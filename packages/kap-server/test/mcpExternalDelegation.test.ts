import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  IConfigService,
  renderProfileCatalogEntries,
  type DispatchProfileCatalogEntry,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createKikiMcpServer, kikiMcpConfigFromEnv } from '../src/mcp/server';
import { registerApiV2Routes } from '../src/routes/registerApiV2Routes';
import { descriptorFromMeta } from '../src/services/transcript/coreBinding';

const exploreCatalogEntry: DispatchProfileCatalogEntry = {
  profileName: 'explore',
  description: 'Map code without changing it.',
  whenToUse: 'Use for bounded evidence gathering.',
  modelAlias: 'grok-4.6',
  thinkingEffort: 'max',
  allowedModels: ['grok-4.6', 'glm-5.3-flash'],
  alternativeModels: [{
    alias: 'glm-5.3-flash',
    when: 'Use for wide scans.',
    thinkingEffort: 'max',
  }],
  tools: 'Read, Grep',
};

describe('Kiki external delegation MCP server', () => {
  const close: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(close.splice(0).map((dispose) => dispose()));
  });

  it('initializes, lists the narrow tool set, and preserves JSON/structured parity', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      expect(href).toContain('/api/v2/sessions/session-operator/external-delegation/list');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer SECRET_TOKEN');
      expect(new Headers(init?.headers).get('x-kiki-delegation-token')).toBe('DELEGATION_SECRET');
      expect(new Headers(init?.headers).has('x-kiki-principal-id')).toBe(false);
      return new Response(
        JSON.stringify({
          code: 0,
          msg: 'ok',
          data: {
            delegationId: 'delegation_1',
            dispatchables: [{ kind: 'main' }, { kind: 'named', ...exploreCatalogEntry }],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const server = createKikiMcpServer(
      {
        endpoint: 'http://127.0.0.1:58627',
        token: 'SECRET_TOKEN',
        delegationToken: 'DELEGATION_SECRET',
        sessionId: 'session-operator',
        workspacePath: '/example/workspace',
      },
      { fetch: fetchMock },
    );
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close.push(() => client.close(), () => server.close());

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).toSorted()).toEqual([
      'kiki_cancel',
      'kiki_continue',
      'kiki_dispatch',
      'kiki_events',
      'kiki_list',
      'kiki_result',
      'kiki_status',
      'kiki_transcript',
      'kiki_wait',
    ]);
    const called = await client.callTool({ name: 'kiki_list', arguments: {} });
    expect(called.structuredContent).toEqual({
      delegationId: 'delegation_1',
      dispatchables: [{ kind: 'main' }, { kind: 'named', ...exploreCatalogEntry }],
      binding: {
        version: 1,
        workspacePath: '/example/workspace',
        sessionId: 'session-operator',
      },
    });
    expect(JSON.parse(((called as { content: Array<{ text: string }> }).content[0]!).text)).toEqual(called.structuredContent);
    const renderedCatalog = renderProfileCatalogEntries([exploreCatalogEntry]);
    const refreshedTools = await client.listTools();
    expect(refreshedTools.tools.find((tool) => tool.name === 'kiki_list')?.description).toContain(renderedCatalog);
    expect(refreshedTools.tools.find((tool) => tool.name === 'kiki_dispatch')?.description).toContain(renderedCatalog);
  });

  it('pins the workspace and Session binding when the MCP server is created', async () => {
    const config = {
      endpoint: 'http://127.0.0.1:58627',
      token: 'TOKEN',
      delegationToken: 'DELEGATION_SECRET',
      sessionId: 'session-original',
      workspacePath: '/example/original',
    };
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      expect(fetchUrl(url)).toContain('/sessions/session-original/external-delegation/list');
      return new Response(
        JSON.stringify({ code: 0, msg: 'ok', data: { delegationId: 'delegation_1', dispatchables: [{ kind: 'main' }] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const server = createKikiMcpServer(config, { fetch: fetchMock });
    config.sessionId = 'session-mutated';
    config.workspacePath = '/example/mutated';

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close.push(() => client.close(), () => server.close());

    const called = await client.callTool({ name: 'kiki_list', arguments: {} });
    expect(called.structuredContent).toMatchObject({
      binding: {
        version: 1,
        workspacePath: '/example/original',
        sessionId: 'session-original',
      },
    });
  });

  it('requires an absolute workspace binding in the stdio environment', () => {
    const env = {
      KIKI_KAP_ENDPOINT: 'http://127.0.0.1:58627',
      KIKI_KAP_TOKEN: 'TOKEN',
      KIKI_DELEGATION_TOKEN: 'DELEGATION_SECRET',
      KIKI_SESSION_ID: 'session-operator',
      KIKI_WORKSPACE_PATH: '/example/workspace',
    };
    expect(kikiMcpConfigFromEnv(env)).toMatchObject({
      sessionId: 'session-operator',
      workspacePath: '/example/workspace',
    });
    expect(() => kikiMcpConfigFromEnv({ ...env, KIKI_WORKSPACE_PATH: 'relative' })).toThrow();
  });

  it('pages result text on a UTF-8 byte boundary without leaking operator configuration', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ code: 0, msg: 'ok', data: { text: '你你你', dispatch: { dispatchId: 'dispatch_1' } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const server = createKikiMcpServer(
      {
        endpoint: 'http://127.0.0.1:58627',
        token: 'DO_NOT_EXPOSE',
        delegationToken: 'DELEGATION_SECRET',
        sessionId: 'session-operator',
        workspacePath: '/example/workspace',
      },
      { fetch: fetchMock },
    );
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close.push(() => client.close(), () => server.close());

    const called = await client.callTool({ name: 'kiki_result', arguments: { dispatch_id: 'dispatch_1', max_bytes: 6 } });
    expect(called.structuredContent).toMatchObject({ text: '你你', nextCursor: 2 });
    expect(JSON.stringify(called)).not.toContain('DO_NOT_EXPOSE');
  });

  it('rejects max_bytes below four and accepts the domain minimum', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(JSON.parse(fetchBody(init)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ code: 0, msg: 'ok', data: { text: 'done', dispatch: { dispatchId: 'dispatch_1' } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const server = createKikiMcpServer(
      {
        endpoint: 'http://127.0.0.1:58627',
        token: 'TOKEN',
        delegationToken: 'DELEGATION_SECRET',
        sessionId: 'session-operator',
        workspacePath: '/example/workspace',
      },
      { fetch: fetchMock },
    );
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close.push(() => client.close(), () => server.close());

    const rejected = await Promise.all([1, 2, 3].map((maxBytes) =>
      client.callTool({
        name: 'kiki_result',
        arguments: { dispatch_id: 'dispatch_1', max_bytes: maxBytes },
      }),
    ));
    expect(rejected.every((response) => response.isError === true)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    const accepted = await client.callTool({
      name: 'kiki_result',
      arguments: { dispatch_id: 'dispatch_1', max_bytes: 4 },
    });
    expect(accepted.isError).not.toBe(true);
    expect(bodies).toEqual([{ dispatch_id: 'dispatch_1', limit: 4 }]);
  });

  it('clamps max_bytes to the domain result page limit', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(JSON.parse(fetchBody(init)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ code: 0, msg: 'ok', data: { text: 'hello', dispatch: { dispatchId: 'dispatch_1' } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const server = createKikiMcpServer(
      {
        endpoint: 'http://127.0.0.1:58627',
        token: 'TOKEN',
        delegationToken: 'DELEGATION_SECRET',
        sessionId: 'session-operator',
        workspacePath: '/example/workspace',
      },
      { fetch: fetchMock },
    );
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close.push(() => client.close(), () => server.close());

    const called = await client.callTool({
      name: 'kiki_result',
      arguments: { dispatch_id: 'dispatch_1', max_bytes: 100_000 },
    });
    expect(called.isError).not.toBe(true);
    expect(bodies[0]).toMatchObject({ dispatch_id: 'dispatch_1', limit: 65_536 });
  });

  it('forwards exact bindings without progress polling when no token is supplied', async () => {
    const requests: Array<{ action: string; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      requests.push({
        action: href.split('/').at(-1)!,
        body: JSON.parse(fetchBody(init)) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify({
          code: 0,
          msg: 'ok',
          data: {
            dispatchId: 'dispatch_exact',
            target: 'named',
            taskName: 'exact_probe',
            profileName: 'explore',
            actualProfile: 'explore',
            modelAlias: 'grok-4.6',
            thinkingEffort: 'high',
            status: 'queued',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const server = createKikiMcpServer(
      {
        endpoint: 'http://127.0.0.1:58627',
        token: 'TOKEN',
        delegationToken: 'DELEGATION_SECRET',
        sessionId: 'session-operator',
        workspacePath: '/example/workspace',
      },
      { fetch: fetchMock },
    );
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close.push(() => client.close(), () => server.close());

    const dispatched = await client.callTool({
      name: 'kiki_dispatch',
      arguments: {
        target: 'named',
        task_name: 'exact_probe',
        profile_name: 'explore',
        model_alias: 'grok-4.6',
        thinking_effort: 'high',
        dispatch_key: 'dispatch-key-exact',
        message: 'inspect',
      },
    });
    expect(dispatched.isError).not.toBe(true);
    expect(dispatched.structuredContent).toMatchObject({
      dispatch_key: 'dispatch-key-exact',
      receipt: {
        dispatch_id: 'dispatch_exact',
        dispatch_key: 'dispatch-key-exact',
        task_name: 'exact_probe',
        actual_profile: 'explore',
        status: 'queued',
        next_step: expect.stringContaining('kiki_wait'),
        continue_hint: expect.stringContaining('kiki_dispatch'),
      },
    });
    expect(requests[0]).toEqual({
      action: 'dispatch',
      body: {
        target: 'named',
        task_name: 'exact_probe',
        profile_name: 'explore',
        model_alias: 'grok-4.6',
        thinking_effort: 'high',
        dispatch_key: 'dispatch-key-exact',
        message: 'inspect',
      },
    });

    await client.callTool({
      name: 'kiki_continue',
      arguments: {
        dispatch_id: 'dispatch_exact',
        dispatch_key: 'continue-key-exact',
        message: 'continue',
      },
    });
    expect(requests[1]).toEqual({
      action: 'continue',
      body: {
        dispatch_id: 'dispatch_exact',
        dispatch_key: 'continue-key-exact',
        message: 'continue',
      },
    });
    const rebound = await client.callTool({
      name: 'kiki_continue',
      arguments: {
        dispatch_id: 'dispatch_exact',
        message: 'continue',
        model_alias: 'other-model',
      },
    });
    expect(rebound.isError).toBe(true);
    expect(requests).toHaveLength(2);
  });

  it('generates dispatch keys for dispatch and continue and echoes them in receipts', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      requests.push(JSON.parse(fetchBody(init)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          code: 0,
          msg: 'ok',
          data: {
            dispatchId: `dispatch_${requests.length}`,
            target: 'named',
            taskName: 'memory_probe',
            profileName: 'explore',
            actualProfile: 'explore',
            status: 'queued',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const server = createKikiMcpServer(
      {
        endpoint: 'http://127.0.0.1:58627',
        token: 'TOKEN',
        delegationToken: 'DELEGATION_SECRET',
        sessionId: 'session-operator',
        workspacePath: '/example/workspace',
      },
      { fetch: fetchMock },
    );
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close.push(() => client.close(), () => server.close());

    const dispatched = await client.callTool({
      name: 'kiki_dispatch',
      arguments: {
        target: 'named',
        task_name: 'memory_probe',
        profile_name: 'explore',
        message: 'inspect',
      },
    });
    const continued = await client.callTool({
      name: 'kiki_continue',
      arguments: { dispatch_id: 'dispatch_1', message: 'continue' },
    });
    const dispatchKey = requests[0]?.['dispatch_key'];
    const continueKey = requests[1]?.['dispatch_key'];
    expect(dispatchKey).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(continueKey).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(continueKey).not.toBe(dispatchKey);
    expect(dispatched.structuredContent).toMatchObject({
      dispatch_key: dispatchKey,
      receipt: { dispatch_key: dispatchKey, dispatch_id: 'dispatch_1' },
    });
    expect(continued.structuredContent).toMatchObject({
      dispatch_key: continueKey,
      receipt: { dispatch_key: continueKey, dispatch_id: 'dispatch_2' },
    });
  });

  it('mirrors targeted timeout and wait-any responses through kiki_wait', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(fetchBody(init)) as Record<string, unknown>;
      bodies.push(body);
      const data = body['dispatch_id'] === undefined
        ? {
            waitStatus: 'completed',
            waitedMs: 3,
            dispatch: { dispatchId: 'dispatch_any', status: 'completed' },
            completedDuringWait: [{ dispatchId: 'dispatch_any', status: 'completed' }],
          }
        : {
            waitStatus: 'timed_out',
            waitedMs: 0,
            dispatch: { dispatchId: body['dispatch_id'], status: 'running' },
            completedDuringWait: [],
          };
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const server = createKikiMcpServer(
      {
        endpoint: 'http://127.0.0.1:58627',
        token: 'TOKEN',
        delegationToken: 'DELEGATION_SECRET',
        sessionId: 'session-operator',
        workspacePath: '/example/workspace',
      },
      { fetch: fetchMock },
    );
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close.push(() => client.close(), () => server.close());

    const timedOut = await client.callTool({
      name: 'kiki_wait',
      arguments: { dispatch_id: 'dispatch_running', timeout_s: 0 },
    });
    const any = await client.callTool({ name: 'kiki_wait', arguments: { timeout_s: 1 } });
    expect(bodies).toEqual([
      { dispatch_id: 'dispatch_running', timeout_s: 0 },
      { timeout_s: 1 },
    ]);
    expect(timedOut.isError).not.toBe(true);
    expect(timedOut.structuredContent).toMatchObject({
      waitStatus: 'timed_out',
      dispatch: { dispatchId: 'dispatch_running', status: 'running' },
    });
    expect(any.structuredContent).toMatchObject({
      waitStatus: 'completed',
      completedDuringWait: [{ dispatchId: 'dispatch_any', status: 'completed' }],
    });
  });

  it('streams delegation progress from lifecycle and transcript polling until terminal status', async () => {
    let eventPoll = 0;
    let transcriptPoll = 0;
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const action = fetchUrl(url).split('/').at(-1);
      const body = JSON.parse(fetchBody(init)) as Record<string, unknown>;
      let data: unknown;
      if (action === 'dispatch') {
        data = { dispatchId: 'dispatch_progress', target: 'main', status: 'queued', createdAt: 1 };
      } else if (action === 'events') {
        eventPoll += 1;
        expect(body).toMatchObject({ dispatch_id: 'dispatch_progress', limit: 100 });
        data = eventPoll === 1
          ? {
              items: [
                { seq: 1, dispatchId: 'dispatch_progress', type: 'queued', at: 1 },
                { seq: 2, dispatchId: 'dispatch_progress', type: 'started', at: 2 },
              ],
            }
          : { items: [{ seq: 3, dispatchId: 'dispatch_progress', type: 'completed', at: 3 }] };
      } else if (action === 'transcript') {
        transcriptPoll += 1;
        expect(body).toMatchObject({ dispatch_id: 'dispatch_progress', limit: 50 });
        data = transcriptPoll === 1
          ? { items: [{ index: 0, role: 'assistant', text: 'working' }] }
          : { items: [{ index: 1, role: 'tool', text: 'done' }] };
      } else if (action === 'status') {
        data = { dispatchId: 'dispatch_progress', target: 'main', status: 'completed', createdAt: 1, endedAt: 3 };
      } else {
        throw new Error(`Unexpected action: ${action}`);
      }
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const server = createKikiMcpServer(
      {
        endpoint: 'http://127.0.0.1:58627',
        token: 'TOKEN',
        delegationToken: 'DELEGATION_SECRET',
        sessionId: 'session-operator',
        workspacePath: '/example/workspace',
      },
      { fetch: fetchMock, progressPollIntervalMs: 0 },
    );
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close.push(() => client.close(), () => server.close());
    const progress: Array<{ progress: number; message?: string }> = [];

    const called = await client.callTool(
      { name: 'kiki_dispatch', arguments: { target: 'main', message: 'inspect' } },
      undefined,
      { onprogress: (update) => progress.push(update) },
    );

    expect(called.structuredContent).toMatchObject({
      dispatchId: 'dispatch_progress',
      status: 'completed',
    });
    expect(progress).toEqual([
      { progress: 1, message: 'Delegation turn started (0 tool calls completed).' },
      { progress: 2, message: 'Delegation running (1 tool call completed).' },
      { progress: 3, message: 'Delegation completed (1 tool call completed).' },
    ]);
    expect(eventPoll).toBe(2);
    expect(transcriptPoll).toBe(2);
  });

  it('keeps polling transcript while a progress-token dispatch is active', async () => {
    let eventPoll = 0;
    let activeTranscriptPolls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const action = fetchUrl(url).split('/').at(-1);
      let data: unknown;
      if (action === 'dispatch') {
        data = { dispatchId: 'dispatch_active', target: 'main', status: 'running', createdAt: 1 };
      } else if (action === 'events') {
        eventPoll += 1;
        data = eventPoll === 1
          ? { items: [{ seq: 1, dispatchId: 'dispatch_active', type: 'started', at: 1 }] }
          : { items: [{ seq: 2, dispatchId: 'dispatch_active', type: 'completed', at: 2 }] };
      } else if (action === 'transcript') {
        activeTranscriptPolls += 1;
        data = activeTranscriptPolls === 1
          ? { items: [] }
          : { items: [{ index: 0, role: 'assistant', text: 'done' }] };
      } else if (action === 'status') {
        data = { dispatchId: 'dispatch_active', target: 'main', status: 'completed', createdAt: 1 };
      } else {
        throw new Error(`Unexpected action: ${action}`);
      }
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const server = createKikiMcpServer(
      {
        endpoint: 'http://127.0.0.1:58627',
        token: 'TOKEN',
        delegationToken: 'DELEGATION_SECRET',
        sessionId: 'session-operator',
        workspacePath: '/example/workspace',
      },
      { fetch: fetchMock, progressPollIntervalMs: 0 },
    );
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close.push(() => client.close(), () => server.close());

    const called = await client.callTool(
      { name: 'kiki_dispatch', arguments: { target: 'main', message: 'inspect' } },
      undefined,
      { onprogress: () => undefined },
    );

    expect(called.isError).not.toBe(true);
    expect(called.structuredContent).toMatchObject({
      dispatchId: 'dispatch_active',
      status: 'completed',
    });
    expect(activeTranscriptPolls).toBe(2);
  });

  it('reports invalid tool input as invalid_input instead of an internal error', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const server = createKikiMcpServer(
      {
        endpoint: 'http://127.0.0.1:58627',
        token: 'TOKEN',
        delegationToken: 'DELEGATION_SECRET',
        sessionId: 'session-operator',
        workspacePath: '/example/workspace',
      },
      { fetch: fetchMock },
    );
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close.push(() => client.close(), () => server.close());

    const invalidTaskName = await client.callTool({
      name: 'kiki_dispatch',
      arguments: { target: 'named', task_name: 'Mixed-Case', profile_name: 'explore', message: 'x' },
    });
    expect(invalidTaskName.isError).toBe(true);
    expect(invalidTaskName.structuredContent).toMatchObject({ error: { code: 'invalid_input' } });
    expect(JSON.stringify(invalidTaskName)).toContain('task_name');
    expect(fetchMock).not.toHaveBeenCalled();

    const missingMessage = await client.callTool({
      name: 'kiki_dispatch',
      arguments: { target: 'main' },
    });
    expect(missingMessage.isError).toBe(true);
    expect(missingMessage.structuredContent).toMatchObject({ error: { code: 'invalid_input' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pages astral and mixed text without splitting Unicode or losing code units', async () => {
    const source = 'A😀你B🧪终';
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(fetchBody(init)) as { cursor?: number };
      const cursor = body.cursor ?? 0;
      // Deliberately split after two UTF-16 code units. The first backend
      // response ends with a high surrogate, independently exercising the
      // MCP edge's repair cursor rather than relying on a friendly backend.
      const text = source.slice(cursor, cursor + 2);
      const nextCursor = cursor + text.length < source.length ? cursor + text.length : undefined;
      return new Response(
        JSON.stringify({ code: 0, msg: 'ok', data: { text, nextCursor, dispatch: { dispatchId: 'dispatch_1' } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const server = createKikiMcpServer(
      {
        endpoint: 'http://127.0.0.1:58627',
        token: 'TOKEN',
        delegationToken: 'DELEGATION_SECRET',
        sessionId: 'session-operator',
        workspacePath: '/example/workspace',
      },
      { fetch: fetchMock },
    );
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close.push(() => client.close(), () => server.close());

    let cursor: number | undefined;
    let concatenated = '';
    do {
      const called = await client.callTool({
        name: 'kiki_result',
        arguments: { dispatch_id: 'dispatch_1', cursor, max_bytes: 4 },
      });
      expect(called.isError).not.toBe(true);
      const page = called.structuredContent as { text: string; nextCursor?: number };
      expect(Buffer.byteLength(page.text, 'utf8')).toBeLessThanOrEqual(4);
      expect(Buffer.from(page.text, 'utf8').toString('utf8')).toBe(page.text);
      concatenated += page.text;
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    expect(concatenated).toBe(source);
  });

  it('returns typed redacted tool errors for rejected REST requests', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ code: 40001, msg: 'Bearer SECRET_TOKEN was rejected' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const server = createKikiMcpServer(
      {
        endpoint: 'http://127.0.0.1:58627',
        token: 'SECRET_TOKEN',
        delegationToken: 'DELEGATION_SECRET',
        sessionId: 'session-operator',
        workspacePath: '/example/workspace',
      },
      { fetch: fetchMock },
    );
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close.push(() => client.close(), () => server.close());

    const called = await client.callTool({ name: 'kiki_status', arguments: { dispatch_id: 'dispatch_1' } });
    expect(called.isError).toBe(true);
    expect(called.structuredContent).toEqual({
      error: { code: 'request_rejected', message: 'Kiki delegation request failed.' },
    });
    expect(JSON.stringify(called)).not.toContain('SECRET_TOKEN');
  });

  it('passes an already-classified failure code and description through untouched', async () => {
    const description =
      'External agent authentication expired or was rejected; re-authenticate the provider and retry.';
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          code: 40001,
          msg: description,
          details: { failure_code: 'auth_expired' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const server = createKikiMcpServer(
      {
        endpoint: 'http://127.0.0.1:58627',
        token: 'SECRET_TOKEN',
        delegationToken: 'DELEGATION_SECRET',
        sessionId: 'session-operator',
        workspacePath: '/example/workspace',
      },
      { fetch: fetchMock },
    );
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close.push(() => client.close(), () => server.close());

    const called = await client.callTool({ name: 'kiki_status', arguments: { dispatch_id: 'dispatch_1' } });
    expect(called.isError).toBe(true);
    expect(called.structuredContent).toEqual({
      error: { code: 'auth_expired', message: description },
    });
  });

  it('collapses an untrusted failure_code instead of trusting the envelope', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          code: 40001,
          msg: 'Bearer SECRET_TOKEN was rejected',
          details: { failure_code: 'not_a_category' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const server = createKikiMcpServer(
      {
        endpoint: 'http://127.0.0.1:58627',
        token: 'SECRET_TOKEN',
        delegationToken: 'DELEGATION_SECRET',
        sessionId: 'session-operator',
        workspacePath: '/example/workspace',
      },
      { fetch: fetchMock },
    );
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close.push(() => client.close(), () => server.close());

    const called = await client.callTool({ name: 'kiki_status', arguments: { dispatch_id: 'dispatch_1' } });
    expect(called.isError).toBe(true);
    expect(called.structuredContent).toEqual({
      error: { code: 'request_rejected', message: 'Kiki delegation request failed.' },
    });
    expect(JSON.stringify(called)).not.toContain('SECRET_TOKEN');
  });
});

describe('external delegation route exposure', () => {
  const originalPrincipal = process.env['KIKI_EXTERNAL_PRINCIPAL_ID'];
  const originalSession = process.env['KIKI_EXTERNAL_SESSION_ID'];
  const originalToken = process.env['KIKI_EXTERNAL_DELEGATION_TOKEN'];

  afterEach(() => {
    if (originalPrincipal === undefined) delete process.env['KIKI_EXTERNAL_PRINCIPAL_ID'];
    else process.env['KIKI_EXTERNAL_PRINCIPAL_ID'] = originalPrincipal;
    if (originalSession === undefined) delete process.env['KIKI_EXTERNAL_SESSION_ID'];
    else process.env['KIKI_EXTERNAL_SESSION_ID'] = originalSession;
    if (originalToken === undefined) delete process.env['KIKI_EXTERNAL_DELEGATION_TOKEN'];
    else process.env['KIKI_EXTERNAL_DELEGATION_TOKEN'] = originalToken;
  });

  it('does not register any external route while the feature is off', async () => {
    process.env['KIKI_EXTERNAL_PRINCIPAL_ID'] = 'example-principal';
    process.env['KIKI_EXTERNAL_SESSION_ID'] = 'session-operator';
    process.env['KIKI_EXTERNAL_DELEGATION_TOKEN'] = 'DELEGATION_SECRET';
    const paths: string[] = [];
    const register = (path: string) => paths.push(path);
    const api = { get: register, post: register, put: register, delete: register };
    const app = { register: async (plugin: (host: unknown) => Promise<void> | void) => plugin(api) };
    const core = {
      accessor: {
        get: (id: unknown) =>
          id === IConfigService
            ? { ready: Promise.resolve() }
            : { enabled: () => false },
      },
    };

    await registerApiV2Routes(app as never, core as never);
    expect(paths.some((path) => path.includes('external-delegation'))).toBe(false);
  });
});

describe('external delegation transcript projection', () => {
  it('projects the typed delegator before legacy labels and never fabricates main', () => {
    expect(
      descriptorFromMeta('external-child', {
        type: 'independent',
        delegator: { kind: 'external', delegationId: 'delegation_test' },
        labels: { parentAgentId: 'main' },
        parentAgentId: 'main',
      }),
    ).toEqual({
      agentId: 'external-child',
      type: 'independent',
      delegator: { kind: 'external', delegationId: 'delegation_test' },
      parentAgentId: undefined,
      label: undefined,
    });
  });
});

function fetchUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function fetchBody(init: Parameters<typeof fetch>[1]): string {
  if (typeof init?.body !== 'string') throw new Error('Expected a string request body.');
  return init.body;
}
