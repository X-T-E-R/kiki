import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';

const [entry] = process.argv.slice(2);
const tools = new Map();
let cordisSlots;
const sources = new Map();
const providers = new Map();
const asrProviders = new Map();
const harnessAccountSources = new Map();
const harnessQuotaSources = new Map();
const harnessAccountLeases = new Map();
const harnessAccountWork = new Set();
const wireString = (value) => typeof value === 'string' ? value : undefined;
async function releaseHarnessAccount(key) {
  const lease = harnessAccountLeases.get(key);
  if (lease === undefined) return;
  if (lease.releasing !== undefined) return lease.releasing;
  lease.releasing = Promise.resolve().then(() => lease.adapter.release({ leaseId: lease.leaseId }, {
    ...lease.context, signal: new AbortController().signal,
  })).finally(() => harnessAccountLeases.delete(key));
  return lease.releasing;
}
const imAdapters = new Map();
const imConnections = new Map();
const imEventCalls = new Map();
let nextImEvent = 0;
async function stopImAdapter(id) {
  const connection = imConnections.get(id);
  if (connection === undefined) return;
  imConnections.delete(id);
  connection.controller.abort();
  for (const [callId, call] of imEventCalls) if (call.adapterId === id) { imEventCalls.delete(callId); call.reject(new Error('IM adapter stopped')); }
  await connection.adapter.stop();
}
function emitImEvent(id, event, owner) {
  const connection = imConnections.get(id);
  if (connection !== owner || connection?.started !== true || !connection.definition.inbound || connection.controller.signal.aborted) return Promise.reject(new Error('IM connection is not receiving'));
  if (event.kind === 'message') {
    const work = (connection.inputQueue ?? Promise.resolve()).catch(() => undefined).then(() => transmitImEvent(id, event, owner));
    connection.inputQueue = work;
    return work;
  }
  return transmitImEvent(id, event, owner);
}
function reportImDiagnostic(id, diagnostic, owner) {
  const connection = imConnections.get(id);
  if (connection !== owner || connection?.started !== true || !connection.definition.inbound || connection.controller.signal.aborted) return Promise.reject(new Error('IM connection is not receiving'));
  if (Buffer.byteLength(JSON.stringify(diagnostic), 'utf8') > 1024) return Promise.reject(new Error('IM diagnostic exceeds the byte limit'));
  const callId = ++nextImEvent;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { imEventCalls.delete(callId); reject(new Error('IM diagnostic acknowledgement timed out')); }, 30_000);
    imEventCalls.set(callId, { adapterId: id, resolve: () => { clearTimeout(timer); resolve(); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    send({ method: 'im-adapter-report', params: { adapterId: id, connectionId: connection.id, callId, diagnostic } });
  });
}
function transmitImEvent(id, event, connection) {
  if (imConnections.get(id) !== connection || connection.controller.signal.aborted) throw new Error('IM connection is not receiving');
  const imCompleteLimits = connection.context.messageLimits;
  const wireMedia = (media) => media === undefined ? undefined : { name: media.name, mediaType: media.mediaType, base64: Buffer.from(media.bytes).toString('base64') };
  if (event.kind === 'message') {
    if (!Array.isArray(event.parts) || event.parts.length < 1 || event.parts.length > imCompleteLimits.parts) throw new Error('IM complete input has an invalid part count');
    if (event.parts.some((part) => part.tooLarge === true)) throw new Error('IM complete input contains a tooLarge part');
    const bytes = event.parts.map((part) => part.media?.bytes?.byteLength ?? 0);
    if (bytes.some((size) => size > connection.definition.maxInboundBytes) || bytes.reduce((sum, size) => sum + size, 0) > imCompleteLimits.mediaBytes) throw new Error('IM complete input exceeds the media byte limit');
    if (event.parts.reduce((sum, part) => sum + (part.text?.length ?? 0), 0) > imCompleteLimits.textChars) throw new Error('IM complete input exceeds the text limit');
  }
  const wireEvent = event.kind === 'message' ? { ...event, parts: event.parts.map((part) => ({ ...part, media: wireMedia(part.media) })) } : { ...event, media: wireMedia(event.media) };
  const serialized = event.kind === 'message' ? JSON.stringify(wireEvent) : undefined;
  if (serialized !== undefined && serialized.length > imCompleteLimits.serializedChars) throw new Error('IM complete input exceeds the serialized message limit');
  const callId = ++nextImEvent;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { imEventCalls.delete(callId); reject(new Error('IM input acknowledgement timed out')); }, 30_000);
    imEventCalls.set(callId, { adapterId: id, resolve: () => { clearTimeout(timer); resolve(); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    if (serialized === undefined) send({ method: 'im-adapter-event', params: { adapterId: id, callId, event: wireEvent } });
    else for (let offset = 0, index = 0; offset < serialized.length; offset += imCompleteLimits.chunkChars, index++) send({ method: 'im-adapter-message-chunk', params: { adapterId: id, callId, index, characters: serialized.length, data: serialized.slice(offset, offset + imCompleteLimits.chunkChars) } });
  });
}
const mediaCalls = new Map();
let nextMediaCall = 0;
const outputCalls = new Map();
let nextOutputCall = 0;
function callMedia(id, action, input) {
  const callId = ++nextMediaCall;
  return new Promise((resolve, reject) => {
    mediaCalls.set(callId, { resolve, reject });
    send({ method: 'media-call', params: { id, callId, action, input } });
  });
}
function outputRequest(id, action, input) {
  const callId = ++nextOutputCall;
  return new Promise((resolve, reject) => {
    outputCalls.set(callId, { resolve, reject });
    send({ method: 'output-request', params: { id, callId, action, input } });
  });
}
const modelCalls = new Map();
let nextModelCall = 0;
function modelError(code, message) {
  return Object.assign(new Error(message), { code });
}
function modelRpc(id, action, input, streamId) {
  const callId = ++nextModelCall;
  return new Promise((resolve, reject) => {
    modelCalls.set(callId, { resolve, reject });
    send({ method: 'model-call', params: { id, callId, action, input, streamId } });
  });
}
function modelContext(id, ownerSignal, canStream) {
  const call = (action, input) => {
    if (ownerSignal.aborted) return Promise.reject(modelError('request.cancelled', 'Plugin invocation has ended'));
    return modelRpc(id, action, input);
  };
  const models = { list: (options) => call('list', options?.candidates === undefined ? undefined : { candidates: [...options.candidates] }) };
  if (canStream) models.stream = async function* (input, options) {
    const signal = options?.signal === undefined ? ownerSignal : AbortSignal.any([ownerSignal, options.signal]);
    const check = () => { if (signal.aborted) throw modelError('request.cancelled', 'Model request cancelled'); };
    check();
    const { streamId } = await call('start', input);
    let finished = false;
    let closing;
    const close = () => closing ??= modelRpc(id, 'return', undefined, streamId).catch(() => undefined);
    signal.addEventListener('abort', close, { once: true });
    try {
      for (;;) {
        check();
        const frame = await modelRpc(id, 'next', undefined, streamId);
        check();
        if (frame.done) { finished = true; return; }
        yield frame.value;
      }
    } catch (error) {
      check();
      throw error;
    } finally {
      signal.removeEventListener('abort', close);
      if (!finished) await close();
    }
  };
  return { models, harnessQuota: { cached: () => call('harness-quota-cached') }, credentials: {
    status: (setting) => call('credential-status', { setting }),
    set: (setting, value) => call('credential-set', { setting, value }),
  } };
}
const OUTPUT_PREVIEW_CHARS = 50_000;
const IMAGE_PREVIEW_CHARS = 512 * 1024;
async function saveOutput(id, value, mimeType, signal, base64 = false) {
  const size = base64 ? Math.floor(value.length * 3 / 4) - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0) : Buffer.byteLength(value);
  await outputRequest(id, 'start', { size, mimeType });
  for (let offset = 0; offset < value.length;) {
    signal.throwIfAborted();
    let end = Math.min(value.length, offset + (base64 ? 64 * 1024 : 16 * 1024));
    if (!base64 && end < value.length && value.codePointAt(end - 1) > 0xffff) end -= 1;
    const chunk = value.slice(offset, end);
    await outputRequest(id, 'chunk', base64 ? chunk : Buffer.from(chunk).toString('base64'));
    offset = end;
  }
  signal.throwIfAborted();
  return outputRequest(id, 'end');
}
function outputNotice(saved) {
  return `Original plugin output saved at: ${JSON.stringify(saved.path)}\nAttachment reference: ${JSON.stringify(saved.reference)}; size: ${saved.size} bytes.\nPass the path to Read or ReadMediaFile to inspect the complete original.`;
}
function textPreview(value, saved) {
  const notice = outputNotice(saved);
  return `${value.slice(0, Math.max(0, OUTPUT_PREVIEW_CHARS - notice.length - 2))}\n\n${notice}`;
}
async function prepareToolResult(id, result, signal) {
  if (typeof result !== 'object' || result === null || !('output' in result) ||
    (result.isError !== undefined && typeof result.isError !== 'boolean')) throw new Error('Plugin returned an invalid tool result');
  let output = result.output;
  let truncated;
  if (typeof output === 'string') {
    if (output.length > OUTPUT_PREVIEW_CHARS) {
      const saved = await saveOutput(id, output, 'text/plain', signal);
      output = textPreview(output, saved);
      truncated = true;
    }
  } else if (Array.isArray(output)) {
    const imageChars = output.reduce((sum, part) => sum + (part?.type === 'image_url' && typeof part.imageUrl?.url === 'string' ? part.imageUrl.url.length : 0), 0);
    const parts = [];
    for (const part of output) {
      signal.throwIfAborted();
      if (!(part?.type === 'text' && typeof part.text === 'string') &&
        !(part?.type === 'image_url' && typeof part.imageUrl?.url === 'string' && /^data:image\/(?:png|jpeg|webp);base64,/.test(part.imageUrl.url))) throw new Error('Plugin returned an invalid tool result');
      if (part.type === 'image_url' && imageChars > IMAGE_PREVIEW_CHARS) {
        const url = part.imageUrl.url;
        const match = /^data:(image\/(?:png|jpeg|webp));base64,/.exec(url);
        if (match === null) throw new Error('Plugin returned an invalid tool result image URL');
        const saved = await saveOutput(id, url.slice(match[0].length), match[1], signal, true);
        parts.push({ type: 'text', text: outputNotice(saved) }, { type: 'image_url', imageUrl: { url: saved.reference } });
      } else if (part?.type === 'text' && typeof part.text === 'string' && part.text.length > OUTPUT_PREVIEW_CHARS) {
        const saved = await saveOutput(id, part.text, 'text/plain', signal);
        parts.push({ type: 'text', text: textPreview(part.text, saved) });
        truncated = true;
      } else parts.push(part);
    }
    output = parts;
    const serialized = JSON.stringify(parts.filter((part) => part.type === 'text'));
    if (serialized.length > 2 * OUTPUT_PREVIEW_CHARS) {
      const saved = await saveOutput(id, serialized, 'application/json', signal);
      output = [{ type: 'text', text: outputNotice(saved) }, ...parts.filter((part) => part.type === 'image_url')];
      truncated = true;
    }
  } else throw new Error('Plugin returned an invalid tool result');
  return { output, isError: result.isError, truncated };
}
const pending = new Map();
const rpcWrite = process.stdout.write.bind(process.stdout);
const send = (message) => rpcWrite(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
process.stdout.write = (chunk, encoding, callback) => process.stderr.write(chunk, encoding, callback);
for (const method of ['log', 'info', 'debug', 'warn']) console[method] = (...args) => console.error(...args);

let started = false;
let installPrerequisite;
let handlePanelRequest;
let handleRouteRequest;
let activate;
let deactivate;
const lifetime = new AbortController();
const settingsCalls = new Map();
let nextSettingsCall = 0;
let shuttingDown;
let latestActivity = [];
const activityListeners = new Set();
const focusCalls = new Map();
let nextFocusCall = 0;
const imCalls = new Map();
let nextImCall = 0;
function imRpc(method, params, signal) {
  const current = signal ?? new AbortController().signal;
  if (current.aborted) {
    if (method === 'im-send') return Promise.resolve({ status: 'cancelled', retryable: false, diagnosticCode: 'cancelled' });
    return Promise.reject(new Error('cancelled'));
  }
  const callId = ++nextImCall;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { imCalls.delete(callId); reject(new Error('IM bridge timed out')); }, 20_000);
    const finish = (settle, value) => { clearTimeout(timer); current.removeEventListener('abort', onAbort); settle(value); };
    const onAbort = () => { send({ method: 'im-cancel', params: { callId } }); };
    current.addEventListener('abort', onAbort, { once: true });
    imCalls.set(callId, { resolve: (value) => finish(resolve, value), reject: (error) => finish(reject, error) });
    send({ method, params: { callId, ...params } });
  });
}
const im = {
  capabilities(signal) { return imRpc('im-capabilities', {}, signal); },
  listRoutes(signal) { return imRpc('im-list-routes', {}, signal); },
  send(request, signal) { return imRpc('im-send', { request }, signal); },
};
function onActivity(listener) { activityListeners.add(listener); listener(latestActivity); return () => activityListeners.delete(listener); }
function focusSession(sessionId) {
  const callId = ++nextFocusCall;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { focusCalls.delete(callId); reject(new Error('Session navigation timed out')); }, 5000);
    focusCalls.set(callId, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    send({ method: 'app-focus-session', params: { callId, sessionId } });
  });
}
function updateSettings(values) {
  const callId = ++nextSettingsCall;
  return new Promise((resolve, reject) => {
    settingsCalls.set(callId, { resolve, reject });
    send({ method: 'settings-update', params: { callId, values } });
  });
}
let openPanelStream;
let panelServer;
let panelServerReady;
const panelTokens = new Map();
const panelStreams = new Set();
const panelCalls = new Map();
const panelSockets = new Set();
const PANEL_FRAME_LIMIT = 16 * 1024 * 1024;

