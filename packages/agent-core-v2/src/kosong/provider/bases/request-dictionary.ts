import { createHash } from 'node:crypto';
import { constants, zstdCompress } from 'node:zlib';

const DCZ_MAGIC = Buffer.from([0x5e, 0x2a, 0x4d, 0x18, 0x20, 0x00, 0x00, 0x00]);
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_MEMORY_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_SCOPE_MEMORY_BYTES = 24 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES_PER_SCOPE = 4;
const DEFAULT_MAX_DICTIONARY_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_ENCODED_BYTES = 32 * 1024 * 1024;
const DECODER_ERROR_STATUSES = new Set([400, 412, 413, 415]);
const SCOPE_IGNORED_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'baggage',
  'cache-control',
  'connection',
  'content-encoding',
  'content-length',
  'host',
  'origin',
  'referer',
  'te',
  'traceparent',
  'tracestate',
  'transfer-encoding',
  'user-agent',
  'x-client-request-id',
  'x-dict-miss',
  'x-dict-store',
  'x-dict-stored',
  'x-portway-decode-error',
  'x-request-id',
]);
const ZSTD_PARAMS = {
  [constants.ZSTD_c_checksumFlag]: 1,
  [constants.ZSTD_c_compressionLevel]: 9,
  [constants.ZSTD_c_dictIDFlag]: 0,
  [constants.ZSTD_c_windowLog]: 25,
};

type RequestDictionaryEncoding = 'identity' | 'zstd' | 'dcz';

interface BudgetResident {
  size: number;
  touchedOrder: number;
  drop: () => void;
}

class DictionaryProcessBudget {
  private _bytes = 0;
  private _order = 0;
  private readonly _residents = new Set<BudgetResident>();

  constructor(readonly maxBytes: number) {}

  retainedBytes(): number {
    return this._bytes;
  }

  takeOrder(): number {
    this._order += 1;
    return this._order;
  }

  retain(resident: BudgetResident): boolean {
    this._residents.add(resident);
    this._bytes += resident.size;
    this.evictOverflow(resident);
    if (this._bytes <= this.maxBytes) return true;
    this.release(resident);
    return false;
  }

  release(resident: BudgetResident): void {
    if (!this._residents.delete(resident)) return;
    this._bytes -= resident.size;
  }

  private evictOverflow(protectedResident: BudgetResident): void {
    while (this._bytes > this.maxBytes) {
      const oldest = this.oldest(protectedResident);
      if (oldest === undefined) return;
      const before = this._bytes;
      oldest.drop();
      if (this._bytes >= before) return;
    }
  }

  private oldest(except: BudgetResident): BudgetResident | undefined {
    let selected: BudgetResident | undefined;
    for (const resident of this._residents) {
      if (resident === except) continue;
      if (selected === undefined || resident.touchedOrder < selected.touchedOrder) selected = resident;
    }
    return selected;
  }
}

let processDictionaryBudget = new DictionaryProcessBudget(DEFAULT_MAX_MEMORY_BYTES);

/** Accounting for the live process ceiling. Does not return dictionary bytes. */
export function dictionaryProcessBudgetAccounting(): { readonly maxBytes: number; readonly retainedBytes: number } {
  return {
    maxBytes: processDictionaryBudget.maxBytes,
    retainedBytes: processDictionaryBudget.retainedBytes(),
  };
}

/**
 * Points transports constructed after this call at a fresh shared ceiling.
 * Production construction keeps the 64MiB process budget.
 */
export function testingUseDictionaryBudget(maxBytes: number): {
  restore: () => void;
  retainedBytes: () => number;
} {
  const previous = processDictionaryBudget;
  const budget = new DictionaryProcessBudget(finiteLimit(maxBytes, DEFAULT_MAX_MEMORY_BYTES, 0));
  processDictionaryBudget = budget;
  return {
    restore: () => {
      processDictionaryBudget = previous;
    },
    retainedBytes: () => budget.retainedBytes(),
  };
}

interface DictionaryEntry {
  readonly bytes: Buffer;
  readonly hash: string;
  readonly resident: BudgetResident;
  storedAt: number;
  storedOrder: number;
  touchedAt: number;
  touchedOrder: number;
  generation: number;
  timer?: ReturnType<typeof setTimeout>;
}

interface EncodedRequest {
  readonly body: Buffer;
  readonly encoding: RequestDictionaryEncoding;
  readonly fallback?: EncodedRequest;
}

