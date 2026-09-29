import { join } from 'pathe';
import { coerce, gte } from 'semver';
import { CodexAppServerClient } from '@kiki/codex-client';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService, type IHostProcess } from '#/os/interface/hostProcess';

import { IAgentExecutorRegistry, type AgentExecutorDescriptor, type AgentExecutorSourceProbe } from './agentExecutor';
import { expandExecutorText, locateCommand, selectExecutorSource } from './binaryDiscovery';
import {
  claudeConfigDir,
  claudeSettingsPaths,
  credentialFromClaudeCliStatus,
  scanClaudeCredentials,
} from './claudeCredentials';
import { executorEnvLookup, executorLaunchArgs, executorProcessEnv } from './executorOverrides';

export type AgentExecutorPreflightStatus = 'ready' | 'warning' | 'unavailable';
export type AgentExecutorPreflightSeverity = 'info' | 'warning' | 'error';

export interface AgentExecutorPreflightDiagnostic {
  readonly severity: AgentExecutorPreflightSeverity;
  readonly message: string;
}

/**
 * One thing that must be installed before the engine can run, in setup order:
 * declared `dependency` rules first, then the launched program itself.
 */
export interface AgentExecutorRequirement {
  readonly id: string;
  readonly label: string;
  readonly role: 'dependency' | 'program';
  readonly status: 'ok' | 'missing' | 'failed';
  readonly path?: string;
  readonly version?: string;
  readonly installHint?: string;
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
  readonly credentialSource?: import('./agentExecutor').AgentExecutorCredentialSource;
  readonly credentialDetail?: string;
  readonly requirements: readonly AgentExecutorRequirement[];
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

interface CredentialResolution {
  readonly loginStatus: AgentExecutorPreflightResult['loginStatus'];
  readonly source?: import('./agentExecutor').AgentExecutorCredentialSource;
  readonly detail?: string;
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
    const launchEnv = executorProcessEnv(descriptor);
    const probe = await this.#probe(command, versionArgs, launchEnv);
    const diagnostics: AgentExecutorPreflightDiagnostic[] = [];
    if (!probe.available) diagnostics.push(error(`${command} is not installed or not executable.`));
    else if (probe.code !== 0) diagnostics.push(warning(`${command} ${versionArgs.join(' ')} exited with code ${probe.code}.`));
    const version = firstLine(probe.output);
    const rules = await this.#diagnostics(descriptor, version, probe.available, command);
    diagnostics.push(...rules.diagnostics);
    const loginStatus = probe.available && probe.code === 0 ? await this.#auth(descriptor) : { loginStatus: 'unknown' as const };
    const program = programRequirement(descriptor, probe.available ? probe.code === 0 ? 'ok' : 'failed' : 'missing',
      probe.available ? await locateCommand(command, this.fs, this.bootstrap) ?? command : undefined, version, this.bootstrap);
    return resultOf(id, command, rules.resolvedArgs, version, diagnostics, undefined, undefined, loginStatus,
      [...rules.requirements, program]);
  }

