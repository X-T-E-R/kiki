# Configuration files

Kiki writes all long-term preferences — which model to use, which API key to fill in, how many steps an Agent can run per turn — into TOML (a plain-text configuration format with a clear structure) files. Change them once and they take effect on every startup. Ordinary agent and runtime settings live in `config.toml`; provider credentials live in a separate `credentials.toml`; terminal-UI and client preferences (theme, editor, notifications, auto-update) live in a companion `tui.toml`.

Default location: `~/.kiki/config.toml`, created automatically on first run. Provider credentials live beside it in `~/.kiki/credentials.toml`; see [Provider credentials](#provider-credentials).

## Config file location

The CLI reads configuration from `~/.kiki/config.toml`. To relocate the data directory, override it with the `KIKI_HOME` environment variable:

```sh
export KIKI_HOME=/path/to/kiki-home
```

The config file path then becomes `$KIKI_HOME/config.toml`. Regardless of where the directory lives, the file name is always `config.toml`.

`credentials.toml` follows the same rule: it always sits in the same directory as `config.toml`, so its path becomes `$KIKI_HOME/credentials.toml` when you override the data directory. Its file name is always `credentials.toml`.

::: tip
TOML field names always use snake_case, for example `default_model` and `max_context_size`. If a key contains `.`, you must quote it — for example `[models."gpt-4.1"]` — otherwise TOML treats `.` as a nested table separator.
:::

## Complete example

The following example covers the most commonly used configuration fields. You can copy it and adjust as needed:

```toml
default_model = "kimi-code/k3"
default_permission_mode = "manual"
default_plan_mode = false
merge_all_available_skills = true

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"

[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
max_context_size = 1048576
capabilities = [ "thinking", "always_thinking", "image_in", "video_in", "tool_use" ]
display_name = "K3"
support_efforts = [ "low", "high", "max" ]
default_effort = "max"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144
capabilities = [ "thinking", "always_thinking", "image_in", "video_in", "tool_use" ]

[models."kimi-code/kimi-for-coding-highspeed"]
provider = "managed:kimi-code"
model = "kimi-for-coding-highspeed"
max_context_size = 262144
capabilities = [ "thinking", "always_thinking", "image_in", "video_in", "tool_use" ]

[thinking]
enabled = true
effort = "high"
keep = "all"

[loop_control]
max_attempts_per_step = 5
reserved_context_size = 50000

[background]
max_running_tasks = 4
keep_alive_on_exit = false

[nb_search.credential_slots."exa.default"]
provider_id = "exa"
env = "NB_SEARCH_EXA_API_KEY"

[nb_search.defaults]
search_lane = "exa.search"

[[permission.rules]]
decision = "allow"
pattern = "Read"

[[permission.rules]]
decision = "deny"
pattern = "Bash(rm -rf*)"

[[hooks]]
event = "PreToolUse"
matcher = "Bash"
command = "node ~/.kiki/hooks/check-bash.mjs"
timeout = 5
```

## Provider credentials

Provider credentials — the API keys Kiki uses to call each provider — are stored in `~/.kiki/credentials.toml`, a companion file in the same directory as `config.toml` (`$KIKI_HOME/credentials.toml` when you override the data directory). Ordinary configuration stays in `config.toml`; credential values keep the TOML paths they had there, so a provider's `api_key` simply moves out of its `[providers."<name>"]` table in `config.toml` and into the same table here.

```toml
# ~/.kiki/credentials.toml
[providers."managed:kimi-code"]
api_key = "YOUR_API_KEY"
```

The file is optional. When it is missing, Kiki treats it as empty and falls back to any credential still present in `config.toml`. When both files carry a value for the same provider credential, the value in `credentials.toml` wins.

The field-level priority between `api_key` and the `[providers.<name>.env]` fallback is covered in [Config overrides](./overrides.md#provider-credentials).

### Migrating existing keys

If an older `config.toml` still holds provider credentials, the first load after upgrading moves them into `credentials.toml` and rewrites `config.toml` without them. The previous `config.toml` is kept as a backup named `config.toml.bak-<date>` — the migration date, for example `config.toml.bak-2026-09-30` — so you can review or restore it. The backup still contains the original plaintext keys; remove it after checking the migration if you no longer need it. Repeated loads do not create another backup or change already-moved credentials.

### File permissions

Kiki creates and rewrites `credentials.toml` with owner-only permissions (`0600`) wherever the platform supports it, so other users on the same machine cannot read your keys.

### Secret handling

Configuration and provider read APIs report credential presence (for example, `has_api_key`) without returning the stored key. Keep `credentials.toml` and any migration backup private.

## Top-level fields

Fields in the config file fall into two categories: **top-level scalars** that directly control default behavior, and **nested tables** (`providers`, `models`, `thinking`, etc.) that each have their own structure, described individually in the sections below.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `default_model` | `string` | — | Default model alias; must be defined in `models` |
| `default_permission_mode` | `string` | `manual` | Default permission mode for new sessions; one of `manual` (prompt each time), `yolo` (auto-approve tool actions, but the agent may still ask questions), or `auto` (fully autonomous — the agent decides everything without asking) |
| `default_plan_mode` | `boolean` | `false` | Whether new sessions start in Plan mode (produce a plan before executing) by default |
| `merge_all_available_skills` | `boolean` | `true` | Whether to merge Agent Skills from all available directories |
| `extra_skill_dirs` | `array<string>` | — | Extra skill search directories, layered on top of the default directories |
| `extra_agent_dirs` | `array<string>` | — | Extra custom agent search directories, layered on top of the default directories |
| `skip_builtin_profile_installation` | `array<string>` | — | Built-in template names not to install under `agents/builtin/` at startup. Already managed copies remain active and continue receiving safe updates; this is not a runtime disable switch |
| `disabled_named_profiles` | `array<string>` | `[]` | Profile names to hide from subagent discovery and dispatch, regardless of file source. The default main `agent` binding remains available |
| `builtin_product_skills` | `boolean` | `true` | Whether Kiki's product skills are offered to the model: `kiki-ops` for product usage and configuration, and `kiki-profile` for agent profile authoring. Turning them off removes both names and descriptions from the system prompt, at the cost of those guided workflows |
| `providers` | `table` | `{}` | API provider table → [`providers`](#providers) |
| `models` | `table` | — | Model alias table → [`models`](#models) |
| `thinking` | `table` | — | Default parameters for Thinking mode → [`thinking`](#thinking) |
| `loop_control` | `table` | — | Agent loop control parameters → [`loop_control`](#loop-control) |
| `retry` | `table` | — | Error-specific step retry policies → [`retry`](#retry) |
| `token_counting` | `table` | — | Which context token count is reported externally → [`token_counting`](#token-counting) |
| `background` | `table` | — | Background task runtime parameters → [`background`](#background) |
| `subagent` | `table` | — | Subagent run defaults and limits → [`subagent`](#subagent) |
| `agents` | `table` | — | Delegation-notice defaults → [`agents`](#agents) |
| `thread_communication` | `table` | `{ enabled = false }` | Local peer-thread communication → [`thread_communication`](#thread-communication) |
| `mcp` | `table` | — | Global MCP server timeout defaults → [`mcp`](#mcp) |
| `tools` | `table` | — | Global tool switch → [`tools`](#tools) |
| `image` | `table` | — | Image compression parameters → [`image`](#image) |
| `session_title` | `table` | — | Which model writes AI session titles → [`session_title`](#session-title) |
| `experimental` | `table` | — | Persistent overrides for experimental-feature flags → [`experimental`](#experimental) |
| `nb_search_source` | `table` | — | Host option controlling whether the built-in search module reuses the server's local nb-search configuration → [`nb_search`](#nb-search) |
| `nb_search` | `table` | — | Built-in search and retrieval module behind `WebSearch` and `FetchURL` → [`nb_search`](#nb-search) |
| `permission` | `table` | — | Initial permission rules → [`permission`](#permission) |
| `hooks` | `array<table>` | — | Lifecycle hooks; see [Hooks](../customization/hooks.md) |
| `identity` | `table` | — | Custom agent identity → [`identity`](#identity) |
| `prompt` | `table` | `{}` | Prompt field overrides and custom variables → [`prompt`](#prompt) |

The following sections cover each of the nested tables in turn: `providers`, `models`, `thinking`, `loop_control`, `retry`, `token_counting`, `background`, `subagent`, `agents`, `thread_communication`, `mcp`, `tools`, `image`, `session_title`, `experimental`, `nb_search`, `permission`, and `prompt`.

## `providers`

Each entry in the `providers` table defines an API provider, keyed by a unique name. The provider's `api_key` lives in [`credentials.toml`](#provider-credentials), and the CLI does **not** fall back to shell environment variables automatically. Running `export KIMI_API_KEY` in the terminal does not give any provider its key — write it in `credentials.toml` instead.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `string` | Yes | Provider type: `kimi`, `anthropic`, `openai`, `openai_responses`, `google-genai`, `vertexai` |
| `api_key` | `string` | No | API key. Stored in `credentials.toml`; a value in `config.toml` is used only when `credentials.toml` has none for that provider |
| `base_url` | `string` | No | API base URL |
| `oauth` | `table` | No | OAuth credential reference (`storage` and `key` fields); injected automatically by the login flow — normally no need to write this by hand |
| `env` | `table<string, string>` | No | Fallback source for provider credentials; see below |
| `custom_headers` | `table<string, string>` | No | Custom HTTP headers attached to each request |

**`env` sub-table**: You can write provider-conventional key names (such as `KIMI_API_KEY`) inside `[providers.<name>.env]` as a fallback source for `api_key` / `base_url`. This sub-table is **read only from the config file** and does not modify the shell environment:

```toml
[providers.kimi.env]
KIMI_API_KEY = "sk-xxx"
KIMI_BASE_URL = "https://api.moonshot.ai/v1"
```

Priority: `api_key` field > `env` sub-table key > if both are absent, startup fails with an error.

## `models`

Each entry in the `models` table defines a model alias (the name used in `default_model` or the `-m` flag), keyed by a unique name.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `provider` | `string` | Yes | Name of the provider to use; must be defined in `providers` |
| `model` | `string` | Yes | Model identifier sent to the server when calling the API |
| `max_context_size` | `integer` | Yes | Maximum context length in tokens; must be at least 1 |
| `max_input_size` | `integer` | No | Declared per-request input limit when it sits below the total window (e.g. gpt-5: 400k window, 272k input). Compaction, context-overflow checks, and usage ratios prefer it; completion budgeting keeps the total window. Resolution clamps it to `max_context_size` |
| `max_output_size` | `integer` | No | Per-request output token cap (maps to `max_tokens`). Currently only the `anthropic` provider honors it. When set for a Claude model, this explicit value overrides the built-in server-side maximum |
| `capabilities` | `array<string>` | No | Capability tags to add explicitly: `thinking`, `always_thinking`, `image_in`, `video_in`, `audio_in`, `tool_use`. Unioned with the capabilities auto-detected by the provider — entries can only be added, never removed |
| `support_efforts` | `array<string>` | No | Thinking effort levels the model accepts. For `kimi`, selecting another value at runtime fails; when model resolution carries an unsupported configured or previous value, the session falls back to the target model's `default_effort` and reports that effective value to the UI. A Thinking-capable Kimi model without this field uses boolean `on` / `off`. Other providers pass concrete values unchanged when their protocol has a native effort field; protocols that expose only levels or token budgets perform the required format conversion. Managed and open-platform refreshes may rewrite this field; to pin it manually, set `[models."<alias>".overrides] support_efforts` instead |
| `default_effort` | `string` | No | Default thinking effort for the model. Managed and open-platform refreshes may rewrite this field; to pin it manually, set `[models."<alias>".overrides] default_effort` instead |
| `service_tier` | `string` | No | Service tier for every request using this model: `auto`, `default`, `flex`, or `priority`. Overrides profile, route, and per-request tiers, including main-agent and subagent requests. Only `openai_responses` encodes it; other protocols ignore it. Omit to retain the requesting profile or request's tier |
| `request_params` | `table` | No | Extra request parameters merged into every request for this model (for example `temperature`, `top_p`); values may be strings, numbers, or booleans. Layered values merge by key |
| `context_budget` | `integer` | No | Upper bound (tokens) applied to the model's effective context window; never above the model's real capacity. Layered values take the smallest |
| `max_completion_tokens` | `integer` | No | Upper bound on per-request completion tokens. Layered values take the smallest, within the model's output cap |
| `off_effort` | `string` | No | Effort value sent on the wire to disable thinking (e.g. `none` for xai grok). Only meaningful for models that declare such an encoding (catalog imports set it): turning thinking Off then sends this value instead of omitting the effort field — the only way to actually stop reasoning on models that reason by default |
| `protocol` | `string` | No | Transport override; currently only `anthropic`, which routes this model's requests through the Anthropic Messages transport. Not accepted in `overrides` |
| `beta_api` | `boolean` | No | `anthropic` transport only: route requests through the beta Messages API endpoint instead of the standard one. Not accepted in `overrides` |
| `base_url` | `string` | No | Per-model endpoint override (written by catalog imports for gateway models served away from the provider default). Resolution prefers it over the provider's `base_url`; only takes effect together with `protocol` |
| `display_name` | `string` | No | Name shown in the UI; falls back to `model` when unset |
| `aliases` | `array<string>` | No | Extra routing keys for this model. An exact match on any entry resolves to this table key, including names that contain `/`. This is the supported way to keep old names working after you rename a key. The same alias string on two models is an error |
| `reasoning_key` | `string` | No | `openai` provider only. Override the field name used for reasoning content when the gateway returns it under a non-standard name; by default `reasoning_content`, `reasoning_details`, and `reasoning` are auto-detected |
| `adaptive_thinking` | `boolean` | No | `anthropic` provider only. Force adaptive thinking on or off, overriding the version inference based on the model name. Omit to infer automatically (Claude ≥ 4.6 uses adaptive) |
| `prompt_overrides` | `table` | No | Prompt field overrides for this model alias, with optional `files` and `fields`; see [`prompt`](#prompt) |
| `cognition` | `table` | No | Per-alias prompt files that condition this model → [Model cognition](#model-cognition) |

When an alias contains `.`, use a quoted key:

```toml
[models."gpt-4.1"]
provider = "openai"
model = "gpt-4.1"
max_context_size = 1048576
```

### Model alias resolution

The key of each `[models]` entry is the model's alias — the name used by `default_model`, `-m`, and an agent's `model_alias`. A request is resolved in this order:

1. Exact table key
2. Exact match against a model's `aliases` list
3. Bare name that uniquely matches a table key or a record's `model` field (equal to the name, or ending in `/<name>`)
4. Provider-qualified name (`<prefix>/<name>`) whose last segment is a table key and whose prefix is consistent with that record's `provider`

A bare name and a provider-qualified name resolve to each other when the match is unique. If more than one configured model matches, resolution fails and asks you to use a full model id to disambiguate.

When you shorten a table key, put the previous name in `aliases` so sessions and agent profiles that still store the old name keep working:

```toml
[models.fast-model]
provider = "openai"
model = "fast-model"
max_context_size = 1048576
aliases = ["openai/fast-model"]
```

The same pattern applies to a review model whose key used to be qualified:

```toml
[models.k3-review]
provider = "openai"
model = "k3-review"
max_context_size = 262144
aliases = ["openai/k3-review"]
```

### Model overrides

Use `[models."<alias>".overrides]` for user overrides that must survive provider-model refreshes. Runtime consumers read the effective value: the override when present, otherwise the top-level field.

```toml
[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144

[models."kimi-code/kimi-for-coding".overrides]
max_context_size = 131072
display_name = "Kimi for Coding (custom)"
```

`[models."<alias>".overrides]` accepts ordinary model fields such as `max_context_size`, `max_input_size`, `max_output_size`, `capabilities`, `display_name`, `reasoning_key`, `adaptive_thinking`, `support_efforts`, `default_effort`, `off_effort`, `service_tier`, `request_params`, `context_budget`, and `max_completion_tokens`. It does not accept identity / routing fields: `provider`, `model`, `protocol`, `beta_api`, and `base_url`. For these added fields, resolve the model alias configuration, including its `overrides`, first; then apply model alias → top-level profile → matching `model_profiles` entry. Merge `request_params` by key and use the last explicit `service_tier`; `context_budget` and `max_completion_tokens` are limits, so take the smallest declared value across layers within the model's capacity and output cap. Omitting a limit adds no restriction.

You can also switch models temporarily without touching the config file — by setting `KIKI_MODEL_*` environment variables, the CLI synthesizes a temporary provider in memory that does not persist after restart. See [Define a model from environment variables](./env-vars.md#define-a-model-from-environment-variables-kiki-model).

### Model cognition

`[models."<alias>".cognition]` attaches prompt files to a single model alias, so a model that needs different conditioning (extra instructions shaping how it reasons) than the rest of your catalog gets it without touching any agent profile. Every field points at a file read from disk at runtime; no default text ships with the CLI, and nothing is injected unless you declare a file.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `overlay` | `string` or `array<string>` | — | File(s) merged into the bound model's system prompt. Multiple paths are joined with a blank line in declaration order |
| `overlay_mode` | `string` | `append` | How `overlay` combines with the profile's prompt: `append`, `prepend`, `wrap`, `persona`, or `replace` |
| `steering` | `string` or `array<string>` | — | File(s) injected as a user message right after your prompt, at the start of every turn |
| `anchor` | `string` or `array<string>` | — | File(s) used as the complete system prompt for the opening steps of a turn, replacing the profile prompt and any `overlay` |
| `anchor_steps` | `integer` | `1` | How many model requests at the start of an anchored turn use the `anchor` text; must be at least 1 |
| `anchor_scope` | `string` | `session` | `session` anchors only the session's first turn; `turn` anchors the opening steps of every turn |

Paths are relative to the [data root directory](./data-locations.md#data-root-directory) (`~/.kiki` by default). Absolute paths, paths that resolve outside the data root (including through a symlink), and missing files are rejected when the profile binds, with an error naming the field and the path — a typo stops the session instead of silently sending an unconditioned prompt. A declared file that exists but is empty is skipped; when every file declared for one field is empty, that field behaves as unset.

The three fields differ in how far they sit from the model's next token. `overlay` and `anchor` rewrite the system prompt, which the model reads once, before your request. `steering` sits directly after your prompt as an ordinary user message — not a `<system-reminder>` — and the same text is re-injected on every new turn, including after compaction re-arms the context, so the cue never drifts away from the latest request.

`overlay_mode` decides how much of the profile's prompt survives:

| Mode | Result |
| --- | --- |
| `append` | Profile prompt, then the overlay |
| `prepend` | Overlay, then the profile prompt |
| `wrap` | Overlay, the profile prompt, then a fixed closing line stating that the overlay still governs reasoning |
| `persona` | The overlay takes the place of the profile prompt's opening `You are …` paragraph; the rest of that prompt is kept |
| `replace` | The overlay becomes the entire system prompt |

`persona` locates the identity paragraph by matching `You are` at the very start of the prompt. A profile whose prompt opens some other way has no identity paragraph to drop, so the overlay is appended instead.

Anchoring is a per-request substitution, not a rewrite of the stored prompt. For the first `anchor_steps` requests of an anchored turn the model receives the `anchor` text as its entire system prompt; from the next step onward it receives the normal prompt, overlay included, for the rest of the session. Reach for it when a long profile prompt crowds out the conditioning you want at the moment the model plans, and the full prompt only matters once it starts calling tools. A system prompt passed explicitly by a caller is never replaced.

Cognition binds to the alias rather than to the main agent, so a subagent that binds the same alias — through its own `model_alias`, whether pinned or dispatched — gets the same overlay, steering, and anchor. Switching aliases mid-session re-renders the overlay for the newly bound model.

The example below conditions a DeepSeek V4 model whose default habit is to narrate execution step by step instead of planning first. It pairs a short `anchor` — a thin persona that stands in for the profile prompt while the model plans — with `steering` that asks for a plan before action:

```toml
[models."axon-message/deepseek-v4-flash-0731".cognition]
anchor = "cognition/flash-anchor.md"
anchor_steps = 3
steering = "cognition/flash-steering.md"
```

`~/.kiki/cognition/flash-anchor.md`:

```
You are a helpful software engineer assistant.
```

`~/.kiki/cognition/flash-steering.md`:

```
Router: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Let's first understand the problem and devise a plan; then let's carry out the plan and act.
```

With both files in place, the model plans before acting during the first three steps of the session, then continues with its full profile prompt.

Treat that wording as a starting point rather than a setting. Which phrasing actually shifts a model's reasoning was measured on this one model, and another model — or another profile prompt — may need different text, or none at all. The mechanism itself does not interpret the files.

## Subagent model binding

A subagent's model comes from exactly two places: the `model_alias` passed
with the `AgentRun` dispatch, or the pin on the profile, route, or caller lease
that the dispatch selects. The caller's model and `default_model` are not silent
fallbacks: without a parameter or effective pin, dispatch fails with
`model.not_configured` before creating a child. Set `model_alias: inherit` on a
subagent profile, route, or caller lease, or pass `model_alias: "inherit"` to
`AgentRun`, to explicitly bind the caller's current resolved model. A main-agent
profile cannot use `inherit` because it has no caller.

Thinking effort may stay unset. With `model_alias: inherit`, it follows the
caller's effective thinking effort unless an explicit tool `effort` or an
applicable profile, route, caller-lease, or matching `model_profiles` effort pin
wins. Otherwise, effort resolves as tool `effort` → matching `model_profiles`
effort → profile `thinking_effort` when the selected model matches its pin →
the bound model's own default under the global [`[thinking]`](#thinking) config.

## `thinking`

`thinking` sets the global default behavior for Thinking mode.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | Whether Thinking is enabled by default for new sessions; set to `false` to force Thinking off |
| `effort` | `string` | — | Thinking effort level (for example `low`, `medium`, `high`, `xhigh`, `max`). Non-Kimi providers do not remap concrete effort values when the upstream protocol accepts them; if the provider rejects the value, choose one that the model supports. Protocols that expose only levels or token budgets still require format conversion. Kimi models with `support_efforts` fall back to their model default when this configured value is not listed; Kimi models without that list treat every enabled value as boolean `on` |
| `keep` | `string` | `"all"` | Preserved Thinking passthrough. On `kimi` it is sent as `thinking.keep`; on `anthropic` (Claude and Kimi's Anthropic-compatible mode) it is sent as a `context_management` `clear_thinking_20251015` edit (enabling keep routes Anthropic requests to the beta Messages API; an off-value disables keep and returns to the standard endpoint). `"all"` preserves prior turns' reasoning (`reasoning_content` / Anthropic thinking blocks); set to an off-value (`false`/`0`/`no`/`off`/`none`/`null`) to disable. Overridden by `KIKI_MODEL_THINKING_KEEP`; only injected while Thinking is on |

### Deprecated fields

| Field | Deprecated in | Description |
| --- | --- | --- |
| `default_thinking` | 0.21.0 | Top-level boolean, replaced by `[thinking] enabled`. Migrate `default_thinking = true` to `enabled = true`, and `default_thinking = false` to `enabled = false`. |
| `thinking.mode` | 0.21.0 | One of `auto` / `on` / `off`, replaced by `[thinking] enabled`. `mode = "off"` becomes `enabled = false`; `mode = "on"` and `mode = "auto"` are equivalent to `enabled = true` (the default) and can be removed. |

## `loop_control`

`loop_control` governs the step count limit, the per-step attempt limit, the threshold that triggers automatic context compaction, and the attempt limit for a failing compaction request in the Agent execution loop.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `max_steps_per_turn` | `integer` | — | Maximum steps per turn; unset or `0` means unlimited |
| `max_attempts_per_step` | `integer` | `5` | Maximum total attempts for a failing step, including the initial attempt |
| `reserved_context_size` | `integer` | — | Number of tokens reserved for model output; automatic compaction is triggered when the remaining context window falls below this value |
| `compaction_max_attempts` | `integer` | `5` | Maximum total requests for a failing compaction, including the initial attempt; every recovery path (retry backoff, context-overflow shrink, empty or truncated shrink) draws on the same budget |

`max_steps_per_turn` can be overridden by the `KIKI_LOOP_MAX_STEPS_PER_TURN` environment variable, and `max_attempts_per_step` by `KIKI_LOOP_MAX_ATTEMPTS_PER_STEP`; both take higher priority than the config file.

Retries only apply to transient failures — connection errors, timeouts, HTTP 429 rate limits, and all HTTP 500–599 server errors. A 429 caused by an exhausted quota or insufficient account balance is not retried and fails immediately, since it cannot succeed until the account is recharged.

## `retry`

`retry` customizes the total attempt budget and fixed backoff for selected step errors. By default, a retryable step gets five total attempts, with waits of 2, 4, 8, and 16 seconds plus up to 25% jitter (30–37.5 seconds in total). A provider `Retry-After` value or a matching policy's fixed `backoff` replaces the corresponding default wait. The section and each policy are strict: an unknown field is rejected rather than silently ignored.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `max_attempts` | `integer` | — | Maximum total attempts for a failing step, including the initial attempt; overrides `loop_control.max_attempts_per_step` |
| `policies` | `array<table>` | — | Ordered per-error policies written as `[[retry.policies]]`; the first matching policy applies |

Each `[[retry.policies]]` entry has these fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `match` | `string` | Yes | Regular expression matched against the error code and error name |
| `max_attempts` | `integer` | No | Total attempts for matching errors, including the initial attempt; overrides the section-level budget |
| `backoff` | `integer` | No | Fixed delay in milliseconds before each retry; a provider retry-after hint still takes precedence |
| `retry` | `boolean` | No | Defaults to `true`. `false` can suppress an error that Kiki normally considers retryable; `true` cannot force retries for an error classified as non-retryable |

Policies are checked from top to bottom, so put specific regular expressions before broader ones:

```toml
[retry]
max_attempts = 4

[[retry.policies]]
match = '^provider\.rate_limit$'
max_attempts = 6
backoff = 1000

[[retry.policies]]
match = '^provider\.'
retry = false
```

## `token_counting`

`token_counting` selects which context token count is reported externally — the value behind the context-size display. Internal logic (automatic compaction triggers, budgets, and overflow backoff) always uses both provider-reported usage and estimates, regardless of this setting.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `strategy` | `"measured+estimated" \| "measured" \| "estimated"` | `"measured+estimated"` | `measured+estimated` reports the live size — the provider-reported usage of each exchange plus an estimate of the not-yet-measured tail — floored by the last measured total; `measured` reports provider usage alone, so the display only moves when an exchange completes; `estimated` reports a pure estimate with provider usage ignored — the fallback for providers that do not report usage or report it unreliably |

`strategy` can be overridden by the `KIKI_TOKEN_COUNTING_STRATEGY` environment variable, which takes higher priority than `config.toml`.

## `background`

`background` controls the concurrency behavior of background tasks (launched via the `Bash` tool's `run_in_background=true` parameter or the `AgentRun` tool's `background=true` parameter).

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `max_running_tasks` | `integer` | — | Maximum number of background tasks running concurrently |
| `keep_alive_on_exit` | `boolean` | `false` | Whether to keep still-running background tasks when the session closes. By default, Kiki requests that all background tasks stop before the process exits; set this to `true` only when you want tasks to outlive the session. In print mode (`kiki -p`), this is only a legacy fallback used when `print_background_mode` is unset: `true` is equivalent to `print_background_mode = "drain"` |
| `kill_grace_period_ms` | `integer` | `5000` | Grace period in milliseconds after session close, a manual stop, or a task timeout requests graceful termination. If a task is still running after this period, Kiki attempts to force-stop it |
| `bash_auto_background_on_timeout` | `boolean` | `true` | When a foreground `Bash` command hits its timeout, move it to a background task instead of killing it — the agent is notified when it completes, and the backgrounded command is bounded by the `bash_task_timeout_s` default background timeout. Set to `false` to kill timed-out foreground commands instead |
| `bash_task_timeout_s` | `integer` | `600` | Default timeout (seconds) for background `Bash` tasks when the call omits `timeout`; also used to re-arm foreground commands moved to the background on timeout. `0` means no timeout — the task runs until it exits or the model stops it. Explicit per-call `timeout` values are unaffected. In print mode (`kiki -p`) the default is `0` unless explicitly set |
| `print_background_mode` | `"exit" \| "drain" \| "steer"` | `"steer"` | Print mode (`kiki -p`) only. Governs how pending background tasks are handled once the main agent's turn ends: `"exit"` exits immediately; `"drain"` waits for every background task to reach a terminal state before exiting (results are not fed back to the main agent); `"steer"` stays alive so a completing background task — like a background subagent — injects a synthetic user message that steers the main agent into a new turn, looping until a turn ends with no pending background tasks or a limit is hit. Takes precedence over the `keep_alive_on_exit` print fallback |
| `print_wait_ceiling_s` | `integer` | `2147483` | In print mode (`kiki -p`), the wall-clock ceiling (seconds) for the wait/steer loop when `print_background_mode` is `"drain"` or `"steer"` (the default is ~24.8 days — effectively unbounded). Has no effect outside print mode or when it is `"exit"` |
| `print_max_turns` | `integer` | `100000` | In print mode (`kiki -p`) with `print_background_mode = "steer"`, the maximum number of new turns that may be triggered by background-task completions, to keep the steering loop bounded (the default is effectively unbounded) |

`keep_alive_on_exit` can be overridden by the `KIKI_BACKGROUND_KEEP_ALIVE_ON_EXIT` environment variable, and `max_running_tasks` by `KIKI_BACKGROUND_MAX_RUNNING_TASKS`; both take higher priority than `config.toml`.

In print mode (`kiki -p "<prompt>"`), Kiki stays alive after the main agent's turn as long as background tasks are still pending: each completion is fed back to the main agent as a synthetic user message, steering it into a new turn (`print_background_mode = "steer"` by default), and the run exits once a turn ends with nothing pending. The loop is bounded by `print_wait_ceiling_s` and `print_max_turns`, both effectively unbounded by default. Background work is never killed by a wall-clock cap in print mode either: background `Bash` tasks default to no timeout (`bash_task_timeout_s = 0`), and subagents run without a timeout (`[subagent] timeout_ms = 0`), so only the model itself stops a task. Set `print_background_mode` to `"drain"` to wait for tasks without feeding results back, or `"exit"` to end the run as soon as the main agent finishes.

## `subagent`

`subagent` controls how spawned subagents (`AgentRun`) run.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `default_profile` | `string` | built-in general-purpose prompt | Explicit profile override when `AgentRun` omits `profile`, `route`, and `profile_file`. If the key is absent, including from a partial `[subagent]` table, `AgentRun` uses the built-in general-purpose subagent prompt without loading a catalog profile. Set `""` to require an explicit target (strict mode) |
| `deny_models` | `string[]` | — | Denylist applied to every subagent model binding after alias resolution, whether the alias came from the dispatch or from a profile pin |
| `allowed_tools` | `string[]` | `[]` | Exact tool names to allow past the native subagent default restriction. Currently applies to `BoardRead` and `BoardWrite`; it does not override profile allowlists, denylists, or other policy limits |
| `max_direct_children` | `integer` | `16` | Maximum simultaneous dispatched child runs per caller, including startup and cancellation; `0` disables this limit |
| `max_total_subagents` | `integer` | `0` | Maximum simultaneous dispatched subagent runs throughout one session tree, including grandchildren and deeper descendants but not main; `0` disables this limit |
| `timeout_ms` | `integer` | `7200000` (2 hours) | Maximum wall-clock time (milliseconds) a single subagent (`AgentRun`) is allowed to run before it is settled as `timed_out`. `0` means no timeout — the subagent runs until it finishes or the model stops it. This is the background-task manager's per-task timeout for each subagent task, so it applies to both foreground and background subagents. In print mode (`kiki -p`) the default is `0` unless explicitly set. Note: any value above `2147483647` (about 24.8 days) is clamped to roughly 24.8 days by the runtime |

Native subagents are denied `BoardRead` and `BoardWrite` by default. To allow either tool, name it explicitly in the subagent profile's [`tools`](../customization/agents.md#agent-file-format) list, or set a server default in `config.toml`:

```toml
[subagent]
allowed_tools = ["BoardRead"]
```

Omitting `tools` or using `*` does not opt in. `allowed_tools = []` removes server opt-ins without removing explicit profile entries. Profile allowlists, `disallowedTools`, disabled tool groups, caller restrictions, global and session policy, feature flags, Plan mode, and invocation approval still apply. Cron, thread, Plan-entry/exit, question, and goal tools remain main-only; these opt-ins cannot open them. MCP tools, inherited user tools, and other extensions keep their existing defaults. External executors control their own tools.

Tool lists in profile descriptions and settings are configuration previews, not guarantees of runtime availability. Features, the child runtime, and approval can still prevent a call.

`timeout_ms` can be overridden by the `KIKI_SUBAGENT_TIMEOUT_MS` environment variable, which takes higher priority than `config.toml`. There are no environment variables for `allowed_tools`, `deny_models`, or the two concurrency limits.

The limits are global configuration defaults, but counts are isolated to each session. Idle and historical children do not count. A running descendant still counts after its parent finishes; resuming a child takes an execution slot without creating another agent. Admission reserves capacity before asynchronous startup and releases it after startup failure or execution completion. Exceeding either limit immediately returns `dispatch.limit_exceeded` with `layer`, `current`, `limit`, and `owner` (REST business code `42904`); it does not queue work or stop another agent. Wait for an active run to finish or explicitly raise the relevant configuration limit. Automatic task-completion wakeups obey the same limits. If a wakeup is rejected, the finished task and its output remain available through `TaskOutput`; the notification is not marked delivered.

## `agents`

This strict section controls the boolean gates for [delegation notices](../customization/agents.md). Unknown keys are configuration errors.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | Accepted for configuration compatibility; currently controls no behavior |
| `notify_parent` | `boolean` | `true` | Permits the subagent-only `AgentNotify` tool, which queues a fire-and-forget message in the parent agent's mailbox. Set to `false` to withhold the tool from every subagent |

`[agents.delegation]` is a nested table. Both slots accept booleans only. `false` skips that notice and always wins over any prompt field override; omitting a slot or setting it to `true` keeps the notice enabled.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `sub` | `boolean` | `true` | Enables the notice injected when this profile runs as a dispatched subagent |
| `independent` | `boolean` | `true` | Enables the notice for an MCP / SDK host invocation with no parent agent |

To replace notice text, override `delegation.sub.notice` or `delegation.independent.notice` under [`PromptOverrides`](#prompt). The former string path values are removed and fail strict parsing; move their file contents into an external prompt-override TOML `[fields]` entry.

## `thread_communication`

This strict section controls [local peer-thread communication](../customization/agents.md#peer-thread-communication). It is disabled by default and has no environment-variable override.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `false` | Permits the four main-Agent peer-thread tools and local REST and Klient thread operations. Set to `true` to enable those operations globally |

Per-workspace overrides are persisted separately and managed through the local REST API or Klient. An override can disable one workspace while the global switch remains on, but cannot enable communication while this global switch is off.

## `mcp`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `startup_timeout_ms` | `integer` | `30000` (30 seconds) | Global default connection (startup + tool discovery) timeout in milliseconds for all MCP servers. Accepts `1`–`2147483647`. A per-server `startupTimeoutMs` in `mcp.json` always wins over this section and the environment variable; when neither is set, the default applies |
| `tool_timeout_ms` | `integer` | `60000` (60 seconds) | Global default single tool-call timeout in milliseconds for all MCP servers. Accepts `1`–`2147483647`. A per-server `toolTimeoutMs` in `mcp.json` always wins over this section and the environment variable; when neither is set, the client built-in default applies |

`startup_timeout_ms` and `tool_timeout_ms` can be overridden by the `KIKI_MCP_STARTUP_TIMEOUT_MS` and `KIKI_MCP_TOOL_TIMEOUT_MS` environment variables respectively, which take higher priority than `config.toml`. See [MCP](../server/mcp.md) for the full MCP server configuration.

## `identity`

Customizes how the agent identifies itself. By default, upstream requests use the `kiki-cli` product without claiming a custom name or slug.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | — | Display name the agent calls itself in the system prompt (fills the `${product_name}` slot, including in your own `SYSTEM.md` and agent files) |
| `slug` | `string` | derived from `name` | Machine identifier used in protocol fields: the `User-Agent` product token sent to third-party providers, and the client name announced to MCP servers. Derived from `name` when omitted: lowercased, with every run of non-alphanumeric characters folded to `-` |
| `advertise_as_kimi_code` | `boolean` | `false` | Send `kimi-code-cli` as the upstream `User-Agent` product for Kimi Code compatibility, overriding the `slug` for upstream HTTP requests. By default, Kiki identifies itself as `kiki-cli` |

```toml
[identity]
name = "Acme Dev Agent"
slug = "acme-dev"              # optional
advertise_as_kimi_code = false
```

`name` and `slug` can be set through the `KIKI_IDENTITY_NAME` and `KIKI_IDENTITY_SLUG` environment variables, which take higher priority than `config.toml` and are never written back to it — convenient for containers and CI, where writing a config file is awkward.

A name that contains no ASCII letters or digits (for example a purely Chinese name) leaves nothing to derive a slug from and falls back to `agent`; write `slug` explicitly if you need a specific protocol token.

The identity is resolved once at startup and holds for the life of the process — it is announced to MCP servers and providers when connections are made, so it cannot change midway. Edits to this section take effect on the next start, for new sessions: a resumed session keeps the system prompt it was recorded with, since its past turns already speak under that identity. Likewise, an MCP OAuth authorization keeps the client registration it was granted under; reset that server's authentication to register under the new identity.
## `tools`

`tools` is the global tool switch: it applies to every agent in all sessions and intersects with each agent's own `tools` / `disallowedTools` policy.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `array<string>` | — | Global allowlist: when non-empty, only the listed tools are available; omitting the field or setting an empty array imposes no constraint |
| `disabled` | `array<string>` | — | Global denylist, applied after `enabled` |

Name matching follows the same rules as the same-named fields in an agent file: built-in tools match by exact name (such as `Read`), and MCP tools match with globs (such as `mcp__github__*`). Three entry shapes never match anything and are reported with a warning: a wildcard outside an `mcp__` pattern (`enabled = ["*"]` disables every tool, `disabled = ["*"]` disables none), an `mcp__` literal missing the tool segment (`mcp__github` — use `mcp__github__*` for a whole server), and a name no registered or built-in tool has (matching is case-sensitive).

```toml
[tools]
disabled = ["EnterPlanMode", "ExitPlanMode", "mcp__github__*"]
```

::: warning Note
Like the `tools` / `disallowedTools` fields of an agent file, this section shapes the tools shown to the model and is enforced again before execution. [Permission rules](#permission) remain a separate control for operations that require approval.
:::

## `image`

`image` controls how images are compressed before being sent to the model, across every ingestion point (pasted images, `ReadMediaFile` reads, images in MCP tool results, and so on).

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `max_edge_px` | `integer` | `2000` | Longest-edge ceiling in pixels. Larger images are scaled down proportionally to fit; raising it preserves more detail at the cost of larger request bodies |
| `read_byte_budget` | `integer` | `262144` (256 KB) | Per-image byte budget for images the model reads for itself (`ReadMediaFile` default reads). It bounds the accumulated request-body size when the model keeps screenshotting and reading images; fine detail stays reachable through the `region` parameter, which reads a crop back at full fidelity (`region` and `full_resolution` are not subject to this budget) |

`max_edge_px` can be overridden by the `KIKI_IMAGE_MAX_EDGE_PX` environment variable and `read_byte_budget` by `KIKI_IMAGE_READ_BYTE_BUDGET`; both take higher priority than `config.toml`.

Which image formats reach the model depends on the provider the request resolves to. Every provider accepts PNG, JPEG, GIF, and WebP; the Kimi provider additionally accepts BMP, HEIC, and HEIF, so an iPhone photo needs no conversion first. Any other image is replaced by a text notice that names the formats the current provider accepts.

## `session_title`

`session_title` chooses how AI session titles are written.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | `string` | unset | Model alias used to write session titles. Unset (or empty) keeps title generation on the managed `chat_title` tool, whose usage is included in the subscription; setting an alias runs the same title-prompt budgets through that model instead |

Automatic title generation is on by default. Turn it off in the GUI, with `auto_session_title = false` under `[experimental]`, or with `KIKI_EXPERIMENTAL_AUTO_SESSION_TITLE=0`.

## `experimental`

`experimental` stores persistent overrides for experimental-feature flags, keyed by flag id. Each flag's precedence, highest first: its `KIKI_EXPERIMENTAL_<NAME>` environment variable, this section, the `KIKI_EXPERIMENTAL_FLAG` master switch, then the flag's built-in default.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `auto_session_title` | `boolean` | `true` | Whether an AI session title is generated automatically; see [`session_title`](#session-title) |

Other registered flags can also be overridden here by id, but `auto_session_title` is currently the only user-facing entry.

## `nb_search`

`nb_search` configures Kiki's built-in search and retrieval module — the capability behind the `WebSearch` and `FetchURL` tools. The module is part of the product: it ships with Kiki and needs no separate installation, and its provider instances, credential slots, lanes, and default fetch chain are built in.

Beyond those built-in defaults you supply the credential for the provider you choose, through the environment variable named in its credential slot, and name a default search lane so `WebSearch` runs without an explicit lane argument. Field names and merge behavior follow the module's canonical configuration contract, shared with the standalone nb-search CLI, so an existing nb-search configuration file applies without translation.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `provider_instances` | `table` | No | Named provider instances with `provider_id`, `enabled`, optional `credential_slot_id` / `base_url`, and provider-specific `options` |
| `credential_slots` | `table` | No | Named credential slots containing only `provider_id` and the environment-variable name in `env` |
| `lanes` | `table` | No | Named operation lanes with `provider_instance_id`, `operation_id`, `latency`, `cost`, and optional `evidence_groups` |
| `defaults.search_lane` | `string` | No | Default lane selected by `WebSearch`; without it, web search fails closed |
| `defaults.fetch_chain` | `array<table>` | No | Fetch pipeline chain by input kind and representation; the built-in default for URLs is `direct.fetch` followed by `jina.reader` |
| `execution` | `table` | No | Provider-call, concurrency, retry, timeout, inline-output, response-size, redirect, content-size, and quality budgets |

Credential values are never stored in `config.toml`. This is a deliberate exception to the [provider credential](#providers) design, where `api_key` sits in the config file: search-module credentials live in the server process environment instead — each credential slot only names the environment variable in its `env` field, and the value itself is never written into `config.toml`. The Kiki server process environment takes precedence, including an explicitly empty value. When local reuse is enabled, Kiki can fill missing variables from the local nb-search `secrets.json` under the server's `NB_SEARCH_HOME` (default: `~/.nb-search`). It only imports variables for matching credential slots and checks the provider, endpoint, slot, and file protection before use. Changes that redirect imported credentials are rejected rather than silently rebinding them. The module does not read variables from another terminal or automatically load separate `.env` files. Neither secret values nor the credential file are sent to the GUI.

By default, settings are layered in this order: the module's built-in defaults, the server's local nb-search configuration, the server environment, then Kiki's `[nb_search]` overrides. The local file is selected by `NB_SEARCH_CONFIG`, or by `config.json` under `NB_SEARCH_HOME` (default: `~/.nb-search`). A missing default file is allowed; an explicit path that is missing or unreadable makes that source unavailable.

Use **Settings → Search & retrieval → Overview & source** to inspect the source and control reuse, or set the separate host option:

```toml
[nb_search_source]
reuse_local_config = false
```

`reuse_local_config` defaults to `true`. Setting it to `false` skips the server's local nb-search configuration and credential files — the built-in module keeps running on Kiki's own settings and built-in defaults — without editing the skipped files or removing Kiki's saved settings and credential environment. Isolated default search storage lives under Kiki's cache; explicit `nb_search.home` and `nb_search.jobs_root` settings still take precedence. Changes apply on the next runtime request without a restart. Saving the source selection does not guarantee that a search lane is ready; check the reported source and tool readiness separately. When connected to a remote Kiki server, these files and environment variables belong to that server, not the browser's machine.

```toml
[nb_search.credential_slots."exa.default"]
provider_id = "exa"
env = "NB_SEARCH_EXA_API_KEY"

[nb_search.defaults]
search_lane = "exa.search"

[nb_search.execution]
max_provider_calls = 16
max_concurrency = 4
retry_count = 1
search_timeout_ms = 30000
fetch_timeout_ms = 60000
max_inline_bytes = 65536

[nb_search.execution.fetch]
max_source_bytes = 2097152
max_response_bytes = 2097152
max_content_chars = 200000
max_redirects = 5
```

## `permission`

`permission` sets permission rules that are automatically loaded when a session starts, controlling whether the Agent needs user confirmation before calling a tool. Rules are written as a `[[permission.rules]]` array of tables, matched in order — the first matching rule takes effect.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `decision` | `string` | Yes | Action on match: `allow` (permit immediately), `deny` (reject immediately), `ask` (prompt each time) |
| `scope` | `string` | No | Rule scope: `turn-override`, `session-runtime`, `project`, `user`; defaults to `user` |
| `pattern` | `string` | Yes | Match pattern in the form `ToolName` or `ToolName(arg-pattern)`, e.g. `Read` or `Bash(rm -rf*)` |
| `reason` | `string` | No | Rule description for debugging and auditing |

Built-in tool names are listed in [Built-in tools](../reference/tools.md). Most built-in tools that accept rule arguments define their own matching subject, such as `Bash(command-pattern)` or `Read(path-pattern)`. MCP tools and custom tools can only be matched by tool name — argument patterns are not supported for them.

```toml
[[permission.rules]]
decision = "allow"
pattern = "Read"

[[permission.rules]]
decision = "allow"
pattern = "Grep"

[[permission.rules]]
decision = "deny"
pattern = "Bash(rm -rf*)"

[[permission.rules]]
decision = "ask"
pattern = "Bash"
```

### Dangerous Bash commands

`permission.dangerous_bash` is a three-state opt-in for the tree-sitter Bash analyzer that flags destructive commands such as `rm -rf`, `shutdown`, `dd` to a block device, and nested wrappers like `sudo` / `bash -c`. When the guard is on, a command that would otherwise be auto-approved is upgraded to `ask` and uses the existing approval flow. Deny rules are unchanged. Unanalyzable commands are not upgraded.

| Value | Effect |
| --- | --- |
| `default` (unset) | On in `manual` and `auto`; off in `yolo` |
| `on` | Always upgrade dangerous Bash to `ask`, including `yolo` |
| `off` | Never intervene |

YOLO stays hands-off by default so an explicit Never Ask / yolo session is not rewritten. Set `on` only when you want the analyzer even in that mode.

```toml
[permission]
dangerous_bash = "default"
```

::: tip
MCP server declarations are configured in `~/.kiki/mcp.json` or the project-local `.kiki/mcp.json`, not in `config.toml`. The legacy `.kimi-code/mcp.json` path is not read. The interactive configuration entry point is the built-in `kiki-ops` skill (Kiki's product-usage and configuration Skill): type `/kiki-ops help me configure MCP`; see [Model Context Protocol](../server/mcp.md).
:::

## `prompt`

`prompt` overrides stable text fields without forking an agent profile. Field values replace the named text unit; they do not append, prepend, or wrap it.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `variables` | `record<string, string>` | `{}` | Named variables referenced as `${name}` from an override field. Names must match `[A-Za-z_][A-Za-z0-9_]*`; built-in runtime names are reserved and cannot be redefined here |
| `overrides` | `table` | `{}` | Global [`PromptOverrides`](#prompt-override-format), with optional `files` and `fields` |

Useful built-in field ids include `system.language`, `system.reply_style`, `system.coding`, `system.shared`, `tool.web-search.description`, `tool.web-search.guidance`, `delegation.sub.notice`, and `delegation.independent.notice`. System fields replace sections of the built-in prompt. `system.shared` is the only shared outer addition and is appended once when non-empty. A tool `description` replaces its static description while preserving runtime-generated details; its `guidance` is appended under the existing `User-configured guidance:` label when non-empty.

`${name}` substitution is a single, literal pass with no recursion or script execution. A field may use its declared built-in variables and names from `[prompt.variables]`; an unknown name is rejected. Whole-prompt composition variables such as `${base_prompt}` and `${parent_prompt}` are not allowed in fields.

```toml
[prompt.variables]
search_guidance = "Favor recent results unless the question asks for historical context."

[prompt.overrides]
files = ["prompt/team.toml"]

[prompt.overrides.fields]
"system.shared" = "When citing web sources, link the exact URL you opened."
"tool.web-search.guidance" = "Use ${search_guidance} when results span multiple years."
```

### Prompt override format

Every override surface uses the same object:

```text
files?: string[]
fields?: record<string, string>
```

Paths in `files` are relative to the Kiki home directory (`~/.kiki` by default). Absolute paths, `..` traversal, paths that escape through symbolic links, missing files, malformed TOML, duplicate keys, and unknown field ids fail validation. Each external file is strict TOML with `schema_version = 1` and one `[fields]` table; it cannot include other files:

```toml
schema_version = 1

[fields]
"system.language" = "Reply in the user's language unless they request another language."
"tool.web-search.description" = "Search public web sources through Kiki's configured search runtime."
```

Within one surface, files are applied in listed order and inline `fields` apply last. Across surfaces, precedence from low to high is global `[prompt.overrides]`, model `[models."<alias>".prompt_overrides]`, agent or `SYSTEM.md` frontmatter `prompt_overrides`, then the matching `model_profiles[].prompt_overrides`. A missing key inherits the lower value; an empty string explicitly clears only fields that allow empty values.

```toml
[models.fast-model.prompt_overrides]
files = ["prompt/fast-model.toml"]

[models.fast-model.prompt_overrides.fields]
"system.reply_style" = "Keep answers compact and action-oriented. ${reply_style_guide}"
```

For agent and `SYSTEM.md` frontmatter, use the equivalent YAML mapping:

```yaml
prompt_overrides:
  files:
    - prompt/reviewer.toml
  fields:
    system.coding: Prefer minimal, verified patches.
```

The active profile, model, field registry, configuration, and loaded override files are frozen for each turn when its first model request is prepared. A valid watched-file update applies on the next turn, never halfway through the current turn. If a refresh fails, Kiki reports `prompt-fields-refresh-failed` and keeps the last valid snapshot rather than partially applying the broken update.

A whole-body `SYSTEM.md` or agent replacement, or a model cognition `replace`, shadows the corresponding `system.*` fields. A cognition anchor is sent byte-for-byte, so system and delegation fields are inactive while the anchor applies; tool fields remain effective. These statuses are diagnostic only and are never inserted into the prompt.

::: warning Removed
The old `[prompt] shared` and `[prompt.tools]` keys have been removed and now fail strict configuration parsing. Move `shared` to the `"system.shared"` key under `[prompt.overrides.fields]`; move each tool entry to `tool.<kebab-case-name>.guidance` (for example, `WebSearch` becomes `tool.web-search.guidance`).
:::

In the desktop GUI, open **Settings → Agents → Prompt** to edit this section. The card is collapsed by default — expand it before editing.

## `tui.toml`

Alongside `config.toml`, the CLI keeps terminal-UI and client preferences in a companion `tui.toml` in the same directory (`~/.kiki/tui.toml`, or `$KIKI_HOME/tui.toml` when overridden). It is created with defaults on first run, and the interactive commands `/config`, `/theme`, and `/editor` write to it for you — so you rarely need to edit it by hand. If the file is malformed, the CLI falls back to defaults and shows a notice instead of failing to start.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `theme` | `string` | `auto` | Color theme: `auto` (follow the terminal), `dark`, `light`, or the name of a [custom theme](../customization/themes.md) |
| `render_latex` | `boolean` | `true` | Render LaTeX math expressions (`$…$`, `$$…$$`) in Markdown messages as Unicode text; `false` keeps the raw source |
| `disable_paste_burst` | `boolean` | `false` | Disable the non-bracketed paste-burst fallback that keeps rapid multi-line pastes from submitting line by line |
| `cache_expiry_hint` | `boolean` | `true` | Show a dialog when resuming a long-idle session or submitting after a long idle stretch, warning that the context cache has likely expired and offering to compact or start a new session |
| `[editor].command` | `string` | `""` | External editor command for composing long input; empty falls back to `$VISUAL` / `$EDITOR` |
| `[notifications].enabled` | `boolean` | `true` | Whether desktop notifications are sent |
| `[notifications].notification_condition` | `string` | `unfocused` | When to notify: `unfocused` (only when the terminal is not focused) or `always` |
| `[status_line].items` | `string[]` | `[]` | Built-in slots to show on the first footer line and their order: `mode`, `goal`, `model`, `tasks`, `cwd`, `git`, `tips`. Unset keeps the default layout; unknown ids are skipped with a warning |
| `[status_line].command` | `string` | `""` | Custom status line command. Its first stdout line replaces the first footer line, with a JSON snapshot (model, cwd, git branch, permission mode, plan mode, context usage, session id, version) passed on stdin. Runs are capped at 300ms and throttled to once per second; failures fall back to the built-in layout |

```toml
# ~/.kiki/tui.toml
theme = "auto" # "auto" | "dark" | "light" | custom theme name
render_latex = true # false keeps LaTeX math in messages as raw source
disable_paste_burst = false # true disables non-bracketed paste-burst fallback
cache_expiry_hint = true # false disables the "cache expired" dialog on resume / idle submit

[editor]
command = "" # empty uses $VISUAL / $EDITOR

[notifications]
enabled = true
notification_condition = "unfocused" # "unfocused" | "always"

# [status_line]
# items = ["mode", "goal", "model", "tasks", "cwd", "git", "tips"]
# command = "~/.kiki/statusline.sh"
```

Changes apply on the next start, or immediately with `/reload-tui` (which reloads only `tui.toml`); `/reload` reloads both `config.toml` and `tui.toml`.

## Project-local configuration

In addition to the user-level files under `~/.kiki`, Kiki reads a project-local configuration file at `<project-root>/.kiki/local.toml`. It holds settings that are specific to one project checkout and typically should not be shared with teammates. The legacy `.kimi-code/local.toml` path is not read.

The file is created automatically when you add an extra workspace directory with [`/add-dir`](../reference/slash-commands.md) and choose to remember it for the project. You rarely need to edit it by hand. The directories recorded here only load when the workspace is trusted: an untrusted checkout does not read `additional_dir` at startup, and persisting a new directory requires trusting the workspace first.

### `[workspace]`

The `[workspace]` table groups project-level workspace settings:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `additional_dir` | `array<string>` | No | Additional workspace directories, stored as absolute paths. Written automatically when you confirm "remember this directory" in `/add-dir`; read back on startup so the directories are available in every session of this project. Only loaded for a trusted workspace |

```toml
[workspace]
additional_dir = ["/absolute/path/to/shared"]
```

Because directories are stored as absolute paths, which are specific to your machine, we recommend adding `.kiki/local.toml` to your project's `.gitignore` so it is not committed.

## Next steps

- [Providers and models](./providers.md) — connection examples for each provider type (Kimi, Claude, OpenAI, Gemini)
- [Config overrides](./overrides.md) — priority rules for CLI options, config file, and environment variables
- [Environment variables](./env-vars.md) — complete list of runtime variables like `KIKI_HOME`
