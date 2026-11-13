import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  asrProviderDefinitionSchema, harnessAccountSourceDefinitionSchema, harnessQuotaSourceDefinitionSchema, mediaProviderDefinitionSchema, pluginImAdapterDefinitionSchema, sessionSourceDefinitionSchema, skinFileSchema,
  type AsrProviderDefinition, type HarnessAccountSourceDefinition, type HarnessQuotaSourceDefinition, type MediaProviderDefinition, type PluginImAdapterDefinition, type SessionSourceDefinition, type SkinFile,
} from '@kiki/protocol';
import { satisfies, validRange } from 'semver';
import { z } from 'zod';

import { ProtocolSchema } from '#/kosong/protocol/protocol';

import type { PluginExecutionTier } from '#/app/cordisRuntime/cordisRuntime';
import type { ExtensionSlotId } from '#/app/plugin/extensionSlots';

import type { PluginDiagnostic } from './types';

export const KIKI_PLUGIN_ENGINE_VERSION = '0.4.3';
export const PLUGIN_EXTENSION_VERSION = 1;

function checkAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

const schemaVersion = z.literal(PLUGIN_EXTENSION_VERSION);
const executionTierSchema = z.enum(['in-process', 'worker-isolate', 'process-isolated']);
const extensionSlotIds = {
  'E1:llm-adapter': true,
  'E2:llm-request': true,
  'E3:llm-stream': true,
  'E4:llm-error-recovery': true,
  'E5:prompt-context': true,
  'E6:context-compaction': true,
  'E7:agent-loop': true,
  'E8:tool-pipeline': true,
  'E9:subagent-dispatch': true,
  'E10:executor-registry': true,
  'E11:session-state': true,
  'E12:server-gui-slots': true,
} satisfies Record<ExtensionSlotId, true>;
const extensionSlotSchema = z.enum(Object.keys(extensionSlotIds) as [ExtensionSlotId, ...ExtensionSlotId[]]);
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
  concurrencySafe: z.boolean().optional(),
  display: z.record(z.string(), z.unknown()).optional(),
  approvalRule: z.string().min(1).optional(),
  disclosure: z.enum(['inline', 'deferred']).default('deferred'),
  mediaInputs: z.boolean().optional(),
}).strict();

export const panelContributionSchema = z.object({
  schemaVersion,
  id: slug,
  label: z.string().min(1).max(64),
  slot: z.enum(['sidebar', 'workspace', 'settings']),
  path: z.string().startsWith('./').endsWith('.html'),
  assets: z.array(z.string().startsWith('./')).max(30).optional(),
}).strict();

export const commandContributionSchema = z.object({
  schemaVersion,
  name: slug,
  description: z.string().min(1).max(240),
  prompt: z.string().min(1).max(16_384),
}).strict();

export const requestProjectionStrategySchema = z.enum(['passthrough', 'tool_result_appendix', 'tool_result_trailing_text']);
export type PluginRequestProjectionStrategy = z.infer<typeof requestProjectionStrategySchema>;

export const requestProjectionContributionSchema = z.object({
  schemaVersion,
  strategySetting: z.string().min(1).default('strategy'),
  modelsSetting: z.string().min(1).default('targetModels'),
  defaultStrategy: requestProjectionStrategySchema.default('tool_result_appendix'),
  defaultModels: z.array(z.string().min(1)).max(200).default([]),
}).strict();
export type PluginRequestProjection = z.infer<typeof requestProjectionContributionSchema>;

