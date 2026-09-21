# Kiki

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Docs](https://img.shields.io/badge/docs-online-blue)](https://x-t-e-r.github.io/kiki/en/) <br>
[Documentation](https://x-t-e-r.github.io/kiki/en/) · [Issues](https://github.com/X-T-E-R/kiki/issues) · [中文](README.zh-CN.md)

## What is Kiki

Kiki is a local agent workspace: it can read and edit code, run shell commands, search files, fetch web pages, and choose the next step based on the feedback it receives. It ships in three forms that share one daemon and one session store — a desktop app, a terminal CLI/TUI, and a browser UI served by the local server. It works out of the box with Moonshot AI's Kimi models and can also be configured to use other compatible providers.

Kiki began as a fork of [Kimi Code](https://github.com/MoonshotAI/kimi-code) and is now developed independently.

## Install

Download the appropriate build from [GitHub Releases](https://github.com/X-T-E-R/kiki/releases):

- **Desktop app (recommended):** `Kiki_*_x64-setup.exe` for Windows.
- **CLI:** the `kiki` executable for your platform, from the `kiki-v<version>` release assets.

> On Windows, install [Git for Windows](https://gitforwindows.org/) before first launch because the Kiki CLI uses the bundled Git Bash as its shell environment. If Git Bash is installed in a custom location, set `KIKI_SHELL_PATH` to the absolute path of `bash.exe`.

Then verify it with a new shell session:

```sh
kiki --version
```

The CLI is not published to npm; use the release artifacts, or run from source while developing. See [Installation](https://x-t-e-r.github.io/kiki/en/getting-started/installation) for update channels and details.

## Quick Start

Open a project and start the interactive UI:

```sh
cd your-project
kiki        # terminal UI
kiki web    # browser UI
```

On first launch, run `/login` and choose either Kimi Code OAuth or a Moonshot AI Open Platform API key. After login, try your first task:

```
Take a look at this project and explain its main directories.
```

## Key Features

- **Three forms, one workspace.** Desktop app, terminal TUI, and browser UI share the same daemon, sessions, and configuration — switch between them freely.
- **Subagents for focused, parallel work.** Dispatch subagents in isolated contexts while keeping the main conversation clean, and watch them live in the agent panel.
- **Background tasks and message queue.** Long-running work detaches into background tasks; messages sent while the agent is busy queue up with per-message timing control.
- **Goal mode.** Start a message with `/goal` to pin an objective the agent pursues across turns, with pause, edit, and cancel controls.
- **Task board.** Track requirements and tasks per workspace, linked to the sessions that work on them.
- **Scheduled tasks.** Cron jobs fire prompts into sessions on a schedule, managed from a global panel.
- **Provider and model management.** Configure providers, models, and thinking effort from the settings UI; Kimi works out of the box.
- **Video input.** Drop a screen recording or demo clip into the chat and let the agent watch what is hard to describe in words.
- **AI-native MCP configuration.** Add, edit, and authenticate Model Context Protocol servers conversationally with `/kiki-ops`, without hand-editing JSON.
- **Rich plugin ecosystem.** Install skills, MCP servers, and data sources from the marketplace or any GitHub repo, with each install's trust level surfaced up front.
- **Lifecycle hooks.** Run local commands at key points to gate risky tool calls, audit decisions, trigger desktop notifications, or connect to your own automation.
- **Editor & IDE integration (ACP).** Drive a Kiki session straight from Zed, JetBrains, or any [Agent Client Protocol](https://agentclientprotocol.com/) client with `kiki acp`.

## Use it in your editor (ACP)

Kiki speaks the [Agent Client Protocol](https://agentclientprotocol.com/), so ACP-compatible editors and IDEs (Zed, JetBrains, …) can drive a session over stdio. Log in once, then point your editor at the `kiki acp` subcommand — no extra login needed.

For Zed, add this to `~/.config/zed/settings.json`:

```json
{
  "agent_servers": {
    "Kiki": {
      "type": "custom",
      "command": "kiki",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Then open a new conversation in Zed's Agent panel. See the [ACP guide](https://x-t-e-r.github.io/kiki/en/server/acp) for JetBrains setup and troubleshooting.

## Docs

- [Installation](https://x-t-e-r.github.io/kiki/en/getting-started/installation)
- [First launch](https://x-t-e-r.github.io/kiki/en/getting-started/first-launch)
- [Desktop app](https://x-t-e-r.github.io/kiki/en/getting-started/desktop-app)
- [Interaction and approvals](https://x-t-e-r.github.io/kiki/en/guides/interaction)
- [Configuration](https://x-t-e-r.github.io/kiki/en/configuration/config-files)
- [Command reference](https://x-t-e-r.github.io/kiki/en/reference/command)

## Develop

Requirements: Node.js ≥ 24.15.0, pnpm 10.33.0.

```sh
git clone https://github.com/X-T-E-R/kiki.git
cd kiki
pnpm install
```

```sh
pnpm dev:cli    # run the CLI in dev mode
pnpm test       # run tests
pnpm typecheck  # TypeScript check
pnpm lint       # oxlint
pnpm build      # build all packages
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contribution guide.

## Community

- [Issues](https://github.com/X-T-E-R/kiki/issues)
- For security vulnerabilities, see [SECURITY.md](SECURITY.md).

## Acknowledgements

Kiki's TUI is built on top of [`pi-tui`](https://github.com/earendil-works/pi-mono/tree/main/packages/tui), and the project began as a fork of [Kimi Code](https://github.com/MoonshotAI/kimi-code). We thank the authors of both for their valuable work.

## License

Released under the [MIT License](LICENSE).
