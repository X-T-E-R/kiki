import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize } from 'pathe';
import { Disposable } from '#/_base/di/lifecycle';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { IBashParserService } from '#/app/bashParser/bashParser';
import { IEventBus } from '#/app/event/eventBus';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { AgentsMdReminderShownEvent } from '#/app/telemetry/events';
import { IAgentRuntimeService, inspectAgentWorkspaceRoots } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { translateShellDrivePath } from '@kiki/kaos/exec-env';
import { profileKey } from '#/agent/profile/profileOps';
import { dynamicPromptKey } from '#/agent/profile/dynamicPrompt';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { ToolDidExecuteContext } from '#/agent/toolExecutor/toolHooks';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { RuntimeLease } from '#/runtime/runtime';
import { IAgentAgentsMdReminderService } from './agentsMdReminder';
import { IAgentsMdDiscoveryService } from './agentsMdDiscoveryService';
import { extractBashTargetDirs } from './bashTargets';
import {
  analyzeInstructionCoverage,
  classifyDiscoveredChain,
  instructionKey,
  instructionVersion,
  type DiscoveredChainAction,
  type InstructionAliasFile,
  type InstructionFile,
} from './instructionCoverage';

export const agentsMdReminderKnownKey = defineState<Set<string>>('agentsMdReminder.known', () => new Set());
export const agentsMdReminderCwdKey = defineState<string | undefined>('agentsMdReminder.cwd', () => undefined);
export const agentsMdReminderSeededKey = defineState<boolean>('agentsMdReminder.seeded', () => false);

interface PendingInstruction {
  readonly file: InstructionFile;
  readonly sourcePath: string;
  readonly content: string;
  readonly pathClass: 'posix' | 'win32';
}

export class AgentAgentsMdReminderService extends Disposable implements IAgentAgentsMdReminderService {
  declare readonly _serviceBrand: undefined;
  private readonly pending = new Map<string, PendingInstruction>();
  private pendingGeneration = 0;
  private readonly telemetryFired = new Set<string>();
  private readonly loaded = new Map<string, { item: PendingInstruction; mtimeMs: number; size: number; dirRevision: number }>();
  private readonly loadFlights = new Map<string, Promise<PendingInstruction | undefined>>();

  constructor(
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IEventBus _eventBus: IEventBus,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IAgentStateService private readonly states: IAgentStateService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @IAgentsMdDiscoveryService private readonly discovery: IAgentsMdDiscoveryService,
    @IBashParserService private readonly bashParser: IBashParserService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IEventDispatcher dispatcher: IEventDispatcher,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
  ) {
    super();
    this.states.contributeState(agentsMdReminderKnownKey);
    this.states.contributeState(agentsMdReminderCwdKey);
    this.states.contributeState(agentsMdReminderSeededKey);
    this._register(dispatcher.hooks.onDidRestore.register('agentsMdReminder', async (_ctx, next) => {
      this.pendingGeneration++;
      this.pending.clear();
      await next();
    }));
    this._register(toolExecutor.onWillExecuteTool((event) => {
      if (!event.execution.accesses?.some((access) => access.kind === 'file' && access.workspaceRoot !== true && (access.operation === 'write' || access.operation === 'readwrite'))) return;
      event.waitUntil((async () => {
        const actions = await this.discoverActionsFor(event.execution.accesses ?? [], event.args);
        if (!actions.some((action) => action.kind === 'full')) return;
        this.queue(actions.map((action) => action.item));
        event.veto({ isError: true, output: 'No files were changed. Applicable directory instructions have not yet been disclosed in this context. The host will disclose them before the next step; review them and retry this operation.' });
      })());
    }));
    this._register(toolExecutor.hooks.onDidExecuteTool.register('agentsMdReminder', async (ctx, next) => {
      try {
        await this.afterTool(ctx);
      } catch (error) {
        onUnexpectedError(error);
      }
      await next();
    }));
  }

  seedInjected(paths: readonly string[], cwd: string): void {
    this.states.set(agentsMdReminderKnownKey, new Set(paths.map(normalize)));
    this.states.set(agentsMdReminderCwdKey, cwd);
    this.states.set(agentsMdReminderSeededKey, true);
  }

