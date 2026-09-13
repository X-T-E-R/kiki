import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

const appRoot = resolve(import.meta.dirname, '..');
const source = resolve(appRoot, '..', '..', 'docs');
const target = resolve(appRoot, 'dist', 'docs');

async function copyMarkdownTree(sourceDir, targetDir) {
  await mkdir(targetDir, { recursive: true });
  const entries = (await readdir(sourceDir, { withFileTypes: true }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const sourcePath = resolve(sourceDir, entry.name);
    const targetPath = resolve(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyMarkdownTree(sourcePath, targetPath);
    } else if (entry.isFile() && extname(entry.name) === '.md') {
      await copyFile(sourcePath, targetPath);
    }
  }
}

await rm(target, { recursive: true, force: true });
for (const locale of ['en', 'zh']) {
  await copyMarkdownTree(resolve(source, locale), resolve(target, locale));
}

console.log(`[copy-doc-assets] copied ${source} to ${target}`);
