import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { HookDefSchema, HooksV2ConfigSchema, hooksFromToml, type HooksV2Config, type HookDefConfig } from '#/features/externalHooks/configSection';
import { McpServerConfigSchema, type McpServerConfig } from '#/mcpCore/config-schema';

import { parsePluginExtension } from './contributions';
import { importClaudePlugin } from './claudeImport';
import { pluginPrerequisitesSchema } from './prerequisites';
import {
  PLUGIN_NAME_REGEX,
  type PluginCommandEntry,
  type PluginDiagnostic,
  type PluginInterface,
  type PluginManifest,
  type PluginManifestKind,
} from './types';

const KIMI_PLUGIN_ROOT_PATH = 'kimi.plugin.json';
const KIMI_PLUGIN_DIR_PATH = '.kimi-plugin/plugin.json';

export const PLUGIN_SYSTEM_PROMPT_MAX_BYTES = 32 * 1024;

export const PLUGIN_ICON_MAX_BYTES = 64 * 1024;

const PLUGIN_ICON_MIME_TYPES: Readonly<Record<string, string>> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const UNSUPPORTED_RUNTIME_FIELDS = [
  'tools',
  'apps',
  'inject',
  'configFile',
  'config_file',
  'bootstrap',
] as const;

function checkAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export interface ParsedManifestResult {
  readonly manifest?: PluginManifest;
  readonly manifestKind?: PluginManifestKind;
  readonly manifestPath?: string;
  readonly shadowedManifestPath?: string;
  readonly diagnostics: readonly PluginDiagnostic[];
}

