import { produce } from 'immer';
import { ICpuWorkerService } from '#/app/cpuWorker/cpuWorkerService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { logicalByteSize, readLogicalBytes } from '#/persistence/coldSegmentLog';
import { event2FromRecord } from '#/app/event/event2';
import { tokenCountingKey } from '#/agent/tokenCounting/tokenCountingOps';
import { AgentModelSwitch } from '#/agent/modelSwitch/modelSwitchEvent';
import { turnKey } from '#/agent/loop/turnOps';
import { panelAccountingKey, type PanelAccountingState } from '#/agent/usage/panelAccounting';
import { AGENT_WIRE_RECORD_KEY, isWireRecord } from '#/wire/record';
import { agentScopeOf, sessionScopeOf, workspacePersistenceScope } from '#/workspace/sessionLifecycle/internal/addressing';
import type { AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import type { AgentProfileSnapshotHost } from './agentProfileSnapshot';
import { readPersistedAgentCheckpoint } from './persistedAgentCheckpoint';
import { permissionModeKey } from '#/agent/permissionMode/permissionModeOps';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { planKey, type PlanState } from '#/features/plan/planOps';
import { expandedStateFolds } from '#/state/state';
import { contextMemoryKey } from '#/agent/contextMemory/contextOps';
import { contextTokenCounts, type WireContextProjection } from '#/agent/contextMemory/wireContextProjection';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { TokenCountingState } from '#/agent/tokenCounting/tokenCountingOps';

export interface PersistedAgentRuntimeFacts {
  readonly contextTokens?: number;
  readonly turnCount?: number;
  readonly panelAccounting?: PanelAccountingState;
  readonly complete: boolean;
  readonly status?: {
    readonly permissionMode: PermissionMode;
    readonly permissionConfigured: boolean;
    readonly planActive: boolean;
    readonly contextTokens: WireContextProjection['contextTokens'];
  };
}

const KEYS = [tokenCountingKey, turnKey, panelAccountingKey] as const;
const STATUS_KEYS = [permissionModeKey, planKey, contextMemoryKey] as const;
const FOLDS = [...KEYS, ...STATUS_KEYS].map(key => ({ key, folds: new Map([...expandedStateFolds(key)].map(([event, fold]) => [event.type, { event, fold }])) }));
const BYTE_BUDGET = 8 << 20;
const CONTEXT = { silent: true, emit: () => {}, checkpoint: () => {}, clearCheckpoints: () => {}, undoToCheckpoint: () => {} };
interface RuntimeFactsCacheEntry {
  readonly size: number;
  readonly mtime: number | undefined;
  readonly contextTokens: number | undefined;
  readonly promise: Promise<PersistedAgentRuntimeFacts>;
}
const caches = new WeakMap<AgentProfileSnapshotHost, Map<string, RuntimeFactsCacheEntry>>();

/** Reads verified checkpoint facts plus at most 8 MiB of wire without materializing an agent. */
export async function readPersistedAgentRuntimeFacts(
  host: AgentProfileSnapshotHost,
  workspaceId: string,
  sessionId: string,
  agentId: string,
  metadata?: AgentMeta,
  signal?: AbortSignal,
  options?: { readonly includeStatus?: boolean },
): Promise<PersistedAgentRuntimeFacts> {
  signal?.throwIfAborted();
  const storage = 'accessor' in host ? host.accessor.get(IFileSystemStorageService) : host.storage;
  const docs = 'accessor' in host ? host.accessor.get(IAtomicDocumentStore) : host.docs;
  let workers: ICpuWorkerService | undefined;
  if ('accessor' in host) {
    try { workers = host.accessor.get(ICpuWorkerService); } catch { workers = undefined; }
  } else {
    workers = host.workers;
  }
  const scope = agentScopeOf(sessionScopeOf(workspacePersistenceScope('sessions', workspaceId), sessionId), agentId);
  const [size, mtime] = await Promise.all([
    logicalByteSize(storage, scope, AGENT_WIRE_RECORD_KEY), storage.mtime(scope, AGENT_WIRE_RECORD_KEY),
  ]);
  const fallback = { contextTokens: metadata?.contextTokens, complete: false };
  if (size === undefined) return fallback;
  let cache = caches.get(host);
  if (cache === undefined) { cache = new Map(); caches.set(host, cache); }
  const wait = (promise: Promise<PersistedAgentRuntimeFacts>) => promise.then(facts => { signal?.throwIfAborted(); return facts; });
  const cacheKey = options?.includeStatus === true ? `${scope}:status` : scope;
  const cached = cache.get(cacheKey);
  if (cached?.size === size && cached.mtime === mtime && cached.contextTokens === metadata?.contextTokens) return wait(cached.promise);
  const read = async (): Promise<PersistedAgentRuntimeFacts> => {
    const keys = options?.includeStatus === true ? [...KEYS, ...STATUS_KEYS] : KEYS;
    const checkpoint = await readPersistedAgentCheckpoint(docs, storage, scope, size, mtime ?? 0, new Set(keys.map(key => key.name)), workers);
    const usable = checkpoint !== undefined && KEYS.every(key => checkpoint.states.has(key.name));
    const start = usable ? checkpoint.offset : 0;
    if (size - start > BYTE_BUDGET) return fallback;
    const states = usable ? checkpoint.states : new Map<string, unknown>(keys.map(key => [key.name, key.initial()]));
    let statusComplete = options?.includeStatus === true && (!usable || STATUS_KEYS.every(key => states.has(key.name)));
    let permissionConfigured = usable && states.has(permissionModeKey.name);
    let valid = true;
    let tokensSeen = usable;
    const foldLine = (line: string) => {
      if (line.trim().length === 0) return;
      let record: unknown;
      try { record = JSON.parse(line); } catch { valid = false; return; }
      if (!isWireRecord(record)) { valid = false; return; }
      if (record.type === 'permission.set_mode') permissionConfigured = true;
      for (const { key, folds } of FOLDS) {
        if (STATUS_KEYS.some(statusKey => statusKey.name === key.name) && !statusComplete) continue;
        const entry = folds.get(record.type);
        if (entry === undefined) continue;
        const event = event2FromRecord(entry.event, record);
        if (event === undefined) { valid = false; continue; }
        if (key === tokenCountingKey && (!(event instanceof AgentModelSwitch) || event.contextTokens !== undefined)) tokensSeen = true;
        states.set(key.name, produce(states.get(key.name), (draft: unknown) => entry.fold(draft as never, event as never, {
          ...CONTEXT,
          undoToCheckpoint: () => { statusComplete = false; },
        })));
      }
    };
    if (start < size) {
      const decoder = new TextDecoder();
      let pending = '';
      let bytesRead = 0;
      for await (const bytes of readLogicalBytes(storage, scope, AGENT_WIRE_RECORD_KEY, { start, end: size - 1 })) {
        bytesRead += bytes.byteLength;
        pending += decoder.decode(bytes, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf('\n')) !== -1) {
          foldLine(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
        }
      }
      foldLine(pending + decoder.decode());
      valid &&= bytesRead === size - start;
    }
    const [afterSize, afterMtime] = await Promise.all([
      logicalByteSize(storage, scope, AGENT_WIRE_RECORD_KEY), storage.mtime(scope, AGENT_WIRE_RECORD_KEY),
    ]);
    if (!valid || afterSize !== size || afterMtime !== mtime) return fallback;
    return {
      contextTokens: tokensSeen ? (states.get(tokenCountingKey.name) as ReturnType<typeof tokenCountingKey.initial>).tokens : metadata?.contextTokens,
      turnCount: (states.get(turnKey.name) as ReturnType<typeof turnKey.initial>).nextTurnId,
      panelAccounting: states.get(panelAccountingKey.name) as PanelAccountingState,
      complete: true,
      status: statusComplete ? {
        permissionMode: states.get(permissionModeKey.name) as PermissionMode,
        permissionConfigured,
        planActive: (states.get(planKey.name) as PlanState).active,
        contextTokens: contextTokenCounts(states.get(contextMemoryKey.name) as ContextMessage[], states.get(tokenCountingKey.name) as TokenCountingState),
      } : undefined,
    };
  };
  const entry = { size, mtime, contextTokens: metadata?.contextTokens, promise: read() };
  cache.delete(cacheKey);
  cache.set(cacheKey, entry);
  if (cache.size > 1024) cache.delete(cache.keys().next().value!);
  void entry.promise.then(facts => { if (!facts.complete && cache.get(cacheKey) === entry) cache.delete(cacheKey); },
    () => { if (cache.get(cacheKey) === entry) cache.delete(cacheKey); });
  return wait(entry.promise);
}
