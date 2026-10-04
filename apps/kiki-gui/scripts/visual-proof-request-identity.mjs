/**
 * Visual proof for Settings › Request identity (fixture `request-identity`):
 * the global default, a built-in identity with its preview (summary, then the
 * expanded header table), two custom identities holding an unsaved draft each
 * across switches (kept, marked in the directory, saved, rejected, discarded),
 * the guard shown when leaving with a draft, client version tracks (staged
 * candidate, after a check), where identities are used, and the latest
 * requests — zh, light and dark. The draft walk also asserts the values, so a
 * dropped draft fails the run instead of only looking wrong.
 *
 *   node scripts/visual-proof-request-identity.mjs [--widths=1440,390]
 *
 * Screenshots land in .tmp/request-identity-proof/<stamp>/ as `<surface>-<theme>-<width>.png`.
 * Mock-only: a frozen production build talks to the fixture server, which
 * stands in for kap-server.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.tmp', 'request-identity-proof', String(Date.now()));
await mkdir(output, { recursive: true });
const widths = (process.argv.find((arg) => arg.startsWith('--widths='))?.slice('--widths='.length) ?? '1440').split(',').map(Number);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
  '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

/** Hash of everything the bundle is built from, so the cache cannot age silently. */
function buildKey() {
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const head = git(['rev-parse', 'HEAD']);
  // The bundle reads workspace packages too (session-core copy, protocol,
  // klient), so the whole dirty set counts — not just this app's own src.
  const dirty = git(['status', '--porcelain=v1']);
  const hash = createHash('sha1').update(head ?? 'no-git').update(dirty ?? 'no-git');
  const walk = (path) => {
    const info = statSync(path, { throwIfNoEntry: false });
    if (info === undefined) return;
    if (info.isDirectory()) {
      for (const child of readdirSync(path).sort()) walk(join(path, child));
      return;
    }
    hash.update(`\n${path.slice(root.length)}:${info.size}:${info.mtimeMs}`);
  };
  for (const input of ['src', 'index.html', 'vite.config.ts']) walk(join(root, input));
  return hash.digest('hex');
}

/**
 * The walk asserts client-held drafts, so the code under test has to hold
 * still: one production build up front, served statically. A dev server
 * re-reads a shared worktree on every request, so another writer's half-saved
 * module or an HMR reload mid-walk would void the run instead of failing it.
 */
const dist = join(root, '.tmp', 'request-identity-proof', 'dist');
const stamp = join(dist, '.build-key');
const key = buildKey();
if (!existsSync(join(dist, 'index.html')) || !existsSync(stamp) || readFileSync(stamp, 'utf8') !== key) {
  console.log('[proof] building the GUI…');
  const result = spawnSync(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build',
    '--outDir', dist, '--emptyOutDir', '--logLevel', 'warn'], { cwd: root, stdio: 'inherit', timeout: 300_000 });
  if (result.status !== 0) {
    console.error('[proof] the GUI does not build; no screenshots were taken');
    process.exit(1);
  }
  writeFileSync(stamp, key);
}

