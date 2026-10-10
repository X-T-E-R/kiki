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

## Models and Recipes

**Settings → Models & providers → Available models** opens each model's editor. Change its request settings and prompt text here, then **Save** once. The identity selector keeps common, main-agent and independent-agent drafts separate; saving includes edits made in all three. Editing text loaded from a file stores an inline copy on the model, leaving the source file unchanged. Advanced fields edit the same model rather than a second form.

Opening a prompt does not by itself leave the shared group. While main or independent still follows that group, the first **Save** of a prompt copies the whole effective group onto that identity, including unchanged file references and timing. Later edits to the shared group no longer change it. A steering source set to **Follow the user-message setting** uses the steering text and timing already in effect for user messages on the selected identity. That is the saved steering, not the words of the user message. After the identity has its own prompt copy, this reads the steering on that copy. A source left unconfigured stays off.

Usage fields on an identity are separate from that copy. Changing **Default thinking effort**, **Service tier**, **Max generated tokens**, **Automatic compaction point**, or **Context budget** writes only that field. When a shared **Context budget** or **Max generated tokens** is already set, a higher value on the identity does not raise it, and a lower value tightens it. **Default thinking effort**, **Service tier**, and **Automatic compaction point** take the identity's value. **Use shared again** restores that field; leaving a field out of the save keeps it.

