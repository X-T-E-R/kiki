import '@kiki/node-sdk/native-fs-watch-error-guard';
import { enableIndependentWorkerHeaps, removeInjectedHeapOption } from '@kiki/node-sdk/worker-heap-policy';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

removeInjectedHeapOption(process.env);
enableIndependentWorkerHeaps();

function commandArguments(argv: readonly string[]): readonly string[] {
  const second = argv[1];
  const script =
    second !== undefined &&
    (second.includes('/') || second.includes('\\') || /\.(?:cjs|mjs|js|ts)$/.test(second));
  return argv.slice(script ? 2 : 1);
}

const indexerArg = process.argv.findIndex((arg, index) => index > 0 && arg === '__search-indexer');
if (indexerArg > 0) {
  void import('@kiki/kap-server/sqlite-indexer-runtime')
    .then(({ runSqliteIndexerCommand }) => runSqliteIndexerCommand(process.argv[indexerArg + 1] ?? ''))
    .then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      },
    );
} else if (commandArguments(process.argv)[0] === '__plugin_run_node') {
  void import('./android-plugin-runner').catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
} else {
  void runAndroidHost().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}

interface AndroidGatewayBootstrap {
  readonly url?: string;
  readonly secretToken?: string;
  readonly mcpUrl?: string;
  readonly mcpToken?: string;
}

interface AndroidBootstrapFrame {
  readonly v?: number;
  readonly type: 'bootstrap';
  readonly homeDir?: string;
  readonly localOwnerToken?: string;
  readonly preferredPort?: number;
  readonly gateway?: AndroidGatewayBootstrap;
}

type AndroidControlFrame =
  | { readonly type: 'ping'; readonly seq?: number }
  | { readonly type: 'network'; readonly state: 'available' | 'lost' }
  | { readonly type: 'cancel_active_turns' }
  | { readonly type: 'shutdown'; readonly graceMs?: number };

function emitFrame(payload: Record<string, unknown>): void {
  process.stdout.write(`@@kiki ${JSON.stringify(payload)}\n`);
}

