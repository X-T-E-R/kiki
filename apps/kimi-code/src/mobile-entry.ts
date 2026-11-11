import '@kiki/node-sdk/native-fs-watch-error-guard';
import { enableIndependentWorkerHeaps, removeInjectedHeapOption } from '@kiki/node-sdk/worker-heap-policy';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

export type MobileHostPlatform = 'android' | 'ios';

export interface MobileGatewayBootstrap {
  readonly url?: string;
  readonly secretToken?: string;
  readonly mcpUrl?: string;
  readonly mcpToken?: string;
}

export interface MobileBootstrapFrame {
  readonly v?: number;
  readonly type: 'bootstrap';
  readonly platform?: MobileHostPlatform;
  readonly homeDir?: string;
  readonly localOwnerToken?: string;
  readonly preferredPort?: number;
  readonly ipcSocketPath?: string;
  readonly memoryBudgetMb?: number;
  readonly gateway?: MobileGatewayBootstrap;
}

export type MobileControlFrame =
  | { readonly type: 'ping'; readonly seq?: number }
  | { readonly type: 'network'; readonly state: 'available' | 'lost' }
  | { readonly type: 'cancel_active_turns' }
  | { readonly type: 'shutdown'; readonly graceMs?: number };

export type AndroidGatewayBootstrap = MobileGatewayBootstrap;
export type AndroidBootstrapFrame = MobileBootstrapFrame;
export type AndroidControlFrame = MobileControlFrame;

export interface MobileMessagePortLike {
  postMessage(value: unknown): void;
  on?(event: 'message', listener: (value: unknown) => void): unknown;
  on?(event: 'close', listener: () => void): unknown;
  off?(event: 'message', listener: (value: unknown) => void): unknown;
  off?(event: 'close', listener: () => void): unknown;
  close?(): void;
}

export interface MobileControlChannel {
  readBootstrap(): Promise<MobileBootstrapFrame | undefined>;
  frames(): AsyncIterable<MobileControlFrame>;
  emit(payload: Record<string, unknown>): void;
  close?(): void | Promise<void>;
}

export interface StdioControlChannelOptions {
  readonly input?: Readable;
  readonly output?: Pick<Writable, 'write'>;
  readonly requireBootstrapFrame?: boolean;
}

export interface RunMobileHostOptions {
  readonly defaultPlatform?: MobileHostPlatform;
  readonly platform?: MobileHostPlatform;
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly bundleDir?: string;
  readonly controlChannel?: MobileControlChannel;
  readonly exitOnShutdown?: boolean;
  readonly registerSignalHandlers?: boolean;
}

export interface MobileHostHandle {
  readonly platform: MobileHostPlatform;
  readonly homeDir: string;
  readonly port: number;
  readonly serverId: string;
  readonly ipcSocketPath?: string;
  readonly closed: Promise<void>;
  shutdown(graceMs?: number): Promise<number>;
}

export function normalizeMobileHostPlatform(
  candidate: string | undefined,
  fallback: MobileHostPlatform = 'android',
): MobileHostPlatform {
  const lowered = candidate?.trim().toLowerCase();
  if (lowered === 'ios') return 'ios';
  if (lowered === 'android') return 'android';
  return fallback;
}

export function commandArguments(argv: readonly string[]): readonly string[] {
  const second = argv[1];
  const script =
    second !== undefined &&
    (second.includes('/') || second.includes('\\') || /\.(?:cjs|mjs|js|ts)$/.test(second));
  return argv.slice(script ? 2 : 1);
}

function parseIncomingObject(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return undefined;
}

function isControlFrame(record: Record<string, unknown>): record is MobileControlFrame {
  const type = record['type'];
  if (type === 'ping' || type === 'cancel_active_turns' || type === 'shutdown') return true;
  if (type === 'network') {
    return record['state'] === 'available' || record['state'] === 'lost';
  }
  return false;
}