export async function parseManifest(pluginRoot: string, signal?: AbortSignal): Promise<ParsedManifestResult> {
  checkAborted(signal);
  const rootJsonPath = path.join(pluginRoot, KIMI_PLUGIN_ROOT_PATH);
  const dirJsonPath = path.join(pluginRoot, KIMI_PLUGIN_DIR_PATH);
  const rootJsonExists = await isFile(rootJsonPath, signal);
  checkAborted(signal);
  const dirJsonExists = await isFile(dirJsonPath, signal);
  checkAborted(signal);

  if (!rootJsonExists && !dirJsonExists) {
    const claudePath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
    if (await isFile(claudePath, signal)) {
      checkAborted(signal);
      const imported = await importClaudePlugin(pluginRoot, claudePath, signal);
      checkAborted(signal);
      return { ...imported, manifestKind: 'claude-code', manifestPath: claudePath };
    }
    checkAborted(signal);
    return {
      diagnostics: [
        {
          severity: 'error',
          message: `No manifest at ${KIMI_PLUGIN_ROOT_PATH}, ${KIMI_PLUGIN_DIR_PATH}, or .claude-plugin/plugin.json`,
        },
      ],
    };
  }

  const manifestPath = rootJsonExists ? rootJsonPath : dirJsonPath;
  const manifestKind: PluginManifestKind = rootJsonExists ? 'kimi-plugin-root' : 'kimi-plugin-dir';
  const shadowedManifestPath = rootJsonExists && dirJsonExists ? dirJsonPath : undefined;

  let raw: unknown;
  try {
    checkAborted(signal);
    const content = await readFile(manifestPath, { encoding: 'utf8', signal });
    checkAborted(signal);
    raw = JSON.parse(content);
  } catch (error) {
    checkAborted(signal);
    return {
      manifestKind,
      manifestPath,
      shadowedManifestPath,
      diagnostics: [
        {
          severity: 'error',
          message: `Failed to parse ${path.relative(pluginRoot, manifestPath)}: ${(error as Error).message}`,
        },
      ],
    };
  }

  if (!isObject(raw)) {
    return {
      manifestKind,
      manifestPath,
      shadowedManifestPath,
      diagnostics: [{ severity: 'error', message: 'manifest must be a JSON object' }],
    };
  }

  const diagnostics: PluginDiagnostic[] = [];

  const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
  if (name.length === 0) {
    diagnostics.push({ severity: 'error', message: '"name" is required' });
    return { manifestKind, manifestPath, shadowedManifestPath, diagnostics };
  }
  if (!PLUGIN_NAME_REGEX.test(name)) {
    diagnostics.push({
      severity: 'error',
      message: `"name" must match ${PLUGIN_NAME_REGEX} (got "${name}")`,
    });
    return { manifestKind, manifestPath, shadowedManifestPath, diagnostics };
  }

  let skills = await resolveDirListField(pluginRoot, 'skills', raw['skills'], diagnostics, signal);
  checkAborted(signal);
  let rootSkillFallback: boolean | undefined;
  if (raw['skills'] === undefined) {
    const rootSkillMd = path.join(pluginRoot, 'SKILL.md');
    if (await isFile(rootSkillMd, signal)) {
      checkAborted(signal);
      skills = [pluginRoot];
      rootSkillFallback = true;
    }
  }

  let agents = await resolveDirListField(pluginRoot, 'agents', raw['agents'], diagnostics, signal);
  checkAborted(signal);
  if (raw['agents'] === undefined) {
    const agentsDir = path.join(pluginRoot, 'agents');
    if (await isDir(agentsDir, signal)) {
      checkAborted(signal);
      agents = [agentsDir];
    }
  }

  const skillInstructions =
    typeof raw['skillInstructions'] === 'string' ? raw['skillInstructions'] : undefined;

  const systemPrompt = await readSystemPrompt(pluginRoot, raw, diagnostics, signal);
  checkAborted(signal);
  let prerequisites: PluginManifest['prerequisites'];
  if (raw['x-kiki'] !== undefined) {
    const extension = isObject(raw['x-kiki']) ? raw['x-kiki'] : undefined;
    if (extension === undefined || extension['prerequisites'] !== undefined) {
      const result = pluginPrerequisitesSchema.safeParse(extension?.['prerequisites']);
      if (!result.success) {
        diagnostics.push({ severity: 'warn', message: 'Invalid x-kiki.prerequisites; no runtime preparation will be attempted' });
      } else {
        prerequisites = result.data;
      }
    }
  }

  const kiki = await parsePluginExtension(pluginRoot, raw['x-kiki'], diagnostics, signal);
  checkAborted(signal);
  recordUnsupportedRuntimeFields(raw, diagnostics);

  const manifest: PluginManifest = {
    name,
    version: stringField(raw, 'version'),
    description: stringField(raw, 'description'),
    keywords: stringArrayField(raw, 'keywords'),
    homepage: stringField(raw, 'homepage'),
    license: stringField(raw, 'license'),
    author: readAuthor(raw['author']),
    skills,
    rootSkillFallback,
    agents,
    sessionStart: readSessionStart(raw['sessionStart'], diagnostics),
    mcpServers: await readMcpServers(pluginRoot, raw['mcpServers'], diagnostics, signal),
    hooks: readHooks(raw['hooks'], diagnostics),
    hookRules: readHookRules(raw['hooks'], diagnostics),
    commands: await readCommands(pluginRoot, raw['commands'], diagnostics, signal),
    interface: readInterface(raw['interface']),
    icon: await readIcon(pluginRoot, raw['icon'], diagnostics, signal),
    skillInstructions,
    systemPrompt,
    prerequisites,
    kiki,
  };
  checkAborted(signal);

  return { manifest, manifestKind, manifestPath, shadowedManifestPath, diagnostics };
}

function recordUnsupportedRuntimeFields(
  raw: Record<string, unknown>,
  diagnostics: PluginDiagnostic[],
): void {
  for (const field of UNSUPPORTED_RUNTIME_FIELDS) {
    if (raw[field] === undefined) continue;
    diagnostics.push({
      severity: 'info',
      message: `"${field}" is present but not supported by Kimi plugins`,
    });
  }
}

