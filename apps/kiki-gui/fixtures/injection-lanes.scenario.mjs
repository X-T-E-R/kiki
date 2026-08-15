import { assistantMsg, originMsg, sessionRecord, userMsg } from './helpers.mjs';

const SID = 'session_fixture_injection_lanes';

/**
 * Injection lane gallery: every non-user origin that arrives as a user-role
 * message must render on the left system lane (collapsed, dimmed) — cron fire,
 * compaction summary, non-slash skill activation, goal continuation — while a
 * typed user prompt stays a right-side You bubble.
 */
export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: injection lanes' })],
  snapshots: {
    [SID]: {
      has_more: false,
      messages: [
        userMsg(SID, 'Keep an eye on the nightly job.', 8),
        assistantMsg(SID, ['Watching it — will report when it fires.'], 7),
        originMsg(
          SID,
          '<cron-fire job="nightly">Run the nightly report.</cron-fire>',
          { kind: 'cron_job', jobId: 'nightly' },
          6,
        ),
        originMsg(
          SID,
          'Earlier context summarized: the user asked about the nightly job schedule.',
          { kind: 'compaction_summary' },
          5,
        ),
        originMsg(
          SID,
          'SKILL.md body: review the diff for regressions before merging.',
          { kind: 'skill_activation', skillName: 'review', trigger: 'auto' },
          4,
        ),
        originMsg(
          SID,
          'Continue toward the goal: finish the migration checklist.',
          { kind: 'system_trigger', name: 'goal_continuation' },
          3,
        ),
        assistantMsg(SID, ['Nightly job fired on schedule — report is attached.'], 2),
      ],
    },
  },
};
