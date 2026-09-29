/**
 * Background controls: pick a picture or video (or a link), then dial how it
 * shows. Shared by Settings → Appearance (`full`) and the onboarding
 * appearance step (`compact`: pick + one strength slider). Every change
 * writes the real prefs; the app behind is the preview.
 */

import { useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import {
  APPEARANCE_LIMITS,
  BACKGROUND_ALIGNMENTS,
  type BackgroundAlignment,
  type BackgroundFit,
  type BackgroundLook,
  type BackgroundScope,
  DEFAULT_BACKGROUND_LOOK,
} from '@kiki/protocol';

import { useI18n } from '../../i18n';
import {
  backdropStatus,
  backgroundPrefsServerSnapshot,
  backgroundPrefsSnapshot,
  checkBackgroundFile,
  editKeyForTheme,
  isPersistent,
  pruneMedia,
  storeBackgroundFile,
  subscribeBackdropStatus,
  subscribeBackgroundPrefs,
  writeBackgroundPrefs,
  type BackgroundPrefs,
  type BackgroundSlot,
} from '../../lib/skins';
import { AppearanceApiError, importBackgroundUrl } from '../../lib/skins/packsApi';
import { useServerEndpoint } from '../../lib/skins/useAppearancePacks';
import { useMediaThumbnail } from '../../lib/skins/useMediaThumbnail';
import type { ResolvedTheme } from '../../lib/theme';
import { FeedbackLine, Toggle, type Feedback } from '../controls';
import { INPUT, SECONDARY_BUTTON } from '../ui';
import { SettingField } from './fields';
import { SettingsSegmented } from './SettingsPrimitives';

const ACCEPT = 'image/png,image/jpeg,image/webp,image/avif,image/gif,video/mp4,video/webm';

export function useBackgroundPrefs(): BackgroundPrefs {
  return useSyncExternalStore(subscribeBackgroundPrefs, backgroundPrefsSnapshot, backgroundPrefsServerSnapshot);
}

function useBackdropStatus() {
  return useSyncExternalStore(subscribeBackdropStatus, backdropStatus, backdropStatus);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function mediaIds(prefs: BackgroundPrefs): Set<string> {
  const ids = new Set<string>();
  for (const slot of [prefs.light, prefs.dark]) {
    for (const ref of slot?.media ?? []) ids.add(ref.id);
    if (slot?.poster !== undefined) ids.add(slot.poster.id);
  }
  return ids;
}

/**
 * Write a slot for the theme being edited. Stored media nothing points at is
 * dropped only when the media itself changed: a dial edit keeps every file, so
 * a slider drag never walks the media store.
 */
function writeSlot(prefs: BackgroundPrefs, theme: ResolvedTheme, slot: BackgroundSlot | null): void {
  const key = editKeyForTheme(prefs, theme);
  const next: BackgroundPrefs = { ...prefs, [key]: slot };
  const before = mediaIds(prefs);
  const after = mediaIds(next);
  writeBackgroundPrefs(next);
  if (before.size !== after.size || [...before].some((id) => !after.has(id))) void pruneMedia(after);
}

function Slider({ id, value, min, max, step, onChange, format }: {
  id: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format: (value: number) => string;
}) {
  return (
    <span className="flex items-center gap-2">
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => { onChange(Number(event.target.value)); }}
        className="w-40 accent-[var(--color-accent)]"
        aria-valuetext={format(value)}
      />
      <span className="w-11 text-right text-[12px] text-ink-faint tabular-nums">{format(value)}</span>
    </span>
  );
}

const percent = (value: number) => `${Math.round(value * 100)}%`;
const pixels = (value: number) => `${value}px`;
/** A 3×3 grid of anchor points, arrow-key navigable as one radio group. */
function AlignmentGrid({ value, onChange, labelledBy }: { value: BackgroundAlignment; onChange: (value: BackgroundAlignment) => void; labelledBy: string }) {
  const { t } = useI18n();
  const order: BackgroundAlignment[] = ['topLeft', 'top', 'topRight', 'left', 'center', 'right', 'bottomLeft', 'bottom', 'bottomRight'];
  const move = (from: BackgroundAlignment, key: string) => {
    const index = order.indexOf(from);
    const delta = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : key === 'ArrowDown' ? 3 : key === 'ArrowUp' ? -3 : 0;
    const next = order[index + delta];
    return delta === 0 || next === undefined ? null : next;
  };
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="grid w-[76px] grid-cols-3 gap-0.5 rounded-md bg-ink/[0.04] p-0.5" data-bg-alignment>
      {order.map((choice) => {
        const selected = choice === value;
        return (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={t(`st.bg.alignment.${choice}`)}
            title={t(`st.bg.alignment.${choice}`)}
            tabIndex={selected ? 0 : -1}
            data-bg-alignment-choice={choice}
            onClick={() => { onChange(choice); }}
            onKeyDown={(event) => {
              const next = move(choice, event.key);
              if (next === null) return;
              event.preventDefault();
              onChange(next);
              (event.currentTarget.parentElement?.querySelector(`[data-bg-alignment-choice="${next}"]`) as HTMLElement | null)?.focus();
            }}
            className="flex h-6 items-center justify-center rounded-[4px] hover:bg-panel focus-visible:outline-2 focus-visible:outline-accent"
          >
            <span className={`block rounded-full transition-all ${selected ? 'h-2 w-2 bg-accent' : 'h-1 w-1 bg-ink-faint'}`} />
          </button>
        );
      })}
    </div>
  );
}

