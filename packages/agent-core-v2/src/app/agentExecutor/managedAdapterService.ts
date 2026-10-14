import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { basename, dirname, isAbsolute, join } from 'pathe';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { LifecycleScope } from '#/app/scopes';
import { Error2, ErrorCodes, isError2 } from '#/errors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';

import { IAgentExecutorRegistry, type AgentExecutorDescriptor } from './agentExecutor';
import { locateCommand } from './binaryDiscovery';
import {
  expandSourceOwnedAdapterPath,
  MANAGED_ADAPTER_RELEASES,
  MANAGED_ADAPTER_SCOPE,
  managedAdapterEntry,
  SOURCE_OWNED_ADAPTER_ENTRY,
  SOURCE_OWNED_ADAPTER_FILES,
  SOURCE_OWNED_ADAPTER_PACKAGE,
  SOURCE_OWNED_ADAPTER_ROOT_ENV,
  SOURCE_OWNED_ADAPTER_SOURCE,
  SOURCE_OWNED_ADAPTER_VERSION,
  sourceOwnedAdapterScript,
  type ManagedAdapterInstallation,
  type ManagedAdapterRelease,
  type ManagedAdapterState,
} from './managedAdapterRegistry';
import { resolveWindowsNodeShim } from './windowsNodeShim';

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = 5 * 60_000;

export interface ManagedAdapterStatus {
  readonly id: string;
  readonly release: ManagedAdapterRelease;
  readonly active?: ManagedAdapterInstallation;
  readonly previous?: ManagedAdapterInstallation;
  readonly phase: 'idle' | 'downloading' | 'verifying' | 'installing' | 'activating' | 'failed';
  readonly error?: string;
  readonly supportsMcp?: boolean;
}

interface OwnedAdapterFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface IManagedAdapterService {
  readonly _serviceBrand: undefined;
  list(): Promise<readonly ManagedAdapterStatus[]>;
  status(id: string): Promise<ManagedAdapterStatus>;
  installable(id: string): Promise<boolean>;
  install(id: string): Promise<ManagedAdapterStatus>;
  rollback(id: string): Promise<ManagedAdapterStatus>;
}

export const IManagedAdapterService: ServiceIdentifier<IManagedAdapterService> =
  createDecorator<IManagedAdapterService>('managedAdapterService');

