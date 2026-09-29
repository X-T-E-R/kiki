import { describe, expect, it, vi } from 'vitest';

import { createKlient } from '../src/transports/http/index.js';
import { KlientValidationError } from '../src/core/validation.js';

function envelope(data: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve({ code: 0, msg: 'success', data, request_id: 'r1' }) } as Response;
}

const task = {
  taskId: 'task-1', kind: 'shell', state: 'completed', outputTail: 'full output', description: 'build', detached: false,
};

describe('session view transcript detail', () => {
  it('reads one entity through the authenticated session detail route', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/api/sessions/s%201/transcript/detail');
      expect(Object.fromEntries(url.searchParams)).toEqual({ agent_id: 'main', kind: 'task', id: 'task-1' });
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
      return envelope({ session_id: 's 1', agent_id: 'main', kind: 'task', task });
    });
    const klient = createKlient({ endpoint: 'http://example.test', token: 'secret', fetch: fetchMock as typeof fetch });
    try {
      const detail = klient.session('s 1').view.transcript.detail;
      expect(detail).toBeTypeOf('function');
      await expect(detail!({ agentId: 'main', kind: 'task', id: 'task-1' })).resolves.toMatchObject({
        kind: 'task', task: { taskId: 'task-1', outputTail: 'full output' },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await klient.close();
    }
  });

  it('rejects a path-like agent id before sending and a malformed body after', async () => {
    const fetchMock = vi.fn(async () => envelope({ session_id: 's1', agent_id: 'main', kind: 'task', task: { taskId: 'x' } }));
    const klient = createKlient({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      const detail = klient.session('s1').view.transcript.detail!;
      await expect(detail({ agentId: '../main', kind: 'task', id: 'x' })).rejects.toBeInstanceOf(KlientValidationError);
      expect(fetchMock).not.toHaveBeenCalled();
      await expect(detail({ agentId: 'main', kind: 'task', id: 'x' })).rejects.toBeInstanceOf(KlientValidationError);
    } finally {
      await klient.close();
    }
  });
});
