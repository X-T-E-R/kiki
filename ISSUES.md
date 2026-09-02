# Kiki 问题清单（活文档）

来源：2026-08-14 五路并发审计（GUI 前端 / 后端链路 / agent-core-v2 / 跨包集成 / CLI+漂移治理），
合并一份外部 AI 审计文档；冲突以本地审计取证为准（裁决记录见文末）。
维护人：主协调 agent。修复批次的 agent 不得直接编辑本文件；批次合入后由协调者更新状态。

状态图例：`fixing(X)` = 修复批次 X 进行中；`fixed(X)` = 已随批次 X 合入；`backlog` = 已登记未排期；
`decided` = 已裁决（不改 / 待产品决策 / 上游处理）。

> **合入状态（2026-08-14）**：Batch A/B/C/D1/D2/E/F 七个分支已全部合入 `kiki`，集成校验通过
> （GUI 30 文件/383 测试全绿 + typecheck；agent-core / agent-core-v2 / kap-server typecheck 全绿）。
> 各表项的 `fixed` 即代表已随对应批次合入。批次实施过程中新增的跟进项见文末「Follow-ups」。

## Batch A — GUI 会话/composer 交互（fix/gui-composer-ux）

| ID | 级别 | 问题 | 证据 |
|----|------|------|------|
| A1 | P1 | 拼错/未知 slash 命令静默作为 prompt 发送给模型，无"命令不存在"反馈 | Composer.tsx:354-371; slashCommands.ts:107-117 |
| A2 | P1 | composer per-session 状态只持久化文本：附件与权限/模型 pill 切会话即丢，与"草稿持久化"承诺矛盾 | SessionView.tsx:969-972,845-870,316-322; drafts.ts:49-60 |
| A3 | P2 | 图片连续粘贴 stale-closure 竞态静默丢图；读取期间无 loading 占位、可提前发送漏图 | Composer.tsx:308-339 |
| A4 | P2 | effort/thinking 本地镜像遮蔽 server 值（GUI 恒携带自己的值）；/new 与会话页本地默认 effort 行为不一致 | SessionView.tsx:861-863,1105-1107,1195; NewSessionDraft.tsx:63,98-101 |
| A5 | P2 | 默认模型三源并存且本地镜像优先，"改了不生效、两处不同值" | NewSessionDraft.tsx:88; SettingsPage.tsx:390 |
| A6 | P2 | "需要重启"徽章直接 kill 全部运行中会话且无确认（多数字段其实热生效）；浏览器端"确认"永久清除重启提醒 | SettingsPage.tsx:1055-1076; RestartBanner.tsx:71-80; lib.rs:149-181 |
| A7 | P2 | 多卡可见且无焦点时 y/n 快捷键静默无响应，提示与行为脱节 | Transcript.tsx:894-899,962; SessionView.tsx:587-594 |
| A8 | P2 | /new 页 cwd 无校验自由文本，placeholder 硬编码 Windows 路径；桌面端未用原生目录选择 | NewSessionDraft.tsx:118-122,239-246 |
| A9 | P3 | 连接/设置页硬编码英文与原始枚举残留（"URL:"/"WebSocket: open"/连接 pill title） | SettingsPage.tsx:602,605,923; Sidebar.tsx:216 |
| A10 | P3 | DesktopSettings.desktopNotifications 未解析未读取的死字段 | settings.ts:15 |

## Batch B — GUI 连接/WS/终端交互（fix/gui-connection-ux）

| ID | 级别 | 问题 | 证据 |
|----|------|------|------|
| B1 | P1 | 浏览器模式 Ctrl+N / Ctrl+Tab 为浏览器保留键，preventDefault 无效，快捷键面板却照样宣传 | App.tsx:141-165,211-223; ShortcutsOverlay.tsx:41-48; connection.tsx:1-15 |
| B2 | P1 | 断线横幅纯静态：无"立即重连"动作；WS 单独断开时发送"成功但无响应"迷惑窗口（composer 不感知 wsStatus） | App.tsx:254-258; SessionView.tsx:1561-1566; client.ts:388; ws.ts:601-611 |
| B3 | P2 | WS 收 fatal 帧后 manuallyClosed=true 永不自动恢复，界面无重连按钮 | ws.ts:458 |
| B4 | P2 | 隐藏期间入站帧缓冲无上限（quarantine 反而有 1000 帧/2MB 上限），恢复显示一次性 drain 冻结 | sessionController.ts:103-104,190 |
| B5 | P2 | terminal close 先删本地 tab 再吞 REST close 失败；网络失败时服务端 PTY 复活 | terminalManager.ts:249 |
| B6 | P2 | Ctrl+Tab 全局跳转无输入框编辑守卫（编辑中按组合键丢焦点跳会话） | App.tsx:211 |
| B7 | P3 | Esc 多重语义（终端面板开着时 Esc 先关面板而非停 turn）快捷键面板未分层说明 | SessionView.tsx:947-966,1127-1130; ShortcutsOverlay.tsx:59 |

