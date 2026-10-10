import { createHash } from 'node:crypto';
import { join } from 'pathe';

import { createDecorator } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { LifecycleScope } from '#/app/scopes';
import { installedBrowserDriver, installedBrowserChrome } from '#/app/capability/entries/browserResourceStore';
import { StdioMcpClient } from '#/mcpCore/client-stdio';
import type { MCPClient } from '#/mcpCore/types';
import type { Runtime } from '#/runtime/runtime';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IRuntimeResolver, IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';

import type { BrowserResolvedConnection } from './browserConfig';
import { BrowserError } from './errors';
import { openCodexBrowser, type CodexBrowserBackend } from './codexBrowser';

export const AGENT_BROWSER_VERSION = '0.38.2';
export interface BrowserBackend {
  readonly client: MCPClient;
  readonly runtime: Runtime;
  readonly session: string;
  readonly namespace: string;
  readonly version: string;
  readonly profilePath?: string;
  readonly official?: CodexBrowserBackend;
  close(): Promise<void>;
}
export interface IBrowserBackendFactory {
  readonly _serviceBrand: undefined;
  open(connection: BrowserResolvedConnection): Promise<BrowserBackend>;
}
export const IBrowserBackendFactory = createDecorator<IBrowserBackendFactory>('browserBackendFactory');

export function browserRuntimeResolver(resolver: IRuntimeResolver, env: Record<string, string>): IRuntimeResolver {
  return { _serviceBrand: undefined, inspect: (binding) => resolver.inspect(binding), acquire: (binding, required) => {
    const lease = resolver.acquire(binding, required);
    const processService = lease.runtime.process;
    if (processService === undefined) { lease.dispose(); throw new BrowserError('browser.execution_failed', 'Browser runtime has no process service'); }
    const runtime: Runtime = Object.assign(Object.create(lease.runtime) as Runtime, { process: {
      ...processService, spawn: (command: string, args: readonly string[], options: Parameters<typeof processService.spawn>[2]) => {
        const unset = Object.keys(options?.env ?? {}).filter((key) => key.startsWith('AGENT_BROWSER_') && !(key in env));
        return processService.spawn(command, args, { ...options, env: { ...options?.env, ...env }, envUnset: [...options?.envUnset ?? [], ...unset] });
      },
    } });
    return { runtime, track: (resource) => lease.track(resource), dispose: () => lease.dispose() };
  } };
}

export class BrowserBackendFactory implements IBrowserBackendFactory {
  declare readonly _serviceBrand: undefined;
  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IWorkspaceInstanceManager private readonly workspaces: IWorkspaceInstanceManager,
    @IRuntimeResolver private readonly runtimes: IRuntimeResolver,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
  ) {}

  async open(connection: BrowserResolvedConnection): Promise<BrowserBackend> {
    const workspace = await this.workspaces.acquire({ root: this.bootstrap.cwd });
    let client: StdioMcpClient | undefined;
    try {
      const runtime = workspace.instance.runtimes.current('local');
      if (runtime === undefined || runtime.process === undefined) throw new BrowserError('browser.execution_failed', 'The Kiki service host has no local process runtime');
      if (connection.type === 'codex-extension') {
        const backend = await openCodexBrowser({ runtimeRoot: connection.runtimeRoot, browserId: connection.browserId,
          cwd: this.bootstrap.cwd, runtime, resolver: this.runtimes });
        return { ...backend, close: async () => { try { await backend.close(); } finally { workspace.dispose(); } } };
      }
      const command = connection.driverPath ?? this.bootstrap.args.browserDriverPath ?? await installedBrowserDriver(this.bootstrap.homeDir);
      if (command === undefined) throw new BrowserError('browser.version', 'Browser components are not prepared on this Kiki service host. Open Settings > Browser control and choose Install components, then check this connection again.');
      const check = await runtime.process.spawn(command, ['--version'], { shell: false, windowsHide: true, timeout: 10_000 });
      let output = '';
      check.stdout.on('data', (chunk: Buffer) => { if (output.length < 4096) output += chunk.toString(); });
      check.stderr.resume();
      const exit = await check.wait();
      await check.dispose();
      const version = /\b(\d+\.\d+\.\d+)\b/.exec(output)?.[1];
      if (exit !== 0 || version !== AGENT_BROWSER_VERSION || !output.includes('kiki-no-replay-r1') || !output.includes('kiki-stdio-r1')) {
        throw new BrowserError('browser.version', `Expected the managed agent-browser ${AGENT_BROWSER_VERSION} kiki-no-replay-r1 kiki-stdio-r1 build; detected ${version ?? 'no compatible executable'}. This build prevents automatic replay and Windows MCP output hangs.`);
      }
      const namespace = `kiki-${createHash('sha256').update(this.bootstrap.homeDir).digest('hex').slice(0, 20)}`;
      const session = `browser-${createHash('sha256').update(connection.id).digest('hex').slice(0, 24)}`;
      const profilePath = connection.type === 'agent-browser-profile'
        ? connection.profilePath ?? join(this.bootstrap.homeDir, 'browser', 'profiles', connection.id) : undefined;
      await this.documents.set('browser', 'agent-browser-config.json', {});
      const configPath = this.storage.pathFor('browser', 'agent-browser-config.json');
      if (configPath === undefined) throw new BrowserError('browser.execution_failed', 'Browser driver configuration requires a file-backed document store');
      const env: Record<string, string> = { AGENT_BROWSER_CONFIG: configPath, AGENT_BROWSER_NAMESPACE: namespace,
        AGENT_BROWSER_SESSION: session, AGENT_BROWSER_PIN_TAB: '1', AGENT_BROWSER_SOCKET_DIR: join(this.bootstrap.homeDir, 'browser', 'run') };
      if (profilePath !== undefined) env['AGENT_BROWSER_PROFILE'] = profilePath;
      if (connection.type === 'agent-browser-cdp') env['AGENT_BROWSER_CDP'] = connection.endpointSecret;
      if (connection.type === 'agent-browser-profile') {
        const executable = connection.executablePath ?? (await installedBrowserChrome(this.bootstrap.homeDir))?.executable;
        if (executable !== undefined) env['AGENT_BROWSER_EXECUTABLE_PATH'] = executable;
      }
      if (connection.type === 'agent-browser-profile' && connection.headed === true) env['AGENT_BROWSER_HEADED'] = '1';
      client = new StdioMcpClient({ transport: 'stdio', command, args: ['mcp', '--tools', 'all'], executor: 'local', env },
      { runtimeResolver: browserRuntimeResolver(this.runtimes, env), workspaceId: runtime.identity.workspaceId, runtimeId: 'local',
        defaultCwd: this.bootstrap.cwd, startupTimeoutMs: 15_000, toolCallTimeoutMs: 150_000, computerControl: false });
      await client.connect();
      const activeClient = client;
      return { client, runtime, session, namespace, version, profilePath,
        close: async () => { try { await activeClient.close(); } finally { workspace.dispose(); } } };
    } catch (error) {
      await client?.close();
      workspace.dispose();
      throw error;
    }
  }
}

registerScopedService(LifecycleScope.App, IBrowserBackendFactory, BrowserBackendFactory, ScopeActivation.OnDemand, 'browser');
