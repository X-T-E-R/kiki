/**
 * The one enable flow, for a new user arriving from the Work entry and an
 * existing user switching a mode on from inside the app. Same sheet, same
 * button, same result.
 *
 * It shows this home's real gaps and nothing else: what is already there, what
 * is missing, and the one external program the missing part needs. Nothing is
 * re-confirmed per package, and nothing the user already disabled is quietly
 * put back — the server decides that, and this sheet reflects its answer.
 *
 * A partial install is a first-class outcome, not an error screen: whatever
 * succeeded stays, the rest is named, and retrying is the same one action.
 */

import { useEffect, useMemo, useState } from 'react';

import type { WorkPresetItem } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../i18n';
import type { KikiClient } from '../lib/client';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from './Dialog';
import { Spinner } from './icons';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from './ui';

type Phase =
  | { readonly kind: 'review' }
  | { readonly kind: 'working' }
  | { readonly kind: 'done' }
  | { readonly kind: 'partial'; readonly completed: readonly string[]; readonly failures: readonly { readonly plugin_id: string; readonly message: string }[] };

export interface WorkSetupSheetProps {
  readonly mode: WorkPresetItem;
  readonly client: KikiClient;
  /** After the server accepted the setup; the caller lands on the surface. */
  readonly onClose: () => void;
  readonly onEnabled: (mode: WorkPresetItem) => void;
  /** Open a document so the user can see what the setup was for. */
  readonly onPickFile?: () => void;
}

function ItemMark({ state }: { state: 'have' | 'missing' }) {
  return state === 'have'
    ? <span aria-hidden className="mt-0.5 flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full bg-success text-[9px] font-bold text-white">✓</span>
    : <span aria-hidden className="mt-0.5 h-[15px] w-[15px] shrink-0 rounded-full border-[1.5px] border-amber-rule" />;
}

function PrerequisiteSize(): string {
  return '84 MB';
}