async function resolveDirListField(
  pluginRoot: string,
  field: string,
  raw: unknown,
  diagnostics: PluginDiagnostic[],
  signal?: AbortSignal,
): Promise<readonly string[]> {
  checkAborted(signal);
  if (raw === undefined) return [];
  const entries: string[] = [];
  if (typeof raw === 'string') {
    entries.push(raw);
  } else if (Array.isArray(raw) && raw.every((entry) => typeof entry === 'string')) {
    entries.push(...raw);
  } else {
    diagnostics.push({ severity: 'error', message: `"${field}" must be a string or string[]` });
    return [];
  }

  const resolved: string[] = [];
  for (const entry of entries) {
    checkAborted(signal);
    if (!entry.startsWith('./')) {
      diagnostics.push({
        severity: 'error',
        message: `"${field}" path must start with "./" (got "${entry}")`,
      });
      continue;
    }
    const absolute = path.resolve(pluginRoot, entry);
    let real: string;
    try {
      checkAborted(signal);
      real = await realpath(absolute);
      checkAborted(signal);
    } catch {
      checkAborted(signal);
      real = absolute;
    }
    let rootReal: string;
    try {
      checkAborted(signal);
      rootReal = await realpath(pluginRoot);
      checkAborted(signal);
    } catch {
      checkAborted(signal);
      rootReal = pluginRoot;
    }
    if (!isWithin(real, rootReal)) {
      diagnostics.push({
        severity: 'error',
        message: `"${field}" path resolves outside the plugin (${entry})`,
      });
      continue;
    }
    if (!(await isDir(real, signal))) {
      checkAborted(signal);
      diagnostics.push({
        severity: 'warn',
        message: `"${field}" path is not a directory (${entry})`,
      });
      continue;
    }
    checkAborted(signal);
    resolved.push(real);
  }
  checkAborted(signal);
  return resolved;
}

async function resolvePluginPathField(input: {
  readonly pluginRoot: string;
  readonly field: string;
  readonly value: string;
  readonly diagnostics: PluginDiagnostic[];
}, signal?: AbortSignal): Promise<string | undefined> {
  checkAborted(signal);
  if (!input.value.startsWith('./')) {
    input.diagnostics.push({
      severity: 'warn',
      message: `"${input.field}" path must start with "./" (got "${input.value}")`,
    });
    return undefined;
  }
  const absolute = path.resolve(input.pluginRoot, input.value);
  let real: string;
  try {
    checkAborted(signal);
    real = await realpath(absolute);
    checkAborted(signal);
  } catch {
    checkAborted(signal);
    real = absolute;
  }
  let rootReal: string;
  try {
    checkAborted(signal);
    rootReal = await realpath(input.pluginRoot);
    checkAborted(signal);
  } catch {
    checkAborted(signal);
    rootReal = input.pluginRoot;
  }
  if (!isWithin(real, rootReal)) {
    input.diagnostics.push({
      severity: 'warn',
      message: `"${input.field}" path resolves outside the plugin (${input.value})`,
    });
    return undefined;
  }
  checkAborted(signal);
  return real;
}

function readSessionStart(
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): PluginManifest['sessionStart'] {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    diagnostics.push({ severity: 'warn', message: '"sessionStart" must be an object' });
    return undefined;
  }
  const skill = typeof raw['skill'] === 'string' ? raw['skill'].trim() : '';
  if (skill.length === 0) {
    diagnostics.push({
      severity: 'warn',
      message: '"sessionStart.skill" is required when sessionStart is present',
    });
    return undefined;
  }
  return { skill };
}

