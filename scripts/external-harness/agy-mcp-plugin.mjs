import { mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const RECEIPT = '.kiki-mcp-owner.json';
const pluginName = sessionId => {
  if (!/^[a-f0-9-]{36}$/i.test(sessionId)) throw Error('Invalid AGY MCP session ID');
  return `kiki-acp-${sessionId}`;
};
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
async function optional(path) {
  try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
async function removeOwned(path, state, expectedReceipt) {
  if (await optional(resolve(path, RECEIPT)) !== expectedReceipt) throw Error('AGY MCP ownership receipt changed; preserve the plugin for scoped recovery');
  const entries = await readdir(path);
  if (entries.some(name => name !== RECEIPT && !Object.hasOwn(state.files, name))) throw Error('AGY MCP plugin contains foreign files; preserve it for scoped recovery');
  for (const [name, expected] of Object.entries(state.files)) {
    const actual = await optional(resolve(path, name));
    if (actual !== undefined && actual !== expected) throw Error('Owned AGY MCP plugin changed; preserve it for scoped recovery');
  }
  for (const name of ['plugin.json', 'mcp_config.json']) {
    try { await unlink(resolve(path, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await unlink(resolve(path, RECEIPT));
  await rmdir(path);
}

export async function registerProjectMcpPlugin({ cwd, sessionId, nodePath, handlerPath, servers }) {
  const name = pluginName(sessionId);
  const path = resolve(cwd, '.agents', 'plugins', name);
  const env = {};
  const mcpServers = Object.fromEntries(servers.map((server, index) => {
    const key = `KIKI_AGY_MCP_${sessionId.replaceAll('-', '_')}_${index}`;
    env[key] = JSON.stringify(server);
    return [server.name, { command: nodePath, args: [handlerPath, '--mcp-stdio', key] }];
  }));
  if (Object.keys(mcpServers).length !== servers.length) throw Error('AGY session MCP server names must be unique');
  const state = { version: 1, sessionId, adapterPid: process.pid, nativePid: null, phase: 'prepared', nonce: randomUUID(), files: {
    'plugin.json': JSON.stringify({ name, description: 'Session-bound Kiki tool connection.' }, null, 2) + '\n',
    'mcp_config.json': JSON.stringify({ mcpServers }, null, 2) + '\n',
  } };
  await mkdir(resolve(cwd, '.agents', 'plugins'), { recursive: true });
  try { await mkdir(path); }
  catch (error) { if (error.code === 'EEXIST') throw Error('AGY MCP plugin path already exists; preserve the user files or recover the exact owned plugin first'); throw error; }
  let receipt = JSON.stringify(state);
  await writeFile(resolve(path, RECEIPT), receipt, { flag: 'wx' });
  try {
    await writeFile(resolve(path, 'mcp_config.json'), state.files['mcp_config.json'], { flag: 'wx' });
    await writeFile(resolve(path, 'plugin.json'), state.files['plugin.json'], { flag: 'wx' });
  } catch (error) {
    await removeOwned(path, state, receipt);
    throw error;
  }
  let closed = false;
  const update = async patch => {
    if (await optional(resolve(path, RECEIPT)) !== receipt) throw Error('AGY MCP ownership receipt changed before launch');
    Object.assign(state, patch);
    const next = JSON.stringify(state);
    const temp = resolve(path, `${RECEIPT}.${state.nonce}.tmp`);
    await writeFile(temp, next, { flag: 'wx' });
    try { await rename(temp, resolve(path, RECEIPT)); } catch (error) { await unlink(temp); throw error; }
    receipt = next;
  };
  return { name, path, env,
    beforeLaunch: () => update({ phase: 'launching' }),
    launched: pid => update({ phase: 'launched', nativePid: pid ?? null }),
    async close() {
      if (closed) return;
      await removeOwned(path, state, receipt);
      closed = true;
    },
  };
}

export async function recoverProjectMcpPlugin({ cwd, sessionId }) {
  const path = resolve(cwd, '.agents', 'plugins', pluginName(sessionId));
  const receipt = await optional(resolve(path, RECEIPT));
  if (receipt === undefined) return { status: 'no-owned-registration', path };
  const state = JSON.parse(receipt);
  if (state.version !== 1 || state.sessionId !== sessionId || !state.files ||
      Object.keys(state.files).sort().join(',') !== 'mcp_config.json,plugin.json') throw Error('Invalid AGY MCP ownership receipt; preserve the plugin');
  if (processAlive(state.adapterPid) || state.nativePid !== null && processAlive(state.nativePid)) return { status: 'owned-session-still-live', path };
  if (state.phase !== 'prepared' && (state.phase !== 'launched' || state.nativePid === null)) return { status: 'native-launch-identity-unconfirmed', path };
  await removeOwned(path, state, receipt);
  return { status: 'owned-registration-recovered', path };
}
