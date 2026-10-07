import * as childProcess from 'node:child_process';
import { createHash, createHmac, generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { join } from 'pathe';
import { Server, utils } from 'ssh2';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SSHKaos } from '#/ssh';
import {
  SshConnectionManager,
  SshKnownHostVerificationError,
  type SshConnectionHost,
} from '#/ssh-connection';
import { SshKnownHosts } from '#/ssh-known-hosts';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const directories: string[] = [];
const managers: SshConnectionManager[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ path: string; home: string }> {
  const home = await mkdtemp(join(tmpdir(), 'kiki-ssh-connection-'));
  directories.push(home);
  return { path: join(home, 'known_hosts'), home };
}

function key(): string {
  return generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
}

async function startServer(hostKey: string, port = 0, holdExec = false, keyboard = false): Promise<{ server: Server; port: number; connections: () => number; drop: () => void; finishExec: () => void }> {
  let count = 0;
  const clients: Array<{ end(): void }> = [];
  const pendingExec: Array<{ exit(code: number): void; end(): void }> = [];
  const files = new Map<string, Buffer>();
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    count++;
    clients.push(client);
    client.on('error', () => undefined);
    client.on('authentication', (ctx) => {
      if (keyboard && ctx.method === 'keyboard-interactive') {
        let round = 0;
        const ask = (): void => {
          const expected = round++ === 0 ? 'one-time-code' : 'second-factor';
          ctx.prompt([{ prompt: expected, echo: false }], (answers) => {
            if (answers[0] !== expected) return ctx.reject();
            if (round === 2) ctx.accept(); else ask();
          });
        };
        ask();
      } else if (!keyboard && ctx.method === 'password' && ctx.username === 'tester' && ctx.password === 'temporary-password') ctx.accept();
      else ctx.reject();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptExec, rejectExec, info) => {
          if (info.command.includes('reject-exec')) { rejectExec(); return; }
          const respond = (): void => {
            const channel = acceptExec();
            if (info.command.includes('KIKI_SSH_ENV')) {
              channel.write('KIKI_SSH_ENV\nLinux\nx86_64\n6.8.0\n/bin/bash\n');
              channel.exit(0);
              channel.end();
              return;
            }
            channel.write('hello from SSH\n');
            if (holdExec) pendingExec.push(channel);
            else {
              channel.exit(0);
              channel.end();
            }
          };
          if (holdExec) setTimeout(respond, 60);
          else respond();
        });
        session.on('sftp', (acceptSftp) => {
          const channel = acceptSftp();
          let nextHandle = 0;
          const handles = new Map<number, string>();
          channel.on('REALPATH', (request, path) => {
            const target = path === '.' ? '/home/tester' : path;
            channel.name(request, [{ filename: target, longname: target, attrs: { mode: 0o040755, size: 0, uid: 1000, gid: 1000, atime: 0, mtime: 0 } }]);
          });
          channel.on('STAT', (request, path) => {
            if (path === '/home/tester') {
              channel.attrs(request, { mode: 0o040755, size: 0, uid: 1000, gid: 1000, atime: 0, mtime: 0 });
            } else if (files.has(path)) {
              channel.attrs(request, { mode: 0o100644, size: files.get(path)!.length, uid: 1000, gid: 1000, atime: 0, mtime: 0 });
            } else channel.status(request, utils.sftp.STATUS_CODE.NO_SUCH_FILE);
          });
          channel.on('OPEN', (request, path, flags) => {
            if ((flags & utils.sftp.OPEN_MODE.TRUNC) !== 0) files.set(path, Buffer.alloc(0));
            if (!files.has(path)) files.set(path, Buffer.alloc(0));
            const id = nextHandle++;
            handles.set(id, path);
            const handle = Buffer.alloc(4);
            handle.writeUInt32BE(id);
            channel.handle(request, handle);
          });
          channel.on('WRITE', (request, handle, offset, data) => {
            const path = handles.get(handle.readUInt32BE(0));
            if (!path) return channel.status(request, utils.sftp.STATUS_CODE.FAILURE);
            const next = Buffer.alloc(Math.max(files.get(path)?.length ?? 0, offset + data.length));
            files.get(path)?.copy(next);
            data.copy(next, offset);
            files.set(path, next);
            channel.status(request, utils.sftp.STATUS_CODE.OK);
          });
          channel.on('READ', (request, handle, offset, length) => {
            const path = handles.get(handle.readUInt32BE(0));
            if (!path) return channel.status(request, utils.sftp.STATUS_CODE.FAILURE);
            const chunk = files.get(path)!.subarray(offset, offset + length);
            if (chunk.length === 0) return channel.status(request, utils.sftp.STATUS_CODE.EOF);
            channel.data(request, chunk);
          });
          channel.on('CLOSE', (request, handle) => {
            handles.delete(handle.readUInt32BE(0));
            channel.status(request, utils.sftp.STATUS_CODE.OK);
          });
        });
      });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('SSH test server did not bind');
  return {
    server, port: address.port, connections: () => count,
    drop: () => { for (const client of clients) client.end(); },
    finishExec: () => { for (const channel of pendingExec.splice(0)) { channel.exit(0); channel.end(); } },
  };
}

