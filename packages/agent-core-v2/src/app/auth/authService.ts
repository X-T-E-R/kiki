import { randomUUID } from 'node:crypto';

import {
  DeviceCodeTimeoutError,
  KIMI_CODE_PLATFORM_ID,
  KIMI_CODE_PROVIDER_NAME,
  KimiOAuthToolkit,
  kimiCodeBaseUrl,
  kimiRegionLoginHosts,
  OAuthError,
  OAuthAccessDeniedError,
  applyManagedKimiCodeConfig,
  applyOAuthMethodConfig,
  clearOAuthMethodConfig,
  isDeviceOAuthMethod,
  OAUTH_METHODS,
  OAuthDeviceMethods,
  oauthMethodFor,
  clearManagedKimiCodeConfig,
  fetchManagedKimiCodeModels,
  resolveKimiCodeLoginAuth,
  resolveKimiCodeOAuthRef,
  resolveKimiCodeRuntimeAuth,
  resolveKimiRegion,
  type AuthManagedUserInfoResult,
  type AuthManagedUsageResult,
  type BearerTokenProvider,
  type DeviceAuthorization,
  type KimiRegion,
  type ManagedKimiConfigShape,
  LocalOriginalOAuthService,
  LocalOriginalOAuthError,
  type LocalOriginalOAuthProbe,
  type LocalOriginalOAuthSourceRef,
} from '@kiki/oauth';
import { connectOriginalOAuthRequestSchema, originalOAuthRequestSchema, type ConnectOriginalOAuthRequest, type OriginalOAuthProbe, type OriginalOAuthRequest } from '@kiki/protocol';
import { parse as parseToml } from 'smol-toml';
import { originalOAuthKeyring } from '#/persistence/backends/node-fs/originalOAuthKeyring';
import type {
  OAuthFlowSnapshot,
  OAuthFlowStart,
  OAuthFlowStartPending,
  OAuthFlowStatus,
  OAuthLoginCancelResponse,
  OAuthLogoutResponse,
  RefreshOAuthProviderModelsResponse,
} from './oauthProtocol';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Error2, ErrorCodes } from '#/errors';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IEventService } from '#/app/event/event';
import { ILogService } from '#/_base/log/log';
import {
  deriveProviderId,
  effectiveModelConfig,
  nonEmpty,
  resolveModelAuthMaterial,
  resolveModelProviderId,
} from '#/kosong/model/modelAuth';
import { IModelService, type ModelRecord } from '#/kosong/model/model';
import {
  DEFAULT_MODEL_SECTION,
  MODELS_SECTION,
  PROVIDERS_SECTION,
  THINKING_SECTION,
} from '#/app/kosongConfig/configSection';
import { ModelCatalogChanged } from '#/app/kosongConfig/discovery';
import {
  IProviderService,
  type OAuthRef,
  type ProviderConfig,
  type ProvidersChangedEvent,
} from '#/kosong/provider/provider';
import { isOAuthCatalogVendor } from '#/kosong/provider/providerDefinition';
import { ITelemetryService } from '#/app/telemetry/telemetry';

import {
  AuthModelNotResolvedError,
  AuthProvisioningRequiredError,
  AuthTokenMissingError,
  type AuthStatus,
  IAuthSummaryService,
  IOAuthService,
  IOAuthToolkit,
  type OAuthLoginOptions,
  type OAuthMethodStatus,
} from './auth';

const TERMINAL_RETENTION_MS = 5 * 60 * 1000;
const DEFAULT_DEVICE_EXPIRES_IN_SEC = 15 * 60;

interface FlowState {
  readonly flowId: string;
  readonly provider: string;
  readonly controller: AbortController;
  readonly oauthRef: OAuthRef | undefined;
  readonly loginBaseUrl: string | undefined;
  device: DeviceAuthorization | undefined;
  status: OAuthFlowStatus;
  tokenGranted: boolean;
  expiresAt: number;
  gcTimer: ReturnType<typeof setTimeout> | undefined;
  errorMessage: string | undefined;
  resolvedAt: string | undefined;
}

export class OAuthService extends Disposable implements IOAuthService {
  declare readonly _serviceBrand: undefined;
  private readonly flows = new Map<string, FlowState>();

  private refreshChain: Promise<unknown> = Promise.resolve();

