# 从脚本调用工具

在 Python、Node.js、Shell 或其他本机程序中调用 Kiki 共享的工具，无需 MCP，也无需 AI 对话。调用复用 Kiki 中已配置的供应商和凭据；脚本拿到的是连接凭据，不是供应商 API 密钥。

## 准备连接

在 **设置 → 连接与远程 → 从其他地方访问 → Agent 与客户端** 中创建连接，允许所需工具。再为该连接创建会话，选择工作区和权限模式。插件工具还需要安装、配置，并在该会话中启用。连接的权限上限、工具允许列表、工作区边界和正常审批仍然有效。声明不受限访问的媒体工具还需要连接的本地命令访问权限。

连接的 **自选工具** 列表按插件分组显示已启用插件的工具。勾选 `plugin__kiki_media__generate` 和 `plugin__kiki_media__media`，并为它们的不受限访问开启 **允许在这台机器上执行命令**。本机所有者也可以在终端中追加授权；已有工具授权会保留，修改授权会停止该连接正在运行的工作：

```sh
kiki tools --client CONNECTION_ID grant plugin__kiki_media__generate plugin__kiki_media__media --allow-commands
```

查找并恢复共享会话，将 `CONNECTION_ID` 和 `SESSION_REF` 替换为实际值：

```sh
kiki tools --client CONNECTION_ID call kiki_session --args '{"action":"list"}'
kiki tools --client CONNECTION_ID call kiki_session --args '{"action":"resume","session_ref":"SESSION_REF"}'
kiki tools --client CONNECTION_ID list
```

