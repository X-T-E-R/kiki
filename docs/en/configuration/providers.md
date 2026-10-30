# Providers and models

Kiki can connect to multiple model providers at once. An API key is the most general connection method; the desktop and browser settings also offer account sign-in for Kimi Code, GitHub Copilot, and ChatGPT (Codex). Kimi is one supported service, not a separate Kiki provider category. Each provider uses a wire protocol; its models have their own IDs, context lengths, and capabilities. This page explains `config.toml` provider types and companion [`credentials.toml`](./config-files.md#provider-credentials) API keys.

## Supported provider types

The `type` field in the `providers` table selects the connection's request format (the API payload and endpoint). Chat models can override their connection's format with `protocol`; decision connections use the format of the connection itself:

| Type | Protocol | Typical use |
| --- | --- | --- |
| `kimi` | OpenAI-compatible | Kimi Code managed service, Kimi Platform API key |
| `anthropic` | Anthropic Messages | Claude model family |
| `openai` | OpenAI Chat Completions | OpenAI and compatible services, DeepSeek, Qwen, etc. |
| `openai_responses` | OpenAI Responses API | OpenAI's newer Responses interface |
| `google-genai` | Google GenAI | Gemini API |
| `vertexai` | Google GenAI on Vertex | Google Cloud Vertex AI |
| `system_one` | System One | Decision services such as Jev; permission review and memory recommendations |
| `pair_score` | Reranking scores | Memory ranking with compatible rerankers or classifiers |

Chat connections stream by default. Capabilities such as thinking, vision, and tool use are matched automatically by model name prefix — you typically do not need to declare them manually. Decision connections return judgments or scores and do not add entries to the chat model catalog.

**Credential priority**: a model's own credential wins; otherwise Kiki uses the provider's `api_key`, then its explicitly configured `api_key_env` variable. Without `api_key_env`, the existing `[providers.<name>.env]` credential fallback remains unchanged. The `system_one` type provides the TypeSafe default address; its implicit `TYPESAFE_API_KEY` fallback applies only to the `https://api.typesafe.ai` origin. For another service, select its key or environment variable explicitly, or leave credentials unset when it needs none. See [Config overrides: provider credentials](./overrides.md#provider-credentials) for the full priority and an environment-variable example.

### Decision connections

A decision connection owns its address, protocol and credentials. Permission review and [Memory Advisor](../guides/memory.md#memory-advisor) can reference the same connection, while each keeps its own source choice and behavior settings. Use a compatible service's address and remote model name; no local chat model or context size is needed.

This example shares one Jev connection, using the server's existing environment variable:

```toml
[providers.judgment]
type = "system_one"
base_url = "https://api.typesafe.ai/v1"
api_key_env = "TYPESAFE_API_KEY"
default_model = "jev-latest"

[permission.reviewer]
source = { kind = "connection", connection = "judgment" }

[memory.advisor]
source = { kind = "connection", connection = "judgment" }
```

`default_model` is the name sent to the remote decision service. A source can override it with `model`, or select an existing chat alias with `{ kind = "model", model = "review-model" }`. Changing one consumer's source does not change the other. [Memory Advisor](../guides/memory.md#memory-advisor) uses the source when enabled; saving a source preserves an existing off switch.

For a reranker, use `type = "pair_score"`, its `base_url`, and its remote `default_model`. Pair scores support memory **Rank**, not **Select** or permission review. By default, requests append `/systemone` or `/rerank` to the base path. Set `decision_endpoint` to a path or complete URL when the service needs another route; it must share the base URL's scheme, host and port and contain no embedded credentials.

Both types use the existing provider credential fields and custom headers. A service that accepts unauthenticated HTTP requests can leave credentials unset. An explicitly selected `api_key_env` that has no value and no alternative authentication reports an authentication issue; an upstream 401 or 403 does too. Store API keys through the existing connection credential field or `credentials.toml`, not a second consumer-specific key field. The [decision probe](../server/rest-api.md#decision-connections) tests the selected service with synthetic content.

Existing Reviewer `backend = "jev"` and advisor `selector` configurations continue working. The explicit [move Reviewer key](../server/rest-api.md#decision-connections) action transfers a saved legacy key on the server, switches the Reviewer source, then clears that old key. A partial result preserves newer settings: refresh and check the connection and Reviewer before retrying. If the Reviewer key has changed while the target connection still holds the old key, choose a new connection name; conflicting connections are never overwritten. Environment-variable connections require no key transfer.

### Model request format overrides

Set `protocol` on a model when a shared gateway requires a different API for that model. Accepted values are `openai` (Chat Completions), `openai_responses` (Responses), `anthropic` (Messages), and `google-genai` (Google GenAI). Omit it to inherit the provider's default; remove the field to return to inheritance. `kimi` and `vertexai` are provider types, not model protocol values.

```toml
[providers.gateway]
type = "openai"
base_url = "https://example.com/v1"

[models.chat]
provider = "gateway"
model = "remote-chat"
max_context_size = 128000

[models.responses]
provider = "gateway"
model = "remote-responses"
max_context_size = 128000
protocol = "openai_responses"
```

Replace the example endpoint and remote IDs with your service's values. Both models reuse the gateway's credentials. The override changes the API payload and path, not the provider, default model, request identity, or main/subagent usage settings. The endpoint must support the selected API; if it rejects the request, choose a supported format or remove the override. Kiki does not silently try another protocol.

The [model REST API](../server/rest-api.md#models-and-providers) reports the saved `protocol` separately from `effective_protocol`, the resolved request format. Saving a format does not test connectivity.

## Request compression

Request compression stays off until you configure it. `[request_compression]` applies to every provider that does not set its own table. A provider table replaces individual fields and inherits the rest: an omitted `targets` list, `min_bytes`, or `dictionary` stays as the system set it. `targets`, when set, replaces the system list in order; Kiki does not add the two lists together. Leave the provider key unset to inherit. `encoding = "off"` on a provider turns compression off for that provider even when the system table turns it on. With no system table, only providers that already set `request_compression` compress.

```toml
[request_compression]
encoding = "zstd"
targets = ["https://example.com/v1"]
min_bytes = 1024
dictionary = true

[providers.gateway.request_compression]
min_bytes = 0
```

The provider above keeps zstd, the same targets, and dictionary consent, and changes only the size threshold. Omit `dictionary` to keep the system choice. `dictionary = false` refuses retention for that provider. `dictionary` applies only to zstd. Saving either table applies on the next model request; a request already in flight keeps the settings it started with. `POST /api/config` writes the system table. `GET /api/providers` returns a provider table as saved, including a partial table, `encoding` set to `"off"`, and the original `targets` order.

For a gateway that explicitly supports compressed request bodies, this applies to Responses, Messages, and Chat Completions; other protocols keep their existing transport. A saved target does not skip the gateway's own compression support.

```toml
[providers.gateway.request_compression]
encoding = "gzip"
targets = ["https://example.com/v1"]
min_bytes = 1024
```

`targets` lists supported HTTP(S) API base URLs. A request must match the origin and path boundary; changing a model to another endpoint does not enable compression there. `min_bytes` counts UTF-8 body bytes and defaults to 1024. Empty, smaller, streaming, already encoded, and non-JSON bodies are left unchanged. Kiki uses the compressed body only when it is smaller. Remove the provider table to inherit again, or set `encoding = "off"` to disable compression for that provider. Remove the system table to leave every unset provider uncompressed.

To use ordinary zstd instead, set `encoding = "zstd"`. Neither gzip nor ordinary zstd asks the gateway to retain request bodies. If the gateway also implements the Portway request-dictionary extension, you may explicitly consent to temporary body retention:

```toml
[providers.gateway.request_compression]
encoding = "zstd"
targets = ["https://example.com/v1"]
dictionary = true
```

`dictionary = true` asks the gateway to cache exact request bytes, which can include messages, media, tool results, and signatures. Kiki keeps acknowledged dictionaries only in bounded process memory, for up to ten minutes. A dictionary acknowledgement confirms cached bytes, not completed model generation. Every request is still built from the full local history; a changed or compacted history is never reconstructed from guessed model output.

Only a marked, pre-execution decoding rejection permits an encoding fallback, with at most three attempts. Transport failures and temporary provider errors before any output use the existing [request retry policy](./config-files.md#retry), even when delivery is uncertain. Native agent turns also retry connection interruptions after partial output by default: Kiki discards the failed attempt's output before resending, and tools run only after a complete response. Failed generations may incur additional charges; set `[retry] retry_partial_responses = false` to disable partial-response replay. Completed tool results remain in local history and are not executed again by this retry. If a target does not support compression, disable it before starting a new request rather than relying on automatic format probing.

## Incremental Responses over WebSocket

Responses WebSocket stays off until you configure it. `[responses_web_socket]` applies to every provider that does not set its own table. A provider table replaces that value as a whole. `targets`, when set on the provider, replaces the system list in order and is not added to it. Omit the provider key to inherit. `off = true` keeps that provider on ordinary HTTP even when the system table lists targets. With no system table, only providers that set `responses_web_socket` open a socket. Saving either table applies on the next model request. An idle socket closes immediately; a socket serving an in-flight request stays open until that request completes, fails, or is canceled, then the next request uses a new connection.

For a gateway that advertises the version 1 `X-Responses-WebSocket-Capabilities` handshake, opt in to connection-local Responses history:

```toml
[responses_web_socket]
targets = ["https://example.com/v1"]

[providers.gateway]
type = "openai_responses"
base_url = "https://example.com/v1"

[providers.other.responses_web_socket]
off = true
```

The target must match the origin and path boundary of the Responses endpoint. A saved target does not skip the handshake. Kiki uses the official OpenAI SDK, keeps one socket per Agent, and sends only new input when the previous completed response still matches the local history. Helper requests, other Agents, and forks do not share that history. Canceling a request closes its socket; model, credentials, policy, and context changes reset the connection or send a full request. Remove the provider table to inherit again, or set `off = true` to keep ordinary HTTP for that provider. Remove the system table to leave every unset provider on ordinary HTTP.

The gateway temporarily retains native request and response items on the connection. Unlike HTTP request dictionaries, this state follows completed generation, not dictionary acknowledgements. Unknown output fields are retained in an in-memory sidecar and sent in full rather than used for an incremental request.

If the gateway explicitly reports missing history before execution, Kiki sends the full current history once. A pre-execution unsupported upstream format or prompt policy can fall back to a full HTTP request. The transport does not use this fallback for access denials or partial responses. This path supports `response.create` generation only; it does not enable background generation, steering, or `generate:false` warmup.

Connection interruptions use the [request retry policy](./config-files.md#retry), including closes before the terminal event with code 1000, 1001, 1006, 1012, or no code. A retry retires the old socket and sends the full current history on a new connection; `previous_response_id` is not a continuation cursor for the interrupted response. A `websocket_connection_limit_reached` event is a connection interruption even when a gateway forwards it over HTTP streaming (SSE). After 55 minutes of connection use, Kiki proactively replaces its socket before the next request without interrupting a response in progress.

Native agent turns can discard partial text, thinking (including encrypted thinking), and unfinished local tool calls before resending. Refusals, provider-hosted tool output, explicit non-retryable errors, and cancellation still stop replay. Each retry appears in the UI and logs, with at most five attempts including the first; configuration can lower this limit but cannot raise it. Failure and retry logs include `transport` (`ws` or `sse`), `webSocketCapabilities`, `webSocketCapabilityVersion`, and `webSocketConnectionAgeMs` for Kiki's local connection; unavailable values are `null`. After exhaustion, a child task fails with its existing context available for `AgentRun` resume.

## `/provider` — interactive provider management

Prefer not to edit TOML by hand? Type `/provider` in the TUI to open the **provider manager**, where you can interactively add or remove providers.

The manager displays providers as a list of entries grouped by source. Navigation:

- ↑/↓ to move the cursor, ←/→ to page
- `d` to delete the current provider (with `[y/N]` confirmation)
- Press Enter on the `[ Add New Platform ]` row to add a new provider

Two paths when adding:

- **Known third-party provider**: pick a provider from the [models.dev](https://models.dev/) catalog → enter an API key → pick a default model. Vendors the catalog does not describe with a protocol (xai, openrouter, and other vendor-specific SDKs) are imported as OpenAI-compatible and marked as guessed; if the catalog has no usable endpoint for them, you are asked for a base URL first. Proprietary protocols (Amazon Bedrock, Cohere) cannot be imported. Deprecated and alpha models are left out of the list. If the public catalog is unreachable, Kiki falls back to a built-in snapshot of it, so the import still works offline.
- **Custom registry (api.json)**: paste a custom registry URL and Bearer token; this explicit import creates the `providers` / `models` entries. Later startup does not synchronize upstream additions, removals, or model metadata changes.

### Fetching model suggestions

In GUI **Settings → Models & providers → Providers & accounts**, expand the folded **Maintenance** section at the bottom and click **Get models** to fetch suggestions from every connection. API-key providers and custom registries are fetched only on request, not at startup or on a timer. Fetching these suggestions does not change your providers, configured models, or default model. Choose a suggestion and save it separately to add a model; an upstream removal does not delete an existing model.

Kimi Code account sign-in maintains its managed catalog separately. When that catalog refreshes and no global default is set, Kiki selects a managed model even if the catalog itself has not changed. An unchanged catalog preserves explicit defaults, including a choice made while the refresh was in progress.

Suggestions are kept in server memory and disappear when the server restarts. Changing or deleting a provider connection discards its cached suggestions. A failed fetch shows an error while retaining the last successful suggestions; a successful empty response clears them. Models already configured for that provider are excluded even if their local aliases differ from the upstream model IDs.

In the GUI, open **Settings → Models & providers → Providers & accounts**. Under **Connect with an API key**, choose one of five protocol entries (`openai`, `openai_responses`, `anthropic`, `google-genai`, `vertexai`) or search for a service by name. A matching service, including DeepSeek, GLM, Kimi, Ollama, LM Studio, or OpenRouter, fills in its protocol and base URL. If there is no match, choose a protocol and enter the base URL yourself. Then enter the key if required, use **Add model** inside the connection form, and choose **Save provider**.

Ollama and LM Studio use the same API-key path as other OpenAI-compatible services; their local servers may not require a key. The five quick starts are OpenAI, Anthropic, Google Gemini, DeepSeek, and Moonshot (Kimi) — the Kimi shortcut configures the `kimi` provider described below.

**Providers & accounts** lists configured connections and their **Models** lists. Search by connection name or by the IDs and names of its models; expand a connection to inspect context size and capabilities, then click a model row to open the full editor in a side panel. A model star sets the global new-session default; the **New sessions use** bar above the tabs does the same. **Remove model** is at the bottom of the editor and asks for confirmation. The provider and model also retain their own per-provider default and remote ID. A manually entered Kimi API key uses the same suggestion-only flow as other API-key connections; account sign-in provisions its own models.

::: warning
Kimi Code OAuth managed accounts logged in via `/login` do not appear in `/provider`. Use `/login` and `/logout` to manage them.
:::

The same operations are also available in non-interactive environments via the shell command: [`kiki provider`](../reference/command.md#kiki-provider).

## `kimi`

For connecting to Moonshot AI's OpenAI-compatible interface, including the Kimi Code managed service and Kimi Platform API keys.

- Default `base_url`: `https://api.moonshot.ai/v1`
- Credential key names: `KIMI_API_KEY`, `KIMI_BASE_URL` — these are entries of the `[providers.<name>.env]` sub-table, not shell environment variables
- Additional capabilities: video upload and stored image attachment references

For `type = "kimi"` models using Chat Completions or Messages on the official endpoints listed in this section, Kiki uploads stored image attachments with the current provider credentials and sends a file reference. Local originals remain unchanged. Remote copies follow the provider's retention policy; closing or deleting the local session does not delete them. Each cached reference is checked with the current credentials before reuse, and a deleted or expired file is uploaded again. Cache entries are isolated by endpoint, protocol, provider, and credentials. Other endpoints and inline image inputs keep their existing inline transport. A temporary upload failure uses the image inline; authentication failures use the existing sign-in recovery.

Kiki keeps the attachment size limits enforced by the composer and does not discard older media to meet an additional 20 MiB provider request budget.

Kimi Code subscription keys pair with the managed base URL `https://api.kimi.com/coding/v1` (configured automatically by `/login`). Open-platform keys pair with the endpoint of the portal that issued the key: `https://api.moonshot.cn/v1` for keys from [platform.kimi.com](https://platform.kimi.com), or the default `https://api.moonshot.ai/v1` for keys from [platform.kimi.ai](https://platform.kimi.ai).

```toml
[providers.kimi]
type = "kimi"
base_url = "https://api.moonshot.ai/v1"
```

```toml
# ~/.kiki/credentials/credentials.toml
[providers.kimi]
api_key = "sk-xxxxx"
```

> When using the Kimi Code managed service, running `/login` automatically configures `base_url` and credentials — no manual setup needed.

For the standard managed Kimi Code credential slot, Kiki can also reuse an existing Kimi Code sign-in when its own slot has no token. It reads the original home from `KIMI_CODE_HOME`, or `~/.kimi-code` by default, and follows that installation's `credentials_store` setting. This selects a credential slot, not a verified account identity. An explicitly connected original source stays selected; disconnecting it from Kiki does not delete the original credentials.

With `credentials_store = "keyring"`, an unavailable keyring is a storage error, not a signed-out account; restore keyring access before retrying. `auto` mode can use a readable file copy. Reusing the source reads its credentials in place rather than copying them into Kiki's own credential directory.

## `anthropic`

For connecting to the Claude API. Standard Claude models automatically enable vision, tool use, and Thinking (where supported); custom or uncovered models need `capabilities` declared explicitly on `[models.<alias>]`.

- Default `base_url`: follows Anthropic SDK default
- Credential key names: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`
- Default `max_tokens`: inferred per model. To override, set `max_output_size` on the model alias

```toml
[providers.anthropic]
type = "anthropic"

[models."claude-opus-4-7"]
provider = "anthropic"
model = "claude-opus-4-7"
max_context_size = 200000
# max_output_size = 32000  # optional; omit to use the model-inferred default
```

```toml
# ~/.kiki/credentials/credentials.toml
[providers.anthropic]
api_key = "sk-ant-xxxxx"
```

## `openai`

For connecting to the OpenAI Chat Completions protocol, as well as any third-party service compatible with that protocol (override `base_url` as needed).

Third-party reasoning models (DeepSeek, Qwen, One API, etc.) work out of the box: the CLI automatically handles the `reasoning_content` field and `reasoning_effort` injection. OpenAI-compatible Chat connections also retain structured `reasoning_details`, including encrypted records, when restoring conversations and sending subsequent requests. Summaries are shown only when no nonempty string reasoning is returned; encrypted records stay out of the transcript. If your gateway returns reasoning content under a non-standard field name, set `reasoning_key` on the model alias to override.

For both `openai` and `openai_responses`, Kiki does not send an output-length limit of its own when you have not set one and the model's capability is unknown — the request carries no `max_tokens`, `max_completion_tokens` or `max_output_tokens`, and the server's own default applies. A limit you set yourself, a known model output capability, a tighter session or profile limit, and a remaining-window budget are all still honored; the context window size on its own is not treated as an output limit. That maximum is a ceiling, not a promise about answer length — what the model returns still depends on the task and on when it stops — and you are billed for the response you actually get.

- Default `base_url`: `https://api.openai.com/v1`
- Credential key names: `OPENAI_API_KEY`, `OPENAI_BASE_URL`

```toml
[providers.openai]
type = "openai"
base_url = "https://api.openai.com/v1"
```

```toml
# ~/.kiki/credentials/credentials.toml
[providers.openai]
api_key = "sk-xxxxx"
```

## `openai_responses`

Corresponds to OpenAI's newer Responses API, always operating in streaming mode. Configuration is the same as `openai`.

- Default `base_url`: `https://api.openai.com/v1`
- Credential key names: `OPENAI_API_KEY`, `OPENAI_BASE_URL`

```toml
[providers.openai_responses]
type = "openai_responses"
base_url = "https://api.openai.com/v1"
```

```toml
# ~/.kiki/credentials/credentials.toml
[providers.openai_responses]
api_key = "sk-xxxxx"
```

## `google-genai`

For connecting directly to the Google Gemini API. Thinking, vision, and multimodal capabilities are auto-detected by model name.

- Credential key name: `GOOGLE_API_KEY`

```toml
[providers.gemini]
type = "google-genai"
```

```toml
# ~/.kiki/credentials/credentials.toml
[providers.gemini]
api_key = "xxxxx"
```

To route through a Gemini-compatible proxy or gateway, set `base_url` (or the `GOOGLE_GEMINI_BASE_URL` env var); when omitted, the SDK default `https://generativelanguage.googleapis.com` is used.

> Give the **host root only**. The Google GenAI SDK appends the API version and path itself (e.g. `/v1beta/models/<model>:generateContent`), so a trailing `/v1beta` would produce a doubled `/v1beta/v1beta/…`.

```toml
[providers.gemini]
type = "google-genai"
base_url = "https://your-gateway.example"
```

```toml
# ~/.kiki/credentials/credentials.toml
[providers.gemini]
api_key = "xxxxx"
```

## `vertexai`

Uses the same Google GenAI client as [`google-genai`](#google-genai), but stays on Vertex AI. It does not call the Gemini Developer API (`generativelanguage.googleapis.com`). `vertexai` is a provider type, not a model `protocol` value.

### API key

Store the key as `api_key` in `credentials.toml`, or as `VERTEXAI_API_KEY` in the provider `[providers.<name>.env]` sub-table.

With neither project nor location set, requests go to `https://aiplatform.googleapis.com` with API version `v1` and the `x-goog-api-key` header. The path looks like `/v1/publishers/google/models/<model>:streamGenerateContent`.

```toml
[providers.vertex]
type = "vertexai"
```

```toml
# ~/.kiki/credentials/credentials.toml
[providers.vertex]
api_key = "xxxxx"
```

With both `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` set, that same key is sent on the project resource. The host matches project ADC for the same location. Location `global` uses `https://aiplatform.googleapis.com/v1/projects/<project>/locations/global/publishers/google/models/<model>:streamGenerateContent`. Location `us` uses `https://aiplatform.us.rep.googleapis.com`, and location `eu` uses `https://aiplatform.eu.rep.googleapis.com`, each with `/v1/projects/<project>/locations/<location>/publishers/google/models/<model>:streamGenerateContent`. Any other location uses `https://<location>-aiplatform.googleapis.com` with that same project path.

Set both coordinates or neither. Setting only one is rejected. A model id that already starts with `projects/` is sent unchanged. A model id that starts with `publishers/` is rejected when project and location are set.

### Project ADC

Write the project ID and location in the provider env sub-table, and leave the API key unset. A shell `export GOOGLE_CLOUD_PROJECT` is not read. Sign in with Google Cloud application default credentials: `gcloud auth application-default login`, or set `GOOGLE_APPLICATION_CREDENTIALS` to a service account JSON file.

Requests use API version `v1beta1` and a path that starts with `/v1beta1/projects/<project>/locations/<location>/`. Location `global` uses `https://aiplatform.googleapis.com`. Location `us` uses `https://aiplatform.us.rep.googleapis.com`. Location `eu` uses `https://aiplatform.eu.rep.googleapis.com`. Other locations use `https://<location>-aiplatform.googleapis.com`.

```toml
[providers.vertex]
type = "vertexai"

[providers.vertex.env]
GOOGLE_CLOUD_PROJECT = "my-gcp-project"
GOOGLE_CLOUD_LOCATION = "us-central1"
```

```sh
gcloud auth application-default login
kiki
```

To send any of these routes through a custom host, set `base_url` (or `GOOGLE_VERTEX_BASE_URL` in the provider env sub-table). Give the host root only. The client appends the API version and path.

`google-genai` stays on the Gemini Developer API unless that provider's env sub-table sets both `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`. Those coordinates select Vertex AI, and an API key configured for that provider is still sent. A `vertexai` API key stays on Vertex AI when those coordinates are set.

## OAuth and credential injection

In the GUI **Providers & accounts** tab, **Sign in with an account** offers Kimi Code, GitHub Copilot, and ChatGPT (Codex). Choose the account, open the verification URL, enter its device code, and wait for the connected status. An account needs access to the corresponding subscription or service; available models depend on that account. Sign out from the same row to remove its managed connection and models. These are sign-in methods, not new protocol `type` values: Kimi Code and Copilot use `openai`-compatible requests; ChatGPT Codex uses `openai_responses` against the Codex endpoint. OAuth tokens live in JSON files under `credentials/` (see [Data locations](./data-locations.md)); API keys live in `credentials/credentials.toml`. The CLI `/login` and `/logout` commands continue to manage Kimi Code only.

## Request identity

The sections above decide which endpoint Kiki connects to and with which key. **Request identity** decides which client each request claims to be: it writes the `User-Agent` and extra headers, so the provider treats the traffic as Codex CLI, Claude Code, Grok Build, OpenCode, or Kiki's own client. It is a different setting from [`[identity]`](./config-files.md#identity), the runtime display name and slug.

Identity only supplies those client-identity fields. `base_url`, the API key, and the authentication method still come from your provider configuration and `credentials.toml`. Credential and transport headers such as `Authorization`, `x-api-key`, `Cookie`, and `Content-Type` are not accepted as identity fields.

### Built-in identities

Kiki ships six identities. Built-in identities are read-only; **Duplicate and edit** produces a custom identity whose User-Agent, headers, and body fields you edit in plain text, with values accepting placeholders such as `{version}`, `{model}`, and `{os_type}`:

| Identity | preset / identity ID | What it sends |
| --- | --- | --- |
| Kimi Code | `kimi_code` / `kimi_code` | Kiki's native client: adds `X-Msh-*` device headers on a Kimi provider |
| Codex CLI | `codex_compatible` / `codex` | `codex_cli_rs/{version}` User-Agent and `originator`, OpenAI Responses only |
| Claude Code | `claude_code_compatible` / `claude_code` | `claude-cli/{version} (external, cli)` User-Agent, `x-app`, and `X-Stainless-*`, Anthropic Messages only |
| Grok Build | `grok_build_compatible` / `grok_build` | `grok-shell/{version}` User-Agent and `x-grok-*` session and turn headers, on Chat Completions, Responses, or Messages |
| OpenCode | `opencode_compatible` / `opencode` | `opencode/{version}` User-Agent, `x-opencode-client: cli`, and the dynamic `x-opencode-session` and `x-opencode-request` |
| None | `none` / `none` | Sends no Kiki-chosen identity fields: the User-Agent, the reserved identity headers, and the `X-Msh-*` device headers are removed. Fields a provider's authentication protocol requires still go out — OAuth tokens, account headers, the Grok client-version marker — because those belong to the protocol rather than to identity |

### OpenCode

With the `OpenCode` identity, upstream sees an OpenCode command-line client:

- `User-Agent: opencode/{version}`, defaulting to the OpenCode CLI version shipped with Kiki (npm package `opencode-ai`, currently 1.18.21)
- `x-opencode-client: cli`, a fixed value
- `x-opencode-session`: one value per agent session, stable within that session, so upstream attributes the session's requests to a single OpenCode session
- `x-opencode-request`: regenerated every turn, identifying a single request

The identity works over OpenAI Responses, Anthropic Messages, and OpenAI Chat Completions, unlike Codex (Responses only) and Claude Code (Messages only).

### Where to configure it

GUI **Settings → Models & providers → Identity** is the central page: the left column lists built-in (read-only) and custom identities, the right side previews the headers and body fields that identity actually sends, and three further cards cover client versions, per-layer usage, and recent requests. An identity applies in three layers; the **Default request identity** card on that page sets the global layer, and the provider and model layers are set in **Settings → Models & providers**:

| Layer | GUI | `config.toml` |
| --- | --- | --- |
| Global default | Settings → Models & providers → Identity | `[request_identity]` |
| Provider | Settings → Models & providers → provider editor → Request identity | `[providers.<name>.request_identity]` |
| Model | Settings → Models & providers → Providers & accounts → expand connection → Models → model row → Request identity | `[models."<alias>".request_identity]` |

Later layers override earlier ones (global → provider → model). With no layer set, an ordinary API-key connection uses the built-in Kimi Code identity, and a provider authenticated through the Codex or Grok Build OAuth flows uses that provider's default identity. Choosing a compatible preset clears the lower layers first, then applies that layer's optional sparse `overrides` (for example `lineage.format`, `client.user_agent`, `request.logical_id`). Sending one provider's traffic as OpenCode takes only:

```toml
[providers.my-gateway.request_identity]
preset = "opencode_compatible"
```

### Client versions

The client version a built-in identity carries follows the value shipped with Kiki, and the **Client versions** card can check upstream through the npm registry, the locally installed CLI (`opencode --version`), or a manifest URL. A check only stages a candidate version: requests keep using the current one until you apply it. You can also pin the version, or roll back to a previous one.

## Next steps

- [Configuration files](./config-files.md) — full field reference for the `providers` and `models` tables
- [Config overrides](./overrides.md) — credential resolution priority rules for providers
- [Environment variables](./env-vars.md) — credential key names per provider type
