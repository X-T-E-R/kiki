import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, realpath, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { HookDef } from '#/features/externalHooks/internal/types';
import { discoverFileSkills } from '#/app/skillCatalog/fileSkillDiscovery';
import type { SkillDiscoveryResult } from '#/app/skillCatalog/skillDiscovery';
import type { SkillRoot } from '#/app/skillCatalog/types';
import { BugIndicatingError, Error2, ErrorCodes, PluginErrors } from '#/errors';
import type { McpServerConfig } from '#/mcpCore/config-schema';

import { downloadZip, extractZip } from './archive';
import { loadPluginCommand } from './commands';
import { buildInstallPlan, fingerprintDirectory, type PluginInstallPlan } from './installPlan';
import { resolveGithubCommitSha, resolveGithubSource } from './github-resolver';
import { parseManifest, type ParsedManifestResult } from './manifest';
import { resolvePluginPrerequisites } from './prerequisites';
import { resolveInstallSource } from './source';
import { readInstalled, writeInstalled, type InstalledRecord } from './store';
import type { PluginAgentRoot } from './types';
import {
  normalizePluginId,
  type EnabledPluginSessionStart,
  type EnabledPluginSystemPrompt,
  type PluginCapabilityState,
  type PluginCommandDef,
  type PluginGithubMetadata,
  type PluginInfo,
  type PluginMcpServerEntry,
  type PluginMcpServerInfo,
  type PluginRecord,
  type PluginRollback,
  type PluginSource,
  type PluginSummary,
  type PluginUpdateStatus,
  type ReloadSummary,
} from './types';

export interface PluginManagerOptions {
  readonly kimiHomeDir: string;
  readonly discoverSkills?: (roots: readonly SkillRoot[]) => Promise<SkillDiscoveryResult>;
}

interface ManagedPluginCopy {
  readonly root: string;
  readonly previousRoot?: string;
}

export class PluginManager {
  private readonly kimiHomeDir: string;
  private readonly discoverSkills: (roots: readonly SkillRoot[]) => Promise<SkillDiscoveryResult>;
  private records = new Map<string, PluginRecord>();

  constructor(options: PluginManagerOptions) {
    this.kimiHomeDir = options.kimiHomeDir;
    this.discoverSkills = options.discoverSkills ?? discoverFileSkills;
  }

  async load(): Promise<void> {
    const file = await readInstalled(this.kimiHomeDir);
    const next = new Map<string, PluginRecord>();
    for (const entry of file.plugins) {
      next.set(entry.id, await this.materialize(entry));
    }
    this.records = next;
  }

