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
    <div className="min-w-0 space-y-1.5" data-model-edit-scope={scope}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <SettingsSegmented<EditScope>
          ariaLabel={t('st.modelScope.scopeAria')}
          value={scope}
          dataAttr="data-model-scope-choice"
          onChange={onScopeChange}
          choices={EDIT_SCOPES.map((value) => ({ value, label: t(SCOPE_LABEL[value]) }))}
        />
        {scope === 'shared' || summary === undefined ? null : (
          <span className="text-[12px] text-ink-faint" data-model-scope-summary>
            <span data-model-scope-differences={String(differences)}>{differences}</span>
            {' '}{summary}
          </span>
        )}
      </div>
      <Hint>{t(SCOPE_HINT[scope])}</Hint>
    </div>
  );
}
