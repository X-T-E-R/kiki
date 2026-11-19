import { z } from 'zod';
import { asrProviderDefinitionSchema } from '../plugin';

export const pluginPreviewRequestSchema = z.object({
  source: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
});

export const pluginInstallRequestSchema = pluginPreviewRequestSchema.extend({
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  consent: z.boolean(),
  defaultEnabled: z.boolean().optional(),
});

export const pluginInstallPlanSchema = z.object({
  id: z.string(),
  version: z.string().optional(),
  fingerprint: z.string(),
  changes: z.array(z.string()),
  consentRequired: z.boolean(),
  permissions: z.object({
    fs: z.enum(['workspace', 'outside']).optional(),
    net: z.array(z.string()).optional(),
    exec: z.array(z.string()).optional(),
    secrets: z.boolean().optional(),
    uiPanel: z.boolean().optional(),
  }).optional(),
  contributions: z.array(z.string()),
  appService: z.boolean().optional(),
  contextTokens: z.number(),
  unsupported: z.array(z.string()),
});

export const pluginSettingsResponseSchema = z.object({
  schema: z.unknown().optional(),
  values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  secretsConfigured: z.array(z.string()),
});

export { pluginModelCatalogSchema, type PluginModelCatalog } from '@kiki/plugin-sdk';

export const pluginSettingsPatchSchema = z.object({
  values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

export const pluginPrerequisiteInstallSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  consent: z.literal(true),
});

export const pluginPanelSummarySchema = z.object({
  pluginId: z.string(), id: z.string(), label: z.string(), slot: z.enum(['sidebar', 'workspace', 'settings']),
});
export const pluginPanelDocumentSchema = z.object({ html: z.string(), url: z.string().optional(), sandbox: z.literal('allow-scripts') });
export const pluginPanelBridgeRequestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('session.summary'), session_id: z.string().min(1) }),
  z.object({ method: z.literal('session.sendMessage'), session_id: z.string().min(1), text: z.string().min(1).max(16_384) }),
  z.object({ method: z.literal('plugin.call'), session_id: z.string().min(1).optional(), action: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/), args: z.unknown() }),
  z.object({ method: z.literal('plugin.settings.get') }),
  z.object({ method: z.literal('plugin.settings.patch'), values: pluginSettingsPatchSchema.shape.values }),
  z.object({ method: z.literal('plugin.models.list') }),
]);
export const pluginPanelBridgeResponseSchema = z.object({ result: z.unknown() });

export type PluginPanelSummary = z.infer<typeof pluginPanelSummarySchema>;
export type PluginPanelDocument = z.infer<typeof pluginPanelDocumentSchema>;
export type PluginPanelBridgeRequest = z.infer<typeof pluginPanelBridgeRequestSchema>;
export type PluginPanelBridgeResponse = z.infer<typeof pluginPanelBridgeResponseSchema>;
export type PluginSettingsResponse = z.infer<typeof pluginSettingsResponseSchema>;
export type PluginSettingsPatch = z.infer<typeof pluginSettingsPatchSchema>;
export type PluginPrerequisiteInstall = z.infer<typeof pluginPrerequisiteInstallSchema>;
export type PluginPreviewRequest = z.infer<typeof pluginPreviewRequestSchema>;
export type PluginInstallRequest = z.infer<typeof pluginInstallRequestSchema>;
export type PluginInstallPlan = z.infer<typeof pluginInstallPlanSchema>;

export const pluginNavigationSchema = z.object({
  request: z.object({ id: z.number().int(), pluginId: z.string(), sessionId: z.string(), at: z.number() }).optional(),
});
export type PluginNavigation = z.infer<typeof pluginNavigationSchema>;