/** Configuration for the node-local Portway dictionary transport. */
export interface RequestDictionaryTransportOptions {
  readonly dictionary?: boolean;
  readonly maxMemoryBytes?: number;
  readonly maxScopeMemoryBytes?: number;
  readonly maxEntriesPerScope?: number;
  readonly maxDictionaryBytes?: number;
  readonly maxBodyBytes?: number;
  readonly maxEncodedBytes?: number;
  readonly ttlMs?: number;
}

/** Encodes full request bytes as bounded native zstd or RFC9842 DCZ on fetch. */
export class RequestDictionaryTransport {
  private readonly _dictionaryEnabled: boolean;
  private readonly _maxMemoryBytes: number;
  private readonly _maxScopeMemoryBytes: number;
  private readonly _maxEntriesPerScope: number;
  private readonly _maxDictionaryBytes: number;
  private readonly _maxBodyBytes: number;
  private readonly _maxEncodedBytes: number;
  private readonly _ttlMs: number;
  private readonly _budget: DictionaryProcessBudget;
  private readonly _entries = new Map<string, Map<string, DictionaryEntry>>();
  private _memoryBytes = 0;

  constructor(options: RequestDictionaryTransportOptions = {}) {
    this._dictionaryEnabled = options.dictionary ?? false;
    this._maxMemoryBytes = finiteLimit(options.maxMemoryBytes, DEFAULT_MAX_MEMORY_BYTES, 0);
    this._maxScopeMemoryBytes = finiteLimit(
      options.maxScopeMemoryBytes,
      DEFAULT_MAX_SCOPE_MEMORY_BYTES,
      0,
    );
    this._maxEntriesPerScope = finiteLimit(
      options.maxEntriesPerScope,
      DEFAULT_MAX_ENTRIES_PER_SCOPE,
      0,
    );
    this._maxDictionaryBytes = finiteLimit(
      options.maxDictionaryBytes,
      DEFAULT_MAX_DICTIONARY_BYTES,
      0,
    );
    this._maxBodyBytes = finiteLimit(options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES, 0);
    this._maxEncodedBytes = finiteLimit(
      options.maxEncodedBytes,
      DEFAULT_MAX_ENCODED_BYTES,
      0,
    );
    this._ttlMs = finiteLimit(options.ttlMs, DEFAULT_TTL_MS, 0);
    this._budget = processDictionaryBudget;
  }

  /** Bytes this transport still retains. The count is not dictionary content. */
  retainedBytes(): number {
    return this._memoryBytes;
  }

  async fetch(
    fetchImpl: typeof fetch,
    input: Parameters<typeof fetch>[0],
    init: RequestInit = {},
    bytes: Buffer,
  ): Promise<Response> {
    const request = new Request(input, init);
    const signal = request.signal;
    signal.throwIfAborted();
    const body = Buffer.from(bytes);
    const bodyHash = sha256(body);
    const now = Date.now();
    const scopeKey = requestScopeKey(request);
    this.prune(now);
    const encoded = await this._encode(body, scopeKey, signal);
    signal.throwIfAborted();
    const baseHeaders = new Headers(request.headers);
    const attempts: EncodedRequest[] = [encoded];
    if (encoded.fallback !== undefined) {
      attempts.push(encoded.fallback, { body, encoding: 'identity' });
    } else if (encoded.encoding === 'zstd') {
      attempts.push({ body, encoding: 'identity' });
    }
    let attempt = 0;
    while (attempt < attempts.length) {
      const current = attempts[attempt]!;
      signal.throwIfAborted();
      const headers = requestHeaders(baseHeaders, current.encoding, this._dictionaryEnabled, current.body);
      const storeRequested = headers.get('x-dict-store') === '1';
      const response = await fetchImpl(input, { ...init, headers, body: bodyInitBytes(current.body) });
      const marked = isMarkedDecoderRejection(response);
      if (marked && current.encoding === 'dcz') {
        await releaseDecoderResponse(response);
        attempt += 1;
        continue;
      }
      if (marked && current.encoding === 'zstd' && response.status === 415) {
        await releaseDecoderResponse(response);
        attempt += 1;
        continue;
      }
      if (!marked) this.acknowledge(response, storeRequested, body, bodyHash, scopeKey, Date.now());
      return response;
    }
    throw new Error('Request dictionary retry state exhausted');
  }

