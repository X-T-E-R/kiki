---
title: Model selection vocabulary
description: Model aliases, wire identifiers, and subagent binding rules in one reference.
outline: [2, 3]
---

# Model selection vocabulary

Kiki keeps three things separate when selecting models: the model keys in your config file, the `model_alias` used when dispatching subagents, and the identifier actually sent to the provider. This page defines that vocabulary and the binding rules; you mainly need it when pinning models for subagents or profiles.

## Current vocabulary

- **Configured model key**: the key of an entry under `[models]` in `config.toml`. Resolution results use it as the canonical runtime identifier.
- **`model_alias`**: the model selector used by `AgentRun` calls, agent files, and profile routes; `AgentRun` accepts a concrete configured model name, while subagent profiles, routes, and caller leases may also use the reserved value `inherit`.
- **Wire model identifier**: the `model` value actually sent to the provider endpoint. It does not have to equal the configured key — the same provider model can be registered under several purpose-specific keys.
- **Thinking effort**: the dispatch parameter `effort`, or `thinking_effort` on a profile or route. It resolves independently from `model_alias`, except that explicit model inheritance also follows the caller's effective effort unless an applicable effort pin wins.

## Binding rules

A newly spawned subagent selects its model in this order:

1. The concrete `model_alias` passed at dispatch time.
2. The `model_alias` pin on the effective profile, route, or caller lease (constraints an external delegating host pre-sets for the caller).
3. Explicitly configured `[subagent].default_model`.

With none of these sources, the spawn fails with `model.not_configured`; neither the caller's model nor the main-agent `default_model` is a silent fallback. `model_alias: inherit` on a profile, route, or caller lease binds the caller's current model and thinking effort unless an explicit tool `effort` or an applicable effort pin overrides them. `AgentRun` itself rejects `model_alias: "inherit"` — pass a concrete configured model name, or omit the parameter to use the target default. An unknown alias or a model on a denylist fails before the child starts. Choosing a model outside `preferred_models` / `discouraged_models` is allowed as long as it is inside every hard model and effort limit.

A resumed or retried subagent keeps its persisted binding unless the `AgentRun` `resume` explicitly requests a change. Omitting both `model_alias` and `effort` keeps the current binding; an explicit effort applies to the next idle run. `AgentRun` rejects `model_alias: "inherit"` on resume as well; specify a concrete model name for an explicit change, or omit it to keep the saved model. Switching to a different canonical model requires `allow_model_change: true`; an alias resolving to the same canonical model is a no-op.

## Agent files and routes

Agent files and profile route sidecars pin models with `model_alias`; a main-agent profile cannot use `inherit` because it has no caller. A legacy `model_preference` field is rejected with a migration message, as is unknown `model` metadata left behind by other tools — remove fields that are not supported rather than expecting them to be ignored.

A route-declared `model_alias` is a soft default, and `preferred_models`, `discouraged_models`, and `preferred_efforts` are recommendations. `allowed_models`, `deny_models`, and `allowed_efforts` are hard limits: in a subagent, going outside them rejects the binding, a manual change, or a resume. In a main session your own selection wins, and a violation only warns. `[subagent].deny_models` adds a further hard limit. Native model lists compare canonical identities; external executors compare the effective model IDs they actually call.

## Settings by identity

A model carries one set of shared settings: its default thinking effort, service tier, automatic compaction point, context budget and generated-token ceiling. An identity can override a few of those, and only those — every field it leaves unset keeps the shared value, so an override is a difference rather than a second copy of the settings.

- **Shared**: the model's own values. Every use of the model starts from them, and subagents always use them.
- **Main agent**: applies when the model is used as the main agent, whichever profile happens to hold it. An unset field inherits.
- **Externally delegated agent**: applies to agents delegated in from an external host. An unset field inherits.

Identity is who the model is serving, not which profile is selected, so switching profiles does not drop this layer. Overriding a prompt or cognition field is a different mechanism: those replace a whole group of values, while a setting here changes one field at a time. Clearing an override returns the field to the shared value. `usage_effective` and `usage_sources` report the value each identity resolves to and where it was read from; they describe the model's own resolution, and do not include a profile pin or a session override.

The context budget and the generated-token ceiling are caps, not preferences: the effective value is the lower of the shared cap and any identity value, so an identity can tighten them but never raise them past what the model allows.

In Settings › Models, the model editor opens on the shared values; switch to Main agent to see and edit only that identity's differences, and the editor shows what each field inherits and what it resolves to.

## Model ID resolution

Kiki resolves a requested value to a canonical configured key in this order:

1. An exact configured-key match wins first.
2. Explicit aliases declared on the model record are accepted; ambiguity fails.
3. An unqualified value may match the last segment of a configured key, or the last segment of a record's wire `model` value; ambiguity fails.
4. A qualified value resolves through a trailing configured key only when its provider prefix matches the target record.
5. Unknown or incomplete values never resolve.

This convenience resolution does not create a second selection vocabulary: the public subagent surface still exposes only `model_alias`.

## Next steps

- [Agents and Sub-Agents](../customization/agents.md#agent-file-format) — agent file fields and subagent binding behavior.
- [Configuration files](../configuration/config-files.md#subagent) — the model registry and subagent settings.
