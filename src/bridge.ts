// Claude Agent SDK driver for the bridge.
//
// Inbound OpenAI history is replayed through a temporary cc-session-io session,
// while the trailing user turn is sent to the SDK as streaming input. The SDK's
// query is deliberately isolated from API-key auth, local settings, MCP, hooks,
// and skills. Full-agent mode changes only the system/tool/permission preset.

import {
	query as sdkQuery,
	type EffortLevel,
	type Options as ClaudeQueryOptions,
	type Query,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { createSession, deleteSession, repairToolPairing } from "cc-session-io";
import { splitConversation, type OpenAIMessage } from "./convert.js";
import { expectedContextWindow } from "./models.js";
import type { AnthropicUsage } from "./openai.js";

const DISALLOWED_TOOLS = ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"];

const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
	ultra: "max",
};

export type BridgeEvent =
	| { type: "text"; delta: string }
	| { type: "reasoning"; delta: string }
	| { type: "usage"; usage: AnthropicUsage }
	| { type: "done"; stopReason: string | null }
	| { type: "error"; message: string; status?: string; httpStatus?: number };

export type RunOptions = {
	model: string;
	reasoning?: string;
	cwd?: string;
	signal?: AbortSignal;
	/** Test/offline seam. Production callers use the SDK's query(). */
	queryFn?: typeof sdkQuery;
};

function isAuthError(message: string, status?: string): boolean {
	if (status === "authentication_failed") return true;
	return /not logged in|unauthorized|authentication|invalid api key|please run .*login|oauth|credentials/i.test(message);
}

/** A friendlier message for the most common operational failures. */
export function describeError(message: string, status?: string): string {
	if (/\bENOENT\b|spawn[^\n]*not found/i.test(message)) {
		const executable = process.env.CLAUDE_BRIDGE_CLAUDE_BIN || "the bundled Claude Code executable";
		return (
			`Could not run Claude Code ('${executable}'). Install Claude Code or unset/fix ` +
			`CLAUDE_BRIDGE_CLAUDE_BIN. (underlying error: ${message})`
		);
	}
	if (isAuthError(message, status)) {
		return (
			"Claude Code is not authenticated with OAuth. The bridge requires your Claude Code subscription, " +
			"so you must be logged in: run `claude login` (Claude Pro/Max). " +
			`(underlying error: ${message})`
		);
	}
	return message;
}

function childEnvironment(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.ANTHROPIC_API_KEY;
	delete env.ANTHROPIC_AUTH_TOKEN;
	delete env.ANTHROPIC_TOKEN;
	delete env.ANTHROPIC_BASE_URL;
	delete env.CLAUDE_CODE_USE_BEDROCK;
	delete env.CLAUDE_CODE_USE_VERTEX;
	for (const key of Object.keys(env)) {
		if (key.startsWith("ANTHROPIC_VERTEX_")) delete env[key];
	}
	env.ENABLE_CLAUDEAI_MCP_SERVERS = "0";
	env.DISABLE_AUTO_COMPACT = "1";
	env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
	env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
	return env;
}

function usageFrom(value: any): AnthropicUsage {
	const usage: AnthropicUsage = {};
	for (const key of [
		"input_tokens",
		"output_tokens",
		"cache_read_input_tokens",
		"cache_creation_input_tokens",
	] as const) {
		if (typeof value?.[key] === "number") usage[key] = value[key];
	}
	return usage;
}

function mergeUsage(acc: AnthropicUsage, value: any): AnthropicUsage {
	return { ...acc, ...usageFrom(value) };
}

export function servedContextWindow(modelUsage: unknown, requestedModel: string): number | undefined {
	if (!modelUsage || typeof modelUsage !== "object") return undefined;
	const baseModel = requestedModel.replace(/\[1m\]$/i, "");
	for (const [model, usage] of Object.entries(modelUsage as Record<string, unknown>)) {
		if (model !== baseModel && !model.startsWith(`${baseModel}-`)) continue;
		const context = (usage as { contextWindow?: unknown })?.contextWindow;
		if (typeof context === "number" && context > 0) return context;
	}
	return undefined;
}

function warnOnContextMismatch(message: any, requestedModel: string): void {
	const served = servedContextWindow(message?.modelUsage, requestedModel);
	if (!served) return;
	const expected = expectedContextWindow(requestedModel);
	if (served !== expected) {
		console.warn(
			`hermes-claude-bridge: ${requestedModel} served a ${served}-token context window; expected ${expected}. ` +
				"Update the measured model catalog before relying on Hermes compaction thresholds.",
		);
	}
}

function assistantText(message: any): string {
	if (!Array.isArray(message?.message?.content)) return "";
	return message.message.content
		.filter((block: any) => block?.type === "text" && typeof block.text === "string")
		.map((block: any) => block.text)
		.join("");
}

