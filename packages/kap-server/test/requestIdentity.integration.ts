import type { RequestIdentityCatalog, RequestIdentityPreview } from '@kiki/protocol';
import { ErrorCode } from '@kiki/protocol';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T> {
  code: number;
  msg?: string;
  data: T;
}

describe('server-v2 /api/request-identity', () => {
  let server: RunningServer | undefined;
  let home: string;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-request-identity-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (server !== undefined) await server.close();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  async function call<T>(method: string, path: string, body?: unknown): Promise<Envelope<T>> {
    const response = await authedFetch(server as RunningServer, base, `/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await response.json()) as Envelope<T>;
  }

  it('duplicates, edits, previews, assigns and deletes a custom identity', async () => {
    const listed = await call<RequestIdentityCatalog>('GET', '/request-identity');
    expect(listed.code).toBe(0);
    expect(listed.data.profiles.map((profile) => profile.id)).toEqual(['kimi_code', 'codex', 'claude_code', 'grok_build', 'opencode', 'none']);
    expect(listed.data.tracks.map((track) => [track.id, track.current.origin])).toEqual([
      ['codex_cli', 'builtin'], ['claude_code', 'builtin'], ['grok_cli', 'builtin'], ['opencode_cli', 'builtin'],
    ]);
    expect(listed.data.usage[0]).toMatchObject({ scope: 'global', effective_profile: 'kimi_code' });
    const opencode = await call<RequestIdentityPreview>('POST', '/request-identity/preview', {
      profile: 'opencode', protocol: 'openai', model: 'example-model',
    });
    expect(opencode.code).toBe(0);
    expect(opencode.data.headers).toContainEqual(expect.objectContaining({ name: 'User-Agent', value: 'opencode/1.18.21' }));
    expect(opencode.data.headers).toContainEqual(expect.objectContaining({ name: 'x-opencode-client', value: 'cli' }));

    const created = await call<RequestIdentityCatalog>('POST', '/request-identity/profiles', { from: 'claude_code', label: 'Claude SDK' });
    const custom = created.data.profiles.find((profile) => profile.id === 'custom:claude_code-1');
    expect(custom).toMatchObject({ label: 'Claude SDK', builtin: false, duplicated_from: 'claude_code' });
    const { id: _id, builtin: _b, duplicated_from: _d, created_at: _c, updated_at: _u, ...draft } = custom!;

    const edited = await call<RequestIdentityCatalog>('PUT', '/request-identity/profiles/custom:claude_code-1', {
      ...draft,
      version: { mode: 'fixed', value: '2.0.0' },
      user_agent: 'claude-cli/{version} (external, sdk-cli)',
    });
    expect(edited.code).toBe(0);

    const preview = await call<RequestIdentityPreview>('POST', '/request-identity/preview', {
      profile: 'custom:claude_code-1', protocol: 'anthropic', model: 'claude-example',
    });
    expect(preview.data.headers).toContainEqual(expect.objectContaining({ name: 'User-Agent', value: 'claude-cli/2.0.0 (external, sdk-cli)' }));
    expect(preview.data.params['metadata.user_id']).toContain('session_id');

    const assigned = await call('POST', '/config', { request_identity: { profile: 'custom:claude_code-1' } });
    expect(assigned.code).toBe(0);
    const inUse = await call('DELETE', '/request-identity/profiles/custom:claude_code-1');
    expect(inUse.code).toBe(ErrorCode.REQUEST_IDENTITY_CONFLICT);
    expect((await call<RequestIdentityCatalog>('GET', '/request-identity')).data.usage[0]).toMatchObject({ effective_profile: 'custom:claude_code-1' });

    await call('POST', '/config', { request_identity: null });
    const deleted = await call<RequestIdentityCatalog>('DELETE', '/request-identity/profiles/custom:claude_code-1');
    expect(deleted.data.profiles.some((profile) => profile.id === 'custom:claude_code-1')).toBe(false);
  });

  it('answers typed errors for read-only, missing and malformed input', async () => {
    const readOnly = await call('PUT', '/request-identity/profiles/codex', {
      label: 'x', base_preset: 'codex_compatible', track: 'codex_cli', version: { mode: 'track' }, user_agent: '', headers: [], params: [],
    });
    expect(readOnly.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(readOnly.msg).toContain('read-only');
    expect((await call('POST', '/request-identity/profiles', { from: 'custom:none-9' })).code).toBe(ErrorCode.REQUEST_IDENTITY_NOT_FOUND);
    expect((await call('POST', '/request-identity/profiles', { from: 'codex', extra: 1 })).code).toBe(ErrorCode.VALIDATION_FAILED);
    expect((await call('POST', '/config', { request_identity: { profile: 'custom:none-9' } })).code).not.toBe(0);
    expect((await call('PUT', '/request-identity/manifest', { url: 'http://example.test/m.json' })).code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('stages, applies, pins and rolls back a release track without touching requests until applied', async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === 'https://registry.npmjs.org/@xai-official%2Fgrok/latest') {
        return new Response(JSON.stringify({ name: '@xai-official/grok', version: '1.2.0' }), { status: 200 });
      }
      return realFetch(input, init);
    });

    const checked = await call<RequestIdentityCatalog>('POST', '/request-identity/tracks/grok_cli/check', { source: 'npm' });
    const staged = checked.data.tracks.find((track) => track.id === 'grok_cli')!;
    expect(staged).toMatchObject({ current: { version: '1.0.44' }, candidate: { version: '1.2.0', origin: 'npm' }, last_check: { ok: true } });

    expect((await call('PUT', '/request-identity/tracks/grok_cli/pin', { pinned: true })).code).toBe(0);
    expect((await call('POST', '/request-identity/tracks/grok_cli/apply', { version: '1.2.0' })).code).toBe(ErrorCode.VALIDATION_FAILED);
    await call('PUT', '/request-identity/tracks/grok_cli/pin', { pinned: false });

    const applied = await call<RequestIdentityCatalog>('POST', '/request-identity/tracks/grok_cli/apply', { version: '1.2.0' });
    expect(applied.data.tracks.find((track) => track.id === 'grok_cli')?.current).toMatchObject({ version: '1.2.0', origin: 'npm' });
    const preview = await call<RequestIdentityPreview>('POST', '/request-identity/preview', {
      profile: 'grok_build', protocol: 'openai_responses', model: 'grok-example',
    });
    expect(preview.data.headers).toContainEqual(expect.objectContaining({ name: 'x-grok-client-version', value: '1.2.0' }));

    const rolled = await call<RequestIdentityCatalog>('POST', '/request-identity/tracks/grok_cli/rollback');
    expect(rolled.data.tracks.find((track) => track.id === 'grok_cli')?.current).toMatchObject({ version: '1.0.44', origin: 'builtin' });
    expect((await call('POST', '/request-identity/tracks/grok_cli/rollback')).code).toBe(ErrorCode.VALIDATION_FAILED);
    expect((await call('POST', '/request-identity/tracks/other_cli/rollback')).code).toBe(ErrorCode.VALIDATION_FAILED);
  });
});
