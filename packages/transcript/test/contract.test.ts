import { describe, expect, it } from 'vitest';

import {
  agentTranscriptSnapshotSchema,
  transcriptDetailQuerySchema,
  transcriptDetailResponseSchema,
} from '#/contract/schema';

describe('windowed transcript global contract', () => {
  it('accepts legacy arrays plus optional coverage and references', () => {
    const snapshot = agentTranscriptSnapshotSchema.parse({
      items: [], tasks: [], interactions: [], attachments: [], todos: [], prompts: [], meta: {},
      taskRefs: [{ kind: 'task', taskId: 'task-1' }],
      attachmentRefs: [{ kind: 'attachment', attachmentId: 'attachment-1' }],
      promptRefs: [{ kind: 'prompt', promptId: 'prompt-1' }],
      globalCoverage: {
        version: 1,
        tasks: { returned: 1, total: 2, hasMore: true },
        attachments: { returned: 0, total: 1, hasMore: true },
        prompts: { returned: 1, total: 1, hasMore: false },
      },
    });
    expect(snapshot.globalCoverage?.tasks.hasMore).toBe(true);
    expect(snapshot.taskRefs).toHaveLength(1);
  });

  it('validates detail endpoint references and discriminated responses', () => {
    expect(transcriptDetailQuerySchema.safeParse({ agent_id: 'main', kind: 'task', id: 'task-1' }).success).toBe(true);
    expect(transcriptDetailQuerySchema.safeParse({ agent_id: '../main', kind: 'task', id: 'task-1' }).success).toBe(false);
    expect(transcriptDetailResponseSchema.parse({
      session_id: 's1', agent_id: 'main', kind: 'task',
      task: { taskId: 'task-1', kind: 'subagent', state: 'completed', detached: false, outputTail: 'done' },
    })).toMatchObject({ kind: 'task', task: { taskId: 'task-1' } });
  });
});
