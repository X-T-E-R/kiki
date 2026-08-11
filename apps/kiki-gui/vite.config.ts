import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

import { localServerPlugin } from './vite/localServer';

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
  },
  server: {
    port: webPort,
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
