/**
 * Integer namespaces:
 *   - 0          success
 *   - 4xxxx      客户端错误 (HTTP-4xx analog)
 *   - 5xxxx      daemon 内部错误
 *   - 6xxxx      工具运行时
 *   - 7xxxx      LLM provider 透传 (msg = original upstream text)
 *   - 8xxxx      MCP server 透传 (msg = original upstream text)
 *   - 9xxxx      预留
 */

export const ErrorCode = {
  /** 成功 */
  SUCCESS: 0,

  /** Zod 校验失败，`details` 含字段路径列表 */
  VALIDATION_FAILED: 40001,
  /** JSON 解析失败、字段类型错 */
  REQUEST_MALFORMED: 40002,
  /** provider 的凭据由 OAuth 管理，拒绝手工写 api_key */
  PROVIDER_OAUTH_MANAGED: 40003,
  /** 导入的 model catalog 文档不合法 */
  CATALOG_IMPORT_INVALID: 40004,
  /** 导入的 registry 文档不合法 */
  REGISTRY_IMPORT_INVALID: 40005,

  /** 客户端握手携带的 daemon 令牌缺失或不匹配（klient IPC hello） */
  AUTH_INVALID_TOKEN: 40101,

  /** daemon 没有任何 provider 配置 */
  AUTH_PROVISIONING_REQUIRED: 40110,
  /** provider 存在但 token / api_key 缺失 */
  AUTH_TOKEN_MISSING: 40111,
  /** 刷新 token 收到 401（用户撤销了授权） */
  AUTH_TOKEN_UNAUTHORIZED: 40112,
  /** 默认 / 请求的 model 解析不到 provider */
  AUTH_MODEL_NOT_RESOLVED: 40113,

  /** session_id 不存在 */
  SESSION_NOT_FOUND: 40401,
  /** prompt_id 不存在 */
  PROMPT_NOT_FOUND: 40402,
  /** message_id 不存在 */
  MESSAGE_NOT_FOUND: 40403,
  /** approval_id 不存在 */
  APPROVAL_NOT_FOUND: 40404,
  /** question_id 不存在 */
  QUESTION_NOT_FOUND: 40405,
  /** task_id 不存在 */
  TASK_NOT_FOUND: 40406,
  /** file_id 不存在 */
  FILE_NOT_FOUND: 40407,
  /** mcp_server_id 不存在 */
  MCP_SERVER_NOT_FOUND: 40408,
  /** fs path 不存在 */
  FS_PATH_NOT_FOUND: 40409,
  /** workspace_id 不存在 */
  WORKSPACE_NOT_FOUND: 40410,
  /** fs 路径存在但当前进程无权限读取 */
  FS_PERMISSION_DENIED: 40411,
  /** provider_id 不存在 */
  PROVIDER_NOT_FOUND: 40412,
  /** model_id 不存在 */
  MODEL_NOT_FOUND: 40413,
  /** terminal_id 不存在 */
  TERMINAL_NOT_FOUND: 40414,
  /** skill_name 不存在 */
  SKILL_NOT_FOUND: 40415,
  /** tool_call_id 不存在，或该调用没有对应的 plan（非 ExitPlanMode） */
  TOOL_CALL_NOT_FOUND: 40416,
  /** model catalog 条目不存在 */
  CATALOG_ENTRY_NOT_FOUND: 40417,
  /** capability_id 不存在 */
  CAPABILITY_NOT_FOUND: 40418,
  /** plugin_id 不存在 */
  PLUGIN_NOT_FOUND: 40419,
  /** runtime_id 不存在 */
  RUNTIME_NOT_FOUND: 40420,
  /** peer thread reference does not resolve to an existing session */
  THREAD_NOT_FOUND: 40421,
  /** named agent profile does not exist in the requested editable scope */
  AGENT_PROFILE_NOT_FOUND: 40422,

  /** session 有正在进行的 prompt，拒绝新请求 */
  SESSION_BUSY: 40901,
  /** approval 已被其他 client 应答 */
  APPROVAL_ALREADY_RESOLVED: 40902,
  /** prompt 已结束（abort 幂等返回 0） */
  PROMPT_ALREADY_COMPLETED: 40903,
  /** task 已完结，无法取消 */
  TASK_ALREADY_FINISHED: 40904,
  /** mcp restart 时若已在 connecting/connected */
  MCP_ALREADY_CONNECTED: 40905,
  /** fs.read 请求 file，但 path 是目录 */
  FS_IS_DIRECTORY: 40906,
  /** fs.read 请求 utf-8，但 path 是二进制；client 改走 `:download` */
  FS_IS_BINARY: 40907,
  /** fs.git_status 但 session.cwd 不是 git repo */
  FS_GIT_UNAVAILABLE: 40908,
  /** 用户 ESC / 关闭面板放弃整组（client 调 `:dismiss`） */
  QUESTION_DISMISSED: 40909,
  /** 当前历史没有可 compact 的前缀 */
  COMPACTION_UNABLE: 40910,
  /** 当前历史没有足够的用户提示词可撤回 */
  SESSION_UNDO_UNAVAILABLE: 40911,
  /** skill 存在但类型不支持用户激活（如 reference 类型） */
  SKILL_NOT_ACTIVATABLE: 40912,

  /** 当前会话已存在活跃 goal */
  GOAL_ALREADY_EXISTS: 40913,
  /** 目标不存在 */
  GOAL_NOT_FOUND: 40914,
  /** goal 状态不允许该操作 */
  GOAL_STATUS_INVALID: 40915,
  /** goal 当前状态不可恢复 */
  GOAL_NOT_RESUMABLE: 40916,
  /** goal objective 为空 */
  GOAL_OBJECTIVE_EMPTY: 40917,
  /** goal objective 超过长度限制 */
  GOAL_OBJECTIVE_TOO_LONG: 40918,
  /** fs.mkdir 目标路径已存在（文件或目录） */
  FS_ALREADY_EXISTS: 40919,
  /** goal 只允许主 agent 使用 */
  GOAL_UNSUPPORTED_AGENT: 40920,
  /** provider_id 已存在 */
  PROVIDER_ALREADY_EXISTS: 40921,
  /** page_token 与当前查询不匹配 */
  PAGE_TOKEN_MISMATCH: 40922,
  /** 标题生成当前不可用（无可用模型 / 已在进行） */
  SESSION_TITLE_UNAVAILABLE: 40923,
  /** 同一 capability 的安装已在进行 */
  CAPABILITY_INSTALL_IN_PROGRESS: 40924,
  /** capability 在当前平台不受支持 */
  CAPABILITY_UNSUPPORTED: 40925,
  /** 目标 runtime 当前不可用 */
  RUNTIME_UNAVAILABLE: 40926,
  /** target thread is archived */
  THREAD_ARCHIVED: 40927,
  /** peer-thread communication is disabled for the workspace */
  THREAD_DISABLED: 40928,
  /** the reference points at another host */
  THREAD_CROSS_HOST: 40929,
  /** source and target identify the same thread */
  THREAD_SELF_SEND: 40930,
  /** thread cursor is malformed, stale, or belongs to another query */
  THREAD_CURSOR_INVALID: 40931,
  /** an idempotency key was reused with a different payload */
  THREAD_IDEMPOTENCY_CONFLICT: 40932,
  /** session is active in another process sharing the same home */
  SESSION_LOCKED: 40933,
  /** named agent profile is backed by a non-editable source */
  AGENT_PROFILE_READ_ONLY: 40934,
  /** MCP server is loaded from a plugin or project-root file */
  MCP_SERVER_READ_ONLY: 40935,
  /** target message cannot be used for the requested action */
  MESSAGE_ACTION_UNAVAILABLE: 40936,
  /** expected session event cursor no longer matches the current watermark */
  SESSION_CURSOR_MISMATCH: 40937,
  /** prompt_id 已在该 agent 的历史中使用 */
  PROMPT_ID_CONFLICT: 40938,
  /** session index 仍在构建，列表/搜索暂不可用 */
  SESSION_INDEX_BUILDING: 40939,
  /** MCP OAuth flow failed, expired, or was cancelled */
  MCP_OAUTH_FAILED: 40940,

  /** approval 60s 超时 */
  APPROVAL_EXPIRED: 41001,
  /** question 60s 超时 */
  QUESTION_EXPIRED: 41002,
  /** 临时文件已过期 */
  FILE_EXPIRED: 41003,

  /** 文件过大（如 session 导出超限；/files 上传不设上限） */
  FILE_TOO_LARGE: 41301,
  /** fs.read 超 10MB */
  FS_TOO_LARGE: 41302,
  /** fs.list / fs.search / fs.grep 命中超上限 */
  FS_TOO_MANY_RESULTS: 41303,
  /** path 越出 session cwd 边界 */
  FS_PATH_ESCAPES_SESSION: 41304,
  /** fs.grep 执行 >30s */
  FS_GREP_TIMEOUT: 41305,

  /** 请求频率超过服务端限制 */
  RATE_LIMITED: 42901,
  /** WS 单连接 watch_paths > 100 */
  FS_WATCH_LIMIT_EXCEEDED: 42902,
  /** peer-thread list, read, wait, or message bound exceeded */
  THREAD_LIMIT_EXCEEDED: 42903,

  /** 兜底 */
  INTERNAL_ERROR: 50001,
  /** 写入 session 持久化失败 */
  PERSISTENCE_FAILURE: 50003,
  /** model catalog 后端不可用 */
  CATALOG_UNAVAILABLE: 50004,
  /** a durably accepted peer message could not be delivered */
  THREAD_DELIVERY_FAILED: 50005,

  /** tool 执行抛错 */
  TOOL_EXECUTION_FAILED: 60001,
  /** tool 在此 session 未启用 */
  TOOL_NOT_AVAILABLE: 60002,

  /** provider.* — provider 原 code 含义保留；`msg` 字段透传上游错误文本。 */
  /** mcp.* — mcp server 原 code 含义保留；`msg` 字段透传上游错误文本。 */
} as const;

