import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

export async function openTranscriptObserver(port, bearerToken) {
  const wsUrl = `ws://127.0.0.1:${port}/api/ws`;
  const ws = new WebSocket(wsUrl, [`kimi-code.bearer.${bearerToken}`]);
  const listeners = new Set();
  const ackWaiters = new Map();
  let reqSeq = 0;

  let serverHelloResolve;
  const serverHelloPromise = new Promise((resolve) => {
    serverHelloResolve = resolve;
  });

  let wsClosedError = null;
  const rejectAllAckWaiters = (err) => {
    wsClosedError = err;
    for (const [id, waiter] of ackWaiters) {
      ackWaiters.delete(id);
      waiter.reject(err);
    }
  };

  ws.addEventListener('message', (event) => {
    let parsed;
    try {
      const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (parsed.type === 'server_hello') {
      serverHelloResolve?.(parsed);
      serverHelloResolve = undefined;
      return;
    }
    if (parsed.type === 'ping') {
      try {
        ws.send(JSON.stringify({ type: 'pong', ...(parsed.id ? { id: parsed.id } : {}) }));
      } catch {}
      return;
    }
    if (parsed.type === 'pong') {
      return;
    }
    if (parsed.type === 'ack' && typeof parsed.id === 'string') {
      const waiter = ackWaiters.get(parsed.id);
      if (waiter) {
        ackWaiters.delete(parsed.id);
        waiter.resolve(parsed);
      }
      return;
    }
    for (const listener of listeners) {
      listener(parsed);
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', (err) => reject(err), { once: true });
  });

  ws.addEventListener('close', (ev) => {
    rejectAllAckWaiters(new Error(`WS closed unexpectedly code=${ev.code} reason=${ev.reason}`));
  });
  ws.addEventListener('error', () => {
    rejectAllAckWaiters(new Error('WS socket error'));
  });

  async function sendControl(frame, timeoutMs = 45000) {
    if (wsClosedError) throw wsClosedError;
    const id = frame.id;
    const ackPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ackWaiters.delete(id);
        reject(new Error(`WS ${frame.type} (${id}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      ackWaiters.set(id, {
        resolve(val) {
          clearTimeout(timer);
          resolve(val);
        },
        reject(err) {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
    ws.send(JSON.stringify(frame));
    return ackPromise;
  }

  await serverHelloPromise;
  const helloAck = await sendControl({
    type: 'client_hello',
    id: 'hello',
    payload: { client_id: 'perf-home-bench', token: bearerToken },
  });
  if (helloAck.code !== 0) {
    throw new Error(`client_hello failed with code=${helloAck.code}`);
  }

  const heartbeatTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        reqSeq += 1;
        ws.send(JSON.stringify({ type: 'ping', id: `hb-${reqSeq}` }));
      } catch {}
    }
  }, 10000);
  heartbeatTimer.unref?.();

  async function subscribeSession(sessionId, timeoutMs = 45000) {
    reqSeq += 1;
    const ack = await sendControl(
      {
        type: 'subscribe_v2',
        id: `sub-${reqSeq}`,
        payload: {
          session_id: sessionId,
          transcript: { '*': 'off', main: 'delta' },
          transcript_coverage_version: 2,
        },
      },
      timeoutMs,
    );
    if (ack.code !== 0) {
      throw new Error(`subscribe_v2 failed with code=${ack.code}`);
    }
  }

  async function subscribeEvents(sessionId, timeoutMs = 30000) {
    reqSeq += 1;
    const ack = await sendControl(
      {
        type: 'subscribe',
        id: `subev-${reqSeq}`,
        payload: {
          session_ids: [sessionId],
          agent_filter: ['main'],
        },
      },
      timeoutMs,
    );
    if (ack.code !== 0) {
      throw new Error(`subscribe failed with code=${ack.code}`);
    }
  }

  async function unsubscribeSession(sessionId, timeoutMs = 15000) {
    reqSeq += 1;
    await sendControl(
      {
        type: 'unsubscribe_v2',
        id: `unsub2-${reqSeq}`,
        payload: { session_id: sessionId },
      },
      timeoutMs,
    ).catch(() => {});
    reqSeq += 1;
    await sendControl(
      {
        type: 'unsubscribe',
        id: `unsub-${reqSeq}`,
        payload: { session_ids: [sessionId] },
      },
      timeoutMs,
    ).catch(() => {});
  }

  function watchPromptTurn(sessionId, startedAtPerfNow) {
    let firstDeltaMs = null;
    let resolveDelta;
    let resolveDone;
    const firstDeltaPromise = new Promise((resolve) => {
      resolveDelta = resolve;
    });
    const turnDonePromise = new Promise((resolve) => {
      resolveDone = resolve;
    });

    const onFrame = (frame) => {
      const frameSessionId = frame.session_id ?? frame.payload?.session_id ?? frame.payload?.sessionId;
      if (frameSessionId !== undefined && frameSessionId !== sessionId) return;

      const evType = frame.payload?.event?.type ?? frame.payload?.type ?? frame.type;
      if (
        evType === 'content.delta' ||
        evType === 'assistant.delta' ||
        evType === 'thinking.delta'
      ) {
        if (firstDeltaMs === null) {
          firstDeltaMs = Number((performance.now() - startedAtPerfNow).toFixed(2));
          resolveDelta(firstDeltaMs);
        }
      }
      if (evType === 'turn.ended') {
        if (firstDeltaMs === null) {
          firstDeltaMs = Number((performance.now() - startedAtPerfNow).toFixed(2));
          resolveDelta(firstDeltaMs);
        }
        resolveDone('completed');
        return;
      }

      if (frame.type === 'prompt.outcome_committed' || evType === 'prompt.outcome_committed') {
        const terminal = frame.payload?.terminal;
        if (firstDeltaMs === null) {
          firstDeltaMs = Number((performance.now() - startedAtPerfNow).toFixed(2));
          resolveDelta(firstDeltaMs);
        }
        resolveDone(terminal?.state ?? 'completed');
        return;
      }

      if (frame.type === 'transcript.ops') {
        const ops = frame.payload?.ops ?? frame.ops ?? [];
        for (const op of ops) {
          if (
            firstDeltaMs === null &&
            (op.op === 'append' ||
              (op.op === 'frame.upsert' && op.frame?.kind !== 'user'))
          ) {
            firstDeltaMs = Number((performance.now() - startedAtPerfNow).toFixed(2));
            resolveDelta(firstDeltaMs);
          }
          if (
            op.op === 'turn.upsert' &&
            (op.turn?.state === 'completed' || op.turn?.state === 'failed' || op.turn?.state === 'cancelled')
          ) {
            if (firstDeltaMs === null) {
              firstDeltaMs = Number((performance.now() - startedAtPerfNow).toFixed(2));
              resolveDelta(firstDeltaMs);
            }
            resolveDone(op.turn.state);
          }
        }
      }
      if (
        frame.type === 'event.session.work_changed' &&
        frame.payload?.busy === false &&
        firstDeltaMs !== null
      ) {
        resolveDone('idle');
      }
    };

    listeners.add(onFrame);
    const cleanup = () => listeners.delete(onFrame);

    return {
      waitFirstDelta(timeoutMs = 30000) {
        return Promise.race([
          firstDeltaPromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timed out waiting for first transcript delta')), timeoutMs),
          ),
        ]);
      },
      async waitTurnSettled(timeoutMs = 30000) {
        try {
          return await Promise.race([
            turnDonePromise,
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Timed out waiting for turn settlement')), timeoutMs),
            ),
          ]);
        } finally {
          cleanup();
        }
      },
      dispose: cleanup,
    };
  }

  return {
    subscribeSession,
    subscribeEvents,
    unsubscribeSession,
    watchPromptTurn,
    close() {
      clearInterval(heartbeatTimer);
      try {
        ws.close();
      } catch {}
    },
  };
}

function parseLogKeyValues(line) {
  const fields = {};
  const regex = /([A-Za-z0-9_]+)=("[^"]*"|\S+)/g;
  let match;
  while ((match = regex.exec(line)) !== null) {
    const key = match[1];
    let val = match[2];
    if (val.startsWith('"') && val.endsWith('"')) {
      try {
        val = JSON.parse(val);
      } catch {
        val = val.slice(1, -1);
      }
    } else if (/^-?\d+(\.\d+)?$/.test(val)) {
      val = Number(val);
    }
    fields[key] = val;
  }
  return fields;
}

export function parseServerPhaseLogs(stagedHome) {
  const logDir = path.join(stagedHome, 'logs');
  if (!fs.existsSync(logDir)) return { byPromptId: new Map(), bySessionId: new Map(), totals: {} };

  const byPromptId = new Map();
  const bySessionId = new Map();
  const phaseBuckets = new Map();

  const files = fs
    .readdirSync(logDir)
    .filter((name) => name.startsWith('kimi-code.log'))
    .sort()
    .reverse();

  for (const file of files) {
    const text = fs.readFileSync(path.join(logDir, file), 'utf8');
    for (const line of text.split('\n')) {
      const isRestorePhase = line.includes('agent restore phase');
      const isSubphase = !isRestorePhase && line.includes('prompt admission subphase');
      if (!isRestorePhase && !isSubphase) continue;

      let ctx;
      if (line.trimStart().startsWith('{')) {
        try {
          const parsed = JSON.parse(line);
          ctx = parsed.ctx ?? parsed;
        } catch {
          continue;
        }
      } else {
        ctx = parseLogKeyValues(line);
      }

      if (isRestorePhase && ctx.status === 'completed' && typeof ctx.elapsedMs === 'number') {
        const key = `phase:${ctx.phase}`;
        if (!phaseBuckets.has(key)) phaseBuckets.set(key, []);
        phaseBuckets.get(key).push(ctx.elapsedMs);
        if (typeof ctx.promptId === 'string') {
          const map = byPromptId.get(ctx.promptId) ?? {};
          map[ctx.phase] = ctx.elapsedMs;
          byPromptId.set(ctx.promptId, map);
        }
        if (typeof ctx.sessionId === 'string') {
          const list = bySessionId.get(ctx.sessionId) ?? [];
          list.push({ kind: 'phase', name: ctx.phase, elapsedMs: ctx.elapsedMs, promptId: ctx.promptId });
          bySessionId.set(ctx.sessionId, list);
        }
      } else if (isSubphase && typeof ctx.elapsedMs === 'number') {
        const key = `subphase:${ctx.subphase}`;
        if (!phaseBuckets.has(key)) phaseBuckets.set(key, []);
        phaseBuckets.get(key).push(ctx.elapsedMs);
        if (typeof ctx.promptId === 'string') {
          const map = byPromptId.get(ctx.promptId) ?? {};
          map[`sub:${ctx.subphase}`] = ctx.elapsedMs;
          byPromptId.set(ctx.promptId, map);
        }
      }
    }
  }

  const totals = {};
  for (const [key, values] of phaseBuckets) {
    const sorted = [...values].sort((a, b) => a - b);
    totals[key] = {
      count: sorted.length,
      p50Ms: Number(sorted[Math.floor((sorted.length - 1) * 0.5)].toFixed(2)),
      p95Ms: Number(sorted[Math.floor((sorted.length - 1) * 0.95)].toFixed(2)),
      maxMs: Number(sorted[sorted.length - 1].toFixed(2)),
    };
  }

  return { byPromptId, bySessionId, totals };
}
