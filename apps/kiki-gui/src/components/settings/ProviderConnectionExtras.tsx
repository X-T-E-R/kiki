import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { useDirtyReporter } from '../dirtyGuard';
import { Icon } from '../icons';
import { INPUT, SECONDARY_BUTTON } from '../ui';
import { FORM_LABEL, SettingsDraftFooter, SettingsSelect } from './SettingsPrimitives';
import { KEEP_SECRET, SecretField, type SecretDraft } from './SecretField';
import { useSavedTick } from './useSavedTick';

type ModelSource = 'static' | 'discover' | 'oauth-catalog';
type SourceChoice = 'inherit' | ModelSource;

/**
 * One header or env entry. Stored values are write-only: the server returns
 * only names, so a stored row starts in `keep`, and a new row has no name yet.
 */
interface NamedEntry {
  readonly id: number;
  readonly stored: boolean;
  name: string;
  value: SecretDraft;
  removed: boolean;
}

let entrySeq = 0;
const storedEntries = (names: readonly string[] | undefined): NamedEntry[] =>
  (names ?? []).map((name) => ({ id: ++entrySeq, stored: true, name, value: KEEP_SECRET, removed: false }));

/** Per-name patch: set values, null for removed names; renaming = remove + set. */
function namedPatch(entries: readonly NamedEntry[], stored: readonly string[]): Record<string, string | null> | undefined {
  const patch: Record<string, string | null> = {};
  for (const entry of entries) {
    const name = entry.name.trim();
    if (entry.stored && entry.removed) { patch[name] = null; continue; }
    if (entry.value.mode === 'set' && name !== '') patch[name] = entry.value.value;
  }
  for (const name of stored) if (!entries.some((entry) => entry.stored && entry.name === name)) patch[name] = null;
  return Object.keys(patch).length === 0 ? undefined : patch;
}

function entriesDirty(entries: readonly NamedEntry[]): boolean {
  return entries.some((entry) => entry.removed || entry.value.mode === 'set' || (!entry.stored && entry.name.trim() !== ''));
}

