import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { computeChaosWorkDirKey } from './corpus-generator.mjs';
import { generateSyntheticMp4, generateSyntheticPng } from './scenario-soak-and-media-weaknet.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MiB = 1024 * 1024;
const BASE_TIME = 1_760_300_000_000;

const GUI_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
};

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
  if (!samples.length) return { count: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
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

// ---------------------------------------------------------------------------
// Real Spec-Compliant Ogg/Opus Binary Generator (RFC 3533 + RFC 7845)
// ---------------------------------------------------------------------------
const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let r = i << 24;
    for (let j = 0; j < 8; j += 1) {
      r = (r & 0x80000000) !== 0 ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
    }
    table[i] = r >>> 0;
  }
  return table;
})();

export function computeOggCrc32(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i += 1) {
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}

function buildOggPage({ headerType, granulePosition, serial, sequence, packets }) {
  const laces = [];
  for (const pkt of packets) {
    let rem = pkt.length;
    while (rem >= 255) {
      laces.push(255);
      rem -= 255;
    }
    laces.push(rem);
  }
  const body = Buffer.concat(packets);
  const header = Buffer.alloc(27 + laces.length);
  header.write('OggS', 0, 'ascii');
  header[4] = 0; // stream_structure_version
  header[5] = headerType;
  header.writeBigInt64LE(BigInt(granulePosition), 6);
  header.writeUInt32LE(serial >>> 0, 14);
  header.writeUInt32LE(sequence >>> 0, 18);
  header.writeUInt32LE(0, 22); // CRC placeholder
  header[26] = laces.length;
  for (let i = 0; i < laces.length; i += 1) {
    header[27 + i] = laces[i];
  }
  const page = Buffer.concat([header, body]);
  const crc = computeOggCrc32(page);
  page.writeUInt32LE(crc, 22);
  return page;
}

/**
 * Generate a real, RFC 7845 / RFC 3533 compliant Ogg/Opus audio file.
 * Sniffed as `audio/ogg` by kap-server and natively decoded by Chromium `<audio>`.
 */
export function generateValidOggOpus(durationMs = 1600, { serial = 0x53390001 } = {}) {
  const opusHead = Buffer.alloc(19);
  opusHead.write('OpusHead', 0, 'ascii');
  opusHead[8] = 1; // version
  opusHead[9] = 1; // channel count (mono)
  opusHead.writeUInt16LE(312, 10); // pre-skip (standard 6.5ms @ 48kHz)
  opusHead.writeUInt32LE(48_000, 12); // input sample rate
  opusHead.writeInt16LE(0, 16); // output gain
  opusHead[18] = 0; // channel mapping family

  const vendor = Buffer.from('kiki-chaos-s9', 'ascii');
  const opusTags = Buffer.alloc(8 + 4 + vendor.length + 4);
  opusTags.write('OpusTags', 0, 'ascii');
  opusTags.writeUInt32LE(vendor.length, 8);
  vendor.copy(opusTags, 12);
  opusTags.writeUInt32LE(0, 12 + vendor.length);

  const pages = [
    buildOggPage({ headerType: 0x02, granulePosition: 0, serial, sequence: 0, packets: [opusHead] }),
    buildOggPage({ headerType: 0x00, granulePosition: 0, serial, sequence: 1, packets: [opusTags] }),
  ];

  // 20ms Opus 48kHz mono silence frame (TOC 0xf8 = CELT FB 20ms mono + 2 silence payload bytes)
  const silencePacket = Buffer.from([0xf8, 0xff, 0xfe]);
  const packetCount = Math.max(10, Math.ceil(durationMs / 20));
  const packetsPerPage = 10;
  let seq = 2;
  let granule = 0;
  for (let i = 0; i < packetCount; i += packetsPerPage) {
    const batchCount = Math.min(packetsPerPage, packetCount - i);
    const batch = Array.from({ length: batchCount }, () => silencePacket);
    granule += batchCount * 960;
    const isLast = i + batchCount >= packetCount;
    pages.push(
      buildOggPage({
        headerType: isLast ? 0x04 : 0x00,
        granulePosition: granule,
        serial,
        sequence: seq,
        packets: batch,
      }),
    );
    seq += 1;
  }
  return Buffer.concat(pages);
}

export function generateValidSyntheticMp4(totalBytes = 192 * 1024) {
  return generateSyntheticMp4(totalBytes);
}

