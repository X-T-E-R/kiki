/**
 * Fixture stand-in for the appearance-pack routes (kap-server
 * routes/appearance.ts): list, manifest and declared files, read from pack
 * folders on disk; delete and install acknowledge without touching disk.
 *
 * Scenario seed (optional):
 *   appearancePacks: [absolute pack folder, …]   // each holds kiki-pack.json
 *
 * The visual proof points it at docs/examples/appearance-packs, so the GUI is
 * exercised against the real shipped example rather than a mock manifest.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  avif: 'image/avif', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm',
};

function packsOf(server) {
  const dirs = server.scenario?.data.appearancePacks ?? [];
  const removed = server.appearanceRemoved ?? new Set();
  return dirs.map((dir) => {
    const pack = JSON.parse(readFileSync(join(dir, 'kiki-pack.json'), 'utf8'));
    const bytes = readdirSync(dir).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);
    return { dir, pack, bytes };
  }).filter((entry) => !removed.has(entry.pack.id));
}

function summaryOf({ pack, bytes }) {
  const variants = ['light', 'dark'].filter((key) => pack.variants[key] !== undefined);
  const all = variants.map((key) => pack.variants[key]);
  return {
    id: pack.id,
    name: pack.name,
    description: pack.description,
    author: pack.author,
    license: pack.license,
    variants,
    hasSkin: all.some((v) => v.colors !== undefined || v.fonts !== undefined || v.shape !== undefined),
    hasVideo: all.some((v) => (v.background?.media ?? []).some((file) => /\.(mp4|webm)$/i.test(file))),
    bytes,
  };
}

/** Handle an `/api/appearance/*` request; returns true when it answered. */
export function handleAppearance(server, req, res, path) {
  if (!path.startsWith('/appearance/')) return false;
  const method = req.method ?? 'GET';
  if (path === '/appearance/packs' && method === 'GET') {
    server.envelope(res, { items: packsOf(server).map(summaryOf), directory: '/home/fixture/.kiki/themes', skipped: [] });
    return true;
  }
  if (path === '/appearance/packs' && method === 'POST') {
    req.resume();
    server.envelope(res, null, 40001, 'fixture: pack install is not simulated');
    return true;
  }
  const match = /^\/appearance\/packs\/([a-z0-9-]+)(?:\/files\/([A-Za-z0-9._-]+))?$/.exec(path);
  if (match === null) return false;
  const entry = packsOf(server).find((item) => item.pack.id === match[1]);
  if (entry === undefined) {
    server.envelope(res, null, 40409, 'appearance pack not found');
    return true;
  }
  if (match[2] !== undefined) {
    const file = match[2];
    const type = TYPES[file.split('.').at(-1)?.toLowerCase() ?? ''];
    if (type === undefined) {
      res.writeHead(404).end();
      return true;
    }
    const data = readFileSync(join(entry.dir, file));
    res.writeHead(200, { 'content-type': type, 'content-length': data.byteLength, 'cache-control': 'private, max-age=3600' });
    res.end(data);
    return true;
  }
  if (method === 'DELETE') {
    server.appearanceRemoved = new Set([...(server.appearanceRemoved ?? []), entry.pack.id]);
    server.envelope(res, { removed: true });
    return true;
  }
  server.envelope(res, { pack: entry.pack, bytes: entry.bytes });
  return true;
}
