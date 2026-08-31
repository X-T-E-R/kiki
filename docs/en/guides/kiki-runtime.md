# Kiki runtime boundary

Run `kimi` to use the command-line or terminal interface. **Kiki** names the downstream additions in this repository; it is not a separate executable, and it does not replace the existing Kimi Code CLI documentation.

This guide shows which runtime surfaces come from the upstream Kimi Code baseline, which areas Kiki adapts, and which features exist only in Kiki. Use the classification before deciding where to configure a feature, report a regression, or resolve an upstream-sync conflict.

## Read the boundary

The classification describes the origin and maintenance boundary of a surface, not its quality or release status:

- **Inherited**: the public behavior or contract comes from the upstream Kimi Code baseline and remains the default reference.
- **Adapted**: an upstream subsystem still supplies the main contract, but Kiki changes a defined integration area inside it.
- **Kiki-only**: the package, tool, or behavior was added after the Kiki fork point (the upstream commit used as the comparison start) and has no upstream Kimi Code baseline at that point.

| Surface | Classification | What the label means here |
| --- | --- | --- |
| Kimi Code CLI, TUI (terminal user interface), and the `kimi` command | Inherited | Installation, login, sessions, configuration, and ordinary command behavior continue to use the existing Kimi Code CLI docs. |
| `kap-server`, `@moonshot-ai/protocol`, and the session, configuration, and authentication contracts they expose | Inherited | Kiki clients consume these contracts instead of defining a separate server or protocol family. |
| Model-binding areas in `agent-core-v2` | Adapted | Kiki extends selected upstream agent-engine paths while preserving their existing session and task lifecycles. |
| Explicit model-alias and thinking-effort binding for newly spawned subagents | Kiki-only | Only the symbolic-selector path is disabled by default; the explicit binding itself is stable and always available. Tool parameters use `model_alias` and `effort`; Agent files still use `thinking_effort`. |
| Per-model prompt conditioning via [`[models."<alias>".cognition]`](../configuration/config-files.md#model-cognition) | Kiki-only | Overlay, steering, and anchor prompt files attach to a model alias rather than an agent profile. The repository ships no default text for them; every file is read from the data root at runtime, and an undeclared field injects nothing. |
| Direct-child tools `AgentRun`, `AgentSwarm`, `AgentList`, and `AgentSend` | Kiki-only | Always on the main `agent` profile. They launch or resume children, fan out item-based work, list direct children, and queue mailbox messages. |
| Local peer-thread communication | Kiki-only | Main Agents can list, read, message, and wait on existing sessions across local workspaces; REST and Klient provide target-only external-client sends without peer attribution. |
| Standalone `@kiki/gui` package | Kiki-only | The GUI is a downstream client of the inherited server and protocol surfaces. Some components adapt separately attributed donor material, so those components are classified as adapted within the Kiki-only package. |

The repository fork point used for this guide is `437a1b8`. The hash is a comparison anchor, not a claim that later upstream changes are already present.

## Choose the command and runtime

Every surface runs the same engine, `agent-core-v2`. There is no engine switch: the historical v1 engine was removed from this fork, along with `KIMI_CODE_LEGACY_FLAG`.

| Invocation or setting | Runtime behavior |
| --- | --- |
| `kimi` or `kimi -p` | Uses the inherited CLI/TUI surface on `agent-core-v2`. |
| `kimi web` | Starts `kap-server`, also on `agent-core-v2`. |
| `@kiki/gui` | Exists as a separate private workspace package that connects as a client. It does not install a `kiki` command or replace the TUI. |

`KIMI_CODE_EXPERIMENTAL_FLAG=1` enables registered experiments inside the engine. It does not turn the executable into Kiki. For the complete switch reference, use [Environment variables](../configuration/env-vars.md#runtime-switches); for command syntax, use the [`kimi` command reference](../reference/kimi-command.md).

## Enable Kiki-only agent features

The model-selector feature below remains experimental and off by default.

| Feature | Enable with | Additional boundary |
| --- | --- | --- |
| All registered experiments | `KIMI_CODE_EXPERIMENTAL_FLAG=1` | This is a broad master gate, not a runtime or product selector. |

[Agents and subagents](../customization/agents.md) documents the binding precedence, lifecycle, and child-agent tools. [Configuration files](../configuration/config-files.md#subagent) documents the `[subagent]` timeout and denylist.

## Integrate peer-thread communication

Peer-thread communication is disabled by default. Set [`[thread_communication] enabled = true`](../configuration/config-files.md#thread-communication) to opt in. Once enabled, it coordinates existing sessions on this host, including sessions in different workspaces; every thread reference includes the host, workspace, and session identity, and cross-host sends are rejected. Only main Agents receive the four built-in thread tools, but local clients can use the same contract directly. Sending to a cold target can resume that session and consume model quota.

The REST/Klient surface below is served by `kimi web`.

The REST surface is available under `/api/v1` when the Kimi server is running:

| Operation | Route |
| --- | --- |
| List threads | `GET /api/v1/threads` |
| Read completed turns | `POST /api/v1/threads:read` |
| Send a message | `POST /api/v1/threads:send` |
| Wait for activity | `POST /api/v1/threads:wait` |
| Read a workspace override | `GET /api/v1/workspaces/{workspace_id}/thread-communication` |
| Set a workspace override | `PUT /api/v1/workspaces/{workspace_id}/thread-communication` |
| Clear a workspace override | `DELETE /api/v1/workspaces/{workspace_id}/thread-communication` |

`POST /api/v1/threads:send` accepts exactly `target`, `content`, and `idempotency_key`. It rejects the legacy `source` field and records the delivered turn as user-origin input; a REST client cannot claim a source thread. Use `GET /openapi.json` for the complete request and response schemas. `GET /api/v1/meta` advertises support as `capabilities.thread_communication: true`.

Klient exposes the corresponding methods under `global.threads`: `hostId`, `list`, `read`, `send`, `wait`, `getWorkspaceOverride`, `setWorkspaceOverride`, `clearWorkspaceOverride`, and `isWorkspaceEnabled`. Call `global.threads.send({ target, content, idempotencyKey })`.

The strict Klient facade does not accept `source`, and extra source data sent through a lower-level transport cannot create peer provenance. Like REST, Klient sends are recorded as user-origin input. To record true peer attribution, the source session's main Agent must call `send_message_to_thread`, which derives that source from its current session rather than client-supplied data.

Workspace overrides persist across restarts. Clearing one returns the workspace to the effective global setting; an enabled override cannot bypass a globally disabled `[thread_communication]` section.

## Separate the GUI, server, and clients

Kiki does not introduce a second backend stack. `@kiki/gui` calls the inherited `kap-server` REST and WebSocket surfaces (the request/response API and live update channel) and uses types from `@moonshot-ai/protocol`; the existing TUI and other clients continue to use their established Kimi Code paths.

| Boundary | Owner in this repository | Consequence |
| --- | --- | --- |
| CLI/TUI command surface | Upstream Kimi Code baseline | Keep `kimi` behavior and the existing user docs as the default contract. |
| Server, protocol, session, configuration, and authentication surface | Upstream Kimi Code baseline | A Kiki client change should adapt to this contract unless the contract itself is deliberately reclassified. |
| Agent-engine integration delta | Kiki maintainers | Kiki owns model/effort binding and child-agent regressions introduced by the downstream delta. |
| `@kiki/gui` client, state, and presentation | Kiki maintainers | The package is a private repository workspace surface; its presence is not a public release or production-readiness claim. |

The GUI package records adapted material from codeg, AionUi, grok-build, and LiveAgent in `apps/kiki-gui/ATTRIBUTION.md`. That file assigns provenance to specific adapted behavior and lists known dependency licenses; it explicitly does not assign a donor license to an entire target file or establish a complete distribution-notice set.

## Keep Kiki data and Kimi OAuth separate

The desktop app keeps Kiki-owned data under `KIKI_HOME` (by default `~/.kiki`). Its configuration is always `KIKI_HOME/config.toml`; selecting a Kimi Home never replaces that file with Kimi Code's full configuration.

Kimi OAuth is intentionally shared. The selected Kimi Home may be the default Kimi Code Home or a custom absolute path, and Kiki login, logout, and refresh directly use `<Kimi Home>/credentials/kimi-code.json`, `<Kimi Home>/device_id`, and `<Kimi Home>/oauth/`. Those actions therefore affect the same Kimi Code login; Kiki never copies OAuth credentials into `KIKI_HOME`.

The Settings card provides a repeatable one-way model-configuration import from the selected Kimi Home. It imports only `providers`, `models`, `services`, `default_model`, `default_provider`, and `thinking`. The three map categories merge by key: source entries replace matching aliases while Kiki-only aliases remain. The other categories replace the Kiki value only when they exist in the source. OAuth credential files are never copied; imported provider and service entries may retain references to the credentials already shared from the selected Kimi Home. All other Kiki config sections and comments attached to untouched entries remain unchanged, and repeating the same import is a no-op. The desktop action stops and restarts only Kiki's owned backend. For headless maintenance, stop that backend first, then run from `apps/kiki-gui`:

```sh
pnpm desktop:import-kimi-config
```

Pass `--source-home <absolute-path>` and `--target-home <absolute-path>` to override the default Homes. The command prints only status, paths, and category names; it does not read or move OAuth, Sessions, or Skills.

Sessions and User Skills use the selected Kimi Home only as a migration source. A Sessions move stops Kiki's owned backend, recalculates the plan, then renames only `workspaces.json` and `sessions/`; if the second rename fails after the catalog moved, Kiki immediately renames the catalog back and reports a partial move if that compensation also fails. User Skills copy keeps the source and does not overwrite an occupied Kiki target. Copy migrations stop and restart only Kiki's owned backend; they do not stop or lock external Kimi Code processes, so close those processes before migrating.

## Sync from upstream

The configured upstream is `MoonshotAI/kimi-code`, with `437a1b8` as this guide's comparison anchor. Upstream sync is a deliberate Git and integration operation; nothing in the Kiki name, feature flags, or GUI automatically imports later upstream changes.

When reviewing an upstream update:

1. Keep inherited command, server, protocol, session, configuration, and authentication contracts aligned with the upstream change.
2. Reapply or repair adapted agent-engine deltas at their integration seams rather than treating the full engine as Kiki-only.
3. Preserve Kiki-only behavior only where it still composes with the updated inherited contract.
4. Recheck GUI attribution when adapted donor material or the shipped dependency graph changes.

This order keeps upstream fixes distinguishable from downstream behavior and makes ownership clear when a regression crosses the boundary.

## Source map

The following repository paths back the classifications in this guide:

- **Command surface**: `apps/kimi-code/package.json`
- **Inherited server and protocol**: `packages/kap-server/`, `packages/protocol/`, `packages/node-sdk/`, and `packages/oauth/`
- **Adapted model-binding areas**: `packages/agent-core-v2/src/session/subagent/`
- **Kiki-only per-model prompt conditioning**: `packages/agent-core-v2/src/agent/cognition/`, `packages/agent-core-v2/src/features/modelSteering/`, and the `cognition` schema in `packages/agent-core-v2/src/app/kosongConfig/configSection.ts`
- **Kiki-only child-agent tools**: `packages/agent-core-v2/src/agent/tools/agent/`, `packages/agent-core-v2/src/agent/tools/agent-list/`, and `packages/agent-core-v2/src/agent/tools/agent-send/`
- **Kiki-only peer-thread core and transport**: `packages/agent-core-v2/src/app/threadCommunication/`, `packages/kap-server/src/routes/threads.ts`, and `packages/klient/src/contract/global/threads.ts`
- **Kiki-only GUI and its donor boundary**: `apps/kiki-gui/package.json`, `apps/kiki-gui/src/lib/client.ts`, and `apps/kiki-gui/ATTRIBUTION.md`

## Next steps

- [Getting started](./getting-started.md) — install and run the inherited `kimi` command.
- [Agents and subagents](../customization/agents.md) — configure model binding and use the child-agent tools.
- [Environment variables](../configuration/env-vars.md#runtime-switches) — compare engine selection and experimental feature gates.
- [`kimi` command reference](../reference/kimi-command.md) — look up the current executable, flags, and subcommands.
