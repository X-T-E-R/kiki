import { createHash, randomUUID } from 'node:crypto';
import { join } from 'pathe';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { LifecycleScope } from '#/app/scopes';
import { Error2, ErrorCodes } from '#/errors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';

import { locateCommand } from './binaryDiscovery';
import {
  MANAGED_ADAPTER_RELEASES,
  MANAGED_ADAPTER_SCOPE,
  managedAdapterEntry,
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
}

export interface IManagedAdapterService {
  readonly _serviceBrand: undefined;
  list(): Promise<readonly ManagedAdapterStatus[]>;
  status(id: string): Promise<ManagedAdapterStatus>;
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
  ) {}

  list(): Promise<readonly ManagedAdapterStatus[]> {
    return Promise.all(Object.keys(MANAGED_ADAPTER_RELEASES).map((id) => this.status(id)));
  }

  async status(id: string): Promise<ManagedAdapterStatus> {
    const release = releaseFor(id);
    const state = await this.documents.get<ManagedAdapterState>(MANAGED_ADAPTER_SCOPE, id);
    return { id, release, active: state?.active, previous: state?.previous,
      ...this.progress.get(id) ?? { phase: 'idle' as const } };
  }

  install(id: string): Promise<ManagedAdapterStatus> {
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
    releaseFor(id);
    return this.serialize(id, async () => {
      const updated = await this.documents.update<ManagedAdapterState>(MANAGED_ADAPTER_SCOPE, id, (current) => {
        if (current?.previous === undefined) return current;
        return { active: current.previous, previous: current.active };
      });
      if (updated?.active === undefined || updated.previous === undefined) {
        throw new Error2(ErrorCodes.CONFIG_INVALID, `No previous managed adapter installation for "${id}"`);
      }
      this.progress.delete(id);
      return this.status(id);
    });
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

function releaseFor(id: string): ManagedAdapterRelease {
  const release = Object.hasOwn(MANAGED_ADAPTER_RELEASES, id) ? MANAGED_ADAPTER_RELEASES[id] : undefined;
  if (release === undefined) throw new Error2(ErrorCodes.CONFIG_INVALID, `Unknown managed adapter "${id}"`);
  return release;
}

registerScopedService(LifecycleScope.App, IManagedAdapterService, ManagedAdapterService,
  ScopeActivation.OnScopeCreated, 'managedAdapter');
