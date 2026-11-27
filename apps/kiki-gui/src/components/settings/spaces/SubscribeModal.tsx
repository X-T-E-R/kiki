import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import {
  evaluateSubscriptionSelection,
  normalizePreviewManifest,
  toggleSubscriptionItem,
  toggleSubscriptionScope,
  type PortableSpaceBindingChoices,
  type PortableSpaceCenterCommit,
  type PortableSpaceCenterSource,
  type PortableSpaceEndpoint,
  type PortableSpaceImpact,
  type PortableSpacePatchSourceResult,
  type PortableSpaceSourceRecord,
  type PortableSpaceSubscribePreviewItem,
  type PortableSpaceSubscribePreviewManifest,
  type PortableSpaceSubscriptionSelection,
  type PortableSpaceSyncPolicy,
  type PortableSubscriptionScope,
} from '@kiki/protocol';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';

import { useHost } from '../../../host';
import { useI18n } from '../../../i18n';
import type { KikiClient } from '../../../lib/client';
import {
  PORTABLE_SUBSCRIPTION_SCOPE_LABEL_KEY,
  extractSubscriptionOrigin,
  isPortablePreviewExpiredError,
  isPortablePreviewStaleError,
  isPortableUnlockRequiredError,
  isSupportedPortableArchivePath,
  maskSubscriptionUrl,
  portableSpacesApi,
} from '../../../lib/portableSpaces';
import { MAIN_SPACE_ID, type SpaceListItem } from '../../../lib/spaces';
import type { PendingSubscribeIntent } from '../../../lib/subscribeIntent';
import { FeedbackLine, InlineError, type Feedback } from '../../controls';
import { Dialog, DIALOG_SHEET_OVERLAY_CLASS } from '../../Dialog';
import { DisclosureChevron, Icon } from '../../icons';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { FieldIssue, FORM_LABEL, SettingsSegmented, SettingsSelect } from '../SettingsPrimitives';
import { ModelBindingSection } from './ModelBindingSection';

/**
 * Unframed warm-paper dialog surface (`fourSidedBoxes = 0` inside modal chrome
 * and content). Retains `Dialog`'s focus trap, Escape/backdrop handling, and
 * mobile safe-area sheet geometry.
 */
const UNFRAMED_MODAL_PANEL_CLASS =
  'anim-enter flex w-full max-w-[880px] flex-col overflow-hidden rounded-xl bg-paper text-ink outline-none max-h-[calc(var(--kiki-visual-height,100dvh)-2rem-var(--kiki-safe-top-inset))] max-md:h-[calc(var(--kiki-visual-height,100dvh)-var(--kiki-safe-top-inset))] max-md:max-h-none max-md:max-w-none max-md:rounded-none';

type NewSourceTab = 'url' | 'archive' | 'legacy';
type LegacyKind = 'dir' | 'git';
type ModalStage = 'input' | 'unlock' | 'preview';

export type SubscribeModalMode =
  | {
    readonly kind: 'new';
    readonly initialIntent?: PendingSubscribeIntent;
    readonly initialArchivePath?: string;
    readonly initialTab?: NewSourceTab;
    readonly initialLegacyKind?: LegacyKind;
  }
  | {
    readonly kind: 'update-review';
    readonly source: PortableSpaceCenterSource;
  }
  | {
    readonly kind: 'edit-selection';
    readonly source: PortableSpaceCenterSource;
  };

export type SubscribeModalResult =
  | { readonly kind: 'commit'; readonly commit: PortableSpaceCenterCommit }
  | { readonly kind: 'patch'; readonly result: PortableSpacePatchSourceResult }
  | { readonly kind: 'linked'; readonly record: PortableSpaceSourceRecord };

export interface SubscribeModalProps {
  readonly client: KikiClient;
  readonly spaces: readonly SpaceListItem[];
  readonly mode: SubscribeModalMode;
  readonly queuedCount?: number;
  readonly onClose: () => void;
  readonly onDone: (result: SubscribeModalResult) => void;
}

function ScopeCheckbox({
  id,
  state,
  disabled,
  ariaLabel,
  scope,
  onChange,
}: {
  readonly id: string;
  readonly state: 'checked' | 'indeterminate' | 'unchecked';
  readonly disabled?: boolean;
  readonly ariaLabel: string;
  readonly scope: PortableSubscriptionScope;
  readonly onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current !== null) {
      ref.current.indeterminate = state === 'indeterminate';
    }
  }, [state]);

  return (
    <input
      ref={ref}
      id={id}
      type="checkbox"
      data-portable-scope-check={scope}
      aria-label={ariaLabel}
      aria-checked={state === 'indeterminate' ? 'mixed' : state === 'checked'}
      checked={state === 'checked'}
      disabled={disabled}
      onChange={() => {
        // Clicking an indeterminate or unchecked parent enables the whole scope;
        // clicking a fully checked parent disables it.
        onChange(state !== 'checked');
      }}
      className="h-4 w-4 shrink-0 cursor-pointer accent-[var(--color-selected-ink)] disabled:cursor-not-allowed"
    />
  );
}

function formatStatusLabel(
  item: PortableSpaceSubscribePreviewItem,
  t: ReturnType<typeof useI18n>['t'],
): string {
  if (item.status === 'owned_by_other') {
    return t('st.portable.center.status.owned_by_other', { owner: item.ownerLabel ?? item.ownerSourceId ?? '—' });
  }
  return t(`st.portable.center.status.${item.status}` as I18nKey);
}

function statusToneClass(status: PortableSpaceSubscribePreviewItem['status']): string {
  switch (status) {
    case 'will_write':
      return 'text-selected-ink font-normal';
    case 'blocked':
      return 'text-danger-ink font-normal';
    case 'owned_by_other':
    case 'pending':
    case 'new_scope':
      return 'text-amber-ink font-normal';
    case 'removed_impact':
      return 'text-danger-ink';
    case 'kept_local':
    case 'unchanged':
      return 'text-ink-faint';
  }
}

function isModelRequiredPrompt(item: PortableSpaceSubscribePreviewItem, itemById: ReadonlyMap<string, PortableSpaceSubscribePreviewItem>): boolean {
  if (item.scope !== 'instructions') return false;
  return item.referencedByIds.some((refId) => {
    const ref = itemById.get(refId);
    return ref !== undefined && (ref.id.startsWith('config:models.') || ref.id === 'config:prompt');
  });
}

function defaultPolicyForManifest(
  manifest: PortableSpaceSubscribePreviewManifest,
  requested?: PortableSpaceSyncPolicy,
): PortableSpaceSyncPolicy {
  if (requested !== undefined && manifest.allowedPolicies.includes(requested)) {
    return requested;
  }
  if (manifest.allowedPolicies.includes('auto')) return 'auto';
  if (manifest.allowedPolicies.includes('manual')) return 'manual';
  return manifest.allowedPolicies[0] ?? 'once';
}

