---
title: Agent Profiles
---

# Agent Profiles

**Agent（智能体）**是真正干活的那个东西：读文件、跑命令、调工具、给答案。Kiki 里每个 agent 都由一份 **profile** 定义——一份 Markdown，写明它跑在哪个模型和思考档位上、被怎么指示、可以调用哪些工具、能把手上的活交给谁。写一次，之后每次派发这类 agent 都复用它。

这一页讲 agent 是什么、主 agent 与 subagent 有什么区别，以及怎么选、怎么组合 profile。完整字段参考在 [Agent 与 subagent](/zh/customization/agents)和 [Agent profile 概念与设计](/zh/customization/agent-profiles)。

## 主 agent 和它的 subagent

每个会话里你只面对一个 agent：**主 agent**。它接收你的消息、规划、调工具，产出你看到的回复。当某一块活值得隔离开时，主 agent 会派一个 **subagent** 去做——需要先摸清的代码改动、要并行审的几份实现、要在不占主上下文的前提下规划的大重构。

subagent 拿到任务描述，在自己的隔离上下文里干活，干完交回结论、结束时也会报一声；它完整的推理和工具记录不会整份倒进主 agent 的对话，这正是它让好几条线同时跑、而主上下文不被细节填满的原因。这是上下文隔离，不是封死的盒子：你可以点开任何一个 subagent 读它自己的记录，也可以直接在它的输入框里给它发消息，见[子智能体有自己的记录](/zh/features/workbench#子智能体有自己的记录)。

![一个派发树：主会话派出多个子智能体，每个绑定了自己的模型。](/shots/workbench/workbench-per-role-models.zh.png)

每个 subagent 自己也要消耗模型 token，所以把主 agent 一步就能做完的活交出去是纯多花的钱。剩下的活够不够拆得开，由主 agent 自己判断；你直接点名某个角色时，它会照办。

### 一份 profile 怎么变成主 agent

profile 本身既不是主 agent 也不是 subagent，它是什么取决于怎么被绑定：

- **被选为会话的主 agent**——终端里用 `--agent`，或新建会话时从选择器里选。这就是和你对话的那个。
- **被派发为 subagent**——主 agent 把任务交给它。这是其余所有角色的常态。
- **独立运行**——由外部宿主（某个 MCP 客户端、SDK 调用方，或外部执行器）自行调用它。它不是本会话的 subagent，所以 Kiki 给它的是「独立运行」的交接提示，而不是 subagent 那份；但收结果的一端仍然是那个宿主。

![新建会话页上的 profile 选择器：列出能驱动会话的 profile，以及当前勾选的那个。](/shots/agents/agents-profile-picker.zh.png)

frontmatter 里的 `main: true` 只是把某个 profile 标记为会话主 agent 的**候选**，也就是让它出现在选择器里。它不是授权闸门：派发时显式点名这样一个 profile，它仍然作为 subagent 运行，也永远不会因此变成会话的主 agent。真正的绑定是你选中的那个；这个标记只决定你能选什么。

会话主 agent 跑的是你为这个会话选的模型，它会盖过 profile 里钉的那个。subagent 的模型则另行决定，依次看：派发时显式写的 `model_alias`、它所用 profile 的钉值或模型菜单、最后是 `[subagent].default_model`。profile 没钉、也没配默认值时，这次派发会以 `model.not_configured` 失败，而不是悄悄沿用调用方的模型——除非那个 profile 特意设了 `model_alias: inherit`。所以你在模型选单里定的管的是你正在对话的那个 agent，profile 里钉死的管的是每次以该角色被派发出去的 agent。

### 一个模型，一套共用设置，只在你想要的地方有差异

同一个模型同时服务两种角色时，你不需要把它定义两遍。模型只定义一次——它的 alias、provider、凭据、上下文窗口和支持的思考档位——两种角色共用日常的运行设置，比如默认 effort、service tier、上下文什么时候压缩、以及上下文使用预算。主 agent 可以只覆盖你想要不同的那些，没填的继承共用值；subagent 直接用共用值。

所以同一个模型可以给主 agent 设成高 effort、其他地方用默认，或者让主 agent 在更紧的点触发压缩、而 subagent 保持共用触发点。没有点名的地方就保持共用，而你在会话里显式选的模型或 effort 依然优先。提示词字段同样分共享、主 agent 与独立三种：参数是逐字段继承，旧的提示词身份块仍按整组替换。准确规则见[配置参考 `models`](/zh/configuration/config-files#models)和[模型菜单与硬边界](/zh/customization/agent-profiles#模型菜单与硬边界)。

## 一份文件描述一个角色

**Frontmatter** 装配置——名字、给派发方读的描述、模型与思考强度、工具白名单，以及这个角色自己能派发哪些 subagent。**正文**是 agent 起步时用的系统提示词。不需要别的：profile 就是纯文本，你可以读、可以 diff、可以进版本库。

新装的实例自带三个立刻能用的角色：驱动会话的主 `agent`；通用 subagent `general`，能读写文件、跑命令、搜索；只读的 `explore`，用来摸清陌生代码。

它们都收在**设置 → 智能体**这一页里。主 agent 和 subagent 在同一张列表上并排列出，每行显示它的模型、思考档位，以及它自己能派发哪些子智能体；每个角色来自哪个文件也一并标出，你要改的时候直接就改。

![设置里的智能体列表：主 agent 与 subagent 分组列出，每行带自己的模型、思考档位和可用的子智能体。](/shots/agents/agents-profiles.zh.png)

## 值得自己写的两种角色

另外两个以内置模板的形式提供，因为大部分工作会分成这两种形状：

- **`implementer`** 端到端负责一个技术目标——调查、在授权后实现、验证、带证据交回。它可以用 `explore` 做只读的铺垫，但保留最终的工程判断。
- **`reviewer`** 独立、只读地判断一个决定、一份候选或一次修复，报出问题但不去改。工具被限制，无法编辑或派发。

两个模板都设了 `model_alias: inherit`，也就是除非你钉死，否则这个角色跟着派发它的模型走。你可以在首次启动向导、`/kiki-profile` skill，或**设置 → 智能体**里加入它们。

![设置里的智能体编辑页：指令、描述、何时使用、模型、思考档位、引擎、是否可作主 agent，以及它能派发哪些子智能体。](/shots/agents/agents-profile-editor.zh.png)

改一个角色会打开它自己的页面。表单覆盖了真正要紧的字段——起步用的指令、给派发方读的描述、何时使用、模型、思考档位、引擎、能不能驱动会话、能派发哪些子智能体——旁边还有一个**原文文件**标签页，想直接读写 Markdown 时用它。

什么情况下值得自己写？某类工作反复出现，而且有团队规矩的时候——必须给出文件和行号的审查者、汇报前总要先跑一遍测试的执行者、不许碰生成文件的实现者。从一个已经好用的角色复制，或从内置模板起步，比从空白开始省事。

## 由谁决定跑哪个

你很少需要手动指定 profile。主 agent 会根据每个 profile 声明的 `description` 和 `whenToUse` 派发，所以真正决定分派的就是这两行——它们是写给派发方看的，不是写给你自己看的。你仍然可以引导：直接在对话里点名（「先用 `explore` 把文件理一遍」）。派发是否要停下来问你，取决于会话的[权限模式](/zh/guides/interaction#权限模式)——`manual` 下每次都会变成一个请求，由你读过再接受或拒绝；`auto` 和 `yolo` 则让常规派发直接走。

角色跑在哪儿也由你定。把主 agent、各个子智能体和审查者绑到不同模型或不同厂商，强模型做规划，便宜的跑日常。需要硬性限制时，用 allowlist 锁住某个角色不许用贵的模型；profile 已经维护了一份完整的许可清单时，用 `restrict_models_to_menu: true` 把菜单变成上限。见[平台与模型](/zh/configuration/providers)和[模型菜单与硬边界](/zh/customization/agent-profiles#模型菜单与硬边界)。

改动约 200 毫秒生效，新派发的 agent 立刻用上。已经在跑的会话仍然绑定它启动时的快照，所以在那个会话里用**重建上下文**即可应用改动而不丢掉对话。见[Profile 热刷新与进行中的会话](/zh/customization/agents#profile-热刷新与进行中的会话)。

## Profile 不是角色

profile 是执行配置：工具、权限、模型、思考档位，以及角色起步的提示词。[角色（persona）](/zh/features/people)是身份：它是谁、做什么用、跨会话记住什么。角色卡会写明它挂在哪个 profile 上，换掉这个绑定也不会丢掉身份。

## 下一步

- [Agent 与 subagent](/zh/customization/agents)——字段参考与派发合同
- [Agent profile 概念与设计](/zh/customization/agent-profiles)——profile 放在哪里、什么时候生效
- [一个工作台，好几条线](/zh/features/workbench)——主会话拿派发树做什么
- [每一层都归你](/zh/features/freedom)——提示词覆写、连接、权限模式与 hooks
