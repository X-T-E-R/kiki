/**
 * Usage → External sync → add / edit a destination.
 *
 * One scrolling form in the drawer tier (never a bare form block appended to
 * the page, and never a nested modal), read top to bottom as: what kind of
 * destination, where it points, how much history it covers, then a real
 * handshake and a real payload preview, then one consent that enables it.
 *
 * Three rules shape the interaction:
 *   - Nothing is sent until the last button. Saving a draft is a server-side
 *     configuration write with `enabled: false`; closing the form without
 *     saving performs no request at all.
 *   - Consent is bound to the payload the server fingerprinted, so enabling
 *     re-saves the form first and refuses when the form has been edited since
 *     the preview it is holding (`stale`).
 *   - A credential is write-only: it goes up once, is stored server-side, and
 *     is never read back into this form or into browser storage.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { I18nKey } from '@kiki/session-core/i18n';
import type { UsageExportDraft, UsageExportPreview, UsageExportSave, UsageExportScope, UsageExportTarget } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import { useConnection } from '../../../state/connection';
import { FeedbackLine, InlineError, Toggle, type Feedback } from '../../controls';
import { Icon } from '../../icons';
import { SidePanel } from '../../SidePanel';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { AxisGroup } from '../usageShared';
import { UsageExportConsentFacts, UsageExportPreviewBlock } from './UsageExportPreview';
import {
  EXPORT_KINDS,
  EXPORT_SCHEDULES,
  floorToHalfHour,
  kindShortKey,
  usageExportApi,
  utcLabel,
  type UsageExportApi,
  type UsageExportEntry,
} from '../../../lib/usageExport';

const FIELD_LABEL = 'block text-[12px] text-ink-soft';
const ROW_WRAP = 'flex flex-wrap items-end gap-x-3 gap-y-2';
const HINT = 'text-[11.5px] leading-relaxed text-ink-faint';
const SELECT = 'h-8 rounded-md border border-hairline bg-paper px-2 text-[12.5px] text-ink outline-none focus:border-selected-ink';
const NUM_INPUT = `${INPUT} w-24 text-right font-mono tabular-nums`;

const ADD = 'usage.export.form.addTitle';

/** One sentence per handshake outcome; the recorded category is shown beside it. */
const OUTCOME_KEYS: Record<string, I18nKey> = {
  delivered: 'usage.export.form.testDelivered',
  retry: 'usage.export.form.testRetry',
  'needs-auth': 'usage.export.form.testNeedsAuth',
  'too-large': 'usage.export.form.testTooLarge',
  invalid: 'usage.export.form.testInvalid',
  'remote-diverged': 'usage.export.form.testDiverged',
};

