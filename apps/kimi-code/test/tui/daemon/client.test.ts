import { describe, expect, it, vi } from 'vitest';
import { createKlient } from '@kiki/klient/http';

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
  const commands = { timing: vi.fn() };
  const session = vi.fn(() => ({ agent: vi.fn(() => agent), interactions, commands, agents: vi.fn() }));
  const klient = {
    global: { sessions, kosong: { listModels: vi.fn() } },
    session,
    close: vi.fn(),
  };
  return { klient, sessions, agent, interactions, commands };
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

  it('aborts an exact turn through the authenticated session command transport', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => ({
      json: async () => ({ code: 0, msg: 'ok', data: { aborted: true } }),
    }) as Response);
    const klient = createKlient({ endpoint: 'http://127.0.0.1:57580', token: 'secret', fetch: fetch as typeof globalThis.fetch });
    const client = new DaemonClient({ url: 'http://127.0.0.1:57580', token: 'secret', klient });
    try {
      await expect(client.abortTurn('session 1', 0)).resolves.toEqual({ aborted: true });
      expect(requestUrl(fetch.mock.calls[0]![0])).toBe('http://127.0.0.1:57580/api/sessions/session%201/turns/0:abort');
      expect(fetch.mock.calls[0]?.[1]).toMatchObject({
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
        body: '{}',
      });
    } finally {
      await client.close();
    }
  });

  it('delegates queued prompt timing changes through the session command transport', async () => {
    const fake = fakeKlient();
    fake.commands.timing.mockResolvedValue({
      prompt_id: 'prompt-1',
      append_timing: 'subagents_done',
      revision: 2,
    });
    const client = new DaemonClient({
      url: 'http://127.0.0.1:57580',
      token: 'secret',
      klient: fake.klient as never,
    });

    await expect(client.timingPrompt('session-1', 'prompt-1', {
      append_timing: 'subagents_done',
    })).resolves.toMatchObject({ prompt_id: 'prompt-1', append_timing: 'subagents_done' });
    expect(fake.commands.timing).toHaveBeenCalledWith('prompt-1', {
      append_timing: 'subagents_done',
    });
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
      'http://127.0.0.1:57580/api/models',
      'http://127.0.0.1:57580/api/agents?expand=true',
      'http://127.0.0.1:57580/api/sessions/session-1/skills',
      'http://127.0.0.1:57580/api/sessions/session-1/skills/review:activate',
      'http://127.0.0.1:57580/api/sessions/session-1/profile',
      'http://127.0.0.1:57580/api/sessions/session-1/profile',
      'http://127.0.0.1:57580/api/sessions/session-1/profile',
      'http://127.0.0.1:57580/api/sessions/session-1/profile',
    ]);
    expect(fetch.mock.calls.slice(3).map(([, init]) => jsonRequestBody(init))).toEqual([
      { args: 'staged changes' },
      { agent_config: { model: 'model-b' } },
      { agent_config: { permission_mode: 'auto' } },
      { agent_config: { profile: 'reviewer' } },
      { agent_config: { thinking: 'high' } },
    ]);
  });

  it('loads the active goal through the real kap-server envelope shape', async () => {
    const fake = fakeKlient();
    const goal = {
      goalId: 'goal-1',
      objective: 'Ship the release',
      status: 'active' as const,
      turnsUsed: 1,
      tokensUsed: 12,
      wallClockMs: 25,
      budget: {
        tokenBudget: null,
        turnBudget: null,
        wallClockBudgetMs: null,
        remainingTokens: null,
        remainingTurns: null,
        remainingWallClockMs: null,
        tokenBudgetReached: false,
        turnBudgetReached: false,
        wallClockBudgetReached: false,
        overBudget: false,
      },
    };
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => ({
      json: async () => ({ code: 0, msg: 'ok', data: goal }),
    }) as Response);
    const client = new DaemonClient({
      url: 'http://127.0.0.1:57580/',
      token: 'secret',
      fetch: fetch as typeof globalThis.fetch,
      klient: fake.klient as never,
    });

    await expect(client.getGoal('session 1')).resolves.toEqual(goal);
    expect(requestUrl(fetch.mock.calls[0]![0])).toBe(
      'http://127.0.0.1:57580/api/sessions/session%201/goal',
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer secret',
      },
    });
  });

  it('creates and renews server leases through kap-server REST', async () => {
    const fake = fakeKlient();
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => ({
      json: async () => ({
        code: 0,
        msg: 'ok',
        data: { lease_id: 'lease-1', expires_at: 1234 },
      }),
    }) as Response);
    const client = new DaemonClient({
      url: 'http://127.0.0.1:57580/',
      token: 'secret',
      fetch: fetch as typeof globalThis.fetch,
      klient: fake.klient as never,
    });

    await client.renewServerLease('lease-1');

    expect(requestUrl(fetch.mock.calls[0]![0])).toBe('http://127.0.0.1:57580/api/leases');
    expect(jsonRequestBody(fetch.mock.calls[0]?.[1])).toEqual({ lease_id: 'lease-1' });
  });

  it('updates a session-owned source overlay through kap-server REST', async () => {
    const fake = fakeKlient();
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => ({
      json: async () => ({ code: 0, msg: 'ok', data: { profiles: 1, skills: 2 } }),
    }) as Response);
    const client = new DaemonClient({
      url: 'http://127.0.0.1:57580/',
      token: 'secret',
      fetch: fetch as typeof globalThis.fetch,
      klient: fake.klient as never,
    });
    const body = {
      lease_id: 'lease-1',
      agent_files: ['reviewer.md'],
      skill_dirs: ['skills'],
    };

    await expect(client.updateSessionSourceOverlay('session 1', body)).resolves.toEqual({
      profiles: 1,
      skills: 2,
    });
    expect(requestUrl(fetch.mock.calls[0]![0])).toBe(
      'http://127.0.0.1:57580/api/sessions/session%201/source-overlay',
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
    expect(jsonRequestBody(fetch.mock.calls[0]?.[1])).toEqual(body);
  });

  it('loads transcript snapshots through the authenticated Klient view', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => ({
      json: async () => ({ code: 0, msg: 'ok', data: { as_of_seq: 4, epoch: 'e1' } }),
    }) as Response);
    const klient = createKlient({ endpoint: 'http://127.0.0.1:57580', token: 'secret', fetch: fetch as typeof globalThis.fetch, validate: false });
    const client = new DaemonClient({ url: 'http://127.0.0.1:57580', token: 'secret', klient });
    try {
      await expect(client.klient.session('session 1').view.snapshot()).resolves.toMatchObject({ as_of_seq: 4, epoch: 'e1' });
      expect(requestUrl(fetch.mock.calls[0]![0])).toBe('http://127.0.0.1:57580/api/klient/session-view/session%201/snapshot');
      expect(fetch.mock.calls[0]?.[1]).toMatchObject({ headers: { accept: 'application/json', authorization: 'Bearer secret' } });
    } finally {
      await client.close();
    }
  });
});
