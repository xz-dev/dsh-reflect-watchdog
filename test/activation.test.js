import assert from "node:assert/strict";
import test from "node:test";
import plugin, { inject } from "../src/index.js";

// Regression: apply() reads ctx.agents, so Cordis must be told to inject it,
// otherwise activation fails with 'cannot get property "agents" without inject'.
test("plugin declares the agents injection it uses", () => {
	assert.deepEqual(inject, ["agents"]);
	assert.deepEqual(plugin.inject, ["agents"]);
});
