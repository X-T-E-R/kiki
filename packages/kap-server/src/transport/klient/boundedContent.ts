import {
  CONTENT_PAGE_BYTES,
  CONTENT_PREVIEW_BYTES,
  jsonBytes,
  jsonTextPrefix,
  type ContentRef,
  type ContentSegment,
  type ContentSource,
  type ContentWindow,
} from '@kiki/transcript';
import { projectInlineToolMedia } from '../../services/inlineMedia';
import { contentRevision, contentRevisionOfArray } from './contentRevision';
const fieldRevisions = new WeakMap<object, Map<string, string>>();
export const ENTITY_BYTES = 64 * 1024;
export const TIMELINE_ENTITY_BYTES = 128 * 1024;
const ARRAY_WINDOW = 4;
const ROSTER_WINDOW = 64;
const ROSTER_SEGMENT_LIMIT = 2048;
const ROSTER_PAGE_BYTES = 1024 * 1024;
const OBJECT_WINDOW = 64;
const ID_KEYS = /^(?:id|kind|state|status|role|op|.*Id|.*_id|mediaType|marker|interactionKind|type)$/u;
const OPAQUE_FIELDS = new Set(['input', 'output', 'display', 'request', 'response', 'payload', 'content', 'customData', 'detail']);

type Path = ContentRef['path'];
type StructureDirection = 'head' | 'tail';
interface Cut { path: Path; kind: ContentRef['kind']; offset: number; total: number; direction?: ContentRef['direction'] }
interface Budget { nodes: number }

export class ContentChangedError extends Error {
  constructor() { super('Content changed; reload its preview before continuing.'); }
}

export { contentRevision } from './contentRevision';

function selectContent(entity: object, path: Path): unknown {
  let selected: unknown = entity;
  for (const key of path) {
    if (selected === null || typeof selected !== 'object' || !Object.hasOwn(selected, key)) throw new ContentChangedError();
    selected = (selected as Record<string | number, unknown>)[key];
  }
  return selected;
}

function fieldRevision(entity: object, path: Path, through?: number): string {
  const selected = selectContent(entity, path);
  const owner = selected !== null && typeof selected === 'object' ? selected : entity;
  let fields = fieldRevisions.get(owner);
  if (fields === undefined) { fields = new Map(); fieldRevisions.set(owner, fields); }
  const structure = isStructurePath(path) && Array.isArray(selected);
  const count = structure ? through ?? selected.length : undefined;
  if (structure && count! > selected.length) throw new ContentChangedError();
  const key = owner === entity
    ? JSON.stringify([path, count])
    : JSON.stringify([structure, isRosterPath(path), count, Array.isArray(selected) ? selected.length : undefined]);
  const existing = fields.get(key);
  if (existing !== undefined) return existing;
  const revision = structure
    ? contentRevision(selected.slice(0, count).map((child) => {
      const header = child as Record<string, unknown>;
      return [header['kind'], header['stepId'] ?? header['frameId'], header['ordinal']];
    }))
    : isRosterPath(path) && Array.isArray(selected)
      ? contentRevisionOfArray(selected.length, (index) => {
        const header = selected[index] as Record<string, unknown>;
        return header['agent_id'] ?? header['id'];
      })
      : contentRevision(selected);
  fields.set(key, revision);
  return revision;
}

function isRosterPath(path: Path): boolean {
  return path.length === 1 && path[0] === 'subagents';
}

function bindCuts(entity: object, source: ContentSource, cuts: readonly Cut[]): ContentRef[] {
  return cuts.map((cut) => ({
    ...cut,
    source,
    revision: fieldRevision(entity, cut.path, isStructurePath(cut.path) ? cut.total : undefined),
  }));
}

