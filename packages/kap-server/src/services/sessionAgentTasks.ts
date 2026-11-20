import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import {
  IAgentLifecycleService, IAgentTaskService, IAtomicDocumentStore,
  IFileSystemStorageService, ISessionContext, ISessionMetadata,
  agentScopeOf, getLiveSessionById, sessionScopeOf, workspacePersistenceScope,
  type AgentTaskInfo, type Scope, type SessionSummary,
} from '@kiki/agent-core-v2';
import {
  agentTaskSummarySchema, taskReceiptSchema, agentRunSourceSchema,
  type AgentTaskSummary, type AgentTasksFailure, type ListAgentTasksQuery,
  type ListAgentTasksResponse,
} from '@kiki/protocol';
import { z } from 'zod';

const taskIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-z]{8}$/;
const safeSegment = (value: string): boolean => value !== '.' && value !== '..' && !/[/\\\0]/.test(value) && value.length > 0;
const DEFAULT_TASK_READ_CONCURRENCY = 16;
const TASK_READ_CONCURRENCY_ENV = 'KIKI_AGENT_TASKS_READ_CONCURRENCY';
const MAX_CURSOR_STATES = 1024;
const YIELD_EVERY = 64;

function resolveTaskReadConcurrency(): number {
  const raw = process.env[TASK_READ_CONCURRENCY_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_TASK_READ_CONCURRENCY;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 128 ? parsed : DEFAULT_TASK_READ_CONCURRENCY;
}

interface CursorFailureState {
  readonly failures: readonly AgentTasksFailure[];
  readonly failed: readonly string[];
}

const cursorKeys = new WeakMap<Scope, Buffer>();
const cursorStates = new WeakMap<Scope, Map<string, CursorFailureState>>();
const cursorSchema = z.object({
  version: z.literal(1), session: z.string(), scope: z.string(), inventory: z.string(),
  owner: z.number().int().nonnegative(), offset: z.number().int().nonnegative(),
  prefix: z.string().optional(), started_at: z.string().datetime(),
  state_id: z.string().min(1).max(64).optional(),
});
type Cursor = z.infer<typeof cursorSchema>;

export class AgentTasksPageTokenError extends Error {}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function cursorKey(core: Scope): Buffer {
  let key = cursorKeys.get(core);
  if (key === undefined) { key = randomBytes(32); cursorKeys.set(core, key); }
  return key;
}

function cursorStateStore(core: Scope): Map<string, CursorFailureState> {
  let store = cursorStates.get(core);
  if (store === undefined) {
    store = new Map();
    cursorStates.set(core, store);
  }
  return store;
}

function saveCursorState(core: Scope, state: CursorFailureState): string | undefined {
  if (state.failures.length === 0 && state.failed.length === 0) return undefined;
  const store = cursorStateStore(core);
  const stateId = randomBytes(16).toString('hex');
  if (store.size >= MAX_CURSOR_STATES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(stateId, {
    failures: [...state.failures],
    failed: [...state.failed],
  });
  return stateId;
}

function loadCursorState(core: Scope, stateId: string | undefined): CursorFailureState {
  if (stateId === undefined) return { failures: [], failed: [] };
  const store = cursorStateStore(core);
  const saved = store.get(stateId);
  if (saved === undefined) {
    throw new AgentTasksPageTokenError('Invalid or expired agent-tasks page_token; restart pagination');
  }
  store.delete(stateId);
  store.set(stateId, saved);
  return saved;
}

function encodeCursor(core: Scope, cursor: Cursor): string {
  const body = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  return `${body}.${createHmac('sha256', cursorKey(core)).update(body).digest('base64url')}`;
}

function decodeCursor(core: Scope, token: string): Cursor {
  try {
    const [body, signature, extra] = token.split('.');
    if (body === undefined || signature === undefined || extra !== undefined) throw new Error('Invalid page token');
    const expected = createHmac('sha256', cursorKey(core)).update(body).digest();
    const supplied = Buffer.from(signature, 'base64url');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new Error('Invalid page token');
    return cursorSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
  } catch { throw new AgentTasksPageTokenError('Invalid or expired agent-tasks page_token; restart pagination'); }
}

async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;
  let completed = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await fn(items[index]!);
        completed++;
        if (completed % YIELD_EVERY === 0) await yieldToEventLoop();
      }
    }),
  );
  return results;
}