const settingsPropertySchema = z.object({
  type: z.enum(['string', 'boolean', 'number']),
  title: z.string().optional(),
  description: z.string().optional(),
  secret: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  hidden: z.boolean().optional(),
  group: z.string().min(1).max(80).optional(),
  groupTitle: z.string().min(1).max(80).optional(),
  localizations: z.record(z.string().min(2).max(35), z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    groupTitle: z.string().min(1).max(80).optional(),
  }).strict()).optional(),
  enum: z.array(z.string().min(1)).max(2000).optional(),
  multiline: z.boolean().optional(),
  advanced: z.boolean().optional(),
  format: z.enum(['kiki-model', 'kiki-connection']).optional(),
  requiredUnless: z.string().min(1).optional(),
}).strict().superRefine((property, ctx) => {
  if (property.format !== undefined && property.type !== 'string') {
    ctx.addIssue({ code: 'custom', path: ['format'], message: 'format requires a string setting' });
  }
  if (property.format !== undefined && property.secret === true) {
    ctx.addIssue({ code: 'custom', path: ['format'], message: 'secret settings cannot declare format' });
  }
});

type SettingsProperty = z.infer<typeof settingsPropertySchema>;

export const settingsContributionSchema = z.object({
  schemaVersion,
  schema: z.object({
    type: z.literal('object'),
    properties: z.record(z.string(), settingsPropertySchema),
    required: z.array(z.string()).optional(),
  }).strict().superRefine((schema, ctx) => {
    for (const [key, property] of Object.entries(schema.properties) as [string, SettingsProperty][]) {
      const reference = property.requiredUnless;
      if (reference === undefined) continue;
      if (property.type !== 'string') {
        ctx.addIssue({ code: 'custom', path: ['properties', key, 'requiredUnless'], message: 'requiredUnless requires a string setting' });
      }
      if (schema.required?.includes(key) !== true) {
        ctx.addIssue({ code: 'custom', path: ['properties', key, 'requiredUnless'], message: 'requiredUnless requires the setting to be listed in required' });
      }
      if (reference === key) {
        ctx.addIssue({ code: 'custom', path: ['properties', key, 'requiredUnless'], message: 'requiredUnless cannot reference the same setting' });
        continue;
      }
      const target = schema.properties[reference];
      if (target === undefined) {
        ctx.addIssue({ code: 'custom', path: ['properties', key, 'requiredUnless'], message: `requiredUnless references unknown setting ${reference}` });
      } else {
        if (target.type !== 'string') {
          ctx.addIssue({ code: 'custom', path: ['properties', key, 'requiredUnless'], message: 'requiredUnless must reference a string setting' });
        }
        if (target.secret === true) {
          ctx.addIssue({ code: 'custom', path: ['properties', key, 'requiredUnless'], message: 'requiredUnless cannot reference a secret setting' });
        }
      }
    }
  }),
}).strict();

export type PluginPermissions = z.infer<typeof permissionSchema>;
export type PluginTheme = z.infer<typeof themeContributionSchema> & { readonly file: SkinFile };
export type PluginProviderPreset = z.infer<typeof providerPresetSchema>;
export type PluginTool = z.infer<typeof toolContributionSchema>;
export type PluginPanel = z.infer<typeof panelContributionSchema> & { readonly file: string; readonly assetFiles: Readonly<Record<string, string>> };
export type PluginDeclarativeCommand = z.infer<typeof commandContributionSchema>;
export type PluginSettings = z.infer<typeof settingsContributionSchema>;

export const mediaSourceGroupSchema = z.object({ id: slug, label: z.string().min(1), providerIds: z.array(slug).min(1), settingsPrefix: z.string().regex(/^[a-z0-9]+__$/), legacyPluginId: z.string().optional(), required: z.array(z.string()).default([]) }).strict();
export type PluginMediaSourceGroup = z.infer<typeof mediaSourceGroupSchema>;

