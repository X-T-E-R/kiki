import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { abortable } from '@kiki/agent-core-v2/_base/utils/abort';
import type { SessionSummary } from '@kiki/agent-core-v2';
import { normalizeLiteral, tokenize } from '@kiki/lexical';
import { projectTranscriptUserOrigin, type TranscriptFrame, type TranscriptItem, type TranscriptStore } from '@kiki/transcript';
import type { HistoryLocatorStore } from '../services/history/historyLocatorStore';
import type { HistorySortedCursor } from '../services/history/historySortedSearch';
import { GlobalSearchError, type GlobalSearchHit, type GlobalSearchPage } from './contract';
import { MAX_DOC_TEXT_CHARS, type MessageDoc, type TitleDoc } from './docs';
import { compareRows, tokenFingerprint, type MatchedRow, type NormalizedQuery } from './match';
import { makeSnippet } from './snippet';

type LiveDoc = { key: string; value: MessageDoc | TitleDoc };
type Navigation = Pick<HistoryLocatorStore, 'scan'>;
interface TextMark {
  readonly id: string;
  readonly length: number;
  readonly digest: number;
  readonly pending: boolean;
}
interface ResidentAgent {
  snapshot?: readonly TranscriptItem[];
  readonly keys: readonly string[];
  readonly marks: Map<string, readonly TextMark[]>;
  readonly completeTurns: Set<number>;
}
interface LiveSearchState {
  readonly id: string;
  readonly fingerprint: string;
  readonly store: WeakRef<TranscriptStore>;
  readonly agents: Map<string, ResidentAgent>;
  readonly verified: WeakSet<TranscriptItem>;
  readonly historical: Map<string, HistorySortedCursor | undefined>;
  readonly gaps: Set<string>;
  readonly rows: MatchedRow[];
  touchedAt: number;
  sequence: number;
  active?: boolean;
  summary?: SessionSummary;
  iterator?: Generator<LiveDoc | undefined>;
  residentDone: boolean;
  emitted: number;
  documents: number;
  bytes: number;
  records: number;
  last?: { sequence: number; page: GlobalSearchPage };
}
interface LiveSearchInput {
  readonly query: NormalizedQuery;
  readonly sessionId: string;
  readonly store: TranscriptStore;
  readonly pageToken?: string;
  readonly signal?: AbortSignal;
  readonly deadlineAt: number;
  readonly textBudget: number;
  readonly maxHits: number;
  readonly ready: () => Promise<void>;
  readonly summary: () => Promise<SessionSummary | undefined>;
  readonly navigation?: Navigation;
}

class LiveDeadline extends Error {}

export class LiveSearch {
  private readonly states = new Map<string, LiveSearchState>();
  private readonly expirations = new Map<string, ReturnType<typeof setTimeout>>();

  private evict(id: string): void {
    const state = this.states.get(id);
    if (state !== undefined && !state.active) {
      state.iterator = undefined;
      state.agents.clear();
      state.rows.length = 0;
    }
    this.states.delete(id);
    clearTimeout(this.expirations.get(id));
    this.expirations.delete(id);
  }

  clear(): void { for (const id of this.states.keys()) this.evict(id); }

  /**
   * A continuation searches the transcript as captured on its first page. Appends, text streaming onto
   * captured text, and older history loaded in front keep that capture valid; a store that drops,
   * reorders or rewrites captured searchable text under the same ids (undo, edit-resend, a replaced
   * generation) ends it. The captured array is held only until the resident scan finishes; afterwards
   * per-text digests carry the check, so the search never pins history the store has released.
   */
  private assertWatermark(state: LiveSearchState, store: TranscriptStore, includeToolOutput: boolean): void {
    for (const [agent, captured] of state.agents) {
      const current = store.getAgent(agent)?.getItems();
      const start = current === undefined ? -1 : startOfKeys(current, captured.keys);
      let intact = start >= 0;
      for (let index = 0; intact && index < captured.keys.length; index += 1) {
        const item = current![start + index]!;
        if (state.verified.has(item)) continue;
        const marks = captured.marks.get(captured.keys[index]!)
          ?? (captured.snapshot === undefined ? [] : marksOf(captured.snapshot[index]!, includeToolOutput));
        intact = extendsMarks(item, marks, includeToolOutput);
        if (intact) state.verified.add(item);
      }
      if (intact) continue;
      this.evict(state.id);
      throw new GlobalSearchError('invalid_page_token', 'live transcript was rewritten since this search started; restart the search');
    }
  }

