/**
 * Settings → Appearance → Appearance packs: the installed packs with their
 * previews, and use / import / export / delete. Using a pack writes its
 * colors as the selected skin and its media as the background; both stay
 * ordinary prefs afterwards.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import {
  packBackgroundPrefs,
  packMediaId,
  packSkinOf,
  resolveBackdropMedia,
  setPackSkins,
  skinPrefsSnapshot,
  writeBackgroundPrefs,
  writeSkinPrefs,
} from '../../lib/skins';
import {
  AppearanceApiError,
  deleteAppearancePack,
  exportAppearancePack,
  installAppearancePack,
} from '../../lib/skins/packsApi';
import { useAppearancePacks, useServerEndpoint, type AppearancePackEntry } from '../../lib/skins/useAppearancePacks';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, type Feedback } from '../controls';
import { SECONDARY_BUTTON } from '../ui';
import { formatBytes, useBackgroundPrefs } from './BackgroundSettings';
import { useSkinPrefs } from './SkinSettings';

function PackPreview({ entry }: { entry: AppearancePackEntry }) {
  const [url, setUrl] = useState<string | null>(null);
  const file = entry.pack.preview ?? entry.pack.variants.light?.background?.poster ?? entry.pack.variants.dark?.background?.poster;
  useEffect(() => {
    if (file === undefined) return;
    let active = true;
    let objectUrl: string | null = null;
    void resolveBackdropMedia({ id: packMediaId(entry.pack.id, file), kind: 'image', mime: 'image/*', name: file, bytes: 0 }).then((blob) => {
      if (!active || blob === null) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => {
      active = false;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [entry.pack.id, file]);
  const accent = entry.pack.variants.light?.colors?.accent ?? entry.pack.variants.dark?.colors?.accent;
  return (
    <span aria-hidden className="relative block aspect-[16/10] w-full overflow-hidden rounded-[8px] bg-canvas ring-1 ring-hairline" data-pack-preview>
      {url !== null ? <img src={url} alt="" className="h-full w-full object-cover" /> : null}
      {accent !== undefined ? <span className="absolute bottom-2 left-2 h-3 w-3 rounded-full ring-2 ring-paper" style={{ backgroundColor: accent }} /> : null}
    </span>
  );
}

export function AppearancePacks() {
  const { t } = useI18n();
  const host = useHost();
  const endpoint = useServerEndpoint();
  const queryClient = useQueryClient();
  const catalog = useAppearancePacks();
  const skin = useSkinPrefs();
  const background = useBackgroundPrefs();
  const input = useRef<HTMLInputElement>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState(false);
  const [pendingReplace, setPendingReplace] = useState<{ file: File; id: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AppearancePackEntry | null>(null);

  const inUse = (id: string) => (skin.selection.source === 'pack' && skin.selection.id === id)
    || background.light?.packId === id || background.dark?.packId === id;

  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ['appearance-packs'] }); };

  const use = (entry: AppearancePackEntry) => {
    const colors = packSkinOf(entry.pack);
    if (colors !== null) {
      setPackSkins(catalog.data.packs.map((item) => packSkinOf(item.pack)).filter((item): item is NonNullable<typeof item> => item !== null));
      writeSkinPrefs({ selection: { source: 'pack', id: entry.pack.id } });
    }
    writeBackgroundPrefs(packBackgroundPrefs(entry.pack));
    setFeedback(null);
  };

  const install = async (file: File, replace: boolean) => {
    setBusy(true);
    setFeedback(null);
    try {
      const result = await installAppearancePack(endpoint, file, replace);
      setFeedback({ tone: 'success', text: t(result.replaced ? 'st.pack.replaced' : 'st.pack.imported', { name: result.pack.name }) });
      refresh();
    } catch (error) {
      if (error instanceof AppearanceApiError && error.code === 40919) {
        const id = /"([^"]+)"/.exec(error.message)?.[1] ?? '';
        setPendingReplace({ file, id });
        return;
      }
      setFeedback({ tone: 'error', text: t('st.pack.importFailed', { reason: error instanceof Error ? error.message : String(error) }) });
    } finally {
      setBusy(false);
    }
  };

  const exportPack = async (entry: AppearancePackEntry) => {
    const filename = `${entry.pack.id}.kiki-pack.zip`;
    try {
      const blob = await exportAppearancePack(endpoint, entry.pack.id);
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
      setFeedback({ tone: 'success', text: t('st.pack.exported', { file: filename }) });
    } catch (error) {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  };

  const remove = async (entry: AppearancePackEntry) => {
    try {
      await deleteAppearancePack(endpoint, entry.pack.id);
      // Drop both halves if this pack was in use, so nothing points at it.
      if (background.light?.packId === entry.pack.id || background.dark?.packId === entry.pack.id) {
        writeBackgroundPrefs({ light: null, dark: null, linked: true });
      }
      const selection = skinPrefsSnapshot().selection;
      if (selection.source === 'pack' && selection.id === entry.pack.id) writeSkinPrefs({ selection: { source: 'builtin', id: 'paper' } });
      setFeedback({ tone: 'success', text: t('st.pack.deleted', { name: entry.pack.name }) });
      refresh();
    } catch (error) {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  };

  if (catalog.data.unsupported) return <Hint>{t('st.pack.unsupported')}</Hint>;

  return (
    <div className="space-y-3" data-appearance-packs>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Hint>{t('st.pack.hint')}{host.kind === 'browser' ? ` ${t('st.pack.remoteHint')}` : ''}</Hint>
        <input
          ref={input}
          type="file"
          accept=".zip,application/zip"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          data-pack-file
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file !== undefined) void install(file, false);
          }}
        />
        <button type="button" className={SECONDARY_BUTTON} disabled={busy} data-pack-import onClick={() => { input.current?.click(); }}>
          {busy ? t('st.pack.importing') : t('st.pack.import')}
        </button>
      </div>
      <FeedbackLine feedback={feedback} />
      {catalog.data.packs.length === 0 && !catalog.isLoading ? <p className="text-[13px] text-ink-soft">{t('st.pack.empty')}</p> : null}
      <ul className="grid gap-3 sm:grid-cols-2">
        {catalog.data.packs.map((entry) => {
          const active = inUse(entry.pack.id);
          return (
            <li key={entry.pack.id} data-pack={entry.pack.id} className={`flex flex-col gap-2 rounded-[10px] p-2 ${active ? 'bg-panel shadow-[var(--kiki-sheet-shadow)]' : ''}`}>
              <PackPreview entry={entry} />
              <div className="min-w-0 px-1">
                <p className="flex flex-wrap items-baseline gap-x-1.5">
                  <span className="text-[13px] font-medium text-ink">{entry.pack.name}</span>
                  <span className="text-[12px] text-ink-faint">
                    {[
                      entry.summary.hasSkin ? t('st.pack.colors') : null,
                      entry.summary.hasVideo ? t('st.pack.video') : null,
                      formatBytes(entry.summary.bytes),
                    ].filter(Boolean).join(' · ')}
                  </span>
                </p>
                {entry.pack.description !== undefined ? <p className="mt-0.5 line-clamp-2 text-[12px] leading-4 text-ink-soft">{entry.pack.description}</p> : null}
                {entry.pack.author !== undefined || entry.pack.license !== undefined ? (
                  <p className="mt-0.5 truncate text-[12px] text-ink-faint">{[entry.pack.author, entry.pack.license].filter(Boolean).join(' · ')}</p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2 px-1 pb-1">
                <button type="button" className={SECONDARY_BUTTON} aria-pressed={active} disabled={active} data-pack-use={entry.pack.id} onClick={() => { use(entry); }}>
                  {active ? t('st.pack.inUse') : t('st.pack.use')}
                </button>
                <button type="button" className="rounded-md px-2 py-1.5 text-[12px] text-ink-soft hover:text-ink" onClick={() => void exportPack(entry)}>
                  {t('st.pack.export')}
                </button>
                <button type="button" className="ml-auto rounded-md px-2 py-1.5 text-[12px] text-danger hover:bg-danger/5" data-pack-delete={entry.pack.id} onClick={() => { setPendingDelete(entry); }}>
                  {t('st.pack.delete')}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <ConfirmDialog
        open={pendingReplace !== null}
        title={t('st.pack.exists', { id: pendingReplace?.id ?? '' })}
        confirmLabel={t('st.pack.replaceConfirm')}
        tone="default"
        overlayId="appearance-pack-replace"
        onConfirm={() => {
          const file = pendingReplace?.file;
          setPendingReplace(null);
          if (file !== undefined) void install(file, true);
        }}
        onCancel={() => { setPendingReplace(null); }}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('st.pack.deleteTitle', { name: pendingDelete?.pack.name ?? '' })}
        body={t('st.pack.deleteBody')}
        confirmLabel={t('st.pack.deleteConfirm')}
        overlayId="appearance-pack-delete"
        onConfirm={() => {
          const entry = pendingDelete;
          setPendingDelete(null);
          if (entry !== null) void remove(entry);
        }}
        onCancel={() => { setPendingDelete(null); }}
      />
    </div>
  );
}
