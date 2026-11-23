import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  bootstrapOps,
  callLocalApi,
  classifyRuntimeServerPath,
  ensureSearchDisabledConfig,
  inspectRuntime,
  parseConductorArgs,
  reconcileSwitch,
  rollbackRuntime,
  sanitizeOpsConfigToml,
  switchRuntime,
} from './kiki-ops-conductor.mjs';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const tempBase = join(repoRoot, '.tmp', 'kiki-ops-conductor-tests');
mkdirSync(tempBase, { recursive: true });

const TOKEN = 'A'.repeat(43);
const OLD_COMMIT = '1'.repeat(40);
const NEW_COMMIT = '2'.repeat(40);

function makeTemp() {
  return mkdtempSync(join(tempBase, 'case-'));
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function writeCandidate(dir, commit, desktopContent, serverContent) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'kiki-desktop.exe'), desktopContent);
  writeFileSync(join(dir, 'kiki-server.exe'), serverContent);
  const dHash = sha256(desktopContent);
  const sHash = sha256(serverContent);
  const receipt = {
    schemaVersion: 1,
    sourceCommit: commit,
    acceptanceRef: 'fixture://acceptance',
    checkRef: 'fixture://check',
    files: {
      'kiki-desktop.exe': { sha256: dHash, bytes: Buffer.byteLength(desktopContent) },
      'kiki-server.exe': { sha256: sHash, bytes: Buffer.byteLength(serverContent) },
    },
  };
  writeFileSync(join(dir, 'desktop-build-receipt.json'), JSON.stringify(receipt, null, 2));
  return `${dHash.slice(0, 24)}-${sHash.slice(0, 24)}`;
}

function seedActive(runtimeRoot, releaseId, commit, desktopContent, serverContent) {
  const activeDir = join(runtimeRoot, 'active');
  mkdirSync(activeDir, { recursive: true });
  writeFileSync(join(activeDir, 'kiki-desktop.exe'), desktopContent);
  writeFileSync(join(activeDir, 'kiki-server.exe'), serverContent);
  writeFileSync(join(activeDir, 'build-info.txt'), `gitSha: ${commit}`);
  writeFileSync(
    join(activeDir, 'active-release.json'),
    JSON.stringify({ schemaVersion: 1, releaseId, gitSha: commit, syncedAtUtc: new Date().toISOString() }),
  );
  writeFileSync(
    join(runtimeRoot, 'current.json'),
    JSON.stringify({ schemaVersion: 1, releaseId, gitSha: commit, promotedAtUtc: new Date().toISOString() }),
  );
}

