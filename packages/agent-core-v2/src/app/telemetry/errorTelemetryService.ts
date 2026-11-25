import { randomUUID } from 'node:crypto';

import { createDecorator } from '#/_base/di/instantiation';
import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { addUnexpectedErrorListener } from '#/_base/errors/unexpectedError';
import { IConfigService } from '#/app/config/config';
import { CREDENTIALS_POOL_SECTION, resolvePoolCredential, type CredentialsPoolSection } from '#/app/config/credentialPool';
import { PROVIDERS_SECTION } from '#/app/kosongConfig/configSection';
import { LifecycleScope } from '#/app/scopes';
import type { ProvidersSection } from '#/kosong/provider/provider';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { resolveCoreVersion } from './coreVersion';
import { ERROR_TELEMETRY_SECTION, type ErrorTelemetryConfig } from './errorTelemetryConfig';
import { ITelemetryService, type ITelemetryAppender, type TelemetryProperties } from './telemetry';

const CLIENT_ID_SCOPE = 'telemetry';
const CLIENT_ID_KEY = 'client-id.json';
const MAX_QUEUE_SIZE = 200;
const REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2000;
const MAX_MESSAGE_LENGTH = 500;
const MAX_IDENTIFIER_LENGTH = 128;

const URL_PATTERN = /\bhttps?:\/\/[^\s"'`<>|]+/gi;

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|authorization)\s*[:=]\s*["']?[^\s"',;}{]+["']?/gi,
];

