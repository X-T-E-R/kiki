/**
 * Conversation references — a link to another Kiki session (thread) or room
 * typed or pasted into a prompt. "Copy link" writes `/s/<id>` or `/rooms/<id>`;
 * browser and desktop URLs carry the same route behind a local or caller-supplied
 * origin, and explicit `kiki://` forms are accepted for hand-typed links.
 *
 * A reference is plain prompt text. At send time the GUI appends one
 * structured `<thread_refs>` block carrying known thread or room metadata and
 * tool guidance; the transcript strips that block back off and renders each
 * link as a chip, so the model sees context and the user never sees markup.
 */

import type { Session, Workspace } from '@kiki/protocol';

import { conversationRefLink } from '../sessions/conversationLinks';

/** Session ids are `session_<uuid>` (seat sessions add a `seat_` infix). */
const SESSION_ID = 'session_[A-Za-z0-9][A-Za-z0-9_-]*';
const ROOM_ID = '[A-Za-z0-9][A-Za-z0-9_-]{0,127}';
const SESSION_ID_PATTERN = new RegExp(`^${SESSION_ID}$`);
const ROOM_ID_PATTERN = new RegExp(`^${ROOM_ID}$`);
/** Optional sub-route, query or hash after the id (`/agent/…`, `?turn=…`). */
const TAIL = String.raw`(?:[/?#][^\s]*?)?`;
const LEAD = String.raw`(^|[\s(\[（「“"'])`;
const TRAIL = String.raw`(?=$|[\s)\]）」”"',.;:!?，。；：！？])`;
const ORIGIN = String.raw`(?:(?:https?|tauri):\/\/[^\s/]+)?`;
/** Loopback names/addresses identify this machine, regardless of port. */
const LOOPBACK_HOSTS = new Set([
  'localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1',
  // The Tauri webview origin is still this machine.
  'tauri.localhost',
]);

const linkPattern = (): RegExp => new RegExp(
  `${LEAD}((?:(?<origin>${ORIGIN})\\/(?<route>s|r|rooms)\\/(?<id>${SESSION_ID}|${ROOM_ID})|kiki:\\/\\/(?<protocolRoute>s|session|sessions|r|rooms)\\/(?<protocolId>${SESSION_ID}|${ROOM_ID}))(?<tail>${TAIL}))${TRAIL}`,
  'g',
);

const originHost = (origin: string | undefined): string | undefined => {
  if (origin === undefined) return undefined;
  try {
    return new URL(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(origin) ? origin : `http://${origin}`).host.toLowerCase();
  } catch { return undefined; }
};

const isLocalOrigin = (origin: string, ownHost: string | undefined): boolean => {
  try {
    const url = new URL(origin);
    return LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) || url.host.toLowerCase() === ownHost;
  } catch { return false; }
};

/** Controls which full URLs belong to this app; bare paths are unaffected. */
export interface ConversationRefOptions {
  /** This app's own origin, with or without a scheme, when the caller knows it. */
  readonly origin?: string;
}

/** A linked conversation object of either kind. */
export type ConversationRefKind = 'session' | 'room';

/** One conversation link, with its original bounds and canonical in-app route. */
export interface ConversationRefMatch {
  /** Link bounds in the scanned text (`end` exclusive). */
  readonly start: number;
  readonly end: number;
  /** The link exactly as written. */
  readonly raw: string;
  readonly kind: ConversationRefKind;
  readonly id: string;
  /** `/s/<id>` or `/rooms/<id>`, preserving the sub-route, query and hash. */
  readonly href: string;
}

/** One thread link, retaining the thread-only caller contract. */
export interface ThreadRefMatch {
  /** Link bounds in the scanned text (`end` exclusive). */
  readonly start: number;
  readonly end: number;
  /** The link exactly as written. */
  readonly raw: string;
  readonly sessionId: string;
}

/** Every local thread or room link in `text`, in document order without overlap. */
export function findConversationRefs(text: string, options?: ConversationRefOptions): ConversationRefMatch[] {
  const matches: ConversationRefMatch[] = [];
  const ownHost = originHost(options?.origin);
  for (const match of text.matchAll(linkPattern())) {
    const lead = match[1] ?? '';
    const raw = match[2] ?? '';
    const groups = match.groups ?? {};
    const id = groups['id'] ?? groups['protocolId'];
    const route = groups['route'] ?? groups['protocolRoute'];
    const origin = groups['origin'];
    if (id === undefined || route === undefined || raw === '') continue;
    if (origin && !isLocalOrigin(origin, ownHost)) continue;
    const kind = route === 'r' || route === 'rooms' ? 'room' : 'session';
    const isSessionId = SESSION_ID_PATTERN.test(id);
    if (kind === 'session' ? !isSessionId : isSessionId || !ROOM_ID_PATTERN.test(id)) continue;
    const start = match.index + lead.length;
    matches.push({ start, end: start + raw.length, raw, kind, id, href: conversationRefLink(kind, id) + (groups['tail'] ?? '') });
  }
  return matches;
}

