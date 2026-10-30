import type { ErrorPayload } from '#/_base/errors/serialize';

export interface CpuRequest {
  readonly id: number;
  readonly operation: unknown;
}

export type CpuResponse =
  | { readonly id: number; readonly result: unknown }
  | { readonly id: number; readonly error: { readonly name: string; readonly message: string; readonly code?: string; readonly payload?: ErrorPayload } };

let entry: string | undefined;

export function configureCpuWorkerRuntime(options: { entry?: string }): void { entry = options.entry; }
export function cpuWorkerEntry(): string | undefined { return entry; }