## Batch C — 桌面壳启动与 CSP（fix/desktop-startup）

| ID | 级别 | 问题 | 证据 |
|----|------|------|------|
| C1 | P0 | 后端子进程死亡不被检测：秒退场景也钉满 120s 才报错（dad4275 只放宽了超时，治标） | lib.rs:111-131,97,32; start.ts:320-342(重活 await 在 listen 前) |
| C2 | P1 | stderr 整体被吞 + 后端默认日志级别 silent：失败后零日志零退出码，错误文案不可操作 | lib.rs:94-97; apps/kimi-code/src/cli/sub/web/shared.ts:22 |
| C3 | P1 | 桌面启动失败界面渲染浏览器模式的 URL/token 表单（端口随机分配根本填不了），唯一有效动作（重试 spawn）藏在"检测本地服务器"后 | connection.tsx:100-127; ConnectScreen.tsx |
| C4 | P2 | BackendManager 互斥锁从 spawn 前持到 ready 轮询结束，重启/二次连接最长阻塞 120s；锁内应只做 slot 状态更新 | lib.rs:66-131,148,510,559 |
| C5 | P2 | 桌面冷启动最长 120s 仅一行"正在连接…"，无阶段进度、无取消 | lib.rs:32; connection.tsx:90,279-291; ConnectScreen.tsx:78 |
| C6 | P2 | 桌面 CSP 只允许 loopback，与远程连接表单、provider /models fetch 两个现有入口冲突，用户只见 Failed to fetch | tauri.conf.json:26; ConnectScreen.tsx:86; ProviderFields.tsx:379; settings.ts:666 |
| C7 | P3 | deep-link token 仅在 /meta 成功后清除，连接失败时留在地址栏 | connection.tsx:145 |

## Batch D1 — 服务端集成健壮性（fix/server-delegation-robustness）

| ID | 级别 | 问题 | 证据 |
|----|------|------|------|
| D1-1 | P0 | WS 无应用层心跳：半开连接假在线（客户端已前向兼容，缺服务端 heartbeat_ms 广播 + ping） | wsConnectionV1.ts:17; ws.ts:185-190,401-409; docs/server-heartbeat.md |
| D1-2 | P0 | 委派失败原因三层脱敏（safeExternalFailure → redactedMessage → safeRemoteMessage），token 过期/quota/模型不支持/断网对用户全是黑盒 | externalDelegationService.ts:560-579,97; routes/v2/externalDelegation.ts:180-187; mcp/server.ts:264-267 |
| D1-3 | P1 | MCP edge 输入校验错误报成 internal（ZodError 落兜底分支）；task_name 命名规则无提示陷阱 | mcp/server.ts:29,71,199-211 |
| D1-4 | P1 | 委派/authority 配置错误拖死整个 kap-server 启动（dispose 后重抛），爆炸半径过大 | start.ts:344; mcp/externalDelegationAuthority.ts:120,137 |
| D1-5 | P2 | meta 的 thread_communication 为必填 literal(true)，新客户端解析旧 server 失败 | protocol/src/rest/meta.ts:21-26 |
| D1-6 | P2 | klient IPC 全局默认超时 30s→65s 只为 wait 服务，普通调用失败感知延迟翻倍；wait 60s 与 RPC 65s 仅 5s 余量 | klient/src/transports/ipc/channel.ts:31 |
| D1-7 | P2 | KIKI_MCP_* 校验错误只报"incomplete or unsafe"，不列缺失/非法变量；READ_ONLY=0 报错误导 | apps/kimi-code/src/cli/sub/web/run.ts:339-358 |
| D1-8 | P3 | kiki_result.max_bytes 上限 65KB 但后端固定只请求 16384 字符 | mcp/server.ts:50,93 |

## Batch D2 — Codex MCP 启动器（fix/codex-mcp-launcher）

| ID | 级别 | 问题 | 证据 |
|----|------|------|------|
| D2-1 | P1 | workspace binding 漂移后错误只报笼统的 isolated authority contract，不指出哪个字段漂移；无重建入口 | codex-kiki-mcp.ps1:444,463,512 |
| D2-2 | P1 | 每 workspace 常驻隐藏 kap-server：无 stop/list、launcher 退出不回收、常规 kimi web kill 枚举不到（只扫默认 home） | codex-kiki-mcp.ps1:673; legacy-kill.ts:46 |
| D2-3 | P2 | 端口被第三方进程占用即该 workspace 硬失败永久报废（唯一自救手工删 binding.json）；错误不可操作 | codex-kiki-mcp.ps1:673-735 |

## Batch E — doctor 加固与文档治理（fix/docs-governance）

