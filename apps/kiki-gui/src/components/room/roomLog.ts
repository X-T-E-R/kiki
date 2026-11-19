/**
 * Room log helpers: incremental polling of `GET /rooms/{id}/log` (the server
 * has no room push stream yet), the @-completion token under the caret, the
 * localized line for a system entry, and the usage sum across members.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { RoomDocument, RoomLogEntry, RoomUsage } from '@kiki/protocol';
import { markRoomSeen } from '@kiki/session-core/settings';

import type { BotRoomApi } from '../../lib/botRooms';

export const ROOM_POLL_MS = 2000;
export const ROOM_IDLE_POLL_MS = 15_000;
/** The newest this many entries stay on the page. */
export const ROOM_LOG_WINDOW = 2000;
const PAGE = 500;

export interface RoomLogState {
  readonly entries: readonly RoomLogEntry[];
  readonly loaded: boolean;
  readonly error: unknown;
  readonly truncated: boolean;
  /** Fetch whatever is new right now (after a send or an action). */
  readonly refresh: () => void;
}

/** Pages the whole log once, then asks only for entries after the last id. */
export function useRoomLog(api: BotRoomApi, roomId: string, pollIntervalMs: number | false = ROOM_POLL_MS): RoomLogState {
  const [entries, setEntries] = useState<readonly RoomLogEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [truncated, setTruncated] = useState(false);
  const lastId = useRef<string | undefined>(undefined);
  const inFlight = useRef<Promise<void> | null>(null);
  const alive = useRef(true);

  const pull = useCallback(() => {
    if (inFlight.current !== null) return inFlight.current;
    const run = (async () => {
      try {
        let after = lastId.current;
        for (;;) {
          const page = await api.roomLog(roomId, { afterId: after, limit: PAGE });
          if (!alive.current) return;
          if (page.lastSeq !== undefined && document.visibilityState !== 'hidden') markRoomSeen(roomId, page.lastSeq);
          if (page.entries.length > 0) {
            const pageEntries = page.entries;
            after = pageEntries.at(-1)?.id ?? after;
            lastId.current = after;
            let didTruncate = false;
            setEntries((current) => {
              const seen = new Set(current.map((entry) => entry.id));
              const merged = [...current, ...pageEntries.filter((entry) => !seen.has(entry.id))];
              if (merged.length > ROOM_LOG_WINDOW) didTruncate = true;
              return merged.length > ROOM_LOG_WINDOW ? merged.slice(-ROOM_LOG_WINDOW) : merged;
            });
            if (didTruncate) setTruncated(true);
          }
          setError(null);
          setLoaded(true);
          if (page.nextCursor === undefined || page.entries.length === 0) break;
        }
      } catch (caught) {
        if (alive.current) setError(caught);
      } finally {
        inFlight.current = null;
      }
    })();
    inFlight.current = run;
    return run;
  }, [api, roomId]);

  useEffect(() => {
    alive.current = true;
    lastId.current = undefined;
    setEntries([]);
    setLoaded(false);
    setError(null);
    setTruncated(false);
    void pull();
    return () => {
      alive.current = false;
    };
  }, [pull]);

  useEffect(() => {
    if (pollIntervalMs === false) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void pull();
    }, pollIntervalMs);
    return () => {
      window.clearInterval(timer);
    };
  }, [pull, pollIntervalMs]);

  return { entries, loaded, error, truncated, refresh: () => { void pull(); } };
}

/** The `@partial` word ending at the caret, if the caret is inside one. */
export function mentionAtCaret(text: string, caret: number): { readonly start: number; readonly query: string } | undefined {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([^\s@]*)$/u.exec(before);
  if (match === null) return undefined;
  const query = match[2] ?? '';
  return { start: caret - query.length - 1, query };
}

export interface MentionOption {
  readonly key: string;
  /** Inserted after `@`. */
  readonly insert: string;
  readonly label: string;
  readonly hint?: string;
  readonly personaId?: string;
}

/** Everyone first, then members whose name or id starts with (or contains) the query. */
export function mentionOptions(
  members: readonly { readonly personaId: string; readonly name: string; readonly hint?: string }[],
  query: string,
  everyone: { readonly label: string; readonly hint: string },
): MentionOption[] {
  const needle = query.toLocaleLowerCase();
  const all: MentionOption = { key: '*', insert: everyone.label, label: everyone.label, hint: everyone.hint };
  const people = members
    .map((member) => ({ key: member.personaId, insert: member.name, label: member.name, hint: member.hint, personaId: member.personaId }))
    .filter((option) => needle === ''
      || option.label.toLocaleLowerCase().includes(needle)
      || option.key.toLocaleLowerCase().startsWith(needle));
  const everyoneMatches = needle === '' || all.label.toLocaleLowerCase().includes(needle)
    || 'everyone'.startsWith(needle) || 'all'.startsWith(needle);
  return everyoneMatches ? [all, ...people] : people;
}

/** Sum of every member session's token total; undefined when none reported. */
export function roomTokenTotal(usage: RoomUsage | undefined): number | undefined {
  if (usage === undefined) return undefined;
  let total = 0;
  let any = false;
  for (const member of usage.members) {
    const value = member.usage as { total?: Record<string, unknown> } | undefined;
    const counts = value?.total;
    if (counts === undefined || counts === null || typeof counts !== 'object') continue;
    for (const key of ['inputOther', 'output', 'inputCacheRead', 'inputCacheCreation']) {
      const count = counts[key];
      if (typeof count === 'number' && Number.isFinite(count)) { total += count; any = true; }
    }
  }
  return any ? total : undefined;
}

/** Index of the pause entry the live paused state belongs to (gets the actions). */
export function livePauseIndex(entries: readonly RoomLogEntry[], room: RoomDocument | undefined): number {
  if (room?.paused !== true) return -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind !== 'system') continue;
    if (entry.event === 'continued') return -1;
    if (entry.event === 'budget_exhausted' || entry.event === 'paused') return index;
  }
  return -1;
}

/** The server's refusal for a roster / workspace change during a live turn. */
export function isStopFirstError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /stop the active room turn/iu.test(message);
}