export function boundedEntity<T extends object>(entity: T, source: ContentSource, maxBytes = source.kind === 'turn' || source.kind === 'frame' ? TIMELINE_ENTITY_BYTES : ENTITY_BYTES, agentId?: string, structureDirection: StructureDirection = 'head', initialRosterWindow = ROSTER_WINDOW): T & ContentWindow {
  if (source.kind === 'todo') {
    if ((entity as ContentWindow).contentRefs !== undefined) return entity;
    if (maxBytes >= ENTITY_BYTES) return boundedTodo(entity, source, maxBytes);
  }
  const result = projectAt(entity, [], source, entity, maxBytes, agentId, structureDirection, initialRosterWindow);
  return { ...(result.value as T), contentRefs: result.refs.length === 0 ? undefined : result.refs };
}

const NOTE_FIELDS = new Set(['goal', 'directives', 'decided', 'rejected', 'evidence', 'files', 'next', 'open']);

function boundedTodo<T extends object>(entity: T, source: ContentSource, maxBytes: number): T & ContentWindow {
  const body = { ...entity } as Record<string, unknown>;
  const inline: Record<string, unknown> = {};
  let available = maxBytes - 4096;
  const notes = body['notes'];
  if (notes !== null && typeof notes === 'object' && !Array.isArray(notes)) {
    const entries = Object.entries(notes);
    let characters = 0;
    const legal = entries.length <= NOTE_FIELDS.size && entries.every(([key, value]) => {
      if (!NOTE_FIELDS.has(key) || typeof value !== 'string' || value.length > 1500) return false;
      characters += value.length;
      return characters <= 7500;
    });
    if (legal) {
      const bytes = jsonBytes({ notes });
      if (bytes <= available) {
        inline['notes'] = notes;
        delete body['notes'];
        available -= bytes;
      }
    }
  }
  const items = body['items'];
  if (Array.isArray(items) && completeTodoItemsFit(items, available)) {
    inline['items'] = items;
    delete body['items'];
    available -= jsonBytes({ items });
  }
  const result = projectAt(body, [], source, entity, available + 4096);
  return { ...(result.value as T), ...inline, contentRefs: result.refs.length === 0 ? undefined : result.refs };
}

function completeTodoItemsFit(items: readonly unknown[], maxBytes: number): boolean {
  let bytes = 12;
  for (const value of items) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    if (typeof item['title'] !== 'string' || item['title'].length > maxBytes - bytes ||
      !['pending', 'in_progress', 'done'].includes(item['status'] as string) ||
      Object.keys(item).some((key) => key !== 'title' && key !== 'status')) return false;
    bytes += jsonBytes(item) + 1;
    if (bytes > maxBytes) return false;
  }
  return true;
}

export function boundedListPreview<T extends object>(entity: T, maxBytes = 2048): T {
  let textBytes = CONTENT_PREVIEW_BYTES;
  let arrayWindow = ARRAY_WINDOW;
  for (;;) {
    const projected = projectValue(entity, [], [], textBytes, arrayWindow, 0, { nodes: 128 }) as T;
    if (jsonBytes(projected) <= maxBytes) return projected;
    if (arrayWindow > 0) { arrayWindow = 0; continue; }
    if (textBytes > 32) { textBytes = Math.floor(textBytes / 2); continue; }
    return projected;
  }
}

function isUserTextFrame(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record['kind'] === 'text' && record['role'] === 'user';
}

const USER_FRAME_PRESERVE_WINDOW = 32;

