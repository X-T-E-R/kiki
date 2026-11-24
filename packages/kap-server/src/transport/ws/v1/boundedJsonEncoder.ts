const MAX_JSON_ENCODE_DEPTH = 512;
const MAX_STREAM_JSON_DEPTH = 1024;
const MAX_CAPTURED_KEY_BYTES = 64;
const MAX_CAPTURED_SCALAR_BYTES = 512;
const REUSABLE_SCRATCH_BYTES = 256 * 1024;

/** Maximum encoded UTF-8 byte length of one journal line, including trailing LF. */
export const MAX_SINGLE_JOURNAL_LINE_BYTES = 256 * 1024;

const reusableScratch = new Uint8Array(REUSABLE_SCRATCH_BYTES);
const HEX_DIGITS = new Uint8Array([
  0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37,
  0x38, 0x39, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66,
]);

/** Result of encoding a JSON value or JSONL line under a strict UTF-8 byte cap. */
export type BoundedJsonEncodeResult =
  | { readonly ok: true; readonly buffer: Buffer; readonly bytes: number }
  | { readonly ok: false; readonly reason: 'exceeded'; readonly omittedBytesAtLeast: number }
  | { readonly ok: false; readonly reason: 'invalid'; readonly error: unknown };

class BudgetExceededSignal {
  constructor(readonly omittedBytesAtLeast: number) {}
}

class BoundedUtf8JsonWriter {
  private buf: Uint8Array;
  private offset = 0;
  private readonly maxBytes: number;
  private readonly dynamic: boolean;
  private readonly seen = new Set<object>();

  constructor(maxBytes: number, dynamic: boolean) {
    this.maxBytes = maxBytes;
    this.dynamic = dynamic;
    if (!dynamic && maxBytes <= reusableScratch.byteLength) {
      this.buf = reusableScratch;
    } else {
      const initial = Math.min(Math.max(4096, 64), Math.max(64, maxBytes));
      this.buf = new Uint8Array(initial);
    }
  }

  private ensure(extra: number): void {
    const needed = this.offset + extra;
    if (needed > this.maxBytes) {
      throw new BudgetExceededSignal(needed);
    }
    if (needed <= this.buf.byteLength) return;
    if (!this.dynamic) {
      throw new BudgetExceededSignal(needed);
    }
    let nextSize = this.buf.byteLength;
    while (nextSize < needed) {
      nextSize = Math.min(this.maxBytes, nextSize * 2);
    }
    const grown = new Uint8Array(nextSize);
    grown.set(this.buf.subarray(0, this.offset), 0);
    this.buf = grown;
  }

  private writeByte(b: number): void {
    this.ensure(1);
    this.buf[this.offset++] = b;
  }

  private writeAscii(text: string): void {
    const len = text.length;
    this.ensure(len);
    for (let i = 0; i < len; i += 1) {
      this.buf[this.offset++] = text.charCodeAt(i);
    }
  }

  private writeHex4(code: number): void {
    this.ensure(6);
    this.buf[this.offset++] = 0x5c;
    this.buf[this.offset++] = 0x75;
    this.buf[this.offset++] = HEX_DIGITS[(code >>> 12) & 0xf]!;
    this.buf[this.offset++] = HEX_DIGITS[(code >>> 8) & 0xf]!;
    this.buf[this.offset++] = HEX_DIGITS[(code >>> 4) & 0xf]!;
    this.buf[this.offset++] = HEX_DIGITS[code & 0xf]!;
  }

  private writeString(str: string): void {
    const len = str.length;
    if (this.offset + len + 2 > this.maxBytes) {
      throw new BudgetExceededSignal(this.offset + len + 2);
    }
    this.writeByte(0x22);
    for (let i = 0; i < len; i += 1) {
      const code = str.charCodeAt(i);
      if (code >= 0x20 && code <= 0x7e) {
        if (code === 0x22) {
          this.ensure(2);
          this.buf[this.offset++] = 0x5c;
          this.buf[this.offset++] = 0x22;
        } else if (code === 0x5c) {
          this.ensure(2);
          this.buf[this.offset++] = 0x5c;
          this.buf[this.offset++] = 0x5c;
        } else {
          this.ensure(1);
          this.buf[this.offset++] = code;
        }
        continue;
      }
      if (code < 0x20) {
        switch (code) {
          case 0x08:
            this.ensure(2);
            this.buf[this.offset++] = 0x5c;
            this.buf[this.offset++] = 0x62;
            break;
          case 0x09:
            this.ensure(2);
            this.buf[this.offset++] = 0x5c;
            this.buf[this.offset++] = 0x74;
            break;
          case 0x0a:
            this.ensure(2);
            this.buf[this.offset++] = 0x5c;
            this.buf[this.offset++] = 0x6e;
            break;
          case 0x0c:
            this.ensure(2);
            this.buf[this.offset++] = 0x5c;
            this.buf[this.offset++] = 0x66;
            break;
          case 0x0d:
            this.ensure(2);
            this.buf[this.offset++] = 0x5c;
            this.buf[this.offset++] = 0x72;
            break;
          default:
            this.writeHex4(code);
            break;
        }
        continue;
      }
      if (code === 0x7f) {
        this.ensure(1);
        this.buf[this.offset++] = 0x7f;
        continue;
      }
      if (code <= 0x7ff) {
        this.ensure(2);
        this.buf[this.offset++] = 0xc0 | (code >>> 6);
        this.buf[this.offset++] = 0x80 | (code & 0x3f);
        continue;
      }
      if (code >= 0xd800 && code <= 0xdbff) {
        if (i + 1 < len) {
          const next = str.charCodeAt(i + 1);
          if (next >= 0xdc00 && next <= 0xdfff) {
            const cp = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
            this.ensure(4);
            this.buf[this.offset++] = 0xf0 | (cp >>> 18);
            this.buf[this.offset++] = 0x80 | ((cp >>> 12) & 0x3f);
            this.buf[this.offset++] = 0x80 | ((cp >>> 6) & 0x3f);
            this.buf[this.offset++] = 0x80 | (cp & 0x3f);
            i += 1;
            continue;
          }
        }
        this.writeHex4(code);
        continue;
      }
      if (code >= 0xdc00 && code <= 0xdfff) {
        this.writeHex4(code);
        continue;
      }
      this.ensure(3);
      this.buf[this.offset++] = 0xe0 | (code >>> 12);
      this.buf[this.offset++] = 0x80 | ((code >>> 6) & 0x3f);
      this.buf[this.offset++] = 0x80 | (code & 0x3f);
    }
    this.writeByte(0x22);
  }

