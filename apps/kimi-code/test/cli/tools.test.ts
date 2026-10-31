import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerToolsCommand } from '../../src/cli/sub/tools';

const { ensureServer, daemonRequest, api, createKlient } = vi.hoisted(() => {
  const api = { list: vi.fn(), update: vi.fn(), tools: vi.fn() };
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