export function SubscribeModal({
  client,
  spaces,
  mode,
  queuedCount = 0,
  onClose,
  onDone,
}: SubscribeModalProps) {
  const host = useHost();
  const { t, locale } = useI18n();
  const urlInputId = useId();
  const urlIssueId = useId();
  const labelInputId = useId();
  const passphraseInputId = useId();
  const cleanupRadioName = useId();

  const initialIntent = mode.kind === 'new' ? mode.initialIntent : undefined;
  const initialArchivePath = mode.kind === 'new' ? mode.initialArchivePath : undefined;
  const isDeepLinkOrigin = mode.kind === 'new' && initialIntent !== undefined;

  const [sourceTab, setSourceTab] = useState<NewSourceTab>(() => {
    if (mode.kind !== 'new') return 'url';
    if (mode.initialTab !== undefined) return mode.initialTab;
    if (initialArchivePath !== undefined) return 'archive';
    return 'url';
  });
  const [legacyKind, setLegacyKind] = useState<LegacyKind>(
    mode.kind === 'new' && mode.initialLegacyKind !== undefined ? mode.initialLegacyKind : 'dir',
  );

  const [urlDraft, setUrlDraft] = useState(initialIntent?.url ?? '');
  const [archivePath, setArchivePath] = useState(initialArchivePath ?? '');
  const [legacyTarget, setLegacyTarget] = useState('');
  const [gitRef, setGitRef] = useState('');
  const [gitSubpath, setGitSubpath] = useState('');
  const [labelDraft, setLabelDraft] = useState(
    mode.kind === 'new' ? (initialIntent?.name ?? '') : mode.source.label,
  );
  const [targetSpaceId, setTargetSpaceId] = useState<string>(
    mode.kind === 'new' ? MAIN_SPACE_ID : (mode.source.linkedSpaceId ?? MAIN_SPACE_ID),
  );
  const [passphrase, setPassphrase] = useState('');
  const [inputIssue, setInputIssue] = useState<string | null>(null);

  const [stage, setStage] = useState<ModalStage>(mode.kind === 'new' ? 'input' : 'preview');
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<unknown>(null);
  const [manifest, setManifest] = useState<PortableSpaceSubscribePreviewManifest | null>(null);
  const [selection, setSelection] = useState<PortableSpaceSubscriptionSelection | null>(null);
  const [bindings, setBindings] = useState<PortableSpaceBindingChoices>({});
  const [syncPolicy, setSyncPolicy] = useState<PortableSpaceSyncPolicy>(
    initialIntent?.mode ?? 'auto',
  );
  const [expandedScopes, setExpandedScopes] = useState<ReadonlySet<PortableSubscriptionScope>>(new Set());
  const [expandedDiffs, setExpandedDiffs] = useState<ReadonlySet<string>>(new Set());
  const [excludedOpen, setExcludedOpen] = useState(false);

  // Edit-selection deselected cleanup state
  const [cleanupDeselected, setCleanupDeselected] = useState(false);
  const [reviewedImpact, setReviewedImpact] = useState<{
    readonly impact: PortableSpaceImpact;
    readonly impactDigest: string;
  } | null>(null);
  const [reviewingCleanup, setReviewingCleanup] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [needsFreshPreview, setNeedsFreshPreview] = useState(false);
  const [dropFeedback, setDropFeedback] = useState<Feedback>(null);

  const dropZoneRef = useRef<HTMLDivElement>(null);
  const previewSeqRef = useRef(0);
  const previewAbortRef = useRef<AbortController | null>(null);

  // Clear passphrase and abort in-flight previews on unmount.
  useEffect(() => () => {
    previewAbortRef.current?.abort();
  }, []);

  const closeCleanly = useCallback(() => {
    if (submitting) return;
    previewAbortRef.current?.abort();
    setPassphrase('');
    onClose();
  }, [submitting, onClose]);

  const applyLoadedManifest = useCallback((loaded: PortableSpaceSubscribePreviewManifest) => {
    setManifest(loaded);
    setSelection(loaded.defaultSelection);
    setBindings(loaded.savedBindingChoices);
    setSyncPolicy(defaultPolicyForManifest(loaded, mode.kind === 'new' ? initialIntent?.mode : undefined));
    if (mode.kind === 'new' && labelDraft.trim() === '') {
      setLabelDraft(loaded.suggestedLabel);
    }
    setReviewedImpact(null);
    setCleanupDeselected(false);
    setNeedsFreshPreview(false);
    setSubmitError(null);
    setPreviewError(null);
    setPassphrase('');
    // Expand the first nonempty scope plus any scope containing executable plugins by default.
    const initialExpanded = new Set<PortableSubscriptionScope>();
    const firstNonEmpty = loaded.items.find((item) => item.selectable)?.scope;
    if (firstNonEmpty !== undefined) initialExpanded.add(firstNonEmpty);
    for (const item of loaded.items) {
      if (item.domain === 'plugins') initialExpanded.add(item.scope);
    }
    setExpandedScopes(initialExpanded);
    setExpandedDiffs(new Set());
    setStage('preview');
  }, [mode.kind, initialIntent?.mode, labelDraft]);

  const fetchPreview = useCallback(async (unlockPassphrase?: string) => {
    previewAbortRef.current?.abort();
    const controller = new AbortController();
    previewAbortRef.current = controller;
    const seq = ++previewSeqRef.current;

    setLoadingPreview(true);
    setPreviewError(null);
    setSubmitError(null);
    setNeedsFreshPreview(false);

    const unlock = unlockPassphrase !== undefined && unlockPassphrase.length > 0
      ? { passphrase: unlockPassphrase }
      : undefined;

    try {
      const api = portableSpacesApi(client);
      let loaded: PortableSpaceSubscribePreviewManifest;
      if (mode.kind === 'new') {
        const source = sourceTab === 'archive'
          ? { kind: 'archive' as const, path: archivePath.trim() }
          : { kind: 'url' as const, url: urlDraft.trim() };
        loaded = await api.previewSubscribe(
          { source, linkToSpaceId: targetSpaceId, unlock },
          { signal: controller.signal },
        );
      } else {
        loaded = await api.previewSource(
          mode.source.id,
          unlock !== undefined ? { unlock } : {},
          { signal: controller.signal },
        );
      }
      if (seq !== previewSeqRef.current || controller.signal.aborted) return;
      applyLoadedManifest(loaded);
    } catch (caught) {
      if (seq !== previewSeqRef.current || controller.signal.aborted) return;
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      if (isPortableUnlockRequiredError(caught)) {
        setStage('unlock');
        setPreviewError(unlockPassphrase !== undefined ? caught : null);
      } else {
        setPreviewError(caught);
      }
    } finally {
      if (seq === previewSeqRef.current) {
        setLoadingPreview(false);
      }
    }
  }, [client, mode, sourceTab, archivePath, urlDraft, targetSpaceId, applyLoadedManifest]);

  // Existing-source review / edit-selection automatically loads its preview on open.
  useEffect(() => {
    if (mode.kind === 'update-review' || mode.kind === 'edit-selection') {
      void fetchPreview();
    }
    // Intentionally keyed on mode identity, not selection state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode.kind, mode.kind === 'new' ? null : mode.source.id]);

  // Native file drop listener scoped strictly to the archive drop zone when visible.
  useEffect(() => {
    if (mode.kind !== 'new' || stage !== 'input' || sourceTab !== 'archive' || host.onFileDrop === undefined) {
      return undefined;
    }
    return host.onFileDrop((drop) => {
      const zone = dropZoneRef.current;
      if (zone === null) return;
      if (drop.position !== undefined) {
        const rect = zone.getBoundingClientRect();
        const inside =
          drop.position.x >= rect.left
          && drop.position.x <= rect.right
          && drop.position.y >= rect.top
          && drop.position.y <= rect.bottom;
        if (!inside) return;
      }
      if (drop.paths.length !== 1 || !isSupportedPortableArchivePath(drop.paths[0] ?? '')) {
        setDropFeedback({ tone: 'error', text: t('st.portable.center.dropInvalid') });
        return;
      }
      setArchivePath(drop.paths[0]!);
      setInputIssue(null);
      setDropFeedback(null);
    });
  }, [host, mode.kind, stage, sourceTab, t]);

  const manifestIndex = useMemo(
    () => (manifest === null ? null : normalizePreviewManifest(manifest)),
    [manifest],
  );

  const evaluation = useMemo(() => {
    if (manifest === null || selection === null || manifestIndex === null) return null;
    return evaluateSubscriptionSelection(manifest, selection, bindings, manifestIndex);
  }, [manifest, selection, bindings, manifestIndex]);

  const deselectedManagedCount = useMemo(() => {
    if (mode.kind !== 'edit-selection' || manifest === null || evaluation === null) return 0;
    const managedSet = new Set(mode.source.managedIds ?? []);
    if (managedSet.size === 0) return 0;
    let count = 0;
    for (const item of manifest.items) {
      if (!item.selectable) continue;
      const isManaged = item.memberUnitIds.some((unitId) => managedSet.has(unitId)) || managedSet.has(item.id);
      if (isManaged && !evaluation.selectedItemIds.has(item.id)) {
        count += 1;
      }
    }
    return count;
  }, [mode, manifest, evaluation]);

  // Selection or binding edits invalidate any previously reviewed cleanup impact digest.
  const handleSelectionChange = useCallback((next: PortableSpaceSubscriptionSelection) => {
    setSelection(next);
    setReviewedImpact(null);
    setSubmitError(null);
  }, []);

  const handleBindingsChange = useCallback((next: PortableSpaceBindingChoices) => {
    setBindings(next);
    setReviewedImpact(null);
    setSubmitError(null);
  }, []);

  const handleStartPreview = () => {
    if (loadingPreview || submitting) return;
    if (sourceTab === 'url') {
      const trimmed = urlDraft.trim();
      if (trimmed === '') {
        setInputIssue(t('st.portable.linkPathRequired'));
        return;
      }
    } else if (sourceTab === 'archive') {
      const trimmed = archivePath.trim();
      if (trimmed === '') {
        setInputIssue(t('st.portable.linkPathRequired'));
        return;
      }
      if (!isSupportedPortableArchivePath(trimmed)) {
        setInputIssue(t('st.portable.center.dropInvalid'));
        return;
      }
    }
    setInputIssue(null);
    void fetchPreview();
  };

  const handleLegacyLinkSubmit = async () => {
    if (submitting) return;
    const trimmed = legacyTarget.trim();
    if (trimmed === '') {
      setInputIssue(t('st.portable.linkPathRequired'));
      return;
    }
    setSubmitting(true);
    setPreviewError(null);
    try {
      const endpoint: PortableSpaceEndpoint = legacyKind === 'git'
        ? {
          kind: 'git',
          repo: trimmed,
          ref: gitRef.trim() || undefined,
          subpath: gitSubpath.trim() || undefined,
        }
        : { kind: 'dir', path: trimmed };
      const record = await portableSpacesApi(client).registerSource({
        endpoint,
        label: labelDraft.trim() || undefined,
        unlock: passphrase.length > 0 ? { passphrase } : undefined,
      });
      setPassphrase('');
      onDone({ kind: 'linked', record });
    } catch (caught) {
      setSubmitting(false);
      setPreviewError(caught);
    }
  };

  const handleReviewCleanupImpact = async () => {
    if (mode.kind !== 'edit-selection' || manifest === null || selection === null || reviewingCleanup) return;
    setReviewingCleanup(true);
    setSubmitError(null);
    try {
      const reviewed = await portableSpacesApi(client).previewSource(mode.source.id, {
        previewToken: manifest.previewToken,
        selection,
        cleanupDeselected: true,
        ...bindings,
      });
      if (reviewed.impact !== undefined && reviewed.impactDigest !== undefined) {
        setReviewedImpact({ impact: reviewed.impact, impactDigest: reviewed.impactDigest });
      }
    } catch (caught) {
      setSubmitError(caught);
      if (isPortablePreviewStaleError(caught) || isPortablePreviewExpiredError(caught)) {
        setNeedsFreshPreview(true);
      }
    } finally {
      setReviewingCleanup(false);
    }
  };

  const handleConfirm = async () => {
    if (manifest === null || selection === null || evaluation === null || submitting || needsFreshPreview) return;
    const canProceed = mode.kind === 'edit-selection' ? evaluation.canConfirmEdit : evaluation.canConfirmInitial;
    if (!canProceed) return;
    if (mode.kind === 'edit-selection' && cleanupDeselected && deselectedManagedCount > 0 && reviewedImpact === null) {
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      const api = portableSpacesApi(client);
      if (mode.kind === 'new') {
        const commit = await api.subscribe({
          previewToken: manifest.previewToken,
          selection,
          syncPolicy,
          label: labelDraft.trim().slice(0, 120) || undefined,
          createBackup: true,
          ...bindings,
        });
        setPassphrase('');
        onDone({ kind: 'commit', commit });
      } else if (mode.kind === 'update-review') {
        const commit = await api.syncSubscription(mode.source.id, {
          previewToken: manifest.previewToken,
          createBackup: true,
          ...bindings,
        });
        setPassphrase('');
        onDone({ kind: 'commit', commit });
      } else {
        const doPurge = cleanupDeselected && deselectedManagedCount > 0;
        const result = await api.patchSource(mode.source.id, {
          previewToken: manifest.previewToken,
          selection,
          cleanupDeselected: doPurge,
          ...(doPurge && reviewedImpact !== null ? { impactDigest: reviewedImpact.impactDigest } : {}),
          createBackup: true,
          ...bindings,
        });
        setPassphrase('');
        onDone({ kind: 'patch', result });
      }
    } catch (caught) {
      setSubmitting(false);
      setSubmitError(caught);
      if (isPortablePreviewStaleError(caught) || isPortablePreviewExpiredError(caught)) {
        setNeedsFreshPreview(true);
      }
    }
  };

  const spaceChoices = useMemo(
    () => (spaces.length > 0
      ? spaces.map((s) => ({ value: s.id, label: s.id === MAIN_SPACE_ID ? t('st.spaces.main') : s.name }))
      : [{ value: MAIN_SPACE_ID, label: t('st.spaces.main') }]),
    [spaces, t],
  );

  const targetSpaceLabel = spaceChoices.find((s) => s.value === (manifest?.targetSpaceId ?? targetSpaceId))?.label
    ?? t('st.spaces.main');

  const modalTitle = mode.kind === 'update-review'
    ? t('st.portable.center.reviewTitle', { name: mode.source.label })
    : mode.kind === 'edit-selection'
      ? t('st.portable.center.editTitle', { name: mode.source.label })
      : stage === 'preview' && manifest !== null
        ? (labelDraft.trim() || manifest.suggestedLabel)
        : isDeepLinkOrigin
          ? t('st.portable.center.deepLinkOriginTitle', { origin: extractSubscriptionOrigin(initialIntent.url) })
          : t('st.portable.center.modalTitle');

  const toggleScopeExpanded = (scope: PortableSubscriptionScope) => {
    setExpandedScopes((current) => {
      const next = new Set(current);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  };

  const toggleDiffExpanded = (itemId: string) => {
    setExpandedDiffs((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  const totalSelectableCount = useMemo(
    () => (manifest?.items.filter((item) => item.selectable).length ?? 0),
    [manifest],
  );

  const hasAnyCredentials = useMemo(() => {
    if (manifest === null) return false;
    if (manifest.secretMode !== 'none') return true;
    return manifest.items.some((item) => item.coupledCredentialIds.length > 0);
  }, [manifest]);

  const canConfirm = evaluation !== null
    && !submitting
    && !loadingPreview
    && !needsFreshPreview
    && (mode.kind === 'edit-selection' ? evaluation.canConfirmEdit : evaluation.canConfirmInitial)
    && !(mode.kind === 'edit-selection' && cleanupDeselected && deselectedManagedCount > 0 && reviewedImpact === null);

  const confirmGateMessage = useMemo(() => {
    if (evaluation === null) return null;
    if (evaluation.hasHardBlockers) {
      return t('st.portable.center.hardBlockerGate', { count: evaluation.blockedByItemId.size });
    }
    const missingBindings = evaluation.unresolvedRequiredSlots.length + evaluation.invalidTargetSlots.length;
    if (missingBindings > 0) {
      return t('st.portable.center.bindingUnresolvedGate', { count: missingBindings });
    }
    if (mode.kind !== 'edit-selection' && evaluation.selectedItemIds.size === 0) {
      return t('st.portable.center.noItemsSelected');
    }
    return null;
  }, [evaluation, mode.kind, t]);

  const confirmButtonLabel = useMemo(() => {
    if (submitting) return t('st.portable.center.confirming');
    const count = evaluation?.selectedItemIds.size ?? 0;
    if (mode.kind === 'update-review') return t('st.portable.center.confirmUpdate', { count });
    if (mode.kind === 'edit-selection') {
      if (cleanupDeselected && reviewedImpact !== null) {
        return t('st.portable.center.confirmEditPurge', { count: reviewedImpact.impact.deletedIds.length });
      }
      return t('st.portable.center.confirmEdit');
    }
    if (syncPolicy === 'once') return t('st.portable.center.confirmImportOnce', { count });
    return t('st.portable.center.confirmSubscribe', { count });
  }, [submitting, evaluation, mode.kind, cleanupDeselected, reviewedImpact, syncPolicy, t]);

  const policyHint = syncPolicy === 'auto'
    ? t('st.portable.center.policyAutoHint')
    : syncPolicy === 'manual'
      ? t('st.portable.center.policyManualHint')
      : t('st.portable.center.policyOnceHint');

  return (
    <Dialog
      stacked
      ariaLabel={modalTitle}
      overlayId="portable-subscribe-modal"
      overlayClassName={DIALOG_SHEET_OVERLAY_CLASS}
      panelClassName={UNFRAMED_MODAL_PANEL_CLASS}
      dismissible={!submitting}
      onClose={closeCleanly}
      overlayData={{ 'data-portable-subscribe-modal': stage }}
    >
      {/* Header */}
      <div className="flex shrink-0 items-start justify-between gap-4 border-b border-hairline px-6 py-4">
        <div className="min-w-0">
          <h2 className="font-sans text-[18px] leading-[26px] font-bold text-ink" data-portable-modal-title>
            {modalTitle}
          </h2>
          {stage === 'preview' && manifest !== null ? (
            <p className="mt-0.5 truncate text-[12px] leading-4 text-ink-faint" data-portable-modal-subtitle>
              <span className="font-mono">{manifest.displayOrigin}</span>
              {' · '}
              {manifest.format === 'age' ? '.kiki.age' : manifest.format === 'tgz' ? '.kiki.tgz' : manifest.format}
              {' · '}
              {t('st.portable.center.targetSpace')}: {targetSpaceLabel}
            </p>
          ) : queuedCount > 0 ? (
            <p className="mt-0.5 text-[12px] leading-4 text-ink-soft" data-portable-queued-notice>
              {t('st.portable.center.queuedIntentsNotice', { count: queuedCount })}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={closeCleanly}
          disabled={submitting}
          aria-label={t('common.close')}
          data-portable-modal-close
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:h-11 pointer-coarse:w-11"
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      {/* Scrollable Body */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-6 py-5">
        {stage === 'input' && mode.kind === 'new' ? (
          <div className="space-y-5" data-portable-stage-input>
            {isDeepLinkOrigin ? (
              <div className="space-y-4" data-portable-deeplink-origin>
                <p className="text-[14px] leading-[21px] text-ink-soft">
                  {t('st.portable.center.deepLinkOriginHint')}
                </p>
                <dl className="divide-y divide-hairline border-t border-b border-hairline text-[13px] leading-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2 py-2.5">
                    <dt className="text-ink-soft">{t('st.portable.linkUrl')}</dt>
                    <dd className="min-w-0 break-all font-mono text-[12px] leading-4 text-ink" data-portable-deeplink-url>
                      {maskSubscriptionUrl(initialIntent.url)}
                    </dd>
                  </div>
                  {labelDraft.trim() !== '' ? (
                    <div className="flex flex-wrap items-baseline justify-between gap-2 py-2.5">
                      <dt className="text-ink-soft">{t('st.portable.linkLabel')}</dt>
                      <dd className="text-ink" data-portable-deeplink-name>{labelDraft}</dd>
                    </div>
                  ) : null}
                  {spaces.length > 1 ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                      <dt className="text-ink-soft">{t('st.portable.center.targetSpace')}</dt>
                      <dd className="w-56">
                        <SettingsSelect<string>
                          ariaLabel={t('st.portable.center.targetSpace')}
                          dataAttr="data-portable-target-space"
                          value={targetSpaceId}
                          onChange={setTargetSpaceId}
                          choices={spaceChoices}
                        />
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </div>
            ) : (
              <>
                <SettingsSegmented<NewSourceTab>
                  ariaLabel={t('st.portable.linkKind')}
                  dataAttr="data-portable-source-tab"
                  value={sourceTab}
                  onChange={(next) => {
                    setSourceTab(next);
                    setInputIssue(null);
                    setPreviewError(null);
                    setDropFeedback(null);
                    setPassphrase('');
                  }}
                  choices={[
                    { value: 'url', label: t('st.portable.center.sourceKindUrl') },
                    { value: 'archive', label: t('st.portable.center.sourceKindArchive') },
                    { value: 'legacy', label: t('st.portable.center.sourceKindLegacy') },
                  ]}
                />

                {sourceTab === 'url' ? (
                  <div className="space-y-4">
                    <div>
                      <label htmlFor={urlInputId} className={FORM_LABEL}>{t('st.portable.linkUrl')}</label>
                      <div className="mt-1.5 flex gap-2">
                        <input
                          id={urlInputId}
                          data-autofocus
                          data-portable-url-input
                          value={urlDraft}
                          spellCheck={false}
                          autoComplete="off"
                          placeholder={t('st.portable.linkUrlPlaceholder')}
                          aria-invalid={inputIssue !== null}
                          aria-describedby={inputIssue !== null ? urlIssueId : undefined}
                          onChange={(event) => {
                            setUrlDraft(event.target.value);
                            setInputIssue(null);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              handleStartPreview();
                            }
                          }}
                          className={`${INPUT} min-w-0 flex-1 font-mono text-[12px] leading-4`}
                        />
                        {typeof navigator !== 'undefined' && navigator.clipboard?.readText !== undefined ? (
                          <button
                            type="button"
                            data-portable-url-paste
                            className={`${SECONDARY_BUTTON} shrink-0 pointer-coarse:min-h-11`}
                            onClick={() => {
                              void navigator.clipboard.readText()
                                .then((text) => {
                                  if (text.trim()) {
                                    setUrlDraft(text.trim());
                                    setInputIssue(null);
                                  }
                                })
                                .catch(() => undefined);
                            }}
                          >
                            {t('st.portable.center.pasteUrl')}
                          </button>
                        ) : null}
                      </div>
                      <FieldIssue id={urlIssueId} text={inputIssue} />
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label htmlFor={labelInputId} className={FORM_LABEL}>{t('st.portable.linkLabel')}</label>
                        <input
                          id={labelInputId}
                          data-portable-label-input
                          value={labelDraft}
                          maxLength={120}
                          placeholder={t('st.portable.linkLabelPlaceholder')}
                          onChange={(event) => { setLabelDraft(event.target.value); }}
                          className={`${INPUT} mt-1.5`}
                        />
                      </div>
                      {spaces.length > 1 ? (
                        <div>
                          <span className={FORM_LABEL}>{t('st.portable.center.targetSpace')}</span>
                          <div className="mt-1.5">
                            <SettingsSelect<string>
                              variant="form"
                              ariaLabel={t('st.portable.center.targetSpace')}
                              dataAttr="data-portable-target-space"
                              value={targetSpaceId}
                              onChange={setTargetSpaceId}
                              choices={spaceChoices}
                            />
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {sourceTab === 'archive' ? (
                  <div className="space-y-4">
                    <div
                      ref={dropZoneRef}
                      data-portable-archive-dropzone
                      className="space-y-3 border-t border-b border-hairline py-4"
                    >
                      <p className="text-[13px] leading-5 text-ink-soft">{t('st.portable.center.archiveDropHint')}</p>
                      <div className="flex flex-wrap gap-2">
                        <input
                          id={urlInputId}
                          data-autofocus
                          data-portable-archive-input
                          value={archivePath}
                          spellCheck={false}
                          autoComplete="off"
                          placeholder={t('st.portable.center.archivePathPlaceholder')}
                          aria-invalid={inputIssue !== null}
                          aria-describedby={inputIssue !== null ? urlIssueId : undefined}
                          onChange={(event) => {
                            setArchivePath(event.target.value);
                            setInputIssue(null);
                            setDropFeedback(null);
                          }}
                          className={`${INPUT} min-w-0 flex-1 font-mono text-[12px] leading-4`}
                        />
                        {host.pickFilePath !== undefined ? (
                          <button
                            type="button"
                            data-portable-archive-pick
                            className={`${SECONDARY_BUTTON} shrink-0 pointer-coarse:min-h-11`}
                            onClick={() => {
                              void host.pickFilePath?.()
                                .then((picked) => {
                                  if (picked === null) return;
                                  if (!isSupportedPortableArchivePath(picked)) {
                                    setDropFeedback({ tone: 'error', text: t('st.portable.center.dropInvalid') });
                                    return;
                                  }
                                  setArchivePath(picked);
                                  setInputIssue(null);
                                  setDropFeedback(null);
                                })
                                .catch((error: unknown) => {
                                  setDropFeedback({ tone: 'error', text: errorText(locale, error) });
                                });
                            }}
                          >
                            {t('st.portable.center.archivePick')}
                          </button>
                        ) : null}
                      </div>
                      <FieldIssue id={urlIssueId} text={inputIssue} />
                      <FeedbackLine feedback={dropFeedback} />
                    </div>

                    {spaces.length > 1 ? (
                      <div className="max-w-xs">
                        <span className={FORM_LABEL}>{t('st.portable.center.targetSpace')}</span>
                        <div className="mt-1.5">
                          <SettingsSelect<string>
                            variant="form"
                            ariaLabel={t('st.portable.center.targetSpace')}
                            dataAttr="data-portable-target-space"
                            value={targetSpaceId}
                            onChange={setTargetSpaceId}
                            choices={spaceChoices}
                          />
                        </div>
                      </div>
                    ) : null}

                    <p className="text-[12px] leading-4 text-ink-faint">{t('st.portable.center.archiveOnceOnly')}</p>
                  </div>
                ) : null}

                {sourceTab === 'legacy' ? (
                  <div className="space-y-4" data-portable-legacy-link>
                    <SettingsSegmented<LegacyKind>
                      ariaLabel={t('st.portable.linkKind')}
                      dataAttr="data-portable-legacy-kind"
                      value={legacyKind}
                      onChange={(next) => {
                        setLegacyKind(next);
                        setInputIssue(null);
                      }}
                      choices={[
                        { value: 'dir', label: t('st.portable.linkKindDir') },
                        { value: 'git', label: t('st.portable.linkKindGit') },
                      ]}
                    />

                    <div>
                      <label htmlFor={urlInputId} className={FORM_LABEL}>
                        {t(legacyKind === 'git' ? 'st.portable.linkRepo' : 'st.portable.linkPath')}
                      </label>
                      <div className="mt-1.5 flex gap-2">
                        <input
                          id={urlInputId}
                          data-autofocus
                          data-portable-link-target
                          value={legacyTarget}
                          spellCheck={false}
                          autoComplete="off"
                          placeholder={legacyKind === 'git' ? 'https://github.com/example/kiki-space.git' : '/path/to/space-dir'}
                          onChange={(event) => {
                            setLegacyTarget(event.target.value);
                            setInputIssue(null);
                          }}
                          className={`${INPUT} min-w-0 flex-1 font-mono text-[12px] leading-4`}
                        />
                        {legacyKind === 'dir' && host.pickDirectory !== undefined ? (
                          <button
                            type="button"
                            data-portable-link-browse
                            className={`${SECONDARY_BUTTON} shrink-0 pointer-coarse:min-h-11`}
                            onClick={() => {
                              void host.pickDirectory?.()
                                .then((picked) => {
                                  if (picked !== null) {
                                    setLegacyTarget(picked);
                                    setInputIssue(null);
                                  }
                                })
                                .catch((error: unknown) => {
                                  setPreviewError(error);
                                });
                            }}
                          >
                            {t('st.spaces.browse')}
                          </button>
                        ) : null}
                      </div>
                      <FieldIssue id={urlIssueId} text={inputIssue} />
                    </div>

                    {legacyKind === 'git' ? (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <label className={FORM_LABEL}>{t('st.portable.linkRef')}</label>
                          <input
                            data-portable-link-ref
                            value={gitRef}
                            spellCheck={false}
                            placeholder="main"
                            onChange={(event) => { setGitRef(event.target.value); }}
                            className={`${INPUT} mt-1.5 font-mono text-[12px] leading-4`}
                          />
                        </div>
                        <div>
                          <label className={FORM_LABEL}>{t('st.portable.linkSubpath')}</label>
                          <input
                            data-portable-link-subpath
                            value={gitSubpath}
                            spellCheck={false}
                            placeholder="spaces/work"
                            onChange={(event) => { setGitSubpath(event.target.value); }}
                            className={`${INPUT} mt-1.5 font-mono text-[12px] leading-4`}
                          />
                        </div>
                      </div>
                    ) : null}

                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label htmlFor={labelInputId} className={FORM_LABEL}>{t('st.portable.linkLabel')}</label>
                        <input
                          id={labelInputId}
                          data-portable-link-label
                          value={labelDraft}
                          maxLength={120}
                          placeholder={t('st.portable.linkLabelPlaceholder')}
                          onChange={(event) => { setLabelDraft(event.target.value); }}
                          className={`${INPUT} mt-1.5`}
                        />
                      </div>
                      <div>
                        <label htmlFor={passphraseInputId} className={FORM_LABEL}>{t('st.portable.passphraseOptionalLabel')}</label>
                        <input
                          id={passphraseInputId}
                          type="password"
                          data-portable-link-passphrase
                          value={passphrase}
                          autoComplete="off"
                          placeholder={t('st.portable.passphrasePlaceholder')}
                          onChange={(event) => { setPassphrase(event.target.value); }}
                          className={`${INPUT} mt-1.5`}
                        />
                      </div>
                    </div>
                  </div>
                ) : null}
              </>
            )}

            {previewError !== null ? <InlineError error={previewError} /> : null}
          </div>
        ) : null}

        {stage === 'unlock' ? (
          <form
            className="space-y-4"
            data-portable-stage-unlock
            onSubmit={(event) => {
              event.preventDefault();
              if (passphrase.length === 0 || loadingPreview) return;
              void fetchPreview(passphrase);
            }}
          >
            <p className="text-[14px] leading-[21px] text-ink-soft">{t('st.portable.center.unlockPrompt')}</p>
            <div>
              <label htmlFor={passphraseInputId} className={FORM_LABEL}>{t('st.portable.passphraseLabel')}</label>
              <input
                id={passphraseInputId}
                type="password"
                data-autofocus
                data-portable-unlock-passphrase
                value={passphrase}
                autoComplete="off"
                placeholder={t('st.portable.passphrasePlaceholder')}
                onChange={(event) => { setPassphrase(event.target.value); }}
                className={`${INPUT} mt-1.5 max-w-md`}
              />
            </div>
            {previewError !== null ? <InlineError error={previewError} /> : null}
          </form>
        ) : null}

        {stage === 'preview' ? (
          <div className="space-y-5" data-portable-stage-preview>
            {loadingPreview && manifest === null ? (
              <p className="py-6 text-[14px] leading-[21px] text-ink-soft" data-portable-preview-loading>
                {t('st.portable.center.fetchingPreview')}
              </p>
            ) : null}

            {previewError !== null && manifest === null ? (
              <div className="space-y-3" data-portable-preview-error>
                <InlineError error={previewError} />
                <button
                  type="button"
                  data-portable-preview-retry
                  className={SECONDARY_BUTTON}
                  onClick={() => { void fetchPreview(); }}
                >
                  {t('common.retry')}
                </button>
              </div>
            ) : null}

            {manifest !== null && selection !== null && evaluation !== null && manifestIndex !== null ? (
              <>
                {/* 3-State Sync Policy (new subscription/import only) */}
                {mode.kind === 'new' ? (
                  <div className="space-y-1.5" data-portable-sync-policy>
                    <span className={FORM_LABEL}>{t('st.portable.center.policyLabel')}</span>
                    <SettingsSegmented<PortableSpaceSyncPolicy>
                      ariaLabel={t('st.portable.center.policyLabel')}
                      dataAttr="data-portable-policy-choice"
                      value={syncPolicy}
                      disabled={submitting}
                      onChange={setSyncPolicy}
                      choices={[
                        {
                          value: 'auto',
                          label: t('st.portable.center.policyAuto'),
                          disabled: !manifest.allowedPolicies.includes('auto'),
                        },
                        {
                          value: 'manual',
                          label: t('st.portable.center.policyManual'),
                          disabled: !manifest.allowedPolicies.includes('manual'),
                        },
                        {
                          value: 'once',
                          label: t('st.portable.center.policyOnce'),
                          disabled: !manifest.allowedPolicies.includes('once'),
                        },
                      ]}
                    />
                    <p className="text-[12px] leading-4 text-ink-soft">
                      {!manifest.allowedPolicies.includes('auto') && manifest.allowedPolicies.length === 1
                        ? t('st.portable.center.archiveOnceOnly')
                        : !manifest.allowedPolicies.includes('auto') && manifest.encryptionMode === 'passphrase'
                          ? t('st.portable.center.passphraseManualOnly')
                          : policyHint}
                    </p>
                  </div>
                ) : null}

                {/* Security Exclusions (read-only hairline strip, never checkable) */}
                {manifest.excluded.length > 0 ? (
                  <div className="border-t border-b border-hairline py-2.5" data-portable-excluded-strip>
                    <button
                      type="button"
                      aria-expanded={excludedOpen}
                      data-portable-excluded-toggle
                      onClick={() => { setExcludedOpen((open) => !open); }}
                      className="flex min-h-[28px] w-full items-center justify-between gap-2 text-left text-[13px] leading-5 font-normal text-amber-ink pointer-coarse:min-h-11"
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <DisclosureChevron open={excludedOpen} />
                        <span>{t('st.portable.center.excludedSummary', { count: manifest.excluded.length })}</span>
                      </span>
                    </button>
                    {excludedOpen ? (
                      <ul className="mt-2 space-y-1 pl-5 text-[12px] leading-4 text-ink-soft" data-portable-excluded-items>
                        {manifest.excluded.map((entry) => (
                          <li key={entry.id} className="flex flex-wrap gap-x-2">
                            <span className="font-mono text-ink">{entry.path}</span>
                            <span className="text-ink-faint">{entry.reason}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}

                {/* 6-Scope Selective Tree */}
                <div className="space-y-2.5" data-portable-selection-tree>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-[13px] leading-5 font-normal text-ink">
                      {t('st.portable.center.selectItemsHeading')}
                    </h3>
                    <span className="text-[12px] leading-4 tabular-nums text-ink-soft" data-portable-selected-counter>
                      {t('st.portable.center.selectedTotal', {
                        selected: evaluation.selectedItemIds.size,
                        total: totalSelectableCount,
                      })}
                    </span>
                  </div>

                  {manifest.manifestTruncated ? (
                    <p className="text-[12px] leading-4 text-ink-faint">{t('st.portable.center.manifestTruncated')}</p>
                  ) : null}

                  <div className="divide-y divide-hairline border-t border-b border-hairline">
                    {evaluation.scopeSummaries.map((summary) => {
                      // Hide zero-item scopes per Frame Audit §1.
                      if (summary.totalCount === 0) return null;
                      const scopeItems = manifestIndex.itemsByScope.get(summary.scope) ?? [];
                      const hasExecutablePlugins = scopeItems.some((item) => item.domain === 'plugins');
                      const expanded = expandedScopes.has(summary.scope);
                      const scopeTitle = t(PORTABLE_SUBSCRIPTION_SCOPE_LABEL_KEY[summary.scope]);
                      const checkboxId = `portable-scope-${summary.scope}`;

                      return (
                        <div key={summary.scope} data-portable-scope-group={summary.scope}>
                          <div className="flex items-center gap-2.5 py-2.5 pointer-coarse:min-h-11">
                            {mode.kind !== 'update-review' ? (
                              <ScopeCheckbox
                                id={checkboxId}
                                scope={summary.scope}
                                state={summary.state}
                                disabled={submitting || summary.selectableCount === 0}
                                ariaLabel={scopeTitle}
                                onChange={(checked) => {
                                  handleSelectionChange(
                                    toggleSubscriptionScope(manifest, selection, summary.scope, checked, manifestIndex),
                                  );
                                }}
                              />
                            ) : null}
                            <button
                              type="button"
                              aria-expanded={expanded}
                              data-portable-scope-toggle={summary.scope}
                              onClick={() => { toggleScopeExpanded(summary.scope); }}
                              className="flex min-h-[28px] min-w-0 flex-1 items-center justify-between gap-3 text-left outline-none focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11"
                            >
                              <span className="inline-flex min-w-0 items-center gap-1.5 text-[13px] leading-5 font-normal text-ink">
                                <DisclosureChevron open={expanded} className="shrink-0 text-ink-faint" />
                                <span className="truncate">{scopeTitle}</span>
                                {hasExecutablePlugins ? (
                                  <span
                                    data-portable-executable-scope-badge={summary.scope}
                                    className="shrink-0 rounded-sm bg-attention/12 px-1.5 py-0.5 text-[11px] leading-3.5 font-normal text-amber-ink"
                                  >
                                    {t('st.portable.center.executablePluginTag')}
                                  </span>
                                ) : null}
                              </span>
                              <span className="shrink-0 text-[12px] leading-4 tabular-nums text-ink-soft" data-portable-scope-count={summary.scope}>
                                {t('st.portable.center.scopeCount', {
                                  selected: summary.selectedCount,
                                  total: summary.selectableCount,
                                })}
                              </span>
                            </button>
                          </div>

                          {expanded ? (
                            <ul className="divide-y divide-hairline/60 pb-2 pl-6" data-portable-scope-items={summary.scope}>
                              {scopeItems.map((item) => {
                                const checked = evaluation.selectedItemIds.has(item.id);
                                const blockedDeps = evaluation.blockedByItemId.get(item.id);
                                const diffOpen = expandedDiffs.has(item.id);
                                const refNames = item.referencedByIds
                                  .map((refId) => manifestIndex.itemById.get(refId)?.label ?? refId)
                                  .slice(0, 2);
                                const modelReqPrompt = isModelRequiredPrompt(item, manifestIndex.itemById);

                                return (
                                  <li
                                    key={item.id}
                                    data-portable-preview-item={item.id}
                                    data-portable-item-status={item.status}
                                    className="py-2"
                                  >
                                    <div className="flex items-start gap-2.5">
                                      {mode.kind !== 'update-review' ? (
                                        <input
                                          type="checkbox"
                                          data-portable-item-check={item.id}
                                          aria-label={item.label}
                                          checked={checked}
                                          disabled={submitting || !item.selectable}
                                          onChange={(event) => {
                                            handleSelectionChange(
                                              toggleSubscriptionItem(
                                                manifest,
                                                selection,
                                                item.id,
                                                event.target.checked,
                                                manifestIndex,
                                              ),
                                            );
                                          }}
                                          className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-[var(--color-selected-ink)] disabled:cursor-not-allowed"
                                        />
                                      ) : null}

                                      <div className="min-w-0 flex-1 space-y-0.5">
                                        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                                          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                                            <span className={`text-[13px] leading-5 ${item.selectable ? 'text-ink' : 'text-ink-faint'}`}>
                                              {item.label}
                                            </span>
                                            <span className="truncate font-mono text-[12px] leading-4 text-ink-faint">{item.path}</span>
                                            {item.domain === 'plugins' ? (
                                              <span
                                                data-portable-executable-plugin-tag={item.id}
                                                className="shrink-0 rounded-sm bg-attention/12 px-1.5 py-0.5 text-[11px] leading-3.5 font-normal text-amber-ink"
                                              >
                                                {t('st.portable.center.executablePluginTag')}
                                              </span>
                                            ) : null}
                                            {modelReqPrompt ? (
                                              <span className="text-[12px] leading-4 font-normal text-selected-ink" data-portable-model-required-tag={item.id}>
                                                {t('st.portable.center.modelRequiredTag')}
                                              </span>
                                            ) : null}
                                          </div>
                                          <span className={`shrink-0 text-[12px] leading-4 ${statusToneClass(item.status)}`}>
                                            {formatStatusLabel(item, t)}
                                          </span>
                                        </div>

                                        {item.referencedByIds.length > 0 ? (
                                          <p className="text-[12px] leading-4 text-ink-faint" data-portable-referenced-by={item.id}>
                                            {item.referencedByIds.length === 1
                                              ? t('st.portable.center.referencedByOne', { name: refNames[0] ?? '' })
                                              : t('st.portable.center.referencedBy', {
                                                names: refNames.join(locale === 'zh' ? '、' : ', '),
                                                count: item.referencedByIds.length,
                                              })}
                                          </p>
                                        ) : null}

                                        {item.reason !== undefined ? (
                                          <p className="text-[12px] leading-4 text-ink-soft">{item.reason}</p>
                                        ) : null}

                                        {blockedDeps !== undefined && blockedDeps.length > 0 ? (
                                          <p className="text-[12px] leading-4 text-danger-ink" data-portable-item-blocker={item.id}>
                                            {t('st.portable.center.blockedByDeps', {
                                              deps: blockedDeps
                                                .map((depId) => manifestIndex.itemById.get(depId)?.label ?? depId)
                                                .join(', '),
                                            })}
                                          </p>
                                        ) : null}

                                        {item.safeDiff !== undefined ? (
                                          <div className="pt-1">
                                            <button
                                              type="button"
                                              data-portable-diff-toggle={item.id}
                                              aria-expanded={diffOpen}
                                              onClick={() => { toggleDiffExpanded(item.id); }}
                                              className="inline-flex items-center gap-1 text-[12px] leading-4 text-ink-soft hover:text-ink pointer-coarse:min-h-11"
                                            >
                                              <DisclosureChevron open={diffOpen} />
                                              <span>{t(diffOpen ? 'st.portable.center.diffHide' : 'st.portable.center.diffShow')}</span>
                                            </button>
                                            {diffOpen ? (
                                              <div className="mt-1.5 border-l-2 border-hairline pl-3" data-portable-diff-content={item.id}>
                                                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-4 text-ink-soft">
                                                  {item.safeDiff}
                                                </pre>
                                                {item.safeDiffTruncated ? (
                                                  <p className="mt-1 text-[12px] leading-4 text-ink-faint">
                                                    {t('st.portable.center.diffTruncated')}
                                                  </p>
                                                ) : null}
                                              </div>
                                            ) : null}
                                          </div>
                                        ) : null}
                                      </div>
                                    </div>
                                  </li>
                                );
                              })}
                            </ul>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>

                  {/* Coupled Credentials opt-in */}
                  {hasAnyCredentials && mode.kind !== 'update-review' ? (
                    <label className="inline-flex min-h-[32px] cursor-pointer items-center gap-2 pt-1 text-[13px] leading-5 text-ink pointer-coarse:min-h-11">
                      <input
                        type="checkbox"
                        data-portable-include-credentials
                        checked={selection.includeCredentials}
                        disabled={submitting}
                        onChange={(event) => {
                          handleSelectionChange({
                            ...selection,
                            includeCredentials: event.target.checked,
                          });
                        }}
                        className="h-4 w-4 shrink-0 accent-[var(--color-selected-ink)]"
                      />
                      <span>
                        {t('st.portable.center.credentialsToggle', { count: evaluation.coupledCredentialIds.length })}
                      </span>
                    </label>
                  ) : null}
                </div>

                {/* Inline Model Binding Step */}
                <ModelBindingSection
                  manifest={manifest}
                  evaluation={evaluation}
                  bindings={bindings}
                  disabled={submitting}
                  onChangeBindings={handleBindingsChange}
                />

                {/* Edit-Selection Deselected Cleanup Choice */}
                {mode.kind === 'edit-selection' && deselectedManagedCount > 0 ? (
                  <fieldset
                    className="space-y-2 border-t border-hairline pt-4"
                    data-portable-cleanup-section
                    disabled={submitting || reviewingCleanup}
                  >
                    <label className="flex cursor-pointer items-start gap-2.5 py-1 pointer-coarse:min-h-11">
                      <input
                        type="radio"
                        name={cleanupRadioName}
                        data-portable-cleanup-choice="keep"
                        checked={!cleanupDeselected}
                        onChange={() => {
                          setCleanupDeselected(false);
                          setReviewedImpact(null);
                        }}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-selected-ink)]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] leading-5 font-normal text-ink">
                          {t('st.portable.center.cleanupKeepLocal')}
                        </span>
                        <span className="block text-[12px] leading-4 text-ink-soft">
                          {t('st.portable.center.cleanupKeepLocalDesc', { count: deselectedManagedCount })}
                        </span>
                      </span>
                    </label>

                    <label className="flex cursor-pointer items-start gap-2.5 py-1 pointer-coarse:min-h-11">
                      <input
                        type="radio"
                        name={cleanupRadioName}
                        data-portable-cleanup-choice="purge"
                        checked={cleanupDeselected}
                        onChange={() => {
                          setCleanupDeselected(true);
                          setReviewedImpact(null);
                        }}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-danger)]"
                      />
                      <span className="min-w-0 flex-1 space-y-1.5">
                        <span className="block text-[13px] leading-5 font-normal text-ink">
                          {t('st.portable.center.cleanupPurge')}
                        </span>
                        <span className="block text-[12px] leading-4 text-ink-soft">
                          {t('st.portable.center.cleanupPurgeDesc')}
                        </span>
                        {cleanupDeselected && reviewedImpact === null ? (
                          <button
                            type="button"
                            data-portable-cleanup-review
                            disabled={reviewingCleanup}
                            className={`${SECONDARY_BUTTON} mt-1 pointer-coarse:min-h-11`}
                            onClick={() => { void handleReviewCleanupImpact(); }}
                          >
                            {reviewingCleanup
                              ? t('st.portable.center.cleanupReviewing')
                              : t('st.portable.center.cleanupReviewAction')}
                          </button>
                        ) : null}
                        {cleanupDeselected && reviewedImpact !== null ? (
                          <ul className="space-y-0.5 pt-1 text-[12px] leading-4 text-ink-soft" data-portable-cleanup-impact>
                            <li className="font-normal text-ink">
                              {t('st.portable.center.impactDeleted', { count: reviewedImpact.impact.deletedIds.length })}
                            </li>
                            {reviewedImpact.impact.preservedLocalIds.length > 0 ? (
                              <li>
                                {t('st.portable.center.impactPreservedLocal', {
                                  count: reviewedImpact.impact.preservedLocalIds.length,
                                })}
                              </li>
                            ) : null}
                            {reviewedImpact.impact.handedOffIds.length > 0 ? (
                              <li>
                                {t('st.portable.center.impactHandedOff', {
                                  count: reviewedImpact.impact.handedOffIds.length,
                                })}
                              </li>
                            ) : null}
                            {reviewedImpact.impact.preservedDependencyIds.length > 0 ? (
                              <li>
                                {t('st.portable.center.impactPreservedDep', {
                                  count: reviewedImpact.impact.preservedDependencyIds.length,
                                })}
                              </li>
                            ) : null}
                            {reviewedImpact.impact.pendingReconcileIds.length > 0 ? (
                              <li className="text-amber-ink">
                                {t('st.portable.center.impactPending', {
                                  count: reviewedImpact.impact.pendingReconcileIds.length,
                                })}
                              </li>
                            ) : null}
                          </ul>
                        ) : null}
                      </span>
                    </label>
                  </fieldset>
                ) : null}

                {submitError !== null ? (
                  <div className="space-y-2" data-portable-submit-error>
                    <InlineError error={submitError} />
                    {needsFreshPreview ? (
                      <button
                        type="button"
                        data-portable-refresh-preview
                        className={SECONDARY_BUTTON}
                        onClick={() => { void fetchPreview(); }}
                      >
                        {t('st.portable.center.refreshPreview')}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Pinned Footer (at most 1 primary CTA per step) */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-hairline bg-paper px-6 py-4 max-md:pb-[calc(1rem+var(--kiki-safe-bottom-inset))]">
        <div className="flex items-center gap-2">
          {stage === 'preview' && mode.kind === 'new' ? (
            <button
              type="button"
              data-portable-modal-back
              disabled={submitting}
              className={`${SECONDARY_BUTTON} pointer-coarse:min-h-11`}
              onClick={() => {
                setStage('input');
                setSubmitError(null);
              }}
            >
              {t('st.portable.center.back')}
            </button>
          ) : stage === 'unlock' && mode.kind === 'new' ? (
            <button
              type="button"
              data-portable-modal-back
              disabled={loadingPreview}
              className={`${SECONDARY_BUTTON} pointer-coarse:min-h-11`}
              onClick={() => {
                setPassphrase('');
                setStage('input');
              }}
            >
              {t('st.portable.center.back')}
            </button>
          ) : (
            <button
              type="button"
              data-portable-modal-cancel
              disabled={submitting}
              className={`${SECONDARY_BUTTON} pointer-coarse:min-h-11`}
              onClick={closeCleanly}
            >
              {t('common.cancel')}
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {stage === 'preview' && confirmGateMessage !== null ? (
            <span className="text-[12px] leading-4 text-amber-ink" data-portable-confirm-gate>
              {confirmGateMessage}
            </span>
          ) : null}

          {stage === 'input' && mode.kind === 'new' ? (
            sourceTab === 'legacy' ? (
              <button
                type="button"
                data-portable-link-submit
                disabled={submitting}
                className={`${PRIMARY_BUTTON} pointer-coarse:min-h-11`}
                onClick={() => { void handleLegacyLinkSubmit(); }}
              >
                {submitting ? t('common.saving') : t('st.portable.linkSubmit')}
              </button>
            ) : (
              <button
                type="button"
                data-portable-fetch-preview
                disabled={loadingPreview}
                className={`${PRIMARY_BUTTON} pointer-coarse:min-h-11`}
                onClick={handleStartPreview}
              >
                {loadingPreview ? t('st.portable.center.fetchingPreview') : t('st.portable.center.fetchPreview')}
              </button>
            )
          ) : null}

          {stage === 'unlock' ? (
            <button
              type="button"
              data-portable-unlock-confirm
              disabled={loadingPreview || passphrase.length === 0}
              className={`${PRIMARY_BUTTON} pointer-coarse:min-h-11`}
              onClick={() => { void fetchPreview(passphrase); }}
            >
              {loadingPreview ? t('st.portable.center.fetchingPreview') : t('st.portable.center.unlockSubmit')}
            </button>
          ) : null}

          {stage === 'preview' ? (
            <button
              type="button"
              data-portable-confirm-submit
              disabled={!canConfirm}
              className={`${PRIMARY_BUTTON} pointer-coarse:min-h-11`}
              onClick={() => { void handleConfirm(); }}
            >
              {confirmButtonLabel}
            </button>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
