import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { SpaceRecord, UpdateSpaceResponse } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useHost } from '../../../host';
import { useI18n } from '../../../i18n';
import { homesApi, isAbsolutePath, spaceKeys, type SpaceListItem } from '../../../lib/spaces';
import { useConnection } from '../../../state/connection';
import { FeedbackLine, Hint, type Feedback } from '../../controls';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../../Dialog';
import { DANGER_BUTTON, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { FieldIssue, FORM_LABEL } from '../SettingsPrimitives';
import { SpaceDot } from './SpaceDot';

/** "Add existing space…": registers a folder that already has this main space as its base. */
export function AttachSpaceDialog({ onClose, onAttached }: {
  onClose: () => void;
  onAttached: (record: SpaceRecord) => void;
}) {
  const { client } = useConnection();
  const host = useHost();
  const { t, locale } = useI18n();
  const pathId = useId();
  const issueId = useId();
  const [path, setPath] = useState('');
  const [issue, setIssue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const submit = () => {
    if (!isAbsolutePath(path)) { setIssue(t('st.spaces.pathRequired')); return; }
    setBusy(true);
    setFeedback(null);
    void homesApi(client).attach({ path: path.trim() })
      .then(onAttached)
      .catch((error: unknown) => { setBusy(false); setFeedback({ tone: 'error', text: errorText(locale, error) }); });
  };

  return (
    <Dialog onClose={() => { if (!busy) onClose(); }} ariaLabel={t('st.spaces.attachTitle')} overlayId="space-attach-dialog">
      <form data-space-attach onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <h2 className="font-display text-[17px] font-semibold text-ink">{t('st.spaces.attachTitle')}</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">{t('st.spaces.attachBody')}</p>
        <label htmlFor={pathId} className={`${FORM_LABEL} mt-4`}>{t('st.spaces.location')}</label>
        <div className="mt-1.5 flex gap-2">
          <input id={pathId} data-autofocus data-space-attach-path value={path} spellCheck={false} autoComplete="off"
            aria-invalid={issue !== null} aria-describedby={issue !== null ? issueId : undefined}
            onChange={(event) => { setPath(event.target.value); setIssue(null); }}
            className={`${INPUT} min-w-0 flex-1 font-mono text-[12px]`} />
          {host.pickDirectory !== undefined ? (
            <button type="button" className={SECONDARY_BUTTON} onClick={() => {
              void host.pickDirectory?.().then((picked) => { if (picked !== null) { setPath(picked); setIssue(null); } }).catch(() => undefined);
            }}>{t('st.spaces.browse')}</button>
          ) : null}
        </div>
        <FieldIssue id={issueId} text={issue} />
        <div className="mt-3"><FeedbackLine feedback={feedback} /></div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className={PRIMARY_BUTTON} disabled={busy}>{busy ? t('common.saving') : t('st.spaces.attachConfirm')}</button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Permanent deletion (`homes.erase`). The destructive button stays disabled
 * until the typed name matches exactly; the body names the folder and says the
 * delete is recursive and final, and points at "Remove from list" for keeping
 * the files.
 */
export function DeleteSpaceDialog({ space, onClose, onDeleted }: {
  space: SpaceListItem;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const inputId = useId();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const matches = typed === space.name;

  const submit = () => {
    if (!matches || busy) return;
    setBusy(true);
    setFeedback(null);
    void homesApi(client).erase(space.id, { confirm_name: typed })
      .then(onDeleted)
      .catch((error: unknown) => { setBusy(false); setFeedback({ tone: 'error', text: errorText(locale, error) }); });
  };

  return (
    <Dialog role="alertdialog" onClose={() => { if (!busy) onClose(); }} ariaLabel={t('st.spaces.deleteTitle', { name: space.name })} overlayId="space-delete-dialog">
      <form data-space-delete={space.id} onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <h2 className="flex items-center gap-2 font-display text-[17px] font-semibold text-ink">
          <SpaceDot color={space.color} />
          <span className="min-w-0 break-words">{t('st.spaces.deleteTitle', { name: space.name })}</span>
        </h2>
        <p className="mt-2.5 text-[13px] leading-relaxed text-ink-soft">{t('st.spaces.deleteBody')}</p>
        <p data-space-delete-path className="mt-2 break-all rounded-md bg-danger/[0.06] px-2.5 py-2 font-mono text-[12px] text-ink">{space.path}</p>
        <p className="mt-2 text-[12.5px] text-ink-soft">{t('st.spaces.deleteKeepHint')}</p>
        <label htmlFor={inputId} className={`${FORM_LABEL} mt-4`}>{t('st.spaces.deleteTypeLabel', { name: space.name })}</label>
        <input id={inputId} data-autofocus data-space-delete-input value={typed} autoComplete="off" spellCheck={false}
          onChange={(event) => { setTyped(event.target.value); }}
          className={`${INPUT} mt-1.5 text-[13px]`} />
        <div className="mt-3"><FeedbackLine feedback={feedback} /></div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" data-space-delete-confirm className={DANGER_BUTTON} disabled={!matches || busy}>
            {t('st.spaces.deleteConfirm')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

type CopyTarget = { hostId: string; workspaceId?: string };
const targetKey = (target: CopyTarget) => `${target.workspaceId ?? ''}\u0000${target.hostId}`;

/**
 * §9.5 from the main space: flip a space between shared and separate
 * accounts in one `PATCH /homes/{id}`. Going separate may copy the main
 * space's saved SSH passwords for the hosts ticked here (default: none).
 * Going back to shared keeps whatever the space saved on its own.
 */
export function SpaceCredentialsDialog({ space, onClose, onDone }: {
  space: SpaceListItem;
  onClose: () => void;
  onDone: (result: UpdateSpaceResponse) => void;
}) {
  const { client } = useConnection();
  const { t, tp, locale } = useI18n();
  const shared = space.credentials_shared !== false;
  const target = shared ? 'isolated' : 'shared';
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const candidates = useQuery({
    queryKey: spaceKeys.sshCandidates(space.id),
    queryFn: () => homesApi(client).sshCopyCandidates(space.id),
    enabled: shared,
    staleTime: 0,
  });
  const hosts = candidates.data?.hosts ?? [];
  const allSelected = hosts.length > 0 && hosts.every((host) => selected.has(targetKey(host)));

  const toggle = (key: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const submit = () => {
    if (busy) return;
    const picked = hosts.filter((host) => selected.has(targetKey(host)))
      .map((host) => (host.workspaceId === undefined ? { hostId: host.hostId } : { hostId: host.hostId, workspaceId: host.workspaceId }));
    setBusy(true);
    setFeedback(null);
    void homesApi(client).update(space.id, {
      inherit: { credentials: target },
      ...(target === 'isolated' && picked.length > 0 ? { copy_ssh_credentials: { hosts: picked } } : {}),
    })
      .then(onDone)
      .catch((error: unknown) => { setBusy(false); setFeedback({ tone: 'error', text: errorText(locale, error) }); });
  };

  const kindLabel = (kind: 'password' | 'passphrase') => t(kind === 'password' ? 'st.spaces.kind.password' : 'st.spaces.kind.passphrase');

  return (
    <Dialog onClose={() => { if (!busy) onClose(); }} ariaLabel={t('st.spaces.credDialogTitle', { name: space.name })} overlayId="space-credentials-dialog"
      panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.sm} max-h-[calc(100dvh-2rem)] overflow-y-auto`}>
      <div data-space-credentials={space.id} data-space-credentials-target={target}>
        <h2 className="flex items-center gap-2 font-display text-[17px] font-semibold text-ink">
          <SpaceDot color={space.color} />
          <span className="min-w-0 break-words">{t('st.spaces.credDialogTitle', { name: space.name })}</span>
        </h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2" aria-hidden>
          {(['shared', 'isolated'] as const).map((mode) => {
            const isTarget = mode === target;
            return (
              <div key={mode} data-space-credentials-mode={mode}
                className={`rounded-lg p-3 ${isTarget ? 'bg-panel shadow-[var(--kiki-sheet-shadow)] ring-1 ring-accent/40' : 'bg-ink/[0.03]'}`}>
                <p className={`text-[13px] font-medium ${isTarget ? 'text-ink' : 'text-ink-soft'}`}>{t(mode === 'shared' ? 'st.spaces.credShared' : 'st.spaces.credIsolated')}</p>
                <p className="mt-0.5 text-[12px] text-ink-faint">{t(mode === 'shared' ? 'st.spaces.credSharedDesc' : 'st.spaces.credIsolatedDesc')}</p>
              </div>
            );
          })}
        </div>

        {target === 'isolated' ? (
          <>
            <p className="mt-4 text-[13px] leading-relaxed text-ink-soft">{t('st.spaces.credToIsolatedNote', { name: space.name })}</p>
            <fieldset className="mt-4 border-t border-hairline pt-3" data-space-copy-ssh>
              <legend className="sr-only">{t('st.spaces.copySsh', { name: space.name })}</legend>
              <div className="flex items-baseline justify-between gap-3">
                <p aria-hidden className="text-[13px] font-medium text-ink">{t('st.spaces.copySsh', { name: space.name })}</p>
                {hosts.length > 1 ? (
                  <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-ink-soft">
                    <input type="checkbox" data-space-copy-ssh-all checked={allSelected} className="accent-[var(--color-accent)]"
                      onChange={() => { setSelected(allSelected ? new Set() : new Set(hosts.map(targetKey))); }} />
                    {t('st.spaces.copySshAll')}
                  </label>
                ) : null}
              </div>
              <Hint>{t('st.spaces.copySshHint')}</Hint>
              {candidates.isLoading ? <p className="mt-2 text-[12px] text-ink-faint">{t('st.spaces.copySshLoading')}</p> : null}
              {candidates.isError ? <div className="mt-2"><FeedbackLine feedback={{ tone: 'error', text: errorText(locale, candidates.error) }} /></div> : null}
              {candidates.isSuccess && hosts.length === 0 ? <p className="mt-2 text-[12px] text-ink-faint" data-space-copy-ssh-empty>{t('st.spaces.copySshNone')}</p> : null}
              {hosts.length > 0 ? (
                <ul className="mt-2 divide-y divide-hairline rounded-lg border border-hairline bg-paper">
                  {hosts.map((host) => {
                    const key = targetKey(host);
                    return (
                      <li key={key}>
                        <label className="flex min-h-11 cursor-pointer items-center gap-2.5 px-3 py-2">
                          <input type="checkbox" data-space-copy-ssh-host={host.hostId} checked={selected.has(key)}
                            onChange={() => { toggle(key); }} className="shrink-0 accent-[var(--color-accent)]" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] text-ink">{host.name}</span>
                            {host.workspaceId !== undefined || host.name !== host.hostId ? (
                              <span className="block truncate font-mono text-[11px] text-ink-faint">{host.hostId}{host.workspaceId !== undefined ? ` · ${host.workspaceId}` : ''}</span>
                            ) : null}
                          </span>
                          <span className="shrink-0 text-[11.5px] text-ink-faint">{host.credential_kinds.map(kindLabel).join(' · ')}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </fieldset>
          </>
        ) : (
          <p className="mt-4 text-[13px] leading-relaxed text-ink-soft" data-space-credentials-shared-note>{t('st.spaces.credToSharedNote', { name: space.name })}</p>
        )}

        <div className="mt-3"><FeedbackLine feedback={feedback} /></div>
        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          {target === 'isolated' && selected.size > 0 ? (
            <span className="mr-auto text-[12px] text-ink-faint">{tp('st.spaces.copyCount', selected.size)}</span>
          ) : null}
          <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" data-space-credentials-confirm className={PRIMARY_BUTTON} disabled={busy} onClick={submit}>
            {busy ? t('common.saving') : t(target === 'isolated' ? 'st.spaces.credSwitchToIsolated' : 'st.spaces.credSwitchToShared')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