  async flushStepHead(): Promise<void> {
    const generation = this.pendingGeneration;
    const candidates: PendingInstruction[] = [];
    for (const item of this.pending.values()) {
      const lease = this.acquire(item.file.runtimeId.startsWith('ssh:') ? item.file.runtimeId.slice(4) : item.file.runtimeId === 'local' ? 'local' : undefined);
      try {
        const current = await this.load(lease, item.sourcePath, true);
        if (current !== undefined) candidates.push(current);
      } finally { lease.dispose(); }
      if (generation !== this.pendingGeneration) return;
    }
    const actions = this.classifyChains(candidates);
    if (actions.length === 0) { this.pending.clear(); return; }
    const fullFiles: InstructionFile[] = [];
    const aliasFiles: InstructionAliasFile[] = [];
    const blocks: string[] = [];
    for (const action of actions) {
      const { item } = action;
      if (action.kind === 'full') {
        fullFiles.push(item.file);
        blocks.push(`<!-- From: ${item.sourcePath} -->\nHost: ${item.file.runtimeId}; scope: ${item.file.scope}\n${item.content}`);
      } else {
        aliasFiles.push({ ...item.file, canonicalSourcePath: action.canonicalSourcePath });
        blocks.push(`<!-- From: ${item.sourcePath} -->\nHost: ${item.file.runtimeId}; scope: ${item.file.scope}\n(Identical to ${action.canonicalSourcePath} already in context above; overrides parent directory instructions within this scope.)`);
      }
    }
    this.reminders.appendSystemReminder(`Applicable directory instructions (complete current versions; apply within each stated directory scope):\n\n${blocks.join('\n\n')}`, {
      kind: 'injection',
      variant: 'agents_md',
      disclosure: {
        mode: 'add',
        files: fullFiles,
        ...(aliasFiles.length > 0 ? { aliases: aliasFiles } : {}),
      },
    });
    this.pending.clear();
  }

  private acquire(host?: string): RuntimeLease {
    return this.runtime.acquireFor === undefined || host === undefined ? this.runtime.acquire(['fs']) : this.runtime.acquireFor(host, ['fs']);
  }

  private systemFilesFor(candidates: readonly PendingInstruction[], pathClass: 'posix' | 'win32'): InstructionFile[] {
    const profile = this.states.get(profileKey);
    const files = this.states.get(dynamicPromptKey)?.context.agentsMdFiles ?? [];
    const out: InstructionFile[] = [];
    for (const item of candidates) {
      if (item.pathClass !== pathClass) continue;
      const key = instructionKey(item.file, pathClass);
      const trusted = files.some((file) => instructionKey(file, pathClass) === key && file.version === item.file.version) ||
        (item.file.runtimeId === this.runtime.inspect().identity.runtimeId &&
          (profile.agentsMdPaths ?? []).some((path) => instructionKey({ path, runtimeId: item.file.runtimeId, scope: item.file.scope }, pathClass) === key));
      if (trusted && profile.systemPrompt.includes(`<!-- From: ${item.sourcePath} -->\n${item.content}`)) {
        out.push(item.file);
      }
    }
    return out;
  }

  private classifyChains(candidates: readonly PendingInstruction[]): DiscoveredChainAction<PendingInstruction>[] {
    if (candidates.length === 0) return [];
    const history = this.context.get();
    const byClass = new Map<'posix' | 'win32', PendingInstruction[]>();
    for (const item of candidates) {
      const list = byClass.get(item.pathClass) ?? [];
      list.push(item);
      byClass.set(item.pathClass, list);
    }
    const actions = new Map<string, DiscoveredChainAction<PendingInstruction>>();
    for (const [pathClass, items] of byClass) {
      const coverage = analyzeInstructionCoverage(history, pathClass, this.systemFilesFor(items, pathClass));
      const sorted = [...items].sort((a, b) => a.file.scope.length - b.file.scope.length);
      for (const item of sorted) {
        const normScope = pathClass === 'win32' ? normalize(item.file.scope).toLowerCase() : normalize(item.file.scope);
        const chain = sorted.filter((anc) => {
          if (anc.file.runtimeId !== item.file.runtimeId) return false;
          const ancScope = pathClass === 'win32' ? normalize(anc.file.scope).toLowerCase() : normalize(anc.file.scope);
          const prefix = ancScope.endsWith('/') ? ancScope : `${ancScope}/`;
          return normScope === ancScope || normScope.startsWith(prefix);
        });
        for (const action of classifyDiscoveredChain(chain, coverage)) {
          const key = instructionKey(action.item.file, pathClass);
          const prev = actions.get(key);
          if (prev === undefined || (prev.kind === 'alias' && action.kind === 'full')) {
            actions.set(key, action);
          }
        }
      }
    }
    return [...actions.values()];
  }

