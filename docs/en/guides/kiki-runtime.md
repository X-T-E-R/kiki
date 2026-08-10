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
| Model-binding areas in `agent-core` and `agent-core-v2` | Adapted | Kiki extends selected upstream agent-engine paths while preserving their existing session and task lifecycles. |
| Explicit model-alias and thinking-effort binding for newly spawned subagents | Kiki-only | The binding behavior is a downstream addition implemented in both agent-engine paths and disabled by default. |
| Five-tool Codex-style collaboration adapter | Kiki-only | The adapter adds `spawn_agent`, `list_agents`, `wait_agent`, `followup_task`, and `interrupt_agent`; it does not claim complete Codex compatibility. |
| Standalone `@kiki/gui` package | Kiki-only | The GUI is a downstream client of the inherited server and protocol surfaces. Some components adapt separately attributed donor material, so those components are classified as adapted within the Kiki-only package. |

The repository fork point used for this guide is `437a1b8`. The hash is a comparison anchor, not a claim that later upstream changes are already present.

## Choose the command and runtime

The executable name and the agent engine are separate choices. Start with `kimi`; use an environment variable only when you need a non-default engine or an experimental feature.

| Invocation or setting | Runtime behavior |
| --- | --- |
| `kimi` or `kimi -p` | Uses the inherited CLI/TUI surface and selects `agent-core-v2` by default. |
| `KIMI_CODE_LEGACY_FLAG=1` with `kimi` | Keeps the same `kimi` command but selects the legacy `agent-core` engine. |
| `kimi web` | Starts `kap-server` on the `agent-core-v2` path; the legacy flag does not change this server path. |
| `@kiki/gui` | Exists as a separate private workspace package that connects as a client. It does not install a `kiki` command or replace the TUI. |

`KIMI_CODE_EXPERIMENTAL_FLAG=1` enables registered experiments inside the selected engine. It does **not** select an engine and does not turn the executable into Kiki. For the complete switch reference, use [Environment variables](../configuration/env-vars.md#runtime-switches); for command syntax, use the [`kimi` command reference](../reference/kimi-command.md).

## Enable Kiki-only agent features

The Kiki-only agent features are experimental and off by default. Prefer the feature-specific gate when you need only one behavior.

| Feature | Enable with | Additional boundary |
| --- | --- | --- |
| Explicit subagent model and effort binding | `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL=1` | Applies to new subagent spawns. Resumed or retried subagents retain their persisted binding. |
| Five-tool named-agent adapter | `KIMI_CODE_EXPERIMENTAL_AGENT_COLLABORATION=1` | `[agents] enabled = false` still removes the five tools. The adapter has no `send_message` tool and does not copy parent history when spawning. |
| All registered experiments | `KIMI_CODE_EXPERIMENTAL_FLAG=1` | This is a broad master gate, not a runtime or product selector. |

[Agents and subagents](../customization/agents.md) documents the binding precedence, lifecycle, and exact collaboration limits. [Configuration files](../configuration/config-files.md#subagent) documents the persistent subagent defaults.

## Separate the GUI, server, and clients

Kiki does not introduce a second backend stack. `@kiki/gui` calls the inherited `kap-server` REST and WebSocket surfaces (the request/response API and live update channel) and uses types from `@moonshot-ai/protocol`; the existing TUI and other clients continue to use their established Kimi Code paths.

| Boundary | Owner in this repository | Consequence |
| --- | --- | --- |
| CLI/TUI command surface | Upstream Kimi Code baseline | Keep `kimi` behavior and the existing user docs as the default contract. |
| Server, protocol, session, configuration, and authentication surface | Upstream Kimi Code baseline | A Kiki client change should adapt to this contract unless the contract itself is deliberately reclassified. |
| Agent-engine integration delta | Kiki maintainers | Kiki owns model/effort binding and collaboration-adapter regressions introduced by the downstream delta. |
| `@kiki/gui` client, state, and presentation | Kiki maintainers | The package is a private repository workspace surface; its presence is not a public release or production-readiness claim. |

The GUI package records adapted material from codeg, AionUi, grok-build, and LiveAgent in `apps/kiki-gui/ATTRIBUTION.md`. That file assigns provenance to specific adapted behavior and lists known dependency licenses; it explicitly does not assign a donor license to an entire target file or establish a complete distribution-notice set.

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

- **Command and engine selection**: `apps/kimi-code/package.json` and `apps/kimi-code/src/cli/experimental-v2.ts`
- **Inherited server and protocol**: `packages/kap-server/`, `packages/protocol/`, `packages/node-sdk/`, and `packages/oauth/`
- **Adapted model-binding areas**: `packages/agent-core/src/session/subagent-binding.ts` and `packages/agent-core-v2/src/session/subagent/`
- **Kiki-only collaboration adapter**: `packages/agent-core/src/tools/builtin/collaboration/agent-collaboration.ts` and `packages/agent-core-v2/src/agent/tools/agent-collaboration/agentCollaborationTool.ts`
- **Kiki-only GUI and its donor boundary**: `apps/kiki-gui/package.json`, `apps/kiki-gui/src/lib/client.ts`, and `apps/kiki-gui/ATTRIBUTION.md`

## Next steps

- [Getting started](./getting-started.md) — install and run the inherited `kimi` command.
- [Agents and subagents](../customization/agents.md) — configure model binding and use the collaboration adapter within its current limits.
- [Environment variables](../configuration/env-vars.md#runtime-switches) — compare engine selection and experimental feature gates.
- [`kimi` command reference](../reference/kimi-command.md) — look up the current executable, flags, and subcommands.
