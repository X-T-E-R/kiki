import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import type { MemoryAdvisorProbeResult, MemorySettingsPatch } from '@kiki/protocol';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import {
  MEMORY_ADVISOR_DEFAULTS,
  MEMORY_ADVISOR_NUMBER_FIELDS,
  MEMORY_ADVISOR_RANGES,
  memoryAdvisorModePatch,
  memoryAdvisorNumberValue,
  memoryAdvisorReasonKey,
  parseMemoryAdvisorNumber,
  type MemoryAdvisorNumberField,
} from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { StatusDot } from '../capabilities/primitives';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, SaveStatus, Toggle, type Feedback } from '../controls';
import { useMemoryAdvisor } from '../memory/useMemoryAdvisor';
import { DANGER_GHOST_BUTTON, SECONDARY_BUTTON } from '../ui';
import { DecisionSourceSummary } from './DecisionSources';
import { MemoryAdvisorRuntime } from './MemoryAdvisorRuntime';
import { SectionCard } from './SectionCard';
import { AdvancedDetails, SettingField, SettingsGroup } from './fields';
import { CommitInput, SettingsSegmented } from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';

/** Which write a save status belongs to, so only that row says "Saved". */
type WriteSlot = 'switch' | 'mode' | 'children' | MemoryAdvisorNumberField | 'remove';

/**
 * Memory Advisor: the quick switch on the heading and which service picks
 * (shown here, chosen in Who decides). Choosing a source and switching the
 * advisor on is the decision to use that service; there is no second OK.
 * Tuning and diagnostics are behind Advanced.
 */
export function MemoryAdvisorSettingsCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  // A link may name a workspace; status and live reads follow it.
  const [params] = useSearchParams();
  const workspaceId = params.get('workspace') ?? undefined;
  const advisor = useMemoryAdvisor(workspaceId);
  const [saved, ping] = useSavedTick();
  const [slot, setSlot] = useState<WriteSlot | undefined>();
  const [confirmRemove, setConfirmRemove] = useState(false);

  const data = advisor.data;
  const config = data?.advisor;
  const status = data?.advisor_status;
  const view = advisor.view;
  /** One write at a time; resolves `true` only when the server accepted it. */
  const write = (next: WriteSlot, patch: MemorySettingsPatch): Promise<boolean> => {
    if (advisor.save.isPending) return Promise.resolve(false);
    setSlot(next);
    return advisor.save.mutateAsync(patch).then(() => { ping(); return true; }, () => false);
  };
  const statusFor = (key: WriteSlot) => (slot === key ? <SaveStatus saving={advisor.save.isPending} saved={saved && !advisor.save.isError} /> : null);
  const busy = advisor.query.isPending || advisor.save.isPending;

  const probe = useMutation({
    mutationFn: (destination: string) => client.probeMemoryAdvisor(destination),
  });
  useEffect(() => { probe.reset(); }, [status?.destination]); // eslint-disable-line react-hooks/exhaustive-deps

  const destination = status?.destination;
  const memoryOff = status?.state === 'disabled' || data?.effective_enabled === false;
  const reasonKey = memoryAdvisorReasonKey(status?.reason);
  const feedback: Feedback = advisor.query.isError
    ? { tone: 'error', text: t('memory.advisor.loadFailed', { detail: errorText(locale, advisor.query.error) }) }
    : advisor.save.isError
      ? { tone: 'error', text: t('memory.advisor.saveFailed', { detail: errorText(locale, advisor.save.error) }) }
      : null;
  const headerModel = status?.source_status?.model ?? status?.model;
  const pairScore = (status?.source_status?.protocol ?? config?.selector?.protocol) === 'pair_score';
  const dot = view.tone === 'ok' ? 'ok' : view.tone === 'danger' ? 'error' : view.tone === 'caution' ? 'waiting' : 'off';

  return (
    <SectionCard id="st-card-memory-advisor" title={t('memory.advisor.title')} actions={(
      <span className="inline-flex items-center gap-2">
        {statusFor('switch')}
        <Toggle id="memory-advisor-enabled" layout="bare" label={t('memory.advisor.switch')} checked={view.on}
          disabled={busy}
          onChange={(on) => { void write('switch', memoryAdvisorModePatch(on, config)); }} />
      </span>
    )}>
      <div className="min-w-0 space-y-5" data-memory-advisor-settings>
        <div className="space-y-1">
          <p data-memory-advisor-status={view.kind} role="status" className="flex items-center gap-2 text-[13px] text-ink">
            {dot === 'off' ? null : <span aria-hidden className="inline-flex"><StatusDot state={dot} label="" /></span>}
            <span>{t(view.stateKey)}</span>
            {headerModel !== undefined && view.on ? <span className="truncate font-mono text-[12px] text-ink-faint">{headerModel}</span> : null}
          </p>
          {memoryOff ? <p data-memory-advisor-memory-off className="max-w-[62ch] text-[12px] leading-snug text-amber-ink">{t('memory.advisor.memoryOff')}</p>
            : view.kind === 'problem' && reasonKey !== undefined ? <p data-memory-advisor-reason className="max-w-[62ch] text-[12px] leading-snug text-danger">{t(reasonKey)}</p>
              : <Hint>{t('memory.advisor.switchHint')}</Hint>}
        </div>

        <SettingsGroup title={t('memory.advisor.selectorGroup')}>
          <DecisionSourceSummary consumer="memory" source={config?.source} status={status?.source_status}
            legacy={config?.source === undefined && config?.selector !== undefined
              ? t('st.decision.row.memoryLegacy', { model: config.selector.model }) : undefined} />
          {destination !== undefined ? <ProbeRow result={probe.data} error={probe.error} pending={probe.isPending} onRun={() => { probe.mutate(destination); }} /> : null}
        </SettingsGroup>
        <AdvancedDetails summary={t('memory.advisor.advanced')} data-memory-advisor-advanced>
          <div className="space-y-1 text-[13px] text-ink">
            <SettingField label={t('memory.advisor.mode')} labelId="memory-advisor-mode-label"
              help={t(config?.mode === 'select' ? 'memory.advisor.modeHint.select' : 'memory.advisor.modeHint.rank')}>
              {statusFor('mode')}
              <SettingsSegmented<'rank' | 'select'> ariaLabelledBy="memory-advisor-mode-label" dataAttr="data-memory-advisor-mode"
                value={config?.mode === 'select' ? 'select' : 'rank'} disabled={busy || !view.on}
                onChange={(mode) => { void write('mode', { advisor: { mode } }); }}
                choices={[
                  { value: 'rank', label: t('memory.advisor.mode.rank') },
                  { value: 'select', label: t('memory.advisor.mode.select'), disabled: pairScore },
                ]} />
            </SettingField>
            <SettingField label={t('memory.advisor.children')} htmlFor="memory-advisor-children" help={t('memory.advisor.childrenHint')}>
              {statusFor('children')}
              <Toggle id="memory-advisor-children" layout="bare" label={t('memory.advisor.children')}
                checked={config?.apply_to_children ?? MEMORY_ADVISOR_DEFAULTS.apply_to_children} disabled={busy}
                onChange={(apply_to_children) => { void write('children', { advisor: { apply_to_children } }); }} />
            </SettingField>
            <div className="grid gap-x-6 gap-y-1 pt-1 sm:grid-cols-2" data-memory-advisor-numbers>
              {MEMORY_ADVISOR_NUMBER_FIELDS.map((field) => {
                const range = MEMORY_ADVISOR_RANGES[field];
                const shown = memoryAdvisorNumberValue(field, config, status);
                const followsSource = field === 'first_step_wait_ms';
                return (
                  <SettingField key={field} label={t(`memory.advisor.field.${field}` as I18nKey)} htmlFor={`memory-advisor-${field}`}
                    detail={t('memory.advisor.fieldDefault', { value: shown.fallback })}>
                    {statusFor(field)}
                    {followsSource && !shown.explicit ? (
                      <span data-memory-advisor-wait-default className="text-[12px] text-ink-faint">{t('agentPanel.default')}</span>
                    ) : null}
                    {followsSource && shown.explicit && config !== undefined ? (
                      <button type="button" data-memory-advisor-wait-reset disabled={busy}
                        className="text-[12px] font-medium text-ink-soft underline-offset-2 hover:text-ink hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={() => { void write(field, { advisor: { first_step_wait_ms: null } }); }}>
                        {t('composer.modelResetDefault')}
                      </button>
                    ) : null}
                    <CommitInput id={`memory-advisor-${field}`} dataAttr={`data-memory-advisor-${field.replaceAll('_', '-')}`}
                      className="w-24 text-right" inputMode="numeric" disabled={busy}
                      value={String(shown.value)}
                      validate={(text) => (parseMemoryAdvisorNumber(field, text) === null ? t('memory.advisor.fieldInvalid', { min: range.min, max: range.max }) : null)}
                      onCommit={(text) => { void write(field, { advisor: { [field]: Number(text) } }); }} />
                  </SettingField>
                );
              })}
            </div>
            {destination !== undefined ? (
              <dl data-memory-advisor-destination-row className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 py-1 text-[13px]">
                <dt className="text-ink-soft">{t('memory.advisor.destination')}</dt>
                <dd data-memory-advisor-destination className="min-w-0 break-all font-mono text-[12px] text-ink">{destination}</dd>
              </dl>
            ) : null}
            <MemoryAdvisorRuntime workspaceId={workspaceId} config={config} />
            {config !== undefined ? (
              <div className="pt-3">
                <button type="button" data-memory-advisor-remove className={DANGER_GHOST_BUTTON} disabled={busy}
                  onClick={() => { setConfirmRemove(true); }}>{t('memory.advisor.remove')}</button>
              </div>
            ) : null}
          </div>
        </AdvancedDetails>
        <ConfirmDialog open={confirmRemove} title={t('memory.advisor.removeTitle')} body={t('memory.advisor.removeBody')}
          confirmLabel={t('memory.advisor.removeConfirm')} busy={advisor.save.isPending}
          onCancel={() => { setConfirmRemove(false); advisor.save.reset(); }}
          onConfirm={() => { void write('remove', { advisor: null }).then((ok) => { if (ok) setConfirmRemove(false); }); }}>
          {/* A refused removal keeps the dialog open: the reason sits here and
              the same button tries again. */}
          {slot === 'remove' && advisor.save.isError ? (
            <p data-memory-advisor-remove-error role="alert" className="text-[12px] leading-snug text-danger">
              {t('memory.advisor.saveFailed', { detail: errorText(locale, advisor.save.error) })}
            </p>
          ) : null}
        </ConfirmDialog>

        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

/**
 * The optional synthetic check. It goes to the confirmed destination only, so
 * it is offered once a destination exists; the result line says how the
 * selector answered, or why it did not, in the same reasons the status uses.
 */
function ProbeRow({ result, error, pending, onRun }: {
  readonly result: MemoryAdvisorProbeResult | undefined;
  readonly error: unknown;
  readonly pending: boolean;
  readonly onRun: () => void;
}) {
  const { t, locale } = useI18n();
  const reasonKey = memoryAdvisorReasonKey(result?.status.reason);
  const feedback: Feedback = pending ? null
    : error !== null && error !== undefined ? { tone: 'error', text: t('memory.advisor.testFailed', { reason: errorText(locale, error) }) }
      : result === undefined ? null
        : result.ok ? {
          tone: 'success',
          text: [
            t('memory.advisor.testOk', { ms: Math.round(result.duration_ms) }),
            result.usage_known && result.input_tokens !== undefined ? t('memory.advisor.testTokens', { input: result.input_tokens, output: result.output_tokens ?? 0 }) : '',
          ].filter((part) => part !== '').join(' '),
        }
          : { tone: 'error', text: t('memory.advisor.testFailed', { reason: reasonKey === undefined ? t(`memory.advisor.state.${result.status.state}` as I18nKey) : t(reasonKey) }) };
  return (
    <div data-memory-advisor-probe className="space-y-1.5 pt-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button type="button" data-memory-advisor-test className={SECONDARY_BUTTON} disabled={pending} onClick={onRun}>
          {pending ? t('memory.advisor.testing') : t('memory.advisor.test')}
        </button>
      </div>
      <FeedbackLine feedback={feedback} />
    </div>
  );
}
