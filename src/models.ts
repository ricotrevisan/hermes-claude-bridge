// Claude Code model catalog shared by the HTTP model endpoint and request routing.
// Runtime forms/context windows follow pi-claude-bridge's measured Agent SDK
// subscription behavior. Keep this explicit: SDK result metadata arrives too late
// for Hermes to choose a safe compaction threshold for the current turn.

const ONE_MILLION = 1_000_000;
const TWO_HUNDRED_K = 200_000;

type ModelEntry = {
	id: string;
	runtimeId: string;
	contextWindow: number;
};

export const MODEL_CATALOG: readonly ModelEntry[] = [
	{ id: "claude-fable-5", runtimeId: "claude-fable-5[1m]", contextWindow: ONE_MILLION },
	{ id: "claude-opus-5", runtimeId: "claude-opus-5[1m]", contextWindow: ONE_MILLION },
	{ id: "claude-opus-4-8", runtimeId: "claude-opus-4-8[1m]", contextWindow: ONE_MILLION },
	// Bare Opus 4.7 is measured at 1M on subscription OAuth.
	{ id: "claude-opus-4-7", runtimeId: "claude-opus-4-7", contextWindow: ONE_MILLION },
	// Opus 4.6 at 1M is plan-dependent, so remain conservative.
	{ id: "claude-opus-4-6", runtimeId: "claude-opus-4-6", contextWindow: TWO_HUNDRED_K },
	{ id: "claude-sonnet-5", runtimeId: "claude-sonnet-5[1m]", contextWindow: ONE_MILLION },
	// Sonnet 4.6 at 1M requires Extra Usage, which this bridge refuses.
	{ id: "claude-sonnet-4-6", runtimeId: "claude-sonnet-4-6", contextWindow: TWO_HUNDRED_K },
	{ id: "claude-haiku-4-5", runtimeId: "claude-haiku-4-5", contextWindow: TWO_HUNDRED_K },
] as const;

export const MODEL_IDS = MODEL_CATALOG.map((model) => model.id);
export const DEFAULT_MODEL = "claude-opus-5";

const MODEL_ALIASES: Record<string, string> = {
	fable: "claude-fable-5",
	opus: "claude-opus-5",
	sonnet: "claude-sonnet-5",
	haiku: "claude-haiku-4-5",
};

export function resolveModel(requested: string | undefined): string {
	if (!requested) return DEFAULT_MODEL;
	return MODEL_ALIASES[requested.toLowerCase()] ?? requested;
}

export function runtimeModelId(publicModelId: string): string {
	return MODEL_CATALOG.find((model) => model.id === publicModelId)?.runtimeId ?? publicModelId;
}

export function expectedContextWindow(publicOrRuntimeModelId: string): number {
	const entry = MODEL_CATALOG.find(
		(model) => model.id === publicOrRuntimeModelId || model.runtimeId === publicOrRuntimeModelId,
	);
	if (entry) return entry.contextWindow;
	return /\[1m\]$/i.test(publicOrRuntimeModelId) ? ONE_MILLION : TWO_HUNDRED_K;
}
