import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { skinFileSchema, type SkinFile } from '@kiki/protocol';
import { satisfies, validRange } from 'semver';
import { z } from 'zod';

import { ProtocolSchema } from '#/kosong/protocol/protocol';

import type { PluginDiagnostic } from './types';

export const KIKI_PLUGIN_ENGINE_VERSION = '0.4.0';
export const PLUGIN_EXTENSION_VERSION = 1;

const schemaVersion = z.literal(PLUGIN_EXTENSION_VERSION);
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const permissionSchema = z.object({
  fs: z.enum(['workspace', 'outside']).optional(),
  net: z.array(z.string().min(1)).optional(),
  exec: z.array(z.string().min(1)).optional(),
  secrets: z.boolean().optional(),
  uiPanel: z.boolean().optional(),
}).strict();

export const themeContributionSchema = z.object({
  schemaVersion,
  id: slug,
  label: z.string().min(1).max(64),
  base: z.enum(['light', 'dark']),
  path: z.string().startsWith('./'),
}).strict();

export const providerPresetSchema = z.object({
  schemaVersion,
  id: slug,
  label: z.string().min(1),
  protocol: ProtocolSchema,
  baseUrl: z.url(),
  models: z.array(z.string().min(1)).min(1),
}).strict();

const accessSchema = z.union([
  z.object({ kind: z.literal('all') }).strict(),
  z.object({
    kind: z.literal('file'),
    operation: z.enum(['read', 'write', 'readwrite', 'search']),
    path: z.string().min(1),
    recursive: z.boolean().optional(),
    implicitExternal: z.boolean().optional(),
  }).strict(),
]);

export const toolContributionSchema = z.object({
  schemaVersion,
  name: z.string().regex(/^[a-zA-Z][\w-]{0,63}$/),
  description: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()).optional(),
  accesses: z.array(accessSchema).default([{ kind: 'all' }]),
  display: z.record(z.string(), z.unknown()).optional(),
  approvalRule: z.string().min(1).optional(),
  disclosure: z.enum(['inline', 'deferred']).default('deferred'),
}).strict();

export const panelContributionSchema = z.object({
  schemaVersion,
  id: slug,
  label: z.string().min(1).max(64),
  slot: z.enum(['sidebar', 'workspace']),
  path: z.string().startsWith('./').endsWith('.html'),
  assets: z.array(z.string().startsWith('./')).max(30).optional(),
}).strict();

export const commandContributionSchema = z.object({
  schemaVersion,
  name: slug,
  description: z.string().min(1).max(240),
  prompt: z.string().min(1).max(16_384),
}).strict();

export const settingsContributionSchema = z.object({
  schemaVersion,
  schema: z.object({
    type: z.literal('object'),
    properties: z.record(z.string(), z.object({
      type: z.enum(['string', 'boolean', 'number']),
      title: z.string().optional(),
      description: z.string().optional(),
      secret: z.boolean().optional(),
      default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    }).strict()),
    required: z.array(z.string()).optional(),
  }).strict(),
}).strict();

export type PluginPermissions = z.infer<typeof permissionSchema>;
export type PluginTheme = z.infer<typeof themeContributionSchema> & { readonly file: SkinFile };
export type PluginProviderPreset = z.infer<typeof providerPresetSchema>;
export type PluginTool = z.infer<typeof toolContributionSchema>;
export type PluginPanel = z.infer<typeof panelContributionSchema> & { readonly file: string; readonly assetFiles: Readonly<Record<string, string>> };
export type PluginDeclarativeCommand = z.infer<typeof commandContributionSchema>;
export type PluginSettings = z.infer<typeof settingsContributionSchema>;

export interface PluginExtension {
  readonly engines?: { readonly kiki: string };
  readonly permissions?: PluginPermissions;
  readonly themes?: readonly PluginTheme[];
  readonly providerPresets?: readonly PluginProviderPreset[];
  readonly tools?: readonly PluginTool[];
  readonly panels?: readonly PluginPanel[];
  readonly commands?: readonly PluginDeclarativeCommand[];
  readonly entry?: string;
  readonly settings?: PluginSettings;
}

