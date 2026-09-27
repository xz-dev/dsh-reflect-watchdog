# Behaviour checklist

Source: `~/.pi/agent/git/github.com/xz-dev/pi-reflect-watchdog` and `~/.pi/agent/pi-reflect-watchdog.json` (`hookPauses`: `ask-user-wait-started` / `ask-user-wait-finished`; every numeric threshold left at the built-in default).

| item | Pi evidence | DSH mapping | status | test |
| --- | --- | --- | --- | --- |
| Defaults 60 root loops / 300 all loops / 20 task minutes / 60s idle gap / cancel `alt+x` | `src/config.ts` `BUILT_IN_CONFIG` | `resolveConfig` + `cordis.patch.yml` | ported | `test/watchdog.test.js` (shortcut registration) |
| User hook pair pauses counters | `pi-reflect-watchdog.json`; `extension.ts` `handlePauseHook` per-pair depth | `pi:semantic-hook:v1` listener, same names. `dsh-notify` publishes them around `ask_user_question`. `pauseOnAskUser` is off so the waterfall does not nest the same wait | ported | `apply pauses on the user's ask-user semantic hooks` |
| Count only successful root `turn_end` (`stop`/`toolUse`); children count all-loops | `extension.ts` `isSuccessfulTurn`, `recordRootLoop` / `recordAllLoop` | Non-interrupted `session/event` `assistant/message`. Root = `ctx.agents.roots()`. Child agents in the same registry count all-loops only | ported | `root and child loops` |
| Active time, 10s grace, sleep freeze, idle reset, reminder clears task/root/all only | `src/collection-state.ts` | `src/accounting.js` (no peer ledger) | ported | `test/accounting.test.js` |
| Thresholds fire while other agents are still busy and enter steering immediately | README; `maybeDispatch` | Tick and loop handlers call `maybeDispatch`. Oracle is `ctx.llm.stream` on the agent route, then `agent.steer` | ported | task-time test; root-loop test |
| Cooldown `clamp(floor(root/3), 10, 30)` skips automatic reflects while `loopsSince <= cooldown`, including equal | `reflectCooldownLoops`, `reflectCooldownState` | In-process counter, zeroed when the report is steered. After restart, assistant messages after the last steered reflection report are counted | ported | `task-time retrigger inside the cooldown` |
| `/reflect` supplement, coalesce while one is waiting, `/cancel-reflect` and `alt+x` before start | `queueManualReflection`, `cancelQueuedReflection` | `ctx.commands` + `ctx.tuiShortcuts`. Ignored off the root agent. In-flight oracle is not cancelled | ported | `manual reflect` |
| Oracle XML, 3 attempts, case-insensitive tags/type, `NO_ISSUE` or `ROUTE_CORRECTION` | `reflection-protocol.ts`, `MAX_REFLECTION_REASKS` | `src/protocol.js` + `src/xml.js`. Same default oracle prompt | ported | `test/protocol.test.js`, invalid-XML test |
| Report then exactly `[assistant]\ncontinue` | `REFLECTION_CONTINUATION_CONTENT`, `finishReflection` | Two `agent.steer` user messages. Continuation body exact | partial | root-loop test asserts both bodies |
| `reflection-completed` with `REFLECTION_TYPE`, `REASON`, `NEXT_STEP`, 4096 clip | `publishReflectionCompleted` | `ctx.emit("pi:semantic-hook:v1", {version:1, name:"reflection-completed", values})` plus `reflect-watchdog/completed` | ported | apply test |
| Human `user` message and terminal assistant abort reset the cycle | `isUserTakeoverMessageStart`, `isAbortedTerminalTakeover` | `user/message` with `source.kind === "user"` resets. Any `turn/end` `reason.kind === "aborted"` resets | partial | takeover test covers the user message |
| Pause clears live contributors and replays busy on resume; `/reflect` still runs | `pause-changed` then local-activity replay | Same reducer, then `busyAgents` replay. Manual queue is not paused | ported | `user takeover and pause/resume` |
| Status row | `widget.ts` | `ctx.tuiStatus.set`. Host caps text at 200 cells (`dsh-tui` `status.d.ts`) | partial | not asserted against the host cap |
| NO_ISSUE toast | `finishReflection` | `ctx.tuiToast.show` | ported | completion payload test covers the decision; toast is the same branch |
| Up to 10 tool calls and a session-file history locator inside the inquiry | README; `MAX_REFLECTION_TOOL_CALLS`; `buildReflectionPrompt` | No call. `LlmRuntime.stream` can list tools but nothing executes them, and there is no session custom-entry fold | gap | — |
| Automatic report as assistant, manual as user; context-excluded until the source assistant remains; compaction sees only the wake | README "Returning to ordinary work" | `Agent.steer` accepts only `UserMessage` (`dsh-agent` `runtime-types.d.ts`). No custom-entry projection API | gap | — |
| Cross-process child counters and checkpoint fencing | `process-domain.ts` | Same-process `agent/status` only. No peer transport seam | gap | — |
| Project `.pi/pi-reflect-watchdog.json` merge | `config-loader.ts` | Cordis config only. The user's file has no project override | gap | — |
| Inquiry turns excluded from counters | README | Oracle is not an agent turn, so it cannot increment counters | built-in | invalid-XML test steers nothing |
| Steering waits for the next step boundary and does not abort the current tool batch | Pi `deliverAs: "steer"` | `agent.steer` (`runtime-types.d.ts` "nearest step") | built-in | — |

## Gaps (missing seam)

- Tool-using inquiry: DSH has no plugin-facing excluded side turn. `llm.stream` (`dsh-llm` `GenerateOptions.tools`) does not run tools or fold attempts out of `deriveMessages()`.
- Report role and compaction bypass: no custom message type, no context projection hook that drops a report from compaction while keeping it for the next oracle. Both verdicts are durable user notices.
- Cross-process aggregation: `ctx.agents` is one process. Subagents that are not registry agents are invisible.
- Project config file: no DSH equivalent of Pi's trusted project JSON loader; put overrides in the cordis row.