| ID | 级别 | 问题 | 证据 |
|----|------|------|------|
| E1 | P1 | kimi doctor 对 agent-core-v2 internal/ 子路径动态 import 无兜底，上游重构即整条命令崩（含未改的 config/tui 检查） | doctor.ts:300-307,130-137 |
| E2 | P1 | kiki-runtime.md 同一特性既"disabled by default"又"stable and always available"，双语同错 | docs/{zh,en}/guides/kiki-runtime.md |
| E3 | P2 | 根 AGENTS.md:47 仍描述旧 nix 检查语义；Project Map 无 kiki-gui；与 fork 现状脱节 | AGENTS.md:47; scripts/check-nix-workspace.mjs |
| E4 | P2 | changelog 顶部游离条目应回退（changeset 已承载且与上游 sync 流程冲突）；external delegation 缺 changeset | docs/{zh,en}/release-notes/changelog.md |
| E5 | P2 | KIKI_MCP_* 未进中英文环境变量文档；thread communication 仅 v2 可用未注明 | docs/{zh,en}/configuration/env-vars.md |
| E6 | P2 | doctor 未接收 parser warning callback；有 WARN 时仍打印"All checked config files are valid." | doctor.ts:96,260 |
| E7 | P2 | legacy 引擎下 doctor 用 v2 schema 给 v2-only 字段（service_tier/request_params）虚假 OK | doctor.ts:260; v1 parser.ts:86-104 |
| E8 | P3 | 已合入分支残留（gui-batch-a/c、codex/*-integration 等）；无引用 scratch 脚本/截图/handoff 工件入库；FRONTEND-ISSUES.md KG-001 记录与实现脱节 | 分支列表; apps/kiki-gui/scripts/*, screenshots/; FRONTEND-ISSUES.md:38 |

## Batch F — 协作语义（fix/collab-semantics）

| ID | 级别 | 问题 | 证据 |
|----|------|------|------|
| F1 | P1 | v1 resume/retry 不再跟随父 agent 的 /model 切换（fork 移除再继承逻辑且未被 flag 隔离，默认路径静默语义变化） | subagent-host.ts:263,644（旧"follow mid-session /model switches"逻辑被删） |
| F2 | P2 | v2 collaboration materialize 重建 agent 时不重传 delegator/forkedFrom，覆盖结构化元数据 | agentCollaborationTool.ts:158; sessionMetadataService.ts:145 |
| F3 | P2 | fork_turns 只接受 "none" 是死参数；named agent 状态解析失败回退 errored 无 unknown | agent-collaboration.ts:22,260 |
| F4 | P2 | v1 agentfile 复制体注释指向不存在的 v2 路径，"keep in sync"无机制且已漂移（v1 缺 service_tier/request_params） | v1 profile/agentfile/types.ts:1-6 |
| F5 | P3 | subagent binding source 用模块级 WeakMap 旁路保存，对象复制后来源信息丢失 | subagent-binding.ts:114 |

## Backlog（已登记未排期）

| ID | 级别 | 问题 | 备注 |
|----|------|------|------|
| BK1 | P1 | 设置双通道收敛单一写者（桌面域并入 server API），根除整文件互覆 | **已关闭（2026-08-18）**：Tauri 直写通道整段删除（read/write_server_config IPC + toml_edit 依赖），GUI 统一走 `GET/POST /api/v1/config` 且仅发送增量 patch 防多客户端互覆；`IConfigService` 保持进程内串行写者；4 包 tsc + cargo test + GUI 461/461 全绿；残余：多 kap-server 进程共享 home 仍属跨进程竞争边界 |
| BK2 | P1 | workspace handler 只创建不回收（watcher/loader/订阅线性积累） | **已关闭（2026-08-18）**：`WorkspaceInstanceLease` 引用计数（session 激活持引用、close/archive 释放）+ 空闲 TTL 逐出（`[workspace_instance].idle_ttl_ms`，默认 5min）+ DELETE /workspaces 强制级联（等 in-flight、拒新操作、正常 close 生命周期、dispose 级联）；真实服务集成测试覆盖引用 2→1→0 与 DELETE 归零 |
| BK3 | P1 | CLI(TUI) 与桌面后端共用 home 无会话级跨进程互斥，可同时恢复写同一会话 | **已关闭（2026-08-18）**：v2 文件锁（hard link 原子创建 + 120s lease/15s 续租 + tokenized stale takeover），锁定覆盖 create/resume/restore/fork 全活动期；App 层 resume single-flight；kap-server 新增 `SESSION_LOCKED=40933` 线码区分报错；已知残余：lease 锁无 fencing token、legacy v1 引擎不参与协议 |
| BK4 | P1 | runtime.json 无安装器/重签工具；Codex 侧模型安装时冻结（换模型=HMAC 死结） | **已关闭（2026-08-17）**：launcher 新增 `-ListBindings`/`-ResignBinding`/`-ResignAllBindings`，按裁决 #9 落地；仅 model/thinkingEffort 作为每 workspace 独立已签名参数，其余 authority 契约不变；含端到端测试与文档 |
| BK5 | P1 | GUI 会话与 Codex 委派会话互不可见（独立 homeDir）；thread 通信跨 host 不可能 | 维持现状（见裁决 #8）；**边界已文档化（2026-08-18）**：`docs/*/guides/cross-host-session-boundaries.md`——host=home-scoped 身份域、隔离裁决依据、禁止绕过方式、受控桥接设计约束（双端启用/可撤销凭证/幂等/fail closed） |
| BK6 | P2 | 委派进行中无进度流（仅生命周期事件），Codex 只能轮询 | **已关闭（2026-08-18）**：`kiki_dispatch`/`kiki_continue` 支持 MCP `progressToken`——有 token 时请求保持打开并推送标准 `notifications/progress`（轮次开始 + 已完成工具计数，终态覆盖 completed/failed/cancelled/interrupted）；无 token 保持原异步语义，REST/事件/持久化协议零新增；14 例新测试全过 |
| BK7 | P2 | TUI 不显示 peer-thread 消息来源（像用户自己的输入） | **已关闭（2026-08-18）**：live/replay 双路径渲染 `Peer thread · <source-session>` 来源行（textDim，正文上方），pi-tui 零改动；新增 8 断言全过，15 个 TUI 失败均为既有 Windows 环境簇 |
| BK8 | P2 | sidecar 二进制新鲜度零校验（旧后端+新前端症状零散） | **已关闭（2026-08-17）**：构建期清单（target/大小/SHA-256/版本）+ 启动期 `/api/v1/meta` 版本握手，不匹配拒绝连接并给诊断 |
| BK9 | P2 | 协作能力 v1/v2 双写 + v2 内两套 durable mailbox 后端重复 | **已关闭（2026-08-18，用户裁决硬切换）**：named-agent 协作改经薄适配器复用 `MiniDbMailboxBackend`（新 v2 目录），旧后端与专属 schema 删除；不迁移旧数据（几乎无真实使用且 mailbox 不含对话历史），旧目录保留不删、非空启动 warn；安全边界投递/原子 backlog 128/幂等/FIFO/crash 恢复全保留（breaking 已注 changeset） |
| BK10 | P2 | 子代理模型绑定 7 入口 5 层解析链收敛 | **已关闭（2026-08-18）**：全部入口（Agent/AgentSwarm/collaboration/TowerSpawn/agentfile bind/route pin/secondary pool/default_subagent_model/profile setModel）统一经 `IModelService.resolveId` + `canonicalizeSubagentBinding`，写路径持久化 canonical id、展示层保留原 pool label；`subagent/configSection` 不再私读 models config；grep 旁路检查 0 命中；v1 链冻结未动 |
| BK11 | P2 | thread 通信默认全局开启且可唤醒冷会话消耗额度 | **已关闭（2026-08-18）**：默认值源码/manifest 本就为 `enabled: false`，本批补齐默认值断言测试 + 修正仍声称"默认开启"的双语文档（docs/*/customization/agents.md、guides/kiki-runtime.md），明确 opt-in 与额度消耗提示 |
| BK12 | P3 | terminal_input.data 无大小上限；TERMINAL_NOT_FOUND 无法区分"能力未开放" | **部分缓解（perf 批）**：registerWsV1 新增 8MiB 帧上限（超限 1009 关闭）；schema 级 `data` 上限与错误码语义仍缺 |
| BK13 | P3 | /threads::wait 客户端断开不取消服务侧 wait（≤60s 资源浪费） | **已关闭（2026-08-17）**：路由改 200ms 可取消轮询 + AbortSignal（req aborted/reply close/shutdown），顺带消除 shutdown 时长轮询卡关闭的死锁 |
| BK14 | P3 | vite localServer 探测只查 PID 存活不防复用；暴露 0.0.0.0 时返回 bearer token | **已关闭（2026-08-17）**：候选实例经 `/api/v1/meta` 校验 server_id 身份；非 loopback 绑定不再回吐 token |
| BK15 | P3 | 三套模型词汇（model/model_alias/model_preference）全量统一 | **路线已文档化（2026-08-18）**：`docs/*/guides/model-vocabulary-convergence.md`——v2 委派契约统一 model/model_alias，agentfile model_preference 保留为 schema 兼容词汇，阶段 0–5 路线；勘察补正：v2 `model` 支持模型池 key、bare ID 后缀匹配为解析便利能力 |

## 裁决记录（外部文档 vs 本地审计，取证后）

1. **外部#1 心跳**：属实，本仓库 `docs/server-heartbeat.md` 自证；客户端已前向兼容，修复在服务端（→ D1-1）。本地审计此前未覆盖此点，无冲突。
2. **外部#7 v1 resume 继承**：属实（diff 取证确认 fork 删除再继承逻辑且未隔离）。F1 实现折中：显式绑定保留、继承型绑定 resume 时重新继承父模型。**合入后需用户确认是否符合预期产品语义。**
3. **外部#19 上游重复修复**：属实，`upstream/main` 领先 1 提交 `01c74e9`（session profile catalog 隔离）与 fork 同名 changeset 重叠。下次同步上游时采用上游版本并去重，本批不改。**（2026-08-17 已执行：采用上游版本，fork 重复 changeset 已删；见上游同步记录。）**
4. **外部#22 台账 KG-001**：与本地审计一致（记录过时、实现为有意演进），E8 更新台账而非删除。
5. **外部#2/#3（会话互斥/handler 回收）**：属实，但分别需要跨进程锁与上游生命周期架构级设计 → BK3/BK2。
6. 其余外部条目与本地审计结论一致或互补，未见本地审计被推翻的结论。
7. **FU17 裁决（2026-08-17 用户拍板）**：按「更好用更易用优先、校验严格性让步」设计——外部委派 workspace 漂移时 **fail-open**（edge 禁用、主服务继续启动、错误显式呈现）；该设计原则同样适用于后续其他设计。待实施：`externalDelegationRoute.test.ts:189-214` 的 fail-closed 期望改写为 fail-open 契约（与 `boot.integration.ts` 正向固化对齐）。
8. **BK11 裁决（2026-08-17 用户拍板）**：thread 通信**默认关（opt-in）**；冷唤醒耗额度问题随默认关消解。BK5（GUI/委派会话互不可见）维持现状，受控跨 host 桥接另立设计项。待实施：`[thread_communication] enabled` 默认翻转为 false + 文档/测试跟进。
9. **BK4 裁决（2026-08-17 用户拍板）**：做 runtime.json 重签工具（installer/doctor 子命令方向），让普通用户可自助换模型。待排期设计。
10. **FU7 裁决（2026-08-17 用户拍板）**：effort 下拉**选中即发送**，消除「看似选中实则未发」。待实施（GUI 小改）。

## 修复批次合入记录（2026-08-14）

| 批次 | 分支 | 内容 | 提交数 |
|------|------|------|--------|
| A | fix/gui-composer-ux | GUI 会话/composer（A1-A10） | 2 |
| B | fix/gui-connection-ux | GUI 连接/WS/终端（B1-B7） | 5 |
| C | fix/desktop-startup | 桌面壳启动/CSP（C1-C7） | 3 |
| D1 | fix/server-delegation-robustness | 服务端心跳/委派健壮性（D1-1..8） | 13 |
| D2 | fix/codex-mcp-launcher | Codex MCP 启动器（D2-1..3） | 4 |
| E | fix/docs-governance | doctor 加固/文档治理/仓库卫生（E1-E8） | 4 |
| F | fix/collab-semantics | 协作语义（F1-F5） | 5 |

合入方式：顺序 `--no-ff` 合并；唯一人工解冲突为 `apps/kiki-gui/src/i18n/{zh,en}.ts` 三块批次键追加（Batch C/B/A 合并保留）。

## 上游同步记录（2026-08-17：upstream 0.36.1）

- 范围：`sync/upstream-0.36.1` worktree 合并 `upstream/main` `437a1b8b` → `44a6c70e`（69 commits，`@moonshot-ai/kimi-code` 0.36.1）。49 个冲突路径（44 内容 + 5 modify/delete），外加 4 处 kiki 独有代码对上游已删 API 的语义迁移。
- 关键裁决：
  1. v2 核心全面采用上游新架构：`ISessionManager` App 级会话门面（取代 `IWorkspaceLifecycleService.handlerFor` 组合）、声明式 subagent model pool（上游 #2700）、`features/` 重组、`runtimeBinding` 进程能力模型。不保留 workspaceLifecycle 双轨兼容层。
  2. F1 语义在模型池上重表达：spawn 时分类 `inherit | fixed` 并经 `AgentMeta.labels['subagentBindingMode']` 持久化；resume/retry 时 inherit 跟随父当前 model/thinking、fixed 冻结（显式 `primary` 按 spawn 时父绑定冻结）；无标签旧 agent 安全按 fixed；fork 经 `labelsFromAgentMeta` 复制。**FU3 仍未决**（仅持久化 mode 二态，完整 spawn-source 持久化待产品拍板）。
  3. thread wire 错误码避开上游新增码段重新编号，并跨 `packages/protocol` / `kap-server` / `klient` 三包同步：40421、40927–40932。属协议变更，GUI 与服务端同仓发布保持一致。
  4. 按裁决记录 #3 删除重复 changeset（`isolate-session-profile-catalogs`）；`configure-subagent-bindings` changeset 改写为 pool 语义；`coder.yaml` 保留 kiki 的 `Agent`/`AgentSwarm` 工具条目（不采用上游删除）。
  5. 「委派 root 禁止 fork」断言移植到新架构测试（`test/app/sessionManager/sessionManagerService.test.ts`）。
- 主要修复（对 kiki 直接受益）：#2911 自托管 OpenAI 兼容端点 tool_call id 重编号挂起修复、#2876 Windows file-watcher（盘符根/UNC）、#2899 MCP OAuth 取消悬挂、TUI 启动冻结修复、subagent 活动查看器、step-retry 等。
- 验证证据：15 包 typecheck 全绿；kiki-gui 31 文件 418 测试全绿；v2 合并触及区定向 555+ 测试全绿；klient 线程契约/错误码 66/66（单 worker）；protocol 529/529；reviewer 独立审查（diff-of-diffs 保全、F1 抽查、双轨 grep）通过。全量套件在本机存在环境性红测，归因见 FU17-FU20，均非本轮合并引入。

## 上游同步记录（2026-08-17：upstream 0.36.1）

### 合入收尾（2026-08-17 当日完成）

- `sync/upstream-0.36.1`（merge commit `4d3a76b60`）已 fast-forward 合入 `kiki` 主支。
- perf 冻结审计批 `perf/freeze-fixes-20260816`（`ff952dae3`）随后合入，merge commit `f79c53b53`：8 个冲突按「新架构 + perf 硬化叠加」解决；`sessionEventBroadcaster` 从已删的 `followWorkspaceHandlers` 迁到 `ISessionManager` close/archive 事件；`perf-exp5` 测试迁移后断言修复后的驱逐契约；`threadCommunicationService.test.ts` 断言更新为新门面序列。
- 本机 Node 升级 24.19.0（仓库 engines >=24.15 满足）；三个 gen-manifest 在新 Node 下重生成功（FU19 关闭）。
- 合入后验证：GUI 33 文件 426 测试全绿（含 perf-exp6）；kap-server sessions 64/64、threads 15/15、wsConnectionV1 39/39、perf-exp5 2/2；v2 threadCommunication 24/24；pi-tui 89/89；受影响包 typecheck 全绿。
- BK/FU 全面复核（2026-08-17 两路审计）：多数 backlog 仍成立（kiki 特有或产品裁决项）；BK2/BK10/BK12 部分缓解已标注；FU3 核心诉求以二态标签形式完成；FU19 关闭；其余维持原状。

## 体验反馈批次（2026-08-17，0.36.1 构建体验后）

用户实机体验首轮 0.36.1 构建后反馈 9 项问题，按四个互斥批次并行修复（W 组件交互 / X 数据面 / Y 模型绑定 / Z 台账小项）：

| 反馈 | 根因 | 修复 |
| --- | --- | --- |
| 新页面开新窗口而非应用内页面 | Markdown 链接无差别 `target="_blank"` | 内部路径改 React Router Link 应用内导航；外部 scheme 保留新窗口 |
| 子代理重开对话丢名字/0 工具调用 | 快照 roster 缺 `parent_agent_id`/`label`/`tool_call_count`，GUI 硬编码 0 | kap-server 快照补齐三字段并合入持久化 metadata，GUI 消费 |
| 子代理面板上方无限兄弟代理 | 组件对全部兄弟/子节点无界 map | 去重+各限量 4 个+「更多」展开入口 |
| 用量统计口径错 | cache 命中率分母漏 cache_creation；总量口径不统一 | 四段互斥口径统一（lib/usage.ts） |
| 上下文面板点击=压缩 | ContextMeter onClick 直接绑 onCompact | 点击开详情面板，压缩按钮移入面板内 |
| 右栏子代理数量无限 | AgentTreeView 递归无界渲染 | 有界滚动区（max-h-80） |
| 重开旧对话模型选择不恢复 | snapshot `agent_config.model` 输出占位空串 | snapshot 恢复 main agent 后读持久化 `ProfileModel` 覆盖 |
| 嵌套子代理模型不走默认 | 三入口取「直接 caller」profile，嵌套时 caller=子代理 | 嵌套 spawn 重定向主代理上下文：pool default→fixed，否则主代理当前模型 fixed；顶层 inherit 不变 |
| FU2 死参数 | fork_turns/statusOf 与 v1 不对称 | 对齐 v1（任意非空+运行时可操作错误；未知状态返回 unknown） |

同批落地的已裁决台账项：FU17（fail-open 契约测试）、BK11（thread 通信默认关 opt-in，含文档/测试跟进）、FU7（effort 选中即发送，新会话+已有会话两侧）、FU1（快照改 arrayContaining 根治）、FU20（旧术语注释清理）、FU12（klient ipc 超时放宽）。

另：`config-manifest.toml` 已在 Node 24.19 下按最终源码重生（thread_communication 默认 false 等）。

## 体验反馈批次（2026-08-17，0.36.1 构建体验后）

### 第二轮反馈与工程项（同日）

| 反馈/事项 | 根因 | 修复 |
| --- | --- | --- |
| 立即发送的消息出现在开头 | queued local echo 误匹配历史同文占位块 | 仅 running prompt 可合并占位、从尾部匹配；queued 恒追加尾部；steer 锚定保留 |
| 消息中间 `/` 不触发 skill | slash 解析仅识别整条 draft 起始 | `parseSlashTrigger/completeSlashTrigger` 支持光标处行内 token，inline 菜单只列 skill |
| 历史子代理闪烁 | resync 重建历史卡片+forest 全量换引用 | `stabilizeAgentForest` 结构共享；历史卡片字段级等价复用+锚点恢复；memo comparator 只比渲染依赖 |
| 思考链一块块蹦出 | thinking.delta 统一走 rAF 发布，主线程忙时攒成大块 | 可见页面改 microtask 节奏发布（突发合并保留），隐藏页保持原缓冲 |
| 裸别名解析脆弱（设计修正） | 模型解析纯精确键，裸名无兜底 | v1/v2 新增无歧义裸名匹配：精确优先、唯一命中才解析、多候选报错列全名、写路径 canonical 化 |
| BK4/BK8/BK13/BK14/FU4/FU13/FU21 | 见台账行内关闭记录 | 同左 |

## Follow-ups（批次实施中新增，未排期）

| ID | 级别 | 问题 | 来源批次 |
|----|------|------|----------|
| FU1 | P2 | agent-core 既有快照漂移：`test/profile/agent-profile-loader.test.ts` 的 `DEFAULT_AGENT_PROFILES['coder'].tools` 快照未含协作工具，基线即失败、非本批引入 | F |
| FU2 | P2 | v2 侧同款死参数未收敛：`agentCollaborationTool.ts` 的 fork_turns / statusOf('errored') 与 v1 对称，F3 按证据范围只改了 v1 | F |
| FU3 | P3 | **核心诉求已以二态形式完成（2026-08-17 同步批）**：spawn 三入口（Agent/Swarm/collaboration）均持久化 `inherit|fixed` 标签（`AgentMeta.labels['subagentBindingMode']`），重启后显式 alias 误判为继承的风险已消解；完整五态 source（tool/profile/default/secondary/caller）持久化属产品增强项，仍待拍板 | F/同步 |
| FU4 | P2 | kap-server pino 日志走 stdout，`--log-level warn` 落盘的是 stderr；服务端日志进 desktop-backend.log 需改 logger destination 或加 `--log-file` | **已关闭（2026-08-17）**：pino destination 改 stderr，与桌面 stderr 捕获约定直接兼容，无需 `--log-file` | C |
| FU5 | P3 | desktop 侧打包/冷启动验证 | **已关闭（2026-08-18）**：`pnpm desktop:build` 全链路成功（Vite 41s + cargo release 6m23s + makensis），产出 `Kiki_0.1.0_x64-setup.exe`（45.8MB）；此前 promote/冷启动冒烟已过 | C |
| FU6 | P3 | A3 容量校验基准用渲染期 attachments 起步，跨两次极快粘贴可能略微超出 8 附件/20MB 上限（功能更新正确，仅校验基准偏旧） | **已关闭（2026-08-18）**：`attachmentBaselineRef` 同步基准 + FileReader 启动前预留 loading stub，同 tick 连续粘贴按累计数量/字节校验 | A |
| FU7 | P3 | A4 展示/发送语义：effort 下拉"看似选中"实则未发送、由 server 决定 | **已关闭（2026-08-18）**：勘察确认生产接线已满足裁决（setEffortOverride 即时生效、`thinking: effectiveEffort` 随请求发送）；补"选择值进入下一次请求"回归契约测试 | A |
| FU8 | P3 | A8 桌面原生目录选择对话框未实现（defer，仅做校验+placeholder） | **已关闭（2026-08-18）**：`selectDirectoriesNative()`（tauri plugin-dialog，directory+multiple），设置页桌面环境显示"选择文件夹…"，Web 降级手工输入 | A |
| FU9 | P3 | A9 extraDirs placeholder 用了 POSIX 路径，Windows 桌面用户用 Windows 示例更直观 | **已关闭（2026-08-18）**：中英文 placeholder 均改 Windows 示例 | A |
| FU10 | P3 | D1-3 `createToolError` 覆写依赖 MCP SDK 私有方法，SDK 升级可能静默回落 | **已核查（2026-08-18）**：SDK 1.29.0 下未断裂（13/13 过）；止血=锁精确版本 `1.29.0`（去 `^`）+ 契约测试作升级门禁，待执行 | D1 |
| FU11 | P3 | D1 委派失败分类未迁移已持久化旧文档的 errorCode（数据迁移边界） | D1 |
| FU12 | P3 | klient `ipc.test.ts` 有 1 例时序敏感偶发超时（非本批引入），建议显式放宽 testTimeout | **已关闭（2026-08-18）**：该例局部 `timeout: 60_000`，连跑两遍 19/19 过 | D1 |
| FU13 | P3 | D2 优雅关闭端点 `POST /api/v1/shutdown` 只静态核对，HTTP 成功路径未在真实服务验证（fallback 强杀路径已测）。2026-08-17 perf 批次已给 `IThreadCommunicationService.shutdown()` 接线并覆盖 close 路径 | **已关闭（2026-08-17）**：新增真实服务集成测试，覆盖 200 响应 + listener 关闭 + thread shutdown 调用 + 注册释放 | D2 |
| FU14 | P2 | 设置页 providers 草稿的 dirty-guard 只拦设置页内部区块切换；经应用侧栏导航离开（如 Capabilities）时不弹确认，未保存草稿静默丢失（dsh 设计吸纳批次合并验证期发现） | **已关闭（2026-08-18）**：dirty 所有权提升到 App，应用级 guarded navigator + 统一确认对话框，覆盖 Sidebar/Quick Switcher/快捷键/托盘/新会话导航全部出口 | G |
| FU15 | P3 | QueueStrip 行内编辑已实现 `onEdit` 但未接线：kap-server 无原位编辑端点（保存=移除+重发会落队尾，位置语义需产品确认）；接线只需 SessionView 传一行 handler | **已关闭（2026-08-18）**：SessionView 接线 `onEdit`，保存=abort 原 prompt + 同配置重发（接受落队尾语义，不改服务端）；负向路径有双语 toast | G |
| FU16 | P3 | turn tail 的 tok/s 与 ContextMeter 的 system/tools/messages breakdown 未做：wire 无 per-turn token 计数与上下文分段数据，需服务端补数据后再上 | **已关闭（2026-08-18）**：`turn.ended` 增四段 usage + tok/s（流时长优先）；`contextBreakdown` 三段估算归一到权威总数并标 `estimated:true`；WS/REST/snapshot 三通道可选扩展向后兼容；GUI turn tail + ContextMeter 详情双语落地 | G |
| FU17 | P2 | `externalDelegationRoute.test.ts`「workspace 绑定漂移拒启动」用例在合并前基线即红，与 `start.ts` fail-open 矛盾 | **已关闭（2026-08-18）**：用例改写为 fail-open 契约——healthz 200、delegation edge 关闭、warn 级（pino level 40）诊断含 drift 信息 | 同步 |
| FU18 | P2 | 上游 0.36.1 自带测试在本机 Windows 成片失败（posix 路径断言、5s 超时簇为主）；涉败文件与上游逐字节一致，非合并回归。2026-08-17 本机 Node 升 24.19 后原 nvm4w shim spawn ENOENT 簇预计消失（execPath 已修通），待一次全量复跑确认剩余面。**2026-08-19 抽样分类（未全量复跑）**：`agent-core-v2` 全量 `vitest run` 为 55 文件 / 251 例失败，抽样后至少分三类——(a) 平台权限：`test/os/backends/node-local/hostFsService.test.ts` 的 symlink 三例是 `EPERM: operation not permitted, symlink`，Windows 建符号链接需管理员或开发者模式；(b) 平台路径：`tools/glob.test.ts` 一例断言反斜杠、实得正斜杠；(c) **并发噪声**：`miniDbQueryStore.test.ts` 337 文件并发时红、单独或三文件小批跑全绿，全量日志里的 "The latest test that might've caused the error is…" 是 worker 崩溃而非断言失败。因此 251 这个数字被并发显著放大，复跑时建议先降并发再统计 | 同步 |
| FU19 | P3 | ~~manifest 未重生~~ **已关闭（2026-08-17）**：Node 升 24.19 后 `gen:config-manifest` / `gen:state-manifest` / `gen:wire-manifest` 全部重生成功；`config-manifest.toml` 相对手合版校正 7+/11-（池语义真值：secondaryModel owner 归位、overlay 条目删除） | 同步 |
| FU20 | P3 | 生产源码旧术语注释残留 | **基本清完（2026-08-17 Z 批）**：sessionLookup/fsProcess/fsService/fs/runRg/acpConnection/sdk-rpc-client-v2/WorkspaceServicesView 已清理；残余 bashTool.ts 一处（当时属他批范围） | 同步 |
| FU21 | P3 | v1 `test/harness/coder-subagent-tools.test.ts` 4 例与 `test/profile/agent-profile-loader.test.ts` 快照（FU1）在基线即红 | **已关闭（2026-08-17）**：4 例修复（coder profile 断言对齐 Agent/AgentSwarm；shell 探测改宿主自适应）；FU1 快照已先行根治 | 同步 |
| FU22 | P2 | `test/features/tower/tools/spawnTool.test.ts` 三例基线即红，且**不属于 FU18 那一类**——不是平台限制也不是并发噪声，单文件跑必红：生产侧 `createAgent` 自 `4a0b86e5c`（persist subagent identity）起多传一个 `userLabel`（如 `"tower worker agent-build: Build gemm"`），而该测试文件最后一次改动是更早的 `509733b9e`，`toHaveBeenCalledWith` 的期望对象未同步。涉及三例：`spawns a detached tower-worker…` / `canonicalizes the configured secondary model…` / `binds reviewers to the tower model…`。修法=期望对象补 `userLabel`，或改用 `expect.objectContaining` 只钉住 binding/labels。定位证据：在 `cognition-binding` 分支上把本地改动暂存/恢复各跑一次，两次都是同样三例失败，与该分支改动无关（该分支 `git diff d052d00a4..HEAD -- src/features/tower test/features/tower` 为空） | 外部（cognition-binding 分支例行验证时定位） |