async function readSystemPrompt(
  pluginRoot: string,
  raw: Record<string, unknown>,
  diagnostics: PluginDiagnostic[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  checkAborted(signal);
  const parts: string[] = [];
  if (raw['systemPrompt'] !== undefined && typeof raw['systemPrompt'] !== 'string') {
    diagnostics.push({ severity: 'warn', message: '"systemPrompt" must be a string' });
  }
  const inline = stringField(raw, 'systemPrompt');
  if (inline !== undefined) {
    const inlineBytes = Buffer.byteLength(inline, 'utf8');
    if (inlineBytes > PLUGIN_SYSTEM_PROMPT_MAX_BYTES) {
      diagnostics.push({
        severity: 'warn',
        message:
          `"systemPrompt" is ${inlineBytes} bytes, exceeding the ` +
          `${PLUGIN_SYSTEM_PROMPT_MAX_BYTES / 1024} KB limit; the field is ignored`,
      });
    } else {
      parts.push(inline);
    }
  }

  const pathValue = raw['systemPromptPath'];
  if (pathValue !== undefined) {
    if (typeof pathValue !== 'string') {
      diagnostics.push({ severity: 'warn', message: '"systemPromptPath" must be a string' });
    } else if (pathValue.trim().length === 0) {
      diagnostics.push({ severity: 'warn', message: '"systemPromptPath" must not be blank' });
    } else {
      const resolved = await resolvePluginPathField({
        pluginRoot,
        field: 'systemPromptPath',
        value: pathValue.trim(),
        diagnostics,
      }, signal);
      checkAborted(signal);
      if (resolved !== undefined) {
        let fileStat: Awaited<ReturnType<typeof stat>> | undefined;
        try {
          checkAborted(signal);
          fileStat = await stat(resolved);
          checkAborted(signal);
        } catch {
          checkAborted(signal);
          fileStat = undefined;
        }
        if (fileStat === undefined || !fileStat.isFile()) {
          diagnostics.push({
            severity: 'warn',
            message: `"systemPromptPath" is not a file (${pathValue})`,
          });
        } else if (fileStat.size > PLUGIN_SYSTEM_PROMPT_MAX_BYTES) {
          diagnostics.push({
            severity: 'warn',
            message:
              `"systemPromptPath" is ${fileStat.size} bytes, exceeding the ` +
              `${PLUGIN_SYSTEM_PROMPT_MAX_BYTES / 1024} KB limit; the file is ignored (${pathValue})`,
          });
        } else {
          try {
            checkAborted(signal);
            const content = (await readFile(resolved, { encoding: 'utf8', signal }))
              .replace(/^\uFEFF/, '').trim();
            checkAborted(signal);
            if (content.length > 0) parts.push(content);
          } catch (error) {
            checkAborted(signal);
            diagnostics.push({
              severity: 'warn',
              message: `Failed to read "systemPromptPath" (${pathValue}): ${(error as Error).message}`,
            });
          }
        }
      }
    }
  }

  checkAborted(signal);
  return parts.length === 0 ? undefined : parts.join('\n\n');
}

async function readIcon(
  pluginRoot: string,
  raw: unknown,
  diagnostics: PluginDiagnostic[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  checkAborted(signal);
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    diagnostics.push({ severity: 'warn', message: '"icon" must be a string' });
    return undefined;
  }
  const value = raw.trim();
  if (value.length === 0) {
    diagnostics.push({ severity: 'warn', message: '"icon" must not be blank' });
    return undefined;
  }
  const resolved = await resolvePluginPathField({
    pluginRoot,
    field: 'icon',
    value,
    diagnostics,
  }, signal);
  checkAborted(signal);
  if (resolved === undefined) return undefined;
  const mimeType = PLUGIN_ICON_MIME_TYPES[path.extname(resolved).toLowerCase()];
  if (mimeType === undefined) {
    diagnostics.push({
      severity: 'warn',
      message: `"icon" must be an .svg or .png file inside the plugin (${value})`,
    });
    return undefined;
  }
  let fileStat: Awaited<ReturnType<typeof stat>> | undefined;
  try {
    checkAborted(signal);
    fileStat = await stat(resolved);
    checkAborted(signal);
  } catch {
    checkAborted(signal);
    fileStat = undefined;
  }
  if (fileStat === undefined || !fileStat.isFile()) {
    diagnostics.push({ severity: 'warn', message: `"icon" is not a file (${value})` });
    return undefined;
  }
  if (fileStat.size > PLUGIN_ICON_MAX_BYTES) {
    diagnostics.push({
      severity: 'warn',
      message:
        `"icon" is ${fileStat.size} bytes, exceeding the ` +
        `${PLUGIN_ICON_MAX_BYTES / 1024} KB limit; the icon is ignored (${value})`,
    });
    return undefined;
  }
  try {
    checkAborted(signal);
    const bytes = await readFile(resolved, { signal });
    checkAborted(signal);
    return `data:${mimeType};base64,${bytes.toString('base64')}`;
  } catch (error) {
    checkAborted(signal);
    diagnostics.push({
      severity: 'warn',
      message: `Failed to read "icon" (${value}): ${(error as Error).message}`,
    });
    return undefined;
  }
}

async function readMcpServers(
  pluginRoot: string,
  raw: unknown,
  diagnostics: PluginDiagnostic[],
  signal?: AbortSignal,
): Promise<PluginManifest['mcpServers']> {
  checkAborted(signal);
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    diagnostics.push({ severity: 'warn', message: '"mcpServers" must be an object' });
    return undefined;
  }

  const out: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(raw)) {
    checkAborted(signal);
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      diagnostics.push({
        severity: 'warn',
        message: '"mcpServers" entries must have a non-empty name',
      });
      continue;
    }
    const parsed = McpServerConfigSchema.safeParse(value);
    if (!parsed.success) {
      diagnostics.push({
        severity: 'warn',
        message: `Invalid MCP server "${trimmedName}": ${parsed.error.message}`,
      });
      continue;
    }
    const normalized = await normalizePluginMcpServer({
      pluginRoot,
      name: trimmedName,
      config: parsed.data,
      diagnostics,
    }, signal);
    checkAborted(signal);
    if (normalized !== undefined) out[trimmedName] = normalized;
  }
  checkAborted(signal);
  return Object.keys(out).length === 0 ? undefined : out;
}

