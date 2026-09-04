import { basename, dirname, isAbsolute, join, normalize } from 'pathe';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { IBashParserService } from '#/app/bashParser/bashParser';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventBus } from '#/app/event/eventBus';
import type { AgentsMdReminderShownEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import {
  ContextApplyCompaction,
  ContextClear,
} from '#/agent/contextMemory/contextEvents';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ContextUndone } from '#/agent/undo/undoService';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { normalizeUserPath } from '#/tool/path-access';
import {
  AGENTS_MD_PLAIN_NAMES,
  extractAgentsMdPathsFromSystemPrompt,
  loadAgentsMdDetailed,
} from '#/agent/profile/context';
import { profileKey } from '#/agent/profile/profileOps';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { ToolDidExecuteContext } from '#/agent/toolExecutor/toolHooks';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { IAgentAgentsMdReminderService } from './agentsMdReminder';
import { IAgentsMdDiscoveryService } from './agentsMdDiscoveryService';
import { extractBashTargetDirs } from './bashTargets';

const AGENTS_MD_BASENAMES: ReadonlySet<string> = new Set<string>(AGENTS_MD_PLAIN_NAMES);

const BASH_PARSE_OPTIONS = { timeoutMs: 500, maxNodes: 10_000 } as const;
const BASH_SHORT_RETRY_OPTIONS = {
  timeoutMs: Number.POSITIVE_INFINITY,
  maxNodes: BASH_PARSE_OPTIONS.maxNodes,
} as const;
const BASH_SHORT_RETRY_MAX_CHARS = 512;

export const agentsMdReminderKnownKey = defineState<Set<string>>(
  'agentsMdReminder.known',
  () => new Set(),
);
export const agentsMdReminderCwdKey = defineState<string | undefined>(
  'agentsMdReminder.cwd',
  () => undefined as string | undefined,
);
export const agentsMdReminderSeededKey = defineState<boolean>(
  'agentsMdReminder.seeded',
  () => false,
);

