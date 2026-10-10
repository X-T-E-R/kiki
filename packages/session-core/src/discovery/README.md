# 发现 Kiki：GUI 消费合同

`@kiki/session-core/discovery` 提供方案 A 的路线目录、可恢复学习进度、页面目标和可试动作。它不挂载 GUI，不调用模型，不创建会话，不安装能力，不修改执行状态。GUI 已将地图挂载在 `/discover`；其他目标都是现有生产页面。

## 页面与状态

`DISCOVERY_ROUTES` 定义五站概览和四条兴趣路线；`DISCOVERY_STATIONS` 是十一站共享内容。同一站在不同路线里复用 `seen / tried / skipped` 三个独立事实。`DISCOVERY_EXAMPLES` 是标为“界面示例 · 不会运行”的本地解释对象，不兼容真实 session/transcript 类型，也不进入会话列表。

`reduceDiscoveryState` 是纯转换：

- `start` 选择路线并从首站开始；换路保留原进度。
- `viewed` 在当前站实际呈现后记为已看过；`tried` 由真实控件的成功回执触发。两者不自动换页。
- `next / previous / select / skip` 改当前位置；略过只记 `skipped`，不冒充看过或尝试过。
- `leave` 保留当前位置；`collapse` 只收起纸签；`resume` 显式恢复当前位置。
- 到路线终点为 `finished`。只有 `discoveryRouteProgress(...).viewed` 才表示所有站均看过；到终点和实际运行、配置完成都不是一回事。

`discoveryView(state, context)` 可直接驱动纸签 props：`route / station / destination / visible / collapsed / position / total / progress / actions / canPrevious / canNext / resume / hasNewContent`。用户自己跳到无关页面时 `visible=false`，不产生导航请求；显式续看才恢复目标。

## 持久化与恢复

进度在既有 `kiki.settings` 的 `featureDiscovery` 字段内，键为 `[homeId, connectionId]` 的 JSON tuple。复用 `readSettings / writeSettings / subscribeSettings`，不新增全局 store、storage key、后端服务、门禁或同步协议；字段不属于 portable settings。

`currentDiscoveryScope(connectionId)` 沿既有 active space 给出 home；GUI 可直接用已核实的导航 scope 构造 `DiscoveryScope`。connectionId 必须是无凭证的既有身份，不传 URL/token。`readDiscoveryState` 每次按此 scope 读取，不从别的空间借用进度。`writeDiscoveryState` 白名单保存版本、路线、站点和学习事实，不保存 session/workspace 引用、任务文本、草稿、表单或 return point。

恢复解析把未完成状态读为 `left`，不自动弹出、不自动跳页。旧内容版本保留已看过事实；`hasNewContent` 只在旧版本小于当前版本时出现。查看地图后可发 `acknowledge-content`，不能因版本升级清空学习进度。未知 schema、无效路线/站点组合回到选路。

## 导航与真实动作端口

`DiscoveryContext` 由当前生产页面提供，不在导览里另查模型、重建运行状态或创建 session：

- `sessionId + sessionReachable=true` 只用于当前 home/connection 已核实、未删除/未归档的对象。未核实或不存在时会话站去 `/new`，在导览区域显示本地示例；没有 `/s/demo`。
- `workspaceId / personaId` 仅携带当前过滤上下文。Memory 保留两个范围；Board/Cron/Capabilities 保留 workspace。无工作区照常浏览，不要求创建。
- `online` 来自现有连接状态；`sessionBusy` 来自生产会话状态；`draftEmpty` 来自现有草稿与附件状态。
- `anchors` 是真实已挂载、可操作的语义控件。能力详情、看板详情和定时任务详情还需要相应 `data` 为 true；空列表或加载失败不能报告实际动作完成。记忆的范围切换和用量筛选不要求先有数据。

`navigateDiscovery` 将显式选路/选站/前后站/续看送入 `DiscoveryNavigationPort.navigate`，只有 `committed` 才提交新位置。取消 dirty 提醒或页面不可达分别返回 `cancelled / unavailable`，保留原位置。收起、离开及学习标记不调用导航端口。传入与当前页面/空间生命周期绑定的 `AbortSignal`；换空间、离开或被新请求替代时取消，迟到回执不会改变进度。

前端适配必须复用 `useGuardedNavigate` 和既有 nav history。`GuardedNavigate` 返回 `void | Promise<void>`，不能把调用返回当作成功；端口应观察目标 visit 已提交/页面已挂载，以及 dirty 对话取消。设置目标保留 `#st-card-*` 和现有 mount 握手，不另起定时器定位。

`tryDiscoveryAction` 只执行当前页面可用动作，并等待 `DiscoveryActionPort.perform` 的观察结果。`done` 才记进度；例子和扩展方向链接只记已看过。真实控件或草稿填入成功才记已尝试。草稿动作明确 `send=false / overwrite=false`；适配器执行时再次核实空草稿且无附件，不把提前投影的 `draftEmpty` 当成可覆盖许可。发送、queue/steer、审批和真实 `/kiki-ops` 首任务继续归原 consumer。

## GUI 接线合同

- App 注册 `DISCOVERY_ENTRY_PATH`，侧栏放永久入口。欢迎完成和导览进度分开；欢迎末页平铺 `DISCOVERY_ROUTES` 的五条路线，与 `/discover` 复用 `DiscoveryRouteRow`。点一行通过真实 `startRoute` 开始该路线，导航成功后结束欢迎向导；取消导航则保留向导和原进度。模型连接和真实任务上手留在 Discover 与各自生产页面。
- 在真实页面页头下挂纸签，不占 RightRail、不盖 Composer；窄窗/开始输入/审批时用 `collapsed` 让位。
- `workspace-picker / materials / work-mode` 接 NewSessionPage/Composer 现有控件；`agent-panel` 接 SessionView 的 `[data-rail-toggle]`；`send-controls` 接运行时真实发送控件，只打开/解释，不发送消息。
- `memory-scope / capability-detail / board-detail / cron-detail / result-detail / usage-filter` 接各页面现有操作并按实际 mount/data 宣告可用。无数据保留生产空态，本地例子仅放纸签。
- 进入前用现有 nav history 保留 `visitId`；`DiscoveryReturnPoint` 只在内存引用该 visit。`discoveryCanReturn` 核实同一 scope 后由既有 history 恢复布局与草稿，不把路由或任务文本复制进学习偏好。

本模块无新的 klient/server procedure。生产类型与权限继续由已有 facade 和页面提供；GUI 集成、实际页头布局、键盘路径和真实端口交互仍由 GUI owner 验证。
