import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getBundledDiskAssetManifest, getNativePackageRoot, getSeaAssetSource } from './native-assets';
import { loadNativePackage } from './native-require';

type ModuleLoad = (request: string, parent: unknown, isMain: boolean) => unknown;

interface ModuleResolveResult {
  readonly url: string;
  readonly shortCircuit?: boolean;
}

type ModuleResolveNext = (specifier: string, context: unknown) => ModuleResolveResult;

interface ModuleWithLoad {
  _load?: ModuleLoad;
  registerHooks?: (hooks: {
    resolve?: (
      specifier: string,
      context: unknown,
      nextResolve: ModuleResolveNext,
    ) => ModuleResolveResult;
  }) => unknown;
}

const NATIVE_HOOK_SPECIFIERS = new Set([
  '@napi-rs/keyring',
  '@mariozechner/clipboard',
  'node-pty',
  '@kiki/auth-native',
]);

const nodeRequire = createRequire(import.meta.url);
let installed = false;
const loadingPackages = new Set<string>();
const loadedPackages = new Map<string, unknown>();
const esmWrapperUrls = new Map<string, string>();

// pi-tui loads its platform-specific native helpers via an absolute-path
// require() computed from import.meta.url / process.execPath
// (see pi-tui dist/terminal.js and dist/native-modifiers.js). In a SEA binary
// those .node files live in the native-asset cache, so redirect any absolute
// require of a pi-tui native helper to the cached copy.
//
// Path shape: native/<darwin|win32>/prebuilds/<arch>/<file>.node — note the
// two path segments after "prebuilds", so ".+" (not "[^/]+") is required.
const PI_TUI_NATIVE_PATTERN = /native[\\/](?:win32|darwin)[\\/]prebuilds[\\/].+\.node$/;

export function installNativeModuleHook(): void {
  if (installed) return;
  installed = true;

  const moduleBuiltin = nodeRequire('node:module') as ModuleWithLoad;
  const originalLoad = moduleBuiltin._load;
  if (originalLoad === undefined) return;

  moduleBuiltin._load = function loadWithNativeAssets(
    this: unknown,
    request: string,
    parent: unknown,
    isMain: boolean,
  ): unknown {
    if (
      NATIVE_HOOK_SPECIFIERS.has(request) &&
      !loadingPackages.has(request) &&
      (getSeaAssetSource() !== null || getBundledDiskAssetManifest() !== null)
    ) {
      if (loadedPackages.has(request)) return loadedPackages.get(request);
      loadingPackages.add(request);
      try {
        const pkg = loadNativePackage(request);
        if (pkg === null) throw new Error(`Native package assets are unavailable: ${request}`);
        loadedPackages.set(request, pkg);
        return pkg;
      } finally {
        loadingPackages.delete(request);
      }
    }
    if (request === '@kiki/auth-native' && getSeaAssetSource() === null) {
      const packagedRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'native', 'auth-native');
      if (existsSync(join(packagedRoot, 'package.json'))) {
        return originalLoad.call(this, packagedRoot, parent, isMain);
      }
    }
    if (
      typeof request === 'string' &&
      PI_TUI_NATIVE_PATTERN.test(request) &&
      !existsSync(request)
    ) {
      const pkgRoot = getNativePackageRoot('@kiki/pi-tui');
      if (pkgRoot !== null) {
        const match = request.match(PI_TUI_NATIVE_PATTERN);
        if (match !== null) {
          const redirected = join(pkgRoot, match[0]);
          return originalLoad.call(this, redirected, parent, isMain);
        }
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  if (typeof moduleBuiltin.registerHooks === 'function') {
    const anchorUrl = import.meta.url;
    moduleBuiltin.registerHooks({
      resolve(specifier, context, nextResolve) {
        if (
          NATIVE_HOOK_SPECIFIERS.has(specifier) &&
          (getSeaAssetSource() !== null || getBundledDiskAssetManifest() !== null)
        ) {
          let dataUrl = esmWrapperUrls.get(specifier);
          if (dataUrl === undefined) {
            const pkg = nodeRequire(specifier) as Record<string, unknown>;
            const exportKeys =
              pkg !== null && typeof pkg === 'object'
                ? Object.keys(pkg).filter(
                    (key) => key !== 'default' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key),
                  )
                : [];
            const wrapperSource = [
              'import { createRequire } from "node:module";',
              `const mod = createRequire(${JSON.stringify(anchorUrl)})(${JSON.stringify(specifier)});`,
              ...exportKeys.map(
                (key) => `export const ${key} = mod[${JSON.stringify(key)}];`,
              ),
              'export default mod;',
            ].join('\n');
            dataUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(wrapperSource)}`;
            esmWrapperUrls.set(specifier, dataUrl);
          }
          return { url: dataUrl, shortCircuit: true };
        }
        return nextResolve(specifier, context);
      },
    });
  }
}
