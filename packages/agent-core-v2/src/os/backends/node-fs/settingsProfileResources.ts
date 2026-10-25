import { parse as parseToml } from 'smol-toml';
import {
  isAbsolute,
  join,
  normalize,
  relative,
} from 'pathe';
import { parseAgentFileText } from '@kiki/agent-profiles/agentFile';
import { parseAgentRouteFileText } from '@kiki/agent-profiles/agentRouteFile';
import {
  parsePromptOverrideDocument,
  validatePromptOverridePath,
} from '@kiki/agent-profiles/promptOverrides';
import { parseSystemMdProfile } from '@kiki/agent-profiles/systemFile';

import { atomicWrite } from '#/_base/utils/fs';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { IBuiltinAgentProfileLoader } from '#/app/agentProfileCatalog/builtinAgentProfileLoader';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { LifecycleScope } from '#/app/scopes';
import { IHostFileSystem, type HostDirEntry } from '#/os/interface/hostFileSystem';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';
import {
  ISettingsProfileResources,
  SettingsProfileResourceError,
  type SettingsProfileResource,
} from '#/app/settingsTransfer/profileResources';

const MAX_RESOURCE_KEY_LENGTH = 512;
const MAX_PROFILE_BYTES = 1_048_576;
const MAX_PROMPT_OVERRIDE_BYTES = 1_048_576;
const PROTECTED_PROMPT_PATH_SEGMENTS = new Set([
  'auth',
  'cache',
  'config',
  'credentials',
  'keychain',
  'logs',
  'mcp',
  'plugins',
  'search-index',
  'secrets',
  'server',
  'sessions',
  'store',
  'tools',
  'tokens',
]);
const PROTECTED_PROMPT_FILE_NAMES = new Set(['config.toml', 'home.toml']);

type ResourceKind = 'profile' | 'route' | 'system' | 'prompt';

type ResourceLocation = {
  readonly key: string;
  readonly kind: ResourceKind;
  readonly rootPath: string;
};

export class SettingsProfileResources implements ISettingsProfileResources {
  declare readonly _serviceBrand: undefined;

