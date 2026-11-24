/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { randomUUID } from 'node:crypto';
import { AcpLoginHelper, rebuildLoopbackRedirect, type HostProcessLike } from '@kiki/acp-client';
import type { HarnessQuotaReading } from '@kiki/plugin-sdk';
import { join, normalize } from 'pathe';
import { gte, lt, rcompare, valid } from 'semver';

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
import {
  createAntigravityProbeWorkspace,
  detectLinuxMusl,
  inspectOfficialReleaseDirectory,
  installOfficialAntigravityBinary,
  listInstalledOfficialVersions,
  pruneUnusedOfficialVersions,
  readAntigravityLocalCredentials,
  readAntigravityProfileCache,
  removeDirectoryForce,
  restoreAntigravityAuthConfig,
  scrubAntigravityProbeSession,
  scrubAntigravityProfileAuth,
  snapshotAntigravityAuthConfig,
  syncAntigravityUserConfig,
  writeAntigravityProfileCache,
  writeAntigravityProfileSecrets,
  type AntigravityCachedModel,
  type AntigravityProfileCache,
} from '#/os/backends/node-local/antigravityHostOps';
import {
  antigravityAuthSettings,
  antigravityCredentialEnvToRemove,
  type AntigravityAuthMethod,
} from '#/os/backends/node-local/antigravitySettings';

import { executorSourceId, IAgentExecutorRegistry, type AgentExecutorDescriptor } from './agentExecutor';
import {
  ANTIGRAVITY_CLI_MIN_VERSION,
  antigravityCacheRoot,
  antigravityOfficialFallbackRelease,
  antigravityOfficialVersionsRoot,
  antigravityRelease,
  fetchAntigravityCliManifest,
  type AntigravityRelease,
  type AntigravityReleaseLayout,
} from './antigravityDistribution';
import {
  acquireAntigravityBinaryLease,
  activeAntigravityLeasedDirectories,
  antigravityOfficialCliArgs,
  antigravityProcessService,
  antigravitySettingsHome,
  antigravitySshConnectionValue,
  isOfficialAntigravityCliCommand,
} from './antigravityProcess';
import {
  AntigravityQuotaCollector,
  antigravityQuotaToHarnessReadings,
  fetchGoogleUserInfo,
  type AntigravityQuotaResult,
} from './antigravityQuota';
import { executorEnvLookup, executorLaunchArgs, executorProcessEnv } from './executorOverrides';

export const ANTIGRAVITY_CACHE_SCOPE = 'managed-binaries';

export interface AntigravityCacheState {
  readonly activeVersion: string;
  readonly activeDirectory?: string;
  readonly layout?: AntigravityReleaseLayout;
}

export interface AntigravityProfileModelStatus {
  readonly id: string;
  readonly label?: string;
  readonly thinkingLevels?: readonly string[];
}

export interface AntigravityProfileStatus {
  readonly instanceId: string;
  readonly signedIn: boolean;
  readonly authMethod?: AntigravityAuthMethod;
  readonly accountLabel?: string;
  readonly gcpProject?: string;
  readonly gcpLocation?: string;
  readonly eligibility?: 'ready' | 'subscription_required' | 'unknown';
  readonly eligibilityMessage?: string;
  readonly tokenExpired?: boolean;
  readonly autoModeSupported?: boolean;
  readonly models?: readonly AntigravityProfileModelStatus[];
  readonly commands?: readonly string[];
  readonly checkedAt?: string;
}

export interface AntigravityStatus {
  readonly release: AntigravityRelease;
  readonly latestRelease?: {
    readonly version: string;
    readonly updateAvailable: boolean;
  };
  readonly versions: readonly string[];
  readonly activeVersion?: string;
  readonly phase: 'idle' | 'installing' | 'failed';
  readonly error?: string;
  readonly profile?: AntigravityProfileStatus;
}

export interface AntigravityStatusOptions {
  readonly instanceId?: string;
  readonly checkUpdates?: boolean;
  readonly refreshModels?: boolean;
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

export interface AntigravityLoginRequest {
  readonly methodId: AntigravityAuthMethod;
  readonly instanceId?: string;
  readonly gcpProject?: string;
  readonly gcpLocation?: string;
  readonly apiKey?: string;
  readonly force?: boolean;
}

export type AntigravityLoginFlowKind = 'code_paste' | 'loopback_url';

export type AntigravityLoginStart =
  | {
    readonly alreadySignedIn: true;
    readonly instanceId?: string;
    readonly profile?: AntigravityProfileStatus;
  }
  | {
    readonly alreadySignedIn: false;
    readonly handle: string;
    readonly authUrl: string;
    readonly redirectUri: string;
    readonly flowKind?: AntigravityLoginFlowKind;
    readonly methodId: AntigravityAuthMethod;
    readonly instanceId?: string;
    readonly expiresInSecs: number;
  };

/** Why a sign-in did not complete: mismatch, subscription gate, invalid config, or vendor rejection. */
export type AntigravityLoginMessageCode =
  | 'callback_mismatch'
  | 'signin_failed'
  | 'subscription_required'
  | 'configuration_invalid';

export interface AntigravityLoginOutcome {
  readonly signedIn: boolean;
  readonly retryable: boolean;
  readonly message?: string;
  readonly messageCode?: AntigravityLoginMessageCode;
  readonly profile?: AntigravityProfileStatus;
}

export interface IAntigravityService {
  readonly _serviceBrand: undefined;
  status(options?: AntigravityStatusOptions): Promise<AntigravityStatus>;
  install(version?: string, options?: { readonly instanceId?: string }): Promise<AntigravityStatus>;
  activate(version: string, options?: { readonly instanceId?: string }): Promise<AntigravityStatus>;
  beginLogin(request: AntigravityAuthMethod | AntigravityLoginRequest): Promise<AntigravityLoginStart>;
  completeLogin(handle: string, codeOrUrl: string, instanceId?: string): Promise<AntigravityLoginOutcome>;
  cancelLogin(handle: string, instanceId?: string): Promise<void>;
  logout(instanceId?: string): Promise<void>;
  probeProfile(instanceId?: string): Promise<AntigravityProfileStatus>;
  readProfileQuota(instanceId?: string, signal?: AbortSignal): Promise<AntigravityQuotaResult>;
  readAllInstanceQuotas(signal?: AbortSignal): Promise<readonly HarnessQuotaReading[]>;
}

export const IAntigravityService = createDecorator<IAntigravityService>('antigravityService');

const MANIFEST_CACHE_TTL_MS = 60 * 60_000;
const AUTH_EXPIRY_MS = 300_000;
const CODE_LOGIN_URL_TIMEOUT_MS = 30_000;
const CODE_LOGIN_FINISH_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 30_000;
const ANTIGRAVITY_CODE_REDIRECT_URI = 'https://antigravity.google/oauth-callback';
const MAX_AUTH_URL_LENGTH = 16_384;

export interface AntigravityCodeAuthUrl {
  readonly authorizationUrl: string;
  readonly redirectUri: string;
  readonly state: string;
}

export function parseAntigravityCodeAuthUrl(rawUrl: string): AntigravityCodeAuthUrl | undefined {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_AUTH_URL_LENGTH || /\s/.test(trimmed)) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  const state = url.searchParams.get('state');
  const redirectUri = url.searchParams.get('redirect_uri');
  if (
    url.origin !== 'https://accounts.google.com' ||
    (url.pathname !== '/o/oauth2/auth' && url.pathname !== '/o/oauth2/v2/auth') ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.searchParams.getAll('state').length !== 1 ||
    url.searchParams.getAll('redirect_uri').length !== 1 ||
    url.searchParams.getAll('response_type').length !== 1 ||
    url.searchParams.get('response_type') !== 'code' ||
    state === null ||
    state.length === 0 ||
    state.length > 512 ||
    /\s/.test(state) ||
    redirectUri !== ANTIGRAVITY_CODE_REDIRECT_URI
  ) {
    return undefined;
  }
  return { authorizationUrl: trimmed, redirectUri, state };
}

