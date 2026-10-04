# Plugins

Plugins package reusable Kiki capabilities into installable units — they can add [Agent Skills](./skills.md), custom [agents](./agents.md), automatically load a specified Skill at session start, contribute system-prompt instructions, declare MCP servers to provide real tool capabilities, and bring another tool's conversation history in as a [Kiki session you can keep working in](#session-history-import), or as a read-only archive. They are ideal for sharing workflows with a team, connecting to external services, or installing extensions from the [official plugins](#official-plugins).

## Installation and Management

Run `/plugins` in the TUI to open the plugin manager. It is a single panel with four tabs, switched with `Tab` / `Shift-Tab`:

- **Installed**: Manage installed plugins
- **Official**: Kimi-maintained marketplace plugins
- **Curated**: Third-party plugins from Kimi partners in the default marketplace
- **Custom**: Install from a URL

Common keys:

| Key | Action |
| --- | --- |
| `Tab` / `Shift-Tab` | Switch between the Installed / Official / Curated / Custom tabs |
| `Space` | Enable or disable the selected installed plugin (Installed tab) |
| `D` | Remove the selected installed plugin (Installed tab) |
| `M` | Manage MCP servers for the selected plugin (Installed tab) |
| `R` | Reload `installed.json` and all manifests (Installed tab) |
| `Enter` | Installed tab: install the available update, or view details if up to date · Official/Curated tab: install or update · Custom tab: install |
| `I` | View plugin details (Installed tab) |
| `Esc` | Go back or cancel |

You can also use slash commands directly:

