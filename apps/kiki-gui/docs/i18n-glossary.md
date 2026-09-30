# zh / en i18n glossary

Term pairings for `packages/session-core/src/i18n/en.ts` and `zh.ts` — the single
dictionary that `apps/kiki-gui` and `apps/kimi-code` both render through. Read it
before writing new copy or translating a batch; read
[`settings-conventions.md`](./settings-conventions.md) §4 for the surrounding
copy rules.

Counts in the notes are the number of dictionary keys whose value contains the
term on `kiki` @ `27682d04de` (5372 keys per locale). When two translations
compete the majority form wins unless a note says otherwise.

## Terms

| 中文 | English | 说明 · 不要用的译法 |
| --- | --- | --- |
| 会话 | session | 持久单元：归档、worktree、权限、标题都挂在会话上（zh 286 / en 275）。en 不要用 chat、dialog 指 session；zh 不要用「对话」指 session。 |
| 对话 | conversation | 会话里看得见的聊天内容，以及「当前打开的那个对话」（zh 26 / en 31）。临时会话 = a temporary conversation / 临时对话。`preview.addToChat` 的 "Add to chat" 与 `menu.addToConversation` 同义：统一 conversation，不要 chat（en 仅 5 处）。 |
| 线程 | thread | 同一会话里并发的一条对话线（`tc.sem.thread.*`、`threadRef.*`，zh 24 / en 23）。zh 统一「线程」，不要留 `Thread` 不译（`st.profiles.mainOnHint` 1 处）；en 句中小写 thread。 |
| 智能体 | agent | zh 335 处用「智能体」，40 处直接把 `Agent` 留在中文句子里 — 统一「智能体」。不要「代理」（3）、不要「子代理」。产品名 `AgentRun` 保留原样。en 句中小写 agent，只有句首或独立标签的首词大写。 |
| 子智能体 | subagent | 一个词 `subagent`，不是 sub-agent（0）。zh 现有 6 处「子 Agent」（`capabilityReason.*`）要改回「子智能体」。树形从属关系可说 child agents（"Show child agents" / 展开子智能体），指同一件事。 |
| 派发 / 派生 | dispatch / spawn | dispatch = 派发（15；不要「分派」6），spawn = 派生（`subagent.event.spawned` 派生）。 |
| 角色 | persona | 「谁」在和你说话：名字、头像、头衔、语气、长期规则。en persona（单 1 / 复 personas）。不要译「人设」（0）；`composer.agentProfileTitle` 遗留的「人格」1 处改回「角色」。角色卡 = persona card（导入/导出的对象）。**该表面尚未落到 `kiki` 主干，随 `kiki-bot` 分支引入。** |
| 智能体档案 | agent profile | 「怎么干活」：模型、思考强度、工具、权限、指令——和 persona 是两件事，别都译成「角色」。zh 现有三种写法：档案 15 / 配置档 14 / 配置目录 2。首选「智能体档案」（composer 与 `profile.switch*` 面向用户的那一侧用词），诊断类文案里的「配置档」「配置目录」逐步归一。 |
| 房间 | room | 2–6 个参与讨论的房间：成员 member、主持人 host、静音 mute（`room.*`）。en room / zh 房间；不要用「群」指 room（「群」只出现在通知的团队群聊文案里），也不要写「会话」。**随 `kiki-bot` 分支引入主干。** |
| 工作区 | workspace | zh 143 / en 143，一个被登记的项目目录。不要用「空间」指工作区；worktree 是工作区里的检出目录，不等于工作区。 |
| 空间 | space | Kiki 空间：有自己的对话、记忆和工作区（`st.section.spaces`、`st.purpose.spaces`，zh 69 / en 70）。大写 Space 只指这个产品概念；`st.compact.reserveHint` 里的「保留的空间」是字面余量，en 用 room/space、小写。 |
| 技能 | skill | 来自 skills 目录的能力包（zh 83 / en 89），`agentPanel.*Skill*`、`st.skills.*`。不要译成「工具」。 |
| 插件 | plugin | 安装并启用的扩展（zh 72 / en 78）；插件里的 skill 仍叫「技能」。 |
| 工具 | tool | 智能体调用的工具（zh 131 / en 138）。工具调用 = tool call：注意 `subagent.tools` 的 en 是 "{count} tools"、zh 是「{count} 次工具调用」，改文案时把量词对齐。 |
| 任务看板 | task board | `taskBoard.*`（zh 41 / en 12）。zh 统一「任务看板」，`taskBoard.title` 的「需求与任务看板」要归一；en 现有 'Task Board' 是遗留 Title Case，新文案写 'Task board'。卡片 card（22）、需求 requirement（9，`taskBoard.newTask` = "New Requirement" / 新建需求）。 |
| 定时任务 | scheduled task(s) | `cron.panel.*`（zh 19 / en 13）。「计划任务」不用（0）；`cron` 只作为 key 前缀和内部标识，不出现在面向用户的文案里。 |
| 记忆 | memory | 跨会话记住的偏好与事实（zh 48 / en 56），一条叫 entry / 条目（24）。不要用「内存」。 |
| 审批 / 批准 | approval / approve | 功能与动作用「审批」（29）：Approve for me = 替我审批，Reviewer = 审查者；状态与结果用「批准」（45）：Awaiting approval = 待批准，Approval required = 需人工审批。不要写「确认授权」（`agentPanel.approvalNotice` 1 处），也不要把「授权」当 approval 用（7 处另有含义：OAuth、通知授权）；「放行」只属于 Full access 这一模式名（`composer.perm.yolo`）。 |
| 压缩 | compaction | 上下文压缩（zh 59 / en compaction 25）。不要用「精简」「汇总」（0）。陷阱：`st.skin.densityCompact` 的 'Compact' 是界面密度，与压缩无关。 |
| 外部引擎 | external engine | Kiki 驱动的第三方编码智能体，复用其本机登录或 API key（`st.engines.*`，zh 8 / en 8）。不要用 backend、adapter；「模型引擎」指 Kiki 自己的 model engine，是另一件事。 |
| 提示词 | prompt | 你写或发送的文本：初始提示词 initial prompt、执行提示词 execution prompt、提示词字段 Prompt fields（zh 27 / en 73）。不要用「指令」或「说明」译 prompt。 |
| 指令 | instructions | 智能体的常驻指令正文：`st.agentManager.instructions` 指令，`st.agentManager.prompt` = "Instructions (prompt body)" / 指令正文（en 25 / zh 12）。不要用「说明」译 instructions（`st.profiles.teamIntro` 1 处），也不要和 prompt 互换。 |
| 上下文 | context | 上下文窗口 context window；重建上下文 rebuild context（`persona.rebuild`）（zh 72）。 |
| 提示 / 帮助 | hint / help | `*.hint`、`*.help` 是设置卡里的帮助文本：一句话说清「做什么 + 默认值」，优先级、环境变量、内部细节放 AdvancedDetails，zh 不留英文。 |
| worktree | worktree | zh 保留原词不译（`st.worktrees.title` 两边都是 'Worktrees'，36 个 key 提到它）。分支 = branch，检出目录 = checkout。 |
| MCP 服务器 | MCP server | 保留 MCP 不译（`st.plugins.contrib.mcp`）。 |