  constructor(
    @IOAuthToolkit private readonly toolkit: IOAuthToolkit,
    @IProviderService private readonly providerService: IProviderService,
    @IConfigService private readonly config: IConfigService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ILogService private readonly log: ILogService,
    @IEventService private readonly events: IEventService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {
    super();
    this._register(providerService.onDidChangeProviders((event) => {
      this.invalidateFlows(event);
    }));
  }

  private originalSources(): LocalOriginalOAuthService {
    if (this.toolkit.originalSources === undefined) throw new OAuthError('Original account sources are not available in this Kiki host.');
    return this.toolkit.originalSources;
  }

  private originalProbeDto(probe: LocalOriginalOAuthProbe): OriginalOAuthProbe {
    return { provider: probe.provider, home_dir: probe.homeDir, storage_backend: probe.storageBackend,
      state: probe.state, account: probe.account, can_connect: probe.canConnect, reason: probe.reason };
  }

  async probeOriginal(request: OriginalOAuthRequest): Promise<OriginalOAuthProbe> {
    const input = originalOAuthRequestSchema.parse(request);
    return this.originalProbeDto(await this.originalSources().probe(input.provider, input.home_dir));
  }

  connectOriginal(request: ConnectOriginalOAuthRequest): Promise<OriginalOAuthProbe> {
    const input = connectOriginalOAuthRequestSchema.parse(request);
    const provider = providerKeyFor(input.provider);
    this.abortExisting(provider);
    return this.enqueueAuthMutation(async () => {
      const source = await this.originalSources().connect(input.provider, input.home_dir, input.expected_account_id);
      const accessToken = await this.originalSources().getAccessToken(source);
      await this.provisionDeviceMethod(provider, accessToken, undefined, source);
      return this.originalProbeDto(await this.originalSources().probe(source.provider, source.homeDir, source));
    });
  }

  async listMethods(): Promise<readonly OAuthMethodStatus[]> {
    return Promise.all(OAUTH_METHODS.map(async (method): Promise<OAuthMethodStatus> => {
      const source = this.providerService.get(method.providerName)?.oauth?.source;
      if (source !== undefined) {
        const probe = await this.originalSources().probe(source.provider, source.homeDir, source);
        const signedIn = probe.state === 'ready' || probe.state === 'refresh_required';
        return { id: method.id, label: method.label, provider: method.providerName, protocol: method.protocol,
          signed_in: signedIn, connection_state: signedIn ? probe.state as 'ready' | 'refresh_required' : probe.state === 'signed_out' ? 'signed_out' : 'reconnect_required',
          account: probe.account, quota: { state: 'unknown' },
          auth_source: { kind: 'local_original', home_dir: probe.homeDir, storage_backend: probe.storageBackend, source_state: probe.state } };
      }
      let signedIn = false;
      let connectionState: OAuthMethodStatus['connection_state'] = 'signed_out';
      try {
        signedIn = this.providerService.get(method.providerName)?.oauth !== undefined
          && nonEmpty(await this.getCachedAccessToken(method.providerName)) !== undefined;
        connectionState = signedIn ? 'ready' : 'signed_out';
        if (isDeviceOAuthMethod(method.id) && this.toolkit.deviceMethods !== undefined) {
          connectionState = await this.toolkit.deviceMethods.connectionState(method.id);
          signedIn = signedIn && (connectionState === 'ready' || connectionState === 'refresh_required');
          if (!signedIn && (connectionState === 'ready' || connectionState === 'refresh_required')) {
            connectionState = 'reconnect_required';
          }
        }
      } catch {
        signedIn = false;
        connectionState = 'reconnect_required';
      }
      let account: OAuthMethodStatus['account'] = { state: 'unknown' };
      let quota: OAuthMethodStatus['quota'] = { state: 'unknown' };
      if (signedIn && method.id === 'kimi-code') {
        const [user, usage] = await Promise.allSettled([
          this.getManagedUserInfo(method.providerName),
          this.getManagedUsage(method.providerName),
        ]);
        if (user.status === 'fulfilled' && user.value.kind === 'ok' && user.value.userInfo.userId) {
          account = { state: 'known', id: user.value.userInfo.username || user.value.userInfo.email || user.value.userInfo.userId };
        }
        if (usage.status === 'fulfilled' && usage.value.kind === 'ok') {
          const row = usage.value.summary ?? usage.value.limits[0];
          if (row !== undefined && row !== null && Number.isFinite(row.limit) && Number.isFinite(row.used)) {
            quota = {
              state: 'known', label: row.name ?? 'Plan quota',
              remaining: Math.max(0, row.limit - row.used),
              unit: row.unit ?? 'count',
              reset_at: row.resetAt,
            };
          }
        }
      } else if (signedIn && this.toolkit.deviceMethods !== undefined) {
        try {
          const details = await this.toolkit.deviceMethods.getAccountDetails(method.providerName);
          if (details.accountId) account = { state: 'known', id: details.accountId };
          if (details.quota !== undefined) {
            quota = { state: 'known', label: details.quota.label,
              remaining: details.quota.remaining, unit: details.quota.unit,
              reset_at: details.quota.resetAt };
          }
        } catch {
          account = { state: 'unknown' };
          quota = { state: 'unknown' };
        }
      }
      return {
        id: method.id,
        label: method.label,
        provider: method.providerName,
        protocol: method.protocol,
        signed_in: signedIn,
        auth_source: { kind: 'kiki' },
        connection_state: connectionState,
        account,
        quota,
      };
    }));
  }

  async startLogin(
    requested = KIMI_CODE_PROVIDER_NAME,
    options: OAuthLoginOptions = {},
  ): Promise<OAuthFlowStart> {
    const provider = oauthMethodFor(requested)?.providerName ?? requested;
    if (isDeviceOAuthMethod(provider)) return this.startDeviceMethodLogin(provider);
    this.log.info('oauth startLogin: enter', { provider });
    const loginAuth = this.resolveLoginAuth(provider, options.region);
    this.log.info('oauth startLogin: resolved login auth', {
      provider,
      hasOAuthRef: loginAuth.oauthRef !== undefined,
      hasBaseUrl: loginAuth.baseUrl !== undefined,
      hasOAuthHost: loginAuth.oauthHost !== undefined,
    });
    this.abortExisting(provider);

    const state: FlowState = {
      flowId: `oauth_${randomUUID()}`,
      provider,
      controller: new AbortController(),
      oauthRef: loginAuth.oauthRef,
      loginBaseUrl: loginAuth.baseUrl,
      device: undefined,
      status: 'pending',
      tokenGranted: false,
      expiresAt: Date.now() + DEFAULT_DEVICE_EXPIRES_IN_SEC * 1000,
      gcTimer: undefined,
      errorMessage: undefined,
      resolvedAt: undefined,
    };
    this.flows.set(provider, state);

    let resolveDevice!: (auth: DeviceAuthorization) => void;
    let rejectDevice!: (error: unknown) => void;
    const deviceReady = new Promise<DeviceAuthorization>((resolve, reject) => {
      resolveDevice = resolve;
      rejectDevice = reject;
    });

    this.log.info('oauth startLogin: calling toolkit.login', { provider });
    const loginPromise = this.toolkit.login(provider, {
      signal: state.controller.signal,
      oauthRef: loginAuth.oauthRef,
      baseUrl: loginAuth.baseUrl,
      oauthHost: loginAuth.oauthHost,
      onDeviceCode: (auth) => {
        this.log.info('oauth startLogin: onDeviceCode fired', { provider });
        state.device = auth;
        if (auth.expiresIn !== null) {
          state.expiresAt = Date.now() + auth.expiresIn * 1000;
        }
        resolveDevice(auth);
      },
    });
    const fastPath: Promise<OAuthFlowStart | undefined> = loginPromise.then(async () => {
      if (state.device !== undefined) return undefined;
      this.log.info('oauth startLogin: toolkit resolved without device code (already authenticated)', {
        provider,
      });
      await this.completeAlreadyAuthenticatedLogin(state);
      return {
        flow_id: state.flowId,
        provider: state.provider,
        status: 'authenticated',
      };
    });

    loginPromise.then(
      () => {
        this.log.info('oauth startLogin: toolkit.login resolved', {
          provider,
          deviceArrived: state.device !== undefined,
        });
        if (state.device !== undefined) {
          this.handleSuccess(state);
        }
      },
      (error) => {
        this.log.warn('oauth startLogin: toolkit.login rejected', {
          provider,
          error: error instanceof Error ? error.message : String(error),
        });
        this.handleFailure(state, error);
        rejectDevice(error);
      },
    );

    this.log.info('oauth startLogin: awaiting device flow start', { provider });
    const winner = await Promise.race([
      deviceReady.then((device) => ({ kind: 'device' as const, device })),
      fastPath.then((result) => ({ kind: 'fast' as const, result })),
    ]);
    if (winner.kind === 'fast' && winner.result !== undefined) {
      this.log.info('oauth startLogin: fast path returned authenticated', { provider });
      return winner.result;
    }
    const device = winner.kind === 'device' ? winner.device : await deviceReady;
    this.log.info('oauth startLogin: deviceReady resolved', { provider });
    return this.toFlowStart(state, device);
  }

  getFlow(requested = KIMI_CODE_PROVIDER_NAME): OAuthFlowSnapshot | undefined {
    const state = this.flows.get(providerKeyFor(requested));
    if (state === undefined || state.device === undefined) return undefined;
    return this.toSnapshot(state, state.device);
  }

  cancelLogin(requested = KIMI_CODE_PROVIDER_NAME): Promise<OAuthLoginCancelResponse> {
    const state = this.flows.get(providerKeyFor(requested));
    if (state === undefined || state.status !== 'pending') {
      return Promise.resolve({ cancelled: false, status: state?.status ?? 'cancelled' });
    }
    state.controller.abort();
    this.setTerminal(state, 'cancelled');
    if (isDeviceOAuthMethod(state.provider) && state.tokenGranted && state.device !== undefined) {
      return this.enqueueAuthMutation(async () => {
        await this.deviceMethods().logout(state.provider);
        await this.deprovisionDeviceMethod(state.provider);
        return { cancelled: true, status: 'cancelled' };
      });
    }
    return Promise.resolve({ cancelled: true, status: 'cancelled' });
  }

  async logout(requested = KIMI_CODE_PROVIDER_NAME): Promise<OAuthLogoutResponse> {
    const provider = providerKeyFor(requested);
    if (isDeviceOAuthMethod(provider)) {
      this.abortExisting(provider);
      return this.enqueueAuthMutation(async () => {
        const source = this.providerService.get(provider)?.oauth?.source;
        if (source === undefined) await this.deviceMethods().logout(provider);
        else await this.originalSources().disconnect(source);
        await this.deprovisionDeviceMethod(provider);
        return { logged_out: true, provider };
      });
    }
    const oauthRef =
      provider === KIMI_CODE_PROVIDER_NAME
        ? this.resolveRuntimeOAuthRef(provider)
        : this.readOAuthRefOptional(provider);
    const result = await this.toolkit.logout(provider, oauthRef);
    this.abortExisting(provider);
    await this.deprovisionProvider(provider);
    return { logged_out: true, provider: result.providerName };
  }

  async status(provider = KIMI_CODE_PROVIDER_NAME): Promise<AuthStatus> {
    this.log.info('oauth status: enter', { provider });
    const oauthRef = this.readOAuthRefOptional(provider);
    try {
      const token = await this.getCachedAccessToken(provider, oauthRef);
      this.log.info('oauth status: got token', { provider, hasToken: token !== undefined });
      return token === undefined ? { loggedIn: false } : { loggedIn: true, provider };
    } catch (error) {
      this.log.warn('oauth status: getCachedAccessToken threw', {
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private originalSource(provider: string, oauthRef?: OAuthRef): LocalOriginalOAuthSourceRef | undefined {
    const source = (oauthRef ?? this.providerService.get(providerKeyFor(provider))?.oauth)?.source;
    if (source !== undefined && (providerKeyFor(source.provider) !== providerKeyFor(provider) ||
      (oauthRef ?? this.providerService.get(providerKeyFor(provider))?.oauth)?.key !== oauthMethodFor(source.provider)?.oauthKey)) {
      throw new LocalOriginalOAuthError('unsupported', 'The original OAuth source does not match this provider.');
    }
    return source;
  }

  resolveTokenProvider(provider: string, oauthRef?: OAuthRef): BearerTokenProvider | undefined {
    const source = this.originalSource(provider, oauthRef);
    if (source !== undefined) return this.originalSources().tokenProvider(source);
    if (isDeviceOAuthMethod(provider)) return this.deviceMethods().tokenProvider(provider);
    return this.toolkit.tokenProvider(provider, this.resolveRuntimeOAuthRef(provider, oauthRef));
  }

  getCachedAccessToken(provider: string, oauthRef?: OAuthRef): Promise<string | undefined> {
    const source = this.originalSource(provider, oauthRef);
    if (source !== undefined) return this.originalSources().getCachedAccessToken(source);
    if (isDeviceOAuthMethod(provider)) return this.deviceMethods().getCachedAccessToken(provider);
    return this.toolkit.getCachedAccessToken(provider, this.resolveRuntimeOAuthRef(provider, oauthRef));
  }

  private deviceMethods(): OAuthDeviceMethods {
    if (this.toolkit.deviceMethods === undefined) {
      throw new Error2(ErrorCodes.AUTH_TOKEN_MISSING, 'Account sign-in methods are not available in this host.');
    }
    return this.toolkit.deviceMethods;
  }

  private startDeviceMethodLogin(provider: string): Promise<OAuthFlowStart> {
    this.abortExisting(provider);
    const state: FlowState = {
      flowId: `oauth_${randomUUID()}`,
      provider,
      controller: new AbortController(),
      oauthRef: undefined,
      loginBaseUrl: undefined,
      device: undefined,
      status: 'pending',
      tokenGranted: false,
      expiresAt: Date.now() + DEFAULT_DEVICE_EXPIRES_IN_SEC * 1000,
      gcTimer: undefined,
      errorMessage: undefined,
      resolvedAt: undefined,
    };
    this.flows.set(provider, state);
    return new Promise<OAuthFlowStart>((resolve, reject) => {
      let settled = false;
      const login = this.deviceMethods().login(provider, {
        signal: state.controller.signal,
        onDeviceCode: (device) => {
          state.device = device;
          if (device.expiresIn !== null) state.expiresAt = Date.now() + device.expiresIn * 1000;
          settled = true;
          resolve(this.toFlowStart(state, device));
        },
      });
      login.then(
        async (accessToken) => {
          if (state.status !== 'pending') {
            if (!settled) reject(new OAuthError('Login cancelled.'));
            return;
          }
          state.tokenGranted = true;
          try {
            await this.enqueueAuthMutation(() => this.provisionDeviceMethod(provider, accessToken, state));
            if (state.status === 'pending') this.setTerminal(state, 'authenticated');
          } catch (error) {
            this.log.warn('oauth device method provisioning failed', {
              provider,
              error: error instanceof Error ? error.message : String(error),
            });
            this.handleFailure(state, error);
            if (!settled) {
              settled = true;
              reject(error);
            }
            return;
          }
          if (!settled) {
            settled = true;
            resolve({ flow_id: state.flowId, provider, status: 'authenticated' });
          }
        },
        (error: unknown) => {
          this.handleFailure(state, error);
          if (!settled) {
            settled = true;
            reject(error);
          }
        },
      );
    });
  }

  private enqueueAuthMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.refreshChain.then(operation);
    this.refreshChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async provisionDeviceMethod(provider: string, accessToken: string, flow?: FlowState, source?: LocalOriginalOAuthSourceRef): Promise<RefreshOAuthProviderModelsResponse['changed'][number]> {
    const method = this.deviceMethods().method(provider);
    const models = await method.listModels(accessToken);
    await this.config.reload();
    if (flow?.controller.signal.aborted === true) throw new OAuthError('Login cancelled.');
    const previousSource = this.providerService.get(method.providerName)?.oauth?.source;
    const next = structuredClone(this.readUserConfigShape());
    const applied = applyOAuthMethodConfig(next, method, {
      baseUrl: method.baseUrlFor(accessToken),
      headers: method.requestHeaders(accessToken),
      models,
    });
    if (source !== undefined) {
      const configured = next.providers[method.providerName];
      next.providers[method.providerName] = { ...configured, oauth: { storage: 'file', key: method.oauthKey, source } };
    }
    await this.config.replace(PROVIDERS_SECTION, next.providers);
    await this.config.replace(MODELS_SECTION, next.models ?? {});
    await this.config.replace(DEFAULT_MODEL_SECTION, next.defaultModel);
    if (previousSource !== undefined && JSON.stringify(previousSource) !== JSON.stringify(source)) await this.originalSources().disconnect(previousSource);
    return { provider_id: provider, provider_name: method.label, added: applied.added, removed: applied.removed };
  }

  private async deprovisionDeviceMethod(provider: string): Promise<void> {
    const method = oauthMethodFor(provider);
    if (method === undefined) return;
    const next = structuredClone(this.readUserConfigShape());
    const cleanup = clearOAuthMethodConfig(next, method);
    if (cleanup.removedProvider) await this.config.replace(PROVIDERS_SECTION, next.providers);
    if (cleanup.removedModels.length > 0) await this.config.replace(MODELS_SECTION, next.models ?? {});
    if (cleanup.defaultModelCleared) await this.config.replace(DEFAULT_MODEL_SECTION, undefined);
  }

  getManagedUsage(provider = KIMI_CODE_PROVIDER_NAME): Promise<AuthManagedUsageResult> {
    const configured = this.providerService.get(provider);
    const auth = resolveKimiCodeRuntimeAuth({
      configuredBaseUrl: configured?.baseUrl,
      configuredOAuthRef: configured?.oauth,
    });
    return this.toolkit.getManagedUsage(provider, {
      oauthRef: auth.oauthRef,
      baseUrl: auth.baseUrl,
    });
  }

  getManagedUserInfo(provider = KIMI_CODE_PROVIDER_NAME): Promise<AuthManagedUserInfoResult> {
    const configured = this.providerService.get(provider);
    const auth = resolveKimiCodeRuntimeAuth({
      configuredBaseUrl: configured?.baseUrl,
      configuredOAuthRef: configured?.oauth,
    });
    return this.toolkit.getManagedUserInfo(provider, {
      oauthRef: auth.oauthRef,
      baseUrl: auth.baseUrl,
    });
  }

  refreshOAuthProviderModels(): Promise<RefreshOAuthProviderModelsResponse> {
    const run = this.refreshChain.then(async () => {
      const kimi = await this.doRefreshOAuthProviderModels();
      const devices = await this.refreshDeviceMethodModels();
      const result = {
        changed: [...kimi.changed, ...devices.changed],
        unchanged: [...kimi.unchanged, ...devices.unchanged],
        failed: [...kimi.failed, ...devices.failed],
      };
      if (devices.changed.length > 0) {
        this.events.publish(new ModelCatalogChanged({ payload: result }));
      }
      return result;
    });
    this.refreshChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async refreshDeviceMethodModels(): Promise<RefreshOAuthProviderModelsResponse> {
    const changed: RefreshOAuthProviderModelsResponse['changed'] = [];
    const unchanged: string[] = [];
    const failed: RefreshOAuthProviderModelsResponse['failed'] = [];
    if (this.toolkit.deviceMethods === undefined) return { changed, unchanged, failed };
    for (const method of OAUTH_METHODS) {
      if (!isDeviceOAuthMethod(method.providerName)) continue;
      if (this.providerService.get(method.providerName)?.oauth === undefined) continue;
      try {
        const oauthRef = this.providerService.get(method.providerName)?.oauth;
        const token = await this.resolveTokenProvider(method.providerName, oauthRef)!.getAccessToken();
        const change = await this.provisionDeviceMethod(method.providerName, token, undefined, oauthRef?.source);
        if (change.added === 0 && change.removed === 0) unchanged.push(method.providerName);
        else changed.push(change);
      } catch (error) {
        failed.push({
          provider: method.providerName,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { changed, unchanged, failed };
  }

  private async doRefreshOAuthProviderModels(): Promise<RefreshOAuthProviderModelsResponse> {
    const changed: RefreshOAuthProviderModelsResponse['changed'] = [];
    const unchanged: string[] = [];
    const failed: RefreshOAuthProviderModelsResponse['failed'] = [];

    await this.config.reload();
    const current = this.readUserConfigShape();
    const provider = current.providers[KIMI_CODE_PROVIDER_NAME];
    if (!isOAuthCatalogProvider(provider)) {
      return { changed, unchanged, failed };
    }

    try {
      const auth = resolveKimiCodeRuntimeAuth({
        configuredBaseUrl: provider.baseUrl,
        configuredOAuthRef: provider.oauth,
      });
      const tokenProvider = this.resolveTokenProvider(KIMI_CODE_PROVIDER_NAME, auth.oauthRef);
      if (tokenProvider === undefined) {
        throw new Error2(ErrorCodes.AUTH_TOKEN_MISSING, 'OAuth token provider is not configured.', {
          details: { provider_id: KIMI_CODE_PROVIDER_NAME },
        });
      }
      const token = await tokenProvider.getAccessToken();
      const models = await fetchManagedKimiCodeModels({
        accessToken: token,
        baseUrl: auth.baseUrl,
      });
      if (models.length === 0) {
        return { changed, unchanged, failed };
      }

      const next = structuredClone(current);
      applyManagedKimiCodeConfig(next, {
        models,
        baseUrl: auth.baseUrl,
        oauthKey: auth.oauthRef.key,
        oauthHost: auth.oauthRef.oauthHost,
        preserveDefaultModel: true,
      });
      const refreshedAliasKeys = providerRefreshAliasKeys(
        current,
        next,
        KIMI_CODE_PROVIDER_NAME,
        `${KIMI_CODE_PLATFORM_ID}/`,
      );
      restoreProviderAliases(
        next,
        preserveUserProviderAliases(current, KIMI_CODE_PROVIDER_NAME, refreshedAliasKeys),
      );
      restoreDefaultSelection(next, current.defaultModel, current.thinking?.enabled);
      clampDanglingDefault(next);

      if (providerModelsEqual(current, next, KIMI_CODE_PROVIDER_NAME, refreshedAliasKeys)) {
        unchanged.push(KIMI_CODE_PROVIDER_NAME);
      } else {
        const { added, removed } = computeChanges(
          collectModelIdsForAliases(current, refreshedAliasKeys),
          collectModelIdsForAliases(next, refreshedAliasKeys),
        );
        await this.config.replace(PROVIDERS_SECTION, next.providers);
        await this.config.replace(MODELS_SECTION, next.models ?? {});
        await this.config.replace(DEFAULT_MODEL_SECTION, next.defaultModel);
        await this.config.replace(THINKING_SECTION, next.thinking);
        changed.push({
          provider_id: KIMI_CODE_PROVIDER_NAME,
          provider_name: 'Kimi Code',
          added,
          removed,
        });
      }
    } catch (error) {
      failed.push({
        provider: KIMI_CODE_PROVIDER_NAME,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    const result = { changed, unchanged, failed };
    if (result.changed.length > 0) {
      this.events.publish(new ModelCatalogChanged({ payload: result }));
    }
    return result;
  }

  private readUserConfigShape(): ManagedKimiConfigShape {
    const providers =
      this.config.inspect<Record<string, ProviderConfig>>(PROVIDERS_SECTION).userValue ?? {};
    const models = this.config.inspect<Record<string, ModelRecord>>(MODELS_SECTION).userValue ?? {};
    const defaultModel = this.config.inspect<string>(DEFAULT_MODEL_SECTION).userValue;
    const thinking =
      this.config.inspect<ManagedKimiConfigShape['thinking']>(THINKING_SECTION).userValue;
    return {
      providers: { ...providers } as ManagedKimiConfigShape['providers'],
      models: { ...models } as ManagedKimiConfigShape['models'],
      defaultModel,
      thinking: thinking === undefined ? undefined : { ...thinking },
    };
  }

  getRegion(): KimiRegion {
    const oauth = this.providerService.get(KIMI_CODE_PROVIDER_NAME)?.oauth;
    return resolveKimiRegion({
      configuredOAuthHost: oauth?.oauthHost,
      configuredOAuthKey: oauth?.key,
      readMarker:
        (this.bootstrap.getEnv('KIKI_CODE_REGION_MARKER') ??
          process.env['KIKI_CODE_REGION_MARKER']) !== 'off',
      homeDir: this.bootstrap.homeDir,
    });
  }

  private resolveLoginAuth(
    provider: string,
    region?: KimiRegion,
  ): {
    readonly oauthRef: OAuthRef | undefined;
    readonly baseUrl: string | undefined;
    readonly oauthHost: string | undefined;
  } {
    const config = this.providerService.get(provider);
    if (provider !== KIMI_CODE_PROVIDER_NAME) {
      return { oauthRef: config?.oauth, baseUrl: undefined, oauthHost: undefined };
    }
    const hosts = region === undefined ? undefined : kimiRegionLoginHosts(region);
    const loginAuth = resolveKimiCodeLoginAuth({
      configuredBaseUrl: config?.baseUrl,
      configuredOAuthRef: config?.oauth,
      requestedBaseUrl: hosts?.baseUrl,
      requestedOAuthHost: hosts?.oauthHost,
    });
    const oauthRef =
      loginAuth.oauthRef ??
      resolveKimiCodeOAuthRef({
        oauthHost: loginAuth.oauthHost,
        baseUrl: loginAuth.baseUrl,
      });
    return {
      oauthRef,
      baseUrl: loginAuth.baseUrl,
      oauthHost: loginAuth.oauthHost,
    };
  }

  private readOAuthRefOptional(provider: string): OAuthRef | undefined {
    return this.providerService.get(provider)?.oauth;
  }

  private resolveRuntimeOAuthRef(provider: string, oauthRef?: OAuthRef): OAuthRef | undefined {
    if (provider !== KIMI_CODE_PROVIDER_NAME) return oauthRef;
    const config = this.providerService.get(provider);
    return resolveKimiCodeRuntimeAuth({
      configuredBaseUrl: config?.baseUrl,
      configuredOAuthRef: oauthRef ?? config?.oauth,
    }).oauthRef;
  }

  private abortExisting(provider: string): void {
    const existing = this.flows.get(provider);
    if (existing !== undefined && existing.status === 'pending') {
      existing.controller.abort();
      this.setTerminal(existing, 'cancelled');
    }
  }

  private invalidateFlows(event: ProvidersChangedEvent): void {
    const affected = new Set([...event.removed, ...event.changed]);
    if (affected.size === 0) return;
    for (const state of this.flows.values()) {
      if (!affected.has(state.provider)) continue;
      if (state.status !== 'pending') continue;
      if (state.tokenGranted) continue;
      state.controller.abort();
      state.errorMessage = 'Provider configuration changed during login.';
      this.setTerminal(state, 'cancelled');
    }
  }

  private handleSuccess(state: FlowState): void {
    if (state.status !== 'pending') return;
    state.tokenGranted = true;
    void this.provisionAfterSuccess(state);
  }

  private async completeAlreadyAuthenticatedLogin(state: FlowState): Promise<void> {
    if (state.status !== 'pending') return;
    state.tokenGranted = true;
    await this.provisionAfterSuccess(state);
  }

  private async provisionAfterSuccess(state: FlowState): Promise<void> {
    try {
      await this.provisionProvider(state.provider, state.oauthRef, state.loginBaseUrl);
      if (this.flows.get(state.provider) !== state) return;
      if (state.provider === KIMI_CODE_PROVIDER_NAME) {
        await this.refreshOAuthProviderModelsBestEffort(state.provider);
      }
    } catch (error) {
      this.log.warn('oauth provider provisioning failed', {
        provider: state.provider,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (state.status === 'pending') {
        this.setTerminal(state, 'authenticated');
      }
    }
  }

  private async provisionProvider(
    provider: string,
    oauthRef: OAuthRef | undefined,
    loginBaseUrl: string | undefined,
  ): Promise<void> {
    if (oauthRef === undefined && provider !== KIMI_CODE_PROVIDER_NAME) return;
    const baseUrl =
      loginBaseUrl ?? this.providerService.get(provider)?.baseUrl ?? kimiCodeBaseUrl();
    await this.providerService.set(provider, {
      type: 'kimi',
      baseUrl,
      apiKey: '',
      oauth: oauthRef,
    });
  }

  private async refreshOAuthProviderModelsBestEffort(provider: string): Promise<void> {
    const result = await this.refreshOAuthProviderModels();
    if (result.failed.length > 0) {
      this.log.warn('oauth startLogin: model refresh failed on already-authenticated fast path', {
        provider,
        failures: result.failed,
      });
    }
  }

  private async deprovisionProvider(provider: string): Promise<void> {
    if (provider !== KIMI_CODE_PROVIDER_NAME) return;
    const next = structuredClone(this.readUserConfigShape());
    const cleanup = clearManagedKimiCodeConfig(next);
    if (
      !cleanup.removedProvider &&
      cleanup.removedModels.length === 0 &&
      !cleanup.defaultModelCleared
    ) {
      return;
    }
    if (cleanup.defaultModelCleared) {
      next.thinking = undefined;
    }
    if (cleanup.removedProvider) {
      await this.config.replace(PROVIDERS_SECTION, next.providers);
    }
    if (cleanup.removedModels.length > 0) {
      await this.config.replace(MODELS_SECTION, next.models ?? {});
    }
    if (cleanup.defaultModelCleared) {
      await this.config.replace(DEFAULT_MODEL_SECTION, undefined);
      await this.config.replace(THINKING_SECTION, undefined);
    }
  }

  private handleFailure(state: FlowState, err: unknown): void {
    if (state.status !== 'pending') return;
    state.errorMessage = err instanceof Error ? err.message : String(err);
    const status = classifyFailure(err);
    const method = oauthMethodFor(state.provider)?.id;
    this.setTerminal(state, (method === 'openai-codex' || method === 'grok-build') && status === 'denied'
      && !(err instanceof OAuthAccessDeniedError) ? 'failed' : status);
  }

  private setTerminal(state: FlowState, status: OAuthFlowStatus): void {
    state.status = status;
    state.resolvedAt = new Date().toISOString();
    const timer = setTimeout(() => {
      if (this.flows.get(state.provider) === state) {
        this.flows.delete(state.provider);
      }
    }, TERMINAL_RETENTION_MS);
    timer.unref();
    state.gcTimer = timer;
  }

  private toFlowStart(state: FlowState, device: DeviceAuthorization): OAuthFlowStartPending {
    const expiresIn = device.expiresIn ?? DEFAULT_DEVICE_EXPIRES_IN_SEC;
    return {
      flow_id: state.flowId,
      provider: state.provider,
      verification_uri: device.verificationUri,
      verification_uri_complete: device.verificationUriComplete,
      user_code: device.userCode,
      expires_in: expiresIn,
      interval: device.interval,
      status: 'pending',
      expires_at: new Date(state.expiresAt).toISOString(),
    };
  }

  private toSnapshot(state: FlowState, device: DeviceAuthorization): OAuthFlowSnapshot {
    return {
      ...this.toFlowStart(state, device),
      status: state.status,
      resolved_at: state.resolvedAt,
      error_message: state.errorMessage,
    };
  }
}

export class AuthSummaryService implements IAuthSummaryService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IProviderService private readonly providerService: IProviderService,
    @IModelService private readonly modelService: IModelService,
    @IConfigService private readonly config: IConfigService,
    @IOAuthService private readonly oauth: IOAuthService,
    @ILogService private readonly log: ILogService,
  ) {}

  async summarize(): Promise<readonly AuthStatus[]> {
    const providers = this.providerService.list();
    const oauthProviders = Object.entries(providers).filter(
      ([, config]) => config.oauth !== undefined,
    );
    this.log.info('auth summarize: enter', {
      total: Object.keys(providers).length,
      oauthProviders: oauthProviders.map(([name]) => name),
    });
    const statuses: AuthStatus[] = [];
    for (const [name] of oauthProviders) {
      try {
        statuses.push(await this.oauth.status(name));
      } catch (error) {
        this.log.warn('auth summarize: status threw', {
          provider: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return statuses;
  }

  async ensureReady(modelOverride?: string): Promise<void> {
    await this.config.reload();
    const providers = this.providerService.list();
    const requestedModelId = modelOverride ?? this.modelService.getDefaultModel();
    const modelId =
      requestedModelId === undefined || requestedModelId === ''
        ? undefined
        : this.modelService.resolveId(requestedModelId);
    const configured = modelId === undefined ? undefined : this.modelService.get(modelId);
    if (Object.keys(providers).length === 0 && !isProviderlessModel(configured)) {
      throw new AuthProvisioningRequiredError();
    }
    if (requestedModelId === undefined || requestedModelId === '') {
      throw new AuthModelNotResolvedError(undefined);
    }
    if (configured === undefined || modelId === undefined) {
      throw new AuthModelNotResolvedError(requestedModelId);
    }

    const model = effectiveModelConfig(configured);
    const providerId = resolveModelProviderId(model, this.providerService.getDefaultProvider());
    const provider = providerId === undefined ? undefined : this.providerService.get(providerId);
    if (providerId !== undefined && provider === undefined) {
      throw new AuthModelNotResolvedError(modelId, providerId);
    }

    const providerName = providerId ?? providerNameFromFlatModel(model);
    if (providerName === undefined) {
      throw new AuthModelNotResolvedError(modelId);
    }

    const auth = resolveModelAuthMaterial({
      modelId,
      model,
      provider,
      providerName,
    });
    if (auth.apiKey !== undefined) return;
    if (auth.oauth !== undefined) {
      const providerKey = auth.oauthProviderKey ?? providerName;
      const token = await this.oauth.getCachedAccessToken(providerKey, auth.oauth);
      if (nonEmpty(token) !== undefined) return;
      throw new AuthTokenMissingError(providerKey);
    }
    throw new AuthTokenMissingError(providerName);
  }
}

function providerKeyFor(requested: string): string {
  return oauthMethodFor(requested)?.providerName ?? requested;
}

function classifyFailure(err: unknown): OAuthFlowStatus {
  if (err instanceof DeviceCodeTimeoutError) return 'expired';
  if (err instanceof OAuthError) {
    return err.message.toLowerCase().includes('aborted') ? 'cancelled' : 'denied';
  }
  return 'denied';
}

function isProviderlessModel(model: ModelRecord | undefined): boolean {
  if (model === undefined) return false;
  const effective = effectiveModelConfig(model);
  return (
    effective.providerId === undefined &&
    effective.provider === undefined &&
    providerNameFromFlatModel(effective) !== undefined
  );
}

function providerNameFromFlatModel(model: ModelRecord): string | undefined {
  const baseUrl = nonEmpty(model.baseUrl);
  return baseUrl === undefined ? undefined : deriveProviderId(baseUrl);
}

interface ManagedModel {
  readonly provider: string;
  readonly model: string;
  readonly maxContextSize: number;
  readonly capabilities?: readonly string[];
  readonly displayName?: string;
}

function isOAuthCatalogProvider(
  provider: ProviderConfig | Record<string, unknown> | undefined,
): provider is ProviderConfig & { oauth: OAuthRef } {
  const type = (provider as ProviderConfig | undefined)?.type;
  return (
    provider !== undefined &&
    isOAuthCatalogVendor(type) &&
    (provider as ProviderConfig).oauth !== undefined
  );
}

function collectModelIdsForAliases(
  config: ManagedKimiConfigShape,
  aliasKeys: ReadonlySet<string>,
): Set<string> {
  const ids = new Set<string>();
  for (const aliasKey of aliasKeys) {
    const alias = managedModel(config, aliasKey);
    if (alias !== undefined && alias.model.length > 0) ids.add(alias.model);
  }
  return ids;
}

function providerAliasKeys(config: ManagedKimiConfigShape, providerId: string): Set<string> {
  const keys = new Set<string>();
  for (const [alias, model] of Object.entries(config.models ?? {})) {
    if ((model as ManagedModel).provider === providerId) keys.add(alias);
  }
  return keys;
}

function generatedProviderAliasKeys(
  config: ManagedKimiConfigShape,
  providerId: string,
  aliasPrefix: string,
): Set<string> {
  const keys = new Set<string>();
  for (const [alias, model] of Object.entries(config.models ?? {})) {
    if ((model as ManagedModel).provider === providerId && alias.startsWith(aliasPrefix)) {
      keys.add(alias);
    }
  }
  return keys;
}

function computeChanges(
  oldIds: Set<string>,
  newIds: Set<string>,
): { added: number; removed: number } {
  let added = 0;
  for (const id of newIds) {
    if (!oldIds.has(id)) added++;
  }
  let removed = 0;
  for (const id of oldIds) {
    if (!newIds.has(id)) removed++;
  }
  return { added, removed };
}

function providerModelsEqual(
  config: ManagedKimiConfigShape,
  nextConfig: ManagedKimiConfigShape,
  providerId: string,
  aliasKeys: ReadonlySet<string>,
): boolean {
  return (
    providerModelSnapshot(config, providerId, aliasKeys) ===
    providerModelSnapshot(nextConfig, providerId, aliasKeys)
  );
}

function providerModelSnapshot(
  config: ManagedKimiConfigShape,
  providerId: string,
  aliasKeys: ReadonlySet<string>,
): string {
  const snapshots: Array<{ alias: string; model: ManagedModel }> = [];
  for (const alias of aliasKeys) {
    const model = managedModel(config, alias);
    if (model === undefined || model.provider !== providerId) continue;
    snapshots.push({
      alias,
      model: {
        ...model,
        capabilities:
          model.capabilities === undefined ? undefined : model.capabilities.toSorted(),
      },
    });
  }
  snapshots.sort((a, b) => a.alias.localeCompare(b.alias));
  return JSON.stringify(snapshots);
}

function providerRefreshAliasKeys(
  config: ManagedKimiConfigShape,
  nextConfig: ManagedKimiConfigShape,
  providerId: string,
  aliasPrefix: string,
): Set<string> {
  const keys = generatedProviderAliasKeys(config, providerId, aliasPrefix);
  for (const key of providerAliasKeys(nextConfig, providerId)) keys.add(key);
  return keys;
}

function preserveUserProviderAliases(
  config: ManagedKimiConfigShape,
  providerId: string,
  refreshedAliasKeys: ReadonlySet<string>,
): Record<string, ManagedModel> {
  const preserved: Record<string, ManagedModel> = {};
  for (const [alias, model] of Object.entries(config.models ?? {})) {
    const entry = model as ManagedModel;
    if (entry.provider !== providerId || refreshedAliasKeys.has(alias)) continue;
    preserved[alias] = structuredClone(entry);
  }
  return preserved;
}

function restoreProviderAliases(
  config: ManagedKimiConfigShape,
  aliases: Record<string, ManagedModel>,
): void {
  if (Object.keys(aliases).length === 0) return;
  config.models = {
    ...config.models,
    ...aliases,
  } as ManagedKimiConfigShape['models'];
}

function restoreDefaultSelection(
  config: ManagedKimiConfigShape,
  defaultModel: string | undefined,
  defaultEnabled: boolean | undefined,
): void {
  if (defaultModel === undefined || config.models?.[defaultModel] === undefined) return;
  config.defaultModel = defaultModel;
  const capabilities = managedModel(config, defaultModel)?.capabilities ?? [];
  const enabled = capabilities.includes('always_thinking') ? true : defaultEnabled;
  if (enabled !== undefined) {
    config.thinking = { ...config.thinking, enabled };
  }
}

function clampDanglingDefault(config: ManagedKimiConfigShape): void {
  if (config.defaultModel !== undefined && config.models?.[config.defaultModel] === undefined) {
    config.defaultModel = undefined;
    config.thinking = undefined;
  }
}

function managedModel(
  config: ManagedKimiConfigShape,
  alias: string,
): ManagedModel | undefined {
  return config.models?.[alias] as ManagedModel | undefined;
}

class OAuthToolkitService extends KimiOAuthToolkit implements IOAuthToolkit {
  declare readonly _serviceBrand: undefined;
  readonly deviceMethods: OAuthDeviceMethods;
  readonly originalSources = new LocalOriginalOAuthService({ keyring: originalOAuthKeyring, parseConfig: parseToml });
  constructor(@IBootstrapService bootstrap: IBootstrapService) {
    super({
      homeDir: bootstrap.modelAccountHomeDir,
      credentialsDir: `${bootstrap.modelAccountHomeDir}/credentials`,
      identity: bootstrap.clientIdentity,
    });
    this.deviceMethods = new OAuthDeviceMethods({
      homeDir: bootstrap.modelAccountHomeDir,
      credentialsDir: `${bootstrap.modelAccountHomeDir}/credentials`,
      grokHomeDir: bootstrap.credentialsHomeDir,
    });
  }
}

registerScopedService(LifecycleScope.App, IOAuthService, OAuthService, ScopeActivation.OnScopeCreated, 'auth');
registerScopedService(LifecycleScope.App, IOAuthToolkit, OAuthToolkitService, ScopeActivation.OnScopeCreated, 'auth');
registerScopedService(LifecycleScope.App, IAuthSummaryService, AuthSummaryService, ScopeActivation.OnScopeCreated, 'auth');