  writeValue(rawValue: unknown, key: string, depth: number): boolean {
    if (depth > MAX_JSON_ENCODE_DEPTH) {
      throw new RangeError('JSON encoding exceeded maximum nesting depth');
    }
    let value = rawValue;
    if (typeof value === 'object' && value !== null) {
      if (Buffer.isBuffer(value)) {
        const lowerBound = 25 + value.byteLength * 2;
        if (this.offset + lowerBound > this.maxBytes) {
          throw new BudgetExceededSignal(this.offset + lowerBound);
        }
      } else if (ArrayBuffer.isView(value)) {
        const lowerBound = value.byteLength * 5;
        if (this.offset + lowerBound > this.maxBytes) {
          throw new BudgetExceededSignal(this.offset + lowerBound);
        }
      }
      const maybeToJson = (value as { toJSON?: unknown }).toJSON;
      if (typeof maybeToJson === 'function') {
        value = (maybeToJson as (k: string) => unknown).call(value, key);
      }
    }
    if (value instanceof Number) value = value.valueOf();
    else if (value instanceof String) value = value.valueOf();
    else if (value instanceof Boolean) value = value.valueOf();

    if (value === null) {
      this.writeAscii('null');
      return true;
    }
    const kind = typeof value;
    if (kind === 'string') {
      this.writeString(value as string);
      return true;
    }
    if (kind === 'number') {
      const n = value as number;
      this.writeAscii(Number.isFinite(n) ? String(n) : 'null');
      return true;
    }
    if (kind === 'boolean') {
      this.writeAscii(value ? 'true' : 'false');
      return true;
    }
    if (kind === 'bigint') {
      throw new TypeError('Do not know how to serialize a BigInt');
    }
    if (kind === 'undefined' || kind === 'function' || kind === 'symbol') {
      return false;
    }

    const obj = value as object;
    if (this.seen.has(obj)) {
      throw new TypeError('Converting circular structure to JSON');
    }
    this.seen.add(obj);
    try {
      if (Array.isArray(obj)) {
        const arrLen = obj.length;
        if (arrLen > 0) {
          const lowerBound = arrLen * 2 + 1;
          if (this.offset + lowerBound > this.maxBytes) {
            throw new BudgetExceededSignal(this.offset + lowerBound);
          }
        }
        this.writeByte(0x5b);
        for (let i = 0; i < arrLen; i += 1) {
          if (i > 0) this.writeByte(0x2c);
          if (!this.writeValue(obj[i], String(i), depth + 1)) {
            this.writeAscii('null');
          }
        }
        this.writeByte(0x5d);
        return true;
      }

      this.writeByte(0x7b);
      let first = true;
      const record = obj as Record<string, unknown>;
      for (const prop in record) {
        if (!Object.hasOwn(record, prop)) continue;
        const propVal = record[prop];
        if (propVal === undefined || typeof propVal === 'function' || typeof propVal === 'symbol') {
          continue;
        }
        const savedOffset = this.offset;
        if (!first) this.writeByte(0x2c);
        this.writeString(prop);
        this.writeByte(0x3a);
        const wrote = this.writeValue(propVal, prop, depth + 1);
        if (!wrote) {
          this.offset = savedOffset;
        } else {
          first = false;
        }
      }
      this.writeByte(0x7d);
      return true;
    } finally {
      this.seen.delete(obj);
    }
  }

  finish(appendLf: boolean): Buffer {
    const outLen = this.offset + (appendLf ? 1 : 0);
    const out = Buffer.allocUnsafe(outLen);
    out.set(this.buf.subarray(0, this.offset), 0);
    if (appendLf) out[this.offset] = 0x0a;
    return out;
  }
}

