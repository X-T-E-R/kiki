---
title: Model vocabulary convergence
description: Current model-selection vocabularies, the recommended target state, and a staged compatibility plan for agent-core and agent-core-v2.
outline: [2, 3]
---

# Model vocabulary convergence

Kiki currently exposes related model-selection concepts through different field names in the legacy `agent-core` engine, the `agent-core-v2` dispatch contract, and Agent-file frontmatter. This roadmap defines the boundaries, the recommended target state, and migration phases; it does not implement or schedule a migration by itself.

::: warning Note
This page is a design roadmap, not a deprecation notice. Existing configuration, Agent files, tool calls, and persisted subagent bindings keep their current behavior until a separately reviewed implementation changes them.
:::

::: danger Out of date
Written while both engines existed. `packages/agent-core` (v1) has since been deleted, so every row and source path below that describes the v1 vocabulary is history, not current behavior. The convergence target itself still stands; this page is scheduled for a rebaseline.
:::

## Separate the concepts first

The current vocabulary becomes easier to reason about when three different concepts are kept distinct:

- **Configured model key**: the key of an entry in `[models]`, used as the canonical runtime identifier after resolution.
- **Symbolic or pool selection**: a request such as `primary`, `secondary`, or a configured subagent-pool key. It describes how to choose a model rather than naming a model record directly.
- **Wire model identifier**: the model name inside a model record, sent to the provider endpoint. It is not automatically the same as the configured model key.

`model_alias` is the explicit configured-model path. `model` and `model_preference` are selection vocabularies whose exact meaning depends on the surface that owns them.

## Current state

The three spellings coexist because they belong to contracts with different compatibility histories.

| Surface | Fields | Current meaning | Why it exists |
| --- | --- | --- | --- |
| Legacy `packages/agent-core` profiles and Agent files | `model_preference`, `model_alias` | `model_preference` accepts `primary` or `secondary`; `model_alias` names a configured model. They are mutually exclusive and become the internal `modelPreference` / `modelAlias` profile fields. | The v1 profile and Agent-file format predates the v2 dispatch vocabulary and is still required by the selectable legacy engine. |
| `packages/agent-core-v2` `AgentRun` / `AgentSwarm` dispatch | `model`, `model_alias` | `model` is the symbolic or configured-pool selector. `primary` freezes the caller binding; other accepted values come from the configured subagent model pool. `model_alias` selects the configured-model path directly. They are mutually exclusive. | This is the current model-facing v2 dispatch contract and lets the tool present a bounded model pool without exposing every configured model as a symbolic choice. |
| Kiki Agent files and profile-route sidecars in v2 | `model_preference`, `model_alias` | `model_preference` remains limited to `primary` or `secondary` and is mapped at parse time to the profile's internal selection field. `secondary` means the configured pool default. `model_alias` remains the direct configured-model field. | Kiki retained the Agent-file feature across the upstream sync. The spelling is persisted, user-authored schema rather than a v2 tool parameter. |

Ordinary Agent files intentionally ignore unknown frontmatter fields, including another tool's `model` field. Profile-route sidecars are strict and reject unknown fields. Renaming the Agent-file field to `model` would therefore change both compatibility behavior and error behavior, not merely spelling.

### Model ID resolution

Both `resolveModelAlias` in v1 and `ModelService.resolveId` in v2 apply the same important resolution shape:

1. An exact configured key wins.
2. A request containing `/` is not suffix-matched when no exact key exists.
3. An unqualified value may match the final segment of a configured key or the model record's `model` value.
4. One candidate resolves to its canonical configured key; multiple candidates fail and require a full ID.

This bare-ID convenience is a resolution rule, not a separate selector vocabulary. The convergence work must not turn it into a third public meaning for `model`.

## Recommended target state

The recommended target is to unify v2 dispatch semantics while keeping Agent-file compatibility isolated at its schema boundary.

| Boundary | Target vocabulary | Target rule |
| --- | --- | --- |
| v2 model-facing dispatch tools | `model`, `model_alias` | `model` remains the bounded symbolic/pool selector; `model_alias` remains the direct configured-model selector. |
| v2 runtime after input parsing | One normalized selection representation | Tool `model` and Agent-file `model_preference` map to the same internal selector concept before precedence and validation run. Schema spellings must not leak into downstream resolution logic. |
| Agent-file and route frontmatter | Keep `model_preference`, `model_alias` | Treat `model_preference` as an Agent-file-schema compatibility term, not as an alternative v2 runtime API. |
| Model registry | Canonical configured model key | Resolution returns the configured key; bare-ID matching remains a convenience with exact-match and ambiguity safeguards. |
| v1 engine | Compatibility-only vocabulary | Keep current behavior while v1 is supported; do not redesign v1 merely to make field names resemble v2. |

### Why Agent files should keep `model_preference`

Keeping `model_preference` is preferable to silently converging Agent files on `model`:

- Agent files are persisted, user-authored documents shared across versions and, in some cases, across agent tools.
- `model_preference` explicitly signals symbolic `primary` / `secondary` behavior, while `model_alias` can still address literal aliases named `primary` or `secondary`.
- Existing ordinary Agent files ignore an unknown `model` field for cross-tool compatibility. Reinterpreting that field could unexpectedly change which model a previously harmless file selects.
- Upstream v2 no longer needs to carry `model_preference` throughout its runtime. Keeping the spelling only in Kiki's parser and serializer boundary limits the fork-specific delta.

