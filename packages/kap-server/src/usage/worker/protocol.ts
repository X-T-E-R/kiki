import type { UsageWireSlice, UsageWireState } from '@kiki/agent-core-v2/agent/usage/usageWireFramer';

export const USAGE_WORKER_VERSION = 1;
export const USAGE_CHUNK_BYTES = 1 << 20;

export type UsageWorkerRequest =
  | { readonly v: 1; readonly id: number; readonly type: 'begin'; readonly offset: number; readonly agentId?: string; readonly state?: UsageWireState; readonly allowance: SharedArrayBuffer; readonly deadlineAt: number }
  | { readonly v: 1; readonly id: number; readonly type: 'chunk'; readonly bytes: ArrayBuffer; readonly start: number; readonly end: number }
  | { readonly v: 1; readonly id: number; readonly type: 'close' };

export interface UsageWorkerMetrics {
  readonly heapUsed: number;
  readonly arrayBuffers: number;
  readonly cpuUserMicros: number;
  readonly cpuSystemMicros: number;
  readonly parseMs: number;
}

export type UsageWorkerResponse =
  | { readonly v: 1; readonly type: 'ready' }
  | { readonly v: 1; readonly id: number; readonly type: 'result'; readonly slice?: UsageWireSlice; readonly bytes?: ArrayBuffer; readonly metrics: UsageWorkerMetrics }
  | { readonly v: 1; readonly id: number; readonly type: 'error'; readonly message: string };
