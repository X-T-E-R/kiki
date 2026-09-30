/**
 * Board glyphs: one status mark shared by column headers, cards and the
 * detail status list, plus a signal-bar priority mark. Line-drawn at 16px so
 * they sit on the text baseline; tone comes from the status, never from
 * decoration (orange stays reserved for in-progress work).
 */

import type { BoardTaskStatus, TaskPriority } from './types';

const STATUS_TONE: Record<BoardTaskStatus, string> = {
  active: 'text-ink-soft',
  todo: 'text-ink-soft',
  backlog: 'text-ink-faint',
  in_progress: 'text-ink-soft',
  running: 'text-ink-soft',
  paused: 'text-amber-ink',
  done: 'text-success',
  cancelled: 'text-ink-faint',
  superseded: 'text-ink-faint',
  failed: 'text-danger',
};

export function statusTone(status: BoardTaskStatus): string {
  return STATUS_TONE[status];
}

export function StatusGlyph({ status, className = 'h-3.5 w-3.5' }: { readonly status: BoardTaskStatus; readonly className?: string }) {
  const tone = STATUS_TONE[status];
  const common = { 'aria-hidden': true, viewBox: '0 0 16 16', fill: 'none', className: `${className} shrink-0 ${tone}` } as const;
  switch (status) {
    case 'in_progress':
    case 'running':
      return (
        <svg {...common} data-status-glyph={status}>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 4.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" />
        </svg>
      );
    case 'paused':
      return (
        <svg {...common} data-status-glyph={status}>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6.6 5.8v4.4M9.4 5.8v4.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case 'done':
      return (
        <svg {...common} data-status-glyph={status}>
          <circle cx="8" cy="8" r="6.75" fill="currentColor" />
          <path d="m5.3 8.2 1.8 1.8 3.6-3.8" stroke="var(--color-panel)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'cancelled':
    case 'failed':
      return (
        <svg {...common} data-status-glyph={status}>
          <circle cx="8" cy="8" r="6.75" fill="currentColor" />
          <path d="m5.9 5.9 4.2 4.2m0-4.2-4.2 4.2" stroke="var(--color-panel)" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case 'superseded':
      return (
        <svg {...common} data-status-glyph={status}>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
          <path d="M5.4 8h5m-1.9-2 2 2-2 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'backlog':
      return (
        <svg {...common} data-status-glyph={status}>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.4 2.2" />
        </svg>
      );
    default:
      return (
        <svg {...common} data-status-glyph={status}>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
  }
}

const PRIORITY_BARS: Record<Exclude<TaskPriority, 'urgent'>, number> = { high: 3, medium: 2, low: 1 };

/** Signal bars (P1 three, P2 two, P3 one); P0 is a filled danger square. */
export function PriorityGlyph({ priority, className = 'h-3.5 w-3.5' }: { readonly priority: TaskPriority; readonly className?: string }) {
  if (priority === 'urgent') {
    return (
      <svg aria-hidden viewBox="0 0 16 16" className={`${className} shrink-0 text-danger`} data-priority-glyph={priority}>
        <rect x="1.5" y="1.5" width="13" height="13" rx="3.5" fill="currentColor" />
        <path d="M8 4.6v4.2" stroke="var(--color-panel)" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="8" cy="11.2" r="1.05" fill="var(--color-panel)" />
      </svg>
    );
  }
  const lit = PRIORITY_BARS[priority];
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={`${className} shrink-0 text-ink-soft`} data-priority-glyph={priority}>
      {[0, 1, 2].map((index) => (
        <rect
          key={index}
          x={2 + index * 4.5}
          y={10 - index * 3.5}
          width="3"
          height={4 + index * 3.5}
          rx="0.9"
          fill="currentColor"
          opacity={index < lit ? 1 : 0.28}
        />
      ))}
    </svg>
  );
}

export function FolderGlyph({ className = 'h-3.5 w-3.5' }: { readonly className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={`${className} shrink-0`} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M2.2 4.4c0-.6.5-1.1 1.1-1.1h3l1.3 1.5h5.1c.6 0 1.1.5 1.1 1.1v6.3c0 .6-.5 1.1-1.1 1.1H3.3c-.6 0-1.1-.5-1.1-1.1z" />
    </svg>
  );
}

/** Conversation bubble for linked-session counts and session rows. */
export function SessionGlyph({ className = 'h-3.5 w-3.5' }: { readonly className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={`${className} shrink-0`} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M3 3.5h10c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H8.2L5 13.8v-2.3H3c-.6 0-1-.4-1-1v-6c0-.6.4-1 1-1z" />
    </svg>
  );
}
