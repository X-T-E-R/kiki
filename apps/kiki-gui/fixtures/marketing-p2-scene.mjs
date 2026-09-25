/**
 * marketing-p2-scene — shared data for the P2 promotional screenshots
 * (D01–D08 + the task-board close-up).
 *
 * Everything here is fixture-server data on the real wire shapes; no product
 * component is bypassed and no presentation prop is injected. The composition
 * builders live in `marketing-p2-builders.mjs`; this module holds the seeds
 * they need: nb-search capabilities (D06/D07), scheduled tasks (D05) and the
 * owned sample recording (D08).
 *
 * The fictional project is the same `sample-app` workbench the P1 batch builds
 * (`marketing-builders.mjs`), so the whole set reads as one product.
 */

import { readFileSync } from 'node:fs';

/** Locale picker, mirroring the P1 builders. */
export function pick(locale, en, zh) {
  return locale === 'zh' ? zh : en;
}

/**
 * The sample video D08 attaches: a self-owned 12 s neutral "screen recording"
 * (960×540 H.264, ffmpeg 8.1). It was generated once from the two still layers
 * kept next to it (`page.png` = the scrolling content column, `cursor.png` = the
 * pointer), overlaid on a 12 s paper-coloured bed, then encoded with
 * `-c:v libx264 -pix_fmt yuv420p -crf 30 -movflags +faststart`. No product or
 * user session was recorded; the frame carries no text and no real data.
 */
const NAVIGATION_DEMO = new URL('./marketing-p2-assets/navigation-demo.mp4', import.meta.url);

let cachedNavigationDemoDataUrl;
let cachedNavigationDemoBytes;

/** `data:video/mp4;base64,…` for the seeded attachment (read once per process). */
export function navigationDemoDataUrl() {
  if (cachedNavigationDemoDataUrl === undefined) {
    cachedNavigationDemoDataUrl = `data:video/mp4;base64,${navigationDemoBytes().toString('base64')}`;
  }
  return cachedNavigationDemoDataUrl;
}

export function navigationDemoBytes() {
  cachedNavigationDemoBytes ??= readFileSync(NAVIGATION_DEMO);
  return cachedNavigationDemoBytes;
}

// ---------------------------------------------------------------------------
// nb-search capabilities (D06 lanes, D07 fetch chain)
// ---------------------------------------------------------------------------

/**
 * Secret-free nb-search capabilities seeded with the real lane ids and the
 * real provider descriptors of kiki's nb-search donor config
 * (packages/agent-core-v2/src/app/nbSearch/donorConfig.ts): the selected
 * default lane, two further ready lanes (one of them genuinely credential-free)
 * and the unconfigured Tavily lane, whose readiness reason renders from this
 * data instead of being asserted in prose. Lane ids, outputs, latency and cost
 * tiers are the product's own; nothing here claims a live provider call.
 */
