/**
 * Visual proof for the remote-Kiki surfaces (slice C): the space switcher's
 * remote group and the two lists on Settings → Spaces.
 *
 * The remote side is mocked at the browser level: the source home's
 * `/api/remote-connections*` API answers from this script's own state (records,
 * allow list, saved edits), so what is shown is the GUI against the typed
 * contract — not a live peer and not a claim about a real remote server. The
 * rest of the app (spaces, sessions, desktop shell) is the shared `spaces`
 * fixture through `space-desktop-mock.mjs`.
 *
 *   node scripts/visual-proof-remote-spaces.mjs [--only=remote-space-switcher]
 *
 * Asserted, not just captured: only a `gui`-purpose connection becomes a space;
 * an offline one keeps its last reading and says when it was taken; browsing
 * one is not offered for a thread-message-only connection; the inbound gate is
 * off by default and allows nobody on its own; an invitation is shown once and
 * gone after the dialog closes; a revoke reads back as revoked; the add form
 * keeps its drafts on refusal and clears the token after a save.
 * Output: KIKI_PROOF_OUTPUT_DIR (default .tmp/visual-proof/<run>), build under
 * KIKI_PROOF_DIST_DIR.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXTURE_TOKEN } from './fixture-server.mjs';
import { spaceDesktopMock } from './space-desktop-mock.mjs';
import { runProof } from '../proof/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SPACES = [
  { id: 'main', path: 'C:\\Users\\fixture\\.kiki' },
  { id: 'h-acme0000000000001', name: 'ACME confidential', color: '#0f766e', path: 'D:\\secure\\kiki-acme', hot: true, pending: 2, busy: 1 },
];

const HOME_B = '0f4c6e1a-2b7d-4a3e-9c11-7d0a51b2c301';
const ID_B = '9d5b4bd0-8f2b-4a1f-9f37-52c1b48a1a01';
const ID_HOME = '3a17c0de-6f45-4b90-8e21-0c9d7a5e4b02';
const ID_BRIDGE = 'c4e2f872-51aa-4d3b-8f60-2b7e19c3d503';
const ID_OFF = '7b1f5a36-9d24-4e58-b1c7-6f30a2e8b604';
const ID_APPROVAL = 'e8d3b204-7c69-4f11-a3d8-5e71b0c9f205';

const MINUTE = 60_000;
/** Text assertions follow the locale the runner asked for; ids and counts do not. */
const STALE = { en: 'as of', zh: '截至' };
const REMOVE_BODY = { en: 'does not shut that Kiki down', zh: '不会关掉对方的 Kiki' };
const GATE_BODY = { en: 'nobody on its own', zh: '并不放行任何人' };
const ONCE = { en: 'hown once', zh: '只显示一次' };
const NOT_SAVED = { en: 'not saved', zh: '不会保存' };
const REVOKE_BODY = { en: 'Other Kikis are unaffected', zh: '不影响其他 Kiki' };

/** The locale the runner asked this job for, read from the document. */
async function locale(page) {
  return (await page.getAttribute('html', 'lang') ?? 'en').startsWith('zh') ? 'zh' : 'en';
}
const now = Date.now();

function identity(homeId, hostId) {
  return { homeId, hostId, protocol: 1 };
}