function jsonStringBytes(text: string): number {
  let bytes = 2;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit === 0x22 || unit === 0x5c || unit === 0x08 || unit === 0x0c || unit === 0x0a || unit === 0x0d || unit === 0x09) {
      bytes += 2;
    } else if (unit < 0x20) {
      bytes += 6;
    } else if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (unit >= 0xd800 && unit <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function tryCompactFlatObject(value: unknown, maxBytes: number, textLimit: number): number | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return undefined;
  const record = value as Record<string, unknown>;
  const kind = record['kind'];
  if (kind === 'marker' || kind === 'tool') return undefined;
  let totalKeys = 0;
  let serializedKeys = 0;
  let bytes = 2;
  for (const key in record) {
    if (!Object.hasOwn(record, key)) continue;
    totalKeys += 1;
    if (totalKeys > OBJECT_WINDOW || key.length > 160) return undefined;
    const child = record[key];
    if (child === undefined) continue;
    const keyBytes = jsonStringBytes(key);
    let valueBytes: number;
    if (typeof child === 'string') {
      valueBytes = jsonStringBytes(child);
      if (valueBytes > textLimit && !ID_KEYS.test(key)) return undefined;
    } else if (child === null) {
      valueBytes = 4;
    } else if (typeof child === 'boolean') {
      valueBytes = child ? 4 : 5;
    } else if (typeof child === 'number') {
      valueBytes = Number.isFinite(child) ? String(child).length : 4;
    } else {
      return undefined;
    }
    bytes += (serializedKeys > 0 ? 1 : 0) + keyBytes + 1 + valueBytes;
    serializedKeys += 1;
    if (bytes + 20 > maxBytes) return undefined;
  }
  return bytes;
}

function projectAt(value: unknown, path: Path, source: ContentSource, entity: object, maxBytes: number, agentId?: string, structureDirection: StructureDirection = 'head', initialRosterWindow = ROSTER_WINDOW): { value: unknown; refs: ContentRef[]; valueBytes?: number } {
  const media = agentId === undefined ? undefined : { source, entity, agentId };
  let textBytes = source.kind === 'turn' || source.kind === 'frame'
    ? 16 * 1024
    : source.kind === 'task'
      ? Math.max(CONTENT_PREVIEW_BYTES, Math.min(8 * 1024, maxBytes))
      : CONTENT_PREVIEW_BYTES;
  if (media === undefined) {
    const compactBytes = tryCompactFlatObject(value, maxBytes, Math.min(textBytes, CONTENT_PREVIEW_BYTES));
    if (compactBytes !== undefined) return { value, refs: [], valueBytes: compactBytes };
  }
  let arrayWindow = ARRAY_WINDOW;
  let rosterWindow = initialRosterWindow;
  let structureWindow = 8;
  let completeSendReceipts = true;
  let preserveUserFrames = true;
  for (;;) {
    const cuts: Cut[] = [];
    const receiptProjection = { complete: completeSendReceipts, retained: false };
    const projected = projectValue(value, path, cuts, textBytes, arrayWindow, 0, { nodes: 128 }, structureWindow, media, structureDirection, receiptProjection, rosterWindow, preserveUserFrames);
    const refs = bindCuts(entity, source, cuts);
    if (jsonBytes({ value: projected, refs }) <= maxBytes) return { value: projected, refs };
    if (receiptProjection.retained) { completeSendReceipts = false; continue; }
    if (textBytes > CONTENT_PREVIEW_BYTES) { textBytes = Math.floor(textBytes / 2); continue; }
    if (arrayWindow > 0) { arrayWindow = 0; continue; }
    if (rosterWindow > 8) { rosterWindow = Math.floor(rosterWindow / 2); continue; }
    if (textBytes > 32) { textBytes = Math.floor(textBytes / 2); continue; }
    if (structureWindow > 1) { structureWindow = Math.floor(structureWindow / 2); continue; }
    if (preserveUserFrames) { preserveUserFrames = false; continue; }
    return { value: projected, refs };
  }
}

const COMPACTION_HEADLINE_KEYS = ['type', 'phase', 'strategy', 'fallbackFrom', 'source', 'reasonCodes', 'time', 'shapeVersion'] as const;
const COMPACTION_SUMMARY_KEYS = ['summary', 'contextSummary'] as const;

function compactionEnum(value: unknown, allowed: readonly string[]): string | undefined {
  return typeof value === 'string' && allowed.includes(value) ? value : undefined;
}

