/**
 * "Applies to": which agents the prompt text below is written for.
 *
 * Prompts are the one part of a model with a real per-identity layer people
 * edit by hand, so the choice lives in the Prompts tab and nowhere else. It
 * re-points the editors below and writes nothing by itself. An identity that
 * already carries its own prompts says so on its segment.
 */

import { useI18n } from '../../i18n';
import { EDIT_SCOPES, SCOPE_LABEL, type EditScope } from './modelEditScope';

export function ModelEditScopeSwitch({ scope, customized, onScopeChange }: {
  scope: EditScope;
  /** Identities whose prompts differ from the shared ones. */
  customized: ReadonlySet<EditScope>;
  onScopeChange: (scope: EditScope) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2" data-model-edit-scope={scope} data-model-edit-scope-switch>
      <span id="model-scope-label" className="text-[12px] font-medium text-ink-soft">{t('st.modelScope.appliesTo')}</span>
      <div role="radiogroup" aria-labelledby="model-scope-label"
        className="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-md bg-ink/[0.04] p-0.5">
        {EDIT_SCOPES.map((value) => {
          const selected = value === scope;
          const marked = customized.has(value);
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={selected}
              data-model-scope-choice={value}
              data-model-scope-customized={marked ? '' : undefined}
              onClick={() => { if (!selected) onScopeChange(value); }}
              className={`inline-flex h-7 items-center gap-1.5 rounded-[5px] px-3 text-[12.5px] transition-colors focus-visible:ring-2 focus-visible:ring-selected-ink/40 pointer-coarse:h-9 ${
                selected
                  ? 'bg-panel font-medium text-ink shadow-[var(--kiki-sheet-shadow)]'
                  : 'text-ink-soft hover:text-ink'
              }`}
            >
              {t(SCOPE_LABEL[value])}
              {marked ? <span aria-hidden className="size-1.5 rounded-full bg-selected-ink" /> : null}
              {marked ? <span className="sr-only">{t('st.modelScope.customized')}</span> : null}
            </button>
          );
        })}
      </div>
      {scope !== 'shared' && customized.has(scope) ? (
        <span className="text-[11.5px] text-selected-ink" data-model-scope-summary>{t('st.modelScope.customized')}</span>
      ) : null}
    </div>
  );
}
