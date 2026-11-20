import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  syncBundleSchema,
  type EncryptedCredentialEnvelope,
  type ProjectIdentity,
  type SkillRootSyncPlan,
  type SyncBundle,
  type SyncBundleExportInput,
  type SyncBundleImportReceipt,
  type SyncCredentialMergeReceipt,
  type SyncMemoryRecord,
  type SyncPeerTransferInput,
  type SyncSkillFileEntry,
} from '@kiki/protocol';
import {
  ConfigTarget,
  CREDENTIALS_POOL_SECTION,
  extractPortableConfigLayer,
  filterMemoriesForSync,
  isSkillSyncExcluded,
  isSyncConflictArtifact,
  isValidProjectId,
  loadNativeAgeX25519Cipher,
  mergeCredentialEnvelopes,
  planSkillSync,
  projectRoots,
  resolveProjectIdentity,
  sanitizeCredentialMergeReceipt,
  sealSyncedCredentialPool,
  userRoots,
  type AgeX25519Cipher,
  type AgeX25519Keypair,
  type CredentialsPoolSection,
  type IConfigRegistry,
  type IConfigService,
  type IMemoryScopes,
  type IMemoryStore,
} from '@kiki/agent-core-v2';

import { readPrivateFile, writePrivateFile } from '../auth/privateFiles';

export interface SyncPeerTransport {
  resolvePeerRecipient(peerId: string): Promise<string | undefined>;
  pushBundle(peerId: string, bundle: SyncBundle): Promise<SyncBundleImportReceipt>;
  pullBundle(peerId: string, input: SyncBundleExportInput): Promise<SyncBundle>;
}

export interface SyncServiceOptions {
  readonly homeDir: string;
  readonly osHomeDir: string;
  readonly configService?: Pick<IConfigService, 'ready' | 'get' | 'inspect' | 'replace'>;
  readonly configRegistry?: Pick<IConfigRegistry, 'getSection' | 'listSections'>;
  readonly memoryScopes?: Pick<IMemoryScopes, 'bindWorkspace' | 'listProjectBindings'>;
  readonly memoryStore?: Pick<IMemoryStore, 'list' | 'put' | 'get'>;
  readonly peerTransport?: SyncPeerTransport;
  readonly cipher?: AgeX25519Cipher;
}

const EXCLUDED_SKILL_DIRS = new Set(['.git', 'node_modules']);
const MAX_BUNDLE_SKILL_FILES = 512;
const MAX_BUNDLE_SKILL_FILE_BYTES = 256 * 1024;

