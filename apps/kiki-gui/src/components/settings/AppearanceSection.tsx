import { useState, useSyncExternalStore } from 'react';

import {
  CHAT_WIDTH_CHOICES,
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_PROSE_FONT_SIZE,
  DEFAULT_UI_ZOOM,
  MAX_CODE_FONT_SIZE,
  MAX_PROSE_FONT_SIZE,
  MAX_UI_ZOOM,
  MIN_CODE_FONT_SIZE,
  MIN_PROSE_FONT_SIZE,
  MIN_UI_ZOOM,
  settingsServerSnapshot,
  settingsSnapshot,
  stepCodeFontSize,
  stepProseFontSize,
  stepUiZoom,
  subscribeSettings,
  writeSettings,
  type ChatWidthPreference,
  type MotionPreference,
  type ThemePreference,
} from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { spaceSettingsTargetIsSpace, spaceSettingsTargetOf } from '../../lib/spaceSettings';
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
import { Icon } from '../icons';
import { SECONDARY_BUTTON } from '../ui';
import { AppearancePacks } from './AppearancePacks';
import { BackgroundSettings, useBackgroundPrefs } from './BackgroundSettings';
import { SectionCard } from './SectionCard';
import { SettingField, SettingsBox, SettingsGroup } from './fields';
import { FontRoleField } from './FontRoleField';
import { firstFamily } from '../../lib/fontDetect';
import { SettingsSegmented } from './SettingsPrimitives';
import { SkinFiles, SkinPicker, useSkinPrefs } from './SkinSettings';
import { SpacePrefOrigin } from './spaces/SpacePrefOrigin';
import { useConnection } from '../../state/connection';

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

const STEPPER_BTN =
  'flex h-7 w-7 items-center justify-center rounded-[5px] text-ink-soft transition-colors hover:bg-panel hover:text-ink disabled:cursor-not-allowed disabled:text-ink-faint disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink';

function ScaleStepper({
  prefix,
  labelId,
  valueText,
  canStepOut,
  canStepIn,
  isModified,
  outAria,
  inAria,
  resetLabel,
  deviceBadge,
  onStepOut,
  onStepIn,
  onReset,
}: {
  prefix: 'ui-zoom' | 'prose-size' | 'code-size';
  labelId: string;
  valueText: string;
  canStepOut: boolean;
  canStepIn: boolean;
  isModified: boolean;
  outAria: string;
  inAria: string;
  resetLabel: string;
  deviceBadge: string | undefined;
  onStepOut: () => void;
  onStepIn: () => void;
  onReset: () => void;
}) {
  return (
    <>
      <div
        role="group"
        aria-labelledby={labelId}
        {...{ [`data-${prefix}-control`]: '' }}
        className="inline-flex items-center gap-0.5 rounded-md bg-ink/[0.04] p-0.5"
      >
        <button
          type="button"
          {...{ [`data-${prefix}-out`]: '' }}
          aria-label={outAria}
          disabled={!canStepOut}
          onClick={onStepOut}
          className={STEPPER_BTN}
        >
          <Icon name="dash" size={14} />
        </button>
        <span
          {...{ [`data-${prefix}-value`]: '' }}
          aria-live="polite"
          className="min-w-[3.75rem] px-2 text-center text-[13px] font-medium tabular-nums text-ink select-none"
        >
          {valueText}
        </span>
        <button
          type="button"
          {...{ [`data-${prefix}-in`]: '' }}
          aria-label={inAria}
          disabled={!canStepIn}
          onClick={onStepIn}
          className={STEPPER_BTN}
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
      {isModified ? (
        <button
          type="button"
          {...{ [`data-${prefix}-reset`]: '' }}
          className={SECONDARY_BUTTON}
          onClick={onReset}
        >
          {resetLabel}
        </button>
      ) : null}
      {deviceBadge !== undefined ? <span className="text-[12px] text-ink-faint">{deviceBadge}</span> : null}
    </>
  );
}

/**
 * Settings → Appearance. Every control applies the moment it changes, so the
 * app itself is the feedback; there is no draft to save. The first choice is
 * the theme and the skin tiles — the page's protagonist. The one page-level
 * action is "Restore defaults", which keeps an undo; it is only there once
 * something is customized (the theme choice does not count).
 */