  async #discovered(id: string): Promise<AgentExecutorPreflightResult> {
    const descriptor = this.registry.get(id)!;
    const sources = await this.registry.discover(id);
    const selected = selectExecutorSource(descriptor, sources);
    const diagnostics: AgentExecutorPreflightDiagnostic[] = sources.map((source) =>
      source.available
        ? info(`Source ${source.id}: ${sourceLocation(source)}${source.version === undefined ? '' : ` (${source.version})`}`)
        : (selected === undefined ? warning : info)(`Source ${source.id}: ${source.diagnostic ?? 'unavailable'}`));
    if (descriptor.source !== undefined && selected === undefined) {
      diagnostics.unshift(error(`Configured source "${descriptor.source}" is unavailable.`));
    } else if (selected === undefined) {
      diagnostics.unshift(error('No configured executable source is available.'));
    } else {
      diagnostics.unshift(info(`Selected source ${selected.id}: ${sourceLocation(selected)}.`));
    }
    const rules = await this.#diagnostics(descriptor, selected?.version, selected !== undefined, selected?.command);
    diagnostics.push(...rules.diagnostics);
    const failed = selected === undefined
      ? sources.find((source) => !source.available && source.command !== undefined) : undefined;
    const program = programRequirement(descriptor, selected !== undefined ? 'ok' : failed !== undefined ? 'failed' : 'missing',
      selected === undefined ? undefined : sourceLocation(selected), selected?.version, this.bootstrap);
    return resultOf(
      id,
      selected?.command ?? '',
      rules.resolvedArgs,
      selected?.version,
      diagnostics,
      selected?.id,
      sources,
      selected === undefined ? { loginStatus: 'unknown' as const } : await this.#auth(descriptor, selected.command),
      [...rules.requirements, program],
    );
  }

  async #diagnostics(
    descriptor: AgentExecutorDescriptor,
    version?: string,
    available = true,
    command = descriptor.command,
  ): Promise<{
    readonly diagnostics: AgentExecutorPreflightDiagnostic[];
    readonly resolvedArgs: readonly string[];
    readonly requirements: AgentExecutorRequirement[];
  }> {
    const diagnostics: AgentExecutorPreflightDiagnostic[] = [];
    const requirements: AgentExecutorRequirement[] = [];
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
        const probe = await this.#probe(rule.command, rule.args, executorProcessEnv(descriptor));
        if (!probe.available) diagnostics.push(error(rule.unavailable));
        else if (probe.code !== 0) diagnostics.push(warning(rule.failed.replaceAll('{code}', String(probe.code))));
        requirements.push({
          id: rule.command,
          label: rule.label ?? rule.command,
          role: 'dependency',
          status: !probe.available ? 'missing' : probe.code === 0 ? 'ok' : 'failed',
          path: probe.available ? await locateCommand(rule.command, this.fs, this.bootstrap) ?? rule.command : undefined,
          version: probe.available ? firstLine(probe.output) : undefined,
          installHint: rule.installHint === undefined ? undefined : expandExecutorText(rule.installHint, this.bootstrap),
        });
      }
      if (rule.kind === 'flag' && command !== undefined) {
        const probe = await this.#probe(command, rule.args, executorProcessEnv(descriptor));
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
    return { diagnostics, resolvedArgs: executorLaunchArgs(descriptor, resolvedArgs), requirements };
  }

  async #auth(descriptor: AgentExecutorDescriptor, command = descriptor.command): Promise<CredentialResolution> {
    const auth = descriptor.auth;
    if (auth?.kind === 'codex-account') {
      if (command === undefined) return { loginStatus: 'unknown' };
      const client = new CodexAppServerClient(this.processService, {
        id: descriptor.id, command, args: descriptor.args,
        env: executorProcessEnv(descriptor),
        startupTimeoutMs: 12_000, requestTimeoutMs: 12_000,
      });
      try {
        const signal = AbortSignal.timeout(15_000);
        await client.connect(signal);
        const response: unknown = await client.request('account/read', { refreshToken: false }, signal);
        if (typeof response !== 'object' || response === null || !('account' in response)) return { loginStatus: 'unknown' };
        return { loginStatus: response.account === null ? 'logged_out'
          : typeof response.account === 'object' && response.account !== null ? 'logged_in' : 'unknown' };
      } catch {
        return { loginStatus: 'unknown' };
      } finally {
        await client.shutdown().catch(() => undefined);
      }
    }
    if (auth?.kind === 'claude-credentials') return this.#claudeCredentials(descriptor, auth);
    if (auth?.kind !== 'command-json') return { loginStatus: 'unknown' };
    const probe = await this.#probe(auth.command, auth.args, executorProcessEnv(descriptor));
    if (!probe.available || probe.code === -1) return { loginStatus: 'unknown' };
    try {
      const data: unknown = JSON.parse(probe.output);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) return { loginStatus: 'unknown' };
      const loggedIn = (data as Record<string, unknown>)[auth.loggedInKey];
      return { loginStatus: loggedIn === true ? 'logged_in' : loggedIn === false ? 'logged_out' : 'unknown' };
    } catch {
      return { loginStatus: 'unknown' };
    }
  }

  async #claudeCredentials(
    descriptor: AgentExecutorDescriptor,
    auth: { readonly command: string; readonly args: readonly string[] },
  ): Promise<CredentialResolution> {
    const lookup = executorEnvLookup(descriptor, (name) => this.bootstrap.getEnv(name));
    const configDir = claudeConfigDir({ get: lookup }, this.bootstrap.osHomeDir);
    const local = await scanClaudeCredentials({
      env: { get: lookup },
      readText: async (path) => {
        try {
          return await this.fs.readText(path);
        } catch {
          return undefined;
        }
      },
      settingsPaths: claudeSettingsPaths(configDir),
    });
    if (local.source !== 'none') return { loginStatus: 'logged_in', source: local.source, detail: local.detail };
    const probe = await this.#probe(auth.command, auth.args, executorProcessEnv(descriptor));
    if (!probe.available || probe.code === -1) {
      return { loginStatus: 'unknown', source: 'unknown' };
    }
    const remote = credentialFromClaudeCliStatus(probe.output);
    if (remote.source === 'unknown') return { loginStatus: 'unknown', source: 'unknown' };
    return remote.source === 'none'
      ? { loginStatus: 'logged_out', source: 'none' }
      : { loginStatus: 'logged_in', source: remote.source, detail: remote.detail };
  }

  async #probe(command: string, args: readonly string[], env?: Record<string, string>): Promise<CommandProbe> {
    let child: IHostProcess;
    try {
      child = await this.processService.spawn(command, args, {
        shell: false,
        windowsHide: true,
        mergeStderr: false,
        env,
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

const UNKNOWN_CREDENTIALS: CredentialResolution = { loginStatus: 'unknown' };

function resultOf(
  id: string,
  command: string,
  resolvedArgs: readonly string[],
  version: string | undefined,
  diagnostics: readonly AgentExecutorPreflightDiagnostic[],
  selectedSource?: string,
  sources?: readonly import('./agentExecutor').AgentExecutorSourceProbe[],
  credentials: CredentialResolution = UNKNOWN_CREDENTIALS,
  requirements: readonly AgentExecutorRequirement[] = [],
): AgentExecutorPreflightResult {
  const status = diagnostics.some((diagnostic) => diagnostic.severity === 'error')
    ? 'unavailable'
    : diagnostics.some((diagnostic) => diagnostic.severity === 'warning')
      ? 'warning'
      : 'ready';
  return { id, status, command, version, selectedSource, sources, resolvedArgs, diagnostics,
    loginStatus: credentials.loginStatus, credentialSource: credentials.source,
    credentialDetail: credentials.detail, requirements };
}

function programRequirement(
  descriptor: AgentExecutorDescriptor,
  status: AgentExecutorRequirement['status'],
  path: string | undefined,
  version: string | undefined,
  bootstrap: IBootstrapService,
): AgentExecutorRequirement {
  return {
    id: descriptor.id,
    label: descriptor.programLabel ?? descriptor.label ?? descriptor.id,
    role: 'program',
    status,
    path,
    version,
    installHint: descriptor.installHint === undefined ? undefined : expandExecutorText(descriptor.installHint, bootstrap),
  };
}

function sourceLocation(source: AgentExecutorSourceProbe): string {
  return source.launchArgs?.[0] ?? source.command ?? '';
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