  private queue(items: readonly PendingInstruction[]): void {
    for (const item of items) this.pending.set(instructionKey(item.file, item.pathClass), item);
  }

  private async load(lease: RuntimeLease, path: string, freshStat = false): Promise<PendingInstruction | undefined> {
    const scopeDir = basename(dirname(path)).toLowerCase() === '.kiki' ? dirname(dirname(path)) : dirname(path);
    const key = `${lease.runtime.identity.runtimeId}:${lease.runtime.identity.generation}:${normalize(path)}`;
    const cacheState = this.discovery.directoryCacheState?.(lease.runtime, scopeDir);
    if (!freshStat) {
      const cached = this.loaded.get(key);
      if (cached !== undefined && cacheState !== undefined && cacheState.fresh && cacheState.revision === cached.dirRevision) {
        return cached.item;
      }
      const inflight = this.loadFlights.get(key);
      if (inflight !== undefined) return inflight;
    }
    const flight = this.loadFromDisk(lease, path, scopeDir, key, cacheState?.revision ?? 0).finally(() => {
      if (this.loadFlights.get(key) === flight) this.loadFlights.delete(key);
    });
    if (!freshStat) this.loadFlights.set(key, flight);
    return flight;
  }

  private async loadFromDisk(
    lease: RuntimeLease,
    path: string,
    scopeDir: string,
    key: string,
    dirRevision: number,
  ): Promise<PendingInstruction | undefined> {
    try {
      const fs = lease.runtime.fs!;
      const stat = await fs.stat(path);
      if (!stat.isFile) return undefined;
      const cached = this.loaded.get(key);
      if (stat.mtimeMs !== undefined && cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        this.loaded.set(key, { ...cached, dirRevision });
        return cached.item;
      }
      const content = (await fs.readText(path, { errors: 'strict' })).trim();
      if (!content) return undefined;
      const canonical = await fs.realpath(path);
      const item: PendingInstruction = { content, sourcePath: path, pathClass: lease.runtime.environment.pathClass, file: { path: normalize(canonical),
        version: instructionVersion(content), scope: scopeDir,
        runtimeId: lease.runtime.identity.runtimeId } };
      if (stat.mtimeMs !== undefined) {
        if (this.loaded.size >= 64) this.loaded.delete(this.loaded.keys().next().value!);
        this.loaded.set(key, { item, mtimeMs: stat.mtimeMs, size: stat.size, dirRevision });
      }
      return item;
    } catch { return undefined; }
  }

  private async admittedRootsFor(lease: RuntimeLease): Promise<readonly string[]> {
    const mapped = lease.runtime.workspace.mapRoots(inspectAgentWorkspaceRoots(this.runtime, {
      workDir: this.sessionContext.cwd,
      additionalDirs: [],
    }));
    const rawRoots = [mapped.workDir, ...(mapped.additionalDirs ?? [])];
    const resolved = await Promise.all(rawRoots.map(async (dir) => {
      const normalized = stripTrailingSlash(normalize(dir));
      try {
        const real = this.discovery.resolveRealPath !== undefined
          ? await this.discovery.resolveRealPath(lease, normalized)
          : normalize(await lease.runtime.fs!.realpath(normalized));
        return stripTrailingSlash(real);
      } catch {
        return normalized;
      }
    }));
    return [...new Set([...rawRoots.map((dir) => stripTrailingSlash(normalize(dir))), ...resolved])];
  }

  private async isTrustedExternalPath(
    lease: RuntimeLease,
    targetPath: string,
    checkDirectory = true,
  ): Promise<boolean> {
    const pathClass = lease.runtime.environment.pathClass;
    const normalized = stripTrailingSlash(normalize(targetPath));
    if (checkDirectory && isSharedSystemDirectory(normalized, pathClass)) return false;
    const fs = lease.runtime.fs;
    if (fs === undefined) return false;
    try {
      const info = await fs.stat(normalized);
      if (!isTrustedExternalStat(info, lease.runtime.identity.runtimeId, lease.runtime.environment)) return false;
      return true;
    } catch {
      return false;
    }
  }

