import { createHash, randomBytes } from 'node:crypto';

import type { IAtomicDocumentStore } from '@kiki/agent-core-v2';
import {
  AccessDeniedError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
  ServerError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import { isActiveExternalClientGrant, type ExternalClientGrant } from './host';

const DOCUMENT_KEY = 'state.json';
const DOCUMENT_VERSION = 1;
const DEFAULT_SCOPE = 'credentials';
const ACCESS_TOKEN_TTL_SECONDS = 300;
const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const AUTHORIZATION_CODE_TTL_MS = 120_000;
const CONSENT_TTL_MS = 120_000;

type OAuthResponse = Parameters<OAuthServerProvider['authorize']>[2];
type ClientRegistration = Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'> & {
  readonly client_id?: string;
  readonly client_id_issued_at?: number;
};

interface PendingConsentRecord {
  readonly id: string;
  readonly clientId: string;
  readonly clientName?: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly resource: string;
  readonly codeChallenge: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly status: 'pending' | 'approved' | 'denied' | 'expired';
  readonly connectionId?: string;
}

interface AuthorizationCodeRecord {
  readonly clientId: string;
  readonly grantId: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly resource: string;
  readonly codeChallenge: string;
  readonly expiresAt: number;
}

interface AccessTokenRecord {
  readonly clientId: string;
  readonly grantId: string;
  readonly scopes: readonly string[];
  readonly resource: string;
  readonly audience: string;
  readonly expiresAt: number;
}

interface RefreshTokenRecord {
  readonly clientId: string;
  readonly grantId: string;
  readonly scopes: readonly string[];
  readonly resource: string;
  readonly audience: string;
  readonly expiresAt: number;
}

interface OAuthDocument {
  readonly version: 1;
  readonly clients: Record<string, OAuthClientInformationFull>;
  readonly pending: Record<string, PendingConsentRecord>;
  readonly codes: Record<string, AuthorizationCodeRecord>;
  readonly accessTokens: Record<string, AccessTokenRecord>;
  readonly refreshTokens: Record<string, RefreshTokenRecord>;
}

export interface ExternalClientPendingConsent {
  readonly id: string;
  readonly clientId: string;
  readonly clientName?: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly resource: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface ExternalClientConsentResponse {
  readonly connectionId: string;
  readonly approved: boolean;
}

export interface ExternalClientOAuthOptions {
  readonly issuerUrl: URL;
  readonly resourceServerUrl: URL;
  readonly host: {
    resolveGrant(grantId: string): ExternalClientGrant | null | Promise<ExternalClientGrant | null>;
  };
  readonly store?: IAtomicDocumentStore;
  readonly storeScope?: string;
  readonly scopesSupported?: readonly string[];
  readonly consentTimeoutMs?: number;
}

export class ExternalClientOAuthService implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  readonly provider: OAuthServerProvider;
  private readonly store: IAtomicDocumentStore | undefined;
  private readonly storeScope: string;
  private readonly issuerUrl: URL;
  private readonly resourceServerUrl: URL;
  private readonly host: ExternalClientOAuthOptions['host'];
  private readonly scopesSupported: readonly string[];
  private readonly consentTimeoutMs: number;
  private readonly waiters = new Map<string, { readonly resolve: (record: PendingConsentRecord) => void; readonly reject: (error: unknown) => void }>();
  private mutation = Promise.resolve();
  private memoryDocument: OAuthDocument = emptyDocument();

  constructor(options: ExternalClientOAuthOptions) {
    this.store = options.store;
    this.storeScope = options.storeScope ?? DEFAULT_SCOPE;
    this.issuerUrl = new URL(options.issuerUrl.href);
    this.resourceServerUrl = new URL(options.resourceServerUrl.href);
    this.host = options.host;
    this.scopesSupported = [...new Set(options.scopesSupported ?? [])];
    this.consentTimeoutMs = Math.max(1_000, options.consentTimeoutMs ?? CONSENT_TTL_MS);
    this.clientsStore = {
      getClient: (clientId) => this.getClient(clientId),
      registerClient: (client) => this.registerClient(client),
    };
    this.provider = this;
  }

  get issuer(): URL {
    return new URL(this.issuerUrl.href);
  }

  get resource(): URL {
    return new URL(this.resourceServerUrl.href);
  }

