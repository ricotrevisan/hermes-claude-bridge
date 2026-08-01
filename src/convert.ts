// OpenAI Chat Completions messages → Anthropic-shaped messages for cc-session-io.
//
// Adapted from pi-claude-bridge's convert.js (https://github.com/elidickinson/pi-claude-bridge,
// MIT, Copyright (c) 2026 Eli Dickinson). See NOTICE.
//
// Inbound requests from Hermes are standard OpenAI chat: system/developer/user/
// assistant/tool roles, optional multimodal user content, optional assistant
// tool_calls and tool-result messages. We translate these into the message
// shape cc-session-io's Session.importMessages() consumes (Anthropic API form),
// then resume a session from them. The trailing user turn becomes the live
// prompt for query(); everything before it becomes resumable history.
//
// In the thin-client model Claude Code runs its own tools, so Hermes normally
// only sends system + user/assistant text. We still translate tool_calls /
// tool results faithfully so a tools-enabled Hermes config round-trips cleanly.

import type { ContentBlock, Message } from "cc-session-io";

export type OpenAITextPart = { type: "text"; text: string };
export type OpenAIImagePart = { type: "image_url"; image_url: { url: string } };
export type OpenAIContentPart = OpenAITextPart | OpenAIImagePart | { type: string; [k: string]: unknown };

export type OpenAIToolCall = {
	id: string;
	type?: string;
	function: { name: string; arguments?: string };
};

export type OpenAIMessage = {
	role: "system" | "developer" | "user" | "assistant" | "tool" | string;
	content?: string | OpenAIContentPart[] | null;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
	name?: string;
};

/** Concatenate system/developer message text. Returns undefined when none. */
export function extractSystem(messages: OpenAIMessage[]): string | undefined {
	const parts: string[] = [];
	for (const m of messages) {
		if (m.role === "system" || m.role === "developer") {
			const text = contentToText(m.content);
			if (text) parts.push(text);
		}
	}
	return parts.length ? parts.join("\n\n") : undefined;
}

/** Flatten OpenAI message content (string or parts) to plain text. */
export function contentToText(content: OpenAIMessage["content"]): string {
	if (content == null) return "";
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const part of content) {
		if (part.type === "text" && typeof (part as OpenAITextPart).text === "string") {
			parts.push((part as OpenAITextPart).text);
		}
	}
	return parts.join("\n");
}

