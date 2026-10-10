/**
 * Downloading a Recipe as a portable archive.
 *
 * The server's `export` already returns a self-contained snapshot: a canonical
 * file map with the inheritance chain resolved and no `extends` or
 * `installation:` parent left to resolve on the other side. So this module only
 * has to pack those files and hand the bytes to the browser — it deliberately
 * does no manifest rewriting of its own, because a second serialization pass is
 * exactly where a "shareable" package stops matching the one that was exported.
 *
 * A managed local package's source is `installation:<id>`, which is an
 * identifier rather than an address. That is why the export route exists, and
 * why nothing here tries to pass such a locator to somebody else as if it were
 * a link.
 */

import { zipSync } from 'fflate';

/** A name safe for a download on every platform the app runs on. */
export function recipeExportZipName(source: { name: string; version?: string }): string {
  const parts = [source.name, source.version].filter((part): part is string => typeof part === 'string' && part.trim() !== '');
  const stem = parts.join('-')
    .replaceAll(/[^\w.-]+/gu, '-')
    .replaceAll(/^[-.]+/gu, '')
    .replaceAll(/[-.]+$/gu, '');
  return `${stem === '' ? 'recipe' : stem}.zip`;
}

/**
 * Pack an exported file map into ZIP bytes.
 *
 * Entries are stored rather than deflated: these are small text files that are
 * already compressible, and storing them keeps the archive inspectable and the
 * pack step allocation-free on the main thread.
 */
export function zipRecipeFiles(files: Readonly<Record<string, string>>): Uint8Array {
  const encoder = new TextEncoder();
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) {
    entries[name] = encoder.encode(content);
  }
  return zipSync(entries, { level: 0 });
}

/** Whether a source locator is something a recipient could actually fetch. */
export function isShareableLocator(locator: string): boolean {
  return locator.startsWith('https://');
}

/**
 * Trigger a browser download of the archive.
 *
 * The object URL is revoked on the next tick rather than immediately: Safari
 * and some Chromium builds have not started reading the blob by the time the
 * click handler returns, and revoking too early cancels the download silently.
 */
export function downloadRecipeZip(bytes: Uint8Array, fileName: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => { URL.revokeObjectURL(url); }, 0);
}
