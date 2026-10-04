import { basename, dirname, isAbsolute, join, normalize } from 'pathe';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { IBashParserService } from '#/app/bashParser/bashParser';
import { IEventBus } from '#/app/event/eventBus';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { AgentsMdReminderShownEvent } from '#/app/telemetry/events';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { translateShellDrivePath } from '#/_base/execEnv/shellPathBridge';
import { profileKey } from '#/agent/profile/profileOps';
import { dynamicPromptKey } from '#/agent/profile/dynamicPrompt';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { BeforeToolExecuteEvent, ToolDidExecuteContext } from '#/agent/toolExecutor/toolHooks';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { RuntimeLease } from '#/runtime/runtime';
import { IAgentAgentsMdReminderService } from './agentsMdReminder';
import { IAgentsMdDiscoveryService } from './agentsMdDiscoveryService';
import { extractBashTargetDirs } from './bashTargets';
import { coveredInstructions, instructionKey, instructionVersion, type InstructionFile } from './instructionCoverage';

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
  private readonly telemetryFired = new Set<string>();
  private readonly loaded = new Map<string, { item: PendingInstruction; mtimeMs: number; size: number }>();

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
      this.pending.clear();
      await next();
    }));
    this._register(toolExecutor.onWillExecuteTool((event) => {
      if (!event.execution.accesses?.some((access) => access.kind === 'file' && (access.operation === 'write' || access.operation === 'readwrite'))) return;
      event.waitUntil((async () => {
        const missing = await this.discoverFor(event.execution.accesses ?? [], event.args);
        if (missing.length === 0) return;
        this.queue(missing);
        event.veto({ isError: true, output: 'No files were changed. Applicable directory instructions have not yet been disclosed in this context. The host will disclose them before the next step; review them and retry this operation.' });
      })());
    }));
    this._register(toolExecutor.hooks.onDidExecuteTool.register('agentsMdReminder', async (ctx, next) => {
      try { await this.afterTool(ctx); } catch {}
      await next();
    }));
  }

  seedInjected(paths: readonly string[], cwd: string): void {
    this.states.set(agentsMdReminderKnownKey, new Set(paths.map(normalize)));
    this.states.set(agentsMdReminderCwdKey, cwd);
    this.states.set(agentsMdReminderSeededKey, true);
  }

  async flushStepHead(): Promise<void> {
    const missing: PendingInstruction[] = [];
    for (const item of this.pending.values()) {
      const lease = this.acquire(item.file.runtimeId.startsWith('ssh:') ? item.file.runtimeId.slice(4) : item.file.runtimeId === 'local' ? 'local' : undefined);
      try {
        const current = await this.load(lease, item.sourcePath);
        if (current !== undefined && !this.covered(current)) missing.push(current);
      } finally { lease.dispose(); }
    }
    if (missing.length === 0) { this.pending.clear(); return; }
    this.reminders.appendSystemReminder(`Applicable directory instructions (complete current versions; apply within each stated directory scope):\n\n${missing.map((item) => `<!-- From: ${item.sourcePath} -->\nHost: ${item.file.runtimeId}; scope: ${item.file.scope}\n${item.content}`).join('\n\n')}`, {
      kind: 'injection', variant: 'agents_md', disclosure: { mode: 'add', files: missing.map((item) => item.file) },
    });
    this.pending.clear();
  }

  private acquire(host?: string): RuntimeLease {
    return this.runtime.acquireFor === undefined || host === undefined ? this.runtime.acquire(['fs']) : this.runtime.acquireFor(host, ['fs']);
  }

  private covered(item: PendingInstruction): boolean {
    const key = instructionKey(item.file, item.pathClass);
    if (coveredInstructions(this.context.get(), item.pathClass).has(`${key}:${item.file.version}`)) return true;
    const profile = this.states.get(profileKey);
    const files = this.states.get(dynamicPromptKey)?.context.agentsMdFiles ?? [];
    const trusted = files.some((file) => instructionKey(file, item.pathClass) === key && file.version === item.file.version) ||
      (item.file.runtimeId === this.runtime.inspect().identity.runtimeId &&
        (profile.agentsMdPaths ?? []).some((path) => instructionKey({ path, runtimeId: item.file.runtimeId, scope: item.file.scope }, item.pathClass) === key));
    return trusted && profile.systemPrompt.includes(`<!-- From: ${item.sourcePath} -->\n${item.content}`);
  }

  private queue(items: readonly PendingInstruction[]): void {
    for (const item of items) this.pending.set(instructionKey(item.file, item.pathClass), item);
  }

  private async load(lease: RuntimeLease, path: string): Promise<PendingInstruction | undefined> {
    try {
      const fs = lease.runtime.fs!;
      const stat = await fs.stat(path);
      if (!stat.isFile) return undefined;
      const key = `${lease.runtime.identity.runtimeId}:${lease.runtime.identity.generation}:${normalize(path)}`;
      const cached = this.loaded.get(key);
      if (stat.mtimeMs !== undefined && cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.item;
      const content = (await fs.readText(path, { errors: 'strict' })).trim();
      if (!content) return undefined;
      const canonical = await fs.realpath(path);
      const item: PendingInstruction = { content, sourcePath: path, pathClass: lease.runtime.environment.pathClass, file: { path: normalize(canonical),
        version: instructionVersion(content), scope: basename(dirname(path)).toLowerCase() === '.kiki' ? dirname(dirname(path)) : dirname(path),
        runtimeId: lease.runtime.identity.runtimeId } };
      if (stat.mtimeMs !== undefined) {
        if (this.loaded.size >= 64) this.loaded.delete(this.loaded.keys().next().value!);
        this.loaded.set(key, { item, mtimeMs: stat.mtimeMs, size: stat.size });
      }
      return item;
    } catch { return undefined; }
  }

  private async discoverDir(lease: RuntimeLease, directory: string): Promise<readonly string[]> {
    let target = normalize(directory);
    try { target = normalize(await lease.runtime.fs!.realpath(target)); } catch {}
    const pathClass = lease.runtime.environment.pathClass;
    const base = normalize(lease.runtime.workspace.mapRoots({ workDir: this.sessionContext.cwd, additionalDirs: [] }).workDir);
    const normalized = pathClass === 'win32' ? target.toLowerCase() : target;
    const root = pathClass === 'win32' ? base.toLowerCase() : base;
    return this.discovery.discover(lease, target, normalized === root || normalized.startsWith(`${root}/`) ? base : undefined);
  }

  private async discoverFor(accesses: readonly import('#/tool/toolContract').ToolResourceAccess[], args: unknown): Promise<PendingInstruction[]> {
    const host = stringArg(args, 'host');
    const lease = this.acquire(host);
    try {
      const dirs = [...new Set(accesses.flatMap((access) => access.kind === 'file' ? [access.operation === 'search' || access.recursive ? access.path : dirname(access.path)] : []))];
      const paths = [...new Set((await Promise.all(dirs.map((dir) => this.discoverDir(lease, dir)))).flat())];
      const loaded = await Promise.all(paths.map((path) => this.load(lease, path)));
      return loaded.filter((item): item is PendingInstruction => item !== undefined && !this.covered(item));
    } finally { lease.dispose(); }
  }

  private async afterTool(ctx: ToolDidExecuteContext): Promise<void> {
    if (ctx.outcome !== 'executed') return;
    const accesses = ctx.accesses ?? [];
    const lease = this.acquire(stringArg(ctx.args, 'host'));
    try {
      for (const access of accesses) {
        if (access.kind !== 'file' || basename(access.path).toLowerCase() !== 'agents.md') continue;
        if (access.operation === 'write' || access.operation === 'readwrite') {
          const directory = dirname(access.path);
          this.discovery.invalidate(lease.runtime, basename(directory).toLowerCase() === '.kiki' ? dirname(directory) : directory);
          this.loaded.clear();
        }
      }
    } finally { lease.dispose(); }
    let missing = await this.discoverFor(accesses, ctx.args);
    if (ctx.toolCall.name === 'Bash') {
      const lease = this.acquire(stringArg(ctx.args, 'host'));
      try {
        const env = lease.runtime.environment;
        const shellPath = (path: string) => env.pathClass === 'win32' ? translateShellDrivePath(path) : path;
        const rawCwd = shellPath(stringArg(ctx.args, 'cwd') ?? this.sessionContext.cwd);
        const cwd = isAbsolute(rawCwd) ? rawCwd : join(this.sessionContext.cwd, rawCwd);
        const command = stringArg(ctx.args, 'command') ?? '';
        let parsed = this.bashParser.parse(command, { timeoutMs: 500, maxNodes: 10_000 });
        if (!parsed.ok && command.length <= 512) parsed = this.bashParser.parse(command, { timeoutMs: Number.POSITIVE_INFINITY, maxNodes: 10_000 });
        const dirs = parsed.ok && !parsed.hasError ? extractBashTargetDirs(parsed.root, cwd, env.homeDir) : [];
        if (stringArg(ctx.args, 'cwd') !== undefined && !dirs.includes(cwd)) dirs.unshift(cwd);
        const paths = [...new Set((await Promise.all(dirs.map((dir) => this.discoverDir(lease, shellPath(dir))))).flat())];
        const loaded = await Promise.all(paths.map((path) => this.load(lease, path)));
        missing = [...missing, ...loaded.filter((item): item is PendingInstruction => item !== undefined && !this.covered(item))];
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

function stringArg(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

registerScopedService(LifecycleScope.Agent, IAgentAgentsMdReminderService, AgentAgentsMdReminderService, ScopeActivation.OnScopeCreated, 'agentsMdReminder');
