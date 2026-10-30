/**
 * 添加浏览器: one side panel, two steps, the same shape as 添加渠道.
 *
 * Step 1 asks the one question a person can answer: which browser should the
 * Agent drive? Each way in is one row — its name, one line of what it is, and
 * the server's own readiness word — with 手动配置 last for the browser no route
 * covers. Step 2 is that route's own setup (the server's actions, nothing
 * inferred), or the manual form, with Back in the panel header. Finishing a
 * route keeps the panel open on its connected state; the list behind it
 * refreshes on its own.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { I18nKey } from '@kiki/session-core/i18n';
import type { BrowserSourceId } from '@kiki/session-core/settings';

import { useI18n } from '../../../i18n';
import { browserApi, browserKeys, presetReadiness, type BrowserSetupStatus } from '../../../lib/browserRest';
import { useConnection } from '../../../state/connection';
import { Hint, InlineError } from '../../controls';
import { Icon } from '../../icons';
import { SidePanel } from '../../SidePanel';
import { SECONDARY_BUTTON } from '../../ui';
import { OtherBrowserEcosystems } from './BrowserBits';
import { BrowserRoute, READINESS_TONE } from './BrowserSetupWizard';
import { SOURCE_NAME_KEYS, useBrowserAllowance } from './browserAllowance';
import { WebBridgeReadiness } from './WebBridgeReadiness';

type Step = { readonly kind: 'pick' } | { readonly kind: 'route'; readonly preset: string } | { readonly kind: 'manual' };

/** The way people usually want first: their own browser, then Kiki's own. */
const ROUTE_ORDER = ['kimi-webbridge', 'independent-browser', 'codex-browser', 'ego-lite'];

const PICK_HINT_KEYS: Partial<Record<string, I18nKey>> = {
  'kimi-webbridge': 'st.browser.pick.kimi-webbridge',
  'independent-browser': 'st.browser.pick.independent-browser',
  'codex-browser': 'st.browser.pick.codex-browser',
  'ego-lite': 'st.browser.pick.ego-lite',
};

function routeName(t: ReturnType<typeof useI18n>['t'], preset: BrowserSetupStatus): string {
  return preset.preset in SOURCE_NAME_KEYS ? t(SOURCE_NAME_KEYS[preset.preset as BrowserSourceId]) : preset.displayName;
}

export function AddBrowserPanel({ onClose, manualForm, onManual }: {
  readonly onClose: () => void;
  /** The manual connection form; the card owns its draft and save. */
  readonly manualForm: React.ReactNode;
  /** Called when the person picks 手动配置, so the card can open a fresh draft. */
  readonly onManual: () => void;
}) {
  const { t } = useI18n();
  const { client, scopeId } = useConnection();
  const allowance = useBrowserAllowance();
  const [step, setStep] = useState<Step>({ kind: 'pick' });

  const query = useQuery({
    queryKey: browserKeys.presets(scopeId),
    queryFn: () => browserApi(client).setupPresets(),
    staleTime: 5_000,
    refetchOnWindowFocus: true,
    refetchInterval: (result) => result.state.data?.presets.some((preset) => preset.state === 'preparing') === true ? 1_500 : false,
  });
  const presets = [...(query.data?.presets ?? [])].sort((a, b) => {
    const ia = ROUTE_ORDER.indexOf(a.preset);
    const ib = ROUTE_ORDER.indexOf(b.preset);
    return (ia === -1 ? ROUTE_ORDER.length : ia) - (ib === -1 ? ROUTE_ORDER.length : ib);
  });
  const chosen = step.kind === 'route' ? presets.find((preset) => preset.preset === step.preset) : undefined;

  const title = step.kind === 'manual' ? t('st.browser.addManual')
    : chosen !== undefined ? routeName(t, chosen)
      : t('st.browser.add');

  return (
    <SidePanel
      title={title}
      overlayId="settings-add-browser"
      width="lg"
      onClose={onClose}
      data={{ 'data-browser-add-panel': step.kind === 'route' ? step.preset : step.kind }}
      back={step.kind === 'pick' ? undefined : { label: t('st.browser.add'), onClick: () => { setStep({ kind: 'pick' }); }, data: { 'data-browser-back': '' } }}
      stepKey={step.kind === 'route' ? step.preset : step.kind}
    >
      <div className="min-w-0 space-y-5" data-browser-add-view={step.kind}>
        {step.kind === 'pick' ? (
          <>
            <p className="text-[13px] text-ink-soft">{t('st.browser.pick.lead')}</p>
            {query.isPending ? (
              <p role="status" className="text-[12.5px] text-ink-faint">{t('st.browser.setup.detecting')}</p>
            ) : query.isError ? (
              <div className="space-y-2">
                <InlineError error={query.error} />
                <button type="button" className={SECONDARY_BUTTON} onClick={() => { void query.refetch(); }}>{t('common.retry')}</button>
              </div>
            ) : null}
            <ul className="divide-y divide-hairline border-y border-hairline" data-browser-pick-list>
              {presets.map((preset) => {
                const readiness = presetReadiness(preset);
                const enabled = allowance.sourceEnabled(preset.preset);
                const tone = READINESS_TONE[readiness];
                const hint = PICK_HINT_KEYS[preset.preset];
                return (
                  <li key={preset.preset}>
                    <button type="button" data-browser-pick={preset.preset}
                      onClick={() => { setStep({ kind: 'route', preset: preset.preset }); }}
                      className="group flex w-full items-center gap-3 px-1 py-3.5 text-left transition-colors hover:bg-ink/[0.025] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink">
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13.5px] font-medium text-ink">{routeName(t, preset)}</span>
                        {hint === undefined ? null : <span className="mt-0.5 block text-[12.5px] leading-5 text-ink-soft">{t(hint)}</span>}
                      </span>
                      <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px] text-ink-faint" data-browser-pick-state={enabled ? readiness : 'disabled'}>
                        <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${enabled ? tone.dot : 'bg-hairline-strong'}`} />
                        {enabled ? t(tone.text) : t('st.browser.source.disabled')}
                      </span>
                      <Icon name="chevron" size={14} className="shrink-0 text-ink-faint transition-colors group-hover:text-ink-soft" />
                    </button>
                  </li>
                );
              })}
              <li>
                <button type="button" data-browser-add-manual
                  onClick={() => { onManual(); setStep({ kind: 'manual' }); }}
                  className="group flex w-full items-center gap-3 px-1 py-3.5 text-left transition-colors hover:bg-ink/[0.025] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] font-medium text-ink">{t('st.browser.addManual')}</span>
                    <span className="mt-0.5 block text-[12.5px] leading-5 text-ink-soft">{t('st.browser.addManualHint')}</span>
                  </span>
                  <Icon name="chevron" size={14} className="shrink-0 text-ink-faint transition-colors group-hover:text-ink-soft" />
                </button>
              </li>
            </ul>
            <div className="space-y-1.5">
              <Hint>{t('st.browser.modelNotice')}</Hint>
              <OtherBrowserEcosystems />
            </div>
          </>
        ) : step.kind === 'manual' ? (
          manualForm
        ) : chosen === undefined ? (
          <p role="status" className="text-[12.5px] text-ink-faint">{t('st.browser.setup.detecting')}</p>
        ) : (
          <BrowserRoute preset={chosen} open onOpenChange={() => {}} bare>
            {chosen.preset === 'kimi-webbridge' ? <WebBridgeReadiness /> : null}
          </BrowserRoute>
        )}
      </div>
    </SidePanel>
  );
}
