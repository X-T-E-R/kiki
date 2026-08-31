import { readFileSync } from 'node:fs';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

import { localServerPlugin } from './vite/localServer';

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const webPort = Number(process.env['KIKI_GUI_PORT']) || 5177;
// Where the dev proxy forwards server traffic. The app can also connect to an
// arbitrary server URL typed into the connect screen (loopback cross-origin is
// allowed by kap-server), but the default connection is same-origin through
// this proxy so no CORS / Origin handling is involved.
// eslint-disable-next-line typescript/prefer-nullish-coalescing -- `||` is deliberate: an empty KIMI_SERVER_URL must fall back too
const serverTarget = process.env['KIMI_SERVER_URL'] || 'http://127.0.0.1:58627';

export default defineConfig({
  plugins: [react(), tailwindcss(), localServerPlugin({ proxyTarget: serverTarget })],
  define: {
    __KIKI_PROXY_TARGET__: JSON.stringify(serverTarget),
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(packageJson.version),
    'import.meta.env.VITE_BUILD_SHA': JSON.stringify(process.env['KIKI_BUILD_SHA'] ?? ''),
    'import.meta.env.VITE_UPDATE_CHANNEL': JSON.stringify(process.env['KIKI_UPDATE_CHANNEL'] ?? 'stable'),
  },
  server: {
    // Pin IPv4: a bare 'localhost' bind can land on ::1 only on dual-stack
    // Windows, and Chromium then hangs resolving localhost to 127.0.0.1.
    host: '127.0.0.1',
    port: webPort,
    // `tauri dev` runs this dev server as its beforeDevCommand while cargo
    // links into src-tauri/target; watching those trees crashes the watcher
    // (EBUSY on the in-flight exe) and kills the whole desktop launch.
    watch: {
      ignored: ['**/src-tauri/target/**', '**/src-tauri/binaries/**', '**/dist/**'],
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
  },
});
