import { createRequire } from 'node:module';

const requireFromCore = createRequire(new URL('../../../packages/agent-core-v2/package.json', import.meta.url));
const { WebSocketServer } = requireFromCore('ws');

const RESPONSES_WS_CAPABILITIES_V2 = JSON.stringify({
  version: 2,
  events: ['response.create'],
  generate: true,
  generate_false: false,
  background: false,
  steering: false,
  cancel: false,
  scheduling: 'connection_fifo',
  max_in_flight: 1,
  max_named_streams: 8,
  max_queued: 8,
  max_frame_bytes: 8388608,
  max_queued_bytes: 8388608,
  max_state_bytes: 8388608,
  state_ttl_seconds: 600,
  connection_lifetime_seconds: 2415,
  admission_lifetime_seconds: 1800,
  active_turn_timeout_seconds: 600,
  lifetime_mode: 'drain_active',
  state_scope: 'connection',
  previous_response_id: true,
  native_responses_upstream_required: true,
  state_miss: 'previous_response_not_found',
  state_miss_execution: 'not_executed',
});

function extractHeader(headers, name) {
  const value = headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(', ');
  return typeof value === 'string' ? value : undefined;
}

export function createTwinProtocolExtension({ cacheOracle, recordViolation, counters, sendJson, nextSeq }) {
  const armedActions = [];
  const responsesHttpStore = new Map();
  const wsSockets = new Set();
  const wsStats = {
    connections: 0,
    frames: 0,
    incrementalFrames: 0,
    fullFrames: 0,
    stateMisses: 0,
  };

  function armAction(action) {
    armedActions.push({ ...action });
  }

  function clearArmedActions() {
    armedActions.length = 0;
  }

  function consumeArmedAction(protocol) {
    const idx = armedActions.findIndex((a) => !a.protocol || a.protocol === protocol);
    if (idx === -1) return null;
    const [action] = armedActions.splice(idx, 1);
    return action;
  }

  function resetProtocolState() {
    armedActions.length = 0;
    responsesHttpStore.clear();
    wsStats.connections = 0;
    wsStats.frames = 0;
    wsStats.incrementalFrames = 0;
    wsStats.fullFrames = 0;
    wsStats.stateMisses = 0;
  }

  function sendAnthropicToolViolation(res, { model, messageId, mixedText, toolName = 'Read', stream = true, usage }) {
    const toolCallId = `toolu_viol_${messageId}`;
    const blocks = [];
    if (mixedText) blocks.push({ type: 'text', text: mixedText });
    blocks.push({ type: 'tool_use', id: toolCallId, name: toolName, input: { path: 'README.md' } });
    const messageUsage = usage ?? { input_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 24 };
    if (!stream) {
      counters.succeededResponses += 1;
      sendJson(res, 200, {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model,
        content: blocks,
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: messageUsage,
      });
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
    });
    res.flushHeaders?.();
    res.write(`event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: messageUsage.input_tokens ?? 0,
          cache_read_input_tokens: messageUsage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: messageUsage.cache_creation_input_tokens ?? 0,
          output_tokens: 1,
        },
      },
    })}\n\n`);
    let blockIdx = 0;
    if (mixedText) {
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: blockIdx, content_block: { type: 'text', text: '' } })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: blockIdx, delta: { type: 'text_delta', text: mixedText } })}\n\n`);
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIdx })}\n\n`);
      blockIdx += 1;
    }
    res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: blockIdx, content_block: { type: 'tool_use', id: toolCallId, name: toolName, input: {} } })}\n\n`);
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: blockIdx, delta: { type: 'input_json_delta', partial_json: '{"path":"README.md"}' } })}\n\n`);
    res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIdx })}\n\n`);
    res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 24 } })}\n\n`);
    res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
    counters.succeededResponses += 1;
    res.end();
  }

  function handleGeminiRequest(req, res, { urlPath, body }) {
    const modelMatch = /\/models\/([^:/]+):(streamGenerateContent|generateContent)/u.exec(urlPath);
    const model = modelMatch?.[1] ?? body.model ?? 'gemini-2.5-pro';
    const isStream = modelMatch?.[2] === 'streamGenerateContent';
    const seq = nextSeq();
    const messageId = `gem_twin_${String(seq).padStart(6, '0')}`;
    const bodyWithModel = { ...body, model };
    const armed = consumeArmedAction('google_genai');

    if (armed?.kind === 'context_overflow') {
      sendJson(res, 400, {
        error: {
          code: 400,
          status: 'INVALID_ARGUMENT',
          message: 'The input token count exceeds the maximum number of tokens allowed.',
        },
      });
      return;
    }
    if (armed?.kind === 'http_413') {
      sendJson(res, 413, {
        error: { code: 413, status: 'INVALID_ARGUMENT', message: 'Request payload size exceeds the limit.' },
      });
      return;
    }

    const audit = cacheOracle.evaluate({
      protocol: 'google_genai',
      body: bodyWithModel,
      requestMeta: { messageId, urlPath, stream: isStream },
    });

    const parts = [];
    if (armed?.kind === 'tool_call_violation') {
      if (armed.mixedText) parts.push({ text: armed.mixedText });
      parts.push({ functionCall: { name: armed.toolName ?? 'Read', args: { path: 'README.md' } } });
    } else {
      parts.push({ text: armed?.replyText ?? `Twin Gemini OK [${messageId}]` });
    }

    const payload = {
      responseId: messageId,
      modelVersion: model,
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: audit.providerUsage,
    };

    counters.succeededResponses += 1;
    if (!isStream) {
      sendJson(res, 200, payload);
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
    });
    res.flushHeaders?.();
    res.end(`data: ${JSON.stringify(payload)}\n\n`);
  }

  function handleOpenAiWithOracle(req, res, { isResponsesApi, body, messageId, stream }) {
    const protocolHint = extractHeader(req.headers, 'x-twin-protocol');
    const isDeepSeek =
      !isResponsesApi &&
      (protocolHint === 'deepseek' || (typeof body.model === 'string' && body.model.toLowerCase().includes('deepseek')));
    const protocol = isResponsesApi ? 'openai_responses' : isDeepSeek ? 'deepseek' : 'openai_chat';
    const armed = consumeArmedAction(protocol);

    if (armed?.kind === 'context_overflow') {
      sendJson(res, 400, {
        error: {
          type: 'invalid_request_error',
          code: 'context_length_exceeded',
          message: 'Your input exceeds the context window of this model.',
        },
      });
      return;
    }
    if (armed?.kind === 'http_413') {
      sendJson(res, 413, {
        error: {
          type: 'invalid_request_error',
          code: 'request_body_too_large',
          message: 'Request entity too large; reduce media attachments.',
        },
      });
      return;
    }

    let effectiveMessages = null;
    let effectiveTools = null;
    let incrementalTransport = null;

    if (isResponsesApi) {
      const prevId = typeof body.previous_response_id === 'string' && body.previous_response_id.length > 0
        ? body.previous_response_id
        : null;
      const incomingInput = Array.isArray(body.input) ? body.input : body.input !== undefined ? [body.input] : [];
      if (prevId) {
        const stored = responsesHttpStore.get(prevId);
        if (!stored) {
          sendJson(res, 400, {
            error: {
              type: 'invalid_request_error',
              code: 'previous_response_not_found',
              message: `Previous response "${prevId}" not found.`,
            },
          });
          return;
        }
        effectiveMessages = [...stored.input, ...incomingInput];
        effectiveTools = Array.isArray(body.tools) ? body.tools : stored.tools;
        incrementalTransport = 'responses_http_previous_id';
      } else {
        effectiveMessages = incomingInput;
        effectiveTools = Array.isArray(body.tools) ? body.tools : [];
      }
    }

    const audit = cacheOracle.evaluate({
      protocol,
      body,
      effectiveMessages,
      effectiveTools,
      incrementalTransport,
      requestMeta: { messageId, isResponsesApi, stream },
    });

    const replyText = armed?.replyText ?? `Twin OK [${messageId}]`;
    const isToolViolation = armed?.kind === 'tool_call_violation';

    if (isResponsesApi) {
      const outputItems = [];
      if (isToolViolation) {
        if (armed.mixedText) {
          outputItems.push({ type: 'message', id: `msg_${messageId}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: armed.mixedText }] });
        }
        outputItems.push({
          type: 'function_call',
          id: `fc_${messageId}`,
          call_id: `call_${messageId}`,
          name: armed.toolName ?? 'Read',
          arguments: '{"path":"README.md"}',
        });
      } else {
        outputItems.push({ type: 'message', id: `msg_${messageId}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: replyText }] });
      }
      responsesHttpStore.set(messageId, {
        input: [...(effectiveMessages ?? []), ...outputItems],
        tools: effectiveTools ?? [],
      });
      if (responsesHttpStore.size > 1024) {
        const oldest = responsesHttpStore.keys().next().value;
        if (oldest) responsesHttpStore.delete(oldest);
      }

      if (!stream) {
        counters.succeededResponses += 1;
        sendJson(res, 200, {
          id: messageId,
          object: 'response',
          status: 'completed',
          model: body.model,
          output: outputItems,
          usage: audit.providerUsage,
        });
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
      });
      res.flushHeaders?.();
      if (isToolViolation) {
        if (armed.mixedText) {
          res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: armed.mixedText })}\n\n`);
        }
        const fc = outputItems[outputItems.length - 1];
        res.write(`event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: outputItems.length - 1, item: { ...fc, arguments: '' } })}\n\n`);
        res.write(`event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: fc.id, output_index: outputItems.length - 1, delta: fc.arguments })}\n\n`);
        res.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: outputItems.length - 1, item: fc })}\n\n`);
      } else {
        res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: replyText })}\n\n`);
      }
      res.end(
        `event: response.completed\ndata: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id: messageId,
            object: 'response',
            status: 'completed',
            model: body.model,
            output: outputItems,
            usage: audit.providerUsage,
          },
        })}\n\n`,
      );
      counters.succeededResponses += 1;
      return;
    }

    // OpenAI Chat / DeepSeek
    const toolCallsPayload = isToolViolation
      ? [{ id: `call_${messageId}`, type: 'function', function: { name: armed.toolName ?? 'Read', arguments: '{"path":"README.md"}' } }]
      : undefined;

    if (!stream) {
      counters.succeededResponses += 1;
      sendJson(res, 200, {
        id: messageId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: isToolViolation ? (armed.mixedText ?? null) : replyText,
              ...(toolCallsPayload ? { tool_calls: toolCallsPayload } : {}),
            },
            finish_reason: isToolViolation ? 'tool_calls' : 'stop',
          },
        ],
        usage: audit.providerUsage,
      });
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
    });
    res.flushHeaders?.();
    if (isToolViolation) {
      if (armed.mixedText) {
        res.write(`data: ${JSON.stringify({
          id: messageId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{ index: 0, delta: { role: 'assistant', content: armed.mixedText }, finish_reason: null }],
        })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({
        id: messageId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{ index: 0, id: `call_${messageId}`, type: 'function', function: { name: armed.toolName ?? 'Read', arguments: '{"path":"README.md"}' } }],
          },
          finish_reason: null,
        }],
      })}\n\n`);
      res.end(`data: ${JSON.stringify({
        id: messageId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: audit.providerUsage,
      })}\n\ndata: [DONE]\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({
        id: messageId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: replyText }, finish_reason: null }],
      })}\n\n`);
      res.end(`data: ${JSON.stringify({
        id: messageId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: audit.providerUsage,
      })}\n\ndata: [DONE]\n\n`);
    }
    counters.succeededResponses += 1;
  }

  function attachResponsesWebSocket(httpServer) {
    const wss = new WebSocketServer({ noServer: true });
    wss.on('headers', (headers) => {
      headers.push(`X-Responses-WebSocket-Capabilities: ${RESPONSES_WS_CAPABILITIES_V2}`);
    });

    httpServer.on('upgrade', (req, socket, head) => {
      const urlPath = (req.url ?? '/').split('?')[0];
      if (!urlPath.includes('/responses')) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });

    wss.on('connection', (ws) => {
      wsStats.connections += 1;
      wsSockets.add(ws);
      const connResponses = new Map();

      ws.on('close', () => {
        wsSockets.delete(ws);
      });

      ws.on('message', (raw) => {
        wsStats.frames += 1;
        let frame;
        try {
          frame = JSON.parse(raw.toString('utf8'));
        } catch {
          ws.send(JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', code: 'invalid_json', message: 'Invalid WS JSON frame' } }));
          return;
        }
        if (frame.type !== 'response.create') {
          ws.send(JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', code: 'unsupported_event', message: `Unsupported WS event ${String(frame.type)}` } }));
          return;
        }

        const seq = nextSeq();
        const responseId = `resp_ws_${String(seq).padStart(6, '0')}`;
        const prevId = typeof frame.previous_response_id === 'string' && frame.previous_response_id.length > 0
          ? frame.previous_response_id
          : null;
        const incomingInput = Array.isArray(frame.input) ? frame.input : frame.input !== undefined ? [frame.input] : [];

        let effectiveInput = incomingInput;
        let effectiveTools = Array.isArray(frame.tools) ? frame.tools : [];
        let incrementalTransport = null;

        if (prevId) {
          const stored = connResponses.get(prevId);
          if (!stored) {
            wsStats.stateMisses += 1;
            ws.send(JSON.stringify({
              type: 'error',
              status: 400,
              error: {
                type: 'invalid_request_error',
                code: 'previous_response_not_found',
                message: `Previous response "${prevId}" not found on this WebSocket connection.`,
              },
            }));
            return;
          }
          wsStats.incrementalFrames += 1;
          effectiveInput = [...stored.input, ...incomingInput];
          effectiveTools = Array.isArray(frame.tools) ? frame.tools : stored.tools;
          incrementalTransport = 'responses_ws_previous_id';
        } else {
          wsStats.fullFrames += 1;
        }

        const armed = consumeArmedAction('openai_responses_ws');
        if (armed?.kind === 'context_overflow') {
          ws.send(JSON.stringify({
            type: 'error',
            status: 400,
            error: {
              type: 'invalid_request_error',
              code: 'context_length_exceeded',
              message: 'Your input exceeds the context window of this model.',
            },
          }));
          return;
        }

        const audit = cacheOracle.evaluate({
          protocol: 'openai_responses_ws',
          body: frame,
          effectiveMessages: effectiveInput,
          effectiveTools,
          incrementalTransport,
          requestMeta: { messageId: responseId, previousResponseId: prevId, wsConnection: wsStats.connections },
        });

        const isToolViolation = armed?.kind === 'tool_call_violation';
        const replyText = armed?.replyText ?? `Twin WS OK [${responseId}]`;
        const outputItems = [];
        if (isToolViolation) {
          if (armed.mixedText) {
            outputItems.push({ type: 'message', id: `msg_${responseId}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: armed.mixedText }] });
          }
          outputItems.push({
            type: 'function_call',
            id: `fc_${responseId}`,
            call_id: `call_${responseId}`,
            name: armed.toolName ?? 'Read',
            arguments: '{"path":"README.md"}',
          });
        } else {
          outputItems.push({ type: 'message', id: `msg_${responseId}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: replyText }] });
        }

        connResponses.set(responseId, {
          input: [...effectiveInput, ...outputItems],
          tools: effectiveTools,
        });

        ws.send(JSON.stringify({
          type: 'response.created',
          response: { id: responseId, object: 'response', status: 'in_progress', model: frame.model },
        }));
        if (isToolViolation) {
          if (armed.mixedText) {
            ws.send(JSON.stringify({ type: 'response.output_text.delta', delta: armed.mixedText }));
          }
          const fc = outputItems[outputItems.length - 1];
          ws.send(JSON.stringify({ type: 'response.output_item.added', output_index: outputItems.length - 1, item: { ...fc, arguments: '' } }));
          ws.send(JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: fc.id, output_index: outputItems.length - 1, delta: fc.arguments }));
          ws.send(JSON.stringify({ type: 'response.output_item.done', output_index: outputItems.length - 1, item: fc }));
        } else {
          ws.send(JSON.stringify({ type: 'response.output_text.delta', delta: replyText }));
        }
        ws.send(JSON.stringify({
          type: 'response.completed',
          response: {
            id: responseId,
            object: 'response',
            status: 'completed',
            model: frame.model,
            output: outputItems,
            usage: audit.providerUsage,
          },
        }));
        counters.succeededResponses += 1;
      });
    });

    return {
      close: () => {
        for (const sock of wsSockets) {
          try {
            sock.terminate();
          } catch {}
        }
        wsSockets.clear();
        try {
          wss.close();
        } catch {}
      },
    };
  }

  return {
    armAction,
    clearArmedActions,
    consumeArmedAction,
    resetProtocolState,
    sendAnthropicToolViolation,
    handleGeminiRequest,
    handleOpenAiWithOracle,
    attachResponsesWebSocket,
    getWsStats: () => ({ ...wsStats }),
  };
}
