import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const QUIESCENT_WINDOW_MS = 120_000;
const TEMP_GIT_REPO_COUNT = 24;

function sessionLockFileName(wsId, sessionId) {
  const scope = `sessions/${wsId}/${sessionId}`;
  return `${createHash('sha256').update(scope).digest('hex')}.lock`;
}

function recordFingerprint(map, filePath) {
  try {
    const st = fs.statSync(filePath);
    if (st.isFile()) {
      map.set(filePath, { size: st.size, mtimeMs: st.mtimeMs });
    }
    return st;
  } catch {
    return undefined;
  }
}

function linkOrCopyFile(src, dst) {
  try {
    fs.linkSync(src, dst);
  } catch {
    fs.copyFileSync(src, dst);
  }
}

function createTempGitRepos(reposRoot, count) {
  fs.mkdirSync(reposRoot, { recursive: true });
  const repoPaths = [];
  for (let i = 0; i < count; i += 1) {
    const repoDir = path.join(reposRoot, `repo-${String(i).padStart(2, '0')}`);
    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir, windowsHide: true });
    execFileSync('git', ['config', 'user.email', 'bench@example.test'], { cwd: repoDir, windowsHide: true });
    execFileSync('git', ['config', 'user.name', 'Bench'], { cwd: repoDir, windowsHide: true });
    execFileSync('git', ['remote', 'add', 'origin', `https://github.com/example/bench-repo-${i}.git`], {
      cwd: repoDir,
      windowsHide: true,
    });
    fs.writeFileSync(path.join(repoDir, 'README.md'), `# Bench Repo ${i}\n`, 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repoDir, windowsHide: true });
    execFileSync('git', ['commit', '-q', '-m', `chore: seed bench repo ${i}`], {
      cwd: repoDir,
      windowsHide: true,
    });
    if (i % 2 === 1) {
      fs.writeFileSync(path.join(repoDir, 'dirty-note.txt'), `dirty-${i}\n`, 'utf8');
    }
    repoPaths.push(repoDir);
  }
  return repoPaths;
}

function sanitizeAgentProfiles(sourceHome, stagedHome, fingerprints) {
  const srcAgentsDir = path.join(sourceHome, 'agents');
  if (!fs.existsSync(srcAgentsDir)) return 0;
  const dstAgentsDir = path.join(stagedHome, 'agents');
  fs.mkdirSync(dstAgentsDir, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(srcAgentsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const srcPath = path.join(srcAgentsDir, entry.name);
    recordFingerprint(fingerprints, srcPath);
    const raw = fs.readFileSync(srcPath, 'utf8');
    const nameBase = path.basename(entry.name, '.md');
    const isMain = /\bmain\s*:\s*true\b/.test(raw);
    const frontmatter = [
      '---',
      `name: ${JSON.stringify(nameBase)}`,
      `description: ${JSON.stringify(`Sanitized profile ${count + 1}`)}`,
      ...(isMain ? ['main: true'] : []),
      'model_alias: "mock-fast"',
      'thinking_effort: "high"',
      '---',
      `Follow bench instructions for profile ${count + 1}.`,
      'x'.repeat(Math.min(Math.max(raw.length, 128), 4096)),
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dstAgentsDir, entry.name), frontmatter, 'utf8');
    count += 1;
  }
  return count;
}

function stageSanitizedAgentsMd(sourceHome, stagedHome, fingerprints) {
  const srcPath = path.join(sourceHome, 'AGENTS.md');
  const st = recordFingerprint(fingerprints, srcPath);
  const targetBytes = st ? Math.min(Math.max(st.size, 512), 16384) : 4096;
  const body = `# Bench Workspace Instructions\n\n${'Follow deterministic benchmark rules.\n'.repeat(Math.ceil(targetBytes / 40))}`.slice(
    0,
    targetBytes,
  );
  fs.writeFileSync(path.join(stagedHome, 'AGENTS.md'), body, 'utf8');
}

