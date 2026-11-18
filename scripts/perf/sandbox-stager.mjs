import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_SIDECAR_BYTES = 2 * 1024 * 1024;

function computeWorkDirKey(workDir) {
  const slashed = workDir.replaceAll('\\', '/');
  const isWin = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/u.test(slashed);
  const rawNorm = isWin
    ? path.win32.normalize(slashed).replaceAll('\\', '/').toLowerCase()
    : path.posix.normalize(workDir);
  const normalized = rawNorm.length > 1 ? rawNorm.replace(/\/+$/u, '') : rawNorm;
  const base = normalized.split('/').pop() ?? 'workspace';
  const slug = base
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
    .slice(0, 40)
    .replaceAll(/^-+|-+$/gu, '') || 'workspace';
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  return `wd_${slug}_${hash}`;
}

function listSortedNames(dirPath) {
  try {
    return fs.readdirSync(dirPath).toSorted();
  } catch {
    return [];
  }
}

function statSignature(filePath) {
  try {
    const st = fs.statSync(filePath);
    return { exists: true, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return { exists: false, size: -1, mtimeMs: -1 };
  }
}

export function captureSourceFingerprint(sessionDir, maxChildAgentId) {
  const agentsDir = path.join(sessionDir, 'agents');
  const mainDir = path.join(agentsDir, 'main');
  const childDir = maxChildAgentId ? path.join(agentsDir, maxChildAgentId) : null;
  return {
    rootEntries: listSortedNames(sessionDir),
    stateStat: statSignature(path.join(sessionDir, 'state.json')),
    mediaEntries: listSortedNames(path.join(sessionDir, 'media')),
    agentsEntries: listSortedNames(agentsDir),
    mainEntries: listSortedNames(mainDir),
    mainWireStat: statSignature(path.join(mainDir, 'wire.jsonl')),
    childEntries: childDir ? listSortedNames(childDir) : [],
    childWireStat: childDir ? statSignature(path.join(childDir, 'wire.jsonl')) : null,
  };
}

function fingerprintsEqual(before, after) {
  return JSON.stringify(before) === JSON.stringify(after);
}

function linkOrCopyReadOnlyFile(srcPath, dstPath, linkStats) {
  try {
    fs.linkSync(srcPath, dstPath);
    linkStats.hardlinkedFiles += 1;
  } catch {
    fs.copyFileSync(srcPath, dstPath);
    linkStats.copiedFiles += 1;
  }
}

function junctionDirectory(targetDir, linkPath, junctionPaths) {
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(targetDir, linkPath, type);
  junctionPaths.push(linkPath);
}

function scrubAgentMeta(rawAgent, ordinal) {
  if (!rawAgent || typeof rawAgent !== 'object' || Array.isArray(rawAgent)) return {};
  const scrubbed = {
    createdAt: typeof rawAgent.createdAt === 'number' ? rawAgent.createdAt : undefined,
    type: rawAgent.type === 'main' || rawAgent.type === 'sub' || rawAgent.type === 'independent' ? rawAgent.type : undefined,
    parentAgentId: typeof rawAgent.parentAgentId === 'string' || rawAgent.parentAgentId === null ? rawAgent.parentAgentId : undefined,
    delegator: rawAgent.delegator && typeof rawAgent.delegator === 'object' ? rawAgent.delegator : undefined,
    displayName: rawAgent.type === 'main' ? 'Main' : `Subagent #${ordinal}`,
    model: typeof rawAgent.model === 'string' ? rawAgent.model : undefined,
    thinkingEffort: typeof rawAgent.thinkingEffort === 'string' ? rawAgent.thinkingEffort : undefined,
    thinkingEffortExplicit: typeof rawAgent.thinkingEffortExplicit === 'boolean' ? rawAgent.thinkingEffortExplicit : undefined,
    executor: typeof rawAgent.executor === 'string' ? rawAgent.executor : undefined,
    executorProtocol: typeof rawAgent.executorProtocol === 'string' ? rawAgent.executorProtocol : undefined,
    allowKikiSubagents: typeof rawAgent.allowKikiSubagents === 'boolean' ? rawAgent.allowKikiSubagents : undefined,
    status: rawAgent.status === 'completed' || rawAgent.status === 'failed' || rawAgent.status === 'cancelled' ? rawAgent.status : undefined,
    completedAt: typeof rawAgent.completedAt === 'number' ? rawAgent.completedAt : undefined,
    resultSummary: typeof rawAgent.resultSummary === 'string' && rawAgent.resultSummary.length > 0 ? 'completed' : undefined,
    error: typeof rawAgent.error === 'string' && rawAgent.error.length > 0 ? 'error' : undefined,
    taskId: typeof rawAgent.taskId === 'string' ? rawAgent.taskId : undefined,
    usage: rawAgent.usage && typeof rawAgent.usage === 'object' ? rawAgent.usage : undefined,
    contextTokens: typeof rawAgent.contextTokens === 'number' ? rawAgent.contextTokens : undefined,
    toolCallCount: typeof rawAgent.toolCallCount === 'number' ? rawAgent.toolCallCount : undefined,
  };
  return Object.fromEntries(Object.entries(scrubbed).filter(([, v]) => v !== undefined));
}

function writeScrubbedStateJson(srcStatePath, dstStatePath, { sandboxId, title, cwd }) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(srcStatePath, 'utf8'));
  } catch {
    raw = {};
  }
  const agents = {};
  if (raw.agents && typeof raw.agents === 'object' && !Array.isArray(raw.agents)) {
    let idx = 1;
    for (const [agentId, meta] of Object.entries(raw.agents)) {
      agents[agentId] = scrubAgentMeta(meta, idx);
      idx += 1;
    }
  }
  const scrubbedMeta = {
    id: sandboxId,
    version: typeof raw.version === 'number' ? raw.version : 2,
    title,
    titleKind: 'custom',
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 1_700_000_000_000,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 1_700_000_000_000,
    ...(typeof raw.activityUpdatedAt === 'number' ? { activityUpdatedAt: raw.activityUpdatedAt } : {}),
    archived: false,
    cwd,
    agents,
    ...(raw.lastTurnReason === 'completed' || raw.lastTurnReason === 'cancelled' || raw.lastTurnReason === 'failed'
      ? { lastTurnReason: raw.lastTurnReason }
      : {}),
    ...(raw.usage && typeof raw.usage === 'object' ? { usage: raw.usage } : {}),
  };
  fs.writeFileSync(dstStatePath, JSON.stringify(scrubbedMeta), 'utf8');
}

