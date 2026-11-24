/**
 * Single logic core shared by every agent workspace (`main`, `subagent`, and
 * `branch`). Owns timeline subscription/actions, draft/attachment/annotation
 * persistence and pending-submission recovery state, durable "Send now" receipt
 * tracking, model switching + dialog props, context auto-compact,
 * `MessageViewContext`, `InteractionPlacementContext` isolation, and unified
 * `Composer` prop assembly.
 *
 * Three legitimate architectural differences stay explicit on `policy`:
 * - Difference A (`mountHost`): `'seat'` (main registers into `ConversationShell`
 *   via `useRegisterSeat`) vs `'dock'` (child/branch docks inside `WorkspaceSurface`).
 * - Difference B (`busyPlainSendMode`): `'queue'` (main queues on busy Enter) vs
 *   `'steer'` (child/branch steers immediately on busy Enter when eligible).
 * - Difference C (`interactionPlacementMode`): `'tray'` (main aggregates in bottom
 *   tray) vs `'inline'` (embedded preview child isolates `{ inTray: false }` so
 *   approvals/questions are never absorbed by the main tray).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import type { DeferredAppendTiming, ExecutorCatalogItem, ListModelsResponse, PromptDeliveryReason, PromptItem } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';
import {
  boundExecutionChoice,
  flushDrafts,
  invalidatePendingSubmissionRetry,
  isPendingSubmissionInFlight,
  readComposerState,
  readDraft,
  readPendingSubmission,
  subscribeDraftAppends,
  subscribePendingSubmissions,
  writeComposerState,
  writeDraft,
  type ComposerAttachment,
  type ExecutionChoice,
  type PendingComposerSubmission,
} from '@kiki/session-core/composer';
import {
  MAIN_AGENT_ID,
  type AgentForest,
  type AgentTreeNode,
  type Block,
  type SessionController,
  type SessionViewState,
  type SubagentBlock,
} from '@kiki/session-core/session';
import { settingsCardRoute } from '@kiki/session-core/sessions';
import {
  settingsServerSnapshot,
  settingsSnapshot,
  subscribeSettings,
} from '@kiki/session-core/settings';

type LiveSettings = ReturnType<typeof settingsSnapshot>;

import { useI18n } from '../../i18n';
import {
  agentProfileCatalogQueryKey,
  agentProfileCatalogRefetchInterval,
  loadAgentProfileCatalog,
  type AgentProfileCatalogMode,
} from '../../lib/agentProfileCatalog';
import type { KikiConfigResponse } from '../../lib/client';
import { fsSearchRequestBody, type FsSearchPageArgs } from '../../lib/fsSearchFeed';
import { useProfileFilePreview } from '../../lib/profileFilePreview';
import { pushToast } from '../../lib/toasts';
import { useConnection } from '../../state/connection';
import { DEFAULT_AGENT_PROFILE, type Composer } from '../Composer';
import { useSessionHarness, type SessionHarness } from '../harness/sessionHarness';
import type { InteractionPlacement } from '../Interactions';
import type { MessageViewContextValue } from '../message/messageViewContext';
import type { ModelSwitchDialog } from '../model-switch/ModelSwitchDialog';
import { useModelSwitches, type ModelSwitchesHandle } from '../model-switch/useModelSwitches';
import { useExecutorCatalog } from '../settings/profileEditor/engines';
import { useContextMeterAutoCompact } from '../useContextMeterAutoCompact';
import { agentContinuationAvailable, useAgentTimeline, type AgentTimelineResult } from './useAgentTimeline';
import {
  normalizeStoredAnnotations,
  useConversationAnnotations,
  type UseConversationAnnotationsResult,
} from './useConversationAnnotations';
import {
  useModelSwitchFlow,
  type ModelSwitchDialogState,
  type UseModelSwitchFlowResult,
} from './useModelSwitchFlow';

export type WorkspaceMountHost = 'seat' | 'dock';
export type BusyPlainSendMode = 'queue' | 'steer';
export type WorkspaceInteractionPlacementMode = 'tray' | 'inline';

/** The agent identity a workspace renders; always resolved by the shell. */
export interface AgentWorkspaceTarget {
  readonly sessionId: string;
  readonly agentId: string;
}

/**
 * "Send now" delivery feedback, shared by the session composer and child
 * workspaces: the receipt names why a message did not join the running turn,
 * and a late durable read can still supply the reason when the first
 * acknowledgement has none.
 */
type SendNowOutcome = Awaited<ReturnType<SessionController['sendPromptNow']>>['outcome'];

const SEND_NOW_QUEUED_KEYS: Readonly<Record<PromptDeliveryReason, I18nKey>> = {
  no_active_turn: 'sv.steerQueuedNoActiveTurn',
  target_changed: 'sv.steerQueuedTargetChanged',
  prompt_no_longer_pending: 'sv.steerQueuedNotPending',
  steer_rejected: 'sv.steerQueuedRejected',
  external_retry: 'sv.steerQueuedExternalUnknown',
  executor_deferred: 'sv.steerQueuedExternal',
  model_switch_boundary: 'sv.steerQueuedModelBoundary',
};