/** Coordinates device X25519 keys, per-entry credential envelopes, portable project identities, portable config/memory/skill bundles, and peer push/pull sync. */
export class SyncService {
  private readonly keyPath: string;
  private readonly cipher: AgeX25519Cipher;
  private cachedKeypair: AgeX25519Keypair | undefined;
  private keyLoadFlight: Promise<AgeX25519Keypair> | undefined;
  private mergeChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: SyncServiceOptions) {
    this.keyPath = join(options.homeDir, 'credentials', 'device-x25519.key');
    this.cipher = options.cipher ?? loadNativeAgeX25519Cipher();
  }

  peekDeviceRecipient(): string | undefined {
    return this.cachedKeypair?.recipient;
  }

  async ensureDeviceKeypair(): Promise<AgeX25519Keypair> {
    if (this.cachedKeypair !== undefined) return this.cachedKeypair;
    if (this.keyLoadFlight !== undefined) return this.keyLoadFlight;
    this.keyLoadFlight = (async () => {
      try {
        const raw = (await readPrivateFile(this.keyPath)).toString('utf8').trim();
        if (raw.startsWith('AGE-SECRET-KEY-1')) {
          const recipient = this.cipher.recipientFromIdentity(raw);
          this.cachedKeypair = { identity: raw, recipient };
          return this.cachedKeypair;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const generated = this.cipher.generateX25519Keypair();
      await writePrivateFile(this.keyPath, `${generated.identity}\n`);
      this.cachedKeypair = generated;
      return generated;
    })();
    try {
      return await this.keyLoadFlight;
    } finally {
      this.keyLoadFlight = undefined;
    }
  }

  async getDevicePublicKey(): Promise<{ readonly recipient: string }> {
    const keypair = await this.ensureDeviceKeypair();
    return { recipient: keypair.recipient };
  }

  async sealSyncedCredentials(input: {
    readonly recipients: readonly string[];
    readonly credentialIds?: readonly string[];
  }): Promise<{
    readonly envelopes: readonly EncryptedCredentialEnvelope[];
    readonly skipped: readonly { readonly credentialId: string; readonly reason: string }[];
  }> {
    const { userPool } = await this.readCredentialLayers();
    return sealSyncedCredentialPool(userPool, input.recipients, {
      credentialIds: input.credentialIds,
      cipher: this.cipher,
    });
  }

  mergeIncomingCredentials(
    envelopes: readonly EncryptedCredentialEnvelope[],
  ): Promise<SyncCredentialMergeReceipt> {
    const run = this.mergeChain.then(async () => {
      const keypair = await this.ensureDeviceKeypair();
      const { userPool, localMachineIds } = await this.readCredentialLayers();
      const result = mergeCredentialEnvelopes(
        userPool,
        envelopes,
        keypair.identity,
        this.cipher,
        localMachineIds,
      );
      if (result.applied.length > 0 && this.options.configService !== undefined) {
        await this.options.configService.ready;
        await this.options.configService.replace(CREDENTIALS_POOL_SECTION, result.merged, ConfigTarget.User);
      }
      const revision = createHash('sha256')
        .update(
          JSON.stringify(
            Object.entries(result.merged)
              .map(([id, entry]): readonly [string, string, string] => [id, entry.revision ?? '', entry.updatedAt ?? ''])
              .toSorted((left, right) => left[0].localeCompare(right[0])),
          ),
        )
        .digest('hex')
        .slice(0, 16);
      const receipt = sanitizeCredentialMergeReceipt(result, `cred:${revision}`);
      return {
        appliedIds: [...receipt.appliedIds],
        skippedIds: receipt.skippedIds.map((entry) => ({ credentialId: entry.credentialId, reason: entry.reason })),
        conflictIds: [...receipt.conflictIds],
        revision: receipt.revision,
      };
    });
    this.mergeChain = run.catch(() => undefined);
    return run;
  }

  async resolveProjectIdentity(cwd: string, bind = true): Promise<ProjectIdentity> {
    if (bind && this.options.memoryScopes?.bindWorkspace !== undefined) {
      return this.options.memoryScopes.bindWorkspace(cwd);
    }
    return resolveProjectIdentity(cwd);
  }

  async exportPortableConfig(): Promise<Record<string, unknown>> {
    if (this.options.configService === undefined) return {};
    await this.options.configService.ready;
    const rawUser: Record<string, unknown> = {};
    const domains = new Set<string>([
      'defaultModel',
      'defaultProvider',
      ...(this.options.configRegistry?.listSections().map((section) => section.domain) ?? []),
    ]);
    for (const domain of domains) {
      const value = this.options.configService.inspect(domain).userValue;
      if (value !== undefined) rawUser[domain] = value;
    }
    return extractPortableConfigLayer(rawUser, this.options.configRegistry);
  }

  async planSkillsSync(workDir?: string): Promise<readonly SkillRootSyncPlan[]> {
    const roots = [
      ...(await userRoots(this.options.homeDir, this.options.osHomeDir)),
      ...(workDir === undefined ? [] : await projectRoots(workDir)),
    ];
    return planSkillSync(roots);
  }

  async exportSyncBundle(input: SyncBundleExportInput): Promise<SyncBundle> {
    const portableConfig = input.includeConfig ? await this.exportPortableConfig() : undefined;
    let credentialEnvelopes: EncryptedCredentialEnvelope[] | undefined;
    if (input.includeCredentials && input.recipients !== undefined && input.recipients.length > 0) {
      const sealed = await this.sealSyncedCredentials({
        recipients: input.recipients,
        credentialIds: input.credentialIds,
      });
      credentialEnvelopes = [...sealed.envelopes];
    }
    const memories = input.includeMemories
      ? await this.exportPortableMemories(input.projectIds)
      : undefined;
    const skillPlans = input.includeSkills ? [...(await this.planSkillsSync(input.workDir))] : undefined;
    const skills = input.includeSkills
      ? await this.exportPortableSkills(input.workDir, input.targetPlatform)
      : undefined;

    return syncBundleSchema.parse({
      format: 'kiki.sync-bundle.v1',
      exportedAt: new Date().toISOString(),
      ...(portableConfig === undefined ? {} : { portableConfig }),
      ...(credentialEnvelopes === undefined ? {} : { credentialEnvelopes }),
      ...(memories === undefined ? {} : { memories }),
      ...(skills === undefined ? {} : { skills }),
      ...(skillPlans === undefined ? {} : { skillPlans }),
    });
  }

  async importSyncBundle(rawBundle: SyncBundle): Promise<SyncBundleImportReceipt> {
    const bundle = syncBundleSchema.parse(rawBundle);
    const configDomainsApplied: string[] = [];
    if (bundle.portableConfig !== undefined && this.options.configService !== undefined) {
      await this.options.configService.ready;
      const sanitized = extractPortableConfigLayer(bundle.portableConfig, this.options.configRegistry);
      for (const [domain, value] of Object.entries(sanitized)) {
        if (domain === CREDENTIALS_POOL_SECTION) continue;
        const existingUser = this.options.configService.inspect(domain).userValue;
        const merged = deepMergePortableConfig(existingUser, value);
        await this.options.configService.replace(domain, merged, ConfigTarget.User);
        configDomainsApplied.push(domain);
      }
    }

    const credentials = await this.mergeIncomingCredentials(bundle.credentialEnvelopes ?? []);

    let memoriesApplied = 0;
    let memoriesSkipped = 0;
    if (bundle.memories !== undefined && this.options.memoryStore !== undefined) {
      for (const item of bundle.memories) {
        if (!isValidProjectId(item.projectId)) {
          memoriesSkipped += 1;
          continue;
        }
        const scope = { kind: 'workspace' as const, workspaceId: item.projectId };
        let existing = await this.options.memoryStore.get(scope, item.id);
        if (existing === undefined) {
          const listed = await this.options.memoryStore.list(scope);
          const normalizedTitle = item.title.trim().toLowerCase();
          existing = listed.find(
            (entry) => entry.status === 'active' && entry.title.trim().toLowerCase() === normalizedTitle,
          );
        }
        if (existing !== undefined) {
          if (
            existing.applicability === 'machine-local' ||
            existing.body === item.body ||
            item.updated < existing.updated
          ) {
            memoriesSkipped += 1;
            continue;
          }
          await this.options.memoryStore.put({
            action: 'update',
            scope,
            id: existing.id,
            expectedRevision: existing.revision,
            type: item.type,
            title: item.title,
            body: item.body,
            pinned: item.pinned,
            applicability: 'portable',
            origin_host_id: item.origin_host_id,
            reason: 'Cross-machine portable memory sync',
            source: { writer: 'import' },
          });
          memoriesApplied += 1;
          continue;
        }
        try {
          await this.options.memoryStore.put({
            action: 'create',
            scope,
            type: item.type,
            title: item.title,
            body: item.body,
            pinned: item.pinned,
            applicability: 'portable',
            origin_host_id: item.origin_host_id,
            reason: 'Cross-machine portable memory sync',
            source: { writer: 'import' },
          });
          memoriesApplied += 1;
        } catch {
          memoriesSkipped += 1;
        }
      }
    }

    let skillsApplied = 0;
    let skillsSkipped = 0;
    if (bundle.skills !== undefined && bundle.skills.length > 0) {
      const targetRoot = resolve(join(this.options.homeDir, 'skills'));
      await mkdir(targetRoot, { recursive: true });
      const realTargetRoot = await realpath(targetRoot);
      const grouped = new Map<string, SyncSkillFileEntry[]>();
      for (const file of bundle.skills) {
        const list = grouped.get(file.skillName) ?? [];
        list.push(file);
        grouped.set(file.skillName, list);
      }
      for (const [skillName, group] of grouped) {
        if (
          !isSafeRelativeSkillPath(skillName) ||
          skillName.includes('/') ||
          skillName.includes('\\') ||
          isSkillSyncExcluded({ name: skillName, targetPlatform: process.platform })
        ) {
          skillsSkipped += group.length;
          continue;
        }
        const skillMdFile = group.find((entry) => entry.relativePath.replaceAll('\\', '/') === 'SKILL.md');
        if (skillMdFile !== undefined) {
          const fm = parseSkillFrontmatter(Buffer.from(skillMdFile.contentBase64, 'base64').toString('utf8'));
          if (isSkillSyncExcluded({ name: skillName, frontmatter: fm, targetPlatform: process.platform })) {
            skillsSkipped += group.length;
            continue;
          }
        }
        for (const file of group) {
          if (!isSafeRelativeSkillPath(file.relativePath) || isSecretSkillSidecar(file.relativePath)) {
            skillsSkipped += 1;
            continue;
          }
          const normalizedRel = file.relativePath.replaceAll('\\', '/');
          const dest = resolve(realTargetRoot, skillName, normalizedRel);
          const rel = relative(realTargetRoot, dest);
          if (rel.startsWith('..') || isAbsolute(rel)) {
            skillsSkipped += 1;
            continue;
          }
          if (!(await hasNoSymlinkSegments(realTargetRoot, `${skillName}/${normalizedRel}`))) {
            skillsSkipped += 1;
            continue;
          }
          const bytes = Buffer.from(file.contentBase64, 'base64');
          const destParent = dirname(dest);
          await mkdir(destParent, { recursive: true });
          const confirmedParent = await realpath(destParent);
          const parentRel = relative(realTargetRoot, confirmedParent);
          if (parentRel.startsWith('..') || isAbsolute(parentRel)) {
            skillsSkipped += 1;
            continue;
          }
          if (!(await isSafeRegularWriteTarget(dest))) {
            skillsSkipped += 1;
            continue;
          }
          await writeFile(dest, bytes);
          skillsApplied += 1;
        }
      }
    }

    return {
      configDomainsApplied: configDomainsApplied.toSorted(),
      credentials,
      memoriesApplied,
      memoriesSkipped,
      skillsApplied,
      skillsSkipped,
    };
  }

  async pushToPeer(peerId: string, input: SyncPeerTransferInput): Promise<SyncBundleImportReceipt> {
    if (this.options.peerTransport === undefined) {
      throw new Error('Peer sync transport is not configured');
    }
    const peerRecipient = await this.options.peerTransport.resolvePeerRecipient(peerId);
    const recipients = peerRecipient === undefined ? [] : [peerRecipient];
    const bundle = await this.exportSyncBundle({
      recipients,
      credentialIds: input.credentialIds,
      projectIds: input.projectIds,
      workDir: input.workDir,
      includeConfig: input.includeConfig,
      includeCredentials: input.includeCredentials && recipients.length > 0,
      includeMemories: input.includeMemories,
      includeSkills: input.includeSkills,
    });
    return this.options.peerTransport.pushBundle(peerId, bundle);
  }

  async pullFromPeer(peerId: string, input: SyncPeerTransferInput): Promise<SyncBundleImportReceipt> {
    if (this.options.peerTransport === undefined) {
      throw new Error('Peer sync transport is not configured');
    }
    const localKey = await this.ensureDeviceKeypair();
    const bundle = await this.options.peerTransport.pullBundle(peerId, {
      recipients: [localKey.recipient],
      credentialIds: input.credentialIds,
      projectIds: input.projectIds,
      workDir: input.workDir,
      includeConfig: input.includeConfig,
      includeCredentials: input.includeCredentials,
      includeMemories: input.includeMemories,
      includeSkills: input.includeSkills,
      targetPlatform: process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux',
    });
    return this.importSyncBundle(bundle);
  }

  private async exportPortableMemories(
    explicitProjectIds?: readonly string[],
  ): Promise<SyncMemoryRecord[]> {
    if (this.options.memoryStore === undefined) return [];
    const projectIds = new Set<string>();
    if (explicitProjectIds !== undefined) {
      for (const id of explicitProjectIds) {
        if (isValidProjectId(id)) projectIds.add(id);
      }
    } else if (this.options.memoryScopes?.listProjectBindings !== undefined) {
      for (const binding of await this.options.memoryScopes.listProjectBindings()) {
        if (isValidProjectId(binding.projectId)) projectIds.add(binding.projectId);
      }
    }
    const records: SyncMemoryRecord[] = [];
    for (const projectId of [...projectIds].toSorted()) {
      const listed = await this.options.memoryStore.list({ kind: 'workspace', workspaceId: projectId });
      for (const entry of filterMemoriesForSync(listed)) {
        if (entry.status !== 'active') continue;
        records.push({
          id: entry.id,
          projectId,
          type: entry.type,
          title: entry.title,
          body: entry.body,
          pinned: entry.pinned,
          updated: entry.updated,
          revision: entry.revision,
          applicability: 'portable',
          ...(entry.origin_host_id === undefined ? {} : { origin_host_id: entry.origin_host_id }),
        });
      }
    }
    return records;
  }

  private async exportPortableSkills(
    workDir?: string,
    targetPlatform?: 'win32' | 'darwin' | 'linux',
  ): Promise<SyncSkillFileEntry[]> {
    const kikiHomeSkills = resolve(join(this.options.homeDir, 'skills'));
    const candidateRoots = [
      { path: kikiHomeSkills, source: 'user' as const },
      ...(workDir === undefined ? [] : await projectRoots(workDir)),
    ];
    const plans = await planSkillSync(candidateRoots);
    const fileTreeRoots = plans.filter((plan) => plan.transport === 'file_tree');
    const files: SyncSkillFileEntry[] = [];
    const seen = new Set<string>();
    for (const root of fileTreeRoots) {
      let entries;
      try {
        entries = await readdir(root.path, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (files.length >= MAX_BUNDLE_SKILL_FILES) return files;
        if (!entry.isDirectory()) continue;
        if (EXCLUDED_SKILL_DIRS.has(entry.name)) continue;
        const skillDir = join(root.path, entry.name);
        const skillMdPath = join(skillDir, 'SKILL.md');
        let skillMdText: string;
        try {
          skillMdText = await readFile(skillMdPath, 'utf8');
        } catch {
          continue;
        }
        const fm = parseSkillFrontmatter(skillMdText);
        if (isSkillSyncExcluded({ name: entry.name, frontmatter: fm, targetPlatform })) {
          continue;
        }
        await collectSkillFiles(skillDir, entry.name, files, seen);
      }
    }
    return files;
  }

  private async readCredentialLayers(): Promise<{
    readonly userPool: CredentialsPoolSection;
    readonly localMachineIds: ReadonlySet<string>;
  }> {
    if (this.options.configService === undefined) {
      return { userPool: {}, localMachineIds: new Set() };
    }
    await this.options.configService.ready;
    const inspected = this.options.configService.inspect(CREDENTIALS_POOL_SECTION);
    const userPool = isRecord(inspected.userValue)
      ? (inspected.userValue as CredentialsPoolSection)
      : {};
    const localPool = isRecord(inspected.localValue)
      ? (inspected.localValue as CredentialsPoolSection)
      : {};
    return {
      userPool,
      localMachineIds: new Set(Object.keys(localPool)),
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMergePortableConfig(existing: unknown, incoming: unknown): unknown {
  if (!isRecord(existing) || !isRecord(incoming)) {
    return incoming;
  }
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    merged[key] = deepMergePortableConfig(existing[key], value);
  }
  return merged;
}

const SECRET_SKILL_FILE_PATTERN =
  /(?:^\.env(?:\.|$)|\.(?:pem|key|p12|pfx|jks|kdbx)$|^id_(?:rsa|ed25519|ecdsa)|(?:secret|credential|private[_-]?key|service[_-]?account))/i;

function isSecretSkillSidecar(relPath: string): boolean {
  const normalized = relPath.replaceAll('\\', '/');
  return normalized.split('/').some((seg) => SECRET_SKILL_FILE_PATTERN.test(seg));
}

function isSafeRelativeSkillPath(relPath: string): boolean {
  const normalized = relPath.replaceAll('\\', '/');
  if (normalized === '' || normalized.startsWith('/') || isAbsolute(relPath)) return false;
  return !normalized
    .split('/')
    .some((seg) => seg === '' || seg === '.' || seg === '..' || EXCLUDED_SKILL_DIRS.has(seg) || isSyncConflictArtifact(seg));
}

async function hasNoSymlinkSegments(realRoot: string, normalizedRel: string): Promise<boolean> {
  let cursor = realRoot;
  for (const segment of normalizedRel.split('/')) {
    cursor = join(cursor, segment);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return false;
    }
  }
  return true;
}

async function isSafeRegularWriteTarget(dest: string): Promise<boolean> {
  try {
    const stat = await lstat(dest);
    return !stat.isSymbolicLink() && !stat.isDirectory();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

function parseSkillFrontmatter(content: string): Record<string, unknown> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (match === null) return undefined;
  const result: Record<string, unknown> = {};
  const lines = match[1]!.split(/\r?\n/);
  let currentListKey: string | undefined;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (currentListKey !== undefined && /^\s+-\s+/.test(rawLine)) {
      const value = trimmed.replace(/^-\s+/, '').replace(/^['"]|['"]$/g, '').trim();
      const existing = result[currentListKey];
      if (Array.isArray(existing)) existing.push(value);
      continue;
    }
    currentListKey = undefined;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    const rawVal = trimmed.slice(colon + 1).trim();
    if (rawVal === '') {
      result[key] = [];
      currentListKey = key;
    } else if (rawVal === 'true') {
      result[key] = true;
    } else if (rawVal === 'false') {
      result[key] = false;
    } else if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
      result[key] = rawVal
        .slice(1, -1)
        .split(',')
        .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
        .filter((item) => item.length > 0);
    } else {
      result[key] = rawVal.replace(/^['"]|['"]$/g, '');
    }
  }
  return result;
}

async function collectSkillFiles(
  skillDir: string,
  skillName: string,
  out: SyncSkillFileEntry[],
  seen: Set<string>,
): Promise<void> {
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (EXCLUDED_SKILL_DIRS.has(entry.name) || isSyncConflictArtifact(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        if (out.length >= MAX_BUNDLE_SKILL_FILES) return;
        const rel = relative(skillDir, fullPath).replaceAll('\\', '/');
        if (isSecretSkillSidecar(rel)) continue;
        const key = `${skillName}\0${rel}`;
        if (seen.has(key)) continue;
        const bytes = await readFile(fullPath);
        if (bytes.byteLength > MAX_BUNDLE_SKILL_FILE_BYTES) continue;
        seen.add(key);
        out.push({
          skillName,
          relativePath: rel,
          contentBase64: bytes.toString('base64'),
        });
      }
    }
  };
  await walk(skillDir);
}
