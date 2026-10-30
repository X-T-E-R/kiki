import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CpuWorkerPool, type CpuPoolOptions, type CpuRequestOptions } from './host';
import { cpuWorkerEntry } from './protocol';

const owners = new Set<CpuWorkerPool>();
let standalone: CpuWorkerPool | undefined;

export function createCpuPool(options?: CpuPoolOptions): CpuWorkerPool {
  return new CpuWorkerPool(resolveEntry(), options);
}

export function registerCpuPool(pool: CpuWorkerPool): { dispose(): Promise<void> } {
  owners.add(pool);
  return { async dispose() { owners.delete(pool); await pool.close(); } };
}

export function runCpuTask<T>(operation: unknown, options?: CpuRequestOptions): Promise<T> {
  try {
    let pool: CpuWorkerPool | undefined;
    for (const owner of owners) pool = owner;
    pool ??= standalone ??= createCpuPool();
    return pool.request<T>(operation, options);
  } catch (error) { return Promise.reject(error); }
}

export async function closeCpuPool(): Promise<void> {
  const previous = standalone;
  standalone = undefined;
  await previous?.close();
}

function resolveEntry(): URL {
  const configuredEntry = cpuWorkerEntry();
  if (configuredEntry !== undefined) return pathToFileURL(configuredEntry);
  for (const relative of ['./bootstrap.mjs', './cpu-worker.mjs']) {
    const entry = new URL(relative, import.meta.url);
    try { if (statSync(entry).isFile()) return entry; } catch {}
  }
  throw new Error('CPU worker asset is unavailable');
}
