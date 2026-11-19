export type ByteUnitSystem = 'si' | 'iec';

export interface FormatBytesOptions {
  /** `'si'` labels values as `KB`/`MB` (default); `'iec'` labels them as `KiB`/`MiB`. */
  unit?: ByteUnitSystem;
}

/**
 * Format a byte count into a compact human-readable size string.
 * - `unit: 'si'` (default): `B`, `KB`, `MB` (1 decimal below 10, 0 at >= 10).
 * - `unit: 'iec'`: `B`, `KiB`, `MiB` (integer `KiB`, up to 1 decimal `MiB` with trailing `.0` trimmed).
 */
export function formatBytes(bytes: number, options?: FormatBytesOptions): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (options?.unit === 'iec') {
    if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
    return `${bytes} B`;
  }
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
