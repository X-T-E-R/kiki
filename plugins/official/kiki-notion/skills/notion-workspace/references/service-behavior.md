# Notion service response guide

Use this guide alongside the currently discovered tool descriptions, not instead of their schemas. The names below are official documentation labels, not client call identifiers. The Kiki manifest supplies the connection; discover its tools in the current session.

## Access and search

The official access-check label is `notion-get-tool-access`. An empty object requests the whole exposed `current_tool_access` map; an empty `tool_names` list instead requests an empty map. Map keys use base names with underscores, for example `ai_search`, not client prefixes.

- `available`: eligible, subject to the usual page permissions.
- `available_with_limit`: eligible within the reported allowance; do not turn a quota into unlimited retries.
- `upgrade_required` / `plan_required`: only use a fallback explicitly documented for that exposed tool. AI search can fall back to Notion-only keywords with notices; do not promise connected sources were searched.
- `full_version_required`: surface the service's full-version link; do not assume that installing this plugin unlocks it.
- `not_enabled`: no promised fallback; billing or administrator restrictions can still fail.
- Missing entry: not advertised, not evidence of a usable fallback.

When `ai_search` is available, the map may omit `search`. Prefer the exposed AI search capability. Otherwise use an exposed workspace search capability. If only AI search is exposed with an upgrade/plan requirement, its documented keyword fallback can be used. If neither is exposed, an administrator must enable search. User lookup has separate user-information permissions and is not required for this brief workflow.

Search may silently drop unsupported filters and sorting and report them in `notices`. Check each restriction's reason against the actual values: multiple teamspaces can be restricted while one is supported. Check all notices even when access status is available. Do not claim date, title-only, editor, teamspace, or verification constraints were enforced unless the response and fetched evidence support them. AI search result type alone does not prove AI or connected-source coverage.

## Reading and edits

The official fetch label is `notion-fetch`. A large page can return `truncated: true`, `unknown_block_ids` (at most 50 subtree roots), and a larger `unknown_block_count`. Fetch a relevant returned root directly. If it fails with `object_not_found`, keep the permission/missing-content ambiguity in coverage. A successful subtree read does not fill roots whose IDs were not returned. Linked child pages are not automatically read; fetch the relevant ones within scope.

The official update label is `notion-update-page`. Exact-match `update_content` edits must match the current page; an unmatched old string fails without changing the page. Refetch instead of switching to whole-page replacement. Read the current writer schema for the supported command and content syntax; do not infer it from this reference.

Create/update can return async handles. The official status label is `notion-get-async-task`. The handle can be the returned object itself (`object: "async_task"`, `id`) or be nested in the tool's response. Pass its actual ID as the status tool's `task_id`. Pending states are `queued`, `running`, and `retrying`; terminal states are `succeeded` (operation result) and `failed` (error). Wait at least `poll_after_seconds` between polls. An update with `allow_async: false` can still return a handle. Queue-size validation failure creates no handle: splitting or a synchronous retry is useful only where the current tool documents it and remains within the requested change. A succeeded task does not ensure a template's content is ready; read back the intended content.

For `rate_limited`, read `structuredContent.error.retry_after_seconds` and reduce concurrency. Permit at most two delayed retries within the task's remaining wait budget. Retrying an unchanged permission or validation error is not recovery. Do not print tokens, signed URLs, or credential data into the brief.

## Official sources

Behavior checked 2026-10-04; the live connection remains authoritative for availability and schemas.

- [Supported tools and async behavior](https://developers.notion.com/guides/mcp/mcp-supported-tools.md)
- [Connection setup](https://developers.notion.com/guides/mcp/get-started-with-mcp)
- [OAuth/PKCE client requirements](https://developers.notion.com/guides/mcp/build-mcp-client)
- [Security and untrusted content](https://developers.notion.com/guides/mcp/mcp-security-best-practices)

This is an original Kiki workflow, not a downloaded Notion/OpenAI/Figma skill. Notion's hosted service and workspace content are not covered by the plugin's MIT license; see the package `NOTICE` for service terms.