  get scopes(): readonly string[] {
    return this.scopesSupported;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, response: OAuthResponse): Promise<void> {
    const requestedResource = params.resource?.href ?? this.resourceServerUrl.href;
    if (!sameResource(requestedResource, this.resourceServerUrl.href)) {
      throw new InvalidTargetError('The authorization resource does not match this MCP resource.');
    }
    const scopes = normalizeScopes(params.scopes ?? []);
    ensureScopesSupported(scopes, this.scopesSupported);
    const now = Date.now();
    const pending: PendingConsentRecord = {
      id: randomId('consent'),
      clientId: client.client_id,
      clientName: client.client_name,
      redirectUri: params.redirectUri,
      scopes,
      resource: this.resourceServerUrl.href,
      codeChallenge: params.codeChallenge,
      createdAt: now,
      expiresAt: now + this.consentTimeoutMs,
      status: 'pending',
    };
    await this.mutate((document) => ({
      ...document,
      pending: { ...document.pending, [pending.id]: pending },
    }));
    const decision = await this.waitForConsent(pending);
    if (decision.status !== 'approved' || decision.connectionId === undefined) {
      throw new AccessDeniedError('The Kiki owner denied this authorization request.');
    }
    const grant = await this.host.resolveGrant(decision.connectionId);
    if (!isActiveExternalClientGrant(grant)) {
      throw new AccessDeniedError('The selected Kiki connection is unavailable.');
    }
    if (!sameResource(grant.resource, this.resourceServerUrl.href) || !sameResource(grant.audience, this.resourceServerUrl.href)) {
      throw new AccessDeniedError('The selected Kiki connection is not valid for this resource.');
    }
    ensureGrantScopes(grant, scopes);
    const code = randomToken(32);
    const codeRecord: AuthorizationCodeRecord = {
      clientId: client.client_id,
      grantId: grant.id,
      redirectUri: params.redirectUri,
      scopes,
      resource: this.resourceServerUrl.href,
      codeChallenge: params.codeChallenge,
      expiresAt: Date.now() + AUTHORIZATION_CODE_TTL_MS,
    };
    await this.mutate((document) => ({
      ...document,
      pending: removeRecord(document.pending, pending.id),
      codes: { ...document.codes, [hash(code)]: codeRecord },
    }));
    const redirect = new URL(params.redirectUri);
    redirect.searchParams.set('code', code);
    if (params.state !== undefined) redirect.searchParams.set('state', params.state);
    response.redirect(302, redirect.href);
  }

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const record = (await this.read()).codes[hash(authorizationCode)];
    if (record === undefined || record.expiresAt <= Date.now()) throw new InvalidGrantError('The authorization code is invalid or expired.');
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const key = hash(authorizationCode);
    const document = await this.read();
    const record = document.codes[key];
    if (record === undefined || record.expiresAt <= Date.now() || record.clientId !== client.client_id) {
      throw new InvalidGrantError('The authorization code is invalid or expired.');
    }
    if (redirectUri !== undefined && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError('The redirect_uri does not match the authorization request.');
    }
    ensureResource(resource, record.resource);
    const grant = await this.host.resolveGrant(record.grantId);
    if (!isActiveExternalClientGrant(grant)) throw new InvalidGrantError('The Kiki connection has been revoked.');
    ensureGrantScopes(grant, record.scopes);
    const tokens = issueTokens(client.client_id, grant, record.scopes, record.resource);
    await this.mutate((current) => ({
      ...current,
      codes: removeRecord(current.codes, key),
      accessTokens: { ...current.accessTokens, [hash(tokens.access_token)]: tokens.access },
      refreshTokens: { ...current.refreshTokens, [hash(tokens.refresh_token)]: tokens.refresh },
    }));
    return tokens.response;
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const key = hash(refreshToken);
    const document = await this.read();
    const record = document.refreshTokens[key];
    if (record === undefined || record.expiresAt <= Date.now() || record.clientId !== client.client_id) {
      throw new InvalidGrantError('The refresh token is invalid or expired.');
    }
    ensureResource(resource, record.resource);
    const requestedScopes = scopes === undefined ? record.scopes : normalizeScopes(scopes);
    if (!isSubset(requestedScopes, record.scopes)) throw new InvalidScopeError('The requested scope exceeds the granted scope.');
    const grant = await this.host.resolveGrant(record.grantId);
    if (!isActiveExternalClientGrant(grant)) throw new InvalidGrantError('The Kiki connection has been revoked.');
    ensureGrantScopes(grant, requestedScopes);
    const tokens = issueTokens(client.client_id, grant, requestedScopes, record.resource);
    await this.mutate((current) => ({
      ...current,
      refreshTokens: {
        ...removeRecord(current.refreshTokens, key),
        [hash(tokens.refresh_token)]: tokens.refresh,
      },
      accessTokens: { ...current.accessTokens, [hash(tokens.access_token)]: tokens.access },
    }));
    return tokens.response;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = (await this.read()).accessTokens[hash(token)];
    if (record === undefined || record.expiresAt <= Math.floor(Date.now() / 1000)) {
      throw new InvalidTokenError('The access token is invalid or expired.');
    }
    const grant = await this.host.resolveGrant(record.grantId);
    if (!isActiveExternalClientGrant(grant)) throw new InvalidTokenError('The Kiki connection has been revoked.');
    ensureGrantScopes(grant, record.scopes);
    return {
      token,
      clientId: record.clientId,
      scopes: [...record.scopes],
      expiresAt: record.expiresAt,
      resource: new URL(record.resource),
      extra: { grantId: grant.id, audience: grant.audience },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await this.mutate((document) => {
      const key = hash(request.token);
      const access = document.accessTokens[key];
      if (access?.clientId === client.client_id) {
        return { ...document, accessTokens: removeRecord(document.accessTokens, key) };
      }
      const refresh = document.refreshTokens[key];
      if (refresh?.clientId === client.client_id) {
        return { ...document, refreshTokens: removeRecord(document.refreshTokens, key) };
      }
      return document;
    });
  }

