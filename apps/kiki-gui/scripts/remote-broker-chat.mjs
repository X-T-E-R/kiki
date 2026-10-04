import { randomUUID } from 'node:crypto';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { tsImport } from 'tsx/esm/api';

import { brokerDesktopMock } from './broker-desktop-mock.mjs';

const { applyContentSegment, rebindTurnContentRefs } = await tsImport('../../../packages/transcript/src/index.ts', import.meta.url);
const execFile = promisify(execFileCallback);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const guiRoot = resolve(scriptDir, '..');
const repoRoot = resolve(guiRoot, '../..');
const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const runRoot = join(guiRoot, '.tmp', `remote-broker-${runId}`);
const homeA = join(runRoot, 'A');
const homeB = join(runRoot, 'B');
const childProcesses = [];
const stepEvidence = new Map();
const brokerMetrics = [];
let activeStep = 'setup';
let cleanupStarted = false;
let interrupted = false;
let exitCode = 0;
let restoreFetch = () => {};
let localA;
let controlA;
let controlB;
let remoteB;
let viteServer;
let browser;

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const asBytes = (value) => Buffer.byteLength(value, 'utf8');
const endpoint = (port) => `http://127.0.0.1:${port}`;
const tailLines = (value, limit = 40) => value.split(/\r?\n/u).filter(Boolean).slice(-limit);

function record(step, text) {
  stepEvidence.set(step, text);
  console.log(`[remote-broker-chat] step ${step}: ${text}`);
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolveListen);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : undefined;
  await new Promise((resolveClose, reject) => server.close((error) => error === undefined ? resolveClose() : reject(error)));
  if (port === undefined) throw new Error('free-port allocation returned no port');
  return port;
}

function spawnTracked(name, command, args, env) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env, NO_PROXY: '*', no_proxy: '*' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const output = { stdout: [], stderr: [] };
  const entry = { name, child, output, spawnError: undefined };
  child.stdout?.on('data', (chunk) => { output.stdout.push(...tailLines(String(chunk), 12)); output.stdout.splice(0, Math.max(0, output.stdout.length - 80)); });
  child.stderr?.on('data', (chunk) => { output.stderr.push(...tailLines(String(chunk), 12)); output.stderr.splice(0, Math.max(0, output.stderr.length - 80)); });
  child.on('error', (error) => { entry.spawnError = error; output.stderr.push(`${error.name}: ${error.message}`); });
  childProcesses.push(entry);
  return child;
}

