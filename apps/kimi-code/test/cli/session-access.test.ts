import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { startServer, type RunningServer } from '@kiki/kap-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_HOST_IDENTITY } from '../../../../packages/kap-server/test/helpers/hostIdentity';
import { registerSessionAccessCommand } from '../../src/kiki/sessionAccess';

const mocks = vi.hoisted(() => ({ ensureServer: vi.fn() }));
vi.mock('../../src/kiki/serve', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/kiki/serve')>(),
  ensureServer: mocks.ensureServer,
}));

const SERVER_URL = 'http://127.0.0.1:12345';
const OWNER_TOKEN = 'fixture-owner-token';
const SECRET_TOKEN = 'session-access-secret-once';
const nativeFetch = globalThis.fetch;
let output = '';
let fetchMock: ReturnType<typeof vi.fn>;

function envelope(data: unknown, status = 200, msg = 'ok'): Response {
  return new Response(JSON.stringify({ code: status === 200 ? 0 : 1, msg, data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function run(args: string[]): Promise<void> {
  output = '';
  const program = new Command().exitOverride();
  program.configureOutput({ writeErr: () => {} });
  registerSessionAccessCommand(program);
  await program.parseAsync(['node', 'kiki', 'session-access', ...args]);
}

beforeEach(() => {
  vi.clearAllMocks();
  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output += String(chunk); return true; });
  mocks.ensureServer.mockResolvedValue({ url: SERVER_URL, token: OWNER_TOKEN });
  fetchMock = vi.fn();
  fetchMock.mockResolvedValue(envelope({}));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('kiki session-access CLI', () => {
  it('lists token metadata through the local owner endpoint', async () => {
    const result = {
      version: 1,
      enabled: true,
      terminal_handoff: true,
      server_id: 'server-fixture',
      tokens: [{ id: 'token-id', session_id: 'session-id', scopes: ['read'], client: 'editor', channel: 'terminal', issued_at: 100, expires_at: 200 }],
    };
    fetchMock.mockResolvedValueOnce(envelope(result));

    await run(['--home', 'C:/fixture/home', 'list']);

    expect(mocks.ensureServer).toHaveBeenCalledWith({ homeDir: expect.stringContaining('fixture') });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SERVER_URL}/api/session-access`);
    expect(request.method).toBe('GET');
    expect(new Headers(request.headers).get('authorization')).toBe(`Bearer ${OWNER_TOKEN}`);
    expect(JSON.parse(output)).toEqual(result);
  });

  it('issues a token with the requested scopes and TTL, printing its secret exactly once', async () => {
    const result = {
      token: SECRET_TOKEN,
      expires_at: 200,
      session_id: 'session-id',
      scopes: ['read', 'prompt', 'abort'],
      server_id: 'server-fixture',
      server_version: '1.2.3',
      session_access: 1,
    };
    fetchMock.mockResolvedValueOnce(envelope(result));

    await run(['issue', '--session', 'session-id', '--scope', 'read, prompt,abort', '--name', 'editor', '--ttl', '15m']);

    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SERVER_URL}/api/session-access/tokens`);
    expect(request.method).toBe('POST');
    expect(new Headers(request.headers).get('authorization')).toBe(`Bearer ${OWNER_TOKEN}`);
    if (typeof request.body !== 'string') throw new Error('Expected a JSON request body');
    expect(JSON.parse(request.body)).toEqual({
      session_id: 'session-id',
      scopes: ['read', 'prompt', 'abort'],
      client: { name: 'editor' },
      ttl_seconds: 900,
    });
    expect(JSON.parse(output)).toEqual(result);
    expect(output.split(SECRET_TOKEN).length - 1).toBe(1);
  });

  it('defaults token lifetime to one hour and rejects lifetimes outside the owner range before connecting', async () => {
    await run(['issue', '--session', 'session-id', '--scope', 'read', '--name', 'editor']);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ ttl_seconds: 3600 });

    fetchMock.mockClear();
    mocks.ensureServer.mockClear();
    await expect(run(['issue', '--session', 'session-id', '--scope', 'read', '--name', 'editor', '--ttl', '59s']))
      .rejects.toThrow('whole number of seconds from 60s through 24h');
    await expect(run(['issue', '--session', 'session-id', '--scope', 'read', '--name', 'editor', '--ttl', '25h']))
      .rejects.toThrow('whole number of seconds from 60s through 24h');
    expect(mocks.ensureServer).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects invalid scopes and incomplete or conflicting revoke forms before connecting', async () => {
    await expect(run(['issue', '--session', 'session-id', '--scope', 'read,write', '--name', 'editor']))
      .rejects.toThrow('Invalid --scope');
    await expect(run(['revoke'])).rejects.toThrow('Provide a token_id or use --all');
    await expect(run(['revoke', 'token-id', '--all'])).rejects.toThrow('Use either a token_id or --all');
    expect(mocks.ensureServer).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('revokes a single encoded token id or all tokens', async () => {
    fetchMock.mockResolvedValueOnce(envelope({ revoked: 1 }));
    await run(['revoke', 'token/id']);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${SERVER_URL}/api/session-access/tokens/token%2Fid`);
    expect(JSON.parse(output)).toEqual({ revoked: 1 });

    fetchMock.mockResolvedValueOnce(envelope({ revoked: 3 }));
    await run(['revoke', '--all']);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`${SERVER_URL}/api/session-access/tokens`);
    expect(JSON.parse(output)).toEqual({ revoked: 3 });
  });

  it('surfaces the house-envelope message on a failed owner request', async () => {
    fetchMock.mockResolvedValueOnce(envelope(null, 403, 'Owner token required.'));

    await expect(run(['list'])).rejects.toThrow('Owner token required.');
    expect(output).toBe('');
  });

  it('lists, issues and revokes tokens through the actual ensureServer and a running server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-session-access-cli-'));
    const home = join(root, 'home');
    let server: RunningServer | undefined;
    vi.stubGlobal('fetch', nativeFetch);
    try {
      await mkdir(home);
      server = await startServer({ homeDir: home, host: '127.0.0.1', port: 0, logLevel: 'silent', hostIdentity: TEST_HOST_IDENTITY });
      const actualServe = await vi.importActual<typeof import('../../src/kiki/serve')>('../../src/kiki/serve');
      mocks.ensureServer.mockImplementation(actualServe.ensureServer);
      const endpoint = `http://127.0.0.1:${server.port}`;

      await run(['--home', home, 'list']);
      expect(JSON.parse(output)).toMatchObject({ version: 1, enabled: true, tokens: [] });
      const attachment = await mocks.ensureServer.mock.results[0]?.value;
      expect(attachment).toMatchObject({ url: endpoint, token: server.localOwnerToken });

      const created = await nativeFetch(`${endpoint}/api/sessions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${server.localOwnerToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ metadata: { cwd: root } }),
      });
      const createdEnvelope = await created.json() as { code: number; msg: string; data?: { id: string } };
      expect(created.status, createdEnvelope.msg).toBe(200);
      expect(createdEnvelope.code, createdEnvelope.msg).toBe(0);
      const sessionId = createdEnvelope.data?.id;
      if (typeof sessionId !== 'string') throw new Error('Expected the server to create a session.');

      await run(['--home', home, 'issue', '--session', sessionId, '--scope', 'read,prompt,abort', '--name', 'cli-integration']);
      const issued = JSON.parse(output) as { token: string; session_id: string; scopes: string[]; session_access: number };
      expect(issued).toMatchObject({
        token: expect.stringMatching(/^ksa_[A-Za-z0-9_-]{43}$/),
        session_id: sessionId,
        scopes: ['read', 'prompt', 'abort'],
        session_access: 1,
      });
      expect(output.split(issued.token).length - 1).toBe(1);

      await run(['--home', home, 'list']);
      const listing = JSON.parse(output) as { tokens: Array<{ id: string; session_id: string; scopes: string[]; client: { name: string }; channel: string }> };
      expect(listing.tokens).toHaveLength(1);
      const listedToken = listing.tokens[0];
      if (listedToken === undefined) throw new Error('Expected the token to appear in the list.');
      expect(listedToken).toMatchObject({
        id: expect.stringMatching(/^sat_/),
        session_id: sessionId,
        scopes: ['read', 'prompt', 'abort'],
        client: { name: 'cli-integration' },
        channel: 'owner',
      });
      expect(output).not.toContain(issued.token);
      const tokenId = listedToken.id;

      await run(['--home', home, 'revoke', tokenId]);
      expect(JSON.parse(output)).toEqual({ revoked: 1 });
      const denied = await nativeFetch(`${endpoint}/api/sessions/${sessionId}`, {
        headers: { authorization: `Bearer ${issued.token}` },
      });
      const deniedEnvelope = await denied.json() as { code: number };
      expect(denied.status).toBe(401);
      expect(deniedEnvelope.code).toBe(40101);
      expect(mocks.ensureServer).toHaveBeenCalledTimes(4);
    } finally {
      try {
        if (server !== undefined) await server.close();
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    }
  }, 60000);
});
