---
title: Spaces, computers, devices and pairing
description: The vocabulary and model for where a window is, what it can open and who can come in, the phased plan that follows from it, and how much of it is built.
outline: [2, 3]
---

# Spaces, computers, devices and pairing

This record fixes how the GUI talks about where work lives, what a window can open, and who may come in. It covers the sidebar's space switcher, the connection settings, pairing between spaces, and the phone launcher's directions, across `apps/kiki-gui`, `apps/kiki-gui/mobile`, `packages/protocol`, `packages/klient` and `packages/kap-server`. The general GUI rules it applies are in [GUI interface rules](./2026-11-ui-rules.md).

## The problem

In the code, "several spaces" and "connecting to another Kiki" are two halves of one thing. The server has a single unit: a Kiki home, which is one data directory served by one kap-server process with one identity (`homeId` + `hostId`, `packages/protocol/src/rest/connections.ts`). A space on this computer is another home registered in the main home's `homes.json`; a "remote Kiki" is a home on another machine. The interface presented them as two systems with their own nouns and entry points, because four separate pieces of work (the first single-server connection page, multiple local spaces, external clients and web access, then pairing codes, phone pairing and peer tunnels) each brought their own words and none went back to unify the earlier ones.

What people met as a result:

- **What was shown did not match what was read.** Inside a space on another computer, the settings band showed the internal key `remote:<uuid>`; "Connected server" showed this device's own address and offered to restart this device's server; owner-only pages kept their "Add" buttons although the broker refuses those operations (`Operation is not available to a remote space`, `packages/klient/src/transports/http/connections.ts`); and the Spaces page asked this device's server for the settings of a space called `remote:<uuid>`, which the server's `main | h-…` parameter rejects.
- **Different failures looked like one.** The broker route packed every admission error into envelope code 40101, and the GUI read 40101 as "this space needs an access token". A closed gate on the other side, a paused pairing, a changed identity, a local space that had not started and a broken SSH channel all showed a full-page "needs an access token" form whose value the remote branch never used.
- **Things happened that nobody chose.** Pressing "Pairing code" switched the inbound gate on for good and started listening on the local network and Tailscale (`createPairCode` sets `state.enabled = true` in `packages/kap-server/src/services/connections/admission.ts`), and the dialog did not say so. Pairing also set up thread messages every time, while the same page said thread-message permission was granted separately.
- **One task had two mechanisms.** "Connect to a remote Kiki" existed twice: an SSH alias plus a typed owner token at the bottom of Settings › Workspaces (the window switches to the other server with owner rights), and pairing under "Access from elsewhere" (a peer credential through the broker with limited rights). Both called the result "remote Kiki". "Kikis I connect to" sat on the page about who may connect *to* this Kiki, and the switcher's "Manage spaces…" led to a page where the remote entries were not listed.
- **Too many words.** One home was called space, Kiki, remote Kiki, other Kiki, this Kiki, home, server; one machine was 本机, computer, machine, SSH host, host; entering was switch, switch over, open in a new window. In a phone browser, 「本机」 meant the computer running the server, not the phone.

## The model

### What the code already has

These are the pieces the model is built from. None of them changes in the first three phases.

| Piece | What it is | Where its state lives |
| --- | --- | --- |
| Home | One Kiki data directory and its server process, identity `{ homeId, hostId, protocol }` | That machine's disk |
| Space | A home registered in the main home's `homes.json`; the main home's own id is `main` (`packages/protocol/src/rest/space.ts`, `apps/kiki-gui/src/lib/spaces.ts`) | The list is per computer; only the main space's server writes it |
| Outbound pairing record | This home's pointer to another home: label, endpoint, target identity, `purposes ⊆ {gui, bridge}`, transport, state, background summary (`packages/protocol/src/rest/connections.ts`) | The current home's `server/outbound-connections.json` and connection secrets |
| Space on another computer | An enabled outbound record with `gui`, entered as scope `remote:<connectionId>`; every read and write goes through the current home's broker, limited to `CONNECTION_OPERATIONS` (`packages/protocol/src/rest/connection-operations.ts`) | As above |
| Inbound gate, grants and pairing codes | Who may connect to the current home; the gate is off by default; a code is 8 characters, ten minutes, single use | The current home's server |
| Thread bridge | A one-way thread-message permission between two homes: source and target scopes, `operations ⊆ {read, send, wait, wake}`, expiry (`packages/protocol/src/rest/thread-bridge.ts`) | The current home's `server/thread-bridges.json` |
| Web access | A one-time link exchanged for a browser cookie, plus the list of outbound spaces such a browser may switch to | The current home's `server/web-access.json` |
| Owner (SSH) profile | A desktop-saved SSH alias; connecting tunnels to the other server and asks for its owner token (scope `ssh:<id>`) | Per device; the token is not saved |
| Navigation scope | A window's internal "where am I": `local`, `direct:<url>`, `ssh:<profile>`, `remote:<connection>` (`apps/kiki-gui/src/lib/navScopeConnection.ts`) | Per window |

