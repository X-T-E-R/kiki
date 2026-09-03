import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { mcpCommandConfig, upsertMcpServer } from '../../src/kiki/install';
import { createSeatOnConnection } from '../../src/kiki/seat';
import { mcpPrincipal } from '../../src/kiki/mcp';
import { parseDuration } from '../../src/kiki/serve';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('kiki command helpers', () => {
  it('parses daemon idle durations', () => {
    expect(parseDuration('250ms')).toBe(250);
    expect(parseDuration('45s')).toBe(45_000);
    expect(parseDuration('30m')).toBe(1_800_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(() => parseDuration('30')).toThrow('Invalid duration.');
  });

  it('derives a stable MCP principal from the workspace', () => {
    expect(mcpPrincipal('C:\\workspace')).toBe(mcpPrincipal('C:\\workspace'));
    expect(mcpPrincipal('C:\\workspace')).toMatch(/^mcp:[a-f0-9]{16}$/);
  });

  it('sends only the seat API contract fields', async () => {
    let body = '';
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      body = String(init.body);
      return new Response(JSON.stringify({
        code: 0,
        msg: 'success',
        data: {
          seatId: 'seat_example',
          sessionId: 'session_example',
          delegationToken: 'token',
          principal: 'cursor',
          workspace: 'C:\\workspace',
          mode: 'auto',
        },
      }));
    });
    await createSeatOnConnection(
      { url: 'http://127.0.0.1:58627', token: 'server-token', serverId: 'server' },
      {
        workspace: 'C:\\workspace',
        principal: 'cursor',
        mode: 'auto',
        json: true,
      } as never,
    );
    expect(JSON.parse(body)).toEqual({
      workspace: 'C:\\workspace',
      principal: 'cursor',
      mode: 'auto',
    });
  });

  it('backs up and replaces an existing kiki MCP entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-command-test-'));
    roots.push(root);
    const configPath = join(root, 'mcp.json');
    await writeFile(configPath, JSON.stringify({
      mcpServers: {
        other: { command: 'other' },
        kiki: { command: 'old' },
      },
    }));

    const config = mcpCommandConfig(root);
    const backup = await upsertMcpServer(configPath, config);
    expect(backup).toBeDefined();
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      mcpServers: {
        other: { command: 'other' },
        kiki: config,
      },
    });
    const names = await readdir(root);
    expect(names.filter((name) => name.startsWith('mcp.json.bak.'))).toHaveLength(1);
  });
});
