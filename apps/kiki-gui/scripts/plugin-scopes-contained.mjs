/**
 * The four plugin-scope deltas, rendered inside a contained run.
 *
 * The proof runner builds with vite and launches chromium in one process. This
 * script keeps those two jobs apart: it does NOT build — it serves an already
 * built `dist` from an in-process static server and launches chromium beside
 * it, sequentially, with the same real fixture server the runner uses. That is
 * what lets the render fit a small isolated job without a build, an editor or a
 * dev server running next to the browser.
 *
 * What it proves, and why each is worth a picture:
 *
 *   1. the ＋ menu and the rail agree — the same plugin, the same switch, the
 *      same level, before and after one pick, with the draft untouched;
 *   2. the install target really is the address — the MCP leaf's request for a
 *      workspace's entries is read off the network, not off the URL bar;
 *   3. trust is described as what actually reads it.
 *
 * Run: node scripts/plugin-scopes-contained.mjs <absolute-output-dir>
 * `KIKI_PROOF_CHROMIUM` may name a browser explicitly for an isolated run whose
 * HOME no longer holds Playwright's download; otherwise Playwright discovers
 * its own, exactly as the runner does.
 * Everything it starts (static server, fixture, chromium) is closed in finally.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, '.tmp', 'visual-proof', 'dist');
const OUT = resolve(process.argv[2] ?? join(ROOT, '.tmp', 'plugin-scopes-contained'));
// Chromium is discovered by Playwright, as the runner's renders are. An
// isolated run replaces HOME/LOCALAPPDATA, where Playwright's copy lives, so
// such a caller passes an absolute path in through the environment instead of
// this file carrying anyone's.
const CHROMIUM = process.env.KIKI_PROOF_CHROMIUM;
// The beacon and the log come first, before anything that can fail: a contained
// run whose candidate dies has no stdout anyone can read, so the first line of
// this file is the only way to tell "started and could not" from "never ran".
mkdirSync(OUT, { recursive: true });
const log = (line) => { appendFileSync(join(OUT, 'contained.log'), `${line}\n`); };
log(`start ${new Date().toISOString()} node=${process.version}`);
log(`argv ${process.argv.join(' ')}`);
log(`dist ${DIST} exists=${existsSync(join(DIST, 'index.html'))}`);
/** What the render actually served: a digest of the built entry and of every
 *  asset's name and size (vite names assets by content), not a timestamp. */
function distDigest(dir) {
  if (!existsSync(join(dir, 'index.html'))) return 'none';
  const hash = createHash('sha1').update(readFileSync(join(dir, 'index.html')));
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const child = rel === '' ? name : `${rel}/${name}`;
      const info = statSync(join(dir, child));
      if (info.isDirectory()) walk(child);
      else hash.update(`\n${child}:${info.size}`);
    }
  };
  walk('assets');
  return hash.digest('hex').slice(0, 16);
}

const SID = 'session_fixture_plugin_scopes';
const WSID = 'wd_plugin_scopes_0123456789ab';
const OTHER_WSID = 'wd_plugin_other_fedcba987654';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.map': 'application/json', '.ico': 'image/x-icon',
};

const assertions = [];
const check = (name, ok, detail) => {
  assertions.push(detail === undefined ? { name, pass: ok === true } : { name, pass: ok === true, detail });
  if (ok !== true) throw new Error(detail === undefined ? name : `${name} — ${detail}`);
};

/** The SPA server over the built bundle: unknown paths fall back to index.html. */
function startStatic(dir) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/__kiki/local-server') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    let file = normalize(join(dir, path));
    if (!file.startsWith(dir + sep) || !existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((done) => { server.listen(0, '127.0.0.1', () => { done(server); }); });
}

if (!existsSync(join(DIST, 'index.html'))) throw new Error(`no build at ${DIST}`);
log(`render start ${new Date().toISOString()} dist=${DIST}`);
const DIST_DIGEST = distDigest(DIST);
log(`dist digest ${DIST_DIGEST}`);
if (process.argv.includes('--probe')) {
  // Load-only mode: no server, no browser, no fixture. It exists so a contained
  // failure can be told apart from a launcher or environment failure.
  log(`probe ok env keys=${Object.keys(process.env).sort().join(',')}`);
  process.exit(0);
}