  private async _encode(
    body: Buffer,
    scopeKey: string,
    signal: AbortSignal,
  ): Promise<EncodedRequest> {
    if (body.length === 0 || body.length > this._maxBodyBytes) {
      return { body, encoding: 'identity' };
    }
    const plain = await this._zstd(body, undefined, signal);
    const plainRequest: EncodedRequest = { body: plain, encoding: 'zstd' };
    let selected: EncodedRequest = plain.length < body.length && plain.length <= this._maxEncodedBytes
      ? plainRequest
      : { body, encoding: 'identity' };
    if (!this._dictionaryEnabled) return selected;
    const dictionary = this._lookup(scopeKey, Date.now());
    if (dictionary === undefined || dictionary.bytes.length > this._maxDictionaryBytes) return selected;
    const frame = await this._zstd(body, dictionary.bytes, signal);
    const dcz = Buffer.concat([DCZ_MAGIC, Buffer.from(dictionary.hash, 'hex'), frame]);
    if (dcz.length < body.length && dcz.length <= this._maxEncodedBytes && dcz.length < selected.body.length) {
      selected = { body: dcz, encoding: 'dcz', fallback: plainRequest };
    }
    return selected;
  }

  private _zstd(body: Buffer, dictionary: Buffer | undefined, signal: AbortSignal): Promise<Buffer> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = (): void => {
        finish(() => {
          reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
        });
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        zstdCompress(body, { dictionary, params: ZSTD_PARAMS }, (error, result) => {
          finish(() => {
            if (error !== null) reject(error);
            else if (signal.aborted) reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
            else resolve(Buffer.from(result));
          });
        });
      } catch (error) {
        finish(() => {
          reject(error);
        });
      }
    });
  }

  private _lookup(scopeKey: string, now: number): DictionaryEntry | undefined {
    const entries = this._entries.get(scopeKey);
    if (entries === undefined) return undefined;
    let selected: DictionaryEntry | undefined;
    for (const entry of [...entries.values()]) {
      if (now - entry.storedAt >= this._ttlMs) {
        this.drop(scopeKey, entry);
        continue;
      }
      if (selected === undefined || entry.storedOrder > selected.storedOrder) selected = entry;
    }
    if (selected !== undefined) this.touch(selected, now);
    return selected;
  }

  private acknowledge(
    response: Response,
    storeRequested: boolean,
    body: Buffer,
    bodyHash: string,
    scopeKey: string,
    now: number,
  ): void {
    if (!storeRequested || this._maxDictionaryBytes === 0 || this._maxEntriesPerScope === 0) return;
    const acknowledged = response.headers.get('x-dict-stored');
    if (acknowledged !== bodyHash || !/^[0-9a-f]{64}$/u.test(acknowledged)) return;
    if (
      body.length > this._maxDictionaryBytes ||
      body.length > this._maxScopeMemoryBytes ||
      body.length > this._maxMemoryBytes ||
      body.length > this._budget.maxBytes
    ) return;
    const entries = this._entries.get(scopeKey) ?? new Map<string, DictionaryEntry>();
    const existing = entries.get(bodyHash);
    if (existing !== undefined) {
      const order = this._budget.takeOrder();
      existing.storedAt = now;
      existing.storedOrder = order;
      existing.touchedAt = now;
      existing.touchedOrder = order;
      existing.resident.touchedOrder = order;
      this.arm(scopeKey, existing);
      return;
    }
    while (entries.size >= this._maxEntriesPerScope || scopeMemory(entries) + body.length > this._maxScopeMemoryBytes) {
      const oldest = oldestEntry(entries);
      if (oldest === undefined) break;
      this.drop(scopeKey, oldest);
    }
    while (this._memoryBytes + body.length > this._maxMemoryBytes) {
      const oldest = this.oldestInstanceEntry();
      if (oldest === undefined) break;
      this.drop(oldest.scopeKey, oldest.entry);
    }
    if (
      entries.size >= this._maxEntriesPerScope ||
      scopeMemory(entries) + body.length > this._maxScopeMemoryBytes ||
      this._memoryBytes + body.length > this._maxMemoryBytes
    ) {
      if (entries.size === 0) this._entries.delete(scopeKey);
      return;
    }
    const order = this._budget.takeOrder();
    const entry = this.createEntry(body, bodyHash, scopeKey, now, order);
    entries.set(bodyHash, entry);
    this._entries.set(scopeKey, entries);
    this._memoryBytes += entry.bytes.length;
    if (!this._budget.retain(entry.resident)) {
      this.unlink(scopeKey, entry);
      return;
    }
    this.arm(scopeKey, entry);
  }

  private createEntry(body: Buffer, bodyHash: string, scopeKey: string, now: number, order: number): DictionaryEntry {
    const bytes = Buffer.from(body);
    const linked: { entry?: DictionaryEntry } = {};
    const resident: BudgetResident = {
      size: bytes.length,
      touchedOrder: order,
      drop: () => {
        const entry = linked.entry;
        if (entry !== undefined) this.drop(scopeKey, entry);
      },
    };
    const entry: DictionaryEntry = {
      bytes,
      hash: bodyHash,
      resident,
      storedAt: now,
      storedOrder: order,
      touchedAt: now,
      touchedOrder: order,
      generation: 0,
    };
    linked.entry = entry;
    return entry;
  }

  private touch(entry: DictionaryEntry, now: number): void {
    const order = this._budget.takeOrder();
    entry.touchedAt = now;
    entry.touchedOrder = order;
    entry.resident.touchedOrder = order;
  }

  private arm(scopeKey: string, entry: DictionaryEntry): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    const generation = entry.generation + 1;
    entry.generation = generation;
    const timer = setTimeout(() => {
      if (entry.generation !== generation) return;
      this.drop(scopeKey, entry);
    }, this._ttlMs);
    const nodeTimer = timer as { unref?: () => void };
    nodeTimer.unref?.();
    entry.timer = timer;
  }

  private unlink(scopeKey: string, entry: DictionaryEntry): void {
    const entries = this._entries.get(scopeKey);
    if (entries?.get(entry.hash) !== entry) return;
    entries.delete(entry.hash);
    if (entries.size === 0) this._entries.delete(scopeKey);
    this._memoryBytes -= entry.bytes.length;
    entry.generation += 1;
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }

  private drop(scopeKey: string, entry: DictionaryEntry): void {
    const entries = this._entries.get(scopeKey);
    if (entries?.get(entry.hash) !== entry) return;
    this.unlink(scopeKey, entry);
    this._budget.release(entry.resident);
  }

  private prune(now: number): void {
    for (const [scopeKey, entries] of this._entries) {
      for (const entry of [...entries.values()]) {
        if (now - entry.storedAt >= this._ttlMs) this.drop(scopeKey, entry);
      }
    }
  }

  private oldestInstanceEntry(): { scopeKey: string; entry: DictionaryEntry } | undefined {
    let selected: { scopeKey: string; entry: DictionaryEntry } | undefined;
    for (const [scopeKey, entries] of this._entries) {
      for (const entry of entries.values()) {
        if (selected === undefined || entry.touchedOrder < selected.entry.touchedOrder) {
          selected = { scopeKey, entry };
        }
      }
    }
    return selected;
  }
}

