---
title: GUI interface rules
description: The nine rules every GUI page is judged by, the per-area decisions taken from them in November 2026, and how much of that work is built.
outline: [2, 3]
---

# GUI interface rules

This record holds the rules that settle disputes about the GUI in `apps/kiki-gui`, the page-by-page decisions the November 2026 redesign took from them, and the state of that work. The rules are short; most of the record is the per-area decisions, because later changes are checked against them.

Two documents in the tree carry the same conventions in working form and are what reviewers read day to day: `apps/kiki-gui/docs/settings-conventions.md` (how a settings card is built) and `apps/kiki-gui/docs/i18n-glossary.md` (terms, state words and fixed sentences). If they disagree with this record on a detail, the documents in the tree win; if they disagree on a rule, correct whichever is wrong.

The spaces, connection and pairing pages follow the same rules but were designed separately; see [Spaces, computers, devices and pairing](./2026-11-spaces-and-pairing.md). The preview panel is covered by [The preview layer](./2026-11-preview-layer.md).

## The problem

The GUI had grown one page at a time, and each page had picked its own answers. Settings lists with two or three entries carried full search, filter chips, sort and multi-select. On a phone a model connection's state had shrunk to a coloured dot, with the words "Missing key" and "Connected" hidden. The agent table wrote "Default" in every cell without saying what the default resolved to. Engine internals (session residency limits, handoff notices to subagents and hosts, the default return fields of `AgentList`) sat on the same pages as user preferences. First launch put a modal questionnaire over the new-conversation page, and reopened it on every reload until it was finished. The browser asked for notification permission the first time Kiki wanted to notify, with no context.

Of the nine rules below, three were broken most often: rule 2 (state and next step only), rule 4 (state in words) and rule 7 (settings hold only "from now on" defaults).

## What each page is for

Kiki is a workbench for directing agents: a person hands a task over, watches it, decides when needed, and takes the result. The conversation page holds that work. Every other page is one of three kinds and must be able to say which:

- **Makes the next conversation possible**: models, permissions, workspaces, capabilities. It is worth having when the next send neither fails nor oversteps.
- **Says what happened and what is happening**: activity, usage, background tasks, scheduled tasks. It is worth having when it answers "do I need to act?" at a glance.
- **Manages the material conversations use**: memory, personas, archive.

The project's standing principles (smallest correct change, start nothing the person did not start, do not claim to know what is not known, ask only when needed, teach at the moment of use, report state plainly) become the nine rules below when applied to these three kinds of page.

## The nine rules

Each rule comes with the test that decides whether a page meets it.

| # | Rule | How to judge |
| --- | --- | --- |
| 1 | **Answer the page's question first.** Each page, and each settings section, answers one question, stated as one sentence at its top. The first screen gives the answer (a status sentence or the list itself); the controls that change it come after. | Look only at the first screen (desktop 1440×900, phone first screen). Can a newcomer answer the page's question? |
| 2 | **Normally show only state and the next step.** What is present is the object's state and its one most common action. Rare, per-object and explanatory things go one level down: a row menu, a detail page, an "Advanced" fold. List tools have thresholds: search appears at 8 items; filter chips at 8 items with at least two kinds; sort only where the order changes what the reader concludes; multi-select only from an explicit "Select" action. | Count the first-screen controls and ask whether half of this week's visitors would touch each one. Check list tools against the thresholds. |
| 3 | **Put an action next to the object it acts on.** An action on one object sits on that object (the most common one inline, the rest in its row menu). The action that creates this page's objects sits in the page header, once. Actions on the current conversation's content sit in the conversation header's ⋯; the sidebar row menu is for list management. Settings hold future defaults, never actions on something in front of the person. One vermilion primary button per screen; vermilion only for "needs you"; links and secondary actions are ink. | How many steps lie between an action and the thing it changes; whether it appears twice; where vermilion is used. |
| 4 | **Say state in words, where it happens.** A state is a word; colour and shape only reinforce it. What is not known is said as not known ("Not checked", "Unknown"), never replaced by "0" or "Default", and "Default" always carries the value it resolves to. Work in progress says what is being done and since when. An empty state is one sentence on what will appear plus one action that fills it; an action with nothing to act on is not shown. A failure is said where it happened: what did not work and how to recover, with the server's text in the details. | Remove the colour: can the state still be read? Is anything unknown written as known? Does every empty and failed state offer a next step? |
| 5 | **One rhythm.** A row has at most two lines (a name; one fact). Help text is one sentence; longer text goes in a fold. One width per page: 720 px for reading, 1120 px for lists and boards. No boxes inside boxes; cards only for objects that can themselves be opened. What a group heading already says is not repeated in its rows. | Row heights and repetition; boxes in boxes; whether an ⓘ carries information needed for a decision (touch has no hover). |
| 6 | **On a phone, change the form, not the words.** Desktop and phone say the same things in the same order. The phone may drop what is one step away, but the desktop must not lose reach because of the phone, and the two menus need not match item for item. Only the form changes on a phone: menus become bottom sheets; a page header keeps the title and one action, the rest goes into ⋯; switches stay at the right of their row and only a picker that does not fit drops under its label; tables become two-line rows; truncation keeps the end that tells objects apart (a path keeps its file name, a title keeps its start); anything that works only by hover or keyboard gets a tap entry or is absent on touch. The desktop never gets worse for the phone's sake. | Put the two screenshots side by side: same information, same order? Any clipped column, squeezed-out title, or state left as a colour only? |
| 7 | **Settings hold only "from now on" defaults.** A setting passes three tests: the person sees what it changes while working; two reasonable people would choose differently; there is no better place for it than next to the thing it affects. What fails is not a setting: engine internals go to Developer & labs › Engine parameters; things the product should get right by itself, switches duplicated elsewhere, actions on something in front of the person, and questions with a sensible default that can be changed later are removed from Settings. | Ask the three questions of every setting. |
| 8 | **Start nothing for the person.** Without an action of theirs: no dialog, no navigation, no connection, no system permission request, no send, and no reading of another application's sign-ins or credentials. A check the person starts is read-only and reports facts; whether to use the result is their choice. A modal that opens by itself counts as starting something. | List every side effect of loading a page and ask who started it. |
| 9 | **Ask and teach at the moment of use.** A question appears only when its answer is needed now and the person can see the consequence. A behaviour is explained once, in place, the first time it happens, and not again. | When a question appears, can the person see what it affects? When something is explained, is the explained thing on screen? |