/** `datetime-local` reads and writes local wall time; the boundary is UTC. */
/** `datetime-local` edits wall time; the boundary the server records is UTC. */
function toLocalInput(ms: number): string {
  return new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
function fromLocalInput(value: string): number | undefined {
  if (value === '') return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

interface FormState {
  readonly id: string | undefined;
  readonly label: string;
  readonly kind: UsageExportTarget['kind'];
  readonly endpoint: string;
  readonly authentication: 'none' | 'bearer' | 'hmac';
  readonly gzip: boolean;
  /** Write-only: empty means "keep whatever the server already holds". */
  readonly secret: string;
  readonly storage: 'keyring' | 'private-file';
  readonly fileAck: boolean;
  readonly command: string;
  readonly timeoutSeconds: string;
  readonly outputLimitKb: string;
  readonly privateOpen: boolean;
  readonly privateHost: string;
  readonly privateIp: string;
  readonly privatePort: string;
  readonly privateProtocol: 'http:' | 'https:';
  readonly scheduleMinutes: (typeof EXPORT_SCHEDULES)[number];
  readonly historyFrom: number;
  readonly historyInput: string;
  readonly includeEphemeral: boolean;
  readonly excluded: readonly string[];
}

function initialForm(nowMs: number, entry: UsageExportEntry | undefined): FormState {
  const start = entry === undefined ? floorToHalfHour(nowMs) : entry.destination.scope.start_at;
  const base: FormState = {
    id: entry?.destination.id, label: '', kind: 'vibe', endpoint: '', authentication: 'bearer', gzip: true,
    secret: '', storage: 'keyring', fileAck: false, command: '', timeoutSeconds: '10', outputLimitKb: '64',
    privateOpen: false, privateHost: '', privateIp: '', privatePort: '', privateProtocol: 'https:',
    scheduleMinutes: 30, historyFrom: start, historyInput: toLocalInput(start),
    includeEphemeral: false, excluded: [],
  };
  if (entry === undefined) return base;
  const { destination } = entry;
  const target = destination.target;
  const grant = target.kind === 'script' ? undefined : target.private_grant;
  return {
    ...base,
    label: destination.label,
    kind: target.kind,
    endpoint: target.kind === 'script' ? '' : target.endpoint,
    authentication: target.kind === 'webhook' ? target.authentication : 'bearer',
    gzip: target.kind === 'webhook' ? target.gzip : true,
    storage: destination.credential_storage === 'private-file' ? 'private-file' : 'keyring',
    fileAck: destination.credential_storage === 'private-file',
    command: target.kind === 'script' ? target.command : '',
    timeoutSeconds: target.kind === 'script' ? String(target.timeout_ms / 1000) : '10',
    outputLimitKb: target.kind === 'script' ? String(Math.round(target.output_limit_bytes / 1024)) : '64',
    privateOpen: grant !== undefined,
    privateHost: grant?.host ?? '',
    privateIp: grant?.ip ?? '',
    privatePort: grant === undefined ? '' : String(grant.port),
    privateProtocol: grant?.protocol ?? 'https:',
    scheduleMinutes: (EXPORT_SCHEDULES as readonly number[]).includes(destination.schedule_minutes)
      ? (destination.schedule_minutes as FormState['scheduleMinutes'])
      : 30,
    includeEphemeral: destination.scope.include_ephemeral,
    excluded: destination.scope.excluded_workspace_ids,
  };
}

type Built = { readonly draft: UsageExportDraft; readonly secret?: NonNullable<UsageExportSave['secret']> };

/**
 * What the form would send, without the id the server assigns on first save:
 * that id is not the person's choice, so it must not decide whether a preview
 * still describes the payload they read.
 */
function formSignature(built: Built): string {
  return JSON.stringify({ ...built, draft: { ...built.draft, id: undefined } });
}

/**
 * Form → wire. Returns the key of the field that blocks the save instead of a
 * body, so the failure is attached to the control the person has to fix.
 */
function build(state: FormState, halfHour: number): Built | { readonly invalid: I18nKey } {
  const label = state.label.trim();
  if (label === '') return { invalid: 'usage.export.form.invalidName' };
  const scheduled = (EXPORT_SCHEDULES as readonly number[]).includes(state.scheduleMinutes) ? state.scheduleMinutes : 30;
  // The destination's own scope stays open-ended: a bounded range belongs to a
  // one-off backfill, not to a destination that keeps reporting.
  const scope: UsageExportScope = {
    start_at: halfHour, end_at: null, include_ephemeral: state.includeEphemeral,
    excluded_workspace_ids: [...state.excluded],
  };
  let target: UsageExportTarget;
  if (state.kind === 'script') {
    const command = state.command.trim();
    if (command === '') return { invalid: 'usage.export.form.invalidCommand' };
    const seconds = Number(state.timeoutSeconds);
    if (!Number.isFinite(seconds) || seconds < 0.1 || seconds > 60) return { invalid: 'usage.export.form.timeoutInvalid' };
    const kilobytes = Number(state.outputLimitKb);
    if (!Number.isFinite(kilobytes) || kilobytes < 1 || kilobytes > 1024) return { invalid: 'usage.export.form.outputLimitInvalid' };
    target = { kind: 'script', command, timeout_ms: Math.round(seconds * 1000), output_limit_bytes: Math.round(kilobytes * 1024) };
  } else {
    const endpoint = state.endpoint.trim();
    if (!/^https?:\/\/\S+$/i.test(endpoint)) return { invalid: 'usage.export.form.invalidEndpoint' };
    let grant: { host: string; ip: string; port: number; protocol: 'http:' | 'https:' } | undefined;
    if (state.privateOpen) {
      const host = state.privateHost.trim();
      if (host === '') return { invalid: 'usage.export.form.invalidPrivateHost' };
      const ip = state.privateIp.trim();
      if (ip === '') return { invalid: 'usage.export.form.invalidPrivateIp' };
      const port = Number(state.privatePort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { invalid: 'usage.export.form.invalidPrivatePort' };
      grant = { host, ip, port, protocol: state.privateProtocol };
    }
    target = state.kind === 'webhook'
      ? { kind: 'webhook', endpoint, gzip: state.gzip, authentication: state.authentication, private_grant: grant }
      : { kind: 'vibe', endpoint, private_grant: grant };
  }
  const value = state.secret.trim();
  if (value !== '' && state.storage === 'private-file' && !state.fileAck) {
    return { invalid: 'usage.export.form.storage.fileAckRequired' };
  }
  const secret = value === ''
    ? undefined
    : { value, storage: state.storage, acknowledge_file_storage: state.storage === 'private-file' ? true : undefined };
  return {
    draft: {
      id: state.id, label, target, scope,
      schedule_minutes: scheduled as UsageExportDraft['schedule_minutes'],
    },
    secret,
  };
}

export function UsageExportForm({ entry, onClose, onSaved }: {
  /** The destination being edited, or undefined for a new one. */
  readonly entry: UsageExportEntry | undefined;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const { t } = useI18n();
  const { client, klient } = useConnection();
  const api = usageExportApi(klient);
  const nowMs = useMemo(() => Date.now(), []);
  const [state, setState] = useState<FormState>(() => initialForm(nowMs, entry));
  const [busy, setBusy] = useState<'save' | 'test' | 'preview' | 'enable' | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [error, setError] = useState<unknown>(null);
  const [invalid, setInvalid] = useState<I18nKey | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ readonly signature: string; readonly value: UsageExportPreview } | null>(null);
  const [showSecret, setShowSecret] = useState(false);

  const workspacesQuery = useQuery({ queryKey: ['workspaces'], queryFn: () => client.listWorkspaces(), staleTime: 30_000 });
  const workspaces = workspacesQuery.data?.items ?? [];

  const historyHalfHour = floorToHalfHour(state.historyFrom);
  const built = build(state, historyHalfHour);
  // An invalid form has no payload to compare; `saveDraft` reports the field.
  const signature = 'invalid' in built ? '' : formSignature(built);
  const stale = preview !== null && preview.signature !== signature;
  const busyNow = busy !== null;
  const seamMissing = api === undefined;

  const patch = (next: Partial<FormState>) => {
    setState((current) => ({ ...current, ...next }));
    setFeedback(null);
    setError(null);
    setInvalid(null);
    setCategory(null);
  };

  /**
   * Save the form, hand back the server's destination id. The id is kept in the
   * form's own state: without it every save would create another destination,
   * so the stream identity (and with it the consent fingerprint) would change
   * under the person reading the preview.
   */
  const saveDraft = async (target: UsageExportApi): Promise<string | undefined> => {
    if ('invalid' in built) { setInvalid(built.invalid); return undefined; }
    const saved = await target.saveDraft(built);
    setState((current) => (current.id === saved.id ? current : { ...current, id: saved.id }));
    return saved.id;
  };

  const onSave = async () => {
    if (api === undefined) return;
    setBusy('save');
    try {
      const id = await saveDraft(api);
      if (id === undefined) return;
      setFeedback({ tone: 'success', text: t('usage.export.form.saved') });
      onSaved();
    } catch (failure) { setError(failure); } finally { setBusy(null); }
  };

  const onTest = async () => {
    if (api === undefined) return;
    setBusy('test');
    try {
      const id = await saveDraft(api);
      if (id === undefined) return;
      const result = await api.testProtocol(id);
      setCategory(result.error_category);
      if (result.outcome === 'delivered') setFeedback({ tone: 'success', text: t('usage.export.form.testDelivered') });
      else setFeedback({ tone: 'error', text: t(OUTCOME_KEYS[result.outcome] ?? 'usage.export.form.testRetry') });
    } catch (failure) { setError(failure); } finally { setBusy(null); }
  };

  const onPreview = async () => {
    if (api === undefined) return;
    setBusy('preview');
    try {
      const id = await saveDraft(api);
      if (id === undefined) return;
      const value = await api.preview(id);
      setPreview({ signature, value });
    } catch (failure) { setError(failure); } finally { setBusy(null); }
  };

  const onEnable = async () => {
    if (api === undefined || preview === null || stale) return;
    setBusy('enable');
    try {
      // Consent is bound to the payload the server fingerprinted. Saving an
      // identical draft leaves that fingerprint untouched, so the consent the
      // person just read is the one that gets recorded; when the save did move
      // it, the server refuses and the preview below is re-requested.
      const id = await saveDraft(api);
      if (id === undefined) return;
      const saved = await api.preview(id);
      if (saved.preview_fingerprint !== preview.value.preview_fingerprint) {
        setPreview({ signature, value: saved });
        setError(new Error(t('usage.export.consent.changed')));
        return;
      }
      await api.enable(id, { preview_fingerprint: saved.preview_fingerprint, acknowledge: true });
      onSaved();
    } catch (failure) { setError(failure); } finally { setBusy(null); }
  };

  const title = entry === undefined ? t(ADD) : t('usage.export.form.editTitle', { name: entry.destination.label });

  return (
    <SidePanel
      title={title}
      description={t('usage.export.form.description')}
      overlayId="usage-export-form"
      onClose={onClose}
      width="lg"
      data={{ 'data-usage-export-form': entry === undefined ? 'create' : 'edit' }}
      footer={(
        <>
          <button type="button" data-usage-export-form-save disabled={busyNow || seamMissing} onClick={() => void onSave()} className={SECONDARY_BUTTON}>
            {t(busy === 'save' ? 'usage.export.form.saving' : 'usage.export.form.save')}
          </button>
          <button type="button" data-usage-export-form-cancel disabled={busyNow} onClick={onClose} className="ml-auto h-8 rounded-md px-2 text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink disabled:opacity-50">
            {t('common.close')}
          </button>
        </>
      )}
    >
      <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void onPreview(); }}>
        {seamMissing ? <p role="alert" className="text-[12.5px] text-danger">{t('usage.export.noTransport')}</p> : null}

        <section className="space-y-2">
          <AxisGroup
            label={t('usage.export.form.kind')}
            dataAxis="export-kind"
            options={EXPORT_KINDS}
            value={state.kind}
            onChange={(kind) => { patch({ kind }); }}
            labelFor={(kind) => t(kindShortKey(kind))}
          />
          <p data-usage-export-form-kind-hint className={`${HINT} max-w-[76ch]`}>
            {t(state.kind === 'vibe' ? 'usage.export.form.kind.vibeHint' : state.kind === 'webhook' ? 'usage.export.form.kind.webhookHint' : 'usage.export.form.kind.scriptHint')}
          </p>
        </section>

        <label className="block space-y-1">
          <span className={FIELD_LABEL}>{t('usage.export.form.name')}</span>
          <input
            data-usage-export-form-name
            value={state.label}
            maxLength={80}
            placeholder={t('usage.export.form.namePlaceholder')}
            aria-invalid={invalid === 'usage.export.form.invalidName'}
            onChange={(event) => { patch({ label: event.target.value }); }}
            className={INPUT}
          />
        </label>

        {state.kind === 'script' ? (
          <section className="space-y-2">
            <label className="block space-y-1">
              <span className={FIELD_LABEL}>{t('usage.export.form.command')}</span>
              <textarea
                data-usage-export-form-command
                value={state.command}
                rows={3}
                spellCheck={false}
                placeholder={t('usage.export.form.commandPlaceholder')}
                aria-invalid={invalid === 'usage.export.form.invalidCommand'}
                onChange={(event) => { patch({ command: event.target.value }); }}
                className={`${INPUT} font-mono text-[12px]`}
              />
            </label>
            <p data-usage-export-form-script-note className={`${HINT} max-w-[76ch]`}>{t('usage.export.form.commandHint')}</p>
            <p className={`${HINT} max-w-[76ch]`}>{t('usage.export.form.commandApproval')}</p>
            <details className="[&[open]>summary]:mb-2">
              <summary className="cursor-pointer text-[12px] text-ink-soft underline decoration-dotted underline-offset-2">{t('usage.export.form.advanced')}</summary>
              <div className={ROW_WRAP}>
                <label className="block space-y-1">
                  <span className={FIELD_LABEL}>{t('usage.export.form.timeout')}</span>
                  <input inputMode="decimal" value={state.timeoutSeconds} aria-invalid={invalid === 'usage.export.form.timeoutInvalid'} onChange={(event) => { patch({ timeoutSeconds: event.target.value }); }} className={NUM_INPUT} />
                </label>
                <label className="block space-y-1">
                  <span className={FIELD_LABEL}>{t('usage.export.form.outputLimit')}</span>
                  <input inputMode="numeric" value={state.outputLimitKb} aria-invalid={invalid === 'usage.export.form.outputLimitInvalid'} onChange={(event) => { patch({ outputLimitKb: event.target.value }); }} className={NUM_INPUT} />
                </label>
              </div>
            </details>
          </section>
        ) : (
          <section className="space-y-2">
            <label className="block space-y-1">
              <span className={FIELD_LABEL}>{t('usage.export.form.endpoint')}</span>
              <input
                data-usage-export-form-endpoint
                value={state.endpoint}
                spellCheck={false}
                inputMode="url"
                placeholder={t('usage.export.form.endpointPlaceholder')}
                aria-invalid={invalid === 'usage.export.form.invalidEndpoint'}
                onChange={(event) => { patch({ endpoint: event.target.value }); }}
                className={`${INPUT} font-mono text-[12px]`}
              />
            </label>
            <p className={`${HINT} max-w-[76ch]`}>{t('usage.export.form.endpointHint')}</p>
            {state.kind === 'webhook' ? (
              <div className={ROW_WRAP}>
                <label className="block space-y-1">
                  <span className={FIELD_LABEL}>{t('usage.export.form.auth')}</span>
                  <select
                    data-usage-export-form-auth
                    value={state.authentication}
                    onChange={(event) => { patch({ authentication: event.target.value as FormState['authentication'] }); }}
                    className={SELECT}
                  >
                    <option value="none">{t('usage.export.form.auth.none')}</option>
                    <option value="bearer">{t('usage.export.form.auth.bearer')}</option>
                    <option value="hmac">{t('usage.export.form.auth.hmac')}</option>
                  </select>
                </label>
                <div className="pb-1">
                  <Toggle label={t('usage.export.form.gzip')} checked={state.gzip} onChange={(gzip) => { patch({ gzip }); }} />
                </div>
              </div>
            ) : null}
          </section>
        )}

        {state.kind !== 'script' ? (
          <section className="space-y-2">
            <label className="block space-y-1">
              <span className={FIELD_LABEL}>{t('usage.export.form.secret')}</span>
              <span className="flex items-center gap-2">
                <input
                  data-usage-export-form-secret
                  type={showSecret ? 'text' : 'password'}
                  value={state.secret}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t('usage.export.form.secretPlaceholder')}
                  onChange={(event) => { patch({ secret: event.target.value }); }}
                  className={`${INPUT} flex-1 font-mono text-[12px]`}
                />
                <button
                  type="button"
                  data-usage-export-form-secret-toggle
                  aria-label={t('usage.export.form.secret')}
                  aria-pressed={showSecret}
                  onClick={() => { setShowSecret((open) => !open); }}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink"
                >
                  <Icon name={showSecret ? 'eyeOff' : 'eye'} size={14} />
                </button>
              </span>
            </label>
            <p className={HINT}>{t(entry === undefined ? 'usage.export.form.secretNever' : 'usage.export.form.secretKeep')}</p>
            <div className={ROW_WRAP}>
              <label className="block space-y-1">
                <span className={FIELD_LABEL}>{t('usage.export.form.storage')}</span>
                <select
                  data-usage-export-form-storage
                  value={state.storage}
                  onChange={(event) => { patch({ storage: event.target.value as FormState['storage'] }); }}
                  className={SELECT}
                >
                  <option value="keyring">{t('usage.export.form.storage.keyring')}</option>
                  <option value="private-file">{t('usage.export.form.storage.file')}</option>
                </select>
              </label>
            </div>
            {state.storage === 'private-file' ? (
              <Toggle
                label={t('usage.export.form.storage.fileAck')}
                checked={state.fileAck}
                onChange={(fileAck) => { patch({ fileAck }); }}
              />
            ) : null}
          </section>
        ) : null}

        {state.kind !== 'script' ? (
          <details className="[&[open]>summary]:mb-2">
            <summary className="cursor-pointer text-[12px] text-ink-soft underline decoration-dotted underline-offset-2">{t('usage.export.form.privateEndpoint')}</summary>
            <div className="space-y-2">
              <Toggle label={t('usage.export.form.privateEndpoint')} checked={state.privateOpen} onChange={(privateOpen) => { patch({ privateOpen }); }} />
              {state.privateOpen ? (
                <div className={ROW_WRAP}>
                  <label className="block space-y-1">
                    <span className={FIELD_LABEL}>{t('usage.export.form.privateHost')}</span>
                    <input value={state.privateHost} spellCheck={false} aria-invalid={invalid === 'usage.export.form.invalidPrivateHost'} onChange={(event) => { patch({ privateHost: event.target.value }); }} className={`${INPUT} w-44`} />
                  </label>
                  <label className="block space-y-1">
                    <span className={FIELD_LABEL}>{t('usage.export.form.privateIp')}</span>
                    <input value={state.privateIp} spellCheck={false} aria-invalid={invalid === 'usage.export.form.invalidPrivateIp'} onChange={(event) => { patch({ privateIp: event.target.value }); }} className={`${INPUT} w-36 font-mono`} />
                  </label>
                  <label className="block space-y-1">
                    <span className={FIELD_LABEL}>{t('usage.export.form.privatePort')}</span>
                    <input inputMode="numeric" value={state.privatePort} aria-invalid={invalid === 'usage.export.form.invalidPrivatePort'} onChange={(event) => { patch({ privatePort: event.target.value }); }} className={NUM_INPUT} />
                  </label>
                  <label className="block space-y-1">
                    <span className={FIELD_LABEL}>{t('usage.export.form.privateProtocol')}</span>
                    <select value={state.privateProtocol} onChange={(event) => { patch({ privateProtocol: event.target.value as 'http:' | 'https:' }); }} className={SELECT}>
                      <option value="https:">https:</option>
                      <option value="http:">http:</option>
                    </select>
                  </label>
                </div>
              ) : null}
              <p className={`${HINT} max-w-[76ch]`}>{t('usage.export.form.privateHint')}</p>
            </div>
          </details>
        ) : null}

        <section className="space-y-2">
          <div className={ROW_WRAP}>
            <label className="block space-y-1">
              <span className={FIELD_LABEL}>{t('usage.export.form.historyFrom')}</span>
              <input
                data-usage-export-form-history
                type="datetime-local"
                data-utc-boundary
                value={state.historyInput}
                aria-invalid={invalid === 'usage.export.form.historyInvalid'}
                onChange={(event) => {
                  const ms = fromLocalInput(event.target.value);
                  patch({ historyInput: event.target.value, historyFrom: ms ?? state.historyFrom });
                }}
                className={`${INPUT} w-56 font-mono text-[12px]`}
              />
            </label>
            <label className="block space-y-1">
              <span className={FIELD_LABEL}>{t('usage.export.form.schedule')}</span>
              <select
                data-usage-export-form-schedule
                value={String(state.scheduleMinutes)}
                onChange={(event) => { patch({ scheduleMinutes: Number(event.target.value) as FormState['scheduleMinutes'] }); }}
                className={SELECT}
              >
                {EXPORT_SCHEDULES.map((minutes) => (
                  <option key={minutes} value={String(minutes)}>{t(`usage.export.schedule.${minutes}`)}</option>
                ))}
              </select>
            </label>
          </div>
          <p data-usage-export-form-boundary className="font-mono text-[11.5px] text-ink-soft tabular-nums">{utcLabel(historyHalfHour)}</p>
          <p className={`${HINT} max-w-[76ch]`}>{t('usage.export.form.historyHint')}</p>
          <Toggle label={t('usage.export.form.ephemeral')} checked={state.includeEphemeral} onChange={(includeEphemeral) => { patch({ includeEphemeral }); }} />
          <p className={`${HINT} max-w-[76ch]`}>{t('usage.export.form.ephemeralHint')}</p>
          <div className="space-y-1.5">
            <span className={FIELD_LABEL}>{t('usage.export.form.excluded')}</span>
            <p className={HINT}>{t('usage.export.form.excludedHint')}</p>
            {workspaces.length > 0 ? (
              <ul data-usage-export-form-excluded className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-hairline bg-paper px-3 py-2">
                {workspaces.map((workspace) => (
                  <li key={workspace.id}>
                    <Toggle
                      layout="row"
                      label={workspace.name}
                      checked={state.excluded.includes(workspace.id)}
                      onChange={(on) => {
                        patch({ excluded: on ? [...state.excluded, workspace.id] : state.excluded.filter((id) => id !== workspace.id) });
                      }}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </section>

        <section className="space-y-2 border-t border-hairline pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" data-usage-export-form-test disabled={busyNow || seamMissing} onClick={() => void onTest()} className={SECONDARY_BUTTON}>
              {t(busy === 'test' ? 'usage.export.form.testing' : 'usage.export.form.test')}
            </button>
            <button type="submit" data-usage-export-form-preview disabled={busyNow || seamMissing} className={PRIMARY_BUTTON}>
              {t(busy === 'preview' ? 'usage.export.form.previewing' : 'usage.export.form.preview')}
            </button>
          </div>
          {invalid !== null ? <p role="alert" data-usage-export-form-invalid className="text-[12px] text-danger">{t(invalid)}</p> : null}
          <FeedbackLine feedback={feedback} />
          {error !== null ? <InlineError error={error} /> : null}
          {category !== null && category !== 'generic' ? (
            <p data-usage-export-form-category className="font-mono text-[11.5px] text-ink-faint">{category}</p>
          ) : null}
        </section>

        {preview !== null ? (
          <section className="border-t border-hairline pt-4">
            <UsageExportPreviewBlock
              preview={preview.value}
              stale={stale}
              footer={(
                <div className="space-y-3 border-t border-hairline pt-3">
                  <UsageExportConsentFacts kind={state.kind} privateGrant={state.privateOpen} />
                  <button
                    type="button"
                    data-usage-export-form-enable
                    disabled={busyNow || stale || seamMissing}
                    onClick={() => void onEnable()}
                    className={PRIMARY_BUTTON}
                  >
                    {t(busy === 'enable' ? 'usage.export.consent.enabling' : 'usage.export.consent.enable')}
                  </button>
                </div>
              )}
            />
          </section>
        ) : null}
      </form>
    </SidePanel>
  );
}
