/**
 * Layout grammar shared by every capability view — the Capabilities page and
 * the settings Skills / MCP / Plugins leaves render the same pieces, so a row
 * or a status reads identically wherever it appears.
 *
 * Quiet by construction (visual baseline §0): hierarchy comes from icons and
 * whitespace, not card borders. A section is a T5 label over rows; a row is
 * icon + name (T3) + one-line fact (T4) + one trailing slot. Hover washes the
 * row in neutral ink, never accent.
 */

import type { ReactNode } from 'react';

import { Icon } from '../icons';

export function CapabilitySection({
  id,
  title,
  count,
  aside,
  children,
}: {
  readonly id?: string;
  readonly title: string;
  readonly count?: number;
  /** Right-aligned control (manage gear, "Add server"). */
  readonly aside?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section id={id} data-capability-section={id} className="min-w-0 scroll-mt-4">
      <div className="flex min-h-8 items-center gap-1.5 border-b border-hairline pb-1.5">
        <h2 className="text-[13px] font-medium text-ink">{title}</h2>
        {count !== undefined ? (
          <span className="text-[12px] text-ink-faint tabular-nums">{count}</span>
        ) : null}
        {aside !== undefined ? <div className="ms-auto flex items-center gap-1">{aside}</div> : null}
      </div>
      <div className="pt-2">{children}</div>
    </section>
  );
}

/** Two columns from 720px; one column below. Rows sit 2px apart. */
export function RowGrid({ children }: { readonly children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-x-6 gap-y-0.5 min-[720px]:grid-cols-2">{children}</div>;
}

export function CapabilityRow({
  icon,
  title,
  meta,
  badge,
  trailing,
  onOpen,
  openLabel,
  dataAttrs,
  tone = 'plain',
}: {
  readonly icon: ReactNode;
  readonly title: string;
  /** One fact line (T4): description, status, counts. */
  readonly meta?: ReactNode;
  /** A T6 text tag inline with the title ("Official", "Needs setup"). */
  readonly badge?: ReactNode;
  /** One trailing control — a toggle, an Install button, a ⋯ menu. */
  readonly trailing?: ReactNode;
  readonly onOpen?: () => void;
  readonly openLabel?: string;
  readonly dataAttrs?: Record<`data-${string}`, string>;
  readonly tone?: 'plain' | 'danger';
}) {
  const body = (
    <>
      {icon}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={`truncate text-[13px] font-medium ${tone === 'danger' ? 'text-danger' : 'text-ink'}`}>{title}</span>
          {badge}
        </span>
        {meta !== undefined ? (
          <span className="mt-0.5 block truncate text-[12px] leading-4 text-ink-faint">{meta}</span>
        ) : null}
      </span>
    </>
  );
  return (
    <div
      {...dataAttrs}
      className="group relative flex min-h-14 min-w-0 items-center gap-3 rounded-lg px-2 py-2 transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] focus-within:bg-ink/[0.04]"
    >
      {onOpen !== undefined ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={openLabel}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink"
        >
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3">{body}</div>
      )}
      {trailing !== undefined ? <div className="flex shrink-0 items-center gap-1">{trailing}</div> : null}
    </div>
  );
}

/** Inline tag: text colour only, no fill (baseline §4.2 rule 5). */
export function Tag({ children, tone = 'faint' }: { readonly children: ReactNode; readonly tone?: 'faint' | 'accent' | 'danger' | 'warn' | 'success' }) {
  const color = tone === 'accent' ? 'text-selected-ink'
    : tone === 'danger' ? 'text-danger'
      : tone === 'warn' ? 'text-amber-ink'
        : tone === 'success' ? 'text-success'
          : 'text-ink-faint';
  return <span className={`shrink-0 text-[11px] font-medium leading-[14px] ${color}`}>{children}</span>;
}

