/**
 * S2 visual proof — the advanced nb-search editors on their own.
 *
 * The tabs under test are pure: they take capabilities and the page draft as
 * props, so this script renders them through a disposable Vite page generated
 * into `apps/kiki-gui/.tmp/nbsearch-s2/` (gitignored) with real fixture values
 * and the real session-core helpers. That is the same mount the settings page
 * performs once it passes the draft down; it is not a copy of the page.
 *
 *   node scripts/visual-proof-nbsearch-s2.mjs
 *
 * Screenshots land in `.tmp/nbsearch-s2-shots/`. No network is touched: every
 * value is a fixture, and the key-status panel is served by an in-page stub.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS_DIR = join(ROOT, '.tmp', 'nbsearch-s2');
const OUT = join(ROOT, '.tmp', 'nbsearch-s2-shots');

const FIXTURE = `
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { NbSearchCapabilities, NbSearchConfigPatch, NbSearchKeyUsageView } from '@kiki/protocol';
import { nbSearchDraftFromConfig, setNbSearchFetchChain, type NbSearchDraft } from '@kiki/session-core/settings';
import '../../src/index.css';
import { I18nProvider } from '../../src/i18n';
import { NbSearchAdvancedTab } from '../../src/components/settings/nbSearch/NbSearchAdvancedTab';
import { NbSearchFetchTab } from '../../src/components/settings/nbSearch/NbSearchFetchTab';
import { NbSearchKeyUsagePanel } from '../../src/components/settings/nbSearch/NbSearchKeyUsagePanel';
import { NbSearchLanesTab } from '../../src/components/settings/nbSearch/NbSearchLanesTab';
import type { NbSearchAdvancedBinding } from '../../src/components/settings/nbSearch/advancedSupport';

const lane = (provider: string, operation: string, extra: Record<string, unknown>) => ({
  provider_instance_id: provider, operation_id: operation, latency: 'fast', cost: 'cheap', ...extra,
});

const CAPABILITIES: NbSearchCapabilities = {
  schema_version: '3.0',
  revision: 's2-visual-fixture',
  config_source: { reuse_local_config: true, layers: ['defaults', 'local', 'kiki'], local_config: 'present', availability: 'ready', issues: [] },
  configuration: {
    lanes: {
      'exa.search': lane('exa.default', 'search', { evidence_groups: ['exa'] }),
      'exa.synthesis': lane('exa.default', 'synthesis', { cost: 'expensive' }),
      'github.repositories': lane('github.default', 'repositories', { cost: 'free', evidence_groups: ['github'] }),
    },
    presets: {},
    provider_instance_ids: ['exa.default', 'github.default', 'tavily.default'],
    fetch_chains: [],
    file_scopes: [{ id: 'shared-docs', root: '/srv/shared/docs', media_types: ['text/plain'] }],
  },
  /**
   * The layers below Kiki. This is what makes a row source-provided; the catalogs
   * above only say what is in force. \`exa.local\` and \`fast\` are Kiki's own and
   * deliberately absent here even though the effective catalogs serve them: that
   * is the state a saved local entry is in after a reload.
   */
  inherited_configuration: {
    lanes: {
      'exa.search': lane('exa.default', 'search', { evidence_groups: ['exa'] }),
      'exa.synthesis': lane('exa.default', 'synthesis', { cost: 'expensive' }),
      'github.repositories': lane('github.default', 'repositories', { cost: 'free', evidence_groups: ['github'] }),
    },
    presets: { 'sources-first': { lanes: ['github.repositories', 'exa.search'] } },
    provider_instance_ids: ['exa.default', 'github.default', 'tavily.default', 'direct-http.default'],
    default_search_lane: 'github.repositories',
    fetch_chains: [
      { input_kind: 'url', representation: 'markdown', pipelines: ['direct.fetch', 'jina.reader'] },
      { input_kind: 'url', representation: 'text', pipelines: ['direct.fetch'] },
      { input_kind: 'inline_text', representation: 'markdown', pipelines: ['direct.local'] },
      { input_kind: 'inline_text', representation: 'text', pipelines: ['direct.local'] },
      { input_kind: 'inline_bytes', representation: 'markdown', pipelines: ['direct.local'] },
      { input_kind: 'inline_bytes', representation: 'text', pipelines: ['direct.local'] },
      { input_kind: 'file', representation: 'markdown', pipelines: ['direct.local'] },
      { input_kind: 'file', representation: 'text', pipelines: ['direct.local'] },
    ],
    file_scopes: [{ id: 'engine-docs', root: '/srv/docs', media_types: ['text/plain'] }],
  },
  providers: {
    descriptors: [
      { provider_id: 'exa', adapter_version: '1', query_operations: [
        { operation_id: 'search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true },
        { operation_id: 'synthesis', output: { channel: 'typed', schema_id: 'exa.synthesis@1' }, built_in_async: true },
      ], fetch_operations: [], activation: { credential: 'required', endpoint: 'optional' }, option_keys: [] },
      { provider_id: 'tavily', adapter_version: '1', query_operations: [
        { operation_id: 'search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true },
      ], fetch_operations: [], activation: { credential: 'required', endpoint: 'optional' }, option_keys: [] },
      { provider_id: 'github', adapter_version: '1', query_operations: [
        { operation_id: 'repositories', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true },
      ], fetch_operations: [], activation: { credential: 'none', endpoint: 'none' }, option_keys: [] },
      { provider_id: 'direct-http', adapter_version: '1', query_operations: [],
        fetch_operations: [{ operation_id: 'fetch' }, { operation_id: 'local' }],
        activation: { credential: 'none', endpoint: 'none' }, option_keys: [] },
    ],
    instances: [
      { id: 'exa.default', provider_id: 'exa', enabled: true, availability: 'ready', issues: [], credential: { requirement: 'required', configured: true, slot_id: 'exa.default' }, endpoint: { requirement: 'optional', configured: false } },
      { id: 'exa.local', provider_id: 'exa', enabled: true, availability: 'unavailable', issues: [{ code: 'CREDENTIAL_NOT_CONFIGURED' }], credential: { requirement: 'required', configured: false, slot_id: 'exa.local' }, endpoint: { requirement: 'optional', configured: false } },
      { id: 'tavily.default', provider_id: 'tavily', enabled: true, availability: 'ready', issues: [], credential: { requirement: 'required', configured: true, slot_id: 'tavily.default' }, endpoint: { requirement: 'optional', configured: false } },
      { id: 'github.default', provider_id: 'github', enabled: true, availability: 'ready', issues: [], credential: { requirement: 'none', configured: false }, endpoint: { requirement: 'none', configured: false } },
      { id: 'direct-http.default', provider_id: 'direct-http', enabled: true, availability: 'ready', issues: [], credential: { requirement: 'none', configured: false }, endpoint: { requirement: 'none', configured: false } },
    ],
  },
  search: {
    default_lane: 'exa.local',
    lanes: [
      { id: 'exa.local', output: { channel: 'results', schema_id: 'nb-search.results@1' }, execution_modes: [], availability: 'unavailable', issues: [{ code: 'CREDENTIAL_NOT_CONFIGURED' }], latency: 'fast', cost: 'cheap' },
      { id: 'exa.search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, execution_modes: ['sync', 'async'], availability: 'ready', issues: [], latency: 'fast', cost: 'cheap' },
      { id: 'exa.synthesis', output: { channel: 'typed', schema_id: 'exa.synthesis@1' }, execution_modes: ['async'], availability: 'ready', issues: [], latency: 'medium', cost: 'expensive' },
      { id: 'github.repositories', output: { channel: 'results', schema_id: 'nb-search.results@1' }, execution_modes: ['sync'], availability: 'ready', issues: [], latency: 'fast', cost: 'free' },
    ],
    presets: [
      { name: 'sources-first', lanes: ['github.repositories', 'exa.search'], execution_modes: ['sync'], availability: 'ready', issues: [] },
      { name: 'fast', lanes: ['exa.search', 'github.repositories'], execution_modes: ['sync'], availability: 'ready', issues: [] },
    ],
    limits: { max_queries: 64, max_results: 100, max_timeout_ms: 3600000, max_inline_bytes: 65536 },
  },
  fetch: {
    default_representation: 'markdown',
    inputs: [
      { kind: 'url', enabled: true, max_bytes: 2097152 },
      { kind: 'inline_text', enabled: true, max_bytes: 2097152 },
      { kind: 'inline_bytes', enabled: true, max_bytes: 2097152 },
      { kind: 'file', enabled: false, max_bytes: 2097152 },
    ],
    chains: [
      { input_kind: 'url', representation: 'markdown', pipelines: ['direct.fetch', 'jina.reader'] },
      { input_kind: 'url', representation: 'text', pipelines: ['direct.fetch'] },
      { input_kind: 'inline_text', representation: 'markdown', pipelines: ['direct.local'] },
      { input_kind: 'inline_text', representation: 'text', pipelines: ['direct.local'] },
      { input_kind: 'inline_bytes', representation: 'markdown', pipelines: ['direct.local'] },
      { input_kind: 'inline_bytes', representation: 'text', pipelines: ['direct.local'] },
      { input_kind: 'file', representation: 'markdown', pipelines: ['direct.local'] },
      { input_kind: 'file', representation: 'text', pipelines: ['direct.local'] },
    ],
    pipelines: [
      { id: 'direct.fetch', input_kinds: ['url'], media_types: ['text/html'], representations: ['markdown', 'text'], execution_modes: ['sync'], egress: 'url', stages: [{ id: 'direct-http', role: 'acquire' }], availability: 'ready', issues: [], latency: 'fast', cost: 'free' },
      { id: 'direct.local', input_kinds: ['inline_text', 'inline_bytes', 'file'], media_types: ['text/plain'], representations: ['markdown', 'text'], execution_modes: ['sync'], egress: 'none', stages: [{ id: 'direct-http', role: 'convert' }], availability: 'ready', issues: [], latency: 'fast', cost: 'free' },
      { id: 'jina.reader', input_kinds: ['url'], media_types: ['text/html'], representations: ['markdown', 'text'], execution_modes: ['sync'], egress: 'url', stages: [{ id: 'jina-reader', role: 'reader' }], availability: 'unavailable', issues: [{ code: 'LANE_NOT_CONFIGURED' }], latency: 'medium', cost: 'free' },
    ],
    limits: { max_source_bytes: 2097152, max_response_bytes: 2097152, max_content_chars: 200000, max_redirects: 5, max_timeout_ms: 60000, max_inline_bytes: 2097152 },
  },
  jobs: { result_ttl_seconds: 3600, cancel_supported: true },
};

const CONFIG = {
  schema_version: '4',
  home: '/srv/nb-search',
  log_level: 'warn',
  provider_instances: {
    'exa.default': { provider_id: 'exa', enabled: true },
    'exa.local': { provider_id: 'exa', enabled: true, credential_slot_id: 'exa.local' },
    'tavily.default': { provider_id: 'tavily', enabled: true, key_strategy: 'priority', balance_ttl_ms: 600000 },
  },
  credential_slots: { 'exa.local': { provider_id: 'exa', env: 'NB_SEARCH_EXA_LOCAL_API_KEY' } },
  lanes: { 'exa.local': { provider_instance_id: 'exa.default', operation_id: 'search', latency: 'fast', cost: 'cheap' } },
  presets: { fast: { lanes: ['exa.search', 'github.repositories'] } },
  defaults: { search_lane: 'exa.local', fetch_chain: [{ input_kind: 'url', representation: 'markdown', pipelines: ['direct.fetch', 'jina.reader'] }] },
  fetch: { file_scopes: [{ id: 'project-docs', root: '/srv/project/docs', media_types: ['text/markdown'] }] },
  execution: { search_timeout_ms: 30000, fetch: { max_content_chars: 200000, quality: { min_content_chars: 400, blocked_markers: ['Just a moment...'] } } },
} as unknown as NbSearchConfigPatch;

/** Offline stand-in for the typed key-usage read; no request leaves the page. */
const USAGE: Record<string, NbSearchKeyUsageView> = {
  'tavily.default': {
    provider_instance_id: 'tavily.default', provider_id: 'tavily', balance_supported: true,
    keys: [
      { key_index: 1, state: 'ready', usage: { scope: 'key', unit: 'credits', used: 1240, limit: 4000, remaining: 2760, checked_at: '2026-10-03T09:00:00Z' } },
      { key_index: 2, state: 'cooldown', cooldown_until: '2026-10-03T12:30:00Z', usage_error: 'unavailable' },
      { key_index: 3, state: 'exhausted', usage: { scope: 'team', unit: 'credits', used: 4000, limit: 4000, remaining: 0, checked_at: '2026-10-03T09:00:00Z' } },
    ],
  },
  'exa.default': {
    provider_instance_id: 'exa.default', provider_id: 'exa', balance_supported: false,
    keys: [
      { key_index: 1, state: 'ready' },
      { key_index: 2, state: 'unknown' },
    ],
  },
};

function KeyUsageView() {
  return (
    <div style={{ display: 'grid', gap: 24 }}>
      {['tavily.default', 'exa.default'].map((id) => (
        <section key={id} data-harness-panel={id} style={{ borderTop: '1px solid var(--kiki-hairline, rgba(0,0,0,.1))', paddingTop: 16 }}>
          <h2 style={{ margin: '0 0 8px', fontSize: 15, fontWeight: 600 }}>{id}</h2>
          <NbSearchKeyUsagePanel instanceId={id} readUsage={async () => USAGE[id]!} />
        </section>
      ))}
    </div>
  );
}

function Shell({ view }: { view: string }) {
  const [config, setConfig] = useState<NbSearchConfigPatch | undefined>(CONFIG);
  const [draft, setDraft] = useState<NbSearchDraft>(() => nbSearchDraftFromConfig(CONFIG, CAPABILITIES));
  const binding: NbSearchAdvancedBinding = { capabilities: CAPABILITIES, draft, config, onChange: setDraft };
  void setConfig;
  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: '32px 28px 120px' }} data-harness-view={view}>
      {view === 'lanes' ? (
        <NbSearchLanesTab
          capabilities={CAPABILITIES}
          defaultSearchLane={draft.defaultSearchLane}
          onSelectLane={() => undefined}
          advanced={binding}
        />
      ) : null}
      {view === 'fetch' ? (
        <NbSearchFetchTab
          capabilities={CAPABILITIES}
          fetchChain={draft.fetchChain}
          fetchChainInherited={draft.fetchChainInherited}
          onChangeChain={() => undefined}
          onToggleInherited={() => undefined}
          advanced={binding}
        />
      ) : null}
      {view === 'advanced' ? (
        <NbSearchAdvancedTab
          execution={draft.execution}
          testRun={{ status: 'idle' }}
          onUpdateExecution={(patch) => {
            setDraft((current) => ({ ...current, execution: { ...current.execution, ...patch } }));
          }}
          onRunCheck={() => undefined}
          onCancelCheck={() => undefined}
          advanced={binding}
        />
      ) : null}
      {view === 'keys' ? <KeyUsageView /> : null}
    </div>
  );
}