async function startStatic(dir) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/__kiki/local-server') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    let file = normalize(join(dir, path));
    if (!file.startsWith(dir + sep) || !existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html');
    const stream = createReadStream(file);
    stream.once('open', () => {
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      stream.pipe(res);
    });
    stream.once('error', () => {
      if (!res.headersSent) res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
  });
  await new Promise((ready) => { server.listen(0, '127.0.0.1', ready); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => { server.close(); } };
}

const fixture = await startFixtureServer({ port: 0, scenario: 'request-identity' });
const endpoint = `http://127.0.0.1:${fixture.http.address().port}`;
process.env.KIKI_SERVER_URL = endpoint;
const web = await startStatic(dist);
const browser = await chromium.launch({ args: ['--no-proxy-server'] });
const errors = [];

const control = (body) => fetch(`${endpoint}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const url = (path) => `${web.url}${path}${path.includes('?') ? '&' : '?'}server=${encodeURIComponent(endpoint)}&token=${FIXTURE_TOKEN}`;

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
  });
  await page.waitForTimeout(200);
}

async function shot(page, name) {
  await settle(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) errors.push(`${name}: horizontal overflow ${overflow}px`);
  const file = join(output, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`[shot] ${file}`);
}

async function to(page, selector) {
  await page.locator(selector).first().evaluate((node) => { node.scrollIntoView({ block: 'start' }); });
}

/** A draft that does not survive the walk is a failure, not a screenshot. */
function check(name, actual, expected) {
  if (actual !== expected) errors.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const field = (page, selector) => page.locator(selector).inputValue();

/** Pick an identity. Below `md` only one pane shows, so return to the list first. */
async function openRow(page, width, id) {
  if (width < 600 && await page.locator('[data-identity-back]').isVisible()) {
    await page.locator('[data-identity-back]').click();
    await settle(page);
  }
  await page.locator(`[data-identity-row="${id}"]`).click();
  await page.waitForSelector(`[data-identity-detail="${id}"]`);
  await settle(page);
}

const CODEX_DRAFT = {
  label: 'REVIEW-DRAFT-NOT-SAVED',
  userAgent: 'codex-tui/{version} ({os_type}; {arch}) REVIEW',
  overrides: '{ "lineage": { "thread_identity": "none" } }',
};
const CLAUDE_DRAFT = 'Claude Code (terminal) REVIEW';

async function walk(page, tag, width) {
  const narrow = width < 600;
  await page.goto(url('/settings/identity'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-identity-detail="codex"] [data-preview-header="User-Agent"]', { state: 'attached', timeout: 30_000 });

  // The global default is above the directory, so a narrow screen starts on the list.
  if (narrow) await shot(page, `list-${tag}`);
  await to(page, '#st-card-request-identity');
  await shot(page, `default-${tag}`);
  if (narrow) await openRow(page, width, 'codex');
  await shot(page, `builtin-${tag}`);

  // Preview: the summary carries protocol, version and User-Agent; the full
  // header table is behind an explicit expand.
  await to(page, '[data-identity-preview]');
  const summary = await page.locator('[data-identity-preview] [data-preview-version]').textContent();
  if (!(summary ?? '').includes('OpenAI Responses')) errors.push(`${tag}: preview summary lacks the protocol: ${String(summary)}`);
  await shot(page, `builtin-preview-${tag}`);
  await page.locator('[data-identity-preview] [data-preview-details] summary').click();
  await shot(page, `builtin-preview-expanded-${tag}`);

  // IDN-01: one draft per identity. Switching away and back keeps name,
  // User-Agent and overrides JSON, and no confirm dialog is involved.
  await openRow(page, width, 'custom:codex-1');
  await page.locator('[data-identity-label]').fill(CODEX_DRAFT.label);
  await page.locator('[data-identity-user-agent]').fill(CODEX_DRAFT.userAgent);
  await page.locator('[data-identity-overrides-details] summary').click();
  await page.locator('[data-identity-overrides]').fill(CODEX_DRAFT.overrides);
  await openRow(page, width, 'codex');
  await openRow(page, width, 'custom:claude-1');
  await page.locator('[data-identity-label]').fill(CLAUDE_DRAFT);
  await to(page, '[data-identity-detail="custom:claude-1"]');
  await shot(page, `custom-${tag}`);

  await openRow(page, width, 'custom:codex-1');
  check(`${tag} label kept across a switch`, await field(page, '[data-identity-label]'), CODEX_DRAFT.label);
  check(`${tag} User-Agent kept across a switch`, await field(page, '[data-identity-user-agent]'), CODEX_DRAFT.userAgent);
  check(`${tag} overrides JSON kept across a switch`, await field(page, '[data-identity-overrides]'), CODEX_DRAFT.overrides);
  await to(page, '[data-identity-detail="custom:codex-1"]');
  await shot(page, `draft-restored-${tag}`);

  // The directory marks which identity still holds a draft.
  if (narrow) await page.locator('[data-identity-back]').click();
  await settle(page);
  check(`${tag} drafted row is marked`, await page.locator('[data-identity-row="custom:codex-1"] [data-identity-unsaved]').count(), 1);
  check(`${tag} no marker on a clean row`, await page.locator('[data-identity-row="codex"] [data-identity-unsaved]').count(), 0);
  await shot(page, `draft-marked-${tag}`);

  // Saving writes one identity: the draft's values come back from the server,
  // and the other identity's draft is untouched.
  await openRow(page, width, 'custom:codex-1');
  await page.locator('[data-settings-draft="identity-custom:codex-1"] button').first().click();
  await page.waitForFunction((label) => document.querySelector('[data-identity-row="custom:codex-1"]')?.textContent?.includes(label), CODEX_DRAFT.label, { timeout: 10_000 });
  await settle(page);
  check(`${tag} saved value stays in the editor`, await field(page, '[data-identity-label]'), CODEX_DRAFT.label);
  await shot(page, `draft-saved-${tag}`);
  await openRow(page, width, 'custom:claude-1');
  check(`${tag} other draft survives a save`, await field(page, '[data-identity-label]'), CLAUDE_DRAFT);

  // A rejected save keeps the input and the message, and both survive a switch.
  await page.locator('[data-identity-user-agent]').fill('claude-cli/{version} {terminal}');
  await page.locator('[data-settings-draft="identity-custom:claude-1"] button').first().click();
  await page.waitForSelector('[data-identity-detail="custom:claude-1"] [data-field-issue]', { timeout: 10_000 });
  await to(page, '[data-identity-pairs="header"]');
  await shot(page, `draft-rejected-${tag}`);
  await openRow(page, width, 'custom:codex-1');
  await openRow(page, width, 'custom:claude-1');
  check(`${tag} field error survives a switch`, await page.locator('[data-identity-detail="custom:claude-1"] [data-field-issue]').count(), 1);

  // Leaving the page while a draft exists — on an identity that is not even
  // open — asks once, and staying keeps the draft.
  await openRow(page, width, 'codex');
  // Below lg the section list lives in a drawer opened from the page header,
  // directly after the desktop nav that is still in the DOM behind it.
  const leaf = page.locator('[data-settings-nav-leaf="general"]');
  if (narrow) {
    await page.locator('[data-settings-nav-trigger]').click();
    await leaf.last().waitFor();
    await leaf.last().click();
  } else {
    await leaf.click();
  }
  const dialog = page.locator('[aria-modal="true"]').filter({ hasText: '丢弃并离开' });
  await dialog.waitFor({ timeout: 10_000 });
  await shot(page, `guard-${tag}`);
  await dialog.getByRole('button', { name: '继续编辑' }).click();
  await dialog.waitFor({ state: 'detached' });
  await settle(page);
  check(`${tag} cancel keeps the page`, new URL(page.url()).pathname, '/settings/identity');
  await openRow(page, width, 'custom:claude-1');
  check(`${tag} cancel keeps the draft`, await field(page, '[data-identity-label]'), CLAUDE_DRAFT);

  // Discard clears only the identity it belongs to.
  await page.locator('[data-settings-discard="identity-custom:claude-1"]').click();
  await settle(page);
  check(`${tag} discard restores the stored label`, await field(page, '[data-identity-label]'), 'Claude Code (terminal)');
  check(`${tag} no draft marker is left`, await page.locator('[data-identity-unsaved]').count(), 0);
  await shot(page, `draft-discarded-${tag}`);

  await to(page, '#st-card-identity-tracks');
  await shot(page, `tracks-${tag}`);
  await page.locator('[data-identity-track="codex_cli"] [data-track-check="npm"]').click();
  await page.waitForSelector('[data-identity-track="codex_cli"] [data-track-candidate]');
  await to(page, '#st-card-identity-tracks');
  await shot(page, `tracks-staged-${tag}`);

  await to(page, '#st-card-identity-usage');
  await shot(page, `usage-${tag}`);
  await to(page, '#st-card-identity-recent');
  await shot(page, `recent-${tag}`);
}

for (const width of widths) {
  for (const theme of ['light', 'dark']) {
    await control({ action: 'scenario', name: 'request-identity' }).catch(() => {});
    const page = await browser.newPage({ viewport: { width, height: width < 600 ? 844 : 900 }, deviceScaleFactor: 1 });
    page.on('pageerror', (error) => { errors.push(`${theme}-${width}: ${error.message}`); });
    await page.addInitScript((next) => {
      localStorage.setItem('kiki.locale', 'zh');
      localStorage.setItem('kiki.settings', JSON.stringify({ theme: next }));
    }, theme);
    try { await walk(page, `${theme}-${width}`, width); }
    catch (error) { errors.push(`${theme}-${width}: ${error instanceof Error ? error.message : String(error)}`); await page.screenshot({ path: join(output, `failed-${theme}-${width}.png`) }).catch(() => {}); }
    finally { await page.close(); }
  }
}

await browser.close();
web.close();
fixture.http.close();
console.log(`[proof] ${output}`);
if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
}
process.exit();
