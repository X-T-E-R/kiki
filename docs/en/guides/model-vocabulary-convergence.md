---
title: Model vocabulary convergence
description: Current model-selection vocabulary and binding rules for agent-core-v2.
outline: [2, 3]
---

# Model vocabulary convergence

Kiki uses `packages/agent-core-v2` as its only agent engine. Model selection now has one explicit dispatch and profile field, `model_alias`, while thinking effort remains a separate setting.

::: info Changed
The earlier convergence roadmap is complete. The `model` dispatch parameter, `model_preference` frontmatter field, and `[secondary_model]` configuration section are no longer part of the current contract.
:::

## Current vocabulary

The current vocabulary separates configured identity, provider identity, and thinking effort:

- **Configured model key**: the key of an entry in `[models]`. Resolution returns this canonical runtime identifier.
- **`model_alias`**: the configured-model selector used by `AgentRun`, Agent files, profile routes, and caller leases.
- **Wire model identifier**: the `model` value inside a model record, sent to the provider endpoint. It does not need to match the configured model key.
- **Thinking effort**: `effort` on a dispatch or `thinking_effort` on a profile or route. It resolves independently from `model_alias`.

## Binding rules

A newly spawned subagent binds its model from exactly two sources:

1. The dispatch's `model_alias`.
2. The effective profile, route, or caller lease's `model_alias` pin.

The dispatch value wins when both are present. When neither source supplies a model, the spawn fails with `model.not_configured`; a subagent never inherits the caller's model or a configured default. Unknown aliases and models rejected by machine or role constraints also fail before the child starts.

Resumed and retried subagents keep their persisted binding unless an explicit `AgentRun` resume requests a change. Omit `effort` to keep the current value; an explicit effort applies to the next idle run. An explicit `model_alias` may change the model only when `allow_model_change: true` confirms the change; an alias resolving to the same canonical model is a no-op. Caller, role, route, and executor restrictions remain enforced, including machine and role model constraints. An external executor that does not support changing a resumed thread binding returns an error instead of recreating the thread or executor.

## Agent files and routes

Agent files and profile-route sidecars use `model_alias` for model pins. `model_preference` is explicitly rejected with a migration diagnostic. Ordinary Agent files continue to ignore another tool's unknown `model` metadata, while route sidecars remain strict and reject unknown fields.

A route-declared `model_alias` is locked for automatic dispatch. `AgentRun` may omit it or repeat the same resolved model, but a conflicting value is rejected. Role-level `allowed_models` and `deny_models`, plus machine-level `[subagent].deny_models`, can only narrow the allowed set.

## Model ID resolution

`ModelService.resolveId` resolves a requested model to the canonical configured key in this order:

1. An exact configured key wins.
2. An explicit alias declared by a model record is accepted; ambiguous aliases fail.
3. An unqualified value may match the final segment of a configured key or the model record's wire `model` value; ambiguous matches fail.
4. A qualified value may resolve through a configured tail key only when its provider prefix is consistent with that record.
5. Unknown or incomplete values do not resolve.

This convenience resolution does not create another selector vocabulary: public subagent surfaces still expose only `model_alias`.

## Source map

The current behavior is anchored in these repository paths:

- **Configured-key resolution**: `packages/agent-core-v2/src/kosong/model/resolveModelId.ts`
- **Dispatch schema**: `packages/agent-core-v2/src/agent/tools/agent/agent.ts`
- **Subagent binding**: `packages/agent-core-v2/src/session/subagent/configSection.ts`
- **Agent-file parsing**: `packages/agent-core-v2/src/workspace/workspaceAgentProfileLoader/internal/agentFile.ts`
- **Profile-route parsing**: `packages/agent-core-v2/src/workspace/workspaceAgentProfileLoader/internal/agentRouteFile.ts`

## Next steps

- [Agents and subagents](../customization/agents.md#agent-file-format) — current Agent-file fields and subagent binding behavior.
- [Configuration files](../configuration/config-files.md#subagent) — current model registry and subagent configuration.
- [Kiki runtime boundary](./kiki-runtime.md) — ownership boundaries for the single agent engine.
