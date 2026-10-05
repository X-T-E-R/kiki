# Memory

Kiki remembers the things you would otherwise re-explain every session: how you like your code reviewed, which project fact you confirmed last week, where a reference lives. It is on by default, everything stays on the machine running Kiki, and every write shows up as one line in the conversation.

This page covers the scope choices on the **/memory** page, the review inbox that can sit between an agent and a write, and how to turn memory off. For what the agent does inside one session — compression, the message queue, the task board — see [Work that runs long](/en/features/long-work).

::: warning Shared memory homes
A Kiki older than 0.3.2 does not know the **Basis** and **Validity** fields below, and a write from that version can drop them from an entry. If two Kiki installations share one memory home — a desktop app and a CLI on the same `KIKI_HOME`, or a rollback to an earlier build — upgrade each of them to 0.3.2 or later. A field that has already been dropped is not restored for you: an entry that has lost one reads **Not recorded**, and putting it back means recording the basis or the check again from the original instruction or source material.
:::

## What the agent remembers

Memory is not a transcript and not a cache. It is the small set of durable facts that would otherwise be lost when a session ends; task progress belongs in the agent's working notes instead. An entry is one subject, held in one place: a short title you can recognize later and the **complete** current content, including the conditions that decide when it applies. The agent replaces content in full rather than appending to it, and keeps correction history and retired values in the change reason, not in the rule itself. The entry body is limited to 1,500 characters and a scope holds 300 active entries at a time; past either, the agent merges into existing entries instead of starting a new one.

Agents write with `MemoryWrite` and read back with `MemorySearch` and `MemoryRead`. Search matches partial terms, including Chinese phrases without spaces. Native subagents get the two read-only tools by default; `MemoryWrite` stays with the main agent.

Search comes in two modes. The default searches for a subject, title or alias and returns a ranked page of 8; `mode: "list"` browses the inventory a page at a time, 20 entries per page, with no query. Both report which scopes and statuses were actually inspected, whether the result set is complete, and whether anything was skipped or unreadable. A search snippet is at most 200 characters and **omits the conditions** — before relying on an entry, merging it, or replacing it, the agent reads it in full, and a search that finds nothing only means no entry uses those words.

In the main agent's `TodoList` notes, `directives` and `decided` can point at an entry by id, like `[m_id]`. At compaction the handoff carries each referenced entry's current title, follows replacements, and marks archived entries as withdrawn.

## Where an entry came from, and when to check it

An entry can record two things about itself, and both change how you should read it.

**Basis** is the content's evidence: `human` (something you asked for or accepted), `observed` (checkable material or an observation), `derived` (Kiki's own inference or a relay of what someone else said), or `unknown`. The detail view spells each one out and shows the note and any source locators behind it. An older entry that has no basis recorded reads **Not recorded** — a gap in the record, not a judgment about the content. Once you have material you can check it against, ask Kiki to record the basis and the check for that entry; the fields are written through the memory tools, not by the editor on the **/memory** page. Kiki will not invent one, and it does not treat a line as yours just because the write happened in your turn.

**Validity** is the check to run before trusting a changing fact. It carries a `check` describing what must be verified, and optionally an `until` timestamp. An entry with a check reads **Before relying on it: Check again**; one past its `until` reads **Past its endpoint** and stays on disk as a historical lead rather than a current premise; one with no recorded validity reads **No check was recorded**. Passing `until` never deletes or archives anything on its own.

Changing an entry's title, type or content on the page keeps its recorded basis and check. When the basis or the check needs to change, ask Kiki to update them at the same time. See [Built-in Tools](/en/reference/tools#memory-tools) for the tool-level contract.

## What the page lets you choose

On the `/memory` page you pick which body of memory you are looking at, and the page always offers the same three choices:

- **Global** — shared across every project.
- **Workspace** — one project's store.
- **Persona** — one persona's own store, following that persona across profiles and models.

