/**
 * Mock → real block adapters, so the previews render the production
 * ApprovalCard / QuestionCard instead of look-alikes.
 */

import type { ApprovalBlock, QuestionBlock } from '@kiki/session-core/session';

import type { MockApproval, MockQuestion } from './states';

const CREATED = '2026-10-08T10:00:00.000Z';
const EXPIRES = '2099-01-01T00:00:00.000Z';

export function approvalBlock(mock: MockApproval): ApprovalBlock {
  const isFile = mock.tool === 'Write';
  return {
    kind: 'approval',
    id: `approval-${mock.id}`,
    request: {
      approval_id: mock.id,
      session_id: 'session_preview',
      tool_call_id: `call-${mock.id}`,
      tool_name: mock.tool,
      action: mock.action,
      tool_input_display: isFile
        ? { kind: 'file_io', operation: 'write', path: mock.command }
        : { kind: 'command', command: mock.command },
      created_at: CREATED,
      expires_at: EXPIRES,
    },
    resolution: undefined,
    originAgentId: mock.origin,
  };
}

export function questionBlock(mock: MockQuestion): QuestionBlock {
  return {
    kind: 'question',
    id: `question-${mock.id}`,
    request: {
      question_id: mock.id,
      session_id: 'session_preview',
      questions: [{
        id: `${mock.id}-1`,
        question: mock.question,
        options: mock.options.map((label, index) => ({ id: `${mock.id}-o${index}`, label })),
      }],
      created_at: CREATED,
    },
    outcome: undefined,
  };
}

/** A flat, neutral placeholder "screenshot" for the image tile. */
export const PREVIEW_IMAGE = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#e9dfcc"/><rect x="10" y="12" width="76" height="8" rx="2" fill="#c9b99c"/><rect x="10" y="28" width="52" height="6" rx="2" fill="#d6c8ad"/><rect x="10" y="40" width="64" height="6" rx="2" fill="#d6c8ad"/><rect x="10" y="60" width="76" height="24" rx="4" fill="#fffdf8"/></svg>',
)}`;
