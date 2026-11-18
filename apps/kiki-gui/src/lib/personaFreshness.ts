import type { Klient } from '@kiki/klient';
import type { QueryClient } from '@tanstack/react-query';

const PERSONA_SESSION_LIST_ROOTS = [
  ['persona-session-heads'],
  ['persona-switcher-sessions'],
] as const;

const PERSONA_QUERY_ROOTS = [
  ['personas'],
  ['persona'],
  ['persona-avatar'],
  ['personas', 'directory'],
  ['bots'],
  ...PERSONA_SESSION_LIST_ROOTS,
] as const;

export function invalidatePersonaSessionLists(queries: Pick<QueryClient, 'invalidateQueries'>): void {
  for (const queryKey of PERSONA_SESSION_LIST_ROOTS) {
    void queries.invalidateQueries({ queryKey: [...queryKey] });
  }
}

/** Re-read persona and legacy bot surfaces after a server or peer change. */
export async function invalidatePersonaQueries(queries: QueryClient): Promise<void> {
  await Promise.all(PERSONA_QUERY_ROOTS.map((queryKey) => queries.invalidateQueries({ queryKey: [...queryKey] })));
}

/** Subscribe to server-published persona mutations and refresh after WS attach/reconnect. */
export function subscribePersonaFreshness(klient: Pick<Klient, 'events'>, queries: QueryClient): () => void {
  let active = true;
  const refresh = () => {
    void invalidatePersonaQueries(queries).catch(() => undefined);
  };
  const subscription = klient.events.on('personas.changed', () => {
    if (active) refresh();
  });
  void Promise.resolve(subscription.ready).then(() => {
    if (active) refresh();
  }).catch(() => undefined);
  return () => { active = false; subscription.dispose(); };
}
