/**
 * Per-session "消息 | 过程" choice. Stored locally per session id; a session
 * without a stored choice opens in the message view exactly when its
 * delivery is `message` (Bot mode).
 */

import { useCallback, useEffect, useState } from 'react';

import type { Session } from '@kiki/protocol';
import { spaceStorage } from '../../lib/spaceStorage';

export type TimelineView = 'message' | 'process';

const STORAGE_KEY = 'kiki.timelineView';
const CHANGE_EVENT = 'kiki:timeline-view';

function readAll(): Record<string, TimelineView> {
  try {
    const parsed = JSON.parse(spaceStorage.getItem(STORAGE_KEY) ?? '{}') as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, TimelineView> : {};
  } catch {
    return {};
  }
}

export function defaultTimelineView(session: Pick<Session, 'delivery'> | undefined): TimelineView {
  return session?.delivery === 'message' ? 'message' : 'process';
}

export function readTimelineView(sessionId: string, session: Pick<Session, 'delivery'> | undefined): TimelineView {
  const stored = readAll()[sessionId];
  return stored === 'message' || stored === 'process' ? stored : defaultTimelineView(session);
}

export function writeTimelineView(sessionId: string, view: TimelineView): void {
  try {
    spaceStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readAll(), [sessionId]: view }));
  } catch {
    // Storage can be unavailable; the choice then lasts for this page only.
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { sessionId, view } }));
}

/** Shared by the header toggle and the timeline: both re-read on every change. */
export function useTimelineView(
  sessionId: string,
  session: Pick<Session, 'delivery'> | undefined,
): [TimelineView, (view: TimelineView) => void] {
  const [view, setView] = useState<TimelineView>(() => readTimelineView(sessionId, session));
  const delivery = session?.delivery;
  useEffect(() => {
    setView(readTimelineView(sessionId, delivery === undefined ? undefined : { delivery }));
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; view: TimelineView }>).detail;
      if (detail.sessionId === sessionId) setView(detail.view);
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => { window.removeEventListener(CHANGE_EVENT, onChange); };
  }, [sessionId, delivery]);
  const choose = useCallback((next: TimelineView) => { writeTimelineView(sessionId, next); }, [sessionId]);
  return [view, choose];
}

/** `Ctrl/Cmd+Shift+.` flips the view (design §4.5). */
export function isTimelineViewShortcut(event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): boolean {
  return (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && (event.code === 'Period' || event.key === '>' || event.key === '.');
}
