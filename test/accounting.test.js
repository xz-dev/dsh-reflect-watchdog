import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createAccountingState,
	GRACE_FENCE_MS,
	reduceAccountingState,
	SLEEP_GAP_MS,
	snapshotAccounting,
} from "../src/accounting.js";

test("active time counts only while busy and resets after a long idle gap", () => {
	let state = createAccountingState({ nowMs: 0, idleResetGapMs: 60_000 });
	state = reduceAccountingState(state, { type: "activity", contributorId: "root", busy: true, atMs: 0 });
	state = reduceAccountingState(state, { type: "tick", atMs: 5_000 });
	assert.equal(snapshotAccounting(state).activeMs, 5_000);
	state = reduceAccountingState(state, { type: "loop", scope: "root", atMs: 5_000 });
	state = reduceAccountingState(state, { type: "activity", contributorId: "root", busy: false, atMs: 5_000 });
	state = reduceAccountingState(state, { type: "tick", atMs: 5_000 + GRACE_FENCE_MS + 1 });
	state = reduceAccountingState(state, { type: "activity", contributorId: "root", busy: true, atMs: 90_000 });
	const shot = snapshotAccounting(state);
	assert.equal(shot.activeMs, 0);
	assert.equal(shot.rootLoops, 0);
});

test("sleep gap freezes an open interval and pause drops the gap", () => {
	let state = createAccountingState({ nowMs: 0, idleResetGapMs: 60_000 });
	state = reduceAccountingState(state, { type: "activity", contributorId: "root", busy: true, atMs: 0 });
	state = reduceAccountingState(state, { type: "tick", atMs: SLEEP_GAP_MS + 5_000 });
	const slept = snapshotAccounting(state).activeMs;
	assert.ok(slept < 6_000, `slept wall time leaked: ${slept}`);
	state = reduceAccountingState(state, { type: "pause", paused: true, atMs: 20_000 });
	state = reduceAccountingState(state, { type: "tick", atMs: 40_000 });
	const pausedMs = snapshotAccounting(state).activeMs;
	state = reduceAccountingState(state, { type: "pause", paused: false, atMs: 40_000 });
	state = reduceAccountingState(state, { type: "activity", contributorId: "root", busy: true, atMs: 40_000 });
	state = reduceAccountingState(state, { type: "tick", atMs: 41_000 });
	assert.equal(snapshotAccounting(state).activeMs, pausedMs + 1_000);
});

test("reminder-accepted clears task and loop counters but keeps active time", () => {
	let state = createAccountingState({ nowMs: 0, idleResetGapMs: 60_000 });
	state = reduceAccountingState(state, { type: "activity", contributorId: "root", busy: true, atMs: 0 });
	state = reduceAccountingState(state, { type: "loop", scope: "root", atMs: 1_000 });
	state = reduceAccountingState(state, { type: "loop", scope: "all", atMs: 1_000 });
	state = reduceAccountingState(state, { type: "reminder-accepted", atMs: 1_000 });
	const shot = snapshotAccounting(state, 1_000);
	assert.equal(shot.rootLoops, 0);
	assert.equal(shot.allLoops, 0);
	assert.equal(shot.taskMs, 0);
	assert.equal(shot.activeLoops, 2);
	assert.equal(shot.activeMs, 1_000);
});