// ---------------------------------------------------------------------------
// Tier Configuration (`--tier full` vs `--tier smoke`)
// ---------------------------------------------------------------------------
export function resolveS9TierConfig(tier = 'full', overrides = {}) {
  const normalized = tier === 'smoke' ? 'smoke' : 'full';
  const base =
    normalized === 'smoke'
      ? {
          tier: 'smoke',
          giantGiB: 0.015,
          sessionCount: 140,
          secondaryWorkspaceCount: 11,
          sessionsPerSecondaryWorkspace: 8,
          subagentCount: 250,
          personaCount: 8,
          sendRounds: 10,
          streamHoldDrill1Ms: 1_600,
          streamHoldDrill2Ms: 9_000,
          mediaAudioCount: 4,
          mediaVideoCount: 3,
          mediaImageCount: 4,
          quickSwitcherArrows: 35,
          mediaRangeMaxMs: 250,
          sidebarMaxBlankGapPx: 24,
          stepTimeoutMs: 45_000,
          churnIntervalMs: 250,
        }
      : {
          tier: 'full',
          giantGiB: 3.1,
          sessionCount: 10_000,
          secondaryWorkspaceCount: 11,
          sessionsPerSecondaryWorkspace: 8,
          subagentCount: 10_000,
          personaCount: 10,
          sendRounds: 10,
          streamHoldDrill1Ms: 2_200,
          streamHoldDrill2Ms: 12_000,
          mediaAudioCount: 6,
          mediaVideoCount: 4,
          mediaImageCount: 6,
          quickSwitcherArrows: 35,
          mediaRangeMaxMs: 250,
          sidebarMaxBlankGapPx: 24,
          stepTimeoutMs: 60_000,
          churnIntervalMs: 200,
        };
  return { ...base, ...overrides };
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

/**
 * Seeds Scenario S9 corpus extensions onto the existing chaos NVMe home:
 * - Personas (`<home>/personas/`) so `[data-sidebar-personas-toggle]` renders an accordion
 * - 10k sessions (or 140 in smoke) distributed across 12 workspaces so Sidebar & QuickSwitcher virtualizers engage
 * - `chaos_s9_media` session with real valid `.ogg` Opus audio, `.mp4` video, and `.png` images in ScopedMediaStore
 */
export function seedS9ChaosExtensions({ dir, corpus, tierConfig }) {
  const startedAt = performance.now();
  const rootDir = path.resolve(dir ?? corpus.rootDir);
  const homeDir = corpus?.homeDir ?? path.join(rootDir, 'home');
  const workspaceDir = corpus?.workspaceDir ?? path.join(rootDir, 'workspace');
  const primaryWorkspaceId = corpus?.workspaceId ?? computeChaosWorkDirKey(workspaceDir);

  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  // 1. Seed valid personas so `[data-sidebar-personas-toggle]` renders a real multi-row accordion
  const personaIds = [];
  for (let i = 1; i <= tierConfig.personaCount; i += 1) {
    const id = `s9-persona-${String(i).padStart(2, '0')}`;
    const pDir = path.join(homeDir, 'personas', id);
    fs.mkdirSync(pDir, { recursive: true });
    const personaMd = [
      '---',
      `name: S9 Chaos Persona ${String(i).padStart(2, '0')}`,
      `title: Scale Verification Role #${i}`,
      'job: Verify virtualized sidebar layout and popover invariants',
      `greeting: Persona ${i} online for Scenario S9 flight recorder verification.`,
      '---',
      `Synthetic zero-PII persona #${i} seeded for Scenario S9 full-stack browser chaos testing.`,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(pDir, 'persona.md'), personaMd, 'utf8');
    personaIds.push(id);
  }

  // 2. Register 11 lightweight secondary workspaces alongside the primary workspace
  const wsPath = path.join(homeDir, 'workspaces.json');
  const existingWs = fs.existsSync(wsPath)
    ? JSON.parse(fs.readFileSync(wsPath, 'utf8'))
    : { version: 1, workspaces: {}, deleted_workspace_ids: [] };
  const nowIso = new Date(BASE_TIME).toISOString();
  if (!existingWs.workspaces[primaryWorkspaceId]) {
    existingWs.workspaces[primaryWorkspaceId] = {
      root: workspaceDir,
      name: 'Chaos Benchmark Workspace',
      created_at: nowIso,
      last_opened_at: nowIso,
    };
  }
  const secondaryWorkspaces = [];
  for (let w = 1; w <= tierConfig.secondaryWorkspaceCount; w += 1) {
    const secRoot = path.join(rootDir, 's9-workspaces', `ws-${String(w).padStart(2, '0')}`);
    fs.mkdirSync(secRoot, { recursive: true });
    const wid = computeChaosWorkDirKey(secRoot);
    existingWs.workspaces[wid] = {
      root: secRoot,
      name: `S9 Secondary Workspace ${String(w).padStart(2, '0')}`,
      created_at: nowIso,
      last_opened_at: new Date(BASE_TIME - w * 60_000).toISOString(),
    };
    secondaryWorkspaces.push({ id: wid, root: secRoot });
  }
  fs.writeFileSync(wsPath, JSON.stringify(existingWs, null, 2), 'utf8');

  // 3. Seed scale sessions (hardlinked wire.jsonl template for rapid 10k creation)
  const tplWirePath = path.join(rootDir, '_s9_session_wire_template.jsonl');
  const minimalWire = [
    JSON.stringify({ type: 'metadata', protocol_version: '1.6', created_at: BASE_TIME }),
    JSON.stringify({
      type: 'turn.prompt',
      turnId: 1,
      promptId: 'p-s9-tpl-1',
      input: [{ type: 'text', text: 'Synthetic S9 scale catalog entry.' }],
      origin: { kind: 'user' },
      time: BASE_TIME + 10,
    }),
    JSON.stringify({
      type: 'context.append_message',
      message: {
        id: 'm-s9-tpl-1',
        role: 'user',
        content: [{ type: 'text', text: 'Synthetic S9 scale catalog entry.' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
      time: BASE_TIME + 12,
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      event: { type: 'step.begin', turnId: '1', step: 1, uuid: 'step-s9-tpl-1' },
      time: BASE_TIME + 15,
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      event: {
        type: 'content.part',
        turnId: '1',
        stepUuid: 'step-s9-tpl-1',
        part: { type: 'text', text: 'Scale catalog session ready.' },
      },
      time: BASE_TIME + 20,
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      event: { type: 'step.end', turnId: '1', step: 1, uuid: 'step-s9-tpl-1' },
      time: BASE_TIME + 25,
    }),
    JSON.stringify({ type: 'turn.ended', turnId: 1, durationMs: 15, reason: 'completed', time: BASE_TIME + 30 }),
  ].join('\n');
  fs.writeFileSync(tplWirePath, `${minimalWire}\n`, 'utf8');

  const seededSessionIds = [];
  const churnTargetPaths = [];
  let hardlinked = 0;
  let copied = 0;

  const seedOneSession = (wsId, wsRoot, sid, title, ts, trackChurn) => {
    const sDir = path.join(homeDir, 'sessions', wsId, sid);
    const statePath = path.join(sDir, 'state.json');
    if (fs.existsSync(statePath)) {
      seededSessionIds.push(sid);
      if (trackChurn && churnTargetPaths.length < 32) churnTargetPaths.push({ sid, wsId, statePath });
      return;
    }
    const mainDir = path.join(sDir, 'agents', 'main');
    fs.mkdirSync(mainDir, { recursive: true });
    const mode = linkOrCopy(tplWirePath, path.join(mainDir, 'wire.jsonl'));
    if (mode === 'hardlinked') hardlinked += 1;
    else copied += 1;
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        id: sid,
        version: 2,
        title,
        titleKind: 'custom',
        createdAt: ts,
        updatedAt: ts + 30,
        archived: false,
        cwd: wsRoot,
        lastTurnReason: 'completed',
        agents: {
          main: { type: 'main', displayName: 'Main', model: 'twin-anthropic', createdAt: ts, contextTokens: 512 },
        },
      }),
      'utf8',
    );
    seededSessionIds.push(sid);
    if (trackChurn && churnTargetPaths.length < 32) churnTargetPaths.push({ sid, wsId, statePath });
  };

  let seq = 0;
  for (const sw of secondaryWorkspaces) {
    for (let j = 1; j <= tierConfig.sessionsPerSecondaryWorkspace; j += 1) {
      seq += 1;
      const sid = `s9_scale_${String(seq).padStart(5, '0')}`;
      seedOneSession(sw.id, sw.root, sid, `S9 Secondary Session #${seq}`, BASE_TIME - seq * 1_000, false);
    }
  }
  const remainingForPrimary = Math.max(0, tierConfig.sessionCount - seq);
  for (let i = 1; i <= remainingForPrimary; i += 1) {
    seq += 1;
    const sid = `s9_scale_${String(seq).padStart(5, '0')}`;
    seedOneSession(
      primaryWorkspaceId,
      workspaceDir,
      sid,
      `S9 Scale Session #${String(seq).padStart(5, '0')}`,
      BASE_TIME - seq * 500,
      i <= 32,
    );
  }
  fs.rmSync(tplWirePath, { force: true });

  // 4. Seed dedicated `chaos_s9_media` session with real valid `.ogg` Opus + `.mp4` + `.png` in ScopedMediaStore
  const mediaSessionId = 'chaos_s9_media';
  const mediaSessionDir = path.join(homeDir, 'sessions', primaryWorkspaceId, mediaSessionId);
  const mediaDir = path.join(mediaSessionDir, 'media');
  const metaDir = path.join(mediaDir, 'meta');
  const mediaMainDir = path.join(mediaSessionDir, 'agents', 'main');
  fs.rmSync(mediaSessionDir, { recursive: true, force: true });
  fs.mkdirSync(metaDir, { recursive: true });
  fs.mkdirSync(mediaMainDir, { recursive: true });

  const oggBuf = generateValidOggOpus(2_000);
  const mp4Buf = generateValidSyntheticMp4(192 * 1024);
  const pngBuf = generateSyntheticPng(480, 320, { deflateLevel: 1, smoothBands: true });

  const oggFileIds = [];
  const mp4FileIds = [];
  const pngFileIds = [];

  for (let i = 1; i <= tierConfig.mediaAudioCount; i += 1) {
    const fileId = `f_s9ogg_${String(i).padStart(4, '0')}`;
    fs.writeFileSync(path.join(mediaDir, `${fileId}.ogg`), oggBuf);
    writeMediaMeta(metaDir, fileId, '.ogg', `s9-voice-${i}.ogg`, 'audio/ogg');
    oggFileIds.push(fileId);
  }
  for (let i = 1; i <= tierConfig.mediaVideoCount; i += 1) {
    const fileId = `f_s9mp4_${String(i).padStart(4, '0')}`;
    fs.writeFileSync(path.join(mediaDir, `${fileId}.mp4`), mp4Buf);
    writeMediaMeta(metaDir, fileId, '.mp4', `s9-clip-${i}.mp4`, 'video/mp4');
    mp4FileIds.push(fileId);
  }
  for (let i = 1; i <= tierConfig.mediaImageCount; i += 1) {
    const fileId = `f_s9png_${String(i).padStart(4, '0')}`;
    fs.writeFileSync(path.join(mediaDir, `${fileId}.png`), pngBuf);
    writeMediaMeta(metaDir, fileId, '.png', `s9-frame-${i}.png`, 'image/png');
    pngFileIds.push(fileId);
  }

  const mediaWireLines = [JSON.stringify({ type: 'metadata', protocol_version: '1.6', created_at: BASE_TIME })];
  const mediaTurns = Math.max(oggFileIds.length, mp4FileIds.length);
  for (let t = 0; t < mediaTurns; t += 1) {
    const turnId = t + 1;
    const ts = BASE_TIME + turnId * 4_000;
    const turnKey = String(turnId);
    const stepUuid = `step-s9m-${turnId}-1`;
    const parts = [
      {
        type: 'text',
        text: `S9 Media Stability Turn #${turnId}: real Ogg/Opus audio, MP4 video, and PNG frame attached.`,
      },
    ];
    if (oggFileIds[t]) {
      parts.push({ type: 'audio_url', audioUrl: { url: `kimi-file://${oggFileIds[t]}`, name: `s9-voice-${turnId}.ogg` } });
    }
    if (mp4FileIds[t]) {
      parts.push({ type: 'video_url', videoUrl: { url: `kimi-file://${mp4FileIds[t]}`, name: `s9-clip-${turnId}.mp4` } });
    }
    if (pngFileIds[t]) {
      parts.push({ type: 'image_url', imageUrl: { url: `kimi-file://${pngFileIds[t]}`, name: `s9-frame-${turnId}.png` } });
    }
    mediaWireLines.push(
      JSON.stringify({
        type: 'turn.prompt',
        turnId,
        promptId: `prompt-s9m-${turnId}`,
        input: parts,
        origin: { kind: 'user' },
        time: ts,
      }),
      JSON.stringify({
        type: 'context.append_message',
        message: {
          id: `msg-s9m-user-${turnId}`,
          role: 'user',
          content: parts,
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
            text: `Verified S9 turn #${turnId} attachments (audio=${oggFileIds[t] ?? 'none'}, video=${mp4FileIds[t] ?? 'none'}).`,
          },
        },
        time: ts + 20,
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        event: { type: 'step.end', turnId: turnKey, step: 1, uuid: stepUuid },
        time: ts + 30,
      }),
      JSON.stringify({ type: 'turn.ended', turnId, durationMs: 35, reason: 'completed', time: ts + 40 }),
    );
  }
  fs.writeFileSync(path.join(mediaMainDir, 'wire.jsonl'), `${mediaWireLines.join('\n')}\n`, 'utf8');
  fs.writeFileSync(
    path.join(mediaSessionDir, 'state.json'),
    JSON.stringify({
      id: mediaSessionId,
      version: 2,
      title: 'S9 Fullstack Ogg/Opus & MP4 Media Session',
      titleKind: 'custom',
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME + 120_000,
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
          contextTokens: 8_192,
        },
      },
    }),
    'utf8',
  );

  return {
    rootDir,
    homeDir,
    workspaceDir,
    primaryWorkspaceId,
    secondaryWorkspaceCount: secondaryWorkspaces.length,
    personaIds,
    seededSessionCount: seededSessionIds.length,
    churnTargetPaths,
    mediaSessionId,
    oggFileIds,
    mp4FileIds,
    pngFileIds,
    oggBytes: oggBuf.byteLength,
    mp4Bytes: mp4Buf.byteLength,
    pngBytes: pngBuf.byteLength,
    wireLinkStats: { hardlinked, copied },
    elapsedMs: roundMs(performance.now() - startedAt),
  };
}