## Conventions and fixed wording

The rules are written into the tree in three places, which later work should extend rather than restate:

- **`apps/kiki-gui/docs/settings-conventions.md`**: §0 (a section answers one question first, with a state card first when the section has a state), §2 (phone rows keep switches and short inputs on the right; links and text buttons are ink), §3 (state is a word; list tools have a threshold; read-only objects show values and the reason instead of disabled controls), §3.5 (what is not a setting), §3.6 (empty, loading, failure) and §4 ("Default" carries its value).
- **`apps/kiki-gui/docs/i18n-glossary.md`**: the state-word table, "Default ({value})", the 「这台电脑」 / 「运行 Kiki 的电脑」 rule, 「导览」 as the only onboarding word, 「连接」 as the object people connect, 「复刻」 for fork, and the standard Auto sentence.
- **`LIST_TOOLS_MIN_ITEMS = 8`** in `apps/kiki-gui/src/components/settings/list/listState.ts`: the one threshold constant for list tools, compared with `>=`. Pages do not choose their own threshold.

Four words that look alike are four different things and never stand in for each other: 「未检测」 / "Not checked" (nobody has looked), 「未知」 / "Unknown" (looked, could not read it), "0", and 「默认」 / "Default" (which always shows its value). The glossary's state words are the only state words used in rows, state cards and the sidebar:

| zh | en | Used for |
| --- | --- | --- |
| 已连接 | Connected | a connection that works |
| 就绪 | Ready | a tool or service that works |
| 缺少密钥 | Missing key | a connection with no credential |
| 未登录 | Not signed in | an account connection |
| 未检测 | Not checked | not looked at yet |
| 未知 | Unknown | read but not readable |
| 不可用 | Unavailable | read, and really unusable |
| 正在{动作}… | {Doing}… | in progress, naming the object |
| 已失败 / 已停止 | Failed / Stopped | outcomes; never red |
| 需要处理 | Needs attention | a summary of problems in Settings and lists |
| 等你处理 / 待批准 / 待回答 | Needs you / Awaiting approval / Awaiting answer | only for decisions the person must make |

Sentences that several surfaces share are fixed:

| Use | zh | en |
| --- | --- | --- |
| Auto mode, everywhere it is explained (permissions page, composer chip, first approval card) | 工作区里的读写和常规命令 Kiki 自己做；敏感文件、外部链接和危险命令先问你。 | Kiki handles reads, writes and routine commands in the workspace itself, and asks you before sensitive files, external links or risky commands. |
| A default | 默认（{value}）; when it cannot be resolved 默认（未知） | Default ({value}); Default (unknown) |
| The machine running the server, in the desktop app | 这台电脑 | this computer |
| The same machine, from a phone or a browser | 运行 Kiki 的电脑 | the computer running Kiki |
| A failure line | 没能{做什么}：{原因}。{怎么办} | Couldn't {do what}: {reason}. {How to recover} |

「本机」 and 「本地」 are not used for the machine running the server: on a phone they point at the phone. Fork is 「复刻」 everywhere; the four values that said 「分叉」 were corrected, as were three values with a bare "Agent" and the value 「智能体传话」 (now 「智能体之间的消息」).

Every key the redesign added is in `packages/session-core/src/i18n/en.ts` and `zh.ts`. The tables in this record give copy only where it fixes a decision; the dictionaries hold the rest.

