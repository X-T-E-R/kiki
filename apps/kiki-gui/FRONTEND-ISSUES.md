# Kiki GUI 前端问题台账

本文件保存 Kiki GUI 的已审计前端问题，供前端工程师复现、排序和验收。审计基线为提交 `4459515267a0cbb30d44b682a956855c1845d129`；以下条目均为该提交上的未修复观察。文件只记录问题，不授予实现、修改协议或改动服务端的权限。除非出现新的直接证据，不应据此认定 `agent-core` 或 `agent-core-v2` 有缺陷。

## 阅读约定

- **P1**：会丢失用户输入、破坏会话一致性、误导关键操作，或使正常恢复路径卡死。
- **P2**：主要功能可用，但存在明显的正确性、可发现性、可访问性或规模限制。
- **P3**：不会阻断主要流程，但会持续造成歧义或降低验证可信度。
- **事实**只描述代码和协议当前直接表达的行为；**影响判断**是从这些事实推导出的用户后果。
- “期望行为”只定义可观察结果，不指定实现方式；“定向证明”用于修复后的最小验收。

## 索引

| ID | 严重度 | 问题 | 主要风险 |
| --- | --- | --- | --- |
| KG-001 | P2 | WebSocket 订阅未限定主 agent | 子 agent 事件可能进入主会话视图 |
| KG-002 | P1 | 历史分页顺序与前端假设相反 | 旧消息倒序、插入位置和游标错误 |
| KG-003 | P2 | `turn.started.prompt` 被忽略 | 非本页提交的用户输入可能不显示 |
| KG-004 | P1 | 首次快照失败后仍可发送 | 未订阅事件的页面接受新输入 |
| KG-005 | P1 | resync 失败后无自动重试或隔离 | 页面可能长期停留在不可信状态 |
| KG-006 | P1 | 问题回答失败后卡片永久忙碌 | 用户无法重试或取消 |
| KG-007 | P1 | 发送失败会丢失草稿 | 用户输入不可恢复 |
| KG-008 | P2 | 待交互聚合状态过早清零 | view state 与未解决 block 相互矛盾 |
| KG-009 | P1 | abort 的 REST 失败被吞掉 | 页面可能暗示已停止，实际仍在运行 |
| KG-010 | P2 | 会话列表固定为 100 条且无分页 | 较旧会话不可达 |
| KG-011 | P2 | 布局只适配桌面宽屏 | 窄视口下主要区域被挤压 |
| KG-012 | P2 | 键盘焦点、可访问名称和低对比文本不足 | 键盘和低视力用户难以操作 |
| KG-013 | P2 | 会话列表和快照错误缺少可见反馈 | 空白、加载中与失败无法区分 |
| KG-014 | P3 | 模型选择器混合“继承值”和“显式值” | 用户无法判断当前模型来源 |
| KG-015 | P1 | 全局审批快捷键可能操作屏外请求 | `y`/`n` 可能批准了用户未查看的对象 |
| KG-016 | P2 | 工具分组 fixture 与实际事件序列不符 | 视觉证明未覆盖其声称的实时分组路径 |

## 详细条目

### KG-001 · WebSocket 订阅未限定主 agent

- **状态 / 严重度**：未修复 · P2
- **可见故障**：同一 session 存在子 agent 活动时，主会话视图没有明确保证只接收主 agent 的 session/agent 事件。
- **事实**：`KikiSocket.sendSubscribe()` 只发送 `session_ids` 和 `cursors`。协议允许 `subscribe.payload.agent_filter`，并明确说明省略该字段会回退到接收 session 内所有 agent 的旧行为。
- **影响判断**：子 agent 的工具、状态或生命周期事件可能与主 agent 的 transcript 状态混合，造成错误的卡片、busy 状态或任务归属。是否已在每类事件上实际发生，需要用多 agent 会话复现确认。
- **证据**：`apps/kiki-gui/src/lib/ws.ts:262-272`；`packages/protocol/src/ws-control.ts:100-105,151-156`。
- **期望行为**：主会话视图的订阅范围清晰且可验证；默认只呈现主 agent 的事件，除非产品明确提供切换或聚合视图。
- **定向证明**：创建一个主 agent 与至少一个子 agent 同时产生事件的 session，确认主视图只出现允许范围内的事件，并检查实际发出的 `subscribe` frame。