**Model switching** is under **Settings → Models & providers → Defaults**. It sets the default and **Ask before switching**. **Direct** keeps the current context, **Summarize first** compacts it, and **Fresh context** starts a new window. Exception rules match canonical model ids. `*` and `?` are the only wildcards, an empty side matches any model, and the first enabled rule wins. **Save rules** replaces that list and does not change the default or the ask setting. The fields are [`[model_switch]`](../configuration/config-files.md#model-switch).

A [Recipe](../customization/prompt-fields.md#recipe-model-presets) contributes a reusable set of prompt and model-setting overrides. In the model editor, choose **Choose a Recipe**, then browse installed packages, configured markets or **Import**. Preview a URL or an absolute path on the server; HTTPS ZIP imports also need their SHA-256 checksum. Reading or selecting a package does not apply it.

- **Apply to model** commits the selected Recipe together with the model's current unsaved edits. **Restore manual settings** removes that model's Recipe reference and saves those edits too; it does not erase saved manual values or a profile's separate Recipe.
- **Install and apply** installs the preview and performs that same model save. **Install only** stores the package without applying it or saving model drafts. If applying fails, the installation, selection and drafts remain; correct the reported problem and retry **Apply to model** without reinstalling.
- **Copy and edit** creates an independent local Recipe; **Extend from this** keeps a parent reference. In its author view, edit **Prompt words** or **Source files**, then **Save Recipe**. This saves the package, not a new model selection. Mixed inline/file text stays in separate editable segments. A notice appears when a prompt edit will rewrite the manifest's TOML formatting; file-only edits leave that manifest unchanged.
- **Download as ZIP** shares the accepted package, including inherited content, without uploading it. Save author drafts first. A profile can also reference an installed Recipe through its [Markdown frontmatter](../customization/prompt-fields.md#recipe-model-presets).

Recipe values cover only the fields or prompt slots they declare; uncovered settings keep their lower-layer values, and explicit profile differences still apply. A running conversation keeps its bound revision. Use [Rebuild context](../customization/agents.md#rebuilding-a-session-context) while idle to adopt current sources.

## About

**Settings → About** shows the current version and owns the update settings. **Update channel** picks Stable or Beta, and every check — automatic or manual — reads the channel from here. **Check for updates automatically** turns the daily check on or off; with it off, only **Check for updates** checks. The **When an update is found** setting applies: **Notify me** shows a dialog with the version and a short summary and waits for you, while **Download and install** starts the install without that dialog. Either way, Kiki asks before closing spaces that still have running work.

The dialog's three choices are saved rather than repeated each time: **Remind me tomorrow** comes back 24 hours later, **Skip this version** silences that version on that channel only, and a newer version still comes either way. Before installing, Kiki re-checks the channel and the version and refuses an offer that has changed underneath you. If a choice cannot be saved, the dialog stays open and asks you to try again. See [Kiki desktop](../getting-started/desktop-app.md#update).

## Agents

**Settings → Agents** picks a workspace and shows its default main profile (the agent's configuration file), the source in effect, and the subagent capabilities. File-backed profiles can be edited at the source shown. **Settings → Agents → Prompt** edits the `[prompt]` prompt-field overrides section in `config.toml`; expand the card first. See [Agents and subagents](../customization/agents.md#capability-visibility) and [Prompt field overrides](../customization/prompt-fields.md).

The periodic long-term memory reminders run on their own schedule. To stop just those while keeping the new standing-instruction and pre-compaction checks, set `memory_maintenance = false` in `config.toml`; memory tools, approval and task notes stay available. See [Continuity reminder settings](../configuration/config-files.md#continuity-reminder-settings).

## Search & retrieval

**Settings → Search & retrieval → Overview & source** inspects the built-in search and retrieval module — the capability behind the `WebSearch` and `FetchURL` tools — showing which configuration source is in effect and whether the server reuses the local search configuration. The equivalent configuration lives in `config.toml` — see [Configuration files](../configuration/config-files.md#nb-search).

The same section's **Advanced & diagnostics** tab carries a **Full-text index** card for searching your own session history. The first index is built in the background, newest sessions first, and the card counts what is done so far. If the index stops for a reason you can fix, that card is where **Restart the indexer** appears; when indexing is off or unavailable by configuration, there is nothing to restart and the reason is stated instead.

## Browser control

**Settings → Browser control** (`/settings/browser-control`) manages saved browser connections. One connection is one controllable browser location; opening the page reads and edits them and starts no browser.

A connection has a fixed id, a display name, and one of two styles, which point at different targets:

- **Profile (Independent agent browser):** Kiki starts and manages a browser of its own on the server, with a profile (sign-in state) of its own — your everyday browser cookies are not copied. Optional extras: an installed Chrome or Edge instead of the bundled one, and **Show the browser window** (off by default, so it starts headless).
- **CDP (Existing or remote browser):** attaches to a browser that already exposes a CDP address and starts nothing new. That address names the machine the browser runs on, which may be a different machine.

The driver, and any browser Kiki starts, run on the Kiki server — not on the device showing this window. **Check components** starts the managed driver and reads its session and tab state; **Check connection** handshakes with the CDP endpoint and lists its targets. Neither opens a page. **Start browser** and **Attach browser** are the separate actions that connect. Saving writes configuration only and ends that connection's current running session first. **Disconnect** releases the connection, and what happens to the browser depends on who started it: a borrowed CDP browser stays, an instance Kiki started is closed.

**Preparing the components is a step of its own**, and it comes first. **Prepare browser components** reports the managed driver and an independent Chrome as **Ready** or **Not prepared**; **Install components** downloads and verifies the ones that are missing, and **Recheck** reads the state again. On a host that cannot install them, automatic setup is not offered and you point the connection at a driver and a browser you already have. The page keeps the order visible: prepare the components, add and save the connection below, then check it and connect. The components are stored under `<Kiki home>/browser/resources` on the machine that runs them.

Agents use these connections through the [browser tools](../reference/tools.md#browser-tools), naming a connection by its id — never by display name. **Default connection** applies to sessions created afterwards; turning a connection off never swaps in another one.

Browser control is off by default. Turn on `native_browser` under **Settings → Developer → Experimental**, or set it under [`[experimental]`](../configuration/config-files.md#experimental), before connecting. While it is off, the page still reads and edits saved connections, but connecting is refused and agents get no browser tools. The connections themselves live in [`[browser_control]`](../configuration/config-files.md#browser-control).

## Computer control

**Settings → Computer control** brings together the connected machine, executor installation, model usage preference, and computer MCP connections. Desktop actions run on the machine hosting the Kiki server, through a pinned open-source executor; nothing is installed or connected automatically.

**Model usage preference** defaults to **Avoid**: models generally avoid computer control unless you or your rules explicitly request it, and prefer existing CLI, API, MCP, short-script, and browser-specific capabilities. **Prefer** favors computer control for suitable interactive tasks. Both choices respect your current explicit instructions, tool availability, correctness, and permissions. Saving changes guidance on the next model request, not tool permissions or installation. The source tag shows the effective configuration layer; **Restore inherited** removes this server's override and adopts the inherited value, which can also be **Prefer**. A failed save keeps your draft.

**Install executor** downloads and verifies that release, then registers a global MCP connection named `kiki-computer` (the driver's path plus `mcp` arguments). **Installed** means the files verified — it does not check that anything can actually be controlled, and it does not touch the desktop. The page names the machine that would be driven: **Kiki server** is the connected server, so over a remote or SSH connection the desktop is that host's own graphical session.

The main agent of each session uses the executor's own tools through the existing [MCP](../server/mcp.md) mechanism and permissions. Children need an explicit computer-tool opt-in; the usage preference does not enable their tools. See [`computer_control`](../configuration/config-files.md#computer-control) for the field and tool-selection rules. The pinned Windows executor watches the primary display and cannot pick a different one. On macOS the desktop permission travels in the calling process, so grant it where the driver reports it missing.

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

  A **vibecafe.ai** destination signs in from the page itself: press **Sign in to VibeCafe**, approve it in your browser with the code it shows, and the page confirms the connection on its own. There is no authorization code to copy, and no address, client id, or key to fill in — the destination is `https://vibecafe.ai`. A custom address, or a key you supply yourself, is the advanced path instead.

Existing `/usage?panel=limits` links open Live and focus the concurrency-rule section; there is no separate Limits tab.

External sync stays off until the server enables the `usage_export` flag. Signing in does not change that: an approved credential is stored, the destination stays **disabled**, and no consent has been given — so the order still holds, choose a destination, preview the exact payload, agree once, then enable. A destination that has not been agreed to sends nothing. Widening the range, changing the endpoint, or changing a credential to a different identity asks again, while shrinking the range or changing the interval does not. Pausing keeps the queue and the signed-in account. **Pause**, and **Disable sync** on a vibecafe.ai destination, turn sending off (`enabled` false, state `disabled`, no next time) and leave the account on the page. Removing asks whether to discard the queued batches and is the action that deletes the stored credential. Asking the service to delete what it already holds is a separate action. See [`kiki usage-export`](../reference/command.md#kiki-usage-export) for the command-side equivalent.

A **Script** destination runs your command as your own OS user with your ordinary permissions — it can read files and reach the network on its own, and this is not a sandbox. Kiki writes only the content-free batch to its stdin and reads a receipt from its output.

For a request that looks stuck, open **Live → Request details** before changing a limit. A queued row names the local rule blocking it, and a provider HTTP 429 is diagnosed from the provider's own error — a full local queue, a timeout and a rejection each need a different fix. [`request_governance`](../configuration/config-files.md#request-governance) has the fields, examples and error codes. External executors are not counted here.

## CLI counterpart

The TUI has no **Settings** dialog. Terminal-side preferences (theme, editor, and the rest) are configured in `tui.toml` or with the interactive `/config`, `/theme` and `/editor` commands — see [`tui.toml`](../configuration/config-files.md#tui-toml). Agent and runtime settings live in `config.toml`.
