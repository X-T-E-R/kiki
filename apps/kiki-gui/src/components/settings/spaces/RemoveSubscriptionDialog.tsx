import { useCallback, useEffect, useId, useState } from 'react';

import type {
  PortableSpaceCenterSource,
  PortableSpaceRemovePreviewResult,
  PortableSpaceRemoveReviewedResponse,
} from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../../i18n';
import type { KikiClient } from '../../../lib/client';
import {
  isPortablePreviewExpiredError,
  isPortablePreviewStaleError,
  portableSpacesApi,
} from '../../../lib/portableSpaces';
import { ConfirmDialog } from '../../ConfirmDialog';
import { InlineError } from '../../controls';
import { SECONDARY_BUTTON } from '../../ui';

export interface RemoveSubscriptionDialogProps {
  readonly open: boolean;
  readonly client: KikiClient;
  readonly source: PortableSpaceCenterSource;
  readonly onCancel: () => void;
  readonly onRemoved: (result: PortableSpaceRemoveReviewedResponse, purged: boolean) => void;
}

export function RemoveSubscriptionDialog({
  open,
  client,
  source,
  onCancel,
  onRemoved,
}: RemoveSubscriptionDialogProps) {
  const { t, locale } = useI18n();
  const radioName = useId();
  const [purgeManaged, setPurgeManaged] = useState(false);
  const [preview, setPreview] = useState<PortableSpaceRemovePreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);

  const loadPreview = useCallback(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setNeedsRefresh(false);
    void portableSpacesApi(client)
      .previewRemoveSource(source.id, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setPreview(result);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setPreview(null);
        setError(caught);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => { controller.abort(); };
  }, [client, source.id]);

  useEffect(() => {
    if (!open) return;
    setPurgeManaged(false);
    return loadPreview();
  }, [open, loadPreview]);

  const confirm = async () => {
    if (busy || preview === null || needsRefresh) return;
    setBusy(true);
    setError(null);
    try {
      const response = await portableSpacesApi(client).removeReviewedSource(source.id, {
        previewToken: preview.previewToken,
        purgeManaged,
        impactDigest: preview.impactDigest,
        createBackup: true,
      });
      onRemoved(response, purgeManaged);
    } catch (caught) {
      setError(caught);
      if (isPortablePreviewStaleError(caught) || isPortablePreviewExpiredError(caught)) {
        setNeedsRefresh(true);
      }
      setBusy(false);
    }
  };

  const impact = preview?.impact;
  const managedCount = preview?.managedCount ?? source.managedIds?.length ?? 0;
  const willDeleteCount = impact?.deletedIds.length ?? 0;

  return (
    <ConfirmDialog
      open={open}
      stacked
      overlayId="portable-remove-subscription-dialog"
      title={t('st.portable.center.removeTitle', { name: source.label })}
      tone={purgeManaged ? 'danger' : 'default'}
      busy={busy}
      confirmDisabled={loading || preview === null || needsRefresh}
      confirmLabel={
        purgeManaged
          ? t('st.portable.center.removeConfirmPurge', { count: willDeleteCount })
          : t('st.portable.center.removeConfirmDetach')
      }
      confirmData={{ 'data-portable-remove-confirm': purgeManaged ? 'purge' : 'detach' }}
      onConfirm={() => { void confirm(); }}
      onCancel={onCancel}
    >
      <div className="mt-4 space-y-3" data-portable-remove-dialog={source.id}>
        {loading ? (
          <p className="text-[12.5px] text-ink-soft" data-portable-remove-loading>
            {t('st.portable.center.removeLoading')}
          </p>
        ) : null}

        {error !== null ? (
          <div className="space-y-2" data-portable-remove-error>
            <InlineError error={error} />
            {needsRefresh || preview === null ? (
              <button
                type="button"
                data-portable-remove-refresh
                className={SECONDARY_BUTTON}
                onClick={() => { loadPreview(); }}
              >
                {t('st.portable.center.refreshPreview')}
              </button>
            ) : null}
          </div>
        ) : null}

        <fieldset className="divide-y divide-hairline border-t border-b border-hairline" disabled={loading || busy}>
          <label className="flex cursor-pointer items-start gap-3 py-3 pointer-coarse:min-h-11">
            <input
              type="radio"
              name={radioName}
              value="detach"
              data-portable-remove-choice="detach"
              checked={!purgeManaged}
              onChange={() => { setPurgeManaged(false); }}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-selected-ink)]"
            />
            <span className="min-w-0 flex-1 space-y-0.5">
              <span className="block text-[13px] font-medium text-ink">
                {t('st.portable.center.removeDetachTitle')}
              </span>
              <span className="block text-[12px] text-ink-soft">
                {t('st.portable.center.removeDetachDesc', { count: managedCount })}
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-3 py-3 pointer-coarse:min-h-11">
            <input
              type="radio"
              name={radioName}
              value="purge"
              data-portable-remove-choice="purge"
              checked={purgeManaged}
              onChange={() => { setPurgeManaged(true); }}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-danger)]"
            />
            <span className="min-w-0 flex-1 space-y-1">
              <span className="block text-[13px] font-medium text-ink">
                {t('st.portable.center.removePurgeTitle')}
              </span>
              <span className="block text-[12px] text-ink-soft">
                {t('st.portable.center.removePurgeDesc')}
              </span>
              {impact !== undefined ? (
                <ul className="space-y-0.5 pt-1 text-[12px] text-ink-soft" data-portable-remove-impact>
                  <li className="font-medium text-ink">
                    {t('st.portable.center.impactDeleted', { count: impact.deletedIds.length })}
                  </li>
                  {impact.preservedLocalIds.length > 0 ? (
                    <li>{t('st.portable.center.impactPreservedLocal', { count: impact.preservedLocalIds.length })}</li>
                  ) : null}
                  {impact.handedOffIds.length > 0 ? (
                    <li>{t('st.portable.center.impactHandedOff', { count: impact.handedOffIds.length })}</li>
                  ) : null}
                  {impact.preservedDependencyIds.length > 0 ? (
                    <li>{t('st.portable.center.impactPreservedDep', { count: impact.preservedDependencyIds.length })}</li>
                  ) : null}
                  {impact.pendingReconcileIds.length > 0 ? (
                    <li className="text-amber-ink">
                      {t('st.portable.center.impactPending', { count: impact.pendingReconcileIds.length })}
                    </li>
                  ) : null}
                  <li className="text-ink-faint">{t('st.portable.center.removeBackupNote')}</li>
                </ul>
              ) : null}
            </span>
          </label>
        </fieldset>

        {error !== null && typeof error === 'string' ? (
          <p className="text-[12px] text-danger-ink">{errorText(locale, error)}</p>
        ) : null}
      </div>
    </ConfirmDialog>
  );
}
