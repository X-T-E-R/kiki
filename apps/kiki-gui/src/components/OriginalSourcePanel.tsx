/**
 * Choosing where a connection's sign-in comes from — one of them, inside the one
 * connection the page already manages.
 *
 * A person can hold a sign-in of Kiki's own, or point at the one the vendor's
 * own app already has on this machine. The second is reuse, not a copy: Kiki
 * renews it near expiry and adapts wherever the machine keeps it, without ever
 * starting the other app and without reading its token here.
 *
 * The order on screen is the order it happens in: **check, then attach.** The
 * check says which account is on the other side and where it lives; only then is
 * attaching offered, and attaching carries that account's id so a credential
 * replaced in the meantime is refused rather than silently adopted. Changing the
 * directory throws the check away, because it no longer answers this question.
 *
 * "This machine" is the machine Kiki's *server* runs on. That is usually the
 * one you are looking at and occasionally not, so the directory is available as
 * an ordinary advanced input rather than hidden behind a support path.
 */

import { useState } from 'react';

import type { I18nKey } from '@kiki/session-core/i18n';

import type { OAuthMethodStatus } from '../lib/client';
import { useI18n } from '../i18n';
import { Icon } from './icons';
import { FeedbackLine, Hint } from './controls';
import { SECONDARY_BUTTON } from './ui';
import {
  originalStateBlock,
  useOriginalOAuthSource,
  type OriginalProvider,
  type OriginalSourceBlock,
  type OriginalSourceController,
} from './useOriginalOAuthSource';

/** The vendor's app whose sign-in can be reused, and where it keeps it. */
const ORIGINAL_APP: Readonly<Record<OriginalProvider, { name: string; home: string }>> = {
  'openai-codex': { name: 'Codex', home: '~/.codex' },
  'grok-build': { name: 'Grok', home: '~/.grok' },
  'kimi-code': { name: 'Kimi Code', home: '~/.kimi-code' },
};

/** Methods whose original sign-in this surface can look for. */
export function isOriginalSourceMethod(method: OAuthMethodStatus): method is OAuthMethodStatus & { id: OriginalProvider } {
  return method.id === 'openai-codex' || method.id === 'grok-build' || method.id === 'kimi-code';
}

/** Where the machine keeps it, in the words a person would use. */
const STORAGE_KEY = {
  file: 'st.source.storageFile',
  keyring: 'st.source.storageKeyring',
  encrypted: 'st.source.storageEncrypted',
  ephemeral: 'st.source.storageEphemeral',
} as const satisfies Record<string, I18nKey>;

/** A machine that reports no storage backend has nothing to say about storage. */
function storageKey(backend: 'file' | 'keyring' | 'encrypted' | 'ephemeral' | null): I18nKey | null {
  return backend === null ? null : STORAGE_KEY[backend];
}

/** The one sentence that says what the person can do about a blocked check. */
const BLOCK_KEY = {
  noAccount: 'st.source.blockNoAccount',
  unsupported: 'st.source.blockUnsupported',
  unreadable: 'st.source.blockUnreadable',
  signedOut: 'st.source.blockSignedOut',
  accountChanged: 'st.source.blockAccountChanged',
  refreshFailed: 'st.source.blockRefreshFailed',
} as const;

export function OriginalSourcePanel({
  method,
  onChanged,
}: {
  method: OAuthMethodStatus & { id: OriginalProvider };
  /** Re-reads the page after the connection's source actually changes. */
  onChanged?: () => Promise<void> | void;
}) {
  const { t } = useI18n();
  const app = ORIGINAL_APP[method.id].name;
  // The row already says which sign-in this connection is on; this only speaks
  // when the answer is not Kiki's own credential.
  const active = method.auth_source;
  const usingOriginal = active?.kind === 'local_original';
  const source = useOriginalOAuthSource(method.id, usingOriginal, onChanged, usingOriginal ? active.home_dir : undefined);
  const [advanced, setAdvanced] = useState(false);
  // An attached connection whose credential the machine no longer backs is not a
  // working one. The row above already says so — the server maps a source that
  // is not ready to a sign-in that must be replaced — and this must not
  // contradict it by promising a renewal that cannot happen. The same sentence
  // and the same check are offered, because a credential that went bad is
  // replaced by checking the machine, not by a new card.
  const unusable = usingOriginal
    ? originalStateBlock(active.source_state, true, active.source_state === 'ready' || active.source_state === 'refresh_required')
    : null;

  return (
    <div data-original-source={method.id} className="space-y-3 rounded-lg border border-hairline bg-panel/50 p-3">
      <div className="space-y-1">
        <p className="text-[12.5px] font-medium text-ink">
          {t('st.source.localOriginal', { app })}
        </p>
        {/* What reuse is, not what this credential is doing. Beside a credential
            that cannot be used, the renewal half of this sentence would read as
            a promise about it, so it is stated only when it is true. */}
        <p className="text-[12px] leading-4 text-ink-soft">
          {t(unusable === null ? 'st.source.localOriginalBody' : 'st.source.localOriginalBodySpent', { app })}
        </p>
      </div>

      {usingOriginal ? (
        <>
          <div data-original-source-state={active.source_state} className="space-y-2">
          {unusable === null ? (
            <>
              <p className="text-[12px] text-ink-soft">{t('st.source.connected')}</p>
              <p className="text-[12px] leading-4 text-ink-faint">
                {storageKey(active.storage_backend) === null
                  ? t('st.source.renews')
                  : `${t('st.source.storage', { storage: t(storageKey(active.storage_backend) as I18nKey) })} ${t('st.source.renews')}`}
              </p>
            </>
          ) : (
            // The reason this credential is no longer usable, in the same words
            // a check would use — one vocabulary, not two.
            <p data-original-source-unusable={unusable} className="text-[12px] leading-4 text-ink-soft">
              {t(BLOCK_KEY[unusable], { app })}
            </p>
          )}
          {/* The consequence worth stating: this removes Kiki's use of the
              credential, not the credential. Someone pressing this is worried
              about signing out their other app, and they are not doing that.
              It is written as what will happen, because nothing has happened
              yet — the past tense here would claim a state that is not true. */}
          <p className="text-[12px] leading-4 text-ink-faint">{t('st.source.detachHint', { app })}</p>
          <button
            type="button"
            data-original-source-detach
            className={SECONDARY_BUTTON}
            onClick={() => { void source.detachLocalOriginal?.(); }}
          >
            {t('st.source.detach')}
          </button>
          </div>
          {/* A credential the machine no longer backs is replaced by checking
              the machine, so the check stays on screen — beside the way to let
              go, since a person whose credential is unusable may want either. */}
          {unusable === null ? null : (
            <ProbeBlock
              source={source}
              app={app}
              home={ORIGINAL_APP[method.id].home}
              reason={unusable}
              advanced={advanced}
              setAdvanced={setAdvanced}
            />
          )}
        </>
      ) : (
        // Only a connection with no credential of its own needs to be pointed
        // at one. Once it is attached, checking the machine again answers a
        // question nobody is asking — unless the credential went bad, which is
        // the one case where checking is the way back.
        <ProbeBlock
          source={source}
          app={app}
          home={ORIGINAL_APP[method.id].home}
          reason={unusable}
          advanced={advanced}
          setAdvanced={setAdvanced}
        />
      )}
      <FeedbackLine feedback={source.feedback} />
    </div>
  );
}

