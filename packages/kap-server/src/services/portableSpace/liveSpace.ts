import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { ConfigTarget, isSkillSyncExcluded, openPinnedLogicalRead, planSkillSync, readPinnedRange, type IBootstrapService, type IConfigRegistry, type IConfigService, type IFileSystemStorageService, type IMemoryScopes, type IMemoryStore, type ISessionIndex, type ISessionManager } from '@kiki/agent-core-v2';
import { IMcpConfigStore } from '@kiki/agent-core-v2/app/mcpConfig/configStore';
import { applySectionToToml, snakeToCamel, transformTomlData } from '@kiki/agent-core-v2/app/config/toml';
import { mergeConfigCredentials } from '@kiki/agent-core-v2/app/config/credentials';
import { extractMachineLocalConfigLayer, mergePortableNotifications } from '@kiki/agent-core-v2/app/config/configLayers';
import { nbSearchManagedCredentialsSchema } from '@kiki/agent-core-v2/app/nbSearch/managedCredentials';
import { parseSkillText } from '@kiki/agent-core-v2/app/skillCatalog/parser';
import { parseMemoryMarkdown, serializeMemoryMarkdown } from '@kiki/agent-core-v2/app/memory/memoryMarkdown';
import { MEMORY_PERSONA_ID_PATTERN, MEMORY_WORKSPACE_ID_PATTERN, type MemoryScope } from '@kiki/agent-core-v2/app/memory/memoryScopes';
import type { IPluginService } from '@kiki/agent-core-v2/app/plugin/plugin';
import type { IAppendLogStore } from '@kiki/agent-core-v2/persistence/interface/appendLogStore';
import type { IMemoryPersistence } from '@kiki/agent-core-v2/persistence/interface/memoryPersistence';
import { McpServerConfigSchema } from '@kiki/agent-core-v2/mcpCore/config-schema';
import type { PortableSpaceOperationMode, PortableSpaceSessionSelection } from '@kiki/protocol';
import { checkedPath, git, gitRemote, MAX_SPACE_BYTES, missing, readBounded, writeFileAtomic } from './spaceFiles';
import { configProjection, encodeToml, filesFromUnits, mcpProjection, object, parseToml, sections, type Data, type Units } from './treeProjection';
import { hydrateRecipeInstallation, installBytes, readRecipeInstallations, RECIPE_INSTALLATIONS } from './recipeStore';
import { GUI_CREDENTIALS, readGuiCredentials, readHomeFiles } from './homeFiles';
import { writePrivateFile } from '../auth/privateFiles';
import { sameUnit } from './mergeEngine';
import { safePortablePath } from './tarArchive';

export interface SessionLiveServices {
  bootstrap: Pick<IBootstrapService, 'sessionsDir' | 'scope'>;
  sessions: Pick<ISessionManager, 'get' | 'isEphemeral'>;
  index: Pick<ISessionIndex, 'status' | 'prepare' | 'get' | 'listRecent' | 'reconcileNow'>;
  logs: Pick<IAppendLogStore, 'flush'>;
  storage?: IFileSystemStorageService;
}

export interface SessionImportRemap {
  workspaceId?: string;
  workDir?: string;
}

export interface LiveServices extends SessionLiveServices {
  bootstrap: IBootstrapService;
  config: IConfigService;
  registry: IConfigRegistry;
  mcp: IMcpConfigStore;
  memory: IMemoryStore;
  memoryPersistence: IMemoryPersistence;
  scopes: IMemoryScopes;
  plugins: IPluginService;
  sessions: ISessionManager;
  index: ISessionIndex;
  logs: IAppendLogStore;
}

function scopePath(scope: MemoryScope): string {
  switch (scope.kind) {
    case 'global': return 'global';
    case 'persona': return `persona/${scope.personaId}`;
    case 'workspace': return `workspace/${scope.workspaceId}`;
    case 'persona_workspace': return `persona_workspace/${scope.personaId}__${scope.workspaceId}`;
  }
}

