/**
 * error-abort — on prompt: a failing tool call (isError result) followed by a
 * slow stream the runner aborts mid-flight → prompt.aborted + turn.ended
 * (cancelled) arrive over the wire. Proves the aborted notice, the failed
 * tool card, and the group's auto-expand-on-error.
 */

import {
  approvalFrame,
  commitAssistant,
  fid,
  sessionRecord,
  streamSteps,
  turnEnd,
  turnStart,
  workChanged,
} from './helpers.mjs';

const SID = 'session_fixture_abort';
const FAIL_CALL = fid('call');
const SLOW_CALL = fid('call');

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: error + abort' })],
  snapshots: {
    [SID]: {
      messages: [],
      subagents: [
        {
          id: 'agent-sub-0',
          agent_id: 'agent-sub-0',
          session_id: SID,
          kind: 'subagent',
          label: 'worker',
          parent_agent_id: 'main',
          status: 'running',
          description: 'Inspect worker logs',
          created_at: '2026-01-01T11:55:02.000Z',
          started_at: '2026-01-01T11:55:02.000Z',
        },
      ],
      agent_transcripts: {
        main: {
          items: [
            {
              kind: 'turn',
              turnId: 't0',
              ordinal: 0,
              state: 'failed',
              origin: { kind: 'user', payload: { promptId: 'p0', userMessageId: 'um0' } },
              promptId: 'p0',
              prompt: 'Check the upstream provider worker status.',
              startedAt: '2026-01-01T11:55:00.000Z',
              endedAt: '2026-01-01T11:58:05.000Z',
              durationMs: 185438,
              error: 'Anthropic error: antigravity_missing_terminal: Upstream completed without a usable answer.',
              errorDetails: [
                'Anthropic error: antigravity_missing_terminal: Upstream completed without a usable answer.',
                'code=provider.api_error · upstreamErrorCode=antigravity_missing_terminal · upstreamErrorType=api_error · errorSource=provider_event · request_delivery=executed · request_output=observed · upstream_retryable=false',
              ].join('\n'),
              steps: [
                {
                  kind: 'step',
                  stepId: 't0.1',
                  turnId: 't0',
                  ordinal: 1,
                  state: 'interrupted',
                  startedAt: '2026-01-01T11:55:00.000Z',
                  endedAt: '2026-01-01T11:58:05.000Z',
                  frames: [
                    {
                      kind: 'text',
                      frameId: 'um0',
                      role: 'user',
                      text: 'Check the upstream provider worker status.',
                      part: { partId: 'um0', messageId: 'um0', revision: 0, provenance: { source: 'engine' } },
                    },
                    {
                      kind: 'tool',
                      frameId: 'tool-call-sub-0',
                      toolCallId: 'call-sub-0',
                      name: 'AgentRun',
                      state: 'error',
                      input: { description: 'Inspect worker logs', profile: 'worker', prompt: 'Check the worker logs.' },
                      error: '400 Bad Request — INVALID_ARGUMENT: Please ensure that function call turn comes immediately after a user turn or after a function response turn.',
                      taskId: 'agent-sub-0',
                      agentRefs: [{ agentId: 'agent-sub-0', role: 'child' }],
                      startedAt: '2026-01-01T11:55:02.000Z',
                      endedAt: '2026-01-01T11:55:03.319Z',
                    },
                  ],
                },
              ],
            },
          ],
          tasks: [
            {
              taskId: 'agent-sub-0',
              kind: 'subagent',
              state: 'running',
              detached: false,
              subagentName: 'worker',
              description: 'Inspect worker logs',
              agentId: 'agent-sub-0',
              parentToolCallId: 'call-sub-0',
              toolCallId: 'call-sub-0',
              outputTail: '',
              startedAt: '2026-01-01T11:55:02.000Z',
            },
          ],
          prompts: [
            {
              promptId: 'p0',
              userMessageId: 'um0',
              status: 'failed',
              content: [{ type: 'text', text: 'Check the upstream provider worker status.' }],
              createdAt: '2026-01-01T11:55:00.000Z',
              finishedAt: '2026-01-01T11:58:05.000Z',
            },
          ],
        },
        'agent-sub-0': {
          items: [
            {
              kind: 'turn',
              turnId: 't0',
              ordinal: 0,
              state: 'failed',
              origin: { kind: 'user' },
              prompt: 'Check the worker logs.',
              startedAt: '2026-01-01T11:55:02.000Z',
              endedAt: '2026-01-01T11:55:03.319Z',
              durationMs: 1319,
              error: '400 Bad Request — INVALID_ARGUMENT: Please ensure that function call turn comes immediately after a user turn or after a function response turn.',
              errorDetails: [
                '400 Bad Request — INVALID_ARGUMENT: Please ensure that function call turn comes immediately after a user turn or after a function response turn.',
                'code=provider.api_error · statusCode=400 · upstreamErrorCode=unlisted_upstream_turn_order_error · upstreamErrorType=INVALID_ARGUMENT · errorSource=provider_http · requestId=00000000-0000-4000-8000-000000000001 · upstreamDetails={"client_request_id":"00000000-0000-4000-8000-000000000002"}',
              ].join('\n'),
              steps: [],
            },
          ],
        },
      },
    },
  },
  onPrompt: [
    turnStart(1, 'Run the failing then slow fixture.'),
    workChanged(true),
    { frame: { type: 'turn.step.started', payload: { turnId: 1, step: 1 } } },
    {
      frame: {
        type: 'tool.call.started',
        payload: {
          turnId: 1, toolCallId: FAIL_CALL, name: 'Bash',
          args: { command: 'exit 3' },
          display: { kind: 'command', command: 'exit 3' },
        },
      },
    },
    { delay: 200 },
    { frame: approvalFrame({ toolName: 'Bash', action: 'Running: exit 3', display: { kind: 'command', command: 'exit 3' }, toolCallId: FAIL_CALL }) },
    { waitFor: 'approval' },
    { delay: 300 },
    {
      frame: {
        type: 'tool.result',
        payload: {
          turnId: 1, toolCallId: FAIL_CALL, isError: true,
          output: { kind: 'command_output', exit_code: 3, stderr: 'fixture failure: forced exit' },
        },
      },
    },
    { delay: 250 },
    {
      frame: {
        type: 'tool.call.started',
        payload: {
          turnId: 1, toolCallId: SLOW_CALL, name: 'Read',
          args: { file_path: 'C:/fixture/workshop/slow.log' },
          display: { kind: 'file_io', operation: 'read', path: 'C:/fixture/workshop/slow.log' },
        },
      },
    },
    { delay: 200 },
    { frame: { type: 'tool.result', payload: { turnId: 1, toolCallId: SLOW_CALL, output: { kind: 'file_content', path: 'C:/fixture/workshop/slow.log', content: 'line\n' } } } },
    { delay: 300 },
    // A deliberately slow stream the runner aborts part-way through.
    ...streamSteps('assistant.delta', 1, 'The first command failed; recovering slowly' + ' …'.repeat(40), { per: 10, delay: 220 }),
    // Reached only if never aborted (the proof aborts long before this).
    turnEnd(1),
    commitAssistant('$SID', 'The first command failed; recovering slowly.'),
    workChanged(false),
  ],
};