async function stopTracked(entry) {
  const { child } = entry;
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid !== undefined) {
    await execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
  } else {
    child.kill('SIGTERM');
  }
  await Promise.race([once(child, 'exit').catch(() => {}), sleep(5000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function cleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  restoreFetch();
  if (browser !== undefined) await browser.close().catch(() => {});
  if (viteServer !== undefined) await viteServer.close().catch(() => {});
  for (const entry of childProcesses.toReversed()) await stopTracked(entry);
  // A walk that stopped short keeps its run directory: the screenshot and the
  // two homes' logs are the evidence for whatever it reached.
  if (exitCode === 0 && process.env.REMOTE_BROKER_KEEP_EVIDENCE !== '1') await rm(runRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  else console.error(`[remote-broker-chat] run directory kept for inspection: ${runRoot}`);
}

async function handleSignal(signal) {
  if (interrupted) return;
  interrupted = true;
  exitCode = 130;
  await cleanup();
  process.exit(exitCode);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => { void handleSignal(signal); });

async function waitForStub(port, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const entry = childProcesses.find((candidate) => candidate.child === child);
    if (entry?.spawnError !== undefined) throw new Error(`stub model spawn failed: ${entry.spawnError.message}`);
    if (child.exitCode !== null) throw new Error(`stub model exited before readiness: ${child.exitCode}`);
    try {
      const response = await fetch(`${endpoint(port)}/v1/models`);
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`stub model did not become ready on ${port}`);
}

async function waitForKap(name, home, port, child) {
  const deadline = Date.now() + 120_000;
  const ownerPath = join(home, 'server.local-owner');
  while (Date.now() < deadline) {
    const entry = childProcesses.find((candidate) => candidate.child === child);
    if (entry?.spawnError !== undefined) throw new Error(`${name} spawn failed: ${entry.spawnError.message}`);
    if (child.exitCode !== null) {
      throw new Error(`${name} exited before readiness: ${child.exitCode}; stderr=${entry?.output.stderr.join(' ').slice(-1000) ?? ''}`);
    }
    const owner = await readFile(ownerPath, 'utf8').then((value) => value.trim()).catch(() => '');
    if (owner !== '') {
      try {
        const response = await fetch(`${endpoint(port)}/api/meta`, { headers: { authorization: `Bearer ${owner}` } });
        const envelope = await response.json();
        if (response.ok && envelope.code === 0) return { owner, meta: envelope.data };
      } catch {}
    }
    await sleep(250);
  }
  const entry = childProcesses.find((candidate) => candidate.child === child);
  throw new Error(`${name} did not become ready on ${port}; stderr=${entry?.output.stderr.join(' ').slice(-1000) ?? ''}`);
}

function installBrokerMetrics() {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const requestUrl = input instanceof Request ? input.url : String(input);
    const isBrokerCall = /\/api\/remote-connections\/[0-9a-f-]{36}\/call$/u.test(new URL(requestUrl).pathname);
    let requestBody;
    if (isBrokerCall) {
      const raw = init.body ?? (input instanceof Request ? input.body : undefined);
      if (typeof raw === 'string') requestBody = raw;
    }
    const response = await nativeFetch(input, init);
    if (isBrokerCall) {
      const body = requestBody === undefined ? undefined : JSON.parse(requestBody);
      const responseBytes = await response.clone().arrayBuffer().then((bytes) => bytes.byteLength).catch(() => 0);
      brokerMetrics.push({
        step: activeStep,
        operation: body?.operation ?? 'unknown',
        requestBytes: requestBody === undefined ? 0 : asBytes(requestBody),
        responseBytes,
      });
    }
    return response;
  };
  restoreFetch = () => { globalThis.fetch = nativeFetch; restoreFetch = () => {}; };
}

function metricsFor(step) {
  return brokerMetrics.filter((entry) => entry.step === step);
}

function metricSummary(step) {
  const entries = metricsFor(step);
  return `${entries.length} broker calls, request=${entries.reduce((sum, entry) => sum + entry.requestBytes, 0)}B, response=${entries.reduce((sum, entry) => sum + entry.responseBytes, 0)}B`;
}

async function errorDetails(operation) {
  try {
    await operation();
    return { ok: true, code: undefined, message: undefined };
  } catch (error) {
    return { ok: false, code: error?.code, message: error instanceof Error ? error.message : String(error) };
  }
}

async function pollSnapshot(client, sessionId, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  let reads = 0;
  while (Date.now() < deadline) {
    last = await client.sessionView(sessionId).snapshot();
    reads += 1;
    if (predicate(last)) return { snapshot: last, reads };
    if (reads >= 3 && last.session?.busy === false && last.session?.last_turn_reason === 'failed') {
      let transcript = 'unavailable';
      try { transcript = JSON.stringify(await client.sessionView(sessionId).transcript.page({ agentId: 'main', pageSize: 100 })).slice(0, 4000); } catch (error) { transcript = `error:${error instanceof Error ? error.message : String(error)}`; }
      throw new Error(`session ${sessionId} failed its turn; messages=${JSON.stringify(last.messages).slice(0, 2000)}; transcript=${transcript}`);
    }
    await sleep(180);
  }
  throw new Error(`timed out waiting for session ${sessionId}; reads=${reads}; last=${JSON.stringify(last)?.slice(0, 500)}`);
}

async function pollStubReply(client, sessionId, promptId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let reads = 0;
  let snapshot;
  let transcript;
  while (Date.now() < deadline) {
    const view = client.sessionView(sessionId);
    snapshot = await view.snapshot();
    transcript = await view.transcript.page({ agentId: 'main', pageSize: 100 });
    reads += 1;
    let turn = transcript.items.find((item) => item.kind === 'turn' && item.promptId === promptId);
    if (turn !== undefined && !['queued', 'running'].includes(turn.state)) {
      let contentReads = 0;
      const hydrate = async (entity) => {
        while (entity.contentRefs?.length > 0) {
          assertCondition(contentReads < 20, `content continuation exceeded its bounded budget for ${promptId}`);
          const segment = await view.transcript.content({ agentId: 'main', ref: entity.contentRefs[0] });
          entity = applyContentSegment(entity, segment);
          if (entity.kind === 'turn') entity = rebindTurnContentRefs(entity);
          contentReads += 1;
        }
        return entity;
      };
      turn = await hydrate(turn);
      for (const step of turn.steps) {
        for (let index = 0; index < step.frames.length; index += 1) step.frames[index] = await hydrate(step.frames[index]);
      }
      const reply = turn.steps.flatMap((step) => step.frames)
        .filter((frame) => frame.kind === 'text' && frame.role === 'assistant').map((frame) => frame.text).join('\n');
      if (reply !== '') return { snapshot, transcript, reply, reads, contentReads, turnId: turn.turnId, promptId };
      if (turn.state === 'failed') throw new Error(`prompt ${promptId} failed: ${turn.error ?? 'no readable assistant reply'}`);
    }
    await sleep(180);
  }
  throw new Error(`timed out waiting for stub reply for prompt ${promptId} in ${sessionId}; reads=${reads}; transcript=${JSON.stringify(transcript)?.slice(0, 1600)}`);
}

async function pollMarker(client, sessionId, marker, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let reads = 0;
  let snapshot;
  let transcript;
  while (Date.now() < deadline) {
    snapshot = await client.sessionView(sessionId).snapshot();
    transcript = await client.sessionView(sessionId).transcript.page({ agentId: 'main', pageSize: 100 });
    reads += 1;
    if (`${JSON.stringify(snapshot)}${JSON.stringify(transcript)}`.includes(marker)) return { snapshot, transcript, reads };
    await sleep(180);
  }
  throw new Error(`timed out waiting for ${marker} in ${sessionId}; reads=${reads}`);
}

/**
 * The browser half: this window is A, the space switcher offers B because A
 * really registered it, entering B re-scopes the window onto A's broker, a
 * message typed there is delivered to B and answered by B's configured stub,
 * and the return trip puts the window back on A's own home.
 *
 * Nothing here is mocked about B: the remote Kiki is the second real
 * kap-server, and every read below goes through A's broker to it. What the
 * browser needs from the desktop is only the shell (see broker-desktop-mock).
 */
async function attemptGui({ connectionId, aSessionId, bSessionId, aUrl, aOwner, bTitle, bHomeLabel }) {
  let page;
  const pageErrors = [];
  const consoleErrors = [];
  const evidence = [];
  const traffic = [];
  const sockets = [];
  const pending = new Map();
  const responseReads = [];
  const started = Date.now();
  const stamp = () => Date.now() - started;
  const describe = (request) => {
    const path = new URL(request.url()).pathname;
    const body = request.postDataJSON?.();
    return { method: request.method(), path, operation: body?.operation, params: body?.params };
  };
  const frameSummary = (payload) => {
    try {
      const frame = JSON.parse(String(payload));
      const data = frame.data;
      return { type: frame.type, id: frame.id, sessionId: frame.sessionId, scope: frame.scope,
        service: frame.service, event: frame.event, code: frame.code, msg: frame.msg,
        data: frame.type === 'auth' ? undefined : { type: data?.type, generation: data?.generation,
          status: data?.status, detail: data?.detail, event: data?.event?.type, agentId: data?.event?.agent_id,
          grade: data?.event?.grade, cursor: data?.event?.cursor, input: data?.input } };
    } catch { return { malformed: String(payload).slice(0, 160) }; }
  };
  try {
    const { createServer } = await import('vite');
    const { chromium } = await import('playwright');
    // The app's vite config owns the port (KIKI_GUI_PORT, default 5177), so
    // the walk takes a free port for itself rather than racing whatever else
    // is on the default one.
    const port = await freePort();
    const previousPort = process.env.KIKI_GUI_PORT;
    process.env.KIKI_GUI_PORT = String(port);
    // A private cache dir: another walk's stale module graph must not decide
    // whether this one can boot, and this run's cache is its own to discard.
    viteServer = await createServer({ root: guiRoot, logLevel: 'silent', cacheDir: join(runRoot, 'vite-cache'),
      server: { watch: null, hmr: false } });
    await viteServer.listen();
    const address = viteServer.httpServer?.address();
    const boundPort = typeof address === 'object' && address !== null ? address.port : undefined;
    if (boundPort !== port) throw new Error(`vite bound ${String(boundPort)} instead of ${port}`);
    // Vite reports listening before it can serve; a cold dev start under load
    // takes a while, and the first navigation must not race it.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const probe = await fetch(`http://127.0.0.1:${port}/index.html`);
        if (probe.ok) break;
      } catch { await sleep(300); }
      if (attempt === 99) throw new Error(`vite on ${port} never served a page`);
    }
    // A cold dev server compiles the whole graph on the first module request,
    // which is longer than the navigation budget. Warming the entry the page
    // will ask for means the first `goto` is a cache read, not a compile.
    await fetch(`http://127.0.0.1:${port}/src/main.tsx`).catch(() => undefined);
    if (previousPort === undefined) delete process.env.KIKI_GUI_PORT;
    else process.env.KIKI_GUI_PORT = previousPort;
    browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(brokerDesktopMock, { aUrl, aOwner, homeName: 'A' });
    await context.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(...args) {
          super(...args);
          this.addEventListener('close', (event) => {
            console.info('[remote-broker-ws-close]', JSON.stringify({ path: new URL(this.url).pathname,
              code: event.code, reason: event.reason, wasClean: event.wasClean }));
          });
        }
      };
    });
    page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
      if (message.text().startsWith('[remote-broker-ws-close] ')) {
        sockets.push({ at: stamp(), browserClose: JSON.parse(message.text().slice('[remote-broker-ws-close] '.length)) });
      }
    });
    page.on('request', (request) => {
      if (!new URL(request.url()).pathname.startsWith('/api/')) return;
      pending.set(request, { at: stamp(), ...describe(request) });
    });
    page.on('requestfailed', (request) => {
      const entry = pending.get(request);
      if (entry === undefined) return;
      pending.delete(request);
      traffic.push({ ...entry, settledAt: stamp(), failure: request.failure()?.errorText });
    });
    page.on('response', (response) => {
      const request = response.request();
      const entry = pending.get(request);
      if (entry === undefined) return;
      pending.delete(request);
      const read = response.json().catch(() => null).then((body) => {
        const result = { ...entry, settledAt: stamp(), status: response.status(), code: body?.code, msg: body?.msg };
        traffic.push(result);
        if (response.status() >= 400 || (body?.code !== undefined && body.code !== 0)) evidence.push(`business response=${JSON.stringify(result)}`);
      });
      responseReads.push(read);
    });
    page.on('websocket', (socket) => {
      const path = new URL(socket.url()).pathname;
      socket.on('framesent', ({ payload }) => sockets.push({ at: stamp(), path, direction: 'sent', ...frameSummary(payload) }));
      socket.on('framereceived', ({ payload }) => sockets.push({ at: stamp(), path, direction: 'received', ...frameSummary(payload) }));
      socket.on('socketerror', (error) => sockets.push({ at: stamp(), path, error }));
      socket.on('close', () => sockets.push({ at: stamp(), path, closed: true }));
    });
    const url = `http://127.0.0.1:${port}/new?server=${encodeURIComponent(aUrl)}&token=${encodeURIComponent(aOwner)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForSelector('[data-session-sidebar]', { timeout: 60_000 });
    const aRow = page.locator(`[data-session-row="${aSessionId}"]`).first();
    await aRow.waitFor({ state: 'visible', timeout: 30_000 });
    await aRow.click();
    await page.waitForURL((url) => url.pathname === `/s/${aSessionId}`, { timeout: 60_000 });
    await page.waitForSelector('[data-transcript-scroll]', { state: 'visible', timeout: 60_000 });
    assertCondition(await page.locator(`[data-session-row="${bSessionId}"]`).count() === 0, 'local A lists B before the switch');
    evidence.push(`opened local A session=${aSessionId}`);

    // The remote Kiki is offered as a space because A registered it, and only
    // because it is a browsing-purpose connection.
    await page.locator('[data-space-switcher]').click();
    const remoteRow = page.locator(`[data-space-remote-item="${connectionId}"]`);
    await remoteRow.waitFor({ state: 'visible', timeout: 30_000 });
    const rowText = (await remoteRow.innerText()).replace(/\s+/gu, ' ').trim();
    assertCondition(rowText.includes(bHomeLabel), `the remote row is the remote Kiki, not something else: ${rowText}`);
    evidence.push(`remote row: ${rowText}`);
    // The remote Kiki as this window's control home reports it: the record the
    // prepare path reads before it commits to anything.
    const listed = await page.evaluate(async ({ id, aUrl, aOwner }) => {
      const response = await fetch(`${aUrl}/api/remote-connections`, { headers: { authorization: `Bearer ${aOwner}` } });
      const body = await response.json();
      const record = (body.data ?? []).find((entry) => entry.id === id);
      return { status: response.status, record: record === undefined ? null
        : { id: record.id, enabled: record.enabled, state: record.state, purposes: record.purposes, protocol: record.target?.protocol } };
    }, { id: connectionId, aUrl, aOwner });
    evidence.push(`listed=${JSON.stringify(listed)}`);
    // The prepare path's own first call: the remote client's own /meta, which
    // must answer with B's home through A's broker.
    const brokerMeta = await page.evaluate(async ({ id, aUrl, aOwner }) => {
      const started = performance.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        const response = await fetch(`${aUrl}/api/remote-connections/${id}/call`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${aOwner}` },
          body: JSON.stringify({ operation: 'meta' }),
          signal: controller.signal,
        });
        const body = await response.json();
        return { ms: Math.round(performance.now() - started), status: response.status, home: body.data?.server_home_id ?? null, raw: JSON.stringify(body).slice(0, 200) };
      } catch (error) { return { ms: Math.round(performance.now() - started), error: String(error) }; }
      finally { clearTimeout(timer); }
    }, { id: connectionId, aUrl, aOwner });
    evidence.push(`brokerMeta=${JSON.stringify(brokerMeta)}`);
    // The switcher closes its menu and asks the boundary to enter the scope.
    // Whether the window actually moved is the thing under test, so it is
    // observed rather than assumed, and the walk reports what it reached.
    await remoteRow.scrollIntoViewIfNeeded();
    await remoteRow.click({ timeout: 15_000 });
    await sleep(3_000);
    // A window holding an unsent draft asks before it is replaced, exactly as
    // it would for a person; the walk answers the way the reader would.
    await page.evaluate(() => { (window).__nav = []; const push = (t) => (window).__nav.push(t);
      setTimeout(push, 0);
      window.addEventListener('beforeunload', () => push('beforeunload'));
      window.addEventListener('pagehide', () => push('pagehide'));
    });
    evidence.push(`urlBefore=${page.url()} after click: menuOpen=${await page.locator('[data-space-switcher-menu]').isVisible().catch(() => false)} switcherRemote=${await page.locator('[data-space-switcher]').getAttribute('data-space-remote').catch(() => null)} handoff=${await page.evaluate(() => sessionStorage.getItem('kiki.navScopeHandoff.v1')?.slice(0, 160) ?? 'none')}`);

    // The reload re-selects the remote scope from the credential-free handoff;
    // the composer then names the space it delivers to.
    // The verify is a real brokered round trip to B, so it is given room.
    await page.waitForSelector('[data-space-remote]', { timeout: 90_000 });
    // The line reads the local home's connection list, so give that query a
    // moment rather than sampling the first paint.
    let targetLine = '';
    for (let attempt = 0; attempt < 30 && targetLine.trim() === ''; attempt += 1) {
      targetLine = (await page.textContent('[data-composer-remote-target]').catch(() => null)) ?? '';
      if (targetLine.trim() !== '') break;
      await sleep(400);
    }
    if (targetLine.trim() === '') {
      const refused = await page.evaluate(async (id) => {
        const token = sessionStorage.getItem('kiki.connection') ?? localStorage.getItem('kiki.connection');
        void token;
        const response = await fetch(`/api/remote-connections/${id}/call`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ operation: 'GET /api/meta' }),
        });
        return `${response.status} ${(await response.text()).slice(0, 400)}`;
      }, connectionId);
      throw new Error(`inside the remote space the composer named no target; a direct broker call says: ${refused}; observed: ${evidence.join(' ~ ')}`);
    }
    evidence.push(`composer target: ${targetLine.trim()}`);

    // B's session, opened from the remote space's own list. The list is
    // virtualized, so the row is scrolled into view and clicked where it
    // actually is, not where the DOM says it should be.
    const bRow = page.locator(`[data-session-row="${bSessionId}"]`).first();
    for (let attempt = 0; attempt < 20 && await bRow.count() === 0; attempt += 1) await sleep(500);
    const rowCount = await page.locator('[data-session-row]').count();
    await bRow.waitFor({ state: 'attached', timeout: 30_000 });
    await bRow.scrollIntoViewIfNeeded();
    const where = await bRow.boundingBox();
    evidence.push(`B row: listed=${rowCount} box=${JSON.stringify(where)}`);
    if (where === null) throw new Error(`the remote space lists ${rowCount} sessions; B's row is not on screen`);
    await page.mouse.click(where.x + Math.min(where.width, 160) / 2, where.y + where.height / 2);
    // /new already has a composer. The route, not that shared element, proves
    // the row selected B before any prompt can be submitted.
    await page.waitForURL((url) => url.pathname === `/s/${bSessionId}`, { timeout: 60_000 });
    await page.waitForSelector('textarea[data-composer]', { timeout: 60_000 });
    await page.waitForSelector('[data-transcript-scroll]', { state: 'visible', timeout: 60_000 });
    // The session title as the window shows it, or the state it is actually
    // in — either is readable evidence of where the click landed.
    await page.waitForTimeout(3_000);
    const landed = await page.evaluate(() => ({
      url: location.pathname,
      heading: (document.querySelector('h1, [data-session-title]')?.textContent ?? '').slice(0, 80),
      hasComposer: document.querySelector('textarea[data-composer]') !== null,
    }));
    evidence.push(`landed=${JSON.stringify(landed)}`);
    const guiMarker = `GUI-broker-prompt-${runId}`;
    // Typed, not assigned: the composer keeps its own state, so a direct value
    // assignment would leave the send control with nothing to send.
    await page.click('textarea[data-composer]');
    await page.keyboard.type(guiMarker, { delay: 10 });
    // The send control is pressed, not the shortcut: the first-send focus
    // handling is another owner's seam, and this walk is about where the
    // message goes, not about which key sends it.
    const sendButton = page.locator('button[data-send-ready]').first();
    await sendButton.waitFor({ state: 'visible', timeout: 20_000 });
    // The send gate is the app's own: if it says the composer cannot send, that
    // is a fact about this session, not a walk step to force past.
    const gate = await page.evaluate(() => {
      const button = document.querySelector('button[data-send-ready]');
      const area = document.querySelector('textarea[data-composer]');
      return { ready: button?.hasAttribute('data-send-ready') ?? false, disabled: button?.disabled ?? null,
        value: area?.value ?? '', label: button?.getAttribute('aria-label') ?? '' };
    });
    evidence.push(`send gate=${JSON.stringify(gate)}`);
    // A bounded diagnosis of the send, not a step to get past: every request
    // the click causes, what came back, what the window did next, and whether
    // the draft cleared. Nothing here is asserted green or bad — it is read.
    const observed = { requests: [], responses: [], console: [], sockets: 0 };
    const watched = /session|prompt|message|resume|agent|turn|submit|remote-connections/i;
    page.on('request', (request) => {
      if (!watched.test(request.url())) return;
      observed.requests.push(`${request.method()} ${new URL(request.url()).pathname}${request.url().includes('/call') ? ' ' + (request.postData() ?? '').slice(0, 90) : ''}`);
    });
    page.on('response', (response) => {
      if (!watched.test(response.url())) return;
      observed.responses.push(`${response.status()} ${new URL(response.url()).pathname}`);
    });
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') observed.console.push(`${message.type()}: ${message.text().slice(0, 160)}`);
    });
    page.on('websocket', () => { observed.sockets += 1; });
    // A send that navigates away would destroy the page mid-read, so the
    // navigation is recorded as it happens rather than inferred afterwards.
    const navigations = [];
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url().slice(0, 120)); });
    observed.beforeUrl = page.url();
    await sendButton.click();
    // Long enough for one submit round trip and a broker hop, and short enough
    // that a silent failure is visible rather than inferred.
    for (let tick = 0; tick < 12; tick += 1) await sleep(500);
    evidence.push(`send navigations: from=${observed.beforeUrl} to=${JSON.stringify(navigations.slice(-3))}`);
    // The read is best-effort: if the window is gone, that is the finding.
    observed.afterUrl = page.url();
    const after = await page.evaluate(() => ({
      value: document.querySelector('textarea[data-composer]')?.value ?? '',
      hasMarkerInBody: document.body.innerText.includes('GUI-broker-prompt'),
      // A refused send says so where the reader can see it.
      alerts: [...document.querySelectorAll('[role="alert"], [role="status"], [data-attachment-error], [data-composer-error]')].map((n) => (n.textContent ?? '').trim().slice(0, 120)).filter(Boolean),
      disabled: document.querySelector('button[data-send-ready]')?.hasAttribute('data-send-ready') ?? null,
    })).catch((error) => ({ readFailed: String(error).slice(0, 120), url: page.url() }));
    evidence.push(`send diagnosis: draftAfter=${JSON.stringify(after.value)} markerInBody=${after.hasMarkerInBody} sendReady=${after.disabled} alerts=${JSON.stringify(after.alerts)}`);
    evidence.push(`send requests: ${JSON.stringify(observed.requests.slice(-8))}`);
    evidence.push(`send responses: ${JSON.stringify(observed.responses.slice(-8))}`);
    evidence.push(`send console: ${JSON.stringify(observed.console.slice(-4))} sockets=${observed.sockets}`);
    assertCondition(new URL(page.url()).pathname === `/s/${bSessionId}`, 'send changed the selected B session');
    // The Node half already produced the same stub text. Only assistant prose
    // belonging to this GUI prompt's turn proves a new reply reached the screen.
    const replyHandle = await page.waitForFunction((marker) => {
      const user = [...document.querySelectorAll('[data-block-id][data-turn-id]')].find((row) => row.textContent?.includes(marker));
      const turnId = user?.getAttribute('data-turn-id');
      if (turnId === undefined || turnId === null) return false;
      const reply = [...document.querySelectorAll('[data-block-id][data-turn-id]')]
        .filter((row) => row.getAttribute('data-turn-id') === turnId)
        .flatMap((row) => [...row.querySelectorAll('[data-assistant-prose]')])
        .find((row) => row.textContent?.includes('已发出') || row.textContent?.includes('本地 stub 模型'));
      return reply instanceof HTMLElement && reply.getBoundingClientRect().height > 0
        ? { turnId, text: reply.innerText } : false;
    }, guiMarker, { timeout: 60_000 });
    const reply = await replyHandle.jsonValue();
    evidence.push(`sent ${guiMarker}; current-turn assistant=${JSON.stringify(reply)} (session=${bSessionId})`);
    await page.screenshot({ path: join(runRoot, 'gui-remote-broker-chat.png'), fullPage: false });
    evidence.push(`screenshot: gui-remote-broker-chat.png (url=${page.url()})`);
    // A screenshot of the return surface, so a click that finds nothing is
    // readable rather than only a timeout.
    await page.screenshot({ path: join(runRoot, 'gui-before-return.png'), fullPage: false });

    // Back to this window's own home: the local list is A's again.
    const switcher = page.locator('button[data-space-remote]').first();
    await switcher.waitFor({ state: 'attached', timeout: 20_000 });
    const box = await switcher.boundingBox();
    evidence.push(`switcher box=${JSON.stringify(box)} remote=${await switcher.getAttribute('data-space-remote').catch(() => null)}`);
    await switcher.click({ force: true, timeout: 20_000 });
    const backRow = page.locator('[data-space-switcher-menu] [data-space-back-local]').first();
    await backRow.waitFor({ state: 'visible', timeout: 20_000 });
    // Leaving the remote space is a scope switch back to the home this window
    // really belongs to, carried by the same reload handoff — so the click
    // destroys the page it was made on, and the return is read from the window
    // that comes back.
    await Promise.all([
      page.waitForNavigation({ timeout: 60_000 }).catch(() => undefined),
      backRow.click({ timeout: 30_000, force: true }),
    ]);
    await page.waitForSelector('[data-space-switcher]:not([data-space-remote])', { timeout: 60_000 });
    const backLine = (await page.textContent('[data-composer-remote-target]').catch(() => null)) ?? '';
    assertCondition(backLine.trim() === '', `the local home still names a remote target: ${backLine}`);
    const readCurrentVisit = () => page.evaluate(() => {
      const history = JSON.parse(sessionStorage.getItem('kiki.navHistory.v1') ?? '{}');
      const current = history.entries?.[history.currentIndex];
      return { scope: current?.scope, route: current === undefined ? undefined : `${current.pathname}${current.search}${current.hash}`,
        historyScopes: (history.entries ?? []).map((entry) => entry.scope.scopeId) };
    });
    const backHome = await readCurrentVisit();
    assertCondition(backHome.scope?.homeId === 'main' && backHome.scope.scopeId === 'local',
      `the current return scope is not A's local home: ${JSON.stringify(backHome)}`);
    const returnedARow = page.locator(`[data-session-row="${aSessionId}"]`).first();
    await returnedARow.waitFor({ state: 'visible', timeout: 30_000 });
    assertCondition(await page.locator(`[data-session-row="${bSessionId}"]`).count() === 0, 'returned A list still contains B');
    await returnedARow.click();
    await page.waitForURL((url) => url.pathname === `/s/${aSessionId}`, { timeout: 60_000 });
    await page.waitForSelector('textarea[data-composer]', { timeout: 60_000 });
    await page.waitForSelector('[data-transcript-scroll]', { state: 'visible', timeout: 60_000 });
    assertCondition(await page.locator('[data-composer-remote-target]').count() === 0, 'A session composer retains the B target');
    const returnedVisit = await readCurrentVisit();
    assertCondition(returnedVisit.scope?.homeId === 'main' && returnedVisit.scope.scopeId === 'local' && returnedVisit.route === `/s/${aSessionId}`,
      `the final A route and current scope disagree: ${JSON.stringify(returnedVisit)}`);
    await page.screenshot({ path: join(runRoot, 'gui-returned-local.png'), fullPage: false });
    evidence.push(`returned to local A session=${aSessionId}; A list excludes B; composer has no remote target; currentVisit=${JSON.stringify(returnedVisit)}`);
    assertCondition(pageErrors.length === 0, `page errors: ${pageErrors.join(' | ')}`);
    return `GUI walk succeeded: ${evidence.join('; ')}; consoleErrors=${consoleErrors.length}`;
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    await page?.screenshot({ path: join(runRoot, 'gui-failure.png'), fullPage: false }).catch(() => {});
    await writeFile(join(runRoot, 'gui-failure.txt'), await page?.locator('body').innerText().catch(() => '') ?? '', 'utf8');
    evidence.push(`pending=${JSON.stringify([...pending.values()])}; diagnostics=gui-diagnostics.json; screenshot=gui-failure.png`);
    return `GUI walk stopped after: ${detail}; reached: ${evidence.join('; ') || 'nothing'}; pageErrors=${pageErrors.join(' | ')}; consoleErrors=${consoleErrors.slice(0, 6).join(' | ')}`;
  } finally {
    await Promise.allSettled(responseReads);
    await writeFile(join(runRoot, 'gui-diagnostics.json'), JSON.stringify({ evidence, traffic, sockets, pending: [...pending.values()], pageErrors, consoleErrors }, null, 2), 'utf8');
    await page?.close().catch(() => {});
    if (browser !== undefined) { await browser.close().catch(() => {}); browser = undefined; }
    if (viteServer !== undefined) { await viteServer.close().catch(() => {}); viteServer = undefined; }
  }
}

