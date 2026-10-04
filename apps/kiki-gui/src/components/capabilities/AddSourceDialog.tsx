/**
 * "Add from source" — a local folder, a GitHub repository, or a ZIP URL with
 * its SHA-256. Every path ends in the same preview + consent sheet as the
 * marketplace, so a hand-typed source gets no weaker a review.
 *
 * This dialog is about one install's input. The catalog address is a standing
 * server setting, edited where it is read: Plugins' Advanced, and Settings.
 */

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import { marketplaceUrlPatch } from '@kiki/session-core/settings';

import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, type Feedback } from '../controls';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../Dialog';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import type { InstallRequest } from './InstallFlow';
import { Segmented } from './primitives';
import { PLUGIN_QUERY_KEYS } from './usePlugins';

type SourceKind = 'path' | 'github' | 'zip';

export function AddSourceDialog({
  onClose,
  onPreview,
}: {
  readonly onClose: () => void;
  readonly onPreview: (request: InstallRequest) => void;
}) {
  const { t } = useI18n();
  const host = useHost();
  const [kind, setKind] = useState<SourceKind>('github');
  const [source, setSource] = useState('');
  const [sha256, setSha256] = useState('');
  const trimmed = source.trim();
  const shaValid = /^[0-9a-fA-F]{64}$/.test(sha256.trim());
  const ready = trimmed !== '' && (kind !== 'zip' || shaValid);

  const pick = async () => {
    const selected = await host.pickDirectory?.();
    if (typeof selected === 'string') setSource(selected);
  };

  const submit = () => {
    if (!ready) return;
    const name = trimmed.split(/[\\/]/).filter(Boolean).at(-1)?.replace(/\.zip$/i, '') ?? trimmed;
    onPreview({ source: trimmed, sha256: kind === 'zip' ? sha256.trim() : undefined, displayName: name });
  };

  return (
    <Dialog
      onClose={onClose}
      ariaLabel={t('cap.source.title')}
      overlayId="capability-add-source"
      panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.sm}`}
      overlayData={{ 'data-add-source': kind }}
    >
      <h2 className="font-display text-[18px] leading-6 text-ink">{t('cap.source.title')}</h2>
      <p className="mt-1 text-[13px] leading-5 text-ink-soft">{t('cap.source.body')}</p>
      <form
        className="mt-5 space-y-4"
        onSubmit={(event) => { event.preventDefault(); submit(); }}
      >
        <Segmented
          value={kind}
          onChange={(next) => { setKind(next); setSource(''); setSha256(''); }}
          ariaLabel={t('cap.source.kind')}
          options={[
            { value: 'github', label: t('cap.source.github') },
            { value: 'path', label: t('cap.source.path') },
            { value: 'zip', label: t('cap.source.zip') },
          ]}
        />
        <label className="block space-y-1 text-[12px] font-medium text-ink-soft">
          {kind === 'github' ? t('cap.source.githubLabel') : kind === 'path' ? t('cap.source.pathLabel') : t('cap.source.zipLabel')}
          <div className="flex gap-2">
            <input
              className={`${INPUT} font-mono`}
              value={source}
              data-autofocus
              spellCheck={false}
              autoComplete="off"
              placeholder={kind === 'github' ? 'https://github.com/owner/repo' : kind === 'path' ? t('st.plugins.pathPlaceholder') : 'https://example.com/plugin.zip'}
              onChange={(event) => { setSource(event.target.value); }}
            />
            {kind === 'path' && host.pickDirectory !== undefined ? (
              <button type="button" className={`${SECONDARY_BUTTON} shrink-0`} onClick={() => { void pick(); }}>{t('st.plugins.pickPath')}</button>
            ) : null}
          </div>
        </label>
        {kind === 'zip' ? (
          <label className="block space-y-1 text-[12px] font-medium text-ink-soft">
            {t('cap.source.sha')}
            <input
              className={`${INPUT} font-mono`}
              value={sha256}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={sha256.trim() !== '' && !shaValid}
              onChange={(event) => { setSha256(event.target.value); }}
            />
            <span className="block text-[12px] font-normal leading-4 text-ink-faint">
              {sha256.trim() !== '' && !shaValid ? t('cap.source.shaInvalid') : t('cap.source.shaHint')}
            </span>
          </label>
        ) : kind === 'github' ? (
          <p className="text-[12px] leading-4 text-ink-faint">{t('cap.source.githubHint')}</p>
        ) : null}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className={PRIMARY_BUTTON} disabled={!ready} data-add-source-submit>{t('cap.source.review')}</button>
        </div>
      </form>
    </Dialog>
  );
}

export function CatalogSourceField() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  useEffect(() => { setDraft(configQuery.data?.plugins?.marketplaceUrl ?? ''); }, [configQuery.data]);
  const save = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig(marketplaceUrlPatch(draft));
      queryClient.setQueryData(['config'], echoed);
      await queryClient.invalidateQueries({ queryKey: PLUGIN_QUERY_KEYS.marketplace });
      setFeedback({ tone: 'success', text: t('st.plugins.sourceSaved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };
  const dirty = draft !== (configQuery.data?.plugins?.marketplaceUrl ?? '');
  return (
    <div className="space-y-2" data-catalog-source>
      <label className="block space-y-1 text-[12px] font-medium text-ink-soft">
        {t('st.plugins.sourceLabel')}
        <input className={`${INPUT} font-mono`} value={draft} spellCheck={false} placeholder={t('st.plugins.sourcePlaceholder')} onChange={(event) => { setDraft(event.target.value); }} />
      </label>
      <p className="text-[12px] leading-4 text-ink-faint">{t('st.plugins.sourceHint')}</p>
      {dirty ? (
        <button type="button" className={SECONDARY_BUTTON} disabled={saving} onClick={() => { void save(); }}>
          {saving ? t('common.saving') : t('st.plugins.sourceSave')}
        </button>
      ) : null}
      <FeedbackLine feedback={feedback} />
    </div>
  );
}
