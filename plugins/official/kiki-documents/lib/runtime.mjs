import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DocumentsError } from './paths.mjs';

export const EXTRACT_VERSION = '0.1.1';
export async function loadExtract(packagePath) {
  const root = packagePath || path.resolve(import.meta.dirname, '../vendor/nb-extract');
  if (!path.isAbsolute(root)) throw new DocumentsError('DEPENDENCY_PATH_INVALID', 'nbExtractPath must be absolute.', 'Select the standard package root in plugin settings or leave it empty for the bundled package.');
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new DocumentsError('DEPENDENCY_MISSING', 'The nb-extract package is missing.', 'Reinstall the complete plugin or set nbExtractPath to an installed @nb-corp/nb-extract package root.');
    throw error;
  }
  if (manifest.name !== '@nb-corp/nb-extract') throw new DocumentsError('DEPENDENCY_INVALID', 'Expected the official nb-extract package root.', 'Select the directory containing its package.json, not a node_modules parent.');
  if (manifest.version !== EXTRACT_VERSION) throw new DocumentsError('VERSION_MISMATCH', `nb-extract ${manifest.version} found; this plugin requires ${EXTRACT_VERSION}.`, 'Use the bundled package or select the pinned standard package.');
  const entry = manifest.exports?.['.']?.import;
  if (entry !== './dist/index.mjs') throw new DocumentsError('DEPENDENCY_INVALID', 'nb-extract has an unexpected public API entry.', 'Use the official @nb-corp/nb-extract package.');
  const api = await import(pathToFileURL(await realpath(path.join(root, entry))).href);
  if (typeof api.extract !== 'function' || typeof api.saveResult !== 'function') throw new DocumentsError('DEPENDENCY_INVALID', 'nb-extract public API is incomplete.', 'Reinstall the complete plugin.');
  return api;
}