function finiteLimit(value: number | undefined, fallback: number, minimum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum) throw new RangeError('Request dictionary limits must be safe non-negative integers');
  return resolved;
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Exact request bytes as a DOM BodyInit. A pooled Buffer contributes only its own range. */
export function bodyInitBytes(bytes: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  const buffer = bytes.buffer;
  if (buffer instanceof ArrayBuffer) {
    return new Uint8Array(buffer, bytes.byteOffset, bytes.byteLength);
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function requestHeaders(
  base: Headers,
  encoding: RequestDictionaryEncoding,
  dictionaryEnabled: boolean,
  body: Buffer,
): Headers {
  const headers = new Headers(base);
  headers.delete('content-encoding');
  headers.delete('content-length');
  headers.delete('x-dict-store');
  headers.set('content-length', String(body.length));
  if (encoding !== 'identity') {
    headers.set('content-encoding', encoding);
    if (dictionaryEnabled) headers.set('x-dict-store', '1');
  }
  return headers;
}

function isMarkedDecoderRejection(response: Response): boolean {
  if (!DECODER_ERROR_STATUSES.has(response.status) || response.headers.get('x-portway-decode-error')?.trim() !== '1') return false;
  return response.status !== 412 || response.headers.get('x-dict-miss')?.trim() === '1';
}

async function releaseDecoderResponse(response: Response): Promise<void> {
  const body = response.body;
  if (body === null) return;
  try {
    await body.cancel();
  } catch (cancelError) {
    try {
      await response.arrayBuffer();
    } catch {
      throw cancelError;
    }
  }
}

function requestScopeKey(request: Request): string {
  const headers: string[] = [];
  request.headers.forEach((value, name) => {
    if (SCOPE_IGNORED_HEADERS.has(name)) return;
    headers.push(`${name}\u0000${value}`);
  });
  headers.sort();
  return sha256(Buffer.from(`${request.method}\u0000${request.url}\u0000${headers.join('\u0001')}`, 'utf8'));
}

function scopeMemory(entries: Map<string, DictionaryEntry>): number {
  let total = 0;
  for (const entry of entries.values()) total += entry.bytes.length;
  return total;
}

function oldestEntry(entries: Map<string, DictionaryEntry>): DictionaryEntry | undefined {
  let oldest: DictionaryEntry | undefined;
  for (const entry of entries.values()) {
    if (oldest === undefined || entry.touchedOrder < oldest.touchedOrder) oldest = entry;
  }
  return oldest;
}
