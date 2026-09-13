import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EXTERNAL_INTERACTION_NOT_OWNED_CODE as CORE_INTERACTION_NOT_OWNED_CODE } from '@kiki/agent-core-v2';
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
      expect(JSON.parse(String(init?.body))).toEqual({
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
    });
    expect(() => kikiMcpConfigFromEnv({
      KIKI_KAP_ENDPOINT: 'http://127.0.0.1:58627',
      KIKI_DELEGATION_TOKEN: 'DELEGATION_SECRET',
      KIKI_SESSION_ID: 'session-operator',
      KIKI_WORKSPACE_PATH: 'relative/path',
    })).toThrow();
  });
});

async function connect(klient: SeatKlient): Promise<{ client: Client }> {
  const server = createKikiMcpServer(klient);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  close.push(() => client.close(), () => server.close());
  return { client };
}

function fakeKlient(calls: Array<{ name: string; input: unknown }> = []): SeatKlient {
  return {
    async call(name: DelegationProcedureName, input: unknown) {
      calls.push({ name, input });
      const output = outputs[name];
      if (output === undefined) throw new Error(`Missing fixture for ${name}`);
      return output;
    },
    async close() {},
  } as unknown as SeatKlient;
}