/**
 * Encode one JSONL record as UTF-8 bytes including trailing LF under a strict
 * byte ceiling without allocating full intermediate strings for oversized values.
 */
export function encodeJsonLineBounded(
  value: unknown,
  maxBytesWithLf: number,
): BoundedJsonEncodeResult {
  if (maxBytesWithLf < 2) {
    return { ok: false, reason: 'exceeded', omittedBytesAtLeast: 3 };
  }
  const writer = new BoundedUtf8JsonWriter(maxBytesWithLf - 1, false);
  try {
    const wrote = writer.writeValue(value, '', 0);
    if (!wrote) {
      return { ok: false, reason: 'invalid', error: new TypeError('Top-level value is not JSON-serializable') };
    }
    const out = writer.finish(true);
    return { ok: true, buffer: out, bytes: out.byteLength };
  } catch (error) {
    if (error instanceof BudgetExceededSignal) {
      return { ok: false, reason: 'exceeded', omittedBytesAtLeast: error.omittedBytesAtLeast + 1 };
    }
    return { ok: false, reason: 'invalid', error };
  }
}

/**
 * Encode one JSON value as UTF-8 bytes without trailing LF under a strict
 * byte ceiling (supports dynamic growth up to `maxBytes` for outbound frames).
 */
export function encodeJsonValueBounded(
  value: unknown,
  maxBytes: number,
): BoundedJsonEncodeResult {
  if (maxBytes < 1) {
    return { ok: false, reason: 'exceeded', omittedBytesAtLeast: 1 };
  }
  const writer = new BoundedUtf8JsonWriter(maxBytes, maxBytes > REUSABLE_SCRATCH_BYTES);
  try {
    const wrote = writer.writeValue(value, '', 0);
    if (!wrote) {
      return { ok: false, reason: 'invalid', error: new TypeError('Top-level value is not JSON-serializable') };
    }
    const buffer = writer.finish(false);
    return { ok: true, buffer, bytes: buffer.byteLength };
  } catch (error) {
    if (error instanceof BudgetExceededSignal) {
      return { ok: false, reason: 'exceeded', omittedBytesAtLeast: error.omittedBytesAtLeast };
    }
    return { ok: false, reason: 'invalid', error };
  }
}

/**
 * Return a conservative lower-bound UTF-8 JSON byte length for an arbitrary value
 * without allocating serialized strings; stops as soon as `limitBytes` is exceeded.
 */
export function estimateJsonByteLengthBounded(value: unknown, limitBytes: number): number {
  const res = encodeJsonValueBounded(value, limitBytes);
  if (res.ok) return res.bytes;
  if (res.reason === 'exceeded') return res.omittedBytesAtLeast;
  return Number.POSITIVE_INFINITY;
}

/** Extracted top-level metadata from a validated streaming JSON journal line. */
export interface StreamingParsedJournalLine {
  readonly kind?: string;
  readonly version?: number;
  readonly epoch?: string;
  readonly created_at?: number;
  readonly last_seq?: number;
  readonly seq?: number;
  readonly from_seq?: number;
  readonly attention_seq?: number;
  readonly event_type?: string;
  readonly agent_id?: string | null;
  readonly has_agent_id?: boolean;
  readonly routing_known?: boolean;
  readonly omitted_bytes_at_least?: number;
  readonly reason?: string;
  readonly session_id?: string;
  readonly roster_hint?: {
    type?: string;
    agentId?: string;
    subagentId?: string;
    infoKind?: string;
    infoAgentId?: string;
  };
  readonly envelope?: {
    type?: string;
    seq?: number;
    epoch?: string;
    session_id?: string;
    payloadKind?: 'object' | 'other';
    payloadAgentId?: string;
    payloadHasNonStringAgentId?: boolean;
    payloadAgentIdOverflowed?: boolean;
    payloadSubagentId?: string;
    payloadInfoKind?: string;
    payloadInfoAgentId?: string;
  };
}

const enum ParserState {
  Value = 0,
  ObjectKeyOrEnd = 1,
  ObjectKey = 2,
  ObjectColon = 3,
  ObjectCommaOrEnd = 4,
  ArrayValueOrEnd = 5,
  ArrayCommaOrEnd = 6,
  String = 7,
  StringEscape = 8,
  StringUnicode = 9,
  Number = 10,
  Literal = 11,
  Done = 12,
  Error = 13,
}

const enum ContainerKind {
  Object = 0,
  Array = 1,
}

const enum CaptureSlot {
  None = 0,
  RootKind = 1,
  RootVersion = 2,
  RootEpoch = 3,
  RootCreatedAt = 4,
  RootLastSeq = 5,
  RootSeq = 6,
  RootFromSeq = 7,
  RootAttentionSeq = 8,
  RootEventType = 9,
  RootAgentId = 10,
  RootRoutingKnown = 11,
  RootOmittedBytes = 12,
  RootReason = 13,
  RootSessionId = 14,
  EnvType = 15,
  EnvSeq = 16,
  EnvEpoch = 17,
  EnvSessionId = 18,
  PayloadAgentId = 19,
  PayloadSubagentId = 20,
  PayloadInfoKind = 21,
  PayloadInfoAgentId = 22,
  RosterType = 23,
  RosterAgentId = 24,
  RosterSubagentId = 25,
  RosterInfoKind = 26,
  RosterInfoAgentId = 27,
  EnvObject = 28,
  PayloadObject = 29,
  PayloadInfoObject = 30,
  RosterHintObject = 31,
}