function buildConfigToml(mockBaseUrl, discoveredModels) {
  const lines = [
    'default_model = "mock-fast"',
    '',
    '[providers.mock_loopback]',
    'type = "openai"',
    `base_url = ${JSON.stringify(mockBaseUrl)}`,
    'api_key = "mock-loopback-key"',
    '',
    '[models.mock-fast]',
    'provider = "mock_loopback"',
    'model = "mock-fast"',
    'max_context_size = 4000000',
    'capabilities = ["thinking", "image_in", "video_in"]',
    'support_efforts = ["low", "medium", "high", "xhigh", "max"]',
    'default_effort = "high"',
    '',
  ];
  for (const alias of discoveredModels) {
    if (!alias || alias === 'mock-fast' || alias.startsWith('adhoc:')) continue;
    lines.push(`[models.${JSON.stringify(alias)}]`);
    lines.push('provider = "mock_loopback"');
    lines.push(`model = ${JSON.stringify(alias)}`);
    lines.push('max_context_size = 4000000');
    lines.push('capabilities = ["thinking", "image_in", "video_in"]');
    lines.push('support_efforts = ["low", "medium", "high", "xhigh", "max"]');
    lines.push('default_effort = "high"');
    lines.push('');
  }
  lines.push('[cron]');
  lines.push('manualTick = true');
  lines.push('');
  lines.push('[search]');
  lines.push('enabled = true');
  lines.push('');
  return lines.join('\n');
}

function isolateSessionForMutation(stagedSessionDir, junctionsSet, linkedFingerprintsBySession, sessionKey) {
  const agentsDir = path.join(stagedSessionDir, 'agents');
  linkedFingerprintsBySession.delete(sessionKey);
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const lstat = fs.lstatSync(fullPath);
      if (lstat.isSymbolicLink()) {
        const target = fs.realpathSync(fullPath);
        fs.unlinkSync(fullPath);
        junctionsSet.delete(fullPath);
        if (entry.name === 'tasks' && fs.existsSync(target)) {
          fs.mkdirSync(fullPath, { recursive: true });
          for (const tEntry of fs.readdirSync(target, { withFileTypes: true })) {
            if (tEntry.isFile() && tEntry.name.endsWith('.json')) {
              fs.copyFileSync(path.join(target, tEntry.name), path.join(fullPath, tEntry.name));
            }
          }
        }
        continue;
      }
      if (lstat.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (lstat.isFile() && lstat.nlink > 1) {
        const tmpCopy = `${fullPath}.isolated-${process.pid}`;
        fs.copyFileSync(fullPath, tmpCopy);
        fs.unlinkSync(fullPath);
        fs.renameSync(tmpCopy, fullPath);
      }
    }
  }
  if (fs.existsSync(agentsDir)) {
    walk(agentsDir);
  }
}