export const pluginUsageTargetSchema = z.union([
  z.object({ workspace_id: z.string().min(1) }).strict(),
  z.object({ session_id: z.string().min(1) }).strict(),
]);
export const pluginUsageOverrideSchema = z.enum(['inherit', 'on', 'off']);
export const pluginUsageRequestSchema = z.object({ target: pluginUsageTargetSchema, plugin_id: z.string().min(1), override: pluginUsageOverrideSchema }).strict();
export const pluginUsageItemSchema = z.object({
  id: z.string(), displayName: z.string(), version: z.string().optional(), icon: z.string().optional(),
  home_enabled: z.boolean(), global_enabled: z.boolean(), state: z.enum(['ok', 'error']), override: pluginUsageOverrideSchema,
  session_override: pluginUsageOverrideSchema.optional(),
  effective: z.boolean(), reason: z.enum(['home_disabled', 'workspace_disabled', 'session_disabled', 'global_disabled', 'invalid_plugin']).optional(),
  app_service: z.boolean(), skillCount: z.number(), mcpServerCount: z.number(),
});
export const pluginUsageResponseSchema = z.object({
  home_id: z.string(), target: z.object({ workspace_id: z.string(), name: z.string(), root: z.string(), session_id: z.string().optional() }),
  revision: z.number().int().nonnegative(), apply_state: z.enum(['applied', 'pending', 'failed']),
  errors: z.array(z.string()), plugins: z.array(pluginUsageItemSchema),
});
export type PluginUsageTarget = z.infer<typeof pluginUsageTargetSchema>;
export type PluginUsageOverride = z.infer<typeof pluginUsageOverrideSchema>;
export type PluginUsageRequest = z.infer<typeof pluginUsageRequestSchema>;
export type PluginUsageResponse = z.infer<typeof pluginUsageResponseSchema>;
export type PluginUsageItem = z.infer<typeof pluginUsageItemSchema>;

/** GitHub provenance for github-sourced plugins (domain PluginGithubMetadata). */
export const pluginGithubMetadataSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  ref: z.object({
    kind: z.enum(['branch', 'tag', 'sha']),
    value: z.string(),
  }),
  installedSha: z.string().optional(),
});

export const pluginSummarySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  version: z.string().optional(),
  icon: z.string().optional(),
  enabled: z.boolean(),
  globalEnabled: z.boolean(),
  defaultEnabled: z.boolean().optional(),
  asrProviders: z.array(asrProviderDefinitionSchema).optional(),
  state: z.enum(['ok', 'error']),
  skillCount: z.number(),
  mcpServerCount: z.number(),
  enabledMcpServerCount: z.number(),
  hookCount: z.number(),
  commandCount: z.number(),
  hasErrors: z.boolean(),
  source: z.enum(['local-path', 'zip-url', 'github']),
  originalSource: z.string().optional(),
  github: pluginGithubMetadataSchema.optional(),
  zipSha256: z.string().optional(),
  rollback: z.object({
    version: z.string().optional(),
    source: z.enum(['local-path', 'zip-url', 'github']),
    originalSource: z.string().optional(),
    github: pluginGithubMetadataSchema.optional(),
    zipSha256: z.string().optional(),
  }).optional(),
});
export type PluginSummaryWire = z.infer<typeof pluginSummarySchema>;

export const listPluginsResponseSchema = z.object({
  plugins: z.array(pluginSummarySchema),
});
export type ListPluginsResponse = z.infer<typeof listPluginsResponseSchema>;

export const installPluginRequestSchema = pluginInstallRequestSchema;
export type InstallPluginRequest = z.infer<typeof installPluginRequestSchema>;

