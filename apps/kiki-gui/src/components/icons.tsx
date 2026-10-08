/**
 * The GUI's one icon family. Every drawn mark in the app comes from here.
 *
 * Spec: a 16px viewBox with content kept inside the 2–14 box, a 1.35 stroke,
 * round caps and joins, no fill, `stroke="currentColor"`. Three rendered
 * sizes only: 12 (inline — relation marks, chevrons, tag prefixes), 14
 * (timeline row heads, row actions) and 16 (navigation, header buttons).
 * Colour is inherited from the text; resting marks sit at `ink-faint`.
 *
 * Unicode glyphs (◧ ⌕ ✎ ☰ ⋯ × ✓ ▸) are never icons: they come from different
 * fonts with different weights and baselines, and a column of them cannot
 * read as one axis.
 *
 * An icon names a KIND of thing, never an outcome. Outcome belongs to
 * `OutcomeMark`, whose rule is that success is silent.
 */

import type { ReactNode } from 'react';

export type IconName =
  // Activity kinds (timeline row heads)
  | 'read'
  | 'search'
  | 'edit'
  | 'terminal'
  | 'web'
  | 'agent'
  | 'skill'
  | 'plan'
  | 'task'
  | 'goal'
  | 'memory'
  | 'think'
  | 'system'
  | 'clock'
  | 'gate'
  | 'ask'
  | 'file'
  | 'tool'
  // Outcome and state marks
  | 'check'
  | 'cross'
  | 'dash'
  | 'warning'
  // On-demand help beside a label or control.
  | 'info'
  | 'hold'
  // Controls
  | 'chevron'
  | 'close'
  | 'menu'
  | 'more'
  | 'plus'
  | 'arrowRight'
  | 'arrowDown'
  | 'external'
  | 'folder'
  | 'panel'
  | 'filter'
  | 'sliders'
  | 'pin'
  | 'settings'
  | 'arrowLeft'
  | 'arrowUp'
  | 'arrowUpRight'
  | 'expand'
  | 'collapse'
  | 'grip'
  | 'stop'
  | 'quote'
  | 'star'
  | 'starFilled'
  | 'dot'
  | 'ring'
  | 'partial'
  | 'eye'
  | 'eyeOff'
  | 'copy'
  // Places and relations
  | 'board'
  | 'usage'
  | 'bell'
  | 'notes'
  | 'persona'
  | 'branch'
  | 'room'
  | 'thread'
  | 'compass';

export type IconSize = 12 | 14 | 16;

const SIZE_CLASS: Record<IconSize, string> = {
  12: 'h-3 w-3',
  14: 'h-3.5 w-3.5',
  16: 'h-4 w-4',
};

