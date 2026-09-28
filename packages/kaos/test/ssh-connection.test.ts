import { createHmac, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { Server, utils } from 'ssh2';
import { afterEach, describe, expect, it } from 'vitest';

import { SshConnectionManager, type SshConnectionHost } from '#/ssh-connection';
import { SshKnownHosts } from '#/ssh-known-hosts';

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

async function startServer(hostKey: string, port = 0): Promise<{ server: Server; port: number; connections: () => number; drop: () => void }> {
  let count = 0;
  const clients: Array<{ end(): void }> = [];
  const files = new Map<string, Buffer>();
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    count++;
    clients.push(client);
    client.on('error', () => undefined);
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === 'tester' && ctx.password === 'temporary-password') ctx.accept();
      else ctx.reject();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptExec) => {
          const channel = acceptExec();
          channel.write('hello from SSH\n');
          channel.exit(0);
          channel.end();
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
  return { server, port: address.port, connections: () => count, drop: () => { for (const client of clients) client.end(); } };
}

function host(port: number, knownHostsFile: string, trustUnknown?: SshConnectionHost['trustUnknown']): SshConnectionHost {
  return { hostname: '127.0.0.1', port, username: 'tester', password: 'temporary-password', agent: 'none', knownHostsFiles: [knownHostsFile], trustUnknown };
}

describe('SSH connection manager with an actual ssh2 server', () => {
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
