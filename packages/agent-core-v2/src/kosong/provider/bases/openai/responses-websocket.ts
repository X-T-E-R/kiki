import OpenAI from 'openai';
import { ResponsesWS } from 'openai/resources/responses/ws';
import { getWebSocketEventPayload } from 'openai/resources/responses/ws-base';
import type { ResponsesOutputProjection, ResponsesTransportDiagnostics } from '#/kosong/contract/responsesTransport';

import { createAbortError } from '#/kosong/contract/errors';

type RawObject = Record<string, unknown>;
type SDKStreamRecord = {
  type: string;
  message?: unknown;
  error?: unknown;
  code?: number;
  reason?: string;
};

type GatewayError = {
  code: string | undefined;
  message: string;
  param: string | null | undefined;
  status: number | undefined;
  execution: string | undefined;
  retirementNotExecuted: boolean;
};

type Baseline = {
  responseId: string;
  prefix: readonly unknown[];
  canonicalInput: readonly unknown[];
  canonicalPrefix: readonly unknown[] | undefined;
  canonicalFingerprint: readonly string[] | undefined;
  projectedOutput: readonly unknown[] | undefined;
  incremental: boolean;
  identityKey: string;
  wireIdentityKey: string;
  connectionKey: string;
};

type OutputProjection = (output: readonly unknown[]) => ResponsesOutputProjection | undefined;

type PreparedCanonical = {
  input: readonly unknown[] | undefined;
  inputFingerprint: readonly string[] | undefined;
  identityKey: string;
  wireIdentityKey: string;
  forceFull: boolean;
};

type ActiveConnection = {
  socket: ResponsesWS;
  stream: AsyncIterableIterator<unknown>;
  interruptionGeneration: number;
};

type PrimedResponse = {
  record: SDKStreamRecord;
  delta: boolean;
  retriedStateMiss: boolean;
};

const CAPABILITIES_HEADER = 'x-responses-websocket-capabilities';
const READY_STATE_OPEN = 1;
const RESPONSE_CREATE = 'response.create';
const TERMINAL_WRITE_MARGIN_SECONDS = 15;
const UNSUPPORTED_CONTROLS = [
  'background',
  'conversation',
  'context_management',
  'generate',
  'stream_options',
] as const;

function asObject(value: unknown): RawObject | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as RawObject;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function exactJson(value: unknown): string | undefined {
  try {
    const result = JSON.stringify(value);
    return result === undefined ? undefined : result;
  } catch {
    return undefined;
  }
}

function fingerprintInput(input: readonly unknown[] | undefined): readonly string[] | undefined {
  if (input === undefined) return undefined;
  const result: string[] = [];
  for (const item of input) {
    const fingerprint = exactJson(item);
    if (fingerprint === undefined) return undefined;
    result.push(fingerprint);
  }
  return result;
}

function isPrefix(prefix: readonly string[], value: readonly string[]): boolean {
  if (prefix.length > value.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (prefix[index] !== value[index]) return false;
  }
  return true;
}

function sameFingerprint(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return isPrefix(left, right);
}

function headerRecord(
  headers: Headers | Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  if (headers === undefined) return {};
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  return Object.fromEntries(Object.entries(headers));
}