export function createStdioControlChannel(options: StdioControlChannelOptions = {}): MobileControlChannel {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const requireBootstrap = options.requireBootstrapFrame === true;
  const rl = createInterface({ input, crlfDelay: Infinity });
  const lineIterator = rl[Symbol.asyncIterator]();

  return {
    async readBootstrap(): Promise<MobileBootstrapFrame | undefined> {
      if (!requireBootstrap) return undefined;
      const first = await lineIterator.next();
      if (first.done || first.value.trim().length === 0) {
        throw new Error('Expected mobile bootstrap JSON line on stdin');
      }
      const parsed = JSON.parse(first.value) as MobileBootstrapFrame;
      if (parsed.type !== 'bootstrap') {
        throw new Error(`Expected first stdin frame type "bootstrap", got "${String((parsed as { type?: unknown }).type)}"`);
      }
      return parsed;
    },
    async *frames(): AsyncIterable<MobileControlFrame> {
      for await (const rawLine of lineIterator) {
        const trimmed = rawLine.trim();
        if (trimmed.length === 0) continue;
        let record: Record<string, unknown> | undefined;
        try {
          record = parseIncomingObject(trimmed);
        } catch {
          continue;
        }
        if (record !== undefined && isControlFrame(record)) {
          yield record;
        }
      }
    },
    emit(payload: Record<string, unknown>): void {
      output.write(`@@kiki ${JSON.stringify(payload)}\n`);
    },
    close(): void {
      rl.close();
    },
  };
}

export function createMessagePortControlChannel(
  port: MobileMessagePortLike,
  options: { readonly initialBootstrap?: MobileBootstrapFrame; readonly requireBootstrapFrame?: boolean } = {},
): MobileControlChannel {
  const queue: unknown[] = [];
  let closed = false;
  let notify: (() => void) | undefined;

  const wake = (): void => {
    const waiter = notify;
    notify = undefined;
    waiter?.();
  };

  const onMessage = (value: unknown): void => {
    if (closed) return;
    queue.push(value);
    wake();
  };

  const eventTarget = port as unknown as {
    addEventListener?(type: string, listener: (event: unknown) => void): void;
    removeEventListener?(type: string, listener: (event: unknown) => void): void;
  };
  const onEventMessage = (event: unknown): void => {
    const payload =
      event !== null && typeof event === 'object' && 'data' in event
        ? (event as { readonly data?: unknown }).data
        : event;
    onMessage(payload);
  };

  const onClose = (): void => {
    if (closed) return;
    closed = true;
    wake();
  };

  if (typeof port.on === 'function') {
    port.on('message', onMessage);
    port.on('close', onClose);
  } else if (typeof eventTarget.addEventListener === 'function') {
    eventTarget.addEventListener('message', onEventMessage);
  }

  const nextRaw = async (): Promise<{ readonly done: true } | { readonly done: false; readonly value: unknown }> => {
    while (queue.length === 0) {
      if (closed) return { done: true };
      await new Promise<void>((resolveWait) => {
        notify = resolveWait;
      });
    }
    return { done: false, value: queue.shift() };
  };

  let bootstrapConsumed = false;

  return {
    async readBootstrap(): Promise<MobileBootstrapFrame | undefined> {
      if (bootstrapConsumed) return undefined;
      bootstrapConsumed = true;
      if (options.initialBootstrap !== undefined) {
        return options.initialBootstrap;
      }
      if (options.requireBootstrapFrame !== true && queue.length === 0) {
        return undefined;
      }
      const first = await nextRaw();
      if (first.done) {
        if (options.requireBootstrapFrame === true) {
          throw new Error('Expected mobile bootstrap frame on MessagePort before close');
        }
        return undefined;
      }
      const record = parseIncomingObject(first.value);
      if (record?.['type'] === 'bootstrap') {
        return record as unknown as MobileBootstrapFrame;
      }
      if (options.requireBootstrapFrame === true) {
        throw new Error(`Expected first MessagePort frame type "bootstrap", got "${String(record?.['type'])}"`);
      }
      queue.unshift(first.value);
      return undefined;
    },
    async *frames(): AsyncIterable<MobileControlFrame> {
      while (true) {
        const item = await nextRaw();
        if (item.done) return;
        let record: Record<string, unknown> | undefined;
        try {
          record = parseIncomingObject(item.value);
        } catch {
          continue;
        }
        if (record !== undefined && isControlFrame(record)) {
          yield record;
        }
      }
    },
    emit(payload: Record<string, unknown>): void {
      if (closed) return;
      port.postMessage(payload);
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (typeof port.off === 'function') {
        port.off('message', onMessage);
        port.off('close', onClose);
      } else if (typeof eventTarget.removeEventListener === 'function') {
        eventTarget.removeEventListener('message', onEventMessage);
      }
      wake();
    },
  };
}