  async search(input: LiveSearchInput): Promise<GlobalSearchPage> {
    const q = input.query;
    const fingerprint = `${tokenFingerprint(q, 'live')}:${q.pageSize}`;
    let state: LiveSearchState;
    let sequence = 0;
    if (input.pageToken === undefined) {
      while (this.states.size >= 8) this.evict(this.states.keys().next().value!);
      state = { id: randomUUID(), fingerprint, store: new WeakRef(input.store), agents: new Map(), verified: new WeakSet(), historical: new Map(),
        gaps: new Set(), rows: [], touchedAt: Date.now(), sequence: 0, residentDone: false,
        emitted: 0, documents: 0, bytes: 0, records: 0 };
      this.states.set(state.id, state);
    } else {
      let cursor: { v?: number; f?: string; id?: string; sequence?: number };
      try { cursor = JSON.parse(Buffer.from(input.pageToken, 'base64url').toString('utf8')) as typeof cursor; }
      catch { throw new GlobalSearchError('invalid_page_token', 'pageToken is malformed'); }
      const saved = cursor?.id === undefined ? undefined : this.states.get(cursor.id);
      if (cursor?.v !== 3 || cursor.f !== fingerprint || saved === undefined || saved.fingerprint !== fingerprint || saved.store.deref() !== input.store ||
          !Number.isSafeInteger(cursor.sequence) || cursor.sequence! < 0 || Date.now() - saved.touchedAt > 60_000) {
        throw new GlobalSearchError('invalid_page_token', 'live search cursor expired or changed; restart the search');
      }
      state = saved;
      sequence = cursor.sequence!;
      this.assertWatermark(state, input.store, q.includeToolOutput === true);
      if (state.last?.sequence === sequence) return state.last.page;
      if (state.sequence !== sequence) throw new GlobalSearchError('invalid_page_token', 'live search cursor was already consumed');
    }
    if (state.active) throw new GlobalSearchError('invalid_page_token', 'live search cursor is already in use');
    state.active = true;
    state.touchedAt = Date.now();
    clearTimeout(this.expirations.get(state.id));
    const expiration = setTimeout(() => this.evict(state.id), 60_000);
    expiration.unref();
    this.expirations.set(state.id, expiration);
    const timeout = new AbortController();
    const signal = input.signal === undefined ? timeout.signal : AbortSignal.any([input.signal, timeout.signal]);
    const timer = setTimeout(() => timeout.abort(new LiveDeadline()), Math.max(0, input.deadlineAt - Date.now()));
    const check = (): void => {
      input.signal?.throwIfAborted();
      if (Date.now() >= input.deadlineAt) throw new LiveDeadline();
      signal.throwIfAborted();
    };
    let deadline = false;
    const items: GlobalSearchHit[] = [];
    try {
      check();
      if (state.iterator === undefined && !state.residentDone) {
        await abortable(input.ready(), signal);
        check();
        state.summary = await abortable(input.summary(), signal);
        check();
        const ids = q.container?.agentId === undefined ? input.store.agents().map((agent) => agent.agentId) : [q.container.agentId];
        for (const agent of ids) {
          check();
          const transcript = input.store.getAgent(agent);
          if (transcript === undefined) { state.historical.set(agent, undefined); continue; }
          const items = transcript.getItems();
          for (const item of items) state.verified.add(item);
          state.agents.set(agent, { snapshot: items, keys: items.map(itemKey), marks: new Map(), completeTurns: new Set() });
          if (transcript.hasMoreOlder) state.historical.set(agent, undefined);
        }
        state.iterator = residentDocs(input.sessionId, state, q);
      }
      let chars = 0;
      let nodes = 0;
      while (!state.residentDone) {
        check();
        if (chars >= input.textBudget) { deadline = true; break; }
        if (nodes >= 4096) break;
        const next = state.iterator!.next();
        if (next.done) {
          finishResident(state, q);
          break;
        }
        const doc = next.value;
        if (doc !== undefined) {
          state.documents += 1;
          chars += doc.value.text.length;
          const matched = matchResident(q, doc);
          if (matched !== undefined) {
            state.rows.push({ ...matched, value: { ...matched.value,
              text: matched.value.kind === 'title' ? matched.value.text : makeSnippet(matched.value.text, q.query, 80,
                matched.anchor === undefined || q.literalQuery === undefined ? undefined : { at: matched.anchor, len: q.literalQuery.length }) } });
            if (state.rows.length >= Math.min(input.maxHits, 4096)) {
              state.gaps.add('candidate_cap');
              finishResident(state, q);
            }
          }
        }
        if (++nodes % 16 === 0) await setImmediate(undefined, { signal });
      }
      if (state.residentDone) {
        const rows = state.rows.slice(state.emitted, state.emitted + q.pageSize);
        items.push(...rows.map((row) => hitOf(row)));
        state.emitted += rows.length;
        if (items.length === 0 && state.historical.size > 0) {
          check();
          const [agent, cursor] = state.historical.entries().next().value!;
          if (input.navigation === undefined) {
            state.gaps.add('history_unavailable');
            state.historical.clear();
          } else {
            const scan = await abortable(input.navigation.scan(input.sessionId, agent, signal, {
              query: q.mode === 'terms' && q.op === 'OR' ? (q.termsQuery ?? []).map((term) => `"${term}"`).join(' ') : q.query,
              mode: q.mode === 'literal' ? 'literal' : q.op === 'OR' ? 'any' : 'terms',
              includeToolOutput: q.includeToolOutput, role: q.role === 'title' ? undefined : q.role,
              after: q.startTime, before: q.endTime === undefined ? undefined : q.endTime + 1,
              pageSize: q.pageSize,
              sort: q.mode !== 'literal' && q.sort === 'time_asc' ? 'oldest' : q.sort === 'score' && q.mode !== 'literal' ? 'relevance' : 'newest',
              orderedCursor: cursor,
            }, undefined, { maxBytes: 128 << 10, maxRecords: 512, allowOversize: false }), signal);
            check();
            if (scan === undefined) {
              state.gaps.add('source_missing');
              state.historical.delete(agent);
            } else {
              state.bytes += scan.bytesRead;
              state.records += scan.recordsRead;
              const completeTurns = state.agents.get(agent)?.completeTurns;
              for (const hit of scan.hits ?? []) {
                if (hit.turn !== undefined && completeTurns?.has(hit.turn) || hit.role === 'record' || q.role === 'title' ||
                    q.workspaceId !== undefined && q.workspaceId !== state.summary?.workspaceId) continue;
                if (state.rows.some(({ value }) => value.kind === 'message' && value.agentId === agent &&
                    value.turn === hit.turn && value.stepId === hit.stepId && value.role === hit.role && value.text === hit.snippet)) continue;
                items.push({ sessionId: input.sessionId, workspaceId: state.summary?.workspaceId ?? '',
                  sessionTitle: state.summary?.title ?? '', agentId: agent, role: hit.role,
                  snippet: hit.snippet, time: hit.time ?? state.summary?.updatedAt ?? 0,
                  turn: hit.turn, stepId: hit.stepId, score: q.mode === 'literal' ? 0 : q.termsQuery?.length ?? 0 });
              }
              for (const gap of scan.gaps ?? []) {
                if (!['page_local_relevance', 'navigation_building', 'wire_scan_limit'].includes(gap)) state.gaps.add(gap);
              }
              if (scan.orderedNext !== undefined) state.historical.set(agent, scan.orderedNext);
              else {
                state.historical.delete(agent);
                if (!scan.complete) state.gaps.add(scan.incompleteReason ?? 'history_partial');
              }
            }
          }
        }
      }
    } catch (error) {
      if (input.signal?.aborted) { this.evict(state.id); input.signal.throwIfAborted(); }
      if (error instanceof LiveDeadline || timeout.signal.aborted) deadline = true;
      else {
        this.evict(state.id);
        if (error instanceof Error && ['stale_scan_cursor', 'history_source_changed'].includes(error.message)) {
          throw new GlobalSearchError('invalid_page_token', 'history source changed; restart the search');
        }
        throw error;
      }
    } finally { clearTimeout(timer); state.active = false; }
    this.assertWatermark(state, input.store, q.includeToolOutput === true);
    const scanPending = !state.residentDone || state.historical.size > 0;
    const hasMore = scanPending || state.emitted < state.rows.length;
    const gaps = [...state.gaps];
    if (scanPending) gaps.push('scan_pending');
    if (state.historical.size > 0 || state.bytes > 0) gaps.push('page_local_order');
    if (deadline) gaps.push('deadline');
    const page: GlobalSearchPage = { items, hasMore,
      pageToken: hasMore ? Buffer.from(JSON.stringify({ v: 3, f: fingerprint, id: state.id, sequence: sequence + 1 })).toString('base64url') : undefined,
      incomplete: deadline ? 'deadline' : state.gaps.has('candidate_cap') ? 'candidate_cap' : scanPending || state.gaps.size > 0 ? 'scan_budget' : undefined,
      coverage: { domain: 'full_text', complete: !scanPending && !deadline && state.gaps.size === 0, gaps,
        scanned: { bytes: state.bytes, records: state.records } },
      indexState: { state: !state.residentDone || state.historical.size > 0 ? 'building' : 'ready',
        indexedSessions: 1, totalSessions: 1, documents: state.documents }, source: 'live' };
    state.last = { sequence, page };
    state.sequence = sequence + 1;
    return page;
  }
}

