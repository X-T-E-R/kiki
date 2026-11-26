import { produce } from 'immer';
import { abortable } from '#/_base/utils/abort';
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
import {
  readPersistedAgentCheckpoint,
  readPersistedCheckpointStatToken,
} from './persistedAgentCheckpoint';
import { permissionModeConfiguredKey, permissionModeKey } from '#/agent/permissionMode/permissionModeOps';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { runtimeBindingKey } from '#/agent/runtimeBinding/runtimeBindingOps';
import type { RuntimeBinding } from '#/runtime/runtime';
import type { PlanGate } from '#/features/plan/configSection';
import { planKey, type PlanState } from '#/features/plan/planOps';
import { expandedStateFolds } from '#/state/state';
import { contextMemoryKey } from '#/agent/contextMemory/contextOps';
import { contextTokenCounts, type WireContextProjection } from '#/agent/contextMemory/wireContextProjection';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { TokenCountingState } from '#/agent/tokenCounting/tokenCountingOps';

export interface PersistedAgentRuntimeControls {
  readonly permissionMode: PermissionMode;
  readonly permissionConfigured: boolean;
  readonly planActive: boolean;
  readonly planGate?: PlanGate;
  readonly runtimeBinding?: RuntimeBinding;
}

export interface PersistedAgentRuntimeFacts {
  readonly contextTokens?: number;
  readonly measuredTokens?: number;
  readonly turnCount?: number;
  readonly panelAccounting?: PanelAccountingState;
  readonly complete: boolean;
  readonly fromCheckpoint?: boolean;
  readonly controls?: PersistedAgentRuntimeControls;
  readonly status?: {
    readonly permissionMode: PermissionMode;
    readonly permissionConfigured: boolean;
    readonly planActive: boolean;
    readonly contextTokens: WireContextProjection['contextTokens'];
  };
}

