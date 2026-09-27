import assert from "node:assert/strict";
import test from "node:test";
import plugin, { inject } from "../src/index.js";

// Regression: apply() reads ctx.agents, so Cordis must be told to inject it,
// otherwise activation fails with 'cannot get property "agents" without inject'.
test("plugin declares the agents injection it uses", () => {
	assert.deepEqual(inject, ["agents"]);
	assert.deepEqual(plugin.inject, ["agents"]);
});

// Regression: dsh-llm finish reasons are objects ({ kind }); a normal { kind: "stop" }
// finish must not be reported as "stream finished with reason [object Object]".
test("reflection accepts dsh-llm object finish reasons", async () => {
	const { createWatchdog } = await import("../src/index.js");
	const XML = "<reflection><type>NO_ISSUE</type><reason>ok</reason><done>d</done><current_step>c</current_step><next_step>n</next_step></reflection>";
	const toasts = [];
	const steered = [];
	const root = {
		session: { deriveMessages: () => [] },
		options: { provider: "gateway", model: "m" },
		steer: (m) => steered.push(m),
	};
	const watchdog = createWatchdog({
		config: (await import("../src/index.js")).resolveConfig?.({}) ?? {},
		llm: () => ({ async *stream() { yield { type: "text-delta", text: XML }; yield { type: "finish", reason: { kind: "stop" } }; } }),
		agents: () => [root],
		isRoot: (a) => a === root,
		setStatus: () => {},
		toast: (t) => toasts.push(t),
		createUser: (m) => ({ role: "user", ...m }),
		createAssistant: (m) => ({ role: "assistant", ...m }),
		emit: () => {},
	});
	watchdog.queueManualReflection(root, "probe");
	for (let i = 0; i < 20 && steered.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
	assert.equal(toasts.filter((t) => /Reflection failed/.test(t)).length, 0, toasts.join(" | "));
	assert.ok(steered.length >= 1, "reflection report steered into the agent");
	watchdog.dispose();
});
