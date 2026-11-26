import { join } from 'node:path';

import { ErrorCodes, Error2 } from '#/errors';
import {
  getShareBinRgPath,
  getShareDir,
  getVendorRgPath,
  rgBinaryName,
  rgUnavailableMessage,
  type EnsureRgPathOptions,
  type RgProbe,
} from '#/os/backends/node-local/tools/rgLocator';

export { getShareBinRgPath, rgUnavailableMessage, type EnsureRgPathOptions, type RgProbe };

export type RgResolutionSource = 'system-path' | 'vendor' | 'share-bin-cached';

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
    const vendor = getVendorRgPath(rgBinaryName());
    if (vendor !== undefined) {
      const vendorRun = await probe.exec([vendor, '--version']).catch(() => ({ exitCode: -1 }));
      if (vendorRun.exitCode === 0) {
        return { path: vendor, source: 'vendor' };
      }
    }
    const shareDir = options.shareDir ?? getShareDir();
    const cacheDirs = [
      shareDir,
      ...(options.fallbackShareDirs ?? []).filter((dir) => dir !== '' && dir !== shareDir),
    ];
    for (const dir of cacheDirs) {
      for (const subdir of ['bin', 'tools']) {
        const cached = join(dir, subdir, rgBinaryName());
        const cachedRun = await probe.exec([cached, '--version']).catch(() => ({ exitCode: -1 }));
        if (cachedRun.exitCode === 0) {
          return { path: cached, source: 'share-bin-cached' };
        }
      }
    }
  }

  throw new Error2(ErrorCodes.OS_FS_UNAVAILABLE, 'ripgrep (rg) is not available on PATH');
}