## Decisions by area

### Settings: navigation and section shape

Settings has 20 leaves in seven groups (`SETTINGS_NAV_TREE` in `packages/session-core/src/settings/settings.ts`): app (General, Appearance, Shortcuts, Notifications & messages); models and agents (Models, Agents); sessions and work (Sessions, Workspaces, Memory); capabilities (Extensions & tools, Search & retrieval, Browser & computer, Hooks); permissions; connection (rebuilt separately as "Spaces & devices"); advanced (About & updates, Developer & labs). Recipes is a tab of Models, not a leaf. Request identity and the new Engine parameters are tabs of Developer & labs. Old addresses (`/settings/recipes`, `/settings/ai?tab=identity`, old `#st-card-*` anchors) redirect to the new place and land on the card, and settings search finds moved entries at their new home.

A leaf with a problem says so with the word 「需处理」 / "Needs attention" instead of a red dot. The phone's settings index gains a 「需要处理」 / "Needs attention" group at the top, one row per problem ("{section} · {object} {problem}"; en "{section} · {object}: {problem}") that opens the card concerned. The group uses data read once when the index opens (model connections and plugin state), uses a cached answer when there is one, and is never polled. While that data has not arrived, the group is absent rather than saying "checking"; when the read fails, it is absent too, because not knowing is not a problem to report. On a phone, a section page has no full-width search row; search sits behind a magnifier in the header and replaces the title row when opened.

Every section follows one shape:

```text
Settings / <section>
<one sentence: the question this page answers>
<state card: the state in words>              always first when the section has a state
<needs attention: one row per problem, each with its fix>   only when there is a problem
<defaults people change, most used first>
<the objects this section owns; list tools by threshold>
▸ Advanced (rare settings, precedence, environment variables)
```

A section has at most three tabs, and a tab with only one card is merged back. A section never shows engine internals, switches duplicated elsewhere, actions on something in front of the person, decision-relevant information hidden in an ⓘ, or buttons with nothing to act on. An object that is itself read-only (a built-in agent, a built-in request identity, a memory store opened as a read-only recovery copy) shows its values and the reason. The product has no state in which an administrator manages a page and the client cannot write it, so no such state is designed; the only "managed" objects are OAuth-managed connections, which are partly editable, not read-only.

### Settings › Models

Models answers 「Kiki 用哪些模型回答，哪个连接需要处理。」 / "Which models Kiki answers with, and which connection needs attention." Its tabs are 「连接 · 默认值 · Recipe」 / "Connections · Defaults · Recipes".

```text
Settings / Models
Which models Kiki answers with, and which connection needs attention.

  New conversations use Kiki Pro                          [Change]
  2 connections, 1 needs attention

Needs attention
  alt        API · 1 model        Missing key              [Add key]

Connections                                       [+ Add connection]
  fixture    API · 2 models       Connected                        ›
  alt        API · 1 model        Missing key                      ›

▸ Command-line agents (on the computer running Kiki)
▸ Decision models (which model reviews approvals and which picks memories)
```

