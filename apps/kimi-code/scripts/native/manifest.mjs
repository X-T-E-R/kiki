export const BROWSER_DRIVER_ASSET = Object.freeze({
  key: 'browser-driver', relativePath: 'runtime/browser-driver/agent-browser.exe', mode: 0o755,
});

export const NATIVE_ASSET_MANIFEST_VERSION = 2;
export const WEB_ASSET_MANIFEST_VERSION = 1;

export const WINDOWS_PROCESS_HELPER_ASSET = Object.freeze({
  key: 'windows-process-helper',
  relativePath: 'runtime/process/windows-process-helper.exe',
  mode: 0o755,
});

export const MINIDB_TEXT_BUILD_WORKER_ASSET = Object.freeze({
  key: 'minidb-text-build-worker',
  relativePath: 'runtime/minidb/text-build-worker.mjs',
  mode: 0o644,
});

export const KAP_USAGE_PARSER_WORKER_ASSET = Object.freeze({
  key: 'kap-usage-parser-worker',
  relativePath: 'runtime/kap-server/usage-parser-worker.mjs',
  mode: 0o644,
});

export const QUERY_STORE_WORKER_ASSET = Object.freeze({
  key: 'query-store-worker',
  relativePath: 'runtime/query-store/query-store-worker.mjs',
  mode: 0o644,
});

export const USAGE_READ_MODEL_WORKER_ASSET = Object.freeze({
  key: 'usage-read-model-worker',
  relativePath: 'runtime/usage/usage-read-model-worker.mjs',
  mode: 0o644,
});

export const MEMORY_WORKER_ASSET = Object.freeze({
  key: 'memory-worker',
  relativePath: 'runtime/memory/memory-worker.mjs',
  mode: 0o644,
});

export const CPU_WORKER_ASSET = Object.freeze({
  key: 'cpu-worker',
  relativePath: 'runtime/cpu/cpu-worker.mjs',
  mode: 0o644,
});

export const MAILBOX_WORKER_ASSET = Object.freeze({
  key: 'mailbox-worker',
  relativePath: 'runtime/mailbox/mailbox-worker.mjs',
  mode: 0o644,
});

export const KAP_SQLITE_QUERY_WORKER_ASSET = Object.freeze({
  key: 'kap-sqlite-query-worker',
  relativePath: 'runtime/kap-server/sqlite-query-worker.mjs',
  mode: 0o644,
});

export const PLUGIN_HOST_RUNNER_ASSET = Object.freeze({
  key: 'plugin-host-runner',
  relativePath: 'runtime/plugin/hostRunner.mjs',
  mode: 0o644,
});

export const KAP_MODEL_PRICES_ASSET = Object.freeze({
  key: 'kap-model-prices',
  relativePath: 'runtime/kap-server/model_prices_and_context_window.json',
  mode: 0o644,
});

export const KIKI_DOCS_ASSET_KEY_PREFIX = 'kiki-docs/';
export const KIKI_DOCS_RUNTIME_PATH_PREFIX = 'runtime/kiki-docs/';

export function kikiDocsAsset(relativePath) {
  return Object.freeze({
    key: `${KIKI_DOCS_ASSET_KEY_PREFIX}${relativePath}`,
    relativePath: `${KIKI_DOCS_RUNTIME_PATH_PREFIX}${relativePath}`,
    mode: 0o644,
  });
}

export function buildManifestKey(target) {
  return `native/${target}/manifest.json`;
}

export function buildRuntimeAssetKey(target, key) {
  return `native/${target}/runtime/${key}`;
}

export function isManifestVersionSupported(version) {
  return version === NATIVE_ASSET_MANIFEST_VERSION;
}

export function buildAssetKey(target, packageRoot, relativePath) {
  return `native/${target}/${packageRoot}/${relativePath}`;
}

export function buildWebManifestKey(target) {
  return `web/${target}/manifest.json`;
}

export function buildWebAssetKey(target, relativePath) {
  return `web/${target}/dist/web/${relativePath}`;
}