function compactionHeadline(payload: object, path: Path, cuts: Cut[], textBytes: number): Record<string, unknown> {
  const record = payload as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const key of COMPACTION_HEADLINE_KEYS) {
    const value = record[key];
    if (key === 'strategy' || key === 'fallbackFrom') {
      const strategy = compactionEnum(value, ['summarize', 'relay']);
      if (strategy !== undefined) kept[key] = strategy;
    } else if (key === 'source') {
      const source = compactionEnum(value, ['auto', 'manual']);
      if (source !== undefined) kept[key] = source;
    } else if (key === 'phase') {
      const phase = compactionEnum(value, ['queued', 'running', 'started', 'blocked', 'completed', 'failed', 'cancelled', 'interrupted']);
      if (phase !== undefined) kept[key] = phase;
    } else if (key === 'reasonCodes' && Array.isArray(value) && value.every((code) => typeof code === 'string')) {
      kept[key] = value;
    } else if (key === 'type' && typeof value === 'string') {
      kept[key] = value;
    } else if ((key === 'time' || key === 'shapeVersion') && typeof value === 'number') {
      kept[key] = value;
    }
  }
  const result = record['result'];
  if (!path.includes('result') && result !== null && typeof result === 'object' && !Array.isArray(result)) {
    kept['result'] = compactionHeadline(result, [...path, 'result'], cuts, textBytes);
  }
  for (const key of COMPACTION_SUMMARY_KEYS) {
    const summary = record[key];
    if (typeof summary !== 'string') continue;
    const prefix = jsonTextPrefix(summary, 0, Math.min(textBytes, CONTENT_PREVIEW_BYTES));
    kept[key] = prefix;
    if (prefix.length < summary.length) cuts.push({ path: [...path, key], kind: 'text', offset: prefix.length, total: summary.length });
  }
  return kept;
}

function isStructurePath(path: Path): boolean {
  return path.length === 1 && path[0] === 'steps' ||
    path.length === 3 && path[0] === 'steps' && typeof path[1] === 'number' && path[2] === 'frames';
}

const EXTERNAL_TEXT_FIELDS = new Set<string>(['recordId', 'turnId', 'text', 'kind', 'title', 'relatedOperationIds', 'sourceUrl', 'clientTime', 'source'] satisfies readonly (keyof import('@kiki/transcript').ExternalTextRecord)[]);

function isExternalTextMarker(value: object, path: Path): boolean {
  if (path.length > 0) return false;
  const marker = value as Record<string, unknown>;
  if (marker['kind'] !== 'marker' || marker['marker'] !== 'external.text') return false;
  const payload = marker['payload'];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  if (!Object.keys(record).every((key) => EXTERNAL_TEXT_FIELDS.has(key)) ||
    typeof record['recordId'] !== 'string' || typeof record['turnId'] !== 'number' ||
    typeof record['text'] !== 'string' || typeof record['kind'] !== 'string' ||
    !['note', 'user_excerpt', 'assistant_excerpt', 'handoff'].includes(record['kind'])) return false;
  const source = record['source'];
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return false;
  const identity = source as Record<string, unknown>;
  return identity['driver'] === 'external' && typeof identity['connectionId'] === 'string' &&
    typeof identity['clientName'] === 'string' && typeof identity['sessionRef'] === 'string';
}

function isSendMessageFrame(value: object): boolean {
  const frame = value as Record<string, unknown>;
  return frame['kind'] === 'tool' && frame['name'] === 'SendMessage' &&
    typeof frame['toolCallId'] === 'string' && !frame['toolCallId'].startsWith('external:');
}

function isSendMessageReceipt(output: string): boolean {
  if (output.length > TIMELINE_ENTITY_BYTES) return false;
  try {
    const receipt: unknown = JSON.parse(output);
    if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) return false;
    const fields = receipt as Record<string, unknown>;
    return typeof fields['message_id'] === 'string' ||
      Array.isArray(fields['messages']) && fields['messages'].every((item) =>
        item !== null && typeof item === 'object' && typeof (item as Record<string, unknown>)['message_id'] === 'string');
  } catch {
    return false;
  }
}