  private readonly pathClass: 'posix' | 'win32';

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IBuiltinAgentProfileLoader private readonly builtin: IBuiltinAgentProfileLoader,
  ) {
    this.pathClass = bootstrap.platform === 'win32' ? 'win32' : 'posix';
  }

  async list(): Promise<readonly SettingsProfileResource[]> {
    const keys = await this.listProfileKeys();
    const resources: SettingsProfileResource[] = [];
    const promptRefs = new Set<string>();
    for (const key of keys) {
      let text: string | undefined;
      try {
        text = await this.read(key);
      } catch (error) {
        if (error instanceof SettingsProfileResourceError) continue;
        throw error;
      }
      if (text === undefined || !this.isValid({ key, text })) continue;
      resources.push({ key, text });
      this.collectPromptOverrideRefs(key, text, promptRefs);
    }
    for (const key of promptRefs) {
      let text: string | undefined;
      try {
        text = await this.read(key);
      } catch {
        throw referencedPromptOverrideError();
      }
      if (text === undefined || !this.isValid({ key, text })) throw referencedPromptOverrideError();
      resources.push({ key, text });
    }
    return resources.toSorted((left, right) => compareResourceKeys(left.key, right.key));
  }

  private isValid(resource: SettingsProfileResource): boolean {
    try {
      this.validate(resource);
      return true;
    } catch {
      return false;
    }
  }

  validate(resource: SettingsProfileResource): void {
    if (resource === null || typeof resource !== 'object') {
      throw invalidResource('resource must be an object');
    }
    if (typeof resource.key !== 'string') {
      throw invalidResource('resource key must be a string');
    }
    if (typeof resource.text !== 'string') {
      throw invalidResource('resource text must be a string');
    }
    const location = this.location(resource.key);
    this.assertTextSize(location.kind, resource.text);
    if (location.kind === 'prompt') {
      let parsed: unknown;
      try {
        parsed = parseToml(resource.text);
      } catch (error) {
        throw invalidResource(`invalid prompt override TOML at ${location.key}`, error);
      }
      try {
        parsePromptOverrideDocument(parsed, { path: location.key, text: resource.text });
      } catch (error) {
        throw invalidResource(`invalid prompt override document at ${location.key}`, error);
      }
      return;
    }
    if (location.kind === 'system') {
      parseSystemMdProfile(
        resource.text,
        location.key,
        this.builtin.getDefault(),
        () => {},
      );
      return;
    }
    if (location.kind === 'route') {
      const parts = location.key.split('/');
      if (parts.length !== 4) {
        throw invalidResource(`route resource key must be agents/.routes/<profile>/<route>.md: ${location.key}`);
      }
      const profile = parts[2];
      const routeFile = parts[3];
      if (profile === undefined || routeFile === undefined || !routeFile.endsWith('.md')) {
        throw invalidResource(`invalid route resource key: ${location.key}`);
      }
      parseAgentRouteFileText({
        path: location.key,
        expectedProfile: profile,
        expectedRouteName: routeFile.slice(0, -3),
        text: resource.text,
      });
      return;
    }
    parseAgentFileText({
      path: location.key,
      source: 'user',
      text: resource.text,
    });
  }

  references(resource: SettingsProfileResource): readonly string[] {
    const location = this.location(resource.key);
    if (location.kind === 'prompt' || location.kind === 'route') return [];
    this.validate(resource);
    const refs = new Set<string>();
    this.collectPromptOverrideRefs(location.key, resource.text, refs);
    return [...refs].toSorted(compareResourceKeys);
  }

  async read(key: string): Promise<string | undefined> {
    const location = this.location(key);
    const root = await this.canonicalRoot(location.rootPath, false);
    if (root === undefined) return undefined;
    const filePath = await this.resolveExistingPath(root, location.key);
    if (filePath === undefined) return undefined;
    const text = await this.fs.readText(filePath);
    this.assertTextSize(location.kind, text);
    return text;
  }

  async write(resource: SettingsProfileResource): Promise<void> {
    this.validate(resource);
    const location = this.location(resource.key);
    const root = await this.canonicalRoot(location.rootPath, true);
    if (root === undefined) throw invalidResource(`resource root is unavailable: ${location.rootPath}`);
    const filePath = await this.prepareWritePath(root, location.key);
    await atomicWrite(filePath, resource.text);
  }

  async delete(key: string): Promise<void> {
    const location = this.location(key);
    const root = await this.canonicalRoot(location.rootPath, false);
    if (root === undefined) return;
    const filePath = await this.resolveExistingPath(root, location.key);
    if (filePath === undefined) return;
    await this.fs.remove(filePath);
  }

  private async listProfileKeys(): Promise<readonly string[]> {
    const root = await this.canonicalRoot(this.bootstrap.userAgentProfileHomeDir, false);
    if (root === undefined) return [];
    const keys: string[] = [];
    await this.walkProfileDirectory(root, join(root, 'agents'), ['agents'], keys);
    if (await this.resolveExistingPath(root, 'SYSTEM.md') !== undefined) keys.push('SYSTEM.md');
    return keys.toSorted();
  }

  private async walkProfileDirectory(
    root: string,
    directory: string,
    segments: readonly string[],
    keys: string[],
  ): Promise<void> {
    const directoryPath = await this.checkDirectory(root, directory);
    if (directoryPath === undefined) return;
    let entries: readonly HostDirEntry[];
    try {
      entries = (await this.fs.readdir(directoryPath)).toSorted((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink === true) continue;
      const childSegments = [...segments, entry.name];
      const childPath = join(directoryPath, entry.name);
      if (entry.isDirectory) {
        if (segments.length === 1 && entry.name === '.routes') {
          await this.listRouteDirectory(root, childPath, childSegments, keys);
          continue;
        }
        if (entry.name === 'builtin' && segments.length === 1) continue;
        if (entry.name === 'node_modules' || entry.name.toLowerCase() === '_private') continue;
        if (entry.name.startsWith('.')) continue;
        await this.walkProfileDirectory(root, childPath, childSegments, keys);
        continue;
      }
      if (entry.isFile && entry.name.endsWith('.md')) keys.push(childSegments.join('/'));
    }
  }

  private async listRouteDirectory(
    root: string,
    routesDirectory: string,
    segments: readonly string[],
    keys: string[],
  ): Promise<void> {
    const directoryPath = await this.checkDirectory(root, routesDirectory);
    if (directoryPath === undefined) return;
    let profiles: readonly HostDirEntry[];
    try {
      profiles = (await this.fs.readdir(directoryPath)).toSorted((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const profile of profiles) {
      if (profile.isSymbolicLink === true || !profile.isDirectory) continue;
      const profilePath = join(directoryPath, profile.name);
      const profileSegments = [...segments, profile.name];
      const profileDirectory = await this.checkDirectory(root, profilePath);
      if (profileDirectory === undefined) continue;
      let routes: readonly HostDirEntry[];
      try {
        routes = (await this.fs.readdir(profileDirectory)).toSorted((left, right) => left.name.localeCompare(right.name));
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      for (const route of routes) {
        if (route.isSymbolicLink === true) continue;
        if (route.isFile && route.name.endsWith('.md')) keys.push([...profileSegments, route.name].join('/'));
      }
    }
  }

  private collectPromptOverrideRefs(key: string, text: string, refs: Set<string>): void {
    if (key !== 'SYSTEM.md' && !key.startsWith('agents/') || key.includes('/.routes/')) return;
    let parsed: unknown;
    try {
      parsed = key === 'SYSTEM.md'
        ? parseSystemMdProfile(text, key, this.builtin.getDefault(), () => {})
        : parseAgentFileText({ path: key, source: 'user', text });
    } catch {
      return;
    }
    collectPromptOverrideRefs(parsed, refs);
  }

  private location(key: string): ResourceLocation {
    const normalizedKey = normalizeResourceKey(key);
    if (normalizedKey === 'SYSTEM.md') {
      return {
        key: normalizedKey,
        kind: 'system',
        rootPath: this.bootstrap.userAgentProfileHomeDir,
      };
    }
    if (normalizedKey.startsWith('agents/') && normalizedKey.endsWith('.md')) {
      const parts = normalizedKey.split('/');
      if (parts[1]?.toLowerCase() === 'builtin') {
        throw invalidResource('managed builtin agent resources are not transferable');
      }
      return {
        key: normalizedKey,
        kind: parts[1] === '.routes' ? 'route' : 'profile',
        rootPath: this.bootstrap.userAgentProfileHomeDir,
      };
    }
    if (normalizedKey.toLowerCase().endsWith('.toml')) {
      assertPromptOverrideKeyAllowed(normalizedKey);
      return {
        key: normalizedKey,
        kind: 'prompt',
        rootPath: this.bootstrap.homeDir,
      };
    }
    throw invalidResource(`unsupported settings profile resource key: ${normalizedKey}`);
  }

  private async canonicalRoot(rootPath: string, create: boolean): Promise<string | undefined> {
    try {
      const root = await this.fs.realpath(rootPath);
      return await this.requireDirectory(root);
    } catch (error) {
      if (!create && isMissing(error)) return undefined;
      if (!create || !isMissing(error)) throw error;
      await this.fs.mkdir(rootPath, { recursive: true });
      const root = await this.fs.realpath(rootPath);
      return this.requireDirectory(root);
    }
  }

  private async requireDirectory(path: string): Promise<string> {
    const stat = await this.fs.lstat(path);
    if (!stat.isDirectory || stat.isSymbolicLink === true) {
      throw invalidResource(`resource root is not a real directory: ${path}`);
    }
    return normalize(path);
  }

  private async checkDirectory(root: string, directory: string): Promise<string | undefined> {
    let stat;
    try {
      stat = await this.fs.lstat(directory);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (stat.isSymbolicLink === true) return undefined;
    if (!stat.isDirectory) throw invalidResource(`resource directory is not a directory: ${directory}`);
    const real = normalize(await this.fs.realpath(directory));
    if (!this.isWithin(root, real)) throw invalidResource(`resource directory escapes its root: ${directory}`);
    return real;
  }

  private async resolveExistingPath(root: string, key: string): Promise<string | undefined> {
    const parts = key.split('/');
    let current = root;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      let stat;
      try {
        stat = await this.fs.lstat(current);
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
      if (stat.isSymbolicLink === true) throw invalidResource(`resource path contains a symbolic link: ${key}`);
      if (index < parts.length - 1 && !stat.isDirectory) {
        throw invalidResource(`resource path component is not a directory: ${key}`);
      }
      if (index === parts.length - 1 && !stat.isFile) return undefined;
      const real = normalize(await this.fs.realpath(current));
      if (!this.isWithin(root, real)) throw invalidResource(`resource path escapes its root: ${key}`);
    }
    return current;
  }

  private async prepareWritePath(root: string, key: string): Promise<string> {
    const parts = key.split('/');
    const parentParts = parts.slice(0, -1);
    let current = root;
    for (const part of parentParts) {
      current = join(current, part);
      let stat;
      try {
        stat = await this.fs.lstat(current);
      } catch (error) {
        if (!isMissing(error)) throw error;
        await this.fs.mkdir(current);
        stat = await this.fs.lstat(current);
      }
      if (stat.isSymbolicLink === true) throw invalidResource(`resource path contains a symbolic link: ${key}`);
      if (!stat.isDirectory) throw invalidResource(`resource path component is not a directory: ${key}`);
      const real = normalize(await this.fs.realpath(current));
      if (!this.isWithin(root, real)) throw invalidResource(`resource path escapes its root: ${key}`);
      current = real;
    }
    const target = join(current, parts.at(-1)!);
    try {
      const stat = await this.fs.lstat(target);
      if (stat.isSymbolicLink === true) throw invalidResource(`resource path is a symbolic link: ${key}`);
      if (stat.isDirectory) throw invalidResource(`resource path is a directory: ${key}`);
      const real = normalize(await this.fs.realpath(target));
      if (!this.isWithin(root, real)) throw invalidResource(`resource path escapes its root: ${key}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return target;
  }

  private assertTextSize(kind: ResourceKind, text: string): void {
    const limit = kind === 'prompt' ? MAX_PROMPT_OVERRIDE_BYTES : MAX_PROFILE_BYTES;
    if (Buffer.byteLength(text, 'utf8') > limit) {
      throw invalidResource(`resource exceeds the ${limit}-byte size limit`);
    }
  }

  private isWithin(root: string, candidate: string): boolean {
    const rootValue = this.pathClass === 'win32' ? normalize(root).toLowerCase() : normalize(root);
    const candidateValue = this.pathClass === 'win32' ? normalize(candidate).toLowerCase() : normalize(candidate);
    const rel = normalize(relative(rootValue, candidateValue)).replaceAll('\\', '/');
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
  }
}

function normalizeResourceKey(key: string): string {
  if (typeof key !== 'string') throw invalidResource('resource key must be a string');
  if (key.includes('\\')) throw invalidResource('resource key must be a relative path using forward slashes');
  const normalizedSeparators = key;
  if (
    normalizedSeparators.length === 0
    || normalizedSeparators.includes('\u0000')
    || isAbsolute(normalizedSeparators)
    || /^[A-Za-z]:[\\/]/.test(key)
    || normalizedSeparators.startsWith('//')
  ) {
    throw invalidResource('resource key must be a relative path');
  }
  const parts = normalizedSeparators.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw invalidResource('resource key must not contain traversal or empty path components');
  }
  if (parts.some((part) => /[<>:"|?*\u0000-\u001F]/u.test(part) || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
    throw invalidResource('resource key must use portable path components');
  }
  const normalized = normalize(normalizedSeparators).replaceAll('\\', '/');
  if (normalized !== normalizedSeparators) throw invalidResource('resource key must be normalized');
  if (normalized.length > MAX_RESOURCE_KEY_LENGTH) throw invalidResource('resource key exceeds the size limit');
  return normalized;
}

function assertPromptOverrideKeyAllowed(key: string): void {
  const parts = key.split('/');
  if (parts.some((part) => {
    const normalized = part.toLowerCase();
    return PROTECTED_PROMPT_PATH_SEGMENTS.has(normalized) || PROTECTED_PROMPT_FILE_NAMES.has(normalized);
  })) {
    throw invalidResource(`prompt override path is not transferable: ${key}`);
  }
  if (parts[0]?.toLowerCase() === 'agents' && parts[1]?.toLowerCase() === 'builtin') {
    throw invalidResource(`prompt override path is not transferable: ${key}`);
  }
}

function collectPromptOverrideRefs(value: unknown, refs: Set<string>, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectPromptOverrideRefs(item, refs, seen);
    return;
  }
  const record = value as Record<string, unknown>;
  const overrides = record['promptOverrides'];
  if (overrides !== null && typeof overrides === 'object' && !Array.isArray(overrides)) {
    const content = overrides as Record<string, unknown>;
    for (const branch of [content, content['main'], content['independent']]) {
      if (branch === null || typeof branch !== 'object' || Array.isArray(branch)) continue;
      const files = (branch as Record<string, unknown>)['files'];
      if (!Array.isArray(files)) continue;
      for (const file of files) {
        if (typeof file === 'string') refs.add(validatePromptOverridePath(file));
      }
    }
  }
  for (const nested of Object.values(record)) collectPromptOverrideRefs(nested, refs, seen);
}

function referencedPromptOverrideError(): SettingsProfileResourceError {
  return new SettingsProfileResourceError('referenced prompt override is unavailable, invalid, or not transferable');
}

function compareResourceKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidResource(message: string, cause?: unknown): SettingsProfileResourceError {
  const error = new SettingsProfileResourceError(message);
  if (cause !== undefined) error.cause = cause;
  return error;
}

function isMissing(error: unknown): boolean {
  if (error instanceof HostFsError) return error.code === OsFsErrors.codes.OS_FS_NOT_FOUND;
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === 'ENOENT' || code === OsFsErrors.codes.OS_FS_NOT_FOUND;
}

registerScopedService(
  LifecycleScope.App,
  ISettingsProfileResources,
  SettingsProfileResources,
  ScopeActivation.OnDemand,
  'settingsTransfer',
);
