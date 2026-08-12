/**
 * `document.title` per route: "<page> — Kiki", or bare "Kiki" when the route
 * carries no page context (or the session list has not loaded the record yet).
 */

import type { Session } from '@moonshot-ai/protocol';

export type WindowRoute =
  | { kind: 'session'; sessionId: string }
  | { kind: 'new' }
  | { kind: 'settings' }
  | { kind: 'usage' }
  | { kind: 'other' };

export function composeWindowTitle(page: string | undefined): string {
  return page === undefined || page.trim() === '' ? 'Kiki' : `${page} — Kiki`;
}

export function resolveWindowTitle(
  route: WindowRoute,
  sessions: readonly Session[],
  text: { untitled: string; newSession: string; settings: string; usage: string },
): string {
  switch (route.kind) {
    case 'new':
      return composeWindowTitle(text.newSession);
    case 'settings':
      return composeWindowTitle(text.settings);
    case 'usage':
      return composeWindowTitle(text.usage);
    case 'session': {
      const session = sessions.find((item) => item.id === route.sessionId);
      if (session === undefined) return composeWindowTitle(undefined);
      const label =
        session.title.trim() !== ''
          ? session.title
          : session.last_prompt !== undefined && session.last_prompt.trim() !== ''
            ? session.last_prompt
            : text.untitled;
      return composeWindowTitle(label);
    }
    case 'other':
      return composeWindowTitle(undefined);
  }
}
