# Kiki 0.3.3

Start with something you want done, rather than a configuration interview. This release also improves desktop startup, long conversations, model controls, and usage history.

## Highlights

- **Get started with Kiki.** The last setup button opens a new conversation with a short request waiting in the composer: introduce Kiki, ask what you most want to finish, and do it once. Configuration comes up only when that task needs it; existing working settings stay as they are. Nothing is sent until you press Send. In Chinese, the button is **让 Kiki 带你上手**.
- **Read and continue long conversations.** Older message content and live output continue loading, queued model switches remain readable, and cold conversation lists and automatic rules load with less delay. Delivered images retain their full content.
- **Control models and prompts together.** Edit complete model prompt bodies, use Recipes on models and agent profiles, customize session-title prompts, and apply pending model or reasoning changes at a safe boundary when sending immediately. Completed model switches and your selected model survive reopening a conversation.
- **See what work is doing.** Running subagents, compaction states, and completion notifications reflect the conversation's work. Scheduled messages can queue, insert immediately, or wait for idle. Archiving a conversation also handles its attached conversations and shows progress.
- **Follow costs back to their sources.** Usage history includes recorded provider and agent-profile attribution, filters, trends, and links to consumption sources, with faster repeated reads. Usage export no longer needs an experimental switch; export still requires your chosen destination and authorization.
- **A more dependable desktop.** Startup no longer launches repeated background processes. Picture and video backgrounds reload correctly, documentation and sign-in links open in the system browser, and plugin settings open on their own pages.

## Install or upgrade

Update the desktop app and server together. Recipes are available by default; an explicit setting that disables them remains respected. Existing conversation history, credentials, and drafts are not replaced by the new welcome request.

| Platform | Desktop download |
| --- | --- |
| Windows x64 | `Kiki_0.3.3_x64-setup.exe` — NSIS installer, includes CLI |
| Linux x64 | `Kiki_0.3.3_amd64.AppImage` or `Kiki_0.3.3_amd64.deb` |
| macOS Apple Silicon | `Kiki_0.3.3_aarch64.dmg` |
| macOS Intel | `Kiki_0.3.3_x64.dmg` |

Standalone CLI downloads are `kiki-linux-x64`, `kiki-linux-arm64`, `kiki-darwin-x64`, and `kiki-darwin-arm64`, each with an adjacent `.sha256` file. Windows receives the CLI through the unified installer or npm, not a separate Release executable.

For npm, install one of these packages with Node.js 24.15 or newer:

```sh
npm install -g kiki-agent@0.3.3
```

For CLI/TUI only:

```sh
npm install -g kiki-agent-lite@0.3.3
```

Verify downloaded files against their adjacent `.sha256` files. Windows installers are not Authenticode-signed, so SmartScreen may show **Unknown publisher**; Windows x64 automatic updates use a separate release-key signature. macOS downloads are unsigned and not notarized: follow the [macOS first-open and CLI-linking steps](https://x-t-e-r.github.io/kiki/en/getting-started/installation#install-the-desktop-app). Linux and macOS desktop updates require manual replacement.

[Installation guide](https://x-t-e-r.github.io/kiki/en/getting-started/installation) · [First conversation](https://x-t-e-r.github.io/kiki/en/getting-started/first-launch) · [Report a problem](https://github.com/X-T-E-R/kiki/issues)