/** Status dot (baseline §7.3): idle is not drawn. */
export function StatusDot({ state, label }: { readonly state: 'ok' | 'busy' | 'error' | 'off' | 'waiting'; readonly label: string }) {
  if (state === 'off') return <span className="sr-only">{label}</span>;
  const color = state === 'ok' ? 'bg-success'
    : state === 'busy' ? 'bg-ink-soft status-dot-busy'
      : state === 'waiting' ? 'bg-accent'
        : 'bg-danger';
  return (
    <span className="inline-flex shrink-0 items-center" title={label}>
      <span aria-hidden className={`h-[7px] w-[7px] rounded-full ${color}`} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** A quiet 32px icon button for section headers and row trailing slots. */
export function IconButton({
  icon,
  glyph,
  label,
  onClick,
  disabled,
  pressed,
  dataAttrs,
}: {
  readonly icon?: Parameters<typeof Icon>[0]['name'];
  /** A drawn mark outside the shared family (same spec), used instead of `icon`. */
  readonly glyph?: ReactNode;
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly pressed?: boolean;
  readonly dataAttrs?: Record<`data-${string}`, string>;
}) {
  return (
    <button
      type="button"
      {...dataAttrs}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-md text-ink-faint transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-11 pointer-coarse:w-11"
    >
      {glyph ?? (icon === undefined ? null : <Icon name={icon} size={16} />)}
    </button>
  );
}

/** Quiet text button — secondary actions that should not look like buttons at rest. */
export const QUIET_BUTTON =
  'inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:opacity-50';

/** The paper-inset segmented control, same geometry as the scope control. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  dataAttribute,
}: {
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (next: T) => void;
  readonly ariaLabel: string;
  readonly dataAttribute?: `data-${string}`;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      {...(dataAttribute === undefined ? {} : { [dataAttribute]: value })}
      className="inline-flex min-w-0 items-center gap-0.5 rounded-[9px] bg-ink/[0.04] p-0.5"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            data-segment={option.value}
            onClick={() => { onChange(option.value); }}
            className={`inline-flex min-h-7 items-center rounded-[7px] px-3 text-[13px] whitespace-nowrap transition-colors duration-[var(--kiki-motion-quick)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink pointer-coarse:min-h-10 ${
              active
                ? 'bg-paper font-medium text-ink shadow-[var(--kiki-sheet-shadow)]'
                : 'text-ink-soft hover:text-ink'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** Quiet empty state: what this means, and the one way forward. */
export function EmptyNote({ title, body, action }: { readonly title: string; readonly body?: string; readonly action?: ReactNode }) {
  return (
    <div className="rounded-lg px-2 py-6" data-capability-empty>
      <p className="text-[13px] text-ink-soft">{title}</p>
      {body !== undefined ? <p className="mt-1 max-w-[62ch] text-[12px] leading-4 text-ink-faint">{body}</p> : null}
      {action !== undefined ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly placeholder: string;
  readonly ariaLabel: string;
}) {
  return (
    <label className="flex h-10 min-w-0 items-center gap-2 rounded-[10px] bg-ink/[0.04] px-3 text-ink-faint ring-1 ring-inset ring-transparent transition-colors duration-[var(--kiki-motion-quick)] focus-within:bg-paper focus-within:ring-hairline-strong">
      <Icon name="search" size={16} />
      <input
        type="search"
        value={value}
        onChange={(event) => { onChange(event.target.value); }}
        onKeyDown={(event) => { if (event.key === 'Escape') onChange(''); }}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint [&::-webkit-search-cancel-button]:hidden"
      />
    </label>
  );
}

/**
 * A disclosure that folds its body with the shared grid-rows transition. The
 * "Advanced" blocks (pinning, provenance, raw manifest) all use this.
 */
export function Disclosure({
  label,
  open,
  onToggle,
  children,
  dataAttrs,
}: {
  readonly label: string;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
  readonly dataAttrs?: Record<`data-${string}`, string>;
}) {
  return (
    <div {...dataAttrs} data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex min-h-8 items-center gap-1.5 rounded-md px-1 text-[13px] font-medium text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink"
      >
        <span aria-hidden className={`flex text-ink-faint transition-transform duration-[var(--kiki-motion-quick)] motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}>
          <Icon name="chevron" size={12} />
        </span>
        {label}
      </button>
      <div className="expand-collapse grid" style={{ gridTemplateRows: open ? '1fr' : '0fr' }}>
        <div className="overflow-hidden" inert={!open}>
          <div className="pt-2 pl-5">{children}</div>
        </div>
      </div>
    </div>
  );
}

/** Label/value pairs for detail facts. */
export function FactList({ items }: { readonly items: readonly { readonly label: string; readonly value: ReactNode; readonly mono?: boolean }[] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[12px] leading-4">
      {items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="text-ink-faint">{item.label}</dt>
          <dd className={`min-w-0 break-words text-ink-soft ${item.mono === true ? 'font-mono' : ''}`}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
