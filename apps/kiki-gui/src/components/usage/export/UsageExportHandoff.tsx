/**
 * Usage → External sync → old collector handoff (on demand, inside one
 * destination's detail).
 *
 * A local vibe-usage collector and native Kiki export must never both report the
 * same home to the same account, and replaying history is not a fix — so the
 * handoff splits the timeline at one future UTC half-hour boundary: the collector
 * owns every bucket before it, Kiki owns every bucket from it onward, and
 * `kiki.usage.handoff.v1` records the receipts that prove the crossing.
 *
 * One consent arms it, and that consent has two effects, both stated before it is
 * given: Kiki persists its own authorization at the boundary and starts covering
 * from there, and the collector file the user picked stops covering this home
 * from that boundary on. Kiki does not rewrite the collector's own state file,
 * does not read its key, and does not stop its service.
 *
 * Behind that one action the server does four ordered things, and the screen
 * reports which of them failed instead of collapsing them: record the boundary,
 * handshake the destination, fingerprint the payload that will be sent, then arm.
 * The recorded phases are then shown as what they are, never as progress toward a
 * success that has not happened: `prepared` is a boundary nobody has acted on,
 * `armed` is readiness at that boundary with Kiki queuing offline, `awaiting-native`
 * waits for Kiki's first real receipt, and only `completed` means both receipts
 * are in. The old shared hostname keeps its history throughout.
 */

import { useState } from 'react';

import type { I18nKey } from '@kiki/session-core/i18n';
import type { UsageExportDestination, UsageExportHandoff } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import { InlineError } from '../../controls';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { ceilToHalfHour, utcLabel, type UsageExportApi, type UsageExportHandoffPhase, type UsageExportHandoffView } from '../../../lib/usageExport';

const HINT = 'text-[11.5px] leading-relaxed text-ink-faint';
const NOTE_SOFT = 'rounded-lg border border-hairline bg-panel px-3 py-2 text-[12.5px] leading-relaxed text-ink-soft';
const NOTE_AMBER = 'rounded-lg border border-amber-rule/40 bg-amber-card px-3 py-2 text-[12.5px] leading-relaxed text-amber-ink';
const INPUT_BASE = 'h-8 rounded-md border border-hairline bg-paper px-2 font-mono text-[12px] text-ink outline-none focus:border-selected-ink aria-[invalid=true]:border-danger';

const PHASE_TITLE: Record<UsageExportHandoffPhase, I18nKey> = {
  prepared: 'usage.export.handoff.phase.prepared',
  armed: 'usage.export.handoff.phase.armed',
  'awaiting-native': 'usage.export.handoff.phase.awaiting-native',
  completed: 'usage.export.handoff.phase.completed',
  'rollback-prepared': 'usage.export.handoff.phase.rollback-prepared',
};
const PHASE_BODY: Record<UsageExportHandoffPhase, I18nKey> = {
  prepared: 'usage.export.handoff.phase.prepared.body',
  armed: 'usage.export.handoff.phase.armed.body',
  'awaiting-native': 'usage.export.handoff.phase.awaiting-native.body',
  completed: 'usage.export.handoff.phase.completed.body',
  'rollback-prepared': 'usage.export.handoff.phase.rollback-prepared.body',
};
/** Which of the ordered steps the server was on when it refused. */
const STEP_LABEL: Record<string, I18nKey> = {
  plan: 'usage.export.handoff.step.plan',
  test: 'usage.export.handoff.step.test',
  preview: 'usage.export.handoff.step.preview',
  arm: 'usage.export.handoff.step.arm',
  refresh: 'usage.export.handoff.step.refresh',
  rollback: 'usage.export.handoff.step.rollback',
};

