# Plugin 制作参考

字段全集、每项限制、安装语义和 diagnostics 读法，以安装版本的 `customization/plugins.md` 为准：`<KIKI_HOME>/docs/{en,zh}/customization/plugins.md`（未设置 KIKI_HOME 时为 `~/.kiki`，在服务端主机上）。本文只放写工具时反复要用、且已核实的事实。

## 最小 manifest

`x-kiki.tools` 里就是上文那份工具定义，逐字段照抄：

```json
{
  "name": "kiki-tile",
  "version": "0.1.0",
  "description": "Draw a deterministic local tile and return it as an image from one tool call.",
  "license": "MIT",
  "x-kiki": {
    "engines": { "kiki": "^0.4.0" },
    "entry": "./entry.mjs",
    "tools": [
      {
        "schemaVersion": 1,
        "name": "tile_draw",
        "description": "Draw one deterministic grayscale tile for a given seed and return it as an image alongside its seed.",
        "parameters": {
          "type": "object",
          "properties": {
            "seed": { "type": "integer", "minimum": 0, "maximum": 255, "description": "Seed that shifts the diagonal pattern." },
            "size": { "type": "integer", "minimum": 8, "maximum": 512, "description": "Edge length in pixels." }
          },
          "required": ["seed"],
          "additionalProperties": false
        },
        "accesses": [{ "kind": "all" }]
      }
    ]
  }
}
```

`name` 同时是 plugin id，必须匹配 `[a-z0-9][a-z0-9_-]{0,63}`。声明任何 Kiki 贡献都要写 `engines.kiki`；当前引擎版本是 `0.4.0`，超出 semver range 会被拒。

有 `tools`、`sessionSources`、`panels`、`commands`、`settings`、`themes` 任何一项时，`engines.kiki` 必填；其中 `tools` 和 `sessionSources` 还要求 `entry` 存在。所有 `./` 路径解析符号链接后必须仍留在 plugin 根目录内。

## 工具定义放在一份源里

宿主要求 entry 注册的定义与 manifest `x-kiki.tools` 中那一条**逐字段相同**，否则拒绝注册（`registered a changed tool definition`）。手写两份必然漂移，所以把定义放在 `lib/definitions.mjs`，entry 只导入它；manifest 那份写完后用测试断言两者相等（kiki-office 的 `test/office.test.mjs` 第一条测试就是这么做的）。

`lib/definitions.mjs`

```js
export const tileDraw = {
  schemaVersion: 1,
  name: 'tile_draw',
  description: 'Draw one deterministic grayscale tile for a given seed and return it as an image alongside its seed.',
  parameters: {
    type: 'object',
    properties: {
      seed: { type: 'integer', minimum: 0, maximum: 255, description: 'Seed that shifts the diagonal pattern.' },
      size: { type: 'integer', minimum: 8, maximum: 512, description: 'Edge length in pixels.' },
    },
    required: ['seed'],
    additionalProperties: false,
  },
  accesses: [{ kind: 'all' }],
};
```

manifest 里的写法是 `"tools": [{ ...见上 }]`——同一份对象，或者由脚本把 `lib/definitions.mjs` 同步进 manifest（kiki-office 的 `scripts/sync-manifest.mjs` 就是这个用途）。定义只写一处，另一处生成或断言。

| 字段 | 说明 |
| --- | --- |
| `schemaVersion` | 固定 `1` |
| `name` | 匹配 `^[a-zA-Z][\w-]{0,63}$`；模型看到的是 `plugin__<pluginId 连字符换成下划线>__<name>` |
| `description` | 模型据此选工具；kiki-office 全部控制在 600 字符内 |
| `parameters` | JSON Schema 对象；缺省是空对象 schema |
| `accesses` | 默认 `[{ kind: 'all' }]`。声明 `kind: 'file'` 时 `path` 写 `$.<参数名>` |
| `disclosure` | `inline` 或 `deferred`（默认 `deferred`） |
| `approvalRule` | 无文件准入时使用；有文件准入后由宿主按路径生成 |

## 可运行的例子：一次 output 回传文字和图片

`lib/tile.mjs`（无第三方依赖，确定性 PNG）：

```js
import { deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
  return Buffer.concat([head, Buffer.from(type, 'latin1'), data, tail]);
}

export function drawTile(size, value) {
  const stride = size + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x += 1) {
      const lit = (x + y + value) % 8 < 4;
      raw[y * stride + 1 + x] = lit ? 235 : 20;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 0;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
```

`entry.mjs`：

```js
import { drawTile } from './lib/tile.mjs';
import { tileDraw } from './lib/definitions.mjs';

export function register(api) {
  api.registerTool(tileDraw, async (args, context) => {
    const seed = args?.seed ?? 0;
    const size = args?.size ?? 64;
    context.progress({ kind: 'progress', percent: 50, text: 'Drawing tile' });
    const png = drawTile(size, seed);
    return {
      output: [
        { type: 'text', text: `Tile seed ${seed} at ${size}x${size}, ${png.length} bytes.` },
        { type: 'image_url', imageUrl: { url: `data:image/png;base64,${png.toString('base64')}` } },
      ],
    };
  });
}
```

已核实：seed 3、size 32 时 text 为 `Tile seed 3 at 32x32, 114 bytes.`，随后的 part 是通过宿主校验的 `data:image/png;base64,` URL（`drawTile(8, 3)` 产出 95 字节，64×64 为 132 字节）。`kimi.plugin.json`、`entry.mjs`、`lib/definitions.mjs` 和 `lib/tile.mjs` 四个文件即可安装成一个能工作的 plugin。