export class ManagedAdapterService implements IManagedAdapterService {
  declare readonly _serviceBrand: undefined;
  private readonly progress = new Map<string, Pick<ManagedAdapterStatus, 'phase' | 'error'>>();
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostProcessService private readonly processService: IHostProcessService,
    @IAtomicTomlDocumentStore private readonly documents: IAtomicTomlDocumentStore,
    @IAgentExecutorRegistry private readonly registry?: IAgentExecutorRegistry,
  ) {}

  list(): Promise<readonly ManagedAdapterStatus[]> {
    const ids = [...Object.keys(MANAGED_ADAPTER_RELEASES)];
    for (const descriptor of this.registry?.list() ?? []) {
      if (!ids.includes(descriptor.id) && sourceOwnedAdapterScript(descriptor) !== undefined) ids.push(descriptor.id);
    }
    return Promise.all(ids.map((id) => this.status(id)));
  }

  async status(id: string): Promise<ManagedAdapterStatus> {
    if (Object.hasOwn(MANAGED_ADAPTER_RELEASES, id)) {
      const release = MANAGED_ADAPTER_RELEASES[id]!;
      const state = await this.documents.get<ManagedAdapterState>(MANAGED_ADAPTER_SCOPE, id);
      return { id, release, active: state?.active, previous: state?.previous,
        ...this.progress.get(id) ?? { phase: 'idle' as const } };
    }
    return this.sourceOwnedStatus(id);
  }

  async installable(id: string): Promise<boolean> {
    if (Object.hasOwn(MANAGED_ADAPTER_RELEASES, id)) return true;
    const descriptor = this.descriptorFor(id);
    if (descriptor !== undefined && sourceOwnedAdapterScript(descriptor) !== undefined) return true;
    const state = await this.documents.get<ManagedAdapterState>(MANAGED_ADAPTER_SCOPE, id);
    return state?.active?.targetDir !== undefined;
  }

  install(id: string): Promise<ManagedAdapterStatus> {
    if (!Object.hasOwn(MANAGED_ADAPTER_RELEASES, id)) return this.serialize(id, () => this.installSourceOwned(id));
    const release = releaseFor(id);
    return this.serialize(id, async () => {
      const previous = await this.documents.get<ManagedAdapterState>(MANAGED_ADAPTER_SCOPE, id);
      if (previous?.active.version === release.version && previous.active.integrity === release.integrity) {
        return this.status(id);
      }
      const installId = randomUUID();
      const installation: ManagedAdapterInstallation = {
        version: release.version, integrity: release.integrity, source: release.source, installId,
      };
      const root = join(this.bootstrap.homeDir, 'tools', 'managed-executors', id, `${release.version}-${installId}`);
      const downloadDir = join(this.bootstrap.homeDir, '.tmp', 'managed-executors', id, installId);
      try {
        this.progress.set(id, { phase: 'downloading' });
        await this.fs.mkdir(downloadDir, { recursive: true });
        const filename = (await this.npm(['pack', release.source, '--pack-destination', downloadDir])).trim();
        if (!/^[a-zA-Z0-9._-]+\.tgz$/.test(filename)) {
          throw new Error2(ErrorCodes.CONFIG_INVALID, `npm returned an invalid archive filename for "${id}"`);
        }
        const archive = join(downloadDir, filename);
        this.progress.set(id, { phase: 'verifying' });
        const size = (await this.fs.stat(archive)).size;
        if (size <= 0 || size > MAX_ARCHIVE_BYTES) {
          throw new Error2(ErrorCodes.CONFIG_INVALID, `Adapter archive for "${id}" exceeds the download limit`);
        }
        const bytes = await this.fs.readBytes(archive);
        if (bytes.length !== size || `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== release.integrity) {
          throw new Error2(ErrorCodes.CONFIG_INVALID, `Adapter archive checksum mismatch for "${id}"`);
        }
        this.progress.set(id, { phase: 'installing' });
        await this.fs.mkdir(root, { recursive: true });
        await this.npm(['install', '--prefix', root, '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', archive]);
        const entry = managedAdapterEntry(id, this.bootstrap.homeDir, installation)!;
        if (!(await this.fs.stat(entry)).isFile) {
          throw new Error2(ErrorCodes.CONFIG_INVALID, `Managed adapter "${id}" has no executable entry`);
        }
        const pkg = JSON.parse(await this.fs.readText(join(root, 'node_modules', release.packageName, 'package.json'))) as {
          name?: unknown; version?: unknown;
        };
        if (pkg.name !== release.packageName || pkg.version !== release.version) {
          throw new Error2(ErrorCodes.CONFIG_INVALID, `Managed adapter "${id}" installed a different package`);
        }
        this.progress.set(id, { phase: 'activating' });
        await this.documents.update<ManagedAdapterState>(MANAGED_ADAPTER_SCOPE, id,
          (current) => current?.active === undefined
            ? { active: installation }
            : { active: installation, previous: current.active });
        this.progress.delete(id);
      } catch (error) {
        this.progress.set(id, { phase: 'failed', error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      return this.status(id);
    });
  }

  rollback(id: string): Promise<ManagedAdapterStatus> {
    return this.serialize(id, async () => {
      if (!await this.installable(id)) releaseFor(id);
      const current = await this.documents.get<ManagedAdapterState>(MANAGED_ADAPTER_SCOPE, id);
      if (current?.previous === undefined || current.active === undefined) {
        throw new Error2(ErrorCodes.CONFIG_INVALID, `No previous managed adapter installation for "${id}"`);
      }
      const moved = current.previous.targetDir !== undefined;
      if (moved) {
        try {
          await this.restoreOwned(id, current.previous);
        } catch (error) {
          await this.restoreRecordedFiles(id, current.active);
          throw error;
        }
      }
      let updated: ManagedAdapterState | undefined;
      try {
        updated = await this.documents.update<ManagedAdapterState>(MANAGED_ADAPTER_SCOPE, id, (state) => {
          if (state?.previous === undefined || state.active === undefined) return state;
          return { active: state.previous, previous: state.active };
        });
      } catch (error) {
        if (moved) await this.restoreRecordedFiles(id, current.active);
        throw error;
      }
      if (updated?.active === undefined || updated.previous === undefined) {
        if (moved) await this.restoreRecordedFiles(id, current.active);
        throw new Error2(ErrorCodes.CONFIG_INVALID, `No previous managed adapter installation for "${id}"`);
      }
      this.progress.delete(id);
      return this.status(id);
    });
  }

  private async sourceOwnedStatus(id: string): Promise<ManagedAdapterStatus> {
    const descriptor = this.descriptorFor(id);
    const selected = descriptor === undefined ? undefined : this.absoluteOwnedScript(sourceOwnedAdapterScript(descriptor));
    const state = await this.documents.get<ManagedAdapterState>(MANAGED_ADAPTER_SCOPE, id);
    if (selected === undefined && state?.active.targetDir === undefined &&
        (descriptor === undefined || sourceOwnedAdapterScript(descriptor) === undefined)) {
      releaseFor(id);
    }
    const bundle = await this.readOwnedBundle(false);
    const release = ownedRelease(bundle);
    const targetDir = selected === undefined ? state?.active.targetDir : dirname(selected);
    const supportsMcp = bundle !== undefined && targetDir !== undefined &&
      await this.productionMatches(targetDir, bundle);
    return { id, release, active: state?.active, previous: state?.previous, supportsMcp,
      ...this.progress.get(id) ?? { phase: 'idle' as const } };
  }

  private async installSourceOwned(id: string): Promise<ManagedAdapterStatus> {
    const targetDir = this.ownedTargetDir(id);
    try {
      const bundle = await this.readOwnedBundle(true);
      if (bundle === undefined) {
        throw new Error2(ErrorCodes.CONFIG_INVALID, 'Source-owned adapter resources are unavailable');
      }
      const integrity = ownedIntegrity(bundle);
      const recorded = await this.documents.get<ManagedAdapterState>(MANAGED_ADAPTER_SCOPE, id);
      const existing = await this.readProduction(targetDir);
      const matches = sameProduction(existing, bundle);
      if (matches && recorded?.active.version === SOURCE_OWNED_ADAPTER_VERSION && recorded.active.integrity === integrity) {
        return this.status(id);
      }
      const installId = randomUUID();
      const installation: ManagedAdapterInstallation = {
        version: SOURCE_OWNED_ADAPTER_VERSION, integrity, source: SOURCE_OWNED_ADAPTER_SOURCE, installId, targetDir,
      };
      this.progress.set(id, { phase: 'installing' });
      const previous = await this.snapshotPrevious(id, targetDir, existing, matches, integrity, recorded?.active);
      await this.writeSnapshot(this.snapshotDir(id, installation), bundle);
      if (!matches) await this.replaceProduction(targetDir, existing, bundle);
      this.progress.set(id, { phase: 'activating' });
      try {
        await this.documents.update<ManagedAdapterState>(MANAGED_ADAPTER_SCOPE, id, (current) =>
          previous !== undefined ? { active: installation, previous }
            : current?.active === undefined ? { active: installation }
              : { active: installation, previous: current.active });
      } catch (error) {
        if (!matches) await this.restoreProductionFiles(targetDir, existing, SOURCE_OWNED_ADAPTER_FILES);
        throw error;
      }
      this.progress.delete(id);
    } catch (error) {
      this.progress.set(id, { phase: 'failed', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    return this.status(id);
  }

  private descriptorFor(id: string): AgentExecutorDescriptor | undefined {
    if (this.registry === undefined) return undefined;
    try {
      const descriptor = this.registry.get(id);
      return descriptor?.id === id ? descriptor : undefined;
    } catch {
      return undefined;
    }
  }

  private ownedTargetDir(id: string): string {
    const raw = this.descriptorFor(id);
    const script = raw === undefined ? undefined : sourceOwnedAdapterScript(raw);
    if (script === undefined) throw new Error2(ErrorCodes.CONFIG_INVALID, `Unknown managed adapter "${id}"`);
    const expanded = expandSourceOwnedAdapterPath(script, this.bootstrap);
    if (!isAbsolute(expanded) || basename(expanded) !== SOURCE_OWNED_ADAPTER_ENTRY) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, 'Source-owned adapter path must be absolute');
    }
    return dirname(expanded);
  }

  private absoluteOwnedScript(script: string | undefined): string | undefined {
    if (script === undefined) return undefined;
    const expanded = expandSourceOwnedAdapterPath(script, this.bootstrap);
    return isAbsolute(expanded) && basename(expanded) === SOURCE_OWNED_ADAPTER_ENTRY ? expanded : undefined;
  }

  private async snapshotPrevious(
    id: string,
    targetDir: string,
    existing: ReadonlyMap<string, Uint8Array>,
    matches: boolean,
    integrity: string,
    active: ManagedAdapterInstallation | undefined,
  ): Promise<ManagedAdapterInstallation | undefined> {
    if (!matches && existing.size > 0) {
      const files = SOURCE_OWNED_ADAPTER_FILES.flatMap((name) => {
        const bytes = existing.get(name);
        return bytes === undefined ? [] : [{ name, bytes }];
      });
      const installation: ManagedAdapterInstallation = {
        version: '0.0.0', integrity: ownedIntegrity(files), source: 'snapshot:local-adapter',
        installId: randomUUID(), targetDir,
      };
      await this.writeSnapshot(this.snapshotDir(id, installation), files);
      return installation;
    }
    if (matches && active !== undefined && active.integrity !== integrity) {
      return { ...active, targetDir: active.targetDir ?? targetDir };
    }
    return undefined;
  }

  private snapshotDir(id: string, installation: ManagedAdapterInstallation): string {
    return join(this.bootstrap.homeDir, 'tools', 'managed-executors', id,
      `${installation.version}-${installation.installId}`);
  }

  private async writeSnapshot(dir: string, files: readonly OwnedAdapterFile[]): Promise<void> {
    await this.fs.mkdir(dir, { recursive: true });
    for (const file of files) await this.fs.writeBytes(join(dir, file.name), file.bytes);
  }

  private async replaceProduction(
    targetDir: string,
    before: ReadonlyMap<string, Uint8Array>,
    files: readonly OwnedAdapterFile[],
  ): Promise<void> {
    await this.fs.mkdir(targetDir, { recursive: true });
    const attempted: string[] = [];
    try {
      for (const file of writeOrder(files)) {
        attempted.push(file.name);
        await this.fs.writeBytes(join(targetDir, file.name), file.bytes);
      }
    } catch (error) {
      await this.restoreProductionFiles(targetDir, before, attempted);
      throw error;
    }
  }

  private async restoreRecordedFiles(id: string, installation: ManagedAdapterInstallation): Promise<void> {
    if (installation.targetDir === undefined) return;
    try {
      await this.restoreOwned(id, installation);
    } catch (error) {
      throw new Error2(ErrorCodes.CONFIG_INVALID,
        `Source-owned adapter restore failed after the installation record update failed: ${errorText(error)}`,
        { cause: error });
    }
  }

  private async restoreProductionFiles(
    targetDir: string,
    before: ReadonlyMap<string, Uint8Array>,
    names: readonly string[],
  ): Promise<void> {
    try {
      await this.restoreProduction(targetDir, before, names);
    } catch (error) {
      throw new Error2(ErrorCodes.CONFIG_INVALID,
        `Source-owned adapter restore failed after a partial write: ${errorText(error)}`,
        { cause: error });
    }
  }

  private async restoreProduction(
    targetDir: string,
    before: ReadonlyMap<string, Uint8Array>,
    names: readonly string[] = [...before.keys()],
  ): Promise<void> {
    for (const name of names) {
      const old = before.get(name);
      if (old === undefined) await this.fs.remove(join(targetDir, name));
      else await this.fs.writeBytes(join(targetDir, name), old);
    }
  }

  private async restoreOwned(id: string, installation: ManagedAdapterInstallation): Promise<void> {
    const targetDir = installation.targetDir;
    if (targetDir === undefined) return;
    const root = this.snapshotDir(id, installation);
    let stat: { isDirectory: boolean };
    try {
      stat = await this.fs.stat(root);
    } catch (error) {
      if (!absentOwnedFile(error)) throw error;
      throw new Error2(ErrorCodes.CONFIG_INVALID, 'Source-owned adapter snapshot is unavailable');
    }
    if (!stat.isDirectory) throw new Error2(ErrorCodes.CONFIG_INVALID, 'Source-owned adapter snapshot is unavailable');
    const files: OwnedAdapterFile[] = [];
    for (const name of SOURCE_OWNED_ADAPTER_FILES) {
      try {
        files.push({ name, bytes: await this.fs.readBytes(join(root, name)) });
      } catch (error) {
        if (!absentOwnedFile(error)) throw error;
      }
    }
    if (files.length === 0) throw new Error2(ErrorCodes.CONFIG_INVALID, 'Source-owned adapter snapshot is unavailable');
    await this.fs.mkdir(targetDir, { recursive: true });
    for (const file of files) await this.fs.writeBytes(join(targetDir, file.name), file.bytes);
    for (const name of SOURCE_OWNED_ADAPTER_FILES) {
      if (!files.some((file) => file.name === name)) await this.fs.remove(join(targetDir, name));
    }
  }

  private async readProduction(dir: string): Promise<Map<string, Uint8Array>> {
    const found = new Map<string, Uint8Array>();
    for (const name of SOURCE_OWNED_ADAPTER_FILES) {
      try {
        found.set(name, await this.fs.readBytes(join(dir, name)));
      } catch (error) {
        if (!absentOwnedFile(error)) throw error;
      }
    }
    return found;
  }

  private async productionMatches(dir: string, files: readonly OwnedAdapterFile[]): Promise<boolean> {
    return sameProduction(await this.readProduction(dir), files);
  }

  private async readOwnedBundle(required: boolean): Promise<readonly OwnedAdapterFile[] | undefined> {
    try {
      const root = await this.ownedBundleRoot();
      const files: OwnedAdapterFile[] = [];
      for (const name of SOURCE_OWNED_ADAPTER_FILES) files.push({ name, bytes: await this.fs.readBytes(join(root, name)) });
      return files;
    } catch (error) {
      if (!required) return undefined;
      if (error instanceof Error2) throw error;
      throw new Error2(ErrorCodes.CONFIG_INVALID, 'Source-owned adapter resources are unavailable');
    }
  }

  private async ownedBundleRoot(): Promise<string> {
    const configured = this.bootstrap.getEnv(SOURCE_OWNED_ADAPTER_ROOT_ENV)?.trim();
    if (configured !== undefined && configured.length > 0) {
      if (await this.hasOwnedBundle(configured)) return configured;
      throw new Error2(ErrorCodes.CONFIG_INVALID, 'Source-owned adapter resources are unavailable');
    }
    let current = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = join(current, 'scripts', 'external-harness');
      if (await this.hasOwnedBundle(candidate)) return candidate;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    const beside = join(dirname(fileURLToPath(import.meta.url)), 'external-harness');
    if (await this.hasOwnedBundle(beside)) return beside;
    throw new Error2(ErrorCodes.CONFIG_INVALID, 'Source-owned adapter resources are unavailable');
  }

  private async hasOwnedBundle(root: string): Promise<boolean> {
    for (const name of SOURCE_OWNED_ADAPTER_FILES) {
      try {
        if (!(await this.fs.stat(join(root, name))).isFile) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  private serialize<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(action);
    this.tails.set(id, work);
    void work.finally(() => {
      if (this.tails.get(id) === work) this.tails.delete(id);
    }).catch(() => undefined);
    return work;
  }

  private async npm(args: readonly string[]): Promise<string> {
    const npm = await locateCommand('npm', this.fs, this.bootstrap);
    if (npm === undefined) throw new Error2(ErrorCodes.CONFIG_INVALID, 'npm is required to install managed adapters');
    const launch = await resolveWindowsNodeShim(npm, args, this.fs, this.bootstrap);
    if (this.bootstrap.platform === 'win32' && /\.(?:cmd|bat)$/i.test(npm)) {
      const entry = launch.args[0];
      if (entry === undefined || !/[\\/]node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js$/i.test(entry) ||
          !(await this.fs.stat(entry)).isFile) {
        throw new Error2(ErrorCodes.CONFIG_INVALID, `Cannot locate npm's Node entry from "${npm}"`);
      }
    }
    const child = await this.processService.spawn(launch.command, launch.args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const drain = (stream: typeof child.stdout, collect: (chunk: Buffer | string) => void): Promise<void> =>
      new Promise((resolve, reject) => {
        stream.on('data', collect);
        stream.once('end', resolve);
        stream.once('error', reject);
      });
    const stdoutDone = drain(child.stdout, (chunk) => { stdout = (stdout + chunk.toString()).slice(-8192); });
    const stderrDone = drain(child.stderr, (chunk) => { stderr = (stderr + chunk.toString()).slice(-8192); });
    let timer: NodeJS.Timeout | undefined;
    try {
      const code = await Promise.race([
        Promise.all([child.wait(), stdoutDone, stderrDone]).then(([exitCode]) => exitCode),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Managed adapter npm operation timed out')), INSTALL_TIMEOUT_MS);
        }),
      ]);
      if (code !== 0) throw new Error(`npm exited with code ${code}: ${stderr.slice(-2048)}`);
      return stdout;
    } catch (error) {
      await child.kill().catch(() => undefined);
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await child.dispose();
    }
  }
}

