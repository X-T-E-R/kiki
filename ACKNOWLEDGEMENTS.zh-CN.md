# 致谢

Kiki 建立在很多人的工作之上。这一页列出 Kiki 复用了代码的开源项目，以及只借鉴了思路、没有用到其代码的项目，并写明 Kiki 从每个项目拿了什么、对应的许可证。

桌面应用中改编代码所依据的上游固定版本，见 [apps/kiki-gui/ATTRIBUTION.md](apps/kiki-gui/ATTRIBUTION.md) 和 [apps/kiki-gui/THIRD_PARTY_NOTICES.md](apps/kiki-gui/THIRD_PARTY_NOTICES.md)。

## 代码复用

以下项目的代码被 Kiki fork、内置、移植、改编，或作为依赖直接使用。

- **[Kimi Code](https://github.com/MoonshotAI/kimi-code)**（MIT）。Kiki 最初是 Kimi Code 的整树 fork：CLI、智能体引擎、协议包、插件和文档都从这里长出来。原版权声明保留在 [LICENSE](LICENSE) 中。
- **[pi-mono / pi-tui](https://github.com/earendil-works/pi-mono/tree/main/packages/tui)**（MIT）。终端界面运行在 `packages/pi-tui` 里内置的 pi-tui 副本上，包括它的差量渲染器、编辑器和 Markdown 组件。许可证保留在 `packages/pi-tui/LICENSE`。
- **[OpenTUI](https://github.com/anomalyco/opentui)**（MIT）。pi-tui 里把终端原始输入切分成完整转义序列的 stdin 缓冲，基于 OpenTUI 的代码。
- **[codeg](https://github.com/xintaofei/codeg)**（Apache-2.0）。桌面应用改编了 codeg 按需加载 Streamdown 代码、数学和 Mermaid 引擎的做法、贴底滚动的对话线程、可折叠溢出 hook，以及把 Kiki 服务端打包成 Tauri sidecar 的脚本。时间线的历史折叠沿用了 codeg 对已完成轮次的折叠方式。
- **[AionUi](https://github.com/iOfficeAI/AionUi)**（Apache-2.0）。代码块控件（语言标签、复制、长代码块折叠）、审批条的提交防护，以及模型和思考强度选择器在能力缺失时的降级处理，改编自 AionUi。选中文字后的引用按钮沿用了它「选中即回复」的行为。
- **[grok-build](https://github.com/xai-org/grok-build)**（Apache-2.0）。编辑 diff 采用 grok-build 的做法：三行上下文、合并相邻片段、「N unchanged lines」分隔行，以及 `+N/-M` 的改动统计。
- **[LiveAgent](https://github.com/Stack-Cairn/LiveAgent)**（MIT）。桌面应用唤醒后重连的策略、对托管服务进程的有界关闭，改编自 LiveAgent。输入框的右键菜单和时间线边缘按消息分布的刻度导航条，参照了 LiveAgent 的同类组件。
- **[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)**（MIT）。对话外壳的很多部分来自这里：首屏与停靠两种输入框形态、统一的内容宽度、思考行的摘要规则和扫光动画、失败优先的工具摘要、每轮的运行计时和结尾读数，以及用户消息里的 `@智能体` 标签。SQLite 搜索索引的 schema 校验改编自它的 session-query 包。
- **[LiteLLM](https://github.com/BerriAI/litellm)**（MIT）。Kiki 在 `packages/kap-server/vendor/litellm` 中附带 LiteLLM 的模型价格与上下文窗口表快照，并用 NOTICE 记录上游版本。
- **[nb-search](https://github.com/NB-Corp/nb-search)**（MIT）。联网搜索和网页抓取基于 nb-search，以打过补丁的发布包形式内置在 `vendor/` 下，附带许可证和补丁来源记录。
- **[tree-sitter-bash](https://github.com/tree-sitter/tree-sitter-bash)**（MIT）。Kiki 用纯 TypeScript 写的 bash 解析器（用来判断一条 shell 命令能否放行）复现了 tree-sitter-bash 的语法规则和节点类型，并以真实语法做对照测试。
- **[Agent Client Protocol TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)**（Apache-2.0）。`kiki acp` 和 Kiki 对外部 ACP 引擎的支持都建立在这个官方 SDK 上。
- **[Streamdown](https://github.com/vercel/streamdown)**（Apache-2.0）。桌面应用和文件预览里的流式 Markdown、代码高亮、中日韩文本、数学公式和图表，都通过 Streamdown 及其插件渲染。
- **[Tauri](https://github.com/tauri-apps/tauri)**（Apache-2.0 OR MIT）。桌面外壳、安装包、原生对话框、通知和带签名的 Windows 自动更新，都基于 Tauri 及其插件。
- **[xterm.js](https://github.com/xtermjs/xterm.js)**（MIT）。桌面应用的终端面板。
- **[CodeMirror](https://github.com/codemirror)**（MIT）。桌面应用里的文本与代码编辑。
- **[use-stick-to-bottom](https://github.com/stackblitz-labs/use-stick-to-bottom)**（MIT）。流式输出时让对话停在最新一条消息。

## 仅设计参考

Kiki 借鉴了以下项目的思路或行为，但不包含它们的任何代码。

- **[Claude Code](https://github.com/anthropics/claude-code)**（专有软件）。Kiki 记忆的四种类型（用户、反馈、项目、参考）沿用 Claude Code 的划分。Kiki 也能安装带 `.claude-plugin/plugin.json` 清单的 Claude Code 插件，清单由 Kiki 自己的导入器读取。
- **[OpenAI Codex](https://github.com/openai/codex)**（Apache-2.0）。会话历史工具把搜索、读取和目录浏览分开，参照了 Codex 的工具划分。Kiki 托管的 worktree 像 Codex 一样清理继承来的 git 环境变量，Codex 兼容的请求身份也按它的 User-Agent 格式生成。
- **[Hermes Agent](https://github.com/NousResearch/hermes-agent)**（MIT）。历史工具的发现方式、定位锚点和如实报告失败的做法，参照了 Hermes 的会话搜索。
- **[magic-context](https://github.com/cortexkit/magic-context)**（MIT）。历史搜索先过滤候选、再截断结果数量，和 magic-context 的做法一致。
- **[Letta Code](https://github.com/letta-ai/letta-code)**（Apache-2.0）。和 Letta Code 一样，每次写入记忆都必须附上理由，方便事后解释和撤销。
- **[AnythingLLM](https://github.com/Mintplex-Labs/anything-llm)**（MIT）。在原位置编辑已发送消息的方式参照了 AnythingLLM 的编辑表单，输入框的撤销栈也采用同样的 100 条上限。
- **[dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui)**（Apache-2.0）。「能力」页分组、可折叠的卡片，参照了 dsh-web-ui 插件分组的结构。

感谢所有公开构建这些项目的人。
