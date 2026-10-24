import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { windowsMcpEnvironmentResponseSchema, windowsMcpRegisterResponseSchema } from '@kiki/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authedFetch } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
}

describe('server-v2 Windows-MCP registration', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let layout: string | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    await Promise.all([home, layout].filter((dir): dir is string => dir !== undefined).map((dir) => rm(dir, { recursive: true, force: true })));
    home = undefined;
    layout = undefined;
  });

  it('describes the external executor and records an installed interpreter without starting it or selecting it', async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-windows-mcp-home-'));
    layout = await mkdtemp(join(tmpdir(), 'kiki-windows-mcp-layout-'));
    const python = join(layout, 'python.exe');
    const configPath = join(layout, 'config.toml');
    await writeFile(python, '');
    await writeFile(configPath, '[server]\ntransport = "stdio"\n');
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    const base = `http://127.0.0.1:${server.port}`;
    const described = await authedFetch(server, base, '/api/computer/windows-mcp');
    const description = await described.json() as Envelope<unknown>;
    expect(description.code).toBe(0);
    expect(windowsMcpEnvironmentResponseSchema.parse(description.data)).toMatchObject({
      version: '0.8.8',
      distribution: 'external-environment',
      managedInstall: 'withheld-until-gpl-acceptance',
      bundled: false,
      autoStart: false,
      connection: 'kiki-windows-mcp',
    });
    expect(windowsMcpEnvironmentResponseSchema.parse(description.data).licenses.map((item) => item.license)).toEqual([
      'MIT', 'GPL-2.0-only', 'GPL-2.0-or-later',
    ]);
    const missing = await authedFetch(server, base, '/api/computer/windows-mcp/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ python: join(layout, 'missing', 'python.exe'), configPath, version: '0.8.8' }),
    });
    const missingBody = await missing.json() as Envelope<unknown>;
    expect(missingBody.code).not.toBe(0);
    expect(missingBody.msg).toContain('does not exist');
    await expect(readFile(join(home, 'mcp.json'), 'utf8')).rejects.toThrow();
    const registered = await authedFetch(server, base, '/api/computer/windows-mcp/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ python, configPath, version: '0.8.8' }),
    });
    const registeredBody = await registered.json() as Envelope<unknown>;
    expect(registeredBody.code).toBe(0);
    expect(windowsMcpRegisterResponseSchema.parse(registeredBody.data)).toEqual({
      result: 'mcp-configured',
      name: 'kiki-windows-mcp',
      connection: 'kiki-windows-mcp',
      started: false,
      bundled: false,
    });
    const stored = await readFile(join(home, 'mcp.json'), 'utf8');
    expect(stored).toContain(python.replace(/\\/g, '\\\\'));
    expect(stored).toContain('windows_mcp');
    expect(stored).not.toContain('install');
    expect(stored).not.toContain('auth');
    const again = await authedFetch(server, base, '/api/computer/windows-mcp/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ python, configPath, version: '0.8.8' }),
    });
    const againBody = await again.json() as Envelope<{ result: string }>;
    expect(againBody.code).toBe(0);
    expect(againBody.data.result).toBe('existing-mcp-config-reused');
    const config = await authedFetch(server, base, '/api/config');
    const configBody = await config.json() as Envelope<{ computer_control: { connection?: string } }>;
    expect(configBody.code).toBe(0);
    expect(configBody.data.computer_control.connection).toBeUndefined();
    expect(stored).not.toContain(home);
  });
});