function* residentDocs(sessionId: string, state: LiveSearchState, q: NormalizedQuery): Generator<LiveDoc | undefined> {
  const summary = state.summary;
  const workspaceId = summary?.workspaceId ?? '';
  const sessionTitle = summary?.title ?? '';
  const timeOf = (iso?: string): number => {
    const time = iso === undefined ? NaN : Date.parse(iso);
    return Number.isNaN(time) ? summary?.updatedAt ?? 0 : time;
  };
  for (const [agentId, resident] of state.agents) {
    const captured = resident.snapshot;
    if (captured === undefined) continue;
    for (const item of captured) {
      yield undefined;
      if (item.kind !== 'turn' || item.contentRefs?.length) {
        resident.marks.set(itemKey(item), []);
        if (item.kind === 'turn') state.historical.set(agentId, undefined);
        continue;
      }
      let complete = true;
      const marks: TextMark[] = [];
      const doc = (key: string, role: MessageDoc['role'], text: string, time: number, stepId?: string): LiveDoc | undefined => {
        if (text.length > MAX_DOC_TEXT_CHARS) {
          complete = false;
          state.historical.set(agentId, undefined);
          return undefined;
        }
        const bounded = text.slice(0, MAX_DOC_TEXT_CHARS).trim();
        if (!bounded) return undefined;
        return { key, value: { kind: 'message', sessionId, workspaceId, sessionTitle, agentId, role,
          text: bounded, time, turn: item.ordinal, stepId } };
      };
      if (item.prompt !== undefined) {
        marks.push(markOf('prompt', item.prompt, false));
        yield doc(`${sessionId}/${agentId}/live/u/t${item.ordinal}`, 'user', item.prompt, timeOf(item.startedAt));
      }
      for (const step of item.steps) {
        yield undefined;
        const time = timeOf(step.endedAt ?? step.startedAt ?? item.startedAt);
        for (const frame of step.frames) {
          yield undefined;
          const role = frameRole(frame, q.includeToolOutput === true);
          if (role === undefined) continue;
          if (frame.contentRefs?.length) { complete = false; state.historical.set(agentId, undefined); continue; }
          const text = frameText(frame);
          marks.push(markOf(frame.frameId, text, frame.kind === 'tool' && frame.state === 'running'));
          yield doc(`${sessionId}/${agentId}/live/${role}/${frame.frameId}`, role, text, time, step.stepId);
        }
      }
      resident.marks.set(itemKey(item), marks);
      if (complete) resident.completeTurns.add(item.ordinal);
    }
  }
  if (sessionTitle) yield { key: `${sessionId}/$title`, value: { kind: 'title', sessionId, workspaceId, sessionTitle,
    agentId: '', role: 'title', text: sessionTitle.slice(0, MAX_DOC_TEXT_CHARS), time: summary?.updatedAt ?? 0 } };
}

