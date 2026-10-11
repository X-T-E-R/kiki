import { messageContentSchema, type MessageContent } from '@kiki/protocol';
import { spaceStorage, type SpaceStorage } from '../storage/spaceStorage';

const KEY = 'kiki.unconfirmedSubmissions';

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

function write(storage: SpaceStorage, items: readonly UnconfirmedSubmission[]): void {
  if (items.length === 0) storage.removeItem(KEY);
  else storage.setItem(KEY, JSON.stringify(items));
}

export interface SubmissionPreservation {
  readonly persisted: boolean;
  readonly acknowledge: () => void;
}

/** Best-effort backup before transport submission; a failed backup must retain the composition until acknowledgement. */
export function preserveSubmission(input: UnconfirmedSubmission): SubmissionPreservation {
  const storage = spaceStorage.capture();
  let persisted = false;
  try {
    const previous = read(storage).filter(item => item.sessionId !== input.sessionId || item.agentId !== input.agentId || item.promptId !== input.promptId);
    write(storage, [...previous, input]);
    persisted = true;
  } catch { /* Backup capacity and storage policy do not constrain message submission. */ }
  return {
    persisted,
    acknowledge: () => {
      try {
        write(storage, read(storage).filter(item => item.sessionId !== input.sessionId || item.agentId !== input.agentId || item.promptId !== input.promptId));
      } catch { /* An accepted send must never become a failed submission because storage cleanup failed. */ }
    },
  };
}

export function readUnconfirmedSubmissions(sessionId: string): readonly UnconfirmedSubmission[] {
  return read(spaceStorage).filter(item => item.sessionId === sessionId);
}

/** Remove only an acknowledged identity or an item explicitly dismissed by its author; never resend. */
export function forgetUnconfirmedSubmission(sessionId: string, promptId: string): void {
  if (typeof localStorage === 'undefined') return;
  write(spaceStorage, read(spaceStorage).filter(item => item.sessionId !== sessionId || item.promptId !== promptId));
}
