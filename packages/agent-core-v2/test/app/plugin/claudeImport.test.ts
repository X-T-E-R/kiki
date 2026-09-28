import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseManifest } from '#/app/plugin/manifest';
import { PluginManager } from '#/app/plugin/manager';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'kiki-claude-import-'));
  dirs.push(root);
  for (const segment of ['.claude-plugin', 'skills/research', 'agents', 'commands', 'hooks']) {
    await mkdir(path.join(root, segment), { recursive: true });
  }
  await writeFile(path.join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'claude-demo', version: '1.2.3', lspServers: {} }));
  await writeFile(path.join(root, 'skills/research/SKILL.md'), '# Research');
  await writeFile(path.join(root, 'agents/helper.md'), '# Helper');
  await writeFile(path.join(root, 'commands/draft.md'), '# Draft');
  await writeFile(path.join(root, 'hooks/hooks.json'), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'node check.js' }] }],
    UnknownEvent: [{ hooks: [{ type: 'prompt', prompt: 'not supported' }] }],
  } }));
  await writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: {
    local: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'] }, unsupported: { type: 'websocket', url: 'ws://example.com' },
  } }));
  return root;
}

describe('Claude Code read-only plugin import', () => {
  it('maps supported components and lists unsupported ones before installation', async () => {
    const root = await fixture();
    const parsed = await parseManifest(root);
    expect(parsed.manifestKind).toBe('claude-code');
    expect(parsed.manifest?.skills).toHaveLength(1);
    expect(parsed.manifest?.agents).toHaveLength(1);
    expect(parsed.manifest?.commands?.[0]?.name).toBe('draft');
    expect(parsed.manifest?.hooks).toHaveLength(1);
    expect(parsed.manifest?.mcpServers?.['local']?.transport).toBe('stdio');
    expect(parsed.manifest?.unsupportedComponents).toContain('lspServers');
    expect(parsed.manifest?.unsupportedComponents).toContain('hooks:UnknownEvent');
    const home = await mkdtemp(path.join(tmpdir(), 'kiki-claude-managed-'));
    dirs.push(home);
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    const plan = await manager.preview(root);
    expect(plan.unsupported).toContain('lspServers');
    expect(plan.consentRequired).toBe(true);
    await manager.install(root, { fingerprint: plan.fingerprint, consent: true });
    await manager.setEnabled('claude-demo', true);
    const server = manager.enabledMcpServers()['plugin-claude-demo:local'];
    expect(server?.transport).toBe('stdio');
    if (server?.transport !== 'stdio') throw new Error('Claude MCP server should use stdio');
    expect(path.normalize(server.args?.[0] ?? '')).toBe(path.join(home, 'plugins', 'managed', 'claude-demo', 'server.js'));
  });
});
