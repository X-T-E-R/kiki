import { Disposable } from '#/_base/di/lifecycle';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentStateService } from '#/agent/state/agentState';
import { acquireToolRuntime, prepareToolRuntime, resolveSshToolTarget } from '#/agent/tools/os/sshToolTarget';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type {
  BeforeToolExecuteEvent,
  ToolDidExecuteContext,
} from '#/agent/toolExecutor/toolHooks';
import type { ToolCall } from '#/kosong/contract/message';
import type { HostFileStat } from '#/os/interface/hostFileSystem';
import type { Runtime } from '#/runtime/runtime';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { ExecutableToolResult, ToolAccesses, ToolFileAccessOperation } from '#/tool/toolContract';

import { IStaleGuardService } from './staleGuard';
import { StaleGuardCleared, StaleGuardRecorded, staleGuardKey, staleGuardStateMapKey } from './staleGuardOps';

const WRITE_OPERATIONS: readonly ToolFileAccessOperation[] = ['write', 'readwrite'];
const READ_OPERATIONS: readonly ToolFileAccessOperation[] = ['read'];

type Knowledge = 'current' | 'unread' | 'changed';

interface WriteCheck {
  readonly path: string;
  readonly displayPath: string;
  readonly runtimeId: string;
  readonly knowledge: Knowledge;
}

interface ToolTarget {
  readonly host?: string;
  readonly path: string;
}

function accessedFilePath(
  accesses: ToolAccesses | undefined,
  operations: readonly ToolFileAccessOperation[],
): string | undefined {
  for (const access of accesses ?? []) {
    if (access.kind === 'file' && operations.includes(access.operation)) return access.path;
  }
  return undefined;
}

