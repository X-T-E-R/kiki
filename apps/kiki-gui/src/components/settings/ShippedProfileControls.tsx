import { useState } from 'react';

import type { NamedAgentProfile, ShippedAgentProfile } from '../../lib/client';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { SECONDARY_BUTTON } from '../ui';

/**
 * Built-in (shipped) profile management on a profile row: an origin badge
 * carrying the on-disk copy's modification state against the bundled
 * original, plus the restore-original action. Restore is double-confirmed and
 * the engine backs up the current copy before overwriting it; when the row's
 * copy pins a model the confirmation spells out that the pin is lost.
 */
export function ShippedProfileControls({
  entry,
  profile,
  onRestored,
  onError,
}: {
  readonly entry: ShippedAgentProfile;
  readonly profile?: NamedAgentProfile;
  readonly onRestored: (entry: ShippedAgentProfile) => void;
  readonly onError: (error: unknown) => void;
}) {
  const { client } = useConnection();
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const removed = entry.status === 'removed';
  const restorable = removed || entry.status === 'custom' || entry.status === 'update-available';
  const statusKey =
    entry.status === 'custom'
      ? 'st.shipped.custom'
      : entry.status === 'update-available'
        ? 'st.shipped.updateAvailable'
        : removed
          ? 'st.shipped.removed'
          : 'st.shipped.clean';
  const badgeTone = removed
    ? 'border-hairline bg-panel text-ink-faint'
    : entry.status === 'clean'
      ? 'border-hairline text-ink-faint'
      : 'border-accent/40 bg-accent-soft text-accent';

  const restore = async () => {
    setBusy(true);
    try {
      onRestored(await client.restoreShippedAgentProfile(entry.template_id));
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const pinnedModel = profile?.pinned_model_alias;
  const consequences: string[] = [];
  if (!removed) consequences.push(t('st.shipped.restoreOverwrite'));
  if (pinnedModel !== undefined && pinnedModel !== '') {
    consequences.push(t('st.shipped.restoreModelPin', { model: pinnedModel }));
  }

  return (
    <>
      <span
        data-shipped-status={entry.status}
        className={`rounded-full border px-2 py-0.5 font-mono text-[9.5px] ${badgeTone}`}
      >
        {t('st.shipped.badge')} · {t(statusKey)}
      </span>
      {restorable ? (
        <button
          type="button"
          data-shipped-restore={entry.template_id}
          className={SECONDARY_BUTTON}
          disabled={busy}
          onClick={() => { setConfirming(true); }}
        >
          {t('st.shipped.restore')}
        </button>
      ) : null}
      {confirming ? (
        <ConfirmDialog
          open
          overlayId="confirm-shipped-restore"
          title={t('st.shipped.restoreTitle', { name: entry.template_id })}
          body={t(removed ? 'st.shipped.restoreRemovedBody' : 'st.shipped.restoreBody')}
          consequences={consequences}
          confirmLabel={t('st.shipped.restore')}
          tone="danger"
          busy={busy}
          onCancel={() => { setConfirming(false); }}
          onConfirm={() => {
            setConfirming(false);
            void restore();
          }}
        />
      ) : null}
    </>
  );
}
