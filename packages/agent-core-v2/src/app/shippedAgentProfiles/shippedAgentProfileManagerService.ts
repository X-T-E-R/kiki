import { createHash } from 'node:crypto';

import { dirname, join, relative } from 'pathe';

import { Emitter, type Event } from '#/_base/event';
import { Disposable } from '#/_base/di/lifecycle';
import { atomicWrite } from '#/_base/utils/fs';
import { ILogService } from '#/_base/log/log';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Error2, ErrorCodes } from '#/errors';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  DISABLED_BUILTIN_PROFILES_SECTION,
  SKIP_BUILTIN_PROFILE_INSTALLATION_SECTION,
  type DisabledBuiltinProfilesConfig,
  type SkipBuiltinProfileInstallationConfig,
} from '#/workspace/workspaceAgentProfileLoader/configSection';
import { SYSTEM_MD_FILENAME } from '@kiki/agent-profiles/systemFile';
import { isHostFsMissing } from '@kiki/agent-profiles/hostFs';

import {
  IShippedAgentProfileManager,
  type ShippedAgentProfileStatus,
  type ShippedAgentProfileStatusEntry,
} from './shippedAgentProfileManager';
import {
  SHIPPED_AGENT_PROFILE_BUNDLE_VERSION,
  SHIPPED_AGENT_PROFILE_TEMPLATES,
  type ShippedAgentProfileTemplate,
} from './shippedAgentProfiles';

const STATE_DIR_NAME = 'agent-profile-state';
const ACTIVE_DIR_RELATIVE = 'agents/builtin';
const MANIFEST_NAME = 'manifest.json';
const MANAGED_SCAN_DEPTH = 8;

type SkipReason = 'adopted' | 'disabled' | 'conflict';

interface ManagedStateRecord {
  readonly activePath: string;
  readonly baselineHash: string;
  readonly offeredHash: string | undefined;
  readonly status: 'clean' | 'custom' | 'update-available' | 'removed';
  readonly updatedAt: string;
}

interface ShippedAgentProfileStateManifest {
  readonly schemaVersion: 1;
  readonly bundleVersion: number;
  readonly templates: Record<string, ManagedStateRecord>;
  readonly skipped: Record<string, SkipReason>;
}

type AtomicTextWriter = (path: string, text: string) => Promise<void>;

/** `shippedAgentProfiles` domain — owns the on-disk lifecycle of the managed copies of the shipped
 *  agent profiles (`<userAgentProfileHomeDir>/agents/builtin/`). At startup it materializes the
 *  shipped originals on first run, reconciles every managed file against the B/U/N baseline
 *  protocol (unmodified files follow the installed originals; modified files are never
 *  overwritten; removed files stay removed), and exposes per-template status plus a restore-
 *  original operation. Failures degrade to an unmanaged, diagnostic state and never fail app
 *  startup or rewrite a file it does not manage. */