export function validateAntigravityLoginCodeResponse(
  pending: AntigravityCodeAuthUrl,
  response: string,
): string | undefined {
  const value = response.trim();
  if (/^[\w./~-]{1,2048}$/.test(value)) return value;
  if (value.length > MAX_AUTH_URL_LENGTH || /\s/.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    `${url.origin}${url.pathname}` !== pending.redirectUri ||
    url.username !== '' ||
    url.password !== '' ||
    url.searchParams.getAll('state').length !== 1 ||
    url.searchParams.get('state') !== pending.state ||
    url.searchParams.getAll('code').length !== 1 ||
    !url.searchParams.get('code')
  ) {
    return undefined;
  }
  return value;
}

interface PendingLoopbackLogin {
  readonly kind: 'loopback';
  readonly handle: string;
  readonly instanceId: string;
  readonly homeKey: string;
  readonly profileHome: string;
  readonly helper: AcpLoginHelper;
  readonly authUrl: string;
  readonly expiresAt: number;
  readonly timer: NodeJS.Timeout;
}

interface PendingCodeLogin {
  readonly kind: 'code';
  readonly handle: string;
  readonly instanceId: string;
  readonly homeKey: string;
  readonly profileHome: string;
  readonly tempHome: string;
  readonly child: HostProcessLike;
  readonly releaseLease: () => void;
  readonly parsedUrl: AntigravityCodeAuthUrl;
  readonly expiresAt: number;
  readonly timer: NodeJS.Timeout;
}

type PendingLogin = PendingLoopbackLogin | PendingCodeLogin;

export class AntigravityService implements IAntigravityService {
  declare readonly _serviceBrand: undefined;
  private installing: Promise<AntigravityStatus> | undefined;
  private failure: string | undefined;
  private closed = false;
  private cachedManifest: { readonly release: AntigravityRelease; readonly fetchedAt: number } | undefined;
  private readonly busyHomes = new Set<string>();
  private readonly pendingByHandle = new Map<string, PendingLogin>();
  private readonly pendingHandleByHome = new Map<string, string>();
  private readonly activeHelpers = new Set<AcpLoginHelper>();
  private readonly quota = new AntigravityQuotaCollector();

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

  async status(options: AntigravityStatusOptions = {}): Promise<AntigravityStatus> {
    const instanceId = options.instanceId ?? 'antigravity-acp';
    const musl = await this.detectMusl();
    let release = antigravityOfficialFallbackRelease(this.bootstrap.platform, this.bootstrap.arch, musl);
    let latestManifest: AntigravityRelease | undefined;

    if (options.checkUpdates === true) {
      latestManifest = await this.resolveLiveManifest(true, musl).catch(() => undefined);
    } else if (
      this.cachedManifest !== undefined &&
      Date.now() - this.cachedManifest.fetchedAt < MANIFEST_CACHE_TTL_MS
    ) {
      latestManifest = this.cachedManifest.release;
    }
    if (latestManifest !== undefined) {
      release = latestManifest;
    }

    const versionsRoot = antigravityOfficialVersionsRoot(this.bootstrap.homeDir);
    const officialInstalled = await listInstalledOfficialVersions(versionsRoot, this.bootstrap.platform, this.bootstrap.arch);
    const legacyVersions = await this.listLegacyInstalledVersions();
    const versionSet = new Set<string>([
      ...officialInstalled.map((item) => item.version),
      ...legacyVersions,
    ]);
    const versions = [...versionSet].toSorted(rcompare);
    const state = await this.documents.get<AntigravityCacheState>(ANTIGRAVITY_CACHE_SCOPE, 'antigravity-acp');
    if (state?.layout === 'official-cli' && state.activeDirectory !== undefined) {
      const matched = officialInstalled.find((item) =>
        item.directoryName === state.activeDirectory ||
        item.releaseId === state.activeDirectory ||
        item.version === state.activeVersion,
      );
      if (matched !== undefined && matched.directoryName !== state.activeDirectory) {
        await this.documents.set(ANTIGRAVITY_CACHE_SCOPE, 'antigravity-acp', {
          activeVersion: matched.version,
          activeDirectory: matched.directoryName,
          layout: 'official-cli',
        } satisfies AntigravityCacheState).catch(() => undefined);
      }
    }
    let activeVersion = state?.activeVersion !== undefined && versionSet.has(state.activeVersion)
      ? state.activeVersion
      : versions[0];
    if (activeVersion === undefined) {
      activeVersion = await this.resolveExternalVersion(instanceId);
    }

    const latestRelease = latestManifest === undefined
      ? undefined
      : {
        version: latestManifest.version,
        updateAvailable: activeVersion === undefined
          ? true
          : valid(activeVersion) !== null && valid(latestManifest.version) !== null
            ? lt(activeVersion, latestManifest.version)
            : activeVersion !== latestManifest.version,
      };

    const profile = options.refreshModels === true
      ? await this.probeProfile(instanceId).catch(() => this.readProfileStatus(instanceId))
      : await this.readProfileStatus(instanceId);

    return {
      release,
      latestRelease,
      versions,
      activeVersion,
      phase: this.installing !== undefined ? 'installing' : this.failure !== undefined ? 'failed' : 'idle',
      error: this.failure,
      profile,
    };
  }

  install(version?: string, options: { readonly instanceId?: string } = {}): Promise<AntigravityStatus> {
    if (this.installing !== undefined) throw invalid('An Antigravity installation is already running');
    const legacyRequested = version !== undefined && valid(version) !== null && lt(version, ANTIGRAVITY_CLI_MIN_VERSION);
    const installId = randomUUID();

    const work = (async () => {
      const musl = await this.detectMusl();
      let tagVersion = version ?? antigravityOfficialFallbackRelease(this.bootstrap.platform, this.bootstrap.arch, musl).version;
      try {
        this.failure = undefined;
        if (legacyRequested && version !== undefined) {
          const release = antigravityRelease(version, this.bootstrap.platform, this.bootstrap.arch, musl);
          tagVersion = release.version;
          const tag = { installId, version: tagVersion };
          if (!await this.legacyComplete(release.version)) {
            const directory = this.legacyDirectory(release.version);
            await this.fs.remove(directory).catch((error: unknown) => {
              if (!isMissingFsError(error)) throw error;
            });
            await installBinaryArchive({
              url: release.url,
              directory,
              entry: release.entry,
              requiredSibling: release.requiredSibling,
              expectedSha256: release.sha256,
              expectedArchiveBytes: release.archiveBytes,
              expectedEntryBytes: release.executableBytes,
              expectedSiblingBytes: release.harnessBytes,
              timeoutMs: ANTIGRAVITY_INSTALL_TIMEOUT_MS,
              onProgress: (progress) => { this.publish({ ...tag, ...progress }); },
            });
          }
          this.publish({ ...tag, stage: 'activate' });
          await this.documents.set(ANTIGRAVITY_CACHE_SCOPE, 'antigravity-acp', {
            activeVersion: release.version,
            layout: 'legacy-pair',
          } satisfies AntigravityCacheState);
          this.publish({ ...tag, stage: 'done' });
        } else {
          const release = await this.resolveLiveManifest(true, musl);
          if (version !== undefined && release.version !== version) {
            throw invalid(
              `Requested Antigravity CLI version ${version} does not match the current official manifest (${release.version}); omit version to install the current official release.`,
            );
          }
          tagVersion = release.version;
          const tag = { installId, version: tagVersion };
          const versionsRoot = antigravityOfficialVersionsRoot(this.bootstrap.homeDir);
          const installed = await installOfficialAntigravityBinary({
            versionsRoot,
            version: release.version,
            url: release.url,
            sha512: release.sha512!,
            format: release.format === 'executable' ? 'executable' : 'tar.gz',
            executableName: release.entry,
            platform: this.bootstrap.platform,
            arch: this.bootstrap.arch,
            timeoutMs: ANTIGRAVITY_INSTALL_TIMEOUT_MS,
            leasedDirectories: activeAntigravityLeasedDirectories(),
            onProgress: (progress) => { this.publish({ ...tag, ...progress }); },
            validate: (executablePath) => this.validateOfficialBinary(executablePath, release.version),
          });
          const verified = await inspectOfficialReleaseDirectory(installed.directory, this.bootstrap.platform, this.bootstrap.arch);
          if (verified === undefined) {
            throw new Error(`Installed Antigravity CLI directory is missing or invalid at ${installed.directory}`);
          }
          this.publish({ ...tag, stage: 'activate' });
          await this.documents.set(ANTIGRAVITY_CACHE_SCOPE, 'antigravity-acp', {
            activeVersion: verified.version,
            activeDirectory: verified.directoryName,
            layout: 'official-cli',
          } satisfies AntigravityCacheState);
          await pruneUnusedOfficialVersions(
            versionsRoot,
            verified.directory,
            activeAntigravityLeasedDirectories(),
            this.bootstrap.platform,
          ).catch(() => undefined);
          this.publish({ ...tag, stage: 'done' });
        }
      } catch (error) {
        this.failure = error instanceof Error ? error.message : String(error);
        const timedOut = error instanceof Error && (
          error.name === 'TimeoutError' ||
          (error.cause as { readonly name?: string } | undefined)?.name === 'TimeoutError'
        );
        this.publish({ installId, version: tagVersion, stage: 'failed', error: this.failure, timedOut });
        throw error;
      } finally {
        this.installing = undefined;
      }
      return this.status({ instanceId: options.instanceId });
    })();
    this.installing = work;
    return work;
  }