function readHooks(
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): readonly HookDefConfig[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    const parsed = HooksV2ConfigSchema.safeParse(hooksFromToml(raw));
    return parsed.success ? parsed.data.legacy : undefined;
  }
  const out: HookDefConfig[] = [];
  raw.forEach((entry, i) => {
    const parsed = HookDefSchema.safeParse(entry);
    if (!parsed.success) {
      diagnostics.push({
        severity: 'error',
        message: `Invalid hook at index ${i}: ${parsed.error.message}`,
      });
    } else {
      out.push(parsed.data);
    }
  });
  return out.length === 0 ? undefined : out;
}

function readHookRules(raw: unknown, diagnostics: PluginDiagnostic[]): HooksV2Config | undefined {
  if (raw === undefined || Array.isArray(raw)) return undefined;
  const parsed = HooksV2ConfigSchema.safeParse(hooksFromToml(raw));
  if (parsed.success) return parsed.data;
  diagnostics.push({ severity: 'error', message: `Invalid v2 hooks: ${parsed.error.message}` });
  return undefined;
}

async function readCommands(
  pluginRoot: string,
  raw: unknown,
  diagnostics: PluginDiagnostic[],
  signal?: AbortSignal,
): Promise<readonly PluginCommandEntry[] | undefined> {
  checkAborted(signal);
  if (raw === undefined) return undefined;
  const entries: string[] = [];
  if (typeof raw === 'string') {
    entries.push(raw);
  } else if (Array.isArray(raw) && raw.every((entry) => typeof entry === 'string')) {
    entries.push(...raw);
  } else {
    diagnostics.push({ severity: 'warn', message: '"commands" must be a string or string[]' });
    return undefined;
  }

  const files: PluginCommandEntry[] = [];
  for (const entry of entries) {
    checkAborted(signal);
    const resolved = await resolvePluginPathField({
      pluginRoot,
      field: 'commands',
      value: entry,
      diagnostics,
    }, signal);
    checkAborted(signal);
    if (resolved === undefined) continue;
    const directory = await isDir(resolved, signal);
    checkAborted(signal);
    if (directory) {
      const nested = await listMarkdownFilesRecursive(resolved, signal);
      checkAborted(signal);
      files.push(...nested);
    } else {
      const file = await isFile(resolved, signal);
      checkAborted(signal);
      if (file && resolved.endsWith('.md')) {
        files.push({ path: resolved, name: commandNameFromFile(resolved, path.dirname(resolved)) });
      } else {
        diagnostics.push({
          severity: 'warn',
          message: `"commands" entry must be a directory or .md file (${entry})`,
        });
      }
    }
  }
  checkAborted(signal);
  return files.length === 0 ? undefined : files.toSorted((a, b) => a.name.localeCompare(b.name));
}

