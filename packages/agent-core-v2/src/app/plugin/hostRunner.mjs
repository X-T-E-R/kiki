import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [entry] = process.argv.slice(2);
const tools = new Map();
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
      });
    }).then(
      (result) => send({ id: message.id, result }),
      (error) => send({ id: message.id, error: { code: -32000, message: String(error) } }),
    ).finally(() => pending.delete(message.id));
  }
}
