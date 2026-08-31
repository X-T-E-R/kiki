# `@moonshot-ai/acp-client`

Outbound ACP v1 client and child-process lifecycle engine for external agent executors.

## Boundary

This package owns ACP transport, process lifecycle, remote-session opening, cancellation, session-ref validation, and the first ACP-to-executor-neutral event mapper. It does not know about Kiki turns, transcript records, interactions, profiles, or dependency injection. The agent-core adapter supplies those policies and projects the normalized events into Kiki's canonical turn and transcript contracts.

`packages/acp-server` is the opposite protocol role: it exposes Kiki as an ACP Agent. This package hosts an external ACP Agent as the ACP Client.

## Main API

```ts
import { AcpProcessClient } from '@moonshot-ai/acp-client';

const client = new AcpProcessClient(hostProcessService, {
  id: 'grok-acp',
  command: 'grok',
  args: ['agent', 'stdio'],
  startupTimeoutMs: 70_000,
  shutdownGraceMs: 3_000,
});

const controller = new AbortController();
const turn = await client.startTurn({
  prompt: 'Inspect the repository',
  signal: controller.signal,
  session: {
    cwd: workspacePath,
    sessionRef: durableRef,
    configOptions: [{ configId: 'model', value: 'grok-build' }],
  },
});

for await (const event of turn.events) {
  recordNormalizedExecutorEvent(event);
}
const result = await turn.completion;
```

The constructor accepts the minimal shape shared by `IHostProcessService`: `spawn(command, args, options)`, returning piped stdin/stdout/stderr plus `wait`, `kill`, and `dispose`. The package never imports or calls `child_process.spawn`; production injects the runtime lease's process service and tests may inject a fake.

`AcpProcessClient` exports:

- `status()` with the full `cold → spawning → initializing → opening_session → configuring → ready ⇄ prompting` lifecycle;
- `openSession()` implementing live reuse, `session/resume`, `session/load`, then `session/new` fallback;
- `startTurn()` returning an async normalized event stream and completion promise;
- `cancel()` implementing `session/cancel`, JSON-RPC request cancellation, cancel grace, connection close, TERM, and KILL;
- `shutdown()`, `stderrTail()`, and `sessionRef()`.

On Windows, process-tree termination is explicit: TERM/KILL escalation uses injected `taskkill /PID <pid> /T` and `/F` through the same host process service. stdout is reserved for ACP NDJSON; stderr is separately logged and retained in a bounded ring.

## Normalized executor events

`mapAcpSessionNotification()` and `mapAcpSessionUpdate()` are the first mapper required by the executor-neutral adapter boundary. They emit `NormalizedExecutorEvent`, including:

- `message.delta` and `thought.delta`;
- `tool.call` and `tool.update`;
- `plan.update` and `plan.remove`;
- `commands.update`, `mode.update`, `config.update`, and `session.info`;
- `usage`;
- `unknown` for forward-compatible update discriminators.

Known malformed updates are protocol errors and close the connection. Unknown update discriminators are rewritten before the SDK's closed-union parser, mapped to `unknown`, and never expose ACP schema types to downstream executor recorders.

## Durable session refs

`parseExecutorSessionRefEnvelope`, `serializeExecutorSessionRefEnvelope`, and `deserializeExecutorSessionRefEnvelope` validate:

```ts
{
  executorId: string;
  version: number;
  ref: Record<string, unknown>;
}
```

Refs must be bounded JSON, have limited nesting, contain no secret-like keys, and match the executor ID/version before reuse. Persistence remains the adapter's responsibility.

## Test fixtures

`test/fixtures/in-process-scripted-agent.ts` uses SDK `agent()` and direct `ClientApp ↔ AgentApp` connection for protocol tests. `test/fixtures/stdio-fake-agent.mjs` is a real spawnable stdio process covering capabilities, new/resume/load fallback, config options, message/thought/tool/plan/usage/unknown updates, permission selection/cancellation, pre/post-prompt crash, initialize/prompt/cancel hangs, stderr noise, malformed NDJSON, idle exit, and Windows child-tree termination.
