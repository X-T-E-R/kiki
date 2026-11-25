import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  access,
  constants,
  mkdir,
  mkdtemp,
  open as fsOpen,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

import { AgentBlobServiceImpl } from '../../../packages/agent-core-v2/src/agent/blob/agentBlobServiceImpl.ts';
import {
  HOST_PINNED_SUBSCOPE,
  HOSTREF_PROTOCOL,
  isHostPinnedSupported,
  openVerifiedHostPinnedStream,
  registerHostPinnedRef,
} from '../../../packages/agent-core-v2/src/agent/media/hostPinnedMedia.ts';
import { SessionMediaStoreService } from '../../../packages/agent-core-v2/src/agent/media/sessionMediaStoreService.ts';
import { ReadMediaFileTool } from '../../../packages/agent-core-v2/src/agent/tools/read-media-file/readMediaFileTool.ts';
import { HostFileSystem } from '../../../packages/agent-core-v2/src/os/backends/node-local/hostFsService.ts';
import { FileServiceImpl } from '../../../packages/agent-core-v2/src/app/file/fileServiceImpl.ts';
import { PluginMediaService } from '../../../packages/agent-core-v2/src/app/pluginMedia/pluginMediaService.ts';
import { detachSessionSharedCasAliases, StorageGovernanceService } from '../../../packages/agent-core-v2/src/app/storageGovernance/storageGovernanceService.ts';
import { JsonAtomicDocumentStore } from '../../../packages/agent-core-v2/src/persistence/backends/node-fs/atomicDocumentStore.ts';
import { BlobStoreService } from '../../../packages/agent-core-v2/src/persistence/backends/node-fs/blobStoreService.ts';
import { ContentAddressedStoreService } from '../../../packages/agent-core-v2/src/persistence/backends/node-fs/contentAddressedStoreService.ts';
import { FileStorageService } from '../../../packages/agent-core-v2/src/persistence/backends/node-fs/fileStorageService.ts';
import { IAtomicDocumentStore } from '../../../packages/agent-core-v2/src/persistence/interface/atomicDocumentStore.ts';
import { IBootstrapService } from '../../../packages/agent-core-v2/src/app/bootstrap/bootstrap.ts';
import { IHostFileSystem } from '../../../packages/agent-core-v2/src/os/interface/hostFileSystem.ts';
import { ISessionIndex } from '../../../packages/agent-core-v2/src/app/sessionIndex/sessionIndex.ts';
import { ISessionManager } from '../../../packages/agent-core-v2/src/app/sessionManager/sessionManager.ts';
import { sessionScopeOf, workspacePersistenceScope } from '../../../packages/agent-core-v2/src/index.ts';
import { readPersistedAgentCheckpoint } from '../../../packages/agent-core-v2/src/session/persistedAgentCheckpoint.ts';
import {
  readArchivedReplayCheckpointEnvelope,
  rehydrateColdReplayCheckpoint,
} from '../../../packages/agent-core-v2/src/session/replayCheckpointArchive.ts';
import { REPLAY_ABI_VERSION } from '../../../packages/agent-core-v2/src/state/eventDispatcherService.ts';
import { encodeReplayCheckpointGraph } from '../../../packages/agent-core-v2/src/state/replayCheckpointCodec.ts';
import { AGENT_WIRE_RECORD_KEY } from '../../../packages/agent-core-v2/src/wire/record.ts';
import { resolvePromptMediaFiles } from '../../../packages/kap-server/src/lib/promptMedia.ts';
import { createAuthHook } from '../../../packages/kap-server/src/middleware/auth.ts';
import { registerHostMediaPreviewRoutes } from '../../../packages/kap-server/src/routes/hostMediaPreview.ts';

const kapServerRequire = createRequire(new URL('../../../packages/kap-server/package.json', import.meta.url));
const Fastify = kapServerRequire('fastify');

const MiB = 1024 * 1024;
const KiB = 1024;
const OWNER_HEADERS = { authorization: 'Bearer s21-owner-token' };

function assert(condition, message) {
  if (!condition) throw new Error(`S21 assertion failed: ${message}`);
}

function makeDeterministicMp4(totalBytes, seed = 1) {
  const ftyp = Buffer.from([
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d,
    0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d,
    0x6d, 0x70, 0x34, 0x31,
  ]);
  const moov = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x6d, 0x6f, 0x6f, 0x76]);
  const mdatSize = Math.max(16, totalBytes - ftyp.byteLength - moov.byteLength);
  const out = Buffer.alloc(ftyp.byteLength + moov.byteLength + mdatSize);
  ftyp.copy(out, 0);
  moov.copy(out, ftyp.byteLength);
  out.writeUInt32BE(mdatSize, ftyp.byteLength + moov.byteLength);
  out.write('mdat', ftyp.byteLength + moov.byteLength + 4, 'ascii');
  for (let i = ftyp.byteLength + moov.byteLength + 8; i < out.byteLength; i += 4096) {
    out[i] = ((i >>> 12) + seed * 37) & 0xff;
    if (i + 1 < out.byteLength) out[i + 1] = seed & 0xff;
  }
  return out;
}

function makeSolidPng(width, height) {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const chunk = (type, data) => {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.byteLength, 0);
    let crc = 0xffffffff;
    for (const b of typeBuf) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    for (const b of data) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rowSize = 1 + width * 3;
  const raw = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowSize;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const idx = rowStart + 1 + x * 3;
      raw[idx] = (x + y) & 0xff;
      raw[idx + 1] = (x * 2) & 0xff;
      raw[idx + 2] = (y * 2) & 0xff;
    }
  }
  const idat = deflateSync(raw, { level: 1 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function makeSessionCtx(sessionScope, sessionId, { isPrivate, ephemeral }) {
  return {
    _serviceBrand: undefined,
    sessionId,
    workspaceId: 'wd_s21',
    ephemeral,
    sessionDir: sessionScope,
    scope: (sub) => (sub === undefined ? sessionScope : `${sessionScope}/${sub}`),
    isPrivate: () => isPrivate,
  };
}

function makeAgentScope(sessionScope, agentId) {
  const base = `${sessionScope}/agents/${agentId}`;
  return {
    _serviceBrand: undefined,
    agentId,
    scope: (sub) => (sub === undefined ? base : `${base}/${sub}`),
  };
}

async function listRegularFilesRecursive(rootDir) {
  const results = [];
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const info = await stat(full, { bigint: true });
        results.push({
          path: full,
          size: Number(info.size),
          inodeKey: `${info.dev.toString(16)}:${info.ino.toString(16)}`,
          nlink: Number(info.nlink),
        });
      }
    }
  };
  await walk(rootDir);
  return results;
}

