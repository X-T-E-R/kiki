import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

import { localServerPlugin } from './vite/localServer';

const webPort = Number(process.env['KIKI_GUI_PORT']) || 5177;
// Where the dev proxy forwards server traffic. The app can also connect to an
// arbitrary server URL typed into the connect screen (loopback cross-origin is
// allowed by kap-server), but the default connection is same-origin through
// this proxy so no CORS / Origin handling is involved.
const serverTarget = process.env['KIMI_SERVER_URL'] || 'http://127.0.0.1:58627';

export default defineConfig({
  plugins: [react(), tailwindcss(), localServerPlugin({ proxyTarget: serverTarget })],
  define: {
    __KIKI_PROXY_TARGET__: JSON.stringify(serverTarget),
  },
  server: {
    port: webPort,
    strictPort: false,
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
