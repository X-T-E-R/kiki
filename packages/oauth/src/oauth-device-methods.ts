/**
 * Registry and token lifecycle for the account sign-in methods that are not
 * Kimi Code. Each method keeps its own token file under the shared
 * credentials directory and runs through the same {@link OAuthManager}
 * (cross-process lock, refresh coalescing, revoked tombstones) as Kimi Code;
 * only the three HTTP hooks differ.
 */

import { join } from 'node:path';

import { createGitHubCopilotMethod, GITHUB_COPILOT_METHOD } from './github-copilot';
import { createGrokBuildMethod, GROK_BUILD_METHOD } from './grok-build';
import { resolveKikiHome } from './home';
import { OAuthManager, type LoginOptions, type OAuthManagerOptions } from './oauth-manager';
import { OAuthUnauthorizedError } from './errors';
import { decodeJwtPayload, type OAuthDeviceMethod, type OAuthMethodDescriptor, type OAuthMethodId } from './oauth-method-types';
import { createOpenAICodexMethod, openaiCodexAccountId, OPENAI_CODEX_METHOD } from './openai-codex';
import { FileTokenStorage, type TokenStorage } from './storage';
import { classifyToken } from './token-state';
import type { BearerTokenProvider } from './toolkit';
import { isRecord } from './utils';

export const KIMI_CODE_METHOD: OAuthMethodDescriptor = {
  id: 'kimi-code',
  label: 'Kimi Code',
  providerName: 'managed:kimi-code',
  protocol: 'openai',
  defaultBaseUrl: 'https://api.kimi.com/coding/v1',
  oauthKey: 'oauth/kimi-code',
  aliasPrefix: 'kimi-code',
};

/** Every sign-in method Kiki offers, in presentation order. */
export const OAUTH_METHODS: readonly OAuthMethodDescriptor[] = [
  KIMI_CODE_METHOD,
  GITHUB_COPILOT_METHOD,
  OPENAI_CODEX_METHOD,
  GROK_BUILD_METHOD,
];

const DEVICE_METHOD_FACTORIES: Readonly<Partial<Record<OAuthMethodId, (fetchImpl: typeof fetch) => OAuthDeviceMethod>>> = {
  'github-copilot': createGitHubCopilotMethod,
  'openai-codex': createOpenAICodexMethod,
  'grok-build': createGrokBuildMethod,
};

export function oauthMethodById(id: string): OAuthMethodDescriptor | undefined {
  return OAUTH_METHODS.find((method) => method.id === id);
}

/** Resolve a method from its id or from the provider id it provisions. */
export function oauthMethodFor(idOrProvider: string): OAuthMethodDescriptor | undefined {
  return OAUTH_METHODS.find(
    (method) => method.id === idOrProvider || method.providerName === idOrProvider,
  );
}

/** True for methods implemented by a device-flow port (every method but Kimi Code). */
export function isDeviceOAuthMethod(idOrProvider: string): boolean {
  const method = oauthMethodFor(idOrProvider);
  return method !== undefined && DEVICE_METHOD_FACTORIES[method.id] !== undefined;
}

export function createOAuthDeviceMethod(
  idOrProvider: string,
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
): OAuthDeviceMethod | undefined {
  const method = oauthMethodFor(idOrProvider);
  if (method === undefined) return undefined;
  return DEVICE_METHOD_FACTORIES[method.id]?.(fetchImpl);
}

function storageNameFor(method: OAuthMethodDescriptor): string {
  return method.oauthKey.startsWith('oauth/') ? method.oauthKey.slice('oauth/'.length) : method.oauthKey;
}

export interface OAuthDeviceMethodsOptions {
  readonly homeDir?: string | undefined;
  readonly credentialsDir?: string | undefined;
  readonly grokHomeDir?: string;
  readonly storage?: TokenStorage | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly now?: OAuthManagerOptions['now'];
  readonly sleep?: OAuthManagerOptions['sleep'];
  readonly deviceCodeTimeoutMs?: number | undefined;
  readonly disableCrossProcessLock?: boolean | undefined;
}

export interface OAuthAccountDetails {
  readonly accountId?: string;
  readonly quota?: {
    readonly label: string;
    readonly remaining: number;
    readonly unit: 'count' | 'percent';
    readonly resetAt?: string;
  };
}

function copilotQuota(payload: unknown): OAuthAccountDetails['quota'] {
  if (!isRecord(payload) || !isRecord(payload['quota_snapshots'])) return undefined;
  const snapshots = payload['quota_snapshots'];
  for (const [key, label] of [['premium_interactions', 'Premium interactions'], ['chat', 'Chat'], ['completions', 'Completions']] as const) {
    const row = snapshots[key];
    if (!isRecord(row)) continue;
    const remaining = row['remaining'];
    const percent = row['percent_remaining'];
    const resetAt = typeof row['reset_date'] === 'string' ? row['reset_date'] : undefined;
    if (typeof remaining === 'number' && Number.isFinite(remaining) && remaining >= 0
      && typeof row['entitlement'] === 'number' && row['entitlement'] > 0) {
      return { label, remaining, unit: 'count', resetAt };
    }
    if (row['entitlement'] !== 0 && typeof percent === 'number'
      && Number.isFinite(percent) && percent >= 0 && percent <= 100) {
      return { label, remaining: percent, unit: 'percent', resetAt };
    }
  }
  return undefined;
}

/** Token lifecycle for the device-flow methods, one manager per method. */
export class OAuthDeviceMethods {
  private readonly homeDir: string;
  private readonly storage: TokenStorage;
  private readonly grokStorage: TokenStorage;
  private readonly options: OAuthDeviceMethodsOptions;
  private readonly managers = new Map<OAuthMethodId, OAuthManager>();
  private readonly methods = new Map<OAuthMethodId, OAuthDeviceMethod>();

