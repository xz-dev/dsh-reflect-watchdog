/**
 * Single-process port of pi-reflect-watchdog's collection-state reducer
 * (src/collection-state.ts, BSD-3-Clause, xz-dev). Peer checkpointing,
 * ledger replay fencing and the process-domain transport are dropped: DSH
 * runs one process per TUI, so only local contributors exist. The phase
 * machine (idle/collecting/grace), the 10s grace fence, the 5s heartbeat
 * sleep freeze and the idle-reset gap keep the exact Pi semantics.
 */

export const GRACE_FENCE_MS = 10_000;
export const HEARTBEAT_MS = 5_000;
export const SLEEP_GAP_MS = 10_000;

function busyCount(live) {
	let count = 0;
	for (const contributor of live.values()) if (contributor.busy) count += 1;
	return count;
}

function settleAccounting(accounting, atMs) {
	if (accounting.paused) return accounting;
	const activeDelta =
		accounting.activeSinceMs === null ? 0 : atMs - accounting.activeSinceMs;
	const taskDelta =
		accounting.taskSinceMs === null ? 0 : atMs - accounting.taskSinceMs;
	return {
		...accounting,
		activeMs: accounting.activeMs + activeDelta,
		taskMs: accounting.taskMs + taskDelta,
		activeSinceMs: accounting.activeSinceMs === null ? null : atMs,
		taskSinceMs: accounting.taskSinceMs === null ? null : atMs,
	};
}

function resetCycle(accounting) {
	return {
		...accounting,
		activeMs: 0,
		activeLoops: 0,
		taskMs: 0,
		rootLoops: 0,
		allLoops: 0,
	};
}

function withLive(state, live, atMs) {
	const wasBusy = busyCount(state.live) > 0;
	const isBusy = busyCount(live) > 0;
	const inGrace = state.accounting.graceSinceMs !== null;
	let accounting = settleAccounting(state.accounting, atMs);

	if (accounting.paused) {
		return { ...state, nowMs: atMs, live: new Map(), accounting };
	}
	if (!wasBusy && !inGrace && isBusy) {
		// idle -> collecting: reopen the active interval; a long idle gap
		// resets counters only, never timestamps beyond the reopen.
		if (
			accounting.idleSinceMs !== null &&
			atMs > accounting.idleSinceMs + state.idleResetGapMs
		)
			accounting = resetCycle(accounting);
		accounting = {
			...accounting,
			activeSinceMs: atMs,
			taskSinceMs: atMs,
			idleSinceMs: null,
			graceSinceMs: null,
		};
	} else if (inGrace && isBusy) {
		// grace -> collecting: rejoined inside the fence, no loss.
		accounting = {
			...accounting,
			activeSinceMs: atMs,
			taskSinceMs: atMs,
			idleSinceMs: null,
			graceSinceMs: null,
		};
	} else if (wasBusy && !isBusy) {
		// collecting -> grace: cut the interval at the true all-idle instant.
		accounting = {
			...accounting,
			activeSinceMs: null,
			taskSinceMs: null,
			idleSinceMs: null,
			graceSinceMs: atMs,
		};
	} else if (inGrace && !isBusy) {
		const graceSinceMs = accounting.graceSinceMs;
		if (atMs - graceSinceMs > GRACE_FENCE_MS) {
			accounting = {
				...accounting,
				activeSinceMs: null,
				taskSinceMs: null,
				idleSinceMs: graceSinceMs,
				graceSinceMs: null,
			};
		}
	} else if (!isBusy) {
		accounting = {
			...accounting,
			activeSinceMs: null,
			taskSinceMs: null,
			idleSinceMs: accounting.idleSinceMs ?? atMs,
			graceSinceMs: null,
		};
	}
	return { ...state, nowMs: atMs, live, accounting };
}

function addLoopDelta(state, rootDelta, allDelta) {
	if (state.accounting.paused || rootDelta < 0 || allDelta < rootDelta)
		return state;
	return {
		...state,
		accounting: {
			...state.accounting,
			activeLoops: state.accounting.activeLoops + allDelta,
			rootLoops: state.accounting.rootLoops + rootDelta,
			allLoops: state.accounting.allLoops + allDelta,
		},
	};
}

export function createAccountingState(options = {}) {
	const nowMs = options.nowMs ?? 0;
	const idleResetGapMs = options.idleResetGapMs ?? 60_000;
	if (
		!Number.isSafeInteger(nowMs) ||
		nowMs < 0 ||
		!Number.isSafeInteger(idleResetGapMs) ||
		idleResetGapMs <= 0
	)
		throw new RangeError("accounting timing must use positive safe milliseconds");
	return {
		nowMs,
		idleResetGapMs,
		live: new Map(),
		accounting: {
			paused: false,
			pausedAtMs: null,
			activeMs: 0,
			activeLoops: 0,
			taskMs: 0,
			rootLoops: 0,
			allLoops: 0,
			activeSinceMs: null,
			taskSinceMs: null,
			idleSinceMs: null,
			graceSinceMs: null,
		},
	};
}

