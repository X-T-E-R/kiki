/**
 * Display projection for user messages that arrived from another agent or
 * thread rather than from this window's composer.
 *
 * The durable text of such a message opens with the producer's envelope
 * (`Message from agent "…" (…):`, `Message from thread …:`, `Verified
 * message from space …`) because the model reads that line; the wire record
 * stays byte-exact. The transcript already states the source in its own line
 * above the bubble (the sender label, or the bridged-origin row), so the
 * bubble, its copy text, and reply quotes show only the body.
 *
 * The envelope comes off only when both halves of the contract hold: the
 * block carries the trusted origin metadata for that source (the text alone
 * is never evidence), and the text still opens with the exact envelope shape
 * the producer writes. A literal "Message from" someone typed, an old record
 * without origin metadata, and a producer that no longer wraps all render
 * untouched rather than being eaten by a looser rule.
 *
 * Editing runs the projection the other way: the editor opens the durable
 * bytes the producer wrote — envelope included, because a rewrite replaces
 * that record — while the generated material the presentation marks (context
 * blocks, attachment notices, carry selections) stays stripped. An envelope
 * the projection strips as a source span would otherwise be quietly dropped
 * from the message the model reads.
 */

import { parseSelectionCarryovers } from '@kiki/session-core/composer';
import type { UserBlock } from '@kiki/session-core/session';
import { shiftTextPresentation, type TextPresentation } from '@kiki/transcript';

/** The trusted source a user block carries: mailbox agent, peer thread, or a bridged home. */
export type UserMessageSource = 'agent' | 'thread' | 'bridged';

const AGENT_ENVELOPE = /^Message from (?:external )?agent "[^"\r\n]*" \([^\r\n()]*\):\r?\n\r?\n/;
const THREAD_ENVELOPE = /^Message from thread (?:"[^"\r\n]*" \([^\r\n()]*\)|[^\r\n():]*):\r?\n\r?\n/;
const BRIDGED_ENVELOPE = /^Verified message from space \S+ · thread \S+ \((?:local|network)\):\r?\n\r?\n/;

const ENVELOPES: Readonly<Record<UserMessageSource, RegExp>> = {
  agent: AGENT_ENVELOPE,
  thread: THREAD_ENVELOPE,
  bridged: BRIDGED_ENVELOPE,
};

/** The source the origin metadata proves, or undefined for the user's own voice. */
export function userMessageSource(
  block: Pick<UserBlock, 'agentMessage' | 'peerThread' | 'bridgedPeer'>,
): UserMessageSource | undefined {
  if (block.agentMessage !== undefined) return 'agent';
  if (block.peerThread !== undefined) return 'thread';
  if (block.bridgedPeer !== undefined) return 'bridged';
  return undefined;
}

/** The envelope this block's own text opens with, once metadata and text shape agree on it. */
function envelopeOf(
  block: Pick<UserBlock, 'text' | 'agentMessage' | 'peerThread' | 'bridgedPeer'>,
): string | undefined {
  const source = userMessageSource(block);
  return source === undefined ? undefined : ENVELOPES[source].exec(block.text)?.[0];
}

/**
 * The text the transcript shows: the body without the transport envelope
 * when the metadata-gated contract holds, the verbatim text otherwise.
 * Presentation spans are code-unit offsets into the raw text, so they shift
 * by the removed prefix; a span the envelope fully covered is gone.
 */
export function displayUserMessageText(
  block: Pick<UserBlock, 'text' | 'presentation' | 'agentMessage' | 'peerThread' | 'bridgedPeer'>,
): { readonly text: string; readonly presentation?: TextPresentation } {
  const envelope = envelopeOf(block);
  if (envelope === undefined) return { text: block.text, presentation: block.presentation };
  const cut = envelope.length;
  return { text: block.text.slice(cut), presentation: shiftPastEnvelope(block.presentation, cut) };
}

/**
 * The text an edit opens with, and so the text a rewrite sends back: the
 * durable message with every generated span its presentation marks removed —
 * the transport envelope excepted, since that line is what the model reads
 * and only the bubble hides it. Without a proven envelope this is the
 * ordinary carry projection, so user-authored text keeps its own rules.
 */
export function editableUserMessageText(
  block: Pick<UserBlock, 'text' | 'presentation' | 'agentMessage' | 'peerThread' | 'bridgedPeer'>,
): string {
  const envelope = envelopeOf(block);
  if (envelope === undefined) return parseSelectionCarryovers(block.text, block.presentation).body;
  return parseSelectionCarryovers(block.text, withoutEnvelopeSpans(block.presentation, envelope.length)).body;
}

/**
 * Drop `cut` code units from the front of the presentation. The offset
 * arithmetic stays in the transcript contract's own shift; a span the cut
 * covered entirely falls out, and one that straddled the cut clamps to the
 * new start instead of going negative.
 */
function shiftPastEnvelope(presentation: TextPresentation | undefined, cut: number): TextPresentation | undefined {
  if (presentation === undefined) return undefined;
  const spans = (shiftTextPresentation(presentation, -cut)?.spans ?? [])
    .filter((span) => span.end > 0)
    .map((span) => (span.start < 0 ? { ...span, start: 0 } : span));
  return spans.length === 0 ? undefined : { spans };
}

/**
 * The presentation as an edit projection must read it. The envelope's own byte
 * range is durable rather than generated, so a span lying inside it leaves the
 * list entirely, and a span that reaches past the cut is clipped to the body
 * side: the envelope keeps every byte the producer wrote, while the generated
 * part of that span is still projected out.
 */
function withoutEnvelopeSpans(presentation: TextPresentation | undefined, cut: number): TextPresentation | undefined {
  const spans = (presentation?.spans ?? [])
    .filter((span) => span.end > cut)
    .map((span) => (span.start < cut ? { ...span, start: cut } : span));
  return spans.length === 0 ? undefined : { spans };
}
