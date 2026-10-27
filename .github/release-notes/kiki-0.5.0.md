# Kiki 0.5.0

This release moves canonical peer-message storage to SQLite and improves long conversation recovery, group chat controls, and the desktop interface.

## What changed

- **Mailbox upgrade.** Older homes must upgrade their peer-message mailbox before normal sessions open. The startup screen shows progress and recovery actions; `kiki storage status`, `migrate`, `cancel`, `rollback`, and `backup` provide the same path in the terminal. The original data and recovery copies are retained. Rollback is available only before SQLite accepts new canonical writes.
- **Conversations and performance.** Saved history loads in bounded pages, including long agent timelines. Repeated media results no longer show the same image twice. Markdown editing, model-directory reads, and browser detection avoid blocking unrelated interaction. The profile picker no longer waits for a preview before a new message can be entered.
- **Group chat.** Bind a group by sender, topic, or whole chat in Notifications & messages. Choose whether every message wakes the agent, only a supported mention/reply or configured prefix does, or messages are recorded without waking it. Mention/reply needs metadata from that chat service; use a prefix or every-message wake when it lacks that metadata. Broadening an existing binding asks for confirmation. Quiet group messages remain available in history.
- **Agent and tool controls.** Nested agents use a compact timeline branch. Session capability switches retain explicit off choices, and ordinary reply threads keep `SendMessage` off by default unless you enable it for a session or configure a different global default. Windows plugin and MCP commands resolve installed executables through `PATH`.

## Upgrade

Close other Kiki processes using the same home before upgrading. If the upgrade reports a writer is active, finish that work, close the old process, then retry. Keep the original mailbox and its recovery copies until you have verified the upgraded sessions. See [`kiki storage`](https://x-t-e-r.github.io/kiki/en/reference/command#kiki-storage) for status, backup, and rollback.

Download the desktop package for your system: `Kiki_0.5.0_x64-setup.exe` on Windows (includes the CLI); `Kiki_0.5.0_amd64.AppImage` or `Kiki_0.5.0_amd64.deb` on Linux x64; `Kiki_0.5.0_aarch64.dmg` on Apple Silicon or `Kiki_0.5.0_x64.dmg` on Intel macOS. Each has an adjacent `.sha256` file.

For npm, use Node.js 24.22.1 or later on the 24 line, or 26.12.1 or later; Node.js 25 and earlier 26 releases are not supported:

```sh
npm install -g kiki-agent@0.5.0
```

For CLI/TUI only:

```sh
npm install -g kiki-agent-lite@0.5.0
```

Standalone CLI downloads are `kiki-linux-x64`, `kiki-linux-arm64`, `kiki-darwin-x64`, and `kiki-darwin-arm64`, each with an adjacent `.sha256` file. Windows receives the CLI through its installer or npm.

Windows installers are not Authenticode-signed; SmartScreen may show **Unknown publisher**. Windows x64 automatic updates use a separate release-key signature. macOS downloads are unsigned and not notarized; follow the [first-open and CLI-linking steps](https://x-t-e-r.github.io/kiki/en/getting-started/installation#install-the-desktop-app). Linux and macOS desktop updates use manual replacement.

[Installation guide](https://x-t-e-r.github.io/kiki/en/getting-started/installation) · [Report a problem](https://github.com/X-T-E-R/kiki/issues)
