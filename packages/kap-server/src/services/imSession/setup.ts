import { randomBytes } from 'node:crypto';

import { imSetupCatalogSchema, type ImPasteResult, type ImSetupCatalog, type ImSetupProvider, type ImSetupRequest, type ImSetupResult } from '@kiki/protocol';
import { SESSION_CAPABILITIES, SESSION_SETUP, discoverMatrix, discordInstallUrl, exchangeMatrixLogin, exchangeSlackOAuth, matrixPasswordLogin, matrixSsoUrl, slackManifestInstallUrl, slackOAuthUrl } from '@nb-im/core';

interface SetupAttempt {
  provider: 'slack' | 'matrix';
  expiresAt: number;
  redirectUri: string;
  instanceId?: string;
  homeserver?: string;
  clientId?: string;
  state?: string;
}

export function imSetupCatalog(): ImSetupCatalog {
  return imSetupCatalogSchema.parse({ platforms: (['discord', 'slack', 'matrix'] as const).map((provider) => ({
    provider_kind: provider, ...SESSION_SETUP[provider], capabilities: SESSION_CAPABILITIES[provider],
  })) });
}

export class ImSessionSetup {
  private readonly attempts = new Map<string, SetupAttempt>();

  constructor(private readonly save: (provider: ImSetupProvider, fields: Readonly<Record<string, string>>, instanceId?: string) => Promise<ImPasteResult>) {}

  async run(input: ImSetupRequest): Promise<ImSetupResult> {
    if (input.action === 'save') return this.saved(input.provider_kind, input.fields, input.instance_id);
    if (input.action === 'discord_install') return { kind: 'link', url: discordInstallUrl(input.application_id, input.guild_id) };
    if (input.action === 'slack_manifest') return { kind: 'link', url: slackManifestInstallUrl(input.name) };
    if (input.action === 'matrix_discover') return { kind: 'discovery', ...await discoverMatrix(input.server, AbortSignal.timeout(15000)) };
    if (input.action === 'slack_oauth_begin') {
      const state = randomBytes(24).toString('hex');
      const url = slackOAuthUrl({ client_id: input.client_id, redirect_uri: input.redirect_uri, state });
      const attemptId = this.begin({ provider: 'slack', redirectUri: input.redirect_uri, clientId: input.client_id, state, instanceId: input.instance_id });
      return { kind: 'link', url, attempt_id: attemptId, callback_uri: input.redirect_uri };
    }
    if (input.action === 'slack_oauth_complete') {
      const attempt = this.take(input.attempt_id, 'slack');
      if (input.state !== attempt.state) throw new Error('setup_oauth_state_mismatch');
      const result = await exchangeSlackOAuth({ client_id: attempt.clientId!, client_secret: input.client_secret, code: input.code, redirect_uri: attempt.redirectUri, state: input.state, expected_state: attempt.state! }, AbortSignal.timeout(15000));
      return this.saved('slack', { bot_token: result.bot_token, app_token: input.app_token }, attempt.instanceId);
    }
    if (input.action === 'matrix_sso_begin') {
      const callback = new URL(input.redirect_uri);
      if (callback.search || callback.hash) throw new Error('setup_callback_uri');
      callback.searchParams.set('kiki_im_state', randomBytes(24).toString('hex'));
      const redirectUri = callback.href;
      const url = matrixSsoUrl(input.homeserver, redirectUri, input.idp_id);
      const attemptId = this.begin({ provider: 'matrix', homeserver: input.homeserver, redirectUri, instanceId: input.instance_id });
      return { kind: 'link', url, attempt_id: attemptId, callback_uri: redirectUri };
    }
    if (input.action === 'matrix_sso_complete') {
      const attempt = this.take(input.attempt_id, 'matrix');
      const callback = new URL(input.callback_uri);
      callback.searchParams.delete('loginToken');
      if (callback.href !== attempt.redirectUri) throw new Error('setup_callback_mismatch');
      const result = await exchangeMatrixLogin({ homeserver: attempt.homeserver!, login_token: input.login_token }, AbortSignal.timeout(15000));
      return this.saved('matrix', { homeserver: result.homeserver, access_token: result.access_token }, attempt.instanceId);
    }
    const result = await matrixPasswordLogin({ homeserver: input.homeserver, user: input.user, password: input.password }, AbortSignal.timeout(15000));
    return this.saved('matrix', { homeserver: result.homeserver, access_token: result.access_token }, input.instance_id);
  }

  clear(): void { this.attempts.clear(); }

  private async saved(provider: ImSetupProvider, fields: Readonly<Record<string, string>>, instanceId?: string): Promise<ImSetupResult> {
    const descriptor = SESSION_SETUP[provider];
    const known = new Set<string>(descriptor.fields.map((field) => field.key));
    if (Object.keys(fields).some((key) => !known.has(key)) || descriptor.fields.some((field) => field.required && !fields[field.key]?.trim())) throw new Error('setup_fields_invalid');
    if (provider === 'matrix') matrixSsoUrl(fields['homeserver']!, 'http://127.0.0.1/');
    return { kind: 'saved', result: await this.save(provider, fields, instanceId) };
  }

  private begin(input: Omit<SetupAttempt, 'expiresAt'>): string {
    for (const [id, attempt] of this.attempts) if (attempt.expiresAt <= Date.now()) this.attempts.delete(id);
    if (this.attempts.size >= 32) throw new Error('setup_attempt_limit');
    const id = randomBytes(18).toString('hex');
    this.attempts.set(id, { ...input, expiresAt: Date.now() + 10 * 60 * 1000 });
    return id;
  }

  private take(id: string, provider: SetupAttempt['provider']): SetupAttempt {
    const attempt = this.attempts.get(id);
    if (attempt === undefined || attempt.provider !== provider || attempt.expiresAt <= Date.now()) throw new Error('setup_attempt_expired');
    this.attempts.delete(id);
    return attempt;
  }
}
