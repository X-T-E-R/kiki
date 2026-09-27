import { useEffect, useState } from 'react';
import type { NbSearchManagedCredentialView } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import { INPUT, SECONDARY_BUTTON } from '../../ui';

type ReadCredential = (instanceId: string, reveal: boolean) => Promise<NbSearchManagedCredentialView>;
type WriteCredential = (instanceId: string, value: string | null, version: string, binding: string) => Promise<NbSearchManagedCredentialView>;

export function NbSearchCredentialEditor({ instanceId, disabled, read, write }: {
  instanceId: string;
  disabled: boolean;
  read: ReadCredential;
  write: WriteCredential;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<NbSearchManagedCredentialView | null>(null);
  const [draft, setDraft] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'load' | 'save' | 'conflict' | null>(null);

  useEffect(() => {
    let live = true;
    setState(null);
    setDraft('');
    setVisible(false);
    setError(null);
    void read(instanceId, false).then((result) => {
      if (live) setState(result);
    }, () => {
      if (live) setError('load');
    });
    return () => { live = false; };
  }, [instanceId, read]);

  const reveal = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await read(instanceId, true);
      setState(result);
      if (result.value !== undefined) {
        setDraft(result.value);
        setVisible(true);
      } else {
        setError('load');
      }
    } catch {
      setError('load');
    } finally {
      setBusy(false);
    }
  };

  const update = async (value: string | null) => {
    if (state === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await write(instanceId, value, state.version, state.binding_version);
      setState(result);
      setDraft('');
      setVisible(false);
    } catch (cause) {
      setError(cause !== null && typeof cause === 'object' && 'code' in cause && cause.code === 40941 ? 'conflict' : 'save');
    } finally {
      setBusy(false);
    }
  };

  const locked = busy || disabled || state === null;
  return (
    <div className="space-y-2 rounded-md border border-hairline p-2.5 text-[11px]">
      <p className="font-medium text-ink-soft">{t('st.nbSearch.managed.title')}</p>
      <p className="text-ink-faint">{t('st.nbSearch.managed.hint')}</p>
      {state !== null ? (
        <p aria-live="polite" className="text-ink-soft">
          {t(state.stored ? 'st.nbSearch.managed.stored' : 'st.nbSearch.managed.empty')}
          {' · '}{t(`st.nbSearch.managed.source.${state.source}`)}
          {state.stored && !state.active ? ` · ${t('st.nbSearch.managed.inactive')}` : ''}
        </p>
      ) : null}
      <label className="block font-medium text-ink-soft">
        {t('st.nbSearch.managed.value')}
        <input
          className={`${INPUT} mt-1 font-mono`}
          type={visible ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" className={SECONDARY_BUTTON} disabled={locked || !state?.stored || busy} onClick={() => void reveal()}>{t('st.nbSearch.managed.reveal')}</button>
        <button type="button" className={SECONDARY_BUTTON} disabled={!visible} onClick={() => setVisible(false)}>{t('st.nbSearch.managed.hide')}</button>
        <button type="button" className={SECONDARY_BUTTON} disabled={locked || draft.trim().length === 0} onClick={() => void update(draft)}>{t('st.nbSearch.managed.save')}</button>
        <button type="button" className={SECONDARY_BUTTON} disabled={locked || !state?.stored} onClick={() => void update(null)}>{t('st.nbSearch.managed.clear')}</button>
        {error !== null ? <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={() => { setError(null); setDraft(''); setVisible(false); void read(instanceId, false).then(setState, () => setError('load')); }}>{t('common.retry')}</button> : null}
      </div>
      {disabled ? <p className="text-amber-ink">{t('st.nbSearch.managed.saveConfigFirst')}</p> : null}
      {error !== null ? <p role="alert" className="text-danger">{t(`st.nbSearch.managed.error.${error}`)}</p> : null}
    </div>
  );
}
