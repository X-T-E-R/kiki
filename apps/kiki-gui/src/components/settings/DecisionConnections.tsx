/**
 * Standalone decision connections (`openai_decisions`, `system_one`, `pair_score`)
 * and attached decision capabilities on chat connections (`decision_capabilities`).
 *
 * Standalone services render directly inside the unified Connections list with a
 * subtle `Decision` / `决策` badge and no chat-model rows; attached capabilities
 * sit inside a chat connection's editor so `/v1/decisions`, System One, or
 * Rerank can share that connection's base URL and API key.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  providerIdSchema,
  type DecisionCapabilitiesPatch,
  type DecisionCapabilitiesWire,
  type DecisionConnectionProbeResult,
  type DecisionProtocol,
  type ProviderCatalogItem,
} from '@kiki/protocol';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import {
  DECISION_CONNECTION_PARAM,
  DECISION_CONNECTION_PRESETS,
  DECISION_PROTOCOLS,
  decisionConnectionDestination,
  decisionConnectionEndpoint,
  decisionDestination,
  decisionEndpointIssue,
  decisionProtocolOf,
  type DecisionConnectionPreset,
  type DecisionEndpointIssue,
} from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { usePhoneMode } from '../../lib/layoutHooks';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, InlineError, Toggle, type Feedback } from '../controls';
import { useDirtyReporter } from '../dirtyGuard';
import { DisclosureChevron, Icon } from '../icons';
import { hostLabel } from '../providerPresets';
import { DANGER_GHOST_BUTTON, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { KEEP_SECRET, SecretField, type SecretDraft } from './SecretField';
import { DecisionJudgeRows } from './DecisionSources';
import { LIST_ROW_HEIGHT, type ListDensity } from './list';
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
  if (protocol === 'openai_decisions') return 'openai_decisions';
  if (protocol === 'pair_score') return 'pair_score';
  const host = hostLabel(provider.effective_base_url ?? provider.base_url);
  return host === 'api.typesafe.ai' ? 'jev' : 'system_one';
}

function freeId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * Standalone card retained for isolated unit tests; the live settings UI places
 * `DecisionJudgeRows` on Defaults and `DecisionConnectionEditor` in Connections.
 */
