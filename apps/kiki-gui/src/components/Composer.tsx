/**
 * Composer — floating rounded-2xl card: chips above a full-width multiline
 * input (send shortcut from settings), a bottom toolbar with one control per
 * concern (attach, permission-mode dropdown, plan/swarm/goal dropdown, agent
 * profile picker, model+effort selector fed from the server catalog), and a
 * round accent send button; busy state swaps in Abort.
 *
 * Batch B additions:
 *   - `/` opens a slash menu of REAL entries: skills from the session's
 *     `GET /skills` catalog, or on /new the workspace `GET /skills` catalog,
 *     plus client shortcuts that map to shipped actions. Unknown `/text`
 *     goes out as a plain prompt — nothing invented.
 *   - `@` opens a workspace file picker fed by `fs:search`; picks become
 *     reference chips that ride the prompt text as `@path` tokens.
 *   - Pasted images become preview chips and send as real base64 image
 *     content parts (the server format-gates and compresses them).
 *     Placeholder chips cover the async reads; sending blocks until they land.
 *   - Dropped files are a pure text gesture: each file's absolute path is
 *     inserted at the caret (quoted when it contains spaces) — no attachment
 *     chips, no upload. Desktop drops arrive through the host's native
 *     drag-drop bridge; a browser drop falls back to the bare file name.
 *   - A slash-looking draft that resolves to no entry is intercepted at send
 *     time with an inline confirm, so a typo never silently ships as prompt
 *     text (disabled `reference` skills explain themselves instead).
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import type { FsSearchHit, PermissionMode, PromptPlanGate } from '@kiki/protocol';

import {
  buildSlashItems,
  classifySlashSubmission,
  completeSlashTrigger,
  filterSlashItems,
  parseSlashDraft,
  parseSlashTrigger,
  type SlashActionId,
  type SlashItem,
} from '@kiki/session-core/commands';
import {
  ACCEPTED_IMAGE_MIMES,
  fileToImageAttachment,
  formatBytes,
  hasMention,
  insertDroppedPaths,
  parseMentionTrigger,
  pushInputHistory,
  readInputHistory,
  reserveImageFiles,
  reserveUploadFiles,
  type ComposerAttachment,
  type SelectionAnnotation,
} from '@kiki/session-core/composer';
import { errorText, issueText, type I18nKey, type I18nParams } from '@kiki/session-core/i18n';
import {
  isComposerSendKey,
  resolveCatalogModel,
  resolveSelectedEffort,
  settingsServerSnapshot,
  settingsSnapshot,
  subscribeSettings,
  type ComposerModelSource,
} from '@kiki/session-core/settings';
import { useHost } from '../host';
import { isVscodeWebview, vscodeHost } from '../host/vscode';
import { useI18n } from '../i18n';
import {
  agentProfileCatalogQueryKey,
  loadAgentProfileCatalog,
  type AgentProfileCatalogMode,
} from '../lib/agentProfileCatalog';
import { API_CODES, ApiError, type NamedAgentProfile } from '../lib/client';
import { registerOverlay } from '../lib/uiBusy';
import { pushToast } from '../lib/toasts';
import { useConnection } from '../state/connection';
import { ContextMeter, type ContextMeterUsage } from './ContextMeter';
import { ConfirmDialog } from './ConfirmDialog';
import { useComposerContextMenu } from './ComposerContextMenu';
import { SearchableSelect, type SearchableSelectOption } from './SearchableSelect';

const MODES: readonly { id: PermissionMode; labelKey: I18nKey; hintKey: I18nKey }[] = [
  { id: 'manual', labelKey: 'composer.mode.manual', hintKey: 'composer.mode.manualHint' },
  { id: 'auto', labelKey: 'composer.mode.auto', hintKey: 'composer.mode.autoHint' },
  { id: 'yolo', labelKey: 'composer.mode.yolo', hintKey: 'composer.mode.yoloHint' },
];

/** Localized descriptions for the client-side slash shortcuts (skills carry server text). */
const SLASH_ACTION_DESCRIPTIONS: Record<SlashActionId, I18nKey> = {
  plan: 'composer.slash.plan',
  goal: 'composer.slash.goal',
  new: 'composer.slash.new',
  fork: 'composer.slash.fork',
  undo: 'composer.slash.undo',
  compact: 'composer.slash.compact',
};

const MENTION_DEBOUNCE_MS = 250;
const MENTION_ROW_LIMIT = 8;
const REBUILD_CONTEXT_OPTION = '__kiki_rebuild_context__';
const CATALOG_RETRY_INTERVAL_MS = 30_000;

const isTransientCatalogError = (error: unknown): boolean =>
  error instanceof ApiError && (error.code === API_CODES.TIMEOUT || error.code === -1);

const retryCatalog = (failureCount: number, error: Error): boolean =>
  isTransientCatalogError(error) && failureCount < 3;
const catalogRetryDelay = (attempt: number): number =>
  Math.min(1000 * 2 ** attempt, CATALOG_RETRY_INTERVAL_MS);
const catalogRefetchInterval = (query: { state: { error: Error | null } }): number | false =>
  isTransientCatalogError(query.state.error) ? CATALOG_RETRY_INTERVAL_MS : false;

let vscodeConversationSequence = 0;

function nextVscodeConversationKey(): string {
  vscodeConversationSequence += 1;
  return `vscode-conversation-${vscodeConversationSequence}`;
}

export { resolveSelectedEffort };

/** Fallback display/binding when the server echoes no profile on a session. */
export const DEFAULT_AGENT_PROFILE = 'agent';

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? undefined : value;

/**
 * The wire's private flag: a private profile hides from every public
 * enumeration surface (catalog list, this picker) but stays resolvable by
 * name. Read defensively so the exclusion activates the moment the catalog
 * serialization carries the field.
 */
const isPrivateProfile = (item: NamedAgentProfile): boolean =>
  (item as NamedAgentProfile & { readonly private?: boolean }).private === true;

/**
 * Profile picker options: only enabled, non-private main profiles
 * (`main: true`) are conversation candidates. Sub-agent-only profiles are
 * never offered here — dispatch them with AgentRun instead. A previously
 * selected profile that has become unavailable remains visible on the
 * trigger with a diagnostic until the user reselects.
 */
export function buildAgentProfileOptions(
  items: readonly NamedAgentProfile[],
  t: (key: I18nKey, params?: I18nParams) => string,
): SearchableSelectOption[] {
  const pickable = items.filter(
    (item) => item.main === true && !item.disabled && !isPrivateProfile(item),
  );
  const toOption = (item: NamedAgentProfile, group: string): SearchableSelectOption => ({
    value: item.name,
    label: item.name,
    description: nonEmpty(item.description) ?? nonEmpty(item.when_to_use),
    hint: nonEmpty(item.pinned_model_alias),
    title: item.name,
    group,
    badges: [
      { label: item.source },
      ...(nonEmpty(item.thinking_effort) !== undefined
        ? [{ label: t('composer.profileEffortBadge', { effort: item.thinking_effort! }) }]
        : []),
    ],
  });
  return pickable.map((item) => toOption(item, t('composer.profileGroupMain')));
}

type ComposerMenu =
  | { kind: 'slash'; start: number; end: number; query: string; inline: boolean }
  | { kind: 'mention'; start: number; query: string };

/** One undoable composer state: the text plus the caret that sat with it. */
interface ComposerUndoEntry {
  readonly text: string;
  readonly cursor: number;
}

/** anything-llm's PromptInput caps its local stack at 100; so does this one. */
const UNDO_STACK_LIMIT = 100;

