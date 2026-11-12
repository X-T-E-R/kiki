# Demo storyboard: a real lead session

The flagship demo is a **real screen recording**, not a fixture scene: one Kiki main session splitting a task across models — planning on a strong model, handing exploration and routine work to faster or cheaper models, and sending review to a different vendor — while taking changes mid-course and recovering a lane that failed. Record it **after** the GUI redesign lands, on real work, in the desktop app, 1440×900 or larger, light theme. Keep the raw footage; cut it afterward.

Label every public cut **"Real session, sped up"** (ZH 「真实录屏，部分加速」) and mark speed-ups on screen ("×8"). Never splice fixture scenes into the real cut without a visible "Example scene" (「示例画面」) label.

## What to capture (raw)

Start recording before the first prompt and stop after the lead's final summary. Things the footage has to show if they happen, **without staging them**:

1. **Division of labour & Recipes:** the dispatch tree or Settings → Models showing different models bound to each role, plus one installed Recipe bound to a native model (showing prompts plus model settings, installed once with per-binding options).
2. **Dispatch:** the lead's first plan, then the dispatch tree growing into several parallel lines, each with its model chip visible.
3. **Background:** lines moved to the background, with completion notices appearing on the timeline while you do nothing.
4. **Mid-course change:** you type a new requirement while the lead is busy. It lands in the queue, you open its timing control (when idle / after subagents / after tasks), and the lead later picks it up.
5. **Recovery:** a lane fails or is interrupted, the lead sees the result, and it re-dispatches or resumes. If this doesn't happen naturally, leave it out. Don't fake a failure.
6. **Persistence:** the requirement board being updated, and the `/goal` status.
7. **Inspection:** clicking into one subagent to read its own transcript.
8. **Wrap-up:** the lead's final summary.

Also record a separate 15 s terminal clip of `kiki prompt-fields explain tool.web-search.description --model <alias>` for the prompt-override beat.

## 30 s cut (X, Reddit, 小红书, PH gallery)

| Time | Shot | Caption EN / ZH (≤ 6 words / ≤ 12 字) |
| --- | --- | --- |
| 0–4 s | Dispatch tree fanning out, model chips differ | "One task, several models" / 「让贵的模型只干它擅长的那一步」 |
| 4–10 s | Lines moving to background; notices arrive (×8) | "Several helpers working at once" / 「几个帮手一起跑，跑完自己汇报」 |
| 10–16 s | You type mid-run → queue → timing menu | "Talk while it works" / 「它忙它的，我说我的」 |
| 16–22 s | Model Recipe binding + `prompt-fields explain` | "Fitted to each model" / 「每个模型都有自己的专武」 |
| 22–27 s | A lane recovers, or board updates / subagent inspect | "Every step stays in view" / 「每一步和结果都看得见」 |
| 27–30 s | Wordmark · "One task, several models, each doing its part." / "Your agents, your call." · `npm i -g kiki-agent` | — |

## 3–5 min cut (B站 main body, YouTube)

Follow the chapters in [bilibili.zh-CN.md](bilibili.zh-CN.md): multi-model division of labour, Recipes, dispatch, background, mid-course change, recovery, persistence, and prompt fields. Use real time for the key moments and ×4–×16 for waiting. Voice-over is recorded separately (ZH for B站; EN subtitles optional).

## Privacy checklist (before any export)

- [ ] No API keys, tokens, or `credentials.toml` on screen. Blur Settings → AI key fields even when they're masked.
- [ ] No local usernames or home paths (`C:\Users\…`, `/Users/…`). Use a neutral workspace path or blur it.
- [ ] No private repo names, internal hostnames, or ticket IDs in session titles, transcripts, or the sidebar. Rename sessions or blur them.
- [ ] No notifications from other apps; turn on Do Not Disturb.
- [ ] No other people's names or email addresses in diffs or commit logs.
- [ ] Sidebar shows only sessions that belong to the demo.
- [ ] Check every frame of the cover image and the 30 s cut at full resolution.

## Fallback: fixture scenes (if the recording isn't ready)

Build a 25 s cut from the existing fixture shots under `docs/public/shots/` (see [../RESHOOT.md](../RESHOOT.md)): `workbench/workbench-per-role-models` (fleet) → `index/hero-workbench` (workbench) → `long-work/long-work-goal-queue` (goal + queue timing) → `daily/d04-tool-steps-notification` (background completion notice) → `long-work/r04-task-board` (board) → `freedom/d02-prompt-fields` (prompt fields) → wordmark. Label it "Example scenes rendered by the real UI" throughout, **drop the "recovers a crashed line" beat and all "hours" wording**, and don't use it as the Product Hunt video or the B站 cut.
