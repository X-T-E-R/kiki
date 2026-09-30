# Personas, Bots, and rooms

A **persona** keeps an identity and its memories across conversations. A [profile](./agent-profiles.md) still controls tools, permissions, and execution. A **Bot** gives a persona a persistent conversation, while a **room** lets several personas discuss a topic in separate member sessions.

## Start with a persona

Create a persona on the Personas page, or place a card at `$KIKI_HOME/personas/release-guide/persona.md` (`$KIKI_HOME` defaults to `~/.kiki`):

```yaml
---
name: Release guide
title: Release coordinator
job: Check release readiness
profile: agent
greeting: What are we preparing to release?
memory:
  shared: [global, workspace]
---
You coordinate release preparation. Ask for missing evidence and distinguish
confirmed facts from open questions.
```

The directory name is the stable ID: lowercase letters, digits, and single hyphens between words. The Markdown body supplies the identity. Optional `model_alias` and `thinking_effort` select a configured model and effort; they do not grant permissions. Fields such as `tools` are rejected because permissions belong to the profile.

Choose the persona when creating a GUI session, or start it from the terminal:

```sh
kiki --persona release-guide
```

In the TUI, `/persona list` lists the catalog and `/persona switch release-guide` opens a **new** session. The previous conversation is preserved. Explicit model selection overrides the persona's model; otherwise Kiki uses the persona's model before the profile or default model. An explicitly selected profile overrides the persona's profile without discarding the identity.

Each session freezes its persona snapshot. Editing a card does not silently change an ongoing conversation's system prompt; start a new session or rebuild its context to apply the edit. The opening greeting is local presentation until you explicitly reply to it; merely opening a conversation does not add the greeting to model history.

## Memory and character cards

Persona memory follows the persona across profiles and models. Persona-specific entries are isolated from other personas; by default the persona can also read shared global and workspace memory. Set `memory.shared: []` to exclude those shared memories. The memory page provides persona and persona-workspace scopes; deleting a persona also removes its persona namespaces. If memory cleanup fails, deletion reports the error and retains the card for retry.

The Personas page supports Character Card V3 JSON, PNG, and CHARX import/export. Preview an import before saving it: card lorebook entries can become persona memory, which influences later model requests. Unknown card extensions are preserved on export; keep the original card if it contains binary assets other than its avatar, because those assets are not fully retained. Avatar uploads accept PNG, JPEG, and WebP up to 2 MiB. Duplicate creates a new identity without copying conversation state or private memory; archive hides a persona from ordinary selection without erasing it.

## Enable a Bot

Use **Set as Bot** to create or reopen the persona's persistent home conversation. This explicitly enables Bot support. You can also configure it in `config.toml`:

```toml
[bot]
enabled = true
max_handoffs_per_hour = 30
room_budget = 12
```

Bot support is off by default; ordinary personas do not require it. A Bot's default working directory is `$KIKI_HOME/bots/<id>`, unless the persona specifies `home_workspace`. Its home conversation is separate from every room membership.

A session's `delivery` is either `reply` or `message`. In message mode, only successful `SendMessage` calls become delivered messages; ordinary model text remains in the process view. If a user-triggered turn ends with ordinary text but no successful send, Kiki asks the model to reconsider **once**, which can incur one extra model request. The shipped `agent` profile exposes `SendMessage` in message mode, while reply-mode turns omit it. A custom profile with an explicit `tools` allowlist must include `SendMessage`; delivery mode does not bypass profile permissions. The tool table is frozen for a turn, so changing delivery takes effect on the next turn.

`SendMessage` can address the user or another enabled Bot with `to: "@Name"`. Use the persona ID when names collide. A handoff can wake a closed home conversation and counts toward the hourly limit; retrying the same delivery key does not consume another slot. Attachments are immutable copies from the session workspace, its additional directories, or the Bot home area—not arbitrary filesystem paths.

## Discuss in a room

Create a room with two to six members, a classification workspace, and a host. Persona members get dedicated message-mode sessions. The API also accepts existing threads (`kind: "thread"`); these reuse their own sessions, workspaces, and permissions, require `[threadCommunication] enabled = true`, and cannot be subagents. In the GUI, Ctrl/⌘-click threads in the sidebar and choose **Pull into a new room**, use **Add to room…** on a thread, add threads from the **Threads** tab under **Add member**, or choose **Open a room with these threads** on a thread link. Scheduling has three rules:

1. A user mention wakes the named members; `@everyone` selects all members.
2. A user message without mentions goes to the host, whether the host is a persona or a thread.
3. A Bot message wakes only the members it mentions. A message with no mentions does not continue the discussion.

Members run sequentially, so later speakers receive earlier speakers' results. Muted members are skipped by Bot mentions and host fallback, but an explicit user mention still wakes them. Each member sees the messages since its last wake, excluding its own already-recorded output.

The budget limits member messages after each user message (12 by default). When exhausted, discussion pauses; **Continue** resets the budget and resumes retained work. **Pause** cancels queued wakes but allows the active turn to finish. **Stop all** also interrupts an active persona turn, never an original thread task; completed actions are not undone. Persona-only rooms retain user interruption steering, while mixed rooms retain queued work. At most one room question is shown at a time; later questions queue.

Thread members default to `queueWhenBusy: true`: room input waits for their current turn to finish instead of steering it. Cold threads resume in their own workspaces. For every member other than the host, unmentioned messages are included in their next since catch-up without a separate model call. To speak, a thread must use `ThreadSend({room, content, mentions?})`; its ordinary assistant text never enters the room.

Renaming, changing the host, muting, and workspace classification never rewrite member system prompts or permissions. Removing a thread leaves a system record in its session and preserves the room log; it does not archive the original thread. Creation requires two to six members, but leaving can reduce a room below two. Free discussion and room-scoped `HistorySearch` are not part of this release.

If a member cannot wake, the room shows the failure and a recovery action instead of promising an automatic retry. For a model login failure, sign in under **Settings → Models**, or open the member's conversation and select an available model. Existing member sessions retain their bound model; editing the persona card does not change it. After fixing the problem, send another room message and mention the failed member if it is not the host. **Continue** resumes a paused room; it does not retry an unpaused failed wake.

## API entry points

The SDK exposes `global.personas`, `global.bots`, and `global.rooms`; HTTP clients also have `rest.personas`, `rest.bots`, and `rest.rooms`. Lists return arrays directly. Session creation accepts `persona` and `delivery`; session reads return `agent_config.persona = { id, name, avatarUrl? }` and `delivery`.

REST resources are `/api/personas`, `/api/bots`, and `/api/rooms`. Room membership, mute state, host, and budget are updated with `PATCH /api/rooms/{id}`; pause, continue, and stop use their corresponding POST actions. `GET /api/rooms/{id}/log` accepts `afterId` and `limit`. Persona memory uses `/api/memory/persona?persona_id=<id>` or `/api/memory/persona_workspace?persona_id=<id>&workspace_id=<workspace>`.

Authentication and connection setup are described in the [REST API guide](../server/rest-api.md).
