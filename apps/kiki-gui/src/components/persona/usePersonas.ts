/**
 * Shared persona queries. One list key for every surface (the /personas page,
 * the composer's agent chip, the memory page's persona group), so an edit on
 * one refreshes the others.
 */

import { useQuery, type QueryClient } from '@tanstack/react-query';

import type { PersonaSummary } from '@kiki/protocol';

import { useConnection } from '../../state/connection';
import { personaAvatarQueryKey } from './PersonaAvatar';

export const PERSONAS_QUERY_KEY = ['personas'] as const;
export const personaQueryKey = (id: string) => ['persona', id] as const;

export function usePersonaList(options: { readonly includeArchived?: boolean; readonly enabled?: boolean } = {}) {
  const { client } = useConnection();
  const includeArchived = options.includeArchived === true;
  return useQuery({
    queryKey: [...PERSONAS_QUERY_KEY, { includeArchived }],
    queryFn: () => client.listPersonas({ includeArchived }),
    enabled: options.enabled ?? true,
    staleTime: 15_000,
  });
}

/** After a write: the lists, the one snapshot, and (optionally) its avatar. */
export async function invalidatePersonas(queryClient: QueryClient, id?: string, options: { readonly avatar?: boolean } = {}): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: PERSONAS_QUERY_KEY }),
    id === undefined ? undefined : queryClient.invalidateQueries({ queryKey: personaQueryKey(id) }),
    id === undefined || options.avatar !== true ? undefined : queryClient.invalidateQueries({ queryKey: personaAvatarQueryKey(id) }),
  ]);
}

/** Case-insensitive match over the fields a person would type. */
export function matchesPersona(persona: PersonaSummary, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return true;
  return [persona.name, persona.title, persona.job, persona.id]
    .some((field) => field !== undefined && field.toLocaleLowerCase().includes(needle));
}

/** Active first, then by name in the user's collation. */
export function sortPersonas(items: readonly PersonaSummary[]): PersonaSummary[] {
  return [...items].sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name));
}

/** Browser download fallback for hosts without a native save dialog. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
