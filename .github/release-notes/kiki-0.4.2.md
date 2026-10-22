# Kiki 0.4.2

This release updates conversation recovery, browser and plugin settings, session capabilities, and mobile chat connections.

## Highlights

- **Browser sources and Ego Lite.** Switch browser sources independently and choose allowed connections within each source. Turning a source off keeps its selections. Ego Lite readiness checks on Windows no longer confuse an installed, prepared browser with unfinished setup. Install Ego Lite separately from its official site, then check and allow it in Browser & computer settings.
- **Session capabilities.** The conversation sidebar has compact switches for browser, computer, memory, thread communication, and web tools. New installations default to memory, thread communication, and web on, with browser and computer off. Existing explicit choices remain in effect. A globally disabled capability stays unavailable; a default-off capability can be enabled for a session or an explicitly configured profile.
- **Phone conversations.** Notifications & messages separates two-way chat, push channels, and local alerts. Bind a paired phone chat to a persona or thread, change its target, and manage phone actions from settings or the conversation sidebar. Multiple accounts and incoming identities require an explicit choice, and reconnecting accounts are distinguished from listeners that are ready.
- **Plugin installation and settings.** Marketplace ZIP installs use the published checksum. Plugin forms group related settings and offer existing connection choices. Custom settings panels receive the app's presentation context and resize to their content while keeping their own controls and wording.
- **External agents and saved conversations.** Unchanged prompt refreshes preserve external session bindings. AgentSend respects the effective delegation setting and keeps undelivered messages queued for the original child. Conversation views retain quoted content and attachments through submission and history recovery.
- **Spaces and Recipes.** Cross-space thread listing and waiting no longer fail with an invalid bridge request. Child spaces can read installed Recipes from their base space with local overrides. Relative model Recipe paths resolve from the configuration that declares them; inherited packages can be copied or extended before editing.

Telegram, Feishu, QQ/OneBot, and WeChat have different message and attachment support. QQ does not accept files through the current bridge, and an unknown send failure is not treated as a length rejection and resent in pieces. The complete assistant reply remains available on the desktop. See [Phone sessions](https://x-t-e-r.github.io/kiki/en/features/phone) for setup and platform behavior.

## Install or upgrade

Update the desktop app and server together. Windows x64 uses the NSIS installer and includes the CLI. Linux x64 offers AppImage and deb packages; macOS offers Apple Silicon and Intel dmg packages.

For desktop and CLI through npm, use Node.js 24.15 or newer:

```sh
npm install -g kiki-agent@0.4.2
```

For CLI/TUI only:

```sh
npm install -g kiki-agent-lite@0.4.2
```

Standalone CLI downloads are `kiki-linux-x64`, `kiki-linux-arm64`, `kiki-darwin-x64`, and `kiki-darwin-arm64`, with adjacent `.sha256` files. Windows receives the CLI through the installer or npm.

Windows installers are not Authenticode-signed; SmartScreen may show **Unknown publisher**. Windows x64 automatic updates use a separate release-key signature. macOS downloads are unsigned and not notarized; follow the [first-open and CLI-linking steps](https://x-t-e-r.github.io/kiki/en/getting-started/installation#install-the-desktop-app). Linux and macOS desktop updates use manual replacement.

[Installation guide](https://x-t-e-r.github.io/kiki/en/getting-started/installation) · [Report a problem](https://github.com/X-T-E-R/kiki/issues)
