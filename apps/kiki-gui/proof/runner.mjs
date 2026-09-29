/**
 * Shared visual-proof runner.
 *
 * One static production build served in-process, one chromium, and one job per
 * scenario: every job gets its own browser context and its own fixture server,
 * so scenarios never share server, storage or viewport state, and the old
 * `/__control` scenario switch + reload + settle sleep has nothing left to do.
 * No child process is spawned except the one-shot `vite build`, so a crashed
 * run cannot leave a dev server or a stale listener behind.
 *
 * A caller supplies a registry (`{ name, fixture, run, ... }`) and receives the
 * results. The runner owns: argument/output selection, the build and its cache,
 * the static server, the job queue, per-job contexts, hard timeouts, the FAIL
 * screenshot, and the summary lines the gates grep for.
 *
 * Job context handed to `entry.run(context)`:
 *   page     — the job's page (timeline monitor installed)
 *   view     — { locale, theme, width } the job must render
 *   out      — this run's screenshot directory
 *   webUrl   — static server origin
 *   fixtureUrl — this job's fixture server origin (no trailing slash)
 *   link(path) — app URL carrying the fixture deep-link query
 *   control(body) — POST /__control on this job's fixture server
 *   shot(name) — settle finite animations, capture `<name>.png`
 *   errors   — pageerror messages collected for the job so far
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

import { FIXTURE_TOKEN, startFixtureServer } from '../scripts/fixture-server.mjs';
import { installTimelineMonitor } from '../scripts/timeline-integrity.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
  '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

export const UPDATE_GOLDENS_FLAG = '--update-goldens';
const ONLY_PREFIX = '--only=';
const MATRIX_PREFIX = '--matrix=';

/** How many runs stay in the disposable output root before older ones go. */
const KEEP_RUNS = 10;
const RUN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T/;

/**
 * Values a declared matrix dimension takes under `--matrix=all`. `--matrix=default`
 * keeps only the canonical en/light/1440 view of every scenario.
 */
export const MATRIX_VALUES = {
  locale: ['en', 'zh'],
  theme: ['light', 'dark'],
  width: [1440, 390],
};
const CANONICAL_VIEW = { locale: 'en', theme: 'light', width: 1440 };
/** Every scenario runs in each locale; theme/width are opt-in per scenario. */
const BASE_DIMENSIONS = ['locale'];

function product(choices) {
  return choices.reduce((rows, values) => rows.flatMap((row) => values.map((value) => [...row, value])), [[]]);
}

/**
 * The dimensions in which a view differs from the canonical one, as a short
 * suffix (`dark`, `390`, `zh`, `zh-dark-390`). Screenshot names carry it so two
 * views of the same screen stay distinct files in one run directory — the old
 * zh replica run got that separation from a second output directory.
 */
function viewSuffix(view) {
  return ['theme', 'width'].filter((dim) => view[dim] !== CANONICAL_VIEW[dim])
    .concat(view.locale === CANONICAL_VIEW.locale ? [] : ['locale'])
    .map((dim) => (dim === 'locale' ? view.locale : view[dim]))
    .join('-');
}

/** Job ids carry the non-canonical dimensions, so a FAIL line names its view. */
function jobId(name, view) {
  const extras = ['theme', 'width'].filter((dim) => view[dim] !== CANONICAL_VIEW[dim]).map((dim) => `${dim}=${view[dim]}`);
  if (view.locale !== CANONICAL_VIEW.locale) extras.unshift(`locale=${view.locale}`);
  return extras.length === 0 ? name : `${name}[${extras.join(' ')}]`;
}

/**
 * One job per scenario × view. A scenario declares the dimensions its walk
 * really varies (`matrix: ['theme', 'width']`); the runner gives each
 * combination its own context, so no walker has to loop over them itself.
 */
export function expandJobs(scenarios, { only, matrix }) {
  const jobs = [];
  for (const entry of scenarios) {
    if (only !== null && !only.includes(entry.name)) continue;
    const dimensions = [...BASE_DIMENSIONS, ...(entry.matrix ?? [])];
    const choices = dimensions.map((dim) => (matrix === 'all' ? MATRIX_VALUES[dim] : [CANONICAL_VIEW[dim]]));
    for (const combination of product(choices)) {
      const view = { ...CANONICAL_VIEW };
      dimensions.forEach((dim, index) => { view[dim] = combination[index]; });
      jobs.push({ entry, id: jobId(entry.name, view), view });
    }
  }
  return jobs;
}

