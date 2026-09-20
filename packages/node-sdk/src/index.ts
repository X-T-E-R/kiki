export { installNbSearchWorkerHost, runNbSearchWorkerCommand, NB_SEARCH_WORKER_COMMAND } from '#/nb-search-worker';
export { KimiHarness } from '#/kimi-harness';
export type { KimiHarnessRuntimeOptions } from '#/kimi-harness';
export { Session } from '#/session';
export { KimiAuthFacade } from '#/auth';
export { createKimiHarness, SDKRpcClient, type SDKRpcClientOptions } from '#/sdk-rpc-client';
export {
  createPrintClient,
  flushPrintWires,
  PRINT_MAX_TURNS_DEFAULT,
  PRINT_WAIT_CEILING_S_DEFAULT,
  setClampedTimeout,
} from '#/print-client';
export type { PrintClientHost, AgentTaskConfig, PrintBackgroundMode } from '#/print-client';
export {
  inspectPromptFields,
  listPromptFieldDefinitions,
  type PromptFieldDefinitionInfo,
  type PromptFieldInspectOptions,
  type PromptFieldInspection,
  type PromptFieldSourceInfo,
  type PromptFieldValidationSummary,
  type PromptFieldValueInfo,
} from '#/prompt-fields';
export {
  createKimiConfigRpc,
  KimiConfigRpcClient,
  type KimiConfigRpc,
  type KimiConfigValidationIssue,
  type KimiConfigValidationPathSegment,
  type ResolveKimiConfigPathInput,
  type ValidateKimiConfigTomlInput,
} from '#/config-rpc';
export { SDKRpcClientBase } from '#/rpc';
export { KimiForCodingProvider } from '#/kimi-code-model-provider';
export type { KimiForCodingProviderOptions } from '#/kimi-code-model-provider';
export { removeProviderFromConfig } from '#/v2/config-mapper';

export {
  applyCatalogProvider,
  catalogBaseUrl,
  catalogModelToAlias,
  catalogProviderModels,
  CatalogFetchError,
  DEFAULT_CATALOG_URL,
  fetchCatalog,
  loadBuiltInCatalog,
  resolveCatalogImport,
} from '#/catalog';
export type {
  ApplyCatalogProviderOptions,
  Catalog,
  CatalogImportInvalidReason,
  CatalogImportResolution,
  CatalogModel,
  CatalogProviderEntry,
  FetchCatalogOptions,
} from '#/catalog';

export {
  ErrorCodes,
  KimiError,
  type KimiErrorCode,
  type KimiErrorInfo,
  type KimiErrorOptions,
  type KimiErrorPayload,
  KIMI_ERROR_INFO,
  fromKimiErrorPayload,
  isKimiError,
  toKimiErrorPayload,
} from '#/errors';

// Diagnostic logging — public surface only.
// RootLogger / getRootLogger / LoggingConfig stay internal to the SDK.
export {
  flushDiagnosticLogs,
  flushDiagnosticLogsSync,
  log,
  redact,
  resolveGlobalLogPath,
} from '#/logging';
export type { LogContext, LogLevel, LogPayload, Logger } from '#/logging';
export { resolveKikiHome } from '@kiki/agent-core-v2';

// Host-side config helpers — safe config reader + config path resolution, used
// by hosts (e.g. the CLI's server telemetry bootstrap) that need to inspect
// config without spinning up a full engine.
export { effectiveModelAlias, loadRuntimeConfigSafe, resolveConfigPath } from '#/config';
export { limitAgentReplayByTurns } from '#/wire/replay-turns';
export { parseAgentFileText } from '@kiki/agent-core-v2';
export { resolveAgentPath } from '@kiki/agent-core-v2/workspace/workspaceAgentProfileLoader/internal/paths';

// Process-wide HTTP proxy bootstrap — installed once at CLI startup so all
// outbound fetch honors HTTP_PROXY / HTTPS_PROXY / NO_PROXY.
export { installGlobalProxyDispatcher } from '@kiki/agent-core-v2/_base/utils/proxy';

// Image compression — ingestion sites (e.g. the CLI's clipboard paste, the ACP
// adapter) shrink oversized images while constructing the content part, before
// it enters a prompt. Best effort: returns the original on any failure.
// Compression is never silent: buildImageCompressionCaption renders the note
// placed next to a compressed image, and persistOriginalImage keeps the
// pre-compression bytes readable (ReadMediaFile + region) for detail.
export {
  buildImageCompressionCaption,
  buildUnsupportedImageNotice,
  compressImageForModel,
  compressBase64ForModel,
  gateImageFormatParts,
  isModelAcceptedImageMime,
  normalizeImageMime,
  parseImageDataUrl,
  persistOriginalImage,
  sessionMediaOriginalsDir,
  IMAGE_BYTE_BUDGET,
  MAX_IMAGE_EDGE_PX,
} from '@kiki/agent-core-v2';
export type { ImageCompressionTelemetry } from '@kiki/agent-core-v2';
export type {
  CompressImageOptions,
  CompressImageResult,
  CompressBase64Result,
  ImageCompressionCaptionInput,
} from '@kiki/agent-core-v2/agent/media/image-compress';
export { ImageLimits } from '#/image-limits';

// Experimental feature flags — types only. Resolved values come from
// `KimiHarness.getExperimentalFeatures()` over RPC, not from a re-exported runtime value.
export type {
  ExperimentalFeatureState,
  ExperimentalFlagMap,
  ExperimentalFlagSource,
  FlagDefinitionInput,
  FlagId,
  FlagSurface,
} from '@kiki/agent-core-v2';

// Daemon file references (agent-core-v2) — pure helpers for the internal
// `kimi-file://` media URLs and the model-facing `<image|video|file>` path
// tags. A daemon-ref media part is self-contained (kind from the part type,
// file id from the url) — there is no tag+ref pairing to fold.
// Hosts must not import agent-core-v2 directly; `FileMeta` and
// `UploadFileOptions` ride the `export type * from '#/types'` below.
export {
  buildDaemonFileUrl,
  buildMediaPathTag,
  isDaemonFileUrl,
  matchSingleMediaPathTag,
  parseDaemonFileUrl,
} from '@kiki/agent-core-v2/agent/media/mediaRef';
export type {
  DaemonFileRef,
  MediaKind,
} from '@kiki/agent-core-v2/agent/media/mediaRef';

export type {
  KimiAuthLoginResult,
  KimiAuthLogoutResult,
} from '#/auth';

export * from '#/events';
export type * from '#/types';