function errorEvent(message: string, status?: string, httpStatus?: number | null): BridgeEvent {
	// Claude can reject an overage fallback as an ordinary API 400 before it
	// emits rate_limit_info. Preserve the billing meaning so Hermes does not
	// retry a request that cannot run against the available subscription quota.
	if (/\bout of extra usage\b|\bextra usage\b[^.\n]*(?:unavailable|exhausted|disabled)/i.test(message)) {
		status = "overage";
		httpStatus = 402;
	}
	return {
		type: "error",
		message,
		...(status ? { status } : {}),
		...(typeof httpStatus === "number" ? { httpStatus } : {}),
	};
}

function resultError(message: any): BridgeEvent | null {
	if (message.type !== "result") return null;
	if (message.subtype === "success" && !message.is_error) return null;

	const errors = Array.isArray(message.errors) ? message.errors.filter(Boolean).join("; ") : "";
	const text = errors || (typeof message.result === "string" && message.result) || message.subtype || "error_during_execution";
	const status = message.subtype === "success" ? "error_during_execution" : message.subtype;
	return errorEvent(text, status, message.api_error_status);
}

function queryOptions(
	cwd: string,
	resume: string | undefined,
	opts: RunOptions,
): ClaudeQueryOptions {
	const fullAgent = process.env.CLAUDE_BRIDGE_FULL_AGENT === "1";
	const effort = opts.reasoning ? REASONING_TO_EFFORT[opts.reasoning.toLowerCase()] : undefined;
	const executable = process.env.CLAUDE_BRIDGE_CLAUDE_BIN;

	const common: ClaudeQueryOptions = {
		cwd,
		model: opts.model,
		includePartialMessages: true,
		env: childEnvironment(),
		mcpServers: {},
		strictMcpConfig: true,
		settingSources: [],
		skills: [],
		hooks: {},
		settings: { disableAllHooks: true },
		...(effort ? { effort } : {}),
		...(resume ? { resume } : { persistSession: false }),
		...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
	};

	if (fullAgent) {
		return {
			...common,
			tools: { type: "preset", preset: "claude_code" },
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
			disallowedTools: DISALLOWED_TOOLS,
			systemPrompt: { type: "preset", preset: "claude_code" },
		};
	}

	return {
		...common,
		tools: [],
		maxTurns: 1,
		// The official preset without the outer Hermes harness prompt is
		// load-bearing for Claude subscription routing. Forwarding that full
		// system prompt was observed to select Extra Usage instead.
		systemPrompt: { type: "preset", preset: "claude_code" },
	};
}

// Billing safety: the prompt stays parked until account metadata has been
// validated, so a rejected query never dispatches user content to a backend.
function gatedPrompt(content: unknown, released: Promise<boolean>): AsyncIterable<SDKUserMessage> {
	return (async function* () {
		if (!(await released)) return;
		yield {
			type: "user",
			message: { role: "user", content } as SDKUserMessage["message"],
			parent_tool_use_id: null,
		};
	})();
}

/**
 * Drive one Claude Agent SDK turn and yield normalized bridge events.
 * Successful queries end with usage and done; failures end with error.
 */
