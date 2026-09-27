/**
 * Reflection prompt and XML verdict protocol, ported from
 * pi-reflect-watchdog src/prompts.ts + src/reflection-protocol.ts
 * (BSD-3-Clause, xz-dev). The oracle perspective text is verbatim; the
 * generated context block drops Pi's session-file history locator and the
 * tool-call budget, because the DSH port runs the reflection as one direct
 * auxiliary model call without tools (see BEHAVIOR.md).
 */
import { buildXmlDocument, MAX_XML_TEXT_CODE_POINTS, parseTrailingXml } from "./xml.js";

export const DEFAULT_REFLECTION_PROMPT = `You are an oracle with critical thinking, like The Oracle from *The Matrix*.

You do not predict a future that is already fixed. By observing goals, motives, choices, patterns of behavior, and cause and effect, you see where events are most likely to lead. Your role is not to make decisions for others, but to help them see what they truly want, what choice they are actually making, and where that choice may lead.

Assess the interaction from a third-party perspective, including how the working agent has interpreted the task. Understand the user's meaning across surrounding replies and later clarifications, rather than treating isolated statements as a settled goal. You can question the goal itself; distinguish that new interpretation from what the user actually expressed.

When invoked, do not rush to solve the immediate problem. First, step back, look at the whole picture, and think from first principles:

- Is the stated goal the result we truly want?
- Even if the current approach succeeds, will it solve the underlying problem?
- Which important assumptions remain untested but are being treated as facts?
- Are the current actions aligned with the real goal?
- Proactively audit the entire chain of execution for unnecessary detours, reversals, repeated work, or circular progress.
- Are fear, inertia, sunk costs, or short-term pressure causing us to avoid a more important question?
- If we continue making the same choices, where are we most likely to arrive?

Look beneath the visible task for the conflict that truly matters. Notice recurring patterns, unspoken trade-offs, and choices that have already been made through action.

Your voice lives inside the structured answer fields you return: speak calmly, kindly, and directly there. Do not judge from above, and do not become cryptic merely to sound profound. You may use short questions, simple analogies, or precise observations inside those fields to help others recognize the answer for themselves.

If you find a misaligned goal, a false assumption, a deviation from the intended path, or wasted effort, state it clearly. Explain the pattern you see and its likely consequences, then propose a more fundamental and effective direction. Do not defend the current approach simply because time and effort have already been invested.

Distinguish facts from inference and uncertainty. Do not present possibility as destiny, and do not pretend to know what cannot be known.

You do not need to say everything you see. Prioritize the one insight that is most likely to change the judgment, choice, or direction that matters now.

Your core objective is to identify the direction that most quickly leads to the outcome the end user actually wants.`;

export const MAX_REFLECTION_TEXT_CHARACTERS = MAX_XML_TEXT_CODE_POINTS;
/** Maximum total XML attempts, matching the Pi contract (1 initial + 2 reasks). */
export const MAX_REFLECTION_ATTEMPTS = 3;

export const REFLECTION_ROOT_TAG = "reflection";

const REQUIRED_FIELDS = ["type", "reason", "done", "current_step", "next_step"];

export function formatDuration(ms) {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}

function normalizeReflectionXmlCase(text) {
	return text.replace(
		/<\/?(reflection|type|reason|done|current_step|next_step)>/gi,
		(tag, name) => `${tag.startsWith("</") ? "</" : "<"}${name.toLowerCase()}>`,
	);
}

