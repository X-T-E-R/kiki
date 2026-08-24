export type TranscriptMessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface TranscriptProvenance {
  readonly source: 'engine' | 'legacy-wire';
  readonly recordOrdinal?: number;
  readonly partOrdinal?: number;
}

export interface TranscriptLineage {
  readonly replacesMessageId?: string;
  readonly parentMessageId?: string;
  readonly rewriteId?: string;
}

export interface TranscriptMessageIdentity {
  readonly messageId: string;
  readonly role: TranscriptMessageRole;
  readonly revision: number;
  readonly provenance: TranscriptProvenance;
  readonly lineage?: TranscriptLineage;
}

export interface TranscriptPartIdentity {
  readonly partId: string;
  readonly messageId?: string;
  readonly revision: number;
  readonly provenance: TranscriptProvenance;
}

export type TranscriptAnchor =
  | { readonly kind: 'turn'; readonly turnId: string }
  | { readonly kind: 'step'; readonly turnId: string; readonly stepId: string }
  | { readonly kind: 'frame'; readonly turnId: string; readonly stepId: string; readonly frameId: string }
  | { readonly kind: 'tool_call'; readonly toolCallId: string };