const enum ScopeTag {
  Other = 0,
  Root = 1,
  Envelope = 2,
  Payload = 3,
  PayloadInfo = 4,
  RosterHint = 5,
}

const LITERAL_TRUE = [0x74, 0x72, 0x75, 0x65];
const LITERAL_FALSE = [0x66, 0x61, 0x6c, 0x73, 0x65];
const LITERAL_NULL = [0x6e, 0x75, 0x6c, 0x6c];

/**
 * Bounded-memory RFC 8259 streaming JSON validator and top-level journal metadata
 * extractor. Processes arbitrarily large lines in small chunks without allocating
 * full line strings or buffers.
 */
export class StreamingJournalLineParser {
  private state: ParserState = ParserState.Value;
  private readonly stack = new Uint8Array(MAX_STREAM_JSON_DEPTH);
  private readonly scopeStack = new Uint8Array(MAX_STREAM_JSON_DEPTH);
  private depth = 0;

  private activeSlot: CaptureSlot = CaptureSlot.None;
  private isCapturingKey = false;
  private captureBuf = new Uint8Array(MAX_CAPTURED_SCALAR_BYTES + 2);
  private captureLen = 0;
  private captureOverflow = false;

  private unicodeDigitsLeft = 0;
  private utf8Remaining = 0;
  private utf8CodePoint = 0;
  private utf8MinCodePoint = 0;

  private literalExpected: readonly number[] = LITERAL_NULL;
  private literalIndex = 0;
  private literalValue: boolean | null = null;

  private numStage = 0;
  private numBuf = new Uint8Array(64);
  private numLen = 0;
  private numOverflow = false;

  private rootIsObject = false;
  private readonly meta: {
    kind?: string;
    version?: number;
    epoch?: string;
    created_at?: number;
    last_seq?: number;
    seq?: number;
    from_seq?: number;
    attention_seq?: number;
    event_type?: string;
    agent_id?: string | null;
    has_agent_id?: boolean;
    routing_known?: boolean;
    omitted_bytes_at_least?: number;
    reason?: string;
    session_id?: string;
    roster_hint?: {
      type?: string;
      agentId?: string;
      subagentId?: string;
      infoKind?: string;
      infoAgentId?: string;
    };
    envelope?: {
      type?: string;
      seq?: number;
      epoch?: string;
      session_id?: string;
      payloadKind?: 'object' | 'other';
      payloadAgentId?: string;
      payloadHasNonStringAgentId?: boolean;
      payloadAgentIdOverflowed?: boolean;
      payloadSubagentId?: string;
      payloadInfoKind?: string;
      payloadInfoAgentId?: string;
    };
  } = {};

  feed(chunk: Uint8Array): boolean {
    if (this.state === ParserState.Error) return false;
    const len = chunk.byteLength;
    let i = 0;
    while (i < len) {
      if (this.state === ParserState.String && this.captureOverflow && this.utf8Remaining === 0) {
        while (i < len) {
          const b = chunk[i]!;
          if (b >= 0x20 && b < 0x80 && b !== 0x22 && b !== 0x5c) {
            i += 1;
            continue;
          }
          break;
        }
        if (i >= len) break;
      }
      const b = chunk[i]!;
      i += 1;
      if (!this.stepByte(b)) {
        this.state = ParserState.Error;
        return false;
      }
    }
    return true;
  }

  finish(): StreamingParsedJournalLine | undefined {
    if (this.state === ParserState.Number) {
      if (!this.finishNumber()) {
        this.state = ParserState.Error;
        return undefined;
      }
    }
    if (this.state !== ParserState.Done || !this.rootIsObject || this.depth !== 0) {
      return undefined;
    }
    return this.meta;
  }

  private isWhitespace(b: number): boolean {
    return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
  }

  private currentScope(): ScopeTag {
    return this.depth === 0 ? ScopeTag.Other : (this.scopeStack[this.depth - 1] as ScopeTag);
  }