const KEYS = [tokenCountingKey, turnKey, panelAccountingKey] as const;
const CONTROL_KEYS = [permissionModeKey, permissionModeConfiguredKey, planKey, runtimeBindingKey] as const;
const STATUS_KEYS = [permissionModeKey, permissionModeConfiguredKey, planKey, runtimeBindingKey, contextMemoryKey] as const;
const ALL_KEYS = [...KEYS, ...STATUS_KEYS] as const;
const CONTROL_KEY_NAMES = new Set<string>(CONTROL_KEYS.map(key => key.name));
const FOLDS = ALL_KEYS.map(key => ({ key, folds: new Map([...expandedStateFolds(key)].map(([event, fold]) => [event.type, { event, fold }])) }));
const BASE_FOLD_TYPES = new Set<string>(FOLDS.filter(entry => entry.key !== contextMemoryKey && !CONTROL_KEY_NAMES.has(entry.key.name)).flatMap(entry => [...entry.folds.keys()]));
const CONTROL_FOLD_TYPES = new Set<string>([...BASE_FOLD_TYPES, 'permission.set_mode', ...FOLDS.filter(entry => CONTROL_KEY_NAMES.has(entry.key.name)).flatMap(entry => [...entry.folds.keys()])]);
const STATUS_FOLD_TYPES = new Set<string>([...CONTROL_FOLD_TYPES, ...FOLDS.filter(entry => entry.key === contextMemoryKey).flatMap(entry => [...entry.folds.keys()])]);
const BYTE_BUDGET = 8 << 20;
const CONTEXT = { silent: true, emit: () => {}, checkpoint: () => {}, clearCheckpoints: () => {}, undoToCheckpoint: () => {} };
interface RuntimeFactsCacheEntry {
  readonly size: number;
  readonly mtime: number | undefined;
  readonly checkpointToken: string;
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
  options?: { readonly includeStatus?: boolean; readonly includeControls?: boolean },
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
  const [size, mtime, ckptStat] = await Promise.all([
    logicalByteSize(storage, scope, AGENT_WIRE_RECORD_KEY),
    storage.mtime(scope, AGENT_WIRE_RECORD_KEY),
    readPersistedCheckpointStatToken(storage, scope),
  ]);
  const fallback = { contextTokens: metadata?.contextTokens, complete: false };
  if (size === undefined) return fallback;
  let cache = caches.get(host);
  if (cache === undefined) { cache = new Map(); caches.set(host, cache); }
  const wait = (promise: Promise<PersistedAgentRuntimeFacts>) => {
    void promise.catch(() => {});
    return (signal === undefined ? promise : abortable(promise, signal)).then(facts => {
      signal?.throwIfAborted();
      return facts;
    });
  };
  const includeStatus = options?.includeStatus === true;
  const includeControls = includeStatus || options?.includeControls === true;
  const cacheKey = includeStatus ? `${scope}:status` : includeControls ? `${scope}:controls` : scope;
  const cached = cache.get(cacheKey);
  if (
    cached?.size === size &&
    cached.mtime === mtime &&
    cached.checkpointToken === ckptStat.token &&
    cached.contextTokens === metadata?.contextTokens
  ) return wait(cached.promise);
  const read = async (): Promise<PersistedAgentRuntimeFacts> => {
    const keys = includeStatus ? [...KEYS, ...STATUS_KEYS] : includeControls ? [...KEYS, ...CONTROL_KEYS] : KEYS;
    const checkpoint = await readPersistedAgentCheckpoint(docs, storage, scope, size, mtime ?? 0, new Set(keys.map(key => key.name)), workers);
    const usable = checkpoint !== undefined && KEYS.every(key => checkpoint.states.has(key.name));
    const start = usable ? checkpoint.offset : 0;
    if (size - start > BYTE_BUDGET) return fallback;
    const states = usable ? checkpoint.states : new Map<string, unknown>(keys.map(key => [key.name, key.initial()]));
    let controlsComplete = includeControls && (!usable || (states.has(permissionModeKey.name) && states.has(planKey.name)));
    let statusComplete = includeStatus && controlsComplete && (!usable || states.has(contextMemoryKey.name));
    if (controlsComplete && !states.has(runtimeBindingKey.name)) {
      states.set(runtimeBindingKey.name, runtimeBindingKey.initial());
    }
    if (controlsComplete && !states.has(permissionModeConfiguredKey.name)) {
      states.set(permissionModeConfiguredKey.name, usable && states.has(permissionModeKey.name));
    }
    let permissionConfigured = controlsComplete && states.get(permissionModeConfiguredKey.name) === true;
    let valid = true;
    let tokensSeen = usable;
    const relevantTypes = statusComplete ? STATUS_FOLD_TYPES : controlsComplete ? CONTROL_FOLD_TYPES : BASE_FOLD_TYPES;
    const foldLine = (line: string) => {
      if (line.length === 0) return;
      const trimmedEnd = line.endsWith('\r') ? line.length - 1 : line.length;
      if (trimmedEnd === 0) return;
      if (line.charCodeAt(0) === 123 && line.charCodeAt(trimmedEnd - 1) === 125) {
        const type = /^\{\s*"type"\s*:\s*"([^"]+)"/.exec(line.slice(0, Math.min(128, trimmedEnd)))?.[1];
        if (type !== undefined && !relevantTypes.has(type)) return;
      }
      if (line.trim().length === 0) return;
      let record: unknown;
      try { record = JSON.parse(line); } catch { valid = false; return; }
      if (!isWireRecord(record)) { valid = false; return; }
      if (record.type === 'permission.set_mode') permissionConfigured = true;
      for (const { key, folds } of FOLDS) {
        if (key === contextMemoryKey && !statusComplete) continue;
        if (CONTROL_KEY_NAMES.has(key.name) && !controlsComplete) continue;
        const entry = folds.get(record.type);
        if (entry === undefined) continue;
        const event = event2FromRecord(entry.event, record);
        if (event === undefined) { valid = false; continue; }
        if (key === tokenCountingKey && (!(event instanceof AgentModelSwitch) || event.contextTokens !== undefined)) tokensSeen = true;
        states.set(key.name, produce(states.get(key.name), (draft: unknown) => entry.fold(draft as never, event as never, {
          ...CONTEXT,
          undoToCheckpoint: () => {
            statusComplete = false;
            if (key === planKey) controlsComplete = false;
          },
        })));
      }
    };
    if (start < size) {
      const decoder = new TextDecoder();
      let pending = '';
      let bytesRead = 0;
      let yieldedAt = performance.now();
      for await (const bytes of readLogicalBytes(storage, scope, AGENT_WIRE_RECORD_KEY, { start, end: size - 1 })) {
        signal?.throwIfAborted();
        bytesRead += bytes.byteLength;
        pending += decoder.decode(bytes, { stream: true });
        let lineStart = 0;
        let newline: number;
        while ((newline = pending.indexOf('\n', lineStart)) !== -1) {
          foldLine(pending.slice(lineStart, newline));
          lineStart = newline + 1;
        }
        pending = lineStart === 0 ? pending : pending.slice(lineStart);
        if (performance.now() - yieldedAt >= 4) {
          await new Promise<void>((resolve) => { setImmediate(resolve); });
          signal?.throwIfAborted();
          yieldedAt = performance.now();
        }
      }
      foldLine(pending + decoder.decode());
      valid &&= bytesRead === size - start;
    }
    const [afterSize, afterMtime, afterCkpt] = await Promise.all([
      logicalByteSize(storage, scope, AGENT_WIRE_RECORD_KEY),
      storage.mtime(scope, AGENT_WIRE_RECORD_KEY),
      readPersistedCheckpointStatToken(storage, scope),
    ]);
    if (!valid || afterSize !== size || afterMtime !== mtime || afterCkpt.token !== ckptStat.token) return fallback;
    const tokenState = states.get(tokenCountingKey.name) as TokenCountingState;
    const planState = controlsComplete ? states.get(planKey.name) as PlanState : undefined;
    const permissionMode = controlsComplete ? states.get(permissionModeKey.name) as PermissionMode : undefined;
    return {
      contextTokens: tokensSeen ? tokenState.tokens : metadata?.contextTokens,
      measuredTokens: tokensSeen ? tokenState.anchors.findLast(anchor => anchor.measured)?.tokens : undefined,
      turnCount: (states.get(turnKey.name) as ReturnType<typeof turnKey.initial>).nextTurnId,
      panelAccounting: states.get(panelAccountingKey.name) as PanelAccountingState,
      complete: true,
      fromCheckpoint: usable && start === size,
      controls: controlsComplete && planState !== undefined && permissionMode !== undefined ? {
        permissionMode,
        permissionConfigured,
        planActive: planState.active,
        planGate: planState.gate,
        runtimeBinding: states.get(runtimeBindingKey.name) as RuntimeBinding | undefined,
      } : undefined,
      status: statusComplete && planState !== undefined && permissionMode !== undefined ? {
        permissionMode,
        permissionConfigured,
        planActive: planState.active,
        contextTokens: contextTokenCounts(states.get(contextMemoryKey.name) as ContextMessage[], tokenState),
      } : undefined,
    };
  };
  const promise = read();
  void promise.catch(() => {});
  const entry = { size, mtime, checkpointToken: ckptStat.token, contextTokens: metadata?.contextTokens, promise };
  cache.delete(cacheKey);
  cache.set(cacheKey, entry);
  if (cache.size > 1024) cache.delete(cache.keys().next().value!);
  void entry.promise.then(
    facts => { if ((!facts.complete || !ckptStat.distinguishable) && cache.get(cacheKey) === entry) cache.delete(cacheKey); },
    () => { if (cache.get(cacheKey) === entry) cache.delete(cacheKey); },
  );
  return wait(entry.promise);
}