### KG-002 · 历史分页顺序与前端假设相反

- **状态 / 严重度**：未修复 · P1
- **可见故障**：向上加载旧消息时，新增历史可能倒序或插在错误位置；随后继续分页时可能使用错误的 `before_id`。
- **事实**：服务端 `/messages` 先把完整历史反转为 newest-first，再返回分页结果；服务端测试也把这个顺序作为契约。前端 `prependOlderMessages()` 按传入顺序生成 block、整体前插，并把 `messages[0]` 当作最旧消息。fixture server 却返回 oldest-first 的尾部切片，因此现有 fixture 会掩盖生产契约差异。
- **影响判断**：真实服务端返回两条以上旧消息时，前端的阅读顺序和下一页游标都可能错误；fixture 的长 transcript 证明不能排除该问题。
- **证据**：`packages/kap-server/src/services/messages/messageHistory.ts:78-109`；`packages/kap-server/test/messages.test.ts:252-281`；`apps/kiki-gui/src/state/transcript.ts:439-467`；`apps/kiki-gui/scripts/fixture-server.mjs:411-421`。
- **期望行为**：快照、增量分页和最终 transcript 都保持 oldest-to-newest 的阅读顺序，且每次请求的 `before_id` 指向当前最旧的已加载消息。
- **定向证明**：使用真实 `/messages` 契约准备至少 120 条带连续编号的消息，打开快照后连续加载两页；断言 DOM 编号严格递增、无重复或缺失，并核对第二次请求的游标。

### KG-003 · `turn.started.prompt` 被忽略

- **状态 / 严重度**：未修复 · P2
- **可见故障**：由其他客户端、定时任务或恢复流程发起的 turn，可能直接出现 assistant 输出，却没有对应的用户输入。
- **事实**：协议的 `turn.started` payload 包含可选 `prompt`。`applyFrame()` 没有 `turn.started` 分支；当前 fixture 的 `turnStart()` 虽支持 prompt 参数，但所有场景均未传入该参数。
- **影响判断**：当没有本地 `prompt.submitted` 或 REST local echo 补齐用户消息时，turn 的触发文本会从 transcript 中消失。
- **证据**：`packages/protocol/src/events.ts:630-633,1561-1564`；`apps/kiki-gui/src/state/transcript.ts:627-1082`；`apps/kiki-gui/fixtures/helpers.mjs:118-120`；`apps/kiki-gui/fixtures/basic-stream.scenario.mjs:56`。
- **期望行为**：带 `prompt` 的 `turn.started` 在缺少等价用户 block 时显示一次，并与稍后到达的 durable/local-echo 用户消息去重。
- **定向证明**：分别发送“只有 `turn.started.prompt`”和“随后又到 `prompt.submitted`”两组 frame；前者显示一条用户输入，后者仍只显示一条。

### KG-004 · 首次快照失败后仍可发送

- **状态 / 严重度**：未修复 · P1
- **可见故障**：session 长时间显示 `Opening session…`，但 composer 仍可输入并发送；此时页面没有该 session 的事件订阅。
- **事实**：`open()` 在快照成功后才调用 `socket.subscribe()`。`useActiveController()` 吞掉 `open()` 的 rejection，并保留 controller。`App` 无条件向 composer 传入 `disabled={false}`。
- **影响判断**：用户可能在看不到现有 transcript、也收不到后续事件的情况下提交 prompt；提交成功与页面状态会分离。
- **证据**：`apps/kiki-gui/src/state/sessionController.ts:65-75`；`apps/kiki-gui/src/App.tsx:31-53,431-449`；`apps/kiki-gui/src/components/Transcript.tsx:404-412`。
- **期望行为**：首次同步未完成时不能把 composer 呈现为可正常发送；失败状态必须给出明确、可操作的恢复路径。只有建立可用快照和订阅后才进入正常编辑状态。
- **定向证明**：让首次 snapshot 返回可重试错误，确认页面显示失败而不是无限加载、发送不可用；恢复 snapshot 后确认订阅建立且 composer 恢复。

