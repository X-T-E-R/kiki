import { isDeepStrictEqual } from 'node:util';
import { parse, stringify } from 'smol-toml';
import { extractPortableConfigLayer, type IConfigRegistry } from '@kiki/agent-core-v2';
import { splitConfigCredentials, mergeConfigCredentials } from '@kiki/agent-core-v2/app/config/credentials';
import type { PortableSpaceDomain, PortableSpaceExcludedItem, PortableSpaceFormat, PortableSpaceSecretMode } from '@kiki/protocol';
import { safePortablePath } from './tarArchive';
import { parseRecipients } from './ageCodec';
import { installBytes, readRecipeInstallations, RECIPE_INSTALLATIONS, RECIPE_STORE, type PortableRecipeInstallation } from './recipeStore';
import { nbSearchManagedCredentialsSchema } from '@kiki/agent-core-v2/app/nbSearch/managedCredentials';

export type Data = Record<string, unknown>;
export interface SpaceUnit { domain: PortableSpaceDomain; path: string; key: string[]; value: unknown }
export type Units = Map<string, SpaceUnit>;
export interface ForkBase { forkId: string; createdAt: string; unitHashes: Record<string, string> }
export interface PortableSpaceTree {
  units: Units;
  excluded?: PortableSpaceExcludedItem[];
  unset: Set<string>;
  overlay: boolean;
  recipients: ReturnType<typeof parseRecipients>;
  format: PortableSpaceFormat;
  secretMode: PortableSpaceSecretMode;
  encryptionMode: 'none' | 'x25519' | 'passphrase';
  label: string;
  fork?: ForkBase;
}

export const PLAIN = 'credentials/credentials.toml';
export const SEALED = `${PLAIN}.age`;
export const FORK = '.kiki-fork-base.json';
export const RECIPIENTS = '.age-recipients';
const SECRET_KEY = /(?:auth|bearer|token|secret|password|api.?key|private.?key|cookie|access.?key|signature|session|^x[-_]access$)/i;
const SAFE_MCP_ENV = new Set(['PATH', 'NODE_ENV', 'NO_COLOR', 'LANG', 'TZ']);
const ENTITY_SECTIONS = new Set(['providers', 'models']);
const platforms = ['linux', 'darwin', 'win32'];

export function object(value: unknown): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['__proto__', 'constructor', 'prototype'].includes(key)));
}

export function parseToml(bytes: Buffer | undefined): Data {
  if (bytes === undefined) return {};
  try { return parse(bytes.toString('utf8')); }
  catch { throw new Error('Invalid Portable Space TOML'); }
}

export function encodeToml(data: Data): Buffer {
  return Buffer.from(stringify(data as Parameters<typeof stringify>[0]));
}

export function configProjection(raw: Data, registry?: IConfigRegistry): { config: Data; credentials: Data } {
  const pool = object(raw['credentials']);
  const { config, credentials } = splitConfigCredentials(raw);
  delete config['credentials'];
  const providers = object(config['providers']);
  const providerSecrets = object(credentials['providers']);
  for (const [id, value] of Object.entries(providers)) {
    const provider = object(value);
    const secrets = object(providerSecrets[id]);
    for (const name of ['headers', 'custom_headers', 'customHeaders', 'env']) {
      const headers = object(provider[name]);
      const hidden = { ...object(secrets[name]) };
      for (const [key, entry] of Object.entries(headers)) {
        if (SECRET_KEY.test(key) || (typeof entry === 'string' && /^(?:bearer|basic|token)\s+\S+|^sk-[\w-]{8,}/i.test(entry))) {
          hidden[key] = entry;
          delete headers[key];
        }
      }
      if (Object.keys(headers).length) provider[name] = headers;
      else delete provider[name];
      if (Object.keys(hidden).length) secrets[name] = hidden;
    }
    if (Object.keys(secrets).length) providerSecrets[id] = secrets;
    providers[id] = provider;
  }
  if (Object.keys(providers).length) config['providers'] = providers;
  const projected = extractPortableConfigLayer(config, registry);
  const secret: Data = {};
  if (Object.keys(pool).length) secret['pool'] = pool;
  if (Object.keys(providerSecrets).length) secret['providers'] = providerSecrets;
  if (Object.keys(object(credentials['nb_search'])).length) secret['nb_search'] = credentials['nb_search'];
  return { config: projected, credentials: secret };
}

