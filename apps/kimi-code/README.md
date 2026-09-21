# @kiki/cli

> A local agent workspace for Kiki

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Docs](https://img.shields.io/badge/docs-online-blue)](https://x-t-e-r.github.io/kiki/) [Releases](https://github.com/X-T-E-R/kiki/releases)

## What is Kiki CLI

Kiki is a local agent workspace with a desktop GUI, a CLI/TUI, and a browser UI available through `kiki web`. It can read and edit code, run shell commands, search files, fetch web pages, and choose the next step from the feedback it receives. It works out of the box with Moonshot AI's Kimi models and can also be configured to use other compatible providers.

Kiki began as a fork of Kimi Code (Moonshot AI) and is now developed independently.

## Install

Download the appropriate build from [GitHub Releases](https://github.com/X-T-E-R/kiki/releases).

> On Windows, install [Git for Windows](https://gitforwindows.org/) before first launch because Kiki CLI uses the bundled Git Bash as its shell environment. If Git Bash is installed in a custom location, set `KIKI_SHELL_PATH` to the absolute path of `bash.exe`.

Then run it with a new terminal session:

```sh
kiki --version
```

### A note on npm

The CLI is currently not published to npm; use the release artifacts, or run from source while developing.

For uninstall instructions, see the [installation guide](https://x-t-e-r.github.io/kiki/en/getting-started/installation).

## Quick Start

Open a project and start the interactive UI:

```sh
cd your-project
kiki
```

On first launch, run `/login` inside Kiki CLI and choose either Kimi Code OAuth or a Kimi Platform API key. After login, try a first task:

```
Take a look at this project and explain the main directories.
```

To use the browser UI, run:

```sh
kiki web
```

## Key Features

- **Local-first workspace.** Use the desktop GUI, CLI/TUI, or browser UI while keeping sessions and configuration on your machine.
- **Subagents and background tasks.** Dispatch focused subagents and let work continue while you review results or keep working.
- **Goal mode and task board.** Break larger objectives into tracked tasks and monitor their progress.
- **Cron scheduling.** Schedule recurring agent work from the local workspace.
- **Provider and model management.** Configure compatible providers and choose models for each task.
- **Video input.** Drop a screen recording or demo clip into the chat so the agent can inspect it.
- **AI-native MCP configuration.** Add, edit, and authenticate Model Context Protocol servers conversationally via `/kiki-ops Configure MCP` — no hand-editing JSON.
- **Lifecycle hooks.** Run local commands at key points — gate risky tool calls, audit decisions, fire desktop notifications, or connect your own automation.

## Documentation

- Full docs: https://x-t-e-r.github.io/kiki/en/
- 中文文档: https://x-t-e-r.github.io/kiki/zh/
- Getting Started: https://x-t-e-r.github.io/kiki/en/getting-started/installation

## Repository & Issues

- Source: https://github.com/X-T-E-R/kiki
- Issues: https://github.com/X-T-E-R/kiki/issues
- Security: see [SECURITY.md](../../SECURITY.md) in the main repository

## License

MIT
