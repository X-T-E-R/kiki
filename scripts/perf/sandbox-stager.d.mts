import type { CorpusRecord, SampledCorpusRecord } from './corpus-scanner.mjs';

export interface SourceFingerprint {
  readonly files: Readonly<Record<string, { readonly exists: boolean; readonly size: number; readonly mtimeMs: number }>>;
  readonly agentNames: readonly string[];
}

export interface SandboxImmutabilityReport {
  readonly checkedSessions: number;
  readonly mutations: number;
}

export interface StagedCorpusSandbox {
  readonly sandboxRoot: string;
  readonly stageMs: number;
  readonly hardlinkedFiles: number;
  readonly copiedFiles: number;
  readonly junctionCount: number;
  readonly samples: readonly SampledCorpusRecord[];
  cleanup(): SandboxImmutabilityReport;
}

export function captureSourceFingerprint(
  sessionDir: string,
  maxChildAgentId?: string | null,
): SourceFingerprint;

export function stageCorpusSandbox(options: {
  readonly corpusHome: string;
  readonly samples: readonly SampledCorpusRecord[];
  readonly backgroundRecords?: readonly CorpusRecord[];
}): StagedCorpusSandbox;