// ---------------------------------------------------------------------------
// In-Browser Frame-by-Frame Flight Recorder (Injected via addInitScript)
// ---------------------------------------------------------------------------
export function buildFlightRecorderInitScript() {
  return () => {
    try {
      localStorage.setItem('kiki.locale', 'en');
      localStorage.setItem('kiki.railMode', 'default');
      localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
    } catch {}

    const POPUP_SELECTOR = [
      '[data-select-panel]',
      '[data-execution-panel]',
      '[data-anchored-popover]',
      '[data-add-panel]',
      '[data-permission-panel]',
      '[data-run-mode-panel]',
      '[data-composer-ssh-panel]',
      '[data-composer-ssh-list]',
      '[data-composer-menu]',
      '[data-composer-notes-panel]',
      '[data-composer-queued-popover]',
      '[data-context-details]',
      '[data-send-timing-menu]',
      '[data-agent-family-popover]',
      '[data-file-link-menu]',
      '[data-composer-context-menu]',
      '[role="menu"]',
      '[role="listbox"]',
      '[role="dialog"]',
    ].join(', ');

    const ERROR_BOUNDARY_SELECTOR = [
      '[data-app-error-boundary]',
      'main > section[role="alert"] pre',
      '[data-settings-pane-error]',
    ].join(', ');

    const state = {
      frameCount: 0,
      frameDeltas: [],
      maxRafGapMs: 0,
      cls: 0,
      clsEntries: [],
      longTasks: [],
      phaseTransitions: [],
      phaseFlashToSettling: [],
      errorBoundaryMounts: [],
      transcriptRootRemounts: [],
      scrollHeightCollapses: [],
      unexpectedScrollSnapBacks: [],
      audioUnmounts: [],
      audioSkeletonFlashes: [],
      floatingOverlapBreaches: [],
      floatingRadiusBreaches: [],
      floatingScrollableBreaches: [],
      // Tracking state
      lastPath: window.location.pathname,
      lastPhase: null,
      settledSessionPaths: new Set(),
      scrollRootIds: new WeakMap(),
      nextScrollRootId: 1,
      activeScrollBySession: new Map(), // sessionBase -> { rootId, hadNonZeroHeight, prevScrollTop }
      snapBackWatch: { active: false, label: '', prevScrollTop: 0, rootId: null },
      audioNodes: new WeakMap(),
      nextAudioId: 1,
      trackedReadyAudios: new Map(), // audioId -> { el, src, containerEl, sessionBase }
      audioWatch: { active: false, sessionBase: null, baselineIds: new Set() },
      seenBoundarySignatures: new Set(),
      floatingSweepActive: false,
    };

    const getSessionBasePath = (pathname) => {
      const m = /^(\/s\/[^/]+)/u.exec(pathname || window.location.pathname);
      return m ? m[1] : null;
    };

    const isVisibleEl = (el) => {
      if (!el || !el.isConnected) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number.parseFloat(style.opacity) <= 0.01) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width >= 16 && rect.height >= 16;
    };

    const isFloatingSurface = (el) => {
      const style = getComputedStyle(el);
      if (style.position === 'fixed' || style.position === 'absolute') return true;
      if (
        el.hasAttribute('data-select-panel') ||
        el.hasAttribute('data-execution-panel') ||
        el.hasAttribute('data-anchored-popover') ||
        el.hasAttribute('data-add-panel') ||
        el.hasAttribute('data-permission-panel') ||
        el.hasAttribute('data-run-mode-panel') ||
        el.hasAttribute('data-composer-ssh-panel') ||
        el.hasAttribute('data-composer-ssh-list') ||
        el.hasAttribute('data-composer-menu') ||
        el.hasAttribute('data-composer-notes-panel') ||
        el.hasAttribute('data-composer-queued-popover') ||
        el.hasAttribute('data-context-details') ||
        el.hasAttribute('data-send-timing-menu') ||
        el.getAttribute('role') === 'dialog' ||
        el.getAttribute('role') === 'menu'
      ) {
        return true;
      }
      let cur = el.parentElement;
      for (let d = 0; d < 3 && cur; d += 1, cur = cur.parentElement) {
        const ps = getComputedStyle(cur);
        if (ps.position === 'fixed' || ps.position === 'absolute') return true;
      }
      return false;
    };

    const inspectFloatingPopups = () => {
      const raw = Array.from(document.querySelectorAll(POPUP_SELECTOR)).filter(
        (el) => isVisibleEl(el) && isFloatingSurface(el),
      );
      // Deduplicate nested roles (e.g., [role="listbox"] inside [data-permission-panel] or [role="dialog"])
      const roots = raw.filter((el) => !raw.some((other) => other !== el && other.contains(el)));
      const details = roots.map((el) => {
        const style = getComputedStyle(el);
        const radius = Number.parseFloat(style.borderTopLeftRadius) || 0;
        const rect = el.getBoundingClientRect();
        // Count distinct scrollable descendants (including self) that actually scroll OR declare nested overflow-y scroll
        const allNodes = [el, ...Array.from(el.querySelectorAll('*'))];
        const scrollableEls = [];
        for (const node of allNodes) {
          if (!isVisibleEl(node)) continue;
          const ns = getComputedStyle(node);
          if (ns.overflowY === 'auto' || ns.overflowY === 'scroll') {
            const nr = node.getBoundingClientRect();
            const overflows = node.scrollHeight > node.clientHeight + 2;
            if (nr.height >= 24 && overflows) {
              scrollableEls.push({
                tag: node.tagName.toLowerCase(),
                scrollHeight: node.scrollHeight,
                clientHeight: node.clientHeight,
              });
            }
          }
        }
        return {
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role'),
          attrs: Array.from(el.attributes)
            .map((a) => a.name)
            .filter((n) => n.startsWith('data-'))
            .slice(0, 6),
          borderTopLeftRadiusPx: Number(radius.toFixed(2)),
          scrollableCount: scrollableEls.length,
          scrollables: scrollableEls.slice(0, 4),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      });
      return { count: details.length, popups: details };
    };

    const sampleDomInvariants = (source) => {
      const now = Number(performance.now().toFixed(2));
      const pathNow = window.location.pathname;
      const sessionBase = getSessionBasePath(pathNow);
      const urlSid = sessionBase ? decodeURIComponent(sessionBase.slice(3)) : null;
      const composerSessionEl = document.querySelector('[data-composer-session]');
      const renderedSid = composerSessionEl ? composerSessionEl.getAttribute('data-composer-session') : null;
      const domMatchesUrlSession = urlSid !== null && (renderedSid === urlSid || renderedSid === null);
      state.lastPath = pathNow;

      // 1. ConversationShell data-phase tracking (only after DOM matches current URL session!)
      const shell = document.querySelector('.conversation-shell');
      const phase = shell ? shell.getAttribute('data-phase') : null;
      if (phase !== state.lastPhase) {
        state.phaseTransitions.push({ ts: now, path: pathNow, from: state.lastPhase, to: phase, source, renderedSid });
        if (
          phase === 'settling' &&
          sessionBase !== null &&
          domMatchesUrlSession &&
          state.settledSessionPaths.has(sessionBase) &&
          state.phaseFlashToSettling.length < 40
        ) {
          state.phaseFlashToSettling.push({ ts: now, path: pathNow, sessionBase, from: state.lastPhase, to: phase, source });
        }
        state.lastPhase = phase;
      }
      const scroller = document.querySelector('[data-transcript-scroll]');
      if (
        sessionBase !== null &&
        urlSid !== null &&
        renderedSid === urlSid &&
        phase === 'active' &&
        scroller &&
        scroller.querySelector('[data-transcript-virtual-item]') !== null
      ) {
        state.settledSessionPaths.add(sessionBase);
      }

      // 2. React ErrorBoundary detection
      const boundaryEl = document.querySelector(ERROR_BOUNDARY_SELECTOR);
      if (boundaryEl && isVisibleEl(boundaryEl)) {
        const sig = `${pathNow}:${(boundaryEl.textContent ?? '').trim().slice(0, 120)}`;
        if (!state.seenBoundarySignatures.has(sig) && state.errorBoundaryMounts.length < 25) {
          state.seenBoundarySignatures.add(sig);
          state.errorBoundaryMounts.push({ ts: now, path: pathNow, text: (boundaryEl.textContent ?? '').trim().slice(0, 300) });
        }
      }
      try {
        const lastFail = sessionStorage.getItem('kiki.lastRenderFailure');
        if (lastFail && !state.seenBoundarySignatures.has('sessionStorage:lastRenderFailure')) {
          state.seenBoundarySignatures.add('sessionStorage:lastRenderFailure');
          state.errorBoundaryMounts.push({ ts: now, path: pathNow, text: `sessionStorage.lastRenderFailure: ${lastFail.slice(0, 300)}` });
        }
      } catch {}

      // 3. Transcript scroll container mount identity, clientHeight === 0 collapse, & scrollTop -> 0 snap-back
      if (sessionBase !== null && urlSid !== null && renderedSid === urlSid && scroller) {
        let rootId = state.scrollRootIds.get(scroller);
        if (rootId === undefined) {
          rootId = state.nextScrollRootId++;
          state.scrollRootIds.set(scroller, rootId);
        }
        const prev = state.activeScrollBySession.get(sessionBase);
        if (prev && prev.rootId !== rootId && state.settledSessionPaths.has(sessionBase)) {
          if (state.transcriptRootRemounts.length < 40) {
            state.transcriptRootRemounts.push({
              ts: now,
              path: pathNow,
              sessionBase,
              previousRootId: prev.rootId,
              nextRootId: rootId,
              source,
            });
          }
        }
        const ch = scroller.clientHeight;
        const st = scroller.scrollTop;
        const hadNonZero = (prev?.hadNonZeroHeight ?? false) || ch > 0;
        if (ch === 0 && (hadNonZero || state.settledSessionPaths.has(sessionBase))) {
          if (state.scrollHeightCollapses.length < 40) {
            state.scrollHeightCollapses.push({ ts: now, path: pathNow, sessionBase, rootId, source });
          }
        }
        if (
          state.snapBackWatch.active &&
          state.snapBackWatch.rootId === rootId &&
          state.snapBackWatch.prevScrollTop > 120 &&
          st <= 2 &&
          scroller.scrollHeight > scroller.clientHeight + 200
        ) {
          if (state.unexpectedScrollSnapBacks.length < 40) {
            state.unexpectedScrollSnapBacks.push({
              ts: now,
              path: pathNow,
              label: state.snapBackWatch.label,
              fromScrollTop: state.snapBackWatch.prevScrollTop,
              toScrollTop: st,
              source,
            });
          }
        }
        if (state.snapBackWatch.active) {
          if (state.snapBackWatch.rootId === null) state.snapBackWatch.rootId = rootId;
          if (st > 2) state.snapBackWatch.prevScrollTop = st;
        }
        state.activeScrollBySession.set(sessionBase, { rootId, hadNonZeroHeight: hadNonZero, prevScrollTop: st });
      }

      // 4. Audio element stability inside transcript
      if (scroller && sessionBase !== null) {
        const audios = scroller.querySelectorAll('audio');
        for (const audio of audios) {
          const src = audio.getAttribute('src') || audio.currentSrc || '';
          if (!src) continue;
          let info = state.audioNodes.get(audio);
          if (!info) {
            info = {
              id: state.nextAudioId++,
              src,
              containerEl: audio.closest('[data-message-media="audio"]') || audio.parentElement,
              sessionBase,
            };
            state.audioNodes.set(audio, info);
            state.trackedReadyAudios.set(info.id, { el: audio, ...info });
          }
        }
      }
      if (state.audioWatch.active && sessionBase === state.audioWatch.sessionBase) {
        for (const aid of state.audioWatch.baselineIds) {
          const tracked = state.trackedReadyAudios.get(aid);
          if (!tracked) continue;
          if (!tracked.el.isConnected) {
            if (state.audioUnmounts.length < 40 && !state.audioUnmounts.some((u) => u.audioId === aid)) {
              state.audioUnmounts.push({ ts: now, path: pathNow, audioId: aid, src: tracked.src.slice(0, 160), source });
            }
          }
          const container = tracked.containerEl;
          if (container && container.isConnected) {
            const busySkeleton = container.querySelector('[aria-busy="true"]');
            if (busySkeleton && state.audioSkeletonFlashes.length < 40) {
              state.audioSkeletonFlashes.push({
                ts: now,
                path: pathNow,
                audioId: aid,
                src: tracked.src.slice(0, 160),
                source,
              });
            }
          }
        }
      }

      // 5. Continuous floating surface overlap check on rAF
      if (source === 'raf') {
        const snap = inspectFloatingPopups();
        if (snap.count > 1 && state.floatingOverlapBreaches.length < 30) {
          state.floatingOverlapBreaches.push({ ts: now, path: pathNow, count: snap.count, popups: snap.popups });
        }
      }
    };

    try {
      const lsObs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput && typeof entry.value === 'number') {
            state.cls += entry.value;
            if (state.clsEntries.length < 50 && entry.value > 0.001) {
              state.clsEntries.push({ ts: Number(entry.startTime.toFixed(1)), value: Number(entry.value.toFixed(4)) });
            }
          }
        }
      });
      lsObs.observe({ type: 'layout-shift', buffered: true });
    } catch {}

    try {
      const ltObs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longTasks.push({ ts: Number(entry.startTime.toFixed(1)), duration: Number(entry.duration.toFixed(2)) });
        }
      });
      ltObs.observe({ type: 'longtask', buffered: true });
    } catch {}

    const mo = new MutationObserver(() => {
      sampleDomInvariants('mutation');
    });
    const attachObserver = () => {
      if (document.documentElement) {
        mo.observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['data-phase', 'aria-busy', 'src', 'hidden'],
        });
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', attachObserver, { once: true });
    } else {
      attachObserver();
    }

    let prevRaf = performance.now();
    const onRaf = (now) => {
      const delta = now - prevRaf;
      prevRaf = now;
      state.frameCount += 1;
      if (delta > 0 && delta < 10_000) {
        if (state.frameDeltas.length < 6000) state.frameDeltas.push(delta);
        if (delta > state.maxRafGapMs) state.maxRafGapMs = delta;
      }
      sampleDomInvariants('raf');
      requestAnimationFrame(onRaf);
    };
    requestAnimationFrame(onRaf);

    window.__s9FlightRecorder = {
      armSnapBackWatch(label) {
        const scroller = document.querySelector('[data-transcript-scroll]');
        const rootId = scroller ? (state.scrollRootIds.get(scroller) ?? null) : null;
        state.snapBackWatch = {
          active: true,
          label: String(label ?? ''),
          prevScrollTop: scroller ? scroller.scrollTop : 0,
          rootId,
        };
      },
      disarmSnapBackWatch() {
        state.snapBackWatch.active = false;
      },
      armAudioWatch() {
        sampleDomInvariants('arm-audio');
        const sessionBase = getSessionBasePath(window.location.pathname);
        const baselineIds = new Set();
        for (const [id, item] of state.trackedReadyAudios.entries()) {
          if (item.sessionBase === sessionBase && item.el.isConnected) {
            baselineIds.add(id);
          }
        }
        state.audioWatch = { active: true, sessionBase, baselineIds };
        return { armedCount: baselineIds.size, sessionBase };
      },
      disarmAudioWatch() {
        state.audioWatch.active = false;
      },
      inspectFloatingPopups() {
        const snap = inspectFloatingPopups();
        const now = Number(performance.now().toFixed(2));
        const pathNow = window.location.pathname;
        if (snap.count > 1 && state.floatingOverlapBreaches.length < 30) {
          state.floatingOverlapBreaches.push({ ts: now, path: pathNow, count: snap.count, popups: snap.popups });
        }
        for (const p of snap.popups) {
          if (p.borderTopLeftRadiusPx < 8 && state.floatingRadiusBreaches.length < 30) {
            state.floatingRadiusBreaches.push({ ts: now, path: pathNow, popup: p });
          }
          if (p.scrollableCount > 1 && state.floatingScrollableBreaches.length < 30) {
            state.floatingScrollableBreaches.push({ ts: now, path: pathNow, popup: p });
          }
        }
        return snap;
      },
      getSummary() {
        const fpsSamples = state.frameDeltas.filter((d) => d >= 1).map((d) => Math.min(120, 1000 / d));
        const sortedFps = [...fpsSamples].sort((a, b) => a - b);
        const meanFps = sortedFps.length
          ? Number((sortedFps.reduce((a, b) => a + b, 0) / sortedFps.length).toFixed(2))
          : 0;
        const p5Fps = sortedFps.length
          ? Number(sortedFps[Math.max(0, Math.floor(sortedFps.length * 0.05))].toFixed(2))
          : 0;
        const durations = state.longTasks.map((t) => t.duration);
        return {
          frameCount: state.frameCount,
          fps: { mean: meanFps, p5: p5Fps, maxRafGapMs: Number(state.maxRafGapMs.toFixed(2)) },
          cls: Number(state.cls.toFixed(4)),
          clsEntryCount: state.clsEntries.length,
          longTasks: {
            count: durations.length,
            maxMs: durations.length ? Number(Math.max(...durations).toFixed(2)) : 0,
            totalBlockingTimeMs: Number(durations.reduce((a, d) => a + Math.max(0, d - 50), 0).toFixed(2)),
          },
          phaseTransitionsCount: state.phaseTransitions.length,
          phaseTransitionsSample: state.phaseTransitions.slice(0, 30),
          breaches: {
            phaseFlashToSettling: state.phaseFlashToSettling,
            errorBoundaryMounts: state.errorBoundaryMounts,
            transcriptRootRemounts: state.transcriptRootRemounts,
            scrollHeightCollapses: state.scrollHeightCollapses,
            unexpectedScrollSnapBacks: state.unexpectedScrollSnapBacks,
            audioUnmounts: state.audioUnmounts,
            audioSkeletonFlashes: state.audioSkeletonFlashes,
            floatingOverlapBreaches: state.floatingOverlapBreaches,
            floatingRadiusBreaches: state.floatingRadiusBreaches,
            floatingScrollableBreaches: state.floatingScrollableBreaches,
          },
        };
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Verdict Evaluator (Exported for Deterministic Unit Tests + Runtime Gating)
// ---------------------------------------------------------------------------
export function evaluateS9Verdict({ flightRecorder, pageErrors, http5xxResponses, drill1, drill2, drill3, serverHealth, tierConfig }) {
  const breaches = [];
  const fb = flightRecorder?.breaches ?? {};

  if ((pageErrors?.length ?? 0) > 0) {
    breaches.push(`pageErrors=${pageErrors.length}`);
  }
  if ((http5xxResponses?.length ?? 0) > 0) {
    breaches.push(`http5xxResponses=${http5xxResponses.length}`);
  }
  if ((fb.errorBoundaryMounts?.length ?? 0) > 0) {
    breaches.push(`errorBoundaryMounts=${fb.errorBoundaryMounts.length}`);
  }
  if ((fb.phaseFlashToSettling?.length ?? 0) > 0) {
    breaches.push(`phaseFlashToSettling=${fb.phaseFlashToSettling.length}`);
  }
  if ((fb.transcriptRootRemounts?.length ?? 0) > 0) {
    breaches.push(`transcriptRootRemounts=${fb.transcriptRootRemounts.length}`);
  }
  if ((fb.scrollHeightCollapses?.length ?? 0) > 0) {
    breaches.push(`scrollHeightCollapses=${fb.scrollHeightCollapses.length}`);
  }
  if ((fb.unexpectedScrollSnapBacks?.length ?? 0) > 0) {
    breaches.push(`unexpectedScrollSnapBacks=${fb.unexpectedScrollSnapBacks.length}`);
  }
  if ((fb.audioUnmounts?.length ?? 0) > 0) {
    breaches.push(`audioUnmounts=${fb.audioUnmounts.length}`);
  }
  if ((fb.audioSkeletonFlashes?.length ?? 0) > 0) {
    breaches.push(`audioSkeletonFlashes=${fb.audioSkeletonFlashes.length}`);
  }
  if ((fb.floatingOverlapBreaches?.length ?? 0) > 0) {
    breaches.push(`floatingPopupOverlap=${fb.floatingOverlapBreaches.length}`);
  }
  if ((fb.floatingRadiusBreaches?.length ?? 0) > 0) {
    breaches.push(`floatingPopupRadiusLt8px=${fb.floatingRadiusBreaches.length}`);
  }
  if ((fb.floatingScrollableBreaches?.length ?? 0) > 0) {
    breaches.push(`floatingPopupNestedScrollables=${fb.floatingScrollableBreaches.length}`);
  }

  // Drill 1 assertions
  if (!drill1 || drill1.error) {
    breaches.push(`drill1.error=${drill1?.error ?? 'missing'}`);
  } else {
    const requiredRounds = tierConfig?.sendRounds ?? 10;
    if ((drill1.roundsSucceeded ?? 0) < requiredRounds) {
      breaches.push(`drill1.roundsSucceeded=${drill1.roundsSucceeded ?? 0} < ${requiredRounds}`);
    }
    if (drill1.composerUsableAfterAllRounds !== true) {
      breaches.push('drill1.composerNotUsableWithoutReload');
    }
    if ((drill1.composerPopupSweep?.triggersClicked ?? 0) < 3) {
      breaches.push(`drill1.composerPopupSweep.triggersClicked=${drill1.composerPopupSweep?.triggersClicked ?? 0} < 3`);
    }
    if ((drill1.composerPopupSweep?.breachCount ?? 0) > 0) {
      breaches.push(`drill1.composerPopupSweep.breachCount=${drill1.composerPopupSweep.breachCount}`);
    }
  }

  // Drill 2 assertions
  if (!drill2 || drill2.error) {
    breaches.push(`drill2.error=${drill2?.error ?? 'missing'}`);
  } else {
    const maxRangeMs = tierConfig?.mediaRangeMaxMs ?? 250;
    if (drill2.oggRangeProbe?.status !== 206) {
      breaches.push(`drill2.oggRangeProbe.status=${drill2.oggRangeProbe?.status ?? null} != 206`);
    }
    if ((drill2.oggRangeProbe?.rangeLatencyMs ?? 99999) >= maxRangeMs) {
      breaches.push(`drill2.oggRangeProbe.rangeLatencyMs=${drill2.oggRangeProbe?.rangeLatencyMs} >= ${maxRangeMs}`);
    }
    if (drill2.mp4RangeProbe?.status !== 206) {
      breaches.push(`drill2.mp4RangeProbe.status=${drill2.mp4RangeProbe?.status ?? null} != 206`);
    }
    if ((drill2.mp4RangeProbe?.rangeLatencyMs ?? 99999) >= maxRangeMs) {
      breaches.push(`drill2.mp4RangeProbe.rangeLatencyMs=${drill2.mp4RangeProbe?.rangeLatencyMs} >= ${maxRangeMs}`);
    }
    if ((drill2.mountedAudioCount ?? 0) < 1) {
      breaches.push('drill2.noMountedAudioElements');
    }
    if (drill2.attachmentPreviewOpened !== true) {
      breaches.push('drill2.attachmentPreviewDidNotOpen');
    }
    if ((drill2.redundantMediaPlaybackRemints?.length ?? 0) > 0) {
      breaches.push(`drill2.redundantMediaPlaybackRemints=${drill2.redundantMediaPlaybackRemints.length}`);
    }
  }

  // Drill 3 assertions
  if (!drill3 || drill3.error) {
    breaches.push(`drill3.error=${drill3?.error ?? 'missing'}`);
  } else {
    const maxGap = tierConfig?.sidebarMaxBlankGapPx ?? 24;
    if (drill3.sidebar?.virtualized !== true) {
      breaches.push('drill3.sidebar.notVirtualized');
    }
    if (drill3.sidebar?.personasToggleFound !== true) {
      breaches.push('drill3.sidebar.personasToggleNotFound');
    }
    if ((drill3.sidebar?.maxBlankGapPx ?? 99999) > maxGap) {
      breaches.push(`drill3.sidebar.maxBlankGapPx=${drill3.sidebar?.maxBlankGapPx} > ${maxGap}`);
    }
    if (drill3.quickSwitcher?.opened !== true) {
      breaches.push('drill3.quickSwitcher.notOpened');
    }
    if (drill3.quickSwitcher?.highlightedMounted !== true) {
      breaches.push('drill3.quickSwitcher.highlightedItemNotMounted');
    }
    if (drill3.quickSwitcher?.highlightedInViewport !== true) {
      breaches.push('drill3.quickSwitcher.highlightedItemOutOfViewport');
    }
    if (drill3.rightRail10k?.foundColdNeedleA !== true) {
      breaches.push('drill3.rightRail10k.coldNeedleNotFound');
    }
  }

  // Server health assertions
  if ((serverHealth?.unhandledRejections ?? 0) > 0) {
    breaches.push(`server.unhandledRejections=${serverHealth.unhandledRejections}`);
  }
  if ((serverHealth?.uncaughtExceptions ?? 0) > 0) {
    breaches.push(`server.uncaughtExceptions=${serverHealth.uncaughtExceptions}`);
  }

  return { passed: breaches.length === 0, breaches };
}

// ---------------------------------------------------------------------------
// Helper Functions for Live Server + Browser Drills
// ---------------------------------------------------------------------------
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
  } catch (err) {
    return {
      status: 0,
      elapsedMs: roundMs(performance.now() - t0),
      json: null,
      rawText: String(err?.message ?? err).slice(0, 200),
      networkError: err?.name === 'AbortError' ? 'timeout' : String(err?.code ?? err?.message ?? 'fetch_error'),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function startGuiStaticServer() {
  const { ensureGuiStaticBuild } = await import('../perf/browser-runner.mjs');
  const build = ensureGuiStaticBuild(path.join(REPO_ROOT, '.tmp', 'chaos-gui-dist'));
  const staticServer = createHttpServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    if (urlPath === '/__kiki/local-server') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    let file = path.normalize(path.join(build.distDir, urlPath));
    if (!file.startsWith(build.distDir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(build.distDir, 'index.html');
    }
    const stream = fs.createReadStream(file);
    stream.once('open', () => {
      res.writeHead(200, { 'content-type': GUI_MIME[path.extname(file)] ?? 'application/octet-stream' });
      stream.pipe(res);
    });
    stream.once('error', () => {
      if (!res.headersSent) res.writeHead(404);
      res.end('not found');
    });
  });
  await new Promise((resolve) => staticServer.listen(0, '127.0.0.1', resolve));
  const webUrl = `http://127.0.0.1:${staticServer.address().port}`;
  return {
    webUrl,
    buildMs: build.buildMs,
    reusedCache: build.reusedCache,
    close: () => new Promise((resolve) => staticServer.close(() => resolve())),
  };
}

async function waitForSessionIdle(endpoint, token, sessionId, timeoutMs = 25_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const st = await apiJsonRaw(endpoint, token, 'GET', `/api/sessions/${encodeURIComponent(sessionId)}/status`, undefined, 10_000);
    const data = st.json?.data ?? null;
    if (st.status === 200 && data) {
      const busy =
        data.busy === true ||
        data.executing === true ||
        data.main_turn_active === true ||
        data.state === 'running' ||
        data.loop?.status === 'running';
      if (!busy) return true;
    }
    await sleep(60);
  }
  return false;
}

function startSessionIndexChurnWorker(churnTargets, intervalMs = 200) {
  let stopped = false;
  let ticks = 0;
  let mutations = 0;
  const timer = setInterval(() => {
    if (stopped || churnTargets.length === 0) return;
    ticks += 1;
    const target = churnTargets[ticks % churnTargets.length];
    try {
      const raw = fs.readFileSync(target.statePath, 'utf8');
      const parsed = JSON.parse(raw);
      parsed.updatedAt = Date.now();
      parsed.title = `S9 Scale Session ${target.sid} (churn #${ticks})`;
      fs.writeFileSync(target.statePath, JSON.stringify(parsed), 'utf8');
      mutations += 1;
    } catch {}
  }, intervalMs);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      return { ticks, mutations };
    },
    stats() {
      return { ticks, mutations };
    },
  };
}

