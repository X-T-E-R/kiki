# Config overrides

Kiki has three places where runtime parameters can be influenced: the config file, command-line options, and environment variables. They are not a simple "whoever has higher priority wins" relationship — the three serve different scenarios and have non-overlapping scopes:

- **Config files** store long-term preferences (model, loop control, etc.); provider credentials live in the companion `credentials.toml`. Both take effect on every startup
- **Command-line options** make one-off changes for the current startup; discarded after exit
- **Environment variables** primarily handle data directory location, OAuth endpoint switching, and a small number of runtime switches — **not a general fallback mechanism for config fields**

This distinction matters: many users run `export KIMI_API_KEY=xxx` in the shell expecting the CLI to pick it up automatically, but it does not. See [Provider credentials](#provider-credentials) below for why.

## Two roles of environment variables

Environment variables fall into two categories by function and cannot be collapsed into a single linear priority order:

1. **Locating the config files**: `KIKI_HOME` sets the data root directory, making the paths `$KIKI_HOME/config.toml` and its companion `$KIKI_HOME/credentials/credentials.toml`. This step runs before all other resolution and is not a fallback for individual parameters.
2. **Runtime endpoints and diagnostics**: Variables like `KIKI_CODE_OAUTH_HOST`, `KIKI_CODE_BASE_URL`, and `KIKI_LOG_LEVEL` are read when the OAuth or logging subsystems initialize. For the full list, see [Environment variables](./env-vars.md).

## Priority for ordinary runtime parameters

For ordinary runtime parameters such as model alias, Plan mode, yolo mode, and Skills directories, priority from highest to lowest is:

1. **Command-line options** (`-m`, `--plan`, `--yolo`, etc.): apply only to the current startup
2. **User config file** (`~/.kiki/config.toml`): stores long-term preferences

A small number of environment variables explicitly override specific config file fields — for example, `KIKI_BACKGROUND_KEEP_ALIVE_ON_EXIT` has higher priority than `[background].keep_alive_on_exit`. These exceptions are noted in [Environment variables](./env-vars.md) and in the relevant field descriptions in [Configuration files](./config-files.md).

::: warning
**Ordinary runtime parameters do not fall back to shell environment variables.** Provider `api_key` / `base_url` are read only from the config files — secrets from `credentials.toml`, everything else from `config.toml` — and do not fall back to `export`-ed shell variables. The only exception is the explicit `KIKI_MODEL_*` channel — see [Define a model from environment variables](./env-vars.md#define-a-model-from-environment-variables-kiki-model).
:::

The CLI reads user-level configuration from `KIKI_HOME` (default `~/.kiki`) and project-local settings from `<project-root>/.kiki/local.toml`. The legacy `.kimi-code/local.toml` path is not read. To isolate config between different projects, point `KIKI_HOME` at different data directories — see [Common scenarios](#common-scenarios) below.

## Provider credentials

Provider credentials (`api_key`, `base_url`) follow their own resolution rules, separate from the ordinary parameter priority chain.

Provider API keys are stored in `credentials/credentials.toml` under the data root. Kiki reads the two files as one document, and on a shared TOML path the value in `credentials.toml` wins; `config.toml` never holds a plaintext credential. See [Provider credentials](./config-files.md#provider-credentials) for the file, its permissions, and the first-load migration.

For a single provider, credentials are resolved in this order:

1. `[providers.<name>].api_key` — the key stored in `credentials.toml`; highest priority
2. The matching key inside the `[providers.<name>.env]` sub-table (`KIMI_API_KEY`, `ANTHROPIC_API_KEY`, etc.) — consulted only when `api_key` is empty; these secret values live in `credentials.toml` too
3. If both are absent — startup fails with an error indicating the provider is missing credentials

`base_url` is resolved the same way: first `[providers.<name>].base_url`, then the `*_BASE_URL` key in `[providers.<name>.env]`. `base_url` is not a secret, so it stays in `config.toml`.

> The `[providers.<name>.env]` sub-table is just a TOML section in the config files — it does not write anything into the shell environment. It is only consulted when the corresponding direct field (`api_key` / `base_url`) is empty.

For the full list of credential key names, see [Environment variables: provider credential key names](./env-vars.md#provider-credential-key-names).

## Command-line options

Options passed at startup have the highest priority and apply only to the current session:

| Option | Effect |
| --- | --- |
| `-S, --session [id]` | Resume a specific session; enters interactive selection when no id is given |
| `-c, --continue` | Resume the last session for the current working directory |
| `-y, --yolo` | Auto-approve regular tool calls; the agent may still ask questions |
| `--auto` | Approve routine actions automatically; ask before protected access and allow agent questions |
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

Resolve the model first, then that model's thinking effort. Route and caller-lease pins are defaults you can override; `allowed_models`, `deny_models`, and `allowed_efforts` are hard limits at every profile, lease, tree, and matching `model_profiles` scope — for a subagent they reject binding, manual changes, and resume, while in a main session your own selection wins and going outside one only warns. A value the model itself does not support is still an error either way.

When a profile binds — a new main session, a new subagent, a model switch, or a native `AgentRun` dispatch — the requested effort is collected from the role's own sources and then resolved against the bound model:

1. An explicit `effort` on the call.
2. For a main session, a persona's or route's locked effort. For a subagent, the route's locked effort, or the caller lease's when the route pins none. Then, in both cases, a matching `model_profiles` entry and the profile's top-level `thinking_effort`.
3. The bound model's preferred effort.
4. `[models."<alias>"].overrides.default_effort`.
5. The model's own `default_effort`.

If none of those produces a value, or the resulting effort is not one the model supports, the bind fails as a configuration error rather than silently picking something. With no model configured at all, the bind asks for both a model and an effort. You do not have to pass an effort when a route, lease, profile pin, or model default already supplies one; you need one only when nothing else does, in which case configure that pin or pass `effort` for this call.

This applies to profile binding only. A plain resume that keeps an existing valid binding is not recomputed, so an effort saved earlier keeps working. Changing only `effort` keeps the saved model, and changing model on resume still requires `allow_model_change: true`.

Paths that do not bind a profile are unchanged: the global `[thinking]` section still supplies its fallback, and `[thinking].enabled = false` still resolves an unpinned effort to Off there.

## Prompt field precedence

Prompt text fields use a separate chain. From low to high: global `[prompt.overrides]`, model `[models."<alias>".prompt_overrides]`, agent or `SYSTEM.md` frontmatter `prompt_overrides`, then the matching `model_profiles[].prompt_overrides`. Agent files and `SYSTEM.md` sit at the same level, so there are five surfaces across four levels.

Every surface accepts `files` and `fields`. Files load from the Kiki home directory in listed order, then inline fields win within that surface. A field missing at a higher level inherits the lower value; values are never concatenated. See [`prompt`](./config-files.md#prompt) for the external-file schema, field examples, and how to move off the removed `prompt.shared` / `prompt.tools` keys.

## Common scenarios

**Isolated test environment** — use a separate data directory to avoid polluting the main config and sessions:

```sh
KIKI_HOME="$PWD/.kiki-sandbox" kiki
```

**One-off test key** — since provider credentials are read only from the config files, write a test key into `credentials.toml`:

```toml
# ~/.kiki/credentials/credentials.toml
[providers.kimi.env]
KIMI_API_KEY = "sk-test"
```

**Auto-approve tool calls for one session**:

```sh
kiki --yolo
```

`--yolo` applies to the interactive session; it cannot be combined with `-p` — see the mutual exclusion rules above.

**Enter Plan mode temporarily** (to make it permanent, set `default_plan_mode = true` in the config file):

```sh
kiki --plan
```

## Next steps

- [Configuration files](./config-files.md) — complete reference for all configurable fields
- [Environment variables](./env-vars.md) — full list and description of `KIKI_HOME` and related variables
