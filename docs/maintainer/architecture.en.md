# Kiki runtime boundary

`kiki` is the product's CLI entry point (the terminal form of the three-form product: desktop app, CLI/TUI, and server). It starts the daemon-backed terminal interface, runs non-interactive `-p` requests, and exposes daemon, seat, and MCP integration commands. The package does not install a second `kimi` executable. See [the command reference](../en/reference/command.md) for startup and migration.

This guide distinguishes inherited implementation from Kiki-owned integration. A package name or a passing source check is not a claim that a corresponding npm package or desktop release has been published.

## Read the boundary

These labels describe origin and maintenance responsibility, not release readiness:

- **Inherited**: implementation or contracts originate in the upstream Kimi Code baseline.
- **Adapted**: Kiki changes an inherited subsystem's integration or supported behavior.
- **Kiki-only**: a surface was added after the fork point and had no counterpart at that comparison point.

| Surface | Classification | Current boundary |
| --- | --- | --- |
| CLI, TUI (terminal user interface), and executable identity | Adapted | The command is `kiki`; interactive sessions attach to the shared daemon instead of creating an independent terminal runtime. |
| `kap-server`, `@kiki/protocol`, and engine session/configuration/authentication contracts | Inherited and adapted | Existing server contracts remain in use; Kiki adds unified client wiring without creating another engine. |
| Model-binding areas in `agent-core-v2` | Adapted | Kiki owns the downstream model/effort binding and dispatch integration. |
| Explicit model alias and thinking effort for subagents | Kiki-only | Tool parameters use `model_alias` and `effort`; agent files use `thinking_effort`. |
| Per-model [prompt conditioning](../en/configuration/config-files.md#model-cognition) | Kiki-only | Overlay, steering, and anchor files attach to a model alias. No default file text is shipped or injected for undeclared fields. |
| `AgentRun`, `AgentList`, and `AgentSend` | Kiki-only | Direct-child launch/resume, discovery, and mailbox operations. |
| Local peer-thread communication | Kiki-only | Agents can coordinate local sessions; external REST/Klient callers send target-only messages without peer attribution. |
| `@kiki/gui` and shared `@kiki/session-core` client integration | Kiki-only and adapted | GUI and terminal session views consume the shared client contracts. Donor-derived GUI material retains its specific attribution. |

The comparison anchor is `437a1b8`. It does not imply that all later upstream changes are present.

## Choose the command and runtime

All surfaces use `agent-core-v2`; the historical v1 engine is not an alternative runtime.

| Invocation | Runtime behavior |
| --- | --- |
| `kiki` | Attach to or start the shared daemon, then open the TUI. Startup failures are reported; there is no legacy local-TUI fallback. |
| `kiki -p "prompt"` | Run through the shared Klient facade in an SDK-hosted in-memory engine, without opening the TUI or attaching to a daemon. It waits for the submitted prompt's terminal result and then applies the configured background-task policy. |
| `kiki serve --ensure --workspace . --json` | Reuse a healthy shared daemon or start one. |
| `kiki serve --stop` | Stop the shared daemon through its supported lifecycle command. |
| `kiki web` | Compatibility foreground REST/WebSocket/web-UI command; it does not attach to the shared daemon. |
| `@kiki/gui` | Browser/desktop client of the shared engine and server. The GUI workspace package does not install another CLI. |

`KIKI_EXPERIMENTAL_FLAG=1` enables registered experiments; it is not an engine or product selector. See [environment variables](../en/configuration/env-vars.md#runtime-switches).

## Enable Kiki-only agent features

Explicit model and effort binding and the direct-child tools are separate from experimental feature selection. Use the owning feature's switch when you need an experiment; the master switch enables all registered experiments and is broader than a single opt-in.

[Agents and subagents](../en/customization/agents.md) documents binding precedence and lifecycle. [Configuration files](../en/configuration/config-files.md#subagent) documents subagent timeout and denylist settings.

## Integrate peer-thread communication

Peer-thread communication defaults off. Set [`[thread_communication] enabled = true`](../en/configuration/config-files.md#thread-communication) to opt in. References include host, workspace, and session identity; cross-host sends are rejected. Only main agents receive the four peer-thread tools. The separate `ThreadCreate` tool opens a top-level session without requiring peer-thread communication. Sending to a cold session may resume it and consume model quota.

The server exposes these routes under `/api`:

| Operation | Route |
| --- | --- |
| List threads | `GET /api/threads` |
| Read completed turns | `POST /api/threads:read` |
| Send a message | `POST /api/threads:send` |
| Wait for activity | `POST /api/threads:wait` |
| Read a workspace override | `GET /api/workspaces/{workspace_id}/thread-communication` |
| Set a workspace override | `PUT /api/workspaces/{workspace_id}/thread-communication` |
| Clear a workspace override | `DELETE /api/workspaces/{workspace_id}/thread-communication` |

`POST /api/threads:send` accepts `target`, `content`, and `idempotency_key`. It rejects `source` and records user-origin input. `GET /openapi.json` provides schemas; `GET /api/meta` advertises `capabilities.thread_communication: true`.

Klient exposes `global.threads.hostId`, `list`, `read`, `send`, `wait`, `getWorkspaceOverride`, `setWorkspaceOverride`, `clearWorkspaceOverride`, and `isWorkspaceEnabled`. Send with `global.threads.send({ target, content, idempotencyKey })`. Extra lower-level transport fields cannot create peer attribution; true peer sends use the source agent's `ThreadSend` tool, which derives the source identity itself.

Workspace overrides persist across restarts. Clearing one restores the global setting; an enabled override cannot bypass a globally disabled section.

Communication history uses `GET /api/threads/messages`, `global.threads.messages`, and `rest.threads.messages`; see the [canonical read contract](../en/server/rest-api.md#communication-history). `RuntimeThreadMailboxStore` stores derived global/session/workspace index pointers in the same target partition and atomic WAL batch as each peer acceptance, with one compound index over group/order. Reads resolve the current delivery document, never a copied content log, and never resume cold sessions. The mailbox uses disk-mode values so retaining history does not load every message body into RAM; keys and index metadata remain resident. Normal acceptance and legacy import maintain non-external message pointers in the same partition batch, including repairs of interrupted imports. The physical `peer_history_v1` projection is unchanged: a complete v2 marker is reused without scanning; a complete v1 marker proves peer-thread coverage, not room coverage. Remaining gaps use bounded shard-local key-only scans, decode only message keys, and write only missing or mismatched pointers. Existing global checkpoints and v1 peer-only coverage are inherited; new checkpoints record shard/key progress after successful repair batches, by message work/time and shard completion. Message and pointer reads are partition-batched to avoid repeated shard validation. Fsync remains `always`. Peer terminal rows no longer use the 512-row pruning rule. Already-pruned historical messages are not recovered from wire. The service checks surviving endpoint metadata, includes archived sessions, and serves explicit scan-budget continuations (500 candidate rows or a 2 MiB text threshold, checked between batches of at most 20). `HistorySearch` peer scope reuses lexical matching over this view with bounded scan continuations. Room wake receipts are recipient-owned history; the separate room log remains authoritative for the full discussion.

Mailbox initialization and history backfill are single-flight operations owned by the runtime epoch, not by the first RPC caller. A caller timeout or cancellation stops that caller's wait; loss of ownership or store close cancels the shared work and waits for it before releasing database locks. Ordinary mailbox initialization installs the history-index definition but does not wait for its backfill. History reads kick shared repair without awaiting it and expose coverage state. Incomplete reads pin a coverage generation; pointer repair batches, completion, and reopening incomplete coverage invalidate old pagination. Peer-only reads retain their inherited complete-v1 generation while room repair runs. Failed repair remains incomplete/error; reopen retries from the last durable checkpoint. A fresh mailbox is complete because every producer path maintains pointers transactionally. The first successful mailbox call and first successful history read each establish their own warm-call epoch: the default per-attempt budget is 20 seconds while cold and 10 seconds while warm, with a total retry deadline twice that budget. `KIKI_THREAD_MAILBOX_TIMEOUT_MS` overrides both per-attempt defaults. A deadline error includes the method, wait phase, runtime role/readiness/epoch, and last retry code; it does not identify a shard-lock holder.

## Separate the GUI, server, and clients

GUI and TUI session views consume the Klient session-view/command contract through shared session-core integration. The daemon owns engine execution. Existing general REST routes, terminal/global WebSocket traffic, and the non-interactive SDK path still exist; unified session wiring does not mean every historical transport or SDK entry has been removed.

Kiki maintainers own the downstream CLI identity, client integration, home resolution, and migration contracts. Upstream remains the provenance of inherited implementation, not an instruction to restore the old executable or a second live home.

`apps/kiki-gui/ATTRIBUTION.md` records adapted material from codeg, AionUi, grok-build, and LiveAgent. It assigns provenance to specific behavior and lists known licenses; it does not assign one donor license to an entire target file or establish a complete distribution-notice set.

## Use one runtime home

Runtime configuration, sessions, and OAuth credentials use `KIKI_HOME`, defaulting to `~/.kiki`. Supported explicit `--home` options take precedence. Startup uses only the Kiki home settings. Real Kimi provider/OAuth identifiers and endpoints remain unchanged; product home naming does not rename the provider protocol.


The command reports status, paths, and category names without copying OAuth, sessions, or skills. Desktop session moves and skill copies remain separate operations: a session move transfers `workspaces.json` and `sessions/` with compensation on partial failure; skill copying preserves the source and occupied targets. These operations stop/restart only Kiki's owned backend, not external Kimi Code processes. Close external processes before migrating their data.

## Sync from upstream

The upstream baseline is `MoonshotAI/kimi-code`; Kiki's own repository is `X-T-E-R/kiki`. Sync requires an explicit review and selected port, never an automatic consequence of a product name or feature flag.

1. Evaluate inherited fixes against current Kiki contracts; do not restore retired entry points or home fallbacks.
2. Integrate accepted changes at their owning engine/server boundaries.
3. Preserve Kiki-owned dispatch and client behavior with targeted regression checks.
4. Recheck attribution when adapted material or the shipped dependency graph changes.

## Source map

- **Command and daemon startup**: `apps/kimi-code/src/cli/commands.ts`, `apps/kimi-code/src/kiki/`, and `apps/kimi-code/package.json`
- **Server and client contracts**: `packages/kap-server/`, `packages/protocol/`, `packages/klient/`, and `packages/session-core/`
- **SDK execution**: `packages/node-sdk/`
- **Home resolution and explicit migration**: `packages/oauth/src/home.ts`
- **Model/effort binding and child execution**: `packages/agent-core-v2/src/session/subagent/` and `packages/agent-core-v2/src/session/dispatch/`
- **Prompt conditioning**: `packages/agent-core-v2/src/agent/cognition/`, `packages/agent-core-v2/src/features/modelSteering/`, and `packages/agent-core-v2/src/app/kosongConfig/configSection.ts`
- **Peer threads**: `packages/agent-core-v2/src/app/threadCommunication/`, `packages/kap-server/src/routes/threads.ts`, and `packages/klient/src/contract/global/threads.ts`
- **GUI provenance**: `apps/kiki-gui/ATTRIBUTION.md`

## Next steps

- [Getting started](../en/getting-started/first-launch.md) — choose a release or local source build.
- [Agents and subagents](../en/customization/agents.md) — configure bindings and child-agent tools.
- [Environment variables](../en/configuration/env-vars.md#runtime-switches) — configure runtime settings and experiments.
- [`kiki` command reference](../en/reference/command.md) — daemon, inbound integration, and explicit migration.