export interface PluginExtension {
  readonly engines?: { readonly kiki: string };
  readonly tier?: PluginExecutionTier;
  readonly slots?: readonly ExtensionSlotId[];
  readonly permissions?: PluginPermissions;
  readonly themes?: readonly PluginTheme[];
  readonly providerPresets?: readonly PluginProviderPreset[];
  readonly tools?: readonly PluginTool[];
  readonly sessionSources?: readonly SessionSourceDefinition[];
  readonly mediaProviders?: readonly MediaProviderDefinition[];
  readonly asrProviders?: readonly AsrProviderDefinition[];
  readonly harnessAccountSources?: readonly HarnessAccountSourceDefinition[];
  readonly harnessQuotaSources?: readonly HarnessQuotaSourceDefinition[];
  readonly imAdapters?: readonly PluginImAdapterDefinition[];
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly mediaSources?: readonly PluginMediaSourceGroup[];
  readonly mediaScriptProvider?: string;
  readonly panels?: readonly PluginPanel[];
  readonly commands?: readonly PluginDeclarativeCommand[];
  readonly entry?: string;
  readonly activation?: 'app';
  readonly settings?: PluginSettings;
  readonly requestProjection?: PluginRequestProjection;
  /**
   * An extra management surface this package owns. The host offers it on the
   * plugin's own page, so a package with a surface is reached by installing
   * that package rather than through a global control.
   */
  readonly mediaSurface?: { readonly view: 'media' };
}