export function runId(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * Parse and validate the command line. Everything is checked before any file
 * is written, so a typo cannot truncate a previous run's screenshots.
 */
export function parseProofArgs(argv, scenarioNames) {
  const updateGoldens = argv.includes(UPDATE_GOLDENS_FLAG);
  const onlyArgs = argv.filter((arg) => arg.startsWith(ONLY_PREFIX));
  if (onlyArgs.length > 1) throw new Error(`${ONLY_PREFIX}<names> may only be specified once`);
  const only = onlyArgs.length === 0 ? null : onlyArgs[0].slice(ONLY_PREFIX.length).split(',');
  const unknown = only?.filter((name) => name.length === 0 || !scenarioNames.includes(name)) ?? [];
  if (unknown.length > 0) throw new Error(`unknown scenario(s): ${unknown.join(', ')}`);
  if (updateGoldens && only !== null) throw new Error(`${UPDATE_GOLDENS_FLAG} cannot be combined with ${ONLY_PREFIX}`);

  const matrixArgs = argv.filter((arg) => arg.startsWith(MATRIX_PREFIX));
  if (matrixArgs.length > 1) throw new Error(`${MATRIX_PREFIX}<mode> may only be specified once`);
  const matrix = matrixArgs.length === 0 ? 'default' : matrixArgs[0].slice(MATRIX_PREFIX.length);
  if (matrix !== 'default' && matrix !== 'all') throw new Error(`${MATRIX_PREFIX} must be default or all, got ${matrix}`);

  const known = [UPDATE_GOLDENS_FLAG, '--no-build'];
  for (const arg of argv) {
    if (known.includes(arg) || arg.startsWith(ONLY_PREFIX) || arg.startsWith(MATRIX_PREFIX)) continue;
    throw new Error(`unknown argument: ${arg}`);
  }

  return { updateGoldens, only, matrix, noBuild: argv.includes('--no-build') };
}

/**
 * Pick this run's screenshot directory. A disposable run always gets its own
 * run-id directory, so two concurrent `--only` runs cannot clear each other's
 * output; `--update-goldens` writes the tracked goldens instead.
 */
export function selectOutput({ root, argv, scenarioNames, goldensDir }) {
  const { updateGoldens, only, matrix, noBuild } = parseProofArgs(argv, scenarioNames);
  const dir = updateGoldens
    ? goldensDir
    : resolve(process.env.KIKI_PROOF_OUTPUT_DIR ?? join(root, '.tmp', 'visual-proof', runId()));
  return { updateGoldens, only, matrix, noBuild, outputDir: dir };
}

/** Drop disposable run directories beyond the newest `KEEP_RUNS`, plus their `latest` pointer check. */
function pruneRuns(outputRoot, current) {
  let entries;
  try {
    entries = readdirSync(outputRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const runs = entries
    .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const stale = runs.filter((name) => name !== current).slice(0, Math.max(0, runs.length - KEEP_RUNS));
  for (const name of stale) rmSync(join(outputRoot, name), { recursive: true, force: true });
}

/**
 * Build key for the private build directory: the commit, the working-tree
 * status, and a name/size/mtime fingerprint of every bundle input. A run on an
 * unchanged tree reuses the previous build for free; any edit (even one that
 * keeps the file size) bumps an mtime and rebuilds.
 */
function buildCacheKey(root) {
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const head = git(['rev-parse', 'HEAD']);
  if (head === null) return null;
  const hash = createHash('sha1').update(head);
  hash.update(git(['status', '--porcelain=v1', '--', 'src', 'index.html', 'vite.config.ts', 'public']) ?? '');
  const inputs = [join(root, 'src'), join(root, 'index.html'), join(root, 'vite.config.ts'), join(root, 'public')];
  const walk = (path) => {
    let info;
    try {
      info = statSync(path);
    } catch {
      return;
    }
    if (info.isDirectory()) {
      for (const child of readdirSync(path).sort()) walk(join(path, child));
      return;
    }
    hash.update(`\n${path.slice(root.length)}:${info.size}:${info.mtimeMs}`);
  };
  for (const input of inputs) walk(input);
  return hash.digest('hex');
}

function build(root, distDir) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [
    join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build',
    '--outDir', distDir, '--emptyOutDir', '--logLevel', 'warn',
  ], { cwd: root, stdio: 'inherit', timeout: 180_000 });
  if (result.status !== 0) throw new Error(`vite build failed (status ${result.status})`);
  return Date.now() - started;
}

/** Static SPA server over the build; `/__kiki/local-server` reports no local server. */
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

function withTimeout(promise, ms, label) {
  let timer;
  // The losing branch keeps running; swallow its late rejection so a timed-out
  // job reports the timeout instead of a stray unhandled rejection.
  promise.catch(() => undefined);
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** The app shell renders the sidebar on every route; the composer follows. */
const SHELL_READY = '[data-session-sidebar]';
const COMPOSER_READY = 'textarea:not([disabled])';

/**
 * Wait until the fixture server has seen the app's websocket handshake. The
 * old harness slept ~1s here for the same reason: a scenario that sends a
 * prompt before the socket is up loses the frames the fixture emits in reply.
 * Returns false when the app never connected, so the caller can say so.
 */
async function waitForAppHandshake(control, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const log = await control({ action: 'ws_log' }).catch(() => null);
    if ((log?.data?.inbound?.length ?? 0) > 0) return true;
    if (Date.now() > deadline) return false;
    await new Promise((done) => setTimeout(done, 100));
  }
}

async function runJob({ browser, job, webUrl, out, shotNames, jobTimeoutMs }) {
  const { entry, id, view } = job;
  const suffix = viewSuffix(view);
  const started = Date.now();
  const fixture = await startFixtureServer({ port: 0, scenario: entry.fixture ?? entry.name });
  const fixtureUrl = `http://127.0.0.1:${fixture.http.address().port}`;
  const link = (path) => `${webUrl}${path}${path.includes('?') ? '&' : '?'}server=${encodeURIComponent(fixtureUrl)}&token=${FIXTURE_TOKEN}`;
  const control = async (body) => {
    const response = await fetch(`${fixtureUrl}/__control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`fixture control ${JSON.stringify(body)} failed with HTTP ${response.status}`);
    return response.json();
  };
  const errors = [];
  const jobShots = [];
  const shot = async (name) => {
    // A non-canonical view keeps its own copy of every screen.
    const file = suffix === '' ? name : `${name}-${suffix}`;
    if (shotNames.has(file)) throw new Error(`duplicate screenshot name in this run: ${file}`);
    shotNames.add(file);
    jobShots.push(file);
    // Settle finite animations (entrance fades, chevron turns) before capture:
    // a frame taken mid-entrance shows rows at partial opacity and chevrons
    // half-rotated, which reads as a design defect that is not there. Looping
    // signatures (spinners, breathing dots) are infinite and are left running.
    const inFlight = await page.evaluate(async () => {
      const finite = () => document.getAnimations().filter((animation) => {
        const iterations = animation.effect?.getComputedTiming().iterations;
        return animation.playState === 'running' && iterations !== Infinity;
      });
      const count = finite().length;
      await Promise.all(finite().map((animation) => animation.finished.catch(() => undefined)));
      return count;
    }).catch(() => 0);
    await page.screenshot({ path: join(out, `${file}.png`) });
    console.log(`[shot] ${file}.png${inFlight > 0 ? ` (settled ${inFlight} animations)` : ''}`);
    // KIKI_PROOF_PROBE="sel1|sel2": log the effective opacity (the product of
    // every ancestor's) and text colour of each match — a diagnostic for "is
    // this faint by design or caught mid-transition".
    if (process.env.KIKI_PROOF_PROBE !== undefined) {
      const report = await page.evaluate((selectors) => selectors.map((selector) => {
        const element = document.querySelector(selector);
        if (element === null) return { selector, found: false };
        let opacity = 1;
        const chain = [];
        for (let node = element; node !== null && node instanceof Element; node = node.parentElement) {
          const own = Number(getComputedStyle(node).opacity);
          if (own < 1) chain.push(`${node.tagName.toLowerCase()}.${String(node.className).slice(0, 40)}=${own}`);
          opacity *= own;
        }
        const style = getComputedStyle(element);
        return { selector, opacity: Number(opacity.toFixed(3)), color: style.color, background: style.backgroundColor, chain };
      }), process.env.KIKI_PROOF_PROBE.split('|'));
      console.log(`[probe] ${name} ${JSON.stringify(report)}`);
    }
  };

  const context = await browser.newContext({
    viewport: { width: view.width, height: view.width <= 600 ? 844 : 900 },
    reducedMotion: 'reduce',
  });
  let page;
  try {
    await context.addInitScript(({ locale, theme, onboardingCompleted }) => {
      try {
        if (localStorage.getItem('kiki.locale') === null) localStorage.setItem('kiki.locale', locale);
        if (theme !== null) {
          const raw = localStorage.getItem('kiki.settings');
          const settings = raw === null ? {} : JSON.parse(raw);
          if (settings.theme === undefined) localStorage.setItem('kiki.settings', JSON.stringify({ ...settings, theme }));
        }
        if (onboardingCompleted) {
          if (localStorage.getItem('kiki.onboarding') === null) {
            localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
          }
        } else {
          localStorage.removeItem('kiki.onboarding');
          localStorage.removeItem('kiki.newSessionDraft');
        }
      } catch { /* storage unavailable */ }
    }, {
      locale: view.locale,
      theme: view.theme ?? null,
      onboardingCompleted: entry.onboarding !== false,
    });
    page = await context.newPage();
    page.on('pageerror', (error) => {
      errors.push(error.message);
      console.error(`[pageerror] ${id}: ${error.message}`);
    });
    page.on('console', (message) => {
      if (message.type() === 'error') console.error(`[console:error] ${id}: ${message.text()}`);
    });
    await installTimelineMonitor(page);
    await page.goto(link('/new'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForSelector(SHELL_READY, { timeout: 30_000 });
    // Fixtures with no sessions never render the composer; that is a fixture
    // property, not a slow boot, so the wait is best-effort by design.
    await page.waitForSelector(COMPOSER_READY, { timeout: entry.onboarding === false ? 5_000 : 20_000 }).catch(() => undefined);
    if (!await waitForAppHandshake(control, 15_000)) console.warn(`[${id}] the app never opened a websocket to the fixture`);
    const jobContext = { page, view, out, webUrl, fixtureUrl, link, control, shot, errors };
    await withTimeout(entry.run(jobContext), jobTimeoutMs, `job ${id}`);
    if (errors.length > 0) throw new Error(`pageerror: ${errors.join(' | ')}`);
    return { id, name: entry.name, view, ok: true, ms: Date.now() - started, shots: jobShots };
  } catch (error) {
    if (page !== undefined) await page.screenshot({ path: join(out, `${id}-FAIL.png`) }).catch(() => undefined);
    return { id, name: entry.name, view, ok: false, ms: Date.now() - started, shots: jobShots, error: error.message };
  } finally {
    await context.close().catch(() => undefined);
    await fixture.stop().catch(() => undefined);
  }
}

/**
 * Evaluate every scenario module this run will use once, in registry order,
 * with the fixture-id counter reset before each — so ids are the same on every
 * run instead of depending on which browser context loaded the module first.
 */
async function primeFixtureIds(root, fixtures) {
  const { resetFid } = await import('../fixtures/helpers.mjs');
  for (const name of fixtures) {
    resetFid();
    await import(pathToFileURL(join(root, 'fixtures', `${name}.scenario.mjs`)).href);
  }
}

export async function runProof({
  root,
  scenarios,
  argv,
  label = 'proof',
  goldensDir = join(root, 'screenshots', 'batch3'),
  distDir = join(root, '.tmp', 'visual-proof', 'dist'),
  workers = Math.max(1, Number(process.env.KIKI_PROOF_WORKERS ?? 4)),
  jobTimeoutMs = Number(process.env.KIKI_PROOF_JOB_TIMEOUT_MS ?? 60_000),
  runTimeoutMs = Number(process.env.KIKI_PROOF_RUN_TIMEOUT_MS ?? 15 * 60_000),
  onWebUp,
}) {
  const names = scenarios.map((entry) => entry.name);
  const options = selectOutput({ root, argv, scenarioNames: names, goldensDir });
  const jobs = expandJobs(scenarios, options);
  await primeFixtureIds(root, [...new Set(jobs.map((job) => job.entry.fixture ?? job.entry.name))]);

  mkdirSync(options.outputDir, { recursive: true });
  if (options.updateGoldens) {
    // Updating the tracked goldens replaces them: a scenario that no longer
    // captures a screen must not leave its old golden behind.
    rmSync(options.outputDir, { recursive: true, force: true });
    mkdirSync(options.outputDir, { recursive: true });
  } else {
    const outputRoot = dirname(options.outputDir);
    writeFileSync(join(outputRoot, 'latest'), `${options.outputDir}\n`);
    pruneRuns(outputRoot, basename(options.outputDir));
  }
  console.log(`[${label}] mode: ${options.updateGoldens ? 'update-goldens' : 'disposable'}`);
  console.log(`[${label}] output: ${options.outputDir}`);
  console.log(`[${label}] matrix: ${options.matrix}`);
  console.log(`[${label}] jobs: ${jobs.length} (workers ${Math.min(workers, Math.max(jobs.length, 1))})`);

  const heartbeat = setTimeout(() => {
    console.error(`[${label}] run exceeded ${runTimeoutMs}ms — exiting`);
    process.exit(2);
  }, runTimeoutMs);
  heartbeat.unref();

  const startedAt = Date.now();
  const cacheKey = buildCacheKey(root);
  const cached = cacheKey !== null && existsSync(join(distDir, 'index.html'))
    && existsSync(join(distDir, '.kiki-build-key'))
    && readFileSyncText(join(distDir, '.kiki-build-key')) === cacheKey;
  let buildMs = 0;
  if (options.noBuild && existsSync(join(distDir, 'index.html'))) {
    console.log(`[${label}] reusing build in ${distDir} (--no-build)`);
  } else if (cached) {
    console.log(`[${label}] reusing build in ${distDir} (unchanged sources)`);
  } else {
    console.log(`[${label}] building -> ${distDir}`);
    buildMs = build(root, distDir);
    if (cacheKey !== null) writeFileSync(join(distDir, '.kiki-build-key'), cacheKey);
  }

  const web = await startStatic(distDir);
  const webUrl = `http://127.0.0.1:${web.address().port}`;
  onWebUp?.(webUrl);
  const launchStarted = Date.now();
  const browser = await chromium.launch({ args: ['--no-proxy-server'] });
  const launchMs = Date.now() - launchStarted;
  console.log(`[${label}] web up at ${webUrl} (build ${buildMs}ms, chromium ${launchMs}ms)`);

  const results = [];
  const shotNames = new Set();
  try {
    const queue = [...jobs];
    const worker = async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        const result = await runJob({ browser, job: next, webUrl, out: options.outputDir, shotNames, jobTimeoutMs });
        console.log(`[${label}] ${result.ok ? 'ok  ' : 'FAIL'} ${result.id} ${result.ms}ms ${result.shots.length} shots${result.ok ? '' : ` — ${result.error}`}`);
        results.push(result);
      }
    };
    await Promise.all(Array.from({ length: Math.min(workers, jobs.length) }, worker));
  } finally {
    await browser.close().catch(() => undefined);
    await new Promise((done) => web.close(done));
  }
  clearTimeout(heartbeat);

  const failed = results.filter((result) => !result.ok);
  const shots = results.reduce((total, result) => total + result.shots.length, 0);
  console.log(`[${label}] build ${buildMs}ms, chromium ${launchMs}ms, jobs ${results.length}, shots ${shots}, total ${Date.now() - startedAt}ms`);
  console.log(failed.length > 0 ? `${label.toUpperCase()} FAILED` : `${label.toUpperCase()} DONE`);
  return { failed, results, shots, outputDir: options.outputDir, buildMs, launchMs, totalMs: Date.now() - startedAt };
}

function readFileSyncText(path) {
  try {
    return statSync(path).size === 0 ? null : readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
