/**
 * File scopes: which local roots a fetch may read from.
 *
 * Three states, and the page must not blur them: inherit (nothing is written,
 * the source's scopes stay in force), an explicit list, and explicitly none.
 * The inherited list is shown read-only because the engine owns it; editing
 * always writes the whole list, which is what the config format replaces.
 *
 * Renders the body only — the Advanced tab owns the group heading.
 */

import { useMemo } from 'react';
import type { NbSearchFileScopeDraft } from '@kiki/session-core/settings';

import { useI18n } from '../../../i18n';
import { Icon } from '../../icons';
import { INPUT, SECONDARY_BUTTON } from '../../ui';
import { FORM_LABEL } from '../SettingsPrimitives';
import type { NbSearchAdvancedBinding } from './advancedSupport';

export function NbSearchFileScopeEditor({
  binding,
  saving = false,
}: {
  binding: NbSearchAdvancedBinding;
  saving?: boolean;
}) {
  const { t } = useI18n();
  const capabilities = binding.capabilities;
  const advanced = binding.draft.advanced;
  const own = advanced?.fileScopes;
  const inherited = useMemo(
    () => capabilities.configuration?.file_scopes
      ?? capabilities.inherited_configuration?.file_scopes
      ?? [],
    [capabilities.configuration, capabilities.inherited_configuration],
  );
  const rows = own ?? [];

  const write = (next: readonly NbSearchFileScopeDraft[] | undefined) => {
    if (advanced === undefined) return;
    binding.onChange({
      ...binding.draft,
      advanced: { ...advanced, fileScopes: next === undefined ? undefined : [...next] },
    });
  };

  const update = (index: number, patch: Partial<NbSearchFileScopeDraft>) => {
    write(rows.map((row, candidate) => (candidate === index ? { ...row, ...patch } : row)));
  };

  const state = own === undefined ? 'inherit' : rows.length === 0 ? 'none' : 'custom';
  const stateText = state === 'inherit'
    ? t('st.nbSearch.fileScope.stateInherit', { count: String(inherited.length) })
    : state === 'none'
      ? t('st.nbSearch.fileScope.stateNone')
      : t('st.nbSearch.fileScope.stateCustom', { count: String(rows.length) });

  return (
    <div className="space-y-3">
      <p className="text-[12px] leading-snug text-ink-soft" data-nb-search-filescope-state={state}>
        {stateText}
      </p>

      {state === 'inherit' && inherited.length > 0 ? (
        <ul className="divide-y divide-hairline" data-nb-search-filescope-inherited>
          {inherited.map((scope) => (
            <li key={scope.id} className="flex flex-wrap items-baseline gap-x-2 py-1.5">
              <span className="font-mono text-[11px] text-ink">{scope.id}</span>
              <span className="min-w-0 break-all font-mono text-[11px] text-ink-faint">{scope.root}</span>
              {scope.media_types !== undefined ? (
                <span className="text-[12px] text-ink-soft">{scope.media_types.join(', ')}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {state === 'custom' ? (
        <ul className="divide-y divide-hairline" data-nb-search-filescope-rows>
          {rows.map((scope, index) => (
            <li key={`${index}:${scope.id}`} className="flex items-start gap-2 py-2">
              <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.4fr)_minmax(0,1fr)]">
                <label className={FORM_LABEL}>
                  {t('st.nbSearch.fileScope.id')}
                  <input
                    className={`${INPUT} mt-1 font-mono`}
                    value={scope.id}
                    disabled={saving}
                    spellCheck={false}
                    autoComplete="off"
                    aria-label={`${t('st.nbSearch.fileScope.id')} ${index + 1}`}
                    data-nb-search-filescope-id
                    onChange={(event) => {
                      update(index, { id: event.target.value });
                    }}
                  />
                </label>
                <label className={FORM_LABEL}>
                  {t('st.nbSearch.fileScope.root')}
                  <input
                    className={`${INPUT} mt-1 font-mono`}
                    value={scope.root}
                    disabled={saving}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={t('st.nbSearch.fileScope.rootPlaceholder')}
                    aria-label={`${t('st.nbSearch.fileScope.root')} ${index + 1}`}
                    data-nb-search-filescope-root
                    onChange={(event) => {
                      update(index, { root: event.target.value });
                    }}
                  />
                </label>
                <label className={FORM_LABEL}>
                  {t('st.nbSearch.fileScope.mediaTypes')}
                  <input
                    className={`${INPUT} mt-1 font-mono`}
                    value={(scope.media_types ?? []).join(', ')}
                    disabled={saving}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="text/plain"
                    aria-label={`${t('st.nbSearch.fileScope.mediaTypes')} ${index + 1}`}
                    data-nb-search-filescope-media
                    onChange={(event) => {
                      const parsed = event.target.value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
                      update(index, { media_types: parsed.length === 0 ? undefined : parsed });
                    }}
                  />
                </label>
              </div>
              <button
                type="button"
                className={`${SECONDARY_BUTTON} mt-5 shrink-0 px-1.5 py-1 text-danger hover:border-danger/40`}
                aria-label={t('st.nbSearch.fileScope.removeScope', { n: index + 1 })}
                title={t('st.nbSearch.fileScope.removeScope', { n: index + 1 })}
                disabled={saving}
                data-nb-search-filescope-remove
                onClick={() => {
                  write(rows.filter((_, candidate) => candidate !== index));
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {(state === 'custom' ? rows : []).some((scope) => scope.id.trim() === '' || scope.root.trim() === '') ? (
        <p role="alert" data-nb-search-filescope-issue className="text-[12px] leading-4 text-danger">
          {t('st.nbSearch.fileScope.incomplete')}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`${SECONDARY_BUTTON} inline-flex items-center gap-1`}
          disabled={saving}
          data-nb-search-filescope-add
          onClick={() => {
            const next = [...rows, { id: '', root: '' }];
            write(next);
          }}
        >
          <Icon name="plus" size={12} />
          {t('st.nbSearch.fileScope.add')}
        </button>
        {own !== undefined ? (
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={saving}
            data-nb-search-filescope-restore
            onClick={() => {
              write(undefined);
            }}
          >
            {t('st.nbSearch.advanced.restoreInherited')}
          </button>
        ) : null}
        {/* Clearing is reachable from either state that still has scopes: a person
            who wants no file source at all should not have to add one first. */
        state !== 'none' ? (
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={saving}
            data-nb-search-filescope-clear
            onClick={() => {
              write([]);
            }}
          >
            {t('st.nbSearch.fileScope.clear')}
          </button>
        ) : null}
      </div>

      <p className="text-[12px] leading-snug text-ink-faint">{t('st.nbSearch.fileScope.hint')}</p>
    </div>
  );
}
