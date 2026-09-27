import assert from "node:assert/strict";
import { test } from "node:test";
import { apply, createWatchdog, reflectCooldownLoops, resolveConfig } from "../src/index.js";

const XML = `<reflection><type>NO_ISSUE</type><reason>fine</reason><done>d</done><current_step>c</current_step><next_step>n</next_step></reflection>`;

function harness(overrides = {}) {
	let clock = 0;
	let timer;
	const toasts = [];
	const steered = [];
	const streams = [];
	const root = {
		session: {
			id: "root",
			deriveMessages() {
				return this.messages;
			},
			messages: [],
		},
		options: { provider: "p", model: "m", reasoningEffort: "high" },
		steer(message) {
			steered.push(message);
			root.session.messages.push(message);
		},
	};
	const child = {
		session: { id: "child", deriveMessages() { return []; }, messages: [] },
		options: { provider: "p", model: "m" },
		steer(message) { steered.push(message); },
	};
	const config = resolveConfig({
		rootLoopLimit: 2,
		allLoopLimit: 5,
		taskMinutes: 1,
		idleResetGapSeconds: 60,
		hookPauses: [],
		...overrides.config,
	});
	const watchdog = createWatchdog({
		config,
		llm: () => ({
			async *stream(request) {
				streams.push(request);
				const script = overrides.replies ?? [XML];
				const text = script[streams.length - 1] ?? XML;
				yield { type: "text-delta", text };
				yield { type: "finish", reason: "stop" };
			},
		}),
		agents: () => [root, child],
		isRoot: (agent) => agent === root,
		now: () => clock,
		setIntervalFn(fn) {
			timer = fn;
			return 1;
		},
		clearIntervalFn() {
			timer = undefined;
		},
		toast: (text) => toasts.push(text),
		emitCompleted: (values) => toasts.push(values),
		createUser: (input) => ({ role: "user", ...input }),
		createAssistant: (input) => ({ role: "assistant", ...input }),
	});
	return {
		watchdog,
		root,
		child,
		toasts,
		steered,
		streams,
		config,
		bump(ms) {
			clock += ms;
			timer?.();
		},
		async settle() {
			await new Promise((resolve) => setImmediate(resolve));
			await new Promise((resolve) => setImmediate(resolve));
		},
	};
}

test("root and child loops latch separate thresholds and steer report plus continue", async () => {
	const h = harness();
	h.watchdog.agentActivity(h.root, true);
	h.watchdog.assistantMessage(h.child);
	assert.equal(h.watchdog.snapshot().allLoops, 1);
	assert.equal(h.watchdog.snapshot().rootLoops, 0);
	h.watchdog.assistantMessage(h.root);
	h.watchdog.assistantMessage(h.root);
	await h.settle();
	assert.equal(h.streams.length, 1);
	assert.equal(h.streams[0].provider, "p");
	assert.equal(h.streams[0].reasoningEffort, "high");
	assert.equal(h.streams[0].purpose, undefined);
	assert.equal(h.steered.length, 2);
	assert.match(h.steered[0].content[0].text, /Reflection · NO_ISSUE/);
	assert.equal(h.steered[1].content[0].text, "[assistant]\ncontinue");
	assert.equal(h.steered[0].source.kind, "dsh-reflect-watchdog");
	assert.equal(h.toasts.at(-1).REFLECTION_TYPE, "NO_ISSUE");
});

test("task-time retrigger inside the cooldown is skipped", async () => {
	const limit = reflectCooldownLoops(100_000);
	const h = harness({ config: { rootLoopLimit: 100_000, allLoopLimit: 100_000, taskMinutes: 1 } });
	h.watchdog.agentActivity(h.root, true);
	for (let i = 0; i < 60; i += 1) h.bump(1_000);
	await h.settle();
	assert.equal(h.streams.length, 1);
	for (let i = 0; i < 60; i += 1) h.bump(1_000);
	await h.settle();
	assert.equal(h.streams.length, 1);
	assert.ok(h.toasts.includes("Reflect skipped during cooldown."));
	for (let i = 0; i < limit + 1; i += 1) h.watchdog.assistantMessage(h.root);
	for (let i = 0; i < 60; i += 1) h.bump(1_000);
	await h.settle();
	assert.equal(h.streams.length, 2);
});

