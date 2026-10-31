import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_VIEWPORTS = {
  wide: { width: 1440, height: 900 },
  narrow: { width: 390, height: 844 },
};
const DEFAULT_MATRIX = {
  themes: ['light'],
  locales: ['en'],
  viewports: ['wide'],
};
const MAX_SETUP_TIMEOUT_MS = 60_000;
const HELP = `
Headless Kiki GUI visual proof

Usage:
  node scripts/visual-proof.mjs --config path/to/proof.mjs
  node scripts/visual-proof.mjs --name smoke --scenario hero-shell --vite --route hero=./new

The config module exports a default object:
  {
    name: 'settings',
    baseUrl: 'http://127.0.0.1:5177',
    token: 'YOUR_TOKEN',
    scenario: 'hero-shell',
    vite: true,
    routes: [
      { name: 'hero', path: '/new', waitFor: '[data-phase="hero"]', setup: './setup.mjs' },
    ],
    matrix: { themes: ['light', 'dark'], locales: ['en'], viewports: ['wide', 'narrow'] },
  }

Options:
  --config <file>       Load route, setup, matrix and server options from an ESM module.
  --name <name>         Output name; defaults to the config name or visual-proof.
  --base-url <url>      Existing GUI URL. Omit with --vite to start Vite.
  --token <token>       Bearer token appended to each route.
  --server-url <url>    Existing API/fixture URL appended as the server query parameter.
  --scenario <name>     Start fixture-server in-process with this scenario.
  --vite                Start the GUI Vite server and stop it after the run.
  --route [name=]<path> Add a route; repeat for a matrix of route screenshots.
  --setup [name=]<file> Setup module for a route, or all routes when no name is given.
  --theme <list>        Comma-separated theme subset: light,dark.
  --locale <list>       Comma-separated locale subset: en,zh.
  --viewport <list>     Comma-separated viewport subset: wide,narrow.
  --matrix <list|all>   Shorthand subset from light,dark,en,zh,wide,narrow.
  --output-dir <path>   Override .tmp/visual-proof/<name>/.
  --help                Print this help and exit successfully.

A setup module exports an async function receiving { page, route, view }, or a
step array. Steps may be { click: selector }, { waitFor: selector }, or
{ scroll: selector | 'top' | 'bottom' }.
`;

function normalizeArgv(argv) {
  const knownWithValue = new Set([
    '--config', '--name', '--base-url', '--token', '--server-url', '--scenario',
    '--route', '--setup', '--theme', '--locale', '--lang', '--viewport', '--width',
    '--matrix', '--output-dir',
  ]);
  return argv.flatMap((arg) => {
    const separator = arg.indexOf('=');
    if (!arg.startsWith('--') || separator < 0) return [arg];
    const option = arg.slice(0, separator);
    return knownWithValue.has(option) ? [option, arg.slice(separator + 1)] : [arg];
  });
}

function valueAfter(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || (value.startsWith('--') && value !== '--')) throw new Error(`${option} requires a value`);
  return value;
}

function repeated(argv, option) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === option) values.push(valueAfter(argv, index, option));
  }
  return values;
}

function one(argv, option) {
  const values = repeated(argv, option);
  if (values.length > 1) throw new Error(`${option} may only be specified once`);
  return values[0];
}

function listValue(raw, name, allowed) {
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length === 0 || values.some((value) => !allowed.includes(value))) {
    throw new Error(`${name} must contain only ${allowed.join(', ')}`);
  }
  return [...new Set(values)];
}

function routeSpec(raw) {
  const separator = raw.indexOf('=');
  const name = separator < 0 ? undefined : raw.slice(0, separator);
  let path = separator < 0 ? raw : raw.slice(separator + 1);
  const msysPath = path.replaceAll('\\\\', '/').match(/^[A-Za-z]:\/Program Files\/Git\/(.+)$/i);
  if (msysPath !== null) path = `/${msysPath[1]}`;
  const routeName = name ?? (path.replace(/^\/+/, '').replace(/[^a-zA-Z0-9_-]+/g, '-') || 'route');
  if (!path) throw new Error(`route ${raw} has no path`);
  return { name: routeName, path };
}

