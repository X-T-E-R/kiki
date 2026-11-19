import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildIsolatedPerfEnv,
  copyOrCloneFile,
  copySessionOutcomes,
  createIsolatedSandboxDirs,
  createSandboxTeardown,
  createSourceImmutabilityTracker,
  isolateProcessOsHome,
  sanitizeAgentProfiles,
  sessionLockFileName,
  stageSanitizedAgentsMd,
  stageSessionAgentTree,
  writeMinimalWireMetadata,
} from '../perf/sandbox-stager.mjs';

const QUIESCENT_WINDOW_MS = 120_000;
const TEMP_GIT_REPO_COUNT = 24;
const BACKGROUND_MAIN_WIRE_MAX_BYTES = 64 * 1024;

function createTempGitRepos(reposRoot, count) {
  fs.mkdirSync(reposRoot, { recursive: true });
  const templateDir = path.join(reposRoot, '_template');
  fs.mkdirSync(templateDir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: templateDir, windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'bench@example.test'], { cwd: templateDir, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'Bench'], { cwd: templateDir, windowsHide: true });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/bench-repo.git'], { cwd: templateDir, windowsHide: true });
  fs.writeFileSync(path.join(templateDir, 'README.md'), '# Bench Repo\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: templateDir, windowsHide: true });
  execFileSync('git', ['commit', '-q', '-m', 'chore: seed bench repo'], { cwd: templateDir, windowsHide: true });
  const repoPaths = [];
  for (let i = 0; i < count; i += 1) {
    const repoDir = path.join(reposRoot, `repo-${String(i).padStart(2, '0')}`);
    fs.cpSync(templateDir, repoDir, { recursive: true });
    if (i % 2 === 1) fs.writeFileSync(path.join(repoDir, 'dirty-note.txt'), `dirty-${i}\n`, 'utf8');
    repoPaths.push(repoDir);
  }
  fs.rmSync(templateDir, { recursive: true, force: true });
  return repoPaths;
}

function buildConfigToml(mockBaseUrl, discoveredModels, enableSessionTitle = false, enableSearch = true) {
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
    lines.push(
      `[models.${JSON.stringify(alias)}]`,
      'provider = "mock_loopback"',
      `model = ${JSON.stringify(alias)}`,
      'max_context_size = 4000000',
      'capabilities = ["thinking", "image_in", "video_in"]',
      'support_efforts = ["low", "medium", "high", "xhigh", "max"]',
      'default_effort = "high"',
      '',
    );
  }
  lines.push('[cron]', 'manualTick = true', '', '[search]', `enabled = ${enableSearch ? 'true' : 'false'}`, '');
  if (enableSessionTitle) {
    lines.push('[session_title]', 'model = "mock-fast"', 'triggers = []', '');
  }
  return lines.join('\n');
}

function seedDenseBenchRepo(repoDir) {
  for (let pkg = 0; pkg < 12; pkg += 1) {
    const pkgName = `pkg-${String(pkg).padStart(2, '0')}`;
    for (let mod = 0; mod < 160; mod += 1) {
      const subDir = path.join(repoDir, 'packages', pkgName, mod % 2 === 0 ? 'src' : 'test');
      fs.mkdirSync(subDir, { recursive: true });
      const ext = mod % 3 === 0 ? 'tsx' : 'ts';
      fs.writeFileSync(
        path.join(subDir, `feature_${String(mod).padStart(3, '0')}.${ext}`),
        `export const feature_${pkg}_${mod} = ${mod};\nexport function renderView${mod}(): string { return 'ok-${pkg}-${mod}'; }\n`,
        'utf8',
      );
    }
  }
  const docsDir = path.join(repoDir, 'docs', 'guides');
  fs.mkdirSync(docsDir, { recursive: true });
  for (let d = 0; d < 80; d += 1) {
    fs.writeFileSync(path.join(docsDir, `guide-${String(d).padStart(2, '0')}.md`), `# Guide ${d}\n\nDeterministic benchmark guide content ${d}.\n`, 'utf8');
  }
}

