# Memory

Kiki remembers the things you would otherwise re-explain every session: how you like your code reviewed, which project fact you confirmed last week, where a reference lives. Memory is on by default, entries are stored on the machine running Kiki, and every write shows up as one line in the conversation. The optional [Memory Advisor](#memory-advisor) uses a model you choose to pick relevant saved entries.

This page covers the scope choices on the **/memory** page, reviewed Markdown edits, the review inbox, model-assisted recommendations, and how to turn memory off. For what the agent does inside one session — compression, the message queue, the task board — see [Work that runs long](/en/features/long-work).

::: warning Shared memory homes
A Kiki older than 0.3.2 does not know the **Basis** and **Validity** fields below, and a write from that version can drop them from an entry. If two Kiki installations share one memory home — a desktop app and a CLI on the same `KIKI_HOME`, or a rollback to an earlier build — upgrade each of them to 0.3.2 or later. A field that has already been dropped is not restored for you: an entry that has lost one reads **Not recorded**, and putting it back means recording the basis or the check again from the original instruction or source material.
:::

## What the agent remembers

Memory is not a transcript and not a cache. It is the small set of durable facts that would otherwise be lost when a session ends; task progress belongs in the agent's working notes instead. An entry is one subject, held in one place: a short title you can recognize later and the **complete** current content, including the conditions that decide when it applies. The agent replaces content in full rather than appending to it, and keeps correction history and retired values in the change reason, not in the rule itself. The entry body is limited to 1,500 characters and a scope holds 300 active entries at a time; past either, the agent merges into existing entries instead of starting a new one. Replacing an active entry is still allowed at capacity when the final active count does not increase; a proposal is checked again when you approve it.

Agents write with `MemoryWrite` and read back with `MemorySearch` and `MemoryRead`. Search matches partial terms, including Chinese phrases without spaces. Native subagents get the two read-only tools by default; `MemoryWrite` stays with the main agent.

Open a memory-tool row in the conversation to read its recorded **Input** and **Output** together. Large fields continue loading from that original record, and their copy controls retrieve the complete field rather than just the visible preview. A write's receipt keeps the scope, revision and operation from that write; **View** opens the entry's current state on the memory page, while **Undo** targets the recorded operation. Neither replaces the historical output with today's entry. If reading a field or receipt fails, use its **Retry** action.

Search comes in two modes. The default searches for a subject, title or alias and returns a ranked page of 8; `mode: "list"` browses the inventory a page at a time, 20 entries per page, with no query. Both report which scopes and statuses were inspected, whether the result set is complete, and whether anything was skipped or unreadable. Continue with the cursor while `exhausted` is false, even after an empty preparation page. The file backend ranks each bounded source chunk; an empty search means no match for those words, not proof that no related guidance exists.

Search returns the complete body, evidence, check and revision when the whole entry fits its response budget: 24,000 UTF-16 units and 6,000 estimated tokens, including metadata. The agent can reuse an item marked `complete: true` without another read. An item marked `complete: false` is a reference with an exact `MemoryRead` target; the agent reads that target before using or changing its content. Bodies are never cut short to fit. If reference metadata alone exceeds the budget, restart with a smaller `page_size`. List mode returns references.

Each agent can keep explicit entry IDs such as `[m_id]` in any section of its current `TodoList` notes. Kiki deduplicates these links for automatic recall; only entries visible to that agent, active, unexpired and within the complete-entry budget can enter its working set.

Compaction handles links in `directives` and `decided` separately. With SQLite, the handoff keeps references for a fresh `MemoryRead`; the file-backed path includes current titles, follows replacements and marks archived entries as inactive.

## Where an entry came from, and when to check it

An entry can record two things about itself, and both change how you should read it.

**Basis** is the content's evidence: `human` (something you asked for or accepted), `observed` (checkable material or an observation), `derived` (Kiki's own inference or a relay of what someone else said), or `unknown`. The detail view spells each one out and shows the note and any source locators behind it. An older entry that has no basis recorded reads **Not recorded** — a gap in the record, not a judgment about the content. Once you have material you can check it against, record the basis and check through the memory tools or a [reviewed Markdown import](#edit-a-markdown-export). Kiki will not invent one, and it does not treat a line as yours just because the write happened in your turn.

**Validity** is the check to run before trusting a changing fact. It carries a `check` describing what must be verified, and optionally an `until` timestamp. An entry with a check reads **Before relying on it: Check again**; one past its `until` reads **Past its endpoint** and stays on disk as a historical lead rather than a current premise; one with no recorded validity reads **No check was recorded**. Passing `until` never deletes or archives anything on its own.

Changing an entry's title, type or content on the page keeps its recorded basis and check. When those attributes need to change, update them along with the content through the tools or the Markdown import. See [Built-in Tools](/en/reference/tools#memory-tools) for the tool-level contract.

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

The list and Inbox show available entries as they arrive and keep reading automatically until the namespace is covered. If a record cannot be read, the page keeps the readable entries and shows the diagnostic rather than claiming the list is empty. If continuation fails or the source changes, use **Retry** to reload. List previews stay short; opening an entry or **View** in Inbox loads its full content.

### Change history and undo

Every change to an entry is recorded. Each history row shows the before and after and offers **Undo** for that one operation, deletes included — which is why the delete confirmation says you can undo it.

If the entry changed while you had it open, saving is refused and you are asked to reload first, so your edit cannot overwrite the newer version. Reload and re-apply what you meant to change.

Saving an entry that changes nothing — the same title, content, pin state and recorded attributes — produces no new version and nothing to undo, and the page says **No change**. Re-submitting an edit you already saved is the normal way to land here. Changing only the basis or the check is still a change, and does get its own version.

## Edit a Markdown export

For a home already using SQLite, **/memory** lets you export one complete entry, edit its Markdown file and review the changes before saving. The same workflow is available through the authenticated [Memory API](/en/server/rest-api#markdown-export-and-import), including when agent memory access is off.

1. Open an entry and choose **Export Markdown**, then edit the saved file. Keep its scope, ID, revision, origin and source coordinates intact; update the complete content, basis and check together when they change.
2. Next to **New memory**, choose **Import** and select the edited file. Check **Source**, enter your reason and choose **Preview import**. Compare **Stored now** with **From the file**. An unchanged document needs no write; an already admitted source points to its current corrected entry instead of replaying old content.
3. Choose **Apply update** or **Create memory** only when the preview offers that action. A preview lasts ten minutes and expires on a server restart or authority change. If it expires, choose **Preview again** with the same file. After a revision conflict, re-export the entry if it still exists, reconcile your changes and preview again. If it was forgotten, stop importing this old source.

A genuinely new document uses `id: new`, `revision: null` and `origin: null`. Renaming an old file or changing its ID does not restore a forgotten source. Import does not approve pending proposals, revive retired entries or move entries to another scope; use their review or restoration actions first. In read-only recovery mode you can export, but must [resume editing](#backend-migration-and-recovery) before previewing or applying an import.

## Backend migration and recovery

Starting the upgraded Kiki automatically migrates existing memory through the SQLite import and validation pipeline. New homes use SQLite too. No migration button, old-writer confirmation or experimental switch is required. The same tools and editor wait for the upgrade, then use SQLite; original files remain unchanged, and subsequent starts reuse the completed database. Storage migration preserves **Allow memory**: if it is off, agents still receive no saved memory and the advisor sends none out.

If the upgrade stops, the [Memory API](/en/server/rest-api#backend-migration-and-recovery) reports its saved operation ID, last committed page and source issues. Normal memory access stays blocked instead of reading an older copy. Repair the reported source and retry that operation, or restart to resume it. Upgrade other installations sharing the home as well; the backend marker governs compatible writers, not binaries released before that protocol.

The API can also save a governed recovery package and switch SQLite to read-only mode. Current entries stay readable, including corrections made after migration; editing resumes only with the current recovery ID and epoch returned by the API. Keep the full database backup: Markdown exports current entries and pending proposals, while the database also retains immutable revisions, correction records and forget barriers. Do not restore an old file directory over newer governed memory.

## The review inbox

Memory approval has three settings. The default, **auto**, applies a write the agent proposes right away. Set it to **review** and a proposed update or archive waits for you. With `auto` there is nothing pending, so no **Inbox** tab appears at all.

While a proposal waits, the original entry keeps its current content and stays in effect. **Keep** applies the proposal — an update replaces the text of the entry it supersedes, an archive archives that entry. **Discard** drops only the proposal and leaves the original untouched. A proposal is not active guidance: it is not used as a premise, and an agent's own write cannot approve it, only you can.

## Memory Advisor

Memory Advisor uses a source you choose to recommend saved entries for the current request. Choose its source in **Settings → Models & providers → Defaults → Who decides** (`/settings/ai?tab=defaults#st-card-decision-judges`); **Settings → Memory** keeps its switch, budgets and runtime status. Choose a source and enable the advisor to start using it.

1. Choose a [decision connection](../configuration/providers.md#decision-connections) or an existing chat model for **Memory Advisor**. A connection owns its protocol, endpoint and existing Kiki credentials; an optional model name on this row overrides its remote default. **System One** uses a compatible decision service, **Pair score** uses a reranker, and chat models return structured answers. Saving the source preserves an existing off switch and does not change the permission reviewer's source. Existing `selector` configurations remain usable until you replace or clear the source.
2. In **Settings → Memory**, turn on **Memory Advisor**. It sends the current request, task notes, relevant tool-error context, memory titles, short excerpts and selected complete entries to that source. Common secret patterns are masked before sending.
3. Optionally choose **Test with sample data**. It tests the saved source with made-up content, including while the advisor is off. Your saved entries are not read for this test. A failure names the issue; use the source's connection or model settings to correct its address, protocol or credentials, then try again.

The **Advisor** switch in the memory-page header and the command in `Ctrl-K` change the same global setting. Turning it off preserves the configuration, cancels unfinished recommendations, and restores the previous memory selection and text. Turning it back on uses **Rank**. The separate **Allow memory** switch controls all agent memory access.

In **Advanced**, **Rank** places recommendations before keyword matches within the existing complete-entry budget. **Select** also leaves out entries explicitly judged unsuitable; exact ID references, pinned entries and entries not yet judged remain eligible. **Pair score** supports **Rank** only. A recommendation does not replace an entry's evidence or required validity check. Children use the advisor only within their effective memory and model permissions, and can be excluded with **Advise subagents**.

In the same fold, **In a running session** lets you choose an existing session and agent, then **Read status** for the latest runtime outcome, calls and recommendations. Reads happen only when requested. A cold or absent agent reports **No running status yet** and stays unloaded.

The wait, request deadline, calls per turn, directory pages, full-entry count and input budget are adjustable in the same fold. Only the first step waits, up to the configured limit. Without your own value it waits up to 3000 ms for a System One or Pair score connection and 1500 ms for a chat model, and follows the source when you switch it. A value you enter always wins; **Reset to default** returns to the source default. Later results join at a subsequent step. On a timeout or invalid answer, Kiki uses the existing selection path. If the current storage backend lacks committed snapshots, the advisor reports that it is unsupported and memory continues as before.

## Turning memory off

**Allow memory** on the **/memory** page and in Settings stops agents from reading or writing memory. To keep memory available and stop only model-assisted recommendations, turn off **Advisor** instead.

The periodic long-term-memory reminders are separate. To stop just those while keeping the new-instruction and pre-compaction checks, set `memory_maintenance = false` in `config.toml` — the memory tools, approval and task notes stay available. See [Continuity reminder settings](/en/configuration/config-files#continuity-reminder-settings).

## Next steps

- [Personas, Bots, and rooms](/en/customization/personas#memory-and-character-cards) — how persona memory follows a persona
- [Work that runs long](/en/features/long-work#memory-keeps-the-facts-across-sessions) — the other long-work features
- [Built-in Tools](/en/reference/tools#memory-tools) — the memory tools in full
- [Server API](/en/server/rest-api#memory) — the same memory over HTTP