### KG-005 · resync 失败后无自动重试或隔离

- **状态 / 严重度**：未修复 · P1
- **可见故障**：出现 delta gap 或 `resync_required` 后，如果第一次 snapshot 重取失败，`Resyncing…` 会消失，但页面不会自动再次收敛。
- **事实**：`resync()` 的 catch 只清除 `resyncing`，没有重试调度或失败状态。`handleFrame()` 在 resync 期间仍继续把后续 frame 应用到当前 state，没有 quarantine 或 buffer 分支。
- **影响判断**：一次瞬时失败即可让 transcript 长期保持有缺口的状态；继续应用后续 frame 还可能让用户误以为页面已恢复。
- **证据**：`apps/kiki-gui/src/state/sessionController.ts:82-115`；`apps/kiki-gui/src/state/transcript.ts:606-635`；`apps/kiki-gui/src/App.tsx:415-420`。
- **期望行为**：resync 成功前，页面不能把状态当作已恢复；系统应能自主再次尝试，或进入明确的失败/暂停状态并提供恢复动作，同时避免把缺口后的 frame 当作连续历史。
- **定向证明**：制造 delta gap，让第一次 resync snapshot 失败、第二次成功，并在两次请求之间继续发送 frame；断言最终 state 来自成功快照且没有重复、缺失或假恢复。

### KG-006 · 问题回答失败后卡片永久忙碌

- **状态 / 严重度**：未修复 · P1
- **可见故障**：Question card 提交或 dismiss 后会禁用两个按钮；REST 请求失败时卡片保持禁用，页面也不显示错误，用户无法重试。
- **事实**：`QuestionCard` 在操作时把本地 `busy` 设为 `true`，回调签名为 `void`，没有 success/failure/finally 回路。`App` 对 answer/dismiss 的 rejection 使用 `.catch(() => undefined)` 吞掉错误。只有 block outcome 更新后卡片才会被替换。
- **影响判断**：任何网络或服务端错误都会把当前问题卡永久卡在处理中，直到外部事件或整页重载改变状态。
- **证据**：`apps/kiki-gui/src/components/Interactions.tsx:369-426,442-461`；`apps/kiki-gui/src/App.tsx:352-355`；`apps/kiki-gui/src/state/sessionController.ts:234-268`。
- **期望行为**：提交成功后显示已回答状态；失败后恢复按钮、保留选择并显示可重试错误。dismiss 失败也应恢复可操作状态。
- **定向证明**：分别让 answer 和 dismiss 第一次失败、第二次成功；断言第一次后按钮重新可用且选择仍在，第二次后 outcome 正确更新。

### KG-007 · 发送失败会丢失草稿

- **状态 / 严重度**：未修复 · P1
- **可见故障**：发送请求失败后只显示错误消息，刚才输入的 prompt 已从编辑框和 session 草稿存储中删除。
- **事实**：`App.actions.send()` 在等待 `sendPrompt()` 前就清空持久草稿和 React state；catch 只设置 `sendError`。Composer 的 `send()` 还会在调用 `onSend()` 后再次 `onChange('')`。
- **影响判断**：网络失败或服务器拒绝会造成不可恢复的用户输入丢失，长 prompt 的损失尤其严重。
- **证据**：`apps/kiki-gui/src/App.tsx:330-347`；`apps/kiki-gui/src/components/Composer.tsx:81-87`。
- **期望行为**：只有服务器接受提交后才移除草稿；失败时编辑框和持久草稿保留原文，用户可修改后重试。
- **定向证明**：输入唯一长文本并让 submit 第一次失败；断言 UI 与重新加载后的 session 草稿仍为原文。第二次成功后再断言草稿被清空。