function isPngHeader(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(8);
    const read = fs.readSync(fd, head, 0, 8, 0);
    return (
      read === 8 &&
      head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 &&
      head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function stagePersonas(sourceHome, stagedHome, stagedSessionIdSet, forbiddenPiiTokens, tracker) {
  const srcPersonasDir = path.join(sourceHome, 'personas');
  if (!fs.existsSync(srcPersonasDir)) return 0;
  const dstPersonasDir = path.join(stagedHome, 'personas');
  fs.mkdirSync(dstPersonasDir, { recursive: true });
  let count = 0;
  for (const pEntry of fs.readdirSync(srcPersonasDir, { withFileTypes: true })) {
    if (!pEntry.isDirectory()) continue;
    const personaId = pEntry.name;
    if (personaId.length >= 12) forbiddenPiiTokens.add(personaId);
    const srcPersonaMd = path.join(srcPersonasDir, personaId, 'persona.md');
    if (!fs.existsSync(srcPersonaMd)) continue;
    tracker.trackFile(srcPersonaMd);
    count += 1;
    const dstPDir = path.join(dstPersonasDir, personaId);
    fs.mkdirSync(dstPDir, { recursive: true });
    fs.writeFileSync(
      path.join(dstPDir, 'persona.md'),
      ['---', `name: "Persona ${count}"`, 'model_alias: "mock-fast"', 'thinking_effort: "high"', '---', `Neutral benchmark persona ${count}.`, ''].join('\n'),
      'utf8',
    );
    const srcPState = path.join(srcPersonasDir, personaId, 'state.json');
    if (fs.existsSync(srcPState)) {
      tracker.trackFile(srcPState);
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
  return count;
}

export async function stageFullKikiHome({
  mockBaseUrl,
  scratchRoot,
  stageMedia = false,
  seedLargeWorkspace = false,
  enableSessionTitle = false,
  enableSearch = true,
  isolateProcessEnv = true,
}) {
  const realOsHome = os.homedir();
  const sourceHome = process.env.KIKI_REAL_CORPUS_HOME ?? path.join(realOsHome, '.kiki');
  if (!fs.existsSync(sourceHome)) {
    throw new Error('Real KIKI_HOME corpus directory does not exist');
  }

  const forbiddenPiiTokens = new Set([os.userInfo().username, realOsHome, sourceHome]);
  const locksDir = path.join(sourceHome, 'session-locks');
  const tracker = createSourceImmutabilityTracker({ locksDir });
  const copyStats = { copiedFiles: 0, copiedBytes: 0 };

  const effectiveScratchBase = scratchRoot ?? process.env.KIKI_PERF_SCRATCH_DIR ?? os.tmpdir();
  const { sandboxRoot: tempRoot, homeDir: stagedHome, osHomeDir } = createIsolatedSandboxDirs(
    effectiveScratchBase,
    'kiki-perf-home-',
  );
  const reposRoot = path.join(tempRoot, 'repos');
  const repoPaths = createTempGitRepos(reposRoot, TEMP_GIT_REPO_COUNT);
  if (seedLargeWorkspace && repoPaths[0]) {
    seedDenseBenchRepo(repoPaths[0]);
  }

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
  if (fs.existsSync(locksDir)) {
    for (const name of fs.readdirSync(locksDir)) {
      if (name.endsWith('.lock')) activeLockFiles.add(name);
    }
  }

  const srcWorkspacesPath = path.join(sourceHome, 'workspaces.json');
  let rawWorkspaces = { version: 1, workspaces: {}, deleted_workspace_ids: [] };
  if (fs.existsSync(srcWorkspacesPath)) {
    tracker.trackFile(srcWorkspacesPath);
    try {
      rawWorkspaces = JSON.parse(fs.readFileSync(srcWorkspacesPath, 'utf8'));
    } catch {}
  }

  const sanitizedWorkspaces = {};
  let wsIdx = 0;
  for (const [wsId, entry] of Object.entries(rawWorkspaces.workspaces ?? {})) {
    forbiddenPiiTokens.add(wsId);
    if (entry && typeof entry.root === 'string' && entry.root.length >= 6) forbiddenPiiTokens.add(entry.root);
    wsIdx += 1;
    sanitizedWorkspaces[wsId] = {
      root: assignRepo(wsId),
      name: `workspace-${wsIdx}`,
      created_at: entry?.created_at ?? '2026-01-01T00:00:00.000Z',
      last_opened_at: entry?.last_opened_at ?? '2026-01-01T00:00:00.000Z',
      ...(entry?.pinned === true ? { pinned: true } : {}),
    };
  }

  const discoveredModels = new Set();
  const scannedPlans = [];
  const rawLargePngs = [];
  const rawRichSessions = [];
  const rawBlobrefPngs = [];
  const rawVoiceOggs = [];
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
        const srcStatePath = path.join(srcSessionDir, 'state.json');
        let sessionEntries;
        let stateStat;
        try {
          const dirStat = fs.statSync(srcSessionDir);
          stateStat = fs.statSync(srcStatePath);
          if (now - dirStat.mtimeMs < QUIESCENT_WINDOW_MS || now - stateStat.mtimeMs < QUIESCENT_WINDOW_MS) {
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

        let parsedState;
        try {
          parsedState = JSON.parse(fs.readFileSync(srcStatePath, 'utf8'));
        } catch {
          skippedSessions += 1;
          continue;
        }

        const srcAgentsDir = path.join(srcSessionDir, 'agents');
        let skipFromAgent = false;
        let mainWireBytes = 0;
        let totalWireBytes = 0;
        let mainCkptBytes = 0;
        let hasMainCkpt = false;
        let agentDirCount = 0;

        if (fs.existsSync(srcAgentsDir)) {
          let agentDirents = [];
          try {
            agentDirents = fs.readdirSync(srcAgentsDir, { withFileTypes: true });
          } catch {
            skipFromAgent = true;
          }
          for (const aDirent of agentDirents) {
            if (skipFromAgent || !aDirent.isDirectory()) continue;
            agentDirCount += 1;
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
            for (const ae of aEntries) {
              const aePath = path.join(aPath, ae.name);
              if (ae.isFile() && (ae.name === 'wire.jsonl' || ae.name === 'wire.transcript-receipt.json' || ae.name === 'wire.jsonl.generation')) {
                try {
                  const wst = fs.statSync(aePath);
                  if (now - wst.mtimeMs < QUIESCENT_WINDOW_MS) {
                    skipFromAgent = true;
                    break;
                  }
                  if (ae.name === 'wire.jsonl') {
                    totalWireBytes += wst.size;
                    if (aDirent.name === 'main') mainWireBytes += wst.size;
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
                  } catch {}
                }
              } else if (stageMedia && ae.isDirectory() && ae.name === 'blobs' && rawBlobrefPngs.length < 24) {
                try {
                  for (const bEntry of fs.readdirSync(aePath, { withFileTypes: true })) {
                    if (!bEntry.isFile() || !/^[0-9a-f]{64}$/u.test(bEntry.name)) continue;
                    const bPath = path.join(aePath, bEntry.name);
                    const bst = fs.statSync(bPath);
                    if (bst.size >= 512 * 1024 && bst.size <= 12 * 1048576 && isPngHeader(bPath)) {
                      rawBlobrefPngs.push({
                        wsId,
                        sessionId,
                        agentId: aDirent.name,
                        blobName: bEntry.name,
                        fileId: `blobref:${aDirent.name}:${bEntry.name}`,
                        sizeBytes: bst.size,
                        rawSrcPath: bPath,
                      });
                      if (rawBlobrefPngs.length >= 24) break;
                    }
                  }
                } catch {}
              }
            }
          }
        }

        if (skipFromAgent) {
          skippedSessions += 1;
          continue;
        }

        if (stageMedia) {
          const srcMediaDir = path.join(srcSessionDir, 'media');
          const needMediaSamples = rawLargePngs.length < 96 || rawVoiceOggs.length < 24 || rawRichSessions.length < 8;
          if (needMediaSamples && fs.existsSync(srcMediaDir)) {
            try {
              const mStat = fs.statSync(srcMediaDir);
              const metaDir = path.join(srcMediaDir, 'meta');
              if (now - mStat.mtimeMs >= QUIESCENT_WINDOW_MS && fs.existsSync(metaDir)) {
                const sessionImages = [];
                let sessionImageBytes = 0;
                for (const metaEntry of fs.readdirSync(metaDir, { withFileTypes: true })) {
                  if (!metaEntry.isFile() || !metaEntry.name.endsWith('.json')) continue;
                  const fileId = metaEntry.name.slice(0, -5);
                  if (!fileId.startsWith('f_')) continue;
                  const metaFile = path.join(metaDir, metaEntry.name);
                  let metaObj;
                  try {
                    metaObj = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
                  } catch {
                    continue;
                  }
                  if (!metaObj || typeof metaObj.key !== 'string') continue;
                  const binPath = path.join(srcMediaDir, metaObj.key);
                  let binStat;
                  try {
                    binStat = fs.statSync(binPath);
                  } catch {
                    continue;
                  }
                  const mediaType = String(metaObj.mediaType ?? '');
                  if (mediaType === 'image/png' || mediaType === 'image/jpeg') {
                    const imgRec = { wsId, sessionId, fileId, sizeBytes: binStat.size, mediaType, relKey: metaObj.key, metaFile, rawSrcPath: binPath };
                    sessionImages.push(imgRec);
                    sessionImageBytes += binStat.size;
                    if (binStat.size >= 512 * 1024) rawLargePngs.push(imgRec);
                  } else if ((mediaType.startsWith('audio/ogg') || binPath.toLowerCase().endsWith('.ogg')) && binStat.size >= 16 * 1024) {
                    rawVoiceOggs.push({
                      wsId,
                      sessionId,
                      fileId,
                      sizeBytes: binStat.size,
                      mediaType: mediaType || 'audio/ogg',
                      relKey: metaObj.key,
                      metaFile,
                      rawSrcPath: binPath,
                    });
                  }
                }
                if (sessionImages.length >= 8) {
                  sessionImages.sort((a, b) => b.sizeBytes - a.sizeBytes);
                  rawRichSessions.push({ wsId, sessionId, imageCount: sessionImages.length, totalImageBytes: sessionImageBytes, images: sessionImages.slice(0, 16) });
                }
              }
            } catch {}
          }
        }

        const agentsObj = parsedState.agents && typeof parsedState.agents === 'object' ? parsedState.agents : {};
        const mainMeta = agentsObj.main;
        const executor = parsedState.executorId ?? mainMeta?.executor ?? 'native';
        const hasExternalClient = Boolean(parsedState.custom?.externalClient);
        const dstSessionDir = path.join(stagedHome, 'sessions', wsId, sessionId);

        scannedPlans.push({
          wsId,
          sessionId,
          mappedRepo,
          srcSessionDir,
          srcStatePath,
          parsedState,
          stagedSessionDir: dstSessionDir,
          stateBytes: stateStat.size,
          mainWireBytes,
          totalWireBytes,
          mainCkptBytes,
          hasMainCkpt,
          agentCount: Math.max(agentDirCount, Object.keys(agentsObj).length),
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

  const toPublicSession = (p) => ({
    wsId: p.wsId,
    sessionId: p.sessionId,
    stagedSessionDir: p.stagedSessionDir,
    stateBytes: p.stateBytes,
    mainWireBytes: p.mainWireBytes,
    totalWireBytes: p.totalWireBytes,
    mainCkptBytes: p.mainCkptBytes,
    hasMainCkpt: p.hasMainCkpt,
    agentCount: p.agentCount,
    executor: p.executor,
    isNativeRunnable: p.isNativeRunnable,
  });

  const sortedByTotalWire = scannedPlans.map(toPublicSession).toSorted((a, b) => b.totalWireBytes - a.totalWireBytes);
  const openFanoutSamples = sortedByTotalWire.slice(0, Math.min(5, sortedByTotalWire.length));
  const nativeWithCkpt = sortedByTotalWire.filter(
    (s) => s.isNativeRunnable && s.hasMainCkpt && s.mainCkptBytes <= 450 * 1048576 && s.mainWireBytes >= 50 * 1048576,
  );
  const warmSendSample =
    nativeWithCkpt.find((s) => s.agentCount >= 250 && s.stateBytes >= 1024 * 1024 && s.mainWireBytes >= 150 * 1048576 && s.mainWireBytes <= 260 * 1048576) ??
    nativeWithCkpt.find((s) => s.agentCount >= 100 && s.mainWireBytes <= 260 * 1048576) ??
    nativeWithCkpt.find((s) => s.mainWireBytes <= 260 * 1048576) ??
    sortedByTotalWire.find((s) => s.isNativeRunnable && s.mainWireBytes <= 260 * 1048576);
  const coldMegaCandidates = nativeWithCkpt.filter(
    (s) => s.sessionId !== warmSendSample?.sessionId && s.totalWireBytes >= 300 * 1048576 && s.mainWireBytes >= 60 * 1048576 && s.mainWireBytes <= 240 * 1048576,
  );
  const coldDurableSample = coldMegaCandidates[0] ?? nativeWithCkpt.find((s) => s.sessionId !== warmSendSample?.sessionId) ?? warmSendSample;
  const coldSyncSample =
    coldMegaCandidates[1] ??
    nativeWithCkpt.find((s) => s.sessionId !== warmSendSample?.sessionId && s.sessionId !== coldDurableSample?.sessionId) ??
    coldDurableSample;

  const isolatedSessionIds = new Set([warmSendSample, coldDurableSample, coldSyncSample].filter(Boolean).map((t) => t.sessionId));
  const megaColdSessions = scannedPlans
    .map(toPublicSession)
    .filter((s) => !isolatedSessionIds.has(s.sessionId))
    .toSorted((a, b) => b.stateBytes - a.stateBytes);
  const megaRunnableFallback = megaColdSessions.find((s) => s.hasMainCkpt && s.mainWireBytes <= 300 * 1048576);
  const fullArtifactSessionIds = new Set(
    [...openFanoutSamples, warmSendSample, coldDurableSample, coldSyncSample, ...megaColdSessions.slice(0, 8), megaRunnableFallback]
      .filter(Boolean)
      .map((s) => s.sessionId),
  );

  for (const plan of scannedPlans) {
    const scope = { wsId: plan.wsId, sessionId: plan.sessionId };
    tracker.trackFile(plan.srcStatePath, scope);
    const { parsedState } = plan;
    if (typeof parsedState.cwd === 'string' && parsedState.cwd.length >= 6) forbiddenPiiTokens.add(parsedState.cwd);
    if (typeof parsedState.title === 'string' && parsedState.title.length >= 18) forbiddenPiiTokens.add(parsedState.title);
    parsedState.cwd = plan.mappedRepo;
    if ('workDir' in parsedState) parsedState.workDir = plan.mappedRepo;
    if ('worktree' in parsedState) delete parsedState.worktree;
    if (parsedState.custom && typeof parsedState.custom === 'object' && !Array.isArray(parsedState.custom) && 'cwd' in parsedState.custom) {
      parsedState.custom.cwd = plan.mappedRepo;
    }
    const agentsObj = parsedState.agents && typeof parsedState.agents === 'object' ? parsedState.agents : {};
    for (const aMeta of Object.values(agentsObj)) {
      if (aMeta && typeof aMeta === 'object') {
        if (typeof aMeta.model === 'string' && aMeta.model.length > 0) discoveredModels.add(aMeta.model);
        if (aMeta.labels && typeof aMeta.labels === 'object') {
          delete aMeta.labels.workDir;
          delete aMeta.labels.additionalDirs;
          delete aMeta.labels.agentWorkspaceRoots;
        }
      }
    }

    const isFullSession = fullArtifactSessionIds.has(plan.sessionId);
    fs.mkdirSync(plan.stagedSessionDir, { recursive: true });
    fs.writeFileSync(path.join(plan.stagedSessionDir, 'state.json'), JSON.stringify(parsedState), 'utf8');
    if (isFullSession) {
      copySessionOutcomes(plan.srcSessionDir, plan.stagedSessionDir, copyStats, tracker, scope);
    }
    stageSessionAgentTree(plan.srcSessionDir, plan.stagedSessionDir, copyStats, {
      fullWires: isFullSession,
      primaryAgentIds: ['main'],
      maxBackgroundMainWireBytes: BACKGROUND_MAIN_WIRE_MAX_BYTES,
      copyBlobs: false,
      tracker,
      scope,
    });
  }

  const keepNonIsolated = (arr) => arr.filter((item) => !isolatedSessionIds.has(item.sessionId));
  const selectedLargePngs = keepNonIsolated(rawLargePngs).toSorted((a, b) => b.sizeBytes - a.sizeBytes).slice(0, 24);
  const selectedRichSessions = keepNonIsolated(rawRichSessions).toSorted((a, b) => b.totalImageBytes - a.totalImageBytes).slice(0, 6);
  const selectedBlobrefPngs = keepNonIsolated(rawBlobrefPngs).toSorted((a, b) => b.sizeBytes - a.sizeBytes).slice(0, 16);
  const selectedVoiceOggs = keepNonIsolated(rawVoiceOggs).toSorted((a, b) => b.sizeBytes - a.sizeBytes).slice(0, 12);

  const stagedMediaPaths = new Map();
  const materializeCanonicalMedia = (item) => {
    const key = `${item.wsId}/${item.sessionId}/${item.fileId}`;
    let dstBin = stagedMediaPaths.get(key);
    if (!dstBin) {
      const scope = { wsId: item.wsId, sessionId: item.sessionId };
      const dstMediaRoot = path.join(stagedHome, 'sessions', item.wsId, item.sessionId, 'media');
      dstBin = path.join(dstMediaRoot, item.relKey);
      tracker.trackFile(item.metaFile, scope);
      tracker.trackFile(item.rawSrcPath, scope);
      copyOrCloneFile(item.metaFile, path.join(dstMediaRoot, 'meta', `${item.fileId}.json`), copyStats);
      copyOrCloneFile(item.rawSrcPath, dstBin, copyStats);
      stagedMediaPaths.set(key, dstBin);
    }
    return { wsId: item.wsId, sessionId: item.sessionId, fileId: item.fileId, sizeBytes: item.sizeBytes, mediaType: item.mediaType, srcPath: dstBin };
  };

  const canonicalLargePngs = selectedLargePngs.map(materializeCanonicalMedia);
  const voiceOggs = selectedVoiceOggs.map(materializeCanonicalMedia);
  const canonicalRichImageSessions = selectedRichSessions.map((rs) => ({
    wsId: rs.wsId,
    sessionId: rs.sessionId,
    imageCount: rs.imageCount,
    totalImageBytes: rs.totalImageBytes,
    images: rs.images.map((img) => {
      const staged = materializeCanonicalMedia(img);
      return { fileId: staged.fileId, sizeBytes: staged.sizeBytes, mediaType: staged.mediaType, srcPath: staged.srcPath };
    }),
  }));
  const blobrefPngs = selectedBlobrefPngs.map((item) => {
    const scope = { wsId: item.wsId, sessionId: item.sessionId };
    const dstBlob = path.join(stagedHome, 'sessions', item.wsId, item.sessionId, 'agents', item.agentId, 'blobs', item.blobName);
    tracker.trackFile(item.rawSrcPath, scope);
    copyOrCloneFile(item.rawSrcPath, dstBlob, copyStats);
    return { wsId: item.wsId, sessionId: item.sessionId, agentId: item.agentId, fileId: item.fileId, sizeBytes: item.sizeBytes, srcPath: dstBlob };
  });

  fs.writeFileSync(
    path.join(stagedHome, 'workspaces.json'),
    JSON.stringify({
      version: rawWorkspaces.version ?? 1,
      workspaces: sanitizedWorkspaces,
      deleted_workspace_ids: rawWorkspaces.deleted_workspace_ids ?? [],
    }),
    'utf8',
  );

  const stagedSessionIdSet = new Set(scannedPlans.map((s) => s.sessionId));
  const stagedPersonaCount = stagePersonas(sourceHome, stagedHome, stagedSessionIdSet, forbiddenPiiTokens, tracker);
  const userProfileCount = sanitizeAgentProfiles(sourceHome, stagedHome, tracker);
  stageSanitizedAgentsMd(sourceHome, stagedHome, tracker);
  fs.writeFileSync(path.join(stagedHome, 'config.toml'), buildConfigToml(mockBaseUrl, discoveredModels, enableSessionTitle, enableSearch), 'utf8');

  function cloneColdSession(sourceSession, cloneSessionId, overrides = {}) {
    const wsId = overrides.wsId ?? sourceSession.wsId;
    const dstDir = path.join(stagedHome, 'sessions', wsId, cloneSessionId);
    fs.mkdirSync(dstDir, { recursive: true });
    const rawState = JSON.parse(fs.readFileSync(path.join(sourceSession.stagedSessionDir, 'state.json'), 'utf8'));
    const nextState = {
      ...rawState,
      id: cloneSessionId,
      title: overrides.title ?? `Bench Session ${cloneSessionId}`,
      archived: overrides.archived ?? false,
      archivedAt: overrides.archived ? Date.now() : undefined,
      custom: overrides.custom ? { ...rawState.custom, ...overrides.custom } : rawState.custom,
    };
    const stateJson = JSON.stringify(nextState);
    fs.writeFileSync(path.join(dstDir, 'state.json'), stateJson, 'utf8');
    copySessionOutcomes(sourceSession.stagedSessionDir, dstDir, copyStats);
    const dstMainDir = path.join(dstDir, 'agents', 'main');
    fs.mkdirSync(dstMainDir, { recursive: true });
    if (overrides.copyMainArtifacts !== false) {
      const srcMainDir = path.join(sourceSession.stagedSessionDir, 'agents', 'main');
      for (const rel of ['wire.transcript-receipt.json', 'wire.jsonl.generation']) {
        const p = path.join(srcMainDir, rel);
        if (fs.existsSync(p)) copyOrCloneFile(p, path.join(dstMainDir, rel), copyStats);
      }
      const srcWire = path.join(srcMainDir, 'wire.jsonl');
      if (overrides.copyMainWire === true && fs.existsSync(srcWire)) {
        copyOrCloneFile(srcWire, path.join(dstMainDir, 'wire.jsonl'), copyStats);
        const srcCkpt = path.join(srcMainDir, 'replay-checkpoints', 'engine-v1');
        if (fs.existsSync(srcCkpt)) {
          copyOrCloneFile(srcCkpt, path.join(dstMainDir, 'replay-checkpoints', 'engine-v1'), copyStats);
        }
      } else {
        writeMinimalWireMetadata(path.join(dstMainDir, 'wire.jsonl'), Date.now());
      }
    }
    return {
      wsId,
      sessionId: cloneSessionId,
      stagedSessionDir: dstDir,
      stateBytes: Buffer.byteLength(stateJson, 'utf8'),
      agentCount: sourceSession.agentCount,
      cwd: nextState.cwd,
    };
  }

  const restoreOsHome = isolateProcessEnv ? isolateProcessOsHome(osHomeDir) : () => {};
  const serverEnv = buildIsolatedPerfEnv({ homeDir: stagedHome, osHomeDir });
  const verifySourceMutations = () => tracker.verify().mutations;
  const teardown = createSandboxTeardown(tempRoot, () => {
    restoreOsHome();
    return verifySourceMutations();
  });

  return {
    stagedHome,
    osHomeDir,
    serverEnv,
    defaultRepoCwd: repoPaths[0],
    sampleWorkspaceId: Object.keys(sanitizedWorkspaces)[0],
    forbiddenPiiTokens,
    inventory: {
      sessionsStaged: scannedPlans.length,
      sessionsSkipped: skippedSessions,
      workspacesRegistered: Object.keys(sanitizedWorkspaces).length,
      tempGitRepos: repoPaths.length,
      personasStaged: stagedPersonaCount,
      userProfilesStaged: userProfileCount,
      fingerprintedSourceFiles: tracker.trackedFileCount,
      copiedFiles: copyStats.copiedFiles,
      copiedMB: Math.round(copyStats.copiedBytes / 1048576),
      hardlinkedFiles: 0,
      junctionCount: 0,
      maxStateKB: Math.round(Math.max(0, ...scannedPlans.map((s) => s.stateBytes)) / 1024),
      maxAgents: Math.max(0, ...scannedPlans.map((s) => s.agentCount)),
      sessionsOver300MB: scannedPlans.filter((s) => s.totalWireBytes >= 300 * 1048576).length,
    },
    samples: {
      openFanout: openFanoutSamples,
      warmSend: warmSendSample,
      coldDurableSend: coldDurableSample,
      coldSyncSend: coldSyncSample,
      megaColdSessions: megaColdSessions.slice(0, 8),
      canonicalLargePngs,
      canonicalRichImageSessions,
      blobrefPngs,
      voiceOggs,
    },
    cloneColdSession,
    verifySourceMutations,
    teardown,
  };
}
