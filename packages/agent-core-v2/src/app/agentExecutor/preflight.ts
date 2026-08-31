import { join } from 'pathe';
import { coerce, gte } from 'semver';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService, type IHostProcess } from '#/os/interface/hostProcess';

import { IAgentExecutorRegistry } from './agentExecutor';
import { selectExecutorSource } from './binaryDiscovery';
import { BUILTIN_AGENT_EXECUTORS } from './builtinDescriptors';

export type AgentExecutorPreflightStatus = 'ready' | 'warning' | 'unavailable';
export type AgentExecutorPreflightSeverity = 'info' | 'warning' | 'error';

export interface AgentExecutorPreflightDiagnostic {
  readonly severity: AgentExecutorPreflightSeverity;
  readonly message: string;
}

export interface AgentExecutorPreflightResult {
  readonly id: string;
  readonly status: AgentExecutorPreflightStatus;
  readonly command: string;
  readonly version?: string;
  readonly selectedSource?: string;
  readonly sources?: readonly import('./agentExecutor').AgentExecutorSourceProbe[];
  readonly resolvedArgs: readonly string[];
  readonly diagnostics: readonly AgentExecutorPreflightDiagnostic[];
}

export interface IAgentExecutorPreflightService {
  readonly _serviceBrand: undefined;
  run(ids?: readonly string[]): Promise<readonly AgentExecutorPreflightResult[]>;
}

export const IAgentExecutorPreflightService: ServiceIdentifier<IAgentExecutorPreflightService> =
  createDecorator<IAgentExecutorPreflightService>('agentExecutorPreflightService');

interface CommandProbe {
  readonly available: boolean;
  readonly code?: number;
  readonly output: string;
}

