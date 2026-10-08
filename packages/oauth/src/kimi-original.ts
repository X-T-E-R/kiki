import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { KIMI_CODE_FLOW_CONFIG } from './constants';
import { OAuthError, OAuthUnauthorizedError } from './errors';
import { inspectTokenStorage, resolveTokenStorage, type ResolveTokenStorageDeps } from './keyring-storage';
import type { LocalOriginalOAuthProbe, LocalOriginalOAuthSourceRef } from './local-original-types';
import { defaultRefreshThreshold, OAuthManager } from './oauth-manager';
import type { OAuthManagerOptions } from './oauth-manager';
import { classifyToken } from './token-state';

export interface KimiOriginalOAuthOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly storageDeps?: ResolveTokenStorageDeps;
  readonly managerOptions?: Pick<OAuthManagerOptions, 'now' | 'refreshTokenImpl' | 'refreshThreshold'>;
}

export class KimiOriginalOAuthService {
  private readonly managers = new Map<string, OAuthManager>();
  private readonly disconnected = new Set<string>();

  constructor(private readonly options: KimiOriginalOAuthOptions = {}) {}

  private home(requested?: string): string {
    const path = requested ?? (this.options.env ?? process.env)['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code');
    if (!isAbsolute(path)) throw new OAuthError('The original Kimi Code directory must be absolute on the Kiki server.');
    return resolve(path);
  }

  private async inspect(homeDir: string, pinned?: LocalOriginalOAuthSourceRef) {
    const snapshot = await inspectTokenStorage(join(homeDir, 'credentials'), 'kimi-code', this.options.storageDeps);
    if (pinned !== undefined && (pinned.provider !== 'kimi-code' || pinned.storageBackend !== snapshot.backend || pinned.authFile !== join(homeDir, 'credentials', 'kimi-code.json'))) {
      throw new OAuthError('Original Kimi Code storage changed; reconnect this source explicitly.');
    }
    return snapshot;
  }

  async probe(requestedHome?: string, pinned?: LocalOriginalOAuthSourceRef): Promise<LocalOriginalOAuthProbe> {
    let homeDir = requestedHome ?? '';
    try {
      homeDir = this.home(requestedHome);
      const snapshot = await this.inspect(homeDir, pinned);
      const token = classifyToken(snapshot.token);
      const sourceRef: LocalOriginalOAuthSourceRef = { kind: 'local_original', provider: 'kimi-code', homeDir,
        storageBackend: snapshot.backend, authFile: join(homeDir, 'credentials', 'kimi-code.json') };
      const now = this.options.managerOptions?.now?.() ?? Math.floor(Date.now() / 1000);
      const threshold = this.options.managerOptions?.refreshThreshold ?? defaultRefreshThreshold;
      const state = token.kind === 'missing' || token.kind === 'revoked' || this.disconnected.has(homeDir) ? 'signed_out'
        : token.token.expiresAt - now < threshold(token.token.expiresIn) ? 'refresh_required' : 'ready';
      return { provider: 'kimi-code', homeDir, storageBackend: snapshot.backend, state,
        account: { state: 'unknown' }, canConnect: state === 'ready' || state === 'refresh_required', sourceRef };
    } catch (error) {
      return { provider: 'kimi-code', homeDir, storageBackend: pinned?.storageBackend ?? null, state: 'unreadable',
        account: { state: 'unknown' }, canConnect: false,
        reason: error instanceof OAuthError ? error.message : 'The original Kimi Code credentials could not be read.' };
    }
  }

  async connect(homeDir?: string): Promise<LocalOriginalOAuthSourceRef> {
    const home = this.home(homeDir);
    this.disconnected.delete(home);
    const probe = await this.probe(home);
    if (!probe.canConnect || probe.sourceRef === undefined) throw new OAuthUnauthorizedError(probe.reason ?? 'No original Kimi Code sign-in was found.');
    await this.getAccessToken(probe.sourceRef);
    return probe.sourceRef;
  }

  async disconnect(ref: LocalOriginalOAuthSourceRef): Promise<void> {
    this.disconnected.add(this.home(ref.homeDir));
  }

  async getCachedAccessToken(ref: LocalOriginalOAuthSourceRef): Promise<string | undefined> {
    const home = this.home(ref.homeDir);
    if (this.disconnected.has(home)) return undefined;
    const state = classifyToken((await this.inspect(home, ref)).token);
    return state.kind === 'valid' ? state.token.accessToken : undefined;
  }

  async getAccessToken(ref: LocalOriginalOAuthSourceRef, options?: { readonly force?: boolean }): Promise<string> {
    const home = this.home(ref.homeDir);
    if (this.disconnected.has(home)) throw new OAuthUnauthorizedError('This original Kimi Code source is disconnected from Kiki.');
    await this.inspect(home, ref);
    let manager = this.managers.get(home);
    if (manager === undefined) {
      manager = new OAuthManager({ config: KIMI_CODE_FLOW_CONFIG, configDir: home,
        storage: resolveTokenStorage(join(home, 'credentials'), this.options.storageDeps), ...this.options.managerOptions });
      this.managers.set(home, manager);
    }
    return manager.ensureFresh(options);
  }
}