async function listMarkdownFilesRecursive(root: string, signal?: AbortSignal): Promise<readonly PluginCommandEntry[]> {
  checkAborted(signal);
  const out: PluginCommandEntry[] = [];
  await walkMarkdown(root, root, out, signal);
  checkAborted(signal);
  return out;
}

async function walkMarkdown(
  root: string,
  dir: string,
  out: PluginCommandEntry[],
  signal?: AbortSignal,
): Promise<void> {
  checkAborted(signal);
  let entries;
  try {
    checkAborted(signal);
    entries = await readdir(dir, { withFileTypes: true });
    checkAborted(signal);
  } catch {
    checkAborted(signal);
    return;
  }
  for (const entry of entries) {
    checkAborted(signal);
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkMarkdown(root, full, out, signal);
      checkAborted(signal);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push({ path: full, name: commandNameFromFile(full, root) });
    }
  }
  checkAborted(signal);
}

function commandNameFromFile(file: string, root: string): string {
  const relative = path.relative(root, file).replace(/\.md$/i, '');
  return relative.split(path.sep).join('/');
}

async function normalizePluginMcpServer(input: {
  readonly pluginRoot: string;
  readonly name: string;
  readonly config: McpServerConfig;
  readonly diagnostics: PluginDiagnostic[];
}, signal?: AbortSignal): Promise<McpServerConfig | undefined> {
  checkAborted(signal);
  const { config } = input;
  if (config.transport === 'http' || config.transport === 'sse') return config;

  let command = config.command;
  if (command.startsWith('./')) {
    const resolvedCommand = await resolvePluginPathField({
      pluginRoot: input.pluginRoot,
      field: `mcpServers.${input.name}.command`,
      value: command,
      diagnostics: input.diagnostics,
    }, signal);
    checkAborted(signal);
    if (resolvedCommand === undefined) return undefined;
    command = resolvedCommand;
  } else if (command.includes('/') || path.isAbsolute(command)) {
    input.diagnostics.push({
      severity: 'warn',
      message: `"mcpServers.${input.name}.command" must be a PATH command or start with "./"`,
    });
    return undefined;
  }

  let cwd = config.cwd;
  if (cwd !== undefined) {
    const resolvedCwd = await resolvePluginPathField({
      pluginRoot: input.pluginRoot,
      field: `mcpServers.${input.name}.cwd`,
      value: cwd,
      diagnostics: input.diagnostics,
    }, signal);
    checkAborted(signal);
    if (resolvedCwd === undefined) return undefined;
    cwd = resolvedCwd;
  }

  checkAborted(signal);
  return { ...config, command, cwd };
}

function readAuthor(raw: unknown): PluginManifest['author'] {
  if (typeof raw === 'string') return { name: raw };
  if (!isObject(raw)) return undefined;
  const name = stringField(raw, 'name');
  const email = stringField(raw, 'email');
  if (name === undefined && email === undefined) return undefined;
  return { name, email };
}

function readInterface(raw: unknown): PluginInterface | undefined {
  if (!isObject(raw)) return undefined;
  const out: PluginInterface = {
    displayName: stringField(raw, 'displayName'),
    shortDescription: stringField(raw, 'shortDescription'),
    longDescription: stringField(raw, 'longDescription'),
    developerName: stringField(raw, 'developerName'),
    websiteURL: stringField(raw, 'websiteURL'),
  };
  const hasAny = Object.values(out).some((value) => value !== undefined);
  return hasAny ? out : undefined;
}

function stringField(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function stringArrayField(raw: Record<string, unknown>, key: string): readonly string[] | undefined {
  const value = raw[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    return undefined;
  }
  return value as readonly string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function isFile(p: string, signal?: AbortSignal): Promise<boolean> {
  checkAborted(signal);
  try {
    checkAborted(signal);
    const value = await stat(p);
    checkAborted(signal);
    return value.isFile();
  } catch {
    checkAborted(signal);
    return false;
  }
}

async function isDir(p: string, signal?: AbortSignal): Promise<boolean> {
  checkAborted(signal);
  try {
    checkAborted(signal);
    const value = await stat(p);
    checkAborted(signal);
    return value.isDirectory();
  } catch {
    checkAborted(signal);
    return false;
  }
}
