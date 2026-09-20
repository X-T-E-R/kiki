---
title: 跨 host 会话边界
description: GUI 与 Codex 委派会话保持隔离的原因，以及未来受控桥接必须满足的约束。
outline: [2, 3]
---

# 跨 host 会话边界

GUI 会话与 Codex 委派会话有意使用彼此独立的 Kimi home 目录。它们不能通过会话或 thread API 发现对方，当前 thread 通信契约也会拒绝跨 host 引用。本文记录这一裁决，以及未来如需受控桥接时必须满足的最低约束。

::: warning 注意
受支持的设计是隔离，而不是共享存储。不要让 GUI 与 Codex 委派运行时指向同一个可写 home 目录，不要在两者之间复制会话目录，也不要复制 `device_id` 来让两个 home 冒充同一个 host。
:::

## 此处 host 的含义

Thread 引用由 `hostId` + `workspaceId` + `sessionId` 组成。`hostId` 不是 DNS 名称或物理机器名；`ThreadCommunicationService` 从该 server 的 `homeDir` 下读取稳定的 Kimi device ID，并将其作为 host 标识。

Home 目录同时也是 server 文件存储的根。会话元数据、wire 记录、会话索引、thread mailbox、server instance 记录和 device ID 因而属于同一个本地权限与持久化边界。

即使运行在同一台物理计算机上，只要两个运行时使用独立 home 和独立 device ID，它们就是不同的 thread host。

## 当前拓扑

受支持的 GUI 与 Codex 路径会有意建立不同的存储与权限域。

### GUI 侧会话

GUI 连接到一个 `kap-server` instance，只能看到该 server home 目录下保存的会话。本地 GUI 开发会在 `KIKI_HOME` 下发现 server；该变量未设置时回退到 `~/.kiki`，并读取这个 home 的 instance registry 与 bearer token。

GUI 是该 server 的客户端。它不会扫描任意 Kimi home，也不会合并其他 server 的会话索引。

### Codex 外部委派

Codex MCP launcher 为每个 workspace 预配一份带签名的 workspace binding。每份 binding 都包含专用 `kap-home` 目录，launcher 启动该 workspace 的 KAP 进程时，会把 `KIKI_HOME` 设置为这个目录。

专用 server 可以读取另一条固定的配置路径和 Agent profile home，但它的可写会话状态、server token、instance registry、device ID 与委派 Session 仍全部位于 binding 的 `kap-home` 下。Launcher 还会校验进程、端口、Session、workspace、模型绑定和权限记录是否与已签名 workspace binding 一致。

### 直接结果

两条路径按构造方式互不可见：

- 每个 server 的 `ISessionIndex` 只读取自身 home 下的会话。
- `listThreads` 基于这份本地会话索引，因此不能列出另一个 home 中的 Session。
- Thread 引用包含本地 `hostId`。
- `readThread`、`sendMessage`、peer send 与 `waitThreads` 都会调用本地 host 校验；`hostId` 不匹配时，以 `thread.cross_host` 失败，并返回 `Cross-host thread communication is not supported.`。

即使使用同一 workspace 路径，也不会让两条 Session 成为 peer。Workspace identity 只是 thread 引用的一部分，存储与 host 边界仍然不同。

## 裁决：维持隔离

当前裁决是保持现状，不共享 home，也不建立隐式桥接。

### 可用性依据

- GUI 会话列表继续表示 GUI 侧工作，不混入由 operator 预配的 Codex 委派 Session。
- 每个 Codex workspace 都有一条稳定的委派 Session 与权限契约，launcher 的诊断与恢复可以准确指出责任主体。
- 停止或重新预配某个委派 workspace，不会干扰 GUI 的常规 server 生命周期。
- 用户不会把本地 thread 消息误发给另一权限域中恰好同名的 Session。

### 隔离依据

- 会话数据、mailbox 状态、bearer token、instance 记录与 device identity 都限制在拥有它们的进程族内。
- Codex launcher 可以强制使用专用 home、只读共享配置、带签名的 workspace binding、独占端口，以及只允许一条预配 Session 的窄外部委派权限。
- 已失陷或陈旧的客户端不能只靠提交 `source` 字段来冒充 peer 来源。现有 REST 与 Klient send 只允许指定目标，消息会记为 user 来源输入。
- 故障、清理和数据保留保持本地化；任一 host 都不需要理解或修复另一 host 的磁盘状态。

这一裁决的代价是明确的：内置 thread 通信不能协调 GUI Session 与 Codex 委派 Session。

## 哪些做法不属于桥接

以下做法会破坏当前边界，不能作为捷径：

- 让两个 server 指向同一个可写 `KIKI_HOME`。
- 在 home 之间复制或同步 `sessions/`、thread mailbox 数据、`server.token` 或 `device_id`。
- 把外部 `ThreadRef` 的 `hostId` 改写为本地值。
- 给现有 REST 或 Klient send 契约加入由客户端控制的 `source` 字段。
- 把 external delegation API 当作通用 thread 传输。它是面向一条已预配 Session 的窄权限边缘，不是跨 host peer bus。
- 把相同 workspace 路径当成两条 Session 共享 owner 或信任域的证明。

## 受控桥接的设计约束

