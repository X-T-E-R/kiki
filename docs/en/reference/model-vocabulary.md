---
title: Model selection vocabulary
description: Model aliases, wire identifiers, and subagent binding rules in one reference.
outline: [2, 3]
---

# Model selection vocabulary

Kiki keeps three things separate when selecting models: the model keys in your config file, the `model_alias` used when dispatching subagents, and the identifier actually sent to the provider. This page defines that vocabulary and the binding rules; you mainly need it when pinning models for subagents or profiles.

## Current vocabulary

- **Configured model key**: the key of an entry under `[models]` in `config.toml`. Resolution results use it as the canonical runtime identifier.
- **`model_alias`**: the model selector used by `AgentRun` calls, agent files, and profile routes; its value is one of the configured model keys.
- **Wire model identifier**: the `model` value actually sent to the provider endpoint. It does not have to equal the configured key — the same provider model can be registered under several purpose-specific keys.
- **Thinking effort**: the dispatch parameter `effort`, or `thinking_effort` on a profile or route. It resolves independently from `model_alias`.

## Binding rules

A newly spawned subagent gets its model from exactly two sources:

1. The `model_alias` passed at dispatch time.
2. The `model_alias` pin on the effective profile, route, or caller lease (constraints an external delegating host pre-sets for the caller).

When both are present, the dispatch value wins. When neither names a model, the spawn fails with `model.not_configured`; a subagent never inherits its caller's model and never falls back to a default. Unknown aliases and machine-denied models fail before the child starts. A model outside role guidance, or different from a route or caller-lease pin, continues when executable and produces a structured binding advisory.

A resumed or retried subagent keeps its persisted binding unless the `AgentRun` `resume` explicitly requests a change. Omitting `effort` keeps the current value; an explicit effort applies to the next idle run. An explicit `model_alias` only switches models when confirmed with `allow_model_change: true`; an alias resolving to the same canonical model is a no-op.

## Agent files and routes

Agent files and profile route sidecars pin models with `model_alias`. The legacy `model_preference` field is explicitly rejected with a migration diagnostic; unknown `model` metadata written by other tools is ignored.

A route-declared `model_alias` is the route default. The caller may override it with another executable model; the binding remains tied to the route, is marked detached, and carries an advisory. Role-level `allowed_models` / `deny_models` and effort lists are recommendation policy. Machine-level `[subagent].deny_models` is the hard model boundary.

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