function toLocalInput(ms: number): string {
  const date = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

export function HandoffSection({ api, destination, view, handoff, onHandoff, onSettled }: {
  readonly api: UsageExportApi;
  readonly destination: UsageExportDestination;
  readonly view: UsageExportHandoffView | null;
  readonly handoff: UsageExportHandoff | null;
  readonly onHandoff: (next: UsageExportHandoff | null) => void;
  /** The destination itself changed (armed or rolled back): refresh the list. */
  readonly onSettled: () => void;
}) {
  const { t, time } = useI18n();
  const [cutoff, setCutoff] = useState(() => toLocalInput(ceilToHalfHour(Date.now() + 60_000)));
  const [collectorFile, setCollectorFile] = useState('');
  const [rollbackCutoff, setRollbackCutoff] = useState(() => toLocalInput(ceilToHalfHour(Date.now() + 60_000)));
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [invalid, setInvalid] = useState<'cutoff' | 'file' | 'rollback' | null>(null);

  const boundary = new Date(cutoff).getTime();
  const resolved = Number.isFinite(boundary) ? ceilToHalfHour(boundary) : Number.NaN;
  const expired = view !== null && view.phase === 'prepared' && view.cutoffAt <= Date.now();

  const run = async (nextStep: string, work: () => Promise<UsageExportHandoff | null>) => {
    setBusy(true);
    setStep(nextStep);
    setError(null);
    try {
      const next = await work();
      onHandoff(next);
      if (next !== null && (next.phase === 'armed' || next.phase === 'awaiting-native' || next.phase === 'rollback-prepared')) onSettled();
      return next;
    } catch (failure) {
      setError(failure);
      return null;
    } finally {
      setBusy(false);
    }
  };

  /**
   * One consent: record the boundary, prove the destination answers, fingerprint
   * exactly what will be sent, then arm — which is what persists the native
   * authorization, activates the collector file's cutoff for this home and
   * enables reporting.
   */
  const onArm = async () => {
    if (!Number.isFinite(resolved) || resolved <= Date.now()) { setInvalid('cutoff'); return; }
    if (collectorFile.trim() === '') { setInvalid('file'); return; }
    setInvalid(null);
    const file = collectorFile.trim();
    await run('plan', async () => {
      const planned = await api.planHandoff(destination.id, resolved);
      setStep('test');
      const tested = await api.testProtocol(destination.id);
      if (tested.outcome !== 'delivered') throw new Error(`handshake:${tested.outcome}`);
      setStep('preview');
      const payload = await api.preview(destination.id);
      setStep('arm');
      return api.armHandoff(destination.id, { collector_file: file, preview_fingerprint: payload.preview_fingerprint, acknowledge: true })
        .catch(async (failure: unknown) => { onHandoff(planned); throw failure; });
    });
  };

  const onRefresh = () => { void run('refresh', async () => {
    const next = await api.refreshHandoff(destination.id);
    onSettled();
    return next;
  }); };

  const onRollback = () => {
    const next = new Date(rollbackCutoff).getTime();
    if (!Number.isFinite(next) || next <= Date.now()) { setInvalid('rollback'); return; }
    setInvalid(null);
    void run('rollback', () => api.rollbackHandoff(destination.id, ceilToHalfHour(next), true));
  };

  // A handoff starts from a fresh vibecafe destination: the collector and Kiki
  // must not already both be reporting. Those are wire facts, so the screen says
  // which one blocks instead of offering a button that cannot work.
  const fresh = destination.target.kind === 'vibe' && destination.last_success_at === null;
  const arranging = view === null || view.phase === 'prepared';

  if (!fresh && view === null) {
    return (
      <section data-usage-export-handoff-section className="space-y-2">
        <h5 className="text-[12.5px] font-medium text-ink">{t('usage.export.handoff.title')}</h5>
        <p data-usage-export-handoff-inapplicable className={NOTE_SOFT}>{t('usage.export.handoff.freshOnly')}</p>
      </section>
    );
  }

  return (
    <section data-usage-export-handoff-section className="space-y-3">
      <h5 className="text-[12.5px] font-medium text-ink">{t('usage.export.handoff.title')}</h5>
      <p className={`${HINT} max-w-[76ch]`}>{t('usage.export.handoff.intro')}</p>

      {view !== null ? (
        <div data-usage-export-handoff-phase={view.phase} className={view.phase === 'completed' ? NOTE_SOFT : NOTE_AMBER}>
          <p className="font-medium">{t(PHASE_TITLE[view.phase])}</p>
          <p className="mt-0.5">{t(PHASE_BODY[view.phase])}</p>
        </div>
      ) : null}

      {view !== null && view.mismatch ? (
        <p data-usage-export-handoff-mismatch role="status" className={NOTE_AMBER}>{t('usage.export.handoff.mismatch')}</p>
      ) : null}

      {view !== null ? (
        <dl className="space-y-1 text-[12px] leading-5">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <dt className="text-ink-faint">{t('usage.export.handoff.cutoff')}</dt>
            <dd data-usage-export-handoff-cutoff-value className="font-mono text-ink tabular-nums">{utcLabel(view.cutoffAt)}</dd>
            {view.previousCutoffAt === null ? null : (
              <dd className="font-mono text-ink-faint line-through">{utcLabel(view.previousCutoffAt)}</dd>
            )}
          </div>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <dt className="text-ink-faint">{t('usage.export.handoff.collector')}</dt>
            <dd data-usage-export-handoff-legacy className="min-w-0 text-ink">
              {view.legacyReceipt === null
                ? t('usage.export.handoff.noLegacyReceipt')
                : t('usage.export.handoff.legacyReceipt', {
                    count: view.legacyReceipt.buckets,
                    time: time.relativeTime(new Date(view.legacyReceipt.completedAt).toISOString()),
                  })}
            </dd>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <dt className="text-ink-faint">Kiki</dt>
            <dd data-usage-export-handoff-native className="text-ink">
              {view.nativeReceipt === null
                ? t('usage.export.handoff.noNativeReceipt')
                : t('usage.export.handoff.nativeReceipt', { count: view.nativeReceipt.buckets })}
            </dd>
          </div>
        </dl>
      ) : null}

      {view !== null ? (
        <details data-usage-export-handoff-technical className="text-[12px] leading-relaxed text-ink-soft [&[open]>summary]:mb-1">
          <summary className="cursor-pointer text-ink-faint underline decoration-dotted underline-offset-2">
            {t('usage.export.handoff.technicalShow')}
          </summary>
          <p className="mt-1">
            <span className="text-ink-faint">{t('usage.export.handoff.namespace')}</span>
            {' '}
            <span className="font-mono break-all text-ink-soft">{view.namespace}</span>
          </p>
          <p className="mt-0.5">{t('usage.export.handoff.sameAccount')}</p>
        </details>
      ) : null}

      {arranging ? (
        <div className="space-y-2">
          {expired ? (
            <p data-usage-export-handoff-expired role="status" className={NOTE_AMBER}>{t('usage.export.handoff.expired')}</p>
          ) : null}
          {view === null ? (
            <p data-usage-export-handoff-none className={NOTE_SOFT}>{t('usage.export.handoff.notArranged')}</p>
          ) : null}
          <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
            <label className="block space-y-1">
              <span className="block text-[12px] text-ink-soft">{t('usage.export.handoff.cutoff')}</span>
              <input
                data-usage-export-handoff-cutoff
                type="datetime-local"
                value={cutoff}
                aria-invalid={invalid === 'cutoff'}
                onChange={(event) => { setCutoff(event.target.value); setInvalid(null); }}
                className={`${INPUT_BASE} w-56`}
              />
            </label>
            <label className="block min-w-0 space-y-1">
              <span className="block text-[12px] text-ink-soft">{t('usage.export.handoff.collectorFile')}</span>
              <input
                data-usage-export-handoff-file
                value={collectorFile}
                spellCheck={false}
                placeholder={t('usage.export.handoff.collectorPlaceholder')}
                aria-invalid={invalid === 'file'}
                onChange={(event) => { setCollectorFile(event.target.value); setInvalid(null); }}
                className={`${INPUT_BASE} w-80 max-w-full`}
              />
            </label>
          </div>
          <p data-usage-export-handoff-boundary className="font-mono text-[11.5px] text-ink-soft tabular-nums">
            {Number.isFinite(resolved) ? utcLabel(resolved) : ''}
          </p>
          <p className={`${HINT} max-w-[76ch]`}>{t('usage.export.handoff.cutoffHint')}</p>
          <div data-usage-export-handoff-effects className={NOTE_SOFT}>
            <p className="text-[12.5px] leading-relaxed text-ink-soft">{t('usage.export.handoff.effects')}</p>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-[12.5px] leading-relaxed text-ink-soft">
              <li>{t('usage.export.handoff.effect.collector')}</li>
              <li>{t('usage.export.handoff.effect.native')}</li>
            </ul>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-faint">{t('usage.export.handoff.safety')}</p>
          </div>
          <button type="button" data-usage-export-handoff-arm disabled={busy} onClick={() => void onArm()} className={PRIMARY_BUTTON}>
            {t(busy ? 'usage.export.handoff.arming' : 'usage.export.handoff.arm')}
          </button>
          <p className={`${HINT} max-w-[76ch]`}>{t('usage.export.handoff.armRequirements')}</p>
          {invalid !== null ? (
            <p role="alert" data-usage-export-handoff-invalid className="text-[12px] text-danger">
              {t(invalid === 'file' ? 'usage.export.handoff.fileRequired' : invalid === 'rollback' ? 'usage.export.handoff.cutoffInvalid' : 'usage.export.handoff.cutoffInvalid')}
            </p>
          ) : null}
        </div>
      ) : null}

      {view !== null && view.phase !== 'prepared' ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {view.phase !== 'completed' ? (
              <button type="button" data-usage-export-handoff-refresh disabled={busy} onClick={onRefresh} className={SECONDARY_BUTTON}>
                {t(busy && step === 'refresh' ? 'usage.export.busy.working' : 'usage.export.handoff.refresh')}
              </button>
            ) : null}
            <button
              type="button"
              data-usage-export-handoff-rollback-open
              aria-expanded={rollbackOpen}
              disabled={busy}
              onClick={() => { setRollbackOpen((current) => !current); }}
              className="rounded-md px-1.5 text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink disabled:opacity-50"
            >
              {t('usage.export.handoff.rollback')}
            </button>
          </div>
          {rollbackOpen ? (
            <div data-usage-export-handoff-rollback className="space-y-2">
              <p className={`${HINT} max-w-[76ch]`}>{t('usage.export.handoff.rollbackHint')}</p>
              <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
                <label className="block space-y-1">
                  <span className="block text-[12px] text-ink-soft">{t('usage.export.handoff.cutoff')}</span>
                  <input
                    data-usage-export-handoff-rollback-cutoff
                    type="datetime-local"
                    value={rollbackCutoff}
                    aria-invalid={invalid === 'rollback'}
                    onChange={(event) => { setRollbackCutoff(event.target.value); setInvalid(null); }}
                    className={`${INPUT_BASE} w-56`}
                  />
                </label>
                <button type="button" data-usage-export-handoff-rollback-run disabled={busy} onClick={onRollback} className={PRIMARY_BUTTON}>
                  {t(busy && step === 'rollback' ? 'usage.export.handoff.arming' : 'usage.export.handoff.rollbackRun')}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <p className={`${HINT} max-w-[76ch]`}>{t('usage.export.handoff.untouched')}</p>

      {error !== null ? (
        <div className="space-y-1">
          <p role="alert" data-usage-export-handoff-error className="text-[12px] text-danger">
            {t('usage.export.handoff.stepFailed', { step: step === null ? '' : t(STEP_LABEL[step] ?? 'usage.export.handoff.step.arm') })}
          </p>
          <InlineError error={error} />
        </div>
      ) : null}
      {handoff !== null && handoff.phase === 'prepared' && !expired && busy ? (
        <p role="status" className={HINT}>{t('usage.export.handoff.armProgress', { step: step === null ? '' : t(STEP_LABEL[step] ?? 'usage.export.handoff.step.arm') })}</p>
      ) : null}
    </section>
  );
}