### KG-008 · 待交互聚合状态过早清零

- **状态 / 严重度**：未修复 · P2
- **可见故障**：同一 session 同时存在多个待审批/待回答请求时，解决任意一个请求后，`SessionViewState.pendingInteraction` 会变成 `none`，但 state 中仍有未解决的交互 block。
- **事实**：审批 resolved、问题 answered/dismissed 的 frame 分支都无条件写入 `pendingInteraction: 'none'`。本地 REST 成功路径 `markApprovalResolved()` 和 `markQuestionOutcome()` 也同样清零；代码已另有按 block 计算的 pending count，但没有用它重算聚合状态。
- **影响判断**：当前 header 的数量来自 block 计数，因此不一定立即显示错误；但 controller 的聚合状态已不可信，任何依赖该字段的 UI、恢复或后续逻辑都可能漏报剩余人工请求。
- **证据**：`apps/kiki-gui/src/state/transcript.ts:998-1053,1109-1139,1161-1167`；`apps/kiki-gui/src/App.tsx:69-89`。
- **期望行为**：每次解决单个请求后，聚合状态根据所有未解决 block 或权威 session 状态重算；只在没有任何待交互时变为 `none`。
- **定向证明**：构造“两项审批”“审批 + 问题”两种 state，依次解决其中一项；断言 `pendingInteraction` 与剩余 block 一致，全部解决后才变为 `none`。

### KG-009 · abort 的 REST 失败被吞掉

- **状态 / 严重度**：未修复 · P1
- **可见故障**：用户点击停止或按 Escape 后，如果可靠的 REST abort 失败，界面没有失败提示，也没有重试动作。
- **事实**：controller 先发送 fire-and-forget WebSocket abort，再调用注释标为“reliable path”的 REST abort；REST rejection 被 catch 后直接忽略。`App` 的 abort action 也丢弃 promise。
- **影响判断**：WebSocket frame 未送达且 REST 又失败时，后台 prompt 可能继续运行，而用户得不到任何确认或警告。
- **证据**：`apps/kiki-gui/src/state/sessionController.ts:193-203`；`apps/kiki-gui/src/App.tsx:272-289,349`。
- **期望行为**：只有收到权威确认或终止事件后才显示已停止；可靠路径失败时明确提示当前 turn 可能仍在运行，并允许再次尝试或刷新状态。
- **定向证明**：断开 WebSocket 发送能力并让 REST abort 失败，确认 UI 不会静默宣告成功且提供恢复；再让重试成功，确认状态由服务端事件收敛。

### KG-010 · 会话列表固定为 100 条且无分页

- **状态 / 严重度**：未修复 · P2
- **可见故障**：账号有超过 100 个活跃或含归档 session 时，侧栏只显示首批结果，没有“加载更多”或其他入口访问余下会话。
- **事实**：Sidebar 和 App 都固定调用 `listSessions({ page_size: 100 })`，不读取 `has_more`，也不传 `before_id`/`after_id`。REST client 已支持这些 cursor 参数。
- **影响判断**：排序较后的 session 在 GUI 中不可达；App 合并 active session record 的轮询也只覆盖首批 100 条。
- **证据**：`apps/kiki-gui/src/components/Sidebar.tsx:69-79,153-225`；`apps/kiki-gui/src/App.tsx:237-256`；`apps/kiki-gui/src/lib/client.ts:152-163`。
- **期望行为**：用户能从 GUI 到达全部符合筛选条件的 session，分页过程中不重复、不跳项，并保留 active/archived 筛选语义。
- **定向证明**：准备至少 125 个按 `updated_at` 排序的 session，连续加载到末页；断言 125 个 ID 各出现一次，`has_more=false` 后停止请求。

### KG-011 · 布局只适配桌面宽屏

