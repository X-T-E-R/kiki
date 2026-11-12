# First launch

You have Kiki installed. This page walks through the first ten minutes: starting it in your project, connecting a model, and getting a useful answer out of it.

## Start Kiki

Move into your project directory and run `kiki` to start the interactive UI:

```sh
cd your-project
kiki
```

If you are working from a source checkout, run `pnpm dev:cli` from the repository root instead. To send a single instruction without entering the interactive UI, use `-p` (prompt mode):

```sh
kiki -p "Take a look at this project's directory structure"
```

Add `-c` (short for `--continue`) to pick up the previous session; [Workspaces and sessions](../guides/sessions.md#starting-and-resuming-sessions) covers how that differs from `--session`:

```sh
kiki -c
```

## Connect a model

Kiki needs a model before it can answer anything. In the interactive UI, type `/login`:

```sh
/login
```

That opens a picker with four options:

- **Kimi Code (kimi.com/code)** — the managed subscription, via a device-code flow: open the link on any device, sign in, and enter the code
- **Kimi Code (kimi.ai/code)** — the same flow against the global endpoint
- **Kimi Platform (API key · platform.kimi.com)** — an API key from the mainland platform console
- **Kimi Platform (API key · platform.kimi.ai)** — an API key from the global platform console

`/logout` clears the current credentials.

::: tip Other providers
Anthropic, OpenAI, Google, and other providers are configured in `~/.kiki/config.toml` — see [Providers and models](../configuration/providers.md). The full option reference is split across [Configuration files](../configuration/config-files.md), [Environment variables](../configuration/env-vars.md), and [Configuration overrides](../configuration/overrides.md).
:::

In the desktop app and the browser UI, first run happens on the new conversation page itself, and no dialog opens. While Kiki has no usable sign-in and no models, a card titled **Connect a model so Kiki can answer.** sits where the message box will be. It offers three ways in, and each one finishes on the card:

- **Sign in with an account**: lists the subscription accounts this Kiki can sign in to, the same sign-ins Settings offers, and runs the sign-in on the card.
- **Enter an API key**: choose a service from the models.dev directory (OpenAI, Anthropic, DeepSeek and others), paste the key, and press **Connect**. Kiki saves the connection and then sends one small real request to check it, so a service counts as connected only after it has answered. A key that fails shows the provider's error, and the connection the card just added is removed again so you can try another key. For a service the list does not carry, a local server, or a custom address, **Add it in Settings** opens the full form.
- **Check for a sign-in already on this computer**: looks for an existing Codex, Kimi Code, or Grok sign-in. Nothing is read until you press it; the check is read-only and does not start the other app. The card then says what it found, or that it found nothing, and **Use this sign-in** attaches the account it showed. The check always looks at the computer running Kiki; when that may not be the one in front of you (in a browser, on a phone, or attached to another computer's Kiki), the lane's label says so.

Once a connection works, the message box takes the card's place, with one line naming what was connected and the model new conversations use. The card is not a one-time step: it comes back whenever Kiki again has no usable sign-in and no models. Its header also has an English / 中文 language switch. Appearance is not asked; it follows your system until you change it under **Settings → Appearance** (see [GUI skins](../customization/skins.md)).

The card's last line, **Already using Claude Code or Codex? Let it set up Kiki for you**, hands setup to an agent you already use. Pick Claude Code, Codex, Grok Build, or the shared agents folder; Kiki previews the `kiki-ops` skill file it will write there and whether one already exists, and writes it only after you confirm. It then gives you the line `/kiki-ops set Kiki up for me` to paste into that agent.

Below the starters, or below the card while nothing is connected, one line offers a one-minute tour that calls no model. It appears only while this Kiki has no conversations, and only once per device: **Start the tour**, **No thanks**, a tour started from **Discover Kiki**, or a first conversation puts it away.

**Discover Kiki** in the sidebar starts the same tour any time and lists three areas you can explore on their own. Each stop offers an action on the real page or a labelled local example. Leaving keeps your place, and **Continue exploring** takes you back. The tour creates no session, and a suggested prompt is only a draft until you send it.

Two more first-run hints wait for the moment they apply, and each comes once per device. The first approval you meet in Auto mode carries a short explanation of what Auto does on its own (reads, writes, and routine commands in the workspace) and what it asks about first (sensitive files, external links, and risky commands), with **Ask at every step** to switch that conversation to `manual` and **Got it** to keep Auto. The first time something finishes, fails, or waits for you while you are away and the system has never been asked about notifications, Kiki asks in words once you are back whether to send a system notification next time: **Notify me** asks the system then, and **No thanks** is remembered on this device without switching any notification off. The switches themselves are under [Notifications & messages](../guides/settings.md#notifications-messages).

First run does not ask which folder to work in. The new conversation page defaults to your most recent workspace; with none, your first send creates one under Kiki home (see [Starting and resuming sessions](../guides/sessions.md#starting-and-resuming-sessions)). Starters only fill the draft and never send on their own. [Connections](../guides/settings.md#connections) covers adding, signing in to, and managing connections after first run.

To get help with a real task, start a new conversation and ask `/kiki-ops` to help you get started. Kiki's bundled guidance asks what you most want to get done, then takes you through doing it once — setting up what that step needs and leaving what already works alone. You review the draft and press Send yourself.

A default model and thinking effort for a subagent like the read-only Explore come up only when the task requires examining material first — the project's files or the outside sources a claim depends on. A first agent profile is offered only when the work is missing that role, with the reason attached; research, writing and office work get a role shaped to that job rather than the engineering pair. You can ask for that setup later with `/kiki-ops`; [Agents and sub-agents](../customization/agents-and-subagents.md#built-in-sub-agents) explains how profiles pick their model.

## Your first conversation

Once logged in, describe what you want in natural language. Letting Kiki look around first is a good way to start:

```text
Take a look at this project's directory structure and briefly describe what each directory is for.
```

Kiki answers using tools (built-in capabilities it can call — reading files, searching code, running commands), so it looks at your project before it replies instead of guessing. Read-only calls run without stopping to ask.

New sessions start in Auto mode, so Kiki runs ordinary tool calls — including shell commands — without stopping to ask, and pauses for your approval before touching sensitive files such as `.env` or private keys. Use `/permission` to switch to `manual`, `auto`, `review` ("Approve for me", where a reviewer you configure decides first), or `yolo`; [Permission modes](../guides/interaction.md#permission-modes) explains what each one asks for.

You can also skip the tour and describe a concrete task:

```text
Add a function in src/utils that converts any string to kebab-case, and add a unit test for it.
```

Kiki plans the steps, modifies the code, runs the tests, and tells you what it did at each step.

::: tip Not sure what to do? Type `/help`
Type `/help` at any time to open the built-in command and keyboard shortcut panel. Use `↑`/`↓` to browse and `Esc` to close. To exit, type `/exit`, press `Ctrl-C` twice, or press `Ctrl-D` with the input box empty.
:::

## Commands and shortcuts worth knowing now

If you remember nothing else from this page, remember these:

**Session commands**

| Command | Description |
| --- | --- |
| `/new` | Start a new session, clearing the current context |
| `/sessions` | Browse session history and choose one to resume |
| `/model` | Switch the current model |
| `/compact` | Manually compress the context to free up tokens (a token is the basic unit models use to measure text — how many tokens a conversation takes determines how much context fits) |
| `/fork` | Fork the current session into an independent copy with full history (you stay in the current session) |

**Most-used keyboard shortcuts**

| Shortcut | Description |
| --- | --- |
| `Esc` | Interrupt streaming output (output that appears piece by piece in real time) / close a popup |
| `Ctrl-C` | Interrupt output; press twice while idle to exit |
| `Shift-Tab` | Toggle Plan mode |
| `Ctrl-S` | Inject a message mid-stream without waiting for the current response to finish |
| `Ctrl-O` | Collapse / expand tool output and compaction summaries (the summaries generated when context is compressed) |

For the full list, type `/help` or visit [Slash commands](../reference/slash-commands.md) and [Keyboard shortcuts](../reference/keyboard.md).

## Where data is stored

Kiki keeps its local data under `~/.kiki/` — config files, session records, logs, and the update cache. Set the `KIKI_HOME` environment variable to move all of it somewhere else. One exception: unless `KIKI_HOME` is set, the desktop app reads OAuth credentials from the compatibility home `~/.kimi-code/`. [Data locations](../configuration/data-locations.md) lists every path and what it holds.

## Next steps

- [Interaction and input](../guides/interaction.md) — input box operations, approval flow, Plan mode, and YOLO mode explained
- [Workspace and session management](../guides/sessions.md) — resuming sessions, the task board, compressing context, exporting sessions
- [Common use cases](./use-cases.md) — prompt examples for typical tasks