export function sendNowQueuedNotice(reason: PromptDeliveryReason | undefined): I18nKey {
  return reason === undefined ? 'sv.steerQueued' : SEND_NOW_QUEUED_KEYS[reason];
}

export function sendNowNotice(
  outcome: SendNowOutcome,
  reason: PromptDeliveryReason | undefined,
): { readonly tone: 'info'; readonly key: I18nKey } | undefined {
  if (outcome === 'held') return { tone: 'info', key: reason === 'external_retry' ? 'sv.steerQueuedExternalUnknown' : 'sv.submissionRecovery.server' };
  if (outcome === 'not_pending') return { tone: 'info', key: 'sv.steerQueuedNotPending' };
  if (outcome === 'queued') return { tone: 'info', key: sendNowQueuedNotice(reason) };
  return undefined;
}

const MAX_OPEN_NOW_RECEIPTS = 20;

type NowReceiptDecision =
  | { readonly kind: 'drop' }
  | { readonly kind: 'wait' }
  | { readonly kind: 'report'; readonly reason: PromptDeliveryReason };

export function nowReceiptDecision(input: {
  readonly promptId: string;
  readonly reported: string | null;
  readonly ingress: readonly PromptItem[];
  readonly settled: boolean;
}): NowReceiptDecision {
  if (input.settled) return { kind: 'drop' };
  const record = input.ingress.find((item) => item.prompt_id === input.promptId);
  if (record === undefined) return { kind: 'wait' };
  if (record.admission === 'failed' || record.admission === 'cancelled'
    || record.status === 'running' || record.delivery_state === 'steered' || record.delivery_state === 'accepted'
    || record.delivery_state === 'failed' || record.delivery_state === 'cancelled') return { kind: 'drop' };
  if (record.admission !== 'admitted' || record.delivery_state !== 'queued' || record.delivery_reason === undefined) {
    return { kind: 'wait' };
  }
  if (input.reported !== null) return { kind: 'drop' };
  return { kind: 'report', reason: record.delivery_reason };
}

export function trackOpenNowReceipt(receipts: Map<string, string | null>, promptId: string, reason: string | null): void {
  receipts.set(promptId, reason);
  while (receipts.size > MAX_OPEN_NOW_RECEIPTS) {
    const oldest = receipts.keys().next().value;
    if (oldest === undefined) break;
    receipts.delete(oldest);
  }
}

/** Local inline interaction placement used when a child workspace renders embedded alongside main. */
export const INLINE_INTERACTION_PLACEMENT: InteractionPlacement = Object.freeze({ inTray: false });

type StoredComposerState = ReturnType<typeof readComposerState>;

export interface WorkspaceAutoCompactInput {
  readonly enabled: boolean;
  readonly modelId: string | undefined;
  readonly modelLabel: string | undefined;
  readonly maxContextTokens: number | undefined;
  readonly running: boolean;
  readonly profileName?: string;
  readonly profileCatalog?: Parameters<typeof useContextMeterAutoCompact>[0]['profileCatalog'];
}

export interface WorkspaceExecutionResolution {
  readonly currentModel: string | undefined;
  readonly carriedThinking: string | undefined;
  readonly profileDefaultEffort?: (toModel: string) => string | undefined;
  readonly autoCompact: WorkspaceAutoCompactInput;
  readonly busy: boolean;
  readonly canSteerNow?: boolean;
  readonly steerBusyBlocked?: boolean;
  readonly externalBindingSetting?: { readonly model: string; readonly thinking?: string };
  readonly sendTimingDefault?: DeferredAppendTiming;
  readonly sessionRecord?: SessionViewState['session'];
  readonly durableIngress?: readonly PromptItem[];
  readonly fsSearchEnabled?: boolean;
}

export interface MainProfileCatalogPolicy {
  readonly pendingProfile: string | undefined;
  readonly pendingExecution: ExecutionChoice | undefined;
}

export interface ChildBindingsPolicy {
  readonly selectedNode: AgentTreeNode | undefined;
  readonly selectedSubagent: SubagentBlock | undefined;
  readonly reportedExecutorId: string | undefined;
}

