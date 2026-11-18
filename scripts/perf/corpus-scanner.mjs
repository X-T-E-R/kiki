import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { roundMb } from './metrics.mjs';
import { createMulberry32, seededSample } from './prng.mjs';

const MIB = 1024 * 1024;

export const STRATA_DEFINITIONS = [
  {
    id: 'giant-main',
    primary: (s) => s.mainWireBytes >= 150 * MIB,
    fallback: (s) => s.mainWireBytes >= 25 * MIB,
    describeThreshold: 'mainWire>=150MiB (fallback >=25MiB)',
  },
  {
    id: 'multimedia-dense',
    primary: (s) => s.totalAttachmentCount >= 25,
    fallback: (s) => s.totalAttachmentCount >= 5,
    describeThreshold: 'attachments>=25 (fallback >=5)',
  },
  {
    id: 'massive-subagent',
    primary: (s) => s.subagentCount >= 80,
    fallback: (s) => s.subagentCount >= 15,
    describeThreshold: 'subagents>=80 (fallback >=15)',
  },
  {
    id: 'giant-cold-subagent',
    primary: (s) => s.maxChildWireBytes >= 15 * MIB,
    fallback: (s) => s.maxChildWireBytes >= 4 * MIB,
    describeThreshold: 'maxChildWire>=15MiB (fallback >=4MiB)',
  },
  {
    id: 'medium-scroll-partial',
    primary: (s) => s.mainWireBytes >= 5 * MIB && s.mainWireBytes <= 50 * MIB,
    fallback: (s) => s.mainWireBytes >= 1 * MIB && s.mainWireBytes <= 50 * MIB,
    describeThreshold: '5MiB<=mainWire<=50MiB',
  },
];

export function resolveCorpusHome(explicitHome) {
  if (explicitHome && explicitHome.trim().length > 0) {
    return path.resolve(explicitHome);
  }
  const fromEnv = process.env.KIKI_REAL_CORPUS_HOME;
  if (fromEnv && fromEnv.trim().length > 0) {
    return path.resolve(fromEnv);
  }
  return path.join(os.homedir(), '.kiki');
}