  private resolveKeySlot(scope: ScopeTag, key: string): CaptureSlot {
    switch (scope) {
      case ScopeTag.Root:
        switch (key) {
          case 'kind': return CaptureSlot.RootKind;
          case 'version': return CaptureSlot.RootVersion;
          case 'epoch': return CaptureSlot.RootEpoch;
          case 'created_at': return CaptureSlot.RootCreatedAt;
          case 'last_seq': return CaptureSlot.RootLastSeq;
          case 'seq': return CaptureSlot.RootSeq;
          case 'from_seq': return CaptureSlot.RootFromSeq;
          case 'attention_seq': return CaptureSlot.RootAttentionSeq;
          case 'event_type': return CaptureSlot.RootEventType;
          case 'agent_id': return CaptureSlot.RootAgentId;
          case 'routing_known': return CaptureSlot.RootRoutingKnown;
          case 'omitted_bytes_at_least': return CaptureSlot.RootOmittedBytes;
          case 'reason': return CaptureSlot.RootReason;
          case 'session_id': return CaptureSlot.RootSessionId;
          case 'envelope': return CaptureSlot.EnvObject;
          case 'roster_hint': return CaptureSlot.RosterHintObject;
          default: return CaptureSlot.None;
        }
      case ScopeTag.Envelope:
        switch (key) {
          case 'type': return CaptureSlot.EnvType;
          case 'seq': return CaptureSlot.EnvSeq;
          case 'epoch': return CaptureSlot.EnvEpoch;
          case 'session_id': return CaptureSlot.EnvSessionId;
          case 'payload': return CaptureSlot.PayloadObject;
          default: return CaptureSlot.None;
        }
      case ScopeTag.Payload:
        switch (key) {
          case 'agentId': return CaptureSlot.PayloadAgentId;
          case 'subagentId': return CaptureSlot.PayloadSubagentId;
          case 'info': return CaptureSlot.PayloadInfoObject;
          default: return CaptureSlot.None;
        }
      case ScopeTag.PayloadInfo:
        switch (key) {
          case 'kind': return CaptureSlot.PayloadInfoKind;
          case 'agentId': return CaptureSlot.PayloadInfoAgentId;
          default: return CaptureSlot.None;
        }
      case ScopeTag.RosterHint:
        switch (key) {
          case 'type': return CaptureSlot.RosterType;
          case 'agentId': return CaptureSlot.RosterAgentId;
          case 'subagentId': return CaptureSlot.RosterSubagentId;
          case 'infoKind': return CaptureSlot.RosterInfoKind;
          case 'infoAgentId': return CaptureSlot.RosterInfoAgentId;
          default: return CaptureSlot.None;
        }
      default:
        return CaptureSlot.None;
    }
  }

  private stepByte(b: number): boolean {
    switch (this.state) {
      case ParserState.Value:
        if (this.isWhitespace(b)) return true;
        return this.startValue(b);

      case ParserState.ArrayValueOrEnd:
        if (this.isWhitespace(b)) return true;
        if (b === 0x5d) {
          return this.popContainer(ContainerKind.Array);
        }
        return this.startValue(b);

      case ParserState.ArrayCommaOrEnd:
        if (this.isWhitespace(b)) return true;
        if (b === 0x2c) {
          this.state = ParserState.Value;
          return true;
        }
        if (b === 0x5d) {
          return this.popContainer(ContainerKind.Array);
        }
        return false;

      case ParserState.ObjectKeyOrEnd:
        if (this.isWhitespace(b)) return true;
        if (b === 0x7d) {
          return this.popContainer(ContainerKind.Object);
        }
        if (b === 0x22) {
          this.beginString(true);
          return true;
        }
        return false;

      case ParserState.ObjectKey:
        if (this.isWhitespace(b)) return true;
        if (b === 0x22) {
          this.beginString(true);
          return true;
        }
        return false;

      case ParserState.ObjectColon:
        if (this.isWhitespace(b)) return true;
        if (b === 0x3a) {
          this.state = ParserState.Value;
          return true;
        }
        return false;

      case ParserState.ObjectCommaOrEnd:
        if (this.isWhitespace(b)) return true;
        if (b === 0x2c) {
          this.state = ParserState.ObjectKey;
          return true;
        }
        if (b === 0x7d) {
          return this.popContainer(ContainerKind.Object);
        }
        return false;

      case ParserState.String:
        return this.stepString(b);

      case ParserState.StringEscape:
        return this.stepStringEscape(b);

      case ParserState.StringUnicode:
        return this.stepStringUnicode(b);

      case ParserState.Number:
        return this.stepNumber(b);

      case ParserState.Literal:
        if (b !== this.literalExpected[this.literalIndex]) return false;
        this.literalIndex += 1;
        if (this.literalIndex === this.literalExpected.length) {
          this.recordScalar(this.literalValue);
          this.transitionAfterValue();
        }
        return true;

      case ParserState.Done:
        return this.isWhitespace(b);

      case ParserState.Error:
        return false;
    }
  }