  list(): readonly PluginRecord[] {
    return [...this.records.values()].toSorted((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): PluginRecord | undefined {
    return this.records.get(normalizePluginId(id));
  }

  async preview(source: string, sha256?: string): Promise<PluginInstallPlan> {
    const candidate = await preparePluginSource(source, sha256);
    try {
      const parsed = await parseManifest(candidate.root);
      assertInstallable(parsed);
      const fingerprint = await fingerprintDirectory(candidate.root);
      return buildInstallPlan(parsed.manifest!, fingerprint, this.records.get(normalizePluginId(parsed.manifest!.name))?.manifest);
    } finally {
      if (candidate.tempDir !== undefined) await rm(candidate.tempDir, { recursive: true, force: true });
    }
  }

  async install(source: string, options: { readonly sha256?: string; readonly fingerprint?: string; readonly consent?: boolean } = {}): Promise<PluginRecord> {
    const candidate = await preparePluginSource(source, options.sha256);
    let managedCopy: ManagedPluginCopy | undefined;
    let previousRollback: string | undefined;
    let rollbackRoot: string | undefined;

    try {
      const parsed = await parseManifest(candidate.root);
      try { assertInstallable(parsed); }
      catch (error) {
        const reason = error instanceof Error ? error.message.replace(/^Cannot install plugin: /, '') : String(error);
        throw new Error2(ErrorCodes.PLUGIN_LOAD_FAILED,
          `Cannot install plugin ${candidate.source === 'local-path' ? `at ${candidate.root}` : `from ${candidate.originalSource}`}: ${reason}`);
      }
      const id = normalizePluginId(parsed.manifest!.name);
      if (options.fingerprint !== undefined) {
        const actual = await fingerprintDirectory(candidate.root);
        const plan = buildInstallPlan(parsed.manifest!, actual, this.records.get(id)?.manifest);
        if (actual !== options.fingerprint) throw new Error2(ErrorCodes.VALIDATION_FAILED, 'Plugin changed since installation preview');
        if (plan.consentRequired && options.consent !== true) throw new Error2(ErrorCodes.VALIDATION_FAILED, 'Installation consent required for plugin changes');
      }
      managedCopy = await copyPluginToManagedRoot(this.kimiHomeDir, id, candidate.root);
      const normalizedRoot = managedCopy.root;
      if (options.fingerprint !== undefined && await fingerprintDirectory(normalizedRoot) !== options.fingerprint) {
        throw new Error2(ErrorCodes.VALIDATION_FAILED, 'Plugin changed while copying the installation');
      }
      const managedParsed = await parseManifest(normalizedRoot);
      assertInstallable(managedParsed);
      const existing = this.records.get(id);
      const now = new Date().toISOString();
      const record = await recordFrom({
        id,
        root: normalizedRoot,
        enabled: existing?.enabled ?? false,
        installedAt: existing?.installedAt ?? now,
        updatedAt: now,
        originalSource: candidate.originalSource,
        source: candidate.source,
        capabilities: existing?.capabilities,
        github: candidate.github,
        zipSha256: candidate.zipSha256,
        parsed: managedParsed,
        discoverSkills: this.discoverSkills,
      });
      if (existing === undefined && managedCopy.previousRoot !== undefined) {
        throw new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, `Unmanaged plugin directory already exists for ${id}`);
      }
      const next = new Map(this.records);
      if (existing !== undefined && managedCopy.previousRoot !== undefined) {
        rollbackRoot = path.join(this.kimiHomeDir, 'plugins', 'rollback', id);
        await mkdir(path.dirname(rollbackRoot), { recursive: true });
        previousRollback = `${managedCopy.previousRoot}-older`;
        try { await rename(rollbackRoot, previousRollback); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; previousRollback = undefined; }
        await rename(managedCopy.previousRoot, rollbackRoot);
        managedCopy = { root: managedCopy.root, previousRoot: rollbackRoot };
        const previous: PluginRollback = {
          version: existing.manifest?.version, source: existing.source, originalSource: existing.originalSource,
          github: existing.github, zipSha256: existing.zipSha256,
        };
        next.set(id, { ...record, rollback: previous });
      } else {
        next.set(id, record);
      }
      await this.persist(next);
      this.records = next;
      if (previousRollback !== undefined) await rm(previousRollback, { recursive: true, force: true }).catch(() => undefined);
      managedCopy = undefined;
      return next.get(id)!;
    } catch (error) {
      if (managedCopy !== undefined) {
        try {
          await rollbackManagedPluginCopy(managedCopy);
          if (previousRollback !== undefined && rollbackRoot !== undefined) await rename(previousRollback, rollbackRoot);
        } catch (rollbackError) {
          throw new Error2(
            ErrorCodes.PLUGIN_LOAD_FAILED,
            'Plugin installation failed and the previous managed copy could not be restored',
            {
              cause: new AggregateError(
                [error, rollbackError],
                'Plugin installation failed and the previous managed copy could not be restored',
                { cause: error },
              ),
            },
          );
        }
      }
      throw error;
    } finally {
      if (candidate.tempDir !== undefined) {
        await rm(candidate.tempDir, { recursive: true, force: true });
      }
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const key = normalizePluginId(id);
    const current = this.records.get(key);
    if (current === undefined) throw pluginNotFound(id);
    if (current.enabled === enabled) return;
    const next = new Map(this.records);
    next.set(key, { ...current, enabled, updatedAt: new Date().toISOString() });
    await this.persist(next);
    this.records = next;
  }

  async setMcpServerEnabled(id: string, server: string, enabled: boolean): Promise<void> {
    const key = normalizePluginId(id);
    const current = this.records.get(key);
    if (current === undefined) throw pluginNotFound(id);
    if (current.manifest?.mcpServers?.[server] === undefined) {
      throw new Error2(
        ErrorCodes.MCP_SERVER_NOT_FOUND,
        `Plugin "${id}" does not declare MCP server "${server}"`,
        { details: { id, server } },
      );
    }
    const currentMcpServers = current.capabilities?.mcpServers ?? {};
    const nextCapabilities: PluginCapabilityState = {
      ...current.capabilities,
      mcpServers: {
        ...currentMcpServers,
        [server]: { enabled },
      },
    };
    const next = new Map(this.records);
    next.set(key, {
      ...current,
      capabilities: nextCapabilities,
      updatedAt: new Date().toISOString(),
    });
    await this.persist(next);
    this.records = next;
  }

  async remove(id: string, deleteData = false): Promise<void> {
    const key = normalizePluginId(id);
    const next = new Map(this.records);
    if (!next.delete(key)) {
      throw pluginNotFound(id);
    }
    await this.persist(next);
    this.records = next;
    if (deleteData) await rm(path.join(this.kimiHomeDir, 'plugins', 'data', key), { recursive: true, force: true });
  }

  async rollback(id: string): Promise<PluginRecord> {
    const key = normalizePluginId(id);
    const current = this.records.get(key);
    if (current === undefined) throw pluginNotFound(id);
    if (current.rollback === undefined) throw new Error2(ErrorCodes.VALIDATION_FAILED, `No previous version of ${id} is available`);
    const rollbackRoot = path.join(this.kimiHomeDir, 'plugins', 'rollback', key);
    const parsed = await parseManifest(rollbackRoot);
    assertInstallable(parsed);
    if (normalizePluginId(parsed.manifest!.name) !== key) throw new Error2(ErrorCodes.VALIDATION_FAILED, 'Rollback copy has a mismatched plugin name');
    await swapPluginCopies(current.root, rollbackRoot);
    try {
      const previous = await recordFrom({
        id: key, root: current.root, enabled: current.enabled, installedAt: current.installedAt,
        updatedAt: new Date().toISOString(), originalSource: current.rollback.originalSource,
        source: current.rollback.source, capabilities: current.capabilities, github: current.rollback.github,
        zipSha256: current.rollback.zipSha256, parsed: await parseManifest(current.root),
        rollback: { version: current.manifest?.version, source: current.source, originalSource: current.originalSource,
          github: current.github, zipSha256: current.zipSha256 },
        discoverSkills: this.discoverSkills,
      });
      const next = new Map(this.records);
      next.set(key, previous);
      await this.persist(next);
      this.records = next;
      return previous;
    } catch (error) {
      await swapPluginCopies(current.root, rollbackRoot);
      throw error;
    }
  }

  async checkUpdates(): Promise<readonly PluginUpdateStatus[]> {
    const records = [...this.records.values()].filter(
      (record) => record.source === 'github' && record.github !== undefined,
    );
    const results = await Promise.all(
      records.map(async (record) => {
        try {
          return await checkGithubUpdate(record);
        } catch {
          return undefined;
        }
      }),
    );
    return results
      .filter((result): result is PluginUpdateStatus => result !== undefined)
      .toSorted((a, b) => a.id.localeCompare(b.id));
  }

  async reload(): Promise<ReloadSummary> {
    const prevIds = new Set(this.records.keys());
    const file = await readInstalled(this.kimiHomeDir);
    const next = new Map<string, PluginRecord>();
    const errors: Array<{ id: string; message: string }> = [];
    for (const entry of file.plugins) {
      try {
        next.set(entry.id, await this.materialize(entry));
      } catch (error) {
        errors.push({ id: entry.id, message: (error as Error).message });
      }
    }
    const added: string[] = [];
    for (const id of next.keys()) if (!prevIds.has(id)) added.push(id);
    const removed: string[] = [];
    for (const id of prevIds) if (!next.has(id)) removed.push(id);
    this.records = next;
    return { added, removed, errors };
  }

  enabledHooks(): readonly HookDef[] {
    const out: HookDef[] = [];
    for (const record of this.records.values()) {
      if (!record.enabled) continue;
      if (record.state !== 'ok' || record.manifest === undefined) {
        const message = record.diagnostics.find((diagnostic) => diagnostic.severity === 'error')?.message;
        throw new Error2(
          PluginErrors.codes.PLUGIN_LOAD_FAILED,
          `Failed to load hooks from plugin "${record.id}": ${message ?? 'invalid plugin state'}`,
          { details: { id: record.id } },
        );
      }
      for (const hook of record.manifest.hooks ?? []) {
        out.push({
          ...hook,
          cwd: record.root,
          env: {
            KIKI_HOME: this.kimiHomeDir,
            KIKI_PLUGIN_ROOT: record.root,
          },
        });
      }
    }
    return out;
  }

  async enabledCommands(): Promise<readonly PluginCommandDef[]> {
    const out: PluginCommandDef[] = [];
    const records = [...this.records.values()];
    for (const record of records) {
      if (!record.enabled || record.state !== 'ok' || record.manifest === undefined) continue;
      for (const entry of record.manifest.commands ?? []) {
        const def = await loadPluginCommand({
          commandPath: entry.path,
          pluginId: record.id,
          fallbackName: entry.name,
        });
        if (def !== undefined) out.push(def);
      }
      for (const command of record.manifest.kiki?.commands ?? []) {
        out.push({ pluginId: record.id, name: command.name, description: command.description,
          body: command.prompt, path: record.manifestPath ?? record.root });
      }
    }
    return out;
  }

  pluginSkillRoots(): readonly SkillRoot[] {
    const roots: SkillRoot[] = [];
    for (const record of this.records.values()) {
      if (!record.enabled || record.state !== 'ok' || record.manifest === undefined) continue;
      for (const dir of record.manifest.skills ?? []) {
        roots.push({
          path: dir,
          source: 'extra',
          plugin: { id: record.id, instructions: record.skillInstructions },
          scanMode: record.manifest.rootSkillFallback ? 'root-skill-only' : undefined,
        });
      }
    }
    return roots;
  }

  pluginAgentRoots(): readonly PluginAgentRoot[] {
    const roots: PluginAgentRoot[] = [];
    for (const record of this.records.values()) {
      if (!record.enabled || record.state !== 'ok' || record.manifest === undefined) continue;
      for (const dir of record.manifest.agents ?? []) {
        roots.push({ path: dir, source: 'plugin' });
      }
    }
    return roots;
  }

  enabledSessionStarts(): readonly EnabledPluginSessionStart[] {
    const out: EnabledPluginSessionStart[] = [];
    for (const record of this.records.values()) {
      if (!record.enabled || record.state !== 'ok') continue;
      const skill = record.manifest?.sessionStart?.skill;
      if (skill === undefined) continue;
      out.push({ pluginId: record.id, skillName: skill });
    }
    return out;
  }

  enabledSystemPrompts(): readonly EnabledPluginSystemPrompt[] {
    const out: EnabledPluginSystemPrompt[] = [];
    for (const record of this.records.values()) {
      if (!record.enabled || record.state !== 'ok') continue;
      const content = record.manifest?.systemPrompt;
      if (content === undefined) continue;
      out.push({ pluginId: record.id, content });
    }
    return out;
  }

  enabledMcpServers(): Record<string, McpServerConfig> {
    const out: Record<string, McpServerConfig> = {};
    for (const record of this.records.values()) {
      if (!record.enabled || record.state !== 'ok' || record.manifest === undefined) continue;
      for (const [name, config] of Object.entries(record.manifest.mcpServers ?? {})) {
        if (!isMcpServerEnabled(record, name, config)) continue;
        out[pluginMcpRuntimeName(record.id, name)] = withPluginMcpRuntime(
          withMcpServerEnabled(config, true),
          record.root,
          this.kimiHomeDir,
        );
      }
    }
    return out;
  }

  mcpServerEntries(): readonly PluginMcpServerEntry[] {
    const out: PluginMcpServerEntry[] = [];
    for (const record of this.records.values()) {
      if (record.state !== 'ok' || record.manifest === undefined) continue;
      for (const [name, config] of Object.entries(record.manifest.mcpServers ?? {})) {
        const enabled = record.enabled && isMcpServerEnabled(record, name, config);
        const effective = withPluginMcpRuntime(
          withMcpServerEnabled(config, enabled),
          record.root,
          this.kimiHomeDir,
        );
        out.push({
          name: pluginMcpRuntimeName(record.id, name),
          config: effective,
          pluginId: record.id,
          serverName: name,
        });
      }
    }
    return out;
  }

  summaries(): readonly PluginSummary[] {
    return this.list().map((record) => recordToSummary(record));
  }

  info(id: string): PluginInfo | undefined {
    const record = this.get(id);
    return record === undefined ? undefined : recordToInfo(record);
  }

  private async persist(records: ReadonlyMap<string, PluginRecord>): Promise<void> {
    const installed: InstalledRecord[] = [...records.values()].map((record) => ({
      id: record.id,
      root: record.root,
      source: record.source,
      enabled: record.enabled,
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
      originalSource: record.originalSource,
      capabilities: record.capabilities,
      github: record.github,
      zipSha256: record.zipSha256,
      rollback: record.rollback,
    }));
    await writeInstalled(this.kimiHomeDir, { version: 1, plugins: installed });
  }

  private async materialize(entry: InstalledRecord): Promise<PluginRecord> {
    const parsed = await parseManifest(entry.root);
    return recordFrom({
      id: entry.id,
      root: entry.root,
      enabled: entry.enabled,
      installedAt: entry.installedAt,
      updatedAt: entry.updatedAt,
      originalSource: entry.originalSource,
      capabilities: entry.capabilities,
      github: entry.github,
      zipSha256: entry.zipSha256,
      rollback: entry.rollback,
      source: entry.source,
      parsed,
      discoverSkills: this.discoverSkills,
    });
  }
}

interface PreparedPluginSource {
  readonly root: string;
  readonly tempDir?: string;
  readonly originalSource: string;
  readonly source: PluginSource;
  readonly github?: PluginGithubMetadata;
  readonly zipSha256?: string;
}

function assertInstallable(parsed: ParsedManifestResult): void {
  const failure = parsed.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
  if (parsed.manifest === undefined || failure !== undefined) {
    throw new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, `Cannot install plugin: ${failure?.message ?? 'no manifest'}`);
  }
}

async function preparePluginSource(source: string, sha256?: string): Promise<PreparedPluginSource> {
  const resolved = resolveInstallSource(source);
  if (resolved.kind === 'local-path') {
    return { root: await normalizeInstallRoot(resolved.path), originalSource: resolved.path, source: 'local-path' };
  }
  const originalSource = source.trim();
  let github: PluginGithubMetadata | undefined;
  let zipUrl = resolved.kind === 'zip-url' ? resolved.path : '';
  if (resolved.kind === 'github') {
    const resolution = await resolveGithubSource(resolved);
    const installedSha = await installedGithubSha(resolved.owner, resolved.repo, resolution.ref);
    if (installedSha === undefined || installedSha.length !== 40) {
      throw new Error2(ErrorCodes.VALIDATION_FAILED, 'GitHub plugin requires a pinned 40-character commit SHA');
    }
    github = { owner: resolved.owner, repo: resolved.repo, ref: resolution.ref, installedSha };
    zipUrl = `https://codeload.github.com/${resolved.owner}/${resolved.repo}/zip/${installedSha}`;
  } else if (sha256 === undefined || !/^[0-9a-fA-F]{64}$/.test(sha256)) {
    throw new Error2(ErrorCodes.VALIDATION_FAILED, 'ZIP plugins require a sha256 checksum');
  }
  const buffer = await downloadZip(zipUrl);
  if (resolved.kind === 'zip-url' && createHash('sha256').update(buffer).digest('hex') !== sha256!.toLowerCase()) {
    throw new Error2(ErrorCodes.VALIDATION_FAILED, 'Plugin ZIP sha256 mismatch');
  }
  const tempDir = await mkdtemp(path.join(tmpdir(), 'kimi-plugin-zip-'));
  try {
    const root = await extractZip(buffer, tempDir);
    return { root, tempDir, originalSource, source: resolved.kind, github, zipSha256: resolved.kind === 'zip-url' ? sha256?.toLowerCase() : undefined };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function installedGithubSha(
  owner: string,
  repo: string,
  ref: PluginGithubMetadata['ref'],
): Promise<string | undefined> {
  if (ref.kind === 'sha' && ref.value.length === 40) return ref.value.toLowerCase();
  return resolveGithubCommitSha(owner, repo, ref.value);
}

async function checkGithubUpdate(record: PluginRecord): Promise<PluginUpdateStatus> {
  const github = record.github;
  if (github === undefined)
    throw new BugIndicatingError(`Plugin "${record.id}" has no GitHub metadata`);
  const current = github.ref;
  const pinned = explicitGithubRef(record);

  if (pinned?.kind === 'tag' || pinned?.kind === 'sha') {
    return {
      id: record.id,
      source: 'github',
      current,
      latest: current,
      displayVersion: current.value,
      updateAvailable: false,
    };
  }

  if (pinned?.kind === 'branch') {
    const latestSha = await resolveGithubCommitSha(github.owner, github.repo, pinned.value);
    return {
      id: record.id,
      source: 'github',
      current,
      latest: current,
      displayVersion: latestSha.slice(0, 12),
      updateAvailable: github.installedSha === undefined || github.installedSha !== latestSha,
    };
  }

  const latest = await resolveGithubSource({
    kind: 'github',
    owner: github.owner,
    repo: github.repo,
  });
  let updateAvailable = current.kind !== latest.ref.kind || current.value !== latest.ref.value;
  if (!updateAvailable && (latest.ref.kind === 'branch' || latest.ref.kind === 'tag')) {
    const latestSha = await resolveGithubCommitSha(github.owner, github.repo, latest.ref.value);
    updateAvailable = github.installedSha === undefined || github.installedSha !== latestSha;
  }
  return {
    id: record.id,
    source: 'github',
    current,
    latest: latest.ref,
    displayVersion: latest.displayVersion,
    updateAvailable,
  };
}

function explicitGithubRef(record: PluginRecord): PluginGithubMetadata['ref'] | undefined {
  const fallback =
    record.github?.ref.kind === 'sha' ||
    (record.github?.ref.kind === 'branch' && record.github.ref.value !== 'HEAD')
      ? record.github.ref
      : undefined;
  if (record.originalSource === undefined) return fallback;
  try {
    const source = resolveInstallSource(record.originalSource);
    return source.kind === 'github' ? source.ref : fallback;
  } catch {
    return fallback;
  }
}

function pluginNotFound(id: string): Error2 {
  return new Error2(PluginErrors.codes.PLUGIN_NOT_FOUND, `Plugin "${id}" is not installed`, {
    details: { id },
  });
}

async function normalizeInstallRoot(rootPath: string): Promise<string> {
  const trimmed = rootPath.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `Plugin root must be an absolute path (got "${rootPath}")`,
      { details: { path: rootPath } },
    );
  }
  let resolved: string;
  try {
    resolved = await realpath(trimmed);
  } catch (error) {
    throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `Plugin root does not exist: ${trimmed}`, {
      cause: error,
      details: { path: trimmed },
    });
  }
  if (!(await stat(resolved)).isDirectory()) {
    throw new Error2(ErrorCodes.VALIDATION_FAILED, `Plugin root is not a directory: ${trimmed}`, {
      details: { path: trimmed },
    });
  }
  return resolved;
}

