import { z } from 'zod';
import {
  TLS_FINGERPRINT_PATTERN,
  isDirectConnectionHost,
  isLoopbackHost,
  isValidTargetHostname,
} from '../pairing';

export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_WS_SUBPROTOCOL = 'kiki-relay-v1';
export const RELAY_SHARE_URI_PREFIX = 'kiki-relay://';

const safeRelayLabel = /* @__PURE__ */ z.string().min(1).max(128).regex(/^[^\u0000-\u001F\u007F]+$/);

export const relayNodeRoleSchema = /* @__PURE__ */ z.enum(['auto', 'backup-only']);
export type RelayNodeRole = z.infer<typeof relayNodeRoleSchema>;

export const relayNodeSlotSchema = /* @__PURE__ */ z.enum([
  'home',
  'standby',
  'backup-only',
  'connecting',
  'offline',
  'disabled',
  'error',
]);
export type RelayNodeSlot = z.infer<typeof relayNodeSlotSchema>;

export const relayNodeConfigSchema = /* @__PURE__ */ z.object({
  id: z.string().min(1).max(128),
  label: safeRelayLabel.optional(),
  url: z.string().min(1).max(2048),
  token: z.string().min(1).max(512).optional(),
  role: relayNodeRoleSchema.default('auto'),
  enabled: z.boolean().default(true),
  subscriptionId: z.string().min(1).max(128).optional(),
}).strict();
export type RelayNodeConfig = z.infer<typeof relayNodeConfigSchema>;

export const relaySubscriptionConfigSchema = /* @__PURE__ */ z.object({
  id: z.string().min(1).max(128),
  url: z.string().url().max(2048),
  label: safeRelayLabel.optional(),
  enabled: z.boolean().default(true),
  etag: z.string().max(512).optional(),
  refreshIntervalSec: z.number().int().min(60).max(604_800).optional(),
  lastSyncedAt: z.number().int().nonnegative().optional(),
  lastError: z.string().max(512).optional(),
}).strict();
export type RelaySubscriptionConfig = z.infer<typeof relaySubscriptionConfigSchema>;

export const relayManifestNodeSchema = /* @__PURE__ */ z.object({
  id: z.string().min(1).max(128),
  name: safeRelayLabel.optional(),
  url: z.string().min(1).max(2048),
  token: z.string().min(1).max(512).optional(),
  role: relayNodeRoleSchema.optional(),
}).strict();
export type RelayManifestNode = z.infer<typeof relayManifestNodeSchema>;

export const relayManifestSchema = /* @__PURE__ */ z.object({
  version: z.literal(1),
  title: safeRelayLabel.optional(),
  refreshIntervalSec: z.number().int().min(60).max(604_800).optional(),
  nodes: z.array(relayManifestNodeSchema).max(64),
}).strict();
export type RelayManifest = z.infer<typeof relayManifestSchema>;

export const relayNodeLiveStatusSchema = /* @__PURE__ */ z.object({
  id: z.string().min(1).max(128),
  label: z.string().max(128),
  url: z.string().min(1).max(2048),
  role: relayNodeRoleSchema,
  enabled: z.boolean(),
  tokenConfigured: z.boolean(),
  subscriptionId: z.string().min(1).max(128).optional(),
  slot: relayNodeSlotSchema,
  connected: z.boolean(),
  rttMs: z.number().int().nonnegative().optional(),
  lastConnectedAt: z.number().int().nonnegative().optional(),
  lastError: z.string().max(512).optional(),
  publishedStreamUrl: z.string().max(2048).optional(),
}).strict();
export type RelayNodeLiveStatus = z.infer<typeof relayNodeLiveStatusSchema>;

export const relayLocalServerStateSchema = /* @__PURE__ */ z.object({
  state: z.enum(['stopped', 'starting', 'running', 'error']),
  port: z.number().int().min(1).max(65535).optional(),
  basePath: z.string().max(256).optional(),
  shareUri: z.string().max(2048).optional(),
  pid: z.number().int().positive().optional(),
  error: z.string().max(512).optional(),
}).strict();
export type RelayLocalServerState = z.infer<typeof relayLocalServerStateSchema>;