const PATHS: Record<IconName, ReactNode> = {
  // A page with its fold: something was looked at.
  read: (
    <>
      <path d="M4 2.5h5.2L12 5.3v8.2H4z" />
      <path d="M9 2.5v3h3" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.2" />
      <path d="m10.2 10.2 3.3 3.3" />
    </>
  ),
  edit: (
    <>
      <path d="M10.4 2.9 13.1 5.6 6 12.7l-3.2.5.5-3.2z" />
      <path d="m9.2 4.1 2.7 2.7" />
    </>
  ),
  terminal: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.8" />
      <path d="m5 6.5 2 1.5-2 1.5M8.5 10H11" />
    </>
  ),
  web: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M2.4 8h11.2M8 2.2c1.7 1.6 2.5 3.6 2.5 5.8s-.8 4.2-2.5 5.8C6.3 12.2 5.5 10.2 5.5 8S6.3 3.8 8 2.2z" />
    </>
  ),
  // Two offset frames: work handed to another agent.
  agent: (
    <>
      <rect x="2.5" y="2.5" width="7.5" height="7.5" rx="1.6" />
      <path d="M6 13.5h5.9a1.6 1.6 0 0 0 1.6-1.6V6" />
    </>
  ),
  skill: <path d="M8 2.3 9.4 6.6l4.3 1.4-4.3 1.4L8 13.7 6.6 9.4 2.3 8l4.3-1.4z" />,
  plan: <path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8M2.5 4.5h.01M2.5 8h.01M2.5 11.5h.01" />,
  task: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M6.8 5.6v4.8L10.4 8z" />
    </>
  ),
  goal: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <circle cx="8" cy="8" r="2.4" />
    </>
  ),
  // A four-point spark: something kept for later. Drawn, not the ✦ glyph.
  memory: <path d="M8 2.5c.5 3 2.5 5 5.5 5.5-3 .5-5 2.5-5.5 5.5-.5-3-2.5-5-5.5-5.5 3-.5 5-2.5 5.5-5.5z" />,
  think: (
    <>
      <path d="M5.2 11.3a4.3 4.3 0 1 1 5.6 0v1.2H5.2z" />
      <path d="M6.3 14h3.4" />
    </>
  ),
  system: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M5.5 6.5h5M5.5 9.5h3" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 4.8V8l2.2 1.4" />
    </>
  ),
  // A shield: a decision point, whatever the outcome.
  gate: <path d="M8 2.2 13 4v3.6c0 3-2.1 5.2-5 6.2-2.9-1-5-3.2-5-6.2V4z" />,
  ask: <path d="M3 3.5h10c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H8.2L5 13.8v-2.3H3c-.6 0-1-.4-1-1v-6c0-.6.4-1 1-1z" />,
  // An attachment: a page without the reading fold, with a clip line.
  file: (
    <>
      <path d="M4 2.5h5.2L12 5.3v8.2H4z" />
      <path d="M6.2 8.2h3.6M6.2 10.6h2.4" />
    </>
  ),
  tool: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 2.3v1.9M8 11.8v1.9M2.3 8h1.9M11.8 8h1.9M4 4l1.3 1.3M10.7 10.7 12 12M4 12l1.3-1.3M10.7 5.3 12 4" />
    </>
  ),
  check: <path d="m3.5 8.4 2.9 2.9 6.1-6.6" />,
  cross: <path d="m4.3 4.3 7.4 7.4m0-7.4-7.4 7.4" />,
  dash: <path d="M4 8h8" />,
  warning: (
    <>
      <path d="M8 2.6 13.8 13H2.2z" />
      <path d="M8 6.6v2.8M8 11.3h.01" />
    </>
  ),
  // A circled question: the fine print behind a label, one hover away.
  info: (
    <>
      <circle cx="8" cy="8" r="5.9" />
      <path d="M6.5 6.4a1.6 1.6 0 1 1 2.2 1.5c-.5.2-.7.5-.7 1v.4M8 11.4h.01" />
    </>
  ),
  // A partly filled dial: something held back, waiting to resume.
  hold: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M6.6 5.8v4.4M9.4 5.8v4.4" />
    </>
  ),
  chevron: <path d="m6 3.8 4.2 4.2L6 12.2" />,
  close: <path d="m4.5 4.5 7 7m0-7-7 7" />,
  menu: <path d="M2.8 4.5h10.4M2.8 8h10.4M2.8 11.5h10.4" />,
  more: <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth={2.2} />,
  plus: <path d="M8 3v10M3 8h10" />,
  arrowRight: <path d="M3 8h10m-3.8-3.8L13 8l-3.8 3.8" />,
  arrowDown: <path d="M8 3v10m-3.8-3.8L8 13l3.8-3.8" />,
  external: <path d="M6.5 3H3.5a1 1 0 0 0-1 1v8.5a1 1 0 0 0 1 1H12a1 1 0 0 0 1-1V9.5M9.5 2.5h4v4M13.5 2.5 7.5 8.5" />,
  // A folder with its tab: a place in the file manager.
  folder: <path d="M13.5 11.3a1.2 1.2 0 0 1-1.2 1.2H3.7a1.2 1.2 0 0 1-1.2-1.2V3.9a1.2 1.2 0 0 1 1.2-1.2h2.7l1.3 1.9h4.6a1.2 1.2 0 0 1 1.2 1.2z" />,
  panel: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.6" />
      <path d="M10 3v10" />
    </>
  ),
  filter: <path d="M2.5 3.5h11l-4.2 5v4l-2.6 1v-5z" />,
  sliders: (
    <>
      <path d="M2.5 4.5h7M13.5 4.5h0M2.5 8h2M7.5 8h6M2.5 11.5h6M12 11.5h1.5" />
      <circle cx="11" cy="4.5" r="1.5" />
      <circle cx="6" cy="8" r="1.5" />
      <circle cx="10.5" cy="11.5" r="1.5" />
    </>
  ),
  pin: <path d="M9.6 2.2 13.8 6.4l-1.5 1.5-1-.3-2.8 2.8.4 3.1-1 1-2.4-3.4-3 2.2 4.7-5.3-.3-1 2.8-2.8-.3-1z" />,
  board: (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1.8" />
      <path d="M6 2.5v11M10 2.5v7" />
    </>
  ),
  usage: <path d="M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V6.5" />,
  // A kept leaf of notes with a folded corner: the Memory page (a place).
  // The spark (`memory`) is the ACT of remembering in the timeline.
  notes: (
    <>
      <path d="M3.4 2.5h7.3l2 2v9a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z" />
      <path d="M5.2 6.4h4.4M5.2 9h3" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" />
    </>
  ),
  arrowLeft: <path d="M13 8H3m3.8-3.8L3 8l3.8 3.8" />,
  arrowUp: <path d="M8 13V3M4.2 6.8 8 3l3.8 3.8" />,
  arrowUpRight: <path d="M4.5 11.5 11.5 4.5M5.5 4.5h6v6" />,
  expand: <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9.3 6.7M2.5 13.5l4.2-4.2" />,
  collapse: <path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5l4-4M6.5 9.5l-4 4" />,
  // Six dots: a drag handle.
  grip: <path d="M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01" strokeWidth={2.2} />,
  stop: <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="currentColor" />,
  quote: <path d="M3 11.5c0-3 1-5 3.5-6M9 11.5c0-3 1-5 3.5-6M3 11.5h2.6V9H3zM9 11.5h2.6V9H9z" />,
  star: <path d="M8 2l1.6 3.4 3.7.5-2.7 2.6.7 3.7L8 10.4l-3.3 1.8.7-3.7L2.7 5.9l3.7-.5z" />,
  starFilled: <path d="M8 2l1.6 3.4 3.7.5-2.7 2.6.7 3.7L8 10.4l-3.3 1.8.7-3.7L2.7 5.9l3.7-.5z" fill="currentColor" />,
  // A solid state dot (unsaved, in progress) and its hollow counterpart.
  dot: <circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" />,
  ring: <circle cx="8" cy="8" r="4.5" />,
  // A dial a quarter filled: an estimate or partial figure (unknown price).
  partial: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 8V2.2A5.8 5.8 0 0 1 13.8 8z" fill="currentColor" />
    </>
  ),
  bell: (
    <>
      <path d="M4.2 7a3.8 3.8 0 0 1 7.6 0v2.4l1 1.6H3.2l1-1.6z" />
      <path d="M6.6 12.4a1.5 1.5 0 0 0 2.8 0" />
    </>
  ),
  // A split: a branch forked off another session's history.
  branch: (
    <>
      <circle cx="4.5" cy="3.8" r="1.3" />
      <circle cx="4.5" cy="12.2" r="1.3" />
      <circle cx="11.5" cy="6.2" r="1.3" />
      <path d="M4.5 5.1v5.8M11.5 7.5c0 2.2-2 2.9-7 3.4" />
    </>
  ),
  // Secret-field controls: show / hide a value, copy it.
  eye: (
    <>
      <path d="M1.8 8S4.2 3.6 8 3.6 14.2 8 14.2 8 11.8 12.4 8 12.4 1.8 8 1.8 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M6.3 4c.5-.2 1.1-.4 1.7-.4 3.8 0 6.2 4.4 6.2 4.4a11 11 0 0 1-1.6 2.1M10 11.8a4.8 4.8 0 0 1-2 .6C4.2 12.4 1.8 8 1.8 8a11 11 0 0 1 2.3-2.8" />
      <path d="M6.6 6.6a2 2 0 0 0 2.8 2.8M2.5 2.5l11 11" />
    </>
  ),
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" />
      <path d="M10.5 5.5V4.1a1.6 1.6 0 0 0-1.6-1.6H4.1a1.6 1.6 0 0 0-1.6 1.6v4.8a1.6 1.6 0 0 0 1.6 1.6h1.4" />
    </>
  ),
  // An arrow leaving a line: a session another session started.
  thread: <path d="M4 2.8v5.4c0 1.4 1.1 2.5 2.5 2.5H12m-2.6-2.6 2.6 2.6-2.6 2.6" />,
  // A hash: a room is a named group (# is how the sidebar and chips write it).
  room: <path d="M6.3 2.6 5.2 13.4M10.9 2.6 9.8 13.4M3 5.6h10.4M2.6 10.4H13" />,
  // A face on a kept card: the Personas page (who, not what it can do).
  persona: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="3" />
      <circle cx="8" cy="6.8" r="1.8" />
      <path d="M4.9 11.6c.6-1.4 1.7-2.1 3.1-2.1s2.5.7 3.1 2.1" />
    </>
  ),
  compass: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <polygon points="10.8,5.2 6.8,7.2 5.2,10.8 9.2,8.8" />
    </>
  ),
};