let web;
let fixture;
let browser;
try {
  const { chromium } = await import(pathToFileURL(join(ROOT, 'node_modules', 'playwright', 'index.mjs')).href);
  log('playwright loaded');
  web = await startStatic(DIST);
  const webUrl = `http://127.0.0.1:${web.address().port}`;
  fixture = await startFixtureServer({ port: 0, scenario: 'plugin-scopes' });
  const fixtureUrl = `http://127.0.0.1:${fixture.http.address().port}`;
  const link = (path) => `${webUrl}${path}${path.includes('?') ? '&' : '?'}server=${encodeURIComponent(fixtureUrl)}&token=${FIXTURE_TOKEN}`;
  log(`web ${webUrl} fixture ${fixtureUrl}`);

  browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-proxy-server', '--disable-gpu', '--disable-dev-shm-usage'] });  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', colorScheme: 'light', locale: 'en-US' });
  const page = await context.newPage();
  page.on('pageerror', (error) => { appendFileSync(join(OUT, 'browser-errors.log'), `${error.stack ?? error.message}\n`); });
  // The rendered app's own calls, which is the only place the real target of a
  // request can be read: a URL in the address bar is a wish, a request is a fact.
  const requests = [];
  page.on('request', (request) => {
    const body = request.postData();
    requests.push(decodeURIComponent(request.url()) + (body === null ? '' : ` :: ${decodeURIComponent(body)}`));
  });
  const shot = async (name) => { await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false }); log(`shot ${name}`); };
  const go = async (path, selector) => {
    await page.goto(link(path), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForSelector(selector, { timeout: 20_000 });
    await page.waitForTimeout(400);
  };
  const openRail = async () => {
    const head = page.locator('[data-rail-plugins] [aria-expanded]').first();
    if (await head.getAttribute('aria-expanded') === 'false') await head.click();
  };

  // 1 · One plugin, two surfaces, before and after one pick.
  await go(`/s/${SID}`, '[data-rail-plugins]');
  await openRail();
  await page.waitForSelector('[data-rail-plugin="office"]', { timeout: 15_000 });
  await page.locator('[data-rail-plugin="office"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  const railSource = async () => (await page.locator('[data-rail-plugin="office"] [data-rail-plugin-source]').textContent())?.trim();
  check('rail: office starts off', await page.locator('[data-rail-plugin="office"]').getAttribute('data-effective') === 'false');
  check('rail: office names the workspace, not the conversation', ['this workspace', '本工作区'].includes(await railSource()), await railSource());
  await shot('contained-rail-before');

  await page.locator('[data-add-menu-trigger]').first().click();
  await page.waitForSelector('[data-add-menu-plugins]', { timeout: 15_000 });
  await page.locator('[data-add-menu-plugins]').click();
  await page.waitForSelector('[data-add-plugins-view]', { timeout: 15_000 });
  await page.waitForTimeout(300);
  const caption = async (id) =>
    (await page.locator(`[data-add-plugin="${id}"]`).innerText()).split(String.fromCharCode(10))[1]?.trim() ?? '';
  const draftBefore = await page.locator('textarea[data-composer]').inputValue();
  check('＋ menu: office switch agrees with the rail', await page.locator('[data-add-plugin="office"] input[type=checkbox]').isChecked() === false);
  check('＋ menu: office caption names the workspace', /^off for this workspace$/i.test(await caption('office')), await caption('office'));
  await shot('contained-add-before');

  await page.locator('[data-add-plugin="office"] [role=switch]').click();
  await page.waitForTimeout(1200);
  check('＋ menu: the pick really checks the switch', await page.locator('[data-add-plugin="office"] input[type=checkbox]').isChecked() === true);
  check('＋ menu: the caption follows the switch onto this conversation', /^on for this conversation$/i.test(await caption('office')), await caption('office'));
  check('the pick leaves the draft alone', await page.locator('textarea[data-composer]').inputValue() === draftBefore);
  check('the pick keeps the panel open', await page.locator('[data-add-plugins-view]').count() === 1);
  await shot('contained-add-after');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  await go(`/s/${SID}`, '[data-rail-plugins]');
  await openRail();
  await page.waitForSelector('[data-rail-plugin="office"]', { timeout: 15_000 });
  await page.locator('[data-rail-plugin="office"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  check('rail: the same pick is checked here too', await page.locator('[data-rail-plugin="office"] input[type=checkbox]').isChecked() === true);
  check('rail: the row is on', await page.locator('[data-rail-plugin="office"]').getAttribute('data-effective') === 'true');
  check('rail: the level moved to this conversation', ['this conversation', '当前对话'].includes(await railSource()), await railSource());
  await shot('contained-rail-after');

  // 2 · The address decides the target: the MCP leaf a workspace page links to
  // must ask the server for THAT workspace's root. The procedure travels in the
  // call body, so the evidence is the request text, not the URL path.
  const before = requests.length;
  await go(`/settings/mcp?workspace=${WSID}`, '[data-mcp-workspace-root]');
  await page.waitForTimeout(700);
  check('MCP leaf: shows the linked workspace', (await page.locator('[data-mcp-workspace-name]').innerText()).includes('Scopes workspace'));
  check('MCP leaf: shows its root', (await page.locator('[data-mcp-workspace-root]').innerText()).includes('C:/fixture/scopes'));
  const reads = requests.slice(before).filter((entry) => entry.toLowerCase().includes('mcp') && entry.includes('{'));
  check('MCP leaf: actually asked for that root, not the bar’s wish',
    reads.some((entry) => entry.includes('C:/fixture/scopes')), reads.join(' | ') || 'no MCP call was made');
  check('MCP leaf: never asked for the other workspace',
    reads.every((entry) => !entry.includes('C:/fixture/other')), reads.join(' | '));
  check('MCP leaf: a plugin’s entry offers no edit',
    await page.locator('[data-mcp-server="from-plugin"] button[aria-label^="Edit"]').count() === 0);
  check('MCP leaf: an owned entry still does',
    await page.locator('[data-mcp-server="files"] button[aria-label^="Edit"]').count() === 1);
  await shot('contained-mcp-workspace');

  const beforeOther = requests.length;
  await go(`/settings/mcp?workspace=${OTHER_WSID}`, '[data-mcp-workspace-root]');
  await page.waitForTimeout(700);
  const otherReads = requests.slice(beforeOther).filter((entry) => entry.toLowerCase().includes('mcp') && entry.includes('{'));
  check('MCP leaf: a second workspace reads its own root',
    otherReads.some((entry) => entry.includes('C:/fixture/other')), otherReads.join(' | ') || 'no MCP call was made');
  const mcpEvidence = [...reads, ...otherReads];

  // 3 · Trust, described as what actually reads it.
  await go(`/settings/workspaces?workspace=${WSID}`, '[data-workspace-detail]');
  const trust = await page.locator('#st-card-workspace-trust').innerText();
  check('trust: names the project layers it gates', /config file, MCP servers and hooks/.test(trust), trust);
  check('trust: makes no claim about every tool', !/ask before|asks before/i.test(trust), trust);
  check('trust: the switch names the action', /Trust Scopes workspace/.test(trust), trust);
  check('trust: opening the page granted nothing', await page.locator('#workspace-trust-toggle').isChecked() === false);
  await page.locator('#st-card-workspace-trust').scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await shot('contained-trust');

  writeFileSync(join(OUT, 'report.json'), JSON.stringify({
    pass: true,
    source: { repo: ROOT, dist: DIST, distDigest: DIST_DIGEST, fixture: 'plugin-scopes', browser: CHROMIUM ?? 'playwright-default', viewport: '1440x900', locale: 'en-US' },
    assertions,
    // The rendered app's own calls for a workspace's entries: what was actually
    // asked for, so the target can be checked without trusting the address bar.
    evidence: { mcpReads: mcpEvidence },
  }, null, 2));
  log(`pass ${assertions.length} assertions`);
} catch (error) {
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ pass: false, assertions, error: { message: error.message, stack: error.stack } }, null, 2));
  log(`FAIL ${error.message}`);
  process.exitCode = 1;
} finally {
  // Everything this run started, closed here: the job cannot leave a listener,
  // a browser or a fixture behind even when an assertion threw.
  await browser?.close().catch(() => undefined);
  await new Promise((done) => { if (web === undefined) done(); else web.close(done); });
  await fixture?.stop().catch(() => undefined);
  log(`render end ${new Date().toISOString()}`);
}
