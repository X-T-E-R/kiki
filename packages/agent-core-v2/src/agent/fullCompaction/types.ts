export interface CompactionResult {
  summary: string;
  contextSummary?: string;
  compactedCount: number;
  tokensBefore: number;
  tokensAfter: number;
  keptUserMessageCount?: number;
  keptHeadUserMessageCount?: number;
  droppedCount?: number;
  strategy?: 'summarize' | 'relay';
  shapeVersion?: number;
  reasonCodes?: string[];
  fallbackFrom?: 'relay' | 'summarize';
}

export type CompactionSource = 'manual' | 'auto';

export interface CompactionBeginData {
  queued?: boolean;
  instruction?: string;
  strategy?: 'summarize' | 'relay';
  source: CompactionSource;
}
