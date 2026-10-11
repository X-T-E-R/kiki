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

Instead of the terminal, the desktop app and the browser UI open a welcome on first run with three steps:

1. **What Kiki can help you do** — four uses, one line each, named like the tour routes that follow: doing one thing first, understanding and directing work, keeping work going, and extending Kiki when needed. Language is one small switch beside the title; theme, colors, and a background picture sit behind the **Appearance** row below, and once it is open the window behind the dialog previews each choice.
2. **How should Kiki work with you?** — choose the default permission mode, whether completed work should notify you while you are away, and a concise or detailed reply style. Auto is recommended; Review is under **More**. Reply style is saved as one user memory: reopening setup updates that preference rather than adding another. You can edit it under **Settings → Memory**. Failures, questions, and approval requests still notify you regardless of the completed-work switch.
3. **Go** — connect a model through Settings, install the `kiki-ops` help skill into an agent you already use, or open **Just look around first** to choose a tour. Installing the skill shows its destination and any overwrite before asking you to confirm. The five tour routes include a full overview and four starting points based on what interests you; choosing one starts the shared Discover tour and closes setup.

The first step only has **Next**. On the agreement step, **Next** or **Set up later** saves an explicit permission choice before continuing; notification and reply-style choices save when selected. A failed save stays visible, and a reply-style failure does not prevent you from continuing. **Close setup** ends the run without starting a tour. **Replay setup wizard** in Settings opens it again with your saved preferences.

The wizard hands off model setup rather than writing provider credentials itself. With no usable model, the new session page also offers **Sign in with an account** (Kimi Code, GitHub Copilot, or ChatGPT (Codex)) and **Use an API key or local server**. Each opens its own lane in **Settings → Models & providers**, where templates are grouped by vendor, gateway, and local server. **Test connection** checks the form without saving it. Star a model under **Available models** to use it in new sessions.

The welcome message uses the model and thinking effort you select when you send it. If none is configured, use the composer's model selector to choose one or connect a provider; your draft stays in place. Then resend the same welcome request. Neither a tour nor closing setup sends a prompt, and starter chips only prepare a draft.

The wizard does not ask which folder to work in. The new session page defaults to your most recent workspace, or a new folder under Kiki Home if you have none. You can ask for later setup with `/kiki-ops`; [Agents and sub-agents](../customization/agents.md#built-in-sub-agents) covers how profiles pick their model.

The guided routes also remain available from **Discover Kiki** in the sidebar. Each stop offers an action on the real page or a labelled local example. Leaving keeps your place, and **Continue exploring** takes you back. The tour itself makes no model calls and creates no demo session; a suggested prompt is only a draft until you send it.

To get help with a real task, start a new conversation and ask `/kiki-ops` to help you get started. Kiki's bundled guidance asks what you most want to get done, then takes you through doing it once — setting up what that step needs and leaving what already works alone. You review the draft and press Send yourself.

A default model and thinking effort for a subagent like the read-only Explore come up only when the task requires examining material first — the project's files or the outside sources a claim depends on. A first agent profile is offered only when the work is missing that role, with the reason attached; research, writing and office work get a role shaped to that job rather than the engineering pair. You can ask for that setup later with `/kiki-ops`; [Agents and sub-agents](../customization/agents.md#built-in-sub-agents) explains how profiles pick their model.

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
