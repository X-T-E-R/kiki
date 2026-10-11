/**
 * ux-20261006-scene — the scenario seeds for the usage screenshot set
 * (2026-10-06): the usage page's three readings, and the external-sync
 * destinations list.
 *
 * Why a separate module: the Features-series campaign seeds are owned work in
 * flight, and this set needs a world the existing ones do not provide. The
 * `daily-usage` frame already ships a real History tab, so that frame is not
 * reshot here; what the page claims and no frame yet shows is the OTHER two
 * tabs and the third one. A reader cannot see "who is queued, and which rule
 * holds them" or "where the statistics go" from a seven-day bar chart, and a
 * features page spends three sentences on exactly those.
 *
 * Everything here is the same neutral world the other public frames use: the
 * fictional `sample-app` project, its four-session roster, and the same model
 * catalog. Two additions, both data over routes that already exist:
 *
 *   1. `requestGovernance` — the snapshot `/api/usage/realtime` answers. Two
 *      rules, one enabled and one paused, and one waiting request naming the
 *      rule that holds it: a frame whose waiting list is empty would not
 *      support the claim it is shot for. The paused rule is deliberate — the
 *      prose says a switch pauses a rule without deleting it, and a list that
 *      only holds enabled rules cannot show that.
 *   2. `usageExport` — three destinations, one per kind the product supports,
 *      each in a different state: active, paused, and one whose credential was
 *      refused. Endpoints are `example.test`, labels are the kind a reader
 *      would give them, and no key, fingerprint, or account is real. The
 *      refusal row is what makes the frame honest: a list of three green rows
 *      would imply a setup that only works.
 *
 * Locale discipline is the same as marketing-campaign-scene.mjs: identical ids
 * and structure between en and zh, translated visible copy only. The thin
 * `ux-20261006-<id>-<locale>.scenario.mjs` entry points call `build<Id>(locale)`.
 *
 * These are fixture-server wire shapes (see helpers.mjs). No product code is
 * involved, and nothing here reaches the network or a real Kiki home.
 */

import { sessionRecord, ts } from './helpers.mjs';
import {
  ROLE_BINDING,
  SAMPLE_ROOT,
  SESSION,
  WORKSPACE_ID,
  sampleConfig,
  sampleModels,
  sampleProviders,
  sampleWorkspace,
} from './marketing-scene.mjs';

/** The fictional project every frame shows, same as the 2026-10-04/05 sets. */
export const PROJECT_ROOT = SAMPLE_ROOT;
export const PROJECT = 'sample-app';

const HALF_HOUR = 1_800_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const pick = (locale, en, zh) => (locale === 'zh' ? zh : en);

/** Anchored to the fixture clock, so a walk at any hour reads as recent. */
const now = () => Date.parse(ts(0));
const floorHalf = (ms) => Math.floor(ms / HALF_HOUR) * HALF_HOUR;

// ---------------------------------------------------------------------------
// Governance — the Live tab
// ---------------------------------------------------------------------------

/**
 * The model ids are the catalog keys this world already ships, because a
 * concurrency rule selects on exactly that string: a frame showing a friendly
 * display name where the rule editor would reject it would be showing
 * something the product does not do.
 */
const MODELS = {
  k3: ROLE_BINDING.main.id,
  fable: 'claude-fable-5',
  flash: 'deepseek-v4-flash',
};

/**
 * U1. Three running requests, one waiting.
 *
 * The waiting row is the reason this frame exists: it names `kimi-cap` as the
 * rule holding it, so the pair of facts the page claims — a request is waiting,
 * and a specific rule is why — is legible in one screenshot. Counts per
 * dimension sum to the header's totals, and the per-session bucket is omitted
 * on purpose because the panel filters it out.
 */
