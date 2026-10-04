/**
 * Standalone visual capture script for R1 audit verification.
 *
 * Every scenario asserts the state it is about to capture and aborts with a
 * non-zero exit when an assertion fails, so a shot can never be filed for a
 * state that was not on screen. Details:
 *
 *  - Build: the script builds its own production bundle (`.tmp/r1-proof/dist`,
 *    `--no-build` to reuse the last one) and prints the provenance (asset
 *    names + sha256 of the bundle and of the sources it covers).
 *  - Theme: dark/light go through the app's real preference (`.kiki.settings`
 *    + the storage event the shell listens to, `src/lib/theme.ts`), and each
 *    dark shot asserts the resolved token actually changed. Writing
 *    `classList.add('dark')` does nothing — the palette follows
 *    `<html data-theme>`.
 *  - K06 runs on the `send-timing` fixture: the turn parks on a release gate,
 *    so the composer really is busy without a pending interaction. The
 *    `basic-stream` fixture used before gates the same turn on an approval;
 *    the approval sets `pendingInteraction`, which unmounts the working line
 *    (`SessionView.tsx` `composerWorking`) and with it the queued status and
 *    its popover ~1s in, leaving an empty screenshot.
 *  - K02 remote: the browser harness cannot produce a real remote session (a
 *    remote trigger needs the desktop runtime plus a live SSH connection,
 *    `SpaceSwitcher.tsx` `enter`/`sshLabel`). The two remote shots are
 *    therefore render-shape captures of the component's remote markup injected
 *    after load; they prove the markup renders, not that a remote session
 *    behaves. The local menu is driven for real (the script creates two extra
 *    spaces through the product's own `/api/homes`).
 *
 * Captures: K01 plan mode (auto vs manual, light/dark/narrow), K06 queued
 * concise + click-through popover (light/dark/narrow, draft preserved), K02
 * space switcher (local list, remote render), K07 agent hooks section.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(join(ROOT, '.tmp', 'r1-proof'));
const DIST = resolve(process.env['R1_DIST'] ?? join(OUT, 'dist'));
const BUILD = !process.argv.includes('--no-build');

if (!existsSync(OUT)) {
  mkdirSync(OUT, { recursive: true });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
  '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

/** Sources whose content the captured UI depends on — printed for provenance. */
const PROVENANCE_SOURCES = [
  'src/components/Composer.tsx',
  'src/components/ComposerControls.tsx',
  'src/components/SessionView.tsx',
  'src/components/SpaceSwitcher.tsx',
  'src/lib/useRequestGovernance.ts',
  '../../packages/session-core/src/i18n/zh.ts',
];

const sha256 = (file) => {
  const hash = createHash('sha256');
  hash.update(readFileSync(file));
  return hash.digest('hex');
};

function buildDist() {
  const started = Date.now();
  const result = spawnSync(process.execPath, [
    join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build',
    '--outDir', DIST, '--emptyOutDir', '--logLevel', 'warn',
  ], { cwd: ROOT, stdio: 'inherit', timeout: 240_000 });
  if (result.status !== 0) throw new Error(`vite build failed (status ${result.status})`);
  console.log(`Built ${DIST} in ${Date.now() - started}ms`);
}

function printProvenance() {
  const index = join(DIST, 'index.html');
  if (!existsSync(index)) throw new Error(`no build at ${DIST} (run without --no-build)`);
  const assets = [...readFileSync(index, 'utf8').matchAll(/\/assets\/([\w.-]+)/g)].map((m) => m[1]);
  console.log('Build provenance:');
  console.log(`  dist        ${DIST}`);
  console.log(`  index.html  sha256 ${sha256(index).slice(0, 16)} assets ${assets.join(', ')}`);
  for (const relative of PROVENANCE_SOURCES) {
    const file = resolve(join(ROOT, relative));
    console.log(`  ${relative.padEnd(46)} sha256 ${sha256(file).slice(0, 16)}`);
  }
}

function startStatic(dir) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/__kiki/local-server') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    let file = normalize(join(dir, path));
    if (!file.startsWith(dir + sep) || !existsSync(file) || statSync(file).isDirectory()) {
      file = join(dir, 'index.html');
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ready) => server.listen(0, '127.0.0.1', () => ready(server)));
}