function safeReaddir(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function collectLockedSessionIds(corpusHome) {
  const locked = new Set();
  const locksDir = path.join(corpusHome, 'session-locks');
  for (const entry of safeReaddir(locksDir)) {
    const base = entry.name.replace(/\.lock$/iu, '').replace(/\.json$/iu, '');
    if (base.length > 0) locked.add(base);
  }
  return locked;
}

export function scanCorpusSessions(corpusHome, { minIdleMs = 120_000, nowMs = Date.now() } = {}) {
  const sessionsRoot = path.join(corpusHome, 'sessions');
  if (!fs.existsSync(sessionsRoot)) {
    return { available: false, totalScanned: 0, eligibleCount: 0, skippedActiveCount: 0, records: [] };
  }

  const lockedIds = collectLockedSessionIds(corpusHome);
  const records = [];
  let totalScanned = 0;
  let skippedActiveCount = 0;

  for (const wsEntry of safeReaddir(sessionsRoot)) {
    if (!wsEntry.isDirectory()) continue;
    const wsDir = path.join(sessionsRoot, wsEntry.name);
    for (const sessEntry of safeReaddir(wsDir)) {
      if (!sessEntry.isDirectory()) continue;
      const sessionDir = path.join(wsDir, sessEntry.name);
      const stateStat = safeStat(path.join(sessionDir, 'state.json'));
      if (!stateStat || !stateStat.isFile()) continue;
      totalScanned += 1;

      if (lockedIds.has(sessEntry.name)) {
        skippedActiveCount += 1;
        continue;
      }

      const mainWirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
      const mainWireStat = safeStat(mainWirePath);
      const latestSessionMtime = Math.max(stateStat.mtimeMs, mainWireStat?.mtimeMs ?? 0);
      if (minIdleMs > 0 && nowMs - latestSessionMtime < minIdleMs) {
        skippedActiveCount += 1;
        continue;
      }

      let mediaCount = 0;
      const mediaFilesDir = path.join(sessionDir, 'media', 'files');
      const mediaRootDir = path.join(sessionDir, 'media');
      const mediaEntries = safeReaddir(mediaFilesDir);
      if (mediaEntries.length > 0) {
        mediaCount = mediaEntries.filter((e) => e.isFile()).length;
      } else {
        mediaCount = safeReaddir(mediaRootDir).filter((e) => e.isFile() && !e.name.endsWith('.json')).length;
      }

      let subagentCount = 0;
      let maxChildWireBytes = 0;
      let maxChildAgentId = null;
      let blobCount = 0;
      let activeChildLock = false;

      const agentsDir = path.join(sessionDir, 'agents');
      const agentDirs = safeReaddir(agentsDir).filter((e) => e.isDirectory());
      for (const agentEntry of agentDirs) {
        const agentId = agentEntry.name;
        const agentPath = path.join(agentsDir, agentId);
        const blobsPath = path.join(agentPath, 'blobs');
        for (const sub of safeReaddir(blobsPath)) {
          if (sub.isFile()) {
            blobCount += 1;
          } else if (sub.isDirectory()) {
            blobCount += safeReaddir(path.join(blobsPath, sub.name)).filter((f) => f.isFile()).length;
          }
        }
        if (agentId === 'main') continue;
        subagentCount += 1;
        const childWireStat = safeStat(path.join(agentPath, 'wire.jsonl'));
        if (childWireStat) {
          if (minIdleMs > 0 && nowMs - childWireStat.mtimeMs < minIdleMs) {
            activeChildLock = true;
            break;
          }
          if (childWireStat.size > maxChildWireBytes) {
            maxChildWireBytes = childWireStat.size;
            maxChildAgentId = agentId;
          }
        }
      }

      if (activeChildLock) {
        skippedActiveCount += 1;
        continue;
      }

      const mainWireBytes = mainWireStat?.size ?? 0;
      if (mainWireBytes === 0 && subagentCount === 0) continue;

      records.push({
        sourceSessionId: sessEntry.name,
        sourceWorkspaceId: wsEntry.name,
        sourceSessionDir: sessionDir,
        mainWireBytes,
        subagentCount,
        maxChildWireBytes,
        maxChildAgentId,
        mediaCount,
        blobCount,
        totalAttachmentCount: mediaCount + blobCount,
      });
    }
  }

  records.sort((a, b) => {
    if (b.mainWireBytes !== a.mainWireBytes) return b.mainWireBytes - a.mainWireBytes;
    if (b.subagentCount !== a.subagentCount) return b.subagentCount - a.subagentCount;
    return a.sourceSessionId < b.sourceSessionId ? -1 : 1;
  });

  return {
    available: records.length > 0,
    totalScanned,
    eligibleCount: records.length,
    skippedActiveCount,
    records,
  };
}

export function formatSampleDescriptor(sample) {
  return `${sample.label} [stratum=${sample.stratum}, mainWire=${roundMb(sample.mainWireBytes)}MB, agents=${sample.subagentCount}, maxChildWire=${roundMb(sample.maxChildWireBytes)}MB, media=${sample.totalAttachmentCount}]`;
}

export function selectStratifiedSamples(records, { seed, perStratum = 2, backgroundCatalogCount = 32 }) {
  const rng = createMulberry32(seed);
  const chosenSourceDirs = new Set();
  const samples = [];
  const stratumCensus = {};

  let sampleOrdinal = 1;
  for (const stratum of STRATA_DEFINITIONS) {
    const primaryPool = records.filter(stratum.primary);
    const fallbackPool = primaryPool.length >= perStratum ? primaryPool : records.filter(stratum.fallback);
    const activeTier = primaryPool.length >= perStratum ? 'primary' : 'fallback';
    const deduplicated = fallbackPool.filter((r) => !chosenSourceDirs.has(r.sourceSessionDir));
    const candidatePool = deduplicated.length >= perStratum ? deduplicated : fallbackPool;
    const picked = seededSample(candidatePool, perStratum, rng);

    stratumCensus[stratum.id] = {
      primaryEligible: primaryPool.length,
      fallbackEligible: fallbackPool.length,
      tierUsed: picked.length > 0 ? activeTier : 'empty',
      sampledCount: picked.length,
    };

    for (const item of picked) {
      chosenSourceDirs.add(item.sourceSessionDir);
      const index = sampleOrdinal;
      sampleOrdinal += 1;
      const sample = {
        ...item,
        ordinal: index,
        label: `sample#${index}`,
        sandboxId: `perf_sample_${index}`,
        stratum: stratum.id,
      };
      samples.push({
        ...sample,
        descriptor: formatSampleDescriptor(sample),
      });
    }
  }

  const remaining = records.filter((r) => !chosenSourceDirs.has(r.sourceSessionDir));
  const backgroundRecords = seededSample(remaining, backgroundCatalogCount, rng).map((item, idx) => ({
    ...item,
    sandboxId: `perf_catalog_${idx + 1}`,
  }));

  return { samples, backgroundRecords, stratumCensus };
}