export async function parsePluginExtension(
  root: string,
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): Promise<PluginExtension | undefined> {
  if (raw === undefined) return undefined;
  const envelope = z.object({
    engines: z.object({ kiki: z.string().min(1) }).strict().optional(),
    permissions: permissionSchema.optional(),
    themes: z.array(themeContributionSchema).optional(),
    providerPresets: z.array(providerPresetSchema).optional(),
    tools: z.array(toolContributionSchema).optional(),
    panels: z.array(panelContributionSchema).optional(),
    commands: z.array(commandContributionSchema).optional(),
    entry: z.string().startsWith('./').optional(),
    settings: settingsContributionSchema.optional(),
    prerequisites: z.unknown().optional(),
  }).strict().safeParse(raw);
  if (!envelope.success) {
    diagnostics.push({ severity: 'error', message: `Invalid x-kiki extension: ${envelope.error.message}` });
    return undefined;
  }
  const value = envelope.data;
  const hasContributions = value.themes !== undefined || value.providerPresets !== undefined ||
    value.tools !== undefined || value.panels !== undefined || value.commands !== undefined ||
    value.entry !== undefined || value.settings !== undefined;
  if (hasContributions && value.engines === undefined) {
    diagnostics.push({ severity: 'error', message: 'x-kiki.engines.kiki is required for Kiki contributions' });
  }
  if (value.engines !== undefined && (validRange(value.engines.kiki) === null ||
    !satisfies(KIKI_PLUGIN_ENGINE_VERSION, value.engines.kiki))) {
    diagnostics.push({ severity: 'error', message: `Plugin requires Kiki ${value.engines.kiki}; engine is ${KIKI_PLUGIN_ENGINE_VERSION}` });
  }
  if (value.tools !== undefined && value.entry === undefined) {
    diagnostics.push({ severity: 'error', message: 'x-kiki.entry is required for tools' });
  }
  const resolvedEntry = value.entry === undefined ? undefined : await safePluginFile(root, value.entry);
  if (value.entry !== undefined && resolvedEntry === undefined) {
    diagnostics.push({ severity: 'error', message: 'x-kiki.entry must be an existing file inside the plugin' });
  }
  const themes: PluginTheme[] = [];
  for (const theme of value.themes ?? []) {
    const file = await safePluginFile(root, theme.path);
    if (file === undefined) {
      diagnostics.push({ severity: 'error', message: `Theme ${theme.id} must reference a file inside the plugin` });
      continue;
    }
    try {
      const bytes = await readFile(file);
      if (bytes.byteLength > 64 * 1024) throw new Error('theme file exceeds 64 KiB');
      const skin = skinFileSchema.parse(JSON.parse(bytes.toString('utf8')));
      if (skin.id !== undefined && skin.id !== theme.id) throw new Error('theme id mismatch');
      if (skin.variants[theme.base] === undefined) throw new Error(`missing ${theme.base} variant`);
      themes.push({ ...theme, file: { ...skin, id: theme.id } });
    } catch (error) {
      diagnostics.push({ severity: 'error', message: `Invalid theme ${theme.id}: ${(error as Error).message}` });
    }
  }
  const panels: PluginPanel[] = [];
  if (value.panels?.length && value.permissions?.uiPanel !== true) {
    diagnostics.push({ severity: 'error', message: 'x-kiki.permissions.uiPanel is required for panel contributions' });
  }
  for (const panel of value.panels ?? []) {
    const file = await safePluginFile(root, panel.path);
    if (file === undefined || (await stat(file)).size > 256 * 1024) {
      diagnostics.push({ severity: 'error', message: `Panel ${panel.id} must reference an HTML file under 256 KiB inside the plugin` });
      continue;
    }
    const assetFiles: Record<string, string> = {};
    for (const asset of panel.assets ?? []) {
      const resolved = await safePluginFile(root, asset);
      if (resolved === undefined || (await stat(resolved)).size > 512 * 1024 ||
        !/\.(?:js|css|svg|png|webp)$/i.test(resolved)) {
        diagnostics.push({ severity: 'error', message: `Panel ${panel.id} asset ${asset} is invalid or exceeds 512 KiB` });
      } else assetFiles[asset.slice(2)] = resolved;
    }
    panels.push({ ...panel, file, assetFiles });
  }
  return {
    engines: value.engines,
    permissions: value.permissions,
    themes,
    providerPresets: value.providerPresets,
    tools: value.tools,
    panels,
    commands: value.commands,
    entry: resolvedEntry,
    settings: value.settings,
  };
}

async function safePluginFile(root: string, relative: string): Promise<string | undefined> {
  const base = await realpath(root);
  const candidate = path.resolve(base, relative);
  const file = await realpath(candidate).catch(() => undefined);
  if (file === undefined) return undefined;
  const within = path.relative(base, file);
  if (within.startsWith('..') || path.isAbsolute(within) || !(await stat(file)).isFile()) return undefined;
  return file;
}
