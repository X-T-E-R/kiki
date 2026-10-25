import { createHash } from 'node:crypto';
import type { ImHistoryEntry, ImHistoryQuery, ImLocalHistoryPage } from '@kiki/agent-core-v2/app/bot/imMessageHistory';

export interface ImHistoryDocuments {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface ImPreparedHistoryPrompt {
  readonly sessionId: string;
  readonly images: readonly import('@kiki/protocol').MessageContent[];
  readonly context: import('@kiki/protocol').ImMessageMetadata['context'];
  readonly snapshot: number;
}

interface JournalEntry extends ImHistoryEntry {
  readonly admission?: string;
  readonly originalKey?: string;
}

interface OriginalMessage {
  readonly entry: ImHistoryEntry;
  readonly eventIds: readonly string[];
}

interface Head {
  sequence: number;
  revision: number;
  page: number;
  archives: number[];
  rows: JournalEntry[];
  locations: Record<string, number>;
  changes?: Record<string, number>;
  seen: string[];
  watermarks: Record<string, number>;
  sentIds?: string[];
  truncated: boolean;
}

interface Cursor {
  room: string;
  query: string;
  snapshot: number;
  revision: number;
  page: number;
  offset: number;
}

const PAGE_ROWS = 64;
const PAGE_CHARS = 128 * 1024;
const ARCHIVES = 10;
const SCAN_ROWS = 256;
const RESULT_CHARS = 60 * 1024;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function rowKey(row: ImHistoryEntry): string {
  return digest(row.metadata.source_message_id ?? `event:${row.eventId}`);
}

function empty(): Head {
  return { sequence: 0, revision: 0, page: 0, archives: [], rows: [], locations: {}, seen: [], watermarks: {}, truncated: false };
}

function chars(row: ImHistoryEntry): number {
  return JSON.stringify(row).length;
}

function filterKey(query: ImHistoryQuery): string {
  return JSON.stringify([query.keyword ?? null, query.senderId ?? null, query.before ?? null]);
}

export class ImHistoryJournal {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly documents: ImHistoryDocuments) {}

  static room(providerKind: string, accountId: string, chatId: string, topicId: string): string {
    return digest(JSON.stringify([providerKind, accountId, chatId, topicId]));
  }

  private key(room: string, page?: number): string {
    return `im-history-v1/${room}/${page === undefined ? 'head' : `page-${page}`}`;
  }

