import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ErrorCode } from '@kiki/protocol';
import { ILocalSessionCatalog, ISessionIndex, ISessionManager, ISessionMetadata } from '@kiki/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startServer, type RunningServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T> { code: number; data: T }
interface LocalSummary { id: string; engine: string; external_id: string; title?: string; cwd?: string; partial: boolean }

describe('read-only local executor sessions', () => {
  let home: string;
  let server: RunningServer | undefined;
  let base: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'local-executor-sessions-'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, 'vendor-claude'));
    vi.stubEnv('CODEX_HOME', join(home, 'vendor-codex'));
  });
  afterEach(async () => {
    if (server !== undefined) await server.close();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  async function boot() {
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0,
      homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
  }
  async function request<T>(path: string, init?: Parameters<typeof authedFetch>[3]): Promise<Envelope<T>> {
    const response = await authedFetch(server!, base, path, init);
    expect(response.status).toBe(200);
    return response.json() as Promise<Envelope<T>>;
  }
  async function sessionBuckets(): Promise<string[]> {
    return readdir(join(home, 'sessions')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
  }

  it('lists and opens vendor transcripts without adding foreign IDs to Kiki sessions', async () => {
    const project = join(home, 'vendor-claude', 'projects', 'project');
    await mkdir(project, { recursive: true });
    const source = [
      { type: 'user', sessionId: 'vendor-id', cwd: '/work', timestamp: '2026-09-29T12:00:00Z',
        message: { content: 'Read this local transcript' } },
      { type: 'assistant', timestamp: '2026-09-29T12:00:01Z', message: { content: [{ type: 'text', text: 'Local response' }] } },
      { type: 'custom-title', customTitle: 'Vendor title' },
    ].map((item) => JSON.stringify(item)).join('\n') + '\n';
    const sourcePath = join(project, 'vendor-id.jsonl');
    await writeFile(sourcePath, source);
    await boot();
    const before = await sessionBuckets();
    const listed = await request<{ exists: boolean; items: LocalSummary[] }>('/api/executors/claude-acp/local-sessions');
    expect(listed.code).toBe(0);
    expect(listed.data.exists).toBe(true);
    expect(listed.data.items).toHaveLength(1);
    const summary = listed.data.items[0]!;
    expect(summary).toMatchObject({ external_id: 'vendor-id', engine: 'claude', title: 'Vendor title', partial: false });
    expect(summary.id).toMatch(/^external:claude:[a-f0-9]{64}$/);
    const detail = await request<{ summary: LocalSummary; messages: Array<{ role: string; blocks: Array<{ kind: string; text?: string }> }> }>(
      `/api/executors/claude-acp/local-sessions/${encodeURIComponent(summary.id)}`,
    );
    expect(detail.code).toBe(0);
    expect(detail.data.summary.id).toBe(summary.id);
    expect(detail.data.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(detail.data.messages[1]?.blocks[0]?.text).toBe('Local response');
    expect(await sessionBuckets()).toEqual(before);
    expect(await readFile(sourcePath, 'utf8')).toBe(source);
  });

  it.each(['claude-acp', 'codex-app-server'] as const)('attaches %s once across concurrent calls and restarts without importing vendor IDs into the Kiki index', async (executorId) => {
    vi.stubEnv(executorId === 'claude-acp' ? 'CLAUDE_AGENT_ACP_PATH' : 'CODEX_PATH', process.execPath);
    const project = executorId === 'claude-acp' ? join(home, 'vendor-claude', 'projects', 'project')
      : join(home, 'vendor-codex', 'sessions', '2026', '09', '29');
    const cwd = join(home, 'workspace');
    await mkdir(project, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const content = JSON.stringify(executorId === 'claude-acp'
      ? { type: 'user', sessionId: 'foreign-thread', cwd, message: { content: 'Existing conversation' } }
      : { type: 'session_meta', payload: { id: 'foreign-thread', cwd } }) + '\n';
    const sourcePath = join(project, executorId === 'claude-acp' ? 'foreign-thread.jsonl'
      : 'rollout-2026-09-29T12-00-00-foreign-thread.jsonl');
    await writeFile(sourcePath, content);
    await boot();
    const listed = await request<{ resume_enabled: boolean; items: Array<LocalSummary & { engine: 'claude' | 'codex'; source_home: string; resume: { supported: boolean } }> }>(`/api/executors/${executorId}/local-sessions`);
    const summary = listed.data.items[0]!;
    expect(listed.data.resume_enabled).toBe(true);
    expect(summary.resume.supported).toBe(true);
    for (const foreignId of [summary.id, summary.external_id]) {
      await expect(server!.core.accessor.get(ISessionManager).create({ sessionId: foreignId, workDir: cwd,
        localSession: { localId: summary.id, executorId, engine: summary.engine, externalId: summary.external_id, home: summary.source_home } }))
        .rejects.toThrow(/External source IDs/);
      expect(await server!.core.accessor.get(ISessionIndex).get(foreignId)).toBeUndefined();
    }
    const path = `/api/executors/${executorId}/local-sessions/${encodeURIComponent(summary.id)}/resume`;
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source_home: summary.source_home }) };
    type Receipt = { session_id: string; executor_id: string; created: boolean };
    const receipts = await Promise.all([request<Receipt>(path, init), request<Receipt>(path, init)]);
    expect(receipts.map((item) => item.code), JSON.stringify(receipts)).toEqual([0, 0]);
    expect(receipts.map((item) => item.data.created).sort()).toEqual([false, true]);
    const id = receipts[0]!.data.session_id;
    expect(receipts[1]!.data.session_id).toBe(id);
    expect(id).toMatch(/^session_[a-f0-9-]{36}$/);
    expect(id).not.toContain('foreign-thread');
    const bucket = (await sessionBuckets())[0]!;
    const sessionDir = join(home, 'sessions', bucket, id);
    const meta = JSON.parse(await readFile(join(sessionDir, 'state.json'), 'utf8'));
    expect(meta.custom.local_session).toMatchObject({ executorId, externalId: 'foreign-thread', home: summary.source_home });
    if (executorId === 'codex-app-server') {
      const acpPath = `/api/executors/codex-acp/local-sessions/${encodeURIComponent(summary.id)}/resume`;
      expect(await request<Receipt>(acpPath, init)).toMatchObject({ code: 0, data: { session_id: id, executor_id: executorId, created: false } });
    }
    const wire = await readFile(join(sessionDir, 'agents', 'main', 'wire.jsonl'), 'utf8');
    expect(wire).toContain('executor.session.updated');
    expect(wire).toMatch(/bindingFingerprint/);
    expect(await readFile(sourcePath, 'utf8')).toBe(content);
    await server!.close();
    server = undefined;
    await boot();
    expect(await request<Receipt>(path, init)).toMatchObject({ code: 0, data: { session_id: id, created: false } });
    expect((await request(path, { ...init, body: JSON.stringify({ source_home: '/different-home' }) })).code).toBe(ErrorCode.VALIDATION_FAILED);
  }, 60_000);

  it.each([
    { title: ' Vendor title ', lastPrompt: 'Last prompt', expected: 'Vendor title' },
    { title: undefined, lastPrompt: `  ${'🙂'.repeat(81)}\nmore  `, expected: '🙂'.repeat(80) },
    { title: '   ', lastPrompt: '  Last\n prompt  ', expected: 'Last prompt' },
    { title: undefined, lastPrompt: undefined, expected: undefined },
  ])('initializes local attachment titles without replacing a custom title: $expected', async ({ title, lastPrompt, expected }) => {
    vi.stubEnv('CLAUDE_AGENT_ACP_PATH', process.execPath);
    const project = join(home, 'vendor-claude', 'projects', 'project');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'foreign-thread.jsonl'), JSON.stringify({ type: 'user', sessionId: 'foreign-thread', cwd: home,
      message: { content: 'Existing conversation' } }) + '\n');
    await boot();
    const listed = await request<{ items: Array<LocalSummary & { source_home: string }> }>('/api/executors/claude-acp/local-sessions');
    const source = listed.data.items[0]!;
    const catalog = server!.core.accessor.get(ILocalSessionCatalog);
    const detail = (await catalog.get('claude-acp', source.id))!;
    vi.spyOn(catalog, 'get').mockResolvedValue({ ...detail, summary: { ...detail.summary, title, lastPrompt } });
    const path = `/api/executors/claude-acp/local-sessions/${encodeURIComponent(source.id)}/resume`;
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source_home: source.source_home }) };
    const result = await request<{ session_id: string; created: boolean }>(path, init);
    expect(result).toMatchObject({ code: 0, data: { created: true } });
    const id = result.data.session_id;
    const metadata = server!.core.accessor.get(ISessionManager).get(id)!.accessor.get(ISessionMetadata);
    expect((await metadata.read()).title).toBe(expected);
    expect((await server!.core.accessor.get(ISessionIndex).get(id))?.title).toBe(expected);
    await metadata.setTitle('User title');
    expect(await request(path, init)).toMatchObject({ code: 0, data: { session_id: id, created: false } });
    expect((await metadata.read()).title).toBe('User title');
    await server!.close();
    server = undefined;
    await boot();
    expect(await request(path, init)).toMatchObject({ code: 0, data: { session_id: id, created: false } });
    expect((await server!.core.accessor.get(ISessionIndex).get(id))?.title).toBe('User title');
  }, 60_000);

  it('rejects disabled continuation and sources without a working directory without creating Kiki sessions', async () => {
    vi.stubEnv('KIKI_EXPERIMENTAL_LOCAL_SESSION_RESUME', 'false');
    const project = join(home, 'vendor-claude', 'projects', 'project');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'incomplete.jsonl'), JSON.stringify({ type: 'user', sessionId: 'incomplete', message: { content: 'No cwd' } }) + '\n');
    await writeFile(join(project, 'resumable.jsonl'), JSON.stringify({ type: 'user', sessionId: 'resumable', cwd: home, message: { content: 'Has cwd' } }) + '\n');
    await boot();
    const list = await request<{ resume_enabled: boolean; items: Array<LocalSummary & { source_home: string; resume: { supported: boolean; reason?: string } }> }>('/api/executors/claude-acp/local-sessions');
    const source = list.data.items.find((item) => item.external_id === 'incomplete')!;
    const resumable = list.data.items.find((item) => item.external_id === 'resumable')!;
    expect(list.data.resume_enabled).toBe(false);
    expect(source.resume).toEqual({ supported: false, reason: 'working_directory_missing' });
    expect(resumable.resume.supported).toBe(true);
    const path = `/api/executors/claude-acp/local-sessions/${encodeURIComponent(source.id)}/resume`;
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source_home: source.source_home }) };
    expect((await request(`/api/executors/claude-acp/local-sessions/${encodeURIComponent(resumable.id)}/resume`, init)).code).toBe(ErrorCode.CAPABILITY_UNSUPPORTED);
    vi.stubEnv('KIKI_EXPERIMENTAL_LOCAL_SESSION_RESUME', 'true');
    expect((await request(path, init)).code).toBe(ErrorCode.CAPABILITY_UNSUPPORTED);
    expect(await sessionBuckets()).toEqual([]);
  });

  it('returns missing/unsupported catalogs and validates the scan limit', async () => {
    await boot();
    const missing = await request<{ exists: boolean; items: unknown[] }>('/api/executors/codex-app-server/local-sessions');
    expect(missing).toMatchObject({ code: 0, data: { exists: false, items: [] } });
    expect((await request('/api/executors/native/local-sessions')).code).toBe(ErrorCode.AGENT_PROFILE_NOT_FOUND);
    expect((await request(`/api/executors/claude-acp/local-sessions/external:claude:${'a'.repeat(64)}`)).code)
      .toBe(ErrorCode.SESSION_NOT_FOUND);
    expect((await request('/api/executors/claude-acp/local-sessions?limit=201')).code).toBe(ErrorCode.VALIDATION_FAILED);
    const unauthorized = await fetch(`${base}/api/executors/claude-acp/local-sessions`);
    expect(unauthorized.status).toBe(401);
  });
});
