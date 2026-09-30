/**
 * Real-backend check for the room GUI: against a running kap-server
 * (`--server`, token read from `$KIKI_HOME/server.token`), seed three
 * personas, enable one Bot, create a three-member room, then drive the GUI:
 * send from the room composer, see the message land in the real log, pause
 * and continue, and refuse / allow roster changes. Screenshots land in
 * .tmp/bot-real/<stamp>/.
 *
 *   KIKI_HOME=<isolated home> node scripts/real-proof-bot.mjs --server=http://127.0.0.1:59411 [--bot=lin-lan]
 *
 * Without a model provider in that home a woken member cannot answer; the
 * script records what the server logged after the send (a Bot reply or a
 * `wake_failed` line) and reports it rather than failing on it.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = process.argv.find((arg) => arg.startsWith('--server='))?.slice('--server='.length) ?? 'http://127.0.0.1:58627';
const home = process.env.KIKI_HOME;
if (home === undefined) throw new Error('Set KIKI_HOME to the server\'s isolated home');
const token = (await readFile(join(home, 'server.token'), 'utf8')).trim();
const output = join(root, '.tmp', 'bot-real', String(Date.now()));
await mkdir(output, { recursive: true });
const notes = [];
const errors = [];

async function api(path, init = {}) {
  const response = await fetch(`${server}/api${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const envelope = await response.json();
  if (envelope.code !== 0) throw new Error(`${init.method ?? 'GET'} ${path}: ${envelope.code} ${envelope.msg}`);
  return envelope.data;
}

const PERSONAS = [
  { id: 'lin-lan', name: '林岚', title: '发布协调', job: '负责发布节奏。', description: '你是林岚，负责发布协调。' },
  { id: 'a-che', name: '阿澈', title: '写作', job: '起草 changelog。', description: '你是阿澈，负责写作。' },
  { id: 'xiao-lan', name: '小蓝', title: '调研', job: '查资料、核对事实。', description: '你是小蓝，负责调研。' },
];
for (const definition of PERSONAS) {
  const existing = await api(`/personas/${definition.id}`).catch(() => undefined);
  if (existing === undefined) await api(`/personas/${definition.id}`, { method: 'PUT', body: { definition } });
}
const botId = process.argv.find((arg) => arg.startsWith('--bot='))?.slice('--bot='.length) ?? 'lin-lan';
const bot = await api(`/bots/${botId}/enable`, { method: 'POST' });
notes.push(`bot enabled: ${bot.personaId} home=${bot.homeSessionId}`);
const workspace = resolve(root, '.tmp', 'real-room-workspace');
await mkdir(workspace, { recursive: true });
// A fresh room per run: the proof covers member sessions created by the
// running server, not ones left cold by an earlier run.
const room = await api('/rooms', {
  method: 'POST',
  body: { name: `真实房间验证 ${new Date().toISOString().slice(11, 19)}`, workspace, host: 'lin-lan', members: PERSONAS.map((persona) => ({ personaId: persona.id })) },
});
notes.push(`room ${room.id} members=${room.members.map((member) => `${member.personaId}:${member.sessionId}`).join(',')}`);

process.env.KIKI_SERVER_URL = server;
const vite = await createServer({ root, server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/*.test.ts', '**/*.test.tsx'] } } });
await vite.listen();
const web = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ args: ['--no-proxy-server'] });
const url = (path) => `${web}${path}?server=${encodeURIComponent(server)}&token=${encodeURIComponent(token)}`;

async function shot(page, name) {
  await page.waitForTimeout(400);
  const file = join(output, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`[shot] ${file}`);
}

