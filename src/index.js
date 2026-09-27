/**
 * dsh-reflect-watchdog: root-agent loop and active-time watchdog for
 * DeepSeek Harness. Port of pi-reflect-watchdog (BSD-3-Clause, xz-dev).
 *
 * Counters come from the local accounting reducer (src/accounting.js).
 * Reflections run as direct auxiliary model calls through `ctx.llm.stream`
 * against the target agent's own provider/model route (no `purpose` tag —
 * `session-title` forces reasoning off). The parsed verdict is steered back
 * into the agent followed by the fixed "[assistant]\ncontinue" wake.
 * Completion is `pi:semantic-hook:v1` / `reflection-completed`.
 */
import { createAssistantMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import {
	createAccountingState,
	reduceAccountingState,
	snapshotAccounting,
} from "./accounting.js";
import {
	buildReflectionContextMessage,
	buildReflectionReaskPrompt,
	DEFAULT_REFLECTION_PROMPT,
	formatDuration,
	formatReflectionReport,
	MAX_REFLECTION_ATTEMPTS,
	parseReflectionXml,
} from "./protocol.js";

export const name = "dsh-reflect-watchdog";

const STATUS_KEY = "dsh-reflect-watchdog";
const SOURCE_KIND = "dsh-reflect-watchdog";
const COMPLETED_EVENT = "reflect-watchdog/completed";
const CONTINUATION_CONTENT = "[assistant]\ncontinue";
const SEMANTIC_HOOK_CHANNEL = "pi:semantic-hook:v1";
const REFLECTION_COMPLETED_HOOK = "reflection-completed";
const SEMANTIC_HOOK_TEXT_LIMIT = 4096;
const REFLECT_COOLDOWN_MIN_LOOPS = 10;
const REFLECT_COOLDOWN_MAX_LOOPS = 30;
const TICK_MS = 1_000;
/** User's pi-reflect-watchdog.json pair. dsh-notify publishes these names. */
const USER_ASK_USER_PAUSE = Object.freeze([
	Object.freeze({
		pause: "ask-user-wait-started",
		resume: "ask-user-wait-finished",
	}),
]);

const HookPauseSchema = z.object({
	pause: z.string(),
	resume: z.string(),
});

export const Config = z.object({
	rootLoopLimit: z.number().step(1).min(1).default(60),
	allLoopLimit: z.number().step(1).min(1).default(300),
	taskMinutes: z.number().step(1).min(1).default(20),
	idleResetGapSeconds: z.number().step(1).min(1).default(60),
	reflectionPrompt: z.string().min(1).default(DEFAULT_REFLECTION_PROMPT),
	/** Optional oracle route override; empty uses the target agent's own route. */
	reflectionProvider: z.string().default(""),
	reflectionModel: z.string().default(""),
	/** Pi key id for cancelling a queued manual reflection, or false. */
	cancelShortcut: z.union([z.string().min(1), z.const(false)]).default("alt+x"),
	/**
	 * Also pause on the user-questions waterfall. Off by default: the user's
	 * Pi pair is delivered as semantic hooks by dsh-notify, and pausing both
	 * would nest the same wait twice.
	 */
	pauseOnAskUser: z.boolean().default(false),
	/** Semantic-hook pause/resume pairs (`pi:semantic-hook:v1`). */
	hookPauses: z.array(HookPauseSchema).default(USER_ASK_USER_PAUSE),
});

const DEFAULTS = {
	rootLoopLimit: 60,
	allLoopLimit: 300,
	taskMinutes: 20,
	idleResetGapSeconds: 60,
	reflectionPrompt: DEFAULT_REFLECTION_PROMPT,
	reflectionProvider: "",
	reflectionModel: "",
	cancelShortcut: "alt+x",
	pauseOnAskUser: false,
	hookPauses: USER_ASK_USER_PAUSE,
};

/** Resolve partial config over defaults with the Pi validation rules. */
export function resolveConfig(raw = {}) {
	const config = { ...DEFAULTS };
	for (const key of ["rootLoopLimit", "allLoopLimit", "taskMinutes", "idleResetGapSeconds"]) {
		if (raw[key] === undefined) continue;
		if (typeof raw[key] === "number" && Number.isSafeInteger(raw[key]) && raw[key] > 0)
			config[key] = raw[key];
	}
	if (typeof raw.reflectionPrompt === "string" && raw.reflectionPrompt.trim().length > 0)
		config.reflectionPrompt = raw.reflectionPrompt;
	if (typeof raw.reflectionProvider === "string") config.reflectionProvider = raw.reflectionProvider.trim();
	if (typeof raw.reflectionModel === "string") config.reflectionModel = raw.reflectionModel.trim();
	if (raw.cancelShortcut === false || (typeof raw.cancelShortcut === "string" && raw.cancelShortcut.length > 0))
		config.cancelShortcut = raw.cancelShortcut;
	if (typeof raw.pauseOnAskUser === "boolean") config.pauseOnAskUser = raw.pauseOnAskUser;
	if (Array.isArray(raw.hookPauses)) {
		const seen = new Set();
		const pairs = [];
		for (const pair of raw.hookPauses) {
			if (
				typeof pair?.pause !== "string" ||
				typeof pair?.resume !== "string" ||
				pair.pause.length === 0 ||
				pair.resume.length === 0 ||
				pair.pause === pair.resume
			)
				continue;
			const key = `${pair.pause}\n${pair.resume}`;
			if (seen.has(key)) continue;
			seen.add(key);
			pairs.push(Object.freeze({ pause: pair.pause, resume: pair.resume }));
		}
		config.hookPauses = pairs;
	}
	return Object.freeze(config);
}

export function contributorId(agent) {
	const id = agent?.session?.id ?? agent?.id;
	return id === undefined || id === null ? undefined : String(id);
}

export function reflectCooldownLoops(rootLoopLimit) {
	if (!Number.isFinite(rootLoopLimit)) return REFLECT_COOLDOWN_MAX_LOOPS;
	return Math.min(
		REFLECT_COOLDOWN_MAX_LOOPS,
		Math.max(REFLECT_COOLDOWN_MIN_LOOPS, Math.floor(rootLoopLimit / 3)),
	);
}

function localTimestamp() {
	const date = new Date();
	const offset = -date.getTimezoneOffset();
	const sign = offset >= 0 ? "+" : "-";
	const pad = (value) => String(Math.abs(value)).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, "0")}${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

function clipHookText(value) {
	if (value.length <= SEMANTIC_HOOK_TEXT_LIMIT) return value;
	let prefix = "";
	for (const codePoint of value) {
		if (prefix.length + codePoint.length >= SEMANTIC_HOOK_TEXT_LIMIT) break;
		prefix += codePoint;
	}
	return `${prefix}…`;
}

function messageText(message) {
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
}

/**
 * Core watchdog state machine. UI services, the LLM runtime and the cordis
 * context are injected so unit tests can drive fakes.
 */
export function createWatchdog(options) {
	const {
		config,
		llm, // () => llm runtime | undefined
		agents, // () => roots array; isRoot(agent) via options.isRoot
		isRoot,
		now = () => Date.now(),
		setIntervalFn = (fn, ms) => setInterval(fn, ms),
		clearIntervalFn = (handle) => clearInterval(handle),
		setStatus = () => {},
		toast = () => {},
		emitCompleted = () => {},
		createUser = (input) => createUserMessage(input),
		createAssistant = (input) => createAssistantMessage(input),
	} = options;

	let state = createAccountingState({ idleResetGapMs: config.idleResetGapSeconds * 1000 });
	const busyAgents = new Map();
	const latched = new Set();
	let pendingAutomatic;
	const manualQueue = [];
	let activeReflection;
	let ticker;
	let reflectionSequence = 0;
	let cooldownArmed = false;
	let rootLoopsSinceReflect = 0;

	const snapshot = () => snapshotAccounting(state, now());
	const paused = () => state.accounting.paused;

	function reduce(event) {
		state = reduceAccountingState(state, event);
	}

	function thresholdSnapshot() {
		const counters = snapshot();
		return {
			activeMs: counters.activeMs,
			activeLoops: counters.activeLoops,
			taskMs: counters.taskMs,
			taskMinutes: config.taskMinutes,
			rootLoops: counters.rootLoops,
			rootLoopLimit: config.rootLoopLimit,
			allLoops: counters.allLoops,
			allLoopLimit: config.allLoopLimit,
		};
	}

	function loopsSinceLastReflect() {
		const agent = primaryRoot();
		let scanned = Infinity;
		try {
			const history = agent?.session?.deriveMessages?.() ?? [];
			let marker = -1;
			for (let index = history.length - 1; index >= 0; index -= 1) {
				const message = history[index];
				if (
					message?.role === "user" &&
					message?.source?.kind === SOURCE_KIND &&
					typeof message?.source?.reflection?.report === "string"
				) {
					marker = index;
					break;
				}
			}
			if (marker >= 0) {
				scanned = 0;
				for (let index = marker + 1; index < history.length; index += 1)
					if (history[index]?.role === "assistant") scanned += 1;
			}
		} catch {
			scanned = Infinity;
		}
		// Armed in this process: the counter is zeroed when the report is steered,
		// before that user message is in the log. A history scan would still see the
		// previous report and look idle. After restart the flag is clear and the log wins.
		if (cooldownArmed) return rootLoopsSinceReflect;
		return scanned;
	}

	function cooldownRemainingLoops() {
		const since = loopsSinceLastReflect();
		if (!Number.isFinite(since)) return 0;
		return Math.max(0, reflectCooldownLoops(config.rootLoopLimit) - since);
	}

	function skipAutomatic() {
		const since = loopsSinceLastReflect();
		// Pi skips while loopsSinceReflect <= cooldown, including the equal case.
		return Number.isFinite(since) && since <= reflectCooldownLoops(config.rootLoopLimit);
	}

	function statusText() {
		const counters = snapshot();
		const cooldown = cooldownRemainingLoops();
		return (
			`Reflect Watchdog${cooldown ? ` (${cooldown} loops disable)` : ""}` +
			` | active ${formatDuration(counters.activeMs)}/${counters.activeLoops} loops` +
			` · task ${formatDuration(counters.taskMs)}/${config.taskMinutes}m` +
			` · root ${counters.rootLoops}/${config.rootLoopLimit}` +
			` · all ${counters.allLoops}/${config.allLoopLimit}` +
			(manualQueue.length > 0
				? ` · queued · ${config.cancelShortcut === false ? "/cancel-reflect" : config.cancelShortcut} to cancel`
				: "")
		);
	}

	function refreshStatus() {
		const counters = snapshot();
		if (!counters.anyBusy && activeReflection === undefined && manualQueue.length === 0) {
			setStatus(STATUS_KEY, undefined);
			return;
		}
		setStatus(STATUS_KEY, statusText());
	}

	function stopTicker() {
		if (ticker !== undefined) clearIntervalFn(ticker);
		ticker = undefined;
	}

	function syncTicker() {
		const want = snapshot().anyBusy && !paused();
		if (want && ticker === undefined) {
			ticker = setIntervalFn(() => {
				reduce({ type: "tick", atMs: now() });
				latchAutomatic();
				refreshStatus();
				maybeDispatch();
				if (!snapshot().anyBusy) stopTicker();
			}, TICK_MS);
			ticker.unref?.();
		} else if (!want) stopTicker();
	}

	function setPaused(nextPaused) {
		if (paused() === nextPaused) return;
		reduce({ type: "pause", paused: nextPaused, atMs: now() });
		// Pi drops live contributors on pause and replays local busy on resume.
		if (!nextPaused) {
			for (const [id, busy] of busyAgents)
				reduce({ type: "activity", contributorId: id, busy, atMs: now() });
		}
		syncTicker();
		refreshStatus();
		maybeDispatch();
	}

	function crossedReasons() {
		const counters = snapshot();
		const reasons = [];
		if (counters.rootLoops >= config.rootLoopLimit) reasons.push("ROOT_LOOP_LIMIT");
		if (counters.allLoops >= config.allLoopLimit) reasons.push("ALL_LOOP_LIMIT");
		if (counters.taskMs >= config.taskMinutes * 60_000) reasons.push("TASK_TIME_LIMIT");
		return reasons.filter((reason) => !latched.has(reason));
	}

	function latchAutomatic() {
		if (paused()) return;
		const reasons = crossedReasons();
		if (reasons.length === 0) return;
		for (const reason of reasons) latched.add(reason);
		if (pendingAutomatic !== undefined) {
			for (const reason of reasons)
				if (!pendingAutomatic.reasons.includes(reason)) pendingAutomatic.reasons.push(reason);
			return;
		}
		reflectionSequence += 1;
		pendingAutomatic = {
			id: reflectionSequence,
			agent: primaryRoot(),
			reasons,
			thresholds: thresholdSnapshot(),
			timestamp: localTimestamp(),
		};
	}

	function primaryRoot() {
		const roots = agents();
		return roots[0];
	}

	function resetCycle() {
		latched.clear();
		pendingAutomatic = undefined;
		reduce({ type: "cycle-reset", atMs: now() });
		refreshStatus();
	}

	function queueManualReflection(agent, supplement) {
		if (agent === undefined || !isRoot(agent)) return "ignored";
		if (manualQueue.length > 0) return "coalesced";
		reflectionSequence += 1;
		const pending = {
			id: reflectionSequence,
			agent,
			reasons: ["USER_REQUEST"],
			thresholds: thresholdSnapshot(),
			userSupplement: supplement,
			timestamp: localTimestamp(),
		};
		manualQueue.push(pending);
		maybeDispatch();
		refreshStatus();
		return manualQueue.includes(pending) ? "queued" : "dispatched";
	}

	function cancelQueuedReflection() {
		if (manualQueue.length === 0) {
			toast("No queued reflection to cancel.");
			return false;
		}
		manualQueue.length = 0;
		refreshStatus();
		toast("Queued reflection cancelled.");
		return true;
	}

	function latestReflection(agent) {
		let history;
		try {
			history = agent.session.deriveMessages();
		} catch {
			return undefined;
		}
		for (let index = history.length - 1; index >= 0; index -= 1) {
			const message = history[index];
			const reflection = message?.source?.reflection;
			if (
				message?.role === "user" &&
				message?.source?.kind === SOURCE_KIND &&
				typeof reflection?.report === "string" &&
				typeof reflection?.timestamp === "string"
			)
				return { timestamp: reflection.timestamp, report: reflection.report };
		}
		return undefined;
	}

	async function streamText(request) {
		const runtime = llm();
		if (runtime === undefined) throw new Error("llm runtime unavailable");
		let text = "";
		let failure;
		for await (const chunk of runtime.stream(request)) {
			if (chunk?.type === "text-delta") text += chunk.text;
			else if (chunk?.type === "finish" && chunk.reason !== undefined && chunk.reason !== "stop" && chunk.reason !== "end_turn")
				failure = `stream finished with reason ${String(chunk.reason)}`;
		}
		if (failure !== undefined) throw new Error(failure);
		return text;
	}

	function maybeDispatch() {
		if (activeReflection !== undefined) return;
		const manual = manualQueue[0];
		if (manual !== undefined) {
			if (manual.agent === undefined || !agents().includes(manual.agent)) {
				manualQueue.shift();
				return;
			}
			manualQueue.shift();
			void runReflection(manual);
			refreshStatus();
			return;
		}
		if (paused()) return;
		const automatic = pendingAutomatic;
		if (automatic === undefined) return;
		pendingAutomatic = undefined;
		latched.clear();
		reduce({ type: "reminder-accepted", atMs: now() });
		if (automatic.agent === undefined || !agents().includes(automatic.agent)) return;
		if (skipAutomatic()) {
			toast("Reflect skipped during cooldown.");
			refreshStatus();
			return;
		}
		void runReflection(automatic);
		refreshStatus();
	}

	async function runReflection(pending) {
		const controller = new AbortController();
		activeReflection = { pending, controller };
		refreshStatus();
		const agent = pending.agent;
		const provider = config.reflectionProvider || agent.options?.provider;
		const model = config.reflectionModel || agent.options?.model;
		try {
			if (!provider || !model) throw new Error("target agent has no provider/model route");
			const history = agent.session.deriveMessages();
			const previous = latestReflection(agent);
			const contextMessage = buildReflectionContextMessage({
				timestamp: pending.timestamp,
				reasons: pending.reasons,
				thresholds: pending.thresholds,
				userSupplement: pending.userSupplement,
				previousReflection: previous,
			});
			let messages = [
				...history,
				createUser({
					content: [{ type: "text", text: contextMessage }],
					source: { kind: SOURCE_KIND },
				}),
			];
			let decision;
			let lastError = "no response";
			for (let attempt = 1; attempt <= MAX_REFLECTION_ATTEMPTS; attempt += 1) {
				const route = {};
			if (!config.reflectionProvider && agent.options?.reasoningEffort)
				route.reasoningEffort = agent.options.reasoningEffort;
			if (!config.reflectionProvider && agent.options?.maxTokens)
				route.maxTokens = agent.options.maxTokens;
			const text = await streamText({
					provider,
					model,
					system: config.reflectionPrompt,
					messages,
					signal: controller.signal,
					...route,
				});
				const validation = parseReflectionXml(text);
				if (validation.valid) {
					decision = validation.decision;
					break;
				}
				lastError = validation.error;
				if (attempt < MAX_REFLECTION_ATTEMPTS) {
					toast(`Reflection attempt ${attempt}/${MAX_REFLECTION_ATTEMPTS} invalid: ${lastError}; retrying.`, { color: "warning" });
					messages = [
						...messages,
						createAssistant({
							content: [{ type: "text", text }],
							source: { provider, model },
						}),
						createUser({
							content: [{ type: "text", text: buildReflectionReaskPrompt(lastError) }],
							source: { kind: SOURCE_KIND },
						}),
					];
				}
			}
			if (activeReflection?.pending !== pending) return;
			if (decision === undefined) {
				toast(`Reflection failed: ${lastError}`, { color: "warning" });
				return;
			}
			const report = formatReflectionReport(pending, decision);
			agent.steer(
				createUser({
					content: [{ type: "text", text: report }],
					source: {
						kind: SOURCE_KIND,
						form: "notice",
						summary: `Reflection · ${decision.type}`.slice(0, 120),
						reflection: {
							timestamp: pending.timestamp,
							report,
							type: decision.type,
							reasons: pending.reasons,
						},
					},
				}),
			);
			agent.steer(
				createUser({
					content: [{ type: "text", text: CONTINUATION_CONTENT }],
					source: { kind: SOURCE_KIND, form: "notice", summary: "Reflection continuation" },
				}),
			);
			cooldownArmed = true;
			rootLoopsSinceReflect = 0;
			if (decision.type === "NO_ISSUE") toast(`Reflect watchdog: ${decision.reason}`);
			try {
				emitCompleted({
					REFLECTION_TYPE: decision.type,
					REASON: clipHookText(decision.reason),
					NEXT_STEP: clipHookText(decision.nextStep),
				});
			} catch {
				// Completion-hook listeners never change the outcome.
			}
		} catch (error) {
			if (activeReflection?.pending !== pending) return;
			const message = error instanceof Error ? error.message : String(error);
			toast(`Reflection failed: ${message.slice(0, 160)}`, { color: "warning" });
		} finally {
			if (activeReflection?.pending === pending) {
				activeReflection = undefined;
				refreshStatus();
				maybeDispatch();
			}
		}
	}

	return {
		/** 'agent/status' equivalent: one agent flipped busy/idle. */
		agentActivity(agent, busy) {
			const id = contributorId(agent);
			if (id === undefined) return;
			busyAgents.set(id, busy);
			reduce({ type: "activity", contributorId: agent.id, busy, atMs: now() });
			syncTicker();
			latchAutomatic();
			refreshStatus();
			maybeDispatch();
		},
		agentDisposed(agent) {
			const id = contributorId(agent);
			if (id === undefined || !busyAgents.delete(id)) return;
			reduce({ type: "detached", contributorId: id, atMs: now() });
			syncTicker();
			refreshStatus();
		},
		/** One committed, non-interrupted assistant message (Pi turn_end stop|toolUse). */
		assistantMessage(agent) {
			if (paused()) return;
			const root = isRoot(agent);
			if (root) {
				if (cooldownArmed) rootLoopsSinceReflect += 1;
				reduce({ type: "loop", scope: "root", atMs: now() });
			} else {
				reduce({ type: "loop", scope: "all", atMs: now() });
			}
			syncTicker();
			latchAutomatic();
			refreshStatus();
			maybeDispatch();
		},
		/** Human-typed message or terminal abort: fresh activity cycle. */
		userTakeover() {
			resetCycle();
		},
		setPaused,
		queueManualReflection,
		cancelQueuedReflection,
		snapshot,
		statusText,
		cooldownRemainingLoops,
		get pendingAutomatic() {
			return pendingAutomatic;
		},
		get activeReflection() {
			return activeReflection;
		},
		get manualQueueLength() {
			return manualQueue.length;
		},
		dispose() {
			stopTicker();
			setStatus(STATUS_KEY, undefined);
		},
	};
}

export function apply(ctx, rawConfig = {}) {
	const config = resolveConfig(rawConfig);
	const agentsService = ctx.agents;

	const watchdog = createWatchdog({
		config,
		llm: () => ctx.get("llm"),
		agents: () => agentsService.roots(),
		isRoot: (agent) => agentsService.roots().includes(agent),
		setStatus: (key, text) => ctx.get("tuiStatus")?.set(key, text),
		toast: (text, options) => ctx.get("tuiToast")?.show(text, options),
		emitCompleted: (values) => {
			const envelope = Object.freeze({
				version: 1,
				name: REFLECTION_COMPLETED_HOOK,
				values: Object.freeze({ ...values }),
			});
			try {
				ctx.emit(SEMANTIC_HOOK_CHANNEL, envelope);
			} catch {
				// Completion-hook listeners never change the outcome.
			}
			try {
				ctx.emit(COMPLETED_EVENT, values);
			} catch {
				// Same containment as the Pi publisher.
			}
		},
	});

	const pauseDepths = config.hookPauses.map(() => 0);
	let askUserDepth = 0;
	const syncPause = () => {
		watchdog.setPaused(askUserDepth > 0 || pauseDepths.some((depth) => depth > 0));
	};
	ctx.on(SEMANTIC_HOOK_CHANNEL, (data) => {
		const name = data?.name;
		if (typeof name !== "string" || data?.version !== 1) return;
		let changed = false;
		config.hookPauses.forEach((pair, index) => {
			if (pair.pause === name) {
				pauseDepths[index] = Math.min(Number.MAX_SAFE_INTEGER, pauseDepths[index] + 1);
				changed = true;
			}
			if (pair.resume === name && pauseDepths[index] > 0) {
				pauseDepths[index] -= 1;
				changed = true;
			}
		});
		if (changed) syncPause();
	});

	ctx.on("agent/status", (payload) => {
		watchdog.agentActivity(payload.agent, payload.status === "running");
	});
	ctx.on("agent/disposed", (payload) => {
		watchdog.agentDisposed(payload.agent);
	});
	ctx.on("session/event", (session, event) => {
		if (event.type === "assistant/message" && event.data?.interrupted !== true) {
			const agent = agentsService.get(session.id);
			if (agent !== undefined) watchdog.assistantMessage(agent);
			return;
		}
		if (event.type === "user/message" && event.data?.source?.kind === "user") {
			watchdog.userTakeover();
			return;
		}
		if (event.type === "turn/end" && event.data?.reason?.kind === "aborted") {
			watchdog.userTakeover();
		}
	});

	if (config.pauseOnAskUser) {
		ctx.on("user-questions/request", async (_request, next) => {
			askUserDepth += 1;
			syncPause();
			try {
				return await next();
			} finally {
				askUserDepth = Math.max(0, askUserDepth - 1);
				syncPause();
			}
		});
	}

	const commands = ctx.get("commands");
	const unregister = [];
	const track = (disposer) => {
		if (typeof disposer === "function") unregister.push(disposer);
	};
	track(commands?.register({
		name: "reflect",
		description: "Queue an immediate reflection with optional user supplement",
		handler: async (invocation) => {
			const outcome = watchdog.queueManualReflection(
				invocation.agent,
				invocation.rawInput.trim() || undefined,
			);
			if (outcome === "ignored") return { kind: "error", text: "No live root agent." };
			if (outcome === "coalesced")
				return { kind: "success", text: "A reflection is already queued." };
			if (outcome === "queued")
				return {
					kind: "success",
					text: `Reflection queued · ${config.cancelShortcut === false ? "/cancel-reflect" : config.cancelShortcut} to cancel`,
				};
			return { kind: "success", text: "Reflection queued." };
		},
	}));
	track(commands?.register({
		name: "cancel-reflect",
		description: "Cancel a queued manual reflection before it starts",
		handler: async () => {
			watchdog.cancelQueuedReflection();
			return { kind: "success" };
		},
	}));

	if (config.cancelShortcut !== false) {
		const disposer = ctx
			.get("tuiShortcuts")
			?.register(config.cancelShortcut, {
				description: "Cancel queued reflection (dsh-reflect-watchdog)",
				handler: () => watchdog.cancelQueuedReflection(),
			});
		if (typeof disposer === "function") ctx.effect(() => disposer);
	}

	return () => {
		for (const disposer of unregister) {
			try {
				disposer();
			} catch {
				// Registry teardown must not block watchdog disposal.
			}
		}
		watchdog.dispose();
	};
}

export const inject = ["agents"];

export default { name, inject, Config, apply };
