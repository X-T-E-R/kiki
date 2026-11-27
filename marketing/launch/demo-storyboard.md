# Demo storyboards: real recordings (0.7.0)

Every flagship demo is a **real screen recording**, not a fixture scene. Record on real work, 1920×1080 (or 1440×900+ for desktop-only cuts), 30 fps, light theme unless explicitly demonstrating dark mode. Keep raw footage and cut afterward.

Label every public cut **"Real session, sped up"** (ZH 「真实录屏，部分加速」) and mark speed-ups on screen ("×4" / "×8"). Never splice fixture scenes into a real cut without a visible **"Example scene"** (「示例画面」) label.

## Export spec & metadata hygiene (all platforms, especially X)

- **Target duration for X root video:** **35–48 s** (`vqv_weight` sweet spot — do NOT cut below 30 s).
- **Container & codec:** `1920x1080`, `30fps`, `H.264 (yuv420p)`, `+faststart`, stripped of all container metadata and encoder provenance:

```sh
ffmpeg -i raw_cut.mov \
  -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2" \
  -r 30 -c:v libx264 -pix_fmt yuv420p -crf 20 -movflags +faststart \
  -c:a aac -b:a 128k \
  -map_metadata -1 -fflags +bitexact \
  kiki-070-launch-clean.mp4
```

- Zero `.cn` domains, zero university/lab identifiers, zero local usernames, and zero non-demo notifications anywhere on screen or in terminal prompts.

---

## Storyboard A (Lead X / Cross-Device Hook — 35–48 s physical split-screen)

**Concept:** One prompt sent from a 5G phone over self-hosted E2EE `kiki-relay` lands on the home PC Electron desktop, edits and builds the app, and wakes a physical Android test phone on the desk to auto-tap through verification via `kiki-phone` — with Human Takeover one click away.

| Time | Shot | On-screen cue (≤ 6 words / ≤ 12 字) |
| --- | --- | --- |
| 0–6 s | Split-screen opens: left hand holds 5G Android phone (`REMOTE_ONLY` mode) sending a fix prompt over `kiki-relay`; right pane shows home PC Kiki desktop receiving the turn immediately over pre-warmed E2EE reverse pool | "5G phone → home PC via E2EE relay" / 「5G 手机经自建加密中转直连家里电脑」 |
| 6–16 s | Home PC Kiki dispatches subagent, edits the file, runs test/build, and prints the clean diff (×4) | "Local PC edits and verifies" / 「家里电脑本地改码跑测试」 |
| 16–28 s | Physical Android test device on desk lights up; `kiki-phone` launches the app, navigates the flow, and captures the live preview stream inside Kiki Desktop | "Same session operates real phone" / 「同一会话直接操控桌面真机验证」 |
| 28–36 s | Back on the 5G phone: final diff summary + device screenshot arrive in the same thread; quick toggle of Human Takeover guard | "End-to-end TLS 1.3 pinned" / 「内层 TLS 1.3 证书固定 · 一键人工接管」 |
| 36–42 s | Clean paper-and-ink end card: Kiki wordmark · `Desktop · TUI · Web · Android · MIT` | — |

---

## Storyboard B (Multi-Model Fleet + Orthogonal Reviewer — 35–45 s cut & 3–5 min B站/YouTube body)

**Concept:** One Kiki main session splitting a real coding task across vendors — planning on a strong model, delegating exploration and scoped edits to cheaper models, and having a different-vendor orthogonal `reviewer` catch a real bug line (`$0.04` review pass) — while taking mid-course changes and inspecting prompt fields.

### What to capture (raw)

Start recording before the first prompt and stop after the lead's final summary. Capture only what happens naturally, **without staging**:

1. **Division of labour & Recipes:** dispatch tree or Settings → Models showing different models bound to each role, plus one installed Recipe bound to a native model.
2. **Dispatch:** the lead's plan, then parallel lines fanning out with distinct model chips visible.
3. **Orthogonal review catch:** a different-vendor `reviewer` flags a concrete bug line with the actual Usage cost (`$0.04` callout or whatever the real turn cost was — always use the real recorded figure).
4. **Mid-course queue:** type a requirement while the lead is busy; open per-message timing (when idle / after subagents / after tasks).
5. **Natural recovery (optional):** if a lane fails and recovers naturally, keep it; if not, omit it.
6. **Persistence & inspection:** optional `kiki-task-board` update, `/goal` status, subagent transcript drill-in, and a 15 s terminal clip of `kiki prompt-fields explain tool.web-search.description --model <alias>`.

### 35–42 s cut (X Reply 2 plate / Reddit / 小红书 / PH gallery)

| Time | Shot | Caption EN / ZH (≤ 6 words / ≤ 12 字) |
| --- | --- | --- |
| 0–6 s | Dispatch tree fanning out, distinct vendor model chips | "One task, several vendors" / 「让贵的模型只干它擅长的那一步」 |
| 6–14 s | Background lines running; completion notices land on timeline (×8) | "Parallel subagents report back" / 「几个帮手一起跑，跑完自己汇报」 |
| 14–22 s | Different-vendor reviewer catches bug line + Usage cost callout (`$0.04`) | "Independent review caught the bug" / 「换一家模型审出真实缺陷」 |
| 22–28 s | Typing mid-run → queue → timing selector | "Queue changes without interrupting" / 「它忙它的，我说我的」 |
| 28–34 s | Model Recipe binding + `prompt-fields explain` | "Fitted to each model" / 「每个模型都有自己的专武」 |
| 34–40 s | End card · Kiki wordmark · `One task, several models · MIT` | — |

### 3–5 min cut (B站 main body, YouTube)

Follow the chapters in [bilibili.zh-CN.md](bilibili.zh-CN.md): multi-model division of labour, Recipes, dispatch and queue, real-device / cross-device (`kiki-relay` + Android + `kiki-phone` / `kiki-cua`), orthogonal review & recovery, persistence, and prompt fields. Use real time for key moments and ×4–×8 for waiting.

---

## Privacy & net-clean checklist (before any export)

- [ ] No API keys, tokens, or `credentials.toml` on screen. Blur Settings → AI key fields even when masked.
- [ ] No local usernames or home paths (`C:\Users\…`, `/Users/…`). Use a neutral path (`C:\Projects\sample-app` or `~/work`) or blur it.
- [ ] Zero `.cn` URLs, university/lab names, internal hostnames, private repo names, or personal handles in terminals, browser tabs, phone notifications, or sidebar titles.
- [ ] Turn on Do Not Disturb on both PC and phones before recording.
- [ ] Strip all container metadata with `ffmpeg -map_metadata -1 -fflags +bitexact`.
- [ ] Check every frame of cover images and exported cuts at full 1080p resolution.

## Fallback: fixture scenes (when live recording is not ready)

Build a 25–30 s still sequence from `docs/public/shots/` (see [../RESHOOT.md](../RESHOOT.md)): `workbench/workbench-per-role-models` → `index/wl-20261005-hero-workbench` → `long-work/long-work-goal-queue` → `daily/d04-tool-steps-notification` → `long-work/r04-task-board` → `freedom/d02-prompt-fields` → wordmark. Label it **"Example scenes rendered by the real UI"** throughout, drop any unrecorded recovery/cost claim, and do not use fixture sequences as the Product Hunt video, X root video, or B站 main cut.
