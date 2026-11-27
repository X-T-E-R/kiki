# Product Hunt (0.7.0)

**Name:** Kiki

**Tagline** (≤ 60 chars): One task, several models — desktop, phone, and real devices.

Alternates: "Local multi-model agent workbench, MIT open source" · "Your agents, your call."

**Description** (≤ 260 chars):
Open-source (MIT) local agent workbench. Split one task across vendors with per-model Recipes, steer your PC from a dual-mode Android app over self-hosted E2EE kiki-relay, and control physical phones, local desktops, and Proxmox/VNC VMs with one-click takeover.

**Topics:** Developer Tools · Artificial Intelligence · Open Source

**Gallery** (1270×760, in this order; every still is a rendered example scene, so say so in the caption):
1. Real screen recording, 35–48 s physical split-screen cut (Storyboard A in [demo-storyboard.md](demo-storyboard.md): 5G phone over `kiki-relay` E2EE → home PC diff → physical Android device verification via `kiki-phone`). Label: "Real session, sped up".
2. `workbench-per-role-models.en.png`: "One task, several vendors — each role bound to its own model (rendered example)"
3. `wl-20261005-hero-workbench.en.png`: "Electron desktop, terminal, browser, and Android on one local daemon (rendered example)"
4. `d02-prompt-fields.en.png`: "Rewrite any built-in prompt field, per model (rendered example)"
5. `long-work-goal-queue.en.png`: "Queue messages while busy, each with its own delivery timing (rendered example)"
6. `r04-task-board.en.png`: "A requirement board that outlasts sessions (rendered example)"
7. `r01-reviewer-profile.en.png`: "Every agent is a plain Markdown file you own (rendered example)"

If the live recording is not ready, lead with `workbench-per-role-models.en.png` and omit item 1. Do not use a fixture slideshow as the Product Hunt video.

**Maker comment:**

Hi Product Hunt. Kiki is an open-source (MIT) local agent workbench running as one service on your machine, so the Electron 44 desktop app, terminal (`kiki`), browser (`kiki web`), and Android app all share the same work.

- **One task, several models — fitted to each one.** The lead session splits the work: a strong model plans, cheaper models handle exploration or routine edits, and a different vendor reviews so it does not share the implementer's blind spots. Each agent is a plain Markdown file (`tools`, `model_alias`, effort, permitted children, system prompt). Native models also bind installable Recipes (prompts, model settings, optional script hooks) — five MIT recipes (GPT-6.1 Sol, GPT-6 Astra, DeepSeek V4.1, Gemini 4 Argon, Gemini 3.8 Flash) are published at `https://github.com/X-T-E-R/kiki-recipes`, and any built-in prompt field can be overridden per model and inspected with `kiki prompt-fields explain`.
- **Cross-device without a mandatory cloud relay.** Work files, sessions, history, and config stay on your machine. When your desktop is behind NAT, self-host `kiki-relay` (Docker or Node.js 24+): inner streams stay end-to-end TLS 1.3 pinned to your space's P-256 SPKI fingerprint, so the relay never terminates inner TLS. On Android, pick **Connect to PC Kiki** (lightweight remote client over LAN or `kiki-relay`) or **Run Kiki locally on phone** (embedded Bionic Node) on first launch, with signed in-app APK updates.
- **Operate real phones, desktops, VMs, and local documents.** Official checksum-pinned plugins (`https://github.com/X-T-E-R/kiki-plugins`, 20 official packages) add physical Android/iOS control (`kiki-phone`), multi-DPI local desktops (`kiki-cua`), NetEase UU Remote / Proxmox VE / VNC desktops (`kiki-uu-remote`) — all with live preview and one-click Human Takeover — plus local PDF/Office extraction (`kiki-extract`), Word/Excel/PowerPoint editing (`kiki-office`), CSV checks (`kiki-work`), and Image/Video/TTS/3D generation (`kiki-media`).

Current public release is `0.6.2` (`0.7.0` candidate staged on GitHub Releases). It is still early `0.x` software: the macOS `.dmg` is unsigned (`Control-click -> Open` on first launch), while 0.7 Windows desktop installers now bundle a self-contained Git Bash and `rg` toolchain out of the box. I'd love to hear which models you split across a task and what you would wire up first.