- The **state card** comes first, above the tabs: 「新会话默认用 {model}」 / "New conversations use {model}" with **Change**, then the connection count and, when there are any, how many need attention ("2 connections, 1 needs attention" / 「2 个连接，1 个需要处理」).
- **Needs attention** lists only connections with a problem, each with the one action that fixes it: 「填写密钥」 / "Add key" opens that connection with its key field focused; a signed-out account gets its sign-in action. "Needs attention" means what the attention filter means today: provider status `error` or `unconfigured`, or an account whose `connection_state` is `reconnect_required`.
- **Connections** is one list of every chat connection (account sign-ins, API services, local servers such as Ollama), each row "name · kind · N models · state word". **Add connection** sits only at the right of the "Connections" heading and opens the same three-lane component as the first-run card (see [First run](#first-run)), so the catalogue of not-yet-connected accounts no longer sits under existing connections. Inside Settings, the key lane's "Another service or a custom address" opens the full provider form in the same panel.
- **Command-line agents** is a fold holding the external-engine list; the switch that allows choosing enabled engines appears only when at least one engine exists.
- **Decision models** is a fold with two rows, "Approval review: Not set. Reviews will ask you instead." and "Memory advisor: {model}".
- Concurrency rules are added, edited, toggled and deleted in a **Concurrency** card on Models › Defaults. The Usage page keeps only a read-only line "Limited by {count} concurrency rules" with **Manage rules**, which links to that card.
- On a phone the order is the same; a connection row has two lines (name and state word; "API · 2 models") and the state word is never dropped.

| State | What shows |
| --- | --- |
| No connection | The state card says 「还没有连接模型。连上一个，Kiki 才能回答。」 / "No model connected yet. Connect one so Kiki can answer." and the three lanes open directly under it; no dashed empty box first. |
| Loading | After 300 ms, two placeholder rows of row height; the state card says 「正在读取连接…」 / "Loading connections…". |
| One connection | No list tools; "1 connection". |
| 8 or more | Search appears; a "Needs attention {n}" chip appears only when some rows match and some do not. |
| List failed | 「没能读取连接列表：{detail}」 / "Couldn't load the connection list: {detail}" with Retry; the default model still shows if known, otherwise "Default (unknown)". |
| Sign-in methods failed | Under the account lane: 「没能读取可用的登录方式：{detail}」 / "Couldn't load the available sign-in methods: {detail}" with Retry, in Settings and in the first-run card alike. |

### Settings › Sessions, Agents, Permissions and Engine parameters

**Sessions** answers 「新会话怎样开始、怎样起名、后台工作怎么处理。」 / "How new conversations start, get named, and handle background work." It has no tabs and five cards: new conversations (plan before acting), titles (automatic titles and the model that writes them), agent questions (keep working or wait for you; remind the agent when it asks too often), background work (move a timed-out command to the background, the command timeout, keep background tasks when a conversation closes), and archive (「归档」 / "Archive": the count and "View archive"; 「还没有归档对话」 when there are none, and no "View archive" then).

What left Sessions, and where it went:

| Item | Moved to | Why |
| --- | --- | --- |
| Approval for entering or leaving plan mode | Permissions | It is an approval rule. |
| Allow threads; subagents may notify their parent | Agents › Dispatch | Messages between agents, which the person can observe. |
| Handoff notices to subagents and hosts, the "prefer file tools after Bash" hint, maximum running tasks, the four session-residency values, the three title-generation timings, the title prompt text, advanced command run and termination parameters | Developer & labs › Engine parameters | Rule 7: not observable while working, or something the product should get right by itself. |

**Engine parameters** receives every engine internal. None was deleted, the two handoff notices included. The tab opens with 「这些参数只在排查问题时需要改。」 / "You only need to change these when troubleshooting." and shows effective values, still editable. Request identity and the server's own identity (display name, slug, upstream identification, extra agent directories, built-in templates not to install) also move to Developer & labs.

**Agents** answers 「谁来干活、用什么模型、能派给谁。」 / "Who does the work, with which model, and who can be dispatched." It is one page without tabs: a "Needs attention" block, the agent list, a **Dispatch** section, and an **Advanced** fold.

- A row's second line states effective values: 「默认模型（{model}）· 思考：{effort} · 可被派发」 / "Default model ({model}) · Thinking: {effort} · Can be dispatched". Model and thinking are changed in the agent's detail page; the list has no inline pickers.
- The two common problems read as sentences next to their row: 「指定的模型“{model}”不存在，现在用默认模型。」 / "The model “{model}” doesn't exist, so the default model is used." and 「项目里的 {name} 与内置 {name} 同名，没有生效。」 / "The project's {name} has the same name as the built-in {name} and isn't in effect." Other diagnostics keep their text.
- Dispatch holds the default subagent, subagent limits and agent messaging, then the subagent panel mode and tool defaults; each card keeps its own anchor and save model.
- Advanced holds subagent model rules, shared prompt fields (where the old onboarding's "speaking style" was written, so people looking to change tone find it there) and agents disabled by name. A deep link to a card inside the fold opens the fold.
- A built-in agent's detail says 「内置智能体不能直接修改，复制后可以改。」 / "Built-in agents can't be edited directly. Duplicate one to change it." followed by Duplicate.
- With only the built-in main agent, the list shows one row and 「需要专门做某类事的助手时，在这里新建，或让 Kiki 帮你写一个。」. A failed read says 「没能读取智能体：{detail}」 / "Couldn't load agents: {detail}" with Retry. Search and grouping appear at 8 agents.

**Permissions** was already the best page and changes little. The purpose sentence says 「智能体」, not "Agent". "Change" is an ink link. The risky-Bash choice reads 「跟随模式（{effect}）」 / "Follow mode ({effect})" instead of "Default". The rules card's precedence explanation goes into the Advanced fold, and "Add rule" appears only in the empty sentence while there are no rules. The Tools card says once, when nothing is set per tool, 「所有工具都按各智能体的设置。」 / "Every tool follows each agent's settings." with **Adjust per tool**, and lists unavailable tools once under 「这台 Kiki 上不可用的工具（{count}）」 / "Tools not available on this Kiki ({count})" instead of repeating "currently off" on every row. The Auto hint uses the standard Auto sentence.

### Settings: the remaining sections

| Section | Decision | Rule |
| --- | --- | --- |
| General | The "Sidebar tools" card is removed; the identical checkboxes in the sidebar's View menu are the only place. "Send shortcut" is hidden on touch. | 7 |
| Appearance | Unchanged. | — |
| Notifications & messages | The This-device card states the system permission as a word: 「系统通知：已允许」 / "System notifications: allowed", 「系统通知：还没有询问」 / "not asked yet", 「系统通知：已拒绝，可以在系统设置里打开」 / "blocked. You can turn them on in system settings." The line only states; asking happens from the banner described under [First run](#first-run). | 4 |
| Workspaces | List tools by threshold. A row keeps one visible verb, **New session**; pin, rename and remove go into ⋯; multi-select opens only from **Select**. A failed trust read is said once under the list with a count and Retry ("Couldn't read the trust status of {count} workspaces"), and rows no longer say "Unknown". "Clean up" is absent when there are no worktrees. | 2, 4 |
| Memory | Links are ink. The advisor switch lives only here. | 3 |
| Extensions & tools | Holds sources and defaults only (skill directories, merge rules, MCP configuration). Installed objects are listed only on the Capabilities page; this section shows 「已安装 {plugins} 个插件、{skills} 个技能」 / "{plugins} plugins and {skills} skills installed" with a link there. A parse failure says 「没能读取已安装的插件：服务器返回的格式不对（{detail}）」 with Retry. | 3, 4 |
| Search & retrieval | Unchanged, except that a service switched on without its key gets **Add key** beside the switch. | 4 |
| Browser & computer, Hooks | While empty, the only add action is the one in the empty state; the heading action appears once there is an item. | 3 |
| Developer & labs | Gains Engine parameters and Request identity. | 7 |
| About & updates | "Re-enter onboarding" is removed; the tour starts from the Discover page. | 9 |

### First-party pages

- **Usage** opens on History, not on the live control panel. While requests run or wait, a band above says 「现在：{active} 个模型请求进行中，{queued} 个排队」 / "Now: {active} model requests running, {queued} queued". Export and model prices move into the header ⋯ ("Model prices ({count} missing)"). Quota bars are ink and turn to the needs-you colour with 「剩余不足 10%」 / "Less than 10% left". The sidebar badge says 「{count} 排队」 / "{count} queued" only when something is queued. Never-used: 「还没有用量记录。开始一次对话后，这里按时间显示花费和 token。」; an old server: 「这台 Kiki 的服务器版本不提供用量数据。」. The History tab's honest handling of unpriced and unknown usage stays as it is. On a phone, the range is a dropdown and live tables become two-line rows.
- **Memory**: the header holds only the title and "New memory"; under it one status sentence, 「记忆已开启，存在运行 Kiki 的电脑上；每轮由 {model} 挑选相关的几条。」, with an ink "Memory settings" link. "Show archived" becomes a last row 「已归档 {count} 条 ›」.
- **Personas**: the desktop header keeps its three buttons; the phone header keeps "New persona" and moves the rest into ⋯. Archived personas become a last row. A persona conversation's header on a phone has two lines (avatar and persona name; the title across the whole line) and no workspace name.
- **Background tasks** use the common page header (its back button replaces "Back to conversation"), group rows into "Running" and "Finished", put Stop on running rows, drop the per-row boxes and the "Shell" tag, and explain the empty page: 「命令超时转入后台、或智能体启动长任务时，会出现在这里。」.
- **Capabilities** opens on Installed, problems first, with Marketplace second; refresh goes into ⋯.
- **Activity** keeps its structure: waiting items longest-waiting first, then what finished while the person was away.
- **Discover** stays as the help entry with one main path: 「花一分钟，在真实界面上走一遍：交给 Kiki 一件事、看它做、批准一步、收下结果。不调用模型。」 and **Start the tour** as the only vermilion button, then three text rows for single topics. A paused tour adds 「上次停在第 {step} 站。」 with Continue.
- **Scheduled tasks** stop repeating "Enabled" inside the "Enabled" group and merge "repeat" and "insert when idle" into one fact. **Archived conversations** replace the ambiguous "×" with Restore and "Delete permanently…" in ⋯.

A phone page header holds ☰ or Back, the title (never squeezed below eight Chinese characters' width) and at most one action; everything else goes into ⋯ as a bottom sheet.

### Sidebar

A conversation row says four things at a glance: which conversation (title), whether to go there (state, ranked needs you > failed > running > unread > read), when (time) and where (workspace, omitted when grouped by workspace). Queue counts and background-task marks leave the row and are seen inside the conversation; the external-client tag stays.

```text
desktop row                                             phone row
● Pick a rollout window                1月1日           ● Pick a rollout window              ⋯
  …/workshop · 待回答                                     …/workshop · 待回答           1月1日
○ Backfill usage rollups               2 小时前          ○ Backfill usage rollups             ⋯
  …/workshop · 已运行 3 小时 12 分                        …/workshop · 已运行 3 小时    2 小时前
```

- A running row's second line says 「已运行 {duration}」 / "Running for {duration}": `m:ss` under an hour, hours and minutes from an hour, days only from a day. Chinese durations keep the glossary's spacing (「3 小时 12 分」, 「2 天」).
- On a phone the time moves to the right end of the second line and ⋯ stays on the first line; ⋯ is the only menu entry on iOS, where long-press does not open a context menu.
- The running count beside "Sessions" is a word ("2 running"), still a filter shortcut. An active filter shows its icon in the selected ink, not vermilion. The filter menu lists only states that currently have conversations.
- The row menu's first level is list management: pin, rename, copy thread link, add to the current conversation (only when another conversation is open), join a room (only when thread communication is on; absent, not greyed with an explanation, when it is off), copy working directory, archive. On desktop, fork, export archive, compact context and undo last turn stay reachable in a "More" submenu at the end, because acting on a conversation without opening it is a real desktop habit. On a phone the menu has only the first level, as a bottom sheet; those four actions are in the conversation's own menu. Filter and view menus are bottom sheets on phones too.
- The footer shows nothing while connected and words while not: 「已断开 · 正在重连」 / "Disconnected · reconnecting". The spaces design later moves connection state into the sidebar's position bar and removes this footer mark.

### First run

There is no questionnaire. The first launch lands on a real new-conversation page.

| Situation | What the person sees |
| --- | --- |
| The server has no usable model (`needsProviderSetup`: authentication not ready and the model list empty, both probes answered) | The new-conversation page with the "connect a model" card in the composer's place. This is server state, not one-time onboarding, so it returns whenever the server has no model again. |
| Models exist, the server has no conversation yet | The ordinary page; under the starters, a tour line unless this device dismissed it. |
| Models exist and conversations exist | The ordinary page, with no guidance. |
| A phone or browser joins a Kiki that is already in use | The same: no card, no tour line. |
| A phone or browser joins a Kiki with no model | The same card; the third lane names the computer running Kiki. |
| The probes have not answered or failed | The composer as usual. A card appearing late is better than a wrong thing flashing; an unreachable server is the connection banner's job. |

The card has three lanes in one card; choosing one expands it in place and folds the other two into "Use another way". Nothing navigates to Settings.

- **Sign in with an account** shows the server's sign-in methods with the device-code flow under the row.
- **Enter an API key** shows service, key and Connect; local services make the key optional; "Another service or a custom address" goes to Settings.
- **Check for a sign-in already on this computer** is a button. The card reads nothing when it appears. Pressing it runs the existing read-only check (the same request as Settings' "check this computer"; it starts no other application and reads out no token) for the sign-ins the server can reuse (Codex, Grok Build, Kimi Code), then states the result: the found account with "Use this sign-in", or 「这台电脑上没有找到可用的登录。」 because the person asked. Only "Use this sign-in" connects, carrying the account that was found, and the connection is refused if the account changed in between.
- A secondary ink line, "Already using Claude Code or Codex? Let it set up Kiki for you", installs the Kiki operations skill into the chosen host only when pressed.
- The language switch in the card's corner starts from the system locale. Appearance is not asked; it follows the system. The page shows only the "kiki." wordmark, no tagline.

| Key copy | zh | en |
| --- | --- | --- |
| Card title | 先连接一个模型，Kiki 才能回答。 | Connect a model so Kiki can answer. |
| Lanes | 用账号登录 / 填写 API 密钥 / 检查这台电脑上已有的登录 | Sign in with an account / Enter an API key / Check for a sign-in already on this computer |
| Third lane from a phone or browser | 检查运行 Kiki 的电脑上已有的登录 | Check for a sign-in already on the computer running Kiki |
| Found / none / failed | 找到了 {app} 的登录：{account} / 这台电脑上没有找到可用的登录。 / 没能检查这台电脑上的登录：{detail} | Found a {app} sign-in: {account} / No usable sign-in was found on this computer. / Couldn't check this computer for sign-ins: {detail} |
| Key rejected | 这个密钥没有通过验证：{detail}。检查是否复制完整，或换一个密钥。 | This key didn't pass the check: {detail}. Make sure it was copied in full, or try another key. |
| Connected (shown once, this visit) | 已连接 {name}，新会话默认用 {model}。 | Connected {name}. New conversations use {model}. |
| Model chip with no model | 未连接模型 | No model connected |

Three things are asked or taught later, at the moment they matter:

1. **Autonomy.** The default stays Auto (the server's default). The first approval card shown in Auto mode carries one line, once per device: 「这是「自动」模式：工作区里的读写和常规命令 Kiki 自己做；像这样的敏感文件、外部链接和危险命令会先问你。」 with 「改成每步询问」 / "Ask at every step" and 「知道了」 / "Got it". "Ask at every step" changes only this conversation; the card then offers 「以后的新会话也这样」 / "Use this for new conversations too" with a Settings link.
2. **Notifications.** When a task first finishes while the person is away and the system permission has not been asked, nothing is requested at that moment. When the person returns, a banner in the connection banner's place asks 「「{title}」在你离开时完成了。以后这种时候要发系统通知吗？」 with 「通知我」 / "Notify me" and 「不用」 / "No thanks". "Notify me" requests the permission inside its click handler (browsers require a gesture); "No thanks" turns off completion notifications only. It is asked once.
3. **The tour.** While the server has no conversation, the new-conversation page shows 「想先看看 Kiki 怎么干活？一分钟导览，不调用模型。」 with "Start the tour" and "No thanks", in the weakest style on the page, even next to the model card. It goes away after "No thanks", a finished tour or the first sent message; later the tour starts from Discover. The "no conversation on the server" condition keeps it away from phones and browsers joining a Kiki already in use. Someone who finished the old wizard counts as having dismissed it.

### Phone forms in conversations

- **Conversation menu** is a bottom sheet in phone mode, in three groups with no keyboard hints: rename, session overview, side question, **Find in this conversation** (opens the existing find bar); compact context, continue with a new context, undo last turn; fork, export archive, effective prompts, terminal (only with the phone opt-in). Leading rows the menu already has (persona links, the Message/Process switch) stay on top as their own group. The desktop dropdown does not change.
- **Approval cards**, on both platforms, show what an edit changes: the diff with a 12-line fold ("Show all {count} lines"); a new-file write shows 「新建文件 · {count} 行」 / "New file · {count} lines" over its first 8 lines. Next to Approve and Reject there is 「说明后拒绝」 / "Reject with a note", which opens one input, 「告诉 Kiki 为什么，或者该怎么做」, and 「拒绝并发送」; it sends `reject` with `feedback`, and an empty note is a plain reject. In the composer's tray the decision row stays pinned to the bottom of the scroll area so Approve and Reject never scroll out of sight. In phone mode, while the tray holds the pending items, the timeline shows one line 「{count} 项等你处理」 / "{count} items need you" with Review instead of one record per item; desktop keeps one record each.
- **Paths keep their file name.** Tool rows, approval titles, tray rows and the right rail render paths from structured `display.path` as a directory part that shrinks and truncates on its left and a file-name part that does not shrink; only a file name that cannot fit is cut in its middle. Approval titles read "{verb} {path}" ("Edit …/workshop/bench.md") instead of the server's English description. The full path is in the details and in the desktop hover title.

### Choosing from a list

Lists that ask the person to pick one or several values had grown four forms: the browser's native `<select>`, a searchable single-value combobox (`SearchableSelect`), a settings-only `SettingsSelect`, and at least four separate model pickers. The decision is one select base for single and multiple selection, which shows search at `LIST_TOOLS_MIN_ITEMS` options and opens as a bottom sheet in phone mode, and one model picker built on it, used wherever a model is chosen. The concurrency rule editor's free-text model field becomes a multi-select on that picker first; every other call site follows without changing any option list, default or saved value.

## What is built

The rules and conventions are in the tree, as listed under [Conventions and fixed wording](#conventions-and-fixed-wording), and every key the redesign added exists in both dictionaries. Beyond that, the following items shipped in the November GUI interaction & mobile pass live on the pass branch (`perf/gui-interaction-mobile-pass`, PR #59) rather than pre-merge `kiki`:

- **Settings frame**: the 20-leaf navigation tree with Recipes as a Models tab (`packages/session-core/src/settings/settings.ts`, `SETTINGS_NAV_TREE`, `AI_SETTINGS_TABS`); Developer & labs with `overview`, `engine` and `identity` tabs (`DEVELOPER_SETTINGS_TABS`) and redirects for moved tabs (`MOVED_SETTINGS_TABS`); the leaf word and the phone index's "Needs attention" group (`apps/kiki-gui/src/components/settings/SettingsNav.tsx`); the list-tool threshold applied by the shared list primitives (`apps/kiki-gui/src/components/settings/list/`).
All GUI paths below are under `apps/kiki-gui/src/`.

- **Sessions and Engine parameters**: the five-card Sessions page (`components/settings/SessionsSection.tsx`) and the Engine parameters tab (`components/settings/EngineParametersSection.tsx`).
- **Agents**: rows with effective values and the attention block (`components/settings/profileEditor/TeamView.tsx`). **Permissions**: the follow-mode wording for risky Bash commands and the plan-mode gate (`components/settings/PermissionsSection.tsx`).
- **First run**: the card and its parts (`components/firstRun/ModelConnectCard.tsx`, `LocalSignInLane.tsx`, `TourLine.tsx`, `ConnectedLine.tsx`), the notification banner (`components/firstRun/NotifyAskBanner.tsx`, with the ask flow in `lib/awayNotify.ts`), and the browser host that requests notification permission only from a click (`host/browser.ts`). The old wizard, its automatic opening and the Discover page's model-connection entry are gone. Behaviour tests live in `components/NewSessionFirstRun.test.tsx`.
- **First-party pages**: Usage opening on History, with the live band, quota wording, queued badge and price count (`components/UsagePage.tsx`, `components/UsageNavigation.tsx`); the concurrency rule editor extracted to `components/usage/ConcurrencyRulesEditor.tsx` (still mounted on the Usage page); the Memory status sentence (`components/MemoryPage.tsx`); Personas, Background tasks, Archived conversations and Discover (`components/persona/PersonasPage.tsx`, `components/TasksPage.tsx`, `components/ArchivedSessionsPage.tsx`, `components/discovery/DiscoveryPage.tsx`); Capabilities opening on Installed (`components/capabilities/CapabilitiesPage.tsx`).
- **Approvals and paths**: the diff and content preview with folds, "Reject with a note" and the once-per-device Auto explanation (`components/Interactions.tsx`, mark `kiki.firstRun.autoExplained`); the two-part path renderer (`components/PathText.tsx`) used in tool rows and approval titles.
- **Sidebar**: running time in words, the running count as a word, the selected-ink filter icon, the desktop "More" submenu, filter, view and row menus as bottom sheets on phones (`components/overlays/ActionSheet.tsx`), and the footer's words-only connection mark (`components/Sidebar.tsx`).
- **Phone mode** itself: `(pointer: coarse) and (max-width: 639px)` (`PHONE_QUERY` in `apps/kiki-gui/src/lib/layoutHooks.ts`, and the `phone:` variant in `apps/kiki-gui/src/index.css`).

## What is not built

Each remaining follow-up item is tracked by an issue with the title given (#3–#58).

- **"Make Settings › Models lead with which connection needs attention"**: the state card and "Needs attention" block, the Recipes tab drawn by `AiSection` itself (the strip lists it on every tab today, but `SettingsPage` still draws that tab on the Models page's behalf), the Concurrency card, "Add connection" as the first-run component, the new purpose sentence (the old one is still in the dictionaries), ink decision-source links, the retryable sign-in-methods failure, and state words on phone rows.
- **"Finish the Agents, Permissions and Sessions settings pages"**: Agents still has two tabs (`AGENTS_SETTINGS_TABS`), no Advanced fold, no built-in sentence, the generic diagnostics and a raw load error; the Permissions Tools card summary; the Auto hint (`st.defaults.permission.autoHint` still holds an older sentence); the archive card's title and the leftover Sessions tab plumbing (`SESSIONS_SETTINGS_TABS`); the unused `apps/kiki-gui/src/components/settings/SessionTitleModelSettings.tsx`.
- **"Trim controls and state status in words on the remaining settings pages"**: General's "Sidebar tools" card is still there; Workspaces, Memory links, Extensions & tools, Search & retrieval, Browser & computer, Hooks and the Notifications permission line are unchanged.
- **"Open the session menu as a grouped bottom sheet on phones, with Find"**: the conversation menu is still a dropdown on phones; also the persona header on phones, `ActionSheet` support for check and radio rows, and "Running" in words on room rows.
- **"Keep approval decisions in view and say pending items once on phones"**: the pinned decision row, the new-file title, the follow-up line after "Ask at every step", the merged phone line, the right rail's file-name-keeping subjects, and deleting the dead `apps/kiki-gui/src/components/agent-panel/InspectorNeedsYou.tsx`.
- **"Remove unused copy keys, stale visual-proof steps and dead UI code"**: well over a hundred unused keys (most of the old `onboarding.*` copy), visual-proof scripts that still drive removed screens, Chinese duration spacing (`time.durationHours` is still 「{h}小时{m}分」) and days-only running rows.
- **"Update the settings guide (en and zh) for the reorganised Settings pages"**: the user guide still describes the old layout.
- **"Build one select base and one model picker, starting with concurrency rules"** and **"Move every model choice and native select in the GUI onto the shared select"**: nothing of the shared select exists yet.
- **"Enlarge the remaining small touch targets in the timeline and composer"**: activity rows, reply links, capability switches and the SSH remove button are still mouse-sized on touch.

## What was never verified

- No real device was used. Every phone observation came from Chromium's phone emulation; iOS Safari, Android WebView and layouts with the soft keyboard open were not seen.
- None of the reorganised settings pages (Agents, Permissions, Sessions, Engine parameters) has been looked at in a screenshot since it was reorganised, and dark theme was not looked at for any of this work.
- The Capabilities page was only seen with three entries; the global task board, detail pages (agent, plugin, workspace, memory entry, Recipe) and the "When to notify" tab of Notifications were not seen, so statements about them rest on the code.
- Settings' read-only, loading and save-failure states were not seen.
- A send with no model, which showed empty quotation marks in an error, was seen only against the fixture server; a real server's behaviour was not checked.

## Open questions

- Developer & labs still shows a row with only the machine name `plugin_import` when an older server reports it. Should `experimentalFlagRows` (`packages/session-core/src/settings/agentSettings.ts`) filter it out as it does `usage_export`, or should it stay as old-server behaviour? It must not get a display name: the code treats it as a shipped capability, and tests assert it has no copy.
- When the first-run component is reused as Models' add panel inside Settings, should its own title line and language switch show there?
- The first-run page shows only the wordmark. Whether it, and the Discover page, should later carry the product's positioning headline is not decided.
