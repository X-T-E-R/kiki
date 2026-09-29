/**
 * Skin picker and skin-file tools for Settings → Appearance.
 *
 * Everything here applies the moment it is chosen: a skin is reversible in one
 * click and the whole app is its own preview, so there is no draft to save.
 */

import { useMemo, useState, useSyncExternalStore } from 'react';

import type { SkinFile } from '@kiki/protocol';

import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import {
  BUILTIN_SKINS,
  DEFAULT_SKIN_ID,
  buildSkinExport,
  builtinSkinDescriptionKey,
  declaredVariants,
  getUserSkinsDirectory,
  packSkinOf,
  resolveSkin,
  skinPrefsServerSnapshot,
  skinPrefsSnapshot,
  subscribeSkinPrefs,
  writeSkinPrefs,
} from '../../lib/skins';
import { useAppearancePacks } from '../../lib/skins/useAppearancePacks';
import { useUserSkins } from '../../lib/skins/useUserSkins';
import type { ResolvedTheme } from '../../lib/theme';
import { FeedbackLine, Hint, type Feedback } from '../controls';
import { INPUT, SECONDARY_BUTTON } from '../ui';

export function useSkinPrefs() {
  return useSyncExternalStore(subscribeSkinPrefs, skinPrefsSnapshot, skinPrefsServerSnapshot);
}

/**
 * Paper (the default skin) carries no colors: it is the stylesheet palette in
 * src/index.css. Its own values live here, because the live tokens belong to
 * whichever skin is selected and would make Paper's swatch mirror that one.
 */
export const PAPER_SWATCH: Record<ResolvedTheme, { canvas: string; paper: string; panel: string; ink: string; accent: string }> = {
  light: { canvas: '#f0eadf', paper: '#f6f1e7', panel: '#fbf8f2', ink: '#1f1b16', accent: '#c2410c' },
  dark: { canvas: '#110e0a', paper: '#17140f', panel: '#1d1914', ink: '#efe8dc', accent: '#f08a4b' },
};

/** A swatch row rendered from the skin's own tokens, so it cannot lie. */
function SkinSwatch({ skin, theme }: { skin: SkinFile; theme: ResolvedTheme }) {
  const variant = skin.variants[theme] ?? skin.variants[declaredVariants(skin)[0] ?? 'light'];
  const colors = skin.id === DEFAULT_SKIN_ID ? PAPER_SWATCH[theme] : variant?.colors ?? {};
  const cells = [colors.canvas, colors.paper, colors.panel, colors.accent].map((value) => value ?? 'transparent');
  return (
    <span aria-hidden className="flex h-5 shrink-0 overflow-hidden rounded-[4px] ring-1 ring-hairline">
      {cells.map((color, index) => (
        <span key={index} className="h-full w-3" style={{ backgroundColor: color }} />
      ))}
    </span>
  );
}

