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

Instead of the terminal, the desktop app and the browser UI open a setup wizard on first run with the same four choices:

1. **Language and look** — the window behind the dialog previews each choice.
2. **Connect a model** — an API key works with the widest range of services, and you can instead sign in with a Kimi Code, GitHub Copilot, or ChatGPT (Codex) account. Templates are grouped by vendor, gateway, and local server. **Test connection** checks the values in the form without saving anything.
3. **Permissions** — the default permission mode for new sessions. Auto is the recommended choice: it works on its own inside the workspace and asks before sensitive or external actions.
4. **What else Kiki can do** — web search and history, memory, SSH hosts, external engines, plugins, skills and MCP, scheduled tasks, the task board, and bots. Each row either opens its settings or, with **Let Kiki set it up**, opens a new session with a `/kiki-ops` request typed in for you to review and send.

Skip any page and finish it later — **Settings → Models & providers** holds the model connection, and **Replay setup wizard** in Settings starts the wizard over. The welcome message uses your configured model when you send it. If no model is configured, open the model selector in the composer to choose one or connect a provider; your draft stays in place. Send the same welcome request again after choosing a model; it uses that selection, including any thinking effort you chose. After connecting a provider, star the model you want in **Settings → Models & providers → Available models**; new sessions use starred models.

The wizard does not ask which folder to work in. **Get started with Kiki** opens a new session in a new folder under Kiki Home, with a request already typed into the composer: Kiki says in two or three sentences what it can do, asks what you most want to get done, then takes you through doing it once — setting up whatever that step needs and leaving what already works alone. A default model and thinking effort for a subagent like the read-only Explore come up only when the task really has to have its material checked out first — the project's own files, or the outside sources a claim depends on. A first agent profile is offered only when the work in front of you is missing that role, with the reason attached; research, writing and office work get a role shaped to that job rather than the engineering pair. **Close setup** skips all of that and just closes the dialog. Nothing is sent in either case until you send it, and the starter chips on the new session offer a few opening prompts. For the workspace itself, the new session page still defaults to your most recent workspace, or a new folder under Kiki Home if you have none. You can also ask for any of that later setup with `/kiki-ops`, and [Agents and sub-agents](../customization/agents.md#built-in-sub-agents) covers how agent profiles pick their model.

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
