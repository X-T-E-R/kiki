export interface CorpusRecord {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly mainWireBytes: number;
  readonly mainWireMb: number;
  readonly subagentCount: number;
  readonly maxChildWireBytes: number;
  readonly maxChildWireMb: number;
  readonly maxChildAgentId: string | null;
  readonly branchAgentId: string | null;
  readonly branchWireBytes: number;
  readonly mediaCount: number;
  readonly blobCount: number;
  readonly attachmentCount: number;
}

export interface SampledCorpusRecord extends CorpusRecord {
  readonly ordinal: number;
  readonly label: string;
  readonly sandboxId: string;
  readonly stratum: string;
  readonly descriptor: string;
}

export interface CorpusScanResult {
  readonly available: boolean;
  readonly corpusHome: string;
  readonly totalScanned: number;
  readonly eligibleCount: number;
  readonly skippedActiveCount: number;
  readonly records: readonly CorpusRecord[];
}

export function resolveCorpusHome(explicitHome?: string): string;
export function scanCorpusSessions(
  corpusHome: string,
  options?: { readonly minIdleMs?: number },
): CorpusScanResult;
export function selectStratifiedSamples(
  records: readonly CorpusRecord[],
  options: {
    readonly seed: number;
    readonly perStratum?: number;
    readonly backgroundCatalogCount?: number;
  },
): {
  readonly samples: readonly SampledCorpusRecord[];
  readonly backgroundRecords: readonly CorpusRecord[];
};