function headerFingerprint(headers: Readonly<Record<string, string>>): string {
  return Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}\u0000${value}`)
    .join('\u0001');
}

function clientAuthFingerprint(client: OpenAI): string {
  const apiKey = client.apiKey;
  return apiKey === null ? '<null>' : apiKey;
}

function connectionFingerprint(
  client: OpenAI,
  headers: Readonly<Record<string, string>>,
): string {
  return [client.baseURL, clientAuthFingerprint(client), headerFingerprint(headers)].join('\u0000');
}

function readHeaderValue(headers: unknown, wanted: string): string | undefined {
  if (headers instanceof Headers) return headers.get(wanted) ?? undefined;
  const object = asObject(headers);
  if (object === undefined) return undefined;
  for (const [name, value] of Object.entries(object)) {
    if (name.toLowerCase() !== wanted) continue;
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') {
      return value[0];
    }
    return undefined;
  }
  return undefined;
}

function handshakeHeaders(socket: ResponsesWS): unknown {
  const nodeSocket = socket.socket as unknown as { platformSocket?: unknown };
  const platformSocket = asObject(nodeSocket.platformSocket);
  const request = asObject(platformSocket?.['_req']);
  const response = asObject(request?.['res']);
  return response?.['headers'];
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validateCapabilities(value: unknown): ResponsesWebSocketCapabilities {
  const object = asObject(value);
  if (object === undefined) {
    throw new ResponsesWebSocketError(
      'Responses WebSocket capability header must contain a JSON object.',
      'responses_ws_capabilities_unsupported',
      { safeHttpFallback: true },
    );
  }

  const version = object['version'];
  if (version !== 1 && version !== 2) {
    throw new ResponsesWebSocketError(
      'Responses WebSocket capability version is unsupported.',
      'responses_ws_capabilities_unsupported',
      { safeHttpFallback: true },
    );
  }

  const events = object['events'];
  if (!Array.isArray(events) || !events.every((event) => typeof event === 'string') || !events.includes(RESPONSE_CREATE)) {
    throw new ResponsesWebSocketError(
      'Responses WebSocket capabilities do not advertise response.create.',
      'responses_ws_capabilities_unsupported',
      { safeHttpFallback: true },
    );
  }

  const booleanCapabilities = [
    ['generate', true],
    ['generate_false', false],
    ['background', false],
    ['steering', false],
    ['cancel', false],
    ['previous_response_id', true],
    ['native_responses_upstream_required', true],
  ] as const;
  for (const [name, expected] of booleanCapabilities) {
    if (object[name] !== expected) {
      throw new ResponsesWebSocketError(
        `Responses WebSocket capability ${name} is unsupported.`,
        'responses_ws_capabilities_unsupported',
        { safeHttpFallback: true },
      );
    }
  }

  if (object['scheduling'] !== 'connection_fifo' || object['state_scope'] !== 'connection') {
    throw new ResponsesWebSocketError(
      'Responses WebSocket scheduling or state scope is unsupported.',
      'responses_ws_capabilities_unsupported',
      { safeHttpFallback: true },
    );
  }

  if (object['state_miss'] !== 'previous_response_not_found' || object['state_miss_execution'] !== 'not_executed') {
    throw new ResponsesWebSocketError(
      'Responses WebSocket state-miss semantics are unsupported.',
      'responses_ws_capabilities_unsupported',
      { safeHttpFallback: true },
    );
  }

  for (const name of [
    'max_in_flight',
    'max_named_streams',
    'max_queued',
    'max_frame_bytes',
    'max_queued_bytes',
    'max_state_bytes',
    'state_ttl_seconds',
    'connection_lifetime_seconds',
  ]) {
    if (!positiveInteger(object[name])) {
      throw new ResponsesWebSocketError(
        `Responses WebSocket capability ${name} must be a positive integer.`,
        'responses_ws_capabilities_unsupported',
        { safeHttpFallback: true },
      );
    }
  }

  const shared = {
    ...object,
    events: Object.freeze([...events]),
    generate: true as const,
    generate_false: false as const,
    background: false as const,
    steering: false as const,
    cancel: false as const,
    scheduling: 'connection_fifo' as const,
    max_in_flight: object['max_in_flight'] as number,
    max_named_streams: object['max_named_streams'] as number,
    max_queued: object['max_queued'] as number,
    max_frame_bytes: object['max_frame_bytes'] as number,
    max_queued_bytes: object['max_queued_bytes'] as number,
    max_state_bytes: object['max_state_bytes'] as number,
    state_ttl_seconds: object['state_ttl_seconds'] as number,
    connection_lifetime_seconds: object['connection_lifetime_seconds'] as number,
    state_scope: 'connection' as const,
    previous_response_id: true as const,
    native_responses_upstream_required: true as const,
    state_miss: 'previous_response_not_found' as const,
    state_miss_execution: 'not_executed' as const,
  };

  if (version === 1) return Object.freeze({ ...shared, version: 1 as const });

  if (object['lifetime_mode'] !== 'drain_active') {
    throw new ResponsesWebSocketError(
      'Responses WebSocket capability lifetime_mode is unsupported.',
      'responses_ws_capabilities_unsupported',
      { safeHttpFallback: true },
    );
  }
  if (!positiveInteger(object['admission_lifetime_seconds']) || !positiveInteger(object['active_turn_timeout_seconds'])) {
    throw new ResponsesWebSocketError(
      'Responses WebSocket capability admission_lifetime_seconds and active_turn_timeout_seconds must be positive integers.',
      'responses_ws_capabilities_unsupported',
      { safeHttpFallback: true },
    );
  }
  const admission = object['admission_lifetime_seconds'];
  const active = object['active_turn_timeout_seconds'];
  const bound = admission + active + TERMINAL_WRITE_MARGIN_SECONDS;
  if (!Number.isSafeInteger(bound) || shared.connection_lifetime_seconds !== bound) {
    throw new ResponsesWebSocketError(
      'Responses WebSocket connection_lifetime_seconds must equal admission_lifetime_seconds + active_turn_timeout_seconds + 15.',
      'responses_ws_capabilities_unsupported',
      { safeHttpFallback: true },
    );
  }

  return Object.freeze({
    ...shared,
    version: 2 as const,
    lifetime_mode: 'drain_active' as const,
    admission_lifetime_seconds: admission,
    active_turn_timeout_seconds: active,
  });
}

function parseCapabilities(headerValue: string | undefined): ResponsesWebSocketCapabilities {
  if (headerValue === undefined || headerValue.trim().length === 0) {
    throw new ResponsesWebSocketError(
      'Responses WebSocket capability header is missing.',
      'responses_ws_capabilities_unsupported',
      { safeHttpFallback: true },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(headerValue);
  } catch {
    throw new ResponsesWebSocketError(
      'Responses WebSocket capability header is not valid JSON.',
      'responses_ws_capabilities_unsupported',
      { safeHttpFallback: true },
    );
  }
  return validateCapabilities(parsed);
}

function readGatewayError(error: unknown): GatewayError {
  const wrapper = asObject(error);
  const event = wrapper?.['type'] === 'error' ? wrapper : asObject(wrapper?.['error']);
  const nested = asObject(event?.['error']);
  const code = readString(nested?.['code']) ?? readString(event?.['code']);
  const message =
    readString(nested?.['message']) ??
    readString(event?.['message']) ??
    (error instanceof Error ? error.message : String(error));
  const param = nested?.['param'] === null ? null : readString(nested?.['param']) ?? readString(event?.['param']);
  const status = readNumber(event?.['status']) ?? readNumber(nested?.['status']);
  const execution = event?.['type'] === 'error' && nested !== undefined &&
    typeof nested['type'] === 'string' && typeof nested['message'] === 'string' &&
    Number.isInteger(event['status'])
    ? readString(event['execution']) : undefined;
  const retirementNotExecuted = execution === 'not_executed' && nested?.['code'] === 'connection_retiring';
  return { code, message, param, status, execution, retirementNotExecuted };
}

function completedResponse(event: RawObject): { responseId: string; output: readonly unknown[] } | undefined {
  if (event['type'] !== 'response.completed') return undefined;
  const response = asObject(event['response']);
  if (response === undefined) return undefined;
  const responseId = readString(response['id']);
  const output = response['output'];
  if (responseId === undefined || !Array.isArray(output)) return undefined;
  return { responseId, output };
}

function terminalType(value: unknown): 'completed' | 'incomplete' | 'failed' | undefined {
  const type = asObject(value)?.['type'];
  if (type === 'response.completed') return 'completed';
  if (type === 'response.incomplete') return 'incomplete';
  if (type === 'response.failed') return 'failed';
  return undefined;
}

function unsupportedControl(value: unknown, name: string): boolean {
  if (name === 'stream_options') return value !== null && value !== undefined;
  if (name === 'background') return value === true;
  if (name === 'conversation' || name === 'context_management') return value !== null && value !== undefined;
  if (name === 'generate') return value === false;
  return false;
}

function prepareParams(fullParams: Record<string, unknown>): Record<string, unknown> {
  const params = { ...fullParams };
  delete params['type'];
  delete params['previous_response_id'];

  for (const name of UNSUPPORTED_CONTROLS) {
    if (Object.hasOwn(params, name) && unsupportedControl(params[name], name)) {
      throw new ResponsesWebSocketError(
        `Responses WebSocket does not support ${name}.`,
        'unsupported_control',
      );
    }
    delete params[name];
  }

  if (params['stream'] !== undefined) delete params['stream'];
  if (params['cancel'] === true) {
    throw new ResponsesWebSocketError('Responses WebSocket does not support response.cancel.', 'unsupported_control');
  }
  delete params['cancel'];

  const promptCacheOptions = asObject(params['prompt_cache_options']);
  if (promptCacheOptions?.['prewarm'] === true) {
    throw new ResponsesWebSocketError(
      'Responses WebSocket does not support generate:false prewarming.',
      'unsupported_control',
    );
  }

  return params;
}

function canonicalObject(
  canonical: ResponsesWebSocketCanonical | readonly unknown[] | string | undefined,
): ResponsesWebSocketCanonical | undefined {
  return typeof canonical === 'object' && canonical !== null && !Array.isArray(canonical)
    ? canonical as ResponsesWebSocketCanonical
    : undefined;
}

function canonicalInput(
  canonical: ResponsesWebSocketCanonical | readonly unknown[] | string | undefined,
  params: Readonly<Record<string, unknown>>,
): readonly unknown[] | undefined {
  if (Array.isArray(canonical)) return canonical;
  const canonicalObjectValue = canonicalObject(canonical);
  if (canonicalObjectValue?.input !== undefined) return canonicalObjectValue.input;
  return Array.isArray(params['input']) ? params['input'] : undefined;
}

function wireIdentity(params: Readonly<Record<string, unknown>>): string {
  const withoutInput = { ...params };
  delete withoutInput['input'];
  return exactJson(withoutInput) ?? '<uncacheable-wire-identity>';
}

function canonicalIdentity(
  canonical: ResponsesWebSocketCanonical | readonly unknown[] | string | undefined,
  params: Readonly<Record<string, unknown>>,
): string {
  if (typeof canonical === 'string') return canonical;
  const canonicalObjectValue = canonicalObject(canonical);
  if (canonicalObjectValue !== undefined) {
    if (canonicalObjectValue.key !== undefined) {
      return exactJson(canonicalObjectValue.key) ?? '<uncacheable-canonical-key>';
    }
    if (canonicalObjectValue.model !== undefined || canonicalObjectValue.tools !== undefined || canonicalObjectValue.system !== undefined || canonicalObjectValue.auth !== undefined) {
      return exactJson({
        model: canonicalObjectValue.model,
        tools: canonicalObjectValue.tools,
        system: canonicalObjectValue.system,
        auth: canonicalObjectValue.auth,
      }) ?? '<uncacheable-canonical-identity>';
    }
  }

  return wireIdentity(params);
}

function canonicalForceFull(
  canonical: ResponsesWebSocketCanonical | readonly unknown[] | string | undefined,
): boolean {
  const canonicalObjectValue = canonicalObject(canonical);
  return canonicalObjectValue?.compacted === true || canonicalObjectValue?.forked === true;
}

function prepareCanonical(
  canonical: ResponsesWebSocketCanonical | readonly unknown[] | string | undefined,
  params: Readonly<Record<string, unknown>>,
): PreparedCanonical {
  const input = canonicalInput(canonical, params);
  const inputFingerprint = fingerprintInput(input);
  const requestFingerprint = fingerprintInput(Array.isArray(params['input']) ? params['input'] : undefined);
  const verified = inputFingerprint !== undefined && requestFingerprint !== undefined && sameFingerprint(inputFingerprint, requestFingerprint);
  return {
    input: verified ? input : undefined,
    inputFingerprint: verified ? inputFingerprint : undefined,
    identityKey: canonicalIdentity(canonical, params),
    wireIdentityKey: wireIdentity(params),
    forceFull: canonicalForceFull(canonical),
  };
}

function buildResponseCreate(params: Readonly<Record<string, unknown>>, input?: readonly unknown[]): RawObject {
  const body: RawObject = { type: RESPONSE_CREATE, ...params };
  if (input !== undefined) body['input'] = input;
  return body;
}

function jsonBytes(value: unknown): number | undefined {
  const serialized = exactJson(value);
  return serialized === undefined ? undefined : new TextEncoder().encode(serialized).byteLength;
}

function frameBytes(body: RawObject): number {
  const bytes = jsonBytes(body);
  if (bytes === undefined) {
    throw new ResponsesWebSocketError('Responses WebSocket request is not JSON serializable.', 'invalid_request');
  }
  return bytes;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const unref = (timer as unknown as { unref?: () => void }).unref;
  unref?.call(timer);
}

function rawRecord(value: unknown): SDKStreamRecord | undefined {
  const record = asObject(value);
  if (record === undefined || typeof record['type'] !== 'string') return undefined;
  return record as SDKStreamRecord;
}

function socketReady(socket: ResponsesWS): boolean {
  return socket.socket.readyState === READY_STATE_OPEN;
}

export interface ResponsesWebSocketCapabilities {
  readonly version: 1 | 2;
  readonly lifetime_mode?: 'drain_active';
  readonly admission_lifetime_seconds?: number;
  readonly active_turn_timeout_seconds?: number;
  readonly events: readonly string[];
  readonly generate: true;
  readonly generate_false: false;
  readonly background: false;
  readonly steering: false;
  readonly cancel: false;
  readonly scheduling: 'connection_fifo';
  readonly max_in_flight: number;
  readonly max_named_streams: number;
  readonly max_queued: number;
  readonly max_frame_bytes: number;
  readonly max_queued_bytes: number;
  readonly max_state_bytes: number;
  readonly state_ttl_seconds: number;
  /**
   * Hard lifetime of this socket's I/O, in seconds. Version 2 sets it to
   * admission_lifetime_seconds + active_turn_timeout_seconds + 15.
   * Reaching it closes the socket only. It is not persistence cleanup,
   * producer join, or slot release, and it does not by itself prove that a
   * generation succeeded or was not executed.
   */
  readonly connection_lifetime_seconds: number;
  readonly state_scope: 'connection';
  readonly previous_response_id: true;
  readonly native_responses_upstream_required: true;
  readonly state_miss: 'previous_response_not_found';
  readonly state_miss_execution: 'not_executed';
  readonly [key: string]: unknown;
}

export interface ResponsesWebSocketCanonical {
  readonly input?: readonly unknown[];
  readonly key?: unknown;
  readonly model?: unknown;
  readonly tools?: unknown;
  readonly system?: unknown;
  readonly auth?: unknown;
  readonly compacted?: boolean;
  readonly forked?: boolean;
}

export interface ResponsesWebSocketCreateOptions {
  readonly signal?: AbortSignal;
  readonly headers?: Headers | Readonly<Record<string, string>>;
  readonly canonical?: ResponsesWebSocketCanonical | readonly unknown[] | string;
  readonly canonicalOutput?: OutputProjection;
  readonly onFullInput?: (input: readonly unknown[]) => void;
}

export class ResponsesWebSocketError extends Error {
  readonly code: string;
  readonly safeHttpFallback: boolean;
  readonly status: number | undefined;
  readonly param: string | null | undefined;
  readonly execution: string | undefined;

  constructor(
    message: string,
    code = 'responses_websocket_error',
    options?: {
      readonly cause?: unknown;
      readonly safeHttpFallback?: boolean;
      readonly status?: number;
      readonly param?: string | null;
      readonly execution?: string;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'ResponsesWebSocketError';
    this.code = code;
    this.safeHttpFallback = options?.safeHttpFallback === true;
    this.status = options?.status;
    this.param = options?.param;
    this.execution = options?.execution;
  }
}

/**
 * Runs one Responses turn at a time through the official SDK. Version 2 uses
 * drain_active admission and a socket-only hard lifetime; a terminal already
 * delivered to the adapter remains valid after normal consumption, even if
 * the peer or lifetime timer closes the socket while the consumer is awaiting.
 * Explicit cancellation, close, and disposal still interrupt that consumption.
 * A closed socket loses its previous-response baseline. A verified, bounded
 * native prefix remains available for full input on the next version 2 socket,
 * with the same request identity and an exactly matching canonical prefix.
 * Retirement permits HTTP recovery only before any response event, with integer
 * status, nested error.type/code/message, and top-level execution:not_executed.
 */
export class ResponsesWebSocketTransport {
  private _socket: ResponsesWS | null = null;
  private _socketKey: string | undefined;
  private _connectedAt: bigint | undefined;
  private _capabilities: ResponsesWebSocketCapabilities | undefined;
  private _baseline: Baseline | null = null;
  private _fullRebase: Baseline | null = null;
  private _baselineTimer: ReturnType<typeof setTimeout> | undefined;
  private _lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
  private _lifetimeExpired = false;
  private _inFlight = false;
  private _retired = false;
  private _disposed = false;
  private _retirePromise: Promise<void> | undefined;
  private _resolveRetire: (() => void) | undefined;
  private readonly _nativeOutput = new WeakMap<object, readonly unknown[]>();
  private readonly _expiredSockets = new WeakSet<ResponsesWS>();
  private _interruptionGeneration = 0;
  private _capabilitiesAdvertised = false;
  private _closedDiagnostics: ResponsesTransportDiagnostics | undefined;

  get capabilities(): ResponsesWebSocketCapabilities | undefined {
    return this._capabilities;
  }

  diagnostics(): ResponsesTransportDiagnostics {
    if (this._socket === null && this._closedDiagnostics !== undefined) return this._closedDiagnostics;
    return {
      transport: 'ws',
      webSocketCapabilities: this._capabilitiesAdvertised,
      webSocketCapabilityVersion: this._capabilities?.version ?? null,
      webSocketConnectionAgeMs: this._connectedAt === undefined ? null
        : Math.min(Number.MAX_SAFE_INTEGER, Number((process.hrtime.bigint() - this._connectedAt) / 1_000_000n)),
    };
  }

  close(): void {
    if (this._disposed) return;
    this._interruptionGeneration += 1;
    this._closeCurrent();
  }

  retire(): Promise<void> {
    if (this._disposed) return Promise.resolve();
    if (!this._retired) {
      this._retired = true;
      this._retirePromise = new Promise<void>((resolve) => {
        this._resolveRetire = resolve;
      });
      this._clearBaseline();
      if (!this._inFlight) this.dispose();
    }
    return this._retirePromise!;
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._retired = true;
    this._fullRebase = null;
    this._closeCurrent();
    this._resolveRetire?.();
    this._resolveRetire = undefined;
  }

  async request(
    fullParams: Record<string, unknown>,
    options: {
      readonly baseUrl: string;
      readonly apiKey: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly signal?: AbortSignal;
      readonly canonicalOutput?: OutputProjection;
      readonly onFullInput?: (input: readonly unknown[]) => void;
    },
  ): Promise<AsyncIterable<unknown>> {
    const client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
      defaultHeaders: options.headers,
      maxRetries: 0,
    });
    return this.create(client, fullParams, {
      headers: options.headers,
      signal: options.signal,
      canonicalOutput: options.canonicalOutput,
      onFullInput: options.onFullInput,
    });
  }

  commitResponse(responseId: string, canonicalOutput: readonly unknown[]): void {
    const baseline = this._baseline ?? this._fullRebase;
    if (this._disposed || this._inFlight || baseline?.responseId !== responseId ||
      baseline.projectedOutput === undefined ||
      (baseline !== this._fullRebase && (this._socket === null || !socketReady(this._socket)))) return;
    const projected = fingerprintInput(baseline.projectedOutput);
    const actual = fingerprintInput(canonicalOutput);
    if (projected === undefined || actual === undefined || !sameFingerprint(projected, actual)) return;
    baseline.canonicalPrefix = [...baseline.canonicalInput, ...canonicalOutput];
    baseline.canonicalFingerprint = fingerprintInput(baseline.canonicalPrefix);
  }

  async create(
    client: OpenAI,
    fullParams: Record<string, unknown>,
    options: ResponsesWebSocketCreateOptions = {},
  ): Promise<AsyncIterable<unknown>> {
    if (this._disposed || this._retired) {
      throw new ResponsesWebSocketError(
        'Responses WebSocket transport is no longer accepting requests.',
        this._disposed ? 'responses_websocket_disposed' : 'responses_websocket_retired',
      );
    }
    if (this._inFlight) {
      throw new ResponsesWebSocketError(
        'Responses WebSocket transport already has a response in flight.',
        'responses_websocket_inflight',
      );
    }
    if (options.signal?.aborted) throw createAbortError();

    const params = prepareParams(fullParams);
    const canonical = prepareCanonical(options.canonical, params);
    const headers = headerRecord(options.headers);
    const connectionKey = connectionFingerprint(client, headers);
    this._inFlight = true;

    let abortHandler: (() => void) | undefined;
    let sendAttempted = false;
    try {
      const rebase = this._fullRebase;
      const fullRebaseInput = rebase?.canonicalFingerprint !== undefined && canonical.inputFingerprint !== undefined &&
        rebase.connectionKey === connectionKey && rebase.identityKey === canonical.identityKey &&
        rebase.wireIdentityKey === canonical.wireIdentityKey && !canonical.forceFull &&
        canonical.input !== undefined && isPrefix(rebase.canonicalFingerprint, canonical.inputFingerprint)
        ? [...rebase.prefix, ...canonical.input.slice(rebase.canonicalPrefix!.length)] : undefined;
      if (fullRebaseInput !== undefined) options.onFullInput?.(fullRebaseInput);
      const connection = await this._ensureConnection(client, headers, connectionKey, options.signal);
      const useDelta = this._canUseDelta(canonical, connectionKey, params);
      const baseline = this._baseline;
      if (baseline?.canonicalFingerprint !== undefined && canonical.inputFingerprint !== undefined &&
        canonical.input !== undefined && isPrefix(baseline.canonicalFingerprint, canonical.inputFingerprint)) {
        params['input'] = [...baseline.prefix, ...canonical.input.slice(baseline.canonicalPrefix!.length)];
      } else if (this._capabilities?.version === 2 && fullRebaseInput !== undefined) {
        params['input'] = fullRebaseInput;
      }
      if (Array.isArray(params['input'])) options.onFullInput?.(params['input']);
      const body = useDelta
        ? buildResponseCreate(params, canonical.input!.slice(baseline!.canonicalPrefix!.length))
        : buildResponseCreate(params, Array.isArray(params['input']) ? params['input'] : undefined);
      if (useDelta) body['previous_response_id'] = this._baseline!.responseId;

      this._assertFrameWithinLimit(body);
      abortHandler = (): void => {
        this._closeCurrent(connection.socket);
      };
      options.signal?.addEventListener('abort', abortHandler, { once: true });
      if (options.signal?.aborted) {
        abortHandler();
        throw createAbortError();
      }

      sendAttempted = true;
      connection.socket.send(body as never);
      const primed = await this._primeResponse(connection, params, useDelta, options.signal);
      return this._streamResponse(
        connection,
        params,
        canonical,
        options.canonicalOutput,
        connectionKey,
        options.signal,
        abortHandler,
        primed.record,
        primed.delta,
        primed.retriedStateMiss,
      );
    } catch (error) {
      this._inFlight = false;
      if (abortHandler !== undefined) options.signal?.removeEventListener('abort', abortHandler);
      if (sendAttempted) this._closeCurrent();
      if (this._retired) this.dispose();
      if (options.signal?.aborted) {
        this._closeCurrent();
        throw createAbortError();
      }
      throw error;
    }
  }

  private _canUseDelta(
    canonical: PreparedCanonical,
    connectionKey: string,
    params: Readonly<Record<string, unknown>>,
  ): boolean {
    const baseline = this._baseline;
    const requestInput = Array.isArray(params['input']) ? params['input'] : undefined;
    const requestFingerprint = fingerprintInput(requestInput);
    if (
      baseline === null ||
      !baseline.incremental ||
      baseline.connectionKey !== connectionKey ||
      baseline.identityKey !== canonical.identityKey ||
      baseline.wireIdentityKey !== canonical.wireIdentityKey ||
      canonical.forceFull ||
      canonical.input === undefined ||
      canonical.inputFingerprint === undefined ||
      requestFingerprint === undefined ||
      baseline.canonicalFingerprint === undefined ||
      !sameFingerprint(requestFingerprint, canonical.inputFingerprint) ||
      !isPrefix(baseline.canonicalFingerprint, canonical.inputFingerprint)
    ) {
      return false;
    }
    return true;
  }

  private _assertFrameWithinLimit(body: RawObject): void {
    const capabilities = this._capabilities;
    if (capabilities === undefined) {
      throw new ResponsesWebSocketError('Responses WebSocket capabilities are unavailable.', 'responses_ws_capabilities_unsupported', { safeHttpFallback: true });
    }
    if (frameBytes(body) > capabilities.max_frame_bytes) {
      throw new ResponsesWebSocketError(
        'Responses WebSocket response.create frame exceeds the advertised limit.',
        'responses_websocket_frame_too_large',
      );
    }
  }

  private async _ensureConnection(
    client: OpenAI,
    headers: Readonly<Record<string, string>>,
    connectionKey: string,
    signal: AbortSignal | undefined,
  ): Promise<ActiveConnection> {
    if (this._connectedAt !== undefined && process.hrtime.bigint() - this._connectedAt >= 55n * 60n * 1_000_000_000n) this._closeCurrent();
    if (this._socket !== null && this._socketKey === connectionKey && socketReady(this._socket)) {
      return { socket: this._socket, stream: this._socket.stream(), interruptionGeneration: this._interruptionGeneration };
    }

    if (this._socket !== null) this._closeCurrent();
    if (signal?.aborted) throw createAbortError();

    const socket = new ResponsesWS(client, { headers, reconnect: null });
    socket.on('event', (event) => {
      if (event.type !== 'response.completed') return;
      const payload = getWebSocketEventPayload(event);
      if (payload === undefined) return;
      const rawJSON = (source: string): unknown => (JSON as unknown as { rawJSON(source: string): unknown }).rawJSON(source);
      const lossless = asObject(JSON.parse(payload, (_key, value: unknown, context?: { source: string }) =>
        typeof value === 'number' && context !== undefined ? rawJSON(context.source) : value));
      const output = asObject(lossless?.['response'])?.['output'];
      if (Array.isArray(output)) this._nativeOutput.set(event, output);
    });
    this._socket = socket;
    this._socketKey = connectionKey;
    this._capabilities = undefined;
    this._capabilitiesAdvertised = false;
    this._closedDiagnostics = undefined;
    let upgradeHeaders: unknown;
    const platformSocket = socket.socket.platformSocket as unknown as {
      on?: (event: string, listener: (response: unknown) => void) => void;
      off?: (event: string, listener: (response: unknown) => void) => void;
    };
    const onUpgrade = (response: unknown): void => {
      const responseObject = asObject(response);
      upgradeHeaders = responseObject?.['headers'];
    };
    platformSocket.on?.('upgrade', onUpgrade);
    const stream = socket.stream();
    const abortHandler = (): void => {
      this._closeCurrent(socket);
    };
    signal?.addEventListener('abort', abortHandler, { once: true });

    try {
      while (true) {
        const next = await stream.next();
        if (next.done) {
          throw new ResponsesWebSocketError(
            'Responses WebSocket closed before the handshake completed.',
            'responses_websocket_handshake_closed',
          );
        }
        const record = rawRecord(next.value);
        if (record === undefined) {
          throw new ResponsesWebSocketError(
            'Responses WebSocket emitted an invalid lifecycle record.',
            'responses_websocket_protocol',
          );
        }
        if (record.type === 'error') {
          throw this._errorFromSDK(record.error);
        }
        if (record.type === 'close') {
          throw new ResponsesWebSocketError(
            'Responses WebSocket closed before the handshake completed.',
            'responses_websocket_handshake_closed',
            { status: record.code },
          );
        }
        if (record.type !== 'open') continue;

        const capabilityHeader = readHeaderValue(upgradeHeaders, CAPABILITIES_HEADER) ??
          readHeaderValue(handshakeHeaders(socket), CAPABILITIES_HEADER);
        this._connectedAt = process.hrtime.bigint();
        this._capabilitiesAdvertised = capabilityHeader !== undefined && capabilityHeader.trim().length > 0;
        const capabilities = parseCapabilities(capabilityHeader);
        this._capabilities = capabilities;
        this._socketKey = connectionKey;
        this._armConnectionLifetime(socket, capabilities);
        return { socket, stream, interruptionGeneration: this._interruptionGeneration };
      }
    } catch (error) {
      this._closeCurrent(socket);
      if (signal?.aborted) throw createAbortError();
      throw error;
    } finally {
      platformSocket.off?.('upgrade', onUpgrade);
      signal?.removeEventListener('abort', abortHandler);
      if (this._socket !== socket || this._capabilities === undefined) {
        await stream.return?.();
      }
    }
  }

  private _errorFromSDK(error: unknown, allowSafeHttpFallback = false): ResponsesWebSocketError {
    const details = readGatewayError(error);
    const code = details.code ?? 'responses_websocket_error';
    const safeHttpFallback =
      allowSafeHttpFallback &&
      details.execution === 'not_executed' &&
      (code === 'unsupported_upstream_format' || code === 'unsupported_prompt_policy' ||
        (code === 'connection_retiring' && details.retirementNotExecuted));
    const suffix = details.param === undefined || details.param === null ? '' : ` (param: ${details.param})`;
    return new ResponsesWebSocketError(`${code}: ${details.message}${suffix}`, code, {
      cause: error,
      safeHttpFallback,
      status: details.status,
      param: details.param,
      execution: details.execution,
    });
  }

  private async _primeResponse(
    connection: ActiveConnection,
    fullParams: Readonly<Record<string, unknown>>,
    initialDelta: boolean,
    signal: AbortSignal | undefined,
  ): Promise<PrimedResponse> {
    let delta = initialDelta;
    let retriedStateMiss = false;
    while (true) {
      const next = await connection.stream.next();
      if (next.done) {
        if (signal?.aborted) throw createAbortError();
        throw new ResponsesWebSocketError(
          'Responses WebSocket ended before a response event.',
          'responses_websocket_closed_before_terminal',
        );
      }
      const record = rawRecord(next.value);
      if (record === undefined) {
        throw new ResponsesWebSocketError(
          'Responses WebSocket emitted an invalid record.',
          'responses_websocket_protocol',
        );
      }
      if (record.type === 'message') {
        const event = asObject(record.message);
        if (event === undefined || readString(event['type']) === undefined) {
          throw new ResponsesWebSocketError(
            'Responses WebSocket emitted an invalid response event.',
            'responses_websocket_protocol',
          );
        }
        return { record, delta, retriedStateMiss };
      }
      if (record.type === 'error') {
        const error = this._errorFromSDK(record.error, true);
        if (
          delta &&
          !retriedStateMiss &&
          error.code === 'previous_response_not_found' &&
          error.execution === 'not_executed'
        ) {
          retriedStateMiss = true;
          delta = false;
          this._clearBaseline();
          const fullBody = buildResponseCreate(
            fullParams,
            Array.isArray(fullParams['input']) ? fullParams['input'] : undefined,
          );
          this._assertFrameWithinLimit(fullBody);
          connection.socket.send(fullBody as never);
          continue;
        }
        throw error;
      }
      if (record.type === 'close') {
        if (signal?.aborted) throw createAbortError();
        throw new ResponsesWebSocketError(
          'Responses WebSocket closed before a response event.',
          'responses_websocket_closed_before_terminal',
          { status: record.code },
        );
      }
      if (record.type === 'raw') {
        throw new ResponsesWebSocketError(
          'Responses WebSocket emitted a non-JSON frame.',
          'responses_websocket_protocol',
        );
      }
    }
  }

  private async *_streamResponse(
    connection: ActiveConnection,
    fullParams: Readonly<Record<string, unknown>>,
    canonical: PreparedCanonical,
    outputProjection: OutputProjection | undefined,
    connectionKey: string,
    signal: AbortSignal | undefined,
    abortHandler: () => void,
    initialRecord: SDKStreamRecord,
    initialDelta: boolean,
    initialRetriedStateMiss: boolean,
  ): AsyncGenerator<unknown> {
    const iterator = connection.stream;
    const capabilities = this._capabilities;
    let pendingRecord: SDKStreamRecord | undefined = initialRecord;
    let delta = initialDelta;
    let retriedStateMiss = initialRetriedStateMiss;
    let sawResponseEvent = initialRecord.type === 'message';
    let keepConnection = false;
    let terminal: 'completed' | 'incomplete' | 'failed' | undefined;
    let completion: { responseId: string; output: readonly unknown[] } | undefined;

    try {
      while (true) {
        const next = pendingRecord === undefined ? await iterator.next() : { done: false, value: pendingRecord };
        pendingRecord = undefined;
        if (next.done) {
          if (signal?.aborted) throw createAbortError();
          throw new ResponsesWebSocketError(
            'Responses WebSocket ended before a terminal response event.',
            'responses_websocket_closed_before_terminal',
          );
        }
        const record = rawRecord(next.value);
        if (record === undefined) {
          throw new ResponsesWebSocketError('Responses WebSocket emitted an invalid record.', 'responses_websocket_protocol');
        }

        if (record.type === 'message') {
          if (this._socket !== connection.socket) {
            throw new ResponsesWebSocketError(
              'Responses WebSocket closed before the response was committed.',
              'responses_websocket_closed_before_terminal',
            );
          }
          sawResponseEvent = true;
          const event = asObject(record.message);
          if (event === undefined || readString(event['type']) === undefined) {
            throw new ResponsesWebSocketError('Responses WebSocket emitted an invalid response event.', 'responses_websocket_protocol');
          }
          terminal = terminalType(event);
          completion = completedResponse(event);
          if (completion !== undefined) completion.output = this._nativeOutput.get(event) ?? completion.output;
          yield record.message;
          if (signal?.aborted) throw createAbortError();
          const lifetimeClosedAfterTerminal = terminal !== undefined && this._expiredSockets.has(connection.socket) &&
            !this._disposed && this._interruptionGeneration === connection.interruptionGeneration;
          if (this._socket !== connection.socket && !lifetimeClosedAfterTerminal) {
            throw new ResponsesWebSocketError(
              'Responses WebSocket closed before the response was committed.',
              'responses_websocket_closed_before_terminal',
            );
          }
          if (terminal !== undefined) {
            const peerClosed = !socketReady(connection.socket);
            const nativeInput: unknown[] | undefined = Array.isArray(fullParams['input']) ? fullParams['input'] : undefined;
            const prefix = completion === undefined || nativeInput === undefined
              ? undefined : [...nativeInput, ...completion.output];
            const projectedOutput = completion === undefined ? undefined
              : outputProjection === undefined ? { input: completion.output, incremental: true } : outputProjection(completion.output);
            const canonicalPrefix = outputProjection === undefined && canonical.input !== undefined && completion !== undefined
              ? [...canonical.input, ...completion.output] : undefined;
            const stateBytes = prefix === undefined ? undefined : jsonBytes(prefix);
            if (
              (!peerClosed || capabilities?.version === 2) &&
              terminal === 'completed' && completion !== undefined && canonical.input !== undefined &&
              canonical.inputFingerprint !== undefined && prefix !== undefined &&
              projectedOutput !== undefined && stateBytes !== undefined && capabilities !== undefined &&
              stateBytes <= capabilities.max_state_bytes
            ) {
              const baseline: Baseline = {
                responseId: completion.responseId,
                prefix,
                canonicalInput: canonical.input.slice(),
                canonicalPrefix,
                canonicalFingerprint: fingerprintInput(canonicalPrefix),
                projectedOutput: projectedOutput.input,
                incremental: projectedOutput.incremental,
                identityKey: canonical.identityKey,
                wireIdentityKey: canonical.wireIdentityKey,
                connectionKey,
              };
              if (capabilities.version === 2) this._fullRebase = baseline;
              if (!peerClosed) {
                this._storeBaseline(baseline);
                keepConnection = true;
              } else {
                this._clearBaseline();
              }
            } else if (!peerClosed && terminal === 'completed' && completion !== undefined) {
              this._clearBaseline();
              keepConnection = true;
            } else {
              this._clearBaseline();
            }
            if (!keepConnection) this._closeCurrent(connection.socket);
            return;
          }
          continue;
        }

        if (record.type === 'error') {
          const error = this._errorFromSDK(record.error, !sawResponseEvent);
          if (
            delta &&
            !sawResponseEvent &&
            !retriedStateMiss &&
            error.code === 'previous_response_not_found' &&
            error.execution === 'not_executed'
          ) {
            retriedStateMiss = true;
            delta = false;
            this._clearBaseline();
            const fullBody = buildResponseCreate(
              fullParams,
              Array.isArray(fullParams['input']) ? fullParams['input'] : undefined,
            );
            this._assertFrameWithinLimit(fullBody);
            connection.socket.send(fullBody as never);
            continue;
          }
          throw error;
        }

        if (record.type === 'close') {
          if (signal?.aborted) throw createAbortError();
          throw new ResponsesWebSocketError(
            'Responses WebSocket closed before a terminal response event.',
            'responses_websocket_closed_before_terminal',
            { status: record.code },
          );
        }

        if (record.type === 'raw') {
          throw new ResponsesWebSocketError(
            'Responses WebSocket emitted a non-JSON frame.',
            'responses_websocket_protocol',
          );
        }
      }
    } catch (error) {
      this._clearBaseline();
      if (signal?.aborted) throw createAbortError();
      throw error;
    } finally {
      signal?.removeEventListener('abort', abortHandler);
      try {
        await iterator.return?.();
      } finally {
        this._inFlight = false;
        if (this._retired) {
          this.dispose();
        } else if (!keepConnection || (this._lifetimeExpired && this._socket === connection.socket)) {
          this._closeCurrent(connection.socket);
        }
      }
    }
  }

  private _armConnectionLifetime(socket: ResponsesWS, capabilities: ResponsesWebSocketCapabilities): void {
    if (this._lifetimeTimer !== undefined) clearTimeout(this._lifetimeTimer);
    this._lifetimeExpired = false;
    const forceOnExpiry = capabilities.version === 2;
    const expire = (): void => {
      if (this._socket !== socket) return;
      this._lifetimeExpired = true;
      if (this._inFlight && !forceOnExpiry) return;
      if (forceOnExpiry) this._expiredSockets.add(socket);
      this._closeCurrent(socket);
    };
    const maxDelay = 2_147_483_647;
    const delay = capabilities.connection_lifetime_seconds * 1000;
    if (!forceOnExpiry || delay <= maxDelay) {
      this._lifetimeTimer = setTimeout(expire, delay);
      unrefTimer(this._lifetimeTimer);
      return;
    }
    const deadline = process.hrtime.bigint() + BigInt(capabilities.connection_lifetime_seconds) * 1_000_000_000n;
    const schedule = (): void => {
      if (this._socket !== socket) return;
      const remaining = deadline - process.hrtime.bigint();
      if (remaining <= 0n) {
        expire();
        return;
      }
      const milliseconds = (remaining + 999_999n) / 1_000_000n;
      this._lifetimeTimer = setTimeout(schedule, Number(milliseconds > BigInt(maxDelay) ? BigInt(maxDelay) : milliseconds));
      unrefTimer(this._lifetimeTimer);
    };
    schedule();
  }

  private _storeBaseline(baseline: Baseline): void {
    this._clearBaseline();
    this._baseline = baseline;
    const ttlSeconds = this._capabilities?.state_ttl_seconds;
    if (ttlSeconds === undefined) return;
    this._baselineTimer = setTimeout(() => {
      if (this._baseline === baseline) {
        this._baseline = null;
        this._baselineTimer = undefined;
      }
    }, ttlSeconds * 1000);
    unrefTimer(this._baselineTimer);
  }

  private _clearBaseline(): void {
    if (this._baselineTimer !== undefined) {
      clearTimeout(this._baselineTimer);
      this._baselineTimer = undefined;
    }
    this._baseline = null;
  }

  private _closeCurrent(expected?: ResponsesWS): void {
    const socket = this._socket;
    if (socket === null || (expected !== undefined && socket !== expected)) return;
    this._closedDiagnostics = this.diagnostics();
    this._socket = null;
    this._socketKey = undefined;
    this._connectedAt = undefined;
    this._capabilities = undefined;
    this._lifetimeExpired = false;
    if (this._lifetimeTimer !== undefined) {
      clearTimeout(this._lifetimeTimer);
      this._lifetimeTimer = undefined;
    }
    this._clearBaseline();
    try {
      socket.close({ code: 1000, reason: 'transport closed' });
    } catch {
      const platformSocket = (socket.socket as unknown as { platformSocket?: { terminate?: () => void } }).platformSocket;
      platformSocket?.terminate?.();
    }
  }
}
