import {
  RUNTIME_MAX_FRAME_BYTES,
  RUNTIME_MAX_REQUEST_ID_LENGTH,
  RUNTIME_PROTOCOL_NAME,
  RUNTIME_PROTOCOL_VERSION,
  isFiniteNonNegativeInteger,
  isFinitePositiveNumber,
  isNonEmptyString,
  type RuntimeCallCancel,
  type RuntimeCallError,
  type RuntimeCallRequest,
  type RuntimeCallResult,
  type RuntimeFrame,
  type RuntimeHello,
  type RuntimeMaybeTokens,
  type RuntimeReady,
  type RuntimeReject,
  type RuntimeTokenAck,
} from './messages';

export type DecoderEvent =
  | { readonly kind: 'frame'; readonly frame: RuntimeFrame }
  | { readonly kind: 'overflow'; readonly error: Error }
  | { readonly kind: 'invalid'; readonly error: Error };

export interface FrameDecoder {
  readonly bufferedBytes: number;
  push(chunk: Uint8Array): readonly DecoderEvent[];
}

export function encodeFrame(frame: RuntimeFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

export function encodeHello(hello: RuntimeHello): string {
  return encodeFrame({ type: 'hello', hello });
}

export function encodeTokens(tokens: readonly string[]): string {
  return encodeFrame({ type: 'token', token: { tokens } });
}

export function encodeCall(call: RuntimeCallRequest): string {
  return encodeFrame({ type: 'call', call });
}

export function encodeCancel(cancel: RuntimeCallCancel): string {
  return encodeFrame({ type: 'cancel', cancel });
}

export function createFrameDecoder(maxFrameBytes: number): FrameDecoder {
  const limit = Math.max(
    1,
    Math.floor(isFinitePositiveNumber(maxFrameBytes) ? maxFrameBytes : RUNTIME_MAX_FRAME_BYTES),
  );
  const textDecoder = new TextDecoder();
  let buffered = Buffer.alloc(0);
  let closed = false;

  function fail(kind: 'overflow' | 'invalid', message: string): DecoderEvent {
    closed = true;
    return { kind, error: new Error(message) };
  }

  return {
    get bufferedBytes(): number {
      return buffered.byteLength;
    },

    push(chunk: Uint8Array): readonly DecoderEvent[] {
      if (closed) return [];
      const incoming = Buffer.from(chunk);
      buffered = buffered.byteLength === 0 ? incoming : Buffer.concat([buffered, incoming]);
      const events: DecoderEvent[] = [];
      for (;;) {
        const newlineIndex = buffered.indexOf(0x0a);
        if (newlineIndex === -1) {
          if (buffered.byteLength > limit) {
            events.push(fail('overflow', `runtime frame exceeds the ${limit} byte limit`));
          }
          return events;
        }
        const lineBytes = buffered.subarray(0, newlineIndex);
        buffered = buffered.subarray(newlineIndex + 1);
        if (lineBytes.byteLength > limit) {
          return [fail('overflow', `runtime frame exceeds the ${limit} byte limit`)];
        }
        if (lineBytes.byteLength === 0) continue;
        const result = decodeLine(textDecoder.decode(lineBytes));
        if (result.frame === undefined) {
          return [fail('invalid', result.error.message)];
        }
        events.push({ kind: 'frame', frame: result.frame });
      }
    },
  };
}

interface DecodeSuccess {
  readonly frame: RuntimeFrame;
  readonly error?: never;
}

interface DecodeFailure {
  readonly frame?: never;
  readonly error: Error;
}

function decodeLine(line: string): DecodeSuccess | DecodeFailure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    return { error: new Error(`runtime frame is not valid JSON: ${(error as Error).message}`) };
  }
  if (parsed === null || typeof parsed !== 'object' || !('type' in parsed)) {
    return { error: new Error('runtime frame must be an object with a type field') };
  }
  const type = (parsed as { readonly type?: unknown }).type;
  try {
    return { frame: decodeByType(type, parsed) };
  } catch (error) {
    return { error: new Error(`invalid runtime ${String(type)} frame: ${(error as Error).message}`) };
  }
}