function stringArg(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function targetFromArgs(args: unknown, fallbackPath: string): ToolTarget {
  try {
    const target = resolveSshToolTarget(stringArg(args, 'host'), stringArg(args, 'path') ?? fallbackPath);
    return { host: target.host, path: target.path ?? fallbackPath };
  } catch {
    return { path: fallbackPath };
  }
}

function targetFromCall(call: ToolCall): ToolTarget | undefined {
  if (typeof call.arguments !== 'string') return undefined;
  try {
    const args: unknown = JSON.parse(call.arguments);
    const path = stringArg(args, 'path');
    return path === undefined ? undefined : targetFromArgs(args, path);
  } catch {
    return undefined;
  }
}

function samePath(left: string, right: string, runtime: Runtime | undefined): boolean {
  const normalize = (path: string) => path.replaceAll('\\', '/');
  const a = normalize(left);
  const b = normalize(right);
  return runtime?.environment.pathClass === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function recordedMtime(recorded: number | { readonly mtimeMs: number; readonly size?: number }): number {
  return typeof recorded === 'number' ? recorded : recorded.mtimeMs;
}

function sameFileState(
  recorded: number | { readonly mtimeMs: number; readonly size?: number },
  stat: HostFileStat,
): boolean {
  if (recordedMtime(recorded) !== stat.mtimeMs) return false;
  return typeof recorded === 'number' || recorded.size === undefined || stat.size === undefined || recorded.size === stat.size;
}

function overwriteVeto(knowledge: Knowledge, displayPath: string): string | undefined {
  if (knowledge === 'unread') {
    return (
      `"${displayPath}" already exists and has not been read by this agent, so Write would replace content you have not seen. ` +
      'Read it first, or use Edit to change part of it.'
    );
  }
  if (knowledge === 'changed') {
    return (
      `"${displayPath}" has been modified on disk since this agent last read it, so Write would replace content you have not seen. ` +
      'Read it again first, or use Edit to change part of it.'
    );
  }
  return undefined;
}

function editNote(check: WriteCheck): string | undefined {
  if (check.knowledge === 'unread') {
    return `Note: you had not read ${check.displayPath}; the edit was applied because the text it replaced matched the file exactly.`;
  }
  if (check.knowledge === 'changed') {
    return `Note: ${check.displayPath} changed on disk since you last read it; the edit was applied because the text it replaced still matched exactly.`;
  }
  return undefined;
}

function withNote(result: ExecutableToolResult, note: string): ExecutableToolResult {
  return { ...result, note: result.note === undefined || result.note === '' ? note : `${result.note}\n${note}` };
}

export class StaleGuardService extends Disposable implements IStaleGuardService {
  declare readonly _serviceBrand: undefined;

  private readonly writeChecks = new WeakMap<ToolCall, WriteCheck>();

  constructor(
    @IAgentStateService private readonly states: IAgentStateService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
  ) {
    super();
    this.states.contributeState(staleGuardKey);
    this._register(toolExecutor.onBeforeExecuteTool((event) => this.guardWrite(event)));
    this._register(
      toolExecutor.hooks.onDidExecuteTool.register('staleGuard', async (ctx, next) => {
        await this.observeExecution(ctx);
        await next();
      }),
    );
    this._register(
      this.runtime.onDidChange(() => {
        void this.dispatcher.dispatch(new StaleGuardCleared({}));
      }),
    );
  }

  recordedMtimeMs(path: string, runtimeId = 'local'): number | undefined {
    const recorded = this.states.get(staleGuardKey).get(staleGuardStateMapKey(path, runtimeId));
    return recorded === undefined ? undefined : recordedMtime(recorded);
  }

  private runtimeIdForHost(host: string | undefined, inspected?: Runtime): string {
    if (inspected !== undefined) return inspected.identity.runtimeId;
    if (host === 'local') return 'local';
    if (host !== undefined) return `ssh:${host}`;
    try {
      return this.runtime.inspect().identity.runtimeId;
    } catch {
      return 'local';
    }
  }

  private guardWrite(event: BeforeToolExecuteEvent): void {
    const name = event.toolCall.name;
    if (name !== 'Edit' && name !== 'Write') return;
    const path = accessedFilePath(event.execution.accesses, WRITE_OPERATIONS);
    if (path === undefined) return;
    const displayPath = stringArg(event.args, 'path') ?? path;
    const target = targetFromArgs(event.args, path);
    const overwrite = name === 'Write' && stringArg(event.args, 'mode') !== 'append';
    event.waitUntil(async () => {
      let inspected: Runtime | undefined;
      try {
        inspected = await prepareToolRuntime(this.runtime, target.host);
      } catch {
        inspected = undefined;
      }
      const runtimeId = this.runtimeIdForHost(target.host, inspected);
      const knowledge = this.knowledgeFromBatch(event, target, path, runtimeId, inspected) ??
        await this.knowledgeOnDisk(path, target.host, inspected);
      this.writeChecks.set(event.toolCall, { path, displayPath, runtimeId, knowledge });
      const veto = overwrite ? overwriteVeto(knowledge, displayPath) : undefined;
      return veto === undefined ? undefined : { veto: denyToolExecution(veto) };
    });
  }

  private knowledgeFromBatch(
    event: BeforeToolExecuteEvent,
    target: ToolTarget,
    path: string,
    runtimeId: string,
    inspected: Runtime | undefined,
  ): Knowledge | undefined {
    let knowledge: Knowledge | undefined;
    for (const call of event.toolCalls) {
      if (call.id === event.toolCall.id) break;
      const earlierTarget = targetFromCall(call);
      if (call.name === 'Read' && earlierTarget !== undefined &&
          this.runtimeIdForHost(earlierTarget.host) === runtimeId &&
          samePath(earlierTarget.path, target.path, inspected)) {
        knowledge = 'current';
        continue;
      }
      const earlier = call.name === 'Edit' || call.name === 'Write' ? this.writeChecks.get(call) : undefined;
      if (earlier?.runtimeId === runtimeId && samePath(earlier.path, path, inspected)) knowledge = earlier.knowledge;
    }
    return knowledge;
  }

  private async observeExecution(ctx: ToolDidExecuteContext): Promise<void> {
    if (ctx.outcome !== 'executed' || ctx.result.isError === true) return;
    const name = ctx.toolCall.name;
    if (name === 'Read') {
      const path = accessedFilePath(ctx.accesses, READ_OPERATIONS);
      if (path !== undefined) await this.recordCurrentMtime(path, ctx.args);
      return;
    }
    if (name !== 'Edit' && name !== 'Write') return;
    const path = accessedFilePath(ctx.accesses, WRITE_OPERATIONS);
    if (path === undefined) return;
    const check = this.writeChecks.get(ctx.toolCall);
    if (check === undefined || check.knowledge === 'current') {
      await this.recordCurrentMtime(path, ctx.args);
      return;
    }
    const note = name === 'Edit' ? editNote(check) : undefined;
    if (note !== undefined) ctx.result = withNote(ctx.result, note);
  }

  private async knowledgeOnDisk(path: string, host?: string, inspected?: Runtime): Promise<Knowledge> {
    const file = await this.statFile(path, host, inspected);
    if (file === undefined || file.stat.mtimeMs === undefined) return 'current';
    const recorded = this.states.get(staleGuardKey).get(staleGuardStateMapKey(path, file.runtimeId));
    if (recorded === undefined) return 'unread';
    return sameFileState(recorded, file.stat) ? 'current' : 'changed';
  }

  private async recordCurrentMtime(path: string, args: unknown): Promise<void> {
    const target = targetFromArgs(args, path);
    const file = await this.statFile(path, target.host);
    if (file?.stat.mtimeMs === undefined) return;
    const recorded = this.states.get(staleGuardKey).get(staleGuardStateMapKey(path, file.runtimeId));
    if (recorded !== undefined && sameFileState(recorded, file.stat)) return;
    await this.dispatcher.dispatch(new StaleGuardRecorded({
      path,
      mtimeMs: file.stat.mtimeMs,
      size: file.stat.size,
      runtimeId: file.runtimeId === 'local' ? undefined : file.runtimeId,
    }));
  }

  private async statFile(path: string, host?: string, inspected?: Runtime): Promise<{ readonly stat: HostFileStat; readonly runtimeId: string } | undefined> {
    let lease: ReturnType<typeof acquireToolRuntime> | undefined;
    try {
      const prepared = inspected ?? await prepareToolRuntime(this.runtime, host);
      lease = acquireToolRuntime(this.runtime, host, ['fs']);
      if (lease.runtime.identity.runtimeId !== prepared.identity.runtimeId ||
          lease.runtime.identity.generation !== prepared.identity.generation) return undefined;
      const stat = await lease.runtime.fs!.stat(path);
      return stat.isFile ? { stat, runtimeId: lease.runtime.identity.runtimeId } : undefined;
    } catch {
      return undefined;
    } finally {
      lease?.dispose();
    }
  }
}
