import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeSessionById, getLiveSessionById, IAgentContextMemoryService, IAgentLifecycleService, IEventDispatcher, ISessionIndex, ISessionInteractionService, IWireService, resumeSessionById } from '@kiki/agent-core-v2';
import { TRANSCRIPT_COVERAGE_VERSION } from '@kiki/transcript';
import { expect } from 'vitest';
import { type RunningServer, startServer } from '../../src/start';
import { authHeaders } from './auth';
import { TEST_HOST_IDENTITY } from './hostIdentity';

interface Envelope<T> { readonly code: number; readonly msg: string; readonly data: T }
interface ShadowPlan { readonly toolCallId: string; readonly plan: string }
interface ShadowSession {
  readonly id: string; readonly cwd: string; title: string | undefined; archived: boolean;
  readonly turns: string[]; readonly plans: ShadowPlan[]; readonly receipts: Map<string, string>; readonly durableIds: string[];
}

/** Receipt returned by a completed stateful session sequence run. */
export interface SequenceReceipt { readonly seed: number; readonly weights: Record<string, number>; readonly history: readonly string[]; readonly convergedSessions: number }

function createPrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296; };
}

/** TigerBeetle VOPR-style swarm weight sampler: assigns [1..100] to k-of-n commands and zeroes the remaining n-k. */
export function sampleSwarmWeights(seed: number, names: readonly string[]): Record<string, number> {
  const rng = createPrng(seed ^ 0x9e3779b9), n = names.length;
  const k = Math.min(n - 1, Math.max(3, 3 + Math.floor(rng() * Math.max(1, n - 3))));
  const copy = [...names];
  for (let i = n - 1; i > 0; i -= 1) { const j = Math.floor(rng() * (i + 1)); [copy[i], copy[j]] = [copy[j]!, copy[i]!]; }
  const active = new Set(copy.slice(0, k)), weights: Record<string, number> = {};
  for (const name of names) weights[name] = active.has(name) ? 1 + Math.floor(rng() * 100) : 0;
  return weights;
}

