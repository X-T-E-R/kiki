# `@kiki/agent-profiles`

Agent profile parsing, filesystem discovery, layered catalog projection, dispatch constraints, and catalog rendering.

## Public contract

- `SCHEMA_VERSION`: `1`
- Filesystem port: `HostFs`
  - `readFile(path: string): Promise<string>`
  - `readdir(path: string): Promise<readonly HostDirEntry[]>`
  - `stat(path: string): Promise<HostFileStat>`
  - `realpath(path: string): Promise<string>`
- Model port: `ModelAliasResolver.resolveId(alias: string): string | undefined`
- Executor port: `ExecutorValidator.validateExecutor(id: string, options: ExecutorOptions | undefined, binding: ExecutorBinding): ExecutorValidationResult | string`
- Parsing: `parseAgentFileText`, `parseAgentRouteFileText`, `parseSubagentList`, `parseSpawnConstraints`
- Discovery: `discoverAgentFiles`, `resolveAgentSourceGraph`, `profilesFromDiscovery`, `loadSystemMdProfile`
- Catalog: `projectAgentProfileCatalog`, `buildProfileCatalogEntries`, `renderProfileCatalogEntries`, `buildProfileDescriptions`

`realpath` supplies canonical paths for deduplication and symbolic-link escape checks. `resolveId` returns the canonical model id or `undefined` when the alias is unresolved. `validateExecutor` returns an explicit accepted binding or a diagnostic; legacy diagnostic strings are converted at this boundary.

## Agent profile frontmatter

| Key | Value |
| --- | --- |
| `name` | kebab-case string; defaults to the file basename |
| `description` | non-empty string |
| `whenToUse` | non-empty string |
| `override` | boolean |
| `main` | boolean |
| `private` | boolean |
| `delegation_notice` | `auto` or `off` |
| `tools` | comma-separated string or string list; `*` means unrestricted |
| `disallowedTools` | comma-separated string or string list |
| `subagents` | comma-separated string, string list, or lease mappings |
| `spawn_constraints` | mapping described below |
| `executor` | non-empty executor id |
| `executor_options` | scalar string, number, or boolean mapping |
| `model_alias` | non-empty model alias |
| `thinking_effort` | non-empty string |
| `allowed_models` | comma-separated string or string list |
| `deny_models` | comma-separated string or string list |
| `allowed_efforts` | comma-separated string or string list |
| `model_profiles` | model profile mappings described below |
| `service_tier` | `auto`, `default`, `flex`, or `priority` |
| `request_params` | scalar string, number, or boolean mapping |
| `system_prompt_mode` | `replace`, `prepend`, or `append` |
| `model_preference` | removed; parsing fails when present |

The Markdown body is the prompt and must be non-empty.

### Subagent lease mapping

| Key | Value |
| --- | --- |
| `name` | kebab-case profile name |
| `source` | relative `.md` path confined to the contribution root |
| `description` | non-empty string |
| `whenToUse` | non-empty string |
| `model_alias` | non-empty model alias |
| `thinking_effort` | non-empty string |
| `allowed_models` | string list |
| `deny_models` | string list |
| `allowed_efforts` | string list |
| `tools` | string list; `*` means unrestricted replacement |
| `disallowedTools` | string list |
| `subagents` | string list; `*` means unrestricted replacement |
| `prompt_mode` | `prepend`, `append`, or `wrap` |
| `prompt` | non-empty string required with `prompt_mode` |
| `delegation_notice` | `auto` or `off` |
| `service_tier` | `auto`, `default`, `flex`, `priority`, or `null` |
| `request_params` | scalar mapping or `null` |
| `model_profiles` | model profile mappings |
| `model_preference` | removed; parsing fails when present |

`main`, `override`, `id`, `profile`, and `spawn_constraints` are invalid in a lease mapping.

### Spawn constraints

`spawn_constraints` accepts `allowed_models`, `deny_models`, `allowed_efforts`, and `disallowed_tools`, each as a string list.

### Model profile mapping

| Key | Value |
| --- | --- |
| `alias` | required non-empty model alias |
| `when` | required non-empty selection guidance |
| `thinking_effort` | non-empty string |
| `allowed_efforts` | string list |
| `prompt_mode` | `prepend`, `append`, or `wrap` |
| `prompt` | non-empty string required with `prompt_mode` |

A `wrap` prompt contains `${parent_prompt}` or `${base_prompt}` exactly once. `prepend` and `append` prompts cannot contain either token.

## Route sidecar frontmatter

Route sidecars are stored under `.routes/<profile>/<route>.md`.

| Key | Value |
| --- | --- |
| `id` | lowercase dotted id whose first segment matches `profile` |
| `profile` | kebab-case base profile |
| `description` | non-empty string |
| `whenToUse` | non-empty string |
| `prompt_mode` | `inherit`, `prepend`, `append`, or `wrap` |
| `model_alias` | non-empty model alias |
| `thinking_effort` | non-empty string |
| `service_tier` | `auto`, `default`, `flex`, `priority`, or `null` |
| `request_params` | scalar mapping or `null` |
| `tools` | string or string list |
| `disallowedTools` | string or string list |
| `subagents` | string or string list |
| `model_preference` | removed; parsing fails when present |

`inherit` requires an empty Markdown body. Other prompt modes require a non-empty body; `wrap` contains one parent prompt token, while `prepend` and `append` contain none.
