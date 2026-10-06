import { attachErrorDetails } from '#/_base/errors/errors';
import { readProviderErrorIdentifier } from './errors';

export type StreamEndSource = 'in_progress' | 'terminal' | 'event_error' | 'sdk_error' | 'local_error' | 'cancelled' | 'eof';

export interface StreamDiagnostics {
  readonly schemaVersion: 1;
  readonly protocol: 'openai_responses';
  readonly endSource: StreamEndSource;
  readonly terminalStatus: 'completed' | 'incomplete' | 'failed' | null;
  readonly terminalTextParts: number | null;
  readonly terminalTextChars: number | null;
  readonly terminalToolCalls: number | null;
  readonly emittedTextChars: number;
  readonly emittedToolHeaders: number;
  readonly eventCount: number;
  readonly textDeltaCount: number;
  readonly textDoneCount: number;
  readonly contentPartAddedCount: number;
  readonly outputItemAddedCount: number;
  readonly outputItemDoneCount: number;
  readonly terminalEventCount: number;
  readonly errorEventCount: number;
}

export function createStreamDiagnostics(): StreamDiagnostics {
  return {
    schemaVersion: 1, protocol: 'openai_responses', endSource: 'in_progress', terminalStatus: null,
    terminalTextParts: null, terminalTextChars: null, terminalToolCalls: null,
    emittedTextChars: 0, emittedToolHeaders: 0, eventCount: 0, textDeltaCount: 0, textDoneCount: 0,
    contentPartAddedCount: 0, outputItemAddedCount: 0, outputItemDoneCount: 0, terminalEventCount: 0, errorEventCount: 0,
  };
}

const END_SOURCES = new Set<StreamEndSource>(['in_progress', 'terminal', 'event_error', 'sdk_error', 'local_error', 'cancelled', 'eof']);
const COUNT_FIELDS = ['emittedTextChars', 'emittedToolHeaders', 'eventCount', 'textDeltaCount', 'textDoneCount', 'contentPartAddedCount', 'outputItemAddedCount', 'outputItemDoneCount', 'terminalEventCount', 'errorEventCount'] as const;
const TERMINAL_COUNT_FIELDS = ['terminalTextParts', 'terminalTextChars', 'terminalToolCalls'] as const;

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Validates and copies only bounded stream categories and counters, never response content. */
export function safeStreamDiagnostics(value: unknown): StreamDiagnostics | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  if (source['schemaVersion'] !== 1 || source['protocol'] !== 'openai_responses') return undefined;
  if (!END_SOURCES.has(source['endSource'] as StreamEndSource)) return undefined;
  const status = source['terminalStatus'];
  if (status !== null && status !== 'completed' && status !== 'incomplete' && status !== 'failed') return undefined;
  if (COUNT_FIELDS.some(key => !isCount(source[key]))) return undefined;
  if (TERMINAL_COUNT_FIELDS.some(key => source[key] !== null && !isCount(source[key]))) return undefined;
  return {
    schemaVersion: 1,
    protocol: 'openai_responses',
    endSource: source['endSource'] as StreamEndSource,
    terminalStatus: status,
    terminalTextParts: source['terminalTextParts'] as number | null,
    terminalTextChars: source['terminalTextChars'] as number | null,
    terminalToolCalls: source['terminalToolCalls'] as number | null,
    emittedTextChars: source['emittedTextChars'] as number,
    emittedToolHeaders: source['emittedToolHeaders'] as number,
    eventCount: source['eventCount'] as number,
    textDeltaCount: source['textDeltaCount'] as number,
    textDoneCount: source['textDoneCount'] as number,
    contentPartAddedCount: source['contentPartAddedCount'] as number,
    outputItemAddedCount: source['outputItemAddedCount'] as number,
    outputItemDoneCount: source['outputItemDoneCount'] as number,
    terminalEventCount: source['terminalEventCount'] as number,
    errorEventCount: source['errorEventCount'] as number,
  };
}

/** Projects provider failure metadata for consumers such as room wake records. Input is ErrorPayload.details. */
export function safeProviderFailureDetails(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null) return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  if (source['errorSource'] === 'provider_stream' || source['errorSource'] === 'provider_event') result['errorSource'] = source['errorSource'];
  for (const key of ['upstreamErrorType', 'upstreamErrorCode', 'requestId', 'traceId'] as const) {
    if (source[key] === null) result[key] = null;
    else {
      const identifier = readProviderErrorIdentifier(source[key]);
      if (identifier !== null) result[key] = identifier;
    }
  }
  const diagnostics = safeStreamDiagnostics(source['streamDiagnostics']);
  if (diagnostics !== undefined) result['streamDiagnostics'] = diagnostics;
  return result;
}

export function attachStreamDiagnostics<T>(error: T, diagnostics: StreamDiagnostics | undefined, cancelled = false): T {
  const safe = safeStreamDiagnostics(diagnostics);
  if (safe !== undefined) attachErrorDetails(error, { streamDiagnostics: cancelled ? { ...safe, endSource: 'cancelled' } : safe });
  return error;
}

export function addDiagnosticCount(current: number, amount = 1): number {
  return Math.min(Number.MAX_SAFE_INTEGER, current + amount);
}
