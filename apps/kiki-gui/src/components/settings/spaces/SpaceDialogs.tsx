import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { SpaceRecord, UpdateSpaceResponse } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../../i18n';
import { homesApi, spaceKeys, type SpaceListItem } from '../../../lib/spaces';
import { useConnection } from '../../../state/connection';
import type { KikiClient } from '../../../lib/client';
import { FeedbackLine, Hint, type Feedback } from '../../controls';
import { ConfirmDialog } from '../../ConfirmDialog';
import { DANGER_BUTTON, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { FORM_LABEL } from '../SettingsPrimitives';
import { SpaceDot } from './SpaceDot';

/**
 * Permanent deletion (`homes.erase`). The destructive verb stays disabled until
 * the typed name matches exactly; the body names the folder and says the delete
 * is recursive and final, and points at "Remove from list" for keeping the
 * files. Rendered through ConfirmDialog: the typed-name gate is its child.
 */
export function DeleteSpaceDialog({ client: controlClient, space, onClose, onDeleted }: {
  client?: KikiClient;
  space: SpaceListItem;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { client: connectionClient } = useConnection();
  const client = controlClient ?? connectionClient;
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
    <ConfirmDialog
      open
      overlayId="space-delete-dialog"
      title={t('st.spaces.deleteTitle', { name: space.name })}
      body={t('st.spaces.deleteBody')}
      confirmLabel={t('st.spaces.deleteConfirm')}
      tone="danger"
      busy={busy}
      confirmDisabled={!matches}
      confirmData={{ 'data-space-delete-confirm': '' }}
      onCancel={onClose}
      onConfirm={submit}
    >
      <form data-space-delete={space.id} onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <p data-space-delete-path className="mt-2 break-all rounded-md bg-danger/[0.06] px-3 py-2 font-mono text-[12px] text-ink">{space.path}</p>
        <p className="mt-2 text-[12.5px] text-ink-soft">{t('st.spaces.deleteKeepHint')}</p>
        <label htmlFor={inputId} className={`${FORM_LABEL} mt-4`}>{t('st.spaces.deleteTypeLabel', { name: space.name })}</label>
        <input id={inputId} data-space-delete-input value={typed} autoComplete="off" spellCheck={false}
          onChange={(event) => { setTyped(event.target.value); }}
          className={`${INPUT} mt-1.5 text-[13px]`} />
        {feedback !== null ? <div className="mt-3"><FeedbackLine feedback={feedback} /></div> : null}
      </form>
    </ConfirmDialog>
  );
}

type CopyTarget = { hostId: string; workspaceId?: string };
const targetKey = (target: CopyTarget) => `${target.workspaceId ?? ''}\u0000${target.hostId}`;

/**
 * §9.5 from the main space: flip a space between shared and separate
 * accounts in one `PATCH /homes/{id}`. Going separate may copy the main
 * space's saved SSH passwords for the hosts ticked here (default: none).
 * Going back to shared keeps whatever the space saved on its own. Rendered
 * through ConfirmDialog: the copy-selection is its child, the armed verb is
 * the direction being switched to.
 */
export function SpaceCredentialsDialog({ client: controlClient, space, onClose, onDone }: {
  client?: KikiClient;
  space: SpaceListItem;
  onClose: () => void;
  onDone: (result: UpdateSpaceResponse) => void;
}) {
  const { client: connectionClient } = useConnection();
  const client = controlClient ?? connectionClient;
  const { t, tp, locale } = useI18n();
  const shared = space.credentials_shared !== false;
  const target = shared ? 'isolated' : 'shared';
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const candidates = useQuery({
    queryKey: spaceKeys.sshCandidates(space.id, client),
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
    <ConfirmDialog
      open
      overlayId="space-credentials-dialog"
      title={t('st.spaces.credDialogTitle', { name: space.name })}
      tone="default"
      busy={busy}
      confirmLabel={t(target === 'isolated' ? 'st.spaces.credSwitchToIsolated' : 'st.spaces.credSwitchToShared')}
      confirmData={{ 'data-space-credentials-confirm': '' }}
      onCancel={onClose}
      onConfirm={submit}
    >
      <div data-space-credentials={space.id} data-space-credentials-target={target} className="max-h-[55dvh] overflow-y-auto">
        <div className="mt-3 grid gap-2 sm:grid-cols-2" aria-hidden>
          {(['shared', 'isolated'] as const).map((mode) => {
            const isTarget = mode === target;
            return (
              <div key={mode} data-space-credentials-mode={mode}
                className={`rounded-lg p-3 ${isTarget ? 'bg-panel shadow-[var(--kiki-sheet-shadow)] ring-1 ring-selected-ink/40' : 'bg-ink/[0.03]'}`}>
                <p className={`text-[13px] font-medium ${isTarget ? 'text-ink' : 'text-ink-soft'}`}>{t(mode === 'shared' ? 'st.spaces.credShared' : 'st.spaces.credIsolated')}</p>
                <p className="mt-0.5 text-[12px] text-ink-faint">{t(mode === 'shared' ? 'st.spaces.credSharedDesc' : 'st.spaces.credIsolatedDesc')}</p>
              </div>
            );
          })}
        </div>

        {target === 'isolated' ? (
          <>
            <p className="mt-4 text-[13px] leading-relaxed text-ink-soft">{t('st.spaces.credToIsolatedNote', { name: space.name })}</p>
            <fieldset className="mt-4 pt-3" data-space-copy-ssh>
              <legend className="sr-only">{t('st.spaces.copySsh', { name: space.name })}</legend>
              <div className="flex items-baseline justify-between gap-3">
                <p aria-hidden className="text-[13px] font-medium text-ink">{t('st.spaces.copySsh', { name: space.name })}</p>
                {hosts.length > 1 ? (
                  <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-ink-soft">
                    <input type="checkbox" data-space-copy-ssh-all checked={allSelected} className="accent-[var(--color-selected-ink)]"
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
                        <label className="flex min-h-11 cursor-pointer items-center gap-2 px-3 py-2">
                          <input type="checkbox" data-space-copy-ssh-host={host.hostId} checked={selected.has(key)}
                            onChange={() => { toggle(key); }} className="shrink-0 accent-[var(--color-selected-ink)]" />
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
        {target === 'isolated' && selected.size > 0 ? (
          <p className="mt-2 text-[12px] text-ink-faint">{tp('st.spaces.copyCount', selected.size)}</p>
        ) : null}
      </div>
    </ConfirmDialog>
  );
}
