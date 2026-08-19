export const ErrorCode = {
  SUCCESS: 0,

  VALIDATION_FAILED: 40001,
  REQUEST_MALFORMED: 40002,
  PROVIDER_OAUTH_MANAGED: 40003,
  CATALOG_IMPORT_INVALID: 40004,
  REGISTRY_IMPORT_INVALID: 40005,

  AUTH_PROVISIONING_REQUIRED: 40110,
  AUTH_TOKEN_MISSING: 40111,
  AUTH_TOKEN_UNAUTHORIZED: 40112,
  AUTH_MODEL_NOT_RESOLVED: 40113,

  SESSION_NOT_FOUND: 40401,
  PROMPT_NOT_FOUND: 40402,
  MESSAGE_NOT_FOUND: 40403,
  APPROVAL_NOT_FOUND: 40404,
  QUESTION_NOT_FOUND: 40405,
  TASK_NOT_FOUND: 40406,
  FILE_NOT_FOUND: 40407,
  MCP_SERVER_NOT_FOUND: 40408,
  FS_PATH_NOT_FOUND: 40409,
  WORKSPACE_NOT_FOUND: 40410,
  FS_PERMISSION_DENIED: 40411,
  PROVIDER_NOT_FOUND: 40412,
  MODEL_NOT_FOUND: 40413,
  TERMINAL_NOT_FOUND: 40414,
  SKILL_NOT_FOUND: 40415,
  TOOL_CALL_NOT_FOUND: 40416,
  CATALOG_ENTRY_NOT_FOUND: 40417,
  CAPABILITY_NOT_FOUND: 40418,
  PLUGIN_NOT_FOUND: 40419,
  RUNTIME_NOT_FOUND: 40420,
  /** peer thread reference does not resolve to an existing session */
  THREAD_NOT_FOUND: 40421,
  /** named agent profile does not exist in the requested editable scope */
  AGENT_PROFILE_NOT_FOUND: 40422,

  SESSION_BUSY: 40901,
  APPROVAL_ALREADY_RESOLVED: 40902,
  PROMPT_ALREADY_COMPLETED: 40903,
  TASK_ALREADY_FINISHED: 40904,
  MCP_ALREADY_CONNECTED: 40905,
  FS_IS_DIRECTORY: 40906,
  FS_IS_BINARY: 40907,
  FS_GIT_UNAVAILABLE: 40908,
  QUESTION_DISMISSED: 40909,
  COMPACTION_UNABLE: 40910,
  SESSION_UNDO_UNAVAILABLE: 40911,
  SKILL_NOT_ACTIVATABLE: 40912,

  GOAL_ALREADY_EXISTS: 40913,
  GOAL_NOT_FOUND: 40914,
  GOAL_STATUS_INVALID: 40915,
  GOAL_NOT_RESUMABLE: 40916,
  GOAL_OBJECTIVE_EMPTY: 40917,
  GOAL_OBJECTIVE_TOO_LONG: 40918,
  FS_ALREADY_EXISTS: 40919,
  GOAL_UNSUPPORTED_AGENT: 40920,
  PROVIDER_ALREADY_EXISTS: 40921,
  PAGE_TOKEN_MISMATCH: 40922,
  SESSION_TITLE_UNAVAILABLE: 40923,
  CAPABILITY_INSTALL_IN_PROGRESS: 40924,
  CAPABILITY_UNSUPPORTED: 40925,
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
  PROMPT_ID_CONFLICT: 40938,

  APPROVAL_EXPIRED: 41001,
  QUESTION_EXPIRED: 41002,
  FILE_EXPIRED: 41003,

  FILE_TOO_LARGE: 41301,
  FS_TOO_LARGE: 41302,
  FS_TOO_MANY_RESULTS: 41303,
  FS_PATH_ESCAPES_SESSION: 41304,
  FS_GREP_TIMEOUT: 41305,

  FS_WATCH_LIMIT_EXCEEDED: 42902,
  /** peer-thread list, read, wait, or message bound exceeded */
  THREAD_LIMIT_EXCEEDED: 42903,

  INTERNAL_ERROR: 50001,
  PERSISTENCE_FAILURE: 50003,
  CATALOG_UNAVAILABLE: 50004,
  /** a durably accepted peer message could not be delivered */
  THREAD_DELIVERY_FAILED: 50005,

  TOOL_EXECUTION_FAILED: 60001,
  TOOL_NOT_AVAILABLE: 60002,

} as const;

/**
 * Reserved (intentionally unallocated; do NOT reuse for new variants):
 *   - 40101 auth.invalid_token        (daemon's own token; future)
 *   - 40102 auth.missing_token        (daemon's own token; future)
 *   - 40103 auth.forbidden_origin     (daemon's own token; future)
 *   - 42901 rate.limited
 *   - 50002 protocol.version_mismatch
 *
 * (`ErrorCodeReason` 不随本表迁移：server 侧没有消费方；数字码到字符串
 * reason 的映射仍由 protocol 包为 v1 链路和 server-e2e 持有。)
 */

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
