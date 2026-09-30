/**
 * PersonaAvatar — the one face a persona shows everywhere (list, editor,
 * composer chip, session header, memory scopes, later the message view and
 * rooms).
 *
 * With an avatar the image is fetched through the client (the route needs
 * the bearer header, which an <img src> cannot send) and shown as a blob URL.
 * Without one — or while it loads, or if it fails — the persona's first
 * character is set in the display face on a tint picked from the id, so two
 * personas side by side read as two people. The tints are existing token
 * pairs, so both themes hold contrast without a second palette.
 */

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { PersonaAvatarData } from '@kiki/protocol';

import { useOptionalConnection } from '../../state/connection';

export type { PersonaAvatarData };

/** Background + ink token pairs; each pair already passes AA in both themes. */
const TINTS = [
  'bg-ink/[0.06] text-ink-soft',
  'bg-selected text-selected-ink',
  'bg-amber-card text-amber-ink',
  'bg-bubble-user text-section-ink',
] as const;

/** Stable tint for an id (FNV-1a), so a persona keeps its color everywhere. */
export function personaTintIndex(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % TINTS.length;
}

/** First user-perceived character of the name (a CJK name reads by its surname). */
export function personaInitial(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') return '?';
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  const first = Segmenter === undefined
    ? Array.from(trimmed)[0]
    : new Segmenter(undefined, { granularity: 'grapheme' }).segment(trimmed)[Symbol.iterator]().next().value?.segment;
  return (first ?? '?').toLocaleUpperCase();
}

/** Avatar data for a list summary; mirrors klient's `personas.avatar()` helper. */
export function personaAvatarOf(persona: { readonly id: string; readonly name: string; readonly avatarMime?: string }): PersonaAvatarData {
  return {
    id: persona.id,
    name: persona.name,
    avatarUrl: persona.avatarMime === undefined ? undefined : `/api/personas/${encodeURIComponent(persona.id)}/avatar`,
  };
}

export const personaAvatarQueryKey = (id: string) => ['persona-avatar', id] as const;

/** Only our own avatar route needs the authenticated fetch; data/blob URLs render directly. */
function needsFetch(url: string): boolean {
  return /\/api\/personas\/[^/]+\/avatar$/u.test(url);
}

export function PersonaAvatar({
  persona,
  size = 32,
  decorative = false,
  className = '',
}: {
  readonly persona: PersonaAvatarData;
  /** Edge length in px; the corner radius and initial scale with it. */
  readonly size?: number;
  /** Next to the visible name, the avatar is decoration and stays out of the a11y tree. */
  readonly decorative?: boolean;
  readonly className?: string;
}) {
  const connection = useOptionalConnection();
  const url = persona.avatarUrl;
  const fetchable = url !== undefined && needsFetch(url) && connection !== null;
  const avatarQuery = useQuery({
    queryKey: personaAvatarQueryKey(persona.id),
    queryFn: ({ signal }) => connection!.client.getPersonaAvatar(persona.id, signal),
    enabled: fetchable,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const blob = fetchable ? avatarQuery.data ?? null : null;
  // Created and revoked by the same effect, so a StrictMode remount (or a
  // shared cached blob) never leaves this instance holding a revoked URL.
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    if (blob === null) { setObjectUrl(null); return; }
    const next = URL.createObjectURL(blob);
    setObjectUrl(next);
    return () => { URL.revokeObjectURL(next); };
  }, [blob]);
  const src = objectUrl ?? (url !== undefined && !needsFetch(url) ? url : null);

  // Rounded square rather than a circle: a persona is a card you keep, and
  // the square leaves room for the initial at small sizes.
  const radius = Math.max(4, Math.round(size * 0.28));
  const style = { width: size, height: size, borderRadius: radius, fontSize: Math.max(9, Math.round(size * 0.46)) };
  const a11y = decorative ? { 'aria-hidden': true as const } : { role: 'img' as const, 'aria-label': persona.name };

  return (
    <span
      data-persona-avatar={persona.id}
      data-persona-avatar-kind={src === null ? 'initial' : 'image'}
      title={decorative ? undefined : persona.name}
      style={style}
      {...a11y}
      className={`relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden font-display leading-none font-semibold ring-1 ring-inset ring-ink/[0.07] ${
        src === null ? TINTS[personaTintIndex(persona.id)] : 'bg-panel'
      } ${className}`}
    >
      {src === null ? personaInitial(persona.name) : (
        <img src={src} alt="" draggable={false} className="h-full w-full object-cover" />
      )}
    </span>
  );
}
