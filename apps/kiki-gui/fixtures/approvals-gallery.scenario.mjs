/**
 * approvals-gallery — five pending approvals side by side: Bash command,
 * Edit (file_io), Write create, a url_fetch, and an unknown tool whose
 * display payload has no displayable command (labeled raw-JSON fallback).
 * No script — the point is the cards themselves.
 */

import { sessionRecord } from './helpers.mjs';

const SID = 'session_fixture_gallery';

const expires = new Date(Date.now() + 23 * 3600_000).toISOString();
const created = new Date().toISOString();

function approval(id, toolName, action, display, toolCallId) {
  return {
    approval_id: id,
    session_id: SID,
    turn_id: 1,
    tool_call_id: toolCallId,
    tool_name: toolName,
    action,
    tool_input_display: display,
    created_at: created,
    expires_at: expires,
  };
}

export default {
  sessions: [
    sessionRecord(SID, {
      title: 'Fixture: approvals gallery',
      busy: true,
      pending_interaction: 'approval',
    }),
  ],
  snapshots: {
    [SID]: {
      messages: [],
      pending_approvals: [
        approval('approval_gal_bash', 'Bash', 'Running: pnpm test', { kind: 'command', command: 'pnpm test' }, 'call_gal_bash'),
        approval(
          'approval_gal_edit',
          'Edit',
          'Editing C:/fixture/workshop/bench.md',
          {
            kind: 'file_io',
            operation: 'edit',
            path: 'C:/fixture/workshop/bench.md',
            before: '# bench\n\ntail vise\n',
            after: '# bench\n\nface vise + tail vise\n',
          },
          'call_gal_edit',
        ),
        approval(
          'approval_gal_write',
          'Write',
          'Writing C:/fixture/workshop/cut-list.md',
          { kind: 'file_io', operation: 'write', path: 'C:/fixture/workshop/cut-list.md', content: '- legs x4\n- apron x2\n' },
          'call_gal_write',
        ),
        approval(
          'approval_gal_fetch',
          'WebFetch',
          'Fetching https://example.com/spec',
          { kind: 'url_fetch', url: 'https://example.com/spec' },
          'call_gal_fetch',
        ),
        approval(
          'approval_gal_mystery',
          'ProbeTool',
          'ProbeTool wants to run',
          // No command/path/summary the card can recognize → raw JSON details.
          { flavor: 'mystery', nested: { depth: 2, flags: ['x', 'y'] } },
          'call_gal_mystery',
        ),
      ],
    },
  },
};
