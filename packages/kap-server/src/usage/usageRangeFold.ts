import type { UsageFact } from '@kiki/agent-core-v2/agent/usage/usageFact';

export interface FoldedUsageRecord extends UsageFact {
  readonly folded: {
    readonly records: number;
    readonly known: number;
    readonly missing: number;
    readonly legacyZero: number;
    readonly latestAt: number;
  };
}

export interface FoldBucketView {
  readonly key: string;
  turnCount: number;
  readonly sessions: {
    readonly sessionId: string;
    readonly turnIds: number[];
    turnCount: number;
    unknownTurnRecords: number;
    agents?: {
      agentId: string;
      turnIds: number[];
      unknownTurnRecords: number;
    }[];
  }[];
  sessionsTruncated: boolean;
  turnAgents?: boolean;
}
