# dsh-reflect-watchdog

Root-agent loop and active-time watchdog for DeepSeek Harness. Port of [pi-reflect-watchdog](https://github.com/xz-dev/pi-reflect-watchdog) (BSD-3-Clause, Xiangzhe).

Counters follow that plugin's local activity machine: busy/idle, 10s grace, 5s heartbeat sleep freeze, idle-gap reset. Crossing `rootLoopLimit`, `allLoopLimit`, or `taskMinutes` runs an oracle call on the target agent's own provider/model (optional `reflectionProvider` / `reflectionModel` override). A valid `<reflection>` verdict is steered back as a user notice plus a second steer whose body is exactly `[assistant]\ncontinue`. `/reflect` and `/cancel-reflect` match the Pi commands; `alt+x` cancels a queued manual request. Completion publishes `reflection-completed` on `pi:semantic-hook:v1` so `dsh-notify` can deliver it. Ask-user pauses come from that same bus (`ask-user-wait-started` / `ask-user-wait-finished`), which is what `~/.pi/agent/pi-reflect-watchdog.json` configures.

See [BEHAVIOR.md](BEHAVIOR.md) for what is actually equivalent and what is not.

```bash
node ~/.local/share/dsh/npm/node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile tui add file:/absolute/path/dsh-reflect-watchdog-0.1.0.tgz --ignore-scripts
```

The packed `cordis.patch.yml` inserts the plugin with the user's thresholds. `dsh-notify` must be enabled too, or ask-user waits will not freeze counters unless you set `pauseOnAskUser: true` and clear `hookPauses`.