export class AgentAgentsMdReminderService
  extends Disposable
  implements IAgentAgentsMdReminderService
{
  declare readonly _serviceBrand: undefined;

  private readonly remindQueue = new Set<string>();
  private readonly reminded = new Set<string>();
  private readonly readRecently = new Set<string>();
  private readonly claimed = new Set<string>();
  private readonly telemetryFired = new Set<string>();

  constructor(
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IEventBus eventBus: IEventBus,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IAgentStateService private readonly states: IAgentStateService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @IAgentsMdDiscoveryService private readonly discovery: IAgentsMdDiscoveryService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IBashParserService private readonly bashParser: IBashParserService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentStateService private readonly agentState: IAgentStateService,
  ) {
    super();
    this.states.contributeState(agentsMdReminderKnownKey);
    this.states.contributeState(agentsMdReminderCwdKey);
    this.states.contributeState(agentsMdReminderSeededKey);
    this._register(
      this.dispatcher.hooks.onDidRestore.register('agentsMdReminder', async (_ctx, next) => {
        const profile = this.agentState.get(profileKey);
        const paths =
          profile.agentsMdPaths ?? extractAgentsMdPathsFromSystemPrompt(profile.systemPrompt);
        this.seedInjected(paths, this.sessionContext.cwd);
        await next();
      }),
    );
    this._register(eventBus.subscribe(ContextApplyCompaction, () => this.reminded.clear()));
    this._register(eventBus.subscribe(ContextClear, () => this.reminded.clear()));
    this._register(eventBus.subscribe(ContextUndone, () => this.reminded.clear()));
    const handler = async (ctx: ToolDidExecuteContext, next: () => Promise<void>): Promise<void> => {
      await this.probeAndRemind(ctx);
      await next();
    };
    this._register(toolExecutor.hooks.onDidExecuteTool.register('agentsMdReminder', handler));
  }

  seedInjected(paths: readonly string[], cwd: string): void {
    const known = this.states.get(agentsMdReminderKnownKey);
    for (const path of paths) known.add(normalize(path));
    this.states.set(agentsMdReminderKnownKey, new Set(known));
    this.states.set(agentsMdReminderCwdKey, cwd);
    this.states.set(agentsMdReminderSeededKey, true);
  }

  private get known(): Set<string> {
    return this.states.get(agentsMdReminderKnownKey);
  }

  async flushStepHead(): Promise<void> {
    const readRecently = new Set(this.readRecently);
    this.readRecently.clear();
    const queued = [...this.remindQueue].filter(
      (path) => !this.known.has(path) && !this.reminded.has(path) && !readRecently.has(path),
    );
    this.remindQueue.clear();
    if (queued.length === 0) return;
    const lease = this.runtime.acquire(['fs']);
    const paths: string[] = [];
    try {
      for (const path of queued) {
        try {
          const stat = await lease.runtime.fs!.stat(path);
          if (stat.isFile && stat.size > 0) paths.push(path);
        } catch {}
      }
    } finally {
      lease.dispose();
    }
    if (paths.length === 0) return;
    this.reminders.appendSystemReminder(reminderText(paths), {
      kind: 'injection',
      variant: 'agents_md',
    });
    for (const path of paths) this.reminded.add(path);
  }

  private get agentCwd(): string {
    return this.states.get(agentsMdReminderCwdKey) ?? this.sessionContext.cwd;
  }

  private async ensureSeeded(): Promise<void> {
    if (this.states.get(agentsMdReminderSeededKey)) return;
    const lease = this.runtime.acquire(['fs']);
    try {
      const { paths } = await loadAgentsMdDetailed(
        { fs: lease.runtime.fs!, homeDir: lease.runtime.environment.homeDir },
        this.agentCwd,
        this.bootstrap.homeDir,
      );
      this.seedInjected(paths, this.agentCwd);
    } finally {
      lease.dispose();
    }
  }

  private async probeAndRemind(ctx: ToolDidExecuteContext): Promise<void> {
    if (ctx.outcome !== 'executed') return;
    const discovered: string[] = [];
    try {
      this.invalidateWrittenInstruction(ctx);
      await this.ensureSeeded();
      const { dirs, selfKnown } = this.targetDirs(ctx);
      const selfKnownSet = new Set(selfKnown);
      for (const dir of dirs) {
        for (const path of await this.probeDir(dir)) {
          if (
            this.known.has(path) ||
            this.reminded.has(path) ||
            this.remindQueue.has(path) ||
            this.claimed.has(path) ||
            selfKnownSet.has(path)
          ) {
            continue;
          }
          this.claimed.add(path);
          discovered.push(path);
        }
      }
      for (const path of selfKnown) {
        this.remindQueue.delete(path);
        this.readRecently.add(path);
      }
      if (discovered.length === 0) return;
      const untracked = discovered.filter((path) => !this.telemetryFired.has(path));
      if (untracked.length > 0) {
        const properties: AgentsMdReminderShownEvent = {
          turn_id: ctx.turnId,
          tool_name: ctx.toolCall.name,
          reminded_count: untracked.length,
          trace_id: ctx.trace?.traceId,
        };
        this.telemetry.track2('agents_md_reminder_shown', properties);
        for (const path of untracked) this.telemetryFired.add(path);
      }
      for (const path of discovered) this.remindQueue.add(path);
    } catch {} finally {
      for (const path of discovered) this.claimed.delete(path);
    }
  }

  private targetDirs(ctx: ToolDidExecuteContext): { dirs: string[]; selfKnown: string[] } {
    const selfKnown: string[] = [];
    const lease = this.runtime.acquire();
    const env = lease.runtime.environment;
    lease.dispose();
    switch (ctx.toolCall.name) {
      case 'Read':
      case 'Edit':
      case 'Write':
      case 'Glob':
      case 'Grep':
        return this.targetDirsFromAccesses(ctx);
      case 'Bash': {
        const args = ctx.args;
        const command = stringArg(args, 'command');
        if (command === undefined) return { dirs: [], selfKnown };
        const cwdArg = stringArg(args, 'cwd');
        const base = hostPath(this.sessionContext.cwd, env.pathClass);
        const normalizedCwdArg =
          cwdArg === undefined ? undefined : normalizeUserPath(cwdArg, env.pathClass);
        const effectiveCwd =
          normalizedCwdArg === undefined
            ? base
            : normalize(
                isAbsolute(normalizedCwdArg)
                  ? normalizedCwdArg
                  : join(base, normalizedCwdArg),
              );
        let parsed = this.bashParser.parse(command, BASH_PARSE_OPTIONS);
        if (!parsed.ok && command.length <= BASH_SHORT_RETRY_MAX_CHARS) {
          parsed = this.bashParser.parse(command, BASH_SHORT_RETRY_OPTIONS);
        }
        if (!parsed.ok || parsed.hasError) {
          return normalizedCwdArg === undefined
            ? { dirs: [], selfKnown }
            : { dirs: [effectiveCwd], selfKnown };
        }
        const targets = extractBashTargetDirs(
          parsed.root,
          effectiveCwd,
          env.homeDir,
        ).map((target) => hostPath(target, env.pathClass));
        if (normalizedCwdArg !== undefined && !targets.includes(effectiveCwd)) {
          targets.unshift(effectiveCwd);
        }
        return { dirs: targets, selfKnown };
      }
      default:
        return { dirs: [], selfKnown };
    }
  }

  private targetDirsFromAccesses(ctx: ToolDidExecuteContext): {
    dirs: string[];
    selfKnown: string[];
  } {
    const dirs: string[] = [];
    const selfKnown: string[] = [];
    const targetsFiles =
      ctx.toolCall.name === 'Read' ||
      ctx.toolCall.name === 'Edit' ||
      ctx.toolCall.name === 'Write';
    for (const access of ctx.accesses ?? []) {
      if (access.kind !== 'file') continue;
      if (
        targetsFiles &&
        ctx.result.isError !== true &&
        AGENTS_MD_BASENAMES.has(basename(access.path))
      ) {
        selfKnown.push(access.path);
      }
      dirs.push(targetsFiles ? dirname(access.path) : access.path);
    }
    return { dirs: [...new Set(dirs)], selfKnown: [...new Set(selfKnown)] };
  }

  private invalidateWrittenInstruction(ctx: ToolDidExecuteContext): void {
    if (
      ctx.result.isError === true ||
      (ctx.toolCall.name !== 'Edit' && ctx.toolCall.name !== 'Write')
    ) {
      return;
    }
    const lease = this.runtime.acquire();
    try {
      const pathClass = lease.runtime.environment.pathClass;
      for (const access of ctx.accesses ?? []) {
        if (
          access.kind !== 'file' ||
          (access.operation !== 'write' && access.operation !== 'readwrite')
        ) {
          continue;
        }
        const directory = instructionProbeDirectory(access.path, pathClass);
        if (directory !== undefined) this.discovery.invalidate(lease.runtime, directory);
      }
    } finally {
      lease.dispose();
    }
  }

  private async probeDir(dir: string): Promise<string[]> {
    const lease = this.runtime.acquire(['fs']);
    try {
      return [...(await this.discovery.discover(lease, dir))];
    } finally {
      lease.dispose();
    }
  }
}

