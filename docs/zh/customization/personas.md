# 角色、Bot 与房间

**角色（persona）**让一个身份及其记忆延续到不同会话；[profile](./agent-profiles.md) 仍然负责工具、权限和执行方式。**Bot** 为角色提供常驻会话，**房间**则让多个角色在各自独立的成员会话里讨论同一主题。

## 从角色开始

在「角色」页创建角色，或把角色卡放到 `$KIKI_HOME/personas/release-guide/persona.md`（`$KIKI_HOME` 默认为 `~/.kiki`）：

```yaml
---
name: 发布向导
title: 发布协调人
job: 检查发布准备情况
profile: agent
greeting: 这次准备发布什么？
memory:
  shared: [global, workspace]
---
你负责协调发布准备工作。主动询问缺失的证据，区分已确认事实与待解决问题。
```

目录名就是稳定 ID：使用小写字母、数字，以单个连字符分隔单词。Markdown 正文定义身份。可选的 `model_alias` 和 `thinking_effort` 指定已配置模型及思考档位，但不授予权限。`tools` 等字段会被拒绝，因为权限属于 profile。

在 GUI 新建会话时选择角色，或从终端启动：

```sh
kiki --persona release-guide
```

TUI 中，`/persona list` 列出角色，`/persona switch release-guide` 打开一个**新会话**，旧会话仍然保留。显式选择的模型优先于角色模型；否则先使用角色模型，再考虑 profile 或默认模型。显式选择其他 profile 会覆盖角色预设的 profile，但不会丢掉角色身份。

每个会话都会冻结自己的角色快照。编辑角色卡不会悄悄修改正在进行的会话的系统提示词；新建会话或重建上下文后才会应用修改。开场白在你明确回复之前只是本地展示，单纯打开会话不会把它加入模型历史。

## 记忆与角色卡

角色记忆跟随角色，不随 profile 或模型切换而丢失。角色专属条目与其他角色隔离；默认也能读取公共 global 和 workspace 记忆。设置 `memory.shared: []` 可排除这些公共记忆。记忆页提供角色与角色工作区分组；删除角色也会删除其角色记忆命名空间。如果清理记忆失败，删除操作会报告错误并保留角色卡，便于重试。

角色页支持 Character Card V3 的 JSON、PNG、CHARX 导入导出。保存前先查看导入预览：卡片的 lorebook（背景知识条目）可转换为角色记忆，影响后续模型请求。未知扩展字段会在导出时保留；如果卡片含有头像之外的二进制素材，请保留原卡，因为这些素材尚不能完整保留。头像支持不超过 2 MiB 的 PNG、JPEG、WebP。复制会创建新身份，不复制会话状态或私有记忆；归档会隐藏常规选择列表中的角色，但不抹除数据。

## 启用 Bot

使用「设为 Bot」创建或重新打开角色的常驻会话。这个操作会显式启用 Bot 支持，也可以在 `config.toml` 中配置：

```toml
[bot]
enabled = true
max_handoffs_per_hour = 30
room_budget = 12
```

Bot 默认关闭，普通角色不依赖这个开关。Bot 默认工作目录为 `$KIKI_HOME/bots/<id>`，也可以在角色中指定 `home_workspace`。常驻会话与每个房间的成员会话彼此独立。

会话的 `delivery` 为 `reply` 或 `message`。在消息模式中，只有成功的 `SendMessage` 调用才算已发送消息，普通模型文本留在过程视图。用户触发的轮次如果只输出普通文本、没有成功发送，Kiki 会让模型重新考虑**一次**，因此可能增加一次模型请求。内置 `agent` profile 在消息模式中会暴露 `SendMessage`，reply 模式的轮次则不暴露。自定义 profile 如果显式设置了 `tools` 白名单，必须自行加入 `SendMessage`；delivery 模式不会绕过 profile 权限。工具表会在每个轮次内冻结，因此切换 delivery 会在下一轮生效。

`SendMessage` 可以发给用户，也可以用 `to: "@名字"` 发给另一个已启用 Bot。同名时使用角色 ID。交接可以唤醒已关闭的常驻会话，并计入每小时上限；相同投递键的重试不会再占一个名额。附件是从会话工作区、附加目录或 Bot 主目录区域复制的不可变副本，不能任意读取文件系统路径。

## 在房间中讨论

创建房间时选择两到六个角色、工作区和主持人。每个成员都会获得独立的消息模式会话。调度只有三条规则：

1. 用户 @ 谁就唤醒谁；`@everyone` 或 `@所有人` 选择全部成员。
2. 用户没有 @ 任何人时交给主持人。
3. Bot 消息只唤醒它 @ 到的成员。没有 @ 的发言不会继续触发讨论。

成员依次运行，后发言者能收到前一位的结果。静音成员不会被 Bot 提及和主持兜底唤醒，但用户显式 @ 它时仍会唤醒。成员收到自上次唤醒以来的消息，不重复加入自己已经记录过的发言。

预算限制每条用户消息之后的 Bot 发言数，默认 12 条。用尽后讨论暂停，「继续」会重置预算并恢复保留的任务。「暂停」取消排队唤醒，允许当前轮次结束；「停止所有」还会中断当前轮次，但不回滚已完成的动作。用户发送新消息时，旧的排队唤醒会被取消，正在运行的成员会收到插话，然后再调度新选中的成员。同一时刻房间只展示一张问题卡，后续问题排队。

改名、换主持人或静音不会重写已有系统提示词。修改成员或工作区之前，需要先停止当前轮次。更换工作区会创建新的专属成员会话，并归档旧会话以保留过程历史。自由讨论与房间范围的 `HistorySearch` 不在本次实现中。

## API 入口

SDK 提供 `global.personas`、`global.bots`、`global.rooms`；HTTP 客户端还提供 `rest.personas`、`rest.bots`、`rest.rooms`。列表直接返回数组。创建会话接受 `persona` 和 `delivery`；读取会话会返回 `agent_config.persona = { id, name, avatarUrl? }` 以及 `delivery`。

REST 资源位于 `/api/personas`、`/api/bots`、`/api/rooms`。房间成员、静音、主持人和预算通过 `PATCH /api/rooms/{id}` 更新；暂停、继续和停止分别使用对应的 POST 动作。`GET /api/rooms/{id}/log` 接受 `afterId` 和 `limit`。角色记忆入口为 `/api/memory/persona?persona_id=<id>` 或 `/api/memory/persona_workspace?persona_id=<id>&workspace_id=<workspace>`。

认证与连接方式见 [REST API 指南](../server/rest-api.md)。
