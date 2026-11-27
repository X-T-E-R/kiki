import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import {
  syncBundleImportInputSchema,
  syncBundleSchema,
  type EncryptedCredentialEnvelope,
  type PortableSpaceSessionSelection,
  type ProjectIdentity,
  type SkillRootSyncPlan,
  type SyncBundle,
  type SyncBundleExportInput,
  type SyncBundleImportInput,
  type SyncBundleImportReceipt,
  type SyncCredentialMergeReceipt,
  type SyncFilesExportInput,
  type SyncFilesExportResult,
  type SyncFilesImportInput,
  type SyncFilesTransferReceipt,
  type SyncHomeAssetEntry,
  type SyncMemoryRecord,
  type SyncMemoryScopeKind,
  type SyncPeerFilesPullInput,
  type SyncPeerFilesPushInput,
  type SyncPeerTransferInput,
  type SyncSessionFileEntry,
  type SyncSkillFileEntry,
} from '@kiki/protocol';
import {
  ConfigTarget,
  CREDENTIALS_POOL_SECTION,
  extractPortableConfigLayer,
  filterMemoriesForSync,
  isSkillSyncExcluded,
  isSyncConflictArtifact,
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
  type IBootstrapService,
  type IConfigRegistry,
  type IConfigService,
  type IFileSystemStorageService,
  type IMemoryScopes,
  type IMemoryStore,
  type ISessionIndex,
  type ISessionManager,
  type IWorkspaceService,
} from '@kiki/agent-core-v2';

import { mergePortableNotifications } from '@kiki/agent-core-v2/app/config/configLayers';
import { MEMORY_PERSONA_ID_PATTERN, MEMORY_WORKSPACE_ID_PATTERN, type MemoryScope } from '@kiki/agent-core-v2/app/memory/memoryScopes';
import {
  extractPromptOverrideRefsFromAgentMarkdown,
  extractPromptOverrideRefsFromConfig,
  validatePromptOverridePath,
} from '@kiki/agent-core-v2/app/promptField/promptOverrideFile';
import type { IAppendLogStore } from '@kiki/agent-core-v2/persistence/interface/appendLogStore';
import type { IMemoryPersistence } from '@kiki/agent-core-v2/persistence/interface/memoryPersistence';
import { readPrivateFile, writePrivateFile } from '../auth/privateFiles';
import { discoverMemoryScopes, exportSessionFiles, importSessionFiles } from '../portableSpace/liveSpace';
import { safePortablePath } from '../portableSpace/tarArchive';
import { exportTransferFiles, importTransferFiles } from './fileSync';
import {
  exportSessionsTarGzStream,
  importSessionsTarGzStream,
  type SessionStreamImportFilter,
} from './sessionArchiveStream';

export interface SyncPeerTransport {
  resolvePeerRecipient(peerId: string): Promise<string | undefined>;
  pushBundle(peerId: string, bundle: SyncBundleImportInput): Promise<SyncBundleImportReceipt>;
  pullBundle(peerId: string, input: SyncBundleExportInput): Promise<SyncBundle>;
  exportPeerFiles?(peerId: string, input: SyncFilesExportInput): Promise<SyncFilesExportResult>;
  importPeerFiles?(peerId: string, input: SyncFilesImportInput): Promise<SyncFilesTransferReceipt>;
  pullSessionsStream?(peerId: string, sessions: PortableSpaceSessionSelection): Promise<Readable>;
  pushSessionsStream?(
    peerId: string,
    stream: Readable,
    options?: { readonly targetWorkDir?: string; readonly targetProjectId?: string },
  ): Promise<{ readonly sessionsApplied: number; readonly sessionsSkipped: number }>;
}

export interface SyncServiceOptions {
  readonly homeDir: string;
  readonly osHomeDir: string;
  readonly configService?: Pick<IConfigService, 'ready' | 'get' | 'inspect' | 'replace'>;
  readonly configRegistry?: Pick<IConfigRegistry, 'getSection' | 'listSections'>;
  readonly memoryScopes?: Pick<IMemoryScopes, 'bindWorkspace' | 'listProjectBindings' | 'listWorkspaceIds'>;
  readonly memoryStore?: Pick<IMemoryStore, 'list' | 'put' | 'get'>;
  readonly memoryPersistence?: Pick<IMemoryPersistence, 'namespaces'>;
  readonly bootstrap?: Pick<IBootstrapService, 'sessionsDir' | 'scope'>;
  readonly sessionManager?: Pick<ISessionManager, 'get' | 'isEphemeral'>;
  readonly sessionIndex?: Pick<ISessionIndex, 'status' | 'prepare' | 'get' | 'listRecent' | 'reconcileNow'>;
  readonly appendLogStore?: Pick<IAppendLogStore, 'flush'>;
  readonly storage?: IFileSystemStorageService;
  readonly workspaceService?: Pick<IWorkspaceService, 'createOrTouch'>;
  readonly peerTransport?: SyncPeerTransport;
  readonly cipher?: AgeX25519Cipher;
}

const EXCLUDED_SKILL_DIRS = new Set(['.git', 'node_modules']);
const ALL_MEMORY_SCOPE_KINDS: readonly SyncMemoryScopeKind[] = ['global', 'persona', 'workspace', 'persona_workspace'];
const CANONICAL_MEMORY_ID_PATTERN = /^m_[a-zA-Z0-9_]+$/;
const MAX_SYNC_BUNDLE_WIRE_BYTES = 64 * 1024 * 1024;
const MAX_SKILL_MD_PROBE_BYTES = 1024 * 1024;
const HOME_ASSET_ROOT_FILES = ['AGENTS.md', 'SYSTEM.md'] as const;
const HOME_ASSET_ROOT_DIRS = ['prompt', 'prompts', 'cognition', 'personas', 'agents', 'recipes'] as const;
const HOME_ASSET_EXCLUDED_SEGMENT =
  /^(?:\.git|\.ssh|\.gnupg|node_modules|credentials|config\.local\.toml|server\.local-owner|\.env(?:\..*)?|secrets?|\.secrets?|.*\.(?:pem|key|pfx|sqlite(?:3)?(?:-wal|-shm)?|lock))$/i;
const NOFOLLOW_FLAG = fsConstants.O_NOFOLLOW ?? 0;

