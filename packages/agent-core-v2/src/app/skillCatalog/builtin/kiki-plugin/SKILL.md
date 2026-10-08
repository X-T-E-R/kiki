---
name: kiki-plugin
description: 'Create, fix, or extend a local Kiki plugin: its manifest, an entry.mjs that registers tools, and the skills it carries. Use when the user wants a tool, skill, panel, or hook packaged as a plugin, or when an installed one fails.'
when_to_use: The user wants to write, modify, debug, or ship a Kiki plugin directory - adding a native tool, packaging a skill, fixing a manifest diagnostic, making a tool return an image, or reinstalling an edited plugin so the change takes effect. Not for installing, enabling, or browsing plugins as a user, and not for an agent profile or a standalone skill outside a plugin.
---

# 制作 Kiki 插件

把用户的能力做成一个能装、能调、能验的本地 plugin 目录。plugin 是宿主执行的一组声明式贡献加一个可选的 entry 文件；工具真正跑的是 entry 里的代码。

## 1. 先判断要不要做成 plugin

用户描述的能力如果一条脚本加一次 Bash 就能完成，就写脚本，不要为它建 plugin。临时脚本不需要安装、工具声明或共享。

只有出现下面某种需要，才做 plugin：

- 需要**原生工具 schema**：模型按结构化参数调用，而不是把命令行拼进提示词。
- 需要**一次调用同时回传文字和图片**（`output` 的多个 part），或要返回图片 dataURL。
- 需要**宿主面板**（`x-kiki.panels` + `handlePanelRequest`）或**插件声明的斜杠命令**。
- 需要**生命周期介入**：`installPrerequisite`、`sessionStart`、hooks、主题、provider preset、settings。
- 同一套能力要给多个项目、多个会话复用。

能力本身是提示词和流程，只是想让它自动出现时，做成 plugin 里的 skill 就够，不需要 entry。

## 2. 选落点

- 用户要**新能力** → 写 `kimi.plugin.json` + `entry.mjs`（若需要）+ plugin skill。
- 用户要**改已装 plugin** → 默认改源目录后对同一路径重新安装（见第 7 节），这是有在途隔离保证的路径。直接改 `$KIKI_HOME/plugins/managed/<id>/` 里的托管副本只适合用户明确要临时打补丁；它不走同一条更新路径，之后重新安装会覆盖，而且没有「在途调用仍读旧资源」的隔离保证。
- 用户要**修诊断** → 先用 `/plugins info <id>` 读真实 diagnostics，按具体报错改，不要猜字段。

改源还是改托管副本只在用户已经表明要动托管副本时才需要问；默认建议是改源目录后重装。

## 3. 写 manifest

`kimi.plugin.json`（或 `.kimi-plugin/plugin.json`）常用字段：`name`（plugin id，匹配 `[a-z0-9][a-z0-9_-]{0,63}`）、`version`、`description`、`icon`（`./` 路径的 svg/png，≤64 KB）、`skills`、`interface`。Kiki 专属贡献写在 `x-kiki` 里：`engines.kiki`、`entry`、`tools`、`permissions`、`settings`、`panels`、`commands`。字段全集、每项限制和 diagnostics 读法写在安装版本的 `customization/plugins.md`（`<KIKI_HOME>/docs/{en,zh}/`，本机 Kiki_HOME 未设置时为 `~/.kiki`）里，先读它再定字段，不要凭印象写。

- 有 `tools`、`sessionSources`、`panels`、`commands`、`settings`、`themes` 任何一项就必须写 `engines.kiki`；声明了 `tools` 或 `sessionSources` 还必须有 `entry`。
- 所有 `./` 路径（`skills`、`agents`、`commands`、`icon`、`systemPromptPath`、panel、entry）解析符号链接后仍须留在 plugin 根目录内。
- `tools` 里写的工具定义必须和 entry 里 `registerTool` 的定义逐字段一致；不一致时宿主会拒绝注册，报「registered a changed tool definition」。用一份定义源（`lib/definitions.mjs` 之类）同时喂给两处。

## 4. 写 entry

