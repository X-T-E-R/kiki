# @kiki/cli

> A local agent workspace for Kiki

[![License](https://img.shields.io/badge/license-MIT-blue)](https://github.com/X-T-E-R/kiki/blob/kiki/LICENSE) [![Docs](https://img.shields.io/badge/docs-online-blue)](https://x-t-e-r.github.io/kiki/) [Releases](https://github.com/X-T-E-R/kiki/releases)

## About

Kiki is a local agent workspace with a desktop GUI, a CLI/TUI, and a browser UI available through `kiki web`. It can read and edit code, run shell commands, search files, fetch web pages, and choose the next step from the feedback it receives. It works out of the box with Moonshot AI's Kimi models and can also be configured to use other compatible providers.

Kiki began as a fork of Kimi Code (Moonshot AI) and is now developed independently.

## Install

Download the appropriate build from [GitHub Releases](https://github.com/X-T-E-R/kiki/releases).

> **Windows:** install [Git for Windows](https://gitforwindows.org/) before first launch — Kiki CLI uses the bundled Git Bash as its shell environment. If Git Bash is in a custom location, set `KIKI_SHELL_PATH` to the absolute path of `bash.exe`.

Then open a new terminal session and confirm the install:

```sh
kiki --version
```

### Installing from npm

With Node.js 24.15.0 or later you can also install from npm. Pick **one** of these — they both provide the same `kiki` command, and installing both leaves you with a conflict:

- `kiki-agent` — CLI/TUI plus a checksum-verified desktop download
- `kiki-agent-lite` — CLI/TUI only

GitHub Releases remain the way to get a standalone executable. For checksums, update channels, and uninstall steps, see the [installation guide](https://x-t-e-r.github.io/kiki/en/getting-started/installation).

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

To use the browser UI instead, run:

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
- Security: report privately per https://github.com/X-T-E-R/kiki/blob/kiki/SECURITY.md

## License

[MIT](https://github.com/X-T-E-R/kiki/blob/kiki/LICENSE)