export function parseReflectionXml(text) {
	const parsed = parseTrailingXml(normalizeReflectionXmlCase(text), REFLECTION_ROOT_TAG);
	if (!parsed.valid) return parsed;
	const normalizedFields = new Map();
	for (const [name, value] of parsed.value.fields) {
		const normalized = name.toLowerCase();
		if (normalizedFields.has(normalized))
			return { valid: false, error: `duplicate reflection field ${normalized}` };
		normalizedFields.set(normalized, value);
	}
	if (
		normalizedFields.size !== REQUIRED_FIELDS.length ||
		REQUIRED_FIELDS.some((name) => !normalizedFields.has(name))
	)
		return {
			valid: false,
			error: "reflection XML must contain exactly the five required fields",
		};
	const values = new Map();
	for (const name of REQUIRED_FIELDS) {
		const value = normalizedFields.get(name)?.trim();
		if (!value)
			return { valid: false, error: `reflection field ${name} must be non-empty` };
		values.set(name, value);
	}
	const type = values.get("type")?.toUpperCase();
	if (type !== "NO_ISSUE" && type !== "ROUTE_CORRECTION")
		return { valid: false, error: "reflection type must be NO_ISSUE or ROUTE_CORRECTION" };
	return {
		valid: true,
		decision: {
			type,
			reason: values.get("reason"),
			done: values.get("done"),
			currentStep: values.get("current_step"),
			nextStep: values.get("next_step"),
		},
	};
}

/**
 * Build the user-side context message appended after the conversation
 * history. The semantic prefix travels as the request's system prompt.
 */
export function buildReflectionContextMessage(context) {
	const supplement = context.userSupplement?.trim();
	const previous = context.previousReflection;
	const example = buildXmlDocument(REFLECTION_ROOT_TAG, [
		{ name: "type", value: "NO_ISSUE" },
		{ name: "reason", value: "why the route is sound" },
		{ name: "done", value: "completed work" },
		{ name: "current_step", value: "current work" },
		{ name: "next_step", value: "suggested next step" },
	]);
	return `Earlier assistant reflection (fallible historical analysis, not the user's words or a conclusion to preserve):
${previous ? `${previous.timestamp}\n${previous.report}` : "(none)"}

[Plugin-generated reflection context]
Current local RFC3339 time: ${context.timestamp}
Trigger source(s): ${context.reasons.join(", ")}
Threshold snapshot: active=${formatDuration(context.thresholds.activeMs)}/${context.thresholds.activeLoops} loops; task=${formatDuration(context.thresholds.taskMs)}/${context.thresholds.taskMinutes}m; root=${context.thresholds.rootLoops}/${context.thresholds.rootLoopLimit}; all=${context.thresholds.allLoops}/${context.thresholds.allLoopLimit}
User supplement: ${supplement ? supplement : "(none)"}

Branch-scoped history recovery unavailable in this harness. Use the current conversation context.

Your entire response must be exactly one <reflection>...</reflection> XML document, with no text before or after it; express all observations and reasoning inside the five fields. XML names and the type value are case-insensitive. The document must contain exactly these five unique, non-empty fields in any order: type, reason, done, current_step, next_step. The type must be NO_ISSUE or ROUTE_CORRECTION. Total non-thinking assistant text must not exceed ${MAX_REFLECTION_TEXT_CHARACTERS} Unicode characters, so keep every word inside the XML fields. Example:
${example}

Do not copy untrusted text into XML without escaping it. Example escaped supplement:
${buildXmlDocument("supplement", [{ name: "text", value: supplement ?? "none" }])}`;
}

export function buildReflectionReaskPrompt(error) {
	return `Your previous reflection response was invalid: ${error}\nCorrect it now. Your entire response must be exactly one valid <reflection> XML document with no text before or after it, containing exactly the unique non-empty type, reason, done, current_step, and next_step fields.`;
}

export function formatReflectionReport(pending, decision) {
	const supplement = pending.userSupplement?.trim();
	return [
		`Reflection · ${decision.type}`,
		`Time: ${pending.timestamp}`,
		`Trigger: ${pending.reasons.join(", ")}`,
		`Thresholds: active=${formatDuration(pending.thresholds.activeMs)}/${pending.thresholds.activeLoops} loops; task=${formatDuration(pending.thresholds.taskMs)}/${pending.thresholds.taskMinutes}m; root=${pending.thresholds.rootLoops}/${pending.thresholds.rootLoopLimit}; all=${pending.thresholds.allLoops}/${pending.thresholds.allLoopLimit}`,
		`User supplement: ${supplement ? supplement : "(none)"}`,
		`Reason: ${decision.reason}`,
		`Done: ${decision.done}`,
		`Current step: ${decision.currentStep}`,
		`Next step: ${decision.nextStep}`,
	].join("\n");
}
