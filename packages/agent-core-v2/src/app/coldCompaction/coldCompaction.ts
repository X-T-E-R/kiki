import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ColdUnsealOptions } from '#/persistence/coldSegmentLog';
import type {
  RetainedCompactOptions,
  RetainedCompactSessionResult,
  RetainedUnsealSessionResult,
} from '#/persistence/retainedJournal';

export interface ColdCompactionStatus {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly sweepsCompleted: number;
  readonly sessionsCompacted: number;
  readonly physicalBytesReclaimed: number;
  readonly lastSweepAt?: number;
}

export interface IColdCompactionService {
  readonly _serviceBrand: undefined;
  compactSession(
    sessionId: string,
    options?: RetainedCompactOptions & { readonly workspaceId?: string },
  ): Promise<RetainedCompactSessionResult | undefined>;
  unsealSession(
    sessionId: string,
    options?: ColdUnsealOptions & { readonly workspaceId?: string },
  ): Promise<RetainedUnsealSessionResult | undefined>;
  runIdlePass(maxSessions?: number): Promise<number>;
  status(): ColdCompactionStatus;
}

export const IColdCompactionService: ServiceIdentifier<IColdCompactionService> =
  createDecorator<IColdCompactionService>('coldCompactionService');