- **状态 / 严重度**：未修复 · P2
- **可见故障**：窄视口下固定侧栏和右栏继续占用 564px，再叠加 transcript 内边距与 composer 控件，主内容区被严重压缩。
- **事实**：App 始终使用横向三栏 flex；Sidebar 固定 `w-[264px] shrink-0`，RightRail 固定 `w-[300px] shrink-0`。样式中唯一 media query 是 `prefers-reduced-motion`，没有 viewport breakpoint。
- **影响判断**：平板、手机、窄窗口和分屏模式下会出现难读、难点或溢出的主要操作区域。
- **证据**：`apps/kiki-gui/src/App.tsx:360-368,454-457`；`apps/kiki-gui/src/components/Sidebar.tsx:107-108`；`apps/kiki-gui/src/components/RightRail.tsx:151`；`apps/kiki-gui/src/index.css:144-154`。
- **期望行为**：常见窄视口仍能独立访问 session、transcript、composer 和待交互卡片；辅助栏不应挤掉主要任务区。
- **定向证明**：在 320、768 和 1024 CSS px 宽度分别完成选 session、读 transcript、发送 prompt、回答问题和打开右栏；检查无水平页面溢出且主要控件可见可点。

### KG-012 · 键盘焦点、可访问名称和低对比文本不足

- **状态 / 严重度**：未修复 · P2
- **可见故障**：键盘用户难以判断当前焦点；图标按钮对辅助技术的名称不稳定；大量 `text-ink-faint` 小字在浅背景上对比不足。
- **事实**：源码中没有 `focus-visible` 样式。Composer 的 send/abort 图标按钮只有 `title`，没有 `aria-label` 或可见文本。调色板中 `ink-faint` 为 `#a39a8b`，在 `paper #f7f3ec` 和 `panel #fffdf8` 上按 WCAG 相对亮度公式计算的对比度分别约为 2.51:1 和 2.74:1；该颜色被用于 10–12px 的说明和状态文本。
- **影响判断**：键盘导航、屏幕阅读器识别和低视力阅读都会受到影响；具体合规范围还需对完整页面做语义树和交互审计。
- **证据**：`apps/kiki-gui/src/index.css:8-23,42-60`；`apps/kiki-gui/src/components/Composer.tsx:169-207,211-213`；`apps/kiki-gui/src/components/Sidebar.tsx:153-162,189-214`。
- **期望行为**：所有交互控件都有明确的可访问名称和可见键盘焦点；正常字号文本在实际背景上达到适用对比要求；纯状态变化能被辅助技术理解。
- **定向证明**：仅用键盘遍历 connect、session list、composer、approval/question 和菜单；检查焦点顺序与可见性。再用浏览器 accessibility tree 核对 icon button 名称，并对实际字号/背景运行对比检查。

### KG-013 · 会话列表和快照错误缺少可见反馈

- **状态 / 严重度**：未修复 · P2
- **可见故障**：会话列表请求失败时侧栏可能只剩空白；快照失败时主区域持续显示 `Opening session…`，两处都没有错误原因或重试入口。
- **事实**：Sidebar 只在 `sessions.length === 0 && sessionsQuery.isSuccess` 时显示空状态，也只渲染 mutation 的 `actionError`，未渲染 `sessionsQuery.error`。`useActiveController()` 的 snapshot catch 为空，Transcript 只根据 `loaded` 显示固定加载文本。
- **影响判断**：用户无法区分“没有 session”“仍在加载”“鉴权/网络错误”和“服务端失败”，也不知道应该等待还是采取动作。
- **证据**：`apps/kiki-gui/src/components/Sidebar.tsx:69-79,153-163`；`apps/kiki-gui/src/App.tsx:41-47`；`apps/kiki-gui/src/components/Transcript.tsx:404-412`。
- **期望行为**：列表和快照各自区分 loading、empty、error、success；错误状态提供简洁原因和可执行的重试/重新连接动作。
- **定向证明**：分别让 session list 与 snapshot 返回网络错误、未授权和可重试服务错误；确认状态文案与动作正确，成功重试后旧错误消失。

