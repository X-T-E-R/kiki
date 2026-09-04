import { describe, expect, it, vi } from 'vitest';

import { DaemonClient } from '#/tui/daemon/client';

function fakeKlient() {
  const sessions = { list: vi.fn(), create: vi.fn() };
  const agent = {
    prompt: vi.fn(),
    setModel: vi.fn(),
    setPermission: vi.fn(),
    runCommand: vi.fn(),
    runShellCommand: vi.fn(),
  };
  const interactions = {
    list: vi.fn(),
    respond: vi.fn(),
    acquireConsumer: vi.fn(),
    releaseConsumer: vi.fn(),
  };
  const session = vi.fn(() => ({ agent: vi.fn(() => agent), interactions, agents: vi.fn() }));
  const klient = {
    global: { sessions, kosong: { listModels: vi.fn() } },
    session,
    close: vi.fn(),
  };
  return { klient, sessions, agent, interactions };
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function jsonRequestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body.');
  return JSON.parse(init.body) as unknown;
}

describe('DaemonClient', () => {
  it('uses klient http facades for creation and agent commands', async () => {
    const fake = fakeKlient();
    fake.sessions.create.mockResolvedValue({ id: 'session-1' });
    const client = new DaemonClient({
      url: 'http://127.0.0.1:57580',
      token: 'secret',
      klient: fake.klient as never,
    });

    await client.createSession({ workDir: 'C:\\repo' });
    await client.runShellCommand('session-1', 'pwd');

    expect(fake.sessions.create).toHaveBeenCalledWith({ workDir: 'C:\\repo' });
    expect(fake.agent.runShellCommand).toHaveBeenCalledWith({ command: 'pwd' });
  });

  it('lists daemon sessions through the klient keyset facade', async () => {
    const fake = fakeKlient();
    fake.sessions.list.mockResolvedValue({
      items: [
        {
          id: 'session-1',
          title: 'Example',
          lastPrompt: 'Hello',
          cwd: 'C:\\repo',
          updatedAt: 123,
          custom: { source: 'test' },
        },
      ],
      nextCursor: 'session-0',
    });
    const client = new DaemonClient({
      url: 'http://127.0.0.1:57580',
      token: 'secret',
      klient: fake.klient as never,
    });

    await expect(client.listSessions(25, 'session-2')).resolves.toEqual({
      items: [
        {
          id: 'session-1',
          title: 'Example',
          lastPrompt: 'Hello',
          cwd: 'C:\\repo',
          updatedAt: 123,
          custom: { source: 'test' },
        },
      ],
      nextCursor: 'session-0',
    });
    expect(fake.sessions.list).toHaveBeenCalledWith({
      limit: 25,
      before: 'session-2',
      includeArchived: false,
    });
  });

  it('uses REST model, agent profile, and session profile endpoints', async () => {
    const fake = fakeKlient();
    const fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => ({
      json: async () => ({
        code: 0,
        msg: 'ok',
        data: requestUrl(input).endsWith('/models') || requestUrl(input).includes('/agents?')
          ? { items: [] }
          : { id: 'session-1' },
      }),
    }) as Response);
    const client = new DaemonClient({
      url: 'http://127.0.0.1:57580',
      token: 'secret',
      fetch: fetch as typeof globalThis.fetch,
      klient: fake.klient as never,
    });

    await client.listModels();
    await client.listAgentProfiles();
    await client.listSkills('session-1');
    await client.activateSkill('session-1', 'review', 'staged changes');
    await client.setModel('session-1', 'model-b');
    await client.setPermission('session-1', 'auto');
    await client.setProfile('session-1', 'reviewer');
    await client.setThinking('session-1', 'high');

    expect(fetch.mock.calls.map(([input]) => requestUrl(input))).toEqual([
      'http://127.0.0.1:57580/api/v1/models',
      'http://127.0.0.1:57580/api/v1/agents?expand=true',
      'http://127.0.0.1:57580/api/v1/sessions/session-1/skills',
      'http://127.0.0.1:57580/api/v1/sessions/session-1/skills/review:activate',
      'http://127.0.0.1:57580/api/v1/sessions/session-1/profile',
      'http://127.0.0.1:57580/api/v1/sessions/session-1/profile',
      'http://127.0.0.1:57580/api/v1/sessions/session-1/profile',
      'http://127.0.0.1:57580/api/v1/sessions/session-1/profile',
    ]);
    expect(fetch.mock.calls.slice(3).map(([, init]) => jsonRequestBody(init))).toEqual([
      { args: 'staged changes' },
      { agent_config: { model: 'model-b' } },
      { agent_config: { permission_mode: 'auto' } },
      { agent_config: { profile: 'reviewer' } },
      { agent_config: { thinking: 'high' } },
    ]);
  });

  it('loads transcript snapshots through authenticated kap-server REST', async () => {
    const fake = fakeKlient();
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => ({
      json: async () => ({ code: 0, msg: 'ok', data: { as_of_seq: 4, epoch: 'e1' } }),
    }) as Response);
    const client = new DaemonClient({
      url: 'http://127.0.0.1:57580/',
      token: 'secret',
      fetch: fetch as typeof globalThis.fetch,
      klient: fake.klient as never,
    });

    await expect(client.snapshot('session 1', { transcript: true })).resolves.toMatchObject({
      as_of_seq: 4,
      epoch: 'e1',
    });
    expect(requestUrl(fetch.mock.calls[0]![0])).toBe(
      'http://127.0.0.1:57580/api/v1/sessions/session%201/snapshot?mode=transcript',
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer secret',
      },
    });
  });
});
