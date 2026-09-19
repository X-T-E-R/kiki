import { sessionRecord, ts } from './helpers.mjs';

const SID = 'session_fixture_goal_queue';

/**
 * Goal card + queue timing + recovery hold, all at rest: the session cold-loads
 * with a live goal and two parked prompts whose append timings differ, so the
 * strip shows the per-row timing segments in both states and the recovery gate
 * asks before resuming anything. No prompt traffic is scripted — the scenario
 * is a snapshot the walkers poke (dismiss the gate, re-time a row) without a
 * turn ever starting.
 */
export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: goal + queue' })],
  snapshots: {
    [SID]: {
      messages: [],
      has_more: false,
      // The GUI reads goal state from the transcript meta (Slice B), not from
      // the REST snapshot — seed both so the resting session shows it.
      agent_transcripts: {
        main: {
          agent_id: 'main',
          has_more: false,
          items: [],
          prompts: [
            {
              promptId: 'prompt_fx_gq_changelog',
              userMessageId: 'um_fx_gq_changelog',
              status: 'queued',
              content: [{ type: 'text', text: 'Draft the changelog entries for the release' }],
              createdAt: ts(9),
              queuePosition: 0,
              appendTiming: 'agent_idle',
              revision: 1,
            },
            {
              promptId: 'prompt_fx_gq_artifacts',
              userMessageId: 'um_fx_gq_artifacts',
              status: 'queued',
              content: [{ type: 'text', text: 'Sweep the release artifacts into the evidence bundle' }],
              createdAt: ts(8),
              queuePosition: 1,
              appendTiming: 'tasks_done',
              revision: 2,
            },
          ],
          meta: {
            goal: {
              objective: 'Prepare the release evidence bundle',
              status: 'active',
              completionCriterion: 'All checks and screenshots are archived',
              followUpTiming: 'subagents_done',
              controlRevision: 3,
              budgetUsed: 6800,
              budgetLimit: 20000,
            },
          },
        },
      },
      goal: {
        goalId: 'goal-fixture-queue',
        objective: 'Prepare the release evidence bundle',
        completionCriterion: 'All checks and screenshots are archived',
        status: 'active',
        followUpTiming: 'subagents_done',
        controlRevision: 3,
        turnsUsed: 2,
        tokensUsed: 6800,
        wallClockMs: 184000,
        budget: {
          tokenBudget: 20000,
          turnBudget: 8,
          wallClockBudgetMs: 900000,
          remainingTokens: 13200,
          remainingTurns: 6,
          remainingWallClockMs: 716000,
          tokenBudgetReached: false,
          turnBudgetReached: false,
          wallClockBudgetReached: false,
          overBudget: false,
        },
      },
      queued_prompts: [
        {
          prompt_id: 'prompt_fx_gq_changelog',
          user_message_id: 'um_fx_gq_changelog',
          status: 'queued',
          content: [{ type: 'text', text: 'Draft the changelog entries for the release' }],
          created_at: ts(9),
          append_timing: 'agent_idle',
          revision: 1,
        },
        {
          prompt_id: 'prompt_fx_gq_artifacts',
          user_message_id: 'um_fx_gq_artifacts',
          status: 'queued',
          content: [{ type: 'text', text: 'Sweep the release artifacts into the evidence bundle' }],
          created_at: ts(8),
          append_timing: 'tasks_done',
          revision: 2,
        },
      ],
    },
  },
};
