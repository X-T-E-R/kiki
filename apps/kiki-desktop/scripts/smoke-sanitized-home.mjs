#!/usr/bin/env node
/* eslint-disable no-console -- Layer 3 real-binary sanitized KIKI_HOME traversal & @2x visual proof runner. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, '..');
const repoRoot = resolve(desktopRoot, '../..');
const proofDir = resolve(repoRoot, '.tmp', 'electron-070-proof');

const unpackedDir =
  process.platform === 'win32'
    ? join(desktopRoot, 'out', 'win-unpacked')
    : join(desktopRoot, 'out', 'linux-unpacked');
const exe =
  process.platform === 'win32'
    ? join(unpackedDir, 'kiki-desktop.exe')
    : join(unpackedDir, 'kiki-desktop');

assert.ok(existsSync(exe), `Unpacked Electron executable not found: ${exe}`);

rmSync(proofDir, { recursive: true, force: true });
mkdirSync(proofDir, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'kiki-smoke-home-'));
const sanitizedHome = join(scratch, 'home');
const userDataDir = join(scratch, 'user-data');
const cacheDir = join(scratch, 'cache');
const sampleWorkspace = join(scratch, 'sample-project');

mkdirSync(sanitizedHome, { recursive: true });
mkdirSync(sampleWorkspace, { recursive: true });
writeFileSync(
  join(sampleWorkspace, 'README.md'),
  '# Sample Workspace\n\nSanitized non-secret workspace for Electron 0.7.0 verification.\n',
  'utf8',
);
writeFileSync(
  join(sanitizedHome, 'config.toml'),
  '[general]\nlanguage = "zh-CN"\n',
  'utf8',
);

const cleanEnv = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v === undefined) continue;
  if (k.toUpperCase() === 'ELECTRON_RUN_AS_NODE') continue;
  cleanEnv[k] = v;
}
cleanEnv['KIKI_HOME'] = sanitizedHome;
cleanEnv['KIKI_DESKTOP_USER_DATA_DIR'] = userDataDir;
cleanEnv['KIKI_CACHE_DIR'] = cacheDir;
cleanEnv['NO_PROXY'] = '127.0.0.1,localhost';
cleanEnv['no_proxy'] = '127.0.0.1,localhost';
cleanEnv['KIKI_SKIP_AUTOSTART_SYNC'] = '1';

let electronApp;
const serverPids = new Set();

try {
  console.log('[smoke:home] Launching packaged kiki-desktop.exe at @2x scale in isolated sanitized KIKI_HOME...');
  const bootStart = performance.now();
  electronApp = await electron.launch({
    executablePath: exe,
    args: [
      '--no-proxy-server',
      '--no-release-redirect',
      '--force-device-scale-factor=2',
      '--home',
      sanitizedHome,
    ],
    env: cleanEnv,
  });

  const page = await electronApp.firstWindow();
  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.setBounds({ x: 60, y: 40, width: 1440, height: 920 });
    }
  });

  const pageErrors = [];
  const badApiResponses = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });
  page.on('response', (res) => {
    const url = res.url();
    const status = res.status();
    if (
      (url.includes('/api/') || url.startsWith('kiki-app://localhost/')) &&
      (status === 401 || status === 403 || status === 404 || status >= 500)
    ) {
      badApiResponses.push({ url, status });
    }
  });

  let conn = null;
  const bootDeadline = Date.now() + 20_000;
  while (Date.now() < bootDeadline) {
    const discovered = await page
      .evaluate(async () => {
        const bridge = window.__KIKI_ELECTRON__;
        if (!bridge || window.location.origin !== 'kiki-app://localhost') return null;
        return await bridge.discoverConnection();
      })
      .catch(() => null);
    if (discovered && discovered.ok && discovered.connection?.config?.url) {
      conn = discovered.connection.config;
      break;
    }
    if (discovered && discovered.config?.url) {
      conn = discovered.config;
      break;
    }
    await delay(80);
  }
  assert.ok(conn, 'Timed out waiting for __KIKI_ELECTRON__.discoverConnection()');

  const bootMs = Math.round(performance.now() - bootStart);
  console.log(`[smoke:home] Connected to ${conn.url} under origin kiki-app://localhost in ${bootMs}ms`);

  const instancesDir = join(sanitizedHome, 'server', 'instances');
  if (existsSync(instancesDir)) {
    for (const file of readdirSync(instancesDir)) {
      if (!file.endsWith('.json')) continue;
      const parsed = JSON.parse(readFileSync(join(instancesDir, file), 'utf8'));
      if (typeof parsed.pid === 'number') serverPids.add(parsed.pid);
    }
  }

  // Seed sanitized sessions via live REST API (never touching production ~/.kiki).
  const createSession = async (title) => {
    const res = await fetch(`${conn.url}/api/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${conn.token}`,
        'Content-Type': 'application/json',
        Origin: 'kiki-app://localhost',
      },
      body: JSON.stringify({
        metadata: {
          cwd: sampleWorkspace,
          title,
        },
      }),
    });
    assert.equal(res.status, 200, `Failed creating session ${title}: HTTP ${res.status}`);
    const body = await res.json();
    assert.equal(body.code, 0, `Session create returned non-zero code: ${JSON.stringify(body)}`);
    return body.data.id;
  };

  const sessionA = await createSession('Electron 0.7.0 架构迁移与 kiki-app 固定源验收');
  await createSession('SQLite WAL 搜索与多空间托盘状态同步');

  // Wait for initial UI shell render on /new
  await page.waitForSelector('#root *', { timeout: 15_000 });
  await delay(1200);
  const shotNew = join(proofDir, '01-new-session-2x.png');
  await page.screenshot({ path: shotNew });
  console.log(`[smoke:home] Captured ${shotNew}`);

  // Navigate in-SPA via history.pushState + popstate (never full reload unless testing SPA fallback)
  const navigateSpa = async (routePath) => {
    await page.evaluate((target) => {
      window.history.pushState({}, '', target);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, routePath);
    await delay(1000);
  };

  await navigateSpa(`/s/${sessionA}`);
  const shotSession = join(proofDir, '02-session-workspace-2x.png');
  await page.screenshot({ path: shotSession });
  console.log(`[smoke:home] Captured ${shotSession}`);

  // Also verify hard reload on deep SPA route `/s/${sessionA}` works via appProtocol SPA fallback!
  await page.goto(`kiki-app://localhost/s/${sessionA}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#root *', { timeout: 15_000 });
  await delay(1000);

  await navigateSpa('/usage');
  const shotUsage = join(proofDir, '03-usage-dashboard-2x.png');
  await page.screenshot({ path: shotUsage });
  console.log(`[smoke:home] Captured ${shotUsage}`);

  await navigateSpa('/usage?panel=quota');
  const shotQuota = join(proofDir, '04-usage-quota-2x.png');
  await page.screenshot({ path: shotQuota });
  console.log(`[smoke:home] Captured ${shotQuota}`);

  await navigateSpa('/settings');
  const shotSettings = join(proofDir, '05-settings-desktop-2x.png');
  await page.screenshot({ path: shotSettings });
  console.log(`[smoke:home] Captured ${shotSettings}`);

  const dpr = await page.evaluate(() => window.devicePixelRatio);
  assert.equal(dpr, 2, `Expected @2x devicePixelRatio=2, got ${dpr}`);
  assert.deepEqual(pageErrors, [], `Unexpected renderer pageerrors: ${JSON.stringify(pageErrors)}`);
  assert.deepEqual(badApiResponses, [], `Unexpected 401/403/404/5xx responses: ${JSON.stringify(badApiResponses)}`);

  await page.evaluate(async () => {
    await window.__KIKI_ELECTRON__.desktop.writePrefs({ closeToTray: false });
  });
  await electronApp.close();
  electronApp = undefined;

  console.log('[smoke:home] ALL LAYER 3 CHECKS PASSED.');
} finally {
  if (electronApp) {
    await electronApp.close().catch(() => undefined);
  }
  for (const pid of serverPids) {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await delay(100);
      } catch {
        break;
      }
    }
    try {
      process.kill(pid);
    } catch {
      // Already exited.
    }
  }
  await delay(300);
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