  async activate(version: string, options: { readonly instanceId?: string } = {}): Promise<AntigravityStatus> {
    if (this.installing !== undefined) throw invalid('A complete cached Antigravity version is required');
    const versionsRoot = antigravityOfficialVersionsRoot(this.bootstrap.homeDir);
    const officialInstalled = await listInstalledOfficialVersions(versionsRoot, this.bootstrap.platform, this.bootstrap.arch);
    const officialMatch = officialInstalled.find((entry) => entry.version === version);
    if (officialMatch !== undefined) {
      const verified = await inspectOfficialReleaseDirectory(officialMatch.directory, this.bootstrap.platform, this.bootstrap.arch);
      if (verified === undefined) {
        throw invalid('A complete cached Antigravity version is required');
      }
      await this.documents.set(ANTIGRAVITY_CACHE_SCOPE, 'antigravity-acp', {
        activeVersion: verified.version,
        activeDirectory: verified.directoryName,
        layout: 'official-cli',
      } satisfies AntigravityCacheState);
      return this.status({ instanceId: options.instanceId });
    }
    const release = antigravityRelease(version, this.bootstrap.platform, this.bootstrap.arch);
    if (!await this.legacyComplete(release.version)) {
      throw invalid('A complete cached Antigravity version is required');
    }
    await this.documents.set(ANTIGRAVITY_CACHE_SCOPE, 'antigravity-acp', {
      activeVersion: release.version,
      layout: 'legacy-pair',
    } satisfies AntigravityCacheState);
    return this.status({ instanceId: options.instanceId });
  }

  async beginLogin(requestInput: AntigravityAuthMethod | AntigravityLoginRequest): Promise<AntigravityLoginStart> {
    this.requireOpen();
    const request: AntigravityLoginRequest = typeof requestInput === 'string'
      ? { methodId: requestInput }
      : requestInput;
    const instanceId = request.instanceId ?? 'antigravity-acp';
    const descriptor = await this.resolveTargetDescriptor(instanceId);
    const env = executorProcessEnv(descriptor);
    const profileHome = antigravitySettingsHome(env, this.bootstrap, descriptor.id);
    const homeKey = canonicalHomeKey(profileHome, this.bootstrap.platform);

    if (this.busyHomes.has(homeKey) || this.pendingHandleByHome.has(homeKey)) {
      throw invalid('An Antigravity sign-in is already pending');
    }
    this.busyHomes.add(homeKey);
    try {
      const credentials = await readAntigravityLocalCredentials(profileHome);
      const envLookup = executorEnvLookup(descriptor, (name) => this.bootstrap.getEnv(name));
      const gcpProject = request.gcpProject?.trim() || credentials.settings.gcpProject;
      const gcpLocation = request.gcpLocation?.trim() || credentials.settings.gcpLocation;
      const configIssue = validateAuthConfig({
        methodId: request.methodId,
        gcpProject,
        gcpLocation,
        apiKey: request.apiKey?.trim(),
        existingSecret: request.methodId === 'gemini-api-key'
          ? credentials.secrets?.geminiApiKey
          : credentials.secrets?.googleApiKey,
        envKey: request.methodId === 'gemini-api-key'
          ? envLookup('GEMINI_API_KEY')
          : envLookup('GOOGLE_API_KEY'),
      });
      if (configIssue !== undefined) {
        throw invalid(configIssue);
      }

      if (request.methodId === 'gemini-api-key' || request.methodId === 'agent-platform') {
        const snapshot = await snapshotAntigravityAuthConfig(profileHome);
        try {
          await antigravityAuthSettings(profileHome, request.methodId, {
            project: gcpProject,
            location: gcpLocation,
          });
          if (request.apiKey !== undefined && request.apiKey.trim() !== '') {
            await writeAntigravityProfileSecrets(profileHome, request.methodId === 'gemini-api-key'
              ? { ...credentials.secrets, geminiApiKey: request.apiKey.trim() }
              : { ...credentials.secrets, googleApiKey: request.apiKey.trim() });
          }
          this.quota.invalidate(profileHome);
          const profile = await this.probeProfile(instanceId);
          return { alreadySignedIn: true, instanceId, profile };
        } catch (error) {
          await restoreAntigravityAuthConfig(profileHome, snapshot).catch(() => undefined);
          this.quota.invalidate(profileHome);
          const detail = error instanceof Error && error.message.trim() !== '' ? `: ${error.message.trim()}` : '';
          throw invalid(`Antigravity credentials could not be verified${detail}`);
        }
      }

      await antigravityAuthSettings(profileHome, request.methodId, {
        project: gcpProject,
        location: gcpLocation,
      });

      const resolved = await this.executors.resolveExecutable(instanceId);
      this.requireOpen();
      const command = resolved.descriptor.command!;
      const launchArgs = executorLaunchArgs(
        resolved.descriptor,
        [...resolved.descriptor.launchArgs ?? [], ...resolved.descriptor.args],
      );
      const isOfficial = isOfficialAntigravityCliCommand(command, resolved.descriptor, launchArgs);

      if (request.methodId === 'oauth-personal' && isOfficial) {
        const existingCache = await readAntigravityProfileCache(profileHome);
        if (
          request.force !== true &&
          credentials.cliToken !== undefined &&
          !credentials.cliToken.expired &&
          existingCache?.verificationFailed !== true &&
          existingCache?.eligibility !== 'subscription_required'
        ) {
          try {
            const profile = await this.probeProfile(instanceId);
            return { alreadySignedIn: true, instanceId, profile };
          } catch {}
        }
        return await this.startOfficialCodeLogin({
          instanceId,
          homeKey,
          profileHome,
          descriptor: resolved.descriptor,
          command,
          methodId: request.methodId,
        });
      }

      let helper: AcpLoginHelper | undefined;
      try {
        helper = this.createLoginHelper(resolved.descriptor, env ?? {});
        const result = await helper.start(request.methodId);
        this.requireOpen();
        if (result.alreadySignedIn) {
          await helper.close();
          this.activeHelpers.delete(helper);
          const profile = await this.readProfileStatus(instanceId);
          return { alreadySignedIn: true, instanceId, profile };
        }
        const handle = randomUUID();
        const owned = helper;
        const timer = setTimeout(() => { void this.cancelLogin(handle).catch(() => {}); }, AUTH_EXPIRY_MS);
        timer.unref();
        this.pendingByHandle.set(handle, {
          kind: 'loopback',
          handle,
          instanceId,
          homeKey,
          profileHome,
          helper: owned,
          authUrl: result.authUrl,
          expiresAt: Date.now() + AUTH_EXPIRY_MS,
          timer,
        });
        this.pendingHandleByHome.set(homeKey, handle);
        return {
          ...result,
          handle,
          flowKind: 'loopback_url',
          methodId: request.methodId,
          instanceId,
          expiresInSecs: Math.floor(AUTH_EXPIRY_MS / 1000),
        };
      } catch (error) {
        if (helper !== undefined) {
          this.activeHelpers.delete(helper);
          await helper.close();
        }
        throw error;
      }
    } finally {
      this.busyHomes.delete(homeKey);
    }
  }