entry 是一个 ES 模块，导出 `register(api)`；需要前置安装再导出 `installPrerequisite`，需要面板后端再导出 `handlePanelRequest`。运行时上下文提供 `signal`（用户取消时中止，长任务要听它）、`settings`、`workspaceRoot`、`approvedPaths`、`imageIn`、`progress`。返回 `output` 是一个字符串或 part 数组：`{ type: 'text', text }` 与 `{ type: 'image_url', imageUrl: { url } }`。图片只接受 `data:image/png|jpeg|webp;base64,` dataURL，远程 URL 会被判为非法结果。大文本和图像由宿主自动保存为会话原件：文本返回预览和可读路径，图像返回会话附件引用，不需要插件另写分块协议。类型来自公开的 `@kiki/plugin-sdk`。

写之前用 Read 阅读 `references/authoring.md`；内置调用时，这份参考已附在下方。里面有可直接复制的最小 manifest、entry、image part 示例和一份真能跑的 `kiki-tile` 例子（一张确定性小图 + 数字，一次 tool output 同时回传文字和图片）。

## 5. 让脚本继续能独立跑

entry 里的真实逻辑放在 `scripts/` 或 `lib/` 下的普通模块里，脚本自己能用 `node` 单独跑通，entry 只做参数适配和结果整形。宿主只传 `PATH` 等少数环境变量给子进程，工作目录在 plugin 根而非用户 workspace；脚本需要用户路径时用 `context.workspaceRoot` 拼，不要假设 cwd。

## 6. 验证

1. 结构检查：manifest 能被解析且无 error diagnostics（`/plugins info <id>`）。
2. 真机执行：装好启用后调用工具，确认 `output` 结构、错误分支和 `progress` 符合预期。
3. 端到端：给出一个成功样例和一个不满足条件的样例，说明各自应看到什么。

没有验证到就写明未验证，不把「文件写好了」当成能用。

## 7. 装与重装

- `/plugins install --trust <path-or-url>`：带 `entry` 或声明了 permissions 的 plugin 需要 `--trust` 这一次知情同意；纯 themes 之类不需。同意按来源记住，同一来源再次安装不再问。
- **本地源会被拷贝到托管副本**（`$KIKI_HOME/plugins/managed/<id>/`），Kiki 始终从托管副本运行。只改源目录不会自动生效，需要再执行一次 install；也没有自动 watch。
- 首次：`/plugins install --trust <源目录>` → `/plugins enable <id>`。
- 改完源码后：对同一路径再跑一次 `/plugins install <源目录>`，`--trust` 不必重复传——同意按来源记住，不是每次必问。它沿用已同意的来源和已保存的 enabled 状态，把新内容复制进托管副本，**这一步做完新工具就能在原对话里调用**。运行时先等这个 plugin 的在途调用结束，再换掉它的 host 并刷新活跃 agent 的工具注册；其他 plugin 的进程不受影响。
- 生效范围：**工具**在这次安装完成后即可用，无需再 reload 或新会话；**skills、提示词、MCP server** 仍需 `/new` 或 `/reload`，不要笼统说「所有贡献都已即时生效」。
- `/plugins reload` 是**独立的重读操作**，用于重新读 `installed.json` 与各 manifest（诊断、手动改动托管副本、外部变更后）。它不会去同步源目录；把源改动送进 Kiki 的动作始终是再执行一次 install。
- 有 klient 实例时 `klient.global.plugins.reload()` 等价于 `/plugins reload`。
- 改了 `tools` 定义、`permissions` 等，再安装时会在 plan 里显示为 changed。

## 交付

给出：plugin 目录路径、manifest 与 entry 各自承担什么、工具名（模型看到的是 `plugin__<id 连字符换成下划线>__<tool>`）、验证过的调用结果、以及生效还需要用户做的步骤（安装/启用/重装/`/reload`）。明确写出尚未验证的部分。

## 边界

- 插件代码以用户账号权限运行，不是沙箱；安装同意是按来源记住的，不是逐次调用。
- 不为了让用户「顺便」用上就把它写进官方 plugin 目录或 marketplace。
- 修 profile 走 `kiki-profile`，写 hook 走 `kiki-hooks`，做外观包走 `kiki-appearance`；这些不必塞进 plugin。