  private async discoverDir(lease: RuntimeLease, directory: string): Promise<readonly string[]> {
    let target = stripTrailingSlash(normalize(directory));
    try {
      target = stripTrailingSlash(this.discovery.resolveRealPath !== undefined
        ? await this.discovery.resolveRealPath(lease, target)
        : normalize(await lease.runtime.fs!.realpath(target)));
    } catch {}
    const pathClass = lease.runtime.environment.pathClass;
    const admittedRoots = await this.admittedRootsFor(lease);
    const matchedRoot = matchAdmittedRoot(target, admittedRoots, pathClass);
    if (matchedRoot !== undefined) {
      return this.discovery.discover(lease, target, matchedRoot);
    }
    if (!await this.isTrustedExternalPath(lease, target, true)) return [];
    const discovered = await this.discovery.discover(lease, target, undefined);
    if (discovered.length === 0) return discovered;
    const trusted: string[] = [];
    for (const filePath of discovered) {
      const parentDir = dirname(filePath);
      const scopeDir = basename(parentDir).toLowerCase() === '.kiki' ? dirname(parentDir) : parentDir;
      const scopeOk = await this.isTrustedExternalPath(lease, scopeDir, true);
      if (!scopeOk) continue;
      if (parentDir !== scopeDir && !await this.isTrustedExternalPath(lease, parentDir, true)) continue;
      if (!await this.isTrustedExternalPath(lease, filePath, false)) continue;
      trusted.push(filePath);
    }
    return trusted;
  }

  private async discoverActionsFor(accesses: readonly import('#/tool/toolContract').ToolResourceAccess[], args: unknown): Promise<DiscoveredChainAction<PendingInstruction>[]> {
    const dirs = [...new Set(accesses.flatMap((access) => access.kind === 'file' && access.workspaceRoot !== true ? [access.operation === 'search' || access.recursive ? access.path : dirname(access.path)] : []))];
    if (dirs.length === 0) return [];
    const host = stringArg(args, 'host');
    const lease = this.acquire(host);
    try {
      const paths = [...new Set((await Promise.all(dirs.map((dir) => this.discoverDir(lease, dir)))).flat())];
      const loaded = await Promise.all(paths.map((path) => this.load(lease, path)));
      return this.classifyChains(preferredInstructions(loaded));
    } finally { lease.dispose(); }
  }

  private async discoverFor(accesses: readonly import('#/tool/toolContract').ToolResourceAccess[], args: unknown): Promise<PendingInstruction[]> {
    return (await this.discoverActionsFor(accesses, args)).map((action) => action.item);
  }

  private async afterTool(ctx: ToolDidExecuteContext): Promise<void> {
    if (ctx.outcome !== 'executed') return;
    const accesses = ctx.accesses ?? [];
    const mutatedAgentsMdDirs = accesses.flatMap((access) => {
      if (access.kind !== 'file' || access.workspaceRoot === true || basename(access.path).toLowerCase() !== 'agents.md') return [];
      if (access.operation !== 'write' && access.operation !== 'readwrite') return [];
      const directory = dirname(access.path);
      return [basename(directory).toLowerCase() === '.kiki' ? dirname(directory) : directory];
    });
    if (mutatedAgentsMdDirs.length > 0) {
      const lease = this.acquire(stringArg(ctx.args, 'host'));
      try {
        for (const directory of mutatedAgentsMdDirs) this.discovery.invalidate(lease.runtime, directory);
        this.loaded.clear();
      } finally { lease.dispose(); }
    }
    let missing = await this.discoverFor(accesses, ctx.args);
    if (ctx.toolCall.name === 'Bash') {
      const lease = this.acquire(stringArg(ctx.args, 'host'));
      try {
        const env = lease.runtime.environment;
        const shellPath = (path: string) => env.pathClass === 'win32' ? translateShellDrivePath(path) : path;
        const agentWorkDir = inspectAgentWorkspaceRoots(this.runtime, {
          workDir: this.sessionContext.cwd,
          additionalDirs: [],
        }).workDir;
        const rawCwd = shellPath(stringArg(ctx.args, 'cwd') ?? agentWorkDir);
        const cwd = isAbsolute(rawCwd) ? rawCwd : join(agentWorkDir, rawCwd);
        const command = stringArg(ctx.args, 'command') ?? '';
        let parsed = this.bashParser.parse(command, { timeoutMs: 500, maxNodes: 10_000 });
        if (!parsed.ok && command.length <= 512) parsed = this.bashParser.parse(command, { timeoutMs: Number.POSITIVE_INFINITY, maxNodes: 10_000 });
        const dirs = parsed.ok && !parsed.hasError ? extractBashTargetDirs(parsed.root, cwd, env.homeDir) : [];
        if (stringArg(ctx.args, 'cwd') !== undefined && !dirs.includes(cwd)) dirs.unshift(cwd);
        const paths = [...new Set((await Promise.all(dirs.map((dir) => this.discoverDir(lease, shellPath(dir))))).flat())];
        const loaded = await Promise.all(paths.map((path) => this.load(lease, path)));
        missing = [...missing, ...this.classifyChains(preferredInstructions(loaded)).map((action) => action.item)];
      } finally { lease.dispose(); }
    }
    this.queue(missing);
    const untracked = missing.filter((item) => !this.telemetryFired.has(instructionKey(item.file, item.pathClass)));
    if (untracked.length > 0) {
      const properties: AgentsMdReminderShownEvent = { turn_id: ctx.turnId, tool_name: ctx.toolCall.name, reminded_count: untracked.length, trace_id: ctx.trace?.traceId };
      this.telemetry.track2('agents_md_reminder_shown', properties);
      for (const item of untracked) this.telemetryFired.add(instructionKey(item.file, item.pathClass));
    }
  }
}

