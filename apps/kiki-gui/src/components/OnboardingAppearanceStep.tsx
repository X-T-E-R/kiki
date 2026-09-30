/**
 * The onboarding "Make it yours" step: light / dark / system, the built-in
 * palettes as tappable swatches, and an optional background picture with one
 * strength slider. Every choice writes the real setting at once, and the app
 * behind the dialog is the preview — there is no mock frame here.
 */

import { useState, useSyncExternalStore } from 'react';

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
import { PAPER_SWATCH, useSkinPrefs } from './settings/SkinSettings';

/** Four color cells from the palette itself, in the theme on screen. */
function Swatch({ skin, theme }: { skin: SkinFile; theme: ResolvedTheme }) {
  const variant = skin.variants[theme] ?? skin.variants[declaredVariants(skin)[0] ?? 'light'];
  // Paper sets no colors (it is the stylesheet palette); see PAPER_SWATCH.
  const colors = variant?.colors ?? PAPER_SWATCH[theme];
  const cells = [colors.canvas, colors.paper, colors.ink, colors.accent].map((value) => value ?? 'var(--color-paper)');
  return (
    <span aria-hidden className="grid h-10 w-full grid-cols-4 overflow-hidden rounded-[8px] ring-1 ring-hairline">
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
    <div className="mt-3 space-y-5" data-onboarding-appearance>
      <p className="text-[12px] leading-relaxed text-ink-soft">{t('onboarding.appearance.body')}</p>

      <div className="space-y-2">
        <span id="onboarding-theme-label" className="block text-[13px] text-ink">{t('onboarding.appearance.brightness')}</span>
        <SettingsSegmented<ThemePreference>
          ariaLabelledBy="onboarding-theme-label"
          dataAttr="data-theme-choice"
          value={settings.theme}
          onChange={(choice) => { writeSettings({ theme: choice }); }}
          choices={(['light', 'dark', 'system'] as ThemePreference[]).map((choice) => ({
            value: choice, label: t(`st.appearance.theme.${choice}`),
          }))}
        />
      </div>

      <div className="space-y-2">
        <span id="onboarding-palette-label" className="block text-[13px] text-ink">{t('onboarding.appearance.colors')}</span>
        <ul role="radiogroup" aria-labelledby="onboarding-palette-label" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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
                  className={`flex w-full flex-col gap-1.5 rounded-[10px] p-1.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-selected-ink ${
                    selected ? 'bg-paper shadow-[var(--kiki-sheet-shadow)]' : 'hover:bg-ink/[0.04]'
                  }`}
                >
                  <Swatch skin={option} theme={theme} />
                  <span className={`px-0.5 text-[12px] leading-4 ${selected ? 'font-medium text-ink' : 'text-ink-soft'}`}>
                    {t(`onboarding.appearance.palette.${option.id}` as 'onboarding.appearance.palette.paper')}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="space-y-2">
        {showBackground ? (
          <>
            <span className="block text-[13px] text-ink">{t('onboarding.appearance.picture')}</span>
            <BackgroundSettings theme={theme} compact />
          </>
        ) : (
          <button
            type="button"
            data-onboarding-bg-open
            aria-expanded={false}
            onClick={() => { setShowBackground(true); }}
            className="flex min-h-9 items-center gap-1.5 rounded-md text-[13px] text-ink-soft transition-colors hover:text-ink"
          >
            <span aria-hidden className="text-[15px] leading-none">+</span>
            {t('onboarding.appearance.addPicture')}
          </button>
        )}
      </div>

      <p className="text-[12px] text-ink-faint">{t('onboarding.appearance.later')}</p>
    </div>
  );
}
