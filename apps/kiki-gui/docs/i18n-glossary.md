# zh / en i18n glossary

Term pairings for `packages/session-core/src/i18n/en.ts` and `zh.ts` — the single
dictionary that `apps/kiki-gui` and `apps/kimi-code` both render through. Read it
before writing new copy or translating a batch; read
[`settings-conventions.md`](./settings-conventions.md) §4 for the surrounding
copy rules.

## Terms

| 中文 | English | 说明 · 不要用的译法 |
| --- | --- | --- |
| 会话 | session | 持久单元：归档、worktree、权限、标题都挂在会话上。en 不要用 chat、dialog 指 session；zh 不要用「对话」指 session。 |
| 对话 | conversation | 会话里看得见的聊天内容，以及「当前打开的那个对话」。临时会话 = a temporary conversation / 临时对话。统一 conversation，不要 chat。 |
| 线程 | thread | 同一会话里并发的一条对话线（`tc.sem.thread.*`、`threadRef.*`）。zh 统一「线程」，不要留 `Thread` 不译；en 句中小写 thread。 |
| 智能体 | agent | 统一「智能体」，不要「代理」或「子代理」。产品名 `AgentRun` 保留原样。en 句中小写 agent，只有句首或独立标签的首词大写。 |
| 子智能体 | subagent | 一个词 `subagent`，不是 sub-agent。树形从属关系可说 child agents（"Show child agents" / 展开子智能体），指同一件事。 |
| 派发 / 派生 | dispatch / spawn | dispatch = 派发，spawn = 派生。 |
| 角色 | persona | 「谁」在和你说话：名字、头像、头衔、语气、长期规则。不要译「人设」或「人格」；角色卡 = persona card（导入/导出的对象）。 |
| 智能体档案 | agent profile | 「怎么干活」：模型、思考强度、工具、权限、指令——和 persona 是两件事，别都译成「角色」。首选「智能体档案」（composer 与 `profile.switch*` 面向用户的那一侧用词），诊断类文案里的「配置档」「配置目录」逐步归一。 |
| 房间 | room | 2–6 个参与讨论的房间：成员 member、主持人 host、静音 mute（`room.*`）。不要用「群」指 room（「群」只出现在通知的团队群聊文案里），也不要写「会话」。 |
| 工作区 | workspace | 一个被登记的项目目录。不要用「空间」指工作区；worktree 是工作区里的检出目录，不等于工作区。 |
| 空间 | space | Kiki 空间：有自己的对话、记忆和工作区（`st.section.spaces`、`st.purpose.spaces`）。大写 Space 只指这个产品概念；`st.compact.reserveHint` 里的「保留的空间」是字面余量，en 用 room/space、小写。 |
| 技能 | skill | 来自 skills 目录的能力包（`agentPanel.*Skill*`、`st.skills.*`）。不要译成「工具」。 |
| 插件 | plugin | 安装并启用的扩展；插件里的 skill 仍叫「技能」。 |
| 工具 | tool | 智能体调用的工具。工具调用 = tool call：注意 `subagent.tools` 的 en 是 "{count} tools"、zh 是「{count} 次工具调用」，改文案时把量词对齐。 |
| 任务看板 | task board | `taskBoard.*`。zh 统一「任务看板」，`taskBoard.title` 的「需求与任务看板」要归一；en 新文案写 'Task board'。卡片 card、需求 requirement。 |
| 定时任务 | scheduled task(s) | `cron.panel.*`。「计划任务」不用；`cron` 只作为 key 前缀和内部标识，不出现在面向用户的文案里。 |
| 记忆 | memory | 跨会话记住的偏好与事实，一条叫 entry / 条目。不要用「内存」。 |
| 审批 / 批准 | approval / approve | 功能与动作用「审批」：Approve for me = 替我审批，Reviewer = 审查者；状态与结果用「批准」：Awaiting approval = 待批准，Approval required = 需人工审批。不要写「确认授权」；「授权」是 authorization 的用词（工作区已授权、OAuth、通知端点授权、插件声明不授权）；「放行」只属于 Full access 这一模式名（`composer.perm.yolo`）。 |
| 压缩 | compaction | 上下文压缩。不要用「精简」「汇总」。陷阱：`st.skin.densityCompact` 的 'Compact' 是界面密度，与压缩无关。 |
| 外部引擎 | external engine | Kiki 驱动的第三方编码智能体，复用其本机登录或 API key（`st.engines.*`）。不要用 backend、adapter；「模型引擎」指 Kiki 自己的 model engine，是另一件事。 |
| 提示词 | prompt | 你写或发送的文本：初始提示词 initial prompt、执行提示词 execution prompt、提示词字段 Prompt fields。不要用「指令」或「说明」译 prompt。 |
| 指令 | instructions | 智能体的常驻指令正文：`st.agentManager.instructions` 指令，`st.agentManager.prompt` = "Instructions (prompt body)" / 指令正文。不要用「说明」译 instructions，也不要和 prompt 互换。 |
| 上下文 | context | 上下文窗口 context window；重建上下文 rebuild context（`persona.rebuild`）。 |
| 提示 / 帮助 | hint / help | `*.hint`、`*.help` 是设置卡里的帮助文本：一句话说清「做什么 + 默认值」，优先级、环境变量、内部细节放 AdvancedDetails，zh 不留英文。 |
| worktree | worktree | zh 保留原词不译（`st.worktrees.title` 两边都是 'Worktrees'）。分支 = branch，检出目录 = checkout。 |
| MCP 服务器 | MCP server | 保留 MCP 不译（`st.plugins.contrib.mcp`）。 |
| 复刻 | fork | 从一个会话或一条消息复制出新会话（`menu.fork`、`transcript.fork`）。统一「复刻」，不要「分叉」。 |
| 导览 | tour | 首次启动后唯一的引导形式：可选的一分钟导览（`firstRun.tour.*`、`discovery.hub.*`）。「引导」「向导」不作为产品词。 |
| 连接 / 模型连接 | connection / model connection | 设置和首次启动里用户面对的对象：一个账号登录或一个 API 密钥（`st.ai.status.*`、`firstRun.*`）。「提供商」只指厂商本身。分区名「模型与提供商 / Models & providers」随设置改版改为「模型 / Models」。 |
| 这台电脑 / 运行 Kiki 的电脑 | this computer / the computer running Kiki | 「这台电脑」只在桌面应用里、且确指运行服务器的那台机器时用。手机或浏览器接入另一台电脑上的 Kiki 时，一律写「运行 Kiki 的电脑」（`firstRun.lane.localRemote*`、`memory.status.on`）。不要写「本机」「本地」指服务器所在的机器：在手机上有歧义。 |
| 默认（{value}） | Default ({value}) | 凡显示「默认」，必须带上它解析到的值（`common.defaultWithValue`）；解析不出时写「默认（未知）」（`common.defaultUnknown`）。不要只写「默认」。 |
| 自动（权限模式） | Auto | 标准解释句：「工作区里的读写和常规命令 Kiki 自己做；敏感文件、外部链接和危险命令先问你。」/ "Kiki handles reads, writes and routine commands in the workspace itself, and asks you before sensitive files, external links or risky commands." 权限页、第一张审批卡（`firstRun.auto.explain`）、输入框芯片的说明都用这一句；`composer.perm.autoHint` 是它的短形。 |