function writeAtomicUtf8(targetPath: string, content: string, mode = 0o600): void {
  const parent = dirname(targetPath);
  mkdirSync(parent, { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, content, { encoding: 'utf8', mode });
  renameSync(tempPath, targetPath);
}

export function ensureManagedMobileMcp(
  homeDir: string,
  platform: MobileHostPlatform,
  mcpUrl: string,
  mcpToken: string,
): void {
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
  const serverName = platform === 'ios' ? 'ios-phone' : 'android-phone';
  existingServers[serverName] = {
    transport: 'http',
    url: mcpUrl,
    headers: {
      Authorization: `Bearer ${mcpToken}`,
    },
  };
  root['mcpServers'] = existingServers;
  writeAtomicUtf8(mcpPath, `${JSON.stringify(root, null, 2)}\n`, 0o600);
}

export function ensureManagedAndroidMcp(homeDir: string, mcpUrl: string, mcpToken: string): void {
  ensureManagedMobileMcp(homeDir, 'android', mcpUrl, mcpToken);
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

const DEFAULT_IOS_OPERATOR_PROFILE = `---
name: ios-operator
description: Operate iOS system capabilities and Shortcuts safely through ios-phone MCP tools
whenToUse: Automating iOS system actions, clipboard/media bridges, or paired remote spaces
system_prompt_mode: append
---

## iOS device operation

- Use \`ios-phone\` MCP tools for native iOS actions and paired Space or SSH hosts for external shell workloads; the iOS app sandbox does not spawn local subprocesses.
- Ask for explicit user confirmation before payments, outbound messages to real contacts, account changes, or permission-sensitive shortcuts.
`;

export function ensureDefaultMobileOperatorProfile(homeDir: string, platform: MobileHostPlatform): void {
  const fileName = platform === 'ios' ? 'ios-operator.md' : 'android-operator.md';
  const profilePath = join(homeDir, 'agents', fileName);
  if (existsSync(profilePath)) return;
  const content = platform === 'ios' ? DEFAULT_IOS_OPERATOR_PROFILE : DEFAULT_ANDROID_OPERATOR_PROFILE;
  writeAtomicUtf8(profilePath, content, 0o644);
}

export function ensureDefaultAndroidOperatorProfile(homeDir: string): void {
  ensureDefaultMobileOperatorProfile(homeDir, 'android');
}

export function configureBundledMobileAssets(
  bundleDir: string,
  platform: MobileHostPlatform,
  env: NodeJS.ProcessEnv = process.env,
): void {
  env['KIKI_PLATFORM'] = platform;
  env['KIKI_RUNTIME_PROFILE'] ??= 'mobile';
  env['KIKI_PTY'] ??= 'off';

  const hostRunner = join(bundleDir, 'hostRunner.mjs');
  if (platform !== 'ios' && existsSync(hostRunner)) env['KIKI_PLUGIN_HOST_RUNNER'] ??= hostRunner;

  const historyEntry = join(bundleDir, 'builtin', 'entry.mjs');
  if (existsSync(historyEntry)) env['KIKI_HISTORY_IMPORT_ENTRY'] ??= historyEntry;

  const externalHarness = join(bundleDir, 'external-harness');
  if (existsSync(externalHarness)) env['KIKI_SOURCE_OWNED_ADAPTER_ROOT'] ??= externalHarness;

  const sqliteIndexer = join(bundleDir, 'sqlite-indexer.mjs');
  const sqliteQuery = join(bundleDir, 'sqlite-query-worker.mjs');
  if (existsSync(sqliteIndexer) && existsSync(sqliteQuery)) {
    delete env['KIKI_SQLITE_INDEXER_SEA'];
    env['KIKI_SQLITE_INDEXER_PATH'] ??= sqliteIndexer;
    env['KIKI_SQLITE_QUERY_WORKER_PATH'] ??= sqliteQuery;
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

function resolveDefaultControlChannel(args: readonly string[], env: NodeJS.ProcessEnv): MobileControlChannel {
  const workerPayload =
    !isMainThread && workerData !== null && typeof workerData === 'object'
      ? (workerData as Record<string, unknown>)
      : undefined;
  const workerControlPort =
    (workerPayload?.['controlPort'] as MobileMessagePortLike | undefined) ??
    (!isMainThread && parentPort !== null && (workerPayload?.['kikiMobileHost'] === true || env['KIKI_MOBILE_TRANSPORT'] === 'message-port')
      ? parentPort
      : undefined);

  if (workerControlPort !== undefined) {
    const initialBootstrap =
      workerPayload?.['kikiBootstrap'] !== null &&
      typeof workerPayload?.['kikiBootstrap'] === 'object' &&
      !Array.isArray(workerPayload['kikiBootstrap'])
        ? (workerPayload['kikiBootstrap'] as MobileBootstrapFrame)
        : undefined;
    const requireBootstrapFrame =
      initialBootstrap === undefined &&
      (env['KIKI_MOBILE_BOOTSTRAP_PORT'] === '1' || args.includes('--bootstrap-port'));
    return createMessagePortControlChannel(workerControlPort, {
      initialBootstrap,
      requireBootstrapFrame,
    });
  }

  const useBootstrapStdin =
    env['KIKI_MOBILE_BOOTSTRAP_STDIN'] === '1' ||
    env['KIKI_ANDROID_BOOTSTRAP_STDIN'] === '1' ||
    args.includes('--bootstrap-stdin');
  return createStdioControlChannel({ requireBootstrapFrame: useBootstrapStdin });
}

let workerHeapsInitialized = false;
function ensureWorkerHeapsPolicy(env: NodeJS.ProcessEnv): void {
  removeInjectedHeapOption(env);
  if (!workerHeapsInitialized && isMainThread) {
    workerHeapsInitialized = true;
    enableIndependentWorkerHeaps();
  }
}

export async function startMobileHost(options: RunMobileHostOptions = {}): Promise<MobileHostHandle> {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv;
  ensureWorkerHeapsPolicy(env);

  const {
    NB_SEARCH_WORKER_COMMAND,
    installGlobalProxyDispatcher,
    installNbSearchWorkerHost,
    resolveKikiHome,
    runNbSearchWorkerCommand,
  } = await import('@kiki/node-sdk');

  const args = commandArguments(argv);
  if (args[0] === NB_SEARCH_WORKER_COMMAND) {
    await runNbSearchWorkerCommand(args);
    if (options.exitOnShutdown ?? isMainThread) {
      process.exit(0);
    }
    return {
      platform: normalizeMobileHostPlatform(options.platform ?? env['KIKI_PLATFORM'], options.defaultPlatform ?? 'android'),
      homeDir: '',
      port: 0,
      serverId: '',
      closed: Promise.resolve(),
      shutdown: async () => 0,
    };
  }

  const entryFile = fileURLToPath(import.meta.url);
  const bundleDir = options.bundleDir ?? dirname(entryFile);
  const channel = options.controlChannel ?? resolveDefaultControlChannel(args, env);
  const bootstrap = await channel.readBootstrap();

  const platform = normalizeMobileHostPlatform(
    options.platform ?? bootstrap?.platform ?? env['KIKI_PLATFORM'],
    options.defaultPlatform ?? 'android',
  );

  if (bootstrap?.memoryBudgetMb !== undefined && Number.isFinite(bootstrap.memoryBudgetMb) && bootstrap.memoryBudgetMb >= 64) {
    env['KIKI_MOBILE_MEMORY_BUDGET_MB'] = String(Math.floor(bootstrap.memoryBudgetMb));
  }

  if (platform !== 'ios') {
    installNbSearchWorkerHost({
      executable: process.execPath,
      entryArgs: [...process.execArgv, entryFile],
    });
  }
  installGlobalProxyDispatcher(env);
  configureBundledMobileAssets(bundleDir, platform, env);
  await configureWorkerRuntimes(bundleDir);

  const rawHome = bootstrap?.homeDir ?? env['KIKI_HOME'];
  if (rawHome !== undefined && rawHome.trim().length > 0) {
    env['KIKI_HOME'] = resolve(rawHome.trim());
  }
  const homeDir = resolveKikiHome(env['KIKI_HOME']);
  mkdirSync(homeDir, { recursive: true });

  const secretBrokerUrl = bootstrap?.gateway?.url ?? env['KIKI_SECRET_BROKER_URL'];
  const secretBrokerToken = bootstrap?.gateway?.secretToken ?? env['KIKI_SECRET_BROKER_TOKEN'];
  if (secretBrokerUrl && secretBrokerToken) {
    const existingBackend = env['KIKI_SECRET_BACKEND']?.trim();
    env['KIKI_SECRET_BACKEND'] =
      existingBackend === 'android-broker' || existingBackend === 'mobile-broker'
        ? existingBackend
        : platform === 'android'
          ? 'android-broker'
          : 'mobile-broker';
    env['KIKI_SECRET_BROKER_URL'] = secretBrokerUrl;
    env['KIKI_SECRET_BROKER_TOKEN'] = secretBrokerToken;
  }

  const mcpUrl =
    bootstrap?.gateway?.mcpUrl ??
    env['KIKI_MOBILE_MCP_URL'] ??
    env['KIKI_ANDROID_MCP_URL'] ??
    env['KIKI_IOS_MCP_URL'];
  const mcpToken =
    bootstrap?.gateway?.mcpToken ??
    env['KIKI_MOBILE_MCP_TOKEN'] ??
    env['KIKI_ANDROID_MCP_TOKEN'] ??
    env['KIKI_IOS_MCP_TOKEN'];
  if (mcpUrl && mcpToken) {
    ensureManagedMobileMcp(homeDir, platform, mcpUrl, mcpToken);
  }
  ensureDefaultMobileOperatorProfile(homeDir, platform);

  const docsDir = join(bundleDir, 'docs');
  if (existsSync(join(docsDir, 'en', 'index.md'))) {
    const { installKikiDocs } = await import('./native/product-docs');
    installKikiDocs({ kikiHome: homeDir, docsSourceDir: docsDir, packageRoot: bundleDir, runtimeDir: bundleDir });
  }

  const ownerToken = (
    bootstrap?.localOwnerToken ??
    env['KIKI_SERVER_AUTH_TOKEN'] ??
    env['KIKI_LOCAL_OWNER_TOKEN'] ??
    ''
  ).trim();
  if (ownerToken.length === 0) {
    throw new Error(`${platform === 'ios' ? 'iOS' : 'Android'} host requires localOwnerToken via bootstrap frame or KIKI_SERVER_AUTH_TOKEN`);
  }

  const envPort = env['KIKI_PORT'] ? Number.parseInt(env['KIKI_PORT'], 10) : undefined;
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
      env,
      localOwnerToken: ownerToken,
      authTokenService,
      serverVersion: version,
      hostIdentity: {
        productName: platform === 'ios' ? 'kiki-ios' : 'kiki-android',
        version,
        platform: `${platform}-${process.arch}`,
      },
      webAssetsDir,
    });

  const server = await startOnPort(preferredPort ?? 0).catch(async (error: unknown) => {
    if ((preferredPort ?? 0) !== 0) {
      return startOnPort(0);
    }
    throw error;
  });

  const rawIpcSocket = (bootstrap?.ipcSocketPath ?? env['KIKI_MOBILE_IPC_SOCKET'] ?? '').trim();
  let ipcHost: { readonly socketPath: string; close(): Promise<void> } | undefined;
  if (rawIpcSocket.length > 0) {
    const { serveKlientIpc } = await import('@kiki/klient/ipc');
    ipcHost = await serveKlientIpc({
      scope: server.core,
      socketPath: rawIpcSocket,
      token: ownerToken,
    });
  }

  diagnostics.record('ready', { serverId: server.serverId, port: server.port });
  channel.emit({
    type: 'ready',
    platform,
    port: server.port,
    pid: process.pid,
    version,
    serverId: server.serverId,
    guiPath: '/',
    ipcSocketPath: ipcHost?.socketPath,
  });

  const unsubscribeTurns = server.subscribeTurnSummary((summary) => {
    channel.emit({
      type: 'turns',
      active: summary.active > 0 ? 1 : 0,
      busySessions: summary.active,
      executing: summary.executing,
      pendingInteraction: summary.pendingInteraction,
    });
  });

  const exitOnShutdown = options.exitOnShutdown ?? (isMainThread && options.controlChannel === undefined);
  const registerSignals = options.registerSignalHandlers ?? (isMainThread && options.controlChannel === undefined);

  let shutdownPromise: Promise<number> | undefined;
  const onSigInt = (): void => { void initiateShutdown(); };
  const onSigTerm = (): void => { void initiateShutdown(); };

  if (registerSignals) {
    process.once('SIGINT', onSigInt);
    process.once('SIGTERM', onSigTerm);
  }

  const initiateShutdown = (graceMs = 5_000): Promise<number> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    shutdownPromise = (async (): Promise<number> => {
      if (registerSignals) {
        process.off('SIGINT', onSigInt);
        process.off('SIGTERM', onSigTerm);
      }
      unsubscribeTurns();
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      if (exitOnShutdown) {
        forceTimer = setTimeout(() => {
          process.exit(0);
        }, Math.max(500, graceMs));
        forceTimer.unref();
      }
      let exitCode = 0;
      try {
        if (ipcHost !== undefined) {
          await ipcHost.close().catch(() => undefined);
        }
        await server.close();
        const receipt = await server.exitReceipt;
        diagnostics.record('closed', { ...receipt });
        if (receipt.callerOutcome !== 'resolved' || receipt.cleanupOutcome !== 'closed') {
          exitCode = 1;
        }
      } catch (error) {
        exitCode = 1;
        diagnostics.record('close_failed', { error: error instanceof Error ? error.message : String(error) });
      } finally {
        if (forceTimer !== undefined) clearTimeout(forceTimer);
        await channel.close?.();
      }
      if (exitOnShutdown) {
        process.exit(exitCode);
      }
      return exitCode;
    })();
    return shutdownPromise;
  };

  void (async () => {
    for await (const frame of channel.frames()) {
      if (frame.type === 'ping') {
        channel.emit({ type: 'pong', seq: frame.seq });
      } else if (frame.type === 'network' && (frame.state === 'available' || frame.state === 'lost')) {
        server.notifyNetworkChange(frame.state);
      } else if (frame.type === 'cancel_active_turns') {
        const cancelled = server.cancelActiveTurns();
        channel.emit({ type: 'turns_cancelled', cancelled });
      } else if (frame.type === 'shutdown') {
        await initiateShutdown(frame.graceMs);
        return;
      }
    }
  })();

  return {
    platform,
    homeDir,
    port: server.port,
    serverId: server.serverId,
    ipcSocketPath: ipcHost?.socketPath,
    closed: server.closed,
    shutdown: initiateShutdown,
  };
}

export async function runMobileHost(options: RunMobileHostOptions = {}): Promise<void> {
  const handle = await startMobileHost(options);
  await handle.closed;
}

export async function runAndroidHost(options: Omit<RunMobileHostOptions, 'defaultPlatform'> = {}): Promise<void> {
  await runMobileHost({ ...options, defaultPlatform: 'android' });
}

let cliEntryDispatched = false;
export function dispatchMobileCliEntry(defaultPlatform: MobileHostPlatform = 'android'): void {
  if (cliEntryDispatched) return;
  cliEntryDispatched = true;
  ensureWorkerHeapsPolicy(process.env);
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
    return;
  }
  if (commandArguments(process.argv)[0] === '__plugin_run_node') {
    void import('./android-plugin-runner').catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
    return;
  }
  void runMobileHost({ defaultPlatform }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}

function isDirectEntryExecution(metaUrl: string): boolean {
  try {
    const selfPath = resolve(fileURLToPath(metaUrl));
    const argv1 = process.argv[1];
    if (argv1 !== undefined && resolve(argv1) === selfPath) return true;
    const workerPayload =
      !isMainThread && workerData !== null && typeof workerData === 'object'
        ? (workerData as Record<string, unknown>)
        : undefined;
    return workerPayload?.['kikiMobileAutoStart'] === true;
  } catch {
    return false;
  }
}

if (isDirectEntryExecution(import.meta.url)) {
  dispatchMobileCliEntry(normalizeMobileHostPlatform(process.env['KIKI_PLATFORM'], 'android'));
}
