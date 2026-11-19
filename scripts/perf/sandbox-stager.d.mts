import type { CorpusRecord, SampledCorpusRecord } from './corpus-scanner.mjs';

export interface StatSignature {
  readonly exists: boolean;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface SourceFingerprint {
  readonly rootEntries: readonly string[];
  readonly stateStat: StatSignature;
  readonly mediaEntries: readonly string[];
  readonly agentsEntries: readonly string[];
  readonly mainEntries: readonly string[];
  readonly mainWireStat: StatSignature;
  readonly mainCkptStat: StatSignature;
  readonly childEntries: readonly string[];
  readonly childWireStat: StatSignature | null;
}

export interface SandboxImmutabilityReport {
  readonly checkedSessions: number;
  readonly verifiedSources: number;
  readonly checkedFiles: number;
  readonly mutations: number;
}

export interface StagedCorpusSandbox {
  readonly sandboxRoot: string;
  readonly homeDir: string;
  readonly osHomeDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly stageMs: number;
  readonly hardlinkedFiles: number;
  readonly copiedFiles: number;
  readonly copiedBytes: number;
  readonly junctionCount: number;
  readonly samples: readonly SampledCorpusRecord[];
  verifyImmutability(): SandboxImmutabilityReport;
  cleanup(): SandboxImmutabilityReport;
}

export function computeWorkDirKey(workDir: string): string;
export function sessionLockFileName(wsId: string, sessionId: string): string;
export function statSignature(filePath: string): StatSignature;

export function captureSourceFingerprint(
  sessionDir: string,
  maxChildAgentId?: string | null,
): SourceFingerprint;

export function buildIsolatedPerfEnv(options?: {
  readonly homeDir?: string;
  readonly osHomeDir?: string;
  readonly extra?: Readonly<Record<string, string>>;
  readonly baseEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv;

export function isolateProcessOsHome(osHomeDir: string): () => void;

export function stageCorpusSandbox(options: {
  readonly corpusHome: string;
  readonly samples: readonly SampledCorpusRecord[];
  readonly backgroundRecords?: readonly CorpusRecord[];
  readonly sandboxParentDir?: string;
  readonly isolateProcessEnv?: boolean;
}): StagedCorpusSandbox;