export async function* runClaude(
	messages: OpenAIMessage[],
	opts: RunOptions,
): AsyncGenerator<BridgeEvent> {
	const cwd = opts.cwd || process.env.CLAUDE_BRIDGE_CWD || process.cwd();
	const { history, promptText, promptBlocks } = splitConversation(messages);
	let session: ReturnType<typeof createSession> | null = null;
	let activeQuery: Query | null = null;
	let aborted = opts.signal?.aborted ?? false;
	let releasePrompt: (send: boolean) => void = () => {};
	const promptGate = new Promise<boolean>((resolve) => {
		releasePrompt = resolve;
	});
	let failed = false;
	let subscriptionAccount = false;
	let authenticated = false;
	let sawText = false;
	let stopReason: string | null = null;
	let streamedUsage: AnthropicUsage = {};
	let authoritativeUsage: AnthropicUsage | null = null;

	const onAbort = () => {
		aborted = true;
		if (activeQuery) {
			void activeQuery.interrupt().catch(() => {});
			try {
				activeQuery.close();
			} catch {
				// Best effort; finally retries close.
			}
		}
	};

	if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });

	try {
		let resumeSessionId: string | undefined;
		if (history.length > 0) {
			session = createSession({
				projectPath: cwd,
				claudeDir: process.env.CLAUDE_CONFIG_DIR,
				model: opts.model,
			});
			session.importMessages(repairToolPairing(history));
			session.save();
			resumeSessionId = session.sessionId;
		}

		if (aborted) return;

		const content = promptBlocks ?? (promptText || "[continue]");
		activeQuery = (opts.queryFn ?? sdkQuery)({
			prompt: gatedPrompt(content, promptGate),
			options: queryOptions(cwd, resumeSessionId, opts),
		});

		if (opts.signal?.aborted) onAbort();
		if (aborted) return;

		const account = await activeQuery.accountInfo();
		subscriptionAccount = account.apiProvider === "firstParty" && Boolean(account.subscriptionType);
		if (!subscriptionAccount) {
			failed = true;
			yield errorEvent(
				"Claude Agent SDK did not report a first-party Claude subscription account; refusing non-subscription execution.",
				"authentication_failed",
			);
			return;
		}
		releasePrompt(true);

		for await (const message of activeQuery) {
			if (aborted) break;

			if (message.type === "system" && message.subtype === "init") {
				// Claude Code currently reports "none" for a valid Keychain-backed
				// claude.ai login. Explicit API-key sources are never accepted.
				const source = message.apiKeySource as string | undefined;
				authenticated = subscriptionAccount && (source === "oauth" || source === "none");
				if (!authenticated) {
					failed = true;
					yield errorEvent(
						source === undefined
							? "Claude Agent SDK did not report an API-key source; refusing unverifiable billing."
							: `Claude Agent SDK reported API-key source '${source}'; refusing non-subscription billing.`,
						"authentication_failed",
					);
					break;
				}
				continue;
			}

			// The SDK emits init before any turn output. Refuse to forward or
			// trigger further iteration until OAuth has been verified.
			if (!authenticated) {
				failed = true;
				yield errorEvent("Claude Agent SDK did not initialize with OAuth authentication.", "authentication_failed");
				break;
			}

			if (message.type === "stream_event") {
				const event: any = message.event;
				if (event?.type === "content_block_delta") {
					const delta = event.delta;
					if (delta?.type === "text_delta" && delta.text) {
						sawText = true;
						yield { type: "text", delta: delta.text };
					} else if (delta?.type === "thinking_delta" && delta.thinking) {
						yield { type: "reasoning", delta: delta.thinking };
					}
				} else if (event?.type === "message_start") {
					streamedUsage = mergeUsage(streamedUsage, event.message?.usage);
				} else if (event?.type === "message_delta") {
					if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
					streamedUsage = mergeUsage(streamedUsage, event.usage);
				}
				continue;
			}

			if (message.type === "assistant") {
				if (message.error) {
					failed = true;
					yield errorEvent(assistantText(message) || message.error, message.error);
					break;
				}
				if (!sawText) {
					const text = assistantText(message);
					if (text) {
						sawText = true;
						yield { type: "text", delta: text };
					}
				}
				continue;
			}

			if (message.type === "rate_limit_event") {
				if (message.rate_limit_info.isUsingOverage === true) {
					failed = true;
					yield errorEvent(
						"Claude Agent SDK selected Extra Usage instead of subscription quota; refusing the turn.",
						"overage",
						402,
					);
					break;
				}
				if (message.rate_limit_info.status === "rejected") {
					failed = true;
					const kind = message.rate_limit_info.rateLimitType;
					yield errorEvent(`Claude subscription rate limit rejected${kind ? ` (${kind})` : ""}.`, "rate_limit", 429);
					break;
				}
			}

			if (message.type === "result") {
				warnOnContextMismatch(message, opts.model);
				authoritativeUsage = mergeUsage(streamedUsage, message.usage);
				stopReason = message.stop_reason;
				const failure = resultError(message);
				if (failure) {
					failed = true;
					yield failure;
					break;
				}
				if (!sawText && message.subtype === "success" && message.result) {
					sawText = true;
					yield { type: "text", delta: message.result };
				}
			}
		}

		if (failed && activeQuery) {
			try {
				await activeQuery.interrupt();
			} catch {
				// Closing below is authoritative cleanup.
			}
		}

		if (!aborted && !failed && !authenticated) {
			failed = true;
			yield errorEvent("Claude Agent SDK ended without OAuth authentication initialization.", "authentication_failed");
		}
	} catch (error) {
		if (!aborted) {
			failed = true;
			const value = error as any;
			yield errorEvent(
				error instanceof Error ? error.message : String(error),
				typeof value?.status === "string" ? value.status : undefined,
				typeof value?.status === "number" ? value.status : value?.statusCode,
			);
		}
	} finally {
		releasePrompt(false);
		if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
		if (activeQuery) {
			try {
				activeQuery.close();
			} catch {
				// Best-effort cleanup.
			}
		}
		if (session) {
			try {
				deleteSession(session.sessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
			} catch {
				// Temporary replay cleanup is best effort.
			}
		}
	}

	if (!aborted && !failed) {
		yield { type: "usage", usage: authoritativeUsage ?? streamedUsage };
		yield { type: "done", stopReason };
	}
}
