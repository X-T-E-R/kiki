/**
 * Kimi Code entry point.
 *
 * Parses CLI arguments via Commander.js, validates options, then delegates to
 * the requested UI runner.
 */

import '@kiki/node-sdk/native-fs-watch-error-guard';
import { initializeNbSearchWorkerEntry } from './native/nb-search-worker';
import { runSqliteIndexerCommand } from '@kiki/kap-server/sqlite-indexer-runtime';
import { isSea } from 'node:sea';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CommanderError } from 'commander';

import {
  assertMailboxStartupReady,
  flushDiagnosticLogs,
  installGlobalProxyDispatcher,
  log,
  resolveGlobalLogPath,
  resolveKikiHome,
} from '@kiki/node-sdk';

import { createProgram } from './cli/commands';
import { drainStdio, finalizeHeadlessRun } from './cli/headless-exit';
import { startupTrace } from './utils/startup-trace';
import type { CLIOptions } from './cli/options';
import { OptionConflictError, PromptInputError, validateOptions } from './cli/options';
import { runPrompt } from './cli/run-prompt';
import { runShell } from './cli/run-shell';
import { formatStartupError } from './cli/startup-error';
import { runPluginNodeEntry } from './cli/sub/plugin-run-node';
import { getVersion } from './cli/version';
import { PROCESS_NAME } from './constant/app';
import { SOURCE_OWNED_ADAPTER_ROOT_ENV } from '../../../scripts/external-harness/production-manifest.mjs';
import { cleanupStaleNativeCacheForCurrent, getPluginHostRunnerFile, getHistoryImportEntryFile, getKapSqliteQueryWorkerFile, getSourceOwnedAdapterRoot, getWindowsProcessHelperFile } from './native/native-assets';
import { installMinidbTextBuildWorker } from './native/minidb-worker';
import { installKapModelPricing } from './native/model-pricing';
import { installKikiDocs } from './native/product-docs';
import { installKapUsageWorker } from './native/usage-worker';
import { installQueryStoreWorker } from './native/query-store-worker';
import { installUsageReadModelWorker } from './native/usage-read-model-worker';
import { installMailboxWorker } from './native/mailbox-worker';
import { installMemoryWorker } from './native/memory-worker';
import { installCpuWorker } from './native/cpu-worker';
import { installNativeModuleHook } from './native/module-hook';
import { runNativeAssetSmokeIfRequested } from './native/smoke';

/**
 * Outcome of a CLI command run, reported back to the process entrypoint.
 *
 * `handleMainCommand` is a reusable, unit-tested handler — it must not terminate
 * the process itself. It reports here whether a headless (`kimi -p`) run
 * completed so the entrypoint (the only place that owns the process) can arm the
 * force-exit fallback.
 */
export interface MainCommandOutcome {
  readonly headlessCompleted: boolean;
}

export async function handleMainCommand(
  opts: CLIOptions,
  version: string,
): Promise<MainCommandOutcome> {
  let validated: ReturnType<typeof validateOptions>;
  startupTrace('main:enter');
  try {
    validated = validateOptions(opts);
    await assertMailboxStartupReady(resolveKikiHome());
    if (validated.uiMode === 'print') {
      await runPrompt(validated.options, version);
      return { headlessCompleted: true };
    }
  } catch (error) {
    if (error instanceof OptionConflictError || error instanceof PromptInputError) {
      process.stderr.write(`error${error instanceof PromptInputError && error.code ? ` [${error.code}]` : ''}: ${error.message}\n`);
      process.exit(error instanceof PromptInputError ? error.exitCode : 1);
    }
    throw error;
  }

  startupTrace('runShell:begin');
  await runShell(validated.options, version);
  return { headlessCompleted: false };
}

export function main(): void {
  process.title = PROCESS_NAME;
  const indexerArg = process.argv.findIndex((arg, index) => index > 0 && arg === '__search-indexer');
  if (indexerArg > 0) {
    const path = process.argv[indexerArg + 1];
    void runSqliteIndexerCommand(path ?? '').then(
      () => process.exit(0),
      (error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); },
    );
    return;
  }
  if (initializeNbSearchWorkerEntry()) return;
  bootstrap();
}

