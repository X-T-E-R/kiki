# Concurrency load benchmark

Runs N concurrent sessions against a real kap-server (HTTP + WebSocket) with a
local stub model provider on 127.0.0.1. No real model requests are made and no
user home is touched. Not part of CI.

Each session runs the real agent loop and real tools (Read, Grep, Glob, Edit,
TodoList, Bash, foreground AgentRun with the `explore` profile) inside an
isolated workspace. Simulated GUI clients open WebSocket views, read first
screens and older pages, poll the session list, session point reads, agent
panel metrics and the activity panel, and refresh a session on
`session.metaUpdated` events at most once per 250 ms per session, as the GUI does.

Use the Node version from the repository `.nvmrc`. Run from the repository
root. On Windows, build the process helper once first:

```sh
node packages/agent-core-v2/scripts/build-windows-process-helper.mjs
node --import tsx --import ./build/register-raw-text-loader.mjs packages/kap-server/bench/concurrency/driver.mts --sessions 10 --clients 3 --duration 60 --label head
node packages/kap-server/bench/concurrency/brief.mjs .tmp/perf-concurrency/head-n10
node packages/kap-server/bench/concurrency/analyze.mjs .tmp/perf-concurrency/head-n10
```

The 100-session regression target is
`--sessions 100 --clients 12 --duration 90 --warmup 20 --no-profile`; it takes
about four minutes. Pass `--no-profile` for timing comparisons, because the
CPU profiler adds main-thread overhead.

Options: `--sessions`, `--clients`, `--duration` (measured seconds),
`--warmup` (seconds), `--ttft` (ms), `--tps` (stub tokens per second),
`--steps` (tool steps per turn), `--subagent-every` (turns), `--root`
(scratch root, default `.tmp/perf-concurrency` in the repository, which is
gitignored), `--label`, `--no-profile`.

Outputs in `<root>/<label>-n<N>/out/`: `summary.json` (event loop, step gaps,
tool phases, HTTP/WS latencies, CPU, memory, errors), `server.cpuprofile`, and
`hotspots.json` from `analyze.mjs`. `brief.mjs` prints a one-screen summary.
`callers.mjs <runDir> <regex> [depth]`, `callees.mjs` and `roots.mjs`
attribute profile time by caller, callee and entry point.

The harness is not part of CI, `pnpm test`, or the package typecheck.

Model concurrency limits in `[request_governance]` are deliberate throttling,
not stalls; the generated config sets no rules so the stub absorbs every
request concurrently.