/** Runs pinned witness prefixes, swarm-weighted stateful transitions, and a final hot-vs-cold convergence check. */
export async function runSessionSequence(opts: { readonly seed: number; readonly steps?: number }): Promise<SequenceReceipt> {
  const rng = createPrng(opts.seed);
  const commandNames = ['create', 'send', 'planRead', 'coldOpen', 'older', 'reconcile', 'renameArchive', 'restart'] as const;
  const weights = sampleSwarmWeights(opts.seed, commandNames), history: string[] = [];
  const sessions = new Map<string, ShadowSession>();
  const home = await mkdtemp(join(tmpdir(), 'kiki-seq-'));
  const workspaces = [join(home, 'ws-0'), join(home, 'ws-1')];
  await Promise.all(workspaces.map((w) => mkdir(w, { recursive: true })));

  let llmSeq = 0;
  const provider: Server = createServer((req, res) => {
    void (async () => {
      for await (const _c of req) void _c;
      llmSeq += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ id: `c-${llmSeq}`, choices: [{ index: 0, delta: { content: `ok-${llmSeq}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } })}\n\ndata: [DONE]\n\n`);
    })();
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const port = (provider.address() as { readonly port: number }).port;
  await writeFile(join(home, 'config.toml'), [
    'default_model = "stub"', '[search]', 'enabled = false', '[cron]', 'manualTick = true',
    '[providers.stub]', 'type = "openai"', `base_url = "http://127.0.0.1:${port}/v1"`, 'api_key = "stub"',
    '[models.stub]', 'provider = "stub"', 'model = "stub"', 'max_context_size = 32000',
  ].join('\n'));

  let server: RunningServer | undefined, base = '', seqCounter = 0;
  const boot = async (): Promise<void> => {
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent', userSkillDir: join(home, 'skills'), userAgentProfileHomeDir: join(home, 'agents') });
    base = `http://127.0.0.1:${server.port}`;
  };
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Envelope<T>> => {
    const url = new URL(path, base);
    if (/\/transcript(?:\/ops)?$/u.test(url.pathname)) url.searchParams.set('transcript_coverage_version', String(TRANSCRIPT_COVERAGE_VERSION));
    const res = await fetch(url, { method, headers: authHeaders(server!, body === undefined ? {} : { 'content-type': 'application/json' }), body: body === undefined ? undefined : JSON.stringify(body) } as never);
    return (await res.json()) as Envelope<T>;
  };
  const readAllTurns = async (id: string, pageSize: number): Promise<string[]> => {
    const out: string[] = [];
    let cur: { turn?: string; item?: string } | undefined;
    for (let g = 0; g < 50; g += 1) {
      const qs = new URLSearchParams({ agent_id: 'main', page_size: String(pageSize) });
      if (cur?.item !== undefined) qs.set('before_item', cur.item); else if (cur?.turn !== undefined) qs.set('before_turn', cur.turn);
      const p = await call<{ items: { kind: string; turnId?: string }[]; has_more: boolean; next_cursor?: string; read?: { readiness?: string } }>('GET', `/api/sessions/${id}/transcript?${qs.toString()}`);
      expect(p.code).toBe(0);
      if (p.data.read?.readiness === 'preparing' && p.data.next_cursor !== undefined) { cur = { item: p.data.next_cursor }; continue; }
      const ids = p.data.items.filter((x) => x.kind === 'turn').map((x) => x.turnId!);
      out.unshift(...ids);
      if (!p.data.has_more || ids.length === 0) break;
      cur = { turn: ids[0] };
    }
    expect(new Set(out).size).toBe(out.length);
    return out;
  };
  const flushMain = async (id: string): Promise<void> => {
    const main = getLiveSessionById(server!.core.accessor, id)?.accessor.get(IAgentLifecycleService).get('main');
    if (main !== undefined) { await main.accessor.get(IEventDispatcher).flush(); await main.accessor.get(IWireService).flush(); }
  };
  const waitSettled = async (id: string, minTurns: number): Promise<string[]> => {
    for (let i = 0; i < 200; i += 1) {
      const s = await call<{ busy?: boolean }>('GET', `/api/sessions/${id}`);
      const turns = await readAllTurns(id, 20);
      if (s.code === 0 && s.data.busy !== true && turns.length >= minTurns) break;
      await new Promise<void>((r) => setTimeout(r, 15));
    }
    await flushMain(id);
    return readAllTurns(id, 20);
  };
  const createCmd = async (): Promise<ShadowSession> => {
    const cwd = workspaces[sessions.size % workspaces.length]!;
    const res = await call<{ id: string }>('POST', '/api/sessions', { metadata: { cwd }, agent_config: { permission_mode: 'manual' } });
    expect(res.code).toBe(0);
    const entry: ShadowSession = { id: res.data.id, cwd, title: undefined, archived: false, turns: [], plans: [], receipts: new Map(), durableIds: [] };
    sessions.set(entry.id, entry);
    return entry;
  };
  const sendCmd = async (s: ShadowSession, optsSend?: { withPlan?: boolean; mode?: 'fresh' | 'idempotent' | 'conflict' }): Promise<void> => {
    const prev = [...s.receipts.entries()];
    const mode = optsSend?.mode ?? (prev.length > 0 && rng() < 0.25 ? (rng() < 0.5 ? 'idempotent' : 'conflict') : 'fresh');
    if (mode !== 'fresh' && prev.length > 0) {
      const [pid, orig] = prev[Math.floor(rng() * prev.length)]!;
      const replay = await call('POST', `/api/sessions/${s.id}/prompts`, { prompt_id: pid, content: [{ type: 'text', text: mode === 'idempotent' ? orig : `${orig}-mut` }] });
      if (mode === 'conflict') expect(replay.code).not.toBe(0); else expect(replay.code).toBe(0);
      expect(await waitSettled(s.id, s.turns.length)).toEqual(s.turns);
      return;
    }
    seqCounter += 1;
    const pid = `pid-${opts.seed}-${seqCounter}`, text = `msg-${seqCounter}`, durable = seqCounter % 2 === 0;
    expect((await call('POST', `/api/sessions/${s.id}/prompts`, { prompt_id: pid, admission: durable ? 'durable' : undefined, content: [{ type: 'text', text }] })).code).toBe(0);
    let nowTurns = await waitSettled(s.id, s.turns.length + 1);
    if (optsSend?.withPlan === true) {
      const handle = (await resumeSessionById(server!.core.accessor, s.id))!;
      const main = handle.accessor.get(IAgentLifecycleService).get('main') ?? await handle.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
      const callId = `plan-${seqCounter}`, planText = `# Plan ${seqCounter}`;
      main.accessor.get(IAgentContextMemoryService).append(
        { role: 'assistant', content: [], toolCalls: [{ type: 'function', id: callId, name: 'ExitPlanMode', arguments: '{}' }] },
        { role: 'tool', content: [{ type: 'text', text: 'Plan approved.' }], toolCalls: [], toolCallId: callId },
      );
      const inter = handle.accessor.get(ISessionInteractionService);
      inter.enqueue({ id: `apr-${seqCounter}`, kind: 'approval', payload: { toolCallId: callId, toolName: 'ExitPlanMode', action: 'plan', display: { kind: 'plan_review', plan: planText } }, origin: { agentId: 'main', turnId: nowTurns.length } });
      inter.respond(`apr-${seqCounter}`, { decision: 'approved' });
      await flushMain(s.id);
      s.plans.push({ toolCallId: callId, plan: planText });
      nowTurns = await readAllTurns(s.id, 20);
    }
    expect(nowTurns.slice(0, s.turns.length)).toEqual(s.turns);
    expect(nowTurns.length).toBeGreaterThan(s.turns.length);
    s.turns.splice(0, s.turns.length, ...nowTurns);
    s.receipts.set(pid, text);
    if (durable) s.durableIds.push(pid);
  };
  const inspectSession = async (s: ShadowSession) => {
    const turns = await readAllTurns(s.id, 3);
    const plans = (await call<{ plans: { tool_call_id: string; plan: string }[] }>('GET', `/api/sessions/${s.id}/transcript/plan?agent_id=main`)).data.plans.map((p) => ({ toolCallId: p.tool_call_id, plan: p.plan }));
    const durableIds = ((await call<{ ingress?: { prompt_id: string }[] }>('GET', `/api/sessions/${s.id}/prompts?admission=durable`)).data.ingress ?? []).map((p) => p.prompt_id).toSorted();
    const meta = (await call<{ title?: string; archived: boolean }>('GET', `/api/sessions/${s.id}`)).data;
    return { turns, plans, durableIds, title: s.title === undefined ? undefined : meta.title, archived: Boolean(meta.archived) };
  };

  try {
    await boot();
    history.push('witness:planRead->coldOpen');
    const s0 = await createCmd();
    await sendCmd(s0, { withPlan: true });
    await sendCmd(s0, { mode: 'fresh' });
    await closeSessionById(server!.core.accessor, s0.id);
    expect(getLiveSessionById(server!.core.accessor, s0.id)).toBeUndefined();
    expect((await call<{ plans: { tool_call_id: string; plan: string }[] }>('GET', `/api/sessions/${s0.id}/transcript/plan?agent_id=main`)).data.plans.map((p) => ({ toolCallId: p.tool_call_id, plan: p.plan }))).toEqual(s0.plans);
    expect(getLiveSessionById(server!.core.accessor, s0.id)).toBeUndefined();
    expect(await readAllTurns(s0.id, 5)).toEqual(s0.turns);

    history.push('witness:older->liveSend');
    await sendCmd(s0, { mode: 'fresh' });
    await closeSessionById(server!.core.accessor, s0.id);
    expect(await readAllTurns(s0.id, 2)).toEqual(s0.turns);
    await sendCmd(s0, { mode: 'fresh' });
    expect((await call<{ items: { kind: string; turnId?: string }[] }>('GET', `/api/sessions/${s0.id}/transcript?agent_id=main&page_size=2`)).data.items.filter((i) => i.kind === 'turn').map((i) => i.turnId)).toEqual(s0.turns.slice(-2));
    expect(await readAllTurns(s0.id, 2)).toEqual(s0.turns);

    history.push('witness:reconcile+receipts');
    const idx = server!.core.accessor.get(ISessionIndex) as ISessionIndex & { reconcileNow: () => Promise<void> };
    await Promise.all([idx.reconcileNow(), idx.reconcileNow(), sendCmd(s0, { mode: 'idempotent' })]);
    await sendCmd(s0, { mode: 'conflict' });

    let restarts = 0;
    for (let step = 0; step < (opts.steps ?? 14); step += 1) {
      const list = [...sessions.values()], unarchived = list.filter((x) => !x.archived);
      const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;
      const enabled = commandNames.filter((c) => c === 'create' ? sessions.size < 4 : c === 'send' ? unarchived.length > 0 : c === 'older' ? list.some((x) => x.turns.length >= 2) : c === 'restart' ? restarts < 1 : list.length > 0);
      const pool = enabled.some((c) => weights[c]! > 0) ? enabled.filter((c) => weights[c]! > 0) : enabled;
      let roll = rng() * pool.reduce((a, c) => a + Math.max(1, weights[c]!), 0), chosen: (typeof commandNames)[number] = pool[0]!;
      for (const c of pool) { roll -= Math.max(1, weights[c]!); if (roll <= 0) { chosen = c; break; } }
      history.push(`${step}:${chosen}`);
      if (chosen === 'create') await createCmd();
      else if (chosen === 'send') await sendCmd(pick(unarchived), { withPlan: rng() < 0.3 });
      else if (chosen === 'planRead') {
        const s = pick(list), wasCold = getLiveSessionById(server!.core.accessor, s.id) === undefined;
        expect((await call<{ plans: { tool_call_id: string; plan: string }[] }>('GET', `/api/sessions/${s.id}/transcript/plan?agent_id=main`)).data.plans.map((p) => ({ toolCallId: p.tool_call_id, plan: p.plan }))).toEqual(s.plans);
        if (wasCold) expect(getLiveSessionById(server!.core.accessor, s.id)).toBeUndefined();
      } else if (chosen === 'coldOpen') {
        const s = pick(list);
        if (getLiveSessionById(server!.core.accessor, s.id) !== undefined) await closeSessionById(server!.core.accessor, s.id);
        expect((await call<{ items: { kind: string; turnId?: string }[] }>('GET', `/api/sessions/${s.id}/transcript?agent_id=main&page_size=3`)).data.items.filter((i) => i.kind === 'turn').map((i) => i.turnId)).toEqual(s.turns.slice(-3));
        expect(getLiveSessionById(server!.core.accessor, s.id)).toBeUndefined();
      } else if (chosen === 'older') { const s = pick(list.filter((x) => x.turns.length >= 2)); expect(await readAllTurns(s.id, 2)).toEqual(s.turns); }
      else if (chosen === 'reconcile') {
        const index = server!.core.accessor.get(ISessionIndex) as ISessionIndex & { reconcileNow: () => Promise<void> };
        await Promise.all([index.reconcileNow(), index.reconcileNow()]);
        expect(new Set((await call<{ items: { id: string }[] }>('GET', '/api/sessions?limit=50')).data.items.map((i) => i.id))).toEqual(new Set(unarchived.map((s) => s.id)));
      } else if (chosen === 'renameArchive') {
        const s = pick(list);
        if (rng() < 0.6 || (unarchived.length <= 1 && !s.archived)) { s.title = `Title-${opts.seed}-${step}`; expect((await call('POST', `/api/sessions/${s.id}/profile`, { title: s.title })).code).toBe(0); }
        else { expect((await call('POST', `/api/sessions/${s.id}:${s.archived ? 'restore' : 'archive'}`, {})).code).toBe(0); s.archived = !s.archived; }
      } else if (chosen === 'restart') { restarts += 1; await server!.close(); server = undefined; await boot(); }
    }

    history.push('convergence:hotVsCold');
    const hotView = new Map<string, Awaited<ReturnType<typeof inspectSession>>>();
    for (const s of sessions.values()) hotView.set(s.id, await inspectSession(s));
    await server!.close(); server = undefined; await boot();
    for (const s of sessions.values()) {
      expect(getLiveSessionById(server!.core.accessor, s.id)).toBeUndefined();
      const cold = await inspectSession(s);
      expect(getLiveSessionById(server!.core.accessor, s.id)).toBeUndefined();
      expect(cold).toEqual(hotView.get(s.id));
      expect(cold).toEqual({ turns: s.turns, plans: s.plans, durableIds: s.durableIds.toSorted(), title: s.title, archived: s.archived });
    }
    return { seed: opts.seed, weights, history, convergedSessions: sessions.size };
  } catch (cause) {
    throw new Error(`SessionSequence failed (replay seed=${opts.seed}): weights=${JSON.stringify(weights)} history=${JSON.stringify(history)}`, { cause });
  } finally {
    if (server !== undefined) await server.close().catch(() => undefined);
    provider.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