  async completeLogin(handle: string, codeOrUrl: string, instanceId?: string): Promise<AntigravityLoginOutcome> {
    const pending = this.requirePending(handle, true, instanceId);
    if (this.busyHomes.has(pending.homeKey)) throw invalid('Antigravity sign-in is busy');

    if (pending.kind === 'code') {
      const validated = validateAntigravityLoginCodeResponse(pending.parsedUrl, codeOrUrl);
      if (validated === undefined) {
        return {
          signedIn: false,
          retryable: true,
          message: 'The code or callback URL does not match this pending sign-in.',
          messageCode: 'callback_mismatch',
        };
      }
      this.busyHomes.add(pending.homeKey);
      clearTimeout(pending.timer);
      try {
        await submitCodeToLoginProcess(pending.child, validated);
        const creds = await readAntigravityLocalCredentials(pending.profileHome);
        if (creds.cliToken === undefined && creds.legacyToken === undefined) {
          return {
            signedIn: false,
            retryable: false,
            message: 'Antigravity sign-in exited without saving a credential.',
            messageCode: 'signin_failed',
          };
        }
        this.quota.invalidate(pending.profileHome);
        const probeOutcome = await this.runPostLoginProbe(pending.instanceId, pending.profileHome);
        return probeOutcome;
      } catch (error) {
        const detail = error instanceof Error && error.message.trim() !== '' ? `: ${error.message.trim()}` : '';
        return {
          signedIn: false,
          retryable: false,
          message: `Antigravity sign-in failed${detail}`,
          messageCode: 'signin_failed',
        };
      } finally {
        this.removePending(pending);
        await closeCodeLoginProcess(pending);
        this.busyHomes.delete(pending.homeKey);
      }
    }

    try {
      rebuildLoopbackRedirect(pending.authUrl, codeOrUrl);
    } catch {
      return {
        signedIn: false,
        retryable: true,
        message: 'The callback does not match this pending sign-in.',
        messageCode: 'callback_mismatch',
      };
    }
    this.busyHomes.add(pending.homeKey);
    clearTimeout(pending.timer);
    try {
      await pending.helper.finish(pending.authUrl, codeOrUrl);
      this.quota.invalidate(pending.profileHome);
      const probeOutcome = await this.runPostLoginProbe(pending.instanceId, pending.profileHome, true);
      return probeOutcome;
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() !== '' ? `: ${error.message.trim()}` : '';
      return {
        signedIn: false,
        retryable: false,
        message: `Antigravity sign-in failed${detail}`,
        messageCode: 'signin_failed',
      };
    } finally {
      this.removePending(pending);
      this.activeHelpers.delete(pending.helper);
      await pending.helper.close();
      this.busyHomes.delete(pending.homeKey);
    }
  }

  async cancelLogin(handle: string, instanceId?: string): Promise<void> {
    const pending = this.requirePending(handle, false, instanceId);
    this.removePending(pending);
    clearTimeout(pending.timer);
    if (pending.kind === 'code') {
      await closeCodeLoginProcess(pending);
    } else {
      this.activeHelpers.delete(pending.helper);
      await pending.helper.close();
    }
  }

  async logout(instanceId = 'antigravity-acp'): Promise<void> {
    this.requireOpen();
    const descriptor = await this.resolveTargetDescriptor(instanceId);
    const env = executorProcessEnv(descriptor);
    const profileHome = antigravitySettingsHome(env, this.bootstrap, descriptor.id);
    const homeKey = canonicalHomeKey(profileHome, this.bootstrap.platform);

    if (this.busyHomes.has(homeKey) || this.pendingHandleByHome.has(homeKey)) {
      throw invalid('Cancel the pending sign-in before signing out');
    }
    this.busyHomes.add(homeKey);
    let helper: AcpLoginHelper | undefined;
    try {
      const resolved = await this.executors.resolveExecutable(instanceId).catch(() => undefined);
      if (resolved?.descriptor.command !== undefined) {
        await antigravityAuthSettings(profileHome);
        helper = this.createLoginHelper(resolved.descriptor, executorProcessEnv(resolved.descriptor) ?? {});
        await helper.logout().catch(() => undefined);
      }
      await scrubAntigravityProfileAuth(profileHome);
      this.quota.invalidate(profileHome);
    } finally {
      if (helper !== undefined) {
        this.activeHelpers.delete(helper);
        await helper.close();
      }
      this.busyHomes.delete(homeKey);
    }
  }

  async probeProfile(instanceId = 'antigravity-acp'): Promise<AntigravityProfileStatus> {
    this.requireOpen();
    const resolved = await this.executors.resolveExecutable(instanceId);
    const descriptor = resolved.descriptor;
    const env = executorProcessEnv(descriptor);
    const profileHome = antigravitySettingsHome(env, this.bootstrap, descriptor.id);
    const probeWorkspace = await createAntigravityProbeWorkspace(this.bootstrap.homeDir);
    const wrappedProcesses = antigravityProcessService(this.processes, descriptor, this.bootstrap);
    const launchArgs = executorLaunchArgs(descriptor, [...descriptor.launchArgs ?? [], ...descriptor.args]);

    let child: HostProcessLike | undefined;
    let probeSessionId: string | undefined;
    try {
      child = await wrappedProcesses.spawn(descriptor.command!, launchArgs, {
        cwd: probeWorkspace,
        env,
        shell: false,
        windowsHide: true,
        mergeStderr: false,
        ownedProcessTree: true,
      });
      const sessionData = await runDisposableAcpProbe(child, probeWorkspace);
      probeSessionId = sessionData.sessionId;
      const creds = await readAntigravityLocalCredentials(profileHome);
      let accountLabel: string | undefined;
      if (creds.cliToken !== undefined && !creds.cliToken.expired) {
        const userInfo = await fetchGoogleUserInfo(creds.cliToken.accessToken).catch(() => undefined);
        accountLabel = userInfo?.email;
      }
      const checkedAt = new Date().toISOString();
      const cache: AntigravityProfileCache = {
        version: 1,
        authMethod: creds.settings.authMethod,
        accountLabel,
        gcpProject: creds.settings.gcpProject,
        gcpLocation: creds.settings.gcpLocation,
        eligibility: 'ready',
        autoModeSupported: sessionData.autoModeSupported,
        models: sessionData.models,
        commands: sessionData.commands,
        checkedAt,
      };
      await writeAntigravityProfileCache(profileHome, cache);
      const modelIds = sessionData.models.map((item) => item.id);
      const modelThinkingLevels: Record<string, readonly string[]> = {};
      const allThinkingLevels = new Set<string>();
      for (const model of sessionData.models) {
        if (model.thinkingLevels !== undefined && model.thinkingLevels.length > 0) {
          modelThinkingLevels[model.id] = model.thinkingLevels;
          for (const level of model.thinkingLevels) allThinkingLevels.add(level);
        }
      }
      this.executors.recordNegotiated?.(
        instanceId,
        sessionData.agentVersion ?? descriptor.version,
        {
          agentVersion: sessionData.agentVersion,
          models: modelIds.length > 0 ? modelIds : undefined,
          thinkingLevels: allThinkingLevels.size > 0 ? [...allThinkingLevels] : undefined,
          modelThinkingLevels: Object.keys(modelThinkingLevels).length > 0 ? modelThinkingLevels : undefined,
          slashCommands: sessionData.commands.length > 0 ? sessionData.commands : undefined,
          permissionModes: sessionData.availableModes.length > 0 ? sessionData.availableModes : undefined,
        },
        descriptor.registryRevision ?? descriptor.revision,
      );
      return this.readProfileStatus(instanceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('SUBSCRIPTION_REQUIRED')) {
        const checkedAt = new Date().toISOString();
        const existing = await readAntigravityProfileCache(profileHome);
        await writeAntigravityProfileCache(profileHome, {
          ...existing,
          version: 1,
          eligibility: 'subscription_required',
          eligibilityMessage: 'Google requires an eligible Antigravity subscription for this account.',
          verificationFailed: true,
          checkedAt,
        });
      }
      throw error;
    } finally {
      if (child !== undefined) {
        await child.kill('SIGTERM').catch(() => undefined);
        await Promise.resolve(child.dispose()).catch(() => undefined);
      }
      await scrubAntigravityProbeSession({
        profileHome,
        sessionId: probeSessionId,
        cwd: probeWorkspace,
      }).catch(() => undefined);
      await removeDirectoryForce(probeWorkspace).catch(() => undefined);
    }
  }

