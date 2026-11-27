# Reddit drafts (0.7.0)

Post as a text post with the image or clip inline. Reply to every question in the first few hours. Do not cross-post the same day.

## r/LocalLLaMA

**Title:** I wanted planning, implementation, and review on different vendors' models — plus a self-hosted E2EE relay to control my home PC from my phone (MIT)

**Body:**

I wanted planning, implementation, and review on different vendors' models, and I wanted to steer my local setup from my phone without routing session contents through a hosted cloud relay. So I built Kiki (`kiki-agent`, MIT): an open-source local agent workbench where one local daemon drives the Electron 44 desktop app, terminal (`kiki`), browser (`kiki web`), and a dual-mode Android app.

On a real coding task, the lead agent runs a frontier reasoning model to plan and accept the result, dispatches a fast read-only `explore` subagent on another model to inspect the codebase, sends scoped edits to an `implementer` bound to a cheap or self-hosted OpenAI-compatible endpoint, and runs a `reviewer` on a third vendor so it does not share the implementer's blind spots. Each role is a Markdown file (`tools`, `model_alias`, `thinking_effort`, permitted children in frontmatter; system prompt in the body). A subagent with no model bound and no `[subagent].default_model` fails loudly with `model.not_configured` instead of silently falling back to the lead's model.

**Fitted to each model.** Claude Code is tuned for Claude and Codex for GPT. For native models, Kiki binds a Recipe (prompts, model settings, and optional script hooks) installed once per model. Five MIT recipes (GPT-6.1 Sol, GPT-6 Astra, DeepSeek V4.1, Gemini 4 Argon, Gemini 3.8 Flash) live in `https://github.com/X-T-E-R/kiki-recipes`. Recipes apply to native models, not external executors.

**Override any built-in prompt field per model.** If a smaller local model keeps misusing a tool, replace that tool's description only for that model alias:

```toml
[models.cheap-worker.prompt_overrides]
files = ["prompt/cheap-worker.toml"]   # holds e.g. "tool.web-search.description" = "..."
```

`kiki prompt-fields explain <field> --model cheap-worker` shows the effective value and full source chain.

**Cross-device, long-session, and real device engineering (0.7.0):**
- **Self-hosted E2EE relay (`kiki-relay`):** run a lightweight Node.js 24+ or Docker reverse-pool rendezvous server when your PC sits behind NAT. Inner traffic stays end-to-end TLS 1.3 pinned to the host space's P-256 SPKI fingerprint (`fp`), so the relay never terminates inner TLS.
- **Dual-mode Android APK:** on first launch, choose **Connect to PC Kiki** (lightweight remote shell over LAN or `kiki-relay`) or **Run Kiki locally on phone** (embeds Bionic Node directly on Android), with SHA-256 + signing-cert verified in-app updates.
- **60fps resident device & VM panels (`kiki-plugins`):** official plugins add physical Android/iOS control (`kiki-phone` with warm `scrcpy`), local multi-DPI desktop control (`kiki-cua`), and Proxmox VE / VNC / UU Remote desktops (`kiki-uu-remote`) — panels stay resident across session switches (`0ms` re-open) with one-click Human Takeover protection.
- **Multi-GB sessions, cache-safe compaction, and peer threads:** streaming CPU-worker journal indexing keeps cold open sub-second on 3GB+ multi-week sessions without freezing the UI; cache-safe compaction preserves the KV-cache prefix (`>=99%` hit retention on 250k+ runs); long-lived sessions communicate and wake each other directly via `ThreadSend` / `ThreadRead` / `ThreadWait` and `@Thread`.

[image: `docs/public/shots/workbench/workbench-per-role-models.en.png`]

Caveats: current public release is `0.6.2` with `0.7.0` staged (`0.x`, rough edges remain); unsigned, unnotarized macOS `.dmg`; Windows 0.7 desktop installers bundle Git Bash and `rg` out of the box (Windows npm CLI still needs Git for Windows); npm install requires Node.js 24.22.1+ or 26.12.1+ (Linux/macOS also have a standalone `install.sh` binary). Screenshots are rendered example scenes, not benchmarks. Repo: https://github.com/X-T-E-R/kiki

Question: which roles would you hand to a local model first, and which tool descriptions trip your local models up?

## r/ChatGPTCoding

**Title:** One task, several models, across desktop, terminal, Android, and real devices: Kiki 0.7 (MIT open source)

**Body:**

I wanted planning, implementation, and review on different vendors' models — and a clean way to keep working from my phone or test on a real device without handing my sessions to a cloud relay. Kiki (`kiki-agent`, MIT) runs as one local service on your machine so the Electron desktop app, terminal (`kiki`), browser (`kiki web`), and Android app all show the same work.

For a multi-file change, the lead session splits the work: a reasoning model plans and verifies the final result, an `explore` subagent searches the repo on a fast model, an `implementer` handles scoped edits on DeepSeek or another OpenAI-compatible model, and an independent `reviewer` checks the diff on a different vendor.

- **Fitted to each model.** Native models can bind a Recipe (prompts + model settings + optional script hooks). Five MIT recipes (GPT-6.1 Sol, GPT-6 Astra, DeepSeek V4.1, Gemini 4 Argon, Gemini 3.8 Flash) are published at `https://github.com/X-T-E-R/kiki-recipes`.
- **Agent definitions are files you edit.** Each agent is a Markdown file; save it and the next dispatch uses it. Rewrite any built-in prompt field per model and inspect it with `kiki prompt-fields explain`.
- **Keep working while it works — even on 3GB+ sessions.** Subagents and background tasks notify the lead on completion. Messages you type while busy queue up with per-message timing (when idle, after subagents, or after tasks). Streaming CPU-worker journal indexing keeps cold open sub-second on multi-week 3GB+ sessions, cache-safe compaction keeps `>=99%` KV-cache prefix retention on 250k+ runs, and long-lived sessions talk directly via `ThreadSend` / `@Thread`.
- **Cross-device + 60fps resident device panels.** Self-host `kiki-relay` (Docker/Node.js) for SPKI-pinned E2EE access behind NAT; pair the dual-mode Android APK (remote PC client or standalone Bionic Node host); install official plugins from `https://github.com/X-T-E-R/kiki-plugins` for physical phones (`kiki-phone` over warm `scrcpy`), local desktops (`kiki-cua`), and Proxmox VE / VNC (`kiki-uu-remote`) with `0ms` re-open resident panels and Human Takeover, plus local PDFs (`kiki-extract`), Word/Excel/PowerPoint (`kiki-office`), and Image/Video/TTS/3D (`kiki-media`).
- **Bring your history and tools.** Import Claude Code, Codex, Pi, Grok Build, and OpenCode sessions with a loss preview; connect Zed and JetBrains via `kiki acp`.

[video: 35–48 s real recording (Storyboard A or B), or image: `docs/public/shots/workbench/workbench-per-role-models.en.png`]

Early `0.x` (`0.6.2` public / `0.7.0` candidate), rough edges remain, macOS build is unsigned. Screenshots are rendered example scenes. https://github.com/X-T-E-R/kiki

What does your planner / worker / reviewer split look like today?