export interface AgentWorkspaceCorePolicy {
  /** Difference A: where `<Composer>` mounts (`'seat'` vs `'dock'`). */
  readonly mountHost: WorkspaceMountHost;
  /** Difference B: running-turn Enter default (`'queue'` vs `'steer'`). */
  readonly busyPlainSendMode: BusyPlainSendMode;
  /** Difference C: approval/question placement scope (`'tray'` vs `'inline'`). */
  readonly interactionPlacementMode: WorkspaceInteractionPlacementMode;
  /** Storage key for draft, attachments, annotations, and pending-submission recovery. */
  readonly storageKey: string;
  /** Scope string matching pending-submission records (defaults to `storageKey`). */
  readonly sendScope?: string;
  /** Whether this workspace's timeline is visible (controls child demand lease). */
  readonly visible?: boolean;
  /** Shell-owned session state & forest for non-main targets. */
  readonly sessionState?: SessionViewState;
  readonly forest?: AgentForest;
  /** Optional initial attachments override (e.g. main's `/new` hand-off). */
  readonly initialAttachments?: readonly ComposerAttachment[];
  /**
   * Initialize draft synchronously from storage (`true`, default for child) or
   * inside the mount effect (`false`, preserving main's `/new` hand-off order).
   */
  readonly syncInitialDraft?: boolean;
  /** Whether to mirror `attachments` and `annotations` into `writeComposerState`. Defaults to `true`. */
  readonly persistComposerState?: boolean;
  /** Optional sibling chrome fields persisted alongside `attachments`/`annotations`. */
  readonly extraComposerState?: Partial<Omit<StoredComposerState, 'attachments' | 'annotations' | 'quotes'>>;
  /** Optional guard preventing annotation edits/removals (e.g. while main's queueEdit loads). */
  readonly isAnnotationMutationLocked?: () => boolean;
  /** Optional side effect when draft or attachments are edited by the user. */
  readonly onDraftMutated?: () => void;
  /** Optional side effect after an external draft append (`subscribeDraftAppends`). */
  readonly onDraftAppended?: (restored: {
    readonly text: string;
    readonly restoredAttachments: readonly ComposerAttachment[] | undefined;
    readonly chrome: StoredComposerState;
  }) => void;
  /** Optional hook executed right before `flushDrafts()` on unmount. */
  readonly onBeforeFlushUnmount?: () => void;
  /** Whether `useModelSwitches` subscribes for this target (false when main yields to a routed child). */
  readonly modelSwitchActive?: boolean;
  /** Optional controlled model-switch dialog state (main's `switchConfirmation` union). */
  readonly controlledModelSwitchDialog?: ModelSwitchDialogState;
  readonly onChangeModelSwitchDialog?: (dialog: ModelSwitchDialogState | undefined) => void;
  /** Defer `/models` fetch until transcript is ready (cold child opens). */
  readonly deferModelsQuery?: boolean;
  /** Enable main-session profile catalog, file preview, and harness resolution. */
  readonly mainProfileCatalog?: MainProfileCatalogPolicy;
  /** Enable child agent capabilities + executor binding queries. */
  readonly childBindings?: ChildBindingsPolicy;
  /** Pure derivation of execution, model-switch, and auto-compact inputs from core state. */
  readonly resolveExecution: (ctx: {
    readonly state: SessionViewState;
    readonly models: ListModelsResponse['items'] | undefined;
    readonly modelsQuery: UseQueryResult<ListModelsResponse>;
    readonly config: KikiConfigResponse | undefined;
    readonly configQuery: UseQueryResult<KikiConfigResponse>;
    readonly liveSettings: LiveSettings;
    readonly modelSwitches: ModelSwitchesHandle;
    readonly executorCatalog: readonly ExecutorCatalogItem[];
    readonly agentProfileCatalogMode: AgentProfileCatalogMode;
    readonly agentProfilesQuery: UseQueryResult<Awaited<ReturnType<typeof loadAgentProfileCatalog>>>;
    readonly fileProfilePreview: ReturnType<typeof useProfileFilePreview>;
    readonly harness: SessionHarness | undefined;
    readonly boundProfile: string;
    readonly boundExecution: ExecutionChoice;
    readonly shownExecution: ExecutionChoice;
    readonly capabilitiesQuery: UseQueryResult<Awaited<ReturnType<ReturnType<typeof useConnection>['client']['getAgentCapabilities']>>>;
    readonly executorBindingQuery: UseQueryResult<string | null>;
    readonly agentKnown: boolean;
  }) => WorkspaceExecutionResolution;
  /** Main's tray placement when `interactionPlacementMode === 'tray'`. */
  readonly trayInteractionPlacement?: InteractionPlacement;
  /** Optional custom handler for `<ModelSwitchDialog onOpenSettings>`. */
  readonly onOpenModelSwitchSettings?: () => void;
}

export type SharedWorkspaceComposerProps = Pick<
  ComponentProps<typeof Composer>,
  | 'value'
  | 'onChange'
  | 'attachments'
  | 'onChangeAttachments'
  | 'annotationStore'
  | 'onRemoveAnnotation'
  | 'onUpdateAnnotation'
  | 'onLocateAnnotation'
  | 'fsSearch'
  | 'pendingModelSwitch'
  | 'bindingSetting'
  | 'modelSwitchError'
  | 'contextAutoCompact'
  | 'sendTimingDefault'
  | 'busySendsNow'
  | 'sessionId'
  | 'agentId'
>;

