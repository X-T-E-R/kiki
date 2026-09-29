import { join } from 'pathe';
import { coerce, gte } from 'semver';
import { CodexAppServerClient } from '@kiki/codex-client';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService, type IHostProcess } from '#/os/interface/hostProcess';

import { IAgentExecutorRegistry, type AgentExecutorDescriptor } from './agentExecutor';
import { selectExecutorSource } from './binaryDiscovery';

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
  readonly loginStatus: 'logged_in' | 'logged_out' | 'unknown';
}

export interface IAgentExecutorPreflightService {
  readonly _serviceBrand: undefined;
  run(ids?: readonly string[]): Promise<readonly AgentExecutorPreflightResult[]>;
  lastCheck(id: string): AgentExecutorPreflightResult | undefined;
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
  readonly #lastChecks = new Map<string, { readonly result: AgentExecutorPreflightResult; readonly checkedAt: number }>();

  constructor(
    @IHostProcessService private readonly processService: IHostProcessService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IAgentExecutorRegistry private readonly registry: IAgentExecutorRegistry,
  ) {}

  async run(ids: readonly string[] = this.registry.list().filter((descriptor) => descriptor.protocol !== 'native').map((descriptor) => descriptor.id)): Promise<readonly AgentExecutorPreflightResult[]> {
    return Promise.all(ids.map(async (id) => {
      const result = await this.#runOne(id);
      if (this.registry.get(id) !== undefined) this.#lastChecks.set(id, { result, checkedAt: Date.now() });
      return result;
    }));
  }

  lastCheck(id: string): AgentExecutorPreflightResult | undefined {
    const check = this.#lastChecks.get(id);
    return check !== undefined && Date.now() - check.checkedAt < 60_000 ? check.result : undefined;
  }