function mcpExclusionReason(server: Data): string | undefined {
  const command = server['command'];
  if (typeof command === 'string') {
    const trimmed = command.trim();
    if (!trimmed) return 'MCP command is empty';
    if (/[\\/]|^[a-z]:|^~/i.test(trimmed)) return `MCP command uses a machine-local filesystem path (${trimmed})`;
  } else {
    const url = typeof server['url'] === 'string' && URL.canParse(server['url']) ? new URL(server['url']) : undefined;
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      return 'MCP server URL is missing or does not use http/https';
    }
    if (url.username || url.password || [...url.searchParams.keys()].some((key) => SECRET_KEY.test(key))) {
      return 'MCP server URL embeds inline credentials or secret query parameters';
    }
  }
  if (Array.isArray(server['args']) && server['args'].some((arg) => typeof arg === 'string' && /^(?:[a-z]:[\\/]|[\\/]|~(?:[\\/]|$))/i.test(arg.trim()))) {
    return 'MCP arguments reference a machine-local filesystem path';
  }
  return undefined;
}

export function mcpProjection(raw: Data): { config: Data; credentials: Data; excluded: PortableSpaceExcludedItem[] } {
  const config: Data = {};
  const credentials: Data = {};
  const excluded: PortableSpaceExcludedItem[] = [];
  for (const [id, value] of Object.entries(object(raw['mcpServers'] ?? raw['servers'] ?? raw))) {
    const server = object(value);
    const reason = mcpExclusionReason(server);
    if (reason !== undefined) {
      const escapedId = `mcp:${id.replaceAll('%', '%25').replaceAll('.', '%2E')}`;
      excluded.push({
        id: escapedId.slice(0, 512),
        domain: 'mcp',
        path: `mcp.${id}`.slice(0, 512),
        reason: reason.slice(0, 512),
      });
      continue;
    }
    const split = splitConfigCredentials(server);
    for (const name of ['headers', 'env']) {
      const publicEntries = object(split.config[name]);
      const hidden = object(split.credentials[name]);
      for (const [key, entry] of Object.entries(publicEntries)) {
        const secret = name === 'env' ? !SAFE_MCP_ENV.has(key.toUpperCase())
          : SECRET_KEY.test(key) || (typeof entry === 'string' && /^(?:bearer|basic|token)\s+\S+/i.test(entry));
        if (secret) {
          hidden[key] = entry;
          delete publicEntries[key];
        }
      }
      if (Object.keys(publicEntries).length) split.config[name] = publicEntries;
      else delete split.config[name];
      if (Object.keys(hidden).length) split.credentials[name] = hidden;
    }
    delete split.config['cwd'];
    config[id] = split.config;
    if (Object.keys(split.credentials).length) credentials[id] = split.credentials;
  }
  return { config, credentials, excluded };
}

const RESERVED_PORTABLE_PLUGIN_DIRS = new Set(['managed', 'sources', 'rollback', 'data']);

export function isPortablePluginId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) && !RESERVED_PORTABLE_PLUGIN_DIRS.has(id);
}

export function hasBundledPluginManifest(id: string, paths: ReadonlySet<string>): boolean {
  return paths.has(`plugins/${id}/kimi.plugin.json`) || paths.has(`plugins/${id}/package.json`);
}

export function domainForFile(path: string): PortableSpaceDomain | undefined {
  const parts = safePortablePath(path).split('/');
  if (parts.some((part) => /^(?:\.git|\.tmp|\.ssh|\.gnupg|node_modules|credentials|config\.local\.toml|\.env(?:\..*)?|secrets?|\.secrets?|.*\.(?:pem|key|pfx|sqlite(?:3)?(?:-wal|-shm)?|lock))$/i.test(part))) return;
  if (parts.length === 1) {
    if (['AGENTS.md', 'SYSTEM.md'].includes(path)) return 'instructions';
    if (path === 'space-preferences.json') return 'appearance';
  }
  if (path.startsWith(RECIPE_STORE)) return 'recipes';
  switch (parts[0]) {
    case 'prompt': case 'prompts': case 'cognition': return 'instructions';
    case 'themes': return 'appearance';
    case 'agents': return parts[1]?.toLowerCase() === 'builtin' ? undefined : 'agents';
    case 'plugins': return parts.length >= 3 && parts[1] !== undefined && isPortablePluginId(parts[1]) ? 'plugins' : undefined;
    case 'recipes': case 'personas': case 'skills': case 'memories': case 'sessions': return parts[0];
  }
}