  private startValue(b: number): boolean {
    if (b === 0x7b) {
      if (this.depth >= MAX_STREAM_JSON_DEPTH) return false;
      let nextScope = ScopeTag.Other;
      if (this.depth === 0) {
        this.rootIsObject = true;
        nextScope = ScopeTag.Root;
      } else if (this.activeSlot === CaptureSlot.EnvObject) {
        this.meta.envelope ??= {};
        nextScope = ScopeTag.Envelope;
      } else if (this.activeSlot === CaptureSlot.PayloadObject) {
        this.meta.envelope ??= {};
        this.meta.envelope.payloadKind = 'object';
        nextScope = ScopeTag.Payload;
      } else if (this.activeSlot === CaptureSlot.PayloadInfoObject) {
        nextScope = ScopeTag.PayloadInfo;
      } else if (this.activeSlot === CaptureSlot.RosterHintObject) {
        this.meta.roster_hint ??= {};
        nextScope = ScopeTag.RosterHint;
      } else if (this.activeSlot === CaptureSlot.PayloadAgentId) {
        this.meta.envelope ??= {};
        this.meta.envelope.payloadHasNonStringAgentId = true;
      }
      this.activeSlot = CaptureSlot.None;
      this.stack[this.depth] = ContainerKind.Object;
      this.scopeStack[this.depth] = nextScope;
      this.depth += 1;
      this.state = ParserState.ObjectKeyOrEnd;
      return true;
    }
    if (b === 0x5b) {
      if (this.depth === 0 || this.depth >= MAX_STREAM_JSON_DEPTH) return false;
      if (this.activeSlot === CaptureSlot.PayloadObject) {
        this.meta.envelope ??= {};
        this.meta.envelope.payloadKind = 'other';
      } else if (this.activeSlot === CaptureSlot.PayloadAgentId) {
        this.meta.envelope ??= {};
        this.meta.envelope.payloadHasNonStringAgentId = true;
      }
      this.activeSlot = CaptureSlot.None;
      this.stack[this.depth] = ContainerKind.Array;
      this.scopeStack[this.depth] = ScopeTag.Other;
      this.depth += 1;
      this.state = ParserState.ArrayValueOrEnd;
      return true;
    }
    if (b === 0x22) {
      if (this.depth === 0) return false;
      this.beginString(false);
      return true;
    }
    if (b === 0x2d || (b >= 0x30 && b <= 0x39)) {
      if (this.depth === 0) return false;
      this.numLen = 0;
      this.numOverflow = false;
      this.appendNumByte(b);
      this.numStage = b === 0x2d ? 0 : b === 0x30 ? 1 : 2;
      this.state = ParserState.Number;
      return true;
    }
    if (b === 0x74) {
      if (this.depth === 0) return false;
      this.literalExpected = LITERAL_TRUE;
      this.literalIndex = 1;
      this.literalValue = true;
      this.state = ParserState.Literal;
      return true;
    }
    if (b === 0x66) {
      if (this.depth === 0) return false;
      this.literalExpected = LITERAL_FALSE;
      this.literalIndex = 1;
      this.literalValue = false;
      this.state = ParserState.Literal;
      return true;
    }
    if (b === 0x6e) {
      if (this.depth === 0) return false;
      this.literalExpected = LITERAL_NULL;
      this.literalIndex = 1;
      this.literalValue = null;
      this.state = ParserState.Literal;
      return true;
    }
    return false;
  }

  private beginString(asKey: boolean): void {
    this.isCapturingKey = asKey;
    const shouldCapture = asKey
      ? this.currentScope() !== ScopeTag.Other
      : this.activeSlot !== CaptureSlot.None;
    this.captureLen = 0;
    this.captureOverflow = !shouldCapture;
    if (shouldCapture) {
      this.captureBuf[this.captureLen++] = 0x22;
    }
    this.utf8Remaining = 0;
    this.state = ParserState.String;
  }

  private pushCaptureByte(b: number): void {
    if (this.captureOverflow) return;
    const limit = this.isCapturingKey ? MAX_CAPTURED_KEY_BYTES + 1 : MAX_CAPTURED_SCALAR_BYTES + 1;
    if (this.captureLen >= limit) {
      this.captureOverflow = true;
      return;
    }
    this.captureBuf[this.captureLen++] = b;
  }

  private stepString(b: number): boolean {
    if (this.utf8Remaining > 0) {
      if ((b & 0xc0) !== 0x80) return false;
      this.utf8CodePoint = (this.utf8CodePoint << 6) | (b & 0x3f);
      this.utf8Remaining -= 1;
      if (this.utf8Remaining === 0) {
        if (
          this.utf8CodePoint < this.utf8MinCodePoint ||
          this.utf8CodePoint > 0x10ffff ||
          (this.utf8CodePoint >= 0xd800 && this.utf8CodePoint <= 0xdfff)
        ) {
          return false;
        }
      }
      this.pushCaptureByte(b);
      return true;
    }
    if (b === 0x22) {
      this.finishString();
      return true;
    }
    if (b === 0x5c) {
      this.pushCaptureByte(b);
      this.state = ParserState.StringEscape;
      return true;
    }
    if (b < 0x20) return false;
    if (b < 0x80) {
      this.pushCaptureByte(b);
      return true;
    }
    if (b >= 0xc2 && b <= 0xdf) {
      this.utf8Remaining = 1;
      this.utf8CodePoint = b & 0x1f;
      this.utf8MinCodePoint = 0x80;
      this.pushCaptureByte(b);
      return true;
    }
    if (b >= 0xe0 && b <= 0xef) {
      this.utf8Remaining = 2;
      this.utf8CodePoint = b & 0x0f;
      this.utf8MinCodePoint = 0x800;
      this.pushCaptureByte(b);
      return true;
    }
    if (b >= 0xf0 && b <= 0xf4) {
      this.utf8Remaining = 3;
      this.utf8CodePoint = b & 0x07;
      this.utf8MinCodePoint = 0x10000;
      this.pushCaptureByte(b);
      return true;
    }
    return false;
  }

