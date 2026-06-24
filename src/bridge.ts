// Claude Code driver for the bridge.
//
// Ported/adapted from pi-claude-bridge (https://github.com/elidickinson/pi-claude-bridge,
// MIT, Copyright (c) 2026 Eli Dickinson). See NOTICE.
//
// CRITICAL: this drives the user's installed `claude` CLI in print mode
// (`claude -p`), NOT the Claude Agent SDK's query(). The Agent SDK spawns its
// own bundled CLI tagged CLAUDE_CODE_ENTRYPOINT=sdk-ts, which Anthropic meters
// as SDK/API usage (it draws "extra usage"/overage, not your subscription
// allowance). The standalone `claude -p` (and `acp`) is the entrypoint
// Anthropic allows to run on the Claude Code Pro/Max subscription. So we shell
// out to it and parse its --output-format stream-json events.
//
// Thin-client model: Claude Code runs its OWN tools; we only stream text/
// reasoning back. We replay inbound OpenAI history into a cc-session-io session
// and `--resume` it; the trailing user turn is piped in as a stream-json user
// message (text or image blocks).

import { spawn } from "node:child_process";
import { createSession, deleteSession, repairToolPairing } from "cc-session-io";
import { splitConversation, type OpenAIMessage } from "./convert.js";
import type { AnthropicUsage } from "./openai.js";

// The user's installed Claude Code CLI (the subscription entrypoint). Override
// with CLAUDE_BRIDGE_CLAUDE_BIN if it isn't on PATH.
const CLAUDE_BIN = process.env.CLAUDE_BRIDGE_CLAUDE_BIN || "claude";

// By default the bridge presents Claude as a CLEAN conversational assistant:
// no tools, no MCP servers, no hooks, and a replaced system prompt. This avoids
// inheriting the user's full Claude Code setup (skills/auto-memory/hooks/MCP),
// which otherwise leaks side-actions and tool narration into chat answers.
// Set CLAUDE_BRIDGE_FULL_AGENT=1 to instead run Claude with the user's complete
// config and its own tools (more capable, but verbose and prone to side-actions).
const FULL_AGENT = process.env.CLAUDE_BRIDGE_FULL_AGENT === "1";
const DEFAULT_SYSTEM_PROMPT = "You are a helpful, concise assistant.";

// In full-agent mode, interactive tools can't work in a headless `-p` run —
// block them so the model never stalls.
const DISALLOWED_TOOLS = ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"];

const REASONING_TO_EFFORT: Record<string, string> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "max",
	max: "max",
};

export type BridgeEvent =
	| { type: "text"; delta: string }
	| { type: "reasoning"; delta: string }
	| { type: "usage"; usage: AnthropicUsage }
	| { type: "done"; stopReason: string | null }
	| { type: "error"; message: string; status?: string };

export type RunOptions = {
	model: string;
	reasoning?: string;
	cwd?: string;
	signal?: AbortSignal;
	appendSystem?: boolean;
};

/** Remove API-key env vars so the CLI uses the Claude Code subscription, not a
 *  metered API key. Call once at startup. */
export function forceSubscriptionAuth(): void {
	delete process.env.ANTHROPIC_API_KEY;
	delete process.env.ANTHROPIC_AUTH_TOKEN;
	delete process.env.ANTHROPIC_BASE_URL;
}

function isAuthError(message: string, status?: string): boolean {
	if (status === "authentication_failed") return true;
	return /not logged in|unauthorized|authentication|invalid api key|please run .*login|oauth|credentials/i.test(message);
}

/** A friendlier message for the most common operational failures. */
export function describeError(message: string, status?: string): string {
	if (/ENOENT|not found|spawn .* ENOENT/i.test(message)) {
		return (
			`Could not run the Claude Code CLI ('${CLAUDE_BIN}'). Install it and ensure it's on PATH ` +
			`(or set CLAUDE_BRIDGE_CLAUDE_BIN). The bridge drives 'claude -p' to use your subscription. ` +
			`(underlying error: ${message})`
		);
	}
	if (isAuthError(message, status)) {
		return (
			"Claude Code is not authenticated. The bridge uses your Claude Code subscription, " +
			"so you must be logged in: run `claude login` (Claude Pro/Max). " +
			`(underlying error: ${message})`
		);
	}
	return message;
}

function mergeUsage(acc: AnthropicUsage, u: any): AnthropicUsage {
	if (!u) return acc;
	return {
		input_tokens: u.input_tokens ?? acc.input_tokens,
		output_tokens: u.output_tokens ?? acc.output_tokens,
		cache_read_input_tokens: u.cache_read_input_tokens ?? acc.cache_read_input_tokens,
		cache_creation_input_tokens: u.cache_creation_input_tokens ?? acc.cache_creation_input_tokens,
	};
}

/**
 * Drive a single Claude Code print-mode turn and yield normalized events.
 * Always ends with a `usage` event then a `done` event — unless it yields an
 * `error` event first.
 */
