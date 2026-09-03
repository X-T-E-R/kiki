import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';

import {
  detectLocalServer,
  isLoopbackBindHost,
  parseServerInstance,
  rankServerInstances,
} from './localServer.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  mock.restoreAll();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('local kap-server discovery', () => {
  it('uses the home token and prefers a live instance serving the current workspace', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-local-server-'));
    tempDirs.push(home);
    const instances = join(home, 'server', 'instances');
    await mkdir(instances, { recursive: true });
    await writeFile(join(home, 'server.token'), 'local-secret\n');
    await writeFile(
      join(instances, 'newest-other.json'),
      JSON.stringify({
        server_id: 'different-registry-id',
        pid: process.pid,
        url: 'http://127.0.0.1:41002',
        startedAt: 200,
        heartbeatAt: 300,
        workspaces: ['C:/other'],
      }),
    );
    await writeFile(
      join(instances, 'workspace-live.json'),
      JSON.stringify({
        server_id: 'stale-registration-id',
        pid: process.pid,
        host: '0.0.0.0',
        port: 41001,
        started_at: 100,
        heartbeat_at: 150,
        workspaces: ['C:/demo'],
      }),
    );

    const fetchMock = mock.method(
      globalThis,
      'fetch',
      async (input: string | URL | Request, init?: RequestInit) => {
        assert.equal(String(input), 'http://127.0.0.1:41001/api/v1/meta');
        assert.deepEqual(init?.headers, { authorization: 'Bearer local-secret' });
        return new Response(JSON.stringify({ data: { server_id: 'meta-may-differ', server_version: '0.40.0' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    );

    const privatePayload = await detectLocalServer('http://127.0.0.1:58627', {
      home,
      includeToken: false,
      currentWorkspace: 'C:/demo/worktree',
    });
    assert.deepEqual(privatePayload, {
      url: 'http://127.0.0.1:41001',
      token: undefined,
      home,
    });
    assert.doesNotMatch(JSON.stringify(privatePayload), /local-secret/);
    assert.equal(fetchMock.mock.callCount(), 1);

    const loopbackPayload = await detectLocalServer('http://127.0.0.1:58627', {
      home,
      currentWorkspace: 'C:/demo/worktree',
    });
    assert.equal(loopbackPayload.token, 'local-secret');
  });

  it('parses both registry shapes and ranks by workspace then heartbeat', () => {
    const current = parseServerInstance(JSON.stringify({
      pid: 41,
      host: '127.0.0.1',
      port: 41001,
      started_at: 100,
      heartbeat_at: 150,
      workspaces: ['C:/demo'],
    }));
    const newest = parseServerInstance(JSON.stringify({
      pid: 42,
      url: 'http://localhost:41002',
      startedAt: 200,
      heartbeatAt: 300,
      version: '0.40.0',
      workspaces: ['C:/other'],
    }));
    assert.ok(current);
    assert.ok(newest);
    assert.deepEqual(rankServerInstances([newest, current], 'C:/demo/worktree'), [current, newest]);
    assert.deepEqual(rankServerInstances([newest, current], 'C:/unknown'), [newest, current]);
    assert.equal(parseServerInstance('{broken'), undefined);
    assert.equal(parseServerInstance(JSON.stringify({ pid: 43, url: 'http://example.test:41003', startedAt: 1 })), undefined);
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
