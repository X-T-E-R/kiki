import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [entry] = process.argv.slice(2);
const tools = new Map();
const sources = new Map();
const providers = new Map();
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
  shuttingDown = Promise.resolve().then(() => deactivate?.());
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
        dataDir: message.params?.dataDir, signal: lifetime.signal, updateSettings, onActivity, focusSession });
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
      return handlePanelRequest(message.params.action, message.params.args, { settings: message.params.settings ?? {} });
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
        media: {
          generate(input) { return callMedia(message.id, 'generate', input); },
          media(input) { return callMedia(message.id, 'media', input); },
        },
      });
    }).then((result) => prepareToolResult(message.id, result, controller.signal)).then(
      (result) => send({ id: message.id, result }),
      (error) => send({ id: message.id, error: { code: -32000, message: String(error) } }),
    ).finally(() => pending.delete(message.id));
  }
}
await shutdown();
