import { useId, useState } from 'react';

import type { PortableSpaceEndpoint, PortableSpaceSourceRecord, PortableSpaceSubscriptionSyncResult } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useHost } from '../../../host';
import { useI18n } from '../../../i18n';
import type { KikiClient } from '../../../lib/client';
import { portableSpacesApi } from '../../../lib/portableSpaces';
import { FeedbackLine, type Feedback } from '../../controls';
import { SidePanel } from '../../SidePanel';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { FieldIssue, FORM_LABEL, SettingsSegmented } from '../SettingsPrimitives';

type LinkKind = 'url' | 'dir' | 'archive' | 'git';

export interface LinkSourcePanelProps {
  readonly client: KikiClient;
  readonly token?: string;
  readonly initialKind?: LinkKind;
  readonly initialTarget?: string;
  readonly onClose: () => void;
  readonly onDone: (record: PortableSpaceSourceRecord, syncResult?: PortableSpaceSubscriptionSyncResult) => void;
}

export function LinkSourcePanel({ client, token, initialKind, initialTarget, onClose, onDone }: LinkSourcePanelProps) {
  const host = useHost();
  const { t, locale } = useI18n();
  const formId = useId();
  const targetId = useId();
  const targetIssueId = useId();
  const labelId = useId();
  const refId = useId();
  const subpathId = useId();
  const passphraseId = useId();

  const [kind, setKind] = useState<LinkKind>(initialKind ?? 'dir');
  const [target, setTarget] = useState(initialTarget ?? '');
  const [label, setLabel] = useState('');
  const [gitRef, setGitRef] = useState('');
  const [subpath, setSubpath] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [issue, setIssue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const browse = async () => {
    if (host.pickDirectory === undefined) return;
    try {
      const picked = await host.pickDirectory();
      if (picked !== null) {
        setTarget(picked);
        setIssue(null);
        setFeedback(null);
      }
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    }
  };

  const submit = async () => {
    if (busy) return;
    const trimmed = target.trim();
    if (trimmed === '') {
      setIssue(t('st.portable.linkPathRequired'));
      return;
    }

    setBusy(true);
    setFeedback(null);
    try {
      if (kind === 'url') {
        const result = await portableSpacesApi(client).subscribe({
          url: trimmed,
          label: label.trim() || undefined,
          linkToSpaceId: 'main',
          autoSync: true,
          unlock: passphrase.trim() !== '' ? { passphrase: passphrase.trim() } : undefined,
          createBackup: true,
        });
        onDone(result.source, result);
        return;
      }
      const endpoint: PortableSpaceEndpoint = kind === 'git'
        ? {
          kind: 'git',
          repo: trimmed,
          ref: gitRef.trim() || undefined,
          subpath: subpath.trim() || undefined,
        }
        : kind === 'archive'
          ? { kind: 'archive', path: trimmed }
          : { kind: 'dir', path: trimmed };
      const record = await portableSpacesApi(client).registerSource({
        endpoint,
        label: label.trim() || undefined,
        unlock: passphrase.trim() !== '' ? { passphrase: passphrase.trim() } : undefined,
      });
      onDone(record);
    } catch (error) {
      setBusy(false);
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    }
  };

  return (
    <SidePanel
      title={t('st.portable.linkTitle')}
      overlayId="portable-link-panel"
      width="md"
      onClose={() => { if (!busy) onClose(); }}
      data={{ 'data-portable-link-panel': kind }}
      footer={(
        <>
          <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <span className="ml-auto" />
          <button type="submit" form={formId} data-portable-link-submit className={PRIMARY_BUTTON} disabled={busy}>
            {busy ? t('common.saving') : t(kind === 'url' ? 'st.portable.subscribeSubmit' : 'st.portable.linkSubmit')}
          </button>
        </>
      )}
    >
      <form
        id={formId}
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div>
          <span id={`${formId}-kind`} className={FORM_LABEL}>{t('st.portable.linkKind')}</span>
          <div className="mt-1.5">
            <SettingsSegmented<LinkKind>
              ariaLabelledBy={`${formId}-kind`}
              dataAttr="data-portable-link-kind"
              value={kind}
              onChange={(next) => {
                setKind(next);
                setIssue(null);
              }}
              choices={[
                { value: 'url', label: t('st.portable.linkKindUrl') },
                { value: 'dir', label: t('st.portable.linkKindDir') },
                { value: 'archive', label: t('st.portable.linkKindArchive') },
                { value: 'git', label: t('st.portable.linkKindGit') },
              ]}
            />
          </div>
        </div>

        <div>
          <label htmlFor={targetId} className={FORM_LABEL}>
            {t(kind === 'url' ? 'st.portable.linkUrl' : kind === 'git' ? 'st.portable.linkRepo' : 'st.portable.linkPath')}
          </label>
          <div className="mt-1.5 flex gap-2">
            <input
              id={targetId}
              data-autofocus
              data-portable-link-target
              value={target}
              spellCheck={false}
              autoComplete="off"
              placeholder={
                kind === 'url'
                  ? t('st.portable.linkUrlPlaceholder')
                  : kind === 'git'
                    ? 'https://github.com/org/kiki-space.git'
                    : kind === 'archive'
                      ? '/path/to/space.kiki.age'
                      : '/path/to/space-dir'
              }
              aria-invalid={issue !== null}
              aria-describedby={issue !== null ? targetIssueId : undefined}
              onChange={(event) => {
                setTarget(event.target.value);
                setIssue(null);
              }}
              className={`${INPUT} min-w-0 flex-1 font-mono text-[12px]`}
            />
            {kind === 'dir' && host.pickDirectory !== undefined ? (
              <button type="button" data-portable-link-browse className={SECONDARY_BUTTON} onClick={() => { void browse(); }}>
                {t('st.spaces.browse')}
              </button>
            ) : null}
          </div>
          <FieldIssue id={targetIssueId} text={issue} />
        </div>

        {kind === 'git' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={refId} className={FORM_LABEL}>{t('st.portable.linkRef')}</label>
              <input
                id={refId}
                data-portable-link-ref
                value={gitRef}
                spellCheck={false}
                placeholder="main"
                onChange={(event) => { setGitRef(event.target.value); }}
                className={`${INPUT} mt-1.5 font-mono text-[12px]`}
              />
            </div>
            <div>
              <label htmlFor={subpathId} className={FORM_LABEL}>{t('st.portable.linkSubpath')}</label>
              <input
                id={subpathId}
                data-portable-link-subpath
                value={subpath}
                spellCheck={false}
                placeholder="spaces/work"
                onChange={(event) => { setSubpath(event.target.value); }}
                className={`${INPUT} mt-1.5 font-mono text-[12px]`}
              />
            </div>
          </div>
        ) : null}

        <div>
          <label htmlFor={labelId} className={FORM_LABEL}>{t('st.portable.linkLabel')}</label>
          <input
            id={labelId}
            data-portable-link-label
            value={label}
            maxLength={120}
            placeholder={t('st.portable.linkLabelPlaceholder')}
            onChange={(event) => { setLabel(event.target.value); }}
            className={`${INPUT} mt-1.5`}
          />
        </div>

        <div>
          <label htmlFor={passphraseId} className={FORM_LABEL}>{t('st.portable.passphraseOptionalLabel')}</label>
          <input
            id={passphraseId}
            type="password"
            data-portable-link-passphrase
            value={passphrase}
            autoComplete="off"
            placeholder={t('st.portable.passphrasePlaceholder')}
            onChange={(event) => { setPassphrase(event.target.value); }}
            className={`${INPUT} mt-1.5`}
          />
        </div>

        <FeedbackLine feedback={feedback} />
      </form>
    </SidePanel>
  );
}