export function putUnit(units: Units, domain: PortableSpaceDomain, key: string[], value: unknown, path = key.join('.')): void {
  const id = `${domain}:${key.map((part) => part.replaceAll('%', '%25').replaceAll('.', '%2E')).join('.')}`;
  if (id.length > 512 || path.length > 512) throw new Error('Portable Space item identity exceeds 512 characters');
  units.set(id, { domain, key, path, value });
}

export function toUnitsWithExcluded(
  files: ReadonlyMap<string, Buffer>,
  registry?: IConfigRegistry,
): { units: Units; excluded: PortableSpaceExcludedItem[] } {
  const units: Units = new Map();
  let excluded: PortableSpaceExcludedItem[] = [];
  let secrets: Data = parseToml(files.get(PLAIN));
  for (const filename of ['config.toml', ...platforms.map((platform) => `config.${platform}.toml`)]) {
    const platform = filename.split('.')[1];
    const split = configProjection(parseToml(files.get(filename)), registry);
    if (platform === 'toml') secrets = mergeConfigCredentials(split.credentials, secrets);
    for (const [name, value] of Object.entries(split.config)) {
      const prefix = platform === 'toml' ? [] : [filename];
      if (ENTITY_SECTIONS.has(name)) {
        for (const [id, entry] of Object.entries(object(value))) putUnit(units, 'config', [...prefix, name, id], entry);
      } else putUnit(units, 'config', [...prefix, name], value);
    }
  }
  const mcp = files.get('mcp.json');
  if (mcp !== undefined) {
    let data: Data;
    try { data = object(JSON.parse(mcp.toString('utf8'))); }
    catch { throw new Error('Invalid Portable Space mcp.json'); }
    const split = mcpProjection(data);
    excluded = split.excluded;
    for (const [id, server] of Object.entries(split.config)) putUnit(units, 'mcp', [id], server, `mcp.${id}`);
    secrets = mergeConfigCredentials({ mcp: split.credentials }, secrets);
  }
  for (const [section, value] of Object.entries(secrets)) {
    if (section === 'nb_search') putUnit(units, 'credentials', [section], value);
    else if (section === 'nb_search_gui') {
      const { slots } = nbSearchManagedCredentialsSchema.parse({ schema_version: '1', slots: value });
      for (const [id, entry] of Object.entries(slots)) putUnit(units, 'credentials', [section, id], entry);
    }
    else if (['pool', 'providers', 'mcp'].includes(section)) for (const [id, entry] of Object.entries(object(value))) putUnit(units, 'credentials', [section, id], entry);
  }
  const extensions = parseToml(files.get('extensions.toml'));
  for (const [section, domain, id] of [['skill_repos', 'skills', 'name'], ['plugins', 'plugins', 'id']] as const) {
    const list = extensions[section];
    if (Array.isArray(list)) for (const entry of list) {
      const key = object(entry)[id];
      if (typeof key !== 'string' || !key) throw new Error(`Invalid ${section} declaration`);
      putUnit(units, domain, [section, key], entry);
    }
  }
  const bundledPluginPathsById = new Map<string, Set<string>>();
  for (const path of files.keys()) {
    if (domainForFile(path) !== 'plugins') continue;
    const pluginId = safePortablePath(path).split('/')[1];
    if (pluginId === undefined) continue;
    let group = bundledPluginPathsById.get(pluginId);
    if (group === undefined) {
      group = new Set<string>();
      bundledPluginPathsById.set(pluginId, group);
    }
    group.add(safePortablePath(path));
  }
  const validBundledPluginIds = new Set<string>();
  for (const [pluginId, group] of bundledPluginPathsById) {
    if (hasBundledPluginManifest(pluginId, group)) {
      validBundledPluginIds.add(pluginId);
    } else {
      excluded.push({
        id: `plugins:plugins.${pluginId.replaceAll('%', '%25').replaceAll('.', '%2E')}`.slice(0, 512),
        domain: 'plugins',
        path: `plugins/${pluginId}`.slice(0, 512),
        reason: `Bundled plugin "${pluginId}" is missing required kimi.plugin.json or package.json`,
      });
    }
  }
  for (const [path, bytes] of files) {
    if (path === RECIPE_INSTALLATIONS) {
      for (const [id, entry] of Object.entries(readRecipeInstallations(bytes))) {
        putUnit(units, 'recipes', ['installation', id], entry, `${RECIPE_INSTALLATIONS}/${id}`);
      }
      continue;
    }
    const domain = domainForFile(path);
    if (domain === 'plugins') {
      const canonical = safePortablePath(path);
      const pluginId = canonical.split('/')[1];
      if (pluginId !== undefined && validBundledPluginIds.has(pluginId)) {
        putUnit(units, 'plugins', [canonical], bytes, canonical);
      }
      continue;
    }
    if (domain) putUnit(units, domain, [path], bytes, path);
  }
  for (const pluginId of validBundledPluginIds) {
    const declarationId = `plugins:plugins.${pluginId.replaceAll('%', '%25').replaceAll('.', '%2E')}`;
    if (!units.has(declarationId)) {
      putUnit(units, 'plugins', ['plugins', pluginId], { id: pluginId, enabled: true });
    }
  }
  return { units, excluded };
}