/** Coordinates device X25519 keys, per-entry credential envelopes, portable project identities, portable config/memory/skill bundles, and peer push/pull sync. */
export class SyncService {
  private readonly keyPath: string;
  private resolvedCipher: AgeX25519Cipher | undefined;
  private cachedKeypair: AgeX25519Keypair | undefined;
  private keyLoadFlight: Promise<AgeX25519Keypair> | undefined;
  private mergeChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: SyncServiceOptions) {
    this.keyPath = join(options.homeDir, 'credentials', 'device-x25519.key');
    this.resolvedCipher = options.cipher;
  }

  private get cipher(): AgeX25519Cipher {
    if (this.resolvedCipher === undefined) {
      this.resolvedCipher = loadNativeAgeX25519Cipher();
    }
    return this.resolvedCipher;
  }

  peekDeviceRecipient(): string | undefined {
    return this.cachedKeypair?.recipient;
  }

  async readExistingDeviceKeypair(): Promise<AgeX25519Keypair | undefined> {
    if (this.cachedKeypair !== undefined) return this.cachedKeypair;
    try {
      const raw = (await readPrivateFile(this.keyPath)).toString('utf8').trim();
      if (raw.startsWith('AGE-SECRET-KEY-1')) {
        const recipient = await this.cipher.recipientFromIdentity(raw);
        this.cachedKeypair = { identity: raw, recipient };
        return this.cachedKeypair;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    return undefined;
  }

  async ensureDeviceKeypair(): Promise<AgeX25519Keypair> {
    if (this.cachedKeypair !== undefined) return this.cachedKeypair;
    if (this.keyLoadFlight !== undefined) return this.keyLoadFlight;
    this.keyLoadFlight = (async () => {
      try {
        const raw = (await readPrivateFile(this.keyPath)).toString('utf8').trim();
        if (raw.startsWith('AGE-SECRET-KEY-1')) {
          const recipient = await this.cipher.recipientFromIdentity(raw);
          this.cachedKeypair = { identity: raw, recipient };
          return this.cachedKeypair;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const generated = await this.cipher.generateX25519Keypair();
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
    const cipher = Object.keys(userPool).length === 0 ? this.resolvedCipher : this.cipher;
    return sealSyncedCredentialPool(userPool, input.recipients, {
      credentialIds: input.credentialIds,
      cipher,
    });
  }

  private computePoolRevision(pool: CredentialsPoolSection): string {
    const digest = createHash('sha256')
      .update(
        JSON.stringify(
          Object.entries(pool)
            .map(([id, entry]): readonly [string, string, string] => [id, entry.revision ?? '', entry.updatedAt ?? ''])
            .toSorted((left, right) => left[0].localeCompare(right[0])),
        ),
      )
      .digest('hex')
      .slice(0, 16);
    return `cred:${digest}`;
  }

  mergeIncomingCredentials(
    envelopes: readonly EncryptedCredentialEnvelope[],
  ): Promise<SyncCredentialMergeReceipt> {
    const run = this.mergeChain.then(async () => {
      const { userPool, localMachineIds } = await this.readCredentialLayers();
      if (envelopes.length === 0) {
        return {
          appliedIds: [],
          skippedIds: [],
          conflictIds: [],
          revision: this.computePoolRevision(userPool),
        };
      }
      const keypair = await this.ensureDeviceKeypair();
      const result = await mergeCredentialEnvelopes(
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
      const receipt = sanitizeCredentialMergeReceipt(result, this.computePoolRevision(result.merged));
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
      ? await this.exportPortableMemories(input.projectIds, input.memoryScopes)
      : undefined;
    const skillPlans = input.includeSkills ? [...(await this.planSkillsSync(input.workDir))] : undefined;
    const exportedAt = new Date().toISOString();
    const baseEnvelopeBytes = Buffer.byteLength(
      JSON.stringify({
        format: 'kiki.sync-bundle.v1',
        exportedAt,
        portableConfig,
        credentialEnvelopes,
        memories,
        skillPlans,
      }),
    );
    if (baseEnvelopeBytes > MAX_SYNC_BUNDLE_WIRE_BYTES) {
      throw new Error('Sync bundle exceeds the 64 MiB transfer limit');
    }
    const wireBudget = { remaining: MAX_SYNC_BUNDLE_WIRE_BYTES - baseEnvelopeBytes };
    const exportedHomeAssets = input.includeConfig && input.includeHomeAssets === true
      ? await this.exportPortableHomeAssets(wireBudget, portableConfig)
      : undefined;
    const homeAssets = exportedHomeAssets !== undefined && exportedHomeAssets.length > 0
      ? exportedHomeAssets
      : undefined;
    const skills = input.includeSkills
      ? await this.exportPortableSkills(input.workDir, input.targetPlatform, input.includeGitSkills === true, wireBudget)
      : undefined;
    const sessions = input.sessions !== undefined && input.sessions.mode !== 'none'
      ? await this.exportPortableSessions(input.sessions, wireBudget)
      : undefined;

    const bundle = syncBundleSchema.parse({
      format: 'kiki.sync-bundle.v1',
      exportedAt,
      portableConfig,
      homeAssets,
      credentialEnvelopes,
      memories,
      skills,
      skillPlans,
      sessions,
    });
    if (Buffer.byteLength(JSON.stringify(bundle)) > MAX_SYNC_BUNDLE_WIRE_BYTES) {
      throw new Error('Sync bundle exceeds the 64 MiB transfer limit');
    }
    return bundle;
  }

  async importSyncBundle(rawBundle: SyncBundleImportInput): Promise<SyncBundleImportReceipt> {
    const bundle = syncBundleImportInputSchema.parse(rawBundle);
    const requiredOverrideRefs = collectConfinedPromptOverrideRefs(bundle.portableConfig, bundle.homeAssets);
    let homeAssetsApplied: number | undefined;
    let homeAssetsSkipped: number | undefined;
    let installedPaths = new Set<string>();
    if (bundle.homeAssets !== undefined) {
      const applied = await this.importPortableHomeAssets(bundle.homeAssets, requiredOverrideRefs);
      homeAssetsApplied = applied.applied;
      homeAssetsSkipped = applied.skipped;
      installedPaths = applied.installedPaths;
    }

    if (bundle.portableConfig !== undefined && requiredOverrideRefs.size > 0) {
      await this.assertReferencedPromptOverridesInstalled(requiredOverrideRefs, installedPaths, bundle.homeAssets !== undefined);
    }

    const configDomainsApplied: string[] = [];
    if (bundle.portableConfig !== undefined && this.options.configService !== undefined) {
      await this.options.configService.ready;
      const sanitized = extractPortableConfigLayer(bundle.portableConfig, this.options.configRegistry);
      for (const [domain, value] of Object.entries(sanitized)) {
        if (domain === CREDENTIALS_POOL_SECTION) continue;
        const existingUser = this.options.configService.inspect(domain).userValue;
        const merged = domain === 'notifications' ? mergePortableNotifications(existingUser, value) : deepMergePortableConfig(existingUser, value);
        await this.options.configService.replace(domain, merged, ConfigTarget.User);
        configDomainsApplied.push(domain);
      }
    }

    const credentials = await this.mergeIncomingCredentials(bundle.credentialEnvelopes ?? []);

    if (bundle.targetWorkDir !== undefined) {
      await this.options.workspaceService?.createOrTouch(bundle.targetWorkDir);
    }
    const resolvedTarget = bundle.targetWorkDir !== undefined
      ? await this.resolveProjectIdentity(bundle.targetWorkDir, true)
      : undefined;
    const remappedMemoryWorkspaceId = bundle.targetProjectId !== undefined && MEMORY_WORKSPACE_ID_PATTERN.test(bundle.targetProjectId)
      ? bundle.targetProjectId
      : resolvedTarget?.projectId;
    const remappedSessionWorkspaceId = resolvedTarget?.workDirKey
      ?? (bundle.targetProjectId !== undefined && MEMORY_WORKSPACE_ID_PATTERN.test(bundle.targetProjectId)
        ? bundle.targetProjectId
        : undefined);

    let memoriesApplied = 0;
    let memoriesSkipped = 0;
    if (bundle.memories !== undefined && this.options.memoryStore !== undefined) {
      for (const item of bundle.memories) {
        const scope = resolveIncomingMemoryScope(item, remappedMemoryWorkspaceId);
        if (scope === undefined) {
          memoriesSkipped += 1;
          continue;
        }
        try {
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
              (existing.type === item.type &&
                existing.body === item.body &&
                existing.title === item.title &&
                existing.pinned === item.pinned &&
                isDeepStrictEqual(existing.basis, item.basis) &&
                isDeepStrictEqual(existing.validity, item.validity)) ||
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
              basis: item.basis,
              validity: item.validity ?? null,
              applicability: 'portable',
              origin_host_id: item.origin_host_id,
              reason: 'Cross-machine portable memory sync',
              source: { writer: 'import' },
            });
            memoriesApplied += 1;
            continue;
          }
          await this.options.memoryStore.put({
            action: 'create',
            scope,
            importedId: CANONICAL_MEMORY_ID_PATTERN.test(item.id) ? item.id : undefined,
            type: item.type,
            title: item.title,
            body: item.body,
            pinned: item.pinned,
            basis: item.basis,
            validity: item.validity,
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

    let sessionsApplied: number | undefined;
    let sessionsSkipped: number | undefined;
    if (bundle.sessions !== undefined) {
      const liveSessions = this.sessionLiveServices();
      if (liveSessions !== undefined) {
        const result = await importSessionFiles(
          liveSessions,
          bundle.sessions,
          remappedSessionWorkspaceId !== undefined || bundle.targetWorkDir !== undefined
            ? { workspaceId: remappedSessionWorkspaceId, workDir: bundle.targetWorkDir }
            : undefined,
        );
        sessionsApplied = result.sessionsApplied;
        sessionsSkipped = result.sessionsSkipped;
      } else {
        sessionsApplied = 0;
        sessionsSkipped = new Set(bundle.sessions.map((entry) => entry.sessionId)).size;
      }
    }

    return {
      configDomainsApplied: configDomainsApplied.toSorted(),
      ...(homeAssetsApplied === undefined ? {} : { homeAssetsApplied }),
      ...(homeAssetsSkipped === undefined ? {} : { homeAssetsSkipped }),
      credentials,
      memoriesApplied,
      memoriesSkipped,
      skillsApplied,
      skillsSkipped,
      ...(sessionsApplied === undefined ? {} : { sessionsApplied }),
      ...(sessionsSkipped === undefined ? {} : { sessionsSkipped }),
    };
  }

  async pushToPeer(peerId: string, input: SyncPeerTransferInput): Promise<SyncBundleImportReceipt> {
    if (this.options.peerTransport === undefined) {
      throw new Error('Peer sync transport is not configured');
    }
    const peerRecipient = await this.options.peerTransport.resolvePeerRecipient(peerId);
    const recipients = peerRecipient === undefined ? [] : [peerRecipient];
    const wantsSessions = input.sessions !== undefined && input.sessions.mode !== 'none';
    const canStreamSessions = wantsSessions && this.options.peerTransport.pushSessionsStream !== undefined;
    const bundle = await this.exportSyncBundle({
      recipients,
      credentialIds: input.credentialIds,
      projectIds: input.projectIds,
      memoryScopes: input.memoryScopes,
      workDir: input.workDir,
      includeConfig: input.includeConfig,
      includeHomeAssets: input.includeConfig,
      includeCredentials: input.includeCredentials && recipients.length > 0,
      includeMemories: input.includeMemories,
      includeSkills: input.includeSkills,
      includeGitSkills: input.includeGitSkills,
      sessions: canStreamSessions ? { mode: 'none' } : input.sessions,
    });
    const payload: SyncBundleImportInput = {
      ...bundle,
      targetWorkDir: input.targetWorkDir,
      targetProjectId: input.targetProjectId,
    };
    let receipt: SyncBundleImportReceipt;
    try {
      receipt = await this.options.peerTransport.pushBundle(peerId, payload);
    } catch (error) {
      if (bundle.homeAssets !== undefined && isLegacyHomeAssetsRejection(error)) {
        const { homeAssets: _omitted, ...legacyPayload } = payload;
        receipt = await this.options.peerTransport.pushBundle(peerId, legacyPayload);
      } else {
        throw error;
      }
    }
    if (!canStreamSessions) {
      return receipt;
    }
    try {
      const stream = await this.exportSessionsStream(input.sessions!);
      const streamed = await this.options.peerTransport.pushSessionsStream!(peerId, stream, {
        targetWorkDir: input.targetWorkDir,
        targetProjectId: input.targetProjectId,
      });
      return {
        ...receipt,
        sessionsApplied: (receipt.sessionsApplied ?? 0) + streamed.sessionsApplied,
        sessionsSkipped: (receipt.sessionsSkipped ?? 0) + streamed.sessionsSkipped,
      };
    } catch (error) {
      if (!isUnsupportedSessionStreamError(error)) throw error;
      const fallbackBundle = await this.exportSyncBundle({
        includeConfig: false,
        includeHomeAssets: false,
        includeCredentials: false,
        includeMemories: false,
        includeSkills: false,
        sessions: input.sessions,
      });
      const fallbackReceipt = await this.options.peerTransport.pushBundle(peerId, {
        ...fallbackBundle,
        targetWorkDir: input.targetWorkDir,
        targetProjectId: input.targetProjectId,
      });
      return {
        ...receipt,
        sessionsApplied: (receipt.sessionsApplied ?? 0) + (fallbackReceipt.sessionsApplied ?? 0),
        sessionsSkipped: (receipt.sessionsSkipped ?? 0) + (fallbackReceipt.sessionsSkipped ?? 0),
      };
    }
  }

  async pullFromPeer(peerId: string, input: SyncPeerTransferInput): Promise<SyncBundleImportReceipt> {
    if (this.options.peerTransport === undefined) {
      throw new Error('Peer sync transport is not configured');
    }
    const localKey = await this.ensureDeviceKeypair();
    const wantsSessions = input.sessions !== undefined && input.sessions.mode !== 'none';
    const canStreamSessions = wantsSessions && this.options.peerTransport.pullSessionsStream !== undefined;
    const pullRequest: SyncBundleExportInput = {
      recipients: [localKey.recipient],
      credentialIds: input.credentialIds,
      projectIds: input.projectIds,
      memoryScopes: input.memoryScopes,
      workDir: input.workDir,
      includeConfig: input.includeConfig,
      includeHomeAssets: input.includeConfig,
      includeCredentials: input.includeCredentials,
      includeMemories: input.includeMemories,
      includeSkills: input.includeSkills,
      includeGitSkills: input.includeGitSkills,
      sessions: canStreamSessions ? { mode: 'none' } : input.sessions,
      targetPlatform: process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux',
    };
    let bundle: SyncBundle;
    try {
      bundle = await this.options.peerTransport.pullBundle(peerId, pullRequest);
    } catch (error) {
      if (pullRequest.includeHomeAssets === true && isLegacyHomeAssetsRejection(error)) {
        const { includeHomeAssets: _omitted, ...legacyPullRequest } = pullRequest;
        bundle = await this.options.peerTransport.pullBundle(peerId, legacyPullRequest);
      } else {
        throw error;
      }
    }
    const filtered = filterPulledSyncBundle(bundle, {
      ...input,
      sessions: canStreamSessions ? { mode: 'none' } : input.sessions,
    });
    const receipt = await this.importSyncBundle({
      ...filtered,
      targetWorkDir: input.targetWorkDir,
      targetProjectId: input.targetProjectId,
    });
    if (!canStreamSessions) {
      return receipt;
    }
    try {
      const stream = await this.options.peerTransport.pullSessionsStream!(peerId, input.sessions!);
      const streamed = await this.importSessionsStream(stream, {
        targetWorkDir: input.targetWorkDir,
        targetProjectId: input.targetProjectId,
        filter: buildSessionStreamFilter(input.sessions!),
      });
      return {
        ...receipt,
        sessionsApplied: (receipt.sessionsApplied ?? 0) + streamed.sessionsApplied,
        sessionsSkipped: (receipt.sessionsSkipped ?? 0) + streamed.sessionsSkipped,
      };
    } catch (error) {
      if (!isUnsupportedSessionStreamError(error)) throw error;
      const fallbackBundle = await this.options.peerTransport.pullBundle(peerId, {
        recipients: [localKey.recipient],
        includeConfig: false,
        includeHomeAssets: false,
        includeCredentials: false,
        includeMemories: false,
        includeSkills: false,
        sessions: input.sessions,
      });
      const filteredSessions = filterPulledSyncBundle(fallbackBundle, {
        includeConfig: false,
        includeCredentials: false,
        includeMemories: false,
        includeSkills: false,
        sessions: input.sessions,
      });
      const fallbackReceipt = await this.importSyncBundle({
        ...filteredSessions,
        targetWorkDir: input.targetWorkDir,
        targetProjectId: input.targetProjectId,
      });
      return {
        ...receipt,
        sessionsApplied: (receipt.sessionsApplied ?? 0) + (fallbackReceipt.sessionsApplied ?? 0),
        sessionsSkipped: (receipt.sessionsSkipped ?? 0) + (fallbackReceipt.sessionsSkipped ?? 0),
      };
    }
  }

  /** Streams selected canonical sessions directly as a gzip-compressed POSIX tar archive with no JSON size ceiling. */
  async exportSessionsStream(selection: PortableSpaceSessionSelection): Promise<Readable> {
    if (
      this.options.bootstrap === undefined ||
      this.options.sessionManager === undefined ||
      this.options.sessionIndex === undefined ||
      this.options.appendLogStore === undefined
    ) {
      throw new Error('Session sync services are not configured');
    }
    return exportSessionsTarGzStream(
      {
        bootstrap: this.options.bootstrap,
        sessions: this.options.sessionManager,
        index: this.options.sessionIndex,
        logs: this.options.appendLogStore,
        storage: this.options.storage,
      },
      selection,
    );
  }

  /** Streams an incoming gzip-compressed session tar archive directly into staged directories and commits updates atomically. */
  async importSessionsStream(
    gzipInput: Readable,
    options?: {
      readonly targetWorkDir?: string;
      readonly targetProjectId?: string;
      readonly filter?: SessionStreamImportFilter;
    },
  ): Promise<{ readonly sessionsApplied: number; readonly sessionsSkipped: number }> {
    if (
      this.options.bootstrap === undefined ||
      this.options.sessionManager === undefined ||
      this.options.sessionIndex === undefined ||
      this.options.appendLogStore === undefined
    ) {
      throw new Error('Session sync services are not configured');
    }
    if (options?.targetWorkDir !== undefined) {
      await this.options.workspaceService?.createOrTouch(options.targetWorkDir);
    }
    const resolvedTarget = options?.targetWorkDir !== undefined
      ? await this.resolveProjectIdentity(options.targetWorkDir, true)
      : undefined;
    const remappedSessionWorkspaceId = resolvedTarget?.workDirKey
      ?? (options?.targetProjectId !== undefined && MEMORY_WORKSPACE_ID_PATTERN.test(options.targetProjectId)
        ? options.targetProjectId
        : undefined);
    return importSessionsTarGzStream(
      {
        bootstrap: this.options.bootstrap,
        sessions: this.options.sessionManager,
        index: this.options.sessionIndex,
        logs: this.options.appendLogStore,
        storage: this.options.storage,
      },
      gzipInput,
      { workspaceId: remappedSessionWorkspaceId, workDir: options?.targetWorkDir },
      options?.filter,
    );
  }

  exportFiles(input: SyncFilesExportInput): Promise<SyncFilesExportResult> {
    return exportTransferFiles(input.path, {
      homeDir: this.options.homeDir,
      osHomeDir: this.options.osHomeDir,
    });
  }

  importFiles(input: SyncFilesImportInput): Promise<SyncFilesTransferReceipt> {
    return importTransferFiles(input, {
      homeDir: this.options.homeDir,
      osHomeDir: this.options.osHomeDir,
    });
  }

  async pullFilesFromPeer(peerId: string, input: SyncPeerFilesPullInput): Promise<SyncFilesTransferReceipt> {
    if (this.options.peerTransport?.exportPeerFiles === undefined) {
      throw new Error('Peer file sync transport is not configured');
    }
    const exported = await this.options.peerTransport.exportPeerFiles(peerId, { path: input.remotePath });
    return this.importFiles({
      destinationPath: input.localPath,
      kind: exported.kind,
      archiveBase64: exported.archiveBase64,
    });
  }

  async pushFilesToPeer(peerId: string, input: SyncPeerFilesPushInput): Promise<SyncFilesTransferReceipt> {
    if (this.options.peerTransport?.importPeerFiles === undefined) {
      throw new Error('Peer file sync transport is not configured');
    }
    const exported = await this.exportFiles({ path: input.localPath });
    return this.options.peerTransport.importPeerFiles(peerId, {
      destinationPath: input.remotePath,
      kind: exported.kind,
      archiveBase64: exported.archiveBase64,
    });
  }

  private sessionLiveServices() {
    if (
      this.options.bootstrap === undefined ||
      this.options.sessionManager === undefined ||
      this.options.sessionIndex === undefined ||
      this.options.appendLogStore === undefined
    ) {
      return undefined;
    }
    return {
      bootstrap: this.options.bootstrap,
      sessions: this.options.sessionManager,
      index: this.options.sessionIndex,
      logs: this.options.appendLogStore,
      storage: this.options.storage,
    };
  }

  private async exportPortableSessions(
    selection: PortableSpaceSessionSelection,
    wireBudget: { remaining: number },
  ): Promise<SyncSessionFileEntry[]> {
    const live = this.sessionLiveServices();
    if (live === undefined) return [];
    const maxRawBytes = Math.floor((Math.max(0, wireBudget.remaining) * 3) / 4);
    const exported = await exportSessionFiles(live, selection, maxRawBytes);
    const entries: SyncSessionFileEntry[] = [];
    for (const [key, bytes] of exported) {
      const [, sessionId, ...tail] = key.split('/');
      if (!sessionId || tail.length === 0) continue;
      const relativePath = tail.join('/');
      const wireCost = estimateBase64EntryWireBytes(bytes.byteLength, sessionId, relativePath);
      if (wireCost > wireBudget.remaining) {
        throw new Error('Sync bundle exceeds the 64 MiB transfer limit');
      }
      wireBudget.remaining -= wireCost;
      entries.push({
        sessionId,
        relativePath,
        contentBase64: bytes.toString('base64'),
      });
    }
    return entries;
  }

  private async exportPortableMemories(
    explicitProjectIds?: readonly string[],
    memoryScopes?: readonly SyncMemoryScopeKind[],
  ): Promise<SyncMemoryRecord[]> {
    if (this.options.memoryStore === undefined) return [];
    const allowedKinds = new Set<SyncMemoryScopeKind>(memoryScopes ?? ALL_MEMORY_SCOPE_KINDS);
    const discovered = await discoverMemoryScopes(
      this.options.homeDir,
      this.options.memoryScopes,
      this.options.memoryPersistence,
    );
    const byKey = new Map<string, MemoryScope>();
    for (const scope of discovered) byKey.set(memoryScopeKey(scope), scope);
    let projectFilter: Set<string> | undefined;
    if (explicitProjectIds !== undefined) {
      projectFilter = new Set<string>();
      for (const id of explicitProjectIds) {
        if (MEMORY_WORKSPACE_ID_PATTERN.test(id)) {
          projectFilter.add(id);
          const wsScope: MemoryScope = { kind: 'workspace', workspaceId: id };
          byKey.set(memoryScopeKey(wsScope), wsScope);
        }
      }
    }
    const scopes = [...byKey.entries()]
      .toSorted((left, right) => left[0].localeCompare(right[0]))
      .map(([, scope]) => scope)
      .filter((scope) => {
        if (!allowedKinds.has(scope.kind)) return false;
        if (projectFilter !== undefined && (scope.kind === 'workspace' || scope.kind === 'persona_workspace')) {
          return projectFilter.has(scope.workspaceId);
        }
        return true;
      });
    const records: SyncMemoryRecord[] = [];
    for (const scope of scopes) {
      const listed = await this.options.memoryStore.list(scope);
      for (const entry of filterMemoriesForSync(listed)) {
        if (entry.status !== 'active') continue;
        records.push({
          id: entry.id,
          scope,
          projectId: scope.kind === 'workspace' || scope.kind === 'persona_workspace' ? scope.workspaceId : undefined,
          type: entry.type,
          title: entry.title,
          body: entry.body,
          pinned: entry.pinned,
          updated: entry.updated,
          revision: entry.revision,
          applicability: 'portable',
          origin_host_id: entry.origin_host_id,
          basis: entry.basis,
          validity: entry.validity,
        });
      }
    }
    return records;
  }

  private async exportPortableSkills(
    workDir?: string,
    targetPlatform?: 'win32' | 'darwin' | 'linux',
    includeGitSkills = false,
    wireBudget: { remaining: number } = { remaining: MAX_SYNC_BUNDLE_WIRE_BYTES },
  ): Promise<SyncSkillFileEntry[]> {
    const discoveredUserRoots = (await userRoots(this.options.homeDir, this.options.osHomeDir))
      .filter((root) => root.scanMode !== 'commands');
    const discoveredProjectRoots = workDir === undefined
      ? []
      : (await projectRoots(workDir)).filter((root) => root.scanMode !== 'commands');
    const candidateRoots = [...discoveredUserRoots, ...discoveredProjectRoots];
    const plans = await planSkillSync(candidateRoots);
    const selectedRoots = includeGitSkills
      ? plans
      : plans.filter((plan) => plan.transport === 'file_tree');
    const files: SyncSkillFileEntry[] = [];
    const seen = new Set<string>();
    for (const root of selectedRoots) {
      let entries;
      try {
        entries = await readdir(root.path, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        if (EXCLUDED_SKILL_DIRS.has(entry.name)) continue;
        const skillDir = join(root.path, entry.name);
        const skillMdPath = join(skillDir, 'SKILL.md');
        let skillMdText: string;
        try {
          const mdStat = await lstat(skillMdPath);
          if (mdStat.isSymbolicLink() || !mdStat.isFile()) continue;
          if (mdStat.size > MAX_SKILL_MD_PROBE_BYTES || estimateBase64EntryWireBytes(mdStat.size, entry.name, 'SKILL.md') > wireBudget.remaining) {
            throw new Error('Sync bundle exceeds the 64 MiB transfer limit');
          }
          skillMdText = await readFile(skillMdPath, 'utf8');
        } catch (error) {
          if (error instanceof Error && error.message.includes('64 MiB')) throw error;
          continue;
        }
        const fm = parseSkillFrontmatter(skillMdText);
        if (isSkillSyncExcluded({ name: entry.name, frontmatter: fm, targetPlatform })) {
          continue;
        }
        await collectSkillFiles(skillDir, entry.name, files, seen, wireBudget);
      }
    }
    return files;
  }

  private async exportPortableHomeAssets(
    wireBudget: { remaining: number },
    portableConfig?: Record<string, unknown>,
  ): Promise<SyncHomeAssetEntry[]> {
    let realHomeDir: string;
    try {
      realHomeDir = await realpath(this.options.homeDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const entries: SyncHomeAssetEntry[] = [];
    const seen = new Set<string>();
    const discoveredOverrideRefs = new Set<string>(
      portableConfig === undefined ? [] : extractPromptOverrideRefsFromConfig(portableConfig),
    );
    const addFile = async (relPath: string, fullPath: string, required: boolean): Promise<Buffer | undefined> => {
      const normalized = required
        ? normalizeConfinedPromptOverridePath(relPath)
        : normalizeAllowedSyncHomeAssetPath(relPath);
      if (normalized === undefined) {
        if (required) {
          throw new Error(`Referenced prompt override path must stay under prompt/ or agents/: '${relPath}'`);
        }
        return undefined;
      }
      if (seen.has(normalized)) return undefined;
      let info;
      try {
        info = await lstat(fullPath);
      } catch (error) {
        if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw new Error(`Referenced prompt override file could not be inspected: '${normalized}'`, { cause: error });
      }
      if (info.isSymbolicLink() || !info.isFile()) {
        if (required) {
          throw new Error(`Referenced prompt override file is not a regular file: '${normalized}'`);
        }
        return undefined;
      }
      const resolvedPath = await realpath(fullPath);
      const rel = relative(realHomeDir, resolvedPath);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        if (required) {
          throw new Error(`Referenced prompt override file escapes Kiki home: '${normalized}'`);
        }
        return undefined;
      }
      const statCost = estimateBase64EntryWireBytes(info.size, 'home', normalized);
      if (statCost > wireBudget.remaining) {
        throw new Error('Sync bundle exceeds the 64 MiB transfer limit');
      }
      let bytes: Buffer;
      const handle = await open(fullPath, fsConstants.O_RDONLY | NOFOLLOW_FLAG);
      try {
        const handleStat = await handle.stat();
        if (!handleStat.isFile()) {
          if (required) {
            throw new Error(`Referenced prompt override file is not a regular file: '${normalized}'`);
          }
          return undefined;
        }
        const handleCost = estimateBase64EntryWireBytes(handleStat.size, 'home', normalized);
        if (handleCost > wireBudget.remaining) {
          throw new Error('Sync bundle exceeds the 64 MiB transfer limit');
        }
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
      const actualCost = estimateBase64EntryWireBytes(bytes.byteLength, 'home', normalized);
      if (actualCost > wireBudget.remaining) {
        throw new Error('Sync bundle exceeds the 64 MiB transfer limit');
      }
      wireBudget.remaining -= actualCost;
      seen.add(normalized);
      entries.push({
        relativePath: normalized,
        contentBase64: bytes.toString('base64'),
      });
      return bytes;
    };

    for (const rootFile of HOME_ASSET_ROOT_FILES) {
      await addFile(rootFile, join(realHomeDir, rootFile), false);
    }
    const walkDir = async (relDir: string, fullDir: string): Promise<void> => {
      let info;
      try {
        info = await lstat(fullDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      if (info.isSymbolicLink() || !info.isDirectory()) return;
      const resolvedDir = await realpath(fullDir);
      const dirRel = relative(realHomeDir, resolvedDir);
      if (dirRel.startsWith('..') || isAbsolute(dirRel)) return;
      let children;
      try {
        children = await readdir(fullDir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      const sorted = children.toSorted((left, right) => left.name.localeCompare(right.name));
      for (const child of sorted) {
        if (child.isSymbolicLink()) continue;
        if (HOME_ASSET_EXCLUDED_SEGMENT.test(child.name) || isSyncConflictArtifact(child.name)) continue;
        const childRel = `${relDir}/${child.name}`;
        if (relDir === 'agents' && child.name.toLowerCase() === 'builtin') continue;
        const childFull = join(fullDir, child.name);
        if (child.isDirectory()) {
          await walkDir(childRel, childFull);
        } else if (child.isFile()) {
          const fileBytes = await addFile(childRel, childFull, false);
          if (fileBytes !== undefined && childRel.startsWith('agents/') && childRel.toLowerCase().endsWith('.md')) {
            try {
              for (const ref of extractPromptOverrideRefsFromAgentMarkdown(fileBytes.toString('utf8'), childRel)) {
                discoveredOverrideRefs.add(ref);
              }
            } catch {}
          }
        }
      }
    };
    for (const rootDir of HOME_ASSET_ROOT_DIRS) {
      await walkDir(rootDir, join(realHomeDir, rootDir));
    }
    for (const ref of [...discoveredOverrideRefs].toSorted((a, b) => a.localeCompare(b))) {
      await addFile(ref, join(realHomeDir, ref), true);
    }
    return entries.toSorted((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  private async importPortableHomeAssets(
    assets: readonly SyncHomeAssetEntry[],
    requiredOverrideRefs: ReadonlySet<string>,
  ): Promise<{ readonly applied: number; readonly skipped: number; readonly installedPaths: Set<string> }> {
    await mkdir(this.options.homeDir, { recursive: true });
    const realHomeDir = await realpath(this.options.homeDir);
    let applied = 0;
    let skipped = 0;
    const installedPaths = new Set<string>();
    for (const entry of assets) {
      const normalized = normalizeAllowedSyncHomeAssetPath(entry.relativePath);
      if (normalized === undefined) {
        skipped += 1;
        continue;
      }
      const isRequired = requiredOverrideRefs.has(normalized);
      const dest = resolve(realHomeDir, normalized);
      const rel = relative(realHomeDir, dest);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        if (isRequired) throw new Error(`Referenced prompt override escapes Kiki home: '${normalized}'`);
        skipped += 1;
        continue;
      }
      if (!(await hasNoSymlinkSegments(realHomeDir, normalized))) {
        if (isRequired) throw new Error(`Referenced prompt override contains a symlink segment: '${normalized}'`);
        skipped += 1;
        continue;
      }
      const destParent = dirname(dest);
      await mkdir(destParent, { recursive: true });
      const confirmedParent = await realpath(destParent);
      const parentRel = relative(realHomeDir, confirmedParent);
      if (parentRel.startsWith('..') || isAbsolute(parentRel)) {
        if (isRequired) throw new Error(`Referenced prompt override parent escapes Kiki home: '${normalized}'`);
        skipped += 1;
        continue;
      }
      if (!(await isSafeRegularWriteTarget(dest))) {
        if (isRequired) throw new Error(`Referenced prompt override target is unsafe (symlink, directory, or hardlink): '${normalized}'`);
        skipped += 1;
        continue;
      }
      const tmpPath = join(confirmedParent, `.kiki-home-asset-${randomBytes(8).toString('hex')}.tmp`);
      let handle;
      try {
        handle = await open(
          tmpPath,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW_FLAG,
          0o644,
        );
        await handle.writeFile(Buffer.from(entry.contentBase64, 'base64'));
        await handle.close();
        handle = undefined;
        if (!(await isSafeRegularWriteTarget(dest))) {
          await unlink(tmpPath).catch(() => {});
          if (isRequired) throw new Error(`Referenced prompt override target became unsafe during install: '${normalized}'`);
          skipped += 1;
          continue;
        }
        await rename(tmpPath, dest);
      } catch (error) {
        if (handle !== undefined) await handle.close().catch(() => {});
        await unlink(tmpPath).catch(() => {});
        if (isRequired) {
          throw new Error(`Failed to install referenced prompt override '${normalized}'`, { cause: error });
        }
        skipped += 1;
        continue;
      }
      applied += 1;
      installedPaths.add(normalized);
    }
    return { applied, skipped, installedPaths };
  }

  private async assertReferencedPromptOverridesInstalled(
    requiredOverrideRefs: ReadonlySet<string>,
    installedPaths: ReadonlySet<string>,
    bundleCarriedHomeAssets: boolean,
  ): Promise<void> {
    await mkdir(this.options.homeDir, { recursive: true });
    const realHomeDir = await realpath(this.options.homeDir);
    for (const ref of requiredOverrideRefs) {
      if (bundleCarriedHomeAssets && !installedPaths.has(ref)) {
        const presentLocally = await this.verifyLocalPromptOverrideFile(realHomeDir, ref);
        if (!presentLocally) {
          throw new Error(`Referenced prompt override file is missing from incoming sync bundle: '${ref}'`);
        }
        continue;
      }
      const verified = await this.verifyLocalPromptOverrideFile(realHomeDir, ref);
      if (!verified) {
        throw new Error(`Referenced prompt override file could not be verified before applying config: '${ref}'`);
      }
    }
  }

  private async verifyLocalPromptOverrideFile(realHomeDir: string, normalized: string): Promise<boolean> {
    const dest = resolve(realHomeDir, normalized);
    const rel = relative(realHomeDir, dest);
    if (rel.startsWith('..') || isAbsolute(rel)) return false;
    if (!(await hasNoSymlinkSegments(realHomeDir, normalized))) return false;
    try {
      const info = await lstat(dest);
      if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) return false;
      const realDest = await realpath(dest);
      const realRel = relative(realHomeDir, realDest);
      return !realRel.startsWith('..') && !isAbsolute(realRel);
    } catch {
      return false;
    }
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

function memoryScopeKey(scope: MemoryScope): string {
  switch (scope.kind) {
    case 'global': return 'global';
    case 'persona': return `persona/${scope.personaId}`;
    case 'workspace': return `workspace/${scope.workspaceId}`;
    case 'persona_workspace': return `persona_workspace/${scope.personaId}/${scope.workspaceId}`;
  }
}

function resolveIncomingMemoryScope(
  item: SyncMemoryRecord,
  remappedWorkspaceId?: string,
): MemoryScope | undefined {
  if (item.scope !== undefined) {
    switch (item.scope.kind) {
      case 'global':
        return { kind: 'global' };
      case 'persona':
        return MEMORY_PERSONA_ID_PATTERN.test(item.scope.personaId)
          ? { kind: 'persona', personaId: item.scope.personaId }
          : undefined;
      case 'workspace': {
        const workspaceId = remappedWorkspaceId ?? item.scope.workspaceId;
        return MEMORY_WORKSPACE_ID_PATTERN.test(workspaceId)
          ? { kind: 'workspace', workspaceId }
          : undefined;
      }
      case 'persona_workspace': {
        const workspaceId = remappedWorkspaceId ?? item.scope.workspaceId;
        return MEMORY_WORKSPACE_ID_PATTERN.test(workspaceId) && MEMORY_PERSONA_ID_PATTERN.test(item.scope.personaId)
          ? { kind: 'persona_workspace', workspaceId, personaId: item.scope.personaId }
          : undefined;
      }
    }
  }
  const workspaceId = remappedWorkspaceId ?? item.projectId;
  if (workspaceId === undefined || !MEMORY_WORKSPACE_ID_PATTERN.test(workspaceId)) return undefined;
  return { kind: 'workspace', workspaceId };
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

function isLegacyHomeAssetsRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:homeAssets|includeHomeAssets)/i.test(message) && /unrecognized|unknown|additional/i.test(message);
}

function isUnsupportedSessionStreamError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (status === 404 || status === 405 || status === 501) return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP (?:404|405|501)\b|Not Found/i.test(message);
}

function buildSessionStreamFilter(selection: PortableSpaceSessionSelection): SessionStreamImportFilter | undefined {
  if (selection.mode === 'ids') {
    return { allowedSessionIds: new Set(selection.sessionIds) };
  }
  if (selection.mode === 'recent') {
    return { maxSessions: selection.count };
  }
  return undefined;
}

function filterPulledSyncBundle(bundle: SyncBundle, input: SyncPeerTransferInput): SyncBundle {
  const allowedCredentialIds = input.credentialIds === undefined ? undefined : new Set(input.credentialIds);
  const allowedMemoryScopes = input.memoryScopes === undefined ? undefined : new Set(input.memoryScopes);
  const allowedProjectIds = input.projectIds === undefined ? undefined : new Set(input.projectIds);

  const credentialEnvelopes = !input.includeCredentials || bundle.credentialEnvelopes === undefined
    ? undefined
    : allowedCredentialIds === undefined
      ? bundle.credentialEnvelopes
      : bundle.credentialEnvelopes.filter((env) => allowedCredentialIds.has(env.credentialId));

  const memories = !input.includeMemories || bundle.memories === undefined
    ? undefined
    : bundle.memories.filter((item) => {
        const scopeKind: SyncMemoryScopeKind = item.scope?.kind ?? 'workspace';
        if (allowedMemoryScopes !== undefined && !allowedMemoryScopes.has(scopeKind)) {
          return false;
        }
        if (allowedProjectIds !== undefined && (scopeKind === 'workspace' || scopeKind === 'persona_workspace')) {
          const workspaceId = item.scope !== undefined && 'workspaceId' in item.scope
            ? item.scope.workspaceId
            : item.projectId;
          if (workspaceId === undefined || !allowedProjectIds.has(workspaceId)) {
            return false;
          }
        }
        return true;
      });

  let sessions: SyncSessionFileEntry[] | undefined;
  if (input.sessions !== undefined && input.sessions.mode !== 'none' && bundle.sessions !== undefined) {
    if (input.sessions.mode === 'ids') {
      const allowedSessions = new Set(input.sessions.sessionIds);
      sessions = bundle.sessions.filter((entry) => allowedSessions.has(entry.sessionId));
    } else {
      const allowedSessions = new Set<string>();
      sessions = [];
      for (const entry of bundle.sessions) {
        if (!allowedSessions.has(entry.sessionId)) {
          if (allowedSessions.size >= input.sessions.count) continue;
          allowedSessions.add(entry.sessionId);
        }
        sessions.push(entry);
      }
    }
  }

  return {
    format: bundle.format,
    exportedAt: bundle.exportedAt,
    portableConfig: input.includeConfig ? bundle.portableConfig : undefined,
    homeAssets: input.includeConfig ? bundle.homeAssets : undefined,
    credentialEnvelopes,
    memories,
    skills: input.includeSkills ? bundle.skills : undefined,
    skillPlans: input.includeSkills ? bundle.skillPlans : undefined,
    sessions,
  };
}

function normalizeConfinedPromptOverridePath(rawPath: string): string | undefined {
  let validated: string;
  try {
    validated = safePortablePath(validatePromptOverridePath(rawPath));
  } catch {
    return undefined;
  }
  const parts = validated.split('/');
  if (parts.length < 2) return undefined;
  if (parts.some((part) => HOME_ASSET_EXCLUDED_SEGMENT.test(part) || isSyncConflictArtifact(part))) {
    return undefined;
  }
  const top = parts[0];
  if (top === 'prompt' || top === 'prompts') return validated;
  if (top === 'agents' && parts[1]?.toLowerCase() !== 'builtin') return validated;
  return undefined;
}

function collectConfinedPromptOverrideRefs(
  portableConfig: Record<string, unknown> | undefined,
  homeAssets: readonly SyncHomeAssetEntry[] | undefined,
): Set<string> {
  const refs = new Set<string>();
  const addRef = (raw: string): void => {
    const confined = normalizeConfinedPromptOverridePath(raw);
    if (confined === undefined) {
      throw new Error(`Referenced prompt override path must stay under prompt/ or agents/: '${raw}'`);
    }
    refs.add(confined);
  };
  if (portableConfig !== undefined) {
    for (const ref of extractPromptOverrideRefsFromConfig(portableConfig)) {
      addRef(ref);
    }
  }
  if (homeAssets !== undefined) {
    for (const entry of homeAssets) {
      const normalized = normalizeAllowedSyncHomeAssetPath(entry.relativePath);
      if (normalized !== undefined && normalized.startsWith('agents/') && normalized.toLowerCase().endsWith('.md')) {
        const text = Buffer.from(entry.contentBase64, 'base64').toString('utf8');
        let agentRefs: readonly string[];
        try {
          agentRefs = extractPromptOverrideRefsFromAgentMarkdown(text, normalized);
        } catch {
          continue;
        }
        for (const ref of agentRefs) {
          addRef(ref);
        }
      }
    }
  }
  return refs;
}

function normalizeAllowedSyncHomeAssetPath(rawPath: string): string | undefined {
  let normalized: string;
  try {
    normalized = safePortablePath(rawPath);
  } catch {
    return undefined;
  }
  const parts = normalized.split('/');
  if (parts.some((part) => HOME_ASSET_EXCLUDED_SEGMENT.test(part) || isSyncConflictArtifact(part))) {
    return undefined;
  }
  if (parts.length === 1) {
    return (HOME_ASSET_ROOT_FILES as readonly string[]).includes(normalized) ? normalized : undefined;
  }
  const top = parts[0];
  if (top === undefined || !(HOME_ASSET_ROOT_DIRS as readonly string[]).includes(top)) {
    return undefined;
  }
  if (top === 'agents' && parts[1]?.toLowerCase() === 'builtin') {
    return undefined;
  }
  return normalized;
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
    return !stat.isSymbolicLink() && !stat.isDirectory() && stat.nlink <= 1;
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

function estimateBase64EntryWireBytes(rawBytes: number, ownerKey: string, relativePath: string): number {
  return Math.ceil(rawBytes / 3) * 4 + Buffer.byteLength(ownerKey) + Buffer.byteLength(relativePath) + 96;
}

async function collectSkillFiles(
  skillDir: string,
  skillName: string,
  out: SyncSkillFileEntry[],
  seen: Set<string>,
  wireBudget: { remaining: number },
): Promise<void> {
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (EXCLUDED_SKILL_DIRS.has(entry.name) || isSyncConflictArtifact(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const rel = relative(skillDir, fullPath).replaceAll('\\', '/');
        if (isSecretSkillSidecar(rel)) continue;
        const key = `${skillName}\0${rel}`;
        if (seen.has(key)) continue;
        const info = await lstat(fullPath);
        if (info.isSymbolicLink() || !info.isFile()) continue;
        const statCost = estimateBase64EntryWireBytes(info.size, skillName, rel);
        if (statCost > wireBudget.remaining) {
          throw new Error('Sync bundle exceeds the 64 MiB transfer limit');
        }
        const bytes = await readFile(fullPath);
        const actualCost = estimateBase64EntryWireBytes(bytes.byteLength, skillName, rel);
        if (actualCost > wireBudget.remaining) {
          throw new Error('Sync bundle exceeds the 64 MiB transfer limit');
        }
        wireBudget.remaining -= actualCost;
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
