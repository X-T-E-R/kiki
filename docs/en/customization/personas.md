# Personas, Bots, and rooms

A **persona** is an identity that keeps its memory across conversations and has a stable address you can come back to. Its [profile](./agent-profiles.md) controls tools, permissions, model and execution — the persona answers "who this is and what it remembers", the profile answers "what it can call and how it runs", and rebinding the profile leaves the identity intact. A **bot** is the persistent conversation behind a persona, reachable by a scheduled prompt, another persona or a room; a **room** lets several personas discuss a topic in separate member sessions.

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

The directory name is the stable ID: lowercase letters, digits, and single hyphens between words. The Markdown body supplies the identity. Optional `model_alias` and `thinking_effort` pick a configured model and effort; they grant no permissions, and fields such as `tools` are rejected because permissions belong to the profile.

Choose the persona when creating a GUI session, or start it from the terminal:

```sh
kiki --persona release-guide
```

Every persona has one **daily conversation** — the same entry the sidebar row, the switcher, the session header and the persona page all open — so "ask this persona" always means the same conversation. A persona can hold several at once; switch between them from its conversation list. In the terminal, `/persona switch release-guide` opens a **new** session and leaves the previous conversation alone. `/persona list` shows the catalog.

An explicit model selection beats the persona's model; otherwise Kiki uses the persona's model before the profile's or the default. An explicitly selected profile replaces the persona's profile without discarding the identity.

Each session freezes its persona snapshot, so editing a card does not change an ongoing conversation — start a new session or rebuild its context. The opening greeting is local until you reply to it; opening a conversation does not put it in the model's history.

## Memory and character cards

Persona memory follows the persona across profiles and models. Persona-specific entries are isolated from other personas, and by default the persona can also read shared global and workspace memory — set `memory.shared: []` to exclude those. The memory page offers persona and persona-workspace scopes; [Memory](../guides/memory.md) covers the model, the review inbox and the undoable history. Deleting a persona removes its namespaces, and if that cleanup fails the deletion reports the error and keeps the card so you can retry.

The Personas page imports and exports Character Card V3 in JSON, PNG and CHARX. Preview an import before saving: lorebook entries can become persona memory and therefore influence later model requests. Unknown card extensions survive an export, but binary assets other than the avatar are not fully retained, so keep the original if it has them. The avatar picker accepts PNG, JPEG and WebP up to 20 MB and uploads a 256-pixel crop in a circle or square frame that survives reloads. **Remove avatar** restores the initials without deleting the persona or its memories. Direct API uploads are still limited to 2 MiB. **Duplicate** creates a new identity without copying conversation state or private memory, and **archive** hides a persona from ordinary selection without erasing it.

Saved persona files are capped at 1 MiB for `persona.md` and 256 KiB each for examples and extensions, measured in UTF-8 bytes. Oversized content fails before the card or its memory changes, so shorten it and try again. An older invalid or oversized card can still be replaced with `PUT /api/personas/{id}` or removed with `DELETE /api/personas/{id}`, which removes its memory first.

## The persistent conversation

A persona is reachable whether or not you have typed to it. Its **daily conversation** is that address: the sidebar row, the switcher, the session header and the persona page all open the same one, and the persona page lists the others so you can move the daily entry to a different conversation. Opening it for the first time creates it.

That same conversation is what a scheduled prompt, a message from another persona and a room seat address reach — there is no second persona to set up. It works in its own directory, `$KIKI_HOME/bots/<id>` by default, or the one named by `home_workspace`. Related limits live in `config.toml`:

```toml
[bot]
enabled = true
max_handoffs_per_hour = 30
room_budget = 12
```

A session's `delivery` is either `reply` or `message`. In message mode only successful `SendMessage` calls become delivered messages, and ordinary model text stays in the process view; if a user-triggered turn ends with text and no send, Kiki asks the model to reconsider **once**, which can cost one extra request. The shipped `agent` profile exposes `SendMessage` in message mode and omits it in reply mode, and a custom profile with an explicit `tools` allowlist must list it — delivery mode does not bypass profile permissions. The tool table is frozen for a turn, so a delivery change applies to the next one.