function writeAtomicUtf8(targetPath: string, content: string, mode = 0o600): void {
  const parent = dirname(targetPath);
  mkdirSync(parent, { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, content, { encoding: 'utf8', mode });
  renameSync(tempPath, targetPath);
}

function ensureManagedAndroidMcp(homeDir: string, mcpUrl: string, mcpToken: string): void {
  const mcpPath = join(homeDir, 'mcp.json');
  let root: Record<string, unknown> = {};
  if (existsSync(mcpPath)) {
    try {
      const parsed = JSON.parse(readFileSync(mcpPath, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        root = { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      root = {};
    }
  }
  const existingServers =
    root['mcpServers'] && typeof root['mcpServers'] === 'object' && !Array.isArray(root['mcpServers'])
      ? { ...(root['mcpServers'] as Record<string, unknown>) }
      : {};
  existingServers['android-phone'] = {
    transport: 'http',
    url: mcpUrl,
    headers: {
      Authorization: `Bearer ${mcpToken}`,
    },
  };
  root['mcpServers'] = existingServers;
  writeAtomicUtf8(mcpPath, `${JSON.stringify(root, null, 2)}\n`, 0o600);
}

const DEFAULT_ANDROID_OPERATOR_PROFILE = `---
name: android-operator
description: Operate Android apps and phone capabilities safely through android-phone MCP tools
whenToUse: Automating on-device apps, reading screen hierarchy, or performing phone actions
system_prompt_mode: append
---

## Android device operation

- Prefer structured \`android-phone\` accessibility inspection tools before coordinate taps, and verify the foreground package before acting.
- Ask for explicit user confirmation before payments, transfers, outbound messages to real contacts, account deletions, or system security changes.
- Do not tap or close Kiki's own Activity window unless the user explicitly asks to inspect Kiki itself.
`;

function ensureDefaultAndroidOperatorProfile(homeDir: string): void {
  const profilePath = join(homeDir, 'agents', 'android-operator.md');
  if (existsSync(profilePath)) return;
  writeAtomicUtf8(profilePath, DEFAULT_ANDROID_OPERATOR_PROFILE, 0o644);
}

function configureBundledAssets(bundleDir: string): void {
  process.env['KIKI_PLATFORM'] ??= 'android';
  process.env['KIKI_RUNTIME_PROFILE'] ??= 'mobile';
  process.env['KIKI_PTY'] ??= 'off';

  const hostRunner = join(bundleDir, 'hostRunner.mjs');
  if (existsSync(hostRunner)) process.env['KIKI_PLUGIN_HOST_RUNNER'] ??= hostRunner;

  const historyEntry = join(bundleDir, 'builtin', 'entry.mjs');
  if (existsSync(historyEntry)) process.env['KIKI_HISTORY_IMPORT_ENTRY'] ??= historyEntry;

  const externalHarness = join(bundleDir, 'external-harness');
  if (existsSync(externalHarness)) process.env['KIKI_SOURCE_OWNED_ADAPTER_ROOT'] ??= externalHarness;

  const sqliteIndexer = join(bundleDir, 'sqlite-indexer.mjs');
  const sqliteQuery = join(bundleDir, 'sqlite-query-worker.mjs');
  if (existsSync(sqliteIndexer) && existsSync(sqliteQuery)) {
    delete process.env['KIKI_SQLITE_INDEXER_SEA'];
    process.env['KIKI_SQLITE_INDEXER_PATH'] ??= sqliteIndexer;
    process.env['KIKI_SQLITE_QUERY_WORKER_PATH'] ??= sqliteQuery;
  }
}

async function configureWorkerRuntimes(bundleDir: string): Promise<void> {
  const [
    nodeSdk,
    minidbRuntime,
    usageWorkerRuntime,
    modelPricingRuntime,
  ] = await Promise.all([
    import('@kiki/node-sdk'),
    import('@kiki/minidb/worker-runtime'),
    import('@kiki/kap-server/usage-worker-runtime'),
    import('@kiki/kap-server/model-pricing-runtime'),
  ]);

  const queryStoreWorker = join(bundleDir, 'query-store-worker.mjs');
  if (existsSync(queryStoreWorker)) nodeSdk.configureQueryStoreWorkerRuntime(queryStoreWorker);

  const usageReadModelWorker = join(bundleDir, 'usage-read-model-worker.mjs');
  if (existsSync(usageReadModelWorker)) nodeSdk.configureUsageReadModelWorkerRuntime(usageReadModelWorker);

  const mailboxWorker = join(bundleDir, 'mailbox-worker.mjs');
  if (existsSync(mailboxWorker)) nodeSdk.configureMailboxWorkerRuntime(mailboxWorker);

  const memoryWorker = join(bundleDir, 'memory-worker.mjs');
  if (existsSync(memoryWorker)) nodeSdk.configureMemoryWorkerRuntime(memoryWorker);

  const cpuWorker = join(bundleDir, 'cpu-worker.mjs');
  if (existsSync(cpuWorker)) nodeSdk.configureCpuWorkerRuntime({ entry: cpuWorker });

  const textBuildWorker = join(bundleDir, 'text-build-worker.mjs');
  if (existsSync(textBuildWorker)) minidbRuntime.configureTextBuildWorkerRuntime(textBuildWorker);

  const usageParserWorker = join(bundleDir, 'usage-parser-worker.mjs');
  if (existsSync(usageParserWorker)) usageWorkerRuntime.configureUsageWorkerRuntime(usageParserWorker);

  const pricingJson = join(bundleDir, 'model_prices_and_context_window.json');
  if (existsSync(pricingJson)) modelPricingRuntime.configureModelPricingRuntime(pricingJson);
}

async function runAndroidHost(): Promise<void> {
  const {
    NB_SEARCH_WORKER_COMMAND,
    installGlobalProxyDispatcher,
    installNbSearchWorkerHost,
    resolveKikiHome,
    runNbSearchWorkerCommand,
  } = await import('@kiki/node-sdk');

  const args = commandArguments(process.argv);
  if (args[0] === NB_SEARCH_WORKER_COMMAND) {
    await runNbSearchWorkerCommand(args);
    process.exit(0);
    return;
  }

  const entryFile = fileURLToPath(import.meta.url);
  const bundleDir = dirname(entryFile);
  installNbSearchWorkerHost({
    executable: process.execPath,
    entryArgs: [...process.execArgv, entryFile],
  });
  installGlobalProxyDispatcher(process.env);
  configureBundledAssets(bundleDir);
  await configureWorkerRuntimes(bundleDir);

  const useBootstrapStdin =
    process.env['KIKI_ANDROID_BOOTSTRAP_STDIN'] === '1' || args.includes('--bootstrap-stdin');

  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  const lineIterator = rl[Symbol.asyncIterator]();

  let bootstrap: AndroidBootstrapFrame | undefined;
  if (useBootstrapStdin) {
    const first = await lineIterator.next();
    if (first.done || first.value.trim().length === 0) {
      throw new Error('Expected Android bootstrap JSON line on stdin');
    }
    const parsed = JSON.parse(first.value) as AndroidBootstrapFrame;
    if (parsed.type !== 'bootstrap') {
      throw new Error(`Expected first stdin frame type "bootstrap", got "${String((parsed as { type?: unknown }).type)}"`);
    }
    bootstrap = parsed;
  }

  const rawHome = bootstrap?.homeDir ?? process.env['KIKI_HOME'];
  if (rawHome !== undefined && rawHome.trim().length > 0) {
    process.env['KIKI_HOME'] = resolve(rawHome.trim());
  }
  const homeDir = resolveKikiHome(process.env['KIKI_HOME']);
  mkdirSync(homeDir, { recursive: true });

  const secretBrokerUrl = bootstrap?.gateway?.url ?? process.env['KIKI_SECRET_BROKER_URL'];
  const secretBrokerToken = bootstrap?.gateway?.secretToken ?? process.env['KIKI_SECRET_BROKER_TOKEN'];
  if (secretBrokerUrl && secretBrokerToken) {
    process.env['KIKI_SECRET_BACKEND'] = 'android-broker';
    process.env['KIKI_SECRET_BROKER_URL'] = secretBrokerUrl;
    process.env['KIKI_SECRET_BROKER_TOKEN'] = secretBrokerToken;
  }

  const mcpUrl = bootstrap?.gateway?.mcpUrl ?? process.env['KIKI_ANDROID_MCP_URL'];
  const mcpToken = bootstrap?.gateway?.mcpToken ?? process.env['KIKI_ANDROID_MCP_TOKEN'];
  if (mcpUrl && mcpToken) {
    ensureManagedAndroidMcp(homeDir, mcpUrl, mcpToken);
  }
  ensureDefaultAndroidOperatorProfile(homeDir);

  const docsDir = join(bundleDir, 'docs');
  if (existsSync(join(docsDir, 'en', 'index.md'))) {
    const { installKikiDocs } = await import('./native/product-docs');
    installKikiDocs({ kikiHome: homeDir, docsSourceDir: docsDir, packageRoot: bundleDir, runtimeDir: bundleDir });
  }

  const ownerToken = (
    bootstrap?.localOwnerToken ??
    process.env['KIKI_SERVER_AUTH_TOKEN'] ??
    process.env['KIKI_LOCAL_OWNER_TOKEN'] ??
    ''
  ).trim();
  if (ownerToken.length === 0) {
    throw new Error('Android host requires localOwnerToken via bootstrap stdin or KIKI_SERVER_AUTH_TOKEN');
  }

  const envPort = process.env['KIKI_PORT'] ? Number.parseInt(process.env['KIKI_PORT'], 10) : undefined;
  const preferredPort = bootstrap?.preferredPort ?? (Number.isInteger(envPort) && envPort! >= 0 ? envPort : 0);

  const [{ createInMemoryAuthTokenService, startServer }, { KIMI_BUILD_INFO }, { installServerDiagnostics }] =
    await Promise.all([
      import('@kiki/kap-server'),
      import('./cli/build-info'),
      import('./kiki/server-diagnostics'),
    ]);

  const version = KIMI_BUILD_INFO.version ?? '0.5.1';
  const webAssetsDir = existsSync(join(bundleDir, 'web', 'index.html')) ? join(bundleDir, 'web') : undefined;
  const diagnostics = installServerDiagnostics(homeDir);
  const authTokenService = createInMemoryAuthTokenService(ownerToken);

  const startOnPort = (port: number) =>
    startServer({
      host: '127.0.0.1',
      port,
      homeDir,
      localOwnerToken: ownerToken,
      authTokenService,
      serverVersion: version,
      hostIdentity: {
        productName: 'kiki-android',
        version,
        platform: `android-${process.arch}`,
      },
      webAssetsDir,
    });

  let server = await startOnPort(preferredPort ?? 0).catch(async (error: unknown) => {
    if ((preferredPort ?? 0) !== 0) {
      return startOnPort(0);
    }
    throw error;
  });

  diagnostics.record('ready', { serverId: server.serverId, port: server.port });
  emitFrame({
    type: 'ready',
    port: server.port,
    pid: process.pid,
    version,
    serverId: server.serverId,
    guiPath: '/',
  });

  const unsubscribeTurns = server.subscribeTurnSummary((summary) => {
    emitFrame({
      type: 'turns',
      active: summary.active > 0 ? 1 : 0,
      busySessions: summary.active,
      executing: summary.executing,
      pendingInteraction: summary.pendingInteraction,
    });
  });

  let shuttingDown = false;
  const initiateShutdown = async (graceMs = 5_000): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    unsubscribeTurns();
    const forceTimer = setTimeout(() => {
      process.exit(0);
    }, Math.max(500, graceMs));
    forceTimer.unref();
    let exitCode = 0;
    try {
      await server.close();
      const receipt = await server.exitReceipt;
      diagnostics.record('closed', { ...receipt });
      if (receipt.callerOutcome !== 'resolved' || receipt.cleanupOutcome !== 'closed') {
        exitCode = 1;
      }
    } catch (error) {
      exitCode = 1;
      diagnostics.record('close_failed', { error: error instanceof Error ? error.message : String(error) });
    }
    process.exit(exitCode);
  };

  process.once('SIGINT', () => { void initiateShutdown(); });
  process.once('SIGTERM', () => { void initiateShutdown(); });

  void (async () => {
    for await (const rawLine of lineIterator) {
      const trimmed = rawLine.trim();
      if (trimmed.length === 0) continue;
      let frame: AndroidControlFrame;
      try {
        frame = JSON.parse(trimmed) as AndroidControlFrame;
      } catch {
        continue;
      }
      if (frame.type === 'ping') {
        emitFrame({ type: 'pong', seq: frame.seq });
      } else if (frame.type === 'network' && (frame.state === 'available' || frame.state === 'lost')) {
        server.notifyNetworkChange(frame.state);
      } else if (frame.type === 'cancel_active_turns') {
        const cancelled = server.cancelActiveTurns();
        emitFrame({ type: 'turns_cancelled', cancelled });
      } else if (frame.type === 'shutdown') {
        await initiateShutdown(frame.graceMs);
        return;
      }
    }
  })();

  await server.closed;
}
