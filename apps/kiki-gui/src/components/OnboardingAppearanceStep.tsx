/**
 * The appearance half of the onboarding welcome page: light / dark / system,
 * the built-in palettes as tappable swatches, and an optional background
 * picture with one strength slider. Every choice writes the real setting at
 * once, and the app behind the dialog is the preview — there is no mock
 * frame here. The wizard renders the language row above these rows with the
 * same `OnboardingRow`, so the page reads as one short form.
 */

import { useState, useSyncExternalStore, type ReactNode } from 'react';

import type { SkinFile } from '@kiki/protocol';
import {
  settingsServerSnapshot,
  settingsSnapshot,
  subscribeSettings,
  writeSettings,
  type ThemePreference,
} from '@kiki/session-core/settings';

import { useI18n } from '../i18n';
import { BUILTIN_SKINS, declaredVariants, writeSkinPrefs } from '../lib/skins';
import { prefersDark, resolveTheme, type ResolvedTheme } from '../lib/theme';
import { BackgroundSettings, useBackgroundPrefs } from './settings/BackgroundSettings';
import { SettingsSegmented } from './settings/SettingsPrimitives';
import { Icon } from './icons';
import { PAPER_SWATCH, useSkinPrefs } from './settings/SkinSettings';

/**
 * One labelled row of the welcome page: a fixed label column on wide
 * screens, stacked on narrow ones. Rows are divided by a hairline, not boxed.
 */
export function OnboardingRow({ label, labelId, children }: {
  readonly label: string;
  readonly labelId: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid gap-x-6 gap-y-2 border-t border-hairline py-3.5 first:border-t-0 first:pt-0 sm:grid-cols-[112px_minmax(0,1fr)]">
      <span id={labelId} className="pt-1 text-[13px] font-medium text-ink">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Four color cells from the palette itself, in the theme on screen. */
function Swatch({ skin, theme }: { skin: SkinFile; theme: ResolvedTheme }) {
  const variant = skin.variants[theme] ?? skin.variants[declaredVariants(skin)[0] ?? 'light'];
  // Paper sets no colors (it is the stylesheet palette); see PAPER_SWATCH.
  const colors = variant?.colors ?? PAPER_SWATCH[theme];
  const cells = [colors.canvas, colors.paper, colors.ink, colors.accent].map((value) => value ?? 'var(--color-paper)');
  return (
    <span aria-hidden className="grid h-8 w-full grid-cols-4 overflow-hidden rounded-[7px] ring-1 ring-hairline">
      {cells.map((color, index) => <span key={index} style={{ backgroundColor: color }} />)}
    </span>
  );
}

export function OnboardingAppearanceStep() {
  const { t } = useI18n();
  const settings = useSyncExternalStore(subscribeSettings, settingsSnapshot, settingsServerSnapshot);
  const skin = useSkinPrefs();
  const background = useBackgroundPrefs();
  const theme = resolveTheme(settings.theme, prefersDark());
  const hasBackground = background.light !== null || background.dark !== null;
  const [showBackground, setShowBackground] = useState(hasBackground);

  return (
    <div data-onboarding-appearance>
      <OnboardingRow label={t('onboarding.appearance.brightness')} labelId="onboarding-theme-label">
        <SettingsSegmented<ThemePreference>
          ariaLabelledBy="onboarding-theme-label"
          dataAttr="data-theme-choice"
          value={settings.theme}
          onChange={(choice) => { writeSettings({ theme: choice }); }}
          choices={(['light', 'dark', 'system'] as ThemePreference[]).map((choice) => ({
            value: choice, label: t(`st.appearance.theme.${choice}`),
          }))}
        />
      </OnboardingRow>

      <OnboardingRow label={t('onboarding.appearance.colors')} labelId="onboarding-palette-label">
        <ul role="radiogroup" aria-labelledby="onboarding-palette-label" className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          {BUILTIN_SKINS.map((option) => {
            const selected = skin.selection.source === 'builtin' && skin.selection.id === option.id;
            return (
              <li key={option.id}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-onboarding-palette={option.id}
                  onClick={() => { writeSkinPrefs({ selection: { source: 'builtin', id: option.id ?? 'paper' } }); }}
                  // The chosen palette is "where you are": the ink-blue ring, not the accent.
                  className={`flex w-full flex-col gap-1.5 rounded-[9px] p-1.5 text-left transition-[background-color,box-shadow] duration-[var(--kiki-motion-quick)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink ${
                    selected ? 'bg-selected ring-1 ring-selected-ink/60' : 'hover:bg-ink/[0.04]'
                  }`}
                >
                  <Swatch skin={option} theme={theme} />
                  <span className={`px-0.5 text-[12px] leading-4 ${selected ? 'font-medium text-selected-ink' : 'text-ink-soft'}`}>
                    {t(`onboarding.appearance.palette.${option.id}` as 'onboarding.appearance.palette.paper')}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </OnboardingRow>

      <OnboardingRow label={t('onboarding.appearance.picture')} labelId="onboarding-picture-label">
        {showBackground ? (
          <BackgroundSettings theme={theme} compact />
        ) : (
          <button
            type="button"
            data-onboarding-bg-open
            aria-expanded={false}
            aria-describedby="onboarding-picture-label"
            onClick={() => { setShowBackground(true); }}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-1 text-[13px] text-ink-soft transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
          >
            <Icon name="plus" size={12} />
            {t('onboarding.appearance.addPicture')}
          </button>
        )}
      </OnboardingRow>
    </div>
  );
}