  private stepStringEscape(b: number): boolean {
    if (
      b === 0x22 || b === 0x5c || b === 0x2f ||
      b === 0x62 || b === 0x66 || b === 0x6e || b === 0x72 || b === 0x74
    ) {
      this.pushCaptureByte(b);
      this.state = ParserState.String;
      return true;
    }
    if (b === 0x75) {
      this.pushCaptureByte(b);
      this.unicodeDigitsLeft = 4;
      this.state = ParserState.StringUnicode;
      return true;
    }
    return false;
  }

  private stepStringUnicode(b: number): boolean {
    const isHex =
      (b >= 0x30 && b <= 0x39) ||
      (b >= 0x41 && b <= 0x46) ||
      (b >= 0x61 && b <= 0x66);
    if (!isHex) return false;
    this.pushCaptureByte(b);
    this.unicodeDigitsLeft -= 1;
    if (this.unicodeDigitsLeft === 0) {
      this.state = ParserState.String;
    }
    return true;
  }

  private finishString(): void {
    let decoded: string | undefined;
    if (!this.captureOverflow) {
      this.captureBuf[this.captureLen++] = 0x22;
      try {
        decoded = JSON.parse(
          Buffer.from(this.captureBuf.buffer, this.captureBuf.byteOffset, this.captureLen).toString('utf8'),
        ) as string;
      } catch {
        decoded = undefined;
      }
    }
    if (this.isCapturingKey) {
      this.activeSlot = decoded !== undefined
        ? this.resolveKeySlot(this.currentScope(), decoded)
        : CaptureSlot.None;
      this.state = ParserState.ObjectColon;
      return;
    }
    if (decoded !== undefined) {
      this.recordScalar(decoded);
    } else if (this.activeSlot === CaptureSlot.PayloadObject) {
      this.meta.envelope ??= {};
      this.meta.envelope.payloadKind = 'other';
    } else if (this.activeSlot === CaptureSlot.PayloadAgentId) {
      this.meta.envelope ??= {};
      this.meta.envelope.payloadAgentIdOverflowed = true;
    }
    this.activeSlot = CaptureSlot.None;
    this.transitionAfterValue();
  }

  private appendNumByte(b: number): void {
    if (this.activeSlot === CaptureSlot.None || this.numOverflow) return;
    if (this.numLen >= this.numBuf.byteLength) {
      this.numOverflow = true;
      return;
    }
    this.numBuf[this.numLen++] = b;
  }

  private stepNumber(b: number): boolean {
    switch (this.numStage) {
      case 0:
        if (b === 0x30) {
          this.appendNumByte(b);
          this.numStage = 1;
          return true;
        }
        if (b >= 0x31 && b <= 0x39) {
          this.appendNumByte(b);
          this.numStage = 2;
          return true;
        }
        return false;
      case 1:
        if (b === 0x2e) {
          this.appendNumByte(b);
          this.numStage = 3;
          return true;
        }
        if (b === 0x65 || b === 0x45) {
          this.appendNumByte(b);
          this.numStage = 5;
          return true;
        }
        break;
      case 2:
        if (b >= 0x30 && b <= 0x39) {
          this.appendNumByte(b);
          return true;
        }
        if (b === 0x2e) {
          this.appendNumByte(b);
          this.numStage = 3;
          return true;
        }
        if (b === 0x65 || b === 0x45) {
          this.appendNumByte(b);
          this.numStage = 5;
          return true;
        }
        break;
      case 3:
        if (b >= 0x30 && b <= 0x39) {
          this.appendNumByte(b);
          this.numStage = 4;
          return true;
        }
        return false;
      case 4:
        if (b >= 0x30 && b <= 0x39) {
          this.appendNumByte(b);
          return true;
        }
        if (b === 0x65 || b === 0x45) {
          this.appendNumByte(b);
          this.numStage = 5;
          return true;
        }
        break;
      case 5:
        if (b === 0x2b || b === 0x2d) {
          this.appendNumByte(b);
          this.numStage = 6;
          return true;
        }
        if (b >= 0x30 && b <= 0x39) {
          this.appendNumByte(b);
          this.numStage = 7;
          return true;
        }
        return false;
      case 6:
        if (b >= 0x30 && b <= 0x39) {
          this.appendNumByte(b);
          this.numStage = 7;
          return true;
        }
        return false;
      case 7:
        if (b >= 0x30 && b <= 0x39) {
          this.appendNumByte(b);
          return true;
        }
        break;
    }
    if (!this.finishNumber()) return false;
    return this.stepByte(b);
  }