function decodeByType(type: unknown, parsed: { readonly [key: string]: unknown }): RuntimeFrame {
  switch (type) {
    case 'hello':
      return { type, hello: decodeHello(parsed['hello']) };
    case 'token':
      return { type, token: decodeToken(parsed['token']) };
    case 'call':
      return { type, call: decodeCall(parsed['call']) };
    case 'cancel':
      return { type, cancel: decodeCancel(parsed['cancel']) };
    case 'ack':
      return { type, ack: decodeAck(parsed['ack']) };
    case 'ready':
      return { type, ready: decodeReady(parsed['ready']) };
    case 'result':
      return { type, result: decodeResult(parsed['result']) };
    case 'error':
      return { type, error: decodeError(parsed['error']) };
    case 'reject':
      return { type, reject: decodeReject(parsed['reject']) };
    default:
      throw new Error(`unknown runtime frame type: ${String(type)}`);
  }
}

function decodeHello(value: unknown): RuntimeHello {
  const field = requireObject(value, 'hello');
  return {
    v: requireConstNumber(field, 'v', RUNTIME_PROTOCOL_VERSION, 'protocol version') as typeof RUNTIME_PROTOCOL_VERSION,
    protocol: requireConstString(field, 'protocol', RUNTIME_PROTOCOL_NAME, 'protocol name') as typeof RUNTIME_PROTOCOL_NAME,
    hostId: requireBoundedString(field, 'hostId', 128),
    canonicalHomeDir: requireBoundedString(field, 'canonicalHomeDir', 4_096),
  };
}

function decodeToken(value: unknown): RuntimeMaybeTokens {
  const field = requireObject(value, 'token');
  const tokens = field['tokens'];
  if (!Array.isArray(tokens) || tokens.length === 0 || tokens.length > 4) {
    throw new Error('tokens must be a non-empty array of at most 4 entries');
  }
  return { tokens: tokens.map((token) => requireBoundedString({ token }, 'token', 4_096)) };
}

function decodeCall(value: unknown): RuntimeCallRequest {
  const field = requireObject(value, 'call');
  return {
    requestId: requireBoundedString(field, 'requestId', RUNTIME_MAX_REQUEST_ID_LENGTH),
    method: requireBoundedString(field, 'method', 256),
    epoch: requireNonNegativeInteger(field, 'epoch'),
    payload: field['payload'],
    timeoutMs: requirePositiveInteger(field, 'timeoutMs'),
  };
}

function decodeCancel(value: unknown): RuntimeCallCancel {
  const field = requireObject(value, 'cancel');
  return {
    requestId: requireBoundedString(field, 'requestId', RUNTIME_MAX_REQUEST_ID_LENGTH),
    epoch: requireNonNegativeInteger(field, 'epoch'),
  };
}

function decodeAck(value: unknown): RuntimeTokenAck {
  const field = requireObject(value, 'ack');
  return {
    v: requireConstNumber(field, 'v', RUNTIME_PROTOCOL_VERSION, 'protocol version') as typeof RUNTIME_PROTOCOL_VERSION,
    protocol: requireConstString(field, 'protocol', RUNTIME_PROTOCOL_NAME, 'protocol name') as typeof RUNTIME_PROTOCOL_NAME,
    epoch: requireNonNegativeInteger(field, 'epoch'),
    hostId: requireBoundedString(field, 'hostId', 128),
    canonicalHomeDir: requireBoundedString(field, 'canonicalHomeDir', 4_096),
  };
}

