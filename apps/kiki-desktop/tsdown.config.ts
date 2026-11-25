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

const sharedDefines = {
  __KIKI_DESKTOP_BUILD_ID__: JSON.stringify(process.env['KIKI_BUILD_ID'] ?? ''),
  __KIKI_DESKTOP_CHANNEL__: JSON.stringify(process.env['KIKI_CHANNEL'] ?? ''),
  __KIKI_DESKTOP_DISTRIBUTION__: JSON.stringify(process.env['KIKI_DESKTOP_DISTRIBUTION'] ?? ''),
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
