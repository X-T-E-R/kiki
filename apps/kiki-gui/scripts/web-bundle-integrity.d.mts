export interface WebBundleIntegrityResult {
  readonly webDir: string;
  readonly fileCount: number;
  readonly referencedAssets: readonly string[];
}

export declare function extractHtmlAssetPaths(indexHtml: string): string[];

export declare function countRegularFiles(dirPath: string): Promise<number>;

export declare function assertWebBundleIntegrity(
  webDir: string,
  options?: {
    readonly sourceDistDir?: string;
    readonly minFileCount?: number;
  },
): Promise<WebBundleIntegrityResult>;

export declare function stageWebBundle(options: {
  readonly sourceDistDir: string;
  readonly targetWebDir: string;
  readonly minFileCount?: number;
}): Promise<WebBundleIntegrityResult>;