Two facts matter most. First, outbound records, inbound grants and thread bridges are stored **per home**, not per computer: switching from the main space to another local space switches to that space's list of what it can open. Second, a device has six ways to reach another Kiki (a typed address and token, a desktop SSH profile, a pairing code, an SSH pairing, a web-access link, the phone app's pairing), and only two of them appeared in the switcher.

### Four words

The interface uses four words, and only these, to say where a person is, where they can go and who can come in.

| zh | en | What it is | Whose |
| --- | --- | --- | --- |
| 空间 | Space | A place for work: conversations, memory, workspaces, settings, credentials. One home. It has a name and a colour. | It belongs to its computer; its settings are its own |
| 电脑 | Computer | The machine a space lives on. Only a name and a grouping; it has no management page of its own. In the desktop app, for the machine running the server, the name is 「这台电脑」 / "This computer"; otherwise the machine's name. | — |
| 设备 | Device | What a person looks at a space with: this desktop window, a browser, a phone. | The one in hand |
| 配对 | Pairing (verb: pair) | Permission one space gives another space or a device. There are two permissions: **open** (browse and chat) and **thread messages** (read, send, wait, and wake when granted). | Stored in the space that gives it |

"Kiki" is not a countable noun in UI copy ("remote Kiki", "other Kiki", "this Kiki" go away), and home, host, owner, inbound, outbound, invitation, identity string, bridge and scope do not appear in regular UI. 「主空间」 / "Main space" stays as the name of each computer's default space and is shown like any other name.

What is stored where follows from this. **Per device**: which computer this device connects to (address and credential, or a web cookie), which space each window is in, the window mode, the last page per space, the appearance cache, the phone app's saved computers, request timeouts. **Per computer**: which spaces exist on it. **Per space**: everything else, including appearance, configuration, credential scope, which other spaces it can open, who can open it, thread-message permissions and web access. Storage stays per space; the interface says whose list it is ("openable from “{space}”") instead of moving it.

How existing concepts map:

| Today | Becomes | Handling |
| --- | --- | --- |
| home, Kiki as a countable noun, remote Kiki, other Kiki, this Kiki | space | Renamed in the UI; internal ids unchanged |
| subspace | space | "Subspace" is not a UI word |
| 本机, machine, server, host, "Kiki on an SSH host" | computer | One word |
| `remote:` scope | a space on another computer | Folded into spaces |
| outbound record / inbound grant | a pairing (what I can open / who can open this) | Data kept, renamed |
| purposes `gui` / `bridge` | the two permissions on a pairing | Merged |
| thread bridge | the "thread messages" permission | Not a noun any more; shown on the pairing row and revocable on its own |
| invitation, identity string | — | Moved under Advanced as "Manual identity exchange"; the CLI keeps them |
| server connection | this device's connection | Renamed; still the diagnostics page |
| desktop SSH profile with a typed token | a pairing way: "Owner (SSH)" | Moved into the same list; not retired |
| web-access browser sessions, phone app pairings | devices | Listed together (phones need a stored kind, see [Open questions](#open-questions)) |
| external clients, SSH hosts, rooms, thread communication | unchanged | External clients stay on Access; SSH hosts are where agents execute, not spaces; rooms and thread communication live inside one space |

## Decisions

### Position bar

The sidebar head becomes a two-line bar, 44 px high, in the place of today's switcher button; the whole bar opens the switch panel.

```text
┌─────────────────────────────────────────────┐
│ kiki.  ● Main space                      ⌄  │
│        This computer                     ②  │
└─────────────────────────────────────────────┘
```

Line 1 is the wordmark, the space's colour dot, the space name (the main space included) and a chevron; the name truncates and carries the full name as `title`. Line 2 is the computer name and, when there is one to say, the state; at its right end, the count of items needing the person in other spaces. The "remote" tag goes away: that a space is on another computer is said by line 2. The connection state is said once, here, and the sidebar footer's connection mark is removed.

| Situation | zh | en |
| --- | --- | --- |
| Desktop app, a space on this computer, connected | 这台电脑 | This computer |
| Browser or phone, connected | {电脑名} | {computer} |
| A space on another computer, connected | {电脑名} · 已连接 | {computer} · Connected |
| Reconnecting to the current space | {电脑名} · 正在重连… | {computer} · Reconnecting… |
| Disconnected and not retrying | {电脑名} · 已断开 | {computer} · Disconnected |
| Opening another space | 正在打开 {空间名}… | Opening {space}… |
| Computer name unknown | state only | state only |

Names come from three sources and nowhere else: the space list (`GET /homes`), the pairing record's `label`, and the authorized handshake's `targetLabel` (the machine name, `GET /api/remote-connections/handshake`). No `homeId`, `remote:` key or UUID is ever shown in place of a name; when no name is known, the UI says "another space" or shows only the state. On a phone, a window that is not in the space its device connects to directly shows a second small line under the page title: 「在 {空间名}」 / "In {space}".

### Switch panel

The menu becomes a switch panel: a 320 px popover under the bar on desktop, a bottom sheet on phones (at most 70% of the screen, content scrolling, the two bottom entries fixed).

```text
Switch space
────────────────────────────────────────
This computer
 ● Main space                         ✓ Current
 ● ACME confidential    Running · 2 waiting
 ● Thesis writing                 Not started
Other computers · openable from “Main space”
 ◍ Workstation B
   gpu-box · Connected · 3 working · 2 waiting on you
 ◍ Home desktop
   home-desktop · Offline · as of 9 minutes ago
────────────────────────────────────────
＋ Pair a space on another computer…
   Manage spaces and pairings…
```

The first group's title is the computer name. The second group's title, 「其他电脑 · 从「{当前本机空间}」可以打开」 / "Other computers · openable from “{space}”", says which local space owns the list. Each row's second line is always computer name · state · counts; addresses stay in Settings. Desktop keeps the numbered shortcut hints. In the phone app, a last entry 「切换电脑…」 / "Switch computer…" leads to the launcher.

These state words are the only ones used for spaces anywhere:

| State | zh | en | Applies to |
| --- | --- | --- | --- |
| current | 当前 | Current | all |
| running | 运行中 | Running | spaces on this computer |
| not started | 未启动 | Not started | spaces on this computer |
| connected | 已连接 | Connected | other computers |
| offline | 离线 · 截至 {时间} | Offline · as of {time} | other computers |
| waiting | 等对方批准 | Waiting for approval | other computers |
| closed | 对方已关闭接入 | Access is closed on that side | other computers |
| re-pair | 需要重新配对 | Needs pairing again | other computers |
| changed | 那个地址现在是另一个空间 | That address is now a different space | other computers |
| paused | 已停用 | Paused | other computers, Settings only |

| Panel situation | What it shows |
| --- | --- |
| Loading | Two placeholder rows and 「正在读取空间…」 / "Loading spaces…" |
| Only the main space, no pairings | The main space, then 「把某个项目的对话、记忆和工作区分开存放。」 / "Keep a project’s conversations, memory and workspaces apart.", then "New space…" and "Pair a space on another computer…" |
| Browser or phone | The computer's spaces, all but the current one disabled, under 「其他空间只能在那台电脑的桌面应用里打开。」 / "Other spaces open only in the desktop app on that computer."; no "New space…" |
| A web session allowed no other spaces | No second group |
| A list fails to load | 「读不到这份列表。」 / "Couldn’t read this list." with Retry in that group's place |
| In a space on another computer | First row of group 1: 「← 回到 {本机空间名}」 / "← Back to {space}" |

A tapped row shows 「正在打开…」 / "Opening…" while the other rows are disabled and the panel stays open. On success the panel closes and the window enters that space. On failure **the window stays where it was** (route, open conversation and draft unchanged) and the row shows the reason and one action. There is no full-page takeover and no toast.

| Reason | zh | en | Action |
| --- | --- | --- | --- |
| Network unreachable (also any unknown reason) | 连不上。那台电脑可能关机了，或不在同一个网络。 | Can’t reach it. That computer may be off or on another network. | Retry |
| `inbound_disabled` | 对方关闭了“允许其他空间连接”。等对方重新打开后再试。 | Access is closed on that side. Try again once it is reopened. | Retry |
| `connection_not_approved`, 401 | 对方不再接受这次配对。 | That side no longer accepts this pairing. | Pair again… |
| `identity_changed` | 那个地址现在是另一个空间，已停止连接。 | That address now answers as a different space. Nothing was opened. | Remove… |
| `connection_paused` | 这条配对已停用。 | This pairing is paused. | Turn on |
| A space on this computer failed to start | 没能启动 {名称}。 | Couldn’t start {name}. | Retry · View log… |
| Incompatible protocol | 对方的版本太旧或太新，无法打开。 | That side’s version can’t be opened from here. | — |

The broker's error code stays 40101 for all of these; the GUI tells the reasons apart by the reason string the server sends, and unknown strings fall back to "can't reach it". Changing the server's codes is separate work and is not required.

### Full-page recovery and dropped connections

The full-page recovery (`NavScopeRecovery`) is kept for two cases only: the space to restore at start-up cannot be entered, and browser Back lands on a page of a space that cannot be entered. It shows a title with the reason above, Retry, and 「回到 {本机空间名}」 / "Back to {space}". The access-token field appears only when the target really takes a typed token, which means hand-entered addresses and owner (SSH) profiles; a paired space, a web-access cookie session and the phone app's paired connection never show it. When a typed token is accepted it is the token used from then on, including after the reload a cross-scope return performs, and it replaces a saved token for that address. Both exits are pressed by the person; the page never leaves by itself.

When the current space's connection drops, line 2 of the bar says it is reconnecting, and the top banner names the space when it is not the device's own: 「与 {空间名} 的连接中断，正在重连… ［立即重连］」 / "Lost connection to {space}. Reconnecting… [Reconnect now]"; for the device's own server the existing 「连接中断 — 正在重连…」 stays. After repeated failures it says 「仍然连不上 {空间名}，会继续重试。［立即重试］［回到 {空间名}］」 / "Still can’t reach {space}. Retrying. [Retry now] [Back to {space}]". Reconnection only targets the space the person is in, never switches spaces, keeps drafts and open conversations, and re-sends nothing while disconnected.

### Settings: Spaces & devices

The group 「连接与远程」 / "Connection & remote" becomes 「空间与设备」 / "Spaces & devices", with four pages. Page addresses do not change (`/settings/spaces`, `/settings/connection-services`, `/settings/connection`), the `?tab=` ids `web`, `kiki` and `clients` keep working, and the old names stay findable in settings search.

| Page | Answers | Content |
| --- | --- | --- |
| 空间 / Spaces | Where can I go | Spaces on this computer; spaces on other computers; (in a non-main space) accounts and keys, follow or pin; at the bottom, 「本设备」 / "This device": window mode |
| 接入 / Access | Who can come in | Tabs: 设备 / Devices (browsers and phones) · 其他空间 / Other spaces · 外部客户端 / External clients |
| 本设备的连接 / This device's connection | Is it working | Today's diagnostics, shown as segments |
| SSH 主机 / SSH hosts | Where agents execute | Unchanged |

**Spaces.** Two sections, 「这台电脑上的空间」 and 「其他电脑上的空间 · 从「{空间名}」可以打开」. The verb is 「切换」 / "Switch" everywhere. A paired row has three lines: name; computer, address, state and last contact; and the facts read from the record and its thread-message permission, 「可打开 / 不可打开」 / "Can be opened / Can't be opened" and 「线程消息：双向 / 仅发出 / 仅接收 / 无」 / "Thread messages: both ways / outgoing only / incoming only / none". When the thread-message permission cannot be read, the row says 「线程消息：读不到」 / "Thread messages: can't read", never "none". Its menu holds Retry, Turn off / Turn on, 「线程消息…」 / "Thread messages…" (scope, operations in words, expiry, and turning off or revoking that one permission without removing the pairing) and "Remove pairing…". Owner (SSH) profiles appear in the same section labelled 「所有者（SSH）」 / "Owner (SSH)" with 「连接…」 / "Connect…", which still asks for the token. In a browser or on a phone, spaces on this computer are listed read-only, with no "New space" and no "Add existing space…", and only the other spaces the owner allows this browser to open are shown. Opened while the window is in a space on another computer, the page starts with 「这里显示的是 {本机空间名} 的空间与配对。」 / "These are the spaces and pairings of {space}." and reads only this device's own space.

**Access.** Devices holds web access, the signed-in browsers and 「允许这些设备打开的其他空间」 (today's browser-switchable list, renamed). Other spaces holds the master switch 「允许其他空间连接」 / "Allow other spaces to connect", the "Pairing code" button, and the list of grants (name, computer, 「已允许 / 等对方使用配对码 / 已撤销」, the same open and thread-message facts, last connection, a menu with "Thread messages…" and "Revoke…"), followed by 「要打开的其他空间在“空间”页管理。」 with a link. This space's identity is one copyable row under 「高级 → 手动交换身份」 / "Advanced → Manual identity exchange", never raw JSON.

**This device's connection** lists one segment per hop, so it is always clear which link is described:

```text
This device → Workstation A (this computer)   ● Connected   http://127.0.0.1:58627   [Reconnect now] [Edit]
Workstation A → Workstation B            ● Connected   b.example.test · 1 minute ago        [Retry]
```

A space on this computer has only the first segment; a space on another computer adds a second whose name and state come from the pairing record, the same name the bar shows. The restart row names its target, 「重启这台电脑上的 Kiki 服务」 / "Restart the Kiki service on this computer", and appears only when the desktop app manages that service.

**Settings inside a space on another computer** show only pages that can work: this device's pages (General, the device parts of Appearance, Shortcuts, Notifications) and the Spaces & devices group. Every other page, including by deep link, is one sentence: 「{空间名} 的设置要在它所在的电脑上改。」 / "{space}’s settings are changed on its own computer." Controls the broker would refuse are not rendered as editable. The band on every page reads 「当前：{空间名}（{电脑名}）」 / "Current: {space} ({computer})", falling back to 「当前：{空间名}」 and then 「当前：另一个空间」.

### Pairing: one sheet

Pairing is one sheet with two directions, opened from three places: the switch panel's "Pair a space on another computer…" and the Spaces page's "Pair…" open "open another space"; Access › Other spaces › "Pairing code" opens "let another space or device open this one". It is a side panel on desktop and a full-height sheet on phones.

```text
Pair a space on another computer
On the other computer, open Settings → Access → Other spaces → Pairing code.

Way        [Pairing code] [SSH]       (SSH only in the desktop app with saved SSH hosts)
Address    http://192.168.1.20:58627
Code       XXXX-XXXX
Name       (optional; empty uses the other computer's name)
☐ Also ask for thread messages      Let this space's agents message that space's threads and wait for replies.
☑ Show its working and waiting counts in the switch panel      Reads two numbers only, never its threads.
                                                         [Cancel] [Pair]
```

The fixed zh copy is 「配对另一台电脑上的空间」, 「在对方的电脑上打开：设置 → 接入 → 其他空间 → 配对码。」, 「名称（可选，留空用对方电脑的名字）」, 「同时请求线程消息 — 让这个空间的智能体给对方的线程发消息并等待回复。」 and 「在切换面板里显示它的进行中与待处理数量 — 只取两个数字，不加载对方的任何线程。」. The thread-message box is shown only for the pairing-code way, because the SSH way cannot decline today and a box that cannot take effect is not shown. A successful pairing closes the sheet, adds the row and shows 「已配对 {名称}。［切换］」 / "Paired {name}. [Switch]"; **the window stays in its current space**. Failures read 「配对码不对，或已经过期。」, 「连不上这个地址。」, 「对方没有打开“允许其他空间连接”。」 and, when someone claims their own code, 「这个地址就是当前这个空间。」.

The other direction starts with a screen that says what will be allowed and what generating the code switches on, before any request is sent:

```text
Pairing code
After pairing with this code, the other side can:
☑ Open this space (browse and chat)
☐ Message this space's threads, and start a model run here

Generating a code turns on “Allow other spaces to connect” and lets this computer
accept pairing on the local network and Tailscale until you turn that switch off.
                                        [Cancel] [Turn on and generate code]
```

The zh copy is 「对方用配对码配对后可以：」, 「打开这个空间（浏览与对话）」, 「给这个空间的线程发消息，并在这里发起一轮模型运行」, 「生成配对码会打开“允许其他空间连接”，并让这台电脑在局域网和 Tailscale 上接受配对，直到你关掉这个开关。」 and 「［取消］［打开并生成配对码］」. "Open this space" is checked and cannot be unchecked, because every pairing grants it. When the gate is already on, the paragraph is absent and the button reads 「生成配对码」 / "Generate code". After generating, the sheet shows today's code, QR code, countdown, addresses and "New code"; when the code is used it says 「{名称} 已配对。」, and when it expires 「这个配对码已过期。［换一个码］」.

Removing and revoking say exactly what changes: 「移除后，这个空间不能再打开 {名称}，保存的凭据会被删除。不会关掉对方，也不改对方的设置。」 and 「{名称} 正在进行的连接会中断，以后也不能再打开这里。不影响其他配对。」. Pairing codes stay the one regular way to pair.

### Phone

The phone app's launcher keeps its tabs (Connect, Computers, Network) and the word "computer", which already fit the model; only its directions change, to 「在电脑上打开 设置 → 接入 → 其他空间 → 配对码。」 / "On your computer, open Settings → Access → Other spaces → Pairing code." In the app, the bar sits at the top of the drawer and the switch panel rises from the bottom. A phone browser's connect screen does not offer to find Kiki on this device when the page was not served from this device, and shows errors in plain words with the raw text under "Details".

### The three rules, applied

- **Do not switch or connect by yourself.** A successful pairing does not switch. A dropped connection does not switch. Start-up restores only a space it can verify, and otherwise waits on the recovery page. Automatic reconnection only targets the space the person is in; the only background read of other spaces is the counts the person left ticked when pairing. Generating a pairing code no longer switches the gate on silently, and pairing no longer adds thread messages silently: both are said first and chosen by the person.
- **What is read and what is shown never differ quietly.** Names come only from the three sources above. Each settings block says whose state it shows and changes. Failures are shown by their own reason. Counts for offline spaces carry "as of {time}".
- **What the person did not do is not shown as done.** Showing a pairing code is not pairing: the list gains a row only when the other side uses the code. A switch shows its effective state, not just the saved value. A permission line states a read fact, and "can't read" is not "none".

## Decided against, and why

| Not done | Why |
| --- | --- |
| Merge every space's conversations into one sidebar | Spaces exist to keep work apart, and each scope keeps its own caches, drafts and reading positions. |
| Cloud accounts or a relay | Kiki promises not to route through someone else's server. |
| Several addresses per pairing with automatic route choice | It introduces the system changing routes by itself, which needs its own decision; each pairing has one address. |
| Fine-grained permissions | Open and thread messages cover what exists. |
| Entering other spaces on the same computer from a browser or phone | Each space is a separate server process with its own gate; it would need the main space to relay, which is a different feature. |
| Unifying "thread" and "conversation" in this work | It reaches rooms, the activity page, the CLI and the docs; only the permission is named "thread messages" here. |
| A "run on which computer" picker or load balancing | The model is: switch to that space, then start a conversation. |
| Designing the native Android app's screens | They were not looked at. |
| Changing rooms or thread communication | They live inside one space and showed no problem of where or whom. |

## Data, protocol and phases

Every phase leaves a usable product and can ship alone. No `localStorage` key changes, and `homes.json`, outbound records, inbound grants and `thread-bridges.json` are untouched in the first three phases.

| Phase | Scope | Storage | Protocol |
| --- | --- | --- | --- |
| 1 · Say the truth | No internal ids in the settings band, pairing source line or grant details; per-reason failures for paired spaces with no token field; the launcher's directions; the phone browser's connect screen; the main space's name on the switcher; the corrected thread-message note | Unchanged | Unchanged |
| 2 · One place | Position bar and switch panel; failures in the row; Spaces & devices settings; settings limited to what works in a space on another computer; no "New space" in browsers and on phones | Unchanged | Unchanged |
| 3 · One pairing flow | The pairing sheet; the gate explanation; opt-in thread messages; thread-message facts and per-permission revoke on rows | Unchanged | The outbound pairing request (`POST /api/remote-connections/pair`) gains an optional `requestBridge`, forwarded to the other side's existing `pair/claim` field; absent means requested, as before. Generating a code already accepts `allowBridge` and `bridgeOperations` |
| 4 · Data changes | Paired phones as devices; renaming a pairing | Optional `kind` on incoming grants; a persisted label change | Both additive; records without `kind` show as spaces |

Two points correct the premise the plan was first written on. A pairing's default thread-message operations are `read`, `send` and `wait`, without `wake` (`DEFAULT_PAIR_BRIDGE_OPERATIONS` in `packages/kap-server/src/services/connections/admission.ts`); without `wake`, a bridged message stays pending instead of starting a turn (`packages/kap-server/src/services/threadBridge/bridge.ts`). The user docs (`docs/en/features/spaces.md` and its zh mirror) still say pairing includes `wake` and need correcting. And the machine running the server is 「这台电脑」 in the desktop app, never 「本机」, as the glossary in `apps/kiki-gui/docs/i18n-glossary.md` requires.

Changing the GUI's default for thread messages ends "pair, and agents can already message each other" for GUI pairings. `kiki pair` keeps today's default (requested and allowed), and the docs and CLI notes must say so.

## What is built

Phase 1 is built except for one item:

- Paired-space failures map the broker's reason strings to their own reasons (`apps/kiki-gui/src/lib/navScopeConnection.ts`; `ScopeRestoreFailure` in `apps/kiki-gui/src/lib/navScope.ts`), and the recovery page shows each with its own title and action and no token field (`apps/kiki-gui/src/components/NavScopeRecovery.tsx`, copy under `nav.scope.failed.remote-*`).
- The settings band names a paired space from its record and otherwise says 「当前：另一个空间」 (`SpaceBand` in `apps/kiki-gui/src/components/SettingsPage.tsx`); the switcher falls back to 「另一个空间」 instead of an internal key (`apps/kiki-gui/src/components/SpaceSwitcher.tsx`).
- The Access page's note now says that pairing with a code also allows thread messages (read, send, wait) when both sides have a workspace, and that the list does not show them yet (`st.inbound.bridgeNote`).
- The launcher's directions name the path that exists today, "Settings → Access from elsewhere → Other Kiki → Pairing code" (`apps/kiki-gui/mobile/launcher/launcher.js`, `index.html`).
- In a browser, the connect screen offers to find a local Kiki only when the page was served from this device, and it shows errors in plain words with the raw text under "Details" (`apps/kiki-gui/src/components/ConnectScreen.tsx`).
- The glossary rule for 「这台电脑」 / 「运行 Kiki 的电脑」 is in `apps/kiki-gui/docs/i18n-glossary.md`.

Not built from phase 1: the main space still shows no name on the switcher (`shownName` is `null` in the main space); that moves into the position bar work.

## What is not built

Each item is tracked by an issue with the title given.

- **"Use the typed access token when returning to a hand-entered address"**: the token typed on the recovery page is ignored for `direct:` scopes and the field is also offered to web-cookie and phone-app connections.
- **"Replace the sidebar space button with a two-line position bar"**: the bar, the shared name hook, the phone "In {space}" line, the banner naming the space, and removing the footer mark.
- **"Turn the space menu into a switch panel that reports failures in the row"**: the panel, the bottom sheet, in-row failures, and dropping "New space…" in browsers.
- **"Merge the connection settings into a "Spaces & devices" group"**: the group is still "Connection & remote" (`st.group.connection`), outbound rows still sit under Access from elsewhere, the owner (SSH) form is still on Settings › Workspaces, and the Spaces page still requests a `remote:` space's settings.
- **"Show which space each settings page acts on when in another computer's space"**: the segmented connection page, the visibility rule and the band with the computer name.
- **"Let an outbound pairing say whether it asks for thread messages"**: `connectionPairInputSchema` has no `requestBridge`, and `pairOutbound` sends `requestBridge: true` (`packages/kap-server/src/services/connections/pairing.ts`).
- **"Show each pairing's thread-message permission and let it be revoked alone"**: no GUI file uses the thread-bridge API yet, although klient has it (`rest.threadBridges`).
- **"Make pairing one sheet that says what it allows before it happens"**: the code dialog still generates a code on mount with `createPairCode({})` (`apps/kiki-gui/src/components/settings/remote/InviteSourceDialog.tsx`).
- **"Update the spaces docs and phone launcher to the new settings names"**, which also removes the `wake` claim from the feature docs and adds the four words to the glossary.
- **"List paired phones as devices and allow renaming a pairing"**, which waits for the rulings below.

## What was never verified

- No two real Kikis were paired for this design. Every "other computer" was a browser-level stand-in answering with the shapes the route code defines; `apps/kiki-gui/scripts/remote-broker-chat.mjs` was not run.
- The real desktop shell, the "one window per space" mode and the desktop SSH profile's connect flow were only read in code. Check the window-mode control in that mode when the settings move.
- The native Android app's screens were not seen, and the launcher's Computers and Network tabs were only read in source.
- That switching to another local space changes the list of other computers is inferred from where records are stored; that phones appear in the inbound list is inferred from the shells calling the same `pair/claim` that writes grants.
- That "Restart server" inside a space on another computer restarts this device's server, and that "Add" on Models fails there, were read from the code, not pressed.
- The English interface was only read in the dictionaries, not seen.
- The GUI has never rendered real thread-bridge status data; look at a real pairing's scope fields before fixing how the other side's workspace is worded.

## Open questions

- **Wake on the pairing sheet.** The sheet's checkbox says the other side can "start a model run here", but the pairing default grants `read`, `send` and `wait` without `wake`. Either ticking the box grants `wake`, or the clause leaves the copy. This must be answered before the pairing sheet merges.
- **The SSH way and thread messages.** Should SSH pairing also be able to decline thread messages? It would need `requestBridge` on the SSH connect input, which today always asks (`packages/kap-server/src/services/connections/manager.ts`).
- **Paired phones as devices** (not ruled on). The recommendation is an optional `kind: 'space' | 'device'` on `pair/claim` and on grants, with phones sending `device` only to servers that advertise support through the handshake, so Access › Devices can list "Paired phones".
- **Renaming a pairing** (not ruled on). The recommendation is `PUT /api/remote-connections/:connectionId/label`, mirroring the enable route, since today a name can only be set while pairing.
- **Retiring owner (SSH) profiles** (not ruled on). They move into the Spaces page and stay. The recommendation is to retire them only once SSH pairing is shown to cover the owner case, and then to give each saved profile a "Use pairing (SSH) instead…" action the person runs one by one, never a silent conversion: the two hold different credentials with different rights.
- **Reconnect threshold.** How many failed attempts turn the banner into "Still can’t reach {space}" is not fixed; the socket's retry diagnostic exposes the attempt count.
- **One name per pairing record.** A record stores one `label`, so a space on another computer cannot show both a space name and a machine name. Keeping the machine name (`targetLabel`, already returned by `pair/claim`) would need a stored field.
