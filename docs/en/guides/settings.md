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

**Settings → Models & providers → Connections** (`/settings/ai?tab=providers`) is one list. Every way Kiki reaches a model is a **connection** — an account you sign in to, a hosted API you hold a key for, or a server on this machine — and each row says how it is reached, what it carries, and whether it works. How it authenticates is part of the connection, not a separate list to keep in step.

**Add connection** is the single way in, and it asks one question — which service, by what means:

- **Sign in with an account** — the subscriptions this server offers: Kimi Code, a ChatGPT account for Codex, a Grok Build account, GitHub Copilot. An account you already have a connection for is not offered again; a sign-in that has gone stale is recovered on that connection's own row.
- **From the directory** — pick a service from models.dev and Kiki fills in its address and model list. An id that already exists updates that connection, and the form says so before you press.
- **Enter it myself** — a protocol, an address and a key, for a service the directory does not have, including a local server.

An account connection is written by the sign-in, so its row has no protocol, address or key to fill in. Expand it to see which account is behind it, what the vendor says it has left, and the action that changes the sign-in:

- **Connected** — the credential works, and Kiki renews it on its own. **Sign out** ends that sign-in inside Kiki and removes the models it added; at the provider you stay signed in.
- **Sign-in expired** — the provider no longer accepts it. **Sign in again** replaces it on this same connection; nothing is added to the list.
- **Sign-in didn't finish** — the flow ended without a credential: you declined it, the code expired, or it failed. One line says which, and the row is left as the server reports it.
- **Waiting for you** — a sign-in is running, with the code, **Open verification page**, how long it stays valid, and **Cancel sign-in**.

A completed sign-in adds that account's models to the catalog on the server. **Available models** is where you check what you can actually use — a row here reports the connection and its sign-in state.

Signing out here affects Kiki only. The provider keeps its own record of your subscription, and signing in again reconnects the same account.

### Reusing a sign-in this machine already has

For ChatGPT (Codex) and Grok Build, a connection can use the sign-in their own app already holds on this machine instead of a new one. Kiki reuses it and renews it when it runs out; it does not copy the credential, does not start the other app, and signing in or out here does not change anything there.

"This machine" is the machine Kiki's **server** runs on. That is usually the one you are looking at; when it is not, **Look somewhere else on the server** takes a directory to read from instead.

**Check this machine** reports which account is on the other side and where it is kept — a file, the system keyring, or an encrypted store — and **Use this sign-in** then attaches that exact account. A credential that was replaced in between is refused rather than adopted, and one that is due for renewal is used and renewed.

If the machine cannot be used, the page says why in terms you can act on — no account for that service, signed out, stored somewhere unreadable, or belonging to a different account — and offers nothing to attach.

**Stop using it** lets go of the machine's sign-in for this connection. It removes Kiki's reference and the models it provisioned; the sign-in itself is still there, and the other app is unaffected.

### Timeouts

**Settings → Models & providers → Connections** carries two separate timeouts, and they govern different requests:

- **Request timeout** — the default deadline for ordinary requests this interface makes to the Kiki server.
- **Reading timeout** — how long a history or content read may wait before Kiki gives up on it. The default is `0`, meaning no deadline: a large or slow conversation loads as long as it takes. Set a number of seconds if you would rather a stalled read fail quickly.