  async #runOne(id: string): Promise<AgentExecutorPreflightResult> {
    const descriptor = this.registry.get(id);
    if (descriptor === undefined) return resultOf(id, '', [], undefined,
      [error(`Unknown external executor "${id}".`)]);
    if (descriptor.sources !== undefined) return this.#discovered(id);
    const command = descriptor.command ?? '';
    const versionArgs = descriptor.versionProbe?.args ?? ['--version'];
    const probe = await this.#probe(command, versionArgs);
    const diagnostics: AgentExecutorPreflightDiagnostic[] = [];
    if (!probe.available) diagnostics.push(error(`${command} is not installed or not executable.`));
    else if (probe.code !== 0) diagnostics.push(warning(`${command} ${versionArgs.join(' ')} exited with code ${probe.code}.`));
    const version = firstLine(probe.output);
    const rules = await this.#diagnostics(descriptor, version, probe.available);
    diagnostics.push(...rules.diagnostics);
    const loginStatus = probe.available && probe.code === 0 ? await this.#auth(descriptor) : 'unknown';
    return resultOf(id, command, rules.resolvedArgs, version, diagnostics, undefined, undefined, loginStatus);
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
    const rules = await this.#diagnostics(descriptor, selected?.version, selected !== undefined);
    diagnostics.push(...rules.diagnostics);
    return resultOf(
      id,
      selected?.command ?? '',
      rules.resolvedArgs,
      selected?.version,
      diagnostics,
      selected?.id,
      sources,
      selected === undefined ? 'unknown' : await this.#auth(descriptor, selected.command),
    );
  }

  async #diagnostics(descriptor: AgentExecutorDescriptor, version?: string, available = true): Promise<{
    readonly diagnostics: AgentExecutorPreflightDiagnostic[];
    readonly resolvedArgs: readonly string[];
  }> {
    const diagnostics: AgentExecutorPreflightDiagnostic[] = [];
    let resolvedArgs = descriptor.args;
    for (const rule of descriptor.diagnostics ?? []) {
      if (rule.kind === 'message') diagnostics.push({ severity: rule.severity, message: rule.message });
      if (rule.kind === 'env') diagnostics.push(info(this.bootstrap.getEnv(rule.name) === undefined ? rule.absent : rule.present));
      if (rule.kind === 'path') {
        const path = rule.envHome === undefined ? join(this.bootstrap.osHomeDir, rule.path)
          : join(this.bootstrap.getEnv(rule.envHome) ?? join(this.bootstrap.osHomeDir, rule.path.split('/')[0]!),
            rule.path.split('/').slice(1).join('/'));
        const present = await this.#exists(path);
        const message = (present ? rule.present : rule.absent).replaceAll('{path}', path);
        diagnostics.push(present ? info(message) : { severity: rule.absentSeverity, message });
      }
      if (rule.kind === 'dependency') {
        const probe = await this.#probe(rule.command, rule.args);
        if (!probe.available) diagnostics.push(error(rule.unavailable));
        else if (probe.code !== 0) diagnostics.push(warning(rule.failed.replaceAll('{code}', String(probe.code))));
      }
      if (rule.kind === 'flag' && descriptor.command !== undefined) {
        const probe = await this.#probe(descriptor.command, rule.args);
        const hasFlag = (flag: string): boolean => probe.output.split(/\s+/).includes(flag);
        if (probe.available && hasFlag(rule.stable)) diagnostics.push(info(rule.stableMessage));
        else if (probe.available && hasFlag(rule.fallback)) {
          resolvedArgs = descriptor.args.map((arg) => arg === rule.stable ? rule.fallback : arg);
          diagnostics.push(warning(rule.fallbackMessage));
        } else if (available) diagnostics.push(error(rule.missingMessage));
      }
      if (rule.kind === 'version') {
        const parsed = version === undefined ? null : coerce(version);
        diagnostics.push(parsed !== null && gte(parsed, rule.min) ? warning(rule.warning) : info(rule.normal));
      }
    }
    return { diagnostics, resolvedArgs };
  }

  async #auth(descriptor: AgentExecutorDescriptor, command = descriptor.command): Promise<AgentExecutorPreflightResult['loginStatus']> {
    const auth = descriptor.auth;
    if (auth?.kind === 'codex-account') {
      if (command === undefined) return 'unknown';
      const client = new CodexAppServerClient(this.processService, {
        id: descriptor.id, command, args: descriptor.args,
        env: descriptor.env === undefined ? undefined : { ...descriptor.env },
        startupTimeoutMs: 12_000, requestTimeoutMs: 12_000,
      });
      try {
        const signal = AbortSignal.timeout(15_000);
        await client.connect(signal);
        const response: unknown = await client.request('account/read', { refreshToken: false }, signal);
        if (typeof response !== 'object' || response === null || !('account' in response)) return 'unknown';
        return response.account === null ? 'logged_out'
          : typeof response.account === 'object' && response.account !== null ? 'logged_in' : 'unknown';
      } catch {
        return 'unknown';
      } finally {
        await client.shutdown().catch(() => undefined);
      }
    }
    if (auth?.kind !== 'command-json') return 'unknown';
    const probe = await this.#probe(auth.command, auth.args);
    if (!probe.available || probe.code !== 0) return 'unknown';
    try {
      const data: unknown = JSON.parse(probe.output);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) return 'unknown';
      const loggedIn = (data as Record<string, unknown>)[auth.loggedInKey];
      return loggedIn === true ? 'logged_in' : loggedIn === false ? 'logged_out' : 'unknown';
    } catch {
      return 'unknown';
    }
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

function resultOf(
  id: string,
  command: string,
  resolvedArgs: readonly string[],
  version: string | undefined,
  diagnostics: readonly AgentExecutorPreflightDiagnostic[],
  selectedSource?: string,
  sources?: readonly import('./agentExecutor').AgentExecutorSourceProbe[],
  loginStatus: AgentExecutorPreflightResult['loginStatus'] = 'unknown',
): AgentExecutorPreflightResult {
  const status = diagnostics.some((diagnostic) => diagnostic.severity === 'error')
    ? 'unavailable'
    : diagnostics.some((diagnostic) => diagnostic.severity === 'warning')
      ? 'warning'
      : 'ready';
  return { id, status, command, version, selectedSource, sources, resolvedArgs, diagnostics, loginStatus };
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
