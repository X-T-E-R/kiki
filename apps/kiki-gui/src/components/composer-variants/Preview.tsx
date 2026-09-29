/**
 * Variant picker for the composer state prototypes. `chrome=0` hides the
 * floating switcher so screenshots show only the conversation sheet.
 */

import { STATES, stateFor, type StateKey } from './states';
import { VariantA } from './VariantA';
import { VariantB } from './VariantB';
import { VariantC } from './VariantC';
import { VariantD } from './VariantD';

export const VARIANTS = {
  a: { name: 'A · 时间线尾部', Component: VariantA },
  b: { name: 'B · 状态带', Component: VariantB },
  c: { name: 'C · Dock 清单', Component: VariantC },
  d: { name: 'D · 输入框接管', Component: VariantD },
} as const;

type VariantKey = keyof typeof VARIANTS;

function isVariant(key: string): key is VariantKey {
  return key in VARIANTS;
}

function go(next: { composer?: string; state?: string }) {
  const params = new URLSearchParams(location.search);
  for (const [key, value] of Object.entries(next)) if (value !== undefined) params.set(key, value);
  location.search = params.toString();
}

export function Preview({ variant, stateKey, chrome }: { readonly variant: string; readonly stateKey: string; readonly chrome: boolean }) {
  const key: VariantKey = isVariant(variant) ? variant : 'a';
  const { Component } = VARIANTS[key];
  const state = stateFor(stateKey);
  return (
    <div data-variant={key} data-state={stateKey}>
      <Component state={state} />
      {chrome ? (
        <div className="fixed top-3 right-3 z-50 flex items-center gap-1.5 rounded-lg bg-panel p-1.5 text-[12px] shadow-[var(--kiki-sheet-shadow)]">
          <select aria-label="方案" value={key} onChange={(event) => { go({ composer: event.target.value }); }} className="rounded-md bg-paper px-1.5 py-1 text-ink">
            {Object.entries(VARIANTS).map(([id, entry]) => <option key={id} value={id}>{entry.name}</option>)}
          </select>
          <select aria-label="状态组合" value={stateKey} onChange={(event) => { go({ state: event.target.value }); }} className="rounded-md bg-paper px-1.5 py-1 text-ink">
            {(Object.keys(STATES) as StateKey[]).map((id) => <option key={id} value={id}>{STATES[id].label}</option>)}
          </select>
        </div>
      ) : null}
    </div>
  );
}