function parseToolArgs(args: string | undefined): Record<string, unknown> {
	if (!args) return {};
	try {
		const parsed = JSON.parse(args);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

// Anthropic accepts only these base64 image media types. Anything else is
// dropped (degrading to the surrounding text) rather than sent and 400'd.
const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function imageBlockFromUrl(url: string): ContentBlock | null {
	// Tolerate optional parameters between the mime type and the base64 marker
	// (e.g. data:image/png;charset=utf-8;base64,...). /s keeps line-wrapped base64 intact.
	const dataMatch = /^data:([^;,]+)(?:;[^,]*?)?;base64,(.*)$/s.exec(url);
	if (dataMatch) {
		let mediaType = dataMatch[1].toLowerCase();
		if (mediaType === "image/jpg") mediaType = "image/jpeg";
		if (!SUPPORTED_IMAGE_TYPES.has(mediaType)) return null;
		return { type: "image", source: { type: "base64", media_type: mediaType, data: dataMatch[2] } };
	}
	if (/^https?:\/\//.test(url)) {
		return { type: "image", source: { type: "url", url } };
	}
	return null;
}

// Flatten OpenAI user content to plain text for resumable HISTORY, marking any
// images as "[image]". cc-session-io's importMessages cannot round-trip image
// blocks — they would be JSON-stringified (dumping base64 as text) — so history
// images become a marker. The live trailing prompt keeps real images (it goes
// through query() directly, not the session file).
function historyUserText(content: OpenAIContentPart[]): string {
	const parts: string[] = [];
	for (const part of content) {
		if (part.type === "text" && typeof (part as OpenAITextPart).text === "string") {
			if ((part as OpenAITextPart).text) parts.push((part as OpenAITextPart).text);
		} else if (part.type === "image_url") {
			parts.push("[image]");
		}
	}
	return parts.join("\n");
}

/** Convert OpenAI user/assistant content parts to Anthropic content blocks. */
function userContentToBlocks(content: OpenAIContentPart[]): ContentBlock[] {
	const blocks: ContentBlock[] = [];
	for (const part of content) {
		if (part.type === "text" && typeof (part as OpenAITextPart).text === "string") {
			if ((part as OpenAITextPart).text) blocks.push({ type: "text", text: (part as OpenAITextPart).text });
		} else if (part.type === "image_url") {
			const url = (part as OpenAIImagePart).image_url?.url;
			const img = url ? imageBlockFromUrl(url) : null;
			if (img) blocks.push(img);
		}
	}
	return blocks;
}

/** Translate one OpenAI message (non-system) to an Anthropic message for
 *  resumable HISTORY, or null to drop. Images are flattened to a text marker
 *  (see historyUserText); empty turns are dropped to avoid invalid records. */
function convertOne(m: OpenAIMessage): Message | null {
	if (m.role === "user") {
		const text =
			typeof m.content === "string"
				? m.content
				: Array.isArray(m.content)
					? historyUserText(m.content)
					: "";
		if (!text) return null; // drop empty history user turns
		return { role: "user", content: text };
	}

	if (m.role === "assistant") {
		const blocks: ContentBlock[] = [];
		const text = contentToText(m.content);
		if (text) blocks.push({ type: "text", text });
		for (const tc of m.tool_calls ?? []) {
			blocks.push({ type: "tool_use", id: tc.id, name: tc.function?.name ?? "", input: parseToolArgs(tc.function?.arguments) });
		}
		if (blocks.length === 0) return null; // drop empty assistant turns (content:[] is rejected on resume)
		return { role: "assistant", content: blocks };
	}

	return null; // tool handled by openaiMessagesToAnthropic; system/developer by extractSystem
}

function toolResultBlock(m: OpenAIMessage): ContentBlock {
	return { type: "tool_result", tool_use_id: m.tool_call_id ?? "", content: contentToText(m.content) };
}

/** Convert all non-system OpenAI messages to Anthropic messages.
 *  OpenAI sends parallel tool results as consecutive `tool` messages, but
 *  Anthropic expects one user turn carrying every tool_result block —
 *  repairToolPairing pairs only the first user message after a tool call and
 *  discards the rest, so the run must be merged here. */
export function openaiMessagesToAnthropic(messages: OpenAIMessage[]): Message[] {
	const out: Message[] = [];
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (m.role === "system" || m.role === "developer") continue;

		if (m.role === "tool") {
			const blocks: ContentBlock[] = [toolResultBlock(m)];
			while (messages[i + 1]?.role === "tool") blocks.push(toolResultBlock(messages[++i]));
			out.push({ role: "user", content: blocks });
			continue;
		}

		const converted = convertOne(m);
		if (converted) out.push(converted);
	}
	return out;
}

export type Conversation = {
	history: Message[];
	promptText: string;
	promptBlocks?: ContentBlock[];
};

// The SDK's systemPrompt stays locked to the official claude_code preset: a
// custom system prompt was observed to route the turn through Extra Usage
// (SECURITY.md). System/developer messages therefore ride along as a preamble on
// the live user turn rather than being dropped.
function withSystemPreamble(conversation: Conversation, system: string | undefined): Conversation {
	if (!system) return conversation;
	const preamble = `<system-instructions>\n${system}\n</system-instructions>`;
	return {
		history: conversation.history,
		promptText: conversation.promptText ? `${preamble}\n\n${conversation.promptText}` : preamble,
		promptBlocks: conversation.promptBlocks && [{ type: "text", text: preamble }, ...conversation.promptBlocks],
	};
}

function splitTurns(messages: OpenAIMessage[]): Conversation {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "user") {
		return { history: openaiMessagesToAnthropic(messages), promptText: "[continue]" };
	}

	const history = openaiMessagesToAnthropic(messages.slice(0, -1));
	if (Array.isArray(last.content)) {
		const blocks = userContentToBlocks(last.content);
		const hasImage = blocks.some((b) => b.type === "image");
		return { history, promptText: contentToText(last.content), promptBlocks: hasImage ? blocks : undefined };
	}
	return { history, promptText: typeof last.content === "string" ? last.content : "" };
}

/**
 * Split an OpenAI request into (resumable history, live prompt).
 * The trailing user message becomes the prompt for query(); everything before
 * it is the session history to resume from. If the last message is not a user
 * message, fall back to a "[continue]" prompt with the full history.
 */
export function splitConversation(messages: OpenAIMessage[]): Conversation {
	const turns = splitTurns(messages);
	if (!turns.promptBlocks && !turns.promptText) turns.promptText = "[continue]";
	return withSystemPreamble(turns, extractSystem(messages));
}
