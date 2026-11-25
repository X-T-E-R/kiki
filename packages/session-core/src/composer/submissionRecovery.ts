import { messageContentSchema, type MessageContent } from '@kiki/protocol';
import { spaceStorage, type SpaceStorage } from '../storage/spaceStorage';

export const UNCONFIRMED_SUBMISSIONS_STORAGE_KEY = 'kiki.unconfirmedSubmissions';
const KEY = UNCONFIRMED_SUBMISSIONS_STORAGE_KEY;

export interface UnconfirmedSubmission {
  readonly sessionId: string;
  readonly agentId: string;
  readonly promptId: string;
  readonly content: readonly MessageContent[];
  readonly createdAt: string;
}

function read(storage: SpaceStorage): UnconfirmedSubmission[] {
  try {
    const raw: unknown = JSON.parse(storage.getItem(KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item): UnconfirmedSubmission[] => {
      if (typeof item !== 'object' || item === null || typeof item.sessionId !== 'string' ||
          typeof item.agentId !== 'string' || typeof item.promptId !== 'string' || typeof item.createdAt !== 'string') return [];
      const content = messageContentSchema.array().safeParse(item.content);
      return content.success ? [{ ...item, content: content.data }] : [];
    });
  } catch { return []; }
}

const unconfirmedListeners = new Set<() => void>();
const inFlightSubmissions = new Map<string, number>();

function flightKey(sessionId: string, agentId: string, promptId: string): string {
  return JSON.stringify([sessionId, agentId, promptId]);
}

function notifyUnconfirmedListeners(): void {
  for (const listener of unconfirmedListeners) listener();
}

export function subscribeUnconfirmedSubmissions(listener: () => void): () => void {
  unconfirmedListeners.add(listener);
  return () => { unconfirmedListeners.delete(listener); };
}

export function isSubmissionInFlight(sessionId: string, promptId: string, agentId?: string): boolean {
  if (agentId !== undefined) return (inFlightSubmissions.get(flightKey(sessionId, agentId, promptId)) ?? 0) > 0;
  for (const [key, count] of inFlightSubmissions) {
    if (count <= 0) continue;
    try {
      const [sid, , pid] = JSON.parse(key) as [string, string, string];
      if (sid === sessionId && pid === promptId) return true;
    } catch { /* ignore malformed keys */ }
  }
  return false;
}

function write(storage: SpaceStorage, items: readonly UnconfirmedSubmission[]): void {
  if (items.length === 0) storage.removeItem(KEY);
  else storage.setItem(KEY, JSON.stringify(items));
  notifyUnconfirmedListeners();
}

export interface SubmissionPreservation {
  readonly persisted: boolean;
  readonly acknowledge: () => void;
  /** End active transport flight without discarding the backup (for unconfirmed transport errors). */
  readonly releaseFlight: () => void;
}

/** Best-effort backup before transport submission; a failed backup must retain the composition until acknowledgement. */
export function preserveSubmission(
  input: UnconfirmedSubmission,
  options: { readonly persist?: boolean; readonly inFlight?: boolean } = {},
): SubmissionPreservation {
  const trackFlight = options.inFlight === true;
  const key = flightKey(input.sessionId, input.agentId, input.promptId);
  let flightReleased = !trackFlight;
  const clearFlight = (notify: boolean): void => {
    if (flightReleased) return;
    flightReleased = true;
    const count = (inFlightSubmissions.get(key) ?? 0) - 1;
    if (count <= 0) inFlightSubmissions.delete(key);
    else inFlightSubmissions.set(key, count);
    if (notify) notifyUnconfirmedListeners();
  };
  if (trackFlight) {
    inFlightSubmissions.set(key, (inFlightSubmissions.get(key) ?? 0) + 1);
  }
  const storage = options.persist === false ? undefined : spaceStorage.capture();
  if (storage === undefined) {
    return {
      persisted: false,
      acknowledge: () => { clearFlight(true); },
      releaseFlight: () => { clearFlight(true); },
    };
  }
  let persisted = false;
  try {
    const previous = read(storage).filter(item => item.sessionId !== input.sessionId || item.agentId !== input.agentId || item.promptId !== input.promptId);
    write(storage, [...previous, input]);
    persisted = true;
  } catch { /* Backup capacity and storage policy do not constrain message submission. */ }
  return {
    persisted,
    releaseFlight: () => {
      clearFlight(true);
    },
    acknowledge: () => {
      clearFlight(false);
      try {
        write(storage, read(storage).filter(item => item.sessionId !== input.sessionId || item.agentId !== input.agentId || item.promptId !== input.promptId));
      } catch {
        /* An accepted send must never become a failed submission because storage cleanup failed. */
        notifyUnconfirmedListeners();
      }
    },
  };
}

export function readUnconfirmedSubmissions(sessionId: string, agentId?: string): readonly UnconfirmedSubmission[] {
  return read(spaceStorage).filter(
    item => item.sessionId === sessionId && (agentId === undefined || item.agentId === agentId),
  );
}

/** Remove only an acknowledged identity or an item explicitly dismissed by its author; never resend. */
export function forgetUnconfirmedSubmission(sessionId: string, promptId: string, agentId?: string): void {
  if (typeof localStorage === 'undefined') return;
  write(
    spaceStorage,
    read(spaceStorage).filter(
      item => item.sessionId !== sessionId || item.promptId !== promptId || (agentId !== undefined && item.agentId !== agentId),
    ),
  );
}