  async listPending(): Promise<readonly ExternalClientPendingConsent[]> {
    const now = Date.now();
    const document = await this.read();
    const pending = Object.values(document.pending).filter((record) => record.status === 'pending' && record.expiresAt > now);
    return pending.map(toPendingView);
  }

  async respondPending(id: string, response: ExternalClientConsentResponse): Promise<void> {
    const document = await this.read();
    const pending = document.pending[id];
    if (pending === undefined || pending.status !== 'pending' || pending.expiresAt <= Date.now()) {
      throw new Error('External client consent request is unavailable.');
    }
    if (!response.approved) {
      await this.resolvePending({ ...pending, status: 'denied' });
      return;
    }
    const grant = await this.host.resolveGrant(response.connectionId);
    if (!isActiveExternalClientGrant(grant)) throw new Error('External client connection is unavailable.');
    if (!sameResource(grant.resource, pending.resource) || !sameResource(grant.audience, this.resourceServerUrl.href)) {
      throw new Error('External client connection resource is invalid.');
    }
    ensureGrantScopes(grant, pending.scopes);
    await this.resolvePending({ ...pending, status: 'approved', connectionId: grant.id });
  }

  private async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return (await this.read()).clients[clientId];
  }

  private async registerClient(client: ClientRegistration): Promise<OAuthClientInformationFull> {
    const clientId = client.client_id ?? randomId('client');
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: clientId,
      client_id_issued_at: client.client_id_issued_at ?? Math.floor(Date.now() / 1000),
    } as OAuthClientInformationFull;
    await this.mutate((document) => ({ ...document, clients: { ...document.clients, [clientId]: full } }));
    return full;
  }

  private waitForConsent(pending: PendingConsentRecord): Promise<PendingConsentRecord> {
    return new Promise<PendingConsentRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        void this.expirePending(pending.id).then((record) => {
          const waiter = this.waiters.get(pending.id);
          if (waiter === undefined) return;
          if (record?.status === 'approved' || record?.status === 'denied') {
            waiter.resolve(record);
            return;
          }
          waiter.reject(new ServerError('The owner did not respond to the authorization request in time.'));
        }, (error: unknown) => {
          this.waiters.get(pending.id)?.reject(error);
        });
      }, Math.max(1_000, pending.expiresAt - Date.now()));
      this.waiters.set(pending.id, {
        resolve: (record) => {
          clearTimeout(timer);
          this.waiters.delete(pending.id);
          resolve(record);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.waiters.delete(pending.id);
          reject(error);
        },
      });
      void this.read().then((document) => {
        const persisted = document.pending[pending.id];
        if (persisted === undefined || persisted.status === 'pending') return;
        const waiter = this.waiters.get(pending.id);
        if (waiter === undefined) return;
        if (persisted.status === 'approved' || persisted.status === 'denied') waiter.resolve(persisted);
        else waiter.reject(new ServerError('The authorization request expired.'));
      }).catch((error: unknown) => {
        this.waiters.get(pending.id)?.reject(error);
      });
    });
  }

  private async resolvePending(record: PendingConsentRecord): Promise<void> {
    await this.mutate((document) => ({ ...document, pending: { ...document.pending, [record.id]: record } }));
    const waiter = this.waiters.get(record.id);
    if (waiter !== undefined) {
      if (record.status === 'approved' || record.status === 'denied') waiter.resolve(record);
      if (record.status === 'expired') waiter.reject(new ServerError('The authorization request expired.'));
    }
  }

  private async expirePending(id: string): Promise<PendingConsentRecord | undefined> {
    let result: PendingConsentRecord | undefined;
    await this.mutate((document) => {
      const current = document.pending[id];
      result = current;
      if (current === undefined || current.status !== 'pending') return document;
      result = { ...current, status: 'expired' };
      return { ...document, pending: { ...document.pending, [id]: result } };
    });
    return result;
  }

  private async read(): Promise<OAuthDocument> {
    if (this.store === undefined) return this.memoryDocument;
    const value = await this.store.get<OAuthDocument>(this.storeScope, DOCUMENT_KEY);
    if (value === undefined) return emptyDocument();
    return normalizeDocument(value);
  }

  private async mutate(work: (document: OAuthDocument) => OAuthDocument): Promise<void> {
    const operation = this.mutation.then(async () => {
      if (this.store === undefined) {
        this.memoryDocument = work(this.memoryDocument);
        return;
      }
      await this.store.update<OAuthDocument>(this.storeScope, DOCUMENT_KEY, (current) => work(current === undefined ? emptyDocument() : normalizeDocument(current)));
    });
    this.mutation = operation.then(() => undefined, () => undefined);
    await operation;
  }
}

