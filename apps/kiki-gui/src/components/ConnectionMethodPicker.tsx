/**
 * ConnectionMethodPicker — the one way into a new connection, shared by the
 * Connections tab and the onboarding model step.
 *
 * One question, asked in the order a person actually has it: *which service*,
 * then *by what means*. Signing in with an account names the service itself, so
 * that lane is a short list. Bringing your own key needs a service to bring it
 * to, and the models.dev directory is where most people find one — a name, an
 * address and a model list, prefilled into the same form a hand-written entry
 * uses. The manual path stays for a service the directory does not have.
 *
 * Every route ends in the same place: one more connection on the list.
 */

import { useState } from 'react';

import { useI18n } from '../i18n';
import { AccountSignIn } from './AccountSignIn';
import { Icon } from './icons';
import { PresetGrid } from './PresetGrid';
import { CatalogImportPicker } from './settings/CatalogImportCard';
import type { ProviderPreset, ProviderWireType } from './providerPresets';

export type ConnectionMethod = 'api' | 'account';
export type ConnectionSource = 'directory' | 'manual';

const CHOICE =
  'flex min-w-0 flex-1 items-start gap-2 rounded-lg px-3 py-2 text-left outline-none transition-colors duration-[var(--kiki-motion-quick)] focus-visible:ring-2 focus-visible:ring-selected-ink/40 pointer-coarse:min-h-11';

export function ConnectionMethodPicker({
  onPickApi,
  onAccountChanged,
  onImported,
  configuredIds,
  dense = false,
  initialMethod = 'api',
}: {
  /** A protocol card (preset null) or a vendor preset was chosen. */
  onPickApi: (preset: ProviderPreset | null, protocol?: ProviderWireType) => void;
  onAccountChanged?: () => Promise<void> | void;
  /** A directory pick wrote a connection; the page re-reads its lists. */
  onImported?: () => Promise<void> | void;
  /** Ids already configured, so a directory pick can say it updates one. */
  configuredIds?: ReadonlySet<string>;
  /** Onboarding density: stacked protocol list, no quick-start chips. */
  dense?: boolean;
  initialMethod?: ConnectionMethod;
}) {
  const { t } = useI18n();
  const [method, setMethod] = useState<ConnectionMethod>(initialMethod);
  // The directory leads where a person is choosing a service for the first
  // time. Onboarding already walks them to a chosen provider, so it takes the
  // direct path and never shows the switch.
  const [source, setSource] = useState<ConnectionSource>(dense ? 'manual' : 'directory');
  const choices: readonly { id: ConnectionMethod; title: string; body: string }[] = [
    { id: 'account', title: t('st.connect.accountTitle'), body: t('st.connect.accountBody') },
    { id: 'api', title: t('st.connect.apiTitle'), body: t('st.connect.apiBody') },
  ];
  const sources: readonly { id: ConnectionSource; label: string }[] = [
    { id: 'directory', label: t('st.connect.sourceDirectory') },
    { id: 'manual', label: t('st.connect.sourceManual') },
  ];
  return (
    <div className="space-y-4" data-connection-method-picker data-connection-method={method}>
      <div role="radiogroup" aria-label={t('st.connect.methodAria')}
        className="flex flex-col gap-0.5 rounded-[10px] bg-ink/[0.04] p-0.5 sm:flex-row">
        {choices.map((choice) => {
          const selected = choice.id === method;
          return (
            <button
              key={choice.id}
              type="button"
              role="radio"
              aria-checked={selected}
              data-connection-choice={choice.id}
              onClick={() => { setMethod(choice.id); }}
              className={`${CHOICE} ${selected
                ? 'bg-paper shadow-[var(--kiki-sheet-shadow)]'
                : 'hover:bg-ink/[0.04]'}`}
            >
              <span aria-hidden className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                selected ? 'border-ink bg-ink text-paper' : 'border-hairline-strong'}`}>
                {selected ? <Icon name="check" size={12} /> : null}
              </span>
              <span className="min-w-0">
                <span className={`block text-[13px] ${selected ? 'font-medium text-ink' : 'text-ink-soft'}`}>{choice.title}</span>
                <span className="mt-0.5 block text-[12px] leading-4 text-ink-faint">{choice.body}</span>
              </span>
            </button>
          );
        })}
      </div>
      {method === 'account'
        ? <AccountSignIn compact={dense} onChanged={onAccountChanged} configuredProviderIds={configuredIds} />
        : (
          <div className="space-y-3">
            {/* Which service: a known one from the directory, or one you name
                yourself. Both open the same connection form. */}
            <div role="tablist" aria-label={t('st.connect.serviceAria')} data-connection-source={source}
              className="flex gap-1 border-b border-hairline">
              {sources.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  role="tab"
                  aria-selected={source === candidate.id}
                  data-connection-source-choice={candidate.id}
                  onClick={() => { setSource(candidate.id); }}
                  className={`-mb-px min-h-8 border-b-2 px-3 py-1.5 text-[12px] transition-colors ${
                    source === candidate.id
                      ? 'border-ink font-medium text-ink'
                      : 'border-transparent text-ink-soft hover:text-ink'}`}
                >
                  {candidate.label}
                </button>
              ))}
            </div>
            {source === 'directory' ? (
              <CatalogImportPicker
                configuredIds={configuredIds ?? new Set<string>()}
                onImported={async () => { await onImported?.(); }} />
            ) : (
              <PresetGrid dense={dense} onPick={onPickApi} />
            )}
          </div>
        )}
    </div>
  );
}
