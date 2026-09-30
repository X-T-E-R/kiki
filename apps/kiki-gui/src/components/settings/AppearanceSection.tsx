import { useState, useSyncExternalStore } from 'react';

import {
  settingsServerSnapshot,
  settingsSnapshot,
  subscribeSettings,
  writeSettings,
  type MotionPreference,
  type ThemePreference,
} from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import {
  defaultAppearanceFor,
  isDefaultAppearance,
  readAppearance,
  writeAppearance,
  writeSkinPrefs,
  type AppearanceSnapshot,
  type SkinTweaks,
} from '../../lib/skins';
import { prefersDark, resolveTheme } from '../../lib/theme';
import { Hint } from '../controls';
import { SECONDARY_BUTTON } from '../ui';
import { AppearancePacks } from './AppearancePacks';
import { AppearancePreview } from './AppearancePreview';
import { BackgroundSettings, useBackgroundPrefs } from './BackgroundSettings';
import { SectionCard } from './SectionCard';
import { SettingField } from './fields';
import { FontRoleField } from './FontRoleField';
import { firstFamily } from '../../lib/fontDetect';
import { SettingsSegmented } from './SettingsPrimitives';
import { SkinFiles, SkinPicker, useSkinPrefs } from './SkinSettings';

const DENSITY_CHOICES = [
  { value: 'compact' as const, rem: 0.22 },
  { value: 'default' as const, rem: 0.25 },
  { value: 'roomy' as const, rem: 0.29 },
];

const RADIUS_DEFAULT = 12;

const FONT_CHOICES: readonly { value: string; label: string | null }[] = [
  { value: '', label: null },
  { value: "'Instrument Sans Variable', 'Instrument Sans', ui-sans-serif, system-ui, 'PingFang SC', 'Noto Sans SC', sans-serif", label: 'Instrument Sans' },
  { value: "'Newsreader Variable', 'Newsreader', Georgia, 'Songti SC', 'Noto Serif SC', serif", label: 'Newsreader' },
  { value: "'Space Grotesk', ui-sans-serif, system-ui, 'PingFang SC', 'Noto Sans SC', sans-serif", label: 'Space Grotesk' },
  { value: "ui-sans-serif, system-ui, 'Segoe UI', 'PingFang SC', 'Noto Sans SC', sans-serif", label: 'System sans' },
];

/** What a typed family falls back to, per role, so missing glyphs land on a deliberate face. */
const SANS_FALLBACK = "ui-sans-serif, system-ui, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif";
const MONO_FALLBACK = "ui-monospace, 'Cascadia Mono', Consolas, 'PingFang SC', 'Microsoft YaHei', monospace";
const PROSE_FALLBACK = "Georgia, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', serif";

/** A stored stack is a preset when it is one of the listed values; anything else was typed. */
function splitStack(stack: string | undefined, presets: readonly { value: string }[]): { preset: string; custom: string | undefined } {
  if (stack === undefined) return { preset: '', custom: undefined };
  return presets.some((choice) => choice.value === stack) ? { preset: stack, custom: undefined } : { preset: '', custom: stack };
}

const MONO_CHOICES: readonly { value: string; label: string | null }[] = [
  { value: '', label: null },
  { value: "'JetBrains Mono', ui-monospace, Consolas, monospace", label: 'JetBrains Mono' },
  { value: "ui-monospace, 'Cascadia Mono', Consolas, monospace", label: 'System mono' },
];

function densityOf(spacing: number | undefined): 'compact' | 'default' | 'roomy' {
  if (spacing === undefined) return 'default';
  return DENSITY_CHOICES.reduce((best, choice) =>
    Math.abs(choice.rem - spacing) < Math.abs(best.rem - spacing) ? choice : best,
  ).value;
}

/** The accent currently on screen, so the color input opens on the real value. */
function readAccent(): string {
  if (typeof document === 'undefined') return '#c8401a';
  const value = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim();
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#c8401a';
}

/**
 * The face "Follow skin" resolves to for one role, read from the live stack
 * while no tweak overrides it (with a tweak in force the skin's own face is
 * not on screen, and the generic label is enough).
 */
function skinFaceName(variable: '--font-sans' | '--font-mono', tweak: string | undefined): string | null {
  if (tweak !== undefined || typeof document === 'undefined') return null;
  const stack = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  if (stack === '') return null;
  const face = firstFamily(stack).replace(/ Variable$/, '');
  return face === '' || face.startsWith('ui-') ? null : face;
}

/**
 * Settings → Appearance. Every control applies the moment it changes, so the
 * app (and the preview at the top) is the feedback; there is no draft to save.
 * The one page-level action is "Restore defaults", which keeps an undo; it is
 * only there once something is customized (the theme choice does not count).
 */