Persona entries are isolated from each other. By default a persona can also read the shared global and workspace memory; set `memory.shared: []` on the persona card to cut that off. A workspace has its own switch that can follow the global setting, turn on, or turn off — turning it off leaves the saved entries in place, agents just stop reading and writing them there.

A persona can also keep notes scoped to a single workspace, which is how one persona working across several projects keeps project-specific detail of its own.

A new entry without an explicit scope goes to the bound persona when there is one, otherwise to the workspace — and choosing a scope never moves an existing entry or widens access to another workspace or persona.

### Personas

A persona's memory follows the persona, not the project, so it survives a change of profile or model. Deleting a persona deletes its memory too; if that cleanup fails, the deletion reports the error and keeps the card so you can retry. See [Personas, Bots, and rooms](/en/customization/personas#memory-and-character-cards).

Entries are typed, and the type is what you filter by: **About you**, **Feedback**, **Project**, and **Reference**. An entry is also **pinned** (kept at the top), **active**, **replaced** by a newer entry, or **archived**.

### Archived, replaced, and merged

Retiring an entry is a state change, not a deletion: the text stays, and **Undo** still reaches it. An agent **replaces** an entry when a rule has genuinely changed, which writes a new entry with its own id and marks the old one **Replaced**, so the history of both remains readable. When the new entry fully covers the old one's content, the agent can retire the old one as **Merged into** the retained entry instead, and the detail view links straight to it; that link is re-checked at the moment the retirement is applied, so a merge cannot silently hide a rule whose replacement has since changed.

## The /memory page

**/memory** is always in the sidebar. With memory off it is the guide for turning it on; with memory on it is where you manage entries — search them, filter by type, show or hide archived ones, and open one to read, edit, pin or delete it.

Workspace and Persona are searchable pickers, since either list can run to hundreds of entries. Picking one clears the other, and the choice rides a `?workspace=` or `?persona=` parameter, so a link to a particular scope keeps working.

### Change history and undo

Every change to an entry is recorded. Each history row shows the before and after and offers **Undo** for that one operation, deletes included — which is why the delete confirmation says you can undo it.

If the entry changed while you had it open, saving is refused and you are asked to reload first, so your edit cannot overwrite the newer version. Reload and re-apply what you meant to change.

Saving an entry that changes nothing — the same title, content, pin state and recorded attributes — produces no new version and nothing to undo, and the page says **No change**. Re-submitting an edit you already saved is the normal way to land here. Changing only the basis or the check is still a change, and does get its own version.

## The review inbox

Memory approval has three settings. The default, **auto**, applies a write the agent proposes right away. Set it to **review** and a proposed update or archive waits for you. With `auto` there is nothing pending, so no **Inbox** tab appears at all.

While a proposal waits, the original entry keeps its current content and stays in effect. **Keep** applies the proposal — an update replaces the text of the entry it supersedes, an archive archives that entry. **Discard** drops only the proposal and leaves the original untouched. A proposal is not active guidance: it is not used as a premise, and an agent's own write cannot approve it, only you can.

## Turning memory off

The **/memory** page has a single **Use memory** switch, and the same setting lives in the desktop app's settings. Turning it off stops agents from reading or writing memory.

The periodic long-term-memory reminders are separate. To stop just those while keeping the new-instruction and pre-compaction checks, set `memory_maintenance = false` in `config.toml` — the memory tools, approval and task notes stay available. See [Continuity reminder settings](/en/configuration/config-files#continuity-reminder-settings).

## Next steps

- [Personas, Bots, and rooms](/en/customization/personas#memory-and-character-cards) — how persona memory follows a persona
- [Work that runs long](/en/features/long-work#memory-keeps-the-facts-across-sessions) — the other long-work features
- [Built-in Tools](/en/reference/tools#memory-tools) — the memory tools in full
- [Server API](/en/server/rest-api#memory) — the same memory over HTTP