function host(port: number, knownHostsFile: string, trustUnknown?: SshConnectionHost['trustUnknown']): SshConnectionHost {
  return { hostname: '127.0.0.1', port, username: 'tester', password: 'temporary-password', agent: 'none', knownHostsFiles: [knownHostsFile], trustUnknown };
}

function proxyFixture() {
  const proxy = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    killed: false,
    kill: vi.fn(() => true),
  });
  proxy.kill = vi.fn(() => {
    proxy.killed = true;
    return true;
  });
  return proxy;
}

describe('SSH proxy teardown with an isolated child', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it.each(['exit', 'error'] as const)('keeps a proxy %s after failed setup local to its transport', async (event) => {
    const proxy = proxyFixture();
    vi.spyOn(childProcess, 'spawn').mockReturnValue(proxy as unknown as childProcess.ChildProcessWithoutNullStreams);
    const { path } = await fixture();
    const manager = new SshConnectionManager(async () => ({
      ...host(22, path), keyContents: ['invalid-private-key'], passphrase: 'invalid-passphrase',
      proxyCommand: 'isolated-proxy',
    }));
    managers.push(manager);
    await expect(manager.get('proxy')).rejects.toThrow('SSH private key or passphrase is invalid');
    if (event === 'exit') { proxy.exitCode = 7; proxy.emit('exit', 7, null); }
    else proxy.emit('error', Object.assign(new Error('proxy launch failed'), { code: 'ENOENT' }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(manager.status('proxy').state).toBe('failed');
    expect(proxy.kill).toHaveBeenCalledOnce();
    expect(proxy.stdin.destroyed).toBe(true);
    expect(proxy.stdout.destroyed).toBe(true);
    expect(proxy.stderr.destroyed).toBe(true);
  });

  it.each(['exit', 'error', 'stdin', 'stdout', 'stderr', 'disconnect'] as const)('reports proxy %s during handshake and reclaims its streams', async (event) => {
    const proxy = proxyFixture();
    vi.spyOn(childProcess, 'spawn').mockReturnValue(proxy as unknown as childProcess.ChildProcessWithoutNullStreams);
    const { path } = await fixture();
    const manager = new SshConnectionManager(async () => ({ ...host(22, path), proxyCommand: 'isolated-proxy' }));
    const receipts: unknown[] = [];
    manager.onReceipt((receipt) => receipts.push(receipt));
    managers.push(manager);
    const opening = manager.get('proxy');
    const rejected = expect(opening).rejects.toThrow();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (event === 'exit') { proxy.exitCode = 7; proxy.emit('exit', 7, null); }
    else if (event === 'error') proxy.emit('error', new Error('proxy launch failed'));
    else if (event === 'disconnect') await manager.disconnect('proxy');
    else proxy[event].destroy(new Error(`${event} failed`));
    await rejected;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(manager.status('proxy').state).toBe(event === 'disconnect' ? 'idle' : 'failed');
    expect(proxy.kill).toHaveBeenCalledOnce();
    expect([proxy.stdin, proxy.stdout, proxy.stderr].every((stream) => stream.destroyed)).toBe(true);
    if (event === 'disconnect') expect(receipts).toContainEqual(expect.objectContaining({
      stage: 'disconnect', callerOutcome: 'resolved', cleanupOutcome: 'killed',
      resourcesAfter: 1, killRequested: true, exitObserved: false,
    }));
  });
});

describe('SSH connection receipts', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('keeps the caller failure and notifies other observers when a receipt observer throws', async () => {
    const failure = new Error('Example host resolution failed');
    const manager = new SshConnectionManager(async () => { throw failure; });
    managers.push(manager);
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const unsubscribe = manager.onReceipt(() => { throw new Error('Example observer failed'); });
    const receipts: unknown[] = [];
    manager.onReceipt(receipt => receipts.push(receipt));
    try {
      await expect(manager.get('example-host')).rejects.toBe(failure);
      expect(receipts).toContainEqual(expect.objectContaining({ callerOutcome: 'rejected', errorMessage: failure.message }));
      expect(warning).toHaveBeenCalledWith('SSH receipt observer threw an exception', { code: 'SSH_RECEIPT_OBSERVER_FAILED' });
    } finally { unsubscribe(); }
  });

  it('preserves verification reason in the connection receipt and stops retrying fatal verification errors', async () => {
    const verification = new SshKnownHostVerificationError('revoked', 'SSH host key is revoked for examplehost');
    const create = vi.spyOn(SSHKaos, 'create').mockRejectedValue(verification);
    const { path } = await fixture();
    const manager = new SshConnectionManager(async () => ({
      hostname: 'examplehost', port: 22, username: 'tester', agent: 'none', knownHostsFiles: [path],
    }));
    const receipts: unknown[] = [];
    manager.onReceipt((receipt) => receipts.push(receipt));
    managers.push(manager);

    await expect(manager.get('verification')).rejects.toBe(verification);
    expect(receipts).toContainEqual(expect.objectContaining({
      stage: 'connect', callerOutcome: 'rejected', errorCode: 'revoked', cleanupOutcome: 'closed',
    }));
    await expect(manager.get('verification')).rejects.toThrow(/manual intervention/);
    create.mockRestore();
  });

  it('reports the caller, proxy owner, and settled proxy resources after setup failure', async () => {
    const proxy = proxyFixture();
    vi.spyOn(childProcess, 'spawn').mockReturnValue(proxy as unknown as childProcess.ChildProcessWithoutNullStreams);
    const { path } = await fixture();
    const manager = new SshConnectionManager(async () => ({
      ...host(22, path), keyContents: ['invalid-private-key'], passphrase: 'invalid-passphrase',
      proxyCommand: 'isolated-proxy',
    }));
    const receipts: unknown[] = [];
    manager.onReceipt((receipt) => receipts.push(receipt));
    managers.push(manager);

    await expect(manager.get('proxy')).rejects.toThrow('SSH private key or passphrase is invalid');

    expect(receipts).toContainEqual(expect.objectContaining({
      stage: 'connect',
      callerOutcome: 'rejected',
      terminalOwner: 'ssh_proxy',
      cleanupOutcome: 'killed',
      resourcesBefore: 5,
      resourcesAfter: 1,
      killRequested: true,
      exitObserved: false,
    }));

    proxy.exitCode = 7;
    proxy.emit('exit', 7, null);
    await manager.disconnect('proxy');
    expect(receipts).toContainEqual(expect.objectContaining({
      stage: 'disconnect',
      callerOutcome: 'resolved',
      terminalOwner: 'ssh_proxy',
      cleanupOutcome: 'closed',
      resourcesAfter: 0,
      killRequested: true,
      exitObserved: true,
    }));
  });

  it('reports closed resources only after the proxy exit event is observed', async () => {
    const proxy = proxyFixture();
    vi.spyOn(childProcess, 'spawn').mockReturnValue(proxy as unknown as childProcess.ChildProcessWithoutNullStreams);
    const { path } = await fixture();
    const manager = new SshConnectionManager(async () => ({ ...host(22, path), proxyCommand: 'isolated-proxy' }));
    const receipts: unknown[] = [];
    manager.onReceipt((receipt) => receipts.push(receipt));
    managers.push(manager);

    const opening = manager.get('proxy');
    await new Promise<void>((resolve) => setImmediate(resolve));
    proxy.stderr.destroy(new Error('proxy launch failed'));
    await expect(opening).rejects.toThrow();

    expect(receipts).toContainEqual(expect.objectContaining({
      stage: 'connect',
      callerOutcome: 'rejected',
      cleanupOutcome: 'killed',
      resourcesBefore: 5,
      resourcesAfter: 1,
      killRequested: true,
      exitObserved: false,
    }));

    proxy.exitCode = 7;
    proxy.emit('exit', 7, null);
    await manager.disconnect('proxy');
    expect(receipts).toContainEqual(expect.objectContaining({
      stage: 'disconnect',
      callerOutcome: 'resolved',
      cleanupOutcome: 'closed',
      resourcesAfter: 0,
      killRequested: true,
      exitObserved: true,
    }));
  });
});

