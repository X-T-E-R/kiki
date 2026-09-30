import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { AcpLoginHelper, extractLoopbackRedirect, rebuildLoopbackRedirect } from '../src/login';
import type { HostProcessLike } from '../src/types';

function authUrl(port = 48123) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('redirect_uri', `http://127.0.0.1:${port}/`);
  url.searchParams.set('state', 'fixture-state');
  return url.href;
}

function helperFixture(url: string, output: 'stdout' | 'stderr', logout: unknown = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const methods: string[] = [];
  let exited = false;
  let finish!: (code: number) => void;
  const exit = new Promise<number>((resolve) => { finish = resolve; });
  const settle = () => { if (!exited) { exited = true; finish(0); } };
  const child: HostProcessLike = { pid: 42, get exitCode() { return exited ? 0 : null; }, stdin, stdout, stderr,
    wait: () => exit, kill: async () => { settle(); }, dispose: () => { settle(); } };
  stdin.on('data', (data: Buffer) => {
    const frame = JSON.parse(data.toString());
    methods.push(frame.method);
    if (frame.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1, agentCapabilities: { auth: { logout } } } })}\n`);
    if (frame.method === 'authenticate') (output === 'stdout' ? stdout : stderr).write(`Open the following link to authenticate the ACP server: ${url}\n`);
    if (frame.method === 'logout') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} })}\n`);
  });
  stdin.on('finish', settle);
  return { helper: new AcpLoginHelper({ spawn: async () => child }, { command: 'fixture', args: [] }), methods,
    complete: () => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, result: {} })}\n`) };
}

describe('Antigravity ACP login boundary', () => {
  it('never spawns after close and disposes a child whose spawn settles after close', async () => {
    let resolve!: (child: HostProcessLike) => void;
    const spawn = new Promise<HostProcessLike>((done) => { resolve = done; });
    let calls = 0;
    let killed = false;
    let disposed = false;
    const helper = new AcpLoginHelper({ spawn: async () => { calls++; return spawn; } }, { command: 'fixture', args: [] });
    const starting = helper.start('oauth-personal');
    const rejected = expect(starting).rejects.toThrow('closed');
    await helper.close();
    resolve({ pid: 42, exitCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      wait: async () => 0, kill: async () => { killed = true; }, dispose: () => { disposed = true; } });
    await rejected;
    expect(killed).toBe(true);
    expect(disposed).toBe(true);
    await expect(helper.start('oauth-personal')).rejects.toThrow('closed');
    expect(calls).toBe(1);
  });
  it.each(['stdout', 'stderr'] as const)('captures the donor authorization marker on %s without conflating it with JSON-RPC', async (output) => {
    const fixture = helperFixture(authUrl(), output);
    try {
      expect(await fixture.helper.start('oauth-personal')).toEqual({ alreadySignedIn: false, authUrl: authUrl(), redirectUri: 'http://127.0.0.1:48123/' });
      expect(fixture.methods).toEqual(['initialize', 'authenticate']);
    } finally { await fixture.helper.close(); }
  });

  it('rebuilds only captured loopback code/state/error and rejects unrelated pasted URLs', () => {
    expect(rebuildLoopbackRedirect(authUrl(), 'http://127.0.0.1:48123/?code=fixture-code&state=fixture-state&access_token=discard')).toHaveProperty('href', 'http://127.0.0.1:48123/?code=fixture-code&state=fixture-state');
    for (const pasted of ['http://127.0.0.1:48124/?code=x&state=fixture-state', 'http://example.com/?code=x&state=fixture-state', 'http://127.0.0.1:48123/?code=x&state=wrong', 'http://127.0.0.1:48123/other?code=x&state=fixture-state']) expect(() => rebuildLoopbackRedirect(authUrl(), pasted)).toThrow();
    expect(() => extractLoopbackRedirect('https://example.com/?redirect_uri=http%3A%2F%2F127.0.0.1%3A48123%2F')).toThrow('origin');
    expect(() => extractLoopbackRedirect('https://accounts.google.com/?redirect_uri=http%3A%2F%2Fexample.com%3A48123%2F')).toThrow('loopback');
  });

  it('delivers an accepted callback to the captured local listener and waits for authenticate success', async () => {
    const paths: string[] = [];
    let complete = () => {};
    const server = createServer((req, res) => { paths.push(req.url!); res.end('ok'); complete(); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected TCP');
    const fixture = helperFixture(authUrl(address.port), 'stderr');
    complete = fixture.complete;
    try {
      await fixture.helper.start('oauth-personal');
      await fixture.helper.finish(authUrl(address.port), `http://127.0.0.1:${address.port}/?code=fixture-code&state=fixture-state`);
      expect(paths).toEqual(['/?code=fixture-code&state=fixture-state']);
    } finally { await fixture.helper.close(); await new Promise<void>((resolve) => { server.close(() => resolve()); }); }
  });

  it('does not call logout when the capability is false', async () => {
    const fixture = helperFixture(authUrl(), 'stderr', false);
    try { await expect(fixture.helper.logout()).rejects.toThrow('does not advertise logout'); expect(fixture.methods).toEqual(['initialize']); }
    finally { await fixture.helper.close(); }
  });
});
