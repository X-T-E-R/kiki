import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import { buildIsolatedPerfEnv } from './perf/sandbox-stager.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

if (process.env.KIKI_PERF_DETAIL_TSX_READY !== '1') {
  const loaderUrl = pathToFileURL(path.join(REPO_ROOT, 'build', 'register-raw-text-loader.mjs')).href;
  const realCorpusHome = process.env.KIKI_REAL_CORPUS_HOME ?? path.join(os.homedir(), '.kiki');
  const child = spawnSync(
    process.execPath,
    [
      '--max-old-space-size=8192',
      '--import',
      'tsx/esm',
      '--import',
      loaderUrl,
      __filename,
      ...process.argv.slice(2),
    ],
    {
      cwd: REPO_ROOT,
      env: buildIsolatedPerfEnv({
        extra: { KIKI_PERF_DETAIL_TSX_READY: '1', KIKI_REAL_CORPUS_HOME: realCorpusHome },
      }),
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  process.exit(child.status ?? 1);
}

const { enableIndependentWorkerHeaps } = await import(
  '../packages/agent-core-v2/src/_base/node/workerHeapPolicy.ts'
);
enableIndependentWorkerHeaps();

const [
  { startServer },
  { ISessionIndex, ISessionManager },
  { configureCpuWorkerRuntime },
  mediaPreviewMod,
  { fileToImageAttachment },
  { buildSlashItems, filterSlashItems },
  { startMockSseProvider },
  { stageFullKikiHome },
  { EventLoopMonitor, assertZeroPii, roundMs },
  { prepareDetailWorkspaceFixtures, seedCanonicalGallerySessionViaApi },
  { runDetailUxApiSuite },
  { runDetailUxBrowserSuite },
] = await Promise.all([
  import('../packages/kap-server/src/start.ts'),
  import('../packages/agent-core-v2/src/index.ts'),
  import('../packages/agent-core-v2/src/app/cpuWorker/protocol.ts'),
  import('../packages/kap-server/src/services/mediaPreview.ts'),
  import('../packages/session-core/src/composer/attachments.ts'),
  import('../packages/session-core/src/commands/slashCommands.ts'),
  import('./perf-home/mock-sse.mjs'),
  import('./perf-home/stage-home.mjs'),
  import('./perf-home/stats.mjs'),
  import('./perf-home/detail-ux-fixtures.mjs'),
  import('./perf-home/detail-ux-api-bench.mjs'),
  import('./perf-home/detail-ux-browser-bench.mjs'),
]);

const builtCpuWorkerPath = path.join(REPO_ROOT, 'packages', 'node-sdk', 'dist', 'cpu-worker.mjs');
if (fs.existsSync(builtCpuWorkerPath)) {
  configureCpuWorkerRuntime({ entry: builtCpuWorkerPath });
}

function parseArgs(argv) {
  let outPath = null;
  let skipBrowser = false;
  let scratchDir = process.env.KIKI_PERF_SCRATCH_DIR ?? path.join(REPO_ROOT, '.tmp', 'perf-detail-ux');
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out' && argv[i + 1]) {
      outPath = path.resolve(argv[i + 1]);
      i += 1;
    } else if (argv[i] === '--scratch' && argv[i + 1]) {
      scratchDir = path.resolve(argv[i + 1]);
      i += 1;
    } else if (argv[i] === '--api-only') {
      skipBrowser = true;
    }
  }
  return { outPath, skipBrowser, scratchDir };
}