  private lock<T>(room: string, operation: () => Promise<T>): Promise<T> {
    const work = (this.queues.get(room) ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.queues.set(room, work);
    void work.finally(() => { if (this.queues.get(room) === work) this.queues.delete(room); }).catch(() => undefined);
    return work;
  }

  private async head(room: string): Promise<Head> {
    return await this.documents.get<Head>(this.key(room)) ?? empty();
  }

  private async original(row: JournalEntry): Promise<OriginalMessage> {
    if (row.originalKey !== undefined) {
      const original = await this.documents.get<OriginalMessage>(row.originalKey);
      if (original === undefined) throw new Error('history_original_missing');
      return original;
    }
    const { admission: _, originalKey: __, ...entry } = row;
    return { entry, eventIds: [row.eventId] };
  }

  private preview(entry: ImHistoryEntry): ImHistoryEntry {
    const text = entry.text.slice(0, 16_384);
    return { ...entry, text, content: entry.content?.slice(0, 4), media: entry.media?.slice(0, 4),
      metadata: { ...entry.metadata, mention_ids: entry.metadata.mention_ids?.slice(0, 64) },
      original: entry.metadata.source_message_id === undefined ? undefined : { message_id: entry.metadata.source_message_id, text_length: entry.text.length },
      text_range: { offset: 0, length: text.length, total: entry.text.length, next_offset: text.length < entry.text.length ? text.length : undefined },
      truncated: entry.truncated || text.length < entry.text.length || (entry.content?.length ?? 0) > 4 || (entry.media?.length ?? 0) > 4 || (entry.metadata.mention_ids?.length ?? 0) > 64 ? true : undefined };
  }

  private bounded(entry: ImHistoryEntry): ImHistoryEntry {
    let result = entry;
    while (chars(result) > RESULT_CHARS && result.text.length > 0) {
      const text = result.text.slice(0, Math.floor(result.text.length / 2));
      const offset = result.text_range?.offset ?? 0;
      const total = result.text_range?.total ?? result.original?.text_length ?? entry.text.length;
      result = { ...result, text, truncated: true, text_range: { offset, length: text.length, total, next_offset: offset + text.length < total ? offset + text.length : undefined } };
    }
    if (chars(result) > RESULT_CHARS) throw new Error('history_metadata_exceeds_result_budget');
    return result;
  }

  private async page(room: string, head: Head, id: number): Promise<JournalEntry[]> {
    if (id === head.page) return head.rows;
    if (!head.archives.includes(id)) throw new Error('history_cursor_expired: retained history changed; start a new read');
    const rows = await this.documents.get<JournalEntry[]>(this.key(room, id));
    if (rows === undefined) throw new Error('history_page_missing');
    return rows;
  }

  record(room: string, input: Omit<ImHistoryEntry, 'sequence'>): Promise<JournalEntry> {
    return this.lock(room, async () => {
      const head = await this.head(room);
      const eventKey = digest(input.eventId);
      const key = rowKey({ ...input, sequence: 0 });
      const location = head.locations[key];
      const targetRows = location === undefined ? undefined : await this.page(room, head, location);
      const existing = targetRows?.find((row) => rowKey(row) === key);
      const previous = existing === undefined ? undefined : await this.original(existing);
      if (existing !== undefined && previous !== undefined && (head.seen.includes(eventKey) || previous.eventIds.includes(input.eventId) || input.operation === 'create' && previous.entry.operation === 'retract')) return { ...existing, ...previous.entry };
      const retiredDocuments: string[] = [];
      const append = input.operation === 'create' && previous !== undefined;
      const originalText = input.operation === 'retract' ? '' : append ? [previous.entry.text, input.text].filter((text) => text.length > 0).join('\n') : input.text;
      const incoming = input.content?.filter((part) => part.type === 'file' || (part.type === 'image' || part.type === 'audio' || part.type === 'video') && part.source.kind === 'session_media');
      const originalContent = input.operation === 'retract' ? undefined : append ? [...previous.entry.content ?? [], ...incoming ?? []] : incoming ?? previous?.entry.content;
      const originalMedia = input.operation === 'retract' ? undefined : append ? [...previous.entry.media ?? [], ...input.media ?? []] : input.media ?? previous?.entry.media;
      const prior = append ? previous.entry.metadata : undefined;
      const metadata = { ...input.metadata, context: undefined,
        mentioned: input.metadata.mentioned ?? prior?.mentioned, mention_ids: input.metadata.mention_ids ?? prior?.mention_ids,
        reply_to_message_id: input.metadata.reply_to_message_id ?? prior?.reply_to_message_id,
        is_self: input.metadata.is_self ?? prior?.is_self, timestamp: input.metadata.timestamp ?? prior?.timestamp,
        identity: { ...input.metadata.identity, sender_name: input.metadata.identity.sender_name ?? prior?.identity.sender_name,
          chat_title: input.metadata.identity.chat_title ?? prior?.identity.chat_title, topic_title: input.metadata.identity.topic_title ?? prior?.identity.topic_title } };
      const full: ImHistoryEntry = { ...input, sessionId: previous?.entry.sessionId ?? input.sessionId, metadata, timestamp: input.timestamp ?? (append ? previous.entry.timestamp : undefined), text: originalText, content: originalContent, media: originalMedia, isSelf: input.isSelf ?? previous?.entry.isSelf, sequence: existing?.sequence ?? head.sequence + 1 };
      const originalKey = `im-history-v1/${room}/original-${key}-${eventKey}`;
      await this.documents.set<OriginalMessage>(originalKey, { entry: full, eventIds: [...previous?.eventIds ?? [], input.eventId] });
      if (existing?.originalKey !== undefined && existing.originalKey !== originalKey) retiredDocuments.push(existing.originalKey);
      const row: JournalEntry = { ...this.preview(full), admission: existing?.admission, originalKey };
      head.sequence += 1;
      if (existing !== undefined && targetRows !== undefined) {
        head.revision += 1;
        (head.changes ??= {})[key] = head.sequence;
        targetRows[targetRows.indexOf(existing)] = row;
        while (targetRows.reduce((sum, item) => sum + chars(item), 0) > PAGE_CHARS && targetRows.length > 1) {
          const victim = targetRows.find((item) => item !== row)!;
          targetRows.splice(targetRows.indexOf(victim), 1);
          delete head.locations[rowKey(victim)];
          if (head.changes !== undefined) delete head.changes[rowKey(victim)];
          if (victim.admission !== undefined) retiredDocuments.push(victim.admission);
          if (victim.originalKey !== undefined) retiredDocuments.push(victim.originalKey);
          head.truncated = true;
        }
        if (location !== head.page) {
          await this.documents.set(this.key(room), head);
          await this.documents.set(this.key(room, location), targetRows);
        }
      } else {
        if (head.rows.length >= PAGE_ROWS || head.rows.reduce((sum, item) => sum + chars(item), 0) + chars(row) > PAGE_CHARS) {
          await this.documents.set(this.key(room, head.page), head.rows);
          head.archives.push(head.page);
          head.page += 1;
          head.rows = [];
        }
        head.rows.push(row);
        head.locations[key] = head.page;
      }
      head.seen = [...head.seen, eventKey].slice(-2048);
      const retired = head.archives.splice(0, Math.max(0, head.archives.length - ARCHIVES));
      if (retired.length > 0) {
        head.truncated = true;
        for (const [key, page] of Object.entries(head.locations)) if (retired.includes(page)) {
          delete head.locations[key];
          if (head.changes !== undefined) delete head.changes[key];
        }
      }
      await this.documents.set(this.key(room), head);
      for (const key of retiredDocuments) await this.documents.delete(key);
      for (const page of retired) {
        for (const entry of await this.documents.get<JournalEntry[]>(this.key(room, page)) ?? []) {
          if (entry.admission !== undefined) await this.documents.delete(entry.admission);
          if (entry.originalKey !== undefined) await this.documents.delete(entry.originalKey);
        }
        await this.documents.delete(this.key(room, page));
      }
      return row;
    });
  }

  rememberSent(room: string, ids: readonly string[]): Promise<void> {
    return this.lock(room, async () => {
      const head = await this.head(room);
      head.sentIds = [...new Set([...(head.sentIds ?? []), ...ids.filter((id) => id.length > 0).map(digest)])].slice(-512);
      await this.documents.set(this.key(room), head);
    });
  }

  async isSent(room: string, id: string): Promise<boolean> {
    return (await this.head(room)).sentIds?.includes(digest(id)) === true;
  }

  consume(room: string, owner: string, sequence: number): Promise<void> {
    return this.lock(room, async () => {
      const head = await this.head(room);
      const watermark = Math.max(head.watermarks[owner] ?? 0, Math.min(sequence, head.sequence));
      delete head.watermarks[owner];
      head.watermarks[owner] = watermark;
      for (const retired of Object.keys(head.watermarks).slice(0, -64)) delete head.watermarks[retired];
      await this.documents.set(this.key(room), head);
    });
  }

  async find(room: string, sourceMessageId: string): Promise<ImHistoryEntry | undefined> {
    const row = await this.findPreview(room, sourceMessageId);
    return row === undefined ? undefined : (await this.original(row)).entry;
  }

  private async findPreview(room: string, sourceMessageId: string): Promise<JournalEntry | undefined> {
    const head = await this.head(room);
    const key = digest(sourceMessageId);
    const page = head.locations[key];
    if (page === undefined) return undefined;
    return (await this.page(room, head, page)).find((row) => row.metadata.source_message_id === sourceMessageId);
  }

  prepare(room: string, entry: ImHistoryEntry, prompt: ImPreparedHistoryPrompt): Promise<ImPreparedHistoryPrompt> {
    return this.lock(room, async () => {
      const key = `im-history-v1/${room}/admission-${digest(entry.eventId)}`;
      const existing = await this.documents.get<ImPreparedHistoryPrompt>(key);
      const prepared = existing ?? prompt;
      if (prepared.sessionId !== prompt.sessionId) throw new Error('history_admission_owner_changed');
      const head = await this.head(room);
      const page = head.locations[rowKey(entry)];
      if (page === undefined) throw new Error('history_admission_expired');
      const rows = await this.page(room, head, page);
      const row = rows.find((row) => rowKey(row) === rowKey(entry));
      if (row === undefined || row.eventId !== entry.eventId) throw new Error('history_message_changed_before_admission');
      if (existing === undefined) await this.documents.set(key, prepared);
      const previous = row.admission;
      rows[rows.indexOf(row)] = { ...row, admission: key };
      if (page === head.page) await this.documents.set(this.key(room), head);
      else await this.documents.set(this.key(room, page), rows);
      if (previous !== undefined && previous !== key) await this.documents.delete(previous);
      return prepared;
    });
  }

  read(room: string, query: ImHistoryQuery, senderId?: string): Promise<ImLocalHistoryPage> {
    return this.lock(room, async () => {
      let page: Awaited<ReturnType<ImHistoryJournal['readPage']>>;
      if (query.messageId !== undefined) {
        query.signal?.throwIfAborted();
        const row = await this.findPreview(room, query.messageId);
        const visible = row !== undefined && (senderId === undefined || row.metadata.identity.sender_id === senderId) && (query.senderId === undefined || row.metadata.identity.sender_id === query.senderId);
        let messages: ImHistoryEntry[] = [];
        if (visible) {
          const full = (await this.original(row)).entry;
          const offset = query.textOffset ?? 0;
          if (!Number.isSafeInteger(offset) || offset < 0 || offset > full.text.length) throw new Error('history_text_offset_out_of_range');
          const text = full.text.slice(offset, offset + Math.min(16_384, query.textLimit ?? 8192));
          messages = [{ ...this.preview(full), text, text_range: { offset, length: text.length, total: full.text.length, next_offset: offset + text.length < full.text.length ? offset + text.length : undefined }, truncated: offset > 0 || text.length < full.text.length || full.truncated ? true : undefined }];
        }
        page = { status: 'ok', source: 'local', messages, coverage: (await this.head(room)).truncated ? 'retention_limited' : 'received_only', end: 'reached' };
      } else page = await this.readPage(room, query, senderId);
      return { ...page, messages: page.messages.map((row) => { const { content: _, sessionId: __, ...visible } = this.bounded(row); return visible; }) };
    });
  }

  private async readPage(room: string, query: ImHistoryQuery, senderId?: string): Promise<Omit<ImLocalHistoryPage, 'messages'> & { readonly messages: readonly ImHistoryEntry[] }> {
    query.signal?.throwIfAborted();
    const head = await this.head(room);
    let cursor: Cursor = { room, query: filterKey({ ...query, senderId: senderId ?? query.senderId }), snapshot: head.sequence, revision: head.revision, page: head.page, offset: head.rows.length - 1 };
    if (query.cursor !== undefined) {
      try {
        const raw = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as Cursor;
        if (raw.room !== room || raw.query !== cursor.query || !Number.isInteger(raw.snapshot) || !Number.isInteger(raw.page) || !Number.isInteger(raw.offset) || raw.offset < -1 || raw.offset >= PAGE_ROWS || raw.page < 0 || raw.page > head.page || raw.snapshot > head.sequence) throw new Error('invalid');
        if (raw.revision !== head.revision) throw new Error('history_changed');
        cursor = raw;
      } catch (error) { throw new Error(error instanceof Error && error.message === 'history_changed' ? 'history_changed: messages were edited or retracted; start a new read' : 'invalid_history_cursor'); }
    }
    const rows: ImHistoryEntry[] = [];
    const limit = Math.min(50, Math.max(1, query.limit ?? 20));
    let scanned = 0;
    let size = 0;
    let originalChars = 0;
    let end = false;
    while (rows.length < limit && scanned < SCAN_ROWS && size < RESULT_CHARS && originalChars < 4 * 1024 * 1024) {
      query.signal?.throwIfAborted();
      const page = await this.page(room, head, cursor.page);
      while (cursor.offset >= 0 && rows.length < limit && scanned < SCAN_ROWS && size < RESULT_CHARS && originalChars < 4 * 1024 * 1024) {
        const row = page[cursor.offset--];
        if (row === undefined) throw new Error('history_cursor_expired');
        scanned += 1;
        if (row.sequence > cursor.snapshot || (senderId !== undefined && row.metadata.identity.sender_id !== senderId) || (query.senderId !== undefined && row.metadata.identity.sender_id !== query.senderId) || (query.before !== undefined && (row.timestamp ?? row.receivedAt) >= query.before)) continue;
        if (query.keyword !== undefined) {
          const full = (await this.original(row)).entry;
          originalChars += full.text.length;
          if (!full.text.toLocaleLowerCase().includes(query.keyword.toLocaleLowerCase())) continue;
        }
        const { admission: _, originalKey: __, ...visible } = row;
        const result = this.bounded(visible);
        const next = chars(result);
        if (rows.length > 0 && size + next > RESULT_CHARS) { cursor.offset += 1; size = RESULT_CHARS; break; }
        rows.push(result);
        size += next;
      }
      if (cursor.offset < 0) {
        const previous = head.archives.filter((id) => id < cursor.page).at(-1);
        if (previous === undefined) { end = true; break; }
        cursor.page = previous;
        cursor.offset = (await this.page(room, head, previous)).length - 1;
      }
    }
    return { status: 'ok', source: 'local', messages: rows, coverage: head.truncated ? 'retention_limited' : 'received_only', end: end ? 'reached' : 'more', nextCursor: end ? undefined : Buffer.from(JSON.stringify(cursor)).toString('base64url') };
  }

  background(room: string, owner: string, current: ImHistoryEntry, senderId?: string): Promise<{ readonly entries: readonly ImHistoryEntry[]; readonly snapshot: number; readonly truncated: boolean; readonly coverage: ImLocalHistoryPage['coverage'] }> {
    return this.lock(room, () => this.selectBackground(room, owner, current, senderId));
  }

  private async selectBackground(room: string, owner: string, current: ImHistoryEntry, senderId?: string) {
    const head = await this.head(room);
    const snapshot = head.sequence;
    const page = await this.readPage(room, { limit: 50 }, senderId);
    const watermark = head.watermarks[owner] ?? 0;
    const selected = new Map<number, ImHistoryEntry>();
    const changedAt = (row: ImHistoryEntry) => head.changes?.[rowKey(row)] ?? row.sequence;
    for (const row of page.messages) if (row.isSelf !== true && changedAt(row) > watermark && changedAt(row) <= snapshot && row.sequence !== current.sequence) selected.set(row.sequence, row);
    const changes = Object.entries(head.changes ?? {}).filter(([, sequence]) => sequence > watermark && sequence <= snapshot).sort((a, b) => b[1] - a[1]);
    const pages = new Map<number, JournalEntry[]>();
    for (const [key] of changes.slice(0, SCAN_ROWS)) {
      const location = head.locations[key];
      if (location === undefined) continue;
      let rows = pages.get(location);
      if (rows === undefined) { rows = await this.page(room, head, location); pages.set(location, rows); }
      const row = rows.find((row) => rowKey(row) === key);
      if (row !== undefined && row.isSelf !== true && row.sequence !== current.sequence && (senderId === undefined || row.metadata.identity.sender_id === senderId)) selected.set(row.sequence, row);
    }
    const visited = new Set<string>();
    let reply = current.metadata.reply_to_message_id;
    for (let depth = 0; reply !== undefined && depth < 4 && !visited.has(reply); depth++) {
      visited.add(reply);
      const row = await this.findPreview(room, reply);
      if (row === undefined || (senderId !== undefined && row.metadata.identity.sender_id !== senderId)) break;
      if (row.sequence <= snapshot && row.sequence !== current.sequence) selected.set(row.sequence, row);
      reply = row.metadata.reply_to_message_id;
    }
    const entries: ImHistoryEntry[] = [];
    let size = 0;
    let truncated = page.end === 'more' && (page.messages.at(-1)?.sequence ?? 0) > watermark || changes.length > SCAN_ROWS || head.truncated;
    for (const row of [...selected.values()].sort((a, b) => Number(visited.has(b.metadata.source_message_id ?? '')) - Number(visited.has(a.metadata.source_message_id ?? '')) || changedAt(b) - changedAt(a))) {
      const next = chars(row);
      if (size + next > 24 * 1024 || entries.length >= 50) { truncated = true; continue; }
      size += next;
      entries.push(row);
    }
    return { entries: entries.sort((a, b) => a.sequence - b.sequence), snapshot, coverage: page.coverage, truncated: truncated || entries.some((row) => row.truncated === true) };
  }
}
