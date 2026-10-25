import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import type { Plugin } from 'vite';

const require = createRequire(import.meta.url);
const root = dirname(require.resolve('pdfjs-dist/package.json'));
const prefixes = ['cmaps/', 'standard_fonts/'];
const standalone = ['build/pdf.worker.min.mjs', 'LICENSE'];

export function pdfAssetsPlugin(): Plugin {
  let base = '/';
  let building = false;
  async function resources(): Promise<string[]> {
    const files = [...standalone];
    for (const prefix of prefixes) {
      for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
        if (entry.isFile()) files.push(prefix + entry.name);
      }
    }
    return files;
  }
  const outputName = (file: string) => `pdfjs/${file === 'build/pdf.worker.min.mjs' ? 'pdf.worker.min.mjs' : file}`;
  return {
    name: 'kiki-local-pdf-assets',
    configResolved(config) { base = config.base; building = config.command === 'build'; },
    resolveId(id) { return id === 'virtual:kiki-pdf-assets' ? '\0virtual:kiki-pdf-assets' : undefined; },
    load(id) {
      if (id !== '\0virtual:kiki-pdf-assets') return;
      return `export const workerSrc = ${JSON.stringify(base + 'pdfjs/pdf.worker.min.mjs')};\nexport const cMapUrl = ${JSON.stringify(base + 'pdfjs/cmaps/')};\nexport const standardFontDataUrl = ${JSON.stringify(base + 'pdfjs/standard_fonts/')};\n`;
    },
    async buildStart() {
      if (!building) return;
      for (const file of await resources()) this.emitFile({ type: 'asset', fileName: outputName(file), source: await readFile(join(root, file)) });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0];
        if (path === undefined || !path.startsWith(base + 'pdfjs/')) { next(); return; }
        const name = path.slice((base + 'pdfjs/').length);
        const file = name === 'pdf.worker.min.mjs' ? 'build/pdf.worker.min.mjs' : name;
        const resolved = join(root, file);
        const rel = relative(root, resolved);
        if (rel.startsWith(`..${sep}`) || rel === '..' || (!standalone.includes(file) && !prefixes.some(prefix => file.startsWith(prefix)))) { res.statusCode = 404; res.end(); return; }
        void readFile(resolved).then(bytes => {
          res.setHeader('Content-Type', file.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream');
          res.end(bytes);
        }).catch(() => { res.statusCode = 404; res.end(); });
      });
    },
  };
}