export function SkinPicker({ theme, labelledBy }: { theme: ResolvedTheme; labelledBy: string }) {
  const { t } = useI18n();
  const userSkins = useUserSkins();
  const stored = useSkinPrefs();
  const packs = useAppearancePacks();
  // Built-ins first, then the themes folder, plugin themes, and pack colors.
  // A pack is only listed here for its colors; "Use pack" on the packs card
  // is what also sets its background.
  const options = useMemo(() => [
    ...BUILTIN_SKINS.map((skin) => ({ skin, source: 'builtin' as const })),
    ...userSkins.data.skins.map((skin) => ({ skin, source: 'user' as const })),
    ...packs.data.packs
      .map((entry) => packSkinOf(entry.pack))
      .filter((skin): skin is SkinFile => skin !== null)
      .map((skin) => ({ skin, source: 'pack' as const })),
  ], [userSkins.data.skins, packs.data.packs]);
  const originLabel = (source: 'builtin' | 'user' | 'pack', id: string | undefined) => {
    if (source === 'builtin') return t('st.skin.builtin');
    if (source === 'pack') return t('st.skin.pack');
    const plugin = id === undefined ? undefined : userSkins.data.plugins[id];
    return plugin !== undefined ? t('st.skin.plugin', { plugin: plugin.id }) : t('st.skin.user');
  };

  const activeSkin = resolveSkin(stored.selection);
  const activeVariants = activeSkin === null ? [] : declaredVariants(activeSkin);
  const singleVariantNotice = activeVariants.length === 1 && activeVariants[0] !== theme
    ? t(activeVariants[0] === 'dark' ? 'st.skin.activeDarkOnlyNotice' : 'st.skin.activeLightOnlyNotice')
    : null;

  return (
    <div className="space-y-2">
      {/* Rows stretch to the tallest card in their line, so a wrapped
          description never leaves a ragged grid. */}
      <ul className="grid gap-1 sm:grid-cols-2" aria-labelledby={labelledBy}>
        {options.map(({ skin, source }) => {
          const selected = stored.selection.source === source && stored.selection.id === skin.id;
          const variants = declaredVariants(skin);
          const only = variants.length === 1 ? t(variants[0] === 'dark' ? 'st.skin.darkOnly' : 'st.skin.lightOnly') : null;
          // Built-ins speak the UI language; a user skin shows its author's text.
          const descriptionKey = source === 'builtin' ? builtinSkinDescriptionKey(skin.id) : undefined;
          const description = descriptionKey !== undefined ? t(descriptionKey) : skin.description;
          return (
            <li key={`${source}:${skin.id}`} className="flex">
              <button
                type="button"
                aria-pressed={selected}
                data-skin-choice={skin.id}
                onClick={() => { writeSkinPrefs({ selection: { source, id: skin.id ?? '' } }); }}
                className={`flex min-h-[72px] w-full items-start gap-3 rounded-[10px] px-3 py-2.5 text-left transition-colors ${
                  selected
                    ? 'bg-panel shadow-[var(--kiki-sheet-shadow)]'
                    : 'hover:bg-ink/[0.04]'
                }`}
              >
                <SkinSwatch skin={skin} theme={theme} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-1.5">
                    <span className={`text-[13px] text-ink ${selected ? 'font-medium' : ''}`}>{skin.name}</span>
                    <span className="text-[12px] text-ink-faint">
                      {originLabel(source, skin.id)}
                      {only !== null ? ` · ${only}` : ''}
                    </span>
                  </span>
                  {description !== undefined ? (
                    <span data-skin-description className="mt-0.5 line-clamp-2 block text-[12px] leading-4 text-ink-soft" title={description}>
                      {description}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {singleVariantNotice !== null ? <p role="status" className="text-[12px] text-ink-soft">{singleVariantNotice}</p> : null}
      {stored.selection.source !== 'builtin' && activeSkin === null && !userSkins.isLoading && !packs.isLoading ? (
        <p role="status" className="text-[12px] text-amber-ink">{t('st.skin.missing')}</p>
      ) : null}
    </div>
  );
}

/** The themes folder a user skin is read from, plus export of the current look. */
export function SkinFiles() {
  const { t, tp } = useI18n();
  const host = useHost();
  const userSkins = useUserSkins();
  const stored = useSkinPrefs();
  const [exportName, setExportName] = useState('');
  const [feedback, setFeedback] = useState<Feedback>(null);
  const directory = userSkins.data.directory ?? getUserSkinsDirectory();

  const exportSkin = async () => {
    const { filename, json } = buildSkinExport(stored, exportName);
    const blob = new Blob([json], { type: 'application/json' });
    try {
      const saved = await host.saveBlob?.(blob, filename);
      if (saved === false) return;
      if (host.saveBlob === undefined) {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
        URL.revokeObjectURL(url);
      }
      setFeedback({ tone: 'success', text: t('st.skin.exportDone', { file: filename }) });
    } catch {
      setFeedback({ tone: 'error', text: t('st.skin.exportFailed') });
    }
  };

  return (
    <div className="space-y-5" data-skin-files>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[13px] font-medium text-ink">{t('st.skin.folder')}</span>
          <button type="button" className={SECONDARY_BUTTON} onClick={userSkins.refetch}>{t('st.skin.reload')}</button>
        </div>
        {userSkins.data.unsupported ? <Hint>{t('st.skin.unsupported')}</Hint> : (
          <>
            {directory !== null ? (
              <p className="break-all font-mono text-[12px] text-ink-soft" data-skin-directory>{directory}</p>
            ) : null}
            <Hint>
              {t('st.skin.folderHint')}
              {host.kind === 'browser' ? ` ${t('st.skin.remoteFolderHint')}` : ''}
            </Hint>
            {userSkins.data.skins.length === 0 ? <Hint>{t('st.skin.empty')}</Hint> : null}
            {userSkins.data.skipped.length > 0 ? (
              <details className="text-[12px] text-ink-soft">
                <summary className="cursor-pointer select-none hover:text-ink">{tp('st.skin.skipped', userSkins.data.skipped.length)}</summary>
                <ul className="mt-1 space-y-0.5 font-mono text-[12px] text-ink-faint">
                  {userSkins.data.skipped.map((entry) => <li key={entry.file}>{entry.file}: {entry.reason}</li>)}
                </ul>
              </details>
            ) : null}
          </>
        )}
      </div>
      <div className="space-y-2">
        <label htmlFor="skin-export-name" className="block text-[13px] font-medium text-ink">{t('st.skin.export')}</label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="skin-export-name"
            aria-label={t('st.skin.exportName')}
            placeholder={t('st.skin.exportName')}
            value={exportName}
            onChange={(event) => { setExportName(event.target.value); }}
            className={`${INPUT} max-w-[240px]`}
          />
          <button type="button" className={SECONDARY_BUTTON} onClick={() => void exportSkin()}>{t('st.skin.export')}</button>
        </div>
        <Hint>{t('st.skin.exportHint')}</Hint>
        <FeedbackLine feedback={feedback} />
      </div>
    </div>
  );
}