/**
 * Reserved (intentionally unallocated; do NOT reuse for new variants):
 *   - 40102 auth.missing_token        (daemon's own token; future)
 *   - 40103 auth.forbidden_origin     (daemon's own token; future)
 *   - 50002 protocol.version_mismatch
 */

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ErrorCodeReason: Readonly<Record<ErrorCode, string>> = {
  [ErrorCode.SUCCESS]: 'success',

  [ErrorCode.VALIDATION_FAILED]: 'validation.failed',
  [ErrorCode.REQUEST_MALFORMED]: 'request.malformed',
  [ErrorCode.PROVIDER_OAUTH_MANAGED]: 'provider.oauth_managed',
  [ErrorCode.CATALOG_IMPORT_INVALID]: 'catalog.import_invalid',
  [ErrorCode.REGISTRY_IMPORT_INVALID]: 'registry.import_invalid',

  [ErrorCode.AUTH_INVALID_TOKEN]: 'auth.invalid_token',
  [ErrorCode.AUTH_PROVISIONING_REQUIRED]: 'auth.provisioning_required',
  [ErrorCode.AUTH_TOKEN_MISSING]: 'auth.token_missing',
  [ErrorCode.AUTH_TOKEN_UNAUTHORIZED]: 'auth.token_unauthorized',
  [ErrorCode.AUTH_MODEL_NOT_RESOLVED]: 'auth.model_not_resolved',

  [ErrorCode.SESSION_NOT_FOUND]: 'session.not_found',
  [ErrorCode.PROMPT_NOT_FOUND]: 'prompt.not_found',
  [ErrorCode.MESSAGE_NOT_FOUND]: 'message.not_found',
  [ErrorCode.APPROVAL_NOT_FOUND]: 'approval.not_found',
  [ErrorCode.QUESTION_NOT_FOUND]: 'question.not_found',
  [ErrorCode.TASK_NOT_FOUND]: 'task.not_found',
  [ErrorCode.FILE_NOT_FOUND]: 'file.not_found',
  [ErrorCode.MCP_SERVER_NOT_FOUND]: 'mcp.server_not_found',
  [ErrorCode.FS_PATH_NOT_FOUND]: 'fs.path_not_found',
  [ErrorCode.WORKSPACE_NOT_FOUND]: 'workspace.not_found',
  [ErrorCode.FS_PERMISSION_DENIED]: 'fs.permission_denied',
  [ErrorCode.PROVIDER_NOT_FOUND]: 'provider.not_found',
  [ErrorCode.MODEL_NOT_FOUND]: 'model.not_found',
  [ErrorCode.TERMINAL_NOT_FOUND]: 'terminal.not_found',
  [ErrorCode.SKILL_NOT_FOUND]: 'skill.not_found',
  [ErrorCode.TOOL_CALL_NOT_FOUND]: 'tool_call.not_found',
  [ErrorCode.CATALOG_ENTRY_NOT_FOUND]: 'catalog.entry_not_found',
  [ErrorCode.CAPABILITY_NOT_FOUND]: 'capability.not_found',
  [ErrorCode.PLUGIN_NOT_FOUND]: 'plugin.not_found',
  [ErrorCode.RUNTIME_NOT_FOUND]: 'runtime.not_found',
  [ErrorCode.THREAD_NOT_FOUND]: 'thread.not_found',
  [ErrorCode.AGENT_PROFILE_NOT_FOUND]: 'agent_profile.not_found',

  [ErrorCode.SESSION_BUSY]: 'session.busy',
  [ErrorCode.APPROVAL_ALREADY_RESOLVED]: 'approval.already_resolved',
  [ErrorCode.PROMPT_ALREADY_COMPLETED]: 'prompt.already_completed',
  [ErrorCode.TASK_ALREADY_FINISHED]: 'task.already_finished',
  [ErrorCode.MCP_ALREADY_CONNECTED]: 'mcp.already_connected',
  [ErrorCode.FS_IS_DIRECTORY]: 'fs.is_directory',
  [ErrorCode.FS_IS_BINARY]: 'fs.is_binary',
  [ErrorCode.FS_GIT_UNAVAILABLE]: 'fs.git_unavailable',
  [ErrorCode.QUESTION_DISMISSED]: 'question.dismissed',
  [ErrorCode.COMPACTION_UNABLE]: 'compaction.unable',
  [ErrorCode.SESSION_UNDO_UNAVAILABLE]: 'session.undo_unavailable',
  [ErrorCode.SKILL_NOT_ACTIVATABLE]: 'skill.not_activatable',

  [ErrorCode.GOAL_ALREADY_EXISTS]: 'goal.already_exists',
  [ErrorCode.GOAL_NOT_FOUND]: 'goal.not_found',
  [ErrorCode.GOAL_STATUS_INVALID]: 'goal.status_invalid',
  [ErrorCode.GOAL_NOT_RESUMABLE]: 'goal.not_resumable',
  [ErrorCode.GOAL_OBJECTIVE_EMPTY]: 'goal.objective_empty',
  [ErrorCode.GOAL_OBJECTIVE_TOO_LONG]: 'goal.objective_too_long',
  [ErrorCode.FS_ALREADY_EXISTS]: 'fs.already_exists',
  [ErrorCode.GOAL_UNSUPPORTED_AGENT]: 'goal.unsupported_agent',
  [ErrorCode.PROVIDER_ALREADY_EXISTS]: 'provider.already_exists',
  [ErrorCode.PAGE_TOKEN_MISMATCH]: 'page_token.mismatch',
  [ErrorCode.SESSION_TITLE_UNAVAILABLE]: 'session.title_unavailable',
  [ErrorCode.CAPABILITY_INSTALL_IN_PROGRESS]: 'capability.install_in_progress',
  [ErrorCode.CAPABILITY_UNSUPPORTED]: 'capability.unsupported',
  [ErrorCode.RUNTIME_UNAVAILABLE]: 'runtime.unavailable',
  [ErrorCode.THREAD_ARCHIVED]: 'thread.archived',
  [ErrorCode.THREAD_DISABLED]: 'thread.disabled',
  [ErrorCode.THREAD_CROSS_HOST]: 'thread.cross_host',
  [ErrorCode.THREAD_SELF_SEND]: 'thread.self_send',
  [ErrorCode.THREAD_CURSOR_INVALID]: 'thread.cursor_invalid',
  [ErrorCode.THREAD_IDEMPOTENCY_CONFLICT]: 'thread.idempotency_conflict',
  [ErrorCode.SESSION_LOCKED]: 'session.locked',
  [ErrorCode.AGENT_PROFILE_READ_ONLY]: 'agent_profile.read_only',
  [ErrorCode.MCP_SERVER_READ_ONLY]: 'mcp.server_read_only',
  [ErrorCode.MESSAGE_ACTION_UNAVAILABLE]: 'message.action_unavailable',
  [ErrorCode.SESSION_CURSOR_MISMATCH]: 'session.cursor_mismatch',
  [ErrorCode.PROMPT_ID_CONFLICT]: 'prompt.id_conflict',
  [ErrorCode.SESSION_INDEX_BUILDING]: 'session.index_building',
  [ErrorCode.MCP_OAUTH_FAILED]: 'mcp.oauth_failed',

  [ErrorCode.APPROVAL_EXPIRED]: 'approval.expired',
  [ErrorCode.QUESTION_EXPIRED]: 'question.expired',
  [ErrorCode.FILE_EXPIRED]: 'file.expired',

  [ErrorCode.FILE_TOO_LARGE]: 'file.too_large',
  [ErrorCode.FS_TOO_LARGE]: 'fs.too_large',
  [ErrorCode.FS_TOO_MANY_RESULTS]: 'fs.too_many_results',
  [ErrorCode.FS_PATH_ESCAPES_SESSION]: 'fs.path_escapes_session',
  [ErrorCode.FS_GREP_TIMEOUT]: 'fs.grep_timeout',

  [ErrorCode.RATE_LIMITED]: 'rate.limited',
  [ErrorCode.FS_WATCH_LIMIT_EXCEEDED]: 'fs.watch_limit_exceeded',
  [ErrorCode.THREAD_LIMIT_EXCEEDED]: 'thread.limit_exceeded',

  [ErrorCode.INTERNAL_ERROR]: 'internal.error',
  [ErrorCode.PERSISTENCE_FAILURE]: 'persistence.failure',
  [ErrorCode.CATALOG_UNAVAILABLE]: 'catalog.unavailable',
  [ErrorCode.THREAD_DELIVERY_FAILED]: 'thread.delivery_failed',

  [ErrorCode.TOOL_EXECUTION_FAILED]: 'tool.execution_failed',
  [ErrorCode.TOOL_NOT_AVAILABLE]: 'tool.not_available',
};
