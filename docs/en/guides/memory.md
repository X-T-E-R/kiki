# Memory

Memory is what a session does not keep. Kiki saves your preferences, feedback, verified project facts, and reference pointers, and finds them again in a later conversation. It is on by default, it is stored only on the machine running Kiki, and every write is one line in the conversation. This page covers the choices the **/memory** page offers, the review inbox that can sit between an agent and a write, and how to turn memory off.

If you are looking for what the agent can *do* in a single session — compression, the queue, the task board — see [Work that runs long](/en/features/long-work) instead.

## What the agent remembers

Memory is not a transcript and not a cache. It is the small set of durable facts you would otherwise have to re-explain: how you like your code reviewed, which project fact was verified last week, where the reference lives. Task progress belongs in the agent's working notes, not here.

Agents write memory with `MemoryWrite` and read it back with `MemorySearch` and `MemoryRead`. Search accepts partial term matches, including Chinese phrases without spaces. Native subagents get the read-only `MemorySearch` and `MemoryRead` by default; `MemoryWrite` stays main-only.

In the main agent's `TodoList` notes, `directives` and `decided` can reference an entry by its id, like `[m_id]`. At compaction the handoff carries the current title of each referenced entry, follows replacements, and marks archived entries as withdrawn. Resolving those references does not rewrite the saved notes or the frozen system prompt.

## What the page lets you choose

On the `/memory` page you pick which body of memory you are looking at, and the page always offers the same three choices:

- **Global** — shared across every project.
- **Workspace** — one project's store.
- **Persona** — one persona's own store, following that persona across profiles and models.

Persona-specific entries are isolated from other personas. By default a persona can also read the shared global and workspace memory; set `memory.shared: []` on the persona card to exclude those. A workspace has its own switch that can follow the global setting, turn on, or turn off. Turning memory off in a workspace leaves saved entries in place — agents simply do not read or write them there.

These are the choices the page offers, not a claim about how everything is stored: behind them a persona also has memory scoped to one workspace, so a persona working across projects can keep project-specific notes of its own.

### Personas

A persona's memory follows the identity rather than the project. It keeps following that persona when the profile or model changes, so switching models does not lose what it knows. Deleting a persona also removes its persona memory; if that cleanup fails, the deletion reports the error and keeps the card so you can retry. See [Personas, Bots, and rooms](/en/customization/personas#memory-and-character-cards).

Entries are typed, and the type is what you filter by: **About you**, **Feedback**, **Project**, and **Reference**. An entry is also **pinned** (kept at the top), **active**, **replaced** by a newer entry, or **archived**.

## The /memory page

**/memory** is a permanent entry in the sidebar, whether memory is on or off — with it off, the page is the turn-on guide; with it on, it is the management console. You can search entries, filter by type, show or hide archived ones, and open an entry to read it, edit it, pin it, or delete it.

Workspace and Persona are searchable picks, because either list can run to hundreds; choosing one clears the other, and the choice rides a `?workspace=` or `?persona=` parameter so a link to a particular scope keeps working.

### Change history and undo

Every change to an entry is recorded, and each history row opens the change with the before and after and an **Undo** for that one operation — including a delete. That is why the delete confirmation says you can undo it rather than that it is permanent.

If an entry changed while you had it open, saving is refused with a notice to reload first, so your edit does not overwrite the newer version. Reload the entry and re-apply what you meant to change.

## The review inbox

Memory approval has three settings. The default, **auto**, applies a write the agent proposes right away. Set it to **review** and a proposed update or archive waits for you. With `auto` there is nothing pending, so no **Inbox** tab appears at all.

While a proposal waits, the original entry keeps its current content and stays in effect. **Keep** applies the proposal — an update replaces the text of the entry it supersedes, an archive archives that entry. **Discard** drops only the proposal and leaves the original untouched.

## Turning memory off

The **/memory** page has a single **Use memory** switch, and the same setting is available in the desktop app's settings. Turning it off stops agents from reading or writing memory. The periodic long-term-memory reminders are a separate thing: to stop only those while keeping the new-instruction and pre-compaction checks, set `memory_maintenance = false` in `config.toml`. That does not disable memory tools, approval, or task notes — see [Continuity reminder settings](/en/configuration/config-files#continuity-reminder-settings).

## Next steps

- [Personas, Bots, and rooms](/en/customization/personas#memory-and-character-cards) — how persona memory follows a persona
- [Work that runs long](/en/features/long-work#memory-keeps-the-facts-across-sessions) — the other long-work features
- [Built-in Tools](/en/reference/tools#memory-tools) — the memory tools in full
