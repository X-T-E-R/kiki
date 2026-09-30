/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { randomUUID } from 'node:crypto';
import { AcpLoginHelper, rebuildLoopbackRedirect } from '@kiki/acp-client';
import { join } from 'pathe';
import { rcompare, valid } from 'semver';

import { createDecorator } from '#/_base/di/instantiation';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventService } from '#/app/event/event';
import { Event2 } from '#/app/event/event2';
import { LifecycleScope } from '#/app/scopes';
import { Error2, ErrorCodes } from '#/errors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { installBinaryArchive, type BinaryArchiveProgress } from '#/os/backends/node-local/binaryArchive';
import { antigravityAuthSettings, type AntigravityAuthMethod } from '#/os/backends/node-local/antigravitySettings';

import { IAgentExecutorRegistry } from './agentExecutor';
import { ANTIGRAVITY_VERSION, antigravityCacheRoot, antigravityRelease, type AntigravityRelease } from './antigravityDistribution';
import { antigravityProcessService, antigravitySettingsHome } from './antigravityProcess';
import { executorLaunchArgs, executorProcessEnv } from './executorOverrides';

export const ANTIGRAVITY_CACHE_SCOPE = 'managed-binaries';
export interface AntigravityCacheState { readonly activeVersion: string }
export interface AntigravityStatus {
  readonly release: AntigravityRelease;
  readonly versions: readonly string[];
  readonly activeVersion?: string;
  readonly phase: 'idle' | 'installing' | 'failed';
  readonly error?: string;
}
/**
 * One step of an Antigravity ACP CLI install, published on the global event
 * bus in order: `download` (repeated, with byte counts), `extract`, `activate`,
 * then exactly one terminal `done` or `failed`.
 */
export type AntigravityInstallProgress = { readonly installId: string; readonly version: string } & (
  | BinaryArchiveProgress
  | { readonly stage: 'activate' }
  | { readonly stage: 'done' }
  | { readonly stage: 'failed'; readonly error: string; readonly timedOut: boolean }
);

/** Global bus fact carrying {@link AntigravityInstallProgress}. */
export class AntigravityInstallProgressed extends Event2<{ readonly payload: AntigravityInstallProgress }> {
  static override readonly type = 'event.executor.antigravity_install_progress';
  static override readonly schema = undefined;
}
export interface AntigravityInstallProgressed {
  readonly payload: AntigravityInstallProgress;
}

/** How long the archive download may take before the install fails as timed out. */
export const ANTIGRAVITY_INSTALL_TIMEOUT_MS = 10 * 60_000;

export type AntigravityLoginStart = { readonly alreadySignedIn: true } | {
  readonly alreadySignedIn: false;
  readonly handle: string;
  readonly authUrl: string;
  readonly redirectUri: string;
  readonly methodId: AntigravityAuthMethod;
  readonly expiresInSecs: number;
};
export interface AntigravityLoginOutcome { readonly signedIn: boolean; readonly retryable: boolean; readonly message?: string }
export interface IAntigravityService {
  readonly _serviceBrand: undefined;
  status(): Promise<AntigravityStatus>;
  install(version?: string): Promise<AntigravityStatus>;
  activate(version: string): Promise<AntigravityStatus>;
  beginLogin(method: AntigravityAuthMethod): Promise<AntigravityLoginStart>;
  completeLogin(handle: string, redirectUrl: string): Promise<AntigravityLoginOutcome>;
  cancelLogin(handle: string): Promise<void>;
  logout(): Promise<void>;
}
export const IAntigravityService = createDecorator<IAntigravityService>('antigravityService');

