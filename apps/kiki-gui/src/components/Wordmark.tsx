/**
 * The kiki wordmark: lowercase display serif with a small accent dot. The dot
 * is the brand's pulse — pass `life` to let it breathe while agents work,
 * beckon while one waits for you, and settle once when a turn lands (see
 * styles/motion.css). Without `life` it stays still.
 *
 * `echo` (the /new hero only) makes the dot answer the person typing: each
 * new value plays one small nod (styles/new-session.css). `0` is the
 * arrival nod on mount; the value alternates so the nod restarts.
 */

import { useLifeChanged, type LifeState } from '../lib/motion';

export function Wordmark({ size = 'md', life, echo }: {
  size?: 'md' | 'lg' | 'xl';
  life?: LifeState;
  echo?: number;
}) {
  // The settle plays when the aggregate lands on done, not on every mount.
  // Only a wordmark that carries a pulse takes part in the memory.
  const changed = useLifeChanged('wordmark', life);
  const shown = life === 'idle' ? undefined : life;
  // xl is the /new hero: the page's one large object, stepped down on phones.
  const textClass = size === 'xl' ? 'text-[44px] sm:text-[56px]' : size === 'lg' ? 'text-4xl' : 'text-[22px]';
  const dotClass = size === 'xl'
    ? 'h-2.5 w-2.5 sm:h-3 sm:w-3'
    : size === 'lg' ? 'h-2 w-2' : 'h-1.5 w-1.5';
  return (
    <span className="inline-flex items-baseline select-none" aria-label="kiki">
      <span
        className={`font-display ${textClass} leading-none font-semibold tracking-tight text-ink`}
        style={{ fontVariationSettings: size === 'xl' ? '"opsz" 60' : '"opsz" 40' }}
      >
        kiki
      </span>
      <span
        className={`kiki-wordmark-echo inline-block ${size === 'xl' ? 'ml-1' : 'ml-[3px]'}`}
        data-echo={echo === undefined ? undefined : echo === 0 ? 'arrive' : echo % 2 === 0 ? 'a' : 'b'}
      >
        <span
          data-life={shown}
          data-life-changed={changed ? '' : undefined}
          className={`kiki-wordmark-dot block ${dotClass} translate-y-[-1px] rounded-full bg-accent`}
        />
      </span>
    </span>
  );
}

/** Small accent square used as the assistant's inline mark. */
export function KikiMark({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-2.5 w-2.5 rounded-[3px] bg-accent ${className}`}
    />
  );
}
