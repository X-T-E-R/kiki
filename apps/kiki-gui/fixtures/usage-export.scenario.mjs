/**
 * `/usage?panel=export` — the external-sync destinations panel.
 *
 * The panel is a projection of `/api/usage-export`, so this scenario seeds
 * destinations and drives the real routes: save a draft, test the protocol,
 * preview the payload, enable once with the fingerprint the server issued, and
 * read the result back. It also seeds the two states a user actually meets when
 * something is wrong — a refused credential with a real queued batch, and a
 * service that holds different data — because those are where the recovery
 * wording matters, plus a vibecafe draft that has delivered nothing yet, which
 * is the one a collector handoff can be arranged from.
 *
 * A second scenario (`usage-export-off`) serves the same server with the flag
 * off, so the panel is checked against "the server exposes no destinations"
 * rather than against an empty list.
 */

import { sessionRecord, userMsg, assistantMsg, ts } from './helpers.mjs';

// The seeded destinations start far enough back to read as a real history, and
// the buckets themselves are recent (see `bucket`).
const START = Date.parse('2025-12-01T09:00:00.000Z');

/**
 * A bucket `hours` half-hours before "now", so a walk at any time sees recent
 * buckets; the range filter is still the destination's own.
 */
const bucket = (hours, model, tokens, extra = {}) => ({
  hours,
  model,
  tokens: { input_other: 120, input_cache_read: 900, input_cache_creation: 20, output: 50, ...tokens },
  quality: {
    known_records: 3, missing_records: 0, legacy_zero_records: 0, invalid_records: 0,
    estimated_records: 0, mapping_unknown: false, price_unknown: false, complete: true, ...extra.quality,
  },
  cost: (extra.quality?.price_unknown ?? false)
    ? { usd_estimated: null, currency: 'USD', source: 'kiki-local-estimate', pricing_version: 'a'.repeat(64) }
    : { usd_estimated: 0.0142, currency: 'USD', source: 'kiki-local-estimate', pricing_version: 'a'.repeat(64) },
});

const HASH = (seed) => {
  let h = 0;
  for (const char of seed) h = (h * 31 + char.charCodeAt(0)) >>> 0;
  return h.toString(16).padStart(8, '0').repeat(8);
};

const session = (id, title, updatedMinutes) => ({
  ...sessionRecord(id, { title, updated_at: ts(updatedMinutes) }),
  messages: [userMsg(id, 'ship the usage panel', 12), assistantMsg(id, ['done'], 10)],
});

