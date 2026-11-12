/**
 * marketing-collect — copy captured campaign frames into the canonical
 * screenshot store under docs/public/shots.
 *
 *   node scripts/marketing-collect.mjs --from=<campaign output dir>
 *   node scripts/marketing-collect.mjs --from=<dir> --dry-run
 *
 * `docs/public/shots` is the single canonical screenshot tree for both the
 * VitePress docs site and the repository README / marketing pages.
 *
 * Naming: captured frames are `<slug>.<locale>.<theme>.png`. Light frames land
 * as `docs/public/shots/<page>/<canonical-slug>.<locale>.png`; dark frames land
 * as `docs/public/shots/theme-dark/<canonical-slug>.<locale>.dark.png`.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileURLToPath as pathFromUrl } from 'node:url';

// scripts/ lives in apps/kiki-gui/scripts, so three levels up is the repo root
// (apps/kiki-gui → apps → kiki). Two would land in apps/, which silently
// creates a phantom apps/docs next to the real one.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const arg = (name, fallback) => {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found === undefined ? fallback : found.slice(name.length + 3);
};

const DOCS_DIR = join(ROOT, 'docs', 'public', 'shots');

/**
 * Canonical docs-tree destination for each runner frame slug. Runners whose
 * dated series names include a `20261005-` prefix on disk map here so repeated
 * collections overwrite the existing public paths in place.
 */
const CANONICAL_SLUGS = new Map([
  ['h01-fleet-workbench', 'hero-workbench'],
  ['r05-multi-model-fleet', 'workbench-per-role-models'],
  ['r02-goal-queue', 'long-work-goal-queue'],
  ['wl-hero-workbench', 'wl-20261005-hero-workbench'],
  ['wl-workbench-fleet', 'wl-20261005-workbench-fleet'],
  ['wl-workbench-subagent', 'wl-20261005-workbench-subagent'],
  ['wl-workbench-tasks', 'wl-20261005-workbench-tasks'],
  ['wl-subagent-rail-detail', 'wl-20261005-subagent-rail-detail'],
  ['wl-longwork-goal-queue', 'wl-20261005-longwork-goal-queue'],
  ['wl-longwork-scheduled', 'wl-20261005-longwork-scheduled'],
  ['wl-longwork-context', 'wl-20261005-longwork-context'],
  ['wl-longwork-board', 'wl-20261005-longwork-board'],
  ['ce-freedom-oauth-device', 'ce-20261005-freedom-oauth-device'],
  ['ce-freedom-oauth-reuse', 'ce-20261005-freedom-oauth-reuse'],
  ['ce-freedom-permission-modes', 'ce-20261005-freedom-permission-modes'],
  ['ce-freedom-prompt-overrides', 'ce-20261005-freedom-prompt-overrides'],
  ['ce-extend-plugins', 'ce-20261005-extend-plugins'],
  ['ce-extend-skills', 'ce-20261005-extend-skills'],
  ['ce-extend-mcp', 'ce-20261005-extend-mcp'],
  ['ce-extend-search-source', 'ce-20261005-extend-search-source'],
  ['ce-extend-search-lanes', 'ce-20261005-extend-search-lanes'],
  ['ce-extend-fetch-chain', 'ce-20261005-extend-fetch-chain'],
  ['ce-ecosystem-engines', 'ce-20261005-ecosystem-engines'],
  ['ce-ecosystem-import-sources', 'ce-20261005-ecosystem-import-sources'],
  ['ps-people-memory', 'ps-20261005-people-memory'],
  ['ps-people-execution', 'ps-20261005-people-execution'],
  ['ps-people-room-threads', 'ps-20261005-people-room-threads'],
  ['ps-people-room-paused', 'ps-20261005-people-room-paused'],
  ['ps-spaces-list', 'ps-20261005-spaces-list'],
  ['ps-spaces-detail', 'ps-20261005-spaces-detail'],
  ['ps-spaces-credentials', 'ps-20261005-spaces-credentials'],
  ['ps-spaces-remote', 'ps-20261005-spaces-remote'],
  ['ps-spaces-inbound', 'ps-20261005-spaces-inbound'],
  ['ps-spaces-web-access', 'ps-20261005-spaces-web-access'],
  ['ps-spaces-session-ssh', 'ps-20261005-spaces-session-ssh'],
]);

