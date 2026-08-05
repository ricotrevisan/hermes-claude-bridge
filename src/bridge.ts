// Claude Agent SDK driver for the bridge.
//
// Inbound OpenAI history is replayed through an in-memory session store, while
// the trailing user turn is sent to the SDK as streaming input. The SDK's query
// is deliberately isolated from API-key auth, local settings, MCP, hooks, and
// skills. Full-agent mode changes only the system/tool/permission preset.

import {
	query as sdkQuery,
	type EffortLevel,
	type Options as ClaudeQueryOptions,
	type Query,
	type SDKUserMessage,
	type SessionStore,
	type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { createSession, repairToolPairing, type Message } from "cc-session-io";
import { splitConversation, type OpenAIMessage } from "./convert.js";
import { expectedContextWindow } from "./models.js";
import type { AnthropicUsage } from "./openai.js";
import {
	createMcpServer,
	createToolBridgeState,
	deliverToolResult,
	recordToolUses,
	MCP_SERVER_NAME,
	type HermesToolDef,
	type ToolBridgeState,
	type ToolCallInvocation,
} from "./toolbridge.js";

// Claude Code's built-in tools, blocked in tool mode so the only tools Claude
// can call are the ones routed to Hermes' own permission system. Ported from
// pi-claude-bridge's DISALLOWED_BUILTIN_TOOLS.
const DISALLOWED_BUILTIN_TOOLS = [
	"Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent",
	"NotebookEdit", "EnterWorktree", "ExitWorktree",
	"CronCreate", "CronDelete", "CronList", "TeamCreate", "TeamDelete",
	"WebFetch", "WebSearch", "TodoRead", "TodoWrite",
	"EnterPlanMode", "ExitPlanMode", "RemoteTrigger", "SendMessage",
	"Skill", "TaskOutput", "TaskStop", "ToolSearch",
	"AskUserQuestion", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate",
];

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
	| { type: "error"; message: string; status?: string; httpStatus?: number }
	| { type: "tool_call"; calls: ToolCallInvocation[] };

export type RunOptions = {
	model: string;
	reasoning?: string;
	cwd?: string;
	signal?: AbortSignal;
	/** Hermes tool definitions to expose to Claude via MCP. Enables tool mode. */
	tools?: HermesToolDef[];
	/** Per-query bridge state; the HTTP coordinator resolves tool results through it. */
	toolBridge?: ToolBridgeState;
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
		// CLAUDE_BRIDGE_* holds the bridge's own token and mode switches; a
		// prompt-injected full-agent turn must not be able to read them.
		if (key.startsWith("ANTHROPIC_VERTEX_") || key.startsWith("CLAUDE_BRIDGE_")) delete env[key];
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
	const merged = { ...acc };
	for (const [key, count] of Object.entries(usageFrom(value))) {
		const field = key as keyof AnthropicUsage;
		// A zero report is not informative: cache-heavy turns legitimately end
		// with result usage input_tokens: 0, which must not clobber the positive
		// counts observed in the stream.
		if (count > 0 || merged[field] === undefined) merged[field] = count;
	}
	return merged;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The SDK keys modelUsage by runtime model id, with dated snapshots
// (claude-haiku-4-5-20251001) for some models. Match the requested model
// exactly or as a dated snapshot; a bare prefix would let a new model
// (claude-opus-5-1) silently inherit claude-opus-5's expectations.
function matchServedEntry(
	modelUsage: Record<string, unknown>,
	requestedModel: string,
): { key: string; usage: unknown } | null {
	const baseModel = requestedModel.replace(/\[1m\]$/i, "");
	if (baseModel in modelUsage) return { key: baseModel, usage: modelUsage[baseModel] };
	const datedSnapshot = new RegExp(`^${escapeRegExp(baseModel)}-\\d{8}$`);
	for (const key of Object.keys(modelUsage)) {
		if (datedSnapshot.test(key)) return { key, usage: modelUsage[key] };
	}
	return null;
}

export function servedContextWindow(modelUsage: unknown, requestedModel: string): number | undefined {
	if (!modelUsage || typeof modelUsage !== "object") return undefined;
	const match = matchServedEntry(modelUsage as Record<string, unknown>, requestedModel);
	const context = (match?.usage as { contextWindow?: unknown } | undefined)?.contextWindow;
	return typeof context === "number" && context > 0 ? context : undefined;
}

const CATALOG_STALE_HINT = "Update the measured model catalog before relying on Hermes compaction thresholds.";

function warnOnContextMismatch(message: any, requestedModel: string): void {
	const modelUsage = message?.modelUsage;
	if (!modelUsage || typeof modelUsage !== "object") return;
	const match = matchServedEntry(modelUsage as Record<string, unknown>, requestedModel);
	if (!match) {
		console.warn(
			`hermes-claude-bridge: ${requestedModel} has no modelUsage entry; the turn reported unknown model keys: ` +
				`${Object.keys(modelUsage).join(", ") || "none"}. ${CATALOG_STALE_HINT}`,
		);
		return;
	}
	const context = servedContextWindow(modelUsage, requestedModel);
	if (context === undefined) {
		console.warn(
			`hermes-claude-bridge: ${match.key} reported no usable contextWindow; context drift is unverified. ${CATALOG_STALE_HINT}`,
		);
		return;
	}
	const expected = expectedContextWindow(requestedModel);
	if (context !== expected) {
		console.warn(
			`hermes-claude-bridge: ${requestedModel} served a ${context}-token context window; expected ${expected}. ${CATALOG_STALE_HINT}`,
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
	// Claude can reject an overage fallback as an ordinary result API 400 before
	// it emits rate_limit_info. Preserve that billing meaning, but do not infer it
	// from generic transport errors that happen to quote user-supplied wording.
	if (message.api_error_status === 400 && /\bout of extra usage\b|\bextra usage\b[^.\n]*(?:unavailable|exhausted|disabled)/i.test(text)) {
		return errorEvent(text, "overage", 402);
	}
	return errorEvent(text, status, message.api_error_status);
}

function toolMode(tools: HermesToolDef[] | undefined): boolean {
	return Array.isArray(tools) && tools.length > 0;
}

type Replay = { sessionId: string; store: SessionStore };

// Replay history must never reach the user's real ~/.claude/projects: a session
// left there is visible in `claude --resume` and survives a hard kill. Handing
// the SDK a store instead makes it materialize the transcript into its own temp
// CLAUDE_CONFIG_DIR and delete it when the child exits.
function replayFromHistory(history: Message[], cwd: string, model: string): Replay | null {
	const session = createSession({ projectPath: cwd, model });
	session.importMessages(repairToolPairing(history));
	const entries = session.records as unknown as SessionStoreEntry[];
	// A store that loads nothing makes the SDK drop the resume and fall back to a
	// persisted session in the user's real claude dir. History that repairs away
	// to nothing must take the persistSession: false path instead.
	if (entries.length === 0) return null;
	return {
		sessionId: session.sessionId,
		store: {
			async append() {},
			async load(key) {
				return key.sessionId === session.sessionId ? entries : null;
			},
		},
	};
}

function queryOptions(
	cwd: string,
	replay: Replay | null,
	opts: RunOptions,
	toolBridge: ToolBridgeState,
): ClaudeQueryOptions {
	const tools = toolMode(opts.tools);
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
		...(replay ? { resume: replay.sessionId, sessionStore: replay.store } : { persistSession: false }),
		...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
	};

	if (tools) {
		// Tool mode: Claude Code runs toolless except for the MCP server that
		// exposes Hermes' tools. Every tool call routes through a blocking MCP
		// handler to Hermes' own permission system; Claude never executes.
		const mcpServer = createMcpServer(opts.tools ?? [], toolBridge);
		return {
			...common,
			mcpServers: { [MCP_SERVER_NAME]: mcpServer },
			tools: [],
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
			allowedTools: [`mcp__${MCP_SERVER_NAME}__*`],
			disallowedTools: DISALLOWED_BUILTIN_TOOLS,
			// The official preset without the outer Hermes harness prompt is
			// load-bearing for Claude subscription routing (same as clean mode).
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
	// Tool mode shares this state with the MCP server AND with the HTTP
	// coordinator (when the caller supplies one): recorded tool_use ids must
	// land in the same state the blocked MCP handlers read from.
	const toolBridge = opts.toolBridge ?? createToolBridgeState();
	let activeQuery: Query | null = null;
	let aborted = opts.signal?.aborted ?? false;
	let releasePrompt: (send: boolean) => void = () => {};
	const promptGate = new Promise<boolean>((resolve) => {
		releasePrompt = resolve;
	});
	let failed = false;
	let subscriptionAccount = false;
	let authenticated = false;
	let completed = false;
	let sawText = false;
	let sawRateLimitInfo = false;
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
		const replay = history.length > 0 ? replayFromHistory(history, cwd, opts.model) : null;

		if (aborted) return;

		const content = promptBlocks ?? promptText;
		activeQuery = (opts.queryFn ?? sdkQuery)({
			prompt: gatedPrompt(content, promptGate),
			options: queryOptions(cwd, replay, opts, toolBridge),
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

			// The SDK emits init before any turn output. Account metadata already
			// proved the subscription, so output ahead of init is a broken
			// transport rather than evidence of the wrong credentials.
			if (!authenticated) {
				failed = true;
				yield errorEvent(
					"Claude Agent SDK streamed output before reporting session initialization; refusing the turn.",
					"transport_error",
					502,
				);
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
				if (toolMode(opts.tools)) {
					const toolUses = (message.message?.content ?? []).filter((block) => block?.type === "tool_use");
					if (toolUses.length > 0) {
						// Narrated text and tool calls can coexist on one assistant
						// message; surface the text first, then the tool calls.
						if (!sawText) {
							const text = assistantText(message);
							if (text) {
								sawText = true;
								yield { type: "text", delta: text };
							}
						}
						// Record the tool_use ids in handler-invocation order and surface
						// them to Hermes. The MCP handlers are now blocking on these ids;
						// the server keeps this generator alive and resumes it when
						// Hermes returns the results.
						const calls = recordToolUses(toolBridge, toolUses as Array<{ id: string; name: string; input?: unknown }>);
						if (calls.length > 0) {
							yield { type: "tool_call", calls };
						}
						continue;
					}
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
				sawRateLimitInfo = true;
				const info = message.rate_limit_info;
				if (info.isUsingOverage === true || (info.status === "rejected" && info.rateLimitType === "overage")) {
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
				completed = true;
			}
		}

		if (failed && activeQuery) {
			try {
				await activeQuery.interrupt();
			} catch {
				// Closing below is authoritative cleanup.
			}
		}

		// Without a terminal result the turn was cut short — an empty or truncated
		// stream must not be reported to Hermes as a completed answer.
		if (!aborted && !failed && !completed) {
			failed = true;
			yield errorEvent(
				"Claude Agent SDK stream ended before returning a result; the Claude Code transport failed mid-turn.",
				"transport_error",
				502,
			);
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
	}

	if (!aborted && !failed) {
		// The SDK's rate_limit_event cadence is not contractual; without it the
		// bridge cannot prove the turn ran on subscription quota.
		if (!sawRateLimitInfo) {
			console.warn(
				"hermes-claude-bridge: the SDK emitted no rate-limit metadata for this turn; overage state is unverified.",
			);
		}
		yield { type: "usage", usage: authoritativeUsage ?? streamedUsage };
		yield { type: "done", stopReason };
	}
}
