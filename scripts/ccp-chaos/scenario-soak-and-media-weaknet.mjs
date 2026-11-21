import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { deflateSync } from 'node:zlib';

import { computeChaosWorkDirKey } from './corpus-generator.mjs';
import { buildDecodableMp4 } from './fixtures/media.mjs';
import { assertKapServerWebAssets, createWebAssetsAuditRecorder, evaluateWebAssetsBudget } from './web-assets-bridge.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MiB = 1024 * 1024;
const BASE_TIME = 1_760_200_000_000;

export const FROZEN_S8_WEAKNET_BUDGETS = Object.freeze({
  coldOpenMs: 8_000,
  firstMessageVisibleMs: 8_000,
  longTaskMaxMs: 2_000,
  jsHeapUsedBytes: 512 * MiB,
  requestCountBeforeFirstMessage: 60,
  promptUnderMediaStormMs: 3_000,
  rpcUnderMediaStormMs: 2_000,
});

function roundMs(val) {
  return Number(Number(val ?? 0).toFixed(2));
}

function roundMiB(bytes) {
  return Number((Number(bytes ?? 0) / MiB).toFixed(2));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function quantile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return roundMs(sorted[idx]);
}

function summarize(samples) {
  if (samples.length === 0) return { count: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = [...samples].toSorted((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    min: roundMs(sorted[0]),
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: roundMs(sorted.at(-1)),
    mean: roundMs(sum / sorted.length),
  };
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

export function generateSyntheticPng(width, height, { deflateLevel = 1, smoothBands = false } = {}) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  if (smoothBands) {
    for (let y = 0; y < height; y += 1) {
      const rowStart = y * stride;
      raw[rowStart] = 0;
      const r = (y * 3) & 0xff;
      const g = ((y * 5) ^ 0x55) & 0xff;
      const b = (255 - (y & 0xff)) & 0xff;
      for (let x = 0; x < width; x += 1) {
        const off = rowStart + 1 + x * 3;
        raw[off] = (r + (x >> 3)) & 0xff;
        raw[off + 1] = g;
        raw[off + 2] = (b + (x & 0x1f)) & 0xff;
      }
    }
  } else {
    let state = 0x2468ace1;
    for (let y = 0; y < height; y += 1) {
      const rowStart = y * stride;
      raw[rowStart] = 0;
      for (let x = 0; x < width; x += 1) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const off = rowStart + 1 + x * 3;
        raw[off] = (state >>> 24) & 0xff;
        raw[off + 1] = (state >>> 16) & 0xff;
        raw[off + 2] = (state >>> 8) & 0xff;
      }
    }
  }
  const compressed = deflateSync(raw, { level: deflateLevel });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))]);
}

export function generateSyntheticMp4(totalBytes = 192 * 1024) {
  const base = buildDecodableMp4();
  const padBytes = Math.max(0, totalBytes - base.length);
  if (padBytes < 8) return base;
  const freeBox = Buffer.alloc(padBytes);
  freeBox.writeUInt32BE(padBytes, 0);
  freeBox.write('free', 4, 'ascii');
  return Buffer.concat([base, freeBox]);
}

export function generateSyntheticWav(totalBytes = 192 * 1024) {
  const dataLen = Math.max(64, totalBytes - 44);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLen, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(16000, 24); // sample rate
  header.writeUInt32LE(32000, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLen, 40);
  const pcm = Buffer.alloc(dataLen, 0x01);
  return Buffer.concat([header, pcm]);
}