  constructor(options: OAuthDeviceMethodsOptions = {}) {
    this.options = options;
    this.homeDir = options.homeDir ?? resolveKikiHome();
    this.storage =
      options.storage ?? new FileTokenStorage(options.credentialsDir ?? join(this.homeDir, 'credentials'));
    this.grokStorage = options.grokHomeDir === undefined ? this.storage
      : options.storage ?? new FileTokenStorage(join(options.grokHomeDir, 'credentials'));
  }

  private storageFor(method: OAuthMethodDescriptor): TokenStorage {
    return method.id === 'grok-build' ? this.grokStorage : this.storage;
  }

  method(idOrProvider: string): OAuthDeviceMethod {
    const descriptor = oauthMethodFor(idOrProvider);
    if (descriptor === undefined) throw new Error(`Unknown sign-in method "${idOrProvider}".`);
    let method = this.methods.get(descriptor.id);
    if (method === undefined) {
      method = createOAuthDeviceMethod(descriptor.id, this.options.fetchImpl);
      if (method === undefined) throw new Error(`"${descriptor.label}" has no device sign-in flow.`);
      this.methods.set(descriptor.id, method);
    }
    return method;
  }

  private manager(idOrProvider: string): OAuthManager {
    const method = this.method(idOrProvider);
    let manager = this.managers.get(method.id);
    if (manager !== undefined) return manager;
    manager = new OAuthManager({
      config: { name: storageNameFor(method), oauthHost: method.defaultBaseUrl, clientId: method.id },
      storage: this.storageFor(method),
      configDir: method.id === 'grok-build' ? this.options.grokHomeDir ?? this.homeDir : this.homeDir,
      now: this.options.now,
      sleep: this.options.sleep,
      deviceCodeTimeoutMs: this.options.deviceCodeTimeoutMs,
      disableCrossProcessLock: this.options.disableCrossProcessLock,
      requestDeviceImpl: () => method.requestDevice(),
      pollDeviceImpl: (_config, deviceCode) => method.pollDevice(deviceCode),
      refreshTokenImpl: (_config, refreshToken) => method.refresh(refreshToken),
    });
    this.managers.set(method.id, manager);
    return manager;
  }

  /** Reuse a still-valid token, otherwise run the device flow. Returns the access token. */
  async login(idOrProvider: string, options: LoginOptions = {}): Promise<string> {
    const manager = this.manager(idOrProvider);
    const singleDeviceFlow = this.method(idOrProvider).id !== 'github-copilot';
    if (await manager.hasToken()) {
      try {
        return await manager.ensureFresh();
      } catch (error) {
        if (singleDeviceFlow && !(error instanceof OAuthUnauthorizedError)) throw error;
      }
    }
    return (await manager.login(singleDeviceFlow ? { ...options, restartOnExpiry: false } : options)).accessToken;
  }

  logout(idOrProvider: string): Promise<void> {
    return this.manager(idOrProvider).logout();
  }

  getCachedAccessToken(idOrProvider: string): Promise<string | undefined> {
    return this.manager(idOrProvider).getCachedAccessToken();
  }

  async connectionState(idOrProvider: string): Promise<import('./oauth-method-types').OAuthConnectionState> {
    const method = this.method(idOrProvider);
    const state = classifyToken(await this.storageFor(method).load(storageNameFor(method)));
    if (state.kind === 'missing') return 'signed_out';
    if (state.kind === 'revoked') return 'reconnect_required';
    const now = this.options.now?.() ?? Math.floor(Date.now() / 1000);
    if (state.token.expiresAt !== 0 && state.token.expiresAt <= now) {
      return state.token.refreshToken.length > 0 ? 'refresh_required' : 'reconnect_required';
    }
    return 'ready';
  }

  async getAccountDetails(idOrProvider: string): Promise<OAuthAccountDetails> {
    const descriptor = oauthMethodFor(idOrProvider);
    if (descriptor === undefined || !isDeviceOAuthMethod(descriptor.id)) return {};
    const state = classifyToken(await this.storageFor(descriptor).load(storageNameFor(descriptor)));
    if (state.kind !== 'valid') return {};
    if (descriptor.id === 'openai-codex') {
      return { accountId: openaiCodexAccountId(state.token.accessToken) };
    }
    if (descriptor.id === 'grok-build') {
      const sub = decodeJwtPayload(state.token.accessToken)?.['sub'];
      return { accountId: typeof sub === 'string' && sub.length > 0 ? sub : undefined };
    }
    if (descriptor.id !== 'github-copilot' || state.token.refreshToken.length === 0) return {};
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const request = async (url: string): Promise<unknown> => {
      const response = await fetchImpl(url, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${state.token.refreshToken}`,
          'User-Agent': 'GitHubCopilotChat/0.35.0',
          'Editor-Version': 'vscode/1.107.0',
          'Editor-Plugin-Version': 'copilot-chat/0.35.0',
          'X-GitHub-Api-Version': '2025-04-01',
        },
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok ? response.json() : undefined;
    };
    const [user, usage] = await Promise.allSettled([
      request('https://api.github.com/user'),
      request('https://api.github.com/copilot_internal/user'),
    ]);
    const account = user.status === 'fulfilled' ? user.value : undefined;
    return {
      accountId: isRecord(account) && typeof account['login'] === 'string' && account['login'].length > 0
        ? account['login'] : undefined,
      quota: usage.status === 'fulfilled' ? copilotQuota(usage.value) : undefined,
    };
  }

  tokenProvider(idOrProvider: string): BearerTokenProvider {
    return {
      getAccessToken: (options) =>
        this.manager(idOrProvider).ensureFresh({ force: options?.force === true }),
    };
  }
}