export function DecisionConnectionsCard({ providers, configuredIds, onChanged }: {
  readonly providers: readonly ProviderCatalogItem[];
  readonly configuredIds: ReadonlySet<string>;
  readonly onChanged: () => Promise<void>;
}) {
  const { t } = useI18n();
  const { hash } = useLocation();
  const [params] = useSearchParams();
  const requested = params.get(DECISION_CONNECTION_PARAM);
  const [adding, setAdding] = useState(hash === ADD_HASH);
  useEffect(() => { if (hash === ADD_HASH) setAdding(true); }, [hash]);
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
          <p className="text-[12px] font-medium text-ink-soft">{t('st.decision.servicesTitle')}</p>
          {providers.length === 0 ? <Hint>{t('st.decision.connectionsHint')}</Hint> : (
            <div data-decision-list className="divide-y divide-hairline overflow-hidden rounded-lg border border-hairline bg-panel">
              {providers.map((provider) => (
                <DecisionConnectionEditor key={provider.id} provider={provider}
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
 * Add form: pick the decision preset (OpenAI Decisions, Jev, System One, or
 * Rerank), then enter its base URL, key, and default model. No chat-model rows.
 */
export function NewDecisionConnection({
  configuredIds,
  initialPreset = 'openai_decisions',
  onCancel,
  onCreated,
}: {
  readonly configuredIds: ReadonlySet<string>;
  readonly initialPreset?: DecisionConnectionPreset['id'];
  readonly onCancel: () => void;
  readonly onCreated: () => Promise<void>;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const idPrefix = useId();
  const [presetId, setPresetId] = useState<DecisionConnectionPreset['id']>(initialPreset);
  const preset = DECISION_CONNECTION_PRESETS.find((item) => item.id === presetId)!;
  const [id, setId] = useState(() => freeId(preset.suggestedId, configuredIds));
  const [idTouched, setIdTouched] = useState(false);
  const [draft, setDraft] = useState<ConnectionDraft>({
    baseUrl: preset.baseUrl,
    defaultModel: preset.defaultModel,
    endpoint: '',
    keyEnv: preset.apiKeyEnv ?? '',
  });
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

/**
 * One standalone decision connection inside the unified Connections list.
 * Matches `<details data-connection-row={id}>` visually while carrying a quiet
 * `Decision` / `决策` badge and dedicated decision fields + sample probe.
 */
export function DecisionConnectionEditor({
  provider,
  density = 'comfortable',
  defaultOpen = false,
  openFocusKeySignal = 0,
  onChanged,
}: {
  readonly provider: ProviderCatalogItem;
  readonly density?: ListDensity;
  readonly defaultOpen?: boolean;
  readonly openFocusKeySignal?: number;
  readonly onChanged: () => Promise<void>;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const phone = usePhoneMode();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const idPrefix = useId();
  const protocol = decisionProtocolOf(provider) ?? 'system_one';
  const preset = DECISION_CONNECTION_PRESETS.find((item) => item.id === presetOf(provider))!;
  const read = draftOf(provider);
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

  const readKey = JSON.stringify(read);
  const [seenRead, setSeenRead] = useState(readKey);
  useEffect(() => {
    if (readKey === seenRead || dirty || saving) return;
    setSeenRead(readKey);
    if (sameDraft(read, baseline)) return;
    setBaseline(read); setDraft(read); setRevision(undefined); setConflicts(null);
  }, [readKey, seenRead, dirty, saving]); // eslint-disable-line react-hooks/exhaustive-deps

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

  useEffect(() => {
    if (!defaultOpen) return;
    if (detailsRef.current !== null) detailsRef.current.open = true;
  }, [defaultOpen]);

  useEffect(() => {
    if (openFocusKeySignal === 0) return;
    const details = detailsRef.current;
    if (details === null) return;
    details.open = true;
    const focusKey = () => {
      const editBtn = details.querySelector<HTMLButtonElement>('[data-secret-field] [data-secret-edit]');
      if (editBtn !== null && !editBtn.disabled) {
        editBtn.click();
        return;
      }
      details.querySelector<HTMLInputElement>('[data-secret-field] input')?.focus();
    };
    requestAnimationFrame(focusKey);
  }, [openFocusKeySignal]);

  const [keySaves, setKeySaves] = useState(0);
  const keySource = provider.api_key_env !== undefined ? 'environment' : provider.has_api_key ? 'kiki' : 'none';
  const reveal = useCallback(
    async () => (await client.revealSecret({ kind: 'provider_api_key', provider_id: provider.id })).value,
    [client, provider.id, provider.has_api_key, provider.api_key_env, keySaves], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const destination = decisionConnectionDestination(provider);
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
        try {
          const latest = await client.getProviderEntity(provider.id);
          const savedSnap = draftOf(latest);
          const rebased = rebaseDraft(draft, baseline, savedSnap);
          setBaseline(savedSnap); setDraft(rebased.draft); setRevision(latest.revision);
          setConflicts(rebased.conflicts.length === 0 ? null : { fields: rebased.conflicts, saved: savedSnap });
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

  const displayName = preset.id === 'jev' ? t('st.decision.preset.jev') : provider.id;
  const host = hostLabel(provider.effective_base_url ?? provider.base_url);
  const statusBadge = (
    <span data-connection-status={state} data-decision-status={state}
      className={`inline-flex shrink-0 items-center gap-1.5 text-[12px] ${
        state === 'error' ? 'text-danger' : state === 'setup' ? 'text-amber-ink' : 'text-ink-faint'}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${
        state === 'error' ? 'bg-danger' : state === 'setup' ? 'bg-amber-rule' : 'bg-success'}`} />
      <span>{stateText}</span>
    </span>
  );

  return (
    <details
      ref={detailsRef}
      data-connection-row={provider.id}
      data-decision-row={provider.id}
      data-connection-kind="decision"
      data-connection-health={state}
      data-decision-health={state}
      className="group/provider [&[open]]:bg-paper"
      open={defaultOpen || undefined}
    >
      <summary style={{ minHeight: LIST_ROW_HEIGHT[density] }}
        className={`flex cursor-pointer list-none items-center gap-3 px-3 outline-none transition-colors hover:bg-ink/[0.03] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-selected-ink/40 [&::-webkit-details-marker]:hidden ${density === 'compact' ? 'py-1' : 'py-2'}`}>
        <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-ink/[0.05] text-ink-soft">
          <Icon name="gate" size={14} />
        </span>
        <span className="min-w-0 flex-1">
          <span className={`flex min-w-0 items-baseline ${phone ? 'justify-between gap-2' : 'gap-2'}`}>
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[13px] font-medium text-ink">{displayName}</span>
              {displayName !== provider.id ? (
                <span className="hidden truncate font-mono text-[11px] text-ink-faint sm:inline">{provider.id}</span>
              ) : null}
              <span data-decision-badge className="shrink-0 rounded border border-hairline px-1.5 py-0.5 text-[11px] font-medium leading-none text-ink-soft">
                {t('st.decision.badge')}
              </span>
            </span>
            {phone ? statusBadge : null}
          </span>
          {density === 'compact' ? null : (
            <span className="block truncate text-[12px] text-ink-faint">
              {t(`st.decision.protocol.${protocol}` as I18nKey)}
              {host === undefined ? '' : ` · ${host}`}
              {provider.default_model === undefined || provider.default_model === '' ? '' : ` · ${provider.default_model}`}
            </span>
          )}
        </span>
        {dirty ? <span className="shrink-0 text-[11px] font-medium text-amber-ink">{t('st.dirty.badge')}</span> : null}
        {phone ? null : statusBadge}
        <DisclosureChevron open={false} className="text-ink-faint transition-transform group-open/provider:rotate-90" />
      </summary>
      <div className="space-y-4 px-3 pb-4 pt-1 sm:pl-[3.25rem]">
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
    </details>
  );
}

interface CapabilityRowDraft {
  readonly enabled: boolean;
  readonly model: string;
  readonly endpoint: string;
}

type CapabilitiesDraft = Record<DecisionProtocol, CapabilityRowDraft>;

function capabilitiesDraftFrom(wire: DecisionCapabilitiesWire | undefined): CapabilitiesDraft {
  return {
    openai_decisions: {
      enabled: wire?.openai_decisions !== undefined,
      model: wire?.openai_decisions?.model ?? '',
      endpoint: wire?.openai_decisions?.endpoint ?? '',
    },
    system_one: {
      enabled: wire?.system_one !== undefined,
      model: wire?.system_one?.model ?? '',
      endpoint: wire?.system_one?.endpoint ?? '',
    },
    pair_score: {
      enabled: wire?.pair_score !== undefined,
      model: wire?.pair_score?.model ?? '',
      endpoint: wire?.pair_score?.endpoint ?? '',
    },
  };
}

function sameCapabilityRow(a: CapabilityRowDraft, b: CapabilityRowDraft): boolean {
  return a.enabled === b.enabled && a.model.trim() === b.model.trim() && a.endpoint.trim() === b.endpoint.trim();
}

function sameCapabilitiesDraft(a: CapabilitiesDraft, b: CapabilitiesDraft): boolean {
  return DECISION_PROTOCOLS.every((protocol) => sameCapabilityRow(a[protocol], b[protocol]));
}

function capabilitiesPatchFrom(draft: CapabilitiesDraft, baseline: CapabilitiesDraft): DecisionCapabilitiesPatch | null {
  const patch: Record<string, { model?: string | null; endpoint?: string | null } | null> = {};
  for (const protocol of DECISION_PROTOCOLS) {
    const cur = draft[protocol];
    const prev = baseline[protocol];
    if (sameCapabilityRow(cur, prev)) continue;
    if (!cur.enabled) {
      patch[protocol] = null;
      continue;
    }
    patch[protocol] = {
      model: cur.model.trim() || null,
      endpoint: cur.endpoint.trim() || null,
    };
  }
  return Object.keys(patch).length === 0 ? null : patch as DecisionCapabilitiesPatch;
}

/**
 * Attached decision capabilities inside an expanded chat connection (`ProviderEditor`):
 * toggle on `OpenAI Decisions`, `System One`, or `Pair score` to reuse this
 * connection's base URL and credentials without duplicating API keys, set a
 * default model or custom path, and run the sample probe in place.
 */
export function ProviderDecisionCapabilitiesEditor({
  provider,
  onSaved,
}: {
  readonly provider: ProviderCatalogItem;
  readonly onSaved?: () => Promise<void>;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const idPrefix = useId();
  const query = useQuery({
    queryKey: ['provider-entity', provider.id],
    queryFn: () => client.getProviderEntity(provider.id),
  });
  const entity = query.data;
  const sourceWire = entity?.decision_capabilities ?? provider.decision_capabilities;
  const [draft, setDraft] = useState<CapabilitiesDraft>(() => capabilitiesDraftFrom(sourceWire));
  const [baseline, setBaseline] = useState<CapabilitiesDraft>(() => capabilitiesDraftFrom(sourceWire));
  const [revision, setRevision] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [justSaved, pingSaved] = useSavedTick();
  const [testingProtocol, setTestingProtocol] = useState<DecisionProtocol | null>(null);
  const [probeState, setProbeState] = useState<Partial<Record<DecisionProtocol, { result?: DecisionConnectionProbeResult; error?: unknown }>>>({});

  const dirty = !sameCapabilitiesDraft(draft, baseline);
  useDirtyReporter(`provider-decision-capabilities:${provider.id}`, dirty);

  useEffect(() => {
    if (entity === undefined || dirty || saving || entity.revision === revision) return;
    const next = capabilitiesDraftFrom(entity.decision_capabilities);
    setDraft(next);
    setBaseline(next);
    setRevision(entity.revision);
  }, [entity, dirty, saving, revision]);

  const effectiveBaseUrl = entity?.effective_base_url ?? entity?.base_url ?? provider.effective_base_url ?? provider.base_url;
  const endpointIssues: Partial<Record<DecisionProtocol, DecisionEndpointIssue>> = {};
  for (const protocol of DECISION_PROTOCOLS) {
    const row = draft[protocol];
    if (!row.enabled || effectiveBaseUrl === undefined || effectiveBaseUrl.trim() === '') continue;
    const issue = decisionEndpointIssue(effectiveBaseUrl, row.endpoint);
    if (issue !== null) endpointIssues[protocol] = issue;
  }
  const hasInvalidEndpoint = Object.keys(endpointIssues).length > 0;

  const updateRow = (protocol: DecisionProtocol, patch: Partial<CapabilityRowDraft>) => {
    setDraft((current) => ({ ...current, [protocol]: { ...current[protocol], ...patch } }));
    setFeedback(null);
  };

  const save = async () => {
    const patch = capabilitiesPatchFrom(draft, baseline);
    if (patch === null || hasInvalidEndpoint || revision === '') return;
    setSaving(true);
    setFeedback(null);
    try {
      const updated = await client.updateProvider(provider.id, {
        base_revision: revision,
        decision_capabilities: patch,
      });
      const next = capabilitiesDraftFrom(updated.decision_capabilities);
      setDraft(next);
      setBaseline(next);
      setRevision(updated.revision);
      setProbeState({});
      await Promise.all([
        query.refetch(),
        queryClient.invalidateQueries({ queryKey: ['providers'] }),
        queryClient.invalidateQueries({ queryKey: ['config'] }),
      ]);
      await onSaved?.();
      pingSaved();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  const runProbe = async (protocol: DecisionProtocol) => {
    const row = baseline[protocol];
    if (!row.enabled || testingProtocol !== null) return;
    const endpoint = decisionConnectionEndpoint(effectiveBaseUrl, protocol, row.endpoint);
    const destination = decisionDestination(provider.id, endpoint);
    if (destination === undefined) return;
    setTestingProtocol(protocol);
    try {
      const result = await client.probeDecisionSource({ kind: 'connection', connection: provider.id, protocol }, destination);
      setProbeState((current) => ({ ...current, [protocol]: { result } }));
    } catch (error) {
      setProbeState((current) => ({ ...current, [protocol]: { error } }));
    } finally {
      setTestingProtocol(null);
    }
  };

  if (query.isError) return <InlineError error={query.error} />;

  return (
    <div className="space-y-3" data-provider-decision-capabilities={provider.id}>
      <div className="divide-y divide-hairline rounded-lg border border-hairline bg-panel/50 px-3">
        {DECISION_PROTOCOLS.map((protocol) => {
          const row = draft[protocol];
          const savedRow = baseline[protocol];
          const rowDirty = !sameCapabilityRow(row, savedRow);
          const protocolLabel = t(`st.decision.protocol.${protocol}` as I18nKey);
          const target = decisionConnectionEndpoint(effectiveBaseUrl, protocol);
          const issue = endpointIssues[protocol] ?? null;
          const probe = probeState[protocol];
          const testing = testingProtocol === protocol;
          const canTest = savedRow.enabled && !rowDirty && target !== null && !saving && testingProtocol === null;
          const testNode = testing ? <span>{t('st.decision.testing')}</span>
            : probe?.error !== undefined ? <span className="text-danger">{t('st.decision.testFailed', { reason: errorText(locale, probe.error) })}</span>
              : probe?.result === undefined ? (rowDirty ? <span>{t('st.decision.capabilities.unsavedHint')}</span> : null)
                : probe.result.ok ? <span className="text-success">{t('st.decision.testOk', { ms: Math.round(probe.result.duration_ms) })}</span>
                  : <span className="text-danger">{t('st.decision.testFailed', {
                    reason: t(`st.decision.reason.${probe.result.reason ?? 'unavailable'}` as I18nKey),
                  })}</span>;

          return (
            <div key={protocol} data-decision-capability={protocol} className="space-y-2.5 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-ink">{protocolLabel}</p>
                  <p className="text-[12px] leading-4 text-ink-faint">
                    {t(`st.decision.presetHint.${protocol === 'system_one' ? 'system_one' : protocol === 'pair_score' ? 'pair_score' : 'openai_decisions'}` as I18nKey)}
                  </p>
                </div>
                <Toggle
                  id={`${idPrefix}-${protocol}-toggle`}
                  layout="bare"
                  label={t('st.decision.capabilities.enableAria', { protocol: protocolLabel, provider: provider.id })}
                  checked={row.enabled}
                  disabled={saving || revision === ''}
                  onChange={(enabled) => { updateRow(protocol, { enabled }); }}
                />
              </div>
              {row.enabled ? (
                <div className="space-y-2.5 pl-0.5 pt-0.5">
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    <div className="space-y-1">
                      <label htmlFor={`${idPrefix}-${protocol}-model`} className="block text-[12px] text-ink-soft">{t('st.decision.model')}</label>
                      <input
                        id={`${idPrefix}-${protocol}-model`}
                        data-decision-capability-model={protocol}
                        className={`${INPUT} font-mono`}
                        value={row.model}
                        disabled={saving}
                        spellCheck={false}
                        autoComplete="off"
                        onChange={(event) => { updateRow(protocol, { model: event.target.value }); }}
                      />
                    </div>
                    <div className="space-y-1">
                      <label htmlFor={`${idPrefix}-${protocol}-endpoint`} className="block text-[12px] text-ink-soft">{t('st.decision.endpoint')}</label>
                      <input
                        id={`${idPrefix}-${protocol}-endpoint`}
                        data-decision-capability-endpoint={protocol}
                        className={`${INPUT} font-mono`}
                        value={row.endpoint}
                        placeholder={target?.pathname ?? '/'}
                        disabled={saving}
                        spellCheck={false}
                        autoComplete="off"
                        aria-invalid={issue !== null}
                        onChange={(event) => { updateRow(protocol, { endpoint: event.target.value }); }}
                      />
                    </div>
                  </div>
                  {issue !== null ? (
                    <p data-decision-capability-endpoint-issue={issue} role="alert" className="max-w-[62ch] text-[12px] leading-snug text-danger">
                      {t(ENDPOINT_ISSUE_KEYS[issue], { origin: target?.origin ?? effectiveBaseUrl ?? '' })}
                    </p>
                  ) : null}
                  {target !== null ? (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <button
                        type="button"
                        data-decision-capability-test={protocol}
                        className={SECONDARY_BUTTON}
                        disabled={!canTest}
                        aria-busy={testing}
                        onClick={() => { void runProbe(protocol); }}
                      >
                        {testing ? t('st.decision.testing') : t('st.decision.test')}
                      </button>
                      <p
                        data-decision-capability-test-result={probe?.result === undefined && probe?.error === undefined ? 'none' : probe.result?.ok === true ? 'ok' : 'error'}
                        aria-live="polite"
                        className="min-w-0 break-all text-[12px] leading-4 text-ink-faint"
                      >
                        {testNode}
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <SettingsDraftFooter
        id={`provider-decision-capabilities-${provider.id}`}
        dirty={dirty}
        saving={saving}
        saved={justSaved}
        saveDisabled={hasInvalidEndpoint || revision === ''}
        onSave={() => void save()}
        onDiscard={() => { setDraft(baseline); setFeedback(null); }}
      />
      <FeedbackLine feedback={feedback} />
    </div>
  );
}