const storedBaseSchema = z.object({
  taskId: z.string().regex(taskIdPattern), description: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'timed_out', 'killed', 'lost']),
  startedAt: z.number().min(0).max(8640000000000000),
  endedAt: z.number().min(0).max(8640000000000000).nullable(),
  detached: z.boolean().optional(), cleanupPending: z.boolean().optional(), stopReason: z.string().optional(), ownerAgentId: z.string().optional(),
  receipt: z.unknown().optional(), receiptVerification: z.enum(['verified', 'legacy_unverified', 'invalid']).optional(),
});
const storedTaskSchema = z.discriminatedUnion('kind', [
  storedBaseSchema.extend({ kind: z.literal('process'), command: z.string(), exitCode: z.number().int().nullable() }),
  storedBaseSchema.extend({ kind: z.literal('agent'), agentId: z.string().optional(), profile: z.string().optional(), subagentType: z.string().optional(), model: z.string().optional(), thinkingEffort: z.string().optional(), thinkingEffortExplicit: z.boolean().optional(), executorId: z.string().optional(), executorProtocol: z.string().optional(), parentToolCallId: z.string().optional(), sourceRef: agentRunSourceSchema.optional() }),
  storedBaseSchema.extend({ kind: z.literal('question') }),
  storedBaseSchema.extend({ kind: z.literal('media') }),
]);
const legacyTaskSchema = z.object({
  task_id: z.string().regex(taskIdPattern), description: z.string(), command: z.string(),
  status: z.enum(['running', 'awaiting_approval', 'completed', 'failed', 'killed', 'lost']),
  started_at: z.number(), ended_at: z.number().nullable(), exit_code: z.number().int().nullable(),
  timed_out: z.boolean().optional(), stop_reason: z.string().optional(),
  agent_id: z.string().optional(), subagent_type: z.string().optional(),
});

function storedTask(value: unknown, taskId: string): z.infer<typeof storedTaskSchema> {
  const legacy = legacyTaskSchema.safeParse(value);
  const input = legacy.success ? {
    taskId: legacy.data.task_id, description: legacy.data.description,
    status: legacy.data.status === 'awaiting_approval' ? 'running'
      : legacy.data.status === 'failed' && legacy.data.timed_out ? 'timed_out' : legacy.data.status,
    startedAt: legacy.data.started_at, endedAt: legacy.data.ended_at,
    stopReason: legacy.data.stop_reason, detached: true,
    kind: legacy.data.task_id.startsWith('agent-') ? 'agent' : 'process',
    command: legacy.data.command, exitCode: legacy.data.exit_code,
    agentId: legacy.data.agent_id, profile: legacy.data.subagent_type,
  } : value;
  const result = storedTaskSchema.parse(input);
  if (result.taskId !== taskId) throw new Error('Task metadata ID does not match its storage key');
  return result;
}

function toSummary(sessionId: string, ownerId: string, source: 'live' | 'persisted', info: z.infer<typeof storedTaskSchema>): AgentTaskSummary {
  const receipt = taskReceiptSchema.safeParse(info.receipt);
  const created = new Date(info.startedAt).toISOString();
  return agentTaskSummarySchema.parse({
    id: info.taskId, session_id: sessionId, owner_agent_id: ownerId, source,
    kind: info.kind === 'process' ? 'bash' : info.kind === 'agent' ? 'subagent' : 'tool',
    description: info.description,
    status: info.status === 'killed' ? 'cancelled'
      : info.status === 'timed_out' || info.status === 'lost' ? 'failed' : info.status,
    created_at: created, started_at: created,
    completed_at: info.endedAt === null ? undefined : new Date(info.endedAt).toISOString(),
    run_in_background: info.detached ?? true,
    cleanup_pending: info.cleanupPending,
    command: info.kind === 'process' ? info.command : undefined,
    exit_code: info.kind === 'process' ? info.exitCode : undefined,
    stop_reason: info.stopReason,
    agent_id: info.kind === 'agent' ? info.agentId : undefined,
    profile: info.kind === 'agent' ? info.profile ?? info.subagentType : undefined,
    model: info.kind === 'agent' ? info.model : undefined,
    thinking_effort: info.kind === 'agent' ? info.thinkingEffort : undefined,
    thinking_effort_explicit: info.kind === 'agent' ? info.thinkingEffortExplicit : undefined,
    executor_id: info.kind === 'agent' ? info.executorId : undefined,
    executor_protocol: info.kind === 'agent' ? info.executorProtocol : undefined,
    parent_tool_call_id: info.kind === 'agent' ? info.parentToolCallId : undefined,
    source_ref: info.kind === 'agent' ? info.sourceRef : undefined,
    receipt: receipt.success ? receipt.data : undefined,
    total_bytes: receipt.success ? receipt.data.bytes : undefined,
    receipt_verification: source === 'live' ? info.receiptVerification
      : info.receiptVerification === 'invalid' || (info.receipt !== undefined && !receipt.success) ? 'invalid' : undefined,
  });
}

