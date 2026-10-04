import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SpaceDomain } from '@kiki/protocol';
import { splitConfigCredentials } from '@kiki/agent-core-v2/app/config/credentials';

export function containsInlineMcpCredentials(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const credentials = splitConfigCredentials(value as Record<string, unknown>).credentials;
  const present = (entry: unknown): boolean => typeof entry === 'string' ? entry.length > 0 : entry !== null && typeof entry === 'object' ? Object.values(entry).some(present) : false;
  return present(credentials);
}

export interface SpaceResource {
  id: string;
  name: string;
  domain: SpaceDomain;
  value: unknown;
  files: Record<string, string>;
  dependencies: string[];
  blockedReason?: string;
}
export async function resourceFiles(home: string, relative: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  let bytes = 0;
  async function visit(path: string): Promise<void> {
    const info = await lstat(join(home, path));
    if (info.isSymbolicLink()) throw new Error('Linked resources cannot be frozen; save their content in this space first');
    if (info.isDirectory()) {
      for (const entry of await readdir(join(home, path))) {
        if (entry === '.git') continue;
        if (entry === '.env' || entry === 'credentials') throw new Error('Resource contains private account files; use its account flow instead of copying it');
        await visit(`${path}/${entry}`);
      }
    } else if (info.isFile()) {
      bytes += info.size;
      if (bytes > 64 * 1024 * 1024 || Object.keys(result).length >= 4096) throw new Error('Resource exceeds the 64 MiB / 4096 file snapshot limit');
      result[path] = (await readFile(join(home, path))).toString('base64');
    }
  }
  await visit(relative);
  return result;
}
async function entries(home: string, relative: string): Promise<string[]> {
  try { return (await readdir(join(home, relative))).filter((name) => !name.startsWith('.')).toSorted(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
export async function listSpaceResources(home: string): Promise<SpaceResource[]> {
  const result: SpaceResource[] = [];
  async function add(domain: SpaceDomain, identity: string, relative: string): Promise<void> {
    const id = `resource:${domain}:${identity}`;
    try {
      const files = await resourceFiles(home, relative);
      if (Object.keys(files).length === 0) return;
      const dependencies = domain === 'agents' && relative !== 'SYSTEM.md' && result.some((item) => item.id === 'resource:agents:SYSTEM.md') ? ['resource:agents:SYSTEM.md'] : [];
      const contentFile = Object.keys(files).find((path) => path === relative && /\.(?:md|json|toml)$/.test(path) || path.endsWith('/SKILL.md'));
      const content = contentFile === undefined ? undefined : Buffer.from(files[contentFile]!, 'base64').toString();
      result.push({ id, domain, name: identity, value: { files: Object.keys(files), bytes: Object.values(files).reduce((sum, data) => sum + Buffer.byteLength(data, 'base64'), 0), content: content !== undefined && Buffer.byteLength(content) <= 64 * 1024 ? content : undefined }, files, dependencies });
    } catch (error) {
      result.push({ id, domain, name: identity, value: null, files: {}, dependencies: [], blockedReason: error instanceof Error ? error.message : 'Resource unavailable' });
    }
  }
  for (const [domain, file] of [['agents', 'SYSTEM.md'], ['instructions', 'AGENTS.md']] as const) {
    if ((await lstat(join(home, file)).catch(() => undefined)) !== undefined) await add(domain, file, file);
  }
  for (const [domain, directory] of [['agents', 'agents'], ['skills', 'skills'], ['skills', 'commands'], ['appearance', 'themes']] as const) {
    for (const name of await entries(home, directory)) await add(domain, `${directory}/${name}`, `${directory}/${name}`);
  }
  const mcp = await readFile(join(home, 'mcp.json'), 'utf8').then((text) => JSON.parse(text) as { mcpServers?: Record<string, unknown> }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return { mcpServers: {} }; throw error;
  });
  for (const [name, value] of Object.entries(mcp.mcpServers ?? {})) {
    const secret = containsInlineMcpCredentials(value);
    result.push({ id: `resource:mcp:${name}`, domain: 'mcp', name, value: secret ? { requires_account: true } : value, files: {}, dependencies: [], blockedReason: secret ? 'Connection contains account data; use the dedicated MCP account flow' : undefined });
  }
  const installed = await readFile(join(home, 'plugins/installed.json'), 'utf8').then((text) => JSON.parse(text) as { plugins?: { id: string; root: string; enabled: boolean; capabilities?: unknown }[] }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return { plugins: [] }; throw error;
  });
  for (const plugin of installed.plugins ?? []) {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(plugin.id) || plugin.id.includes('..')) throw new Error('Invalid installed plugin identity');
    await add('plugins', plugin.id, `plugins/managed/${plugin.id}`);
    const item = result.find((entry) => entry.id === `resource:plugins:${plugin.id}`);
    if (item !== undefined) item.value = { id: plugin.id, enabled: plugin.enabled, capabilities: plugin.capabilities };
    else result.push({ id: `resource:plugins:${plugin.id}`, domain: 'plugins', name: plugin.id, value: { id: plugin.id, enabled: plugin.enabled }, files: {}, dependencies: [], blockedReason: 'Plugin has no managed content; reinstall it before freezing' });
  }
  return result;
}