A reading timeout only bounds waiting; it never limits how much can be read. A changed value applies to the **next** read — it does not interrupt one already running, and it does not reconnect anything. Leave it at `0` unless you specifically want a ceiling. These are GUI settings, not keys in `config.toml`; the server-side memory budgets that govern how much history is kept in memory are separate — see [`transcript_memory`](../configuration/config-files.md#transcript-memory).

## About

**Settings → About** shows the current version and owns the update settings. **Update channel** picks Stable or Beta, and every check — automatic or manual — reads the channel from here. **Check for updates automatically** turns the daily check on or off; with it off, only **Check for updates** checks. The **When an update is found** setting applies: **Notify me** shows a dialog with the version and a short summary and waits for you, while **Download and install** starts the install without that dialog. Either way, Kiki asks before closing spaces that still have running work.

The dialog's three choices are saved rather than repeated each time: **Remind me tomorrow** comes back 24 hours later, **Skip this version** silences that version on that channel only, and a newer version still comes either way. Before installing, Kiki re-checks the channel and the version and refuses an offer that has changed underneath you. If a choice cannot be saved, the dialog stays open and asks you to try again. See [Kiki desktop](../getting-started/desktop-app.md#update).

## Agents

**Settings → Agents** picks a workspace and shows its default main profile (the agent's configuration file), the source in effect, and the subagent capabilities. File-backed profiles can be edited at the source shown. **Settings → Agents → Prompt** edits the `[prompt]` prompt-field overrides section in `config.toml`; expand the card first. See [Agents and subagents](../customization/agents.md#capability-visibility) and [Prompt field overrides](../customization/prompt-fields.md).

The periodic long-term memory reminders run on their own schedule. To stop just those while keeping the new standing-instruction and pre-compaction checks, set `memory_maintenance = false` in `config.toml`; memory tools, approval and task notes stay available. See [Continuity reminder settings](../configuration/config-files.md#continuity-reminder-settings).

## Notifications & messages

Under **Settings → Notifications & messages → System notifications**, **Allow system notifications** controls session notifications and pending-input reminders from other spaces on this device. The default-on **Notify when the conversation finishes** switch uses the existing notification path while Kiki is hidden or unfocused. Completion means the assigned work has settled: the main agent has finished, finite background tasks and subagents have settled, and their results and any automatic continuation have been handled. A turn ending alone does not notify. Resident servers, watchers and future schedules do not keep work unfinished; approvals, questions, failures and user stops are not completion notices. In a browser, allow this site to send notifications; if you previously denied permission, restore it in the address bar’s site permissions.

For configured phone or team-chat channels, enable **The conversation finishes** on each channel; it uses the same work-completion decision. **Send notifications** remains their separate master switch; previously disabled masters, connections and channels stay disabled. New configurations default to on with **Skip short work** at `0` seconds, so short replies qualify too. Raising it filters short-work notices for those channels, without changing what completion means. System-notification switches are saved on this device; channel rules are saved by the connected server. Launching or reconnecting does not replay old completion notices.

## Search & retrieval

**Settings → Search & retrieval → Overview & source** inspects the built-in search and retrieval module — the capability behind the `WebSearch` and `FetchURL` tools — showing which configuration source is in effect and whether the server reuses the local search configuration. The equivalent configuration lives in `config.toml` — see [Configuration files](../configuration/config-files.md#nb-search).

The same section's **Advanced & diagnostics** tab carries a **Full-text index** card for searching your own session history. The first index is built in the background, newest sessions first, and the card counts what is done so far. If the index stops for a reason you can fix, that card is where **Restart the indexer** appears; when indexing is off or unavailable by configuration, there is nothing to restart and the reason is stated instead.

## Browser control

**Settings → Browser control** (`/settings/browser-control`) opens on three named routes. Pick one, set it up, connect it — usually two actions.

- **Kimi Browser Extension**: drives the browser you already use, with your own sign-ins. Kiki installs the plugin and the local bridge; the extension is added once from your browser's store, and only you can click through that approval.
- **Independent browser**: Kiki starts and keeps a browser of its own, with its own sign-ins that never touch your everyday browser. **Set up** downloads and verifies the components it needs; **Connect** then starts it.
- **Codex / ChatGPT browser extension**: driven by the Codex / ChatGPT desktop app. Kiki neither installs nor controls this one, so the row carries its official instructions and nothing else.

Each row states its own status and **what it still needs**, and puts the next action on that same line: **Set up** while a component is missing, the store link while only the approval is left, and **Turn on browser control** while only the switch is. Once everything Kiki can install is in place, the row stops asking you to install and tells you it is ready to connect. The detector's own sentences — which parts are merely reported rather than verified — sit in the **What this server checked** fold, off the first screen.

**Turn on browser control** is the same consented action, on this page. When the switch is the only thing missing, that one confirmation installs whatever is still missing — nothing at all when the components are already in place — enables the plugin, and turns browser control on for the server. The confirmation says all three before you accept. Browser control is off by default, so this is the step that switches it on; there is no separate switch to find on another page.

If something outside this page holds browser control off — an environment variable, or a runtime override on that host — no action here can change it. The row says exactly that instead of offering a button, and **See what holds it off** names the override responsible.

The **Advanced: edit connections, or connect a browser you already run** fold holds what you type rather than pick. A connection has a fixed id, a display name, an enable switch, and one of two styles that point at different targets:

- **Profile (Independent agent browser)**: Kiki starts and manages a browser of its own on the server, with a profile (sign-in state) of its own — your everyday browser cookies are not copied. Optional extras: an installed Chrome or Edge instead of the bundled one, and **Show the browser window** (off by default, so it starts headless).
- **CDP (Existing or remote browser)**: attaches to a browser that already exposes a CDP address and starts nothing new. That address names the machine the browser runs on, which may be a different machine.

Each connection can be checked, connected and disconnected on its own. A check starts the managed driver and reads its session and tab state; a CDP connection handshakes with the endpoint and lists its targets. Neither opens a page. Saving writes configuration only and ends that connection's current running session first. **Disconnect** releases the connection: a borrowed CDP browser stays, an instance Kiki started is closed. **Default connection** applies to sessions created afterwards; turning a connection off never swaps in another one.

The driver, and any browser Kiki starts, run on the Kiki server — not on the device showing this window; the components live under `<Kiki home>/browser/resources` on the machine that runs them.

Agents use these connections through the [browser tools](../reference/tools.md#browser-tools), naming a connection by its id — never by display name. The switch and the connections themselves live under [`[experimental]`](../configuration/config-files.md#experimental) and [`[browser_control]`](../configuration/config-files.md#browser-control) respectively.

## Computer control

**Settings → Computer control** drives the desktop of the machine running the Kiki server, through a pinned open-source executor. Nothing is installed or configured by default, so the page starts empty.

**Install executor** downloads and verifies that release, then registers a global MCP connection named `kiki-computer` (the driver's path plus `mcp` arguments). **Installed** means the files verified — it does not check that anything can actually be controlled, and it does not touch the desktop. The page names the machine that would be driven: **Kiki server** is the connected server, so over a remote or SSH connection the desktop is that host's own graphical session.

The agent drives it with the executor's own tools, through the existing MCP mechanism and permissions — see [MCP](../server/mcp.md). The pinned Windows executor watches the primary display and cannot pick a different one. On macOS the desktop permission travels in the calling process, so grant it where the driver reports it missing.

**Stop control** ends the cua processes this service started and disables an editable connection's configuration. Another client or another Kiki instance may still be driving that desktop.

## Composer

The **Composer → Persist composer drafts** toggle controls whether new-session choices (model, effort, workspace, working directory, profile) and per-session draft text are written to this browser. Turning it off clears the saved store. See [Workspace and session management](./sessions.md#session-storage).

## Dispatch capabilities

Open **Dispatch capabilities** — next to the new-session workspace selector, or in a session's right rail — to inspect a subagent's profile (configuration file), route, and executor, plus where the default model and effort come from. Default configuration validity and permission to launch are shown separately. See [Agents and subagents](../customization/agents.md#rebuilding-a-session-context).

## Session controls

### Effective prompts

In a session, open the header's **⋯ → Effective prompts**. The drawer opens independently of the right rail, including on narrow screens, and shows the current agent identity, profile, model and executor, the prompt channels and their source order, field overrides with the reason for each, file locations, and the cognition-anchor scope.

The binding and disk revisions help you spot which source files changed. To actually reload the session's prompt sources, use [Rebuild context](../customization/agents.md#rebuilding-a-session-context) once the session is idle. **Check all branches** is a separate action that inspects the configured common, main-agent and independent-agent prompt files without switching the current identity.

### Cockpit

On desktop-width screens, **Standard / Cockpit** in the right-panel header switches the panel between its normal width and a wide one that takes over the preview space. The conversation and composer stay in the main column either way, and **Standard** or **Exit cockpit** puts the previous preview content, tabs, draft and width back. Opening a file, an agent detail or a skill preview also leaves cockpit.

## Usage

Open **Usage** in the sidebar (`/usage`). It has three tabs and opens **History** by default:

- **History:** token usage and estimated cost for a date range, defaulting to today. Token usage and cost have separate completeness indicators; **Data reliability** distinguishes unknown providers from empty ranges. Existing filtered usage links open History. See [Usage statistics](./sessions.md#gui-usage-statistics).
- **Live:** running and queued native-request counts across this service. Expand **Request details** for the breakdown by model, provider, and role, and waiting rows with blocking rule IDs and elapsed queue time. If the connection fails, the last counts are marked stale. On the same tab, **Concurrency limits** lets you add or edit rules, choose a model or provider target, and set a shared or per-session cap. The switch pauses a rule without deleting it. Saving applies the rule to new and queued requests without stopping active streams.
- **External sync:** destinations that receive this server's own usage. Three kinds are available: **vibecafe.ai**, **Kiki webhook**, and **Script**. Only the model, the UTC half-hour, the four token counts, quality and cost go out — never a prompt, answer, title, workspace name or path.

  A **vibecafe.ai** destination signs in from the page itself: press **Sign in to VibeCafe**, approve it in your browser with the code it shows, and the page reports the result. There is no authorization code to copy, and no address, client id, or key to fill in — the destination is `https://vibecafe.ai`. A custom address, or a key you supply yourself, is the advanced path instead. The flow has not been exercised against the live service: if it does not complete, the destination stays as the page left it and nothing has been sent.

A **Kiki webhook** destination takes your own HTTPS endpoint, with `none`, `bearer`, or `hmac` authentication and optional gzip. A secret is stored either in the system keyring or, if you choose that explicitly, in a private file on the server — the keyring is not silently substituted if it fails, and the file is protected by filesystem permissions rather than encrypted at rest.

Existing `/usage?panel=limits` links open Live and focus the concurrency-rule section; there is no separate Limits tab.

External sync needs no experimental switch; without a destination nothing is sent. Signing in only stores an approved credential: the destination stays **disabled** and no consent has been given. Choose a destination, preview the exact payload, agree once, then enable.

A destination that has not been agreed to sends nothing. Widening the range, changing the endpoint, or changing a credential to a different identity asks again, while shrinking the range or changing the interval does not. Pausing keeps the queue, removing asks whether to discard the queued batches, and asking the service to delete what it already holds is a separate action. On upgrade, an explicit off choice for the retired `usage_export` flag pauses existing destinations once, keeping their consent and queued data; resume each destination when you want it to send again. See [`kiki usage-export`](../reference/command.md#kiki-usage-export) for the command-side equivalent.

A **Script** destination runs your command as your own OS user with your ordinary permissions — it can read files and reach the network on its own, and this is not a sandbox. Kiki writes only the content-free batch to its stdin and reads a receipt from its output.

For a request that looks stuck, open **Live → Request details** before changing a limit. A queued row names the local rule blocking it, and a provider HTTP 429 is diagnosed from the provider's own error — a full local queue, a timeout and a rejection each need a different fix. [`request_governance`](../configuration/config-files.md#request-governance) has the fields, examples and error codes. The rules cover the model requests this service sends itself: when you run a turn on Codex, Claude Code, or Grok Build as the engine, those requests are the engine's own and are not counted here, while an external tool calling back into Kiki for a native request is.

## CLI counterpart

The TUI has no **Settings** dialog. Terminal-side preferences (theme, editor, and the rest) are configured in `tui.toml` or with the interactive `/config`, `/theme` and `/editor` commands — see [`tui.toml`](../configuration/config-files.md#tui-toml). Agent and runtime settings live in `config.toml`.