export async function readSessionAgentTasks(core: Scope, summary: SessionSummary, query: ListAgentTasksQuery): Promise<ListAgentTasksResponse> {
  const session = getLiveSessionById(core.accessor, summary.id);
  const scope = session?.accessor.get(ISessionContext).scope()
    ?? sessionScopeOf(workspacePersistenceScope('sessions', summary.workspaceId), summary.id);
  const docs = core.accessor.get(IAtomicDocumentStore);
  const storage = core.accessor.get(IFileSystemStorageService);
  const live = new Map(session?.accessor.get(IAgentLifecycleService).list().map((agent) => [agent.id, agent]) ?? []);
  const failures: AgentTasksFailure[] = [];
  const ids = new Set(['main', ...live.keys()]);
  let inventoryComplete = true;
  const inventoryFailure = (message: string): void => {
    inventoryComplete = false; failures.push({ stage: 'inventory', message });
  };
  try {
    const metadata = session === undefined
      ? await docs.get<{ agents?: Record<string, unknown> }>(scope, 'state.json')
        ?? await docs.get<{ agents?: Record<string, unknown> }>(`${scope}/session-meta`, 'state.json')
      : await session.accessor.get(ISessionMetadata).read();
    if (metadata === undefined) inventoryFailure('Session metadata is missing');
    if (metadata?.agents !== undefined) {
      if (typeof metadata.agents !== 'object' || metadata.agents === null || Array.isArray(metadata.agents)) {
        inventoryFailure('Invalid session agent inventory');
      } else {
        for (const id of Object.keys(metadata.agents)) {
          if (safeSegment(id)) ids.add(id); else inventoryFailure('Invalid agent identity in session metadata');
        }
      }
    }
  } catch { inventoryFailure('Unable to read session agent inventory'); }
  try {
    for (const id of await storage.list(`${scope}/agents`)) {
      if (safeSegment(id)) ids.add(id); else inventoryFailure('Invalid persisted agent identity');
    }
  } catch { inventoryFailure('Unable to list persisted agent owners'); }
  const owners = [...ids].toSorted();
  const inventory = digest(owners.map((id) => [id, live.has(id)]));
  const cursor: Cursor = query.page_token === undefined ? {
    version: 1, session: summary.id, scope, inventory, owner: 0, offset: 0,
    started_at: new Date().toISOString(),
  } : decodeCursor(core, query.page_token);
  if (cursor.session !== summary.id || cursor.scope !== scope || cursor.inventory !== inventory || cursor.owner > owners.length) {
    throw new AgentTasksPageTokenError('Agent owner inventory changed or page_token belongs to another session; restart pagination');
  }
  const priorState = loadCursorState(core, cursor.state_id);
  const allFailures: AgentTasksFailure[] = [...priorState.failures];
  const failureKeys = new Set(allFailures.map((failure) => JSON.stringify(failure)));
  for (const failure of failures) {
    const key = JSON.stringify(failure);
    if (!failureKeys.has(key)) {
      failureKeys.add(key);
      allFailures.push(failure);
    }
  }
  const items: AgentTaskSummary[] = [];
  const pageSize = query.page_size ?? 100;
  const readConcurrency = resolveTaskReadConcurrency();
  let reads = 0;
  let visits = 0;
  const failed = new Set(priorState.failed);
  while (cursor.owner < owners.length && reads < pageSize && visits < pageSize) {
    const ownerId = owners[cursor.owner]!;
    visits++;
    if (visits % YIELD_EVERY === 0) await yieldToEventLoop();
    const handle = live.get(ownerId);
    const source = handle === undefined ? 'persisted' : 'live';
    const fail = (stage: 'owner' | 'task_metadata', message: string, taskId?: string): void => {
      if (failed.has(ownerId)) return;
      failed.add(ownerId);
      const failure: AgentTasksFailure = { owner_agent_id: ownerId, task_id: taskId, stage, message };
      const key = JSON.stringify(failure);
      if (!failureKeys.has(key)) {
        failureKeys.add(key);
        allFailures.push(failure);
      }
    };
    try {
      const remaining = pageSize - reads;
      let rows: readonly { id: string; read(): Promise<unknown> }[];
      let prefix: string;
      if (handle !== undefined) {
        const service = handle.accessor.get(IAgentTaskService);
        const tasks = service.list(false, remaining + 1, cursor.offset);
        const previous = digest(cursor.offset === 0 ? [] : service.list(false, 1, cursor.offset - 1).map((task) => task.taskId));
        if (cursor.prefix !== undefined && previous !== cursor.prefix) throw new AgentTasksPageTokenError('Task inventory changed; restart pagination');
        rows = tasks.map((task: AgentTaskInfo) => ({ id: task.taskId, read: async () => task }));
        prefix = digest(tasks.slice(0, remaining).slice(-1).map((task) => task.taskId));
      } else {
        const primary = `${agentScopeOf(scope, ownerId)}/tasks`;
        const [primaryKeys, legacyKeys] = ownerId === 'main'
          ? await Promise.all([docs.list(primary), docs.list(`${scope}/tasks`)])
          : [await docs.list(primary), [] as readonly string[]];
        const entries = new Map<string, string>();
        for (const key of primaryKeys) {
          if (key.endsWith('.json')) entries.set(key, primary);
        }
        if (ownerId === 'main') {
          for (const key of legacyKeys) {
            if (key.endsWith('.json') && !entries.has(key)) entries.set(key, `${scope}/tasks`);
          }
        }
        const sorted = [...entries.keys()].toSorted();
        if (cursor.prefix !== undefined && cursor.offset > sorted.length) {
          throw new AgentTasksPageTokenError('Task inventory changed; restart pagination');
        }
        const prefixHash = createHash('sha256');
        for (let index = 0; index < cursor.offset && index < sorted.length; index++) {
          prefixHash.update(sorted[index]!).update('\0');
        }
        const previous = prefixHash.copy().digest('hex');
        if (cursor.prefix !== undefined && previous !== cursor.prefix) {
          throw new AgentTasksPageTokenError('Task inventory changed; restart pagination');
        }
        rows = sorted.slice(cursor.offset, cursor.offset + remaining + 1).map((key) => ({ id: key.slice(0, -5), read: () => docs.get(entries.get(key)!, key) }));
        const nextEnd = Math.min(sorted.length, cursor.offset + Math.min(rows.length, remaining));
        for (let index = cursor.offset; index < nextEnd; index++) {
          prefixHash.update(sorted[index]!).update('\0');
        }
        prefix = prefixHash.digest('hex');
      }
      const batch = rows.slice(0, remaining);
      const resolved = await mapBounded(batch, readConcurrency, async (row) => {
        try {
          return { ok: true as const, id: row.id, info: storedTask(await row.read(), row.id) };
        } catch {
          return { ok: false as const, id: row.id };
        }
      });
      reads += batch.length;
      for (const entry of resolved) {
        if (!entry.ok) {
          fail('task_metadata', 'Unable to read valid task metadata', entry.id);
          continue;
        }
        if (entry.info.ownerAgentId !== undefined && entry.info.ownerAgentId !== ownerId) continue;
        items.push(toSummary(summary.id, ownerId, source, entry.info));
      }
      if (rows.length > remaining) { cursor.offset += batch.length; cursor.prefix = prefix; break; }
    } catch (error) {
      if (error instanceof AgentTasksPageTokenError) throw error;
      fail('owner', 'Unable to list owner task metadata');
    }
    cursor.owner++;
    cursor.offset = 0;
    cursor.prefix = undefined;
  }
  const hasMore = cursor.owner < owners.length;
  const nextCursor: Cursor = hasMore
    ? { ...cursor, state_id: saveCursorState(core, { failures: allFailures, failed: [...failed] }) }
    : cursor;
  const failedCount = failed.size;
  const completed = cursor.owner - owners.slice(0, cursor.owner).filter((id) => failed.has(id)).length;
  const pending = owners.length - completed - failedCount;
  inventoryComplete = inventoryComplete && !allFailures.some((failure) => failure.stage === 'inventory');
  const partial = !inventoryComplete || failedCount > 0;
  return {
    items,
    owners: owners.map((id, index) => ({ owner_agent_id: id, source: live.has(id) ? 'live' : 'persisted',
      state: failed.has(id) ? 'failed' : index < cursor.owner ? 'complete' : 'pending' })),
    coverage: { total_owners: owners.length, completed_owners: completed, failed_owners: failedCount,
      pending_owners: pending, inventory_complete: inventoryComplete, complete: !hasMore && !partial,
      failures: allFailures },
    has_more: hasMore, next_page_token: hasMore ? encodeCursor(core, nextCursor) : undefined,
    partial, consistency: 'incremental', started_at: cursor.started_at, observed_at: new Date().toISOString(),
  };
}