function absentOwnedFile(error: unknown): boolean {
  return isError2(error) && error.code === ErrorCodes.OS_FS_NOT_FOUND;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ownedRelease(files: readonly OwnedAdapterFile[] | undefined): ManagedAdapterRelease {
  return {
    packageName: SOURCE_OWNED_ADAPTER_PACKAGE,
    version: SOURCE_OWNED_ADAPTER_VERSION,
    integrity: files === undefined ? 'unavailable' : ownedIntegrity(files),
    source: SOURCE_OWNED_ADAPTER_SOURCE,
    entry: SOURCE_OWNED_ADAPTER_ENTRY,
  };
}

function ownedIntegrity(files: readonly OwnedAdapterFile[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    hash.update(file.name);
    hash.update('\0');
    hash.update(file.bytes);
    hash.update('\0');
  }
  return `sha256-${hash.digest('hex')}`;
}

function sameProduction(existing: ReadonlyMap<string, Uint8Array>, files: readonly OwnedAdapterFile[]): boolean {
  return files.every((file) => sameBytes(existing.get(file.name), file.bytes)) &&
    SOURCE_OWNED_ADAPTER_FILES.every((name) => files.some((file) => file.name === name));
}

function sameBytes(left: Uint8Array | undefined, right: Uint8Array): boolean {
  if (left === undefined || left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function writeOrder(files: readonly OwnedAdapterFile[]): readonly OwnedAdapterFile[] {
  return [...files].sort((left, right) => {
    if (left.name === SOURCE_OWNED_ADAPTER_ENTRY) return 1;
    if (right.name === SOURCE_OWNED_ADAPTER_ENTRY) return -1;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
}

function releaseFor(id: string): ManagedAdapterRelease {
  const release = Object.hasOwn(MANAGED_ADAPTER_RELEASES, id) ? MANAGED_ADAPTER_RELEASES[id] : undefined;
  if (release === undefined) throw new Error2(ErrorCodes.CONFIG_INVALID, `Unknown managed adapter "${id}"`);
  return release;
}

registerScopedService(LifecycleScope.App, IManagedAdapterService, ManagedAdapterService,
  ScopeActivation.OnScopeCreated, 'managedAdapter');
