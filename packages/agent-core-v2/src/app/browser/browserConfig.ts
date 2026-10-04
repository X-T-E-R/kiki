import { isAbsolute } from 'pathe';
import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const BROWSER_CONFIG_SECTION = 'browserControl';
export const BrowserIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const absolutePath = z.string().min(1).refine((value) => isAbsolute(value) && !value.includes('\0'), 'Expected an absolute server path');
const common = { name: z.string().trim().min(1).max(256), enabled: z.boolean().default(true), driverPath: absolutePath.optional() };
const endpoint = z.string().max(8192).refine((value) => {
  try { return ['http:', 'https:', 'ws:', 'wss:'].includes(new URL(value).protocol) && !/[\r\n\0]/.test(value); }
  catch { return false; }
}, 'Expected a CDP HTTP or WebSocket endpoint');

export const BrowserStoredConnectionSchema = z.discriminatedUnion('type', [
  z.object({ ...common, type: z.literal('agent-browser-profile'), profilePath: absolutePath.optional(), executablePath: absolutePath.optional(), headed: z.boolean().optional() }).strict(),
  z.object({ ...common, type: z.literal('agent-browser-cdp'), endpointSecret: endpoint }).strict(),
]);
export type BrowserStoredConnection = z.infer<typeof BrowserStoredConnectionSchema>;
export type BrowserResolvedConnection = BrowserStoredConnection & { readonly id: string };

export const BrowserEndpointEditSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep') }).strict(),
  z.object({ action: z.literal('set'), value: endpoint }).strict(),
]);
export const BrowserConnectionInputSchema = z.discriminatedUnion('type', [
  z.object({ ...common, type: z.literal('agent-browser-profile'), profilePath: absolutePath.optional(), executablePath: absolutePath.optional(), headed: z.boolean().optional() }).strict(),
  z.object({ ...common, type: z.literal('agent-browser-cdp'), endpoint: BrowserEndpointEditSchema }).strict(),
]);
export type BrowserConnectionInput = z.infer<typeof BrowserConnectionInputSchema>;

export const BrowserConfigSchema = z.object({
  connections: z.record(BrowserIdSchema, BrowserStoredConnectionSchema).default({}),
  defaultBrowser: BrowserIdSchema.optional(),
}).strict();
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;

registerConfigSection(BROWSER_CONFIG_SECTION, BrowserConfigSchema, { defaultValue: { connections: {} } });

export interface BrowserConnectionRecord {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly type: 'agent-browser-profile' | 'agent-browser-cdp';
  readonly driverPath?: string;
  readonly profilePath?: string;
  readonly executablePath?: string;
  readonly headed?: boolean;
  readonly endpointDisplay?: string;
  readonly endpointConfigured?: boolean;
}

export function browserConnectionRecord(connection: BrowserResolvedConnection): BrowserConnectionRecord {
  if (connection.type === 'agent-browser-profile') return { ...connection };
  const endpoint = new URL(connection.endpointSecret);
  return { id: connection.id, name: connection.name, enabled: connection.enabled, type: connection.type,
    driverPath: connection.driverPath, endpointDisplay: `${endpoint.protocol}//${endpoint.host}`, endpointConfigured: true };
}
