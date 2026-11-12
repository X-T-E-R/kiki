import type { HistoryLocatorStore } from '../historyLocatorStore';
import type { TranscriptService } from '../../transcript/transcriptService';

export type NavigationMethod = 'scan' | 'list' | 'lookupDirectory' | 'readBlocks' | 'row' | 'read' |
  'lookupToolCall' | 'readCanonicalEntity' | 'readDurableTurn' | 'readCanonicalTurnHeader' |
  'readCanonicalTurnHeaders' | 'indexedTurnByte' | 'invalidateCanonical' | 'prepareResidentProof' | 'proveResident' | 'checkResidentFailure';
export type TranscriptCallback = 'readRetainedColdTurn' | 'readColdWindowTurn';
export interface NavigationRequest {
  readonly id: number;
  readonly method: NavigationMethod | 'close';
  readonly args: readonly unknown[];
  readonly cancellation: SharedArrayBuffer;
  readonly location?: Awaited<ReturnType<TranscriptService['historyWireLocation']>>;
  readonly session?: string;
  readonly agent?: string;
  readonly detailBudget: number;
}
export type NavigationReport = ReturnType<HistoryLocatorStore['canonicalReadReport']>;
export type NavigationResponse = { readonly id: number; readonly result?: unknown;
  readonly error?: { readonly name: string; readonly message: string; readonly code?: string };
  readonly report?: NavigationReport; readonly retainedBodyChars?: number } |
  { readonly type: 'callback'; readonly id: number; readonly request: number;
    readonly method: TranscriptCallback; readonly args: readonly [string, string, string] };
export interface NavigationCallbackResult {
  readonly type: 'callbackResult';
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly name: string; readonly message: string; readonly code?: string };
}

export function navigationError(error: unknown): NonNullable<NavigationCallbackResult['error']> {
  return error instanceof Error ? { name: error.name, message: error.message, code: (error as NodeJS.ErrnoException).code } :
    { name: 'Error', message: String(error) };
}