export class AntigravityService implements IAntigravityService {
  declare readonly _serviceBrand: undefined;
  private installing: Promise<AntigravityStatus> | undefined;
  private failure: string | undefined;
  private loginBusy = false;
  private closed = false;
  private activeLogin: AcpLoginHelper | undefined;
  private pending: { readonly handle: string; readonly helper: AcpLoginHelper; readonly authUrl: string; readonly expiresAt: number; readonly timer: NodeJS.Timeout } | undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostProcessService private readonly processes: IHostProcessService,
    @IAtomicTomlDocumentStore private readonly documents: IAtomicTomlDocumentStore,
    @IAgentExecutorRegistry private readonly executors: IAgentExecutorRegistry,
    @IEventService private readonly events?: IEventService,
  ) {}

  private publish(progress: AntigravityInstallProgress): void {
    this.events?.publish(new AntigravityInstallProgressed({ payload: progress }));
  }

  async status(): Promise<AntigravityStatus> {
    const release = antigravityRelease(ANTIGRAVITY_VERSION, this.bootstrap.platform, this.bootstrap.arch);
    const root = antigravityCacheRoot(this.bootstrap.homeDir);
    const directories = await this.fs.readdir(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return [];
    });
    const versions: string[] = [];
    for (const directory of directories) {
      if (!directory.isDirectory || valid(directory.name) === null || !directory.name.startsWith('1.')) continue;
      if (await this.complete(directory.name)) versions.push(directory.name);
    }
    versions.sort(rcompare);
    const state = await this.documents.get<AntigravityCacheState>(ANTIGRAVITY_CACHE_SCOPE, 'antigravity-acp');
    return { release, versions, activeVersion: state?.activeVersion ?? versions[0],
      phase: this.installing !== undefined ? 'installing' : this.failure !== undefined ? 'failed' : 'idle', error: this.failure };
  }

  install(version = ANTIGRAVITY_VERSION): Promise<AntigravityStatus> {
    if (this.installing !== undefined) throw invalid('An Antigravity installation is already running');
    const release = antigravityRelease(version, this.bootstrap.platform, this.bootstrap.arch);
    const installId = randomUUID();
    const tag = { installId, version: release.version };
    const work = (async () => {
      try {
        this.failure = undefined;
        if (!await this.complete(release.version)) {
          const directory = this.directory(release.version);
          await this.fs.remove(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
          await installBinaryArchive({ url: release.url, directory, entry: release.entry, requiredSibling: release.requiredSibling,
            timeoutMs: ANTIGRAVITY_INSTALL_TIMEOUT_MS, onProgress: (progress) => { this.publish({ ...tag, ...progress }); } });
        }
        this.publish({ ...tag, stage: 'activate' });
        await this.documents.set(ANTIGRAVITY_CACHE_SCOPE, 'antigravity-acp', { activeVersion: release.version });
      } catch (error) {
        this.failure = error instanceof Error ? error.message : String(error);
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || (error.cause as { name?: string } | undefined)?.name === 'TimeoutError');
        this.publish({ ...tag, stage: 'failed', error: this.failure, timedOut });
        throw error;
      } finally { this.installing = undefined; }
      this.publish({ ...tag, stage: 'done' });
      return this.status();
    })();
    this.installing = work;
    return work;
  }

  async activate(version: string): Promise<AntigravityStatus> {
    const release = antigravityRelease(version, this.bootstrap.platform, this.bootstrap.arch);
    if (this.installing !== undefined || !await this.complete(release.version)) throw invalid('A complete cached Antigravity version is required');
    await this.documents.set(ANTIGRAVITY_CACHE_SCOPE, 'antigravity-acp', { activeVersion: release.version });
    return this.status();
  }

  async beginLogin(method: AntigravityAuthMethod): Promise<AntigravityLoginStart> {
    if (this.loginBusy || this.pending !== undefined) throw invalid('An Antigravity sign-in is already pending');
    this.loginBusy = true;
    let helper: AcpLoginHelper | undefined;
    try {
      helper = await this.loginHelper(method);
      const result = await helper.start(method);
      this.requireOpen();
      if (result.alreadySignedIn) { await helper.close(); return result; }
      const handle = randomUUID();
      const owned = helper;
      const timer = setTimeout(() => { void this.cancelLogin(handle).catch(() => {}); }, 300_000);
      timer.unref();
      this.pending = { handle, helper: owned, authUrl: result.authUrl, expiresAt: Date.now() + 300_000, timer };
      return { ...result, handle, methodId: method, expiresInSecs: 300 };
    } catch (error) { await helper?.close(); throw error; }
    finally { this.loginBusy = false; }
  }

  async completeLogin(handle: string, redirectUrl: string): Promise<AntigravityLoginOutcome> {
    const pending = this.requirePending(handle);
    if (this.loginBusy) throw invalid('Antigravity sign-in is busy');
    try { rebuildLoopbackRedirect(pending.authUrl, redirectUrl); }
    catch { return { signedIn: false, retryable: true, message: 'The callback does not match this pending sign-in.' }; }
    this.loginBusy = true;
    clearTimeout(pending.timer);
    try {
      await pending.helper.finish(pending.authUrl, redirectUrl);
      return { signedIn: true, retryable: false };
    } catch { return { signedIn: false, retryable: false, message: 'Antigravity sign-in failed; start a new sign-in.' }; }
    finally { this.pending = undefined; await pending.helper.close(); this.loginBusy = false; }
  }

  async cancelLogin(handle: string): Promise<void> {
    const pending = this.requirePending(handle, false);
    this.pending = undefined;
    clearTimeout(pending.timer);
    await pending.helper.close();
  }

  async logout(): Promise<void> {
    if (this.loginBusy || this.pending !== undefined) throw invalid('Cancel the pending sign-in before signing out');
    this.loginBusy = true;
    let helper: AcpLoginHelper | undefined;
    try { helper = await this.loginHelper(); await helper.logout(); }
    finally { await helper?.close(); this.loginBusy = false; }
  }

  private requirePending(handle: string, checkExpiry = true): NonNullable<AntigravityService['pending']> {
    const pending = this.pending;
    if (pending === undefined || pending.handle !== handle || (checkExpiry && pending.expiresAt <= Date.now())) throw invalid('Antigravity sign-in handle is invalid or expired');
    return pending;
  }

  private async loginHelper(method?: AntigravityAuthMethod): Promise<AcpLoginHelper> {
    this.requireOpen();
    const { descriptor } = await this.executors.resolveExecutable('antigravity-acp');
    this.requireOpen();
    const env = executorProcessEnv(descriptor);
    await antigravityAuthSettings(antigravitySettingsHome(env, this.bootstrap), method);
    this.requireOpen();
    const helper = new AcpLoginHelper(antigravityProcessService(this.processes, descriptor, this.bootstrap), {
      command: descriptor.command!, args: executorLaunchArgs(descriptor, [...descriptor.launchArgs ?? [], ...descriptor.args]), env,
    });
    this.activeLogin = helper;
    return helper;
  }

  private requireOpen(): void {
    if (this.closed) throw invalid('Antigravity service is closed');
  }

  private directory(version: string): string {
    return join(antigravityCacheRoot(this.bootstrap.homeDir), version, `${this.bootstrap.platform}-${this.bootstrap.arch}`);
  }

  private async complete(version: string): Promise<boolean> {
    const release = antigravityRelease(version, this.bootstrap.platform, this.bootstrap.arch);
    return (await Promise.all([release.entry, release.requiredSibling].map((name) =>
      this.fs.stat(join(this.directory(release.version), name)).then((value) => value.isFile, () => false)))).every(Boolean);
  }

  async dispose(): Promise<void> {
    this.closed = true;
    const pending = this.pending;
    const active = this.activeLogin;
    this.pending = undefined;
    this.activeLogin = undefined;
    if (pending !== undefined) clearTimeout(pending.timer);
    await active?.close();
    if (pending !== undefined && pending.helper !== active) await pending.helper.close();
    await this.installing?.catch(() => undefined);
  }
}

function invalid(message: string): Error2 { return new Error2(ErrorCodes.REQUEST_INVALID, message); }

registerScopedService(LifecycleScope.App, IAntigravityService, AntigravityService, ScopeActivation.OnDemand, 'antigravity');
