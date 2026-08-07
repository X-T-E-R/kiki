/**
 * kiki-gui live protocol smoke — exercises the exact surface the GUI uses:
 *   healthz → meta → workspaces → create session → snapshot → WS handshake →
 *   subscribe → prompt (permission_mode manual) → event.approval.requested →
 *   approve → tool/shell events → completion → abort → archive.
 *
 * Runs ONE tiny prompt (echo kiki-smoke) against the user's real server.
 * Usage: node scripts/smoke.mjs   (token read from ~/.kimi-code/server.token)
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.KIMI_SERVER_URL || 'http://127.0.0.1:58627';
const API = `${BASE}/api/v1`;
const token = (await readFile(join(homedir(), '.kimi-code', 'server.token'), 'utf8')).trim();

const log = (step, extra = '') => console.log(`\x1b[36m[smoke]\x1b[0m ${step}${extra ? ' — ' + extra : ''}`);
const fail = (step, detail) => {
  console.error(`\x1b[31m[smoke FAIL]\x1b[0m ${step}`, detail ?? '');
  process.exitCode = 1;
};

async function api(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const envelope = await response.json();
  return envelope;
}

// 1. healthz (auth-exempt) + meta (auth required) -----------------------------
const healthz = await fetch(`${API}/healthz`).then((r) => r.json());
if (healthz.code !== 0 || healthz.data?.ok !== true) fail('healthz', healthz);
else log('healthz ok');

const meta = await api('GET', '/meta');
if (meta.code !== 0) fail('meta', meta);
else log('meta ok', `server ${meta.data.server_version}, backend ${meta.data.backend ?? 'v1'}`);

// 2. sessions list + workspaces ----------------------------------------------
const sessions = await api('GET', '/sessions?page_size=5');
if (sessions.code !== 0) fail('list sessions', sessions);
else log('sessions listed', `${sessions.data.items.length} of page`);

const workspaces = await api('GET', '/workspaces');
if (workspaces.code !== 0 || workspaces.data.items.length === 0) {
  fail('workspaces', workspaces);
  process.exit(1);
}
const workspace = [...workspaces.data.items].sort((a, b) =>
  b.last_opened_at.localeCompare(a.last_opened_at),
)[0];
log('workspace picked', `${workspace.name} (${workspace.root})`);

// 3. create a throwaway session ----------------------------------------------
const created = await api('POST', '/sessions', {
  title: 'kiki-gui smoke (throwaway)',
  workspace_id: workspace.id,
});
if (created.code !== 0) {
  fail('create session', created);
  process.exit(1);
}
const sessionId = created.data.id;
log('session created', sessionId);

// 4. snapshot ------------------------------------------------------------------
const snap = await api('GET', `/sessions/${sessionId}/snapshot`);
if (snap.code !== 0) {
  fail('snapshot', snap);
  process.exit(1);
}
log('snapshot ok', `as_of_seq=${snap.data.as_of_seq} epoch=${snap.data.epoch}`);

// 5. WS handshake + subscribe ---------------------------------------------------
const seen = [];
const history = [];
const waiters = [];
const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/v1/ws`, [
  `kimi-code.bearer.${token}`,
]);

function waitFor(predicate, timeoutMs, label) {
  const past = history.find(predicate);
  if (past !== undefined) return Promise.resolve(past);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
    waiters.push({ predicate, resolve: (v) => { clearTimeout(timer); resolve(v); }, label });
  });
}
function notify(frame) {
  history.push(frame);
  for (let i = waiters.length - 1; i >= 0; i -= 1) {
    if (waiters[i].predicate(frame)) {
      const w = waiters[i];
      waiters.splice(i, 1);
      w.resolve(frame);
    }
  }
}

const opened = new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = (e) => reject(new Error('ws error'));
});
ws.onmessage = (event) => {
  const frame = JSON.parse(event.data);
  if (frame.type === 'server_hello') {
    log('server_hello', `protocol v${frame.payload.protocol_version}`);
    ws.send(JSON.stringify({ type: 'client_hello', id: 'smoke-1', payload: { client_id: 'kiki-gui-smoke' } }));
    ws.send(
      JSON.stringify({
        type: 'subscribe',
        id: 'smoke-2',
        payload: {
          session_ids: [sessionId],
          cursors: { [sessionId]: { seq: snap.data.as_of_seq, epoch: snap.data.epoch } },
        },
      }),
    );
    return;
  }
  if (frame.type === 'ack') {
    log('ack', `id=${frame.id} code=${frame.code} ${JSON.stringify(frame.payload)}`);
    notify(frame);
    return;
  }
  if (frame.type === 'resync_required' || frame.type === 'error') {
    log(`system ${frame.type}`, JSON.stringify(frame.payload));
    notify(frame);
    return;
  }
  if (frame.payload !== undefined) {
    seen.push(frame.type);
    if (!frame.type.endsWith('.delta')) {
      log('event', `${frame.type} seq=${frame.seq}${frame.volatile ? ' volatile' : ''}`);
    }
    notify(frame);
  }
};
await opened;
log('ws open (subprotocol auth accepted)');

const subscribed = await waitFor((f) => f.type === 'ack' && f.id === 'smoke-2', 10000, 'subscribe ack');
if (subscribed.code !== 0) fail('subscribe ack', subscribed);

// 6. prompt that requires an approval ------------------------------------------
// Fresh sessions bind no model (agent_config.model === ''), so the prompt must
// name one — the GUI resolves this via GET /config default_model.
const config = await api('GET', '/config');
const model = config.code === 0 ? config.data.default_model : undefined;
log('default model', model ?? '(none)');
const prompt = await api('POST', `/sessions/${sessionId}/prompts`, {
  content: [
    {
      type: 'text',
      text: 'Use the Bash tool to run exactly this shell command and nothing else: echo kiki-smoke. Then reply with the single word: done',
    },
  ],
  model,
  permission_mode: 'manual',
});
if (prompt.code !== 0) {
  fail('submit prompt', prompt);
  process.exit(1);
}
log('prompt submitted', `prompt_id=${prompt.data.prompt_id} status=${prompt.data.status}`);
const promptId = prompt.data.prompt_id;

// 7. approval requested → approve ------------------------------------------------
try {
  const requested = await waitFor(
    (f) => f.type === 'event.approval.requested',
    90000,
    'event.approval.requested',
  );
  const approval = requested.payload;
  log('approval requested', `${approval.tool_name}: ${approval.action}`);
  const decision = await api(
    'POST',
    `/sessions/${sessionId}/approvals/${approval.approval_id}`,
    { decision: 'approved' },
  );
  if (decision.code !== 0) fail('approve', decision);
  else log('approved', `resolved_at=${decision.data.resolved_at}`);
} catch (error) {
  fail('approval flow', error.message);
}

// 8. wait for the turn to settle -------------------------------------------------
try {
  await waitFor(
    (f) =>
      f.type === 'prompt.completed' ||
      (f.type === 'turn.ended' && f.payload?.reason !== undefined),
    90000,
    'prompt.completed / turn.ended',
  );
  log('turn settled');
} catch (error) {
  fail('turn settle', error.message);
  const abort = await api('POST', `/sessions/${sessionId}/prompts/${promptId}:abort`, {});
  log('abort attempted', `code=${abort.code}`);
}

// 9. summary + cleanup -------------------------------------------------------------
const kinds = [...new Set(seen)];
log('event types observed', kinds.join(', '));
const finalSnap = await api('GET', `/sessions/${sessionId}/snapshot`);
const texts = finalSnap.data.messages.items
  .flatMap((m) => m.content)
  .filter((c) => c.type === 'text')
  .map((c) => c.text)
  .join('\n');
log('final transcript contains echo output?', texts.includes('kiki-smoke') ? 'yes' : 'no (check events)');

const archived = await api('POST', `/sessions/${sessionId}:archive`);
log('throwaway session archived', `code=${archived.code}`);

ws.close();
console.log(process.exitCode ? '\x1b[31mSMOKE FAILED\x1b[0m' : '\x1b[32mSMOKE PASSED\x1b[0m');
process.exit(process.exitCode ?? 0);