async function main() {
  const { outPath, skipBrowser, scratchDir } = parseArgs(process.argv.slice(2));
  const progress = (msg) => process.stderr.write(`[perf-detail-ux] ${msg}\n`);
  fs.mkdirSync(scratchDir, { recursive: true });

  const mockSse = await startMockSseProvider();
  const stageT0 = performance.now();
  const staged = await stageFullKikiHome({
    mockBaseUrl: mockSse.baseUrl,
    scratchRoot: scratchDir,
    stageMedia: true,
    seedLargeWorkspace: true,
    enableSessionTitle: true,
    enableSearch: false,
  });
  const stagingMs = roundMs(performance.now() - stageT0);
  progress(
    `staged ${staged.inventory.sessionsStaged} sessions, ${staged.samples.canonicalLargePngs.length} large PNGs, ${staged.samples.blobrefPngs.length} blobref PNGs, ${staged.samples.voiceOggs.length} voice oggs in ${stagingMs}ms`,
  );

  const mega10Mb = staged.samples.megaColdSessions[0] ?? staged.samples.openFanout[0];
  const megaRunnable =
    staged.samples.coldDurableSend ??
    staged.samples.megaColdSessions.find((s) => s.hasMainCkpt && s.mainWireBytes <= 300 * 1048576) ??
    mega10Mb;
  const workspacesFile = JSON.parse(fs.readFileSync(path.join(staged.stagedHome, 'workspaces.json'), 'utf8'));
  const runnableRepoRoot = workspacesFile.workspaces?.[megaRunnable.wsId]?.root ?? staged.defaultRepoCwd;

  const fixtures = prepareDetailWorkspaceFixtures({
    staged,
    scratchDir: path.join(staged.stagedHome, '.bench-scratch'),
    extraRepoRoots: [runnableRepoRoot],
  });

  const nowMs = Date.now();
  const clones = {
    coldRenameMega: staged.cloneColdSession(mega10Mb, 'bench_mega_rename'),
    coldPrivacyMega: staged.cloneColdSession(mega10Mb, 'bench_mega_privacy'),
    coldArchiveRestoreMega: staged.cloneColdSession(megaRunnable, 'bench_mega_restore', {
      copyMainWire: true,
    }),
    coldFsReadMega: staged.cloneColdSession(megaRunnable, 'bench_mega_fsread', {
      copyMainWire: true,
    }),
    coldDocPreviewMega: staged.cloneColdSession(megaRunnable, 'bench_mega_docpreview', {
      copyMainWire: true,
    }),
    coldModelSwitchMega: staged.cloneColdSession(megaRunnable, 'bench_mega_modelswitch', {
      copyMainWire: true,
    }),
    coldAtMentionMega: staged.cloneColdSession(megaRunnable, 'bench_mega_atmention', {
      copyMainWire: true,
    }),
    coldSkillsMega: staged.cloneColdSession(megaRunnable, 'bench_mega_skills', {
      copyMainWire: true,
    }),
    familyRoot: staged.cloneColdSession(mega10Mb, 'bench_family_root'),
    familyChildren: [1, 2, 3, 4].map((idx) =>
      staged.cloneColdSession(megaRunnable, `bench_family_child_${idx}`, {
        custom: { created_by_session_id: 'bench_family_root' },
      }),
    ),
    batchSessions: [1, 2, 3, 4, 5].map((idx) =>
      staged.cloneColdSession(megaRunnable, `bench_batch_${idx}`),
    ),
  };

  const browserClones = {
    coldComposerMega: staged.cloneColdSession(megaRunnable, 'bench_browser_composer_mega', {
      copyMainWire: true,
    }),
    sidebarTargetMega: staged.cloneColdSession(megaRunnable, 'bench_browser_sidebar_mega', {
      title: 'Sidebar Mega Target',
      copyMainWire: true,
    }),
  };
  {
    const bigAgents = JSON.parse(fs.readFileSync(path.join(mega10Mb.stagedSessionDir, 'state.json'), 'utf8')).agents ?? {};
    for (const target of [clones.coldArchiveRestoreMega, browserClones.sidebarTargetMega]) {
      const sbPath = path.join(target.stagedSessionDir, 'state.json');
      const sbState = JSON.parse(fs.readFileSync(sbPath, 'utf8'));
      const keepMain = sbState.agents?.main;
      sbState.agents = { ...bigAgents, ...(keepMain ? { main: keepMain } : {}) };
      if (target === browserClones.sidebarTargetMega) {
        sbState.updatedAt = nowMs + 60_000;
      }
      const serializedState = JSON.stringify(sbState);
      fs.writeFileSync(sbPath, serializedState, 'utf8');
      target.stateBytes = Buffer.byteLength(serializedState, 'utf8');
      target.agentCount = Object.keys(sbState.agents).length;
    }
  }

  const elMonitor = new EventLoopMonitor();
  let server;
  let sourceMutations = -1;

  const report = {
    timestamp: new Date().toISOString(),
    stagingMs,
    inventory: {
      ...staged.inventory,
      canonicalLargePngsFound: staged.samples.canonicalLargePngs.length,
      blobrefPngsFound: staged.samples.blobrefPngs.length,
      voiceOggsFound: staged.samples.voiceOggs.length,
    },
    apiSuite: null,
    browserSuite: null,
    safety: {
      sourceMutations: -1,
    },
  };

  try {
    const { ensureGuiStaticBuild } = await import('./perf/browser-runner.mjs');
    const guiBuild = ensureGuiStaticBuild();
    const serverEnv = staged.serverEnv;
    server = await startServer({
      hostIdentity: {
        productName: 'kiki-perf-detail-ux',
        version: '0.0.0-bench',
        platform: process.platform,
      },
      host: '127.0.0.1',
      port: 0,
      homeDir: staged.stagedHome,
      webAssetsDir: guiBuild.distDir,
      env: serverEnv,
      runtimeManaged: false,
      logLevel: 'silent',
    });
    await server.core.accessor.get(ISessionIndex).prepare();

    const baseUrl = `http://127.0.0.1:${server.port}`;
    const authHeaders = { authorization: `Bearer ${server.localOwnerToken}` };
    const manager = server.core.accessor.get(ISessionManager);

    progress('seeding real 12-image + attachment gallery session via API...');
    const gallerySession = await seedCanonicalGallerySessionViaApi({
      baseUrl,
      authHeaders,
      mockSse,
      manager,
      fixtures,
    });

    report.apiSuite = await runDetailUxApiSuite({
      server,
      baseUrl,
      authHeaders,
      staged,
      fixtures,
      gallerySession,
      clones,
      elMonitor,
      fileToImageAttachment,
      buildSlashItems,
      filterSlashItems,
      clearServerMediaPreviewMemoryCache: mediaPreviewMod.clearMediaPreviewMemoryCacheForTest,
      progress,
    });

    if (outPath) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }

    if (!skipBrowser) {
      report.browserSuite = await runDetailUxBrowserSuite({
        endpoint: baseUrl,
        token: server.localOwnerToken,
        fixtures,
        gallerySession,
        browserClones,
        clearServerMediaPreviewCache: async () => {
          mediaPreviewMod.clearMediaPreviewMemoryCacheForTest?.();
          const diskCacheDir = path.join(staged.stagedHome, 'cache', 'media-previews-v1');
          fs.rmSync(diskCacheDir, { recursive: true, force: true });
        },
        progress,
      });
    }
  } finally {
    elMonitor.close();
    if (server) {
      await server.close();
    }
    await mockSse.close();
    sourceMutations = staged.teardown();
  }

  report.safety.sourceMutations = sourceMutations;
  assert.equal(sourceMutations, 0, `Expected 0 source mutations on ~/.kiki, got ${sourceMutations}`);

  const serialized = JSON.stringify(report, null, 2);
  assertZeroPii(serialized, staged.forbiddenPiiTokens);

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${serialized}\n`, 'utf8');
    progress(`saved report to ${outPath}`);
  }
  process.stdout.write(`${serialized}\n`);
}

main().catch((error) => {
  process.stderr.write(`[perf-detail-ux] FAILED: ${error?.stack ?? error}\n`);
  process.exit(1);
});
