import { createHash } from 'node:crypto';
import { access, constants, mkdir, mkdtemp, open as fsOpen, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentBlobServiceImpl } from '#/agent/blob/agentBlobServiceImpl';
import {
  HOST_PINNED_MIN_BYTES,
  HOST_PINNED_SUBSCOPE,
  HOSTREF_PROTOCOL,
  HostPinnedSourceChangedError,
  HostPinnedUnsupportedError,
  isHostPinnedSupported,
  openVerifiedHostPinnedStream,
  readHostPinnedRefRecord,
  registerHostPinnedRef,
  verifyHostPinnedRef,
} from '#/agent/media/hostPinnedMedia';
import { SessionMediaStoreService } from '#/agent/media/sessionMediaStoreService';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { StorageGovernanceService } from '#/app/storageGovernance/storageGovernanceService';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { BlobStoreService } from '#/persistence/backends/node-fs/blobStoreService';
import { ContentAddressedStoreService } from '#/persistence/backends/node-fs/contentAddressedStoreService';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import type { IBlobStore } from '#/persistence/interface/blobStore';
import { StorageError, StorageErrors } from '#/persistence/interface/storage';
import { LIGHTWEIGHT_STATE_NAMES, readPersistedAgentCheckpoint } from '#/session/persistedAgentCheckpoint';
import {
  COLD_CHECKPOINT_ARCHIVE_ZST_KEY,
  COLD_CHECKPOINT_PROJECTION_KEY,
  readArchivedReplayCheckpointEnvelope,
  rehydrateColdReplayCheckpoint,
  slimColdReplayCheckpoint,
} from '#/session/replayCheckpointArchive';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import { REPLAY_ABI_VERSION } from '#/state/eventDispatcherService';
import { encodeReplayCheckpointGraph } from '#/state/replayCheckpointCodec';
import { AGENT_WIRE_RECORD_KEY } from '#/wire/record';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeFakeMp4(totalBytes: number): Buffer {
  const ftyp = Buffer.from([
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d,
    0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d,
    0x6d, 0x70, 0x34, 0x31,
  ]);
  const moov = Buffer.from([
    0x00, 0x00, 0x00, 0x08,
    0x6d, 0x6f, 0x6f, 0x76,
  ]);
  const mdatSize = Math.max(16, totalBytes - ftyp.byteLength - moov.byteLength);
  const out = Buffer.alloc(ftyp.byteLength + moov.byteLength + mdatSize);
  ftyp.copy(out, 0);
  moov.copy(out, ftyp.byteLength);
  out.writeUInt32BE(mdatSize, ftyp.byteLength + moov.byteLength);
  out.write('mdat', ftyp.byteLength + moov.byteLength + 4, 'ascii');
  for (let i = ftyp.byteLength + moov.byteLength + 8; i < out.byteLength; i += 4096) {
    out[i] = (i >>> 12) & 0xff;
  }
  return out;
}

function makeSessionCtx(
  sessionScope: string,
  sessionId: string,
  options: { readonly isPrivate: boolean; readonly ephemeral: boolean },
): ISessionContext {
  return {
    _serviceBrand: undefined,
    sessionId,
    workspaceId: 'wd_test',
    ephemeral: options.ephemeral,
    sessionDir: sessionScope,
    scope: (sub?: string) => (sub === undefined ? sessionScope : `${sessionScope}/${sub}`),
    isPrivate: () => options.isPrivate,
  } as unknown as ISessionContext;
}

