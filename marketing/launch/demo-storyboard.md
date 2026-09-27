# Demo storyboard: a real lead session

The flagship demo is a **real screen recording**, not a fixture scene: one Kiki main session running for hours, leading several lines of work at once across models, taking changes mid-course, and recovering a lane that crashed. Record it **after** the GUI redesign lands, on real work (for example the redesign itself), in the desktop app, 1440×900 or larger, light theme. Keep the raw footage; cut it afterward.

Label every public cut **"Real session, sped up"** (ZH 「真实录屏，部分加速」) and mark speed-ups on screen ("×8"). Never splice fixture scenes into the real cut without a visible "Example scene" (「示例画面」) label.

## What to capture (raw)

Start recording before the first prompt and stop after the lead's final summary. Things the footage has to show if they happen, **without staging them**:

1. **Setup:** Settings → Agents, showing the roles and the model each one is bound to (for example strong model for the lead, DeepSeek for implementation, GLM for exploration, another vendor for review).
2. **Dispatch:** the lead's first plan, then the dispatch tree growing into several parallel lines, each with its model chip visible.
3. **Background:** lines moved to the background, with completion notices appearing on the timeline while you do nothing.
4. **Mid-course change:** you type a new requirement while the lead is busy. It lands in the queue, you open its timing control (when idle / after subagents / after tasks), and the lead later picks it up.
5. **Recovery:** a lane fails or is interrupted, the lead sees the result, and it re-dispatches or resumes. If this doesn't happen naturally, leave it out. Don't fake a failure.
6. **Persistence:** the requirement board being updated, and the `/goal` status.
7. **Inspection:** clicking into one subagent to read its own transcript.
8. **Wrap-up:** the lead's final summary.

Also record a separate 15 s terminal clip of `kiki prompt-fields explain tool.web-search.description --model <alias>` for the Freedom beat.

## 30 s cut (X, Reddit, 小红书, PH gallery)

| Time | Shot | Caption EN / ZH (≤ 6 words / ≤ 12 字) |
| --- | --- | --- |
| 0–4 s | Dispatch tree fanning out, model chips differ | "One lead, many lines" / 「一个主会话，好几条线」 |
| 4–10 s | Lines moving to background; notices arrive (×8) | "Hears back when work finishes" / 「跑完它自己知道」 |
| 10–16 s | You type mid-run → queue → timing menu | "Talk while it works" / 「它忙它的，我说我的」 |
| 16–22 s | A lane fails → lead re-dispatches (only if real; otherwise the board updating) | "Recovers a crashed line" / 「一条线挂了，接着补上」 |
| 22–27 s | Settings → Agents: per-role models; flash of `prompt-fields explain` | "Your models, your prompts" / 「模型和提示词，你说了算」 |
| 27–30 s | Wordmark · "Agents that answer to you." · `npm i -g kiki-agent` | — |

## 3–5 min cut (B站 main body, YouTube)

Follow the chapters in [bilibili.zh-CN.md](bilibili.zh-CN.md): setup, dispatch, background, mid-course change, recovery, persistence, and prompt fields. Use real time for the key moments and ×4–×16 for waiting. Voice-over is recorded separately (ZH for B站; EN subtitles optional).

## Privacy checklist (before any export)

- [ ] No API keys, tokens, or `credentials.toml` on screen. Blur Settings → AI key fields even when they're masked.
- [ ] No local usernames or home paths (`C:\Users\…`, `/Users/…`). Use a neutral workspace path or blur it.
- [ ] No private repo names, internal hostnames, or ticket IDs in session titles, transcripts, or the sidebar. Rename sessions or blur them.
- [ ] No notifications from other apps; turn on Do Not Disturb.
- [ ] No other people's names or email addresses in diffs or commit logs.
- [ ] Sidebar shows only sessions that belong to the demo.
- [ ] Check every frame of the cover image and the 30 s cut at full resolution.

## Fallback: fixture scenes (if the recording isn't ready)

Build a 25 s cut from the existing fixture shots (see [../shots/RESHOOT.md](../shots/RESHOOT.md)): h01 (workbench) → r05 (models per role) → r02 (goal + queue timing) → d04 (background completion notice) → r04 (board) → d02 (prompt fields) → wordmark. Label it "Example scenes rendered by the real UI" throughout, **drop the "recovers a crashed line" beat and all "hours" wording**, and don't use it as the Product Hunt video or the B站 cut.