describe('SSH connection manager with an actual ssh2 server', () => {
  it('answers multiple keyboard-interactive challenges without writing responses to known_hosts', async () => {
    const { path } = await fixture();
    const { port } = await startServer(key(), 0, false, true);
    const seen: string[] = [];
    const manager = new SshConnectionManager(async () => ({
      ...host(port, path), password: undefined, autoTrustFirstKey: true,
      keyboardInteractive: async (prompts) => {
        seen.push(prompts[0]!.prompt);
        return [prompts[0]!.prompt];
      },
    }));
    managers.push(manager);
    const connection = await manager.get('keyboard');
    expect(connection.gethome()).toBe('/home/tester');
    expect(seen).toEqual(['one-time-code', 'second-factor']);
    expect(await readFile(path, 'utf8')).not.toContain('one-time-code');
  });

  it('shares one transport for exec and SFTP, records trust, and reconnects after disconnect', async () => {
    const { path } = await fixture();
    const { port, connections, drop } = await startServer(key());
    let prompts = 0;
    const manager = new SshConnectionManager(async () => host(port, path, async () => { prompts++; return true; }));
    managers.push(manager);
    const [a, b] = await Promise.all([manager.get('dev'), manager.get('dev')]);
    expect(a).toBe(b);
    expect(connections()).toBe(1);
    const proc = await a.exec('echo', 'hello');
    expect(await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      proc.stdout.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      proc.stdout.on('error', reject);
    })).toBe('hello from SSH\n');
    expect(await proc.wait()).toBe(0);
    await a.writeText('/home/tester/test.txt', 'remote contents');
    expect(await a.readText('/home/tester/test.txt')).toBe('remote contents');
    expect((await a.readBytes('/home/tester/test.txt', 4, 7)).toString()).toBe('cont');
    expect(await a.probeEnvironment()).toMatchObject({ osKind: 'Linux', osArch: 'x86_64', shellName: 'bash' });
    expect(a.osEnv.shellPath).toBe('/bin/bash');
    expect(prompts).toBe(1);
    expect(await readFile(path, 'utf8')).toContain('[127.0.0.1]:');
    const disconnected = new Promise<void>((resolve) => {
      const unsubscribe = manager.onStatus((event) => {
        if (event.state === 'disconnected') { unsubscribe(); resolve(); }
      });
    });
    drop();
    await disconnected;
    expect(manager.status('dev').state).toBe('disconnected');
    const reconnected = await manager.get('dev');
    expect(reconnected).not.toBe(a);
    expect(connections()).toBe(2);
    expect(prompts).toBe(1);
    expect(manager.status('dev')).toMatchObject({ state: 'ready', generation: 2 });
  });

  it('does not idle-close a transport with an active exec channel', async () => {
    const { path } = await fixture();
    const { port, finishExec } = await startServer(key(), 0, true);
    const manager = new SshConnectionManager(async () => ({ ...host(port, path), autoTrustFirstKey: true }), 20);
    managers.push(manager);
    const connection = await manager.get('dev');
    const opening = connection.withCwd('/home/tester').exec('sleep', '10');
    expect(connection.activeProcesses).toBe(1);
    const process = await opening;
    expect(connection.activeProcesses).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(manager.status('dev').state).toBe('ready');
    finishExec();
    expect(await process.wait()).toBe(0);
    expect(connection.activeProcesses).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(manager.status('dev').state).toBe('idle');
  });

  it('releases pending exec activity when the server rejects the request', async () => {
    const { path } = await fixture();
    const { port } = await startServer(key());
    const manager = new SshConnectionManager(async () => ({ ...host(port, path), autoTrustFirstKey: true }), 20);
    managers.push(manager);
    const connection = await manager.get('dev');
    const opening = connection.exec('reject-exec');
    expect(connection.activeProcesses).toBe(1);
    await expect(opening).rejects.toThrow('Unable to exec');
    expect(connection.activeProcesses).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(manager.status('dev').state).toBe('idle');
  });

  it.each([new Error('trust callback failed'), 'trust callback failed'])('preserves verification errors and wraps non-Error rejection causes: %s', async (failure) => {
    const { path } = await fixture();
    const { port } = await startServer(key());
    const manager = new SshConnectionManager(async () => host(port, path, () => Promise.reject(failure)));
    managers.push(manager);
    const caught: unknown = await manager.get('dev').catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(Error);
    if (failure instanceof Error) expect(caught).toBe(failure);
    else expect(caught).toMatchObject({ message: 'SSH host verification failed', cause: failure });
    expect(await readFile(path, 'utf8').catch(() => '')).toBe('');
  });

  it('denies an unknown key and rejects a changed key even when autoTrustFirstKey is enabled', async () => {
    const { path } = await fixture();
    const first = await startServer(key());
    const rejectUnknown = new SshConnectionManager(async () => host(first.port, path, async () => false));
    managers.push(rejectUnknown);
    await expect(rejectUnknown.get('dev')).rejects.toThrow();
    expect(await readFile(path, 'utf8').catch(() => '')).toBe('');
    await rejectUnknown.dispose();
    const acceptFirst = new SshConnectionManager(async () => ({ ...host(first.port, path), autoTrustFirstKey: true }));
    managers.push(acceptFirst);
    await acceptFirst.get('dev');
    await acceptFirst.dispose();
    await new Promise<void>((resolve) => first.server.close(() => resolve()));
    servers.splice(servers.indexOf(first.server), 1);
    const second = await startServer(key(), first.port);
    const changed = new SshConnectionManager(async () => ({ ...host(second.port, path), autoTrustFirstKey: true }));
    managers.push(changed);
    await expect(changed.get('dev')).rejects.toThrow(/host key changed/);
    expect(changed.status('dev').state).toBe('failed');
    await expect(changed.get('dev')).rejects.toThrow(/manual intervention/);
    changed.retry('dev');
    await expect(changed.get('dev')).rejects.toThrow(/host key changed/);
  });

  it('matches hashed known_hosts records and never prompts for an existing key', async () => {
    const { path } = await fixture();
    const label = '[127.0.0.1]:2200';
    const raw = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from('fake-key-material')]);
    const salt = Buffer.alloc(20, 17);
    const hash = createHmac('sha1', salt).update(label).digest('base64');
    await writeFile(path, `|1|${salt.toString('base64')}|${hash} ssh-ed25519 ${raw.toString('base64')}\n`);
    const trusted = new SshKnownHosts([path]);
    expect(await trusted.verify('127.0.0.1', 2200, raw, async () => { throw new Error('unexpected prompt'); })).toBe(true);
    await expect(trusted.verify('127.0.0.1', 2200, Buffer.concat([raw, Buffer.from('new')]), async () => true)).rejects.toThrow(/changed/);
  });

  it('serializes simultaneous first-key trust across aliases and never records two distinct keys', async () => {
    const { path } = await fixture();
    const prefix = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519')]);
    const first = new SshKnownHosts([path]);
    const second = new SshKnownHosts([path]);
    const results = await Promise.allSettled([
      first.verify('127.0.0.1', 2200, Buffer.concat([prefix, Buffer.from('key-one')]), async () => true),
      second.verify('127.0.0.1', 2200, Buffer.concat([prefix, Buffer.from('key-two')]), async () => true),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(1);
  });
});