async function main() {
  await mkdir(homeA, { recursive: true });
  await mkdir(homeB, { recursive: true });
  const [portA, portB, stubPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const config = [
    'default_model = "stub"',
    '',
    '[providers.stub]',
    'type = "openai"',
    `base_url = "http://127.0.0.1:${stubPort}/v1"`,
    'api_key = "stub"',
    '',
    '[models.stub]',
    'provider = "stub"',
    'model = "stub"',
    'max_context_size = 100000',
    'capabilities = ["thinking"]',
    '',
  ].join('\n');
  await Promise.all([
    writeFile(join(homeA, 'config.toml'), config, 'utf8'),
    writeFile(join(homeB, 'config.toml'), config, 'utf8'),
  ]);

  const node = process.execPath;
  const stub = spawnTracked('stub-model', node, [join(guiRoot, 'scripts', 'stub-model-server.mjs'), `--port=${stubPort}`], {});
  await waitForStub(stubPort, stub);
  const serverModule = pathToFileURL(join(repoRoot, 'packages', 'kap-server', 'src', 'start.ts')).href;
  const serverCode = `
    const { startServer } = await import(${JSON.stringify(serverModule)});
    const port = Number(process.env.KIKI_HARNESS_PORT);
    const running = await startServer({
      host: '127.0.0.1',
      port,
      homeDir: process.env.KIKI_HOME,
      hostIdentity: { productName: 'remote-broker-harness', version: '0.0.0-harness', platform: process.platform },
      logLevel: process.env.KIKI_HARNESS_LOG_LEVEL ?? 'silent',
    });
    process.stdout.write('[remote-broker-harness] ready\\n');
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await running.close();
      process.exit(0);
    };
    process.once('SIGINT', () => { void close(); });
    process.once('SIGTERM', () => { void close(); });
    await new Promise(() => {});
  `;
  const serverArgs = ['--import', 'tsx/esm', '--import', './build/register-raw-text-loader.mjs', '-e', serverCode];
  const serverEnv = (home, port) => ({ KIKI_HOME: home, KIKI_HARNESS_PORT: String(port), KIKI_HARNESS_LOG_LEVEL: process.env.REMOTE_BROKER_LOG_LEVEL ?? 'silent' });
  const serverA = spawnTracked('kap-server-A', node, serverArgs, serverEnv(homeA, portA));
  const serverB = spawnTracked('kap-server-B', node, serverArgs, serverEnv(homeB, portB));
  const [readyA, readyB] = await Promise.all([
    waitForKap('kap-server A', homeA, portA, serverA),
    waitForKap('kap-server B', homeB, portB, serverB),
  ]);
  assertCondition(readyA.meta?.dangerous_bypass_auth === false, 'A unexpectedly reports dangerous auth bypass');
  assertCondition(readyB.meta?.dangerous_bypass_auth === false, 'B unexpectedly reports dangerous auth bypass');

  const { createKlient } = await tsImport('../../../packages/klient/src/transports/http/index.ts', import.meta.url);
  const guiClient = await tsImport('../src/lib/client.ts', import.meta.url);
  controlA = createKlient({ endpoint: endpoint(portA), token: readyA.owner });
  controlB = createKlient({ endpoint: endpoint(portB), token: readyB.owner });

  await controlB.rest.connections.setInbound(true);
  const handshakeA = await controlA.rest.connections.handshake();
  const invitation = await controlB.rest.connections.invite({ source: handshakeA.identity, label: 'A' });
  const bHandshake = await controlB.rest.connections.handshake();
  const serverTokenB = (await readFile(join(homeB, 'server.token'), 'utf8')).trim();
  const connection = await controlA.rest.connections.add({
    label: 'B',
    endpoint: endpoint(portB),
    target: bHandshake.identity,
    ownerToken: serverTokenB,
    invitation: invitation.invitation,
    backgroundSummary: false,
  });
  assertCondition(connection.target.homeId === readyB.meta.server_home_id, 'registration target identity is not B');

  installBrokerMetrics();
  localA = new guiClient.KikiClient({ baseUrl: endpoint(portA), token: readyA.owner, timeoutMs: 30_000 });
  remoteB = guiClient.createRemoteSpaceClient({ endpoint: endpoint(portA), token: readyA.owner, connectionId: connection.id, timeoutMs: 30_000 });

  activeStep = 1;
  const remoteMeta = await remoteB.meta();
  const aHomeId = handshakeA.identity.homeId;
  const bHomeId = bHandshake.identity.homeId;
  assertCondition(remoteMeta.server_home_id === bHomeId, `broker meta returned ${remoteMeta.server_home_id}, expected B ${bHomeId}`);
  assertCondition(remoteMeta.server_home_id !== aHomeId, 'broker meta returned A home id');
  record(1, `meta.server_home_id=${remoteMeta.server_home_id} (B=${bHomeId}, A=${aHomeId}); connection=${connection.id}; ${metricSummary(1)}`);

  activeStep = 2;
  const bTitle = `B-broker-session-${runId}`;
  const aTitle = `A-local-session-${runId}`;
  const bSession = await remoteB.createSession({ title: bTitle, agent_config: { model: 'stub' } });
  const aSession = await localA.createSession({ title: aTitle, agent_config: { model: 'stub' } });
  assertCondition(typeof bSession.id === 'string' && bSession.id !== '' && typeof aSession.id === 'string' && aSession.id !== '', 'session ids are empty');
  assertCondition(bSession.id !== aSession.id, `unexpected identical session ids: ${bSession.id}`);
  const bView = await remoteB.sessionView(bSession.id).snapshot();
  const aView = await localA.sessionView(aSession.id).snapshot();
  assertCondition(bView.session.title === bTitle, `B snapshot title mismatch: ${bView.session.title}`);
  assertCondition(aView.session.title === aTitle, `A snapshot title mismatch: ${aView.session.title}`);
  const aMissing = await errorDetails(() => localA.sessionView(bSession.id).snapshot());
  const bMissing = await errorDetails(() => remoteB.sessionView(aSession.id).snapshot());
  assertCondition(!aMissing.ok && !bMissing.ok, `cross-home snapshots unexpectedly succeeded: A=${JSON.stringify(aMissing)} B=${JSON.stringify(bMissing)}`);
  record(2, `B session=${bSession.id} title=${bTitle}; A session=${aSession.id} title=${aTitle}; wrong-home snapshot errors A=${aMissing.code ?? 'unknown'} B=${bMissing.code ?? 'unknown'}; ${metricSummary(2)}`);

  activeStep = 3;
  const brokerModels = await remoteB.listModels();
  const stubModel = brokerModels.items.find((model) => model.id === 'stub');
  assertCondition(stubModel !== undefined, `B broker model list did not expose configured stub; ids=${brokerModels.items.map((model) => model.id).join(',')}`);
  const bPromptMarker = `B-broker-prompt-${runId}`;
  const submitted = await remoteB.submitPrompt(bSession.id, { content: [{ type: 'text', text: bPromptMarker }] });
  const first = await pollStubReply(remoteB, bSession.id, submitted.prompt_id, 30_000);
  const replyText = first.reply;
  assertCondition(replyText.includes('已发出') || replyText.includes('本地 stub 模型'), `unexpected assistant text from the configured stub: ${replyText}`);
  const firstSerialized = `${JSON.stringify(first.snapshot)}${JSON.stringify(first.transcript)}`;
  assertCondition(firstSerialized.includes(bPromptMarker), 'brokered transcript omitted the user prompt');
  const firstSnapshotBytes = asBytes(JSON.stringify(first.snapshot));
  record(3, `prompt=${submitted.prompt_id} turn=${first.turnId} marker=${bPromptMarker}; assistant reply=${JSON.stringify(replyText.slice(0, 120))}; contentReads=${first.contentReads}; secondSubmission=none; snapshotBytes=${firstSnapshotBytes}; transcriptBytes=${asBytes(JSON.stringify(first.transcript))}; polls=${first.reads}; ${metricSummary(3)}`);

  activeStep = 4;
  const abortMarker = `B-abort-prompt-${runId}`;
  const abortSubmitted = await remoteB.submitPrompt(bSession.id, { content: [{ type: 'text', text: abortMarker }] });
  await remoteB.klient.session(bSession.id).agent('main').cancel();
  const stopped = await pollSnapshot(remoteB, bSession.id, (snapshot) => snapshot.session.busy === false && snapshot.in_flight_turn === null, 30_000);
  const cancelState = stopped.snapshot.session.last_turn_reason === 'cancelled'
    ? 'cancelled=true via brokered agentLoopService.cancelFromUser'
    : stopped.snapshot.session.last_turn_reason === 'completed'
      ? 'cancel-late: turn ended before brokered cancel took effect'
      : `cancel result did not report cancellation: last_turn_reason=${stopped.snapshot.session.last_turn_reason ?? 'none'}`;
  record(4, `second prompt=${abortSubmitted.prompt_id} marker=${abortMarker}; ${cancelState}; stopped=${stopped.snapshot.session.busy === false}; polls=${stopped.reads}; ${metricSummary(4)}`);

  activeStep = 5;
  const aPromptMarker = `A-local-prompt-${runId}`;
  const localSubmitted = await localA.submitPrompt(aSession.id, { content: [{ type: 'text', text: aPromptMarker }] });
  const localReady = await pollMarker(localA, aSession.id, aPromptMarker, 30_000);
  const remoteRead = await remoteB.sessionView(bSession.id).snapshot();
  const localRead = localReady.snapshot;
  const bTranscript = await remoteB.sessionView(bSession.id).transcript.page({ agentId: 'main', pageSize: 100 });
  const aTranscript = localReady.transcript;
  const aList = await localA.listSessions();
  const bList = await remoteB.listSessions();
  const aJson = `${JSON.stringify(localRead)}${JSON.stringify(aTranscript)}`;
  const bJson = `${JSON.stringify(remoteRead)}${JSON.stringify(bTranscript)}`;
  const aTranscriptJson = JSON.stringify(aTranscript);
  const bTranscriptJson = JSON.stringify(bTranscript);
  assertCondition(!aList.items.some((session) => session.id === bSession.id), 'A session list contains B session id');
  assertCondition(!bList.items.some((session) => session.id === aSession.id), 'B session list contains A session id');
  assertCondition(aJson.includes(aTitle) && aJson.includes(aPromptMarker) && !aJson.includes(bTitle) && !aJson.includes(bPromptMarker), 'A snapshot crossed home data');
  assertCondition(bJson.includes(bTitle) && bJson.includes(bPromptMarker) && !bJson.includes(aTitle) && !bJson.includes(aPromptMarker), 'B snapshot crossed home data');
  assertCondition(aTranscriptJson.includes(aPromptMarker) && !aTranscriptJson.includes(bPromptMarker), 'A transcript crossed home data');
  assertCondition(bTranscriptJson.includes(bPromptMarker) && !bTranscriptJson.includes(aPromptMarker), 'B transcript crossed home data');
  record(5, `A list=${aList.items.length} (contains B=${aList.items.some((session) => session.id === bSession.id)}); B list=${bList.items.length} (contains A=${bList.items.some((session) => session.id === aSession.id)}); transcriptBytes A=${asBytes(aTranscriptJson)} B=${asBytes(bTranscriptJson)}; localPrompt=${localSubmitted.prompt_id}; ${metricSummary(5)}`);

  const guiResult = await attemptGui({ connectionId: connection.id, aSessionId: aSession.id, bSessionId: bSession.id, aUrl: endpoint(portA), aOwner: readyA.owner, bTitle, bHomeLabel: connection.label });
  record('gui', guiResult);
  // A walk that stopped short is a failure, and its screenshots are the
  // evidence for where it stopped.
  if (!guiResult.startsWith('GUI walk succeeded')) exitCode = 1;
}

try {
  await main();
} catch (error) {
  exitCode = 1;
  const message = error instanceof Error ? error.message : String(error);
  record(activeStep === 'setup' ? 'setup' : activeStep, `FAILED: ${message}`);
  console.error(`[remote-broker-chat] ${message}`);
  for (const entry of childProcesses) {
    if (entry.output.stderr.length > 0) console.error(`[remote-broker-chat] ${entry.name} stderr tail: ${entry.output.stderr.join(' ').slice(-1200)}`);
    if (entry.output.stdout.length > 0) console.error(`[remote-broker-chat] ${entry.name} stdout tail: ${entry.output.stdout.join(' ').slice(-1200)}`);
  }
} finally {
  await localA?.klient.close().catch(() => {});
  await remoteB?.klient.close().catch(() => {});
  await controlA?.close().catch(() => {});
  await controlB?.close().catch(() => {});
  await cleanup();
  console.log('=== remote broker chat evidence ===');
  console.log(`command: node apps/kiki-gui/scripts/remote-broker-chat.mjs`);
  console.log(`run=${runId}; homes=${runRoot}; ports are auto-selected; do not run concurrently with another kap-server on the same ports.`);
  console.log(`[setup] real kap-server A and B plus local stub model; authenticated admission order: B inbound → A handshake → B invitation → A add; dangerous auth bypass=false.`);
  for (const step of [1, 2, 3, 4, 5]) console.log(`[step ${step}] ${stepEvidence.get(step) ?? 'NOT REACHED'}`);
  if (stepEvidence.has('gui')) console.log(`[gui] ${stepEvidence.get('gui')}`);
  console.log('[scope] GUI success requires the selected B session URL, this GUI prompt turn’s visible assistant reply, and return to A’s list/session/local composer. Two real isolated KAP servers and a loopback fake model are used; this is not a real SSH, external-model, or native desktop-shell check.');
  if (exitCode !== 0) console.error('[remote-broker-chat] FAILED');
}
process.exitCode = exitCode;