const view = new URLSearchParams(location.search).get('view') ?? 'lanes';
const locale = new URLSearchParams(location.search).get('locale') ?? 'zh';
try { localStorage.setItem('kiki.locale', locale); } catch {}
document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
createRoot(document.getElementById('root')!).render(
  <I18nProvider>
    <Shell view={view} />
  </I18nProvider>,
);
`;

const INDEX_HTML = `<!doctype html>
<html lang="zh">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>nb-search S2 harness</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
`;

async function writeHarness() {
  await mkdir(HARNESS_DIR, { recursive: true });
  await writeFile(join(HARNESS_DIR, 'index.html'), INDEX_HTML);
  await writeFile(join(HARNESS_DIR, 'main.tsx'), FIXTURE);
}

async function shoot(page, name, note) {
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  console.log(`[s2] shot ${name}${note === undefined ? '' : ` — ${note}`}`);
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await writeHarness();

  const server = await createServer({
    root: ROOT,
    configFile: join(ROOT, 'vite.config.ts'),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const webUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
  console.log(`[s2] harness at ${webUrl}`);

  const browser = await chromium.launch({ args: ['--no-proxy-server'] });
  const problems = [];
  try {
    const open = async (view, { width = 1440, height = 1000, theme = 'light', locale = 'zh' } = {}) => {
      const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 2,
        locale: locale === 'zh' ? 'zh-CN' : 'en-US',
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      page.on('pageerror', (error) => { console.error('[s2] page error:', error.message); });
      page.on('console', (message) => {
        if (message.type() === 'error') console.error('[s2] console:', message.text());
      });
      await page.goto(`${webUrl}/.tmp/nbsearch-s2/index.html?view=${view}&locale=${locale}`, { waitUntil: 'load' });
      await page.waitForSelector('[data-harness-view]');
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await page.waitForTimeout(250);
      return { context, page };
    };

    // ---- 1440, light, zh ------------------------------------------------
    {
      const { context, page } = await open('lanes');
      await shoot(page, '01-lanes-1440-light-zh');

      const row = page.locator('[data-nb-search-lane-row="exa.local"]');
      const text = await row.textContent();
      if (!text.includes('exa.local')) problems.push('the local method row does not show its id');
      const execution = await row.locator('[data-nb-search-lane-execution]').getAttribute('data-nb-search-lane-execution');
      if (execution !== 'none') problems.push(`a method with no execution modes read as "${execution}", expected none`);
      // The catalog serves this method and Kiki is the one that added it; the
      // layers below must not be credited with it.
      const localOrigin = await row.getAttribute('data-nb-search-lane-origin');
      if (localOrigin !== 'local') problems.push(`a method only Kiki declares read as "${localOrigin}", expected local`);
      const localBadge = await row.locator('[data-nb-search-lane-source-badge]').textContent();
      if (!localBadge.includes('仅本地')) problems.push(`the local method badge read "${localBadge}"`);
      const sourceRow = page.locator('[data-nb-search-lane-row="exa.search"]');
      const sourceOrigin = await sourceRow.getAttribute('data-nb-search-lane-origin');
      if (sourceOrigin !== 'source') problems.push(`a method the source provides read as "${sourceOrigin}", expected source`);
      const sourceBadge = await sourceRow.locator('[data-nb-search-lane-source-badge]').textContent();
      if (!sourceBadge.includes('来源提供')) problems.push(`the source method badge read "${sourceBadge}"`);

      await page.locator('[data-nb-search-lane-edit="exa.search"]').click();
      await page.locator('[data-nb-search-lane-override]').click();
      await page.waitForSelector('[data-nb-search-lane-editor="exa.search"] input');
      await shoot(page, '02-lane-editor-override-1440-light-zh');
      await context.close();
    }
    {
      const { context, page } = await open('lanes');
      // A method only Kiki declares: edited in place, deletable, nothing to restore.
      await page.locator('[data-nb-search-lane-edit="exa.local"]').click();
      await page.waitForSelector('[data-nb-search-lane-editor="exa.local"] input');
      const editor = page.locator('[data-nb-search-lane-editor="exa.local"]');
      const editorSource = await editor.getAttribute('data-nb-search-lane-source');
      if (editorSource !== 'local') problems.push(`the local method editor read as "${editorSource}"`);
      if (await editor.locator('[data-nb-search-lane-override]').count() !== 0) problems.push('the local method offered an override');
      if (await editor.locator('[data-nb-search-lane-restore]').count() !== 0) problems.push('the local method offered a source restore');
      if (await editor.locator('[data-nb-search-lane-remove]').count() !== 1) problems.push('the local method did not offer deletion');
      await shoot(page, '02b-lane-editor-local-1440-light-zh');
      await context.close();
    }
    {
      const { context, page } = await open('lanes');
      await page.locator('[data-nb-search-presets]').scrollIntoViewIfNeeded();
      const fastOrigin = await page.locator('[data-nb-search-preset-row="fast"]').getAttribute('data-nb-search-preset-origin');
      if (fastOrigin !== 'local') problems.push(`a preset only Kiki declares read as "${fastOrigin}", expected local`);
      const sourcesFirstOrigin = await page.locator('[data-nb-search-preset-row="sources-first"]').getAttribute('data-nb-search-preset-origin');
      if (sourcesFirstOrigin !== 'source') problems.push(`a preset the source provides read as "${sourcesFirstOrigin}", expected source`);
      await page.locator('[data-nb-search-preset-row="fast"] [data-nb-search-preset-open]').click();
      await page.waitForSelector('[data-nb-search-preset-editor="fast"]');
      const presetSource = await page.locator('[data-nb-search-preset-editor="fast"]').getAttribute('data-nb-search-preset-source');
      if (presetSource !== 'local') problems.push(`the local preset editor read as "${presetSource}"`);
      await shoot(page, '03-preset-editor-1440-light-zh');
      await context.close();
    }
    {
      const { context, page } = await open('fetch');
      const steps = await page.locator('[data-nb-search-fetch-chain] > li').count();
      if (steps !== 2) problems.push(`the fetch tab showed ${steps} steps for url→markdown, expected 2`);
      // The saved config already overrides url→markdown, so the all-pairs
      // restore is offered and names how many pairs left the source order.
      if (await page.locator('[data-nb-search-fetch-restore-all]').count() !== 1) {
        problems.push('the all-pairs restore was not offered for a saved chain override');
      }
      const snapshot = await page.locator('[data-nb-search-fetch-snapshot]').textContent();
      if (!snapshot.includes('1')) problems.push(`the snapshot line did not name 1 pair, saw "${snapshot}"`);

      // Per-pair: back to the source order, then Kiki order again.
      await page.locator('[data-nb-search-fetch-restore]').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-nb-search-fetch-restore-all]').length === 0);
      const mode = await page.locator('[data-nb-search-fetch-mode]').getAttribute('data-nb-search-fetch-mode');
      if (mode !== 'source') problems.push(`after the per-pair restore the tab read "${mode}", expected source`);
      await page.locator('[data-nb-search-fetch-customize]').click();
      await page.waitForSelector('[data-nb-search-fetch-restore-all]');
      await page.locator('[data-nb-search-fetch-remove]').nth(1).click();
      await page.locator('details:has([data-nb-search-fetch-snapshot-note]) > summary').click();
      await shoot(page, '04-fetch-snapshot-1440-light-zh');
      await context.close();
    }
    {
      const { context, page } = await open('advanced');
      await page.locator('[data-nb-search-filescope-add]').click();
      await shoot(page, '05-advanced-scopes-quality-1440-light-zh');
      await page.locator('[data-nb-search-quality-mode="custom"]').click();
      await page.locator('[data-nb-search-quality-add]').click();
      await page.locator('[data-nb-search-quality-new]').fill('Attention Required');
      await page.locator('[data-nb-search-quality-new]').press('Enter');
      await shoot(page, '06-advanced-quality-markers-1440-light-zh');
      await context.close();
    }
    {
      const { context, page } = await open('keys');
      if (await page.locator('[data-nb-search-key-usage-result]').count() !== 0) {
        problems.push('the key-status panel read the server before the user asked');
      }
      await shoot(page, '07a-keys-idle-1440-light-zh');
      await page.locator('[data-harness-panel="tavily.default"] [data-nb-search-key-usage-load]').click();
      await page.locator('[data-harness-panel="exa.default"] [data-nb-search-key-usage-load]').click();
      await page.waitForSelector('[data-nb-search-key-usage-keys]');
      const exaText = await page.locator('[data-harness-panel="exa.default"]').textContent();
      if (!exaText.includes('不提供额度查询')) problems.push('a provider without a balance was not said to have none');
      await shoot(page, '07-keys-usage-1440-light-zh');
      await context.close();
    }

    // ---- 390 ------------------------------------------------------------
    for (const [view, name] of [['lanes', '08-lanes-390-light-zh'], ['fetch', '09-fetch-390-light-zh'], ['advanced', '10-advanced-390-light-zh']]) {
      const { context, page } = await open(view, { width: 390, height: 844 });
      if (view === 'advanced') await page.locator('[data-nb-search-filescope-add]').click();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) problems.push(`${view} overflows at 390 by ${overflow}px`);
      await shoot(page, name);
      await context.close();
    }

    // ---- dark -----------------------------------------------------------
    {
      const { context, page } = await open('lanes', { theme: 'dark' });
      await page.locator('[data-nb-search-lane-edit="exa.search"]').click();
      await page.locator('[data-nb-search-lane-override]').click();
      await page.waitForSelector('[data-nb-search-lane-editor="exa.search"] input');
      await shoot(page, '11-lane-editor-1440-dark-zh');
      await context.close();
    }
    {
      const { context, page } = await open('advanced', { theme: 'dark', width: 390, height: 844 });
      await page.locator('[data-nb-search-filescope-add]').click();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) problems.push(`advanced dark at 390 overflows by ${overflow}px`);
      await shoot(page, '12-advanced-390-dark-zh');
      await context.close();
    }
    {
      const { context, page } = await open('fetch', { theme: 'dark', locale: 'en' });
      // One pair left the source order: the line has to read as one pair.
      const snapshot = await page.locator('[data-nb-search-fetch-snapshot]').textContent();
      if (!snapshot.includes('1 pair uses the Kiki order')) problems.push(`the English snapshot line read "${snapshot}"`);
      await page.locator('details:has([data-nb-search-fetch-snapshot-note]) > summary').click();
      await shoot(page, '13-fetch-1440-dark-en');
      await context.close();
    }
  } catch (error) {
    console.error('[s2] run error:', error);
    problems.push(String(error));
  } finally {
    await browser.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }

  if (problems.length > 0) {
    console.error('[s2] FAILED');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`[s2] PROOF DONE -> ${OUT}`);
}

await main();