  async readProfileQuota(instanceId = 'antigravity-acp', signal?: AbortSignal): Promise<AntigravityQuotaResult> {
    const descriptor = await this.resolveTargetDescriptor(instanceId);
    const profileHome = antigravitySettingsHome(executorProcessEnv(descriptor), this.bootstrap, descriptor.id);
    const result = await this.quota.read({
      profileHome,
      platform: this.bootstrap.platform,
      arch: this.bootstrap.arch,
      signal,
    });
    if (result.ok && result.accountLabel !== undefined) {
      const existing = await readAntigravityProfileCache(profileHome);
      if (existing?.accountLabel !== result.accountLabel) {
        await writeAntigravityProfileCache(profileHome, {
          ...existing,
          version: 1,
          accountLabel: result.accountLabel,
          checkedAt: existing?.checkedAt ?? result.checkedAt,
        }).catch(() => undefined);
      }
    }
    return result;
  }

  async readAllInstanceQuotas(signal?: AbortSignal): Promise<readonly HarnessQuotaReading[]> {
    const descriptors = this.executors.list().filter((descriptor) =>
      executorSourceId(descriptor) === 'antigravity-acp' &&
      descriptor.instance?.configuration.kind !== 'plugin_account',
    );
    const byHome = new Map<string, { readonly profileHome: string; readonly descriptors: AgentExecutorDescriptor[] }>();
    for (const descriptor of descriptors) {
      const profileHome = antigravitySettingsHome(executorProcessEnv(descriptor), this.bootstrap, descriptor.id);
      const key = canonicalHomeKey(profileHome, this.bootstrap.platform);
      const group = byHome.get(key);
      if (group === undefined) byHome.set(key, { profileHome, descriptors: [descriptor] });
      else group.descriptors.push(descriptor);
    }

    const readings: HarnessQuotaReading[] = [];
    await Promise.all([...byHome.values()].map(async (group) => {
      const [quotaResult, cache] = await Promise.all([
        this.quota.read({
          profileHome: group.profileHome,
          platform: this.bootstrap.platform,
          arch: this.bootstrap.arch,
          signal,
        }),
        readAntigravityProfileCache(group.profileHome),
      ]);
      if (!quotaResult.ok) return;
      const modelIds = cache?.models?.map((item) => item.id);
      for (const descriptor of group.descriptors) {
        const accountId = descriptor.instance?.quota_account_id ?? descriptor.id;
        readings.push(...antigravityQuotaToHarnessReadings({
          accountId,
          accountLabel: quotaResult.accountLabel ?? cache?.accountLabel ?? descriptor.label ?? descriptor.id,
          windows: quotaResult.windows,
          modelIds,
          readAt: quotaResult.checkedAt,
        }));
      }
    }));
    return readings;
  }

  private async readProfileStatus(instanceId: string): Promise<AntigravityProfileStatus> {
    const descriptor = typeof this.executors.get === 'function' ? this.executors.get(instanceId) : undefined;
    const env = descriptor === undefined ? {} : executorProcessEnv(descriptor);
    const lookup = descriptor === undefined
      ? (name: string) => this.bootstrap.getEnv(name)
      : executorEnvLookup(descriptor, (name) => this.bootstrap.getEnv(name));
    const profileHome = antigravitySettingsHome(env, this.bootstrap, descriptor?.id ?? instanceId);
    const [credentials, cache] = await Promise.all([
      readAntigravityLocalCredentials(profileHome),
      readAntigravityProfileCache(profileHome),
    ]);
    const method = credentials.settings.present ? credentials.settings.authMethod : undefined;
    let signedIn = false;
    let tokenExpired: boolean | undefined;
    const verificationBlocked = cache?.verificationFailed === true || cache?.eligibility === 'subscription_required';
    if (!verificationBlocked) {
      if (method === undefined || method === 'oauth-personal' || method === 'oauth-business') {
        signedIn = credentials.cliToken !== undefined || credentials.legacyToken !== undefined;
        if (credentials.cliToken !== undefined && credentials.legacyToken === undefined) {
          tokenExpired = credentials.cliToken.expired;
        }
      } else if (method === 'gemini-api-key') {
        signedIn = Boolean(credentials.secrets?.geminiApiKey || lookup('GEMINI_API_KEY'));
      } else if (method === 'agent-platform') {
        signedIn = Boolean(
          credentials.secrets?.googleApiKey ||
          lookup('GOOGLE_API_KEY') ||
          (credentials.settings.gcpProject && credentials.settings.gcpLocation),
        );
      }
    }
    return {
      instanceId,
      signedIn,
      authMethod: method,
      accountLabel: cache?.accountLabel,
      gcpProject: credentials.settings.gcpProject,
      gcpLocation: credentials.settings.gcpLocation,
      eligibility: cache?.eligibility ?? (signedIn ? 'unknown' : undefined),
      eligibilityMessage: cache?.eligibilityMessage,
      tokenExpired,
      autoModeSupported: cache?.autoModeSupported,
      models: cache?.models,
      commands: cache?.commands,
      checkedAt: cache?.checkedAt,
    };
  }

