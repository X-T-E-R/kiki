# Getting started

## What is Kiki

Kiki is an AI agent that runs in the terminal, helping you carry out software development tasks and day-to-day terminal operations — reading and modifying code, running shell commands, searching files, fetching web pages, and autonomously planning and adjusting its next steps based on feedback as it works.

It fits scenarios such as:

- **Writing and modifying code**: implementing new features, fixing bugs, completing refactors
- **Understanding a project**: exploring an unfamiliar codebase and answering questions about architecture and implementation
- **Automating tasks**: batch-processing files, running builds and tests, chaining multiple scripts together

The Kiki CLI is written in TypeScript and runs on Node.js.

## Installation

This candidate has not been published to npm, and the repository has not verified that a new registry package exists. Use a release artifact that explicitly contains the current `kiki` entry point, or run the CLI from source while developing.

::: tip Before you install
Kiki is a fully interactive TUI application. For the best visual experience, run it in a terminal with true-color and ligature support, such as [Kitty](https://sw.kovidgoyal.net/kitty/) or [Ghostty](https://ghostty.org/).
:::

### Release artifact

When a published build is available, use only a [GitHub Releases](https://github.com/X-T-E-R/kiki/releases) entry whose release notes and artifact contents explicitly include the current `kiki` executable. Do not infer that a registry package is published from this source tree.

> On Windows, install [Git for Windows](https://gitforwindows.org/) before first launch. Kiki uses the bundled Git Bash as its shell environment; if Git Bash is installed in a custom location, set `KIMI_SHELL_PATH` to the absolute path of `bash.exe`.

### Development from source

Source development requires Node.js `24.15.0` or later and pnpm `10.33.0`. From the repository root:

```sh
node --version
pnpm --version
pnpm install
pnpm dev:cli -- --help
```

The root `dev:cli` script runs `apps/kimi-code`'s `dev` script. It starts the local development marketplace server and forwards `--help` to the CLI entry point; no published package or global install is required.

## Upgrade and uninstall

For a release build, verify the executable named by that release before upgrading:

```sh
kiki --version
```

**Upgrade**: follow the instructions and artifact names in the relevant [GitHub Releases](https://github.com/X-T-E-R/kiki/releases) entry. Use an npm or pnpm upgrade only when that release explicitly documents a published package.

**Uninstall**: if you previously installed a published npm package, `npm uninstall -g @kiki/cli` applies only when that exact package was actually installed. For a release binary, delete the `kiki` executable; source development is removed by deleting the checkout and does not install a global command.

## First launch

Move into your project directory and run `kiki` from a release build to start the daemon-backed interactive UI:

```sh
cd your-project
kiki
```

When developing from source, run `pnpm dev:cli` from the repository root instead. To run a single instruction without entering the interactive UI, use `-p`:

```sh
kiki -p "Take a look at this project's directory structure"
```

To resume the previous session, add `-c`:

```sh
kiki -c
```

On first launch you need to configure an API source. In the interactive UI, enter `/login` to begin the login flow:

```
/login
```

`/login` opens a platform selector supporting two options:

- **Kimi Code (OAuth)** — device-code flow; open the link on any device, sign in, and enter the code to authorize
- **Kimi Platform API key** — enter an API key from `platform.kimi.com` or `platform.kimi.ai`

To sign out, enter `/logout` to clear the current credentials.

::: tip Using other AI providers
If you want to connect Anthropic, OpenAI, Google, or other providers, edit `~/.kiki/config.toml` directly to configure the API key. See [Providers and models](../configuration/providers.md) for details. For the full reference of all config options, see [Configuration files](../configuration/config-files.md), [Environment variables](../configuration/env-vars.md), and [Configuration overrides](../configuration/overrides.md).
:::

## Your first conversation

Once logged in, describe a task in natural language. A good starting point is to let Kiki familiarize itself with the project:

```
Take a look at this project's directory structure and briefly describe what each directory is for.
```

Kiki automatically calls file-reading, search, and other tools to browse the relevant content before responding. Read-only operations are executed automatically by default without requiring confirmation. For operations that modify files or run shell commands, it asks for your confirmation before proceeding.

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
| `/compact` | Manually compress the context to free up tokens |
| `/fork` | Fork the current session into an independent copy with full history (you stay in the current session) |

**Most-used keyboard shortcuts**

| Shortcut | Description |
| --- | --- |
| `Esc` | Interrupt streaming output / close a popup |
| `Ctrl-C` | Interrupt output; press twice while idle to exit |
| `Shift-Tab` | Toggle Plan mode |
| `Ctrl-S` | Inject a message mid-stream without waiting for the current response to finish |
| `Ctrl-O` | Collapse / expand tool output and compaction summaries |

For the full list, type `/help` or visit [Slash commands reference](../reference/slash-commands.md) and [Keyboard shortcuts](../reference/keyboard.md).

## Where data is stored

Kiki stores its local data under `~/.kiki/` by default — config files, session records, logs, and the update cache. To move it elsewhere, point to a new path via the `KIKI_HOME` environment variable. For the full directory layout, see [Data locations](../configuration/data-locations.md) and [Environment variables](../configuration/env-vars.md).

## Next steps

- [Interaction and input](./interaction.md) — input box operations, approval flow, Plan mode, and YOLO mode explained
- [Sessions and context](./sessions.md) — resuming sessions, compressing context, exporting sessions
- [Common use cases](./use-cases.md) — prompt examples for typical tasks
