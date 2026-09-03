# U1 上游接收批次 1

## 接收记录

| 顺序 | upstream commit | 本地 commit | 冲突文件 | 解法 |
|---:|---|---|---|---|
| 1 | `3899079a2` | `7a4dadb02` | `packages/agent-core-v2/test/app/config/config.test.ts` | 保留 Kiki 的 thread communication 与 model-service 覆盖，并合入上游持久化 guard 所需的 cron 默认值与 env overlay。 |
| 2 | `616d51045` | `2b00eb47b` | — | 直接接收，在 lossy-write guard 之后加入 raw TOML 格式保真写回。 |
| 3 | `9d2304c23` | `38fcd163f` | `packages/kap-server/test/prompts.integration.ts`（上游路径已改名） | 保留 Kiki integration 测试结构，只移入 atomic `config.toml` 替换辅助逻辑与 torn-read 覆盖。 |
| 4 | `33eee4260` | `cc5ffe83e` | session-index source/projector/service、storage/query store 及相关测试 | 将 mtime checkpoint 与 freshness scan 叠加到 Kiki 的共享扫描、usage reconciliation、mirror epoch、fail-closed read model 和 storage lock 契约上。 |
| 5 | `75c94c4a0` | `772a1511d` | — | 直接接收：无显式 id 时从 `kimi-file` URL 取得 attachment file id。 |
| 6 | `b17bd61ce` | `66dc17390` | `sessionOutcomeMirrorService.ts`、`turnOps.test.ts`、`sessionOutcomeMirror.test.ts` | 适配 Kiki 的 `IAgentScopeHandle` registry 与本地 event payload，保留 restore reconciliation 和 undo range 判断。 |
| 7 | `d8317d81e` | `aabaf0bbc` | `workspaceAliasesService.test.ts`；上游修改的 `test/session/subagent/forkParity.test.ts` 本地已删除 | 保留 Kiki 的 derived session-index seed 与已删除测试边界，加入 snapshot cache、同步写失效和 generation-safe reload。 |
| 8 | `5e57618fc` | `c1d2538f8` | `sessionLifecycleService.ts`、`workspaceInstanceManagerService.ts` | 仅删除已退役的 model-pool preflight，保留 workspace lease/flag 依赖与 config/model/provider ready 等待。 |
| 9 | `82bf0a8dd` | `4b884c72b` | — | 直接接收 NUL-delimited porcelain 解析与非 ASCII/rename 测试。 |
| 10 | `442b56391` | `5d28288dc` | `AGENTS.md`、双语 `env-vars.md`、`towerFeature.test.ts` | 保留 Kiki-only flags 与 Tower hard-disabled 口径，只接收 per-flag env > config > master env > default 的代码、测试与对应文档。 |
| 11 | `0f39b2cf3` | `b1750e539` | `registerApiV1Routes.ts`、`sessions.ts` | 复用 Kiki 既有 broadcaster 参数，同时服务 optimistic cursor 检查和 GET watermark，并保留本地 usage projection。 |
| 12 | `8f2c60b32` | `8c90049c1` | —（手工移植） | 只移植 `agent-core-v2/src/kosong/**` 与 `packages/oauth`：增加 Kimi `openai_responses` definition，并映射 managed `"response"`。 |
| 13 | `6595955b3` | `e350954e0` | —（手工移植） | protocol 字段保持 optional，kap-server 本地 schema 设为 required，并从实际 `detached` 状态投影 `run_in_background`。 |
| 14 | `2adc6a1c6` | `a8e3f672e` | —（手工移植） | 只取 v2：ACP terminal 不适用时回退 local process、stdio MCP 绑定 local runtime、移除后的 session runtime 可重注册。 |
| 15a | `ffa877cfd` | `db18c4907` | —（语义移植） | 保持 AGENTS.md 变化不重建基础 system prompt。 |
| 15b | `243f34832` | `db18c4907` | —（语义移植） | 不做 in-place system prompt refresh，继续走 `appendSystemReminder`。 |
| 15c | `0b8808a2c` | `db18c4907` | —（语义移植） | context loss 后再次访问目录时允许重新提示未注入的子目录 AGENTS.md。 |
| 15d | `4d7f32e1a` | `db18c4907` | —（语义移植） | reminder 文案只保留可执行的读取要求，不描述 compaction mechanics。 |
| 15e | `ad5f0a5fa` | `db18c4907` | —（语义移植） | discovery 进入 step-head queue；按实际直接读取抑制；同 step 去重；删除前复核文件仍存在。 |

## 封口记录