/** The source home's connection records, as `RemoteConnection` really shapes them. */
function recordsFixture() {
  return [
    {
      // A long name on purpose: it must truncate instead of pushing the state out.
      id: ID_B, label: 'Workstation B — GPU server (office)', endpoint: 'https://b.example.test', target: identity(HOME_B, 'gpu-box'),
      credentialRef: ID_B, purposes: ['gui'], enabled: true, backgroundSummary: true, state: 'online',
      lastConnectedAt: now - 40_000, activeLeases: 1,
      summary: { value: { online: true, busy_sessions: 3, needs_you_sessions: 2, revision: 'r-42', as_of: now - 3_000 }, lastSeen: now - 3_000, stale: false },
    },
    {
      id: ID_HOME, label: 'Kiki at home', endpoint: 'https://home.example.test:8443', target: identity('b81c44a7-2f30-4d95-9e6a-3c17f2b8d406', 'home-desktop'),
      credentialRef: ID_HOME, purposes: ['gui'], enabled: true, backgroundSummary: true, state: 'offline',
      lastConnectedAt: now - 9 * MINUTE, activeLeases: 0,
      summary: { value: { online: true, busy_sessions: 1, needs_you_sessions: 0, revision: 'r-7', as_of: now - 9 * MINUTE }, lastSeen: now - 9 * MINUTE, stale: true },
    },
    {
      id: ID_APPROVAL, label: 'Colleague’s Kiki', endpoint: 'https://peer.example.test', target: identity('d2f7a0c5-8e41-4b73-a9c2-71e5d0b3f807', 'peer-laptop'),
      credentialRef: ID_APPROVAL, purposes: ['gui'], enabled: true, backgroundSummary: false, state: 'authentication_required',
      lastError: 'connection_not_approved', activeLeases: 0,
    },
    {
      id: ID_BRIDGE, label: 'Writer space link', endpoint: 'https://writer.example.test', target: identity('5c9e1f34-7a2b-4d80-b6f1-9e42c3a75d08', 'writer-box'),
      credentialRef: ID_BRIDGE, purposes: ['bridge'], enabled: true, backgroundSummary: false, state: 'offline', activeLeases: 0,
    },
    {
      id: ID_OFF, label: 'Old test box', endpoint: 'http://127.0.0.1:5599', target: identity('a1b2c3d4-5e6f-4a70-8b91-0c1d2e3f4050', 'test-box'),
      credentialRef: ID_OFF, purposes: ['gui'], enabled: false, backgroundSummary: false, state: 'disabled', activeLeases: 0,
    },
  ];
}

function inboundFixture() {
  return {
    enabled: false,
    configuredEnabled: false,
    identity: identity('77aa11bb-22cc-4dd3-8ee4-99ff00aa11bb', 'this-machine'),
    grants: [
      {
        id: 'ad10a1b2-c3d4-4e5f-8a91-b2c3d4e5f601', source: identity(HOME_B, 'gpu-box'),
        target: identity('77aa11bb-22cc-4dd3-8ee4-99ff00aa11bb', 'this-machine'), purpose: 'gui', revision: 1,
        status: 'approved', label: 'Workstation B', createdAt: now - 3 * 3600_000, lastConnectedAt: now - 20_000, activeLeases: 1,
      },
      {
        id: 'be20c3d4-e5f6-4a7b-9c8d-e5f6a7b8c902', source: identity('d2f7a0c5-8e41-4b73-a9c2-71e5d0b3f807', 'peer-laptop'),
        target: identity('77aa11bb-22cc-4dd3-8ee4-99ff00aa11bb', 'this-machine'), purpose: 'gui', revision: 1,
        status: 'invited', label: 'Colleague’s laptop', createdAt: now - 60_000, expiresAt: now + 8 * MINUTE, activeLeases: 0,
      },
      {
        id: 'cf31d4e5-f6a7-4b8c-9d0e-f6a7b8c9d013', source: identity('19e2b7c8-3a4d-4e5f-8a9b-0c1d2e3f4051', 'old-laptop'),
        target: identity('77aa11bb-22cc-4dd3-8ee4-99ff00aa11bb', 'this-machine'), purpose: 'gui', revision: 2,
        status: 'revoked', label: 'Retired laptop', createdAt: now - 5 * 3600_000, lastConnectedAt: now - 4 * 3600_000, activeLeases: 0,
      },
    ],
  };
}

/**
 * Answer the source home's connection API from `state` and record every write,
 * so a screenshot can be paired with what the form actually saved.
 */