/** The picked media as a small still, so the row says what is set. */
function MediaThumb({ slot }: { slot: BackgroundSlot }) {
  const ref = slot.poster ?? slot.media[0]!;
  const url = useMediaThumbnail(ref);
  return (
    <span className="relative flex h-12 w-20 shrink-0 items-center justify-center overflow-hidden rounded-md bg-canvas ring-1 ring-hairline" aria-hidden data-bg-thumb>
      {url === null ? null : ref.kind === 'video'
        ? <video src={url} muted playsInline preload="metadata" className="h-full w-full object-cover" />
        : <img src={url} alt="" className="h-full w-full object-cover" />}
      {slot.media[0]!.kind === 'video' ? (
        <span className="absolute right-1 bottom-1 rounded-[3px] bg-ink/70 px-1 text-[10px] leading-4 font-medium text-paper">▶</span>
      ) : null}
    </span>
  );
}

/** Picking, replacing and removing the media. */
function MediaPicker({ theme, slot, compact, onFeedback }: {
  theme: ResolvedTheme;
  slot: BackgroundSlot | null;
  compact: boolean;
  onFeedback: (feedback: Feedback) => void;
}) {
  const { t } = useI18n();
  const prefs = useBackgroundPrefs();
  const endpoint = useServerEndpoint();
  const input = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const adopt = async (file: Blob, name: string) => {
    // A File's name is a read-only getter; pass it alongside instead of on it.
    const check = await checkBackgroundFile(file, name);
    if (!check.ok) {
      onFeedback({
        tone: 'error',
        text: check.reason === 'size'
          ? t('st.bg.rejectSize', { image: formatBytes(APPEARANCE_LIMITS.imageBytes), video: formatBytes(APPEARANCE_LIMITS.videoBytes) })
          : t(check.reason === 'type' ? 'st.bg.rejectType' : 'st.bg.rejectContent'),
      });
      return;
    }
    const ref = await storeBackgroundFile(file, check, name);
    // A new picture keeps the dials the user already set, but not a pack's.
    const look = slot !== null && slot.packId === undefined ? slot.look : DEFAULT_BACKGROUND_LOOK;
    writeSlot(prefs, theme, { media: [ref], interval: 0, look });
    const notes: string[] = [];
    if (!(await isPersistent())) notes.push(t('st.bg.notPersistent'));
    if (check.kind === 'video' && file.size > APPEARANCE_LIMITS.videoWarnBytes) notes.push(t('st.bg.largeVideo', { size: formatBytes(file.size) }));
    onFeedback(notes.length > 0 ? { tone: 'info', text: notes.join(' ') } : null);
  };

  const importUrl = async () => {
    const target = url.trim();
    if (target === '') return;
    setBusy(true);
    onFeedback(null);
    try {
      const { blob, name } = await importBackgroundUrl(endpoint, target);
      await adopt(blob, name);
      setUrl('');
    } catch (error) {
      onFeedback({
        tone: 'error',
        text: error instanceof AppearanceApiError && error.message === 'unsupported'
          ? t('st.bg.urlUnsupported')
          : t('st.bg.urlFailed', { reason: error instanceof Error ? error.message : String(error) }),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2" data-bg-picker>
      <div className="flex flex-wrap items-center gap-3">
        {slot !== null ? <MediaThumb slot={slot} /> : null}
        <div className="min-w-[8rem] flex-1">
          {slot !== null ? (
            <p className="truncate text-[13px] text-ink" data-bg-current title={slot.media[0]!.name}>{slot.media[0]!.name}</p>
          ) : (
            <p className="text-[13px] text-ink-soft">{t('st.bg.none')}</p>
          )}
        </div>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          data-bg-file
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file !== undefined) void adopt(file, file.name);
          }}
        />
        {/* The actions wrap as one group, so on a phone the file name keeps the row. */}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={SECONDARY_BUTTON} data-bg-choose onClick={() => { input.current?.click(); }}>
            {slot === null ? t('st.bg.chooseFile') : t('st.bg.replaceFile')}
          </button>
          {slot !== null ? (
            <button type="button" className={SECONDARY_BUTTON} data-bg-remove onClick={() => { writeSlot(prefs, theme, null); onFeedback(null); }}>
              {t('st.bg.remove')}
            </button>
          ) : null}
        </div>
      </div>
      {!compact ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => { event.preventDefault(); void importUrl(); }}
        >
          <label htmlFor="bg-url" className="text-[12px] text-ink-soft">{t('st.bg.fromUrl')}</label>
          <input
            id="bg-url"
            type="url"
            inputMode="url"
            value={url}
            placeholder={t('st.bg.urlPlaceholder')}
            onChange={(event) => { setUrl(event.target.value); }}
            className={`${INPUT} min-w-0 max-w-[320px] flex-1`}
          />
          <button type="submit" className={SECONDARY_BUTTON} disabled={busy || url.trim() === ''}>
            {busy ? t('st.bg.importing') : t('st.bg.useUrl')}
          </button>
        </form>
      ) : null}
    </div>
  );
}
/**
 * The background card body. `compact` is the onboarding variant: pick a
 * picture, one strength slider, nothing else.
 */
