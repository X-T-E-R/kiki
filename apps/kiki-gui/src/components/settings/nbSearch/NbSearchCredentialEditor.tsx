import { useCallback, useEffect, useState } from 'react';
import type { NbSearchManagedCredentialView } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { KEEP_SECRET, SecretField, type SecretDraft } from '../SecretField';

type ReadCredential = (instanceId: string, reveal: boolean) => Promise<NbSearchManagedCredentialView>;
type WriteCredential = (instanceId: string, value: string | null, version: string, binding: string) => Promise<NbSearchManagedCredentialView>;

/**
 * The provider's credential slot on the shared secret field. Whatever source
 * wins (a value saved in Kiki, the server environment or nb-search
 * secrets.json) stays viewable; saving here stores a Kiki value that
 * overrides the others, and clearing it falls back to them.
 */
export function NbSearchCredentialEditor({ instanceId, disabled, read, write }: {
  instanceId: string;
  disabled: boolean;
  read: ReadCredential;
  write: WriteCredential;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<NbSearchManagedCredentialView | null>(null);
  const [draft, setDraft] = useState<SecretDraft>(KEEP_SECRET);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'load' | 'save' | 'conflict' | null>(null);
  const [notice, setNotice] = useState<'saved' | 'cleared' | null>(null);

  const load = useCallback(() => {
    let live = true;
    setState(null);
    setDraft(KEEP_SECRET);
    setError(null);
    void read(instanceId, false).then((result) => {
      if (live) setState(result);
    }, () => {
      if (live) setError('load');
    });
    return () => { live = false; };
  }, [instanceId, read]);
  useEffect(load, [load]);

  const version = state?.version;
  const reveal = useCallback(async () => {
    void version;
    return (await read(instanceId, true)).value;
  }, [instanceId, read, version]);

  const save = async () => {
    if (state === null || draft.mode === 'keep') return;
    const value = draft.mode === 'clear' ? null : draft.value.trim();
    if (value === '') return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await write(instanceId, value, state.version, state.binding_version);
      setState(result);
      setDraft(KEEP_SECRET);
      setNotice(value === null ? 'cleared' : 'saved');
    } catch (cause) {
      setError(cause !== null && typeof cause === 'object' && 'code' in cause && cause.code === 40941 ? 'conflict' : 'save');
    } finally {
      setBusy(false);
    }
  };

  const source = state === null ? 'none' : state.source === 'managed' ? 'kiki' : state.source;
  const pending = draft.mode === 'clear' || (draft.mode === 'set' && draft.value.trim() !== '');
  return (
    <div className="space-y-2" data-nb-search-credential={instanceId}>
      <SecretField
        label={t('st.nbSearch.managed.title')}
        source={source}
        envName={state?.env_name}
        draft={draft}
        onChange={(next) => { setDraft(next); setNotice(null); }}
        reveal={state === null || state.source === 'none' ? undefined : reveal}
        clearable={state?.stored === true}
        disabled={busy || disabled || state === null}
        hint={t('st.nbSearch.managed.hint')}
      />
      {pending || error !== null ? (
        <div className="flex flex-wrap items-center gap-2">
          {pending ? (
            <button type="button" className={PRIMARY_BUTTON} disabled={busy || disabled || state === null} onClick={() => void save()}>
              {busy ? t('common.saving') : t('common.save')}
            </button>
          ) : null}
          {error !== null ? <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={load}>{t('common.retry')}</button> : null}
        </div>
      ) : null}
      {disabled ? <p className="text-[12px] text-amber-ink">{t('st.nbSearch.managed.saveConfigFirst')}</p> : null}
      {error !== null ? <p role="alert" className="text-[12px] text-danger">{t(`st.nbSearch.managed.error.${error}`)}</p> : null}
      {notice !== null ? <p role="status" className="text-[12px] text-success">{t(notice === 'saved' ? 'st.secret.saved' : 'st.secret.cleared')}</p> : null}
    </div>
  );
}