function projectValue(value: unknown, path: Path, cuts: Cut[], textBytes: number, arrayWindow: number, depth: number, budget: Budget, structureWindow = 16, media?: { source: ContentSource; entity: object; agentId: string }, structureDirection: StructureDirection = 'head', receiptProjection = { complete: false, retained: false }, rosterWindow = ROSTER_WINDOW, preserveUserFrames = false): unknown {
  budget.nodes -= 1;
  if (media !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const projected = projectInlineToolMedia(value, path, media.source, media.entity, media.agentId);
    if (projected !== undefined) return projected;
  }
  if (typeof value === 'string') {
    const key = path.at(-1);
    const prose = (path.length === 1 && (key === 'prompt' || key === 'text' || key === 'resultSummary' || key === 'outputTail')) ||
      (path.length === 5 && path[0] === 'steps' && path[2] === 'frames' && key === 'text');
    if (typeof key === 'string' && ID_KEYS.test(key) || key === 'url' && path.at(-2) === 'source') return value;
    const limit = prose ? textBytes : Math.min(textBytes, CONTENT_PREVIEW_BYTES);
    const prefix = jsonTextPrefix(value, 0, limit);
    if (prefix.length < value.length) cuts.push({ path, kind: 'text', offset: prefix.length, total: value.length });
    return prefix;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const structure = isStructurePath(path);
    const roster = isRosterPath(path);
    const count = structure ? Math.min(value.length, structureWindow)
      : roster ? Math.min(value.length, rosterWindow)
      : depth > 12 || budget.nodes < 0 ? 0 : Math.min(value.length, arrayWindow);
    let start = structure && structureDirection === 'tail' ? value.length - count : 0;
    let sliceCount = count;
    if (
      preserveUserFrames &&
      structure &&
      structureDirection === 'tail' &&
      start > 0 &&
      path.length === 3 &&
      path[0] === 'steps' &&
      path[2] === 'frames'
    ) {
      const firstUser = value.findIndex((item, index) => index < start && isUserTextFrame(item));
      if (firstUser !== -1 && value.length - firstUser <= USER_FRAME_PRESERVE_WINDOW) {
        start = firstUser;
        sliceCount = value.length - start;
      }
    }
    const projected = value.slice(start, start + sliceCount).map((child, index) => projectValue(child, [...path, start + index], cuts, textBytes, arrayWindow, depth + 1, structure || roster ? { nodes: 128 } : budget, structureWindow, media, structureDirection, receiptProjection, rosterWindow, preserveUserFrames));
    if (sliceCount < value.length) {
      if (structure && structureDirection === 'tail') cuts.push({ path, kind: 'array', offset: start, total: value.length, direction: 'backward' });
      else cuts.push({ path, kind: 'array', offset: sliceCount, total: value.length });
    }
    return projected;
  }
  const entries = Object.entries(value);
  const opaque = path.some((key) => typeof key === 'string' && OPAQUE_FIELDS.has(key));
  if (entries.length > OBJECT_WINDOW || depth > 12 || (opaque && entries.length > Math.max(0, budget.nodes)) || entries.some(([key]) => key.length > CONTENT_PREVIEW_BYTES || jsonBytes(key) > CONTENT_PREVIEW_BYTES)) {
    cuts.push({ path, kind: 'object', offset: 0, total: entries.length });
    return {};
  }
  const externalText = isExternalTextMarker(value, path);
  const compactionMarker = path.length === 0 && (value as Record<string, unknown>)['kind'] === 'marker' && (value as Record<string, unknown>)['marker'] === 'compaction';
  return Object.fromEntries(entries.map(([key, child]) => {
    const childPath = [...path, key];
    if (compactionMarker && key === 'payload' && child !== null && typeof child === 'object' && !Array.isArray(child)) {
      return [key, compactionHeadline(child, childPath, cuts, textBytes)];
    }
    if (receiptProjection.complete && isSendMessageFrame(value) && (
      key === 'output' && typeof child === 'string' && isSendMessageReceipt(child) ||
      key === 'input' && child !== null && typeof child === 'object' && !Array.isArray(child) &&
        Array.isArray((child as Record<string, unknown>)['messages']) && jsonBytes(child) <= TIMELINE_ENTITY_BYTES
    )) {
      receiptProjection.retained = true;
      return [key, child];
    }
    if (OPAQUE_FIELDS.has(key) && !(externalText && key === 'payload') && textBytes <= CONTENT_PREVIEW_BYTES && child !== null && typeof child === 'object') {
      const total = Array.isArray(child) ? child.length : Object.keys(child).length;
      if (total > 8) {
        cuts.push({ path: childPath, kind: Array.isArray(child) ? 'array' : 'object', offset: 0, total });
        return [key, Array.isArray(child) ? [] : {}];
      }
    }
    return [key, projectValue(child, childPath, cuts, textBytes, arrayWindow, depth + 1, OPAQUE_FIELDS.has(key) ? { nodes: 64 } : budget, structureWindow, media, structureDirection, receiptProjection, rosterWindow, preserveUserFrames)];
  }));
}

