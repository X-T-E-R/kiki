import { createServer } from 'node:http';

const HOLD_TAG_RE = /\[PERF_HOLD_STREAM:([A-Za-z0-9_-]+)\]/g;

function extractActiveHoldGateId(bodyText, holdGates) {
  let activeId;
  let match;
  HOLD_TAG_RE.lastIndex = 0;
  while ((match = HOLD_TAG_RE.exec(bodyText)) !== null) {
    const candidate = match[1];
    const gate = holdGates.get(candidate);
    if (gate && !gate.released) {
      activeId = candidate;
    }
  }
  return activeId;
}

export async function startMockSseProvider() {
  const holdGates = new Map();
  const streamReadyResolvers = new Map();
  let requestCount = 0;

  function ensureGate(gateId) {
    let gate = holdGates.get(gateId);
    if (!gate) {
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      gate = { promise, release, released: false };
      holdGates.set(gateId, gate);
    }
    return gate;
  }

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-fast', object: 'model' }] }));
      return;
    }

    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', async () => {
      requestCount += 1;
      let model = 'mock-fast';
      try {
        const parsed = JSON.parse(body);
        if (typeof parsed.model === 'string' && parsed.model.length > 0) {
          model = parsed.model;
        }
      } catch {}

      const gateId = extractActiveHoldGateId(body, holdGates);
      const isResponsesApi = req.url?.includes('/responses');

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      res.flushHeaders?.();

      if (isResponsesApi) {
        const seq1 = JSON.stringify({
          type: 'response.output_text.delta',
          delta: 'Ack.',
        });
        res.write(`event: response.output_text.delta\ndata: ${seq1}\n\n`);
      } else {
        const chunk1 = JSON.stringify({
          id: `mock-${requestCount}`,
          object: 'chat.completion.chunk',
          created: 1700000000,
          model,
          choices: [{ index: 0, delta: { role: 'assistant', content: 'Ack.' }, finish_reason: null }],
        });
        res.write(`data: ${chunk1}\n\n`);
      }

      if (gateId !== undefined) {
        const ready = streamReadyResolvers.get(gateId);
        if (ready) {
          streamReadyResolvers.delete(gateId);
          ready();
        }
        const gate = ensureGate(gateId);
        if (!gate.released) {
          await Promise.race([
            gate.promise,
            new Promise((resolve) => req.once('close', resolve)),
          ]);
        }
      }

      if (res.writableEnded || res.destroyed) return;

      if (isResponsesApi) {
        const done = JSON.stringify({
          type: 'response.completed',
          response: {
            id: `resp-${requestCount}`,
            status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Ack.' }] }],
            usage: { input_tokens: 12, output_tokens: 2, total_tokens: 14 },
          },
        });
        res.end(`event: response.completed\ndata: ${done}\n\n`);
      } else {
        const chunk2 = JSON.stringify({
          id: `mock-${requestCount}`,
          object: 'chat.completion.chunk',
          created: 1700000000,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
        });
        res.end(`data: ${chunk2}\n\ndata: [DONE]\n\n`);
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Mock SSE server failed to bind loopback port');
  }

  return {
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    getRequestCount: () => requestCount,
    prepareHoldGate(gateId) {
      ensureGate(gateId);
      let resolveReady;
      const streamStarted = new Promise((resolve) => {
        resolveReady = resolve;
      });
      streamReadyResolvers.set(gateId, resolveReady);
      return {
        streamStarted,
        release: () => {
          const gate = holdGates.get(gateId);
          if (gate && !gate.released) {
            gate.released = true;
            gate.release();
          }
        },
      };
    },
    close: () =>
      new Promise((resolve) => {
        for (const gate of holdGates.values()) {
          if (!gate.released) {
            gate.released = true;
            gate.release();
          }
        }
        server.close(() => resolve());
      }),
  };
}
