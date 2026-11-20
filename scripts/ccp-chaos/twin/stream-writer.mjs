/**
 * Paced semantic SSE stream writer for Contract Twin Server (Astra v2.3 §§4, 10.2).
 *
 * Emits 100-300 independently timed semantic deltas (text, thinking, fragmented valid
 * tool-call JSON), honoring Node HTTP `res.write() === false` / `drain` backpressure
 * and supporting deterministic mid-stream reset/half-open faults.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function writeWithBackpressure(res, chunk) {
  if (res.destroyed || res.writableEnded) return false;
  const ok = res.write(chunk);
  if (!ok) {
    await new Promise((resolve) => {
      const done = () => {
        res.off('drain', done);
        res.off('close', done);
        res.off('error', done);
        resolve();
      };
      res.once('drain', done);
      res.once('close', done);
      res.once('error', done);
    });
  }
  return !res.destroyed && !res.writableEnded;
}

export function sliceIntoSemanticChunks(text, targetChunks) {
  const s = String(text ?? '');
  if (!s.length) return [];
  const count = Math.max(1, Math.min(targetChunks, s.length));
  const step = Math.max(1, Math.ceil(s.length / count));
  const out = [];
  for (let i = 0; i < s.length; i += step) {
    out.push(s.slice(i, i + step));
  }
  return out;
}

/**
 * Streams an Anthropic SSE message with paced semantic deltas (text + optional thinking + optional tool calls).
 * Returns observed semantic delta & useful payload byte counters for §10.2 verification.
 */
export async function streamPacedAnthropicResponse(
  res,
  req,
  {
    model,
    messageId,
    thinkingText = '',
    replyText = '',
    toolCalls = [],
    targetDeltas = 120,
    cadenceMs = 15,
    faultAtDelta = null,
    faultMode = null,
    onDeltaEmitted = null,
  },
) {
  let closed = false;
  res.once('close', () => {
    if (!res.writableEnded) closed = true;
  });

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
  });

  let semanticDeltas = 0;
  let usefulPayloadBytes = 0;
  const startedAt = performance.now();

  const emit = async (eventName, payload, usefulStr = '') => {
    if (closed || res.destroyed) return false;
    const ok = await writeWithBackpressure(res, `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
    if (!ok) return false;
    if (usefulStr.length > 0) {
      semanticDeltas += 1;
      usefulPayloadBytes += Buffer.byteLength(usefulStr, 'utf8');
      onDeltaEmitted?.({ semanticDeltas, usefulPayloadBytes, elapsedMs: performance.now() - startedAt });
    }
    return true;
  };

  const stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';
  await emit('message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 128, output_tokens: 0 },
    },
  });

  let blockIndex = 0;
  const totalBlocks = (thinkingText ? 1 : 0) + (replyText ? 1 : 0) + toolCalls.length;
  const perBlockTarget = Math.max(8, Math.ceil(targetDeltas / Math.max(1, totalBlocks)));

  const maybeInjectFault = async () => {
    if (faultAtDelta !== null && semanticDeltas >= faultAtDelta) {
      if (faultMode === 'reset') {
        res.socket?.destroy(new Error('twin_injected_midstream_reset'));
        closed = true;
        return true;
      }
      if (faultMode === 'eof') {
        res.end();
        closed = true;
        return true;
      }
    }
    return false;
  };

  if (thinkingText) {
    const idx = blockIndex++;
    await emit('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '' } });
    for (const chunk of sliceIntoSemanticChunks(thinkingText, perBlockTarget)) {
      if (closed) break;
      await emit('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: chunk } }, chunk);
      if (await maybeInjectFault()) return { semanticDeltas, usefulPayloadBytes, aborted: true };
      if (cadenceMs > 0) await sleep(cadenceMs);
    }
    if (!closed) await emit('content_block_stop', { type: 'content_block_stop', index: idx });
  }

  if (replyText) {
    const idx = blockIndex++;
    await emit('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
    for (const chunk of sliceIntoSemanticChunks(replyText, perBlockTarget)) {
      if (closed) break;
      await emit('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: chunk } }, chunk);
      if (await maybeInjectFault()) return { semanticDeltas, usefulPayloadBytes, aborted: true };
      if (cadenceMs > 0) await sleep(cadenceMs);
    }
    if (!closed) await emit('content_block_stop', { type: 'content_block_stop', index: idx });
  }

  for (const call of toolCalls) {
    if (closed) break;
    const idx = blockIndex++;
    const jsonText = JSON.stringify(call.input ?? {});
    await emit('content_block_start', {
      type: 'content_block_start',
      index: idx,
      content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
    });
    for (const frag of sliceIntoSemanticChunks(jsonText, Math.max(6, Math.floor(perBlockTarget / 2)))) {
      if (closed) break;
      await emit(
        'content_block_delta',
        { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: frag } },
        frag,
      );
      if (await maybeInjectFault()) return { semanticDeltas, usefulPayloadBytes, aborted: true };
      if (cadenceMs > 0) await sleep(cadenceMs);
    }
    if (!closed) await emit('content_block_stop', { type: 'content_block_stop', index: idx });
  }

  if (!closed && !res.destroyed) {
    await emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: Math.max(16, Math.ceil(usefulPayloadBytes / 4)) },
    });
    await emit('message_stop', { type: 'message_stop' });
    res.end();
  }

  return {
    semanticDeltas,
    usefulPayloadBytes,
    elapsedMs: Number((performance.now() - startedAt).toFixed(2)),
    aborted: closed,
  };
}