export function readContentSegment(entity: object, ref: ContentRef, range = false, agentId?: string, pageBytes = CONTENT_PAGE_BYTES): ContentSegment {
  const direction = ref.direction;
  const selected = selectContent(entity, ref.path);
  if (range && ref.kind === 'text' && typeof selected === 'string' && ref.offset > 0 && /[\uD800-\uDBFF]/u.test(selected[ref.offset - 1]!)) ref = { ...ref, offset: ref.offset - 1 };
  const structure = ref.kind === 'array' && isStructurePath(ref.path);
  const roster = ref.kind === 'array' && isRosterPath(ref.path);
  const effectivePageBytes = roster && pageBytes <= CONTENT_PAGE_BYTES ? ROSTER_PAGE_BYTES : pageBytes;
  if (direction === 'backward' && !structure) throw new ContentChangedError();
  if (fieldRevision(entity, ref.path, structure ? ref.total : undefined) !== ref.revision) throw new ContentChangedError();
  let refs: ContentRef[] = [];
  let value: unknown;
  let offset: number;
  let start: number | undefined;
  if (ref.kind === 'text') {
    if (typeof selected !== 'string' || selected.length !== ref.total || ref.offset >= selected.length || (ref.offset > 0 && /[\uD800-\uDBFF]/u.test(selected[ref.offset - 1]!))) throw new ContentChangedError();
    let end = Math.min(selected.length, ref.offset + 4097);
    if (end < selected.length && /[\uD800-\uDBFF]/u.test(selected[end - 1]!)) end -= 1;
    value = range ? jsonTextPrefix(selected.slice(ref.offset, end), 0, effectivePageBytes / 2) : jsonTextPrefix(selected, ref.offset, effectivePageBytes / 2);
    offset = ref.offset + (value as string).length;
  } else if (ref.kind === 'array') {
    if (!Array.isArray(selected) || (structure ? selected.length < ref.total : selected.length !== ref.total)) throw new ContentChangedError();
    const itemLimit = roster ? ROSTER_SEGMENT_LIMIT : structure && effectivePageBytes > CONTENT_PAGE_BYTES ? 256 : 20;
    const halfPageBytes = effectivePageBytes / 2;
    if (direction === 'backward') {
      if (ref.offset <= 0 || ref.offset > ref.total) throw new ContentChangedError();
      const reversedValues: unknown[] = [];
      const reversedRefGroups: ContentRef[][] = [];
      let usedBytes = 23;
      let refCount = 0;
      offset = ref.offset;
      while (offset > 0 && reversedValues.length < itemLimit) {
        const index = offset - 1;
        const child = projectAt(selected[index], [...ref.path, index], ref.source, entity, ENTITY_BYTES, agentId, 'tail');
        let deltaBytes = (child.valueBytes ?? jsonBytes(child.value)) + (reversedValues.length > 0 ? 1 : 0);
        let nextRefCount = refCount;
        for (const childRef of child.refs) {
          deltaBytes += jsonBytes(childRef) + (nextRefCount > 0 ? 1 : 0);
          nextRefCount += 1;
        }
        if (reversedValues.length > 0 && usedBytes + deltaBytes > halfPageBytes) break;
        reversedValues.push(child.value);
        if (child.refs.length > 0) reversedRefGroups.push(child.refs);
        usedBytes += deltaBytes;
        refCount = nextRefCount;
        offset = index;
      }
      reversedValues.reverse();
      value = reversedValues;
      for (let groupIndex = reversedRefGroups.length - 1; groupIndex >= 0; groupIndex -= 1) {
        refs.push(...reversedRefGroups[groupIndex]!);
      }
      start = offset;
    } else {
      const values: unknown[] = [];
      let usedBytes = 23;
      let refCount = 0;
      offset = ref.offset;
      if (offset >= ref.total) throw new ContentChangedError();
      while (offset < ref.total && values.length < itemLimit) {
        const child = projectAt(selected[offset], [...ref.path, offset], ref.source, entity, ENTITY_BYTES, agentId);
        let deltaBytes = (child.valueBytes ?? jsonBytes(child.value)) + (values.length > 0 ? 1 : 0);
        let nextRefCount = refCount;
        for (const childRef of child.refs) {
          deltaBytes += jsonBytes(childRef) + (nextRefCount > 0 ? 1 : 0);
          nextRefCount += 1;
        }
        if (values.length > 0 && usedBytes + deltaBytes > halfPageBytes) break;
        values.push(child.value);
        if (child.refs.length > 0) refs.push(...child.refs);
        usedBytes += deltaBytes;
        refCount = nextRefCount;
        offset += 1;
      }
      value = values;
    }
  } else {
    if (selected === null || typeof selected !== 'object' || Array.isArray(selected)) throw new ContentChangedError();
    const entries = Object.entries(selected);
    if (entries.length !== ref.total || ref.offset >= entries.length) throw new ContentChangedError();
    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const halfPageBytes = effectivePageBytes / 2;
    let usedBytes = 23;
    let refCount = 0;
    let serializedEntries = 0;
    offset = ref.offset;
    while (offset < entries.length && offset - ref.offset < OBJECT_WINDOW) {
      const [key, child] = entries[offset]!;
      const projected = projectAt(child, [...ref.path, key], ref.source, entity, ENTITY_BYTES, agentId);
      let deltaBytes = 0;
      const omitsEntry = projected.value === undefined;
      if (!omitsEntry) {
        deltaBytes += jsonBytes(key) + 1 + (projected.valueBytes ?? jsonBytes(projected.value)) + (serializedEntries > 0 ? 1 : 0);
      }
      let nextRefCount = refCount;
      for (const childRef of projected.refs) {
        deltaBytes += jsonBytes(childRef) + (nextRefCount > 0 ? 1 : 0);
        nextRefCount += 1;
      }
      if (offset > ref.offset && usedBytes + deltaBytes > halfPageBytes) break;
      values[key] = projected.value;
      if (projected.refs.length > 0) refs.push(...projected.refs);
      usedBytes += deltaBytes;
      refCount = nextRefCount;
      if (!omitsEntry) serializedEntries += 1;
      offset += 1;
    }
    value = values;
  }
  const next = direction === 'backward'
    ? offset > 0 ? { ...ref, offset } : undefined
    : offset < ref.total ? { ...ref, offset } : undefined;
  const segment = direction === 'backward'
    ? { ref, value, next, contentRefs: refs, start }
    : { ref, value, next, contentRefs: refs };
  return segment;
}
