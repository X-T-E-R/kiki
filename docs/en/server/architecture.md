# Kiki runtime boundary

`kiki` is the product's CLI entry point (the terminal form of the three-form product: desktop app, CLI/TUI, and server). It starts the daemon-backed terminal interface, runs non-interactive `-p` requests, and exposes daemon, seat, and MCP integration commands. The package does not install a second `kimi` executable. See [the command reference](../reference/command.md) for startup and migration.

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
| Per-model [prompt conditioning](../configuration/config-files.md#model-cognition) | Kiki-only | Overlay, steering, and anchor files attach to a model alias. No default file text is shipped or injected for undeclared fields. |
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

`KIKI_EXPERIMENTAL_FLAG=1` enables registered experiments; it is not an engine or product selector. See [environment variables](../configuration/env-vars.md#runtime-switches).

## Enable Kiki-only agent features

Explicit model and effort binding and the direct-child tools are separate from experimental feature selection. Use the owning feature's switch when you need an experiment; the master switch enables all registered experiments and is broader than a single opt-in.

[Agents and subagents](../customization/agents.md) documents binding precedence and lifecycle. [Configuration files](../configuration/config-files.md#subagent) documents subagent timeout and denylist settings.

## Integrate peer-thread communication

Peer-thread communication defaults off. Set [`[thread_communication] enabled = true`](../configuration/config-files.md#thread-communication) to opt in. References include host, workspace, and session identity; cross-host sends are rejected. Only main agents receive the four built-in thread tools. Sending to a cold session may resume it and consume model quota.

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

## Separate the GUI, server, and clients

GUI and TUI session views consume the Klient session-view/command contract through shared session-core integration. The daemon owns engine execution. Existing general REST routes, terminal/global WebSocket traffic, and the non-interactive SDK path still exist; unified session wiring does not mean every historical transport or SDK entry has been removed.

Kiki maintainers own the downstream CLI identity, client integration, home resolution, and migration contracts. Upstream remains the provenance of inherited implementation, not an instruction to restore the old executable or a second live home.

`apps/kiki-gui/ATTRIBUTION.md` records adapted material from codeg, AionUi, grok-build, and LiveAgent. It assigns provenance to specific behavior and lists known licenses; it does not assign one donor license to an entire target file or establish a complete distribution-notice set.

## Use one runtime home

Runtime configuration, sessions, and OAuth credentials use `KIKI_HOME`, defaulting to `~/.kiki`. Supported explicit `--home` options take precedence. The legacy `KIMI_CODE_HOME` setting is not a startup fallback. Real Kimi provider/OAuth identifiers and endpoints remain unchanged; product home naming does not rename the provider protocol.

The desktop compatibility-home setting selects a migration source only. Login, logout, and token refresh no longer operate on a separately selected legacy home. Use [explicit configuration migration](../reference/command.md#migration-from-kimi) or sign in again before depending on legacy credentials.

`kiki migrate-config` copies supported configuration, credentials, device identity, and authored resources without overwriting existing Kiki files or removing the source. `--workspace <directory>` migrates project `local.toml`, `AGENTS.md`, `mcp.json`, and authored resource trees into `.kiki`. Root `AGENTS.md` and standard `.mcp.json` stay in place with their existing semantics. Project-local MCP remains relative to the selected working directory, not an implicit merge of every ancestor's product MCP file.

The desktop's separate model-category import copies only `providers`, `models`, `services`, `default_model`, `default_provider`, and `thinking`. Map categories merge by key, source entries win on matching aliases, and untouched categories/comments remain. This operation does not copy credentials: imported authentication references may require full migration or a new login. Repeating unchanged input is a no-op. For headless use, stop the owned backend first and run from `apps/kiki-gui`:

```sh
pnpm desktop:import-kimi-config --source-home <absolute-path> --target-home <absolute-path>
```

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

- [Getting started](../getting-started/first-launch.md) — choose a release or local source build.
- [Agents and subagents](../customization/agents.md) — configure bindings and child-agent tools.
- [Environment variables](../configuration/env-vars.md#runtime-switches) — configure runtime settings and experiments.
- [`kiki` command reference](../reference/command.md) — daemon, inbound integration, and explicit migration.