function createRssTracker() {
  const baselineRss = process.memoryUsage().rss;
  let peakRss = baselineRss;
  const sample = () => {
    const cur = process.memoryUsage().rss;
    if (cur > peakRss) peakRss = cur;
    return cur;
  };
  const timer = setInterval(sample, 10);
  timer.unref();
  return {
    sample,
    stop() {
      clearInterval(timer);
      sample();
      return {
        baselineRssBytes: baselineRss,
        peakRssBytes: peakRss,
        peakDeltaBytes: Math.max(0, peakRss - baselineRss),
        peakDeltaMiB: Number((Math.max(0, peakRss - baselineRss) / MiB).toFixed(2)),
      };
    },
  };
}

/**
 * Executes standalone backend S21 Storage Zero-Copy, CAS, HostPinnedRef, Streaming,
 * Upload Dedup, Plugin Media Lifecycle, and Governance Gate inside an isolated sandbox.
 */
export async function runScenarioS21StorageZeroCopy(options = {}) {
  const tier = options.tier === 'smoke' ? 'smoke' : 'full';
  const progress = typeof options.progress === 'function' ? options.progress : () => {};
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const prevHelperEnv = process.env['KIKI_WINDOWS_PROCESS_HELPER'];
  const worktreeHelper = join(repoRoot, 'packages/agent-core-v2/dist/windows-process-helper.exe');
  if (process.platform === 'win32') {
    process.env['KIKI_WINDOWS_PROCESS_HELPER'] = worktreeHelper;
  }

  const sandboxBase = options.dir ? resolve(options.dir) : await mkdtemp(join(tmpdir(), 'kiki-s21-sandbox-'));
  if (options.dir) {
    await rm(sandboxBase, { recursive: true, force: true }).catch(() => undefined);
  }
  await mkdir(sandboxBase, { recursive: true });
  const homeDir = join(sandboxBase, 'home');
  const sameVolWs = join(sandboxBase, 'ws-same-vol');
  await mkdir(homeDir, { recursive: true });
  await mkdir(sameVolWs, { recursive: true });

  let crossVolWs = options.crossVolumeDir ? resolve(options.crossVolumeDir) : undefined;
  let createdCrossVol = false;
  if (crossVolWs === undefined && process.platform === 'win32') {
    const homeDrive = homeDir.slice(0, 2).toLowerCase();
    const tmpDrive = tmpdir().slice(0, 2).toLowerCase();
    if (tmpDrive !== homeDrive) {
      crossVolWs = await mkdtemp(join(tmpdir(), 'kiki-s21-crossvol-'));
      createdCrossVol = true;
    }
  } else if (crossVolWs !== undefined) {
    await mkdir(crossVolWs, { recursive: true });
  }

  const storage = new FileStorageService(homeDir);
  const blobs = new BlobStoreService(storage);
  const docs = new JsonAtomicDocumentStore(storage);
  const cas = new ContentAddressedStoreService(storage);
  const noopLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const fileService = new FileServiceImpl(blobs, noopLog, { current: cas });

  const mp4SizeBytes = tier === 'full' ? 50 * MiB : 6 * MiB;
  const uploadSizeBytes = tier === 'full' ? 10 * MiB : 2 * MiB;

  const metrics = {
    scenario: 'S21_storage_zero_copy',
    tier,
    platform: process.platform,
    sandboxBase,
    sameVolumeRoot: sameVolWs,
    crossVolumeRoot: crossVolWs ?? null,
    checks: {},
    passed: false,
  };

  try {
    progress(`[S21] Generating ${mp4SizeBytes / MiB} MiB deterministic MP4 fixtures...`);
    const mp4Bytes = makeDeterministicMp4(mp4SizeBytes, 7);
    const mp4Sha = createHash('sha256').update(mp4Bytes).digest('hex');
    const sameVolMp4 = join(sameVolWs, 'master-50m.mp4');
    await writeFile(sameVolMp4, mp4Bytes);
    let crossVolMp4;
    if (crossVolWs !== undefined) {
      crossVolMp4 = join(crossVolWs, 'master-50m-crossvol.mp4');
      await writeFile(crossVolMp4, mp4Bytes);
    }

    progress('[S21-A1] Running 10 concurrent subagents archive-mode read (same-vol & cross-vol)...');
    const sessionPubId = 'session_s21_pub';
    const sessionPubScope = sessionScopeOf(workspacePersistenceScope('sessions', 'wd_s21'), sessionPubId);
    const pubCtx = makeSessionCtx(sessionPubScope, sessionPubId, { isPrivate: false, ephemeral: false });
    const srcStatBefore = await stat(sameVolMp4, { bigint: true });

    const hostFs = new HostFileSystem();
    const runtime = {
      identity: { workspaceId: 'wd_s21', runtimeId: 'local', generation: 's21' },
      capabilities: new Set(['fs']),
      environment: {
        platform: process.platform,
        homedir: homeDir,
        tmpdir: tmpdir(),
        env: {},
      },
      path: nodePath,
      workspace: { mapRoots: (roots) => roots },
      fs: hostFs,
      status: 'ready',
      onDidChangeStatus: () => ({ dispose: () => {} }),
      dispose: () => {},
    };
    const localRuntime = {
      onDidChange: () => ({ dispose: () => {} }),
      isAvailable: (required = []) => required.every((cap) => runtime.capabilities.has(cap)),
      inspect: () => runtime,
      acquire: () => ({ runtime, track: (resource) => resource, dispose: () => {} }),
      prepareFor: async () => runtime,
      acquireFor: () => ({ runtime, track: (resource) => resource, dispose: () => {} }),
    };
    const workspaceCfg = {
      workspaceDir: sameVolWs,
      additionalDirs: crossVolWs !== undefined ? [crossVolWs] : [],
    };
    let toolVideoUploaderCalls = 0;
    const stubVideoUploader = async () => {
      toolVideoUploaderCalls += 1;
      return { type: 'video_url', videoUrl: { url: 'ms://unexpected-bypass' } };
    };

    const archiveRss = createRssTracker();
    const archiveRefs = await Promise.all(
      Array.from({ length: 10 }, async (_, idx) => {
        const src = crossVolMp4 !== undefined && idx >= 5 ? crossVolMp4 : sameVolMp4;
        const blobSvc = new AgentBlobServiceImpl(
          blobs,
          makeAgentScope(sessionPubScope, `sub-${idx}`),
          { current: cas },
          { current: pubCtx },
          { current: docs },
        );
        const tool = new ReadMediaFileTool(
          localRuntime,
          workspaceCfg,
          {
            image_in: true,
            video_in: true,
            audio_in: true,
            thinking: false,
            tool_use: true,
            max_context_tokens: 0,
          },
          stubVideoUploader,
          undefined,
          false,
          undefined,
          undefined,
          undefined,
          undefined,
          blobSvc,
        );
        const execution = await tool.resolveExecution(
          idx % 2 === 0 ? { path: src } : { path: src, full_resolution: true },
        );
        const toolResult = 'execute' in execution
          ? await execution.execute({
              turnId: 1,
              toolCallId: `call_${idx}`,
              signal: new AbortController().signal,
            })
          : execution;
        assert(toolResult.isError !== true, `ReadMediaFileTool failed for child-${idx}: ${JSON.stringify(toolResult.output)}`);
        assert(Array.isArray(toolResult.output), `expected ContentPart[] output for child-${idx}`);
        const videoPart = toolResult.output.find((p) => p.type === 'video_url');
        assert(videoPart !== undefined, `missing video_url part for child-${idx}`);
        const toolResultEvent = JSON.stringify({
          type: 'tool.result',
          toolCallId: `call_${idx}`,
          result: { output: toolResult.output, isError: false },
        });
        assert(!toolResultEvent.includes('data:'), `tool.result leaked inline base64 for child-${idx}`);
        assert(Buffer.byteLength(toolResultEvent, 'utf8') < 8 * KiB, `tool.result exceeded 8 KiB: ${toolResultEvent.length}`);
        return { url: videoPart.videoUrl.url, eventBytes: Buffer.byteLength(toolResultEvent, 'utf8') };
      }),
    );
    const archiveRssReport = archiveRss.stop();
    assert(toolVideoUploaderCalls === 0, `ReadMediaFileTool bypassed CAS offloadFile into videoUploader (${toolVideoUploaderCalls} calls)`);

    const casObjPath = cas.objectPath(mp4Sha);
    assert(casObjPath !== undefined, 'CAS object path missing');
    const casStat = await stat(casObjPath, { bigint: true });
    const srcStatAfter = await stat(sameVolMp4, { bigint: true });
    assert(srcStatAfter.ino === srcStatBefore.ino, 'source inode changed');
    assert(casStat.ino !== srcStatAfter.ino, 'NTFS hard-link violation: source file was hard-linked into CAS');
    await access(sameVolMp4, constants.W_OK);

    const aliasInodes = new Set([`${casStat.dev.toString(16)}:${casStat.ino.toString(16)}`]);
    for (let i = 0; i < 10; i += 1) {
      assert(archiveRefs[i].url === `blobref:video/mp4;${mp4Sha}`, `unexpected blobref for sub-${i}`);
      const aliasPath = storage.pathFor(`${sessionPubScope}/agents/sub-${i}/blobs`, mp4Sha);
      const aliasStat = await stat(aliasPath, { bigint: true });
      aliasInodes.add(`${aliasStat.dev.toString(16)}:${aliasStat.ino.toString(16)}`);
    }
    const casFilesAfterArchive = await listRegularFilesRecursive(join(homeDir, 'blobs', 'v2'));
    assert(casFilesAfterArchive.length === 1, `expected 1 CAS object, got ${casFilesAfterArchive.length}`);
    assert(aliasInodes.size === 1, `expected 1 shared physical inode across CAS + 10 subagents, got ${aliasInodes.size}`);
    assert(archiveRssReport.peakDeltaBytes < 32 * MiB, `10-subagent archive RSS delta ${archiveRssReport.peakDeltaMiB} MiB >= 32 MiB`);

    metrics.checks.archive10Subagents = {
      passed: true,
      mp4Bytes: mp4SizeBytes,
      casPhysicalObjects: casFilesAfterArchive.length,
      distinctPhysicalInodes: aliasInodes.size,
      casNlink: Number(casStat.nlink),
      sourceWritablePreserved: true,
      sourceIsolatedFromCas: true,
      crossVolumeVerified: crossVolMp4 !== undefined,
      maxToolResultEventBytes: Math.max(...archiveRefs.map((r) => r.eventBytes)),
      rss: archiveRssReport,
    };

    progress('[S21-A2] Running HostPinnedRef zero-copy + tamper + write-deny lock verification...');
    const hostPinnedSupported = isHostPinnedSupported();
    if (hostPinnedSupported) {
      const pinnedTargets = crossVolMp4 !== undefined ? [sameVolMp4, crossVolMp4] : [sameVolMp4];
      const hostPinnedResults = [];

      const services = new Map([
        [IHostFileSystem, {}],
        [IAtomicDocumentStore, docs],
        [IBootstrapService, { scope: (name) => name }],
        [ISessionManager, { get: () => undefined }],
        [ISessionIndex, { get: async (id) => (id === sessionPubId ? { id: sessionPubId, workspaceId: 'wd_s21' } : undefined) }],
      ]);
      const core = { accessor: { get: (token) => services.get(token) } };
      const app = Fastify();
      app.setValidatorCompiler(() => () => true);
      app.setSerializerCompiler(() => (data) => JSON.stringify(data));
      app.addHook('onRequest', createAuthHook({ isValid: async (token) => token === 's21-owner-token' }));
      registerHostMediaPreviewRoutes(app, core, undefined, true);

      try {
        const rejectHostRef = await app.inject({
          method: 'POST',
          url: `/api/sessions/${sessionPubId}/media-playback`,
          headers: OWNER_HEADERS,
          payload: { file_id: `hostref:hp_${'0'.repeat(32)}` },
        });
        assert(rejectHostRef.statusCode === 404, `canonical playback must reject hostref:, got ${rejectHostRef.statusCode}`);
        const rejectSha = await app.inject({
          method: 'POST',
          url: `/api/sessions/${sessionPubId}/media-playback`,
          headers: OWNER_HEADERS,
          payload: { file_id: mp4Sha },
        });
        assert(rejectSha.statusCode === 404, `canonical playback must reject bare sha256, got ${rejectSha.statusCode}`);

        for (const targetPath of pinnedTargets) {
          const targetCopy = `${targetPath}.pinned-${randomUUID().slice(0, 8)}.mp4`;
          await writeFile(targetCopy, mp4Bytes);
          const beforeBlobs = await listRegularFilesRecursive(join(homeDir, 'blobs', 'v2'));
          const record = await registerHostPinnedRef(docs, {
            sessionScope: sessionPubScope,
            sessionId: sessionPubId,
            path: targetCopy,
            mimeType: 'video/mp4',
            allowedRoots: [dirname(targetCopy)],
          });
          const afterBlobs = await listRegularFilesRecursive(join(homeDir, 'blobs', 'v2'));
          assert(afterBlobs.length === beforeBlobs.length, 'HostPinnedRef must add 0 CAS media files');
          const manifestPath = storage.pathFor(`${sessionPubScope}/${HOST_PINNED_SUBSCOPE}`, `${record.refId}.json`);
          const manifestBytes = (await stat(manifestPath)).size;
          assert(manifestBytes < 4 * KiB, `HostPinnedRef manifest ${manifestBytes} >= 4 KiB`);

          const mintRes = await app.inject({
            method: 'POST',
            url: `/api/sessions/${sessionPubId}/host-pinned-playback`,
            headers: OWNER_HEADERS,
            payload: { ref_id: `${HOSTREF_PROTOCOL}${record.refId}` },
          });
          assert(mintRes.statusCode === 200, `host-pinned mint failed: ${mintRes.statusCode}`);
          const previewUrl = mintRes.json().data.url;

          const rangeRes = await app.inject({
            method: 'GET',
            url: previewUrl,
            headers: { range: 'bytes=0-65535' },
          });
          assert(rangeRes.statusCode === 206, `host-pinned range expected 206, got ${rangeRes.statusCode}`);
          assert(rangeRes.headers['cache-control'] === 'private, no-store', 'missing private, no-store');
          assert(rangeRes.rawPayload.equals(mp4Bytes.subarray(0, 65536)), 'host-pinned range payload mismatch');

          const openedLock = await openVerifiedHostPinnedStream(record);
          let concurrentWriteBlocked = false;
          try {
            const w = await fsOpen(targetCopy, 'r+');
            await w.close();
          } catch {
            concurrentWriteBlocked = true;
          }
          let streamedBytes = 0;
          for await (const chunk of openedLock.stream) streamedBytes += chunk.byteLength;
          openedLock.close();
          assert(concurrentWriteBlocked === true, 'concurrent write was NOT blocked during active write-deny stream');
          assert(streamedBytes === mp4Bytes.byteLength, 'full pinned stream byte count mismatch');

          const crossGuess = await app.inject({
            method: 'POST',
            url: '/api/sessions/session_other/host-pinned-playback',
            headers: OWNER_HEADERS,
            payload: { ref_id: record.refId },
          });
          assert(crossGuess.statusCode === 404, 'cross-session host-pinned guess must return 404');

          const origStat = await stat(targetCopy);
          const fh = await fsOpen(targetCopy, 'r+');
          const mid = Math.floor(mp4Bytes.byteLength / 2);
          await fh.write(Buffer.from([mp4Bytes[mid] ^ 0xff]), 0, 1, mid);
          await fh.close();
          await utimes(targetCopy, origStat.atime, origStat.mtime);

          const tamperedRes = await app.inject({
            method: 'GET',
            url: previewUrl,
            headers: { range: 'bytes=0-65535' },
          });
          assert(tamperedRes.statusCode === 404, `tampered host-pinned stream must return 404, got ${tamperedRes.statusCode}`);
          assert(tamperedRes.json().msg === 'media_source_changed_or_missing', 'unexpected tamper error message');

          await rm(targetCopy);
          const deletedRes = await app.inject({
            method: 'GET',
            url: previewUrl,
            headers: { range: 'bytes=0-65535' },
          });
          assert(deletedRes.statusCode === 404, `deleted host-pinned stream must return 404, got ${deletedRes.statusCode}`);
          assert(deletedRes.json().msg === 'media_source_changed_or_missing', 'unexpected delete error message');

          hostPinnedResults.push({
            crossVolume: targetPath === crossVolMp4,
            addedMediaBytes: 0,
            manifestBytes,
            verifiedIoBytesPerStream: openedLock.verifiedBytes,
            concurrentWriteBlocked,
            tamperMidByteRestoredMtimeRejected404: true,
            deletedRejected404: true,
          });
        }
      } finally {
        await app.close();
      }
      metrics.checks.hostPinnedRef = {
        passed: true,
        supported: true,
        targets: hostPinnedResults,
      };
    } else {
      let refused = false;
      try {
        await registerHostPinnedRef(docs, {
          sessionScope: sessionPubScope,
          sessionId: sessionPubId,
          path: sameVolMp4,
          mimeType: 'video/mp4',
          allowedRoots: [sameVolWs],
        });
      } catch {
        refused = true;
      }
      assert(refused, 'unsupported platform must refuse to mint HostPinnedRef');
      metrics.checks.hostPinnedRef = { passed: true, supported: false, refusedOnUnsupportedPlatform: true };
    }

    progress('[S21-B] Running 20 uploads (10 distinct contents) + compressed HD PNG + privacy isolation...');
    const uploadHome = join(sandboxBase, 'home-uploads');
    const upStorage = new FileStorageService(uploadHome);
    const upBlobs = new BlobStoreService(upStorage);
    const upDocs = new JsonAtomicDocumentStore(upStorage);
    const upCas = new ContentAddressedStoreService(upStorage);
    const upFiles = new FileServiceImpl(upBlobs, noopLog, { current: upCas });
    try {
      const pubScopeA = sessionScopeOf(workspacePersistenceScope('sessions', 'wd_up'), 'session_up_a');
      const pubScopeB = sessionScopeOf(workspacePersistenceScope('sessions', 'wd_up'), 'session_up_b');
      const privScope = sessionScopeOf(workspacePersistenceScope('sessions', 'wd_up'), 'session_up_priv');
      const ephScope = sessionScopeOf(workspacePersistenceScope('sessions', 'wd_up'), 'session_up_eph');

      const mediaA = new SessionMediaStoreService(
        makeSessionCtx(pubScopeA, 'session_up_a', { isPrivate: false, ephemeral: false }),
        upStorage, upDocs, upBlobs, { current: upCas },
      );
      const mediaB = new SessionMediaStoreService(
        makeSessionCtx(pubScopeB, 'session_up_b', { isPrivate: false, ephemeral: false }),
        upStorage, upDocs, upBlobs, { current: upCas },
      );
      const mediaPriv = new SessionMediaStoreService(
        makeSessionCtx(privScope, 'session_up_priv', { isPrivate: true, ephemeral: false }),
        upStorage, upDocs, upBlobs, { current: upCas },
      );
      const mediaEph = new SessionMediaStoreService(
        makeSessionCtx(ephScope, 'session_up_eph', { isPrivate: false, ephemeral: true }),
        upStorage, upDocs, upBlobs, { current: upCas },
      );

      const distinctPayloads = Array.from({ length: 10 }, (_, idx) => makeDeterministicMp4(uploadSizeBytes, 100 + idx));
      const allPublicInodes = new Set();
      for (let round = 0; round < 2; round += 1) {
        const targetMedia = round === 0 ? mediaA : mediaB;
        const targetScope = round === 0 ? pubScopeA : pubScopeB;
        const attachDir = join(uploadHome, targetScope, 'attachments');
        for (let idx = 0; idx < 10; idx += 1) {
          const payload = distinctPayloads[idx];
          const saved = await upFiles.save(Readable.from([payload]), `video-${idx}.mp4`, { mimeType: 'video/mp4', expiresInSec: 86_400 });
          await resolvePromptMediaFiles(
            [{ type: 'video', source: { kind: 'file', file_id: saved.id } }],
            upFiles,
            join(uploadHome, 'cache'),
            {
              sessionMedia: targetMedia,
              resolveAttachmentsDir: async () => attachDir,
              resolveOriginalsDir: async () => join(uploadHome, targetScope, 'media-originals'),
            },
          );
          const attachStat = await stat(join(attachDir, `${saved.id}-video-${idx}.mp4`), { bigint: true });
          allPublicInodes.add(`${attachStat.dev.toString(16)}:${attachStat.ino.toString(16)}`);
        }
      }
      const upCasFiles = await listRegularFilesRecursive(join(uploadHome, 'blobs', 'v2'));
      assert(upCasFiles.length === 10, `expected 10 physical CAS objects for 20 uploads of 10 contents, got ${upCasFiles.length}`);
      assert(allPublicInodes.size === 10, `expected 10 unique physical inodes across 20 attachments, got ${allPublicInodes.size}`);
      for (const f of upCasFiles) {
        assert(allPublicInodes.has(f.inodeKey), 'attachment inode did not match CAS inode');
      }

      const origDirA = await listRegularFilesRecursive(join(uploadHome, pubScopeA, 'media-originals'));
      const origDirB = await listRegularFilesRecursive(join(uploadHome, pubScopeB, 'media-originals'));
      assert(origDirA.length === 0 && origDirB.length === 0, 'media-originals/ must have 0 writes');

      const hdPng = makeSolidPng(2800, 1600);
      const hdSaved = await upFiles.save(Readable.from([hdPng]), 'hd-frame.png', { mimeType: 'image/png', expiresInSec: 86_400 });
      const hdAttachDir = join(uploadHome, pubScopeA, 'attachments');
      await resolvePromptMediaFiles(
        [{ type: 'image', source: { kind: 'file', file_id: hdSaved.id } }],
        upFiles,
        join(uploadHome, 'cache'),
        {
          sessionMedia: mediaA,
          resolveAttachmentsDir: async () => hdAttachDir,
          resolveOriginalsDir: async () => join(uploadHome, pubScopeA, 'media-originals'),
        },
      );
      const origDirAfterHd = await listRegularFilesRecursive(join(uploadHome, pubScopeA, 'media-originals'));
      assert(origDirAfterHd.length === 0, 'compressed HD PNG must NOT write to media-originals/');

      const casBeforePrivate = (await listRegularFilesRecursive(join(uploadHome, 'blobs', 'v2'))).length;
      const secretPayload = makeDeterministicMp4(256 * KiB, 999);
      const secretSha = createHash('sha256').update(secretPayload).digest('hex');
      for (const [m, sc] of [[mediaPriv, privScope], [mediaEph, ephScope]]) {
        const s = await upFiles.save(Readable.from([secretPayload]), 'secret.mp4', { mimeType: 'video/mp4', expiresInSec: 86_400 });
        await resolvePromptMediaFiles(
          [{ type: 'video', source: { kind: 'file', file_id: s.id } }],
          upFiles,
          join(uploadHome, 'cache'),
          {
            sessionMedia: m,
            resolveAttachmentsDir: async () => join(uploadHome, sc, 'attachments'),
          },
        );
      }
      assert(!(await upCas.has(secretSha)), 'private/ephemeral upload leaked into shared blobs/v2');
      const casAfterPrivate = (await listRegularFilesRecursive(join(uploadHome, 'blobs', 'v2'))).length;
      assert(casAfterPrivate === casBeforePrivate, 'private/ephemeral upload increased blobs/v2 object count');

      metrics.checks.upload20DedupAndPrivacy = {
        passed: true,
        uploadsCount: 20,
        distinctContents: 10,
        uploadSizeBytes,
        casObjectsFor20Uploads: upCasFiles.length,
        distinctAttachmentInodes: allPublicInodes.size,
        mediaOriginalsFilesWritten: 0,
        privateAndEphemeralIsolated: true,
      };
    } finally {
      await upFiles.dispose();
      await upStorage.close();
    }

    progress('[S21-C] Running canonical 64 KiB Range streaming & 10-concurrent Range RSS gate...');
    const mediaPub = new SessionMediaStoreService(pubCtx, storage, docs, blobs, { current: cas });
    let blobsGetCalls = 0;
    const origBlobsGet = blobs.get.bind(blobs);
    blobs.get = async (...args) => {
      blobsGetCalls += 1;
      return origBlobsGet(...args);
    };
    const rangeRss = createRssTracker();
    let maxChunkBytes = 0;
    let totalCanonicalRangeBytes = 0;
    await Promise.all(
      Array.from({ length: 10 }, async (_, idx) => {
        const opened = await mediaPub.open(`blobref:sub-${idx}:${mp4Sha}`);
        assert(opened !== undefined, `openAgentBlob missing for sub-${idx}`);
        const start = idx * 65536;
        const end = start + 65536 - 1;
        const parts = [];
        for await (const chunk of opened.stream({ start, end })) {
          if (chunk.byteLength > maxChunkBytes) maxChunkBytes = chunk.byteLength;
          totalCanonicalRangeBytes += chunk.byteLength;
          parts.push(Buffer.from(chunk));
        }
        assert(Buffer.concat(parts).equals(mp4Bytes.subarray(start, end + 1)), `range mismatch for sub-${idx}`);
      }),
    );
    const rangeRssReport = rangeRss.stop();
    blobs.get = origBlobsGet;
    assert(blobsGetCalls === 0, `openAgentBlob called blobs.get ${blobsGetCalls} times (expected 0)`);
    assert(maxChunkBytes <= 64 * KiB, `Range chunk ${maxChunkBytes} > 64 KiB`);
    assert(rangeRssReport.peakDeltaBytes < 32 * MiB, `10-concurrent Range RSS delta ${rangeRssReport.peakDeltaMiB} MiB >= 32 MiB`);

    metrics.checks.canonicalRangeStreaming = {
      passed: true,
      blobsGetCalls,
      maxChunkBytes,
      totalCanonicalIoBytes: totalCanonicalRangeBytes,
      rss: rangeRssReport,
    };

    progress('[S21-D] Running 50 plugin-media-v1 jobs + resumable stop/resume + 256 MiB inputs LRU...');
    const pmHome = join(sandboxBase, 'home-plugin-media');
    const pmStorage = new FileStorageService(pmHome);
    const pmDocs = new JsonAtomicDocumentStore(pmStorage);
    const pmCas = new ContentAddressedStoreService(pmStorage);
    try {
      const bootstrapStub = { cacheDir: join(pmHome, 'cache'), homeDir: pmHome, scope: (n) => n };
      const instantiationStub = {
        onWillDispose: () => ({ dispose: () => {} }),
        invokeFunction: () => { throw new Error('optional service absent'); },
      };
      const pmSvc = new PluginMediaService(
        bootstrapStub,
        { listMediaProviders: async () => [] },
        pmDocs,
        pmStorage,
        { get: () => ({}) },
        instantiationStub,
        { listPlugins: async () => [] },
        { forExecution: async () => ({}) },
        { current: pmCas },
      );
      await pmSvc.ready;
      const pmCacheRoot = join(pmHome, 'cache', 'plugin-media-v1');
      const pmStoreScope = 'store/plugin-media-v1';

      for (let i = 0; i < 50; i += 1) {
        const jobId = `media-term-${String(i).padStart(2, '0')}`;
        const jobDir = join(pmCacheRoot, jobId);
        await mkdir(jobDir, { recursive: true });
        await writeFile(join(jobDir, '.ready'), Buffer.alloc(0));
        await writeFile(join(jobDir, 'staging.tmp'), Buffer.alloc(64 * KiB, i & 0xff));
        const isFailed = i % 5 === 0;
        const storedRecord = {
          version: 1,
          pluginId: 'stub',
          providerId: 'provider',
          owner: { sessionId: 'session_pm', agentId: 'main' },
          input: { kind: 'image', prompt: 'test' },
          view: {
            schemaVersion: 1,
            job_id: jobId,
            request_id: `req-${i}`,
            owner_session_id: 'session_pm',
            owner_agent_id: 'main',
            provider: 'stub/provider',
            state: isFailed ? 'failed' : 'succeeded',
            phase: 'done',
            can_resume: false,
            artifacts: isFailed ? [] : [{ artifact_id: 'a1', kind: 'image', file_id: `f_${i}`, complete: true }],
            created_at: Date.now(),
            updated_at: Date.now(),
          },
        };
        await pmDocs.set(pmStoreScope, `${jobId}.json`, storedRecord);
        await pmSvc.maybeCleanupJobStaging(jobId);
      }

      const resumableId = 'media-resumable-01';
      const resumableDir = join(pmCacheRoot, resumableId);
      await mkdir(resumableDir, { recursive: true });
      await writeFile(join(resumableDir, '.ready'), Buffer.alloc(0));
      await writeFile(join(resumableDir, 'checkpoint.bin'), Buffer.alloc(32 * KiB, 0xaa));
      const resumableRecord = {
        version: 1,
        pluginId: 'stub',
        providerId: 'provider',
        owner: { sessionId: 'session_pm', agentId: 'main' },
        input: { kind: 'video', prompt: 'resume me' },
        view: {
          schemaVersion: 1,
          job_id: resumableId,
          request_id: 'req-resumable',
          owner_session_id: 'session_pm',
          owner_agent_id: 'main',
          provider: 'stub/provider',
          state: 'stopped',
          phase: 'poll',
          can_resume: true,
          artifacts: [],
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      };
      await pmDocs.set(pmStoreScope, `${resumableId}.json`, resumableRecord);
      await pmSvc.maybeCleanupJobStaging(resumableId);
      const preservedWhileResumable = (await stat(join(resumableDir, 'checkpoint.bin')).catch(() => undefined)) !== undefined;
      assert(preservedWhileResumable, 'resumable job staging was prematurely deleted');

      resumableRecord.view.state = 'succeeded';
      resumableRecord.view.can_resume = false;
      resumableRecord.view.artifacts = [{ artifact_id: 'v1', kind: 'video', file_id: 'f_resumed', complete: true }];
      await pmDocs.set(pmStoreScope, `${resumableId}.json`, resumableRecord);
      await pmSvc.maybeCleanupJobStaging(resumableId);
      const remainingStagingDirs = (await readdir(pmCacheRoot, { withFileTypes: true }).catch(() => []))
        .filter((e) => e.isDirectory() && e.name !== 'inputs');
      assert(remainingStagingDirs.length === 0, `expected 0 terminal staging dirs, got ${remainingStagingDirs.length}`);

      const inputsDir = join(pmCacheRoot, 'inputs');
      await mkdir(inputsDir, { recursive: true });
      const pinnedHash = 'a'.repeat(64);
      const pinnedDir = join(inputsDir, pinnedHash);
      await mkdir(pinnedDir, { recursive: true });
      const pinnedPath = join(pinnedDir, 'pinned.bin');
      await writeFile(pinnedPath, Buffer.alloc(4 * MiB, 0x77));
      const activeJobRec = {
        version: 1,
        pluginId: 'stub',
        providerId: 'provider',
        owner: { sessionId: 'session_pm', agentId: 'main' },
        input: { kind: 'image', prompt: 'active', images: [{ path: pinnedPath }] },
        view: {
          schemaVersion: 1,
          job_id: 'media-active-pin',
          request_id: 'req-pin',
          owner_session_id: 'session_pm',
          owner_agent_id: 'main',
          provider: 'stub/provider',
          state: 'running',
          phase: 'poll',
          can_resume: true,
          artifacts: [],
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      };
      await pmDocs.set(pmStoreScope, 'media-active-pin.json', activeJobRec);

      const inputChunk = Buffer.alloc(10 * MiB, 0x55);
      const baseTime = Date.now() - 60_000;
      for (let i = 0; i < 28; i += 1) {
        const hashDir = createHash('sha256').update(`input-${i}`).digest('hex');
        const dirPath = join(inputsDir, hashDir);
        await mkdir(dirPath, { recursive: true });
        const p = join(dirPath, 'payload.bin');
        await writeFile(p, inputChunk);
        const t = new Date(baseTime + i * 1000);
        await utimes(p, t, t);
        await utimes(dirPath, t, t);
      }
      const pinnedSet = await pmSvc.collectPinnedInputHashes();
      await pmSvc.sweepInputsCache(pinnedSet, 0);
      const remainingInputs = await listRegularFilesRecursive(inputsDir);
      const inputsTotalBytes = remainingInputs.reduce((acc, item) => acc + item.size, 0);
      assert(inputsTotalBytes <= 256 * MiB, `inputs/ LRU exceeded 256 MiB: ${(inputsTotalBytes / MiB).toFixed(2)} MiB`);
      assert(remainingInputs.length <= 512, `inputs/ LRU exceeded 512 items: ${remainingInputs.length}`);
      assert(remainingInputs.some((f) => f.path === pinnedPath), 'pinned active job input was evicted');

      await pmSvc.dispose();
      metrics.checks.pluginMediaLifecycle = {
        passed: true,
        terminalJobsProcessed: 50,
        terminalStagingDirsRemaining: remainingStagingDirs.length,
        resumableStagingPreservedUntilCompleted: preservedWhileResumable,
        inputsTotalBytes,
        inputsEntries: remainingInputs.length,
        pinnedInputPreserved: true,
      };
    } finally {
      await pmStorage.close();
    }

    progress('[S21-E] Running StorageGovernanceService (status, deduplicate, clean-retired+rollback, slim-checkpoints+rehydrate)...');
    const govHome = join(sandboxBase, 'home-governance');
    const govStorage = new FileStorageService(govHome);
    const govDocs = new JsonAtomicDocumentStore(govStorage);
    try {
      const wsDir = join(govHome, 'workspaces', 'user-repo');
      await mkdir(wsDir, { recursive: true });
      const wsFile = join(wsDir, 'important.txt');
      await writeFile(wsFile, 'user-workspace-must-never-be-touched');

      const coldSessionScope = 'sessions/wd_gov/session_cold_1';
      const privSessionScope = 'sessions/wd_gov/session_priv_1';
      const leafScope = `${coldSessionScope}/agents/leaf-sub`;
      const mainScope = `${coldSessionScope}/agents/main`;
      const privAgentScope = `${privSessionScope}/agents/main`;

      for (const sc of [leafScope, mainScope, privAgentScope]) {
        await mkdir(join(govHome, sc, 'blobs'), { recursive: true });
        await mkdir(join(govHome, sc, 'replay-checkpoints'), { recursive: true });
      }

      const legacyBytes = Buffer.alloc(128 * KiB, 0x2a);
      const legacyBase64Hash = createHash('sha256').update(legacyBytes.toString('base64')).digest('hex');
      await writeFile(join(govHome, leafScope, 'blobs', legacyBase64Hash), legacyBytes);
      await writeFile(join(govHome, mainScope, 'blobs', legacyBase64Hash), legacyBytes);
      await writeFile(join(govHome, privAgentScope, 'blobs', legacyBase64Hash), legacyBytes);

      const wireBytes = Buffer.from(`${JSON.stringify({ type: 'metadata', time: 1 })}\n`);
      await govStorage.write(leafScope, AGENT_WIRE_RECORD_KEY, wireBytes);
      await govStorage.write(leafScope, `${AGENT_WIRE_RECORD_KEY}.generation`, Buffer.from('gen-s21'));
      const wireStat = await stat(join(govHome, leafScope, AGENT_WIRE_RECORD_KEY));
      const graph = encodeReplayCheckpointGraph({
        states: [
          { name: 'profile.current', value: { profileName: 'research', model: 'stub' }, meta: { nextPatch: 1 } },
          { name: 'profile.activeTools', value: ['Read', 'Grep'], meta: { nextPatch: 1 } },
          { name: 'turn.state', value: { count: 3 }, meta: { nextPatch: 1 } },
          {
            name: 'context.memory',
            value: { messages: Array.from({ length: 120 }, (_, i) => ({ role: 'assistant', content: [{ type: 'text', text: `msg ${i} ${'a'.repeat(2048)}` }] })) },
            meta: { nextPatch: 120 },
          },
        ],
      });
      const ckptEnvelope = {
        format: 1,
        replayAbi: REPLAY_ABI_VERSION,
        wire: {
          size: wireBytes.byteLength,
          mtimeMs: wireStat.mtimeMs,
          headHash: createHash('sha256').update(wireBytes).digest('hex').slice(0, 32),
          prefixSha256: createHash('sha256').update(wireBytes).digest('hex'),
          storeGeneration: 'gen-s21',
        },
        stateNames: ['profile.current', 'profile.activeTools', 'turn.state', 'context.memory'],
        graph,
      };
      const primaryCkptPath = join(govHome, leafScope, 'replay-checkpoints', 'engine-v1');
      const origCkptBuf = Buffer.from(JSON.stringify(ckptEnvelope), 'utf8');
      const origCkptSha = createHash('sha256').update(origCkptBuf).digest('hex');
      await writeFile(primaryCkptPath, origCkptBuf);

      await govDocs.set(coldSessionScope, 'state.json', {
        id: 'session_cold_1',
        workspaceId: 'wd_gov',
        archived: false,
        private: false,
        createdAt: 1,
        updatedAt: 2,
        agents: {
          main: { type: 'main' },
          'leaf-sub': {
            type: 'sub',
            status: 'completed',
            taskId: 'task-leaf-s21',
            delegator: { kind: 'agent', agentId: 'main' },
          },
        },
      });
      await govDocs.set(privSessionScope, 'state.json', {
        id: 'session_priv_1',
        workspaceId: 'wd_gov',
        archived: false,
        private: true,
        createdAt: 1,
        updatedAt: 2,
        agents: { main: { type: 'main' } },
      });

      const retiredSearch = join(govHome, 'search-index');
      await mkdir(retiredSearch, { recursive: true });
      await writeFile(join(retiredSearch, 'legacy.idx'), Buffer.alloc(8192, 0x19));
      await mkdir(join(govHome, 'search-index-v2'), { recursive: true });
      const govSuccessorDb = new DatabaseSync(join(govHome, 'search-index-v2', 'index.sqlite'));
      govSuccessorDb.exec('CREATE TABLE docs (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO docs (body) VALUES (\'ok\');');
      govSuccessorDb.close();

      const governance = new StorageGovernanceService(govHome);
      const status = await governance.status();
      assert(status.workspaces.excludedFromCleanup === true && status.workspaces.totalFiles === 1, 'workspaces visibility failed');

      const dedupDry = await governance.deduplicate({ apply: false });
      assert(dedupDry.applied === false && dedupDry.reclaimableBytes >= legacyBytes.byteLength, 'deduplicate dry-run failed');
      const dedupApply = await governance.deduplicate({ apply: true });
      assert(dedupApply.applied === true && dedupApply.reclaimedBytes >= legacyBytes.byteLength, 'deduplicate apply failed');
      const inoLeaf = (await stat(join(govHome, leafScope, 'blobs', legacyBase64Hash), { bigint: true })).ino;
      const inoMain = (await stat(join(govHome, mainScope, 'blobs', legacyBase64Hash), { bigint: true })).ino;
      const inoPriv = (await stat(join(govHome, privAgentScope, 'blobs', legacyBase64Hash), { bigint: true })).ino;
      assert(inoLeaf === inoMain, 'public legacy blobs were not linked to same inode');
      assert(inoPriv !== inoLeaf, 'private legacy blob was wrongly deduplicated into shared CAS');

      const detachedAliases = await detachSessionSharedCasAliases(join(govHome, coldSessionScope));
      assert(detachedAliases >= 2, `expected >= 2 detached shared CAS aliases, got ${detachedAliases}`);
      assert((await stat(join(govHome, leafScope, 'blobs', legacyBase64Hash), { bigint: true })).nlink === 1n, 'detached alias still hard-linked');

      const cleanApply = await governance.cleanRetired({ apply: true });
      assert(cleanApply.applied === true && cleanApply.quarantinedBytes === 8192 && cleanApply.runId !== undefined, 'clean-retired apply failed');
      const rolledBack = await governance.cleanRetired({ rollbackRunId: cleanApply.runId, apply: true });
      assert(rolledBack.restoredBytes === 8192, 'clean-retired rollback failed');

      const slimApply = await governance.slimCheckpoints({ apply: true, minAgeDays: 0 });
      assert(slimApply.applied === true && slimApply.slimmedCount === 1 && slimApply.reclaimedBytes > 0, 'slim-checkpoints apply failed');

      const projected = await readPersistedAgentCheckpoint(
        govDocs,
        govStorage,
        leafScope,
        wireBytes.byteLength,
        wireStat.mtimeMs,
        new Set(['profile.current', 'profile.activeTools', 'turn.state']),
      );
      assert(projected !== undefined && Array.isArray(projected.states.get('profile.activeTools')), 'cold reader failed on slimmed checkpoint');

      const fullArchive = await readArchivedReplayCheckpointEnvelope(
        govStorage,
        `${leafScope}/replay-checkpoints`,
        REPLAY_ABI_VERSION,
      );
      assert(fullArchive !== undefined && fullArchive.stateNames.includes('context.memory'), 'archive reader failed');

      const rehydrated = await rehydrateColdReplayCheckpoint(join(govHome, leafScope), REPLAY_ABI_VERSION);
      assert(rehydrated.restored === true, 'rehydrate failed');
      const rehydratedSha = createHash('sha256').update(await readFile(primaryCkptPath)).digest('hex');
      assert(rehydratedSha === origCkptSha, 'rehydrated checkpoint SHA-256 mismatch');
      assert((await readFile(wsFile, 'utf8')) === 'user-workspace-must-never-be-touched', 'workspaces/ file was modified');

      metrics.checks.storageGovernance = {
        passed: true,
        deduplicatedBytes: dedupApply.reclaimedBytes,
        privateBlobExcluded: true,
        retiredQuarantinedAndRolledBackBytes: rolledBack.restoredBytes,
        checkpointSlimReclaimedBytes: slimApply.reclaimedBytes,
        checkpointRehydrateSha256Exact: true,
        workspacesUntouched: true,
      };
    } finally {
      await govStorage.close();
    }

    metrics.passed = true;
    progress('[S21] ALL S21 STORAGE ZERO-COPY GATES PASSED.');
    return metrics;
  } finally {
    await fileService.dispose().catch(() => undefined);
    await storage.close().catch(() => undefined);
    if (prevHelperEnv === undefined) delete process.env['KIKI_WINDOWS_PROCESS_HELPER'];
    else process.env['KIKI_WINDOWS_PROCESS_HELPER'] = prevHelperEnv;
    if (!options.keepSandbox && !options.dir) {
      await rm(sandboxBase, { recursive: true, force: true }).catch(() => undefined);
    }
    if (createdCrossVol && crossVolWs !== undefined) {
      await rm(crossVolWs, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function parseCliArgs(argv) {
  const opts = { tier: 'full', keepSandbox: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dir' && i + 1 < argv.length) opts.dir = argv[++i];
    else if (arg === '--cross-volume-dir' && i + 1 < argv.length) opts.crossVolumeDir = argv[++i];
    else if (arg === '--out' && i + 1 < argv.length) opts.out = argv[++i];
    else if (arg === '--tier' && i + 1 < argv.length) opts.tier = argv[++i];
    else if (arg === '--keep-sandbox') opts.keepSandbox = true;
  }
  return opts;
}

const isMain = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const cli = parseCliArgs(process.argv.slice(2));
  runScenarioS21StorageZeroCopy({
    ...cli,
    progress: (msg) => console.error(msg),
  })
    .then(async (result) => {
      const json = JSON.stringify(result, null, 2);
      if (cli.out) {
        await mkdir(dirname(resolve(cli.out)), { recursive: true });
        await writeFile(resolve(cli.out), json, 'utf8');
      }
      console.log(json);
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
