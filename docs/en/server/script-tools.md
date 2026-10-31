# Tools from scripts

Call Kiki's shared tools from Python, Node.js, a shell, or another local program without MCP or an AI conversation. Calls use the providers and credentials already configured in Kiki; scripts receive a connection credential, not provider API keys.

## Prepare a connection

In **Settings → Connection & remote → Access from elsewhere → Agents & clients**, create a connection and allow the tools you need. Create a conversation for that connection in Kiki and choose its workspace and permission mode. Plugin tools must also be installed, configured and enabled for that conversation. The connection's permission ceiling, tool allowlist, workspace boundaries and normal approvals still apply. Media tools that declare unrestricted access also require the connection's local-command access permission.

In the connection's **Pick tools** list, enabled plugin tools appear grouped by plugin. Select `plugin__kiki_media__generate` and `plugin__kiki_media__media`, and enable **Allow commands on this machine** for their unrestricted access. The local owner can also add these grants from the terminal; existing grants are retained, and changing a grant stops the connection's running work:

```sh
kiki tools --client CONNECTION_ID grant plugin__kiki_media__generate plugin__kiki_media__media --allow-commands
```

Find and resume the shared conversation, replacing `CONNECTION_ID` and `SESSION_REF`:

```sh
kiki tools --client CONNECTION_ID call kiki_session --args '{"action":"list"}'
kiki tools --client CONNECTION_ID call kiki_session --args '{"action":"resume","session_ref":"SESSION_REF"}'
kiki tools --client CONNECTION_ID list
```

`--client` uses the local owner's existing connection configuration to mint a one-hour connection credential without printing it. Add `--home /path/to/kiki-home` when the connection belongs to another home. Discovery does not create a conversation. See [external-client setup](./mcp.md#let-an-external-client-use-kiki-tools) for connection and session controls.

For unattended HTTP clients, the local owner can provision a credential through the existing owner-authenticated `POST /api/external-clients/CONNECTION_ID/credential` route with `{}`. Save only its returned `data.token` in a private file; do not log it. Tool routes accept that connection bearer credential only, from a loopback address. They do not accept the server's owner token. Refresh expired credentials through the owner channel; pausing or revoking the connection stops their access.

The Python and Node.js examples read these environment variables:

| Variable | Value |
| --- | --- |
| `KIKI_SERVER_URL` | The running server's loopback URL, for example `http://127.0.0.1:58627` |
| `KIKI_EXTERNAL_CLIENT_CREDENTIAL_FILE` | Private UTF-8 file containing the connection credential |
| `KIKI_SESSION_REF` | Reference returned by `kiki_session list` or `resume` |
| `KIKI_MEDIA_PROVIDER` | A configured provider ID, for example `kiki-media/openai-image` |

## Generate and download an image

These examples submit one background image job, query it until completion, and save its first artifact as `image.png`. Change the provider and request to match your configured source. Running an example can incur provider charges.

Keep both `idempotency_key` and media `request_id` stable for the same submission. Reusing the operation key returns the original receipt; changing the arguments with that key is rejected. Each status query below has a new key so it reads a fresh media snapshot. An `operation_id` identifies a Kiki tool call; `job_id` identifies the longer-running media generation. A completed tool call may contain a media job that is still `running` or `pending`.

### Shell with the CLI

This POSIX shell example needs `jq`. The CLI handles credential minting and downloads; every command writes JSON to stdout and returns a nonzero exit code for a request or tool error.

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
      accepted|running) sleep 1 ;;
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

For a pre-provisioned credential, replace `--client "$CLIENT"` with `--url "$KIKI_SERVER_URL" --credential-file /private/connection-token`. The CLI also accepts `KIKI_EXTERNAL_CLIENT_TOKEN` when no credential file is supplied. `job download` refuses to replace an existing file and removes an incomplete new output after a failed download.

### Python over HTTP

Save as `generate.py` and run `python generate.py`. It uses only the Python standard library.

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
    while result["state"] in ("accepted", "running") and time.monotonic() < deadline:
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

### Node.js over HTTP

Save as `generate.mjs` and run `node generate.mjs` with a current Node.js release.

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
  while (['accepted', 'running'].includes(result.state) && Date.now() < deadline) {
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

## Query and recover accepted work

If a request times out after submission may have started, reuse its original key and arguments to recover the receipt. Never automatically submit with a new key. When an operation is `outcome_unknown`, or a media job is `unknown`, inspect the provider's accepted work before deciding what to do; another generation may incur another charge.

`waiting_approval` means the normal Kiki approval is still required. Approve or reject it in Kiki, then query the same operation. Scripts cannot elevate the connection's permission ceiling.

For an accepted media job with `can_resume: true`, explicitly resume the same job rather than calling `generate` again:

```sh
kiki tools --client CONNECTION_ID call plugin__kiki_media__media \
  --session-ref SESSION_REF --key resume-example-001 \
  --args '{"action":"resume","job_id":"MEDIA_JOB_ID"}'
```

Resume only continues the saved handle or staged download; it does not buy a new generation. Query with `media` action `get` until an acceptable result is saved. For `partial`, inspect artifact `complete`, `role` and error fields before downloading the artifacts you want. `job download --artifact N` targets a **tool operation whose saved result contains those artifacts**, normally the latest successful `media get`, not the original pending generation receipt.

## HTTP and client reference

All four routes use the usual `{ code, msg, data, request_id }` envelope. A nonzero business `code` can arrive with HTTP 200. Tool data uses `{ content, structuredContent, isError? }`, matching the existing MCP result shape.

| Method and path | Input or result |
| --- | --- |
| `GET /api/external-clients/tools` | `{ tools: [{ name, description, inputSchema, annotations }] }` for this grant |
| `POST /api/external-clients/tools/{name}:call` | `{ arguments, session_ref?, idempotency_key? }`; returns a control result or operation receipt |
| `GET /api/external-clients/jobs/{operation_id}` | Saved operation receipt; never resubmits |
| `GET /api/external-clients/jobs/{operation_id}/result` | Saved result page, with optional `part`, `artifact`, `offset`, `limit` query fields |

For HTTP calls, put bridge fields at the top level, not inside `arguments._kiki`. Side effects require a key of 1–256 characters. `kiki_session` and `kiki_operation` retain their control arguments; for example, cancellation uses `kiki_operation` with `{"operation_id":"OPERATION_ID","action":"cancel"}`.

Without a selector, result pages contain the saved JSON tool result. `part=N` selects a native output-array part; `artifact=N` selects a generated media artifact. Choose only one selector. Limits are 1–256000 (default 12000); text offsets count UTF-16 code units, while media offsets count bytes. Binary chunks are base64 in an embedded resource's `blob`. Follow `structuredContent.range.end` until `complete: true`. Downloads use saved session-owned bytes, not current provider URLs or arbitrary host paths.

The HTTP client SDK exposes the same operations under `klient.rest.externalClients`: `tools(options?)`, `callTool(name, body, options?)`, `job(id, options?)`, and `result(id, range?, options?)`. Create the HTTP client with the connection credential; its owner-management methods remain unavailable to that credential.
