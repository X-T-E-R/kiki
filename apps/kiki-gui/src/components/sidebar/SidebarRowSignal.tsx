/**
 * Strict 2-state visual presentation for left-sidebar navigation rows
 * (sessions, persona parent/child rows, room rows, and search rows).
 *
 * State A (`signal = true`: executing || hasActionableWait || unread):
 *   one still, filled 6px neutral ink disc in a fixed 8px slot + ink title.
 * State B (`signal = false`: idle && read):
 *   same 8px slot left empty + soft ink title.
 */

export type SidebarRowPresentation = 'signal' | 'normal';

export function sidebarRowPresentation(signal: boolean): SidebarRowPresentation {
  return signal ? 'signal' : 'normal';
}

export function SidebarRowDot({
  signal,
  label,
  dataAttr,
}: {
  readonly signal: boolean;
  readonly label?: string;
  readonly dataAttr?: Readonly<Record<string, string | undefined>>;
}) {
  return (
    <span
      className="flex h-5 w-2 shrink-0 items-center justify-center"
      data-sidebar-signal={signal ? 'active' : 'normal'}
      title={signal ? label : undefined}
      aria-label={signal && label !== undefined ? label : undefined}
      aria-hidden={signal && label !== undefined ? undefined : true}
      {...dataAttr}
    >
      {signal ? (
        <span aria-hidden className="block h-1.5 w-1.5 rounded-full bg-ink" />
      ) : null}
    </span>
  );
}
