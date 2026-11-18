import type { QuantileStats } from './perf/metrics.mjs';
import type { SandboxImmutabilityReport } from './perf/sandbox-stager.mjs';

export interface RealCorpusBenchmarkReport {
  readonly seed: number;
  readonly mode: string;
  readonly samples: readonly unknown[];
  readonly immutability: SandboxImmutabilityReport;
  readonly protocol: {
    readonly aggregates: {
      readonly coldOpenTtfcMs: QuantileStats;
      readonly olderPageMs: QuantileStats;
      readonly coldSubagentTtfcMs: QuantileStats;
      readonly maxServerEldP99Ms: number;
    };
  };
  readonly slo: {
    readonly passed: boolean;
    readonly breaches: readonly string[];
  };
}

export type RealCorpusBenchmarkOutcome =
  | { readonly skipped: true; readonly reason: string }
  | { readonly skipped?: false; readonly report: RealCorpusBenchmarkReport; readonly summaryText: string };

export function runRealCorpusBenchmark(options?: {
  readonly corpusHome?: string;
  readonly seed?: number | string;
  readonly perStratum?: number;
  readonly quick?: boolean;
  readonly browser?: boolean;
  readonly enforce?: boolean;
  readonly minIdleMs?: number;
  readonly outPath?: string;
  readonly quiet?: boolean;
}): Promise<RealCorpusBenchmarkOutcome>;