export const pluginMarketplaceEntrySchema = z.object({
  id: z.string(),
  tier: z.enum(['official', 'curated', 'third-party']),
  displayName: z.string(),
  description: z.string().optional(),
  homepage: z.string().optional(),
  icon: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  relevance: z.object({
    cwd: z.array(z.string()).optional(),
    fileGlobs: z.array(z.string()).optional(),
    commands: z.array(z.string()).optional(),
    dependencies: z.array(z.string()).optional(),
  }).optional(),
  version: z.string().optional(),
  source: z.string(),
  sha256: z.string().optional(),
  engines: z.object({ kiki: z.string().optional() }).optional(),
  author: z.string().optional(),
  license: z.string().optional(),
  installable: z.boolean().optional(),
  group: z.string().optional(),
  localizations: z
    .record(
      z.string(),
      z.object({
        displayName: z.string().optional(),
        description: z.string().optional(),
        keywords: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  installed: z
    .object({
      version: z.string().optional(),
      enabled: z.boolean(),
    })
    .optional(),
  updateAvailable: z.boolean().optional(),
  capabilityId: z.string().optional(),
});
export type PluginMarketplaceEntryWire = z.infer<typeof pluginMarketplaceEntrySchema>;

export const pluginMarketplaceResponseSchema = z.object({
  configured: z.boolean(),
  source: z.string().optional(),
  entries: z.array(pluginMarketplaceEntrySchema),
});
export type PluginMarketplaceResponse = z.infer<typeof pluginMarketplaceResponseSchema>;

export const pluginMcpServerInfoSchema = z.object({
  name: z.string(),
  runtimeName: z.string(),
  enabled: z.boolean(),
  transport: z.enum(['stdio', 'http', 'sse']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  envKeys: z.array(z.string()).optional(),
  headerKeys: z.array(z.string()).optional(),
});

export const pluginDiagnosticSchema = z.object({
  severity: z.enum(['error', 'warn', 'info']),
  message: z.string(),
});

export const pluginInfoSchema = pluginSummarySchema.extend({
  root: z.string(),
  installedAt: z.string(),
  updatedAt: z.string().optional(),
  manifestKind: z.enum(['kimi-plugin-root', 'kimi-plugin-dir', 'claude-code']).optional(),
  manifestPath: z.string().optional(),
  manifest: z.unknown().optional(),
  prerequisites: z.object({
    origin: z.enum(['kiki-compatibility', 'plugin-declared']),
    items: z.object({
      schemaVersion: z.literal(1),
      items: z.array(z.object({
        id: z.string(),
        kind: z.enum(['host-capability', 'daemon', 'browser-extension', 'executable', 'configuration']),
        required: z.boolean(),
        provider: z.string().optional(),
        executionHost: z.string().optional(),
        version: z.string().optional(),
        setting: z.string().optional(),
        dependsOn: z.array(z.string()).optional(),
        capabilityImpact: z.array(z.string()).optional(),
      })),
    }),
  }).optional(),
  mcpServers: z.array(pluginMcpServerInfoSchema),
  shadowedManifestPath: z.string().optional(),
  diagnostics: z.array(pluginDiagnosticSchema),
});
export type PluginInfoWire = z.infer<typeof pluginInfoSchema>;

export const pluginIdParamSchema = z.object({
  tail: z.string().min(1),
});
export type PluginIdParam = z.infer<typeof pluginIdParamSchema>;

export const pluginInfoParamSchema = z.object({
  plugin_id: z.string().min(1),
});
export type PluginInfoParam = z.infer<typeof pluginInfoParamSchema>;

const PANEL_HOST_BRIDGE_SCRIPT = `<script>(function(){
const CHANNEL='kiki.panel.v1';
function applyPresentation(p){
  if(!p||typeof p!=='object')return;
  const root=document.documentElement;
  if(p.theme==='dark'||p.theme==='light')root.style.colorScheme=p.theme;
  if(p.tokens&&typeof p.tokens==='object'){
    for(const [k,v] of Object.entries(p.tokens)){if(typeof v==='string')root.style.setProperty(k,v);}
    const aliases=[['--paper','--color-paper'],['--ink','--color-ink'],['--soft','--color-ink-soft'],['--line','--color-hairline'],['--accent','--color-accent']];
    for(const [alias,src] of aliases){if(typeof p.tokens[src]==='string')root.style.setProperty(alias,p.tokens[src]);}
  }
  if(p.locale==='en'||p.locale==='zh')root.lang=p.locale==='zh'?'zh-CN':'en';
}
let lastHeight=0;
function reportHeight(){
  const body=document.body,doc=document.documentElement;
  if(!body||!doc)return;
  const h=Math.ceil(Math.max(body.scrollHeight,body.getBoundingClientRect().height));
  if(h>0&&Math.abs(h-lastHeight)>2){
    lastHeight=h;
    parent.postMessage({channel:CHANNEL,kind:'resize',height:h},'*');
  }
}
window.addEventListener('message',function(e){
  if(e.source!==parent||!e.data||e.data.channel!==CHANNEL)return;
  if(e.data.kind==='init'||e.data.kind==='presentation'){
    applyPresentation(e.data.presentation);
    setTimeout(reportHeight,0);
  }
  if(e.data.kind==='response')setTimeout(reportHeight,0);
});
window.addEventListener('load',reportHeight);
document.addEventListener('toggle',reportHeight,true);
if(typeof ResizeObserver==='function'&&document.documentElement){
  new ResizeObserver(reportHeight).observe(document.documentElement);
}
})();</script>`;

export function withPluginPanelPresentation(html: string): string {
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${PANEL_HOST_BRIDGE_SCRIPT}</body>`);
  }
  return `${html}${PANEL_HOST_BRIDGE_SCRIPT}`;
}
