# 本地服务与 API

Kiki 的本地服务就是共享 daemon。使用 `kiki serve` 启动、复用或停止交互式 TUI、桌面 GUI 与外部调用方共用的 daemon；它提供 REST API（`/api`）和 WebSocket 事件流（`/api/ws`）；安装了 GUI 资源时，也提供浏览器界面。需要让另一台设备的浏览器进入这台 Kiki 时，用 `kiki web` 在同一个 daemon 上开启 [Web 访问](#在浏览器里使用-kiki)。Kiki GUI 用于在浏览器里直接使用 Kiki；REST 与 WebSocket API 面向脚本和第三方工具，可以用代码创建会话、提交提示词、实时跟进执行过程——它们与 TUI、Kiki GUI 读写同一份会话数据。

> 开始前请确认 Kiki 已安装并处于可用状态——完成 `/login` 登录（TUI 内或 `kiki login`），或已在 `config.toml` 配置供应商。服务与 CLI 共享同一份登录态与配置，无需为服务单独准备凭证。

::: warning 注意
本页介绍的 REST 与 WebSocket API 为实验性特性：不保证接口稳定性，端点、字段与事件类型可能随版本随时更改。集成时请以当前版本服务的 `/openapi.json` 与 `/asyncapi.json` 为准。
:::

## 启动或复用共享 daemon

交互式 TUI 和外部调用方共用的 daemon 用 `kiki serve` 控制：

```sh
kiki serve
kiki serve --ensure --workspace . --json
kiki serve --stop
```

不带模式时，`serve` 在前台运行 daemon；`--query --json` 只检查当前实例；`--ensure` 连接已有健康实例或启动新实例；`--stop` 停止所选 home 下当前可达的实例。活跃实例身份无法验证时，须先停止或升级它，Kiki 才会启动其他实例。`--idle-exit` 默认是 `30m`；活跃客户端 lease（定期续期，表示客户端仍在使用 daemon）和运行中的派遣会让服务保持运行。显式 `--idle-exit 0ms` 让新启动的 daemon 一直运行到你手动停止。工作区信任后，TUI 自动执行同样的连接或启动逻辑。

## 在另一台设备的浏览器里打开

`kiki web` 不再自己起一个前台服务。它找到这个 home 的共享 daemon（没有就先启动一个，并让它一直运行到你停止），在上面开启 Web 访问，打印一条一次性进入链接，然后返回：

```sh
kiki web                 # 临时开启 Web 访问，打印链接并在本机浏览器打开
kiki web --no-open       # 只打印链接，不打开浏览器
kiki web --json          # 以 JSON 输出状态和链接，便于脚本读取
```

daemon 本身只监听 `127.0.0.1`。不带 `--port` 时，Web 访问复用 daemon 的本机端口；`--host`、`--port`、`--public-url` 另开一个监听，专供浏览器使用。终端输出里不会出现 `#token=` 或 local-owner 凭据。会话、撤销和网络选项见下方[在浏览器里使用 Kiki](#在浏览器里使用-kiki)，全部选项见 [kiki 命令参考](../reference/command.md#kiki-web)。

## 鉴权

本地管理与远端 peer 访问使用不同凭据。可信本地启动器读取 `<home>/server.local-owner`，这是跨重启保存的私有本地管理凭据（Unix 文件权限为 0600）。桌面 GUI、TUI 和本地 CLI 用它连接同一 home。请保持私有，不要复制给远端 home，也不要填进远端连接配置。公开健康检查不要求 API 鉴权。

远端 GUI 访问要求目标开启入站开关，并持有针对源 home 审批的 grant（连接许可）。使用十分钟有效的一次性配对码（`kiki pair`）或一步式 SSH 连接（`kiki connections ssh connect`）会为该条授权签发独立的对等凭据，并在 daemon 绑定回环地址时自动在本机可达的局域网和 Tailscale IPv4 地址上开启直连对等监听；旧版邀请连接则额外校验目标 `server.token` 中的当前 owner token。单独的 owner token、loopback 隧道或代理请求头都不能获得普通 REST/WebSocket 访问。源后端保存远端凭据，只为固定连接转发受支持的操作；renderer 不保留远端秘密。配对、邀请与 SSH 配置见 [`kiki pair` 与 `kiki connections`](../reference/command.md#kiki-pair)。Thread bridge 使用独立凭据，撤销某次配对授权会同时撤销随该次配对签发的 bridge 授权。

可信本地客户端可按以下方式携带 local-owner 凭据：

- **REST**：请求头 `Authorization: Bearer <token>`。
- **Kiki GUI**：桌面 GUI 和本机启动器带着 local-owner 凭据直接连接；地址里的 `#token=` 片段也被接受，它不会发送到服务端。另一台设备的浏览器不走这条路，而是用 [Web 访问](#在浏览器里使用-kiki)的一次性链接。
- **WebSocket**：能自定义请求头的客户端用 `Authorization: Bearer`；浏览器等不能自定义头的客户端，把 token 放进握手子协议 `kimi-code.bearer.<token>`。

远端 owner token 泄露时运行 `kiki web rotate-token`：它替换 `server.token`，使旧远端凭据失效，并停止受影响的 peer 流，无需重启。它不会轮换 `server.local-owner`，所以该文件泄露要按本地访问已失守处理。

桌面 GUI 通过原生启动器发现本机实例，用 local-owner 凭据认证，并验证服务身份和连接协议后再连接。桌面壳与服务的构建可以不同，只要协议兼容；状态和诊断显示服务实际的构建信息。已识别的服务协议不兼容时，Kiki 会报告问题，不会另外启动第二个服务。没有发现实例时，才会启动随桌面捆绑的后端。

后台重启或端口、token 变化后，桌面会自动重新发现服务，确认仍属于原 home、当前空间和原认证模式。临时失败从 1 秒开始指数退避，最长 10 秒。草稿、当前会话路由和阅读位置原位保留。来自另一个 home、空间或认证模式的候选会被拒绝，原视图继续保留。

因此，同一 home 下受支持的本地客户端共享同一批会话，与具体哪个启动器启动服务无关。

::: warning 注意
两个彼此独立预配、互不信任的运行时——分属不同 host 身份、各自拥有权限域的两个服务——不要共享同一个可写 `KIKI_HOME`，不要在它们的 home 之间复制会话目录，也不要复制 `device_id` 让两个 home 冒充同一台 host。会话索引、thread 归属与权限边界都依赖 home 身份的唯一性。同一 home 下的共享 daemon、TUI、桌面 GUI 与并存的服务实例是受支持的协作方式，不在此列。
:::

Web 访问的监听要绑定非本机地址（`--host`，包括裸 `--host`，即 `0.0.0.0`）时，需要 `--public-url` 指向一个终结 TLS 的 HTTPS 反向代理，或加 `--insecure-no-tls`；两者都没有时会拒绝开启。设置 `KIKI_PASSWORD` 可作为另一种 owner 凭据；它不能替代 local-owner 或逐源 grant。服务端会对鉴权失败自动限流。

## 在浏览器里使用 Kiki

Web 访问是另一台设备的浏览器进入**这台** Kiki 的入口。拿到链接的人可以完整使用这台 Kiki，权限和你相同——它不是只读分享；「临时」只表示门开着多久，不表示能做什么。

可以在 GUI 的**设置 → 连接与远程 → 外部接入 → 网页访问**里开启，也可以在终端里：

```sh
kiki web --temporary            # 默认：临时开启八小时，之后自己关闭
kiki web --persistent           # 一直开着，直到你手动关闭
kiki web --status               # 当前是否开启，以及哪些浏览器已登录
kiki web --off                  # 关闭 Web 访问，不停止 Kiki 和它的任务
kiki web --revoke [session-id]  # 注销某个浏览器，或全部注销
kiki web --host --public-url https://kiki.example.test   # 经终结 TLS 的反向代理让其他设备连上
kiki web --host --insecure-no-tls                        # 允许明文局域网 HTTP（见下方警告）
```

TUI 里对应的是 `/web temporary|persistent|status|off|link|revoke [id]`，可搭配 `--host`、`--port`、`--public-url`、`--insecure-no-tls`、`--no-open`。

每次开启会打印一个一次性链接，十分钟内有效，只能让一个浏览器登录；GUI 里的**为另一台设备生成链接**、TUI 里的 `/web link` 都会另签一条。Kiki 用它换取一个由浏览器自己保管的 session cookie（HttpOnly、`SameSite=Strict`、host-only，HTTPS 下带 `Secure`）；JavaScript、`localStorage` 和 URL 查询参数里都不会留下 session 或根 token。服务端只保留摘要，链接丢失、过期或用过后需要重新生成，而不是找回同一个。始终开启模式下，已经授权的浏览器可以跨服务重启继续使用，闲置 30 天后失效；临时模式下浏览器会话随这次开启一起结束。新设备需要新链接。

关闭 Web 访问会撤销全部链接和浏览器会话，并关闭已打开的连接流；它不会停止 daemon、桌面应用或 TUI，也不会取消已经开始的任务。`kiki serve` 和桌面应用都不受影响。

::: warning 注意
明文 LAN HTTP（`--insecure-no-tls`）没有加密，同一网络里的其他人可以读到传输的内容。超出你信任的网络时，请在前面放一个终结 TLS 的反向代理并传入 `--public-url <https://…>`，此时 Web 访问走该来源。
:::

Web 访问与远端 Kiki 连接是两种不同的对象。远端 Kiki 是另一台 Kiki，有自己的身份和需要你审批的按来源 grant；Web 链接是对**这台** Kiki 的访问，由本机 owner 掌控。Web 访问不改变 peer 授权，开启它也不会让任何 Kiki 进入。

## 用 API 驱动一个会话

下面用 curl 走一遍最小流程：确认服务状态 → 创建会话 → 订阅事件 → 提交提示词 → 回读历史。示例假设服务跑在默认地址，可信本地的 local-owner 凭据已存入 shell 变量 `TOKEN`。

1. 确认服务状态：

```sh
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:58627/api/meta
```

所有 JSON 响应都包在统一信封里——`{ "code": 0, "msg": "success", "data": ..., "request_id": "..." }`，业务结果以 `code` 为准（`0` 表示成功），HTTP 状态码只表达传输层结果。

2. 创建会话，`metadata.cwd` 指定工作目录：

```sh
curl -s -X POST http://127.0.0.1:58627/api/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"metadata": {"cwd": "/path/to/project"}}'
```

返回的 `data.id`（形如 `session_...`）就是后续所有请求要用的会话 id。

3. 连接 WebSocket 并订阅会话事件。任何 WebSocket 客户端都可以；下面是一个零依赖的 Node.js 脚本（Node.js 22+ 内置 `WebSocket` 客户端）：

```js
// subscribe.mjs —— 用法：TOKEN=... node subscribe.mjs session_...
const ws = new WebSocket('ws://127.0.0.1:58627/api/ws', [
  `kimi-code.bearer.${process.env.TOKEN}`,
]);
ws.onmessage = (e) => console.log(e.data);
ws.onopen = () =>
  ws.send(
    JSON.stringify({
      type: 'subscribe',
      id: '1',
      payload: { session_ids: [process.argv[2]] },
    }),
  );
```

4. 提交提示词：

```sh
curl -s -X POST http://127.0.0.1:58627/api/sessions/<session_id>/prompts \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": [{"type": "text", "text": "用一句话介绍这个仓库"}]}'
```

订阅端会依次看到 `turn.started`（轮次开始）→ `assistant.delta`（流式文本增量）→ 发生工具调用时的 `tool.call.started` / `tool.result` → `turn.ended`（轮次结束）。

5. 随时可以用 REST 回读历史消息：

```sh
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:58627/api/sessions/<session_id>/messages?page_size=20"
```

## 在线规范文档

服务运行时会自描述两份规范文档，同样需要 bearer token：

- `GET /openapi.json` — REST API 的 OpenAPI 文档，含每个端点的请求 / 响应 schema，可直接导入 Swagger UI、Postman 等工具。
- `GET /asyncapi.json` — WebSocket 协议的 AsyncAPI 文档，覆盖控制帧与事件类型。

## 下一步

- [服务 API](./rest-api.md) — REST 端点全集、错误码、WebSocket 事件与转录协议
- [kiki 命令](../reference/command.md#kiki-web) — `kiki web` 的全部命令行选项
