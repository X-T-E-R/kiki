import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getNativePackageRoot, getSeaAssetSource } from './native-assets';
import { loadNativePackage } from './native-require';

type ModuleLoad = (request: string, parent: unknown, isMain: boolean) => unknown;

interface ModuleWithLoad {
  _load?: ModuleLoad;
}

const nodeRequire = createRequire(import.meta.url);
let installed = false;
const loadingPackages = new Set<string>();

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
      (request === '@napi-rs/keyring' || request === 'node-pty' || request === '@kiki/auth-native') &&
      !loadingPackages.has(request) && getSeaAssetSource() !== null
    ) {
      loadingPackages.add(request);
      try {
        const pkg = loadNativePackage(request);
        if (pkg === null) throw new Error(`Native package assets are unavailable: ${request}`);
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
}
