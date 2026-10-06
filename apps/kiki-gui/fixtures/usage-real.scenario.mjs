/**
 * usage-real — the /usage dashboard replayed from a captured real response.
 *
 * The synthetic `usage-dashboard` scenario proves the layout and the
 * interactions. It cannot prove *scope*: its trend buckets are laid out by hand
 * and ignore the requested range, so a "last 7 days" read can render bars from
 * outside that window and a prior-period read can return the same bars again.
 * Those are fixture gaps, not product behaviour, and a screenshot taken on top
 * of them proves nothing about dates, comparison, or session trace.
 *
 * So this scenario replays three captured real responses — one day, seven
 * days, and the same seven days narrowed to a provider — and answers every
 * read from them:
 *
 *   - the window is the response's own `query.range`, so the bars the reader
 *     sees are the bars the server returned for exactly that window;
 *   - a prior-period or a narrower-source read picks the recorded response
 *     whose own conditions match, and says so through its own summary;
 *   - the session list, the per-session costs and the per-bucket turn
 *     attribution are the captured ones, so the trace shows real amounts and
 *     real turn ids.
 *
 * A request no recording covers is an unsupported combination, and says so
 * rather than borrowing another window's total or reporting a measured zero.
 *
 * The capture is read-only evidence from another owner's run (393 sessions,
 * 6695 agents, 697922 checkpoint records, titles omitted). It carries no
 * credentials and no chat content, and it never starts the real service or
 * reads the real home directory.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assistantMsg, sessionRecord, userMsg } from './helpers.mjs';

const CAPTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'real-usage');

function readCapture(name) {
  return JSON.parse(readFileSync(join(CAPTURE_DIR, `${name}.json`), 'utf8'));
}

/** The turn ids the capture attributes to its first session, in order. */
const CAPTURED_TURN_IDS = (() => {
  const capture = readCapture('last-7-days');
  const sessionId = capture.sessions.items[0].id;
  const ids = [];
  for (const bucket of capture.trend) {
    for (const entry of bucket.drilldown.sessions) {
      if (entry.session_id !== sessionId) continue;
      for (const turnId of entry.turn_ids) if (!ids.includes(turnId)) ids.push(turnId);
    }
  }
  return ids;
})();

const CAPTURES = {
  today: readCapture('today'),
  last7: readCapture('last-7-days'),
  provider: readCapture('provider-filter'),
};

const ALL = [CAPTURES.today, CAPTURES.last7, CAPTURES.provider];

/**
 * The capture whose own recorded conditions answer this request.
 *
 * A capture only answers a request whose conditions it actually recorded: the
 * same dimension, granularity, source filters and — for a preset read — the
 * same recorded window. Matching loosely would hand a seven-day reader a
 * single day's bars, or hand a provider-filtered reader an unfiltered total,
 * and the page would be showing a real amount under the wrong conditions.
 *
 * A request nobody recorded resolves to null, which the fixture reports as an
 * unsupported combination.
 */
export function matchCapture(query) {
  const dimension = query.get('dimension') ?? 'model';
  const granularity = query.get('granularity') ?? 'day';
  const providers = query.getAll('provider');
  const models = query.getAll('model');
  const startAt = query.get('start_at') !== null ? Number(query.get('start_at')) : null;
  const endAt = query.get('end_at') !== null ? Number(query.get('end_at')) : null;
  const preset = query.get('range');
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const matchesRecordedConditions = (capture) =>
    capture.query.dimension === dimension &&
    capture.query.granularity === granularity &&
    same(capture.query.providers ?? [], providers) &&
    same(capture.query.models ?? [], models);

  // A preset read: the recorded window is the answer, and it has to be the
  // window that preset produced.
  if (startAt === null || endAt === null) {
    const exact = ALL.find((capture) =>
      matchesRecordedConditions(capture) &&
      (preset === null || capture.query.range.preset === preset));
    if (exact !== undefined) return exact;
  } else {
    // An explicit window: the recorded window has to be exactly it. A prior
    // period is a different window than anything recorded, so it falls through
    // to the containment step below rather than silently reusing the current
    // period's numbers.
    const exact = ALL.find((capture) =>
      matchesRecordedConditions(capture) &&
      capture.query.range.start_at === startAt &&
      capture.query.range.end_at === endAt);
    if (exact !== undefined) return exact;
  }

  // A narrower window inside a recorded one — a selected day, a source row's
  // trace — is answered by projecting that recording: only the buckets the
  // window covers are returned, with their own recorded groups. Nothing is
  // constructed, and a window covering no recorded bucket falls through to the
  // empty answer below.
  const covering = ALL
    .filter((capture) => matchesRecordedConditions(capture))
    .filter((capture) => {
      const bounds = capture.query.range;
      if (bounds.start_at === null || bounds.end_at === null) return false;
      return bounds.start_at <= startAt && bounds.end_at >= endAt;
    })
    .toSorted((left, right) =>
      (left.query.range.end_at - left.query.range.start_at) - (right.query.range.end_at - right.query.range.start_at))[0];
  if (covering !== undefined && covering.trend.some(
    (bucket) => bucket.start_at >= startAt && bucket.start_at < endAt,
  )) {
    return { capture: covering, window: { startAt, endAt } };
  }

  // A prior-period window, or a combination outside the capture. Handing back
  // the current period's numbers would put a real amount under conditions that
  // were never measured and make the comparison read as a genuine change, so
  // the request is reported as unsupported and the page keeps the current
  // period while marking the prior one unavailable.
  return null;
}