/** Every local thread link in `text`, in order; room links are left out. */
export function findThreadRefs(text: string, options?: ConversationRefOptions): ThreadRefMatch[] {
  return findConversationRefs(text, options)
    .filter((ref) => ref.kind === 'session')
    .map(({ start, end, raw, id }) => ({ start, end, raw, sessionId: id }));
}

/** The in-app route the sidebar's "Copy link" and "Add to conversation" write. */
export function threadRefLink(sessionId: string): string {
  return `/s/${sessionId}`;
}

/**
 * GUI routes that look like a slash command but are links: `/s/<anything>`
 * and the other in-app pages with a sub-path. Command names never contain a
 * second `/`, so a token like this can never name a command.
 */
export function isAppRouteLink(token: string): boolean {
  return /^\/(?:s|r|rooms|settings|board|cron|memory|usage|activity|capabilities)\/\S/.test(token);
}

/** A short, stable stand-in label for a thread with no title. */
export function shortThreadId(sessionId: string): string {
  const bare = sessionId.replace(/^session_/, '');
  return bare.length <= 8 ? bare : bare.slice(0, 8);
}

// ---- prompt context block ----

export type ThreadRefStatus = 'running' | 'awaiting_approval' | 'awaiting_answer' | 'idle' | 'archived' | 'unknown';

/** What the GUI knows about one referenced thread at send time. */
export interface ThreadRefInfo {
  readonly sessionId: string;
  readonly hostId?: string;
  readonly title?: string;
  readonly workspaceId?: string;
  readonly workspaceName?: string;
  readonly cwd?: string;
  readonly status: ThreadRefStatus;
  /** Last activity on the thread (the record's `updated_at`), ISO 8601. */
  readonly updatedAt?: string;
}

/** What the GUI knows about one referenced room at send time. */
export interface RoomRefInfo {
  readonly id: string;
  readonly name?: string;
  readonly workspaceId?: string;
  readonly memberCount?: number;
}

/** Presentation status of a thread record (pending interaction beats busy). */
export function threadRefStatusOf(session: Session | undefined): ThreadRefStatus {
  if (session === undefined) return 'unknown';
  if (session.archived === true) return 'archived';
  if (session.pending_interaction === 'approval') return 'awaiting_approval';
  if (session.pending_interaction === 'question') return 'awaiting_answer';
  return session.busy ? 'running' : 'idle';
}

/** Everything the GUI can say about a linked thread; only the id when it is not loaded. */
export function threadRefInfoOf(
  sessionId: string,
  session: Session | undefined,
  workspace: Workspace | undefined,
  hostId?: string,
): ThreadRefInfo {
  if (session === undefined) return { sessionId, hostId, status: 'unknown' };
  return {
    sessionId,
    hostId,
    title: session.title.trim() === '' ? undefined : session.title.trim(),
    workspaceId: session.workspace_id,
    workspaceName: workspace?.name,
    cwd: session.worktree?.source_root ?? session.metadata.cwd,
    status: threadRefStatusOf(session),
    updatedAt: session.updated_at,
  };
}

const BLOCK_OPEN = '<thread_refs>';
const BLOCK_CLOSE = '</thread_refs>';
const BLOCK_PATTERN = /\n*<thread_refs>\n[\s\S]*?\n<\/thread_refs>\s*$/;

function attr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll(/[\r\n]+/g, ' ');
}

/** One `<thread_ref …/>` line; unknown fields are left out rather than guessed. */
export function threadRefTag(info: ThreadRefInfo): string {
  const fields: [string, string | undefined][] = [
    ['id', info.sessionId],
    ['host_id', info.hostId],
    ['title', info.title?.trim() === '' ? undefined : info.title?.trim()],
    ['workspace', info.workspaceName],
    ['workspace_id', info.workspaceId],
    ['cwd', info.cwd],
    ['status', info.status],
    ['updated_at', info.updatedAt],
  ];
  const attrs = fields
    .filter((field): field is [string, string] => field[1] !== undefined && field[1] !== '')
    .map(([key, value]) => `${key}="${attr(value)}"`);
  return `<thread_ref ${attrs.join(' ')}/>`;
}

