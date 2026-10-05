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

The extension loads the shared Kiki GUI and attaches to a local Kiki web
server. If no server is registered, it starts one with `kiki serve --ensure`,
so the `kiki` executable must be on your `PATH`. When the extension and your
terminal app resolve the same `KIKI_HOME`, they share configuration, login
state, and sessions. Set `KIKI_HOME` as a system environment variable; the
extension has no separate setting for it.

## Configuration migration

On first activation, the extension copies your `kimi.autosave` and
`kimi.editorContext` settings to `kiki.autosave` and `kiki.editorContext`,
preserving each one's VS Code scope, but only where you have not already set
the `kiki.*` one. Nothing else is carried over.

## License

[Apache-2.0](LICENSE)