export interface AgentWorkspaceCoreResult {
  readonly policy: Pick<
    AgentWorkspaceCorePolicy,
    'mountHost' | 'busyPlainSendMode' | 'interactionPlacementMode' | 'storageKey'
  >;
  readonly liveSettings: LiveSettings;
  readonly timeline: AgentTimelineResult;
  readonly modelsQuery: UseQueryResult<ListModelsResponse>;
  readonly configQuery: UseQueryResult<KikiConfigResponse>;
  readonly executorCatalog: readonly ExecutorCatalogItem[];
  readonly agentProfileCatalogMode: AgentProfileCatalogMode;
  readonly agentProfilesQuery: UseQueryResult<Awaited<ReturnType<typeof loadAgentProfileCatalog>>>;
  readonly fileProfilePreview: ReturnType<typeof useProfileFilePreview>;
  readonly harness: SessionHarness | undefined;
  readonly boundProfile: string;
  readonly boundExecution: ExecutionChoice;
  readonly shownExecution: ExecutionChoice;
  readonly capabilitiesQuery: UseQueryResult<Awaited<ReturnType<ReturnType<typeof useConnection>['client']['getAgentCapabilities']>>>;
  readonly executorBindingQuery: UseQueryResult<string | null>;
  readonly agentKnown: boolean;
  readonly draft: string;
  readonly draftRef: RefObject<string>;
  readonly setDraft: (text: string) => void;
  readonly updateDraft: (text: string) => void;
  readonly attachments: readonly ComposerAttachment[];
  readonly attachmentsRef: RefObject<readonly ComposerAttachment[]>;
  readonly setAttachments: Dispatch<SetStateAction<readonly ComposerAttachment[]>>;
  readonly updateAttachments: (
    next:
      | readonly ComposerAttachment[]
      | ((previous: readonly ComposerAttachment[]) => readonly ComposerAttachment[]),
  ) => void;
  readonly composerOwnerActive: RefObject<boolean>;
  readonly pendingSendRef: RefObject<PendingComposerSubmission | null>;
  readonly submissionInFlight: boolean;
  readonly timelineBlocksRef: RefObject<readonly Block[]>;
  readonly annotations: UseConversationAnnotationsResult;
  readonly trackNowReceipt: (promptId: string, reason?: string | null) => void;
  readonly modelSwitches: ModelSwitchesHandle;
  readonly modelSwitchFlow: UseModelSwitchFlowResult;
  readonly contextAutoCompact: ReturnType<typeof useContextMeterAutoCompact>;
  readonly messageViewContext: MessageViewContextValue;
  readonly interactionPlacement: InteractionPlacement;
  readonly handleFsSearch: (query: string, page?: FsSearchPageArgs) => ReturnType<ReturnType<typeof useConnection>['client']['fsSearch']>;
  readonly revealOwnSend: (joinsNow: boolean) => void;
  readonly busySendsNow: boolean;
  readonly composerProps: SharedWorkspaceComposerProps;
  readonly modelSwitchDialogProps: ComponentProps<typeof ModelSwitchDialog>;
}

