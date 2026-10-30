import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const [runDir, pattern, depthArg] = process.argv.slice(2);
const depth = Number(depthArg ?? 2);
const profile = JSON.parse(await readFile(join(runDir, 'out', 'server.cpuprofile'), 'utf8'));
const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const parents = new Map();
for (const node of nodes.values()) for (const child of node.children ?? []) parents.set(child, node.id);
const label = (node) => `${node.callFrame.functionName || '(anon)'} ${node.callFrame.url.replace(/^.*\/(packages|node_modules)\//, '$1/').replace(/^file:\/\/\//, '')}:${String(node.callFrame.lineNumber + 1)}`;
const regex = new RegExp(pattern);
const breakdown = new Map();
let total = 0;
let all = 0;
for (let i = 0; i < profile.samples.length; i += 1) {
  const us = profile.timeDeltas[i] ?? 0;
  all += us;
  const stack = [];
  for (let id = profile.samples[i]; id !== undefined; id = parents.get(id)) stack.push(id);
  stack.reverse();
  const at = stack.findIndex((id) => regex.test(label(nodes.get(id))));
  if (at < 0) continue;
  total += us;
  const below = stack.slice(at + 1).map((id) => label(nodes.get(id))).filter((name) => !/_base\/(event|errors)|eventBusService|instantiationService/.test(name));
  const key = below.slice(0, depth).join(' -> ') || '(self)';
  breakdown.set(key, (breakdown.get(key) ?? 0) + us);
}
console.log(`${pattern}: ${(total / all * 100).toFixed(2)}% of samples`);
for (const [key, us] of [...breakdown].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`${(us / all * 100).toFixed(2).padStart(6)}%  ${key}`);
