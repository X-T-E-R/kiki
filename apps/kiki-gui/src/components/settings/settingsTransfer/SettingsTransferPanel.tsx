import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  SETTINGS_TRANSFER_CATEGORIES,
  SETTINGS_TRANSFER_MAX_BYTES,
  type SettingsTransferApplyResult,
  type SettingsTransferCatalog,
  type SettingsTransferCategory,
  type SettingsTransferCategorySummary,
  type SettingsTransferMode,
  type SettingsTransferPackage,
  type SettingsTransferPreview,
} from '@kiki/protocol';
import {
  applyLocalSettingsTransferPreferences,
  attachLocalSettingsTransferPreferences,
  parseSettingsTransferPackage,
  settingsTransferPackageWithinLimit,
  withLocalSettingsTransferCatalog,
  withLocalSettingsTransferPreview,
  type LocalSettingsTransferApplyResult,
} from '@kiki/session-core/settings';
import type { I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../../i18n';
import { useConnection } from '../../../state/connection';
import { useHost } from '../../../host';
import { browserAnchorSaveSink, browserSaveSink, bufferedSaveSink } from '../../../host/saveSink';
import { getSettingsTransferClient, type SettingsTransferClient } from '../../../lib/settingsTransferClient';
import { SidePanel } from '../../SidePanel';
import { FeedbackLine, Hint, type Feedback } from '../../controls';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';

const CATEGORY_LABEL_KEYS: Record<SettingsTransferCategory, I18nKey> = {
  models: 'st.settingsTransfer.category.models',
  agents: 'st.settingsTransfer.category.agents',
  permissions: 'st.settingsTransfer.category.permissions',
  tools: 'st.settingsTransfer.category.tools',
  browser: 'st.settingsTransfer.category.browser',
  notifications: 'st.settingsTransfer.category.notifications',
  appearance: 'st.settingsTransfer.category.appearance',
};

const NOTICE_KEYS: Record<SettingsTransferCatalog['notices'][number], I18nKey> = {
  localScope: 'st.settingsTransfer.notice.localScope',
  externalLogins: 'st.settingsTransfer.notice.externalLogins',
  localPaths: 'st.settingsTransfer.notice.localPaths',
  omittedCredentials: 'st.settingsTransfer.notice.omittedCredentials',
  omittedBrowserConnections: 'st.settingsTransfer.notice.omittedBrowserConnections',
  pluginCode: 'st.settingsTransfer.notice.pluginCode',
  profileScope: 'st.settingsTransfer.notice.profileScope',
};

const FAILURE_KEYS: Record<NonNullable<SettingsTransferApplyResult['failure']>, I18nKey> = {
  changed: 'st.settingsTransfer.failure.changed',
  expired: 'st.settingsTransfer.failure.expired',
  writeFailed: 'st.settingsTransfer.failure.writeFailed',
  readbackFailed: 'st.settingsTransfer.failure.readbackFailed',
};

const ITEM_STATUS_KEYS: Record<SettingsTransferApplyResult['items'][number]['status'], I18nKey> = {
  applied: 'st.settingsTransfer.itemStatus.applied',
  unchanged: 'st.settingsTransfer.itemStatus.unchanged',
  failed: 'st.settingsTransfer.itemStatus.failed',
  unverified: 'st.settingsTransfer.itemStatus.unverified',
};

type TransferTab = 'export' | 'import';
type TransferFeedback = Feedback;

type ApplyDisplay = {
  readonly result: SettingsTransferApplyResult;
  readonly local: LocalSettingsTransferApplyResult | null;
};

function categorySummary(catalog: SettingsTransferCatalog | null, category: SettingsTransferCategory): SettingsTransferCategorySummary | undefined {
  return catalog?.categories.find((entry) => entry.id === category);
}

function selectedCategoriesFromBundle(bundle: SettingsTransferPackage): SettingsTransferCategory[] {
  return SETTINGS_TRANSFER_CATEGORIES.filter((category) => bundle.categories.includes(category));
}

function transferFilename(): string {
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  return `kiki-settings-${stamp}.json`;
}

async function savePackage(host: ReturnType<typeof useHost>, bundle: SettingsTransferPackage): Promise<boolean> {
  const filename = transferFilename();
  const bytes = new TextEncoder().encode(JSON.stringify(bundle, null, 2));
  if (bytes.byteLength > SETTINGS_TRANSFER_MAX_BYTES) throw new Error('settings package exceeds the size limit');
  const sink = host.kind === 'browser'
    ? browserAnchorSaveSink(filename)
    : host.openSaveSink !== undefined
      ? await host.openSaveSink(filename)
      : host.saveBlob !== undefined
        ? bufferedSaveSink((blob) => host.saveBlob!(blob, filename))
        : await browserSaveSink(filename);
  if (sink === null) return false;
  try {
    await sink.write(bytes);
    return await sink.close();
  } catch (error) {
    await sink.abort().catch(() => undefined);
    throw error;
  }
}

export function SettingsTransferPanel({
  categories,
  onClose,
}: {
  readonly categories: readonly SettingsTransferCategory[];
  readonly onClose: () => void;
}) {
  const { klient } = useConnection();
  const host = useHost();
  const { t, setLocale } = useI18n();
  const api = useMemo<SettingsTransferClient>(() => getSettingsTransferClient(klient), [klient]);
  const [tab, setTab] = useState<TransferTab>('export');
  const [catalog, setCatalog] = useState<SettingsTransferCatalog | null>(null);
  const [catalogState, setCatalogState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [catalogRetry, setCatalogRetry] = useState(0);
  const [exportCategories, setExportCategories] = useState<SettingsTransferCategory[]>([...categories]);
  const [exportCredentials, setExportCredentials] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportFeedback, setExportFeedback] = useState<TransferFeedback>(null);
  const [bundle, setBundle] = useState<SettingsTransferPackage | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [importCategories, setImportCategories] = useState<SettingsTransferCategory[]>([]);
  const [importCredentials, setImportCredentials] = useState(false);
  const [mode, setMode] = useState<SettingsTransferMode>('append');
  const [preview, setPreview] = useState<SettingsTransferPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewFeedback, setPreviewFeedback] = useState<TransferFeedback>(null);
  const [applying, setApplying] = useState(false);
  const [applyDisplay, setApplyDisplay] = useState<ApplyDisplay | null>(null);
  const [previewRetry, setPreviewRetry] = useState(0);
  const previewIdRef = useRef<string | null>(null);
  const previewSequenceRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const cancelServerPreview = useCallback(async (id: string | null): Promise<void> => {
    if (id === null) return;
    try { await api.cancel({ previewId: id }); } catch { /* The preview is already discarded locally. */ }
  }, [api]);

  const loadCatalog = useCallback(async (): Promise<void> => {
    setCatalogState('loading');
    try {
      const next = await api.catalog();
      setCatalog(withLocalSettingsTransferCatalog(next));
      setCatalogState('ready');
    } catch {
      setCatalogState('error');
    }
  }, [api]);

  useEffect(() => { void loadCatalog(); }, [loadCatalog, catalogRetry]);

  useEffect(() => {
    return () => {
      previewSequenceRef.current += 1;
      const id = previewIdRef.current;
      previewIdRef.current = null;
      void cancelServerPreview(id);
    };
  }, [cancelServerPreview]);

  useEffect(() => {
    const sequence = previewSequenceRef.current + 1;
    previewSequenceRef.current = sequence;
    const oldId = previewIdRef.current;
    previewIdRef.current = null;
    setPreview(null);
    setApplyDisplay(null);
    void cancelServerPreview(oldId);
    if (bundle === null || importCategories.length === 0) {
      if (bundle !== null && importCategories.length === 0) setPreviewFeedback({ tone: 'info', text: t('st.settingsTransfer.noCategories') });
      setPreviewing(false);
      return;
    }
    setPreviewFeedback(null);
    setPreviewing(true);
    void api.preview({
      bundle,
      categories: importCategories,
      mode,
      includeCredentials: importCredentials,
    }).then((next) => {
      if (previewSequenceRef.current !== sequence) {
        void cancelServerPreview(next.previewId);
        return;
      }
      previewIdRef.current = next.previewId;
      setPreview(withLocalSettingsTransferPreview(next, bundle, importCategories, mode));
      setPreviewing(false);
    }).catch(() => {
      if (previewSequenceRef.current !== sequence) return;
      setPreviewing(false);
      setPreviewFeedback({ tone: 'error', text: t('st.settingsTransfer.previewFailed') });
    });
  }, [api, bundle, importCategories, importCredentials, mode, cancelServerPreview, previewRetry, t]);

  const updateCategories = (current: readonly SettingsTransferCategory[], category: SettingsTransferCategory, checked: boolean): SettingsTransferCategory[] => {
    if (checked) return current.includes(category) ? [...current] : [...current, category];
    return current.filter((entry) => entry !== category);
  };

  const chooseFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    previewSequenceRef.current += 1;
    const oldId = previewIdRef.current;
    previewIdRef.current = null;
    await cancelServerPreview(oldId);
    setPreview(null);
    setApplyDisplay(null);
    setPreviewFeedback(null);
    setBundle(null);
    setFileName(file.name);
    setImportCategories([]);
    setImportCredentials(false);
    if (file.size > SETTINGS_TRANSFER_MAX_BYTES) {
      setPreviewFeedback({ tone: 'error', text: t('st.settingsTransfer.fileTooLarge') });
      return;
    }
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const next = parseSettingsTransferPackage(parsed);
      if (next === undefined) {
        setPreviewFeedback({ tone: 'error', text: t('st.settingsTransfer.fileInvalid') });
        return;
      }
      setBundle(next);
      setImportCategories(selectedCategoriesFromBundle(next));
      setImportCredentials(false);
    } catch {
      setPreviewFeedback({ tone: 'error', text: t('st.settingsTransfer.fileReadFailed') });
    }
  };

  const exportSettings = async (): Promise<void> => {
    const categoriesSnapshot = [...exportCategories];
    const credentialsSnapshot = exportCredentials;
    if (categoriesSnapshot.length === 0) {
      setExportFeedback({ tone: 'info', text: t('st.settingsTransfer.noCategories') });
      return;
    }
    setExporting(true);
    setExportFeedback(null);
    try {
      const serverBundle = await api.export({ categories: categoriesSnapshot, includeCredentials: credentialsSnapshot });
      const next = attachLocalSettingsTransferPreferences(serverBundle);
      if (!settingsTransferPackageWithinLimit(next)) {
        setExportFeedback({ tone: 'error', text: t('st.settingsTransfer.exportFailed') });
        return;
      }
      const saved = await savePackage(host, next);
      if (saved) setExportFeedback({ tone: 'success', text: t('st.settingsTransfer.exported') });
    } catch {
      setExportFeedback({ tone: 'error', text: t('st.settingsTransfer.exportFailed') });
    } finally {
      setExporting(false);
    }
  };

  const applySettings = async (): Promise<void> => {
    const currentPreview = preview;
    if (currentPreview === null || applying) return;
    const previewId = previewIdRef.current ?? currentPreview.previewId;
    const applyBundle = bundle;
    const applyCategories = [...importCategories];
    const applyMode = mode;
    previewIdRef.current = null;
    setApplying(true);
    setApplyDisplay(null);
    try {
      const result = await api.apply({ previewId });
      let local: LocalSettingsTransferApplyResult | null = null;
      if (result.status === 'complete' && applyCategories.includes('appearance')) {
        const desktopBridge = host.kind === 'tauri'
          ? { read: host.readDesktopPrefs, write: host.writeDesktopPrefs }
          : undefined;
        local = await applyLocalSettingsTransferPreferences(applyBundle?.preferences, applyMode, desktopBridge);
        if (local.preferences?.locale !== undefined) setLocale(local.preferences.locale);
      }
      setApplyDisplay({ result, local });
      setPreview(null);
      if (result.status === 'complete' && (local === null || local.status === 'complete')) {
        setPreviewFeedback({ tone: 'success', text: t('st.settingsTransfer.imported') });
      } else if (local?.status === 'partial') {
        setPreviewFeedback({ tone: 'error', text: t('st.settingsTransfer.localReadbackFailed') });
      } else if (result.status === 'partial') {
        setPreviewFeedback({ tone: 'error', text: t('st.settingsTransfer.importPartial') });
      } else {
        setPreviewFeedback({ tone: 'error', text: t('st.settingsTransfer.importFailed') });
      }
    } catch {
      setPreviewFeedback({ tone: 'error', text: t('st.settingsTransfer.importFailed') });
      setPreview(null);
    } finally {
      setApplying(false);
    }
  };

  const cancelPanel = (): void => {
    if (exporting || applying) return;
    previewSequenceRef.current += 1;
    const id = previewIdRef.current;
    previewIdRef.current = null;
    setBundle(null);
    setPreview(null);
    setApplyDisplay(null);
    void cancelServerPreview(id);
    onClose();
  };

  const panelTitle = tab === 'export' ? t('st.settingsTransfer.exportTitle') : t('st.settingsTransfer.importTitle');
  const panelDescription = tab === 'export' ? t('st.settingsTransfer.exportHint') : t('st.settingsTransfer.importHint');

  return (
    <SidePanel
      title={panelTitle}
      description={panelDescription}
      overlayId="settings-transfer"
      width="lg"
      onClose={cancelPanel}
      data={{ 'data-settings-transfer-panel': '' }}
      footer={(
        <>
          <button type="button" className={SECONDARY_BUTTON} onClick={cancelPanel} disabled={exporting || applying}>
            {t('st.settingsTransfer.cancel')}
          </button>
          <span className="ml-auto" />
          {tab === 'export' ? (
            <button type="button" className={PRIMARY_BUTTON} data-settings-transfer-export disabled={exporting || exportCategories.length === 0} onClick={() => { void exportSettings(); }}>
              {exporting ? t('st.settingsTransfer.exporting') : t('st.settingsTransfer.export')}
            </button>
          ) : (
            <button type="button" className={PRIMARY_BUTTON} data-settings-transfer-apply disabled={applying || previewing || preview === null} onClick={() => { void applySettings(); }}>
              {applying ? t('st.settingsTransfer.applying') : t('st.settingsTransfer.apply')}
            </button>
          )}
        </>
      )}
    >
      <div className="space-y-5" data-settings-transfer>
        <div className="inline-flex rounded-md bg-ink/[0.04] p-0.5" role="tablist" aria-label={t('st.settingsTransfer.title')}>
          <button type="button" role="tab" aria-selected={tab === 'export'} disabled={exporting || applying} className={tab === 'export' ? 'rounded-[5px] bg-panel px-3 py-1.5 text-[13px] font-medium text-ink shadow-[var(--kiki-sheet-shadow)]' : 'rounded-[5px] px-3 py-1.5 text-[13px] text-ink-soft'} onClick={() => { setTab('export'); }}>
            {t('st.settingsTransfer.export')}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'import'} disabled={exporting || applying} className={tab === 'import' ? 'rounded-[5px] bg-panel px-3 py-1.5 text-[13px] font-medium text-ink shadow-[var(--kiki-sheet-shadow)]' : 'rounded-[5px] px-3 py-1.5 text-[13px] text-ink-soft'} onClick={() => { setTab('import'); }}>
            {t('st.settingsTransfer.import')}
          </button>
        </div>

        {tab === 'export' ? (
          <ExportView
            categories={categories}
            selected={exportCategories}
            catalog={catalog}
            catalogState={catalogState}
            credentials={exportCredentials}
            exporting={exporting}
            feedback={exportFeedback}
            onRetry={() => { setCatalogRetry((value) => value + 1); }}
            onToggle={(category, checked) => { setExportCategories(updateCategories(exportCategories, category, checked)); setExportFeedback(null); }}
            onSelectAll={() => { setExportCategories([...categories]); setExportFeedback(null); }}
            onClear={() => { setExportCategories([]); setExportFeedback(null); }}
            onCredentials={setExportCredentials}
          />
        ) : (
          <ImportView
            categories={categories}
            bundle={bundle}
            fileName={fileName}
            selected={importCategories}
            mode={mode}
            credentials={importCredentials}
            preview={preview}
            previewing={previewing}
            applying={applying}
            feedback={previewFeedback}
            applyDisplay={applyDisplay}
            fileInputRef={fileInputRef}
            onFile={chooseFile}
            onToggle={(category, checked) => { setImportCategories(updateCategories(importCategories, category, checked)); }}
            onSelectAll={() => { if (bundle !== null) setImportCategories(selectedCategoriesFromBundle(bundle)); }}
            onClear={() => { setImportCategories([]); }}
            onMode={setMode}
            onCredentials={setImportCredentials}
            onRetryPreview={() => { setPreviewRetry((value) => value + 1); }}
          />
        )}
      </div>
    </SidePanel>
  );
}