| Command | Description |
| --- | --- |
| `/plugins` | Open the interactive plugin manager |
| `/plugins list` | List installed plugins |
| `/plugins install [--trust] <path-or-url>` | Install from a local directory, zip URL, or GitHub repository URL, or update an already-installed local source by repeating the same path. `--trust` gives the [one-time consent](#installing-a-plugin-that-runs-code) that a plugin running its own code needs, and is only asked on the first install of a source |
| `/plugins marketplace [source]` | Browse the official marketplace, or pass a custom marketplace JSON path or URL |
| `/plugins info <id>` | View plugin details and diagnostics |
| `/plugins enable <id>` | Enable a plugin |
| `/plugins disable <id>` | Disable a plugin |
| `/plugins remove <id>` | Remove a plugin (requires confirmation) |
| `/plugins reload` | Re-read `installed.json` and the managed copies of every plugin. It does not copy anything from your source directories — to pick up a source edit, use `/plugins install <path>` again |
| `/plugins mcp enable <id> <server>` | Enable an MCP server declared by a plugin |
| `/plugins mcp disable <id> <server>` | Disable an MCP server declared by a plugin |

### Installing from GitHub

Use `/plugins install <url>` to install directly from a GitHub repository. Four URL forms are supported:

- `https://github.com/<owner>/<repo>`: Install the latest release; falls back to the default branch if no release exists
- `https://github.com/<owner>/<repo>/tree/<ref>`: Install a specific branch, tag, or short commit SHA
- `https://github.com/<owner>/<repo>/releases/tag/<tag>`: Pin to a specific tag
- `https://github.com/<owner>/<repo>/commit/<sha>`: Pin to a specific commit

Network requests only go through `github.com` redirects and `codeload.github.com` downloads; `api.github.com` is not called.

### Installing a plugin that runs code

Most of a plugin is declarative: Skills, agents, prompt text, themes, MCP server declarations. A plugin that needs more ships an entry file, and Kiki runs that file as Node.js code with your account's permissions — that is how a plugin reads a folder you point it at or imports a history file. It is not a sandbox: the code has the same access you do.

Kiki therefore asks for consent once per source before installing such a plugin. `/plugins install <source>` reports that the plugin runs trusted code and stops; add `--trust` to give the consent:

```sh
/plugins install --trust ./my-plugin
```

In the GUI, the install sheet lists what the plugin would add and what it will be able to do, and its button reads **Allow and install** instead of **Install** while this consent is needed.

The consent is remembered for the source, not for each file, page, or call:

- Installing or updating from the same source again does not ask — even when the plugin's contributions, description, or declared permissions have changed since you approved it.
- A different source that reuses the same plugin id is a new source and asks again.
- For a GitHub URL, the source is the `owner/repo`, so switching branches, tags, or commits inside that repository does not ask again.
- One change does ask again: a plugin that had no entry file starts shipping one.

What you approve is the source rather than the exact bytes: Kiki fingerprints the plugin folder at the preview and refuses an install whose files changed after it. That fingerprint protects the preview, not each later action — once a source is trusted, reinstalling or updating it does not ask again, while the tool calls it produces still follow your current permission mode and tool rules.

### Notes

- Local plugin updates take effect in the conversation you are already in. Install a local plugin once with `/plugins install --trust <path>` and enable it with `/plugins enable <id>`; a newly installed plugin starts disabled. After editing your source directory, run `/plugins install <path>` again with the same path — the updated code and manifest replace the managed copy, the plugin stays enabled, and the tool is available to the same conversation once that command returns. No `/plugins reload`, `/reload`, or `/new` is needed. The already-consented source does not ask for `--trust` again.
- An update waits for that plugin's in-flight work before switching: calls already running finish on the old version, and calls that arrive during the switch wait and run on the new one. Other plugins are not restarted and keep running. A call already resolved against an older tool definition asks for a retry instead of running against changed rules.
- `/plugins reload` is the separate explicit global action. It re-reads `installed.json` and the managed copies of every plugin and never copies from your source directories, so it is not the way to pick up a source edit. System-prompt sections and plugin Skills still rebuild through their own documented timing — see [System-prompt instructions](#system-prompt-instructions) and [Plugin agents](#plugin-agents).
- Local installations are copied to `$KIKI_HOME/plugins/managed/<id>/`, and the CLI always runs from this managed copy. Edit the source directory and reinstall; editing the managed copy by hand does not give the same update path and a later reinstall overwrites it.
- Removing a plugin only deletes the installation record; the managed copy and original source files remain on disk.
- Plugins are currently installed per-user and apply to all projects; project-level installation scope is not yet supported.

### Custom marketplace JSON

Pass a marketplace JSON path or URL to `/plugins marketplace <source>`, set [`KIKI_PLUGIN_MARKETPLACE_URL`](../configuration/env-vars.md), or configure `[plugins] marketplace_url` in `config.toml`. The order is command source, environment variable, then config; without any source, Kiki does not fetch a remote catalog and still shows built-in capabilities. Each entry in the `plugins` array needs an `id` and a `source` (local path, zip URL, or GitHub URL):

```json
{
  "version": "2",
  "plugins": [
    {
      "id": "my-plugin",
      "displayName": "My Plugin",
      "source": "./my-plugin"
    }
  ]
}
```

## Local document extraction

`kiki-documents` converts a local PDF, Office, HTML or text file into Markdown that `Read` and `Grep` can use. Install and enable the plugin through the existing plugin manager, then ask Kiki to extract a file into a new folder and read the result. The package bundles the official `@nb-corp/nb-extract` 0.1.1 JavaScript API and dependencies; it needs no runtime npm install or local skill checkout.

HTML (`.html`/`.htm`), Markdown and plain text work immediately. Local PDF, DOCX, XLSX/XLS and PPTX need Python 3.10+ with MarkItDown's matching format dependencies on the machine running Kiki. Prepare a virtual environment once:

```sh
python -m venv .venv-documents
```

On Windows, install the formats you need with:

```sh
.venv-documents/Scripts/python.exe -m pip install "markitdown[pdf,docx,xlsx,xls,pptx]"
```

On macOS/Linux, use `.venv-documents/bin/python` instead. For PDF only, use `markitdown[pdf]`. Set the environment's absolute Python executable path in **Capabilities → Plugins → Kiki Documents → Settings → Python with MarkItDown** (`pythonPath`). The plugin does not install Python or pip dependencies automatically.

Each extraction creates a new output directory containing `document.md`, `extraction.json` with source, engine and warnings, and any assets actually returned by the engine. The source is unchanged and existing outputs are not overwritten. The response preview may be shortened and marks `previewTruncated`; use `Read`/`Grep` on the saved Markdown for the full text. MarkItDown does not export images, and Defuddle does not download linked images.

Auto processing stays local and never uploads or performs OCR. Empty or image-only scans fail rather than being reported as read; partly scanned documents can still omit image-only pages. For cloud OCR, explicitly authorize uploading the file to MinerU, configure its token in plugin settings and select `engine=mineru` with `allowUpload=true`. Service terms and charges apply; stopping local waiting does not cancel the remote task. Missing dependencies, unsupported formats and byte-limit failures return errors, not a complete extraction. Input is limited to 50 MiB with a 600-second deadline.

## Media Sources

A media plugin contributes one or more *sources* — a named provider for images, video, or speech. Once a media plugin is installed, its sources appear under **Capabilities → Plugins → Media sources**, one searchable list rather than a page per vendor.

### Turning generation on

Generating is experimental and is **off by default**. Everything else on this page — installing sources, filling in their settings, choosing defaults, and reading past generations — works whether or not it is on. Only starting a new generation needs it.

Three ways to turn it on, in the order Kiki reads them:

- Set `KIKI_EXPERIMENTAL_MEDIA_GENERATION=1` in the environment.
- Put `media_generation = true` under `[experimental]` in `config.toml`.
- Turn on **Media generation plugins** in **Settings → Experimental**.

### The list

Every source is a single row that answers three things at once: which provider it is, which package it came from, and whether it can be used right now. The status on the right of a row is one of:

- **Ready** — installed, enabled, and the host confirms its configuration.
- **Needs setup** — the host reports a required setting is missing. Open the row to fill it in.
- **Not checked** — the source is installed and enabled, but its configuration has not been read. Kiki does not read every source's settings to draw a list, so a row in this state is neither an assurance nor a warning. Open the row to see its settings.
- **Unavailable** — the package did not load, or you switched it off. Nothing configured in this row will generate until that is fixed.
- **Blocked** — a job for this provider could not proceed because the package is not loaded. The job is kept, not discarded.

Filter by modality (image, video, speech) or by status, or type to search. The counts beside each band are the whole list, not the filtered one, so a filter never hides how much is behind it.

### Configuring a source

Open a row to reach its settings form. The form is the package's own settings — the same fields, the same secret handling and the same save path as the plugin's own detail page, so a provider's key is a plugin's key.

Secrets are write-only. Kiki shows whether a key is stored and never shows the value again; replacing or clearing one is an ordinary edit.

A source can be configured in one of three ways, and the form says which applies rather than making you infer it:

- **Its own settings.** You supply an API key and, if the provider needs one, a base URL. These fields are required only while no connection is selected.
- **An existing Kiki connection.** If the package declares a connection setting, the form offers the connections you already have. Selecting one is enough — the package's own key and endpoint stop being required, and are not used at all. A connection you select must resolve; Kiki does not silently fall back to a previously stored key if it cannot.
- **Self-managed.** A script may manage its own credentials from its own settings, environment variables, or an external file. That is a supported arrangement, and Kiki does not treat the absence of a key as a broken provider. Nothing Kiki stores is displayed back to you in logs, previews, or reports.

A connection you already have does not promise that the account behind it can do media work. Kiki surfaces what the provider reports; it does not maintain an allowlist of which connections support which modality.

### Per-modality defaults

Three settings on the media entry package pick the default source for images, video and speech. They are ordinary plugin settings, stored with the rest of that package's configuration. When a source is the default, the list says so on its row.

If a modality has no default and exactly one source could serve it, Kiki uses that one. If more than one could, Kiki asks you to choose rather than picking one and charging you for it.

### Recent generations

The same page lists the current session's recent media jobs, and keeps listing them when generation is off. Each one shows its state, and each file that landed is listed with a preview, a download, or an in-page player. Job states are reported as they are, including the two that are easy to get wrong:

- **Outcome unknown** — Kiki cannot confirm whether the vendor accepted the submission, so it may still be generating and charging. Nothing is regenerated automatically, and no retry is offered, because a retry is a second charge.
- **Stopped** — Kiki stopped waiting locally. Whether the vendor also stopped, and whether it is still charging, is what the vendor reports; the row says which.

A job that partly finished keeps the files that landed. **Keep fetching** continues the same job through the session and agent that owns it — not through a global shortcut — and **Stop waiting** does the same. Both act only on the session that produced the job.

### Discovery sources

Where new providers can be discovered from is a different question from which providers are installed, so it gets its own folded section at the bottom of the page. Adding, pausing or removing a discovery source has no effect on already-installed packages, keys or past jobs.

## Official Plugins

Official plugins are plugins and built-in product capabilities maintained by Kimi. There are currently three:

- **[Kimi Datasource](#kimi-datasource)**: Query financial market data, macroeconomic indicators, corporate registration records, academic literature, and Chinese laws and regulations in natural language
- **[Kimi Browser Extension](#kimi-browser-extension)**: Let AI drive your own browser to get web tasks done
- **[Kimi Computer Use](#kimi-computer-use)**: Let AI operate your desktop apps (macOS and Windows)

### Installation and Upgrade

All official plugins share the same installation and upgrade flow:

1. Run `/plugins` and press `Tab` to select **Official**
2. Find the plugin you want and press `Enter` to install
3. After installation completes, run `/reload` or `/new` to activate it

::: info Note
Kimi Browser Extension installs in two parts: after the steps above, you also need to [install the browser extension](#install-the-browser-extension) before it works.
:::

Official plugins do not update automatically — when an update is available, you'll be prompted the next time you use the old version. To upgrade, repeat the installation steps above.

### Kimi Datasource <Badge type="tip" text="v3.3.0" />

Kimi Datasource is the official Kiki data plugin, letting you query financial market data, macroeconomic indicators, corporate registration records, academic literature, and Chinese laws and regulations in natural language — no manual API calls or data accounts required.

You must first complete OAuth login with a Kimi Code account via `/login`; data queries consume your Kimi Code plan quota.

#### How to use

1. Describe your need in natural language, and Kiki will automatically invoke the data capabilities
2. Explicitly trigger the data query skill with `/skill:kimi-datasource`

#### What you can do

**Live market research**: Want to run a quantitative analysis on a stock? Pull three years of daily closing prices, MACD, and KDJ signals in a single query — no third-party data platforms needed.

**Cross-country macro comparison**: Studying supply-chain shifts across China, India, and Vietnam? Get complete GDP growth, trade volume, and demographic time-series from World Bank data spanning 50+ years, all in one go.

**Pre-contract risk check**: Need to vet a counterparty fast? Type the company name and instantly get business registration, equity structure, litigation disputes, and credit blacklist status — right when you need it.

**Literature review acceleration**: Tracing the research arc of RLHF? Get the most-cited papers, key authors, and core findings in seconds, so your literature review outline takes shape in half the time.

**On-the-spot legal lookup**: Stuck on which statute governs a residence-right contract dispute? Pinpoint the relevant Civil Code articles — full text, authority level, and validity — then pull a few comparable precedents to back them up, without digging through statute databases.

**Institutional-grade US equity research**: Writing a deep dive on a US stock? Pull the annual report, standardized financial metrics, top-50 holders, and consensus estimates in one go — no more juggling multiple data terminals.

#### Coverage

| Category | Scope |
|---|---|
| Stocks & financial markets | Well-known databases such as Wind, S&P Capital IQ, and SEC EDGAR, covering prices, technical indicators, financials and valuation, and consensus estimates across A-shares, HK, US, and other major markets, plus official filings for 8,000+ US-listed companies |
| Macroeconomics | Well-known databases such as the World Bank and IMF, covering 50+ years of time series for 189 countries: GDP, trade, population, exchange rates, CPI, balance of payments, GDP forecasts, and more |
| Corporate data | Business registration, equity chain, legal risk, and related-entity graph for mainland Chinese companies |
| Academic literature | Millions of papers across physics, mathematics, CS, quantitative finance, economics — including preprints |
| Legal | Chinese laws, regulations, and judicial cases — statute search and detail lookup across all authority levels, plus ordinary and authoritative case search |
| Smart screening | Well-known databases such as Gildata, covering natural-language screening for stocks, funds, and fund managers, plus macro-industry data, research reports, announcements, and news |

#### Billing and limitations

- Data queries are billed per call and consume Kimi Code account credits
- The plugin provides read-only queries; no write or trading functionality is available
- Technical indicators and real-time prices are only available during active trading hours
- AI-generated output is for reference only and does not constitute investment or business advice

<a id="kimi-webbridge"></a>

### Kimi Browser Extension <Badge type="tip" text="v1.11.4" />

Kimi Browser Extension lets AI drive your browser directly — not an emulator, not a crawler, but the browser you use every day, with your login sessions and cookies. AI can open pages, read content, click buttons, fill in forms, and take screenshots just like you do, taking repetitive web operations off your hands. See the [Kimi Browser Extension site](https://www.kimi.com/features/webbridge) for a product overview.

#### Install the browser extension

After installing via `/plugins`, you also need the Kimi Browser Extension in your browser before AI can drive it. There are two ways to install it:

**Option 1: Install from a store (recommended)**

Open the [Chrome Web Store](https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc) or [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/kimi-webbridge/bnlffdbcfnanfbknnlaflhlhkocccckg) page and click Add.

**Option 2: Install manually**

Use this when you can't reach the stores:

1. [Download the extension package](https://kimi-web-img.moonshot.cn/webbridge/latest/extension/kimi-webbridge-extension.zip) and unzip it
2. Type `chrome://extensions/` in the address bar to open the extensions page, then turn on **Developer mode** in the top-right corner

   ![Turn on Developer mode](../../media/webbridge-dev-mode.jpeg)

3. Click **Load unpacked** in the top-left corner and select the unzipped `kimi-webbridge-extension` folder

   ![Load the unpacked extension](../../media/webbridge-load-unpacked.jpeg)

4. Once installed, the Kimi Browser Extension icon appears in the browser toolbar. Seeing the icon means the installation succeeded, and AI can start working on web pages for you.

   ![The Kimi Browser Extension icon in the browser toolbar](../../media/webbridge-install-success.jpeg)

#### What you can do

- **Web automation**: Just say what you need — AI clicks through pages, fills in forms, reads content, and takes screenshots for you
- **Social trending research**: Automatically browse trending topics on X (Twitter), Weibo, and Xiaohongshu, open the top-liked posts one by one to screenshot and extract key viewpoints, then organize everything into a research library with topic suggestions
- **Job listing collection**: Filter positions on recruiting sites by keyword, city, and job type, and organize titles, links, companies, salaries, and application methods into a table
- **Competitive analysis**: Batch-question multiple AI products and collect their answers to build side-by-side comparison reports
- **Flight price comparison**: Query the same itinerary across multiple travel platforms, record airlines, departure/arrival times, and links sorted by price, and get recommended options

### Kimi Computer Use <Badge type="tip" text="v0.5.4" />

Kimi Computer Use lets AI operate your desktop apps directly, clicking, dragging, scrolling, and typing. The macOS version works silently in the background without taking over your mouse (a few popup actions may still bring an app to the foreground); see [the notes below](#notes-for-the-windows-version) for how the Windows version differs.

#### Authorization (macOS)

The first time you use Kimi Computer Use after installation, it shows an authorization window — just follow the prompts:

1. Click **Authorize** next to **Accessibility** and **Screen Recording**, and enable both permissions in System Settings — the former lets it perform clicks, typing, and scrolling; the latter lets it read screen content and locate UI elements
2. Turn on the **Kiki** switch under "Connect local agents", then restart Kiki for it to take effect

<div style="max-width: 380px; margin: 0 auto;">

![Kimi Computer Use authorization window](../../media/kimi-computer-use-auth.jpeg)

</div>

#### Notes for the Windows version

The Windows version (WinCU) installs differently from the macOS one: run `/plugins install https://cdn.kimi.com/kimi-computer-use-windows/latest/kimi-cu-win-plugin.zip` in Kiki, then restart after installation. A few things to know before using it:

- **It may briefly take over your mouse and keyboard**: Unlike the macOS version, the Windows version cannot reliably inject input in the background; it may briefly activate the target window and use your real mouse and keyboard while performing actions
- **System requirements**: Windows 10 version 1903 (Build 18362) or later, or Windows 11, x64; a real interactive desktop session is required, and Windows Server needs Desktop Experience
- **No extra permissions needed**: Windows does not require the Accessibility and Screen Recording grants that macOS does
- **Matching privilege level**: If the target app runs as administrator, KimiCU must run at the same privilege level

#### What you can do

- **Organize and enter information**: Have AI gather scattered information into Notes, spreadsheets, or your note-taking app, instead of typing everything in by hand
- **Walk through site and app flows**: After changing a page, let AI click through the key flows and screenshot each step to confirm rendering and navigation work
- **Handle repetitive operations**: Repeatedly opening, copying, pasting, and checking can run silently in the background without taking over your mouse
- **Run fixed-step tasks**: For flows with clear steps, spell them out and AI follows along; for example, ask AI to open NetEase Cloud Music and play a specific song
- **Handle software that has no API**: Plenty of professional tools and internal systems have no CLI or API at all; what used to require your own clicking can now be handed to AI, like trimming the first three seconds off a clip in Final Cut Pro and exporting it

::: warning Note
Don't hand it anything involving money, accounts, or publishing, such as payments and transfers, deleting important files, changing passwords, or posting content. To judge whether a task is suitable, check three things: the result is verifiable, the action is reversible, and the risk of getting it wrong is low.
:::

## Plugin Manifest

A plugin is a directory or zip file containing a manifest. The manifest can be placed at either of the following locations:

```text
<plugin_root>/kimi.plugin.json
<plugin_root>/.kimi-plugin/plugin.json
```

When both files exist, `kimi.plugin.json` takes precedence.

Example:

```json
{
  "name": "kimi-finance",
  "version": "1.0.0",
  "description": "Finance data and analysis workflows for Kiki",
  "skills": "./skills/",
  "systemPromptPath": "./SYSTEM.md",
  "sessionStart": {
    "skill": "using-finance"
  },
  "interface": {
    "displayName": "Kimi Finance",
    "shortDescription": "Market data and financial analysis workflows"
  }
}
```

Supported fields:

| Field | Description |
| --- | --- |
| `name` | Required; serves as the plugin id. Must match `[a-z0-9][a-z0-9_-]{0,63}` |
| `version`, `description`, `keywords`, `author`, `homepage`, `license` | Display metadata |
| `interface` | Fields shown in `/plugins`: `displayName`, `shortDescription`, `longDescription`, `developerName`, `websiteURL` |
| `icon` | A `./` path to an `.svg` or `.png` file inside the plugin (64 KB max). `GET /api/plugins` returns it as an inert `data:` URI, for a GUI to draw next to the plugin |
| `skills` | One or more `./` paths; must be within the plugin root directory. When omitted, the `SKILL.md` in the root directory is treated as a single Skill root |
| `agents` | One or more `./` paths; must be within the plugin root directory and point to directories containing [agent files](./agents.md#custom-agents). When omitted, the `agents/` directory under the plugin root (if present) is picked up automatically |
| `sessionStart.skill` | Loads the specified plugin Skill into the main Agent when a new or resumed session starts |
| `skillInstructions` | Additional instructions appended whenever a Skill from this plugin is loaded |
| `systemPrompt` | Inline instructions contributed to the agent's system prompt while the plugin is enabled |
| `systemPromptPath` | A `./` path to a UTF-8 text file containing system-prompt instructions; combined after `systemPrompt` when both are present |
| `mcpServers` | MCP server declarations; enabled by default, can be disabled from `/plugins` |
| `hooks` | Hook rules run on lifecycle events while the plugin is enabled; see [Hooks in Plugins](#hooks-in-plugins) |
| `commands` | One or more `./` paths pointing to a directory or `.md` file; registers the Markdown files within as slash commands. See [Plugin Slash Commands](#plugin-slash-commands) |

Unsupported runtime fields such as `tools`, `apps`, `inject`, and `configFile` appear as diagnostics and are ignored.

### System-prompt instructions

Use `systemPrompt` for a short inline instruction, or `systemPromptPath` to keep longer instructions in a file inside the plugin root. If both fields are present, the inline text appears first, followed by the file content. The file content is read when the plugin is installed or reloaded, so edits take effect only after `/plugins reload`. For example:

```json
{
  "name": "code-review",
  "systemPromptPath": "./SYSTEM.md"
}
```

System-prompt contributions take effect on every surface: the interactive TUI, `kiki -p`, and `kiki web`.

Each field — the inline `systemPrompt` and the `systemPromptPath` file — is limited to 32 KB (UTF-8 bytes): oversized content is ignored and reported in the plugin diagnostics. Across all enabled plugins, one prompt build injects at most 64 KB of instructions; contributions beyond the budget are skipped with a warning, including a single plugin whose inline text and file together exceed that budget.

New sessions and newly created agents read the contributions from the plugins currently enabled. An in-flight request keeps its existing system prompt. `/plugins reload` refreshes the plugin skill list and requests prompt rebuilds for live agents; use it when you need the change to converge deliberately before the next turn. Installing, enabling, disabling, or removing a plugin updates the catalog immediately, and a later prompt rebuild — for example after compaction or a tool-policy change — may pick up the new sections. A resumed session starts from its persisted prompt and uses the current plugin catalog on later rebuilds. Toggling a plugin's MCP server does not change system-prompt sections.

The built-in agent prompt includes instructions from enabled plugins automatically. A custom `SYSTEM.md` or agent file owns its template, so include `${plugin_sections}` where plugin-contributed instructions should appear. If the custom template includes `${base_prompt}` and that effective default already contains the plugin block, do not add `${plugin_sections}` again. See [Custom agents and SYSTEM.md](./agents.md#overriding-the-main-agent-s-system-prompt-with-system-md) for the complete variable table.

## Plugin Slash Commands

Slash commands save a prompt you use often as a `/command`, so you can trigger it by typing the command instead of retyping the whole thing.

Here is a minimal end-to-end example. The plugin's directory structure:

```text
kimi-finance/
  kimi.plugin.json
  commands/
    report.md
```

In the manifest (`kimi.plugin.json`), the `commands` field points to where the command files live:

```json
{
  "name": "kimi-finance",
  "version": "1.0.0",
  "commands": "./commands/"
}
```

The command file `commands/report.md`. The block between the two `---` lines at the top is frontmatter (metadata describing the command); everything below is the prompt sent to the Agent:

```markdown
---
description: Pull and summarize a stock's latest financials
---

Pull the latest financials for $ARGUMENTS and summarize revenue, profit, and key risks.
```

After installing and enabling the plugin, type this in the chat:

```text
/kimi-finance:report TSLA
```

Kimi replaces `$ARGUMENTS` in the body with `TSLA`, then runs the prompt. The three details below cover each step.

### Declaring Commands (the `commands` field)

`commands` takes a single `./` path or an array of paths, each pointing to a directory or `.md` file inside the plugin root:

- Pointing at a **directory**: collects every `.md` file under it recursively; each becomes one command.
- Pointing at a **single `.md` file**: registers just that one.
- Pointing at a non-`.md` file or a missing path: appears as a diagnostic (shown in the `/plugins` panel) and is ignored.

### Writing a Command File

A command file has two parts: an optional **frontmatter** (the metadata between the two `---` lines at the top, where you set `name` and `description`) and the **body** (the prompt after the `---`). When a field is omitted, it falls back as follows:

- `name` (the command name): derived from the file's path relative to the declared `commands` path (without `.md`, using `/` separators), e.g. `commands/frontend/component.md` → `frontend/component`. A `name` set in the frontmatter takes precedence.
- `description` (shown in the command list): the first non-empty line of the body (truncated past 240 characters); if the body is empty too, `No description provided.` is shown.

### Running Commands and Passing Arguments

Commands are prefixed with the plugin id (their namespace) and registered as `<plugin>:<command>`, so the command above is actually `/kimi-finance:report` — this keeps same-named commands from different plugins from colliding.

Whatever you type after the command replaces `$ARGUMENTS` in the body (above, `TSLA` replaces `$ARGUMENTS`). If the body has no `$ARGUMENTS` but you pass arguments anyway, they are not dropped — they are appended to the end of the body as `ARGUMENTS: <what you typed>`.

## Skills and Session Start

Plugin Skills use the same `SKILL.md` format as ordinary [Agent Skills](./skills.md). A typical directory structure:

```text
my-plugin/
  kimi.plugin.json
  skills/
    using-my-plugin/
      SKILL.md
    another-workflow/
      SKILL.md
```

`sessionStart.skill` loads a plugin Skill into the main Agent at session start, making it suitable for initialization instructions, workflow rules, or mapping terminology from other tools to Kiki. It only injects text; it does not execute code.

Regardless of how a Skill is loaded (`sessionStart.skill`, `/skill:<name>`, or automatic model invocation), `skillInstructions` appears alongside that plugin's Skill.

## Plugin Agents

A plugin can ship custom agents: declare one or more `./` directories in the manifest's `agents` field (or simply place an `agents/` directory under the plugin root). The agent files inside use the same format as [custom agents](./agents.md#custom-agents) and, while the plugin is enabled, are discovered automatically and can be delegated to as sub-agents by the main Agent.

```text
my-plugin/
  kimi.plugin.json
  agents/
    reviewer.md
```

Plugin agents rank below every other file source: on a name collision, user-level, extra, project-level, and `--agent-file` agents all win over the plugin-provided one, and replacing a built-in agent still requires an explicit `override: true` in the frontmatter. After installing, enabling, disabling, or removing a plugin, the agent list refreshes in a new session (or on `/reload`); the live session also refreshes after `/plugins reload`.

## MCP Servers in Plugins

When a plugin needs real tool capabilities, it can declare `mcpServers` in its manifest, reusing the [MCP](../server/mcp.md) schema.

Stdio server (local command):

```json
{
  "mcpServers": {
    "finance": {
      "command": "uvx",
      "args": ["kimi-finance-mcp"]
    }
  }
}
```

HTTP server (remote service):

```json
{
  "mcpServers": {
    "docs": {
      "url": "https://example.com/mcp"
    }
  }
}
```

For stdio servers, `command` can be a command on `PATH` or a path starting with `./` within the plugin root directory. `cwd` likewise must start with `./` and be within the plugin root directory; otherwise the server is ignored.

Plugin MCP servers start after `/reload` or in new sessions. To enable or disable a server:

```sh
/plugins mcp disable kimi-finance finance
/reload

/plugins mcp enable kimi-finance finance
/reload
```

### Notion material and write-back

`kiki-notion` is a Kiki-maintained configuration and workflow for [Notion's hosted MCP service](https://developers.notion.com/guides/mcp/get-started-with-mcp), not a Notion-endorsed integration. From the repository root, install `/plugins install --trust ./plugins/official/kiki-notion`, then run `/plugins enable kiki-notion`; for an extracted package, use its directory instead. In **Capabilities → MCP**, authorize `plugin-kiki-notion:notion` through the existing browser OAuth flow, without adding a token field. Use `/reload` or a new conversation if an already-open conversation has not discovered the new MCP connection.

Ask `/skill:notion-workspace` to search a specified page/teamspace/workspace, read key originals, and save a brief with source links to a local path. Name the destination page URL/ID and intended addition or update when you want it saved back. Summaries alone do not change Notion; an explicit write request does not add a plugin-specific confirmation, while normal Kiki tool approvals still apply. Plan/tool restrictions, dropped filters, missing subtrees, and pending async writes are reported rather than presented as complete coverage or a successful write. Access also depends on your workspace permissions and administrator policy; installation does not authorize upgrades or paid actions.

Notion content can reach your selected model provider, Kiki session history, and requested local files. The plugin creates no separate index or credential store. Disabling/removing it does not delete those artifacts or revoke OAuth; disconnect in MCP management and revoke service access in Notion **Settings → Connections** as needed. The package and scripted synthetic MCP chain are tested; real-account authorization/writes and autonomous model execution are not yet verified. The original package is MIT licensed; the remote service and workspace content follow the applicable [Notion agreements](https://www.notion.so/terms).

## Hooks in Plugins

A plugin can declare hook rules in its manifest that run on lifecycle events while the plugin is enabled. Each entry uses the same fields as a [`[[hooks]]` rule in `config.toml`](./hooks.md#configuration) (`event`, `matcher`, `command`, `timeout`):

```json
{
  "hooks": [
    {
      "event": "PreToolUse",
      "matcher": "Bash",
      "command": "node ./hooks/check-bash.mjs",
      "timeout": 5
    }
  ]
}
```

Plugin hooks reuse the same mechanism as global hooks — see [Hooks](./hooks.md) for the event list, the stdin JSON payload, and how exit codes and return values affect the main flow. The differences are:

- A plugin's hooks are active only while the plugin is **enabled**; disabling the plugin stops its hooks.
- Each hook runs with its working directory set to the plugin root, so `command` can use `./` paths inside the plugin.
- The hook process receives two extra environment variables: `KIKI_HOME` and `KIKI_PLUGIN_ROOT` (the plugin root directory).

Installing a plugin never runs its hooks by itself — they only fire when their matching event occurs while the plugin is enabled.

## Session history import

Kiki has built-in history import that turns another tool's text conversation into a **Kiki session you can keep working in**, or saves it as a read-only archive. Claude Code, Codex, Pi, Grok Build, OpenCode export files and custom JSON/scripts need no plugin installation, trust or activation. Import runs on the Kiki server without a model and leaves the source files unchanged; third-party plugins can still add formats through the same source contract.

History import is on by default, but does not scan folders or import anything at startup. To turn it off, start Kiki with `KIKI_EXPERIMENTAL_PLUGIN_IMPORT=false`, or set `plugin_import = false` under [`[experimental]`](../configuration/config-files.md#experimental) in `config.toml`. The existing switch name is retained; see [Environment variables](../configuration/env-vars.md#runtime-switches).

### Importing a conversation

Importing needs no plugin: Kiki serves these formats itself. Open **New session** and choose **Import history** beside the starters, or go through **Capabilities** → **Plugins** → **Import history**. From there:

1. Choose what the conversation becomes. **Kiki session** is the default: the conversation becomes a session in this Kiki, with its earlier turns as context, and you open it and carry on where the other tool left off. **Read-only archive** keeps it as a record you can read but not continue.
2. For a session, choose the **working directory** it runs in. Your existing workspaces are one click away, and you can type or browse for a folder that is not a saved workspace — a session started in a folder you have not opened before works the same way. Browsing does not register anything: the folder is used only if an import actually lands there.
3. Pick a format. Claude Code, Codex, Pi, Grok and OpenCode are built in, as is a custom script of your own; nothing is installed, trusted or enabled to reach this page. A third-party plugin's own source appears here too, once it is installed and enabled.
4. Choose the **Source home** — the folder the other tool keeps its history in, on the machine running the server. Kiki reads only that folder.
5. Pick a conversation from the list. A folder holding many histories is listed one page at a time.
6. Read the preview. It says whether the source could read the conversation at all, what would be kept, what would not be carried over, and where the result lands. **Complete read** means the source read the whole conversation; **Sample** means it read part of it.
7. Choose **Import as session** or **Start import**. That is the one confirmation this conversation gets: the import runs under the preview you just read.

An archive is written into the home of the Kiki server this window is connected to — **Imports into** names it. A session is created in the working directory you chose, on that same server. Neither ever lands in the source folder. A preview belongs to the server that made it, so after connecting to a different Kiki, preview the conversation again.

Progress reports bytes read from the source, and a source the server has not measured yet shows an indeterminate line instead of a percentage. **Stop import** ends a running import, and an import that was stopped, failed, or interrupted by a restart keeps its place and offers **Continue import**. A finished import offers **Open session** when it became a session, and **Open archive** when it became an archive — never both, because it only ever writes one.

### What a session keeps, and what it does not

A session import turns the conversation into context Kiki can continue from, which is what makes the migration painless, and it is not the same promise an archive makes. User and assistant text becomes the session's earlier turns. A tool call from the old conversation arrives as text saying it already happened — it is never re-run, and it grants no permission here. The other tool's system instructions, metadata, usage counts, approvals and running tasks are not installed as this Kiki's own state, and the preview lists that as a loss.

Importing the same source conversation and revision into the same working directory reuses the existing session without replacing any continuation you have added in Kiki. The preview says so before you start. A changed revision imports as a new session, leaving the one you already had alone.

Opening a migrated session needs a model like any other session: importing and reading do not, sending your next message does.

### What an archive keeps, and what it does not

An archive is history, not a live conversation: it cannot be continued, and opening it does not add its content to this session. It is also not a session of its own — it has no place in the session list and is read from the import page's own archive list, without a model. Records keep the roles they had in the other tool — user, assistant, system, tool call, metadata — but nothing is replayed. A tool call in the history stays a record, and text that was a system instruction to that tool is not executed here. Token counts the other tool recorded stay in the metadata and are not counted as usage on this machine.

The preview's loss list is the part of the feature that tells you what you are not getting, so read it before importing:

- **Attachments are not copied.** An image, document, or other embedded file leaves a placeholder in the text and a loss entry with a count; the conversation around it stays readable.
- **Unknown or omitted content is reported.** Claude Code and Codex can preserve unknown rows as metadata; the other rules report unsupported records or parts as counted losses. No rule turns an omitted part into a claim of complete preservation.
- **Malformed input is not hidden.** Claude Code and Codex report unparseable rows in their losses. Pi, Grok, OpenCode and the bundled custom JSON reader reject malformed JSON or invalid required relationships rather than silently skipping them. A preview distinguishes a sample from a complete read.

Claude Code and Codex reject a source folder deeper than 20 levels and a single input line over 128 MiB. Pi, Grok, OpenCode and the bundled custom JSON reader limit each input file to 64 MiB; Grok's summary and update files each have that limit. A custom script controls its own input limits and must report them honestly.

Kiki identifies a conversation by its source, source home, and the other tool's own id, and treats the revision seen in the preview as its content version. Importing the same revision again reuses the archive already there, and a changed conversation imports as a new revision of that archive. If the file changes between the preview and the import, the import fails and the existing archive is kept. Archives are found by title or source id — a lookup over what you have imported, not a full-text search.

When the window is connected to a Kiki on another machine, that server's sources, imports, and archives are readable here, but starting, stopping, and continuing an import belong to the machine that owns the home.

### Built-in formats and custom scripts

Choose a folder containing the format below, not necessarily the other tool's entire home. For OpenCode, first export the session to a local JSON file.

| Source | Supported input |
| --- | --- |
| Claude Code | JSONL history; selects the active UUID/parent conversation path and preserves compaction summaries as text |
| Codex | Legacy and current rollout JSONL; selects conversation messages rather than duplicating their event mirrors |
| Pi | v3 session JSONL, including the active parent-linked branch; inactive branches, thinking and attachments are reported as losses |
| Grok Build | A session folder with `summary.json` and `updates.jsonl`, or a `session-migrate.grok.v1` bundle; ACP text chunks and completed tool results become readable history |
| OpenCode export | Official `{info,messages:[{info,parts}]}` JSON export, or a locally saved flat share array; this does not read `opencode.db` or import SQLite state |
| Custom JSON / script | By default, `.json` files containing a message array or `{title,messages}`; messages have a recognized `role` and string `text` or `content` |

For another format, select **Custom JSON / script** and set **Custom import script** to an absolute path to a JavaScript ES module on the Kiki server. Its source settings use the same existing settings interface under the internal id `kiki-history`; that id is not an installed plugin. You can also set it in `config.toml`:

```toml
[plugin_settings.kiki-history]
customScript = "C:/imports/my-format.mjs"
```

Leave the setting empty to use the bundled JSON reader. A script exports `discover(input, context)`, `probe(input, context)` and `parse(input, context)` using the [source method shapes below](#writing-an-import-source); it does not need a plugin manifest, `register(api)` or an SDK dependency. `context` supplies `signal` and `settings`. The standalone [custom JSON example](https://github.com/X-T-E-R/kiki/blob/main/packages/agent-core-v2/src/app/pluginImport/builtin/examples/custom-json.mjs) can be copied and adapted; it is also included with the built-in resources.

Choose only code you trust: a custom script runs as Node.js with your account's permissions, not in a sandbox. Selecting the script is the explicit choice to run it; there is no additional installation or per-call approval. Changing its code or settings changes the preview revision, so preview again before importing. Kiki still checks the returned records and pages against the shared source contract.

### Writing an import source

An import source is one of the contributions a plugin can declare, so it lives in the same manifest: list `x-kiki.sessionSources`, point `x-kiki.entry` at an ES module, and export `register(api)` from that module. The manifest declares what the plugin offers; the entry does the reading.

```json
{
  "name": "acme-history",
  "version": "0.1.0",
  "description": "Import Acme conversations into read-only archives",
  "x-kiki": {
    "engines": { "kiki": "^0.4.0" },
    "permissions": { "fs": "outside" },
    "entry": "./entry.mjs",
    "sessionSources": [
      {
        "schemaVersion": 1,
        "id": "acme-export",
        "label": "Acme export",
        "formatVersion": "acme-json-v1"
      }
    ]
  }
}
```

- `sessionSources` lists the sources this plugin registers. Each `id` matches `[a-z0-9][a-z0-9-]{0,63}` and must be unique within the plugin; `label` is what the source picker shows, and `formatVersion` names the format you read. A declared source the entry never registers fails when it is used instead of quietly doing nothing.
- `entry` is required for a plugin with session sources and must resolve inside the plugin root. Kiki loads it as an ES module in its own Node.js process, so build your TypeScript down to the file you name here.
- `permissions.fs: "outside"` is what an importer declares to read a folder outside the workspace, which is what a source home is. `engines.kiki` is required as soon as a plugin declares Kiki contributions.

The adapter offers three methods, and the definition passed to `registerSessionSource` must be the one the manifest declares:

- `discover` lists the conversations a folder holds for one source home, paging with the `cursor` it is given.
- `probe` reports one conversation: its content `revision`, title, `status` (`preserved`, `partial`, or `unsupported`), losses, total size, and canonical `sourceHome`. The archive identity includes that home, so return one spelling of a folder rather than a path the user could write two ways.
- `parse` returns records in pages, with the `cursor` that continues the read. `context.signal` is aborted when the reader stops the import, when the plugin is unloaded, or when a page runs past its timeout, and `context.settings` carries the plugin's own settings.

An honest source is worth more than a complete-looking one: give every loss a `code`, a `count`, and a `detail` instead of importing only the part you can read, and never treat history text as instructions to run. Each record holds at most 49,152 UTF-16 code units, so a longer message becomes several records that share an `id` and carry `part`, `textOffset`, and `textTotal`.

The example below is a working source for a folder holding one `history.json`; the record, page, and probe shapes come from the public `@kiki/plugin-sdk` package, whose `session-import` entry point exports them.

```ts
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { PluginRegistrationApi, SessionSourceAdapter } from '@kiki/plugin-sdk';
import type {
  ImportDiscoveryPage, ImportParsePage, ImportProbe, ImportRecord, SessionSourceDefinition,
} from '@kiki/plugin-sdk/session-import';

const definition: SessionSourceDefinition = {
  schemaVersion: 1, id: 'acme-export', label: 'Acme export', formatVersion: 'acme-json-v1',
};

type Message = { role: ImportRecord['role']; text: string; timestamp?: string };
type Conversation = { id: string; title: string; messages: Message[] };

async function conversations(home: string): Promise<Conversation[]> {
  if (!path.isAbsolute(home)) throw new Error('Choose an absolute source folder');
  const file = await realpath(path.resolve(await realpath(home), 'history.json'));
  return JSON.parse(await readFile(file, 'utf8')) as Conversation[];
}

function find(all: Conversation[], externalId: string): Conversation {
  const found = all.find((conversation) => conversation.id === externalId);
  if (found === undefined) throw new Error('That conversation is no longer in this folder; list it again');
  return found;
}

const revisionOf = (conversation: Conversation): string =>
  createHash('sha256').update(JSON.stringify(conversation)).digest('hex');

/** One record per 49,152 UTF-16 code units of text, with the offsets a reader needs to reassemble it. */
function records(conversation: Conversation): ImportRecord[] {
  return conversation.messages.flatMap((message, index) => {
    const split: ImportRecord[] = [];
    for (let part = 0, offset = 0; part === 0 || offset < message.text.length; part++) {
      let end = Math.min(message.text.length, offset + 48 * 1024);
      if (end < message.text.length && /[\uD800-\uDBFF]/.test(message.text[end - 1])) end--;
      split.push({
        id: `${conversation.id}:${index}`, part, role: message.role, text: message.text.slice(offset, end),
        timestamp: message.timestamp, textOffset: offset, textTotal: message.text.length,
      });
      offset = end;
    }
    return split;
  });
}

const adapter: SessionSourceAdapter = {
  async discover({ home }): Promise<ImportDiscoveryPage> {
    const entries = (await conversations(home)).map((conversation) => ({ externalId: conversation.id, title: conversation.title }));
    return { entries, cursor: null };
  },

  async probe({ home, externalId }): Promise<ImportProbe> {
    const conversation = find(await conversations(home), externalId);
    return {
      revision: revisionOf(conversation), title: conversation.title, formatVersion: definition.formatVersion,
      status: 'preserved', losses: [], totalBytes: Buffer.byteLength(JSON.stringify(conversation)), sourceHome: await realpath(home),
    };
  },

  async parse({ home, externalId, revision, cursor }, context): Promise<ImportParsePage> {
    const conversation = find(await conversations(home), externalId);
    if (revisionOf(conversation) !== revision) throw new Error('The conversation changed; preview it again');
    context.signal.throwIfAborted();
    const all = records(conversation);
    const start = Number(cursor ?? 0);
    const page = all.slice(start, start + 32);
    return {
      records: page, losses: [], bytesRead: Buffer.byteLength(JSON.stringify(conversation)),
      cursor: start + page.length < all.length ? String(start + page.length) : null,
    };
  },
};

export function register(api: PluginRegistrationApi): void {
  api.registerSessionSource(definition, adapter);
}
```

## Security Model

Plugins have a limited loading scope. The following operations do not occur during installation or session startup:

- Unsupported runtime fields such as `tools`, `apps`, `inject`, and `configFile` are ignored rather than executed
- All paths must remain within the plugin root directory after symbolic link resolution
- MCP servers of enabled plugins start after `/reload` or in new sessions and can be disabled at any time from `/plugins`
- Installing a plugin does not run its entry file: plugin code starts when you use the contribution, in a Node.js process holding your account's permissions ([not a sandbox](#installing-a-plugin-that-runs-code))
- Broken manifests or unsafe paths appear in `/plugins info <id>` diagnostics and do not affect other sessions
