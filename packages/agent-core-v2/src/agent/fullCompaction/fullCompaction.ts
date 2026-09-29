import type {
  CompactionResult,
  CompactionSource,
} from './types';
import { createDecorator } from "#/_base/di/instantiation";
import type { Event } from '#/_base/event';
import type { Hooks } from '#/hooks';

export interface FullCompactionInput {
  readonly source: CompactionSource;
  readonly instruction?: string;
  readonly strategy?: 'summarize' | 'relay';
}

export interface FullCompactionTask {
  readonly abortController: AbortController;
  readonly promise: Promise<CompactionResult>;
  readonly trigger: CompactionSource;
  readonly tokenCount: number;
  readonly traceId?: string;
}

export interface IAgentFullCompactionService {
  readonly _serviceBrand: undefined;

  readonly compacting: FullCompactionTask | null;
  isCompacting(): boolean;
  begin(input: FullCompactionInput): boolean;
  cancel(): void;
  getAutoCompact(): import('./autoCompact').ResolvedAutoCompact;
  getDefaultAutoCompact(): import('./autoCompact').ResolvedAutoCompact;
  setAutoCompactOverride(tokens: number | null): void;
  getContextStrategy(): { strategy: 'summarize' | 'auto' | 'fresh'; source: 'session' | 'profile' | 'global' | 'default' | 'subagent' | 'executor'; shadow: boolean };
  setContextStrategyOverride(strategy: 'summarize' | 'auto' | 'fresh' | null): void;

  readonly hooks: Hooks<{
    onWillCompact: FullCompactionTask;
  }>;

  readonly onDidFinishCompaction: Event<FullCompactionTask>;
}

export const IAgentFullCompactionService = createDecorator<IAgentFullCompactionService>('agentFullCompactionService');