| 项目 | 本地 commit | 结果 |
|---|---|---|
| 根 `AGENTS.md` 上游同步纪律 | `e4ad8c502` | `apps/*`、`packages/*` 全部改为只 cherry-pick/语义移植；每个 release tag 或每 4 周巡检，先到者为准；高风险类别随到随巡。 |

## 推后 / 拒绝

### 推后到 Phase 1 或对应基座稳定后

- transcript identity / provenance：`2f1246930`、`c48858609`、`5634cb556`、`b3f08b68c`、`f143130c0`、`dc6028dc6`、`cbe0a77f3`、`58b74cfea`、`9e881528a`。原因：等待 session-core / transcript-live 稳定，避免在移动结构上重复移植。
- `eac9ea88e` cron durable。原因：等待 cron/session persistence 基座稳定。
- `4d5147ba5` lifecycle teardown。原因：随本地 runtimeBinding 生命周期工作处理。
- `23921e9f2` 后台任务终止通知。原因：随统一 task lifecycle 处理。
- `ca87c58e6` 委派层级上限、`ea0626ad4` 后台提问受 task controls 约束、`3b69765cf` 双发 spawned。原因：随 external seat / delegation follow-up 处理。
- `b6b9b374d` forced-stop handoff、`742e1197a` durable retry/interrupt、`9c37feb47` fast fork、`692bb0a40` task detach、`496bb6ce4` swarm timeout、`2bf7ed22d` auth readiness、`a23ff5635` add-dir、`4e7738b73` server-local attachments。原因：只取语义并随各自 Kiki 基座或公共契约迁移实施。

### 拒绝本批接收

- `650d12f6c` fileHistory：未纳入当前存储与产品范围。
- Tower 全组 `c3bf6f9d2`、`ece96185e`、`d3b27cc77`、`15f20537c`、`0f44537c1`：用户配置已禁用 `tower-worker`。
- `b4ae7f875` Bash cwd 越界：Kiki §7 cwd 政策更严格。
- `71caabdc6` fs:suggest：归 HostAdapter/session-core。
- `15da84606` workspace-grouped sessions：Kiki 基座自行定义。
- `f1208c8d7` 标题摘录：不接收上游用户可见标题策略。
- `4b9888b73` dangerous bash：不接收上游强制审批策略；仅分析器能力另立 opt-in policy lane，manual/auto 默认开、yolo 默认关。

## Review 1 修正与最终态验证口径

- `56511fd51` 将 step-head flush 注册移入独立的 Agent-scope eager bridge。`AgentAgentsMdReminderService` 不再构造依赖 `IAgentLoopService`，生产 Agent DI 图不再形成 `usage → profile → reminder → loop → requester → usage` 环。
- `b349d7a49` 补齐 ACP stdio MCP 在 `session/new` 与 `session/load` 的行为覆盖；`27279bf1e` 让 ACP composition root 在接收请求前等待 session index ready。
- 合入主线 `6d63e0956` 的 merge commit 为 `0dd083f12`；自动合并保留了 Lane G 对 standalone `packages/kosong`、`packages/telemetry` 的删除，以及本批 upstream 封口章节和 experimental flag 优先级说明。
- 最终 HEAD 的 `packages/kap-server/test/tasks.integration.ts` 为 `12/12` 通过；主线 `6d63e0956` 同命令为 `10/10` 通过。新增真实 Agent materialization 用例与 `run_in_background` 用例均通过。
- reminder 定向集为 `63/64` 通过；唯一失败是 Windows symlink 创建 `EPERM`，与 Lane I 明确列出的同文件、同失败形态一致。
- session watermark 新用例为 `1/1` 通过。另行复核的 3 个 session lifecycle 用例在候选与主线 `6d63e0956` 的同命令中均为相同 3 项失败，因此只按本次主线对照记录，不引用 Lane I（Lane I 未覆盖 kap-server integration）。
- ACP 移植相关 6 个定向用例全部通过；完整 `lifecycle.test.ts` 在候选为 `12/16` 通过、4 项失败，主线 `6d63e0956` 同命令为 `4/16` 通过、12 项失败。候选剩余 4 个失败测试在主线同样失败，但其中 delete 场景的具体错误文本不同，记录为“主线同测试失败”，不声称错误形态完全等价。
- 先前 Git 定向集的 5 项失败不再整体标为既有基线；Lane I 只支持其中 untracked-diff 与并行清理 `EPERM` 的精确失败簇。
- 先前 root `test:promote` 的 `140` 个失败文件仅作为失败证据；只有 Lane I 精确分类的 `55` 个文件可称已分类基线，其余 `85` 个不作既有归类。
