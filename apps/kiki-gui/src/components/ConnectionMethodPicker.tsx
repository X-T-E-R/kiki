/**
 * ConnectionMethodPicker — the one way into a new connection, shared by the
 * Connections tab and the onboarding model step. First the person chooses
 * HOW they reach models: an API key (any hosted API or a server on this
 * machine) or signing in with an account (OAuth). Then the API lane offers
 * the generic wire protocols, with vendor presets only as a search/shortcut
 * that fills the base URL; the account lane lists the server's sign-in
 * methods. No vendor is a connection type of its own.
 */

import { useState } from 'react';

import { useI18n } from '../i18n';
import { AccountSignIn } from './AccountSignIn';
import { Icon } from './icons';
import { PresetGrid } from './PresetGrid';
import type { ProviderPreset, ProviderWireType } from './providerPresets';

export type ConnectionMethod = 'api' | 'account';

const CHOICE =
  'flex min-w-0 flex-1 items-start gap-2.5 rounded-lg px-3 py-2.5 text-left outline-none transition-colors duration-[var(--kiki-motion-quick)] focus-visible:ring-2 focus-visible:ring-accent/40 pointer-coarse:min-h-11';

export function ConnectionMethodPicker({
  onPickApi,
  onAccountChanged,
  dense = false,
  initialMethod = 'api',
}: {
  /** A protocol card (preset null) or a vendor preset was chosen. */
  onPickApi: (preset: ProviderPreset | null, protocol?: ProviderWireType) => void;
  onAccountChanged?: () => Promise<void> | void;
  /** Onboarding density: stacked protocol list, no quick-start chips. */
  dense?: boolean;
  initialMethod?: ConnectionMethod;
}) {
  const { t } = useI18n();
  const [method, setMethod] = useState<ConnectionMethod>(initialMethod);
  const choices: readonly { id: ConnectionMethod; title: string; body: string }[] = [
    { id: 'api', title: t('st.connect.apiTitle'), body: t('st.connect.apiBody') },
    { id: 'account', title: t('st.connect.accountTitle'), body: t('st.connect.accountBody') },
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
      {method === 'api'
        ? <PresetGrid dense={dense} onPick={onPickApi} />
        : <AccountSignIn compact={dense} onChanged={onAccountChanged} />}
    </div>
  );
}