describe('S5 read-only known_hosts inspection', () => {
  function publicKey(): Buffer {
    const parsed = utils.parseKey(key());
    if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Invalid generated test key');
    return parsed.getPublicSSH();
  }

  it('projects exact host and port, aliases, wildcard exclusions and hashed v1 without writes', async () => {
    const { path, home } = await fixture();
    const raw = publicKey();
    const other = publicKey();
    const salt = Buffer.alloc(20, 17);
    const label = '[hashed.example.test]:2200';
    const hash = createHmac('sha1', salt).update(label).digest('base64');
    const text = `example.test,alias.example.test ssh-rsa ${raw.toString('base64')}\n` +
      `[example.test]:2200 ssh-rsa ${other.toString('base64')}\n` +
      `*.example.test,!excluded.example.test ssh-rsa ${raw.toString('base64')}\n` +
      `|1|${salt.toString('base64')}|${hash} ssh-rsa ${raw.toString('base64')}\n`;
    await writeFile(path, text);
    const known = new SshKnownHosts([path, join(home, 'missing')]);
    expect(await known.inspect('alias.example.test', 22)).toMatchObject({ state: 'recorded',
      records: [expect.objectContaining({ line: 1, status: 'recorded', fingerprint: `SHA256:${createHash('sha256').update(raw).digest('base64').replace(/=+$/, '')}` }), expect.objectContaining({ line: 3 })] });
    expect((await known.inspect('example.test', 2200)).records).toMatchObject([{ line: 2, algorithm: 'ssh-rsa' }]);
    expect((await known.inspect('example.test', 2201)).state).toBe('unrecorded');
    expect((await known.inspect('excluded.example.test', 22)).state).toBe('unrecorded');
    expect((await known.inspect('hashed.example.test', 2200)).records).toMatchObject([{ line: 4, status: 'recorded' }]);
    expect((await known.inspect('hashed.example.test', 2201)).state).toBe('unrecorded');
    expect((await known.inspect('unknown.test', 22)).files).toMatchObject([{ state: 'read' }, { state: 'missing', reason: 'ENOENT' }]);
    expect(await readFile(path, 'utf8')).toBe(text);
    await expect(readFile(join(home, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports unsupported markers, invalid public keys, unknown hashes and read errors explicitly', async () => {
    const { path, home } = await fixture();
    const raw = publicKey();
    await writeFile(path, `@cert-authority ca.example.test ssh-rsa ${raw.toString('base64')}\n` +
      `@revoked revoked.example.test ssh-rsa ${raw.toString('base64')}\n` +
      'invalid.example.test ssh-rsa bad-key\n');
    const known = new SshKnownHosts([path]);
    expect(await known.inspect('ca.example.test', 22)).toMatchObject({ state: 'unavailable', records: [{ status: 'unsupported', reason: 'unsupported-marker:@cert-authority' }] });
    expect(await known.inspect('revoked.example.test', 22)).toMatchObject({ state: 'recorded', records: [{ status: 'revoked' }] });
    expect(await known.inspect('invalid.example.test', 22)).toMatchObject({ state: 'unavailable', records: [{ status: 'invalid', reason: 'invalid-public-key', fingerprint: undefined }] });
    await writeFile(path, '|2|salt|hash ssh-rsa bad-key\n');
    expect(await known.inspect('unknown.test', 22)).toMatchObject({ state: 'unavailable', files: [{ reason: 'unsupported-host-hash:line:1' }] });
    expect(await new SshKnownHosts([home]).inspect('unknown.test', 22)).toMatchObject({ state: 'unavailable', files: [{ state: 'unavailable' }] });
  });

  it('classifies exact revoked keys, unrelated revoked markers, and unrecorded algorithms without network writes', async () => {
    const { path } = await fixture();
    const raw = publicKey();
    const other = publicKey();
    const trust = vi.fn(async () => false);
    const known = new SshKnownHosts([path]);

    await writeFile(path, `@revoked examplehost ssh-rsa ${raw.toString('base64')}\n`);
    await expect(known.verify('examplehost', 22, raw, trust)).rejects.toMatchObject({
      reason: 'revoked', status: 'revoked', code: 'revoked',
    });
    expect(trust).not.toHaveBeenCalled();

    await writeFile(path, `@revoked otherhost ssh-rsa ${raw.toString('base64')}\n`);
    await expect(known.verify('examplehost', 22, raw, trust)).resolves.toBe(false);
    expect(trust).toHaveBeenCalledWith(expect.objectContaining({ status: 'unknown' }));

    trust.mockClear();
    await writeFile(path, `@revoked examplehost ssh-rsa ${other.toString('base64')}\n`);
    await expect(known.verify('examplehost', 22, raw, trust)).rejects.toMatchObject({ reason: 'key_changed' });
    expect(trust).not.toHaveBeenCalled();

    trust.mockClear();
    await writeFile(path, `examplehost ssh-ed25519 ${raw.toString('base64')}\n`);
    await expect(known.verify('examplehost', 22, raw, trust)).resolves.toBe(false);
    expect(trust).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'key_algorithm_unrecorded', status: 'key_algorithm_unrecorded',
    }));
    expect(await readFile(path, 'utf8')).toContain('ssh-ed25519');
  });

  it('rejects matching certificate-authority records as unsupported and ignores other hosts', async () => {
    const { path } = await fixture();
    const raw = publicKey();
    const known = new SshKnownHosts([path]);
    const trust = vi.fn(async () => false);

    await writeFile(path, `@cert-authority examplehost ssh-rsa ${raw.toString('base64')}\n`);
    await expect(known.verify('examplehost', 22, raw, trust)).rejects.toMatchObject({
      reason: 'certificate_authority_unsupported', status: 'certificate_authority_unsupported',
    });
    expect(trust).not.toHaveBeenCalled();

    await writeFile(path, `@cert-authority otherhost ssh-rsa ${raw.toString('base64')}\n`);
    await expect(known.verify('examplehost', 22, raw, trust)).resolves.toBe(false);
    expect(trust).toHaveBeenCalledOnce();
  });

  it('accepts an exact host key even when an unrelated revoked marker shares the label', async () => {
    const { path } = await fixture();
    const raw = publicKey();
    const other = publicKey();
    const known = new SshKnownHosts([path]);
    const trust = vi.fn(async () => { throw new Error('unexpected trust prompt'); });

    await writeFile(path,
      `@revoked examplehost ssh-rsa ${other.toString('base64')}\n` +
      `examplehost ssh-rsa ${raw.toString('base64')}\n`);

    await expect(known.verify('examplehost', 22, raw, trust)).resolves.toBe(true);
  });

  it('keeps matching, changed, revoked and unknown verification across two files without network or writes', async () => {
    const { path, home } = await fixture();
    const second = join(home, 'known_hosts2');
    const raw = publicKey();
    const replacement = publicKey();
    const firstText = `other.test ssh-rsa ${raw.toString('base64')}\n`;
    const secondText = `example.test ssh-rsa ${raw.toString('base64')}\n`;
    await writeFile(path, firstText);
    await writeFile(second, secondText);
    const known = new SshKnownHosts([path, second]);
    const trust = async (): Promise<boolean> => { throw new Error('Unexpected trust write'); };
    expect(await known.verify('example.test', 22, raw, trust)).toBe(true);
    await expect(known.verify('example.test', 22, replacement, trust)).rejects.toThrow(/changed/);
    expect(await known.verify('unknown.test', 22, raw, async () => false)).toBe(false);
    expect(await known.inspect('example.test', 22)).toMatchObject({ state: 'recorded', records: [{ file: second }] });
    expect(await readFile(path, 'utf8')).toBe(firstText);
    expect(await readFile(second, 'utf8')).toBe(secondText);
    await writeFile(path, `@revoked example.test ssh-rsa ${replacement.toString('base64')}\n`);
    await expect(known.verify('example.test', 22, raw, trust)).rejects.toThrow(/changed/);
    expect((await known.inspect('example.test', 22)).records.map((entry) => entry.status)).toEqual(['revoked', 'recorded']);
  });
});