`--client` 通过本机所有者已有的连接配置签发一小时有效的连接凭据，不会打印凭据。连接属于其他 home 时，加上 `--home /path/to/kiki-home`。发现工具不会创建会话。连接与会话管理详见 [外部客户端设置](./mcp.md#让外部客户端使用-kiki-工具)。

使用 Python、Node.js 或其他 HTTP 客户端时，由本机所有者导出连接凭据：

```sh
kiki tools --client CONNECTION_ID credential --output /private/connection-token
```

此命令新建私有文件，拒绝覆盖已有文件。输出的 JSON 只包含文件路径和服务器 URL，不含凭据。将 `KIKI_EXTERNAL_CLIENT_CREDENTIAL_FILE` 设为该路径，将 `KIKI_SERVER_URL` 设为返回的 `server_url`。工具路由只接受来自回环地址的连接 bearer 凭据，不接受服务器所有者 token。

凭据一小时后过期。收到 HTTP 401 时，用新的输出路径再次运行 `credential`，更新环境变量，并使用原来的提交键重新运行脚本。较长的 CLI 工作流可直接使用 `--client`，由 CLI 自动获取有效凭据。暂停或撤销连接会立即停止访问。

Python 和 Node.js 示例读取以下环境变量：

| 变量 | 值 |
| --- | --- |
| `KIKI_SERVER_URL` | 正在运行的服务器回环 URL，例如 `http://127.0.0.1:58627` |
| `KIKI_EXTERNAL_CLIENT_CREDENTIAL_FILE` | 包含连接凭据的私有 UTF-8 文件 |
| `KIKI_SESSION_REF` | `kiki_session list` 或 `resume` 返回的引用 |
| `KIKI_MEDIA_PROVIDER` | 已配置的供应商 ID，例如 `kiki-media/openai-image` |

## 生成并下载图片

这些示例提交一个后台图片任务，查询到完成，然后把第一个产物保存为 `image.png`。请按已配置的来源调整供应商和请求。运行示例可能产生供应商费用。

同一次提交要保持 `idempotency_key` 和媒体 `request_id` 不变。复用操作键会返回原来的回执；使用同一键修改参数会被拒绝。下面的每次状态查询使用新键，以读取最新的媒体快照。`operation_id` 标识一次 Kiki 工具调用，`job_id` 标识持续更久的媒体生成任务。工具调用完成时，其中的媒体任务仍可能是 `running` 或 `pending`。

### 在 Shell 中使用 CLI

此 POSIX Shell 示例需要 `jq`。CLI 负责签发凭据和下载；每条命令向 stdout（程序输出通道）写入 JSON，请求或工具出错时以非零退出码结束。

```sh
set -eu
CLIENT=CONNECTION_ID
SESSION=SESSION_REF
PROVIDER=kiki-media/openai-image

tools() { kiki tools --client "$CLIENT" "$@"; }
wait_operation() {
  id=$1
  attempts=0
  while [ "$attempts" -lt 120 ]; do
    receipt=$(tools job get "$id")
    state=$(printf '%s' "$receipt" | jq -r '.structuredContent.state')
    case "$state" in
      completed) printf '%s\n' "$receipt"; return ;;
      accepted|running|waiting_approval) sleep 1 ;;
      *) printf '%s\n' "$receipt" >&2; return 1 ;;
    esac
    attempts=$((attempts + 1))
  done
  echo "Still running; query operation $id again, do not resubmit." >&2
  return 1
}
args=$(jq -nc --arg provider "$PROVIDER" '{request_id:"example-image-001",provider:$provider,execution:"background",request:{kind:"image",prompt:"A simple blue square",count:1}}')
receipt=$(tools call plugin__kiki_media__generate --session-ref "$SESSION" --key example-image-001 --args "$args")
receipt=$(wait_operation "$(printf '%s' "$receipt" | jq -r '.structuredContent.operation_id')")
job=$(printf '%s' "$receipt" | jq -r '.structuredContent.result.output | fromjson | .job.job_id')
count=0
while [ "$count" -lt 120 ]; do
  args=$(jq -nc --arg job "$job" '{action:"get",job_id:$job}')
  receipt=$(tools call plugin__kiki_media__media --session-ref "$SESSION" --key "status-$$-$count" --args "$args")
  op=$(printf '%s' "$receipt" | jq -r '.structuredContent.operation_id')
  receipt=$(wait_operation "$op")
  state=$(printf '%s' "$receipt" | jq -r '.structuredContent.result.output | fromjson | .job.state')
  case "$state" in
    succeeded) tools job download "$op" --artifact 0 --output image.png; exit 0 ;;
    running|pending) sleep 2 ;;
    *) printf '%s\n' "$receipt" >&2; exit 1 ;;
  esac
  count=$((count + 1))
done
printf 'Media job %s is still pending; query it again without generating a new job.\n' "$job" >&2
exit 1
```

使用预先签发的凭据时，把 `--client "$CLIENT"` 替换为 `--url "$KIKI_SERVER_URL" --credential-file /private/connection-token`。未指定凭据文件时，CLI 也可读取 `KIKI_EXTERNAL_CLIENT_TOKEN`。`job download` 不会覆盖已有文件；下载失败后会删除本次新建的不完整输出。

### 通过 Python 调用 HTTP

保存为 `generate.py`，运行 `python generate.py`。示例只使用 Python 标准库。

```python
import base64
import json
import os
from pathlib import Path
import time
import urllib.parse
import urllib.request
import uuid

base = os.environ["KIKI_SERVER_URL"].rstrip("/")
assert urllib.parse.urlparse(base).hostname in ("localhost", "127.0.0.1", "::1")
token = Path(os.environ["KIKI_EXTERNAL_CLIENT_CREDENTIAL_FILE"]).read_text().strip()
session = os.environ["KIKI_SESSION_REF"]

def api(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(base + "/api/external-clients" + path, data=data,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.load(response)
    if result["code"] != 0:
        raise RuntimeError(result["msg"])
    return result["data"]

def tool(name, arguments, key):
    result = api("/tools/" + name + ":call", {"arguments": arguments,
        "session_ref": session, "idempotency_key": key})["structuredContent"]
    deadline = time.monotonic() + 120
    while result["state"] in ("accepted", "running", "waiting_approval") and time.monotonic() < deadline:
        time.sleep(1)
        result = api("/jobs/" + result["operation_id"])["structuredContent"]
    if result["state"] != "completed" or result.get("result", {}).get("isError"):
        raise RuntimeError(json.dumps(result))
    return result

receipt = tool("plugin__kiki_media__generate", {
    "request_id": "example-image-001", "provider": os.environ["KIKI_MEDIA_PROVIDER"],
    "execution": "background", "request": {"kind": "image", "prompt": "A simple blue square", "count": 1}
}, "example-image-001")
job = json.loads(receipt["result"]["output"])["job"]
deadline = time.monotonic() + 240
while job["state"] in ("running", "pending") and time.monotonic() < deadline:
    time.sleep(2)
    receipt = tool("plugin__kiki_media__media", {"action": "get", "job_id": job["job_id"]}, str(uuid.uuid4()))
    job = json.loads(receipt["result"]["output"])["job"]
if job["state"] != "succeeded":
    raise RuntimeError(json.dumps(job))
output = Path("image.png")
with output.open("xb") as file:
    try:
        offset = 0
        while True:
            page = api(f'/jobs/{receipt["operation_id"]}/result?artifact=0&offset={offset}&limit=256000')
            resource = next(part["resource"] for part in page["content"] if part["type"] == "resource")
            file.write(base64.b64decode(resource["blob"]))
            if page["structuredContent"]["complete"]:
                break
            offset = page["structuredContent"]["range"]["end"]
    except Exception:
        file.close()
        output.unlink()
        raise
print(json.dumps({"job_id": job["job_id"], "output": str(output)}))
```

### 通过 Node.js 调用 HTTP

保存为 `generate.mjs`，使用当前版本的 Node.js 运行 `node generate.mjs`。

```js
import { readFile, open, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const base = process.env.KIKI_SERVER_URL.replace(/\/$/, '');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname)) throw new Error('Use a loopback URL');
const token = (await readFile(process.env.KIKI_EXTERNAL_CLIENT_CREDENTIAL_FILE, 'utf8')).trim();
const session = process.env.KIKI_SESSION_REF;
async function api(path, body) {
  const response = await fetch(`${base}/api/external-clients${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  if (!response.ok || result.code !== 0) throw new Error(result.msg ?? `HTTP ${response.status}`);
  return result.data;
}
async function tool(name, args, key) {
  let result = (await api(`/tools/${name}:call`, { arguments: args, session_ref: session, idempotency_key: key })).structuredContent;
  const deadline = Date.now() + 120_000;
  while (['accepted', 'running', 'waiting_approval'].includes(result.state) && Date.now() < deadline) {
    await delay(1000);
    result = (await api(`/jobs/${result.operation_id}`)).structuredContent;
  }
  if (result.state !== 'completed' || result.result?.isError) throw new Error(JSON.stringify(result));
  return result;
}
let receipt = await tool('plugin__kiki_media__generate', {
  request_id: 'example-image-001', provider: process.env.KIKI_MEDIA_PROVIDER, execution: 'background',
  request: { kind: 'image', prompt: 'A simple blue square', count: 1 },
}, 'example-image-001');
let job = JSON.parse(receipt.result.output).job;
const deadline = Date.now() + 240_000;
while (['running', 'pending'].includes(job.state) && Date.now() < deadline) {
  await delay(2000);
  receipt = await tool('plugin__kiki_media__media', { action: 'get', job_id: job.job_id }, randomUUID());
  job = JSON.parse(receipt.result.output).job;
}
if (job.state !== 'succeeded') throw new Error(JSON.stringify(job));
const output = 'image.png';
const file = await open(output, 'wx');
let complete = false;
try {
  let offset = 0;
  while (true) {
    const page = await api(`/jobs/${receipt.operation_id}/result?artifact=0&offset=${offset}&limit=256000`);
    const resource = page.content.find(part => part.type === 'resource').resource;
    await file.writeFile(Buffer.from(resource.blob, 'base64'));
    if (page.structuredContent.complete) { complete = true; break; }
    offset = page.structuredContent.range.end;
  }
} finally {
  await file.close();
  if (!complete) await rm(output);
}
console.log(JSON.stringify({ job_id: job.job_id, output }));
```

## 查询并恢复已接受的任务

请求超时时，如果提交可能已经开始，使用原来的键和参数找回回执，绝不要自动换新键重提。操作为 `outcome_unknown` 或媒体任务为 `unknown` 时，先检查供应商已接受的任务，再决定下一步；再次生成可能再次计费。

权限上限为 `manual` 时，要在 Kiki 中打开共享会话，让 GUI 能接收审批请求。没有审批消费者时，需要审批的调用会立即以 `no_consumer` 被拒绝，不会等待窗口打开。无人值守的批量任务可在检查允许工具及其访问范围后，将连接上限和会话模式设为 `auto` 或 `yolo`。`auto` 仍可能对高风险操作发起审批；`yolo` 在已有授权范围内免除这些正常审批。

`waiting_approval` 表示已连接的 Kiki 窗口正在等待你决定。在窗口中批准或拒绝后，查询同一个操作。示例会在截止时间前继续轮询此状态。脚本不能提高连接的权限上限。

已接受的媒体任务为 `can_resume: true` 时，明确恢复同一任务，不要再次调用 `generate`：

```sh
kiki tools --client CONNECTION_ID call plugin__kiki_media__media \
  --session-ref SESSION_REF --key resume-example-001 \
  --args '{"action":"resume","job_id":"MEDIA_JOB_ID"}'
```

恢复只继续已保存的句柄或暂存下载，不会购买新的生成任务。用 `media` 的 `get` 操作查询，直到保存了可接受的结果。状态为 `partial` 时，先检查产物的 `complete`、`role` 和错误字段，再下载所需产物。`job download --artifact N` 指向的是 **已保存结果中包含这些产物的工具操作**，通常为最近一次成功的 `media get`，而不是最初仍在等待的生成回执。

## HTTP 与客户端参考

四个路由都使用标准的 `{ code, msg, data, request_id }` 信封。非零业务 `code` 也可能使用 HTTP 200。工具数据为 `{ content, structuredContent, isError? }`，与现有 MCP 结果结构一致。

| 方法与路径 | 输入或结果 |
| --- | --- |
| `GET /api/external-clients/tools` | 当前授权的 `{ tools: [{ name, description, inputSchema, annotations }] }` |
| `POST /api/external-clients/tools/{name}:call` | `{ arguments, session_ref?, idempotency_key? }`；返回控制结果或操作回执 |
| `GET /api/external-clients/jobs/{operation_id}` | 已保存的操作回执，不会重提 |
| `GET /api/external-clients/jobs/{operation_id}/result` | 已保存结果的分页，可选查询字段为 `part`、`artifact`、`offset`、`limit` |

HTTP 调用的桥接字段放在顶层，不要放入 `arguments._kiki`。有副作用的调用需要 1–256 个字符的键。`kiki_session` 和 `kiki_operation` 保留控制参数；例如取消操作时调用 `kiki_operation`，参数为 `{"operation_id":"OPERATION_ID","action":"cancel"}`。

不指定选择器时，结果分页包含已保存的 JSON 工具结果。`part=N` 选择原生输出数组中的一段，`artifact=N` 选择生成的媒体产物，两者只能选一个。`limit` 为 1–256000，默认 12000；文本偏移以 UTF-16 代码单元计数，媒体偏移以字节计数。二进制分块以 base64 放在嵌入资源的 `blob` 中。沿 `structuredContent.range.end` 继续读取，直到 `complete: true`。下载读取已保存且属于该会话的字节，不读取当前供应商 URL 或任意主机路径。

HTTP 客户端 SDK 在 `klient.rest.externalClients` 下提供同样的操作：`tools(options?)`、`callTool(name, body, options?)`、`job(id, options?)` 和 `result(id, range?, options?)`。创建 HTTP 客户端时使用连接凭据；该凭据仍不能访问所有者管理方法。
