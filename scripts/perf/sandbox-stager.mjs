import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_SIDECAR_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_CHECKPOINT_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_MEDIA_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_SESSION_MEDIA_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_AGENT_BLOBS_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_SECONDARY_WIRE_BYTES = 512 * 1024;
const DEFAULT_MAX_SECONDARY_AGENTS = 16;
const DEFAULT_MAX_SESSION_WIRE_BYTES = 384 * 1024 * 1024;

const SCRUBBED_ENV_KEYS = [
  'KIKI_DESKTOP_BUNDLED', 'KIKI_RUNTIME_MANAGED', 'KIKI_SQLITE_QUERY_WORKER_PATH', 'KIKI_SQLITE_INDEXER_PATH',
  'KIKI_HISTORY_NAVIGATION_WORKER_ENTRY', 'KIKI_SQLITE_INDEXER_SEA', 'KIKI_USAGE_PARSER_WORKER_PATH',
  'KIKI_USAGE_READ_MODEL_WORKER_PATH', 'KIKI_HOME', 'KIMI_CODE_HOME', 'NODE_OPTIONS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'KIMI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY', 'XAI_API_KEY',
];

export function computeWorkDirKey(workDir) {
  const slashed = workDir.replaceAll('\\', '/');
  const isWin = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/u.test(slashed);
  const rawNorm = isWin ? path.win32.normalize(slashed).replaceAll('\\', '/').toLowerCase() : path.posix.normalize(workDir);
  const normalized = rawNorm.length > 1 ? rawNorm.replace(/\/+$/u, '') : rawNorm;
  const base = normalized.split('/').pop() ?? 'workspace';
  const slug =
    base.toLowerCase().replaceAll(/[^a-z0-9._-]+/gu, '-').replaceAll(/^-+|-+$/gu, '').slice(0, 40).replaceAll(/^-+|-+$/gu, '') ||
    'workspace';
  return `wd_${slug}_${createHash('sha256').update(normalized).digest('hex').slice(0, 12)}`;
}

export function sessionLockFileName(wsId, sessionId) {
  return `${createHash('sha256').update(`sessions/${wsId}/${sessionId}`).digest('hex')}.lock`;
}

function listSortedNames(dirPath) {
  try {
    return fs.readdirSync(dirPath).toSorted();
  } catch {
    return [];
  }
}

export function statSignature(filePath) {
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
    mainCkptStat: statSignature(path.join(mainDir, 'replay-checkpoints', 'engine-v1')),
    childEntries: childDir ? listSortedNames(childDir) : [],
    childWireStat: childDir ? statSignature(path.join(childDir, 'wire.jsonl')) : null,
  };
}

export function createSourceImmutabilityTracker({ locksDir } = {}) {
  const trackedSessions = [];
  const trackedFiles = new Map();
  const readLiveLocks = () => {
    const live = new Set();
    if (locksDir && fs.existsSync(locksDir)) {
      for (const name of listSortedNames(locksDir)) {
        if (name.endsWith('.lock')) live.add(name);
      }
    }
    return live;
  };
  return {
    get trackedFileCount() {
      return trackedFiles.size;
    },
    trackSession(label, sessionDir, maxChildAgentId = null, scope = null) {
      trackedSessions.push({ label, sessionDir, maxChildAgentId, scope, before: captureSourceFingerprint(sessionDir, maxChildAgentId) });
    },
    trackFile(filePath, scope = null) {
      try {
        const st = fs.statSync(filePath);
        if (st.isFile()) trackedFiles.set(filePath, { size: st.size, mtimeMs: st.mtimeMs, scope });
        return st;
      } catch {
        return undefined;
      }
    },
    verify({ throwOnMutation = false } = {}) {
      const liveLocks = readLiveLocks();
      const mutatedLabels = [];
      let mutationCount = 0;
      for (const entry of trackedSessions) {
        if (entry.scope && liveLocks.has(sessionLockFileName(entry.scope.wsId, entry.scope.sessionId))) continue;
        if (JSON.stringify(entry.before) !== JSON.stringify(captureSourceFingerprint(entry.sessionDir, entry.maxChildAgentId))) {
          mutatedLabels.push(entry.label);
          mutationCount += 1;
        }
      }
      for (const [filePath, before] of trackedFiles) {
        if (before.scope && liveLocks.has(sessionLockFileName(before.scope.wsId, before.scope.sessionId))) continue;
        const after = statSignature(filePath);
        if (!after.exists || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
          mutatedLabels.push(path.basename(filePath));
          mutationCount += 1;
        }
      }
      if (throwOnMutation && mutationCount > 0) {
        throw new Error(`Source corpus fingerprint changed (${mutationCount}): ${mutatedLabels.slice(0, 8).join(', ')}`);
      }
      return { checkedSessions: trackedSessions.length, verifiedSources: trackedSessions.length, checkedFiles: trackedFiles.size, mutations: mutationCount };
    },
  };
}

