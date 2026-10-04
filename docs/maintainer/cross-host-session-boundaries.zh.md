---
title: 跨 host 会话边界
description: 独立 home 的隔离边界，以及显式单向 thread bridge 的授权、来源与恢复合同。
outline: [2, 3]
---

# 跨 host 会话边界

独立 Kiki home 仍是独立存储与权限域。Thread 工具默认只处理执行 Agent 所属 home；本机其他空间和远端空间必须经两端 owner 显式置备的单向 bridge。GUI 连接、相同 workspace 路径、同机登录权限和持有 endpoint 都不构成 bridge 授权。

::: warning 注意
不要让 GUI 与外部委派运行时共享可写 home，不要复制会话目录、mailbox、`server.token` 或 `device_id`。Bridge 传输明确批准的消息和有界读结果，不合并两端存储。
:::

## 此处 host 的含义

Thread 引用由 `hostId`、`workspaceId`、`sessionId` 组成。`hostId` 不是 DNS 或物理机器名，而是 server 从自身 `homeDir` 读取的稳定 device ID。Bridge 还固定两端 `homeId`（独立持久 UUID）和协议版本，不能仅以相同 Session ID 寻址。

Home 保存会话元数据、wire 记录、索引、thread mailbox、instance registry 和身份。两个 home 即使位于同机、使用同一 workspace 路径，也不是同一个 thread host。`host_id: "local"`、空值或省略目标 host 都表示执行 Agent 的 home，不是 GUI 当前浏览的空间。

## 当前拓扑

GUI 连接一个 server home，不扫描任意 home，也不把远端会话混入本地索引。跨空间浏览权限和 bridge 线程权限分别授权；能向某条远端线程投递，不代表 GUI 可以打开其历史或文件。

Codex MCP launcher 仍为每个 workspace 使用签名 binding 中的专用 `kap-home`。共享只读配置或 profile 不改变其可写会话、token、instance registry、device ID 和委派 Session 的归属。Launcher 的进程、端口、模型和外部委派权限校验仍独立于 bridge。

同 home 跨 workspace 的 Thread 通信沿用现有 mailbox，不进行跨空间握手。跨 home 的 `ThreadList`、`ThreadRead`、`ThreadSend`、`ThreadWait` 则由同一个 `ThreadCommunicationService` router 委托给 bridge connector。普通 REST 和 Klient `sendMessage` 仍是 external/user 输入，客户端不能提交可信 `source`。

## 显式授权与置备

Bridge 是单向批准记录：provider owner 限定 source 和 target 的 home/host、workspace、可选 Session、有效期及操作，再把专用 credential 安装进 source 后端。省略 `sessionId` 是显式允许该 workspace 的未来线程，不是意外通配。反向发送需要另一条批准记录。

| 操作 | 权限 |
| --- | --- |
| `ThreadList`、`ThreadRead` | `read` |
| `ThreadSend` 入站保存 | `send` |
| `ThreadWait` | `wait` |
| 投递到模型 prompt、恢复冷线程 | 额外的 `wake` |

没有 `wake` 的消息保留为 pending，不启动模型。启动或 ensure daemon 也不等于授权唤醒模型。目标还检查 Session 存在、workspace 归属、未归档以及 thread communication 开关。

管理入口 `/api/thread-bridges/*` 始终要求 local-owner。数据入口仅有四个精确的 POST：`/api/thread-bridge/list`、`read`、`send`、`wait`；它们要求独立 bridge credential，普通 owner、GUI grant 和外部委派 token 都不能替代。启用危险开发鉴权绕过时，有效 inbound 为关闭，已保存策略保留但不能继续接收 bridge。

终端管理使用 `kiki bridges --home <dir>`。`status` 查看策略，`target` 登记固定目标，`approve --input <file>` 在 provider 上签发，`install --input <file>` 在 source 安装；`-` 从标准输入读取 JSON。Credential 不放进参数或模型输出，`approve` 的一次性输出应存入受保护文件。

本机路径使用 `local --input <file>`，选择已登记 `spaceId`。目标 daemon 必须已运行且 inbound 已显式开启。Source 连接目录保存 `local_space` 稳定引用，每次 acquire 从既有控制目录和 instance registry 找当前 loopback endpoint，并核验固定 home/host；普通读不会隐式启动 daemon，换端口重启不会换目标身份。

Network 置备登记固定 endpoint 与 target identity。SSH 使用 source connector 的独立 `bridge` lease 和 acquire 接口；SSH 登录不授予入站权限，bootstrap local-owner 也不成为日常 bridge credential。URL 传输用于受信 loopback 或安全隧道；公开网络必须使用 HTTPS。GUI secret 和 bridge secret 由同一 secret store 按 purpose 隔离。

## 真实来源与有界读取