export async function parsePluginExtension(
  root: string,
  raw: unknown,
  diagnostics: PluginDiagnostic[],
  signal?: AbortSignal,
): Promise<PluginExtension | undefined> {
  checkAborted(signal);
  if (raw === undefined) return undefined;
  const envelope = z.object({
    engines: z.object({ kiki: z.string().min(1) }).strict().optional(),
    tier: executionTierSchema.optional(),
    slots: z.array(extensionSlotSchema).optional(),
    permissions: permissionSchema.optional(),
    themes: z.array(themeContributionSchema).optional(),
    providerPresets: z.array(providerPresetSchema).optional(),
    tools: z.array(toolContributionSchema).optional(),
    sessionSources: z.array(sessionSourceDefinitionSchema).max(20).optional(),
    mediaProviders: z.array(mediaProviderDefinitionSchema).max(1000).optional(),
    asrProviders: z.array(asrProviderDefinitionSchema).max(1000).optional(),
    harnessAccountSources: z.array(harnessAccountSourceDefinitionSchema).max(20).optional(),
    harnessQuotaSources: z.array(harnessQuotaSourceDefinitionSchema).max(20).optional(),
    imAdapters: z.array(pluginImAdapterDefinitionSchema).max(20).optional(),
    dependencies: z.record(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), z.string().refine((range) => validRange(range) !== null)).optional(),
    mediaSources: z.array(mediaSourceGroupSchema).max(1000).optional(),
    mediaScriptProvider: slug.optional(),
    panels: z.array(panelContributionSchema).optional(),
    commands: z.array(commandContributionSchema).optional(),
    entry: z.string().startsWith('./').optional(),
    activation: z.literal('app').optional(),
    settings: settingsContributionSchema.optional(),
    requestProjection: requestProjectionContributionSchema.optional(),
    prerequisites: z.unknown().optional(),
    mediaSurface: z.object({ view: z.literal('media') }).strict().optional(),
  }).strict().safeParse(raw);
  if (!envelope.success) {
    diagnostics.push({ severity: 'error', message: `Invalid x-kiki extension: ${envelope.error.message}` });
    return undefined;
  }
  const value = envelope.data;
  const hasContributions = value.themes !== undefined || value.providerPresets !== undefined ||
    value.tools !== undefined || value.sessionSources !== undefined || value.mediaProviders !== undefined || value.asrProviders !== undefined || value.harnessAccountSources !== undefined || value.harnessQuotaSources !== undefined || value.imAdapters !== undefined || value.dependencies !== undefined || value.panels !== undefined || value.commands !== undefined ||
    value.slots !== undefined || value.entry !== undefined || value.settings !== undefined || value.requestProjection !== undefined;
  if (hasContributions && value.engines === undefined) {
    diagnostics.push({ severity: 'error', message: 'x-kiki.engines.kiki is required for Kiki contributions' });
  }
  if (value.engines !== undefined && (validRange(value.engines.kiki) === null ||
    !satisfies(KIKI_PLUGIN_ENGINE_VERSION, value.engines.kiki))) {
    diagnostics.push({ severity: 'error', message: `Plugin requires Kiki ${value.engines.kiki}; engine is ${KIKI_PLUGIN_ENGINE_VERSION}` });
  }
  if ((value.tools !== undefined || value.sessionSources !== undefined || value.mediaProviders !== undefined || value.asrProviders !== undefined || value.harnessAccountSources !== undefined || value.harnessQuotaSources !== undefined || value.imAdapters !== undefined || value.slots !== undefined || value.activation !== undefined) && value.entry === undefined) {
    diagnostics.push({ severity: 'error', message: 'x-kiki.entry is required for executable contributions' });
  }
  for (const definitions of [value.sessionSources, value.mediaProviders, value.asrProviders, value.harnessAccountSources, value.harnessQuotaSources, value.imAdapters]) {
    if (new Set(definitions?.map((item) => item.id)).size !== (definitions?.length ?? 0)) {
      diagnostics.push({ severity: 'error', message: 'Duplicate executable contribution id' });
    }
  }
  for (const provider of value.mediaProviders ?? []) {
    const group = value.mediaSources?.find((item) => item.providerIds.includes(provider.id));
    const setting = provider.connectionSetting === undefined
      ? undefined
      : group === undefined || provider.connectionSetting.startsWith(group.settingsPrefix)
        ? provider.connectionSetting
        : group.settingsPrefix + provider.connectionSetting;
    if (setting !== undefined && value.settings?.schema.properties[setting]?.type !== 'string') {
      diagnostics.push({ severity: 'error', message: `Media provider ${provider.id} connectionSetting must name a declared string setting` });
    }
  }
  for (const provider of value.asrProviders ?? []) {
    if (provider.connectionSetting !== undefined && value.settings?.schema.properties[provider.connectionSetting]?.type !== 'string') {
      diagnostics.push({ severity: 'error', message: `ASR provider ${provider.id} connectionSetting must name a declared string setting` });
    }
  }
  const groups = value.mediaSources ?? [];
  const groupedIds = groups.flatMap((group) => group.providerIds);
  if (new Set(groups.map((group) => group.id)).size !== groups.length || new Set(groups.map((group) => group.settingsPrefix)).size !== groups.length || new Set(groupedIds).size !== groupedIds.length || groupedIds.some((id) => !value.mediaProviders?.some((provider) => provider.id === id))) diagnostics.push({ severity: 'error', message: 'Media source groups require unique ids, prefixes and declared providers' });
  for (const group of groups) {
    if (group.required.some((key) => value.settings?.schema.properties[group.settingsPrefix + key] === undefined)) diagnostics.push({ severity: 'error', message: `Media source ${group.id} required settings must be declared` });
  }
  if (value.mediaScriptProvider !== undefined && (!value.mediaProviders?.some((provider) => provider.id === value.mediaScriptProvider) || value.settings?.schema.properties['scriptSources']?.type !== 'string')) diagnostics.push({ severity: 'error', message: 'Media scripts require a declared provider and scriptSources string setting' });
  const resolvedEntry = value.entry === undefined ? undefined : await safePluginFile(root, value.entry, signal);
  checkAborted(signal);
  if (value.entry !== undefined && resolvedEntry === undefined) {
    diagnostics.push({ severity: 'error', message: 'x-kiki.entry must be an existing file inside the plugin' });
  }
  const themes: PluginTheme[] = [];
  for (const theme of value.themes ?? []) {
    checkAborted(signal);
    const file = await safePluginFile(root, theme.path, signal);
    checkAborted(signal);
    if (file === undefined) {
      diagnostics.push({ severity: 'error', message: `Theme ${theme.id} must reference a file inside the plugin` });
      continue;
    }
    try {
      checkAborted(signal);
      const bytes = await readFile(file, { signal });
      checkAborted(signal);
      if (bytes.byteLength > 64 * 1024) throw new Error('theme file exceeds 64 KiB');
      const skin = skinFileSchema.parse(JSON.parse(bytes.toString('utf8')));
      if (skin.id !== undefined && skin.id !== theme.id) throw new Error('theme id mismatch');
      if (skin.variants[theme.base] === undefined) throw new Error(`missing ${theme.base} variant`);
      themes.push({ ...theme, file: { ...skin, id: theme.id } });
    } catch (error) {
      checkAborted(signal);
      diagnostics.push({ severity: 'error', message: `Invalid theme ${theme.id}: ${(error as Error).message}` });
    }
  }
  const panels: PluginPanel[] = [];
  if (value.panels?.length && value.permissions?.uiPanel !== true) {
    diagnostics.push({ severity: 'error', message: 'x-kiki.permissions.uiPanel is required for panel contributions' });
  }
  for (const panel of value.panels ?? []) {
    checkAborted(signal);
    const file = await safePluginFile(root, panel.path, signal);
    checkAborted(signal);
    let panelStat: Awaited<ReturnType<typeof stat>> | undefined;
    if (file !== undefined) {
      checkAborted(signal);
      panelStat = await stat(file);
      checkAborted(signal);
    }
    if (file === undefined || panelStat === undefined || panelStat.size > 256 * 1024) {
      diagnostics.push({ severity: 'error', message: `Panel ${panel.id} must reference an HTML file under 256 KiB inside the plugin` });
      continue;
    }
    const assetFiles: Record<string, string> = {};
    for (const asset of panel.assets ?? []) {
      checkAborted(signal);
      const resolved = await safePluginFile(root, asset, signal);
      checkAborted(signal);
      let assetStat: Awaited<ReturnType<typeof stat>> | undefined;
      if (resolved !== undefined) {
        checkAborted(signal);
        assetStat = await stat(resolved);
        checkAborted(signal);
      }
      if (resolved === undefined || assetStat === undefined || assetStat.size > 512 * 1024 ||
        !/\.(?:js|css|svg|png|webp)$/i.test(resolved)) {
        diagnostics.push({ severity: 'error', message: `Panel ${panel.id} asset ${asset} is invalid or exceeds 512 KiB` });
      } else assetFiles[asset.slice(2)] = resolved;
    }
    checkAborted(signal);
    panels.push({ ...panel, file, assetFiles });
  }
  checkAborted(signal);
  return {
    engines: value.engines,
    tier: value.tier,
    slots: value.slots,
    permissions: value.permissions,
    themes,
    providerPresets: value.providerPresets,
    tools: value.tools,
    sessionSources: value.sessionSources,
    mediaProviders: value.mediaProviders,
    asrProviders: value.asrProviders,
    harnessAccountSources: value.harnessAccountSources,
    harnessQuotaSources: value.harnessQuotaSources,
    imAdapters: value.imAdapters,
    dependencies: value.dependencies,
    mediaSources: value.mediaSources,
    mediaScriptProvider: value.mediaScriptProvider,
    panels,
    commands: value.commands,
    entry: resolvedEntry,
    activation: value.activation,
    settings: value.settings,
    requestProjection: value.requestProjection,
    mediaSurface: value.mediaSurface,
  };
}

async function safePluginFile(root: string, relative: string, signal?: AbortSignal): Promise<string | undefined> {
  checkAborted(signal);
  const base = await realpath(root);
  checkAborted(signal);
  const candidate = path.resolve(base, relative);
  let file: string | undefined;
  try {
    checkAborted(signal);
    file = await realpath(candidate);
    checkAborted(signal);
  } catch {
    checkAborted(signal);
    file = undefined;
  }
  if (file === undefined) return undefined;
  const within = path.relative(base, file);
  if (within.startsWith('..') || path.isAbsolute(within)) return undefined;
  checkAborted(signal);
  const fileStat = await stat(file);
  checkAborted(signal);
  return fileStat.isFile() ? file : undefined;
}