async function serveConnections(page, state) {
  await page.route('**/api/remote-connections**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname.replace(/^\/api\/remote-connections/, '');
    const body = method === 'GET' || method === 'DELETE' ? undefined : request.postDataJSON();
    const reply = (data, code = 0, msg = 'success') =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code, msg, data, request_id: `fixture-${state.calls.length}` }) });
    state.calls.push({ method, path, body });
    if (method === 'GET' && path === '') return reply(state.records);
    if (method === 'GET' && path === '/handshake') {
      return reply({ identity: identity('11bb22cc-33dd-4ee5-8ff6-0011223344aa', 'this-machine'), serverId: 'srv-fixture', inboundEnabled: state.inbound.enabled });
    }
    if (method === 'GET' && path === '/inbound') return reply(state.inbound);
    if (method === 'PUT' && path === '/inbound') {
      state.inbound = { ...state.inbound, enabled: body.enabled, configuredEnabled: body.enabled };
      return reply(state.inbound);
    }
    if (method === 'POST' && path === '/inbound/invitations') {
      const grant = {
        id: 'ff42e5f6-a7b8-4c9d-8e0f-a7b8c9d0e114', source: body.source,
        target: identity('77aa11bb-22cc-4dd3-8ee4-99ff00aa11bb', 'this-machine'), purpose: 'gui', revision: 1,
        status: 'invited', label: body.label, createdAt: Date.now(), expiresAt: Date.now() + (body.expiresInMs ?? 600_000), activeLeases: 0,
      };
      state.inbound = { ...state.inbound, grants: [...state.inbound.grants, grant] };
      return reply({ grant, invitation: 'kiki-invitation-token-0000000000000000000000' });
    }
    if (method === 'POST' && /^\/inbound\/grants\/[^/]+\/revoke$/.test(path)) {
      const grantId = path.split('/')[3];
      state.inbound = {
        ...state.inbound,
        grants: state.inbound.grants.map((grant) => (grant.id === grantId ? { ...grant, status: 'revoked', revision: grant.revision + 1, activeLeases: 0 } : grant)),
      };
      return reply(state.inbound);
    }
    if (method === 'POST' && path === '') {
      const record = {
        id: 'aa63f7a8-b9c0-4d1e-9f20-b9c0d1e2f315', label: body.label, endpoint: body.endpoint, target: body.target,
        credentialRef: 'aa63f7a8-b9c0-4d1e-9f20-b9c0d1e2f315', purposes: ['gui'], enabled: true,
        backgroundSummary: body.backgroundSummary, state: 'online', lastConnectedAt: Date.now(), activeLeases: 0,
      };
      state.records = [...state.records, record];
      return reply(record);
    }
    if (method === 'DELETE') {
      state.records = state.records.filter((record) => record.id !== path.slice(1));
      return reply(null);
    }
    if (method === 'PUT' && /\/enabled$/.test(path)) {
      const id = path.split('/')[1];
      state.records = state.records.map((record) => (record.id === id ? { ...record, enabled: body.enabled, state: body.enabled ? 'offline' : 'disabled' } : record));
      return reply(state.records.find((record) => record.id === id));
    }
    if (method === 'POST' && /\/retry$/.test(path)) {
      const id = path.split('/')[1];
      state.records = state.records.map((record) => (record.id === id ? { ...record, state: 'online', lastConnectedAt: Date.now() } : record));
      return reply(state.records.find((record) => record.id === id));
    }
    return reply(null, 40404, `fixture: no connection route ${method} ${path}`);
  });
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function deepLink(webUrl, fixtureUrl, path) {
  const joiner = path.includes('?') ? '&' : '?';
  return `${webUrl}${path}${joiner}server=${encodeURIComponent(fixtureUrl)}&token=${FIXTURE_TOKEN}`;
}