export const relayStatusSchema = /* @__PURE__ */ z.object({
  schemaVersion: z.literal(1),
  hostFingerprint: z.string().regex(TLS_FINGERPRINT_PATTERN).optional(),
  inboundEnabled: z.boolean(),
  homeNodeId: z.string().min(1).max(128).optional(),
  standbyNodeIds: z.array(z.string().min(1).max(128)),
  nodes: z.array(relayNodeLiveStatusSchema),
  subscriptions: z.array(relaySubscriptionConfigSchema),
  localServer: relayLocalServerStateSchema.optional(),
}).strict();
export type RelayStatus = z.infer<typeof relayStatusSchema>;

export const relayNodeCreateInputSchema = /* @__PURE__ */ z.union([
  z.object({
    uri: z.string().min(1).max(2048),
    enabled: z.boolean().optional(),
  }).strict(),
  z.object({
    id: z.string().min(1).max(128).optional(),
    label: safeRelayLabel.optional(),
    url: z.string().min(1).max(2048),
    token: z.string().min(1).max(512).optional(),
    role: relayNodeRoleSchema.optional(),
    enabled: z.boolean().optional(),
  }).strict(),
]);
export type RelayNodeCreateInput = z.infer<typeof relayNodeCreateInputSchema>;

export const relayNodePatchInputSchema = /* @__PURE__ */ z.object({
  label: safeRelayLabel.nullable().optional(),
  url: z.string().min(1).max(2048).optional(),
  token: z.string().min(1).max(512).nullable().optional(),
  role: relayNodeRoleSchema.optional(),
  enabled: z.boolean().optional(),
}).strict();
export type RelayNodePatchInput = z.infer<typeof relayNodePatchInputSchema>;

