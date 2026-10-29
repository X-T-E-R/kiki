import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const [runDir, levelArg] = process.argv.slice(2);
const level = Number(levelArg ?? 1);
const profile = JSON.parse(await readFile(join(runDir, 'out', 'server.cpuprofile'), 'utf8'));
const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const parents = new Map();
for (const node of nodes.values()) for (const child of node.children ?? []) parents.set(child, node.id);
const label = (node) => `${node.callFrame.functionName || '(anon)'} ${node.callFrame.url.replace(/^.*\/(packages|node_modules)\//, '$1/').replace(/^file:\/\/\//, '')}`;
const skip = /_base\/(event|errors|di)|eventBusService|instantiationService|eventDispatcherService|node_modules|^\(anon\) $|node:/;
const buckets = new Map();
let all = 0;
for (let i = 0; i < profile.samples.length; i += 1) {
  const us = profile.timeDeltas[i] ?? 0;
  all += us;
  const stack = [];
  for (let id = profile.samples[i]; id !== undefined; id = parents.get(id)) stack.push(label(nodes.get(id)));
  stack.reverse();
  const repo = stack.filter((name) => /packages\//.test(name) && !skip.test(name));
  const leaf = stack[stack.length - 1];
  const key = repo.length === 0 ? `[native] ${leaf}` : repo.slice(0, level).join(' > ');
  buckets.set(key, (buckets.get(key) ?? 0) + us);
}
for (const [key, us] of [...buckets].sort((a, b) => b[1] - a[1]).slice(0, Number(process.argv[4] ?? 40))) console.log(`${(us / all * 100).toFixed(2).padStart(6)}%  ${key}`);
