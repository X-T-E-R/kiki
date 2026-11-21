import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

import type { Plugin } from 'vite';

const PRECOMPRESSIBLE_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.html', '.svg', '.json', '.wasm']);
const BROTLI_QUALITY = 6;
const GZIP_LEVEL = 9;

function isPrecompressible(fileName: string): boolean {
  return PRECOMPRESSIBLE_EXTENSIONS.has(extname(fileName).toLowerCase());
}

async function collectAssets(directory: string, assets: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectAssets(path, assets);
    } else if (entry.isFile() && isPrecompressible(entry.name)) {
      assets.push(path);
    }
  }
}

export function precompressAssetsPlugin(): Plugin {
  let root: string | undefined;
  let outDir: string | undefined;
  return {
    name: 'kiki-precompress-assets',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      outDir = config.build.outDir;
    },
    async writeBundle(outputOptions) {
      if (root === undefined || outDir === undefined) throw new Error('Vite build output directory was not resolved');
      const outputDirectory = resolve(root, outputOptions.dir ?? outDir);
      const assets: string[] = [];
      await collectAssets(outputDirectory, assets);
      for (const path of assets) {
        const source = await readFile(path);
        const brotli = brotliCompressSync(source, {
          params: { [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY },
        });
        const gzip = gzipSync(source, { level: GZIP_LEVEL });
        await Promise.all([writeFile(`${path}.br`, brotli), writeFile(`${path}.gz`, gzip)]);
      }
    },
  };
}
