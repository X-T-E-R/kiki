/**
 * plugin-market — the official plugin market as a user first meets it.
 *
 * The catalog is seeded from the real `plugins/marketplace.json` rather than
 * hand-written, so a shot shows the shipped data: every official package, the
 * three community entries, the media family as one block, and the real icons.
 * The point of the scenario is that nothing here needs a client change to
 * appear, so a package added to the catalog shows up on its own.
 *
 * Covers: the whole market with no configuration, a workspace match lifted to
 * the top, search across the full list, a detail page for an uninstalled
 * package, the media plugin's own management entry, and the settings leaf.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sessionRecord } from './helpers.mjs';

const SID = 'session_fixture_plugin_market';
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OFFICIAL = join(REPO, 'plugins', 'official');
const CURATED_ICONS = join(REPO, 'plugins', 'curated');
/** The first-party source of record: icons are authored there and published
 *  from there, so a shot reads that tree rather than a copy of it. */
const PLUGINS_REPO = join(REPO, '..', 'kiki-plugins');
const OFFICIAL_SOURCE = join(PLUGINS_REPO, 'plugins', 'official');
const firstParty = new Set(JSON.parse(readFileSync(join(PLUGINS_REPO, 'plugins', 'marketplace.json'), 'utf8'))
  .plugins.filter((entry) => entry.source.startsWith('./official/')).map((entry) => entry.id));

const catalogData = JSON.parse(readFileSync(join(REPO, 'plugins', 'marketplace.json'), 'utf8'));
const digest = (id) => createDigest(id);

function createDigest(id) {
  // A stable, obviously-synthetic 64-hex digest per package: the shape the
  // installer verifies, not a real archive's bytes.
  const seed = [...id].reduce((hash, char) => (hash * 33 + char.charCodeAt(0)) >>> 0, 7);
  return seed.toString(16).padStart(8, '0').repeat(8);
}

function iconDataUri(path) {
  return `data:image/svg+xml;base64,${readFileSync(path).toString('base64')}`;
}

/** The first-party icon, read from the source repo when it has one. */
function officialIcon(id) {
  const authored = join(OFFICIAL_SOURCE, id, 'icon.svg');
  return existsSync(authored) ? iconDataUri(authored) : undefined;
}

/**
 * The icon an entry ships. A first-party package is found by its own id in the
 * source repo; anything else keeps whatever curated mark it already had, and
 * an entry with no icon at all is left without one so the drawn kind tile
 * stands in for it.
 */
function iconFor(entry) {
  if (firstParty.has(entry.id)) return officialIcon(entry.id);
  const curated = join(CURATED_ICONS, `${entry.id}.svg`);
  if (existsSync(curated)) return iconDataUri(curated);
  const local = join(OFFICIAL, entry.id, 'icon.svg');
  return existsSync(local) ? iconDataUri(local) : undefined;
}

function manifestOf(id) {
  return JSON.parse(readFileSync(join(firstParty.has(id) ? OFFICIAL_SOURCE : OFFICIAL, id, 'kimi.plugin.json'), 'utf8'));
}

const summary = (id, overrides = {}) => ({
  id,
  displayName: id,
  enabled: true,
  state: 'ok',
  skillCount: 0,
  mcpServerCount: 0,
  enabledMcpServerCount: 0,
  hookCount: 0,
  commandCount: 0,
  hasErrors: false,
  source: 'local-path',
  ...overrides,
});

/** The catalog exactly as the server would project it, install state aside. */
const CATALOG = catalogData.plugins.map((entry) => ({
  id: entry.id,
  tier: entry.tier,
  displayName: entry.displayName,
  description: entry.description,
  version: entry.version ?? '0.1.0',
  keywords: entry.keywords,
  icon: iconFor(entry),
  source: `C:/kiki/plugins/official/${entry.id}`,
  author: entry.author,
  license: entry.license,
  engines: { kiki: '^0.4.0' },
  ...(entry.group === undefined ? {} : { group: entry.group }),
  ...(entry.relevance === undefined ? {} : { relevance: entry.relevance }),
  // The catalog's own per-language text travels to the client like any other
  // metadata, so a window in another language shows the entry as translated
  // rather than half-translated around the edges.
  ...(entry.localizations === undefined ? {} : { localizations: entry.localizations }),
  // A published archive is identified by its digest; a local package is a
  // folder and needs none.
  ...(entry.tier === 'official' ? { sha256: digest(entry.id), installable: true } : { installable: true }),
}));

const WRITING = summary('kiki-writing', { displayName: 'Kiki Writing', version: manifestOf('kiki-writing').version, icon: officialIcon('kiki-writing'), commandCount: 1 });
const MEDIA = summary('kiki-media', { displayName: 'Kiki Media', version: manifestOf('kiki-media').version, icon: officialIcon('kiki-media') });

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: plugin market' })],
  snapshots: { [SID]: { messages: [], has_more: false } },
  config: {
    default_model: 'fixture/kiki-pro',
    // No marketplace address: the bundled official catalog is the normal case.
    plugins: {},
  },
  plugins: [WRITING, MEDIA],
  pluginInfos: {
    'kiki-writing': {
      ...WRITING,
      root: 'C:/Users/fixture/.kiki/plugins/managed/kiki-writing',
      installedAt: '2026-09-20T09:12:00.000Z',
      manifest: manifestOf('kiki-writing'),
      mcpServers: [],
      diagnostics: [],
    },
    'kiki-media': {
      ...MEDIA,
      root: 'C:/Users/fixture/.kiki/plugins/managed/kiki-media',
      installedAt: '2026-09-21T11:02:00.000Z',
      manifest: manifestOf('kiki-media'),
      mcpServers: [],
      diagnostics: [],
    },
  },
  pluginMarketplace: CATALOG,
  pluginRecommendations: ['kiki-office'],
  workspaces: [
    {
      id: 'wd_fixture_000000000000',
      root: 'C:/fixture',
      name: 'fixture',
      created_at: new Date().toISOString(),
      last_opened_at: new Date().toISOString(),
      session_count: 1,
      pinned: false,
    },
  ],
};