export function useAgentWorkspaceCore(
  target: AgentWorkspaceTarget,
  controller: SessionController | null,
  policy: AgentWorkspaceCorePolicy,
): AgentWorkspaceCoreResult {
  const { sessionId, agentId } = target;
  const {
    mountHost,
    busyPlainSendMode,
    interactionPlacementMode,
    storageKey,
    sendScope = storageKey,
    visible = true,
    sessionState,
    forest,
    initialAttachments,
    syncInitialDraft = true,
    persistComposerState = true,
    extraComposerState,
    isAnnotationMutationLocked,
    onDraftMutated,
    onDraftAppended,
    onBeforeFlushUnmount,
    modelSwitchActive = true,
    controlledModelSwitchDialog,
    onChangeModelSwitchDialog,
    deferModelsQuery = false,
    mainProfileCatalog,
    childBindings,
    resolveExecution,
    trayInteractionPlacement,
    onOpenModelSwitchSettings,
  } = policy;

  const { t } = useI18n();
  const { client, klient, scopeId } = useConnection();
  const navigate = useNavigate();
  const liveSettings = useSyncExternalStore(
    subscribeSettings,
    settingsSnapshot,
    settingsServerSnapshot,
  );

  // ---- 1. Timeline & actions ----
  const timeline = useAgentTimeline(controller, agentId, {
    visible,
    sessionId,
    sessionState,
    forest,
  });

  // ---- 2. Draft, attachments, annotations & pending-submission recovery ----
  const [draft, setDraftState] = useState<string>(() => (syncInitialDraft ? readDraft(storageKey) : ''));
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const [attachments, setAttachmentsState] = useState<readonly ComposerAttachment[]>(
    () => initialAttachments ?? readComposerState(storageKey).attachments ?? [],
  );
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const timelineBlocksRef = useRef<readonly Block[]>(timeline.state.blocks);
  timelineBlocksRef.current = timeline.state.blocks;

  const annotations = useConversationAnnotations({
    storageKey,
    sessionId,
    agentId,
    blocks: () => timelineBlocksRef.current,
    isMutationLocked: isAnnotationMutationLocked,
    persistComposerState,
  });

  const composerOwnerActive = useRef(true);
  const pendingSendRef = useRef<PendingComposerSubmission | null>(
    (() => {
      const saved = readPendingSubmission(storageKey);
      return saved !== undefined && saved.scope === sendScope && !saved.retryInvalidated && saved.draftText === draft
        ? saved
        : null;
    })(),
  );

  const subscribeTargetSubmission = useCallback(
    (listener: () => void) =>
      subscribePendingSubmissions((key) => {
        if (key === storageKey) listener();
      }),
    [storageKey],
  );
  const submissionInFlight = useSyncExternalStore(
    subscribeTargetSubmission,
    () => isPendingSubmissionInFlight(storageKey, sendScope),
    () => false,
  );

  const onDraftMutatedRef = useRef(onDraftMutated);
  onDraftMutatedRef.current = onDraftMutated;
  const onDraftAppendedRef = useRef(onDraftAppended);
  onDraftAppendedRef.current = onDraftAppended;
  const onBeforeFlushUnmountRef = useRef(onBeforeFlushUnmount);
  onBeforeFlushUnmountRef.current = onBeforeFlushUnmount;

  const setDraft = useCallback((text: string) => {
    draftRef.current = text;
    writeDraft(storageKey, text);
    setDraftState(text);
  }, [storageKey]);

  const updateDraft = useCallback((next: string) => {
    if (next !== draftRef.current) {
      pendingSendRef.current = null;
      invalidatePendingSubmissionRetry(storageKey);
      onDraftMutatedRef.current?.();
    }
    draftRef.current = next;
    setDraftState(next);
    writeDraft(storageKey, next);
  }, [storageKey]);

  const updateAttachments = useCallback((
    next:
      | readonly ComposerAttachment[]
      | ((previous: readonly ComposerAttachment[]) => readonly ComposerAttachment[]),
  ) => {
    setAttachmentsState((previous) => {
      const updated = typeof next === 'function' ? next(previous) : next;
      if (updated !== previous) {
        attachmentsRef.current = updated;
        pendingSendRef.current = null;
        invalidatePendingSubmissionRetry(storageKey);
        onDraftMutatedRef.current?.();
      }
      return updated;
    });
  }, [storageKey]);

  useEffect(() => {
    composerOwnerActive.current = true;
    if (!syncInitialDraft) {
      const stored = readDraft(storageKey);
      draftRef.current = stored;
      setDraftState(stored);
    }
    return () => {
      composerOwnerActive.current = false;
      onBeforeFlushUnmountRef.current?.();
      flushDrafts();
    };
  }, [storageKey, syncInitialDraft]);

  useEffect(
    () =>
      subscribeDraftAppends((targetKey, restoredAttachments) => {
        if (targetKey !== storageKey) return;
        const restored = readDraft(storageKey);
        const chrome = readComposerState(storageKey);
        const savedPending = readPendingSubmission(storageKey);
        draftRef.current = restored;
        pendingSendRef.current =
          savedPending !== undefined &&
          savedPending.scope === sendScope &&
          !savedPending.retryInvalidated &&
          savedPending.draftText === restored
            ? savedPending
            : null;
        setDraftState(restored);
        if (syncInitialDraft) {
          const nextAttachments = chrome.attachments ?? [];
          attachmentsRef.current = nextAttachments;
          setAttachmentsState(nextAttachments);
          annotations.setAnnotations(normalizeStoredAnnotations(chrome));
        } else if (restoredAttachments !== undefined) {
          const nextAttachments = [...attachmentsRef.current, ...restoredAttachments];
          attachmentsRef.current = nextAttachments;
          setAttachmentsState(nextAttachments);
        }
        onDraftAppendedRef.current?.({ text: restored, restoredAttachments, chrome });
      }),
    [storageKey, sendScope, syncInitialDraft, annotations.setAnnotations],
  );

  useEffect(() => {
    if (!persistComposerState) return;
    const chrome = readComposerState(storageKey);
    writeComposerState(storageKey, {
      attachments,
      annotations: annotations.annotationsRef.current,
      quotes: [],
      quote: null,
      quoteSource: undefined,
      permissionMode: extraComposerState !== undefined && 'permissionMode' in extraComposerState
        ? extraComposerState.permissionMode
        : chrome.permissionMode,
      planMode: extraComposerState !== undefined && 'planMode' in extraComposerState
        ? extraComposerState.planMode
        : chrome.planMode,
      planGate: extraComposerState !== undefined && 'planGate' in extraComposerState
        ? extraComposerState.planGate
        : chrome.planGate,
      goalObjective: extraComposerState !== undefined && 'goalObjective' in extraComposerState
        ? extraComposerState.goalObjective
        : chrome.goalObjective,
      modelOverride: extraComposerState !== undefined && 'modelOverride' in extraComposerState
        ? extraComposerState.modelOverride
        : chrome.modelOverride,
      effortOverride: extraComposerState !== undefined && 'effortOverride' in extraComposerState
        ? extraComposerState.effortOverride
        : chrome.effortOverride,
      modelChoice: extraComposerState !== undefined && 'modelChoice' in extraComposerState
        ? extraComposerState.modelChoice
        : chrome.modelChoice,
      effortChoice: extraComposerState !== undefined && 'effortChoice' in extraComposerState
        ? extraComposerState.effortChoice
        : chrome.effortChoice,
      modelSwitchMode: extraComposerState !== undefined && 'modelSwitchMode' in extraComposerState
        ? extraComposerState.modelSwitchMode
        : chrome.modelSwitchMode,
      execution: extraComposerState !== undefined && 'execution' in extraComposerState
        ? extraComposerState.execution
        : chrome.execution,
    });
  }, [
    persistComposerState,
    storageKey,
    attachments,
    extraComposerState?.permissionMode,
    extraComposerState?.planMode,
    extraComposerState?.planGate,
    extraComposerState?.goalObjective,
    extraComposerState?.modelOverride,
    extraComposerState?.effortOverride,
    extraComposerState?.modelChoice,
    extraComposerState?.effortChoice,
    extraComposerState?.modelSwitchMode,
    extraComposerState?.execution,
  ]);

  // ---- 3. Catalog, config, profile/child bindings & model switching ----
  const modelsQuery = useQuery({
    queryKey: ['models'],
    queryFn: () => client.listModels(),
    enabled: !deferModelsQuery || controller === null || timeline.state.transcriptReady || timeline.state.loaded,
    staleTime: 60_000,
  });
  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    enabled: typeof client.getConfig === 'function',
    staleTime: 60_000,
  });

  const executorCatalog = useExecutorCatalog();
  const profileWorkspaceId = timeline.state.session?.workspace_id;
  const profileCwd = timeline.state.session?.metadata?.cwd;
  const agentProfileCatalogMode = useMemo<AgentProfileCatalogMode>(
    () =>
      mainProfileCatalog === undefined
        ? { mode: 'disabled' }
        : profileCwd !== undefined && profileCwd !== ''
          ? { mode: 'cwd', cwd: profileCwd, effective: true }
          : profileWorkspaceId === undefined
            ? { mode: 'disabled' }
            : { mode: 'workspace', workspaceId: profileWorkspaceId, effective: true },
    [mainProfileCatalog !== undefined, profileCwd, profileWorkspaceId],
  );
  const agentProfilesQuery = useQuery({
    queryKey: agentProfileCatalogQueryKey(agentProfileCatalogMode),
    queryFn: () => loadAgentProfileCatalog(client, agentProfileCatalogMode),
    enabled: mainProfileCatalog !== undefined && agentProfileCatalogMode.mode !== 'disabled',
    staleTime: 60_000,
    retry: false,
    refetchInterval: agentProfileCatalogRefetchInterval,
  });
  const boundProfile = timeline.state.profile ?? DEFAULT_AGENT_PROFILE;
  const executionBinding = timeline.state.session?.agent_config?.execution;
  const boundExecution = useMemo(
    () => boundExecutionChoice(executionBinding, timeline.state.session?.agent_config?.profile),
    [executionBinding, timeline.state.session],
  );
  const pendingProfile = mainProfileCatalog?.pendingProfile;
  const pendingExecution = mainProfileCatalog?.pendingExecution;
  const profilePending = pendingProfile !== undefined && pendingProfile !== boundProfile;
  const shownExecution = pendingExecution ?? (profilePending
    ? { ...boundExecution, profile: pendingProfile, profile_file: undefined }
    : boundExecution);
  const harness = useSessionHarness(
    mainProfileCatalog === undefined ? undefined : boundProfile,
    agentProfilesQuery.data?.items ?? [],
    mainProfileCatalog === undefined ? undefined : timeline.state.session,
  );
  const fileProfilePreview = useProfileFilePreview(
    mainProfileCatalog === undefined ? undefined : shownExecution.profile_file,
    agentProfileCatalogMode,
  );

  const agentKnown = useMemo(
    () =>
      childBindings === undefined
        ? true
        : agentContinuationAvailable({
            controller,
            node: childBindings.selectedNode,
            subagent: childBindings.selectedSubagent,
            state: timeline.state,
          }),
    [childBindings, controller, timeline.state],
  );
  const capabilitiesQuery = useQuery({
    queryKey: ['agentCapabilities', { session_id: sessionId, agent_id: agentId }],
    queryFn: () => client.getAgentCapabilities({ session_id: sessionId, agent_id: agentId }),
    enabled:
      childBindings !== undefined &&
      typeof client.getAgentCapabilities === 'function' &&
      (controller === null || timeline.state.transcriptReady || timeline.state.loaded),
    staleTime: 30_000,
  });
  const executorBindingQuery = useQuery({
    queryKey: ['agentExecutor', scopeId, sessionId, agentId],
    queryFn: async () => await klient.session(sessionId).getAgentExecutor(agentId) ?? null,
    enabled: childBindings !== undefined && agentKnown && childBindings.reportedExecutorId === undefined,
    staleTime: 30_000,
    retry: false,
  });

  const modelSwitches = useModelSwitches(
    sessionId,
    modelSwitchActive ? agentId : undefined,
    timeline.state.queuedPromptMeta,
  );

  const execution = resolveExecution({
    state: timeline.state,
    models: modelsQuery.data?.items,
    modelsQuery,
    config: configQuery.data,
    configQuery,
    liveSettings,
    modelSwitches,
    executorCatalog,
    agentProfileCatalogMode,
    agentProfilesQuery,
    fileProfilePreview,
    harness,
    boundProfile,
    boundExecution,
    shownExecution,
    capabilitiesQuery,
    executorBindingQuery,
    agentKnown,
  });

  const modelSwitchFlow = useModelSwitchFlow({
    client,
    sessionId,
    agentId,
    catalogItems: modelsQuery.data?.items,
    currentModel: execution.currentModel,
    carriedThinking: execution.carriedThinking,
    switches: modelSwitches,
    rawConfigModelSwitch: configQuery.data?.model_switch,
    profileDefaultEffort: execution.profileDefaultEffort,
    dialog: controlledModelSwitchDialog,
    onChangeDialog: onChangeModelSwitchDialog,
  });

  // ---- 4. Context meter auto-compact ----
  const contextAutoCompact = useContextMeterAutoCompact({
    sessionId: execution.autoCompact.enabled ? sessionId : undefined,
    agentId,
    modelId: execution.autoCompact.modelId,
    modelLabel: execution.autoCompact.modelLabel,
    maxContextTokens: execution.autoCompact.maxContextTokens,
    running: execution.autoCompact.running,
    profileName: execution.autoCompact.profileName,
    profileCatalog: execution.autoCompact.profileCatalog,
  });

  // ---- 5. Durable "Send now" open receipt tracking ----
  const nowReceiptsRef = useRef(new Map<string, string | null>());
  const [nowReceiptTick, setNowReceiptTick] = useState(0);
  const trackNowReceipt = useCallback((promptId: string, reason: string | null = null) => {
    trackOpenNowReceipt(nowReceiptsRef.current, promptId, reason);
    setNowReceiptTick((tick) => tick + 1);
  }, []);

  const ingressForReceipts = execution.durableIngress ?? timeline.state.durableIngress ?? [];
  useEffect(() => {
    const tracked = nowReceiptsRef.current;
    if (tracked.size === 0) return;
    for (const [promptId, reported] of tracked) {
      const decision = nowReceiptDecision({
        promptId,
        reported,
        ingress: ingressForReceipts,
        settled: timeline.state.blocks.some(
          (block) => block.kind === 'user' && block.promptId === promptId && block.promptStatus !== 'queued',
        ),
      });
      if (decision.kind === 'wait') continue;
      if (decision.kind === 'drop') {
        tracked.delete(promptId);
        continue;
      }
      tracked.set(promptId, decision.reason);
      pushToast({ tone: 'info', text: t(sendNowQueuedNotice(decision.reason)) });
    }
  }, [timeline.state.blocks, ingressForReceipts, nowReceiptTick, t]);

  // ---- 6. Shared MessageViewContext & InteractionPlacementContext (Difference C) ----
  const sessionRecord = execution.sessionRecord ?? timeline.state.session;
  const messageViewContext = useMemo<MessageViewContextValue>(() => ({
    persona: sessionRecord?.agent_config?.persona,
    sessionId,
    internalProse: sessionRecord?.delivery === 'message',
    onOpenSession: (targetSessionId) => { void navigate(`/s/${targetSessionId}`); },
  }), [sessionRecord?.agent_config?.persona, sessionRecord?.delivery, sessionId, navigate]);

  const interactionPlacement = useMemo<InteractionPlacement>(
    () =>
      interactionPlacementMode === 'inline'
        ? INLINE_INTERACTION_PLACEMENT
        : trayInteractionPlacement ?? INLINE_INTERACTION_PLACEMENT,
    [interactionPlacementMode, trayInteractionPlacement],
  );

  // ---- 7. Shared Composer utilities & unified composerProps (Differences A & B) ----
  const handleFsSearch = useCallback(
    (query: string, page?: FsSearchPageArgs) =>
      client.fsSearch(sessionId, fsSearchRequestBody(query, page, { limit: 30 }), page?.signal),
    [client, sessionId],
  );

  const busyRef = useRef(execution.busy);
  busyRef.current = execution.busy;
  const revealOwnSend = useCallback((joinsNow: boolean) => {
    if (!joinsNow) {
      const currentlyBusy = agentId === MAIN_AGENT_ID
        ? controller?.getState().busy !== false
        : busyRef.current;
      if (currentlyBusy) return;
    }
    timeline.actions.revealLatest();
  }, [agentId, controller, timeline.actions.revealLatest]);

  const busySendsNow =
    busyPlainSendMode === 'steer' &&
    execution.busy &&
    execution.canSteerNow === true &&
    modelSwitches.dependency === undefined &&
    pendingSendRef.current === null &&
    execution.steerBusyBlocked !== true;

  const pendingModelSwitch = useMemo(
    () =>
      modelSwitches.active === undefined
        ? undefined
        : {
            from: modelSwitches.active.receipt.fromModel,
            to: modelSwitches.active.receipt.toModel,
            mode: modelSwitches.active.input.mode,
            originalThinking: modelSwitches.active.originalBinding.thinking,
            targetThinking: modelSwitches.active.input.thinking,
          },
    [modelSwitches.active],
  );

  const bindingSetting = useMemo(() => {
    if (modelSwitches.setting !== undefined) {
      const setting = modelSwitches.setting;
      const failed = setting.receipt.error !== undefined || setting.receipt.state === 'failed';
      return {
        model: setting.input.model,
        thinking: setting.input.thinking,
        state: (failed ? 'failed' : execution.busy ? 'next_step' : 'applying') as 'failed' | 'next_step' | 'applying',
        error: setting.receipt.error?.message,
        onRetry: failed ? () => modelSwitchFlow.noticeActions.retry?.(setting.input.operationId) : undefined,
      };
    }
    if (execution.externalBindingSetting !== undefined) {
      return {
        ...execution.externalBindingSetting,
        state: 'next_message' as const,
      };
    }
    return undefined;
  }, [modelSwitches.setting, execution.busy, execution.externalBindingSetting, modelSwitchFlow.noticeActions]);

  const modelSwitchError = useMemo(
    () =>
      modelSwitches.error === undefined
        ? undefined
        : {
            detail: modelSwitches.error.message,
            onRetry: modelSwitches.refresh,
          },
    [modelSwitches.error, modelSwitches.refresh],
  );

  const composerProps = useMemo<SharedWorkspaceComposerProps>(() => ({
    value: draft,
    onChange: updateDraft,
    attachments,
    onChangeAttachments: updateAttachments,
    annotationStore: annotations.surface.store,
    onRemoveAnnotation: annotations.onRemove,
    onUpdateAnnotation: annotations.onUpdate,
    onLocateAnnotation: annotations.onLocate,
    fsSearch: execution.fsSearchEnabled === false ? undefined : handleFsSearch,
    pendingModelSwitch,
    bindingSetting,
    modelSwitchError,
    contextAutoCompact,
    sendTimingDefault: execution.sendTimingDefault,
    busySendsNow,
    sessionId,
    agentId,
  }), [
    draft,
    updateDraft,
    attachments,
    updateAttachments,
    annotations.surface.store,
    annotations.onRemove,
    annotations.onUpdate,
    annotations.onLocate,
    execution.fsSearchEnabled,
    handleFsSearch,
    pendingModelSwitch,
    bindingSetting,
    modelSwitchError,
    contextAutoCompact,
    execution.sendTimingDefault,
    busySendsNow,
    sessionId,
    agentId,
  ]);

  // ---- 8. Unified ModelSwitchDialog props (with `onOpenSettings` wired for main & child) ----
  const defaultOpenModelSwitchSettings = useCallback(() => {
    modelSwitchFlow.setDialog(undefined);
    void navigate(settingsCardRoute('ai', 'st-card-model-switch', 'defaults'));
  }, [modelSwitchFlow.setDialog, navigate]);

  const modelSwitchDialogProps = useMemo<ComponentProps<typeof ModelSwitchDialog>>(() => ({
    open: modelSwitchFlow.dialog !== undefined,
    fromModel: modelSwitchFlow.dialog?.fromModel ?? '',
    toModel: modelSwitchFlow.dialog?.toModel ?? '',
    initialMode: modelSwitchFlow.dialog?.initialMode ?? 'direct',
    editing: modelSwitchFlow.dialog?.editingOperationId !== undefined,
    busy: execution.busy,
    submitting: modelSwitchFlow.submitting,
    matchedRuleId: modelSwitchFlow.dialog?.matchedRuleId,
    efforts: modelSwitchFlow.dialogEffort?.efforts,
    initialEffort: modelSwitchFlow.dialogEffort?.effort,
    defaultEffort: modelSwitchFlow.dialogEffort?.defaultEffort,
    effortAdjustedFrom: modelSwitchFlow.dialogEffort?.adjustedFrom,
    onConfirm: (choice) => {
      const dialog = modelSwitchFlow.dialog;
      if (dialog === undefined) return;
      void modelSwitchFlow.submit({
        fromModel: dialog.fromModel,
        toModel: dialog.toModel,
        mode: choice.mode,
        remember: choice.remember,
        effort: choice.effort,
        editingOperationId: dialog.editingOperationId,
        editingRevision: dialog.editingRevision,
      });
    },
    onCancel: () => { modelSwitchFlow.setDialog(undefined); },
    onOpenSettings: onOpenModelSwitchSettings ?? defaultOpenModelSwitchSettings,
  }), [
    modelSwitchFlow.dialog,
    modelSwitchFlow.submitting,
    modelSwitchFlow.dialogEffort,
    modelSwitchFlow.submit,
    modelSwitchFlow.setDialog,
    execution.busy,
    onOpenModelSwitchSettings,
    defaultOpenModelSwitchSettings,
  ]);

  return {
    policy: {
      mountHost,
      busyPlainSendMode,
      interactionPlacementMode,
      storageKey,
    },
    liveSettings,
    timeline,
    modelsQuery,
    configQuery,
    executorCatalog,
    agentProfileCatalogMode,
    agentProfilesQuery,
    fileProfilePreview,
    harness,
    boundProfile,
    boundExecution,
    shownExecution,
    capabilitiesQuery,
    executorBindingQuery,
    agentKnown,
    draft,
    draftRef,
    setDraft,
    updateDraft,
    attachments,
    attachmentsRef,
    setAttachments: setAttachmentsState,
    updateAttachments,
    composerOwnerActive,
    pendingSendRef,
    submissionInFlight,
    timelineBlocksRef,
    annotations,
    trackNowReceipt,
    modelSwitches,
    modelSwitchFlow,
    contextAutoCompact,
    messageViewContext,
    interactionPlacement,
    handleFsSearch,
    revealOwnSend,
    busySendsNow,
    composerProps,
    modelSwitchDialogProps,
  };
}
