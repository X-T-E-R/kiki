/**
 * Durable prompt admission (`admission: 'durable'`), the kap-server
 * PromptIngress surface: a saved-session send is acknowledged as `restoring`,
 * then admitted into the ordinary prompt path once the session is ready.
 *
 * Scenario data `durableAdmission` turns it on and scripts the restore per
 * prompt text: `{ match, restoreMs?, queuePosition?, outcome?: 'admitted' |
 * 'failed' | 'held', duplicateOf? }`. A text with no rule is admitted after
 * `defaultRestoreMs` (default 400 ms), the ordinary fast send. `seed` lists
 * ingress records present when the session opens (held or failed copies).
 *
 * Routes: POST /prompts?admission=durable, GET /prompts?admission=durable,
 * GET /prompts/{id}?admission=durable, POST /prompts/{id}:resume and the
 * restoring/held branch of /prompts/{id}:abort.
 */

function config(server) {
  return server.scenario?.data.durableAdmission;
}

function ledger(session) {
  session.durableIngress ??= new Map();
  return session.durableIngress;
}

function view(entry) {
  const { timer: _timer, body: _body, startedAt, ...item } = entry;
  if (item.admission !== 'restoring') return { ...item, restore_progress: undefined };
  return { ...item, restore_progress: { phase: 'prompt_acquire', started_at: new Date(startedAt).toISOString(), elapsed_ms: Date.now() - startedAt, queue_position: entry.queue_position } };
}

function textOf(content) {
  return (content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
}

/** Seed ingress records once per session (`seed` in scenario data). */
function seed(server, session) {
  const rules = config(server);
  if (rules === undefined || session.durableSeeded) return;
  session.durableSeeded = true;
  for (const record of rules.seed ?? []) {
    if (record.session_id !== undefined && record.session_id !== session.record.id) continue;
    ledger(session).set(record.prompt_id, { ...record, session_id: undefined, startedAt: Date.now() });
  }
}

function admit(server, session, entry) {
  entry.admission = 'admitted';
  entry.queue_position = undefined;
  server.admitDurablePrompt(session, entry.body);
}

function schedule(server, session, entry, rule) {
  const delay = rule?.restoreMs ?? config(server)?.defaultRestoreMs ?? 400;
  entry.startedAt = Date.now();
  entry.queue_position = rule?.queuePosition;
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    if (entry.admission !== 'restoring') return;
    if (rule?.outcome === 'failed') {
      entry.admission = 'failed';
      entry.admission_error = { code: 40903, message: 'Message restoration timed out.' };
      return;
    }
    if (rule?.outcome === 'held') {
      entry.admission = 'held';
      return;
    }
    admit(server, session, entry);
  }, delay);
  entry.timer.unref?.();
}

/** Returns true when the route was handled. */
export function handleDurableAdmission(server, res, session, tail, query, body, method) {
  const rules = config(server);
  if (rules === undefined || session === undefined) return false;
  seed(server, session);
  const durable = query.get('admission') === 'durable';
  const entries = ledger(session);
  if (tail === '/prompts' && method === 'POST' && body?.admission === 'durable' && (body.agent_id === undefined || body.agent_id === 'main')) {
    const promptId = body.prompt_id;
    const existing = entries.get(promptId);
    if (existing !== undefined) return server.envelope(res, view(existing)), true;
    const text = textOf(body.content);
    const rule = (rules.rules ?? []).find((candidate) => text.includes(candidate.match));
    const entry = {
      prompt_id: promptId, user_message_id: promptId, status: 'queued', content: body.content,
      created_at: new Date().toISOString(), append_timing: body.append_timing ?? 'agent_idle', revision: 0,
      admission: rule?.duplicateOf === undefined ? 'restoring' : 'held',
      admission_duplicate_of: rule?.duplicateOf,
      body: { ...body, admission: undefined }, startedAt: Date.now(),
    };
    entries.set(promptId, entry);
    if (entry.admission === 'restoring') schedule(server, session, entry, rule);
    server.envelope(res, view(entry));
    return true;
  }
  if (tail === '/prompts' && method === 'GET' && durable) {
    server.envelope(res, { active: null, queued: [], ingress: [...entries.values()].map(view) });
    return true;
  }
  const one = /^\/prompts\/([^/:]+)$/.exec(tail);
  if (one !== null && method === 'GET' && durable) {
    const entry = entries.get(decodeURIComponent(one[1]));
    if (entry === undefined) server.envelope(res, null, 40404, 'prompt.not_found');
    else server.envelope(res, view(entry));
    return true;
  }
  const resume = /^\/prompts\/([^/:]+):resume$/.exec(tail);
  if (resume !== null && method === 'POST') {
    const entry = entries.get(decodeURIComponent(resume[1]));
    if (entry === undefined) return server.envelope(res, null, 40404, 'prompt.not_found'), true;
    if (entry.admission === 'held' || entry.admission === 'failed') {
      entry.admission = 'restoring';
      entry.admission_error = undefined;
      entry.admission_duplicate_of = undefined;
      entry.body ??= { content: entry.content, prompt_id: entry.prompt_id };
      schedule(server, session, entry, { restoreMs: rules.resumeMs ?? 600 });
    }
    server.envelope(res, view(entry));
    return true;
  }
  const abort = /^\/prompts\/([^/:]+):abort$/.exec(tail);
  if (abort !== null && method === 'POST') {
    const entry = entries.get(decodeURIComponent(abort[1]));
    if (entry === undefined || entry.admission === 'admitted') return false;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.admission = 'cancelled';
    server.envelope(res, { aborted: true, at_seq: session.seq });
    return true;
  }
  return false;
}
