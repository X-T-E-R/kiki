# Environment variables

Kiki uses environment variables to control a small number of runtime behaviors — relocating the data directory and temporarily switching models without touching the config file.

Kiki-owned runtime controls use the `KIKI_*` prefix. Provider credential key names such as `KIMI_API_KEY` and `KIMI_BASE_URL` remain upstream-facing and are documented separately. Treat the exact names listed on this page as authoritative.

::: warning Important: API keys are not configured here
Credential variables such as `KIMI_API_KEY`, `ANTHROPIC_API_KEY`, and `OPENAI_API_KEY` are **not** read automatically from shell environment variables. Running `export KIMI_API_KEY=xxx` in the terminal does not give any provider its key — they must be written in `config.toml` under `[providers.<name>]` or the `[providers.<name>.env]` sub-table.

The only exception is the `KIKI_MODEL_*` family, which is an explicit channel that *does* read credentials from the shell — see [Define a model from environment variables](#define-a-model-from-environment-variables-kiki-model).

For background, see [Config overrides: provider credentials](./overrides.md#provider-credentials).
:::

## Core paths

### `KIKI_HOME`

Overrides the data root directory; the default is `~/.kiki`. Once set, the config file, sessions, logs, OAuth credentials, and all other data land under the new path:

```sh
export KIKI_HOME="/path/to/custom/kiki"
```

> Make sure the directory is writable. Multiple `kiki` instances sharing the same `KIKI_HOME` will share config and credential files.

For the complete data directory structure, see [Data locations](./data-locations.md).

### `KIKI_MODEL_*` family

Switch models temporarily without modifying `config.toml` — when `KIKI_MODEL_NAME` is set, the CLI synthesizes a temporary provider in memory; the change does not persist after restart. See [Define a model from environment variables](#define-a-model-from-environment-variables-kiki-model).

## Provider credential key names (written in config.toml)

The key names below are not read directly from the shell — they are key names written inside the `[providers.<name>.env]` sub-table of `config.toml`, serving as fallback values for `api_key` / `base_url`. The CLI reads only from the config file, not from `process.env`.

This design lets you keep familiar key name conventions while centralizing secret management in the config file:

```toml
[providers.kimi.env]
KIMI_API_KEY = "sk-xxx"
KIMI_BASE_URL = "https://api.moonshot.ai/v1"
```

Key names per provider:

| Key | Applicable provider | Default |
| --- | --- | --- |
| `KIMI_API_KEY` | Kimi / Moonshot | None |
| `KIMI_BASE_URL` | Kimi / Moonshot | `https://api.moonshot.ai/v1` |
| `ANTHROPIC_API_KEY` | Anthropic | None |
| `ANTHROPIC_BASE_URL` | Anthropic | Follows Anthropic SDK default |
| `OPENAI_API_KEY` | OpenAI (`openai` and `openai_responses`) | None |
| `OPENAI_BASE_URL` | OpenAI (`openai` and `openai_responses`) | `https://api.openai.com/v1` |
| `GOOGLE_API_KEY` | Google GenAI, Vertex AI | None |
| `GOOGLE_GEMINI_BASE_URL` | Google GenAI (`google-genai`) | `https://generativelanguage.googleapis.com` |
| `GOOGLE_VERTEX_BASE_URL` | Vertex AI (`vertexai`) | SDK regional default `*-aiplatform.googleapis.com` host |
| `VERTEXAI_API_KEY` | Vertex AI | None |
| `GOOGLE_CLOUD_PROJECT` | Vertex AI | None |
| `GOOGLE_CLOUD_LOCATION` | Vertex AI | None |

::: warning
`GOOGLE_APPLICATION_CREDENTIALS` (path to a service account JSON file) is the only exception that goes through the system environment variable mechanism — it is read by the Google SDK directly via the standard ADC flow, and the CLI does not participate. All other key names must be placed in the `[providers.<name>.env]` sub-table to take effect.
:::

For the full provider type and field reference, see [Providers and models](./providers.md).

## OAuth and managed services

This group of variables redirects OAuth authentication and managed service endpoints to a self-hosted or test environment. They are not needed for everyday use.

| Variable | Purpose | Default |
| --- | --- | --- |
| `KIKI_CODE_OAUTH_HOST` | OAuth auth host; highest priority | Falls back to `KIKI_OAUTH_HOST` when unset |
| `KIKI_OAUTH_HOST` | OAuth auth host; fallback for `KIKI_CODE_OAUTH_HOST` | Falls back to `https://auth.kimi.com` when unset |
| `KIKI_CODE_BASE_URL` | Managed API base URL used after OAuth login | `https://api.kimi.com/coding/v1` |

::: warning
`KIKI_CODE_BASE_URL` (OAuth-managed service, targeting `kimi.com`) and `KIMI_BASE_URL` (direct API key connection, targeting `moonshot.ai`) are two distinct variables. Use each one in its appropriate context.
:::

## Define a model from environment variables (`KIKI_MODEL_*`)

Want to switch models for testing without touching `config.toml`? When `KIKI_MODEL_NAME` is set, the CLI synthesizes a temporary provider and model alias from the `KIKI_MODEL_*` variables in memory — nothing is written back to the config file. These variables take priority over `default_model` in `config.toml`, but the `-m <alias>` option at startup still has the highest priority.

```sh
export KIKI_MODEL_NAME="kimi-for-coding"
export KIKI_MODEL_API_KEY="YOUR_API_KEY"
export KIKI_MODEL_BASE_URL="https://api.example.com/v1"
export KIKI_MODEL_MAX_CONTEXT_SIZE="262144"
export KIKI_MODEL_CAPABILITIES="image_in,thinking"
kiki
```

Complete variable list:

| Variable | Required | Purpose | Default |
| --- | --- | --- | --- |
| `KIKI_MODEL_NAME` | Yes (also the enable switch) | Model id sent to the API | — |
| `KIKI_MODEL_API_KEY` | Yes | API key | — |
| `KIKI_MODEL_PROVIDER_TYPE` | No | Provider type: `kimi`, `anthropic`, `openai` | `kimi` |
| `KIKI_MODEL_BASE_URL` | No | API base URL | Each type has its own default |
| `KIKI_MODEL_MAX_CONTEXT_SIZE` | No | Maximum context length (tokens) | `262144` (256 K) |
| `KIKI_MODEL_CAPABILITIES` | No | Comma-separated capability tags, unioned with auto-detected capabilities | `image_in,thinking` |
| `KIKI_MODEL_DISPLAY_NAME` | No | Name shown in `/model` | Falls back to `KIKI_MODEL_NAME` |
| `KIKI_MODEL_MAX_OUTPUT_SIZE` | No | Per-request output cap (`anthropic` only); when set, overrides the built-in Claude ceiling | Model default |
| `KIKI_MODEL_REASONING_KEY` | No | Reasoning field name override (`openai` only) | Auto-detected |
| `KIKI_MODEL_THINKING_EFFORT` | No | Thinking effort for the synthesized temporary model: `low`/`medium`/`high`/`xhigh`/`max`; only read when `KIKI_MODEL_NAME` is set (distinct from the same-named runtime switch below) | — |
| `KIKI_MODEL_ADAPTIVE_THINKING` | No | Force adaptive thinking on or off (`anthropic` only) | Inferred from model name |

If `KIKI_MODEL_NAME` is set but a required variable is missing, startup fails immediately with a clear error message.

Note that `KIKI_MODEL_THINKING_EFFORT` is read in two independent places: here, to set the temporary model's effort when `KIKI_MODEL_NAME` is set; and as a global runtime switch (below) that forces the effort on the wire for every `kimi`-provider request, regardless of `KIKI_MODEL_NAME`.

## Runtime switches

Switches that control the behavior of subsystems such as background tasks, the built-in search and retrieval module, and the plugin marketplace:

| Variable | Purpose | Valid values |
| --- | --- | --- |
| `KIKI_PASSWORD` | Set a parallel auth credential for the `kiki web` local server, valid alongside the bearer token; recommended when binding the server beyond loopback — see [Local server and API](../server/local-server.md#authentication) | Any non-empty string; when unset, only the token is valid |
| `KIKI_BACKGROUND_KEEP_ALIVE_ON_EXIT` | Whether to keep background tasks when the session closes; takes higher priority than `config.toml`. The default is to stop them on exit | Truthy: `1`/`true`/`yes`/`on`; falsy: `0`/`false`/`no`/`off` |
| `KIKI_BACKGROUND_MAX_RUNNING_TASKS` | Cap on concurrently running background tasks; takes higher priority than `[background] max_running_tasks` in `config.toml` (unset means no cap) | Positive integer; invalid values are ignored |
| `KIKI_IMAGE_MAX_EDGE_PX` | Longest-edge ceiling (px) for image compression; takes higher priority than `[image] max_edge_px` in `config.toml` (default `2000`) | Positive integer; invalid values are ignored |
| `KIKI_IMAGE_READ_BYTE_BUDGET` | Per-image byte budget for model-initiated image reads (`ReadMediaFile` default reads); takes higher priority than `[image] read_byte_budget` in `config.toml` (default `262144`, i.e. 256 KB) | Positive integer; invalid values are ignored |
| `KIKI_PLUGIN_MARKETPLACE_URL` | Set the plugin marketplace JSON loaded by `/plugins`; takes priority over `[plugins] marketplace_url` | `http://` or `https://` URL, `file://` URL, or local path; unset or blank does not load a remote catalog |
| `KIKI_SUBAGENT_TIMEOUT_MS` | Maximum wall-clock time (ms) a single subagent (`AgentRun`) may run; takes higher priority than `[subagent] timeout_ms` in `config.toml` (default `7200000`, i.e. 2 hours) | Positive integer; invalid values fall back to the config or default |
| `KIKI_IDENTITY_NAME` | Display name the agent calls itself in the system prompt; takes higher priority than `[identity] name` in `config.toml` and is never written back to it | Any non-empty string; blank values read as unset |
| `KIKI_IDENTITY_SLUG` | Protocol identifier for the `User-Agent` product token sent to third-party providers and the MCP client name; takes higher priority than `[identity] slug`. Derived from the name when unset | Any non-empty string; normalized to lowercase with non-alphanumeric runs folded to `-` |
| `KIKI_BUILTIN_PRODUCT_SKILLS` | Whether the built-in skills documenting Kiki itself are offered to the model; takes higher priority than `builtin_product_skills` in `config.toml` (default enabled) | Truthy: `1`/`true`/`yes`/`on`; falsy: `0`/`false`/`no`/`off` |
| `KIKI_TUI_FULL_SCREEN` | Enable the experimental fullscreen alternate-screen UI: scrollable transcript viewport, mouse text selection, clickable links, and Ctrl-Shift-F transcript search | `1` enables it; anything else keeps the regular inline UI |
| `KIKI_EXPERIMENTAL_TASK_WAIT` | Whether the model is given the `TaskWait` tool, which waits for background tasks inside the current turn instead of ending it (enabled by default) | Truthy: `1`/`true`/`yes`/`on`; falsy: `0`/`false`/`no`/`off` |
| `KIKI_MCP_CONFIG_PATH` | MCP config file injected by an external orchestrator and loaded read-only by the server started via `kiki web`. Must be set together with `KIKI_MCP_AGENT_PROFILE_HOME` and `KIKI_MCP_CONFIG_READ_ONLY`; an incomplete set fails startup | Absolute path |
| `KIKI_MCP_AGENT_PROFILE_HOME` | Agent-profile root directory injected by an external orchestrator, used together with `KIKI_MCP_CONFIG_PATH`; the three `KIKI_MCP_*` catalog variables must always be set as a set | Absolute path |
| `KIKI_MCP_CONFIG_READ_ONLY` | Read-only marker for the injected catalog; must be `1` — the server never writes back to the injected config or profiles | `1` |
| `KIKI_MCP_STARTUP_TIMEOUT_MS` | Global default connection timeout (ms) for all MCP servers; takes higher priority than `[mcp] startup_timeout_ms` in `config.toml`, but a per-server `startupTimeoutMs` in `mcp.json` still wins (default `30000`) | Integer from `1` to `2147483647`; invalid values are ignored |
| `KIKI_MCP_TOOL_TIMEOUT_MS` | Global default single tool-call timeout (ms) for all MCP servers; takes higher priority than `[mcp] tool_timeout_ms` in `config.toml`, but a per-server `toolTimeoutMs` in `mcp.json` still wins (default `60000`) | Integer from `1` to `2147483647`; invalid values are ignored |
| `KIKI_LOOP_MAX_STEPS_PER_TURN` | Maximum Agent steps per turn; takes higher priority than `[loop_control] max_steps_per_turn` in `config.toml` (unset or `0` means unlimited) | Non-negative integer; invalid values are ignored |
| `KIKI_LOOP_MAX_ATTEMPTS_PER_STEP` | Maximum total attempts for a failing step (including the initial attempt); takes higher priority than `[loop_control] max_attempts_per_step` in `config.toml` (default `5`) | Non-negative integer; invalid values are ignored |
| `KIKI_INFINITE_RETRY` | Retry every failed LLM request indefinitely — turn steps and background operations such as compaction alike — instead of failing the task; waits use exponential backoff (capped at 32 s) and honor the server's `Retry-After` header, and aborting still cancels immediately. Intended for long-running unattended evaluations against endpoints that may fail temporarily | Truthy: `1`/`true`/`yes`/`on`; falsy: `0`/`false`/`no`/`off` |
| `KIKI_TOKEN_COUNTING_STRATEGY` | Which context token count is reported externally (the context-size display); takes higher priority than `[token_counting] strategy` in `config.toml` (default `measured+estimated`) | `measured+estimated`, `measured`, `estimated` (case-insensitive); invalid values are ignored |
| `NB_SEARCH_CONFIG` | Path to a canonical JSON configuration for the built-in search and retrieval module, loaded before Kiki's `[nb_search]` patch | File path |
| `NB_SEARCH_HOME` | Data directory for the built-in search and retrieval module | Directory path |
| `NB_SEARCH_JOBS_ROOT` | Durable job directory for the built-in search and retrieval module | Directory path |
| `NB_SEARCH_LOG_LEVEL` | Log level for the built-in search and retrieval module | `error`, `warn`, `info`, or `debug` |
| `NB_SEARCH_RETENTION_HOURS` | Retention period for durable search and fetch job results | Positive integer |
| `NB_SEARCH_EXA_API_KEY` | Credential used by the built-in `exa.default` provider instance | Non-blank string |
| `NB_SEARCH_TAVILY_API_KEY` | Credential used by the built-in `tavily.default` provider instance | Non-blank string |
| `NB_SEARCH_JINA_API_KEY` | Optional credential used by the built-in `jina-reader.default` fetch provider instance | Non-blank string |
| `KIKI_EXPERIMENTAL_AUTO_SESSION_TITLE` | Whether an AI session title is generated automatically once the first turn completes; takes precedence over the `[experimental]` entry and `KIKI_EXPERIMENTAL_FLAG` (default on) — see [`session_title`](./config-files.md#session-title) | Enable: `1`/`true`/`yes`/`on`; disable: `0`/`false`/`no`/`off` |
| `KIKI_EXPERIMENTAL_FLAG` | Enable all registered experimental features for this process; a per-feature `KIKI_EXPERIMENTAL_<NAME>` variable or an explicit entry in the `[experimental]` section of `config.toml` takes precedence over it | `1`, `true`, `yes`, `on` |
| `KIKI_SHELL_PATH` | Override the Git Bash path on Windows (used when auto-detection fails) | Absolute path |
| `KIKI_MODEL_MAX_COMPLETION_TOKENS` | Hard cap on `max_completion_tokens` per LLM step; applies to the `kimi` provider only | Positive integer; `0` or negative disables clamping |
| `KIKI_MODEL_TEMPERATURE` | Sampling temperature for every request; applies to the `kimi` provider only (global — independent of `KIKI_MODEL_NAME`) | Number, e.g. `0.3` |
| `KIKI_MODEL_TOP_P` | Nucleus-sampling `top_p` for every request; applies to the `kimi` provider only (global) | Number, e.g. `0.95` |
| `KIKI_MODEL_THINKING_EFFORT` | Force a specific thinking effort on the wire (`thinking.effort`), bypassing the model's declared `support_efforts`; applies to the `kimi` provider only, and only while Thinking is on | An effort value, e.g. `max` |
| `KIKI_MODEL_THINKING_KEEP` | Preserved-thinking passthrough; on `kimi` sent as `thinking.keep`, on `anthropic` (Claude and Kimi's Anthropic-compatible mode) sent as a `context_management` `clear_thinking_20251015` edit (enabling keep routes Anthropic requests to the beta Messages API); overrides `[thinking] keep` (which defaults to `"all"`); only injected while Thinking is on | A value the API accepts, e.g. `all`; an off-value (`false`/`0`/`no`/`off`/`none`/`null`) disables it |
| `KIKI_DISABLE_CRON` | Disable the scheduled-task tool (`CronCreate` rejects new schedules; existing tasks do not fire) | `1` to disable |

Subagent concurrency has no environment-variable override. Configure [`[subagent]`](./config-files.md#subagent) with `max_direct_children` and `max_total_subagents`; their defaults are `16` and `0` (unlimited), respectively.

`[subagent]` previously accepted `default_model` and `default_effort`; both keys have been removed. They no longer configure anything and only produce a startup warning if present — a subagent's model comes from the dispatch or a profile pin, never from a configured default (see [`subagent`](./config-files.md#subagent)).

## Diagnostic logs

These variables control log level and file rotation, read once at process startup:

| Variable | Purpose | Default |
| --- | --- | --- |
| `KIKI_LOG_LEVEL` | Log level: `off`, `error`, `warn`, `info`, `debug` | `info` |
| `KIKI_LOG_GLOBAL_MAX_BYTES` | Maximum bytes per global log file | `6291456` (6 MB) |
| `KIKI_LOG_GLOBAL_FILES` | Number of global log files to retain | `5` |
| `KIKI_LOG_SESSION_MAX_BYTES` | Maximum bytes per session log file | `5242880` (5 MB) |
| `KIKI_LOG_SESSION_FILES` | Number of session log files to retain | `3` |

## System environment variables

The CLI also reads several standard system variables to detect the runtime environment; it does not modify them:

- `HOME`: used to resolve the default data path
- `VISUAL`, `EDITOR`: external editor command (`VISUAL` takes precedence)
- `PATH`: used to locate dependencies such as `rg`, `fd`, `fdfind`, and `git`; on Windows, Git Bash detection checks each `git.exe` found on `PATH`, including package-manager shims such as Scoop
- `NO_COLOR`, `FORCE_COLOR`: control color output (following the [no-color.org](https://no-color.org) convention)
- `CI`: when non-empty and not `"0"`, disables theme detection and falls back to the dark theme
- `TERM_PROGRAM`, `TERM`, `TMUX`: detect terminal features and notification support
- `DISPLAY`, `WAYLAND_DISPLAY`, `XDG_SESSION_TYPE`: detect Linux graphical sessions (for clipboard and image features)
- `WSL_DISTRO_NAME`, `WSLENV`: detect WSL for the clipboard PowerShell bridge
- `LOCALAPPDATA`: used on Windows as a fallback when probing for the Git Bash installation path

## HTTP proxy

Kiki honors the standard proxy environment variables for all outbound traffic — model API calls, MCP servers, web tools, sign-in, and update checks:

- `HTTP_PROXY` / `http_proxy`: proxy for `http://` requests
- `HTTPS_PROXY` / `https_proxy`: proxy for `https://` requests
- `ALL_PROXY` / `all_proxy`: fallback proxy used when the scheme-specific variable is unset; this is where a SOCKS proxy is usually set
- `NO_PROXY` / `no_proxy`: comma-separated hosts that bypass the proxy

Both HTTP(S) and SOCKS proxies are supported. A SOCKS proxy is recognized by its scheme — `socks5://`, `socks5h://`, `socks4://`, or `socks://` (an alias for `socks5://`) — and is typically set via `ALL_PROXY` (the form used by tools like Clash and V2RayN). An HTTP(S) proxy takes precedence over `ALL_PROXY` for HTTP/HTTPS traffic.

The proxy is applied only when one of these variables is set; otherwise connections are made directly. Loopback hosts (`localhost`, `127.0.0.1`, `::1`) always bypass the proxy, so a local server such as a localhost MCP server keeps working when a proxy is configured — add your own internal hosts to `NO_PROXY` to exempt them too.

Stdio MCP servers that run as Node child processes honor `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` automatically when the child's Node version supports `NODE_USE_ENV_PROXY` (Node ≥ 22.21 or ≥ 24.5); SOCKS proxying applies to Kiki's own traffic only.

## Next steps

- [Config overrides](./overrides.md) — how environment variables, CLI options, and the config file interact by priority
- [Data locations](./data-locations.md) — directory structure affected by `KIKI_HOME`
- [Providers and models](./providers.md) — full connection examples per provider type