const logText = async () => (await api(`/rooms/${room.id}/log`)).entries;

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => { errors.push(`page: ${error.message}`); });
  await page.addInitScript(() => { localStorage.setItem('kiki.locale', 'zh'); });
  await page.goto(url(`/rooms/${room.id}`), { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector('[data-room-input]', { timeout: 60_000 });
  await page.waitForSelector('[data-sidebar-room]', { timeout: 30_000 }).catch(() => { errors.push('sidebar room row missing'); });
  await shot(page, 'real-room-open');

  // 1. Send from the GUI; the real log must carry it.
  // A mention needs whitespace (or ASCII punctuation) before the `@`.
  const text = `GUI 实测 ${new Date().toISOString().slice(11, 19)} @阿澈 回一句「收到」。`;
  await page.locator('[data-room-input]').fill(text);
  await page.locator('[data-room-input]').press('Enter');
  await page.waitForFunction((needle) => [...document.querySelectorAll('[data-room-from="user"]')].some((node) => node.textContent?.includes(needle)), text.slice(0, 12), { timeout: 20_000 });
  const afterSend = await logText();
  const sent = afterSend.find((entry) => entry.kind === 'message' && entry.from === 'user' && entry.text === text);
  if (sent === undefined) errors.push('sent message not in the server log');
  else notes.push(`server logged the GUI message ${sent.id}; mentions=${JSON.stringify(sent.mentions)}; idempotencyKey=${sent.idempotencyKey !== undefined}`);
  await shot(page, 'real-room-sent');

  // 2. What happened next: a member reply, or wake_failed without a model.
  let outcome = 'nothing within 60s';
  let replier;
  for (let waited = 0; waited < 60_000; waited += 2000) {
    const entries = await logText();
    const index = entries.findIndex((entry) => entry.id === sent?.id);
    const later = entries.slice(index + 1);
    const reply = later.find((entry) => entry.kind === 'message' && entry.from !== 'user');
    const failed = later.find((entry) => entry.kind === 'system' && entry.event === 'wake_failed');
    if (reply !== undefined) { outcome = `member reply from ${reply.from}: ${reply.text.slice(0, 60)}`; replier = reply.from; break; }
    if (failed !== undefined) { outcome = `wake_failed: ${String(failed.data?.reason ?? failed.text).slice(0, 160)}`; break; }
    await page.waitForTimeout(2000);
  }
  notes.push(`after send: ${outcome}`);
  if (replier !== undefined) {
    await page.waitForFunction((from) => document.querySelector(`[data-room-from="${from}"]`) !== null, replier, { timeout: 15_000 })
      .then(() => notes.push(`GUI rendered the ${replier} reply in the room`))
      .catch(() => { errors.push(`room reply from ${replier} not rendered`); });
  } else {
    errors.push(`no member reply: ${outcome}`);
  }
  await shot(page, 'real-room-after-wake');

  // 2b. The replier's member session in message view: the delivered
  // SendMessage shows as a sent message row.
  if (replier !== undefined) {
    const member = room.members.find((item) => item.personaId === replier);
    const memberPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    memberPage.on('pageerror', (error) => { errors.push(`member page: ${error.message}`); });
    await memberPage.addInitScript(() => { localStorage.setItem('kiki.locale', 'zh'); });
    await memberPage.goto(url(`/s/${member.sessionId}`), { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await memberPage.waitForSelector('[data-message-view-row="message"] [data-message-status="sent"]', { timeout: 30_000 })
      .then(() => notes.push(`member session ${member.sessionId} shows a sent SendMessage row`))
      .catch(() => { errors.push('member session: no sent message row'); });
    await shot(memberPage, 'real-member-message-view');
    await memberPage.close();
  }

  // 3. Pause → system line → continue from the header.
  await page.locator('[data-room-pause]').click();
  await page.waitForSelector('[data-room-continue]', { timeout: 10_000 });
  await page.waitForSelector('[data-room-system="paused"]', { timeout: 10_000 });
  await shot(page, 'real-room-paused');
  await page.locator('[data-room-system-continue]').click();
  await page.waitForSelector('[data-room-pause]', { timeout: 10_000 });
  await page.waitForSelector('[data-room-system="continued"]', { timeout: 10_000 });
  notes.push('pause / continue round-tripped through the real server');

  // 4. Members rail: set host (allowed any time), mute toggle.
  if ((await page.locator('[data-room-members]').count()) === 0) await page.locator('[data-room-roster]').click();
  await page.locator('[data-room-member="a-che"] [data-room-set-host]').click();
  await page.waitForFunction(() => document.querySelector('[data-room-host-line]')?.textContent?.includes('阿澈'), null, { timeout: 10_000 });
  const hosted = await api(`/rooms/${room.id}`);
  notes.push(`host now ${hosted.host}`);
  await page.locator('[data-room-member="lin-lan"] [data-room-set-host]').click();
  await page.waitForTimeout(800);
  await shot(page, 'real-room-members');

  // 5. The Bot's home session in message view: a composer send comes back
  // as a delivered (sent) message.
  const home = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  home.on('pageerror', (error) => { errors.push(`bot home: ${error.message}`); });
  await home.addInitScript(() => { localStorage.setItem('kiki.locale', 'zh'); });
  await home.goto(url(`/s/${bot.homeSessionId}`), { waitUntil: 'domcontentloaded', timeout: 120_000 });
  const composer = home.locator('textarea[data-composer]');
  await composer.waitFor({ timeout: 60_000 });
  const before = await home.locator('[data-message-status="sent"]').count();
  await composer.fill(`Bot 实测 ${new Date().toISOString().slice(11, 19)}，回一句。`);
  await composer.press('Enter');
  await home.waitForFunction((count) => document.querySelectorAll('[data-message-status="sent"]').length > count, before, { timeout: 60_000 })
    .then(() => notes.push(`bot home ${bot.homeSessionId} shows a new sent message`))
    .catch(() => { errors.push('bot home: no new sent message'); });
  await shot(home, 'real-bot-home-message-view');
  await home.close();
} catch (error) {
  errors.push(error instanceof Error ? error.message.split('\n')[0] : String(error));
} finally {
  await browser.close();
  await vite.close();
}
console.log(notes.map((note) => `[note] ${note}`).join('\n'));
console.log(`[proof] ${output}`);
if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
}
