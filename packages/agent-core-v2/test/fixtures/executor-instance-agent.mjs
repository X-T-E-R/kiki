import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { request } from 'node:http';
import { SocksClient } from 'socks';

if (process.argv.includes('--version')) {
  const proxy = process.env.HTTP_PROXY ? new URL(process.env.HTTP_PROXY) : undefined;
  const diagnostic = proxy?.username ? ` ${[proxy.href, proxy.username, proxy.password, decodeURIComponent(proxy.username), decodeURIComponent(proxy.password)].join(' ')}` : '';
  process.stdout.write(`instance-fixture 1.0.0${diagnostic}\n`);
  process.exit(0);
}
if (process.argv.includes('models')) {
  process.stdout.write('fixture-model\n');
  process.exit(0);
}
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const account = JSON.parse(await readFile(join(process.env.INSTANCE_HOME, 'account.json'), 'utf8'));
const sessions = new Set();
const target = new URL(account.endpoint);
async function outbound(sessionId) {
  const proxy = process.env.HTTP_PROXY || process.env.http_proxy;
  const proxyUrl = proxy ? new URL(proxy) : undefined;
  let socket;
  if (proxyUrl?.protocol.startsWith('socks')) {
    ({ socket } = await SocksClient.createConnection({
      proxy: { host: proxyUrl.hostname, port: Number(proxyUrl.port), type: 5,
        userId: decodeURIComponent(proxyUrl.username), password: decodeURIComponent(proxyUrl.password) },
      command: 'connect', destination: { host: target.hostname, port: Number(target.port) || 80 }, timeout: 5000,
    }));
  }
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: proxyUrl && !socket ? proxyUrl.hostname : target.hostname,
      port: proxyUrl && !socket ? Number(proxyUrl.port) : Number(target.port) || 80,
      path: proxyUrl && !socket ? target.href : target.pathname,
      method: 'POST', agent: socket ? undefined : false,
      createConnection: socket ? () => socket : undefined,
      headers: { 'x-fixture-account': account.id, 'x-fixture-session': sessionId,
        authorization: `Bearer ${account.key}`,
        'proxy-authorization': proxyUrl?.username ? `Basic ${Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString('base64')}` : '' },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => res.statusCode === 200 ? resolve(text) : reject(new Error(`Fixture request failed: ${res.statusCode}`)));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ pid: process.pid, noProxy: process.env.NO_PROXY, inherited: process.env.INSTANCE_HOST_MARKER }));
  });
}
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  const { id, method, params = {} } = message;
  try {
    if (method === 'initialize') send({ jsonrpc: '2.0', id, result: { protocolVersion: 1,
      agentInfo: { name: 'synthetic-instance-harness', version: '1.0.0' },
      agentCapabilities: { loadSession: true, promptCapabilities: {}, sessionCapabilities: {} }, authMethods: [] } });
    else if (method === 'session/new' || method === 'session/load') {
      const sessionId = params.sessionId ?? `fixture-${account.id}-${process.pid}`;
      sessions.add(sessionId);
      const configOptions = [{ id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: 'fixture-model',
        options: [{ value: 'fixture-model', name: 'Fixture model' }] }];
      send({ jsonrpc: '2.0', id, result: { sessionId, configOptions } });
    } else if (method === 'session/prompt') {
      if (!sessions.has(params.sessionId)) throw new Error('Session must be opened first');
      const text = await outbound(params.sessionId);
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
      send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
    } else send({ jsonrpc: '2.0', id, result: {} });
  } catch (error) { send({ jsonrpc: '2.0', id, error: { code: -32603, message: error.message } }); }
}
