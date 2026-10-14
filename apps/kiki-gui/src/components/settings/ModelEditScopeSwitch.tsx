/**
 * The scope selector at the top of the model editor.
 *
 * One row, at the top, answering "which layer am I editing". It replaces the
 * per-group switches that each used to govern only their own fields. It does
 * not sit beside a second copy of any form: switching it re-points the rows
 * below, and it writes nothing by itself.
 *
 * All three identities stay visible. `independent` is a real identity with its
 * own prompt branches, and offering it only once it already has a usage entry
 * would hide the branch someone is about to create.
 */

import { useI18n } from '../../i18n';
import { Hint } from '../controls';
import { SettingsSegmented } from './SettingsPrimitives';
import { EDIT_SCOPES, SCOPE_HINT, SCOPE_LABEL, type EditScope } from './modelEditScope';

export function ModelEditScopeSwitch({ scope, summary, differences, onScopeChange }: {
  scope: EditScope;
  /**
   * What this identity already differs on, as real words: "usage: 2 fields ·
   * prompt: custom". A colour chip per field would have to be explained; a
   * sentence naming the groups is readable without a legend.
   */
  summary: string | undefined;
  /** The numeric count behind the sentence, for readers and tests. */
  differences: number;
  onScopeChange: (scope: EditScope) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      className="inline-flex max-w-full flex-wrap items-center gap-2"
      data-model-edit-scope={scope}
      data-model-edit-scope-switch
      role="radiogroup"
      aria-label={t('st.modelScope.scopeAria')}
    >
      <div className="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-md bg-ink/[0.04] p-0.5">
        {EDIT_SCOPES.map((value) => {
          const selected = value === scope;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-pressed={selected}
              data-model-edit-scope={value}
              data-model-scope-choice={value}
              title={t(SCOPE_HINT[value])}
              onClick={() => { if (!selected) onScopeChange(value); }}
              className={`h-7 rounded-[5px] px-3 text-[12.5px] transition-colors ${
                selected
                  ? 'bg-panel font-medium text-ink shadow-[var(--kiki-sheet-shadow)]'
                  : 'text-ink-soft hover:text-ink'
              }`}
            >
              {t(SCOPE_LABEL[value])}
            </button>
          );
        })}
      </div>
      {scope === 'shared' || summary === undefined ? null : (
        <span className="text-[12px] text-ink-faint" data-model-scope-summary>
          <span data-model-scope-differences={String(differences)}>{differences}</span>
          {' '}{summary}
        </span>
      )}
      <span className="sr-only" data-model-edit-scope-hint>{t(SCOPE_HINT[scope])}</span>
    </div>
  );
}
