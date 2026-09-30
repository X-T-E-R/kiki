import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { IHarnessMcpService, IAgentProfileService, ensureMainAgent, resumeSessionById } from '@kiki/agent-core-v2';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

import { startServer } from '../src/start';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const require = createRequire(import.meta.url);

describe('attached harness MCP', () => {
  it('runs the actual stdio CLI against the existing main session and revokes disabled/released bindings', { timeout: 60_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-harness-bridge-'));
    const server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    const client = new Client({ name: 'harness-fixture', version: '1' });
    let lease: Awaited<ReturnType<IHarnessMcpService['acquire']>> | undefined;
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const created = await fetch(`${base}/api/sessions`, { method: 'POST', headers: authHeaders(server, { 'content-type': 'application/json' }), body: JSON.stringify({ metadata: { cwd: home } }) });
      expect(created.status).toBe(200);
      const sessionId = ((await created.json()) as { data: { id: string } }).data.id;
      const session = (await resumeSessionById(server.core.accessor, sessionId))!;
      const main = await ensureMainAgent(session);
      const profile = main.accessor.get(IAgentProfileService);
      const binding = profile.data();
      profile.applyBindingSnapshot({ ...binding, allowKikiSubagents: true });
      lease = await server.core.accessor.get(IHarnessMcpService).acquire({ sessionId, agentId: main.id, workspacePath: home });
      expect(lease.server).toMatchObject({ name: 'kiki-harness', args: ['mcp', '--workspace', home, '--attached'] });
      if (!('command' in lease.server)) throw new Error('Expected stdio bridge');
      const env = Object.fromEntries(lease.server.env.map(({ name, value }) => [name, value]));
      const call = async () => {
        const response = await fetch(`${base}/api/klient/delegation/list`, { method: 'POST', headers: { authorization: `Bearer ${env['KIKI_DELEGATION_TOKEN']}`, 'content-type': 'application/json' }, body: '{}' });
        return { status: response.status, body: await response.json() as { code: number } };
      };
      expect(await call()).toMatchObject({ status: 200, body: { code: 0 } });
      const cli = fileURLToPath(new URL('../../../apps/kimi-code/src/main.ts', import.meta.url));
      const loader = new URL('../../../build/register-raw-text-loader.mjs', import.meta.url).href;
      await client.connect(new StdioClientTransport({ command: process.execPath,
        args: ['--import', pathToFileURL(require.resolve('tsx/esm')).href, '--import', loader, cli, ...lease.server.args],
        env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), ...env,
          TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../apps/kimi-code/tsconfig.dev.json', import.meta.url)) }, cwd: home,
      }));
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(13);
      const listed = await client.callTool({ name: 'kiki_list', arguments: {} });
      expect(listed.isError).not.toBe(true);
      expect(listed.structuredContent).toMatchObject({ binding: { sessionId, workspacePath: home } });
      const seats = await fetch(`${base}/api/external-delegation/seats`, { headers: authHeaders(server) });
      expect(await seats.json()).toMatchObject({ code: 0, data: [] });
      profile.applyBindingSnapshot({ ...binding, allowKikiSubagents: false });
      expect((await call()).body.code).not.toBe(0);
      profile.applyBindingSnapshot({ ...binding, allowKikiSubagents: true });
      expect((await call()).body.code).toBe(0);
      lease.dispose();
      expect((await call()).status).toBe(401);
    } finally {
      await client.close();
      lease?.dispose();
      await server.close();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});