function buildMultipartUpload(filename, mimeType, bytes, sessionId) {
  const boundary = `----kikiS8Upload${randomBytes(6).toString('hex')}`;
  const parts = [];
  if (sessionId) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="session_id"\r\n\r\n${sessionId}\r\n`, 'utf8'));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
      'utf8',
    ),
  );
  parts.push(bytes);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(parts) };
}

function linkOrCopy(src, dst) {
  try {
    fs.linkSync(src, dst);
    return 'hardlinked';
  } catch {
    fs.copyFileSync(src, dst);
    return 'copied';
  }
}

function writeMediaMeta(metaDir, fileId, ext, name, mediaType) {
  fs.writeFileSync(
    path.join(metaDir, `${fileId}.json`),
    JSON.stringify({ version: 1, key: `${fileId}${ext}`, name, mediaType }),
    'utf8',
  );
}

function ensureAnchorSession(homeDir, workspaceId, workspaceDir, sessionId = 'chaos_soak_anchor') {
  const dir = path.join(homeDir, 'sessions', workspaceId, sessionId);
  const wirePath = path.join(dir, 'agents', 'main', 'wire.jsonl');
  const statePath = path.join(dir, 'state.json');
  if (fs.existsSync(wirePath) && fs.existsSync(statePath)) return sessionId;
  fs.mkdirSync(path.dirname(wirePath), { recursive: true });
  const ts = BASE_TIME - 60_000;
  const lines = [
    JSON.stringify({ type: 'metadata', protocol_version: '1.6', created_at: ts }),
    JSON.stringify({
      type: 'turn.prompt',
      turnId: 1,
      promptId: 'prompt-anchor-1',
      input: [{ type: 'text', text: 'Clean 1-turn anchor session for soak GC checkpointing.' }],
      origin: { kind: 'user' },
      time: ts + 10,
    }),
    JSON.stringify({
      type: 'context.append_message',
      message: {
        id: 'msg-anchor-user-1',
        role: 'user',
        content: [{ type: 'text', text: 'Clean 1-turn anchor session for soak GC checkpointing.' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
      time: ts + 12,
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      event: { type: 'step.begin', turnId: '1', step: 1, uuid: 'step-anchor-1' },
      time: ts + 15,
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      event: {
        type: 'content.part',
        turnId: '1',
        stepUuid: 'step-anchor-1',
        part: { type: 'text', text: 'Anchor session ready.' },
      },
      time: ts + 20,
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      event: { type: 'step.end', turnId: '1', step: 1, uuid: 'step-anchor-1' },
      time: ts + 25,
    }),
    JSON.stringify({ type: 'turn.ended', turnId: 1, durationMs: 20, reason: 'completed', time: ts + 30 }),
  ];
  fs.writeFileSync(wirePath, `${lines.join('\n')}\n`, 'utf8');
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      id: sessionId,
      version: 2,
      title: 'Soak Anchor Session',
      titleKind: 'custom',
      createdAt: ts,
      updatedAt: ts + 30,
      archived: false,
      cwd: workspaceDir,
      lastTurnReason: 'completed',
      agents: {
        main: { type: 'main', displayName: 'Main', model: 'twin-anthropic', createdAt: ts, contextTokens: 512 },
      },
    }),
    'utf8',
  );
  return sessionId;
}

export function generateExtremeMediaSession(options = {}) {
  const startedAt = performance.now();
  const rootDir = path.resolve(options.dir ?? '/tmp/kiki-chaos-nvme');
  const homeDir = path.join(rootDir, 'home');
  const workspaceDir = path.join(rootDir, 'workspace');
  const sessionId = options.sessionId ?? 'chaos_extreme_media';
  const imageCount = Math.max(10, Math.floor(options.imageCount ?? 600));
  const giantImageCount = Math.min(imageCount, Math.max(0, Math.floor(options.giantImageCount ?? 8)));
  const videoCount = Math.max(1, Math.floor(options.videoCount ?? 40));
  const audioCount = Math.max(0, Math.floor(options.audioCount ?? 30));
  const totalPlaybackAssets = videoCount + audioCount;
  const turnsCount = Math.max(1, Math.min(20, Math.floor(options.turnsCount ?? 20)));
  const giantPngWidth = options.giantPngWidth ?? 1600;
  const giantPngHeight = options.giantPngHeight ?? 1400;
  const regularPngWidth = options.regularPngWidth ?? 1200;
  const regularPngHeight = options.regularPngHeight ?? 900;

  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  const wsPath = path.join(homeDir, 'workspaces.json');
  let workspaceId;
  if (fs.existsSync(wsPath)) {
    const workspaces = JSON.parse(fs.readFileSync(wsPath, 'utf8'));
    workspaceId = Object.keys(workspaces.workspaces ?? {})[0];
  }
  if (!workspaceId) {
    workspaceId = computeChaosWorkDirKey(workspaceDir);
    const nowIso = new Date(BASE_TIME).toISOString();
    fs.writeFileSync(
      wsPath,
      JSON.stringify({
        version: 1,
        workspaces: {
          [workspaceId]: {
            root: workspaceDir,
            name: 'Chaos Benchmark Workspace',
            created_at: nowIso,
            last_opened_at: nowIso,
          },
        },
        deleted_workspace_ids: [],
      }),
      'utf8',
    );
  }

  const anchorSessionId = ensureAnchorSession(homeDir, workspaceId, workspaceDir);

  const sessionDir = path.join(homeDir, 'sessions', workspaceId, sessionId);
  const mediaDir = path.join(sessionDir, 'media');
  const metaDir = path.join(mediaDir, 'meta');
  const mainDir = path.join(sessionDir, 'agents', 'main');
  fs.rmSync(sessionDir, { recursive: true, force: true });
  fs.mkdirSync(metaDir, { recursive: true });
  fs.mkdirSync(mainDir, { recursive: true });

  // Build reusable template blobs once (hardlinked across hundreds of canonical file IDs)
  const giantPngBuf = generateSyntheticPng(giantPngWidth, giantPngHeight, { deflateLevel: 0, smoothBands: false });
  const regularPngBuf = generateSyntheticPng(regularPngWidth, regularPngHeight, { deflateLevel: 1, smoothBands: true });
  const mp4Buf = generateSyntheticMp4(options.videoBytes ?? 192 * 1024);
  const wavBuf = generateSyntheticWav(options.audioBytes ?? 192 * 1024);

  const tplGiantPng = path.join(sessionDir, '_tpl_giant.png');
  const tplRegularPng = path.join(sessionDir, '_tpl_regular.png');
  const tplMp4 = path.join(sessionDir, '_tpl_video.mp4');
  const tplWav = path.join(sessionDir, '_tpl_audio.wav');
  fs.writeFileSync(tplGiantPng, giantPngBuf);
  fs.writeFileSync(tplRegularPng, regularPngBuf);
  fs.writeFileSync(tplMp4, mp4Buf);
  fs.writeFileSync(tplWav, wavBuf);

  const imageFileIds = [];
  const giantImageFileIds = [];
  const videoFileIds = [];
  const audioFileIds = [];
  let hardlinked = 0;
  let copied = 0;

  for (let i = 1; i <= imageCount; i += 1) {
    const fileId = `f_s8img_${String(i).padStart(4, '0')}`;
    const isGiant = i <= giantImageCount;
    const dst = path.join(mediaDir, `${fileId}.png`);
    const mode = linkOrCopy(isGiant ? tplGiantPng : tplRegularPng, dst);
    if (mode === 'hardlinked') hardlinked += 1;
    else copied += 1;
    writeMediaMeta(metaDir, fileId, '.png', isGiant ? `giant-hires-${i}.png` : `timeline-img-${i}.png`, 'image/png');
    imageFileIds.push(fileId);
    if (isGiant) giantImageFileIds.push(fileId);
  }

  for (let i = 1; i <= videoCount; i += 1) {
    const fileId = `f_s8vid_${String(i).padStart(4, '0')}`;
    const dst = path.join(mediaDir, `${fileId}.mp4`);
    const mode = linkOrCopy(tplMp4, dst);
    if (mode === 'hardlinked') hardlinked += 1;
    else copied += 1;
    writeMediaMeta(metaDir, fileId, '.mp4', `timeline-clip-${i}.mp4`, 'video/mp4');
    videoFileIds.push(fileId);
  }

  for (let i = 1; i <= audioCount; i += 1) {
    const fileId = `f_s8aud_${String(i).padStart(4, '0')}`;
    const dst = path.join(mediaDir, `${fileId}.wav`);
    const mode = linkOrCopy(tplWav, dst);
    if (mode === 'hardlinked') hardlinked += 1;
    else copied += 1;
    writeMediaMeta(metaDir, fileId, '.wav', `timeline-audio-${i}.wav`, 'audio/wav');
    audioFileIds.push(fileId);
  }

  fs.rmSync(tplGiantPng, { force: true });
  fs.rmSync(tplRegularPng, { force: true });
  fs.rmSync(tplMp4, { force: true });
  fs.rmSync(tplWav, { force: true });

  const playbackFileIds = [...videoFileIds, ...audioFileIds];
  const wireLines = [JSON.stringify({ type: 'metadata', protocol_version: '1.6', created_at: BASE_TIME })];

  const imgsPerTurn = Math.ceil(imageFileIds.length / turnsCount);
  const mediaPerTurn = Math.ceil(playbackFileIds.length / turnsCount);

  for (let t = 0; t < turnsCount; t += 1) {
    const turnId = t + 1;
    const ts = BASE_TIME + turnId * 5_000;
    const turnKey = String(turnId);
    const stepUuid = `step-s8-${turnId}-1`;

    const imgSlice = imageFileIds.slice(t * imgsPerTurn, (t + 1) * imgsPerTurn);
    const avSlice = playbackFileIds.slice(t * mediaPerTurn, (t + 1) * mediaPerTurn);

    const contentParts = [
      {
        type: 'text',
        text: `Extreme media turn #${turnId}: ${imgSlice.length} images + ${avSlice.length} video/audio assets attached.`,
      },
      ...imgSlice.map((fid) => ({
        type: 'image_url',
        imageUrl: { url: `kimi-file://${fid}`, name: `${fid}.png` },
      })),
      ...avSlice.map((fid) =>
        fid.startsWith('f_s8vid_')
          ? { type: 'video_url', videoUrl: { url: `kimi-file://${fid}`, name: `${fid}.mp4` } }
          : { type: 'audio_url', audioUrl: { url: `kimi-file://${fid}`, name: `${fid}.wav` } },
      ),
    ];

    wireLines.push(
      JSON.stringify({
        type: 'turn.prompt',
        turnId,
        promptId: `prompt-s8-${turnId}`,
        input: contentParts,
        origin: { kind: 'user' },
        time: ts,
      }),
      JSON.stringify({
        type: 'context.append_message',
        message: {
          id: `msg-s8-user-${turnId}`,
          role: 'user',
          content: contentParts,
          toolCalls: [],
          origin: { kind: 'user' },
        },
        time: ts + 2,
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId: turnKey, step: 1, uuid: stepUuid },
        time: ts + 5,
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          turnId: turnKey,
          stepUuid,
          part: {
            type: 'text',
            text: `Indexed turn #${turnId} multimodal bundle (${imgSlice.length} PNGs, ${avSlice.length} AV clips).`,
          },
        },
        time: ts + 20,
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        event: { type: 'step.end', turnId: turnKey, step: 1, uuid: stepUuid },
        time: ts + 30,
      }),
      JSON.stringify({
        type: 'turn.ended',
        turnId,
        durationMs: 40,
        reason: 'completed',
        time: ts + 40,
      }),
    );
  }

  const mainWirePath = path.join(mainDir, 'wire.jsonl');
  fs.writeFileSync(mainWirePath, `${wireLines.join('\n')}\n`, 'utf8');

  const stateJsonPath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(
    stateJsonPath,
    JSON.stringify({
      id: sessionId,
      version: 2,
      title: `Extreme Media Timeline (${imageCount} imgs + ${totalPlaybackAssets} AV)`,
      titleKind: 'custom',
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME + turnsCount * 5_000 + 100,
      archived: false,
      cwd: workspaceDir,
      lastTurnReason: 'completed',
      agents: {
        main: {
          type: 'main',
          displayName: 'Main',
          model: 'twin-anthropic',
          thinkingEffort: 'high',
          createdAt: BASE_TIME,
          contextTokens: 48_000,
          toolCallCount: 0,
        },
      },
    }),
    'utf8',
  );

  return {
    rootDir,
    homeDir,
    workspaceDir,
    workspaceId,
    sessionId,
    anchorSessionId,
    imageCount,
    giantImageCount,
    giantPngBytes: giantPngBuf.byteLength,
    giantPngMiB: roundMiB(giantPngBuf.byteLength),
    regularPngBytes: regularPngBuf.byteLength,
    regularPngKiB: Number((regularPngBuf.byteLength / 1024).toFixed(1)),
    videoCount,
    audioCount,
    totalPlaybackAssets,
    turnsCount,
    imageFileIds,
    giantImageFileIds,
    videoFileIds,
    audioFileIds,
    playbackFileIds,
    wireLinkStats: { hardlinked, copied },
    mainWirePath,
    stateJsonPath,
    elapsedMs: roundMs(performance.now() - startedAt),
  };
}

