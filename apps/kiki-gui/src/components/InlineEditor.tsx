/**
 * InlineEditor — the in-place tier of the form ladder (see SidePanel for the
 * whole ladder). A row that edits one or two of its own values opens under
 * itself instead of pushing a bare form into the page: the body unfolds with
 * the shared grid-rows transition on a quiet inset surface, and is inert
 * while closed so its fields leave the tab order. Keep the body mounted when
 * a half-typed draft should survive a collapse; otherwise pass `lazy`.
 */

import type { ReactNode } from 'react';

export function InlineEditor({ open, id, lazy = false, className = '', children }: {
  open: boolean;
  /** Target of the trigger's `aria-controls`. */
  id?: string;
  /** Render the body only while open (a fresh draft on every open). */
  lazy?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div id={id} data-inline-editor={open ? 'open' : 'closed'} className="expand-collapse grid" style={{ gridTemplateRows: open ? '1fr' : '0fr' }} inert={!open}>
      <div className="min-h-0 overflow-hidden">
        {open || !lazy ? <div className={`rounded-lg bg-ink/[0.03] p-3 ${className}`}>{children}</div> : null}
      </div>
    </div>
  );
}
