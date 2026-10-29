import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const [runDir, pattern, depthArg] = process.argv.slice(2);
const depth = Number(depthArg ?? 3);
const profile = JSON.parse(await readFile(join(runDir, 'out', 'server.cpuprofile'), 'utf8'));
const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const parents = new Map();
for (const node of nodes.values()) for (const child of node.children ?? []) parents.set(child, node.id);
const label = (node) => `${node.callFrame.functionName || '(anon)'} ${node.callFrame.url.replace(/^.*\/(packages|node_modules)\//, '$1/').replace(/^file:\/\/\//, '')}:${String(node.callFrame.lineNumber + 1)}`;
const regex = new RegExp(pattern);
const chains = new Map();
let total = 0;
let all = 0;
for (let i = 0; i < profile.samples.length; i += 1) {
  const us = profile.timeDeltas[i] ?? 0;
  all += us;
  let cursor = profile.samples[i];
  let hit;
  for (let id = cursor; id !== undefined; id = parents.get(id)) if (regex.test(label(nodes.get(id)))) { hit = id; }
  if (hit === undefined) continue;
  total += us;
  const parts = [];
  let id = parents.get(hit);
  while (id !== undefined && parts.length < depth) {
    const node = nodes.get(id);
    const name = label(node);
    if (/packages\//.test(name) && !/_base\/(event|errors)|eventBusService|instantiationService/.test(name)) parts.push(name);
    id = parents.get(id);
  }
  const key = parts.join(' <- ');
  chains.set(key, (chains.get(key) ?? 0) + us);
}
console.log(`${pattern}: ${(total / all * 100).toFixed(2)}% of samples`);
for (const [key, us] of [...chains].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${(us / all * 100).toFixed(2).padStart(6)}%  ${key}`);