export class AgentExecutorPreflightService implements IAgentExecutorPreflightService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IHostProcessService private readonly processService: IHostProcessService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IAgentExecutorRegistry private readonly registry: IAgentExecutorRegistry,
  ) {}

  async run(ids: readonly string[] = Object.keys(BUILTIN_AGENT_EXECUTORS)): Promise<readonly AgentExecutorPreflightResult[]> {
    return Promise.all(ids.map((id) => this.#runOne(id)));
  }

  async #runOne(id: string): Promise<AgentExecutorPreflightResult> {
    const descriptor = this.registry.get(id);
    if (descriptor?.sources !== undefined) return this.#discovered(id);
    switch (id) {
      case 'grok-acp':
        return this.#grok();
      case 'codex-acp':
        return this.#codex();
      case 'cursor-acp':
        return this.#simpleVersion(id, ['--version'], [
          info('Cursor uses the existing cursor-agent login and the pinned model is passed as a root --model flag before acp.'),
        ]);
      case 'claude-acp':
        return this.#claude();
      case 'gemini-acp':
        return this.#gemini();
      case 'kimi-acp':
        return this.#kimi();
      case 'opencode-acp':
        return this.#simpleVersion(id, ['--version'], [
          info('OpenCode uses the existing vendor login and configuration.'),
        ]);
      default:
        return {
          id,
          status: 'unavailable',
          command: '',
          resolvedArgs: [],
          diagnostics: [error(`Unknown built-in external executor "${id}".`)],
        };
    }
  }

  async #discovered(id: string): Promise<AgentExecutorPreflightResult> {
    const descriptor = this.registry.get(id)!;
    const sources = await this.registry.discover(id);
    const selected = selectExecutorSource(descriptor, sources);
    const diagnostics: AgentExecutorPreflightDiagnostic[] = sources.map((source) =>
      source.available
        ? info(`Source ${source.id}: ${source.command ?? ''}${source.version === undefined ? '' : ` (${source.version})`}`)
        : warning(`Source ${source.id}: ${source.diagnostic ?? 'unavailable'}`));
    if (descriptor.source !== undefined && selected === undefined) {
      diagnostics.unshift(error(`Configured source "${descriptor.source}" is unavailable.`));
    } else if (selected === undefined) {
      diagnostics.unshift(error('No configured executable source is available.'));
    } else {
      diagnostics.unshift(info(`Selected source ${selected.id}: ${selected.command}.`));
    }
    if (id === 'codex-app-server') {
      const codexHome = this.bootstrap.getEnv('CODEX_HOME') ?? join(this.bootstrap.osHomeDir, '.codex');
      const authPath = join(codexHome, 'auth.json');
      diagnostics.push(await this.#exists(authPath)
        ? info(`Codex auth state exists at ${authPath}.`)
        : warning(`Codex auth state was not found at ${authPath}; run the vendor login flow first.`));
      diagnostics.push(info('Codex uses app-server --listen stdio:// with on-request approvals and no bypass flag.'));
    }
    if (id === 'cursor-acp') {
      diagnostics.push(info('Only cursor-agent is admitted; the unrelated agent shim is never probed.'));
    }
    return resultOf(
      id,
      selected?.command ?? '',
      descriptor.args,
      selected?.version,
      diagnostics,
      selected?.id,
      sources,
    );
  }

  async #grok(): Promise<AgentExecutorPreflightResult> {
    const diagnostics = [
      this.bootstrap.getEnv('XAI_API_KEY') === undefined
        ? info('Grok reuses the existing CLI login; set XAI_API_KEY only if that is how the vendor CLI is authenticated.')
        : info('XAI_API_KEY is present in the host environment.'),
      info('Spawn order is grok --no-auto-update agent stdio; no auto-approve or bypass flag is used.'),
    ];
    return this.#simpleVersion('grok-acp', ['--version'], diagnostics);
  }

  async #codex(): Promise<AgentExecutorPreflightResult> {
    const descriptor = BUILTIN_AGENT_EXECUTORS['codex-acp']!;
    const [adapter, vendor] = await Promise.all([
      this.#probe(requiredBuiltinCommand(descriptor), ['--version']),
      this.#probe('codex', ['--version']),
    ]);
    const codexHome = this.bootstrap.getEnv('CODEX_HOME') ?? join(this.bootstrap.osHomeDir, '.codex');
    const authPath = join(codexHome, 'auth.json');
    const authPresent = await this.#exists(authPath);
    const diagnostics: AgentExecutorPreflightDiagnostic[] = [];
    if (!adapter.available) diagnostics.push(error('codex-acp adapter is not installed or not executable.'));
    else if (adapter.code !== 0) diagnostics.push(warning(`codex-acp --version exited with code ${adapter.code}.`));
    if (!vendor.available) diagnostics.push(error('Vendor codex CLI is not installed or not executable.'));
    else if (vendor.code !== 0) diagnostics.push(warning(`codex --version exited with code ${vendor.code}.`));
    diagnostics.push(authPresent
      ? info(`Codex auth state exists at ${authPath}.`)
      : warning(`Codex auth state was not found at ${authPath}; run the vendor login flow first.`));
    diagnostics.push(info('DISABLE_MCP_CONFIG_FILTERING=true will be injected into codex-acp.'));
    return resultOf('codex-acp', requiredBuiltinCommand(descriptor), descriptor.args, firstLine(adapter.output), diagnostics);
  }

  async #claude(): Promise<AgentExecutorPreflightResult> {
    const claudeHome = join(this.bootstrap.osHomeDir, '.claude');
    const diagnostics = [
      await this.#exists(claudeHome)
        ? info(`Claude login/config directory exists at ${claudeHome}.`)
        : warning(`Claude login/config directory was not found at ${claudeHome}; run the vendor login flow first.`),
    ];
    return this.#simpleVersion('claude-acp', ['--version'], diagnostics);
  }

  async #gemini(): Promise<AgentExecutorPreflightResult> {
    const descriptor = BUILTIN_AGENT_EXECUTORS['gemini-acp']!;
    const [version, help] = await Promise.all([
      this.#probe(requiredBuiltinCommand(descriptor), ['--version']),
      this.#probe(requiredBuiltinCommand(descriptor), ['--help']),
    ]);
    const diagnostics: AgentExecutorPreflightDiagnostic[] = [];
    if (!version.available) diagnostics.push(error('gemini is not installed or not executable.'));
    else if (version.code !== 0) diagnostics.push(warning(`gemini --version exited with code ${version.code}.`));
    let resolvedArgs = descriptor.args;
    if (help.available && /(^|\s)--acp\b/m.test(help.output)) {
      diagnostics.push(info('Gemini stable --acp flag is available.'));
    } else if (help.available && /(^|\s)--experimental-acp\b/m.test(help.output)) {
      resolvedArgs = ['--experimental-acp'];
      diagnostics.push(warning('Gemini does not advertise --acp; use --experimental-acp in the trusted descriptor override.'));
    } else if (version.available) {
      diagnostics.push(error('Gemini help advertises neither --acp nor --experimental-acp.'));
    }
    const geminiHome = join(this.bootstrap.osHomeDir, '.gemini');
    diagnostics.push(await this.#exists(geminiHome)
      ? info(`Gemini login/config directory exists at ${geminiHome}.`)
      : info('Gemini will reuse its vendor login or API-key environment when present.'));
    return resultOf('gemini-acp', requiredBuiltinCommand(descriptor), resolvedArgs, firstLine(version.output), diagnostics);
  }

  async #kimi(): Promise<AgentExecutorPreflightResult> {
    const descriptor = BUILTIN_AGENT_EXECUTORS['kimi-acp']!;
    const probe = await this.#probe(requiredBuiltinCommand(descriptor), ['--version']);
    const diagnostics: AgentExecutorPreflightDiagnostic[] = [];
    if (!probe.available) diagnostics.push(error('kimi is not installed or not executable.'));
    else if (probe.code !== 0) diagnostics.push(warning(`kimi --version exited with code ${probe.code}.`));
    const version = firstLine(probe.output);
    const parsed = version === undefined ? null : coerce(version);
    if (parsed !== null && gte(parsed, '0.37.0')) {
      diagnostics.push(warning('Kimi Code 0.37+ has a reported ACP MCP-injection regression; verify startup before relying on this harness.'));
    } else {
      diagnostics.push(info('Kimi reuses the existing Kimi Code login and configuration.'));
    }
    return resultOf('kimi-acp', requiredBuiltinCommand(descriptor), descriptor.args, version, diagnostics);
  }

  async #simpleVersion(
    id: string,
    versionArgs: readonly string[],
    initial: readonly AgentExecutorPreflightDiagnostic[],
  ): Promise<AgentExecutorPreflightResult> {
    const descriptor = BUILTIN_AGENT_EXECUTORS[id]!;
    const probe = await this.#probe(requiredBuiltinCommand(descriptor), versionArgs);
    const diagnostics = [...initial];
    if (!probe.available) diagnostics.unshift(error(`${requiredBuiltinCommand(descriptor)} is not installed or not executable.`));
    else if (probe.code !== 0) diagnostics.unshift(warning(`${requiredBuiltinCommand(descriptor)} ${versionArgs.join(' ')} exited with code ${probe.code}.`));
    return resultOf(id, requiredBuiltinCommand(descriptor), descriptor.args, firstLine(probe.output), diagnostics);
  }

  async #probe(command: string, args: readonly string[]): Promise<CommandProbe> {
    let child: IHostProcess;
    try {
      child = await this.processService.spawn(command, args, {
        shell: false,
        windowsHide: true,
        mergeStderr: false,
      });
    } catch {
      return { available: false, output: '' };
    }
    let output = '';
    const append = (chunk: Buffer | string): void => {
      if (output.length >= 64 * 1024) return;
      output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    let timer: NodeJS.Timeout | undefined;
    try {
      const code = await Promise.race([
        child.wait(),
        new Promise<number>((resolve) => {
          timer = setTimeout(() => resolve(-1), 10_000);
        }),
      ]);
      if (code === -1 && child.exitCode === null) await child.kill('SIGTERM').catch(() => undefined);
      return { available: true, code, output: output.trim() };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await child.dispose();
    }
  }

  async #exists(path: string): Promise<boolean> {
    try {
      await this.fs.stat(path);
      return true;
    } catch {
      return false;
    }
  }
}

