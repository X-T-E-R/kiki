# Settings pages

The Kiki desktop app exposes settings in a **Settings** dialog. This page tours each category and links to the reference that owns the underlying configuration; it does not introduce new behavior.

## About

**Settings → About** shows the current version and the update channel. Choose Stable or Beta and run a manual update check; when an update is available, Kiki shows its version and release notes before asking for confirmation. See [Kiki desktop](../getting-started/desktop-app.md#update).

## Agents

**Settings → Agents** selects a workspace to inspect its default main profile, effective source, and subagent capabilities. File-backed profiles can be edited at their displayed source. **Settings → Agents → Prompt** edits the `[prompt]` prompt-field overrides section in `config.toml`; the card is collapsed by default — expand it before editing. See [Agents and subagents](../customization/agents.md#capability-visibility) and [Prompt field overrides](../customization/prompt-fields.md).

## Search & retrieval

**Settings → Search & retrieval → Overview & source** inspects the built-in search and retrieval module — the capability behind the `WebSearch` and `FetchURL` tools — showing which configuration source is in effect and whether the server reuses its local nb-search configuration. The equivalent configuration lives in `config.toml` — see [Configuration files](../configuration/config-files.md#nb-search).

## Composer

The **Composer → Persist composer drafts** toggle controls whether new-session choices (model, effort, workspace, working directory, profile) and per-session draft text are written to this browser. Turning it off clears the saved store. See [Workspace and session management](./sessions.md#session-storage).

## Dispatch capabilities

Open **Dispatch capabilities** — next to the new-session workspace selector, or in a session's right rail — to inspect subagent profiles, routes, executors, and default model and thinking-effort sources. Default configuration validity and permission to launch are shown separately. See [Agents and subagents](../customization/agents.md#rebuilding-a-session-context).

## Usage

The **Usage** page shows token usage and estimated cost for a date range. Opening it without filters starts with today; token usage and cost have separate completeness indicators, and the **Data reliability** section distinguishes unknown providers from empty ranges. See [Workspace and session management](./sessions.md#gui-usage-statistics).

## CLI counterpart

The TUI writes the same client preferences through `tui.toml` and the interactive commands `/config`, `/theme`, and `/editor`; see [`tui.toml`](../configuration/config-files.md#tui-toml). Agent and runtime settings live in `config.toml`.