async function apiJsonRaw(endpoint, token, method, urlPath, body, timeoutMs = 30_000) {
  const t0 = performance.now();
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpoint}${urlPath}`, {
      method,
      headers,
      signal: controller.signal,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, elapsedMs: roundMs(performance.now() - t0), json, rawText: text.slice(0, 300) };
  } catch (error) {
    return {
      status: 0,
      elapsedMs: roundMs(performance.now() - t0),
      json: null,
      rawText: String(error?.message ?? error).slice(0, 200),
      networkError: error?.name === 'AbortError' ? 'timeout' : String(error?.code ?? error?.message ?? 'fetch_error'),
    };
  } finally {
    clearTimeout(timer);
  }
}


function buildObjectUrlAndTimerInitScript({ enableFastTimers: _enableFastTimers = false } = {}) {
  return (fastTimers) => {
    try {
      localStorage.setItem('kiki.locale', 'en');
      localStorage.setItem('kiki.railMode', 'default');
      localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
    } catch {}

    const liveUrls = new Set();
    let createdTotal = 0;
    let revokedTotal = 0;
    const origCreate = URL.createObjectURL.bind(URL);
    const origRevoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = function patchedCreateObjectURL(obj) {
      const url = origCreate(obj);
      liveUrls.add(url);
      createdTotal += 1;
      window.__kikiLiveObjectUrls = liveUrls.size;
      return url;
    };
    URL.revokeObjectURL = function patchedRevokeObjectURL(url) {
      if (liveUrls.delete(url)) {
        revokedTotal += 1;
      }
      window.__kikiLiveObjectUrls = liveUrls.size;
      return origRevoke(url);
    };
    window.__kikiLiveObjectUrls = 0;
    window.__kikiObjectUrlStats = () => ({
      live: liveUrls.size,
      created: createdTotal,
      revoked: revokedTotal,
    });

    window.__kikiSoakFastTimers = Boolean(fastTimers);
    if (window.__kikiSoakFastTimers) {
      const origSetInterval = window.setInterval.bind(window);
      let acceleratedIntervals = 0;
      window.setInterval = function patchedSetInterval(fn, delay, ...args) {
        const numericDelay = typeof delay === 'number' && Number.isFinite(delay) ? delay : 0;
        if (window.__kikiSoakFastTimers && numericDelay >= 30_000) {
          acceleratedIntervals += 1;
          const fastDelay = Math.max(1_500, Math.floor(numericDelay / 20));
          return origSetInterval(fn, fastDelay, ...args);
        }
        return origSetInterval(fn, delay, ...args);
      };
      window.__kikiFastTimerStats = () => ({ acceleratedIntervals });
    }
  };
}

async function readCdpSnapshot(cdp) {
  try {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const map = Object.fromEntries(metrics.map((m) => [m.name, m.value]));
    return {
      jsHeapUsedMiB: roundMiB(map.JSHeapUsedSize ?? 0),
      jsHeapTotalMiB: roundMiB(map.JSHeapTotalSize ?? 0),
      domNodes: map.Nodes ?? 0,
      jsEventListeners: map.JSEventListeners ?? 0,
    };
  } catch (error) {
    return { error: String(error?.message ?? error).slice(0, 200) };
  }
}

export function computeSoakLinearSlopes(checkpoints) {
  if (!Array.isArray(checkpoints) || checkpoints.length < 2) {
    return null;
  }
  const first = checkpoints[0];
  const last = checkpoints.at(-1);
  const deltaCycles = Math.max(1, (last.cycle ?? 0) - (first.cycle ?? 0));
  return {
    fromCycle: first.cycle,
    toCycle: last.cycle,
    deltaCycles,
    jsHeapKbPerCycle: Number((((last.jsHeapMb - first.jsHeapMb) * 1024) / deltaCycles).toFixed(2)),
    domNodesPerCycle: Number(((last.domNodes - first.domNodes) / deltaCycles).toFixed(2)),
    listenersPerCycle: Number(((last.jsEventListeners - first.jsEventListeners) / deltaCycles).toFixed(2)),
    unrevokedObjectUrlsDelta: (last.liveObjectUrls ?? 0) - (first.liveObjectUrls ?? 0),
    serverRssKbPerCycle: Number((((last.serverRssMb - first.serverRssMb) * 1024) / deltaCycles).toFixed(2)),
    serverHeapKbPerCycle: Number((((last.serverHeapMb - first.serverHeapMb) * 1024) / deltaCycles).toFixed(2)),
    serverFdsDelta:
      typeof last.serverOpenFds === 'number' && typeof first.serverOpenFds === 'number'
        ? last.serverOpenFds - first.serverOpenFds
        : null,
  };
}

export async function runScenarioS7LongRunningSoak({
  server,
  corpus,
  mediaCorpus,
  tenKCorpus = null,
  totalCycles = 200,
  checkpointCycles = [20, 80, 140, 200],
  liveTurnsTarget = 15,
  reconnectCycles = [35, 70, 105, 145, 180],
  progress = (msg) => process.stderr.write(`[ccp-chaos] ${msg}\n`),
}) {
  const startedAt = performance.now();
  progress(`S7: Accelerated Long-Running Client & Server Soak (${totalCycles} cycles, fast-timers=20x, 5 WS reconnects, ${liveTurnsTarget} live multi-step media turns)...`);

  const kapRequire = createRequire(path.join(REPO_ROOT, 'packages', 'kap-server', 'package.json'));
  const { chromium } = kapRequire('playwright');

  const anchorSessionId = mediaCorpus?.anchorSessionId ?? ensureAnchorSession(corpus.homeDir, corpus.workspaceId, corpus.workspaceDir);
  const poolSessions = [];
  for (let i = 1; i <= 16; i += 1) {
    const sid = `chaos_bg_${String(i).padStart(4, '0')}`;
    if (fs.existsSync(path.join(corpus.homeDir, 'sessions', corpus.workspaceId, sid, 'state.json'))) {
      poolSessions.push(sid);
    }
  }
  if (mediaCorpus?.sessionId) poolSessions.push(mediaCorpus.sessionId);
  if (corpus?.giantSessionId) poolSessions.push(corpus.giantSessionId);
  if (tenKCorpus?.sessionId && fs.existsSync(path.join(corpus.homeDir, 'sessions', corpus.workspaceId, tenKCorpus.sessionId, 'state.json'))) {
    poolSessions.push(tenKCorpus.sessionId);
  }
  while (poolSessions.length < 20) {
    const created = await apiJsonRaw(server.endpoint, server.token, 'POST', '/api/sessions', {
      title: `Soak Pool Session #${poolSessions.length + 1}`,
      metadata: { cwd: corpus.workspaceDir },
    });
    if (created.json?.data?.id) poolSessions.push(created.json.data.id);
    else break;
  }

  // Create 3 dedicated live-turn sessions + upload 1 synthetic PNG for live streaming turns
  const liveTurnSessions = [];
  for (let i = 0; i < 3; i += 1) {
    const c = await apiJsonRaw(server.endpoint, server.token, 'POST', '/api/sessions', {
      title: `S7 Live Turn Target #${i + 1}`,
      metadata: { cwd: corpus.workspaceDir },
    });
    if (c.json?.data?.id) liveTurnSessions.push(c.json.data.id);
  }
  let uploadedImgId = null;
  if (liveTurnSessions.length > 0) {
    const png = generateSyntheticPng(400, 300, { deflateLevel: 1, smoothBands: true });
    const mp = buildMultipartUpload('soak-inline.png', 'image/png', png, liveTurnSessions[0]);
    const up = await fetch(`${server.endpoint}/api/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': mp.contentType },
      body: mp.body,
    }).then((r) => r.json()).catch(() => null);
    uploadedImgId = up?.data?.id ?? null;
  }

  const checkpoints = [];
  const pageErrors = [];
  const actionCounts = {
    sessionSwitches: 0,
    quickSwitcherToggles: 0,
    pageNavigations: 0,
    lightboxToggles: 0,
    cockpitToggles: 0,
    familyPopoverToggles: 0,
    wsReconnectBlips: 0,
    liveTurnsFired: 0,
    liveTurnsSucceeded: 0,
  };

  let browser = null;
  let webAssetsRecorder = null;
  let webAssetsAudit = null;
  const consoleErrors = [];
  const checkpointSet = new Set(checkpointCycles.filter((c) => c <= totalCycles));
  if (!checkpointSet.has(totalCycles)) checkpointSet.add(totalCycles);
  const reconnectSet = new Set(reconnectCycles);

  try {
    const webInfo = await assertKapServerWebAssets(server.endpoint);
    const deepLink = (routePath) =>
      `${webInfo.webUrl}${routePath}?server=${encodeURIComponent(server.endpoint)}&token=${encodeURIComponent(server.token)}`;

    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--no-proxy-server'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    await context.addInitScript(buildObjectUrlAndTimerInitScript({ enableFastTimers: true }), true);

    const page = await context.newPage();
    webAssetsRecorder = createWebAssetsAuditRecorder(page, server.endpoint);
    page.on('pageerror', (err) => {
      if (pageErrors.length < 30) pageErrors.push(String(err?.message ?? err).slice(0, 300));
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error' && consoleErrors.length < 30) consoleErrors.push(msg.text().slice(0, 300));
    });

    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('Network.enable');
    await cdp.send('HeapProfiler.enable').catch(() => undefined);

    await page.goto(deepLink(`/s/${anchorSessionId}`), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector('[data-transcript-scroll]', { timeout: 20_000 }).catch(() => undefined);
    await sleep(400);

    const spaNavigate = async (routePath) => {
      await page.evaluate((targetPath) => {
        const search = window.location.search;
        window.history.pushState({}, '', `${targetPath}${search}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, routePath);
    };

    const recordCheckpoint = async (cycle) => {
      await spaNavigate(`/s/${anchorSessionId}`);
      await page.waitForSelector('[data-transcript-scroll] [data-transcript-virtual-item]', { timeout: 15_000 }).catch(() => undefined);
      await sleep(350);
      await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined);
      await sleep(180);
      await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined);
      await sleep(180);
      const gcSrv = await server.gc();
      const cdpStats = await readCdpSnapshot(cdp);
      const urlStats = await page.evaluate(() => window.__kikiObjectUrlStats?.() ?? { live: 0, created: 0, revoked: 0 }).catch(() => ({ live: 0, created: 0, revoked: 0 }));
      const cp = {
        cycle,
        elapsedMs: roundMs(performance.now() - startedAt),
        jsHeapMb: cdpStats.jsHeapUsedMiB ?? 0,
        jsHeapTotalMb: cdpStats.jsHeapTotalMiB ?? 0,
        domNodes: cdpStats.domNodes ?? 0,
        jsEventListeners: cdpStats.jsEventListeners ?? 0,
        liveObjectUrls: urlStats.live,
        createdObjectUrls: urlStats.created,
        revokedObjectUrls: urlStats.revoked,
        serverRssMb: gcSrv.metrics.rssMiB,
        serverHeapMb: gcSrv.metrics.heapUsedMiB,
        serverOpenFds: gcSrv.metrics.fdCount,
        serverLiveSessions: gcSrv.metrics.liveSessionCount,
      };
      checkpoints.push(cp);
      progress(
        `S7 Checkpoint C${checkpoints.length} @cycle=${cycle}: jsHeap=${cp.jsHeapMb} MiB, DOM=${cp.domNodes}, listeners=${cp.jsEventListeners}, liveObjURLs=${cp.liveObjectUrls} (created=${cp.createdObjectUrls}/revoked=${cp.revokedObjectUrls}), srvRSS=${cp.serverRssMb} MiB, srvHeap=${cp.serverHeapMb} MiB, FDs=${cp.serverOpenFds}`,
      );
    };

    // Fire 15 background live multi-step streaming turns paced across the soak
    let turnsLaunched = 0;
    const turnInterval = Math.max(1, Math.floor(totalCycles / Math.max(1, liveTurnsTarget)));
    const inflightTurns = [];
    const launchLiveTurn = (idx) => {
      if (liveTurnSessions.length === 0) return;
      const sid = liveTurnSessions[idx % liveTurnSessions.length];
      actionCounts.liveTurnsFired += 1;
      const content =
        idx % 3 === 0 && uploadedImgId
          ? [
              { type: 'text', text: `[CHAOS_SCOPE:s7_turn_${idx}] [TOOLS:WORKSPACE] Soak streaming turn #${idx} with inline image.` },
              { type: 'image', source: { kind: 'file', file_id: uploadedImgId }, name: 'soak-inline.png' },
            ]
          : [{ type: 'text', text: `[CHAOS_SCOPE:s7_turn_${idx}] [TOOLS:WORKSPACE] Soak streaming turn #${idx}.` }];
      const p = apiJsonRaw(
        server.endpoint,
        server.token,
        'POST',
        `/api/sessions/${encodeURIComponent(sid)}/prompts`,
        { prompt_id: `p_s7_${idx}_${randomUUID().slice(0, 6)}`, content },
        25_000,
      )
        .then((res) => {
          if (res.status === 200 && res.json?.code === 0) actionCounts.liveTurnsSucceeded += 1;
        })
        .catch(() => undefined);
      inflightTurns.push(p);
    };

    const auxRoutes = ['/memory', '/usage', '/settings'];
    let auxIdx = 0;

    for (let cycle = 1; cycle <= totalCycles; cycle += 1) {
      const targetSid = poolSessions[(cycle - 1) % poolSessions.length];
      await spaNavigate(`/s/${targetSid}`);
      actionCounts.sessionSwitches += 1;
      await sleep(75);

      // Scroll a bit inside the session
      await page.evaluate(() => {
        const scroller = document.querySelector('[data-transcript-scroll]');
        if (scroller && scroller.scrollHeight > scroller.clientHeight) {
          scroller.scrollTop = Math.floor(scroller.scrollHeight * 0.5);
          scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        }
      }).catch(() => undefined);

      // Fire paced live streaming turns
      if (turnsLaunched < liveTurnsTarget && cycle % turnInterval === 0) {
        turnsLaunched += 1;
        launchLiveTurn(turnsLaunched);
      }

      // QuickSwitcher (Ctrl+K -> Escape)
      if (cycle % 10 === 0) {
        await page.keyboard.press('Control+k').catch(() => undefined);
        await sleep(80);
        await page.keyboard.press('Escape').catch(() => undefined);
        actionCounts.quickSwitcherToggles += 1;
      }

      // MemoryPage / UsagePage / SettingsPage rotation
      if (cycle % 12 === 0) {
        const route = auxRoutes[auxIdx % auxRoutes.length];
        auxIdx += 1;
        await spaNavigate(route);
        await sleep(160);
        actionCounts.pageNavigations += 1;
      }

      // MediaLightbox open/close on media-heavy session
      if (cycle % 15 === 0 && mediaCorpus?.sessionId) {
        await spaNavigate(`/s/${mediaCorpus.sessionId}`);
        await sleep(220);
        const imgBtn = page.locator('[data-transcript-scroll] img').first();
        if (await imgBtn.isVisible().catch(() => false)) {
          await imgBtn.click({ timeout: 2_000 }).catch(() => undefined);
          await sleep(160);
          await page.keyboard.press('Escape').catch(() => undefined);
          actionCounts.lightboxToggles += 1;
        }
      }

      // Cockpit toggle & AgentFamilyPopover
      if (cycle % 20 === 0) {
        const cockpitBtn = page.locator('[data-rail-mode="cockpit"]').first();
        if (await cockpitBtn.isVisible().catch(() => false)) {
          await cockpitBtn.click({ timeout: 2_000 }).catch(() => undefined);
          await sleep(120);
          await page.locator('[data-rail-mode="default"]').first().click({ timeout: 2_000 }).catch(() => undefined);
          actionCounts.cockpitToggles += 1;
        }
        if (corpus?.giantSessionId && corpus?.heavySubagentId) {
          await spaNavigate(`/s/${corpus.giantSessionId}/agent/${corpus.heavySubagentId}`);
          await sleep(150);
          const fam = page.locator('[data-agent-family-trigger]').first();
          if (await fam.isVisible().catch(() => false)) {
            await fam.click({ timeout: 2_000 }).catch(() => undefined);
            await sleep(100);
            await page.keyboard.press('Escape').catch(() => undefined);
            actionCounts.familyPopoverToggles += 1;
          }
        }
      }

      // 5 brief offline/online WS reconnect blips
      if (reconnectSet.has(cycle)) {
        await cdp.send('Network.emulateNetworkConditions', {
          offline: true,
          latency: 0,
          downloadThroughput: 0,
          uploadThroughput: 0,
        }).catch(() => undefined);
        await sleep(320);
        await cdp.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        }).catch(() => undefined);
        await sleep(320);
        actionCounts.wsReconnectBlips += 1;
      }

      if (checkpointSet.has(cycle)) {
        await Promise.allSettled(inflightTurns.splice(0));
        await recordCheckpoint(cycle);
      }
    }

    await Promise.allSettled(inflightTurns);
    const fastTimerStats = await page.evaluate(() => window.__kikiFastTimerStats?.() ?? null).catch(() => null);
    const finalSrvMetrics = await server.metrics(false);

    for (const sid of liveTurnSessions) {
      await server.closeSession(sid).catch(() => undefined);
    }

    if (webAssetsRecorder) {
      await webAssetsRecorder.settle();
      webAssetsAudit = webAssetsRecorder.snapshot();
      webAssetsRecorder.detach();
      webAssetsRecorder = null;
    }
    const webAssetsGate = evaluateWebAssetsBudget(webAssetsAudit);
    const slopes = computeSoakLinearSlopes(checkpoints);
    const passed = Boolean(
      webAssetsGate.passed &&
        pageErrors.length === 0 &&
        consoleErrors.length === 0 &&
        slopes !== null &&
        slopes.jsHeapKbPerCycle < 250 &&
        slopes.listenersPerCycle < 10 &&
        slopes.domNodesPerCycle < 25 &&
        slopes.unrevokedObjectUrlsDelta <= 2 &&
        finalSrvMetrics.unhandledRejections === 0 &&
        finalSrvMetrics.uncaughtExceptions === 0,
    );

    return {
      passed,
      servedByKapServer: true,
      webAssetsAudit,
      webAssetsGate,
      totalCycles,
      wallMs: roundMs(performance.now() - startedAt),
      poolSessionCount: poolSessions.length,
      actionCounts,
      fastTimerStats,
      checkpoints,
      slopes,
      pageErrors,
      consoleErrors,
      serverHealth: {
        unhandledRejections: finalSrvMetrics.unhandledRejections,
        uncaughtExceptions: finalSrvMetrics.uncaughtExceptions,
        eldP99Ms: finalSrvMetrics.eldP99Ms,
        maxSingleTickStallMs: finalSrvMetrics.maxSingleTickStallMs,
      },
    };
  } catch (error) {
    return {
      passed: false,
      totalCycles,
      wallMs: roundMs(performance.now() - startedAt),
      actionCounts,
      checkpoints,
      slopes: computeSoakLinearSlopes(checkpoints),
      pageErrors,
      consoleErrors,
      error: String(error?.stack ?? error).slice(0, 600),
    };
  } finally {
    webAssetsRecorder?.detach();
    await browser?.close().catch(() => undefined);
  }
}