async function probeMediaPlaybackAndRange(endpoint, token, sessionId, fileId) {
  const mintT0 = performance.now();
  const mintRes = await apiJsonRaw(
    endpoint,
    token,
    'POST',
    `/api/sessions/${encodeURIComponent(sessionId)}/media-playback`,
    { file_id: fileId },
    15_000,
  );
  const mintLatencyMs = roundMs(performance.now() - mintT0);
  if (mintRes.status !== 200 || mintRes.json?.code !== 0 || !mintRes.json?.data?.preview_id) {
    return {
      fileId,
      mintStatus: mintRes.status,
      mintCode: mintRes.json?.code ?? null,
      mintLatencyMs,
      status: mintRes.status,
      rangeLatencyMs: mintLatencyMs,
      error: mintRes.json?.msg ?? mintRes.rawText,
    };
  }
  const previewId = mintRes.json.data.preview_id;
  const rangeT0 = performance.now();
  let status = 0;
  let contentType = null;
  let contentRange = null;
  let bytes = 0;
  let error = null;
  try {
    const res = await fetch(`${endpoint}/media-preview/${previewId}`, {
      headers: { range: 'bytes=0-65535' },
    });
    status = res.status;
    contentType = res.headers.get('content-type');
    contentRange = res.headers.get('content-range');
    const buf = Buffer.from(await res.arrayBuffer());
    bytes = buf.byteLength;
  } catch (err) {
    error = String(err?.message ?? err).slice(0, 200);
  }
  const rangeLatencyMs = roundMs(performance.now() - rangeT0);
  await apiJsonRaw(endpoint, token, 'DELETE', `/api/sessions/media-playback/${previewId}`, undefined, 5_000).catch(
    () => undefined,
  );
  return {
    fileId,
    previewId,
    mintStatus: mintRes.status,
    mintLatencyMs,
    status,
    rangeLatencyMs,
    totalMs: roundMs(mintLatencyMs + rangeLatencyMs),
    contentType,
    contentRange,
    bytes,
    error,
  };
}