`SendMessage` addresses the user or another persona with `to: "@Name"`; use the persona ID when names collide. A handoff can wake a closed conversation and counts toward the hourly limit, though retrying the same delivery key does not consume another slot. Attachments are immutable copies from the session workspace, its additional directories or the persona's own area, not arbitrary filesystem paths.

## Discuss in a room

Create a room with two to six members, a classification workspace and a host. Persona members get their own message-mode sessions. The API also accepts existing threads (`kind: "thread"`), which reuse their own sessions, workspaces and permissions, need `[thread_communication] enabled = true`, and cannot be subagents. In the GUI, Ctrl/⌘-click threads in the sidebar and choose **Pull into a new room**, use **Add to room…** on a thread, add them from the **Threads** tab under **Add member**, or pick **Open a room with these threads** on a thread link. Three rules decide who wakes:

1. A user mention wakes the named members; `@everyone` selects all members.
2. A user message without mentions goes to the host, whether the host is a persona or a thread.
3. A persona message wakes only the members it mentions. A message with no mentions does not continue the discussion.

Members run one after another, so a later speaker sees earlier speakers' results. A muted member is skipped by persona mentions and host fallback, but an explicit user mention still wakes it. Each member sees the messages since its last wake, minus its own already-recorded output.

The budget limits member messages after each user message (12 by default). When it runs out the discussion pauses; **Continue** resets the budget and resumes the retained work. **Pause** cancels queued wakes but lets the active turn finish, and **Stop all** also interrupts an active persona turn — never an original thread task — without undoing completed actions. Persona-only rooms keep user interruption steering, mixed rooms keep queued work. One room question is shown at a time; later ones queue.

Thread members default to `queueWhenBusy: true`, so room input waits for their current turn instead of steering it, and cold threads resume in their own workspaces. Every member other than the host gets unmentioned messages in its next catch-up without a separate model call. To speak, a thread must use `ThreadSend({room, content, mentions?})`; its ordinary assistant text never enters the room.

Renaming, changing the host, muting and workspace classification never rewrite a member's system prompt or permissions. Removing a thread leaves a system record in its session and preserves the room log without archiving the original thread. Creating a room needs two to six members, though members can leave and take it below two.

If a member cannot wake, the room shows the failure and what to do about it. For a model login failure, sign in under **Settings → Models & providers → Connections**, or open that member's conversation and pick an available model — existing member sessions keep their bound model, and editing the persona card does not change it. Then send another room message mentioning the failed member if it is not the host. **Continue** resumes a paused room; it does not retry a failed wake on an unpaused one.

## API entry points

The SDK exposes `global.personas`, `global.bots`, and `global.rooms`; HTTP clients also have `rest.personas`, `rest.bots`, and `rest.rooms`. Lists return arrays directly. Session creation accepts `persona` and `delivery`; session reads return `agent_config.persona = { id, name, avatarUrl? }` and `delivery`.

REST resources are `/api/personas`, `/api/bots`, and `/api/rooms`. Room membership, mute state, host, and budget are updated with `PATCH /api/rooms/{id}`; pause, continue, and stop use their corresponding POST actions. `GET /api/rooms/{id}/log` accepts `afterId` and `limit`. Persona memory uses `/api/memory/persona?persona_id=<id>` or `/api/memory/persona_workspace?persona_id=<id>&workspace_id=<workspace>`.

Authentication and connection setup are described in the [REST API guide](../server/rest-api.md).

## Next steps

- [Memory](../guides/memory.md) — the three memory scopes and how persona memory is stored
- [Roles you can talk to](/en/features/people) — the feature tour of personas, daily conversations, and rooms
- [Collaboration tools](../reference/tools.md#collaboration-tools) — the thread and room tools in full
