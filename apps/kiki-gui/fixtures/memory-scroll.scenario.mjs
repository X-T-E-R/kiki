/**
 * memory-scroll — one long ledger: 204 global entries, one of them long enough
 * that its detail and its journal cannot fit on one screen.
 *
 * The list is the subject here, not the content: it exists so the console's
 * two panes have something to scroll independently, and so the list's cursor
 * continuation is exercised page by page — the page asks for 20 at a time and
 * follows `next_cursor` until the store says it is exhausted. The newest entry
 * sorts first and owns a 36-record journal, so the detail's own pane has a
 * long body and a long version list to scroll through.
 *
 * Everything else — settings, shell, the transcript — comes from the `memory`
 * scenario this one spreads.
 */

import memory from './memory.scenario.mjs';
import { ts } from './helpers.mjs';

const LONG_ID = 'm_scroll_long';
const LONG_TITLE = 'Release cut: what has to be reread before the tag';
const LONG_ENTRIES = 204;

const LONG_BODY = [
  'The release cut is read from docs/release.md, not from the last conversation about it. That file carries the ordered steps, the owner of each step, and the checks that have to be repeated before the tag rather than trusted from the previous cut.',
  '',
  'Three checks decide whether the cut may proceed: the workspace builds from a clean tree with the pinned Node and pnpm versions, the proof suite that covers the touched surfaces is green on the same commit, and every memory entry this cut relies on has been reread after its recheck date rather than carried forward. A check that has run out is a lead, not a premise.',
  '',
  'What this entry is not: it is not the changelog, it is not the release note, and it does not name a version. Those are written from the cut, and writing them here would make the two disagree. When a step changes, the change lands in docs/release.md first, and this entry follows it in the same session.',
  '',
  'Provenance matters more here than elsewhere: the steps were agreed in the release retro, and each of them has a named owner rather than "the team". If a step loses its owner, the cut stops at that step instead of continuing on the assumption that someone is watching it.',
  '',
  'The list beside this entry is long on purpose. Reading one entry should not move the others, and coming back to the list should land where the reader left it, still on the same entry, still with an unsaved draft if one was open.',
].join('\n');

const TYPE_CYCLE = ['project', 'feedback', 'reference', 'user'];
const TOPICS = [
  'Deploy window', 'Release checklist', 'Invoice export', 'Retry budget', 'Schema migration',
  'Browser proof', 'Nightly smoke', 'Token rotation', 'Queue timeout', 'Fixture home',
  'Log retention', 'Draft autosave', 'Locale default', 'Backup cadence', 'Rate limit',
  'Changelog entry', 'Failure tone',
];
const NOTES = [
  'what the team agreed', 'the value from the last review', 'where the rule came from',
  'the current source of truth', 'the single exception', 'as confirmed in the retro',
  'the older wording', 'the check that still holds', 'the fallback path', 'the numbers in use',
  'the file that owns it', 'the hand-off step',
];

function buildEntries() {
  const entries = [];
  for (let index = 0; index < LONG_ENTRIES; index += 1) {
    const topic = TOPICS[index % TOPICS.length];
    const note = NOTES[Math.floor(index / TOPICS.length) % NOTES.length];
    entries.push({
      id: index === 0 ? LONG_ID : `m_scroll_${String(index).padStart(3, '0')}`,
      type: TYPE_CYCLE[index % TYPE_CYCLE.length],
      title: index === 0 ? LONG_TITLE : `${topic} — ${note}`,
      body: index === 0 ? LONG_BODY : `${topic} follows ${note}; the file that owns it is the source, not this line.`,
      status: 'active',
      pinned: false,
      created: ts(4_000 + index),
      updated: ts(60 + index),
      source: { writer: index % 3 === 0 ? 'agent' : 'user', session: 'session_fixture_memory', turn: index + 1 },
      reason: '',
    });
  }
  return entries;
}

const entries = buildEntries();

/** A store-written before-image, which is what the version panel reads. */
const beforeImage = (entry, body) => `---\n${JSON.stringify({
  id: entry.id, title: entry.title, type: entry.type, status: entry.status, pinned: false,
  created: entry.created, updated: entry.updated, reason: entry.reason, source: entry.source,
})}\n---\n${body}`;

const longEntry = entries[0];
const journal = Array.from({ length: 36 }, (_, index) => ({
  operationId: `op_scroll_${String(index).padStart(3, '0')}`,
  id: LONG_ID,
  action: index === 0 ? 'create' : 'update',
  at: ts(30 + index * 90),
  writer: index % 2 === 0 ? 'agent' : 'user',
  before: beforeImage(longEntry, `${longEntry.body}\n\nRevision ${index}.`),
  beforeRevision: `rev_scroll_history_${index}`,
  afterRevision: `rev_scroll_history_${index + 1}`,
}));

export default {
  ...memory,
  memoryEntries: { ...memory.memoryEntries, global: entries },
  memoryJournal: { ...memory.memoryJournal, global: journal },
};
