/**
 * File drops anywhere on the conversation column, handed to the seated
 * composer. The card is what users aim at, but a release a little off it —
 * over the transcript — fell through to the browser, which opens the file in
 * the tab and unloads the app. ConversationShell takes FILE drags on the
 * column (text drags and the preview's tab reordering are never touched) and
 * provides this around the composer it seats.
 *
 * Its own module, not ConversationShell's: tests stub that module, and the
 * composer must not depend on what a stub happens to export.
 */

import { createContext, useContext } from 'react';

export interface SeatFileDrop {
  /** A file drag is over the column; the seated card shows its drop state. */
  readonly dragActive: boolean;
  /** The column element: the desktop drop bridge widens its hit test to it. */
  readonly column: HTMLElement | null;
  /** The seated composer's drop path; returns the unregister. */
  readonly registerDrop: (drop: (files: readonly File[]) => void) => () => void;
}

export const SeatFileDropContext = createContext<SeatFileDrop | null>(null);

/** Non-null only for the composer the shell seats (not an inline edit or a subagent's). */
export function useSeatFileDrop(): SeatFileDrop | null {
  return useContext(SeatFileDropContext);
}