async function boot({ page, webUrl, fixtureUrl }, state) {
  await page.context().addInitScript(spaceDesktopMock, { fixtureUrl, token: FIXTURE_TOKEN, spaces: SPACES, windowMode: 'switch' });
  await serveConnections(page, state);
  await page.goto(deepLink(webUrl, fixtureUrl, '/new'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-session-sidebar]', { timeout: 30_000 });
}

async function openSpaces({ page, webUrl, fixtureUrl }, selector) {
  await page.goto(deepLink(webUrl, fixtureUrl, '/settings/spaces'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(selector, { timeout: 30_000 });
  await page.waitForTimeout(300);
}

async function openSidebar(page, width) {
  if (width >= 768) return;
  await page.click('button[aria-label]:has(svg[data-icon="menu"])');
  await page.waitForTimeout(400);
}

/** The switcher's menu: which remote Kikis are spaces, and what they say. */
async function switcher(context) {
  const { page, view, shot, errors, state } = context;
  await boot(context, state);
  await openSidebar(page, view.width);
  await page.click('[data-space-switcher]');
  await page.waitForSelector('[data-space-switcher-menu]');
  await page.waitForTimeout(250);

  const rows = await page.$$('[data-space-remote-item]');
  expect(rows.length === 3, `only gui-purpose, switched-on connections become spaces; saw ${rows.length}`);
  expect(await page.locator(`[data-space-remote-item="${ID_BRIDGE}"]`).count() === 0, 'a thread-message-only connection must not be offered as a space');
  expect(await page.locator(`[data-space-remote-item="${ID_OFF}"]`).count() === 0, 'a switched-off connection must not be offered as a space');
  expect(await page.getAttribute(`[data-space-remote-item="${ID_B}"]`, 'data-space-remote-state') === 'online', 'B should read online');
  expect((await page.textContent(`[data-space-remote-item="${ID_B}"] [data-space-remote-busy]`))?.includes('3') === true, 'B busy count');
  expect((await page.textContent(`[data-space-remote-item="${ID_B}"] [data-space-remote-needs]`))?.includes('2') === true, 'B needs-you count');
  expect(await page.locator(`[data-space-remote-item="${ID_HOME}"][data-space-remote-stale]`).count() === 1, 'an offline space keeps a stale reading');
  const lang = await locale(page);
  expect((await page.textContent(`[data-space-remote-item="${ID_HOME}"]`))?.includes(STALE[lang]) === true, 'a stale reading says when it was taken');
  expect(await page.getAttribute(`[data-space-remote-item="${ID_APPROVAL}"]`, 'data-space-remote-state') === 'authentication_required', 'approval state reads back');
  // A long name loses width first: the state chip and the counts stay whole and
  // inside the row instead of being pushed out by the name or the address.
  const narrow = await page.evaluate((id) => {
    const row = document.querySelector(`[data-space-remote-item="${id}"]`);
    if (row === null) return null;
    const box = row.getBoundingClientRect();
    const name = row.querySelector('span.truncate');
    const chip = row.querySelector('[data-remote-state]');
    const chipBox = chip?.getBoundingClientRect() ?? null;
    return {
      overflow: row.scrollWidth <= row.clientWidth + 1,
      nameWidth: name?.clientWidth ?? null,
      nameClipped: name === null ? null : name.scrollWidth > name.clientWidth,
      chipWidth: chipBox?.width ?? null,
      chipInside: chipBox === null ? null : chipBox.left >= box.left && chipBox.right <= box.right,
      countsInside: [...row.querySelectorAll('[data-space-remote-busy], [data-space-remote-needs]')]
        .every((node) => { const box2 = node.getBoundingClientRect(); return box2.left >= box.left - 1 && box2.right <= box.right + 1; }),
    };
  }, ID_B);
  expect(narrow !== null && narrow.overflow === true, `the row must not overflow: ${JSON.stringify(narrow)}`);
  expect(narrow?.chipInside === true && (narrow?.chipWidth ?? 0) > 20, `the state stays whole inside the row: ${JSON.stringify(narrow)}`);
  expect((narrow?.nameWidth ?? 0) >= 60, `the name keeps a readable width: ${JSON.stringify(narrow)}`);
  expect(narrow?.nameClipped === true, `a long name truncates rather than pushing the status out: ${JSON.stringify(narrow)}`);
  expect(narrow?.countsInside === true, `the counts stay inside the row: ${JSON.stringify(narrow)}`);
  await shot('remote-switcher-menu');

  const menu = await page.evaluate(() => {
    const box = document.querySelector('[data-space-switcher-menu]')?.getBoundingClientRect();
    return box === null || box === undefined ? null : { left: box.left, right: box.right, bottom: box.bottom, width: window.innerWidth, height: window.innerHeight };
  });
  expect(menu !== null && menu.left >= 0 && menu.right <= menu.width && menu.bottom <= menu.height, `menu leaves the viewport: ${JSON.stringify(menu)}`);
  expect(errors.length === 0, `page errors: ${errors.join(' | ')}`);
}

/** Settings → Spaces: the outbound list, the add form, and what it saves. */
async function outbound(context) {
  const { page, shot, state, errors } = context;
  await boot(context, state);
  await openSpaces(context, '[data-remote-connections]');
  await page.waitForSelector(`[data-remote-connection="${ID_B}"]`);
  expect(await page.locator('[data-remote-connection]').count() === 5, 'every registered connection is listed for management');
  expect(await page.locator(`[data-remote-connection="${ID_BRIDGE}"] [data-remote-bridge-only]`).count() === 1, 'a thread-message-only connection says so');
  expect(await page.locator(`[data-remote-connection="${ID_BRIDGE}"] [data-remote-enter]`).count() === 0, 'a thread-message-only connection offers no way in');
  expect(await page.locator(`[data-remote-connection="${ID_B}"] [data-remote-enter]`).count() === 1, 'a browsable connection offers the switch');
  expect(await page.locator(`[data-remote-connection="${ID_HOME}"][data-remote-stale]`).count() === 1, 'the stale reading is marked in the list too');
  expect(await page.locator('[data-remote-self-identity] [data-copy-field]').count() === 1, 'this Kiki’s identity is offered for copying');
  const source = await page.textContent('[data-remote-source]');
  expect(source?.includes('https://b.example.test') === false, `the source line names the local control home: ${source}`);
  await page.locator('[data-remote-connections]').scrollIntoViewIfNeeded();
  await shot('remote-outbound-list');

  // The add form: a pasted invitation carries the real target identity.
  await page.click('[data-remote-add]');
  await page.waitForSelector('[data-remote-add-form]');
  const invitation = JSON.stringify({
    kiki: 'kiki.connection-invitation/1', invitation: 'kiki-invitation-token-0000000000000000000000',
    target: identity(HOME_B, 'gpu-box'), label: 'Home laptop',
  });
  await page.fill('[data-remote-invitation]', invitation);
  await page.waitForSelector('[data-remote-target]');
  const target = await page.textContent('[data-remote-target]');
  expect(target?.includes('0f4c6e1a') === true && target?.includes('host') === true, `the real target fingerprint shows: ${target}`);
  expect(target?.includes('Home laptop') === true, 'the name the other Kiki uses is shown, not retyped');
  // A bare code cannot name the target, and the form says so instead of guessing.
  await page.fill('[data-remote-invitation]', 'kiki-invitation-token-0000000000000000000000');
  await page.waitForSelector('[data-remote-invitation-problem]');
  await page.fill('[data-remote-invitation]', invitation);
  await page.fill('[data-remote-label]', 'Renderer box');
  await page.fill('[data-remote-endpoint]', 'http://192.168.1.40:5523');
  await page.fill('#remote-connection-token', 'owner-token-fixture-value');
  // Leaving the field is what asks the question: the address rule is said where
  // the address is typed, and the save stays blocked until it holds.
  await page.locator('[data-remote-endpoint]').press('Tab');
  await page.waitForTimeout(150);
  const tls = await page.textContent('[data-remote-add-form]');
  expect(tls?.includes('https://') === true, `the TLS rule is said in place: ${tls}`);
  expect(await page.isDisabled('[data-remote-add-submit]') === true, 'an address the server would refuse cannot be saved');
  expect(state.calls.filter((call) => call.method === 'POST' && call.path === '').length === 0, 'nothing is sent while the address is refused');
  await shot('remote-add-invalid');
  await page.fill('[data-remote-endpoint]', 'https://b2.example.test');
  await page.click('[data-remote-add-submit]');
  await page.waitForSelector('[data-remote-add-form]', { state: 'detached' });
  await page.waitForSelector('[data-remote-connection="aa63f7a8-b9c0-4d1e-9f20-b9c0d1e2f315"]');
  const saved = state.calls.filter((call) => call.method === 'POST' && call.path === '');
  expect(saved.length === 1, `exactly one save: ${JSON.stringify(saved)}`);
  expect(saved[0].body.target.homeId === HOME_B && saved[0].body.invitation.includes('kiki-invitation-token'), 'the typed target and invitation are what got saved');
  expect(saved[0].body.ownerToken === 'owner-token-fixture-value', 'the owner token is sent to the local owner API');
  await page.locator('[data-remote-connections]').scrollIntoViewIfNeeded();
  await shot('remote-outbound-saved');

  // Remove asks first, and says the remote Kiki keeps running.
  const lang = await locale(page);
  await page.click(`[data-remote-menu="${ID_HOME}"]`);
  await page.waitForSelector('[data-space-row-menu]');
  await page.click('[data-space-menu-item="remove"]');
  await page.waitForSelector('[data-confirm-action="confirm"]');
  const confirm = await page.textContent('[role="alertdialog"]');
  expect(confirm?.includes(REMOVE_BODY[lang]) === true, `the confirmation names the real consequence: ${confirm}`);
  await shot('remote-remove-confirm');
  // Escape leaves the connection alone, exactly like the cancel button.
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role="alertdialog"]', { state: 'detached' });
  expect(state.calls.some((call) => call.method === 'DELETE') === false, 'cancelling must not remove anything');
  expect(await page.locator(`[data-remote-connection="${ID_HOME}"]`).count() === 1, 'the cancelled row is still there');
  expect(errors.length === 0, `page errors: ${errors.join(' | ')}`);
}

/** Settings → Spaces: the inbound gate, the allow list and one invitation. */
async function inbound(context) {
  const { page, shot, state, errors } = context;
  await boot(context, state);
  await openSpaces(context, '[data-inbound-connections]');
  await page.waitForSelector('[data-inbound-list]');
  expect(await page.isChecked('#inbound-connections-enabled') === false, 'the inbound gate starts off');
  expect(await page.isDisabled('[data-inbound-invite]') === true, 'no invitation can be created while the gate is off');
  expect(await page.locator('[data-inbound-grant]').count() === 3, 'the allow list reads back all lines');
  expect(await page.getAttribute('[data-inbound-grant="be20c3d4-e5f6-4a7b-9c8d-e5f6a7b8c902"]', 'data-inbound-status') === 'invited', 'an invited line reads invited');
  expect(await page.locator('[data-inbound-status-chip="revoked"]').count() === 1, 'a revoked line stays visible as revoked');
  await page.locator('[data-inbound-connections]').scrollIntoViewIfNeeded();
  await shot('remote-inbound-off');

  // Opening the gate allows nobody on its own.
  await page.click('[data-inbound-gate] label');
  await page.waitForSelector('[data-inbound-invite]:not([disabled])');
  expect(await page.locator('[data-inbound-grant]').count() === 3, 'opening the gate must not add or remove allow-list lines');
  expect((await page.textContent('[data-inbound-connections]'))?.includes(GATE_BODY[await locale(page)]) === true, 'the gate says what it does and does not do');

  // One invitation, shown once.
  await page.click('[data-inbound-invite]');
  await page.waitForSelector('[data-inbound-invite-form]');
  await page.fill('[data-inbound-source]', JSON.stringify({
    kiki: 'kiki.identity/1', identity: identity('d2f7a0c5-8e41-4b73-a9c2-71e5d0b3f807', 'peer-laptop'), label: 'Peer laptop',
  }));
  await page.waitForSelector('[data-inbound-source-target]');
  await page.fill('[data-inbound-name]', 'Peer laptop');
  await page.click('[data-inbound-invite-submit]');
  await page.waitForSelector('[data-inbound-invitation]');
  const block = await page.textContent('[data-inbound-invitation]');
  expect(block?.includes('0f4c6e1a') === false && block?.includes('77aa11bb') === true, `the invitation carries the real target identity: ${block}`);
  expect(block?.includes('Peer laptop') === true, 'the invitation names the Kiki it is for');
  // The once-only fact lives in the hint beside the copy box, not repeated in
  // the dialog body (F-RS-01), and it must still say it is not saved.
  const hint = await page.textContent('[data-copy-field="inbound-invitation"]');
  expect(hint?.includes(ONCE[await locale(page)]) === true, `the invitation says it is shown once: ${hint}`);
  expect(hint?.includes(NOT_SAVED[await locale(page)]) === true, `and that it is not saved: ${hint}`);
  const body = await page.textContent('[data-inbound-invite-body]');
  expect(body?.includes(ONCE[await locale(page)]) === false, `the body no longer repeats it: ${body}`);
  await shot('remote-inbound-invitation');
  await page.click('[data-inbound-invite-done]');
  await page.waitForSelector('[data-inbound-invitation]', { state: 'detached' });
  expect(await page.locator('[data-inbound-invitation]').count() === 0, 'the invitation must not persist in the interface');
  await page.waitForSelector('[data-inbound-grant="ff42e5f6-a7b8-4c9d-8e0f-a7b8c9d0e114"]');
  expect(await page.locator('[data-inbound-grant]').count() === 4, 'the new line reads back');

  // Revoking is confirmed and reads back as revoked.
  await page.click('[data-inbound-revoke="ad10a1b2-c3d4-4e5f-8a91-b2c3d4e5f601"]');
  await page.waitForSelector('[data-confirm-action="confirm"]');
  const revokeText = await page.textContent('[role="alertdialog"]');
  expect(revokeText?.includes(REVOKE_BODY[await locale(page)]) === true, `the revoke confirmation is scoped: ${revokeText}`);
  await page.click('[data-confirm-action="confirm"]');
  await page.waitForSelector('[data-inbound-grant="ad10a1b2-c3d4-4e5f-8a91-b2c3d4e5f601"][data-inbound-status="revoked"]');
  await page.locator('[data-inbound-connections]').scrollIntoViewIfNeeded();
  await shot('remote-inbound-revoked');
  expect(state.calls.some((call) => call.path === '/inbound' && call.method === 'PUT' && call.body.enabled === true), 'the gate change was saved through the typed API');
  expect(errors.length === 0, `page errors: ${errors.join(' | ')}`);
}

/** The runtime that cannot accept peers: said out loud, not shown as open. */
async function devRuntime(context) {
  const { page, shot, state, errors } = context;
  state.inbound = { ...state.inbound, enabled: false, configuredEnabled: true, unavailableReason: 'dangerous_auth_bypass' };
  await boot(context, state);
  await openSpaces(context, '[data-inbound-connections]');
  await page.waitForSelector('[data-inbound-dev-runtime]');
  expect(await page.isChecked('#inbound-connections-enabled') === false, 'a saved-on setting must not read as open');
  expect(await page.isDisabled('#inbound-connections-enabled') === true, 'this runtime cannot be switched on');
  expect(await page.locator('[data-inbound-grant]').count() === 3, 'the allow list is kept as it is');
  expect(await page.locator('[data-inbound-invite]').isDisabled() === true, 'no invitation while the runtime cannot accept peers');
  await page.locator('[data-inbound-connections]').scrollIntoViewIfNeeded();
  await shot('remote-inbound-dev-runtime');
  expect(errors.length === 0, `page errors: ${errors.join(' | ')}`);
}

const scenarios = [
  {
    name: 'remote-space-switcher', fixture: 'spaces', matrix: ['width'],
    run: (context) => switcher({ ...context, state: { records: recordsFixture(), inbound: inboundFixture(), calls: [] } }),
  },
  {
    name: 'remote-outbound', fixture: 'spaces', matrix: ['width'],
    run: (context) => outbound({ ...context, state: { records: recordsFixture(), inbound: inboundFixture(), calls: [] } }),
  },
  {
    name: 'remote-inbound', fixture: 'spaces', matrix: ['width'],
    run: (context) => inbound({ ...context, state: { records: recordsFixture(), inbound: inboundFixture(), calls: [] } }),
  },
  {
    name: 'remote-inbound-dev-runtime', fixture: 'spaces', matrix: ['width'],
    run: (context) => devRuntime({ ...context, state: { records: recordsFixture(), inbound: inboundFixture(), calls: [] } }),
  },
];

const { failed } = await runProof({ root: ROOT, scenarios, argv: process.argv.slice(2), label: 'remote-spaces-proof' });
process.exitCode = failed.length > 0 ? 1 : 0;
