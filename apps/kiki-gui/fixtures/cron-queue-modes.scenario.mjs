import { sessionRecord, ts } from './helpers.mjs';

const SID = 'session_fixture_cron_queue_modes';
const HELD_ONLY = 'session_fixture_cron_queue_modes_held';

/**
 * The queue as a user reads it once scheduled tasks have delivery timings:
 * their own messages and one **queue** job share the send order, while an
 * **idle** and a **steer** job are held ahead of it and say so on their rows.
 *
 * The distinction is the whole point of this scenario, so it seeds every
 * case at once — including a scheduled record with no recorded timing, which
 * was admitted into the ordinary order before the field existed and must
 * still read as one of the user's queued messages rather than as something
 * the engine holds.
 */
const cronText = (body) => `<cron-fire jobId="job-1"><prompt>${body}</prompt></cron-fire>`;

export default {
  sessions: [
    sessionRecord(SID, { title: 'Fixture: scheduled queue timings' }),
    // A session waiting only on held scheduled jobs. The header must not open
    // with "0 queued" above real work.
    sessionRecord(HELD_ONLY, { title: 'Fixture: only scheduled jobs waiting' }),
  ],
  snapshots: {
    [SID]: {
      messages: [],
      has_more: false,
      agent_transcripts: {
        main: {
          agent_id: 'main',
          has_more: false,
          items: [],
          prompts: [
            {
              promptId: 'prompt_fx_cqm_user',
              userMessageId: 'um_fx_cqm_user',
              status: 'queued',
              content: [{ type: 'text', text: 'Draft the release note for the desktop build.' }],
              createdAt: ts(9),
              queuePosition: 0,
              appendTiming: 'agent_idle',
              revision: 1,
            },
            {
              promptId: 'prompt_fx_cqm_queue',
              userMessageId: 'um_fx_cqm_queue',
              originKind: 'cron_job',
              originDeliveryMode: 'queue',
              status: 'queued',
              content: [{ type: 'text', text: cronText('Poll the release channel for anything that moved.') }],
              createdAt: ts(8),
              queuePosition: 1,
              appendTiming: 'agent_idle',
              revision: 1,
            },
            {
              promptId: 'prompt_fx_cqm_legacy',
              userMessageId: 'um_fx_cqm_legacy',
              originKind: 'cron_job',
              status: 'queued',
              content: [{ type: 'text', text: cronText('Read the runbook before the next release window.') }],
              createdAt: ts(7),
              queuePosition: 2,
              appendTiming: 'agent_idle',
              revision: 1,
            },
            {
              promptId: 'prompt_fx_cqm_idle',
              userMessageId: 'um_fx_cqm_idle',
              originKind: 'cron_job',
              originDeliveryMode: 'idle',
              status: 'queued',
              content: [{ type: 'text', text: cronText('Controller self-check: keep existing work running.') }],
              createdAt: ts(6),
              queuePosition: 3,
              appendTiming: 'agent_idle',
              revision: 1,
            },
            {
              promptId: 'prompt_fx_cqm_steer',
              userMessageId: 'um_fx_cqm_steer',
              originKind: 'cron_job',
              originDeliveryMode: 'steer',
              status: 'queued',
              content: [{ type: 'text', text: cronText('Read the newest incident note before you answer.') }],
              createdAt: ts(5),
              queuePosition: 4,
              appendTiming: 'agent_idle',
              revision: 1,
            },
          ],
          meta: {},
        },
      },
    },
    [HELD_ONLY]: {
      messages: [],
      has_more: false,
      agent_transcripts: {
        main: {
          agent_id: 'main',
          has_more: false,
          items: [],
          prompts: [
            {
              promptId: 'prompt_fx_cqmo_idle',
              userMessageId: 'um_fx_cqmo_idle',
              originKind: 'cron_job',
              originDeliveryMode: 'idle',
              status: 'queued',
              content: [{ type: 'text', text: cronText('Summarize the overnight logs before the release window opens.') }],
              createdAt: ts(4),
              queuePosition: 0,
              appendTiming: 'agent_idle',
              revision: 1,
            },
            {
              promptId: 'prompt_fx_cqmo_steer',
              userMessageId: 'um_fx_cqmo_steer',
              originKind: 'cron_job',
              originDeliveryMode: 'steer',
              status: 'queued',
              content: [{ type: 'text', text: cronText('Read the newest incident note before you answer.') }],
              createdAt: ts(3),
              queuePosition: 1,
              appendTiming: 'agent_idle',
              revision: 1,
            },
          ],
          meta: {},
        },
      },
      // The REST mirror of the same backlog, so the queue is populated the
      // way a real host serves it rather than by one path alone.
      queued_prompts: [
        {
          prompt_id: 'prompt_fx_cqmo_idle',
          user_message_id: 'um_fx_cqmo_idle',
          status: 'queued',
          content: [{ type: 'text', text: cronText('Summarize the overnight logs before the release window opens.') }],
          created_at: ts(4),
          append_timing: 'agent_idle',
          revision: 1,
        },
        {
          prompt_id: 'prompt_fx_cqmo_steer',
          user_message_id: 'um_fx_cqmo_steer',
          status: 'queued',
          content: [{ type: 'text', text: cronText('Read the newest incident note before you answer.') }],
          created_at: ts(3),
          append_timing: 'agent_idle',
          revision: 1,
        },
      ],
    },
  },
  queued_prompts: [
    {
      prompt_id: 'prompt_fx_cqm_user',
      user_message_id: 'um_fx_cqm_user',
      status: 'queued',
      content: [{ type: 'text', text: 'Draft the release note for the desktop build.' }],
      created_at: ts(9),
      append_timing: 'agent_idle',
      revision: 1,
    },
    {
      prompt_id: 'prompt_fx_cqm_queue',
      user_message_id: 'um_fx_cqm_queue',
      status: 'queued',
      content: [{ type: 'text', text: cronText('Poll the release channel for anything that moved.') }],
      created_at: ts(8),
      append_timing: 'agent_idle',
      revision: 1,
    },
    {
      prompt_id: 'prompt_fx_cqm_legacy',
      user_message_id: 'um_fx_cqm_legacy',
      status: 'queued',
      content: [{ type: 'text', text: cronText('Read the runbook before the next release window.') }],
      created_at: ts(7),
      append_timing: 'agent_idle',
      revision: 1,
    },
    {
      prompt_id: 'prompt_fx_cqm_idle',
      user_message_id: 'um_fx_cqm_idle',
      status: 'queued',
      content: [{ type: 'text', text: cronText('Controller self-check: keep existing work running.') }],
      created_at: ts(6),
      append_timing: 'agent_idle',
      revision: 1,
    },
    {
      prompt_id: 'prompt_fx_cqm_steer',
      user_message_id: 'um_fx_cqm_steer',
      status: 'queued',
      content: [{ type: 'text', text: cronText('Read the newest incident note before you answer.') }],
      created_at: ts(5),
      append_timing: 'agent_idle',
      revision: 1,
    },
  ],
  onPrompt: () => [
    { frame: { type: 'turn.started', payload: { turnId: 1, origin: { kind: 'user' }, prompt: 'A holds the floor.' } } },
    { frame: { type: 'event.session.work_changed', payload: { busy: true, pending_interaction: 'none' } } },
    { frame: { type: 'assistant.delta', offset: 0, payload: { turnId: 1, delta: 'Working.' } } },
    { waitFor: 'release' },
    { frame: { type: 'turn.ended', payload: { turnId: 1, reason: 'completed', durationMs: 300 } } },
    { frame: { type: 'event.session.work_changed', payload: { busy: false, pending_interaction: 'none' } } },
  ],
};

export { SID, HELD_ONLY };