/**
 * The captured session rows, registered so `/s/{id}` resolves.
 *
 * The usage capture carries no transcript, so these rows exist only to make the
 * route real: a reader who follows a turn locator lands on a session page
 * instead of a not-found. Their amounts and workspaces are the captured ones;
 * the messages behind them are not part of this capture and are not invented.
 */
const capturedSessions = CAPTURES.last7.sessions.items.map((item) =>
  sessionRecord(item.id, {
    workspace_id: item.workspace_id,
    // The capture deliberately omits session titles, and a session record
    // requires one. The honest placeholder is "untitled" rather than an
    // invented title: this replay is about amounts, dates and attribution.
    title: item.title ?? 'Untitled session',
    archived: item.archived,
    // The fixture's own session routes order and render ISO timestamps; the
    // capture stores epoch milliseconds.
    created_at: new Date(item.created_at).toISOString(),
    updated_at: new Date(item.updated_at).toISOString(),
    agent_config: { model: item.primary_model ?? '' },
    usage: {
      input_tokens: item.usage.tokens.input_other,
      output_tokens: item.usage.tokens.output,
      cache_read_tokens: item.usage.tokens.input_cache_read,
      cache_creation_tokens: item.usage.tokens.input_cache_creation,
      total_cost_usd: item.usage.cost_usd_estimated,
      context_tokens: item.usage.tokens.input_other,
      context_limit: 262_144,
      turn_count: 1,
    },
  }));

export const usageV2 = {
  captures: CAPTURES,
  matchCapture,
};

export default {
  models: [
    { id: 'axon/gpt-6.1-sol', provider_id: 'axon', remote_id: 'axon/gpt-6.1-sol', display_name: 'GPT-6.1 Sol' },
    { id: 'axon/gpt-6-astra', provider_id: 'axon', remote_id: 'axon/gpt-6-astra', display_name: 'GPT-6 Astra' },
  ],
  providers: [
    { id: 'axon', type: 'openai', has_api_key: true, status: 'connected', default_model: 'axon/gpt-6.1-sol', models: ['axon/gpt-6.1-sol', 'axon/gpt-6-astra'] },
    { id: 'anthropic', type: 'anthropic', has_api_key: true, status: 'connected', default_model: 'anthropic/claude-opus-5-5', models: ['anthropic/claude-opus-5-5'] },
  ],
  // The captured workspace ids were replaced with neutral placeholders when the
  // capture entered the repo, so the names here are illustrative too.
  workspaces: [
    { id: 'wd_fixture_0001_000000000001', root: 'C:/fixture/workshop', name: 'workshop', created_at: 1_700_000_000_000, last_opened_at: 1_790_000_000_000, session_count: 120, pinned: false },
    { id: 'wd_fixture_0002_000000000002', root: 'C:/fixture/lab', name: 'lab', created_at: 1_700_000_000_000, last_opened_at: 1_780_000_000_000, session_count: 44, pinned: false },
    { id: 'wd_fixture_0003_000000000003', root: 'C:/fixture/notes', name: 'notes', created_at: 1_700_000_000_000, last_opened_at: 1_785_000_000_000, session_count: 31, pinned: false },
  ],
  sessions: capturedSessions,
  // A bounded transcript for the first captured session, so the turn locator
  // has real rows to land on. One row per turn id the capture attributes to
  // this session, so the id a trace button carries is the id a transcript row
  // answers to. The message text is illustrative: the usage capture carries no
  // chat, so it makes the rows addressable and says nothing about what this
  // session contained.
  snapshots: {
    [capturedSessions[0].id]: {
      messages: CAPTURED_TURN_IDS.flatMap((turn, index) => [
        { ...userMsg(capturedSessions[0].id, `Recorded-usage question ${index + 1}.`, 240 - index * 15), turn_id: turn },
        { ...assistantMsg(capturedSessions[0].id, [`Recorded-usage answer ${index + 1}.`], 239 - index * 15), turn_id: turn },
      ]),
    },
  },
  usageV2,
};