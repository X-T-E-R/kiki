import { fork } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const isMain = Boolean(process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename);

if (process.argv[2] === '--worker') {
  const [, , , kikiHome, osHome] = process.argv;
  let giantCheckpointJsonDecodes = 0, coldCanonicalFallbacks = 0, maxSingleTickStallMs = 0;
  const origParse = JSON.parse;
  JSON.parse = (t, r) => {
    if (typeof t === 'string' && t.length > 262_144 && t.includes('"acceptedDurableFacts"')) giantCheckpointJsonDecodes += 1;
    return origParse(t, r);
  };
  const [{ IWorkspaceInstanceManager }, { encodeWorkDirKey }, { TRANSCRIPT_COVERAGE_VERSION }, { HistoryNavigation }, { startServer }] = await Promise.all([
    import(pathToFileURL(path.join(REPO_ROOT, 'packages/agent-core-v2/src/index.ts')).href),
    import(pathToFileURL(path.join(REPO_ROOT, 'packages/agent-core-v2/src/_base/utils/workdir-slug.ts')).href),
    import(pathToFileURL(path.join(REPO_ROOT, 'packages/transcript/src/index.ts')).href),
    import(pathToFileURL(path.join(REPO_ROOT, 'packages/kap-server/src/services/history/historyNavigation.ts')).href),
    import(pathToFileURL(path.join(REPO_ROOT, 'packages/kap-server/src/start.ts')).href),
  ]);
  fs.mkdirSync(kikiHome, { recursive: true });
  fs.writeFileSync(path.join(kikiHome, 'config.toml'), 'default_model = "m"\n[search]\nenabled = false\n[providers.p]\ntype = "openai_legacy"\nbase_url = "http://127.0.0.1:9/v1"\napi_key = "k"\n[models.m]\nprovider = "p"\nmodel = "m"\nmax_context_size = 32000\n');
  const workspaces = {}, big = 'X'.repeat(40 * 1024);
  const writeSession = (wsId, root, id, turns, subCount) => {
    const dir = path.join(kikiHome, 'sessions', wsId, id), lines = [];
    fs.mkdirSync(path.join(dir, 'agents/main'), { recursive: true });
    for (let t = 0; t < turns; t += 1) {
      const ts = 1_700_000_000_000 + t * 100;
      lines.push(JSON.stringify({ type: 'turn.prompt', turnId: t, promptId: `p${t}`, input: [{ type: 'text', text: `u${t}` }], origin: { kind: 'user' }, time: ts }),
        JSON.stringify({ type: 'context.append_loop_event', event: { type: 'step.begin', turnId: t, step: 1, uuid: `s${t}` }, time: ts + 1 }),
        JSON.stringify({ type: 'context.append_loop_event', event: { type: 'tool.call', turnId: t, stepUuid: `s${t}`, toolCallId: `c${t}`, name: 'Read', args: { path: 'a' } }, time: ts + 2 }),
        JSON.stringify({ type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: `c${t}`, result: { output: big, isError: false } }, time: ts + 3 }),
        JSON.stringify({ type: 'context.append_loop_event', event: { type: 'step.end', turnId: t, step: 1, uuid: `s${t}` }, time: ts + 4 }),
        JSON.stringify({ type: 'turn.ended', turnId: t, reason: 'completed', time: ts + 5 }));
    }
    fs.writeFileSync(path.join(dir, 'agents/main/wire.jsonl'), `${lines.join('\n')}\n`);
    const agents = { main: { type: 'main', model: 'm' } };
    for (let s = 0; s < subCount; s += 1) {
      fs.mkdirSync(path.join(dir, 'agents', `sub-${s}`), { recursive: true });
      fs.writeFileSync(path.join(dir, 'agents', `sub-${s}`, 'wire.jsonl'), '');
      agents[`sub-${s}`] = { type: 'sub', parentAgentId: 'main', status: 'completed', model: 'm' };
    }
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ id, version: 2, title: id, createdAt: 1_700_000_000_000, updatedAt: 1_700_010_000_000, archived: false, cwd: root, agents }));
  };
  for (let w = 0; w < 4; w += 1) {
    const root = path.join(kikiHome, `cold-ws-${w}`); fs.mkdirSync(root, { recursive: true });
    const wsId = encodeWorkDirKey(root);
    workspaces[wsId] = { root, name: `ws-${w}`, created_at: '2026-01-01T00:00:00.000Z', last_opened_at: '2026-01-01T00:00:00.000Z' };
    for (let s = 0; s < 5; s += 1) writeSession(wsId, root, `cat_${w}_${s}`, 1, 0);
  }
  const [ws0, meta0] = Object.entries(workspaces)[0];
  writeSession(ws0, meta0.root, 'roster_n', 2, 30); writeSession(ws0, meta0.root, 'roster_2n', 2, 60); writeSession(ws0, meta0.root, 'tail_heavy', 48, 0);
  fs.writeFileSync(path.join(kikiHome, 'workspaces.json'), JSON.stringify({ version: 1, workspaces, deleted_workspace_ids: [] }));
  const origCanonical = HistoryNavigation.prototype.readCanonicalEntity;
  HistoryNavigation.prototype.readCanonicalEntity = function (...a) { coldCanonicalFallbacks += 1; return origCanonical.apply(this, a); };
  const eld = monitorEventLoopDelay({ resolution: 10 }); eld.enable();
  let lastTick = performance.now();
  const tickTimer = setInterval(() => { const now = performance.now(); maxSingleTickStallMs = Math.max(maxSingleTickStallMs, Math.max(0, now - lastTick - 15)); lastTick = now; }, 15).unref();
  const server = await startServer({ hostIdentity: { productName: 'kiki-probe', version: '0.0.0', platform: 'probe' }, host: '127.0.0.1', port: 0, homeDir: kikiHome, logLevel: 'silent', userSkillDir: path.join(osHome, 'skills'), userAgentProfileHomeDir: path.join(osHome, 'agents') });
  const counters = () => ({ maxSingleTickStallMs: Number(maxSingleTickStallMs.toFixed(2)), eldP99Ms: eld.count > 0 ? Number(Math.max(0, eld.percentile(99) / 1e6 - 10).toFixed(2)) : 0, coldCanonicalFallbacks, giantCheckpointJsonDecodes, watcherRoots: server.core.accessor.get(IWorkspaceInstanceManager).list().length });
  process.on('message', async (m) => {
    if (m?.cmd === 'reset') { maxSingleTickStallMs = 0; coldCanonicalFallbacks = 0; giantCheckpointJsonDecodes = 0; eld.reset(); lastTick = performance.now(); process.send?.({ id: m.id, counters: counters() }); }
    else if (m?.cmd === 'read') process.send?.({ id: m.id, counters: counters() });
    else if (m?.cmd === 'shutdown') { clearInterval(tickTimer); eld.disable(); await server.close(); process.send?.({ id: m.id, ok: true }); process.exit(0); }
  });
  process.send?.({ ready: true, endpoint: `http://127.0.0.1:${server.port}`, token: server.localOwnerToken, cv: TRANSCRIPT_COVERAGE_VERSION });
}

