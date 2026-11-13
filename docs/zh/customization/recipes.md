# Recipe

Recipe 将可复用的提示词、模型设置和可选脚本 Hook 打包在一起。安装一次后，可在模型或 [Agent profile](./prompt-fields.md#recipe-模型配方) 上选择它。每个绑定保留自己的选项值。

## 安装与选择

在 **设置 → 模型与智能体 → [模型 → 连接](../guides/settings.md#连接)**中打开模型编辑器，点击**选择 Recipe**。可以选择已安装包、浏览已配置的 Recipe 市场，或导入来源。

1. 预览来源 URL 或服务端的绝对路径。本地来源可以是目录或 `recipe.toml` 文件；HTTPS ZIP 可选填 SHA-256 校验值并在填写时核对。
2. 查看展开后的提示词、模型设置和脚本文件。包中出现新脚本时，安装需要明确同意。
3. 选择**仅安装**，只保存包而不改变模型；选择**安装并应用**，还会保存模型绑定及当前表单草稿。
4. 对已安装包，选好选项后点击**应用到模型**。仅查看或选中包不会改变已保存的绑定。

安装成功但应用到模型失败时，保留安装结果，修正所报问题后重试**应用到模型**。**恢复手动设置**移除模型的 Recipe 引用，保留原有手动值和 profile 的独立 Recipe。

## 选择选项与查看结果

每个选项有 id、名称、可选说明和布尔默认值。选项可以控制正文是否出现、向提示槽插入文字，或修改指定的 Markdown 标题节。完整的[选项与 patch 语法](./prompt-fields.md#选项插入与章节修改)在包的 manifest 中声明。

在使用包的模型或 profile 上选择选项；agent 文件中的 `model_profiles[].recipe_options` 还可以在所选模型匹配该条目时覆盖对应层的选项。省略的选择采用包的默认值；两个模型或两个角色可以使用同一个安装包，同时保留不同选择。更新删掉某个已选 id 时，会忽略它并报告诊断；再次保存前应核对绑定的选项。

要查看某个选择而不保存，用 `klient.global.recipes.get(id, values)`，或 `GET /api/recipes/{id}?recipe_options=<URL 编码的 JSON 布尔映射>`。响应中的 `resolved.option_values` 是生效选项，`resolved.branches` 是展开后的提示词正文。

例如，使用已连接的 [Klient](../server/sdk.md)，将预览过的包应用到一个模型：

```ts
const recipes = klient.global.recipes;
const preview = await recipes.preview({ source: { locator: "/path/to/recipe" } });
const installed = await recipes.install({ preview_id: preview.preview_id });
const values = { research: true };
const effective = await recipes.get(installed.installation_id, values);
const model = await klient.global.kosong.readModel("example-model");
await klient.global.kosong.updateModel(model.id, {
  recipe: installed.installation_id,
  recipe_options: values,
  base_revision: model.revision,
});
```

安装带脚本的包前先查看 `preview.hooks`，经批准后才传 `consent: true`。应用到多个模型时，分别读取每个别名，并用各自的 `base_revision` 更新。某个模型期间发生变化时，刷新该模型后重试保存；其他已经成功的模型保存会保留。

新绑定会冻结包的修订、所选选项、展开正文和模型设置。已有或恢复的会话保留这份快照。要采用新选项或包内容，创建新绑定，或在空闲时[重建上下文](./agents-and-subagents.md#重建会话上下文)。

## 浏览已安装包

**设置 → 模型与智能体 → Recipe**（`/settings/recipes`）无需打开模型即可管理包。列表显示每个包的版本、更新方式、失败的更新，以及正在使用它的模型。打开一个包即可阅读（`?recipe=<安装 id>`），再点**编辑此配方**（`&view=edit`）；从来源安装的包提供**定制此 Recipe**，会先复制或继承。这个页面不会绑定任何模型。**移除**会列出仍在使用该包的模型，并让它们回到各自保存的设置。该页还可以从链接或路径安装，以及管理 Recipe 市场。在模型的 Recipe 标签页中，**在 Recipe 库中打开**会跳到已绑定的包。

如果保存因为包已在别处先保存而被拒绝，编辑器会保留你的修改，并提供**载入较新的版本**。你改过的文件保留你的内容，未改动的文件采用较新的副本，下次保存使用较新的修订。

[Recipe API](../server/rest-api.md#recipe-与市场) 提供 `global.recipes.list()` 和 `GET /api/recipes`。每项包含安装 id、显示名称、版本、已接受修订、来源 locator、更新模式和健康状态。`copied_from` 记录 fork 的来源；市场条目通过来源 URL 关联包。

目录中的可选字段可用于模型选择器和管理列表：

| 字段 | 含义 |
| --- | --- |
| `used_by` | 当前生效模型中使用此安装包的别名，包括继承的模型引用；无人使用时省略 |
| `options` | 已接受修订的选项定义及默认值；未声明选项或修订不可用时省略 |
| `update_available` | 成功检查后发现了其他修订 |
| `last_error` | 需要处理的更新或修订读取错误 |

`GET /api/models` 和 `klient.global.kosong.listModels()` 还返回每个模型的 `recipe` 与显式 `recipe_options`。`recipe` 引用可能带 `installation:` 前缀；与目录的 `installation_id` 关联时先去掉前缀。展示所选选项摘要时，将模型选择与各选项默认值合并。未绑定或设置为 `off` 的模型会省略这两个字段。

目录读取采用已接受的本地快照，不获取包来源。修订无法读取或校验时，条目仍然可见，带 `health: "unavailable"` 和诊断。修复安装或移除该包即可；其他包仍可使用。

## 更新、定制与分享

安装包锁定完整依赖链，离线时仍可使用。**跟随**（`follow`）每天检查更新，在无需新脚本授权时接受有效修订。**固定**（`pinned`）保留已接受修订，更新检查会跳过它。显式检查只报告是否有更新，不替换当前修订。非法更新会保留完整的上一次有效包。

用**复制并编辑**创建独立的本地包，或用**基于此继承**保留父源引用。在**提示词正文**或**源文件**中修改，再点**保存 Recipe**。保存包不会替其他模型选择它。API 编辑带 `expected_revision`；冲突时先重新加载再编辑。子空间中的继承安装是只读的，应先在子空间复制或继承，再保存。

**下载 ZIP** 前先保存作者草稿。导出包含已接受的继承内容，其他 Home 可独立导入。API 返回 `{ name, revision, files }`，调用方根据这份相对文件映射创建 ZIP。导出不会上传包。

## 市场与移除

Recipe 市场是配置在 `recipes.markets` 下的 HTTPS 目录，每个市场有 `id`、`name`、`url` 和 `enabled` 开关。关闭市场会保留已安装包。获取目录失败时，可能返回缓存条目及 `offline: true`；诊断会指出要修复的来源。插件市场与 Recipe 市场各自使用独立目录和安装操作。

移除安装包前，先查看 `used_by` 中的模型别名。模型仍引用它时会拒绝移除，除非明确传 `disable_models: true`；这会在受影响模型上写 `recipe: "off"`，并保留其他设置。Profile 引用独立存在，不包含在 `used_by` 中；删除它们需要的包前，应先切换或移除这些引用。已有冻结绑定保留已接受的快照。