function listenPanelStreams() {
  return panelServerReady ??= new Promise((resolve, reject) => {
    panelServer = createServer((socket) => {
      socket.setNoDelay(true);
      panelSockets.add(socket);
      const token = Buffer.allocUnsafe(32);
      let received = 0;
      const timer = setTimeout(() => socket.destroy(), 10_000);
      timer.unref();
      socket.on('error', () => socket.destroy());
      socket.once('close', () => { clearTimeout(timer); panelSockets.delete(socket); });
      const authenticate = (chunk) => {
        const bytes = Math.min(32 - received, chunk.length);
        chunk.copy(token, received, 0, bytes);
        received += bytes;
        if (received !== 32) return;
        clearTimeout(timer);
        socket.off('data', authenticate);
        const key = token.toString('hex');
        const stream = panelTokens.get(key);
        if (stream === undefined) { socket.destroy(); return; }
        panelTokens.delete(key);
        stream.connect(socket);
        if (chunk.length > bytes) stream.receive(chunk.subarray(bytes));
      };
      socket.on('data', authenticate);
    });
    panelServer.once('error', reject);
    panelServer.listen(0, '127.0.0.1', () => { panelServer.unref(); resolve(panelServer.address().port); });
  });
}

async function openPanelChannel(message) {
  if (typeof openPanelStream !== 'function' || shuttingDown !== undefined) throw new Error('Plugin has no panel stream backend');
  const { panelId, stream, args, settings, kikiHome, workspaceId, sessionId } = message.params;
  if (typeof stream !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(stream)) throw new Error('Invalid panel stream name');
  const token = randomBytes(32).toString('hex');
  const controller = new AbortController();
  const binary = new Set();
  const text = new Set();
  const closed = new Set();
  let socket;
  let ended = false;
  let reason;
  let queuedBytes = 0;
  const queued = [];
  const finish = (why) => {
    if (ended) return;
    ended = true; reason = why;
    controller.abort();
    for (const listener of closed) listener(why);
    binary.clear(); text.clear(); closed.clear();
  };
  const dispose = (why) => {
    finish(why);
    clearTimeout(timer);
    panelTokens.delete(token);
    panelStreams.delete(channel);
    panelCalls.delete(message.id);
    queued.length = 0; queuedBytes = 0;
    socket?.destroy();
  };
  const write = (opcode, payload) => {
    if (ended) return false;
    if (payload.length > PANEL_FRAME_LIMIT || (socket === undefined ? queuedBytes + payload.length + 5 > 4 * 1024 * 1024 : socket.writableLength + payload.length + 5 > PANEL_FRAME_LIMIT + 5)) {
      dispose('Plugin stream buffer limit exceeded');
      return false;
    }
    const header = Buffer.allocUnsafe(5);
    header[0] = opcode; header.writeUInt32BE(payload.length, 1);
    if (socket === undefined) {
      queued.push(header, Buffer.from(payload));
      queuedBytes += header.length + payload.length;
      return true;
    }
    socket.cork(); socket.write(header);
    const writable = socket.write(payload);
    socket.uncork();
    return writable;
  };
  const close = (why) => {
    if (ended) return;
    write(8, Buffer.from(why ?? ''));
    finish(why);
    if (socket !== undefined) socket.end();
  };
  const header = Buffer.allocUnsafe(5);
  let headerBytes = 0;
  let payload;
  let payloadBytes = 0;
  let length = 0;
  const channel = {
    dispose,
    connect(connection) {
      socket = connection;
      clearTimeout(timer);
      socket.on('error', (error) => dispose(error.message));
      socket.on('close', () => dispose());
      socket.on('data', (chunk) => {
        try { channel.receive(chunk); } catch (error) { dispose(String(error)); }
      });
      for (const chunk of queued) socket.write(chunk);
      queued.length = 0; queuedBytes = 0;
      if (ended) socket.end();
    },
    receive(chunk) {
      let offset = 0;
      while (offset < chunk.length && !ended) {
        if (headerBytes < 5) {
          const bytes = Math.min(5 - headerBytes, chunk.length - offset);
          chunk.copy(header, headerBytes, offset, offset + bytes);
          headerBytes += bytes; offset += bytes;
          if (headerBytes !== 5) return;
          length = header.readUInt32BE(1);
          if (length > PANEL_FRAME_LIMIT || ![1, 2, 8].includes(header[0])) { dispose('Invalid plugin stream frame'); return; }
        }
        const bytes = Math.min(length - payloadBytes, chunk.length - offset);
        let frame;
        if (payload === undefined && bytes === length) frame = chunk.subarray(offset, offset + bytes);
        else {
          payload ??= Buffer.allocUnsafe(length);
          chunk.copy(payload, payloadBytes, offset, offset + bytes);
          payloadBytes += bytes;
          if (payloadBytes !== length) return;
          frame = payload;
        }
        offset += bytes;
        const opcode = header[0];
        headerBytes = 0; payloadBytes = 0; payload = undefined;
        if (opcode === 8) close(frame.toString('utf8'));
        else if (opcode === 1) { for (const listener of text) listener(frame.toString('utf8')); }
        else { for (const listener of binary) listener(frame); }
      }
    },
  };
  const timer = setTimeout(() => dispose('Plugin stream connect timed out'), 10_000);
  timer.unref();
  panelTokens.set(token, channel);
  panelStreams.add(channel);
  panelCalls.set(message.id, channel);
  pending.set(message.id, controller);
  const handle = {
    sendBinary: (chunk) => write(2, chunk instanceof ArrayBuffer ? Buffer.from(chunk) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
    sendText: (value) => write(1, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))),
    close,
    onBinary: (fn) => { binary.add(fn); return () => binary.delete(fn); },
    onText: (fn) => { text.add(fn); return () => text.delete(fn); },
    onClose: (fn) => { if (ended) fn(reason); else closed.add(fn); return () => closed.delete(fn); },
    signal: controller.signal,
    bufferedAmount: () => queuedBytes + (socket?.writableLength ?? 0),
  };
  controller.signal.addEventListener('abort', () => { if (!ended) dispose('Plugin stream cancelled'); }, { once: true });
  try {
    const port = await listenPanelStreams();
    controller.signal.throwIfAborted();
    const context = { panelId, sessionId, workspaceId, settings: settings ?? {}, kikiHome, ...modelContext(message.id, controller.signal, false), signal: controller.signal };
    const opened = await openPanelStream(stream, args, handle, context);
    const handlers = opened !== null && typeof opened === 'object' && ['onBinary', 'onText', 'onClose'].some((key) => typeof opened[key] === 'function');
    if (handlers) {
      if (typeof opened.onBinary === 'function') handle.onBinary((chunk) => opened.onBinary(chunk));
      if (typeof opened.onText === 'function') handle.onText((value) => opened.onText(value));
      if (typeof opened.onClose === 'function') handle.onClose((why) => opened.onClose(why));
    }
    if (!panelStreams.has(channel)) throw new Error(reason ?? 'Plugin stream closed during open');
    return { result: handlers ? opened.result : opened, port, token };
  } catch (error) { dispose(String(error)); throw error; }
  finally { pending.delete(message.id); }
}

