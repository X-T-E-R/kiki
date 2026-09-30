/**
 * Workspace scope control for the routed tool pages (task board, scheduled
 * tasks). The active scope is always a filled segment, so "which workspaces am
 * I looking at" reads at a glance. With a handful of workspaces every one is
 * its own segment (one click to switch); past that the second segment turns
 * into a picker so the row never wraps into a wall of names.
 *
 * Presentation only: `value` is the caller's scope (`undefined` = all
 * workspaces) and `onChange` hands back the same shape.
 */

import type { Workspace } from '@kiki/protocol';

import { useI18n } from '../i18n';
import { Icon } from './icons';

/** At or below this count every workspace gets its own segment. */
const INLINE_SEGMENT_LIMIT = 4;

const SEGMENT =
  'inline-flex h-8 min-w-0 max-w-48 items-center gap-1.5 rounded-[7px] px-2.5 text-[13px] whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink';
const SEGMENT_ON = 'bg-panel font-medium text-ink shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.12)] ring-1 ring-hairline-strong';
const SEGMENT_OFF = 'text-ink-soft hover:bg-panel/60 hover:text-ink';

/**
 * One segment of a paper-inset segmented control: the active segment lifts to
 * a panel chip with a hairline ring (no accent fill, so a row of controls
 * reads as state rather than as a row of orange buttons). `size` overrides
 * the default 32px height/padding for denser rows.
 */
export function segmentClass(active: boolean, size = ''): string {
  const base = size === ''
    ? SEGMENT
    : 'inline-flex min-w-0 items-center gap-1.5 rounded-[7px] whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink';
  return `${base} ${size} ${active ? SEGMENT_ON : SEGMENT_OFF}`;
}

function FolderGlyph({ active }: { readonly active: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={`h-3.5 w-3.5 shrink-0 ${active ? 'text-accent' : 'text-ink-faint'}`} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M2.2 4.4c0-.6.5-1.1 1.1-1.1h3l1.3 1.5h5.1c.6 0 1.1.5 1.1 1.1v6.3c0 .6-.5 1.1-1.1 1.1H3.3c-.6 0-1.1-.5-1.1-1.1z" />
    </svg>
  );
}

function StackGlyph({ active }: { readonly active: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={`h-3.5 w-3.5 shrink-0 ${active ? 'text-accent' : 'text-ink-faint'}`} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M8 2.5 13.5 5 8 7.5 2.5 5z" />
      <path d="m2.5 8 5.5 2.5L13.5 8M2.5 11l5.5 2.5 5.5-2.5" />
    </svg>
  );
}

export function WorkspaceScopeControl({
  workspaces,
  value,
  onChange,
  dataAttribute = 'data-workspace-scope',
}: {
  readonly workspaces: readonly Pick<Workspace, 'id' | 'name'>[];
  readonly value: string | undefined;
  readonly onChange: (next: string | undefined) => void;
  /** Hook for tests and proofs; lands on the group element. */
  readonly dataAttribute?: string;
}) {
  const { t } = useI18n();
  const allActive = value === undefined;
  const inline = workspaces.length <= INLINE_SEGMENT_LIMIT;
  const selected = workspaces.find((workspace) => workspace.id === value);
  const groupProps = { [dataAttribute]: value ?? 'all' };

  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-[12px] text-ink-faint">{t('scope.prefix')}</span>
      <div
        role="group"
        aria-label={t('scope.switchAria')}
        {...groupProps}
        className="flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-[9px] border border-hairline bg-paper p-0.5"
      >
        <button
          type="button"
          data-scope-option="all"
          aria-pressed={allActive}
          onClick={() => { onChange(undefined); }}
          className={`${SEGMENT} shrink-0 ${allActive ? SEGMENT_ON : SEGMENT_OFF}`}
        >
          <StackGlyph active={allActive} />
          {t('scope.all')}
        </button>
        {inline ? (
          workspaces.map((workspace) => {
            const active = workspace.id === value;
            return (
              <button
                key={workspace.id}
                type="button"
                data-scope-option={workspace.id}
                aria-pressed={active}
                title={workspace.name}
                onClick={() => { onChange(workspace.id); }}
                className={`${SEGMENT} ${active ? SEGMENT_ON : SEGMENT_OFF}`}
              >
                <FolderGlyph active={active} />
                <span className="min-w-0 truncate">{workspace.name}</span>
              </button>
            );
          })
        ) : (
          <span className={`relative ${SEGMENT} p-0 ${selected !== undefined ? SEGMENT_ON : SEGMENT_OFF}`}>
            <span className="pointer-events-none absolute left-2.5"><FolderGlyph active={selected !== undefined} /></span>
            <select
              data-scope-picker
              aria-label={t('scope.switchAria')}
              value={selected?.id ?? ''}
              onChange={(event) => { onChange(event.target.value === '' ? undefined : event.target.value); }}
              className="h-8 min-w-0 max-w-48 cursor-pointer appearance-none truncate rounded-[7px] bg-transparent pr-6 pl-7 text-[13px] text-inherit focus-visible:outline-none"
            >
              <option value="">{t('scope.label')}…</option>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
              ))}
            </select>
            <Icon name="chevron" size={12} className="pointer-events-none absolute right-2 rotate-90 text-ink-faint" />
          </span>
        )}
      </div>
    </div>
  );
}
