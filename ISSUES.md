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
| BK1 | P1 | 设置双通道收敛单一写者（桌面域并入 server API），根除整文件互覆 | 需设计；C 批先做备份滚动与重启确认缓解 |
| BK2 | P1 | workspace handler 只创建不回收（watcher/loader/订阅线性积累） | 上游 App 生命周期架构，需引用计数/逐出设计 |
| BK3 | P1 | CLI(TUI) 与桌面后端共用 home 无会话级跨进程互斥，可同时恢复写同一会话 | storage.locked 已定义未用于激活路径；需跨进程锁设计 |
| BK4 | P1 | runtime.json 无安装器/重签工具；Codex 侧模型安装时冻结（换模型=HMAC 死结） | 产品决策：installer 子命令 vs 文档化手工 |
| BK5 | P1 | GUI 会话与 Codex 委派会话互不可见（独立 homeDir）；thread 通信跨 host 不可能 | 产品裁决：声明边界 vs 受控跨 host 桥 |
| BK6 | P2 | 委派进行中无进度流（仅生命周期事件），Codex 只能轮询 | MCP progress notification |
| BK7 | P2 | TUI 不显示 peer-thread 消息来源（像用户自己的输入） | pi-tui 本地零改动原则，需设计 |
| BK8 | P2 | sidecar 二进制新鲜度零校验（旧后端+新前端症状零散） | build.rs 清单 + meta.server_version 比对 |
| BK9 | P2 | 协作能力 v1/v2 双写 + v2 内两套 durable mailbox 后端重复 | 随 legacy 退役计划处理；F4 先冻结声明 |
| BK10 | P2 | 子代理模型绑定 7 入口 5 层解析链收敛 | F/E 批先做文档与 doctor 裁决层 |
| BK11 | P2 | thread 通信默认全局开启且可唤醒冷会话消耗额度 | 双方审计均建议 opt-in；属产品默认值翻转，待裁决 |
| BK12 | P3 | terminal_input.data 无大小上限；TERMINAL_NOT_FOUND 无法区分"能力未开放" | ws-control.ts:369; wsConnectionV1.ts:464 |
| BK13 | P3 | /threads::wait 客户端断开不取消服务侧 wait（≤60s 资源浪费） | routes/threads.ts:380 |
| BK14 | P3 | vite localServer 探测只查 PID 存活不防复用；暴露 0.0.0.0 时返回 bearer token | vite/localServer.ts:46,1 |
| BK15 | P3 | 三套模型词汇（model/model_alias/model_preference）全量统一 | F 批做文档/校验层，API 破坏性收敛待排期 |

## 裁决记录（外部文档 vs 本地审计，取证后）

1. **外部#1 心跳**：属实，本仓库 `docs/server-heartbeat.md` 自证；客户端已前向兼容，修复在服务端（→ D1-1）。本地审计此前未覆盖此点，无冲突。
2. **外部#7 v1 resume 继承**：属实（diff 取证确认 fork 删除再继承逻辑且未隔离）。F1 实现折中：显式绑定保留、继承型绑定 resume 时重新继承父模型。**合入后需用户确认是否符合预期产品语义。**
3. **外部#19 上游重复修复**：属实，`upstream/main` 领先 1 提交 `01c74e9`（session profile catalog 隔离）与 fork 同名 changeset 重叠。下次同步上游时采用上游版本并去重，本批不改。
4. **外部#22 台账 KG-001**：与本地审计一致（记录过时、实现为有意演进），E8 更新台账而非删除。
5. **外部#2/#3（会话互斥/handler 回收）**：属实，但分别需要跨进程锁与上游生命周期架构级设计 → BK3/BK2。
6. 其余外部条目与本地审计结论一致或互补，未见本地审计被推翻的结论。

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

## Follow-ups（批次实施中新增，未排期）

| ID | 级别 | 问题 | 来源批次 |
|----|------|------|----------|
| FU1 | P2 | agent-core 既有快照漂移：`test/profile/agent-profile-loader.test.ts` 的 `DEFAULT_AGENT_PROFILES['coder'].tools` 快照未含协作工具，基线即失败、非本批引入 | F |
| FU2 | P2 | v2 侧同款死参数未收敛：`agentCollaborationTool.ts` 的 fork_turns / statusOf('errored') 与 v1 对称，F3 按证据范围只改了 v1 | F |
| FU3 | P2 | F1 语义裁决：继承型 resume 跟随父模型已恢复；但 session 重启后 spawn 期 source 标记丢失，显式 tool alias 可能被误判为继承型——需产品确认是否要持久化 source | F |
| FU4 | P2 | kap-server pino 日志走 stdout，`--log-level warn` 落盘的是 stderr；服务端日志进 desktop-backend.log 需改 logger destination 或加 `--log-file` | C |
| FU5 | P2 | desktop 侧 `tauri build`/NSIS 打包与真机冷启动 smoke 未实跑（仅 cargo check/test + TS 测试） | C |
| FU6 | P3 | A3 容量校验基准用渲染期 attachments 起步，跨两次极快粘贴可能略微超出 8 附件/20MB 上限（功能更新正确，仅校验基准偏旧） | A |
| FU7 | P3 | A4 展示/发送语义：effort 下拉"看似选中"实则未发送、由 server 决定——需产品确认 | A |
| FU8 | P3 | A8 桌面原生目录选择对话框未实现（defer，仅做校验+placeholder） | A |
| FU9 | P3 | A9 extraDirs placeholder 用了 POSIX 路径，Windows 桌面用户用 Windows 示例更直观 | A |
| FU10 | P3 | D1-3 `createToolError` 覆写依赖 MCP SDK 私有方法，SDK 升级可能静默回落 | D1 |
| FU11 | P3 | D1 委派失败分类未迁移已持久化旧文档的 errorCode（数据迁移边界） | D1 |
| FU12 | P3 | klient `ipc.test.ts` 有 1 例时序敏感偶发超时（非本批引入），建议显式放宽 testTimeout | D1 |
| FU13 | P3 | D2 优雅关闭端点 `POST /api/v1/shutdown` 只做了静态核对，HTTP 成功路径未在真实服务验证（fallback 强杀路径已测） | D2 |
| FU14 | P2 | 设置页 providers 草稿的 dirty-guard 只拦设置页内部区块切换；经应用侧栏导航离开（如 Capabilities）时不弹确认，未保存草稿静默丢失（dsh 设计吸纳批次合并验证期发现） | G |
| FU15 | P3 | QueueStrip 行内编辑已实现 `onEdit` 但未接线：kap-server 无原位编辑端点（保存=移除+重发会落队尾，位置语义需产品确认）；接线只需 SessionView 传一行 handler | G |
| FU16 | P3 | turn tail 的 tok/s 与 ContextMeter 的 system/tools/messages breakdown 未做：wire 无 per-turn token 计数与上下文分段数据，需服务端补数据后再上 | G |