A future rename should happen only through a versioned Agent-file schema with explicit compatibility rules. It should not be folded into routine engine cleanup.

## Migration phases

The phases below are ordered so that semantics become measurable before names or persisted formats change.

### Phase 0: document and freeze meanings

Record the current fields, accepted values, precedence, feature-flag behavior, and resolution rules. During this phase, avoid introducing new synonyms or broadening `model` to mean both a pool choice and an arbitrary configured alias.

**Exit condition:** the v1 profile contract, v2 tool contract, Agent-file schema, and model registry resolution each have an explicit owner and test matrix.

### Phase 1: normalize at v2 input boundaries

Define one internal selector shape that distinguishes a symbolic/pool selection from a configured-model selection. Convert `AgentRun` / `AgentSwarm` `model`, Agent-file `model_preference`, and `model_alias` into that shape before precedence is evaluated.

This phase may rename internal TypeScript properties, but it must not change tool schemas, frontmatter, configuration files, journal data, or runtime results.

**Exit condition:** precedence and validation run on normalized semantics rather than branching on schema-specific field names.

### Phase 2: make v2 the canonical behavioral reference

Centralize the behavior expected from `model` and `model_alias`: mutual exclusion, pool validation, `primary` behavior, Agent-file `secondary` behavior, direct configured-model resolution, thinking-effort independence, and errors for invalid explicit selections.

The v1 implementation may share tests or fixtures where practical, but it remains a compatibility consumer rather than the source of new vocabulary.

**Exit condition:** equivalent v1 and v2 inputs have documented equivalence or a documented intentional difference.

### Phase 3: isolate compatibility adapters

Keep Agent-file `model_preference` parsing and any persisted legacy spelling in narrow adapters. New v2 domains should consume only normalized selection data and should not add new `modelPreference` dependencies outside the profile-loading and compatibility layers.

**Exit condition:** removing the Agent-file adapter in a test branch would produce compile-time or fixture failures only at declared compatibility boundaries.

### Phase 4: optional versioned Agent-file transition

Do not start this phase unless product requirements justify replacing `model_preference`. If it is approved, introduce an explicit schema version or another unambiguous opt-in, dual-read the old and new forms, reject conflicts, provide diagnostics, and publish an automated rewrite path before removing the old spelling.

The transition must audit ordinary Agent files, strict route sidecars, plugin-provided Agent files, and both engines. Until those conditions exist, retaining `model_preference` is the target state rather than temporary debt.

### Phase 5: retire v1 vocabulary with the v1 engine

Remove v1-only types and documentation only when the legacy engine itself is retired through its own compatibility process. Vocabulary cleanup is not sufficient justification for engine removal.

## Compatibility constraints

Every migration phase must preserve these contracts unless a separate breaking-change decision explicitly replaces them:

- `model` and `model_alias` remain mutually exclusive on v2 dispatch surfaces.
- `model_preference` and `model_alias` remain mutually exclusive in Agent files and profile-route sidecars.
- A literal configured alias named `primary` or `secondary` remains addressable through `model_alias`; symbolic selection must not capture it.
- Exact configured model keys win over bare-ID candidates, qualified unknown IDs are not suffix-matched, and ambiguous bare IDs fail with all candidates identified.
- Profile-file `thinking_effort` and the v2 tool parameter `effort` resolve independently from the model selector.
- Resumed and retried subagents keep their persisted model and effort binding; a resume must not reinterpret the current profile or defaults.
- The secondary-model feature gate continues to control symbolic/pool behavior without disabling stable `model_alias` binding.
- Agent-file format changes remain synchronized across the v1 and v2 parsers for as long as both engines load the format.
- Existing ordinary Agent files containing another tool's `model` metadata must not acquire Kiki model-selection behavior without an explicit schema opt-in.

## Source map

The current behavior is anchored in these repository paths:

- **v1 configured-key resolution**: `packages/agent-core/src/config/model.ts`
- **v1 Agent-file parsing**: `packages/agent-core/src/profile/agentfile/parser.ts`
- **v1 subagent binding**: `packages/agent-core/src/session/subagent-binding.ts`
- **v2 configured-key resolution**: `packages/agent-core-v2/src/kosong/model/modelService.ts`
- **v2 dispatch schema and binding**: `packages/agent-core-v2/src/agent/tools/agent/agent.ts` and `packages/agent-core-v2/src/session/subagent/configSection.ts`
- **v2 Agent-file parsing**: `packages/agent-core-v2/src/workspace/workspaceAgentProfileLoader/internal/agentFile.ts`
- **v2 profile-route parsing**: `packages/agent-core-v2/src/workspace/workspaceAgentProfileLoader/internal/agentRouteFile.ts`

## Next steps

- [Agents and Sub-Agents](../customization/agents.md#agent-file-format) — current Agent-file fields and subagent binding behavior.
- [Configuration files](../configuration/config-files.md#subagent) — current model registry and subagent binding configuration.
- [Kiki runtime boundary](./kiki-runtime.md) — ownership boundaries between inherited and Kiki-specific model-binding behavior.
