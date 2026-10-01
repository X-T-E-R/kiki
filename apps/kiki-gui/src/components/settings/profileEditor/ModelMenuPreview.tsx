import { useI18n } from '../../../i18n';

export interface ModelMenuPreviewData {
  readonly declared: readonly string[];
  readonly defaultAlias?: string;
  readonly effective?: readonly string[];
  readonly added?: readonly string[];
  readonly removed?: readonly string[];
  readonly diagnostics?: readonly string[];
}

/** Display-only: identities and effective candidates are supplied by the shared projection. */
export function ModelMenuPreview({ value, pending = false, error = false, onRetry }: {
  value?: ModelMenuPreviewData;
  pending?: boolean;
  error?: boolean;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  const list = (aliases: readonly string[], declared: boolean) => aliases.length === 0
    ? <span className="text-ink-soft">{t('st.profiles.menuEmpty')}</span>
    : <ul className="space-y-1">
      {aliases.map((alias) => <li key={alias} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className="break-all font-mono text-[11.5px] text-ink">{alias}</span>
        {declared && alias === value?.defaultAlias ? <span className="text-[11px] text-ink-soft">{t('st.profiles.menuDefault')}</span> : null}
      </li>)}
    </ul>;
  return <div data-model-menu-preview className="space-y-2 border-y border-hairline py-3 text-[12px] leading-relaxed" aria-live="polite" aria-busy={pending}>
    {value !== undefined ? <dl className="space-y-3">
      <div data-menu-declared>
        <dt className="mb-1 font-medium text-ink-soft">{t('st.profiles.declaredMenu')}</dt>
        <dd>{list(value.declared, true)}</dd>
      </div>
      <div data-menu-effective>
        <dt className="mb-1 font-medium text-ink-soft">{t('st.profiles.effectiveModels')}</dt>
        <dd>{pending ? <span className="text-ink-soft">{t('st.profiles.menuPreviewPending')}</span>
          : error ? <span className="text-danger">{t('st.profiles.menuPreviewError')}</span>
            : value.effective === undefined ? <span className="text-ink-soft">{t('st.profiles.menuPreviewUnavailable')}</span>
              : list(value.effective, false)}</dd>
      </div>
    </dl> : <p className={error ? 'text-danger' : 'text-ink-soft'}>{t(error ? 'st.profiles.menuPreviewError' : pending ? 'st.profiles.menuPreviewPending' : 'st.profiles.menuPreviewUnavailable')}</p>}
    {error && onRetry !== undefined ? <button type="button" onClick={onRetry}
      className="min-h-9 px-1 text-ink underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-selected-ink">{t('common.retry')}</button> : null}
    {!pending && !error && value?.effective?.length === 0 ? <p data-menu-empty role="alert" className="text-danger">{t('st.profiles.menuNoCandidates')}</p> : null}
    {!pending && !error && (value?.added?.length ?? 0) > 0 ? <p data-menu-added className="break-words text-ink">{t('st.profiles.menuAdded', { models: value!.added!.join(', ') })}</p> : null}
    {!pending && !error && (value?.removed?.length ?? 0) > 0 ? <p data-menu-removed className="break-words font-medium text-amber-ink">{t('st.profiles.menuRemoved', { models: value!.removed!.join(', ') })}</p> : null}
    {!pending && !error ? value?.diagnostics?.map((message, index) => <p key={index} className="break-words text-ink-soft">{message}</p>) : null}
  </div>;
}
