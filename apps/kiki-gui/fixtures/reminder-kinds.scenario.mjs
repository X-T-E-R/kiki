import { assistantMsg, originMsg, sessionRecord, userMsg } from './helpers.mjs';

const SID = 'session_fixture_reminder_kinds';

/**
 * Reminder categories: continuity reminders carry `disclosure.kind` on their
 * injection origin, and each kind heads its quiet row (directive, renew,
 * rebuild, history, progress). One plain reminder without a disclosure keeps
 * the generic "System reminder" heading, for contrast.
 */
const reminder = (kind, triggers, text, minutesAgo, userTurn) => originMsg(
  SID,
  `<system-reminder>\n${text}\n\nIgnore if not relevant. Do not mention this reminder to the user.\n</system-reminder>`,
  { kind: 'injection', variant: 'todo_list_reminder', disclosure: { kind, triggers, epoch: kind === 'rebuild' || kind === 'history' ? 2 : 1, userTurn } },
  minutesAgo,
);

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: reminder categories' })],
  snapshots: {
    [SID]: {
      has_more: false,
      messages: [
        userMsg(SID, 'From now on, run the lint before every commit.', 30),
        reminder('directive', ['E1'], "The user's latest input may set a standing instruction. If it applies beyond this step, add it to TodoList notes.directives (quote + t<turn>).", 29, 't1'),
        assistantMsg(SID, ['Noted — lint runs before every commit from here on.'], 28),
        reminder('progress', ['T1'], 'Working notes were last updated at step 4 and ~12000 tokens of new work followed. Update TodoList notes when convenient.', 20),
        assistantMsg(SID, ['Notes updated: goal, directives and the next step.'], 19),
        reminder('renew', ['T2'], 'The context window will be renewed soon (about 18000 tokens left). Bring TodoList notes up to date.', 12),
        assistantMsg(SID, ['Notes are current; ready for the new window.'], 11),
        reminder('rebuild', ['P1'], 'A new window started. Rebuild TodoList notes from the handoff before continuing: goal, directives, next.', 8),
        userMsg(SID, 'What did we decide about the retry budget earlier?', 6),
        reminder('history', ['E2'], 'The user refers to earlier conversation. Check Standing directives and User input since notes in the latest handoff first; if absent, HistorySearch this session.', 6, 't5'),
        assistantMsg(SID, ['We capped retries at three with jittered backoff.'], 5),
        userMsg(SID, 'Ship it.\n\n<system-reminder>\nImage compressed to fit the context window.\n</system-reminder>', 2),
        assistantMsg(SID, ['Shipped.'], 1),
      ],
    },
  },
};