function NamedValues({ kind, entries, onChange, disabled, issueId }: {
  kind: 'header' | 'env';
  entries: NamedEntry[];
  onChange: (next: NamedEntry[]) => void;
  disabled: boolean;
  issueId: number | null;
}) {
  const { t } = useI18n();
  const newName = useRef<number | null>(null);
  useEffect(() => {
    if (newName.current === null) return;
    document.querySelector<HTMLInputElement>(`[data-named-entry="${newName.current}"]`)?.focus();
    newName.current = null;
  });
  const update = (id: number, patch: Partial<NamedEntry>) => {
    onChange(entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
  };
  const label = t(kind === 'header' ? 'st.providerExtras.headers' : 'st.providerExtras.env');
  return (
    <div className="space-y-2" data-provider-named={kind}>
      <div className="flex items-center justify-between gap-3">
        <span className={FORM_LABEL}>{label}</span>
        <button type="button" className={SECONDARY_BUTTON} disabled={disabled}
          onClick={() => {
            const id = ++entrySeq;
            newName.current = id;
            onChange([...entries, { id, stored: false, name: '', value: KEEP_SECRET, removed: false }]);
          }}>
          {t(kind === 'header' ? 'st.providerExtras.addHeader' : 'st.providerExtras.addEnv')}
        </button>
      </div>
      <Hint>{t(kind === 'header' ? 'st.providerExtras.headersHelp' : 'st.providerExtras.envHelp')}</Hint>
      {entries.length === 0 ? <p className="text-[12px] text-ink-faint">{t('st.providerExtras.none')}</p> : null}
      <ul className="space-y-3">
        {entries.map((entry) => (
          <li key={entry.id} data-provider-named-entry={entry.name || 'new'}
            className={`grid gap-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto] sm:items-start ${entry.removed ? 'opacity-60' : ''}`}>
            {entry.stored ? (
              <span className="flex h-8 items-center truncate font-mono text-[12px] text-ink" title={entry.name}>{entry.name}</span>
            ) : (
              <div>
                <input data-named-entry={entry.id} className={`${INPUT} font-mono ${issueId === entry.id ? 'border-danger' : ''}`}
                  value={entry.name} disabled={disabled} aria-invalid={issueId === entry.id}
                  aria-label={t('st.providerExtras.nameAria', { label })}
                  placeholder={kind === 'header' ? 'X-Header-Name' : 'VARIABLE_NAME'}
                  onChange={(event) => { update(entry.id, { name: event.target.value }); }} />
                {issueId === entry.id ? <p role="alert" className="mt-1 text-[12px] text-danger">{t('st.providerExtras.nameRequired')}</p> : null}
              </div>
            )}
            {entry.removed ? (
              <p className="flex h-8 items-center text-[12px] text-amber-ink">{t('st.providerExtras.removePending')}</p>
            ) : (
              <SecretField
                label={t('st.providerExtras.valueLabel', { name: entry.name || label })}
                labelHidden
                source={entry.stored ? 'kiki' : 'none'}
                // Stored values are write-only: set, never viewed or copied back.
                clearable={false}
                draft={entry.value}
                disabled={disabled}
                sourceText={t(entry.stored ? 'st.providerExtras.stored' : 'st.providerExtras.notStored')}
                placeholder={t(entry.stored ? 'st.providerExtras.replacePlaceholder' : 'st.providerExtras.valuePlaceholder')}
                onChange={(value) => { update(entry.id, { value }); }}
              />
            )}
            <button type="button" className={`${SECONDARY_BUTTON} h-8`} disabled={disabled}
              aria-label={t(entry.removed ? 'st.providerExtras.undoRemove' : 'st.providerExtras.remove', { name: entry.name || label })}
              onClick={() => {
                if (!entry.stored) onChange(entries.filter((candidate) => candidate.id !== entry.id));
                else update(entry.id, { removed: !entry.removed, value: KEEP_SECRET });
              }}>
              {entry.removed ? t('st.secret.undoClear') : <Icon name="close" size={14} />}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Provider → Advanced → Connection extras: how the model list is sourced,
 * request headers and env fallbacks (write-only, names read back), and the
 * OAuth credential storage as a read-only status. Saves on its own, like the
 * generation defaults beside it.
 */
export function ProviderConnectionExtras({ providerId, onSaved }: { providerId: string; onSaved?: () => Promise<void> }) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['provider-entity', providerId], queryFn: () => client.getProviderEntity(providerId) });
  const entity = query.data;
  const [source, setSource] = useState<SourceChoice>('inherit');
  const [headers, setHeaders] = useState<NamedEntry[]>([]);
  const [env, setEnv] = useState<NamedEntry[]>([]);
  const [revision, setRevision] = useState('');
  const [saving, setSaving] = useState(false);
  const [issueId, setIssueId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [justSaved, pingSaved] = useSavedTick();
  const storedSource: SourceChoice = entity?.model_source ?? 'inherit';
  const dirty = entity !== undefined && (source !== storedSource || entriesDirty(headers) || entriesDirty(env));
  useDirtyReporter(`provider-extras:${providerId}`, dirty);

  const reset = () => {
    if (entity === undefined) return;
    setSource(entity.model_source ?? 'inherit');
    setHeaders(storedEntries(entity.custom_header_keys));
    setEnv(storedEntries(entity.env_keys));
    setRevision(entity.revision);
    setIssueId(null);
  };
  useEffect(() => {
    if (entity === undefined || dirty || saving || entity.revision === revision) return;
    reset();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reset reads the same entity
  }, [entity, dirty, saving, revision]);

  if (query.isError) return <InlineError error={query.error} />;
  if (entity === undefined) return <Hint>{t('st.runtime.loading')}</Hint>;

  const save = async () => {
    const unnamed = [...headers, ...env].find((entry) => !entry.stored && entry.name.trim() === '' && entry.value.mode === 'set');
    if (unnamed !== undefined) { setIssueId(unnamed.id); return; }
    setSaving(true);
    setFeedback(null);
    try {
      const customHeaders = namedPatch(headers, entity.custom_header_keys ?? []);
      const envPatch = namedPatch(env, entity.env_keys ?? []);
      await client.updateProvider(providerId, {
        base_revision: revision,
        ...(source !== storedSource ? { model_source: source === 'inherit' ? null : source } : {}),
        ...(customHeaders === undefined ? {} : { custom_headers: customHeaders }),
        ...(envPatch === undefined ? {} : { env: envPatch }),
      });
      const fresh = await query.refetch();
      if (fresh.data !== undefined) {
        setSource(fresh.data.model_source ?? 'inherit');
        setHeaders(storedEntries(fresh.data.custom_header_keys));
        setEnv(storedEntries(fresh.data.env_keys));
        setRevision(fresh.data.revision);
      }
      await queryClient.invalidateQueries({ queryKey: ['providers'] });
      await onSaved?.();
      pingSaved();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 rounded-lg border border-hairline bg-panel/50 p-3" data-provider-extras={providerId}>
      <p className="text-[11px] font-semibold text-ink-soft">{t('st.providerExtras.title')}</p>
      <div className="max-w-sm">
        <span className={FORM_LABEL}>{t('st.providerExtras.modelSource')}</span>
        <div className="mt-1">
          <SettingsSelect<SourceChoice>
            variant="form"
            ariaLabel={t('st.providerExtras.modelSource')}
            dataAttr="data-provider-model-source"
            value={source}
            disabled={saving}
            onChange={setSource}
            choices={[
              { value: 'inherit', label: t('st.providerExtras.sourceInherit') },
              { value: 'static', label: t('st.providerExtras.sourceStatic'), hint: t('st.providerExtras.sourceStaticHint') },
              { value: 'discover', label: t('st.providerExtras.sourceDiscover'), hint: t('st.providerExtras.sourceDiscoverHint') },
              { value: 'oauth-catalog', label: t('st.providerExtras.sourceOauth'), hint: t('st.providerExtras.sourceOauthHint') },
            ]}
          />
        </div>
      </div>
      <NamedValues kind="header" entries={headers} onChange={(next) => { setHeaders(next); setIssueId(null); }} disabled={saving} issueId={issueId} />
      <NamedValues kind="env" entries={env} onChange={(next) => { setEnv(next); setIssueId(null); }} disabled={saving} issueId={issueId} />
      {entity.oauth !== undefined ? (
        <p className="text-[12px] text-ink-soft" data-provider-oauth={entity.oauth.storage}>
          {t('st.providerExtras.oauth', {
            storage: t(entity.oauth.storage === 'keyring' ? 'st.providerExtras.storageKeyring' : 'st.providerExtras.storageFile'),
            state: t(entity.oauth.signed_in ? 'st.providerExtras.signedIn' : 'st.providerExtras.signedOut'),
          })}
        </p>
      ) : null}
      <SettingsDraftFooter saved={justSaved} id={`provider-extras-${providerId}`} dirty={dirty} saving={saving}
        onSave={() => void save()} onDiscard={() => { reset(); setFeedback(null); }} />
      <FeedbackLine feedback={feedback} />
    </div>
  );
}
