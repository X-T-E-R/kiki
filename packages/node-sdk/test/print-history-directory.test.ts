import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { IBootstrapService, ISessionIndex, ISessionManager, type Scope } from '@kiki/agent-core-v2';
import { describe, expect, it, vi } from 'vitest';

import { createPrintHistoryDirectory } from '../src/print-history-directory';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kiki-print-directory-'));
  const summary = { id: 'session_example', workspaceId: 'wd_example' };
  const agentsDir = join(root, summary.workspaceId, summary.id, 'agents');
  await mkdir(join(agentsDir, 'main'), { recursive: true });
  await mkdir(join(agentsDir, 'child'));
  const wirePath = join(agentsDir, 'main', 'wire.jsonl');
  const records = [0, 1].flatMap((turnId) => [
    { type: 'turn.prompt', turnId, promptId: `example-${turnId}`, input: [{ type: 'text', text: `prompt ${turnId}` }], origin: { kind: 'user' }, time: 1000 + turnId * 1000 },
    { type: 'turn.ended', turnId, reason: 'completed', time: 1500 + turnId * 1000 },
  ]);
  await writeFile(wirePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const get = vi.fn(async (id: string, workspaceId: string) => id === summary.id && workspaceId === summary.workspaceId ? summary : undefined);
  const services = new Map<unknown, unknown>([
    [ISessionManager, { get: () => undefined }], [ISessionIndex, { get }], [IBootstrapService, { sessionsDir: root }],
  ]);
  const app = { accessor: { get: (token: unknown) => services.get(token) } } as unknown as Scope;
  return { root, wirePath, directory: createPrintHistoryDirectory(() => app), request: {
    workspaceId: summary.workspaceId, sessionId: summary.id, kind: 'turns' as const, agentId: 'main', order: 'newest' as const, limit: 1,
  } };
}

function prohibited(specifier: string): boolean {
  return specifier.startsWith('@kiki/kap-server') || /search[-/]worker/.test(specifier) || specifier === 'node:worker_threads';
}

describe('print history directory', () => {
  it('replays bounded wire turns, paginates and lists the persisted agent roster without claiming navigation refs', async () => {
    const { root, directory, request } = await fixture();
    try {
      const first = await directory.list(request);
      expect(first).toMatchObject({ status: 'partial', source: 'transcript', coverage: { complete: false, gaps: ['navigation_unavailable', 'refs_unavailable', 'bounded_cold_read'] }, turns: [{ turn: 1, promptExcerpt: 'prompt 1' }] });
      expect(first.turns?.[0]?.ref).toBeUndefined();
      expect(first.nextCursor).toBeDefined();
      expect((await directory.list({ ...request, cursor: first.nextCursor })).turns).toMatchObject([{ turn: 0 }]);
      const roster = await directory.list({ ...request, kind: 'agents', agentId: undefined, limit: 10 });
      expect(roster.agents?.map((agent) => agent.agentId).toSorted()).toEqual(['child', 'main']);
      await expect(directory.list({ ...request, limit: 2, cursor: first.nextCursor })).rejects.toThrow('cursor conflicts');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports an oversized wire as partial and rejects workspace/path mismatches without reading them', async () => {
    const { root, directory, request, wirePath } = await fixture();
    try {
      await writeFile(wirePath, JSON.stringify({ type: 'unknown', text: 'x'.repeat(300 << 10) }) + '\n');
      expect(await directory.list(request)).toMatchObject({ status: 'partial', coverage: { complete: false, gaps: expect.arrayContaining(['line_budget']) }, turns: [] });
      expect(await directory.list({ ...request, workspaceId: 'other' })).toMatchObject({ status: 'unavailable', coverage: { gaps: ['session_unavailable'] } });
      expect(await directory.list({ ...request, sessionId: '../session_example' })).toMatchObject({ status: 'unavailable' });
      const controller = new AbortController();
      controller.abort(new Error('cancelled'));
      await expect(directory.list({ ...request, signal: controller.signal })).rejects.toThrow('cancelled');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the print host local import graph and declared dependencies free of kap-server and search workers', async () => {
    const entry = fileURLToPath(new URL('../src/print-client.ts', import.meta.url));
    const pending = [entry];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const path = pending.pop()!;
      if (seen.has(path)) continue;
      seen.add(path);
      const source = await readFile(path, 'utf8');
      for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)/g)) {
        const specifier = match[1]!;
        expect(prohibited(specifier), `${path} imports ${specifier}`).toBe(false);
        if (specifier.startsWith('.')) pending.push(resolve(dirname(path), `${specifier}.ts`));
      }
    }
    expect(seen.size).toBeGreaterThan(1);
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some(prohibited)).toBe(false);
    expect(prohibited('@kiki/kap-server')).toBe(true);
    expect(prohibited('../search/worker/client')).toBe(true);
    expect(prohibited('node:worker_threads')).toBe(true);
  });
});