export async function runResourceProbe() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kiki-res-probe-')), kikiHome = path.join(scratch, 'kiki-home'), osHome = path.join(scratch, 'os-home');
  fs.mkdirSync(osHome, { recursive: true });
  const req = createRequire(path.join(REPO_ROOT, 'package.json'));
  const child = fork(import.meta.filename, ['--worker', kikiHome, osHome], {
    cwd: REPO_ROOT,
    execArgv: ['--import', pathToFileURL(path.join(REPO_ROOT, 'build/register-raw-text-loader.mjs')).href, '--import', pathToFileURL(req.resolve('tsx/esm')).href],
    env: { ...process.env, HOME: osHome, USERPROFILE: osHome, KIKI_HOME: kikiHome, KIKI_SEARCH_DISABLED: '1', KIKI_DESKTOP_BUNDLED: '', KIKI_RUNTIME_MANAGED: '' },
  });
  const rpc = (cmd) => new Promise((r) => { const id = Math.random().toString(36).slice(2); const fn = (m) => { if (m?.id === id) { child.off('message', fn); r(m); } }; child.on('message', fn); child.send({ id, cmd }); });
  let maxClientGapMs = 0, beatTimer;
  try {
    const { endpoint, token, cv } = await new Promise((r, rej) => { child.once('message', (m) => m?.ready ? r(m) : rej(new Error('boot'))); child.once('exit', (c) => rej(new Error(`exit ${c}`))); });
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    let lastBeat = performance.now();
    beatTimer = setInterval(async () => { await fetch(`${endpoint}/api/healthz`).catch(() => null); const now = performance.now(); maxClientGapMs = Math.max(maxClientGapMs, Math.max(0, now - lastBeat - 40)); lastBeat = now; }, 40);
    await fetch(`${endpoint}/api/klient/session-view/cat_0_0/snapshot`, { headers });
    await rpc('reset');
    const tN = performance.now(); await fetch(`${endpoint}/api/klient/session-view/roster_n/snapshot`, { headers }); const rosterNMs = performance.now() - tN;
    const t2N = performance.now(); await fetch(`${endpoint}/api/klient/session-view/roster_2n/snapshot`, { headers }); const roster2NMs = performance.now() - t2N;
    const coldCheck = (await rpc('read')).counters;
    const tailBody = await (await fetch(`${endpoint}/api/klient/session-view/tail_heavy/transcript?agent_id=main&page_size=20&transcript_coverage_version=${cv}`, { headers })).json();
    const tailRef = tailBody.data.items.filter((i) => i.kind === 'turn').flatMap((t) => t.steps ?? []).flatMap((s) => s.frames ?? []).flatMap((f) => Object.values(f.contentRefs ?? {}))[0];
    await rpc('reset');
    const hydRes = await fetch(`${endpoint}/api/klient/session-view/tail_heavy/transcript/content`, { method: 'POST', headers, body: JSON.stringify({ agentId: 'main', ref: tailRef }) });
    const tailCounters = (await rpc('read')).counters;
    const wsA = path.join(scratch, 'live-a'), wsB = path.join(scratch, 'live-b'); fs.mkdirSync(wsA); fs.mkdirSync(wsB);
    await fetch(`${endpoint}/api/sessions`, { method: 'POST', headers, body: JSON.stringify({ metadata: { cwd: wsA } }) });
    const createTimes = [];
    for (const wd of [wsA, wsA, wsB, wsB]) {
      const t0 = performance.now(), r = await fetch(`${endpoint}/api/sessions`, { method: 'POST', headers, body: JSON.stringify({ metadata: { cwd: wd } }) });
      if (r.status !== 200) throw new Error(`POST /api/sessions status=${r.status}`);
      createTimes.push(Number((performance.now() - t0).toFixed(2)));
    }
    const endCounters = (await rpc('read')).counters;
    const res = {
      coldWatcherRoots: coldCheck.watcherRoots, liveWatcherRoots: endCounters.watcherRoots, tailHydrateStatus: hydRes.status,
      coldCanonicalFallbacks: tailCounters.coldCanonicalFallbacks, giantCheckpointJsonDecodes: tailCounters.giantCheckpointJsonDecodes + endCounters.giantCheckpointJsonDecodes,
      maxSessionCreateMs: Math.max(...createTimes), maxClientGapMs: Number(maxClientGapMs.toFixed(2)),
      maxSingleTickStallMs: Math.max(tailCounters.maxSingleTickStallMs, endCounters.maxSingleTickStallMs),
      rosterNMs: Number(rosterNMs.toFixed(2)), roster2NMs: Number(roster2NMs.toFixed(2)),
    };
    if (res.coldWatcherRoots !== 0 || res.liveWatcherRoots > 2 || res.tailHydrateStatus !== 200 || res.coldCanonicalFallbacks !== 0 ||
        res.giantCheckpointJsonDecodes !== 0 || res.maxSessionCreateMs > 1500 || res.maxClientGapMs > 1000 ||
        res.maxSingleTickStallMs > 250 || res.roster2NMs > Math.max(res.rosterNMs * 2.2 + 80, 250)) throw new Error(`Probe breach: ${JSON.stringify(res)}`);
    return res;
  } finally {
    clearInterval(beatTimer); await rpc('shutdown').catch(() => child.kill());
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

if (isMain && process.argv[2] !== '--worker') process.stdout.write(`${JSON.stringify(await runResourceProbe())}\n`);
