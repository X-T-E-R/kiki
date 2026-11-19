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
  const templateDir = path.join(reposRoot, '_template');
  fs.mkdirSync(templateDir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: templateDir, windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'bench@example.test'], { cwd: templateDir, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'Bench'], { cwd: templateDir, windowsHide: true });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/bench-repo.git'], {
    cwd: templateDir,
    windowsHide: true,
  });
  fs.writeFileSync(path.join(templateDir, 'README.md'), '# Bench Repo\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: templateDir, windowsHide: true });
  execFileSync('git', ['commit', '-q', '-m', 'chore: seed bench repo'], {
    cwd: templateDir,
    windowsHide: true,
  });

  const repoPaths = [];
  for (let i = 0; i < count; i += 1) {
    const repoDir = path.join(reposRoot, `repo-${String(i).padStart(2, '0')}`);
    fs.cpSync(templateDir, repoDir, { recursive: true });
    if (i % 2 === 1) {
      fs.writeFileSync(path.join(repoDir, 'dirty-note.txt'), `dirty-${i}\n`, 'utf8');
    }
    repoPaths.push(repoDir);
  }
  fs.rmSync(templateDir, { recursive: true, force: true });
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
  lines.push(`enabled = ${enableSearch ? 'true' : 'false'}`);
  lines.push('');
  if (enableSessionTitle) {
    lines.push('[session_title]');
    lines.push('model = "mock-fast"');
    lines.push('triggers = []');
    lines.push('');
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
      const fileName = `feature_${String(mod).padStart(3, '0')}.${ext}`;
      fs.writeFileSync(
        path.join(subDir, fileName),
        `export const feature_${pkg}_${mod} = ${mod};\nexport function renderView${mod}(): string { return 'ok-${pkg}-${mod}'; }\n`,
        'utf8',
      );
    }
  }
  const docsDir = path.join(repoDir, 'docs', 'guides');
  fs.mkdirSync(docsDir, { recursive: true });
  for (let d = 0; d < 80; d += 1) {
    fs.writeFileSync(
      path.join(docsDir, `guide-${String(d).padStart(2, '0')}.md`),
      `# Guide ${d}\n\nDeterministic benchmark guide content ${d}.\n`,
      'utf8',
    );
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
      head[0] === 0x89 &&
      head[1] === 0x50 &&
      head[2] === 0x4e &&
      head[3] === 0x47 &&
      head[4] === 0x0d &&
      head[5] === 0x0a &&
      head[6] === 0x1a &&
      head[7] === 0x0a
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

function isolateSessionForMutation(stagedSessionDir, junctionsSet, linkedFingerprintsBySession, sessionKey) {
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
  if (fs.existsSync(stagedSessionDir)) {
    walk(stagedSessionDir);
  }
}

export async function stageFullKikiHome({
  mockBaseUrl,
  scratchRoot,
  stageMedia = false,
  seedLargeWorkspace = false,
  enableSessionTitle = false,
  enableSearch = true,
}) {
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

  const effectiveScratchBase = scratchRoot ?? process.env.KIKI_PERF_SCRATCH_DIR ?? os.tmpdir();
  fs.mkdirSync(effectiveScratchBase, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(effectiveScratchBase, 'kiki-perf-home-'));
  const stagedHome = path.join(tempRoot, 'home');
  const reposRoot = path.join(tempRoot, 'repos');
  fs.mkdirSync(stagedHome, { recursive: true });

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
  const canonicalLargePngs = [];
  const canonicalRichImageSessions = [];
  const blobrefPngs = [];
  const voiceOggs = [];
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
            if (stageMedia && d.rel === 'blobs' && blobrefPngs.length < 24) {
              try {
                for (const bEntry of fs.readdirSync(d.src, { withFileTypes: true })) {
                  if (!bEntry.isFile() || !/^[0-9a-f]{64}$/u.test(bEntry.name)) continue;
                  const bPath = path.join(d.src, bEntry.name);
                  const bst = fs.statSync(bPath);
                  if (bst.size >= 512 * 1024 && bst.size <= 12 * 1048576 && isPngHeader(bPath)) {
                    blobrefPngs.push({
                      wsId,
                      sessionId,
                      agentId: plan.agentId,
                      fileId: `blobref:${plan.agentId}:${bEntry.name}`,
                      sizeBytes: bst.size,
                      srcPath: bPath,
                    });
                    recordFingerprint(sessionLinkedMap, bPath);
                    recordFingerprint(fingerprints, bPath);
                    if (blobrefPngs.length >= 24) break;
                  }
                }
              } catch {}
            }
          }
        }

        if (stageMedia) {
          const srcMediaDir = path.join(srcSessionDir, 'media');
          if (fs.existsSync(srcMediaDir)) {
            try {
              const mStat = fs.statSync(srcMediaDir);
              if (now - mStat.mtimeMs >= QUIESCENT_WINDOW_MS) {
                sessionLinkedMap.set(srcMediaDir, { size: mStat.size, mtimeMs: mStat.mtimeMs, isDir: true });
                const dstMediaJunction = path.join(dstSessionDir, 'media');
                fs.symlinkSync(srcMediaDir, dstMediaJunction, 'junction');
                junctions.add(dstMediaJunction);
                const metaDir = path.join(srcMediaDir, 'meta');
                const needMediaSamples =
                  canonicalLargePngs.length < 96 || voiceOggs.length < 24 || canonicalRichImageSessions.length < 3;
                if (needMediaSamples && fs.existsSync(metaDir)) {
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
                      sessionImages.push({ fileId, sizeBytes: binStat.size, mediaType, srcPath: binPath });
                      sessionImageBytes += binStat.size;
                      if (binStat.size >= 512 * 1024) {
                        canonicalLargePngs.push({
                          wsId,
                          sessionId,
                          fileId,
                          sizeBytes: binStat.size,
                          mediaType,
                          srcPath: binPath,
                        });
                        recordFingerprint(sessionLinkedMap, binPath);
                        recordFingerprint(fingerprints, binPath);
                      }
                    } else if (mediaType.startsWith('audio/ogg') || binPath.toLowerCase().endsWith('.ogg')) {
                      if (binStat.size >= 16 * 1024) {
                        voiceOggs.push({
                          wsId,
                          sessionId,
                          fileId,
                          sizeBytes: binStat.size,
                          mediaType: mediaType || 'audio/ogg',
                          srcPath: binPath,
                        });
                        recordFingerprint(sessionLinkedMap, binPath);
                        recordFingerprint(fingerprints, binPath);
                      }
                    }
                  }
                  if (sessionImages.length >= 8) {
                    sessionImages.sort((a, b) => b.sizeBytes - a.sizeBytes);
                    canonicalRichImageSessions.push({
                      wsId,
                      sessionId,
                      imageCount: sessionImages.length,
                      totalImageBytes: sessionImageBytes,
                      images: sessionImages.slice(0, 16),
                    });
                  }
                }
              }
            } catch {}
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

  fs.writeFileSync(
    path.join(stagedHome, 'config.toml'),
    buildConfigToml(mockBaseUrl, discoveredModels, enableSessionTitle, enableSearch),
    'utf8',
  );

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

  const isolatedTargets = new Set([warmSendSample, coldDurableSample, coldSyncSample].filter(Boolean));
  const isolatedSessionIds = new Set([...isolatedTargets].map((t) => t.sessionId));
  for (const target of isolatedTargets) {
    isolateSessionForMutation(
      target.stagedSessionDir,
      junctions,
      linkedFingerprintsBySession,
      `${target.wsId}/${target.sessionId}`,
    );
  }

  const sampleWorkspaceId = Object.keys(sanitizedWorkspaces)[0];

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
    const srcOutcomes = path.join(sourceSession.stagedSessionDir, 'agent-outcomes');
    if (fs.existsSync(srcOutcomes)) {
      const dstOutcomes = path.join(dstDir, 'agent-outcomes');
      fs.mkdirSync(dstOutcomes, { recursive: true });
      for (const entry of fs.readdirSync(srcOutcomes, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.json')) {
          fs.copyFileSync(path.join(srcOutcomes, entry.name), path.join(dstOutcomes, entry.name));
        }
      }
    }
    const dstMainDir = path.join(dstDir, 'agents', 'main');
    fs.mkdirSync(dstMainDir, { recursive: true });
    if (overrides.copyMainArtifacts !== false) {
      const srcMainDir = path.join(sourceSession.stagedSessionDir, 'agents', 'main');
      for (const rel of ['wire.transcript-receipt.json', 'wire.jsonl.generation']) {
        const p = path.join(srcMainDir, rel);
        if (fs.existsSync(p)) fs.copyFileSync(p, path.join(dstMainDir, rel));
      }
      const srcWire = path.join(srcMainDir, 'wire.jsonl');
      if (overrides.copyMainWire === true && fs.existsSync(srcWire)) {
        fs.copyFileSync(srcWire, path.join(dstMainDir, 'wire.jsonl'));
        const srcCkpt = path.join(srcMainDir, 'replay-checkpoints', 'engine-v1');
        if (fs.existsSync(srcCkpt)) {
          fs.mkdirSync(path.join(dstMainDir, 'replay-checkpoints'), { recursive: true });
          fs.copyFileSync(srcCkpt, path.join(dstMainDir, 'replay-checkpoints', 'engine-v1'));
        }
      } else {
        const initLine = `${JSON.stringify({
          time: Date.now(),
          type: 'metadata',
          payload: { protocolVersion: '1.3' },
        })}\n`;
        fs.writeFileSync(path.join(dstMainDir, 'wire.jsonl'), initLine, 'utf8');
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

  const keepNonIsolated = (arr) => arr.filter((item) => !isolatedSessionIds.has(item.sessionId));
  const validLargePngs = keepNonIsolated(canonicalLargePngs).sort((a, b) => b.sizeBytes - a.sizeBytes);
  const validRichSessions = keepNonIsolated(canonicalRichImageSessions).sort(
    (a, b) => b.totalImageBytes - a.totalImageBytes,
  );
  const validBlobrefPngs = keepNonIsolated(blobrefPngs).sort((a, b) => b.sizeBytes - a.sizeBytes);
  const validVoiceOggs = keepNonIsolated(voiceOggs).sort((a, b) => b.sizeBytes - a.sizeBytes);
  const megaColdSessions = [...stagedSessions]
    .filter((s) => !isolatedSessionIds.has(s.sessionId))
    .sort((a, b) => b.stateBytes - a.stateBytes);

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
      megaColdSessions: megaColdSessions.slice(0, 8),
      canonicalLargePngs: validLargePngs.slice(0, 24),
      canonicalRichImageSessions: validRichSessions.slice(0, 6),
      blobrefPngs: validBlobrefPngs.slice(0, 16),
      voiceOggs: validVoiceOggs.slice(0, 12),
    },
    cloneColdSession,
    verifySourceMutations,
    teardown,
  };
}
