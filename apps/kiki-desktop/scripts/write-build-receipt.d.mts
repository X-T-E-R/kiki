export interface BuildReceiptFileEntry {
  readonly sha256: string;
  readonly bytes: number;
}

export interface ElectronBuildReceipt {
  readonly schemaVersion: 2;
  readonly runtimeKind: 'electron-single-binary';
  readonly sourceCommit: string;
  readonly acceptanceRef: string;
  readonly checkRef: string;
  readonly distribution?: 'github' | 'local' | 'custom';
  readonly updaterFeedBaseUrl?: string;
  readonly serverEntry: string;
  readonly nativeAddons: string;
  readonly files: Readonly<Record<string, BuildReceiptFileEntry>>;
}

export declare function normalizeHttpsUpdaterFeedBaseUrl(rawUrl: unknown): string | null;

export declare function writeElectronBuildReceipt(options?: {
  readonly candidateDir?: string;
  readonly sourceCommit?: string;
  readonly acceptanceRef?: string;
  readonly checkRef?: string;
  readonly distribution?: string;
  readonly updaterFeedBaseUrl?: string;
}): Promise<{
  readonly receiptPath: string;
  readonly releaseId: string;
  readonly receipt: ElectronBuildReceipt;
}>;
