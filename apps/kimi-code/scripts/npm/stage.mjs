import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const source = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const destination = resolve(root, 'dist-npm');
const desktopVersion = JSON.parse(await readFile(resolve(root, '../kiki-gui/package.json'), 'utf8')).version;
if (source.version !== desktopVersion) throw new Error(`CLI ${source.version} and desktop ${desktopVersion} must use the same release version`);

await rm(destination, { recursive: true, force: true });
for (const [kind, name] of [['lite', 'kiki-cli-lite'], ['full', 'kiki-cli']]) {
  const dir = resolve(destination, kind);
  await mkdir(dir, { recursive: true });
  for (const asset of ['dist', 'native', 'README.md']) {
    await cp(resolve(root, asset), resolve(dir, asset), { recursive: true });
  }
  const manifest = {
    name,
    version: source.version,
    description: kind === 'lite' ? 'Kiki CLI/TUI (Node.js)' : 'Kiki CLI/TUI and desktop app',
    license: source.license,
    homepage: source.homepage,
    repository: source.repository,
    type: 'module',
    bin: { kiki: 'dist/main.mjs' },
    engines: { node: '>=24.15.0' },
    dependencies: { ws: source.dependencies.ws },
    optionalDependencies: source.optionalDependencies,
    files: kind === 'lite' ? ['dist', 'native', 'README.md'] : ['dist', 'native', 'desktop', 'scripts', 'README.md'],
    publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' },
  };
  if (kind === 'full') {
    manifest.scripts = { postinstall: 'node scripts/desktop-postinstall.mjs' };
    await cp(resolve(root, 'scripts/npm/desktop-postinstall.mjs'), resolve(dir, 'scripts/desktop-postinstall.mjs'));
  }
  await writeFile(resolve(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Staged ${name}@${source.version}: ${dir}`);
}
