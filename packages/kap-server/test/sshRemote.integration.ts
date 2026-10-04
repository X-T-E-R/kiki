import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectionIdentity, SshRemoteProfile, SshRemotePlan, RemoteConnection } from '@kiki/protocol';
import { createKlient, createConnectionKlient } from '@kiki/klient/http';
import { ISessionManager, ISessionContext, ensureMainAgent, IListThreadsTool, ISendMessageToThreadTool, IThreadMailboxStore, type ThreadRef } from '@kiki/agent-core-v2';
import { startServer, type RunningServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { SshRemoteConnector, type SshRemoteRecord } from '../src/services/sshRemote/connector';
import { SystemSshProcess, remoteServeCommand, sshArguments } from '../src/services/sshRemote/process';

const paths: string[] = []; const connectors: SshRemoteConnector[] = []; const servers: Server[] = []; const kapServers: RunningServer[] = [];
afterEach(async () => {
  for (const server of kapServers.splice(0).toReversed()) await server.close();
  for (const connector of connectors.splice(0)) await connector.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const identity = (): ConnectionIdentity => ({ homeId: randomUUID(), hostId: randomUUID(), protocol: 1 });
const profile = (): SshRemoteProfile => ({ id: 'fixture', label: 'Fixture', target: { kind: 'alias', alias: 'fixture-alias' }, releaseChannel: 'stable', remoteHome: '/fixture home', remoteExecutable: 'kiki', remoteShell: 'posix' });
async function fixture(options: { running?: boolean; noReady?: boolean; failQuery?: boolean } = {}) {
  const path = await mkdtemp(join(tmpdir(), 'kiki-ssh-fixture-')); paths.push(path);
  const target = identity(); const token = 'a'.repeat(43); const serverId = randomUUID(); const requests: { path: string; token?: string }[] = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url!, token: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    const data = req.url === '/api/meta'
      ? { server_home_id: target.homeId, server_id: serverId, server_version: 'fixture-version', dangerous_bypass_auth: false }
      : { identity: target, serverId, inboundEnabled: false };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ code: 0, data }));
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Fixture did not bind');
  const log = join(path, 'events.jsonl'); await writeFile(log, '');
  const configPath = join(path, 'config.json');
  const config = { running: options.running ?? true, noReady: options.noReady, failQuery: options.failQuery, log,
    bootstrap: { url: `http://127.0.0.1:${address.port}`, token, serverId, identity: target, serverVersion: 'fixture-version', dangerousBypassAuth: false, buildChannel: 'stable' } };
  await writeFile(configPath, JSON.stringify(config));
  const process = new SystemSshProcess({ executable: globalThis.process.execPath, prefix: [resolve(import.meta.dirname, 'fixtures/system-ssh.mjs'), configPath], timeoutMs: 1200 });
  const connector = new SshRemoteConnector({ process, serverVersion: 'fixture-version' }); connectors.push(connector);
  const record: SshRemoteRecord = { id: randomUUID(), target, transport: { kind: 'ssh', profile: profile() } };
  const events = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { kind: string; pid?: number; port?: number; args?: string[] });
  return { connector, record, config, configPath, events, requests, token };
}
async function run(executable: string, args: string[], cwd: string): Promise<string> {
  const child = spawn(executable, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = ''; child.stdout.on('data', (data) => { output += String(data); }); child.stderr.on('data', (data) => { errors += String(data); });
  const [code] = await once(child, 'close'); if (code !== 0) throw new Error(`Shell fixture failed: ${errors}`); return output;
}
async function alive(endpoint: string): Promise<boolean> { try { await fetch(endpoint, { signal: AbortSignal.timeout(300) }); return true; } catch { return false; } }
async function eventuallyClosed(endpoint: string): Promise<void> {
  for (let i = 0; i < 30; i++) { if (!(await alive(endpoint))) return; await new Promise((done) => setTimeout(done, 20)); }
  throw new Error('Owned tunnel did not close');
}

describe('system OpenSSH source lifecycle (isolated executable, real loopback HTTP)', () => {
  it('ports the Rust public-key/strict-host-key options and does not parse aliases', () => {
    const args = sshArguments(profile());
    for (const value of ['BatchMode=yes', 'PreferredAuthentications=publickey', 'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no', 'StrictHostKeyChecking=yes', 'ForwardAgent=no', 'ForwardX11=no', 'PermitLocalCommand=no', 'ServerAliveInterval=15', 'ServerAliveCountMax=3', 'ControlMaster=no']) expect(args).toContain(value);
    expect(args.at(-1)).toBe('fixture-alias');
    for (const alias of ['-oProxyCommand=evil', 'a b', 'a\ncommand']) expect(() => sshArguments({ ...profile(), target: { kind: 'alias', alias } })).toThrow();
    const host = sshArguments({ ...profile(), target: { kind: 'host', hostname: 'example.test', username: 'example', port: 2222 }, identityFile: '/fixture key path' });
    expect(host).toContain('/fixture key path'); expect(host.slice(-5)).toEqual(['-p', '2222', '-l', 'example', 'example.test']);
    expect(sshArguments({ ...profile(), target: { kind: 'host', hostname: '::1' } }).at(-1)).toBe('::1');
    expect(args).toContain('ControlPath=none');
  });
  it('executes POSIX and PowerShell quoted argv without interpreting home content', async () => {
    const path = await mkdtemp(join(tmpdir(), 'kiki-ssh-argv-')); paths.push(path);
    await writeFile(join(path, 'serve'), "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    const home = "/fixture spaces/雪' ;$(echo injected); `echo injected`";
    const value = { ...profile(), remoteExecutable: process.execPath.replaceAll('\\', '/'), remoteHome: home };
    const command = remoteServeCommand(value, false);
    const posix = JSON.parse(await run('sh', ['-c', command], path));
    expect(posix).toEqual(['--home', home, '--query', '--json']);
    if (process.platform === 'win32') {
      const encoded = remoteServeCommand({ ...value, remoteShell: 'powershell' }, true).split(' ').at(-1)!;
      const powershell = JSON.parse(await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], path));
      expect(powershell).toEqual(['--home', home, '--ensure', '--json', '--idle-exit', '0ms']);
    }
  });
  it('attaches an existing home without ensure and keeps bootstrap secrets out of public plans', async () => {
    const f = await fixture(); const plan = await f.connector.plan(profile());
    expect(plan.state).toBe('attach'); expect(plan.effects).toEqual({ startsServer: false, serverLifetime: 'existing', opensInbound: false, installsSoftware: false });
    const ready = await f.connector.execute(plan.id, { ensure: false }); expect(ready.state).toBe('ready');
    expect(JSON.stringify([plan, ready, f.connector.status(f.record.id)])).not.toContain(f.token);
    expect((await f.events()).filter((e) => e.kind === 'ensure')).toHaveLength(0);
    const result = await f.connector.withOwner(plan.id, async (owner) => { expect(owner.localOwnerToken).toBe(f.token); expect(owner.target).toEqual(f.record.target); return { provisioned: true }; });
    expect(result).toEqual({ provisioned: true });
    await expect(f.connector.withOwner(plan.id, async () => undefined)).rejects.toThrow('ssh_plan_not_ready');
    await writeFile(f.configPath, JSON.stringify({ ...f.config, running: false }));
    await expect(f.connector.execute(plan.id, { ensure: true })).rejects.toThrow('ssh_remote_not_running');
    expect((await f.events()).filter((e) => e.kind === 'ensure')).toHaveLength(0);
  });
  it('requires explicit ensure, races through one ensure and never opens inbound', async () => {
    const f = await fixture({ running: false }); const plan = await f.connector.plan(profile());
    expect(plan.state).toBe('ensure_required'); expect(plan.effects.opensInbound).toBe(false);
    await expect(f.connector.execute(plan.id, { ensure: false })).rejects.toThrow('ssh_ensure_confirmation_required');
    await Promise.all([f.connector.execute(plan.id, { ensure: true }), f.connector.execute(plan.id, { ensure: true })]);
    expect((await f.events()).filter((e) => e.kind === 'ensure')).toHaveLength(1);
    await writeFile(f.configPath, JSON.stringify({ ...f.config, running: false }));
    await expect(f.connector.execute(plan.id, { ensure: true })).rejects.toThrow('ssh_remote_not_running');
    expect((await f.events()).filter((e) => e.kind === 'ensure')).toHaveLength(1);
    expect(f.requests).toEqual([]);
  });
  it('holds two tunnels independently and releases GUI without interrupting bridge or another target', async () => {
    const a = await fixture(); const b = await fixture(); const gui = new AbortController(); const bridge = new AbortController(); const other = new AbortController();
    await writeFile(a.configPath, JSON.stringify({ ...a.config, aliases: { 'fixture-b': b.configPath } }));
    b.record.transport.profile.target = { kind: 'alias', alias: 'fixture-b' };
    const [first, second] = await Promise.all([a.connector.acquire(a.record, gui.signal, 'gui'), a.connector.acquire(b.record, other.signal, 'gui')]);
    const peer = await a.connector.acquire(a.record, bridge.signal, 'bridge');
    expect(peer.endpoint).toBe(first.endpoint); expect(second.endpoint).not.toBe(first.endpoint);
    expect(a.connector.status(a.record.id)).toMatchObject({ state: 'ready', guiLeases: 1, bridgeLeases: 1 });
    await a.connector.acquire(a.record, gui.signal, 'gui'); expect(a.connector.status(a.record.id).guiLeases).toBe(1);
    gui.abort(); expect(a.connector.status(a.record.id)).toMatchObject({ guiLeases: 0, bridgeLeases: 1 }); expect(await alive(first.endpoint)).toBe(true);
    bridge.abort(); await eventuallyClosed(first.endpoint); expect(await alive(second.endpoint)).toBe(true);
    other.abort(); await eventuallyClosed(second.endpoint);
    expect(a.connector.status(b.record.id).state).toBe('offline');
  });
  it('sends zero credentials for bootstrap identity drift or missing own-process port proof', async () => {
    const drift = await fixture(); const signal = new AbortController();
    await expect(drift.connector.acquire({ ...drift.record, target: identity() }, signal.signal, 'gui')).rejects.toThrow('identity_changed');
    expect(drift.requests).toEqual([]); expect((await drift.events()).some((e) => e.kind === 'tunnel')).toBe(false);
    const unconfirmed = await fixture({ noReady: true });
    await expect(unconfirmed.connector.acquire(unconfirmed.record, signal.signal, 'gui')).rejects.toThrow('ssh_forward_not_confirmed');
    expect(unconfirmed.requests).toEqual([]);
    const tunnel = (await unconfirmed.events()).find((e) => e.kind === 'tunnel'); await eventuallyClosed(`http://127.0.0.1:${tunnel!.port}`);
  });
  it('cancels a connecting target without affecting a live target and redacts SSH stderr failures', async () => {
    const a = await fixture(); const cancelled = await fixture({ noReady: true }); const live = new AbortController(); const pending = new AbortController();
    const ready = await a.connector.acquire(a.record, live.signal, 'gui');
    const operation = cancelled.connector.acquire(cancelled.record, pending.signal, 'bridge');
    pending.abort(); await expect(operation).rejects.toThrow(); expect(await alive(ready.endpoint)).toBe(true);
    const failed = await fixture({ failQuery: true });
    const error = await failed.connector.plan(profile()).catch((error: unknown) => error);
    expect(String(error)).toContain('ssh_command_failed'); expect(String(error)).not.toContain('fixture-private-secret-not-for-log'); expect(failed.requests).toEqual([]);
    await writeFile(failed.configPath, JSON.stringify({ ...failed.config, failureText: 'Host key verification failed. fixture-private-secret-not-for-log' }));
    const rejectedKey = await failed.connector.plan(profile()).catch((error: unknown) => error);
    expect(String(rejectedKey)).toContain('ssh_host_key_rejected'); expect(String(rejectedKey)).not.toContain('fixture-private-secret-not-for-log');
  });
  it('fails unsupported version/channel before forwarding and isolates purpose-specific stop', async () => {
    const f = await fixture();
    await writeFile(f.configPath, JSON.stringify({ ...f.config, bootstrap: { ...f.config.bootstrap, serverVersion: 'other-version' } }));
    await expect(f.connector.plan(profile())).rejects.toThrow('ssh_server_version_mismatch'); expect(f.requests).toEqual([]);
    await writeFile(f.configPath, JSON.stringify({ ...f.config, bootstrap: { ...f.config.bootstrap, buildChannel: 'beta' } }));
    await expect(f.connector.plan(profile())).rejects.toThrow('ssh_release_channel_mismatch'); expect(f.requests).toEqual([]);
    await writeFile(f.configPath, JSON.stringify(f.config));
    const gui = new AbortController(); const bridge = new AbortController();
    const target = await f.connector.acquire(f.record, gui.signal, 'gui');
    await f.connector.acquire(f.record, bridge.signal, 'bridge');
    await expect(f.connector.acquire(f.record, bridge.signal, 'gui')).rejects.toThrow('ssh_lease_purpose_mismatch');
    f.connector.stop(f.record.id, 'gui'); expect(f.connector.status(f.record.id)).toMatchObject({ guiLeases: 0, bridgeLeases: 1 });
    expect(await alive(target.endpoint)).toBe(true);
    f.connector.stop(f.record.id, 'bridge'); await eventuallyClosed(target.endpoint);
  });
});