function shutdown() {
  if (shuttingDown !== undefined) return shuttingDown;
  lifetime.abort();
  for (const stream of panelStreams) stream.dispose('Plugin host stopped');
  for (const socket of panelSockets) socket.destroy();
  panelServer?.close();
  for (const controller of pending.values()) controller.abort();
  shuttingDown = Promise.resolve().then(async () => {
    await Promise.allSettled([...harnessAccountWork, ...[...harnessAccountLeases.keys()].map(releaseHarnessAccount)]);
    await Promise.allSettled([...imConnections.keys()].map(stopImAdapter));
    for (const call of imEventCalls.values()) call.reject(new Error('IM adapter stopped'));
    imEventCalls.clear();
    await deactivate?.();
  });
  return shuttingDown;
}
function stopWithOwner() {
  const timer = setTimeout(() => process.exit(), 1000);
  timer.unref();
  void shutdown().finally(() => process.exit());
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stopWithOwner);
const input = createInterface({ input: process.stdin });
input.once('close', stopWithOwner);
for await (const line of input) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (message.method === 'handshake') {
    if (message.params?.version !== 1 || started) {
      send({ id: message.id, error: { code: -32602, message: 'Unsupported plugin RPC protocol version' } });
      continue;
    }
    started = true;
    send({ id: message.id, result: { version: 1 } });
    try {
      const plugin = await import(pathToFileURL(entry).href);
      cordisSlots = plugin.slots ?? plugin.default?.slots;
      handleRouteRequest = plugin.handleRouteRequest ?? plugin.default?.handleRouteRequest;
      openPanelStream = plugin.openPanelStream ?? plugin.default?.openPanelStream;
      if (typeof plugin.register !== 'function' && (typeof cordisSlots !== 'object' || cordisSlots === null) && typeof handleRouteRequest !== 'function' && typeof openPanelStream !== 'function') throw new Error('Plugin must export register(api) or a slots map');
      installPrerequisite = plugin.installPrerequisite;
      handlePanelRequest = plugin.handlePanelRequest;
      activate = plugin.activate;
      deactivate = plugin.deactivate;
      if (typeof plugin.register === 'function') await plugin.register({
        registerPanelStream(fn) {
          if (typeof fn !== 'function' || openPanelStream !== undefined) throw new Error('Invalid or duplicate panel stream backend');
          openPanelStream = fn;
        },
        registerTool(definition, execute) {
          if (typeof execute !== 'function' || typeof definition?.name !== 'string' || tools.has(definition.name)) {
            throw new Error('Invalid or duplicate plugin tool');
          }
          tools.set(definition.name, execute);
          send({ method: 'register', params: { version: 1, tool: definition } });
        },
        registerSessionSource(definition, adapter) {
          if (typeof definition?.id !== 'string' || sources.has(definition.id) ||
              ['discover', 'probe', 'parse'].some((name) => typeof adapter?.[name] !== 'function')) {
            throw new Error('Invalid or duplicate session source');
          }
          sources.set(definition.id, adapter);
          send({ method: 'register-source', params: { version: 1, definition } });
        },
        registerMediaProvider(definition, adapter) {
          if (typeof definition?.id !== 'string' || providers.has(definition.id) ||
            typeof adapter?.describe !== 'function' || typeof adapter?.submit !== 'function') throw new Error('Invalid or duplicate media provider');
          providers.set(definition.id, adapter);
          send({ method: 'register-media-provider', params: { version: 1, definition } });
        },
        registerAsrProvider(definition, adapter) {
          const id = typeof definition === 'string' ? definition : definition?.id;
          if (typeof id !== 'string' || asrProviders.has(id) || typeof adapter?.transcribe !== 'function') throw new Error('Invalid or duplicate ASR provider');
          asrProviders.set(id, adapter);
          send({ method: 'register-asr-provider', params: { version: 1, definition } });
        },
        registerHarnessAccountSource(definition, adapter) {
          if (typeof definition?.id !== 'string' || harnessAccountSources.has(definition.id) ||
              ['list', 'prepare', 'release'].some((name) => typeof adapter?.[name] !== 'function')) throw new Error('Invalid or duplicate harness account source');
          harnessAccountSources.set(definition.id, adapter);
          send({ method: 'register-harness-account-source', params: { version: 1, definition } });
        },
        registerHarnessQuotaSource(definition, adapter) {
          if (typeof definition?.id !== 'string' || harnessQuotaSources.has(definition.id) || typeof adapter?.read !== 'function') throw new Error('Invalid or duplicate harness quota source');
          harnessQuotaSources.set(definition.id, adapter);
          send({ method: 'register-harness-quota-source', params: { version: 1, definition } });
        },
        registerImAdapter(definition, adapter) {
          if (typeof definition?.id !== 'string' || imAdapters.has(definition.id) || typeof adapter?.start !== 'function' || typeof adapter?.stop !== 'function' || (definition.outbound && typeof adapter?.sendText !== 'function') || (definition.supportsEdit && typeof adapter?.editText !== 'function') || (definition.mediaCapabilities?.length && typeof adapter?.sendMedia !== 'function')) throw new Error('Invalid or duplicate IM adapter');
          imAdapters.set(definition.id, { adapter, definition });
          send({ method: 'register-im-adapter', params: { version: 1, definition } });
        },
      });
    } catch (error) {
      send({ method: 'register-error', params: { message: String(error) } });
      process.exitCode = 1;
      break;
    }
    send({ method: 'ready', params: { version: 1 } });
    continue;
  }
  if (message.method === 'cordis-slot') {
    const { pluginId, generation, attemptId, conversationRevision, payload, settings, ...context } = message.params ?? {};
    const startedAt = performance.now();
    const identity = () => ({ pluginId, generation, attemptId, conversationRevision, durationMs: performance.now() - startedAt });
    void Promise.resolve().then(async () => {
      if (typeof pluginId !== 'string' || !Number.isSafeInteger(generation) || generation < 1 ||
        (attemptId !== undefined && typeof attemptId !== 'string') ||
        (conversationRevision !== undefined && (!Number.isSafeInteger(conversationRevision) || conversationRevision < 0))) throw new Error('Invalid plugin invocation identity');
      const slotHandler = cordisSlots && Object.hasOwn(cordisSlots, context.slot) ? cordisSlots[context.slot] : undefined;
      const handler = typeof slotHandler === 'function'
        ? slotHandler
        : context.slot === 'E12:server-gui-slots' && typeof handleRouteRequest === 'function' && payload?.kind === 'http-route'
          ? handleRouteRequest
          : undefined;
      if (typeof handler !== 'function') throw new Error('Plugin did not register the requested slot');
      const value = await handler(payload, { ...context, pluginId, generation, attemptId, conversationRevision, settings });
      const result = { ...identity(), ok: true, value };
      if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024 * 1024 - 1024) throw new Error('Plugin slot response exceeds RPC limit');
      send({ id: message.id, result });
    }).catch(error => send({ id: message.id, result: { ...identity(), ok: false, message: String(error).slice(0, 1024) } }));
    continue;
  }
  if (message.method === 'settings-result') {
    const call = settingsCalls.get(message.params?.callId);
    settingsCalls.delete(message.params?.callId);
    if (message.params?.error !== undefined) call?.reject(new Error(message.params.error));
    else call?.resolve(message.params?.result);
    continue;
  }
  if (message.method === 'app-activity') {
    latestActivity = Array.isArray(message.params?.activity) ? message.params.activity : [];
    for (const listener of activityListeners) { try { listener(latestActivity); } catch {} }
    continue;
  }
  if (message.method === 'im-result') {
    const call = imCalls.get(message.params?.callId);
    imCalls.delete(message.params?.callId);
    if (message.params?.error !== undefined) call?.reject(new Error(message.params.error === 'cancelled' ? 'cancelled' : 'IM bridge failed'));
    else call?.resolve(message.params?.result);
    continue;
  }
  if (message.method === 'app-focus-result') {
    const call = focusCalls.get(message.params?.callId);
    focusCalls.delete(message.params?.callId);
    if (message.params?.error !== undefined) call?.reject(new Error(message.params.error));
    else call?.resolve(message.params?.result);
    continue;
  }
  if (message.method === 'activate') {
    Promise.resolve().then(() => {
      if (typeof activate !== 'function') throw new Error('App plugin must export activate(context)');
      return activate({ settings: message.params?.settings ?? {}, userHome: message.params?.userHome,
        dataDir: message.params?.dataDir, signal: lifetime.signal, updateSettings, onActivity, focusSession, im });
    }).then((result) => send({ id: message.id, result }),
      (error) => send({ id: message.id, error: { code: -32000, message: String(error) } }));
    continue;
  }
  if (message.method === 'shutdown') {
    void shutdown().then(() => send({ id: message.id, result: true }),
      () => send({ id: message.id, error: { code: -32000, message: 'Plugin shutdown failed' } })).finally(() => process.exit());
    continue;
  }
  if (message.method === 'cancel') {
    const id = message.params?.id;
    pending.get(id)?.abort();
    panelCalls.get(id)?.dispose('Plugin stream cancelled');
    void releaseHarnessAccount(id).catch(() => undefined);
    continue;
  }
  if (message.method === 'harness-account-request') {
    const { sourceId, action, input, settings, kikiHome } = message.params ?? {};
    const controller = new AbortController();
    pending.set(message.id, controller);
    const context = { settings, kikiHome, signal: controller.signal };
    const adapter = shuttingDown === undefined ? harnessAccountSources.get(sourceId) : undefined;
    const work = Promise.resolve().then(async () => {
      if (adapter === undefined || !['list', 'prepare'].includes(action)) throw new Error('Unsupported harness account source action');
      controller.signal.throwIfAborted();
      if (action === 'list') {
        const accounts = await adapter.list(input, context);
        return Array.isArray(accounts) ? accounts.map((account) => ({
          id: wireString(account?.id), label: wireString(account?.label), status: wireString(account?.status),
        })) : null;
      }
      const prepared = await adapter.prepare(input, context);
      if (typeof prepared?.leaseId !== 'string' || prepared.leaseId.length === 0) return null;
      harnessAccountLeases.set(message.id, { adapter, leaseId: prepared.leaseId, context });
      controller.signal.throwIfAborted();
      const connection = prepared.connection;
      return {
        protocol: wireString(connection?.protocol), baseUrl: wireString(connection?.baseUrl), apiKey: wireString(connection?.apiKey),
        modelIds: Array.isArray(connection?.modelIds) ? connection.modelIds.map(wireString) : undefined,
      };
    }).then(
      (result) => send({ id: message.id, result }),
      async (error) => {
        if (action === 'prepare') await releaseHarnessAccount(message.id).catch(() => undefined);
        send({ id: message.id, error: { code: -32000, message: String(error) } });
      },
    ).finally(() => {
      pending.delete(message.id);
      harnessAccountWork.delete(work);
    });
    if (action === 'prepare') harnessAccountWork.add(work);
    continue;
  }
  if (message.method === 'harness-quota-request') {
    const { sourceId, settings, kikiHome } = message.params ?? {};
    const controller = new AbortController();
    pending.set(message.id, controller);
    const adapter = shuttingDown === undefined ? harnessQuotaSources.get(sourceId) : undefined;
    void Promise.resolve().then(async () => {
      if (adapter === undefined) throw new Error('Unsupported harness quota source');
      controller.signal.throwIfAborted();
      const batch = await adapter.read({ settings: settings ?? {}, signal: controller.signal, kikiHome: kikiHome ?? '' });
      return Array.isArray(batch) ? batch : batch?.readings;
    }).then(
      (result) => send({ id: message.id, result }),
      (error) => send({ id: message.id, error: { code: -32000, message: String(error) } }),
    ).finally(() => pending.delete(message.id));
    continue;
  }
  if (message.method === 'harness-account-release') {
    void releaseHarnessAccount(message.params?.prepareId).then(
      () => send({ id: message.id, result: true }),
      () => send({ id: message.id, error: { code: -32000, message: 'The adapter could not release the selected account.' } }),
    );
    continue;
  }
  if (message.method === 'model-result') {
    const call = modelCalls.get(message.params?.callId);
    modelCalls.delete(message.params?.callId);
    const error = message.params?.error;
    if (error !== undefined) call?.reject(modelError(error.code, error.message));
    else call?.resolve(message.params?.result);
    continue;
  }
  if (message.method === 'output-result') {
    const call = outputCalls.get(message.params?.callId);
    outputCalls.delete(message.params?.callId);
    if (message.params?.error !== undefined) call?.reject(new Error(message.params.error));
    else call?.resolve(message.params?.result);
    continue;
  }
  if (message.method === 'media-result') {
    const call = mediaCalls.get(message.params?.callId);
    mediaCalls.delete(message.params?.callId);
    if (message.params?.error !== undefined) call?.reject(new Error(message.params.error));
    else call?.resolve(message.params?.result);
    continue;
  }
  if (message.method === 'im-adapter-event-result' || message.method === 'im-adapter-report-result') {
    const call = imEventCalls.get(message.params?.callId);
    imEventCalls.delete(message.params?.callId);
    if (message.params?.error !== undefined) call?.reject(new Error(message.params.error));
    else call?.resolve();
    continue;
  }
  if (message.method === 'im-adapter-request') {
    const { adapterId, action, input, settings, instanceId, offset, messageLimits, connectionId } = message.params ?? {};
    Promise.resolve().then(async () => {
      const registered = imAdapters.get(adapterId);
      if (registered === undefined) throw new Error('Unknown IM adapter');
      if (action === 'stop') return stopImAdapter(adapterId);
      if (action === 'start') {
        if (imConnections.has(adapterId)) throw new Error('IM adapter already connected');
        const controller = new AbortController();
        const connection = { ...registered, id: connectionId, controller, started: false, context: { signal: controller.signal, settings: settings ?? {}, instanceId, messageLimits: Object.freeze({ ...messageLimits }) } };
        imConnections.set(adapterId, connection);
        try {
          const result = await registered.adapter.start({ ...connection.context, offset, emit: (event) => emitImEvent(adapterId, event, connection), report: (diagnostic) => reportImDiagnostic(adapterId, diagnostic, connection) });
          connection.started = true;
          return result;
        } catch (error) { await stopImAdapter(adapterId); throw error; }
      }
      const connection = imConnections.get(adapterId);
      if (connection?.started !== true || connection.controller.signal.aborted) throw new Error('IM adapter is not connected');
      if (action === 'readHistory') {
        if (!connection.definition.inbound || connection.definition.supportsHistory !== true || typeof connection.adapter.readHistory !== 'function') return { status: 'unsupported' };
        return connection.adapter.readHistory(input, connection.context);
      }
      if (!connection.definition.outbound || !['sendText', 'sendMedia', 'editText', 'answerCallback'].includes(action) || typeof connection.adapter[action] !== 'function') throw new Error('IM action unsupported');
      const value = action === 'sendMedia' ? { ...input, bytes: new Uint8Array(Buffer.from(input.base64, 'base64')), base64: undefined } : input;
      return connection.adapter[action](value, connection.context);
    }).then((result) => send({ id: message.id, result }), (error) => send({ id: message.id, error: { code: -32000, message: String(error) } }));
    continue;
  }
  if (message.method === 'media-provider-request') {
    const controller = new AbortController();
    pending.set(message.id, controller);
    Promise.resolve().then(() => {
      const adapter = providers.get(message.params?.providerId);
      const action = message.params?.action;
      if (adapter === undefined || !['describe', 'submit', 'poll', 'cancel', 'voices'].includes(action) || typeof adapter[action] !== 'function') throw new Error('Unsupported media provider action');
      return adapter[action](message.params.input, {
        signal: controller.signal, settings: message.params.settings ?? {},
        jobId: message.params.jobId, stagingDir: message.params.stagingDir,
        connection() { return callMedia(message.id, 'connection'); },
        progress(update) { send({ method: 'progress', params: { id: message.id, update } }); },
      });
    }).then(
      (result) => send({ id: message.id, result }),
      (error) => send({ id: message.id, error: { code: -32000, message: String(error) } }),
    ).finally(() => pending.delete(message.id));
    continue;
  }
  if (message.method === 'asr-provider-request') {
    const controller = new AbortController();
    pending.set(message.id, controller);
    Promise.resolve().then(() => {
      const adapter = asrProviders.get(message.params?.providerId);
      if (adapter === undefined) throw new Error('Unsupported ASR provider');
      return adapter.transcribe(message.params.input, {
        signal: controller.signal, settings: message.params.settings ?? {},
        connection() { return callMedia(message.id, 'connection'); },
      });
    }).then(
      (result) => send({ id: message.id, result }),
      (error) => send({ id: message.id, error: { code: -32000, message: String(error) } }),
    ).finally(() => pending.delete(message.id));
    continue;
  }
  if (message.method === 'install-prerequisite') {
    Promise.resolve().then(() => {
      if (typeof installPrerequisite !== 'function' || message.params?.consent !== true ||
        typeof message.params.destination !== 'string' || !path.isAbsolute(message.params.destination)) {
        throw new Error('The plugin does not support a consented prerequisite installer');
      }
      return installPrerequisite({ consent: true, destination: message.params.destination });
    }).then(
      (result) => send({ id: message.id, result }),
      (error) => send({ id: message.id, error: { code: -32000, message: String(error) } }),
    );
    continue;
  }
  if (message.method === 'panel-stream-open') {
    void openPanelChannel(message).then((result) => send({ id: message.id, result }),
      (error) => send({ id: message.id, error: { code: -32000, message: String(error) } }));
    continue;
  }
  if (message.method === 'panel-request') {
    const controller = new AbortController();
    pending.set(message.id, controller);
    Promise.resolve().then(() => {
      if (typeof handlePanelRequest !== 'function') throw new Error('Plugin has no panel backend');
      return handlePanelRequest(message.params.action, message.params.args, { settings: message.params.settings ?? {}, kikiHome: message.params.kikiHome, workspaceId: message.params.workspaceId, ...modelContext(message.id, controller.signal, false), signal: controller.signal });
    }).then(
      (result) => send({ id: message.id, result }),
      (error) => send({ id: message.id, error: { code: -32000, message: String(error) } }),
    ).finally(() => pending.delete(message.id));
    continue;
  }
  if (message.method === 'source-request') {
    const controller = new AbortController();
    pending.set(message.id, controller);
    Promise.resolve().then(() => {
      const adapter = sources.get(message.params?.sourceId);
      const action = message.params?.action;
      if (adapter === undefined || !['discover', 'probe', 'parse'].includes(action)) throw new Error('Unregistered source action');
      return adapter[action](message.params.args, { signal: controller.signal, settings: message.params.settings ?? {} });
    }).then(
      (result) => send({ id: message.id, result }),
      (error) => send({ id: message.id, error: { code: -32000, message: String(error) } }),
    ).finally(() => pending.delete(message.id));
    continue;
  }
  if (message.method === 'execute') {
    const controller = new AbortController();
    pending.set(message.id, controller);
    const executor = tools.get(message.params?.name);
    Promise.resolve().then(() => {
      if (executor === undefined) throw new Error(`Unregistered tool: ${message.params?.name}`);
      return executor(message.params.args, {
        signal: controller.signal,
        progress(update) { send({ method: 'progress', params: { id: message.id, update } }); },
        settings: message.params.settings ?? {},
        workspaceRoot: message.params.workspaceRoot,
        approvedPaths: message.params.approvedPaths ?? [],
        imageIn: message.params.imageIn === true,
        workspaceId: message.params.workspaceId,
        kikiHome: message.params.kikiHome,
        media: {
          generate(input) { return callMedia(message.id, 'generate', input); },
          media(input) { return callMedia(message.id, 'media', input); },
        },
        messages: { send(input) { return callMedia(message.id, 'message-send', input); } },
        ...modelContext(message.id, controller.signal, true),
      });
    }).then((result) => prepareToolResult(message.id, result, controller.signal)).then(
      (result) => send({ id: message.id, result }),
      (error) => send({ id: message.id, error: { code: -32000, message: String(error) } }),
    ).finally(() => pending.delete(message.id));
  }
}
await shutdown();
