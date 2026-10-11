---
title: 带过来，也接得进外面
---

# 带过来，也接得进外面

Kiki 和别的工具相接的方向不止一个，而这些方向承诺的并不是同一件事。这一页把它们分开，因为每一种诚实的说法都不一样：

1. **把你的历史带进来**——Kiki 读另一个工具已经产生的对话，把它变成你能接着用的会话。这是读取，不是互通。
2. **让别的工具用 Kiki**——Kiki 作为一个可被调用的服务存在：编辑器通过 ACP 驱动你的会话，Cursor、Claude Code、Codex 这样的工具通过固定席位调用它。
3. **让 Kiki 把别的工具当引擎用**——另一个智能体 harness 跑你的某个子智能体，并且反过来还能调用 Kiki 自己的上下文。

## 把你的历史带进来

Kiki 内置的历史导入把另一个工具的文本对话变成**你能接着用的 Kiki 会话**，或者存成只读归档。Claude Code、Codex、Pi、Grok Build、OpenCode 的导出文件，以及自定义 JSON 或脚本，都不需要插件、不需要信任、不需要启用。导入在 Kiki 服务端运行，不调用模型，源文件原地不动。

打开**新建会话**并选择**导入历史**，或者走**设置 → 会话 → 导入历史**。然后：选这段对话变成什么（**Kiki 会话**是默认项——这段对话在这里变成一个会话，之前的轮次作为上下文，你从另一个工具停下的地方接着做；**只读归档**则把它留成一份能读但不能继续的记录）；选工作目录；选格式；选**来源 home**——另一个工具存放历史的那个文件夹；选一段对话；读预览。预览会说明来源到底能不能读这段对话（**完整读取**还是**抽样**）、会保留什么、不会带过来什么、结果落在哪里。这份预览是这段对话唯一的一次确认。

值得读一读**不会**带过来什么。用户和 assistant 文本会成为会话之前的轮次。旧对话里的一次工具调用会以「这件事已经发生」的文本形式到达——它不会被重跑，在这里也不授予任何权限。另一个工具的系统指令、元数据、用量计数、审批和运行中的任务都不会被安装成这个 Kiki 自己的状态，预览会把每一项都列为损失。附件不会被复制，它们只留下占位和一条计数为损失的记录。

历史导入默认开启，但它不会在启动时扫描文件夹或导入任何东西。见[会话历史导入](/zh/customization/plugins#会话历史导入)。

![导入历史：六个可读的来源，以及一段对话的预览，写明哪些内容不会带过来。](/shots/ecosystem/ecosystem-history-import.zh.png)

## 让别的工具用 Kiki

这就是 Kiki 作为一个服务，有两种形态。

**编辑器驱动你的 Kiki 会话（ACP）。** `kiki acp` 让 Kiki 进入 [Agent Client Protocol](https://agentclientprotocol.com/) 模式，通过 stdin/stdout 讲 JSON-RPC，使编辑器可以直接驱动它的会话、提示词和工具调用。Zed、JetBrains AI Chat 和 Paseo 都支持。方法覆盖面很广：一条正常的智能体流程（initialize → auth → new/load/resume → prompt → cancel，带文件读写和工具审批）都已实现。有几点值得知道：文件读取和写入由客户端执行，Kiki 通过编辑器请求内容，而不是直接读你的机器；如果你的编辑器的 stdio MCP 服务器需要在 Kiki 进程内运行，要用 `kiki acp --allow-client-stdio-mcp` 显式打开。HTTP 和 SSE 的 MCP 转发不需要这个选项。

**外部工具调用 Kiki（席位）。** `kiki seat` 为入站的 MCP 客户端固定一个席位——工作区、主体、权限模式、模型和思考档位在外部工具连上**之前**就定好了，之后调用方改不了。`kiki seat install` 把 stdio MCP 配置写进 Cursor、Claude Code、Codex 或通用客户端自己的配置里。`kiki mcp` 直接跑这条 stdio 边。

见[在 IDE 中使用](/zh/server/ide)、[`kiki acp`](/zh/server/acp)和 [`kiki seat`](/zh/reference/command#kiki-seat)。

## 让 Kiki 把别的工具当引擎用

方向反过来：另一个智能体 harness 跑**你的**子智能体。一个 agent profile 可以带 `executor`，通过 ACP 或 Codex app-server 跑在 Claude Code、Codex、Cursor、Gemini CLI、Kimi CLI、OpenCode 或 Grok Build 上。设置 → 外部引擎会检查每个引擎是否已安装，并列出还差哪些配置步骤。

![外部引擎列表：每个引擎的安装状态、Kiki 能在它上面设置什么，以及仍然存在的检查明细。](/shots/ecosystem/ce-20261005-ecosystem-engines.zh.png)

在使用外部引擎的会话中，输入框的模型选择器列出的是该引擎报告的模型，而不是 Kiki 原生模型的别名。你也可以直接填写引擎模型 ID。已选 ID 不再出现在目录里时，选择器保留它并标注 "不在此引擎的列表中"，不会擅自替换。引擎报告的实际运行模型也不会改写你的选择。

选择器底部用一行说明目录读取的状态：读取是最新时这一行为空；观测超过一分钟时显示 **上次读取在一分钟前。**；上次刷新失败时显示失败原因。点击 **刷新** 会重新向引擎请求，不会发送草稿。未知不等于不支持：能力结论出现在它管辖的控件上。明确声明不支持在此切换模型的引擎会在选择器处说明，并附上引擎自己的细节；上下文计量器只在引擎声明支持时提供手动压缩，否则会说明引擎是拒绝了还是尚未回答。

席位是外部工具调用进来的固定地点；外部执行器是 Kiki 派发出去的地方。当外部 harness 充当主智能体时，`allow_kiki_subagents: true` 允许它反过来派发 Kiki 子智能体，而 `kiki_context` 可以把 Kiki 自己的原生上下文——记忆、看板、cron、线程、历史、hooks——通过同一座桥暴露给它，子智能体完成后再排队回到主智能体。这座桥上 profile 的工具策略、派发策略、模型约束和通知策略依然生效。

见[外部 main agent 的委派](/zh/customization/agents#外部-main-agent-的委派)和[外部 main agent 的 Kiki 上下文](/zh/customization/agents#外部-main-agent-的-kiki-上下文)。

## 下一步

- [会话历史导入](/zh/customization/plugins#会话历史导入)——把别的工具的历史带进来
- [在 IDE 中使用](/zh/server/ide) 和 [`kiki acp`](/zh/server/acp)——在编辑器里用 Kiki
- [`kiki seat`](/zh/reference/command#kiki-seat)——外部工具调用 Kiki
