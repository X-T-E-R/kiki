import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { builtinModules, createRequire } from 'node:module';

const { build } = createRequire(import.meta.url)('../runtime/node_modules/esbuild');

const root = path.resolve(import.meta.dirname, '..');
const modules = path.join(root, 'runtime/node_modules');
const source = path.join(modules, '@nb-corp/nb-extract');
const target = path.join(root, 'vendor/nb-extract');
const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
if (manifest.name !== '@nb-corp/nb-extract' || manifest.version !== '0.1.1') throw new Error('Build requires the pinned standard nb-extract package');
await mkdir(path.join(target, 'dist'), { recursive: true });
await mkdir(path.join(target, 'python'), { recursive: true });
const built = await build({
  entryPoints: [path.join(source, 'dist/index.mjs')], outfile: path.join(target, 'dist/index.mjs'),
  bundle: true, platform: 'node', target: 'node24', format: 'esm', minify: true, legalComments: 'inline', metafile: true,
  alias: { canvas: path.join(modules, 'linkedom/commonjs/canvas-shim.cjs') },
  banner: { js: "/* oxlint-disable */\nimport { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
for (const output of Object.values(built.metafile.outputs)) {
  for (const imported of output.imports) {
    if (!builtinModules.includes(imported.path.replace(/^node:/, ''))) throw new Error(`Unexpected external dependency in bundle: ${imported.path}`);
  }
}
await writeFile(path.join(target, 'package.json'), JSON.stringify({
  name: manifest.name, version: manifest.version, type: 'module', license: manifest.license,
  repository: manifest.repository, exports: { '.': { import: './dist/index.mjs' } },
}, null, 2) + '\n');
await copyFile(path.join(source, 'python/markitdown_bridge.py'), path.join(target, 'python/markitdown_bridge.py'));
await copyFile(path.join(source, 'LICENSE'), path.join(target, 'LICENSE'));
const lock = JSON.parse(await readFile(path.join(root, 'runtime/package-lock.json'), 'utf8'));
const notices = ['# Third-party notices', '', 'This plugin bundles the public API production unit of @nb-corp/nb-extract 0.1.1 without changes to its extraction logic, and its JavaScript dependencies. Generated from the pinned runtime lockfile by scripts/build-vendor.mjs. LinkeDOM uses its own existing no-canvas shim; native canvas is not bundled or resolved from the host. MarkItDown and Python are installed separately by the user; MinerU is a remote service, not bundled software.', ''];
for (const [key, info] of Object.entries(lock.packages).toSorted(([a], [b]) => a.localeCompare(b))) {
  if (!key || info.dev || info.optional) continue;
  const directory = path.join(root, 'runtime', key);
  const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  notices.push(`## ${pkg.name} ${pkg.version}`, '', `License: ${pkg.license ?? 'see license below'}.`, '');
  const files = (await readdir(directory)).filter((name) => /^(licen[sc]e|copying|notice)(\.|$)/i.test(name));
  if (files.length === 0) throw new Error(`No license file found for ${pkg.name}`);
  for (const file of files) notices.push(`### ${file}`, '', '```text', (await readFile(path.join(directory, file), 'utf8')).trim(), '```', '');
}
await writeFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), notices.join('\n'));
process.stdout.write(`Bundled ${manifest.name}@${manifest.version} at vendor/nb-extract; no runtime npm installation required.\n`);