const PATH_PATTERNS: readonly RegExp[] = [
  /file:\/\/[^\s"'`<>|]+/gi,
  /[A-Za-z]:\\[^\s"'`<>|]+/g,
  /\\\\[^\s"'`<>|]+/g,
  /\/(?:Users|home|root|var|tmp|opt|etc|Volumes|private|mnt|srv)\/[^\s"'`<>|]+/g,
];

const ERROR_EVENT_NAME_PATTERN = /(?:^error$|_error$|_failed$|^error_|^api_error$)/i;

/** Single sanitized error telemetry event included in an outbound batch. */
export interface SanitizedErrorTelemetryEvent {
  readonly ts: string;
  readonly category: string;
  readonly event: string;
  readonly error_code?: string;
  readonly status_code?: number;
  readonly model_id?: string;
  readonly provider_id?: string;
  readonly tool_name?: string;
  readonly duration_ms?: number;
  readonly message_redacted?: string;
}

/** Outbound error telemetry payload envelope (`schema_version: 1`). */
export interface ErrorTelemetryBatchPayload {
  readonly schema_version: 1;
  readonly client_id: string;
  readonly kiki_version: string;
  readonly os: NodeJS.Platform;
  readonly arch: string;
  readonly events: readonly SanitizedErrorTelemetryEvent[];
}

/** Scrubs filesystem paths, URLs, and credential-like tokens from free-form error strings. */
export function sanitizeErrorTelemetryMessage(raw: string): string {
  let scrubbed = raw;
  for (const pattern of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, '<redacted>');
  }
  scrubbed = scrubbed.replace(URL_PATTERN, '<url>');
  for (const pattern of PATH_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, '<path>');
  }
  const compact = scrubbed.replace(/\s+/g, ' ').trim();
  return compact.length > MAX_MESSAGE_LENGTH ? `${compact.slice(0, MAX_MESSAGE_LENGTH - 3)}...` : compact;
}

function sanitizeTelemetryIdentifier(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const cleaned = sanitizeErrorTelemetryMessage(raw).replace(/[\r\n\t]+/g, ' ').trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > MAX_IDENTIFIER_LENGTH ? cleaned.slice(0, MAX_IDENTIFIER_LENGTH) : cleaned;
}

/** Returns whether a telemetry event represents an error or failure eligible for error telemetry. */
export function isErrorTelemetryEvent(event: string, properties?: TelemetryProperties): boolean {
  if (ERROR_EVENT_NAME_PATTERN.test(event)) return true;
  if (properties === undefined) return false;
  if (typeof properties['error_type'] === 'string' && properties['error_type'].length > 0) return true;
  if (typeof properties['error_code'] === 'string' && properties['error_code'].length > 0) return true;
  if (properties['status'] === 'failed' || properties['status'] === 'error') return true;
  if (properties['outcome'] === 'error') return true;
  if (properties['reason'] === 'failed') return true;
  if (properties['interrupt_reason'] === 'error') return true;
  return false;
}

function inferCategory(event: string, properties?: TelemetryProperties): string {
  if (event === 'api_error' || event.startsWith('api_') || event.startsWith('provider_')) return 'api';
  if (event.startsWith('tool_') || typeof properties?.['tool_name'] === 'string') return 'tool';
  if (event.startsWith('compaction_')) return 'compaction';
  if (event.startsWith('turn_') || event.startsWith('step_')) return 'turn';
  if (event === 'unexpected_error') return 'unexpected';
  return 'telemetry';
}

function stringProp(properties: TelemetryProperties | undefined, ...keys: string[]): string | undefined {
  if (properties === undefined) return undefined;
  for (const key of keys) {
    const value = properties[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function numberProp(properties: TelemetryProperties | undefined, ...keys: string[]): number | undefined {
  if (properties === undefined) return undefined;
  for (const key of keys) {
    const value = properties[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** Projects a raw telemetry event into the strict allowlisted error telemetry shape. */
export function projectErrorTelemetryEvent(
  event: string,
  properties?: TelemetryProperties,
  now = new Date(),
): SanitizedErrorTelemetryEvent | undefined {
  if (!isErrorTelemetryEvent(event, properties)) return undefined;
  const errorCode = sanitizeTelemetryIdentifier(stringProp(properties, 'error_code', 'error_type'));
  const statusCode = numberProp(properties, 'status_code');
  const modelId = sanitizeTelemetryIdentifier(stringProp(properties, 'model_id', 'alias', 'model'));
  const providerId = sanitizeTelemetryIdentifier(stringProp(properties, 'provider_id', 'provider_type'));
  const toolName = sanitizeTelemetryIdentifier(stringProp(properties, 'tool_name'));
  const durationMs = numberProp(properties, 'duration_ms');
  const safeEvent = sanitizeTelemetryIdentifier(event) ?? 'error';
  return {
    ts: now.toISOString(),
    category: inferCategory(event, properties),
    event: safeEvent,
    ...(errorCode === undefined ? {} : { error_code: errorCode }),
    ...(statusCode === undefined ? {} : { status_code: statusCode }),
    ...(modelId === undefined ? {} : { model_id: modelId }),
    ...(providerId === undefined ? {} : { provider_id: providerId }),
    ...(toolName === undefined ? {} : { tool_name: toolName }),
    ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
  };
}

/** Projects an uncaught/unexpected Error into the strict allowlisted error telemetry shape. */
export function projectUnexpectedErrorEvent(err: unknown, now = new Date()): SanitizedErrorTelemetryEvent {
  const isError = err instanceof Error;
  const codeField = err !== null && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
    ? err.code
    : undefined;
  const statusField = err !== null && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
    ? err.status
    : err !== null && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number'
      ? err.statusCode
      : undefined;
  const rawCode = codeField ?? (isError && err.name ? err.name : 'UnexpectedError');
  const errorCode = sanitizeTelemetryIdentifier(rawCode) ?? 'UnexpectedError';
  return {
    ts: now.toISOString(),
    category: 'unexpected',
    event: 'unexpected_error',
    error_code: errorCode,
    ...(statusField === undefined ? {} : { status_code: statusField }),
  };
}

export interface ErrorTelemetryAppenderOptions {
  readonly getConfig: () => ErrorTelemetryConfig | undefined;
  readonly resolveBearerToken: (connection: string, endpoint: string) => string | undefined;
  readonly getClientId: () => Promise<string>;
  readonly fetchFn?: typeof fetch;
  readonly kikiVersion?: string;
}

/** Batched, opt-in HTTP appender that ships sanitized error telemetry when explicitly enabled. */
export class ErrorTelemetryAppender implements ITelemetryAppender {
  private readonly queue: SanitizedErrorTelemetryEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inflight: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly options: ErrorTelemetryAppenderOptions) {}

  track(event: string, properties?: TelemetryProperties): void {
    if (this.closed) return;
    const config = this.activeConfig();
    if (config === undefined) return;
    const projected = projectErrorTelemetryEvent(event, properties);
    if (projected === undefined) return;
    this.enqueue(projected, config);
  }

  captureUnexpectedError(err: unknown): void {
    if (this.closed) return;
    const config = this.activeConfig();
    if (config === undefined) return;
    this.enqueue(projectUnexpectedErrorEvent(err), config);
  }

  onConfigChanged(): void {
    if (this.activeConfig() === undefined) {
      this.clearTimer();
      this.queue.length = 0;
    }
  }

  async flush(): Promise<void> {
    this.clearTimer();
    if (this.inflight !== undefined) {
      await this.inflight;
      if (this.queue.length === 0) return;
    }
    const drain = (async () => {
      while (this.queue.length > 0) {
        const config = this.activeConfig();
        if (config === undefined) {
          this.queue.length = 0;
          return;
        }
        const batch = this.queue.splice(0, config.max_batch_size);
        await this.sendBatch(config, batch);
      }
    })();
    this.inflight = drain;
    try {
      await drain;
    } finally {
      if (this.inflight === drain) this.inflight = undefined;
    }
  }

  async shutdown(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    this.closed = true;
    const pending = this.flush();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        pending,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') {
            timer.unref();
          }
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private activeConfig(): (ErrorTelemetryConfig & { readonly endpoint: string }) | undefined {
    const config = this.options.getConfig();
    if (config === undefined || config.enabled !== true || !config.endpoint) return undefined;
    if (approvedTelemetryEndpointOrigin(config.endpoint) === undefined) return undefined;
    return config as ErrorTelemetryConfig & { readonly endpoint: string };
  }

  private enqueue(entry: SanitizedErrorTelemetryEvent, config: ErrorTelemetryConfig & { readonly endpoint: string }): void {
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      this.queue.shift();
    }
    this.queue.push(entry);
    if (this.queue.length >= config.max_batch_size) {
      void this.flush();
      return;
    }
    if (this.timer === undefined) {
      const handle = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, config.flush_interval_ms);
      if (typeof handle === 'object' && handle !== null && 'unref' in handle && typeof handle.unref === 'function') {
        handle.unref();
      }
      this.timer = handle;
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private async sendBatch(
    config: ErrorTelemetryConfig & { readonly endpoint: string },
    events: readonly SanitizedErrorTelemetryEvent[],
  ): Promise<void> {
    if (events.length === 0) return;
    try {
      const clientId = await this.options.getClientId();
      const payload: ErrorTelemetryBatchPayload = {
        schema_version: 1,
        client_id: clientId,
        kiki_version: this.options.kikiVersion ?? resolveCoreVersion(),
        os: process.platform,
        arch: process.arch,
        events,
      };
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (config.connection !== undefined) {
        const token = this.options.resolveBearerToken(config.connection, config.endpoint);
        if (token !== undefined && token.length > 0) {
          headers['authorization'] = `Bearer ${token}`;
        }
      }
      const fetchFn = this.options.fetchFn ?? globalThis.fetch;
      await fetchFn(config.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
    }
  }
}

export interface IErrorTelemetryService {
  readonly _serviceBrand: undefined;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export const IErrorTelemetryService = createDecorator<IErrorTelemetryService>('errorTelemetryService');

/** App-scope service attaching the opt-in `[error_telemetry]` appender to `ITelemetryService`. */
export class ErrorTelemetryService extends Disposable implements IErrorTelemetryService {
  declare readonly _serviceBrand: undefined;

  private readonly appender: ErrorTelemetryAppender;
  private clientIdPromise: Promise<string> | undefined;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @ITelemetryService telemetry: ITelemetryService,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
  ) {
    super();
    this.appender = new ErrorTelemetryAppender({
      getConfig: () => this.config.get<ErrorTelemetryConfig | undefined>(ERROR_TELEMETRY_SECTION),
      resolveBearerToken: (connection, endpoint) => this.resolveConnectionApiKey(connection, endpoint),
      getClientId: () => this.ensureClientId(),
    });
    this._register(telemetry.addAppender(this.appender));
    this._register(toDisposable(addUnexpectedErrorListener((err) => {
      this.appender.captureUnexpectedError(err);
    })));
    const onUncaught = (err: Error) => {
      this.appender.captureUnexpectedError(err);
    };
    process.on('uncaughtExceptionMonitor', onUncaught);
    this._register(toDisposable(() => {
      process.off('uncaughtExceptionMonitor', onUncaught);
    }));
    this._register(this.config.onDidChangeConfiguration((event) => {
      if (event.domain === ERROR_TELEMETRY_SECTION) {
        this.appender.onConfigChanged();
      }
    }));
  }

  flush(): Promise<void> {
    return this.appender.flush();
  }

  shutdown(): Promise<void> {
    return this.appender.shutdown();
  }

  override dispose(): void {
    void this.appender.shutdown();
    super.dispose();
  }

  private resolveConnectionApiKey(connection: string, endpoint: string): string | undefined {
    const endpointOrigin = approvedTelemetryEndpointOrigin(endpoint);
    if (endpointOrigin === undefined) return undefined;
    const providers = this.config.get<ProvidersSection | undefined>(PROVIDERS_SECTION);
    const provider = providers?.[connection];
    if (provider === undefined) return undefined;
    const providerOrigin = parseHttpOrigin(provider.baseUrl);
    if (providerOrigin === undefined || providerOrigin !== endpointOrigin) return undefined;
    if (typeof provider.apiKey === 'string' && provider.apiKey.trim().length > 0) {
      return provider.apiKey.trim();
    }
    if (typeof provider.apiKeyEnv === 'string' && provider.apiKeyEnv.trim().length > 0) {
      const envVal = process.env[provider.apiKeyEnv.trim()];
      if (typeof envVal === 'string' && envVal.trim().length > 0) return envVal.trim();
    }
    if (typeof provider.credentialId === 'string' && provider.credentialId.trim() === connection) {
      const fromPool = this.resolvePoolKey(connection);
      if (fromPool !== undefined) return fromPool;
    }
    return this.resolvePoolKey(connection);
  }

  private resolvePoolKey(id: string): string | undefined {
    const pool = this.config.get<CredentialsPoolSection | undefined>(CREDENTIALS_POOL_SECTION);
    const entry = pool?.[id];
    if (entry === undefined) return undefined;
    const resolved = resolvePoolCredential(entry);
    return resolved.apiKey !== undefined && resolved.apiKey.trim().length > 0 ? resolved.apiKey.trim() : undefined;
  }

  private ensureClientId(): Promise<string> {
    this.clientIdPromise ??= this.loadOrCreateClientId();
    return this.clientIdPromise;
  }

  private async loadOrCreateClientId(): Promise<string> {
    try {
      const existing = await this.storage.read(CLIENT_ID_SCOPE, CLIENT_ID_KEY, { recoverMissing: false });
      if (existing !== undefined) {
        const parsed = JSON.parse(new TextDecoder().decode(existing)) as { client_id?: unknown };
        if (typeof parsed.client_id === 'string' && parsed.client_id.trim().length > 0) {
          return parsed.client_id.trim();
        }
      }
    } catch {
    }
    const generated = randomUUID();
    try {
      await this.storage.write(
        CLIENT_ID_SCOPE,
        CLIENT_ID_KEY,
        new TextEncoder().encode(`${JSON.stringify({ client_id: generated })}\n`),
        { atomic: true },
      );
    } catch {
    }
    return generated;
  }
}

function parseHttpOrigin(rawUrl: string | undefined): string | undefined {
  if (rawUrl === undefined) return undefined;
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0 || !URL.canParse(trimmed)) return undefined;
  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  return parsed.origin.toLowerCase();
}

function approvedTelemetryEndpointOrigin(rawEndpoint: string): string | undefined {
  const trimmed = rawEndpoint.trim();
  if (trimmed.length === 0 || !URL.canParse(trimmed)) return undefined;
  const parsed = new URL(trimmed);
  if (parsed.protocol === 'https:') return parsed.origin.toLowerCase();
  if (parsed.protocol === 'http:') {
    const bare = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
      ? parsed.hostname.slice(1, -1).toLowerCase()
      : parsed.hostname.toLowerCase();
    if (bare === 'localhost' || bare === '127.0.0.1' || bare === '::1') {
      return parsed.origin.toLowerCase();
    }
  }
  return undefined;
}

registerScopedService(
  LifecycleScope.App,
  IErrorTelemetryService,
  ErrorTelemetryService,
  ScopeActivation.OnScopeCreated,
  'errorTelemetry',
);
