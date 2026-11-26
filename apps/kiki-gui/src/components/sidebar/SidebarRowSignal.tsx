/**
 * Semantic 3-kind status mark + strict 2-state title weight (`400` `text-ink` vs
 * `text-ink-soft`) for left-sidebar navigation rows:
 *   - `needs_you`: solid vermilion dot (`bg-attention`)
 *   - `working`:   live calm breathing dot (`bg-selected-ink status-dot-busy`)
 *   - `unread`:    crisp hollow ring (`border-[1.5px] border-ink-soft`)
 *   - `signal=false` (idle & read): empty 8px slot
 */

export type SidebarRowPresentation = 'signal' | 'normal';
export type SidebarRowDotKind = 'needs_you' | 'working' | 'unread';

export function sidebarRowPresentation(signal: boolean): SidebarRowPresentation {
  return signal ? 'signal' : 'normal';
}

export function sidebarDotKindFromLife(
  life: 'idle' | 'working' | 'waiting' | 'done' | 'failed',
  options?: { readonly needsYou?: boolean },
): SidebarRowDotKind | undefined {
  if (options?.needsYou === true || life === 'waiting') return 'needs_you';
  if (life === 'working') return 'working';
  if (life === 'done' || life === 'failed') return 'unread';
  return undefined;
}

const DOT_CLASS_BY_KIND: Readonly<Record<SidebarRowDotKind, string>> = {
  needs_you: 'block h-[7px] w-[7px] rounded-full bg-attention',
  working: 'block h-[7px] w-[7px] rounded-full bg-selected-ink status-dot-busy',
  unread: 'block h-[7px] w-[7px] rounded-full border-[1.5px] border-ink-soft bg-transparent',
};

export function SidebarRowDot({
  signal,
  kind = 'unread',
  label,
  dataAttr,
}: {
  readonly signal: boolean;
  readonly kind?: SidebarRowDotKind;
  readonly label?: string;
  readonly dataAttr?: Readonly<Record<string, string | undefined>>;
}) {
  return (
    <span
      className="flex h-5 w-2 shrink-0 items-center justify-center"
      data-sidebar-signal={signal ? 'active' : 'normal'}
      data-sidebar-dot={signal ? kind : undefined}
      title={signal ? label : undefined}
      aria-label={signal && label !== undefined ? label : undefined}
      aria-hidden={signal && label !== undefined ? undefined : true}
      {...dataAttr}
    >
      {signal ? <span aria-hidden className={DOT_CLASS_BY_KIND[kind]} /> : null}
    </span>
  );
}
