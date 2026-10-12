import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createKlient } from '@kiki/klient/http';
import { getAgentToolContributions } from '@kiki/agent-core-v2/agent/toolRegistry/toolContribution';
import { agentCapabilitiesResponseSchema } from '@kiki/protocol';
import { startServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

it('does not register a core task board service', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kiki-no-board-'));
  const server = await startServer({ homeDir: home, host: '127.0.0.1', port: 0, hostIdentity: TEST_HOST_IDENTITY, logLevel: 'silent' });
  const client = createKlient({ endpoint: `http://127.0.0.1:${server.port}`, token: server.localOwnerToken });
  try {
    await expect(client.global.board.read({ action: 'preview', workspaceId: 'missing' })).rejects.toThrow(/unknown service: taskBoardService/);
    await expect(client.global.board.write({ action: 'create', workspaceId: 'missing', requestKey: 'create-one', title: 'Example' })).rejects.toThrow(/unknown service: taskBoardService/);
  } finally {
    await client.close();
    await server.close();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

it('does not mount board tools when the old experimental flag and env are set', async () => {
  const previous = process.env.KIKI_EXPERIMENTAL_TASK_BOARD;
  process.env.KIKI_EXPERIMENTAL_TASK_BOARD = 'true';
  const home = await mkdtemp(join(tmpdir(), 'kiki-no-board-flag-'));
  await writeFile(join(home, 'config.toml'), '[experimental]\ntask_board = true\n');
  const server = await startServer({ homeDir: home, host: '127.0.0.1', port: 0, hostIdentity: TEST_HOST_IDENTITY, logLevel: 'silent' });
  try {
    const names = getAgentToolContributions().map((entry) => entry.options.name);
    expect(names).not.toContain('BoardRead');
    expect(names).not.toContain('BoardWrite');
    const created = await (await authedFetch(server, `http://127.0.0.1:${server.port}`, '/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home } }),
    })).json() as { code: number; data: { id: string } };
    expect(created.code).toBe(0);
    const capabilities = await (await authedFetch(server, `http://127.0.0.1:${server.port}`, `/api/agents/capabilities?session_id=${created.data.id}&agent_id=main`)).json() as { code: number; data: unknown };
    expect(capabilities.code).toBe(0);
    const tools = agentCapabilitiesResponseSchema.parse(capabilities.data).tools ?? [];
    expect(tools.find((tool) => tool.name === 'BoardRead' || tool.name === 'BoardWrite')).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.KIKI_EXPERIMENTAL_TASK_BOARD;
    else process.env.KIKI_EXPERIMENTAL_TASK_BOARD = previous;
    await server.close();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