function hostPath(path: string, pathClass: 'posix' | 'win32'): string {
  return normalize(normalizeUserPath(path, pathClass));
}

function instructionProbeDirectory(
  path: string,
  pathClass: 'posix' | 'win32',
): string | undefined {
  const normalized = normalize(path);
  const name = basename(normalized);
  const comparableName = pathClass === 'win32' ? name.toLowerCase() : name;
  if (
    !AGENTS_MD_PLAIN_NAMES.some((candidate) =>
      pathClass === 'win32'
        ? candidate.toLowerCase() === comparableName
        : candidate === comparableName,
    )
  ) {
    return undefined;
  }
  const parent = dirname(normalized);
  const parentName = basename(parent);
  const isDotKimi =
    pathClass === 'win32'
      ? parentName.toLowerCase() === '.kimi-code'
      : parentName === '.kimi-code';
  return isDotKimi ? dirname(parent) : parent;
}

function stringArg(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function reminderText(paths: readonly string[]): string {
  return (
    'The following AGENTS.md file(s) apply to paths accessed by your recent tool call, but were not included in your system prompt:\n' +
    paths.map((path) => `- ${path}`).join('\n') +
    '\nRead them before making changes in those directories.'
  );
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentAgentsMdReminderService,
  AgentAgentsMdReminderService,
  ScopeActivation.OnScopeCreated,
  'agentsMdReminder',
);
