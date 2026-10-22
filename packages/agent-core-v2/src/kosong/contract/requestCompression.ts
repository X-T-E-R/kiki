export type RequestCompression =
  | { encoding: 'off' }
  | { encoding: 'gzip'; targets: string[]; minBytes?: number }
  | { encoding: 'zstd'; targets: string[]; minBytes?: number; dictionary?: boolean };