async function readCdpMetrics(cdp) {
  try {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const map = Object.fromEntries(metrics.map((m) => [m.name, m.value]));
    return {
      jsHeapUsedMiB: roundMiB(map.JSHeapUsedSize ?? 0),
      jsHeapTotalMiB: roundMiB(map.JSHeapTotalSize ?? 0),
      domNodes: map.Nodes ?? 0,
      jsEventListeners: map.JSEventListeners ?? 0,
      layoutCount: map.LayoutCount ?? 0,
      recalcStyleCount: map.RecalcStyleCount ?? 0,
    };
  } catch (err) {
    return { error: String(err?.message ?? err).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// Main Scenario S9 Entrypoint
// ---------------------------------------------------------------------------
export async function runScenarioS9BrowserFlightRecorder({
  server,
  corpus,
  tenKCorpus,
  s9Corpus,
  tier = 'full',
  tierOverrides = {},
  progress = (msg) => process.stderr.write(`[ccp-chaos] ${msg}\n`),
}) {
  const startedAt = performance.now();
  const tierConfig = resolveS9TierConfig(tier, tierOverrides);
  progress(
    `S9 (tier=${tierConfig.tier}): Full-Stack Browser Flight Recorder (giant=${corpus.giantMainWireGiB} GiB, sessions=${s9Corpus.seededSessionCount}, subagents=${tenKCorpus?.subagentCount ?? corpus.subagentCount}, personas=${s9Corpus.personaIds.length})...`,
  );

  await server.resetWindow();
  await server.startHeapSampling();
  const preSrv = await server.metrics(true);

  const kapRequire = createRequire(path.join(REPO_ROOT, 'packages', 'kap-server', 'package.json'));
  const { chromium } = kapRequire('playwright');

  const pageErrors = [];
  const consoleErrors = [];
  const http5xxResponses = [];
  const mediaPlaybackGrantsByKey = new Map(); // `${sessionId}:${fileId}` -> { count, previewIds, activeCount, timestamps }
  const redundantMediaPlaybackRemints = [];
  let trackRedundantMediaRemints = false;

  let staticSrv = null;
  let browser = null;
  const churnWorker = startSessionIndexChurnWorker(s9Corpus.churnTargetPaths, tierConfig.churnIntervalMs);

  let drill1 = null;
  let drill2 = null;
  let drill3 = null;
  let flightRecorder = null;
  let cdpFinal = null;
  let guiBuildInfo = null;
  let fatalError = null;

  try {
    staticSrv = await startGuiStaticServer();
    guiBuildInfo = { buildMs: staticSrv.buildMs, reusedCache: staticSrv.reusedCache };
    progress(`S9: Real kiki-gui bundle ready (reusedCache=${staticSrv.reusedCache}, buildMs=${staticSrv.buildMs}ms)`);

    const deepLink = (routePath) =>
      `${staticSrv.webUrl}${routePath}?server=${encodeURIComponent(server.endpoint)}&token=${encodeURIComponent(server.token)}`;

    // Launch real Chromium cleanly on both Ubuntu Colab VMs (--no-sandbox --disable-dev-shm-usage) and local desktops
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'],
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    await context.addInitScript(buildFlightRecorderInitScript());

    const page = await context.newPage();
    page.on('pageerror', (err) => {
      if (pageErrors.length < 40) pageErrors.push(String(err?.message ?? err).slice(0, 400));
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error' && consoleErrors.length < 40) {
        consoleErrors.push(msg.text().slice(0, 300));
      }
    });
    page.on('response', async (res) => {
      const url = res.url();
      if (!url.startsWith(server.endpoint)) return;
      const u = new URL(url);
      if (res.status() >= 500 && (u.pathname.startsWith('/api/') || u.pathname.startsWith('/media-preview/'))) {
        if (http5xxResponses.length < 40) {
          http5xxResponses.push({
            method: res.request().method(),
            path: u.pathname,
            status: res.status(),
          });
        }
      }
      // Track browser-initiated POST /api/sessions/:id/media-playback mints & redundant re-mints
      const mintMatch = /^\/api\/sessions\/([^/]+)\/media-playback$/u.exec(u.pathname);
      if (mintMatch && res.request().method() === 'POST') {
        const sid = decodeURIComponent(mintMatch[1]);
        let fileId = 'unknown';
        try {
          const reqBody = JSON.parse(res.request().postData() ?? '{}');
          if (reqBody?.file_id) fileId = reqBody.file_id;
        } catch {}
        const key = `${sid}:${fileId}`;
        const prev = mediaPlaybackGrantsByKey.get(key) ?? { count: 0, activeCount: 0, previewIds: [] };
        prev.count += 1;
        prev.activeCount += 1;
        mediaPlaybackGrantsByKey.set(key, prev);
        if (trackRedundantMediaRemints && prev.count > 1) {
          redundantMediaPlaybackRemints.push({
            sessionId: sid,
            fileId,
            mintCount: prev.count,
            status: res.status(),
          });
        }
      }
      const delMatch = /^\/api\/sessions\/media-playback\/([^/]+)$/u.exec(u.pathname);
      if (delMatch && res.request().method() === 'DELETE') {
        for (const entry of mediaPlaybackGrantsByKey.values()) {
          if (entry.activeCount > 0) entry.activeCount -= 1;
        }
      }
    });

    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');

    const spaNavigate = async (routePath) => {
      await page.evaluate((targetPath) => {
        const search = window.location.search;
        window.history.pushState({}, '', `${targetPath}${search}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, routePath);
    };

    const typeAndSubmitComposer = async (text, { submitMode = 'enter' } = {}) => {
      const input = page.locator('[data-composer-input]').first();
      await input.waitFor({ state: 'visible', timeout: 15_000 });
      await input.click({ timeout: 5_000 });
      await page.keyboard.insertText(text);
      await page.locator('[data-send-ready]').first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
      await sleep(50);
      if (submitMode === 'send-now') {
        const caret = page.locator('[data-send-timing-caret]').first();
        if (await caret.isVisible().catch(() => false)) {
          await caret.click({ timeout: 3_000 }).catch(() => undefined);
          await sleep(100);
          const nowItem = page.locator('[data-send-timing-menu] [role="menuitem"]').filter({ hasText: /Send now|立即发送/iu }).first();
          if (await nowItem.isVisible().catch(() => false)) {
            await nowItem.click({ timeout: 3_000 });
            return 'send-now';
          }
          await page.keyboard.press('Escape').catch(() => undefined);
        }
      }
      await page.keyboard.press('Enter');
      return 'enter';
    };

    // =========================================================================
    // DRILL 1: Send & Steer Stability (10+ rounds across /new -> /s/:id and mega-session)
    //          + Composer Floating Surface Invariant Sweep
    // =========================================================================
    progress(`S9 Drill 1/3: ${tierConfig.sendRounds} consecutive Send & Steer rounds (/new -> /s/:id + mega-session) + Composer popup sweep...`);
    drill1 = {
      roundsAttempted: 0,
      roundsSucceeded: 0,
      newSessionId: null,
      megaSessionId: corpus.giantSessionId,
      roundLatenciesMs: [],
      steerWhileBusyVerified: false,
      upwardScrollSnapBackCheck: null,
      composerUsableAfterAllRounds: false,
      composerPopupSweep: null,
      error: null,
    };

    try {
      await page.goto(deepLink('/new'), { waitUntil: 'domcontentloaded', timeout: tierConfig.stepTimeoutMs });
      await page.waitForSelector('[data-composer-input]', { timeout: 25_000 });
      await sleep(300);

      // Rounds 1..5: /new -> /s/:id + consecutive rounds + busy steer/queue round
      let activeNewSid = null;
      for (let round = 1; round <= 5; round += 1) {
        drill1.roundsAttempted += 1;
        const rT0 = performance.now();
        if (round === 4) {
          // Busy steer / queue round: kick off slow stream, then immediately send follow-up while busy
          await page.evaluate(() => window.__s9FlightRecorder?.armSnapBackWatch?.('drill1-new-steer'));
          await typeAndSubmitComposer(
            `[CHAOS_SCOPE:s9_d1_r4_${Date.now()}] [CHAOS:STREAM_HOLD:${tierConfig.streamHoldDrill1Ms}] S9 Round 4 slow stream for busy steer.`,
          );
          await page.waitForSelector('[data-composer-working], [data-send-timing-caret], button[aria-label*="Stop"]', { timeout: 10_000 }).catch(() => undefined);
          await sleep(180);
          const modeUsed = await typeAndSubmitComposer(
            `[CHAOS_SCOPE:s9_d1_r4b_${Date.now()}] S9 Round 4b follow-up while busy.`,
            { submitMode: 'send-now' },
          );
          drill1.steerWhileBusyVerified = true;
          drill1.steerModeUsed = modeUsed;
          if (activeNewSid) {
            await waitForSessionIdle(server.endpoint, server.token, activeNewSid, 25_000);
          }
          await sleep(250);
          await page.evaluate(() => window.__s9FlightRecorder?.disarmSnapBackWatch?.());
          drill1.roundsSucceeded += 1;
          drill1.roundLatenciesMs.push(roundMs(performance.now() - rT0));
          continue;
        }

        if (round > 1) {
          await page.evaluate((r) => window.__s9FlightRecorder?.armSnapBackWatch?.(`drill1-new-r${r}`), round);
        }
        await typeAndSubmitComposer(`[CHAOS_SCOPE:s9_d1_r${round}_${Date.now()}] S9 Drill 1 round ${round} stability message.`);
        if (round === 1) {
          await page.waitForURL(/\/s\/[^/?]+/u, { timeout: 20_000 });
          const m = /\/s\/([^/?]+)/u.exec(new URL(page.url()).pathname);
          activeNewSid = m ? decodeURIComponent(m[1]) : null;
          drill1.newSessionId = activeNewSid;
          await page.waitForSelector('[data-transcript-scroll] [data-transcript-virtual-item]', { timeout: 20_000 });
        }
        if (activeNewSid) {
          const settled = await waitForSessionIdle(server.endpoint, server.token, activeNewSid, 20_000);
          if (!settled) throw new Error(`Drill 1 round ${round} timed out waiting for session idle`);
        }
        await sleep(180);
        await page.evaluate(() => window.__s9FlightRecorder?.disarmSnapBackWatch?.());
        drill1.roundsSucceeded += 1;
        drill1.roundLatenciesMs.push(roundMs(performance.now() - rT0));
      }

      // Rounds 6..10: Mega-session (chaos_giant_3g)
      await spaNavigate(`/s/${corpus.giantSessionId}`);
      await page.waitForSelector('[data-transcript-scroll] [data-transcript-virtual-item]', { timeout: tierConfig.stepTimeoutMs });
      await page.waitForFunction(
        () => document.querySelector('.conversation-shell')?.getAttribute('data-phase') === 'active',
        null,
        { timeout: 15_000 },
      ).catch(() => undefined);
      await sleep(300);

      for (let round = 6; round <= tierConfig.sendRounds; round += 1) {
        drill1.roundsAttempted += 1;
        const rT0 = performance.now();
        await page.evaluate((r) => window.__s9FlightRecorder?.armSnapBackWatch?.(`drill1-mega-r${r}`), round);
        if (round === tierConfig.sendRounds) {
          await typeAndSubmitComposer(
            `[CHAOS_SCOPE:s9_d1_mega_r${round}_${Date.now()}] [CHAOS:STREAM_HOLD:${tierConfig.streamHoldDrill1Ms}] S9 Mega-session busy stream round ${round}.`,
          );
          await sleep(220);
          await typeAndSubmitComposer(
            `[CHAOS_SCOPE:s9_d1_mega_r${round}b_${Date.now()}] S9 Mega-session queued follow-up round ${round}b.`,
            { submitMode: 'enter' },
          );
        } else {
          await typeAndSubmitComposer(`[CHAOS_SCOPE:s9_d1_mega_r${round}_${Date.now()}] S9 Mega-session send round ${round}.`);
        }
        const settled = await waitForSessionIdle(server.endpoint, server.token, corpus.giantSessionId, 25_000);
        if (!settled) throw new Error(`Drill 1 mega-session round ${round} timed out waiting for idle`);
        await sleep(180);
        await page.evaluate(() => window.__s9FlightRecorder?.disarmSnapBackWatch?.());
        drill1.roundsSucceeded += 1;
        drill1.roundLatenciesMs.push(roundMs(performance.now() - rT0));
      }

      // Verify upward scroll does not snap back to 0 on mega-session
      await page.evaluate(() => window.__s9FlightRecorder?.armSnapBackWatch?.('drill1-upward-scroll'));
      const scrollCheck = await page.evaluate(async () => {
        const scroller = document.querySelector('[data-transcript-scroll]');
        if (!scroller) return { ok: false, reason: 'no_scroller' };
        const maxScroll = scroller.scrollHeight - scroller.clientHeight;
        if (maxScroll < 300) return { ok: true, skipped: true, maxScroll };
        const target = Math.floor(maxScroll * 0.4);
        scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
        scroller.scrollTop = target;
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 500));
        return { ok: scroller.scrollTop > 40, target, settledScrollTop: Math.round(scroller.scrollTop) };
      });
      await page.evaluate(() => window.__s9FlightRecorder?.disarmSnapBackWatch?.());
      drill1.upwardScrollSnapBackCheck = scrollCheck;

      // Verify composer is still usable without reload
      const composerEditable = await page.evaluate(() => {
        const el = document.querySelector('[data-composer-input]');
        return Boolean(
          el &&
            el.isConnected &&
            el.getAttribute('aria-disabled') !== 'true' &&
            (el.getAttribute('contenteditable') === 'true' || el.tagName === 'TEXTAREA'),
        );
      });
      drill1.composerUsableAfterAllRounds = composerEditable;

      // Sequential Composer Floating Surface Sweep: Profile -> Execution/Model -> + -> SSH -> Permission
      const sweepSteps = [];
      let sweepBreaches = 0;
      const triggerSpecs = [
        { name: 'Profile', selector: '[data-status-segment="profile"] button' },
        { name: 'Execution/Model', selector: '[data-status-segment="execution"] button' },
        { name: 'Add(+)', selector: '[data-add-menu-trigger]' },
        { name: 'SSH', selector: '[data-composer-ssh-toggle], [data-add-menu-ssh]' },
        { name: 'Permission', selector: '[data-status-segment="permission"] button' },
      ];
      for (const spec of triggerSpecs) {
        const loc = page.locator(spec.selector).first();
        const visible = await loc.isVisible().catch(() => false);
        if (!visible) {
          sweepSteps.push({ trigger: spec.name, clicked: false, reason: 'not_visible' });
          continue;
        }
        await loc.click({ timeout: 5_000 }).catch(() => undefined);
        await sleep(160);
        const snap = await page.evaluate(() => window.__s9FlightRecorder?.inspectFloatingPopups?.() ?? { count: 0, popups: [] });
        const stepOverlap = snap.count > 1;
        const stepBadRadius = snap.popups.some((p) => p.borderTopLeftRadiusPx < 8);
        const stepNestedScroll = snap.popups.some((p) => p.scrollableCount > 1);
        if (stepOverlap || stepBadRadius || stepNestedScroll) sweepBreaches += 1;
        sweepSteps.push({
          trigger: spec.name,
          clicked: true,
          visiblePopupCount: snap.count,
          popups: snap.popups,
          overlap: stepOverlap,
          badRadius: stepBadRadius,
          nestedScrollables: stepNestedScroll,
        });
      }
      await page.keyboard.press('Escape').catch(() => undefined);
      await sleep(100);
      await page.keyboard.press('Escape').catch(() => undefined);
      drill1.composerPopupSweep = {
        triggersClicked: sweepSteps.filter((s) => s.clicked).length,
        breachCount: sweepBreaches,
        steps: sweepSteps,
      };
    } catch (err) {
      drill1.error = String(err?.stack ?? err).slice(0, 600);
    }

    // =========================================================================
    // DRILL 2: Audio & Media Playback Under Concurrent Active Turn + Index Churn
    // =========================================================================
    progress('S9 Drill 2/3: Audio (.ogg Opus) & Video (.mp4) playback + AttachmentTabView under concurrent streaming turn + SessionIndex churn...');
    drill2 = {
      mediaSessionId: s9Corpus.mediaSessionId,
      concurrentTurnSubmitted: false,
      mountedAudioCount: 0,
      audioReadyUrls: [],
      oggRangeProbe: null,
      mp4RangeProbe: null,
      audioWatchArmedCount: 0,
      attachmentPreviewOpened: false,
      redundantMediaPlaybackRemints: [],
      error: null,
    };

    try {
      // Kick off multi-second active LLM streaming turn on the media session (runs concurrently!)
      const slowPromptRes = await apiJsonRaw(
        server.endpoint,
        server.token,
        'POST',
        `/api/sessions/${encodeURIComponent(s9Corpus.mediaSessionId)}/prompts`,
        {
          prompt_id: `p_s9_d2_concurrent_${randomUUID().slice(0, 8)}`,
          content: [
            {
              type: 'text',
              text: `[CHAOS_SCOPE:s9_d2_stream_${Date.now()}] [CHAOS:STREAM_HOLD:${tierConfig.streamHoldDrill2Ms}] Concurrent slow streaming turn during Drill 2 audio and media playback.`,
            },
          ],
        },
        15_000,
      );
      drill2.concurrentTurnSubmitted = slowPromptRes.status === 200 && slowPromptRes.json?.code === 0;

      // Navigate browser to chaos_s9_media WHILE the slow turn is actively streaming & index churn is running
      await spaNavigate(`/s/${s9Corpus.mediaSessionId}`);
      await page.waitForSelector('[data-transcript-scroll] [data-transcript-virtual-item]', { timeout: tierConfig.stepTimeoutMs });

      // Scroll through transcript so .ogg <audio> elements enter IntersectionObserver viewport and mount
      await page.evaluate(async () => {
        const scroller = document.querySelector('[data-transcript-scroll]');
        if (!scroller) return;
        for (const ratio of [0.0, 0.25, 0.5, 0.75, 1.0, 0.2]) {
          scroller.scrollTop = Math.floor(Math.max(0, scroller.scrollHeight - scroller.clientHeight) * ratio);
          scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 180));
        }
      });

      // Wait for at least 1 in-message <audio> with a real src to mount
      await page.waitForFunction(
        () => {
          const audios = Array.from(document.querySelectorAll('[data-transcript-scroll] audio'));
          return audios.some((a) => Boolean(a.getAttribute('src') || a.currentSrc));
        },
        null,
        { timeout: 15_000 },
      ).catch(() => undefined);

      const audioState = await page.evaluate(() => {
        const audios = Array.from(document.querySelectorAll('[data-transcript-scroll] audio'));
        return audios.map((a) => ({
          src: a.getAttribute('src') || a.currentSrc || '',
          readyState: a.readyState,
          hasError: a.error !== null,
        }));
      });
      drill2.mountedAudioCount = audioState.filter((a) => a.src.length > 0).length;
      drill2.audioReadyUrls = audioState.map((a) => ({ ...a, src: a.src.slice(0, 120) }));

      // Run timed Range 206 probes on real .ogg and .mp4 WHILE active turn streams + index churn runs
      const [oggProbe, mp4Probe] = await Promise.all([
        probeMediaPlaybackAndRange(server.endpoint, server.token, s9Corpus.mediaSessionId, s9Corpus.oggFileIds[0]),
        probeMediaPlaybackAndRange(server.endpoint, server.token, s9Corpus.mediaSessionId, s9Corpus.mp4FileIds[0]),
      ]);
      drill2.oggRangeProbe = oggProbe;
      drill2.mp4RangeProbe = mp4Probe;

      // Scroll to top of media session so video placeholder & audio controls are mounted in viewport
      await page.evaluate(() => {
        const scroller = document.querySelector('[data-transcript-scroll]');
        if (scroller) {
          scroller.scrollTop = 0;
          scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        }
      });
      await sleep(300);

      // Arm in-browser audio watch + redundant media-playback re-mint detector, then open AttachmentTabView in PreviewWorkspace
      const armRes = await page.evaluate(() => window.__s9FlightRecorder?.armAudioWatch?.() ?? { armedCount: 0 });
      drill2.audioWatchArmedCount = armRes.armedCount;
      trackRedundantMediaRemints = true;

      // Prefer clicking the video attachment placeholder (opens AttachmentTabView in PreviewWorkspace)
      const videoTrigger = page.locator('[data-transcript-scroll] [data-media-video-placeholder]').first();
      const videoVisible = await videoTrigger.waitFor({ state: 'visible', timeout: 6_000 }).then(() => true).catch(() => false);
      const attachmentTrigger = videoVisible
        ? videoTrigger
        : page.locator('[data-transcript-scroll] [data-media-broken], [data-transcript-scroll] button[title*=".mp4"]').first();
      if (await attachmentTrigger.isVisible().catch(() => false)) {
        await attachmentTrigger.click({ timeout: 5_000 });
        const previewVisible = await page
          .locator('[data-preview-workspace]:not([hidden])')
          .waitFor({ state: 'visible', timeout: 8_000 })
          .then(() => true)
          .catch(() => false);
        drill2.attachmentPreviewOpened = previewVisible;
        await sleep(700);
        // Close preview workspace cleanly
        const closeBtn = page.locator('[data-preview-workspace] button[aria-label*="Close"], [data-preview-workspace] button[title*="Close"]').first();
        if (await closeBtn.isVisible().catch(() => false)) {
          await closeBtn.click({ timeout: 3_000 }).catch(() => undefined);
        } else {
          await page.keyboard.press('Escape').catch(() => undefined);
        }
        await sleep(200);
      }

      trackRedundantMediaRemints = false;
      await page.evaluate(() => window.__s9FlightRecorder?.disarmAudioWatch?.());
      drill2.redundantMediaPlaybackRemints = [...redundantMediaPlaybackRemints];

      // Let the concurrent slow turn finish cleanly so it doesn't leak into Drill 3
      await waitForSessionIdle(server.endpoint, server.token, s9Corpus.mediaSessionId, 20_000);
    } catch (err) {
      trackRedundantMediaRemints = false;
      await page.evaluate(() => window.__s9FlightRecorder?.disarmAudioWatch?.()).catch(() => undefined);
      drill2.error = String(err?.stack ?? err).slice(0, 600);
    }

    // =========================================================================
    // DRILL 3: 10k Virtualized Scale Navigation (Sidebar accordion, Ctrl+K QuickSwitcher, 10k Subagent Rail)
    // =========================================================================
    progress('S9 Drill 3/3: 10k Virtualized Sidebar accordion toggle, Ctrl+K QuickSwitcher 35x ArrowDown, & 10k-subagent Right Rail search...');
    drill3 = {
      sidebar: null,
      quickSwitcher: null,
      rightRail10k: null,
      error: null,
    };

    try {
      // 3A: Sidebar 10k Virtualized Accordion Toggle (expand/collapse 角色 `[data-sidebar-personas-toggle]`)
      const sidebarToggleExpand = page.locator('[data-sidebar-toggle="expand"]').first();
      if (await sidebarToggleExpand.isVisible().catch(() => false)) {
        await sidebarToggleExpand.click({ timeout: 5_000 });
        await sleep(200);
      }
      await page.waitForSelector('[data-session-list]', { timeout: 15_000 });

      // Load additional Sidebar pages & expand workspace groups so Sidebar (>60 rows) & QuickSwitcher (>40 items) engage real virtualization
      for (let loadStep = 0; loadStep < 5; loadStep += 1) {
        const alreadyVirt = await page.evaluate(() => Boolean(document.querySelector('[data-session-list-virtualized="true"]')));
        if (alreadyVirt) break;
        const showMore = page.locator('[data-session-group-more]').first();
        if (await showMore.isVisible().catch(() => false)) {
          await showMore.click({ timeout: 5_000 }).catch(() => undefined);
          await sleep(250);
          continue;
        }
        const loadMore = page.locator('[data-session-load-more]').first();
        if (await loadMore.isVisible().catch(() => false)) {
          await loadMore.scrollIntoViewIfNeeded().catch(() => undefined);
          await loadMore.click({ timeout: 5_000 }).catch(() => undefined);
          await sleep(450);
          continue;
        }
        // Scroll to bottom of [data-session-list] to trigger infinite load-more button visibility
        await page.evaluate(() => {
          const list = document.querySelector('[data-session-list]');
          if (list) {
            list.scrollTop = list.scrollHeight;
            list.dispatchEvent(new Event('scroll', { bubbles: true }));
          }
        });
        await sleep(300);
      }
      // Reset sidebar scroll to top before measuring initial state
      await page.evaluate(() => {
        const list = document.querySelector('[data-session-list]');
        if (list) {
          list.scrollTop = 0;
          list.dispatchEvent(new Event('scroll', { bubbles: true }));
        }
      });
      await sleep(200);

      const measureSidebarGap = async (label) => {
        return page.evaluate((stepLabel) => {
          const list = document.querySelector('[data-session-list]');
          const anchor = document.querySelector('[data-session-list-virtualized="true"]');
          if (!list || !anchor) {
            return { label: stepLabel, virtualized: Boolean(anchor), blankGapPx: null, mountedRows: 0 };
          }
          const listRect = list.getBoundingClientRect();
          const anchorRect = anchor.getBoundingClientRect();
          const visibleTop = Math.max(listRect.top, anchorRect.top);
          const visibleBottom = Math.min(listRect.bottom, anchorRect.bottom);
          const rows = Array.from(anchor.querySelectorAll(':scope > [data-index]'))
            .map((el) => {
              const r = el.getBoundingClientRect();
              return { index: Number(el.getAttribute('data-index')), top: r.top, bottom: r.bottom, height: r.height };
            })
            .filter((r) => r.height > 0)
            .sort((a, b) => a.top - b.top);
          const visibleRows = rows.filter((r) => r.bottom > visibleTop + 1 && r.top < visibleBottom - 1);
          let blankGapPx = 0;
          if (visibleBottom > visibleTop + 40) {
            if (visibleRows.length === 0) {
              blankGapPx = Math.round(visibleBottom - visibleTop);
            } else {
              blankGapPx = Math.max(0, Math.round(visibleRows[0].top - visibleTop));
            }
          }
          return {
            label: stepLabel,
            virtualized: true,
            scrollTop: Math.round(list.scrollTop),
            scrollHeight: Math.round(list.scrollHeight),
            anchorOffsetTop: Math.round(anchorRect.top - listRect.top + list.scrollTop),
            mountedRows: rows.length,
            visibleRows: visibleRows.length,
            blankGapPx,
          };
        }, label);
      };

      const personasToggle = page.locator('[data-sidebar-personas-toggle]').first();
      const personasToggleFound = await personasToggle.isVisible().catch(() => false);
      const sidebarSamples = [];
      sidebarSamples.push(await measureSidebarGap('initial-top'));

      // Scroll mid-list in Sidebar
      await page.evaluate(() => {
        const list = document.querySelector('[data-session-list]');
        if (list && list.scrollHeight > list.clientHeight + 200) {
          list.scrollTop = Math.min(2000, Math.floor((list.scrollHeight - list.clientHeight) * 0.4));
          list.dispatchEvent(new Event('scroll', { bubbles: true }));
        }
      });
      await sleep(200);
      sidebarSamples.push(await measureSidebarGap('mid-list-before-toggle'));

      if (personasToggleFound) {
        // Scroll back near top to click personas toggle, toggle collapse/expand, then re-scroll mid-list & measure
        await page.evaluate(() => {
          const list = document.querySelector('[data-session-list]');
          if (list) {
            list.scrollTop = 0;
            list.dispatchEvent(new Event('scroll', { bubbles: true }));
          }
        });
        await sleep(150);
        await personasToggle.click({ timeout: 5_000 });
        await sleep(250);
        sidebarSamples.push(await measureSidebarGap('after-toggle-1-top'));

        await page.evaluate(() => {
          const list = document.querySelector('[data-session-list]');
          if (list && list.scrollHeight > list.clientHeight + 200) {
            list.scrollTop = 220;
            list.dispatchEvent(new Event('scroll', { bubbles: true }));
          }
        });
        await sleep(180);
        sidebarSamples.push(await measureSidebarGap('after-toggle-1-near-top'));

        await page.evaluate(() => {
          const list = document.querySelector('[data-session-list]');
          if (list && list.scrollHeight > list.clientHeight + 200) {
            list.scrollTop = Math.min(1800, Math.floor((list.scrollHeight - list.clientHeight) * 0.35));
            list.dispatchEvent(new Event('scroll', { bubbles: true }));
          }
        });
        await sleep(200);
        sidebarSamples.push(await measureSidebarGap('after-toggle-1-mid'));

        await page.evaluate(() => {
          const list = document.querySelector('[data-session-list]');
          if (list) {
            list.scrollTop = 0;
            list.dispatchEvent(new Event('scroll', { bubbles: true }));
          }
        });
        await sleep(150);
        await personasToggle.click({ timeout: 5_000 });
        await sleep(250);
        sidebarSamples.push(await measureSidebarGap('after-toggle-2-top'));

        await page.evaluate(() => {
          const list = document.querySelector('[data-session-list]');
          if (list && list.scrollHeight > list.clientHeight + 200) {
            list.scrollTop = 220;
            list.dispatchEvent(new Event('scroll', { bubbles: true }));
          }
        });
        await sleep(180);
        sidebarSamples.push(await measureSidebarGap('after-toggle-2-near-top'));

        await page.evaluate(() => {
          const list = document.querySelector('[data-session-list]');
          if (list && list.scrollHeight > list.clientHeight + 200) {
            list.scrollTop = Math.min(1800, Math.floor((list.scrollHeight - list.clientHeight) * 0.35));
            list.dispatchEvent(new Event('scroll', { bubbles: true }));
          }
        });
        await sleep(200);
        sidebarSamples.push(await measureSidebarGap('after-toggle-2-mid'));
      }

      const maxBlankGapPx = Math.max(
        0,
        ...sidebarSamples.map((s) => (typeof s.blankGapPx === 'number' ? s.blankGapPx : 0)),
      );
      drill3.sidebar = {
        virtualized: sidebarSamples.some((s) => s.virtualized),
        personasToggleFound,
        maxBlankGapPx,
        samples: sidebarSamples,
      };

      // 3B: Open Ctrl+K QuickSwitcher, type "e" to match settings + sessions (>40 items, engaging virtualizer), press ArrowDown 35 times, assert highlighted item mounted & inside viewport
      await page.keyboard.press('Control+k');
      const switcherList = page.locator('#quick-switcher-list').first();
      const switcherOpened = await switcherList.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false);
      let qsResult = {
        opened: switcherOpened,
        query: 'e',
        isVirtualized: false,
        arrowPresses: 0,
        highlightedMounted: false,
        highlightedInViewport: false,
        highlightedIndex: null,
        listScrollTop: 0,
        rectInfo: null,
      };
      if (switcherOpened) {
        const qsInput = page.locator('[role="dialog"] input[type="text"]').first();
        if (await qsInput.isVisible().catch(() => false)) {
          await qsInput.fill('e');
          await sleep(250);
        }
        qsResult.isVirtualized = await page.evaluate(() => {
          const list = document.querySelector('#quick-switcher-list');
          if (!list) return false;
          const virtualWrapper = list.querySelector('div[style*="position: relative"]');
          return Boolean(virtualWrapper && Number.parseFloat(virtualWrapper.style.height || '0') > 1000);
        });
        for (let k = 0; k < tierConfig.quickSwitcherArrows; k += 1) {
          await page.keyboard.press('ArrowDown');
          qsResult.arrowPresses += 1;
          await sleep(25);
        }
        await sleep(180);
        const evalQs = await page.evaluate(() => {
          const list = document.querySelector('#quick-switcher-list');
          if (!list) return { mounted: false, inViewport: false };
          const listRect = list.getBoundingClientRect();
          const hl = list.querySelector('[data-highlighted], [aria-selected="true"]');
          if (!hl) {
            return {
              mounted: false,
              inViewport: false,
              listScrollTop: Math.round(list.scrollTop),
              mountedItemCount: list.querySelectorAll('[data-index]').length,
            };
          }
          const r = hl.getBoundingClientRect();
          const inViewport = r.height > 0 && r.top >= listRect.top - 4 && r.bottom <= listRect.bottom + 4;
          return {
            mounted: true,
            inViewport,
            highlightedIndex: hl.getAttribute('data-index'),
            listScrollTop: Math.round(list.scrollTop),
            mountedItemCount: list.querySelectorAll('[data-index]').length,
            rectInfo: {
              itemTop: Math.round(r.top),
              itemBottom: Math.round(r.bottom),
              listTop: Math.round(listRect.top),
              listBottom: Math.round(listRect.bottom),
            },
          };
        });
        qsResult = {
          ...qsResult,
          highlightedMounted: Boolean(evalQs.mounted),
          highlightedInViewport: Boolean(evalQs.inViewport),
          highlightedIndex: evalQs.highlightedIndex ?? null,
          listScrollTop: evalQs.listScrollTop ?? 0,
          mountedItemCount: evalQs.mountedItemCount ?? 0,
          rectInfo: evalQs.rectInfo ?? null,
        };
        await page.keyboard.press('Escape').catch(() => undefined);
        await sleep(150);
      }
      drill3.quickSwitcher = qsResult;

      // 3C: Search subagents in the 10k-subagent Right Rail
      const target10kSid = tenKCorpus?.sessionId ?? corpus.giantSessionId;
      const coldNeedleA = tenKCorpus?.coldHistoricalNeedleIds?.[0] ?? 'subagent_00042';
      const coldNeedleB = tenKCorpus?.coldHistoricalNeedleIds?.[1] ?? 'subagent_0010';
      await spaNavigate(`/s/${target10kSid}`);
      await page.waitForSelector('[data-transcript-scroll] [data-transcript-virtual-item]', { timeout: tierConfig.stepTimeoutMs });

      const rosterVisible = await page.locator('[data-agent-roster]').isVisible().catch(() => false);
      if (!rosterVisible) {
        const railToggle = page.locator('[data-rail-toggle]').first();
        if (await railToggle.isVisible().catch(() => false)) {
          await railToggle.click({ timeout: 5_000 });
        }
        await page.waitForSelector('[data-agent-roster]', { timeout: 15_000 }).catch(() => undefined);
      }

      const searchInput = page.locator('[data-roster-search]').first();
      let foundColdNeedleA = false;
      let foundColdNeedleB = false;
      let searchAMs = null;
      let searchBMs = null;
      if (await searchInput.isVisible().catch(() => false)) {
        const sA0 = performance.now();
        await searchInput.fill(coldNeedleA, { timeout: 10_000 });
        foundColdNeedleA = await page
          .waitForFunction(
            (needle) => Boolean(document.querySelector(`[data-agent-roster] [data-agent-id="${needle}"]`)),
            coldNeedleA,
            { timeout: 10_000 },
          )
          .then(() => true)
          .catch(() => false);
        searchAMs = roundMs(performance.now() - sA0);

        const sB0 = performance.now();
        await searchInput.fill(coldNeedleB, { timeout: 10_000 });
        foundColdNeedleB = await page
          .waitForFunction(
            (needle) => Boolean(document.querySelector(`[data-agent-roster] [data-agent-id="${needle}"]`)),
            coldNeedleB,
            { timeout: 10_000 },
          )
          .then(() => true)
          .catch(() => false);
        searchBMs = roundMs(performance.now() - sB0);
        await searchInput.fill('').catch(() => undefined);
      }
      drill3.rightRail10k = {
        sessionId: target10kSid,
        subagentCount: tenKCorpus?.subagentCount ?? corpus.subagentCount,
        coldNeedleA,
        foundColdNeedleA,
        searchAMs,
        coldNeedleB,
        foundColdNeedleB,
        searchBMs,
      };
    } catch (err) {
      drill3.error = String(err?.stack ?? err).slice(0, 600);
    }

    flightRecorder = await page.evaluate(() => window.__s9FlightRecorder?.getSummary?.() ?? null).catch(() => null);
    cdpFinal = await readCdpMetrics(cdp);
  } catch (err) {
    fatalError = String(err?.stack ?? err).slice(0, 800);
  } finally {
    const churnStats = churnWorker.stop();
    if (drill2) drill2.indexChurnStats = churnStats;
    await browser?.close().catch(() => undefined);
    await staticSrv?.close().catch(() => undefined);
  }

  const heapSnap = await server.stopHeapSampling();
  const postSrv = heapSnap.metrics;
  const serverHealth = {
    preRssMiB: preSrv.rssMiB,
    vmRssMiB: postSrv.rssMiB,
    vmHwmMiB: postSrv.vmHwmMiB,
    heapUsedMiB: postSrv.heapUsedMiB,
    eldP99Ms: postSrv.eldP99Ms,
    eldMaxMs: postSrv.eldMaxMs,
    maxSingleTickStallMs: postSrv.maxSingleTickStallMs,
    eventLoopUtilization: postSrv.eventLoopUtilization,
    unhandledRejections: postSrv.unhandledRejections,
    uncaughtExceptions: postSrv.uncaughtExceptions,
    topHeapAllocators: (heapSnap.topRetainers ?? []).slice(0, 15),
  };

  const verdict = evaluateS9Verdict({
    flightRecorder,
    pageErrors,
    http5xxResponses,
    drill1,
    drill2,
    drill3,
    serverHealth,
    tierConfig,
  });
  if (fatalError) {
    verdict.passed = false;
    verdict.breaches.unshift(`fatalError=${fatalError.slice(0, 200)}`);
  }

  progress(
    `S9 Finished (tier=${tierConfig.tier}, passed=${verdict.passed}, breaches=${verdict.breaches.length}, eldP99=${serverHealth.eldP99Ms}ms, vmRss=${serverHealth.vmRssMiB} MiB, fps=${flightRecorder?.fps?.mean ?? 0}, cls=${flightRecorder?.cls ?? 0})`,
  );
  if (verdict.breaches.length > 0) {
    progress(`S9 Breaches: ${verdict.breaches.join(' | ')}`);
  }

  return {
    passed: verdict.passed,
    breaches: verdict.breaches,
    tier: tierConfig.tier,
    wallMs: roundMs(performance.now() - startedAt),
    guiBuild: guiBuildInfo,
    corpusSummary: {
      giantSessionId: corpus.giantSessionId,
      giantMainWireGiB: corpus.giantMainWireGiB,
      seededSessionCount: s9Corpus.seededSessionCount,
      personaCount: s9Corpus.personaIds.length,
      subagentCount: tenKCorpus?.subagentCount ?? corpus.subagentCount,
      mediaSessionId: s9Corpus.mediaSessionId,
      oggBytes: s9Corpus.oggBytes,
      mp4Bytes: s9Corpus.mp4Bytes,
    },
    browserTelemetry: {
      fps: flightRecorder?.fps ?? null,
      cls: flightRecorder?.cls ?? null,
      longTasks: flightRecorder?.longTasks ?? null,
      cdp: cdpFinal,
      pageErrors,
      consoleErrors,
      http5xxResponses,
    },
    flightRecorder,
    drill1_sendAndSteer: drill1,
    drill2_audioMediaUnderLoad: drill2,
    drill3_tenKScaleNavigation: drill3,
    serverHealth,
    fatalError,
  };
}