  private async runPostLoginProbe(
    instanceId: string,
    profileHome: string,
    tolerateMissingSpawn = false,
  ): Promise<AntigravityLoginOutcome> {
    try {
      const profile = await this.probeProfile(instanceId);
      return { signedIn: true, retryable: false, profile };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('SUBSCRIPTION_REQUIRED')) {
        const profile = await this.readProfileStatus(instanceId);
        return {
          signedIn: false,
          retryable: false,
          message: 'Google requires an eligible Antigravity subscription for this account.',
          messageCode: 'subscription_required',
          profile,
        };
      }
      if (tolerateMissingSpawn && isProbeSpawnUnavailable(error)) {
        const profile = await this.readProfileStatus(instanceId);
        return { signedIn: true, retryable: false, profile };
      }
      const existing = await readAntigravityProfileCache(profileHome);
      await writeAntigravityProfileCache(profileHome, {
        ...existing,
        version: 1,
        eligibility: existing?.eligibility === 'subscription_required' ? 'subscription_required' : 'unknown',
        eligibilityMessage: message || 'Antigravity sign-in verification failed.',
        verificationFailed: true,
        checkedAt: new Date().toISOString(),
      }).catch(() => undefined);
      const profile = await this.readProfileStatus(instanceId);
      return {
        signedIn: false,
        retryable: false,
        message: message || 'Antigravity sign-in verification failed.',
        messageCode: existing?.eligibility === 'subscription_required' ? 'subscription_required' : 'signin_failed',
        profile,
      };
    }
  }

  private async startOfficialCodeLogin(input: {
    readonly instanceId: string;
    readonly homeKey: string;
    readonly profileHome: string;
    readonly descriptor: AgentExecutorDescriptor;
    readonly command: string;
    readonly methodId: AntigravityAuthMethod;
  }): Promise<AntigravityLoginStart> {
    const baseEnv = executorProcessEnv(input.descriptor) ?? {};
    const tempHome = join(this.bootstrap.homeDir, 'tools', 'antigravity-acp', 'tmp', 'login', randomUUID());
    const userHome = this.bootstrap.platform === 'win32'
      ? (baseEnv['USERPROFILE'] ?? this.bootstrap.getEnv('USERPROFILE') ?? this.bootstrap.osHomeDir)
      : (baseEnv['HOME'] ?? this.bootstrap.getEnv('HOME') ?? this.bootstrap.osHomeDir);
    await syncAntigravityUserConfig({
      profileHome: input.profileHome,
      tempHome,
      userHome,
      platform: this.bootstrap.platform,
    });
    const releaseLease = acquireAntigravityBinaryLease(input.command, antigravityCacheRoot(this.bootstrap.homeDir));
    const envUnset = new Set([
      ...antigravityCredentialEnvToRemove(input.methodId),
      'DISPLAY',
      'WAYLAND_DISPLAY',
      'BROWSER',
      'CHROME_CRASHPAD_PIPE_NAME',
      'ANTIGRAVITY_HARNESS_PATH',
    ]);
    const env: Record<string, string> = { ...baseEnv };
    for (const key of Object.keys(env)) {
      for (const removed of envUnset) {
        if (key.toUpperCase() === removed.toUpperCase()) delete env[key];
      }
    }
    const sshConnection = antigravitySshConnectionValue(env, this.bootstrap);
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === 'SSH_CONNECTION') delete env[key];
    }
    Object.assign(env, {
      GEMINI_HOME: input.profileHome,
      AGY_ACP_FORCE_FILE_STORAGE: '1',
      AGY_CLI_DISABLE_AUTO_UPDATE: '1',
      SSH_CONNECTION: sshConnection,
      PYTHONUNBUFFERED: '1',
      TEMP: tempHome,
      TMP: tempHome,
      TMPDIR: tempHome,
    });
    for (const key of ['GEMINI_HOME', 'AGY_ACP_FORCE_FILE_STORAGE', 'AGY_CLI_DISABLE_AUTO_UPDATE', 'SSH_CONNECTION', 'PYTHONUNBUFFERED', 'TEMP', 'TMP', 'TMPDIR']) {
      envUnset.delete(key);
    }

    const args = [...antigravityOfficialCliArgs(['acp'], input.profileHome), '--login'];
    let child: HostProcessLike | undefined;
    try {
      child = await this.processes.spawn(input.command, args, {
        env,
        envUnset: [...envUnset],
        shell: false,
        windowsHide: true,
        mergeStderr: false,
        ownedProcessTree: true,
      });
      const parsedUrl = await waitForCodeLoginUrl(child, CODE_LOGIN_URL_TIMEOUT_MS);
      this.requireOpen();
      const handle = randomUUID();
      const timer = setTimeout(() => { void this.cancelLogin(handle).catch(() => {}); }, AUTH_EXPIRY_MS);
      timer.unref();
      this.pendingByHandle.set(handle, {
        kind: 'code',
        handle,
        instanceId: input.instanceId,
        homeKey: input.homeKey,
        profileHome: input.profileHome,
        tempHome,
        child,
        releaseLease,
        parsedUrl,
        expiresAt: Date.now() + AUTH_EXPIRY_MS,
        timer,
      });
      this.pendingHandleByHome.set(input.homeKey, handle);
      return {
        alreadySignedIn: false,
        handle,
        authUrl: parsedUrl.authorizationUrl,
        redirectUri: parsedUrl.redirectUri,
        flowKind: 'code_paste',
        methodId: input.methodId,
        instanceId: input.instanceId,
        expiresInSecs: Math.floor(AUTH_EXPIRY_MS / 1000),
      };
    } catch (error) {
      if (child !== undefined) {
        await child.kill('SIGTERM').catch(() => undefined);
        await Promise.resolve(child.dispose()).catch(() => undefined);
      }
      releaseLease();
      await removeDirectoryForce(tempHome).catch(() => undefined);
      throw error;
    }
  }

  private async detectMusl(): Promise<boolean> {
    return detectLinuxMusl(this.bootstrap.platform, this.bootstrap.arch);
  }

  private async resolveExternalVersion(instanceId: string): Promise<string | undefined> {
    try {
      const descriptor = typeof this.executors.get === 'function' ? this.executors.get(instanceId) : undefined;
      if (
        descriptor?.command !== undefined &&
        (descriptor.selectedSource !== undefined || descriptor.version !== undefined)
      ) {
        const cachedVersion = descriptor.version?.trim();
        return cachedVersion !== undefined && cachedVersion !== '' ? cachedVersion : 'external';
      }
      if (typeof this.executors.discoverMetadata === 'function') {
        const meta = await this.executors.discoverMetadata(instanceId);
        if (meta.installed) {
          const metaVersion = meta.version?.trim();
          return metaVersion !== undefined && metaVersion !== '' ? metaVersion : 'external';
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private async resolveLiveManifest(force: boolean, musl?: boolean): Promise<AntigravityRelease> {
    if (!force && this.cachedManifest !== undefined && Date.now() - this.cachedManifest.fetchedAt < MANIFEST_CACHE_TTL_MS) {
      return this.cachedManifest.release;
    }
    const isMusl = musl ?? await this.detectMusl();
    const release = await fetchAntigravityCliManifest(this.bootstrap.platform, this.bootstrap.arch, { musl: isMusl });
    if (release === undefined) {
      throw new Error('Official Antigravity CLI manifest is unavailable for this platform.');
    }
    this.cachedManifest = { release, fetchedAt: Date.now() };
    return release;
  }

  private async validateOfficialBinary(executablePath: string, expectedVersion?: string): Promise<void> {
    const tempDir = await createAntigravityProbeWorkspace(this.bootstrap.homeDir);
    let child: HostProcessLike | undefined;
    let stderrText = '';
    try {
      child = await this.processes.spawn(
        executablePath,
        ['acp', '--gemini-dir', tempDir, '--app-data-dir', 'antigravity-acp'],
        {
          cwd: tempDir,
          env: {
            GEMINI_HOME: tempDir,
            AGY_CLI_DISABLE_AUTO_UPDATE: '1',
            AGY_ACP_FORCE_FILE_STORAGE: '1',
            TEMP: tempDir,
            TMP: tempDir,
            TMPDIR: tempDir,
          },
          shell: false,
          windowsHide: true,
          mergeStderr: false,
          ownedProcessTree: true,
        },
      );
      child.stderr.on('data', (chunk: Buffer | string) => {
        if (stderrText.length < 16_384) {
          stderrText += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
        }
      });
      const response = await requestJsonRpc(child, 1, 'initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'kiki', version: '1.0.0' },
      }, HANDSHAKE_TIMEOUT_MS);
      const agentInfo = asRecord(response['agentInfo']);
      const capabilities = asRecord(response['agentCapabilities']);
      const protocolVersion = response['protocolVersion'];
      if (agentInfo?.['name'] !== 'Antigravity ACP Server') {
        throw new Error(`Unexpected Antigravity ACP agentInfo.name: ${String(agentInfo?.['name'] ?? '(missing)')}`);
      }
      const rawVersion = typeof agentInfo['version'] === 'string' ? agentInfo['version'].trim() : '';
      const parsedVersion = valid(rawVersion);
      if (parsedVersion === null || !gte(parsedVersion, ANTIGRAVITY_CLI_MIN_VERSION)) {
        throw new Error(`Antigravity ACP version must be >= ${ANTIGRAVITY_CLI_MIN_VERSION}; got ${rawVersion || '(missing)'}`);
      }
      if (expectedVersion !== undefined && valid(expectedVersion) !== null && parsedVersion !== valid(expectedVersion)) {
        throw new Error(`Antigravity ACP version mismatch: expected ${expectedVersion}, got ${parsedVersion}`);
      }
      if (protocolVersion !== 1 && protocolVersion !== 2) {
        throw new Error(`Unsupported Antigravity ACP protocolVersion: ${String(protocolVersion ?? '(missing)')}`);
      }
      if (capabilities?.['loadSession'] !== true) {
        throw new Error('Antigravity ACP binary did not advertise loadSession capability.');
      }
      const resumeCapability = asRecord(capabilities['sessionCapabilities'])?.['resume'];
      if (!resumeCapability) {
        throw new Error('Antigravity ACP binary did not advertise sessionCapabilities.resume.');
      }
      const hasLogout =
        Boolean(asRecord(capabilities['authCapabilities'])?.['logout']) ||
        Boolean(asRecord(capabilities['auth'])?.['logout']);
      const authMethods = Array.isArray(response['authMethods']) ? response['authMethods'] : [];
      const hasOauthPersonal = authMethods.some((entry) => asRecord(entry)?.['id'] === 'oauth-personal');
      if (!hasLogout || !hasOauthPersonal) {
        throw new Error('Antigravity ACP binary must advertise both auth logout and oauth-personal support.');
      }
    } catch (error) {
      const base = error instanceof Error ? error.message : String(error);
      const hint = formatBinaryValidationHint(stderrText);
      throw new Error(hint === undefined ? `Antigravity binary validation failed: ${base}` : `Antigravity binary validation failed: ${base} (${hint})`);
    } finally {
      if (child !== undefined) {
        await child.kill('SIGTERM').catch(() => undefined);
        await Promise.resolve(child.dispose()).catch(() => undefined);
      }
      await removeDirectoryForce(tempDir).catch(() => undefined);
    }
  }

  private async resolveTargetDescriptor(instanceId: string): Promise<AgentExecutorDescriptor> {
    const descriptor = typeof this.executors.get === 'function'
      ? this.executors.get(instanceId)
      : (await this.executors.resolveExecutable(instanceId)).descriptor;
    if (descriptor === undefined) {
      throw invalid(`Unknown Antigravity executor instance "${instanceId}"`);
    }
    if (executorSourceId(descriptor) !== 'antigravity-acp') {
      throw invalid(`Executor "${instanceId}" is not an antigravity-acp instance`);
    }
    return descriptor;
  }

  private createLoginHelper(descriptor: AgentExecutorDescriptor, env: Record<string, string>): AcpLoginHelper {
    const helper = new AcpLoginHelper(antigravityProcessService(this.processes, descriptor, this.bootstrap), {
      command: descriptor.command!,
      args: executorLaunchArgs(descriptor, [...descriptor.launchArgs ?? [], ...descriptor.args]),
      env,
    });
    this.activeHelpers.add(helper);
    return helper;
  }

  private requirePending(handle: string, checkExpiry = true, instanceId?: string): PendingLogin {
    const pending = this.pendingByHandle.get(handle);
    if (
      pending === undefined ||
      (checkExpiry && pending.expiresAt <= Date.now()) ||
      (instanceId !== undefined && pending.instanceId !== instanceId)
    ) {
      throw invalid('Antigravity sign-in handle is invalid or expired');
    }
    return pending;
  }

  private removePending(pending: PendingLogin): void {
    this.pendingByHandle.delete(pending.handle);
    if (this.pendingHandleByHome.get(pending.homeKey) === pending.handle) {
      this.pendingHandleByHome.delete(pending.homeKey);
    }
  }

  private requireOpen(): void {
    if (this.closed) throw invalid('Antigravity service is closed');
  }

  private legacyDirectory(version: string): string {
    return join(antigravityCacheRoot(this.bootstrap.homeDir), version, `${this.bootstrap.platform}-${this.bootstrap.arch}`);
  }

  private async listLegacyInstalledVersions(): Promise<readonly string[]> {
    const root = antigravityCacheRoot(this.bootstrap.homeDir);
    const directories = await this.fs.readdir(root).catch((error: unknown) => {
      if (!isMissingFsError(error)) throw error;
      return [];
    });
    const versions: string[] = [];
    for (const directory of directories) {
      if (!directory.isDirectory || valid(directory.name) === null || !directory.name.startsWith('1.')) continue;
      if (await this.legacyComplete(directory.name)) versions.push(directory.name);
    }
    return versions;
  }

  private async legacyComplete(version: string): Promise<boolean> {
    if (gte(version, ANTIGRAVITY_CLI_MIN_VERSION)) return false;
    const release = antigravityRelease(version, this.bootstrap.platform, this.bootstrap.arch);
    const entries = [
      [release.entry, release.executableBytes],
      [release.requiredSibling, release.harnessBytes],
    ] as const;
    const present = await Promise.all(entries.map(([name, expectedBytes]) => {
      if (name === undefined) return Promise.resolve(true);
      return this.fs.stat(join(this.legacyDirectory(release.version), name)).then(
        (value) => value.isFile && (expectedBytes === undefined || value.size === expectedBytes),
        () => false,
      );
    }));
    return present.every(Boolean);
  }

  async dispose(): Promise<void> {
    this.closed = true;
    const pendingList = [...this.pendingByHandle.values()];
    const helpers = [...this.activeHelpers];
    this.pendingByHandle.clear();
    this.pendingHandleByHome.clear();
    this.activeHelpers.clear();
    this.quota.clear();
    for (const pending of pendingList) {
      clearTimeout(pending.timer);
      if (pending.kind === 'code') {
        await closeCodeLoginProcess(pending);
      } else {
        await pending.helper.close();
      }
    }
    for (const helper of helpers) {
      await helper.close().catch(() => undefined);
    }
    await this.installing?.catch(() => undefined);
  }
}

function validateAuthConfig(input: {
  readonly methodId: AntigravityAuthMethod;
  readonly gcpProject?: string;
  readonly gcpLocation?: string;
  readonly apiKey?: string;
  readonly existingSecret?: string;
  readonly envKey?: string;
}): string | undefined {
  switch (input.methodId) {
    case 'oauth-personal':
      return undefined;
    case 'oauth-business':
      return input.gcpProject && input.gcpLocation
        ? undefined
        : 'Gemini Enterprise (oauth-business) requires both gcp_project and gcp_location.';
    case 'gemini-api-key':
      return input.apiKey || input.existingSecret || input.envKey
        ? undefined
        : 'Gemini API key sign-in requires an api_key (or GEMINI_API_KEY).';
    case 'agent-platform':
      return input.apiKey || input.existingSecret || input.envKey || (input.gcpProject && input.gcpLocation)
        ? undefined
        : 'Agent Platform sign-in requires an api_key (or GOOGLE_API_KEY) or both gcp_project and gcp_location.';
  }
}

function canonicalHomeKey(home: string, platform: NodeJS.Platform): string {
  const normalized = normalize(home);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function waitForCodeLoginUrl(child: HostProcessLike, timeoutMs: number): Promise<AntigravityCodeAuthUrl> {
  return new Promise<AntigravityCodeAuthUrl>((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      fn();
    };
    const onData = (chunk: Buffer | string) => {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      const urls = buffer.match(/https:\/\/accounts\.google\.com\/[^\s"'<>]+/g);
      if (urls !== null) {
        for (const candidate of urls) {
          const parsed = parseAntigravityCodeAuthUrl(candidate);
          if (parsed !== undefined) {
            finish(() => resolve(parsed));
            return;
          }
        }
      }
      if (buffer.length > 65_536) {
        buffer = buffer.slice(-16_384);
      }
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error('Antigravity --login did not emit a Google sign-in link in time.')));
    }, timeoutMs);
    timer.unref();
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    void child.wait().then((code) => {
      finish(() => reject(new Error(`Antigravity --login exited with code ${String(code)} before emitting a sign-in link.`)));
    }, (error) => {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
    });
  });
}

async function submitCodeToLoginProcess(child: HostProcessLike, value: string): Promise<void> {
  child.stdin.write(`${value}\n`);
  child.stdin.end();
  let timer: NodeJS.Timeout | undefined;
  try {
    const code = await Promise.race([
      child.wait(),
      new Promise<number>((resolve) => {
        timer = setTimeout(() => resolve(-1), CODE_LOGIN_FINISH_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
    if (code === -1) {
      throw new Error('Antigravity --login timed out while verifying the authorization code.');
    }
    if (code !== 0) {
      throw new Error(`Antigravity --login exited with code ${String(code)}.`);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function closeCodeLoginProcess(pending: PendingCodeLogin): Promise<void> {
  await pending.child.kill('SIGTERM').catch(() => undefined);
  await Promise.resolve(pending.child.dispose()).catch(() => undefined);
  pending.releaseLease();
  await removeDirectoryForce(pending.tempHome).catch(() => undefined);
}

interface ProbeSessionData {
  readonly sessionId?: string;
  readonly agentVersion?: string;
  readonly autoModeSupported: boolean;
  readonly availableModes: readonly string[];
  readonly models: readonly AntigravityCachedModel[];
  readonly commands: readonly string[];
}

async function runDisposableAcpProbe(child: HostProcessLike, cwd: string): Promise<ProbeSessionData> {
  const commands = new Set<string>();
  const rpc = createJsonRpcClient(child, (notification) => {
    if (notification['method'] !== 'session/update') return;
    const params = asRecord(notification['params']);
    const update = asRecord(params?.['update']);
    if (update?.['sessionUpdate'] !== 'available_commands_update') return;
    const list = Array.isArray(update['availableCommands']) ? update['availableCommands'] : [];
    for (const item of list) {
      const name = typeof asRecord(item)?.['name'] === 'string' ? (asRecord(item)!['name'] as string).trim() : '';
      if (name !== '') commands.add(name);
    }
  });
  try {
    const init = await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'kiki', version: '1.0.0' },
    }, PROBE_TIMEOUT_MS);
    const agentVersion = typeof asRecord(init['agentInfo'])?.['version'] === 'string'
      ? (asRecord(init['agentInfo'])!['version'] as string).trim()
      : undefined;
    const session = await rpc.request('session/new', { cwd, mcpServers: [] }, PROBE_TIMEOUT_MS);
    const sessionId = typeof session['sessionId'] === 'string' ? session['sessionId'] : undefined;
    const modesRecord = asRecord(session['modes']);
    const rawAvailableModes = Array.isArray(modesRecord?.['availableModes']) ? modesRecord['availableModes'] : [];
    const availableModes = rawAvailableModes.flatMap((entry) => {
      const id = typeof asRecord(entry)?.['id'] === 'string' ? (asRecord(entry)!['id'] as string) : undefined;
      return id !== undefined && id !== '' ? [id] : [];
    });
    const autoModeSupported = availableModes.includes('auto');

    let configOptions = Array.isArray(session['configOptions']) ? session['configOptions'] : [];
    const modelOption = findSelectConfigOption(configOptions, 'model', 'model');
    const initialModelValue = typeof modelOption?.['currentValue'] === 'string' ? modelOption['currentValue'] : undefined;
    const rawModelChoices = extractSelectChoices(modelOption);
    const models: AntigravityCachedModel[] = [];

    const hasThoughtConfig = findSelectConfigOption(configOptions, 'thought_level', 'thought_level') !== undefined;
    if (sessionId !== undefined && modelOption !== undefined && hasThoughtConfig && rawModelChoices.length > 0) {
      const modelConfigId = typeof modelOption['id'] === 'string' ? modelOption['id'] : 'model';
      for (const choice of rawModelChoices) {
        let thinkingLevels: readonly string[] | undefined;
        try {
          if (choice.value === initialModelValue) {
            thinkingLevels = extractSelectChoices(findSelectConfigOption(configOptions, 'thought_level', 'thought_level'))
              .map((option) => option.value);
          } else {
            const updated = await rpc.request('session/set_config_option', {
              sessionId,
              configId: modelConfigId,
              value: choice.value,
            }, PROBE_TIMEOUT_MS);
            const nextOptions = Array.isArray(updated['configOptions']) ? updated['configOptions'] : [];
            configOptions = nextOptions;
            thinkingLevels = extractSelectChoices(findSelectConfigOption(nextOptions, 'thought_level', 'thought_level'))
              .map((option) => option.value);
          }
        } catch {
          thinkingLevels = undefined;
        }
        models.push({
          id: choice.value,
          label: choice.label,
          thinkingLevels: thinkingLevels !== undefined && thinkingLevels.length > 0 ? thinkingLevels : undefined,
        });
      }
      if (initialModelValue !== undefined) {
        await rpc.request('session/set_config_option', {
          sessionId,
          configId: modelConfigId,
          value: initialModelValue,
        }, PROBE_TIMEOUT_MS).catch(() => undefined);
      }
    } else {
      const fallbackThinking = extractSelectChoices(findSelectConfigOption(configOptions, 'thought_level', 'thought_level'))
        .map((option) => option.value);
      for (const choice of rawModelChoices) {
        models.push({
          id: choice.value,
          label: choice.label,
          thinkingLevels: fallbackThinking.length > 0 ? fallbackThinking : undefined,
        });
      }
    }

    return {
      sessionId,
      agentVersion,
      autoModeSupported,
      availableModes,
      models,
      commands: [...commands],
    };
  } finally {
    rpc.dispose();
  }
}

interface JsonRpcClient {
  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>;
  dispose(): void;
}

function createJsonRpcClient(
  child: HostProcessLike,
  onNotification?: (message: Record<string, unknown>) => void,
): JsonRpcClient {
  let nextId = 1;
  let buffer = '';
  const pending = new Map<number, {
    readonly resolve: (value: Record<string, unknown>) => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
  }>();

  const onData = (chunk: Buffer | string) => {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
      if (line === '' || !line.startsWith('{')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const message = asRecord(parsed);
      if (message === undefined) continue;
      if (typeof message['id'] === 'number') {
        const entry = pending.get(message['id']);
        if (entry === undefined) continue;
        pending.delete(message['id']);
        clearTimeout(entry.timer);
        const rpcError = asRecord(message['error']);
        if (rpcError !== undefined) {
          const detail = typeof rpcError['message'] === 'string' ? rpcError['message'] : JSON.stringify(rpcError);
          entry.reject(new Error(detail));
        } else {
          entry.resolve(asRecord(message['result']) ?? {});
        }
      } else if (typeof message['method'] === 'string') {
        onNotification?.(message);
      }
    }
  };

  child.stdout.on('data', onData);
  void child.wait().then((code) => {
    for (const [id, entry] of pending) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Error(`Antigravity ACP process exited with code ${String(code)}`));
    }
  }, (error) => {
    for (const [id, entry] of pending) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error instanceof Error ? error : new Error(String(error)));
    }
  });

  return {
    request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
      const id = nextId++;
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Antigravity ACP ${method} timed out`));
        }, timeoutMs);
        timer.unref();
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    dispose(): void {
      child.stdout.off('data', onData);
      for (const [id, entry] of pending) {
        pending.delete(id);
        clearTimeout(entry.timer);
        entry.reject(new Error('Antigravity ACP client disposed'));
      }
    },
  };
}

async function requestJsonRpc(
  child: HostProcessLike,
  _id: number,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const rpc = createJsonRpcClient(child);
  try {
    return await rpc.request(method, params, timeoutMs);
  } finally {
    rpc.dispose();
  }
}

function findSelectConfigOption(
  options: readonly unknown[],
  category: string,
  fallbackId: string,
): Record<string, unknown> | undefined {
  for (const raw of options) {
    const option = asRecord(raw);
    if (option === undefined || option['type'] !== 'select') continue;
    if (option['category'] === category || option['id'] === fallbackId) return option;
  }
  return undefined;
}

function extractSelectChoices(
  option: Record<string, unknown> | undefined,
): readonly { readonly value: string; readonly label?: string }[] {
  if (option === undefined || !Array.isArray(option['options'])) return [];
  const results: { readonly value: string; readonly label?: string }[] = [];
  const seen = new Set<string>();
  const pushChoice = (item: Record<string, unknown>) => {
    const value = typeof item['value'] === 'string' ? item['value'].trim() : '';
    if (value === '' || seen.has(value)) return;
    seen.add(value);
    const label = typeof item['name'] === 'string' && item['name'].trim() !== ''
      ? item['name'].trim()
      : undefined;
    results.push({ value, label });
  };
  for (const raw of option['options']) {
    const entry = asRecord(raw);
    if (entry === undefined) continue;
    if (typeof entry['value'] === 'string') {
      pushChoice(entry);
    } else if (Array.isArray(entry['options'])) {
      for (const nested of entry['options']) {
        const nestedEntry = asRecord(nested);
        if (nestedEntry !== undefined) pushChoice(nestedEntry);
      }
    }
  }
  return results;
}

function formatBinaryValidationHint(stderrText: string): string | undefined {
  if (/\b(?:AF_INET6|enforce_kernel_ipv6_support)\b/i.test(stderrText) || /ipv6|network is unreachable|enetunreach/i.test(stderrText)) {
    return 'IPv6 socket support is required by Antigravity';
  }
  if (/page-size\.cc|Compile-time page size does not match|large page|page size/i.test(stderrText)) {
    return 'Host kernel page-size compatibility issue detected';
  }
  if (/glibc|musl|ld-linux/i.test(stderrText)) {
    return 'Host libc/glibc compatibility issue detected';
  }
  return undefined;
}

function isProbeSpawnUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'EACCES' || code === 'os.fs.not_found') return true;
  return error.message === 'unexpected spawn';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isMissingFsError(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('code' in error)) return false;
  const code = String((error as { readonly code?: unknown }).code);
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'os.fs.not_found' || code === 'os.fs.not_directory';
}

function invalid(message: string): Error2 {
  return new Error2(ErrorCodes.REQUEST_INVALID, message);
}

registerScopedService(LifecycleScope.App, IAntigravityService, AntigravityService, ScopeActivation.OnDemand, 'antigravity');