## State words

One word per state, shared by rows, state cards and the sidebar. Colour only
reinforces the word. 「未检测」「未知」「0」「默认」 are four different things;
never show one in place of another.

| 中文 | English | 用于 |
| --- | --- | --- |
| 已连接 | Connected | 连接可用 |
| 就绪 | Ready | 工具、服务可用 |
| 缺少密钥 | Missing key | 有连接，没有凭据 |
| 未登录 | Not signed in | 账号类连接 |
| 未检测 | Not checked | 还没去看过，不等于「没有」 |
| 未知 | Unknown | 读过，但读不出 |
| 不可用 | Unavailable | 读到了，确实用不了 |
| 正在{动作}… | {Doing}… | 进行中，带上对象（「正在检查…」） |
| 已失败 / 已停止 | Failed / Stopped | 结果；不用红色 |
| 需要处理 | Needs attention | 设置和列表里的问题汇总（`st.nav.needsAttention`） |
| 等你处理 / 待批准 / 待回答 | Needs you / Awaiting approval / Awaiting answer | 只给需要用户决定的事 |

## English style

- **Sentence case.** Only the first word and proper nouns are capitalized. Do not
  Title Case labels. Some `taskBoard.*` and `agentPanel.*` values are still
  legacy Title Case ('Task Details', 'Subagent Details', 'Initial Agent Prompt
  (Optional)') — write sentence case in new strings and normalize these when
  you touch them.
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

One term with several spellings, or one key with the wrong language. Each is
listed with what to change it to; fix them when you next touch that surface
rather than in a separate sweep.

| Where | Problem | Change to |
| --- | --- | --- |
| zh values still containing a bare `Agent` | 统一用「智能体」 | 智能体 |
| zh values using 「子 Agent」 | 一词 subagent | 子智能体 |
| zh values containing a bare `Thread` | zh 统一「线程」 | 线程 |
| `preview.addToChat` ("Add to chat") | en chat vs conversation | conversation |
| `taskBoard.*`, `agentPanel.*` | Title Case labels | sentence case |

Already fixed, listed so new copy doesn't bring them back: 「分叉」 for fork
(`transcript.fork`, `transcript.forkTitle`, `harness.cap.fork`,
`action.forkDoneSession` now say 复刻); 「传话」 (`st.sessions.messagingTitle` now
says 智能体之间的消息; no zh value says 传话 any more); bare `Agent` in
`st.purpose.permissions`, `st.purpose.browserControl`, `st.browser.emptyBody`.

Where zh has several renderings of one term (agent profile: 档案 / 配置档 /
配置目录), use 智能体档案 and leave the diagnostic strings to be normalized
alongside the diagnostics themselves.

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