export async function stageFullKikiHome({ mockBaseUrl }) {
  const sourceHome = process.env.KIKI_REAL_CORPUS_HOME ?? path.join(os.homedir(), '.kiki');
  if (!fs.existsSync(sourceHome)) {
    throw new Error('Real KIKI_HOME corpus directory does not exist');
  }

  const forbiddenPiiTokens = new Set([
    os.userInfo().username,
    os.homedir(),
    sourceHome,
  ]);

  const fingerprints = new Map();
  const linkedFingerprintsBySession = new Map();
  const junctions = new Set();

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kiki-perf-home-'));
  const stagedHome = path.join(tempRoot, 'home');
  const reposRoot = path.join(tempRoot, 'repos');
  fs.mkdirSync(stagedHome, { recursive: true });

  const repoPaths = createTempGitRepos(reposRoot, TEMP_GIT_REPO_COUNT);
  const workspaceToRepo = new Map();
  let wsSeq = 0;
  const assignRepo = (wsId) => {
    let repo = workspaceToRepo.get(wsId);
    if (!repo) {
      repo = repoPaths[wsSeq % repoPaths.length];
      wsSeq += 1;
      workspaceToRepo.set(wsId, repo);
    }
    return repo;
  };

  const activeLockFiles = new Set();
  const locksDir = path.join(sourceHome, 'session-locks');
  if (fs.existsSync(locksDir)) {
    for (const name of fs.readdirSync(locksDir)) {
      if (name.endsWith('.lock')) activeLockFiles.add(name);
    }
  }

  const srcWorkspacesPath = path.join(sourceHome, 'workspaces.json');
  let rawWorkspaces = { version: 1, workspaces: {}, deleted_workspace_ids: [] };
  if (fs.existsSync(srcWorkspacesPath)) {
    recordFingerprint(fingerprints, srcWorkspacesPath);
    try {
      rawWorkspaces = JSON.parse(fs.readFileSync(srcWorkspacesPath, 'utf8'));
    } catch {}
  }

  const sanitizedWorkspaces = {};
  let wsIdx = 0;
  for (const [wsId, entry] of Object.entries(rawWorkspaces.workspaces ?? {})) {
    forbiddenPiiTokens.add(wsId);
    if (entry && typeof entry.root === 'string' && entry.root.length >= 6) forbiddenPiiTokens.add(entry.root);
    const repo = assignRepo(wsId);
    wsIdx += 1;
    sanitizedWorkspaces[wsId] = {
      root: repo,
      name: `workspace-${wsIdx}`,
      created_at: entry?.created_at ?? '2026-01-01T00:00:00.000Z',
      last_opened_at: entry?.last_opened_at ?? '2026-01-01T00:00:00.000Z',
      ...(entry?.pinned === true ? { pinned: true } : {}),
    };
  }

  const discoveredModels = new Set();
  const stagedSessions = [];
  let skippedSessions = 0;
  const now = Date.now();

  const srcSessionsDir = path.join(sourceHome, 'sessions');
  if (fs.existsSync(srcSessionsDir)) {
    for (const wsDirent of fs.readdirSync(srcSessionsDir, { withFileTypes: true })) {
      if (!wsDirent.isDirectory()) continue;
      const wsId = wsDirent.name;
      forbiddenPiiTokens.add(wsId);
      const mappedRepo = assignRepo(wsId);
      if (!sanitizedWorkspaces[wsId]) {
        wsIdx += 1;
        sanitizedWorkspaces[wsId] = {
          root: mappedRepo,
          name: `workspace-${wsIdx}`,
          created_at: '2026-01-01T00:00:00.000Z',
          last_opened_at: '2026-01-01T00:00:00.000Z',
        };
      }

      const srcWsPath = path.join(srcSessionsDir, wsId);
      for (const sDirent of fs.readdirSync(srcWsPath, { withFileTypes: true })) {
        if (!sDirent.isDirectory()) continue;
        const sessionId = sDirent.name;
        forbiddenPiiTokens.add(sessionId);

        if (activeLockFiles.has(sessionLockFileName(wsId, sessionId))) {
          skippedSessions += 1;
          continue;
        }

        const srcSessionDir = path.join(srcWsPath, sessionId);
        let sessionEntries;
        try {
          const dirStat = fs.statSync(srcSessionDir);
          if (now - dirStat.mtimeMs < QUIESCENT_WINDOW_MS) {
            skippedSessions += 1;
            continue;
          }
          sessionEntries = fs.readdirSync(srcSessionDir, { withFileTypes: true });
        } catch {
          skippedSessions += 1;
          continue;
        }

        if (sessionEntries.some((e) => e.name.endsWith('.lock'))) {
          skippedSessions += 1;
          continue;
        }

        const srcStatePath = path.join(srcSessionDir, 'state.json');
        let stateStat;
        try {
          stateStat = fs.statSync(srcStatePath);
          if (now - stateStat.mtimeMs < QUIESCENT_WINDOW_MS) {
            skippedSessions += 1;
            continue;
          }
        } catch {
          skippedSessions += 1;
          continue;
        }

        let parsedState;
        try {
          parsedState = JSON.parse(fs.readFileSync(srcStatePath, 'utf8'));
        } catch {
          skippedSessions += 1;
          continue;
        }

        const srcAgentsDir = path.join(srcSessionDir, 'agents');
        const agentPlans = [];
        let skipFromAgent = false;
        let mainWireBytes = 0;
        let totalWireBytes = 0;
        let mainCkptBytes = 0;
        let hasMainCkpt = false;

        if (fs.existsSync(srcAgentsDir)) {
          let agentDirents = [];
          try {
            agentDirents = fs.readdirSync(srcAgentsDir, { withFileTypes: true });
          } catch {
            skipFromAgent = true;
          }
          for (const aDirent of agentDirents) {
            if (skipFromAgent || !aDirent.isDirectory()) continue;
            const aPath = path.join(srcAgentsDir, aDirent.name);
            let aEntries;
            try {
              aEntries = fs.readdirSync(aPath, { withFileTypes: true });
            } catch {
              continue;
            }
            if (aEntries.some((ae) => ae.name.endsWith('.lock') && !ae.name.includes('.watch-'))) {
              skipFromAgent = true;
              break;
            }
            const filesToLink = [];
            const filesToCopy = [];
            const dirsToJunction = [];
            for (const ae of aEntries) {
              const aePath = path.join(aPath, ae.name);
              if (
                ae.isFile() &&
                (ae.name === 'wire.jsonl' ||
                  ae.name === 'wire.transcript-receipt.json' ||
                  ae.name === 'wire.jsonl.generation')
              ) {
                try {
                  const wst = fs.statSync(aePath);
                  if (now - wst.mtimeMs < QUIESCENT_WINDOW_MS) {
                    skipFromAgent = true;
                    break;
                  }
                  if (ae.name === 'wire.jsonl') {
                    totalWireBytes += wst.size;
                    if (aDirent.name === 'main') mainWireBytes += wst.size;
                    filesToLink.push({ src: aePath, rel: ae.name });
                  } else {
                    filesToCopy.push({ src: aePath, rel: ae.name });
                  }
                } catch {}
              } else if (ae.isDirectory() && ae.name === 'replay-checkpoints') {
                const ckptPath = path.join(aePath, 'engine-v1');
                if (fs.existsSync(ckptPath)) {
                  try {
                    const cst = fs.statSync(ckptPath);
                    if (now - cst.mtimeMs < QUIESCENT_WINDOW_MS) {
                      skipFromAgent = true;
                      break;
                    }
                    if (aDirent.name === 'main') {
                      mainCkptBytes = cst.size;
                      hasMainCkpt = true;
                    }
                    filesToLink.push({ src: ckptPath, rel: path.join('replay-checkpoints', 'engine-v1') });
                  } catch {}
                }
              } else if (ae.isDirectory() && (ae.name === 'blobs' || ae.name === 'tasks')) {
                dirsToJunction.push({ src: aePath, rel: ae.name });
              }
            }
            agentPlans.push({ agentId: aDirent.name, filesToLink, filesToCopy, dirsToJunction });
          }
        }

        if (skipFromAgent) {
          skippedSessions += 1;
          continue;
        }

        recordFingerprint(fingerprints, srcStatePath);
        if (typeof parsedState.cwd === 'string' && parsedState.cwd.length >= 6) forbiddenPiiTokens.add(parsedState.cwd);
        if (typeof parsedState.title === 'string' && parsedState.title.length >= 18) {
          forbiddenPiiTokens.add(parsedState.title);
        }

        parsedState.cwd = mappedRepo;
        if ('workDir' in parsedState) parsedState.workDir = mappedRepo;
        if ('worktree' in parsedState) delete parsedState.worktree;
        if (parsedState.custom && typeof parsedState.custom === 'object' && !Array.isArray(parsedState.custom)) {
          if ('cwd' in parsedState.custom) parsedState.custom.cwd = mappedRepo;
        }

        const agentsObj = parsedState.agents && typeof parsedState.agents === 'object' ? parsedState.agents : {};
        for (const aMeta of Object.values(agentsObj)) {
          if (aMeta && typeof aMeta === 'object') {
            if (typeof aMeta.model === 'string' && aMeta.model.length > 0) {
              discoveredModels.add(aMeta.model);
            }
            if (aMeta.labels && typeof aMeta.labels === 'object') {
              delete aMeta.labels.workDir;
              delete aMeta.labels.additionalDirs;
            }
          }
        }

        const dstSessionDir = path.join(stagedHome, 'sessions', wsId, sessionId);
        fs.mkdirSync(dstSessionDir, { recursive: true });
        fs.writeFileSync(path.join(dstSessionDir, 'state.json'), JSON.stringify(parsedState), 'utf8');

        const srcOutcomesDir = path.join(srcSessionDir, 'agent-outcomes');
        if (fs.existsSync(srcOutcomesDir)) {
          const dstOutcomesDir = path.join(dstSessionDir, 'agent-outcomes');
          fs.mkdirSync(dstOutcomesDir, { recursive: true });
          for (const outEntry of fs.readdirSync(srcOutcomesDir, { withFileTypes: true })) {
            if (!outEntry.isFile() || !outEntry.name.endsWith('.json')) continue;
            const srcOut = path.join(srcOutcomesDir, outEntry.name);
            recordFingerprint(fingerprints, srcOut);
            fs.copyFileSync(srcOut, path.join(dstOutcomesDir, outEntry.name));
          }
        }

        const sessionKey = `${wsId}/${sessionId}`;
        const sessionLinkedMap = new Map();
        linkedFingerprintsBySession.set(sessionKey, { wsId, sessionId, files: sessionLinkedMap });

        for (const plan of agentPlans) {
          const dstAgentDir = path.join(dstSessionDir, 'agents', plan.agentId);
          fs.mkdirSync(dstAgentDir, { recursive: true });
          for (const f of plan.filesToCopy) {
            const dstFile = path.join(dstAgentDir, f.rel);
            fs.mkdirSync(path.dirname(dstFile), { recursive: true });
            fs.copyFileSync(f.src, dstFile);
          }
          for (const f of plan.filesToLink) {
            recordFingerprint(sessionLinkedMap, f.src);
            recordFingerprint(fingerprints, f.src);
            const dstFile = path.join(dstAgentDir, f.rel);
            fs.mkdirSync(path.dirname(dstFile), { recursive: true });
            linkOrCopyFile(f.src, dstFile);
          }
          for (const d of plan.dirsToJunction) {
            try {
              const dStat = fs.statSync(d.src);
              sessionLinkedMap.set(d.src, { size: dStat.size, mtimeMs: dStat.mtimeMs, isDir: true });
            } catch {}
            const dstJunction = path.join(dstAgentDir, d.rel);
            fs.symlinkSync(d.src, dstJunction, 'junction');
            junctions.add(dstJunction);
          }
        }

        const mainMeta = agentsObj.main;
        const executor = parsedState.executorId ?? mainMeta?.executor ?? 'native';
        const hasExternalClient = Boolean(parsedState.custom?.externalClient);

        stagedSessions.push({
          wsId,
          sessionId,
          stagedSessionDir: dstSessionDir,
          stateBytes: stateStat.size,
          mainWireBytes,
          totalWireBytes,
          mainCkptBytes,
          hasMainCkpt,
          agentCount: Math.max(agentPlans.length, Object.keys(agentsObj).length),
          executor,
          isNativeRunnable:
            executor === 'native' &&
            !hasExternalClient &&
            parsedState.lastTurnReason === 'completed' &&
            parsedState.executionPhase !== 'paused' &&
            parsedState.executionPhase !== 'pausing',
        });
      }
    }
  }

  fs.writeFileSync(
    path.join(stagedHome, 'workspaces.json'),
    JSON.stringify({
      version: rawWorkspaces.version ?? 1,
      workspaces: sanitizedWorkspaces,
      deleted_workspace_ids: rawWorkspaces.deleted_workspace_ids ?? [],
    }),
    'utf8',
  );

  const stagedSessionIdSet = new Set(stagedSessions.map((s) => s.sessionId));
  let stagedPersonaCount = 0;
  const srcPersonasDir = path.join(sourceHome, 'personas');
  if (fs.existsSync(srcPersonasDir)) {
    const dstPersonasDir = path.join(stagedHome, 'personas');
    fs.mkdirSync(dstPersonasDir, { recursive: true });
    for (const pEntry of fs.readdirSync(srcPersonasDir, { withFileTypes: true })) {
      if (!pEntry.isDirectory()) continue;
      const personaId = pEntry.name;
      if (personaId.length >= 12) forbiddenPiiTokens.add(personaId);
      const srcPersonaMd = path.join(srcPersonasDir, personaId, 'persona.md');
      if (!fs.existsSync(srcPersonaMd)) continue;
      recordFingerprint(fingerprints, srcPersonaMd);
      stagedPersonaCount += 1;
      const dstPDir = path.join(dstPersonasDir, personaId);
      fs.mkdirSync(dstPDir, { recursive: true });
      const personaText = [
        '---',
        `name: "Persona ${stagedPersonaCount}"`,
        'model_alias: "mock-fast"',
        'thinking_effort: "high"',
        '---',
        `Neutral benchmark persona ${stagedPersonaCount}.`,
        '',
      ].join('\n');
      fs.writeFileSync(path.join(dstPDir, 'persona.md'), personaText, 'utf8');

      const srcPState = path.join(srcPersonasDir, personaId, 'state.json');
      if (fs.existsSync(srcPState)) {
        recordFingerprint(fingerprints, srcPState);
        try {
          const pState = JSON.parse(fs.readFileSync(srcPState, 'utf8'));
          const cleanState = {
            version: 1,
            archived: pState.archived === true,
            ...(typeof pState.homeSessionId === 'string' && stagedSessionIdSet.has(pState.homeSessionId)
              ? { homeSessionId: pState.homeSessionId }
              : {}),
            ...(pState.pinned === true ? { pinned: true } : {}),
            ...(pState.hidden === true ? { hidden: true } : {}),
          };
          fs.writeFileSync(path.join(dstPDir, 'state.json'), JSON.stringify(cleanState), 'utf8');
        } catch {}
      }
    }
  }

  const userProfileCount = sanitizeAgentProfiles(sourceHome, stagedHome, fingerprints);
  stageSanitizedAgentsMd(sourceHome, stagedHome, fingerprints);

  fs.writeFileSync(path.join(stagedHome, 'config.toml'), buildConfigToml(mockBaseUrl, discoveredModels), 'utf8');

  const sortedByTotalWire = [...stagedSessions].sort((a, b) => b.totalWireBytes - a.totalWireBytes);
  const openFanoutSamples = sortedByTotalWire.slice(0, Math.min(5, sortedByTotalWire.length));

  const nativeWithCkpt = sortedByTotalWire.filter(
    (s) =>
      s.isNativeRunnable &&
      s.hasMainCkpt &&
      s.mainCkptBytes <= 450 * 1048576 &&
      s.mainWireBytes >= 50 * 1048576,
  );

  const warmSendSample =
    nativeWithCkpt.find(
      (s) =>
        s.agentCount >= 250 &&
        s.stateBytes >= 1024 * 1024 &&
        s.mainWireBytes >= 150 * 1048576 &&
        s.mainWireBytes <= 260 * 1048576,
    ) ??
    nativeWithCkpt.find((s) => s.agentCount >= 100 && s.mainWireBytes <= 260 * 1048576) ??
    nativeWithCkpt.find((s) => s.mainWireBytes <= 260 * 1048576) ??
    sortedByTotalWire.find((s) => s.isNativeRunnable && s.mainWireBytes <= 260 * 1048576);

  const coldMegaCandidates = nativeWithCkpt.filter(
    (s) =>
      s.sessionId !== warmSendSample?.sessionId &&
      s.totalWireBytes >= 300 * 1048576 &&
      s.mainWireBytes >= 60 * 1048576 &&
      s.mainWireBytes <= 240 * 1048576,
  );
  const coldDurableSample =
    coldMegaCandidates[0] ??
    nativeWithCkpt.find((s) => s.sessionId !== warmSendSample?.sessionId) ??
    warmSendSample;
  const coldSyncSample =
    coldMegaCandidates[1] ??
    nativeWithCkpt.find(
      (s) => s.sessionId !== warmSendSample?.sessionId && s.sessionId !== coldDurableSample?.sessionId,
    ) ??
    coldDurableSample;

  for (const target of new Set([warmSendSample, coldDurableSample, coldSyncSample].filter(Boolean))) {
    isolateSessionForMutation(
      target.stagedSessionDir,
      junctions,
      linkedFingerprintsBySession,
      `${target.wsId}/${target.sessionId}`,
    );
  }

  const sampleWorkspaceId = Object.keys(sanitizedWorkspaces)[0];

  function verifySourceMutations() {
    const liveLocksNow = new Set();
    if (fs.existsSync(locksDir)) {
      for (const name of fs.readdirSync(locksDir)) {
        if (name.endsWith('.lock')) liveLocksNow.add(name);
      }
    }
    let mutations = 0;
    for (const { wsId, sessionId, files } of linkedFingerprintsBySession.values()) {
      if (liveLocksNow.has(sessionLockFileName(wsId, sessionId))) continue;
      for (const [filePath, before] of files) {
        try {
          const after = fs.statSync(filePath);
          if (before.isDir) {
            if (after.mtimeMs !== before.mtimeMs) mutations += 1;
          } else if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
            mutations += 1;
          }
        } catch {
          mutations += 1;
        }
      }
    }
    return mutations;
  }

  function teardown() {
    for (const junctionPath of junctions) {
      try {
        fs.unlinkSync(junctionPath);
      } catch {}
    }
    junctions.clear();
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    return verifySourceMutations();
  }

  return {
    stagedHome,
    defaultRepoCwd: repoPaths[0],
    sampleWorkspaceId,
    forbiddenPiiTokens,
    inventory: {
      sessionsStaged: stagedSessions.length,
      sessionsSkipped: skippedSessions,
      workspacesRegistered: Object.keys(sanitizedWorkspaces).length,
      tempGitRepos: repoPaths.length,
      personasStaged: stagedPersonaCount,
      userProfilesStaged: userProfileCount,
      fingerprintedSourceFiles: fingerprints.size,
      maxStateKB: Math.round(Math.max(0, ...stagedSessions.map((s) => s.stateBytes)) / 1024),
      maxAgents: Math.max(0, ...stagedSessions.map((s) => s.agentCount)),
      sessionsOver300MB: stagedSessions.filter((s) => s.totalWireBytes >= 300 * 1048576).length,
    },
    samples: {
      openFanout: openFanoutSamples,
      warmSend: warmSendSample,
      coldDurableSend: coldDurableSample,
      coldSyncSend: coldSyncSample,
    },
    verifySourceMutations,
    teardown,
  };
}
