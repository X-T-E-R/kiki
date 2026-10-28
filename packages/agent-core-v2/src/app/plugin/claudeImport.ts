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

function checkAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

async function readJson(file: string, signal?: AbortSignal): Promise<unknown> {
  try {
    checkAborted(signal);
    const content = await readFile(file, { encoding: 'utf8', signal });
    checkAborted(signal);
    return JSON.parse(content);
  } catch (error) {
    checkAborted(signal);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function ownFile(root: string, candidate: string, signal?: AbortSignal): Promise<boolean> {
  checkAborted(signal);
  const base = await realpath(root);
  checkAborted(signal);
  let file: string | undefined;
  try {
    checkAborted(signal);
    file = await realpath(candidate);
    checkAborted(signal);
  } catch {
    checkAborted(signal);
    file = undefined;
  }
  if (file === undefined) return false;
  const relative = path.relative(base, file);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  checkAborted(signal);
  const fileStat = await stat(file);
  checkAborted(signal);
  return fileStat.isFile();
}

export async function importClaudePlugin(root: string, manifestPath: string, signal?: AbortSignal): Promise<{
  readonly manifest?: PluginManifest;
  readonly diagnostics: readonly PluginDiagnostic[];
}> {
  checkAborted(signal);
  const diagnostics: PluginDiagnostic[] = [];
  const unsupported: string[] = [];
  const raw = await readJson(manifestPath, signal);
  checkAborted(signal);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { diagnostics: [{ severity: 'error', message: 'Claude Code plugin manifest must be an object' }] };
  }
  const doc = raw as Record<string, unknown>;
  const name = doc['name'];
  if (typeof name !== 'string' || !NAME.test(name)) {
    return { diagnostics: [{ severity: 'error', message: 'Claude Code plugin name is invalid' }] };
  }
  for (const key of Object.keys(doc)) {
    checkAborted(signal);
    if (!['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords'].includes(key)) unsupported.push(`manifest:${key}`);
  }
  const skills: string[] = [];
  const skillRoot = path.join(root, 'skills');
  checkAborted(signal);
  const skillEntries = await readdir(skillRoot, { withFileTypes: true }).catch(() => {
    checkAborted(signal);
    return [];
  });
  checkAborted(signal);
  for (const item of skillEntries) {
    checkAborted(signal);
    if (item.isDirectory() && await ownFile(root, path.join(skillRoot, item.name, 'SKILL.md'), signal)) {
      checkAborted(signal);
      skills.push(path.join(skillRoot, item.name));
    } else unsupported.push(`skills/${item.name}`);
  }
  checkAborted(signal);
  const agentRoot = path.join(root, 'agents');
  let hasAgentsDirectory = false;
  try {
    checkAborted(signal);
    const agentStat = await stat(agentRoot);
    checkAborted(signal);
    hasAgentsDirectory = agentStat.isDirectory();
  } catch {
    checkAborted(signal);
  }
  const agents = hasAgentsDirectory ? [agentRoot] : [];
  const commands: PluginCommandEntry[] = [];
  const commandRoot = path.join(root, 'commands');
  checkAborted(signal);
  const commandEntries = await readdir(commandRoot, { withFileTypes: true }).catch(() => {
    checkAborted(signal);
    return [];
  });
  checkAborted(signal);
  for (const item of commandEntries) {
    checkAborted(signal);
    const file = path.join(commandRoot, item.name);
    if (item.isFile() && item.name.endsWith('.md') && await ownFile(root, file, signal)) {
      checkAborted(signal);
      commands.push({ name: item.name.slice(0, -3), path: file });
    } else unsupported.push(`commands/${item.name}`);
  }
  checkAborted(signal);
  const hooks: HookDefConfig[] = [];
  const hooksRaw = await readJson(path.join(root, 'hooks', 'hooks.json'), signal);
  checkAborted(signal);
  if (hooksRaw !== undefined) {
    const mapping = typeof hooksRaw === 'object' && hooksRaw !== null && !Array.isArray(hooksRaw)
      ? (hooksRaw as Record<string, unknown>)['hooks'] : undefined;
    if (typeof mapping !== 'object' || mapping === null || Array.isArray(mapping)) unsupported.push('hooks/hooks.json');
    else for (const [event, groups] of Object.entries(mapping)) {
      checkAborted(signal);
      if (!HOOK_EVENTS.has(event) || !Array.isArray(groups)) { unsupported.push(`hooks:${event}`); continue; }
      for (const [index, group] of groups.entries()) {
        checkAborted(signal);
        if (typeof group !== 'object' || group === null || !Array.isArray((group as Record<string, unknown>)['hooks'])) {
          unsupported.push(`hooks:${event}[${index}]`); continue;
        }
        const record = group as { matcher?: unknown; hooks: unknown[] };
        for (const hook of record.hooks) {
          checkAborted(signal);
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
  checkAborted(signal);
  const mcpServers: Record<string, McpServerConfig> = {};
  const mcpRaw = await readJson(path.join(root, '.mcp.json'), signal);
  checkAborted(signal);
  if (mcpRaw !== undefined) {
    const map = typeof mcpRaw === 'object' && mcpRaw !== null && !Array.isArray(mcpRaw)
      ? (mcpRaw as Record<string, unknown>)['mcpServers'] : undefined;
    if (typeof map !== 'object' || map === null || Array.isArray(map)) unsupported.push('.mcp.json');
    else for (const [id, spec] of Object.entries(map)) {
      checkAborted(signal);
      const value = typeof spec === 'object' && spec !== null && !Array.isArray(spec)
        ? spec as Record<string, unknown> : {};
      const { type, ...rest } = value;
      const parsed = McpServerConfigSchema.safeParse({ ...rest, transport: type === 'http' || type === 'sse' ? type : (value['command'] ? 'stdio' : 'http') });
      if (!NAME.test(id) || !parsed.success) unsupported.push(`mcp:${id}`);
      else mcpServers[id] = parsed.data;
    }
  }
  for (const component of ['lspServers', 'outputStyles', 'bin', 'scripts']) {
    checkAborted(signal);
    if (doc[component] !== undefined) {
      unsupported.push(component);
      continue;
    }
    try {
      checkAborted(signal);
      await stat(path.join(root, component));
      checkAborted(signal);
      unsupported.push(component);
    } catch {
      checkAborted(signal);
    }
  }
  checkAborted(signal);
  if (unsupported.length > 0) diagnostics.push({ severity: 'info', message: `Claude Code components not imported: ${unsupported.join(', ')}` });
  return {
    manifest: {
      name, version: typeof doc['version'] === 'string' ? doc['version'] : undefined,
      description: typeof doc['description'] === 'string' ? doc['description'] : undefined,
      skills, agents, commands, hooks, mcpServers, unsupportedComponents: unsupported,
    },
    diagnostics,
  };
}
