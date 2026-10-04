# Settings pages

The Kiki desktop app exposes preferences in the **Settings** dialog and activity on separate pages such as **Usage** in the sidebar. This page helps you find each control and what it changes; the linked pages hold the full reference.

**"I want to change X" quick lookup:**

| I want to change… | Go to |
| --- | --- |
| Sign in with a subscription, or add an API key | **Models & providers → Connections** |
| Version and update channel (Stable / Beta) | **About** |
| Agent profiles, prompt-field overrides | **Agents** |
| Low-frequency long-term memory reminders | [`loop_control.continuity_cadence.memory_maintenance`](../configuration/config-files.md#continuity-reminder-settings) in `config.toml` |
| Search and retrieval configuration source | **Search & retrieval** |
| Whether input drafts are remembered | **Composer** |
| Subagent dispatch configuration | **Dispatch capabilities** |
| Run a browser for agent tasks | **Browser control** |
| Drive the server's own desktop | **Computer control** |
| Experimental features | **Developer → Experimental** |
| Inspect this session's prompt sources | Session header **⋯ → Effective prompts** |
| Temporarily use the preview space for the cockpit | Right-panel header **Cockpit** |
| Token usage and cost | **Usage → History** |
| Running or queued model requests | **Usage → Live** |
| Model/provider request concurrency | **Usage → Live → Concurrency limits** |
| Send usage to another service | **Usage → External sync** |
| TUI theme, editor, and other CLI-side preferences | The `/config` commands in the terminal, see [CLI counterpart](#cli-counterpart) |

## Connections

**Settings → Models & providers → Connections** (`/settings/ai?tab=providers`) is one list. Every way Kiki reaches a model is a **connection** — an account you sign in to, a hosted API you hold a key for, or a server on this machine — and each is one row that says how it is reached, what it carries, and whether it works. How a connection authenticates is part of the connection, not a separate list to keep in step with it.

**Add connection** is the single way in, and it asks one question — which service, by what means:

- **Sign in with an account** — the subscriptions this server offers: Kimi Code, a ChatGPT account for Codex, a Grok Build account, GitHub Copilot. An account you already have a connection for is not offered again; a sign-in that has gone stale is recovered on that connection's own row.
- **From the directory** — pick a service from models.dev and Kiki fills in its address and model list. An id that already exists updates that connection, and the form says so before you press.
- **Enter it myself** — a protocol, an address and a key, for a service the directory does not have, including a local server.

An account connection is written by the sign-in, so its row has no protocol, address or key to fill in. Expand it to see which account is behind it, what the vendor says it has left, and the action that changes the sign-in:

- **Connected** — the credential works. Kiki renews it on its own. **Sign out** ends that sign-in in Kiki and removes the models it provisioned; it does not sign you out at the provider, and it does not touch the provider's own record of your account.
- **Sign-in expired** — the provider no longer accepts it. **Sign in again** replaces it on this same connection; nothing is added to the list.
- **Sign-in didn't finish** — the flow ended without a credential: you declined it, the code expired, or it failed. One line says which, and the connection is left as the server reports it rather than as a half-made one.
- **Waiting for you** — a sign-in is running, with the code, **Open verification page**, how long it stays valid, and **Cancel sign-in**.

A sign-in that completes adds that account's models to the catalog on the server. **Available models** is the authority on what you can use — a row here reports the connection and its sign-in, not a promise about which models are selectable right now.

Signing out here affects Kiki only. The provider keeps its own record of your subscription, and signing in again reconnects the same account.

### Reusing a sign-in this machine already has

For ChatGPT (Codex) and Grok Build, a connection can use the sign-in their own app already holds on this machine instead of a new one. Kiki reuses it and renews it when it runs out; it does not copy the credential, does not start the other app, and signing in or out here does not change anything there.

"This machine" is the machine Kiki's **server** runs on. That is usually the one you are looking at, and when it is not, **Look somewhere else on the server** takes a directory to read from instead.

The order is deliberate. **Check this machine** reports which account is on the other side and where it is kept — a file, the system keyring, or an encrypted store. Only then is **Use this sign-in** offered, and it carries the account it just showed you, so a credential that was replaced in between is refused rather than adopted silently. A credential due for renewal is not a problem: it is offered, and Kiki renews it.

When the machine cannot be used, the page says why in terms you can act on — no account for that service, signed out, stored somewhere unreadable, or belonging to a different account — and offers nothing to attach.

**Stop using it** lets go of the machine's sign-in for this connection. It removes Kiki's reference and the models it provisioned; the sign-in itself is still there, and the other app is unaffected.

## About

**Settings → About** shows the current version and the update channel. Choose Stable or Beta and run a manual update check; when an update is available, Kiki shows its version and release notes before asking for confirmation. See [Kiki desktop](../getting-started/desktop-app.md#update).

## Agents

**Settings → Agents** selects a workspace to inspect its default main profile (the agent's configuration file), effective source, and subagent capabilities. File-backed profiles can be edited at their displayed source. **Settings → Agents → Prompt** edits the `[prompt]` prompt-field overrides section in `config.toml`; the card is collapsed by default — expand it before editing. See [Agents and subagents](../customization/agents.md#capability-visibility) and [Prompt field overrides](../customization/prompt-fields.md).

Long-term memory maintenance reminders help retain changes useful to future tasks; no meaningful change calls for no write. To disable only the periodic reminders while keeping new standing-instruction and pre-compaction checks, set `memory_maintenance = false` in `config.toml`. This does not disable memory tools, approval, or task notes. See [Continuity reminder settings](../configuration/config-files.md#continuity-reminder-settings) for the section and prerequisites.

## Search & retrieval

**Settings → Search & retrieval → Overview & source** inspects the built-in search and retrieval module — the capability behind the `WebSearch` and `FetchURL` tools — showing which configuration source is in effect and whether the server reuses the local search configuration. The equivalent configuration lives in `config.toml` — see [Configuration files](../configuration/config-files.md#nb-search).

## Browser control

**Settings → Browser control** (`/settings/browser-control`) manages saved browser connections. One connection is one controllable browser location; opening the page reads and edits them and starts no browser.

A connection has a fixed id, a display name, and one of two styles, which point at different targets:

- **Profile (Independent agent browser):** Kiki starts and manages a browser of its own on the server, with a profile (sign-in state) of its own — your everyday browser cookies are not copied. Optional extras: an installed Chrome or Edge instead of the bundled one, and **Show the browser window** (off by default, so it starts headless).
- **CDP (Existing or remote browser):** attaches to a browser that already exposes a CDP address and starts nothing new. That address names the machine the browser runs on, which may be a different machine.

The driver, and any browser Kiki starts, run on the Kiki server — not on the device showing this window. **Check components** starts the managed driver and reads its session and tab state; **Check connection** handshakes with the CDP endpoint and lists its targets. Neither opens a page. **Start browser** and **Attach browser** are the separate actions that connect. Saving writes configuration only and ends that connection's current running session first. **Disconnect** releases the connection, and what happens to the browser depends on who started it: a borrowed CDP browser stays, an instance Kiki started is closed.

Agents use these connections through the [browser tools](../reference/tools.md#browser-tools), naming a connection by its id — never by display name. **Default connection** applies to sessions created afterwards; turning a connection off never swaps in another one.

Running a browser is a development-candidate feature and is off by default. Turn on `native_browser` under **Settings → Developer → Experimental**, or set it under [`[experimental]`](../configuration/config-files.md#experimental), before connecting. With it off, the page still reads and edits saved connections, but connecting is refused and agents get no browser tools. The connections themselves are stored in [`[browser_control]`](../configuration/config-files.md#browser-control).

## Computer control

**Settings → Computer control** drives the desktop of the machine running the Kiki server, through a pinned open-source executor. Nothing is installed or configured by default, so the page starts empty.

**Install executor** downloads and verifies that pinned release, then registers a global MCP connection named `kiki-computer` (the driver's path plus `mcp` arguments). **Installed** means the executor files verified — not that anything is being controlled; desktop access is a separate check that the install does not run. The page names the machine that would be driven: **Kiki server** is the connected server, so with a remote or SSH connection the desktop belongs to that host's own graphical session.

The agent drives it with the executor's own tools through the existing MCP mechanism and permissions; Kiki adds no second desktop tool set — see [MCP](../server/mcp.md). The pinned Windows executor observes the primary display and has no display selection of its own. On macOS the direct connection carries desktop permissions in the calling process, so grant them where the driver reports them missing.

**Stop control** ends the cua processes this service started, and disables an editable connection's configuration at the same time. It does not mean nobody controls that desktop: another client or another Kiki instance may still be driving it.

## Composer

The **Composer → Persist composer drafts** toggle controls whether new-session choices (model, effort, workspace, working directory, profile) and per-session draft text are written to this browser. Turning it off clears the saved store. See [Workspace and session management](./sessions.md#session-storage).

## Dispatch capabilities

Open **Dispatch capabilities** — next to the new-session workspace selector, or in a session's right rail — to inspect a subagent's profile (configuration file), route, and executor, plus where the default model and effort come from. Default configuration validity and permission to launch are shown separately. See [Agents and subagents](../customization/agents.md#rebuilding-a-session-context).

## Session controls

### Effective prompts

In a session, open the header's **⋯ → Effective prompts**. The drawer opens independently of the right rail, including on narrow screens. It shows the current agent identity, profile, model and executor, prompt channels and source order, field override states and reasons, file locations, and cognition-anchor scope. The latest actual request is separate evidence: before any request exists, the details do not claim that the displayed composition has been sent.

The binding and disk revisions help identify changed source files. When you want to reload the session's prompt sources, use [Rebuild context](../customization/agents.md#rebuilding-a-session-context) after the session becomes idle. Ordinary details read the current identity; **Check all branches** is a separate, explicit action to inspect configured common, main-agent and independent-agent prompt files. It does not activate those other branches or switch the current identity.

### Cockpit

On desktop-width screens, use **Standard / Cockpit** in the right-panel header. Cockpit temporarily widens that panel and takes over the preview space, while the conversation and composer stay in the main column.

Choose **Standard** or **Exit cockpit** to restore the previous preview content, tabs, draft and width. Exiting cockpit leaves the standard right panel open; hiding that panel is a separate action. Opening a file, agent detail or skill preview also exits cockpit and restores the preview workspace. The temporary cockpit width does not replace your saved standard-panel width.

## Usage

Open **Usage** in the sidebar (`/usage`). It has three tabs and opens **History** by default:

- **History:** token usage and estimated cost for a date range, defaulting to today. Token usage and cost have separate completeness indicators; **Data reliability** distinguishes unknown providers from empty ranges. Existing filtered usage links open History. See [Usage statistics](./sessions.md#gui-usage-statistics).
- **Live:** running and queued native-request counts across this service. Expand **Request details** for the breakdown by model, provider, and role, and waiting rows with blocking rule IDs and elapsed queue time. If the connection fails, the last counts are marked stale. On the same tab, **Concurrency limits** lets you add or edit rules, choose a model or provider target, and set a shared or per-session cap. The switch pauses a rule without deleting it. Saving applies the rule to new and queued requests without stopping active streams.
- **External sync:** destinations that receive this server's own usage. Three kinds are available: **vibecafe.ai**, **Kiki webhook**, and **Script**. Only the model, the UTC half-hour, the four token counts, quality and cost go out — never a prompt, answer, title, workspace name or path.

Existing `/usage?panel=limits` links open Live and focus the concurrency-rule section; there is no separate Limits tab.

External sync stays off until the server enables the `usage_export` flag. A saved destination sends nothing until you preview the exact payload and agree once; widening the range, changing the endpoint, or a credential change that cannot be shown to be the same identity asks for consent again, while shrinking the range or changing the interval does not. Pausing a destination keeps its queue; removing it is a separate action that asks whether to discard the queued buckets; asking the service to delete the usage it already holds is a third one. See [`kiki usage-export`](../reference/command.md#kiki-usage-export) for the command-side equivalent.

A **Script** destination runs your command as your own OS user with your ordinary permissions — it can read files and use the network on its own, and this is not a sandbox. Kiki writes only the content-free batch to its stdin and reads a receipt from its output. When a local vibecafe collector already reports this home to the same account, the destination offers a handoff: one future UTC boundary splits the timeline, the collector keeps everything before it and Kiki everything from it onward, and a single agreement covers both. Kiki does not rewrite the collector's state file, read its key, or stop its service.

For a request that appears stuck, open **Live → Request details** before changing a limit. A queued row names the local blocking rule; a provider HTTP 429 is diagnosed from the provider error instead. Local queue-full, timeout, and rejection errors need different adjustments. See [`request_governance`](../configuration/config-files.md#request-governance) for the fields, copyable examples, and error codes. External executors are unmanaged; these counts are not their activity or the provider account's total usage.

## CLI counterpart

The TUI does not use the **Settings** dialog: client preferences in the terminal (theme, editor, and so on) are configured through `tui.toml` and the interactive commands `/config`, `/theme`, and `/editor`; see [`tui.toml`](../configuration/config-files.md#tui-toml). Agent and runtime settings live in `config.toml`.