function requiredBuiltinCommand(descriptor: { readonly command?: string }): string {
  if (descriptor.command === undefined) throw new Error('Built-in executor has no command');
  return descriptor.command;
}

function resultOf(
  id: string,
  command: string,
  resolvedArgs: readonly string[],
  version: string | undefined,
  diagnostics: readonly AgentExecutorPreflightDiagnostic[],
  selectedSource?: string,
  sources?: readonly import('./agentExecutor').AgentExecutorSourceProbe[],
): AgentExecutorPreflightResult {
  const status = diagnostics.some((diagnostic) => diagnostic.severity === 'error')
    ? 'unavailable'
    : diagnostics.some((diagnostic) => diagnostic.severity === 'warning')
      ? 'warning'
      : 'ready';
  return { id, status, command, version, selectedSource, sources, resolvedArgs, diagnostics };
}

function firstLine(value: string): string | undefined {
  return value.split(/\r?\n/, 1)[0] || undefined;
}

function info(message: string): AgentExecutorPreflightDiagnostic {
  return { severity: 'info', message };
}

function warning(message: string): AgentExecutorPreflightDiagnostic {
  return { severity: 'warning', message };
}

function error(message: string): AgentExecutorPreflightDiagnostic {
  return { severity: 'error', message };
}

registerScopedService(
  LifecycleScope.App,
  IAgentExecutorPreflightService,
  AgentExecutorPreflightService,
  ScopeActivation.OnDemand,
  'agentExecutorPreflight',
);