### KG-014 · 模型选择器混合“继承值”和“显式值”

- **状态 / 严重度**：未修复 · P3
- **可见故障**：用户选择 `server default` 后，select 仍会显示解析后的具体模型；界面无法说明该模型来自本次 override、session 绑定还是 server 默认值。
- **事实**：select 的 `value` 是 `model ?? defaultModel ?? serverDefaultModel`，但空 option 的标签是 `server default`；选择空 option 只把 `modelOverride` 清为 `undefined`，随后 `value` 又回到 session/server 的具体模型 ID。
- **影响判断**：用户可能把继承值误认为显式固定值，或误以为已经恢复 server default，而 session 实际仍绑定另一个模型。
- **证据**：`apps/kiki-gui/src/components/Composer.tsx:44-48,96,131-150`；`apps/kiki-gui/src/App.tsx:243-249,308-329,436-443`。
- **期望行为**：选择器清楚区分“继承 server 默认”“使用 session 绑定”和“本次 prompt override”，同时显示最终生效模型。
- **定向证明**：覆盖 session 无模型、session 有模型、用户设置 override、用户清除 override 四种状态；断言来源标签与提交 payload 均符合当前选择。

### KG-015 · 全局审批快捷键可能操作屏外请求

- **状态 / 严重度**：未修复 · P1
- **可见故障**：当 transcript 有多个待审批卡片时，用户在查看后面的卡片按 `y` 或 `n`，实际被处理的是 block 列表中的第一个待审批请求，可能已经滚出视口。
- **事实**：全局 keydown handler 用 `.find()` 选择第一个 unresolved approval，不检查焦点、viewport、选中卡片或最近交互对象。每张 ApprovalCard 都显示相同的 `y`/`n` 提示。
- **影响判断**：快捷键可能批准或拒绝用户没有正在查看的操作；对写文件、运行命令等审批，这是高风险误操作。
- **证据**：`apps/kiki-gui/src/App.tsx:258-303`；`apps/kiki-gui/src/components/Interactions.tsx:217-238`。
- **期望行为**：快捷键的目标必须明确、可见且与用户当前上下文一致；存在歧义时不应执行审批。
- **定向证明**：创建两个内容可区分的待审批请求，把第一个滚出视口并聚焦第二个；按 `y`/`n` 后断言只处理明确指向的对象，无法确定目标时不发送请求。

### KG-016 · 工具分组 fixture 与实际事件序列不符

- **状态 / 严重度**：未修复 · P2
- **可见故障**：fixture 注释和视觉脚本声称实时 Read + Edit + Bash 会折叠为 `Steps · 3`，但 approval block 插在 Edit 与 Bash 之间，按生产分组规则会打断连续工具序列。
- **事实**：`groupBlocks()` 遇到任何非 tool block 都 flush 当前分组。tool-pipeline fixture 在 live Edit 后发出 `event.approval.requested`，再等待处理，之后才发 Bash。视觉脚本在发送 prompt 前等待的 `Steps · 3` 来自 snapshot 中的历史工具链；发送后只截图，没有再次断言 live 三工具分组。
- **影响判断**：现有截图能证明历史 snapshot 的分组，却不能证明 fixture 注释所声称的实时三工具分组；approval 邻接行为也没有被准确覆盖。
- **证据**：`apps/kiki-gui/src/state/grouping.ts:21-44`；`apps/kiki-gui/fixtures/tool-pipeline.scenario.mjs:75-125`；`apps/kiki-gui/scripts/visual-proof.mjs:138-158`。
- **期望行为**：fixture 描述、事件序列和断言必须一致；若要证明三工具连续分组，测试序列中不能插入会打断分组的 block。若 approval 本就应打断，则证明应明确验证该边界。
- **定向证明**：从空 transcript 运行 live 场景，在每个关键 frame 后断言 display node 序列；分别覆盖连续三 tool 和 tool/approval/tool 两种路径，不复用 snapshot 中已有的 `Steps · 3` 作为 live 证明。
