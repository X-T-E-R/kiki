import { describe, expect, it, vi } from 'vitest';

import { extractPortableConfigLayer } from '#/app/config/configLayers';
import {
  ERROR_TELEMETRY_SECTION,
  ErrorTelemetryConfigSchema,
} from '#/app/telemetry/errorTelemetryConfig';
import {
  ErrorTelemetryAppender,
  ErrorTelemetryService,
  projectErrorTelemetryEvent,
  sanitizeErrorTelemetryMessage,
  type ErrorTelemetryBatchPayload,
} from '#/app/telemetry/errorTelemetryService';
import type { IConfigService } from '#/app/config/config';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';

describe('errorTelemetryConfig', () => {
  it('defaults enabled to false and classifies as portable', () => {
    const parsed = ErrorTelemetryConfigSchema.parse({});
    expect(parsed.enabled).toBe(false);
    expect(parsed.endpoint).toBeUndefined();
    expect(parsed.flush_interval_ms).toBe(5000);
    expect(parsed.max_batch_size).toBe(20);
    expect(ERROR_TELEMETRY_SECTION).toBe('errorTelemetry');

    const portable = extractPortableConfigLayer({
      error_telemetry: {
        enabled: true,
        endpoint: 'https://api.example.test/v1/kiki/telemetry',
        connection: 'axon',
        flush_interval_ms: 5000,
        max_batch_size: 20,
      },
    });
    expect(portable['error_telemetry']).toEqual({
      enabled: true,
      endpoint: 'https://api.example.test/v1/kiki/telemetry',
      connection: 'axon',
      flush_interval_ms: 5000,
      max_batch_size: 20,
    });
  });
});

