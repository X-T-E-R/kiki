/**
 * Persona conversation queries with root keys decoupled from `['sessions']`.
 *
 * Keeping these keys under `'persona-session-heads'` and
 * `'persona-switcher-sessions'` prevents `Alt+Tab` window-focus `nudgeConnection`
 * (`invalidateQueries({ queryKey: ['sessions'] })`) from triggering full
 * session-index rescans.
 *
 * - `usePersonaSessionHeads` fetches the single aggregate endpoint
 *   `GET /api/personas/session-heads` once for the entire sidebar persona group
 *   (occupying 1 HTTP slot instead of N concurrent per-persona queries).
 * - `usePersonaSwitcherConversations` fetches up to 100 conversations for one
 *   persona on demand when an explicit switcher panel or overflow view opens.
 */

import { useQuery } from '@tanstack/react-query';
import { createConnectionTransport } from '@kiki/klient/http';
import type { PersonaSessionHeadBucket, PersonaSessionHeadsQuery, PersonaSessionHeadsResponse } from '@kiki/protocol';
import type { SessionPrivateFilter } from '@kiki/session-core/settings';

import { useConnection } from '../../state/connection';

/** The window one switcher panel shows at once; the full list is a page away. */
const PAGE_SIZE = 100;

export type { PersonaSessionHeadBucket };
export type PersonaSessionHeadsMap = Readonly<PersonaSessionHeadsResponse>;

export type PersonaPrivateFilter = SessionPrivateFilter;

export const personaSwitcherQueryKey = (
  personaId: string | undefined,
  privateFilter: PersonaPrivateFilter = 'include',
) => ['persona-switcher-sessions', personaId ?? '', privateFilter] as const;

export const personaSessionHeadsQueryKey = (
  scopeKey: string,
  perPersonaLimit: number,
  privateFilter: PersonaPrivateFilter = 'hide',
) => ['persona-session-heads', scopeKey, perPersonaLimit, privateFilter] as const;

interface SessionHeadsClientOverride {
  readonly listPersonaSessionHeads?: (
    params: PersonaSessionHeadsQuery,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<PersonaSessionHeadsMap>;
  readonly klient?: {
    readonly rest?: {
      readonly personas?: {
        readonly sessionHeads?: (
          params: PersonaSessionHeadsQuery,
          options?: { readonly signal?: AbortSignal },
        ) => Promise<PersonaSessionHeadsMap>;
      };
    };
  };
  readonly baseUrl?: string;
}

export function usePersonaSessionHeads(options: {
  readonly enabled: boolean;
  readonly perPersonaLimit?: number;
  readonly privateFilter?: PersonaPrivateFilter;
}) {
  const connection = useConnection();
  const perPersonaLimit = options.perPersonaLimit ?? 10;
  const privateFilter = options.privateFilter ?? 'hide';
  const includePrivate = privateFilter !== 'hide';
  const privateOnly = privateFilter === 'only' ? true : undefined;
  const client = connection.client as unknown as SessionHeadsClientOverride | undefined;
  const rawBaseUrl = connection.config?.url ?? client?.baseUrl;
  const token = connection.config?.token?.trim() ?? '';
  const connectionId = connection.connectionId ?? null;
  const scopeKey = `${connection.spaceKey ?? ''}:${connection.scopeId ?? 'local'}:${connectionId ?? ''}:${rawBaseUrl ?? ''}`;
  const hasClientMethod = typeof client?.listPersonaSessionHeads === 'function';
  const hasRestMethod = typeof client?.klient?.rest?.personas?.sessionHeads === 'function';
  const canFetchHttp = rawBaseUrl !== undefined && typeof globalThis.fetch === 'function';

  return useQuery<PersonaSessionHeadsMap>({
    queryKey: personaSessionHeadsQueryKey(scopeKey, perPersonaLimit, privateFilter),
    queryFn: async ({ signal }) => {
      const queryParams: PersonaSessionHeadsQuery = {
        per_persona_limit: perPersonaLimit,
        include_private: includePrivate,
        private_only: privateOnly,
      };
      if (hasClientMethod) {
        return client!.listPersonaSessionHeads!(queryParams, { signal });
      }
      if (hasRestMethod) {
        return client!.klient!.rest!.personas!.sessionHeads!(queryParams, { signal });
      }
      const root = (rawBaseUrl ?? '').trim().replace(/\/+$/u, '');
      const url = root === ''
        ? new URL('/api/personas/session-heads', globalThis.location?.origin ?? 'http://localhost')
        : new URL(`${root}/api/personas/session-heads`);
      url.searchParams.set('per_persona_limit', String(perPersonaLimit));
      url.searchParams.set('include_private', String(includePrivate));
      if (privateOnly === true) {
        url.searchParams.set('private_only', 'true');
      }

      const headers: Record<string, string> = { accept: 'application/json' };
      if (token !== '') {
        headers['authorization'] = `Bearer ${token}`;
      }
      const doFetch = connectionId !== null
        ? createConnectionTransport({
            endpoint: root === '' ? (globalThis.location?.origin ?? 'http://localhost') : root,
            token,
            connectionId,
          }).fetch
        : globalThis.fetch;

      const response = await doFetch(url, {
        method: 'GET',
        headers,
        credentials: connectionId === null ? 'same-origin' : undefined,
        signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} reading /api/personas/session-heads`);
      }
      const envelope: unknown = await response.json();
      if (
        envelope === null
        || typeof envelope !== 'object'
        || !('code' in envelope)
        || (envelope as { readonly code: unknown }).code !== 0
        || !('data' in envelope)
        || typeof (envelope as { readonly data: unknown }).data !== 'object'
        || (envelope as { readonly data: unknown }).data === null
      ) {
        const msg = typeof (envelope as { readonly msg?: unknown })?.msg === 'string'
          ? (envelope as { readonly msg: string }).msg
          : 'invalid /api/personas/session-heads response';
        throw new Error(msg);
      }
      return (envelope as { readonly data: PersonaSessionHeadsMap }).data;
    },
    enabled: options.enabled && (hasClientMethod || hasRestMethod || canFetchHttp),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function usePersonaSwitcherConversations(
  personaId: string | undefined,
  open: boolean,
  privateFilter: PersonaPrivateFilter = 'include',
) {
  const { client } = useConnection();
  const hasValidPersona = Boolean(personaId && personaId.trim() !== '');
  const includePrivate = privateFilter !== 'hide';
  const privateOnly = privateFilter === 'only' ? true : undefined;
  return useQuery({
    queryKey: personaSwitcherQueryKey(personaId, privateFilter),
    queryFn: ({ signal }) => client.listSessions({
      persona: personaId!,
      page_size: PAGE_SIZE,
      include_private: includePrivate,
      private_only: privateOnly,
    }, { signal }),
    enabled: open && hasValidPersona && typeof client?.listSessions === 'function',
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}