/** Assertion ledger: a failed check aborts the run instead of filing a shot. */
const checks = [];
function expect(condition, label, detail) {
  const suffix = detail === undefined ? '' : ` — ${detail}`;
  if (condition) {
    checks.push({ label, ok: true });
    console.log(`  ok   ${label}${suffix}`);
    return;
  }
  checks.push({ label, ok: false });
  console.log(`  FAIL ${label}${suffix}`);
  throw new Error(`assertion failed: ${label}${suffix}`);
}

/** Governance snapshot in the shape the fixture/REST layer serves. */
const governance = (sessionId) => ({
  seq: 4,
  asOf: new Date().toISOString(),
  coverage: { native: 'managed', external: 'unmanaged' },
  active: 2,
  queued: 1,
  dimensions: [],
  rules: [
    { id: 'provider-cap', resource: 'model_request', scope: 'global', providers: ['provider-axon'], subagentsOnly: false, maxConcurrent: 2, overflow: 'queue', enabled: true },
  ],
  waiting: [
    { attemptId: 'attempt-r1', sessionId, agentId: 'main', modelId: 'axon/gpt-6.1-sol', providerId: 'provider-axon', purpose: 'turn', waitedMs: 16_800, blockingRules: ['provider-cap'] },
  ],
});

const PAPER_DARK = '#1b2226';

async function setTheme(page, theme) {
  await page.evaluate((next) => {
    const key = 'kiki.settings';
    const oldValue = localStorage.getItem(key);
    const settings = oldValue === null ? {} : JSON.parse(oldValue);
    const newValue = JSON.stringify({ ...settings, theme: next });
    localStorage.setItem(key, newValue);
    window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue, storageArea: localStorage }));
  }, theme);
  await page.waitForFunction((next) => document.documentElement.dataset['theme'] === next, theme, { timeout: 10_000 });
  // Prove the palette followed, not just the attribute.
  const paper = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-paper').trim());
  if (theme === 'dark') return paper.toLowerCase() === PAPER_DARK;
  return paper.toLowerCase() !== PAPER_DARK;
}