async function dirs(path: string): Promise<string[]> {
  return ((await missing(readdir(path, { withFileTypes: true }))) ?? []).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

export async function discoverMemoryScopes(
  home: string,
  scopes?: Pick<IMemoryScopes, 'listWorkspaceIds' | 'listProjectBindings'>,
  persistence?: Pick<IMemoryPersistence, 'namespaces'>,
): Promise<MemoryScope[]> {
  const root = join(home, 'memory');
  const result: MemoryScope[] = [{ kind: 'global' }];
  for (const personaId of await dirs(join(root, 'global', 'personas'))) if (MEMORY_PERSONA_ID_PATTERN.test(personaId)) result.push({ kind: 'persona', personaId });
  const bindings = (await scopes?.listProjectBindings?.()) ?? [];
  const workspaceIds = new Set([
    ...await dirs(join(root, 'workspaces')),
    ...await scopes?.listWorkspaceIds?.() ?? [],
    ...bindings.map((binding) => binding.projectId),
  ]);
  for (const workspaceId of workspaceIds) {
    if (!MEMORY_WORKSPACE_ID_PATTERN.test(workspaceId)) continue;
    result.push({ kind: 'workspace', workspaceId });
    for (const personaId of await dirs(join(root, 'workspaces', workspaceId, 'personas'))) if (MEMORY_PERSONA_ID_PATTERN.test(personaId)) result.push({ kind: 'persona_workspace', workspaceId, personaId });
  }
  const collected = new Map(result.map((scope) => [scopePath(scope), scope]));
  for (const namespace of (await persistence?.namespaces()) ?? []) {
    const [, kindRoot, id, label, personaId] = namespace.replaceAll('\\', '/').split('/');
    const scope = kindRoot === 'global' && id === 'personas' && label && MEMORY_PERSONA_ID_PATTERN.test(label) ? { kind: 'persona', personaId: label } as const
      : kindRoot === 'workspaces' && id && MEMORY_WORKSPACE_ID_PATTERN.test(id)
        ? label === 'personas' && personaId && MEMORY_PERSONA_ID_PATTERN.test(personaId) ? { kind: 'persona_workspace', workspaceId: id, personaId } as const : { kind: 'workspace', workspaceId: id } as const
        : undefined;
    if (scope) collected.set(scopePath(scope), scope);
  }
  return [...collected.values()];
}

export async function refreshSessionIndex(
  index?: Pick<ISessionIndex, 'status' | 'prepare' | 'reconcileNow'>,
): Promise<void> {
  if (index === undefined) return;
  const state = index.status().state;
  if (state === 'uninitialized' || state === 'preparing') await index.prepare();
  await index.reconcileNow?.();
}

async function readSessionWire(
  live: SessionLiveServices,
  scope: string,
  filePath: string,
  limit: number,
): Promise<Buffer | undefined> {
  const info = await missing(lstat(filePath));
  if (info !== undefined && (info.isSymbolicLink() || !info.isFile())) return undefined;
  if (live.storage !== undefined) {
    const pinned = await openPinnedLogicalRead(live.storage, scope, 'wire.jsonl');
    try {
      if (pinned.size !== undefined) {
        if (pinned.size > limit) throw new Error('Portable Space file exceeds its limit: wire.jsonl');
        if (pinned.size === 0) return Buffer.alloc(0);
        const bytes = await readPinnedRange(pinned, 0, pinned.size);
        return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      }
    } finally {
      pinned.close();
    }
  }
  if (info === undefined) return undefined;
  return missing(readBounded(filePath, limit));
}

async function collectSessionSubtree(
  dir: string,
  prefix: string,
  files: Map<string, Buffer>,
  budget: { remaining: number },
): Promise<void> {
  const dirInfo = await missing(lstat(dir));
  if (!dirInfo || dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) return;
  const entries = (await missing(readdir(dir, { withFileTypes: true }))) ?? [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    const key = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await collectSessionSubtree(full, key, files, budget);
      continue;
    }
    if (!entry.isFile()) continue;
    const bytes = await missing(readBounded(full, Math.min(MAX_SPACE_BYTES, Math.max(0, budget.remaining))));
    if (!bytes) continue;
    files.set(key, bytes);
    budget.remaining -= bytes.byteLength;
  }
}