function decodeReady(value: unknown): RuntimeReady {
  const field = requireObject(value, 'ready');
  return {
    epoch: requireNonNegativeInteger(field, 'epoch'),
    hostId: requireBoundedString(field, 'hostId', 128),
    canonicalHomeDir: requireBoundedString(field, 'canonicalHomeDir', 4_096),
    methods: requireStringArray(field, 'methods', 256, 256),
  };
}

function decodeResult(value: unknown): RuntimeCallResult {
  const field = requireObject(value, 'result');
  return {
    requestId: requireBoundedString(field, 'requestId', RUNTIME_MAX_REQUEST_ID_LENGTH),
    epoch: requireNonNegativeInteger(field, 'epoch'),
    value: field['value'],
  };
}

function decodeError(value: unknown): RuntimeCallError {
  const field = requireObject(value, 'error');
  return {
    requestId: requireBoundedString(field, 'requestId', RUNTIME_MAX_REQUEST_ID_LENGTH),
    epoch: requireNonNegativeInteger(field, 'epoch'),
    error: decodeErrorPayload(requireObject(field['error'], 'error')),
  };
}

function decodeErrorPayload(field: Record<string, unknown>): RuntimeCallError['error'] {
  const code = field['code'];
  if (typeof code !== 'string' || code.length === 0 || code.length > 256) {
    throw new Error('error.code must be a string of 1..256 characters');
  }
  const message = field['message'];
  if (typeof message !== 'string' || message.length > 4_096) {
    throw new Error('error.message must be a string of at most 4096 characters');
  }
  return {
    code: code as RuntimeCallError['error']['code'],
    message,
    name: typeof field['name'] === 'string' ? field['name'] : undefined,
    details: field['details'] === null ? undefined : (field['details'] as Record<string, unknown>),
    retryable: field['retryable'] === true,
  };
}

function decodeReject(value: unknown): RuntimeReject {
  const field = requireObject(value, 'reject');
  const code = field['code'];
  if (typeof code !== 'string' || code.length === 0 || code.length > 256) {
    throw new Error('reject.code must be a string of 1..256 characters');
  }
  const message = field['message'];
  if (typeof message !== 'string' || message.length > 4_096) {
    throw new Error('reject.message must be a string of at most 4096 characters');
  }
  return {
    requestId: typeof field['requestId'] === 'string' ? field['requestId'] : undefined,
    epoch: isFiniteNonNegativeInteger(field['epoch']) ? field['epoch'] : undefined,
    code,
    message,
  };
}

function requireStringArray(field: Record<string, unknown>, key: string, maxItems: number, maxLength: number): readonly string[] {
  const value = field[key];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${key} must be an array of at most ${maxItems} entries`);
  }
  return value.map((item) => requireBoundedString({ value: item }, 'value', maxLength));
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} field must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireConstString(field: Record<string, unknown>, key: string, expected: string, label: string): string {
  const value = field[key];
  if (value !== expected) {
    throw new Error(`${key} must be the constant ${label} "${expected}"`);
  }
  return value;
}

function requireConstNumber(field: Record<string, unknown>, key: string, expected: number, label: string): number {
  const value = field[key];
  if (value !== expected) {
    throw new Error(`${key} must be the constant ${label} ${expected}`);
  }
  return value;
}

function requireBoundedString(field: Record<string, unknown>, key: string, maxLength: number): string {
  const value = field[key];
  if (!isNonEmptyString(value, maxLength)) {
    throw new Error(`${key} must be a string of 1..${maxLength} characters`);
  }
  return value;
}

function requireNonNegativeInteger(field: Record<string, unknown>, key: string): number {
  const value = field[key];
  if (!isFiniteNonNegativeInteger(value)) {
    throw new Error(`${key} must be a non-negative safe integer`);
  }
  return value;
}

function requirePositiveInteger(field: Record<string, unknown>, key: string): number {
  const value = field[key];
  if (!isFinitePositiveNumber(value) || !Number.isSafeInteger(value)) {
    throw new Error(`${key} must be a positive safe integer`);
  }
  return value;
}