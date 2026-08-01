import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_MODEL,
	MODEL_IDS,
	expectedContextWindow,
	resolveModel,
	runtimeModelId,
} from "./models.js";

test("model catalog follows pi-claude-bridge's current Claude Code catalog", () => {
	assert.deepEqual(MODEL_IDS, [
		"claude-fable-5",
		"claude-opus-5",
		"claude-opus-4-8",
		"claude-opus-4-7",
		"claude-opus-4-6",
		"claude-sonnet-5",
		"claude-sonnet-4-6",
		"claude-haiku-4-5",
	]);
	assert.equal(DEFAULT_MODEL, "claude-opus-5");
});

test("family aliases select the newest advertised model", () => {
	assert.equal(resolveModel("opus"), "claude-opus-5");
	assert.equal(resolveModel("sonnet"), "claude-sonnet-5");
	assert.equal(resolveModel("fable"), "claude-fable-5");
	assert.equal(resolveModel("haiku"), "claude-haiku-4-5");
});

test("only explicit catalog IDs and aliases resolve", () => {
	assert.equal(resolveModel("claude-opus-4-8"), "claude-opus-4-8");
	assert.equal(resolveModel("future-model"), undefined);
	assert.equal(resolveModel("claude-sonnet-4-6[1m]"), undefined);
	assert.equal(resolveModel(undefined), DEFAULT_MODEL);
});

test("runtime IDs request only measured subscription-compatible context windows", () => {
	assert.equal(runtimeModelId("claude-fable-5"), "claude-fable-5[1m]");
	assert.equal(runtimeModelId("claude-opus-5"), "claude-opus-5[1m]");
	assert.equal(runtimeModelId("claude-opus-4-8"), "claude-opus-4-8[1m]");
	assert.equal(runtimeModelId("claude-opus-4-7"), "claude-opus-4-7");
	assert.equal(runtimeModelId("claude-opus-4-6"), "claude-opus-4-6");
	assert.equal(runtimeModelId("claude-sonnet-5"), "claude-sonnet-5[1m]");
	assert.equal(runtimeModelId("claude-sonnet-4-6"), "claude-sonnet-4-6");
	assert.equal(runtimeModelId("claude-haiku-4-5"), "claude-haiku-4-5");
	assert.throws(() => runtimeModelId("future-model"), /unsupported public model ID/);
});

test("advertised context matches the exact runtime form", () => {
	for (const model of ["claude-fable-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5"]) {
		assert.equal(expectedContextWindow(model), 1_000_000);
	}
	for (const model of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5", "future-model"]) {
		assert.equal(expectedContextWindow(model), 200_000);
	}
});
