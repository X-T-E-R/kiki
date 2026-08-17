import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';

import { detectLocalServer, isLoopbackBindHost } from './localServer.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  mock.restoreAll();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('local kap-server discovery', () => {
  it('rejects a reused pid unless the meta server-id nonce matches the registry', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-local-server-'));
    tempDirs.push(home);
    const instances = join(home, 'server', 'instances');
    await mkdir(instances, { recursive: true });
    await writeFile(join(home, 'server.token'), 'local-secret\n');
    await writeFile(
      join(instances, 'newest-stale.json'),
      JSON.stringify({
        server_id: 'stale-registration',
        pid: process.pid,
        host: '127.0.0.1',
        port: 41002,
        started_at: 200,
      }),
    );
    await writeFile(
      join(instances, 'older-live.json'),
      JSON.stringify({
        server_id: 'verified-process',
        pid: process.pid,
        host: '0.0.0.0',
        port: 41001,
        started_at: 100,
      }),
    );

    const fetchMock = mock.method(
      globalThis,
      'fetch',
      async (input: string | URL | Request, init?: RequestInit) => {
        assert.deepEqual(init?.headers, { authorization: 'Bearer local-secret' });
        const url = String(input);
        const serverId = url.includes(':41001/') ? 'verified-process' : 'different-process';
        return new Response(JSON.stringify({ data: { server_id: serverId } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    );

    const privatePayload = await detectLocalServer('http://127.0.0.1:58627', {
      home,
      includeToken: false,
    });
    assert.deepEqual(privatePayload, {
      url: 'http://127.0.0.1:41001',
      token: undefined,
      home,
    });
    assert.doesNotMatch(JSON.stringify(privatePayload), /local-secret/);
    assert.equal(fetchMock.mock.callCount(), 2);

    const loopbackPayload = await detectLocalServer('http://127.0.0.1:58627', { home });
    assert.equal(loopbackPayload.token, 'local-secret');
  });

  it('treats only explicit loopback Vite binds as safe for token responses', () => {
    assert.equal(isLoopbackBindHost(undefined), true);
    assert.equal(isLoopbackBindHost(false), true);
    assert.equal(isLoopbackBindHost('localhost'), true);
    assert.equal(isLoopbackBindHost('127.9.8.7'), true);
    assert.equal(isLoopbackBindHost('[::1]'), true);

    assert.equal(isLoopbackBindHost(true), false);
    assert.equal(isLoopbackBindHost('0.0.0.0'), false);
    assert.equal(isLoopbackBindHost('::'), false);
    assert.equal(isLoopbackBindHost('192.168.1.20'), false);
    assert.equal(isLoopbackBindHost('devbox.example.test'), false);
  });
});
