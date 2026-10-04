---
title: One workbench, many lines
---

# One workbench, many lines

Every Kiki session has one **main agent**. When the job is bigger than a single turn, the main agent splits it and dispatches **subagents** — each with its own isolated context — and you can watch all of it in one window. This page covers what the workbench does with one task: how the main session fans out, how each role can run a different model, where a subagent's own work lives, and what happens in the background while you talk to the lead.

## Three surfaces, one local daemon

The desktop app, the terminal UI (`kiki`), and the browser UI (`kiki web`) are three front ends to the same local daemon. They read and write the same session data, so a session you start in the terminal is the session you open in the browser, and vice versa. That is the "one workbench" part: pick whichever surface fits the moment.

- [Kiki desktop](/en/getting-started/desktop-app) for the full window with the right rail
- [First launch](/en/getting-started/first-launch) for the terminal path
- [Local server and API](/en/server/local-server) for the browser path

## The main session dispatches the work

You hand the main agent a task — a coding change, a research question, a bug to track down. It plans, calls tools, and when the work divides cleanly it dispatches subagents to handle the focused pieces: exploring an unfamiliar codebase, reviewing several implementations in parallel, or planning a large refactor without touching the main context.

A subagent receives a task description, works in its own isolated context, and returns its conclusions. It does not talk to you directly, and its intermediate reasoning and tool call records stay out of the main agent's history. The lead only keeps the result. This is why you can run four or five lines at once without the main context drowning in details.

Fresh installs ship two subagent profiles: `general`, a general-purpose assistant, and `explore`, a read-only explorer. Dispatch is scheduled by the main agent, based on task complexity, context consumption, and whether the sub-tasks are independent — you do not have to name one. You can, though: tell the main agent directly, or approve each dispatch as it appears.

See [Agents and Sub-Agents](/en/customization/agents) for the full dispatch contract, context isolation, and permission inheritance.

## Each role can run a different model

Different lines of work do not have to share a model. Bind the main agent, each subagent, and the reviewer to different models — or different vendors — and one session runs all of them at once. A strong reasoning model can plan while cheaper models do the routine work; a different vendor can review without the review being anchored to the same blind spots as the implementation.

The main `agent` profile always receives three child-agent tools (`AgentRun`, `AgentList`, `AgentSend`) with no experiment flag, and each can name the model its child should run. If no model is pinned anywhere, a dispatch fails with `model.not_configured` rather than silently guessing. Kimi works out of the box; Anthropic, OpenAI-compatible services, the OpenAI Responses API, Gemini, and Vertex AI can be added, and you can sign in with a GitHub Copilot or ChatGPT account.

Model selection, hard model boundaries, and the model menu are covered in [Providers and models](/en/configuration/providers) and [Agent profiles: concepts and design](/en/customization/agent-profiles#model-menus-and-hard-boundaries).

![The dispatch tree of one session, with each role bound to its own model.](/shots/workbench/workbench-per-role-models.en.png)

## A subagent keeps its own record

Open any dispatched subagent to read its own transcript: what it was asked, what it did, and what it concluded — next to the main session, without loading the main agent's conversation. The same right rail follows you into the subagent, so you can inspect its context and cost the same way.

You can also message a running subagent from its own composer, and pick it back up later with `AgentRun` to continue the same task instead of starting over. See [Agents and Sub-Agents](/en/customization/agents#named-child-agents) and the [right rail](/en/guides/interface#right-rail).

## Background tasks report back on their own

Long shell commands and subagents do not have to hold the foreground. Send them to the background and Kiki notifies the main agent automatically when they finish, with the result inline and the full-output path retained — so neither you nor the agent has to keep checking. You can inspect a running task's status and output, and stop one at any time. Stopping an agent task also reports any direct subagents still running under it.

The main `agent` profile uses `TaskList`, `TaskOutput`, and `TaskStop` for background work. See [Background tasks](/en/reference/tools#background-tasks).

![The tasks page: one background task running with its stop control, one finished, and one failed.](/shots/workbench/workbench-background-tasks.en.png)

## Next steps

- [Work that runs long](/en/features/long-work) — goals, the queue, scheduled tasks, the board, and memory
- [Agents and Sub-Agents](/en/customization/agents) — the full dispatch and model-binding reference
- [Interface overview](/en/guides/interface) — how the workbench window is arranged
