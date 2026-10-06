/**
 * Usage export (`/api/usage-export`) for the GUI fixture server.
 *
 * The routes mirror `packages/kap-server/src/routes/usageExport.ts`: same paths,
 * same envelope codes, same request bodies. Enough of the service semantics is
 * reproduced that the page is exercised against real behaviour rather than a
 * canned list:
 *
 *   - a saved draft comes back with `enabled: false` and no consent;
 *   - the consent fingerprint is a digest of the destination as it currently is,
 *     so editing a scope, a period or the endpoint produces a *different* one and
 *     `enable` refuses a stale one with `consent-preview-changed` — which is the
 *     behaviour the page's stale-preview guard has to be honest about;
 *   - `preview` returns real strict bucket items for the seeded scope;
 *   - pause keeps the queue, removal needs the pending-data consent, and the
 *     handoff is a real prepared → armed → awaiting-native state machine over a
 *     collector file, not a decoration.
 *
 * Writes only ever mutate this in-memory state; nothing here reaches the network
 * or a real Kiki home.
 */

import { createHash, randomUUID } from 'node:crypto';

const HALF_HOUR = 1_800_000;
const HASH = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const OPAQUE = (prefix) => `${prefix}-fx-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
const ADAPTER = { vibe: 'vibe-usage-v1', webhook: 'kiki-webhook-v1', script: 'kiki-script-v1' };

/** Route refusals the real server passes through verbatim (see the route file). */
const ALLOWED = new Set([
  'destination-not-found', 'consent-preview-changed', 'adapter-unavailable', 'private-file-storage-requires-consent',
  'identity-change-requires-new-destination', 'destination-cannot-delete', 'clear-queue-requires-consent',
  'withdraw-requires-consent', 'export-writer-unavailable', 'export-queue-full', 'invalid-queue-capacity',
  'unsafe_endpoint', 'endpoint-query-not-allowed', 'bearer-requires-https', 'remove-requires-queue-consent',
]);

function fail(reason) {
  const error = new Error(reason);
  error.fixtureCategory = ALLOWED.has(reason) ? reason : 'usage-export-operation-failed';
  error.fixtureHttp = reason === 'destination-not-found' ? 404 : 400;
  return error;
}

function endpointOf(target) {
  return target.kind === 'script' ? '' : target.endpoint;
}

/** Same inputs as the service fingerprint: policy, target, credential, scope, stream, adapter. */
function fingerprintOf(server, destination) {
  const target = destination.target.kind === 'script'
    ? { kind: 'script', command: destination.target.command }
    : { kind: destination.target.kind, endpoint: destination.target.endpoint, private_grant: destination.target.private_grant, authentication: destination.target.kind === 'webhook' ? destination.target.authentication : 'bearer' };
  return HASH({
    policy: 'kiki.usage.bucket.v1', target,
    account: destination.account_fingerprint, scope: destination.scope, stream: destination.stream_id,
    adapter: ADAPTER[destination.target.kind],
  });
}

function queueOf(server, id) {
  const entry = server.usageExportQueues.get(id);
  if (entry === undefined) {
    server.usageExportQueues.set(id, { pending: 0, inflight: 0, quarantined: 0, bytes: 0, oldest_at: null, items: [] });
    return server.usageExportQueues.get(id);
  }
  return entry;
}

function statusOf(server) {
  return {
    writer: server.usageExportWriter,
    scan_complete: true,
    scan_error: null,
    destinations: [...server.usageExportDestinations.values()].map((destination) => {
      const queue = queueOf(server, destination.id);
      return {
        destination,
        queue: {
          pending: queue.pending, inflight: queue.inflight, quarantined: queue.quarantined, bytes: queue.bytes,
          limit_bytes: server.usageExportCapacity, warning: queue.bytes > server.usageExportCapacity * 0.8,
          oldest_at: queue.oldest_at,
        },
      };
    }),
  };
}

function bucketsFor(server, destination) {
  // Buckets whose `hours` are offsets from the scenario's own anchor, so a
  // walk at any time sees recent buckets; the range itself is still the
  // destination's, which is what the scope preview has to reflect.
  const seed = server.usageExport?.buckets ?? [];
  const anchor = Math.floor(Date.now() / HALF_HOUR) * HALF_HOUR;
  const items = seed.map(({ hours, ...bucket }) => ({
    ...bucket,
    start_at: new Date(anchor - hours * HALF_HOUR).toISOString(),
    end_at: new Date(anchor - hours * HALF_HOUR + HALF_HOUR).toISOString(),
  }));
  return items
    .filter((bucket) => Date.parse(bucket.start_at) >= destination.scope.start_at)
    .map((bucket) => {
      const stream = destination.stream_id;
      return {
        schema_version: 'kiki.usage.bucket.v1',
        stream_id: stream,
        bucket_id: OPAQUE('bk'),
        revision: 1,
        payload_hash: HASH(bucket),
        operation: 'replace',
        bucket: { ...bucket, source: 'kiki', mapping_version: 'kiki-public-model-v1' },
      };
    });
}

function previewOf(server, destination) {
  const items = bucketsFor(server, destination);
  return {
    destination,
    preview_fingerprint: fingerprintOf(server, destination),
    items,
    total_buckets: items.length,
    source_complete: true,
    invalid_records: 0,
    disclosures: [
      'Only UTC half-hour model/token/quality/cost buckets are exported; no conversation, title, workspace path, profile or real hostname.',
      'The receiver can observe your IP address and usage timing. Unknown local model aliases use destination-specific opaque identifiers.',
      'Scheduling runs while the Kiki backend is alive; it does not keep the daemon alive or call a model.',
      'The displayed account fingerprint identifies this configured credential locally, not a verified remote account. Unverified key changes require fresh consent.',
    ],
  };
}

function enqueue(server, destination, count) {
  const queue = queueOf(server, destination.id);
  queue.pending += count;
  queue.bytes += count * 220;
  queue.oldest_at ??= destination.scope.start_at;
  for (let i = 0; i < count; i += 1) queue.items.push(queuedItem(destination, i));
}
function queuedItem(destination, index) {
  return {
    bucket_id: HASH(`${destination.stream_id}:${destination.scope.start_at}:${index}`).slice(0, 48),
    payload: {
      start_at: new Date(destination.scope.start_at + index * HALF_HOUR).toISOString(),
      end_at: new Date(destination.scope.start_at + (index + 1) * HALF_HOUR).toISOString(),
    },
  };
}

export function resetUsageExport(server, data) {
  // The seed stays a plain object (other fixture domains keep their seeds that
  // way); `usageExportDestinations` is the live map the routes mutate.
  server.usageExport = data.usageExport === undefined ? {} : structuredClone(data.usageExport);
  server.usageExportEnabled = server.usageExport !== null;
  server.usageExportWriter = server.usageExport?.writer ?? true;
  server.usageExportCapacity = server.usageExport?.queue_capacity_bytes ?? 52_428_800;
  server.usageExportQueues = new Map();
  server.usageExportHandoffs = new Map();
  server.usageExportTested = new Map();
  server.usageExportDestinations = new Map();
  for (const seed of server.usageExport?.destinations ?? []) {
    const { queue_pending, quarantined, ...destination } = seed;
    server.usageExportDestinations.set(destination.id, { ...destination, target: { ...destination.target } });
    if (queue_pending > 0) enqueue(server, destination, queue_pending);
    if (quarantined > 0) queueOf(server, destination.id).quarantined = quarantined;
  }
}

/** `POST /api/usage-export/...` — returns true when the path was handled. */
export function handleUsageExport(server, res, path, method, body) {
  const envelope = (data, category = null) => {
    const code = category === null ? 0 : 40001;
    const msg = category === null ? 'success' : category;
    const http = category === 'destination-not-found' ? 404 : category === null ? 200 : 400;
    res.writeHead(http, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code, msg, data, request_id: nextRequestId() }));
  };
  // `/usage-export/destinations/:id/preview` is a GET whose trailing segment
  // could otherwise be read as a session id by the flat route below.
  if (method === 'GET' && /^\/usage-export\/destinations\/[^/]+\/preview$/.test(path)) {
    if (!server.usageExportEnabled) return false;
    const id = decodeURIComponent(path.split('/')[3]);
    const destination = server.usageExportDestinations.get(id);
    if (destination === undefined) { envelope(null, 'destination-not-found'); return true; }
    envelope(previewOf(server, destination));
    return true;
  }
  if (path === '/usage-export' && method === 'GET') {
    if (!server.usageExportEnabled) return false;
    envelope(statusOf(server));
    return true;
  }
  if (path === '/usage-export/diagnostics' && method === 'GET') {
    if (!server.usageExportEnabled) return false;
    envelope(statusOf(server));
    return true;
  }
  if (path === '/usage-export/destinations' && method === 'POST') {
    if (!server.usageExportEnabled) return false;
    const destination = saveDraft(server, body);
    envelope(destination);
    return true;
  }
  const match = /^\/usage-export\/destinations\/([^/]+)(?:\/(.+))?$/.exec(path);
  if (match === null || !server.usageExportEnabled) return false;
  const id = decodeURIComponent(match[1]);
  const action = match[2] ?? '';
  const destination = server.usageExportDestinations.get(id);
  if (destination === undefined && action !== 'export') { envelope(null, 'destination-not-found'); return true; }
  switch (`${method} ${action}`) {
    case 'GET ': {
      if (action === 'handoff') { envelope(server.usageExportHandoffs.get(id) ?? null); return true; }
      if (action === 'export') {
        const queue = queueOf(server, id);
        envelope({ schema_version: 'kiki.usage.local-export.v1', items: queue.items.map((item) => ({ ...item, bucket: null, operation: 'replace', stream_id: destination.stream_id, revision: 1, schema_version: 'kiki.usage.bucket.v1' })) });
        return true;
      }
      if (action === 'preview') { envelope(previewOf(server, destination)); return true; }
      return false;
    }
    case 'POST test': {
      const ok = server.usageExport?.test_outcome !== 'retry';
      if (ok) server.usageExportTested.set(id, fingerprintOf(server, destination));
      envelope({ outcome: ok ? 'delivered' : 'retry', error_category: ok ? null : 'network' });
      return true;
    }
    case 'POST enable': {
      if (server.usageExportHandoffs.get(id)?.phase === 'prepared') { envelope(null, 'handoff-use-arm'); return true; }
      if ((body?.preview_fingerprint ?? null) !== fingerprintOf(server, destination)) { envelope(null, 'consent-preview-changed'); return true; }
      const next = { ...destination, enabled: true, consent_fingerprint: body.preview_fingerprint, state: 'ready', error_category: null, next_at: nextRun(server) };
      server.usageExportDestinations.set(id, next);
      queueOf(server, id).inflight = 0;
      queueOf(server, id).pending = 0;
      next.last_success_at ??= Date.now();
      envelope(next);
      return true;
    }
    case 'POST disable': {
      const next = { ...destination, enabled: false, state: 'disabled', next_at: null };
      server.usageExportDestinations.set(id, next);
      envelope(next);
      return true;
    }
    case 'POST sync': {
      const queue = queueOf(server, id);
      const moved = queue.pending;
      queue.pending = 0;
      queue.inflight = 0;
      queue.oldest_at = queue.pending === 0 ? null : queue.oldest_at;
      envelope(statusOf(server));
      void moved;
      return true;
    }
    case 'POST retry': {
      const queue = queueOf(server, id);
      queue.quarantined = 0;
      const next = { ...destination, state: destination.enabled ? 'ready' : 'disabled', error_category: null, next_at: destination.enabled ? nextRun(server) : null };
      server.usageExportDestinations.set(id, next);
      envelope(statusOf(server));
      return true;
    }
    case 'POST backfill': {
      if (body === undefined) { envelope(null, 'invalid-usage-export-input'); return true; }
      const widened = { ...destination, scope: { ...destination.scope, ...body }, consent_fingerprint: null, enabled: false, state: 'draft' };
      server.usageExportDestinations.set(id, widened);
      const extra = Math.max(0, Math.floor((widened.scope.start_at - destination.scope.start_at) / HALF_HOUR));
      if (extra > 0) enqueue(server, widened, extra);
      envelope(previewOf(server, widened));
      return true;
    }
    case 'POST remove': {
      const queue = queueOf(server, id);
      const pending = queue.pending + queue.inflight + queue.quarantined;
      if (pending > 0 && body?.discard_pending !== true) { envelope(null, 'remove-requires-queue-consent'); return true; }
      server.usageExportDestinations.delete(id);
      server.usageExportQueues.delete(id);
      server.usageExportHandoffs.delete(id);
      envelope({ removed: true });
      return true;
    }
    case 'POST clear-queue': {
      if (body?.acknowledge !== true) { envelope(null, 'clear-queue-requires-consent'); return true; }
      const queue = queueOf(server, id);
      queue.pending = 0; queue.inflight = 0; queue.quarantined = 0; queue.bytes = 0; queue.oldest_at = null; queue.items = [];
      const next = { ...destination, enabled: false, state: 'disabled', error_category: 'queue-explicitly-cleared', next_at: null };
      server.usageExportDestinations.set(id, next);
      envelope(statusOf(server));
      return true;
    }
    case 'POST withdraw': {
      if (body?.acknowledge !== true) { envelope(null, 'withdraw-requires-consent'); return true; }
      if (destination.target.kind === 'vibe') { envelope(null, 'destination-cannot-delete'); return true; }
      const queue = queueOf(server, id);
      queue.pending = 0; queue.inflight = 0; queue.quarantined = 0; queue.oldest_at = null; queue.items = [];
      envelope(statusOf(server));
      return true;
    }
    case 'POST handoff/plan': {
      const boundary = (body?.cutoff_at ?? nextBoundary(Date.now() + 2 * HALF_HOUR));
      if (destination.target.kind !== 'vibe' || destination.last_success_at !== null) { envelope(null, 'handoff-requires-new-vibe-draft'); return true; }
      const handoff = {
        schema_version: 'kiki.usage.handoff.v1',
        data_home_fingerprint: HASH('data-home'), account_fingerprint: destination.account_fingerprint,
        cutoff_at: boundary, namespace: `kiki-${HASH(String(boundary) + destination.stream_id).slice(0, 32)}`,
        phase: 'prepared', legacy_receipt: null, native_receipt: null, previous_cutoff_at: null,
      };
      server.usageExportHandoffs.set(id, handoff);
      const planned = { ...destination, enabled: false, state: 'draft', consent_fingerprint: null, next_at: null, scope: { ...destination.scope, start_at: boundary } };
      server.usageExportDestinations.set(id, planned);
      envelope(handoff);
      return true;
    }
    case 'POST handoff/arm': {
      const handoff = server.usageExportHandoffs.get(id);
      if (handoff === undefined || body?.acknowledge !== true) { envelope(null, 'handoff-consent-changed'); return true; }
      if ((body.preview_fingerprint ?? null) !== fingerprintOf(server, destination)) { envelope(null, 'handoff-consent-changed'); return true; }
      if (server.usageExportTested.get(id) !== body.preview_fingerprint) { envelope(null, 'handoff-readiness-unproven'); return true; }
      if (Date.now() >= handoff.cutoff_at) { envelope(null, 'handoff-missed-unarmed-cutoff'); return true; }
      const armed = { ...handoff, phase: 'armed' };
      server.usageExportHandoffs.set(id, armed);
      const native = { ...destination, enabled: true, state: 'ready', consent_fingerprint: body.preview_fingerprint, next_at: nextRun(server) };
      server.usageExportDestinations.set(id, native);
      envelope(armed);
      return true;
    }
    case 'POST handoff/refresh': {
      const handoff = server.usageExportHandoffs.get(id);
      if (handoff === undefined) { envelope(null); return true; }
      // The seed lives beside `destinations`, like every other fixture field.
      // The seed lives beside `destinations`, like every other fixture field.
      const seed = server.usageExport?.handoff_receipts ?? server.scenario?.data?.handoff_receipts;
      let next = handoff;
      // One receipt per refresh, so `awaiting-native` is a state the walk can
      // actually stop on: the collector's last receipt arrives first, and only a
      // later refresh brings Kiki's own.
      if (seed?.legacy !== undefined && handoff.phase === 'armed' && handoff.legacy_receipt === null) {
        next = {
          ...handoff,
          phase: 'awaiting-native',
          legacy_receipt: {
            completed_at: Date.now(), cutoff_at: handoff.cutoff_at, ingested: seed.legacy,
            coverage_complete: true, cutoff_persisted: true, collector_version: 'fixture-collector',
            collector_identity: { apiUrl: 'https://usage.example.test', keyFingerprint: 'abcdef0123456789', ingest_endpoint: endpointOf(destination) },
          },
        };
      } else if (seed?.native !== undefined && (next.phase === 'armed' || next.phase === 'awaiting-native')) {
        next = { ...next, phase: next.legacy_receipt === null ? 'armed' : 'completed', native_receipt: seed.native };
      }
      server.usageExportHandoffs.set(id, next);
      envelope(next);
      return true;
    }
    case 'POST handoff/rollback': {
      const handoff = server.usageExportHandoffs.get(id);
      if (handoff === undefined || body?.acknowledge !== true) { envelope(null, 'handoff-not-found'); return true; }
      if (!['armed', 'awaiting-native', 'completed'].includes(handoff.phase)) { envelope(null, 'handoff-rollback-new-boundary-required'); return true; }
      if ((body.cutoff_at ?? 0) <= Date.now() || body.cutoff_at <= handoff.cutoff_at) { envelope(null, 'handoff-rollback-new-boundary-required'); return true; }
      const next = { ...handoff, phase: 'rollback-prepared', previous_cutoff_at: handoff.cutoff_at, cutoff_at: body.cutoff_at };
      server.usageExportHandoffs.set(id, next);
      const native = { ...destination, scope: { ...destination.scope, end_at: body.cutoff_at } };
      server.usageExportDestinations.set(id, native);
      envelope(next);
      return true;
    }
    default:
      return false;
  }
  void fail;
  void ADAPTER;
}

function nextBoundary(ms) {
  return Math.ceil(ms / HALF_HOUR) * HALF_HOUR;
}
function nextRun() {
  return Date.now() + 30 * 60_000;
}
let requestCounter = 0;
function nextRequestId() {
  requestCounter += 1;
  return `req_fixture_${String(requestCounter).padStart(4, '0')}`;
}

function saveDraft(server, body) {
  const draft = body?.draft;
  if (draft === undefined || typeof draft.label !== 'string' || draft.label.trim() === '') { throw fail('invalid-usage-export-input'); }
  const previous = draft.id === undefined ? undefined : server.usageExportDestinations.get(draft.id);
  const secret = body?.secret?.value;
  const storage = body?.secret?.storage ?? previous?.credential_storage ?? 'none';
  const account = HASH(`${draft.target.kind}:${secret ?? 'anonymous'}:${draft.target.endpoint ?? draft.target.command ?? ''}`);
  if (previous !== undefined && previous.account_fingerprint !== account) {
    const queue = queueOf(server, previous.id);
    if (queue.pending + queue.inflight + queue.quarantined > 0 || previous.last_success_at !== null) throw fail('identity-change-requires-new-destination');
  }
  const id = previous?.id ?? randomUUID();
  const stream = previous?.stream_id ?? HASH(String(id)).slice(0, 48);
  const sameIdentity = previous !== undefined && previous.account_fingerprint === account;
  const shrunk = previous !== undefined
    && draft.scope.start_at >= previous.scope.start_at
    && (previous.scope.end_at === null || (draft.scope.end_at !== null && draft.scope.end_at <= previous.scope.end_at))
    && (!draft.scope.include_ephemeral || previous.scope.include_ephemeral)
    && previous.scope.excluded_workspace_ids.every((id_) => draft.scope.excluded_workspace_ids.includes(id_));
  const sameTarget = previous !== undefined && endpointOf(previous.target) === endpointOf(draft.target) && previous.target.kind === draft.target.kind;
  const keepConsent = sameIdentity && shrunk && sameTarget && previous.consent_fingerprint !== null;
  const next = {
    id,
    label: draft.label.trim(),
    target: draft.target,
    account_fingerprint: account,
    scope: { start_at: draft.scope.start_at, end_at: draft.scope.end_at ?? null, include_ephemeral: draft.scope.include_ephemeral === true, excluded_workspace_ids: draft.scope.excluded_workspace_ids ?? [] },
    schedule_minutes: draft.schedule_minutes ?? 30,
    stream_id: stream,
    enabled: keepConsent ? previous.enabled : false,
    consent_fingerprint: keepConsent ? fingerprintOf(server, { ...previous, scope: { ...previous.scope, ...draft.scope } }) : null,
    credential_storage: storage,
    state: keepConsent ? (previous.enabled ? 'ready' : 'disabled') : 'draft',
    next_at: keepConsent ? previous.next_at : null,
    last_success_at: previous?.last_success_at ?? null,
    error_category: null,
  };
  server.usageExportDestinations.set(id, next);
  return next;
}
