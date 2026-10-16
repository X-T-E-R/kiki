import type { WireRecord } from '#/wire/record';

const stringRun = /(?:[^"\\\u0000-\u001f]+|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})){1,256}/y;
const numberToken = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

/** Validates the whole JSON value without materializing large non-usage bodies. Byte input validates ASCII syntax before decoding a matching usage record as UTF-8. Duplicate keys follow JSON.parse's last-key-wins rule. */
export function parseUsageJson(input: string | Uint8Array): WireRecord | undefined {
  const bytes = typeof input === 'string' ? undefined : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const text = typeof input === 'string' ? input : bytes!.toString(input.byteLength <= 2048 ? 'utf8' : 'latin1');
  if (text.length <= 2048) {
    const raw = JSON.parse(text) as WireRecord;
    if (raw === null) throw new SyntaxError('Invalid usage source JSON');
    return raw.type === 'usage.record' ? raw : undefined;
  }
  let position = 0;
  let usageType = false;
  let rootObject = false;
  let rootKeyIsType = false;
  const stack: number[] = [];
  const fail = (): never => { throw new SyntaxError('Invalid usage source JSON'); };
  const whitespace = (): void => {
    while (position < text.length) {
      const code = text.charCodeAt(position);
      if (code !== 32 && code !== 9 && code !== 10 && code !== 13) break;
      position++;
    }
  };
  const string = (): void => {
    position++;
    for (;;) {
      if (text[position] === '"') { position++; return; }
      stringRun.lastIndex = position;
      if (!stringRun.test(text)) return fail();
      position = stringRun.lastIndex;
    }
  };
  const matchesString = (start: number, expected: string): boolean => {
    const length = position - start;
    if (length === expected.length + 2 && text.startsWith(expected, start + 1)) return true;
    if (length < expected.length + 2 || length > expected.length * 6 + 2) return false;
    const encoded = text.slice(start, position);
    return encoded.includes('\\') && JSON.parse(encoded) === expected;
  };
  const value = (captureType: boolean): void => {
    whitespace();
    const token = text[position];
    if (captureType) usageType = false;
    if (token === '"') {
      const start = position;
      string();
      if (captureType) usageType = matchesString(start, 'usage.record');
    } else if (token === '{' || token === '[') {
      position++;
      stack.push(token === '{' ? 0 : 5);
    } else if (token === 't' && text.startsWith('true', position)) position += 4;
    else if (token === 'f' && text.startsWith('false', position)) position += 5;
    else if (token === 'n' && text.startsWith('null', position)) position += 4;
    else {
      numberToken.lastIndex = position;
      const number = numberToken.exec(text);
      if (number === null) return fail();
      position = numberToken.lastIndex;
    }
  };
  whitespace();
  rootObject = text[position] === '{';
  value(false);
  while (stack.length > 0) {
    whitespace();
    const top = stack.length - 1;
    const state = stack[top];
    const token = text[position];
    if ((state === 0 && token === '}') || (state === 5 && token === ']')) {
      position++;
      stack.pop();
    } else if (state === 0 || state === 4) {
      if (token !== '"') return fail();
      const start = position;
      string();
      if (rootObject && top === 0) rootKeyIsType = matchesString(start, 'type');
      whitespace();
      if (text[position++] !== ':') return fail();
      stack[top] = 3;
      value(rootObject && top === 0 && rootKeyIsType);
    } else if (state === 5 || state === 6) {
      stack[top] = 7;
      value(false);
    } else if (state === 3 || state === 7) {
      if (token === (state === 3 ? '}' : ']')) {
        position++;
        stack.pop();
      } else if (token === ',') {
        position++;
        stack[top] = state === 3 ? 4 : 6;
      } else return fail();
    } else return fail();
  }
  whitespace();
  if (position !== text.length || text.trim() === 'null') return fail();
  return rootObject && usageType ? JSON.parse(bytes === undefined ? text : bytes.toString('utf8')) as WireRecord : undefined;
}

const usageFields = new Set(['type', 'time', 'model', 'usage', 'usageKnown', 'turnId', 'agentId', 'parentAgentId', 'provider', 'modelAlias', 'profileName', 'upstreamModelId', 'sourceAgentId', 'invalid']);
const tokenFields = new Set(['inputOther', 'output', 'inputCacheRead', 'inputCacheCreation']);
const batchFields = new Set(['version', 'start', 'checkpoint', 'records']);
const checkpointFields = new Set(['generation', 'offset', 'size', 'mtimeMs', 'boundaryHash', 'valid']);
const stringFields = new Set(['type', 'model', 'agentId', 'parentAgentId', 'provider', 'modelAlias', 'profileName', 'upstreamModelId', 'sourceAgentId', 'generation', 'boundaryHash']);
const plainStringRun = /[^"\\\u0000-\u001F]+/y;
const digitRun = /[0-9]+/y;

type JsonTarget = { object: Record<string, unknown>; key: string };
type JsonFrame = { state: number; capture: 0 | 1 | 2 | 3 | 4 | 5 | 6; object?: Record<string, unknown>; key?: string };

/** Fact batches are provisional until finishBatch validates the complete envelope; reset discards a duplicate records array's preceding items. */
export interface UsageFactJsonObserver {
  record(value: Record<string, unknown>): void;
  reset(): void;
}

/** Incrementally validates a JSON value, retaining only usage fields and nesting state rather than unrelated bodies. Input chunks may split any token; duplicate keys retain JSON.parse's last-key-wins semantics. */
export class UsageJsonStream {
  private readonly root: Record<string, unknown> = {};
  private readonly stack: JsonFrame[] = [];
  private started = false;
  private done = false;
  private rootNull = false;
  private rootObject = false;
  private token: 'string' | 'number' | 'literal' | undefined;
  private target?: JsonTarget;
  private keyToken = false;
  private captureString = false;
  private stringParts: string[] = [];
  private stringLength = 0;
  private escape = false;
  private unicode = '';
  private unicodeLeft = 0;
  private literal = '';
  private literalAt = 0;
  private numberState = 0;
  private negative = false;
  private significant = '';
  private significantCount = 0;
  private fractionCount = 0;
  private exponent = 0;
  private exponentNegative = false;
  private sticky = false;

  constructor(private readonly batchObserver?: UsageFactJsonObserver) {}

  write(text: string): void {
    let position = 0;
    while (position < text.length) {
      const char = text[position]!;
      if (this.token === 'string') {
        if (!this.captureString && !this.escape && this.unicodeLeft === 0) {
          stringRun.lastIndex = position;
          if (stringRun.test(text)) { position = stringRun.lastIndex; continue; }
        }
        if (this.unicodeLeft > 0) {
          if (!/[0-9a-fA-F]/.test(char)) this.fail();
          this.unicode += char;
          this.unicodeLeft--;
          position++;
          if (this.unicodeLeft === 0) { this.addString(String.fromCharCode(Number.parseInt(this.unicode, 16))); this.unicode = ''; }
        } else if (this.escape) {
          this.escape = false;
          position++;
          if (char === 'u') this.unicodeLeft = 4;
          else {
            const escaped: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
            if (!Object.hasOwn(escaped, char)) this.fail();
            this.addString(escaped[char]!);
          }
        } else if (char === '"') {
          position++;
          const value = this.captureString ? this.stringParts.join('') : undefined;
          this.stringParts = [];
          this.token = undefined;
          if (this.keyToken) {
            const frame = this.stack.at(-1)!;
            frame.key = value;
            frame.state = 2;
          } else this.finishValue(value);
        } else if (char === '\\') { this.escape = true; position++; }
        else {
          plainStringRun.lastIndex = position;
          if (!plainStringRun.test(text)) this.fail();
          this.addString(text.slice(position, plainStringRun.lastIndex));
          position = plainStringRun.lastIndex;
        }
        continue;
      }
      if (this.token === 'literal') {
        if (char !== this.literal[this.literalAt++]) this.fail();
        position++;
        if (this.literalAt === this.literal.length) {
          this.token = undefined;
          this.finishValue(this.literal === 'true' ? true : this.literal === 'false' ? false : null);
        }
        continue;
      }
      if (this.token === 'number') {
        if (char >= '0' && char <= '9') {
          if (this.numberState === 2) this.fail();
          digitRun.lastIndex = position;
          digitRun.test(text);
          const digits = text.slice(position, digitRun.lastIndex);
          if (this.numberState === 0 || this.numberState === 1) {
            if (char === '0' && digits.length > 1) this.fail();
            this.numberState = char === '0' ? 2 : 3;
          } else if (this.numberState === 4) this.numberState = 5;
          else if (this.numberState === 6 || this.numberState === 7) this.numberState = 8;
          if (this.numberState === 8) {
            if (this.target !== undefined) for (const digit of digits) this.exponent = Math.min(Number.MAX_SAFE_INTEGER, this.exponent * 10 + Number(digit));
          } else if (this.target !== undefined) this.addDigits(digits, this.numberState === 5);
          position = digitRun.lastIndex;
        } else if (char === '-' && this.numberState === 0) { this.negative = true; this.numberState = 1; position++; }
        else if (char === '.' && (this.numberState === 2 || this.numberState === 3)) { this.numberState = 4; position++; }
        else if ((char === 'e' || char === 'E') && [2, 3, 5].includes(this.numberState)) { this.numberState = 6; position++; }
        else if ((char === '+' || char === '-') && this.numberState === 6) { this.exponentNegative = char === '-'; this.numberState = 7; position++; }
        else this.finishNumber();
        continue;
      }
      if (char === ' ' || char === '\t' || char === '\r' || char === '\n') { position++; continue; }
      if (this.done) this.fail();
      const frame = this.stack.at(-1);
      if (frame?.state === 0 || frame?.state === 1) {
        if (char === '}' && frame.state === 0) { this.close(); position++; continue; }
        if (char !== '"') this.fail();
        this.beginString(undefined, true, frame.capture !== 0);
        position++;
        continue;
      }
      if (frame?.state === 2) {
        if (char !== ':') this.fail();
        frame.state = 3;
        position++;
        continue;
      }
      if (frame?.state === 4 || frame?.state === 7) {
        if (char === (frame.state === 4 ? '}' : ']')) this.close();
        else if (char === ',') frame.state = frame.state === 4 ? 1 : 6;
        else this.fail();
        position++;
        continue;
      }
      if (frame?.state === 5 && char === ']') { this.close(); position++; continue; }
      if (frame === undefined && this.started) this.fail();
      const fields = frame?.capture === 1 || frame?.capture === 6 ? usageFields : frame?.capture === 2 ? tokenFields : frame?.capture === 3 ? batchFields : frame?.capture === 4 ? checkpointFields : undefined;
      const target = frame?.key !== undefined && fields?.has(frame.key) ? { object: frame.object!, key: frame.key } : undefined;
      if (frame?.capture === 5 && char !== '{') this.fail();
      if (frame !== undefined) frame.state = frame.state === 3 ? 4 : 7;
      const isRoot = !this.started;
      this.started = true;
      if (char === '{' || char === '[') {
        let capture: JsonFrame['capture'] = isRoot && char === '{' ? (this.batchObserver === undefined ? 1 : 3) : 0;
        let object: Record<string, unknown> | undefined = isRoot ? this.root : undefined;
        if (isRoot) this.rootObject = char === '{';
        if (frame?.capture === 5) { capture = 6; object = {}; }
        if (target !== undefined) {
          if (target.key === 'usage' && char === '{') { capture = 2; object = {}; target.object[target.key] = object; }
          else if (frame?.capture === 3 && target.key === 'checkpoint' && char === '{') { capture = 4; object = {}; target.object[target.key] = object; }
          else if (frame?.capture === 3 && target.key === 'records' && char === '[') { capture = 5; target.object[target.key] = []; this.batchObserver!.reset(); }
          else target.object[target.key] = null;
        }
        this.stack.push({ state: char === '{' ? 0 : 5, capture, object });
        position++;
      } else if (char === '"') {
        this.beginString(target, false, target !== undefined && stringFields.has(target.key));
        position++;
      } else if (char === 't' || char === 'f' || char === 'n') {
        this.target = target;
        this.literal = char === 't' ? 'true' : char === 'f' ? 'false' : 'null';
        this.literalAt = 1;
        this.token = 'literal';
        position++;
      } else if (char === '-' || (char >= '0' && char <= '9')) {
        this.target = target;
        this.token = 'number';
        this.numberState = 0;
        this.negative = false;
        this.significant = '';
        this.significantCount = 0;
        this.fractionCount = 0;
        this.exponent = 0;
        this.exponentNegative = false;
        this.sticky = false;
      } else this.fail();
    }
  }

  finish(): WireRecord | undefined {
    if (this.token === 'number') this.finishNumber();
    if (this.token !== undefined || !this.done || this.rootNull) this.fail();
    return this.rootObject && this.root['type'] === 'usage.record' ? this.root as WireRecord : undefined;
  }

  private beginString(target: JsonTarget | undefined, key: boolean, capture: boolean): void {
    this.target = target;
    this.keyToken = key;
    this.captureString = capture;
    this.stringParts = [];
    this.stringLength = 0;
    this.token = 'string';
  }

  private addString(value: string): void {
    if (!this.captureString) return;
    this.stringLength += value.length;
    if ((this.keyToken && this.stringLength > 18) || (this.target?.key === 'type' && this.stringLength > 12)) {
      this.captureString = false;
      this.stringParts = [];
    } else this.stringParts.push(value);
  }

  private addDigits(value: string, fraction: boolean): void {
    if (fraction) this.fractionCount += value.length;
    if (this.significantCount === 0) value = value.replace(/^0+/, '');
    this.significantCount += value.length;
    const remaining = 1100 - this.significant.length;
    this.significant += value.slice(0, remaining);
    if (/[1-9]/.test(value.slice(remaining))) this.sticky = true;
  }

  private finishNumber(): void {
    if (![2, 3, 5, 8].includes(this.numberState)) this.fail();
    const exponent = (this.exponentNegative ? -this.exponent : this.exponent) - this.fractionCount + this.significantCount - this.significant.length - Number(this.sticky);
    const value = this.significantCount === 0 ? (this.negative ? -0 : 0) : Number(`${this.negative ? '-' : ''}${this.significant}${this.sticky ? '1' : ''}e${exponent}`);
    this.token = undefined;
    this.finishValue(value);
  }

  private finishValue(value: unknown): void {
    if (this.target !== undefined) this.target.object[this.target.key] = value;
    if (this.stack.length === 0) { this.done = true; this.rootNull = value === null; }
    this.target = undefined;
  }

  finishBatch(): Record<string, unknown> {
    this.finish();
    if (!this.rootObject || this.batchObserver === undefined) this.fail();
    return this.root;
  }

  private close(): void {
    const frame = this.stack.pop();
    if (frame?.capture === 6) this.batchObserver!.record(frame.object!);
    if (this.stack.length === 0) this.done = true;
  }

  private fail(): never { throw new SyntaxError('Invalid usage source JSON'); }
}
