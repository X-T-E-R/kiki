import { useCallback, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

import { useGuardedNavigate } from '../components/dirtyGuard';
import { createVisitId, getCurrentVisit } from './navHistory';
import { captureVisitSnapshots, getReadingSnapshot, timelineSnapshotKey } from './navViewState';
import { isTimelineTargetCurrent, locateInTimeline, type LocateOptions, type TimelineTarget } from './timelineLocate';
import { useNavVisitId } from './useNavSnapshot';

export interface TimelineVisitLocator {
  readonly target: TimelineTarget;
  readonly sessionId: string;
  readonly agentId: string;
  readonly notify?: boolean;
  readonly waitMs?: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readTimelineVisitLocator(state: unknown): TimelineVisitLocator | undefined {
  if (!record(state) || !record(state['kikiNav'])) return undefined;
  const locator = state['kikiNav']['locator'];
  if (!record(locator) || typeof locator['sessionId'] !== 'string' || typeof locator['agentId'] !== 'string' || !record(locator['target'])) return undefined;
  const raw = locator['target'];
  let target: TimelineTarget;
  switch (raw['kind']) {
    case 'block': if (typeof raw['blockId'] !== 'string') return undefined; target = { kind: 'block', blockId: raw['blockId'] }; break;
    case 'turn': if (typeof raw['turnId'] !== 'string') return undefined; target = { kind: 'turn', turnId: raw['turnId'] }; break;
    case 'subagent': if (typeof raw['agentId'] !== 'string') return undefined; target = { kind: 'subagent', agentId: raw['agentId'] }; break;
    case 'interaction': if (typeof raw['id'] !== 'string') return undefined; target = { kind: 'interaction', id: raw['id'] }; break;
    case 'annotation':
      if (typeof raw['annotationId'] !== 'string' || typeof raw['blockId'] !== 'string') return undefined;
      target = { kind: 'annotation', annotationId: raw['annotationId'], blockId: raw['blockId'] }; break;
    case 'latest': target = { kind: 'latest', respectReader: raw['respectReader'] === true }; break;
    default: return undefined;
  }
  return { target, sessionId: locator['sessionId'], agentId: locator['agentId'], notify: typeof locator['notify'] === 'boolean' ? locator['notify'] : undefined,
    waitMs: typeof locator['waitMs'] === 'number' && Number.isFinite(locator['waitMs']) && locator['waitMs'] >= 0 ? locator['waitMs'] : undefined };
}

/** Explicit jumps use Router PUSH even on the same URL; tabs/find/scroll never call this. */
export function useTimelineNavigation(): (target: TimelineTarget, options: LocateOptions & { route?: string }) => void {
  const navigate = useGuardedNavigate();
  const location = useLocation();
  return useCallback((target, options) => {
    const route = options.route ?? `${location.pathname}${location.search}${location.hash}`;
    const sameRoute = route === `${location.pathname}${location.search}${location.hash}`;
    if (sameRoute && isTimelineTargetCurrent(target, options)) return;
    const visit = getCurrentVisit();
    if (visit !== null) captureVisitSnapshots(visit.visitId);
    // Do not spread one-shot handoffs (initialPrompt/create/approval) into a new visit.
    navigate(route, { preventScrollReset: true, state: { kikiNav: {
      visitId: createVisitId(), intent: 'timeline-locate',
      locator: { target, sessionId: options.sessionId, agentId: options.agentId ?? 'main', notify: options.notify, waitMs: options.waitMs },
    } } });
  }, [navigate, location]);
}

/** Call after the Transcript's locator registration effect. Return snapshots beat old deep links. */
export function useTimelineVisitLocator(sessionId: string | undefined, agentId = 'main'): void {
  const location = useLocation();
  const visitId = useNavVisitId();
  const performed = useRef<string | null>(null);
  useEffect(() => {
    if (sessionId === undefined || visitId === null || performed.current === visitId) return;
    const locator = readTimelineVisitLocator(location.state);
    if (locator?.sessionId !== sessionId || locator.agentId !== agentId) return;
    performed.current = visitId;
    if (getReadingSnapshot(visitId, timelineSnapshotKey(sessionId, agentId)) !== undefined) return;
    const controller = new AbortController();
    void locateInTimeline(locator.target, { ...locator, signal: controller.signal });
    return () => { controller.abort(); };
  }, [visitId, sessionId, agentId, location.state]);
}
