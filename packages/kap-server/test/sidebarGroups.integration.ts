import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  CREATED_BY_SESSION_ID_KEY,
  IAppendLogStore,
  IBootstrapService,
  IConfigRegistry,
  IConfigService,
  IMemoryScopes,
  IMemoryStore,
  IPluginService,
  ISessionIndex,
  ISessionManager,
  IWorkspaceService,
  SESSION_GROUP_ID_KEY,
  SESSION_GROUP_ORIGIN_KEY,
} from '@kiki/agent-core-v2';
import { IMcpConfigStore } from '@kiki/agent-core-v2/app/mcpConfig/configStore';
import { IMemoryPersistence } from '@kiki/agent-core-v2/persistence/interface/memoryPersistence';
import { encodeWorkDirKey } from '@kiki/agent-core-v2/_base/utils/workdir-slug';
import { createKlient } from '@kiki/klient/http';
import {
  ErrorCode,
  PEER_BRIDGE_CAPABILITY_CHUNKED_V1,
  PEER_BRIDGE_CAPABILITY_GROUP_IDENTITY_V1,
  bridgeCreateSchema,
  matchConnectionOperation,
} from '@kiki/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { readLive, writeLive, type LiveServices } from '../src/services/portableSpace/liveSpace';
import { toUnits } from '../src/services/portableSpace/treeProjection';
import { createBridgedThread } from '../src/services/threadBridge/createThread';
import { type RunningServer, startServer } from '../src/start';
import { PeerBridgeConnection, PeerBridgeRegistry } from '../src/transport/klient/peerBridgeSocket';
import { JournalWatermarkIndex } from '../src/transport/ws/v1/journalWatermarkIndex';
import { SessionEventJournal, sessionJournalPath, type EventEnvelope } from '../src/transport/ws/v1/sessionEventJournal';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

function makeEnvelope(type: string, seq: number): EventEnvelope {
  return {
    type,
    seq,
    timestamp: new Date().toISOString(),
    payload: { seq },
  };
}

describe('JournalWatermarkIndex crash recovery, attention separation, and epoch reset', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('tracks durable flush, keeps metadata-only events from advancing attentionSeq, recovers dirty crashes, and handles epoch reset', async () => {
    const eventsDir = await mkdtemp(join(tmpdir(), 'kiki-wm-idx-'));
    dirs.push(eventsDir);

    const idx1 = new JournalWatermarkIndex(eventsDir);
    await idx1.prepare();
    expect(idx1.isCovered).toBe(true);
    expect(idx1.getCovered('s_never_written')).toEqual({ epoch: '', seq: 0, attentionSeq: 0 });

    const journalPath = sessionJournalPath(eventsDir, 's_attn');
    const j1 = await SessionEventJournal.open(journalPath, undefined, 1000, undefined, idx1.hookFor('s_attn'));
    const epoch1 = j1.epoch;
    j1.append(j1.nextSeq(), makeEnvelope('turn.ended', 1));
    j1.append(j1.nextSeq(), makeEnvelope('session.meta.updated', 2));
    j1.append(j1.nextSeq(), makeEnvelope('session.meta.updated', 3));
    await j1.close();

    expect(idx1.getCovered('s_attn')).toEqual({ epoch: epoch1, seq: 3, attentionSeq: 1 });

    idx1.markDirty('s_attn', 'simulated_crash');
    expect(idx1.getCovered('s_attn')).toBeUndefined();
    expect(idx1.stats().repairMisses).toBe(1);
    await idx1.close();

    const idx2 = new JournalWatermarkIndex(eventsDir);
    expect(idx2.getCovered('s_attn')).toBeUndefined();
    expect(idx2.stats().legacyMisses).toBe(1);
    await idx2.prepare();
    expect(idx2.getCovered('s_attn')).toEqual({ epoch: epoch1, seq: 3, attentionSeq: 1 });

    await writeFile(journalPath, 'corrupt-no-header-line\n', 'utf8');
    const j2 = await SessionEventJournal.open(journalPath, undefined, 1000, undefined, idx2.hookFor('s_attn'));
    const epoch2 = j2.epoch;
    expect(epoch2).not.toBe(epoch1);
    j2.append(j2.nextSeq(), makeEnvelope('turn.started', 1));
    await j2.close();

    const afterReset = idx2.getCovered('s_attn');
    expect(afterReset).toEqual({ epoch: epoch2, seq: 1, attentionSeq: 1 });
    await idx2.close();
  });
});

