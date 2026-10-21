import { isAbsolute } from 'pathe';
import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';
import type { ConfigOrigin } from '#/app/config/config';
import { NATIVE_BROWSER_FLAG_ID } from './flag';
import type { IFlagService } from '#/app/flag/flag';

export const BROWSER_CONFIG_SECTION = 'browserControl';
export const BrowserIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const absolutePath = z.string().min(1).refine((value) => isAbsolute(value) && !value.includes('\0'), 'Expected an absolute server path');
const common = { name: z.string().trim().min(1).max(256), enabled: z.boolean().default(true), driverPath: absolutePath.optional() };
const official = { name: common.name, enabled: common.enabled, type: z.literal('codex-extension'), runtimeRoot: absolutePath, browserId: z.string().min(1).max(512) };
const endpoint = z.string().max(8192).refine((value) => {
  try { return ['http:', 'https:', 'ws:', 'wss:'].includes(new URL(value).protocol) && !/[\r\n\0]/.test(value); }
  catch { return false; }
}, 'Expected a CDP HTTP or WebSocket endpoint');

const egoLite = {
  name: common.name, enabled: common.enabled, type: z.literal('ego-lite'),
  cliPath: absolutePath.optional(), profileId: z.string().trim().min(1).max(256).optional(), serverName: z.string().trim().min(1).max(256).optional(),
};
export const BrowserStoredConnectionSchema = z.discriminatedUnion('type', [
  z.object(official).strict(),
  z.object({ ...common, type: z.literal('agent-browser-profile'), profilePath: absolutePath.optional(), executablePath: absolutePath.optional(), headed: z.boolean().optional() }).strict(),
  z.object({ ...common, type: z.literal('agent-browser-cdp'), endpointSecret: endpoint }).strict(),
  z.object(egoLite).strict(),
]);
export type BrowserStoredConnection = z.infer<typeof BrowserStoredConnectionSchema>;
export type BrowserResolvedConnection = BrowserStoredConnection & { readonly id: string };

export const BrowserEndpointEditSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep') }).strict(),
  z.object({ action: z.literal('set'), value: endpoint }).strict(),
]);
export const BrowserConnectionInputSchema = z.discriminatedUnion('type', [
  z.object(official).strict(),
  z.object({ ...common, type: z.literal('agent-browser-profile'), profilePath: absolutePath.optional(), executablePath: absolutePath.optional(), headed: z.boolean().optional() }).strict(),
  z.object({ ...common, type: z.literal('agent-browser-cdp'), endpoint: BrowserEndpointEditSchema }).strict(),
  z.object(egoLite).strict(),
]);
export type BrowserConnectionInput = z.infer<typeof BrowserConnectionInputSchema>;

export const BrowserConfigSchema = z.object({
  connections: z.record(BrowserIdSchema, BrowserStoredConnectionSchema).default({}),
  defaultBrowser: BrowserIdSchema.optional(),
  allowedBrowsers: z.array(BrowserIdSchema).max(64).optional(),
}).strict();
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;

/**
 * Browser-control save/read projection for settings.
 * `enabled` is the existing `native_browser` flag, not a second gate.
 * `allowedBrowsers` is the checkbox allow set. An unconfigured set does not
 * copy `defaultBrowser`. An explicit empty set allows list/discover only.
 */
export interface BrowserControlSettings {
  readonly enabled: boolean;
  readonly enabledSource: ConfigOrigin;
  readonly allowedBrowsers: readonly string[];
  readonly allowedBrowsersConfigured: boolean;
  readonly allowedBrowsersSource: ConfigOrigin;
}

export function readBrowserControlSettings(
  flags: IFlagService,
  origins: { readonly experimental?: ConfigOrigin; readonly allowed?: ConfigOrigin },
  allowedBrowsers: readonly string[] | undefined,
): BrowserControlSettings {
  const explained = flags.explain(NATIVE_BROWSER_FLAG_ID);
  const enabled = explained?.enabled ?? true;
  const enabledSource: ConfigOrigin = explained?.source === 'env' || explained?.source === 'master-env'
    ? 'env' : explained?.source === 'config' ? origins.experimental ?? 'home' : 'default';
  return {
    enabled, enabledSource,
    allowedBrowsers: allowedBrowsers === undefined ? [] : [...allowedBrowsers],
    allowedBrowsersConfigured: allowedBrowsers !== undefined,
    allowedBrowsersSource: allowedBrowsers === undefined ? 'default' : origins.allowed ?? 'home',
  };
}

export function browserOperationAllowed(allowedBrowsers: readonly string[] | undefined, id: string): boolean {
  return allowedBrowsers === undefined || allowedBrowsers.includes(id);
}

registerConfigSection(BROWSER_CONFIG_SECTION, BrowserConfigSchema, { defaultValue: { connections: {} } });

export interface BrowserConnectionRecord {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly type: 'agent-browser-profile' | 'agent-browser-cdp' | 'codex-extension' | 'ego-lite';
  readonly runtimeRoot?: string;
  readonly browserId?: string;
  readonly driverPath?: string;
  readonly profilePath?: string;
  readonly executablePath?: string;
  readonly headed?: boolean;
  readonly endpointDisplay?: string;
  readonly endpointConfigured?: boolean;
  readonly cliPath?: string;
  readonly profileId?: string;
  readonly serverName?: string;
}

export function browserConnectionRecord(connection: BrowserResolvedConnection): BrowserConnectionRecord {
  if (connection.type === 'ego-lite') {
    return { id: connection.id, name: connection.name, enabled: connection.enabled, type: connection.type,
      cliPath: connection.cliPath, profileId: connection.profileId, serverName: connection.serverName };
  }
  if (connection.type !== 'agent-browser-cdp') return { ...connection };
  const endpoint = new URL(connection.endpointSecret);
  return { id: connection.id, name: connection.name, enabled: connection.enabled, type: connection.type,
    driverPath: connection.driverPath, endpointDisplay: `${endpoint.protocol}//${endpoint.host}`, endpointConfigured: true };
}