export async function exportSessionFiles(
  live: SessionLiveServices,
  selection: PortableSpaceSessionSelection,
  maxBytes = MAX_SPACE_BYTES,
): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  if (selection.mode === 'none') return files;
  const sessions = selection.mode === 'recent' ? (await live.index.listRecent({ limit: selection.count })).items
    : await Promise.all(selection.sessionIds.map(async (id) => {
      const entry = await live.index.get(id);
      if (!entry) throw new Error(`Session not found: ${id}`);
      return entry;
    }));
  const budget = { remaining: maxBytes };
  for (const session of sessions) {
    if (session.private || live.sessions.isEphemeral(session.id)) continue;
    const workspaceSeg = safePortablePath(session.workspaceId);
    const sessionSeg = safePortablePath(session.id);
    if (workspaceSeg.includes('/') || sessionSeg.includes('/')) continue;
    const root = await checkedPath(live.bootstrap.sessionsDir, `${workspaceSeg}/${sessionSeg}`);
    const rootInfo = await missing(lstat(root));
    if (!rootInfo || rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) continue;
    const scope = `${live.bootstrap.scope('sessions')}/${session.workspaceId}/${session.id}`;
    for (const entry of ['state.json', 'meta.json']) {
      const metaPath = join(root, entry);
      const metaInfo = await missing(lstat(metaPath));
      if (!metaInfo || metaInfo.isSymbolicLink() || !metaInfo.isFile()) continue;
      const file = await missing(readBounded(metaPath, Math.max(0, budget.remaining)));
      if (file) {
        const bytes = Buffer.from(JSON.stringify({ ...object(JSON.parse(file.toString('utf8'))), workspaceId: session.workspaceId }));
        if (bytes.byteLength > budget.remaining) throw new Error(`Portable Space file exceeds its limit: ${entry}`);
        files.set(`sessions/${session.id}/${entry}`, bytes);
        budget.remaining -= bytes.byteLength;
      }
    }
    const agentRoot = join(root, 'agents');
    const agentRootInfo = await missing(lstat(agentRoot));
    if (agentRootInfo && !agentRootInfo.isSymbolicLink() && agentRootInfo.isDirectory()) {
      for (const id of await dirs(agentRoot)) {
        const agentDir = join(agentRoot, id);
        const agentInfo = await missing(lstat(agentDir));
        if (!agentInfo || agentInfo.isSymbolicLink() || !agentInfo.isDirectory()) continue;
        await live.logs.flush(`${scope}/agents/${id}`, 'wire.jsonl');
        const bytes = await readSessionWire(live, `${scope}/agents/${id}`, join(agentDir, 'wire.jsonl'), Math.min(MAX_SPACE_BYTES, Math.max(0, budget.remaining)));
        if (bytes) {
          files.set(`sessions/${session.id}/agents/${id}/wire.jsonl`, bytes);
          budget.remaining -= bytes.byteLength;
        }
        await collectSessionSubtree(join(agentDir, 'blobs'), `sessions/${session.id}/agents/${id}/blobs`, files, budget);
        await collectSessionSubtree(join(agentDir, 'tasks'), `sessions/${session.id}/agents/${id}/tasks`, files, budget);
      }
    }
    const wire = await readSessionWire(live, scope, join(root, 'wire.jsonl'), Math.min(MAX_SPACE_BYTES, Math.max(0, budget.remaining)));
    if (wire) {
      files.set(`sessions/${session.id}/wire.jsonl`, wire);
      budget.remaining -= wire.byteLength;
    }
    for (const folder of ['attachments', 'media', 'media-originals', 'agent-outcomes']) {
      await collectSessionSubtree(join(root, folder), `sessions/${session.id}/${folder}`, files, budget);
    }
  }
  return files;
}

