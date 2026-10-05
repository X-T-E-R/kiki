# 常见使用案例

下面每一节都是你实际会遇到的场景，附带的 prompt 可以直接发送，也可以按你的项目改写。

## 理解陌生项目

接手没读过的代码前，先开 Plan 模式（Agent 先写出打算怎么做、得到你同意后才动文件）比较稳妥。启动 CLI 时加 `--plan`，或在会话中按 `Shift-Tab`、输入 `/plan`：

```text
帮我梳理这个仓库的整体架构。重点说清楚：
1. 入口在哪里，启动后做了什么
2. 主要模块之间的依赖关系
3. 配置和数据的加载流程
最后画一张简单的模块关系图。
```

也可以聚焦到具体问题：

```text
src/runtime 下的 event loop 是怎么工作的？事件从哪里产生、又被谁消费？
```

```text
这个项目里「权限审批」是怎么实现的？涉及哪些文件，关键类型是什么？
```

调研规模较大时，可以让 main agent（直接与你对话的那个）把任务拆给多个 subagent 并行处理。写法见 [Agent 与 subagent](../customization/agents.md)。

## 实现新功能

说清需求和验收标准。涉及多个文件的改动，先用 Plan 模式确认方案再执行：

```text
在 src/utils 下新增一个 retry 工具：
- 函数签名 retry<T>(fn: () => Promise<T>, options): Promise<T>
- 支持 maxAttempts、initialDelayMs、backoffFactor 三个选项
- 失败时抛出最后一次的错误
- 补一组单元测试覆盖成功、重试后成功、全部失败三种情况
```

结果不对就描述你想要什么，不用自己动手改：

```text
backoff 算了一个固定值，我希望加一点抖动，避免雷击效应。改一下并更新测试。
```

## 修复 bug

把现象、复现步骤和期望行为一次性说清楚，Agent 就不用反过来问你：

```text
跑 npm test 时偶发地报这个错：

  TypeError: Cannot read properties of undefined (reading 'id')
      at SessionStore.update (src/session/store.ts:142:18)

只在并发触发多个 update 的用例里出现。帮我定位原因并修复，最后跑一次完整测试确认。
```

还不知道原因时，先让 Agent 调查，不要直接改：

```text
用户反馈：登录成功后第一次刷新页面会回到登录页，再刷一次就正常了。先帮我排查可能的原因，列出几个最可疑的位置，等我确认方向后再动手改。
```

纯机械的任务可以直接交给它：

```text
跑一遍测试，失败的用例都修掉，跑完再跑一次确认全绿。
```

## 写测试与重构

边界清晰、结果可验证的任务最省心：

```text
src/parser/markdown.ts 目前几乎没有测试。请补一组单元测试，覆盖正常段落、嵌套列表、代码块、表格、引用块和混合场景。用项目里已有的测试风格。
```

```text
把 src/handlers 下重复的「读 body → 校验 → 写日志 → 返回」逻辑抽成一个中间件。改完跑一遍测试，保证现有行为不变。
```

涉及多个文件的重构，先用 Plan 模式确认方案。也可以 `/fork` 出一个副本先试，之后从 `/sessions` 在两者之间切换，原会话不受影响。

## 一次性脚本与自动化任务

批量改文件、跑统计、做调研对比，一段 prompt 就够：

```text
把 src 目录下所有 .js 文件里的 var 声明改成 const 或 let，能用 const 的优先用 const。改完跑一次 lint 确认。
```

```text
分析 logs/ 下最近 7 天的访问日志，按接口路径统计调用次数、p50 和 p99 响应时间，结果输出成一个 markdown 表格。
```

```text
帮我调研一下 TypeScript 里几种主流的依赖注入方案（tsyringe、inversify、awilix），从 API 风格、装饰器依赖、运行时开销三个维度对比，给一份不超过一页的建议。
```

确认安全的批量任务可以不再逐条审批：启动 CLI 时加 `--yolo`，或在会话中输入 `/yolo`，两者都会把会话切到 YOLO 模式，工具调用（包括读取敏感文件）不再询问，除非被权限规则显式拒绝；退出 Plan 模式时仍会审核。想收窄范围，就在[配置文件](../configuration/config-files.md#permission)的 `[permission]` 段为特定工具预置允许规则。

## 定时任务与提醒

在交互式会话里，直接让 Agent 设一次性提醒或周期任务。它会按你的本地时区生成 cron 表达式（描述「什么时间运行」的标准写法），到点把 prompt 重新发进同一个会话：

```text
下午 2:30 提醒我去查一下部署。
```

```text
每个工作日上午 9 点，帮我汇总最近的 CI 失败情况。
```

```text
每小时巡检一次生产环境的健康端点，看到异常就告诉我。
```

```text
大约 10 分钟之后再回来，确认一下构建是否结束。
```

定时计划属于创建它的那个会话。关掉终端没关系，用 `kiki --session` 恢复同一个会话，计划会重新加载并继续触发；全新会话里不会有任何计划。周期计划在 7 天后停止，最后一次触发时 Agent 会收到「已过期」提示，只有你最初的指示要求续期时它才会续。要查看当前有哪些计划，直接问 Agent 即可；要取消某个计划，让 Agent 删除它或给出对应的 8 位 id。工具说明见[定时任务](../reference/tools.md#定时任务)，`KIKI_DISABLE_CRON=1` 可以整体关停定时任务。

## 生成与维护文档

```text
我刚改了 src/auth/login.ts 的接口签名，把对应的 JSDoc、README 里的示例代码、还有 docs/zh/guides 下提到这个接口的段落都同步更新一遍。
```

```text
src/api 下所有公开函数里，凡是没有 docstring 的都补上文档注释，风格参考已有的注释。
```

```text
根据 src/cli 下的命令实现，生成一份命令参考的草稿，列出每个子命令、参数和默认值，放到 docs/zh/reference 下我后续审阅。
```

要留档或复盘，用 `kiki export <sessionId>` 把会话打包为 ZIP；在 TUI 中用 `/export-md` 可以导出可读的 Markdown 对话记录。

## 下一步

- [Agent 与 subagent](../customization/agents.md) — 如何让 Agent 派发子任务并行处理
- [Hooks](../customization/hooks.md) — 在任务完成等节点触发本地脚本
- [内置工具](../reference/tools.md) — Agent 可调用的全部工具参考
