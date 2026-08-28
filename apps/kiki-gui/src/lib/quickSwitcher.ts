/**
 * Quick-switcher (Ctrl+K) item model: with an empty query the overlay lists
 * the most recent sessions; with a query it merges local title/cwd substring
 * matches (first) with global-search hits (after). The list is flat so ↑↓
 * keyboard navigation needs no section bookkeeping — the component derives
 * visual group headers from item kinds.
 */

import type { Session } from '@moonshot-ai/protocol';

import type { SearchMessageHit } from './client';

export interface SwitcherSessionItem {
  kind: 'session';
  sessionId: string;
  title: string;
  cwd: string;
  updatedAt: string;
}

export interface SwitcherHitItem {
  kind: 'hit';
  sessionId: string;
  sessionTitle: string;
  snippet: string;
  role: SearchMessageHit['role'];
  time: number;
}

/** A static page destination (e.g. the usage dashboard), listed like a row. */
export interface SwitcherActionItem {
  kind: 'action';
  actionId: string;
  title: string;
  route: string;
}

/** One settings card, reachable by name without opening the settings tree. */
export interface SwitcherSettingItem {
  kind: 'setting';
  cardId: string;
  sectionLabel: string;
  title: string;
  route: string;
}

export type SwitcherItem =
  | SwitcherSessionItem
  | SwitcherHitItem
  | SwitcherActionItem
  | SwitcherSettingItem;

/** Caller-supplied page actions; titles are already localized. */
export type SwitcherAction = Omit<SwitcherActionItem, 'kind'>;

export const SWITCHER_RECENT_LIMIT = 10;
export const SWITCHER_TITLE_MATCH_LIMIT = 5;
export const SWITCHER_HIT_LIMIT = 8;
export const SWITCHER_SETTING_LIMIT = 3;

/** `/settings/<section>#st-card-…` — the hash the settings page already
 * flashes on, so a switcher pick lands on the control, not the section top. */
export function settingsCardRoute(section: string, cardId: string): string {
  return `/settings/${section}#${cardId}`;
}

export function switcherSessionLabel(session: Session, untitled: string): string {
  if (session.title.trim() !== '') return session.title;
  if (session.last_prompt !== undefined && session.last_prompt.trim() !== '') {
    return session.last_prompt;
  }
  return untitled;
}

function sessionsByRecency(sessions: readonly Session[]): Session[] {
  return sessions.toSorted((a, b) => b.updated_at.localeCompare(a.updated_at));
}

function toSessionItem(session: Session, untitled: string): SwitcherSessionItem {
  return {
    kind: 'session',
    sessionId: session.id,
    title: switcherSessionLabel(session, untitled),
    cwd: session.metadata.cwd,
    updatedAt: session.updated_at,
  };
}

function matchesQuery(session: Session, query: string, untitled: string): boolean {
  return (
    switcherSessionLabel(session, untitled).toLowerCase().includes(query) ||
    session.metadata.cwd.toLowerCase().includes(query)
  );
}

export function buildSwitcherItems(input: {
  query: string;
  sessions: readonly Session[];
  hits: readonly SearchMessageHit[];
  untitled: string;
  actions?: readonly SwitcherAction[];
  /** Settings cards already filtered by the caller's settings search. */
  settings?: readonly SwitcherSettingItem[];
}): SwitcherItem[] {
  const ordered = sessionsByRecency(input.sessions);
  const query = input.query.trim().toLowerCase();
  const actions: SwitcherActionItem[] = (input.actions ?? [])
    .filter((action) => query === '' || action.title.toLowerCase().includes(query))
    .map((action) => ({ kind: 'action', ...action }));
  if (query === '') {
    return [
      ...actions,
      ...ordered.slice(0, SWITCHER_RECENT_LIMIT).map((session) => toSessionItem(session, input.untitled)),
    ];
  }
  const titleMatches = ordered
    .filter((session) => matchesQuery(session, query, input.untitled))
    .slice(0, SWITCHER_TITLE_MATCH_LIMIT)
    .map((session) => toSessionItem(session, input.untitled));
  const hitItems: SwitcherHitItem[] = input.hits.slice(0, SWITCHER_HIT_LIMIT).map((hit) => ({
    kind: 'hit',
    sessionId: hit.session_id,
    sessionTitle: hit.session_title,
    snippet: hit.snippet,
    role: hit.role,
    time: hit.time,
  }));
  // Settings sit last: a query that names a session should not be outranked
  // by a settings card that happens to share a word.
  const settings = (input.settings ?? []).slice(0, SWITCHER_SETTING_LIMIT);
  return [...actions, ...titleMatches, ...hitItems, ...settings];
}
