/**
 * annotation-save-performance — many sent notes anchored into one large,
 * canonical assistant message. The final assistant row remains short so the
 * walk can also create and edit fresh draft selections without scrolling away
 * from the saved-note bubble under measurement.
 */

import {
  canonicalSelectionText,
  selectionCarryoverPresentation,
  sourceTextVersion,
} from '@kiki/session-core/composer/selectionQuote';
import { assistantMsg, sessionRecord, userMsg } from './helpers.mjs';

const SID = 'session_fixture_annotation_save_performance';
const ANNOTATION_COUNT = 24;
const sourceChunks = Array.from({ length: ANNOTATION_COUNT }, (_, index) =>
  `Annotation passage ${index}: ${`Detailed canonical history ${index}; `.repeat(12_000)}`,
);
const sourceText = sourceChunks.join('\n\n');
const openingMessage = userMsg(SID, 'Open the large canonical source.', 181);
const sourceMessage = assistantMsg(SID, [sourceText], 180);
const sourceBlockId = 'agent-frame-asst-t1-0';
const sourceVersion = sourceTextVersion(sourceText);
const messages = [openingMessage, sourceMessage];
let canonicalOffset = 0;

for (let index = 0; index < ANNOTATION_COUNT; index += 1) {
  const quote = `Annotation passage ${index}:`;
  const canonicalQuote = canonicalSelectionText(quote);
  const carry = selectionCarryoverPresentation([{
    quote,
    comment: index === ANNOTATION_COUNT - 1 ? 'Sent note before save' : `Sent note ${index}`,
    source: {
      blockId: sourceBlockId,
      version: sourceVersion,
      start: canonicalOffset,
      end: canonicalOffset + canonicalQuote.length,
      text: canonicalQuote,
    },
  }], []);
  const carrier = userMsg(SID, `${carry.prefix}History follow-up ${index}`, 170 - index * 2);
  carrier.content[0].presentation = carry.presentation;
  messages.push(
    carrier,
    assistantMsg(SID, [index === ANNOTATION_COUNT - 1
      ? 'Short reply 23 contains Draft target passage and Second draft target for fresh annotations.'
      : `Short reply ${index} keeps the conversation shape realistic.`], 169 - index * 2),
  );
  canonicalOffset += canonicalSelectionText(sourceChunks[index]).length;
}

export default {
  sessions: [sessionRecord(SID, {
    title: 'Fixture: annotation save performance',
    message_count: messages.length,
  })],
  snapshots: {
    [SID]: { messages, has_more: false },
  },
};
