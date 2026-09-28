import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { HookDefSchema, type HookDefConfig } from '#/features/externalHooks/configSection';
import { McpServerConfigSchema, type McpServerConfig } from '#/mcpCore/config-schema';
import type { PluginCommandEntry, PluginDiagnostic, PluginManifest } from './types';

const HOOK_EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'UserPromptSubmit',
  'Stop', 'SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop', 'PreCompact',
]);
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

async function readJson(file: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

async function ownFile(root: string, candidate: string): Promise<boolean> {
  const base = await realpath(root);
  const file = await realpath(candidate).catch(() => undefined);
  if (file === undefined) return false;
  const relative = path.relative(base, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) && (await stat(file)).isFile();
}

export async function importClaudePlugin(root: string, manifestPath: string): Promise<{
  readonly manifest?: PluginManifest;
  readonly diagnostics: readonly PluginDiagnostic[];
}> {
  const diagnostics: PluginDiagnostic[] = [];
  const unsupported: string[] = [];
  const raw = await readJson(manifestPath);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { diagnostics: [{ severity: 'error', message: 'Claude Code plugin manifest must be an object' }] };
  }
  const doc = raw as Record<string, unknown>;
  const name = doc['name'];
  if (typeof name !== 'string' || !NAME.test(name)) {
    return { diagnostics: [{ severity: 'error', message: 'Claude Code plugin name is invalid' }] };
  }
  for (const key of Object.keys(doc)) {
    if (!['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords'].includes(key)) unsupported.push(`manifest:${key}`);
  }
  const skills: string[] = [];
  const skillRoot = path.join(root, 'skills');
  for (const item of await readdir(skillRoot, { withFileTypes: true }).catch(() => [])) {
    if (item.isDirectory() && await ownFile(root, path.join(skillRoot, item.name, 'SKILL.md'))) {
      skills.push(path.join(skillRoot, item.name));
    } else unsupported.push(`skills/${item.name}`);
  }
  const agentRoot = path.join(root, 'agents');
  const agents = (await stat(agentRoot).then((value) => value.isDirectory(), () => false)) ? [agentRoot] : [];
  const commands: PluginCommandEntry[] = [];
  const commandRoot = path.join(root, 'commands');
  for (const item of await readdir(commandRoot, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(commandRoot, item.name);
    if (item.isFile() && item.name.endsWith('.md') && await ownFile(root, file)) {
      commands.push({ name: item.name.slice(0, -3), path: file });
    } else unsupported.push(`commands/${item.name}`);
  }
  const hooks: HookDefConfig[] = [];
  const hooksRaw = await readJson(path.join(root, 'hooks', 'hooks.json'));
  if (hooksRaw !== undefined) {
    const mapping = typeof hooksRaw === 'object' && hooksRaw !== null && !Array.isArray(hooksRaw)
      ? (hooksRaw as Record<string, unknown>)['hooks'] : undefined;
    if (typeof mapping !== 'object' || mapping === null || Array.isArray(mapping)) unsupported.push('hooks/hooks.json');
    else for (const [event, groups] of Object.entries(mapping)) {
      if (!HOOK_EVENTS.has(event) || !Array.isArray(groups)) { unsupported.push(`hooks:${event}`); continue; }
      for (const [index, group] of groups.entries()) {
        if (typeof group !== 'object' || group === null || !Array.isArray((group as Record<string, unknown>)['hooks'])) {
          unsupported.push(`hooks:${event}[${index}]`); continue;
        }
        const record = group as { matcher?: unknown; hooks: unknown[] };
        for (const hook of record.hooks) {
          if (typeof hook !== 'object' || hook === null) { unsupported.push(`hooks:${event}[${index}]`); continue; }
          const rawHook = hook as Record<string, unknown>;
          const value = HookDefSchema.safeParse({
            event, matcher: record.matcher, timeout: typeof rawHook['timeout'] === 'number' ? rawHook['timeout'] : undefined,
            command: typeof rawHook['command'] === 'string'
              ? rawHook['command'].replaceAll('${CLAUDE_PLUGIN_ROOT}', '${KIKI_PLUGIN_ROOT}') : undefined,
          });
          if (rawHook['type'] !== 'command' || !value.success) unsupported.push(`hooks:${event}[${index}]:${String(rawHook['type'])}`);
          else hooks.push(value.data);
        }
      }
    }
  }
  const mcpServers: Record<string, McpServerConfig> = {};
  const mcpRaw = await readJson(path.join(root, '.mcp.json'));
  if (mcpRaw !== undefined) {
    const map = typeof mcpRaw === 'object' && mcpRaw !== null && !Array.isArray(mcpRaw)
      ? (mcpRaw as Record<string, unknown>)['mcpServers'] : undefined;
    if (typeof map !== 'object' || map === null || Array.isArray(map)) unsupported.push('.mcp.json');
    else for (const [id, spec] of Object.entries(map)) {
      const value = typeof spec === 'object' && spec !== null && !Array.isArray(spec)
        ? spec as Record<string, unknown> : {};
      const { type, ...rest } = value;
      const parsed = McpServerConfigSchema.safeParse({ ...rest, transport: type === 'http' || type === 'sse' ? type : (value['command'] ? 'stdio' : 'http') });
      if (!NAME.test(id) || !parsed.success) unsupported.push(`mcp:${id}`);
      else mcpServers[id] = parsed.data;
    }
  }
  for (const component of ['lspServers', 'outputStyles', 'bin', 'scripts']) {
    if (doc[component] !== undefined || await stat(path.join(root, component)).then(() => true, () => false)) unsupported.push(component);
  }
  if (unsupported.length) diagnostics.push({ severity: 'info', message: `Claude Code components not imported: ${unsupported.join(', ')}` });
  return {
    manifest: {
      name, version: typeof doc['version'] === 'string' ? doc['version'] : undefined,
      description: typeof doc['description'] === 'string' ? doc['description'] : undefined,
      skills, agents, commands, hooks, mcpServers, unsupportedComponents: unsupported,
    },
    diagnostics,
  };
}