function setupSpec(raw) {
  const separator = raw.indexOf('=');
  return separator < 0
    ? { name: null, file: raw }
    : { name: raw.slice(0, separator), file: raw.slice(separator + 1) };
}

function matrixShorthand(raw) {
  if (raw === undefined) return {};
  if (raw === 'all') return { themes: ['light', 'dark'], locales: ['en', 'zh'], viewports: Object.keys(DEFAULT_VIEWPORTS) };
  const themes = [];
  const locales = [];
  const viewports = [];
  for (const value of raw.split(',').map((item) => item.trim()).filter(Boolean)) {
    if (['light', 'dark'].includes(value)) themes.push(value);
    else if (['en', 'zh'].includes(value)) locales.push(value);
    else if (Object.hasOwn(DEFAULT_VIEWPORTS, value)) viewports.push(value);
    else throw new Error(`--matrix has unknown value ${value}; use light,dark,en,zh,wide,narrow, or all`);
  }
  return {
    themes: themes.length === 0 ? undefined : [...new Set(themes)],
    locales: locales.length === 0 ? undefined : [...new Set(locales)],
    viewports: viewports.length === 0 ? undefined : [...new Set(viewports)],
  };
}

export function parseGenericArgs(rawArgv) {
  const argv = normalizeArgv(rawArgv);
  const knownWithoutValue = new Set(['--help', '--vite']);
  const knownWithValue = new Set([
    '--config', '--name', '--base-url', '--token', '--server-url', '--scenario',
    '--route', '--setup', '--theme', '--locale', '--lang', '--viewport', '--width',
    '--matrix', '--output-dir',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (knownWithoutValue.has(arg)) continue;
    if (knownWithValue.has(arg)) {
      index += 1;
      if (argv[index] === undefined || argv[index].startsWith('--')) throw new Error(`${arg} requires a value`);
      continue;
    }
    throw new Error(`unknown visual-proof option: ${arg}`);
  }
  const routes = repeated(argv, '--route').map(routeSpec);
  const setupEntries = repeated(argv, '--setup').map(setupSpec);
  const setupByRoute = new Map();
  let globalSetup;
  for (const entry of setupEntries) {
    if (entry.name === null) {
      if (globalSetup !== undefined) throw new Error('--setup without a route name may only be specified once');
      globalSetup = entry.file;
    } else {
      if (setupByRoute.has(entry.name)) throw new Error(`duplicate --setup for route ${entry.name}`);
      setupByRoute.set(entry.name, entry.file);
    }
  }
  const matrix = matrixShorthand(one(argv, '--matrix'));
  const themes = one(argv, '--theme');
  const locales = one(argv, '--locale') ?? one(argv, '--lang');
  const viewports = one(argv, '--viewport') ?? one(argv, '--width');
  if (themes !== undefined && matrix.themes !== undefined) throw new Error('--matrix cannot be combined with --theme');
  if (locales !== undefined && matrix.locales !== undefined) throw new Error('--matrix cannot be combined with --locale/--lang');
  if (viewports !== undefined && matrix.viewports !== undefined) throw new Error('--matrix cannot be combined with --viewport/--width');
  return {
    help: argv.includes('--help'),
    config: one(argv, '--config'),
    name: one(argv, '--name'),
    baseUrl: one(argv, '--base-url'),
    token: one(argv, '--token'),
    serverUrl: one(argv, '--server-url'),
    scenario: one(argv, '--scenario'),
    vite: argv.includes('--vite'),
    routes,
    globalSetup,
    setupByRoute,
    matrix: {
      themes: themes === undefined ? matrix.themes : listValue(themes, '--theme', ['light', 'dark']),
      locales: locales === undefined ? matrix.locales : listValue(locales, '--locale', ['en', 'zh']),
      viewports: viewports === undefined ? matrix.viewports : listValue(viewports, '--viewport', Object.keys(DEFAULT_VIEWPORTS)),
    },
    outputDir: one(argv, '--output-dir'),
  };
}

function isGenericInvocation(argv) {
  if (argv.includes('--help')) return true;
  const legacy = argv.some((arg) => arg === '--only' || arg.startsWith('--only=') || arg === '--update-goldens' || arg === '--no-build');
  const generic = ['--config', '--base-url', '--token', '--server-url', '--scenario', '--vite', '--route', '--setup', '--theme', '--locale', '--lang', '--viewport', '--width', '--output-dir', '--name'];
  const hasGeneric = argv.some((arg) => generic.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
  const matrixOnly = argv.every((arg) => arg === '--matrix' || !arg.startsWith('--matrix=') || ['--matrix=default', '--matrix=all'].includes(arg));
  return !legacy && (hasGeneric || (!matrixOnly && argv.some((arg) => arg === '--matrix' || arg.startsWith('--matrix='))));
}

export { HELP, isGenericInvocation };

async function loadModule(file, baseDir) {
  const path = resolve(baseDir, file);
  return import(pathToFileURL(path).href);
}

async function loadConfig(file, baseDir = process.cwd()) {
  if (file === undefined) return {};
  const module = await loadModule(file, baseDir);
  const config = module.default ?? module.config;
  if (config === null || typeof config !== 'object') throw new Error(`visual proof config ${file} must export an object`);
  return { ...config, __configDir: dirname(resolve(baseDir, file)) };
}

function mergeConfig(cli, loaded) {
  const cliRoutes = cli.routes;
  const routes = cliRoutes.length > 0 ? cliRoutes : (loaded.routes ?? []);
  const cliMatrix = cli.matrix;
  const loadedMatrix = loaded.matrix ?? {};
  return {
    ...loaded,
    name: cli.name ?? loaded.name ?? 'visual-proof',
    baseUrl: cli.baseUrl ?? loaded.baseUrl ?? process.env.KIKI_VISUAL_BASE_URL,
    token: cli.token ?? loaded.token ?? process.env.KIKI_VISUAL_TOKEN,
    serverUrl: cli.serverUrl ?? loaded.serverUrl,
    scenario: cli.scenario ?? loaded.scenario,
    vite: cli.vite || loaded.vite === true,
    routes,
    globalSetup: cli.globalSetup ?? loaded.setup,
    setupByRoute: cli.setupByRoute.size > 0 ? cli.setupByRoute : loaded.setupByRoute,
    matrix: {
      themes: cliMatrix.themes ?? loadedMatrix.themes ?? DEFAULT_MATRIX.themes,
      locales: cliMatrix.locales ?? loadedMatrix.locales ?? DEFAULT_MATRIX.locales,
      viewports: cliMatrix.viewports ?? loadedMatrix.viewports ?? DEFAULT_MATRIX.viewports,
    },
    outputDir: cli.outputDir ?? loaded.outputDir,
    __configDir: loaded.__configDir ?? process.cwd(),
  };
}

function validateConfig(config) {
  if (!config.vite && typeof config.baseUrl !== 'string') {
    throw new Error('visual proof needs --base-url or --vite');
  }
  if (config.vite && config.baseUrl !== undefined && config.baseUrl !== null && config.baseUrl !== '') {
    throw new Error('--base-url cannot be combined with --vite; omit it to let visual-proof start Vite');
  }
  if (!Array.isArray(config.routes) || config.routes.length === 0) {
    throw new Error('visual proof needs at least one --route or config route');
  }
  const names = new Set();
  for (const route of config.routes) {
    if (route === null || typeof route !== 'object' || typeof route.path !== 'string' || route.path.length === 0) {
      throw new Error('each route needs a non-empty path');
    }
    route.name ??= route.path.replace(/^\/+/, '').replace(/[^a-zA-Z0-9_-]+/g, '-') || 'route';
    if (names.has(route.name)) throw new Error(`duplicate route name ${route.name}`);
    names.add(route.name);
  }
  if (config.scenario !== undefined && config.serverUrl !== undefined) {
    throw new Error('--scenario cannot be combined with --server-url');
  }
  for (const key of ['themes', 'locales', 'viewports']) {
    if (!Array.isArray(config.matrix[key]) || config.matrix[key].length === 0) throw new Error(`matrix.${key} cannot be empty`);
  }
}

function combinations(matrix) {
  const views = [];
  for (const locale of matrix.locales) {
    for (const theme of matrix.themes) {
      for (const viewport of matrix.viewports) views.push({ locale, theme, viewport });
    }
  }
  return views;
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'proof';
}

function routeUrl(baseUrl, routePath, serverUrl, token) {
  const url = new URL(routePath, baseUrl);
  if (serverUrl !== undefined) url.searchParams.set('server', serverUrl);
  if (token !== undefined) url.searchParams.set('token', token);
  return url.href;
}

function publicUrl(value) {
  if (value === undefined || value === null) return value;
  try {
    const url = new URL(value);
    url.searchParams.delete('token');
    url.searchParams.delete('authorization');
    const nestedServer = url.searchParams.get('server');
    if (nestedServer !== null) {
      try {
        const server = new URL(nestedServer);
        server.searchParams.delete('token');
        server.searchParams.delete('authorization');
        url.searchParams.set('server', server.href);
      } catch {
        // Keep a non-URL server value unchanged.
      }
    }
    return url.href;
  } catch {
    return value;
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const port = server.address().port;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

async function waitForVite(url, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite exited with ${child.exitCode}: ${output.trim()}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      // Vite is still starting or the first request raced its listener.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Vite did not become ready at ${url}: ${output.trim()}`);
}

async function startVite(serverUrl) {
  const port = await freePort();
  const viteBin = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(viteBin)) throw new Error(`Vite is not installed at ${viteBin}`);
  const child = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(port)], {
    cwd: ROOT,
    env: { ...process.env, ...(serverUrl === undefined ? {} : { KIKI_SERVER_URL: serverUrl }) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForVite(url, child);
    return { child, url };
  } catch (error) {
    await stopVite(child);
    throw error;
  }
}

async function stopVite(child) {
  if (child === undefined || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(), 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
  if (child.exitCode === null && process.platform === 'win32' && child.pid !== undefined) {
    const killer = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `taskkill /PID ${child.pid} /T /F`], { windowsHide: true, stdio: 'ignore' });
    await new Promise((resolvePromise) => killer.once('exit', resolvePromise));
  }
}

async function settleAnimations(page, timeoutMs) {
  await page.evaluate(async (limit) => {
    const finite = document.getAnimations().filter((animation) => {
      const iterations = animation.effect?.getComputedTiming().iterations;
      return animation.playState === 'running' && iterations !== Infinity;
    });
    await Promise.race([
      Promise.all(finite.map((animation) => animation.finished.catch(() => undefined))),
      new Promise((resolvePromise) => setTimeout(resolvePromise, limit)),
    ]);
  }, timeoutMs).catch(() => undefined);
}

async function scrollPage(page, value) {
  if (value === undefined || value === null) return;
  if (value === 'top' || value === 'bottom') {
    await page.evaluate((position) => window.scrollTo({ top: position === 'bottom' ? document.documentElement.scrollHeight : 0, behavior: 'auto' }), value);
    return;
  }
  const selector = typeof value === 'string' ? value : value.selector;
  if (selector === undefined) throw new Error('scroll setup needs a selector, top, or bottom');
  await page.locator(selector).scrollIntoViewIfNeeded();
}

async function runSteps(page, steps) {
  if (!Array.isArray(steps)) throw new Error('setup steps must be an array');
  for (const step of steps) {
    if (step?.click !== undefined) await page.locator(step.click).click(step.options);
    if (step?.waitFor !== undefined) await page.waitForSelector(step.waitFor, step.options);
    if (step?.scroll !== undefined) await scrollPage(page, step.scroll);
  }
}

async function resolveSetup(route, config) {
  const setup = route.setup
    ?? config.setupByRoute?.get?.(route.name)
    ?? config.setupByRoute?.[route.name]
    ?? config.globalSetup;
  if (setup === undefined) return undefined;
  if (typeof setup === 'function' || Array.isArray(setup)) return setup;
  if (typeof setup !== 'string') throw new Error(`setup for ${route.name} must be a module path, function, or step array`);
  const module = await loadModule(setup, config.__configDir);
  return module.default ?? module.setup ?? module.steps;
}

async function runSetup(page, setup, context) {
  if (setup === undefined) return;
  if (Array.isArray(setup)) {
    await runSteps(page, setup);
    return;
  }
  if (typeof setup !== 'function') throw new Error('setup module must export a function or step array');
  await setup({
    ...context,
    click: (selector, options) => page.locator(selector).click(options),
    waitFor: (selector, options) => page.waitForSelector(selector, options),
    scroll: (selectorOrPosition) => scrollPage(page, selectorOrPosition),
  });
}

async function waitNetworkIdle(page) {
  await page.waitForLoadState('networkidle', { timeout: MAX_SETUP_TIMEOUT_MS });
}

export async function runGenericVisualProof({ argv = process.argv.slice(2), cwd = process.cwd() } = {}) {
  const cli = parseGenericArgs(argv);
  if (cli.help) {
    process.stdout.write(`${HELP.trimStart()}\n`);
    return { help: true, screenshots: [], outputDir: null };
  }
  const loaded = await loadConfig(cli.config);
  const config = mergeConfig(cli, loaded);
  validateConfig(config);
  const outputDir = resolve(cwd, config.outputDir ?? join(ROOT, '.tmp', 'visual-proof', safeName(config.name)));
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  const fixture = config.scenario === undefined ? undefined : await startFixtureServer({ port: 0, scenario: config.scenario });
  const fixtureUrl = fixture === undefined ? undefined : `http://127.0.0.1:${fixture.http.address().port}`;
  const serverUrl = fixtureUrl ?? config.serverUrl;
  let vite;
  let browser;
  const screenshots = [];
  const startedAt = new Date().toISOString();
  try {
    vite = config.vite ? await startVite(serverUrl) : undefined;
    const baseUrl = vite?.url ?? config.baseUrl;
    if (baseUrl === undefined) throw new Error('visual proof could not determine a GUI base URL');
    console.log(`[visual-proof] base ${publicUrl(baseUrl)}`);
    browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
    const views = combinations(config.matrix);
    for (const view of views) {
      const viewport = DEFAULT_VIEWPORTS[view.viewport];
      for (const route of config.routes) {
        const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
        try {
          await context.addInitScript(({ locale, theme }) => {
            try {
              localStorage.setItem('kiki.locale', locale);
              const raw = localStorage.getItem('kiki.settings');
              const settings = raw === null ? {} : JSON.parse(raw);
              localStorage.setItem('kiki.settings', JSON.stringify({ ...settings, theme }));
            } catch {
              // Some external pages intentionally disable storage.
            }
          }, view);
          const page = await context.newPage();
          await page.emulateMedia({ colorScheme: view.theme });
          const setup = await resolveSetup(route, config);
          const url = routeUrl(baseUrl, route.path, serverUrl, config.token ?? (fixtureUrl === undefined ? undefined : FIXTURE_TOKEN));
          console.log(`[visual-proof] route ${route.name} ${route.path} -> ${publicUrl(url)}`);
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: MAX_SETUP_TIMEOUT_MS });
          await waitNetworkIdle(page);
          const selectors = route.waitFor === undefined ? [] : (Array.isArray(route.waitFor) ? route.waitFor : [route.waitFor]);
          for (const selector of selectors) await page.waitForSelector(selector, { timeout: MAX_SETUP_TIMEOUT_MS });
          await runSetup(page, setup, { page, route, view, baseUrl, serverUrl, outputDir });
          await scrollPage(page, route.scroll);
          await settleAnimations(page, Number(route.animationTimeoutMs ?? 2000));
          await waitNetworkIdle(page);
          const file = `${safeName(route.name)}--${view.locale}--${view.theme}--${view.viewport}.png`;
          const path = join(outputDir, file);
          await page.screenshot({ path, fullPage: route.fullPage === true });
          screenshots.push({ file, route: route.name, path: route.path, url: publicUrl(url), ...view });
          console.log(`[visual-proof] ${file}`);
        } finally {
          await context.close();
        }
      }
    }
    const index = {
      name: config.name,
      baseUrl: publicUrl(baseUrl),
      serverUrl: publicUrl(serverUrl),
      scenario: config.scenario ?? null,
      startedAt,
      finishedAt: new Date().toISOString(),
      headless: true,
      screenshots,
    };
    writeFileSync(join(outputDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
    console.log(`[visual-proof] wrote ${screenshots.length} screenshot(s) to ${outputDir}`);
    return { help: false, screenshots, outputDir, index };
  } catch (error) {
    if (typeof config.token === 'string' && config.token.length > 0) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.replaceAll(config.token, '[redacted]'));
    }
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    await fixture?.stop().catch(() => undefined);
    await stopVite(vite?.child);
  }
}