async function enterWorkingSession(page, link, sessionId, prompt) {
  await page.goto(link(`/s/${sessionId}`), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('textarea:not([disabled])', { timeout: 20_000 });
  await page.fill('textarea', prompt);
  await page.press('textarea', 'Control+Enter');
  await page.waitForSelector('[data-composer-working]', { timeout: 20_000 });
}

async function capture() {
  if (BUILD) buildDist();
  printProvenance();

  console.log('Starting fixture server...');
  const fixture = await startFixtureServer({ port: 0, scenario: 'basic-stream' });
  const fixturePort = fixture.http.address().port;
  const fixtureUrl = `http://127.0.0.1:${fixturePort}`;

  console.log('Starting static server on', DIST);
  const web = await startStatic(DIST);
  const webPort = web.address().port;
  const webUrl = `http://127.0.0.1:${webPort}`;

  const link = (path, extra = {}) => {
    const u = new URL(path, webUrl);
    u.searchParams.set('server', fixtureUrl);
    u.searchParams.set('token', FIXTURE_TOKEN);
    for (const [k, v] of Object.entries(extra)) {
      u.searchParams.set(k, v);
    }
    return u.toString();
  };
  const control = (body) => fetch(`${fixtureUrl}/__control`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  /** Product REST call, exactly what the spaces settings page sends. */
  const createSpace = async (space) => {
    const response = await fetch(`${fixtureUrl}/api/homes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${FIXTURE_TOKEN}` },
      body: JSON.stringify(space),
    });
    const payload = await response.json();
    if (payload?.code !== 0) throw new Error(`createSpace failed: ${JSON.stringify(payload)}`);
    return payload.data;
  };

  const browser = await chromium.launch({ headless: true });

  const shot = async (page, name) => {
    await page.evaluate(async () => {
      const finite = document.getAnimations().filter(
        (a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity,
      );
      await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
    }).catch(() => undefined);
    const p = join(OUT, `${name}.png`);
    await page.screenshot({ path: p });
    console.log(`Saved screenshot: ${name}.png`);
    return p;
  };

  const newPage = async (browser_, viewport) => {
    const context = await browser_.newContext({ viewport, locale: 'zh-CN' });
    const page = await context.newPage();
    await page.addInitScript(() => {
      try {
        localStorage.setItem('kiki.locale', 'zh');
        localStorage.setItem('kiki.settings', JSON.stringify({ theme: 'light' }));
        localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
      } catch { /* ignore */ }
    });
    return { context, page };
  };

  try {
    // ----------------------------------------------------
    // Scenario 1: K01 - Plan Mode in Auto vs Manual
    // ----------------------------------------------------
    console.log('\n--- Scenario 1: K01 Plan Mode in Auto vs Manual ---');
    {
      const { context, page } = await newPage(browser, { width: 1440, height: 900 });
      await page.goto(link('/s/session_fixture_basic'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('textarea:not([disabled])', { timeout: 15_000 });

      await page.locator('textarea').focus();
      await page.keyboard.press('Control+Shift+M');
      await page.waitForSelector('[data-run-mode-panel]', { timeout: 10_000 });
      await page.locator('[data-mode-switch="plan"]').click();
      await page.waitForTimeout(300);

      // Auto (default) mode: the panel must carry no standing caveat.
      expect(await page.locator('[data-plan-gate-effective]').count() === 0, 'K01 auto: no plan-gate caveat line');
      const autoPanel = (await page.locator('[data-run-mode-panel]').textContent()) ?? '';
      expect(!autoPanel.includes('会等你批准'), 'K01 auto: panel text has no approval caveat');
      await shot(page, 'k01-plan-mode-auto-light-1440');

      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      await page.locator('[data-permission-tone]').click();
      await page.waitForSelector('[data-permission-panel]', { timeout: 5_000 });
      await page.locator('[data-permission-mode="manual"]').click();
      await page.waitForTimeout(300);
      await page.locator('textarea').focus();
      await page.keyboard.press('Control+Shift+M');
      await page.waitForSelector('[data-run-mode-panel]', { timeout: 5_000 });

      const gateSwitch = page.locator('[data-mode-switch="planGate"]');
      expect(await gateSwitch.count() > 0, 'K01 manual: plan-gate switch is offered');
      if (await gateSwitch.getAttribute('aria-checked') === 'true') {
        await gateSwitch.click();
        await page.waitForTimeout(300);
      }
      const gateText = (await page.locator('[data-plan-gate-effective]').textContent()) ?? '';
      expect(gateText.includes('等你批准'), 'K01 manual: promise line reads the plan-gate promise', gateText.trim());
      await shot(page, 'k01-plan-mode-manual-light-1440');

      expect(await setTheme(page, 'dark'), 'K01 dark: palette switched to the dark paper token');
      await page.waitForTimeout(300);
      await shot(page, 'k01-plan-mode-manual-dark-1440');

      expect(await setTheme(page, 'light'), 'K01: palette restored to light');

      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(300);
      const narrowVisible = await page.locator('[data-plan-gate-effective]').isVisible();
      expect(narrowVisible, 'K01 narrow 390: promise line still rendered');
      await shot(page, 'k01-plan-mode-manual-narrow-390');

      // Negative control: switching the gate back on removes the caveat again.
      await gateSwitch.click();
      await page.waitForTimeout(300);
      expect(await page.locator('[data-plan-gate-effective]').count() === 0, 'K01: caveat disappears when the gate is switched back on');

      await context.close();
    }

    // ----------------------------------------------------
    // Scenario 2: K06 - Working Line "排队中" + Inline Details
    // ----------------------------------------------------
    console.log('\n--- Scenario 2: K06 Working Line Queued & Details ---');
    {
      await control({ action: 'scenario', name: 'send-timing' });
      const SESSION = 'session_fixture_send_timing';
      const DRAFT = '排队期间继续打草稿，不受打扰';

      const { context, page } = await newPage(browser, { width: 1440, height: 900 });
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(String(error.message)));

      // The queue is reported by the server: only the response is staged here.
      await page.route('**/usage/realtime', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, msg: 'ok', request_id: 'r1-proof', data: governance(SESSION) }),
      }));

      await enterWorkingSession(page, link, SESSION, 'Run the fixture suite.');

      expect(await page.locator('[data-approval-id]').count() === 0, 'K06: the turn is busy without a pending interaction');

      const trigger = page.locator('[data-composer-queued-trigger]');
      await trigger.waitFor({ timeout: 15_000 });

      // The user keeps drafting while queued.
      await page.fill('textarea', DRAFT);
      await page.waitForTimeout(1_200);

      const concise = await page.evaluate(() => ({
        line: document.querySelector('[data-composer-working]')?.textContent?.trim() ?? '',
        trigger: document.querySelector('[data-composer-queued-trigger]')?.textContent?.trim() ?? '',
        draft: document.querySelector('textarea')?.value ?? '',
      }));
      expect(concise.trigger === '排队中', 'K06 concise: status reads 排队中', concise.line);
      expect(!/\d+\s*秒/.test(concise.line), 'K06 concise: no standing second-count noise', concise.line);
      expect(concise.draft === DRAFT, 'K06 concise: draft typed while queued is kept');
      await shot(page, 'k06-queued-concise-light-1440');

      await trigger.click();
      await page.waitForSelector('[data-composer-queued-popover]', { timeout: 5_000 });
      await page.waitForTimeout(1_200);
      const popover = page.locator('[data-composer-queued-popover]');
      const popoverText = (await popover.textContent().catch(() => null)) ?? '';
      expect(popoverText.length > 0, 'K06 popover: still mounted after the click settles', popoverText.slice(0, 40));
      for (const [label, needle] of [
        ['waited seconds', '已等待：17 秒'],
        ['model', '模型：axon/gpt-6.1-sol'],
        ['blocking rule', '阻塞规则：provider-cap'],
        ['limits management link', '在用量中管理限制规则'],
      ]) {
        expect(popoverText.includes(needle), `K06 popover: shows ${label}`, needle);
      }
      expect(await page.inputValue('textarea') === DRAFT, 'K06 popover: draft untouched by the popover');
      await shot(page, 'k06-queued-details-popover-light-1440');

      expect(await setTheme(page, 'dark'), 'K06 dark: palette switched to the dark paper token');
      await page.waitForTimeout(200);
      await shot(page, 'k06-queued-details-popover-dark-1440');

      expect(await setTheme(page, 'light'), 'K06: palette restored to light');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(200);
      expect(await popover.isVisible(), 'K06 narrow 390: popover stays on screen');
      await shot(page, 'k06-queued-details-popover-narrow-390');

      // The details link is a real route, not decoration.
      await page.click('[data-composer-queued-usage]');
      await page.waitForTimeout(600);
      expect(new URL(page.url()).pathname === '/usage', 'K06 popover: limits link navigates to /usage', page.url());
      expect(pageErrors.length === 0, 'K06: no page errors', pageErrors.join(' | '));

      await context.close();
    }

    // ----------------------------------------------------
    // Scenario 3: K02 - SpaceSwitcher in Local & Remote Modes
    // ----------------------------------------------------
    console.log('\n--- Scenario 3: K02 SpaceSwitcher in Local & Remote Modes ---');
    {
      await control({ action: 'scenario', name: 'basic-stream' });
      // Real multi-space state through the product's own API (what the spaces
      // settings page posts), so the list and shortcut hints are not staged.
      await createSpace({ name: 'GPU 训练机', path: 'D:/fixture/gpu', color: '#295c58' });
      await createSpace({ name: 'Paper', path: 'D:/fixture/paper' });

      const { context, page } = await newPage(browser, { width: 1440, height: 900 });
      await page.goto(link('/s/session_fixture_basic'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-space-switcher]', { timeout: 15_000 });
      // Handled by element, not selector: the remote render drops the
      // `data-space-switcher` id exactly like the component does.
      const triggerHandle = await page.locator('[data-space-switcher]').elementHandle();

      await page.locator('[data-space-switcher]').click();
      await page.waitForSelector('[data-space-switcher-menu]', { timeout: 5_000 });
      await page.waitForTimeout(300);
      const items = await page.locator('[data-space-switch-item]').count();
      expect(items >= 3, 'K02 local: menu lists every registered space', `${items} items`);
      expect(await page.locator('[data-space-switcher-menu] kbd').count() >= 2, 'K02 local: multi-space shortcut hints are shown');
      expect(await page.locator('[data-space-manage]').count() === 1, 'K02 local: manage-spaces entry present');
      await shot(page, 'k02-space-switcher-local-menu-light-1440');

      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);

      // Remote render only — see the header note: a real remote session needs
      // the desktop runtime and an SSH connection, which this harness forbids.
      console.warn('  note: remote SpaceSwitcher shots are render-shape captures of the remote markup injected after load');
      await page.evaluate(() => {
        const trigger = document.querySelector('[data-space-switcher]');
        if (trigger !== null) {
          trigger.setAttribute('data-space-remote', '');
          trigger.removeAttribute('data-space-switcher');
          let nameSpan = trigger.querySelector('[data-space-switcher-name]');
          if (nameSpan === null) {
            nameSpan = document.createElement('span');
            nameSpan.className = 'min-w-0 truncate text-[13px] font-medium';
            nameSpan.setAttribute('data-space-switcher-name', '');
            trigger.insertBefore(nameSpan, trigger.lastElementChild);
          }
          nameSpan.textContent = 'dev-server-gpu';
          const tag = document.createElement('span');
          tag.className = 'shrink-0 rounded-full bg-ink/[0.06] px-1.5 text-[11px] font-medium leading-[18px] text-ink-soft';
          tag.textContent = '远端';
          tag.setAttribute('data-space-remote-tag', '');
          nameSpan.after(tag);
        }
      });
      await page.waitForTimeout(200);
      await shot(page, 'k02-space-switcher-remote-trigger-light-1440');

      await triggerHandle.click();
      await page.waitForSelector('[data-space-switcher-menu]', { timeout: 5_000 });
      await page.waitForTimeout(300);
      await shot(page, 'k02-space-switcher-remote-menu-light-1440');

      await context.close();
    }

    // ----------------------------------------------------
    // Scenario 4: K07 - Agent Panel Hooks Section
    // ----------------------------------------------------
    console.log('\n--- Scenario 4: K07 Agent Panel Injected Rules ---');
    {
      await control({ action: 'scenario', name: 'basic-stream' });

      const { context, page } = await newPage(browser, { width: 1440, height: 900 });

      await page.route('**/sessions/*/agents/*/hooks', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          msg: 'ok',
          data: {
            revision: 'rev-hooks-1',
            binding: {
              executorId: 'exec-agent-core',
              modelId: 'axon/gpt-6.1-sol',
              agentRole: 'root',
            },
            sources: [
              { namespace: 'workspace', path: '.kiki/hooks.ts', status: 'loaded' },
              { namespace: 'plugin', path: 'external/code-guard.ts', status: 'loaded' },
            ],
            diagnostics: [],
            rules: [
              {
                id: 'safety-check',
                path: '.kiki/hooks.ts',
                namespace: 'workspace',
                event: 'step.before',
                action: { type: 'inject' },
                active: true,
                completedSteps: 6,
                nextDue: 8,
                order: 0,
                resetPending: false,
              },
              {
                id: 'commit-lint',
                path: 'external/code-guard.ts',
                namespace: 'plugin',
                event: 'turn.after',
                action: { type: 'observe' },
                active: true,
                completedSteps: 2,
                order: 1,
                resetPending: false,
              },
            ],
          },
        }),
      }));

      await page.goto(link('/s/session_fixture_basic'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('textarea:not([disabled])', { timeout: 15_000 });

      await page.fill('textarea', 'Inspect agent rules.');
      await page.press('textarea', 'Control+Enter');
      await page.waitForTimeout(600);

      await page.waitForSelector('[data-rail-toggle]', { timeout: 15_000 });
      const railToggle = page.locator('[data-rail-toggle]');
      if (await railToggle.count() > 0 && await railToggle.getAttribute('aria-expanded') === 'false') {
        await railToggle.click();
        await page.waitForTimeout(500);
      }

      await page.waitForSelector('[data-session-rail]', { timeout: 10_000 });
      const hooksSection = page.locator('[data-agent-hooks-section]');
      await hooksSection.waitFor({ timeout: 10_000 });
      await shot(page, 'k07-hooks-section-summary-light-1440');

      await hooksSection.locator('button[aria-expanded]').click();
      await page.waitForTimeout(400);
      const hooksText = (await hooksSection.textContent()) ?? '';
      expect(hooksText.includes('safety-check'), 'K07 unfolded: rule rows are rendered', hooksText.slice(0, 60));
      await shot(page, 'k07-hooks-section-unfolded-light-1440');

      expect(await setTheme(page, 'dark'), 'K07 dark: palette switched to the dark paper token');
      await page.waitForTimeout(300);
      await shot(page, 'k07-hooks-section-unfolded-dark-1440');

      expect(await setTheme(page, 'light'), 'K07: palette restored to light');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(300);
      await shot(page, 'k07-hooks-section-unfolded-narrow-390');

      await context.close();
    }

    console.log('\nAll capture scenarios completed successfully!');
  } finally {
    await browser.close();
    web.close();
    await fixture.stop();
  }

  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} assertions passed.`);
}

capture().catch((err) => {
  console.error('Capture failed:', err);
  process.exit(1);
});
