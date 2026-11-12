import { Disposable } from '#/_base/di/lifecycle';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type {
  BeforeToolExecuteEvent,
  ToolDidExecuteContext,
} from '#/agent/toolExecutor/toolHooks';
import type { ToolCall } from '#/kosong/contract/message';
import type { HostFileStat } from '#/os/interface/hostFileSystem';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { ExecutableToolResult, ToolAccesses, ToolFileAccessOperation } from '#/tool/toolContract';

import { IStaleGuardService } from './staleGuard';
import { StaleGuardCleared, StaleGuardRecorded, staleGuardKey } from './staleGuardOps';

const WRITE_OPERATIONS: readonly ToolFileAccessOperation[] = ['write', 'readwrite'];
const READ_OPERATIONS: readonly ToolFileAccessOperation[] = ['read'];

type Knowledge = 'current' | 'unread' | 'changed';

interface WriteCheck {
  readonly path: string;
  readonly displayPath: string;
  readonly knowledge: Knowledge;
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

function callPathArg(call: ToolCall): string | undefined {
  if (typeof call.arguments !== 'string') return undefined;
  try {
    return stringArg(JSON.parse(call.arguments), 'path');
  } catch {
    return undefined;
  }
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

  recordedMtimeMs(path: string): number | undefined {
    return this.states.get(staleGuardKey).get(path);
  }

  private guardWrite(event: BeforeToolExecuteEvent): void {
    const name = event.toolCall.name;
    if (name !== 'Edit' && name !== 'Write') return;
    const path = accessedFilePath(event.execution.accesses, WRITE_OPERATIONS);
    if (path === undefined) return;
    const displayPath = stringArg(event.args, 'path') ?? path;
    const overwrite = name === 'Write' && stringArg(event.args, 'mode') !== 'append';
    event.waitUntil(async () => {
      const knowledge = this.knowledgeFromBatch(event, displayPath, path) ?? await this.knowledgeOnDisk(path);
      this.writeChecks.set(event.toolCall, { path, displayPath, knowledge });
      const veto = overwrite ? overwriteVeto(knowledge, displayPath) : undefined;
      return veto === undefined ? undefined : { veto: denyToolExecution(veto) };
    });
  }

  private knowledgeFromBatch(event: BeforeToolExecuteEvent, displayPath: string, path: string): Knowledge | undefined {
    let knowledge: Knowledge | undefined;
    for (const call of event.toolCalls) {
      if (call.id === event.toolCall.id) break;
      if (call.name === 'Read' && callPathArg(call) === displayPath) {
        knowledge = 'current';
        continue;
      }
      const earlier = call.name === 'Edit' || call.name === 'Write' ? this.writeChecks.get(call) : undefined;
      if (earlier?.path === path) knowledge = earlier.knowledge;
    }
    return knowledge;
  }

  private async observeExecution(ctx: ToolDidExecuteContext): Promise<void> {
    if (ctx.outcome !== 'executed' || ctx.result.isError === true) return;
    const name = ctx.toolCall.name;
    if (name === 'Read') {
      const path = accessedFilePath(ctx.accesses, READ_OPERATIONS);
      if (path !== undefined) await this.recordCurrentMtime(path);
      return;
    }
    if (name !== 'Edit' && name !== 'Write') return;
    const path = accessedFilePath(ctx.accesses, WRITE_OPERATIONS);
    if (path === undefined) return;
    const check = this.writeChecks.get(ctx.toolCall);
    if (check === undefined || check.knowledge === 'current') {
      await this.recordCurrentMtime(path);
      return;
    }
    const note = name === 'Edit' ? editNote(check) : undefined;
    if (note !== undefined) ctx.result = withNote(ctx.result, note);
  }

  private async knowledgeOnDisk(path: string): Promise<Knowledge> {
    const stat = await this.statFile(path);
    if (stat === undefined || stat.mtimeMs === undefined) return 'current';
    const recorded = this.recordedMtimeMs(path);
    if (recorded === undefined) return 'unread';
    return recorded === stat.mtimeMs ? 'current' : 'changed';
  }

  private async recordCurrentMtime(path: string): Promise<void> {
    const stat = await this.statFile(path);
    if (stat?.mtimeMs === undefined || this.recordedMtimeMs(path) === stat.mtimeMs) return;
    await this.dispatcher.dispatch(new StaleGuardRecorded({ path, mtimeMs: stat.mtimeMs }));
  }

  private async statFile(path: string): Promise<HostFileStat | undefined> {
    const lease = this.runtime.acquire(['fs']);
    try {
      const stat = await lease.runtime.fs!.stat(path);
      return stat.isFile ? stat : undefined;
    } catch {
      return undefined;
    } finally {
      lease.dispose();
    }
  }
}
