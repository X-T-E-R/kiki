import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  PortableSpaceApplyReceipt,
  PortableSpaceDiffChange,
  PortableSpaceDiffRow,
  PortableSpaceEndpoint,
  PortableSpaceOperationMode,
  PortableSpacePreviewResult,
  PortableSpaceSourceRecord,
  PortableSpaceUnlock,
} from '@kiki/protocol';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../../i18n';
import type { KikiClient } from '../../../lib/client';
import { endpointKey, portableSpacesApi } from '../../../lib/portableSpaces';
import { MAIN_SPACE_ID, type SpaceListItem } from '../../../lib/spaces';
import { FeedbackLine, InlineError, type Feedback } from '../../controls';
import { DisclosureChevron, Icon } from '../../icons';
import { PRIMARY_BUTTON, SECONDARY_BUTTON, INPUT_BOX } from '../../ui';
import { FORM_LABEL, SettingsSegmented, SettingsSelect } from '../SettingsPrimitives';

function SwapHorizontalIcon({ size = 14, className = '' }: { readonly size?: number; readonly className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M3 5.5h10M10.5 3 13 5.5 10.5 8" />
      <path d="M13 10.5H3M5.5 8 3 10.5 5.5 13" />
    </svg>
  );
}

type CompareMode = Extract<PortableSpaceOperationMode, 'sync' | 'merge' | 'override'>;

interface EndpointOption {
  readonly value: string;
  readonly label: string;
  readonly endpoint: PortableSpaceEndpoint;
}

const DIFF_LABEL_KEYS: Record<Exclude<PortableSpaceDiffChange, 'unchanged'>, I18nKey> = {
  added: 'st.portable.diff.added',
  modified: 'st.portable.diff.modified',
  deleted: 'st.portable.diff.deleted',
  only_left: 'st.portable.diff.onlyLeft',
  only_right: 'st.portable.diff.onlyRight',
  conflict: 'st.portable.diff.conflict',
};

export interface PortableCompareTabProps {
  readonly client: KikiClient;
  readonly token?: string;
  readonly source: PortableSpaceSourceRecord;
  readonly spaces: readonly SpaceListItem[];
  readonly portableSources: readonly PortableSpaceSourceRecord[];
  readonly initialMode?: CompareMode;
  readonly initialRightEndpoint?: PortableSpaceEndpoint;
  readonly sourceUnlock?: PortableSpaceUnlock;
  readonly onApplied: (receipt: PortableSpaceApplyReceipt) => void;
}