function CategoryPicker({
  categories,
  selected,
  counts,
  disabled = false,
  onToggle,
  onSelectAll,
  onClear,
}: {
  readonly categories: readonly SettingsTransferCategory[];
  readonly selected: readonly SettingsTransferCategory[];
  readonly counts?: SettingsTransferCatalog | null;
  readonly disabled?: boolean;
  readonly onToggle: (category: SettingsTransferCategory, checked: boolean) => void;
  readonly onSelectAll: () => void;
  readonly onClear: () => void;
}) {
  const { t } = useI18n();
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <legend className="text-[13px] font-medium text-ink">{t('st.settingsTransfer.categories')}</legend>
        <div className="flex gap-2 text-[12px]">
          <button type="button" className="text-selected-ink hover:underline" data-settings-transfer-select-all disabled={disabled} onClick={onSelectAll}>{t('st.settingsTransfer.selectAll')}</button>
          <button type="button" className="text-ink-faint hover:text-ink hover:underline" data-settings-transfer-clear-all disabled={disabled} onClick={onClear}>{t('st.settingsTransfer.clearAll')}</button>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {categories.map((category) => {
          const summary = categorySummary(counts ?? null, category);
          const checked = selected.includes(category);
          return (
            <label key={category} className={`flex min-h-12 cursor-pointer items-start gap-2 rounded-md border px-3 py-2 transition-colors ${checked ? 'border-selected-ink/40 bg-selected-ink/[0.05]' : 'border-hairline bg-paper hover:border-hairline-strong'}`}>
              <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => { onToggle(category, event.target.checked); }} className="mt-0.5 accent-[var(--color-selected-ink)]" data-settings-transfer-category={category} />
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-ink">{t(CATEGORY_LABEL_KEYS[category])}</span>
                {summary !== undefined ? <span className="block text-[12px] text-ink-faint">{t('st.settingsTransfer.categoryCount', { count: summary.items })}</span> : null}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function NoticeList({ notices }: { readonly notices: readonly SettingsTransferCatalog['notices'][number][] }) {
  const { t } = useI18n();
  if (notices.length === 0) return null;
  return (
    <div className="space-y-1.5 rounded-md bg-ink/[0.035] px-3 py-2.5" data-settings-transfer-notices>
      <p className="text-[12px] font-medium text-ink-soft">{t('st.settingsTransfer.noticeHeading')}</p>
      <ul className="list-disc space-y-0.5 pl-4 text-[12px] leading-5 text-ink-faint">
        {notices.map((notice) => <li key={notice}>{t(NOTICE_KEYS[notice])}</li>)}
      </ul>
    </div>
  );
}

function ExportView({
  categories,
  selected,
  catalog,
  catalogState,
  credentials,
  exporting,
  feedback,
  onRetry,
  onToggle,
  onSelectAll,
  onClear,
  onCredentials,
}: {
  readonly categories: readonly SettingsTransferCategory[];
  readonly selected: readonly SettingsTransferCategory[];
  readonly catalog: SettingsTransferCatalog | null;
  readonly catalogState: 'loading' | 'ready' | 'error';
  readonly credentials: boolean;
  readonly exporting: boolean;
  readonly feedback: TransferFeedback;
  readonly onRetry: () => void;
  readonly onToggle: (category: SettingsTransferCategory, checked: boolean) => void;
  readonly onSelectAll: () => void;
  readonly onClear: () => void;
  readonly onCredentials: (value: boolean) => void;
}) {
  const { t } = useI18n();
  const notices = useMemo(() => {
    const list = catalog?.notices ?? [];
    return credentials ? list.filter((item) => item !== 'omittedCredentials') : list;
  }, [catalog?.notices, credentials]);
  return (
    <div className="space-y-4" data-settings-transfer-export-view>
      {catalogState === 'loading' ? <Hint>{t('st.settingsTransfer.catalogLoading')}</Hint> : null}
      {catalogState === 'error' ? (
        <div className="flex flex-wrap items-center gap-3">
          <FeedbackLine feedback={{ tone: 'error', text: t('st.settingsTransfer.catalogFailed') }} />
          <button type="button" className={SECONDARY_BUTTON} onClick={onRetry}>{t('st.settingsTransfer.retry')}</button>
        </div>
      ) : null}
      <CategoryPicker categories={categories} selected={selected} counts={catalog} disabled={catalogState !== 'ready' || exporting} onToggle={onToggle} onSelectAll={onSelectAll} onClear={onClear} />
      <label className="flex items-start gap-2 text-[13px] text-ink">
        <input type="checkbox" checked={credentials} disabled={exporting} onChange={(event) => { onCredentials(event.target.checked); }} className="mt-0.5 accent-[var(--color-selected-ink)]" data-settings-transfer-export-credentials />
        <span>
          <span className="block font-medium">{t('st.settingsTransfer.credentials')}</span>
          <span className="mt-0.5 block text-[12px] leading-5 text-ink-faint">{t('st.settingsTransfer.credentialsHint')}</span>
        </span>
      </label>
      <NoticeList notices={notices} />
      <FeedbackLine feedback={feedback} />
    </div>
  );
}

function ImportView({
  categories,
  bundle,
  fileName,
  selected,
  mode,
  credentials,
  preview,
  previewing,
  applying,
  feedback,
  applyDisplay,
  fileInputRef,
  onFile,
  onToggle,
  onSelectAll,
  onClear,
  onMode,
  onCredentials,
  onRetryPreview,
}: {
  readonly categories: readonly SettingsTransferCategory[];
  readonly bundle: SettingsTransferPackage | null;
  readonly fileName: string | null;
  readonly selected: readonly SettingsTransferCategory[];
  readonly mode: SettingsTransferMode;
  readonly credentials: boolean;
  readonly preview: SettingsTransferPreview | null;
  readonly previewing: boolean;
  readonly applying: boolean;
  readonly feedback: TransferFeedback;
  readonly applyDisplay: ApplyDisplay | null;
  readonly fileInputRef: React.RefObject<HTMLInputElement | null>;
  readonly onFile: (file: File | undefined) => Promise<void>;
  readonly onToggle: (category: SettingsTransferCategory, checked: boolean) => void;
  readonly onSelectAll: () => void;
  readonly onClear: () => void;
  readonly onMode: (value: SettingsTransferMode) => void;
  readonly onCredentials: (value: boolean) => void;
  readonly onRetryPreview: () => void;
}) {
  const { t } = useI18n();
  const importCategories = bundle === null ? [] : categories.filter((category) => bundle.categories.includes(category));
  const summaryCatalog = preview === null ? null : { scope: preview.scope, categories: preview.categories, notices: preview.notices };
  return (
    <div className="space-y-4" data-settings-transfer-import-view>
      <div className="space-y-2">
        <label className="block text-[13px] font-medium text-ink" htmlFor="settings-transfer-file">{t('st.settingsTransfer.file')}</label>
        <input
          ref={fileInputRef}
          id="settings-transfer-file"
          type="file"
          accept="application/json,.json"
          aria-label={t('st.settingsTransfer.chooseFile')}
          disabled={applying}
          className="block w-full rounded-md border border-hairline bg-paper px-3 py-2 text-[12px] text-ink file:mr-3 file:rounded file:border-0 file:bg-ink/[0.06] file:px-2 file:py-1 file:text-[12px] file:text-ink"
          data-settings-transfer-file
          onChange={(event) => { void onFile(event.currentTarget.files?.[0]); }}
        />
        <Hint>{t('st.settingsTransfer.fileHint')}</Hint>
        {fileName !== null ? <p className="text-[12px] text-ink-soft" data-settings-transfer-file-name>{t('st.settingsTransfer.fileSelected', { name: fileName })}</p> : null}
      </div>
      {bundle !== null ? (
        <>
          <CategoryPicker categories={importCategories} selected={selected} counts={summaryCatalog} disabled={previewing || applying} onToggle={onToggle} onSelectAll={onSelectAll} onClear={onClear} />
          {bundle.categories.includes('appearance') ? (
            <div className="space-y-1 rounded-md bg-ink/[0.035] px-3 py-2.5">
              <p className="text-[12px] font-medium text-ink-soft">{t('st.settingsTransfer.localPreferences')}</p>
              <Hint>{t('st.settingsTransfer.localPreferencesHint')}</Hint>
              {bundle.preferences === undefined ? <Hint>{t('st.settingsTransfer.localNothing')}</Hint> : null}
            </div>
          ) : null}
          {bundle.includesCredentials ? (
            <label className="flex items-start gap-2 text-[13px] text-ink">
              <input type="checkbox" checked={credentials} disabled={previewing || applying} onChange={(event) => { onCredentials(event.target.checked); }} className="mt-0.5 accent-[var(--color-selected-ink)]" data-settings-transfer-import-credentials />
              <span>
                <span className="block font-medium">{t('st.settingsTransfer.credentials')}</span>
                <span className="mt-0.5 block text-[12px] leading-5 text-ink-faint">{t('st.settingsTransfer.credentialsHint')}</span>
              </span>
            </label>
          ) : null}
          <fieldset className="space-y-2" disabled={previewing || applying}>
            <legend className="text-[13px] font-medium text-ink">{t('st.settingsTransfer.mode')}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              <ModeChoice value="append" selected={mode === 'append'} disabled={previewing || applying} label={t('st.settingsTransfer.modeAppend')} hint={t('st.settingsTransfer.appendHint')} onChange={onMode} />
              <ModeChoice value="overwrite" selected={mode === 'overwrite'} disabled={previewing || applying} label={t('st.settingsTransfer.modeOverwrite')} hint={t('st.settingsTransfer.overwriteHint')} onChange={onMode} />
            </div>
          </fieldset>
          {previewing ? <Hint>{t('st.settingsTransfer.previewing')}</Hint> : null}
          {preview !== null ? <PreviewSummary preview={preview} /> : null}
          {applyDisplay !== null ? <ApplyResultDisplay display={applyDisplay} /> : null}
          <NoticeList notices={preview?.notices ?? bundle.notices} />
        </>
      ) : null}
      <FeedbackLine feedback={feedback} />
      {feedback?.tone === 'error' && bundle !== null ? (
        <button type="button" className={SECONDARY_BUTTON} onClick={onRetryPreview} disabled={previewing}>{t('st.settingsTransfer.preview')}</button>
      ) : null}
    </div>
  );
}

function ModeChoice({ value, selected, disabled, label, hint, onChange }: {
  readonly value: SettingsTransferMode;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly label: string;
  readonly hint: string;
  readonly onChange: (value: SettingsTransferMode) => void;
}) {
  return (
    <label className={`cursor-pointer rounded-md border px-3 py-2 ${selected ? 'border-selected-ink/40 bg-selected-ink/[0.05]' : 'border-hairline bg-paper hover:border-hairline-strong'}`}>
      <span className="flex items-start gap-2">
        <input type="radio" name="settings-transfer-mode" value={value} checked={selected} disabled={disabled} onChange={() => { onChange(value); }} className="mt-0.5 accent-[var(--color-selected-ink)]" />
        <span>
          <span className="block text-[13px] font-medium text-ink">{label}</span>
          <span className="mt-0.5 block text-[12px] leading-5 text-ink-faint">{hint}</span>
        </span>
      </span>
    </label>
  );
}

function PreviewSummary({ preview }: { readonly preview: SettingsTransferPreview }) {
  const { t } = useI18n();
  return (
    <section className="space-y-3 rounded-md border border-hairline bg-paper px-3 py-3" data-settings-transfer-preview>
      <div className="space-y-1">
        <h3 className="text-[13px] font-medium text-ink">{t('st.settingsTransfer.summaryHeading')}</h3>
        <p className="text-[12px] text-ink-faint">{t('st.settingsTransfer.target')}</p>
        <p className="break-all font-mono text-[11px] text-ink-soft">{t('st.settingsTransfer.targetHome', { home: preview.scope.home })}</p>
        {preview.scope.spaceId !== undefined ? <p className="break-all font-mono text-[11px] text-ink-soft">{t('st.settingsTransfer.targetSpace', { space: preview.scope.spaceId })}</p> : null}
      </div>
      <div className="space-y-2">
        {preview.categories.map((summary) => (
          <div key={summary.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 pt-2 first:pt-0">
            <span className="text-[12px] font-medium text-ink">{t(CATEGORY_LABEL_KEYS[summary.id])}</span>
            <span className="text-right text-[11px] tabular-nums text-ink-faint">
              {t('st.settingsTransfer.summaryItems', { count: summary.items })}
              {' · '}{t('st.settingsTransfer.summaryAdded', { count: summary.added })}
              {' · '}{t('st.settingsTransfer.summaryConflicts', { count: summary.conflicts })}
              {' · '}{t('st.settingsTransfer.summaryUnchanged', { count: summary.unchanged })}
              {' · '}{t('st.settingsTransfer.summarySkipped', { count: summary.skipped })}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ApplyResultDisplay({ display }: { readonly display: ApplyDisplay }) {
  const { t } = useI18n();
  const localItems = display.local === null ? [] : [
    ...display.local.appliedKeys.map((key) => ({ category: 'appearance' as const, key, status: 'applied' as const })),
    ...display.local.failedKeys.map((key) => ({ category: 'appearance' as const, key, status: 'failed' as const })),
  ];
  const items = [...display.result.items, ...localItems];
  const complete = display.result.status === 'complete' && (display.local === null || display.local.status === 'complete');
  return (
    <section className="space-y-2 rounded-md border border-hairline bg-paper px-3 py-3" data-settings-transfer-apply-result>
      <h3 className="text-[13px] font-medium text-ink">{t('st.settingsTransfer.itemStatusHeading')}</h3>
      {items.length === 0 ? <Hint>{complete ? t('st.settingsTransfer.imported') : t('st.settingsTransfer.importFailed')}</Hint> : null}
      {items.length > 0 ? (
        <ul className="space-y-1">
          {items.map((item, index) => (
            <li key={`${item.category}:${item.key}:${index}`} className="flex items-baseline justify-between gap-3 text-[12px]">
              <span className="min-w-0 break-all font-mono text-ink-soft">{item.key}</span>
              <span className={item.status === 'failed' || item.status === 'unverified' ? 'shrink-0 text-danger' : 'shrink-0 text-ink-faint'}>{t(ITEM_STATUS_KEYS[item.status])}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {display.result.failure !== undefined ? <p className="text-[12px] leading-5 text-danger">{t(FAILURE_KEYS[display.result.failure])}</p> : null}
    </section>
  );
}

export { CATEGORY_LABEL_KEYS };
