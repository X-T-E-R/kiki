#!/usr/bin/env node
/* eslint-disable no-console -- Layer 1 real-binary ELECTRON_RUN_AS_NODE smoke suite. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, '..');

function resolveUnpackedPaths() {
  if (process.platform === 'win32') {
    const dir = join(desktopRoot, 'out', 'win-unpacked');
    return {
      dir,
      exe: join(dir, 'kiki-desktop.exe'),
      serverDir: join(dir, 'resources', 'app.asar.unpacked', 'dist', 'server'),
    };
  }
  if (process.platform === 'linux') {
    const dir = join(desktopRoot, 'out', 'linux-unpacked');
    return {
      dir,
      exe: join(dir, 'kiki-desktop'),
      serverDir: join(dir, 'resources', 'app.asar.unpacked', 'dist', 'server'),
    };
  }
  throw new Error(`Unsupported platform for unpacked smoke: ${process.platform}`);
}

function runNodeChild(exe, args, envOverrides, timeoutMs = 60_000) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(exe, args, {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ...envOverrides,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      rejectRun(new Error(`Timed out after ${timeoutMs}ms: ${args.join(' ')}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      rejectRun(err);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectRun(
          new Error(
            `Process exited code=${code} signal=${signal}: ${args.join(' ')}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
      } else {
        resolveRun({ stdout, stderr });
      }
    });
  });
}

const { exe, serverDir } = resolveUnpackedPaths();
assert.ok(existsSync(exe), `Unpacked binary missing: ${exe}`);
const serverEntry = join(serverDir, 'server-entry.mjs');
assert.ok(existsSync(serverEntry), `Unpacked server-entry.mjs missing: ${serverEntry}`);

const scratchRoot = mkdtempSync(join(tmpdir(), 'kiki-smoke-node-'));
const tempHome = join(scratchRoot, 'home');
const tempCache = join(scratchRoot, 'cache');

try {
  console.log('[smoke:node] 1/4 Verifying packaged Electron fuses...');
  execFileSync(process.execPath, [join(scriptDir, 'verify-fuses.mjs'), exe, '--packaged'], {
    cwd: desktopRoot,
    stdio: 'inherit',
  });

  console.log('[smoke:node] 2/4 Running KIKI_NATIVE_ASSET_SMOKE=1 under real kiki-desktop.exe (ELECTRON_RUN_AS_NODE=1)...');
  const nativeSmoke = await runNodeChild(
    exe,
    [serverEntry],
    {
      KIKI_HOME: tempHome,
      KIKI_CACHE_DIR: tempCache,
      KIKI_NATIVE_ASSET_SMOKE: '1',
    },
    90_000,
  );
  assert.match(nativeSmoke.stdout, /Auth native smoke passed/);
  assert.match(nativeSmoke.stdout, /Native asset smoke passed/);
  console.log(`  -> ${nativeSmoke.stdout.trim().split('\n').join('\n  -> ')}`);

  console.log('[smoke:node] 3/4 Verifying node:sqlite WAL+FTS5 and remaining worker bundles under kiki-desktop.exe...');
  const requiredServerAssets = [
    'sqlite-indexer.mjs',
    'sqlite-query-worker.mjs',
    'history-navigation-worker.mjs',
    'usage-parser-worker.mjs',
    'query-store-worker.mjs',
    'usage-read-model-worker.mjs',
    'mailbox-worker.mjs',
    'memory-worker.mjs',
    'cpu-worker.mjs',
    'plugin-isolation-worker.mjs',
    'hostRunner.mjs',
    'model_prices_and_context_window.json',
    'native-addons.json',
    'web/index.html',
    ...(process.platform === 'win32' ? ['native/windows-process-helper.exe'] : []),
  ];
  for (const rel of requiredServerAssets) {
    const abs = join(serverDir, rel);
    assert.ok(existsSync(abs), `Missing unpacked server asset: ${abs}`);
  }
  if (process.platform === 'win32') {
    const unpackedDir = join(desktopRoot, 'out', 'win-unpacked');
    for (const relTool of [
      'toolchain/git/bin/bash.exe',
      'toolchain/git/cmd/git.exe',
      'toolchain/bin/rg.exe',
      'toolchain/bin/node.cmd',
      'toolchain/bin/node',
      'toolchain/toolchain-manifest.json',
      'THIRD_PARTY_NOTICES.md',
    ]) {
      const absTool = join(unpackedDir, relTool);
      assert.ok(existsSync(absTool), `Missing bundled Windows toolchain asset: ${absTool}`);
    }
    const comSpec = process.env['ComSpec'] ?? 'C:\\Windows\\System32\\cmd.exe';
    const nodeCmdOut = execFileSync(
      comSpec,
      ['/d', '/s', '/c', `""${join(unpackedDir, 'toolchain', 'bin', 'node.cmd')}" -p "20 + 22""`],
      {
        encoding: 'utf8',
        windowsVerbatimArguments: true,
        env: {
          SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows',
          ComSpec: comSpec,
          PATH: 'C:\\Windows\\System32;C:\\Windows',
          TEMP: scratchRoot,
          TMP: scratchRoot,
        },
      },
    ).trim();
    assert.equal(nodeCmdOut, '42', `Bundled toolchain node.cmd failed on virgin PATH: ${nodeCmdOut}`);
  }

  const sqliteAndWorkerProbe = `
    import assert from 'node:assert/strict';
    import { once } from 'node:events';
    import { join } from 'node:path';
    import { DatabaseSync } from 'node:sqlite';
    import { Worker } from 'node:worker_threads';

    const dbPath = join(${JSON.stringify(scratchRoot)}, 'fts-wal-probe.sqlite');
    const db = new DatabaseSync(dbPath);
    const modeRow = db.prepare('PRAGMA journal_mode = WAL').get();
    assert.equal(String(modeRow.journal_mode).toLowerCase(), 'wal');
    db.exec('CREATE VIRTUAL TABLE docs USING fts5(title, body)');
    db.prepare('INSERT INTO docs (title, body) VALUES (?, ?)').run('electron', 'single binary parity');
    const hit = db.prepare('SELECT title FROM docs WHERE docs MATCH ?').get('parity');
    assert.equal(hit.title, 'electron');
    db.close();

    const cpuWorker = new Worker(join(${JSON.stringify(serverDir)}, 'cpu-worker.mjs'));
    try {
      const [firstMsg] = await once(cpuWorker, 'message');
      assert.deepEqual(firstMsg, { type: 'ready' });
      const replyPromise = once(cpuWorker, 'message');
      cpuWorker.postMessage({
        id: 1,
        operation: { type: 'image.decode', bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' },
      });
      const [reply] = await replyPromise;
      assert.deepEqual(reply, { id: 1, result: false });
    } finally {
      await cpuWorker.terminate();
    }
    console.log('SQLITE_AND_WORKERS_OK');
  `;
  const probePath = join(scratchRoot, 'sqlite-worker-probe.mjs');
  writeFileSync(probePath, sqliteAndWorkerProbe, 'utf8');
  const probeRes = await runNodeChild(exe, [probePath], {
    KIKI_HOME: tempHome,
    KIKI_CACHE_DIR: tempCache,
  });
  assert.match(probeRes.stdout, /SQLITE_AND_WORKERS_OK/);

  console.log('[smoke:node] 4/4 Booting live server-entry.mjs serve --port 0 in isolated KIKI_HOME...');
  const liveHome = join(scratchRoot, 'live-home');
  const serverProc = spawn(exe, [serverEntry, 'serve', '--port', '0'], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      KIKI_HOME: liveHome,
      KIKI_CACHE_DIR: tempCache,
      KIKI_DESKTOP_BUNDLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let serverStderr = '';
  serverProc.stderr.setEncoding('utf8');
  serverProc.stderr.on('data', (chunk) => {
    serverStderr += chunk;
  });

  try {
    const instancesDir = join(liveHome, 'server', 'instances');
    const ownerTokenPath = join(liveHome, 'server.local-owner');
    const deadline = Date.now() + 25_000;
    let port = 0;
    let serverId = '';
    let ownerToken = '';
    while (Date.now() < deadline) {
      if (serverProc.exitCode !== null) {
        throw new Error(`Server exited prematurely (${serverProc.exitCode}):\n${serverStderr}`);
      }
      if (existsSync(instancesDir) && existsSync(ownerTokenPath)) {
        const files = readdirSync(instancesDir).filter((f) => f.endsWith('.json'));
        if (files.length > 0) {
          const inst = JSON.parse(readFileSync(join(instancesDir, files[0]), 'utf8'));
          const tok = readFileSync(ownerTokenPath, 'utf8').trim();
          if (inst.port > 0 && tok.length > 0 && typeof inst.server_id === 'string') {
            port = inst.port;
            serverId = inst.server_id;
            ownerToken = tok;
            break;
          }
        }
      }
      await delay(100);
    }
    assert.ok(port > 0, `Server failed to publish instance receipt within 25s.\n${serverStderr}`);
    assert.match(ownerToken, /^[A-Za-z0-9_-]{43}$/);

    const rootHtmlRes = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(rootHtmlRes.status, 200);
    const rootHtml = await rootHtmlRes.text();
    assert.match(rootHtml, /<div id="root"><\/div>/i);

    const unauthSpaces = await fetch(`http://127.0.0.1:${port}/api/desktop/spaces`);
    assert.equal(unauthSpaces.status, 401);

    const authSpaces = await fetch(`http://127.0.0.1:${port}/api/desktop/spaces`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(authSpaces.status, 200);

    const kikiOriginMeta = await fetch(`http://127.0.0.1:${port}/api/meta`, {
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        Origin: 'kiki-app://localhost',
      },
    });
    assert.equal(kikiOriginMeta.status, 200);
    assert.equal(kikiOriginMeta.headers.get('access-control-allow-origin'), 'kiki-app://localhost');
    const metaJson = await kikiOriginMeta.json();
    assert.equal(metaJson.code, 0);
    assert.equal(metaJson.data.desktop_managed, true);

    const evilOriginMeta = await fetch(`http://127.0.0.1:${port}/api/meta`, {
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        Origin: 'https://evil.example',
      },
    });
    assert.equal(evilOriginMeta.headers.get('access-control-allow-origin'), null);

    const nullOriginMeta = await fetch(`http://127.0.0.1:${port}/api/meta`, {
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        Origin: 'null',
      },
    });
    assert.equal(nullOriginMeta.status, 403);

    const shutdownRes = await fetch(`http://127.0.0.1:${port}/api/desktop-lifecycle`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'quit', server_id: serverId, consent: true }),
    });
    assert.equal(shutdownRes.status, 200);
  } finally {
    const exitDeadline = Date.now() + 8_000;
    while (serverProc.exitCode === null && Date.now() < exitDeadline) {
      await delay(100);
    }
    if (serverProc.exitCode === null) {
      serverProc.kill();
    }
  }

  if (process.platform === 'win32') {
    console.log('[smoke:node] 5/5 Promoting real unpacked kiki-desktop.exe into isolated RuntimeRoot via desktop-release.ps1...');
    const repoRoot = resolve(desktopRoot, '../..');
    const releaseScript = resolve(repoRoot, 'apps', 'kiki-gui', 'scripts', 'desktop-release.ps1');
    const unpackedDir = join(desktopRoot, 'out', 'win-unpacked');
    const receipt = JSON.parse(readFileSync(join(unpackedDir, 'desktop-build-receipt.json'), 'utf8'));
    const tempRuntimeRoot = join(scratchRoot, 'runtime-root');
    const promotedHome = join(scratchRoot, 'promoted-home');

    const promoteOut = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        releaseScript,
        '-Action',
        'Promote',
        '-RuntimeRoot',
        tempRuntimeRoot,
        '-CandidateRoot',
        unpackedDir,
        '-ExpectedCommit',
        receipt.sourceCommit,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, KIKI_SKIP_AUTOSTART_SYNC: '1' },
      },
    );
    assert.match(promoteOut, /Promoted Kiki release/);
    assert.ok(existsSync(join(tempRuntimeRoot, 'active', 'kiki-desktop.exe')));
    assert.ok(existsSync(join(tempRuntimeRoot, 'active', 'resources', 'app.asar')));
    assert.ok(!existsSync(join(tempRuntimeRoot, 'cli', 'kiki.exe')), 'Stale v1 cli\\kiki.exe must be absent');
    const publishedCliCmd = join(tempRuntimeRoot, 'cli', 'kiki.cmd');
    assert.ok(existsSync(publishedCliCmd), 'Promoted v2 runtime must publish cli\\kiki.cmd');
    const cliVersionOut = execFileSync(
      'cmd.exe',
      ['/d', '/s', '/c', `""${publishedCliCmd}" --version"`],
      {
        encoding: 'utf8',
        windowsVerbatimArguments: true,
        env: { ...process.env, KIKI_HOME: promotedHome, KIKI_CACHE_DIR: tempCache },
      },
    ).trim();
    assert.match(cliVersionOut, /\d+\.\d+\.\d+/, `Unexpected cli\\kiki.cmd --version output: ${cliVersionOut}`);
    assert.ok(
      existsSync(
        join(
          tempRuntimeRoot,
          'active',
          'resources',
          'app.asar.unpacked',
          'dist',
          'server',
          'server-entry.mjs',
        ),
      ),
    );

    const headlessRunner = join(scratchRoot, 'launch-headless-promoted.ps1');
    writeFileSync(
      headlessRunner,
      [
        'param([string]$Controller, [string]$Root, [string]$LaunchHome)',
        '$ErrorActionPreference = "Stop"',
        '. $Controller -Action Launch',
        '$proc = Invoke-HeadlessLaunch $Root $LaunchHome "serve --port 0 --log-level warn" -PassThru -RuntimeManaged',
        'Write-Output $proc.Id',
      ].join('\n'),
      'utf8',
    );
    const launchedPidText = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        headlessRunner,
        '-Controller',
        releaseScript,
        '-Root',
        tempRuntimeRoot,
        '-LaunchHome',
        promotedHome,
      ],
      { encoding: 'utf8' },
    ).trim();
    const launchedPid = Number(launchedPidText.split(/\r?\n/).at(-1));
    assert.ok(Number.isInteger(launchedPid) && launchedPid > 0, `Invalid promoted headless PID: ${launchedPidText}`);

    try {
      const promInstancesDir = join(promotedHome, 'server', 'instances');
      const promOwnerFile = join(promotedHome, 'server.local-owner');
      const promDeadline = Date.now() + 20_000;
      let promPort = 0;
      let promServerId = '';
      let promToken = '';
      while (Date.now() < promDeadline) {
        if (existsSync(promInstancesDir) && existsSync(promOwnerFile)) {
          const files = readdirSync(promInstancesDir).filter((f) => f.endsWith('.json'));
          if (files.length > 0) {
            const inst = JSON.parse(readFileSync(join(promInstancesDir, files[0]), 'utf8'));
            const tok = readFileSync(promOwnerFile, 'utf8').trim();
            if (inst.port > 0 && tok !== '') {
              promPort = inst.port;
              promServerId = inst.server_id;
              promToken = tok;
              assert.equal(inst.pid, launchedPid, 'Single-PID invariant: promoted headless PID must match server instance PID');
              break;
            }
          }
        }
        await delay(100);
      }
      assert.ok(promPort > 0, 'Promoted active\\kiki-desktop.exe headless launch failed to bind port');
      const health = await fetch(`http://127.0.0.1:${promPort}/api/healthz`);
      assert.equal(health.status, 200);
      await fetch(`http://127.0.0.1:${promPort}/api/desktop-lifecycle`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${promToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'quit', server_id: promServerId, consent: true }),
      }).catch(() => undefined);
    } finally {
      const killDeadline = Date.now() + 8_000;
      while (Date.now() < killDeadline) {
        try {
          process.kill(launchedPid, 0);
          await delay(100);
        } catch {
          break;
        }
      }
      try {
        process.kill(launchedPid);
      } catch {
        // Exited cleanly.
      }
    }
  }

  console.log('[smoke:node] ALL LAYER 1 + REAL-BINARY PROMOTE CHECKS PASSED.');
} finally {
  await delay(250);
  rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