function makeAgentScope(sessionScope: string, agentId: string): IAgentScopeContext {
  const base = `${sessionScope}/agents/${agentId}`;
  return {
    _serviceBrand: undefined,
    agentId,
    scope: (sub?: string) => (sub === undefined ? base : `${base}/${sub}`),
  } as unknown as IAgentScopeContext;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe('zero-copy CAS, privacy isolation, streaming, HostPinnedRef, checkpoints, and storage governance', () => {
  it('deduplicates 10 concurrent subagents onto 1 CAS inode while keeping private/ephemeral/indeterminate strictly isolated', async () => {
    const homeDir = await makeTempDir('kiki-zc-home-');
    const wsDir = await makeTempDir('kiki-zc-ws-');
    const storage = new FileStorageService(homeDir);
    const blobs = new BlobStoreService(storage);
    const docs = new JsonAtomicDocumentStore(storage);
    const cas = new ContentAddressedStoreService(storage);

    try {
      const mp4 = makeFakeMp4(512 * 1024);
      const srcPath = join(wsDir, 'shared.mp4');
      await writeFile(srcPath, mp4);
      const srcBefore = await stat(srcPath, { bigint: true });

      const publicScope = 'sessions/wd_test/session_pub';
      const pubSession = makeSessionCtx(publicScope, 'session_pub', { isPrivate: false, ephemeral: false });

      const refs = await Promise.all(
        Array.from({ length: 10 }, (_, idx) => {
          const svc = new AgentBlobServiceImpl(
            blobs,
            makeAgentScope(publicScope, `child-${idx}`),
            { current: cas } as never,
            { current: pubSession } as never,
            { current: docs } as never,
          );
          return svc.offloadFile('video/mp4', srcPath);
        }),
      );

      const expectedSha = createHash('sha256').update(mp4).digest('hex');
      const casIno = (await stat(cas.objectPath(expectedSha)!, { bigint: true })).ino;
      expect(casIno).not.toBe(srcBefore.ino);
      await expect(access(srcPath, constants.W_OK)).resolves.toBeUndefined();

      for (let i = 0; i < 10; i += 1) {
        expect(refs[i]).toBe(`blobref:video/mp4;${expectedSha}`);
        const aliasPath = storage.pathFor(`${publicScope}/agents/child-${i}/blobs`, expectedSha)!;
        expect((await stat(aliasPath, { bigint: true })).ino).toBe(casIno);
      }

      const isolatedCases = [
        { name: 'private', ctx: makeSessionCtx('sessions/wd_test/session_priv', 'session_priv', { isPrivate: true, ephemeral: false }) },
        { name: 'ephemeral', ctx: makeSessionCtx('sessions/wd_test/session_eph', 'session_eph', { isPrivate: false, ephemeral: true }) },
        { name: 'indeterminate', ctx: undefined },
      ] as const;

      const privatePayload = makeFakeMp4(128 * 1024);
      const privSrc = join(wsDir, 'secret.mp4');
      await writeFile(privSrc, privatePayload);
      const privSha = createHash('sha256').update(privatePayload).digest('hex');

      for (const item of isolatedCases) {
        const scope = `sessions/wd_test/session_${item.name}`;
        const svc = new AgentBlobServiceImpl(
          blobs,
          makeAgentScope(scope, 'main'),
          { current: cas } as never,
          { current: item.ctx } as never,
          { current: docs } as never,
        );
        const ref = await svc.offloadFile('video/mp4', privSrc);
        expect(ref).toBe(`blobref:video/mp4;${privSha}`);
      }
      expect(await cas.has(privSha)).toBe(false);

      const legacyBytes = Buffer.from('legacy-base64-blob-content');
      const legacyBase64 = legacyBytes.toString('base64');
      const legacyHash = createHash('sha256').update(legacyBase64).digest('hex');
      await blobs.put(`${publicScope}/agents/child-0/blobs`, legacyHash, legacyBytes);
      const child0 = new AgentBlobServiceImpl(
        blobs,
        makeAgentScope(publicScope, 'child-0'),
        { current: cas } as never,
        { current: pubSession } as never,
        { current: docs } as never,
      );
      const loadedParts = await child0.loadParts([
        { type: 'image_url', imageUrl: { url: `blobref:image/png;${legacyHash}` } },
      ]);
      expect(loadedParts[0]).toMatchObject({
        type: 'image_url',
        imageUrl: { url: `data:image/png;base64,${legacyBase64}` },
      });

      const failingBlobs = Object.create(blobs) as IBlobStore;
      failingBlobs.put = async () => {
        throw new StorageError(StorageErrors.codes.STORAGE_DISK_FULL, 'disk full');
      };
      failingBlobs.putStream = async () => {
        throw new StorageError(StorageErrors.codes.STORAGE_DISK_FULL, 'disk full');
      };
      const enospcSvc = new AgentBlobServiceImpl(
        failingBlobs,
        makeAgentScope('sessions/wd_test/session_enospc', 'main'),
        { current: undefined } as never,
        { current: undefined } as never,
      );
      const hugeDataUrl = `data:image/png;base64,${Buffer.alloc(300 * 1024, 0x42).toString('base64')}`;
      await expect(enospcSvc.offloadParts([{ type: 'image_url', imageUrl: { url: hugeDataUrl } }])).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_DISK_FULL,
      });
    } finally {
      await storage.close();
    }
  }, 30_000);

  it('streams openAgentBlob in <=64 KiB ranges without calling blobs.get and shares CAS inode for public materialize + linkAttachmentAlias', async () => {
    const homeDir = await makeTempDir('kiki-sms-home-');
    const storage = new FileStorageService(homeDir);
    const blobs = new BlobStoreService(storage);
    const docs = new JsonAtomicDocumentStore(storage);
    const cas = new ContentAddressedStoreService(storage);

    try {
      const sessionScope = 'sessions/wd_test/session_stream';
      const sessionCtx = makeSessionCtx(sessionScope, 'session_stream', { isPrivate: false, ephemeral: false });
      const mediaStore = new SessionMediaStoreService(
        sessionCtx,
        storage,
        docs,
        blobs,
        { current: cas } as never,
      );

      const mp4 = makeFakeMp4(300 * 1024);
      const expectedSha = createHash('sha256').update(mp4).digest('hex');
      await blobs.put(`${sessionScope}/agents/main/blobs`, expectedSha, mp4);

      const getSpy = vi.spyOn(blobs, 'get');
      const opened = await mediaStore.open(`blobref:main:${expectedSha}`);
      expect(opened).toBeDefined();
      expect(opened!.size).toBe(mp4.byteLength);
      expect(opened!.mediaType).toBe('video/mp4');
      expect(getSpy).not.toHaveBeenCalled();

      const sliceChunks: Buffer[] = [];
      for await (const chunk of opened!.stream({ start: 1024, end: 131_071 })) {
        expect(chunk.byteLength).toBeLessThanOrEqual(64 * 1024);
        sliceChunks.push(Buffer.from(chunk));
      }
      expect(getSpy).not.toHaveBeenCalled();
      expect(Buffer.concat(sliceChunks)).toEqual(mp4.subarray(1024, 131_072));

      const matPath = await mediaStore.materialize({
        fileId: 'f_pub_1',
        name: 'clip.mp4',
        mimeType: 'video/mp4',
        size: mp4.byteLength,
        data: mp4,
        stream: () => Readable.from(mp4),
      });
      expect(matPath).toBeDefined();
      const attachDir = join(homeDir, sessionScope, 'attachments');
      await mkdir(attachDir, { recursive: true });
      const linkedPath = await mediaStore.linkAttachmentAlias('f_pub_1', attachDir, 'f_pub_1-clip.mp4');
      expect(linkedPath).toBe(join(attachDir, 'f_pub_1-clip.mp4'));
      const casIno = (await stat(cas.objectPath(expectedSha)!, { bigint: true })).ino;
      const mediaKey = (await storage.list(`${sessionScope}/media`, 'f_pub_1'))[0]!;
      const mediaIno = (await stat(storage.pathFor(`${sessionScope}/media`, mediaKey)!, { bigint: true })).ino;
      const attachIno = (await stat(linkedPath!, { bigint: true })).ino;
      expect(mediaIno).toBe(casIno);
      expect(attachIno).toBe(casIno);
    } finally {
      await storage.close();
    }
  });

  it('enforces HostPinnedRef fail-closed integrity, middle-byte tamper with restored mtime, and write-deny handle on Windows', async () => {
    const prevHelperEnv = process.env['KIKI_WINDOWS_PROCESS_HELPER'];
    delete process.env['KIKI_WINDOWS_PROCESS_HELPER'];
    const homeDir = await makeTempDir('kiki-hp-home-');
    const wsDir = await makeTempDir('kiki-hp-ws-');
    const storage = new FileStorageService(homeDir);
    const docs = new JsonAtomicDocumentStore(storage);

    try {
      const smallPath = join(wsDir, 'small.mp4');
      await writeFile(smallPath, makeFakeMp4(256 * 1024));
      const smallErr = await registerHostPinnedRef(docs, {
        sessionScope: 'sessions/wd_test/session_hp',
        sessionId: 'session_hp',
        path: smallPath,
        mimeType: 'video/mp4',
        allowedRoots: [wsDir],
      }).catch((error: unknown) => error);
      expect(smallErr, String(smallErr)).toBeInstanceOf(HostPinnedUnsupportedError);

      const largeMp4 = makeFakeMp4(HOST_PINNED_MIN_BYTES + 128 * 1024);
      const largePath = join(wsDir, 'large.mp4');
      await writeFile(largePath, largeMp4);

      if (!isHostPinnedSupported()) {
        await expect(registerHostPinnedRef(docs, {
          sessionScope: 'sessions/wd_test/session_hp',
          sessionId: 'session_hp',
          path: largePath,
          mimeType: 'video/mp4',
          allowedRoots: [wsDir],
        })).rejects.toBeInstanceOf(HostPinnedUnsupportedError);
        return;
      }

      const record = await registerHostPinnedRef(docs, {
        sessionScope: 'sessions/wd_test/session_hp',
        sessionId: 'session_hp',
        path: largePath,
        mimeType: 'video/mp4',
        allowedRoots: [wsDir],
      });
      expect(`${HOSTREF_PROTOCOL}${record.refId}`).toMatch(/^hostref:hp_[0-9a-f]{32}$/u);
      const manifestPath = storage.pathFor(`sessions/wd_test/session_hp/${HOST_PINNED_SUBSCOPE}`, `${record.refId}.json`)!;
      expect((await stat(manifestPath)).size).toBeLessThan(4096);

      const loaded = await readHostPinnedRefRecord(docs, 'sessions/wd_test/session_hp', 'session_hp', record.refId);
      expect(loaded?.sha256).toBe(record.sha256);
      expect(await readHostPinnedRefRecord(docs, 'sessions/wd_test/session_hp', 'other_session', record.refId)).toBeUndefined();

      await verifyHostPinnedRef(record);

      const openedRange = await openVerifiedHostPinnedStream(record, { range: { start: 4096, end: 4096 + 65536 - 1 } });
      const rangeChunks: Buffer[] = [];
      for await (const chunk of openedRange.stream) {
        rangeChunks.push(Buffer.from(chunk));
      }
      openedRange.close();
      expect(Buffer.concat(rangeChunks)).toEqual(largeMp4.subarray(4096, 4096 + 65536));

      const openedFull = await openVerifiedHostPinnedStream(record);
      let concurrentWriteBlocked = false;
      try {
        const w = await fsOpen(largePath, 'r+');
        await w.close();
      } catch {
        concurrentWriteBlocked = true;
      }
      const fullChunks: Buffer[] = [];
      for await (const chunk of openedFull.stream) {
        fullChunks.push(Buffer.from(chunk));
      }
      openedFull.close();
      expect(concurrentWriteBlocked).toBe(true);
      expect(Buffer.concat(fullChunks)).toEqual(largeMp4);

      const beforeStat = await stat(largePath);
      const fh = await fsOpen(largePath, 'r+');
      const midOffset = Math.floor(largeMp4.byteLength / 2);
      const flipped = Buffer.from([largeMp4[midOffset]! ^ 0xff]);
      await fh.write(flipped, 0, 1, midOffset);
      await fh.close();
      await utimes(largePath, beforeStat.atime, beforeStat.mtime);

      await expect(verifyHostPinnedRef(record)).rejects.toBeInstanceOf(HostPinnedSourceChangedError);
      await expect(openVerifiedHostPinnedStream(record, { range: { start: 0, end: 1023 } })).rejects.toBeInstanceOf(
        HostPinnedSourceChangedError,
      );

      await rm(largePath);
      await expect(verifyHostPinnedRef(record)).rejects.toBeInstanceOf(HostPinnedSourceChangedError);
    } finally {
      if (prevHelperEnv === undefined) delete process.env['KIKI_WINDOWS_PROCESS_HELPER'];
      else process.env['KIKI_WINDOWS_PROCESS_HELPER'] = prevHelperEnv;
      await storage.close();
    }
  }, 60_000);

  it('slims cold leaf replay-checkpoints losslessly with transparent readers, rehydration, and storage governance CLI operations', async () => {
    const homeDir = await makeTempDir('kiki-gov-home-');
    const storage = new FileStorageService(homeDir);
    const docs = new JsonAtomicDocumentStore(storage);

    try {
      const workspaceDir = join(homeDir, 'workspaces', 'user-project');
      await mkdir(workspaceDir, { recursive: true });
      const userFile = join(workspaceDir, 'keep-me.txt');
      await writeFile(userFile, 'do not touch user workspace');

      const sessionScope = 'sessions/wd_gov/session_cold';
      const childScope = `${sessionScope}/agents/leaf-1`;
      const childDir = join(homeDir, childScope);
      await mkdir(join(childDir, 'replay-checkpoints'), { recursive: true });

      const wireBytes = Buffer.from(`${JSON.stringify({ type: 'metadata', time: 1 })}\n`);
      await storage.write(childScope, AGENT_WIRE_RECORD_KEY, wireBytes);
      await storage.write(childScope, `${AGENT_WIRE_RECORD_KEY}.generation`, Buffer.from('gen-1'));
      const wireStat = await stat(join(childDir, AGENT_WIRE_RECORD_KEY));
      const headHash = createHash('sha256').update(wireBytes).digest('hex').slice(0, 32);
      const prefixSha256 = createHash('sha256').update(wireBytes).digest('hex');

      const largeContext = {
        messages: Array.from({ length: 120 }, (_, i) => ({
          role: 'assistant',
          content: [{ type: 'text', text: `repeated large history payload block ${i} ${'x'.repeat(2048)}` }],
        })),
      };
      const graph = encodeReplayCheckpointGraph({
        states: [
          { name: 'profile.current', value: { profileName: 'research', model: 'stub' }, meta: { nextPatch: 1 } },
          { name: 'profile.activeTools', value: ['Read', 'Grep'], meta: { nextPatch: 1 } },
          { name: 'turn.state', value: { count: 4 }, meta: { nextPatch: 1 } },
          { name: 'context.memory', value: largeContext, meta: { nextPatch: 120 } },
        ],
      });
      const envelope = {
        format: 1 as const,
        replayAbi: REPLAY_ABI_VERSION,
        wire: {
          size: wireBytes.byteLength,
          mtimeMs: wireStat.mtimeMs,
          headHash,
          prefixSha256,
          storeGeneration: 'gen-1',
        },
        stateNames: ['profile.current', 'profile.activeTools', 'turn.state', 'context.memory'],
        graph,
      };
      const primaryPath = join(childDir, 'replay-checkpoints', 'engine-v1');
      const originalRaw = Buffer.from(JSON.stringify(envelope), 'utf8');
      const originalSha = createHash('sha256').update(originalRaw).digest('hex');
      await writeFile(primaryPath, originalRaw);

      await docs.set(sessionScope, 'state.json', {
        id: 'session_cold',
        workspaceId: 'wd_gov',
        archived: false,
        private: false,
        createdAt: 1,
        updatedAt: 2,
        agents: {
          main: { type: 'main' },
          'leaf-1': {
            type: 'sub',
            status: 'completed',
            taskId: 'task-leaf-1',
            delegator: { kind: 'agent', agentId: 'main' },
          },
        },
      });

      const slimmed = await slimColdReplayCheckpoint(childDir, LIGHTWEIGHT_STATE_NAMES, REPLAY_ABI_VERSION);
      expect(slimmed.status).toBe('slimmed');
      expect(slimmed.reclaimedBytes).toBeGreaterThan(0);
      const ckptFiles = await readdir(join(childDir, 'replay-checkpoints'));
      expect(ckptFiles).toContain(COLD_CHECKPOINT_PROJECTION_KEY);
      expect(ckptFiles).toContain(COLD_CHECKPOINT_ARCHIVE_ZST_KEY);
      expect(ckptFiles).not.toContain('engine-v1');

      const projected = await readPersistedAgentCheckpoint(
        docs,
        storage,
        childScope,
        wireBytes.byteLength,
        wireStat.mtimeMs,
        new Set(['profile.current', 'profile.activeTools', 'turn.state']),
      );
      expect(projected).toBeDefined();
      expect(projected!.states.get('profile.activeTools')).toEqual(['Read', 'Grep']);

      const fullRestored = await readArchivedReplayCheckpointEnvelope(
        storage,
        `${childScope}/replay-checkpoints`,
        REPLAY_ABI_VERSION,
      );
      expect(fullRestored).toBeDefined();
      expect(fullRestored!.stateNames).toContain('context.memory');

      const rehydrated = await rehydrateColdReplayCheckpoint(childDir, REPLAY_ABI_VERSION);
      expect(rehydrated.restored).toBe(true);
      const restoredRaw = await readFile(primaryPath);
      expect(createHash('sha256').update(restoredRaw).digest('hex')).toBe(originalSha);

      const legacyBytes = Buffer.alloc(64 * 1024, 0x33);
      const legacySha = createHash('sha256').update(legacyBytes).digest('hex');
      await mkdir(join(childDir, 'blobs'), { recursive: true });
      await writeFile(join(childDir, 'blobs', legacySha), legacyBytes);
      await mkdir(join(homeDir, sessionScope, 'agents', 'main', 'blobs'), { recursive: true });
      await writeFile(join(homeDir, sessionScope, 'agents', 'main', 'blobs', legacySha), legacyBytes);

      const retiredDir = join(homeDir, 'search-index');
      await mkdir(retiredDir, { recursive: true });
      await writeFile(join(retiredDir, 'old.bin'), Buffer.alloc(4096, 0x11));
      await mkdir(join(homeDir, 'search-index-v2'), { recursive: true });
      const sqliteHeader = Buffer.alloc(4096);
      Buffer.from('SQLite format 3\0', 'ascii').copy(sqliteHeader, 0);
      await writeFile(join(homeDir, 'search-index-v2', 'index.sqlite'), sqliteHeader);

      const governance = new StorageGovernanceService(homeDir);
      const status = await governance.status();
      expect(status.workspaces.totalFiles).toBe(1);
      expect(status.workspaces.excludedFromCleanup).toBe(true);
      expect(status.retired.find((r) => r.relativePath === 'search-index')?.exists).toBe(true);
      expect(status.retired.find((r) => r.relativePath === 'search-index')?.successorReady).toBe(true);

      const dryDedup = await governance.deduplicate({ apply: false });
      expect(dryDedup.applied).toBe(false);
      expect(dryDedup.reclaimableBytes).toBeGreaterThanOrEqual(legacyBytes.byteLength);

      const appliedDedup = await governance.deduplicate({ apply: true });
      expect(appliedDedup.applied).toBe(true);
      expect(appliedDedup.reclaimedBytes).toBeGreaterThanOrEqual(legacyBytes.byteLength);
      const inoA = (await stat(join(childDir, 'blobs', legacySha), { bigint: true })).ino;
      const inoB = (await stat(join(homeDir, sessionScope, 'agents', 'main', 'blobs', legacySha), { bigint: true })).ino;
      expect(inoA).toBe(inoB);

      const dryClean = await governance.cleanRetired({ apply: false });
      expect(dryClean.applied).toBe(false);
      expect(dryClean.items.find((c) => c.relativePath === 'search-index')?.status).toBe('planned');

      const appliedClean = await governance.cleanRetired({ apply: true });
      expect(appliedClean.applied).toBe(true);
      expect(appliedClean.runId).toBeDefined();
      expect(await stat(retiredDir).catch(() => undefined)).toBeUndefined();
      expect(await readFile(userFile, 'utf8')).toBe('do not touch user workspace');

      const rolledBack = await governance.cleanRetired({ rollbackRunId: appliedClean.runId });
      expect(rolledBack.restoredBytes).toBe(4096);
      expect((await stat(join(retiredDir, 'old.bin'))).size).toBe(4096);

      const slimDry = await governance.slimCheckpoints({ apply: false, minAgeDays: 0 });
      expect(slimDry.applied).toBe(false);
      expect(slimDry.eligibleCount).toBe(1);

      const slimApply = await governance.slimCheckpoints({ apply: true, minAgeDays: 0 });
      expect(slimApply.applied).toBe(true);
      expect(slimApply.slimmedCount).toBe(1);
      expect(await readFile(userFile, 'utf8')).toBe('do not touch user workspace');
    } finally {
      await storage.close();
    }
  }, 30_000);
});
