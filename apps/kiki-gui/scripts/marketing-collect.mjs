/**
 * marketing-collect — copy captured campaign frames into the two tracked
 * locations the public surfaces read from.
 *
 *   node scripts/marketing-collect.mjs --from=<campaign output dir> --to=docs
 *   node scripts/marketing-collect.mjs --from=<dir> --to=marketing --dry-run
 *
 * There is exactly one master for each frame: marketing/shots. The docs site
 * gets a copy under docs/public/shots, because a VitePress page cannot read
 * outside its own public root, and a symlink would not survive the npm/SEA
 * packaging step. The copy is one-directional and this script is the only
 * thing that performs it, so the two trees cannot drift by accident.
 *
 * Naming: campaign frames are `<slug>.<locale>.<theme>.png` and land in the
 * docs tree as `shots/<page>/<slug>.<locale>.png` — the theme is dropped
 * because a docs page shows one image, and the light master is the one it
 * wants. The dark hero is a README concern and is never copied into docs.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/ lives in apps/kiki-gui/scripts, so three levels up is the repo root
// (apps/kiki-gui → apps → kiki). Two would land in apps/, which silently
// creates a phantom apps/docs next to the real one.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const arg = (name, fallback) => {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found === undefined ? fallback : found.slice(name.length + 3);
};

const from = resolve(arg('from', join(ROOT, '.tmp', 'marketing-campaign')));
const target = arg('to', 'docs');
const dryRun = process.argv.includes('--dry-run');

const MARKETING_DIR = join(ROOT, 'marketing', 'shots');
const DOCS_DIR = join(ROOT, 'docs', 'public', 'shots');

/**
 * Which docs page each frame belongs to. The frame slug is the source of
 * truth: the runner names frames `<page>-<what>`, so the page is the slug up
 * to the first hyphen. A frame with no page keeps its own directory.
 */
const PAGE_OF = new Map([
  ['hero-workbench', 'index'],
  ['workbench-per-role-models', 'workbench'],
  ['workbench-background-tasks', 'workbench'],
  ['long-work-goal-queue', 'long-work'],
  ['long-work-context-fresh', 'long-work'],
  ['long-work-memory-scopes', 'long-work'],
  ['daily-usage', 'daily'],
  ['people-persona-card', 'people'],
  ['people-daily-conversation', 'people'],
  ['people-room', 'people'],
  ['spaces-spaces-list', 'spaces'],
  ['spaces-remote-connections', 'spaces'],
  ['spaces-web-access', 'spaces'],
  ['freedom-connections', 'freedom'],
  ['freedom-prompt-overrides', 'freedom'],
  ['ecosystem-history-import', 'ecosystem'],
  ['look-skins', 'look'],
]);

function parse(name) {
  const match = /^(?<slug>.+)\.(?<locale>en|zh)\.(?<theme>light|dark)\.png$/.exec(name);
  if (match === null) return null;
  return { slug: match.groups.slug, locale: match.groups.locale, theme: match.groups.theme };
}

function main() {
  if (!existsSync(from)) throw new Error(`no captured frames at ${from}`);
  const files = readdirSync(from).filter((name) => name.endsWith('.png') && !name.includes('.FAIL.'));
  const copied = [];
  const skipped = [];
  for (const name of files) {
    const parts = parse(name);
    if (parts === null) { skipped.push(`${name} (unrecognized name)`); continue; }
    if (target === 'docs' && parts.theme === 'dark') { skipped.push(`${name} (dark master is a README frame)`); continue; }
    const source = join(from, name);
    if (statSync(source).size === 0) { skipped.push(`${name} (empty)`); continue; }
    const destination = target === 'marketing'
      ? join(MARKETING_DIR, name)
      : join(DOCS_DIR, PAGE_OF.get(parts.slug) ?? 'misc', `${parts.slug}.${parts.locale}.png`);
    copied.push({ source, destination });
  }
  for (const item of copied) {
    if (dryRun) { console.log(`[collect:dry] ${item.source} -> ${item.destination}`); continue; }
    mkdirSync(dirname(item.destination), { recursive: true });
    copyFileSync(item.source, item.destination);
    console.log(`[collect] ${item.destination}`);
  }
  for (const line of skipped) console.log(`[collect:skip] ${line}`);
  console.log(`[collect] ${copied.length} copied, ${skipped.length} skipped, into ${target}`);
}

main();
