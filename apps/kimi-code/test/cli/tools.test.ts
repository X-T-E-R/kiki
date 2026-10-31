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
  it('reuses an unexpired credential in-process and refreshes after expiry or a server restart', async () => {
    vi.stubEnv('KIKI_EXTERNAL_CLIENT_TOKEN', undefined);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    daemonRequest.mockResolvedValue({ token: 'kec_cache_fixture', expiresAt: 3_601_000 });
    api.tools.mockResolvedValue({ tools: [] });
    const args = ['--home', 'E:/fixture-cache-home', '--client', 'cache-example', 'list'];
    await invoke(args); output = '';
    await invoke(args); output = '';
    expect(daemonRequest).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(3_601_001);
    await invoke(args); output = '';
    expect(daemonRequest).toHaveBeenCalledTimes(2);
    ensureServer.mockResolvedValue({ url: 'http://127.0.0.1:12345', token: 'fixture-owner', serverId: 'restarted-server' });
    await invoke(args);
    expect(daemonRequest).toHaveBeenCalledTimes(3);
    expect(output).not.toContain('kec_cache_fixture');
  });
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


describe('documented operation polling', () => {
  it('uses the displayed external-client settings labels and states Windows shell prerequisites', async () => {
    const dictionaries = await Promise.all([
      import('@kiki/session-core/i18n/en'), import('@kiki/session-core/i18n/zh'),
    ]);
    for (const [locale, labels] of [['en', dictionaries[0].en], ['zh', dictionaries[1].zh]] as const) {
      const expected = `${labels['st.section.externalAccess']} → ${labels['st.section.externalClients']}`;
      for (const path of ['server/script-tools.md', 'server/mcp.md', 'guides/settings.md']) {
        const doc = await readFile(new URL(`../../../../docs/${locale}/${path}`, import.meta.url), 'utf8');
        expect(doc).toContain(expected);
        expect(doc).not.toMatch(/Agents & clients|Agent 与客户端|智能体与客户端/);
        if (path === 'server/script-tools.md') expect(doc).toMatch(/Windows[^\n]*Python[^\n]*jq[^\n]*Git Bash|Windows[^\n]*Python[^\n]*Git Bash[^\n]*jq/);
      }
    }
  });
  it('keeps Shell, Python and Node.js waiting through approval in both locales', async () => {
    const en = await readFile(new URL('../../../../docs/en/server/script-tools.md', import.meta.url), 'utf8');
    const zh = await readFile(new URL('../../../../docs/zh/server/script-tools.md', import.meta.url), 'utf8');
    const blocks = (doc: string) => [...doc.matchAll(/```(sh|python|js)\n([\s\S]*?)```/g)].map((match) => match[2]);
    expect(blocks(zh)).toEqual(blocks(en));
    const python = /def tool\([\s\S]*?\n    return result/.exec(en)![0];
    const pythonResult = await promisify(execFile)(process.platform === 'win32' ? 'python' : 'python3', ['-c', `
import json
class Clock:
    def monotonic(self): return 0
    def sleep(self, seconds): pass
time = Clock()
session = 'fixture'
count = 0
def api(path, body=None):
    global count
    count += 1
    return {'structuredContent': {'operation_id': 'same-operation', 'state': 'waiting_approval' if count < 3 else 'completed', 'result': {}}}
${python}
assert tool('Write', {}, 'stable-key')['state'] == 'completed'
assert count == 3
`]);
    expect(pythonResult.stderr).toBe('');
    const node = /async function tool\([\s\S]*?\n}/.exec(en)![0];
    const nodeResult = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
let count = 0; const session = 'fixture';
const delay = async () => {};
const api = async () => ({ structuredContent: { operation_id: 'same-operation', state: ++count < 3 ? 'waiting_approval' : 'completed', result: {} } });
${node}
if ((await tool('Write', {}, 'stable-key')).state !== 'completed' || count !== 3) throw new Error('Approval polling stopped early');
`]);
    expect(nodeResult.stderr).toBe('');
    const shell = /wait_operation\(\) \{[\s\S]*?\n}/.exec(en)![0];
    const root = await mkdtemp(join(tmpdir(), 'kiki-script-poll-'));
    try {
      const result = await promisify(execFile)('bash', ['-c', `set -eu
sleep() { :; }
jq() { IFS= read -r value; printf '%s\\n' "$value"; }
tools() {
  n=0; if [ -f "$POLL_COUNT" ]; then read n < "$POLL_COUNT"; fi
  n=$((n + 1)); printf '%s\\n' "$n" > "$POLL_COUNT"
  if [ "$n" -lt 3 ]; then printf 'waiting_approval\\n'; else printf 'completed\\n'; fi
}
${shell}
wait_operation same-operation
`], { env: { ...process.env, POLL_COUNT: join(root, 'count').replaceAll('\\', '/') } });
      expect(result.stdout.trim()).toBe('completed');
      expect((await readFile(join(root, 'count'), 'utf8')).trim()).toBe('3');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
