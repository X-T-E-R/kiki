# Plugins

Plugins 把可复用的 Kiki 能力打包成可安装单元——可以添加 [Agent Skills](./skills.md)、自定义 [Agent](./agents.md)、在会话启动时自动加载指定 Skill、提供系统提示词指令，也可以声明 MCP servers 来提供真实工具能力，还可以把别的工具的对话历史作为[可以接着聊下去的 Kiki 会话](#会话历史导入)（或只读归档）带进来。适合把工作流共享给团队、连接外部服务，或从[官方插件](#官方插件)安装扩展。

## 安装与管理

在 TUI 中运行 `/plugins` 打开 plugin 管理器。它是一个面板，有四个 tab：

- **Installed**：管理已装的
- **Official**：Kimi 官方 marketplace plugin
- **Curated**：默认 marketplace 中来自 Kimi 合作伙伴的第三方 plugin
- **Custom**：从 URL 安装

用 `Tab` / `Shift-Tab` 切换。常用按键：

| 按键 | 操作 |
| --- | --- |
| `Tab` / `Shift-Tab` | 在 Installed / Official / Curated / Custom 四个 tab 间切换 |
| `Space` | 启用或禁用选中的已安装 plugin（Installed tab） |
| `D` | 移除选中的已安装 plugin（Installed tab） |
| `M` | 管理选中 plugin 的 MCP servers（Installed tab） |
| `R` | 重新加载 `installed.json` 和所有 manifest（Installed tab） |
| `Enter` | Installed tab：有更新时安装更新，否则查看 plugin 详情 · Official/Curated tab：安装或更新 · Custom tab：安装 |
| `I` | 查看 plugin 详情（Installed tab） |
| `Esc` | 返回或取消 |

也可以直接使用斜杠命令：

| 命令 | 说明 |
| --- | --- |
| `/plugins` | 打开交互式 plugin 管理器 |
| `/plugins list` | 列出已安装 plugins |
| `/plugins install [--trust] <path-or-url>` | 从本地目录、zip URL 或 GitHub 仓库 URL 安装；对已安装的本地来源，重复执行同一路径即可更新。`--trust` 给出[一次知情同意](#安装会运行代码的插件)，会运行自身代码的 plugin 需要它，且只在该来源首次安装时询问 |
| `/plugins marketplace [source]` | 浏览官方 marketplace，或传入自定义 marketplace JSON 的路径或 URL |
| `/plugins info <id>` | 查看 plugin 详情和 diagnostics |
| `/plugins enable <id>` | 启用 plugin |
| `/plugins disable <id>` | 禁用 plugin |
| `/plugins remove <id>` | 移除 plugin（需二次确认） |
| `/plugins reload` | 重读 `installed.json` 与各 plugin 的托管副本。它不会从你的源目录复制任何内容——要应用源目录改动，请再次执行 `/plugins install <path>` |
| `/plugins mcp enable <id> <server>` | 启用 plugin 声明的 MCP server |
| `/plugins mcp disable <id> <server>` | 禁用 plugin 声明的 MCP server |

### 从 GitHub 安装

通过 `/plugins install <url>` 可以直接从 GitHub 仓库安装，支持四种 URL 形式：

- `https://github.com/<owner>/<repo>`：安装最新 release；无 release 时回落到默认分支
- `https://github.com/<owner>/<repo>/tree/<ref>`：安装指定分支、tag 或短 commit SHA
- `https://github.com/<owner>/<repo>/releases/tag/<tag>`：钉死具体 tag
- `https://github.com/<owner>/<repo>/commit/<sha>`：钉死具体 commit

网络请求只走 `github.com` 重定向和 `codeload.github.com` 下载，不调用 `api.github.com`。

### 安装会运行代码的插件

Plugin 的大部分内容是声明式的：Skills、Agent、提示词文本、主题、MCP server 声明。需要做更多事情的 plugin 会附带 entry 文件，Kiki 会把该文件当作以你账号权限运行的 Node.js 代码——plugin 能读你指定的目录、能导入历史文件，靠的就是它。这不是沙箱：这段代码拥有与你本人相同的访问权限。

因此 Kiki 在安装这类 plugin 之前会按来源要求一次知情同意。`/plugins install <source>` 会说明该 plugin 运行受信代码并停下；加上 `--trust` 即表示同意：

```sh
/plugins install --trust ./my-plugin
```

在 GUI 中，安装面板会列出 plugin 新增的能力，以及安装后它能够做什么；需要这次同意时，按钮显示的是**允许并安装**而不是**安装**。

同意按来源记忆，不会按文件、页面或调用逐次要求：

- 再次从同一来源安装或更新不会再问——即使 plugin 的贡献、描述或声明的权限自你批准后已经变化。
- 复用同一个 plugin id 的另一个来源属于新来源，会重新询问。
- 对 GitHub URL 而言，来源是 `owner/repo`，因此在该仓库内切换分支、tag 或 commit 不会重新询问。
- 有一种变化会重新询问：原本没有 entry 文件的 plugin 开始附带 entry。

你批准的是来源，而不是确切的字节：Kiki 在预览时对 plugin 目录取指纹，预览之后文件有变化就拒绝安装。这个指纹保护的是预览，不是之后的每一次动作——来源受信之后，再次安装或更新它不会重新询问，但它产出的工具调用仍按你当前的权限模式与工具规则执行。

### 注意事项

- 本地 plugin 更新会在你当前这段对话里生效。本地 plugin 首次用 `/plugins install --trust <path>` 安装，再用 `/plugins enable <id>` 启用；新安装的 plugin 默认处于未启用状态。改完源目录后，用同一路径再执行一次 `/plugins install <path>`：新代码和 manifest 会替换托管副本，plugin 保持启用，该命令返回后新工具就能在这段对话里使用。不需要 `/plugins reload`、`/reload` 或 `/new`。已同意过的来源不会再次询问 `--trust`。
- 更新会等该 plugin 正在执行的工作结束再切换：已在运行的调用在旧版本上跑完，切换期间到达的调用会排队并在新版本上执行。其他 plugin 不会被重启，继续运行。已经按旧工具定义解析但尚未执行的调用会要求重试，而不是按新规则继续执行。
- `/plugins reload` 是独立的显式全局动作。它重读 `installed.json` 与每个 plugin 的托管副本，且**从不**从你的源目录复制内容，因此不是应用源目录改动的方式。系统提示词指令与 plugin Skill 仍按各自文档的时机重建——见[系统提示词指令](#系统提示词指令)与[插件 Agent](#插件-agent)。
- 本地安装会被拷贝到 `$KIKI_HOME/plugins/managed/<id>/`，CLI 始终从这份托管副本运行。改源目录后重新安装；直接手改托管副本不走同一条更新路径，且之后的重新安装会覆盖它。
- 移除 plugin 只会删除安装记录，托管副本和原始源文件仍保留在磁盘上。
- Plugin 目前按用户安装，对所有项目生效，暂不支持项目级安装范围。

### 自定义 marketplace JSON

浏览 marketplace 时，把 JSON 路径或 URL 传给 `/plugins marketplace <source>`，设置 [`KIKI_PLUGIN_MARKETPLACE_URL`](../configuration/env-vars.md)，或在 `config.toml` 中配置 `[plugins] marketplace_url`。优先级依次为命令 source、环境变量和配置；没有任何 source 时，Kiki 不拉取远程目录，但仍显示内置产品能力。`plugins` 数组中每个条目需要 `id` 和 `source`（本地路径、zip URL 或 GitHub URL）：

```json
{
  "version": "2",
  "plugins": [
    {
      "id": "my-plugin",
      "displayName": "My Plugin",
      "source": "./my-plugin"
    }
  ]
}
```

## 本地文档提取

`kiki-documents` 把本地 PDF、Office、HTML 或文本文件转换成 `Read` 和 `Grep` 可用的 Markdown。通过现有插件管理器安装并启用后，直接让 Kiki 把文件提取到新文件夹，再阅读结果。插件自带官方 `@nb-corp/nb-extract` 0.1.1 的 JavaScript API 和依赖，不需要运行时 npm 安装，也不依赖本机 Skill 源码目录。

HTML（`.html`/`.htm`）、Markdown 和纯文本可以直接处理。本地 PDF、DOCX、XLSX/XLS 和 PPTX 需要在运行 Kiki 的机器上准备 Python 3.10+ 及 MarkItDown 对应格式依赖。一次性创建虚拟环境：

```sh
python -m venv .venv-documents
```

Windows 下安装所需格式：

```sh
.venv-documents/Scripts/python.exe -m pip install "markitdown[pdf,docx,xlsx,xls,pptx]"
```

macOS/Linux 改用 `.venv-documents/bin/python`。只处理 PDF 时使用 `markitdown[pdf]`。在 **能力 → Plugins → Kiki Documents → 设置 → Python with MarkItDown** 中，把 `pythonPath` 设为该环境 Python 可执行文件的绝对路径。插件不会自动安装 Python 或 pip 依赖。

每次提取都创建新目录，包含 `document.md`、记录来源、引擎和 warnings 的 `extraction.json`，以及引擎实际返回的素材。原文件不变，既有输出不会被覆盖。响应中的预览可能缩短，并以 `previewTruncated` 标明；完整正文用 `Read`/`Grep` 读取保存后的 Markdown。MarkItDown 不导出图片，Defuddle 不下载正文中的链接图片。

Auto 默认本地处理，不上传，也不做 OCR。空内容或只有图像的扫描件会报错，不会被称为已读；混合扫描文档仍可能遗漏没有文本层的页面。需要云端 OCR 时，明确授权把该文件上传到 MinerU，配置插件中的 token，再选择 `engine=mineru` 和 `allowUpload=true`。服务条款和费用由 MinerU 决定；停止本地等待不会取消远端任务。缺依赖、不支持格式和字节上限错误不会被报告为完整提取。输入上限为 50 MiB，提取期限为 600 秒。

## 媒体来源

媒体插件会贡献一个或多个*来源*——即图像、视频或语音的提供方。装好媒体插件后，它的来源会出现在**能力 → Plugins → 媒体来源**，是一个可搜索的列表，而不是每家厂商一页。

### 开启生成

生成功能是实验性的，**默认关闭**。本页的其它部分——安装来源、填写设置、选择默认项、查看历史生成——无论是否开启都能用。只有发起新的生成需要它。

按 Kiki 读取的顺序，有三种开启方式：

- 在环境变量里设置 `KIKI_EXPERIMENTAL_MEDIA_GENERATION=1`。
- 在 `config.toml` 的 `[experimental]` 下写 `media_generation = true`。
- 在**设置 → 实验**里打开**媒体生成插件**。

### 列表

每个来源是一行，同时回答三件事：它是哪个提供方、来自哪个包、现在能不能用。行右侧的状态是：

- **可用**——已安装、已启用，且服务端确认了它的配置。
- **需要配置**——服务端报告有必填项缺失。打开这一行补上即可。
- **未检查**——已安装、已启用，但配置还没有被读取。Kiki 不会为了画一个列表去逐个读取每个来源的设置，所以这一状态既不是保证也不是警告。打开这一行就能看到它的设置。
- **不可用**——包没有加载成功，或者被你关掉了。这一行里配的任何东西都不会生成，直到修好为止。
- **受阻**——这个提供方的某个任务因为包没有加载而无法继续。任务被保留，不会被丢弃。

可以按模态（图像、视频、语音）或按状态筛选，也可以直接搜索。每个筛选带旁边的计数是整个列表的数量，不是筛选后的数量，所以筛选不会藏起后面还有多少。

### 配置一个来源

打开某一行就进入它的设置表单。表单就是该包自己的设置——字段、密钥处理方式和保存路径都和插件详情页完全一致，所以提供方的密钥就是插件的密钥。

密钥只写不读。Kiki 只显示是否已保存，绝不再次显示它的值；替换或清空都是一次普通编辑。

一个来源有三种配置方式，表单会直接写明属于哪一种，而不用你自己去猜：

- **它自己的设置。** 你提供 API key，提供方需要的话还有 base URL。只有在未选择连接时，这些字段才是必填的。
- **已有的 Kiki 连接。** 如果该包声明了连接设置，表单会列出你已有的连接。选一个就够了——包自己的密钥和接口地址就不再必填，也完全不会被使用。所选连接必须能解析；如果解析不了，Kiki 不会悄悄退回你之前存的密钥。
- **自行管理。** 脚本可以用它自己的设置、环境变量或外部文件管理凭据。这是受支持的用法，Kiki 不会因为没有密钥就把提供方判成坏的。Kiki 保存的任何内容都不会在日志、预览或报告里回显。

已有的连接并不代表它背后的账号一定能做媒体。Kiki 按提供方实际返回的结果呈现，不维护"哪些连接支持哪些模态"的允许列表。

### 分模态默认项

媒体入口包上的三个设置分别指定图像、视频和语音的默认来源。它们就是普通的插件设置，和该包的其他配置存在一起。某个来源是默认项时，列表会在它那一行标出来。

如果某个模态没有默认项，且只有一个来源能胜任，Kiki 就用它。如果有多个来源能胜任，Kiki 会让你选，而不是替你选一个然后让你付费。

### 最近的生成

同一页面会列出当前会话最近的媒体任务，生成功能关闭时也照常列出。每个任务显示自己的状态，每个已经落地的文件都会列出预览、下载或页内播放。任务状态按实际情况呈现，包括两个容易搞错的：

- **结果不明**——Kiki 无法确认厂商是否已接受这次提交，所以它可能仍在生成并计费。这里不会自动重新生成，也不提供重试按钮，因为重试就是第二次计费。
- **已停止**——Kiki 只是停止了本地等待。厂商是否也停了、是否仍在计费，以厂商返回的为准；这一行会写清楚。

部分完成的任务会保留已经落地的文件。**继续取回**通过拥有该任务的会话和 agent 继续同一个任务——不是走全局捷径——**停止等待**同理。两者都只作用于产出该任务的那个会话。

### 发现来源

从哪里发现新提供方，和已经安装了哪些提供方是两个不同的问题，所以它在页面底部有自己一块可折叠的区域。添加、暂停或移除一个发现来源，不会影响已安装的包、密钥或过往任务。

## 官方插件

官方插件是 Kimi 官方维护的 plugin 和内置产品能力，目前有以下三种：

- **[Kimi Datasource](#kimi-datasource)**：用自然语言查询金融行情、宏观经济、企业工商、学术文献和法律法规
- **[Kimi Browser Extension](#kimi-browser-extension)**：让 AI 直接操控你自己的浏览器，完成各类网页操作
- **[Kimi Computer Use](#kimi-computer-use)**：让 AI 操作你的桌面应用（macOS 和 Windows）

### 安装与升级

官方插件的安装与升级流程一致：

1. 运行 `/plugins`，tab键选择 **Official**
2. 找到要安装的插件，按 `Enter` 安装
3. 安装完成后运行 `/reload` 或 `/new` 激活

::: info 说明
Kimi Browser Extension 分两步安装：完成上述步骤后，还需要[安装浏览器扩展](#安装浏览器扩展)才能使用。
:::

官方插件更新后会在使用旧版时提示更新，不会自动更新，要升级到新版本，重复上述安装步骤即可。

### Kimi Datasource <Badge type="tip" text="v3.3.0" />

Kimi Datasource 是 Kiki 官方数据插件，让你用自然语言直接查询金融行情、宏观经济、企业工商、学术文献和中国法律法规，无需手动调用接口或申请数据账号。

使用前需先通过 `/login` 完成 Kimi Code 账号 OAuth 登录，数据查询会消耗你的 Kimi Code 套餐额度。

#### 使用方式

1. 直接用自然语言描述你的需求，Kiki 会自动调用数据能力
2. 通过 `/skill:kimi-datasource` 明确触发数据查询 Skill

#### 能做什么

**实时量化研究**：盯着茅台想做个量化分析？一句话拉取近三年的每日收盘价、MACD 和 KDJ 信号，直接出结论，不用找第三方数据平台。

**跨国宏观对比**：研究中印越产业转移？基于世界银行 50 年历史数据，一次查询拿到三国 GDP 增速、贸易额、人口结构的完整时间序列对比。

**合同前风险排查**：签合同前五分钟才想起来要查对方背景？输入公司名，立刻拿到工商注册信息、股权穿透、司法纠纷和失信记录，当场决策。

**文献综述加速**：写论文要梳理 RLHF 领域的研究脉络？直接列出高引论文、主要作者和核心结论，综述提纲半小时内成型。

**法律条文速查**：碰上居住权的合同纠纷，拿不准法条？一句话定位《民法典》相关条文原文、效力级别和时效性，再顺手拉几个相近判例佐证，不用翻法规库。

**机构级美股研究**：写美股深度报告？一句话拉出年报原文、标准化财务指标、前 50 大股东和分析师一致预期，不用在多个数据终端之间来回切。

#### 数据覆盖

| 类别 | 覆盖范围 |
|---|---|
| 股票与金融市场 | Wind、S&P Capital IQ、SEC EDGAR 等知名数据库，能力涵盖 A 股、港股、美股等主要市场的行情、技术指标、财报估值、分析师预期，以及 8,000+ 美股上市公司的官方披露文件 |
| 宏观经济 | 世界银行、IMF 等知名数据库，能力涵盖全球 189 个国家 50 年以上的时间序列：GDP、贸易、人口、汇率、CPI、国际收支、GDP 预测等 |
| 企业数据 | 中国大陆境内企业工商信息、股权穿透、司法风险、关联图谱 |
| 学术文献 | 物理、数学、计算机、金融、经济等领域百万量级论文，支持预印本查询 |
| 法律法规 | 中国法律法规与司法案例：各效力层次的法规检索与详情，普通及权威判例检索 |
| 智能筛选 | 恒生聚源等知名数据库，能力涵盖自然语言选股、选基金、选基金经理，以及宏观行业数据、研报、公告与新闻 |

#### 计费与限制

- 数据查询按次计费，消耗 Kimi Code 账号额度
- 插件为只读查询，不提供任何写入或交易功能
- 技术指标（MACD、KDJ 等）及实时行情仅在交易时段内可用
- AI 输出内容仅供参考，不构成任何投资或商业决策建议

<a id="kimi-webbridge"></a>

### Kimi Browser Extension <Badge type="tip" text="v1.11.4" />

Kimi Browser Extension 让 AI 直接操控你的浏览器，带着你的登录状态和 Cookie，AI 可以像你一样打开网页、阅读内容、点击按钮、填写表单、截图保存，把重复繁琐的网页操作交给它完成。产品介绍见 [Kimi Browser Extension 官网](https://www.kimi.com/zh-cn/features/webbridge)。

<a id="install-the-browser-extension"></a>

#### 安装浏览器扩展

通过 `/plugins` 安装后，还需要在浏览器中安装 Kimi Browser Extension 扩展，AI 才能操控你的浏览器。有两种安装方式：

**方式一：应用商店安装（推荐）**

打开 [Chrome 应用商店](https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc)或 [Edge 应用商店](https://microsoftedge.microsoft.com/addons/detail/kimi-webbridge/bnlffdbcfnanfbknnlaflhlhkocccckg)，点击添加即可。

**方式二：手动安装**

无法访问应用商店时使用这种方式，按以下步骤操作：

1. [下载扩展安装包](https://kimi-web-img.moonshot.cn/webbridge/latest/extension/kimi-webbridge-extension.zip)并解压
2. 在浏览器地址栏输入 `chrome://extensions/` 打开扩展管理页，开启右上角的**开发者模式**

   ![开启开发者模式](../../media/webbridge-dev-mode.jpeg)

3. 点击左上角的**加载未打包的扩展程序**，选择解压后的 `kimi-webbridge-extension` 文件夹

   ![加载未打包的扩展程序](../../media/webbridge-load-unpacked.jpeg)

4. 装好后，浏览器工具栏会出现 Kimi Browser Extension 图标，看到图标即安装成功，之后就可以让 AI 帮你操作网页了。

   ![工具栏出现 Kimi Browser Extension 图标](../../media/webbridge-install-success.jpeg)

#### 能做什么

- **网页操作自动化**：你说话，AI 帮你点网页、填表单、读内容、截图，重复性的网页操作交给它就好
- **社媒热点选题**：自动浏览 X（Twitter）、微博、小红书的热门话题，筛选你感兴趣的方向，逐个打开高赞内容截图、提取核心观点，整理成素材库并给出选题建议
- **求职信息搜集**：在招聘网站按条件筛选岗位（关键词、城市、岗位类型），把岗位名称、链接、公司、薪资、投递方式整理成表格
- **竞品分析**：自动在多个 AI 产品间批量发问并采集回答，生成横向对比报告
- **机票比价**：在多个旅行平台查询同一行程，按价格排序记录航司、起降时间和原始链接，给出推荐方案

### Kimi Computer Use <Badge type="tip" text="v0.5.4" />

Kimi Computer Use 让 AI 直接操作你的桌面应用，可以完成点击、拖拽、滚动、输入等操作。macOS 版全程在后台静默运行，不抢占你的鼠标（少量弹窗操作仍会唤起前台 App）；Windows 版的差异见[下文注意事项](#windows-版注意事项)。

#### 授权（macOS）

安装后首次使用时，Kimi Computer Use 会弹出授权窗口，按照提示操作即可：

1. 点击**辅助功能**和**屏幕录制**右侧的**去授权**，在系统设置中开启这两项权限。前者用于执行点击、输入与滚动，后者用于读取屏幕内容、识别需要操作的位置
2. 在**接入本地 Agent**中打开 **Kiki** 开关，重启 Kiki 后生效

<div style="max-width: 380px; margin: 0 auto;">

![Kimi Computer Use 授权窗口](../../media/kimi-computer-use-auth.jpeg)

</div>

#### Windows 版注意事项


- **会短暂占用键鼠**：Windows 版无法像 macOS 版那样稳定地全程后台输入，执行操作时可能短暂激活目标窗口并使用你的鼠标键盘
- **系统要求**：Windows 10 version 1903（Build 18362）或更新版本 / Windows 11，x64；需要真实交互式桌面会话，Windows Server 需要 Desktop Experience
- **无需额外授权**：Windows 不需要 macOS 那样的**辅助功能**和**屏幕录制**权限
- **权限对等**：目标应用以管理员权限运行时，KimiCU 也需要以同等权限运行

#### 能做什么

- **在桌面软件整理和录入信息**：让 AI 把散落在各处的信息整理进备忘录、表格或笔记软件，不用手动逐条输入
- **测试网站和应用流程**：将重复的测试步骤交给AI，截图确认渲染和跳转是否正常
- **处理重复操作**：反复打开、复制、粘贴、检查类型的工作，让AI在后台静默完成，不抢占鼠标
- **搞定没有接口的软件**：操作没有 CLI 或 API 的桌面端应用，例如让它把剪映里这段视频的片头剪掉三秒再导出

::: warning 注意
涉及资金、账号和对外发布的操作不建议使用此能力。
:::

## Plugin manifest

Plugin 是一个带 manifest 的目录或 zip 文件。Manifest 可以放在以下任一位置：

```text
<plugin_root>/kimi.plugin.json
<plugin_root>/.kimi-plugin/plugin.json
```

两个文件同时存在时，以 `kimi.plugin.json` 为准。

示例：

```json
{
  "name": "kimi-finance",
  "version": "1.0.0",
  "description": "Finance data and analysis workflows for Kiki",
  "skills": "./skills/",
  "systemPromptPath": "./SYSTEM.md",
  "sessionStart": {
    "skill": "using-finance"
  },
  "interface": {
    "displayName": "Kimi Finance",
    "shortDescription": "Market data and financial analysis workflows"
  }
}
```

支持的字段：

| 字段 | 说明 |
| --- | --- |
| `name` | 必填，作为 plugin id。必须匹配 `[a-z0-9][a-z0-9_-]{0,63}` |
| `version`、`description`、`keywords`、`author`、`homepage`、`license` | 展示元数据 |
| `interface` | 在 `/plugins` 中展示的字段：`displayName`、`shortDescription`、`longDescription`、`developerName`、`websiteURL` |
| `icon` | 插件包内 `.svg` 或 `.png` 文件的 `./` 路径（上限 64 KB）。`GET /api/plugins` 以惰性的 `data:` URI 返回，供 GUI 画在插件旁边 |
| `skills` | 一个或多个 `./` 路径，必须位于 plugin 根目录内。省略时根目录的 `SKILL.md` 被当作单个 Skill root |
| `agents` | 一个或多个 `./` 路径，必须位于 plugin 根目录内，指向含有 [Agent 文件](./agents.md#自定义-agent)的目录。省略时根下的 `agents/` 目录（若存在）被自动采用 |
| `sessionStart.skill` | 在新会话或恢复会话开始时，把指定 plugin Skill 加载到 main agent |
| `skillInstructions` | 每次加载此 plugin 的 Skill 时一并附带的额外说明 |
| `systemPrompt` | plugin 启用期间提供给 Agent 系统提示词的内联指令 |
| `systemPromptPath` | 指向 UTF-8 文本文件的 `./` 路径；同时设置 `systemPrompt` 时，文件内容拼接在内联指令之后 |
| `mcpServers` | MCP server 声明，默认启用，可从 `/plugins` 中禁用 |
| `hooks` | 在 plugin 启用期间于生命周期事件上运行的 hook 规则；见[插件中的 Hooks](#插件中的-hooks) |
| `commands` | 一个或多个 `./` 路径，指向目录或 `.md` 文件，把其中的 Markdown 文件注册为斜杠命令；见[插件斜杠命令](#插件斜杠命令) |

`tools`、`apps`、`inject`、`configFile` 等不支持的运行时字段会显示为 diagnostics 并被忽略。

### 系统提示词指令

短指令可以直接写在 `systemPrompt`，较长内容则用 `systemPromptPath` 指向 plugin 根目录内的文件。两个字段同时存在时，内联文本在前，文件内容在后。文件内容在安装或重载 plugin 时读取，因此修改文件后需要 `/plugins reload` 才会生效。例如：

```json
{
  "name": "code-review",
  "systemPromptPath": "./SYSTEM.md"
}
```

系统提示词贡献在所有界面上都生效：交互式 TUI、`kiki -p` 和 `kiki web`。

`systemPrompt` 字段与 `systemPromptPath` 文件各限制为 32 KB（UTF-8 字节）：超限内容会被忽略，并显示在 plugin 的 diagnostics 中。一次提示词构建最多注入所有已启用 plugin 合计 64 KB 的指令；超出预算的贡献会被跳过并给出警告——单个 plugin 的内联文本与文件合计超过该预算时同样整体跳过。

新会话和新建 Agent 会读取当前已启用 plugin 的指令。正在进行的请求会继续使用已有的系统提示词。`/plugins reload` 会刷新 plugin Skill 列表，并请求重建活跃 Agent 的提示词；如果需要让变更在下一轮前明确收敛，请使用这个命令。安装、启用、禁用或移除 plugin 会立即更新 catalog，后续的提示词重建（例如压缩上下文或修改工具策略后）可能会读取新的指令。从磁盘恢复的 session 会先使用持久化的提示词，后续重建使用当前 plugin catalog。切换 plugin 的 MCP server 不会改变系统提示词指令。

内置 Agent 提示词会自动包含已启用 plugin 的指令。自定义 `SYSTEM.md` 或 Agent 文件完全拥有自己的模板，因此应在希望出现 plugin 指令的位置加入 `${plugin_sections}`。如果自定义模板包含 `${base_prompt}`，且该有效默认提示词已经包含 plugin 块，就不要再重复加入 `${plugin_sections}`。完整变量表见 [自定义 Agent 与 SYSTEM.md](./agents.md#用-system-md-覆盖-main-agent-的系统提示词)。

## 插件斜杠命令

斜杠命令把一段常用提示词存成 `/命令`，输入它就能触发，省得每次重打。

下面是一个最小完整例子，插件目录结构：

```text
kimi-finance/
  kimi.plugin.json
  commands/
    report.md
```

manifest（`kimi.plugin.json`）用 `commands` 字段指出命令文件的位置：

```json
{
  "name": "kimi-finance",
  "version": "1.0.0",
  "commands": "./commands/"
}
```

命令文件 `commands/report.md`。顶部两行 `---` 之间是 frontmatter（描述命令的元数据），下面的正文是触发时发给 Agent 的提示词：

```markdown
---
description: 拉取指定股票的财报并总结
---

拉取 $ARGUMENTS 的最新财报数据，总结营收、利润和关键风险。
```

装好并启用后，在对话里输入：

```text
/kimi-finance:report TSLA
```

Kimi 会把正文里的 `$ARGUMENTS` 替换成 `TSLA`，再执行这段提示词。三处细节分述如下。

### 声明命令（`commands` 字段）

`commands` 填一个 `./` 路径或路径数组，指向 plugin 根目录内的目录或 `.md` 文件：

- 指向**目录**：递归收集其中所有 `.md` 文件，每个各成为一个命令。
- 指向**单个 `.md` 文件**：只注册这一个。
- 指向非 `.md` 或不存在的路径：显示为 diagnostics（`/plugins` 面板里的诊断提示）并被忽略。

### 编写命令文件

命令文件分两部分：可选的 **frontmatter**（顶部两行 `---` 之间的元数据，可写 `name`、`description`）和**正文**（`---` 之后的提示词）。两个字段省略时的回退规则：

- `name`（命令名）：省略时用文件相对 `commands` 路径的路径命名（去 `.md`、`/` 分隔），如 `commands/frontend/component.md` → `frontend/component`；frontmatter 里显式写的优先。
- `description`（命令列表里的说明）：省略时取正文首行非空文字（超 240 字符截断）；正文也为空则显示 `No description provided.`。

### 调用命令与传参

命令自动以插件 id 作前缀（即命名空间），注册成 `<插件名>:<命令名>`，所以上面的命令实际叫 `/kimi-finance:report`，不同插件的同名命令因此不会冲突。

命令后输入的文字会替换正文里的 `$ARGUMENTS`（上例中 `TSLA` 替换掉 `$ARGUMENTS`）。若正文没写 `$ARGUMENTS` 却传了参数，参数不会丢弃，而是以 `ARGUMENTS: <你输入的内容>` 追加到正文末尾。

## Skills 与会话启动

Plugin Skills 使用与普通 [Agent Skills](./skills.md) 相同的 `SKILL.md` 格式，典型目录结构如下：

```text
my-plugin/
  kimi.plugin.json
  skills/
    using-my-plugin/
      SKILL.md
    another-workflow/
      SKILL.md
```

`sessionStart.skill` 在会话启动时把一个 plugin Skill 加载到 main agent，适合放置初始化说明、工作流规则，或把其他工具中的术语映射到 Kiki。它只注入文本，不执行代码。

无论 Skill 通过哪种方式加载（`sessionStart.skill`、`/skill:<name>` 或模型自动调用），`skillInstructions` 都会随该 plugin 的 Skill 一起出现。

## 插件 Agent

Plugin 可以携带自定义 Agent：在 manifest 的 `agents` 字段里声明一个或多个 `./` 目录（或直接在 plugin 根下放置 `agents/` 目录），其中的 Agent 文件与[自定义 Agent](./agents.md#自定义-agent) 格式相同，会在 plugin 启用期间作为 subagent 被 main agent 自动发现和委派。

```text
my-plugin/
  kimi.plugin.json
  agents/
    reviewer.md
```

Plugin Agent 的优先级低于其他文件来源：同名时用户级、额外目录、项目级和 `--agent-file` 的 Agent 都会覆盖 plugin 提供的版本；替换内置 Agent 同样需要在 frontmatter 里显式写 `override: true`。安装、启用、禁用或移除 plugin 后，Agent 列表在新会话（或 `/reload`）时刷新；当前会话也会在 `/plugins reload` 后刷新。

## Plugin 中的 MCP servers

当 plugin 需要真实工具能力时，可以在 manifest 中声明 `mcpServers`，复用 [MCP](../server/mcp.md) 的 schema。

Stdio server（本地命令）：

```json
{
  "mcpServers": {
    "finance": {
      "command": "uvx",
      "args": ["kimi-finance-mcp"]
    }
  }
}
```

HTTP server（远程服务）：

```json
{
  "mcpServers": {
    "docs": {
      "url": "https://example.com/mcp"
    }
  }
}
```

对于 stdio servers，`command` 可以是 `PATH` 上的命令，也可以是 plugin 根目录内以 `./` 开头的路径。`cwd` 同理，必须以 `./` 开头并位于 plugin 根目录内，否则该 server 会被忽略。

Plugin MCP servers 会在 `/reload` 后或新会话中启动。启用或禁用某个 server：

```sh
/plugins mcp disable kimi-finance finance
/reload

/plugins mcp enable kimi-finance finance
/reload
```

### Notion 资料与写回

`kiki-notion` 是 Kiki 维护的连接配置与工作流，使用 [Notion 官方托管 MCP](https://developers.notion.com/guides/mcp/get-started-with-mcp)，并非 Notion 背书的集成。在仓库根目录运行 `/plugins install --trust ./plugins/official/kiki-notion`，再运行 `/plugins enable kiki-notion`；解压包则换成其目录。在**能力 → MCP** 中对 `plugin-kiki-notion:notion` 完成现有浏览器 OAuth 授权，无需新增 token 字段。若已打开的对话尚未发现新 MCP 连接，用 `/reload` 或新对话加载。

请 `/skill:notion-workspace` 搜索指定页面、teamspace 或工作区，读取关键原文，把带来源链接的简报保存到本地路径。需要回存时，给出目标页面 URL/ID 以及追加或更新意图。只总结不会修改 Notion；明确的写回请求不增加插件专属重复确认，Kiki 原有工具审批仍适用。套餐与工具限制、过滤条件被忽略、缺失 subtree 和异步写入未完成都会明确报告，不会被当成完整覆盖或写回成功。访问还取决于工作区权限与管理员政策；安装不授权升级套餐或付费。

Notion 内容可能发送给你选用的模型供应商，保存在 Kiki 对话历史和指定本地文件中。插件不建立独立索引或凭据库。禁用或移除不会删除这些产物或撤销 OAuth；按需在 MCP 管理入口断开，并在 Notion **设置 → 连接**撤销服务访问。现已验证包与脚本控制的合成 MCP 调用链，尚未验证真实账号认证/写入及模型自主执行。原创插件包采用 MIT 许可，远程服务与工作区内容遵循适用的 [Notion 条款](https://www.notion.so/terms)。

## 插件中的 Hooks

plugin 可以在其 manifest 中声明 hook 规则，在 plugin 启用期间于生命周期事件上运行。每一项使用与 [`config.toml` 中的 `[[hooks]]` 规则](./hooks.md#配置)相同的字段（`event`、`matcher`、`command`、`timeout`）：

```json
{
  "hooks": [
    {
      "event": "PreToolUse",
      "matcher": "Bash",
      "command": "node ./hooks/check-bash.mjs",
      "timeout": 5
    }
  ]
}
```

plugin hooks 复用与全局 hooks 相同的机制——事件列表、stdin JSON 载荷以及退出码和返回值如何影响主流程，详见 [Hooks](./hooks.md)。区别如下：

- plugin 的 hooks 仅在 plugin **启用**期间生效；禁用 plugin 后其 hooks 停止运行。
- 每条 hook 的工作目录为 plugin 根目录，因此 `command` 可以使用 plugin 内的 `./` 路径。
- hook 进程会额外收到两个环境变量：`KIKI_HOME` 和 `KIKI_PLUGIN_ROOT`（plugin 根目录）。

仅安装 plugin 本身不会运行其 hooks——它们只在 plugin 启用期间、匹配的事件触发时运行。

## 会话历史导入

Kiki 内置历史导入，可以把别的工具里的文字对话变成**可以接着聊下去的 Kiki 会话**，或存成只读归档。Claude Code、Codex、Pi、Grok Build、OpenCode 导出文件和自定义 JSON／脚本无需安装、信任或启用插件。导入在 Kiki 服务端运行，不需要模型，也不会修改来源文件；第三方插件仍可通过同一套来源契约增加格式。

历史导入默认开启，但不会在启动时扫描目录或自动导入。需要关闭时，用 `KIKI_EXPERIMENTAL_PLUGIN_IMPORT=false` 启动 Kiki，或在 `config.toml` 的 [`[experimental]`](../configuration/config-files.md#experimental) 下设置 `plugin_import = false`；原开关名称保留，见 [环境变量](../configuration/env-vars.md#运行时开关)。

### 导入一段对话

导入不需要 plugin：这些格式由 Kiki 自己提供。打开**新会话**，在起步项旁选择**导入历史**；或经 **能力** → **插件** → **导入历史**。之后的步骤是：

1. 先选这段对话会变成什么。默认是 **Kiki 会话**：这段对话会成为这个 Kiki 里的一个会话，前面的对话成为它的上下文，打开就能从原来断掉的地方接着聊。**只读归档**则把它保存成一份可读但不能继续的记录。
2. 选会话时，再选它工作的**工作目录**。你已有的工作区一键可选；没保存过的工作区也能手填或浏览选择——在没打开过的文件夹里开一个会话本来就是这么用的。浏览不会注册任何东西：只有导入真的落到那里，这个文件夹才被用上。
3. 选一个格式。Claude Code、Codex、Pi、Grok、OpenCode 都是内置的，自定义脚本也是；到这里不需要安装、信任或启用任何东西。第三方 plugin 自带的来源在安装并启用后也会出现在这里。
4. 选择**来源主目录**，也就是那个工具在它自己所在机器上存放历史的文件夹。Kiki 只读这个目录。
5. 从列表里选一段对话。历史很多的目录会分页列出。
6. 先看预览：它说明来源能否读懂这段对话、哪些内容会保留、哪些不会带过来，以及结果会落到哪里。**完整读取**表示来源读完了整段对话，**样本**表示只读到一部分。
7. 选择**导入为会话**或**开始导入**。这是这段对话唯一的一次确认：导入按你刚看过的预览执行。

归档写进当前窗口所连 Kiki 服务端的 home——**导入到**会写明是哪一个；会话则在你选的工作目录里、同一台服务端上创建。两者都不会落到来源目录里。预览属于生成它的服务端，因此换连到另一个 Kiki 之后需要重新预览。

进度按从来源读到的字节数汇报；服务端还没测出大小的来源会显示不确定的进度，而不是一个百分比。**停止导入**结束正在运行的导入；被停止、失败或因重启中断的导入会保留进度，并提供**继续导入**。导入完成后，变成会话的那条提供**打开会话**，变成归档的那条提供**打开归档**——不会两个都出现，因为它只写出其中一种。

### 会话保留什么、不保留什么

会话导入把这段对话变成 Kiki 可以接着往下聊的上下文，这也是迁移能无痛进行的原因，但它和归档给的承诺不是一回事。用户与助手的文字成为会话里已有的对话轮次。旧对话里的工具调用会以「这件事已经发生过」的文字形式进来：它不会被重跑，在这里也不授予任何权限。另一个工具的系统指令、元数据、用量、审批和进行中的任务不会被装成这个 Kiki 自己的状态，预览会把这一点列为一条损失。

把同一来源对话的同一 revision 再次导入同一个工作目录时，会复用已有会话，不会替换你在 Kiki 中续聊的内容；预览会在开始之前说明这一点。revision 有变化时会创建新会话，原来那个不受影响。

打开迁入的会话和打开任何会话一样需要模型：导入和阅读不需要，发出下一条消息才需要。

### 归档保留什么、不保留什么

归档是历史，不是进行中的对话：它无法继续，打开它也不会把内容加进当前 session。它本身也不是一个 session——不会出现在会话列表里，而是在导入页自己的归档列表中读取，不需要模型。记录保留它们在原工具里的角色——user、assistant、system、工具调用、metadata——但不会重放任何内容。历史里的工具调用只是一条记录；在原工具里属于系统指令的文本不会在这里被执行。原工具记录的外部 token 用量留在 metadata 里，不计入本机消耗。

预览里的损失列表正是告诉你「不会得到什么」的部分，导入前先读它：

- **附件不会被复制。** 图片、文档或其他嵌入文件会在正文里留下占位符和一条带数量的损失记录；它周围的对话仍然可读。
- **不认识或省略的内容会被报告。** Claude Code 和 Codex 可以把未知行保留为 metadata；其他规则把不支持的记录或部件报告为带数量的损失，不会把省略当作完整保留。
- **损坏的输入不会被藏起来。** Claude Code 和 Codex 将无法解析的行列为损失；Pi、Grok、OpenCode 和随包自定义 JSON 读取器遇到无效 JSON 或必要关联损坏时直接拒绝，不会静默跳过。预览会区分抽样和完整读取。

Claude Code 和 Codex 会拒绝嵌套超过 20 层的来源目录和超过 128 MiB 的单条输入行。Pi、Grok、OpenCode 和随包自定义 JSON 读取器限制每个输入文件为 64 MiB；Grok 的 summary 与 updates 文件各有这个上限。自定义脚本负责自己的输入限制，并应如实报告。

Kiki 用来源、来源主目录和原工具自己的对话 id 标识一段对话，并把预览时看到的 revision 当作它的内容版本。再次导入同一 revision 会复用已有归档；对话有变化时，会作为该归档的新 revision 导入。如果文件在预览与导入之间发生变化，导入会失败，已有归档保持不变。归档可以按标题或来源 id 查找——这是对你已导入内容的查找，不是全文检索。

当窗口连接的是另一台机器上的 Kiki 时，那台服务端的来源、导入和归档在这里都可读，但开始、停止和继续导入属于拥有该 home 的那台机器。

### 内置格式与自定义脚本

选择包含下列格式的目录，不一定是原工具的整个 home。OpenCode 需先把会话导出为本地 JSON 文件。

| 来源 | 支持的输入 |
| --- | --- |
| Claude Code | JSONL 历史；选择活动的 UUID／parent 对话路径，把压缩摘要保留为文字 |
| Codex | 旧式及当前 rollout JSONL；选择对话消息，不重复导入对应的事件镜像 |
| Pi | v3 会话 JSONL 的活动 parent 分支；非活动分支、thinking 和附件列为损失 |
| Grok Build | 含 `summary.json` 和 `updates.jsonl` 的会话目录，或 `session-migrate.grok.v1` bundle；ACP 文字片段和已完成工具结果变成可读历史 |
| OpenCode export | 官方 `{info,messages:[{info,parts}]}` JSON 导出或本地保存的 flat share 数组；不读取 `opencode.db`，不迁入 SQLite 状态 |
| Custom JSON / script | 默认读取包含消息数组或 `{title,messages}` 的 `.json` 文件；消息需有已知 `role` 和字符串 `text` 或 `content` |

其他格式可选择 **Custom JSON / script**，把 **Custom import script** 设为 Kiki 服务端上 JavaScript ES 模块的绝对路径。来源设置沿用现有设置接口，内部 id 为 `kiki-history`；它不是已安装插件。也可在 `config.toml` 中设置：

```toml
[plugin_settings.kiki-history]
customScript = "C:/imports/my-format.mjs"
```

留空使用随包 JSON 读取器。脚本导出 `discover(input, context)`、`probe(input, context)` 和 `parse(input, context)`，使用 [下文的来源方法形态](#编写导入来源)；无需插件 manifest、`register(api)` 或 SDK 依赖。`context` 提供 `signal` 和 `settings`。可复制改写独立的 [custom JSON 示例](https://github.com/X-T-E-R/kiki/blob/main/packages/agent-core-v2/src/app/pluginImport/builtin/examples/custom-json.mjs)，发行版内置资源也包含同一文件。

只选择可信代码：自定义脚本以你的账号权限运行在 Node.js 中，不是沙箱。选择脚本就是明确选择执行它，不需要额外安装或逐次审批。修改代码或设置会改变预览 revision，导入前须重新预览；Kiki 仍按共享来源契约检查脚本返回的记录和分页。

### 编写导入来源

导入来源只是 plugin 能声明的一种贡献，所以它写在同一个 manifest 里：在 `x-kiki.sessionSources` 中列出，把 `x-kiki.entry` 指向一个 ES 模块，并在该模块里导出 `register(api)`。manifest 声明 plugin 提供什么，entry 负责读取。

```json
{
  "name": "acme-history",
  "version": "0.1.0",
  "description": "Import Acme conversations into read-only archives",
  "x-kiki": {
    "engines": { "kiki": "^0.4.0" },
    "permissions": { "fs": "outside" },
    "entry": "./entry.mjs",
    "sessionSources": [
      {
        "schemaVersion": 1,
        "id": "acme-export",
        "label": "Acme export",
        "formatVersion": "acme-json-v1"
      }
    ]
  }
}
```

- `sessionSources` 列出这个 plugin 注册的来源。每个 `id` 需匹配 `[a-z0-9][a-z0-9-]{0,63}`，且在 plugin 内唯一；`label` 是来源选择器里显示的文案，`formatVersion` 说明你读取的格式。manifest 声明了、但 entry 从未注册的来源，在使用时会直接失败，而不是静默地什么都不做。
- 带 session sources 的 plugin 必须有 `entry`，且必须解析到 plugin 根目录内。Kiki 会在它自己的 Node.js 进程里把它作为 ES 模块加载，因此 TypeScript 要构建成你在这里指定的那个文件。
- `permissions.fs: "outside"` 是导入器为读取 workspace 之外的目录而声明的权限，来源主目录就是这样的目录。只要 plugin 声明了 Kiki 贡献，就必须写 `engines.kiki`。

适配器提供三个方法，传给 `registerSessionSource` 的 definition 必须是 manifest 里声明的那个：

- `discover` 列出某个来源主目录里的对话，按传入的 `cursor` 分页。
- `probe` 汇报一段对话：内容 `revision`、标题、`status`（`preserved`、`partial` 或 `unsupported`）、损失、总大小，以及规范化的 `sourceHome`。归档身份包含这个 home，因此同一个目录只应返回一种写法，别让用户用两种写法得到两个归档。
- `parse` 分页返回记录，并给出续读用的 `cursor`。读者停止导入、plugin 被卸载或单页超时时，`context.signal` 会被中止；`context.settings` 携带 plugin 自己的设置。

诚实的来源比看起来完整的来源更有价值：每条损失都给出 `code`、`count` 和 `detail`，而不是只导入你能读懂的部分；也不要把你读到的历史文本当成要执行的指令。每条记录最多承载 49,152 个 UTF-16 代码单元，更长的消息会拆成共享同一个 `id`、带 `part`、`textOffset` 和 `textTotal` 的多条记录。

下面这个例子是针对一个存放 `history.json` 的目录的可用来源；记录、分页和 probe 的形态来自公开的 `@kiki/plugin-sdk` 包，它的 `session-import` 入口导出这些类型。

```ts
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { PluginRegistrationApi, SessionSourceAdapter } from '@kiki/plugin-sdk';
import type {
  ImportDiscoveryPage, ImportParsePage, ImportProbe, ImportRecord, SessionSourceDefinition,
} from '@kiki/plugin-sdk/session-import';

const definition: SessionSourceDefinition = {
  schemaVersion: 1, id: 'acme-export', label: 'Acme export', formatVersion: 'acme-json-v1',
};

type Message = { role: ImportRecord['role']; text: string; timestamp?: string };
type Conversation = { id: string; title: string; messages: Message[] };

async function conversations(home: string): Promise<Conversation[]> {
  if (!path.isAbsolute(home)) throw new Error('Choose an absolute source folder');
  const file = await realpath(path.resolve(await realpath(home), 'history.json'));
  return JSON.parse(await readFile(file, 'utf8')) as Conversation[];
}

function find(all: Conversation[], externalId: string): Conversation {
  const found = all.find((conversation) => conversation.id === externalId);
  if (found === undefined) throw new Error('That conversation is no longer in this folder; list it again');
  return found;
}

const revisionOf = (conversation: Conversation): string =>
  createHash('sha256').update(JSON.stringify(conversation)).digest('hex');

/** One record per 49,152 UTF-16 code units of text, with the offsets a reader needs to reassemble it. */
function records(conversation: Conversation): ImportRecord[] {
  return conversation.messages.flatMap((message, index) => {
    const split: ImportRecord[] = [];
    for (let part = 0, offset = 0; part === 0 || offset < message.text.length; part++) {
      let end = Math.min(message.text.length, offset + 48 * 1024);
      if (end < message.text.length && /[\uD800-\uDBFF]/.test(message.text[end - 1])) end--;
      split.push({
        id: `${conversation.id}:${index}`, part, role: message.role, text: message.text.slice(offset, end),
        timestamp: message.timestamp, textOffset: offset, textTotal: message.text.length,
      });
      offset = end;
    }
    return split;
  });
}

const adapter: SessionSourceAdapter = {
  async discover({ home }): Promise<ImportDiscoveryPage> {
    const entries = (await conversations(home)).map((conversation) => ({ externalId: conversation.id, title: conversation.title }));
    return { entries, cursor: null };
  },

  async probe({ home, externalId }): Promise<ImportProbe> {
    const conversation = find(await conversations(home), externalId);
    return {
      revision: revisionOf(conversation), title: conversation.title, formatVersion: definition.formatVersion,
      status: 'preserved', losses: [], totalBytes: Buffer.byteLength(JSON.stringify(conversation)), sourceHome: await realpath(home),
    };
  },

  async parse({ home, externalId, revision, cursor }, context): Promise<ImportParsePage> {
    const conversation = find(await conversations(home), externalId);
    if (revisionOf(conversation) !== revision) throw new Error('The conversation changed; preview it again');
    context.signal.throwIfAborted();
    const all = records(conversation);
    const start = Number(cursor ?? 0);
    const page = all.slice(start, start + 32);
    return {
      records: page, losses: [], bytesRead: Buffer.byteLength(JSON.stringify(conversation)),
      cursor: start + page.length < all.length ? String(start + page.length) : null,
    };
  },
};

export function register(api: PluginRegistrationApi): void {
  api.registerSessionSource(definition, adapter);
}
```

## 安全模型

Plugin 的加载范围有限，以下操作不会在安装或会话启动时发生：

- `tools`、`apps`、`inject`、`configFile` 等不支持的运行时字段只会被忽略，不会执行
- 所有路径在解析符号链接后仍必须位于 plugin 根目录内
- 已启用 plugin 的 MCP servers 会在 `/reload` 后或新会话中启动，且可随时从 `/plugins` 禁用
- 安装 plugin 不会运行它的 entry 文件：plugin 代码在你使用对应能力时才启动，运行在拥有你账号权限的 Node.js 进程中（[不是沙箱](#安装会运行代码的插件)）
- 损坏的 manifest 或不安全路径会显示在 `/plugins info <id>` 的 diagnostics 中，不影响其他会话