export function reduceAccountingState(state, event) {
	if (!Number.isSafeInteger(event.atMs) || event.atMs < 0) return state;
	const atMs = Math.max(state.nowMs, event.atMs);

	switch (event.type) {
		case "activity": {
			if (state.accounting.paused) return state;
			const live = new Map(state.live);
			live.set(event.contributorId, { busy: event.busy });
			return withLive(state, live, atMs);
		}
		case "detached": {
			if (!state.live.has(event.contributorId)) return state;
			const live = new Map(state.live);
			live.delete(event.contributorId);
			return withLive(state, live, atMs);
		}
		case "loop": {
			if (state.accounting.paused) return state;
			const advanced = withLive(state, new Map(state.live), atMs);
			return addLoopDelta(advanced, event.scope === "root" ? 1 : 0, 1);
		}
		case "pause": {
			if (state.accounting.paused === event.paused) return state;
			let accounting = settleAccounting(state.accounting, atMs);
			if (event.paused) {
				accounting = {
					...accounting,
					paused: true,
					pausedAtMs: atMs,
					activeSinceMs: null,
					taskSinceMs: null,
					graceSinceMs: null,
				};
			} else {
				const pausedDuration =
					accounting.pausedAtMs === null ? 0 : atMs - accounting.pausedAtMs;
				accounting = {
					...accounting,
					paused: false,
					pausedAtMs: null,
					activeSinceMs: null,
					taskSinceMs: null,
					graceSinceMs: null,
					idleSinceMs:
						accounting.idleSinceMs === null
							? null
							: accounting.idleSinceMs + pausedDuration,
				};
			}
			return { ...state, nowMs: atMs, live: new Map(), accounting };
		}
		case "tick": {
			if (state.accounting.paused) return { ...state, nowMs: atMs };
			// Sleep freeze: only an OPEN active interval loses wall time when the
			// host sleeps; a gap while idle or in grace shifts nothing.
			const gap = atMs - state.nowMs;
			let accounting = state.accounting;
			if (accounting.activeSinceMs !== null && gap > SLEEP_GAP_MS) {
				const shift = gap - HEARTBEAT_MS;
				accounting = {
					...accounting,
					activeSinceMs: accounting.activeSinceMs + shift,
					taskSinceMs:
						accounting.taskSinceMs === null
							? null
							: accounting.taskSinceMs + shift,
				};
			}
			return withLive({ ...state, accounting }, new Map(state.live), atMs);
		}
		case "reminder-accepted": {
			let accounting = settleAccounting(state.accounting, atMs);
			accounting = {
				...accounting,
				taskMs: 0,
				rootLoops: 0,
				allLoops: 0,
				taskSinceMs:
					!accounting.paused && busyCount(state.live) > 0 ? atMs : null,
			};
			return { ...state, nowMs: atMs, accounting };
		}
		case "cycle-reset": {
			const accounting = settleAccounting(state.accounting, atMs);
			const anyBusy = !accounting.paused && busyCount(state.live) > 0;
			return {
				...state,
				nowMs: atMs,
				accounting: {
					...accounting,
					activeMs: 0,
					activeLoops: 0,
					taskMs: 0,
					rootLoops: 0,
					allLoops: 0,
					activeSinceMs: anyBusy ? atMs : null,
					taskSinceMs: anyBusy ? atMs : null,
					idleSinceMs: anyBusy ? null : (accounting.idleSinceMs ?? atMs),
					graceSinceMs: anyBusy ? null : accounting.graceSinceMs,
				},
			};
		}
		default:
			return state;
	}
}

export function snapshotAccounting(state, atMs = state.nowMs) {
	const nowMs =
		Number.isSafeInteger(atMs) && atMs >= 0 ? Math.max(state.nowMs, atMs) : state.nowMs;
	const accounting = settleAccounting(state.accounting, nowMs);
	const busyContributors = busyCount(state.live);
	return {
		paused: accounting.paused,
		anyBusy: !accounting.paused && busyContributors > 0,
		activeMs: accounting.activeMs,
		activeLoops: accounting.activeLoops,
		taskMs: accounting.taskMs,
		rootLoops: accounting.rootLoops,
		allLoops: accounting.allLoops,
		busyContributors,
	};
}