function bootstrap(): void {
  // Route all outbound fetch through HTTP_PROXY/HTTPS_PROXY (honoring NO_PROXY)
  // before any client is constructed. No-op when no proxy variable is set; an
  // invalid proxy URL is reported and ignored rather than aborting startup.
  installGlobalProxyDispatcher(process.env);
  installNativeModuleHook();
  const pluginHostRunner = getPluginHostRunnerFile();
  if (pluginHostRunner !== null) process.env['KIKI_PLUGIN_HOST_RUNNER'] = pluginHostRunner;
  const windowsProcessHelper = getWindowsProcessHelperFile();
  if (windowsProcessHelper !== null) process.env['KIKI_WINDOWS_PROCESS_HELPER'] = windowsProcessHelper;
  const historyEntry = getHistoryImportEntryFile();
  if (historyEntry !== null) process.env['KIKI_HISTORY_IMPORT_ENTRY'] = historyEntry;
  const sourceOwnedAdapterRoot = getSourceOwnedAdapterRoot();
  if (sourceOwnedAdapterRoot !== null) process.env[SOURCE_OWNED_ADAPTER_ROOT_ENV] = sourceOwnedAdapterRoot;
  else if (!isSea()) delete process.env[SOURCE_OWNED_ADAPTER_ROOT_ENV];
  // Best-effort SEA worker installation. Diagnostics are trace-only and avoid
  // exposing the user's cache path; failure keeps MiniDb's bounded inline mode.
  const workerInstall = installMinidbTextBuildWorker();
  startupTrace(
    workerInstall.status === 'installed'
      ? `minidb-worker:installed basename=${workerInstall.basename} sha256=${workerInstall.assetSha256}`
      : workerInstall.status === 'failed'
        ? `minidb-worker:failed code=${workerInstall.errorCode} sha256=${workerInstall.assetSha256 ?? 'unknown'}`
        : `minidb-worker:${workerInstall.status}`,
  );
  const usageWorkerInstall = installKapUsageWorker();
  startupTrace(usageWorkerInstall.status === 'failed'
    ? `usage-worker:failed code=${usageWorkerInstall.errorCode}`
    : `usage-worker:${usageWorkerInstall.status}`);
  const queryStoreWorkerInstall = installQueryStoreWorker();
  startupTrace(
    queryStoreWorkerInstall.status === 'installed'
      ? `query-store-worker:installed basename=${queryStoreWorkerInstall.basename} sha256=${queryStoreWorkerInstall.assetSha256}`
      : queryStoreWorkerInstall.status === 'failed'
        ? `query-store-worker:failed code=${queryStoreWorkerInstall.errorCode} sha256=${queryStoreWorkerInstall.assetSha256 ?? 'unknown'}`
        : `query-store-worker:${queryStoreWorkerInstall.status}`,
  );
  const usageReadModelWorkerInstall = installUsageReadModelWorker();
  startupTrace(
    usageReadModelWorkerInstall.status === 'installed'
      ? `usage-read-model-worker:installed basename=${usageReadModelWorkerInstall.basename} sha256=${usageReadModelWorkerInstall.assetSha256}`
      : usageReadModelWorkerInstall.status === 'failed'
        ? `usage-read-model-worker:failed code=${usageReadModelWorkerInstall.errorCode} sha256=${usageReadModelWorkerInstall.assetSha256 ?? 'unknown'}`
        : `usage-read-model-worker:${usageReadModelWorkerInstall.status}`,
  );
  const mailboxWorkerInstall = installMailboxWorker();
  startupTrace(
    mailboxWorkerInstall.status === 'installed'
      ? `mailbox-worker:installed basename=${mailboxWorkerInstall.basename} sha256=${mailboxWorkerInstall.assetSha256}`
      : mailboxWorkerInstall.status === 'failed'
        ? `mailbox-worker:failed code=${mailboxWorkerInstall.errorCode} sha256=${mailboxWorkerInstall.assetSha256 ?? 'unknown'}`
        : `mailbox-worker:${mailboxWorkerInstall.status}`,
  );
  const memoryWorkerInstall = installMemoryWorker();
  startupTrace(
    memoryWorkerInstall.status === 'installed'
      ? `memory-worker:installed basename=${memoryWorkerInstall.basename} sha256=${memoryWorkerInstall.assetSha256}`
      : memoryWorkerInstall.status === 'failed'
        ? `memory-worker:failed code=${memoryWorkerInstall.errorCode} sha256=${memoryWorkerInstall.assetSha256 ?? 'unknown'}`
        : `memory-worker:${memoryWorkerInstall.status}`,
  );
  const cpuWorkerInstall = installCpuWorker();
  startupTrace(
    cpuWorkerInstall.status === 'installed'
      ? `cpu-worker:installed basename=${cpuWorkerInstall.basename} sha256=${cpuWorkerInstall.assetSha256}`
      : cpuWorkerInstall.status === 'failed'
        ? `cpu-worker:failed code=${cpuWorkerInstall.errorCode} sha256=${cpuWorkerInstall.assetSha256 ?? 'unknown'}`
        : `cpu-worker:${cpuWorkerInstall.status}`,
  );
  if (isSea()) {
    const queryWorker = getKapSqliteQueryWorkerFile();
    if (queryWorker) process.env['KIKI_SQLITE_QUERY_WORKER_PATH'] = queryWorker;
    process.env['KIKI_SQLITE_INDEXER_SEA'] = '1';
  } else {
    delete process.env['KIKI_SQLITE_INDEXER_SEA'];
    const indexer = fileURLToPath(new URL('./sqlite-indexer.mjs', import.meta.url));
    const queryWorker = fileURLToPath(new URL('./sqlite-query-worker.mjs', import.meta.url));
    if (existsSync(indexer) && existsSync(queryWorker)) {
      process.env['KIKI_SQLITE_INDEXER_PATH'] = indexer;
      process.env['KIKI_SQLITE_QUERY_WORKER_PATH'] = queryWorker;
    }
  }
  const pricingInstall = installKapModelPricing();
  startupTrace(
    pricingInstall.status === 'installed'
      ? `model-pricing:installed basename=${pricingInstall.basename} sha256=${pricingInstall.assetSha256}`
      : pricingInstall.status === 'failed'
        ? `model-pricing:failed code=${pricingInstall.errorCode} sha256=${pricingInstall.assetSha256 ?? 'unknown'}`
        : `model-pricing:${pricingInstall.status}`,
  );
  if (runNativeAssetSmokeIfRequested()) return;

  // Start the background cleanup of stale native cache. Fire-and-forget; must not block startup or throw.
  queueMicrotask(() => {
    try {
      cleanupStaleNativeCacheForCurrent();
    } catch {
      // ignore: cache GC must never affect process startup
    }
  });

  const version = getVersion();

  const program = createProgram(
    version,
    (opts) => {
      void handleMainCommand(opts, version)
        .then(async (outcome) => {
          // Only the process entrypoint disposes of the process. Print mode
          // relies on the event loop draining to exit; flush any buffered output
          // and then arm an unref'd fallback so a stray ref'd handle left over
          // from the run can't wedge a completed `kimi -p` until an external
          // timeout. A healthy run drains and exits before the fallback fires.
          if (outcome.headlessCompleted) {
            await finalizeHeadlessRun(
              process,
              [process.stdout, process.stderr],
              () => Number(process.exitCode) || 0,
            );
          }
        })
        .catch(async (error: unknown) => {
          process.exitCode = 1;
          const operation = opts.prompt !== undefined || opts.promptFile !== undefined ? 'run prompt' : 'start shell';
          process.stderr.write(formatStartupError(error, { operation }));
          process.stderr.write(`See log: ${resolveGlobalLogPath(resolveKikiHome())}\n`);
          await logStartupFailure(operation, error);
          await drainStdio([process.stdout, process.stderr]);
          process.exit(1);
        });
    },
    (entry, args) => {
      void runPluginNodeEntry(entry, args).catch(async (error: unknown) => {
        await logStartupFailure('run plugin node entry', error);
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      });
    },
  );

  program.hook('preAction', (_root, command) => {
    const options = command.optsWithGlobals<{ home?: string }>();
    const docsInstall = installKikiDocs({ kikiHome: resolveKikiHome(options.home) });
    startupTrace(
      docsInstall.status === 'installed'
        ? `product-docs:installed source=${docsInstall.source} files=${docsInstall.fileCount} written=${docsInstall.writtenFiles} removed=${docsInstall.removedFiles} backed-up=${docsInstall.backedUpFiles} sha256=${docsInstall.contentSha256}`
        : docsInstall.status === 'failed'
          ? `product-docs:failed code=${docsInstall.errorCode}`
          : `product-docs:${docsInstall.status}`,
    );
  });

  void program.parseAsync(process.argv).catch((error: unknown) => {
    if (error instanceof CommanderError && error.exitCode === 0) {
      process.exitCode = 0;
      return;
    }
    const code = typeof error === 'object' && error !== null && 'exitCode' in error ? Number(error.exitCode) : 1;
    process.exitCode = Number.isInteger(code) && code > 0 ? code : 1;
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  });
}

main();

async function logStartupFailure(operation: string, error: unknown): Promise<void> {
  log.error('startup failed', { operation, error });
  try {
    await flushDiagnosticLogs();
  } catch {
    // Best-effort diagnostic flush only.
  }
}