export function copyOrCloneFile(srcPath, dstPath, stats) {
  const st = fs.statSync(srcPath);
  if (!st.isFile()) return 0;
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  try {
    fs.copyFileSync(srcPath, dstPath, fs.constants.COPYFILE_FICLONE);
  } catch {
    fs.copyFileSync(srcPath, dstPath);
  }
  if (stats) {
    stats.copiedFiles = (stats.copiedFiles ?? 0) + 1;
    stats.copiedBytes = (stats.copiedBytes ?? 0) + st.size;
  }
  return st.size;
}

export function copyDirectoryBounded(
  srcDir,
  dstDir,
  stats,
  { maxFileBytes = DEFAULT_MAX_MEDIA_FILE_BYTES, maxTotalBytes = DEFAULT_MAX_SESSION_MEDIA_BYTES, filter } = {},
) {
  let copiedDirBytes = 0;
  const walk = (curSrc, curDst, relPrefix) => {
    let entries;
    try {
      entries = fs.readdirSync(curSrc, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.endsWith('.lock') || entry.isSymbolicLink()) continue;
      const srcEntry = path.join(curSrc, entry.name);
      const dstEntry = path.join(curDst, entry.name);
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(srcEntry, dstEntry, relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const sig = statSignature(srcEntry);
      if (!sig.exists || sig.size > maxFileBytes || copiedDirBytes + sig.size > maxTotalBytes) continue;
      if (filter && !filter(relPath, entry, sig.size)) continue;
      copiedDirBytes += copyOrCloneFile(srcEntry, dstEntry, stats);
    }
  };
  if (fs.existsSync(srcDir)) walk(srcDir, dstDir, '');
  return copiedDirBytes;
}

export function writeMinimalWireMetadata(dstWirePath, timeMs = 1_700_000_000_000) {
  fs.mkdirSync(path.dirname(dstWirePath), { recursive: true });
  fs.writeFileSync(dstWirePath, `${JSON.stringify({ time: timeMs, type: 'metadata', payload: { protocolVersion: '1.3' } })}\n`, 'utf8');
}

function copySidecarIfBounded(srcFile, dstFile, maxBytes, stats, tracker, scope) {
  const sig = statSignature(srcFile);
  if (sig.exists && sig.size <= maxBytes) {
    tracker?.trackFile(srcFile, scope);
    copyOrCloneFile(srcFile, dstFile, stats);
  }
}

export function copySessionOutcomes(srcSessionDir, dstSessionDir, stats, tracker, scope = null) {
  const srcOutcomesDir = path.join(srcSessionDir, 'agent-outcomes');
  if (!fs.existsSync(srcOutcomesDir)) return;
  copyDirectoryBounded(srcOutcomesDir, path.join(dstSessionDir, 'agent-outcomes'), stats, {
    maxFileBytes: MAX_SIDECAR_BYTES,
    maxTotalBytes: 32 * 1024 * 1024,
    filter: (relPath, entry) => {
      if (!entry.name.endsWith('.json')) return false;
      tracker?.trackFile(path.join(srcOutcomesDir, relPath), scope);
      return true;
    },
  });
}

export function stageSessionAgentTree(srcSessionDir, dstSessionDir, stats, options = {}) {
  const {
    fullWires = true,
    primaryAgentIds = ['main'],
    maxCheckpointBytes = DEFAULT_MAX_CHECKPOINT_BYTES,
    maxSecondaryWireBytes = DEFAULT_MAX_SECONDARY_WIRE_BYTES,
    maxSecondaryAgents = DEFAULT_MAX_SECONDARY_AGENTS,
    maxSessionWireBytes = DEFAULT_MAX_SESSION_WIRE_BYTES,
    maxBackgroundMainWireBytes = 0,
    copyBlobs = true,
    maxAgentBlobsBytes = DEFAULT_MAX_AGENT_BLOBS_BYTES,
    tracker = null,
    scope = null,
  } = options;
  const primarySet = new Set(primaryAgentIds.filter(Boolean));
  const srcAgentsDir = path.join(srcSessionDir, 'agents');
  let agentEntries = [];
  try {
    agentEntries = fs.readdirSync(srcAgentsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {}
  if (!fullWires && agentEntries.length === 0) {
    writeMinimalWireMetadata(path.join(dstSessionDir, 'agents', 'main', 'wire.jsonl'));
    return;
  }

  let sessionWireBytesCopied = 0;
  let secondaryCopiedCount = 0;
  const orderedEntries = [...agentEntries].toSorted((a, b) => {
    const priDiff = (primarySet.has(a.name) ? 0 : 1) - (primarySet.has(b.name) ? 0 : 1);
    return priDiff || a.name.localeCompare(b.name);
  });

  for (const entry of orderedEntries) {
    if (!fullWires && entry.name !== 'main') continue;
    const srcAgentDir = path.join(srcAgentsDir, entry.name);
    const dstAgentDir = path.join(dstSessionDir, 'agents', entry.name);
    fs.mkdirSync(dstAgentDir, { recursive: true });
    const isPrimary = primarySet.has(entry.name);
    if (fullWires && !isPrimary && secondaryCopiedCount >= maxSecondaryAgents) {
      if (stats) {
        stats.truncatedAgents = (stats.truncatedAgents ?? 0) + 1;
        stats.truncatedReasons = stats.truncatedReasons ?? [];
        if (stats.truncatedReasons.length < 20) stats.truncatedReasons.push(`secondary_agent_cap:${entry.name}`);
      }
      continue;
    }
    if (!isPrimary) secondaryCopiedCount += 1;
    for (const sidecar of ['wire.jsonl.generation', 'wire.transcript-receipt.json']) {
      copySidecarIfBounded(path.join(srcAgentDir, sidecar), path.join(dstAgentDir, sidecar), MAX_SIDECAR_BYTES, stats, tracker, scope);
    }

    const srcWire = path.join(srcAgentDir, 'wire.jsonl');
    const wireSig = statSignature(srcWire);
    const shouldCopyFullWire =
      wireSig.exists &&
      (fullWires
        ? isPrimary ||
          (wireSig.size <= maxSecondaryWireBytes && sessionWireBytesCopied + wireSig.size <= maxSessionWireBytes)
        : entry.name === 'main' && wireSig.size > 0 && wireSig.size <= maxBackgroundMainWireBytes);

    if (shouldCopyFullWire) {
      tracker?.trackFile(srcWire, scope);
      sessionWireBytesCopied += copyOrCloneFile(srcWire, path.join(dstAgentDir, 'wire.jsonl'), stats);
      copySidecarIfBounded(
        path.join(srcAgentDir, 'wire.jsonl.segments.json'),
        path.join(dstAgentDir, 'wire.jsonl.segments.json'),
        MAX_SIDECAR_BYTES,
        stats,
        tracker,
        scope,
      );
      copyDirectoryBounded(
        path.join(srcAgentDir, 'wire.jsonl.segments'),
        path.join(dstAgentDir, 'wire.jsonl.segments'),
        stats,
        {
          maxFileBytes: Number.POSITIVE_INFINITY,
          maxTotalBytes: Number.POSITIVE_INFINITY,
          filter: (relPath) => {
            tracker?.trackFile(path.join(srcAgentDir, 'wire.jsonl.segments', relPath), scope);
            return true;
          },
        },
      );
      if (fullWires) {
        for (const ckptName of ['engine-v1', 'engine-v1.json']) {
          copySidecarIfBounded(path.join(srcAgentDir, 'replay-checkpoints', ckptName), path.join(dstAgentDir, 'replay-checkpoints', ckptName), maxCheckpointBytes, stats, tracker, scope);
        }
        if (copyBlobs) {
          copyDirectoryBounded(path.join(srcAgentDir, 'blobs'), path.join(dstAgentDir, 'blobs'), stats, { maxFileBytes: DEFAULT_MAX_MEDIA_FILE_BYTES, maxTotalBytes: maxAgentBlobsBytes });
        }
      }
    } else {
      if (fullWires && wireSig.exists && wireSig.size > 0) {
        if (stats) {
          stats.truncatedWires = (stats.truncatedWires ?? 0) + 1;
          stats.truncatedReasons = stats.truncatedReasons ?? [];
          if (stats.truncatedReasons.length < 20) {
            stats.truncatedReasons.push(`wire_cap:${entry.name}:${wireSig.size}B`);
          }
        }
      }
      writeMinimalWireMetadata(path.join(dstAgentDir, 'wire.jsonl'));
    }
    if (fullWires) {
      copyDirectoryBounded(path.join(srcAgentDir, 'tasks'), path.join(dstAgentDir, 'tasks'), stats, { maxFileBytes: MAX_SIDECAR_BYTES, maxTotalBytes: 16 * 1024 * 1024 });
    }
  }
  if (!fs.existsSync(path.join(dstSessionDir, 'agents', 'main', 'wire.jsonl'))) {
    writeMinimalWireMetadata(path.join(dstSessionDir, 'agents', 'main', 'wire.jsonl'));
  }
}

export function createIsolatedSandboxDirs(parentDir = os.tmpdir(), prefix = 'kiki-perf-sandbox-') {
  fs.mkdirSync(parentDir, { recursive: true });
  const sandboxRoot = fs.mkdtempSync(path.join(parentDir, prefix));
  const homeDir = path.join(sandboxRoot, 'home');
  const osHomeDir = path.join(sandboxRoot, 'os-home');
  for (const rel of ['', '.config', '.cache', '.local/share', '.agents']) {
    fs.mkdirSync(rel ? path.join(osHomeDir, rel) : osHomeDir, { recursive: true });
  }
  fs.mkdirSync(homeDir, { recursive: true });
  return { sandboxRoot, homeDir, osHomeDir };
}

export function resolveHostPlaywrightBrowsersPath(realOsHome = os.homedir(), env = process.env) {
  if (env.PLAYWRIGHT_BROWSERS_PATH) return env.PLAYWRIGHT_BROWSERS_PATH;
  const candidate =
    process.platform === 'win32'
      ? path.join(env.LOCALAPPDATA || path.join(realOsHome, 'AppData', 'Local'), 'ms-playwright')
      : process.platform === 'darwin'
        ? path.join(realOsHome, 'Library', 'Caches', 'ms-playwright')
        : path.join(env.XDG_CACHE_HOME || path.join(realOsHome, '.cache'), 'ms-playwright');
  return fs.existsSync(candidate) ? candidate : undefined;
}

export function buildIsolatedPerfEnv({ homeDir, osHomeDir, extra = {}, baseEnv = process.env } = {}) {
  const playwrightPath = resolveHostPlaywrightBrowsersPath(baseEnv.USERPROFILE || baseEnv.HOME || os.homedir(), baseEnv);
  const env = { ...baseEnv };
  for (const key of SCRUBBED_ENV_KEYS) delete env[key];
  for (const key of Object.keys(env)) {
    if (key.startsWith('KIKI_EXPERIMENTAL_')) delete env[key];
  }
  if (playwrightPath) env.PLAYWRIGHT_BROWSERS_PATH = playwrightPath;
  if (homeDir) Object.assign(env, { KIKI_HOME: homeDir, KIMI_CODE_HOME: homeDir });
  if (osHomeDir) {
    Object.assign(env, { HOME: osHomeDir, USERPROFILE: osHomeDir, XDG_CONFIG_HOME: path.join(osHomeDir, '.config'), XDG_CACHE_HOME: path.join(osHomeDir, '.cache'), XDG_DATA_HOME: path.join(osHomeDir, '.local', 'share') });
  }
  return Object.assign(env, { GH_HOST: '127.0.0.1:1', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_PROXY: '*' }, extra);
}

export function isolateProcessOsHome(osHomeDir) {
  const keys = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'PLAYWRIGHT_BROWSERS_PATH'];
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  const playwrightPath = resolveHostPlaywrightBrowsersPath(process.env.USERPROFILE || process.env.HOME || os.homedir(), process.env);
  if (playwrightPath && !process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = playwrightPath;
  Object.assign(process.env, { HOME: osHomeDir, USERPROFILE: osHomeDir, XDG_CONFIG_HOME: path.join(osHomeDir, '.config'), XDG_CACHE_HOME: path.join(osHomeDir, '.cache'), XDG_DATA_HOME: path.join(osHomeDir, '.local', 'share') });
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

export function sanitizeAgentProfiles(sourceHome, stagedHome, tracker) {
  const srcAgentsDir = path.join(sourceHome, 'agents');
  if (!fs.existsSync(srcAgentsDir)) return 0;
  const dstAgentsDir = path.join(stagedHome, 'agents');
  fs.mkdirSync(dstAgentsDir, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(srcAgentsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const srcPath = path.join(srcAgentsDir, entry.name);
    tracker?.trackFile(srcPath);
    const raw = fs.readFileSync(srcPath, 'utf8');
    const body = [
      '---',
      `name: ${JSON.stringify(path.basename(entry.name, '.md'))}`,
      `description: ${JSON.stringify(`Sanitized profile ${count + 1}`)}`,
      ...(/\bmain\s*:\s*true\b/u.test(raw) ? ['main: true'] : []),
      'model_alias: "mock-fast"',
      'thinking_effort: "high"',
      '---',
      `Follow bench instructions for profile ${count + 1}.`,
      'x'.repeat(Math.min(Math.max(raw.length, 128), 4096)),
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dstAgentsDir, entry.name), body, 'utf8');
    count += 1;
  }
  return count;
}

export function stageSanitizedAgentsMd(sourceHome, stagedHome, tracker, { preserveRealContent = false } = {}) {
  const srcPath = path.join(sourceHome, 'AGENTS.md');
  const st = tracker ? tracker.trackFile(srcPath) : fs.existsSync(srcPath) ? fs.statSync(srcPath) : undefined;
  if (preserveRealContent && st && fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, path.join(stagedHome, 'AGENTS.md'));
    return;
  }
  const targetBytes = st ? Math.min(Math.max(st.size, 512), 16384) : 4096;
  const body = `# Bench Workspace Instructions\n\n${'Follow deterministic benchmark rules.\n'.repeat(Math.ceil(targetBytes / 40))}`.slice(0, targetBytes);
  fs.writeFileSync(path.join(stagedHome, 'AGENTS.md'), body, 'utf8');
}

export function createSandboxTeardown(sandboxRoot, onAfterRemove) {
  let cleaned = false;
  let cachedResult;
  const runCleanup = () => {
    if (cleaned) return cachedResult;
    cleaned = true;
    fs.rmSync(sandboxRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    cachedResult = onAfterRemove();
    return cachedResult;
  };
  const onSignal = () => {
    try {
      runCleanup();
    } catch {}
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return () => {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    return runCleanup();
  };
}

const SAFE_AGENT_LABEL_KEYS = ['branch', 'branchSealed', 'parentAgentId', 'autonomousReceiptPolicy'];

function scrubAgentLabels(rawLabels) {
  if (!rawLabels || typeof rawLabels !== 'object' || Array.isArray(rawLabels)) return undefined;
  const out = {};
  for (const key of SAFE_AGENT_LABEL_KEYS) {
    if (typeof rawLabels[key] === 'string' && rawLabels[key].length > 0) {
      out[key] = rawLabels[key];
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function scrubAgentMeta(rawAgent, ordinal) {
  if (!rawAgent || typeof rawAgent !== 'object' || Array.isArray(rawAgent)) return {};
  const scrubbed = {
    createdAt: typeof rawAgent.createdAt === 'number' ? rawAgent.createdAt : undefined,
    type: rawAgent.type === 'main' || rawAgent.type === 'sub' || rawAgent.type === 'independent' ? rawAgent.type : undefined,
    parentAgentId: typeof rawAgent.parentAgentId === 'string' || rawAgent.parentAgentId === null ? rawAgent.parentAgentId : undefined,
    forkedFrom: typeof rawAgent.forkedFrom === 'string' ? rawAgent.forkedFrom : undefined,
    labels: scrubAgentLabels(rawAgent.labels),
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
  } catch {}
  const agents = {};
  if (raw.agents && typeof raw.agents === 'object' && !Array.isArray(raw.agents)) {
    let idx = 1;
    for (const [agentId, meta] of Object.entries(raw.agents)) agents[agentId] = scrubAgentMeta(meta, idx++);
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
  fs.mkdirSync(path.dirname(dstStatePath), { recursive: true });
  fs.writeFileSync(dstStatePath, JSON.stringify(scrubbedMeta), 'utf8');
}

export function stageCorpusSandbox({
  corpusHome,
  samples,
  backgroundRecords = [],
  sandboxParentDir,
  isolateProcessEnv = true,
  extremeFullSize = false,
  enableSearch = true,
}) {
  const startedAt = performance.now();
  const { sandboxRoot, homeDir, osHomeDir } = createIsolatedSandboxDirs(sandboxParentDir ?? os.tmpdir(), 'kiki-perf-sandbox-');
  const workspaceRoot = path.join(sandboxRoot, 'workspace');
  const workspaceId = computeWorkDirKey(workspaceRoot);
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const nowIso = new Date(1_700_000_000_000).toISOString();
  fs.writeFileSync(
    path.join(homeDir, 'workspaces.json'),
    JSON.stringify({
      version: 1,
      workspaces: { [workspaceId]: { root: workspaceRoot, name: 'Perf Sandbox Workspace', created_at: nowIso, last_opened_at: nowIso } },
      deleted_workspace_ids: [],
    }),
    'utf8',
  );
  const srcConfigPath = corpusHome ? path.join(corpusHome, 'config.toml') : null;
  if (extremeFullSize && srcConfigPath && fs.existsSync(srcConfigPath)) {
    const rawConfig = fs.readFileSync(srcConfigPath, 'utf8');
    const searchVal = enableSearch ? 'true' : 'false';
    const sectionRe = /(\[search\][ \t]*\r?\n)([\s\S]*?)(?=\r?\n\[|$)/u;
    const nextConfig = sectionRe.test(rawConfig)
      ? rawConfig.replace(sectionRe, (_m, header, body) => {
          const hasEnabled = /^[ \t]*enabled[ \t]*=/mu.test(body);
          const nextBody = hasEnabled
            ? body.replace(/^([ \t]*enabled[ \t]*=[ \t]*)(true|false)/mu, `$1${searchVal}`)
            : `enabled = ${searchVal}\n${body}`;
          return `${header}${nextBody}`;
        })
      : `${rawConfig.trimEnd()}\n\n[search]\nenabled = ${searchVal}\n`;
    fs.writeFileSync(path.join(homeDir, 'config.toml'), nextConfig, 'utf8');
  } else {
    fs.writeFileSync(path.join(homeDir, 'config.toml'), `[search]\nenabled = ${enableSearch ? 'true' : 'false'}\n`, 'utf8');
  }

  const tracker = createSourceImmutabilityTracker({ locksDir: corpusHome ? path.join(corpusHome, 'session-locks') : undefined });
  const copyStats = { copiedFiles: 0, copiedBytes: 0, truncatedAgents: 0, truncatedWires: 0, truncatedReasons: [] };
  if (corpusHome) {
    if (extremeFullSize && fs.existsSync(path.join(corpusHome, 'agents'))) {
      copyDirectoryBounded(path.join(corpusHome, 'agents'), path.join(homeDir, 'agents'), copyStats, {
        maxFileBytes: Number.POSITIVE_INFINITY,
        maxTotalBytes: Number.POSITIVE_INFINITY,
      });
    } else {
      sanitizeAgentProfiles(corpusHome, homeDir, tracker);
    }
    stageSanitizedAgentsMd(corpusHome, homeDir, tracker, { preserveRealContent: extremeFullSize });
  }

  for (const sample of samples) {
    tracker.trackSession(sample.label, sample.sourceSessionDir, sample.maxChildAgentId);
    const dstSessionDir = path.join(homeDir, 'sessions', workspaceId, sample.sandboxId);
    writeScrubbedStateJson(path.join(sample.sourceSessionDir, 'state.json'), path.join(dstSessionDir, 'state.json'), {
      sandboxId: sample.sandboxId,
      title: `Perf ${sample.label} (${sample.stratum})`,
      cwd: workspaceRoot,
    });
    copySessionOutcomes(sample.sourceSessionDir, dstSessionDir, copyStats, tracker);
    copyDirectoryBounded(path.join(sample.sourceSessionDir, 'media'), path.join(dstSessionDir, 'media'), copyStats, extremeFullSize
      ? { maxFileBytes: Number.POSITIVE_INFINITY, maxTotalBytes: Number.POSITIVE_INFINITY }
      : undefined);
    stageSessionAgentTree(sample.sourceSessionDir, dstSessionDir, copyStats, {
      fullWires: true,
      primaryAgentIds: ['main', sample.maxChildAgentId, sample.branchAgentId],
      ...(extremeFullSize
        ? {
            maxSessionWireBytes: Number.POSITIVE_INFINITY,
            maxSecondaryWireBytes: Number.POSITIVE_INFINITY,
            maxSecondaryAgents: Number.POSITIVE_INFINITY,
            maxAgentBlobsBytes: Number.POSITIVE_INFINITY,
          }
        : {}),
      tracker,
    });
  }

  for (let i = 0; i < backgroundRecords.length; i += 1) {
    const bg = backgroundRecords[i];
    tracker.trackSession(`catalog#${i + 1}`, bg.sourceSessionDir, null);
    const dstSessionDir = path.join(homeDir, 'sessions', workspaceId, bg.sandboxId);
    writeScrubbedStateJson(path.join(bg.sourceSessionDir, 'state.json'), path.join(dstSessionDir, 'state.json'), {
      sandboxId: bg.sandboxId,
      title: `Perf Catalog #${i + 1}`,
      cwd: workspaceRoot,
    });
    stageSessionAgentTree(bg.sourceSessionDir, dstSessionDir, copyStats, { fullWires: false, tracker });
  }

  const restoreOsHome = isolateProcessEnv ? isolateProcessOsHome(osHomeDir) : () => {};
  const env = buildIsolatedPerfEnv({ homeDir, osHomeDir });
  const verifyImmutability = () => tracker.verify({ throwOnMutation: true });
  const cleanup = createSandboxTeardown(sandboxRoot, () => {
    restoreOsHome();
    return verifyImmutability();
  });

  return {
    sandboxRoot, homeDir, osHomeDir, env, workspaceRoot, workspaceId, samples,
    stageMs: Number((performance.now() - startedAt).toFixed(2)),
    hardlinkedFiles: 0, copiedFiles: copyStats.copiedFiles, copiedBytes: copyStats.copiedBytes, junctionCount: 0,
    truncationCount: (copyStats.truncatedAgents ?? 0) + (copyStats.truncatedWires ?? 0),
    truncatedReasons: copyStats.truncatedReasons ?? [],
    verifyImmutability, cleanup,
  };
}