## English style

- **Sentence case.** Only the first word and proper nouns are capitalized. Do not
  Title Case labels. 33 of 5372 en values are legacy Title Case, 29 of them under
  `taskBoard.*` and `agentPanel.*` ('Task Details', 'Subagent Details', 'Initial
  Agent Prompt (Optional)') — write sentence case in new strings and normalize
  these when you touch them.
- **No marketing tone.** No seamless, powerful, effortlessly, simply. State what
  happens, in one sentence.
- **Buttons say the result** ("Add rule", "Remove worktree"), never Submit / OK.
- **Errors say what failed and how to recover**; a server message arrives as
  `{detail}`.
- Machine values stay in `font-mono` and stay English (verbs, flags, ids, paths).

## Chinese style

- 中英文、中文与数字之间加一个空格：`复用 Claude Code CLI 的登录状态`、`选 2–6 个角色`。
- 界面里的专名和引用用「」：`「替我审批」模式下`、`已保存「{name}」`；用户输入或参数值用 “”：`没有匹配“{query}”的结果。`
- 全角标点：，。；：——不要用半角逗号句号。
- 文案不留英文单词（产品名、`AgentRun`、worktree、API key、MCP 这类约定保留的除外）。

## Dictionary rules

- `en.ts` is the source of truth for the key set; `zh.ts` is `Partial` and falls
  back to English per key. Add both locales together.
- `{placeholders}` must match one-for-one between locales; `i18n.test.ts` fails on
  any mismatch. Never rename, translate, or drop a placeholder, and never reuse a
  count for a different noun.
- Wire values (status enums, tool names, model ids, server messages) stay English
  in both locales; only display chrome lives in the dictionary.
- `.one` / `.other` pairs drive `tp()`; Chinese uses the same string in both.

## Known inconsistencies

Found on `kiki` @ `27682d04de`; the first two are fixed in the same branch as
this document, the rest are queued for whenever their surface is next touched.

| Where | Problem | Disposition |
| --- | --- | --- |
| `find.*` (14 keys) | en values are the key itself (`'find.aria': 'find.aria'`, `'find.earlier': 'find.earlier {count}'`); zh is translated | fixed — English written per this glossary |
| `st.worktrees.cleanupRule` | zh dropped `{days}`, so the zh sentence never names the threshold | fixed — `{days}` restored in zh |
| 40 zh keys still show `Agent`, 6 show `子 Agent`, 1 shows `Thread`, `message.subagents` (kiki-bot) shows `子代理` | one term, four spellings | normalize to 智能体 / 子智能体 / 线程 |
| zh "agent profile": 档案 15, 配置档 14, 配置目录 2 | three spellings of one term | prefer 智能体档案 |
| `st.sessions.messagingTitle`, `st.communication.threadCommunication`, `st.purpose.sessions` | zh says 传话 | use 消息 / 通信 |
| `preview.addToChat` ("Add to chat") | en chat vs conversation | conversation |
| `taskBoard.*`, `agentPanel.*` (29 values) | Title Case labels | sentence case |
| 80 keys where en and zh are identical | mostly identifiers, units and placeholders (`st.pack.size`, `cap.origin.zip`, `modeSegmentSeparator`), which is correct | spot-check only |

## Auditing the dictionaries

Node 24 runs the dictionaries directly (they are plain objects). Key parity and
placeholder parity:

```sh
node --input-type=module -e "
const { en } = await import('./packages/session-core/src/i18n/en.ts');
const { zh } = await import('./packages/session-core/src/i18n/zh.ts');
const zhOnly = Object.keys(zh).filter((k) => !(k in en));
const enOnly = Object.keys(en).filter((k) => !(k in zh));
const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const bad = Object.keys(en).filter((k) => zh[k] !== undefined && ph(zh[k]) !== ph(en[k]));
console.log({ zhOnly: zhOnly.length, enOnly: enOnly.length, placeholderMismatches: bad });
"
```

The same invariants are enforced by `packages/session-core/src/i18n/i18n.test.ts`
(`pnpm vitest run packages/session-core/src/i18n/i18n.test.ts`).