function preferredInstructions(items: readonly (PendingInstruction | undefined)[]): PendingInstruction[] {
  const selected = new Map<string, PendingInstruction>();
  for (const item of items) {
    if (item === undefined) continue;
    const directory = normalize(dirname(item.sourcePath));
    const key = `${item.file.runtimeId}:${item.pathClass === 'win32' ? directory.toLowerCase() : directory}`;
    if (!selected.has(key)) selected.set(key, item);
  }
  return [...selected.values()];
}

function stripTrailingSlash(path: string): string {
  if (path === '/' || /^[a-zA-Z]:\/$/u.test(path)) return path;
  return path.replace(/\/+$/u, '');
}

function matchAdmittedRoot(
  target: string,
  roots: readonly string[],
  pathClass: 'posix' | 'win32',
): string | undefined {
  const normTarget = pathClass === 'win32' ? target.toLowerCase() : target;
  let best: string | undefined;
  for (const root of roots) {
    const normRoot = pathClass === 'win32' ? root.toLowerCase() : root;
    const prefix = normRoot.endsWith('/') ? normRoot : `${normRoot}/`;
    if (normTarget === normRoot || normTarget.startsWith(prefix)) {
      if (best === undefined || root.length > best.length) best = root;
    }
  }
  return best;
}

function isSharedSystemDirectory(dir: string, pathClass: 'posix' | 'win32'): boolean {
  const normalized = stripTrailingSlash(normalize(dir));
  const localTmp = stripTrailingSlash(normalize(tmpdir()));
  if (pathClass === 'win32') {
    const lower = normalized.toLowerCase();
    if (/^[a-z]:\/?$/u.test(lower)) return true;
    const sharedWin = new Set([
      localTmp.toLowerCase(),
      'c:/windows',
      'c:/windows/temp',
      'c:/temp',
      'c:/tmp',
      'c:/users/public',
    ]);
    return sharedWin.has(lower);
  }
  if (process.platform === 'win32' && normalized.toLowerCase() === localTmp.toLowerCase()) {
    return true;
  }
  const sharedPosix = new Set([
    '/',
    '/tmp',
    '/var/tmp',
    '/private/tmp',
    '/dev/shm',
    '/Users/Shared',
    '/var',
    '/usr',
    '/etc',
    localTmp,
  ]);
  return sharedPosix.has(normalized);
}

function isTrustedExternalStat(
  info: { readonly mode?: number; readonly uid?: number },
  runtimeId: string,
  environment: { readonly pathClass: 'posix' | 'win32'; readonly osKind?: string },
): boolean {
  if (environment.pathClass !== 'posix') return true;
  if (
    runtimeId === 'local' &&
    process.platform === 'win32' &&
    environment.osKind !== 'linux' &&
    environment.osKind !== 'darwin'
  ) {
    return true;
  }
  if (info.mode !== undefined && (info.mode & 0o002) !== 0) return false;
  if (runtimeId === 'local' && typeof process.getuid === 'function') {
    const currentUid = process.getuid();
    if (info.uid !== undefined && info.uid !== currentUid) return false;
  }
  return true;
}

function stringArg(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

registerScopedService(LifecycleScope.Agent, IAgentAgentsMdReminderService, AgentAgentsMdReminderService, ScopeActivation.OnScopeCreated, 'agentsMdReminder');