const PAGE_OF = new Map([
  ['hero-workbench', 'index'],
  ['wl-20261005-hero-workbench', 'index'],
  ['workbench-per-role-models', 'workbench'],
  ['workbench-background-tasks', 'workbench'],
  ['wl-20261005-workbench-fleet', 'workbench'],
  ['wl-20261005-workbench-subagent', 'workbench'],
  ['wl-20261005-workbench-tasks', 'workbench'],
  ['wl-20261005-subagent-rail-detail', 'workbench'],
  ['d01-agent-preview', 'workbench'],
  ['d03-tasks-page', 'workbench'],
  ['long-work-goal-queue', 'long-work'],
  ['long-work-context-fresh', 'long-work'],
  ['long-work-memory-scopes', 'long-work'],
  ['wl-20261005-longwork-goal-queue', 'long-work'],
  ['wl-20261005-longwork-scheduled', 'long-work'],
  ['wl-20261005-longwork-context', 'long-work'],
  ['wl-20261005-longwork-board', 'long-work'],
  ['d05-cron-panel', 'long-work'],
  ['r04-task-board', 'long-work'],
  ['board-task-detail', 'long-work'],
  ['daily-usage', 'daily'],
  ['ux-usage-live', 'daily'],
  ['ux-usage-export', 'daily'],
  ['d04-tool-steps-notification', 'daily'],
  ['d08-video-attachment', 'daily'],
  ['people-persona-card', 'people'],
  ['people-daily-conversation', 'people'],
  ['people-room', 'people'],
  ['ps-people-execution-detail', 'people'],
  ['ps-20261005-people-memory', 'people'],
  ['ps-20261005-people-execution', 'people'],
  ['ps-20261005-people-room-threads', 'people'],
  ['ps-20261005-people-room-paused', 'people'],
  ['spaces-spaces-list', 'spaces'],
  ['spaces-remote-connections', 'spaces'],
  ['spaces-web-access', 'spaces'],
  ['ps-20261005-spaces-list', 'spaces'],
  ['ps-20261005-spaces-detail', 'spaces'],
  ['ps-20261005-spaces-credentials', 'spaces'],
  ['ps-20261005-spaces-remote', 'spaces'],
  ['ps-20261005-spaces-inbound', 'spaces'],
  ['ps-20261005-spaces-web-access', 'spaces'],
  ['ps-20261005-spaces-session-ssh', 'spaces'],
  ['agents-profiles', 'agents'],
  ['agents-profile-editor', 'agents'],
  ['agents-profile-picker', 'agents'],
  ['r01-reviewer-profile', 'agents'],
  ['freedom-connections', 'freedom'],
  ['freedom-prompt-overrides', 'freedom'],
  ['d02-prompt-fields', 'freedom'],
  ['ce-20261005-freedom-oauth-device', 'freedom'],
  ['ce-20261005-freedom-oauth-reuse', 'freedom'],
  ['ce-20261005-freedom-permission-modes', 'freedom'],
  ['ce-20261005-freedom-prompt-overrides', 'freedom'],
  ['extend-search-lanes', 'extend'],
  ['d06-search-lanes', 'extend'],
  ['d07-fetch-chain', 'extend'],
  ['ce-20261005-extend-plugins', 'extend'],
  ['ce-20261005-extend-skills', 'extend'],
  ['ce-20261005-extend-mcp', 'extend'],
  ['ce-20261005-extend-search-source', 'extend'],
  ['ce-20261005-extend-search-lanes', 'extend'],
  ['ce-20261005-extend-fetch-chain', 'extend'],
  ['ecosystem-history-import', 'ecosystem'],
  ['ce-20261005-ecosystem-engines', 'ecosystem'],
  ['ce-20261005-ecosystem-import-sources', 'ecosystem'],
  ['look-skins', 'look'],
]);

export function parseFrameName(name) {
  const match = /^(?<slug>.+)\.(?<locale>en|zh)\.(?<theme>light|dark)\.png$/.exec(name);
  if (match === null) return null;
  return { slug: match.groups.slug, locale: match.groups.locale, theme: match.groups.theme };
}

export function resolveShotDestination(name, docsDir = DOCS_DIR) {
  const parts = parseFrameName(name);
  if (parts === null) return null;
  const canonicalSlug = CANONICAL_SLUGS.get(parts.slug) ?? parts.slug;
  if (parts.theme === 'dark') {
    return join(docsDir, 'theme-dark', `${canonicalSlug}.${parts.locale}.dark.png`);
  }
  const pageDir = PAGE_OF.get(canonicalSlug) ?? 'misc';
  return join(docsDir, pageDir, `${canonicalSlug}.${parts.locale}.png`);
}

export function collectFrames(fromDir, { docsDir = DOCS_DIR, dryRun = false } = {}) {
  if (!existsSync(fromDir)) throw new Error(`no captured frames at ${fromDir}`);
  const files = readdirSync(fromDir).filter((name) => name.endsWith('.png') && !name.includes('.FAIL.'));
  const copied = [];
  const skipped = [];
  for (const name of files) {
    const destination = resolveShotDestination(name, docsDir);
    if (destination === null) {
      skipped.push(`${name} (unrecognized name)`);
      continue;
    }
    const source = join(fromDir, name);
    if (statSync(source).size === 0) {
      skipped.push(`${name} (empty)`);
      continue;
    }
    copied.push({ source, destination });
  }
  for (const item of copied) {
    if (dryRun) {
      console.log(`[collect:dry] ${item.source} -> ${item.destination}`);
      continue;
    }
    mkdirSync(dirname(item.destination), { recursive: true });
    copyFileSync(item.source, item.destination);
    console.log(`[collect] ${item.destination}`);
  }
  for (const line of skipped) console.log(`[collect:skip] ${line}`);
  console.log(`[collect] ${copied.length} copied, ${skipped.length} skipped, into ${docsDir}`);
  return { copied, skipped };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(pathFromUrl(import.meta.url))) {
  const from = resolve(arg('from', join(ROOT, '.tmp', 'marketing-campaign')));
  const dryRun = process.argv.includes('--dry-run');
  collectFrames(from, { dryRun });
}