async function startFixtureHttpServer(state) {
  const receivedPrompts = [];
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 40101, msg: 'unauthorized', data: null }));
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const body = rawBody ? JSON.parse(rawBody) : null;
      const sendOk = (data) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 0, msg: 'ok', data }));
      };

      if (req.method === 'GET' && url.pathname === '/api/healthz') {
        if (state.healthzStatus && state.healthzStatus !== 200) {
          res.writeHead(state.healthzStatus, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 50301, msg: 'unhealthy', data: { ok: false } }));
          return;
        }
        if (state.healthzOk === false) {
          sendOk({ ok: false });
          return;
        }
        sendOk({ ok: true });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/meta') {
        sendOk({
          server_id: state.serverId,
          server_home_id: 'home-1',
          current_space_id: 'main',
          server_version: '0.5.0-test',
          desktop_managed: true,
          dangerous_bypass_auth: false,
          build_id: state.buildId,
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/desktop-lifecycle') {
        sendOk({
          server_id: state.serverId,
          home_id: 'main',
          managed: true,
          draining: false,
          hot_switch_prepared: false,
          work_pending: state.workPending ?? [],
          impact: 'all-windows-in-this-space',
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions/query') {
        if (state.failSessionsQuery) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 50001, msg: 'simulated query error', data: null }));
          return;
        }
        const pageSize = Number(url.searchParams.get('page_size') ?? '50');
        if (pageSize > 100) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 40001, msg: 'page_size must be at most 100 without the ids projection', data: null }));
          return;
        }
        if (Array.isArray(state.sessionsQueryPages)) {
          const tokenParam = url.searchParams.get('page_token');
          const pageIndex = tokenParam ? Number(tokenParam.replace(/^p/, '')) : 0;
          const items = state.sessionsQueryPages[pageIndex] ?? [];
          const nextPage = pageIndex + 1 < state.sessionsQueryPages.length ? `p${pageIndex + 1}` : null;
          sendOk({ items, ...(nextPage ? { next_page_token: nextPage } : {}) });
          return;
        }
        sendOk({ items: state.sessionsQuery ?? [] });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/klient/call') {
        const sid = body?.procedure?.sessionId;
        const control = state.controls?.[sid] ?? { phase: 'running', agents: [] };
        sendOk(control);
        return;
      }
      const subagentsMatch = /^\/api\/sessions\/([^/]+)\/subagents$/.exec(url.pathname);
      if (req.method === 'GET' && subagentsMatch) {
        const sid = decodeURIComponent(subagentsMatch[1]);
        const list = state.subagents?.[sid] ?? [];
        sendOk({ items: list, total: list.length, matched: list.length });
        return;
      }
      const agentTasksMatch = /^\/api\/sessions\/([^/]+)\/agent-tasks$/.exec(url.pathname);
      if (req.method === 'GET' && agentTasksMatch) {
        const sid = decodeURIComponent(agentTasksMatch[1]);
        const items = state.agentTasks?.[sid] ?? [];
        sendOk({ items, has_more: false });
        return;
      }
      const tasksMatch = /^\/api\/sessions\/([^/]+)\/tasks$/.exec(url.pathname);
      if (req.method === 'GET' && tasksMatch) {
        const sid = decodeURIComponent(tasksMatch[1]);
        sendOk({ items: state.tasks?.[sid] ?? [] });
        return;
      }
      const promptMatch = /^\/api\/sessions\/([^/]+)\/prompts$/.exec(url.pathname);
      if (req.method === 'POST' && promptMatch) {
        const sid = decodeURIComponent(promptMatch[1]);
        receivedPrompts.push({
          sessionId: sid,
          receiptQuery: url.searchParams.get('receipt'),
          body,
        });
        sendOk({
          prompt_id: body.prompt_id,
          admission: 'restoring',
          append_timing: body.append_timing,
        });
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 40404, msg: 'not found', data: null }));
    });
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  return {
    port: address.port,
    receivedPrompts,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

function registerInstance(kikiHome, { serverId, pid, port, buildId }) {
  mkdirSync(join(kikiHome, 'server', 'instances'), { recursive: true });
  writeFileSync(join(kikiHome, 'server.local-owner'), `${TOKEN}\n`);
  writeFileSync(
    join(kikiHome, 'server', 'instances', `${serverId}.json`),
    JSON.stringify({
      server_id: serverId,
      pid,
      host: '127.0.0.1',
      port,
      started_at: Date.now(),
      heartbeat_at: Date.now(),
      build_id: buildId,
    }),
  );
}

test('bootstrapOps provisions isolated Kiki-Ops CLI copy and search-disabled config', () => {
  const root = makeTemp();
  try {
    const liveRuntime = join(root, 'Kiki');
    const liveHome = join(root, '.kiki');
    const opsRuntime = join(root, 'Kiki-Ops');
    const opsHome = join(root, '.kiki-ops');
    mkdirSync(join(liveRuntime, 'cli'), { recursive: true });
    const cliBytes = 'kiki-cli-binary-payload-v1';
    writeFileSync(join(liveRuntime, 'cli', 'kiki.exe'), cliBytes);

    // Refuses to bootstrap into live runtime or live home.
    assert.throws(
      () =>
        bootstrapOps({
          opsRuntime: liveRuntime,
          opsHome,
          sourceRuntime: liveRuntime,
          targetRuntime: liveRuntime,
          targetHome: liveHome,
        }),
      /Refusing to bootstrap Kiki-Ops into the live target runtime/,
    );
    assert.throws(
      () =>
        bootstrapOps({
          opsRuntime,
          opsHome: liveHome,
          sourceRuntime: liveRuntime,
          targetRuntime: liveRuntime,
          targetHome: liveHome,
        }),
      /Refusing to bootstrap Kiki-Ops into the live target home/,
    );

    const res = bootstrapOps({
      opsRuntime,
      opsHome,
      sourceRuntime: liveRuntime,
      targetRuntime: liveRuntime,
      targetHome: liveHome,
    });
    assert.equal(res.ok, true);
    assert.equal(existsSync(res.cliPath), true);
    assert.equal(existsSync(res.launcherPath), true);
    const launcherText = readFileSync(res.launcherPath, 'utf8');
    assert.match(launcherText, /KIKI_HOME=/);
    assert.match(launcherText, /--home "/);
    assert.equal(lstatSync(res.cliPath).isSymbolicLink(), false);
    assert.equal(readFileSync(res.cliPath, 'utf8'), cliBytes);
    assert.equal(res.sha256, sha256(cliBytes));

    const manifest = JSON.parse(readFileSync(res.manifestPath, 'utf8'));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.sha256, sha256(cliBytes));

    const configText = readFileSync(res.configPath, 'utf8');
    assert.match(configText, /\[search\]\s*\nenabled = false/);

    // Updating an existing config.toml preserves unrelated sections while disabling search.
    writeFileSync(res.configPath, '[general]\ntheme = "paper"\n\n[search]\nenabled = true\nlimit = 50\n');
    ensureSearchDisabledConfig(res.configPath);
    const updated = readFileSync(res.configPath, 'utf8');
    assert.match(updated, /theme = "paper"/);
    assert.match(updated, /enabled = false/);
    assert.match(updated, /limit = 50/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('inspectRuntime queries live server, active sessions, tasks, and writes hot-switch-ledger.json', async () => {
  const root = makeTemp();
  const srv = await startFixtureHttpServer({
    serverId: 'srv-old',
    buildId: OLD_COMMIT,
    workPending: ['sess-active', 'sess-failed'],
    sessionsQuery: [
      { id: 'sess-active', meta: { title: 'Main work' }, activity: { status: 'running' } },
      { id: 'sess-approval', meta: { title: 'Needs approval' }, activity: { status: 'approval' } },
      { id: 'sess-failed', meta: { title: 'Old failure' }, activity: { status: 'failed' } },
      { id: 'sess-idle', meta: { title: 'Done' }, activity: { status: 'idle' } },
    ],
    controls: {
      'sess-active': {
        phase: 'running',
        agents: [
          { agentId: 'main', state: 'settling', resumable: true },
          { agentId: 'child-1', state: 'settling', resumable: true },
        ],
      },
      'sess-approval': { phase: 'running', agents: [] },
      'sess-failed': { phase: 'failed', agents: [] },
    },
    subagents: {
      'sess-active': [
        { id: 'child-1', agent_id: 'child-1', name: 'worker_a', status: 'running', profile: 'worker' },
        { id: 'child-2', agent_id: 'child-2', name: 'reviewer_b', status: 'idle', profile: 'reviewer' },
      ],
    },
    agentTasks: {
      'sess-active': [
        { task_id: 't-main', owner_agent_id: 'main', status: 'running', source: 'live' },
        { task_id: 't-child', owner_agent_id: 'child-1', status: 'running', source: 'live' },
        { task_id: 't-done', owner_agent_id: 'child-2', status: 'completed', source: 'persisted' },
      ],
    },
    tasks: {
      'sess-active': [{ task_id: 't-main', status: 'running' }],
      'sess-failed': [],
    },
  });
  try {
    const runtimeRoot = join(root, 'Kiki');
    const kikiHome = join(root, 'home');
    const candidateDir = join(root, 'candidate-new');
    const oldRelId = writeCandidate(join(root, 'candidate-old'), OLD_COMMIT, 'desk-old', 'srv-old');
    const newRelId = writeCandidate(candidateDir, NEW_COMMIT, 'desk-new', 'srv-new');
    seedActive(runtimeRoot, oldRelId, OLD_COMMIT, 'desk-old', 'srv-old');
    registerInstance(kikiHome, { serverId: 'srv-old', pid: 10001, port: srv.port, buildId: OLD_COMMIT });

    const activeExe = join(runtimeRoot, 'active', 'kiki-server.exe');
    const ledger = await inspectRuntime({
      runtimeRoot,
      kikiHome,
      candidateRoot: candidateDir,
      expectedCommit: NEW_COMMIT,
      resolveProcessPath: (pid) => (pid === 10001 ? activeExe : null),
    });

    assert.equal(ledger.readiness, 'busy_will_pause');
    assert.equal(ledger.liveServer.server_id, 'srv-old');
    assert.equal(ledger.liveServer.layout, 'active');
    assert.equal(ledger.liveServer.releaseId, oldRelId);
    assert.equal(ledger.candidate.valid, true);
    assert.equal(ledger.candidate.releaseId, newRelId);
    assert.equal(ledger.workPendingDetails.length, 3);
    const activeDetail = ledger.workPendingDetails.find((item) => item.sessionId === 'sess-active');
    assert.equal(activeDetail.phase, 'running');
    assert.equal(activeDetail.activityStatus, 'running');
    assert.equal(activeDetail.activeTaskCount, 2);
    assert.equal(activeDetail.activeTaskScope, 'all_owners');
    assert.equal(activeDetail.subagentCount, 2);
    assert.equal(activeDetail.subagents.length, 2);
    assert.equal(activeDetail.pauseParticipantCount, 2);
    const approvalDetail = ledger.workPendingDetails.find((item) => item.sessionId === 'sess-approval');
    assert.equal(approvalDetail.activityStatus, 'approval');
    assert.equal(existsSync(ledger.ledgerPath), true);

    // Also verifies releases/<id> classification works cleanly.
    const legacyExe = join(runtimeRoot, 'releases', oldRelId, 'kiki-server.exe');
    const classified = classifyRuntimeServerPath(runtimeRoot, legacyExe);
    assert.equal(classified.layout, 'releases');
    assert.equal(classified.releaseId, oldRelId);

    // Follows >10 continuation pages completely and preserves upstream session-query errors instead of empty lists.
    const pagedSrv = await startFixtureHttpServer({
      serverId: 'srv-paged',
      buildId: OLD_COMMIT,
      workPending: [],
      sessionsQueryPages: Array.from({ length: 12 }, (_, idx) => [
        { id: `sess-page-${idx}`, meta: { title: `Page ${idx}` }, activity: { status: idx === 11 ? 'running' : 'idle' } },
      ]),
    });
    try {
      const pagedHome = join(root, 'home-paged');
      registerInstance(pagedHome, { serverId: 'srv-paged', pid: 10001, port: pagedSrv.port, buildId: OLD_COMMIT });
      const pagedLedger = await inspectRuntime({
        runtimeRoot,
        kikiHome: pagedHome,
        resolveProcessPath: () => activeExe,
      });
      assert.equal(pagedLedger.activeSessionsError, null);
      assert.equal(pagedLedger.activeSessions.length, 1);
      assert.equal(pagedLedger.activeSessions[0].sessionId, 'sess-page-11');
      assert.equal(pagedLedger.workPendingDetails.length, 1);
      assert.equal(pagedLedger.workPendingDetails[0].sessionId, 'sess-page-11');
    } finally {
      await pagedSrv.close();
    }

    const failedQuerySrv = await startFixtureHttpServer({
      serverId: 'srv-query-err',
      buildId: OLD_COMMIT,
      workPending: [],
      failSessionsQuery: true,
    });
    try {
      const failedHome = join(root, 'home-query-err');
      registerInstance(failedHome, { serverId: 'srv-query-err', pid: 10001, port: failedQuerySrv.port, buildId: OLD_COMMIT });
      const errLedger = await inspectRuntime({
        runtimeRoot,
        kikiHome: failedHome,
        resolveProcessPath: () => activeExe,
      });
      assert.equal(errLedger.activeSessions, null);
      assert.match(String(errLedger.activeSessionsError), /simulated query error/);
      assert.equal(errLedger.readiness, 'session_inventory_unavailable');
    } finally {
      await failedQuerySrv.close();
    }
  } finally {
    await srv.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('reconcileSwitch reports and optionally nudges cold interrupted sessions using real activity status', async () => {
  const root = makeTemp();
  const srv = await startFixtureHttpServer({
    serverId: 'srv-new',
    buildId: NEW_COMMIT,
    workPending: ['sess-really-running'],
    sessionsQuery: [
      // Real cold/idle sessions return control.phase === 'running' (execution allowed), activity.status === 'idle'.
      { id: 'sess-cold-interrupted', meta: { title: 'Interrupted' }, activity: { status: 'idle' } },
      { id: 'sess-really-running', meta: { title: 'Active' }, activity: { status: 'running' } },
      { id: 'sess-paused', meta: { title: 'Paused' }, activity: { status: 'idle' } },
      { id: 'sess-resume-fail', meta: { title: 'Failed' }, activity: { status: 'failed' } },
    ],
    controls: {
      'sess-cold-interrupted': { phase: 'running', agents: [] },
      'sess-really-running': { phase: 'running', agents: [] },
      'sess-paused': { phase: 'paused', agents: [] },
      'sess-resume-fail': { phase: 'failed', agents: [] },
    },
  });
  try {
    const runtimeRoot = join(root, 'Kiki');
    const kikiHome = join(root, 'home');
    const newRelId = writeCandidate(join(root, 'candidate-new'), NEW_COMMIT, 'desk-new', 'srv-new');
    seedActive(runtimeRoot, newRelId, NEW_COMMIT, 'desk-new', 'srv-new');
    registerInstance(kikiHome, { serverId: 'srv-new', pid: 20002, port: srv.port, buildId: NEW_COMMIT });
    const reportPath = join(runtimeRoot, 'hot-switch-report.json');
    writeFileSync(
      reportPath,
      JSON.stringify({
        schemaVersion: 1,
        outcome: 'succeeded',
        interruptedAfterSettle: true,
        interruptedSessions: ['sess-cold-interrupted', 'sess-really-running', 'sess-paused'],
        resumeFailures: [{ sessionId: 'sess-resume-fail', error: 'timeout' }],
      }),
    );

    const activeExe = join(runtimeRoot, 'active', 'kiki-server.exe');
    const dry = await reconcileSwitch({
      runtimeRoot,
      kikiHome,
      reportPath,
      nudge: false,
      resolveProcessPath: () => activeExe,
    });
    assert.equal(dry.interruptedCount, 4);
    assert.equal(srv.receivedPrompts.length, 0);
    assert.ok(dry.results.every((r) => r.nudged === false && r.reason === 'dry_run'));

    const nudged = await reconcileSwitch({
      runtimeRoot,
      kikiHome,
      reportPath,
      nudge: true,
      prompt: 'Resume interrupted task now.',
      resolveProcessPath: () => activeExe,
    });
    assert.equal(nudged.ok, true);
    assert.equal(srv.receivedPrompts.length, 2);
    assert.deepEqual(
      srv.receivedPrompts.map((p) => p.sessionId),
      ['sess-cold-interrupted', 'sess-resume-fail'],
    );
    for (const item of srv.receivedPrompts) {
      assert.equal(item.receiptQuery, 'true');
      assert.equal(item.body.admission, 'durable');
      assert.equal(item.body.append_timing, 'agent_idle');
      assert.equal(item.body.content[0].text, 'Resume interrupted task now.');
      assert.match(item.body.prompt_id, /^hot-switch-reconcile-/);
    }
    const runningRes = nudged.results.find((r) => r.sessionId === 'sess-really-running');
    assert.equal(runningRes.nudged, false);
    assert.equal(runningRes.reason, 'already_active');
    const pausedRes = nudged.results.find((r) => r.sessionId === 'sess-paused');
    assert.equal(pausedRes.nudged, false);
    assert.equal(pausedRes.reason, 'still_paused');

    // When /api/sessions/query fails with a real error, reconcile must NOT treat unknown activity as idle.
    const errSrv = await startFixtureHttpServer({
      serverId: 'srv-err',
      buildId: NEW_COMMIT,
      failSessionsQuery: true,
      controls: { 'sess-cold-interrupted': { phase: 'running', agents: [] } },
    });
    try {
      const errHome = join(root, 'home-err');
      registerInstance(errHome, { serverId: 'srv-err', pid: 20003, port: errSrv.port, buildId: NEW_COMMIT });
      const errRes = await reconcileSwitch({
        runtimeRoot,
        kikiHome: errHome,
        sessions: ['sess-cold-interrupted'],
        nudge: true,
        resolveProcessPath: () => activeExe,
      });
      assert.equal(errSrv.receivedPrompts.length, 0);
      assert.equal(errRes.results[0].reason, 'activity_unknown');
      assert.equal(errRes.results[0].nudged, false);
    } finally {
      await errSrv.close();
    }
  } finally {
    await srv.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('switchRuntime passes -CanaryCheck, verifies active executable + build_id + new PID, and reconciles', async () => {
  const root = makeTemp();
  const state = {
    serverId: 'srv-old',
    buildId: OLD_COMMIT,
    workPending: [],
    controls: { 'sess-cut': { phase: 'idle', agents: [] } },
  };
  const srv = await startFixtureHttpServer(state);
  try {
    const runtimeRoot = join(root, 'Kiki');
    const kikiHome = join(root, 'home');
    const oldRelId = writeCandidate(join(root, 'cand-old'), OLD_COMMIT, 'desk-old', 'srv-old');
    const newCand = join(root, 'cand-new');
    const newRelId = writeCandidate(newCand, NEW_COMMIT, 'desk-new', 'srv-new');
    seedActive(runtimeRoot, oldRelId, OLD_COMMIT, 'desk-old', 'srv-old');
    registerInstance(kikiHome, { serverId: 'srv-old', pid: 30001, port: srv.port, buildId: OLD_COMMIT });

    let activePid = 30001;
    let activeExePath = join(runtimeRoot, 'releases', oldRelId, 'kiki-server.exe');
    let capturedArgs = null;

    const res = await switchRuntime({
      runtimeRoot,
      kikiHome,
      candidateRoot: newCand,
      expectedCommit: NEW_COMMIT,
      nudgeInterrupted: true,
      resolveProcessPath: (pid) => (pid === activePid ? activeExePath : null),
      runHotSwitch: async (_script, args) => {
        capturedArgs = args;
        // Simulate hot-switch rotating to active\kiki-server.exe with new PID and build_id.
        rmSync(join(kikiHome, 'server', 'instances', 'srv-old.json'), { force: true });
        state.serverId = 'srv-new';
        state.buildId = NEW_COMMIT;
        activePid = 30002;
        seedActive(runtimeRoot, newRelId, NEW_COMMIT, 'desk-new', 'srv-new');
        activeExePath = join(runtimeRoot, 'active', 'kiki-server.exe');
        registerInstance(kikiHome, { serverId: 'srv-new', pid: 30002, port: srv.port, buildId: NEW_COMMIT });
        writeFileSync(
          join(runtimeRoot, 'hot-switch-report.json'),
          JSON.stringify({
            schemaVersion: 1,
            outcome: 'succeeded',
            canaryPassed: true,
            interruptedAfterSettle: true,
            interruptedSessions: ['sess-cut'],
            resumeFailures: [],
          }),
        );
        return { code: 0, stdout: `Running ${newRelId} (srv-new)`, stderr: '' };
      },
    });

    assert.ok(capturedArgs.includes('-CanaryCheck'));
    assert.equal(res.ok, true);
    assert.equal(res.postSwitch.pid, 30002);
    assert.equal(res.postSwitch.build_id, NEW_COMMIT);
    assert.equal(res.postSwitch.layout, 'active');
    assert.equal(srv.receivedPrompts.length, 1);
    assert.equal(srv.receivedPrompts[0].sessionId, 'sess-cut');

    // Fails closed if post-switch server runs from releases\<id>\ instead of active\.
    await assert.rejects(
      () =>
        switchRuntime({
          runtimeRoot,
          kikiHome,
          candidateRoot: newCand,
          expectedCommit: NEW_COMMIT,
          resolveProcessPath: (pid) =>
            pid === activePid ? join(runtimeRoot, 'releases', newRelId, 'kiki-server.exe') : null,
          runHotSwitch: async () => ({ code: 0, stdout: 'ok', stderr: '' }),
        }),
      /instead of .*active.*kiki-server\.exe/i,
    );

    // Empty or corrupted active binaries fail verification explicitly instead of falling back to active-release.json.
    const corruptedRuntime = join(root, 'Kiki-corrupted');
    seedActive(corruptedRuntime, oldRelId, OLD_COMMIT, '', 'srv-old');
    assert.throws(
      () => classifyRuntimeServerPath(corruptedRuntime, join(corruptedRuntime, 'active', 'kiki-server.exe')),
      /Expected a non-empty file/,
    );

    // Probe execution errors propagate instead of being swallowed as null.
    await assert.rejects(
      () =>
        inspectRuntime({
          runtimeRoot,
          kikiHome,
          resolveProcessPath: () => {
            throw new Error('CIM query failed');
          },
        }),
      /CIM query failed/,
    );

    // Whitespace-only acceptanceRef or checkRef is rejected identically to assertEvidenceRef.
    const badReceiptCand = join(root, 'bad-receipt-cand');
    writeCandidate(badReceiptCand, NEW_COMMIT, 'desk-new', 'srv-new');
    const badReceiptPath = join(badReceiptCand, 'desktop-build-receipt.json');
    const badReceipt = JSON.parse(readFileSync(badReceiptPath, 'utf8'));
    badReceipt.acceptanceRef = '   ';
    writeFileSync(badReceiptPath, JSON.stringify(badReceipt));
    const badReceiptInspect = await inspectRuntime({
      runtimeRoot,
      kikiHome,
      candidateRoot: badReceiptCand,
      resolveProcessPath: () => null,
    });
    assert.equal(badReceiptInspect.candidate.valid, false);
    assert.match(badReceiptInspect.candidate.error, /acceptanceRef reference is required/);

    // /agent-tasks failure is preserved on activeTaskError even when /tasks fallback succeeds.
    state.workPending = ['sess-cut'];
    const partialInspect = await inspectRuntime({
      runtimeRoot,
      kikiHome,
      resolveProcessPath: (pid) => (pid === activePid ? activeExePath : null),
      callApi: async (req) => {
        if (req.path.includes('/agent-tasks')) {
          throw new Error('HTTP 500 for GET /agent-tasks: upstream failure');
        }
        if (req.path.includes('/tasks?status=running')) {
          return { items: [{ id: 't1', status: 'running' }], has_more: false };
        }
        return callLocalApi(req);
      },
    });
    state.workPending = [];
    const partialSession = partialInspect.workPendingDetails.find((item) => item.sessionId === 'sess-cut');
    assert.equal(partialSession.activeTaskScope, 'partial_main_only');
    assert.equal(partialSession.activeTaskCount, 1);
    assert.match(partialSession.activeTaskError, /HTTP 500 for GET \/agent-tasks/);
  } finally {
    await srv.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseConductorArgs validates commands and flags', () => {
  assert.deepEqual(parseConductorArgs(['--help']), { command: 'help', options: {} });
  assert.throws(() => parseConductorArgs(['bogus']), /Unknown command/);
  const parsed = parseConductorArgs([
    'switch',
    '--runtime-root',
    'C:\\Kiki',
    '--candidate-root',
    'C:\\cand',
    '--settle-seconds',
    '45',
    '--nudge-interrupted',
    '--json',
  ]);
  assert.equal(parsed.command, 'switch');
  assert.equal(parsed.options['settle-seconds'], '45');
  assert.equal(parsed.options['nudge-interrupted'], true);
  assert.equal(parsed.options.json, true);
});

test('installed controller copy executes outside the repository checkout', () => {
  const root = makeTemp();
  try {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const controllerDir = join(root, 'controller');
    mkdirSync(controllerDir, { recursive: true });
    copyFileSync(join(scriptsDir, 'kiki-ops-conductor.mjs'), join(controllerDir, 'kiki-ops-conductor.mjs'));
    copyFileSync(join(scriptsDir, 'desktop-receipt-contract.mjs'), join(controllerDir, 'desktop-receipt-contract.mjs'));

    const res = spawnSync(process.execPath, [join(controllerDir, 'kiki-ops-conductor.mjs'), '--help'], {
      cwd: controllerDir,
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /kiki-ops-conductor/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reconcileSwitch routes interrupted and resume-failed sessions to their owning space home server', async () => {
  const root = makeTemp();
  const runtimeRoot = join(root, 'Kiki');
  const primaryHome = join(root, 'home-primary');
  const secondaryHome = join(root, 'home-secondary');
  mkdirSync(join(primaryHome, 'server', 'instances'), { recursive: true });
  mkdirSync(join(secondaryHome, 'server', 'instances'), { recursive: true });
  writeFileSync(join(primaryHome, 'server.local-owner'), TOKEN);
  writeFileSync(join(secondaryHome, 'server.local-owner'), TOKEN);
  const relId = `${sha256('d').slice(0, 24)}-${sha256('s').slice(0, 24)}`;
  seedActive(runtimeRoot, relId, NEW_COMMIT, 'd', 's');

  const primaryState = {
    serverId: 'srv-primary',
    buildId: NEW_COMMIT,
    workPending: [],
    activeSessions: [{ id: 'shared-sid', activity: { status: 'idle' } }],
    controlPhases: { 'shared-sid': 'idle' },
  };
  const secondaryState = {
    serverId: 'srv-secondary',
    buildId: NEW_COMMIT,
    workPending: [],
    activeSessions: [
      { id: 'shared-sid', activity: { status: 'idle' } },
      { id: 'sec-failed-resume', activity: { status: 'idle' } },
    ],
    controlPhases: { 'shared-sid': 'idle', 'sec-failed-resume': 'idle' },
  };
  const primarySrv = await startFixtureHttpServer(primaryState);
  const secondarySrv = await startFixtureHttpServer(secondaryState);
  try {
    const activeExePath = join(runtimeRoot, 'active', 'kiki-server.exe');
    writeFileSync(
      join(primaryHome, 'server', 'instances', 'srv-primary.json'),
      JSON.stringify({ server_id: 'srv-primary', pid: 40001, host: '127.0.0.1', port: primarySrv.port, build_id: NEW_COMMIT }),
    );
    writeFileSync(
      join(secondaryHome, 'server', 'instances', 'srv-secondary.json'),
      JSON.stringify({ server_id: 'srv-secondary', pid: 40002, host: '127.0.0.1', port: secondarySrv.port, build_id: NEW_COMMIT }),
    );
    const reportPath = join(runtimeRoot, 'hot-switch-report.json');
    writeFileSync(
      reportPath,
      JSON.stringify({
        schemaVersion: 1,
        kikiHome: primaryHome,
        interruptedSessions: ['shared-sid'],
        interruptedSessionRecords: [{ sessionId: 'shared-sid', kikiHome: secondaryHome }],
        resumeFailures: [{ sessionId: 'sec-failed-resume', kikiHome: secondaryHome, error: 'timeout' }],
      }),
    );

    const reconciled = await reconcileSwitch({
      runtimeRoot,
      kikiHome: primaryHome,
      reportPath,
      nudge: true,
      resolveProcessPath: (pid) => (pid === 40001 || pid === 40002 ? activeExePath : null),
    });

    assert.equal(reconciled.ok, true);
    assert.equal(reconciled.interruptedCount, 2);
    assert.equal(primarySrv.receivedPrompts.length, 0);
    assert.deepEqual(
      secondarySrv.receivedPrompts.map((p) => p.sessionId).sort(),
      ['sec-failed-resume', 'shared-sid'],
    );
    assert.equal(
      reconciled.results.every((r) => r.kikiHome === secondaryHome && r.nudged === true),
      true,
    );
  } finally {
    await primarySrv.close();
    await secondarySrv.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrapOps syncs model/provider config, credentials, and agents while isolating ops from locks and heavy plugins', () => {
  const root = makeTemp();
  try {
    const liveRuntime = join(root, 'Kiki');
    const liveHome = join(root, '.kiki');
    const opsRuntime = join(root, 'Kiki-Ops');
    const opsHome = join(root, '.kiki-ops');
    mkdirSync(join(liveRuntime, 'cli'), { recursive: true });
    writeFileSync(join(liveRuntime, 'cli', 'kiki.exe'), 'ops-cli-v2');
    mkdirSync(join(liveHome, 'credentials'), { recursive: true });
    mkdirSync(join(liveHome, 'agents'), { recursive: true });
    mkdirSync(join(liveHome, 'sessions', 'ws1', 's1'), { recursive: true });
    mkdirSync(join(liveHome, 'logs'), { recursive: true });
    writeFileSync(
      join(liveHome, 'config.toml'),
      [
        'default_model = "fast-coder"',
        'hooks = []',
        '',
        '[providers.main]',
        'type = "openai"',
        'base_url = "https://example.test/v1"',
        '',
        '[models.fast-coder]',
        'provider = "main"',
        'model = "coder-v1"',
        '',
        '[search]',
        'enabled = true',
        '',
        '[mcp]',
        'tool_timeout_ms = 30000',
        '',
        '[plugins]',
        'marketplace_url = "https://example.test/plugins"',
        '',
        '[plugin_settings.heavy]',
        'enabled = true',
        '',
        '[[hooks]]',
        'event = "PreToolUse"',
        'command = "echo hi"',
        '',
        '[cron]',
        'poll_interval_ms = 5000',
        '',
      ].join('\n'),
    );
    writeFileSync(join(liveHome, 'credentials', 'credentials.toml'), '[providers.main]\napi_key = "YOUR_API_KEY"\n');
    writeFileSync(join(liveHome, 'agents', 'implementer.md'), '# Implementer\n');
    writeFileSync(join(liveHome, 'agents', 'stale.lock'), 'locked');
    writeFileSync(join(liveHome, 'sessions', 'ws1', 's1', 'state.json'), '{"id":"s1"}');
    writeFileSync(join(liveHome, 'logs', 'kimi-code.log'), 'live log');

    const res = bootstrapOps({
      opsRuntime,
      opsHome,
      sourceRuntime: liveRuntime,
      targetRuntime: liveRuntime,
      targetHome: liveHome,
    });
    assert.equal(res.ok, true);
    assert.equal(res.syncedConfig, true);
    assert.equal(res.syncedCredentials, true);
    assert.equal(res.syncedAgentsCount, 1);

    const opsConfig = readFileSync(res.configPath, 'utf8');
    assert.match(opsConfig, /default_model = "fast-coder"/);
    assert.match(opsConfig, /\[providers\.main\]/);
    assert.match(opsConfig, /\[models\.fast-coder\]/);
    assert.match(opsConfig, /\[search\]\r?\nenabled = false/);
    assert.match(opsConfig, /\[mcp\]\r?\n$/);
    assert.doesNotMatch(opsConfig, /\[plugins\]/);
    assert.doesNotMatch(opsConfig, /\[plugin_settings/);
    assert.doesNotMatch(opsConfig, /\[\[hooks\]\]/);
    assert.doesNotMatch(opsConfig, /\[cron\]/);

    const opsMcp = JSON.parse(readFileSync(res.mcpConfigPath, 'utf8'));
    assert.deepEqual(opsMcp, { mcpServers: {} });
    assert.equal(
      readFileSync(join(opsHome, 'credentials', 'credentials.toml'), 'utf8'),
      '[providers.main]\napi_key = "YOUR_API_KEY"\n',
    );
    assert.equal(readFileSync(join(opsHome, 'agents', 'implementer.md'), 'utf8'), '# Implementer\n');
    assert.equal(existsSync(join(opsHome, 'agents', 'stale.lock')), false);
    assert.equal(existsSync(join(opsHome, 'sessions')), false);
    assert.equal(existsSync(join(opsHome, 'logs')), false);

    // sanitizeOpsConfigToml handles empty input cleanly.
    assert.match(sanitizeOpsConfigToml(''), /\[search\]\nenabled = false\n\n\[mcp\]\n/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('switchRuntime automatically rolls back primary + headless spaces when switch fails or /api/healthz fails', async () => {
  const root = makeTemp();
  const primaryState = { serverId: 'srv-p-old', buildId: OLD_COMMIT, workPending: [], healthzOk: true };
  const headlessState = { serverId: 'srv-h-old', buildId: OLD_COMMIT, workPending: [], healthzOk: true };
  const primarySrv = await startFixtureHttpServer(primaryState);
  const headlessSrv = await startFixtureHttpServer(headlessState);
  try {
    const runtimeRoot = join(root, 'Kiki');
    const primaryHome = join(root, 'home-primary');
    const headlessHome = join(root, 'home-headless');
    const oldRelId = writeCandidate(join(root, 'cand-old'), OLD_COMMIT, 'desk-old', 'srv-old');
    const newCand = join(root, 'cand-new');
    const newRelId = writeCandidate(newCand, NEW_COMMIT, 'desk-new', 'srv-new');
    seedActive(runtimeRoot, oldRelId, OLD_COMMIT, 'desk-old', 'srv-old');
    registerInstance(primaryHome, { serverId: 'srv-p-old', pid: 50001, port: primarySrv.port, buildId: OLD_COMMIT });
    registerInstance(headlessHome, { serverId: 'srv-h-old', pid: 50002, port: headlessSrv.port, buildId: OLD_COMMIT });

    const activeExe = join(runtimeRoot, 'active', 'kiki-server.exe');
    let primaryPid = 50001;
    let headlessPid = 50002;
    const calls = [];

    // Case A: desktop-hot-switch succeeds exit 0, but headless space /api/healthz returns ok=false -> conductor auto-rolls back both spaces!
    let caughtError = null;
    try {
      await switchRuntime({
        runtimeRoot,
        kikiHome: primaryHome,
        candidateRoot: newCand,
        expectedCommit: NEW_COMMIT,
        resolveProcessPath: (pid) => (pid === primaryPid || pid === headlessPid ? activeExe : null),
        inspectSpaces: async () => [
          {
            kikiHome: primaryHome,
            isPrimary: true,
            hadDesktop: true,
            liveServer: { server_id: 'srv-p-old', pid: 50001, releaseId: oldRelId, build_id: OLD_COMMIT, server_home_id: 'home-1', current_space_id: 'main' },
          },
          {
            kikiHome: headlessHome,
            isPrimary: false,
            hadDesktop: false,
            headlessLaunchArgs: `serve --home "${headlessHome}" --port ${headlessSrv.port}`,
            desktopManaged: false,
            liveServer: { server_id: 'srv-h-old', pid: 50002, releaseId: oldRelId, build_id: OLD_COMMIT, server_home_id: 'home-h', current_space_id: 'subtext' },
          },
        ],
        runHotSwitch: async (_script, args) => {
          calls.push(args);
          if (args.includes('-Rollback')) {
            rmSync(join(primaryHome, 'server', 'instances', 'srv-p-new.json'), { force: true });
            rmSync(join(headlessHome, 'server', 'instances', 'srv-h-new.json'), { force: true });
            primaryState.serverId = 'srv-p-rb';
            primaryState.buildId = OLD_COMMIT;
            primaryState.healthzOk = true;
            headlessState.serverId = 'srv-h-rb';
            headlessState.buildId = OLD_COMMIT;
            headlessState.healthzOk = true;
            primaryPid = 50011;
            headlessPid = 50012;
            seedActive(runtimeRoot, oldRelId, OLD_COMMIT, 'desk-old', 'srv-old');
            registerInstance(primaryHome, { serverId: 'srv-p-rb', pid: 50011, port: primarySrv.port, buildId: OLD_COMMIT });
            registerInstance(headlessHome, { serverId: 'srv-h-rb', pid: 50012, port: headlessSrv.port, buildId: OLD_COMMIT });
            return { code: 0, stdout: `Recovery complete: ${oldRelId}`, stderr: '' };
          }
          // Simulated switch lands on new release, but headless /api/healthz fails.
          rmSync(join(primaryHome, 'server', 'instances', 'srv-p-old.json'), { force: true });
          rmSync(join(headlessHome, 'server', 'instances', 'srv-h-old.json'), { force: true });
          primaryState.serverId = 'srv-p-new';
          primaryState.buildId = NEW_COMMIT;
          headlessState.serverId = 'srv-h-new';
          headlessState.buildId = NEW_COMMIT;
          headlessState.healthzOk = false;
          primaryPid = 50003;
          headlessPid = 50004;
          seedActive(runtimeRoot, newRelId, NEW_COMMIT, 'desk-new', 'srv-new');
          registerInstance(primaryHome, { serverId: 'srv-p-new', pid: 50003, port: primarySrv.port, buildId: NEW_COMMIT });
          registerInstance(headlessHome, { serverId: 'srv-h-new', pid: 50004, port: headlessSrv.port, buildId: NEW_COMMIT });
          return { code: 0, stdout: `Running ${newRelId}`, stderr: '' };
        },
      });
    } catch (error) {
      caughtError = error;
    }

    assert.ok(caughtError, 'switchRuntime must reject when headless /api/healthz fails');
    assert.match(caughtError.message, /\/api\/healthz returned ok=false/);
    assert.equal(calls.length, 2);
    assert.ok(calls[1].includes('-Recover') && calls[1].includes('-Rollback'));
    assert.equal(caughtError.failureReport.ok, false);
    assert.equal(caughtError.failureReport.stage, 'post_switch_verify');
    assert.equal(caughtError.failureReport.rollback.triggered, true);
    assert.equal(caughtError.failureReport.rollback.source, 'conductor_auto_rollback');
    assert.equal(caughtError.failureReport.rollback.ok, true);
    assert.equal(caughtError.failureReport.rollback.releaseId, oldRelId);
    assert.equal(caughtError.failureReport.rollback.spaces.length, 2);
    assert.ok(caughtError.failureReport.rollback.spaces.every((s) => s.ok && s.server.build_id === OLD_COMMIT));

    // Case B: standalone rollback command + arg parser validation.
    const rbParsed = parseConductorArgs(['rollback', '--runtime-root', runtimeRoot, '--release-id', oldRelId, '--json']);
    assert.equal(rbParsed.command, 'rollback');
    assert.equal(rbParsed.options['release-id'], oldRelId);
    const rbRes = await rollbackRuntime({
      runtimeRoot,
      kikiHome: primaryHome,
      releaseId: oldRelId,
      expectedCommit: OLD_COMMIT,
      resolveProcessPath: (pid) => (pid === primaryPid || pid === headlessPid ? activeExe : null),
      runHotSwitch: async (_script, args) => {
        assert.ok(args.includes('-Recover') && args.includes('-Rollback'));
        return { code: 0, stdout: `Recovery complete: ${oldRelId}`, stderr: '' };
      },
    });
    assert.equal(rbRes.ok, true);
    assert.equal(rbRes.releaseId, oldRelId);
    assert.equal(rbRes.spaces.length, 2);
  } finally {
    await primarySrv.close();
    await headlessSrv.close();
    rmSync(root, { recursive: true, force: true });
  }
});