function governance() {
  return {
    domainId: 'this-service',
    runtimeEpoch: 'ep-ux-20261006',
    seq: 12,
    asOf: ts(0),
    coverage: { native: 'managed', external: 'unmanaged' },
    active: 3,
    queued: 1,
    dimensions: [
      { dimension: 'model', id: MODELS.k3, active: 2, queued: 1 },
      { dimension: 'model', id: MODELS.fable, active: 1, queued: 0 },
      { dimension: 'provider', id: 'kimi-code', active: 2, queued: 1 },
      { dimension: 'provider', id: 'anthropic', active: 1, queued: 0 },
      { dimension: 'role', id: 'root/system', active: 2, queued: 0 },
      { dimension: 'role', id: 'subagent', active: 1, queued: 1 },
    ],
    // The first rule is what holds the waiting request above. The second is
    // paused, not deleted: the summary line then shows a rule that still
    // exists and still has a cap, without applying.
    rules: [
      {
        id: 'kimi-cap', resource: 'model_request', scope: 'global', providers: ['kimi-code'],
        subagentsOnly: false, maxConcurrent: 2, overflow: 'queue', enabled: true,
      },
      {
        id: 'session-children', resource: 'model_request', scope: 'each_session', subagentsOnly: true,
        maxConcurrent: 1, maxWaitMs: 60_000, overflow: 'reject', enabled: false,
      },
    ],
    // The waiting list is the same array the header's `queued` counts and the
    // per-dimension rows sum over (see `snapshot()` in
    // requestGovernanceService.ts: `queued: this.waiting.length`, and every
    // dimension row incremented once per waiting attempt). So the counts and
    // this list have to agree: one waiting request, and `kimi-cap` as the rule
    // holding it. A second row with no blocking rule could never be waiting —
    // an unblocked attempt is admitted immediately — and a header reading 1
    // over two rows is the exact arithmetic a reader checks first on a
    // counting page.
    waiting: [
      {
        attemptId: 'attempt-ux-0001', sessionId: SESSION.release, agentId: 'agent-ux-builder',
        modelId: MODELS.k3, providerId: 'kimi-code', purpose: 'turn', waitedMs: 41_000,
        blockingRules: ['kimi-cap'],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// External sync — the export tab
// ---------------------------------------------------------------------------

/** Fixture-server opaque ids: the product parses these on the wire. */
const STREAM = (seed) => seed.repeat(48).slice(0, 48);
const FINGERPRINT = (seed) => seed.repeat(64).slice(0, 64);
const DESTINATION_ID = (n) => `9${n}000000-0000-4000-8000-00000000000${n}`;

/**
 * U2. One destination per kind, in three states.
 *
 * The labels are what a reader would call their own receivers, and the
 * endpoints are `example.test` — the repository's neutral placeholder. The
 * second row is the one carrying the amber refusal: it keeps its queue, which
 * is the behaviour the page promises (pausing and refusing both preserve
 * pending batches), and a frame without it would claim a delivery setup that
 * never fails.
 */
function usageExport() {
  const anchor = floorHalf(now());
  return {
    writer: true,
    queue_capacity_bytes: 52_428_800,
    test_outcome: 'delivered',
    buckets: [
      { hours: 1, model: MODELS.k3, tokens: { input_other: 14_200, input_cache_read: 48_900, input_cache_creation: 6_100, output: 3_800 }, quality: { known_records: 24, missing_records: 0, legacy_zero_records: 0, invalid_records: 0, estimated_records: 0, mapping_unknown: false, price_unknown: false, complete: true }, cost: { usd_estimated: 0.0121, currency: 'USD', source: 'kiki-local-estimate', pricing_version: FINGERPRINT('a') } },
      { hours: 2, model: MODELS.fable, tokens: { input_other: 6_400, input_cache_read: 21_300, input_cache_creation: 0, output: 1_900 }, quality: { known_records: 11, missing_records: 0, legacy_zero_records: 0, invalid_records: 0, estimated_records: 0, mapping_unknown: false, price_unknown: false, complete: true }, cost: { usd_estimated: 0.0064, currency: 'USD', source: 'kiki-local-estimate', pricing_version: FINGERPRINT('a') } },
      { hours: 3, model: MODELS.flash, tokens: { input_other: 9_800, input_cache_read: 12_700, input_cache_creation: 2_400, output: 2_600 }, quality: { known_records: 18, missing_records: 0, legacy_zero_records: 0, invalid_records: 0, estimated_records: 0, mapping_unknown: false, price_unknown: false, complete: true }, cost: { usd_estimated: 0.0027, currency: 'USD', source: 'kiki-local-estimate', pricing_version: FINGERPRINT('a') } },
    ],
    destinations: [
      {
        id: DESTINATION_ID(1),
        label: pick(localeLabel(), 'Team usage receiver', '团队用量接收端'),
        target: { kind: 'webhook', endpoint: 'https://usage.example.test/v1/ingest', gzip: true, authentication: 'bearer' },
        account_fingerprint: FINGERPRINT('1'),
        scope: { start_at: anchor - 14 * DAY, end_at: null, include_ephemeral: false, excluded_workspace_ids: [] },
        schedule_minutes: 30,
        stream_id: STREAM('1'),
        enabled: true,
        consent_fingerprint: FINGERPRINT('2'),
        credential_storage: 'keyring',
        state: 'ready',
        next_at: now() + 18 * 60_000,
        last_success_at: now() - 12 * 60_000,
        error_category: null,
        queue_pending: 0,
        quarantined: 0,
      },
      {
        id: DESTINATION_ID(2),
        label: pick(localeLabel(), 'VibeCafe for this machine', '这台机器的 VibeCafe'),
        target: { kind: 'vibe', endpoint: 'https://vibecafe.ai/api/usage/ingest' },
        account_fingerprint: FINGERPRINT('3'),
        scope: { start_at: anchor - 30 * DAY, end_at: null, include_ephemeral: false, excluded_workspace_ids: [] },
        schedule_minutes: 60,
        stream_id: STREAM('2'),
        enabled: true,
        consent_fingerprint: FINGERPRINT('4'),
        credential_storage: 'keyring',
        state: 'needs-auth',
        next_at: null,
        last_success_at: now() - 3 * DAY,
        error_category: 'http_auth',
        queue_pending: 12,
        quarantined: 1,
      },
      {
        id: DESTINATION_ID(3),
        label: pick(localeLabel(), 'Local export script', '本地导出脚本'),
        target: { kind: 'script', command: 'kiki-usage-to-lakehouse', timeout_ms: 60_000, output_limit_bytes: 65_536 },
        account_fingerprint: FINGERPRINT('5'),
        scope: { start_at: anchor - 7 * DAY, end_at: null, include_ephemeral: false, excluded_workspace_ids: [WORKSPACE_ID] },
        schedule_minutes: 15,
        stream_id: STREAM('3'),
        enabled: false,
        consent_fingerprint: null,
        credential_storage: 'none',
        state: 'disabled',
        next_at: null,
        last_success_at: null,
        error_category: null,
        queue_pending: 0,
        quarantined: 0,
      },
    ],
  };
}

// The destination labels are the only localized part of the export seed, and
// `usageExport()` is called from each locale's builder. Reading the locale off
// a module-level binding keeps the seed helpers free of a second argument
// while still translating exactly the strings a reader sees.
let localeLabel = () => 'en';
const setLocale = (locale) => { localeLabel = () => locale; };

// ---------------------------------------------------------------------------
// Worlds
// ---------------------------------------------------------------------------

/** The shared roster the History frame already ships, so every frame is one app. */
function world(locale) {
  setLocale(locale);
  return {
    config: sampleConfig(),
    models: sampleModels(),
    providers: sampleProviders(),
    workspaces: [sampleWorkspace()],
    sessions: [
      sessionRecord(SESSION.release, {
        title: pick(locale, 'Prepare the release', '准备 sample-app 发布'),
        busy: true,
        main_turn_active: true,
        agent_config: { model: MODELS.k3 },
        usage: {
          input_tokens: 21_400, output_tokens: 4_900, cache_read_tokens: 61_300,
          cache_creation_tokens: 12_800, total_cost_usd: 0.0482, context_tokens: 82_000,
          context_limit: 262_144, turn_count: 6,
        },
        message_count: 2,
        created_at: ts(300),
        updated_at: ts(3),
      }),
      sessionRecord(SESSION.accessibility, {
        title: pick(locale, 'Review accessibility', '检查无障碍'),
        agent_config: { model: MODELS.fable },
        usage: {
          input_tokens: 9_800, output_tokens: 1_600, cache_read_tokens: 22_400,
          cache_creation_tokens: 0, total_cost_usd: 0.0213, context_tokens: 41_000,
          context_limit: 200_000, turn_count: 3,
        },
        message_count: 1,
        created_at: ts(600),
        updated_at: ts(40),
      }),
      sessionRecord(SESSION.documentation, {
        title: pick(locale, 'Update documentation', '更新文档'),
        agent_config: { model: MODELS.flash },
        usage: {
          input_tokens: 6_200, output_tokens: 2_100, cache_read_tokens: 14_800,
          cache_creation_tokens: 3_100, total_cost_usd: 0.0089, context_tokens: 33_000,
          context_limit: 128_000, turn_count: 4,
        },
        message_count: 1,
        created_at: ts(1_440),
        updated_at: ts(95),
      }),
    ],
    snapshots: { [SESSION.release]: { messages: [], has_more: false } },
  };
}

/**
 * U1 — Usage → Live. The governance snapshot is the whole frame; the sessions
 * exist so the sidebar is the same list the History frame shows.
 */
export function buildUx1(locale) {
  return { ...world(locale), requestGovernance: governance() };
}

/**
 * U2 — Usage → External sync. A thin usage projection keeps the page's live
 * strip and its cost/pricing entry points answering: the export panel is read
 * on the same page as the other two, and a frame with a red error behind the
 * list would be a fixture artifact rather than a product claim.
 */
export function buildUx2(locale) {
  const base = world(locale);
  const tokens = { input_other: 37_400, input_cache_read: 98_500, input_cache_creation: 15_900, output: 8_600 };
  return {
    ...base,
    usageV2: {
      summary: { tokens, cost_usd_estimated: 0.0784, cost_unknown: false, session_count: 3, tokens_unknown: false },
      summaryToday: { tokens, cost_usd_estimated: 0.0784, cost_unknown: false, session_count: 3, tokens_unknown: false },
      query: { range: { defaulted_to_all_history: false } },
      reliability: {
        complete: true,
        usage_coverage: { known_records: 212, missing_records: 0, legacy_zero_records: 0 },
        coverage: { earliest_at: now() - 30 * DAY, latest_at: now() - 3 * 60_000 },
        scanned_sessions: 9,
        incomplete_sessions: 0,
        unknown_price_models: [],
        includes_deleted_sessions: false,
        incomplete_reason: null,
      },
      trend: [],
      sessions: { items: [], total: 0, has_more: false, next_page_token: null },
    },
    requestGovernance: governance(),
    usageExport: usageExport(),
  };
}