function ProbeBlock({
  source,
  app,
  home,
  reason,
  advanced,
  setAdvanced,
}: {
  source: OriginalSourceController;
  app: string;
  /** Where that app keeps its sign-in by default: a hint, never a value. */
  home: string;
  /** Why an already-attached credential is unusable, so the check stays open. */
  reason: OriginalSourceBlock | null;
  advanced: boolean;
  setAdvanced: (value: boolean) => void;
}) {
  const { t } = useI18n();
  const probe = source.probe;
  // A check the person has not run yet says nothing, so an attached-but-unusable
  // credential keeps the reason it came with until the machine answers.
  const blocked = probe === null ? reason : source.blocked;

  return (
    <div className="space-y-2">
      {advanced ? (
        <div className="space-y-1.5">
          <label
            htmlFor="original-source-home-dir"
            className="block text-[12px] font-medium text-ink"
          >
            {t('st.source.homeDirLabel')}
          </label>
          <input
            id="original-source-home-dir"
            data-original-source-home-dir
            value={source.homeDir}
            placeholder={home}
            onChange={(event) => { source.setHomeDir(event.target.value); }}
            className="w-full rounded-md border border-hairline-strong bg-paper px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-ink"
          />
          <Hint>{t('st.source.homeDirHint', { app })}</Hint>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-original-source-probe
          className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`}
          disabled={source.probing}
          onClick={() => { void source.probeOriginal(); }}
        >
          <Icon name="search" size={12} />
          {source.probing ? t('st.source.probing') : t('st.source.probe')}
        </button>
        <button
          type="button"
          data-original-source-advanced
          className="text-[12px] text-ink-soft underline-offset-2 hover:underline"
          onClick={() => { setAdvanced(!advanced); }}
        >
          {t('st.source.advanced')}
        </button>
      </div>

      {probe === null ? null : (
        <div
          data-original-source-result={blocked ?? 'connectable'}
          className={`rounded-md border px-2.5 py-2 text-[12px] leading-4 ${
            blocked === null ? 'border-hairline text-ink-soft' : 'border-amber-rule/40 bg-amber-rule/5 text-ink-soft'}`}
        >
          {blocked === null ? (
            <>
              <p className="text-ink">
                {/* Kimi Code keeps a credential slot, not an account identity:
                    an unknown account there is the normal answer, not a sign
                    that something is missing, so it is stated without the
                    "which account" caveat. */}
                {probe.account.state === 'known'
                  ? t('st.source.foundAccount', { account: probe.account.id })
                  : probe.provider === 'kimi-code'
                    ? t('st.source.foundSignIn', { app })
                    : t('st.source.foundAccountUnknown')}
              </p>
              <p className="mt-0.5 text-ink-faint">
                {storageKey(probe.storage_backend) === null
                  ? null
                  : t('st.source.storage', { storage: t(storageKey(probe.storage_backend) as I18nKey) })}
                {probe.state === 'refresh_required' ? ` ${t('st.source.renews')}` : ''}
              </p>
            </>
          ) : (
            <p>{t(BLOCK_KEY[blocked], { app })}</p>
          )}
        </div>
      )}

      {probe !== null && blocked === null ? (
        <button
          type="button"
          data-original-source-connect
          className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`}
          disabled={source.connecting}
          onClick={() => { void source.connectOriginal(); }}
        >
          <Icon name="arrowRight" size={12} />
          {source.connecting ? t('st.source.connecting') : t('st.source.connect')}
        </button>
      ) : null}
    </div>
  );
}