function emptyDocument(): OAuthDocument {
  return { version: DOCUMENT_VERSION, clients: {}, pending: {}, codes: {}, accessTokens: {}, refreshTokens: {} };
}

function normalizeDocument(value: OAuthDocument): OAuthDocument {
  if (value.version !== DOCUMENT_VERSION) throw new Error('External client OAuth state version is unsupported.');
  return {
    version: DOCUMENT_VERSION,
    clients: value.clients ?? {},
    pending: value.pending ?? {},
    codes: value.codes ?? {},
    accessTokens: value.accessTokens ?? {},
    refreshTokens: value.refreshTokens ?? {},
  };
}

function randomId(prefix: string): string {
  return `${prefix}_${randomToken(18)}`;
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function removeRecord<T>(records: Record<string, T>, key: string): Record<string, T> {
  const next = { ...records };
  delete next[key];
  return next;
}

function normalizeScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
}

function ensureScopesSupported(scopes: readonly string[], supported: readonly string[]): void {
  if (supported.length > 0 && !isSubset(scopes, supported)) throw new InvalidScopeError('The requested scope is not supported.');
}

function ensureGrantScopes(grant: ExternalClientGrant, scopes: readonly string[]): void {
  if (!isSubset(scopes, grant.scopes)) throw new InvalidScopeError('The selected connection does not grant the requested scope.');
}

function isSubset(values: readonly string[], allowed: readonly string[]): boolean {
  const permitted = new Set(allowed);
  return values.every((value) => permitted.has(value));
}

function sameResource(left: string, right: string): boolean {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return false;
  }
}

function ensureResource(resource: URL | undefined, expected: string): void {
  if (resource !== undefined && !sameResource(resource.href, expected)) throw new InvalidTargetError('The token resource does not match this MCP resource.');
}

function issueTokens(clientId: string, grant: ExternalClientGrant, scopes: readonly string[], resource: string): {
  readonly response: OAuthTokens;
  readonly access_token: string;
  readonly refresh_token: string;
  readonly access: AccessTokenRecord;
  readonly refresh: RefreshTokenRecord;
} {
  const now = Math.floor(Date.now() / 1000);
  const access_token = randomToken(32);
  const refresh_token = randomToken(48);
  const access: AccessTokenRecord = {
    clientId,
    grantId: grant.id,
    scopes: [...scopes],
    resource,
    audience: grant.audience,
    expiresAt: now + ACCESS_TOKEN_TTL_SECONDS,
  };
  const refresh: RefreshTokenRecord = {
    clientId,
    grantId: grant.id,
    scopes: [...scopes],
    resource,
    audience: grant.audience,
    expiresAt: now + REFRESH_TOKEN_TTL_SECONDS,
  };
  return {
    response: {
      access_token,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token,
      scope: scopes.join(' '),
    },
    access_token,
    refresh_token,
    access,
    refresh,
  };
}

function toPendingView(record: PendingConsentRecord): ExternalClientPendingConsent {
  return {
    id: record.id,
    clientId: record.clientId,
    clientName: record.clientName,
    redirectUri: record.redirectUri,
    scopes: [...record.scopes],
    resource: record.resource,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}