export function isValidRelaySubscriptionUrl(raw: string): boolean {
  try {
    const parsed = new URL(String(raw ?? '').trim());
    if (parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') return false;
    if (!isValidTargetHostname(parsed.hostname)) return false;
    if (parsed.protocol === 'https:') return true;
    if (parsed.protocol === 'http:') {
      return isLoopbackHost(parsed.hostname) || isDirectConnectionHost(parsed.hostname);
    }
    return false;
  } catch {
    return false;
  }
}

export const relaySubscriptionCreateInputSchema = /* @__PURE__ */ z.object({
  url: z
    .string()
    .url()
    .max(2048)
    .refine(
      isValidRelaySubscriptionUrl,
      'Relay subscription URL must use HTTPS (or loopback/private HTTP)',
    ),
  label: safeRelayLabel.optional(),
  enabled: z.boolean().optional(),
}).strict();
export type RelaySubscriptionCreateInput = z.infer<typeof relaySubscriptionCreateInputSchema>;

export const relayProbeInputSchema = /* @__PURE__ */ z.object({
  url: z.string().min(1).max(2048),
}).strict();
export type RelayProbeInput = z.infer<typeof relayProbeInputSchema>;

export const relayProbeResultSchema = /* @__PURE__ */ z.object({
  ok: z.boolean(),
  url: z.string().min(1).max(2048),
  rttMs: z.number().int().nonnegative().optional(),
  version: z.number().int().positive().optional(),
  error: z.string().max(512).optional(),
}).strict();
export type RelayProbeResult = z.infer<typeof relayProbeResultSchema>;

export const relayDeployProxyTargetSchema = /* @__PURE__ */ z.enum([
  'nginx',
  'caddy',
  'openresty',
  'cloudflare',
]);
export type RelayDeployProxyTarget = z.infer<typeof relayDeployProxyTargetSchema>;

export const relaySettingsPatchSchema = /* @__PURE__ */ z.object({
  localServerEnabled: z.boolean().nullable().optional(),
  localServerPort: z.number().int().min(1).max(65535).nullable().optional(),
  localServerBasePath: z.string().max(256).nullable().optional(),
  localServerPublicUrl: z.string().max(2048).nullable().optional(),
}).strict();
export type RelaySettingsPatch = z.infer<typeof relaySettingsPatchSchema>;

export interface ParsedRelayShareUri {
  readonly url: string;
  readonly label?: string;
  readonly token?: string;
  readonly role: RelayNodeRole;
  readonly insecure: boolean;
}

export function normalizeRelayBaseUrl(
  raw: string,
  options?: { readonly allowInsecureWs?: boolean },
): string | undefined {
  const trimmed = String(raw ?? '').trim();
  if (trimmed === '') return undefined;
  let candidate = trimmed;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    const firstSegment = candidate.split(/[/?#]/, 1)[0] ?? '';
    const rawHost = firstSegment.startsWith('[')
      ? firstSegment.slice(0, firstSegment.indexOf(']') + 1)
      : (firstSegment.split(':', 1)[0] ?? '');
    const defaultWs = isLoopbackHost(rawHost) || isDirectConnectionHost(rawHost);
    candidate = `${defaultWs ? 'ws' : 'wss'}://${candidate}`;
  }
  try {
    const parsed = new URL(candidate);
    let protocol = parsed.protocol.toLowerCase();
    if (protocol === 'https:') protocol = 'wss:';
    else if (protocol === 'http:') protocol = 'ws:';
    if (protocol !== 'wss:' && protocol !== 'ws:') return undefined;
    if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
      return undefined;
    }
    if (!isValidTargetHostname(parsed.hostname)) return undefined;
    const allowInsecure =
      options?.allowInsecureWs === true ||
      isLoopbackHost(parsed.hostname) ||
      isDirectConnectionHost(parsed.hostname);
    if (protocol === 'ws:' && !allowInsecure) {
      return undefined;
    }
    let pathname = parsed.pathname
      .replace(/\/v1\/(?:host|probe|health|stream|pool|mux|connect(?:\/[^/]*)?)\/?$/i, '')
      .replace(/\/+$/, '');
    if (pathname === '/') pathname = '';
    const defaultPort =
      (protocol === 'wss:' && parsed.port === '443') ||
      (protocol === 'ws:' && parsed.port === '80');
    const host = defaultPort ? parsed.hostname.toLowerCase() : parsed.host.toLowerCase();
    return `${protocol}//${host}${pathname}`;
  } catch {
    return undefined;
  }
}

export function relayCanonicalOriginPath(relayBaseUrl: string): string {
  const parsed = new URL(relayBaseUrl);
  const defaultPort =
    ((parsed.protocol === 'wss:' || parsed.protocol === 'https:') && parsed.port === '443') ||
    ((parsed.protocol === 'ws:' || parsed.protocol === 'http:') && parsed.port === '80');
  const host = defaultPort ? parsed.hostname.toLowerCase() : parsed.host.toLowerCase();
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  return `${host}${pathname}`;
}

export function parseRelayShareUri(raw: string): ParsedRelayShareUri | undefined {
  const text = String(raw ?? '').trim();
  if (!/^kiki-relay:\/\//i.test(text)) return undefined;
  try {
    const rewritten = `https://${text.slice('kiki-relay://'.length)}`;
    const parsed = new URL(rewritten);
    if (parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') return undefined;
    if (!isValidTargetHostname(parsed.hostname)) return undefined;
    const insecureParam = parsed.searchParams.get('insecure');
    const insecure = insecureParam === '1' || insecureParam?.toLowerCase() === 'true';
    const roleParam = parsed.searchParams.get('role');
    let role: RelayNodeRole = 'auto';
    if (roleParam !== null && roleParam !== '') {
      if (roleParam === 'backup' || roleParam === 'backup-only') role = 'backup-only';
      else if (roleParam === 'auto') role = 'auto';
      else return undefined;
    }
    const nameParam = parsed.searchParams.get('name')?.trim();
    const tokenParam = parsed.searchParams.get('token')?.trim();
    if (nameParam !== undefined && nameParam !== '' && /[\u0000-\u001F\u007F]/.test(nameParam)) {
      return undefined;
    }
    if (tokenParam !== undefined && tokenParam !== '' && /[\u0000-\u001F\u007F]/.test(tokenParam)) {
      return undefined;
    }
    const baseCandidate = `${insecure ? 'ws' : 'wss'}://${parsed.host}${parsed.pathname}`;
    const url = normalizeRelayBaseUrl(baseCandidate);
    if (url === undefined) return undefined;
    return {
      url,
      ...(nameParam !== undefined && nameParam !== '' ? { label: nameParam.slice(0, 128) } : {}),
      ...(tokenParam !== undefined && tokenParam !== '' ? { token: tokenParam.slice(0, 512) } : {}),
      role,
      insecure,
    };
  } catch {
    return undefined;
  }
}

export function formatRelayShareUri(input: {
  readonly url: string;
  readonly label?: string;
  readonly token?: string;
  readonly role?: RelayNodeRole;
}): string {
  const rawParsed = new URL(input.url);
  const insecure = rawParsed.protocol === 'ws:' || rawParsed.protocol === 'http:';
  const normalized = normalizeRelayBaseUrl(input.url);
  if (normalized === undefined) {
    throw new Error('Invalid relay base URL');
  }
  const parsed = new URL(normalized);
  const params = new URLSearchParams();
  if (input.label !== undefined && input.label.trim() !== '') {
    params.set('name', input.label.trim());
  }
  if (input.token !== undefined && input.token.trim() !== '') {
    params.set('token', input.token.trim());
  }
  if (input.role === 'backup-only') {
    params.set('role', 'backup-only');
  }
  if (insecure) {
    params.set('insecure', '1');
  }
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  const query = params.toString();
  return `${RELAY_SHARE_URI_PREFIX}${parsed.host}${pathname}${query === '' ? '' : `?${query}`}`;
}

export type ClassifiedRelayInput =
  | { readonly kind: 'share-uri'; readonly share: ParsedRelayShareUri }
  | { readonly kind: 'subscription-url'; readonly url: string }
  | { readonly kind: 'node-url'; readonly url: string }
  | { readonly kind: 'invalid' };

export function classifyRelayInput(raw: string): ClassifiedRelayInput {
  const text = String(raw ?? '').trim();
  if (text === '') return { kind: 'invalid' };
  if (/^kiki-relay:\/\//i.test(text)) {
    const share = parseRelayShareUri(text);
    return share === undefined ? { kind: 'invalid' } : { kind: 'share-uri', share };
  }
  if (/^https?:\/\//i.test(text)) {
    try {
      const parsed = new URL(text);
      if (parsed.username !== '' || parsed.password !== '' || !isValidTargetHostname(parsed.hostname)) {
        return { kind: 'invalid' };
      }
      const isHttpsOrLocal =
        parsed.protocol === 'https:' ||
        isLoopbackHost(parsed.hostname) ||
        isDirectConnectionHost(parsed.hostname);
      if (!isHttpsOrLocal) return { kind: 'invalid' };
      if (
        parsed.pathname.toLowerCase().endsWith('.json') ||
        parsed.searchParams.get('format') === 'relays'
      ) {
        return { kind: 'subscription-url', url: parsed.toString() };
      }
    } catch {
      return { kind: 'invalid' };
    }
  }
  const nodeUrl = normalizeRelayBaseUrl(text);
  if (nodeUrl !== undefined) {
    return { kind: 'node-url', url: nodeUrl };
  }
  return { kind: 'invalid' };
}

export interface RelayDeployGuide {
  readonly publicHost: string;
  readonly basePath: string;
  readonly port: number;
  readonly proxyTarget: RelayDeployProxyTarget;
  readonly npxCommand: string;
  readonly dockerCommand: string;
  readonly dockerComposeYaml: string;
  readonly proxySnippet: string;
}

export function generateRelayDeployGuide(options?: {
  readonly publicHost?: string;
  readonly basePath?: string;
  readonly port?: number;
  readonly proxyTarget?: RelayDeployProxyTarget;
}): RelayDeployGuide {
  const rawHost = options?.publicHost?.trim() || 'relay.example.com';
  const publicHost = isValidTargetHostname(rawHost) ? rawHost.toLowerCase() : 'relay.example.com';
  const rawPath = options?.basePath?.trim() ?? '/kiki-relay';
  const normalizedPath =
    rawPath === '' || rawPath === '/'
      ? ''
      : `/${rawPath.replace(/^\/+|\/+$/g, '')}`;
  const port =
    options?.port !== undefined && Number.isInteger(options.port) && options.port >= 1 && options.port <= 65535
      ? options.port
      : 9440;
  const proxyTarget = options?.proxyTarget ?? 'caddy';
  const publicUrl = `wss://${publicHost}${normalizedPath}`;
  const basePathArg = normalizedPath === '' ? '' : ` --base-path ${normalizedPath}`;

  const npxCommand =
    'export RELAY_HOST_TOKEN="$(openssl rand -hex 24)" RELAY_SECRET="$(openssl rand -hex 32)" && ' +
    `node server/kiki-relay-server.mjs --host 127.0.0.1 --port ${port}${basePathArg} --public-url ${publicUrl}`;
  const dockerCommand = [
    'export RELAY_HOST_TOKEN="$(openssl rand -hex 24)" RELAY_SECRET="$(openssl rand -hex 32)" && \\',
    'docker build -f server/Dockerfile -t kiki-relay:local . && \\',
    'docker run -d --name kiki-relay --restart unless-stopped \\',
    `  -p 127.0.0.1:${port}:${port} \\`,
    `  -e RELAY_PORT="${port}" \\`,
    ...(normalizedPath === '' ? [] : [`  -e RELAY_BASE_PATH="${normalizedPath}" \\`]),
    `  -e RELAY_PUBLIC_URL="${publicUrl}" \\`,
    '  -e RELAY_HOST_TOKEN="${RELAY_HOST_TOKEN:?Set RELAY_HOST_TOKEN}" \\',
    '  -e RELAY_SECRET="${RELAY_SECRET:?Set RELAY_SECRET}" \\',
    '  kiki-relay:local',
  ].join('\n');

  const dockerComposeYaml = [
    'services:',
    '  kiki-relay:',
    '    build:',
    '      context: .',
    '      dockerfile: server/Dockerfile',
    '    restart: unless-stopped',
    '    ports:',
    `      - "127.0.0.1:${port}:${port}"`,
    '    environment:',
    `      RELAY_PORT: "${port}"`,
    ...(normalizedPath === '' ? [] : [`      RELAY_BASE_PATH: "${normalizedPath}"`]),
    `      RELAY_PUBLIC_URL: "${publicUrl}"`,
    '      RELAY_HOST_TOKEN: "${RELAY_HOST_TOKEN:?Set RELAY_HOST_TOKEN}"',
    '      RELAY_SECRET: "${RELAY_SECRET:?Set RELAY_SECRET}"',
    '      RELAY_TRUST_PROXY: "1"',
  ].join('\n');

  const locationPath = normalizedPath === '' ? '/v1' : normalizedPath;
  let proxySnippet: string;
  switch (proxyTarget) {
    case 'caddy':
      proxySnippet =
        normalizedPath === ''
          ? [
              `${publicHost} {`,
              `  reverse_proxy 127.0.0.1:${port} {`,
              '    flush_interval -1',
              '  }',
              '}',
            ].join('\n')
          : [
              `${publicHost} {`,
              `  handle ${normalizedPath}* {`,
              `    reverse_proxy 127.0.0.1:${port} {`,
              '      flush_interval -1',
              '    }',
              '  }',
              '}',
            ].join('\n');
      break;
    case 'cloudflare':
      proxySnippet = [
        'tunnel: <YOUR_TUNNEL_UUID>',
        'ingress:',
        `  - hostname: ${publicHost}`,
        ...(normalizedPath === '' ? [] : [`    path: ^${normalizedPath}(/.*)?$`]),
        `    service: http://127.0.0.1:${port}`,
        '    originRequest:',
        '      noHappyEyeballs: true',
        '      keepAliveTimeout: 300s',
        '  - service: http_status:404',
      ].join('\n');
      break;
    case 'openresty':
    case 'nginx':
    default:
      proxySnippet = [
        `location ${locationPath}/ {`,
        `    proxy_pass http://127.0.0.1:${port};`,
        '    proxy_http_version 1.1;',
        '    proxy_set_header Upgrade $http_upgrade;',
        '    proxy_set_header Connection "upgrade";',
        '    proxy_set_header Host $host;',
        '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
        '    proxy_set_header X-Forwarded-Proto $scheme;',
        '    proxy_read_timeout 3600s;',
        '    proxy_send_timeout 3600s;',
        '    proxy_buffering off;',
        '}',
      ].join('\n');
      break;
  }

  return {
    publicHost,
    basePath: normalizedPath,
    port,
    proxyTarget,
    npxCommand,
    dockerCommand,
    dockerComposeYaml,
    proxySnippet,
  };
}
