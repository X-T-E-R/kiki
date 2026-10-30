import { assistantMsg, sessionRecord, userMsg } from './helpers.mjs';

export const HISTORY_PAGING_SESSION = 'session_fixture_history_paging';
export const HISTORY_PAGING_TURNS = 1200;
const messages = Array.from({ length: HISTORY_PAGING_TURNS }, (_, index) => {
  const number = String(index).padStart(4, '0');
  return [
    userMsg(HISTORY_PAGING_SESSION, `Record ${number}: inspect this saved conversation entry.`, HISTORY_PAGING_TURNS - index),
    assistantMsg(HISTORY_PAGING_SESSION, [`Reply ${number}: this entry remains in chronological order.`], HISTORY_PAGING_TURNS - index),
  ];
});

export default {
  sessions: [sessionRecord(HISTORY_PAGING_SESSION, { title: 'Fixture: complete history paging', message_count: HISTORY_PAGING_TURNS * 2 })],
  snapshots: {
    [HISTORY_PAGING_SESSION]: { messages: messages.flat(), has_more: false },
  },
};