export async function runScenarioS8MediaWeakNetStorm({
  server,
  mediaCorpus,
  stepTimeoutMs = 45_000,
  progress = (msg) => process.stderr.write(`[ccp-chaos] ${msg}\n`),
}) {
  const startedAt = performance.now();
  const sessionId = mediaCorpus.sessionId;
  progress(
    `S8: Extreme Timeline Media (${mediaCorpus.imageCount} imgs + ${mediaCorpus.totalPlaybackAssets} AV) + 32 Concurrent Giant Requests Under 3 Mbps / 180 ms RTT...`,
  );

  await server.resetWindow();
  const preSrv = await server.metrics(false);

  // ------------------------------------------------------------------
  // Part A: MAX_GRANTS = 64 boundary probe across 70 video/audio assets
  // ------------------------------------------------------------------
  progress(`S8 [1/3]: Probing POST /api/sessions/${sessionId}/media-playback across ${mediaCorpus.playbackFileIds.length} AV assets (> 64 MAX_GRANTS)...`);
  const mintedGrants = [];
  let rejected429 = 0;
  let firstRejectedIndex = null;
  let otherErrors = 0;

  for (let i = 0; i < mediaCorpus.playbackFileIds.length; i += 1) {
    const fileId = mediaCorpus.playbackFileIds[i];
    const res = await apiJsonRaw(
      server.endpoint,
      server.token,
      'POST',
      `/api/sessions/${encodeURIComponent(sessionId)}/media-playback`,
      { file_id: fileId },
      10_000,
    );
    if (res.status === 200 && res.json?.code === 0 && res.json?.data?.preview_id) {
      mintedGrants.push({ index: i + 1, fileId, ...res.json.data });
    } else if (res.status === 429 || res.json?.code === 429 || String(res.rawText).includes('too_many_media_previews')) {
      rejected429 += 1;
      if (firstRejectedIndex === null) firstRejectedIndex = i + 1;
    } else {
      otherErrors += 1;
    }
  }

  const probeRange = async (grant) => {
    if (!grant) return { status: null, bytes: 0, contentRange: null };
    const t0 = performance.now();
    try {
      const res = await fetch(`${server.endpoint}/media-preview/${grant.preview_id}`, {
        headers: { range: 'bytes=0-65535' },
      });
      const buf = Buffer.from(await res.arrayBuffer());
      return {
        status: res.status,
        bytes: buf.byteLength,
        contentRange: res.headers.get('content-range'),
        elapsedMs: roundMs(performance.now() - t0),
      };
    } catch (error) {
      return { status: 0, bytes: 0, error: String(error?.message ?? error).slice(0, 160) };
    }
  };

  const grant1 = mintedGrants.find((g) => g.index === 1) ?? null;
  const grant70 = mintedGrants.find((g) => g.index === mediaCorpus.playbackFileIds.length) ?? null;
  const grant1Range = await probeRange(grant1);
  const grant70Range = grant70
    ? await probeRange(grant70)
    : { status: rejected429 > 0 ? 429 : null, bytes: 0, reason: 'mint_rejected_max_grants' };

  // Clean up minted grants so browser starts from a clean grant table
  await Promise.all(
    mintedGrants.map((g) =>
      apiJsonRaw(server.endpoint, server.token, 'DELETE', `/api/sessions/media-playback/${g.preview_id}`, undefined, 5_000).catch(
        () => undefined,
      ),
    ),
  );

  const grantBoundaryProbe = {
    attempted: mediaCorpus.playbackFileIds.length,
    minted: mintedGrants.length,
    rejected429,
    firstRejectedIndex,
    otherErrors,
    grant1RangeStatus: grant1Range.status,
    grant1RangeBytes: grant1Range.bytes,
    grant70RangeStatus: grant70Range.status,
    grant70RangeBytes: grant70Range.bytes,
  };

  // Create a dedicated fast session for the interactive prompt starvation probe
  const promptProbeSession = await apiJsonRaw(server.endpoint, server.token, 'POST', '/api/sessions', {
    title: 'S8 Interactive Prompt Starvation Probe',
    metadata: { cwd: mediaCorpus.workspaceDir },
  });
  const promptProbeSid = promptProbeSession.json?.data?.id ?? mediaCorpus.anchorSessionId;

  // ------------------------------------------------------------------
  // Part B + C: Weak Network (3 Mbps / 180 ms RTT) Browser Scroll Storm
  //             + Simultaneous 32 Concurrent Giant Requests
  // ------------------------------------------------------------------
  progress('S8 [2/3]: Running Chromium 12-viewport extreme media scroll under 3 Mbps / 180 ms RTT + simultaneous 32-way giant request storm...');
  const kapRequire = createRequire(path.join(REPO_ROOT, 'packages', 'kap-server', 'package.json'));
  const { chromium } = kapRequire('playwright');

  const pageErrors = [];
  let mediaRequestsTotal = 0;
  let abortedMediaRequests = 0;
  let media429Count = 0;
  let mediaFailedCount = 0;

  let browser = null;
  let webAssetsRecorder = null;
  let webAssetsAudit = null;
  const consoleErrors = [];
  let peakServerRssMb = preSrv.rssMiB;
  const rssPoller = setInterval(() => {
    void (async () => {
      try {
        const m = await server.metrics(false);
        if (m.rssMiB > peakServerRssMb) peakServerRssMb = m.rssMiB;
      } catch {}
    })();
  }, 400);

  let weakNetBrowser = null;
  let concurrent32Storm = null;

  try {
    const webInfo = await assertKapServerWebAssets(server.endpoint);
    const deepLink = (routePath) =>
      `${webInfo.webUrl}${routePath}?server=${encodeURIComponent(server.endpoint)}&token=${encodeURIComponent(server.token)}`;

    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--no-proxy-server'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    await context.addInitScript(buildObjectUrlAndTimerInitScript({ enableFastTimers: false }), false);
    await context.addInitScript(() => {
      const longTasks = [];
      window.__kikiS8LongTasks = {
        snapshot() {
          const maxMs = longTasks.length > 0 ? Math.max(...longTasks) : 0;
          const tbtMs = longTasks.reduce((sum, d) => sum + Math.max(0, d - 50), 0);
          return {
            count: longTasks.length,
            longTaskMaxMs: Number(maxMs.toFixed(2)),
            totalBlockingTimeMs: Number(tbtMs.toFixed(2)),
          };
        },
      };
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) longTasks.push(e.duration);
        }).observe({ type: 'longtask', buffered: true });
      } catch {}
    });

    const page = await context.newPage();
    webAssetsRecorder = createWebAssetsAuditRecorder(page, server.endpoint);
    page.on('pageerror', (err) => {
      if (pageErrors.length < 30) pageErrors.push(String(err?.message ?? err).slice(0, 300));
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error' && consoleErrors.length < 30) consoleErrors.push(msg.text().slice(0, 300));
    });
    const isMediaUrl = (url) =>
      url.startsWith(server.endpoint) &&
      (url.includes('/media') || url.includes('/files/') || url.includes('/media-preview/'));
    let firstMessagePainted = false;
    let requestCountBeforeFirstMessage = 0;
    page.on('request', (req) => {
      const url = req.url();
      if (!firstMessagePainted && url.startsWith(server.endpoint)) {
        requestCountBeforeFirstMessage += 1;
      }
      if (isMediaUrl(url)) mediaRequestsTotal += 1;
    });
    page.on('requestfailed', (req) => {
      if (isMediaUrl(req.url())) {
        const failureText = req.failure()?.errorText ?? '';
        if (failureText.includes('ABORTED')) abortedMediaRequests += 1;
        else mediaFailedCount += 1;
      }
    });
    page.on('response', (res) => {
      if (isMediaUrl(res.url())) {
        if (res.status() === 429) media429Count += 1;
        else if (res.status() >= 400) mediaFailedCount += 1;
      }
    });

    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 180,
      downloadThroughput: 375 * 1024, // 3 Mbps down
      uploadThroughput: 187 * 1024, // 1.5 Mbps up
    });

    const openT0 = performance.now();
    await page.goto(deepLink(`/s/${sessionId}`), { waitUntil: 'domcontentloaded', timeout: stepTimeoutMs });
    await page.waitForSelector('[data-transcript-scroll] [data-transcript-virtual-item]', { timeout: stepTimeoutMs });
    const coldOpenMs = roundMs(performance.now() - openT0);
    await page.waitForFunction(
      () => {
        const items = document.querySelectorAll('[data-transcript-scroll] [data-transcript-virtual-item]');
        for (const el of items) {
          if ((el.textContent ?? '').trim().length > 0) return true;
        }
        return false;
      },
      null,
      { timeout: stepTimeoutMs },
    );
    firstMessagePainted = true;
    const firstMessageVisibleMs = roundMs(performance.now() - openT0);
    const coldOpenLongTasks = await page
      .evaluate(() => window.__kikiS8LongTasks?.snapshot?.() ?? { count: 0, longTaskMaxMs: 0, totalBlockingTimeMs: 0 })
      .catch(() => ({ count: 0, longTaskMaxMs: 0, totalBlockingTimeMs: 0 }));
    const coldOpenCdpMetrics = await cdp.send('Performance.getMetrics');
    const coldOpenMetricMap = Object.fromEntries(coldOpenCdpMetrics.metrics.map((m) => [m.name, m.value]));
    const jsHeapUsedBytes = Math.round(coldOpenMetricMap.JSHeapUsedSize ?? 0);

    // Prepare 32 concurrent giant requests against kap-server
    const uploadPngSmall = generateSyntheticPng(1200, 900, { deflateLevel: 0, smoothBands: true }); // ~3.2 MiB valid PNG
    const runConcurrent32 = async () => {
      const stormT0 = performance.now();
      const latencies = [];
      let uploadsSucceeded = 0;
      let uploadsFailed = 0;
      let abortedUploadsHandledCleanly = 0;
      let rangeProbesSucceeded = 0;
      let rangeProbes206 = 0;
      let mediaReadsSucceeded = 0;

      const jobs = [];
      // 12 concurrent multi-MB uploads
      for (let i = 0; i < 12; i += 1) {
        jobs.push(
          (async () => {
            const t0 = performance.now();
            const mp = buildMultipartUpload(`s8-giant-${i}.png`, 'image/png', uploadPngSmall, promptProbeSid);
            try {
              const res = await fetch(`${server.endpoint}/api/files`, {
                method: 'POST',
                headers: { authorization: `Bearer ${server.token}`, 'content-type': mp.contentType },
                body: mp.body,
              });
              await res.text();
              latencies.push(roundMs(performance.now() - t0));
              if (res.status === 200) uploadsSucceeded += 1;
              else uploadsFailed += 1;
            } catch {
              latencies.push(roundMs(performance.now() - t0));
              uploadsFailed += 1;
            }
          })(),
        );
      }

      // 4 mid-flight aborted uploads
      for (let i = 0; i < 4; i += 1) {
        jobs.push(
          (async () => {
            const t0 = performance.now();
            const mp = buildMultipartUpload(`s8-abort-${i}.png`, 'image/png', uploadPngSmall, promptProbeSid);
            const ac = new AbortController();
            const abortTimer = setTimeout(() => ac.abort(), 30 + i * 15);
            try {
              await fetch(`${server.endpoint}/api/files`, {
                method: 'POST',
                headers: { authorization: `Bearer ${server.token}`, 'content-type': mp.contentType },
                body: mp.body,
                signal: ac.signal,
              });
              abortedUploadsHandledCleanly += 1;
            } catch (error) {
              if (error?.name === 'AbortError') abortedUploadsHandledCleanly += 1;
            } finally {
              clearTimeout(abortTimer);
              latencies.push(roundMs(performance.now() - t0));
            }
          })(),
        );
      }

      // 8 concurrent canonical image reads + previews (mix of giant PNGs and regular PNGs)
      for (let i = 0; i < 8; i += 1) {
        jobs.push(
          (async () => {
            const t0 = performance.now();
            const fid = mediaCorpus.imageFileIds[i % mediaCorpus.imageFileIds.length];
            const suffix = i % 2 === 0 ? '/preview' : '';
            try {
              const res = await fetch(
                `${server.endpoint}/api/sessions/${encodeURIComponent(sessionId)}/media/${encodeURIComponent(fid)}${suffix}`,
                { headers: { authorization: `Bearer ${server.token}` } },
              );
              await res.arrayBuffer();
              latencies.push(roundMs(performance.now() - t0));
              if (res.status === 200) mediaReadsSucceeded += 1;
            } catch {
              latencies.push(roundMs(performance.now() - t0));
            }
          })(),
        );
      }

      // 8 concurrent video/audio Range probes (mint -> Range: bytes=0-65535 -> delete)
      for (let i = 0; i < 8; i += 1) {
        jobs.push(
          (async () => {
            const t0 = performance.now();
            const fid = mediaCorpus.playbackFileIds[(i * 7) % mediaCorpus.playbackFileIds.length];
            const mint = await apiJsonRaw(
              server.endpoint,
              server.token,
              'POST',
              `/api/sessions/${encodeURIComponent(sessionId)}/media-playback`,
              { file_id: fid },
              15_000,
            );
            if (mint.status === 200 && mint.json?.data?.preview_id) {
              const pid = mint.json.data.preview_id;
              const rng = await probeRange(mint.json.data);
              if (rng.status === 206 || rng.status === 200) rangeProbesSucceeded += 1;
              if (rng.status === 206) rangeProbes206 += 1;
              await apiJsonRaw(server.endpoint, server.token, 'DELETE', `/api/sessions/media-playback/${pid}`, undefined, 5_000).catch(
                () => undefined,
              );
            }
            latencies.push(roundMs(performance.now() - t0));
          })(),
        );
      }

      await Promise.all(jobs);
      return {
        total: jobs.length,
        uploadsSucceeded,
        uploadsFailed,
        abortedUploadsHandledCleanly,
        mediaReadsSucceeded,
        rangeProbesSucceeded,
        rangeProbes206,
        wallMs: roundMs(performance.now() - stormT0),
        latencyMs: summarize(latencies),
      };
    };

    // Run 12-viewport scroll storm + in-browser prompt/RPC probes + 32-way backend giant storm SIMULTANEOUSLY!
    const scrollT0 = performance.now();
    const stormPromise = runConcurrent32();

    const scrollPromise = page.evaluate(async () => {
      const scroller = document.querySelector('[data-transcript-scroll]');
      if (!scroller) return { scrolledViewports: 0 };
      const vh = Math.max(400, scroller.clientHeight || 720);
      const maxTop = Math.max(0, scroller.scrollHeight - vh);
      for (let i = 1; i <= 12; i += 1) {
        const ratio = i <= 8 ? i / 8 : (12 - i) / 4;
        scroller.scrollTop = Math.floor(maxTop * ratio);
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 140));
      }
      await new Promise((r) => setTimeout(r, 350));
      return {
        scrolledViewports: 12,
        mountedImages: document.querySelectorAll('[data-transcript-scroll] img').length,
        mountedVideos: document.querySelectorAll('[data-transcript-scroll] video').length,
        mountedAudios: document.querySelectorAll('[data-transcript-scroll] audio').length,
      };
    });

    // Wait 300ms into the media scroll storm, then measure interactive RPC + Prompt latency FROM INSIDE Chromium
    // (shares Chromium's HTTP/1.1 connection pool under 3 Mbps / 180 ms RTT!)
    await sleep(300);
    const inBrowserProbes = await page.evaluate(
      async ({ endpoint, token, probeSid }) => {
        const auth = { authorization: `Bearer ${token}` };
        const rpcT0 = performance.now();
        let rpcStatus = 0;
        let rpcError = null;
        try {
          const r = await fetch(`${endpoint}/api/sessions/${encodeURIComponent(probeSid)}/status`, { headers: auth });
          rpcStatus = r.status;
          await r.text();
        } catch (error) {
          rpcError = String(error?.message ?? error).slice(0, 200);
        }
        const rpcMs = Number((performance.now() - rpcT0).toFixed(2));

        const pT0 = performance.now();
        let promptStatus = 0;
        let promptError = null;
        try {
          const p = await fetch(`${endpoint}/api/sessions/${encodeURIComponent(probeSid)}/prompts`, {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json' },
            body: JSON.stringify({
              prompt_id: `p_s8_starve_${Date.now()}`,
              content: [{ type: 'text', text: '[CHAOS_SCOPE:s8_starve] Interactive prompt during weak-net media storm.' }],
            }),
          });
          promptStatus = p.status;
          await p.text();
        } catch (error) {
          promptError = String(error?.message ?? error).slice(0, 200);
        }
        const promptMs = Number((performance.now() - pT0).toFixed(2));
        return {
          rpcUnderMediaStormMs: rpcMs,
          rpcStatus,
          rpcError,
          promptUnderMediaStormMs: promptMs,
          promptStatus,
          promptError,
        };
      },
      { endpoint: server.endpoint, token: server.token, probeSid: promptProbeSid },
    );

    const [scrollInfo, stormResult] = await Promise.all([scrollPromise, stormPromise]);
    const scroll12ViewportsMs = roundMs(performance.now() - scrollT0);
    concurrent32Storm = stormResult;

    const urlStats = await page.evaluate(() => window.__kikiObjectUrlStats?.() ?? { live: 0, created: 0, revoked: 0 }).catch(() => ({ live: 0, created: 0, revoked: 0 }));
    const cdpAfterScroll = await readCdpSnapshot(cdp);

    weakNetBrowser = {
      servedByKapServer: true,
      emulation: { downloadMbps: 3, uploadMbps: 1.5, latencyMs: 180 },
      coldOpenMs,
      firstMessageVisibleMs,
      longTaskMaxMs: coldOpenLongTasks.longTaskMaxMs,
      longTaskCount: coldOpenLongTasks.count,
      totalBlockingTimeMs: coldOpenLongTasks.totalBlockingTimeMs,
      jsHeapUsedBytes,
      requestCountBeforeFirstMessage,
      scroll12ViewportsMs,
      ...scrollInfo,
      ...inBrowserProbes,
      mediaRequestsTotal,
      abortedMediaRequests,
      media429Count,
      mediaFailedCount,
      liveObjectUrlsAfterScroll: urlStats.live,
      createdObjectUrls: urlStats.created,
      revokedObjectUrls: urlStats.revoked,
      cdpAfterScroll,
      pageErrors,
      consoleErrors,
    };
  } catch (error) {
    weakNetBrowser = {
      servedByKapServer: false,
      error: String(error?.stack ?? error).slice(0, 600),
      mediaRequestsTotal,
      abortedMediaRequests,
      media429Count,
      mediaFailedCount,
      pageErrors,
      consoleErrors,
    };
  } finally {
    clearInterval(rssPoller);
    if (webAssetsRecorder) {
      await webAssetsRecorder.settle();
      webAssetsAudit = webAssetsRecorder.snapshot();
      webAssetsRecorder.detach();
    }
    await browser?.close().catch(() => undefined);
    await server.closeSession(promptProbeSid).catch(() => undefined);
  }

  progress('S8 [3/3]: Collecting post-storm server RSS/ELU/GC metrics...');
  const postSrv = await server.metrics(false);
  if (postSrv.rssMiB > peakServerRssMb) peakServerRssMb = postSrv.rssMiB;
  const gcSrv = await server.gc();
  const webAssetsGate = evaluateWebAssetsBudget(webAssetsAudit);
  const B = FROZEN_S8_WEAKNET_BUDGETS;

  const s8Failures = [];
  if (pageErrors.length > 0) s8Failures.push(`pageErrors=${pageErrors.length}`);
  if (consoleErrors.length > 0) s8Failures.push(`consoleErrors=${consoleErrors.length}`);
  if (!webAssetsGate.passed) s8Failures.push(...webAssetsGate.failures.map((f) => `webAssets: ${f}`));
  if (grantBoundaryProbe.grant1RangeStatus !== 206) s8Failures.push(`grant1RangeStatus=${grantBoundaryProbe.grant1RangeStatus}`);
  if (grantBoundaryProbe.grant70RangeStatus !== 206) s8Failures.push(`grant70RangeStatus=${grantBoundaryProbe.grant70RangeStatus}`);
  if (grantBoundaryProbe.rejected429 !== 0) s8Failures.push(`grantBoundary rejected429=${grantBoundaryProbe.rejected429}`);
  if (!weakNetBrowser || weakNetBrowser.error) s8Failures.push(`weakNetBrowser error=${weakNetBrowser?.error ?? 'missing'}`);
  if (weakNetBrowser?.servedByKapServer !== true) s8Failures.push('GUI not served by kap-server webAssets');
  if (!(typeof weakNetBrowser?.coldOpenMs === 'number' && weakNetBrowser.coldOpenMs < B.coldOpenMs)) {
    s8Failures.push(`coldOpenMs=${weakNetBrowser?.coldOpenMs} >= ${B.coldOpenMs}`);
  }
  if (!(typeof weakNetBrowser?.firstMessageVisibleMs === 'number' && weakNetBrowser.firstMessageVisibleMs < B.firstMessageVisibleMs)) {
    s8Failures.push(`firstMessageVisibleMs=${weakNetBrowser?.firstMessageVisibleMs} >= ${B.firstMessageVisibleMs}`);
  }
  if (!(typeof weakNetBrowser?.longTaskMaxMs === 'number' && weakNetBrowser.longTaskMaxMs < B.longTaskMaxMs)) {
    s8Failures.push(`longTaskMaxMs=${weakNetBrowser?.longTaskMaxMs} >= ${B.longTaskMaxMs}`);
  }
  if (!(typeof weakNetBrowser?.jsHeapUsedBytes === 'number' && weakNetBrowser.jsHeapUsedBytes > 0 && weakNetBrowser.jsHeapUsedBytes < B.jsHeapUsedBytes)) {
    s8Failures.push(`jsHeapUsedBytes=${weakNetBrowser?.jsHeapUsedBytes} outside (0, ${B.jsHeapUsedBytes})`);
  }
  if (!(typeof weakNetBrowser?.requestCountBeforeFirstMessage === 'number' && weakNetBrowser.requestCountBeforeFirstMessage > 0 && weakNetBrowser.requestCountBeforeFirstMessage < B.requestCountBeforeFirstMessage)) {
    s8Failures.push(`requestCountBeforeFirstMessage=${weakNetBrowser?.requestCountBeforeFirstMessage} outside (0, ${B.requestCountBeforeFirstMessage})`);
  }
  if (!((weakNetBrowser?.promptUnderMediaStormMs ?? 99999) < B.promptUnderMediaStormMs)) {
    s8Failures.push(`promptUnderMediaStormMs=${weakNetBrowser?.promptUnderMediaStormMs} >= ${B.promptUnderMediaStormMs}`);
  }
  if (!(typeof weakNetBrowser?.promptStatus === 'number' && weakNetBrowser.promptStatus >= 200 && weakNetBrowser.promptStatus < 300)) {
    s8Failures.push(`promptStatus=${weakNetBrowser?.promptStatus ?? 0} (error=${weakNetBrowser?.promptError ?? 'non-2xx'})`);
  }
  if (!((weakNetBrowser?.rpcUnderMediaStormMs ?? 99999) < B.rpcUnderMediaStormMs)) {
    s8Failures.push(`rpcUnderMediaStormMs=${weakNetBrowser?.rpcUnderMediaStormMs} >= ${B.rpcUnderMediaStormMs}`);
  }
  if (!(typeof weakNetBrowser?.rpcStatus === 'number' && weakNetBrowser.rpcStatus >= 200 && weakNetBrowser.rpcStatus < 300)) {
    s8Failures.push(`rpcStatus=${weakNetBrowser?.rpcStatus ?? 0} (error=${weakNetBrowser?.rpcError ?? 'non-2xx'})`);
  }
  if (!concurrent32Storm || concurrent32Storm.uploadsSucceeded !== 12 || (concurrent32Storm.uploadsFailed ?? 0) > 0) {
    s8Failures.push(`uploadsSucceeded=${concurrent32Storm?.uploadsSucceeded ?? 0} !== 12 (failed=${concurrent32Storm?.uploadsFailed ?? 0})`);
  }
  if (!concurrent32Storm || concurrent32Storm.abortedUploadsHandledCleanly !== 4) {
    s8Failures.push(`abortedUploadsHandledCleanly=${concurrent32Storm?.abortedUploadsHandledCleanly ?? 0} !== 4`);
  }
  if (postSrv.unhandledRejections !== 0) s8Failures.push(`unhandledRejections=${postSrv.unhandledRejections}`);
  if (postSrv.uncaughtExceptions !== 0) s8Failures.push(`uncaughtExceptions=${postSrv.uncaughtExceptions}`);

  const passed = s8Failures.length === 0;

  return {
    passed,
    failures: s8Failures,
    budgets: B,
    webAssetsAudit,
    webAssetsGate,
    wallMs: roundMs(performance.now() - startedAt),
    corpusSummary: {
      sessionId,
      imageCount: mediaCorpus.imageCount,
      giantImageCount: mediaCorpus.giantImageCount,
      giantPngMiB: mediaCorpus.giantPngMiB,
      videoCount: mediaCorpus.videoCount,
      audioCount: mediaCorpus.audioCount,
      totalPlaybackAssets: mediaCorpus.totalPlaybackAssets,
      turnsCount: mediaCorpus.turnsCount,
    },
    grantBoundaryProbe,
    weakNetBrowser,
    concurrent32Storm,
    serverHealth: {
      preRssMiB: preSrv.rssMiB,
      peakServerRssMb,
      postGcRssMiB: gcSrv.metrics.rssMiB,
      vmHwmMiB: gcSrv.metrics.vmHwmMiB,
      eldP99Ms: postSrv.eldP99Ms,
      eldMaxMs: postSrv.eldMaxMs,
      maxSingleTickStallMs: postSrv.maxSingleTickStallMs,
      unhandledRejections: postSrv.unhandledRejections,
      uncaughtExceptions: postSrv.uncaughtExceptions,
    },
  };
}
