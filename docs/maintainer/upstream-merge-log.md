# Upstream Synchronization Log (`kimi-code` → `kiki`)

Rule owner: root [`AGENTS.md`](../../AGENTS.md#upstream-synchronization). Review cadence: every upstream release tag or every four weeks, whichever comes first, plus immediate review for security/CVE fixes, provider protocol mismatches, and wire or persistence data-corruption fixes.

Record every accepted, adapted, deferred, rejected, or already-covered upstream commit using the date / upstream commit / disposition / local HEAD / notes format below.

---

## 2026-10-25 — Provider media & managed selection follow-ups

| Date | Upstream commit | Disposition | Local HEAD | Notes |
| --- | --- | --- | --- | --- |
| 2026-10-25 | [5653c739b9c0dbafd1e4b3d36edeb0fe44ec71f4](https://github.com/MoonshotAI/kimi-code/commit/5653c739b9c0dbafd1e4b3d36edeb0fe44ec71f4) image file ref | adapt | `5ebfddcc7` | 复用 Kimi Files 与现有 media resolver，只对已确认的 Kimi 官方 HTTPS 端点、Chat Completions / Messages 上传已保存图片。上传及缓存校验均使用当前鉴权与显式请求身份；缓存按端点、协议、provider、凭据和图片变体隔离，只存远端 ID。每次复用先 retrieve，404/410/到期重新上传；暂时失败保原件并走 inline，鉴权与取消不吞。远端副本遵循 provider 留存策略，本地关闭/删除不触发远端删除；双语 providers 页说明。 |
| 2026-10-25 | `5653c739b9c0dbafd1e4b3d36edeb0fe44ec71f4` fixed 20MB/drop | reject (partial) | `5ebfddcc7` | 保留 composer 现有 20 MiB 附件准入及原 canonical 字节，不增加请求累计预算、不静默丢较早媒体，也不移植失败 retry 丢附件。定向回归覆盖累计超过 20 MiB 仍保两张原图。 |
| 2026-10-25 | #3293 unchanged-catalog default selection | adapt | `2b83f458d` | 目录不变时仅恢复真正缺失的 managed 默认模型/thinking 选择；保明确选择及 fetch 期间新选择。API-key/manual discovery 仍只给 suggestions，不自动写入配置。OAuth 21 项回归及包 typecheck 通过。 |

## 2026-10-25 — Provider credential env reference

| Date | Upstream commit | Disposition | Local HEAD | Notes |
| --- | --- | --- | --- | --- |
| 2026-10-25 | [c5ad17f06aa12702d2b30dff63acba9ed08f688d](https://github.com/MoonshotAI/kimi-code/commit/c5ad17f06aa12702d2b30dff63acba9ed08f688d) `api_key_env` | adapt | `070832863` | 显式变量名接入 config/schema、SDK、模型鉴权、readiness、模型发现与 provider create/patch/clear。保留模型凭证、provider inline 优先级及未声明时原 env bag 合同；同名 bag 空值不回落，不隐式读取 vendor shell key，不复制运行时值进凭证存储。共享 resolver、fake-env 请求/冷读/失败脱敏回归及双语配置参考随实现交付；无 GUI、默认模型选择或协议路由变更。 |

---

## 2026-09-15 — Review sweep (merge-base `38a5a934ae`, 299 upstream commits)

Local HEAD: `88a28cb07`. Shards: ① engine core, ② server/protocol, ③ oauth/config, ④ periphery.

### Disposition: `adopt` / `adapt`

| Upstream | Title | Disposition | Priority | Notes |
| --- | --- | --- | --- | --- |
| #3787 | oauth managed usage 换 quota 模型 | adapt | P0 | **线上回归**：/usage 计划用量行现在为空；provider 协议不匹配类，仓规要求立即复核；REST 契约变更需 changeset 标注 |
| #3776 | DI 图释放已 dispose 的 agent scope | adopt/adapt | P0 | 核心文件与上游修复前逐字节相同；慢性内存泄漏，subagent 活跃下每次生命周期都漏 |
| #3618 | session index 扫描跳过非目录条目 | adapt | P0 | 一个杂文件即可让索引永久退化/崩；XS |
| #3750 | compaction 重试上限可配 + 计数缺陷 | adapt | P0 | 三个独立计数器交替失败可超预算=无上限烧钱；我们逐行同源 |
| #3657 | goal 去 24h 上限 + setTimeout 钳制 | adapt | P0 | **两项必须同批**，否则 deadline 重排退化为 1ms 热循环；离线时间语义另开子批 |
| #3681 | [models] 缺 model 字段告警 | adopt | P0 | config plumbing 三文件 verbatim 可 apply；其 collectDiagnostics 钩子也是 #3785 替代方案（已移除节告警）的落点 |
| #3728 | env 关 auto 模式提醒 | adapt | P0 | 2-3h；省 auto 模式每轮重复注入 ~130 token；命名按仓规 KIKI_PERMISSION_MODE_REMINDER |
| #3734 | llm 重试时流式 attempt 态失效 | adapt | P1 | 重试后分片缓冲污染；S-M |
| #3601 | 空 reasoning 分片合并文本 delta | adapt | P1 | 我们缺"空 think 分片直接丢弃"早返回，一段文本被拆两块；XS |
| #3697 | steer 打断后台任务等待 | adapt | P1 | steerSignal 链全缺；TaskWait 把用户新输入卡到 timeout，可直接感知 |
| #3717+#3720 | 拆除后迟到任务结算静默 + remove 前压制 | adapt | P1 | 同一机制同批；doRemove 无 quiescence、taskService 三处无条件派发=幽灵通知；Promise.all 短路 |
| #3631 | 搜索结果对照 session 源验证 | adapt | P1 | 唯一一处"返回不存在数据"的正确性缺陷；我们 search 三文件同构可点对点适配 |
| #3777 | TUI swarm 进度渲染批处理+缓存 | adapt | P1 | 每帧 O(成员²) 默认路径性能缺陷；estimator 与上游父版逐字节相同，近零冲突 |
| #3560 | `kimi web` 自动开 localhost + 修 `--host ::` 崩溃 | adopt | P1 | 两处真实缺陷均在（run.ts:195/464）；2 hunk |
| #3802 | diff 代码块高亮 | adopt | P1 | 文件与上游父版完全相同，palette 已具备，+3 行 |
| #3670 | 会话选择器内删除会话 | adapt | P1 | 后端 API 齐全（klient delete + kap-server 路由），只缺 TUI 接线与确认 |
| #3688 | MCP 遗漏附件保留原件 | adapt | P2 | 唯一一处不可逆数据丢失；ISessionMediaStore 已有；2-3 人日；完整形态需 #3649/#3652 前置 |
| #3649/#3652 | provider 感知图像格式（HEIC/HEIF/BMP + 回退默认模型） | adapt | P2 | 静态白名单把 iPhone HEIC 误杀；provider 能力面缺口；1-2 人日 + 能力事实确认 |
| #3694 | 存储故障重建索引（只切搜索 sync 预算 + minidb 锁保护 wipe） | adapt (split) | P2 | 同步防雪崩 + 别 rm -rf 别人持有的活库；跨切片（kap-server search + minidb wipe） |
| #3548 | wire 层附件名 | adapt | P2 | 文件名在压缩/转存后丢失；0.5-1 人日 |
| #3219 | 插件市场版本查询加超时 + 首帧不等网络 | adapt | P2 | fetchLatestReleaseTag 无超时；配置远端目录源时卡首帧 |
| #3531 | print 退出前 flush wire | adapt (partial) | P2 | print 路径无 flush；尾记录可丢；M-L，跨 CLI 切片 |
| #3785 | secondary_model.default_effort fail fast | reject (code) → adapt (alt) | P2 | 该域已删；改收"已移除配置节的诊断告警"（复用 #3681 的 collectDiagnostics） |

### Disposition: `defer`

| Upstream | Notes |
| --- | --- |
| reasoning_details 家族（#3492/#3601?→#3735/#3765） | provider 协议面缺口；全家 3-5 人日特性移植，单独收任何一环都无效；需独立立项 |
| #3749 AI 会话标题毕业 | **产品决策**：always-on 还是保留 GUI 逃生阀（建议先 default=true 留阀） |
| pi-tui 重基线 (#3780) | 须按本仓 pi-tui AGENTS.md 的 8 条守护分叉走 re-vendor 流程；大 |
| #3206 lifecycle context through teardown | 与 #3717/#3720 同族，M；di/scope 基础件 4/9 逐字节相同 |
| #3391 信任提示默认 "Trust this folder" | **产品决策**（默认更宽松 vs 现在默认退出） |
| #3803 WebBridge 改名 | **产品决策**（品牌口径混搭） |
| #3473 未确认文件改动警示（独立小修部分） | 依赖上游口径改名，只摘 warning + 缩进小修 |
| #3517 remove staleGuard | 产品取舍（上游嫌体验差删除；我们仍发布中） |
| #3293 refreshProviderModels 默认选择重配部分 | byte-identical，2h 可摘（2026-10-25 已在 `2b83f458d` 适配） |
| #2862 双 OAuth 登录端点 | 产品确认是否要同语义 |
| #3425 kimi session list / #3593 trust 提示 / #3372 doctor 校验 | CLI 增量面，价值中低 |
| #3136 cloudbase 目录项 / #3774 skills 文档澄清 | 小改，随手可做 |

### Disposition: `reject`

| Category | Notes |
| --- | --- |
| runtime-to-DI/actor/xstate/human 层迁移族（#3737/#3710/#3641/#3580/#3606/#3678/#3747/#3662/#3682/#3691/#3626 等 ~30 项） | 仓规首轮排除；我们架构（Event2/Fiber/Scope）本就不同 |
| tower 族（#3752/#3648 等 9 项） | Tower 已退役（88a28cb07），仅留历史解码 |
| remote-control 族（#3034/#3718/#3709/#3707/#3696 等） | 我们无该产品面；#3709 的 V8 正则栈溢出已做同款核查：仅一处同类形态、无风险 |
| secondary-model 族（#3403 等） | 仓规排除；我们已移除该域 |
| 云/问卷/telemetry 族（#3516/#3795/#3616/#3638 等） | 无对应物/云依赖 |
| UI/web 同步（code-app dist、#3539/#3524/#3532 客户端、#3803 部分） | 与 GUI 不同源；#3532 换协议路线不值得（我们 op 游标+四级 grade 断线完整性更强） |
| file-history / updater CLI 自更新（已删）/ xstate 面 | 无对应物 |
| 测试基建/CI/docs-only（#3643/#3269 等） | NA |

### Disposition: `covered`

#3281/#3282（wire repair 逐字节相同）、#3348（torn read 已是上游终态）、#3121（config 有损写防护）、#3122（close drain 全接线）、#3241（两处均在）、#3095、#3375、#2200、#3392、#3325、#3226（check-no-comments 已入 lint）、#3542（v1 早已删除）、#3493（天然只出一次日志）、#3492?（无：reasoning-key 只认字符串，不解析 details，#3735 病灶不可达）。

### Cross-cutting notes from 2026-09-15 sweep

- 三份 wire 折叠口径（transcript wireAdapter / transcript-live liveAdapter / kap-server wireExtract）需要后续收敛到 transcript 读模型——观察项，未评估工作量。
- #3694 与 #3531 的验收跨切片（session index 与搜索索引同源 minidb wipe；CLI print 生命周期），单独做一半会造成两套不一致的"不可恢复"判定。

---

## 2026-09-02 — U1 upstream intake batch 1 (merge commit `0dd083f12` onto `6d63e0956`)

### Accepted / adapted commits

| Order | Upstream commit | Local commit | Conflict surface | Resolution |
| ---: | --- | --- | --- | --- |
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
| Policy | — | `e4ad8c502` | `AGENTS.md` | `apps/*`、`packages/*` 全部改为只 cherry-pick/语义移植；每个 release tag 或每 4 周巡检，先到者为准；高风险类别随到随巡。 |
| Fixup | — | `56511fd51` | Agent DI | 将 step-head flush 注册移入独立的 Agent-scope eager bridge，`AgentAgentsMdReminderService` 不再构造依赖 `IAgentLoopService`。 |
| Fixup | — | `b349d7a49` / `27279bf1e` | ACP | 补齐 ACP stdio MCP 在 `session/new` 与 `session/load` 的行为覆盖；ACP composition root 在接收请求前等待 session index ready。 |

### Deferred in U1 batch

- transcript identity / provenance：`2f1246930`、`c48858609`、`5634cb556`、`b3f08b68c`、`f143130c0`、`dc6028dc6`、`cbe0a77f3`、`58b74cfea`、`9e881528a`（等待 session-core / transcript-live 稳定，避免在移动结构上重复移植）。
- `eac9ea88e` cron durable（等待 cron/session persistence 基座稳定）。
- `4d5147ba5` lifecycle teardown（随本地 runtimeBinding 生命周期工作处理）。
- `23921e9f2` 后台任务终止通知（随统一 task lifecycle 处理）。
- `ca87c58e6` 委派层级上限、`ea0626ad4` 后台提问受 task controls 约束、`3b69765cf` 双发 spawned（随 external seat / delegation follow-up 处理）。
- `b6b9b374d` forced-stop handoff、`742e1197a` durable retry/interrupt、`9c37feb47` fast fork、`692bb0a40` task detach、`496bb6ce4` swarm timeout、`2bf7ed22d` auth readiness、`a23ff5635` add-dir、`4e7738b73` server-local attachments（只取语义并随各自 Kiki 基座或公共契约迁移实施）。

### Rejected in U1 batch

- `650d12f6c` fileHistory：未纳入当前存储与产品范围。
- Tower 全组 `c3bf6f9d2`、`ece96185e`、`d3b27cc77`、`15f20537c`、`0f44537c1`：用户配置已禁用 `tower-worker`。
- `b4ae7f875` Bash cwd 越界：Kiki §7 cwd 政策更严格。
- `71caabdc6` fs:suggest：归 HostAdapter/session-core。
- `15da84606` workspace-grouped sessions：Kiki 基座自行定义。
- `f1208c8d7` 标题摘录：不接收上游用户可见标题策略。
- `4b9888b73` dangerous bash：不接收上游强制审批策略；仅分析器能力另立 opt-in policy lane，manual/auto 默认开、yolo 默认关。