/** One `<room_ref …/>` line; unknown fields are left out rather than guessed. */
export function roomRefTag(info: RoomRefInfo): string {
  const fields: [string, string | undefined][] = [
    ['id', info.id],
    ['name', info.name?.trim() === '' ? undefined : info.name?.trim()],
    ['workspace_id', info.workspaceId],
    ['member_count', info.memberCount?.toString()],
  ];
  const attrs = fields
    .filter((field): field is [string, string] => field[1] !== undefined && field[1] !== '')
    .map(([key, value]) => `${key}="${attr(value)}"`);
  return `<room_ref ${attrs.join(' ')}/>`;
}

/** The note that tells the model how to use referenced threads and rooms. */
export const THREAD_REF_HINT =
  'The user linked the Kiki threads above. Read one with ThreadRead using its host_id, workspace_id and id as session_id (omit host_id for this host if absent), or search it with HistorySearch (scope=session, session_id=<id>).' +
  ' A <room_ref> is a Kiki room the user linked; its page and log live at that room id, and speaking there uses ThreadSend({room: "<id>", content, mentions?}).';

/**
 * Append the context block for every distinct linked thread and resolved room.
 * Text without context lines comes back unchanged; an existing block is replaced
 * so a re-sent (edited, retried) prompt never carries two.
 * Use the same `options` as `findConversationRefs` so context and editing share
 * one view of which full URLs are local.
 */
export function appendThreadRefContext(
  text: string,
  resolve: (sessionId: string) => ThreadRefInfo,
  resolveRoom?: (roomId: string) => RoomRefInfo,
  options?: ConversationRefOptions,
): string {
  const body = stripThreadRefContext(text);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const ref of findConversationRefs(body, options)) {
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (ref.kind === 'session') lines.push(threadRefTag(resolve(ref.id)));
    else if (resolveRoom !== undefined) lines.push(roomRefTag(resolveRoom(ref.id)));
  }
  if (lines.length === 0) return body;
  return `${body}\n\n${BLOCK_OPEN}\n${lines.join('\n')}\n${THREAD_REF_HINT}\n${BLOCK_CLOSE}`;
}

/** Inverse of `appendThreadRefContext`: the prompt as the user wrote it. */
export function stripThreadRefContext(text: string): string {
  return text.replace(BLOCK_PATTERN, '');
}

// ---- composer editing ----

/**
 * Deletion that touches a thread or room link removes the whole link: Backspace
 * just after (or inside) one, Delete just before (or inside) one, or a selection
 * that overlaps one. Returns the widened range, or null when no link is hit.
 * Use the same `options` as `findConversationRefs` so editing and context share
 * one view of which full URLs are local.
 */
export function threadRefDeletionRange(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  key: 'Backspace' | 'Delete',
  options?: ConversationRefOptions,
): { start: number; end: number } | null {
  const refs = findConversationRefs(text, options);
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
export function removeThreadRef(text: string, ref: Pick<ThreadRefMatch, 'start' | 'end'>): { text: string; cursor: number } {
  const before = text.slice(0, ref.start);
  let after = text.slice(ref.end);
  if (/[ \t]$/.test(before) || before === '') after = after.replace(/^[ \t]/, '');
  return { text: before + after, cursor: before.length };
}

/** Insert a link at the caret, padding it with spaces where the draft needs them. */
export function insertThreadRef(
  text: string,
  selection: { readonly start: number; readonly end: number },
  link: string,
): { text: string; cursor: number } {
  const start = Math.max(0, Math.min(Math.min(selection.start, selection.end), text.length));
  const end = Math.max(0, Math.min(Math.max(selection.start, selection.end), text.length));
  const before = text.slice(0, start);
  const after = text.slice(end);
  const prefix = before !== '' && !/\s$/.test(before) ? ' ' : '';
  const suffix = after === '' || !/^\s/.test(after) ? ' ' : '';
  const inserted = `${prefix}${link}${suffix}`;
  return { text: before + inserted + after, cursor: before.length + inserted.length };
}

// ---- composer insert channel ----

type InsertListener = (text: string) => boolean;
const insertListeners = new Map<string, Set<InsertListener>>();

/**
 * Hand a snippet to the mounted main composer of `sessionId`, inserted at its
 * caret. Returns false when no composer for that session is listening, so the
 * caller can fall back to appending to the stored draft.
 */
export function requestComposerInsert(sessionId: string, text: string): boolean {
  const listeners = insertListeners.get(sessionId);
  if (listeners === undefined) return false;
  for (const listener of listeners) {
    if (listener(text)) return true;
  }
  return false;
}

/** Register a composer as the insert target for `sessionId`; returns the unsubscribe. */
export function subscribeComposerInserts(sessionId: string, listener: InsertListener): () => void {
  const listeners = insertListeners.get(sessionId) ?? new Set<InsertListener>();
  listeners.add(listener);
  insertListeners.set(sessionId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) insertListeners.delete(sessionId);
  };
}