export function Composer({
  busy,
  disabled,
  variant = 'main',
  sendDisabled = false,
  sendDisabledTitle,
  disabledPlaceholder,
  value,
  onChange,
  model,
  defaultModel,
  serverDefaultModel,
  modelSource,
  agentProfile,
  agentProfilePending = false,
  permissionMode,
  planMode,
  planGate,
  swarmMode,
  goalObjective = '',
  goalMode = false,
  efforts,
  effort,
  contextUsage,
  sessionUsage,
  busyPlaceholder,
  sessionId,
  workspaceId,
  agentProfileCatalogMode,
  fsSearch,
  mentionScopeKey,
  attachments,
  quote,
  onRemoveQuote,
  annotations,
  onRemoveAnnotation,
  onChangeAttachments,
  onActivateSkill,
  onSessionAction,
  onCompactContext,
  onChangeModel,
  onChangeAgentProfile,
  onRebuildContext,
  onChangePermissionMode,
  onChangePlanMode,
  onChangePlanGate,
  onChangeSwarmMode,
  onChangeGoalObjective,
  onChangeGoalMode,
  onChangeEffort,
  onSend,
  onAbort,
  abortPending = false,
  queueEditing = false,
  onQueueEditConfirm,
  onQueueEditCancel,
  onQueueEditRemove,
  autoFocus,
}: {
  busy: boolean;
  /**
   * Locks the textarea — busy/loading phases only (turn in flight, session
   * still loading, /new creation). Send-only gating belongs to sendDisabled.
   */
  disabled: boolean;
  /** Main composer controls, or the subagent endpoint controls only. */
  variant?: 'main' | 'subagent';
  /**
   * Blocks sending without locking the textarea (default false): the /new
   * page uses it while no workspace or absolute path is chosen yet, so the
   * draft and the workspace pickers stay editable.
   */
  sendDisabled?: boolean;
  /** Tooltip explaining why sending is blocked while `sendDisabled`. */
  sendDisabledTitle?: string;
  /** Placeholder shown when the composer is disabled for a terminal endpoint. */
  disabledPlaceholder?: string;
  /** Controlled text (App owns per-session drafts). */
  value: string;
  onChange: (text: string) => void;
  model: string | undefined;
  /** The session's bound model, when set. */
  defaultModel: string | undefined;
  /** The server's configured default model (fresh sessions bind nothing). */
  serverDefaultModel: string | undefined;
  /** Where the effective model value comes from. */
  modelSource: ComposerModelSource;
  /**
   * Main-agent profile shown in the picker (pending choice included). Omit
   * together with `onChangeAgentProfile` to hide the control entirely.
   */
  agentProfile?: string;
  /** A confirmed switch is waiting for the next prompt — accent tint. */
  agentProfilePending?: boolean;
  permissionMode: PermissionMode;
  /** PromptSubmission.plan_mode — the wire field name (verified). */
  planMode: boolean;
  /**
   * Effective plan gate for the next prompt (`plan_gate`). Provided together
   * with `onChangePlanGate` only where a session-level override exists (/s);
   * the PlanSelect gate row hides when the pair is absent (/new).
   */
  planGate?: PromptPlanGate;
  /** PromptSubmission.swarm_mode — enables concurrent subagent orchestration. */
  swarmMode: boolean;
  goalObjective?: string;
  /**
   * Goal mode (composer toggle): the next plain message is sent with
   * `goal_objective` set to its text. Rendered as a toolbar toggle plus an
   * armed chip above the input; only when `onChangeGoalMode` is wired.
   */
  goalMode?: boolean;
  /** support_efforts of the effective model; effort UI hides when absent. */
  efforts: readonly string[] | undefined;
  effort: string | undefined;
  /** Session context usage for the footer's mini meter (hidden when absent). */
  contextUsage?: { readonly used: number; readonly limit: number };
  /**
   * Lifetime cumulative usage for the context meter's detail card (hidden when
   * absent). Main sessions pass the session record's `SessionUsage`; the
   * subagent variant passes that agent's projected totals (no cost pricing).
   */
  sessionUsage?: ContextMeterUsage;
  /** Placeholder while busy (queue steering on /s, creation progress on /new). */
  busyPlaceholder?: string;
  /** Session scope for the skills catalog + session-scoped shortcuts. */
  sessionId?: string;
  /** Registered workspace id for the /new draft's skill catalog. */
  workspaceId?: string;
  /** Named agent profile catalog visibility and workspace scope. */
  agentProfileCatalogMode: AgentProfileCatalogMode;
  /**
   * File-picker feed for `@` mentions (session `fs:search` on /s, workspace
   * `fs:search` on /new). Omit to disable the picker.
   */
  fsSearch?: (query: string) => Promise<FsSearchHit[]>;
  /** Cache scope for picker results (workspace id on /new); defaults to sessionId. */
  mentionScopeKey?: string;
  /** Controlled attachment chips (parent owns them beside the draft). */
  attachments: readonly ComposerAttachment[];
  /** Selected transcript text quoted into this prompt; rendered as a chip. */
  quote?: string | null;
  onRemoveQuote?: () => void;
  /** Selection annotations (quote + comment) accumulating beside the quote. */
  annotations?: readonly SelectionAnnotation[];
  onRemoveAnnotation?: (id: string) => void;
  /**
   * Setter accepting a next array or an updater over the previous one. The
   * updater form is what back-to-back image pastes use — render closures go
   * stale while file reads are in flight.
   */
  onChangeAttachments: (
    next:
      | readonly ComposerAttachment[]
      | ((previous: readonly ComposerAttachment[]) => readonly ComposerAttachment[]),
  ) => void;
  /** Skill activation — the wire path for slash commands (POST :activate). */
  onActivateSkill?: (name: string, args: string, attachments: readonly ComposerAttachment[]) => void | Promise<unknown>;
  /** Session-scoped shortcuts (/fork, /undo, /compact). */
  onSessionAction?: (action: 'fork' | 'undo' | 'compact') => void;
  /** The context meter's click target (asks the session to compact). */
  onCompactContext?: () => void;
  /** Model picked in the panel; a bound agent rebinds on the server, so the
   * callback may be async and may fail (the panel reports that failure). */
  onChangeModel: (model: string | undefined) => void | Promise<void>;
  /** Profile picked in the select; the parent owns the confirm/pending flow. */
  onChangeAgentProfile?: (name: string) => void;
  onRebuildContext?: () => Promise<{ readonly changed: boolean }>;
  onChangePermissionMode: (mode: PermissionMode) => void;
  onChangePlanMode: (on: boolean) => void;
  /** Session plan-gate pick; required for the PlanSelect gate row to show. */
  onChangePlanGate?: (gate: PromptPlanGate) => void;
  onChangeSwarmMode: (on: boolean) => void;
  onChangeGoalObjective?: (objective: string) => void;
  /** Goal-mode toggle; when absent the composer hides the goal toggle button. */
  onChangeGoalMode?: (on: boolean) => void;
  onChangeEffort: (effort: string | undefined) => void;
  /**
   * Fire the prompt. Returning the submission's promise lets the composer
   * hold its send latch until the round settles (accepted or failed), so a
   * second click/Enter during the in-flight gap cannot double-send; a
   * rejection restores the button for retry. `options.goalObjective` rides
   * the submission as `goal_objective` (a `/goal …` prefix or an armed goal
   * mode), creating the session goal with the message.
   */
  onSend: (
    text: string,
    attachments: readonly ComposerAttachment[],
    options?: { readonly goalObjective?: string },
  ) => void | Promise<unknown>;
  /** Omit when there is nothing to abort (e.g. /new session creation). */
  onAbort?: () => void;
  /**
   * A stop request is in flight: the stop button disables itself so clicks
   * during the round trip cannot fan out duplicate cancels, and it clears
   * once the request settles (success or failure).
   */
  abortPending?: boolean;
  /**
   * Queue-edit mode (a queued message's text is parked in the draft): the send
   * button becomes a confirm check that routes to onQueueEditConfirm — the
   * edit lands back at the message's ORIGINAL queue position — and the stop
   * button becomes a two-step remove for that queued message. Slash-command
   * classification is skipped: the draft is verbatim message text here.
   */
  queueEditing?: boolean;
  onQueueEditConfirm?: (text: string) => void | Promise<unknown>;
  onQueueEditCancel?: () => void;
  onQueueEditRemove?: () => void;
  /** Marks the textarea as the dialog's initial-focus target (`data-autofocus`). */
  autoFocus?: boolean;
}) {
  const host = useHost();
  const vscodeRuntime = isVscodeWebview();
  const vscodeConversationRef = useRef<
    { key: string; sessionId: string | undefined } | undefined
  >(undefined);
  if (vscodeRuntime) {
    const conversation = vscodeConversationRef.current;
    if (conversation === undefined) {
      vscodeConversationRef.current = {
        key: sessionId ?? nextVscodeConversationKey(),
        sessionId,
      };
    } else if (conversation.sessionId === undefined && sessionId !== undefined) {
      conversation.sessionId = sessionId;
    } else if (conversation.sessionId !== sessionId) {
      vscodeConversationRef.current = {
        key: sessionId ?? nextVscodeConversationKey(),
        sessionId,
      };
    }
  }
  const vscodeConversationId = vscodeConversationRef.current?.key;
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const sendShortcut = useSyncExternalStore(
    subscribeSettings,
    settingsSnapshot,
    settingsServerSnapshot,
  ).sendShortcut;
  const text = value;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Custom right-click menu for the input (cut/copy/paste-as-plain-text/select-all).
  const { onContextMenu: onComposerContextMenu, menu: composerContextMenu } =
    useComposerContextMenu({ textareaRef, onChange });
  // Event handlers can run several times before a controlled prop rerender.
  // Keep a synchronous attachment baseline alongside the rendered value so
  // same-tick paste/drop batches reserve against one another.
  const attachmentBaselineRef = useRef(attachments);
  attachmentBaselineRef.current = attachments;
  const updateAttachments = (
    next:
      | readonly ComposerAttachment[]
      | ((previous: readonly ComposerAttachment[]) => readonly ComposerAttachment[]),
  ) => {
    if (typeof next === 'function') {
      onChangeAttachments((current) => {
        const updated = next(current);
        attachmentBaselineRef.current = updated;
        return updated;
      });
      return;
    }
    attachmentBaselineRef.current = next;
    onChangeAttachments(next);
  };
  // Two independent dropdowns share the run-shape settings: the permission
  // panel owns the approval mode; the plan panel owns plan/swarm/goal.
  // `goalOpen` expands the objective field inside the plan panel (the `/goal`
  // shortcut opens both at once).
  const [modeOpen, setModeOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [goalOpen, setGoalOpen] = useState(false);
  const [menu, setMenu] = useState<ComposerMenu | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const turnInFlightRef = useRef(false);
  const [turnInFlight, setTurnInFlight] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [contextRebuildConfirm, setContextRebuildConfirm] = useState(false);
  const [contextRebuildBusy, setContextRebuildBusy] = useState(false);
  // A slash-looking draft that resolved to nothing: send is held until the
  // user confirms plain-text shipping (typo guard) or edits the draft.
  const [slashConfirm, setSlashConfirm] = useState<{
    name: string;
    reason: 'unknown' | 'disabled';
  } | null>(null);
  const [slashCatalogPending, setSlashCatalogPending] = useState(false);
  const slashCatalogPendingRef = useRef(false);
  const currentSlashDraftRef = useRef({ text, sessionId, workspaceId });
  currentSlashDraftRef.current = { text, sessionId, workspaceId };
  // Queue-edit remove is a two-step control: the first click arms the button
  // ("Remove?"), the second actually drops the queued message. The arm times
  // out so a stray hover never leaves a live one-click remove behind.
  const [queueEditRemoveArmed, setQueueEditRemoveArmed] = useState(false);
  const queueEditRemoveArmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (queueEditing) return;
    setQueueEditRemoveArmed(false);
    if (queueEditRemoveArmTimerRef.current !== null) {
      clearTimeout(queueEditRemoveArmTimerRef.current);
      queueEditRemoveArmTimerRef.current = null;
    }
  }, [queueEditing]);
  useEffect(
    () => () => {
      if (queueEditRemoveArmTimerRef.current !== null) clearTimeout(queueEditRemoveArmTimerRef.current);
    },
    [],
  );

  // C-1 input history: per-scope (session, or the /new draft's workspace),
  // memory-only, recorded at send time (see lib/drafts.ts). Browsing state is
  // refs — the recalled text renders through the controlled draft, so no UI
  // state needs a rerender of its own. `historySnapshotRef` holds the
  // pre-browse draft that Escape / ArrowDown-past-the-end restores.
  const historyKey = sessionId ?? (workspaceId !== undefined ? `workspace:${workspaceId}` : undefined);
  const inputHistory = historyKey !== undefined ? readInputHistory(historyKey) : [];
  const historyIndexRef = useRef<number | null>(null);
  const historySnapshotRef = useRef('');

  // C-3 composer-local undo/redo: the controlled value defeats the native
  // textarea undo stack, so Ctrl+Z / Ctrl+Shift+Z walk these (text + caret).
  // `lastCursorRef` tracks the caret across select/change events so snapshots
  // know where the caret sat before an edit.
  const undoStackRef = useRef<ComposerUndoEntry[]>([]);
  const redoStackRef = useRef<ComposerUndoEntry[]>([]);
  const lastCursorRef = useRef(0);

  // C-2 skill preview: the slash row under the pointer wins over the
  // keyboard-active row; null falls back to activeIndex.
  const [slashHoverIndex, setSlashHoverIndex] = useState<number | null>(null);

  const modelsQuery = useQuery({
    queryKey: ['models'],
    queryFn: () => client.listModels(),
    staleTime: 60_000,
    retry: retryCatalog,
    retryDelay: catalogRetryDelay,
    refetchInterval: catalogRefetchInterval,
  });
  const models = modelsQuery.data?.items ?? [];

  // Model picker options: the inherit entry first, then the catalog grouped
  // by provider; the model id rides `keywords` so searching works against
  // display names AND raw ids. The inherit row resolves its target against
  // the catalog so an ambiguous bare alias still shows who will serve it.
  const modelOptions: readonly SearchableSelectOption[] = useMemo(
    () => {
      const inheritTargetId = defaultModel ?? serverDefaultModel;
      const inheritResolved =
        inheritTargetId !== undefined ? resolveCatalogModel(models, inheritTargetId) : undefined;
      const inheritDisplay = inheritResolved?.display_name ?? inheritTargetId ?? t('composer.unknown');
      return [
        {
          value: '',
          label:
            defaultModel !== undefined
              ? t('composer.inheritSession', { model: inheritDisplay })
              : t(
                  modelSource === 'local-default'
                    ? 'composer.inheritLocal'
                    : 'composer.inheritServer',
                  { model: inheritDisplay },
                ),
          hint:
            inheritResolved?.display_name !== undefined &&
            inheritResolved.display_name !== inheritTargetId
              ? inheritTargetId
              : undefined,
          badges:
            inheritResolved !== undefined ? [{ label: inheritResolved.provider_id }] : undefined,
        },
        ...models.map((item) => ({
          value: item.id,
          label: `${item.display_name ?? item.id}${item.id === defaultModel ? t('composer.sessionDefaultSuffix') : ''}`,
          // The hint names the local alias: two aliases of one remote model
          // (the supported shape) must stay distinguishable in the picker.
          hint:
            item.display_name !== undefined && item.display_name !== item.id
              ? item.id
              : item.remote_id,
          group: item.provider_id,
          badges: [
            ...(item.capabilities ?? []).map((capability) => ({ label: capability })),
            ...(item.support_efforts ?? []).map((level) => ({
              label:
                level === item.default_effort
                  ? t('composer.modelEffortDefaultBadge', { effort: level })
                  : level,
              accent: level === item.default_effort,
            })),
          ],
          keywords: `${item.id} ${item.remote_id}`,
          title: item.id,
        })),
      ];
    },
    [models, defaultModel, serverDefaultModel, modelSource, t],
  );

  // The effective catalog validates selections without erasing them on an
  // unavailable server or directory; the picker remains a recovery path.
  const agentProfilesQuery = useQuery({
    queryKey: agentProfileCatalogQueryKey(agentProfileCatalogMode),
    queryFn: () => loadAgentProfileCatalog(client, agentProfileCatalogMode),
    enabled: agentProfileCatalogMode.mode !== 'disabled',
    staleTime: 60_000,
    retry: retryCatalog,
    retryDelay: catalogRetryDelay,
    refetchInterval: catalogRefetchInterval,
  });
  const agentProfileOptions: readonly SearchableSelectOption[] = useMemo(
    () => buildAgentProfileOptions(agentProfilesQuery.data?.items ?? [], t),
    [agentProfilesQuery.data, t],
  );
  const profileSelectOptions: readonly SearchableSelectOption[] = useMemo(
    () => onRebuildContext === undefined
      ? agentProfileOptions
      : [
          ...agentProfileOptions,
          {
            value: REBUILD_CONTEXT_OPTION,
            label: t('profile.rebuildMenu'),
            description: t('profile.rebuildMenuDescription'),
            group: t('profile.actionsGroup'),
          },
        ],
    [agentProfileOptions, onRebuildContext, t],
  );
  const validateProfile = agentProfile !== undefined && agentProfileCatalogMode.mode !== 'disabled';
  const validatingModel = model ?? defaultModel ?? serverDefaultModel;
  const selectedModel = validatingModel !== undefined
    ? resolveCatalogModel(models, validatingModel)
    : undefined;
  // An override holding a bare alias (e.g. a profile-pinned k3-256k) displays
  // as the resolved catalog row, so the trigger names the serving provider's
  // model instead of an unmatched raw id.
  const resolvedModelKey = model !== undefined
    ? resolveCatalogModel(models, model)?.id
    : undefined;
  // A transport failure says nothing about whether a preserved selection is valid.
  // During its background retry, React Query is still pending but must not hold send.
  const selectionLoading =
    (modelsQuery.isPending && !isTransientCatalogError(modelsQuery.failureReason)) ||
    (validateProfile && agentProfilesQuery.isPending && !isTransientCatalogError(agentProfilesQuery.failureReason));
  const selectionCatalogError = [modelsQuery.error, validateProfile ? agentProfilesQuery.error : null]
    .find((error) => error !== null && !isTransientCatalogError(error)) ?? null;
  const invalidProfile = validateProfile && agentProfilesQuery.isSuccess
    && !agentProfileOptions.some((item) => item.value === agentProfile);
  const invalidModel = modelsQuery.isSuccess && validatingModel !== undefined && selectedModel === undefined;
  const invalidEffort = modelsQuery.isSuccess && selectedModel !== undefined
    && effort !== undefined && !selectedModel.support_efforts?.includes(effort);
  const selectionBlocked = selectionLoading || selectionCatalogError !== null || invalidProfile || invalidModel || invalidEffort;

  // The composer mount now survives route changes (the conversation shell owns
  // it), so session-scoped transient UI must reset when the session under it
  // changes: an open menu would otherwise filter A's catalog with B's draft.
  const previousSessionIdRef = useRef(sessionId);
  useEffect(() => {
    if (previousSessionIdRef.current === sessionId) return;
    previousSessionIdRef.current = sessionId;
    setMenu(null);
    setSlashConfirm(null);
    setContextRebuildConfirm(false);
    // Session-scoped recall/undo state would otherwise leak A's entries into
    // B's draft surface (the composer mount survives route changes).
    historyIndexRef.current = null;
    undoStackRef.current = [];
    redoStackRef.current = [];
  }, [sessionId]);

  // Skill catalog for the slash menu. Live sessions use GET /sessions/{id}/skills;
  // the /new draft uses GET /workspaces/{id}/skills so the menu fills before a
  // session exists. Session-only shortcuts (/fork, /undo, /compact) stay gated
  // on sessionId — listing skills does not imply those actions are available.
  const skillsQuery = useQuery({
    queryKey: sessionId !== undefined
      ? ['skills', 'session', sessionId]
      : ['skills', 'workspace', workspaceId],
    queryFn: () =>
      sessionId !== undefined
        ? client.listSessionSkills(sessionId)
        : client.listWorkspaceSkills(workspaceId!),
    enabled: sessionId !== undefined || workspaceId !== undefined,
    staleTime: 60_000,
  });
  const skills = skillsQuery.data?.skills ?? [];
  const skillCatalogReady = sessionId !== undefined || workspaceId !== undefined;
  const slashMenuOpen = menu?.kind === 'slash';
  const refetchSkills = skillsQuery.refetch;
  const slashMenuWasOpenRef = useRef(false);
  useEffect(() => {
    const justOpened = slashMenuOpen && !slashMenuWasOpenRef.current;
    slashMenuWasOpenRef.current = slashMenuOpen;
    if (justOpened && skillCatalogReady && skillsQuery.isStale && !skillsQuery.isFetching) {
      void skillsQuery.refetch();
    }
  }, [slashMenuOpen, skillCatalogReady, skillsQuery.isStale, skillsQuery.isFetching, skillsQuery.refetch]);

  const slashItems = useMemo(
    () => buildSlashItems(skills, { hasSession: sessionId !== undefined }),
    [skills, sessionId],
  );
  const filteredSlashItems = useMemo(() => {
    if (menu?.kind !== 'slash') return [];
    const candidates = menu.inline
      ? slashItems.filter((item) => item.kind === 'skill')
      : slashItems;
    return filterSlashItems(candidates, menu.query);
  }, [menu, slashItems]);

  // Debounced file-picker query (fires only while the mention menu is open).
  useEffect(() => {
    if (menu?.kind !== 'mention') return;
    const timer = setTimeout(() => { setMentionQuery(menu.query); }, MENTION_DEBOUNCE_MS);
    return () => { clearTimeout(timer); };
  }, [menu]);
  const fsQuery = useQuery({
    queryKey: ['fs-search', mentionScopeKey ?? sessionId ?? 'none', mentionQuery],
    queryFn: () => fsSearch!(mentionQuery),
    enabled: menu?.kind === 'mention' && fsSearch !== undefined,
    staleTime: 30_000,
  });
  const mentionItems = useMemo(
    () => (menu?.kind === 'mention' ? (fsQuery.data ?? []).slice(0, MENTION_ROW_LIMIT) : []),
    [menu, fsQuery.data],
  );

  const menuRowCount = menu?.kind === 'slash' ? filteredSlashItems.length : mentionItems.length;
  const menuQuery = menu?.query ?? null;
  useEffect(() => {
    setActiveIndex(0);
    setSlashHoverIndex(null);
  }, [menuQuery, menu?.kind]);

  // C-2: the preview card follows the hovered row, else the keyboard-active
  // row; actions already show their whole one-liner inline, and a skill with
  // an empty description degrades to no card at all.
  const slashPreviewItem = useMemo(() => {
    if (menu?.kind !== 'slash') return null;
    const index = slashHoverIndex ?? activeIndex;
    const item = filteredSlashItems[Math.min(index, filteredSlashItems.length - 1)];
    if (item === undefined || item.kind !== 'skill' || item.description.trim() === '') return null;
    return item;
  }, [menu, filteredSlashItems, slashHoverIndex, activeIndex]);

  // Overlay registration keeps Escape scoped to the menu (not turn-abort).
  useEffect(() => {
    if (menu === null) return;
    return registerOverlay('composer-menu');
  }, [menu]);

  // Autosize the textarea up to ~8 lines.
  useEffect(() => {
    const node = textareaRef.current;
    if (node === null) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 190)}px`;
  }, [text]);

  // Placeholder chips (image base64 still reading, file upload still in
  // flight) block sending so a quick Enter cannot silently drop content.
  const pendingAttachments = attachments.some(
    (attachment) =>
      (attachment.kind === 'image' && attachment.data === '') ||
      (attachment.kind === 'upload' && attachment.fileId === undefined),
  );

  // Queue-edit mode only gates on the text itself: the model catalog and
  // attachment reads belong to a real send, not to an in-place queue edit.
  // Selection carry-overs (annotation chips, the quote chip) count as content
  // exactly like attachments: an otherwise empty draft still sends, with the
  // prefix-only text assembled by the parent.
  const canSend = queueEditing
    ? text.trim() !== '' && !disabled && !sendDisabled && !turnInFlight
    : (text.trim() !== '' ||
        attachments.length > 0 ||
        (annotations !== undefined && annotations.length > 0) ||
        (quote !== undefined && quote !== null)) &&
      !disabled &&
      !sendDisabled &&
      !selectionBlocked &&
      !pendingAttachments &&
      !turnInFlight &&
      !slashCatalogPending;

  // The chips band (quote/annotations/goal-mode/attachments/errors/typo
  // guard) only exists with content; it gates the wrapper's top padding above
  // the input.
  const hasChips =
    queueEditing ||
    (quote !== undefined && quote !== null) ||
    (annotations !== undefined && annotations.length > 0) ||
    (goalMode && onChangeGoalMode !== undefined) ||
    attachments.length > 0 ||
    attachmentError !== null ||
    slashConfirm !== null;

  /**
   * Snapshot the pre-edit state. Any genuine edit clears the redo lane —
   * only undo/redo themselves may push without clearing.
   */
  const pushUndoSnapshot = (snapshot: ComposerUndoEntry) => {
    undoStackRef.current.push(snapshot);
    if (undoStackRef.current.length > UNDO_STACK_LIMIT) undoStackRef.current.shift();
    redoStackRef.current = [];
  };

  /** Write a new draft value and land the caret once the controlled value renders. */
  const applyTextChange = (nextText: string, cursor: number) => {
    setMenu(null);
    onChange(nextText);
    lastCursorRef.current = cursor;
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (node !== null) {
        const at = Math.min(cursor, node.value.length);
        node.focus();
        node.setSelectionRange(at, at);
      }
    });
  };

  const undoEdit = () => {
    const entry = undoStackRef.current.pop();
    if (entry === undefined) return;
    redoStackRef.current.push({ text, cursor: lastCursorRef.current });
    historyIndexRef.current = null;
    applyTextChange(entry.text, entry.cursor);
  };

  const redoEdit = () => {
    const entry = redoStackRef.current.pop();
    if (entry === undefined) return;
    undoStackRef.current.push({ text, cursor: lastCursorRef.current });
    historyIndexRef.current = null;
    applyTextChange(entry.text, entry.cursor);
  };

  /**
   * C-1 recall walk. ArrowUp enters from an empty draft or a caret on the
   * first line; once browsing, ↑ ages and ↓ youthens, and ↓ past the newest
   * entry hands the pre-browse draft back. Returns false when the keypress is
   * not ours (no history, caret mid-text) so the caret keeps its native move.
   */
  const recallHistory = (delta: -1 | 1): boolean => {
    if (inputHistory.length === 0) return false;
    if (historyIndexRef.current === null) {
      if (delta !== -1) return false;
      const caret = textareaRef.current?.selectionStart ?? 0;
      const firstLineEnd = text.indexOf('\n');
      if (text !== '' && firstLineEnd !== -1 && caret > firstLineEnd) return false;
      historySnapshotRef.current = text;
      historyIndexRef.current = inputHistory.length - 1;
    } else {
      const next = historyIndexRef.current + delta;
      if (next >= inputHistory.length) {
        historyIndexRef.current = null;
        applyTextChange(historySnapshotRef.current, historySnapshotRef.current.length);
        return true;
      }
      if (next < 0) return true;
      historyIndexRef.current = next;
    }
    const entry = inputHistory[historyIndexRef.current] ?? '';
    applyTextChange(entry, entry.length);
    return true;
  };

  /** Escape while browsing: exit and restore the pre-browse draft. */
  const exitHistoryRecall = (): boolean => {
    if (historyIndexRef.current === null) return false;
    const snapshot = historySnapshotRef.current;
    historyIndexRef.current = null;
    applyTextChange(snapshot, snapshot.length);
    return true;
  };

  /**
   * Every real hand-off (prompt or skill activation) records the submitted
   * text for ↑ recall and snapshots it so Ctrl+Z right after a send can
   * resurrect the prompt. Local shortcut actions (/plan …) are not sent, so
   * they never land here.
   */
  const recordSubmission = () => {
    if (historyKey !== undefined) pushInputHistory(historyKey, text);
    historyIndexRef.current = null;
    pushUndoSnapshot({ text, cursor: lastCursorRef.current });
  };

  const runAction = (action: SlashActionId) => {
    switch (action) {
      case 'plan':
        onChangePlanMode(!planMode);
        break;
      case 'goal':
        if (onChangeGoalMode !== undefined) {
          onChangeGoalMode(true);
        } else {
          setPlanOpen(true);
          setGoalOpen(true);
        }
        break;
      case 'new':
        void navigate('/new');
        break;
      case 'fork':
      case 'undo':
      case 'compact':
        onSessionAction?.(action);
        break;
    }
  };

  /** Accept the highlighted slash item: skills keep composing args, actions run. */
  const acceptSlashItem = (item: SlashItem) => {
    if (item.disabled === true) return;
    const trigger = menu?.kind === 'slash' ? menu : null;
    setMenu(null);
    if (item.kind === 'skill') {
      if (trigger === null) return;
      const completed = completeSlashTrigger(text, trigger, item.name);
      pushUndoSnapshot({ text, cursor: lastCursorRef.current });
      onChange(completed.text);
      lastCursorRef.current = completed.cursor;
      // Caret to the end of the completed token after the controlled value lands.
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (node !== null) {
          node.focus();
          node.setSelectionRange(completed.cursor, completed.cursor);
        }
      });
      return;
    }
    onChange('');
    if (item.action !== undefined) runAction(item.action);
  };

  /** Accept the highlighted file: chip it and lift the `@token` out of the text. */
  const acceptMentionItem = (hit: FsSearchHit) => {
    if (menu?.kind !== 'mention') return;
    const trigger = menu;
    setMenu(null);
    const node = textareaRef.current;
    const cursor = node?.selectionStart ?? text.length;
    const next = text.slice(0, trigger.start) + text.slice(cursor);
    pushUndoSnapshot({ text, cursor: lastCursorRef.current });
    onChange(next);
    lastCursorRef.current = trigger.start;
    const currentAttachments = attachmentBaselineRef.current;
    if (!hasMention(currentAttachments, hit.path)) {
      updateAttachments([
        ...currentAttachments,
        { kind: 'file', path: hit.path, name: hit.name, isDir: hit.kind === 'directory' },
      ]);
    }
    node?.focus();
  };

  type SelectedAttachmentFile = {
    readonly name: string;
    readonly size: number;
    readonly type: string;
    read(): Promise<File>;
  };

  const readyAttachmentFiles = (files: readonly File[]): SelectedAttachmentFile[] =>
    files.map((file) => ({
      name: file.name,
      size: file.size,
      type: file.type,
      read: () => Promise.resolve(file),
    }));

  const addImageFiles = (files: readonly SelectedAttachmentFile[]) => {
    // Reserve stubs against the synchronous baseline before starting reads.
    // A second paste in this same tick therefore sees the first paste's count
    // and byte total even though the controlled prop has not rerendered yet.
    const reservation = reserveImageFiles(files, attachmentBaselineRef.current);
    if (reservation.accepted.length === 0) {
      if (reservation.lastProblem !== null) {
        setAttachmentError(issueText(locale, reservation.lastProblem));
      }
      return;
    }
    setAttachmentError(null);
    attachmentBaselineRef.current = reservation.next;
    const { accepted } = reservation;
    const stubs: readonly ComposerAttachment[] = reservation.stubs;
    // Loading stubs land immediately (chips render + caps reserve); the async
    // reads replace them by identity through updater writes, so back-to-back
    // pastes cannot drop each other's images the way stale render closures did.
    updateAttachments((current) => [...current, ...stubs]);
    void Promise.all(
      accepted.map(async (file) => fileToImageAttachment(await file.read())),
    )
      .then((images) => {
        updateAttachments((current) =>
          current.flatMap((item) => {
            const stubIndex = stubs.indexOf(item);
            if (stubIndex === -1) return [item];
            const image = images[stubIndex];
            return image !== undefined ? [image] : [];
          }),
        );
      })
      .catch((error: unknown) => {
        // Reads failed wholesale: drop this batch's stubs, keep the rest.
        updateAttachments((current) => current.filter((item) => !stubs.includes(item)));
        setAttachmentError(errorText(locale, error));
      });
  };

  const addUploadFiles = (files: readonly SelectedAttachmentFile[]) => {
    // Same synchronous-reservation contract as addImageFiles: stubs land
    // immediately and are replaced by identity once `POST /files` answers.
    const reservation = reserveUploadFiles(files, attachmentBaselineRef.current);
    if (reservation.accepted.length === 0) {
      if (reservation.lastProblem !== null) {
        setAttachmentError(issueText(locale, reservation.lastProblem));
      }
      return;
    }
    setAttachmentError(null);
    attachmentBaselineRef.current = reservation.next;
    const { accepted } = reservation;
    const stubs = reservation.stubs;
    updateAttachments((current) => [...current, ...stubs]);
    for (const [index, file] of accepted.entries()) {
      const stub = stubs[index];
      if (stub === undefined) continue;
      file
        .read()
        .then((contents) => client.uploadFile(contents))
        .then((meta) => {
          updateAttachments((current) =>
            current.map((item) => (item === stub ? { ...stub, fileId: meta.id } : item)),
          );
        })
        .catch((error: unknown) => {
          updateAttachments((current) => current.filter((item) => item !== stub));
          setAttachmentError(
            `${issueText(locale, { key: 'attach.uploadFailed', params: { name: file.name } })} — ${errorText(locale, error)}`,
          );
        });
    }
  };

  // Late async arrivals (native picker resolving after the composer turned
  // disabled, a queued file-input change) must not add attachments.
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled || queueEditing;

  /** Paste/attach-picker entry point: whitelisted images stay image parts; everything else uploads. */
  const addFiles = (files: readonly SelectedAttachmentFile[]) => {
    if (disabledRef.current) return;
    const images: SelectedAttachmentFile[] = [];
    const uploads: SelectedAttachmentFile[] = [];
    for (const file of files) {
      if (ACCEPTED_IMAGE_MIMES.includes(file.type)) images.push(file);
      else uploads.push(file);
    }
    if (images.length > 0) addImageFiles(images);
    if (uploads.length > 0) addUploadFiles(uploads);
  };

  /**
   * The explicit attachment path. Paste was the only way in, which is
   * undiscoverable; the desktop shell opens its native dialog and the browser
   * falls back to a hidden file input. Both land in `addFiles`, so caps,
   * error text and chip rendering are the paste path's, verbatim. (Dropped
   * files are not attachments — they insert their paths as draft text.)
   */
  const fileInputRef = useRef<HTMLInputElement>(null);
  const openAttachPicker = () => {
    if (disabled || queueEditing) return;
    if (host.pickFiles === undefined) {
      fileInputRef.current?.click();
      return;
    }
    void host.pickFiles()
      .then((files) => {
        if (files !== null && files.length > 0) addFiles(files);
      })
      .catch((error: unknown) => { setAttachmentError(errorText(locale, error)); });
  };

  // Drag-highlight depth counter: dragenter/dragleave fire on every child
  // boundary crossing, so a boolean would flicker the overlay off mid-drag.
  const dragDepthRef = useRef(0);
  const [dragActive, setDragActive] = useState(false);
  const dragHasFiles = (event: DragEvent) =>
    [...event.dataTransfer.types].includes('Files');

  /**
   * An HTML5 drop exposes no absolute path outside Electron-style hosts; the
   * bare file name is the fallback there. Desktop drops carry real paths
   * through the host bridge below.
   */
  const droppedFilePath = (file: File): string => {
    const path = (file as File & { readonly path?: unknown }).path;
    return typeof path === 'string' && path !== '' ? path : file.name;
  };

  /**
   * Insert dropped file paths at the caret as one undoable edit (an active
   * selection is replaced, matching native text drops). A drop position
   * cannot resolve to a text offset inside a textarea, so the live selection
   * is always the landing spot.
   */
  const insertDroppedFilePaths = (paths: readonly string[]) => {
    if (disabled) return;
    const node = textareaRef.current;
    const selection =
      node !== null
        ? { start: node.selectionStart, end: node.selectionEnd }
        : { start: lastCursorRef.current, end: lastCursorRef.current };
    const next = insertDroppedPaths(text, selection, paths);
    if (next.text === text) return;
    pushUndoSnapshot({ text, cursor: lastCursorRef.current });
    historyIndexRef.current = null;
    applyTextChange(next.text, next.cursor);
  };

  // The native bridge binds once per host while the inserter closes over a
  // fresh `text` every render — the ref keeps the delivered callback current.
  const insertDroppedFilePathsRef = useRef(insertDroppedFilePaths);
  insertDroppedFilePathsRef.current = insertDroppedFilePaths;

  // Desktop file drops: Tauri intercepts HTML5 drag-and-drop, so real drops
  // arrive through the host bridge carrying absolute paths. Only drops that
  // land on the composer card insert; drops elsewhere stay inert.
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (host.onFileDrop === undefined) return;
    return host.onFileDrop((drop) => {
      const card = cardRef.current;
      if (card === null || drop.paths.length === 0) return;
      if (drop.position !== undefined) {
        const rect = card.getBoundingClientRect();
        const inside =
          drop.position.x >= rect.left &&
          drop.position.x <= rect.right &&
          drop.position.y >= rect.top &&
          drop.position.y <= rect.bottom;
        if (!inside) return;
      }
      insertDroppedFilePathsRef.current(drop.paths);
    });
  }, [host]);

  const submitWithSlashItems = (items: readonly SlashItem[], catalogAvailable: boolean) => {
    const classified = classifySlashSubmission(items, text.trim());
    if (classified !== null) {
      if (classified.kind === 'unknown' || classified.kind === 'disabled') {
        if (catalogAvailable || classified.kind === 'disabled') {
          setSlashConfirm({
            name: classified.kind === 'unknown' ? classified.name : classified.item.name,
            reason: classified.kind,
          });
          return;
        }
        const builtin = parseSlashDraft(text.trim());
        if (!skillCatalogReady && builtin?.query.toLowerCase() === 'kiki-ops' && onActivateSkill !== undefined) {
          activateSkill('kiki-ops', builtin.args);
          return;
        }
      } else {
        if (classified.item.kind === 'skill' && onActivateSkill !== undefined) {
          activateSkill(classified.item.skill?.name ?? classified.item.name, classified.args);
          return;
        }
        if (classified.item.kind === 'action' && classified.item.action !== undefined) {
          // `/goal <text>` sends immediately with the args as `goal_objective`.
          // A bare `/goal` arms the next message when goal mode is available.
          if (classified.item.action === 'goal' && classified.args !== '') {
            sendPrompt(classified.args, { goalObjective: classified.args });
            return;
          }
          // Prose after a client shortcut (`/plan do it`) is a message, not a
          // command — only a bare action token runs the shortcut.
          if (classified.args === '') {
            onChange('');
            runAction(classified.item.action);
            return;
          }
        }
      }
    }
    sendPrompt(text.trim(), goalMode && onChangeGoalMode !== undefined ? { goalObjective: text.trim() } : undefined);
  };

  const send = () => {
    if (!canSend || slashCatalogPendingRef.current) return;
    // Queue-edit mode: the draft IS a queued message's text. Confirming hands
    // it to the queue round-trip (in-place replace at the original slot) —
    // never to command classification, skill activation, or a fresh send.
    if (queueEditing) {
      setMenu(null);
      const edited = text.trim();
      runAgentTurn(async () => {
        await onQueueEditConfirm?.(edited);
      });
      return;
    }
    // An open menu owns Enter: accept the highlighted row instead of sending.
    if (menu !== null && menuRowCount > 0) {
      if (menu.kind === 'slash') {
        const item = filteredSlashItems[Math.min(activeIndex, filteredSlashItems.length - 1)];
        if (item !== undefined) acceptSlashItem(item);
      } else {
        const item = mentionItems[Math.min(activeIndex, mentionItems.length - 1)];
        if (item !== undefined) acceptMentionItem(item);
      }
      return;
    }
    setMenu(null);
    if (text.trim().startsWith('/') && skillCatalogReady && !skillsQuery.isSuccess) {
      slashCatalogPendingRef.current = true;
      setSlashCatalogPending(true);
      void refetchSkills({ cancelRefetch: false }).then((result) => {
        slashCatalogPendingRef.current = false;
        setSlashCatalogPending(false);
        const current = currentSlashDraftRef.current;
        if (current.text !== text || current.sessionId !== sessionId || current.workspaceId !== workspaceId) return;
        if (result.data === undefined) {
          setAttachmentError(t('composer.slash.submitCatalogFailed'));
          return;
        }
        setAttachmentError((previous) => previous === t('composer.slash.submitCatalogFailed') ? null : previous);
        submitWithSlashItems(buildSlashItems(result.data.skills, { hasSession: sessionId !== undefined }), true);
      });
      return;
    }
    submitWithSlashItems(slashItems, skillsQuery.isSuccess);
  };

  /**
   * Send-intent latch: the ref flips synchronously on the first trigger, so a
   * rapid second click/Enter during the submit round trip (before the parent
   * clears the draft or `busy` arrives) is a no-op instead of a duplicate
   * send. The latch releases once the handler's promise settles — failure
   * included, so the button comes back for a retry. `canSend` reads the state
   * twin, disabling the button in the same render.
   */
  const runAgentTurn = (turn: () => Promise<void>) => {
    if (turnInFlightRef.current) return;
    turnInFlightRef.current = true;
    setTurnInFlight(true);
    void turn()
      .catch((error: unknown) => {
        setAttachmentError(errorText(locale, error));
      })
      .finally(() => {
        turnInFlightRef.current = false;
        setTurnInFlight(false);
      });
  };

  const sendPrompt = (content: string, options?: { readonly goalObjective?: string }) => {
    // Keep the two-argument call shape for plain sends: existing callers and
    // test spies assert on exactly (text, attachments).
    const deliver = (prepared: string) =>
      options === undefined ? onSend(prepared, attachments) : onSend(prepared, attachments, options);
    if (!vscodeRuntime) {
      runAgentTurn(async () => {
        recordSubmission();
        await deliver(content);
      });
      return;
    }
    runAgentTurn(async () => {
      const prepared = await vscodeHost.preparePrompt(content, vscodeConversationId, true);
      recordSubmission();
      await deliver(prepared);
    });
  };

  const activateSkill = (name: string, args: string) => {
    if (!vscodeRuntime) {
      runAgentTurn(async () => {
        recordSubmission();
        await onActivateSkill?.(name, args, attachments);
      });
      return;
    }
    runAgentTurn(async () => {
      await vscodeHost.preparePrompt('', vscodeConversationId, false);
      recordSubmission();
      await onActivateSkill?.(name, args, attachments);
    });
  };

  /** "Send anyway" from the typo guard: plain prompt, no command resolution. */
  const confirmSendPlain = () => {
    if (!canSend) return;
    setSlashConfirm(null);
    setMenu(null);
    sendPrompt(text.trim());
  };

  /** Recompute the trigger-driven menu after any text/caret change. */
  const refreshMenu = (nextText: string, cursor: number) => {
    const slashTrigger = parseSlashTrigger(nextText, cursor);
    if (slashTrigger !== null) {
      setMenu({ kind: 'slash', ...slashTrigger });
      return;
    }
    if (fsSearch !== undefined) {
      const trigger = parseMentionTrigger(nextText, cursor);
      if (trigger !== null) {
        setMenu({ kind: 'mention', start: trigger.start, query: trigger.query });
        return;
      }
    }
    setMenu(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition owns every key while it is open — Enter/Tab/arrows/
    // Escape all belong to the candidate window. Intercepting them (the menu
    // branches below used to run first) eats the commit key and leaves the
    // half-committed text stranded. keyCode 229 covers engines that skip the
    // isComposing flag on keydown.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (menu !== null && menuRowCount > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        setActiveIndex((index) => (index + delta + menuRowCount) % menuRowCount);
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        if (menu.kind === 'slash') {
          const item = filteredSlashItems[Math.min(activeIndex, filteredSlashItems.length - 1)];
          if (item !== undefined) acceptSlashItem(item);
        } else {
          const item = mentionItems[Math.min(activeIndex, mentionItems.length - 1)];
          if (item !== undefined) acceptMentionItem(item);
        }
        return;
      }
    }
    if (event.key === 'Escape' && menu !== null) {
      event.preventDefault();
      setMenu(null);
      return;
    }
    if (event.key === 'Escape' && exitHistoryRecall()) {
      event.preventDefault();
      return;
    }
    // Queue-edit mode: Escape hands the pre-edit draft back (one Esc per
    // layer — an open menu or history browse above eats its own first).
    if (event.key === 'Escape' && queueEditing) {
      event.preventDefault();
      onQueueEditCancel?.();
      return;
    }
    // Composer-local undo/redo: the controlled value defeats the native
    // textarea undo stack, so these walk our snapshot lane instead.
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redoEdit();
      else undoEdit();
      return;
    }
    // History recall lives strictly below the menu branches: an open slash or
    // mention menu keeps owning ↑/↓ exactly as before.
    if (
      (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
      menu === null &&
      !event.ctrlKey && !event.metaKey && !event.altKey &&
      recallHistory(event.key === 'ArrowUp' ? -1 : 1)
    ) {
      event.preventDefault();
      return;
    }
    // An open menu always owns plain Enter (accept the row), even when the
    // send shortcut is ⌘/Ctrl+Enter.
    if (menu !== null && menuRowCount > 0 && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
      return;
    }
    if (isComposerSendKey(event, sendShortcut)) {
      event.preventDefault();
      send();
      return;
    }
    // Ctrl/Cmd+Enter always sends immediately, whatever the configured send
    // shortcut is (an open menu still owns Enter above).
    if (event.key === 'Enter' && !event.shiftKey && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      send();
    }
  };

  const effectiveModel = model ?? defaultModel ?? serverDefaultModel;

  // Focus continuity across a busy flip: becoming `disabled` force-blurs the
  // textarea (platform behavior), which used to be invisible because the
  // composer remounted on route changes anyway. With the resident shell seat
  // the node survives — so a blur CAUSED by the disable (element already
  // disabled at blur time) arms a one-shot refocus when the composer
  // re-enables. A deliberate click-away while enabled never arms it, and a
  // cold session open (never focused) has nothing to restore.
  //
  // The arming listener is NATIVE: Chromium fires `blur` but not `focusout`
  // when disabling a focused element, and React's onBlur is focusout-based —
  // it never sees this blur (verified via .tmp/focus-probe.mjs).
  const refocusOnEnableRef = useRef(false);
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    const armOnDisableBlur = () => {
      if (textarea.disabled) refocusOnEnableRef.current = true;
    };
    textarea.addEventListener('blur', armOnDisableBlur);
    return () => textarea.removeEventListener('blur', armOnDisableBlur);
  }, []);
  useEffect(() => {
    if (disabled || !refocusOnEnableRef.current) return;
    refocusOnEnableRef.current = false;
    textareaRef.current?.focus();
  }, [disabled]);

  const confirmContextRebuild = () => {
    if (onRebuildContext === undefined || contextRebuildBusy) return;
    setContextRebuildBusy(true);
    void onRebuildContext()
      .then((result) => {
        pushToast({
          tone: 'success',
          text: t(result.changed ? 'profile.rebuildDoneChanged' : 'profile.rebuildDoneUnchanged'),
        });
      })
      .catch((error: unknown) => {
        pushToast({
          tone: 'error',
          text: t('profile.rebuildFailed', {
            detail: error instanceof Error ? error.message : String(error),
          }),
        });
      })
      .finally(() => {
        setContextRebuildBusy(false);
        setContextRebuildConfirm(false);
      });
  };

  return (
    <div className="px-6 pb-5" data-composer-variant={variant}>
      {composerContextMenu}
      <ConfirmDialog
        open={contextRebuildConfirm}
        overlayId="confirm-context-rebuild"
        title={t('profile.rebuildTitle')}
        body={t('profile.rebuildBody')}
        consequences={[t('profile.rebuildKeepsHistory'), t('profile.rebuildLatestSources')]}
        confirmLabel={t('profile.rebuildConfirm')}
        tone="default"
        busy={contextRebuildBusy}
        onConfirm={confirmContextRebuild}
        onCancel={() => { if (!contextRebuildBusy) setContextRebuildConfirm(false); }}
      />
      {/* One width axis with the transcript: the conversation shell declares
          --kiki-chat-content-width; the 760px fallback is defensive. */}
      <div className="mx-auto max-w-[var(--kiki-chat-content-width,760px)]">
        {selectionBlocked ? <div data-selection-diagnostic role={selectionLoading ? 'status' : 'alert'} className="mb-2 space-y-1 rounded-lg border border-hairline bg-paper px-3 py-2 text-[11.5px] text-danger">
          {selectionLoading ? <p className="text-ink-soft">{t('selection.loading')}</p> : null}
          {selectionCatalogError !== null ? <p>{t('selection.catalogError', { detail: selectionCatalogError.message })}</p> : null}
          {invalidProfile ? <p>{t('selection.profileInvalid', { value: agentProfile! })}</p> : null}
          {invalidModel ? <p>{t('selection.modelInvalid', { value: validatingModel! })}</p> : null}
          {invalidEffort ? <p>{t('selection.effortInvalid', { value: effort! })}</p> : null}
          {selectionCatalogError !== null ? <button type="button" className="underline" onClick={() => { void modelsQuery.refetch(); if (validateProfile) void agentProfilesQuery.refetch(); }}>{t('common.retry')}</button> : null}
          {invalidEffort ? <button type="button" className="underline" onClick={() => { onChangeEffort(resolveSelectedEffort(selectedModel?.support_efforts, undefined, selectedModel?.default_effort)); }}>{t('selection.resetEffort')}</button> : null}
        </div> : null}
        <div
          ref={cardRef}
          className={`relative rounded-2xl border bg-panel shadow-[0_2px_4px_rgba(28,25,23,0.03),0_16px_40px_-20px_rgba(28,25,23,0.18)] transition-[border-color,box-shadow] ${
            dragActive ? 'border-accent ring-2 ring-accent/40' : 'border-hairline'
          }`}
          onDragEnter={(event) => {
            if (!dragHasFiles(event)) return;
            event.preventDefault();
            dragDepthRef.current += 1;
            setDragActive(true);
          }}
          onDragOver={(event) => {
            if (dragHasFiles(event)) event.preventDefault();
          }}
          onDragLeave={(event) => {
            if (!dragHasFiles(event)) return;
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
            if (dragDepthRef.current === 0) setDragActive(false);
          }}
          onDrop={(event) => {
            dragDepthRef.current = 0;
            setDragActive(false);
            const files = [...event.dataTransfer.files];
            if (files.length === 0) return;
            event.preventDefault();
            insertDroppedFilePaths(files.map(droppedFilePath));
          }}
        >
          {dragActive ? (
            <div className="pointer-events-none absolute inset-0 z-20 rounded-2xl border-2 border-dashed border-accent/60 bg-panel/85" />
          ) : null}
          {/* Chips ride above the input; the toolbar lives below it. The
              wrapper only renders when at least one chip/banner exists so the
              textarea keeps its comfortable top padding on an empty draft. */}
          {hasChips ? (
            <div className="pt-2 pb-1.5">
          {queueEditing ? (
            <div
              data-queue-edit-banner
              className="anim-enter mx-3.5 mt-2 flex items-center gap-2 rounded-lg border border-amber-rule/40 bg-amber-card px-2.5 py-1.5"
            >
              <span aria-hidden className="shrink-0 text-[11.5px] leading-snug text-amber-ink">
                ✎
              </span>
              <p className="min-w-0 flex-1 truncate text-[11.5px] leading-snug text-amber-ink">
                {t('composer.queueEditBanner')}
              </p>
              <button
                type="button"
                aria-label={t('composer.queueEditCancel')}
                title={t('composer.queueEditCancel')}
                onClick={() => { onQueueEditCancel?.(); }}
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-amber-ink/60 transition-colors hover:bg-amber-ink/10 hover:text-amber-ink"
              >
                ×
              </button>
            </div>
          ) : null}
          {quote !== undefined && quote !== null ? (
            <div
              data-quote-chip
              className="anim-enter mx-3.5 mt-2 flex items-start gap-2 rounded-lg border-l-2 border-accent/60 bg-paper px-2.5 py-1.5"
            >
              <p
                title={quote}
                className="max-h-8 min-w-0 flex-1 overflow-hidden text-[11.5px] leading-snug whitespace-pre-wrap text-ink-soft"
              >
                {quote}
              </p>
              <button
                type="button"
                aria-label={t('composer.removeQuote')}
                onClick={onRemoveQuote}
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-hairline hover:text-ink"
              >
                ×
              </button>
            </div>
          ) : null}
          {annotations !== undefined && annotations.length > 0 ? (
            <div data-annotation-chips className="mx-3.5 mt-2 flex flex-col gap-1.5">
              {annotations.map((annotation) => (
                <div
                  key={annotation.id}
                  data-annotation-chip
                  tabIndex={0}
                  className="group anim-enter relative flex items-start gap-2 rounded-lg border-l-2 border-amber-rule bg-amber-card px-2.5 py-1.5 outline-none"
                >
                  <span aria-hidden className="shrink-0 text-[11.5px] leading-snug text-amber-ink">
                    ✎
                  </span>
                  <p className="min-w-0 flex-1 truncate text-[11.5px] leading-snug text-amber-ink">
                    {annotation.comment}
                  </p>
                  <button
                    type="button"
                    aria-label={t('composer.removeAnnotation')}
                    onClick={() => { onRemoveAnnotation?.(annotation.id); }}
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-amber-ink/60 transition-colors hover:bg-amber-ink/10 hover:text-amber-ink"
                  >
                    ×
                  </button>
                  {/* Hover/focus reveal: the full quoted source + comment. The
                      chip itself is focusable so click/touch opens it too. */}
                  <div className="pointer-events-none absolute bottom-full left-0 z-40 mb-1 hidden w-72 max-w-[calc(100vw-48px)] rounded-lg border border-amber-rule/50 bg-panel p-2 shadow-[0_12px_32px_-12px_rgba(28,25,23,0.35)] group-hover:block group-focus-within:block">
                    <p className="max-h-16 overflow-hidden border-l-2 border-accent/60 pl-1.5 text-[11px] leading-snug whitespace-pre-wrap text-ink-soft">
                      {annotation.quote}
                    </p>
                    <p className="mt-1.5 text-[11.5px] leading-snug whitespace-pre-wrap text-amber-ink">
                      {annotation.comment}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {/* Goal mode armed: the next message becomes the session goal. The
              run-state card (pause/resume/cancel/edit) lives above the
              composer dock — see GoalCard. */}
          {goalMode && onChangeGoalMode !== undefined ? (
            <div
              data-goal-armed
              role="group"
              aria-label={t('composer.goalArmedAria')}
              className="anim-enter mx-3.5 mt-2 flex w-fit items-center gap-1.5 rounded-full border border-accent/50 bg-accent-soft/60 py-0.5 pr-1 pl-2.5 text-[11px] font-medium text-accent"
            >
              <span>{t('composer.goalArmedChip')}</span>
              <button
                type="button"
                aria-label={t('composer.goalDisarmAria')}
                title={t('composer.goalDisarmAria')}
                onClick={() => { onChangeGoalMode(false); }}
                className="flex h-4 w-4 items-center justify-center rounded-full text-[9px] text-accent/70 transition-colors hover:bg-accent/15 hover:text-accent"
              >
                <span aria-hidden>✕</span>
              </button>
            </div>
          ) : null}
          {attachments.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 px-3.5 pt-2 pb-1" data-attachment-chips>
              {attachments.map((attachment, index) =>
                attachment.kind === 'file' ? (
                  <span
                    key={`file-${attachment.path}`}
                    title={attachment.path}
                    className="flex items-center gap-1 rounded-full border border-hairline bg-paper py-0.5 pr-1 pl-2 font-mono text-[11px] text-ink-soft"
                  >
                    {attachment.isDir ? '📁' : '📄'} {attachment.name}
                    {attachment.isDir ? '/' : ''}
                    <button
                      type="button"
                      aria-label={t('composer.removeAttachment', { name: attachment.name })}
                      onClick={() => {
                        updateAttachments(attachments.filter((_, i) => i !== index));
                      }}
                      className="flex h-4 w-4 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-hairline hover:text-ink"
                    >
                      ×
                    </button>
                  </span>
                ) : attachment.kind === 'upload' ? (
                  <span
                    key={`upload-${attachment.name}-${attachment.size}`}
                    title={`${attachment.name} · ${attachment.mediaType} · ${formatBytes(attachment.size)}`}
                    aria-label={
                      attachment.fileId === undefined ? t('composer.attachmentUploading') : undefined
                    }
                    data-attachment-uploading={attachment.fileId === undefined ? '' : undefined}
                    className="flex items-center gap-1.5 rounded-full border border-hairline bg-paper py-0.5 pr-1 pl-2 text-[11px] text-ink-soft"
                  >
                    {attachment.fileId === undefined ? (
                      <span className="status-dot-busy flex h-4 w-4 items-center justify-center">
                        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                      </span>
                    ) : (
                      <span aria-hidden>📎</span>
                    )}
                    <span className="max-w-32 truncate">
                      {attachment.name === '' ? t('attach.pastedFile') : attachment.name}
                    </span>
                    <span className="font-mono text-[9.5px] text-ink-faint">
                      {formatBytes(attachment.size)}
                    </span>
                    <button
                      type="button"
                      aria-label={t('composer.removeAttachment', {
                        name: attachment.name === '' ? t('attach.pastedFile') : attachment.name,
                      })}
                      onClick={() => {
                        updateAttachments(attachments.filter((_, i) => i !== index));
                      }}
                      className="flex h-4 w-4 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-hairline hover:text-ink"
                    >
                      ×
                    </button>
                  </span>
                ) : attachment.data === '' ? (
                  // Read-in-flight placeholder: a pulsing dot instead of a
                  // preview, and sending stays blocked until data lands.
                  <span
                    key={`image-${attachment.name}-${attachment.size}`}
                    title={t('composer.attachmentReading')}
                    aria-label={t('composer.attachmentReading')}
                    data-attachment-reading
                    className="flex items-center gap-1.5 rounded-full border border-hairline bg-paper py-0.5 pr-1 pl-2 text-[11px] text-ink-soft"
                  >
                    <span className="status-dot-busy flex h-4 w-4 items-center justify-center">
                      <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                    </span>
                    <span className="max-w-32 truncate">
                      {attachment.name === '' ? t('attach.pastedImage') : attachment.name}
                    </span>
                    <span className="font-mono text-[9.5px] text-ink-faint">
                      {formatBytes(attachment.size)}
                    </span>
                    <button
                      type="button"
                      aria-label={t('composer.removeAttachment', {
                        name: attachment.name === '' ? t('attach.pastedImage') : attachment.name,
                      })}
                      onClick={() => {
                        updateAttachments(attachments.filter((_, i) => i !== index));
                      }}
                      className="flex h-4 w-4 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-hairline hover:text-ink"
                    >
                      ×
                    </button>
                  </span>
                ) : (
                  <span
                    key={`image-${attachment.name}-${attachment.size}`}
                    title={`${attachment.name === '' ? t('attach.pastedImage') : attachment.name} · ${formatBytes(attachment.size)}`}
                    className="flex items-center gap-1.5 rounded-full border border-hairline bg-paper py-0.5 pr-1 pl-0.5 text-[11px] text-ink-soft"
                  >
                    <img
                      src={attachment.previewUrl}
                      alt={attachment.name === '' ? t('attach.pastedImage') : attachment.name}
                      className="h-5 w-5 rounded-full object-cover"
                    />
                    <span className="max-w-32 truncate">
                      {attachment.name === '' ? t('attach.pastedImage') : attachment.name}
                    </span>
                    <span className="font-mono text-[9.5px] text-ink-faint">
                      {formatBytes(attachment.size)}
                    </span>
                    <button
                      type="button"
                      aria-label={t('composer.removeAttachment', {
                        name: attachment.name === '' ? t('attach.pastedImage') : attachment.name,
                      })}
                      onClick={() => {
                        updateAttachments(attachments.filter((_, i) => i !== index));
                      }}
                      className="flex h-4 w-4 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-hairline hover:text-ink"
                    >
                      ×
                    </button>
                  </span>
                ),
              )}
            </div>
          ) : null}
          {attachmentError !== null ? (
            <p className="px-3.5 pt-1.5 font-mono text-[10.5px] text-danger">{attachmentError}</p>
          ) : null}
          {slashConfirm !== null ? (
            <div
              role="alert"
              data-slash-confirm
              className="mx-3.5 mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-amber-rule/40 bg-amber-card px-2.5 py-1.5 text-[11px] font-medium text-amber-ink"
            >
              <span>
                {slashConfirm.reason === 'unknown'
                  ? t('composer.slash.unknownPrompt', { name: slashConfirm.name })
                  : t('composer.slash.disabledPrompt', { name: slashConfirm.name })}
              </span>
              <span className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={confirmSendPlain}
                  disabled={!canSend}
                  className="rounded-full border border-amber-ink/30 px-2 py-0.5 text-[10.5px] transition-colors hover:bg-amber-ink/10 disabled:opacity-50"
                >
                  {t('composer.slash.sendAnyway')}
                </button>
                <button
                  type="button"
                  onClick={() => { setSlashConfirm(null); }}
                  className="rounded-full border border-transparent px-2 py-0.5 text-[10.5px] text-amber-ink/80 underline transition-colors hover:bg-amber-ink/10"
                >
                  {t('composer.slash.cancelSend')}
                </button>
              </span>
            </div>
          ) : null}
            </div>
          ) : null}

          <div className="relative px-3.5 pt-1.5">
            {menu !== null ? (
              <div
                data-composer-menu
                role="listbox"
                aria-label={menu.kind === 'slash' ? t('composer.slashAria') : t('composer.filesAria')}
                className="anim-enter absolute right-0 bottom-full left-0 z-30 mb-1 max-h-72 overflow-y-auto rounded-xl border border-hairline bg-panel p-1 shadow-[0_12px_32px_-12px_rgba(28,25,23,0.35)]"
                // Keep textarea focus while rows are clicked.
                onMouseDown={(event) => { event.preventDefault(); }}
                onMouseLeave={() => { setSlashHoverIndex(null); }}
              >
                {menu.kind === 'slash' ? (
                  <SlashMenuBody
                    items={filteredSlashItems}
                    activeIndex={activeIndex}
                    skillsFailed={skillsQuery.isError}
                    hasSession={skillCatalogReady}
                    onAccept={acceptSlashItem}
                    onHoverRow={setSlashHoverIndex}
                  />
                ) : (
                  <MentionMenuBody
                    items={mentionItems}
                    activeIndex={activeIndex}
                    loading={fsQuery.isLoading || fsQuery.isFetching}
                    failed={fsQuery.isError}
                    query={menu.query}
                    onAccept={acceptMentionItem}
                  />
                )}
              </div>
            ) : null}
            {slashPreviewItem !== null ? (
              <SkillPreviewCard item={slashPreviewItem} />
            ) : null}
            <textarea
              ref={textareaRef}
              rows={1}
              value={text}
              data-composer
              data-autofocus={autoFocus === true ? '' : undefined}
              disabled={disabled}
              onChange={(event) => {
                // User edits only: programmatic value writes never fire this.
                pushUndoSnapshot({ text, cursor: lastCursorRef.current });
                // An edit while browsing history ends the browse; the edited
                // text stands (the pre-browse draft is superseded by it).
                historyIndexRef.current = null;
                onChange(event.target.value);
                lastCursorRef.current = event.target.selectionStart;
                setSlashConfirm(null);
                refreshMenu(event.target.value, event.target.selectionStart);
              }}
              onKeyDown={onKeyDown}
              onKeyUp={(event) => {
                // Caret moves (arrows/Home/End) re-evaluate the trigger.
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                  refreshMenu(text, event.currentTarget.selectionStart);
                }
              }}
              onClick={(event) => { refreshMenu(text, event.currentTarget.selectionStart); }}
              onSelect={(event) => {
                lastCursorRef.current = event.currentTarget.selectionStart;
              }}
              onContextMenu={onComposerContextMenu}
              onBlur={(event) => {
                setMenu(null);
                // Redundant arming path for engines that DO fire focusout on
                // disable; the native listener above covers Chromium.
                if (event.currentTarget.disabled) refocusOnEnableRef.current = true;
              }}
              onPaste={(event) => {
                const files = [...event.clipboardData.files];
                if (files.length === 0) return;
                event.preventDefault();
                addFiles(readyAttachmentFiles(files));
              }}
              placeholder={
                disabled
                  ? (disabledPlaceholder ?? t('composer.placeholder'))
                  : busy
                    ? (busyPlaceholder ?? t('composer.placeholderBusy'))
                    : t('composer.placeholder')
              }
              className="max-h-[190px] min-h-[24px] w-full resize-none bg-transparent py-0.5 text-[14px] leading-relaxed text-ink outline-none placeholder:text-ink-faint disabled:opacity-60"
            />
          </div>

          {/* Bottom toolbar: one control per concern on the left — attach,
              permission mode, plan/swarm/goal, agent profile, model+effort —
              on one line while the width allows, wrapping below it; the send
              cluster pins right. The input above is the surface's subject. */}
          <div
            data-composer-toolbar
            className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1.5 rounded-b-2xl border-t border-hairline bg-paper/60 px-2.5 py-2"
          >
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                disabled={disabled || queueEditing}
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])];
                  // Reset so re-picking the same file fires change again.
                  event.target.value = '';
                  if (files.length > 0) addFiles(readyAttachmentFiles(files));
                }}
              />
              <button
                type="button"
                data-attach-button
                onClick={openAttachPicker}
                disabled={disabled || queueEditing}
                aria-label={t('composer.attachAria')}
                title={t('composer.attachTitle')}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-hairline bg-panel text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                  <path d="M6 2.5v7M2.5 6h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
              {variant !== 'subagent' ? (
                <>
                  <ModeSelect
                    open={modeOpen}
                    onOpenChange={setModeOpen}
                    value={permissionMode}
                    onChange={onChangePermissionMode}
                  />
                  <PlanSelect
                    open={planOpen}
                    onOpenChange={setPlanOpen}
                    planMode={planMode}
                    onChangePlanMode={onChangePlanMode}
                    planGate={planGate}
                    onChangePlanGate={onChangePlanGate}
                    swarmMode={swarmMode}
                    onChangeSwarmMode={onChangeSwarmMode}
                    goalObjective={goalObjective}
                    onChangeGoalObjective={onChangeGoalObjective}
                    goalOpen={goalOpen}
                    onGoalOpenChange={setGoalOpen}
                  />
                  {onChangeGoalMode !== undefined ? (
                    <button
                      type="button"
                      data-goal-mode-toggle
                      aria-pressed={goalMode}
                      aria-label={t('composer.goalArmedAria')}
                      title={t('composer.goalModeTitle')}
                      onClick={() => { onChangeGoalMode(!goalMode); }}
                      className={`flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none ${
                        goalMode
                          ? 'border-accent bg-accent-soft text-accent'
                          : 'border-hairline bg-panel text-ink-soft hover:border-hairline-strong'
                      }`}
                    >
                      <span aria-hidden className="text-[10px]">◎</span>
                      {t('composer.goal')}
                    </button>
                  ) : null}
                </>
              ) : null}
              {onChangeAgentProfile !== undefined && agentProfile !== undefined ? (
                <div className="min-w-0">
                  <SearchableSelect
                    id="composer-agent-profile-select"
                    options={profileSelectOptions}
                    value={agentProfile ?? DEFAULT_AGENT_PROFILE}
                    onChange={(value) => {
                      if (value === REBUILD_CONTEXT_OPTION) {
                        setContextRebuildConfirm(true);
                        return;
                      }
                      onChangeAgentProfile(value);
                    }}
                    disabled={busy}
                    title={
                      busy
                        ? t('profile.rebuildBusy')
                        : agentProfilePending
                          ? t('composer.agentProfilePendingTitle')
                          : t('composer.agentProfileTitle')
                    }
                    ariaLabel={t('composer.agentProfileAria')}
                    emptyText={t('composer.noAgentProfiles')}
                    searchPlaceholder={t('composer.profileSearchPlaceholder')}
                    placement="above"
                    panelClassName="anim-enter absolute z-40 bottom-full left-0 mb-1.5 w-96 max-w-[calc(100vw-48px)] overflow-hidden rounded-xl border border-hairline bg-panel shadow-[0_12px_32px_-12px_rgba(28,25,23,0.35)]"
                    buttonClassName={`flex max-w-44 items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/30 ${
                      agentProfilePending
                        ? 'border-accent bg-accent-soft text-accent'
                        : 'border-hairline bg-panel text-ink-soft hover:border-hairline-strong'
                    }`}
                  />
                </div>
              ) : null}
              <div className="min-w-0">
                <ModelChip
                  modelOptions={modelOptions}
                  hasCatalog={models.length > 0}
                  model={model}
                  resolvedModelKey={resolvedModelKey}
                  effectiveModel={effectiveModel}
                  modelSource={modelSource}
                  disabled={variant === 'subagent' && disabled}
                  onChangeModel={onChangeModel}
                  efforts={efforts}
                  effort={effort}
                  onChangeEffort={onChangeEffort}
                />
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {queueEditing && onQueueEditRemove !== undefined ? (
                // Queue-edit mode: the stop button becomes the remove control
                // for the queued message being edited (two-step: arm, then
                // confirm). Turn abort resumes when the edit ends.
                <button
                  type="button"
                  onClick={() => {
                    if (!queueEditRemoveArmed) {
                      setQueueEditRemoveArmed(true);
                      if (queueEditRemoveArmTimerRef.current !== null) {
                        clearTimeout(queueEditRemoveArmTimerRef.current);
                      }
                      queueEditRemoveArmTimerRef.current = setTimeout(() => {
                        setQueueEditRemoveArmed(false);
                        queueEditRemoveArmTimerRef.current = null;
                      }, 5_000);
                      return;
                    }
                    setQueueEditRemoveArmed(false);
                    if (queueEditRemoveArmTimerRef.current !== null) {
                      clearTimeout(queueEditRemoveArmTimerRef.current);
                      queueEditRemoveArmTimerRef.current = null;
                    }
                    onQueueEditRemove();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && queueEditRemoveArmed) {
                      event.preventDefault();
                      setQueueEditRemoveArmed(false);
                    }
                  }}
                  title={queueEditRemoveArmed ? t('composer.queueEditRemoveConfirm') : t('composer.queueEditRemoveTitle')}
                  aria-label={queueEditRemoveArmed ? t('composer.queueEditRemoveConfirm') : t('composer.queueEditRemoveAria')}
                  className={`flex h-8 shrink-0 items-center justify-center rounded-full border transition-colors focus-visible:ring-2 focus-visible:ring-danger/40 focus-visible:outline-none ${
                    queueEditRemoveArmed
                      ? 'gap-1 border-danger/60 bg-danger/10 px-2.5 text-[11px] font-medium text-danger hover:bg-danger/20'
                      : 'w-8 border-danger/40 text-danger hover:bg-danger/10'
                  }`}
                >
                  {queueEditRemoveArmed ? (
                    t('composer.queueEditRemoveConfirm')
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
                      <path
                        d="M2.5 4h11M6.5 4V2.9a.4.4 0 0 1 .4-.4h2.2a.4.4 0 0 1 .4.4V4m-7.2 0 .65 8.15a1.4 1.4 0 0 0 1.4 1.35h3.3a1.4 1.4 0 0 0 1.4-1.35L13.7 4M6.6 6.8v4.4m2.8-4.4v4.4"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </button>
              ) : busy && onAbort !== undefined ? (
                <button
                  type="button"
                  onClick={onAbort}
                  disabled={abortPending}
                  title={abortPending === true ? t('tasks.stopping') : t('composer.abortTitle')}
                  aria-label={abortPending === true ? t('tasks.stopping') : t('composer.abortTitle')}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-danger/40 text-danger transition-colors hover:bg-danger/10 focus-visible:ring-2 focus-visible:ring-danger/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span aria-hidden className="text-[11px] font-bold">■</span>
                </button>
              ) : null}
              {/* While busy, Send stays mounted beside Stop so a queued prompt
                  has a mouse path too (Enter works as before). */}
              <button
                type="button"
                onClick={send}
                disabled={!canSend}
                title={
                  queueEditing
                    ? t(sendShortcut === 'cmd-enter' ? 'composer.queueEditConfirmTitleCmdEnter' : 'composer.queueEditConfirmTitle')
                    : sendDisabled && !disabled && sendDisabledTitle !== undefined
                      ? sendDisabledTitle
                      : busy
                        ? t(sendShortcut === 'cmd-enter' ? 'composer.queueTitleCmdEnter' : 'composer.queueTitle')
                        : t(sendShortcut === 'cmd-enter' ? 'composer.sendTitleCmdEnter' : 'composer.sendTitle')
                }
                aria-label={queueEditing ? t('composer.queueEditConfirm') : busy ? t('composer.queueAria') : t('composer.sendAria')}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-white transition-colors hover:bg-accent-deep disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:outline-none"
              >
                {queueEditing ? (
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <path
                      d="M3 8.5 6.5 12 13 4.5"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <path
                      d="M2.5 8h10M9 3.5 13.5 8 9 12.5"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
        {/* The hint line teaches an empty draft and then gets out of the way;
            the min-height keeps the meter from hopping as it appears. */}
        <div className="mt-1.5 flex items-center gap-3">
          <div className="min-h-4 min-w-0 flex-1">
            {text.trim() === '' && !busy ? (
              <p data-composer-hints className="text-center text-[10.5px] text-ink-faint">
                {t(sendShortcut === 'cmd-enter' ? 'composer.footerBaseCmdEnter' : 'composer.footerBase')}
                {t(skillCatalogReady ? 'composer.footerSkills' : 'composer.footerShortcuts')}
                {fsSearch !== undefined ? t('composer.footerFiles') : ''}
                {inputHistory.length > 0 ? t('composer.footerHistory') : ''}
              </p>
            ) : null}
          </div>
          {contextUsage !== undefined ? (
            <ContextMeter
              used={contextUsage.used}
              limit={contextUsage.limit}
              usage={sessionUsage}
              usageScope={variant === 'subagent' ? 'agent' : 'session'}
              sessionId={sessionId}
              onCompact={onCompactContext}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SlashMenuBody({
  items,
  activeIndex,
  skillsFailed,
  hasSession,
  onAccept,
  onHoverRow,
}: {
  items: readonly SlashItem[];
  activeIndex: number;
  skillsFailed: boolean;
  hasSession: boolean;
  onAccept: (item: SlashItem) => void;
  /** Row hover feeds the skill preview card (index into `items`). */
  onHoverRow: (index: number) => void;
}) {
  const { t } = useI18n();
  const skills = items.filter((item) => item.kind === 'skill');
  const actions = items.filter((item) => item.kind === 'action');
  let rowIndex = -1;
  const renderRow = (item: SlashItem) => {
    rowIndex += 1;
    const index = rowIndex;
    const active = index === activeIndex;
    return (
      <button
        key={`${item.kind}-${item.name}`}
        type="button"
        role="option"
        aria-selected={active}
        aria-disabled={item.disabled === true}
        onClick={() => { onAccept(item); }}
        onMouseEnter={() => { onHoverRow(index); }}
        className={`flex w-full items-baseline gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors ${
          item.disabled === true ? 'opacity-50' : ''
        } ${active ? 'bg-accent-soft' : 'hover:bg-paper'}`}
      >
        <span className="shrink-0 font-mono text-[12px] font-medium text-accent">
          /{item.name}
        </span>
        {item.skill?.argument_hint !== undefined ? (
          <span className="max-w-32 truncate font-mono text-[10px] text-ink-faint">{item.skill.argument_hint}</span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-soft">
          {item.kind === 'action' && item.action !== undefined
            ? t(SLASH_ACTION_DESCRIPTIONS[item.action])
            : item.description}
        </span>
        {item.disabled === true ? (
          <span className="shrink-0 text-[9.5px] text-ink-faint">{t('composer.slash.notActivatable')}</span>
        ) : item.kind === 'skill' ? (
          <span title={item.skill?.path} className="shrink-0 text-[9.5px] text-ink-faint">{item.skill?.source}</span>
        ) : null}
      </button>
    );
  };
  return (
    <>
      {skills.length > 0 ? (
        <>
          <p className="px-2.5 pt-1 pb-0.5 text-[9.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
            {t('composer.slash.skills')}
          </p>
          {skills.map(renderRow)}
        </>
      ) : null}
      {actions.length > 0 ? (
        <>
          <p className="px-2.5 pt-1 pb-0.5 text-[9.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
            {t('composer.slash.shortcuts')}
          </p>
          {actions.map(renderRow)}
        </>
      ) : null}
      {items.length === 0 ? (
        <p className="px-2.5 py-2 text-[11.5px] text-ink-faint">
          {t('composer.slash.empty')}
        </p>
      ) : null}
      {skillsFailed && hasSession ? (
        <p className="border-t border-hairline px-2.5 py-1 font-mono text-[9.5px] text-ink-faint">
          {t('composer.slash.skillsFailed')}
        </p>
      ) : null}
    </>
  );
}

/**
 * SkillPreviewCard — C-2: the full descriptor for the slash row under the
 * pointer (or the keyboard-active row), which the menu itself can only show
 * truncated. Docks to the right of the menu; on viewports too narrow to have
 * genuine room beside the composer it stays hidden rather than clipping.
 * Skills with an empty description never reach here (the caller degrades).
 */
function SkillPreviewCard({ item }: { item: SlashItem }) {
  const { t } = useI18n();
  const skill = item.skill;
  return (
    <div
      data-skill-preview
      role="tooltip"
      aria-label={t('composer.slash.previewAria')}
      className="anim-enter pointer-events-none absolute right-0 bottom-full z-40 mb-1 hidden w-72 translate-x-[calc(100%+0.5rem)] rounded-xl border border-hairline bg-panel p-3 shadow-[0_12px_32px_-12px_rgba(28,25,23,0.35)] min-[1360px]:block"
    >
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 font-mono text-[12px] font-medium text-accent">
          /{item.name}
        </span>
        {skill !== undefined ? (
          <span className="shrink-0 rounded-full border border-hairline px-1.5 py-px text-[9.5px] text-ink-faint">
            {skill.source}
          </span>
        ) : null}
        {item.disabled === true ? (
          <span className="shrink-0 text-[9.5px] text-ink-faint">
            {t('composer.slash.notActivatable')}
          </span>
        ) : null}
      </div>
      <p className="mt-1.5 max-h-36 overflow-y-auto text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-soft">
        {item.description}
      </p>
      {skill !== undefined ? (
        <p title={skill.path} className="mt-2 truncate font-mono text-[9.5px] text-ink-faint">
          {skill.path}
        </p>
      ) : null}
    </div>
  );
}

function MentionMenuBody({
  items,
  activeIndex,
  loading,
  failed,
  query,
  onAccept,
}: {
  items: readonly FsSearchHit[];
  activeIndex: number;
  loading: boolean;
  failed: boolean;
  query: string;
  onAccept: (item: FsSearchHit) => void;
}) {
  const { t } = useI18n();
  if (failed) {
    return (
      <p className="px-2.5 py-2 font-mono text-[10.5px] text-danger">
        {t('composer.filesFailed')}
      </p>
    );
  }
  if (items.length === 0) {
    return (
      <p className="px-2.5 py-2 text-[11.5px] text-ink-faint">
        {loading
          ? t('composer.filesSearching')
          : query === ''
            ? t('composer.filesEmpty')
            : t('composer.filesNoMatch', { query })}
      </p>
    );
  }
  return (
    <>
      <p className="px-2.5 pt-1 pb-0.5 text-[9.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
        {t('composer.filesHeader')}
      </p>
      {items.map((item, index) => {
        const active = index === activeIndex;
        const isDir = item.kind === 'directory';
        return (
          <button
            key={item.path}
            type="button"
            role="option"
            aria-selected={active}
            onClick={() => { onAccept(item); }}
            className={`flex w-full items-baseline gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors ${
              active ? 'bg-accent-soft' : 'hover:bg-paper'
            }`}
          >
            <span className="shrink-0 text-[11px]">{isDir ? '📁' : '📄'}</span>
            <span className="shrink-0 font-mono text-[12px] font-medium text-ink">
              {item.name}
              {isDir ? '/' : ''}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-faint">
              {item.path}
            </span>
          </button>
        );
      })}
    </>
  );
}

/**
 * ModeSelect — the approval policy for the next prompt, behind one trigger:
 * the three permission modes, nothing else. The trigger names the current
 * mode, so the toolbar carries the state without carrying the panel.
 *
 * Keyboard/overlay contract: the trigger carries aria-haspopup/aria-expanded;
 * opening moves focus to the current mode, ↑/↓ cycles the panel rows,
 * Enter/Space picks natively, Escape closes and refocuses the trigger, and a
 * pointerdown anywhere outside dismisses. While open the panel registers as
 * an overlay so the global Escape handler never aborts the turn out from
 * under it. Picking a mode closes the panel.
 */
function ModeSelect({
  open,
  onOpenChange,
  value,
  onChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
}) {
  const { t } = useI18n();
  const setOpen = onOpenChange;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = MODES.find((mode) => mode.id === value) ?? MODES[0]!;

  const close = (refocus = false) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const release = registerOverlay('composer-mode');
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        close();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      release();
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  // Opening moves focus to the current mode's row so arrowing starts there.
  useEffect(() => {
    if (!open) return;
    rootRef.current
      ?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
      ?.focus();
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const rows = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-mode-row]') ?? [])];
      if (rows.length === 0) return;
      const index = rows.findIndex((row) => row === document.activeElement);
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      rows[(index + delta + rows.length) % rows.length]?.focus();
    }
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Escape/arrow handling for the open panel
    <div ref={rootRef} className="relative" data-mode-select onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('composer.modeAria')}
        title={t(current.hintKey)}
        onClick={() => { setOpen(!open); }}
        className={`flex max-w-56 shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
          open
            ? 'border-accent bg-accent-soft text-accent'
            : 'border-accent/70 bg-accent-soft/60 text-accent hover:border-accent'
        }`}
      >
        <span className="min-w-0 truncate">{t(current.labelKey)}</span>
        <svg
          width="9" height="9" viewBox="0 0 12 12" fill="none" aria-hidden
          className={`shrink-0 opacity-70 transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div className="anim-enter absolute bottom-full left-0 z-30 mb-1.5 w-64 max-w-[calc(100vw-48px)] rounded-xl border border-hairline bg-panel p-1.5 shadow-[0_12px_32px_-12px_rgba(28,25,23,0.35)]">
          <p className="px-2.5 pt-0.5 pb-1 text-[9.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
            {t('composer.modePermissionHeading')}
          </p>
          <div role="listbox" aria-label={t('composer.modePermissionHeading')}>
            {MODES.map((mode) => {
              const isCurrent = mode.id === value;
              return (
                <button
                  key={mode.id}
                  type="button"
                  role="option"
                  data-mode-row
                  aria-selected={isCurrent}
                  onClick={() => {
                    onChange(mode.id);
                    close(true);
                  }}
                  className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                    isCurrent ? 'bg-accent-soft' : 'hover:bg-paper'
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className={`block text-[12px] font-medium ${isCurrent ? 'text-accent' : 'text-ink'}`}>
                      {t(mode.labelKey)}
                    </span>
                    <span className="mt-0.5 block text-[10.5px] leading-snug text-ink-faint">
                      {t(mode.hintKey)}
                    </span>
                  </span>
                  {isCurrent ? (
                    <span aria-hidden className="shrink-0 text-[11px] leading-5 text-accent">✓</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * PlanSelect — the run-shape settings for the next prompt, behind their own
 * trigger next to the approval mode: the plan and swarm switches, the plan
 * gate switch (auto = free in/out, off = approval-gated), and the goal
 * objective. The trigger spells the active combination (`plan · swarm`); with
 * nothing active it rests on the plain `plan` label in the neutral style, and
 * a filled objective or a live goal tints it accent.
 *
 * Open state is owned by the parent because `/goal` has to open this panel
 * with the objective field already expanded. Same keyboard/overlay contract
 * as ModeSelect, except that toggling a switch keeps the panel open —
 * switches come in combinations.
 */
function PlanSelect({
  open,
  onOpenChange,
  planMode,
  onChangePlanMode,
  planGate,
  onChangePlanGate,
  swarmMode,
  onChangeSwarmMode,
  goalObjective,
  onChangeGoalObjective,
  goalOpen,
  onGoalOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  planMode: boolean;
  onChangePlanMode: (on: boolean) => void;
  /** Effective gate + session override handler; the gate row hides without them. */
  planGate?: PromptPlanGate;
  onChangePlanGate?: (gate: PromptPlanGate) => void;
  swarmMode: boolean;
  onChangeSwarmMode: (on: boolean) => void;
  goalObjective: string;
  onChangeGoalObjective?: (objective: string) => void;
  goalOpen: boolean;
  onGoalOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const setOpen = onOpenChange;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const segments = [
    ...(planMode ? [t('composer.plan')] : []),
    ...(swarmMode ? [t('composer.swarm')] : []),
  ];
  const label =
    segments.length > 0 ? segments.join(t('composer.modeSegmentSeparator')) : t('composer.plan');
  const active = planMode || swarmMode ||
    (onChangeGoalObjective !== undefined && goalObjective !== '');

  const close = (refocus = false) => {
    setOpen(false);
    if (onChangeGoalObjective !== undefined && goalObjective === '') onGoalOpenChange(false);
    if (refocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const release = registerOverlay('composer-plan');
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        close();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      release();
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  // Opening moves focus to the plan row — unless `/goal` asked for the
  // objective field, which is the point of that shortcut.
  useEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    if (root === null) return;
    const goalField = goalOpen && onChangeGoalObjective !== undefined
      ? root.querySelector<HTMLElement>('[data-goal-objective]')
      : null;
    (goalField ?? root.querySelector<HTMLElement>('[data-mode-row]'))?.focus();
  }, [open, goalOpen]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // The objective field owns its own arrow keys (caret movement).
      if ((event.target as HTMLElement).tagName === 'INPUT') return;
      event.preventDefault();
      const rows = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-mode-row]') ?? [])];
      if (rows.length === 0) return;
      const index = rows.findIndex((row) => row === document.activeElement);
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      rows[(index + delta + rows.length) % rows.length]?.focus();
    }
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Escape/arrow handling for the open panel
    <div ref={rootRef} className="relative" data-plan-select onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('composer.planAria')}
        title={t('composer.planHint')}
        onClick={() => { setOpen(!open); }}
        className={`flex max-w-56 shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
          open || active
            ? 'border-accent bg-accent-soft text-accent'
            : 'border-hairline bg-panel text-ink-soft hover:border-hairline-strong'
        }`}
      >
        <span className="min-w-0 truncate">{label}</span>
        <svg
          width="9" height="9" viewBox="0 0 12 12" fill="none" aria-hidden
          className={`shrink-0 opacity-70 transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div className="anim-enter absolute bottom-full left-0 z-30 mb-1.5 w-64 max-w-[calc(100vw-48px)] rounded-xl border border-hairline bg-panel p-1.5 shadow-[0_12px_32px_-12px_rgba(28,25,23,0.35)]">
          {(
            [
              ['plan', planMode, onChangePlanMode, 'composer.plan', 'composer.planHint'],
              // The gate switch sits between the two mode switches: on = free
              // (plan mode opens/closes without asking), off = gated.
              ...(planGate !== undefined && onChangePlanGate !== undefined
                ? [
                    [
                      'planGate',
                      planGate === 'free',
                      (on: boolean) => { onChangePlanGate(on ? 'free' : 'gated'); },
                      'composer.planAuto',
                      'composer.planAutoHint',
                    ] as const,
                  ]
                : []),
              ['swarm', swarmMode, onChangeSwarmMode, 'composer.swarm', 'composer.swarmHint'],
            ] as const
          ).map(([id, on, onToggle, labelKey, hintKey]) => (
            <button
              key={id}
              type="button"
              data-mode-row
              data-mode-switch={id}
              aria-pressed={on}
              title={t(hintKey)}
              onClick={() => { onToggle(!on); }}
              className="flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors outline-none hover:bg-paper focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <span
                aria-hidden
                className={`mt-px shrink-0 text-[11px] leading-4 ${on ? 'text-accent' : 'text-ink-faint'}`}
              >
                {on ? '☑' : '☐'}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block text-[12px] font-medium ${on ? 'text-accent' : 'text-ink'}`}>
                  {t(labelKey)}
                </span>
                <span className="mt-0.5 block text-[10.5px] leading-snug text-ink-faint">
                  {t(hintKey)}
                </span>
              </span>
            </button>
          ))}
          {onChangeGoalObjective !== undefined ? goalOpen ? (
            <div className="mt-1 border-t border-hairline px-2.5 pt-1 pb-0.5">
              <label
                htmlFor="composer-goal-objective"
                className="text-[9.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase"
              >
                {t('composer.goalObjective')}
              </label>
              <input
                id="composer-goal-objective"
                data-goal-objective
                value={goalObjective}
                onChange={(event) => { onChangeGoalObjective(event.target.value); }}
                placeholder={t('composer.goalObjectivePlaceholder')}
                className="mt-1 w-full rounded-lg border border-hairline bg-paper px-2.5 py-1.5 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
              />
              <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-faint">
                {t('composer.goalNoteBefore')}
                <span className="font-mono">goal_objective</span>
                {t('composer.goalNoteAfter')}
              </p>
            </div>
          ) : (
            <button
              type="button"
              data-mode-row
              data-goal-open
              aria-expanded={false}
              onClick={() => { onGoalOpenChange(true); }}
              className={`mt-1 flex w-full items-center gap-2 rounded-lg border-t border-hairline px-2.5 py-1.5 text-left text-[12px] font-medium transition-colors outline-none hover:bg-paper focus-visible:ring-2 focus-visible:ring-accent/40 ${
                goalObjective === '' ? 'text-ink' : 'text-accent'
              }`}
            >
              <span className="min-w-0 flex-1 truncate">
                {goalObjective === '' ? t('composer.goalOpen') : goalObjective}
              </span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * ModelChip — one trigger for the model and its thinking effort. The trigger
 * reads `{model} · {effort}`, with the effort segment outside the truncation
 * so the two facts never squeeze each other out. The agent profile is a
 * separate toolbar control, not part of this panel.
 *
 * With an empty catalog the trigger degrades to the read-only effective model
 * (nothing to pick) while the panel still carries the effort row; with neither
 * available it is inert text.
 */
function ModelChip({
  modelOptions,
  hasCatalog,
  model,
  resolvedModelKey,
  effectiveModel,
  modelSource,
  disabled = false,
  onChangeModel,
  efforts,
  effort,
  onChangeEffort,
}: {
  readonly modelOptions: readonly SearchableSelectOption[];
  /** False when `GET /models` returned nothing — no model is pickable. */
  readonly hasCatalog: boolean;
  readonly model: string | undefined;
  /** The catalog key `model` resolves to (bare aliases land on a provider row). */
  readonly resolvedModelKey: string | undefined;
  readonly effectiveModel: string | undefined;
  readonly modelSource: ComposerModelSource;
  readonly disabled?: boolean;
  readonly onChangeModel: (model: string | undefined) => void | Promise<void>;
  readonly efforts: readonly string[] | undefined;
  readonly effort: string | undefined;
  readonly onChangeEffort: (effort: string) => void;
}) {
  const { t } = useI18n();
  const showEffort = efforts !== undefined && efforts.length > 0 && effort !== undefined;
  const title = t('composer.modelTitle', { source: t(`composer.modelSource.${modelSource}`) });

  if (!hasCatalog && !showEffort) {
    return (
      <span
        className="max-w-56 truncate rounded-full border border-hairline bg-panel px-2 py-0.5 font-mono text-[11px] text-ink-soft"
        title={title}
      >
        {effectiveModel ?? t('composer.inheritDefault')}
      </span>
    );
  }

  return (
    <SearchableSelect
      id="composer-model-select"
      options={hasCatalog ? modelOptions : []}
      hideFilter={!hasCatalog}
      // With no catalog the raw value renders verbatim — the read-only label.
      value={hasCatalog ? (resolvedModelKey ?? model ?? '') : (effectiveModel ?? '')}
      onChange={(next) => {
        // The pick is a command the caller owns and may reject (a server-side
        // rebind). Observe the returned promise so no rejection floats, and
        // report the failure here: the trigger keeps rendering the live value,
        // so a rejected pick must not read as applied.
        void Promise.resolve(onChangeModel(next === '' ? undefined : next)).catch(
          (error: unknown) => {
            pushToast({
              tone: 'error',
              text: t('subagent.modelChangeFailed', {
                detail: error instanceof Error ? error.message : String(error),
              }),
            });
          },
        );
      }}
      disabled={disabled}
      title={title}
      ariaLabel={t('composer.modelAria')}
      emptyText={t('composer.inheritDefault')}
      searchPlaceholder={t('composer.modelSearchPlaceholder')}
      placement="above"
      panelClassName="anim-enter absolute z-40 bottom-full left-0 mb-1.5 w-96 max-w-[calc(100vw-48px)] rounded-xl border border-hairline bg-panel shadow-[0_12px_32px_-12px_rgba(28,25,23,0.35)]"
      buttonClassName="flex min-w-0 items-center gap-1 rounded-full border border-hairline bg-panel px-2 py-0.5 font-mono text-[11px] text-ink-soft outline-none transition-colors hover:border-hairline-strong focus:border-accent focus:ring-2 focus:ring-accent/30"
      triggerSuffix={
        showEffort ? (
          <span className="shrink-0 text-ink-faint"> · {effort}</span>
        ) : null
      }
      panelFooter={
        showEffort ? (
          <div className="flex items-center gap-2 border-t border-hairline px-3 py-2.5">
            <span className="shrink-0 text-[9.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
              {t('composer.effortHeading')}
            </span>
            <div
              role="radiogroup"
              aria-label={t('composer.effortTitle')}
              className="ml-auto flex items-center gap-0.5 rounded-full border border-hairline bg-paper p-0.5"
            >
              {efforts.map((level) => (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={level === effort}
                  data-effort={level}
                  disabled={disabled}
                  onClick={() => { onChangeEffort(level); }}
                  className={`rounded-full px-2 py-0.5 font-mono text-[10.5px] transition-colors ${
                    level === effort
                      ? 'bg-accent text-white'
                      : 'text-ink-soft hover:bg-hairline/60'
                  }`}
                >
                  {level}
                </button>
              ))}
            </div>
          </div>
        ) : null
      }
    />
  );
}
