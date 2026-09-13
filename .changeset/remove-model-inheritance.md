---
"@kiki/node-sdk": major
"@kiki/cli": major
---

Subagents no longer inherit the caller's model. A subagent's model now comes from exactly two places: a `model_alias` pinned on its agent profile (or the profile's route, or the caller's tower lease), or an explicit `model_alias` passed with the dispatch. When neither is present, `AgentRun`, `AgentSwarm`, and tower spawn fail with `model.not_configured` instead of silently running the subagent on the caller's model. The built-in profiles (`coder`, `explore`, `tower-worker`) ship without a pin, so dispatching them requires `model_alias` until you pin one.

What is gone:

- The `[secondary_model]` config section (`default_model`, `models`, `force`, `enforce_pool`), `[subagent] default_model` / `default_effort`, and `[agents] default_subagent_model` / `default_subagent_reasoning_effort`.
- The `/secondary-model` TUI command, the GUI subagent model-pool editor, and the REST `secondary_model` config domain.
- The `model_preference` frontmatter key on agent files and route sidecars, and the symbolic `model` parameter on `AgentRun` / `AgentSwarm` (`model_alias` is the only spelling).
- The `secondary-model` experimental flag.

Existing transcripts are unaffected: children recorded under the old inherit label resume on their recorded model alias.
