/**
 * Agent references — a `kiki://agents/<profile>` link the composer writes when
 * the user picks an agent target from the `@` menu, and the transcript renders
 * back as a chip. The protocol package owns the link format and the scan
 * (`agentRefLink` / `findAgentRefs`); this module owns the composer editing
 * contract around it: token replacement at the `@` trigger, whole-link
 * deletion, and caret placement.
 *
 * A reference is plain prompt text. Unlike a `@path` file mention it does NOT
 * become an attachment: the link stays inline so it survives edit/resend of a
 * queued message verbatim, and the backend reads it out of the text to inject
 * and associate the run. The composer tints the link range like a thread link.
 */

import { agentRefLink, findAgentRefs, type AgentRefMatch } from '@kiki/protocol';

export type { AgentRefMatch };
export { agentRefLink, findAgentRefs };

/**
 * Write an agent link at the `@` trigger that opened the menu. `trigger.start`
 * is the `@` index and `cursor` is where the caret sat (the trigger query runs
 * from `start + 1` to `cursor`); both are replaced by the link plus one
 * trailing space so typing continues after it. `reference` is the link the
 * server supplied for the picked candidate, written verbatim. Returns the new
 * text and the caret position just past that space.
 */
export function replaceMentionTriggerWithAgentRef(
  text: string,
  trigger: { readonly start: number },
  cursor: number,
  reference: string,
): { text: string; cursor: number } {
  const link = reference;
  const before = text.slice(0, trigger.start);
  const after = text.slice(Math.max(trigger.start, Math.min(cursor, text.length)));
  // A trailing space separates the link from whatever follows; a leading one is
  // the user's own (the `@` sat at a token boundary).
  const needsSpace = after === '' || !/^\s/.test(after);
  const inserted = needsSpace ? `${link} ` : link;
  return { text: before + inserted + after, cursor: before.length + inserted.length };
}

/**
 * Deletion that touches an agent link removes the whole link: Backspace just
 * after (or inside) one, Delete just before (or inside) one, or a selection
 * that overlaps one. Returns the widened range, or null when no link is hit —
 * the same contract as `threadRefDeletionRange` so both compose on one keypress.
 */
export function agentRefDeletionRange(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  key: 'Backspace' | 'Delete',
): { start: number; end: number } | null {
  const refs = findAgentRefs(text);
  if (refs.length === 0) return null;
  let start = Math.min(selectionStart, selectionEnd);
  let end = Math.max(selectionStart, selectionEnd);
  if (start === end) {
    const hit = refs.find((ref) =>
      key === 'Backspace' ? start > ref.start && start <= ref.end : start >= ref.start && start < ref.end,
    );
    return hit === undefined ? null : { start: hit.start, end: hit.end };
  }
  let widened = false;
  for (const ref of refs) {
    if (ref.end <= start || ref.start >= end) continue;
    if (ref.start < start) { start = ref.start; widened = true; }
    if (ref.end > end) { end = ref.end; widened = true; }
  }
  return widened ? { start, end } : null;
}

/** Remove one link from the draft along with one separating space. */
export function removeAgentRef(
  text: string,
  ref: Pick<AgentRefMatch, 'start' | 'end'>,
): { text: string; cursor: number } {
  const before = text.slice(0, ref.start);
  let after = text.slice(ref.end);
  if (/[ \t]$/.test(before) || before === '') after = after.replace(/^[ \t]/, '');
  return { text: before + after, cursor: before.length };
}
