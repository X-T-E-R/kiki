import { FeedbackLine, type Feedback } from '../../controls';
import { useI18n } from '../../../i18n';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';

/**
 * The page's save row: discard, save, and the result of the last save.
 *
 * The bar exists only while the draft is dirty — a clean page shows no
 * buttons, so it never reads as a permanent fixture. While it exists it is
 * pinned to the bottom of the settings scroll, the one place a hairline earns
 * its keep (PRINCIPLES #12: sticky bars are real containers). The feedback of
 * the save that just landed still shows on a clean page, in flow, or the
 * result would vanish the moment the draft turns clean.
 */
export function NbSearchActionBar({
  dirty,
  saving,
  feedback,
  onSave,
  onDiscard,
}: {
  dirty: boolean;
  saving: boolean;
  feedback: Feedback;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const { t } = useI18n();
  if (!dirty) {
    return feedback === null ? null : (
      <div className="mt-2 pt-3" data-search-action-bar>
        <FeedbackLine feedback={feedback} />
      </div>
    );
  }

  return (
    <div
      className="sticky bottom-[calc(-1*var(--settings-scroll-pb,0px))] z-10 mt-2 flex flex-wrap items-center gap-2 border-t border-hairline bg-canvas/95 py-3 backdrop-blur-sm"
      data-search-action-bar
    >
      <span role="status" className="shrink-0 text-[12px] text-ink-faint" data-dirty-indicator>
        {t('st.draft.unsaved')}
      </span>
      <FeedbackLine feedback={feedback} />
      <div className="ml-auto flex items-center justify-end gap-2">
        <button
          type="button"
          className={SECONDARY_BUTTON}
          disabled={saving}
          onClick={onDiscard}
        >
          {t('st.nbSearch.action.discard')}
        </button>
        <button
          type="button"
          className={PRIMARY_BUTTON}
          disabled={saving}
          onClick={onSave}
        >
          {saving ? t('common.saving') : t('st.nbSearch.save')}
        </button>
      </div>
    </div>
  );
}
