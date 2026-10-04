/**
 * Visual proof for the remote-Kiki surfaces added after the first pass: the SSH
 * way into a space, the composer's remote-target line, and where a bridged
 * message came from.
 *
 * As in `visual-proof-remote-spaces.mjs`, the remote side is mocked at the
 * browser level: the plan the source home returns is this script's own value,
 * and the transcript's bridged block is seeded through the shared transcript
 * fixture. What is judged here is the GUI against the typed contract — this is
 * not a claim about a live SSH peer.
 *
 *   node scripts/visual-proof-remote-entry.mjs [--only=ssh-plan]
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXTURE_TOKEN } from './fixture-server.mjs';
import { spaceDesktopMock } from './space-desktop-mock.mjs';
import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SPACES = [{ id: 'main', path: 'C:\\Users\\fixture\\.kiki' }];
const SOURCE_HOME = '1a5b2f0e-6c1d-4a2f-9b3e-2f0c1d2e3f40';
const REMOTE_ID = '2b6c3f1a-7d2e-4b3f-8c4f-3a1b2c3d4e50';
const BRIDGE_ONLY_ID = '3c7d4a2b-8e3f-4c40-9d50-4b2c3d4e5f61';

/** A saved SSH host, as the settings row would hold it. */
const HOST = {
  id: 'ssh-acme', name: 'acme-box', source: 'kiki', hostname: '10.0.0.9', user: 'kiki', port: 22,
  identityFile: 'C:/Users/fixture/.ssh/id_ed25519', roots: ['/srv/kiki'],
};

function identity(homeId, hostId) {
  return { homeId, hostId, protocol: 1 };
}

function plan(state) {
  return {
    id: 'plan-1',
    profile: {
      id: 'profile-1', label: 'acme-box', target: { kind: 'alias', alias: 'ssh-acme' },
      releaseChannel: 'stable', remoteHome: '/srv/kiki', remoteExecutable: 'kiki', remoteShell: 'posix',
    },
    state,
    target: identity(SOURCE_HOME, 'acme-box'),
    serverId: state === 'attach' ? undefined : 'srv-1',
    expiresAt: Date.now() + 600_000,
    effects: {
      startsServer: state === 'ensure_required',
      serverLifetime: state === 'attach' ? 'existing' : 'until_explicit_stop',
      opensInbound: false,
      installsSoftware: false,
    },
  };
}

function remoteRecord(id, purposes) {
  return {
    id, label: purposes.includes('gui') ? 'ACME' : 'ACME (threads only)', endpoint: 'https://acme.test',
    target: identity(SOURCE_HOME, 'acme-box'), credentialRef: 'cred-1', enabled: true, backgroundSummary: false,
    purposes, state: 'online', lastConnectedAt: Date.now(), activeLeases: 0,
  };
}

/** Text assertions follow the locale the runner asked for; ids and counts do not. */
const LOCATION = { en: 'over the network', zh: '经网络' };
const RUNNING = { en: 'not running', zh: '还没有运行' };
const RUNNING_YES = { en: 'already running', zh: '已经在运行' };
const LIFETIME_NEW = { en: 'until it is stopped explicitly', zh: '直到被明确停止' };
const LIFETIME_KEPT = { en: 'keeps whatever lifetime it already has', zh: '保持它原有的存活方式' };
const WINDOW = { en: 'close this window', zh: '关掉本窗口' };

/** The locale the runner asked this job for, read from the document. */
async function locale(page) {
  return (await page.getAttribute('html', 'lang') ?? 'en').startsWith('zh') ? 'zh' : 'en';
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function deepLink(webUrl, fixtureUrl, path) {
  const joiner = path.includes('?') ? '&' : '?';
  return `${webUrl}${path}${joiner}server=${encodeURIComponent(fixtureUrl)}&token=${FIXTURE_TOKEN}`;
}

/** The source home's SSH plan surface, answered from this script's state. */
async function serveSshRemote(page, state) {
  await page.route('**/api/remote-connections/ssh/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api\/remote-connections\/ssh/, '');
    const body = request.method() === 'GET' ? undefined : request.postDataJSON();
    state.calls.push({ method: request.method(), path, body });
    const reply = (data) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ code: 0, msg: 'success', data, request_id: `fixture-${state.calls.length}` }),
    });
    if (request.method() === 'POST' && path === '/plan') return reply(plan(state.planState));
    if (request.method() === 'POST' && path === '/register') {
      const record = remoteRecord(REMOTE_ID, [body.purpose]);
      state.registered = record;
      return reply(record);
    }
    if (request.method() === 'POST' && /\/execute$/.test(path)) return reply(plan('ready'));
    return reply(null);
  });
  await page.route('**/api/remote-connections', async (route) => {
    const reply = (data) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ code: 0, msg: 'success', data, request_id: 'fixture' }),
    });
    if (route.request().method() !== 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, msg: 'success', data: null }) });
    return reply(state.records);
  });
}

