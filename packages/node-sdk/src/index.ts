export { KimiHarness } from '#/kimi-harness';
export type { KimiHarnessRuntimeOptions } from '#/kimi-harness';
export { Session } from '#/session';
export { KimiAuthFacade } from '#/auth';
export { createKimiHarness, SDKRpcClient, type SDKRpcClientOptions } from '#/sdk-rpc-client';
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
  inferWireType,
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
export { resolveKimiHome } from '@moonshot-ai/agent-core-v2';

// Host-side config helpers — safe config reader + config path resolution, used
// by hosts (e.g. the CLI's server telemetry bootstrap) that need to inspect
// config without spinning up a full engine.
export { effectiveModelAlias, loadRuntimeConfigSafe, resolveConfigPath } from '#/config';
export { limitAgentReplayByTurns } from '#/wire/replay-turns';
export { parseAgentFileText } from '@moonshot-ai/agent-core-v2';
export { resolveAgentPath } from '@moonshot-ai/agent-core-v2/workspace/workspaceAgentProfileLoader/internal/paths';
// The synthesized `[models]` alias a `[secondary_model]` recipe with patch
// fields materializes at runtime — hosts filter it out of model pickers.
export { SECONDARY_DERIVED_MODEL_ALIAS } from '#/config';
// Reserved key of the v2 engine's subagent model pool: it always binds the
// caller's own model, so hosts must not offer a user alias named `primary`
// as the subagent default model.
export { PRIMARY_SUBAGENT_MODEL_CHOICE } from '@moonshot-ai/agent-core-v2/session/subagent/configSection';

// Process-wide HTTP proxy bootstrap — installed once at CLI startup so all
// outbound fetch honors HTTP_PROXY / HTTPS_PROXY / NO_PROXY.
export { installGlobalProxyDispatcher } from '@moonshot-ai/agent-core-v2/_base/utils/proxy';

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
} from '@moonshot-ai/agent-core-v2';
export type { ImageCompressionTelemetry } from '@moonshot-ai/agent-core-v2';
export type {
  CompressImageOptions,
  CompressImageResult,
  CompressBase64Result,
  ImageCompressionCaptionInput,
} from '@moonshot-ai/agent-core-v2/agent/media/image-compress';
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
} from '@moonshot-ai/agent-core-v2';

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
} from '@moonshot-ai/agent-core-v2/agent/media/mediaRef';
export type {
  DaemonFileRef,
  MediaKind,
} from '@moonshot-ai/agent-core-v2/agent/media/mediaRef';

export type {
  KimiAuthCompleteFeedbackUploadInput,
  KimiAuthCompleteFeedbackUploadPart,
  KimiAuthCreateFeedbackUploadUrlInput,
  KimiAuthCreateFeedbackUploadUrlOk,
  KimiAuthCreateFeedbackUploadUrlResult,
  KimiAuthFeedbackUploadPart,
  KimiAuthLoginResult,
  KimiAuthLogoutResult,
  KimiAuthSubmitFeedbackInput,
} from '#/auth';

export * from '#/events';
export type * from '#/types';