export function toUnits(files: ReadonlyMap<string, Buffer>, registry?: IConfigRegistry): Units {
  return toUnitsWithExcluded(files, registry).units;
}

export function sections(units: Units, domain: PortableSpaceDomain): Data {
  const data: Data = {};
  for (const unit of units.values()) {
    if (unit.domain !== domain || Buffer.isBuffer(unit.value)) continue;
    const [section, id] = unit.key;
    if (section === undefined || (domain === 'config' && section.startsWith('config.'))) continue;
    if (id === undefined) Object.defineProperty(data, section, { value: unit.value, writable: true, enumerable: true, configurable: true });
    else data[section] = { ...object(data[section]), [id]: unit.value };
  }
  return data;
}

export function filesFromUnits(units: Units): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const config = sections(units, 'config');
  if (Object.keys(config).length) files.set('config.toml', encodeToml(config));
  for (const platform of platforms) {
    const filename = `config.${platform}.toml`;
    const selected: Units = new Map();
    for (const [id, unit] of units) if (unit.domain === 'config' && unit.key[0] === filename) selected.set(id, { ...unit, key: unit.key.slice(1) });
    if (selected.size) files.set(filename, encodeToml(sections(selected, 'config')));
  }
  const mcp = sections(units, 'mcp');
  if (Object.keys(mcp).length) files.set('mcp.json', Buffer.from(`${JSON.stringify({ mcpServers: mcp }, null, 2)}\n`));
  const credentials = sections(units, 'credentials');
  if (Object.keys(credentials).length) files.set(PLAIN, encodeToml(credentials));
  const extensions: Data = {};
  for (const [section, domain] of [['skill_repos', 'skills'], ['plugins', 'plugins']] as const) {
    const values = Object.values(object(sections(units, domain)[section]));
    if (values.length) extensions[section] = values;
  }
  if (Object.keys(extensions).length) files.set('extensions.toml', encodeToml(extensions));
  const installations = sections(units, 'recipes')['installation'] as Record<string, PortableRecipeInstallation> | undefined;
  if (installations) files.set(RECIPE_INSTALLATIONS, installBytes(installations));
  for (const unit of units.values()) if (Buffer.isBuffer(unit.value)) files.set(unit.path, unit.value);
  return files;
}

export function commonUnits(units: Units): Units {
  return new Map([...units].filter(([, unit]) => unit.domain !== 'config' || !unit.key[0]?.startsWith('config.')));
}

export function platformUnits(units: Units, platform: string): Units {
  const result = commonUnits(units);
  for (const unit of units.values()) if (unit.domain === 'config' && unit.key[0] === `config.${platform}.toml`) {
    const key = unit.key.slice(1);
    const existing = [...result.values()].find((old) => old.domain === 'config' && isDeepStrictEqual(old.key, key))?.value;
    const value = existing && typeof existing === 'object' && unit.value && typeof unit.value === 'object' && !Array.isArray(existing) && !Array.isArray(unit.value)
      ? mergeConfigCredentials(object(existing), object(unit.value)) : unit.value;
    putUnit(result, 'config', key, value);
  }
  return result;
}

export function matches(unit: SpaceUnit, id: string, selector: string): boolean {
  return id === selector || unit.path === selector || unit.path.startsWith(`${selector}.`) || unit.path.startsWith(`${selector}/`)
    || (unit.domain === 'credentials' && `${unit.key.join('.')}`.startsWith(`${selector}.`));
}

export function selectedUnits(units: Units, domains?: readonly PortableSpaceDomain[], pick?: readonly string[]): Units {
  return new Map([...units].filter(([id, unit]) => (domains === undefined || domains.includes(unit.domain)) && (pick === undefined || pick.some((selector) => matches(unit, id, selector)))));
}
