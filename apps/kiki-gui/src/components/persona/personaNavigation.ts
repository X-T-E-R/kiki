import type { PersonaSummary } from '@kiki/protocol';

export type PersonaDailyResolution =
  | { readonly kind: 'loading' | 'error' | 'missing' }
  | { readonly kind: 'home'; readonly personaId: string; readonly sessionId: string; readonly href: string }
  | { readonly kind: 'draft'; readonly personaId: string };

/** A failed or unfinished directory read never establishes that a home does not exist. */
export function resolvePersonaDailyRoute(input: {
  readonly personaId?: string;
  readonly directory: readonly Pick<PersonaSummary, 'id' | 'homeSessionId' | 'archived'>[];
  readonly isLoading: boolean;
  readonly isError: boolean;
}): PersonaDailyResolution {
  if (input.personaId === undefined || input.personaId === '') return { kind: 'missing' };
  if (input.isLoading) return { kind: 'loading' };
  if (input.isError) return { kind: 'error' };
  const persona = input.directory.find((entry) => entry.id === input.personaId);
  if (persona === undefined || persona.archived) return { kind: 'missing' };
  return persona.homeSessionId === undefined
    ? { kind: 'draft', personaId: persona.id }
    : { kind: 'home', personaId: persona.id, sessionId: persona.homeSessionId, href: `/s/${encodeURIComponent(persona.homeSessionId)}` };
}

/** Preserve existing local drafts. Never import an unscoped legacy draft into a remote identity. */
export function personaDailyDraftKey(scopeId: string, personaId: string): string {
  return scopeId === 'local' ? `daily:${personaId}` : `daily:${encodeURIComponent(scopeId)}:${personaId}`;
}

/** Reuses the existing scoped new-draft storage family for per-persona target/settings persistence. */
export function personaDailySettingsKey(scopeId: string, personaId: string): string {
  return `kiki.draft.new.${encodeURIComponent(scopeId)}.daily:${personaId}`;
}

/** Starting another topic preserves the current project without changing the daily pointer. */
export function personaNewConversationUrl(personaId: string, workspaceId?: string): string {
  const params = new URLSearchParams({ persona: personaId });
  if (workspaceId !== undefined && workspaceId !== '') params.set('workspace', workspaceId);
  return `/new?${params.toString()}`;
}
