import { FeedbackLine, type Feedback } from '../../controls';
import { useI18n } from '../../../i18n';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';

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
    <div className="sticky bottom-0 z-10 -mx-4 -mb-4 mt-6 border-t border-hairline bg-panel/95 backdrop-blur-xs px-4 py-3 shadow-xs" data-search-action-bar>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {dirty ? (
            <span
              className="flex items-center gap-1.5 rounded-full bg-amber-card border border-amber-rule/60 px-2.5 py-0.5 text-[11px] font-medium text-amber-ink"
              data-dirty-indicator
            >
              <span className="h-1.5 w-1.5 rounded-full bg-amber-ink animate-pulse" />
              {t('st.tools.unsaved')}
            </span>
          ) : (
            <span className="text-[11.5px] text-ink-faint">
              {t('st.nbSearch.action.barHint')}
            </span>
          )}
          <FeedbackLine feedback={feedback} />
        </div>

        <div className="flex items-center gap-2">
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
    </div>
  );
}
