# Config overrides

Kiki has three places where runtime parameters can be influenced: the config file, command-line options, and environment variables. They are not a simple "whoever has higher priority wins" relationship — the three serve different scenarios and have non-overlapping scopes:

- **Config file** stores long-term preferences (model, keys, loop control, etc.); takes effect on every startup
- **Command-line options** make one-off changes for the current startup; discarded after exit
- **Environment variables** primarily handle data directory location, OAuth endpoint switching, and a small number of runtime switches — **not a general fallback mechanism for config fields**

This distinction matters: many users run `export KIMI_API_KEY=xxx` in the shell expecting the CLI to pick it up automatically, but it does not. See [Provider credentials](#provider-credentials) below for why.

## Two roles of environment variables

Environment variables fall into two categories by function and cannot be collapsed into a single linear priority order:

1. **Locating the config file**: `KIKI_HOME` sets the data root directory, making the config file path `$KIKI_HOME/config.toml`. This step runs before all other resolution and is not a fallback for individual parameters.
2. **Runtime endpoints and diagnostics**: Variables like `KIMI_CODE_OAUTH_HOST`, `KIMI_CODE_BASE_URL`, and `KIMI_LOG_LEVEL` are read when the OAuth or logging subsystems initialize. For the full list, see [Environment variables](./env-vars.md).

## Priority for ordinary runtime parameters

For ordinary runtime parameters such as model alias, Plan mode, yolo mode, and Skills directories, priority from highest to lowest is:

1. **Command-line options** (`-m`, `--plan`, `--yolo`, etc.): apply only to the current startup
2. **User config file** (`~/.kiki/config.toml`): stores long-term preferences

A small number of environment variables explicitly override specific config file fields — for example, `KIKI_BACKGROUND_KEEP_ALIVE_ON_EXIT` has higher priority than `[background].keep_alive_on_exit`. These exceptions are noted in [Environment variables](./env-vars.md) and in the relevant field descriptions in [Configuration files](./config-files.md).

::: warning
**Ordinary runtime parameters do not fall back to shell environment variables.** Provider `api_key` / `base_url` are read only from `config.toml` (including the `[providers.<name>.env]` sub-table) and do not fall back to `export`-ed shell variables. The only exception is the explicit `KIMI_MODEL_*` channel — see [Define a model from environment variables](./env-vars.md#define-a-model-from-environment-variables-kimi-model).
:::

The CLI reads user-level configuration from `KIKI_HOME` (default `~/.kiki`) and project-local settings from `<project-root>/.kiki/local.toml`. The legacy `.kimi-code/local.toml` path is not loaded automatically; run `kiki migrate-config --workspace <directory>` to copy it into `.kiki/`. To isolate config between different projects, point `KIKI_HOME` at different data directories — see [Common scenarios](#common-scenarios) below.

## Provider credentials

Provider credentials (`api_key`, `base_url`) follow their own resolution rules, separate from the ordinary parameter priority chain.

For a single provider, credentials are resolved in this order:

1. `[providers.<name>].api_key` — key written directly in the config file; highest priority
2. The matching key inside the `[providers.<name>.env]` sub-table (`KIMI_API_KEY`, `ANTHROPIC_API_KEY`, etc.) — consulted only when `api_key` is empty
3. If both are absent — startup fails with an error indicating the provider is missing credentials

`base_url` is resolved the same way: first `[providers.<name>].base_url`, then the `*_BASE_URL` key in `[providers.<name>.env]`.

> The `[providers.<name>.env]` sub-table is just a TOML section in the config file — it does not write anything into the shell environment. It is only consulted when the corresponding direct field (`api_key` / `base_url`) is empty.

For the full list of credential key names, see [Environment variables: provider credential key names](./env-vars.md#provider-credential-key-names-written-in-config-toml).

## Command-line options

Options passed at startup have the highest priority and apply only to the current session:

| Option | Effect |
| --- | --- |
| `-S, --session [id]` | Resume a specific session; enters interactive selection when no id is given |
| `-c, --continue` | Resume the last session for the current working directory |
| `-y, --yolo` | Auto-approve regular tool calls; the agent may still ask questions |
| `--auto` | Start in auto permission mode: fully autonomous, the agent will not ask questions |
| `--plan` | Start in Plan mode |
| `-m, --model <model>` | Use a specific model alias for this session |
| `-p, --prompt <prompt>` | Run in non-interactive mode: execute a single prompt and exit |
| `--output-format <format>` | Output format for `-p` mode: `text` or `stream-json` |
| `--skills-dir <dir>` | Replace auto-discovered Skills directories (repeatable; applies to this session only) |

Mutual exclusion rules (startup fails if violated):

- `--output-format` can only be used with `-p`
- `--prompt` cannot be combined with `--yolo` or `--plan`
- `--continue` and `--session` cannot be used together
- In non-prompt mode, `--yolo` and `--plan` cannot be combined with `--continue` or `--session`

::: tip
`--skills-dir` is a one-shot replacement that only affects the current startup. To persistently add search directories, write `extra_skill_dirs` in `config.toml` (see [Agent Skills](../customization/skills.md)).
:::

## Model and effort resolution

For native executor agents, determine the model for this dispatch first, then resolve that model's thinking effort. Existing route, lease, and caller constraints still apply.

Thinking effort resolves in this order:

1. An explicit `effort` must satisfy the selected model's lock and capabilities.
2. When `effort` is omitted, existing route or lease locks take precedence.
3. A matching `model_profiles` entry.
4. The profile's top-level `thinking_effort`, only when the selected model matches the profile's default `model_alias`.
5. `[models."<alias>"].overrides.default_effort`.
6. The `[thinking]` global default.
7. The model's catalog or capability default.

A profile without `model_alias` skips only the top-level effort layer; it does not fail closed, and resolution continues with the next default layer. On a plain resume, omitting model parameters keeps the current binding. An alias resolving to the same canonical model is a no-op. Changing only `effort` keeps the saved model. Changing to a different canonical model without `effort` re-resolves effort for the new model; on resume, that model change still requires `allow_model_change: true`. Existing parameter validation and the external executor's own validation remain in force.

## Common scenarios

**Isolated test environment** — use a separate data directory to avoid polluting the main config and sessions:

```sh
KIKI_HOME="$PWD/.kiki-sandbox" kiki
```

**One-off test key** — since provider credentials are read only from the config file, write a test key into the `env` sub-table:

```toml
[providers.kimi.env]
KIMI_API_KEY = "sk-test"
```

**Skip approval for batch tasks**:

```sh
kiki --yolo -p "Batch rename the following files..."
```

**Enter Plan mode temporarily** (to make it permanent, set `default_plan_mode = true` in the config file):

```sh
kiki --plan
```

## Next steps

- [Configuration files](./config-files.md) — complete reference for all configurable fields
- [Environment variables](./env-vars.md) — full list and description of `KIKI_HOME` and related variables