interface IconProps {
  readonly name: IconName;
  /** One of the three family sizes. Ignored when `className` sets its own box. */
  readonly size?: IconSize;
  /** Extra classes (colour, rotation). A class containing `h-` replaces the size box. */
  readonly className?: string;
}

/** One family icon, decorative by default (`aria-hidden`). */
export function Icon({ name, size = 14, className = '' }: IconProps) {
  const box = /(^|\s)h-/.test(className) ? '' : SIZE_CLASS[size];
  return (
    <svg
      aria-hidden
      data-icon={name}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.35}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${box} ${className}`.trim()}
    >
      {PATHS[name]}
    </svg>
  );
}

/**
 * Disclosure chevron: points right when closed and turns down when open.
 * `className` replaces the default `ink-faint` colour.
 */
export function DisclosureChevron({
  open,
  size = 12,
  className = 'text-ink-faint',
}: {
  readonly open: boolean;
  readonly size?: IconSize;
  readonly className?: string;
}) {
  return (
    <Icon
      name="chevron"
      size={size}
      className={`transition-transform duration-[var(--kiki-motion-quick)] ease-out motion-reduce:transition-none ${open ? 'rotate-90' : ''} ${className}`}
    />
  );
}

/** Running mark: a faint ring with a moving arc, in the 14px box. */
export function Spinner({ label, size = 14 }: { readonly label: string; readonly size?: IconSize }) {
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox="0 0 16 16"
      fill="none"
      className={`spinner shrink-0 text-ink-soft ${SIZE_CLASS[size]}`}
    >
      <circle cx="8" cy="8" r="5.8" stroke="currentColor" strokeOpacity="0.22" strokeWidth={1.35} />
      <path d="M13.8 8A5.8 5.8 0 0 0 8 2.2" stroke="currentColor" strokeWidth={1.35} strokeLinecap="round" />
    </svg>
  );
}

export type OutcomeState = 'running' | 'failed' | 'stopped' | 'done';

export interface OutcomeLabels {
  readonly running: string;
  readonly failed: string;
  readonly stopped: string;
  readonly done: string;
}

/**
 * The one outcome-mark rule: running spins, failure crosses, a stop is an
 * amber dash, and SUCCESS IS SILENT. A column of success marks trains the eye
 * to skip the column, and then the one failure in it gets skipped too. The
 * done state keeps a visually hidden label so assistive tech still hears it.
 */
export function OutcomeMark({
  state,
  labels,
  title,
}: {
  readonly state: OutcomeState;
  readonly labels: OutcomeLabels;
  readonly title?: string;
}) {
  switch (state) {
    case 'running':
      return <Spinner label={labels.running} />;
    case 'failed':
      return (
        <span role="img" aria-label={labels.failed} title={title} data-outcome="failed" className="text-danger">
          <Icon name="cross" />
        </span>
      );
    case 'stopped':
      return (
        <span role="img" aria-label={labels.stopped} title={title} data-outcome="stopped" className="text-amber-rule">
          <Icon name="dash" />
        </span>
      );
    case 'done':
      return <span className="sr-only">{labels.done}</span>;
  }
}