`drawTile` 是纯函数，`node -e` 单独就能跑并写出 PNG 检查像素；entry 只做参数适配和结果整形，所以底层脚本仍能独立执行。

## 执行上下文

`execute(args, context)` 的 `context`：

- `signal: AbortSignal` — 用户取消时中止。长时间循环里要 `signal.throwIfAborted()` 或监听它；宿主取消会向插件发 `cancel`。
- `settings: Record<string, unknown>` — 该 plugin 声明的 settings 值。
- `workspaceRoot?: string` — 当前 workspace 根；宿主没有 workspace 时是 `undefined`。
- `approvedPaths: readonly string[]` — workspace 外被准入的路径。
- `imageIn: boolean` — 当前模型是否支持图片输入；`office_preview` 据此在 PNG 与文字大纲之间切换。
- `progress({ kind, text?, percent? })` — `kind` 为 `progress` / `status` / `stdout` / `stderr`。

## 返回值

- `output` 是字符串，或 part 数组：`{ type: 'text', text }` / `{ type: 'image_url', imageUrl: { url } }`。
- 图片 URL 必须是 `data:image/png|jpeg|webp;base64,` dataURL，≤12 MiB；写远程 URL 或 SVG dataURL 会被判为 invalid tool result，工具直接失败。SVG 要先转 PNG。
- 失败用 `isError: true` 加可读 `output`，不要 throw 后让宿主只显示一个字符串化错误。
- 宿主子进程里 `console.log` 被改写到 stderr（stdout 是 RPC 通道），调试输出用 `console.error`。
- 类型来自公开的 `@kiki/plugin-sdk`：`PluginToolDefinition`、`PluginContentPart`、`PluginExecutionContext`、`PluginRegistrationApi`、`definePlugin`。

## 文件准入的实际效果

`accesses` 写 `{ kind: 'file', operation, path: '$.file' }` 时，宿主在调用前按真实路径准入、执行时把该参数替换成绝对路径，workspace 外的路径进 `context.approvedPaths`。所以 entry 拿到的 `args.file` 已是可信绝对路径，不必自己 resolve；对应地，工具描述里应说明接受 workspace 相对路径或已批准的绝对路径。`path` 只支持 `$.<单个参数名>`，写成别的形式会被拒。

## 生命周期与安装语义

- 宿主在第一次调用时才启动 entry 子进程，90 秒无调用即终止。安装或 reload 换掉某个 plugin 的 host 时，运行时先等它的在途调用结束，旧 host 才被替换。
- entry 进程只拿到 `PATH`、`SystemRoot`、`TEMP` 等少数环境变量，以及 `KIKI_PLUGIN_ROOT`。工作目录在 plugin 根，不在用户 workspace；脚本需要用户路径时用 `context.workspaceRoot` 拼。
- `installPrerequisite({ consent, destination })` 导出后才可能由用户同意安装可执行文件；`consent !== true` 必须拒绝，且不要覆盖已有文件（参考 kiki-office 的 `lib/binary.mjs` 校验固定版本 SHA256）。
- 本地安装把目录**拷贝**到 `$KIKI_HOME/plugins/managed/<id>/`，之后始终从托管副本运行。只改源目录不会自动生效，需要对同一路径重新安装；当前没有自动 watch。手改托管副本可以临时生效，但之后重新安装会覆盖它，且没有「在途调用仍读旧资源」的隔离保证。
- 改完源码的完整动作：再跑一次 `/plugins install <同一源目录>`（`--trust` 只在首次安装时需要，同源更新不必重复传；沿用已同意来源并保留 enabled 状态），**到此为止**。运行时先等该 plugin 的在途调用结束，再换它的 host 并刷新活跃 agent 的工具注册，所以新工具在这一步完成之后就能在原对话里调用，其他 plugin 的进程不受影响。
- `/plugins reload` 是单独的重读操作：重新读 `installed.json` 与各 manifest，用于诊断、手动改过托管副本或外部变更。它不同步源目录——把源改动送进 Kiki 永远靠再执行一次 install，不是 reload。
- 上面说的是**工具**。skills、提示词、MCP server 属于非工具贡献，仍需 `/new` 或 `/reload` 才生效，不要笼统说「所有贡献都已即时生效」。
- 首次安装只要有非 theme 贡献或声明了 permissions 就需要 `--trust` 知情同意（按来源记住）。
- 改了 `tools` 定义、permissions 等会在下次安装的 plan 里显示为 changed。

## 真实可读的例子

第一方插件源码在独立的 [Kiki Plugins 仓库](https://github.com/X-T-E-R/kiki-plugins)，不在 Host 仓库中。可对照其中 `plugins/official/kiki-office`（多工具、文件准入、settings、prerequisite、image part、manifest 与定义同步脚本）和 `plugins/official/kiki-writing`（panel + 声明式命令，无 entry）；本地开发先克隆插件仓，再从该仓读取、修改或安装对应目录。历史导入规则仍由 Host 原生提供，唯一实现位于 `packages/agent-core-v2/src/app/pluginImport/builtin/`；其 `entry.mjs` 演示同一 `registerSessionSource` 契约，`examples/custom-json.mjs` 则是无需安装 plugin 的独立脚本。维护与资源边界见同目录上级的 `README.md`。判断写法是否合规时读真实实现，不要照抄临时生成的 skill 文本。

## 未覆盖

主题、provider preset、hooks、sessionStart、斜杠命令文件的完整字段见安装版本 `customization/plugins.md` 与 `customization/hooks.md`；这些不需要 entry，除非同时要提供工具。