export function BackgroundSettings({ theme, compact = false }: { theme: ResolvedTheme; compact?: boolean }) {
  const { t } = useI18n();
  const prefs = useBackgroundPrefs();
  const status = useBackdropStatus();
  const [feedback, setFeedback] = useState<Feedback>(null);
  const slot = prefs[editKeyForTheme(prefs, theme)] ?? (prefs.linked ? prefs.dark : null);
  const look = slot?.look ?? DEFAULT_BACKGROUND_LOOK;

  const setLook = <K extends keyof BackgroundLook>(key: K, value: Required<BackgroundLook>[K]) => {
    if (slot === null) return;
    writeSlot(prefs, theme, { ...slot, look: { ...slot.look, [key]: value } });
  };

  const notes: ReactNode[] = [];
  if (slot !== null && status.missing) notes.push(<p key="missing" role="status" className="text-[12px] text-amber-ink">{t('st.bg.missing')}</p>);
  if (slot !== null && status.heavyVideo) notes.push(<p key="heavy" role="status" className="text-[12px] text-amber-ink">{t('st.bg.heavyVideo')}</p>);
  if (slot !== null && status.paused !== null) {
    notes.push(<p key="paused" role="status" className="text-[12px] text-ink-soft">{t(status.paused === 'motion' ? 'st.bg.pausedMotion' : 'st.bg.pausedPower')}</p>);
  }

  const strength = (
    <SettingField label={t('st.bg.opacity')} htmlFor={compact ? 'onboarding-bg-opacity' : 'bg-opacity'}>
      <Slider id={compact ? 'onboarding-bg-opacity' : 'bg-opacity'} value={look.opacity} min={0.1} max={1} step={0.05} format={percent} onChange={(value) => { setLook('opacity', value); }} />
    </SettingField>
  );

  if (compact) {
    return (
      <div className="space-y-2" data-bg-settings="compact">
        <MediaPicker theme={theme} slot={slot} compact onFeedback={setFeedback} />
        {slot !== null ? strength : null}
        {notes}
        <FeedbackLine feedback={feedback} />
      </div>
    );
  }

  const raised = prefs.assist && status.textAlpha !== null && status.surfaceAlpha !== null && slot !== null && status.textAlpha > status.surfaceAlpha + 0.005;
  const surfaceHelp = prefs.assist && raised ? t('st.bg.surfaceRaised') : t('st.bg.surfaceHint');

  return (
    <div className="space-y-2" data-bg-settings="full">
      <MediaPicker theme={theme} slot={slot} compact={false} onFeedback={setFeedback} />
      <FeedbackLine feedback={feedback} />
      {notes}
      {slot?.packId !== undefined ? <p className="text-[12px] text-ink-faint">{t('st.bg.fromPack', { name: slot.packId })}</p> : null}
      <Toggle
        layout="row"
        label={t('st.bg.perTheme')}
        checked={!prefs.linked}
        onChange={(separate) => {
          // Splitting copies the shared background into both slots, so
          // nothing visibly changes until the user edits one of them.
          writeBackgroundPrefs(separate
            ? { light: prefs.light ?? prefs.dark, dark: prefs.light ?? prefs.dark, linked: false }
            : { light: prefs[theme] ?? prefs.light ?? prefs.dark, dark: null, linked: true });
        }}
      />
      {!prefs.linked ? <p className="text-[12px] text-ink-faint">{t('st.bg.perThemeHint', { theme: t(`st.appearance.theme.${theme}`) })}</p> : null}
      {slot !== null ? (
        <>
          <SettingField label={t('st.bg.scope')} labelId="bg-scope-label" help={look.scope === 'sidebar' ? t('st.bg.scopeHint') : undefined}>
            <SettingsSegmented<BackgroundScope>
              ariaLabelledBy="bg-scope-label"
              dataAttr="data-bg-scope"
              value={look.scope}
              onChange={(value) => { setLook('scope', value); }}
              choices={(['window', 'main', 'sidebar'] as const).map((value) => ({ value, label: t(`st.bg.scope.${value}`) }))}
            />
          </SettingField>
          <SettingField label={t('st.bg.fit')} labelId="bg-fit-label">
            <SettingsSegmented<BackgroundFit>
              ariaLabelledBy="bg-fit-label"
              dataAttr="data-bg-fit"
              value={look.fit}
              onChange={(value) => { setLook('fit', value); }}
              choices={(['cover', 'contain', 'tile', 'center'] as const).map((value) => ({ value, label: t(`st.bg.fit.${value}`) }))}
            />
          </SettingField>
          {strength}
          <SettingField label={t('st.bg.surface')} htmlFor="bg-surface" help={surfaceHelp}>
            <Slider id="bg-surface" value={look.surfaceOpacity} min={0.3} max={1} step={0.02} format={percent} onChange={(value) => { setLook('surfaceOpacity', value); }} />
          </SettingField>
          <div className="space-y-0.5" data-bg-assist>
            <Toggle
              layout="row"
              label={t('st.bg.assist')}
              checked={prefs.assist}
              onChange={(assist) => { writeBackgroundPrefs({ ...prefs, assist }); }}
            />
            <p className={`text-[12px] leading-4 ${prefs.assist ? 'text-ink-faint' : 'text-amber-ink'}`}>
              {prefs.assist ? t('st.bg.assistHint') : t('st.bg.assistOff')}
            </p>
          </div>
          <details className="group" data-bg-more>
            <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 text-[13px] text-ink-soft select-none hover:text-ink">
              <span aria-hidden className="inline-block transition-transform group-open:rotate-90">›</span>
              {t('st.bg.more')}
            </summary>
            <div className="space-y-2 pt-1">
              <SettingField label={t('st.bg.alignment')} labelId="bg-alignment-label">
                <AlignmentGrid labelledBy="bg-alignment-label" value={BACKGROUND_ALIGNMENTS.includes(look.alignment) ? look.alignment : 'center'} onChange={(value) => { setLook('alignment', value); }} />
              </SettingField>
              <SettingField label={t('st.bg.blur')} htmlFor="bg-blur">
                <Slider id="bg-blur" value={look.blur} min={0} max={40} step={1} format={pixels} onChange={(value) => { setLook('blur', value); }} />
              </SettingField>
              <SettingField label={t('st.bg.brightness')} htmlFor="bg-brightness">
                <Slider id="bg-brightness" value={look.brightness} min={0.4} max={1.4} step={0.05} format={percent} onChange={(value) => { setLook('brightness', value); }} />
              </SettingField>
              <SettingField label={t('st.bg.scrim')} htmlFor="bg-scrim" help={t('st.bg.scrimHint')}>
                <Slider id="bg-scrim" value={look.scrim} min={0} max={0.9} step={0.05} format={percent} onChange={(value) => { setLook('scrim', value); }} />
              </SettingField>
              <SettingField label={t('st.bg.surfaceBlur')} htmlFor="bg-surface-blur">
                <Slider id="bg-surface-blur" value={look.surfaceBlur} min={0} max={32} step={1} format={pixels} onChange={(value) => { setLook('surfaceBlur', value); }} />
              </SettingField>
            </div>
          </details>
        </>
      ) : null}
    </div>
  );
}
