import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  AGENT_WIRE_RECORD_KEY,
  IAppendLogStore,
  IBootstrapService,
  ICpuWorkerService,
  IFileSystemStorageService,
  type Scope,
} from '@kiki/agent-core-v2';
import type { WireContextProjection } from '@kiki/agent-core-v2/agent/contextMemory/wireContextProjection';
import { readWireContextProjection } from '@kiki/agent-core-v2/persistence/wireContextRead';
import { agentScopeOf, sessionScopeOf, workspacePersistenceScope } from '@kiki/agent-core-v2/workspace/sessionLifecycle/internal/addressing';

export type ColdMainWireProjection = WireContextProjection;

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
  const workers = core.accessor.get(ICpuWorkerService);
  const projection = await readWireContextProjection(workers.request.bind(workers), core.accessor.get(IAppendLogStore),
    core.accessor.get(IFileSystemStorageService), scope, AGENT_WIRE_RECORD_KEY, signal);
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