export function p2NbSearchCapabilities() {
  return {
    schema_version: '3.0',
    revision: 'config-p2-nbsearch',
    providers: {
      descriptors: [
        { provider_id: 'github', adapter_version: '1', query_operations: [{ operation_id: 'repositories', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }], fetch_operations: [], activation: { credential: 'required', endpoint: 'none' }, option_keys: [] },
        { provider_id: 'exa', adapter_version: '1', query_operations: [{ operation_id: 'search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }], fetch_operations: [], activation: { credential: 'required', endpoint: 'optional' }, option_keys: ['user_location'] },
        { provider_id: 'duckduckgo', adapter_version: '1', query_operations: [{ operation_id: 'search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }], fetch_operations: [], activation: { credential: 'none', endpoint: 'none' }, option_keys: [] },
        { provider_id: 'context7', adapter_version: '1', query_operations: [{ operation_id: 'docs', output: { channel: 'typed', schema_id: 'nb-search.docs-context@1' }, built_in_async: true }], fetch_operations: [], activation: { credential: 'required', endpoint: 'none' }, option_keys: [] },
        { provider_id: 'tavily', adapter_version: '1', query_operations: [{ operation_id: 'search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }], fetch_operations: [{ operation_id: 'extract', output: { channel: 'markdown', schema_id: 'nb-search.markdown@1' } }], activation: { credential: 'required', endpoint: 'optional' }, option_keys: [] },
        { provider_id: 'jina-reader', adapter_version: '1', query_operations: [], fetch_operations: [{ operation_id: 'reader', output: { channel: 'markdown', schema_id: 'nb-search.markdown@1' } }], activation: { credential: 'none', endpoint: 'optional' }, option_keys: [] },
        { provider_id: 'direct-http', adapter_version: '1', query_operations: [], fetch_operations: [{ operation_id: 'fetch', output: { channel: 'markdown', schema_id: 'nb-search.markdown@1' } }], activation: { credential: 'none', endpoint: 'none' }, option_keys: [] },
      ],
      instances: [
        { id: 'github.default', provider_id: 'github', enabled: true, availability: 'ready', issues: [], credential: { requirement: 'required', configured: true, slot_id: 'github.default' }, endpoint: { requirement: 'none', configured: false } },
        { id: 'exa.default', provider_id: 'exa', enabled: true, availability: 'ready', issues: [], credential: { requirement: 'required', configured: true, slot_id: 'exa.default' }, endpoint: { requirement: 'optional', configured: false } },
        { id: 'duckduckgo.default', provider_id: 'duckduckgo', enabled: true, availability: 'ready', issues: [], credential: { requirement: 'none', configured: false }, endpoint: { requirement: 'none', configured: false } },
        { id: 'context7.default', provider_id: 'context7', enabled: true, availability: 'ready', issues: [], credential: { requirement: 'required', configured: true, slot_id: 'context7.default' }, endpoint: { requirement: 'none', configured: false } },
        { id: 'tavily.default', provider_id: 'tavily', enabled: false, availability: 'unavailable', issues: [{ code: 'CREDENTIAL_NOT_CONFIGURED' }, { code: 'PROVIDER_DISABLED' }], credential: { requirement: 'required', configured: false, slot_id: 'tavily.default' }, endpoint: { requirement: 'optional', configured: false } },
        { id: 'jina-reader.default', provider_id: 'jina-reader', enabled: true, availability: 'ready', issues: [], credential: { requirement: 'none', configured: false }, endpoint: { requirement: 'optional', configured: false } },
        { id: 'direct-http.default', provider_id: 'direct-http', enabled: true, availability: 'ready', issues: [], credential: { requirement: 'none', configured: false }, endpoint: { requirement: 'none', configured: false } },
      ],
    },
    search: {
      default_lane: 'github.repositories',
      lanes: [
        { id: 'github.repositories', output: { channel: 'results', schema_id: 'nb-search.results@1' }, execution_modes: ['sync', 'async'], availability: 'ready', issues: [], latency: 'fast', cost: 'free' },
        { id: 'exa.search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, execution_modes: ['sync', 'async'], availability: 'ready', issues: [], latency: 'fast', cost: 'cheap' },
        { id: 'duckduckgo.search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, execution_modes: ['sync', 'async'], availability: 'ready', issues: [], latency: 'medium', cost: 'free' },
        { id: 'tavily.search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, execution_modes: [], availability: 'unavailable', issues: [{ code: 'CREDENTIAL_NOT_CONFIGURED' }, { code: 'PROVIDER_DISABLED' }], latency: 'fast', cost: 'cheap' },
      ],
      presets: [],
      limits: { max_queries: 64, max_results: 100, max_timeout_ms: 3_600_000, max_inline_bytes: 16_777_216 },
    },
    fetch: {
      default_representation: 'markdown',
      inputs: [
        { kind: 'url', enabled: true, max_bytes: 2_097_152 },
        { kind: 'inline_text', enabled: true, max_bytes: 2_097_152, media_types: ['text/html', 'text/plain', 'text/markdown'] },
      ],
      chains: [{ input_kind: 'url', representation: 'markdown', pipelines: ['direct.fetch', 'jina.reader'] }],
      pipelines: [
        { id: 'tavily.extract', input_kinds: ['url'], media_types: ['text/html'], representations: ['markdown', 'text'], execution_modes: ['sync'], egress: 'url', stages: [{ id: 'tavily.default', role: 'extract' }], availability: 'unavailable', issues: [{ code: 'CREDENTIAL_NOT_CONFIGURED' }], latency: 'fast', cost: 'cheap' },
        { id: 'jina.reader', input_kinds: ['url'], media_types: ['text/html'], representations: ['markdown', 'text'], execution_modes: ['sync', 'async'], egress: 'url', stages: [{ id: 'jina-reader.default', role: 'reader' }], availability: 'ready', issues: [], latency: 'medium', cost: 'free' },
        { id: 'direct.fetch', input_kinds: ['url'], media_types: ['text/html', 'text/plain'], representations: ['markdown', 'text'], execution_modes: ['sync', 'async'], egress: 'url', stages: [{ id: 'direct-http.default', role: 'acquire' }], availability: 'ready', issues: [], latency: 'fast', cost: 'free' },
        { id: 'browser.render', input_kinds: ['url'], media_types: ['text/html'], representations: ['markdown', 'text'], execution_modes: ['async'], egress: 'url', stages: [{ id: 'browser-render.default', role: 'acquire' }], availability: 'ready', issues: [], latency: 'slow', cost: 'expensive' },
      ],
      limits: { max_source_bytes: 2_097_152, max_response_bytes: 2_097_152, max_content_chars: 200_000, max_redirects: 5, max_timeout_ms: 60_000, max_inline_bytes: 16_777_216 },
    },
    jobs: { result_ttl_seconds: 259_200, cancel_supported: true },
  };
}

/**
 * A saved nb-search config: one keyed default lane plus a three-step URL fetch
 * chain. The chain is a SAVED override (custom), not the inherited default
 * (`direct.fetch → jina.reader`), so the fetch tab renders it with its own
 * custom-chain badge instead of posing as the shipped default.
 */
export function p2NbSearchConfig() {
  return {
    defaults: {
      search_lane: 'github.repositories',
      fetch_chain: [
        { input_kind: 'url', representation: 'markdown', pipelines: ['tavily.extract', 'jina.reader', 'direct.fetch'] },
      ],
    },
    credential_slots: {
      'github.default': { provider_id: 'github', env: 'NB_SEARCH_GITHUB_TOKEN' },
      'exa.default': { provider_id: 'exa', env: 'NB_SEARCH_EXA_API_KEY' },
      'context7.default': { provider_id: 'context7', env: 'NB_SEARCH_CONTEXT7_API_KEY' },
      'tavily.default': { provider_id: 'tavily', env: 'NB_SEARCH_TAVILY_API_KEY' },
    },
  };
}

export function p2NbSearchTest() {
  return {
    revision: 'config-p2-nbsearch',
    search: { configured: true, available: true, selection: 'github.repositories', issues: [] },
    fetch: {
      configured: true,
      available: true,
      selection: 'tavily.extract -> jina.reader -> direct.fetch',
      issues: ['CREDENTIAL_NOT_CONFIGURED'],
    },
  };
}

export function p2NbSearchSourceConfig() {
  return {
    reuse_local_config: false,
    layers: ['defaults', 'environment', 'kiki'],
    local_config: 'ignored',
    local_credentials: 'ignored',
    credential_source: 'environment',
    availability: 'ready',
    issues: [],
  };
}

// ---------------------------------------------------------------------------
// Scheduled tasks (D05)
// ---------------------------------------------------------------------------

/**
 * Three plans across two sessions: an enabled recurring plan, an enabled
 * one-shot plan and a paused plan. `next_fire_at` is relative to capture time
 * so the "next fire" countdown is always in the future — a frozen timestamp
 * would read as overdue on a later run.
 */
export function p2CronTasks(locale) {
  const at = (minutesFromNow) => new Date(Date.now() + minutesFromNow * 60_000).toISOString();
  const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  return [
    {
      id: 'cron_p2_weekly_triage',
      session_id: 'sess_sample_prepare_release',
      workspace_id: 'wd_sample-app_000000000000',
      cron: '0 9 * * 1',
      human_schedule: pick(locale, 'Every Monday at 09:00', '每周一 09:00'),
      prompt_preview: pick(
        locale,
        'Summarize the sample-app issues opened since last Monday and draft the triage list.',
        '汇总上周一以来新开的 sample-app issue，并起草分诊清单。',
      ),
      next_fire_at: at(1_320),
      recurring: true,
      paused: false,
      age_days: 12,
      stale: false,
      created_at: ago(17_280),
      last_fired_at: ago(11_400),
    },
    {
      id: 'cron_p2_release_notes',
      session_id: 'sess_sample_review_accessibility',
      workspace_id: 'wd_sample-app_000000000000',
      cron: '30 18 * * *',
      human_schedule: pick(locale, 'Once, today at 18:30', '仅一次，今天 18:30'),
      prompt_preview: pick(
        locale,
        'Regenerate the sample-app release notes PDF from the changelog and attach it to the session.',
        '根据更新日志重新生成 sample-app 发布说明 PDF，并作为附件发到会话里。',
      ),
      next_fire_at: at(96),
      recurring: false,
      paused: false,
      age_days: 0,
      stale: false,
      created_at: ago(140),
      last_fired_at: null,
    },
    {
      id: 'cron_p2_nightly_docs',
      session_id: 'sess_sample_prepare_release',
      workspace_id: 'wd_sample-app_000000000000',
      cron: '0 3 * * *',
      human_schedule: pick(locale, 'Every day at 03:00', '每天 03:00'),
      prompt_preview: pick(
        locale,
        'Run the docs build for sample-app and report the first warning that mentions a broken link.',
        '跑一遍 sample-app 文档构建，并回报第一条提到失效链接的告警。',
      ),
      next_fire_at: null,
      recurring: true,
      paused: true,
      age_days: 31,
      stale: false,
      created_at: ago(44_640),
      last_fired_at: ago(2_880),
    },
  ];
}