async function boot({ page, webUrl, fixtureUrl }, state) {
  await page.context().addInitScript(spaceDesktopMock, { fixtureUrl, token: FIXTURE_TOKEN, spaces: SPACES, windowMode: 'switch' });
  await serveSshRemote(page, state);
  await page.goto(deepLink(webUrl, fixtureUrl, '/new'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-session-sidebar]', { timeout: 30_000 });
}

/**
 * The SSH way into a space: the plan the source home returns, read as the one
 * action being offered. The hosts come from the shared `native-ssh` scenario
 * (so the row is a real saved profile); the plan itself is this script's value.
 */
async function sshPlanScenario(context) {
  const { page, shot, state, errors, control } = context;
  await boot(context, state);
  await control({ action: 'scenario', name: 'native-ssh' });
  await page.goto(deepLink(context.webUrl, context.fixtureUrl, '/settings/ssh'), { waitUntil: 'domcontentloaded' });
  // The row is a disclosure: the action lives in the opened row.
  await page.click('[data-ssh-host-row="staging"] summary');
  await page.waitForSelector('[data-ssh-as-remote-space="staging"]', { state: 'visible', timeout: 30_000 });
  await page.click('[data-ssh-as-remote-space="staging"]');
  await page.waitForSelector('[data-remote-ssh-form]', { timeout: 20_000 });
  await page.waitForSelector('[data-remote-ssh-state]', { timeout: 20_000 });
  const said = await page.textContent('[data-remote-ssh-state]');
  expect(said?.includes(RUNNING[await locale(page)]) === true, `the plan that needs a server says so: ${said}`);
  const effects = await page.textContent('[data-remote-ssh-effects]');
  expect(effects?.includes(LIFETIME_NEW[await locale(page)]) === true, `the started server's lifetime is said: ${effects}`);
  expect(effects?.includes(WINDOW[await locale(page)]) === true, `closing the window is not stopping it: ${effects}`);
  await shot('remote-ssh-plan');
  expect(errors.length === 0, `page errors: ${errors.join(' | ')}`);
}

/** A Kiki already running there: attach, and nothing started. */
async function sshAttachScenario(context) {
  const { page, shot, state, errors, control } = context;
  state.planState = 'attach';
  await boot(context, state);
  await control({ action: 'scenario', name: 'native-ssh' });
  await page.goto(deepLink(context.webUrl, context.fixtureUrl, '/settings/ssh'), { waitUntil: 'domcontentloaded' });
  // The row is a disclosure: the action lives in the opened row.
  await page.click('[data-ssh-host-row="staging"] summary');
  await page.waitForSelector('[data-ssh-as-remote-space="staging"]', { state: 'visible', timeout: 30_000 });
  await page.click('[data-ssh-as-remote-space="staging"]');
  await page.waitForSelector('[data-remote-ssh-state]', { timeout: 20_000 });
  const said = await page.textContent('[data-remote-ssh-state]');
  expect(said?.includes(RUNNING_YES[await locale(page)]) === true, `an existing service attaches: ${said}`);
  const effects = await page.textContent('[data-remote-ssh-effects]');
  expect(effects?.includes(LIFETIME_KEPT[await locale(page)]) === true, `an attached service is not promised a lifetime: ${effects}`);
  await shot('remote-ssh-attach');
  expect(errors.length === 0, `page errors: ${errors.join(' | ')}`);
}

/** Where a bridged message came from, and what can be opened from it. */
async function bridgedOriginScenario(context) {
  const { page, shot, state, errors, control } = context;
  await boot(context, state);
  await control({ action: 'scenario', name: 'bridged-origin' });
  await page.goto(deepLink(context.webUrl, context.fixtureUrl, '/s/session_fixture_bridge_docs'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-bridged-origin]', { timeout: 30_000 });
  const line = await page.textContent('[data-bridged-origin-text]');
  expect(line?.includes('acme-box') === true, `the source host is named: ${line}`);
  expect(line?.includes(LOCATION[await locale(page)]) === true, `where the hop ran is said: ${line}`);
  await shot('remote-bridged-origin');
  expect(errors.length === 0, `page errors: ${errors.join(' | ')}`);
}

/**
 * The composer's target line: a message sent from inside a remote space says
 * which home delivers it. The remote side is reached by the switcher, so the
 * walk enters the space first and sends nothing.
 */
async function composerTargetScenario(context) {
  const { page, shot, state, errors, control } = context;
  await boot(context, state);
  await control({ action: 'scenario', name: 'bridged-origin' });
  await page.goto(deepLink(context.webUrl, context.fixtureUrl, '/s/session_fixture_bridge_docs'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-composer-card]', { timeout: 30_000 });
  // A local space says nothing about where a message goes.
  expect(await page.locator('[data-composer-remote-target]').count() === 0, 'a local space names no remote target');
  await shot('remote-composer-local');
  // Entering a remote space needs the real switch machinery (scope adapter,
  // credential-free reload handoff), so the remote side of this line is
  // covered by the component test, not by a walk that fakes the switch.
  expect(errors.length === 0, `page errors: ${errors.join(' | ')}`);
}

const scenarios = [
  {
    name: 'ssh-plan', fixture: 'native-ssh', matrix: ['width'],
    run: (context) => sshPlanScenario({ ...context, state: { planState: 'ensure_required', records: [], calls: [] } }),
  },
  {
    name: 'ssh-attach', fixture: 'native-ssh', matrix: ['width'],
    run: (context) => sshAttachScenario({ ...context, state: { planState: 'attach', records: [], calls: [] } }),
  },
  {
    name: 'composer-target', fixture: 'bridged-origin', matrix: ['width'],
    run: (context) => composerTargetScenario({ ...context, state: { planState: 'attach', records: [remoteRecord(REMOTE_ID, ['gui'])], calls: [] } }),
  },
  {
    name: 'bridged-origin', fixture: 'bridged-origin', matrix: ['width'],
    run: (context) => bridgedOriginScenario({ ...context, state: { planState: 'attach', records: [remoteRecord(REMOTE_ID, ['gui']), remoteRecord(BRIDGE_ONLY_ID, ['bridge'])], calls: [] } }),
  },
];

const { failed } = await runProof({ root: ROOT, scenarios, argv: process.argv.slice(2), label: 'remote-entry-proof' });
process.exitCode = failed.length > 0 ? 1 : 0;
