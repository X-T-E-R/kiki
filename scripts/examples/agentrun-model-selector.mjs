import { readFile } from 'node:fs/promises';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
  throw new Error('No eligible model candidates');
}
const snapshotPath = process.argv[2];
const scores = snapshotPath === undefined ? undefined : JSON.parse(await readFile(snapshotPath, 'utf8')).scores;
if (snapshotPath !== undefined && (typeof scores !== 'object' || scores === null || Array.isArray(scores))) {
  throw new Error('Snapshot must contain a scores object keyed by model alias');
}
let best;
let bestScore = 0;
for (const candidate of input.candidates) {
  const score = scores === undefined ? 1 : scores[candidate.alias] ?? 0;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0) {
    throw new Error('Model scores must be finite nonnegative numbers');
  }
  if (score > bestScore) {
    best = candidate.alias;
    bestScore = score;
  }
}
if (best === undefined) throw new Error('No eligible candidate has a positive score');
process.stdout.write(JSON.stringify({ model_alias: best }));