export function WorkSetupSheet({ mode, client, onClose, onEnabled, onPickFile }: WorkSetupSheetProps) {
  const { t, locale } = useI18n();
  const [phase, setPhase] = useState<Phase>({ kind: 'review' });
  const [installPrerequisites, setInstallPrerequisites] = useState(true);

  const ready = useMemo(() => mode.plugins.filter((plugin) => plugin.installed && plugin.enabled), [mode.plugins]);
  const missing = useMemo(() => mode.plugins.filter((plugin) => !plugin.installed || !plugin.enabled), [mode.plugins]);
  const prerequisite = useMemo(() => mode.plugins.find((plugin) => plugin.prerequisite !== undefined), [mode.plugins]);

  useEffect(() => {
    if (phase.kind !== 'working') return;
    let cancelled = false;
    client.enableWorkPreset(mode.id, installPrerequisites).then((response) => {
      if (cancelled) return;
      setPhase(response.failures.length === 0 ? { kind: 'done' } : { kind: 'partial', completed: response.completed, failures: response.failures });
      onEnabled(response.preset);
    }, (error: unknown) => {
      if (cancelled) return;
      setPhase({ kind: 'partial', completed: [], failures: [{ plugin_id: mode.id, message: errorText(locale, error) }] });
    });
    return () => { cancelled = true; };
  }, [client, installPrerequisites, locale, mode.id, onEnabled, phase.kind]);

  const start = (): void => { setPhase({ kind: 'working' }); };

  const title = t('workSetup.title');

  return (
    <Dialog
      onClose={onClose}
      ariaLabel={title}
      overlayId="work-setup"
      panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.md} p-0`}
      overlayData={{ 'data-work-setup': phase.kind }}
    >
      <div className="flex max-h-[min(80vh,46rem)] flex-col">
        <div className="shrink-0 border-b border-hairline px-5 py-4">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.11em] text-accent-ink">
            {t('workSetup.eyebrow', { name: mode.name })}
          </p>
          <h2 className="mt-2 font-display text-[19px] font-semibold leading-[1.2] tracking-tight text-ink">{title}</h2>
          {phase.kind === 'review' || phase.kind === 'working' ? (
            <p className="mt-2 max-w-[48ch] text-[12.5px] leading-[1.55] text-ink-soft">
              {t('workSetup.body', { description: mode.description })}
            </p>
          ) : null}
          {phase.kind === 'done' ? (
            <p className="mt-2 text-[12.5px] leading-[1.55] text-ink-soft">{t('workSetup.doneBody')}</p>
          ) : null}
          {phase.kind === 'partial' ? (
            <p className="mt-2 text-[12.5px] leading-[1.55] text-ink-soft">
              {t('workSetup.partialBody', {
                done: String(phase.completed.length),
                total: String(missing.length),
              })}
            </p>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-3.5">
          {phase.kind === 'review' || phase.kind === 'working' ? (
            <>
              {ready.length > 0 ? (
                <>
                  <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-section-ink">{t('workSetup.haveHeading')}</p>
                  {ready.map((plugin) => (
                    <div key={plugin.id} className="flex items-start gap-2.5 border-b border-hairline py-2.5 last:border-b-0">
                      <ItemMark state="have" />
                      <div className="min-w-0 flex-1">
                        <p className="block text-[13px] font-medium text-ink">{plugin.name}</p>
                        <p className="mt-0.5 block text-[11.5px] leading-[1.5] text-ink-faint">{plugin.purpose}</p>
                        <span className="mt-1 block text-[10.5px] font-medium uppercase tracking-[0.03em] text-ink-faint">{t('workSetup.itemInstalledOn')}</span>
                      </div>
                    </div>
                  ))}
                </>
              ) : null}

              {missing.length > 0 ? (
                <>
                  <p className="mb-2 mt-3 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-section-ink">{t('workSetup.addHeading')}</p>
                  {missing.map((plugin) => (
                    <div key={plugin.id} className="flex items-start gap-2.5 border-b border-hairline py-2.5 last:border-b-0">
                      <ItemMark state="missing" />
                      <div className="min-w-0 flex-1">
                        <p className="block text-[13px] font-medium text-ink">{plugin.name}</p>
                        <p className="mt-0.5 block text-[11.5px] leading-[1.5] text-ink-faint">{plugin.purpose}</p>
                        <span className="mt-1 block text-[10.5px] font-medium uppercase tracking-[0.03em] text-ink-faint">
                          {plugin.required ? t('workSetup.itemMissing') : t('workSetup.itemOptional')}
                        </span>
                      </div>
                    </div>
                  ))}
                </>
              ) : null}

              {prerequisite !== undefined ? (
                <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-amber-rule bg-amber-card p-3" data-work-prerequisite>
                  <ItemMark state="missing" />
                  <div className="min-w-0 flex-1">
                    <p className="block text-[12.5px] font-medium text-ink">
                      {t('workSetup.prereqTitle', { name: 'OfficeCLI', size: PrerequisiteSize() })}
                    </p>
                    <p className="mt-1 text-[11.5px] leading-[1.5] text-amber-ink">
                      {t('workSetup.prereqBody', {
                        body: t('workSetup.prereqSkipNote', { name: mode.name }),
                      })}
                    </p>
                    <label className="mt-2.5 flex cursor-pointer items-start gap-2">
                      <input
                        type="checkbox"
                        checked={installPrerequisites}
                        disabled={phase.kind === 'working'}
                        onChange={(event) => { setInstallPrerequisites(event.target.checked); }}
                        className="mt-0.5 h-3.5 w-3.5 accent-[var(--color-accent)]"
                      />
                      <span className="text-[12px] leading-[1.5] text-ink-soft">{t('workSetup.prereqConsent')}</span>
                    </label>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}

          {phase.kind === 'partial' ? (
            <div className="mt-1">
              {phase.completed.length > 0 ? (
                <>
                  <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-section-ink">{t('workSetup.itemReady')}</p>
                  {mode.plugins
                    .filter((plugin) => phase.completed.includes(plugin.id))
                    .map((plugin) => (
                      <div key={plugin.id} className="flex items-start gap-2.5 border-b border-hairline py-2.5">
                        <ItemMark state="have" />
                        <div className="min-w-0 flex-1">
                          <p className="block text-[13px] font-medium text-ink">{plugin.name}</p>
                          <p className="mt-0.5 block text-[11.5px] leading-[1.5] text-ink-faint">{plugin.purpose}</p>
                        </div>
                      </div>
                    ))}
                </>
              ) : null}
              {phase.failures.map((failure) => {
                const plugin = mode.plugins.find((entry) => entry.id === failure.plugin_id);
                return (
                  <div key={`${failure.plugin_id}-${failure.message}`} className="mt-3 rounded-lg border border-danger bg-[#fbeceb] p-3" data-work-setup-failure>
                    <p className="text-[12px] leading-[1.5] text-danger">
                      <b className="font-semibold">{t('workSetup.failedItem', { name: plugin?.name ?? failure.plugin_id, reason: failure.message })}</b>
                    </p>
                  </div>
                );
              })}
            </div>
          ) : null}

          {phase.kind === 'done' ? (
            <p className="text-[12.5px] text-ink-soft" data-work-setup-done>{t('workSetup.doneTitle', { name: mode.name })}</p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-hairline bg-paper px-5 py-3">
          <span className="flex-1 text-[11px] leading-[1.45] text-ink-faint">{t('workSetup.reuseNote')}</span>
          {phase.kind === 'review' ? (
            <>
              <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>{t('workSetup.decline')}</button>
              <button type="button" onClick={start} data-work-setup-confirm className={PRIMARY_BUTTON}>{t('workSetup.confirm', { name: mode.name })}</button>
            </>
          ) : null}
          {phase.kind === 'working' ? (
            <button type="button" disabled className={PRIMARY_BUTTON} data-work-setup-working>
              <span className="flex items-center gap-2"><Spinner label={t('workSetup.working')} size={12} />{t('workSetup.working')}</span>
            </button>
          ) : null}
          {phase.kind === 'done' ? (
            <button type="button" onClick={onPickFile ?? onClose} data-work-setup-start className={PRIMARY_BUTTON}>{t('workSetup.doneAction')}</button>
          ) : null}
          {phase.kind === 'partial' ? (
            <>
              <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>{t('workSetup.close')}</button>
              <button type="button" onClick={start} data-work-setup-retry className={PRIMARY_BUTTON}>{t('workSetup.partialAction')}</button>
            </>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
