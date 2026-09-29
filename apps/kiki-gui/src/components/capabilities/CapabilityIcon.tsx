/**
 * The mark next to a capability's name. A plugin's own icon (a `data:` URI the
 * server inlined from the manifest, or an http(s) catalog URL) renders as an
 * inert `<img>`; without one, a drawn tile stands in. The tile carries a kind
 * glyph — never initials, which read as a placeholder avatar and shift with
 * every rename.
 *
 * Glyphs follow the icon family spec (16px viewBox, 1.35 stroke, round caps).
 */

import { useState } from 'react';

export type CapabilityKind = 'plugin' | 'skill' | 'mcp' | 'tool' | 'panel' | 'theme' | 'command' | 'refresh';

const GLYPHS: Record<CapabilityKind, React.ReactNode> = {
  // A puzzle piece: something that snaps in.
  plugin: (
    <path d="M6.2 3.2h-2a.9.9 0 0 0-.9.9v2.3c.9-.4 2 .1 2 1.3S4.2 9.5 3.3 9.1v2.8c0 .5.4.9.9.9h2.8c-.4-.9.1-2 1.3-2s1.7 1.1 1.3 2h2.3c.5 0 .9-.4.9-.9v-2c.9.3 1.9-.2 1.9-1.4s-1-1.7-1.9-1.4v-3c0-.5-.4-.9-.9-.9h-3c.3-.9-.2-1.9-1.4-1.9s-1.7 1-1.4 1.9z" />
  ),
  // An open book spine: instructions the agent reads.
  skill: (
    <>
      <path d="M8 4.2c-1.3-1-3.2-1.3-5-.9v8.9c1.8-.4 3.7-.1 5 .9 1.3-1 3.2-1.3 5-.9V3.3c-1.8-.4-3.7-.1-5 .9z" />
      <path d="M8 4.2v8.9" />
    </>
  ),
  // Two plugs meeting: a server connection.
  mcp: (
    <>
      <path d="M5.5 10.5 3 13M10.5 5.5 13 3" />
      <path d="m6.8 4.6 4.6 4.6-1.6 1.6a2.3 2.3 0 0 1-3.2 0L5.2 9.4a2.3 2.3 0 0 1 0-3.2z" />
      <path d="m8.2 6 1.4-1.4M10 7.8l1.4-1.4" />
    </>
  ),
  tool: (
    <path d="M10.9 2.8a3 3 0 0 0-3.7 3.9L3.1 10.8a1.4 1.4 0 0 0 2 2l4.1-4.1a3 3 0 0 0 3.9-3.7l-1.8 1.8-1.7-.4-.4-1.7z" />
  ),
  panel: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.8" />
      <path d="M9.5 3v10" />
    </>
  ),
  theme: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5a5.5 5.5 0 0 0 0 11z" fill="currentColor" stroke="none" />
    </>
  ),
  command: (
    <path d="m4 5 3 3-3 3M8.5 11.5H12" />
  ),
  // Two arcs chasing each other: reload.
  refresh: (
    <>
      <path d="M12.8 6.6A5 5 0 0 0 3.6 5.4M3.2 9.4a5 5 0 0 0 9.2 1.2" />
      <path d="M3.4 2.8v2.8h2.8M12.6 13.2v-2.8H9.8" />
    </>
  ),
};

export function CapabilityGlyph({ kind, className = 'h-4 w-4' }: { readonly kind: CapabilityKind; readonly className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.35}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
    >
      {GLYPHS[kind]}
    </svg>
  );
}

const TILE_SIZE = {
  sm: { box: 'h-7 w-7 rounded-[7px]', glyph: 'h-3.5 w-3.5', img: 'h-7 w-7' },
  md: { box: 'h-9 w-9 rounded-[9px]', glyph: 'h-4 w-4', img: 'h-9 w-9' },
  lg: { box: 'h-14 w-14 rounded-[14px]', glyph: 'h-6 w-6', img: 'h-14 w-14' },
} as const;

function usableIcon(icon: string | undefined): string | undefined {
  if (icon === undefined) return undefined;
  if (icon.startsWith('data:image/svg+xml') || icon.startsWith('data:image/png')) return icon;
  if (/^https?:\/\//.test(icon)) return icon;
  return undefined;
}

export function CapabilityIcon({
  icon,
  kind = 'plugin',
  size = 'md',
}: {
  readonly icon?: string;
  readonly kind?: CapabilityKind;
  readonly size?: keyof typeof TILE_SIZE;
}) {
  const [failed, setFailed] = useState(false);
  const source = failed ? undefined : usableIcon(icon);
  const dims = TILE_SIZE[size];
  if (source !== undefined) {
    return (
      <img
        src={source}
        alt=""
        aria-hidden
        draggable={false}
        referrerPolicy="no-referrer"
        onError={() => { setFailed(true); }}
        className={`${dims.img} shrink-0 object-contain`}
        data-capability-icon="image"
      />
    );
  }
  return (
    <span
      aria-hidden
      data-capability-icon="fallback"
      className={`${dims.box} flex shrink-0 items-center justify-center bg-ink/[0.05] text-ink-soft ring-1 ring-inset ring-hairline`}
    >
      <CapabilityGlyph kind={kind} className={dims.glyph} />
    </span>
  );
}
