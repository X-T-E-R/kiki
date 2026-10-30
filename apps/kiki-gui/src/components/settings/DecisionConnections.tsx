/**
 * Decision models, in Models & providers: which service each job asks
 * (approval review, Memory Advisor), then the services — Jev, any System One
 * service, and rerank or classifier endpoints. Each service is an ordinary
 * connection, so its address, key, reveal and removal work the way every
 * other connection's do; it only has no chat models. This card is the only
 * place a decision source is chosen or a decision key is entered.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';

import { providerIdSchema, type DecisionConnectionProbeResult, type DecisionProtocol, type ProviderCatalogItem } from '@kiki/protocol';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import {
  DECISION_CONNECTION_PARAM,
  DECISION_CONNECTION_PRESETS,
  decisionConnectionDestination,
  decisionConnectionEndpoint,
  decisionEndpointIssue,
  decisionProtocolOf,
  type DecisionConnectionPreset,
  type DecisionEndpointIssue,
} from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, type Feedback } from '../controls';
import { useDirtyReporter } from '../dirtyGuard';
import { Icon } from '../icons';
import { hostLabel } from '../providerPresets';
import { DANGER_GHOST_BUTTON, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { KEEP_SECRET, SecretField, type SecretDraft } from './SecretField';
import { DecisionJudgeRows } from './DecisionSources';
import { RowFrame } from './RowFrame';
import { SectionCard } from './SectionCard';
import { AdvancedDetails, SettingField } from './fields';
import { FieldIssue, SettingsDraftFooter, SettingsSegmented } from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';

/** A server environment variable name, as the shell would accept it. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ADD_HASH = '#decision-connection-add';

/** The editable part of a decision connection; the key itself is a separate draft. */
interface ConnectionDraft {
  readonly baseUrl: string;
  readonly defaultModel: string;
  readonly endpoint: string;
  /** The server variable the key is read from; empty for none. */
  readonly keyEnv: string;
}
type DraftField = keyof ConnectionDraft;
const DRAFT_FIELDS: readonly DraftField[] = ['baseUrl', 'defaultModel', 'endpoint', 'keyEnv'];

function draftOf(provider: ProviderCatalogItem): ConnectionDraft {
  return {
    baseUrl: provider.base_url ?? '', defaultModel: provider.default_model ?? '',
    endpoint: provider.decision_endpoint ?? '', keyEnv: provider.api_key_env ?? '',
  };
}

const sameDraft = (a: ConnectionDraft, b: ConnectionDraft) => DRAFT_FIELDS.every((field) => a[field] === b[field]);

/**
 * A draft re-based on a newer save: fields left alone take the saved value,
 * edited fields keep the edit, and an edit the other save also changed
 * (to something else) is reported.
 */
function rebaseDraft(draft: ConnectionDraft, baseline: ConnectionDraft, latest: ConnectionDraft): {
  readonly draft: ConnectionDraft;
  readonly conflicts: readonly DraftField[];
} {
  const next = { ...draft };
  const conflicts: DraftField[] = [];
  for (const field of DRAFT_FIELDS) {
    if (draft[field] === baseline[field]) next[field] = latest[field];
    else if (latest[field] !== baseline[field] && latest[field] !== draft[field]) conflicts.push(field);
  }
  return { draft: next, conflicts };
}

type BaseUrlIssue = 'invalid' | 'credentials';

