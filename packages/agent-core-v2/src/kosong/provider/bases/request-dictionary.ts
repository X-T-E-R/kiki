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

interface DictionaryEntry {
  readonly bytes: Buffer;
  readonly hash: string;
  storedAt: number;
  storedOrder: number;
  touchedAt: number;
  touchedOrder: number;
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
  private readonly _entries = new Map<string, Map<string, DictionaryEntry>>();
  private _memoryBytes = 0;
  private _order = 0;

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
      const response = await fetchImpl(input, { ...init, headers, body: current.body });
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
    for (const [hash, entry] of entries) {
      if (now - entry.storedAt >= this._ttlMs) {
        entries.delete(hash);
        this._memoryBytes -= entry.bytes.length;
        continue;
      }
      if (selected === undefined || entry.storedOrder > selected.storedOrder) selected = entry;
    }
    if (entries.size === 0) {
      this._entries.delete(scopeKey);
      return undefined;
    }
    if (selected !== undefined) {
      selected.touchedAt = now;
      selected.touchedOrder = ++this._order;
    }
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
    if (body.length > this._maxDictionaryBytes || body.length > this._maxScopeMemoryBytes || body.length > this._maxMemoryBytes) return;
    const entries = this._entries.get(scopeKey) ?? new Map<string, DictionaryEntry>();
    const existing = entries.get(bodyHash);
    if (existing !== undefined) {
      existing.storedAt = now;
      existing.storedOrder = ++this._order;
      existing.touchedAt = now;
      existing.touchedOrder = existing.storedOrder;
      if (!this._entries.has(scopeKey)) this._entries.set(scopeKey, entries);
      return;
    }
    while (entries.size >= this._maxEntriesPerScope || scopeMemory(entries) + body.length > this._maxScopeMemoryBytes) {
      const oldest = oldestEntry(entries);
      if (oldest === undefined) break;
      entries.delete(oldest.hash);
      this._memoryBytes -= oldest.bytes.length;
    }
    while (this._memoryBytes + body.length > this._maxMemoryBytes) {
      const oldest = this.oldestGlobalEntry();
      if (oldest === undefined) break;
      const [oldestScope, oldestHash, oldestEntryValue] = oldest;
      const oldestEntries = this._entries.get(oldestScope)!;
      oldestEntries.delete(oldestHash);
      this._memoryBytes -= oldestEntryValue.bytes.length;
      if (oldestEntries.size === 0) this._entries.delete(oldestScope);
    }
    if (entries.size >= this._maxEntriesPerScope || scopeMemory(entries) + body.length > this._maxScopeMemoryBytes || this._memoryBytes + body.length > this._maxMemoryBytes) {
      if (entries.size === 0) this._entries.delete(scopeKey);
      return;
    }
    const order = ++this._order;
    const entry: DictionaryEntry = {
      bytes: Buffer.from(body),
      hash: bodyHash,
      storedAt: now,
      storedOrder: order,
      touchedAt: now,
      touchedOrder: order,
    };
    entries.set(bodyHash, entry);
    this._entries.set(scopeKey, entries);
    this._memoryBytes += entry.bytes.length;
  }

  private prune(now: number): void {
    for (const [scopeKey, entries] of this._entries) {
      for (const [hash, entry] of entries) {
        if (now - entry.storedAt >= this._ttlMs) {
          entries.delete(hash);
          this._memoryBytes -= entry.bytes.length;
        }
      }
      if (entries.size === 0) this._entries.delete(scopeKey);
    }
  }

  private oldestGlobalEntry(): [string, string, DictionaryEntry] | undefined {
    let oldest: [string, string, DictionaryEntry] | undefined;
    for (const [scopeKey, entries] of this._entries) {
      for (const [hash, entry] of entries) {
        if (oldest === undefined || entry.touchedOrder < oldest[2].touchedOrder) oldest = [scopeKey, hash, entry];
      }
    }
    return oldest;
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
