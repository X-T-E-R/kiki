import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ErrorCode } from '@kiki/protocol';
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
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  async function boot() {
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0,
      homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
  }
  async function request<T>(path: string): Promise<Envelope<T>> {
    const response = await authedFetch(server!, base, path);
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
