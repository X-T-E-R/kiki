import { createRequire } from 'node:module';
import { join } from 'node:path';
import { isSea } from 'node:sea';
import type * as NodePty from 'node-pty';

import {
  ensureNativeAssetTree,
  getNativePackageRoot,
  type NativeAssetOptions,
} from './native-assets';

export function createNativePackageRequire(
  packageName: string,
  options: NativeAssetOptions = {},
): ReturnType<typeof createRequire> | null {
  const packageRoot = getNativePackageRoot(packageName, options);
  if (packageRoot === null) return null;

  const cacheRoot = ensureNativeAssetTree(options);
  if (cacheRoot === null) return null;

  return createRequire(join(cacheRoot, 'node_modules', '.kimi-native-entry.cjs'));
}

export function loadNativePackage<T>(
  packageName: string,
  options: NativeAssetOptions = {},
): T | null {
  const nativeRequire = createNativePackageRequire(packageName, options);
  if (nativeRequire === null) return null;
  const packageRoot = getNativePackageRoot(packageName, options);
  if (packageRoot === null) return null;
  const pkg = nativeRequire(packageRoot) as T;
  if (packageName !== 'node-pty' || process.platform !== 'win32' || !isSea()) return pkg;
  const metadata = nativeRequire(join(packageRoot, 'package.json')) as { version: string };
  if (metadata.version !== '1.1.0') throw new Error(`Unsupported SEA node-pty adapter version: ${metadata.version}`);
  const pty = pkg as typeof NodePty;
  // SEA cannot fork arbitrary JS with its own execPath. The upstream DLL
  // backend closes the pseudoconsole without the console-list Node agent.
  return {
    ...pty,
    spawn: (file: string, args: string[] | string, spawnOptions?: NodePty.IPtyForkOptions | NodePty.IWindowsPtyForkOptions) => {
      const proc = pty.spawn(file, args, { useConptyDll: true, ...spawnOptions });
      const agent = (proc as NodePty.IPty & {
        _agent: {
          _useConpty: boolean;
          _useConptyDll: boolean;
          _conoutSocketWorker: { dispose(): void };
          inSocket: { destroy(): void };
        };
      })._agent;
      if (agent._useConpty && agent._useConptyDll) {
        // 1.1.0 emits exit after the output socket closes, but DLL mode only
        // disposes the conout worker on subsequent data (which may never come).
        proc.onExit(() => {
          agent._conoutSocketWorker.dispose();
          agent.inSocket.destroy();
        });
      }
      return proc;
    },
  } as T;
}
