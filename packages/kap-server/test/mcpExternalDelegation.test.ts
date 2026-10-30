import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EXTERNAL_INTERACTION_NOT_OWNED_CODE as CORE_INTERACTION_NOT_OWNED_CODE, SendMessageToThreadToolInputSchema } from '@kiki/agent-core-v2';
import { compileToolArgsValidator, validateToolArgs } from '@kiki/agent-core-v2/tool/args-validator';
import { toInputJsonSchema } from '@kiki/agent-core-v2/tool/input-schema';
import {
  delegationProcedureTable,
  type DelegationProcedureName,
  type DelegationProcedureOutput,
  type SeatKlient,
} from '@kiki/klient/procedures';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createKikiMcpServer,
  EXTERNAL_INTERACTION_NOT_OWNED_CODE,
  kikiMcpConfigFromEnv,
  mcpToolInputSchema,
} from '../src/mcp/server';

const close: Array<() => Promise<void>> = [];

const binding = {
  version: 1 as const,
  seatId: 'seat-operator',
  principalId: 'principal-operator',
  sessionId: 'session-operator',
  workspacePath: '/example/workspace',
};

const dispatch = {
  dispatchId: 'dispatch-1',
  target: 'named' as const,
  taskName: 'probe',
  profileName: 'explore',
  actualProfile: 'explore',
  status: 'queued' as const,
  createdAt: 1,
};

const outputs: Partial<{
  [Name in DelegationProcedureName]: DelegationProcedureOutput<Name>;
}> = {
  profiles: {
    profiles: [{
      kind: 'named',
      profileName: 'explore',
      description: 'Map code without changing it.',
      alternativeModels: [],
    }],
    binding,
  },
  list: {
    version: 1,
    delegationId: 'delegation-1',
    lifecycle: 'active',
    dispatchables: [{ kind: 'main' }],
    children: [],
    continuations: [],
    binding,
  },
  dispatch,
  continue: dispatch,
  send: {
    message: {
      messageId: 'message-1',
      sourceTaskName: 'root',
      targetTaskName: 'probe',
      content: 'inspect',
      acceptedAt: 1,
      targetSeq: 1,
    },
    deduplicated: false,
    delivery: 'queued',
    payloadConflict: false,
  },
};

