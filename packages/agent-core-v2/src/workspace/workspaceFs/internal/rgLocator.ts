import { join } from 'node:path';

import { ErrorCodes, Error2 } from '#/errors';
import {
  getShareBinRgPath,
  getShareDir,
  rgBinaryName,
  rgUnavailableMessage,
  type EnsureRgPathOptions,
  type RgProbe,
} from '#/os/backends/node-local/tools/rgLocator';

export { getShareBinRgPath, rgUnavailableMessage, type EnsureRgPathOptions, type RgProbe };

export type RgResolutionSource = 'system-path' | 'share-bin-cached';

export interface RgResolution {
  readonly path: string;
  readonly source: RgResolutionSource;
}

export async function ensureRgPath(
  probe: RgProbe,
  options: EnsureRgPathOptions = {},
): Promise<RgResolution> {
  options.signal?.throwIfAborted();

  const system = await probe.exec(['rg', '--version']).catch(() => ({ exitCode: -1 }));
  if (system.exitCode === 0) {
    return { path: 'rg', source: 'system-path' };
  }

  if (options.allowCachedFallback === true) {
    options.signal?.throwIfAborted();
    const shareDir = options.shareDir ?? getShareDir();
    const cacheDirs = [
      shareDir,
      ...(options.fallbackShareDirs ?? []).filter((dir) => dir !== '' && dir !== shareDir),
    ];
    for (const dir of cacheDirs) {
      const cached = join(dir, 'bin', rgBinaryName());
      const cachedRun = await probe.exec([cached, '--version']).catch(() => ({ exitCode: -1 }));
      if (cachedRun.exitCode === 0) {
        return { path: cached, source: 'share-bin-cached' };
      }
    }
  }

  throw new Error2(ErrorCodes.OS_FS_UNAVAILABLE, 'ripgrep (rg) is not available on PATH');
}