async function copyPluginToManagedRoot(
  kimiHomeDir: string,
  id: string,
  sourceRoot: string,
): Promise<ManagedPluginCopy> {
  const managedRoot = path.join(kimiHomeDir, 'plugins', 'managed', id);
  const managedDir = path.dirname(managedRoot);
  await mkdir(managedDir, { recursive: true });
  const stagingRoot = await mkdtemp(path.join(managedDir, `${id}-`));
  const previousRoot = `${stagingRoot}-previous`;
  let movedPreviousRoot = false;
  let published = false;
  try {
    await cp(sourceRoot, stagingRoot, { recursive: true });
    try {
      await rename(managedRoot, previousRoot);
      movedPreviousRoot = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(stagingRoot, managedRoot);
    published = true;
    return {
      root: await realpath(managedRoot),
      previousRoot: movedPreviousRoot ? previousRoot : undefined,
    };
  } catch (error) {
    await rm(published ? managedRoot : stagingRoot, { recursive: true, force: true });
    if (movedPreviousRoot) await rename(previousRoot, managedRoot);
    throw error;
  }
}

async function swapPluginCopies(current: string, rollback: string): Promise<void> {
  const staging = `${current}.swap-${randomUUID()}`;
  await rename(current, staging);
  try {
    await rename(rollback, current);
    try { await rename(staging, rollback); }
    catch (error) { await rename(current, rollback); throw error; }
  } catch (error) {
    await rename(staging, current);
    throw error;
  }
}

async function rollbackManagedPluginCopy(copy: ManagedPluginCopy): Promise<void> {
  await rm(copy.root, { recursive: true, force: true });
  if (copy.previousRoot !== undefined) {
    await rename(copy.previousRoot, copy.root);
  }
}

async function recordFrom(input: {
  id: string;
  root: string;
  enabled: boolean;
  installedAt: string;
  updatedAt?: string;
  originalSource?: string;
  capabilities?: PluginCapabilityState;
  github?: PluginGithubMetadata;
  zipSha256?: string;
  rollback?: PluginRollback;
  source?: PluginSource;
  parsed: ParsedManifestResult;
  discoverSkills: (roots: readonly SkillRoot[]) => Promise<SkillDiscoveryResult>;
}): Promise<PluginRecord> {
  const { parsed } = input;
  const hasError = parsed.diagnostics.some((d) => d.severity === 'error');
  return {
    id: input.id,
    root: input.root,
    source: input.source ?? 'local-path',
    enabled: input.enabled,
    state: hasError || parsed.manifest === undefined ? 'error' : 'ok',
    installedAt: input.installedAt,
    updatedAt: input.updatedAt,
    originalSource: input.originalSource,
    capabilities: input.capabilities,
    github: input.github,
    zipSha256: input.zipSha256,
    rollback: input.rollback,
    skillCount: await countDiscoveredPluginSkills(input.id, parsed.manifest, input.discoverSkills),
    manifest: parsed.manifest,
    manifestKind: parsed.manifestKind,
    manifestPath: parsed.manifestPath,
    shadowedManifestPath: parsed.shadowedManifestPath,
    diagnostics: parsed.diagnostics,
    skillInstructions: parsed.manifest?.skillInstructions,
  };
}

function recordToSummary(record: PluginRecord): PluginSummary {
  return {
    id: record.id,
    displayName: record.manifest?.interface?.displayName ?? record.id,
    version: record.manifest?.version,
    enabled: record.enabled,
    state: record.state,
    skillCount: record.skillCount,
    mcpServerCount: Object.keys(record.manifest?.mcpServers ?? {}).length,
    enabledMcpServerCount: pluginMcpServersInfo(record).filter((server) => server.enabled).length,
    hookCount: record.manifest?.hooks?.length ?? 0,
    commandCount: record.manifest?.commands?.length ?? 0,
    hasErrors: record.diagnostics.some((d) => d.severity === 'error'),
    source: record.source,
    originalSource: record.originalSource,
    github: record.github,
    zipSha256: record.zipSha256,
    rollback: record.rollback,
  };
}

function recordToInfo(record: PluginRecord): PluginInfo {
  return {
    ...recordToSummary(record),
    root: record.root,
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
    manifestKind: record.manifestKind,
    manifestPath: record.manifestPath,
    manifest: record.manifest,
    prerequisites: resolvePluginPrerequisites({
      id: record.id, version: record.manifest?.version,
      source: record.originalSource, declared: record.manifest?.prerequisites,
    }),
    mcpServers: pluginMcpServersInfo(record),
    shadowedManifestPath: record.shadowedManifestPath,
    diagnostics: record.diagnostics,
  };
}

function isMcpServerEnabled(record: PluginRecord, name: string, config: McpServerConfig): boolean {
  return record.capabilities?.mcpServers?.[name]?.enabled ?? config.enabled !== false;
}

function pluginMcpServersInfo(record: PluginRecord): readonly PluginMcpServerInfo[] {
  return Object.entries(record.manifest?.mcpServers ?? {})
    .map(([name, config]) => pluginMcpServerInfo(record, name, config))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

function pluginMcpServerInfo(
  record: PluginRecord,
  name: string,
  config: McpServerConfig,
): PluginMcpServerInfo {
  if (config.transport === 'http' || config.transport === 'sse') {
    return {
      name,
      runtimeName: pluginMcpRuntimeName(record.id, name),
      enabled: isMcpServerEnabled(record, name, config),
      transport: config.transport,
      url: config.url,
      headerKeys: config.headers === undefined ? undefined : Object.keys(config.headers).toSorted(),
    };
  }
  return {
    name,
    runtimeName: pluginMcpRuntimeName(record.id, name),
    enabled: isMcpServerEnabled(record, name, config),
    transport: 'stdio',
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    envKeys: config.env === undefined ? undefined : Object.keys(config.env).toSorted(),
  };
}

function pluginMcpRuntimeName(pluginId: string, serverName: string): string {
  return `plugin-${pluginId}:${serverName}`;
}

const KIMI_NODE_FALLBACK_SUBCOMMAND = '__plugin_run_node';

function withMcpServerEnabled(config: McpServerConfig, enabled: boolean): McpServerConfig {
  return { ...config, enabled };
}

function withPluginMcpRuntime(
  config: McpServerConfig,
  pluginRoot: string,
  kimiHomeDir: string,
): McpServerConfig {
  if (config.transport === 'http' || config.transport === 'sse') return config;

  const translate = (value: string): string => value.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot);
  config = {
    ...config,
    command: translate(config.command),
    args: config.args?.map(translate),
    cwd: config.cwd === undefined ? undefined : translate(config.cwd),
    env: config.env === undefined ? undefined : Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, translate(value)])),
  };
  const env = {
    ...config.env,
    KIKI_HOME: kimiHomeDir,
    KIKI_PLUGIN_ROOT: pluginRoot,
  };

  if (config.command === 'node' && isElectron()) {
    return {
      ...config,
      command: process.execPath,
      args: config.args ?? [],
      cwd: config.cwd ?? pluginRoot,
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    };
  }

  if (config.command === 'node' && isKimiNativeBinary()) {
    return {
      ...config,
      command: process.execPath,
      args: [KIMI_NODE_FALLBACK_SUBCOMMAND, ...(config.args ?? [])],
      cwd: config.cwd ?? pluginRoot,
      env,
    };
  }

  return { ...config, cwd: config.cwd ?? pluginRoot, env };
}

function isElectron(): boolean {
  return typeof process.versions['electron'] === 'string';
}

function isKimiNativeBinary(): boolean {
  return !path.basename(process.execPath).toLowerCase().startsWith('node');
}

async function countDiscoveredPluginSkills(
  pluginId: string,
  manifest: PluginRecord['manifest'],
  discoverSkills: (roots: readonly SkillRoot[]) => Promise<SkillDiscoveryResult>,
): Promise<number> {
  const dirs = manifest?.skills ?? [];
  if (dirs.length === 0) return 0;
  const roots: SkillRoot[] = dirs.map((dir) => ({
    path: dir,
    source: 'extra',
    plugin: { id: pluginId, instructions: manifest?.skillInstructions },
    scanMode: manifest?.rootSkillFallback ? 'root-skill-only' : undefined,
  }));
  const result = await discoverSkills(roots);
  return result.skills.length;
}
