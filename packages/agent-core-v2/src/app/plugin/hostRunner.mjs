import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [entry] = process.argv.slice(2);
const tools = new Map();
const sources = new Map();
const providers = new Map();
const mediaCalls = new Map();
let nextMediaCall = 0;
function callMedia(id, action, input) {
  const callId = ++nextMediaCall;
  return new Promise((resolve, reject) => {
    mediaCalls.set(callId, { resolve, reject });
    send({ method: 'media-call', params: { id, callId, action, input } });
  });
}
const pending = new Map();
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
console.log = (...args) => console.error(...args);

let started = false;
let installPrerequisite;
let handlePanelRequest;
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
  if (message.method === 'cancel') {
    pending.get(message.params?.id)?.abort();
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
    }).then(
      (result) => send({ id: message.id, result }),
      (error) => send({ id: message.id, error: { code: -32000, message: String(error) } }),
    ).finally(() => pending.delete(message.id));
  }
}
