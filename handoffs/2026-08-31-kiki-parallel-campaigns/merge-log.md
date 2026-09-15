# Upstream 同步评审日志（kimi-code → kiki）

规则来源：根 AGENTS.md「Upstream Synchronization」。评审节奏：每个上游 release tag 或每四周。
本表记录每次评审对上游提交的判定：日期 | 上游提交 | 判定(adopt/adapt/defer/reject/covered) | 本地 HEAD | 备注。

## 2026-09-15 评审（merge-base 38a5a934ae，上游 299 提交，四 worker 分片研究）

本地 HEAD：88a28cb07。分片：①引擎核心 ②服务端/协议 ③oauth/config ④外围。

### 判定：adopt/adapt（纳入吸纳批，按优先级）

| 提交 | 标题 | 判定 | 批次 | 备注 |
|---|---|---|---|---|
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
| #3694 | 存储故障重建索引（只切搜索 sync 预算 + minidb 锁保护 wipe） | adapt（拆分） | P2 | 同步防雪崩 + 别 rm -rf 别人持有的活库；跨切片（kap-server search + minidb wipe） |
| #3548 | wire 层附件名 | adapt | P2 | 文件名在压缩/转存后丢失；0.5-1 人日 |
| #3219 | 插件市场版本查询加超时 + 首帧不等网络 | adapt | P2 | fetchLatestReleaseTag 无超时；配置远端目录源时卡首帧 |
| #3531 | print 退出前 flush wire | adapt（部分） | P2 | print 路径无 flush；尾记录可丢；M-L，跨 CLI 切片 |
| #3785 | secondary_model.default_effort fail fast | reject(代码) → adapt(替代) | P2 | 该域已删；改收"已移除配置节的诊断告警"（复用 #3681 的 collectDiagnostics） |

### 判定：defer（想要，另行排期）

| 提交 | 备注 |
|---|---|
| reasoning_details 家族（#3492/#3601?→#3735/#3765） | provider 协议面缺口；全家 3-5 人日特性移植，单独收任何一环都无效；需独立立项 |
| #3749 AI 会话标题毕业 | **产品决策**：always-on 还是保留 GUI 逃生阀（建议先 default=true 留阀） |
| pi-tui 重基线 (#3780) | 须按本仓 pi-tui AGENTS.md 的 8 条守护分叉走 re-vendor 流程；大 |
| #3206 lifecycle context through teardown | 与 #3717/#3720 同族，M；di/scope 基础件 4/9 逐字节相同 |
| #3391 信任提示默认 "Trust this folder" | **产品决策**（默认更宽松 vs 现在默认退出） |
| #3803 WebBridge 改名 | **产品决策**（品牌口径混搭） |
| #3473 未确认文件改动警示（独立小修部分） | 依赖上游口径改名，只摘 warning + 缩进小修 |
| #3517 remove staleGuard | 产品取舍（上游嫌体验差删除；我们仍发布中） |
| #3293 refreshProviderModels 默认选择重配部分 | byte-identical，2h 可摘 |
| #2862 双 OAuth 登录端点 | 产品确认是否要同语义 |
| #3425 kimi session list / #3593 trust 提示 / #3372 doctor 校验 | CLI 增量面，价值中低 |
| #3136 cloudbase 目录项 / #3774 skills 文档澄清 | 小改，随手可做 |

### 判定：reject

| 类别 | 备注 |
|---|---|
| runtime-to-DI/actor/xstate/human 层迁移族（#3737/#3710/#3641/#3580/#3606/#3678/#3747/#3662/#3682/#3691/#3626 等 ~30 项） | 仓规首轮排除；我们架构（Event2/Fiber/Scope）本就不同 |
| tower 族（#3752/#3648 等 9 项） | Tower 已退役（88a28cb07），仅留历史解码 |
| remote-control 族（#3034/#3718/#3709/#3707/#3696 等） | 我们无该产品面；#3709 的 V8 正则栈溢出已做同款核查：仅一处同类形态、无风险 |
| secondary-model 族（#3403 等） | 仓规排除；我们已移除该域 |
| 云/问卷/telemetry 族（#3516/#3795/#3616/#3638 等） | 无对应物/云依赖 |
| UI/web 同步（code-app dist、#3539/#3524/#3532 客户端、#3803 部分） | 与 GUI 不同源；#3532 换协议路线不值得（我们 op 游标+四级 grade 断线完整性更强） |
| file-history / updater CLI 自更新（已删）/ xstate 面 | 无对应物 |
| 测试基建/CI/docs-only（#3643/#3269 等） | NA |

### 判定：covered（我们已覆盖，确认无动作）

#3281/#3282（wire repair 逐字节相同）、#3348（torn read 已是上游终态）、#3121（config 有损写防护）、#3122（close drain 全接线）、#3241（两处均在）、#3095、#3375、#2200、#3392、#3325、#3226（check-no-comments 已入 lint）、#3542（v1 早已删除）、#3493（天然只出一次日志）、#3492?（无：reasoning-key 只认字符串，不解析 details，#3735 病灶不可达）。

### 交叉结论

- 三份 wire 折叠口径（transcript wireAdapter / transcript-live liveAdapter / kap-server wireExtract）需要后续收敛到 transcript 读模型——观察项，未评估工作量。
- #3694 与 #3531 的验收跨切片（session index 与搜索索引同源 minidb wipe；CLI print 生命周期），单独做一半会造成两套不一致的"不可恢复"判定。
- merge-log 落点按仓规创建本文件（此前 EasyAgent 工作区的同名文件是战役合并日志，非本表）。
