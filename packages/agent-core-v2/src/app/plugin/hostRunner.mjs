import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [entry] = process.argv.slice(2);
const tools = new Map();
const sources = new Map();
const providers = new Map();
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
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
console.log = (...args) => console.error(...args);

let started = false;
let installPrerequisite;
let handlePanelRequest;
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
function shutdown() {
  if (shuttingDown !== undefined) return shuttingDown;
  lifetime.abort();
  for (const controller of pending.values()) controller.abort();
  shuttingDown = Promise.resolve().then(async () => {
    await Promise.allSettled([...imConnections.keys()].map(stopImAdapter));
    for (const call of imEventCalls.values()) call.reject(new Error('IM adapter stopped'));
    imEventCalls.clear();
    await deactivate?.();
  });
  return shuttingDown;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void shutdown().finally(() => process.exit()); });
for await (const line of createInterface({ input: process.stdin })) {
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
      if (typeof plugin.register !== 'function') throw new Error('Plugin must export register(api)');
      installPrerequisite = plugin.installPrerequisite;
      handlePanelRequest = plugin.handlePanelRequest;
      activate = plugin.activate;
      deactivate = plugin.deactivate;
      await plugin.register({
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
    pending.get(message.params?.id)?.abort();
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
  if (message.method === 'im-adapter-event-result') {
    const call = imEventCalls.get(message.params?.callId);
    imEventCalls.delete(message.params?.callId);
    if (message.params?.error !== undefined) call?.reject(new Error(message.params.error));
    else call?.resolve();
    continue;
  }
  if (message.method === 'im-adapter-request') {
    const { adapterId, action, input, settings, instanceId, offset, messageLimits } = message.params ?? {};
    Promise.resolve().then(async () => {
      const registered = imAdapters.get(adapterId);
      if (registered === undefined) throw new Error('Unknown IM adapter');
      if (action === 'stop') return stopImAdapter(adapterId);
      if (action === 'start') {
        if (imConnections.has(adapterId)) throw new Error('IM adapter already connected');
        const controller = new AbortController();
        const connection = { ...registered, controller, started: false, context: { signal: controller.signal, settings: settings ?? {}, instanceId, messageLimits: Object.freeze({ ...messageLimits }) } };
        imConnections.set(adapterId, connection);
        try {
          const result = await registered.adapter.start({ ...connection.context, offset, emit: (event) => emitImEvent(adapterId, event, connection) });
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
  if (message.method === 'panel-request') {
    Promise.resolve().then(() => {
      if (typeof handlePanelRequest !== 'function') throw new Error('Plugin has no panel backend');
      return handlePanelRequest(message.params.action, message.params.args, { settings: message.params.settings ?? {}, kikiHome: message.params.kikiHome, workspaceId: message.params.workspaceId });
    }).then(
      (result) => send({ id: message.id, result }),
      (error) => send({ id: message.id, error: { code: -32000, message: String(error) } }),
    );
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
      });
    }).then((result) => prepareToolResult(message.id, result, controller.signal)).then(
      (result) => send({ id: message.id, result }),
      (error) => send({ id: message.id, error: { code: -32000, message: String(error) } }),
    ).finally(() => pending.delete(message.id));
  }
}
await shutdown();