function isAllowedSessionRelativePath(rel: string): boolean {
  if (rel === 'state.json' || rel === 'meta.json' || rel === 'wire.jsonl') return true;
  const parts = rel.split('/');
  if (parts[0] === 'attachments' || parts[0] === 'media' || parts[0] === 'media-originals' || parts[0] === 'agent-outcomes') {
    return parts.length >= 2;
  }
  if (parts[0] === 'agents' && parts.length >= 3) {
    if (parts.length === 3 && parts[2] === 'wire.jsonl') return true;
    if ((parts[2] === 'blobs' || parts[2] === 'tasks') && parts.length >= 4) return true;
  }
  return false;
}

export async function importSessionFiles(
  live: SessionLiveServices,
  entries: readonly { readonly sessionId: string; readonly relativePath: string; readonly contentBase64: string }[],
  remap?: SessionImportRemap,
): Promise<{ readonly sessionsApplied: number; readonly sessionsSkipped: number }> {
  const grouped = new Map<string, { readonly relativePath: string; readonly contentBase64: string }[]>();
  for (const entry of entries) {
    const list = grouped.get(entry.sessionId) ?? [];
    list.push({ relativePath: entry.relativePath, contentBase64: entry.contentBase64 });
    grouped.set(entry.sessionId, list);
  }
  let sessionsApplied = 0;
  let sessionsSkipped = 0;
  const remappedWorkspaceId = remap?.workspaceId === undefined
    ? undefined
    : (() => {
      const safe = safePortablePath(remap.workspaceId);
      return safe.includes('/') ? undefined : safe;
    })();
  for (const [sessionId, group] of grouped) {
    let safeSessionId: string;
    try {
      safeSessionId = safePortablePath(sessionId);
      if (safeSessionId.includes('/')) {
        sessionsSkipped += 1;
        continue;
      }
    } catch {
      sessionsSkipped += 1;
      continue;
    }
    if (live.sessions.get(safeSessionId) || (await live.index.get(safeSessionId)) !== undefined) {
      sessionsSkipped += 1;
      continue;
    }
    const metaEntry = group.find((entry) => entry.relativePath === 'state.json')
      ?? group.find((entry) => entry.relativePath === 'meta.json');
    if (metaEntry === undefined) {
      sessionsSkipped += 1;
      continue;
    }
    let sourceWorkspaceId: string;
    try {
      sourceWorkspaceId = sessionWorkspace(Buffer.from(metaEntry.contentBase64, 'base64'));
    } catch {
      sessionsSkipped += 1;
      continue;
    }
    const workspaceId = remappedWorkspaceId ?? sourceWorkspaceId;
    const writes: { path: string; bytes: Buffer }[] = [];
    let valid = true;
    for (const file of group) {
      let safeRel: string;
      try {
        safeRel = safePortablePath(file.relativePath);
      } catch {
        valid = false;
        break;
      }
      if (!isAllowedSessionRelativePath(safeRel)) {
        valid = false;
        break;
      }
      let bytes: Buffer = Buffer.from(file.contentBase64, 'base64');
      if (safeRel === 'state.json' || safeRel === 'meta.json') {
        try {
          const rawJson: unknown = JSON.parse(bytes.toString('utf8'));
          if (rawJson === null || typeof rawJson !== 'object' || Array.isArray(rawJson)) {
            valid = false;
            break;
          }
          const parsed = object(rawJson);
          parsed['workspaceId'] = workspaceId;
          if ('workspace_id' in parsed) parsed['workspace_id'] = workspaceId;
          if (remap?.workDir !== undefined) {
            parsed['workDir'] = remap.workDir;
            parsed['cwd'] = remap.workDir;
            if (parsed['custom'] && typeof parsed['custom'] === 'object' && !Array.isArray(parsed['custom'])) {
              const custom = object(parsed['custom']);
              if ('cwd' in custom) {
                custom['cwd'] = remap.workDir;
                parsed['custom'] = custom;
              }
            }
          }
          bytes = Buffer.from(JSON.stringify(parsed));
        } catch {
          valid = false;
          break;
        }
      }
      try {
        const destination = await checkedPath(live.bootstrap.sessionsDir, `${workspaceId}/${safeSessionId}/${safeRel}`);
        writes.push({ path: destination, bytes });
      } catch {
        valid = false;
        break;
      }
    }
    if (!valid || writes.length === 0) {
      sessionsSkipped += 1;
      continue;
    }
    const workspaceDir = await checkedPath(live.bootstrap.sessionsDir, workspaceId);
    await mkdir(workspaceDir, { recursive: true });
    const sessionDir = await checkedPath(live.bootstrap.sessionsDir, `${workspaceId}/${safeSessionId}`);
    try {
      await mkdir(sessionDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        sessionsSkipped += 1;
        continue;
      }
      throw error;
    }
    try {
      for (const item of writes) await writeFileAtomic(item.path, item.bytes);
    } catch (error) {
      await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    sessionsApplied += 1;
  }
  if (sessionsApplied > 0) await refreshSessionIndex(live.index);
  return { sessionsApplied, sessionsSkipped };
}

async function exportSessions(files: Map<string, Buffer>, live: LiveServices, selection: PortableSpaceSessionSelection): Promise<void> {
  const exported = await exportSessionFiles(live, selection);
  for (const [key, bytes] of exported) files.set(key, bytes);
}

function userConfig(live: LiveServices): Data {
  const raw: Data = {};
  for (const { domain } of live.registry.listSections()) applySectionToToml(raw, domain, live.config.inspect(domain).userValue, live.registry);
  return raw;
}

export async function readLive(live: LiveServices, sessions: PortableSpaceSessionSelection, platform?: 'win32' | 'darwin' | 'linux', includeMemory = true, includeCredentials = true): Promise<Map<string, Buffer>> {
  const home = live.bootstrap.homeDir;
  await live.config.ready;
  const files = await readHomeFiles(home, live.bootstrap.osHomeDir, includeCredentials);
  files.set('config.toml', encodeToml(userConfig(live)));
  const repositories: Data[] = [];
  const skillsRoot = join(home, 'skills');
  for (const name of (await dirs(skillsRoot)).concat([...new Set([...files.keys()].flatMap((path) => path.startsWith('skills/') && path.split('/').length > 2 ? [path.split('/')[1]!] : []))]).filter((name, index, list) => list.indexOf(name) === index)) {
    const skillPath = `skills/${name}/SKILL.md`;
    const bytes = files.get(skillPath);
    const frontmatter = bytes && parseSkillText({ text: bytes.toString('utf8'), skillMdPath: skillPath, skillDirName: name, source: 'user' }).metadata;
    const metadata = frontmatter && { ...frontmatter, os: platform === undefined ? undefined : frontmatter['os'] };
    const excluded = isSkillSyncExcluded({ name, frontmatter: metadata, targetPlatform: platform });
    const [plan] = excluded ? [] : await planSkillSync([{ path: join(skillsRoot, name), source: 'user' }]);
    if (plan?.transport === 'git' && plan.remoteUrl) repositories.push({ name, repo: plan.remoteUrl, branch: plan.branch ?? 'HEAD' });
    if (excluded || plan?.remoteUrl) for (const key of files.keys()) if (key.startsWith(`skills/${name}/`)) files.delete(key);
  }
  const plugins = (await live.plugins.listPlugins()).flatMap((item) => item.source === 'github' && item.originalSource ? [{ id: item.id, enabled: item.enabled, source: item.originalSource }] : []);
  const extensions = { ...parseToml(files.get('extensions.toml')), ...(repositories.length ? { skill_repos: repositories } : {}), ...(plugins.length ? { plugins } : {}) };
  if (Object.keys(extensions).length) files.set('extensions.toml', encodeToml(extensions));
  if (includeMemory) for (const scope of await discoverMemoryScopes(home, live.scopes, live.memoryPersistence)) {
    for (const entry of await live.memory.list(scope)) {
      if (entry.status !== 'active' || entry.applicability === 'machine-local') continue;
      files.set(`memories/${scopePath(scope)}/${entry.id}.md`, Buffer.from(serializeMemoryMarkdown(scope, entry)));
    }
  }
  await exportSessions(files, live, sessions);
  return files;
}

function memoryDocument(path: string, value: Buffer) {
  const doc = parseMemoryMarkdown(value.toString('utf8'));
  if (path !== `memories/${scopePath(doc.scope)}/${doc.id}.md` || doc.status !== 'active') throw new Error(`Invalid portable memory path or status: ${path}`);
  return doc;
}

async function syncSkills(home: string, next: Units, before: Units): Promise<string[]> {
  const synced: string[] = [];
  for (const [id, unit] of next) {
    if (unit.domain !== 'skills' || unit.key[0] !== 'skill_repos' || sameUnit(unit, before.get(id))) continue;
    const { name, repo, branch } = object(unit.value);
    if (typeof name !== 'string' || typeof repo !== 'string' || name.includes('/')) throw new Error('Invalid portable skill Git declaration');
    const path = await checkedPath(home, `skills/${name}`);
    const remote = gitRemote(repo);
    try {
      if (await missing(lstat(path))) {
        const origin = await git(path, ['remote', 'get-url', 'origin']);
        if (origin !== remote) continue;
        await git(path, ['pull', '--ff-only']);
      } else {
        await git(home, ['clone', '--depth', '1', ...(typeof branch === 'string' && branch !== 'HEAD' ? ['--branch', branch] : []), '--', remote, path]);
      }
      synced.push(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && typeof (error as { code?: unknown }).code !== 'number') throw error;
    }
  }
  return synced;
}

function sessionWorkspace(value: Buffer | undefined): string {
  const meta = value && object(JSON.parse(value.toString('utf8')));
  const key = meta && (meta['workspaceId'] ?? meta['workspace_id']);
  if (typeof key !== 'string' || key.includes('/')) throw new Error('Portable session requires persisted workspace metadata');
  return safePortablePath(key);
}

function notificationsForWrite(current: unknown, incoming: unknown, mode: PortableSpaceOperationMode): Data {
  if (mode !== 'override' && mode !== 'replace') return mergePortableNotifications(current, incoming);
  const result = mergePortableNotifications(undefined, incoming);
  return { ...result, credential_values: object(object(current)['credential_values']) };
}

export async function writeLive(live: LiveServices, next: Units, before: Units, mode: PortableSpaceOperationMode = 'merge'): Promise<string[]> {
  const home = live.bootstrap.homeDir;
  const requested = filesFromUnits(next);
  const changed = new Set([...new Set([...next.keys(), ...before.keys()])].filter((id) => !sameUnit(next.get(id), before.get(id))));
  const changes = [...changed].map((id) => (next.get(id) ?? before.get(id))!);
  const memories = changes.filter((unit) => unit.domain === 'memories').map((unit) => {
    const bytes = requested.get(unit.path);
    return { write: bytes !== undefined, doc: memoryDocument(unit.path, bytes ?? unit.value as Buffer) };
  });
  const files = new Map<string, { path: string; bytes?: Buffer }>();
  for (const unit of changes) {
    if (!Buffer.isBuffer(unit.value) || unit.domain === 'memories') continue;
    const bytes = requested.get(unit.path);
    let path = unit.path;
    let root = home;
    if (unit.domain === 'sessions') {
      const [, id, ...tail] = path.split('/');
      const meta = requested.get(`sessions/${id}/state.json`) ?? requested.get(`sessions/${id}/meta.json`) ?? filesFromUnits(before).get(`sessions/${id}/state.json`);
      path = `${sessionWorkspace(meta)}/${id}/${tail.join('/')}`;
      root = live.bootstrap.sessionsDir;
      if (id && live.sessions.get(id)) throw new Error(`Close session ${id} before replacing its data`);
    }
    const destination = await checkedPath(root, path);
    files.set(destination, { path: destination, bytes });
  }
  const credential = sections(next, 'credentials');
  const beforeCredential = sections(before, 'credentials');
  const raw = userConfig(live);
  const alongside = configProjection(raw, live.registry).credentials;
  const publicConfig = sections(next, 'config');
  const publicBefore = sections(before, 'config');
  for (const [id, provider] of Object.entries(object(publicConfig['providers']))) {
    const old = object(object(publicBefore['providers'])[id]);
    const { type, base_url } = object(provider);
    const secret = object(credential['providers'])[id];
    if (Object.keys(old).length && (old['type'] !== type || old['base_url'] !== base_url) && secret !== undefined && isDeepStrictEqual(secret, object(beforeCredential['providers'])[id])) {
      throw new Error(`Provider ${id} changed its endpoint; replace or remove its existing inline credentials explicitly`);
    }
  }
  const configDomains = new Set(changes.flatMap((unit) => unit.domain === 'config' && unit.key[0] && !unit.key[0].startsWith('config.') ? [unit.key[0]] : unit.domain === 'credentials' && unit.key[0] && !['mcp', 'nb_search_gui'].includes(unit.key[0]) ? [unit.key[0] === 'pool' ? 'credentials' : unit.key[0]] : []));
  const finalConfig = mergeConfigCredentials(extractMachineLocalConfigLayer(raw, live.registry), publicConfig);
  for (const group of ['providers', 'nb_search'] as const) {
    if (!configDomains.has(group)) continue;
    const secrets = object(credential[group]);
    if (group === 'providers') {
      for (const id of Object.keys(object(alongside[group]))) {
        const old = object(finalConfig[group]);
        const hidden = object(object(alongside[group])[id]);
        const provider = object(old[id]);
        for (const key of Object.keys(hidden)) delete provider[key];
        if (Object.hasOwn(object(publicConfig[group]), id)) old[id] = provider;
        else delete old[id];
        finalConfig[group] = old;
      }
      finalConfig[group] = mergeConfigCredentials(object(finalConfig[group]), secrets);
    } else finalConfig[group] = mergeConfigCredentials(object(publicConfig[group]), secrets);
  }
  if (!isDeepStrictEqual(credential['pool'], beforeCredential['pool'])) finalConfig['credentials'] = credential['pool'];
  const patch: Data = {};
  const expected: Data = {};
  for (const name of configDomains) {
    const current = live.config.inspect(snakeToCamel(name)).userValue;
    patch[name] = name === 'notifications'
      ? publicConfig[name] !== undefined || mode === 'override' || mode === 'replace'
        ? notificationsForWrite(current, publicConfig[name], mode) : finalConfig[name]
      : finalConfig[name];
    expected[snakeToCamel(name)] = current;
  }
  const guiCredentialChanges = changes.filter((unit) => unit.domain === 'credentials' && unit.key[0] === 'nb_search_gui');
  const guiCredentialPath = guiCredentialChanges.length > 0 ? await checkedPath(home, GUI_CREDENTIALS) : undefined;
  const installationChanges = changes.filter((unit) => unit.domain === 'recipes' && unit.key[0] === 'installation');
  const installationPath = installationChanges.length > 0 ? await checkedPath(home, RECIPE_INSTALLATIONS) : undefined;
  const mcpBefore = new Map((await live.mcp.list()).map(({ name, ...entry }) => [name, entry]));
  const mcpAfter = sections(next, 'mcp');
  const mcpSecrets = object(credential['mcp']);
  const mcpChanges = [...new Set(changes.flatMap((unit) => unit.domain === 'mcp' ? [unit.key[0]!] : unit.domain === 'credentials' && unit.key[0] === 'mcp' ? [unit.key[1]!] : []))].map((name) => {
    const server = mcpAfter[name];
    const original = mcpBefore.get(name);
    const previous = object(sections(before, 'mcp')[name]);
    const proposed = object(server);
    if (server && original && mcpSecrets[name] !== undefined && ['url', 'command', 'args'].some((key) => !isDeepStrictEqual(previous[key], proposed[key])) && isDeepStrictEqual(mcpSecrets[name], object(beforeCredential['mcp'])[name])) {
      throw new Error(`MCP server ${name} changed its command or endpoint; replace or remove its existing credentials explicitly`);
    }
    if (original && !Object.hasOwn(mcpProjection({ [name]: original }).config, name)) throw new Error(`MCP server ${name} uses machine-local configuration`);
    const local = original && 'cwd' in original && original.cwd ? { cwd: original.cwd } : {};
    return { name, exists: original !== undefined, input: server === undefined ? undefined : { ...McpServerConfigSchema.parse({ ...mergeConfigCredentials(object(server), object(mcpSecrets[name])), ...local }), name } };
  });
  const memoryChanges = await Promise.all(memories.map(async (change) => {
    const existing = await live.memory.get(change.doc.scope, change.doc.id);
    if (existing?.applicability === 'machine-local' || existing && existing.status !== 'active') throw new Error(`Memory ${change.doc.id} collides with a non-portable target entry`);
    return { ...change, existing };
  }));
  if (configDomains.size) await live.config.replaceSections(transformTomlData(patch, live.registry), ConfigTarget.User, expected);
  for (const { name, exists, input } of mcpChanges) {
    if (input === undefined) { if (exists) await live.mcp.remove(name); }
    else if (exists) await live.mcp.update(input);
    else await live.mcp.add(input);
  }
  for (const { doc, write, existing } of memoryChanges) {
    if (!write) {
      if (existing) await live.memory.delete(doc.scope, doc.id, existing.revision, 'import');
      continue;
    }
    await live.memory.put({ action: existing ? 'update' : 'create', scope: doc.scope, id: existing?.id,
      importedId: existing ? undefined : doc.id, expectedRevision: existing?.revision, type: doc.type,
      title: doc.title, body: doc.body, pinned: doc.pinned, basis: doc.basis, validity: doc.validity,
      source: { ...doc.source, writer: 'import' }, reason: 'Portable Space import',
    });
  }
  for (const { path, bytes } of files.values()) {
    if (bytes) await writeFileAtomic(path, bytes);
    else await rm(path, { force: true });
  }
  if (changes.some((unit) => unit.domain === 'sessions')) await refreshSessionIndex(live.index);
  if (installationPath) {
    const previous = await missing(readBounded(installationPath));
    const records = previous ? readRecipeInstallations(previous) : {};
    const bytes = requested.get(RECIPE_INSTALLATIONS);
    const proposed = bytes ? readRecipeInstallations(bytes) : {};
    for (const unit of installationChanges) {
      const id = unit.key[1]!;
      const entry = proposed[id];
      if (entry) records[id] = await hydrateRecipeInstallation(entry, home, records[id]?.trustedHooks);
      else delete records[id];
    }
    await writeFileAtomic(installationPath, installBytes(records));
  }
  if (guiCredentialPath) {
    const previous = await missing(readBounded(guiCredentialPath));
    const doc = previous ? readGuiCredentials(previous) : { schema_version: '1' as const, slots: {} };
    const proposed = nbSearchManagedCredentialsSchema.parse({ schema_version: '1', slots: credential['nb_search_gui'] ?? {} }).slots;
    for (const unit of guiCredentialChanges) {
      const id = unit.key[1]!;
      if (Object.hasOwn(proposed, id)) doc.slots[id] = proposed[id]!;
      else delete doc.slots[id];
    }
    const bytes = JSON.stringify(doc);
    await writePrivateFile(guiCredentialPath, bytes);
  }
  if (changes.some((unit) => unit.domain === 'plugins' || unit.domain === 'skills' && unit.key[0] === 'skill_repos')) {
    const data = requested.get('extensions.toml');
    if (data) await writeFileAtomic(join(home, 'extensions.toml'), data);
    else await rm(join(home, 'extensions.toml'), { force: true });
  }
  if (configDomains.size) await live.config.reload();
  return syncSkills(home, next, before);
}
