# `@kiki/acp-client`

Runs an external ACP agent as a child process and normalizes its event stream.

This is a workspace package. It is marked `private: true`, so it is not
published to npm as its own release; the API below is the contract
`packages/agent-core-v2` programs against, and the examples assume a repository
checkout rather than an installed dependency.

Its job is transport and process lifecycle: spawn the external agent, speak ACP
over stdio, open or resume its session, stream normalized events, and cancel or
shut down cleanly. It knows nothing about Kiki turns, transcripts, or profiles —
the agent-core adapter supplies those and projects the events into Kiki's own
contracts. `packages/acp-server` is the mirror image: it exposes Kiki as an ACP
Agent, where this package acts as the ACP Client.

## Usage

```ts
import { AcpProcessClient } from '@kiki/acp-client';

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

The constructor takes the shape shared by `IHostProcessService`: `spawn(command,
args, options)` returning piped stdin/stdout/stderr plus `wait`, `kill`, and
`dispose`. This package never calls `child_process.spawn` itself — production
injects the runtime lease's process service, tests inject a fake.

`AcpProcessClient` exposes:

- `status()` — the full `cold → spawning → initializing → opening_session → configuring → ready ⇄ prompting` lifecycle;
- `openSession()` — live reuse, then `session/resume`, `session/load`, falling back to `session/new`;
- `startTurn()` — an async stream of normalized events plus a completion promise;
- `cancel()` — `session/cancel`, JSON-RPC request cancellation, a cancel grace period, connection close, TERM, then KILL;
- `shutdown()`, `stderrTail()`, and `sessionRef()`.

On Windows, process-tree termination is explicit: TERM/KILL escalation shells
out to `taskkill /PID <pid> /T` and `/F` through the same injected process
service. stdout carries ACP NDJSON only; stderr is logged separately and kept
in a bounded ring buffer.

## Normalized executor events

`mapAcpSessionNotification()` and `mapAcpSessionUpdate()` produce
`NormalizedExecutorEvent`:

- `message.delta` and `thought.delta`
- `tool.call` and `tool.update`
- `plan.update` and `plan.remove`
- `commands.update`, `mode.update`, `config.update`, `session.info`
- `usage`
- `unknown`, for update discriminators a newer agent introduces

A malformed update is a protocol error and closes the connection. An
unrecognized discriminator is rewritten to `unknown` before it reaches the
SDK's closed-union parser, so ACP schema types never reach downstream recorders.

Grok's `_x.ai/session_notification` and `_x.ai/session/update` extensions are
decoded only for six supported update types: tool-input fragments, pending and
resolved interactions, session summaries, response-completion metadata, and
turn-completion metadata. Tool input is emitted as a complete snapshot for the
canonical tool frame; completion metadata never creates a second turn terminal
state. Unknown updates retain their method and bounded source payload when
available so downstream diagnostics can show what arrived without treating it
as assistant text.

## Durable session refs

`parseExecutorSessionRefEnvelope`, `serializeExecutorSessionRefEnvelope`, and
`deserializeExecutorSessionRefEnvelope` validate:

```ts
{
  executorId: string;
  version: number;
  ref: Record<string, unknown>;
}
```

A ref must be bounded JSON with limited nesting and no secret-like keys, and
must match the executor ID and version before reuse. Persisting the ref is the
adapter's job.

## Test fixtures

`test/fixtures/in-process-scripted-agent.ts` drives protocol tests through the
SDK `agent()` and a direct `ClientApp ↔ AgentApp` connection.
`test/fixtures/stdio-fake-agent.mjs` is a real spawnable stdio process covering
capabilities, new/resume/load fallback, config options,
message/thought/tool/plan/usage/unknown updates, permission selection and
cancellation, pre- and post-prompt crashes, initialize/prompt/cancel hangs,
stderr noise, malformed NDJSON, idle exit, and Windows child-tree termination.
