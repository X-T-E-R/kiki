# Show HN draft (0.7.0)

**Title** (≤ 80 chars):

Show HN: Kiki – Local multi-model agent workbench across PC, Android, and devices

Alternates:
- Show HN: Kiki – One task, several models, plus self-hosted E2EE relay & phone control
- Show HN: Kiki – An open-source workbench where each role runs its own model
- Show HN: Kiki – Desktop, TUI, browser, and dual-mode Android on one local daemon

**URL:** https://github.com/X-T-E-R/kiki

**First comment (post immediately):**

I wanted planning, implementation, and review on different vendors' models — and I wanted to steer the same local session from my phone over NAT or let it verify changes on a physical test device without routing session data through a third-party cloud. So I built Kiki (`kiki-agent`, MIT): an open-source local agent workbench where the Electron 44 desktop app, terminal (`kiki`), browser (`kiki web`), and Android app share one local daemon.

On a real change, the lead session splits the job: a reasoning model plans and accepts the diff, a fast read-only `explore` subagent maps the repo on its own model, an `implementer` runs scoped edits on a cheaper or self-hosted OpenAI-compatible endpoint, and a `reviewer` on a third vendor checks the result without sharing the implementer's blind spots. Each role is a plain Markdown file with frontmatter (`tools`, `model_alias`, `thinking_effort`, permitted children) and a system prompt body. A subagent with no model bound and no `[subagent].default_model` fails loudly with `model.not_configured` rather than silently inheriting the lead's expensive model.

- **Fitted to each model.** Claude Code is tuned for Claude and Codex for GPT. For native models, Kiki binds a Recipe — prompts, model settings, and optional script hooks installed once per model. Five MIT recipes (GPT-6.1 Sol, GPT-6 Astra, DeepSeek V4.1, Gemini 4 Argon, Gemini 3.8 Flash) are published at `https://github.com/X-T-E-R/kiki-recipes`. Every built-in prompt field — down to `tool.web-search.description` — can also be overridden per model, and `kiki prompt-fields explain <field> --agent X --model Y` prints the effective text and full source chain.
- **Cross-device without a mandatory cloud relay.** Work files, sessions, history, and config stay on your machine. When your desktop sits behind NAT, you can self-host `kiki-relay` (a lightweight Node.js 24+ or Docker reverse-pool WebSocket server); inner traffic remains end-to-end TLS 1.3 pinned to your space's P-256 SPKI fingerprint (`fp`), so the relay never terminates inner TLS or sees session credentials. The Android app opens in two modes on first launch: lightweight remote client (`REMOTE_ONLY` over LAN or `kiki-relay`), or standalone local host (`LOCAL_HOST`) running bundled Bionic Node directly on Android, with SHA-256 + signing-cert verified in-app APK updates.
- **Real device, desktop, and remote VM control.** Official checksum-pinned plugins (`https://github.com/X-T-E-R/kiki-plugins`, 20 official packages) connect the same agent to physical Android/iOS phones (`kiki-phone` via Mobilewright / Mobile MCP + warm `scrcpy`), local multi-DPI desktops (`kiki-cua`), and NetEase UU Remote, Proxmox VE QEMU VMs (lossless RFB 3.8 over SSH with QMP/QGA fallback), or VNC desktops (`kiki-uu-remote`). Their 60fps preview panels stay resident across session switches (`0ms` re-open), with one-click Human Takeover protection.
- **Built for multi-week sessions.** Streaming CPU-worker journal indexing keeps cold open sub-second even on 3GB+ multi-week sessions without freezing the UI. Cache-safe context compaction preserves the KV-cache prefix across compaction boundaries (`>=99%` cache hit retention on 250k+ long runs) instead of blowing up prompt cost right after a summary. Long-lived sessions (engineering, research, patrol) can also exchange findings and wake each other directly via `ThreadSend` / `ThreadRead` / `ThreadWait` and `@Thread` references alongside multi-persona `Room` discussions.
- **Documents, media, and ecosystem.** Optional plugins handle local PDF/Office-to-Markdown extraction (`kiki-extract`, needing Python + MarkItDown), Word/Excel/PowerPoint editing (`kiki-office`), read-only CSV reconciliation (`kiki-work`), `kiki-task-board`, and Image/Video/TTS/3D generation (`kiki-media`). History imports from Claude Code, Codex, Pi, Grok Build, or OpenCode; `kiki acp` plugs into Zed and JetBrains; `kiki seat` exposes an inbound MCP seat.

Honest limits:
- Current public release is `0.6.2` (`0.7.0` release candidate staged on `kiki` / Releases); this is still early `0.x` software with rough edges.
- The macOS `.dmg` is unsigned and not notarized (`Control-click -> Open` on first launch). Windows 0.7 desktop installers bundle a self-contained Git Bash and `rg` toolchain so clean Windows machines need zero external setup; installing only the CLI via npm on Windows still needs Git for Windows (or `KIKI_SHELL_PATH`), and npm requires Node.js 24.22.1+ or 26.12.1+. Linux/macOS also ship a standalone `install.sh` binary without Node.js.
- Screenshots in the repo are rendered by the real UI from example scenes (`docs/public/shots/`), not benchmarks.

Feedback I'd most appreciate: the Markdown profile + Recipe contract, self-hosted `kiki-relay` ergonomics, and what you look for when letting an agent touch a physical phone or remote VM safely.
