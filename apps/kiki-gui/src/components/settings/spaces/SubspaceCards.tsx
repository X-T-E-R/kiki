import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';

import { useHost } from '../../../host';
import { useI18n } from '../../../i18n';
import { type KikiClient } from '../../../lib/client';
import {
  MAIN_SPACE_ID,
  currentSpaceId,
  enterSpace,
  launchWindowMode,
  spaceKeys,
  spaceSshApi,
  useSpaces,
} from '../../../lib/spaces';
import { readDesktopPrefs } from '@kiki/session-core/settings';
import { useConnection } from '../../../state/connection';
import { ConfirmDialog } from '../../ConfirmDialog';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../../controls';
import { Dialog } from '../../Dialog';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { SectionCard } from '../SectionCard';

/**
 * Accounts and keys inside a space (§9.5). The mode itself changes from the
 * main space (only the main server writes `home.toml`); here the space can
 * copy the main space's saved SSH passwords while it still shares, and restart
 * its own backend so a mode change made elsewhere applies.
 */
export function SpaceCredentialsCard({ client: controlClient, onEnterMain }: {
  client?: KikiClient;
  onEnterMain?: () => void | Promise<void>;
} = {}) {
  const { client: connectionClient } = useConnection();
  const client = controlClient ?? connectionClient;
  const host = useHost();
  const { t, tp, locale } = useI18n();
  const spaces = useSpaces(client);
  const me = spaces.data?.find((item) => item.id === currentSpaceId());
  const shared = me?.credentials_shared !== false;
  const [copyOpen, setCopyOpen] = useState(false);
  const [restartOpen, setRestartOpen] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState(false);
  const mode = launchWindowMode(readDesktopPrefs().windowMode);

  return (
    <SectionCard id="st-card-space-credentials" title={t('st.spaces.credTitle')} scope="server">
      <div className="space-y-3">
        <div className="rounded-lg bg-ink/[0.03] p-3" data-space-cred-current={shared ? 'shared' : 'isolated'}>
          <p className="text-[13px] font-medium text-ink">{t(shared ? 'st.spaces.credShared' : 'st.spaces.credIsolated')}</p>
          <p className="mt-0.5 text-[12px] text-ink-faint">{t(shared ? 'st.spaces.credSharedDesc' : 'st.spaces.credIsolatedDesc')}</p>
        </div>
        <Hint>{t('st.spaces.credChangeFromMain')}</Hint>
        <div className="flex flex-wrap items-center gap-2">
          {shared ? (
            <button type="button" data-space-copy-here className={SECONDARY_BUTTON} onClick={() => { setCopyOpen(true); }}>{t('st.spaces.copySshHere')}</button>
          ) : null}
          {host.kind === 'tauri' ? (
            <button type="button" data-space-go-main className={SECONDARY_BUTTON}
              onClick={() => { void Promise.resolve(onEnterMain !== undefined ? onEnterMain() : enterSpace(host, MAIN_SPACE_ID, mode))
                .catch((error: unknown) => {
                  if (error instanceof Error && error.name === 'AbortError') return;
                  setFeedback({ tone: 'error', text: errorText(locale, error) });
                }); }}>
              {t('st.spaces.switchToMain')}
            </button>
          ) : null}
          {host.kind === 'tauri' ? (
            <button type="button" data-space-restart className={SECONDARY_BUTTON} disabled={busy} onClick={() => { setRestartOpen(true); }}>{t('st.spaces.restartSpace')}</button>
          ) : null}
        </div>
        {host.kind === 'tauri' ? <Hint>{t('st.spaces.restartHint')}</Hint> : null}
        <FeedbackLine feedback={feedback} />
      </div>
      {copyOpen ? (
        <CopySshHereDialog client={client} onClose={() => { setCopyOpen(false); }}
          onCopied={(count) => { setCopyOpen(false); setFeedback({ tone: 'success', text: tp('st.spaces.copiedSsh', count) }); }} />
      ) : null}
      {restartOpen ? (
        <ConfirmDialog open overlayId="space-restart-confirm" tone="default"
          title={t('st.spaces.restartConfirmTitle', { name: me?.name ?? '' })}
          body={t('st.spaces.restartConfirmBody')}
          confirmLabel={t('st.spaces.restartSpace')}
          onCancel={() => { setRestartOpen(false); }}
          onConfirm={() => {
            setRestartOpen(false);
            setBusy(true);
            if (host.kind !== 'tauri') return;
            void host.restartServer().catch((error: unknown) => { setFeedback({ tone: 'error', text: errorText(locale, error) }); })
              .finally(() => { setBusy(false); });
          }} />
      ) : null}
    </SectionCard>
  );
}

/** Copy the main space's saved SSH secrets for this space's Kiki hosts. */
function CopySshHereDialog({ client, onClose, onCopied }: { client: KikiClient; onClose: () => void; onCopied: (count: number) => void }) {
  const { t, locale } = useI18n();
  const hosts = useQuery({
    queryKey: spaceKeys.sshHosts(client),
    queryFn: () => spaceSshApi(client).list(),
    select: (data) => data.hosts.filter((host) => host.source === 'kiki'),
  });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const list = hosts.data ?? [];

  const submit = () => {
    setBusy(true);
    setFeedback(null);
    void spaceSshApi(client).copySharedCredentialsToIsolated({ hosts: [...selected].map((hostId) => ({ hostId })) })
      .then((result) => { onCopied(result.hosts.reduce((sum, host) => sum + host.copied, 0)); })
      .catch((error: unknown) => { setBusy(false); setFeedback({ tone: 'error', text: errorText(locale, error) }); });
  };

  return (
    <Dialog onClose={() => { if (!busy) onClose(); }} ariaLabel={t('st.spaces.copySshHereTitle')} overlayId="space-copy-ssh-here">
      <div data-space-copy-here-dialog>
        <h2 className="font-display text-[18px] font-semibold text-ink">{t('st.spaces.copySshHereTitle')}</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">{t('st.spaces.copySshHereBody')}</p>
        {hosts.isError ? <div className="mt-3"><InlineError error={hosts.error} /></div> : null}
        {hosts.isSuccess && list.length === 0 ? <p className="mt-3 text-[12px] text-ink-faint">{t('st.spaces.copySshNoHosts')}</p> : null}
        {list.length > 0 ? (
          <ul className="mt-3 divide-y divide-hairline rounded-lg border border-hairline bg-paper">
            {list.map((host) => (
              <li key={host.id}>
                <label className="flex min-h-11 cursor-pointer items-center gap-2 px-3 py-2">
                  <input type="checkbox" data-space-copy-here-host={host.id} checked={selected.has(host.id)} className="accent-[var(--color-selected-ink)]"
                    onChange={() => {
                      setSelected((current) => { const next = new Set(current); if (next.has(host.id)) next.delete(host.id); else next.add(host.id); return next; });
                    }} />
                  <span className="min-w-0 truncate text-[13px] text-ink">{host.id}</span>
                </label>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-3"><FeedbackLine feedback={feedback} /></div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" data-space-copy-here-confirm className={PRIMARY_BUTTON} disabled={busy || selected.size === 0} onClick={submit}>
            {t('st.spaces.copySshHereConfirm')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
