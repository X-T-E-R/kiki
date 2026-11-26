import { readFileSync } from 'node:fs';

import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

import { localServerPlugin } from './vite/localServer';
import { pdfAssetsPlugin } from './vite/pdfAssets';
import { precompressAssetsPlugin } from './vite/precompressAssets';

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const webPort = Number(process.env['KIKI_GUI_PORT']) || 5177;
// Where the dev proxy forwards server traffic. The app can also connect to an
// arbitrary server URL typed into the connect screen (loopback cross-origin is
// allowed by kap-server), but the default connection is same-origin through
// this proxy so no CORS / Origin handling is involved.
// eslint-disable-next-line typescript/prefer-nullish-coalescing -- `||` is deliberate: an empty KIKI_SERVER_URL must fall back too
const serverTarget = process.env['KIKI_SERVER_URL'] || 'http://127.0.0.1:58627';

// React and the router change only with a dependency bump, while the entry
// chunk's hash changes on every release. In a chunk of their own they keep
// their hash across releases, and since hashed assets are served immutable a
// returning browser reuses its cached copy after an upgrade. Only packages
// that every start needs belong here: a module listed here loads with the
// entry even when nothing but a lazy page uses it.
const STABLE_VENDOR_PACKAGES = new Set(['react', 'react-dom', 'scheduler', 'react-router', 'react-router-dom']);

function vendorChunk(id: string): string | undefined {
  const normalized = id.replaceAll('\\', '/');
  const packageName = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\/(?!.*\/node_modules\/)/.exec(normalized)?.[1];
  return packageName !== undefined && STABLE_VENDOR_PACKAGES.has(packageName) ? 'vendor-react' : undefined;
}

/**
 * Production browser builds load only the active locale dictionary on boot
 * (`ensureInitialLocaleLoaded` in `src/i18n/index.tsx`), keeping the inactive
 * language (~710 KiB raw) out of the entry bundle. Node, CLI, and Vitest keep
 * both dictionaries loaded synchronously through the real `dictionaries.ts`.
 */
function lazyLocaleDictionariesPlugin(): Plugin {
  return {
    name: 'kiki-lazy-locale-dictionaries',
    apply: 'build',
    load(id) {
      const normalized = id.replaceAll('\\', '/').split('?')[0] ?? '';
      if (normalized.endsWith('/packages/session-core/src/i18n/dictionaries.ts')) {
        return 'export function initialDictionaries() { return { en: {}, zh: {} }; }\n';
      }
      if (normalized.endsWith('/packages/session-core/src/i18n/index.ts')) {
        return "export * from './locale';\n";
      }
      return null;
    },
  };
}

const PURE_SCHEMA_PKG_RE = /\/(?:packages\/(?:protocol|plugin-sdk|transcript)\/src|packages\/klient\/src\/contract|packages\/session-core\/src\/settings\/memoryAdvisor\.ts)/;

interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly body?: readonly AstNode[];
  readonly declaration?: AstNode | null;
  readonly declarations?: readonly { readonly init?: AstNode | null }[];
  readonly kind?: string;
}

function shouldWrapPureInit(node: AstNode): boolean {
  return node.type === 'CallExpression'
    || node.type === 'NewExpression'
    || node.type === 'ObjectExpression'
    || node.type === 'ArrayExpression'
    || node.type === 'MemberExpression';
}

/**
 * Mark pure Zod schema modules side-effect-free and wrap their top-level
 * schema initializers in `/* @__PURE__ *\/ (() => (...))()` for the browser
 * production build so Rollup drops unreferenced schemas inside partially used
 * modules instead of constructing hundreds of Zod v4 objects on boot.
 */
function pureSchemaPackagesPlugin(): Plugin {
  return {
    name: 'kiki-pure-schema-packages',
    apply: 'build',
    enforce: 'post',
    transform(code, id) {
      const normalized = id.replaceAll('\\', '/').split('?')[0] ?? '';
      if (!PURE_SCHEMA_PKG_RE.test(normalized)) return null;
      let ast: AstNode;
      try {
        ast = this.parse(code) as unknown as AstNode;
      } catch {
        return { code, map: null, moduleSideEffects: false };
      }
      const edits: { readonly start: number; readonly end: number }[] = [];
      for (const stmt of ast.body ?? []) {
        const decl = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
        if (decl === null || decl === undefined || decl.type !== 'VariableDeclaration' || decl.kind !== 'const') continue;
        for (const item of decl.declarations ?? []) {
          const init = item.init;
          if (init === null || init === undefined || !shouldWrapPureInit(init)) continue;
          const slice = code.slice(init.start, init.end);
          if (slice.includes('await ') || slice.includes('yield ')) continue;
          edits.push({ start: init.start, end: init.end });
        }
      }
      if (edits.length === 0) return { code, map: null, moduleSideEffects: false };
      let out = code;
      for (let i = edits.length - 1; i >= 0; i -= 1) {
        const { start, end } = edits[i]!;
        out = `${out.slice(0, start)}/* @__PURE__ */ (() => (${out.slice(start, end)}))()${out.slice(end)}`;
      }
      return { code: out, map: null, moduleSideEffects: false };
    },
  };
}

export default defineConfig({
  plugins: [
    lazyLocaleDictionariesPlugin(),
    pureSchemaPackagesPlugin(),
    react(),
    tailwindcss(),
    pdfAssetsPlugin(),
    localServerPlugin({ proxyTarget: serverTarget }),
    precompressAssetsPlugin(),
  ],
  define: {
    __KIKI_PROXY_TARGET__: JSON.stringify(serverTarget),
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(
      process.env['VITE_APP_VERSION']?.trim() || packageJson.version,
    ),
    'import.meta.env.VITE_BUILD_SHA': JSON.stringify(
      process.env['VITE_BUILD_SHA']?.trim() || process.env['KIKI_BUILD_SHA']?.trim() || '',
    ),
    'import.meta.env.VITE_UPDATE_CHANNEL': JSON.stringify(process.env['KIKI_UPDATE_CHANNEL'] ?? 'stable'),
  },
  server: {
    // Pin IPv4: a bare 'localhost' bind can land on ::1 only on dual-stack
    // Windows, and Chromium then hangs resolving localhost to 127.0.0.1.
    host: '127.0.0.1',
    port: webPort,
    // Ignore build output trees so rebuilding dist/ does not trigger recursive
    // watcher churn during local GUI proof or dev runs.
    watch: {
      ignored: ['**/dist/**'],
    },
    // An explicitly demanded port (the proof sets KIKI_GUI_PORT) must bind or
    // fail loudly — never slide to a neighbouring port while a zombie serves
    // a stale app on the expected one. Plain `pnpm dev` stays lenient.
    strictPort: process.env['KIKI_GUI_PORT'] !== undefined,
    proxy: {
      '/api': { target: serverTarget, changeOrigin: true, ws: true },
    },
  },
  preview: {
    port: Number(process.env['KIKI_GUI_PREVIEW_PORT']) || 4177,
    proxy: {
      '/api': { target: serverTarget, changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: { output: { manualChunks: vendorChunk } },
  },
});
