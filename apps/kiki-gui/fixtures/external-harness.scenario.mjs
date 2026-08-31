/**
 * external-harness — a running turn executed by an external ACP harness
 * (executor badge + degraded-fidelity loss codes on the turn header) with a
 * pending external permission request rendered as the open option list (not
 * the native three-button card), anchored after its gated tool call.
 * Resolving the "Always allow" option shows the outcome line.
 */

import { sessionRecord } from './helpers.mjs';

const SID = 'session_fixture_external_harness';

const expires = new Date(Date.now() + 23 * 3600_000).toISOString();
const created = new Date().toISOString();

export default {
  sessions: [
    sessionRecord(SID, {
      title: 'Fixture: external harness',
      busy: true,
      pending_interaction: 'approval',
    }),
  ],
  snapshots: {
    [SID]: {
      messages: [],
      has_more: false,
      agent_transcripts: {
        main: {
          agent_id: 'main',
          has_more: false,
          items: [
            {
              kind: 'turn',
              turnId: 't1',
              ordinal: 1,
              state: 'running',
              origin: { kind: 'user', payload: { promptId: 'p-ext-1', userMessageId: 'um-ext-1' } },
              prompt: 'Summarize the workshop layout.',
              startedAt: created,
              // Supplemental executor.turn.metadata → TranscriptTurn.execution.
              execution: {
                executorId: 'grok',
                protocol: 'acp-v1',
                resumeMode: 'resume',
                profileDelivery: 'native',
                fidelity: 'degraded',
                losses: ['acp_no_step_boundaries', 'tool_output_summary_only'],
              },
              steps: [
                {
                  kind: 'step',
                  stepId: 't1.1',
                  turnId: 't1',
                  ordinal: 1,
                  state: 'completed',
                  frames: [
                    {
                      kind: 'text',
                      frameId: 'asst-t1-1',
                      role: 'assistant',
                      text: 'The workshop has a bench room, a tool wall, and a finishing nook.',
                    },
                    // Gated tool call: the permission card anchors after it.
                    {
                      kind: 'tool',
                      frameId: 'ext-grok-bash-frame',
                      toolCallId: 'call_ext_grok_bash',
                      name: 'grok__bash',
                      state: 'running',
                      input: { command: 'pnpm test' },
                      display: { kind: 'command', command: 'pnpm test' },
                    },
                  ],
                },
              ],
            },
          ],
          // Approval cards project from transcript interactions (project.ts
          // interactionToBlock), not from REST pending_approvals — the REST
          // seed below stays so the resolve route can find the approval.
          // interactionId must equal approval_id so the server's
          // resolvedInteractions map flips this entry after resolve.
          interactions: [
            {
              interactionId: 'approval_ext_grok',
              interactionKind: 'approval',
              toolCallId: 'call_ext_grok_bash',
              state: 'pending',
              request: {
                turnId: 2,
                toolCallId: 'call_ext_grok_bash',
                toolName: 'grok__bash',
                action: 'Run shell command',
                display: {
                  kind: 'external_permission',
                  summary: 'Grok wants to run: pnpm test',
                  detail: { cwd: 'C:/fixture/workshop' },
                  options: [
                    { id: 'opt-allow-once', label: 'Allow once', kind: 'allow_once' },
                    {
                      id: 'opt-allow-always',
                      label: 'Always allow pnpm test',
                      kind: 'allow_always',
                      changes: [{ type: 'command_rule', command: 'pnpm test', scope: 'session' }],
                    },
                    { id: 'opt-reject', label: 'Reject', kind: 'reject_once' },
                  ],
                },
                created_at: created,
                expires_at: expires,
              },
            },
          ],
        },
      },
      pending_approvals: [
        {
          approval_id: 'approval_ext_grok',
          session_id: SID,
          turn_id: 2,
          tool_call_id: 'call_ext_grok_bash',
          tool_name: 'grok__bash',
          action: 'Run shell command',
          tool_input_display: {
            kind: 'external_permission',
            summary: 'Grok wants to run: pnpm test',
            detail: { cwd: 'C:/fixture/workshop' },
            options: [
              { id: 'opt-allow-once', label: 'Allow once', kind: 'allow_once' },
              {
                id: 'opt-allow-always',
                label: 'Always allow pnpm test',
                kind: 'allow_always',
                changes: [{ type: 'command_rule', command: 'pnpm test', scope: 'session' }],
              },
              { id: 'opt-reject', label: 'Reject', kind: 'reject_once' },
            ],
          },
          created_at: created,
          expires_at: expires,
        },
      ],
    },
  },
};