function copySmallSidecarIfPresent(srcFile, dstFile) {
  try {
    const st = fs.statSync(srcFile);
    if (st.isFile() && st.size <= MAX_SIDECAR_BYTES) {
      fs.mkdirSync(path.dirname(dstFile), { recursive: true });
      fs.copyFileSync(srcFile, dstFile);
    }
  } catch {
    // Optional sidecar absent.
  }
}

function stageSingleSession(record, dstSessionDir, { sandboxId, title, cwd, junctionPaths, linkStats, fullWires }) {
  fs.mkdirSync(dstSessionDir, { recursive: true });
  writeScrubbedStateJson(
    path.join(record.sourceSessionDir, 'state.json'),
    path.join(dstSessionDir, 'state.json'),
    { sandboxId, title, cwd },
  );

  if (!fullWires) {
    const mainDir = path.join(dstSessionDir, 'agents', 'main');
    fs.mkdirSync(mainDir, { recursive: true });
    fs.writeFileSync(path.join(mainDir, 'wire.jsonl'), '', 'utf8');
    return;
  }

  const srcMedia = path.join(record.sourceSessionDir, 'media');
  if (fs.existsSync(srcMedia) && fs.statSync(srcMedia).isDirectory()) {
    junctionDirectory(srcMedia, path.join(dstSessionDir, 'media'), junctionPaths);
  }

  const srcAgentsDir = path.join(record.sourceSessionDir, 'agents');
  let agentEntries = [];
  try {
    agentEntries = fs.readdirSync(srcAgentsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    agentEntries = [];
  }

  for (const entry of agentEntries) {
    const srcAgentDir = path.join(srcAgentsDir, entry.name);
    const dstAgentDir = path.join(dstSessionDir, 'agents', entry.name);
    fs.mkdirSync(dstAgentDir, { recursive: true });

    const srcWire = path.join(srcAgentDir, 'wire.jsonl');
    if (fs.existsSync(srcWire) && fs.statSync(srcWire).isFile()) {
      linkOrCopyReadOnlyFile(srcWire, path.join(dstAgentDir, 'wire.jsonl'), linkStats);
    }

    copySmallSidecarIfPresent(
      path.join(srcAgentDir, 'wire.jsonl.generation'),
      path.join(dstAgentDir, 'wire.jsonl.generation'),
    );
    copySmallSidecarIfPresent(
      path.join(srcAgentDir, 'wire.transcript-receipt.json'),
      path.join(dstAgentDir, 'wire.transcript-receipt.json'),
    );
    copySmallSidecarIfPresent(
      path.join(srcAgentDir, 'replay-checkpoints', 'engine-v1.json'),
      path.join(dstAgentDir, 'replay-checkpoints', 'engine-v1.json'),
    );

    const srcBlobs = path.join(srcAgentDir, 'blobs');
    if (fs.existsSync(srcBlobs) && fs.statSync(srcBlobs).isDirectory()) {
      junctionDirectory(srcBlobs, path.join(dstAgentDir, 'blobs'), junctionPaths);
    }
  }
}

function pickSameVolumeTempParent(corpusHome) {
  const sysTmp = os.tmpdir();
  if (process.platform !== 'win32') return sysTmp;
  const corpusRoot = path.parse(path.resolve(corpusHome)).root.toLowerCase();
  const tmpRoot = path.parse(path.resolve(sysTmp)).root.toLowerCase();
  return corpusRoot === tmpRoot ? sysTmp : sysTmp;
}

export function stageCorpusSandbox({ corpusHome, samples, backgroundRecords = [], sandboxParentDir }) {
  const startedAt = performance.now();
  const parentDir = sandboxParentDir ?? pickSameVolumeTempParent(corpusHome);
  fs.mkdirSync(parentDir, { recursive: true });
  const sandboxRoot = fs.mkdtempSync(path.join(parentDir, 'kiki-perf-sandbox-'));
  const homeDir = path.join(sandboxRoot, 'home');
  const workspaceRoot = path.join(sandboxRoot, 'workspace');
  const workspaceId = computeWorkDirKey(workspaceRoot);
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const nowIso = new Date(1_700_000_000_000).toISOString();
  fs.writeFileSync(
    path.join(homeDir, 'workspaces.json'),
    JSON.stringify({
      version: 1,
      workspaces: {
        [workspaceId]: {
          root: workspaceRoot,
          name: 'Perf Sandbox Workspace',
          created_at: nowIso,
          last_opened_at: nowIso,
        },
      },
      deleted_workspace_ids: [],
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(homeDir, 'config.toml'),
    '[search]\nenabled = false\n',
    'utf8',
  );

  const junctionPaths = [];
  const linkStats = { hardlinkedFiles: 0, copiedFiles: 0 };
  const trackedSources = [];

  for (const sample of samples) {
    trackedSources.push({
      label: sample.label,
      sessionDir: sample.sourceSessionDir,
      maxChildAgentId: sample.maxChildAgentId,
      before: captureSourceFingerprint(sample.sourceSessionDir, sample.maxChildAgentId),
    });
    const dstSessionDir = path.join(homeDir, 'sessions', workspaceId, sample.sandboxId);
    stageSingleSession(sample, dstSessionDir, {
      sandboxId: sample.sandboxId,
      title: `Perf ${sample.label} (${sample.stratum})`,
      cwd: workspaceRoot,
      junctionPaths,
      linkStats,
      fullWires: true,
    });
  }

  for (let i = 0; i < backgroundRecords.length; i += 1) {
    const bg = backgroundRecords[i];
    trackedSources.push({
      label: `catalog#${i + 1}`,
      sessionDir: bg.sourceSessionDir,
      maxChildAgentId: null,
      before: captureSourceFingerprint(bg.sourceSessionDir, null),
    });
    const dstSessionDir = path.join(homeDir, 'sessions', workspaceId, bg.sandboxId);
    stageSingleSession(bg, dstSessionDir, {
      sandboxId: bg.sandboxId,
      title: `Perf Catalog #${i + 1}`,
      cwd: workspaceRoot,
      junctionPaths,
      linkStats,
      fullWires: false,
    });
  }

  const stageMs = Number((performance.now() - startedAt).toFixed(2));
  let cleaned = false;

  const verifyImmutability = () => {
    const mutations = [];
    for (const tracked of trackedSources) {
      const after = captureSourceFingerprint(tracked.sessionDir, tracked.maxChildAgentId);
      if (!fingerprintsEqual(tracked.before, after)) {
        mutations.push(tracked.label);
      }
    }
    if (mutations.length > 0) {
      throw new Error(`Source corpus fingerprint changed for: ${mutations.join(', ')}`);
    }
    return { verifiedSources: trackedSources.length, mutations: 0 };
  };

  const cleanup = () => {
    if (cleaned) return verifyImmutability();
    cleaned = true;
    for (let i = junctionPaths.length - 1; i >= 0; i -= 1) {
      const linkPath = junctionPaths[i];
      try {
        if (fs.lstatSync(linkPath).isSymbolicLink()) {
          fs.unlinkSync(linkPath);
        }
      } catch {
        // Link already absent.
      }
    }
    fs.rmSync(sandboxRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    return verifyImmutability();
  };

  const onSignal = () => {
    try {
      cleanup();
    } catch {
      // Best-effort cleanup on termination signal.
    }
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  return {
    sandboxRoot,
    homeDir,
    workspaceRoot,
    workspaceId,
    stageMs,
    junctionCount: junctionPaths.length,
    ...linkStats,
    verifyImmutability,
    cleanup: () => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      return cleanup();
    },
  };
}
