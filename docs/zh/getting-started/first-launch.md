# 首次启动

Kiki 已经装好了。这一页带你走完最初的十分钟：在项目目录里启动、连上模型、拿到第一个有用的回答。

## 启动 Kiki

进入你的项目目录并运行 `kiki`，启动交互式界面：

```sh
cd your-project
kiki
```

如果你在源码检出里开发，请在仓库根目录运行 `pnpm dev:cli`。要在不进入交互界面的情况下执行单条指令，使用 `-p`（prompt 模式）：

```sh
kiki -p "Take a look at this project's directory structure"
```

加上 `-c`（`--continue` 的短写）即可恢复上一次会话；它与 `--session` 等恢复方式的区别见[工作区与会话管理](../guides/sessions.md#启动与恢复会话)：

```sh
kiki -c
```

## 连接模型

Kiki 需要先连上一个模型才能开始回答。在交互界面输入 `/login`：

```sh
/login
```

弹出的选择器提供四个选项：

- **Kimi Code (kimi.com/code)** —— 托管订阅，走设备码授权：在任意设备上打开链接、登录、输入授权码
- **Kimi Code (kimi.ai/code)** —— 同一套流程，对应国际站端点
- **Kimi Platform (API key · platform.kimi.com)** —— 填入国内平台控制台的 API 密钥
- **Kimi Platform (API key · platform.kimi.ai)** —— 填入国际平台控制台的 API 密钥

输入 `/logout` 可以清除当前凭据。

::: tip 其他平台
Anthropic、OpenAI、Google 等平台在 `~/.kiki/config.toml` 中配置，见[平台与模型](../configuration/providers.md)。全部可配置项分散在[配置文件](../configuration/config-files.md)、[环境变量](../configuration/env-vars.md)和[配置覆盖](../configuration/overrides.md)三页。
:::

如果不用终端，桌面应用和浏览器界面首次启动时会打开一个设置向导，同样是三步：

1. **语言与外观** —— 每选一项，弹窗后面的窗口会即时预览。
2. **权限** —— 选择新会话的默认权限模式。推荐「自动」：在工作区内自主执行，涉及敏感或外部操作时先问你。
3. **先逛逛 Kiki** —— 五条导览路线各占一行：完整概览「带我逛一圈」（工作台、会话、记忆、能力和定时，各停一站），或从你感兴趣的事开始——「先做一件事」「看懂与指挥工作」「让工作持续」「按需扩展 Kiki」。点哪一行就直接开始那条路线并结束向导；这份导览和侧栏的「发现 Kiki」入口是同一份，进度和继续提示都只有一处。

任何一页都可以跳过，之后再补。向导不连接模型：它身后的新会话页带着「先连接一个模型」卡片，可以用 Kimi Code、GitHub Copilot 或 ChatGPT（Codex）账号登录，也可以添加 API 密钥；完整的连接表单在 **设置 → 模型与提供商** 里，模板按厂商、网关和本地服务分组，点 **测试连接** 只校验表单里填的值，不会保存。设置中的 **重新进入引导** 可以重跑整个向导。欢迎消息发送时会使用已配置的模型。还没配置模型时，打开输入框里的模型选择器，选择模型或连接提供商，草稿会保留。选好模型后重发同一条欢迎请求，它会使用这次选择的模型和思考强度。连接提供商之后，在 **设置 → 模型与提供商 → 可用模型** 中搜索并星标你要用的模型，新会话会优先使用已星标的模型。

向导不问你用哪个文件夹，末页也不会替你开始什么：点哪条路线就开始那条导览并结束向导，点「关闭引导」则直接关掉弹窗、不开始任何导览。两种方式都不发送任何内容，需要你自己按发送；新会话页下方给出几条起步建议。至于工作目录，新会话页本身仍默认使用最近的工作区，没有时在 Kiki 主目录下新建一个文件夹。这些配置之后也能随时用 `/kiki-ops` 交给 Kiki 帮你完成；模型选择方式见 [Agent 与 subagent](../customization/agents.md#内置-subagent)。

## 你的第一次对话

登录后，用自然语言描述你想要什么。先让 Kiki 熟悉一下项目是个不错的起点：

```text
Take a look at this project's directory structure and briefly describe what each directory is for.
```

Kiki 通过工具（Agent 可调用的内置能力，例如读文件、搜索代码、运行命令）来回答，所以它会先看你的项目再作答，而不是凭空猜测。只读调用不会中途停下来问你。

新会话默认使用 Auto 模式：普通工具调用（包括 Shell 命令）直接执行，访问 `.env`、私钥等敏感文件前会先请求你的审批。用 `/permission` 可切换到 `manual`、`auto`、`review`（「替我审批」，先交给你配置的审查者判断）或 `yolo`；各模式分别会问什么，见[权限模式](../guides/interaction.md#权限模式)。

你也可以跳过这一步，直接给一个具体任务：

```text
Add a function in src/utils that converts any string to kebab-case, and add a unit test for it.
```

Kiki 会规划步骤、修改代码、运行测试，并在每一步告诉你它做了什么。

::: tip 不知道该做什么？输入 `/help`
随时输入 `/help` 打开内置命令和快捷键面板。用 `↑`/`↓` 浏览，`Esc` 关闭。退出可以输入 `/exit`、空闲时连按两次 `Ctrl-C`，或在输入框为空时按 `Ctrl-D`。
:::

## 现在就该记住的命令与快捷键

如果这一页你只记住一段内容，就记住下面这些：

**会话命令**

| 命令 | 说明 |
| --- | --- |
| `/new` | 新建会话，清空当前上下文 |
| `/sessions` | 浏览会话历史并选择恢复 |
| `/model` | 切换当前模型 |
| `/compact` | 手动压缩上下文以释放 token（token 是模型计量文本的基本单位，一段话由多少 token 决定能装进多少上下文） |
| `/fork` | 将当前会话分叉为带完整历史的独立副本（你仍留在当前会话） |

**最常用快捷键**

| 快捷键 | 说明 |
| --- | --- |
| `Esc` | 中断流式输出（内容逐段实时显示的方式）/ 关闭弹窗 |
| `Ctrl-C` | 中断输出；空闲时按两次退出 |
| `Shift-Tab` | 切换 Plan 模式 |
| `Ctrl-S` | 在流式输出中途注入消息，无需等待当前响应结束 |
| `Ctrl-O` | 折叠 / 展开工具输出与压缩摘要（上下文压缩时自动生成的历史摘要） |

完整列表输入 `/help` 查看，或访问[斜杠命令](../reference/slash-commands.md)和[键盘快捷键](../reference/keyboard.md)。

## 数据存储在哪里

Kiki 的本地数据默认放在 `~/.kiki/`：配置文件、会话记录、日志和更新缓存。设置 `KIKI_HOME` 环境变量即可整体换到别的位置。一个例外：未设置 `KIKI_HOME` 时，桌面应用会从兼容家目录 `~/.kimi-code/` 读取 OAuth 凭据。全部路径和各自存放的内容见[数据路径](../configuration/data-locations.md)。

## 下一步

- [交互与输入](../guides/interaction.md) —— 输入框操作、审批流程、Plan 模式与 YOLO 模式说明
- [工作区与会话管理](../guides/sessions.md) —— 恢复会话、任务看板、压缩上下文、导出会话
- [常见使用案例](./use-cases.md) —— 典型任务的提示词示例
