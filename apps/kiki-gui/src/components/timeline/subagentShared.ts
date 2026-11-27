import { createContext, useSyncExternalStore } from 'react';
import type { ToolBlock } from '@kiki/session-core';
import type { AgentTreeNode, Block, NoticePlacementContext, SubagentBlock } from '@kiki/session-core/session';

export const InvocationContext = createContext<{
  callerAgentId: string;
  tools: ReadonlyMap<string, ToolBlock>;
  hasMore: boolean;
  loadOlder: () => Promise<boolean>;
} | null>(null);

export const CompactionRecoveryContext = createContext<{
  readonly latestFailedNoticeId?: string;
  readonly onRetryCompaction?: (strategy: 'summarize' | 'relay') => void;
}>({});

export const NoticePlacementCtx = createContext<{
  readonly placement: NoticePlacementContext;
  readonly blocks: readonly Block[];
  readonly onOpenAgent?: (agentId: string) => void;
  readonly knownAgentIds?: ReadonlySet<string>;
}>({ placement: {}, blocks: [] });

export type SubagentCardForm = 'full' | 'compact';

export function subagentAutoForm(
  status: AgentTreeNode['status'] | SubagentBlock['status'],
): SubagentCardForm {
  return status === 'running' || status === 'background' ? 'full' : 'compact';
}

export function latestLineOf(text: string): string {
  const visible = text.trimEnd();
  const newline = visible.lastIndexOf('\n');
  return newline === -1 ? visible : visible.slice(newline + 1);
}

export function parseTimelineMs(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

const sharedSecondClockListeners = new Set<() => void>();
let sharedSecondClockNow = Date.now();
let sharedSecondClockTimer: ReturnType<typeof setInterval> | null = null;
let sharedSecondClockVisibilityBound = false;

function stopSharedSecondClock(): void {
  if (sharedSecondClockTimer !== null) {
    clearInterval(sharedSecondClockTimer);
    sharedSecondClockTimer = null;
  }
}

function tickSharedSecondClock(): void {
  sharedSecondClockNow = Date.now();
  for (const listener of sharedSecondClockListeners) listener();
}

function startSharedSecondClock(): void {
  if (sharedSecondClockTimer !== null || sharedSecondClockListeners.size === 0) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  const now = Date.now();
  if (now - sharedSecondClockNow >= 1000 || now < sharedSecondClockNow) {
    sharedSecondClockNow = now;
  }
  sharedSecondClockTimer = setInterval(tickSharedSecondClock, 1000);
}

function onSharedSecondClockVisibility(): void {
  if (sharedSecondClockListeners.size === 0) return;
  if (document.visibilityState === 'hidden') {
    stopSharedSecondClock();
  } else {
    tickSharedSecondClock();
    startSharedSecondClock();
  }
}

function subscribeSharedSecondClock(listener: () => void): () => void {
  sharedSecondClockListeners.add(listener);
  if (!sharedSecondClockVisibilityBound && typeof document !== 'undefined') {
    sharedSecondClockVisibilityBound = true;
    document.addEventListener('visibilitychange', onSharedSecondClockVisibility);
  }
  startSharedSecondClock();
  return () => {
    sharedSecondClockListeners.delete(listener);
    if (sharedSecondClockListeners.size === 0) stopSharedSecondClock();
  };
}

function noopSubscribe(): () => void {
  return () => {};
}

function getSharedSecondClockNow(): number {
  return sharedSecondClockNow;
}

function idleSharedSecondClockSnapshot(): number {
  return 0;
}

export function useSharedSecondClock(enabled: boolean): number {
  return useSyncExternalStore(
    enabled ? subscribeSharedSecondClock : noopSubscribe,
    enabled ? getSharedSecondClockNow : idleSharedSecondClockSnapshot,
    idleSharedSecondClockSnapshot,
  );
}

export function subagentStatusTone(status: AgentTreeNode['status'] | SubagentBlock['status']): string {
  switch (status) {
    case 'running':
    case 'background':
      return 'bg-ink-soft';
    case 'completed':
      return 'bg-ink-faint';
    case 'failed':
    case 'lost':
      return 'bg-danger';
    case 'cancelled':
    case 'idle':
    case 'unknown':
      return 'bg-ink-faint';
    case 'suspended':
      return 'bg-amber-rule';
  }
}
