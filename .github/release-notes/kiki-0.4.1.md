# Kiki 0.4.1

First public download after 0.3.3. It includes the 0.4.0 product line and the fixes landed on `kiki` since then. The installers, CLI binaries, and npm packages on this Release are built by GitHub Actions from this tag. They are not a previously built local candidate, and that local candidate was not installed or promoted.

## Highlights

- **External engines and permissions.** Antigravity sessions keep host-approved tool permissions, model-effort checks, and native conversation recovery. External agents can use their allowed Kiki tools under their own identity, and the GUI keeps replies for children running external engines.
- **Conversations, files, and previews.** Thinking from one response stays in one timeline entry. File mentions can load past the first matches. The file pane can show sandboxed HTML and play native audio. Image attachments open in one viewer.
- **Plugins and setup.** Plugin settings can use a plugin's own interface. The task board is an optional official plugin. First-run setup can store working preferences and install Kiki help into an existing agent.
- **Desktop and usage.** Usage history can be reread from cache until the source records change. Windows Bash subprocesses are stopped with their process tree after a timeout or cancellation.

## What this release does not claim

Source review and affected tests accepted the changes above before tagging. These items were not part of that acceptance:

- Saving an edited text draft through the desktop writable path, and choosing a file with the native picker, were not exercised on an installed desktop.
- Terminal color, cursor, and scrolling were not checked on a real TTY.
- A shared Antigravity adapter was not pointed at a live URL, and the output layer was not checked on a newly deployed host.
- The mail plugin is a separate package. It is not in this Release, and this version was not connected to a real mailbox.

## Install or upgrade

Update the desktop app and server together. Existing conversation history, credentials, and drafts are left in place.

| Platform | Desktop download |
| --- | --- |
| Windows x64 | `Kiki_0.4.1_x64-setup.exe` — NSIS installer, includes CLI |
| Linux x64 | `Kiki_0.4.1_amd64.AppImage` or `Kiki_0.4.1_amd64.deb` |
| macOS Apple Silicon | `Kiki_0.4.1_aarch64.dmg` |
| macOS Intel | `Kiki_0.4.1_x64.dmg` |

Standalone CLI downloads are `kiki-linux-x64`, `kiki-linux-arm64`, `kiki-darwin-x64`, and `kiki-darwin-arm64`, each with an adjacent `.sha256` file. Windows receives the CLI through the unified installer or npm, not a separate Release executable.

For npm, install one of these packages with Node.js 24.15 or newer:

```sh
npm install -g kiki-agent@0.4.1
```

For CLI/TUI only:

```sh
npm install -g kiki-agent-lite@0.4.1
```

Verify downloaded files against their adjacent `.sha256` files. Windows installers are not Authenticode-signed, so SmartScreen may show **Unknown publisher**; Windows x64 automatic updates use a separate release-key signature. macOS downloads are unsigned and not notarized: follow the [macOS first-open and CLI-linking steps](https://x-t-e-r.github.io/kiki/en/getting-started/installation#install-the-desktop-app). Linux and macOS desktop updates require manual replacement.

[Installation guide](https://x-t-e-r.github.io/kiki/en/getting-started/installation) · [First conversation](https://x-t-e-r.github.io/kiki/en/getting-started/first-launch) · [Report a problem](https://github.com/X-T-E-R/kiki/issues)