export function AppearanceSection() {
  const { t } = useI18n();
  const settings = useSyncExternalStore(subscribeSettings, settingsSnapshot, settingsServerSnapshot);
  const { client, meta, connectionId } = useConnection();
  const inPairedSpace = typeof connectionId === 'string' && connectionId !== '';
  const spaceTarget = spaceSettingsTargetOf(client, meta);
  const appearanceScope = !inPairedSpace && spaceSettingsTargetIsSpace(spaceTarget) ? 'space' : 'app';
  const inSpace = appearanceScope === 'space';
  const deviceBadge = inSpace ? t('st.scope.device') : undefined;
  const skinPrefs = useSkinPrefs();
  const tweaks = skinPrefs.tweaks;
  const [undo, setUndo] = useState<AppearanceSnapshot | null>(null);
  const theme = resolveTheme(settings.theme, prefersDark());

  const setTweak = <K extends keyof SkinTweaks>(key: K, value: SkinTweaks[K] | undefined) => {
    const { [key]: _drop, ...rest } = tweaks;
    writeSkinPrefs({ tweaks: value === undefined ? rest : { ...rest, [key]: value } });
    setUndo(null);
  };
  const setLocal = (
    patch: Partial<Pick<AppearanceSnapshot, 'theme' | 'motion' | 'proseFont' | 'proseFontSize' | 'codeFontSize' | 'chatWidth' | 'uiZoom'>>,
  ) => {
    writeSettings(patch);
    setUndo(null);
  };

  const background = useBackgroundPrefs();
  const current: AppearanceSnapshot = {
    theme: settings.theme,
    motion: settings.motion,
    proseFont: settings.proseFont,
    proseFontSize: settings.proseFontSize,
    codeFontSize: settings.codeFontSize,
    chatWidth: settings.chatWidth,
    uiZoom: settings.uiZoom,
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
      <SectionCard
        id="st-card-appearance"
        title={t('st.appearance.colorTitle')}
        scope={appearanceScope}
        actions={(
          <div className={`flex-wrap items-center gap-x-3 gap-y-1 ${undo === null && atDefaults ? 'hidden' : 'flex'}`} data-appearance-actions>
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
                className={SECONDARY_BUTTON}
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
        )}
      >
        <SettingsBox>
          <SettingField label={t('st.appearance.theme')} labelId="theme-label">
            <SpacePrefOrigin item="theme" label={t('st.appearance.theme')} />
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
            <span id="skin-label" className="block text-[13px] text-ink">{t('st.skin.title')}</span>
            <SpacePrefOrigin item="skin" label={t('st.skin.title')} />
            <SkinPicker theme={theme} labelledBy="skin-label" />
          </div>
        </SettingsBox>
      </SectionCard>

      <SectionCard id="st-card-appearance-layout" title={t('st.appearance.layoutTitle')} scope={appearanceScope}>
        <SettingsBox>
          <SettingField label={t('st.skin.accent')} htmlFor="skin-accent" help={t('st.skin.accentHint')}>
            <SpacePrefOrigin item="tweaks" label={t('st.skin.accent')} />
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
            {inSpace ? <span className="text-[12px] text-ink-faint">{t('st.scope.device')}</span> : null}
          </SettingField>
        </SettingsBox>
      </SectionCard>

      {inPairedSpace ? null : (
        <SectionCard id="st-card-appearance-background" title={t('st.bg.title')} scope={appearanceScope}>
          <div className="space-y-2">
            <Hint>{t('st.bg.hint')}</Hint>
            <SpacePrefOrigin item="background" label={t('st.bg.title')} />
            <BackgroundSettings theme={theme} />
          </div>
        </SectionCard>
      )}

      <SectionCard id="st-card-appearance-type" title={t('st.appearance.typeTitle')} scope={appearanceScope}>
        <div>
          <SettingsGroup title={t('st.appearance.scaleGroup')}>
            <SettingField label={t('st.appearance.zoom')} labelId="ui-zoom-label" help={t('st.appearance.zoomHint')}>
              <ScaleStepper
                prefix="ui-zoom"
                labelId="ui-zoom-label"
                valueText={`${settings.uiZoom}%`}
                canStepOut={settings.uiZoom > MIN_UI_ZOOM}
                canStepIn={settings.uiZoom < MAX_UI_ZOOM}
                isModified={settings.uiZoom !== DEFAULT_UI_ZOOM}
                outAria={t('st.appearance.zoomOutAria')}
                inAria={t('st.appearance.zoomInAria')}
                resetLabel={t('st.appearance.zoomReset')}
                deviceBadge={deviceBadge}
                onStepOut={() => { setLocal({ uiZoom: stepUiZoom(settings.uiZoom, -1) }); }}
                onStepIn={() => { setLocal({ uiZoom: stepUiZoom(settings.uiZoom, 1) }); }}
                onReset={() => { setLocal({ uiZoom: DEFAULT_UI_ZOOM }); }}
              />
            </SettingField>
            <SettingField label={t('st.appearance.proseSize')} labelId="prose-size-label" help={t('st.appearance.proseSizeHint')}>
              <ScaleStepper
                prefix="prose-size"
                labelId="prose-size-label"
                valueText={`${settings.proseFontSize}px`}
                canStepOut={settings.proseFontSize > MIN_PROSE_FONT_SIZE}
                canStepIn={settings.proseFontSize < MAX_PROSE_FONT_SIZE}
                isModified={settings.proseFontSize !== DEFAULT_PROSE_FONT_SIZE}
                outAria={t('st.appearance.proseSizeOutAria')}
                inAria={t('st.appearance.proseSizeInAria')}
                resetLabel={t('st.appearance.zoomReset')}
                deviceBadge={deviceBadge}
                onStepOut={() => { setLocal({ proseFontSize: stepProseFontSize(settings.proseFontSize, -1) }); }}
                onStepIn={() => { setLocal({ proseFontSize: stepProseFontSize(settings.proseFontSize, 1) }); }}
                onReset={() => { setLocal({ proseFontSize: DEFAULT_PROSE_FONT_SIZE }); }}
              />
            </SettingField>
            <SettingField label={t('st.appearance.codeSize')} labelId="code-size-label" help={t('st.appearance.codeSizeHint')}>
              <ScaleStepper
                prefix="code-size"
                labelId="code-size-label"
                valueText={`${settings.codeFontSize}px`}
                canStepOut={settings.codeFontSize > MIN_CODE_FONT_SIZE}
                canStepIn={settings.codeFontSize < MAX_CODE_FONT_SIZE}
                isModified={settings.codeFontSize !== DEFAULT_CODE_FONT_SIZE}
                outAria={t('st.appearance.codeSizeOutAria')}
                inAria={t('st.appearance.codeSizeInAria')}
                resetLabel={t('st.appearance.zoomReset')}
                deviceBadge={deviceBadge}
                onStepOut={() => { setLocal({ codeFontSize: stepCodeFontSize(settings.codeFontSize, -1) }); }}
                onStepIn={() => { setLocal({ codeFontSize: stepCodeFontSize(settings.codeFontSize, 1) }); }}
                onReset={() => { setLocal({ codeFontSize: DEFAULT_CODE_FONT_SIZE }); }}
              />
            </SettingField>
            <SettingField label={t('st.appearance.chatWidth')} labelId="chat-width-label">
              <SettingsSegmented<ChatWidthPreference>
                ariaLabelledBy="chat-width-label"
                dataAttr="data-chat-width-choice"
                value={settings.chatWidth}
                onChange={(choice) => { setLocal({ chatWidth: choice }); }}
                choices={CHAT_WIDTH_CHOICES.map((choice) => ({
                  value: choice, label: t(`st.appearance.chatWidth.${choice}`),
                }))}
              />
              {deviceBadge !== undefined ? <span className="text-[12px] text-ink-faint">{deviceBadge}</span> : null}
            </SettingField>
          </SettingsGroup>
          <SettingsGroup title={t('st.appearance.fontGroup')}>
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
              note={<SpacePrefOrigin item="proseFont" label={t('st.appearance.prose')} />}
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
          </SettingsGroup>
        </div>
      </SectionCard>

      {inPairedSpace ? null : (
        <SectionCard id="st-card-skin-files" title={t('st.skin.filesTitle')} scope={appearanceScope}>
          <div className="space-y-6">
            <AppearancePacks />
            <div className="pt-5">
              <SkinFiles />
            </div>
          </div>
        </SectionCard>
      )}
    </div>
  );
}