export async function* runClaude(
	messages: OpenAIMessage[],
	opts: RunOptions,
): AsyncGenerator<BridgeEvent> {
	const cwd = opts.cwd || process.env.CLAUDE_BRIDGE_CWD || process.cwd();
	const { system, history, promptText, promptBlocks } = splitConversation(messages);

	// Replay prior turns into a resumable session (if any).
	let session: ReturnType<typeof createSession> | null = null;
	let resumeSessionId: string | undefined;
	if (history.length > 0) {
		session = createSession({ projectPath: cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR, model: opts.model });
		session.importMessages(repairToolPairing(history));
		session.save();
		resumeSessionId = session.sessionId;
	}

	const args = [
		"-p",
		"--output-format", "stream-json",
		"--input-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
		"--model", opts.model,
	];
	const effort = opts.reasoning ? REASONING_TO_EFFORT[opts.reasoning.toLowerCase()] : undefined;
	if (effort) args.push("--effort", effort);
	if (resumeSessionId) args.push("--resume", resumeSessionId);

	if (FULL_AGENT) {
		// Inherit the user's full Claude Code config; Claude runs its own tools.
		args.push("--permission-mode", "bypassPermissions", "--disallowed-tools", ...DISALLOWED_TOOLS);
		if (opts.appendSystem !== false && system) args.push("--append-system-prompt", system);
	} else {
		// Clean assistant: replace the system prompt, drop MCP + hooks, no tools.
		args.push("--strict-mcp-config");
		args.push("--settings", '{"disableAllHooks":true}');
		args.push("--system-prompt", opts.appendSystem !== false && system ? system : DEFAULT_SYSTEM_PROMPT);
		args.push("--tools", ""); // variadic — keep last so it consumes only the empty value
	}

	const userMessage = {
		type: "user",
		message: { role: "user", content: promptBlocks ?? (promptText || "[continue]") },
	};

	const child = spawn(CLAUDE_BIN, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });

	let spawnError: Error | null = null;
	child.on("error", (e) => {
		spawnError = e;
	});
	let stderr = "";
	child.stderr.on("data", (d) => {
		stderr += d.toString();
		if (stderr.length > 8192) stderr = stderr.slice(-8192);
	});

	const onAbort = () => {
		try {
			child.kill("SIGTERM");
		} catch {
			/* ignore */
		}
	};
	if (opts.signal) {
		if (opts.signal.aborted) onAbort();
		else opts.signal.addEventListener("abort", onAbort, { once: true });
	}

	// Send the live user turn, then close stdin so the CLI processes and exits.
	try {
		child.stdin.write(JSON.stringify(userMessage) + "\n");
		child.stdin.end();
	} catch {
		/* child may have failed to spawn; handled below */
	}

	let sawText = false;
	let stopReason: string | null = null;
	let finalUsage: AnthropicUsage = {};
	let emittedError = false;
	let buffer = "";

	// Parse one JSONL message; returns events to yield (so the loop stays flat).
	function handle(msg: any): BridgeEvent[] {
		const out: BridgeEvent[] = [];
		if (msg.type === "stream_event") {
			const event = msg.event;
			if (event?.type === "content_block_delta") {
				const d = event.delta;
				if (d?.type === "text_delta" && d.text) {
					sawText = true;
					out.push({ type: "text", delta: d.text });
				} else if (d?.type === "thinking_delta" && d.thinking) {
					out.push({ type: "reasoning", delta: d.thinking });
				}
			} else if (event?.type === "message_delta") {
				if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
				if (event.usage) finalUsage = mergeUsage(finalUsage, event.usage);
			} else if (event?.type === "message_start" && event.message?.usage) {
				finalUsage = mergeUsage(finalUsage, event.message.usage);
			}
		} else if (msg.type === "assistant") {
			// Fallback only if streaming deltas produced no text.
			if (!sawText && Array.isArray(msg.message?.content)) {
				for (const block of msg.message.content) {
					if (block.type === "text" && block.text) {
						sawText = true;
						out.push({ type: "text", delta: block.text });
					}
				}
			}
		} else if (msg.type === "result") {
			if (msg.usage) finalUsage = mergeUsage(finalUsage, msg.usage);
			if (msg.stop_reason) stopReason = msg.stop_reason;
			if (msg.subtype === "success") {
				if (!sawText && typeof msg.result === "string" && msg.result) {
					out.push({ type: "text", delta: msg.result });
				}
			} else if (!sawText) {
				const errs =
					Array.isArray(msg.errors) && msg.errors.length
						? msg.errors.join("; ")
						: typeof msg.result === "string" && msg.result
							? msg.result
							: msg.subtype || "error_during_execution";
				emittedError = true;
				out.push({ type: "error", message: errs });
			}
		}
		// type:"system" (init/hook/status/thinking_tokens) and others: ignored.
		return out;
	}

	try {
		for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
			if (opts.signal?.aborted) break;
			buffer += chunk.toString();
			let nl: number;
			while ((nl = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				if (!line.trim()) continue;
				let msg: any;
				try {
					msg = JSON.parse(line);
				} catch {
					continue; // ignore non-JSON noise
				}
				for (const ev of handle(msg)) yield ev;
			}
		}
		if (buffer.trim()) {
			try {
				for (const ev of handle(JSON.parse(buffer))) yield ev;
			} catch {
				/* ignore trailing partial */
			}
		}

		const code: number = await new Promise((res) => {
			if (child.exitCode !== null) return res(child.exitCode);
			child.on("close", (c) => res(c ?? 0));
		});

		if (spawnError) {
			emittedError = true;
			yield { type: "error", message: (spawnError as Error).message };
		} else if (code !== 0 && !emittedError && !sawText && !opts.signal?.aborted) {
			emittedError = true;
			yield { type: "error", message: stderr.trim() || `claude exited with code ${code}` };
		}
	} catch (err) {
		emittedError = true;
		yield { type: "error", message: err instanceof Error ? err.message : String(err) };
	} finally {
		if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
		try {
			if (child.exitCode === null) child.kill("SIGKILL");
		} catch {
			/* ignore */
		}
		if (session) {
			try {
				deleteSession(session.sessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
			} catch {
				/* best-effort */
			}
		}
	}

	if (!emittedError) {
		yield { type: "usage", usage: finalUsage };
		yield { type: "done", stopReason };
	}
}
