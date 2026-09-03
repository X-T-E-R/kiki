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
    await client.setModel('session-1', 'kimi-k2');
    await client.setPermission('session-1', 'auto');
    await client.runCommand('session-1', 'status');
    await client.runShellCommand('session-1', 'pwd');

    expect(fake.sessions.create).toHaveBeenCalledWith({ workDir: 'C:\\repo' });
    expect(fake.agent.setModel).toHaveBeenCalledWith('kimi-k2');
    expect(fake.agent.setPermission).toHaveBeenCalledWith('auto');
    expect(fake.agent.runCommand).toHaveBeenCalledWith({ name: 'status', args: undefined });
    expect(fake.agent.runShellCommand).toHaveBeenCalledWith({ command: 'pwd' });
  });

  it('lists daemon sessions through authenticated kap-server REST', async () => {
    const fake = fakeKlient();
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => ({
      json: async () => ({
        code: 0,
        msg: 'ok',
        data: {
          items: [
            {
              id: 'session-1',
              title: 'Example',
              last_prompt: 'Hello',
              metadata: { cwd: 'C:\\repo' },
              updated_at: '2026-01-02T00:00:00.000Z',
            },
          ],
          has_more: false,
        },
      }),
    }) as Response);
    const client = new DaemonClient({
      url: 'http://127.0.0.1:57580',
      token: 'secret',
      fetch: fetch as typeof globalThis.fetch,
      klient: fake.klient as never,
    });

    await expect(client.listSessions(25)).resolves.toEqual({
      items: [
        {
          id: 'session-1',
          title: 'Example',
          lastPrompt: 'Hello',
          cwd: 'C:\\repo',
          updatedAt: Date.parse('2026-01-02T00:00:00.000Z'),
          custom: { cwd: 'C:\\repo' },
        },
      ],
      has_more: false,
    });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      'http://127.0.0.1:57580/api/v1/sessions?page_size=25',
    );
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
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
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