describe('sidebar routes, zero-disk cold watermarks, PortableSpace, and ThreadBridge negotiation', () => {
  const homes: string[] = [];
  let server: RunningServer | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    for (const dir of homes.splice(0)) {
      await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('serves 50 cold units with zero journal/metadata misses when covered, enforces cursor binding, detaches groups, and preserves /api/sessions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-sidebar-http-'));
    homes.push(home);
    const workDir = join(home, 'repo');
    await mkdir(workDir, { recursive: true });
    const wsId = encodeWorkDirKey(workDir);
    const eventsDir = join(home, 'server', 'events');
    await mkdir(eventsDir, { recursive: true });

    const writeCold = async (
      id: string,
      updatedAt: number,
      extra: Record<string, unknown> = {},
      journalSeq?: { readonly seq: number; readonly attn: number },
    ) => {
      const dir = join(home, 'sessions', wsId, id);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'state.json'),
        JSON.stringify({
          version: 1,
          id,
          title: `Title ${id}`,
          cwd: workDir,
          createdAt: updatedAt - 1000,
          updatedAt,
          archived: false,
          ...extra,
        }),
        'utf8',
      );
      if (journalSeq !== undefined) {
        const jPath = sessionJournalPath(eventsDir, id);
        const header = JSON.stringify({
          kind: 'journal_header',
          version: 1,
          epoch: `ep_${id}`,
          created_at: updatedAt,
          last_seq: journalSeq.seq,
          attention_seq: journalSeq.attn,
        });
        await writeFile(jPath, `${header}\n`, 'utf8');
      }
    };

    await writeCold('grp_open', 200_000, {
      custom: {
        [SESSION_GROUP_ID_KEY]: 'grp_demo_1',
        externalClient: {
          driver: 'external',
          connectionId: 'conn_ext_1',
          clientName: 'Vibe42',
          sessionRef: 'v42:1',
        },
      },
    }, { seq: 7, attn: 4 });
    await writeCold('grp_child_old', 100_000, {
      custom: {
        [SESSION_GROUP_ID_KEY]: 'grp_demo_1',
        [CREATED_BY_SESSION_ID_KEY]: 'grp_open',
        created_by_agent_id: 'agent-7',
        child_session_kind: 'child',
        parent_session_id: 'grp_open',
      },
    }, { seq: 5, attn: 2 });

    for (let i = 0; i < 49; i += 1) {
      await writeCold(`cold_${String(i).padStart(2, '0')}`, 190_000 - i * 100, {}, { seq: i + 1, attn: 1 });
    }

    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      env: { ...process.env, KIKI_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL: 'true' },
    });
    await server.core.accessor.get(IWorkspaceService).createOrTouch(workDir, 'Repo');
    const idxStatus = await server.core.accessor.get(ISessionIndex).prepare();
    expect(idxStatus.state).toBe('ready');
    const broadcaster = server.broadcaster;
    if (!broadcaster) throw new Error('expected broadcaster on running server');
    await broadcaster.prepareWatermarkIndex();

    const baseUrl = `http://127.0.0.1:${server.port}`;
    const client = createKlient({ endpoint: baseUrl, token: server.localOwnerToken });
    const rest = client.rest;
    if (!rest) throw new Error('expected rest facade on klient');

    const meta = await rest.meta();
    expect(meta.capabilities.sidebar_groups).toBe(true);

    const beforeStats = broadcaster.watermarkStats();
    expect(beforeStats.covered).toBe(true);

    const page1 = await rest.sidebar.list({ page_size: 50 });
    const samplesMs: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const t0 = performance.now();
      const sampled = await rest.sidebar.list({ page_size: 50 });
      samplesMs.push(performance.now() - t0);
      expect(sampled.units).toHaveLength(50);
    }
    const sortedMs = [...samplesMs].sort((a, b) => a - b);
    const p50Ms = sortedMs[Math.floor(sortedMs.length * 0.5)]!;
    const p95Ms = sortedMs[Math.min(sortedMs.length - 1, Math.floor(sortedMs.length * 0.95) - 1)]!;
    console.log('[sidebar-cold-50-units]', JSON.stringify({ p50Ms: Number(p50Ms.toFixed(2)), p95Ms: Number(p95Ms.toFixed(2)), coveredHits: broadcaster.watermarkStats().coveredHits - beforeStats.coveredHits }));

    const afterStats = broadcaster.watermarkStats();
    expect(afterStats.coveredHits - beforeStats.coveredHits).toBe(51 * 21);
    expect(afterStats.repairMisses).toBe(beforeStats.repairMisses);
    expect(afterStats.legacyMisses).toBe(beforeStats.legacyMisses);
    expect(p95Ms).toBeLessThan(20);

    expect(page1.units).toHaveLength(50);
    const groupUnit = page1.units[0]!;
    expect(groupUnit.kind).toBe('group');
    if (groupUnit.kind === 'group') {
      expect(groupUnit.id).toBe('grp_demo_1');
      expect(groupUnit.member_count).toBe(2);
      expect(groupUnit.members.map((m) => m.id)).toEqual(['grp_open', 'grp_child_old']);
      expect(groupUnit.members[0]!.last_seq).toBe(7);
      expect(groupUnit.members[0]!.attention_cursor).toEqual({ epoch: 'ep_grp_open', seq: 4 });
      expect(groupUnit.members[0]!.external_client).toEqual({
        driver: 'external',
        connectionId: 'conn_ext_1',
        clientName: 'Vibe42',
        sessionRef: 'v42:1',
      });
      expect(groupUnit.members[1]!.last_seq).toBe(5);
      expect(groupUnit.members[1]!.attention_cursor).toEqual({ epoch: 'ep_grp_child_old', seq: 2 });
      expect(groupUnit.members[1]!.created_by_agent_id).toBe('agent-7');
      expect(groupUnit.members[1]!.child_session_kind).toBe('child');
      expect(groupUnit.members[1]!.parent_session_id).toBe('grp_open');
    }

    const badCursorRes = await fetch(
      `${baseUrl}/api/sidebar/sessions?page_size=10&sort=title&cursor=${encodeURIComponent(page1.next_cursor ?? 'invalid')}`,
      { headers: { authorization: `Bearer ${server.localOwnerToken}` } },
    );
    const badCursorEnv = await badCursorRes.json() as { code: number };
    expect(badCursorEnv.code).toBe(ErrorCode.PAGE_TOKEN_MISMATCH);

    const legacyPage = await rest.sessions.list({ page_size: 5 });
    expect(legacyPage.items).toHaveLength(5);
    const flatOpen = legacyPage.items.find((item) => item.id === 'grp_open') as Record<string, unknown> | undefined;
    expect(flatOpen?.['group_id']).toBeUndefined();
    expect((flatOpen?.['metadata'] as Record<string, unknown> | undefined)?.[SESSION_GROUP_ID_KEY]).toBeUndefined();

    expect(matchConnectionOperation('GET', '/api/sidebar/sessions')?.operation).toBe('sidebarSessions');
    expect(matchConnectionOperation('GET', '/api/sidebar/groups/grp_demo_1/members')?.operation).toBe('sidebarGroupMembers');
    expect(matchConnectionOperation('POST', '/api/sidebar/units:resolve')?.operation).toBe('sidebarUnitsResolve');
    expect(matchConnectionOperation('POST', '/api/sessions/grp_child_old:detach-group')?.operation).toBe('sessionDetachGroup');

    const journalReplacementPath = sessionJournalPath(eventsDir, 'cold_00');
    await writeFile(
      journalReplacementPath,
      [
        JSON.stringify({ kind: 'journal_header', version: 1, epoch: 'ep_replaced_ext', created_at: Date.now(), last_seq: 9, attention_seq: 8 }),
        JSON.stringify({ kind: 'event', seq: 9, attention_seq: 8, envelope: { v: 1, seq: 9, type: 'turn.ended', session_id: 'cold_00', time: Date.now(), payload: {} } }),
      ].join('\n') + '\n',
      'utf8',
    );
    const afterExternalReplace = await rest.sidebar.resolveUnits({ session_ids: ['cold_00'] });
    const replacedUnit = afterExternalReplace.units.find((u) => u.kind === 'session' && u.id === 'cold_00');
    expect(replacedUnit?.kind).toBe('session');
    if (replacedUnit?.kind === 'session') {
      expect(replacedUnit.row.last_seq).toBe(9);
      expect(replacedUnit.row.attention_cursor).toEqual({ epoch: 'ep_replaced_ext', seq: 8 });
    }

    const detached = await rest.sessions.detachGroup('grp_child_old');
    expect(detached.detached).toBe(true);
    expect(detached.previous_group_id).toBe('grp_demo_1');

    const resolved = await rest.sidebar.resolveUnits({
      session_ids: ['grp_child_old'],
      group_ids: ['grp_demo_1'],
    });
    expect(resolved.units.some((u) => u.kind === 'session' && u.id === 'grp_child_old')).toBe(true);
    const remainingGroup = resolved.units.find((u) => u.kind === 'group' && u.id === 'grp_demo_1');
    expect(remainingGroup?.kind).toBe('group');
    if (remainingGroup?.kind === 'group') {
      expect(remainingGroup.member_count).toBe(1);
    }

    await client.close();
  });

  it('exports nested-only legacy sessions with resolved group token in export copy without mutating source, and groups siblings on partial import', async () => {
    const srcHome = await mkdtemp(join(tmpdir(), 'kiki-portable-src-'));
    const dstHome = await mkdtemp(join(tmpdir(), 'kiki-portable-dst-'));
    homes.push(srcHome, dstHome);
    const workDir = join(srcHome, 'repo');
    await mkdir(workDir, { recursive: true });
    const wsId = encodeWorkDirKey(workDir);

    const writeNested = async (id: string, doc: Record<string, unknown>) => {
      const dir = join(srcHome, 'sessions', wsId, id, 'session-meta');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'state.json'), JSON.stringify({
        version: 1,
        id,
        title: id,
        cwd: workDir,
        createdAt: 1000,
        updatedAt: 2000,
        archived: false,
        ...doc,
      }), 'utf8');
    };

    await writeNested('leg_root', { createdAt: 1000, updatedAt: 2000 });
    await writeNested('leg_c1', { createdAt: 1100, updatedAt: 2100, custom: { [CREATED_BY_SESSION_ID_KEY]: 'leg_root' } });
    await writeNested('leg_c2', { createdAt: 1200, updatedAt: 2200, custom: { [CREATED_BY_SESSION_ID_KEY]: 'leg_root' } });

    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: srcHome,
      logLevel: 'silent',
    });
    await server.core.accessor.get(ISessionIndex).prepare();

    const makeLive = (s: RunningServer): LiveServices => ({
      bootstrap: s.core.accessor.get(IBootstrapService),
      config: s.core.accessor.get(IConfigService),
      registry: s.core.accessor.get(IConfigRegistry),
      mcp: s.core.accessor.get(IMcpConfigStore),
      memory: s.core.accessor.get(IMemoryStore),
      memoryPersistence: s.core.accessor.get(IMemoryPersistence),
      scopes: s.core.accessor.get(IMemoryScopes),
      plugins: s.core.accessor.get(IPluginService),
      sessions: s.core.accessor.get(ISessionManager),
      index: s.core.accessor.get(ISessionIndex),
      logs: s.core.accessor.get(IAppendLogStore),
    });

    const exportedC1 = await readLive(makeLive(server), { mode: 'ids', sessionIds: ['leg_c1'] }, undefined, false, false);
    const exportedC2 = await readLive(makeLive(server), { mode: 'ids', sessionIds: ['leg_c2'] }, undefined, false, false);
    const c1Doc = JSON.parse(exportedC1.get('sessions/leg_c1/state.json')!.toString('utf8')) as { custom?: Record<string, unknown> };
    const c2Doc = JSON.parse(exportedC2.get('sessions/leg_c2/state.json')!.toString('utf8')) as { custom?: Record<string, unknown> };
    expect(typeof c1Doc.custom?.[SESSION_GROUP_ID_KEY]).toBe('string');
    expect(c1Doc.custom?.[SESSION_GROUP_ID_KEY]).toBe(c2Doc.custom?.[SESSION_GROUP_ID_KEY]);

    const srcOnDisk = JSON.parse(
      await (await import('node:fs/promises')).readFile(join(srcHome, 'sessions', wsId, 'leg_c1', 'session-meta', 'state.json'), 'utf8'),
    ) as { custom?: Record<string, unknown> };
    expect(srcOnDisk.custom?.[SESSION_GROUP_ID_KEY]).toBeUndefined();

    await server.close();
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: dstHome,
      logLevel: 'silent',
    });
    const dstLive = makeLive(server);
    const registry = dstLive.registry;
    const onlyC1 = new Map([['sessions/leg_c1/state.json', exportedC1.get('sessions/leg_c1/state.json')!]]);
    await writeLive(dstLive, toUnits(onlyC1, registry), new Map(), 'merge');
    await dstLive.index.prepare();
    const afterC1 = await dstLive.index.listSidebarUnits!({
      filter: { archived: 'hide', privacy: 'hide' },
      sort: 'updated_desc',
      limit: 10,
      memberLimit: 50,
    });
    expect(afterC1.units).toHaveLength(1);
    expect(afterC1.units[0]!.kind).toBe('group');
    expect(afterC1.units[0]!.memberCount).toBe(1);

    const both = new Map([
      ['sessions/leg_c1/state.json', exportedC1.get('sessions/leg_c1/state.json')!],
      ['sessions/leg_c2/state.json', exportedC2.get('sessions/leg_c2/state.json')!],
    ]);
    await writeLive(dstLive, toUnits(both, registry), toUnits(onlyC1, registry), 'merge');
    await (dstLive.index as { reconcileNow?: () => Promise<void> }).reconcileNow?.();
    const afterBoth = await dstLive.index.listSidebarUnits!({
      filter: { archived: 'hide', privacy: 'hide' },
      sort: 'updated_desc',
      limit: 10,
      memberLimit: 50,
    });
    expect(afterBoth.units).toHaveLength(1);
    expect(afterBoth.units[0]!.kind).toBe('group');
    expect(afterBoth.units[0]!.memberCount).toBe(2);
  });

  it('negotiates group_identity_v1 over peer_socket, keeps bridgeCreateSchema strict, and stamps bridged provenance + group identity', async () => {
    const registry = new PeerBridgeRegistry();
    const sent: unknown[] = [];
    const modern = new PeerBridgeConnection('grant_modern', registry, (frame) => {
      sent.push(frame);
      return true;
    });
    modern.receive({
      type: 'bridge_attach',
      id: 'att_1',
      data: { capabilities: [PEER_BRIDGE_CAPABILITY_CHUNKED_V1, PEER_BRIDGE_CAPABILITY_GROUP_IDENTITY_V1] },
    });
    expect(registry.supportsCapability('grant_modern', PEER_BRIDGE_CAPABILITY_GROUP_IDENTITY_V1, 'create')).toBe(true);

    const legacy = new PeerBridgeConnection('grant_legacy', registry, () => true);
    legacy.receive({
      type: 'bridge_attach',
      id: 'att_2',
      data: { capabilities: [PEER_BRIDGE_CAPABILITY_CHUNKED_V1] },
    });
    expect(registry.supportsCapability('grant_legacy', PEER_BRIDGE_CAPABILITY_GROUP_IDENTITY_V1, 'create')).toBe(false);

    const bridgeUuid = '11111111-1111-4111-8111-111111111111';
    const homeUuid = '22222222-2222-4222-8222-222222222222';
    const validCreate = bridgeCreateSchema.safeParse({
      bridgeId: bridgeUuid,
      revision: 1,
      source: { hostId: 'host-a', workspaceId: 'ws-a', sessionId: 'sess-a' },
      idempotencyKey: 'idem-1',
      groupId: 'grp_origin_1',
      groupOrigin: { homeId: homeUuid, hostId: 'host-a', bridgeId: bridgeUuid },
    });
    expect(validCreate.success).toBe(true);
    const invalidExtra = bridgeCreateSchema.safeParse({
      bridgeId: bridgeUuid,
      revision: 1,
      source: { hostId: 'host-a', workspaceId: 'ws-a', sessionId: 'sess-a' },
      idempotencyKey: 'idem-1',
      unknownField: 'rejected',
    });
    expect(invalidExtra.success).toBe(false);

    const home = await mkdtemp(join(tmpdir(), 'kiki-bridge-grp-'));
    homes.push(home);
    const workDir = join(home, 'repo');
    await mkdir(workDir, { recursive: true });
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    const workspace = await server.core.accessor.get(IWorkspaceService).createOrTouch(workDir, 'Repo');
    const created = await createBridgedThread(
      server.core,
      workspace,
      'host-b',
      validCreate.data!,
      'sess-remote-child',
      'prompt-1',
    );
    expect(created.ref.sessionId).toBe('sess-remote-child');
    const summary = await server.core.accessor.get(ISessionIndex).get('sess-remote-child');
    expect(summary?.custom?.[CREATED_BY_SESSION_ID_KEY]).toBe('host-a:sess-a');
    expect(summary?.custom?.[SESSION_GROUP_ID_KEY]).toBe('grp_origin_1');
    expect(summary?.custom?.[SESSION_GROUP_ORIGIN_KEY]).toEqual({ homeId: homeUuid, hostId: 'host-a', bridgeId: bridgeUuid });

    const parentHandle = await server.core.accessor.get(ISessionManager).create({ workDir, title: 'Child Parent' });
    const childHandle = await server.core.accessor.get(ISessionManager).createChild({
      sourceSessionId: parentHandle.id,
      title: 'Non-Deadlocking Child',
    });
    expect(childHandle.id).not.toBe(parentHandle.id);
    const childMeta = await server.core.accessor.get(ISessionIndex).get(childHandle.id);
    const parentMeta = await server.core.accessor.get(ISessionIndex).get(parentHandle.id);
    expect(childMeta?.groupId).toBeDefined();
    expect(childMeta?.groupId).toBe(parentMeta?.groupId);

    modern.dispose();
    legacy.dispose();
  });
});
