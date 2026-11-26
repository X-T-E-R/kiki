import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { defineConfig } from 'tsdown';

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

const mainBanner = [
  "import { createRequire as __kikiDesktopCreateRequire } from 'node:module';",
  'const require = __kikiDesktopCreateRequire(import.meta.url);',
].join('\n');

function resolveDesktopBuildId(): string {
  const explicit =
    process.env['KIKI_DESKTOP_BUNDLED'] === '1'
      ? undefined
      : process.env['KIKI_BUILD_ID']?.trim();
  if (explicit) {
    return explicit;
  }
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: import.meta.dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

const sharedDefines = {
  __KIKI_DESKTOP_BUILD_ID__: JSON.stringify(resolveDesktopBuildId()),
  __KIKI_DESKTOP_CHANNEL__: JSON.stringify(
    process.env['KIKI_DESKTOP_BUNDLED'] === '1' ? '' : (process.env['KIKI_CHANNEL'] ?? ''),
  ),
  __KIKI_DESKTOP_DISTRIBUTION__: JSON.stringify(process.env['KIKI_DESKTOP_DISTRIBUTION'] ?? ''),
  __KIKI_UPDATER_FEED_BASE_URL__: JSON.stringify(process.env['KIKI_UPDATER_FEED_BASE_URL'] ?? ''),
};

export default defineConfig([
  {
    entry: ['./src/main/index.ts'],
    format: ['esm'],
    platform: 'node',
    target: 'node24',
    outDir: 'dist/main',
    clean: true,
    dts: false,
    sourcemap: true,
    banner: { js: mainBanner },
    define: sharedDefines,
    deps: {
      alwaysBundle: (id) => id !== 'electron' && !builtins.has(id) && !id.startsWith('node:'),
      neverBundle: ['electron'],
      onlyBundle: false,
    },
    outputOptions: {
      codeSplitting: false,
      entryFileNames: 'index.js',
    },
  },
  {
    entry: ['./src/preload/index.ts'],
    format: ['cjs'],
    platform: 'node',
    target: 'node24',
    outDir: 'dist/preload',
    clean: false,
    dts: false,
    sourcemap: true,
    define: sharedDefines,
    deps: {
      alwaysBundle: (id) => id !== 'electron' && !builtins.has(id) && !id.startsWith('node:'),
      neverBundle: ['electron'],
      onlyBundle: false,
    },
    outputOptions: {
      codeSplitting: false,
      entryFileNames: 'index.cjs',
    },
  },
]);
