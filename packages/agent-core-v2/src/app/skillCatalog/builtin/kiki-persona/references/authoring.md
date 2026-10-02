# 角色制作参考

## 安装版本与入口

版本匹配的文档在服务器主机的 `<KIKI_HOME>/docs/zh/customization/personas.md`，未设置 KIKI_HOME 时为 `~/.kiki`。保存或导入前读这份文档；API 连接方式见同一文档目录下的 `server/rest-api.md`。GUI「角色」页可创建、编辑、上传头像，以及预览、导入和导出 Character Card V3 的 JSON、PNG、CHARX 卡片。已有客户端可使用原生 persona API，不需要用户手工搬运字段。

CLI 的 `kiki --persona <id>` 和 TUI 的 `/persona list`、`/persona switch <id>` 用于选择；不是创建或校验命令。

## 最小文件

位置：`<KIKI_HOME>/personas/writing-partner/persona.md`。目录名就是 ID，使用小写字母、数字，单个连字符分隔单词。新建前检查 ID 是否占用。

```markdown
---
name: 写作伙伴
title: 中文写作搭档
profile: agent
greeting: 今天想让哪段文字更清楚？
---
你是一位温和但不盲从的中文写作伙伴。先理解文章要传达什么，再指出最影响理解的一处问题，给出具体改写。意见不一致时讲清依据，不为了附和而称赞。保留作者有辨识度的表达。
```

配套 `examples.md` 放在同一目录，使用两三组自然对话，例如：

```markdown
用户：这句「赋能全场景体验升级」是不是很有气势？
写作伙伴：有气势，但读者还不知道具体变好了什么。可以换成「现在手机和电脑都能接着上次的位置继续读」。

用户：先别改，帮我找出最值得保留的部分。
写作伙伴：第二段里那个具体经历值得保留，它让观点有了落点。我们可以先围绕它整理顺序。
```

必需的是非空 `name` 和身份正文。`profile: agent` 复用内置主执行角色；其他 profile 先确认实际存在。执行权限写在 profile，不放进 persona 文件。

仅在需要时添加：`job`（职责）、`greeting` / `greetings`（开场白）、`room_greeting`（房间开场白）、`tags`、`notes`。`model_alias` / `thinking_effort` 使用本机已配置值；`home_workspace` 和 `delivery` 按实际用途设置，普通角色不需要启用 Bot。消息模式的发送工具仍须由所引用的 profile 提供。

`memory.shared` 决定可读取的公共记忆范围，可为 `[global, workspace]`、其中一项或 `[]`；角色私有记忆与其他角色隔离。不写该字段时沿用产品默认共享，不用空列表冒充「默认」。修改已有角色时保持原设置，用户明确要求独立记忆时才调整。

`skills` 可以被保存和回写，但这里不依赖它来裁切工具或自动装载技能；新角色无需添加它，修复已有角色时保留原值。字段集合是封闭的，不自行添加头像路径、工具授权等字段。

## 原生校验与交付

原生保存会校验角色定义；可导入卡片先预览再导入，检查 ID、引用 profile、头像及记忆内容。导入卡片中的背景知识可能转为角色记忆。不要创建 `state.json` 或 catalog；头像通过原生上传入口处理。

文件通过读取并出现在角色列表后，仍需新会话检查绑定与对话。显式选择的 profile 或模型可能覆盖角色预设，因此核对实际使用的值，而不是只读卡片。导出时明确 `includeMemory` 是否开启；普通分享不附带私有记忆。
