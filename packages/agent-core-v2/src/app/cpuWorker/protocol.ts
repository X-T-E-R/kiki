import type { ErrorPayload } from '#/_base/errors/serialize';

export interface CpuRequest {
  readonly id: number;
  readonly operation: unknown;
  readonly cancellation: SharedArrayBuffer;
}

export type CpuResponse =
  | { readonly type: 'ready' }
  | { readonly id: number; readonly result: unknown; readonly heapTotalBytes?: number }
  | { readonly id: number; readonly cancelled: true; readonly heapTotalBytes?: number }
  | { readonly id: number; readonly error: { readonly name: string; readonly message: string; readonly code?: string; readonly payload?: ErrorPayload }; readonly heapTotalBytes?: number };

let entry: string | undefined;

export function configureCpuWorkerRuntime(options: { entry?: string }): void { entry = options.entry; }
export function cpuWorkerEntry(): string | undefined { return entry; }