export function PortableCompareTab({
  client,
  token,
  source,
  spaces,
  portableSources,
  initialMode = 'sync',
  initialRightEndpoint,
  sourceUnlock,
  onApplied,
}: PortableCompareTabProps) {
  const { t, locale } = useI18n();

  const endpointOptions = useMemo<readonly EndpointOption[]>(() => {
    const live: EndpointOption[] = spaces.map((space) => ({
      value: `live:${space.id}`,
      label: space.id === MAIN_SPACE_ID ? t('st.spaces.main') : space.name,
      endpoint: { kind: 'live', spaceId: space.id },
    }));
    if (live.length === 0) {
      live.push({
        value: `live:${MAIN_SPACE_ID}`,
        label: t('st.spaces.main'),
        endpoint: { kind: 'live', spaceId: MAIN_SPACE_ID },
      });
    }
    const portable: EndpointOption[] = portableSources.map((item) => ({
      value: `source:${item.id}`,
      label: item.label,
      endpoint: item.endpoint,
    }));
    return [...live, ...portable];
  }, [spaces, portableSources, t]);

  const defaultRightValue = useMemo(() => {
    if (initialRightEndpoint !== undefined) {
      const want = endpointKey(initialRightEndpoint);
      const found = endpointOptions.find((option) => endpointKey(option.endpoint) === want);
      if (found !== undefined) return found.value;
    }
    return `live:${MAIN_SPACE_ID}`;
  }, [endpointOptions, initialRightEndpoint]);

  const [leftValue, setLeftValue] = useState(`source:${source.id}`);
  const [rightValue, setRightValue] = useState(defaultRightValue);
  const [mode, setMode] = useState<CompareMode>(initialMode);
  const [unlocksByKey, setUnlocksByKey] = useState<Readonly<Record<string, PortableSpaceUnlock>>>({});
  const [leftPassDraft, setLeftPassDraft] = useState('');
  const [rightPassDraft, setRightPassDraft] = useState('');
  const [preview, setPreview] = useState<PortableSpacePreviewResult | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [resolutions, setResolutions] = useState<Readonly<Record<string, 'left' | 'right'>>>({});
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [nonce, setNonce] = useState(0);
  const loadSeq = useRef(0);

  const leftOption = endpointOptions.find((opt) => opt.value === leftValue) ?? {
    value: `source:${source.id}`,
    label: source.label,
    endpoint: source.endpoint,
  };
  const rightOption = endpointOptions.find((opt) => opt.value === rightValue) ?? endpointOptions[0]!;
  const sameEndpoint = endpointKey(leftOption.endpoint) === endpointKey(rightOption.endpoint);
  const leftKey = endpointKey(leftOption.endpoint);
  const rightKey = endpointKey(rightOption.endpoint);
  const sourceEpKey = endpointKey(source.endpoint);

  const leftRecord = portableSources.find((item) => endpointKey(item.endpoint) === leftKey);
  const rightRecord = portableSources.find((item) => endpointKey(item.endpoint) === rightKey);
  const effectiveLeftUnlock = unlocksByKey[leftKey] ?? (leftKey === sourceEpKey ? sourceUnlock : undefined);
  const effectiveRightUnlock = unlocksByKey[rightKey] ?? (rightKey === sourceEpKey ? sourceUnlock : undefined);

  const showLeftUnlock =
    leftOption.endpoint.kind !== 'live' &&
    ((leftRecord?.encryptionMode === 'passphrase' && effectiveLeftUnlock === undefined) || error !== null);
  const showRightUnlock =
    rightOption.endpoint.kind !== 'live' &&
    ((rightRecord?.encryptionMode === 'passphrase' && effectiveRightUnlock === undefined) || error !== null);

  const loadPreview = useCallback(() => {
    if (sameEndpoint) {
      setPreview(null);
      setError(null);
      setLoading(false);
      return;
    }
    const seq = ++loadSeq.current;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setFeedback(null);
    void portableSpacesApi(client, { token })
      .preview(
        {
          mode,
          sources: [leftOption.endpoint],
          target: rightOption.endpoint,
          sourceUnlocks: effectiveLeftUnlock !== undefined ? [effectiveLeftUnlock] : undefined,
          targetUnlock: effectiveRightUnlock,
        },
        controller.signal,
      )
      .then((result) => {
        if (seq !== loadSeq.current) return;
        setPreview(result);
        setSelected(
          new Set(
            result.rows
              .filter((row) => row.change !== 'unchanged' && row.blockedReason === undefined && row.selected)
              .map((row) => row.id),
          ),
        );
        const initialResolutions: Record<string, 'left' | 'right'> = {};
        for (const row of result.rows) {
          if (row.change === 'conflict') initialResolutions[row.id] = 'left';
        }
        setResolutions(initialResolutions);
      })
      .catch((caught: unknown) => {
        if (seq !== loadSeq.current) return;
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setPreview(null);
        setError(caught);
      })
      .finally(() => {
        if (seq === loadSeq.current) setLoading(false);
      });
    return () => { controller.abort(); };
  }, [client, token, mode, leftOption.endpoint, rightOption.endpoint, sameEndpoint, effectiveLeftUnlock, effectiveRightUnlock]);

  useEffect(() => {
    const cancel = loadPreview();
    return () => { cancel?.(); };
  }, [loadPreview, nonce]);

  const changedRows = useMemo(
    () => (preview?.rows ?? []).filter((row) => row.change !== 'unchanged'),
    [preview],
  );
  const unchangedRows = useMemo(
    () => (preview?.rows ?? []).filter((row) => row.change === 'unchanged'),
    [preview],
  );
  const unchangedTotal = Math.max(preview?.unchangedCount ?? 0, unchangedRows.length);

  const toggleRow = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const setConflictSide = (id: string, side: 'left' | 'right') => {
    setResolutions((current) => ({ ...current, [id]: side }));
    setSelected((current) => {
      const next = new Set(current);
      next.add(id);
      return next;
    });
  };

  const swapEndpoints = () => {
    setLeftValue(rightValue);
    setRightValue(leftValue);
  };

  const applyChanges = async () => {
    if (preview === null || applying || selected.size === 0) return;
    setApplying(true);
    setFeedback(null);
    const conflictResolutions: Record<string, 'left' | 'right' | 'skip'> = {};
    for (const row of changedRows) {
      if (row.change !== 'conflict') continue;
      conflictResolutions[row.id] = selected.has(row.id) ? (resolutions[row.id] ?? 'left') : 'skip';
    }
    try {
      const receipt = await portableSpacesApi(client, { token }).apply({
        previewToken: preview.previewToken,
        selectedIds: [...selected],
        resolutions: Object.keys(conflictResolutions).length > 0 ? conflictResolutions : undefined,
        createBackup: true,
      });
      setFeedback({
        tone: 'success',
        text: t(receipt.restartRequired ? 'st.portable.applyDoneRestart' : 'st.portable.applyDone', {
          count: receipt.appliedIds.length,
        }),
      });
      onApplied(receipt);
      setNonce((value) => value + 1);
    } catch (caught) {
      setFeedback({ tone: 'error', text: errorText(locale, caught) });
    } finally {
      setApplying(false);
    }
  };

  const choices = endpointOptions.map((opt) => ({ value: opt.value, label: opt.label }));

  const renderDiffRow = (row: PortableSpaceDiffRow) => {
    const blocked = row.blockedReason !== undefined;
    const isUnchanged = row.change === 'unchanged';
    const checked = !blocked && selected.has(row.id);
    const isConflict = row.change === 'conflict';
    const resolvedSide = resolutions[row.id] ?? 'left';

    return (
      <li key={row.id} className="border-b border-hairline last:border-b-0">
        <div
          data-portable-diff-row={row.id}
          data-portable-diff-change={row.change}
          className="flex flex-wrap items-start gap-x-3 gap-y-2 py-2.5 sm:flex-nowrap"
        >
          {isUnchanged ? (
            <span className="mt-1 inline-block h-3.5 w-3.5 shrink-0" aria-hidden />
          ) : (
            <input
              type="checkbox"
              aria-label={row.label}
              data-portable-diff-check={row.id}
              disabled={blocked || applying}
              checked={checked}
              onChange={() => { toggleRow(row.id); }}
              className="mt-0.5 shrink-0 accent-[var(--color-selected-ink)]"
            />
          )}

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className={`text-[13px] ${blocked || isUnchanged ? 'text-ink-faint' : 'text-ink'}`}>
                {row.label}
              </span>
              {row.change !== 'unchanged' ? (
                <span
                  className={`rounded px-1.5 py-px text-[11px] font-medium ${
                    isConflict
                      ? 'bg-amber-card text-amber-ink'
                      : row.change === 'deleted'
                        ? 'bg-danger/[0.08] text-danger'
                        : 'bg-ink/[0.05] text-ink-soft'
                  }`}
                >
                  {t(DIFF_LABEL_KEYS[row.change])}
                </span>
              ) : null}
              {row.masked ? <Icon name="lock" size={12} className="text-ink-faint" /> : null}
            </div>
            <p className="truncate font-mono text-[11.5px] text-ink-faint" title={row.path}>{row.path}</p>
            {blocked ? (
              <p className="mt-0.5 text-[12px] leading-4 text-ink-faint" data-portable-diff-blocked={row.id}>
                {row.blockedReason}
              </p>
            ) : null}
            {isConflict && !blocked ? (
              <div className="mt-1.5 flex items-center gap-1.5" data-portable-conflict-resolve={row.id}>
                <button
                  type="button"
                  data-portable-conflict-side="left"
                  aria-pressed={resolvedSide === 'left'}
                  disabled={applying}
                  onClick={() => { setConflictSide(row.id, 'left'); }}
                  className={`rounded px-2 py-0.5 text-[11.5px] transition-colors ${
                    resolvedSide === 'left'
                      ? 'bg-panel font-medium text-ink shadow-[var(--kiki-sheet-shadow)] ring-1 ring-hairline-strong'
                      : 'bg-ink/[0.04] text-ink-soft hover:text-ink'
                  }`}
                >
                  {t('st.portable.conflictKeepLeft')}
                </button>
                <button
                  type="button"
                  data-portable-conflict-side="right"
                  aria-pressed={resolvedSide === 'right'}
                  disabled={applying}
                  onClick={() => { setConflictSide(row.id, 'right'); }}
                  className={`rounded px-2 py-0.5 text-[11.5px] transition-colors ${
                    resolvedSide === 'right'
                      ? 'bg-panel font-medium text-ink shadow-[var(--kiki-sheet-shadow)] ring-1 ring-hairline-strong'
                      : 'bg-ink/[0.04] text-ink-soft hover:text-ink'
                  }`}
                >
                  {t('st.portable.conflictKeepRight')}
                </button>
              </div>
            ) : null}
          </div>

          <div
            className="ml-auto flex max-w-[16rem] shrink-0 items-center gap-1.5 text-[12px] text-ink-soft"
            data-portable-diff-direction={
              isConflict
                ? 'conflict'
                : row.direction === 'to_left' || row.change === 'only_right'
                  ? 'to_left'
                  : row.direction === 'both'
                    ? 'both'
                    : 'to_right'
            }
          >
            <span
              className={`truncate ${isConflict ? 'text-ink' : 'text-ink-faint'}`}
              title={row.beforeSummary ?? undefined}
            >
              {row.beforeSummary ?? '—'}
            </span>
            {isConflict || row.direction === 'both' ? (
              <SwapHorizontalIcon size={12} className={isConflict ? 'shrink-0 text-amber-ink' : 'shrink-0 text-ink-faint'} />
            ) : row.direction === 'to_left' || row.change === 'only_right' ? (
              <Icon name="arrowLeft" size={12} className="shrink-0 text-ink-faint" />
            ) : (
              <Icon name="arrowRight" size={12} className="shrink-0 text-ink-faint" />
            )}
            <span className="truncate text-ink" title={row.afterSummary ?? undefined}>
              {row.afterSummary ?? '—'}
            </span>
          </div>
        </div>
      </li>
    );
  };

  const applyLabel = applying
    ? t('st.portable.applying')
    : mode === 'sync'
      ? t('st.portable.syncConfirm', { count: selected.size })
      : t('st.portable.applyConfirm', { count: selected.size });

  return (
    <div className="space-y-5" data-portable-compare-tab>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-end">
        <div className="min-w-0">
          <span className={FORM_LABEL}>{t('st.portable.compareLeft')}</span>
          <div className="mt-1.5">
            <SettingsSelect<string>
              variant="form"
              ariaLabel={t('st.portable.compareLeft')}
              dataAttr="data-portable-left-endpoint"
              value={leftValue}
              onChange={setLeftValue}
              choices={choices}
            />
          </div>
        </div>
        <button
          type="button"
          data-portable-swap-endpoints
          aria-label={t('st.portable.compareSwap')}
          title={t('st.portable.compareSwap')}
          onClick={swapEndpoints}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-hairline bg-paper text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
        >
          <SwapHorizontalIcon size={14} />
        </button>
        <div className="min-w-0">
          <span className={FORM_LABEL}>{t('st.portable.compareRight')}</span>
          <div className="mt-1.5">
            <SettingsSelect<string>
              variant="form"
              ariaLabel={t('st.portable.compareRight')}
              dataAttr="data-portable-right-endpoint"
              value={rightValue}
              onChange={setRightValue}
              choices={choices}
            />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <SettingsSegmented<CompareMode>
          ariaLabel={t('st.portable.compareMode')}
          dataAttr="data-portable-op-mode"
          value={mode}
          onChange={setMode}
          choices={[
            { value: 'sync', label: t('st.portable.compareModeSync') },
            { value: 'merge', label: t('st.portable.compareModeMerge') },
            { value: 'override', label: t('st.portable.compareModeOverride') },
          ]}
        />
        <button
          type="button"
          data-portable-compare-refresh
          className={SECONDARY_BUTTON}
          disabled={loading || applying || sameEndpoint}
          onClick={() => { setNonce((value) => value + 1); }}
        >
          <span className="inline-flex items-center gap-1.5">
            <Icon name="refresh" size={12} />
            {t('st.portable.compareRefresh')}
          </span>
        </button>
      </div>

      {sameEndpoint ? (
        <p className="text-[13px] text-ink-faint">{t('st.portable.compareSameEndpoint')}</p>
      ) : null}

      {loading ? (
        <p className="text-[12.5px] text-ink-faint" data-portable-compare-loading>{t('st.portable.compareLoading')}</p>
      ) : null}

      {error !== null ? (
        <div className="space-y-2">
          <InlineError error={error} />
        </div>
      ) : null}

      {(showLeftUnlock || showRightUnlock) && !sameEndpoint ? (
        <div className="space-y-2 rounded-lg border border-hairline bg-paper/60 px-3 py-2.5" data-portable-compare-unlock>
          {showLeftUnlock ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (leftPassDraft.trim() === '') return;
                setUnlocksByKey((current) => ({ ...current, [leftKey]: { passphrase: leftPassDraft.trim() } }));
                setLeftPassDraft('');
              }}
            >
              <input
                type="password"
                data-portable-compare-unlock-left
                aria-label={t('st.portable.compareUnlockLeft')}
                value={leftPassDraft}
                placeholder={`${t('st.portable.compareUnlockLeft')} (${leftOption.label})`}
                onChange={(event) => { setLeftPassDraft(event.target.value); }}
                className={`${INPUT_BOX} min-w-0 flex-1`}
              />
              <button type="submit" data-portable-compare-unlock-left-submit className={SECONDARY_BUTTON}>
                {t('st.portable.unlockAction')}
              </button>
            </form>
          ) : null}
          {showRightUnlock ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (rightPassDraft.trim() === '') return;
                setUnlocksByKey((current) => ({ ...current, [rightKey]: { passphrase: rightPassDraft.trim() } }));
                setRightPassDraft('');
              }}
            >
              <input
                type="password"
                data-portable-compare-unlock-right
                aria-label={t('st.portable.compareUnlockRight')}
                value={rightPassDraft}
                placeholder={`${t('st.portable.compareUnlockRight')} (${rightOption.label})`}
                onChange={(event) => { setRightPassDraft(event.target.value); }}
                className={`${INPUT_BOX} min-w-0 flex-1`}
              />
              <button type="submit" data-portable-compare-unlock-right-submit className={SECONDARY_BUTTON}>
                {t('st.portable.unlockAction')}
              </button>
            </form>
          ) : null}
        </div>
      ) : null}

      {preview !== null && !loading ? (
        <div className="space-y-3" data-portable-diff-list>
          {changedRows.length === 0 ? (
            <p className="text-[13px] text-ink-soft" data-portable-compare-empty>{t('st.portable.compareEmpty')}</p>
          ) : (
            <ul className="divide-y divide-hairline border-t border-b border-hairline">
              {changedRows.map(renderDiffRow)}
            </ul>
          )}

          {unchangedTotal > 0 ? (
            <div>
              <button
                type="button"
                data-portable-unchanged-toggle
                aria-expanded={showUnchanged}
                onClick={() => { setShowUnchanged((current) => !current); }}
                className="inline-flex items-center gap-1.5 rounded px-1 py-1 text-[12px] text-ink-soft transition-colors hover:text-ink"
              >
                <DisclosureChevron open={showUnchanged} />
                <span>{t('st.portable.compareUnchanged', { count: unchangedTotal })}</span>
              </button>
              {showUnchanged && unchangedRows.length > 0 ? (
                <ul className="mt-1 border-t border-hairline" data-portable-unchanged-rows>
                  {unchangedRows.map(renderDiffRow)}
                </ul>
              ) : null}
            </div>
          ) : null}

          {preview.dependencyErrors.length > 0 ? (
            <ul className="space-y-1 text-[12px] text-amber-ink">
              {preview.dependencyErrors.map((depError) => <li key={depError}>{depError}</li>)}
            </ul>
          ) : null}

          {changedRows.length > 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              {selected.size === 0 ? (
                <span className="text-[12px] text-ink-faint">{t('st.portable.applyEmpty')}</span>
              ) : <span />}
              <button
                type="button"
                data-portable-apply-submit
                className={PRIMARY_BUTTON}
                disabled={applying || selected.size === 0}
                onClick={() => { void applyChanges(); }}
              >
                {applyLabel}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <FeedbackLine feedback={feedback} />
    </div>
  );
}
