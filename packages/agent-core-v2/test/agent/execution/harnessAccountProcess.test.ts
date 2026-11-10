import { createServer, request as httpRequest, type Server } from 'node:http';
import { PassThrough } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { describe, expect, it, vi } from 'vitest';
import type { HostProcessLike, HostProcessServiceLike } from '@kiki/acp-client';
import type { HarnessAccountConnection } from '@kiki/protocol';

import { ILogService } from '#/_base/log/log';
import { IAgentExecutorRegistry, type AgentExecutorContext, type AgentExecutorDescriptor } from '#/app/agentExecutor/agentExecutor';
import { materializeExecutorInstance } from '#/app/agentExecutor/executorInstances';
import { executorProcessOptions } from '#/app/agentExecutor/executorOverrides';
import { IPluginHostService } from '#/app/plugin/pluginHostService';
import { openHarnessAccountBroker } from '#/agent/execution/harnessAccountBroker';
import { harnessAccountProcess } from '#/agent/execution/harnessAccountProcess';

function setup(engineId = 'agy-cli') {
  const source = 'plugin:fixture-account-source/accounts';
  const descriptor = materializeExecutorInstance('instance-fixture', {
    source_executor: engineId, label: 'Work login', configuration: { kind: 'plugin_account', source, account_id: 'work' }, proxy: { kind: 'inherit' },
  }, { id: engineId, protocol: engineId === 'agy-cli' ? 'acp-v1' : 'codex-app-server', command: 'engine', args: [], revision: 'source' }, () => undefined);
  const connection: HarnessAccountConnection = { protocol: engineId === 'agy-cli' ? 'gemini-v1beta' : 'openai-responses',
    baseUrl: `http://127.0.0.1:12345${engineId === 'agy-cli' ? '' : '/v1'}`, apiKey: 'synthetic-short-lived-key', modelIds: ['fixture-model'] };
  const release = vi.fn(async () => {});
  const prepare = vi.fn(async () => ({ connection, release }));
  const record = vi.fn();
  const warn = vi.fn();
  const get = vi.fn((service: unknown) => {
    if (service === IPluginHostService) return { prepareHarnessAccount: prepare };
    if (service === IAgentExecutorRegistry) return { recordNegotiated: record };
    if (service === ILogService) return { warn };
    throw Error('Unexpected fixture service');
  });
  const context = { descriptor, binding: {}, agent: { accessor: { get } } } as unknown as AgentExecutorContext;
  let finish!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { finish = resolve; });
  const child: HostProcessLike = { pid: 9, exitCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    wait: () => exited, kill: async () => { finish(0); }, dispose: () => {} };
  const spawn = vi.fn<HostProcessServiceLike['spawn']>(async () => child);
  const launch = harnessAccountProcess({ spawn }, context, 'local');
  return { connection, context, descriptor, source, prepare, release, spawn, launch, finish, get, warn };
}

