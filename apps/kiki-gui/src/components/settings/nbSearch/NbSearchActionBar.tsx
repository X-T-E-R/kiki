import { FeedbackLine, type Feedback } from '../../controls';
import { useI18n } from '../../../i18n';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';

/**
 * The page's save row: dirty state, the result of the last save, and the two
 * buttons, in normal flow at the end of the panel.
 *
 * It used to be pinned to the bottom of the scrolling page, which floated the
 * buttons over whatever sat behind them — on this page that was the key rows
 * and the key-order fields, exactly while they were being edited. Reserve space
 * for a pinned bar and only the end of the scroll is fixed; content in the
 * middle is still covered. In the flow the row costs one scroll and covers
 * nothing. Unsaved state stays visible at the top of the page (the tab bar marks
 * it), so the row does not have to hover to be reachable.
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

  return (
    <div
      className="mt-2 flex flex-col gap-2 border-t border-hairline pt-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-x-3 sm:gap-y-2"
      data-search-action-bar
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {dirty ? (
          <span role="status" className="shrink-0 text-[12px] text-ink-faint" data-dirty-indicator>
            {t('st.draft.unsaved')}
          </span>
        ) : (
          // Not `shrink-0`: the sentence is longer than one narrow row, and a
          // non-shrinking box would run under the save button instead of wrapping.
          <span className="min-w-0 text-[12px] leading-[18px] text-ink-faint">
            {t('st.nbSearch.action.barHint')}
          </span>
        )}
        <FeedbackLine feedback={feedback} />
      </div>

      <div className="flex items-center justify-end gap-2 sm:shrink-0">
        {dirty ? (
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={saving}
            onClick={onDiscard}
          >
            {t('st.nbSearch.action.discard')}
          </button>
        ) : null}
        <button
          type="button"
          className={PRIMARY_BUTTON}
          disabled={saving || !dirty}
          onClick={onSave}
        >
          {saving ? t('common.saving') : t('st.nbSearch.save')}
        </button>
      </div>
    </div>
  );
}
