import { Command } from 'commander';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerToolsCommand } from '../../src/cli/sub/tools';

const { ensureServer, daemonRequest, api, createKlient } = vi.hoisted(() => {
  const api = { list: vi.fn(), update: vi.fn(), tools: vi.fn(), credential: vi.fn() };
  return { ensureServer: vi.fn(), daemonRequest: vi.fn(), api,
    createKlient: vi.fn(() => ({ rest: { externalClients: api }, close: vi.fn() })) };
});
vi.mock('../../src/kiki/serve', () => ({ ensureServer }));
vi.mock('../../src/kiki/seat', () => ({ daemonRequest }));
vi.mock('@kiki/klient/http', () => ({ createKlient }));
let output: string;
async function invoke(args: string[]) {
  const command = new Command('kiki');
  registerToolsCommand(command);
  await command.parseAsync(['node', 'kiki', 'tools', ...args]);
  return JSON.parse(output.trim());
}
beforeEach(() => {
  vi.clearAllMocks();
  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((value) => { output += String(value); return true; });
  process.exitCode = 0;
  ensureServer.mockResolvedValue({ url: 'http://127.0.0.1:12345', token: 'fixture-owner', serverId: 'fixture-server' });
  api.list.mockResolvedValue({ connections: [{ id: 'example', tools: ['Read'], allowCommands: false }],
    toolCatalog: [{ pluginId: 'media', tools: [{ name: 'plugin__media__generate', requiresCommands: true }] }] });
  api.update.mockResolvedValue({ connection: { id: 'example' } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; });

describe('script tools CLI owner commands', () => {
  it('exports a private new file without printing the credential and refuses overwrite before minting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-tools-credential-'));
    const path = join(root, 'credential');
    try {
      api.credential.mockResolvedValue({ token: 'kec_private_fixture' });
      expect(await invoke(['--home', root, '--client', 'example', 'credential', '--output', path]))
        .toEqual({ output: path, server_url: 'http://127.0.0.1:12345' });
      expect(await readFile(path, 'utf8')).toBe('kec_private_fixture');
      expect(output).not.toContain('kec_private_fixture');
      if (process.platform === 'win32') {
        const acl = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command',
          '$acl=Get-Acl -LiteralPath $env:KIKI_TEST_ACL_FILE; ConvertTo-Json -Compress @{protected=$acl.AreAccessRulesProtected; count=@($acl.Access).Count; inherited=@($acl.Access | Where-Object IsInherited).Count}'], { env: { ...process.env, KIKI_TEST_ACL_FILE: path } });
        expect(JSON.parse(acl.stdout)).toEqual({ protected: true, count: 1, inherited: 0 });
      } else {
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }
      await writeFile(path, 'keep-existing');
      output = '';
      expect(await invoke(['--home', root, '--client', 'example', 'credential', '--output', path]))
        .toMatchObject({ error: expect.stringContaining('EEXIST') });
      expect(await readFile(path, 'utf8')).toBe('keep-existing');
      expect(api.credential).toHaveBeenCalledTimes(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('removes a new empty credential file when minting fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-tools-credential-'));
    const path = join(root, 'credential');
    try {
      api.credential.mockRejectedValueOnce(new Error('connection revoked'));
      expect(await invoke(['--home', root, '--client', 'example', 'credential', '--output', path]))
        .toEqual({ error: 'connection revoked' });
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('adds explicit plugin grants through the local owner without using the connection credential', async () => {
    vi.stubEnv('KIKI_EXTERNAL_CLIENT_TOKEN', 'fixture-connection');
    expect(await invoke(['--home', 'E:/fixture-home', '--client', 'example', 'grant', 'plugin__media__generate', '--allow-commands']))
      .toEqual({ connection: { id: 'example' } });
    expect(createKlient).toHaveBeenCalledWith({ endpoint: 'http://127.0.0.1:12345', token: 'fixture-owner' });
    expect(api.update).toHaveBeenCalledWith('example', { tools: ['Read', 'plugin__media__generate'], allowCommands: true });
    expect(daemonRequest).not.toHaveBeenCalled();
    expect(output).not.toMatch(/fixture-owner|fixture-connection/);
  });
  it('requires explicit consent for unrestricted plugin tools and requires a local client id', async () => {
    expect(await invoke(['--home', 'E:/fixture-home', '--client', 'example', 'grant', 'plugin__media__generate']))
      .toMatchObject({ error: expect.stringContaining('--allow-commands') });
    expect(api.update).not.toHaveBeenCalled();
    output = '';
    expect(await invoke(['grant', 'Read'])).toMatchObject({ error: expect.stringContaining('--client') });
  });
});