export class ShippedAgentProfileManagerService
  extends Disposable
  implements IShippedAgentProfileManager
{
  declare readonly _serviceBrand: undefined;

  private readonly onDidChangeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

  private readonly readyPromise: Promise<void>;
  private manifestValue: ShippedAgentProfileStateManifest | undefined;
  private reconcileFailures = false;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @ILogService private readonly log: ILogService,
    @IConfigService private readonly config: IConfigService,
    private readonly atomicTextWriter: AtomicTextWriter = atomicWrite,
    private readonly templates: readonly ShippedAgentProfileTemplate[] = SHIPPED_AGENT_PROFILE_TEMPLATES,
  ) {
    super();
    this.readyPromise = this.reconcile().catch((error) => {
      this.reconcileFailures = true;
      this.log.warn(`shipped agent profile reconcile failed: ${String(error)}`);
    });
    void this.readyPromise.catch(() => undefined);
  }

  get ready(): Promise<void> {
    return this.readyPromise;
  }

  get stateDir(): string {
    return join(this.bootstrap.userAgentProfileHomeDir, STATE_DIR_NAME);
  }

  get activeDir(): string {
    return join(this.bootstrap.userAgentProfileHomeDir, ACTIVE_DIR_RELATIVE);
  }

  async status(): Promise<readonly ShippedAgentProfileStatusEntry[]> {
    await this.ready;
    const manifest = this.manifestValue;
    if (manifest === undefined) return [];
    const entries: ShippedAgentProfileStatusEntry[] = [];
    const shippedIds = new Set(this.templates.map((template) => template.id));
    for (const template of this.templates) {
      entries.push(await this.liveEntry(template, manifest));
    }
    for (const [id, record] of Object.entries(manifest.templates)) {
      if (shippedIds.has(id)) continue;
      entries.push({
        templateId: id,
        status: 'retired',
        managed: false,
        activePath: this.toAbsolute(record.activePath),
        baselineHash: record.baselineHash,
        activeHash: undefined,
        offeredHash: undefined,
      });
    }
    for (const [id, reason] of Object.entries(manifest.skipped)) {
      if (shippedIds.has(id)) continue;
      entries.push(skippedEntry(id, reason, this.activeFilePath(id)));
    }
    return entries;
  }

  async restoreOriginal(templateId: string): Promise<ShippedAgentProfileStatusEntry> {
    await this.ready;
    const manifest = this.manifestValue;
    const template = this.templates.find((candidate) => candidate.id === templateId);
    if (manifest === undefined || template === undefined) {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        `Shipped agent profile "${templateId}" is not restorable`,
        { details: { templateId } },
      );
    }
    const record = manifest.templates[templateId];
    if (record === undefined) {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        `Shipped agent profile "${templateId}" is not managed (status: ${manifest.skipped[templateId] ?? 'unknown'})`,
        { details: { templateId, status: manifest.skipped[templateId] } },
      );
    }
    const activePath = this.toAbsolute(record.activePath);
    const backupId = `restore-${new Date().toISOString().replaceAll(':', '-')}-${templateId}`;
    try {
      const current = await this.fs.readText(activePath);
      await this.writeBackup(backupId, record.activePath, current);
    } catch (error) {
      if (!isHostFsMissing(error)) throw error;
    }
    await this.fs.mkdir(dirname(activePath), { recursive: true });
    await this.atomicTextWriter(activePath, template.text);
    this.manifestValue = {
      ...manifest,
      templates: {
        ...manifest.templates,
        [templateId]: {
          activePath: record.activePath,
          baselineHash: hashText(template.text),
          offeredHash: undefined,
          status: 'clean',
          updatedAt: new Date().toISOString(),
        },
      },
    };
    await this.persistManifest();
    this.onDidChangeEmitter.fire();
    return this.liveEntry(template, this.manifestValue);
  }

  private async reconcile(): Promise<void> {
    await this.config.ready;
    const existing = await this.readManifest();
    if (existing === 'corrupt') {
      this.log.warn(
        `shipped agent profile state at ${this.manifestPath} is corrupt; protecting on-disk files and rebuilding management state`,
      );
      this.manifestValue = await this.buildConflictManifest();
    } else {
      this.manifestValue = existing ?? { schemaVersion: 1, bundleVersion: SHIPPED_AGENT_PROFILE_BUNDLE_VERSION, templates: {}, skipped: {} };
      await this.reconcileManifest();
    }
    await this.persistManifest();
  }

  private async reconcileManifest(): Promise<void> {
    const manifest = this.manifestValue!;
    const nextSkipped: Record<string, SkipReason> = {};
    const nextTemplates: Record<string, ManagedStateRecord> = {};
    const legacyInstall = await this.detectLegacyInstall();
    const disabled = this.skippedInstallationNames();
    for (const template of this.templates) {
      try {
        const record = manifest.templates[template.id];
        if (record !== undefined) {
          nextTemplates[template.id] = await this.reconcileManaged(template, record);
          continue;
        }
        const skip = manifest.skipped[template.id];
        const stillApplies = await this.skipReasonApplies(template, skip, disabled);
        if (skip !== undefined && stillApplies) {
          nextSkipped[template.id] = skip;
          continue;
        }
        if (await this.adoptedByUserFile(template)) {
          nextSkipped[template.id] = 'adopted';
          continue;
        }
        if (disabled.has(template.id)) {
          nextSkipped[template.id] = 'disabled';
          continue;
        }
        if (await this.activeFileExists(template.id)) {
          nextSkipped[template.id] = 'conflict';
          this.log.warn(
            `shipped agent profile "${template.id}" exists at ${this.activeFilePath(template.id)} without management state; leaving it unmanaged`,
          );
          continue;
        }
        if (!this.materializesFor(template, legacyInstall)) continue;
        nextTemplates[template.id] = await this.materialize(template);
      } catch (error) {
        this.reconcileFailures = true;
        this.log.warn(`shipped agent profile "${template.id}" reconcile failed: ${String(error)}`);
        if (manifest.templates[template.id] !== undefined) {
          nextTemplates[template.id] = manifest.templates[template.id]!;
        } else if (manifest.skipped[template.id] !== undefined) {
          nextSkipped[template.id] = manifest.skipped[template.id]!;
        }
      }
    }
    this.manifestValue = {
      schemaVersion: 1,
      bundleVersion: SHIPPED_AGENT_PROFILE_BUNDLE_VERSION,
      templates: {
        ...nextTemplates,
        ...retiredRecords(manifest.templates, new Set(this.templates.map((template) => template.id))),
      },
      skipped: {
        ...nextSkipped,
        ...retiredSkipped(manifest.skipped, new Set(this.templates.map((template) => template.id))),
      },
    };
  }

  private async reconcileManaged(
    template: ShippedAgentProfileTemplate,
    record: ManagedStateRecord,
  ): Promise<ManagedStateRecord> {
    const activePath = this.toAbsolute(record.activePath);
    let current: string;
    try {
      current = await this.fs.readText(activePath);
    } catch (error) {
      if (isHostFsMissing(error)) {
        return { ...record, status: 'removed', offeredHash: undefined };
      }
      throw error;
    }
    const activeHash = hashText(current);
    const nextHash = hashText(template.text);
    if (activeHash === record.baselineHash) {
      if (nextHash === record.baselineHash) {
        return { ...record, status: 'clean', offeredHash: undefined };
      }
      await this.writeBackup(`update-${new Date().toISOString().replaceAll(':', '-')}-${template.id}`, record.activePath, current);
      await this.atomicTextWriter(activePath, template.text);
      return {
        activePath: record.activePath,
        baselineHash: nextHash,
        offeredHash: undefined,
        status: 'clean',
        updatedAt: new Date().toISOString(),
      };
    }
    if (activeHash === nextHash) {
      return {
        ...record,
        baselineHash: nextHash,
        offeredHash: undefined,
        status: 'clean',
      };
    }
    if (nextHash === record.baselineHash) {
      return { ...record, status: 'custom', offeredHash: undefined };
    }
    await this.storeOriginal(nextHash, template.text);
    return { ...record, status: 'update-available', offeredHash: nextHash };
  }

  private async liveEntry(
    template: ShippedAgentProfileTemplate,
    manifest: ShippedAgentProfileStateManifest,
  ): Promise<ShippedAgentProfileStatusEntry> {
    const record = manifest.templates[template.id];
    const activePath = this.activeFilePath(template.id);
    if (record === undefined) {
      return skippedEntry(template.id, manifest.skipped[template.id], activePath);
    }
    let current: string | undefined;
    try {
      current = await this.fs.readText(this.toAbsolute(record.activePath));
    } catch (error) {
      if (!isHostFsMissing(error)) throw error;
    }
    const activeHash = current === undefined ? undefined : hashText(current);
    const nextHash = hashText(template.text);
    let status: ShippedAgentProfileStatus = record.status;
    if (current === undefined) {
      status = 'removed';
    } else if (activeHash === nextHash) {
      status = 'clean';
    } else if (activeHash === record.baselineHash) {
      status = 'clean';
    } else if (nextHash === record.baselineHash) {
      status = 'custom';
    } else {
      status = 'update-available';
    }
    return {
      templateId: template.id,
      status,
      managed: true,
      activePath: this.toAbsolute(record.activePath),
      baselineHash: record.baselineHash,
      activeHash,
      offeredHash: status === 'update-available' ? nextHash : undefined,
    };
  }

  private async materialize(template: ShippedAgentProfileTemplate): Promise<ManagedStateRecord> {
    const activePath = this.activeFilePath(template.id);
    await this.fs.mkdir(dirname(activePath), { recursive: true });
    await this.atomicTextWriter(activePath, template.text);
    return {
      activePath: this.relativeToHome(activePath),
      baselineHash: hashText(template.text),
      offeredHash: undefined,
      status: 'clean',
      updatedAt: new Date().toISOString(),
    };
  }

  private async adoptedByUserFile(template: ShippedAgentProfileTemplate): Promise<boolean> {
    if (template.id === 'agent' && (await this.systemMdExists())) return true;
    return (await this.findUserProvidedFile(template.id)) !== undefined;
  }

  private async skipReasonApplies(
    template: ShippedAgentProfileTemplate,
    skip: SkipReason | undefined,
    disabled: ReadonlySet<string>,
  ): Promise<boolean> {
    if (skip === undefined) return false;
    if (skip === 'disabled') return disabled.has(template.id);
    if (skip === 'conflict') return this.activeFileExists(template.id);
    return this.adoptedByUserFile(template);
  }

  private async detectLegacyInstall(): Promise<boolean> {
    if (await this.systemMdExists()) return true;
    const agentsRoot = join(this.bootstrap.userAgentProfileHomeDir, 'agents');
    try {
      if ((await this.fs.readdir(agentsRoot)).length > 0) return true;
    } catch (error) {
      if (!isHostFsMissing(error)) throw error;
    }
    return this.skippedInstallationNames().size > 0;
  }

  private materializesFor(template: ShippedAgentProfileTemplate, legacyInstall: boolean): boolean {
    return legacyInstall
      ? template.materializeOnLegacyInstall
      : template.materializeOnFreshInstall;
  }

  private skippedInstallationNames(): ReadonlySet<string> {
    const current = this.config.get<SkipBuiltinProfileInstallationConfig>(SKIP_BUILTIN_PROFILE_INSTALLATION_SECTION);
    const legacy = this.config.get<DisabledBuiltinProfilesConfig>(DISABLED_BUILTIN_PROFILES_SECTION);
    return new Set(current ?? legacy ?? []);
  }

  private async systemMdExists(): Promise<boolean> {
    try {
      const stat = await this.fs.stat(join(this.bootstrap.userAgentProfileHomeDir, SYSTEM_MD_FILENAME));
      return stat.isFile;
    } catch (error) {
      if (isHostFsMissing(error)) return false;
      throw error;
    }
  }

  private async activeFileExists(id: string): Promise<boolean> {
    try {
      const stat = await this.fs.stat(this.activeFilePath(id));
      return stat.isFile;
    } catch (error) {
      if (isHostFsMissing(error)) return false;
      throw error;
    }
  }

  private async findUserProvidedFile(id: string): Promise<string | undefined> {
    const agentsRoot = join(this.bootstrap.userAgentProfileHomeDir, 'agents');
    const managedRoot = this.activeDir.replaceAll('\\', '/');
    const visit = async (dir: string, depth: number): Promise<string | undefined> => {
      if (depth > MANAGED_SCAN_DEPTH) return undefined;
      let entries;
      try {
        entries = await this.fs.readdir(dir);
      } catch (error) {
        if (isHostFsMissing(error)) return undefined;
        throw error;
      }
      for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name.toLowerCase() === '_private') {
          continue;
        }
        const path = join(dir, entry.name);
        if (entry.isDirectory) {
          if (path.replaceAll('\\', '/') === managedRoot) continue;
          const found = await visit(path, depth + 1);
          if (found !== undefined) return found;
          continue;
        }
        if (entry.isFile && entry.name === `${id}.md`) return path;
      }
      return undefined;
    };
    return visit(agentsRoot, 0);
  }

  private async buildConflictManifest(): Promise<ShippedAgentProfileStateManifest> {
    const manifest: ShippedAgentProfileStateManifest = {
      schemaVersion: 1,
      bundleVersion: SHIPPED_AGENT_PROFILE_BUNDLE_VERSION,
      templates: {},
      skipped: {},
    };
    for (const template of this.templates) {
      if (await this.activeFileExists(template.id)) {
        manifest.skipped[template.id] = 'conflict';
      }
    }
    this.manifestValue = manifest;
    await this.reconcileManifest();
    return this.manifestValue!;
  }

  private async readManifest(): Promise<ShippedAgentProfileStateManifest | 'corrupt' | undefined> {
    let text: string;
    try {
      text = await this.fs.readText(this.manifestPath);
    } catch (error) {
      if (isHostFsMissing(error)) return undefined;
      throw error;
    }
    try {
      const parsed = JSON.parse(text) as ShippedAgentProfileStateManifest;
      if (parsed.schemaVersion !== 1 || typeof parsed.templates !== 'object' || parsed.templates === null) {
        return 'corrupt';
      }
      return {
        schemaVersion: 1,
        bundleVersion: typeof parsed.bundleVersion === 'number' ? parsed.bundleVersion : SHIPPED_AGENT_PROFILE_BUNDLE_VERSION,
        templates: parsed.templates ?? {},
        skipped: parsed.skipped ?? {},
      };
    } catch {
      return 'corrupt';
    }
  }

  private async persistManifest(): Promise<void> {
    const manifest = this.manifestValue;
    if (manifest === undefined) return;
    await this.fs.mkdir(this.stateDir, { recursive: true });
    await this.atomicTextWriter(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  private async storeOriginal(hash: string, text: string): Promise<void> {
    const path = join(this.stateDir, 'originals', `${hash}.md`);
    try {
      await this.fs.stat(path);
      return;
    } catch (error) {
      if (!isHostFsMissing(error)) throw error;
    }
    await this.fs.mkdir(dirname(path), { recursive: true });
    await this.atomicTextWriter(path, text);
  }

  private async writeBackup(backupId: string, relativeActivePath: string, text: string): Promise<void> {
    const path = join(this.stateDir, 'backups', backupId, relativeActivePath.split('/').pop() ?? 'profile.md');
    await this.fs.mkdir(dirname(path), { recursive: true });
    await this.atomicTextWriter(path, text);
  }

  private get manifestPath(): string {
    return join(this.stateDir, MANIFEST_NAME);
  }

  private activeFilePath(id: string): string {
    const template = this.templates.find((candidate) => candidate.id === id);
    const fileName = template?.fileName ?? `${id}.md`;
    return join(this.activeDir, fileName);
  }

  private toAbsolute(homeRelativePath: string): string {
    return join(this.bootstrap.userAgentProfileHomeDir, homeRelativePath);
  }

  private relativeToHome(path: string): string {
    return relative(this.bootstrap.userAgentProfileHomeDir, path).replaceAll('\\', '/');
  }
}

function retiredRecords(
  records: Record<string, ManagedStateRecord>,
  shippedIds: ReadonlySet<string>,
): Record<string, ManagedStateRecord> {
  return Object.fromEntries(Object.entries(records).filter(([id]) => !shippedIds.has(id)));
}

function retiredSkipped(
  skipped: Record<string, SkipReason>,
  shippedIds: ReadonlySet<string>,
): Record<string, SkipReason> {
  return Object.fromEntries(Object.entries(skipped).filter(([id]) => !shippedIds.has(id)));
}

function skippedEntry(
  templateId: string,
  reason: SkipReason | undefined,
  activePath: string | undefined,
): ShippedAgentProfileStatusEntry {
  const status: ShippedAgentProfileStatus =
    reason === 'adopted'
      ? 'adopted'
      : reason === 'disabled'
        ? 'disabled'
        : reason === 'conflict'
          ? 'unmanaged'
          : 'unmanaged';
  return {
    templateId,
    status,
    managed: false,
    activePath,
    baselineHash: undefined,
    activeHash: undefined,
    offeredHash: undefined,
  };
}

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

registerScopedService(
  LifecycleScope.App,
  IShippedAgentProfileManager,
  ShippedAgentProfileManagerService,
  ScopeActivation.OnScopeCreated,
  'shippedAgentProfiles',
);
