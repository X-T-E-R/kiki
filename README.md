# Kiki

**Agents that answer to you.**

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Docs](https://img.shields.io/badge/docs-online-blue)](https://x-t-e-r.github.io/kiki/en/) <br>
[Documentation](https://x-t-e-r.github.io/kiki/en/) · [All features](marketing/features.en.md) · [Screenshot tour](marketing/gallery.en.md) · [Issues](https://github.com/X-T-E-R/kiki/issues) · [中文](README.zh-CN.md)

Kiki is an open-source AI agent workbench that runs on your machine, with a desktop app, a terminal UI, and a browser UI all backed by one local daemon.

<!-- Hero: replace with the real screen recording of a lead session (marketing/launch/demo-storyboard.md) once it is recorded. -->
![The Kiki workbench: a lead session with its dispatched subagents, a background task, an active goal, and a queued message.](marketing/shots/h01-fleet-workbench.en.light.png)

*Example scene rendered by the real Kiki UI; not a measured model-performance demo. A real screen recording will replace it.*

## Freedom: every layer is yours

- **Models.** Bind each role to its own model and mix vendors in one session. For example, a frontier model plans, DeepSeek or GLM does the routine work, and a different vendor reviews. Kimi works out of the box; Anthropic, OpenAI-compatible, Gemini, and Vertex providers can be added.
- **Agents.** An agent is a Markdown file you own. The frontmatter sets its tools, model, and which agents it may dispatch, and the body is its system prompt. Claude Code and OpenCode agent files load as they are, and edits reload in about 200 ms.
- **Prompts.** Rewrite any built-in prompt field, down to a single tool's description, either globally, per model, or per agent. `kiki prompt-fields list | show | explain` shows exactly what the model receives and where each value came from.
- **Data.** Sessions stay on your machine and there is no cloud relay. Kiki is MIT-licensed.

![Prompt field overrides with a live preview of what the model will see.](marketing/shots/d02-prompt-fields.en.light.png)

## Power: built for long, many-threaded work

- **A lead agent runs several lines at once.** It dispatches subagents itself, sends long work to the background, and is notified automatically when that work finishes, so it doesn't need to poll.
- **Keep talking while it works.** Messages you send while it's busy wait in a queue. Each one can go out when the agent is idle, after its subagents finish, or after its tasks finish, and you can reorder, edit, or send one immediately.
- **Work that outlasts a session.** A per-workspace requirement board that the agent reads and writes, `/goal` targets it pursues across turns, and cron-scheduled prompts.
- **One daemon, every surface.** The desktop app, the terminal, and the browser share the same sessions, and Zed and JetBrains connect over [ACP](https://agentclientprotocol.com/).

![One session, several models: each role in the dispatch tree bound to a different model.](marketing/shots/r05-multi-model-fleet.en.light.png)

**[All features →](marketing/features.en.md)**

## Quick start (60 seconds)

```sh
npm install -g kiki-agent   # Node.js 24.15.0+; or grab a desktop build below
cd your-project
kiki                        # terminal UI; `kiki web` for the browser, `kiki desktop` for the app
```

Run `/login` and choose Kimi Code OAuth or a Kimi Platform API key. For other providers, see [Providers and models](https://x-t-e-r.github.io/kiki/en/configuration/providers). Then ask:

```
Take a look at this project and explain its main directories.
```

New sessions start in Auto mode: routine work runs on its own, and sensitive files or dangerous commands still ask first. Switch modes with `/permission`. On Windows, install Git for Windows first (see below).

## Install

Choose a build from [GitHub Releases](https://github.com/X-T-E-R/kiki/releases) under `kiki-v<version>`:

| Platform | Desktop app | Standalone CLI/TUI |
| --- | --- | --- |
| Windows x64 | `Kiki_*_x64-setup.exe` (also installs `kiki` on your user `PATH`) | Included in the installer; no separate Windows CLI asset |
| Linux x64 | `Kiki_*_amd64.deb` (adds `kiki` to `PATH`) or `Kiki_*_amd64.AppImage` | `kiki-linux-x64` |
| Linux ARM64 | — | `kiki-linux-arm64` |
| macOS Apple Silicon | `Kiki_*_aarch64.dmg` | `kiki-darwin-arm64` |
| macOS Intel | `Kiki_*_x64.dmg` | `kiki-darwin-x64` |

Each standalone CLI file comes with a matching `.sha256` checksum. On macOS, the dmg is unsigned and not notarized: verify the download, drag Kiki to Applications, then use **Control-click → Open** on first launch. The dmg does not change your `PATH`, so add the CLI to it separately.

With npm, `kiki-agent` installs the CLI/TUI and downloads and checksum-verifies the matching desktop release (network required); `kiki-agent-lite` installs only the CLI/TUI. `kiki desktop` opens the installed app, or explains how to get it.

> On Windows, install [Git for Windows](https://gitforwindows.org/) before first launch because the Kiki CLI uses the bundled Git Bash as its shell environment. If Git Bash is installed in a custom location, set `KIKI_SHELL_PATH` to the absolute path of `bash.exe`.

Verify with `kiki --version` in a new terminal. See [Installation](https://x-t-e-r.github.io/kiki/en/getting-started/installation) for checksum commands and update channels. To use Kiki inside Zed or JetBrains, see the [ACP guide](https://x-t-e-r.github.io/kiki/en/server/acp).

## Docs

[First launch](https://x-t-e-r.github.io/kiki/en/getting-started/first-launch) · [Desktop app](https://x-t-e-r.github.io/kiki/en/getting-started/desktop-app) · [Agent profiles](https://x-t-e-r.github.io/kiki/en/customization/agent-profiles) · [Prompt field overrides](https://x-t-e-r.github.io/kiki/en/customization/prompt-fields) · [Interaction and approvals](https://x-t-e-r.github.io/kiki/en/guides/interaction) · [Configuration](https://x-t-e-r.github.io/kiki/en/configuration/config-files) · [Command reference](https://x-t-e-r.github.io/kiki/en/reference/command)

## Develop

Requirements: Node.js ≥ 24.15.0, pnpm 10.33.0.

```sh
git clone https://github.com/X-T-E-R/kiki.git && cd kiki && pnpm install
pnpm dev:cli    # run the CLI in dev mode
pnpm test       # tests  ·  pnpm typecheck  ·  pnpm lint  ·  pnpm build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide. Report bugs in [Issues](https://github.com/X-T-E-R/kiki/issues); for security vulnerabilities, see [SECURITY.md](SECURITY.md).

## Acknowledgements

Kiki began as a fork of [Kimi Code](https://github.com/MoonshotAI/kimi-code) and is now developed independently. Its TUI is built on [`pi-tui`](https://github.com/earendil-works/pi-mono/tree/main/packages/tui). We thank the authors of both for their valuable work.

## License

Released under the [MIT License](LICENSE).
