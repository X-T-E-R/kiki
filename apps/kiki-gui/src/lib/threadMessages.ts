/**
 * Cross-thread message log (`GET /threads/messages`): the reads and the pure
 * shaping the session rail and the Activity page share.
 *
 * Contract points this module owns so no surface re-derives them:
 *   - a page can be empty and still carry `next_cursor` (the server stopped at
 *     its scan budget), so a read keeps following the cursor until it has
 *     rows or the cursor runs out; an empty page is never the end;
 *   - a continuation repeats the exact same filters;
 *   - the protocol guarantees `message_id` equals the recipient main-agent
 *     prompt and user-message id, including steered delivery and retries;
 *     navigation uses `?block=user-<message_id>`; `target_seq` is a mailbox
 *     sequence number and is never used as a turn;
 *   - a deleted endpoint is never a link;
 *   - `source.kind === 'room'` is reserved and skipped until rooms land.
 */

import type { ListThreadMessagesQuery, ListThreadMessagesResponse } from '@kiki/protocol';

export type ThreadMessage = ListThreadMessagesResponse['items'][number];
export type ThreadEndpoint = ThreadMessage['target'];
/** A message whose source is a thread (the only kind the server emits today). */
export type ThreadToThreadMessage = ThreadMessage & { readonly source: { readonly kind: 'thread'; readonly thread: ThreadEndpoint } };

export interface ThreadMessagesPage {
  readonly items: readonly ThreadToThreadMessage[];
  readonly nextCursor?: string;
  /** The last hop stopped at the server's scan budget. */
  readonly incomplete: boolean;
}

/** Filters without the cursor; a continuation must repeat them unchanged. */
export type ThreadMessagesFilter = Omit<ListThreadMessagesQuery, 'cursor'>;

/** Empty pages followed before handing a cursor back to the reader. */
const MAX_EMPTY_HOPS = 8;

export function isThreadSourced(message: ThreadMessage): message is ThreadToThreadMessage {
  return message.source.kind === 'thread';
}

/**
 * One reader-visible page: follows empty pages (at most `MAX_EMPTY_HOPS`)
 * so a scan-budget stop does not read as "no more messages".
 */
export async function readThreadMessagesPage(
  list: (query: ListThreadMessagesQuery) => Promise<ListThreadMessagesResponse>,
  filter: ThreadMessagesFilter,
  cursor?: string,
): Promise<ThreadMessagesPage> {
  let next = cursor;
  let incomplete = false;
  for (let hop = 0; ; hop += 1) {
    const page = await list({ ...filter, cursor: next });
    const items = page.items.filter(isThreadSourced);
    next = page.next_cursor;
    incomplete = page.incomplete === 'scan_budget';
    if (items.length > 0 || next === undefined || hop + 1 >= MAX_EMPTY_HOPS) {
      return { items, nextCursor: next, incomplete };
    }
  }
}

/** Stable identity of a thread endpoint (host + workspace + session). */
export function endpointKey(endpoint: ThreadEndpoint): string {
  const { host_id, workspace_id, session_id } = endpoint.ref;
  return `${host_id}\u0000${workspace_id}\u0000${session_id}`;
}

export type MessageDirection = 'out' | 'in';

/** Which side `selfSessionId` is on, and the other endpoint. */
export function peerOf(message: ThreadToThreadMessage, selfSessionId: string): { readonly direction: MessageDirection; readonly peer: ThreadEndpoint } {
  return message.source.thread.ref.session_id === selfSessionId
    ? { direction: 'out', peer: message.target }
    : { direction: 'in', peer: message.source.thread };
}

export interface PeerGroup {
  readonly peer: ThreadEndpoint;
  /** Newest first, as the server orders them. */
  readonly messages: readonly ThreadToThreadMessage[];
  readonly latest: ThreadToThreadMessage;
  readonly latestDirection: MessageDirection;
  readonly sent: number;
  readonly received: number;
  readonly undeliverable: number;
}

/** Group one session's messages by the thread on the other side, most recent peer first. */
export function groupByPeer(messages: readonly ThreadToThreadMessage[], selfSessionId: string): PeerGroup[] {
  const groups = new Map<string, { peer: ThreadEndpoint; messages: ThreadToThreadMessage[] }>();
  for (const message of messages) {
    const { peer } = peerOf(message, selfSessionId);
    const key = endpointKey(peer);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { peer, messages: [message] });
    else group.messages.push(message);
  }
  return [...groups.values()]
    .map(({ peer, messages: list }) => {
      const sorted = list.toSorted(newestFirst);
      const latest = sorted[0]!;
      const sent = sorted.filter((message) => peerOf(message, selfSessionId).direction === 'out').length;
      return {
        peer,
        messages: sorted,
        latest,
        latestDirection: peerOf(latest, selfSessionId).direction,
        sent,
        received: sorted.length - sent,
        undeliverable: sorted.filter((message) => message.delivery === 'undeliverable').length,
      };
    })
    .sort((a, b) => newestFirst(a.latest, b.latest));
}

/** Server order: newest `accepted_at` first, ties by message id. */
export function newestFirst(a: ThreadMessage, b: ThreadMessage): number {
  return b.accepted_at - a.accepted_at || (a.message_id < b.message_id ? 1 : a.message_id > b.message_id ? -1 : 0);
}

/**
 * Where "show in conversation" lands: the recipient's prompt, located by
 * message id. Only a delivered message has a prompt to land on, and a
 * deleted recipient has nowhere to open.
 */
export function messageJumpHref(message: ThreadMessage): string | undefined {
  if (message.delivery !== 'delivered' || message.target.deleted) return undefined;
  const session = encodeURIComponent(message.target.ref.session_id);
  return `/s/${session}?block=${encodeURIComponent(`user-${message.message_id}`)}`;
}

/** The thread itself, unless it was deleted. */
export function endpointHref(endpoint: ThreadEndpoint): string | undefined {
  return endpoint.deleted ? undefined : `/s/${encodeURIComponent(endpoint.ref.session_id)}`;
}

/** The first non-empty line of a message, for one-line summaries. */
export function messageSummary(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return '';
}

/** `accepted_at` (Unix ms) as the ISO string the shared time helpers read. */
export function acceptedIso(message: ThreadMessage): string {
  return new Date(message.accepted_at).toISOString();
}
