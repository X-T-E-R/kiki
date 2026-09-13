import { startFixtureServer, FIXTURE_TOKEN } from './fixture-server.mjs';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { WebSocketServer } from 'ws';

async function run() {
  const output = resolve('.tmp/browser-proof');
  await mkdir(output, { recursive: true });

  const fixture = await startFixtureServer({ port: 0, scenario: 'gui-slice' });
  const fixturePort = fixture.http.address().port;
  const fixtureUrl = `http://127.0.0.1:${fixturePort}`;
  console.log('Fixture server running on:', fixtureUrl);

  // Hook klient endpoints into fixture.handleHttp
  const originalHandleHttp = fixture.handleHttp.bind(fixture);
  fixture.handleHttp = async (req, res) => {
    console.log('FIXTURE HTTP REQ:', req.method, req.url);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url, fixtureUrl);
    const path = url.pathname;
    
    // Klient session-view snapshot
    const snapshotMatch = /^\/api\/klient\/session-view\/([^/]+)\/snapshot$/.exec(path);
    if (snapshotMatch !== null) {
      const sid = snapshotMatch[1];
      const session = fixture.sessions.get(sid);
      if (!session) return fixture.envelope(res, null, 40401, 'session.not_found');
      return fixture.envelope(res, {
        as_of_seq: session.seq,
        epoch: session.epoch,
        session: session.record,
        messages: { items: session.messages.slice(-50), has_more: session.hasMore || session.messages.length > 50 },
        in_flight_turn: session.inFlightTurn,
        subagents: (session.subagents ?? []).map(s => ({
          id: s.id ?? `task-${s.agent_id}`,
          session_id: sid,
          kind: s.kind ?? 'subagent',
          created_at: s.created_at ?? s.started_at ?? new Date().toISOString(),
          ...s,
        })),
        pending_approvals: session.pendingApprovals,
        pending_questions: session.pendingQuestions,
      });
    }

    // Klient transcript page
    const transcriptMatch = /^\/api\/klient\/session-view\/([^/]+)\/transcript$/.exec(path);
    if (transcriptMatch !== null) {
      const sid = transcriptMatch[1];
      const session = fixture.sessions.get(sid);
      if (!session) return fixture.envelope(res, null, 40401, 'session.not_found');
      const agentId = url.searchParams.get('agent_id') || 'main';
      const live = session.transcript.snapshot(agentId);
      return fixture.envelope(res, {
        agent_id: agentId,
        items: live.items,
        has_more: false,
        tasks: live.tasks,
        interactions: live.interactions,
        attachments: live.attachments,
        todos: live.todos,
        prompts: live.prompts,
        meta: live.meta,
        agents: [{ agentId: 'main', type: 'main' }],
        pending_interactions: [],
        seq: session.transcript.latestSeq(agentId),
      });
    }

    return originalHandleHttp(req, res);
  };

  // Klient WebSocket on /api/klient/events
  const klientWss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => [...protocols][0]
  });
  const originalUpgrade = fixture.handleUpgrade.bind(fixture);
  fixture.handleUpgrade = (req, socket, head) => {
    console.log('FIXTURE UPGRADE REQUEST:', req.url);
    if (req.url?.startsWith('/api/klient/events')) {
      klientWss.handleUpgrade(req, socket, head, (ws) => {
        klientWss.emit('connection', ws, req);
      });
      return;
    }
    return originalUpgrade(req, socket, head);
  };

  klientWss.on('connection', (ws) => {
    console.log('Klient WS connected');
    const views = new Map();

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      console.log('WS msg received:', msg.type);
      if (msg.type === 'view_attach') {
        const { id, sessionId, data } = msg;
        const session = fixture.sessions.get(sessionId);
        if (!session) {
          console.log('Session not found in fixture:', sessionId);
          return;
        }
        const generation = data?.generation ?? 1;
        views.set(id, { sessionId, generation });

        // Send reset signal
        const resetEvent = session.transcript.resetEvent('main');
        console.log('Sending resetEvent for main, items count:', resetEvent.snapshot?.items?.length);
        ws.send(JSON.stringify({
          type: 'view_signal',
          id,
          data: {
            type: 'transcript',
            event: resetEvent,
            generation,
          },
        }));

        // Send ready signal
        ws.send(JSON.stringify({
          type: 'view_signal',
          id,
          data: {
            type: 'ready',
            currentSessionCursor: { seq: session.seq, epoch: session.epoch },
            reconnected: false,
            generation,
          },
        }));
      }
    });
  });

  const vite = await createServer({
    root: resolve('systems/kiki/apps/kiki-gui'),
    server: { host: '127.0.0.1', port: 5190, strictPort: true }
  });
  await vite.listen();
  const webPort = vite.httpServer.address().port;
  const webUrl = `http://127.0.0.1:${webPort}`;
  console.log('Vite server running on:', webUrl);

  const browser = await chromium.launch({ args: ['--no-proxy-server'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  
  try {
    const targetUrl = `${webUrl}/s/session_fixture_gui_slice?server=${encodeURIComponent(fixtureUrl)}&token=${FIXTURE_TOKEN}`;
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
    page.on('request', req => console.log('REQ:', req.method(), req.url()));
    page.on('requestfailed', req => console.log('REQ FAILED:', req.method(), req.url(), req.failure()?.errorText));
    console.log('Opening page:', targetUrl);
    await page.goto(targetUrl, { timeout: 30000 });
    
    await page.waitForTimeout(2000);
    const bodyHtml = await page.evaluate(() => document.body.innerText);
    console.log('PAGE BODY TEXT PREVIEW:\n', bodyHtml.slice(0, 500));
    
    // Wait for transcript scroll container
    await page.locator('[data-transcript-scroll]').waitFor({ timeout: 15000 });
    console.log('Transcript scroll container mounted!');
    // Scroll to top to see the first message!
    await page.evaluate(() => {
      document.querySelector('[data-transcript-scroll]').scrollTop = 0;
    });
    await page.waitForTimeout(500);

    await page.screenshot({ path: join(output, 'first-open-top.png'), fullPage: false });

    // Inspect positions of virtual items
    const measurements = await page.evaluate(() => {
      const items = [...document.querySelectorAll('[data-transcript-virtual-item]')].map((el) => {
        const rect = el.getBoundingClientRect();
        const block = el.querySelector('[data-block-id]')?.getAttribute('data-block-id');
        const styleTop = el.style.top;
        const styleTransform = el.style.transform;
        return {
          block,
          styleTop,
          styleTransform,
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
          offsetHeight: el.offsetHeight,
        };
      });
      return {
        items,
        containerHeight: document.querySelector('[data-transcript-virtual-content]')?.style.height,
        scrollTop: document.querySelector('[data-transcript-scroll]')?.scrollTop,
        scrollHeight: document.querySelector('[data-transcript-scroll]')?.scrollHeight,
        clientHeight: document.querySelector('[data-transcript-scroll]')?.clientHeight,
      };
    });

    console.log('Measurements:', JSON.stringify(measurements, null, 2));

  } catch (err) {
    console.error('Test error:', err);
  } finally {
    await browser.close();
    await vite.close();
    fixture.http.close();
    fixture.wss.close();
  }
}

run();
