/**
 * The one mark a worktree session carries: a branch glyph and the branch
 * name, quiet (ink-soft) and truncating. The tooltip says where the checkout
 * came from; ordinary sessions render nothing.
 */

import type { Session } from '@kiki/protocol';

import { useI18n } from '../i18n';
import { Icon } from './icons';

export function worktreeTooltip(
  t: ReturnType<typeof useI18n>['t'],
  worktree: NonNullable<Session['worktree']>,
): string {
  return t('worktree.markTitle', { branch: worktree.branch, source: worktree.source_root, base: worktree.base_ref });
}

export function WorktreeMark({
  worktree,
  className = '',
}: {
  worktree: Session['worktree'];
  className?: string;
}) {
  const { t } = useI18n();
  if (worktree === undefined) return null;
  const tooltip = worktreeTooltip(t, worktree);
  return (
    <span
      data-worktree-mark={worktree.worktree_id}
      title={tooltip}
      className={`inline-flex min-w-0 items-center gap-1 text-[12px] leading-4 text-ink-soft ${className}`}
    >
      <Icon name="branch" size={12} className="text-ink-faint" />
      <span className="min-w-0 truncate font-mono text-[11.5px]">{worktree.branch}</span>
      <span className="sr-only">{tooltip}</span>
    </span>
  );
}