export function AppearanceSection() {
  const { t } = useI18n();
  const settings = useSyncExternalStore(subscribeSettings, settingsSnapshot, settingsServerSnapshot);
  const skinPrefs = useSkinPrefs();
  const tweaks = skinPrefs.tweaks;
  const [undo, setUndo] = useState<AppearanceSnapshot | null>(null);
  const theme = resolveTheme(settings.theme, prefersDark());

  const setTweak = <K extends keyof SkinTweaks>(key: K, value: SkinTweaks[K] | undefined) => {
    const { [key]: _drop, ...rest } = tweaks;
    writeSkinPrefs({ tweaks: value === undefined ? rest : { ...rest, [key]: value } });
    setUndo(null);
  };
  const setLocal = (patch: Partial<Pick<AppearanceSnapshot, 'theme' | 'motion' | 'proseFont'>>) => {
    writeSettings(patch);
    setUndo(null);
  };

  const background = useBackgroundPrefs();
  const current: AppearanceSnapshot = {
    theme: settings.theme,
    motion: settings.motion,
    proseFont: settings.proseFont,
    skin: skinPrefs,
    background,
  };
  const atDefaults = isDefaultAppearance(current);
  const sans = splitStack(tweaks.fontSans, FONT_CHOICES);
  const mono = splitStack(tweaks.fontMono, MONO_CHOICES);
  const fontPresets = (choices: readonly { value: string; label: string | null }[], variable: '--font-sans' | '--font-mono') => {
    // "Follow skin" names the face the skin resolves to, so the interface and
    // code rows never show two identical triggers, and the list never offers
    // that same face twice (once as the skin, once as a preset).
    const skinFace = skinFaceName(variable, variable === '--font-sans' ? tweaks.fontSans : tweaks.fontMono);
    return choices
      .filter((choice) => choice.value === '' || skinFace === null || choice.label !== skinFace)
      .map((choice) => ({
        value: choice.value,
        label: choice.label ?? (skinFace === null ? t('st.skin.fontSkin') : t('st.skin.fontSkinNamed', { face: skinFace })),
      }));
  };

  return (
    <div className="space-y-6" data-appearance-page data-skin-settings>
      <div className="space-y-2">
        <AppearancePreview />
        <div className={`flex-wrap items-center gap-x-3 gap-y-1 ${undo === null && atDefaults ? 'hidden' : 'flex min-h-8'}`} data-appearance-actions>
          {undo !== null ? (
            <>
              <span role="status" className="text-[12px] text-ink-soft">{t('st.appearance.restored')}</span>
              <button
                type="button"
                className="text-[12px] font-medium text-ink-soft underline-offset-2 hover:text-ink hover:underline"
                onClick={() => { writeAppearance(undo); setUndo(null); }}
              >
                {t('st.appearance.undo')}
              </button>
            </>
          ) : null}
          {!atDefaults ? (
            <button
              type="button"
              data-appearance-restore
              className={`${SECONDARY_BUTTON} ml-auto`}
              onClick={() => {
                const before = readAppearance();
                writeAppearance(defaultAppearanceFor(before));
                setUndo(before);
              }}
            >
              {t('st.appearance.restoreDefaults')}
            </button>
          ) : null}
        </div>
      </div>

      <SectionCard id="st-card-appearance" title={t('st.appearance.colorTitle')}>
        <div className="space-y-2">
          <SettingField label={t('st.appearance.theme')} labelId="theme-label">
            <SettingsSegmented<ThemePreference>
              ariaLabelledBy="theme-label"
              dataAttr="data-theme-choice"
              value={settings.theme}
              onChange={(choice) => { setLocal({ theme: choice }); }}
              choices={(['light', 'dark', 'system'] as ThemePreference[]).map((choice) => ({
                value: choice, label: t(`st.appearance.theme.${choice}`),
              }))}
            />
          </SettingField>
          <div className="space-y-2 py-1" data-settings-field>
            <div className="space-y-0.5">
              <span id="skin-label" className="text-[13px] text-ink">{t('st.skin.title')}</span>
              <p className="text-[12px] leading-4 text-ink-faint">{t('st.skin.hint')}</p>
            </div>
            <SkinPicker theme={theme} labelledBy="skin-label" />
          </div>
          <SettingField label={t('st.skin.accent')} htmlFor="skin-accent" help={t('st.skin.accentHint')}>
            <input
              id="skin-accent"
              type="color"
              value={tweaks.accent ?? readAccent()}
              onChange={(event) => { setTweak('accent', event.target.value); }}
              className="h-8 w-12 cursor-pointer rounded-md border border-hairline bg-paper p-0.5"
            />
            {tweaks.accent !== undefined ? (
              <button type="button" className={SECONDARY_BUTTON} onClick={() => { setTweak('accent', undefined); }}>
                {t('st.skin.accentReset')}
              </button>
            ) : null}
          </SettingField>
        </div>
      </SectionCard>

      <SectionCard id="st-card-appearance-background" title={t('st.bg.title')} scope="app">
        <div className="space-y-2">
          <Hint>{t('st.bg.hint')}</Hint>
          <BackgroundSettings theme={theme} />
        </div>
      </SectionCard>

      <SectionCard id="st-card-appearance-type" title={t('st.appearance.typeTitle')}>
        <div className="space-y-2">
          <FontRoleField
            role="sans"
            label={t('st.skin.font')}
            presets={fontPresets(FONT_CHOICES, '--font-sans')}
            presetValue={sans.preset}
            custom={sans.custom}
            fallback={SANS_FALLBACK}
            onPreset={(value) => { setTweak('fontSans', value === '' ? undefined : value); }}
            onCustom={(stack) => { setTweak('fontSans', stack); }}
          />
          <FontRoleField
            role="prose"
            label={t('st.appearance.prose')}
            help={t('st.appearance.proseHint')}
            presets={[
              { value: 'serif', label: t('st.appearance.prose.serif') },
              { value: 'sans', label: t('st.appearance.prose.sans') },
            ]}
            presetValue={settings.proseFont}
            custom={tweaks.fontProse}
            fallback={PROSE_FALLBACK}
            onPreset={(value) => { setLocal({ proseFont: value === 'sans' ? 'sans' : 'serif' }); }}
            onCustom={(stack) => { setTweak('fontProse', stack); }}
          />
          <FontRoleField
            role="mono"
            label={t('st.skin.fontMono')}
            presets={fontPresets(MONO_CHOICES, '--font-mono')}
            presetValue={mono.preset}
            custom={mono.custom}
            fallback={MONO_FALLBACK}
            onPreset={(value) => { setTweak('fontMono', value === '' ? undefined : value); }}
            onCustom={(stack) => { setTweak('fontMono', stack); }}
          />
        </div>
      </SectionCard>

      <SectionCard id="st-card-appearance-layout" title={t('st.appearance.layoutTitle')}>
        <div className="space-y-2">
          <SettingField label={t('st.skin.radius')} htmlFor="skin-radius">
            <input
              id="skin-radius"
              type="range"
              min={0}
              max={24}
              step={2}
              value={tweaks.radius ?? RADIUS_DEFAULT}
              onChange={(event) => {
                const next = Number(event.target.value);
                setTweak('radius', next === RADIUS_DEFAULT ? undefined : next);
              }}
              className="w-40 accent-[var(--color-selected-ink)]"
            />
            <span className="w-10 text-right text-[12px] text-ink-faint tabular-nums">{tweaks.radius ?? RADIUS_DEFAULT}px</span>
          </SettingField>
          <SettingField label={t('st.skin.density')} labelId="skin-density-label">
            <SettingsSegmented<'compact' | 'default' | 'roomy'>
              ariaLabelledBy="skin-density-label"
              value={densityOf(tweaks.spacing)}
              onChange={(value) => {
                setTweak('spacing', value === 'default' ? undefined : DENSITY_CHOICES.find((choice) => choice.value === value)?.rem);
              }}
              choices={[
                { value: 'compact', label: t('st.skin.densityCompact') },
                { value: 'default', label: t('st.skin.densityDefault') },
                { value: 'roomy', label: t('st.skin.densityRoomy') },
              ]}
            />
          </SettingField>
          <SettingField label={t('st.appearance.motion')} labelId="motion-label" help={t('st.appearance.motionHint')}>
            <SettingsSegmented<MotionPreference>
              ariaLabelledBy="motion-label"
              dataAttr="data-motion-choice"
              value={settings.motion}
              onChange={(choice) => { setLocal({ motion: choice }); }}
              choices={(['system', 'reduce', 'full'] as MotionPreference[]).map((choice) => ({
                value: choice, label: t(`st.appearance.motion.${choice}`),
              }))}
            />
          </SettingField>
        </div>
      </SectionCard>

      <SectionCard id="st-card-appearance-packs" title={t('st.pack.title')}>
        <AppearancePacks />
      </SectionCard>

      <SectionCard id="st-card-skin-files" title={t('st.skin.filesTitle')}>
        <SkinFiles />
      </SectionCard>
    </div>
  );
}