Source 从执行 session 取得身份，模型只能选批准的下一跳 `bridge_id` 或 `connection_id`，不能构造 producer。Target 校验 credential、grant revision、source/target scope、两端 home、location、有效期和 hop 后记录独立 `bridged_peer` 来源。

来源保留完整 host/workspace/session、source home、target home、bridge、revision、location、message ID、source sequence、cause ID 和 hop。Transcript 的 `bridgedPeer` 与同 home `peerThread` 明确区分。GUI 导航必须使用完整来源寻址，并另行核验浏览权限，不能把远端同 ID 线程导航到当前 home。

跨空间 `ThreadRead` 复用正式 session view 的 transcript page 和 `ContentRef`（被省略正文的续读引用）。第一页返回 coverage、cursor 和必要来源，正文续读仍执行同一 `read` grant 和目标校验；返回 view 不意味着绕过授权，也不恢复全正文接口。

## 投递、重试与撤销

Source 先持久化 outbox，再按原 source sequence 发送。相同 bridge/source/target/idempotency key 和相同正文返回原 receipt；异正文冲突，不生成新消息。Target 使用现有 durable mailbox 保存 producer 和 target sequence，prompt 使用同一稳定 message ID。Prompt 已持久启动而 mailbox ACK 丢失时，恢复会查已有 prompt receipt，不再生成第二个模型 turn。

| Receipt 状态 | 含义 |
| --- | --- |
| `pending` | Source 已保存，尚无目标接收确认 |
| `accepted` | Target mailbox 已确认保存，尚未确认投递到 prompt |
| `delivered` | 已投递到 prompt，不代表模型已回复 |
| `rejected` | 身份、授权、目标或有效期拒绝后续投递 |
| `undeliverable` | Target 保存过的消息已确认不可投递 |

暂时不可达或限流时保留原 request/key，指数退避，最大单次间隔 60 秒。消息 TTL 为 15 分钟且不超过 grant expiry；过期停止重试，不把未经确认的结果报告为 delivered。Source pending 总量最多 100，每 link 受 `pendingLimit` 限制；重复不占新配额。`messagesPerMinute` 对新 key 限流。终态历史不占 pending 容量。

Source 终态保留 receipt 和 fingerprint 至少 7 天，移除 outbox 正文；target mailbox 保留幂等依据，不沿 external 输入的裁剪路径丢失桥来源。状态和凭证放在各自 home 的私有后端存储，审计输出不含 credential。消息正文属于敏感 prompt 数据，不写入普通操作日志。

Inbound 总开关、workspace 开关、grant revision 和撤销会在接收及实际投递前重判。撤销不删除 Session。Outbound 暂停停止该 link 的活动请求并保留 pending；撤销该 link 移除其专用 secret，不终止共享 descriptor 上其他 link 或 GUI lease。Descriptor 禁用、移除或身份改变由连接管理器停止所有 purpose。

`ThreadWait` 最长 60 秒并保留调用方取消；运输 deadline 覆盖合法等待预算及响应读取。连接关闭、grant 撤销、effective inbound 关闭和 server shutdown 都终止对应活动读取，不回退到 GUI credential。

## 不属于桥接的做法

以下操作仍破坏边界，不能用于绕过批准：共享或同步可写 home；复制 token 或 device identity；把外部 host 改写成本地值；给普通 REST send 增加可伪造 source；把外部委派 API 当作通用 peer bus；把同一 workspace 路径、同 UID 或 SSH 登录当作信任证明。

版本、身份、授权或目标校验不可用时拒绝请求。未知凭证不会降级为 peer 或普通 user 投递；关闭 bridge 后，同 home 通信继续走原路径。

## 源码与验证索引

- **Router 与真实工具**：`packages/agent-core-v2/src/app/threadCommunication/`、`src/agent/tools/thread-communication/`
- **政策、source outbox、strict data gate**：`packages/kap-server/src/services/threadBridge/bridge.ts`
- **本机稳定目标解析**：`packages/kap-server/src/services/connections/localSpace.ts`
- **共享合同**：`packages/protocol/src/rest/thread-bridge.ts`
- **终端管理**：`apps/kimi-code/src/kiki/thread-bridges.ts`
- **真实 server 纵切**：`packages/kap-server/test/threadBridge.integration.ts`，同机和 loopback network 均通过实际工具、mailbox、prompt 与本地 stub 模型；不访问用户 home 或真实 provider。
- **同 home 回归**：`packages/agent-core-v2/test/app/threadCommunication/threadCommunicationService.test.ts`

[运行时边界](./architecture.zh.md#集成-peer-thread-通信)记录同 home 的现有工具和 API；[本地服务与 API](../zh/server/local-server.md)介绍 server 生命周期和客户端连接。