function finishResident(state: LiveSearchState, q: NormalizedQuery): void {
  state.residentDone = true;
  state.iterator = undefined;
  state.rows.sort((left, right) => compareRows(q, left, right));
  for (const resident of state.agents.values()) resident.snapshot = undefined;
}

function frameRole(frame: TranscriptFrame, includeToolOutput: boolean): MessageDoc['role'] | undefined {
  if (frame.kind === 'tool') return includeToolOutput ? 'tool' : undefined;
  if (frame.kind !== 'text') return undefined;
  return frame.role === 'assistant' ? 'assistant' : projectTranscriptUserOrigin(frame.origin) !== undefined ? 'user' : undefined;
}

function frameText(frame: TranscriptFrame): string {
  if (frame.kind === 'text') return frame.text ?? '';
  if (frame.kind !== 'tool') return '';
  if (typeof frame.output === 'string') return frame.output;
  let text = '';
  if (Array.isArray(frame.output)) for (const part of frame.output) {
    if (part.type === 'text') text += part.text.slice(0, MAX_DOC_TEXT_CHARS + 1 - text.length);
    if (text.length > MAX_DOC_TEXT_CHARS) break;
  }
  return text;
}

function markOf(id: string, text: string, pending: boolean): TextMark {
  const length = Math.min(text.length, MAX_DOC_TEXT_CHARS + 1);
  return { id, length, digest: digestOf(text, length), pending };
}