test("manual reflect coalesces, cancels, and ignores non-roots", () => {
	const h = harness();
	assert.equal(h.watchdog.queueManualReflection(h.child), "ignored");
	assert.equal(h.watchdog.queueManualReflection(h.root, "look again"), "dispatched");
	assert.equal(h.watchdog.queueManualReflection(h.root), "queued");
	assert.equal(h.watchdog.queueManualReflection(h.root), "coalesced");
	assert.equal(h.watchdog.cancelQueuedReflection(), true);
	assert.match(h.toasts.at(-1), /cancelled/);
});

test("invalid oracle XML retries then fails closed", async () => {
	const h = harness({ replies: ["nope", "still nope", "no"] });
	h.watchdog.agentActivity(h.root, true);
	h.watchdog.assistantMessage(h.root);
	h.watchdog.assistantMessage(h.root);
	await h.settle();
	assert.equal(h.streams.length, 3);
	assert.equal(h.steered.length, 0);
	assert.match(h.toasts.at(-1), /Reflection failed/);
});

test("user takeover and pause/resume", () => {
	const h = harness();
	h.watchdog.agentActivity(h.root, true);
	h.bump(5_000);
	h.watchdog.assistantMessage(h.root);
	h.watchdog.userTakeover();
	assert.equal(h.watchdog.snapshot().activeMs, 0);
	assert.equal(h.watchdog.snapshot().rootLoops, 0);
	h.watchdog.agentActivity(h.root, true);
	h.bump(1_000);
	const before = h.watchdog.snapshot().taskMs;
	h.watchdog.setPaused(true);
	h.bump(10_000);
	assert.equal(h.watchdog.snapshot().taskMs, before);
	h.watchdog.setPaused(false);
	h.bump(1_000);
	assert.equal(h.watchdog.snapshot().taskMs, before + 1_000);
	assert.equal(h.watchdog.snapshot().anyBusy, true);
});

test("apply pauses on the user's ask-user semantic hooks and publishes reflection-completed", async () => {
	const hooks = [];
	const listeners = new Map();
	const shortcuts = [];
	const commands = [];
	const root = {
		session: { id: "root", deriveMessages() { return []; } },
		options: { provider: "p", model: "m" },
		steer() {},
	};
	const ctx = {
		agents: {
			roots: () => [root],
			get: (id) => (id === "root" ? root : undefined),
		},
		get(service) {
			if (service === "llm") {
				return { async *stream() { yield { type: "text-delta", text: XML }; yield { type: "finish", reason: "stop" }; } };
			}
			if (service === "commands") return { register: (def) => { commands.push(def.name); return () => {}; } };
			if (service === "tuiShortcuts") return { register: (combo) => { shortcuts.push(combo); return () => {}; } };
			return undefined;
		},
		on(event, fn) {
			const list = listeners.get(event) ?? [];
			list.push(fn);
			listeners.set(event, list);
			return () => {};
		},
		emit(event, data) {
			hooks.push([event, data]);
			for (const fn of listeners.get(event) ?? []) fn(data);
		},
		effect() {},
	};
	const dispose = apply(ctx, { rootLoopLimit: 1, allLoopLimit: 100, taskMinutes: 99, hookPauses: undefined });
	assert.deepEqual(commands, ["reflect", "cancel-reflect"]);
	assert.deepEqual(shortcuts, ["alt+x"]);
	const status = listeners.get("agent/status")[0];
	status({ agent: root, status: "running" });
	let taskBefore;
	const sessionListener = listeners.get("session/event")[0];
	ctx.emit("pi:semantic-hook:v1", { version: 1, name: "ask-user-wait-started" });
	sessionListener({ id: "root" }, { type: "assistant/message", data: { interrupted: false } });
	taskBefore = undefined;
	ctx.emit("pi:semantic-hook:v1", { version: 1, name: "ask-user-wait-finished" });
	sessionListener({ id: "root" }, { type: "assistant/message", data: { interrupted: true } });
	sessionListener({ id: "root" }, { type: "assistant/message", data: {} });
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
	const completed = hooks.find((entry) => entry[0] === "pi:semantic-hook:v1" && entry[1]?.name === "reflection-completed");
	assert.ok(completed, "reflection-completed semantic hook missing");
	assert.equal(completed[1].values.REFLECTION_TYPE, "NO_ISSUE");
	assert.equal(taskBefore, undefined);
	sessionListener({ id: "root" }, { type: "user/message", data: { source: { kind: "user" } } });
	dispose();
});
