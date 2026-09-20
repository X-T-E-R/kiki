# Kiki

AI coding assistant for VS Code, built for long-context workflows and complex coding tasks.

## Features

- **Works alongside you**: Kiki autonomously explores your codebase, reads and writes code, and runs terminal commands with your permission
- **Thinking controls**: Toggle reasoning or choose a model-supported thinking effort
- **Provider-aware models**: Distinguish and select same-named models across configured providers
- **Native editor integration**: Review AI-proposed changes directly in VS Code's diff viewer
- **MCP support**: Extend capabilities with Model Context Protocol servers
- **Slash commands**: Quick actions like `/init` to analyze your project and `/compact` to manage context

## Install

Kiki requires VS Code 1.100.0 or later.

1. Install the Kiki VSIX using your normal VS Code extension workflow
2. Open a folder in VS Code
3. Click the Kiki icon in the Activity Bar
4. Sign in with the Kimi service, or use a provider already configured in the shared `config.toml`

The extension loads the shared Kiki GUI and attaches to a local Kiki web server. If
no running server is registered, it starts `kiki web`, so the `kiki` executable
must be available on `PATH`. When the extension and terminal app resolve to the
same `KIKI_HOME`, they share configuration, login state, and sessions. The
system-level `KIKI_HOME` environment variable is supported; there is no
separate VS Code setting for it.

## Configuration migration

On first activation, existing `kimi.autosave` and `kimi.editorContext` settings
are copied to their `kiki.*` counterparts only when the corresponding Kiki
setting has not already been set. No other hidden settings or extension state is
migrated.

## License

[Apache-2.0](LICENSE)
