import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { PluginPanel } from './contributions';

const MAX_PANEL_BYTES = 256 * 1024;
const PANEL_CSP = "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'";
const ASSET_MIME: Readonly<Record<string, string>> = {
  '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp',
};

export async function panelDocument(root: string, panel: PluginPanel): Promise<string> {
  const base = await realpath(root);
  const file = await realpath(panel.file);
  const relative = path.relative(base, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !file.endsWith('.html')) {
    throw new Error('Panel resource escaped its installed plugin');
  }
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_PANEL_BYTES) throw new Error('Panel HTML exceeds 256 KiB');
  let html = await readFile(file, 'utf8');
  for (const [name, asset] of Object.entries(panel.assetFiles)) {
    const bytes = await readFile(asset);
    const mime = ASSET_MIME[path.extname(asset).toLowerCase()];
    if (mime === undefined || bytes.byteLength > 512 * 1024) throw new Error('Invalid plugin panel asset');
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp(`(["'])\\./${escaped}\\1`, 'g'),
      `"data:${mime};base64,${bytes.toString('base64')}"`);
  }
  if (/<(?:script|link|img)\b[^>]*\b(?:src|href)\s*=\s*["'](?!data:)/i.test(html)) {
    throw new Error('Panel references an undeclared external asset');
  }
  const policy = `<meta http-equiv="Content-Security-Policy" content="${PANEL_CSP}">`;
  const withoutDoctype = html.replace(/^\s*<!doctype html>\s*/i, '');
  const metadata = `${policy}<meta name="referrer" content="no-referrer">`;
  if (/<head(?:\s[^>]*)?>/i.test(withoutDoctype)) {
    return `<!doctype html>${withoutDoctype.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${metadata}`)}`;
  }
  return `<!doctype html><html><head>${metadata}</head><body>${withoutDoctype}</body></html>`;
}