describe('plugin account process ownership', () => {
  it('does not read a plugin host for an original global engine', async () => {
    const fixture = setup();
    const descriptor: AgentExecutorDescriptor = { id: 'agy-cli', protocol: 'acp-v1', command: 'engine', args: [], revision: 'original' };
    const processes = { spawn: fixture.spawn };
    const global = harnessAccountProcess(processes, { ...fixture.context, descriptor }, 'local');
    expect(global.processes).toBe(processes);
    expect(fixture.get).not.toHaveBeenCalled();
  });

  it.each(['agy-cli', 'codex-app-server'])('keeps %s secrets out of argv and descriptor revisions, releasing at real exit', async (engineId) => {
    const f = setup(engineId);
    const before = JSON.stringify(f.descriptor);
    const signal = new AbortController().signal;
    await f.launch.processes.spawn('engine', ['original-arg'], executorProcessOptions(f.descriptor), signal);
    expect(f.prepare).toHaveBeenCalledWith(f.source, { engineId, accountId: 'work', instanceId: 'instance-fixture', proxy: { mode: 'system', url: undefined } }, signal);
    const [, args, options] = f.spawn.mock.calls[0]!;
    expect(args?.[0]).toBe('original-arg');
    if (engineId === 'codex-app-server') expect(args?.find((value) => value.includes('base_url'))).toContain(f.connection.baseUrl);
    else expect(options?.env?.['GOOGLE_GEMINI_BASE_URL']).not.toBe(f.connection.baseUrl);
    expect(JSON.stringify(args)).not.toContain(f.connection.apiKey);
    expect(options?.env?.[engineId === 'agy-cli' ? 'GEMINI_API_KEY' : 'KIKI_HARNESS_API_KEY']).toBe(f.connection.apiKey);
    expect(options?.envUnset).not.toContain(engineId === 'agy-cli' ? 'GEMINI_API_KEY' : 'KIKI_HARNESS_API_KEY');
    expect(JSON.stringify(f.descriptor)).toBe(before);
    expect(f.launch.processes.redactDiagnostic?.(f.connection.apiKey)).toBe('[redacted]');
    expect(f.release).not.toHaveBeenCalled();
    f.finish(0);
    await vi.waitFor(() => { expect(f.release).toHaveBeenCalledOnce(); });
  });

  it('releases an acquired connection after spawn failure without trying another source', async () => {
    const f = setup();
    f.spawn.mockRejectedValueOnce(Error('spawn failure'));
    await expect(f.launch.processes.spawn('engine')).rejects.toThrow('Could not start the engine');
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.spawn).toHaveBeenCalledOnce();
  });

  it('rejects an incompatible protocol before spawn and releases its lease', async () => {
    const f = setup();
    f.connection.protocol = 'openai-responses';
    await expect(f.launch.processes.spawn('engine')).rejects.toThrow('compatible connection');
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('names the selected source on preparation failure without exposing backend credentials', async () => {
    const f = setup();
    f.prepare.mockRejectedValueOnce(Error(f.connection.apiKey));
    const error = await f.launch.processes.spawn('engine').catch((failure: unknown) => failure);
    expect(String(error)).toContain(f.source);
    expect(String(error)).not.toContain(f.connection.apiKey);
    expect(f.spawn).not.toHaveBeenCalled();
  });
});

describe('loopback account lease continuation', () => {
  const listen = async (server: Server) => {
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Fixture requires a loopback port');
    return address.port;
  };
  const close = async (server: Server) => {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  };

  it('replaces a dead lease only for later requests and shares one replacement flight', async () => {
    const firstBodies: Array<{ text: string; key: string | undefined }> = [];
    const secondBodies: Array<{ text: string; key: string | undefined }> = [];
    const first = createServer((req) => {
      void (async () => {
        firstBodies.push({ text: (await buffer(req)).toString(), key: req.headers['x-goog-api-key'] as string | undefined });
        req.socket.destroy();
      })().catch(() => { req.socket.destroy(); });
    });
    const second = createServer((req, res) => {
      void (async () => {
        secondBodies.push({ text: (await buffer(req)).toString(), key: (req.headers['x-goog-api-key'] as string | undefined) ?? new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('key') ?? undefined });
        res.end('new-lease-result');
      })().catch(() => { req.socket.destroy(); });
    });
    let broker: Awaited<ReturnType<typeof openHarnessAccountBroker>>;
    const firstRelease = vi.fn(async () => {});
    const secondRelease = vi.fn(async () => {});
    let prepareSignal: AbortSignal | undefined;
    const prepare = vi.fn(async (signal: AbortSignal) => {
      prepareSignal = signal;
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      return { connection: secondConnection, release: secondRelease };
    });
    const validate = vi.fn();
    const releaseError = vi.fn();
    const [firstPort, secondPort] = await Promise.all([listen(first), listen(second)]);
    const firstConnection: HarnessAccountConnection = { protocol: 'gemini-v1beta', baseUrl: `http://127.0.0.1:${firstPort}`, apiKey: 'first-scoped-key', modelIds: ['fixture-model'] };
    const secondConnection: HarnessAccountConnection = { ...firstConnection, baseUrl: `http://127.0.0.1:${secondPort}`, apiKey: 'second-scoped-key' };
    try {
      broker = await openHarnessAccountBroker({ connection: firstConnection, release: firstRelease }, prepare, validate, releaseError);
      expect(broker).toBeDefined();
      const stableUrl = broker!.connection.baseUrl;
      const post = (text: string, key = 'first-scoped-key') => fetch(stableUrl, {
        method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'text/plain' }, body: text, signal: AbortSignal.timeout(5000),
      });
      expect((await post('foreign-request', 'wrong-key')).status).toBe(401);
      expect(firstBodies).toHaveLength(0);
      await expect(post('original-request')).rejects.toThrow();
      expect(prepare).not.toHaveBeenCalled();
      const [continued, concurrent] = await Promise.all([post('continuation-a'), post('continuation-b')]);
      expect(await continued.text()).toBe('new-lease-result');
      expect(await concurrent.text()).toBe('new-lease-result');
      const queryContinuation = await fetch(`${stableUrl}?key=first-scoped-key`, { method: 'POST', body: 'continuation-query', signal: AbortSignal.timeout(5000) });
      expect(await queryContinuation.text()).toBe('new-lease-result');
      expect(prepare).toHaveBeenCalledOnce();
      expect(prepareSignal?.aborted).toBe(false);
      expect(validate).toHaveBeenCalledWith(secondConnection);
      expect(firstBodies).toEqual([{ text: 'original-request', key: 'first-scoped-key' }]);
      expect(secondBodies).toHaveLength(3);
      expect(secondBodies.map(({ text }) => text).toSorted()).toEqual(['continuation-a', 'continuation-b', 'continuation-query']);
      expect(secondBodies.every(({ key }) => key === 'second-scoped-key')).toBe(true);
      expect(broker!.connection.baseUrl).toBe(stableUrl);
      await broker!.close();
      await expect(post('after-close')).rejects.toThrow();
      expect(prepare).toHaveBeenCalledOnce();
    } finally {
      await broker?.close();
      await Promise.all([close(first), close(second)]);
    }
    expect(firstRelease).toHaveBeenCalledOnce();
    expect(secondRelease).toHaveBeenCalledOnce();
    expect(releaseError).not.toHaveBeenCalled();
  });

  it('does not replay a failed request or fall back when replacement is revoked', async () => {
    const bodies: string[] = [];
    const origin = createServer((req) => {
      void (async () => {
        bodies.push((await buffer(req)).toString());
        req.socket.destroy();
      })().catch(() => { req.socket.destroy(); });
    });
    const release = vi.fn(async () => {});
    const prepare = vi.fn(async () => { throw new Error('revoked synthetic-secret'); });
    let broker: Awaited<ReturnType<typeof openHarnessAccountBroker>>;
    try {
      const port = await listen(origin);
      const connection: HarnessAccountConnection = { protocol: 'gemini-v1beta', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'selected-key', modelIds: ['fixture-model'] };
      broker = await openHarnessAccountBroker({ connection, release }, prepare, () => {}, vi.fn());
      const post = (text: string) => fetch(broker!.connection.baseUrl, { method: 'POST', headers: { 'x-goog-api-key': 'selected-key' }, body: text, signal: AbortSignal.timeout(5000) });
      await expect(post('delivered-once')).rejects.toThrow();
      const failure = await post('new-request-after-revocation').catch((error: unknown) => error);
      expect(String(failure)).not.toContain('synthetic-secret');
      expect(bodies).toEqual(['delivered-once']);
      expect(prepare).toHaveBeenCalledOnce();
    } finally {
      await broker?.close();
      await close(origin);
    }
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects non-origin-form targets without forwarding scoped credentials', async () => {
    const leasePaths: string[] = [];
    const foreignRequests: Array<{ path: string | undefined; key: string | undefined }> = [];
    const origin = createServer((req, res) => {
      leasePaths.push(req.url ?? '');
      res.end('lease-result');
    });
    const foreign = createServer((req, res) => {
      foreignRequests.push({ path: req.url, key: req.headers['x-goog-api-key'] as string | undefined });
      res.end('foreign-result');
    });
    const release = vi.fn(async () => {});
    const prepare = vi.fn();
    let broker: Awaited<ReturnType<typeof openHarnessAccountBroker>>;
    const [port, foreignPort] = await Promise.all([listen(origin), listen(foreign)]);
    try {
      const connection: HarnessAccountConnection = { protocol: 'gemini-v1beta', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'selected-key', modelIds: ['fixture-model'] };
      broker = await openHarnessAccountBroker({ connection, release }, prepare, () => {}, vi.fn());
      const endpoint = new URL(broker!.connection.baseUrl);
      const send = (path: string) => new Promise<number>((resolve, reject) => {
        const outgoing = httpRequest({ hostname: endpoint.hostname, port: endpoint.port, path, headers: { 'x-goog-api-key': 'selected-key' } }, (reply) => {
          reply.resume();
          reply.once('end', () => { resolve(reply.statusCode ?? 0); });
        });
        outgoing.once('error', reject);
        outgoing.end();
      });
      for (const path of [
        `http://127.0.0.1:${foreignPort}/outside?key=selected-key`,
        `//127.0.0.1:${foreignPort}/outside`,
        `/\\127.0.0.1:${foreignPort}/outside`,
        '/models/fixture#outside',
      ]) expect(await send(path)).toBe(400);
      expect(foreignRequests).toEqual([]);
      expect(leasePaths).toEqual([]);
      expect(await send('/models/fixture?alt=sse')).toBe(200);
      expect(leasePaths).toEqual(['/models/fixture?alt=sse']);
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      await broker?.close();
      await Promise.all([close(origin), close(foreign)]);
    }
    expect(release).toHaveBeenCalledOnce();
  });

  it('drains other streams on a dead lease while later requests use its replacement', async () => {
    const firstPaths: string[] = [];
    const secondPaths: string[] = [];
    let finishSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => { finishSlow = resolve; });
    const first = createServer((req, res) => {
      firstPaths.push(req.url ?? '');
      if (req.url === '/slow') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('slow-');
        void slowGate.then(() => { res.end('complete'); });
        return;
      }
      req.socket.destroy();
    });
    const second = createServer((req, res) => {
      secondPaths.push(req.url ?? '');
      res.end('replacement-result');
    });
    const firstRelease = vi.fn(async () => {});
    const secondRelease = vi.fn(async () => {});
    let broker: Awaited<ReturnType<typeof openHarnessAccountBroker>>;
    const [firstPort, secondPort] = await Promise.all([listen(first), listen(second)]);
    const firstConnection: HarnessAccountConnection = { protocol: 'gemini-v1beta', baseUrl: `http://127.0.0.1:${firstPort}`, apiKey: 'first-key', modelIds: ['fixture-model'] };
    const secondConnection: HarnessAccountConnection = { ...firstConnection, baseUrl: `http://127.0.0.1:${secondPort}`, apiKey: 'second-key' };
    const prepare = vi.fn(async () => ({ connection: secondConnection, release: secondRelease }));
    try {
      broker = await openHarnessAccountBroker({ connection: firstConnection, release: firstRelease }, prepare, () => {}, vi.fn());
      const get = (path: string) => fetch(`${broker!.connection.baseUrl}${path}`, { headers: { 'x-goog-api-key': 'first-key' }, signal: AbortSignal.timeout(5000) });
      const slow = await get('/slow');
      const slowBody = slow.text();
      await expect(get('/failed-once')).rejects.toThrow();
      expect(await (await get('/next-request')).text()).toBe('replacement-result');
      expect(prepare).toHaveBeenCalledOnce();
      expect(firstPaths).toEqual(['/slow', '/failed-once']);
      expect(secondPaths).toEqual(['/next-request']);
      expect(firstRelease).not.toHaveBeenCalled();
      finishSlow();
      expect(await slowBody).toBe('slow-complete');
      await vi.waitFor(() => { expect(firstRelease).toHaveBeenCalledOnce(); });
      await broker!.close();
      expect(secondRelease).toHaveBeenCalledOnce();
    } finally {
      finishSlow();
      await broker?.close();
      await Promise.all([close(first), close(second)]);
    }
    expect(firstRelease).toHaveBeenCalledOnce();
    expect(secondRelease).toHaveBeenCalledOnce();
  });

  it('leaves remote account connections on their existing direct path', async () => {
    const connection: HarnessAccountConnection = { protocol: 'openai-responses', baseUrl: 'https://account.example.test/v1', apiKey: 'selected-key', modelIds: ['fixture-model'] };
    const release = vi.fn(async () => {});
    const prepare = vi.fn();
    expect(await openHarnessAccountBroker({ connection, release }, prepare, () => {}, vi.fn())).toBeUndefined();
    expect(prepare).not.toHaveBeenCalled();
    await release();
  });
});