  private finishNumber(): boolean {
    if (this.numStage !== 1 && this.numStage !== 2 && this.numStage !== 4 && this.numStage !== 7) {
      return false;
    }
    if (this.activeSlot !== CaptureSlot.None && !this.numOverflow && this.numLen > 0) {
      const raw = Buffer.from(this.numBuf.buffer, this.numBuf.byteOffset, this.numLen).toString('ascii');
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) this.recordScalar(parsed);
    }
    this.activeSlot = CaptureSlot.None;
    this.transitionAfterValue();
    return true;
  }

  private recordScalar(value: string | number | boolean | null): void {
    const slot = this.activeSlot;
    this.activeSlot = CaptureSlot.None;
    switch (slot) {
      case CaptureSlot.None:
        return;
      case CaptureSlot.RootKind:
        if (typeof value === 'string') this.meta.kind = value;
        return;
      case CaptureSlot.RootVersion:
        if (typeof value === 'number') this.meta.version = value;
        return;
      case CaptureSlot.RootEpoch:
        if (typeof value === 'string') this.meta.epoch = value;
        return;
      case CaptureSlot.RootCreatedAt:
        if (typeof value === 'number') this.meta.created_at = value;
        return;
      case CaptureSlot.RootLastSeq:
        if (typeof value === 'number') this.meta.last_seq = value;
        return;
      case CaptureSlot.RootSeq:
        if (typeof value === 'number') this.meta.seq = value;
        return;
      case CaptureSlot.RootFromSeq:
        if (typeof value === 'number') this.meta.from_seq = value;
        return;
      case CaptureSlot.RootAttentionSeq:
        if (typeof value === 'number') this.meta.attention_seq = value;
        return;
      case CaptureSlot.RootEventType:
        if (typeof value === 'string') this.meta.event_type = value;
        return;
      case CaptureSlot.RootAgentId:
        if (typeof value === 'string' || value === null) {
          this.meta.agent_id = value;
          this.meta.has_agent_id = true;
        }
        return;
      case CaptureSlot.RootRoutingKnown:
        if (typeof value === 'boolean') this.meta.routing_known = value;
        return;
      case CaptureSlot.RootOmittedBytes:
        if (typeof value === 'number') this.meta.omitted_bytes_at_least = value;
        return;
      case CaptureSlot.RootReason:
        if (typeof value === 'string') this.meta.reason = value;
        return;
      case CaptureSlot.RootSessionId:
        if (typeof value === 'string') this.meta.session_id = value;
        return;
      case CaptureSlot.EnvType:
        this.meta.envelope ??= {};
        if (typeof value === 'string') this.meta.envelope.type = value;
        return;
      case CaptureSlot.EnvSeq:
        this.meta.envelope ??= {};
        if (typeof value === 'number') this.meta.envelope.seq = value;
        return;
      case CaptureSlot.EnvEpoch:
        this.meta.envelope ??= {};
        if (typeof value === 'string') this.meta.envelope.epoch = value;
        return;
      case CaptureSlot.EnvSessionId:
        this.meta.envelope ??= {};
        if (typeof value === 'string') this.meta.envelope.session_id = value;
        return;
      case CaptureSlot.PayloadObject:
        this.meta.envelope ??= {};
        this.meta.envelope.payloadKind = 'other';
        return;
      case CaptureSlot.PayloadAgentId:
        this.meta.envelope ??= {};
        if (typeof value === 'string') this.meta.envelope.payloadAgentId = value;
        else this.meta.envelope.payloadHasNonStringAgentId = true;
        return;
      case CaptureSlot.PayloadSubagentId:
        this.meta.envelope ??= {};
        if (typeof value === 'string') this.meta.envelope.payloadSubagentId = value;
        return;
      case CaptureSlot.PayloadInfoKind:
        this.meta.envelope ??= {};
        if (typeof value === 'string') this.meta.envelope.payloadInfoKind = value;
        return;
      case CaptureSlot.PayloadInfoAgentId:
        this.meta.envelope ??= {};
        if (typeof value === 'string') this.meta.envelope.payloadInfoAgentId = value;
        return;
      case CaptureSlot.RosterType:
        this.meta.roster_hint ??= {};
        if (typeof value === 'string') this.meta.roster_hint.type = value;
        return;
      case CaptureSlot.RosterAgentId:
        this.meta.roster_hint ??= {};
        if (typeof value === 'string') this.meta.roster_hint.agentId = value;
        return;
      case CaptureSlot.RosterSubagentId:
        this.meta.roster_hint ??= {};
        if (typeof value === 'string') this.meta.roster_hint.subagentId = value;
        return;
      case CaptureSlot.RosterInfoKind:
        this.meta.roster_hint ??= {};
        if (typeof value === 'string') this.meta.roster_hint.infoKind = value;
        return;
      case CaptureSlot.RosterInfoAgentId:
        this.meta.roster_hint ??= {};
        if (typeof value === 'string') this.meta.roster_hint.infoAgentId = value;
        return;
      default:
        return;
    }
  }

  private popContainer(expected: ContainerKind): boolean {
    if (this.depth === 0 || this.stack[this.depth - 1] !== expected) return false;
    this.depth -= 1;
    this.transitionAfterValue();
    return true;
  }

  private transitionAfterValue(): void {
    if (this.depth === 0) {
      this.state = ParserState.Done;
      return;
    }
    const parent = this.stack[this.depth - 1] as ContainerKind;
    this.state = parent === ContainerKind.Object
      ? ParserState.ObjectCommaOrEnd
      : ParserState.ArrayCommaOrEnd;
  }
}
