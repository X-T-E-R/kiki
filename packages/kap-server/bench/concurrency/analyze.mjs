import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(resolve(import.meta.dirname, '../../../../package.json'));
let TraceMap;
let originalPositionFor;
try {
  ({ TraceMap, originalPositionFor } = require('@jridgewell/trace-mapping'));
} catch {
  ({ TraceMap, originalPositionFor } = await import(new URL('../../../../node_modules/.pnpm/@jridgewell+trace-mapping@0.3.31/node_modules/@jridgewell/trace-mapping/dist/trace-mapping.mjs', import.meta.url).href));
}

const repoPrefix = /^.*?systems\/kiki\//;
for (const runDir of process.argv.slice(2)) {
  const out = join(runDir, 'out');
  const profile = JSON.parse(await readFile(join(out, 'server.cpuprofile'), 'utf8'));
  let mapEntries = [];
  try { mapEntries = JSON.parse(await readFile(join(out, 'source-maps.json'), 'utf8')); } catch {}
  const maps = new Map();
  for (const entry of mapEntries) {
    if (!entry.map.startsWith('data:')) continue;
    try { maps.set(entry.url, new TraceMap(JSON.parse(Buffer.from(entry.map.split(',')[1], 'base64').toString('utf8')))); } catch {}
  }
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map();
  for (const node of nodes.values()) for (const child of node.children ?? []) parents.set(child, node.id);
  const keyOf = new Map();
  for (const node of nodes.values()) {
    const frame = node.callFrame;
    const map = maps.get(frame.url);
    const position = map && frame.lineNumber >= 0 ? originalPositionFor(map, { line: frame.lineNumber + 1, column: frame.columnNumber }) : undefined;
    const line = position?.line ?? frame.lineNumber + 1;
    const url = decodeURIComponent(frame.url.replaceAll('\\', '/').replace('file:///', '')).replace(repoPrefix, '');
    keyOf.set(node.id, `${frame.functionName || '(anonymous)'} @ ${url}:${line}`);
  }
  const self = new Map();
  const total = new Map();
  let sampledUs = 0;
  let idleUs = 0;
  for (let i = 0; i < profile.samples.length; i += 1) {
    const id = profile.samples[i];
    const us = profile.timeDeltas[i] ?? 0;
    sampledUs += us;
    const node = nodes.get(id);
    if (node.callFrame.functionName === '(idle)') idleUs += us;
    const key = keyOf.get(id);
    self.set(key, (self.get(key) ?? 0) + us);
    const seen = new Set();
    for (let cursor = id; cursor !== undefined; cursor = parents.get(cursor)) {
      const ancestor = keyOf.get(cursor);
      if (seen.has(ancestor)) continue;
      seen.add(ancestor);
      total.set(ancestor, (total.get(ancestor) ?? 0) + us);
    }
  }
  const row = ([name, us]) => ({ name, ms: Math.round(us / 100) / 10, pct: Math.round(us / sampledUs * 10000) / 100 });
  const repo = ([name]) => /packages\//.test(name) && !/node_modules/.test(name);
  const sorted = (map, filter = () => true) => [...map].filter(filter).sort((a, b) => b[1] - a[1]).slice(0, 40).map(row);
  const result = {
    sampledMs: sampledUs / 1000, busyPct: Math.round((1 - idleUs / sampledUs) * 10000) / 100,
    self: sorted(self), repoSelf: sorted(self, repo), repoInclusive: sorted(total, repo),
  };
  await writeFile(join(out, 'hotspots.json'), JSON.stringify(result, null, 2));
  console.log(runDir, `busy ${String(result.busyPct)}%`);
  console.log('self:'); for (const r of result.self.slice(0, 15)) console.log(`  ${String(r.pct).padStart(6)}%  ${r.name}`);
  console.log('repo self:'); for (const r of result.repoSelf.slice(0, 20)) console.log(`  ${String(r.pct).padStart(6)}%  ${r.name}`);
  console.log('repo inclusive:'); for (const r of result.repoInclusive.slice(0, 30)) console.log(`  ${String(r.pct).padStart(6)}%  ${r.name}`);
}
