# Kimi Code

AI coding assistant for VS Code, built for long-context workflows and complex coding tasks.

## Features

- **Works alongside you**: Kimi autonomously explores your codebase, reads and writes code, and runs terminal commands with your permission
- **Thinking controls**: Toggle reasoning or choose a model-supported thinking effort
- **Provider-aware models**: Distinguish and select same-named models across configured providers
- **Native editor integration**: Review AI-proposed changes directly in VS Code's diff viewer
- **MCP support**: Extend capabilities with Model Context Protocol servers
- **Slash commands**: Quick actions like `/init` to analyze your project and `/compact` to manage context

## Install

Kimi Code requires VS Code 1.100.0 or later.

1. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=moonshot-ai.kimi-code)
2. Open a folder in VS Code
3. Click the Kimi icon in the Activity Bar
4. Sign in with a [kimi.com/code](https://www.kimi.com/code) subscription, or use a provider already configured in the shared `config.toml`

The extension loads the shared Kiki GUI and attaches to a local Kimi daemon. If
no running daemon is registered, it starts `kimi web`, so the `kimi` executable
must be available on `PATH`. When the extension and terminal app resolve to the
same `KIMI_CODE_HOME`, they share configuration, login state, and sessions. The
system-level `KIMI_CODE_HOME` environment variable is supported; there is no
separate VS Code setting for it.

## Docs

Official doc for Kimi Code can be found at [www.kimi.com/code/docs](https://www.kimi.com/code/docs/en/kimi-code-for-vscode/guides/getting-started.html)

## License

[Apache-2.0](LICENSE)