function baseUrlIssue(text: string): BaseUrlIssue | null {
  try {
    const url = new URL(text.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'invalid';
    // The server refuses a user name or password in the address.
    return url.username !== '' || url.password !== '' ? 'credentials' : null;
  } catch {
    return 'invalid';
  }
}

const FIELD_LABEL_KEYS: Readonly<Record<DraftField, I18nKey>> = {
  baseUrl: 'st.decision.baseUrl', defaultModel: 'st.decision.model', endpoint: 'st.decision.endpoint', keyEnv: 'st.decision.keyEnv',
};

const isRevisionConflict = (error: unknown) =>
  error !== null && typeof error === 'object' && 'code' in error && error.code === 40941;

const ENDPOINT_ISSUE_KEYS: Readonly<Record<DecisionEndpointIssue, I18nKey>> = {
  invalid: 'st.decision.endpointInvalid',
  origin: 'st.decision.endpointOrigin',
  credentials: 'st.decision.endpointCredentials',
};

/** Which preset a saved connection reads as: Jev by its address, else by protocol. */
function presetOf(provider: Pick<ProviderCatalogItem, 'type' | 'decision_protocol' | 'base_url' | 'effective_base_url'>): DecisionConnectionPreset['id'] {
  const protocol = decisionProtocolOf(provider);
  if (protocol === 'pair_score') return 'pair_score';
  const host = hostLabel(provider.effective_base_url ?? provider.base_url);
  return host === 'api.typesafe.ai' ? 'jev' : 'system_one';
}

function freeId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * The card: every decision connection, then one way to add another. With
 * none yet, the card is the short explanation and the add form.
 */
export function DecisionConnectionsCard({ providers, configuredIds, onChanged }: {
  readonly providers: readonly ProviderCatalogItem[];
  /** Every connection id, chat or decision: a new one may not reuse any. */
  readonly configuredIds: ReadonlySet<string>;
  readonly onChanged: () => Promise<void>;
}) {
  const { t } = useI18n();
  const { hash } = useLocation();
  const [params] = useSearchParams();
  const requested = params.get(DECISION_CONNECTION_PARAM);
  const [adding, setAdding] = useState(hash === ADD_HASH);
  useEffect(() => { if (hash === ADD_HASH) setAdding(true); }, [hash]);
  // The list's one open slot (#13): a deep link names its row, a click moves
  // it; a row holding unsaved edits keeps its own open state (#14).
  const [openId, setOpenId] = useState<string | null>(requested);
  // The one home for decision models: which job uses what on top, then the
  // services themselves with their address and key. No other page asks for
  // a decision key or picks a decision source.
  return (
    <SectionCard id="st-card-decision-connections" title={t('st.decision.connectionsTitle')}
      actions={adding ? undefined : (
        <button type="button" data-decision-add className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`}
          onClick={() => { setAdding(true); }}>
          <Icon name="plus" size={12} />{t('st.decision.add')}
        </button>
      )}>
      <div className="space-y-6" data-decision-connections>
        <div className="space-y-2">
          <Hint>{t('st.decision.judgesHint')}</Hint>
          <DecisionJudgeRows />
        </div>
        <div className="space-y-2" data-decision-services>
          {providers.length === 0 ? <Hint>{t('st.decision.connectionsHint')}</Hint> : (
            <div data-decision-list>
              {providers.map((provider) => (
                <DecisionConnectionRow key={provider.id} provider={provider}
                  open={openId === provider.id}
                  onOpenChange={(open) => { setOpenId(open ? provider.id : null); }}
                  defaultOpen={requested === provider.id} onChanged={onChanged} />
              ))}
            </div>
          )}
          {adding ? (
            <NewDecisionConnection configuredIds={configuredIds}
              onCancel={() => { setAdding(false); }}
              onCreated={async () => { await onChanged(); setAdding(false); }} />
          ) : null}
        </div>
      </div>
    </SectionCard>
  );
}

/** Base URL, key, model name and the optional endpoint: shared by the add form and each row. */
function ConnectionFields({ idPrefix, draft, onChange, keyDraft, onKeyChange, keySource, keyEnv, keyHint, reveal, protocol }: {
  readonly idPrefix: string;
  readonly draft: ConnectionDraft;
  readonly onChange: (draft: ConnectionDraft) => void;
  readonly keyDraft: SecretDraft;
  readonly onKeyChange: (draft: SecretDraft) => void;
  readonly keySource: 'kiki' | 'environment' | 'none';
  readonly keyEnv?: string;
  readonly reveal?: () => Promise<string | undefined>;
  /** What the key line should say when nothing explains it yet (no key, a variable not set). */
  readonly keyHint?: string;
  readonly protocol: DecisionProtocol;
}) {
  const { t } = useI18n();
  const baseKind = draft.baseUrl.trim() === '' ? null : baseUrlIssue(draft.baseUrl);
  const baseIssue = baseKind === null ? null : t(baseKind === 'credentials' ? 'st.decision.endpointCredentials' : 'st.decision.baseUrlInvalid');
  const endpointIssue = baseIssue === null && draft.baseUrl.trim() !== '' ? decisionEndpointIssue(draft.baseUrl, draft.endpoint) : null;
  const keyEnvIssue = draft.keyEnv.trim() !== '' && !ENV_NAME.test(draft.keyEnv.trim()) ? t('st.decision.keyEnvInvalid') : null;
  const target = decisionConnectionEndpoint(draft.baseUrl, protocol);
  return (
    <div className="space-y-3">
      <SettingField label={t('st.decision.baseUrl')} htmlFor={`${idPrefix}-base`} layout="stack">
        <input id={`${idPrefix}-base`} data-decision-base-url className={`${INPUT} max-w-xl font-mono`} value={draft.baseUrl}
          placeholder="https://" spellCheck={false} autoComplete="off" aria-invalid={baseIssue !== null}
          onChange={(event) => { onChange({ ...draft, baseUrl: event.target.value }); }} />
        <FieldIssue id={`${idPrefix}-base-issue`} text={baseIssue} />
      </SettingField>
      <div className="max-w-xl">
        <SecretField id={`${idPrefix}-key`} label={t('st.decision.key')} source={keySource} envName={keyEnv}
          draft={keyDraft} onChange={onKeyChange} reveal={reveal} hint={keyHint} />
      </div>
      <SettingField label={t('st.decision.model')} htmlFor={`${idPrefix}-model`} layout="stack" help={t('st.decision.modelHint')}>
        <input id={`${idPrefix}-model`} data-decision-model className={`${INPUT} max-w-sm font-mono`} value={draft.defaultModel}
          spellCheck={false} autoComplete="off"
          onChange={(event) => { onChange({ ...draft, defaultModel: event.target.value }); }} />
      </SettingField>
      <AdvancedDetails summary={t('st.advanced.disclosure')} data-decision-advanced open={draft.endpoint.trim() !== '' || undefined}>
        <div className="space-y-3 pt-1 text-[13px] text-ink">
          <SettingField label={t('st.decision.keyEnv')} htmlFor={`${idPrefix}-key-env`} layout="stack" help={t('st.decision.keyEnvFieldHint')}>
            <input id={`${idPrefix}-key-env`} data-decision-key-env className={`${INPUT} max-w-xs font-mono`} value={draft.keyEnv}
              placeholder="YOUR_API_KEY" spellCheck={false} autoComplete="off" aria-invalid={keyEnvIssue !== null}
              onChange={(event) => { onChange({ ...draft, keyEnv: event.target.value }); }} />
            <FieldIssue id={`${idPrefix}-key-env-issue`} text={keyEnvIssue} />
          </SettingField>
          <SettingField label={t('st.decision.endpoint')} htmlFor={`${idPrefix}-endpoint`} layout="stack"
            help={target === null || endpointIssue !== null ? undefined : t('st.decision.endpointHint', { origin: target.origin, path: target.pathname })}>
            <input id={`${idPrefix}-endpoint`} data-decision-endpoint className={`${INPUT} max-w-xl font-mono`} value={draft.endpoint}
              placeholder={target?.pathname ?? '/'} spellCheck={false} autoComplete="off" aria-invalid={endpointIssue !== null}
              onChange={(event) => { onChange({ ...draft, endpoint: event.target.value }); }} />
            {endpointIssue !== null ? (
              <p data-decision-endpoint-issue={endpointIssue} role="alert" className="max-w-[62ch] text-[12px] leading-snug text-danger">
                {t(ENDPOINT_ISSUE_KEYS[endpointIssue], { origin: target?.origin ?? draft.baseUrl })}
              </p>
            ) : null}
          </SettingField>
        </div>
      </AdvancedDetails>
    </div>
  );
}

/** Whether a draft may be written: a usable address, an endpoint on it, a usable variable name. */
function draftValid(draft: ConnectionDraft): boolean {
  return baseUrlIssue(draft.baseUrl) === null && decisionEndpointIssue(draft.baseUrl, draft.endpoint) === null
    && (draft.keyEnv.trim() === '' || ENV_NAME.test(draft.keyEnv.trim()));
}

/**
 * Add form: pick the kind (Jev fills in its address, key variable and model
 * name), then the same fields a saved row shows. No chat-model fields: a
 * decision service has no context size, thinking or model discovery.
 */
function NewDecisionConnection({ configuredIds, onCancel, onCreated }: {
  readonly configuredIds: ReadonlySet<string>;
  readonly onCancel: () => void;
  readonly onCreated: () => Promise<void>;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const idPrefix = useId();
  const [presetId, setPresetId] = useState<DecisionConnectionPreset['id']>('jev');
  const preset = DECISION_CONNECTION_PRESETS.find((item) => item.id === presetId)!;
  const [id, setId] = useState(() => freeId(preset.suggestedId, configuredIds));
  const [idTouched, setIdTouched] = useState(false);
  const [draft, setDraft] = useState<ConnectionDraft>({ baseUrl: preset.baseUrl, defaultModel: preset.defaultModel, endpoint: '', keyEnv: preset.apiKeyEnv ?? '' });
  const [key, setKey] = useState<SecretDraft>(KEEP_SECRET);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  useDirtyReporter('decision-connection:new', true);

  const choose = (next: DecisionConnectionPreset['id']) => {
    const chosen = DECISION_CONNECTION_PRESETS.find((item) => item.id === next)!;
    setPresetId(next);
    setDraft({ baseUrl: chosen.baseUrl, defaultModel: chosen.defaultModel, endpoint: '', keyEnv: chosen.apiKeyEnv ?? '' });
    if (!idTouched) setId(freeId(chosen.suggestedId, configuredIds));
    setFeedback(null);
  };
  const trimmedId = id.trim();
  const idIssue = trimmedId === '' ? null
    : !providerIdSchema.safeParse(trimmedId).success ? t('st.decision.idInvalid')
      : configuredIds.has(trimmedId) ? t('st.decision.idTaken') : null;
  const keyValue = key.mode === 'set' ? key.value.trim() : '';
  const canSave = trimmedId !== '' && idIssue === null && draftValid(draft) && !saving;

  const create = async () => {
    if (!canSave) return;
    setSaving(true);
    setFeedback(null);
    try {
      await client.createProvider({
        id: trimmedId,
        type: preset.type,
        base_url: draft.baseUrl.trim(),
        api_key: keyValue === '' ? undefined : keyValue,
        // Without a typed key the server reads the named variable; nothing is copied.
        api_key_env: keyValue === '' ? draft.keyEnv.trim() || undefined : undefined,
        default_model: draft.defaultModel.trim() || undefined,
        decision_endpoint: draft.endpoint.trim() || undefined,
      });
      await onCreated();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
      setSaving(false);
    }
  };

  return (
    <div data-decision-new id="decision-connection-add" className="space-y-4 rounded-lg border border-hairline bg-paper p-4">
      <p className="text-[13px] font-medium text-ink">{t('st.decision.addTitle')}</p>
      <fieldset disabled={saving} className="min-w-0 space-y-3 disabled:opacity-60">
        <SettingField label={t('st.decision.kind')} labelId={`${idPrefix}-kind`} layout="stack"
          help={t(`st.decision.presetHint.${presetId}` as I18nKey)}>
          <SettingsSegmented<DecisionConnectionPreset['id']> ariaLabelledBy={`${idPrefix}-kind`} dataAttr="data-decision-preset"
            value={presetId} onChange={choose}
            choices={DECISION_CONNECTION_PRESETS.map((item) => ({ value: item.id, label: t(`st.decision.preset.${item.id}` as I18nKey) }))} />
        </SettingField>
        <SettingField label={t('st.decision.id')} htmlFor={`${idPrefix}-id`} layout="stack">
          <input id={`${idPrefix}-id`} data-decision-id className={`${INPUT} max-w-xs font-mono`} value={id}
            spellCheck={false} autoComplete="off" aria-invalid={idIssue !== null}
            onChange={(event) => { setId(event.target.value); setIdTouched(true); }} />
          <FieldIssue id={`${idPrefix}-id-issue`} text={idIssue} />
        </SettingField>
        <ConnectionFields idPrefix={idPrefix} draft={draft} onChange={(next) => { setDraft(next); setFeedback(null); }}
          keyDraft={key} onKeyChange={setKey} keySource="none" protocol={preset.type}
          keyHint={draft.keyEnv.trim() !== '' && ENV_NAME.test(draft.keyEnv.trim()) ? t('st.decision.keyEnvHint', { name: draft.keyEnv.trim() }) : t('st.decision.keyNone')} />
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" data-decision-create className={PRIMARY_BUTTON} disabled={!canSave} onClick={() => void create()}>
          {saving ? t('common.saving') : t('st.decision.create')}
        </button>
        <button type="button" className={SECONDARY_BUTTON} disabled={saving} onClick={onCancel}>{t('common.cancel')}</button>
      </div>
      <FeedbackLine feedback={feedback} />
    </div>
  );
}

/** One saved decision service: a row that opens into its fields, test and removal. */
function DecisionConnectionRow({ provider, open, onOpenChange, defaultOpen, onChanged }: {
  readonly provider: ProviderCatalogItem;
  /** The list's one open slot, unless this row holds unsaved edits — then it
   *  keeps its own open state so an edit is never folded away (#14). */
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly defaultOpen: boolean;
  readonly onChanged: () => Promise<void>;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const idPrefix = useId();
  const protocol = decisionProtocolOf(provider) ?? 'system_one';
  const preset = DECISION_CONNECTION_PRESETS.find((item) => item.id === presetOf(provider))!;
  const read = draftOf(provider);
  // A dirty row keeps the baseline and revision it was edited against, even
  // when the list refreshes underneath it: a newer read never blesses an
  // older draft, and untouched fields are not written back.
  const [baseline, setBaseline] = useState(read);
  const [draft, setDraft] = useState(read);
  const [revision, setRevision] = useState<string | undefined>();
  const [conflicts, setConflicts] = useState<{ fields: readonly DraftField[]; saved: ConnectionDraft } | null>(null);
  const [key, setKey] = useState<SecretDraft>(KEEP_SECRET);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [saved, ping] = useSavedTick();
  const [confirming, setConfirming] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ result?: DecisionConnectionProbeResult; error?: unknown }>();
  const dirty = !sameDraft(draft, baseline) || key.mode !== 'keep';
  useDirtyReporter(`decision-connection:${provider.id}`, dirty);
  // Only a new read moves a clean row; its own save already set the baseline.
  const readKey = JSON.stringify(read);
  const [seenRead, setSeenRead] = useState(readKey);
  useEffect(() => {
    if (readKey === seenRead || dirty || saving) return;
    setSeenRead(readKey);
    if (sameDraft(read, baseline)) return;
    setBaseline(read); setDraft(read); setRevision(undefined); setConflicts(null);
  }, [readKey, seenRead, dirty, saving]); // eslint-disable-line react-hooks/exhaustive-deps
  // The revision and the baseline come from one entity read, never a list row
  // paired with a newer revision. A read that lands while the row is dirty
  // re-bases the draft on it, the same way a 409 does.
  const live = useRef({ draft, baseline });
  live.current = { draft, baseline };
  const baselineKey = JSON.stringify(baseline);
  useEffect(() => {
    if (revision !== undefined) return;
    let current = true;
    void client.getProviderEntity(provider.id).then((entity) => {
      if (!current) return;
      const snapshot = draftOf(entity);
      const { draft: editing, baseline: from } = live.current;
      setRevision(entity.revision);
      if (sameDraft(snapshot, from)) return;
      const rebased = rebaseDraft(editing, from, snapshot);
      setBaseline(snapshot);
      setDraft(rebased.draft);
      if (rebased.conflicts.length > 0) {
        setConflicts({ fields: rebased.conflicts, saved: snapshot });
        setFeedback({ tone: 'error', text: t('st.decision.conflict') });
      }
    }).catch(() => {});
    return () => { current = false; };
  }, [baselineKey, revision, provider.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Every save renews the reveal handle, so a copy shown before a key change
  // is dropped even when the listing reads the same afterwards.
  const [keySaves, setKeySaves] = useState(0);
  const keySource = provider.api_key_env !== undefined ? 'environment' : provider.has_api_key ? 'kiki' : 'none';
  const reveal = useCallback(
    async () => (await client.revealSecret({ kind: 'provider_api_key', provider_id: provider.id })).value,
    [client, provider.id, provider.has_api_key, provider.api_key_env, keySaves], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const destination = decisionConnectionDestination(provider);
  // `has_api_key` is the effective answer: an inline key, or a named variable
  // that is set. No key at all is a valid setup (keyless or custom-header
  // services); only a named variable that is not set is reported.
  const envMissing = provider.api_key_env !== undefined && !provider.has_api_key;
  const needsModel = (provider.default_model ?? '') === '';
  const testFailed = test?.result !== undefined && !test.result.ok;
  const state: 'ok' | 'setup' | 'error' = testFailed ? 'error'
    : envMissing || needsModel ? 'setup'
      : provider.status === 'error' ? 'error' : 'ok';
  const stateText = testFailed && test.result?.reason === 'auth' ? t('st.decision.reason.auth')
    : state === 'error' ? t('st.connections.statusError')
      : envMissing ? t('st.decision.status.envMissing', { name: provider.api_key_env ?? '' })
        : needsModel ? t('st.decision.status.needsModel') : t('st.decision.status.ready');
  const keyHint = envMissing ? t('st.decision.keyEnvMissing', { name: provider.api_key_env ?? '' })
    : keySource === 'none' ? t('st.decision.keyNone') : undefined;

  const save = async () => {
    if (!dirty || !draftValid(draft) || revision === undefined) return;
    setSaving(true);
    setFeedback(null);
    try {
      const keyValue = key.mode === 'set' ? key.value.trim() : '';
      const changed = (field: DraftField) => draft[field] !== baseline[field];
      const entity = await client.updateProvider(provider.id, {
        base_revision: revision,
        base_url: changed('baseUrl') ? draft.baseUrl.trim() : undefined,
        default_model: changed('defaultModel') ? draft.defaultModel.trim() || null : undefined,
        decision_endpoint: changed('endpoint') ? draft.endpoint.trim() || null : undefined,
        api_key_env: changed('keyEnv') ? draft.keyEnv.trim() || null : undefined,
        api_key: key.mode === 'clear' ? '' : keyValue !== '' ? keyValue : undefined,
      });
      const next = draftOf(entity);
      setBaseline(next); setDraft(next); setRevision(entity.revision); setConflicts(null);
      setKey(KEEP_SECRET);
      setKeySaves((count) => count + 1);
      setTest(undefined);
      await onChanged();
      ping();
    } catch (error) {
      if (isRevisionConflict(error)) {
        // Nothing was written. Re-base the draft on what is saved now and let
        // the person check it; the next click saves against the new revision.
        try {
          const latest = await client.getProviderEntity(provider.id);
          const saved = draftOf(latest);
          const rebased = rebaseDraft(draft, baseline, saved);
          setBaseline(saved); setDraft(rebased.draft); setRevision(latest.revision);
          setConflicts(rebased.conflicts.length === 0 ? null : { fields: rebased.conflicts, saved });
          setFeedback({ tone: 'error', text: t('st.decision.conflict') });
          void onChanged();
        } catch (refreshError) {
          setFeedback({ tone: 'error', text: errorText(locale, refreshError) });
        }
      } else {
        setFeedback({ tone: 'error', text: errorText(locale, error) });
      }
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    if (destination === undefined || testing) return;
    setTesting(true);
    try {
      setTest({ result: await client.probeDecisionSource({ kind: 'connection', connection: provider.id }, destination) });
    } catch (error) {
      setTest({ error });
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      await client.deleteProviderEntity(provider.id);
      await onChanged();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
      setSaving(false);
    }
  };

  const testLine = testing ? <span>{t('st.decision.testing')}</span>
    : test?.error !== undefined ? <span className="text-danger">{t('st.decision.testFailed', { reason: errorText(locale, test.error) })}</span>
      : test?.result === undefined ? null
        : test.result.ok ? <span className="text-success">{t('st.decision.testOk', { ms: Math.round(test.result.duration_ms) })}</span>
          : <span className="text-danger">{t('st.decision.testFailed', {
            reason: t(`st.decision.reason.${test.result.reason ?? 'unavailable'}` as I18nKey),
          })}</span>;

  // A dirty row answers its own open state; a clean one rides the list's
  // single slot.
  const [selfOpen, setSelfOpen] = useState(defaultOpen);
  useEffect(() => { if (defaultOpen) setSelfOpen(true); }, [defaultOpen]);
  const expanded = dirty ? selfOpen : open;

  return (
    <RowFrame
      data={{
        'data-decision-row': provider.id,
        'data-decision-health': state,
      }}
      open={expanded}
      onToggle={() => { if (dirty) setSelfOpen((current) => !current); else onOpenChange(!open); }}
      bodyId={`decision-row-body-${provider.id}`}
      expandLabel={t('st.decision.openRow', { name: provider.id })}
      name={preset.id === 'jev' ? t('st.decision.preset.jev') : provider.id}
      marks={(
        <span className="flex shrink-0 items-center gap-1.5">
          {dirty ? <span className="text-[11px] font-medium text-amber-ink">{t('st.dirty.badge')}</span> : null}
          <span data-decision-status={state} className={`inline-flex items-center gap-1.5 text-[12px] ${
            state === 'error' ? 'text-danger' : state === 'setup' ? 'text-amber-ink' : 'text-ink-faint'}`}>
            <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${state === 'error' ? 'bg-danger' : state === 'setup' ? 'bg-amber-rule' : 'bg-success'}`} />
            {stateText}
          </span>
        </span>
      )}
      subtitle={(
        <>
          <span>{t(`st.decision.protocol.${protocol}` as I18nKey)}</span>
          {hostLabel(provider.effective_base_url ?? provider.base_url) === undefined ? null : (
            <>
              <span aria-hidden>·</span>
              <span>{hostLabel(provider.effective_base_url ?? provider.base_url)}</span>
            </>
          )}
          {provider.default_model === undefined ? null : (
            <>
              <span aria-hidden>·</span>
              <span>{provider.default_model}</span>
            </>
          )}
        </>
      )}
    >
      <div className="space-y-4">
        {destination !== undefined ? (
          <div data-decision-test className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <button type="button" data-decision-test-button className={SECONDARY_BUTTON} disabled={testing || saving || dirty}
              aria-busy={testing} onClick={() => void runTest()}>
              {testing ? t('st.decision.testing') : t('st.decision.test')}
            </button>
            <p data-decision-test-result={test?.result === undefined && test?.error === undefined ? 'none' : test.result?.ok === true ? 'ok' : 'error'}
              aria-live="polite" className="min-w-0 break-all text-[12px] leading-4 text-ink-faint">{testLine}</p>
          </div>
        ) : null}
        <fieldset disabled={saving} className="min-w-0 disabled:opacity-60">
          <ConnectionFields idPrefix={idPrefix} draft={draft} onChange={(next) => { setDraft(next); setFeedback(null); }}
            keyDraft={key} onKeyChange={setKey} keySource={keySource} keyEnv={provider.api_key_env}
            reveal={provider.has_api_key ? reveal : undefined} keyHint={keyHint} protocol={protocol} />
        </fieldset>
        <SettingsDraftFooter id={`decision-connection-${provider.id}`} dirty={dirty} saving={saving} saved={saved}
          saveDisabled={!draftValid(draft) || revision === undefined} saveLabel={t('st.decision.save')}
          onSave={() => void save()} onDiscard={() => { setDraft(baseline); setKey(KEEP_SECRET); setFeedback(null); setConflicts(null); }} />
        <FeedbackLine feedback={feedback} />
        {conflicts !== null ? (
          <p data-decision-conflict={conflicts.fields.join(' ')} role="alert" className="max-w-[62ch] text-[12px] leading-snug text-danger">
            {t('st.decision.conflictFields', {
              fields: conflicts.fields.map((field) => t(FIELD_LABEL_KEYS[field])).join(', '),
              saved: conflicts.fields.map((field) => conflicts.saved[field] || '—').join(', '),
            })}
          </p>
        ) : null}
        <div className="flex justify-end">
          <button type="button" data-decision-remove className={DANGER_GHOST_BUTTON} disabled={saving}
            onClick={() => { setConfirming(true); }}>{t('st.decision.remove')}</button>
        </div>
      </div>
      <ConfirmDialog open={confirming} title={t('st.decision.removeTitle', { id: provider.id })} body={t('st.decision.removeBody')}
        confirmLabel={t('st.decision.removeConfirm')} busy={saving}
        onConfirm={() => { setConfirming(false); void remove(); }}
        onCancel={() => { setConfirming(false); }} />
    </RowFrame>
  );
}