describe('ErrorTelemetryAppender', () => {
  it('stays completely silent with zero network calls when disabled', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const getClientId = vi.fn(async () => 'client-disabled');
    const appender = new ErrorTelemetryAppender({
      getConfig: () => ErrorTelemetryConfigSchema.parse({}),
      resolveBearerToken: () => 'sk-should-not-use',
      getClientId,
      fetchFn,
    });

    appender.track('api_error', { error_type: 'rate_limit', model: 'gemini-4-neon', status_code: 429 });
    appender.captureUnexpectedError(new Error('boom at C:\\Users\\alice\\secret.txt'));
    await appender.flush();

    expect(fetchFn).not.toHaveBeenCalled();
    expect(getClientId).not.toHaveBeenCalled();
  });

  it('batches only error events, scrubs paths/tokens, sends bearer auth, and drops network errors silently', async () => {
    const sent: { url: string; headers: Record<string, string>; body: ErrorTelemetryBatchPayload }[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      sent.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)) as ErrorTelemetryBatchPayload,
      });
      return new Response(null, { status: 204 });
    });

    const appender = new ErrorTelemetryAppender({
      getConfig: () => ({
        enabled: true,
        endpoint: 'https://api.example.test/v1/kiki/telemetry',
        connection: 'axon',
        flush_interval_ms: 60_000,
        max_batch_size: 10,
      }),
      resolveBearerToken: (conn) => (conn === 'axon' ? 'sk-test-token-123456' : undefined),
      getClientId: async () => 'anon-client-1',
      fetchFn,
      kikiVersion: '0.4.2-test',
    });

    appender.track('turn_started', { turn_id: 1, mode: 'agent' });
    appender.track('tool_call', { tool_name: 'Read', outcome: 'success', duration_ms: 12 });
    appender.track('api_error', {
      error_type: 'upstream_502',
      model: 'gemini-4-neon',
      provider_type: 'anthropic',
      status_code: 502,
      duration_ms: 340,
      prompt: 'NEVER SEND USER PROMPT',
      message: 'Failed reading /Users/alice/private/paper.tex with Bearer sk-secret-abcdef12345',
    });
    appender.track('tool_call', {
      tool_name: 'Bash',
      outcome: 'error',
      error_type: 'error',
      duration_ms: 88,
    });
    appender.captureUnexpectedError(new Error('Crash at C:\\Users\\bob\\notes.md using sk-live-999999999'));

    await appender.shutdown();

    expect(sent).toHaveLength(1);
    const req = sent[0]!;
    expect(req.url).toBe('https://api.example.test/v1/kiki/telemetry');
    expect(req.headers['authorization']).toBe('Bearer sk-test-token-123456');
    expect(req.body.schema_version).toBe(1);
    expect(req.body.client_id).toBe('anon-client-1');
    expect(req.body.kiki_version).toBe('0.4.2-test');
    expect(req.body.os).toBe(process.platform);
    expect(req.body.arch).toBe(process.arch);
    expect(req.body.events).toHaveLength(3);

    const rawSerialized = JSON.stringify(req.body);
    expect(rawSerialized).not.toContain('NEVER SEND USER PROMPT');
    expect(rawSerialized).not.toContain('/Users/alice');
    expect(rawSerialized).not.toContain('C:\\\\Users\\\\bob');
    expect(rawSerialized).not.toContain('sk-secret-abcdef12345');
    expect(rawSerialized).not.toContain('sk-live-999999999');

    expect(req.body.events[0]).toMatchObject({
      category: 'api',
      event: 'api_error',
      error_code: 'upstream_502',
      status_code: 502,
      model_id: 'gemini-4-neon',
      provider_id: 'anthropic',
      duration_ms: 340,
    });
    expect(req.body.events[0]!.message_redacted).toBeUndefined();

    expect(req.body.events[1]).toMatchObject({
      category: 'tool',
      event: 'tool_call',
      tool_name: 'Bash',
      duration_ms: 88,
    });

    expect(req.body.events[2]).toMatchObject({
      category: 'unexpected',
      event: 'unexpected_error',
      error_code: 'Error',
    });
    expect(req.body.events[2]!.message_redacted).toBeUndefined();

    const failingAppender = new ErrorTelemetryAppender({
      getConfig: () => ({
        enabled: true,
        endpoint: 'https://api.example.test/v1/kiki/telemetry',
        flush_interval_ms: 60_000,
        max_batch_size: 10,
      }),
      resolveBearerToken: () => undefined,
      getClientId: async () => 'anon-client-2',
      fetchFn: vi.fn(async () => { throw new Error('ECONNREFUSED'); }),
    });
    failingAppender.captureUnexpectedError(new Error('offline error'));
    await expect(failingAppender.shutdown()).resolves.toBeUndefined();
  });

  it('scrubs Windows, UNC, POSIX paths and secret formats', () => {
    const out = sanitizeErrorTelemetryMessage(
      'Read /home/researcher/data.csv and E:\\lab\\key.txt with api_key=abc123456 and Bearer tok_987654321',
    );
    expect(out).not.toContain('/home/researcher');
    expect(out).not.toContain('E:\\lab');
    expect(out).not.toContain('abc123456');
    expect(out).not.toContain('tok_987654321');
    expect(out).toContain('<path>');
    expect(out).toContain('<redacted>');
    expect(projectErrorTelemetryEvent('turn_ended', { reason: 'completed' })).toBeUndefined();
    expect(projectErrorTelemetryEvent('turn_ended', { reason: 'failed', duration_ms: 50 })).toMatchObject({
      category: 'turn',
      event: 'turn_ended',
      duration_ms: 50,
    });
  });

  it('refuses cross-origin connection bearer forwarding and coalesces concurrent flushes', async () => {
    const configState: Record<string, unknown> = {
      errorTelemetry: {
        enabled: true,
        endpoint: 'https://collector.evil.test/v1/kiki/telemetry',
        connection: 'axon',
        flush_interval_ms: 60_000,
        max_batch_size: 10,
      },
      providers: {
        axon: { type: 'anthropic', baseUrl: 'https://api.example.test/v1', apiKey: 'sk-axon-origin-bound' },
      },
    };
    const capturedHeaders: Record<string, string>[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn<typeof fetch>(async (_input, init) => {
      capturedHeaders.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(null, { status: 204 });
    });
    const appenders: { track: (e: string, p?: Record<string, unknown>) => void }[] = [];
    const service = new ErrorTelemetryService(
      {
        get: ((domain: string) => configState[domain]) as IConfigService['get'],
        onDidChangeConfiguration: (() => ({ dispose() {} })) as unknown as IConfigService['onDidChangeConfiguration'],
      } as IConfigService,
      {
        addAppender: (appender: { track: (e: string, p?: Record<string, unknown>) => void }) => {
          appenders.push(appender);
          return { dispose() {} };
        },
      } as unknown as ITelemetryService,
      {
        read: async () => new TextEncoder().encode(JSON.stringify({ client_id: 'cid-origin' })),
        write: async () => undefined,
      } as unknown as IFileSystemStorageService,
    );
    try {
      appenders[0]!.track('api_error', { error_type: 'timeout' });
      await service.flush();
      expect(capturedHeaders).toHaveLength(1);
      expect(capturedHeaders[0]!['authorization']).toBeUndefined();

      configState['errorTelemetry'] = {
        enabled: true,
        endpoint: 'https://api.example.test/v1/kiki/telemetry',
        connection: 'axon',
        flush_interval_ms: 60_000,
        max_batch_size: 10,
      };
      appenders[0]!.track('api_error', { error_type: 'upstream_503' });
      await Promise.all([service.flush(), service.flush()]);
      expect(capturedHeaders).toHaveLength(2);
      expect(capturedHeaders[1]!['authorization']).toBe('Bearer sk-axon-origin-bound');
    } finally {
      await service.shutdown();
      service.dispose();
      globalThis.fetch = origFetch;
    }
  });
});