export default {
  name: 'usage-export',
  sessions: [session('sess_export_alpha', 'Usage panel review', 4), session('sess_export_beta', 'Collector handoff', 40)],
  workspaces: [{ id: 'wd_export_000000000000', root: 'C:/fixture/workshop', name: 'docs-site', created_at: ts(600), last_opened_at: ts(30), session_count: 2, pinned: false }],
  usageV2: {
    summary: {
      tokens: { input_other: 40_000, input_cache_read: 900_000, input_cache_creation: 12_000, output: 30_000 },
      cost_usd_estimated: 3.42,
      cost_unknown: false,
      session_count: 2,
      tokens_unknown: false,
    },
    query: { range: { defaulted_to_all_history: false } },
    reliability: { unknown_price_models: [], included_deleted: false },
    trend: [],
    sessions: { items: [], total: 0, has_more: false, next_page_token: null },
  },
  usageExport: {
    writer: true,
    queue_capacity_bytes: 52_428_800,
    test_outcome: 'delivered',
    buckets: [
      bucket(1, 'kimi-k2-thinking', {}),
      bucket(2, 'kimi-k2-thinking', {}, { quality: { mapping_unknown: true } }),
      bucket(3, 'claude-opus-4-thinking', { input_cache_creation: 0 }, { quality: { price_unknown: true, missing_records: 1 } }),
      bucket(4, 'kimi-k2-thinking', {}),
      bucket(5, 'kimi-k2-thinking', {}),
    ],
    destinations: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        label: 'vibecafe personal',
        target: { kind: 'vibe', endpoint: 'https://usage.example.test/api/usage/ingest' },
        account_fingerprint: HASH('vibecafe-key'),
        scope: { start_at: START, end_at: null, include_ephemeral: false, excluded_workspace_ids: [] },
        schedule_minutes: 30,
        stream_id: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6',
        enabled: true,
        consent_fingerprint: HASH('vibecafe-consent'),
        credential_storage: 'keyring',
        state: 'ready',
        next_at: Date.now() + 12 * 60_000,
        last_success_at: Date.now() - 3 * 60 * 60_000,
        error_category: null,
        queue_pending: 0,
        quarantined: 0,
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        // A long origin: the row must truncate and the detail must wrap it
        // without pushing the page sideways.
        label: 'team usage warehouse',
        target: { kind: 'webhook', endpoint: 'https://usage.example.test/a/very/long/ingest/path/that/keeps/going/instead/of/ending/anywhere/near/the/first/line', gzip: true, authentication: 'bearer' },
        account_fingerprint: HASH('warehouse-key'),
        scope: { start_at: START, end_at: null, include_ephemeral: false, excluded_workspace_ids: ['wd_export_000000000000'] },
        schedule_minutes: 15,
        stream_id: 'b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7',
        enabled: true,
        consent_fingerprint: HASH('warehouse-consent'),
        credential_storage: 'keyring',
        state: 'needs-auth',
        next_at: null,
        last_success_at: Date.now() - 26 * 3_600_000,
        error_category: 'http_auth',
        queue_pending: 18,
        quarantined: 2,
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        // The service keeps a larger value for these buckets and refuses a lower
        // revision, so nothing is retried until a human looks.
        label: 'vibecafe audit account',
        target: { kind: 'vibe', endpoint: 'https://usage.example.test/api/usage/ingest' },
        account_fingerprint: HASH('audit-key'),
        scope: { start_at: START - 7 * 86_400_000, end_at: null, include_ephemeral: true, excluded_workspace_ids: [] },
        schedule_minutes: 30,
        stream_id: 'c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8',
        enabled: true,
        consent_fingerprint: HASH('audit-consent'),
        credential_storage: 'private-file',
        state: 'remote-diverged',
        next_at: null,
        last_success_at: Date.now() - 9 * 3_600_000,
        error_category: 'remote_diverged',
        queue_pending: 3,
        quarantined: 0,
      },
      {
        id: '44444444-4444-4444-8444-444444444444',
        // A fresh vibecafe draft: the only state a collector handoff can start
        // from, and it has delivered nothing yet.
        label: 'vibecafe for this home only',
        target: { kind: 'vibe', endpoint: 'https://usage.example.test/api/usage/ingest' },
        account_fingerprint: HASH('fresh-key'),
        scope: { start_at: START, end_at: null, include_ephemeral: false, excluded_workspace_ids: [] },
        schedule_minutes: 30,
        stream_id: 'd4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9',
        enabled: false,
        consent_fingerprint: null,
        credential_storage: 'keyring',
        state: 'draft',
        next_at: null,
        last_success_at: null,
        error_category: null,
        queue_pending: 0,
        quarantined: 0,
      },
    ],
  },
  // The collector's recorded identity, read by the handoff arm exactly as the
  // real server reads it. Nothing here is a real credential.
  handoff_receipts: { legacy: 412, native: { schema_version: 'kiki.usage.receipt.v1', batch_id: 'fx000000000000000000000000', items: [{ stream_id: 'a', bucket_id: 'b', revision: 1, payload_hash: 'c'.repeat(64), status: 'applied' }] } },
};

export const usageExportOff = {
  name: 'usage-export-off',
  sessions: [],
  // No `usageExport` seed: the routes are not registered, and the panel must say
  // the feature is off instead of showing an empty destination list.
};
