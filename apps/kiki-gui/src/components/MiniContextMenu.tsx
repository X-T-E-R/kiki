/**
 * MiniContextMenu — the small fixed-position context menu shared by the
 * link/file-path surfaces (markdown anchors, file chips, preview tabs).
 *
 * On a coarse pointer the entries render as an `ActionSheet`; desktop mounts
 * `MiniContextPointerMenu` lazily on demand.
 */

import { lazyComponent } from '../lib/lazyComponent';
import { useCoarsePointer } from '../lib/layoutHooks';
import { runToastAction } from '../lib/toasts';

const ActionSheet = lazyComponent(() =>
  import('./overlays/ActionSheet').then((m) => m.ActionSheet),
);
const LazyMiniContextPointerMenu = lazyComponent(() =>
  import('./ComposerPopovers').then((m) => m.MiniContextPointerMenu),
);

if (import.meta.env.MODE === 'test') {
  await Promise.all([ActionSheet.preload(), LazyMiniContextPointerMenu.preload()]);
}

export type MiniMenuEntry =
  | {
      readonly key: string;
      readonly label: string;
      readonly danger?: boolean;
      readonly disabled?: boolean;
      readonly run: () => void | Promise<void>;
    }
  | { readonly separator: true };

export interface MiniContextMenuProps {
  readonly x: number;
  readonly y: number;
  readonly entries: readonly MiniMenuEntry[];
  readonly onClose: () => void;
  readonly ariaLabel: string;
  readonly overlayId: string;
  readonly dataAttribute: string;
  readonly itemDataAttribute?: string;
  readonly modalOwnerId?: string;
  readonly autofocus?: boolean;
}

export function MiniContextMenu(props: MiniContextMenuProps) {
  const coarse = useCoarsePointer();
  if (!coarse) return <LazyMiniContextPointerMenu {...props} />;
  const { entries, onClose, ariaLabel, overlayId, dataAttribute, itemDataAttribute = 'data-menu-item', modalOwnerId, autofocus = true } = props;
  return (
    <ActionSheet
      ariaLabel={ariaLabel}
      overlayId={overlayId}
      onClose={onClose}
      dataAttribute={dataAttribute}
      modalOwnerId={modalOwnerId}
      autofocus={autofocus}
    >
      {menuItems(entries, onClose, itemDataAttribute)}
    </ActionSheet>
  );
}

export function menuItems(entries: readonly MiniMenuEntry[], onClose: () => void, itemDataAttribute: string) {
  return entries.map((entry, index) =>
    'separator' in entry ? (
      <div key={`sep-${index}`} className="mx-1 my-1 border-t border-hairline" />
    ) : (
      <button
        key={entry.key}
        type="button"
        role="menuitem"
        {...{ [itemDataAttribute]: entry.key }}
        disabled={entry.disabled}
        className={`w-full rounded-md px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-paper focus-visible:bg-paper disabled:pointer-events-none disabled:opacity-45 ${
          entry.danger === true ? 'text-ink hover:text-danger' : 'text-ink'
        }`}
        onClick={() => {
          onClose();
          runToastAction(entry.label, entry.run);
        }}
      >
        {entry.label}
      </button>
    ),
  );
}
