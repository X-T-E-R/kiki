import { assistantMsg, originMsg, sessionRecord, userMsg } from './helpers.mjs';

const SID = 'session_fixture_task_notified';

/**
 * Regression: a background task's completion notification surfaces mid-turn as
 * a user-role input. Whether it arrives with an explicit task origin (patched
 * server projection / cold REST) or as a bare `<notification>` envelope with no
 * origin at all (legacy records), it must render on the left system/task lane —
 * never as a right-side You bubble. The typed user prompt is the positive
 * control: it must stay a You bubble.
 */
export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: task notified mid-turn' })],
  snapshots: {
    [SID]: {
      has_more: false,
      messages: [
        userMsg(SID, 'Run the fixture suite in the background.', 6),
        assistantMsg(SID, ['Started the suite as a background task — I will keep working.'], 5),
        // Patched cold shape: the task origin rides the record.
        originMsg(
          SID,
          'Background process completed\npnpm test — 42 passed',
          { kind: 'task', taskId: 'task_1' },
          4,
        ),
        // Legacy/hardening shape: no origin, only the notification envelope.
        userMsg(
          SID,
          '<notification id="n2" category="task" type="task.completed" source_kind="background_task" source_id="task_2">\nTitle: Background agent completed\nreview finished\n</notification>',
          3,
        ),
        assistantMsg(SID, ['Suite is green — 42 passed.'], 2),
      ],
    },
  },
};