const endpoint = (server: RunningServer) => `http://127.0.0.1:${server.port}`;
async function ownerCall<T>(server: RunningServer, path: string, body?: unknown): Promise<T> {
  const response = await fetch(endpoint(server) + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${server.localOwnerToken}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json() as { code: number; msg: string; data: T };
  if (!response.ok || value.code !== 0) throw new Error(value.msg);
  return value.data;
}
async function realKapSshFixture() {
  const root = await mkdtemp(join(tmpdir(), 'kiki-kap-ssh-')); paths.push(root);
  const sourceHome = join(root, 'source'); const targetHome = join(root, 'target'); const workspace = join(root, 'workspace');
  await writeFile(join(root, 'events.jsonl'), '');
  for (const home of [sourceHome, targetHome]) { await mkdir(home); await writeFile(join(home, 'config.toml'), 'search_backend = "minidb"\n[search]\nenabled = false\n'); }
  const boot = async (home: string, connector?: SshRemoteConnector) => {
    const server = await startServer({ homeDir: home, port: 0, logLevel: 'silent', hostIdentity: TEST_HOST_IDENTITY,
      serverVersion: 'fixture-version', sshRemoteConnector: connector }); kapServers.push(server); return server;
  };
  const target = await boot(targetHome);
  const configPath = join(root, 'ssh.json');
  const config = { log: join(root, 'events.jsonl'), running: true, bootstrap: {
    url: endpoint(target), token: target.localOwnerToken, serverId: target.serverId, identity: target.admission.identity,
    serverVersion: 'fixture-version', dangerousBypassAuth: false, buildChannel: 'stable',
  } };
  await writeFile(configPath, JSON.stringify(config));
  const makeConnector = () => new SshRemoteConnector({ process: new SystemSshProcess({ executable: process.execPath,
    prefix: [resolve(import.meta.dirname, 'fixtures/system-ssh.mjs'), configPath], timeoutMs: 3000 }), serverVersion: 'fixture-version' });
  const connector = makeConnector(); const source = await boot(sourceHome, connector);
  const events = async () => (await readFile(config.log, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { kind: string });
  const plan = () => ownerCall<SshRemotePlan>(source, '/api/remote-connections/ssh/plan', profile());
  const ready = async () => { const p = await plan(); return ownerCall<SshRemotePlan>(source, `/api/remote-connections/ssh/plans/${p.id}/execute`, { ensure: false }); };
  return { root, sourceHome, targetHome, workspace, source, target, connector, events, plan, ready, boot, makeConnector };
}

describe('SSH connector consumed by real source KAP/broker/thread bridge', () => {
  it('keeps detection separate from explicit admission, saves one canonical record and brokers with peer-only GUI credentials', async () => {
    const f = await realKapSshFixture();
    const attach = await f.plan(); expect(attach.state).toBe('attach'); expect(f.target.admission.status().enabled).toBe(false);
    const ready = await ownerCall<SshRemotePlan>(f.source, `/api/remote-connections/ssh/plans/${attach.id}/execute`, { ensure: false });
    expect(JSON.stringify(ready)).not.toContain(f.target.localOwnerToken);
    expect(f.target.admission.status().enabled).toBe(false);
    await expect(ownerCall(f.source, '/api/remote-connections/ssh/register', { purpose: 'gui', planId: ready.id, label: 'Target', enableInbound: false, backgroundSummary: true })).rejects.toThrow('inbound_disabled');
    expect(f.target.admission.status().enabled).toBe(false); expect(f.source.remoteConnections.list()).toEqual([]);
    const confirmed = await f.ready();
    const record = await ownerCall<RemoteConnection>(f.source, '/api/remote-connections/ssh/register', { purpose: 'gui', planId: confirmed.id, label: 'Target', enableInbound: true, backgroundSummary: true });
    expect(record.transport).toEqual({ kind: 'ssh', profile: profile() }); expect(record.purposes).toEqual(['gui']);
    expect(f.source.admission.status().enabled).toBe(false); expect(f.target.admission.status().enabled).toBe(true);
    const saved = await readFile(join(f.sourceHome, 'server', 'outbound-connections.json'), 'utf8');
    expect(saved).not.toContain(f.target.localOwnerToken); expect(saved).not.toContain(f.target.authTokenService.getToken());
    const credential = await f.source.remoteConnections.secrets.read<{ ownerToken: string; grant: string }>({ connectionId: record.id, purpose: 'gui' });
    expect(credential.ownerToken).toBe(f.target.authTokenService.getToken()); expect(credential.ownerToken).not.toBe(f.target.localOwnerToken);
    await f.source.remoteConnections.pollSummaries();
    const client = createConnectionKlient({ endpoint: endpoint(f.source), token: f.source.localOwnerToken, connectionId: record.id });
    try {
      expect((await client.rest!.meta()).server_home_id).toBe(f.target.admission.identity.homeId);
      expect((await client.rest!.meta()).server_home_id).toBe(f.target.admission.identity.homeId);
      expect(f.connector.status(record.id).guiLeases).toBe(1);
      const before = (await f.events()).filter((e) => e.kind === 'tunnel').length;
      await f.source.remoteConnections.pollSummaries(); await client.rest!.meta();
      expect((await f.events()).filter((e) => e.kind === 'tunnel')).toHaveLength(before);
      const bridgeHold = f.source.remoteConnections.lease(record.id, undefined, 'bridge');
      const transport = await f.source.remoteConnections.acquireTransport(record.id, bridgeHold.signal, 'bridge');
      f.source.remoteConnections.stop(record.id, 'gui');
      expect(f.connector.status(record.id)).toMatchObject({ guiLeases: 0, bridgeLeases: 1 }); expect(await alive(transport.endpoint)).toBe(true);
      await f.source.remoteConnections.enable(record.id, false); expect(bridgeHold.signal.aborted).toBe(true); await eventuallyClosed(transport.endpoint);
      bridgeHold.release(); expect((await ownerCall<{ enabled: boolean }>(f.target, '/api/remote-connections/inbound')).enabled).toBe(true);
      const grants = f.target.admission.status().grants.length;
      await f.source.remoteConnections.enable(record.id, true);
      await f.source.close(); kapServers.splice(kapServers.indexOf(f.source), 1);
      const restored = await f.boot(f.sourceHome, f.makeConnector());
      expect(restored.admission.identity).toEqual(f.source.admission.identity);
      expect(restored.remoteConnections.get(record.id).transport).toEqual(record.transport);
      const restoredClient = createConnectionKlient({ endpoint: endpoint(restored), token: restored.localOwnerToken, connectionId: record.id });
      try { expect((await restoredClient.rest!.meta()).server_home_id).toBe(f.target.admission.identity.homeId); } finally { await restoredClient.close(); }
      expect(f.target.admission.status().grants).toHaveLength(grants);
      expect((await f.events()).filter((e) => e.kind === 'ensure')).toHaveLength(0);
    } finally { await client.close(); }
  }, 60000);
  it('uses the same SSH lease in actual headless ThreadList/ThreadSend, independent bridge auth and target mailbox', async () => {
    const f = await realKapSshFixture();
    const aClient = createKlient({ endpoint: endpoint(f.source), token: f.source.localOwnerToken });
    const bClient = createKlient({ endpoint: endpoint(f.target), token: f.target.localOwnerToken });
    const create = async (server: RunningServer, client: ReturnType<typeof createKlient>, id: string): Promise<ThreadRef> => {
      const created = await client.global.sessions.create({ sessionId: id, workDir: f.root });
      const session = server.core.accessor.get(ISessionManager).get(created.id)!;
      const context = session.accessor.get(ISessionContext);
      await server.core.accessor.get(ISessionManager).close(created.id);
      return { hostId: server.admission.identity.hostId, workspaceId: context.workspaceId, sessionId: created.id };
    };
    try {
      await bClient.rest!.config.patch({ thread_communication: { enabled: true } });
      await aClient.rest!.config.patch({ thread_communication: { enabled: true } });
      const sourceRef = await create(f.source, aClient, 'same-thread'); const targetRef = await create(f.target, bClient, 'same-thread');
      const p = await f.ready();
      const descriptor = await ownerCall<RemoteConnection>(f.source, '/api/remote-connections/ssh/register', { purpose: 'bridge', planId: p.id, label: 'Bridge target' });
      expect(descriptor.purposes).toEqual(['bridge']); expect(f.target.admission.status().enabled).toBe(false);
      await bClient.rest!.connections.setInbound(true);
      const approved = await bClient.rest!.threadBridges.approve({ source: f.source.admission.identity, target: f.target.admission.identity,
        sourceScope: { workspaceId: sourceRef.workspaceId, sessionId: sourceRef.sessionId }, targetScope: { workspaceId: targetRef.workspaceId, sessionId: targetRef.sessionId },
        operations: ['read', 'send', 'wait'], expiresAt: Date.now() + 3600000, pendingLimit: 20, messagesPerMinute: 100, location: 'network', label: 'SSH bridge' });
      const link = await aClient.rest!.threadBridges.install({ connectionId: descriptor.id, ...approved });
      const resumed = await f.source.core.accessor.get(ISessionManager).resume(sourceRef.sessionId); const main = await ensureMainAgent(resumed!);
      const list = await main.accessor.get(IListThreadsTool).resolveExecution({ bridge_id: link.grant.id });
      if (!('execute' in list)) throw new Error('ThreadList rejected');
      const result = await list.execute({ signal: new AbortController().signal, turnId: 0, toolCallId: 'ssh-list' });
      expect(result.output).toEqual(expect.any(String));
      if (typeof result.output !== 'string') throw new Error('Expected ThreadList JSON output');
      expect(JSON.parse(result.output).threads.map((entry: { ref: ThreadRef }) => entry.ref)).toEqual([{ ...targetRef, bridgeId: link.grant.id, connectionId: descriptor.id }]);
      const thread = { host_id: targetRef.hostId, workspace_id: targetRef.workspaceId, session_id: targetRef.sessionId, bridge_id: link.grant.id, connection_id: descriptor.id };
      const send = await main.accessor.get(ISendMessageToThreadTool).resolveExecution({ thread, content: 'Explicit SSH bridge message', idempotency_key: 'ssh-message-key' });
      if (!('execute' in send)) throw new Error('ThreadSend rejected');
      const receipt = await send.execute({ signal: new AbortController().signal, turnId: 0, toolCallId: 'ssh-send' });
      expect(receipt.output).toEqual(expect.any(String));
      if (typeof receipt.output !== 'string') throw new Error('Expected ThreadSend JSON output');
      expect(JSON.parse(receipt.output).delivery).toBe('pending');
      const mailbox = await f.target.core.accessor.get(IThreadMailboxStore).readMessages({ group: `session:${targetRef.sessionId}`, limit: 10 });
      expect(mailbox.items).toHaveLength(1); expect(mailbox.items[0]!.message.producer).toMatchObject({ kind: 'bridged_peer', source: sourceRef, location: 'network' });
      expect(f.target.core.accessor.get(ISessionManager).get(targetRef.sessionId)).toBeUndefined();
      await expect(f.source.remoteConnections.secrets.read({ connectionId: descriptor.id, purpose: 'gui' })).rejects.toThrow();
      const bridgeSecret = await f.source.remoteConnections.secrets.read<{ credential: string }>({ connectionId: link.grant.id, purpose: 'bridge' });
      expect(bridgeSecret.credential).not.toBe(f.target.localOwnerToken); expect(bridgeSecret.credential).not.toBe(f.target.authTokenService.getToken());
      expect(f.source.admission.status().enabled).toBe(false);
      expect((await f.events()).filter((e) => e.kind === 'ensure')).toHaveLength(0);
    } finally { await aClient.close(); await bClient.close(); }
  }, 60000);
});
