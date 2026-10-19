import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  AGENT_WIRE_RECORD_KEY,
  IAppendLogStore,
  IBootstrapService,
  createContextTranscriptReducer,
  type ContextTranscript,
  type Scope,
  type WireRecord,
} from '@kiki/agent-core-v2';
import { event2FromRecord, type Event2, type Event2Class } from '@kiki/agent-core-v2/app/event/event2';
import {
  PermissionSetMode,
  permissionModeKey,
} from '@kiki/agent-core-v2/agent/permissionMode/permissionModeOps';
import type { PermissionMode } from '@kiki/agent-core-v2/agent/permissionPolicy/types';
import {
  PlanModeCancel,
  PlanModeEnter,
  PlanModeExit,
  planKey,
  type PlanState,
} from '@kiki/agent-core-v2/features/plan/planOps';
import type { FoldContext, ReplayableStateKey } from '@kiki/agent-core-v2/state/state';
import { agentScopeOf, sessionScopeOf, workspacePersistenceScope } from '@kiki/agent-core-v2/workspace/sessionLifecycle/internal/addressing';

const SILENT_FOLD: FoldContext = {
  silent: true,
  checkpoint() {},
  clearCheckpoints() {},
  undoToCheckpoint() {},
  emit() {},
};

const PLAN_EVENTS: ReadonlyMap<string, Event2Class> = new Map<string, Event2Class>([
  [PlanModeEnter.type, PlanModeEnter],
  [PlanModeCancel.type, PlanModeCancel],
  [PlanModeExit.type, PlanModeExit],
]);

export interface ColdMainWireProjection {
  readonly transcript: ContextTranscript;
  readonly permissionMode: PermissionMode;
  readonly planActive: boolean;
}

const COLD_MAIN_WIRE_CACHE_BYTES = 4 << 20;
const COLD_MAIN_WIRE_CACHE_ENTRIES = 32;
const coldWireCaches = new WeakMap<Scope, { bytes: number; entries: Map<string, { fingerprint: string; projection: ColdMainWireProjection; bytes: number }> }>();

export async function readColdMainWireProjection(
  core: Scope,
  workspaceId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<ColdMainWireProjection> {
  signal?.throwIfAborted();
  const scope = agentScopeOf(
    sessionScopeOf(
      workspacePersistenceScope(core.accessor.get(IBootstrapService).scope('sessions'), workspaceId),
      sessionId,
    ),
    'main',
  );
  const path = join(core.accessor.get(IBootstrapService).homeDir, scope, AGENT_WIRE_RECORD_KEY);
  const before = await wireFingerprint(path);
  signal?.throwIfAborted();
  const cached = coldWireCaches.get(core)?.entries.get(scope);
  if (before !== undefined && cached?.fingerprint === before) return cached.projection;
  const reducer = createContextTranscriptReducer();
  let permissionMode = permissionModeKey.initial() as PermissionMode;
  let plan: PlanState = { ...planKey.initial() };
  for await (const record of core.accessor.get(IAppendLogStore).read<WireRecord>(scope, AGENT_WIRE_RECORD_KEY, { signal })) {
    reducer.add(record);
    permissionMode = foldPermission(permissionMode, record);
    plan = foldPlan(plan, record);
  }
  const projection = {
    transcript: reducer.result(),
    permissionMode,
    planActive: plan.active === true,
  };
  const after = await wireFingerprint(path);
  if (before !== undefined && before === after) rememberColdWire(core, scope, before, projection);
  return projection;
}

async function wireFingerprint(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.birthtimeMs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function rememberColdWire(core: Scope, scope: string, fingerprint: string, projection: ColdMainWireProjection): void {
  let cache = coldWireCaches.get(core);
  if (cache === undefined) {
    cache = { bytes: 0, entries: new Map() };
    coldWireCaches.set(core, cache);
  }
  const previous = cache.entries.get(scope);
  if (previous !== undefined) {
    cache.entries.delete(scope);
    cache.bytes -= previous.bytes;
  }
  const bytes = projectionBytes(projection, COLD_MAIN_WIRE_CACHE_BYTES);
  if (bytes > COLD_MAIN_WIRE_CACHE_BYTES) return;
  while (cache.entries.size > 0 && (cache.bytes + bytes > COLD_MAIN_WIRE_CACHE_BYTES || cache.entries.size >= COLD_MAIN_WIRE_CACHE_ENTRIES)) {
    const oldest = cache.entries.keys().next().value;
    if (oldest === undefined) break;
    cache.bytes -= cache.entries.get(oldest)?.bytes ?? 0;
    cache.entries.delete(oldest);
  }
  cache.entries.set(scope, { fingerprint, projection, bytes });
  cache.bytes += bytes;
}

function projectionBytes(value: unknown, cap: number): number {
  let bytes = 0;
  const stack: unknown[] = [value];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === 'string') bytes += item.length * 2;
    else if (typeof item === 'number' || typeof item === 'boolean') bytes += 8;
    else if (typeof item === 'object' && item !== null && !seen.has(item)) {
      seen.add(item);
      bytes += 64;
      if (Array.isArray(item)) for (const child of item) stack.push(child);
      else for (const [key, child] of Object.entries(item)) {
        bytes += key.length * 2;
        stack.push(child);
      }
    }
    if (bytes > cap) return bytes;
  }
  return bytes;
}

function foldPermission(permissionMode: PermissionMode, record: WireRecord): PermissionMode {
  if (record.type !== PermissionSetMode.type) return permissionMode;
  const event = event2FromRecord(PermissionSetMode, eventRecord(record));
  if (event === undefined) return permissionMode;
  const next = applyFold(permissionModeKey, permissionMode, PermissionSetMode, event);
  return typeof next === 'string' ? next : permissionMode;
}

function foldPlan(plan: PlanState, record: WireRecord): PlanState {
  const cls = PLAN_EVENTS.get(record.type);
  if (cls === undefined) return plan;
  const event = event2FromRecord(cls, eventRecord(record));
  if (event === undefined) return plan;
  const draft: PlanState = {
    ...plan,
    ...(plan.revisionCount === undefined ? {} : { revisionCount: { ...plan.revisionCount } }),
  };
  const next = applyFold(planKey, draft, cls, event);
  return next ?? draft;
}

function applyFold<S>(
  key: ReplayableStateKey<S>,
  state: S,
  cls: Event2Class,
  event: Event2,
): S | undefined {
  const fold = key.replayable.folds.get(cls);
  if (fold === undefined) return undefined;
  const next = fold(state as never, event, SILENT_FOLD);
  return next === undefined ? undefined : next as S;
}

function eventRecord(record: WireRecord): { readonly type: string; readonly time?: number } & Record<string, unknown> {
  return record as { readonly type: string; readonly time?: number } & Record<string, unknown>;
}
