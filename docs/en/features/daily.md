---
title: The daily driver
---

# The daily driver

The workbench is one window, but the work is not: a turn runs, a subagent finishes, something needs your approval, and the cost adds up. This page is about the parts of that window you look at every day — the timeline that stays readable, annotations you can leave on a message, the tray that collects what needs you, the right rail that follows whichever agent you are focused on, and the usage page that tells you what it cost.

## A timeline that stays readable

A long agent turn is mostly tool calls, thinking, and shell output. The conversation view folds finished stretches of it into one line such as "Worked · 8 steps", and you can expand any fold back in its original order. The live turn and finished subagents fold the same way, image results keep a row of their own, and failed or cancelled entries always stay visible on their own.

Resolved questions, approvals, markers, and completion notices stay inline at their original position as compact one-line entries. Consecutive entries fold into an expandable "Activity history" row, and consecutive identical marker dividers (such as goal updates) show only the latest one with a repeat count, for example "Goal updated ×12", when nothing separates them. Reopening a session shows model changes as dividers naming the previous and new model; changing only thinking effort does not add one.

Long tool output loads in stages — **Continue loading** pulls in the rest, and if that fails on a field that has an original to fetch, the same place offers **Download original** to save the field's full content to your machine. See [Interface overview](/en/guides/interface#conversation-view).

## Annotations: say something about a message

You can attach an annotation to a message in the timeline and send it along with your next message, rather than interrupting with a separate turn. The composer keeps a count of the notes you are carrying, and the note markers stay on the messages they belong to, so a later reader can see what you pointed at and why. Reopening a note brings up the same anchored editor you wrote it in.

Annotations are for the desktop and browser composer; the terminal equivalent is a normal message or a `!` shell command in the same turn. See [Interface overview](/en/guides/interface#input-box).

## "Needs you" collects what is waiting

Approvals and questions do not scatter across the timeline as they arrive. They collect in a tray above the composer: an approval you can act on, and non-blocking questions folded into a "one more item" line until you open them. When something is waiting, the composer card gives it over, and your unsent draft comes back intact when it is resolved.

That is also where the "send timing" menu lives while the agent is busy, so a decision and a queue adjustment are in the same place. Approvals themselves — the modes and what each one allows — are covered in [Interaction and input](/en/guides/interaction#permission-modes).

## The right rail follows the agent you are focused on

The right panel describes one agent at a time: whichever you last clicked into or focused. The main agent and every subagent get the same page, and the same rail follows you into a subagent's transcript.

It shows the agent's head over what it is doing now, "needs you" items as plain rows you can decide from, the activity feed, and a folded capabilities block. From there you can open **Dispatch capabilities** to inspect a subagent's profile, route, and executor, plus where the default model and thinking effort come from. On wide windows the panel is open by default, and **Standard / Cockpit** in the header lets it temporarily take over the preview space; exiting cockpit restores your previous preview content, tabs, draft, and width.

See [Interface overview](/en/guides/interface#right-rail) and [Session controls](/en/guides/settings#session-controls).

## The usage page tells you what it cost

**Usage** in the sidebar opens **History** by default: token usage and estimated cost for a date range, defaulting to today. Token usage and cost carry separate completeness indicators — when a provider does not return usage, Kiki marks it as unknown rather than a real zero — and the **Data reliability** section distinguishes unknown providers and incomplete accounting from an empty range or a failed request.

**Live** shows running and queued requests for this service, with a per-model, provider, and role breakdown, waiting rows naming the blocking rule, and **Concurrency limits** for adding or editing rules. **External sync** sends content-free usage (model, UTC half-hour, four token counts, quality, cost) to vibecafe.ai, a Kiki webhook, or your own script — never a prompt, answer, title, workspace name, or path. It stays off until the server enables the `usage_export` flag, and a saved destination sends nothing until you preview the exact payload and agree once.

See [Usage](/en/guides/settings#usage) and [`kiki usage-export`](/en/reference/command#kiki-usage-export).

![The usage page on its History tab: cost, token, and cache-hit totals for the range, a seven-day trend, and the per-session breakdown below.](/shots/daily/daily-usage.en.png)

## Next steps

- [Interface overview](/en/guides/interface) — the full tour of the window
- [Settings pages](/en/guides/settings) — where each control lives
- [One workbench, many lines](/en/features/workbench) — what the agents in the rail are doing