describe('Kiki external delegation MCP projector', () => {
  afterEach(async () => {
    await Promise.all(close.splice(0).map((dispose) => dispose()));
  });

  it.each(['union', 'reference', 'object'] as const)('advertises the original %s context schema without weakening validation', async (kind) => {
    const object = { type: 'object', properties: { action: { type: 'string', const: 'preview' } },
      required: ['action'], additionalProperties: false };
    const parameters = kind === 'union' ? { anyOf: [object, { type: 'object',
      properties: { action: { type: 'string', const: 'list' } }, required: ['action'], additionalProperties: false }] }
      : kind === 'reference' ? { $defs: { request: object }, $ref: '#/$defs/request' } : object;
    const contextCall = vi.fn(async () => ({ output: { accepted: true } }));
    const { client } = await connect(fakeKlient(), { contextCatalog: { delegation: true, tools: [{
      name: 'board_read', toolName: 'kiki_board_read', description: 'Read the board.', parameters,
    }] }, contextCall });
    const catalog = await client.listTools();
    expect(catalog.tools.find((tool) => tool.name === 'kiki_board_read')?.inputSchema).toEqual(kind === 'union'
      ? { type: 'object', additionalProperties: false, required: ['action'],
        properties: { action: { anyOf: [{ type: 'string', const: 'preview' }, { type: 'string', const: 'list' }] } } }
      : { ...parameters, type: 'object' });
    expect(catalog.tools.find((tool) => tool.name === 'kiki_dispatch')?.inputSchema.properties).toHaveProperty('message');
    const valid = await client.callTool({ name: 'kiki_board_read', arguments: { action: 'preview' } });
    expect(valid.isError).not.toBe(true);
    expect(contextCall).toHaveBeenCalledWith({ name: 'board_read', arguments: { action: 'preview' } }, expect.any(AbortSignal));
    const invalid = await client.callTool({ name: 'kiki_board_read', arguments: {} });
    expect(invalid.isError).toBe(true);
    expect(contextCall).toHaveBeenCalledTimes(1);
  });

  it('starts a native tool connection with an empty policy and reflects later activation and revocation', async () => {
    const tool = { name: 'example_tool', toolName: 'kiki_example_tool', description: 'Example tool',
      parameters: { type: 'object', properties: {} } };
    let active = false;
    const contextCall = vi.fn(async () => ({ output: 'native result' }));
    const { client } = await connect(fakeKlient(), {
      contextCatalog: { delegation: false, nativeTools: true, tools: [] },
      contextList: async () => ({ delegation: false, nativeTools: true, tools: active ? [tool] : [] }), contextCall,
    });
    expect((await client.listTools()).tools).toEqual([]);
    active = true;
    expect((await client.listTools()).tools.map((entry) => entry.name)).toEqual(['kiki_example_tool']);
    expect((await client.callTool({ name: tool.toolName, arguments: {} })).content).toEqual([{ type: 'text', text: 'native result' }]);
    active = false;
    expect((await client.callTool({ name: tool.toolName, arguments: {} })).isError).toBe(true);
    expect(contextCall).toHaveBeenCalledTimes(1);
    expect((await client.listTools()).tools).toEqual([]);
  });

  it.each(['static', 'dynamic'] as const)('lists the native ThreadSend union as one %s object schema while the original validator still rejects mixed or missing branches', async (catalogKind) => {
    const parameters = toInputJsonSchema(SendMessageToThreadToolInputSchema);
    expect(Array.isArray(parameters['anyOf'])).toBe(true);
    const validator = compileToolArgsValidator(parameters);
    const tool = { name: 'ThreadSend', toolName: 'kiki_ThreadSend', description: 'Send to a thread.', parameters };
    const contextCall = vi.fn(async (input: { name: string; arguments: Record<string, unknown> }) => {
      const error = validateToolArgs(validator, input.arguments as never);
      return error === null ? { output: 'sent' } : { output: error, isError: true };
    });
    const contextCatalog = catalogKind === 'static'
      ? { delegation: false, tools: [tool] }
      : { delegation: false, nativeTools: true, tools: [tool] };
    const { client } = await connect(fakeKlient(), { contextCatalog, contextCall,
      contextList: catalogKind === 'dynamic' ? async () => contextCatalog : undefined });
    const listed = (await client.listTools()).tools.find((entry) => entry.name === 'kiki_ThreadSend');
    const schema = listed?.inputSchema as Record<string, unknown>;
    expect(['anyOf', 'oneOf', 'allOf'].filter((key) => key in schema)).toEqual([]);
    expect(schema).toMatchObject({ $schema: parameters['$schema'], type: 'object', required: ['content'], additionalProperties: false });
    expect(Object.keys(schema['properties'] as object).sort()).toEqual(['content', 'idempotency_key', 'mentions', 'room', 'thread']);
    expect(listed?.description).toBe('Send to a thread.\n\nInput constraint: use one of these parameter sets: (thread, content, idempotency_key) or (room, content).');
    const sent = { thread: { workspace_id: 'workspace-example', session_id: 'session-example' }, content: 'nonce', idempotency_key: 'nonce' };
    expect((await client.callTool({ name: 'kiki_ThreadSend', arguments: sent })).isError).not.toBe(true);
    expect(contextCall).toHaveBeenLastCalledWith({ name: 'ThreadSend', arguments: sent }, expect.any(AbortSignal));
    for (const invalid of [{ ...sent, room: 'room-example' }, { content: 'nonce' }, { thread: sent.thread, content: 'nonce' }]) {
      expect(validateToolArgs(validator, invalid as never)).not.toBeNull();
      expect((await client.callTool({ name: 'kiki_ThreadSend', arguments: invalid })).isError).toBe(true);
    }
  });

  it('folds only the root combinator: local $defs references, root constraints and allOf intersections survive', () => {
    const parameters = {
      $schema: 'http://json-schema.org/draft-07/schema#', title: 'Example', description: 'Root description', minProperties: 1,
      definitions: { Name: { type: 'string', minLength: 1 } },
      $defs: { Target: { type: 'object', properties: { id: { $ref: '#/definitions/Name' } }, required: ['id'], additionalProperties: false } },
      allOf: [
        { type: 'object', properties: { target: { $ref: '#/$defs/Target' }, mode: { type: 'string', enum: ['a', 'b'] }, shared: { type: 'string' } }, required: ['target'] },
        { type: 'object', properties: { target: {}, mode: { type: 'string', enum: ['b', 'c'] }, shared: { type: 'string' }, extra: { type: 'number' } }, required: ['mode'], additionalProperties: false },
      ],
    };
    const { schema, constraint } = mcpToolInputSchema(parameters);
    expect(constraint).toBeUndefined();
    expect(schema).toEqual({
      $schema: parameters.$schema, title: 'Example', description: 'Root description', minProperties: 1,
      definitions: parameters.definitions, $defs: parameters.$defs, type: 'object', additionalProperties: false,
      required: ['target', 'mode'],
      properties: {
        target: { $ref: '#/$defs/Target' },
        mode: { allOf: [{ type: 'string', enum: ['a', 'b'] }, { type: 'string', enum: ['b', 'c'] }] },
        shared: { type: 'string' },
        extra: { type: 'number' },
      },
    });
    const validator = compileToolArgsValidator(schema as Record<string, unknown>);
    expect(validateToolArgs(validator, { target: { id: 'x' }, mode: 'b' })).toBeNull();
    expect(validateToolArgs(validator, { target: { id: 'x' }, mode: 'a' })).not.toBeNull();
    expect(validateToolArgs(validator, { target: { id: '' }, mode: 'b' })).not.toBeNull();
    expect(validateToolArgs(validator, { target: { id: 'x' }, mode: 'b', unknown: true })).not.toBeNull();
  });

  it('keeps a property that an open union branch leaves undeclared unconstrained, and resolves branch $ref', () => {
    const $defs = { B: { properties: { a: { type: 'number' }, b: { type: 'string' } }, required: ['b'], additionalProperties: false } };
    const { schema, constraint } = mcpToolInputSchema({ type: 'object', $defs, oneOf: [
      { properties: { a: { type: 'string' } }, required: ['a'] },
      { $ref: '#/$defs/B' },
    ] });
    expect(schema).toEqual({ type: 'object', $defs, required: [],
      properties: { a: { anyOf: [{ type: 'string' }, { type: 'number' }] }, b: {} } });
    expect(constraint).toBe('Input constraint: use exactly one of these parameter sets: (a) or (b).');
  });

  it('registers the thirteen table-owned tools and preserves text/structured parity', async () => {
    const { client } = await connect(fakeKlient());
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name).toSorted()).toEqual([
      'kiki_cancel',
      'kiki_continue',
      'kiki_dispatch',
      'kiki_events',
      'kiki_interactions',
      'kiki_list',
      'kiki_profiles',
      'kiki_respond',
      'kiki_result',
      'kiki_send',
      'kiki_status',
      'kiki_transcript',
      'kiki_wait',
    ]);

    const listed = await client.callTool({ name: 'kiki_list', arguments: {} });
    expect(listed.isError).not.toBe(true);
    const content = listed.content as Array<{ readonly type: string; readonly text?: string }>;
    expect(JSON.parse(content[0]?.type === 'text' ? content[0].text ?? '' : '')).toEqual(
      listed.structuredContent,
    );
    expect(listed.structuredContent).toEqual({
      children: [],
      continuations: [],
      binding: { version: 1, sessionId: 'session-operator', workspacePath: '/example/workspace' },
    });
  });

  it('projects agent_notify with its lifecycle cursor through kiki_events', async () => {
    const { client } = await connect(fakeKlient([], {
      events: {
        items: [{ seq: 3, dispatchId: dispatch.dispatchId, type: 'agent_notify', at: 5, message: 'early finding', messageId: 'mailbox-1' }],
        nextCursor: undefined,
      },
    }));
    const response = await client.callTool({ name: 'kiki_events', arguments: { dispatch_id: dispatch.dispatchId, cursor: 2 } });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toEqual({
      items: [{ seq: 3, dispatchId: dispatch.dispatchId, type: 'agent_notify', at: 5, message: 'early finding', messageId: 'mailbox-1' }],
    });
  });

  it('uses each procedure codec for snake_case input and compatibility output', async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    const { client } = await connect(fakeKlient(calls));

    const dispatched = await client.callTool({
      name: 'kiki_dispatch',
      arguments: {
        target: 'named',
        task_name: 'probe',
        profile_name: 'explore',
        model_alias: 'model-a',
        thinking_effort: 'high',
        dispatch_key: 'dispatch-key',
        message: 'inspect',
      },
    });
    const sent = await client.callTool({
      name: 'kiki_send',
      arguments: {
        task_name: 'probe',
        message: 'inspect',
        idempotency_key: 'message-key',
      },
    });

    expect(calls).toEqual([
      {
        name: 'dispatch',
        input: {
          target: 'named',
          taskName: 'probe',
          profileName: 'explore',
          modelAlias: 'model-a',
          thinkingEffort: 'high',
          dispatchKey: 'dispatch-key',
          message: 'inspect',
        },
      },
      {
        name: 'send',
        input: { taskName: 'probe', message: 'inspect', idempotencyKey: 'message-key' },
      },
    ]);
    expect(dispatched.structuredContent).toMatchObject({
      dispatchId: 'dispatch-1',
      dispatch_key: 'dispatch-key',
      receipt: { dispatch_id: 'dispatch-1', dispatch_key: 'dispatch-key' },
    });
    expect(sent.structuredContent).toMatchObject({ idempotency_key: 'message-key' });
  });

  it('uses the seat HTTP procedure channel for stdio configuration', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      expect(href).toBe('http://127.0.0.1:58627/api/klient/delegation/dispatch');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer DELEGATION_SECRET');
      expect(new Headers(init?.headers).get('authorization')).not.toContain('DAEMON_SECRET');
      expect(JSON.parse(init?.body as string)).toEqual({
        target: 'named',
        taskName: 'probe',
        dispatchKey: 'dispatch-key',
        message: 'inspect',
      });
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: dispatch }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const server = createKikiMcpServer({
      endpoint: 'http://127.0.0.1:58627',
      delegationToken: 'DELEGATION_SECRET',
      sessionId: 'session-operator',
      workspacePath: '/example/workspace',
    }, { fetch: fetchMock });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close.push(() => client.close(), () => server.close());

    const called = await client.callTool({
      name: 'kiki_dispatch',
      arguments: {
        target: 'named',
        task_name: 'probe',
        dispatch_key: 'dispatch-key',
        message: 'inspect',
      },
    });

    expect(called.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('renders the frozen menu ceiling separately from current executable candidates', async () => {
    const { client } = await connect(fakeKlient([], { profiles: { profiles: [{ kind: 'named', profileName: 'helper',
      restrictModelsToMenu: true, declaredModelMenu: ['default', 'denied'], effectiveModelAliases: ['default'],
      modelMenuDiagnostics: ['outside is not an executable menu candidate'], alternativeModels: [] }], binding } }));
    await client.callTool({ name: 'kiki_profiles', arguments: {} });
    const tools = await client.listTools();
    const description = tools.tools.find((tool) => tool.name === 'kiki_dispatch')?.description;
    expect(description).toContain('Declared model menu (hard ceiling, restrict_models_to_menu): default, denied');
    expect(description).toContain('Effective model candidates: default');
    expect(description).toContain('Configuration diagnostic: outside is not an executable menu candidate');
  });

  it('refreshes dynamic profile descriptions for A, B, and an empty catalog', async () => {
    const catalogs = [
      [{ kind: 'named' as const, profileName: 'profile_a', description: 'Catalog A.', alternativeModels: [] }],
      [{ kind: 'named' as const, profileName: 'profile_b', description: 'Catalog B.', alternativeModels: [] }],
      [],
    ];
    let catalogIndex = 0;
    const klient = {
      ...fakeKlient(),
      async call(name: DelegationProcedureName) {
        if (name !== 'profiles') throw new Error(`Unexpected procedure ${name}`);
        return { profiles: catalogs[catalogIndex++]!, binding } as never;
      },
    } as SeatKlient;
    const { client } = await connect(klient);
    const profilesBase = delegationProcedureTable.find((procedure) => procedure.name === 'profiles')!.mcp.description;
    const dispatchBase = delegationProcedureTable.find((procedure) => procedure.name === 'dispatch')!.mcp.description;

    await client.callTool({ name: 'kiki_profiles', arguments: {} });
    const afterA = await client.listTools();
    expect(afterA.tools.find((tool) => tool.name === 'kiki_profiles')?.description).toContain('profile_a');
    expect(afterA.tools.find((tool) => tool.name === 'kiki_dispatch')?.description).toContain('profile_a');

    await client.callTool({ name: 'kiki_profiles', arguments: {} });
    const afterB = await client.listTools();
    expect(afterB.tools.find((tool) => tool.name === 'kiki_profiles')?.description).toContain('profile_b');
    expect(afterB.tools.find((tool) => tool.name === 'kiki_profiles')?.description).not.toContain('profile_a');
    expect(afterB.tools.find((tool) => tool.name === 'kiki_dispatch')?.description).toContain('profile_b');

    await client.callTool({ name: 'kiki_profiles', arguments: {} });
    const afterEmpty = await client.listTools();
    expect(afterEmpty.tools.find((tool) => tool.name === 'kiki_profiles')?.description).toBe(profilesBase);
    expect(afterEmpty.tools.find((tool) => tool.name === 'kiki_dispatch')?.description).toBe(dispatchBase);
  });

  it('leaves injected clients open and closes owned HTTP clients idempotently', async () => {
    const injected = fakeKlient();
    const injectedClose = vi.spyOn(injected, 'close');
    const injectedServer = createKikiMcpServer(injected);
    const injectedFirst = injectedServer.close();
    const injectedSecond = injectedServer.close();
    expect(injectedFirst).toBe(injectedSecond);
    await injectedFirst;
    expect(injectedClose).not.toHaveBeenCalled();

    let ownedSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      ownedSignal = init?.signal;
      ownedSignal?.addEventListener('abort', () => reject(ownedSignal?.reason), { once: true });
    }));
    const ownedServer = createKikiMcpServer({
      endpoint: 'http://127.0.0.1:58627',
      delegationToken: 'DELEGATION_SECRET',
      sessionId: 'session-operator',
      workspacePath: '/example/workspace',
    }, { fetch: fetchMock });
    const ownedClient = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([ownedServer.connect(serverTransport), ownedClient.connect(clientTransport)]);
    const pending = ownedClient.callTool({ name: 'kiki_list', arguments: {} });
    await vi.waitFor(() => expect(ownedSignal).toBeDefined());
    const ownedFirst = ownedServer.close();
    const ownedSecond = ownedServer.close();
    expect(ownedFirst).toBe(ownedSecond);
    await ownedFirst;
    expect(ownedSignal?.aborted).toBe(true);
    await Promise.allSettled([pending]);
    await ownedClient.close();
  });

  it('keeps the interaction ownership code aligned and ignores legacy daemon credentials', () => {
    expect(EXTERNAL_INTERACTION_NOT_OWNED_CODE).toBe(CORE_INTERACTION_NOT_OWNED_CODE);
    expect(kikiMcpConfigFromEnv({
      KIKI_KAP_ENDPOINT: 'http://127.0.0.1:58627',
      KIKI_KAP_TOKEN: 'LEGACY_DAEMON_SECRET',
      KIKI_DELEGATION_TOKEN: 'DELEGATION_SECRET',
      KIKI_SESSION_ID: 'session-operator',
      KIKI_WORKSPACE_PATH: '/example/workspace',
    })).toEqual({
      endpoint: 'http://127.0.0.1:58627',
      delegationToken: 'DELEGATION_SECRET',
      sessionId: 'session-operator',
      workspacePath: '/example/workspace',
      contextEnabled: false,
    });
    expect(() => kikiMcpConfigFromEnv({
      KIKI_KAP_ENDPOINT: 'http://127.0.0.1:58627',
      KIKI_DELEGATION_TOKEN: 'DELEGATION_SECRET',
      KIKI_SESSION_ID: 'session-operator',
      KIKI_WORKSPACE_PATH: 'relative/path',
    })).toThrow();
  });
});

async function connect(klient: SeatKlient, options?: Parameters<typeof createKikiMcpServer>[1]): Promise<{ client: Client }> {
  const server = createKikiMcpServer(klient, options);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  close.push(() => client.close(), () => server.close());
  return { client };
}

function fakeKlient(
  calls: Array<{ name: string; input: unknown }> = [],
  overrides: Partial<{ [Name in DelegationProcedureName]: DelegationProcedureOutput<Name> }> = {},
): SeatKlient {
  return {
    async call(name: DelegationProcedureName, input: unknown) {
      calls.push({ name, input });
      const output = overrides[name] ?? outputs[name];
      if (output === undefined) throw new Error(`Missing fixture for ${name}`);
      return output;
    },
    async close() {},
  } as unknown as SeatKlient;
}
