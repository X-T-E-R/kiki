export interface QuantileStats {
  readonly count: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly mean: number;
}

export function roundMs(value: number): number;
export function roundMb(bytes: number): number;
export function quantiles(values: readonly number[]): QuantileStats;
export function collectForbiddenTokens(
  corpusHome: string,
  extraTokens?: readonly string[],
): string[];
export function assertZeroPrivateLeaks(
  payloadText: string,
  forbiddenTokens: readonly string[],
): void;