如果跨 host 协调成为产品需求，必须在两个完整 host 之间引入显式 bridge。它不能削弱本地 thread 契约，也不能合并 home。

### 权限与同意

- Bridge 必须默认关闭，并按参与的 host 或 workspace 显式启用。
- 两端必须使用专用、可撤销凭证认证 bridge。不能把 GUI bearer token、external delegation token 或模型凭证复用为通用 bridge 凭证。
- 授权必须约束来源 host、目标 host、workspace、Session、方向和允许操作。仅持有 endpoint 不能获得路由权限。
- 用户或 operator 的同意必须明确哪些 Session 可以交换消息。跨某个 home 中所有 Session 的通配访问，需要另一套更强策略。

### 身份与来源

- Bridge 必须保留完整的来源与目标 host-qualified 引用，绝不能用本地 `hostId` 替换远端值。
- 只有在目标端验证了由 bridge 签发、受完整性保护的来源声明后，才能记录 peer 归属；任意客户端提交的来源信息仍然禁止信任。
- 无法验证来源时，目标端必须把输入记为 external / user 来源，而不是 peer 来源。
- Bridge 消息需要独立的协议版本、bridge identity、message ID 与可选 hop 元数据，以便检测循环和 replay 路径。

### 投递语义

- 接收必须幂等。重试同一 bridge 消息不能生成重复 turn；同一 idempotency key 携带不同内容时必须失败。
- 目标端继续负责验证目标 Session 存在、属于所寻址 workspace、未归档，且允许 thread 通信。
- Receipt 必须区分 accepted、delivered、pending、rejected 与 permanently undeliverable。网络请求成功不等于 Session 已收到消息。
- 必须定义每个目标的顺序与重试行为。Bridge 不能绕过目标 mailbox sequence 静默重排消息。
- 必须设置 timeout、有界 payload、rate limit、backpressure 和最大重试窗口。Bridge 不能在任一 home 内产生无界队列。

### 保持数据隔离

- 只有显式协议消息可以跨边界。会话目录、索引、token、配置文件、模型凭证和 device ID 都保持本地。
- 消息内容必须按潜在敏感 prompt 数据处理，要求传输加密、日志脱敏、保留期限和 operator 可见的审计策略。
- Bridge 能向 Session 投递消息，不代表它可以暴露远端文件系统、工具或模型凭证。
- 来源端与目标端必须独立执行策略。宽松的来源端不能覆盖已禁用的目标 workspace 或 host。

### 运维与故障处理

- 两端都需要 kill switch 与凭证撤销路径，且不应要求删除 Session 数据。
- 身份、策略、协议版本或目标校验不可用时，bridge 必须 fail closed；不能回退到共享 home，也不能使用未经验证的 peer 归属。
- 审计记录应包含 bridge identity、来源与目标引用、message ID、策略结果、时间戳和投递结果，默认不记录消息正文。
- 健康状态必须区分本地 thread 健康与 bridge 传输健康，避免把远端中断误诊为本地 Session 损坏。
- 发送带 peer 归属的流量前，必须进行 capability negotiation；混合版本只能降级到明确定义的安全行为。

## 未来 bridge 的验收门槛

Bridge 设计至少包含以下内容后，才适合进入实现：

1. 覆盖凭证盗用、来源伪造、replay、循环、confused-deputy 路由、prompt 数据暴露与目标端失陷的威胁模型。
2. 包含版本、认证、授权、幂等、顺序、receipt、重试上限和来源规则的协议规范。
3. 使用两个不同临时 home 与 device ID 的端到端测试，覆盖重复消息、重启、陈旧 Session、已归档 Session、禁用 workspace、凭证撤销和目标不可达。
4. 向用户明确展示远端来源与投递状态，不能让远端输入在 UI 中与已验证的本地 peer 无法区分。
5. 上线与回滚计划；bridge 关闭时，现有仅本地 `ThreadCommunicationService` 行为保持不变。

在所有门槛满足前，正确的集成假设仍是：GUI 与 Codex 委派 Session 不能通过 thread API 通信。

## 源码索引

当前边界由以下仓库路径支撑：

- **Server 存储根**：`packages/kap-server/src/start.ts`
- **GUI 本地 home 发现**：`apps/kiki-gui/vite/localServer.ts`
- **Codex 每 workspace 专用 home**：`packages/kap-server/scripts/codex-kiki-mcp.ps1`
- **External delegation 权限**：`packages/kap-server/src/mcp/externalDelegationAuthority.ts`
- **Host-qualified thread 契约**：`packages/agent-core-v2/src/app/threadCommunication/threadCommunication.ts`
- **Host ID 与跨 host 拒绝**：`packages/agent-core-v2/src/app/threadCommunication/threadCommunicationService.ts`
- **Device ID 存储**：`packages/oauth/src/identity.ts`

## 下一步

- [Kiki 运行时边界](./architecture.zh.md#集成-peer-thread-通信) — 当前本地 thread 工具、REST 路由与 Klient 表面。
- [会话与上下文](../zh/guides/sessions.md#会话存储) — 单个 home 目录下的普通 Kiki 会话存储。
- [本地服务与 API](../zh/server/local-server.md) — 客户端如何连接到 `kap-server` instance。
