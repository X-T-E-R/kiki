# First launch

This page picks up after installation: start Kiki, configure an API source, and run your first conversation.

## Start Kiki

Move into your project directory and run `kiki` to start the interactive UI:

```sh
cd your-project
kiki
```

When developing from source, run `pnpm dev:cli` from the repository root instead. To run a single instruction without entering the interactive UI, use `-p` (prompt mode):

```sh
kiki -p "Take a look at this project's directory structure"
```

To resume the previous session, add `-c` (short for `--continue`; how it differs from `--session` is covered in [Workspaces and sessions](../guides/sessions.md#starting-and-resuming-sessions)):

```sh
kiki -c
```

## Configure an API source

On first launch you need to configure an API source. In the interactive UI, enter `/login` to begin the login flow:

```sh
/login
```

`/login` opens a platform selector supporting two options:

- **Kimi Code (OAuth)** — device-code flow; open the link on any device, sign in, and enter the code to authorize
- **Kimi Platform API key** — enter an API key from `platform.kimi.com` or `platform.kimi.ai`

To sign out, enter `/logout` to clear the current credentials.

::: tip Using other AI providers
If you want to connect Anthropic, OpenAI, Google, or other providers, edit `~/.kiki/config.toml` directly to configure the API key. See [Providers and models](../configuration/providers.md) for details. For the full reference of all config options, see [Configuration files](../configuration/config-files.md), [Environment variables](../configuration/env-vars.md), and [Configuration overrides](../configuration/overrides.md).
:::

In the GUI, the optional first-run wizard covers provider, preferences, and search setup. Finishing it opens a draft with `/kiki-ops`; Kiki waits for you to send it. The guided conversation explains what subagent profiles do and asks what kind of role you want to create, with `implementer` and `reviewer` as examples. No profile is created without your approval; see [Agents and Sub-Agents](../customization/agents.md#built-in-sub-agents) for how profiles select models.

## Your first conversation

Once logged in, describe a task in natural language. A good starting point is to let Kiki familiarize itself with the project:

```
Take a look at this project's directory structure and briefly describe what each directory is for.
```

Kiki automatically calls file-reading, search, and other tools (tools are built-in capabilities the agent can invoke — reading files, searching code, running commands) to browse the relevant content before responding. Read-only operations are executed automatically by default without requiring confirmation.

File writes follow the workspace trust model rather than prompting on every call: in a trusted working directory, `Write` / `Edit` inside that directory run without per-file approval; writes outside the workspace, and access to sensitive files such as `.env` files and private keys, are blocked or require approval. Shell commands always ask for your confirmation first.

You can also describe a more concrete task directly:

```
Add a function in src/utils that converts any string to kebab-case, and add a unit test for it.
```

Kiki plans the steps, modifies the code, runs the tests, and tells you what it did at each step.

::: tip Not sure what to do? Type `/help`
Type `/help` at any time to open the built-in command and keyboard shortcut panel. Use `↑`/`↓` to browse and `Esc` to close. To exit, type `/exit`, press `Ctrl-C` twice, or press `Ctrl-D` with the input box empty.
:::

## Common commands and keyboard shortcuts

For a first-time user, the following is all you need to know:

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

Kiki stores its local data under `~/.kiki/` by default — config files, session records, logs, and the update cache. To move it elsewhere, point to a new path via the `KIKI_HOME` environment variable. Note that the desktop app's OAuth credentials default to the compatibility home `~/.kimi-code/` when `KIKI_HOME` is unset; see [Data locations](../configuration/data-locations.md) for the full picture.

## Next steps

- [Interaction and input](../guides/interaction.md) — input box operations, approval flow, Plan mode, and YOLO mode explained
- [Workspace and session management](../guides/sessions.md) — resuming sessions, the task board, compressing context, exporting sessions
- [Common use cases](./use-cases.md) — prompt examples for typical tasks
