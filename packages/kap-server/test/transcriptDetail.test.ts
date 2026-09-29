import { AgentTranscript } from '@kiki/transcript';
import { describe, expect, it } from 'vitest';

import {
  readSessionViewTranscriptDetails,
  readSessionViewTranscriptDetail,
} from '../src/transport/klient/sessionViewReads';
import type { TranscriptService } from '../src/services/transcript/transcriptService';

describe('session transcript detail reads', () => {
  it('returns canonical live task, attachment, and prompt bodies by explicit reference', async () => {
    const transcript = new AgentTranscript('main');
    transcript.apply([
      {
        op: 'task.upsert',
        task: {
          taskId: 'task-1', kind: 'subagent', state: 'completed', detached: false,
          outputTail: 'complete task output',
        },
      },
      {
        op: 'attachment.upsert',
        attachment: {
          attachmentId: 'attachment-1', mediaType: 'image/png',
          source: { kind: 'url', url: `data:image/png;base64,${'A'.repeat(8_192)}` },
        },
      },
      {
        op: 'prompt.upsert',
        prompt: {
          promptId: 'prompt-1', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z',
          content: { text: 'complete prompt content' },
        },
      },
    ]);
    const store = {
      ensureAgent: () => transcript,
    };
    const service = {
      forSessionLive: () => store,
      whenReady: async () => undefined,
      ensureAgentHistory: async () => undefined,
    } as unknown as TranscriptService;

    await expect(readSessionViewTranscriptDetail(service, 's1', {
      agentId: 'main', kind: 'task', id: 'task-1',
    })).resolves.toEqual({
      session_id: 's1', agent_id: 'main', kind: 'task',
      task: expect.objectContaining({ taskId: 'task-1', outputTail: 'complete task output' }),
    });
    await expect(readSessionViewTranscriptDetail(service, 's1', {
      agentId: 'main', kind: 'attachment', id: 'attachment-1',
    })).resolves.toEqual({
      session_id: 's1', agent_id: 'main', kind: 'attachment',
      attachment: expect.objectContaining({ attachmentId: 'attachment-1', source: expect.objectContaining({ kind: 'url' }) }),
    });
    await expect(readSessionViewTranscriptDetail(service, 's1', {
      agentId: 'main', kind: 'prompt', id: 'prompt-1',
    })).resolves.toEqual({
      session_id: 's1', agent_id: 'main', kind: 'prompt',
      prompt: expect.objectContaining({ promptId: 'prompt-1', content: { text: 'complete prompt content' } }),
    });
    await expect(readSessionViewTranscriptDetail(service, 's1', {
      agentId: 'main', kind: 'task', id: 'missing',
    })).resolves.toBeUndefined();
  });

  it('paginates canonical global entities with an opaque keyset cursor', async () => {
    const transcript = new AgentTranscript('main');
    transcript.apply([
      ...['task-1', 'task-2', 'task-3'].map((taskId) => ({
        op: 'task.upsert' as const,
        task: {
          taskId, kind: 'subagent' as const, state: 'completed' as const,
          detached: false, outputTail: taskId,
        },
      })),
    ]);
    const store = { ensureAgent: () => transcript };
    const service = {
      forSessionLive: () => store,
      whenReady: async () => undefined,
      ensureAgentHistory: async () => undefined,
    } as unknown as TranscriptService;

    const first = await readSessionViewTranscriptDetails(service, 's1', {
      agentId: 'main', kind: 'task', limit: 1,
    });
    expect(first).toMatchObject({
      kind: 'task', items: [{ taskId: 'task-1' }], has_more: true,
      next_cursor: expect.any(String),
    });
    const second = await readSessionViewTranscriptDetails(service, 's1', {
      agentId: 'main', kind: 'task', limit: 1, cursor: first?.kind === 'task' ? first.next_cursor : undefined,
    });
    expect(second).toMatchObject({
      kind: 'task', items: [{ taskId: 'task-2' }], has_more: true,
      next_cursor: expect.any(String),
    });
  });
});