function digestOf(text: string, length: number): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return hash >>> 0;
}

function searchableTexts(item: TranscriptItem, includeToolOutput: boolean): Map<string, { text?: string; pending: boolean }> {
  const texts = new Map<string, { text?: string; pending: boolean }>();
  if (item.kind !== 'turn' || item.contentRefs?.length) return texts;
  if (item.prompt !== undefined) texts.set('prompt', { text: item.prompt, pending: false });
  for (const step of item.steps) for (const frame of step.frames) {
    if (frameRole(frame, includeToolOutput) === undefined) continue;
    texts.set(frame.frameId, frame.contentRefs?.length ? { pending: true }
      : { text: frameText(frame), pending: frame.kind === 'tool' && frame.state === 'running' });
  }
  return texts;
}

function marksOf(item: TranscriptItem, includeToolOutput: boolean): TextMark[] {
  return [...searchableTexts(item, includeToolOutput)].flatMap(([id, { text, pending }]) => text === undefined ? [] : [markOf(id, text, pending)]);
}

function extendsMarks(item: TranscriptItem, marks: readonly TextMark[], includeToolOutput: boolean): boolean {
  if (marks.length === 0) return true;
  const texts = searchableTexts(item, includeToolOutput);
  return marks.every((mark) => {
    const current = texts.get(mark.id);
    if (current === undefined) return false;
    if (mark.pending || current.text === undefined) return true;
    return current.text.length >= mark.length && digestOf(current.text, mark.length) === mark.digest;
  });
}

function itemKey(item: TranscriptItem): string {
  return item.kind === 'turn' ? `turn:${item.turnId}` : item.kind === 'marker' ? `marker:${item.markerId}` : `taskref:${item.refId}`;
}

function startOfKeys(items: readonly TranscriptItem[], keys: readonly string[]): number {
  if (keys.length === 0) return 0;
  const start = items.findIndex((item) => itemKey(item) === keys[0]);
  if (start < 0 || items.length - start < keys.length) return -1;
  return keys.every((key, index) => itemKey(items[start + index]!) === key) ? start : -1;
}

function matchResident(q: NormalizedQuery, doc: LiveDoc): MatchedRow | undefined {
  const value = doc.value;
  if (q.container?.agentId !== undefined && value.agentId !== q.container.agentId ||
      q.workspaceId !== undefined && q.workspaceId !== value.workspaceId ||
      q.role !== undefined && q.role !== value.role ||
      value.role === 'tool' && !q.includeToolOutput ||
      q.startTime !== undefined && value.time < q.startTime || q.endTime !== undefined && value.time > q.endTime) return undefined;
  if (q.literalQuery !== undefined) {
    const anchor = normalizeLiteral(value.text).indexOf(q.literalQuery);
    return anchor < 0 ? undefined : { ...doc, score: 0, anchor };
  }
  const terms = q.termsQuery ?? [];
  if (terms.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const token of tokenize(value.text)) counts.set(token, (counts.get(token) ?? 0) + 1);
  if (q.op === 'AND' ? !terms.every((term) => counts.has(term)) : !terms.some((term) => counts.has(term))) return undefined;
  return { ...doc, score: terms.reduce((score, term) => score + Math.log(1 + (counts.get(term) ?? 0)), 0) };
}

function hitOf(row: MatchedRow): GlobalSearchHit {
  const doc = row.value;
  return { sessionId: doc.sessionId, workspaceId: doc.workspaceId, sessionTitle: doc.sessionTitle,
    agentId: doc.agentId, role: doc.role, snippet: doc.text, time: doc.time,
    turn: doc.kind === 'message' ? doc.turn : undefined,
    stepId: doc.kind === 'message' ? doc.stepId : undefined, score: row.score };
}
