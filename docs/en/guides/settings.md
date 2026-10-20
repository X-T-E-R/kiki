# Settings pages

The Kiki desktop app exposes preferences in the **Settings** dialog and activity on separate pages such as **Usage** in the sidebar. This page helps you find each control and what it changes; the linked pages hold the full reference.

The settings sidebar groups twenty entries under seven headings: **App**, **Models & agents**, **Sessions & work**, **Capabilities**, **Permissions & rules**, **Connection & remote**, and **Advanced**. Four of them merge what used to be separate pages and are switched by tab — **Models & providers**, **Agents**, **Extensions & tools**, and **Browser & computer** — so a path below that ends in a tab name is one click inside the entry.

**"I want to change X" quick lookup:**

| I want to change… | Go to |
| --- | --- |
| Sign in with a subscription, or add an API key | **Models & agents → Models & providers → Connections** |
| How outbound requests identify themselves | **Models & agents → Models & providers → Identity** |
| Version and update channel (Stable / Beta) | **Advanced → About & updates** |
| Agent profiles, prompt-field overrides | **Models & agents → Agents → Agent profiles** |
| Low-frequency long-term memory reminders | [`loop_control.continuity_cadence.memory_maintenance`](../configuration/config-files.md#continuity-reminder-settings) in `config.toml` |
| Whether input drafts are remembered | **App → General** |
| Background-task limits and scheduled tasks | **Sessions & work → Sessions** |
| Search and retrieval configuration source | **Capabilities → Search & retrieval** |
| Installed plugins, skills, and MCP servers | **Capabilities → Extensions & tools** |
| Subagent dispatch configuration | **Models & agents → Agents → Subagents & dispatch** for server-wide defaults; **Child agents** on a single profile remains in **Agent profiles** |
| Run a browser for agent tasks | **Capabilities → Browser & computer → Browser control** |
| Drive the server's own desktop | **Capabilities → Browser & computer → Computer control** |
| Experimental features | **Advanced → Developer & labs**, under **Where experimental features live** |
| Inspect this session's prompt sources | Session header **⋯ → Effective prompts** |
| Temporarily use the preview space for the cockpit | Right-panel header **Cockpit** |
| Token usage and cost | **Usage → History** |
| Running or queued model requests | **Usage → Live** |
| Model/provider request concurrency | **Usage → Live → Concurrency limits** |
| Send usage to another service | **Usage → External sync** |
| TUI theme, editor, and other CLI-side preferences | The `/config` commands in the terminal, see [CLI counterpart](#cli-counterpart) |

## Connections

**Settings → Models & agents → Models & providers** opens **Connections** (`/settings/ai?tab=providers`), the first of the page's four tabs; **Models**, **Defaults**, and **Identity** sit beside it. `/settings/providers` opens the same tab. The page has three blocks, in this order.

**① API key providers** lists hosted APIs you reach with a key. An empty list in this block does not mean the page has no connections.

**Add connection** adds a service you reach with a key. With nothing connected yet, the form is the page; otherwise it opens beside the lists. It asks which service, and how:

- **From the directory** — pick a service from models.dev and Kiki fills in its address and model list. An id that already exists updates that connection, and the form says so before you press.
- **Enter it myself** — a protocol, an address and a key, for a service the directory does not have, including a local server.

Once any connection exists, search covers every configured connection. The new row appears in the block for how it is reached.

**② Account sign-in (subscription)** lists the subscription accounts already connected: Kimi Code, a ChatGPT account for Codex, a Grok Build account, GitHub Copilot. An account that is not connected yet has **Sign in** in this block. An account you already have a connection for is not offered again; a sign-in that has gone stale is recovered on that connection's own row.

**③ Local HTTP and CLI** holds a server on this machine and local programs such as AGY CLI, Codex, and Claude Code. Once a CLI program is enabled, choose it from the conversation's runtime picker. **Let an outside client use Kiki** opens **Connection & remote → Access from elsewhere** (`/settings/connection-services`). `/settings/external-clients` opens the same page.

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

Open **Settings → Connection & remote → Connection**, then **Current connection** and **HTTP requests** (`/settings/connection?tab=current`). These settings govern requests from this interface to the Kiki server, not the provider connections above:

- **Request timeout (seconds)** — the default deadline for ordinary requests this interface makes to the Kiki server.
- **Reading timeout (seconds)** — how long a history or content read may wait before Kiki gives up on it. The default is `0`, meaning no deadline: a large or slow conversation loads as long as it takes. Set a number of seconds if you would rather a stalled read fail quickly.

A reading timeout only bounds waiting; it never limits how much can be read. A changed value applies to the **next** read — it does not interrupt one already running, and it does not reconnect anything. Leave it at `0` unless you specifically want a ceiling. These are GUI settings, not keys in `config.toml`; the server-side memory budgets that govern how much history is kept in memory are separate — see [`transcript_memory`](../configuration/config-files.md#transcript-memory).

## Models and Recipes

**Settings → Models & agents → Models & providers** opens **Connections**. **Models** (`/settings/ai?tab=models`) is the catalog and each model's editor. **Defaults** (`/settings/ai?tab=defaults`) is where the other task models are set. **Identity** (`/settings/ai?tab=identity`) decides how outbound requests introduce themselves.

Above the tabs, **New sessions use** changes the model a new session starts with as soon as you pick one. The titles, fast model, and subagents listed beside it open **Defaults**, where you change them.

On **Models**, change a model's request settings and prompt text, then **Save** once. The identity selector keeps common, main-agent and independent-agent drafts separate; saving includes edits made in all three. Editing text loaded from a file stores an inline copy on the model, leaving the source file unchanged. Advanced fields edit the same model rather than a second form.

Opening a prompt does not by itself leave the shared group. While main or independent still follows that group, the first **Save** of a prompt copies the whole effective group onto that identity, including unchanged file references and timing. Later edits to the shared group no longer change it. A steering source set to **Follow the user-message setting** uses the steering text and timing already in effect for user messages on the selected identity. That is the saved steering, not the words of the user message. After the identity has its own prompt copy, this reads the steering on that copy. A source left unconfigured stays off.

Usage fields on an identity are separate from that copy. Changing **Default thinking effort**, **Service tier**, **Max generated tokens**, **Automatic compaction point**, or **Context budget** writes only that field. When a shared **Context budget** or **Max generated tokens** is already set, a higher value on the identity does not raise it, and a lower value tightens it. **Default thinking effort**, **Service tier**, and **Automatic compaction point** take the identity's value. **Use shared again** restores that field; leaving a field out of the save keeps it.

**Model switching** is under **Defaults** on that page (`/settings/ai?tab=defaults`). It sets the default and **Ask before switching**. **Direct** keeps the current context, **Summarize first** compacts it, and **Fresh context** starts a new window. Exception rules match canonical model ids. `*` and `?` are the only wildcards, an empty side matches any model, and the first enabled rule wins. **Save rules** replaces that list and does not change the default or the ask setting. The fields are [`[model_switch]`](../configuration/config-files.md#model-switch).

A [Recipe](../customization/prompt-fields.md#recipe-model-presets) contributes a reusable set of prompt and model-setting overrides. In the model editor, choose **Choose a Recipe**, then browse installed packages, configured markets or **Import**. Preview a URL or an absolute path on the server; HTTPS ZIP imports also need their SHA-256 checksum. Reading or selecting a package does not apply it.

- **Apply to model** commits the selected Recipe together with the model's current unsaved edits. **Restore manual settings** removes that model's Recipe reference and saves those edits too; it does not erase saved manual values or a profile's separate Recipe.
- **Install and apply** installs the preview and performs that same model save. **Install only** stores the package without applying it or saving model drafts. If applying fails, the installation, selection and drafts remain; correct the reported problem and retry **Apply to model** without reinstalling.
- **Copy and edit** creates an independent local Recipe; **Extend from this** keeps a parent reference. In its author view, edit **Prompt words** or **Source files**, then **Save Recipe**. This saves the package, not a new model selection. Mixed inline/file text stays in separate editable segments. A notice appears when a prompt edit will rewrite the manifest's TOML formatting; file-only edits leave that manifest unchanged.
- **Download as ZIP** shares the accepted package, including inherited content, without uploading it. Save author drafts first. A profile can also reference an installed Recipe through its [Markdown frontmatter](../customization/prompt-fields.md#recipe-model-presets).

Recipe values cover only the fields or prompt slots they declare; uncovered settings keep their lower-layer values, and explicit profile differences still apply. A running conversation keeps its bound revision. Use [Rebuild context](../customization/agents-and-subagents.md#rebuilding-a-session-context) while idle to adopt current sources.

The **Identity** tab is the central page for request identity: the global default, the built-in and custom identities, client versions, where each identity is used, and recent requests. A provider or a single model carries its own identity in that editor's **Request identity** section, and the later layer wins. An old `/settings/identity` address opens this tab. See [Request identity](../configuration/providers.md#where-to-configure-it).

## About

**Settings → Advanced → About & updates** (`/settings/about`) shows the current version and owns the update settings. **Update channel** picks Stable or Beta, and every check — automatic or manual — reads the channel from here. **Check for updates automatically** turns the daily check on or off; with it off, only **Check for updates** checks. The **When an update is found** setting applies: **Notify me** shows a dialog with the version and a short summary and waits for you, while **Download and install** starts the install without that dialog. Either way, Kiki asks before closing spaces that still have running work.

The dialog's three choices are saved rather than repeated each time: **Remind me tomorrow** comes back 24 hours later, **Skip this version** silences that version on that channel only, and a newer version still comes either way. Before installing, Kiki re-checks the channel and the version and refuses an offer that has changed underneath you. If a choice cannot be saved, the dialog stays open and asks you to try again. See [Kiki desktop](../getting-started/desktop-app.md#update).

## Agents

**Settings → Models & agents → Agents** has two tabs. **Agent profiles** (`/settings/agents?tab=profiles`), the default, lists the selected workspace's main and subagent profiles in one table — role, engine, model, effort, and who may dispatch whom — and marks the file each profile comes from. Open a row to edit its instructions and settings; a file-backed profile can also be edited at the source shown. The same tab holds **Identity and agent loading** and **Prompt fields**, which edits the `[prompt]` prompt-field overrides section in `config.toml`; expand the card first. **Subagents & dispatch** (`/settings/agents?tab=dispatch`) holds the defaults that apply across profiles — see [Dispatch capabilities](#dispatch-capabilities). See [Agents and subagents](../customization/agents-and-subagents.md#capability-visibility) and [Prompt field overrides](../customization/prompt-fields.md).

The periodic long-term memory reminders run on their own schedule. To stop just those while keeping the new standing-instruction and pre-compaction checks, set `memory_maintenance = false` in `config.toml`; memory tools, approval and task notes stay available. See [Continuity reminder settings](../configuration/config-files.md#continuity-reminder-settings).

## Notifications & messages

**Settings → App → Notifications & messages** (`/settings/notifications`) is its own entry in the settings sidebar.

Under **System notifications**, **Allow system notifications** controls session notifications and pending-input reminders from other spaces on this device. The default-on **Notify when the conversation finishes** switch notifies when you are not viewing that conversation, including when another conversation or Settings is open in Kiki. Completion means the assigned work has settled: the main agent has finished, finite background tasks and subagents have settled, and their results and any automatic continuation have been handled. A turn ending alone does not notify. Resident servers, watchers and future schedules do not keep work unfinished; approvals, questions, failures and user stops are not completion notices. In a browser, allow this site to send notifications; if you previously denied permission, restore it in the address bar’s site permissions.

Open the notified conversation to clear its unread badge. Focusing Kiki, visiting Home or Settings, or opening another conversation does not mark it read. Notification clicks open the same conversation in its original home and connection; other conversations remain unread. A conversation left open in a hidden or unfocused window is not marked read until you return to it. After a brief disconnect or app reopen, Kiki catches up completion receipts retained by the running server for ten minutes, without repeating receipts already observed on this device. The first launch does not replay historical completions.

For configured phone or team-chat channels, enable **The conversation finishes** on each channel; it uses the same work-completion decision. **Send notifications** remains their separate master switch; previously disabled masters, connections and channels stay disabled. New configurations default to on with **Skip short work** at `0` seconds, so short replies qualify too. Raising it filters short-work notices for those channels, without changing what completion means. System-notification switches are saved on this device; channel rules are saved by the connected server.

## Search & retrieval

**Settings → Capabilities → Search & retrieval** opens **Overview & source** (`/settings/search`). An old `/settings/environment-tools` address opens this page, and a `tab` there selects a search tab (`overview`, `search`, `fetch`, `providers`, or `advanced`). It inspects the built-in search and retrieval module — the capability behind the `WebSearch` and `FetchURL` tools — showing which configuration source is in effect and whether the server reuses the local search configuration. The equivalent configuration lives in `config.toml` — see [Configuration files](../configuration/config-files.md#nb-search).

The same section's **Advanced & diagnostics** tab carries a **Full-text index** card for searching your own session history. The first index is built in the background, newest sessions first, and the card counts what is done so far. If the index stops for a reason you can fix, that card is where **Restart the indexer** appears; when indexing is off or unavailable by configuration, there is nothing to restart and the reason is stated instead.

## Browser control

**Settings → Capabilities → Browser & computer** opens on its **Browser control** tab (`/settings/browser-control?tab=browser`), which has three setup routes. **Computer control** is the second tab.

**Enable browser control** sits at the top of the page. It stays on unless this server has turned it off. It makes browser tools available subject to the conversation’s tool settings. If the open conversation still has an older tool selection, **Apply current tool settings** previews the target conversation and updates only its tools after confirmation. Its prompt, model and history stay unchanged; explicit tool selections and denied tools remain restricted. Older bindings whose tool source is unknown are never widened automatically. The page shows how many browsers are currently allowed. **Default connection** beside that count chooses the browser new sessions use; **Choose each time** stores no default.

- **Kimi Browser Extension**: drives the browser you already use, with your own sign-ins. Kiki installs the plugin and local bridge; add the extension from your browser's store and approve it there. An existing usable bridge can connect even when its version differs from the bundled download. **Advanced options → Check and update** downloads the verified release; a failed update keeps the previous installation, and a running bridge stays on its current version.
- **Independent browser**: Kiki manages a separate browser and sign-in profile. **Set up** downloads its components; **Connect** starts control, and **Open browser** opens or activates its window. **Advanced options** provides **Check and update** and, on a Windows server, **Create desktop shortcut**. Updates keep a running browser unchanged; shortcuts appear on the server's desktop without overwriting unrelated shortcuts.
- **Codex / ChatGPT browser extension**: a setup route for the Codex or ChatGPT desktop app and its browser extension. It is not a connection type in the editor below. **Set up** prepares the bridge components. Choose a discovered **Available extension connection**, then **Save connection**. These are unverified endpoint candidates: desktop app tools share the same pipe-name prefix. Saving reports that the configuration is saved and connection verification is pending; only a successful browser handshake marks it **Connected**. Saving does not open the pipe, approve the extension, register a native host, or restart the browser. Kiki handles a real permission request when the app or extension sends one. **Official instructions** stay on the route. If no candidates are listed, check the official host and runtime diagnostics; an empty list alone does not mean the extension is disabled. Checking a discovered candidate that is not saved yet saves that connection, then allows the agent to use it, and leaves the current default unchanged. **Save connection** remains the way to save the candidate you picked in the list. If that save fails, the checkbox stays clear and the page says why, so you can try again.

Each route that lists browsers has **Allow agent use**, one checkbox per browser. Check it to let the agent use that browser; clear it to take the permission back. Several can be checked. On an allowed browser, **Default** marks the one new sessions use. Before it is selected the control reads **Set as default**. Press it on another allowed browser to move the mark, or press the current one to clear it. Allowing a browser and choosing the default are separate: clearing a checkbox leaves the default where it is, and a failed default change leaves the allowed browsers as they were and keeps the control so you can try again. The page says why. These checkboxes do not add another Kimi WebBridge.

Each row states its own status and **what it still needs**, and puts the next action on that same line: **Set up** while a component is missing, the store link while only the approval is left, and **Turn on browser control** while only the switch is. Once everything Kiki can install is in place, the Kimi and Independent rows stop asking you to install. A saved Codex selection stays pending until the browser handshake succeeds; a reported connection failure remains an error. The detector's own sentences — which parts are merely reported rather than verified — sit in the **What this server checked** fold, off the first screen.

**Turn on browser control** is the same consented action, on this page. When the switch is the only thing missing, that one confirmation installs whatever is still missing — nothing at all when the components are already in place — enables the plugin, and turns browser control on for the server. The confirmation says all three before you accept. Browser control is available by default; components still need consented setup and a connection starts only when requested. The action also restores a saved off choice when you explicitly confirm it.

If something outside this page holds browser control off — an environment variable, or a runtime override on that host — no action here can change it. The row says exactly that instead of offering a button, and **See what holds it off** names the override responsible.

The **Advanced: edit connections, or connect a browser you already run** fold holds saved connections and manual setup. Existing connections retain their id, type and default after upgrades; a display name never selects a provider. Saved Codex connections can be renamed or disabled here without changing their runtime or browser binding. Create new Codex bindings through the setup route above. For manual connections, choose one of two styles:

- **Profile (Independent agent browser)**: Kiki starts and manages a browser of its own on the server, with a profile (sign-in state) of its own — your everyday browser cookies are not copied. Optional extras: an installed Chrome or Edge instead of the bundled one, and **Show the browser window** (off by default, so it starts headless).
- **CDP (Existing or remote browser)**: attaches to a browser that already exposes a CDP address and starts nothing new. That address names the machine the browser runs on, which may be a different machine.

Each connection can be checked, connected and disconnected on its own. A check starts the managed driver and reads its session and tab state; a CDP connection handshakes with the endpoint and lists its targets. Neither opens a page. Saving writes configuration only and ends that connection's current running session first. **Disconnect** releases the connection: a borrowed CDP browser stays, an instance Kiki started is closed. **Default connection** applies to sessions created afterwards; turning a connection off never swaps in another one.

The driver, and any browser Kiki starts, run on the Kiki server — not on the device showing this window; the components live under `<Kiki home>/browser/resources` on the machine that runs them.

Agents use these connections through the [browser tools](../reference/tools.md#browser-tools), naming a connection by its id — never by display name. The switch and the connections themselves live under [`[experimental]`](../configuration/config-files.md#experimental) and [`[browser_control]`](../configuration/config-files.md#browser-control) respectively.

The **WebBridge readiness** card sits on this page too, below the routes. It states whether the Kimi Browser Extension bridge is working, offers **Check again**, and — while a component is missing — the consented **Set up WebBridge** action. Kimi WebBridge checks one fixed local bridge. A list of Codex extension pipes, or several independent-browser profiles, does not add Kimi WebBridge instances.

## Plugins

**Settings → Capabilities → Extensions & tools** (`/settings/extensions`) has three tabs: **Plugins** (the default, `/settings/plugins`), **Skills** (`/settings/skills`), and **MCP** (`/settings/mcp`). The **Plugins** tab lists installed plugins. Each row carries the plugin's own name, where it came from, its version, whether it is on or reporting errors, and a switch to turn it off without leaving the list. **Find plugins in the market** at the top is where new plugins are installed.

Selecting a plugin opens **its own settings page** (`/settings/plugins?plugin=<id>`): the plugin's name and state, a way back to the list, its settings, and a switch to turn it on or off. An enabled plugin can supply its own settings interface. Otherwise Kiki shows the fields its manifest declares, with Save and Discard after a field changes. If the plugin's interface fails to load, choose **Retry** or use those fields. Leaving with unsaved changes asks first.

**Remove plugin** is at the bottom of the page; it asks first and names what it takes with it, as the [plugin manager](../customization/plugins.md#install-and-manage) does. A plugin with neither settings fields nor its own settings interface still gets a page with its switch and Remove plugin.

The page has its own address, so you can copy it, refresh, or use the browser's back button and come back to the same plugin. The plugin's **Plugin settings** entry on the **Extensions & tools** page leads to it, and so does the package button on a [media source](../customization/plugins.md#configuring-a-source).

## Workspaces

**Settings → Sessions & work → Workspaces** (`/settings/workspaces`) lists the folders known to this server. Open a row to configure that workspace on its own page (`/settings/workspaces?workspace=<id>`): rename it, pin it, choose its [plugin defaults](../customization/plugins.md#choose-where-a-plugin-is-used), or set memory to inherit, on or off. Its root path is shown for identification, not edited here.

**Workspace trust** controls whether Kiki loads that project's configuration, MCP servers and hooks, and permits its project profiles to name external executors. Trust changes only when you explicitly use the switch; opening the page grants nothing and does not change tool approval mode. The **Agents**, **MCP servers** and **Skills** links keep this workspace as their target. Profiles retain their file source and write scope. MCP entries from plugins or project files are read-only here; editable user entries still save to the user configuration, not a new workspace copy. A missing workspace is reported rather than silently switching to another one.

## Computer control

**Settings → Capabilities → Browser & computer**, then the **Computer control** tab (`/settings/computer-control` opens that tab), brings together the connected machine, executor installation, model usage preference, and computer MCP connections. Desktop actions run on the machine hosting the Kiki server, through a pinned open-source executor; nothing is installed or connected automatically.

**Enable computer control** is the switch at the top of this page. It is on unless this server has turned it off. On, desktop observation and input (screen capture, mouse, keyboard) are tools the agent can be given. Off, those computer tools are left out. Changing the switch updates the tools a computer connection that is already running offers. Tool policy can still deny those tools, or only some of them, and the page says so. The switch does not install the executor or connect the desktop.

**Model usage preference** only guides the model. It does not grant or remove the permission the switch and tool policy decide. It defaults to **Avoid**: models generally avoid computer control unless you or your rules explicitly request it, and prefer existing CLI, API, MCP, short-script, and browser-specific capabilities. **Prefer** favors computer control for suitable interactive tasks. Both choices respect your current explicit instructions, tool availability, correctness, and permissions. Saving changes guidance on the next model request, not tool permissions or installation. The source tag shows the effective configuration layer; **Restore inherited** removes this server's override and adopts the inherited value, which can also be **Prefer**. A failed save keeps your draft.

**Install executor** downloads and verifies that release, then registers a global MCP connection named `kiki-computer` (the driver's path plus `mcp` arguments). **Installed** means the files verified — it does not check that anything can actually be controlled, and it does not touch the desktop. The page names the machine that would be driven: **Kiki server** is the connected server, so over a remote or SSH connection the desktop is that host's own graphical session.

The main agent of each session uses the executor's own tools through the existing [MCP](../server/mcp.md) mechanism and permissions. Children need an explicit computer-tool opt-in; the usage preference does not enable their tools. See [`computer_control`](../configuration/config-files.md#computer-control) for the field and tool-selection rules. The pinned Windows executor watches the primary display and cannot pick a different one. On macOS the desktop permission travels in the calling process, so grant it where the driver reports it missing.

**Stop control** ends the cua processes this service started and disables an editable connection's configuration. Another client or another Kiki instance may still be driving that desktop.

## Composer

**Settings → App → General** (`/settings/general`) holds **Persist composer drafts** on the **Composer & session** card. It controls whether new-session choices (model, effort, workspace, working directory, profile) and per-session draft text are written to this browser. Turning it off clears the saved store. See [Workspace and session management](./sessions.md#session-storage).

## Dispatch capabilities

On **Settings → Models & agents → Agents → Agent profiles** (`/settings/agents`), open a profile and use **Child agents** to decide what that agent may start. The **Subagents & dispatch** tab (`/settings/agents?tab=dispatch`) sets what applies across profiles: the default subagent, subagent model governance, the subagent panel's open mode, and the subagent tool settings. **Allow creating child agents** is **Not declared**, **Allowed**, or **Off**. **Not declared** follows the layer above this profile. **Off** stops this agent from starting child agents, including a definition supplied by path. **Preset list** chooses the named presets and routes it may start; a grey value is the child's own until you set one here. **Recommended first** is only an order, and does not allow or forbid a child. **Never dispatch** refuses those names even when the preset list would allow them. A missing model or preset is reported on the profile, separately from whether creating child agents is allowed. See [Agents and subagents](../customization/agents-and-subagents.md#rebuilding-a-session-context).

## Session controls

Session controls stay at `/settings/sessions` (**Sessions & work → Sessions**). **Sessions & work → Workspaces** opens workspaces and does not replace these addresses.

That page also carries **Task and background policy** — how many background tasks may run, the timeout that applies to Bash tasks, and what a non-interactive run does with work still in flight — and **Cron operations**, a read-only readout of the scheduled-task runtime. The task fields are stored under [`background`](../configuration/config-files.md#background).

**Import history** (`/settings/sessions/import`) opens Kiki's built-in importer, also available from **New session**. No plugin installation or activation is needed for the built-in formats; see [Session history import](../customization/plugins.md#session-history-import).

**Manage archived conversations** on `/settings/sessions` opens `/archived` for browsing, searching and reading archived conversations. It also offers permanent deletion of one conversation or all archives in the current connection's home, with confirmation and per-item failure recovery. See [Archive management](./sessions.md#gui-session-recovery-and-activity) for deletion scope.

**Session titles** on `/settings/sessions` also edits the instruction used to write automatic titles. The card names whether the built-in or custom instruction is active; **Show** reveals the server's built-in text as a read-only reference. Edit **Your instruction** and save, or choose **Restore the built-in default** to remove your override. Saving an empty instruction also restores the default. A failed save keeps your draft. These actions preserve the title model, selected moments and automatic-title switch, affect the next title request, and leave existing titles unchanged. See [`session_title`](../configuration/config-files.md#session-title).

### Effective prompts

In a session, open the header's **⋯ → Effective prompts**. The drawer opens independently of the right rail, including on narrow screens, and shows the current agent identity, profile, model and executor, the prompt channels and their source order, field overrides with the reason for each, file locations, and the cognition-anchor scope.

The binding and disk revisions help you spot which source files changed. To actually reload the session's prompt sources, use [Rebuild context](../customization/agents-and-subagents.md#rebuilding-a-session-context) once the session is idle. **Check all branches** is a separate action that inspects the configured common, main-agent and independent-agent prompt files without switching the current identity.

### Cockpit

On desktop-width screens, **Standard / Cockpit** in the right-panel header switches the panel between its normal width and a wide one that takes over the preview space. The conversation and composer stay in the main column either way, and **Standard** or **Exit cockpit** puts the previous preview content, tabs, draft and width back. Opening a file, an agent detail or a skill preview also leaves cockpit.

## Usage

Open **Usage** in the sidebar (`/usage`). The tabs are **Live**, **History**, **Quotas**, and **External sync**, in that order. With no history filter and no `panel=` choice, the page opens **Live**. An address that already filters history, or `panel=history`, opens **History**. `panel=realtime` and `panel=limits` open **Live**.

- **Live:** model requests and live agents appear as two vertically arranged groups, each with its own expandable details. Request details show running and queued native-request counts across this service, breakdowns by model, provider and role, and waiting rows with blocking rule IDs and elapsed queue time. Agent details show main, subagent and independent execution counts, with breakdowns by executor, profile, model or role. If the connection fails, the last counts are marked stale. On the same tab, **Concurrency limits** lets you add or edit rules, choose a model or provider target, and set a shared or per-session cap. The switch pauses a rule without deleting it. Saving applies the rule to new and queued requests without stopping active streams.
- **History:** costs and token usage for a date range, defaulting to today. Follow a trend bar to its consumption sources, then open session records and recorded turns on demand; filters stay with the view. Previous-period comparisons are read only when requested. Token usage and cost have separate completeness indicators; **Data reliability** distinguishes unknown accounting from empty ranges. Existing filtered usage links open History. See [Usage statistics](./sessions.md#gui-usage-statistics).
- **Quotas:** balances, credits, usage windows and other metrics reported by configured providers and services, separate from Kiki's local usage accounting. Cards show the source account, status and available meters. Use **Refresh quotas** to refresh eligible sources, or a card's refresh action for one source. A source that requires authentication offers the appropriate sign-in or settings action; missing or unsupported metrics are not treated as a zero balance.
- **External sync:** destinations that receive this server's own usage. Three kinds are available: **vibecafe.ai**, **Kiki webhook**, and **Script**. Only the model, the UTC half-hour, the four token counts, quality and cost go out — never a prompt, answer, title, workspace name or path.

  A **vibecafe.ai** destination signs in from the page itself: press **Sign in to VibeCafe**, approve it in your browser with the code it shows, and the page reports the result. There is no authorization code to copy, and no address, client id, or key to fill in — the destination is `https://vibecafe.ai`. A custom address, or a key you supply yourself, is the advanced path instead. The flow has not been exercised against the live service: if it does not complete, the destination stays as the page left it and nothing has been sent.

A **Kiki webhook** destination takes your own HTTPS endpoint, with `none`, `bearer`, or `hmac` authentication and optional gzip. A secret is stored either in the system keyring or, if you choose that explicitly, in a private file on the server — the keyring is not silently substituted if it fails, and the file is protected by filesystem permissions rather than encrypted at rest.

Existing `/usage?panel=limits` links open Live and focus the concurrency-rule section; there is no separate Limits tab.

External sync needs no experimental switch; without a destination nothing is sent. Signing in only stores an approved credential: the destination stays **disabled** and no consent has been given. Choose a destination, preview the exact payload, agree once, then enable.

A destination that has not been agreed to sends nothing. Widening the range, changing the endpoint, or changing a credential to a different identity asks again, while shrinking the range or changing the interval does not. **Pause**, and **Disable sync** on a vibecafe.ai destination, turn sending off (`enabled` false, state `disabled`, no next time) while keeping the queue and signed-in account. Removing asks whether to discard queued batches and deletes the stored credential; asking the service to delete what it already holds is a separate action.

On upgrade, an explicit off choice for the retired `usage_export` flag pauses existing destinations once, keeping their consent and queued data; resume each destination when you want it to send again. See [`kiki usage-export`](../reference/command.md#kiki-usage-export) for the command-side equivalent.

A **Script** destination runs your command as your own OS user with your ordinary permissions — it can read files and reach the network on its own, and this is not a sandbox. Kiki writes only the content-free batch to its stdin and reads a receipt from its output.

For a request that looks stuck, open **Live → Request details** before changing a limit. A queued row names the local rule blocking it, and a provider HTTP 429 is diagnosed from the provider's own error — a full local queue, a timeout and a rejection each need a different fix. [`request_governance`](../configuration/config-files.md#request-governance) has the fields, examples and error codes. The rules cover the model requests this service sends itself: when you run a turn on Codex, Claude Code, or Grok Build as the engine, those requests are the engine's own and are not counted here, while an external tool calling back into Kiki for a native request is.

## CLI counterpart

The TUI has no **Settings** dialog. Terminal-side preferences (theme, editor, and the rest) are configured in `tui.toml` or with the interactive `/config`, `/theme` and `/editor` commands — see [`tui.toml`](../configuration/config-files.md#tui-toml). Agent and runtime settings live in `config.toml`.
