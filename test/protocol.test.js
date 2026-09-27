import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildReflectionReaskPrompt,
	formatReflectionReport,
	parseReflectionXml,
} from "../src/protocol.js";
import { buildXmlDocument } from "../src/xml.js";

const valid = buildXmlDocument("reflection", [
	{ name: "type", value: "route_correction" },
	{ name: "reason", value: "goal drifted" },
	{ name: "done", value: "tried A" },
	{ name: "current_step", value: "editing" },
	{ name: "next_step", value: "stop and reread" },
]);

test("parse accepts case-insensitive type and tags", () => {
	const tagged = valid.replace(/<\/?reflection>/g, (tag) => tag.toUpperCase());
	const parsed = parseReflectionXml(`note\n${tagged}`);
	assert.equal(parsed.valid, true);
	assert.equal(parsed.decision.type, "ROUTE_CORRECTION");
	assert.equal(parsed.decision.nextStep, "stop and reread");
});

test("parse rejects extra text after the document and unknown types", () => {
	assert.equal(parseReflectionXml(`${valid}\nmore`).valid, false);
	const bad = valid.replace("route_correction", "MAYBE");
	assert.match(parseReflectionXml(bad).error, /NO_ISSUE or ROUTE_CORRECTION/);
});

test("report keeps trigger thresholds and reask names the parser error", () => {
	const report = formatReflectionReport(
		{
			timestamp: "t",
			reasons: ["TASK_TIME_LIMIT"],
			thresholds: {
				activeMs: 1000,
				activeLoops: 2,
				taskMs: 60000,
				taskMinutes: 20,
				rootLoops: 3,
				rootLoopLimit: 60,
				allLoops: 4,
				allLoopLimit: 300,
			},
		},
		{
			type: "NO_ISSUE",
			reason: "fine",
			done: "d",
			currentStep: "c",
			nextStep: "n",
		},
	);
	assert.match(report, /Reflection · NO_ISSUE/);
	assert.match(report, /TASK_TIME_LIMIT/);
	assert.match(buildReflectionReaskPrompt("duplicate reflection field type"), /duplicate reflection field type/);
});
