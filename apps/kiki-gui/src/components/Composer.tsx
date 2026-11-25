/**
 * Composer — floating rounded-2xl card: chips above a full-width multiline
 * input (send shortcut from settings), a bottom toolbar with one control per
 * concern (＋ menu with attach and the Normal/Plan/Goal mode, permission
 * dropdown, agent profile picker, model+effort selector fed from the server
 * catalog), and a
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

import { useCallback, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition, type DragEvent, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useFsSearchFeed, type FsSearchFeedSearch, type FsSearchFeedView } from '../lib/fsSearchFeed';
import { isPeerConnectionSource } from '../lib/peerAccess';
import { getPickerScaleConfig } from '../lib/subagentScaleConfig';
import { formatThinkingEffortWord } from '../lib/thinkingEffort';
import { useNavigate } from 'react-router-dom';

import type { AgentReferenceCandidate, AgentReferenceCandidatesQuery, DeferredAppendTiming, ExecutorModelCatalogResponse, FsSearchHit, PermissionMode, PromptPlanGate, PromptSkillActivation, SessionUsageError } from '@kiki/protocol';

import {
  buildSlashItems,
  classifySlashSubmission,
  completeSlashTrigger,
  extractSlashSkillTokens,
  hasInlineSlashCandidate,
  orderSlashItemsForDisplay,
  parseSlashDraft,
  parseSlashTrigger,
  removeSkillToken,
  type SlashActionId,
  type SlashItem,
} from '@kiki/session-core/commands';
import {
  ACCEPTED_IMAGE_MIMES,
  prepareThreadRefContext,
  agentRefDeletionRange,
  fileToImageAttachment,
  findAgentRefs,
  findConversationRefs,
  formatBytes,
  hasMention,
  insertDroppedPaths,
  insertThreadRef,
  isNativeExecutor,
  profileExecutor,
  removeAgentRef,
  removeThreadRef,
  replaceMentionTriggerWithAgentRef,
  subscribeComposerInserts,
  threadRefDeletionRange,
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
  composerEnterAction,
  catalogModelSupportsEffort,
  normalizeSelectableModelAlias,
  projectedProfileModelState,
  projectedProfileModelRuleSource,
  resolveCatalogModel,
  resolveSelectedEffort,
  sortThinkingEffortsForDisplay,
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
  agentProfileCatalogRefetchInterval,
  loadAgentProfileCatalog,
  type AgentProfileCatalogMode,
} from '../lib/agentProfileCatalog';
import { API_CODES, ApiError, type NamedAgentProfile } from '../lib/client';
import { isExecutorActionAvailable, mapExecutorCapabilities, resolveExecutorModelThinkingLevels } from '../lib/executorCapabilities';
import {
  agentUnavailableReason,
  filterAgentCandidates,
  groupAgentCandidates,
  type AgentCandidateGroup,
} from '../lib/agentMentionCandidates';
import { pendingModelSwitchChange, type PendingModelSwitch } from '@kiki/session-core/session/modelSwitchQueue';
import {
  anyOverlayOpen,
  COMPOSER_FLOATING_GROUP,
  FLOATING_OWNER_ATTRIBUTE,
  FLOATING_PORTAL_OWNERS_ATTRIBUTE,
  floatingSurfaceZIndex,
  notifyFloatingGroupOpen,
  owningModalId,
  registerOverlay,
  resolveFloatingOwners,
  subscribeFloatingGroup,
} from '../lib/uiBusy';
import { useLayerHistory } from '../lib/layerHistory';
import { MODAL_ESCAPE_ATTRIBUTE } from './Dialog';
import { useSeatFileDrop } from './seatFileDrop';
import { isCoarsePointer, useCoarsePointer } from '../lib/layoutHooks';
import { pastedMediaType } from '../lib/pastedFiles';
import { pushToast } from '../lib/toasts';
import { matchesShortcutAction } from '../lib/shortcuts';
import { useRemoteConnections } from '../lib/remoteConnections';
import { useConnection } from '../state/connection';
import { useProfileFilePreview } from '../lib/profileFilePreview';
import { resolveProfileIcon } from '../lib/profileIcon';
import { ImageTile, QuoteChip, SkillChip, TextTile } from './ContextChips';
import { ComposerFileTile } from './fileContextMenu';
import { ComposerNotes } from './ComposerNotes';
import {
  useSubscribedAnnotations,
  type ConversationAnnotationStore,
} from './agent-workspace/useConversationAnnotations';
import { ContextMeter, type ContextMeterAutoCompact, type ContextMeterCompactAvailability, type ContextMeterUsage } from './ContextMeter';
import { LifeMark } from './LifeMark';
import { ConfirmDialog } from './ConfirmDialog';
import { useComposerContextMenu } from './ComposerContextMenu';
import { ComposerInput, type ComposerReferenceLabel, type ComposerSkillSpan } from './ComposerInput';
import { normalizeComposerText, type ComposerInputHandle } from '../lib/composerInput';
import { Icon, resolvePluginSlotIconName } from './icons';
import { useElapsedSince, useNow } from './RelativeTime';
import { useComposerSsh } from './ssh/ComposerSsh';
import { roomRefFetcher, useRoomRefDirectory } from '../lib/roomRefs';
import { useThreadRefDirectory } from '../lib/threadRefs';
import { ExecutionSelect } from './harness/ExecutionSelect';
import { ProfileSelect } from './harness/ProfileSelect';
import { OutputLayerSelect } from './output-layer';
import { engineLabel, useExecutorCatalog } from './settings/profileEditor/engines';
import type { ExecutionChoice, ExecutionContextGroup } from '@kiki/session-core/composer';
import { buildCatalogModelOptions, modelFactBadges, modelTooltip, useProviderGroupLabel } from './modelSelectOptions';
import { ModelPicker } from './ModelPicker';
import { POPOVER_SURFACE_CLASS, type SearchableSelectOption } from './SearchableSelect';
import { SessionRemainder } from './SessionRemainder';
import type { ContentContinuationHandle } from './transcriptDetail';
import { PersonaAvatar, type PersonaAvatarData } from './persona/PersonaAvatar';
import { Popover } from '@base-ui/react/popover';
import {
  AddMenu,
  type AddMenuExtensionItem,
  type AddMenuView,
  ComposerCardContext,
  ComposerPanelOrigin,
  PermissionSelect,
  POPOVER_LABEL_CLASS,
  RunModeChip,
  SendTimingRows,
  STATUS_SEGMENT_CLASS,
  STATUS_SEGMENT_ICON_CLASS,
  STATUS_SEGMENT_SET,
  usePopover,
  type RunMode,
  type RunModeControls,
  type SendTimingChoice,
} from './ComposerControls';

import { usePluginPicker } from './capabilities/usePluginPicker';
import { useMcpPicker } from './capabilities/useMcpPicker';
import {
  interactiveInputRemainingMs,
  interpolatePluginPromptText,
  resolvePluginLocalizedText,
  selectComposerToolbarSlots,
  subscribePluginPromptInserts,
  type PluginPromptInsertRequest,
} from '@kiki/session-core';
import {
  useExecutePluginSlotAction,
  usePluginGuiSlots,
} from './plugins/PluginComposerSlots';
import { PluginStatusCapsules } from './plugins/PluginStatusCapsules';

function shortRefId(id: string): string {
  const cleaned = id.replace(/^(?:session_|room_|thread_)/u, '');
  return cleaned.length > 14 ? `${cleaned.slice(0, 12)}…` : cleaned;
}

function stripModelProviderPrefix(modelId: string | undefined): string | undefined {
  if (modelId === undefined) return undefined;
  const slash = modelId.lastIndexOf('/');
  return slash >= 0 && slash < modelId.length - 1 ? modelId.slice(slash + 1) : modelId;
}

function fileExtensionTag(name: string, isDir: boolean, dirLabel: string): string {
  if (isDir) return dirLabel;
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return 'FILE';
  return name.slice(dot + 1).toUpperCase().slice(0, 6);
}

export interface PendingRuntimeControls {
  readonly model?: string;
  readonly profile?: string;
  readonly thinking?: string;
}

/** Localized descriptions for the client-side slash shortcuts (skills carry server text). */
/** `/btw` is listed only where a side question can be opened (not in a side agent's own composer). */
function withoutUnhandledActions(
  items: readonly SlashItem[],
  canAskSideQuestion: boolean,
  canOpenBranch: boolean,
): readonly SlashItem[] {
  return items.filter((item) => {
    if (item.action === 'btw') return canAskSideQuestion;
    if (item.action === 'branch') return canOpenBranch;
    return true;
  });
}

const SLASH_ACTION_DESCRIPTIONS: Record<SlashActionId, I18nKey> = {
  plan: 'composer.slash.plan',
  goal: 'composer.slash.goal',
  new: 'composer.slash.new',
  btw: 'composer.slash.btw',
  branch: 'composer.slash.branch',
  fork: 'composer.slash.fork',
  undo: 'composer.slash.undo',
  compact: 'composer.slash.compact',
};

const MENTION_DEBOUNCE_MS = 250;
const CATALOG_RETRY_INTERVAL_MS = 30_000;
/**
 * `/new` has no session id. Its in-flight create stays under this key and is
 * never copied onto the session id the route later adopts.
 */
const DRAFT_SEND_OWNER = '\0composer-draft';

function sendOwnerKey(sessionId: string | undefined): string {
  return sessionId === undefined ? DRAFT_SEND_OWNER : `s:${sessionId}`;
}

type SendFlight = {
  readonly owner: string;
  readonly generation: number;
};

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
 * Whether one profile can answer as this session's main agent. Shared by the
 * execution panel (which nests each engine's own profiles) and the profile
 * list, so both offer exactly the same candidates.
 */
export const isConversationProfile = (item: NamedAgentProfile): boolean =>
  item.main === true && !item.disabled && !isPrivateProfile(item);

/**
 * Profile picker options: only enabled, non-private main profiles
 * (`main: true`) are conversation candidates. Sub-agent-only profiles are
 * never offered here — dispatch them with AgentRun instead. A previously
 * selected profile that has become unavailable remains visible on the
 * trigger with a diagnostic until the user reselects.
 *
 * Profiles are grouped by the engine that runs them, and the group header is
 * that engine's own name. A profile names the harness it drives, so listing
 * them under one undifferentiated heading made a Codex profile look like a
 * Kiki one; grouping by engine puts each one under the engine a reader already
 * recognises from the execution picker. Native profiles keep the product name
 * rather than the wire id, and the rows stay in the caller's order inside each
 * group so the picker's existing sort is preserved.
 */
export function buildAgentProfileOptions(
  items: readonly NamedAgentProfile[],
  t: (key: I18nKey, params?: I18nParams) => string,
  nativeLabel?: string,
): SearchableSelectOption[] {
  const pickable = items.filter(isConversationProfile);
  const toOption = (item: NamedAgentProfile, group: string): SearchableSelectOption => ({
    value: item.name,
    label: item.name === DEFAULT_AGENT_PROFILE ? t('composer.agentDefaultOption') : item.name,
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
  const groupOf = (item: NamedAgentProfile): string => {
    const executor = profileExecutor(item);
    if (isNativeExecutor(executor)) {
      return nativeLabel !== undefined && nativeLabel !== '' ? nativeLabel : t('composer.profileGroupMain');
    }
    // A profile whose engine the catalog does not list still has to be
    // findable, so it is grouped under the raw id rather than dropped or
    // misfiled under Kiki.
    return executor;
  };
  return pickable.map((item) => toOption(item, groupOf(item)));
}

/** What the composer needs to know about an external engine driving main. */
export interface ComposerEngine {
  readonly label: string;
  readonly fork: boolean;
  readonly images: boolean;
  readonly permissionModes?: readonly string[];
  readonly modelThinkingLevels?: Readonly<Record<string, readonly string[]>>;
  readonly advertisesCompact?: boolean;
}

/** `/fork` leaves the slash menu when the engine's handshake refused forking. */
function withoutRefusedActions<T extends { readonly kind: string; readonly action?: string }>(items: T[], engine: ComposerEngine | undefined): T[] {
  return engine?.fork === false
    ? items.filter((item) => item.kind !== 'action' || (item.action !== 'fork' && item.action !== 'btw' && item.action !== 'branch'))
    : items;
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

const EMPTY_DRAFT_SKILLS: {
  readonly occurrences: readonly ReturnType<typeof extractSlashSkillTokens>['occurrences'][number][];
  readonly activations: readonly ReturnType<typeof extractSlashSkillTokens>['activations'][number][];
} = { occurrences: [], activations: [] };
const EMPTY_SKILL_SPANS: readonly ComposerSkillSpan[] = [];
const EMPTY_CONVERSATION_REFS: readonly ReturnType<typeof findConversationRefs>[number][] = [];
const EMPTY_AGENT_REFS: readonly ReturnType<typeof findAgentRefs>[number][] = [];
const EMPTY_OVERLAY_TOKENS: readonly ComposerReferenceLabel[] = [];
const EMPTY_STRING_IDS: readonly string[] = [];

function hasSpecialDraftSyntax(draft: string): boolean {
  return draft.includes('/') || draft.includes('@') || draft.includes('[[');
}

export function Composer({
  busy,
  disabled,
  variant = 'main',
  replyingTo,
  sendDisabled = false,
  sendDisabledTitle,
  disabledPlaceholder,
  value,
  onChange,
  model,
  defaultModel,
  serverDefaultModel,
  modelSource,
  pendingModelSwitch,
  bindingSetting,
  pendingRuntimeControls,
  onCancelRuntimeControls,
  modelSwitchError,
  agentProfile,
  agentProfilePending = false,
  execution,
  boundExecution,
  onChangeExecution,
  executionPending = false,
  onCancelExecution,
  permissionMode,
  planMode,
  planGate,
  goalObjective = '',
  goalMode = false,
  efforts,
  effort,
  contextUsage,
  contextAutoCompact,
  sessionUsage,
  sessionUsageError,
  busyPlaceholder,
  sessionId,
  agentId = 'main',
  delegationPosition,
  workspaceId,
  agentProfileCatalogMode,
  fsSearch,
  mentionScopeKey,
  attachments,
  quote,
  onRemoveQuote,
  quotes,
  onRemoveQuoteItem,
  annotations: annotationsProp,
  annotationStore,
  onRemoveAnnotation,
  onChangeAttachments,
  onActivateSkill,
  onSessionAction,
  onSideQuestion,
  onOpenBranch,
  onCompactContext,
  onChangeModel,
  personaPick,
  onRebuildContext,
  onChangePermissionMode,
  onChangePlanMode,
  onChangePlanGate,
  onChangeGoalObjective,
  onChangeGoalMode,
  onChangeEffort,
  onSend,
  onSendNow,
  busySendsNow = false,
  working,
  sessionRemainder,
  onAbort,
  abortPending = false,
  queueEditing = false,
  messageEditing = false,
  attachmentScopeKey,
  onQueueEditConfirm,
  onQueueEditCancel,
  header,
  onOpenImage,
  onQueueEditRemove,
  autoFocus,
  onUpdateAnnotation,
  onLocateAnnotation,
  needsYou,
  statusNotice,
  engine,
  sendTimingDefault,
}: {
  busy: boolean;
  /**
   * Locks the textarea — busy/loading phases only (turn in flight, session
   * still loading, /new creation). Send-only gating belongs to sendDisabled.
   */
  disabled: boolean;
  /** Main composer controls, or the subagent endpoint controls only. */
  variant?: 'main' | 'subagent';
  /** Subagent composer: the agent this message goes to ("Replying to …"). */
  replyingTo?: string;
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
   * A queued model switch: shown beside the model control so the pending
   * target is visible without pretending the actual model already changed.
   */
  pendingModelSwitch?: PendingModelSwitch;
  bindingSetting?: {
    readonly model: string;
    readonly thinking?: string | null;
    readonly state: 'applying' | 'next_step' | 'next_message' | 'failed';
    readonly error?: string;
    readonly onRetry?: () => void;
  };
  /** Controls captured for the next real prompt, not a separate queue item. */
  pendingRuntimeControls?: PendingRuntimeControls;
  /** Clears the pending prompt controls without touching the live binding. */
  onCancelRuntimeControls?: () => void;
  /**
   * A failed read of the queued switch list. Known operations are kept, so this
   * is reported quietly with a retry instead of pretending the queue is empty.
   */
  modelSwitchError?: { readonly detail: string; readonly onRetry: () => void };
  /**
   * Main-agent profile shown in the picker (pending choice included). Omit
   * together with `onChangeAgentProfile` to hide the control entirely.
   */
  agentProfile?: string;
  /** A confirmed switch is waiting for the next prompt — accent tint. */
  agentProfilePending?: boolean;
  /**
   * Which engine runs this session, and which of that engine's profiles when
   * one is selected. Provided together with `onChangeExecution`; the pair
   * replaces the profile-only chip, because the engine and its profile are one
   * choice. The pick shown is the pending one when a switch is waiting.
   */
  execution?: ExecutionChoice;
  /** What this session was bound to before any pending choice. */
  boundExecution?: ExecutionChoice;
  onChangeExecution?: (next: ExecutionChoice) => void;
  /** A confirmed engine switch applies from the next message — accent tint. */
  executionPending?: boolean;
  /**
   * Drops a switch that is still waiting for the next message. Supplied only
   * while one is pending, which is the only time the chip offers it.
   */
  onCancelExecution?: () => void;
  /**
   * What the bound execution grants the engine (Kiki tool groups, delegation),
   * read from the server's resolved binding. Stated as facts under the panel,
   * never written back as an override.
   */
  executionGrants?: {
    readonly kikiContext: readonly ExecutionContextGroup[] | undefined;
    readonly allowKikiSubagents: boolean | undefined;
  };
  permissionMode: PermissionMode;
  /** PromptSubmission.plan_mode — the wire field name (verified). */
  planMode: boolean;
  /**
   * Effective plan gate for the next prompt (`plan_gate`). Provided together
   * with `onChangePlanGate` only where a session-level override exists (/s);
   * the Mode menu's gate row hides when the pair is absent (/new).
   */
  planGate?: PromptPlanGate;
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
  contextUsage?: { readonly used?: number; readonly limit: number };
  /** Automatic-compaction point wiring for the meter's detail card. */
  contextAutoCompact?: ContextMeterAutoCompact;
  /**
   * Lifetime cumulative usage for the context meter's detail card (hidden when
   * absent). Main sessions pass the session record's `SessionUsage`; the
   * subagent variant passes that agent's projected totals (no cost pricing).
   */
  sessionUsage?: ContextMeterUsage;
  /** Why the session's cumulative usage is missing or short (wire `usage_error`). */
  sessionUsageError?: SessionUsageError;
  /** Placeholder while busy (queue steering on /s, creation progress on /new). */
  busyPlaceholder?: string;
  /** Session scope for the skills catalog + session-scoped shortcuts. */
  sessionId?: string;
  /** Agent whose frozen model domain applies; defaults to the main agent. */
  agentId?: string;
  /** Effective delegation position (`main` for main & branches, `sub` for subagents). */
  delegationPosition?: 'main' | 'sub';
  /** Registered workspace id for the /new draft's skill catalog. */
  workspaceId?: string;
  /** Named agent profile catalog visibility and workspace scope. */
  agentProfileCatalogMode: AgentProfileCatalogMode;
  /**
   * File-picker feed for `@` mentions (session `fs:search` on /s, workspace
   * `fs:search` on /new). Omit to disable the picker.
   */
  fsSearch?: FsSearchFeedSearch;
  /** Cache scope for picker results (workspace id on /new); defaults to sessionId. */
  mentionScopeKey?: string;
  /** Controlled attachment chips (parent owns them beside the draft). */
  attachments: readonly ComposerAttachment[];
  /** Selected transcript text quoted into this prompt; rendered as a chip. */
  quote?: string | null;
  onRemoveQuote?: () => void;
  quotes?: readonly import('@kiki/session-core/composer').SelectionQuote[];
  onRemoveQuoteItem?: (id: string) => void;
  /** Selection annotations (quote + comment) accumulating beside the quote. */
  annotations?: readonly SelectionAnnotation[];
  /** Scoped draft annotation store — avoids re-rendering host workspace views on note edits. */
  annotationStore?: ConversationAnnotationStore;
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
  onActivateSkill?: (name: string, args: string, attachments: readonly ComposerAttachment[], userInput: string) => void | Promise<unknown>;
  /** Session-scoped shortcuts (/fork, /undo, /compact). */
  onSessionAction?: (action: 'fork' | 'undo' | 'compact') => void;
  /** `/btw [question]`: open a side question beside the session; the text, when given, is sent to it. */
  onSideQuestion?: (question?: string) => void;
  /** `/branch [task]`: open an in-session branch with an optional task. */
  onOpenBranch?: (task?: string) => void;
  /** The context meter's click target (asks the session to compact). */
  onCompactContext?: () => void;
  /** Model picked in the panel; a bound agent rebinds on the server, so the
   * callback may be async and may fail (the panel reports that failure). */
  onChangeModel: (model: string | undefined) => void | Promise<void>;
  /** Profile picked in the select; the parent owns the confirm/pending flow. */
  onChangeAgentProfile?: (name: string) => void;
  /**
   * /new only: the agent chip also offers personas. A picked persona replaces
   * the chip's label with its face and name on a paper chip; picking a profile
   * (or "no persona") clears it. Omit to keep the chip profile-only.
   */
  personaPick?: {
    readonly value: PersonaAvatarData | undefined;
    readonly onChange: (id: string | undefined) => void;
  };
  onRebuildContext?: () => Promise<{ readonly changed: boolean }>;
  onChangePermissionMode: (mode: PermissionMode) => void;
  onChangePlanMode: (on: boolean) => void;
  /** Session plan-gate pick; required for the Mode menu's gate row to show. */
  onChangePlanGate?: (gate: PromptPlanGate) => void;
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
   * mode), creating the session goal with the message. `options.appendTiming`
   * is the send-timing menu's one-shot pick: it overrides the session's
   * configured queue timing for this prompt only. `options.presentation`
   * annotates spans in the raw text sent with this prompt.
   */
  onSend: (
    text: string,
    attachments: readonly ComposerAttachment[],
    options?: {
      readonly goalObjective?: string;
      readonly appendTiming?: DeferredAppendTiming;
      readonly presentation?: import('@kiki/transcript').TextPresentation;
      readonly skills?: readonly PromptSkillActivation[];
    },
  ) => void | Promise<unknown>;
  /**
   * Send into the running turn instead of queueing behind it (⌘/Ctrl+Enter
   * under the default Enter semantics). Omit where there is no running turn
   * to join; the key then falls back to a normal send. `presentation` carries
   * spans in the raw text sent with this prompt.
   */
  onSendNow?: (
    text: string,
    attachments: readonly ComposerAttachment[],
    presentation?: import('@kiki/transcript').TextPresentation,
    skills?: readonly PromptSkillActivation[],
  ) => void | Promise<unknown>;
  /**
   * The session's configured default queue timing. When set and not editing an
   * existing message or queue entry, the send button renders a split caret
   * menu for one-shot timing picks (immediate/default, send now when busy, or
   * deferred after subagents/tasks) without changing the session default.
   * Omit to drop the menu.
   */
  sendTimingDefault?: DeferredAppendTiming;
  /**
   * While busy, the plain send joins the running turn too (a conversation
   * with no queue surface of its own): the button reads as "send into this
   * turn" rather than "queue", and the separate send-now hint is dropped.
   */
  busySendsNow?: boolean;
  /**
   * The agent is working on this conversation: the row under the card shows
   * a quiet working line with the age of its latest output. Omit when idle
   * or while the session waits on the user (the tray says that instead).
   * `queued` holds details if a model request is waiting on governance admission.
   */
  working?: {
    readonly lastResponseAt: number | undefined;
    readonly queued?: {
      readonly waitedMs: number;
      readonly modelId?: string;
      readonly blockingRules?: readonly string[];
    };
  };
  /**
   * Session structures this window did not carry — the snapshot fields the
   * header shows and the agent roster. Rendered as one quiet entry at the right
   * end of the footer row, on the same line as the working sentence, so a reader
   * at the input can see what is missing without scrolling back through the
   * transcript. Omitted when nothing is missing.
   *
   * Read from the same controller state as the reading column's own outlet, so
   * both offer the same refs and the same recovery.
   */
  sessionRemainder?: ContentContinuationHandle | undefined;
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
  /** Inline history edit: submit verbatim content to the existing edit-resend action. */
  messageEditing?: boolean;
  /** Draft/edit identity for delayed clipboard and native picker results. */
  attachmentScopeKey?: string;
  onQueueEditConfirm?: (text: string, attachments: readonly ComposerAttachment[], presentation?: import('@kiki/transcript').TextPresentation) => void | Promise<unknown>;
  onQueueEditCancel?: () => void;
  onQueueEditRemove?: () => void;
  /**
   * The goal + queue stack (see ComposerHeader): sheets tucked behind the
   * card's top edge, rendered right above the card.
   */
  header?: ReactNode;
  /** Open an attached image in the lightbox (tray thumbnails are buttons when set). */
  onOpenImage?: (src: string, name: string) => void;
  /** Marks the textarea as the dialog's initial-focus target (`data-autofocus`). */
  autoFocus?: boolean;
  /** Edit an unsent note's comment from the notes pill's panel. */
  onUpdateAnnotation?: (id: string, comment: string) => void;
  /** Scroll the timeline to the passage an unsent note quotes. */
  onLocateAnnotation?: (annotation: SelectionAnnotation) => void;
  /**
   * What is waiting on the user (approvals, questions). With an empty,
   * unfocused draft the card body becomes `render(footer)` — the decision
   * itself; with a draft in progress a bar above the card offers it instead,
   * and the card takes over only when the bar is clicked. Leaving the
   * takeover restores the draft and its caret.
   */
  needsYou?: {
    readonly count: number;
    readonly render: (footer: ReactNode) => ReactNode;
    /** Bumped by an explicit Review elsewhere: take the card over now. */
    readonly takeOverSeq?: number;
  };
  /**
   * One quiet connection fact for the line under the card (reconnecting,
   * disconnected). The line keeps the working state beside it.
   */
  statusNotice?: ReactNode;
  /**
   * The external engine the main agent runs on. Its model ids are the
   * engine's own, not Kiki catalog entries, so they are shown as set and never
   * flagged unavailable; entries the handshake refused (fork, images) leave
   * the composer.
   */
  engine?: ComposerEngine;
}) {
  const annotations = useSubscribedAnnotations(annotationStore, annotationsProp);
  const quoteItems = quotes ?? (quote === undefined || quote === null ? [] : [{ id: 'legacy-quote', quote }]);
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
  const { client, connectionId, connectionSource, scopeId, localClient, meta } = useConnection();
  // In a remote space the message is delivered on another machine's home, so
  // the line above the card names that home. Nothing to say in a local space.
  const remoteControlClient = localClient ?? (isPeerConnectionSource(connectionSource) || connectionSource === 'ssh' ? null : client);
  // Only a remote space reads the list, so a local one keeps no 8-second
  // observer on it.
  const remoteRecords = useRemoteConnections(connectionId === null ? null : remoteControlClient);
  const remoteTarget = connectionId === null
    ? null
    : remoteRecords.data?.find((record) => record.id === connectionId) ?? null;
  const remoteTargetLabel = remoteTarget?.label.trim() ?? '';
  const { t, tp, locale } = useI18n();
  const navigate = useNavigate();
  const sendShortcut = useSyncExternalStore(
    subscribeSettings,
    settingsSnapshot,
    settingsServerSnapshot,
  ).sendShortcut;
  // Phone contract: the IME's Enter is the newline key (sending belongs to
  // the button), and the input text stays ≥16px so iOS never zooms on focus.
  const coarsePointer = useCoarsePointer();
  // Mirror the controlled `value` locally and coalesce plain prose typing
  // updates behind a short trailing timer + `startDraftTransition` so
  // CodeMirror paints each keystroke immediately without blocking rAF on a
  // full Composer + SessionView re-render. Slash/mention/link triggers, IME
  // composition, and external resets still update synchronously; `liveTextRef`
  // always holds the latest keystroke and is passed to `ComposerInput` so a
  // deferred local commit can never clobber newer characters.
  const normalizedPropValue = normalizeComposerText(value);
  const [, startDraftTransition] = useTransition();
  const [localText, setLocalText] = useState(normalizedPropValue);
  const liveTextRef = useRef(normalizedPropValue);
  const pendingEmitsRef = useRef<string[]>([]);
  const prevPropValueRef = useRef(normalizedPropValue);
  const draftSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelDraftSyncTimer = useCallback(() => {
    if (draftSyncTimerRef.current !== null) {
      clearTimeout(draftSyncTimerRef.current);
      draftSyncTimerRef.current = null;
    }
  }, []);
  if (prevPropValueRef.current !== normalizedPropValue) {
    prevPropValueRef.current = normalizedPropValue;
    const echoIndex = pendingEmitsRef.current.indexOf(normalizedPropValue);
    if (echoIndex >= 0) {
      pendingEmitsRef.current.splice(0, echoIndex + 1);
    } else {
      cancelDraftSyncTimer();
      pendingEmitsRef.current.length = 0;
      liveTextRef.current = normalizedPropValue;
      if (localText !== normalizedPropValue) setLocalText(normalizedPropValue);
    }
  }
  const text = localText;
  const emitChange = useCallback((next: string) => {
    pendingEmitsRef.current.push(next);
    if (pendingEmitsRef.current.length > 64) {
      pendingEmitsRef.current.splice(0, pendingEmitsRef.current.length - 64);
    }
    onChange(next);
  }, [onChange]);
  const flushDraftSync = useCallback(() => {
    cancelDraftSyncTimer();
    const latest = liveTextRef.current;
    startDraftTransition(() => {
      setLocalText(latest);
      emitChange(latest);
    });
  }, [cancelDraftSyncTimer, emitChange, startDraftTransition]);
  useEffect(() => () => {
    cancelDraftSyncTimer();
  }, [cancelDraftSyncTimer]);
  const commitText = useCallback((nextText: string, urgent = false) => {
    const normalized = normalizeComposerText(nextText);
    const prevLive = liveTextRef.current;
    liveTextRef.current = normalized;
    if (composingRef.current) {
      cancelDraftSyncTimer();
      pendingEmitsRef.current.length = 0;
      setLocalText(normalized);
      onChange(normalized);
      return;
    }
    const syntaxEdge = hasSpecialDraftSyntax(prevLive) || hasSpecialDraftSyntax(normalized);
    if (urgent || syntaxEdge) {
      cancelDraftSyncTimer();
      setLocalText(normalized);
      startDraftTransition(() => {
        emitChange(liveTextRef.current);
      });
      return;
    }
    // Plain-prose typing / clearing during active keyboard input: coalesce
    // React state + parent sync behind a 120ms trailing timer so CodeMirror
    // paints every keystroke with zero intermediate Composer/SessionView renders.
    const deltaLen = Math.abs(normalized.length - prevLive.length);
    const isInteractiveBurstEdit =
      (interactiveInputRemainingMs() > 0 && (deltaLen === 1 || normalized === '')) ||
      (deltaLen === 1 && prevLive.trim() !== '' && normalized.trim() !== '');
    if (isInteractiveBurstEdit) {
      cancelDraftSyncTimer();
      draftSyncTimerRef.current = setTimeout(flushDraftSync, 120);
      return;
    }
    cancelDraftSyncTimer();
    startDraftTransition(() => {
      const latest = liveTextRef.current;
      setLocalText(latest);
      emitChange(latest);
    });
  }, [cancelDraftSyncTimer, emitChange, flushDraftSync, onChange, startDraftTransition]);
  const textareaRef = useRef<ComposerInputHandle>(null);
  const composingRef = useRef(false);
  // Custom right-click menu for the input (cut / copy / paste / select all).
  // Keyboard and menu paste share the native file-copy / browser media policy.
  type ClipboardContent = { text: string; files: File[] };
  const pasteContentRef = useRef<(read: () => Promise<ClipboardContent>) => Promise<void>>(async () => {});
  const attachmentOwner = `${sessionId ?? ''}:${connectionId ?? ''}:${scopeId}:${attachmentScopeKey ?? ''}:${queueEditing}:${messageEditing}`;
  const attachmentOwnerRef = useRef({ key: attachmentOwner });
  if (attachmentOwnerRef.current.key !== attachmentOwner) attachmentOwnerRef.current = { key: attachmentOwner };
  const owner = attachmentOwnerRef.current;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const ownsAttachmentResult = () => mountedRef.current && attachmentOwnerRef.current === owner;
  // The inline message editor opens ready to type: it takes the caret itself,
  // once its field can hold one (an attachment load disables it first). Gated
  // on props it already takes, so the main composer never steals focus and no
  // draft is touched (focus alone changes neither).
  useEffect(() => {
    if (!messageEditing || !autoFocus || disabled) return;
    textareaRef.current?.focus();
  }, [messageEditing, autoFocus, disabled]);
  const pasteDraftRef = useRef({ sessionId, connectionId, scopeId });
  pasteDraftRef.current = { sessionId, connectionId, scopeId };
  const ownsReservedAttachmentResult = () => mountedRef.current &&
    (queueEditing || messageEditing ? ownsAttachmentResult() :
      pasteDraftRef.current.sessionId === sessionId && pasteDraftRef.current.connectionId === connectionId && pasteDraftRef.current.scopeId === scopeId);
  const { onContextMenu: onComposerContextMenu, menu: composerContextMenu } =
    useComposerContextMenu({ textareaRef, onChange, onPasteContent: (read) => pasteContentRef.current(read) });
  // Event handlers can run several times before a controlled prop rerender.
  // Keep a synchronous attachment baseline alongside the rendered value so
  // same-tick paste/drop batches reserve against one another.
  const attachmentBaselineRef = useRef(attachments);
  attachmentBaselineRef.current = attachments;
  const attachmentKeyMapRef = useRef(new WeakMap<ComposerAttachment, number>());
  const nextAttachmentKeyRef = useRef(1);
  const attachmentKeyOf = (attachment: ComposerAttachment): string => {
    const map = attachmentKeyMapRef.current;
    let id = map.get(attachment);
    if (id === undefined) {
      id = nextAttachmentKeyRef.current;
      nextAttachmentKeyRef.current += 1;
      map.set(attachment, id);
    }
    return `${attachment.kind}-${id}`;
  };
  const updateAttachments = (
    next:
      | readonly ComposerAttachment[]
      | ((previous: readonly ComposerAttachment[]) => readonly ComposerAttachment[]),
  ) => {
    if (typeof next === 'function') {
      onChangeAttachments((current) => {
        const updated = next(current);
        if (ownsAttachmentResult()) attachmentBaselineRef.current = updated;
        return updated;
      });
      return;
    }
    attachmentBaselineRef.current = next;
    onChangeAttachments(next);
  };
  // The permission chip owns the approval mode; the ＋ menu owns attach,
  // the run-shape (Mode) view and rebuild. `/plan` and `/goal` open ＋ straight
  // into its Mode view. The /new draft has no parent goal flag, so it arms
  // goal locally (`localGoalArmed`).
  const [modeOpen, setModeOpen] = useState(false);
  const [addView, setAddView] = useState<AddMenuView>('closed');
  // The invalid-model diagnostic opens the model chip's own menu through this
  // counter (the chip keeps owning the menu and its catalog).
  const [modelMenuSignal, setModelMenuSignal] = useState(0);
  // SSH hosts joined to this session (native_ssh flag); main composer only.
  const ssh = useComposerSsh(sessionId, variant !== 'subagent' && !vscodeRuntime);
  const [localGoalArmed, setLocalGoalArmed] = useState(false);
  // Run shape: Normal / Plan / Goal are one exclusive choice. A live session
  // owns goal mode (onChangeGoalMode); the /new draft arms it locally and
  // folds it into the send as the objective.
  const goalArmed = onChangeGoalMode !== undefined
    ? goalMode
    : localGoalArmed || goalObjective !== '';
  const runMode: RunMode = goalArmed ? 'goal' : planMode ? 'plan' : 'normal';
  const setGoalArmed = (on: boolean) => {
    if (onChangeGoalMode !== undefined) {
      onChangeGoalMode(on);
      return;
    }
    setLocalGoalArmed(on);
    if (!on && goalObjective !== '') onChangeGoalObjective?.('');
  };
  const changeRunMode = (next: RunMode) => {
    if (next !== 'plan' && planMode) onChangePlanMode(false);
    if (next === 'plan' && !planMode) onChangePlanMode(true);
    if ((next === 'goal') !== goalArmed) setGoalArmed(next === 'goal');
  };
  const [menu, setMenu] = useState<ComposerMenu | null>(null);
  const dismissedTriggerRef = useRef<{ kind: 'slash' | 'mention'; start: number; query: string } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const turnInFlightRef = useRef(false);
  // In-flight submits stay with the session (or the /new draft) that started
  // them. The visible latch is that owner's entry. A settle removes only its
  // own generation, so it cannot release another session or a newer submit.
  const sendFlightsRef = useRef(new Map<string, number>());
  const sendGenerationRef = useRef(0);
  // A slash-catalog wait has not been delivered yet. Leaving the session drops
  // that owner's token so the refetch cannot submit later or clear the next
  // session's own wait.
  const slashFlightsRef = useRef(new Map<string, number>());
  const slashGenerationRef = useRef(0);
  const composerAliveRef = useRef(true);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const sendNowRef = useRef(false);
  // One-shot queue-timing pick from the send-timing menu, consumed by the next
  // sendPrompt call (same latch shape as sendNowRef).
  const sendTimingRef = useRef<DeferredAppendTiming | undefined>(undefined);
  const [turnInFlight, setTurnInFlight] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [contextRebuildConfirm, setContextRebuildConfirm] = useState(false);
  const [contextRebuildBusy, setContextRebuildBusy] = useState(false);
  const rebuildOwner = useMemo(() => ({}), [scopeId, meta?.server_id, meta?.started_at, sessionId]);
  const rebuildOwnerRef = useRef<object | undefined>(rebuildOwner);
  rebuildOwnerRef.current = rebuildOwner;
  useEffect(() => {
    rebuildOwnerRef.current = rebuildOwner;
    setContextRebuildConfirm(false);
    setContextRebuildBusy(false);
    return () => { rebuildOwnerRef.current = undefined; };
  }, [rebuildOwner]);
  // A slash-looking draft that resolved to nothing: send is held until the
  // user confirms plain-text shipping (typo guard) or edits the draft.
  const [slashConfirm, setSlashConfirm] = useState<{
    name: string;
    reason: 'unknown' | 'disabled';
  } | null>(null);
  const [slashCatalogPending, setSlashCatalogPending] = useState(false);
  const slashCatalogPendingRef = useRef(false);
  const skillCwd = agentProfileCatalogMode.mode === 'cwd' ? agentProfileCatalogMode.cwd : undefined;
  const skillCatalogReady = sessionId !== undefined || workspaceId !== undefined || agentProfileCatalogMode.mode !== 'disabled';
  const skillScope = JSON.stringify(sessionId !== undefined
    ? [scopeId, 'session', sessionId]
    : workspaceId !== undefined
      ? [scopeId, 'workspace', workspaceId]
      : [scopeId, 'draft', skillCwd]);
  const currentSlashDraftRef = useRef({ skillScope });
  currentSlashDraftRef.current = { skillScope };
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
  const recalledCaretUntouchedRef = useRef(false);
  const recalledCaretPosRef = useRef<number | null>(null);

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

  const frozenMenuQuery = useQuery({
    queryKey: ['agentCapabilities', { session_id: sessionId, agent_id: agentId }],
    queryFn: () => client.getAgentCapabilities({ session_id: sessionId!, agent_id: agentId }),
    enabled: sessionId !== undefined,
    staleTime: 30_000,
    retry: retryCatalog,
    retryDelay: catalogRetryDelay,
  });
  const frozenProfile = frozenMenuQuery.data?.profile;
  const normalizedModel = normalizeSelectableModelAlias(model);
  const normalizedDefaultModel =
    normalizeSelectableModelAlias(defaultModel) ?? normalizeSelectableModelAlias(frozenProfile?.model);
  const normalizedServerDefaultModel = normalizeSelectableModelAlias(serverDefaultModel);

  // Model picker options: the inherit entry first, then the catalog grouped
  // by provider display label (buildCatalogModelOptions). The inherit row
  // resolves its target against the catalog so an ambiguous bare alias still
  // shows who will serve it; its provider rides the second line.
  const providerGroupLabel = useProviderGroupLabel();
  const catalogModelOptions: readonly SearchableSelectOption[] = useMemo(
    () => {
      const inheritTargetId = normalizedDefaultModel ?? normalizedServerDefaultModel;
      const inheritResolved =
        inheritTargetId !== undefined ? resolveCatalogModel(models, inheritTargetId) : undefined;
      const inheritDisplay = inheritResolved?.display_name ?? inheritTargetId ?? t('composer.unknown');
      const inheritHint = [
        inheritResolved !== undefined ? providerGroupLabel(inheritResolved.provider_id) : undefined,
        inheritTargetId !== undefined && inheritTargetId !== inheritDisplay ? inheritTargetId : undefined,
      ].filter((part) => part !== undefined).join(' · ');
      return [
        {
          value: '',
          label:
            normalizedDefaultModel !== undefined
              ? t('composer.inheritSession', { model: inheritDisplay })
              : t(
                  modelSource === 'local-default'
                    ? 'composer.inheritLocal'
                    : 'composer.inheritServer',
                  { model: inheritDisplay },
                ),
          hint: inheritHint !== '' ? inheritHint : undefined,
          disabled: inheritResolved?.enabled === false,
          badges: inheritResolved !== undefined ? modelFactBadges(inheritResolved, t) : undefined,
          title: inheritResolved !== undefined ? modelTooltip(inheritResolved) : inheritTargetId,
        },
        ...buildCatalogModelOptions(models, t, { groupLabel: providerGroupLabel, currentId: normalizedDefaultModel }),
      ];
    },
    [models, normalizedDefaultModel, normalizedServerDefaultModel, modelSource, providerGroupLabel, t],
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
    refetchInterval: (query) => catalogRefetchInterval(query) || agentProfileCatalogRefetchInterval(query),
  });
  // The engine catalog behind the execution panel. Empty while loading or on a
  // server without the route; the native engine is always offered regardless.
  const executorCatalog = useExecutorCatalog();

  const fromFile = execution?.profile_file !== undefined;
  const validateFile = fromFile && (sessionId === undefined || executionPending);
  const filePreviewQuery = useProfileFilePreview(validateFile ? execution?.profile_file : undefined, agentProfileCatalogMode);
  const selectedProfileName = fromFile
    ? filePreviewQuery.data?.profile.name ?? frozenProfile?.name ?? execution!.profile_file!
    : agentProfile ?? frozenProfile?.name ?? DEFAULT_AGENT_PROFILE;
  const catalogProfile = agentProfilesQuery.data?.items.find((item) => item.name === selectedProfileName);
  const effectiveDelegationPosition = delegationPosition ?? (agentId === 'main' ? 'main' : 'sub');
  // A pending file is its own declaration, even if a catalog profile has the same name.
  // A bound file keeps its frozen domain until the next message rebinds it.
  const modelProjection = fromFile
    ? validateFile ? filePreviewQuery.data?.profile : frozenProfile
    : sessionId === undefined ? catalogProfile
      : frozenProfile?.name === selectedProfileName ? frozenProfile
        : frozenProfile !== undefined ? catalogProfile : effectiveDelegationPosition === 'main' ? undefined : { restrict_models_to_menu: true };
  const modelSelectionPosition = effectiveDelegationPosition;
  const selectionDefaultModel = validateFile
    ? normalizeSelectableModelAlias(filePreviewQuery.data?.profile.pinned_model_alias) ?? normalizedServerDefaultModel
    : normalizedDefaultModel;
  const modelOptions: readonly SearchableSelectOption[] = useMemo(() => {
    const projection: Parameters<typeof projectedProfileModelState>[0] = modelProjection;
    const mainConstrained = projection?.model_constraints_active ?? (
      projection?.restrict_models_to_menu === true
      || projection?.allowed_models !== undefined
      || (projection?.deny_models?.length ?? 0) > 0
    );
    const projectionActive = modelSelectionPosition === 'main'
      ? (mainConstrained && projection?.effective_model_aliases !== undefined)
      : (projection?.effective_model_aliases !== undefined || projection?.restrict_models_to_menu === true);

    // Fast path: when no profile model constraint applies and no explicit file
    // preview rewrites row 0, return `catalogModelOptions` directly in O(1)
    // instead of rescanning 10,000 models.
    if (!projectionActive && !validateFile) {
      return catalogModelOptions;
    }

    const effectiveAliases = projection?.effective_model_aliases;
    const modelById = new Map<string, (typeof models)[number]>();
    const modelByRemote = new Map<string, (typeof models)[number]>();
    for (let i = 0; i < models.length; i += 1) {
      const m = models[i]!;
      if (!modelById.has(m.id)) modelById.set(m.id, m);
      if (!modelByRemote.has(m.remote_id)) modelByRemote.set(m.remote_id, m);
    }
    const resolveFast = (alias: string | undefined): string | undefined => {
      const normalized = normalizeSelectableModelAlias(alias);
      if (normalized === undefined) return undefined;
      return modelById.get(normalized)?.id ?? modelByRemote.get(normalized)?.id ?? normalized;
    };
    const effectiveIdentitySet = effectiveAliases === undefined
      ? undefined
      : new Set(effectiveAliases.map((alias: string) => resolveFast(alias) ?? alias));
    const declaredMenuIdentities = projection?.restrict_models_to_menu === true
      && projection.declared_model_menu !== undefined
      ? new Set(projection.declared_model_menu.identities)
      : undefined;

    return catalogModelOptions.map((option) => {
      const target = option.value === '' ? selectionDefaultModel ?? normalizedServerDefaultModel : option.value;
      const inheritedFileModel = validateFile && option.value === '' && target !== undefined
        ? resolveCatalogModel(models, target)
        : undefined;
      const row = validateFile && option.value === '' ? { ...option,
        label: t('composer.inheritSession', { model: inheritedFileModel?.display_name ?? target ?? t('composer.unknown') }),
        hint: inheritedFileModel === undefined ? target : providerGroupLabel(inheritedFileModel.provider_id), title: target,
      } : option;
      if (!projectionActive) return row;

      const normalizedTarget = normalizeSelectableModelAlias(target);
      let state: 'allowed' | 'warning' | 'blocked' | 'unknown';
      if (effectiveIdentitySet === undefined) {
        state = projection?.restrict_models_to_menu === true ? 'unknown' : 'allowed';
      } else if (normalizedTarget === undefined) {
        state = modelSelectionPosition === 'main' ? 'allowed' : 'blocked';
      } else {
        const identity = resolveFast(normalizedTarget) ?? normalizedTarget;
        state = effectiveIdentitySet.has(identity)
          ? 'allowed'
          : modelSelectionPosition === 'main' ? 'warning' : 'blocked';
      }
      if (state === 'allowed') return row;

      const identity = normalizedTarget === undefined ? undefined : resolveFast(normalizedTarget) ?? normalizedTarget;
      const outsideMenu = declaredMenuIdentities !== undefined && identity !== undefined && !declaredMenuIdentities.has(identity);
      const source = `profile:${selectedProfileName}${outsideMenu ? '.restrict_models_to_menu' : ''}`;
      const reason = state === 'unknown' ? t('st.profiles.menuPreviewUnavailable')
        : t(state === 'warning' ? 'selection.modelMenuWarning' : 'selection.modelMenuBlocked', { source });
      return {
        ...row, disabled: state === 'blocked',
        hint: state === 'unknown' || source === row.hint ? undefined : source,
        description: reason, title: [row.title ?? row.label, reason].join('\n'),
      };
    });
  }, [catalogModelOptions, modelProjection, models, selectionDefaultModel, normalizedServerDefaultModel, selectedProfileName, modelSelectionPosition, validateFile, providerGroupLabel, t]);
  const selectedExecution = execution ?? boundExecution;
  const externalExecution = selectedExecution !== undefined && !isNativeExecutor(selectedExecution.executor);
  const executorId = externalExecution ? selectedExecution.executor : undefined;
  const bareExternal = externalExecution && selectedExecution.profile === undefined;
  const explicitProfileChoice = sessionId === undefined || agentProfilePending === true;
  const validateProfile = !fromFile && !bareExternal && explicitProfileChoice && agentProfile !== undefined && agentProfileCatalogMode.mode !== 'disabled';
  const validatingModel = externalExecution
    ? (typeof selectedExecution.overrides?.model === 'string' ? selectedExecution.overrides.model : undefined)
    : normalizedModel || selectionDefaultModel || normalizedServerDefaultModel;
  const modelRuleSource = projectedProfileModelRuleSource(modelProjection, models, validatingModel, selectedProfileName);
  const modelUnresolvedPending = validatingModel === undefined
    && (modelsQuery.isPending || frozenMenuQuery.isPending || normalizedServerDefaultModel === undefined);
  const modelDomainState = externalExecution
    ? 'allowed'
    : projectedProfileModelState(modelProjection, models, validatingModel, modelSelectionPosition, {
        unresolvedPending: modelUnresolvedPending,
      });
  const invalidModelDomain = modelDomainState === 'blocked'
    || (modelDomainState === 'unknown' && !(modelUnresolvedPending && !frozenMenuQuery.isError));
  const queryClient = useQueryClient();
  const executorModelsKey = ['executor-models', connectionId, scopeId, executorId] as const;
  const executorRefresh = useMutation({
    mutationFn: ({ id }: { id: string; key: readonly unknown[] }) => client.klient.rest!.executors.refreshModels(id),
    onSuccess: (response, variables) => { queryClient.setQueryData(variables.key, response); },
  });
  const executorRefreshCurrent = executorRefresh.variables?.key.join('\0') === executorModelsKey.join('\0');
  const executorModelsQuery = useQuery({
    queryKey: executorModelsKey,
    queryFn: () => client.klient.rest!.executors.getModels(executorId!),
    enabled: executorId !== undefined,
    staleTime: 60_000,
    retry: false,
  });
  const executorModelResponse = executorModelsQuery.data;
  const capabilityExecution = boundExecution ?? execution;
  const boundExecutorId = capabilityExecution !== undefined && !isNativeExecutor(capabilityExecution.executor)
    ? capabilityExecution.executor
    : undefined;
  const boundExecutorModelsQuery = useQuery({
    queryKey: ['executor-models', connectionId, scopeId, boundExecutorId],
    queryFn: () => client.klient.rest!.executors.getModels(boundExecutorId!),
    enabled: boundExecutorId !== undefined,
    staleTime: 60_000,
    retry: false,
  });
  // An external engine's capabilities go stale with age, so reading them
  // follows the second clock — but only such an engine has any. Joining the
  // clock unconditionally re-rendered the whole composer every second in
  // every session. Elapsed time since 0 is the clock itself; without an
  // engine the value is never read (both responses are absent).
  const capabilityNow = useElapsedSince(executorId !== undefined || boundExecutorId !== undefined ? 0 : undefined) ?? 0;
  const compactAvailability = useMemo((): ContextMeterCompactAvailability | undefined => {
    if (boundExecutorId === undefined) return undefined;
    if (engine?.advertisesCompact === true) return { available: true };
    const response = boundExecutorId === executorId ? executorModelResponse : boundExecutorModelsQuery.data;
    const control = mapExecutorCapabilities(response, capabilityNow).controls.manual_compact;
    if (control.kind === 'absent') return { available: false, reason: t('context.compactUnread') };
    if (isExecutorActionAvailable(control)) return { available: true };
    const reason = [
      t(control.kind === 'unavailable' ? 'context.compactUnavailable' : 'context.compactUnknown'),
      control.diagnostic,
    ].filter((part): part is string => part !== undefined && part !== '').join(' · ');
    return { available: false, reason };
  }, [boundExecutorId, engine?.advertisesCompact, executorId, executorModelResponse, boundExecutorModelsQuery.data, capabilityNow, t]);
  const executorCapabilities = mapExecutorCapabilities(executorModelResponse, capabilityNow);
  const executorModelValues = executorCapabilities.models.kind === 'ready' || executorCapabilities.models.kind === 'partial'
    ? executorCapabilities.models.values ?? [] : [];
  const executorModelOptions: readonly SearchableSelectOption[] = [
    ...(variant === 'subagent' ? [] : [{ value: '', label: t('composer.engineModelFollow') }]),
    ...executorModelValues.map((value) => ({ value, label: value })),
    ...(validatingModel !== undefined && !executorModelValues.includes(validatingModel)
      ? [{ value: validatingModel, label: validatingModel }] : []),
  ];
  const executorModelWritable = isExecutorActionAvailable(executorCapabilities.controls.model_switch)
    && (executorCapabilities.models.kind === 'ready' || executorCapabilities.models.kind === 'partial');
  const writeExecutorModel = (next: string | undefined) => {
    if (!executorModelWritable) return;
    if (onChangeExecution !== undefined && selectedExecution !== undefined) {
      onChangeExecution({
        ...selectedExecution,
        overrides: { ...selectedExecution.overrides, model: next ?? null },
      });
      return;
    }
    return onChangeModel(next);
  };
  const catalogExecutorItem = executorId === undefined
    ? undefined
    : executorCatalog.find((entry) => entry.id === executorId);
  const executorModelThinkingLevels = engine?.modelThinkingLevels ?? catalogExecutorItem?.capabilities?.negotiated?.model_thinking_levels;
  const executorPermissionModes = engine?.permissionModes ?? catalogExecutorItem?.capabilities?.negotiated?.permission_modes;
  const nativeAutoPermission = externalExecution && executorPermissionModes?.includes('auto') === true;
  const executorGlobalEfforts = isExecutorActionAvailable(executorCapabilities.controls.thinking_switch)
    && (executorCapabilities.thinking_levels.kind === 'ready' || executorCapabilities.thinking_levels.kind === 'partial')
    ? executorCapabilities.thinking_levels.values : undefined;
  const executorEfforts = resolveExecutorModelThinkingLevels(
    validatingModel,
    executorModelThinkingLevels,
    executorGlobalEfforts,
  );
  const selectedModel = !externalExecution && validatingModel !== undefined
    ? resolveCatalogModel(models, validatingModel)
    : undefined;
  // An override holding a bare alias (e.g. a profile-pinned k3-256k) displays
  // as the resolved catalog row, so the trigger names the serving provider's
  // model instead of an unmatched raw id.
  const resolvedModelKey = !externalExecution && normalizedModel !== undefined
    ? resolveCatalogModel(models, normalizedModel)?.id
    : undefined;
  // Catalog reads enrich the selection; the server validates the submitted binding.
  const selectionCatalogError = (validateFile ? filePreviewQuery.error : null) ??
    [externalExecution ? null : modelsQuery.error, validateProfile ? agentProfilesQuery.error : null]
      .find((error) => error !== null && !isTransientCatalogError(error)) ?? null;
  const invalidFile = validateFile && filePreviewQuery.data !== undefined
    && (filePreviewQuery.data.profile.source_file === undefined || filePreviewQuery.data.profile.disabled);
  const invalidProfile = validateProfile && (catalogProfile === undefined
    ? agentProfilesQuery.isSuccess && agentProfilesQuery.data.complete !== false
    : !isConversationProfile(catalogProfile));
  const invalidModel = !externalExecution && engine === undefined && modelsQuery.isSuccess && validatingModel !== undefined && selectedModel === undefined;
  const invalidEffort = !externalExecution && engine === undefined && modelsQuery.isSuccess && selectedModel !== undefined
    && effort !== undefined && !catalogModelSupportsEffort(selectedModel, effort);
  const isExternalClient = execution?.external_connection_id !== undefined;
  const selectionBlocked = !isExternalClient && (invalidFile || invalidProfile || invalidModel || invalidEffort || modelDomainState === 'blocked');

  // The composer mount survives route changes (the conversation shell owns
  // it). Menus, the slash confirm, undo, and a painted submit error belong
  // to the session that was on screen. An in-flight submit does not: the
  // button follows the owner now shown, so B is not stuck on A's promise and
  // returning to A while that promise is open keeps A's button disabled.
  const previousSessionIdRef = useRef(sessionId);
  useEffect(() => {
    composerAliveRef.current = true;
    return () => { composerAliveRef.current = false; };
  }, []);
  useEffect(() => {
    if (previousSessionIdRef.current === sessionId) return;
    slashFlightsRef.current.delete(sendOwnerKey(previousSessionIdRef.current));
    previousSessionIdRef.current = sessionId;
    const owner = sendOwnerKey(sessionId);
    const inFlight = sendFlightsRef.current.has(owner);
    turnInFlightRef.current = inFlight;
    setTurnInFlight(inFlight);
    const slashPending = slashFlightsRef.current.has(owner);
    slashCatalogPendingRef.current = slashPending;
    setSlashCatalogPending(slashPending);
    setAttachmentError(null);
    setMenu(null);
    dismissedTriggerRef.current = null;
    setSlashConfirm(null);
    setContextRebuildConfirm(false);
    // Session-scoped recall/undo state would otherwise leak A's entries into
    // B's draft surface (the composer mount survives route changes).
    historyIndexRef.current = null;
    undoStackRef.current = [];
    redoStackRef.current = [];
  }, [sessionId]);

  // Catalog browsing needs no session. Directory drafts use a read-only
  // snapshot; automatic drafts can already browse global skills and commands.
  // Session-only actions still depend on sessionId, not catalog availability.
  const skillsQuery = useQuery({
    queryKey: ['skills', skillScope],
    queryFn: () => sessionId !== undefined
      ? client.listSessionSkills(sessionId)
      : workspaceId !== undefined
        ? client.listWorkspaceSkills(workspaceId)
        : client.listDraftSkills(skillCwd),
    enabled: skillCatalogReady,
    staleTime: 60_000,
    retry: false,
  });
  const skills = skillsQuery.data?.skills ?? [];
  const pluginGuiSlots = usePluginGuiSlots({ sessionId, workspaceId });
  const { execute: executePluginSlotAction, busyKey: pluginSlotBusyKey } = useExecutePluginSlotAction();
  const pluginPick = usePluginPicker(sessionId, workspaceId);
  const mcpPick = useMcpPicker(sessionId);
  const externalEngine = execution !== undefined && execution.executor !== undefined && execution.executor !== '' && execution.executor !== 'native'
    ? engineLabel(execution.executor, execution.executor, executorCatalog)
    : undefined;
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
    () => withoutUnhandledActions(
      withoutRefusedActions(
        buildSlashItems(skills, {
          hasSession: sessionId !== undefined,
          pluginSlots: pluginGuiSlots.slots,
          locale,
        }),
        engine,
      ),
      onSideQuestion !== undefined,
      onOpenBranch !== undefined,
    ),
    [skills, sessionId, pluginGuiSlots.slots, locale, engine, onSideQuestion, onOpenBranch],
  );
  const skillMenuItems = useMemo(() => slashItems.filter((item) => item.kind === 'skill'), [slashItems]);
  // Pre-compute lowercase slash search entries once per `slashItems` identity
  // so typing in `/` across 1,000+ skills filters in O(N) with zero sorting.
  const slashSearchIndex = useMemo(
    () => slashItems.map((item) => ({
      item,
      nameLower: item.name.toLowerCase(),
      descLower: item.description.toLowerCase(),
    })),
    [slashItems],
  );
  const slashMenuQuery = menu?.kind === 'slash' ? menu.query : '';
  const deferredSlashQuery = useDeferredValue(slashMenuQuery);
  const filteredSlashItems = useMemo(() => {
    if (menu?.kind !== 'slash') return [];
    const q = deferredSlashQuery.trim().toLowerCase();
    const inlineOnly = menu.inline;
    if (q === '') {
      const candidates = inlineOnly ? skillMenuItems : slashItems;
      return orderSlashItemsForDisplay(candidates);
    }
    const skillR0: SlashItem[] = [];
    const skillR1: SlashItem[] = [];
    const skillR2: SlashItem[] = [];
    const pluginR0: SlashItem[] = [];
    const pluginR1: SlashItem[] = [];
    const pluginR2: SlashItem[] = [];
    const actionR0: SlashItem[] = [];
    const actionR1: SlashItem[] = [];
    const actionR2: SlashItem[] = [];
    for (let i = 0; i < slashSearchIndex.length; i += 1) {
      const entry = slashSearchIndex[i]!;
      const { item } = entry;
      if (inlineOnly && item.kind !== 'skill') continue;
      let rank = -1;
      if (entry.nameLower.startsWith(q)) rank = 0;
      else if (entry.nameLower.includes(q)) rank = 1;
      else if (entry.descLower.includes(q)) rank = 2;
      if (rank < 0) continue;
      if (item.kind === 'skill') {
        if (rank === 0) skillR0.push(item);
        else if (rank === 1) skillR1.push(item);
        else skillR2.push(item);
      } else if (item.kind === 'plugin') {
        if (rank === 0) pluginR0.push(item);
        else if (rank === 1) pluginR1.push(item);
        else pluginR2.push(item);
      } else {
        if (rank === 0) actionR0.push(item);
        else if (rank === 1) actionR1.push(item);
        else actionR2.push(item);
      }
    }
    return [...skillR0, ...skillR1, ...skillR2, ...pluginR0, ...pluginR1, ...pluginR2, ...actionR0, ...actionR1, ...actionR2];
  }, [menu, slashItems, skillMenuItems, slashSearchIndex, deferredSlashQuery]);

  // Debounced file-picker query (fires only while the mention menu is open).
  useEffect(() => {
    if (menu?.kind !== 'mention') return;
    const timer = setTimeout(() => { setMentionQuery(menu.query); }, MENTION_DEBOUNCE_MS);
    return () => { clearTimeout(timer); };
  }, [menu]);
  const mentionScope = mentionScopeKey ?? sessionId ?? 'none';
  const fsFeed = useFsSearchFeed({
    scopeKey: mentionScope,
    query: mentionQuery,
    search: fsSearch ?? (() => Promise.resolve([])),
    enabled: menu?.kind === 'mention' && menu.query === mentionQuery && fsSearch !== undefined,
  });
  const lastMentionItemsRef = useRef<readonly FsSearchHit[]>([]);
  const lastMentionScopeRef = useRef(mentionScope);
  if (menu?.kind !== 'mention' || lastMentionScopeRef.current !== mentionScope) {
    lastMentionScopeRef.current = mentionScope;
    lastMentionItemsRef.current = [];
  } else if (menu.query === mentionQuery && !fsFeed.pendingInitial) {
    lastMentionItemsRef.current = fsFeed.items;
  }
  const mentionLoading = menu?.kind === 'mention' && fsSearch !== undefined && (menu.query !== mentionQuery || fsFeed.pendingInitial);
  const mentionItems = menu?.kind === 'mention'
    ? (menu.query === mentionQuery && !fsFeed.pendingInitial ? fsFeed.items : lastMentionItemsRef.current)
    : [];

  // Agent candidates (the `@` menu's agent groups) come from the server's
  // `GET /agents/references`, keyed to the same scope the profile catalog uses.
  // The server is the sole producer: it hides hard-policy blocks and returns
  // fixable faults as unavailable rows. Until 934's handler ships, the fixture
  // feeds this exact shape. The query needs the scope's profile name for the
  // workspace/cwd forms; the session form needs only ids.
  const agentReferenceScope = useMemo((): AgentReferenceCandidatesQuery | null => {
    if (sessionId !== undefined) return { session_id: sessionId, agent_id: agentId };
    if (agentProfileCatalogMode.mode === 'workspace') return { workspace_id: agentProfileCatalogMode.workspaceId, profile: selectedProfileName };
    if (agentProfileCatalogMode.mode === 'cwd') return { cwd: agentProfileCatalogMode.cwd, profile: selectedProfileName };
    return null;
  }, [sessionId, agentId, agentProfileCatalogMode, selectedProfileName]);
  const agentReferencesQuery = useQuery({
    queryKey: ['agent-references', connectionId, scopeId, agentReferenceScope],
    queryFn: () => client.klient.rest!.agents.referenceCandidates(agentReferenceScope!),
    enabled: menu?.kind === 'mention' && agentReferenceScope !== null,
    staleTime: 60_000,
    retry: false,
  });
  const agentCandidateList = useMemo(
    () => (agentReferencesQuery.data === undefined ? { groups: [], delegationAvailable: true } : groupAgentCandidates(agentReferencesQuery.data, t)),
    [agentReferencesQuery.data, t],
  );
  const filteredAgentGroups = useMemo(
    () => (menu?.kind === 'mention' ? filterAgentCandidates(agentCandidateList.groups, menu.query) : []),
    [menu, agentCandidateList],
  );
  const mentionAgentRows = useMemo(
    () => filteredAgentGroups.flatMap((group) => group.candidates),
    [filteredAgentGroups],
  );
  // The unified mention list rows: file hits first, then agent candidates.
  // The flat index drives ↑/↓, Enter and Tab across both groups as one list.
  type MentionRow =
    | { readonly kind: 'file'; readonly hit: FsSearchHit }
    | { readonly kind: 'agent'; readonly candidate: AgentReferenceCandidate };
  const mentionRows: readonly MentionRow[] = useMemo(
    () => [
      ...mentionItems.map((hit): MentionRow => ({ kind: 'file', hit })),
      ...mentionAgentRows.map((candidate): MentionRow => ({ kind: 'agent', candidate })),
    ],
    [mentionItems, mentionAgentRows],
  );
  const mentionRowCount = mentionRows.length;

  const menuRowCount = menu?.kind === 'slash' ? filteredSlashItems.length : mentionRowCount;
  const menuQuery = menu?.query ?? null;
  const isMenuRowDisabled = (index: number): boolean => {
    if (menu?.kind === 'slash') return filteredSlashItems[index]?.disabled === true;
    const row = mentionRows[index];
    return row !== undefined && row.kind === 'agent' && !row.candidate.available;
  };
  const firstEnabledMenuIndex = useMemo(() => {
    if (menu?.kind === 'slash') {
      const idx = filteredSlashItems.findIndex((item) => item.disabled !== true);
      return idx >= 0 ? idx : 0;
    }
    if (menu?.kind === 'mention') {
      const idx = mentionRows.findIndex((row) => row.kind === 'file' || row.candidate.available);
      return idx >= 0 ? idx : 0;
    }
    return 0;
  }, [menu?.kind, filteredSlashItems, mentionRows]);
  useEffect(() => {
    setActiveIndex(firstEnabledMenuIndex);
    setSlashHoverIndex(null);
  }, [menuQuery, menu?.kind, firstEnabledMenuIndex]);

  // C-2: the preview card follows the hovered row, else the keyboard-active
  // row; actions already show their whole one-liner inline, and a skill/plugin
  // with an empty description degrades to no card at all.
  const slashPreviewItem = useMemo(() => {
    if (menu?.kind !== 'slash') return null;
    const index = slashHoverIndex ?? activeIndex;
    const item = filteredSlashItems[Math.min(index, filteredSlashItems.length - 1)];
    if (
      item === undefined ||
      (item.kind !== 'skill' && item.kind !== 'plugin') ||
      item.description.trim() === ''
    ) {
      return null;
    }
    return item;
  }, [menu, filteredSlashItems, slashHoverIndex, activeIndex]);

  // Overlay registration keeps Escape scoped to the menu (not turn-abort).
  useEffect(() => {
    if (menu === null) return;
    return registerOverlay('composer-menu');
  }, [menu]);

  // Placeholder chips (image base64 still reading, file upload still in
  // flight) block sending so a quick Enter cannot silently drop content.
  const pendingAttachments = attachments.some(
    (attachment) =>
      (attachment.kind === 'image' && attachment.data === '') ||
      (attachment.kind === 'upload' && attachment.fileId === undefined),
  );

  // Edits bypass send-only model selection, but still wait for all media.
  const canSend = queueEditing || messageEditing
    ? (text.trim() !== '' || attachments.length > 0 || (annotations?.length ?? 0) > 0 || quoteItems.length > 0) &&
      !disabled && !sendDisabled && !turnInFlight && !pendingAttachments
    : (text.trim() !== '' ||
        attachments.length > 0 ||
        (annotations !== undefined && annotations.length > 0) ||
        (quoteItems.length > 0)) &&
      !disabled &&
      !sendDisabled &&
      !selectionBlocked &&
      !pendingAttachments &&
      !ssh.pending &&
      !turnInFlight &&
      !slashCatalogPending;

  // The chips band (quote/annotations/goal-mode/attachments/errors/typo
  // guard) only exists with content; it gates the wrapper's top padding above
  // the input.
  // The draft's resolved skill tokens (leading or inline), chipped in the tray
  // and tinted in the editor once completed. While the slash menu is open on a
  // token or a lone leading `/name` has no trailing whitespace yet, that token
  // stays unchipped until completed.
  const skillActivationEnabled = !externalExecution && onActivateSkill !== undefined;
  const resolvedDraftSkills = useMemo(() => {
    if (!skillActivationEnabled || !text.includes('/')) return EMPTY_DRAFT_SKILLS;
    const activeSlashEnd = menu?.kind === 'slash' ? menu.end : undefined;
    const raw = extractSlashSkillTokens(slashItems, text, {
      includeLeading: true,
      activeCursor: activeSlashEnd,
    });
    const occurrences = raw.occurrences.filter(
      (match) => !(match.start === 0 && match.end === text.length),
    );
    if (occurrences.length === 0) return EMPTY_DRAFT_SKILLS;
    const seen = new Set<string>();
    const activations = occurrences.filter((match) => {
      const key = match.skillName.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { occurrences, activations };
  }, [skillActivationEnabled, slashItems, text, menu]);
  const draftSkills = resolvedDraftSkills.activations;
  const skillSpans = useMemo(
    () => (resolvedDraftSkills.occurrences.length === 0
      ? EMPTY_SKILL_SPANS
      : resolvedDraftSkills.occurrences.map((match) => ({
          start: match.start,
          end: match.end,
          skillName: match.skillName,
        }))),
    [resolvedDraftSkills.occurrences],
  );
  const removeDraftSkill = (skillName: string) => {
    const matches = resolvedDraftSkills.occurrences
      .filter((match) => match.skillName.toLowerCase() === skillName.toLowerCase())
      .toSorted((a, b) => b.start - a.start);
    if (matches.length === 0) return;
    pushUndoSnapshot({ text, cursor: lastCursorRef.current });
    historyIndexRef.current = null;
    let nextText = text;
    let nextCursor = lastCursorRef.current;
    for (const match of matches) {
      const removed = removeSkillToken(nextText, match);
      nextText = removed.text;
      nextCursor = removed.cursor;
    }
    applyTextChange(nextText, nextCursor);
  };
  // Conversation links in the draft — threads and rooms alike: one tray chip
  // each, a tinted token in the text, and whole-link deletion.
  const conversationRefs = useMemo(
    () => (text.includes('/') || text.includes('[[') ? findConversationRefs(text) : EMPTY_CONVERSATION_REFS),
    [text],
  );
  const agentRefs = useMemo(
    () => (text.includes('@') ? findAgentRefs(text) : EMPTY_AGENT_REFS),
    [text],
  );
  // Labels are presentation only; the editor, draft and submission share raw offsets.
  const backdropTokens = useMemo(
    () => (conversationRefs.length === 0 && agentRefs.length === 0
      ? []
      : [
          ...conversationRefs.map((ref) => ({ start: ref.start, end: ref.end, raw: ref.raw, kind: ref.kind as string, profile: undefined as string | undefined })),
          ...agentRefs.map((ref) => ({ start: ref.start, end: ref.end, raw: ref.raw, kind: 'agent' as string, profile: ref.profile as string | undefined })),
        ].toSorted((a, b) => a.start - b.start || a.end - b.end)),
    [conversationRefs, agentRefs],
  );
  const threadRefs = useMemo(
    () => (conversationRefs.length === 0 ? EMPTY_CONVERSATION_REFS : conversationRefs.filter((ref) => ref.kind === 'session')),
    [conversationRefs],
  );
  const roomRefs = useMemo(
    () => (conversationRefs.length === 0 ? EMPTY_CONVERSATION_REFS : conversationRefs.filter((ref) => ref.kind === 'room')),
    [conversationRefs],
  );
  const threadRefIds = useMemo(
    () => (threadRefs.length === 0 ? EMPTY_STRING_IDS : threadRefs.map((ref) => ref.id)),
    [threadRefs],
  );
  const roomRefIds = useMemo(
    () => (roomRefs.length === 0 ? EMPTY_STRING_IDS : roomRefs.map((ref) => ref.id)),
    [roomRefs],
  );
  const fetchThreadSession = useCallback((id: string) => client.getSession(id), [client]);
  const fetchThreadHostId = useCallback(() => client.klient.global.threads.hostId(), [client]);
  const threadRefDirectory = useThreadRefDirectory(threadRefIds, fetchThreadSession, fetchThreadHostId);
  const roomRefDirectory = useRoomRefDirectory(roomRefIds, roomRefFetcher(client));
  // The model gets the room's identity and what the client knows about it;
  // an unresolved room still carries its id and nothing invented.
  const roomRefInfoOf = useCallback(
    (roomId: string) => ({ id: roomId, ...roomRefDirectory.lookup(roomId) }),
    [roomRefDirectory],
  );
  // Token overlay labels: a referenced agent shows its candidate label (the
  // profile name before candidates load or for a stale reference); a linked
  // thread or room shows its title/name, falling back to the raw link when the
  // record is not loaded yet. The raw link stays in the (transparent) textarea
  // and is what gets sent.
  const agentLabelByProfile = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of agentCandidateList.groups) {
      for (const candidate of group.candidates) {
        if (!map.has(candidate.profile)) map.set(candidate.profile, candidate.label);
      }
    }
    return map;
  }, [agentCandidateList]);
  const overlayTokens = useMemo(
    () => (backdropTokens.length === 0 ? EMPTY_OVERLAY_TOKENS : backdropTokens.map((ref) => {
      let label: string;
      let unresolved = false;
      if (ref.kind === 'agent') {
        label = `@${(ref.profile !== undefined ? agentLabelByProfile.get(ref.profile) : undefined) ?? ref.profile ?? ref.raw}`;
      } else if (ref.kind === 'session') {
        const refId = conversationRefs.find((candidate) => candidate.raw === ref.raw)?.id;
        const title = refId === undefined ? undefined : threadRefDirectory.lookup(refId).session?.title.trim();
        if (title === undefined || title === '') {
          unresolved = true;
          label = refId === undefined
            ? ref.raw
            : `@${locale === 'zh' ? '会话' : 'Thread'} · ${shortRefId(refId)}`;
        } else {
          label = title;
        }
      } else if (ref.kind === 'room') {
        const refId = conversationRefs.find((candidate) => candidate.raw === ref.raw)?.id;
        const name = refId === undefined ? undefined : roomRefDirectory.lookup(refId).name?.trim();
        if (name === undefined || name === '') {
          unresolved = true;
          label = refId === undefined
            ? ref.raw
            : `@${locale === 'zh' ? '群聊' : 'Room'} · ${shortRefId(refId)}`;
        } else {
          label = name;
        }
      } else {
        label = ref.raw;
      }
      return { ...ref, label, unresolved };
    })),
    [backdropTokens, agentLabelByProfile, conversationRefs, threadRefDirectory, roomRefDirectory, locale],
  );
  const pluginToolbarSlots = useMemo(
    () => (variant !== 'subagent' && !queueEditing && !messageEditing
      ? selectComposerToolbarSlots(pluginGuiSlots.slots)
      : []),
    [variant, queueEditing, messageEditing, pluginGuiSlots.slots],
  );
  const addMenuExtensionItems = useMemo<readonly AddMenuExtensionItem[]>(
    () => pluginToolbarSlots
      .filter((slot) => slot.action.kind !== 'open_plugin_panel')
      .map((slot) => {
      const key = `${slot.pluginId}:${slot.id}`;
      const label = resolvePluginLocalizedText(slot.label, locale);
      const tooltip = slot.tooltip === undefined ? label : resolvePluginLocalizedText(slot.tooltip, locale);
      const explicitIcon = (slot as { readonly icon?: string }).icon;
      const panelIdHint = slot.action.kind === 'open_plugin_panel' ? slot.action.panelId : undefined;
      const iconName = resolvePluginSlotIconName({
        icon: explicitIcon,
        pluginId: slot.pluginId,
        panelId: panelIdHint,
        fallback: 'plugin',
      });
      return {
        key,
        pluginId: slot.pluginId,
        slotId: slot.id,
        label,
        tooltip,
        badgeText: slot.badgeText,
        iconName,
        actionKind: slot.action.kind,
        onTrigger: () => {
          void executePluginSlotAction(
            {
              pluginId: slot.pluginId,
              label,
              action: slot.action,
              sessionId,
              workspaceId,
            },
            key,
          );
        },
      };
    }),
    [pluginToolbarSlots, locale, executePluginSlotAction, sessionId, workspaceId],
  );
  const hasPluginStatusCapsules =
    variant !== 'subagent' &&
    pluginGuiSlots.slots.some((slot) => slot.slot === 'status-capsule');
  const hasModeBanner = queueEditing;
  const payloadAttachments = attachments.filter((attachment) => attachment.kind !== 'ssh');
  const hasTray =
    draftSkills.length > 0 ||
    quoteItems.length > 0 ||
    (annotations !== undefined && annotations.length > 0) ||
    payloadAttachments.length > 0;
  const hasLayer2 = hasTray || attachmentError !== null || slashConfirm !== null;

  /**
   * Snapshot the pre-edit state. Any genuine edit clears the redo lane —
   * only undo/redo themselves may push without clearing.
   */
  const pushUndoSnapshot = (snapshot: ComposerUndoEntry) => {
    undoStackRef.current.push(snapshot);
    if (undoStackRef.current.length > UNDO_STACK_LIMIT) undoStackRef.current.shift();
    redoStackRef.current = [];
  };

  // ---- needs-you takeover ----
  // The card becomes the pending decision when there is nothing of the
  // user's in it: an empty draft (no text, attachments, quote or notes) and
  // no caret in the textarea. Otherwise a bar above the card offers it, and
  // a click on the bar takes over explicitly. "Back to input" releases the
  // card until the pending set grows again.
  const [inputFocused, setInputFocused] = useState(false);
  const [takeoverChoice, setTakeoverChoice] = useState<'take' | 'release' | null>(null);
  const needsYouCount = needsYou?.count ?? 0;
  const lastNeedsYouCountRef = useRef(needsYouCount);
  useEffect(() => {
    const previous = lastNeedsYouCountRef.current;
    lastNeedsYouCountRef.current = needsYouCount;
    // Everything answered: the next arrival starts from the default again.
    // A new arrival re-offers the card even after a release.
    if (needsYouCount === 0 || needsYouCount > previous) setTakeoverChoice((choice) => (choice === 'take' && needsYouCount > 0 ? choice : null));
  }, [needsYouCount]);
  const takeOverSeq = needsYou?.takeOverSeq;
  useEffect(() => {
    if (takeOverSeq !== undefined) setTakeoverChoice('take');
  }, [takeOverSeq]);
  const draftHasContent =
    text.trim() !== '' ||
    attachments.length > 0 ||
    (quoteItems.length > 0) ||
    (annotations !== undefined && annotations.length > 0);
  const takenOver =
    needsYou !== undefined && needsYouCount > 0 && !queueEditing &&
    (takeoverChoice === 'take' || (takeoverChoice === null && !draftHasContent && !inputFocused));
  const offerTakeover = needsYou !== undefined && needsYouCount > 0 && !takenOver && !queueEditing;
  const takeOver = () => {
    lastCursorRef.current = textareaRef.current?.selectionStart ?? lastCursorRef.current;
    setMenu(null);
    setTakeoverChoice('take');
    setInputFocused(false);
  };
  const backToInput = () => {
    setTakeoverChoice('release');
    const cursor = lastCursorRef.current;
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (node === null) return;
      const at = Math.min(cursor, node.value.length);
      node.focus();
      node.setSelectionRange(at, at);
    });
  };

  /** Write a local edit and its caret in one editor transaction, then mirror the controlled value. */
  const applyTextChange = (nextText: string, cursor: number) => {
    cancelDraftSyncTimer();
    setMenu(null);
    const nextValue = normalizeComposerText(nextText);
    const nextCursor = normalizeComposerText(nextText.slice(0, Math.max(0, Math.min(cursor, nextText.length)))).length;
    lastCursorRef.current = nextCursor;
    pendingEmitsRef.current.length = 0;
    const node = textareaRef.current;
    if (node !== null && !composingRef.current) {
      node.focus();
      node.setValueAndCursor(nextValue, nextCursor);
    }
    onChange(nextValue);
  };

  // Outside inserts (the sidebar's "Add to conversation"): the snippet lands
  // at the last caret of this session's main composer, as one undo step.
  const insertAtCaretRef = useRef<(snippet: string) => boolean>(() => false);
  insertAtCaretRef.current = (snippet: string) => {
    if (disabled || queueEditing || composingRef.current) return false;
    const node = textareaRef.current;
    const focused = node !== null && document.activeElement === node.element;
    const selection = focused
      ? { start: node.selectionStart, end: node.selectionEnd }
      : { start: lastCursorRef.current, end: lastCursorRef.current };
    const currentText = liveTextRef.current;
    const next = insertThreadRef(currentText, selection, snippet);
    pushUndoSnapshot({ text: currentText, cursor: lastCursorRef.current });
    historyIndexRef.current = null;
    applyTextChange(next.text, next.cursor);
    return true;
  };
  useEffect(() => {
    if (sessionId === undefined || variant === 'subagent') return;
    return subscribeComposerInserts(sessionId, (snippet) => insertAtCaretRef.current(snippet));
  }, [sessionId, variant]);

  const pluginPromptInsertRef = useRef<(request: PluginPromptInsertRequest) => boolean>(() => false);
  pluginPromptInsertRef.current = (request: PluginPromptInsertRequest) => {
    if (disabled || queueEditing || messageEditing || composingRef.current) return false;
    const interpolated = interpolatePluginPromptText(request.text, request.args);
    if (interpolated.trim() === '') return false;
    if (request.submit === true) {
      if (turnInFlightRef.current || pendingAttachments || selectionBlocked || ssh.pending || slashCatalogPendingRef.current) {
        return false;
      }
      setMenu(null);
      setSlashConfirm(null);
      pushUndoSnapshot({ text, cursor: lastCursorRef.current });
      historyIndexRef.current = null;
      applyTextChange('', 0);
      sendPrompt(interpolated);
      return true;
    }
    const separator = text === '' || /\s$/.test(text) ? '' : '\n';
    const nextText = `${text}${separator}${interpolated}`;
    pushUndoSnapshot({ text, cursor: lastCursorRef.current });
    historyIndexRef.current = null;
    applyTextChange(nextText, nextText.length);
    return true;
  };
  useEffect(() => {
    if (variant === 'subagent') return;
    return subscribePluginPromptInserts(sessionId, (request) => pluginPromptInsertRef.current(request));
  }, [sessionId, variant]);

  const undoEdit = () => {
    const entry = undoStackRef.current.pop();
    if (entry === undefined) return;
    redoStackRef.current.push({ text: liveTextRef.current, cursor: lastCursorRef.current });
    historyIndexRef.current = null;
    applyTextChange(entry.text, entry.cursor);
  };

  const redoEdit = () => {
    const entry = redoStackRef.current.pop();
    if (entry === undefined) return;
    undoStackRef.current.push({ text: liveTextRef.current, cursor: lastCursorRef.current });
    historyIndexRef.current = null;
    applyTextChange(entry.text, entry.cursor);
  };

  /**
   * C-1 recall walk. ↑ steps to an older prompt only when the caret is at the
   * start of the text; ↓ steps newer, and ↓ past the newest entry hands the
   * pre-browse draft back, only when the caret is at the end. A wrapped line
   * is not the start. The same edges apply while already browsing. Returns
   * false when the keypress is not ours so the caret keeps its native move.
   */
  const recallHistory = (delta: -1 | 1): boolean => {
    if (inputHistory.length === 0) return false;
    const node = textareaRef.current;
    if (node === null || node.selectionStart !== node.selectionEnd) return false;
    const atStart = node.selectionStart === 0;
    const atEnd = node.selectionStart === node.value.length;
    if (historyIndexRef.current === null) {
      if (delta !== -1 || !atStart) return false;
      historySnapshotRef.current = liveTextRef.current;
      historyIndexRef.current = inputHistory.length - 1;
    } else {
      const canStepOlder = delta === -1 && (atStart || (atEnd && recalledCaretUntouchedRef.current));
      const canStepNewer = delta === 1 && (atEnd || (atStart && recalledCaretUntouchedRef.current));
      if (!canStepOlder && !canStepNewer) return false;
      const next = historyIndexRef.current + delta;
      if (next >= inputHistory.length) {
        historyIndexRef.current = null;
        recalledCaretUntouchedRef.current = false;
        recalledCaretPosRef.current = null;
        applyTextChange(historySnapshotRef.current, historySnapshotRef.current.length);
        return true;
      }
      if (next < 0) return true;
      historyIndexRef.current = next;
    }
    const entry = inputHistory[historyIndexRef.current] ?? '';
    recalledCaretUntouchedRef.current = true;
    recalledCaretPosRef.current = entry.length;
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
   * text for ↑ recall under the session key captured when the send started.
   * The error clear, recall cursor, and undo snapshot touch the resident
   * composer. Those run only while this submit is still the visible
   * generation: a VS Code prepare that resolves after a session switch must
   * not seed the next draft's undo or clear its error. Local shortcut actions
   * (`/plan` …) are not sent, so they never land here.
   */
  const recordSubmission = (surface: boolean, submittedText = liveTextRef.current) => {
    if (historyKey !== undefined) pushInputHistory(historyKey, submittedText);
    if (!surface) return;
    setAttachmentError(null);
    historyIndexRef.current = null;
    pushUndoSnapshot({ text: submittedText, cursor: lastCursorRef.current });
  };
  const submissionVisible = (flight: SendFlight): boolean =>
    composerAliveRef.current
    && sendFlightsRef.current.get(flight.owner) === flight.generation
    && sendOwnerKey(sessionIdRef.current) === flight.owner;

  const runAction = (action: SlashActionId) => {
    switch (action) {
      case 'plan':
        // Plan and goal are exclusive: turning plan on disarms goal.
        if (!planMode) {
          onChangePlanMode(true);
          if (onChangeGoalMode !== undefined && goalMode) onChangeGoalMode(false);
          setLocalGoalArmed(false);
        } else {
          onChangePlanMode(false);
        }
        setAddView('mode');
        break;
      case 'goal':
        if (planMode) onChangePlanMode(false);
        if (onChangeGoalMode !== undefined) {
          onChangeGoalMode(true);
        } else {
          setLocalGoalArmed(true);
        }
        setAddView('mode');
        break;
      case 'new':
        void navigate('/new');
        break;
      case 'btw':
        onSideQuestion?.();
        break;
      case 'branch':
        onOpenBranch?.();
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
    if (item.disabled === true || composingRef.current) return;
    const trigger = menu?.kind === 'slash' ? menu : null;
    dismissedTriggerRef.current = null;
    setMenu(null);
    if (item.kind === 'skill') {
      if (trigger === null) return;
      const completed = completeSlashTrigger(text, trigger, item.name);
      pushUndoSnapshot({ text, cursor: lastCursorRef.current });
      applyTextChange(completed.text, completed.cursor);
      return;
    }
    if (item.kind === 'plugin') {
      if (item.argumentHint !== undefined && trigger !== null) {
        const completed = completeSlashTrigger(text, trigger, item.name);
        pushUndoSnapshot({ text, cursor: lastCursorRef.current });
        applyTextChange(completed.text, completed.cursor);
        return;
      }
      onChange('');
      if (item.pluginId !== undefined && item.pluginAction !== undefined) {
        void executePluginSlotAction(
          {
            pluginId: item.pluginId,
            label: `/${item.name}`,
            action: item.pluginAction,
            sessionId,
            workspaceId,
          },
          `${item.pluginId}:${item.slotId ?? item.name}`,
        );
      }
      return;
    }
    onChange('');
    if (item.action !== undefined) runAction(item.action);
  };

  /** Accept the highlighted file: chip it and lift the `@token` out of the text. */
  const acceptMentionItem = (hit: FsSearchHit) => {
    if (menu?.kind !== 'mention') return;
    const trigger = menu;
    dismissedTriggerRef.current = null;
    setMenu(null);
    const node = textareaRef.current;
    const cursor = node?.selectionStart ?? text.length;
    const next = text.slice(0, trigger.start) + text.slice(cursor);
    pushUndoSnapshot({ text, cursor: lastCursorRef.current });
    applyTextChange(next, trigger.start);
    const currentAttachments = attachmentBaselineRef.current;
    if (!hasMention(currentAttachments, hit.path)) {
      updateAttachments([
        ...currentAttachments,
        { kind: 'file', path: hit.path, name: hit.name, isDir: hit.kind === 'directory' },
      ]);
    }
  };

  /** Accept the highlighted mention row, whether it is a file hit or an agent. */
  const acceptMentionRow = (row: MentionRow) => {
    if (row.kind === 'file') acceptMentionItem(row.hit);
    else acceptMentionAgent(row.candidate);
  };

  /**
   * Accept the highlighted agent target: replace the `@query` trigger text with
   * the server's `reference` link verbatim. An unavailable target is dimmed and
   * cannot be picked. The link stays in the draft text (not an attachment), so
   * it survives queue edit/resend and the backend reads it on send.
   */
  const acceptMentionAgent = (candidate: AgentReferenceCandidate) => {
    if (menu?.kind !== 'mention' || !candidate.available) return;
    const trigger = menu;
    dismissedTriggerRef.current = null;
    setMenu(null);
    const node = textareaRef.current;
    const cursor = node?.selectionStart ?? text.length;
    pushUndoSnapshot({ text, cursor: lastCursorRef.current });
    historyIndexRef.current = null;
    const next = replaceMentionTriggerWithAgentRef(text, trigger, cursor, candidate.reference);
    applyTextChange(next.text, next.cursor);
  };

  /**
   * ＋ → Skills: the same `/name ` token the `/` picker completes, placed at
   * the start of the draft (skills activate from a leading token) with any
   * typed text kept as its args; caret after the token.
   */
  const insertSkillFromMenu = (item: SlashItem) => {
    if (item.disabled === true || composingRef.current) return;
    const rest = text.replace(/^\/\S*\s*/, '');
    const token = `/${item.name} `;
    const next = token + rest;
    pushUndoSnapshot({ text, cursor: lastCursorRef.current });
    applyTextChange(next, token.length);
  };

  /** ＋ → Mention a file: the same chip the `@` picker adds. */
  const mentionFromMenu = (hit: FsSearchHit) => {
    const currentAttachments = attachmentBaselineRef.current;
    if (!hasMention(currentAttachments, hit.path)) {
      updateAttachments([
        ...currentAttachments,
        { kind: 'file', path: hit.path, name: hit.name, isDir: hit.kind === 'directory' },
      ]);
    }
    requestAnimationFrame(() => { textareaRef.current?.focus(); });
  };

  /**
   * A committed pick in a toolbar picker (model, profile, persona) hands the
   * keyboard back to the editor the same way: the picker's close leaves focus
   * on its trigger, where the next keystroke typed nothing — or a bare y/n
   * reached a pending approval. Escape / cancel do not call this, so keyboard
   * users who dismiss a menu stay on its trigger. The move happens on the next
   * frame and only if focus is still on that trigger, so a confirm dialog the
   * pick opened, or a click elsewhere meanwhile, keeps what it took. Never on
   * touch: focusing the editor there raises the software keyboard.
   */
  const focusEditorAfterPick = () => {
    if (isCoarsePointer()) return;
    const trigger = document.activeElement;
    requestAnimationFrame(() => {
      const input = textareaRef.current;
      if (input === null || input.disabled || document.activeElement !== trigger || anyOverlayOpen()) return;
      input.focus();
    });
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
    void Promise.allSettled(
      accepted.map(async (file) => fileToImageAttachment(await file.read())),
    ).then((results) => {
      if (!ownsReservedAttachmentResult()) return;
      let firstError: unknown;
      updateAttachments((current) =>
        current.flatMap((item) => {
          const stubIndex = stubs.indexOf(item);
          if (stubIndex === -1) return [item];
          const result = results[stubIndex];
          if (result?.status === 'fulfilled') return [result.value];
          if (result?.status === 'rejected' && firstError === undefined) firstError = result.reason;
          return [];
        }),
      );
      if (firstError !== undefined && ownsAttachmentResult()) {
        setAttachmentError(errorText(locale, firstError));
      }
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
        .then((contents) => client.uploadFile(contents, sessionId))
        .then((meta) => {
          if (!ownsReservedAttachmentResult()) return;
          updateAttachments((current) =>
            current.map((item) => (item === stub ? { ...stub, fileId: meta.id } : item)),
          );
        })
        .catch((error: unknown) => {
          if (!ownsReservedAttachmentResult()) return;
          updateAttachments((current) => current.filter((item) => item !== stub));
          if (!ownsAttachmentResult()) return;
          setAttachmentError(
            `${issueText(locale, { key: 'attach.uploadFailed', params: { name: file.name } })} — ${errorText(locale, error)}`,
          );
        });
    }
  };

  // Late async arrivals (native picker resolving after the composer turned
  // disabled, a queued file-input change) must not add attachments.
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  // Preserve exact single-pass order for mixed image + file selections/pastes.
  const addFiles = (files: readonly SelectedAttachmentFile[]) => {
    if (disabledRef.current || !ownsAttachmentResult()) return;
    let rejectedImages = false;
    let batchKind: 'image' | 'upload' | null = null;
    let batch: SelectedAttachmentFile[] = [];
    const flushBatch = () => {
      if (batch.length === 0 || batchKind === null) return;
      if (batchKind === 'image') addImageFiles(batch);
      else addUploadFiles(batch);
      batch = [];
      batchKind = null;
    };
    for (const file of files) {
      const isImage = ACCEPTED_IMAGE_MIMES.includes(file.type);
      if (isImage && engine?.images === false) {
        rejectedImages = true;
        continue;
      }
      const kind = isImage ? 'image' : 'upload';
      if (batchKind !== null && batchKind !== kind) flushBatch();
      batchKind = kind;
      batch.push(file);
    }
    flushBatch();
    if (rejectedImages) {
      setAttachmentError(t('composer.engineNoImages', { engine: engine!.label }));
    }
  };
  // Serialize rapid consecutive pastes so paste #1 always reserves its
  // attachment slot before paste #2 commits, preserving true paste order even
  // when async clipboard reads resolve out of order.
  const pasteQueueRef = useRef<Promise<void>>(Promise.resolve());
  pasteContentRef.current = (read) => {
    const node = textareaRef.current;
    if (node === null || node.disabled) return Promise.resolve();
    const draft = { ...pasteDraftRef.current, text: liveTextRef.current };
    const selection = { start: node.selectionStart ?? lastCursorRef.current, end: node.selectionEnd ?? lastCursorRef.current };
    const run = async () => {
      if (disabledRef.current || textareaRef.current !== node || node.disabled) return;
      setAttachmentError(null);
      try {
        const native = await host.readClipboardFiles?.();
        const browser = native === null || native === undefined ? await read() : null;
        const latest = { ...pasteDraftRef.current, text: liveTextRef.current };
        if (!ownsAttachmentResult() || textareaRef.current !== node || node.disabled || latest.sessionId !== draft.sessionId || latest.connectionId !== draft.connectionId || latest.scopeId !== draft.scopeId) return;
        const paths = [...(native?.paths ?? [])];
        const media = [...(native?.media ?? [])];
        let missingPaths = false;
        for (const file of browser?.files ?? []) {
          const type = pastedMediaType(file);
          if (type !== null) {
            media.push({ name: file.name, size: file.size, type, read: () => Promise.resolve(file.type === type ? file : new File([file], file.name, { type })) });
          } else {
            const path = (file as File & { path?: unknown }).path;
            if (typeof path === 'string' && /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(path)) paths.push(path);
            else missingPaths = true;
          }
        }
        if (media.length > 0) addFiles(media);
        const plain = browser?.text ?? '';
        if (latest.text !== draft.text) {
          if (plain !== '' || paths.length > 0 || media.length === 0) {
            setAttachmentError(t('composer.pasteDraftChanged'));
          }
          return;
        }
        let next = { text: draft.text, cursor: selection.start };
        if (plain !== '') {
          next = { text: draft.text.slice(0, selection.start) + plain + draft.text.slice(selection.end), cursor: selection.start + plain.length };
        }
        if (paths.length > 0) {
          next = insertDroppedPaths(next.text, plain === '' ? selection : { start: next.cursor, end: next.cursor }, paths);
        }
        if (next.text !== draft.text) {
          pushUndoSnapshot({ text: draft.text, cursor: selection.start });
          historyIndexRef.current = null;
          applyTextChange(next.text, next.cursor);
        }
        if (missingPaths) setAttachmentError(t('composer.pastePathUnavailable'));
      } catch (error) {
        if (ownsAttachmentResult()) setAttachmentError(errorText(locale, error));
      }
    };
    const chained = pasteQueueRef.current.then(run, run);
    pasteQueueRef.current = chained;
    return chained;
  };

  /**
   * Explicit Attach keeps its upload meaning for all files. The desktop shell
   * opens its native dialog; the browser uses a hidden input. Clipboard media
   * shares the same caps and chips, while ordinary pasted files insert paths.
   */
  const fileInputRef = useRef<HTMLInputElement>(null);
  const openAttachPicker = () => {
    if (disabled) return;
    if (host.pickFiles === undefined) {
      fileInputRef.current?.click();
      return;
    }
    void host.pickFiles()
      .then((files) => {
        if (files !== null && files.length > 0) addFiles(files);
      })
      .catch((error: unknown) => { if (ownsAttachmentResult()) setAttachmentError(errorText(locale, error)); });
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
  const insertNativeDrop = (paths: readonly string[]) => {
    if (!(queueEditing || messageEditing) || host.readDroppedFiles === undefined) {
      insertDroppedFilePaths(paths);
      return;
    }
    void host.readDroppedFiles(paths).then((result) => {
      if (!ownsAttachmentResult() || disabledRef.current) return;
      addFiles(result.media);
      insertDroppedFilePaths(result.paths);
    }).catch((error: unknown) => {
      if (ownsAttachmentResult()) setAttachmentError(errorText(locale, error));
    });
  };
  const insertDroppedFilePathsRef = useRef(insertNativeDrop);
  insertDroppedFilePathsRef.current = insertNativeDrop;

  /** The card's drop path; the seated composer also gets the column's drops. */
  const dropFiles = (files: readonly File[]) => {
    if (disabled || files.length === 0) return;
    const images = queueEditing || messageEditing ? files.filter((file) => ACCEPTED_IMAGE_MIMES.includes(file.type)) : [];
    if (images.length > 0) addFiles(readyAttachmentFiles(images));
    insertDroppedFilePaths(files.filter((file) => !images.includes(file)).map(droppedFilePath));
  };
  const dropFilesRef = useRef(dropFiles);
  dropFilesRef.current = dropFiles;
  // Non-null only when the shell seats this composer: a file released
  // anywhere on the conversation column lands here, and the card shows its
  // drop state for the whole drag.
  const seatFileDrop = useSeatFileDrop();
  const seatFileDropRef = useRef(seatFileDrop);
  seatFileDropRef.current = seatFileDrop;
  const registerSeatDrop = seatFileDrop?.registerDrop;
  useEffect(() => {
    if (registerSeatDrop === undefined) return;
    return registerSeatDrop((files) => { dropFilesRef.current(files); });
  }, [registerSeatDrop]);
  const dropHighlight = dragActive || seatFileDrop?.dragActive === true;

  // Desktop file drops: Tauri intercepts HTML5 drag-and-drop, so real drops
  // arrive through the host bridge carrying absolute paths. A drop on the
  // card inserts; the seated composer also takes one anywhere else on its
  // conversation column, unless another editor there (an inline message
  // edit) is under it. Drops outside the column stay inert.
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (host.onFileDrop === undefined) return;
    return host.onFileDrop((drop) => {
      const card = cardRef.current;
      if (card === null || drop.paths.length === 0) return;
      if (drop.position !== undefined) {
        const { x, y } = drop.position;
        const contains = (rect: DOMRect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
        if (!contains(card.getBoundingClientRect())) {
          const column = seatFileDropRef.current?.column ?? null;
          if (column === null || !contains(column.getBoundingClientRect())) return;
          const under = document.elementFromPoint(x, y)?.closest('[data-composer-card]');
          if (under !== null && under !== undefined && under !== card) return;
        }
      }
      insertDroppedFilePathsRef.current(drop.paths);
    });
  }, [host]);

  const submitWithSlashItems = (items: readonly SlashItem[], catalogAvailable: boolean, draftText = liveTextRef.current) => {
    const trimmed = draftText.trim();
    const classified = classifySlashSubmission(items, trimmed);
    const inlineMatches = skillActivationEnabled
      ? extractSlashSkillTokens(items, trimmed, { includeLeading: false }).activations
      : [];
    const allMatches = skillActivationEnabled
      ? extractSlashSkillTokens(items, trimmed, { includeLeading: true }).activations
      : [];
    if (classified !== null) {
      if (classified.kind === 'unknown' || classified.kind === 'disabled') {
        if (catalogAvailable || classified.kind === 'disabled') {
          setSlashConfirm({
            name: classified.kind === 'unknown' ? classified.name : classified.item.name,
            reason: classified.kind,
          });
          return;
        }
        const builtin = parseSlashDraft(trimmed);
        if (!skillCatalogReady && builtin?.query.toLowerCase() === 'kiki-ops' && onActivateSkill !== undefined) {
          activateSkill('kiki-ops', builtin.args);
          return;
        }
      } else {
        if (classified.item.kind === 'skill' && skillActivationEnabled) {
          if (inlineMatches.length === 0) {
            activateSkill(classified.item.skill?.name ?? classified.item.name, classified.args);
            return;
          }
          const skillsPayload: PromptSkillActivation[] = allMatches.map((match) => ({ name: match.skillName }));
          sendPrompt(
            trimmed,
            runMode === 'goal'
              ? { goalObjective: goalObjective !== '' ? goalObjective : trimmed, skills: skillsPayload }
              : { skills: skillsPayload },
          );
          setLocalGoalArmed(false);
          return;
        }
        if (classified.item.kind === 'plugin' && classified.item.pluginId !== undefined && classified.item.pluginAction !== undefined) {
          recordSubmission(true);
          onChange('');
          void executePluginSlotAction(
            {
              pluginId: classified.item.pluginId,
              label: `/${classified.item.name}`,
              action: classified.item.pluginAction,
              sessionId,
              workspaceId,
              args: classified.args,
            },
            `${classified.item.pluginId}:${classified.item.slotId ?? classified.item.name}`,
          );
          return;
        }
        if (classified.item.kind === 'action' && classified.item.action !== undefined) {
          // `/goal <text>` sends immediately with the args as `goal_objective`.
          // A bare `/goal` arms the next message when goal mode is available.
          if (classified.item.action === 'goal' && classified.args !== '') {
            const goalSkills = skillActivationEnabled
              ? extractSlashSkillTokens(items, classified.args, { includeLeading: true }).activations.map((match) => ({ name: match.skillName }))
              : [];
            sendPrompt(classified.args, {
              goalObjective: classified.args,
              skills: goalSkills.length > 0 ? goalSkills : undefined,
            });
            return;
          }
          // `/btw <question>` goes to a side agent; the main turn never sees it.
          if (classified.item.action === 'btw' && classified.args !== '' && onSideQuestion !== undefined) {
            recordSubmission(true);
            onChange('');
            onSideQuestion(classified.args);
            return;
          }
          if (classified.item.action === 'branch' && classified.args !== '' && onOpenBranch !== undefined) {
            recordSubmission(true);
            onChange('');
            onOpenBranch(classified.args);
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
    const inlineSkills: PromptSkillActivation[] | undefined = inlineMatches.length > 0
      ? inlineMatches.map((match) => ({ name: match.skillName }))
      : undefined;
    // Goal mode: the message itself becomes the objective unless the draft
    // carries an explicit one.
    sendPrompt(
      trimmed,
      runMode === 'goal'
        ? { goalObjective: goalObjective !== '' ? goalObjective : trimmed, skills: inlineSkills }
        : inlineSkills !== undefined
          ? { skills: inlineSkills }
          : undefined,
    );
    setLocalGoalArmed(false);
  };

  /** `now`: join the running turn instead of queueing behind it (plain prompts only). */
  const send = (now = false, timing?: DeferredAppendTiming) => {
    cancelDraftSyncTimer();
    const currentText = liveTextRef.current;
    const liveHasContent =
      currentText.trim() !== '' ||
      attachments.length > 0 ||
      (annotations !== undefined && annotations.length > 0) ||
      quoteItems.length > 0;
    const canSendLive = queueEditing || messageEditing
      ? liveHasContent && !disabled && !sendDisabled && !turnInFlight && !pendingAttachments
      : liveHasContent && !disabled && !sendDisabled && !selectionBlocked && !pendingAttachments && !ssh.pending && !turnInFlight && !slashCatalogPending;
    if (!canSendLive || slashCatalogPendingRef.current || composingRef.current) return;
    if (currentText !== localText) setLocalText(currentText);
    if (currentText !== normalizedPropValue) emitChange(currentText);
    sendNowRef.current = now && onSendNow !== undefined;
    sendTimingRef.current = timing;
    // Queue-edit mode: the draft IS a queued message's text. Confirming hands
    // it to the queue round-trip (in-place replace at the original slot) —
    // never to command classification, skill activation, or a fresh send.
    if (queueEditing || messageEditing) {
      setMenu(null);
      const edited = prepareThreadRefContext(currentText.trim(), threadRefDirectory.info, roomRefInfoOf);
      runAgentTurn(async () => {
        if (queueEditing) await onQueueEditConfirm?.(edited.text, attachments, edited.presentation);
        else await onSend(edited.text, attachments, { presentation: edited.presentation });
      });
      return;
    }
    // An open menu owns Enter: accept the highlighted row instead of sending,
    // and while a mention query is actively debouncing/loading, never ship the
    // unfinished raw `@query` text.
    if (menu !== null && menu.kind === 'mention' && mentionLoading) {
      const row = mentionRows[Math.min(activeIndex, mentionRows.length - 1)];
      if (row !== undefined && row.kind === 'agent' && row.candidate.available) {
        acceptMentionRow(row);
      }
      return;
    }
    if (menu !== null && menuRowCount > 0) {
      if (menu.kind === 'slash') {
        const item = filteredSlashItems[Math.min(activeIndex, filteredSlashItems.length - 1)];
        if (item !== undefined) acceptSlashItem(item);
      } else {
        const row = mentionRows[Math.min(activeIndex, mentionRows.length - 1)];
        if (row !== undefined) acceptMentionRow(row);
      }
      return;
    }
    setMenu(null);
    const trimmed = currentText.trim();
    const localSlash = classifySlashSubmission(slashItems, trimmed);
    const needsColdCatalog = (
      (localSlash !== null && localSlash.kind !== 'resolved') ||
      (skillActivationEnabled && hasInlineSlashCandidate(trimmed))
    ) && skillCatalogReady && !skillsQuery.isSuccess;
    if (needsColdCatalog) {
      const owner = sendOwnerKey(sessionId);
      const generation = slashGenerationRef.current + 1;
      slashGenerationRef.current = generation;
      slashFlightsRef.current.set(owner, generation);
      slashCatalogPendingRef.current = true;
      setSlashCatalogPending(true);
      void refetchSkills({ cancelRefetch: false }).then((result) => {
        if (!composerAliveRef.current || slashFlightsRef.current.get(owner) !== generation) return;
        slashFlightsRef.current.delete(owner);
        if (sendOwnerKey(sessionIdRef.current) !== owner) return;
        slashCatalogPendingRef.current = false;
        setSlashCatalogPending(false);
        const current = currentSlashDraftRef.current;
        if (liveTextRef.current !== currentText || current.skillScope !== skillScope) return;
        if (result.data === undefined) {
          setAttachmentError(t('composer.slash.submitCatalogFailed'));
          submitWithSlashItems(slashItems, true, currentText);
          return;
        }
        setAttachmentError((previous) => previous === t('composer.slash.submitCatalogFailed') ? null : previous);
        submitWithSlashItems(
          withoutUnhandledActions(
            withoutRefusedActions(
              buildSlashItems(result.data.skills, {
                hasSession: sessionId !== undefined,
                pluginSlots: pluginGuiSlots.slots,
                locale,
              }),
              engine,
            ),
            onSideQuestion !== undefined,
            onOpenBranch !== undefined,
          ),
          true,
          currentText,
        );
      });
      return;
    }
    submitWithSlashItems(slashItems, skillsQuery.isSuccess, currentText);
  };

  /**
   * Send-intent latch, owned by the session (or `/new` draft) that started
   * it. The map updates synchronously, so a second Enter in that same session
   * does not call `onSend` again. Switching away does not give the entry to
   * the next session, and switching back while the promise is open keeps this
   * session disabled. `busy` is the running turn, not this latch. The entry
   * is removed when its own promise settles — failure included — and only
   * when the generation still matches, so an older settle cannot release a
   * newer submit. The visible button updates only when that owner is the one
   * on screen. `canSend` reads the state twin.
   */
  const runAgentTurn = (turn: (flight: SendFlight) => Promise<void>) => {
    const owner = sendOwnerKey(sessionId);
    if (sendFlightsRef.current.has(owner)) return;
    const generation = sendGenerationRef.current + 1;
    sendGenerationRef.current = generation;
    const flight: SendFlight = { owner, generation };
    sendFlightsRef.current.set(owner, generation);
    turnInFlightRef.current = true;
    setTurnInFlight(true);
    void turn(flight)
      .catch((error: unknown) => {
        if (!submissionVisible(flight)) return;
        setAttachmentError(errorText(locale, error));
      })
      .finally(() => {
        if (!composerAliveRef.current || sendFlightsRef.current.get(flight.owner) !== flight.generation) return;
        sendFlightsRef.current.delete(flight.owner);
        if (sendOwnerKey(sessionIdRef.current) !== flight.owner) return;
        turnInFlightRef.current = false;
        setTurnInFlight(false);
      });
  };

  const sendPrompt = (
    content: string,
    options?: { readonly goalObjective?: string; readonly skills?: readonly PromptSkillActivation[] },
  ) => {
    // Keep the two-argument call shape for plain sends: existing callers and
    // test spies assert on exactly (text, attachments).
    const now = sendNowRef.current;
    sendNowRef.current = false;
    const timing = sendTimingRef.current;
    sendTimingRef.current = undefined;
    // The caret the send leaves behind is not the user's choice to keep
    // typing: a decision arriving after this send may take the card over.
    setInputFocused(false);
    // Linked threads ride along as a trailing <thread_refs> context block the
    // model reads; the transcript strips it back off and shows chips.
    const withContext = (prepared: string) => prepareThreadRefContext(
      prepared,
      threadRefDirectory.info,
      roomRefInfoOf,
    );
    // Hosts joined to a live session live on the server's session host list and
    // ride no message, so a send in a session carries exactly the draft's own
    // attachments. On /new there is no session yet: the preselected hosts ride
    // the create request, which joins them BEFORE the first prompt; the draft's
    // own send path splits them back out, so they never reach the message.
    const sentAttachments = sessionId === undefined && ssh.snapshot.length > 0
      ? [...attachments, ...ssh.snapshot]
      : attachments;
    const deliver = (raw: string) => {
      const prepared = withContext(raw);
      if (now && options?.goalObjective === undefined && onSendNow !== undefined) {
        if (options?.skills !== undefined) {
          return onSendNow(prepared.text, sentAttachments, prepared.presentation, options.skills);
        }
        return prepared.presentation === undefined ? onSendNow(prepared.text, sentAttachments)
          : onSendNow(prepared.text, sentAttachments, prepared.presentation);
      }
      const merged = timing === undefined && prepared.presentation === undefined ? options
        : { ...options, appendTiming: timing, presentation: prepared.presentation };
      return merged === undefined
        ? onSend(prepared.text, sentAttachments)
        : onSend(prepared.text, sentAttachments, merged);
    };
    const submittedText = liveTextRef.current;
    if (!vscodeRuntime) {
      runAgentTurn(async (flight) => {
        recordSubmission(submissionVisible(flight), submittedText);
        await deliver(content);
      });
      return;
    }
    // `preparePrompt` yields before the captured handler runs. The handler is
    // the one from the session that started the send; it is not retargeted at
    // whoever is on screen, and it is not dropped here. Resident draft
    // mutations wait until this flight is still that visible generation.
    runAgentTurn(async (flight) => {
      const prepared = await vscodeHost.preparePrompt(content, vscodeConversationId, true);
      recordSubmission(submissionVisible(flight), submittedText);
      await deliver(prepared);
    });
  };

  const activateSkill = (name: string, args: string) => {
    const submittedText = liveTextRef.current;
    const sentAttachments = sessionId === undefined && ssh.snapshot.length > 0
      ? [...attachments, ...ssh.snapshot]
      : attachments;
    if (!vscodeRuntime) {
      runAgentTurn(async (flight) => {
        recordSubmission(submissionVisible(flight), submittedText);
        await onActivateSkill?.(name, args, sentAttachments, submittedText);
      });
      return;
    }
    runAgentTurn(async (flight) => {
      await vscodeHost.preparePrompt('', vscodeConversationId, false);
      recordSubmission(submissionVisible(flight), submittedText);
      await onActivateSkill?.(name, args, sentAttachments, submittedText);
    });
  };

  /** "Send anyway" from the typo guard: plain prompt, no command resolution. */
  const confirmSendPlain = () => {
    if (!canSend) return;
    setSlashConfirm(null);
    setMenu(null);
    sendPrompt(text.trim());
  };

  // ---- send-timing menu (busy only) ----
  // While the agent is working, hovering the send button floats a small menu
  // above it: the plain send (its hint names the session's configured default
  // timing), send-now into the running turn, and the deferred queue timings.
  // Where a busy plain send already steers (`busySendsNow`), the menu leads
  // with Send now and offers all three deferred queue timings (`agent_idle`,
  // `subagents_done`, `tasks_done`). A pick fires ONCE — it never rewrites the
  // configured default. The menu stays closed while idle (every timing starts
  // immediately, so the choice would be noise) and in queue-edit mode (the
  // button is the edit's confirm).
  // Auto-scroll the context shelf to reveal newly added attachment tiles.
  const contextShelfRef = useRef<HTMLDivElement | null>(null);
  const prevAttachmentCountRef = useRef(payloadAttachments.length);
  useEffect(() => {
    const prevCount = prevAttachmentCountRef.current;
    prevAttachmentCountRef.current = payloadAttachments.length;
    if (payloadAttachments.length > prevCount) {
      const shelf = contextShelfRef.current;
      if (shelf !== null && shelf.scrollWidth > shelf.clientWidth) {
        shelf.scrollLeft = shelf.scrollWidth;
      }
    }
  }, [payloadAttachments.length]);

  const sendTimingRootRef = useRef<HTMLDivElement | null>(null);
  const sendTimingPanelRef = useRef<HTMLDivElement | null>(null);
  const sendButtonRef = useRef<HTMLButtonElement | null>(null);
  const sendTimingCaretRef = useRef<HTMLButtonElement | null>(null);
  const sendTimingTriggerRef = useRef<'send' | 'caret'>('send');
  const sendTimingMenuId = useId();
  const [sendTimingOpen, setSendTimingOpen] = useState(false);
  useEffect(() => subscribeFloatingGroup(COMPOSER_FLOATING_GROUP, 'composer-send-timing', () => {
    setSendTimingOpen(false);
  }), []);
  useEffect(() => {
    if (sendTimingOpen) notifyFloatingGroupOpen(COMPOSER_FLOATING_GROUP, 'composer-send-timing', sendTimingRootRef.current);
  }, [sendTimingOpen]);
  const sendTimingOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendTimingCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Where keyboard-opened focus lands once the menu renders. */
  const sendTimingFocusRef = useRef<'first' | 'last' | null>(null);
  const sendTimingAvailable =
    sendTimingDefault !== undefined && !queueEditing && !messageEditing && canSend && !takenOver;
  // A pending engine/profile switch cannot join the running turn (the active
  // turn cannot rebind), so "send now" silently degrades to an ordinary queue
  // entry. While one is pending, name the real result where the choice is
  // made: the timing menu omits the send-now row (same omission as an unwired
  // steer path), the button title says the message queues and carries the
  // switch, and the working-line hint is omitted too — its "sends now"
  // wording would promise what the key no longer does. The pending chip
  // beside it already names the switch, and the ⌘/Ctrl+Enter path itself
  // keeps working: it queues.
  const sendNowDegrades = executionPending || pendingRuntimeControls?.model !== undefined;

  const clearSendTimingTimers = () => {
    if (sendTimingOpenTimerRef.current !== null) {
      clearTimeout(sendTimingOpenTimerRef.current);
      sendTimingOpenTimerRef.current = null;
    }
    if (sendTimingCloseTimerRef.current !== null) {
      clearTimeout(sendTimingCloseTimerRef.current);
      sendTimingCloseTimerRef.current = null;
    }
  };
  const closeSendTiming = (refocus = false) => {
    clearSendTimingTimers();
    setSendTimingOpen(false);
    if (refocus) {
      const trigger = sendTimingTriggerRef.current === 'caret' ? sendTimingCaretRef.current : sendButtonRef.current;
      (trigger ?? sendButtonRef.current)?.focus();
    }
  };
  const cancelPendingSendTimingOpen = () => {
    if (sendTimingOpenTimerRef.current !== null) {
      clearTimeout(sendTimingOpenTimerRef.current);
      sendTimingOpenTimerRef.current = null;
    }
  };
  // Hover intent: a short delay keeps a sweep across the button from flashing
  // the menu; a slightly longer leave grace bridges the gap into the panel.
  const openSendTimingOnHover = () => {
    if (!sendTimingAvailable) return;
    if (sendTimingCloseTimerRef.current !== null) {
      clearTimeout(sendTimingCloseTimerRef.current);
      sendTimingCloseTimerRef.current = null;
    }
    if (sendTimingOpen) return;
    sendTimingOpenTimerRef.current ??= setTimeout(() => {
      sendTimingOpenTimerRef.current = null;
      setSendTimingOpen(true);
    }, 180);
  };
  const closeSendTimingOnLeave = () => {
    if (sendTimingOpenTimerRef.current !== null) {
      clearTimeout(sendTimingOpenTimerRef.current);
      sendTimingOpenTimerRef.current = null;
    }
    if (!sendTimingOpen) return;
    // Focus inside the root means a keyboard user owns the menu; the pointer
    // leaving must not strand that focus by closing under it.
    if (
      sendTimingRootRef.current?.contains(document.activeElement) === true
      || sendTimingPanelRef.current?.contains(document.activeElement) === true
    ) return;
    sendTimingCloseTimerRef.current = setTimeout(() => {
      sendTimingCloseTimerRef.current = null;
      setSendTimingOpen(false);
    }, 250);
  };
  const onSendTimingBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!sendTimingOpen) return;
    const next = event.relatedTarget;
    if (
      next instanceof Node
      && (sendTimingRootRef.current?.contains(next) === true || sendTimingPanelRef.current?.contains(next) === true)
    ) return;
    setSendTimingOpen(false);
  };
  // The menu-button key contract: ↑/↓ on the resting send button opens the
  // menu and lands on the first/last row; once open, usePopover's handler on
  // the root walks rows and Escape refocuses the button.
  const onSendTimingButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>, source: 'send' | 'caret' = 'send') => {
    if (!sendTimingAvailable || sendTimingOpen) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    sendTimingTriggerRef.current = source;
    sendTimingFocusRef.current = event.key === 'ArrowUp' ? 'last' : 'first';
    setSendTimingOpen(true);
  };
  const sendTimingKeys = usePopover(sendTimingOpen, closeSendTiming, sendTimingRootRef, 'composer-send-timing', sendTimingPanelRef);
  useEffect(() => {
    if (sendTimingAvailable || !sendTimingOpen) return;
    clearSendTimingTimers();
    setSendTimingOpen(false);
  }, [sendTimingAvailable, sendTimingOpen]);
  const focusSendTimingPanel = useCallback((panel: HTMLElement | null) => {
    if (panel === null || sendTimingFocusRef.current === null) return;
    const rows = [...panel.querySelectorAll<HTMLElement>('[data-menu-row]:not(:disabled)')];
    if (rows.length === 0) return;
    const target = sendTimingFocusRef.current === 'last' ? rows.at(-1) : rows[0];
    sendTimingFocusRef.current = null;
    target?.focus();
  }, []);
  const attachSendTimingPanelRef = useCallback((node: HTMLDivElement | null) => {
    sendTimingPanelRef.current = node;
    if (node !== null) focusSendTimingPanel(node);
  }, [focusSendTimingPanel]);
  useEffect(() => {
    if (!sendTimingOpen || sendTimingFocusRef.current === null) return;
    focusSendTimingPanel(sendTimingPanelRef.current);
  }, [sendTimingOpen, focusSendTimingPanel]);
  useEffect(() => clearSendTimingTimers, []);

  /** Recompute the trigger-driven menu after any text/caret change. */
  const refreshMenu = (nextText: string, cursor: number) => {
    if (composingRef.current) return;
    if (
      menu === null &&
      dismissedTriggerRef.current === null &&
      !nextText.includes('/') &&
      !nextText.includes('@')
    ) {
      return;
    }
    const dismissed = dismissedTriggerRef.current;
    const slashTrigger = parseSlashTrigger(nextText, cursor);
    if (slashTrigger !== null) {
      if (
        dismissed !== null &&
        dismissed.kind === 'slash' &&
        dismissed.start === slashTrigger.start &&
        dismissed.query === slashTrigger.query
      ) {
        setMenu(null);
        return;
      }
      dismissedTriggerRef.current = null;
      setMenu({ kind: 'slash', ...slashTrigger });
      return;
    }
    if (fsSearch !== undefined) {
      const trigger = parseMentionTrigger(nextText, cursor);
      if (trigger !== null) {
        if (
          dismissed !== null &&
          dismissed.kind === 'mention' &&
          dismissed.start === trigger.start &&
          dismissed.query === trigger.query
        ) {
          setMenu(null);
          return;
        }
        dismissedTriggerRef.current = null;
        setMenu({ kind: 'mention', start: trigger.start, query: trigger.query });
        return;
      }
    }
    dismissedTriggerRef.current = null;
    setMenu(null);
  };

  const onKeyDown = (event: globalThis.KeyboardEvent) => {
    // IME composition owns every key while it is open — Enter/Tab/arrows/
    // Escape all belong to the candidate window. Intercepting them (the menu
    // branches below used to run first) eats the commit key and leaves the
    // half-committed text stranded. keyCode 229 covers engines that skip the
    // isComposing flag on keydown.
    if (composingRef.current || event.isComposing || event.keyCode === 229) return;
    // A thread or agent link deletes as one token: Backspace/Delete touching
    // it (or a selection overlapping it) takes the whole link.
    if ((event.key === 'Backspace' || event.key === 'Delete') && !event.altKey) {
      const node = textareaRef.current;
      if (node === null) return;
      const currentText = liveTextRef.current;
      if (currentText.includes('/') || currentText.includes('[[')) {
        const range = threadRefDeletionRange(currentText, node.selectionStart, node.selectionEnd, event.key);
        if (range !== null) {
          event.preventDefault();
          pushUndoSnapshot({ text: currentText, cursor: node.selectionStart });
          historyIndexRef.current = null;
          const next = removeThreadRef(currentText, range);
          applyTextChange(next.text, next.cursor);
          refreshMenu(next.text, next.cursor);
          return;
        }
      }
      if (currentText.includes('@')) {
        const agentRange = agentRefDeletionRange(currentText, node.selectionStart, node.selectionEnd, event.key);
        if (agentRange !== null) {
          event.preventDefault();
          pushUndoSnapshot({ text: currentText, cursor: node.selectionStart });
          historyIndexRef.current = null;
          const next = removeAgentRef(currentText, agentRange);
          applyTextChange(next.text, next.cursor);
          refreshMenu(next.text, next.cursor);
          return;
        }
      }
    }
    if (menu !== null && menuRowCount > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        setActiveIndex((index) => {
          for (let step = 1; step <= menuRowCount; step += 1) {
            const candidate = ((index + delta * step) % menuRowCount + menuRowCount) % menuRowCount;
            if (!isMenuRowDisabled(candidate)) return candidate;
          }
          return Math.min(Math.max(index, 0), menuRowCount - 1);
        });
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        if (menu.kind === 'slash') {
          const item = filteredSlashItems[Math.min(activeIndex, filteredSlashItems.length - 1)];
          if (item !== undefined) acceptSlashItem(item);
        } else {
          const row = mentionRows[Math.min(activeIndex, mentionRows.length - 1)];
          if (row !== undefined) acceptMentionRow(row);
        }
        return;
      }
    }
    if (event.key === 'Escape' && menu !== null) {
      event.preventDefault();
      dismissedTriggerRef.current = { kind: menu.kind, start: menu.start, query: menu.query };
      setMenu(null);
      return;
    }
    if (event.key === 'Escape' && exitHistoryRecall()) {
      event.preventDefault();
      return;
    }
    // Queue-edit mode: Escape hands the pre-edit draft back (one Esc per
    // layer — an open menu or history browse above eats its own first).
    if (event.key === 'Escape' && (queueEditing || messageEditing)) {
      event.preventDefault();
      if (!turnInFlight) onQueueEditCancel?.();
      return;
    }
    // The Mode menu and composer-local undo/redo (the controlled value defeats
    // the native textarea undo stack, so these walk our snapshot lane) use
    // the saved chords: ⌘/Ctrl+Shift+M and ⌘/Ctrl+Z / ⌘/Ctrl+Shift+Z by default.
    const chordEvent = {
      key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey,
      altKey: event.altKey, isComposing: event.isComposing, target: event.target,
    };
    if (variant !== 'subagent' && matchesShortcutAction(chordEvent, 'composer-mode')) {
      event.preventDefault();
      setAddView('mode');
      return;
    }
    if (matchesShortcutAction(chordEvent, 'composer-redo')) {
      event.preventDefault();
      redoEdit();
      return;
    }
    if (matchesShortcutAction(chordEvent, 'composer-undo')) {
      event.preventDefault();
      undoEdit();
      return;
    }
    if (messageEditing) {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
        event.preventDefault();
        send();
      }
      return;
    }
    // History recall lives strictly below the menu branches: an open slash or
    // mention menu keeps owning ↑/↓ exactly as before.
    if (
      (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
      menu === null &&
      !event.shiftKey &&
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
    // Enter semantics come from Settings (composerEnterAction): the default
    // sends with Enter (queued while busy) and sends into the running turn
    // with ⌘/Ctrl+Enter; the alternative keeps Enter as a new line.
    const enterAction = composerEnterAction(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        isComposing: event.isComposing,
        keyCode: event.keyCode,
      },
      sendShortcut,
    );
    if (coarsePointer && enterAction === 'send') {
      // A software keyboard's Enter is the newline key; only ⌘/Ctrl+Enter
      // (a hardware keyboard on a tablet) still sends from the keyboard.
      return;
    }
    if (enterAction === 'send' || enterAction === 'send-now') {
      event.preventDefault();
      send(enterAction === 'send-now' && busy);
    }
  };

  const effectiveModel = bindingSetting?.model ?? validatingModel;
  const statusModel = bindingSetting === undefined ? selectedModel : resolveCatalogModel(models, bindingSetting.model);
  const statusEffort = bindingSetting?.thinking === null ? statusModel?.default_effort : bindingSetting?.thinking ?? effort;
  // The status line names the model by its catalog display name (the inherit
  // source and provider live in the picker and the tooltip).
  const modelShortLabel =
    statusModel?.display_name ??
    (externalExecution ? effectiveModel : stripModelProviderPrefix(effectiveModel));
  // The queued switch names its target the same way the picker does.
  const pendingSwitchChange = pendingModelSwitch === undefined ? undefined : pendingModelSwitchChange({
    ...pendingModelSwitch,
    from: pendingModelSwitch.from === undefined ? undefined : resolveCatalogModel(models, pendingModelSwitch.from)?.id ?? pendingModelSwitch.from,
    to: resolveCatalogModel(models, pendingModelSwitch.to)?.id ?? pendingModelSwitch.to,
  });
  const pendingSwitchEffort = pendingModelSwitch?.targetThinking === null
    ? t('composer.execution.defaultEffort') : pendingModelSwitch?.targetThinking;
  const pendingSwitchLabel = pendingModelSwitch === undefined ? undefined
    : pendingSwitchChange === 'effort' ? pendingSwitchEffort
      : resolveCatalogModel(models, pendingModelSwitch.to)?.display_name ?? pendingModelSwitch.to;
  const pendingSwitchPrefix = pendingSwitchChange === 'model' ? 'modelSwitch.pendingChipPrefix'
    : `modelSwitch.pendingChipPrefix.${pendingSwitchChange}` as I18nKey;
  const pendingSwitchLine = pendingSwitchChange === 'model' ? 'modelSwitch.pendingLine'
    : `modelSwitch.pendingLine.${pendingSwitchChange}` as I18nKey;
  const pendingRuntimeControlParts = pendingRuntimeControls === undefined ? [] : [
    pendingRuntimeControls.profile,
    pendingRuntimeControls.model === undefined ? undefined : resolveCatalogModel(models, pendingRuntimeControls.model)?.display_name ?? pendingRuntimeControls.model,
    pendingRuntimeControls.thinking,
  ].filter((value): value is string => value !== undefined && value !== '');

  // Focus continuity across a busy flip: becoming `disabled` force-blurs the
  // textarea (platform behavior), which used to be invisible because the
  // composer remounted on route changes anyway. With the resident shell seat
  // the node survives — so a blur CAUSED by the disable (element already
  // disabled at blur time) arms a one-shot refocus when the composer
  // re-enables. The focusin that lands on the document is that platform
  // fallback, so it does not cancel the arm; a focusin on any other control
  // does. A deliberate click-away while enabled never arms it, and a cold
  // session open (never focused) has nothing to restore.
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
    const cancelOnFocusElsewhere = (event: globalThis.FocusEvent) => {
      const target = event.target;
      if (target === textarea.element || target === document.body || target === document.documentElement) return;
      refocusOnEnableRef.current = false;
    };
    textarea.element.addEventListener('blur', armOnDisableBlur);
    document.addEventListener('focusin', cancelOnFocusElsewhere);
    return () => {
      textarea.element.removeEventListener('blur', armOnDisableBlur);
      document.removeEventListener('focusin', cancelOnFocusElsewhere);
    };
  }, []);
  useEffect(() => {
    if (disabled || !refocusOnEnableRef.current) return;
    refocusOnEnableRef.current = false;
    if (document.activeElement === document.body) textareaRef.current?.focus();
  }, [disabled]);

  const confirmContextRebuild = () => {
    if (onRebuildContext === undefined || contextRebuildBusy) return;
    setContextRebuildBusy(true);
    void onRebuildContext()
      .then((result) => {
        if (rebuildOwnerRef.current !== rebuildOwner) return;
        pushToast({
          tone: 'success',
          text: t(result.changed ? 'profile.rebuildDoneChanged' : 'profile.rebuildDoneUnchanged'),
        });
      })
      .catch((error: unknown) => {
        if (rebuildOwnerRef.current !== rebuildOwner) return;
        pushToast({
          tone: 'error',
          text: t('profile.rebuildFailed', {
            detail: error instanceof Error ? error.message : String(error),
          }),
        });
      })
      .finally(() => {
        if (rebuildOwnerRef.current !== rebuildOwner) return;
        setContextRebuildBusy(false);
        setContextRebuildConfirm(false);
      });
  };

  const runModeControls: RunModeControls = {
    runMode,
    onChangeRunMode: changeRunMode,
    goalAvailable: onChangeGoalMode !== undefined || onChangeGoalObjective !== undefined,
    planGateFree: planGate === undefined || onChangePlanGate === undefined ? undefined : planGate === 'free',
    onChangePlanGateFree: onChangePlanGate === undefined ? undefined : (free) => { onChangePlanGate(free ? 'free' : 'gated'); },
    permissionMode,
    goalObjective: onChangeGoalObjective !== undefined ? goalObjective : undefined,
    onChangeGoalObjective,
  };

  // A picked persona rides the chip (personaPick.value) on /new; the panel
  // behind it offers both execution profiles and direct persona selection,
  // while the persona's own manager is reached from its dedicated surface.
  const pickedPersona = personaPick?.value;

  const contextRatio = contextUsage !== undefined && contextUsage.used !== undefined && contextUsage.limit > 0
    ? contextUsage.used / contextUsage.limit
    : 0;
  const keepContextOnNarrow = contextUsage !== undefined && (
    contextRatio >= 0.6 || (compactAvailability !== undefined && compactAvailability.available === false && compactAvailability.reason !== undefined)
  );
  const toolbarCrowded = (busy && canSend && !queueEditing && !messageEditing && onAbort !== undefined)
    || (keepContextOnNarrow && runMode !== 'normal');

  // The status line under the input: ordered segments, each a quiet trigger
  // for its own picker. Order and grouping live only in this list.
  const statusSegments: { key: string; node: ReactNode }[] = [];
  if (variant !== 'subagent') {
    const chip = (
      <RunModeChip
        runMode={runMode}
        compact={toolbarCrowded}
        onOpen={() => { setAddView('mode'); }}
        onClear={() => { changeRunMode('normal'); }}
      />
    );
    if (runMode !== 'normal') statusSegments.push({ key: 'run-mode', node: chip });
  }
  if (onChangeExecution !== undefined && execution !== undefined) {
    statusSegments.push({
      key: 'profile',
      node: (
        <ComposerPanelOrigin className="flex min-w-0 max-w-full items-center [&>div]:min-w-0">
          <ProfileSelect
            choice={execution}
            pending={executionPending || pendingRuntimeControls !== undefined}
            busy={busy}
            disabled={variant === 'subagent' && disabled}
            onChange={(next) => {
              if (pickedPersona !== undefined) personaPick?.onChange(undefined);
              onChangeExecution(next);
            }}
            catalog={executorCatalog}
            profiles={agentProfilesQuery.data?.items ?? []}
            catalogMode={agentProfileCatalogMode}
            pickableProfile={isConversationProfile}
            nativeLabel={t('composer.agentDefaultName')}
            persona={pickedPersona === undefined ? undefined : {
              id: pickedPersona.id,
              name: pickedPersona.name,
              avatar: <PersonaAvatar persona={pickedPersona} size={20} decorative className="!rounded-full" />,
            }}
            onClearPersona={pickedPersona === undefined ? undefined : () => { personaPick?.onChange(undefined); }}
            onSelectPersona={personaPick === undefined ? undefined : (id) => {
              personaPick.onChange(id);
            }}
            onCancelPending={executionPending ? onCancelExecution : pendingRuntimeControls !== undefined ? onCancelRuntimeControls : undefined}
            boundExecution={boundExecution}
            onPicked={focusEditorAfterPick}
          />
        </ComposerPanelOrigin>
      ),
    });
    statusSegments.push({
      key: 'execution',
      node: (
        <ComposerPanelOrigin className="flex min-w-0 max-w-full items-center [&>div]:min-w-0">
          <ExecutionSelect
            choice={execution}
            pending={executionPending || pendingRuntimeControls !== undefined}
            busy={busy}
            disabled={variant === 'subagent' && disabled}
            onChange={(next) => {
              if (next.profile === undefined && next.profile_file === undefined) {
                personaPick?.onChange(undefined);
              }
              onChangeExecution(next);
            }}
            catalog={executorCatalog}
            profiles={agentProfilesQuery.data?.items ?? []}
            nativeLabel={t('composer.agentDefaultName')}
            models={models}
            modelOptions={modelOptions}
            currentModel={bindingSetting?.model ?? (externalExecution ? validatingModel : normalizedModel)}
            effectiveModel={effectiveModel}
            modelShortLabel={modelShortLabel}
            modelSource={modelSource}
            currentEffort={statusEffort}
            efforts={externalExecution ? executorEfforts : efforts}
            onChangeModel={(next) => {
              if (externalExecution) return writeExecutorModel(next);
              const state = projectedProfileModelState(modelProjection, models, next ?? selectionDefaultModel ?? serverDefaultModel, modelSelectionPosition);
              if (state === 'blocked') return;
              return onChangeModel(next);
            }}
            onChangeEffort={onChangeEffort}
            executorResponse={executorModelResponse}
            modelThinkingLevels={executorModelThinkingLevels}
            executorRefreshBusy={executorRefreshCurrent && executorRefresh.isPending}
            executorRefreshFailed={executorRefreshCurrent && executorRefresh.isError}
            onRefreshExecutorModels={() => { executorRefresh.mutate({ id: executorId!, key: executorModelsKey }); }}
            domainNote={modelDomainState === 'warning' ? t('selection.modelMenuWarning', { source: modelRuleSource }) : undefined}
            openSignal={modelMenuSignal}
            onPicked={focusEditorAfterPick}
          />
        </ComposerPanelOrigin>
      ),
    });
    const compactAgentLabel = pickedPersona?.name
      ?? (execution.profile !== undefined && execution.profile !== '' && execution.profile !== 'agent'
        ? execution.profile
        : t('composer.agentDefaultName'));
    const compactEfforts = externalExecution ? executorEfforts : efforts;
    const compactEffortValue = isNativeExecutor(execution.executor)
      ? statusEffort
      : (execution.overrides?.thinking ?? undefined);
    const compactEffortLabel =
      compactEffortValue !== undefined &&
      compactEffortValue !== '' &&
      (compactEfforts === undefined || compactEfforts.length > 0)
        ? formatThinkingEffortWord(compactEffortValue, t)
        : undefined;
    const compactIdentityLabel = [compactAgentLabel, modelShortLabel]
      .filter((part): part is string => part !== undefined && part !== '')
      .join(' · ');
    const compactFullLabel = [compactIdentityLabel, compactEffortLabel]
      .filter((part): part is string => part !== undefined && part !== '')
      .join(' · ');
    const compactLeadingIcon = pickedPersona !== undefined ? (
      <PersonaAvatar persona={pickedPersona} size={16} decorative className="!rounded-full shrink-0" />
    ) : (
      <Icon
        name={resolveProfileIcon({
          profile: execution.profile,
          executor: execution.executor,
          main: variant !== 'subagent',
          hasFile: execution.profile_file !== undefined,
        })}
        size={14}
        className={`shrink-0 ${STATUS_SEGMENT_ICON_CLASS}`}
      />
    );
    const profileSegmentNode = statusSegments.at(-2)?.node;
    const executionSegmentNode = statusSegments.at(-1)?.node;
    statusSegments.push({
      key: 'compact-model',
      node: (
        <CompactModelSheet
          icon={compactLeadingIcon}
          label={compactIdentityLabel}
          effortLabel={compactEffortLabel}
          title={compactFullLabel}
          ariaLabel={compactFullLabel}
          profileNode={profileSegmentNode}
          executionNode={executionSegmentNode}
        />
      ),
    });
  }
  if (execution === undefined && !isExternalClient) {
    statusSegments.push({
      key: 'model',
      node: externalExecution && variant !== 'subagent' ? (
        <ExternalModelChoice
          key={executorModelsKey.join('\0')}
          choice={{ ...selectedExecution, overrides: { ...selectedExecution.overrides, model: validatingModel } }}
          engineLabel={engineLabel(executorId!, executorId!, executorCatalog)}
          executorResponse={executorModelResponse}
          executorRefreshBusy={executorRefreshCurrent && executorRefresh.isPending}
          executorRefreshFailed={executorRefreshCurrent && executorRefresh.isError}
          onRefreshExecutorModels={() => { executorRefresh.mutate({ id: executorId!, key: executorModelsKey }); }}
          onChange={(next) => {
            if (onChangeExecution !== undefined) onChangeExecution({ ...selectedExecution, overrides: { ...selectedExecution.overrides, model: next ?? null, thinking: next === undefined ? null : selectedExecution.overrides?.thinking } });
            else void onChangeModel(next);
          }}
        />
      ) : (
        <ModelChip
          modelOptions={externalExecution ? executorModelOptions : modelOptions}
          hasCatalog={externalExecution ? executorModelWritable : engine === undefined && models.length > 0}
          engineLabel={externalExecution && !executorModelWritable ? engineLabel(executorId!, executorId!, executorCatalog) : engine?.label}
          executorLabel={externalExecution ? engineLabel(executorId!, executorId!, executorCatalog) : undefined}
          openSignal={modelMenuSignal}
          model={bindingSetting?.model ?? (externalExecution ? validatingModel : model)}
          resolvedModelKey={bindingSetting === undefined ? resolvedModelKey : statusModel?.id}
          effectiveModel={effectiveModel}
          shortLabel={modelShortLabel}
          modelSource={modelSource}
          disabled={variant === 'subagent' && disabled}
          onChangeModel={(next) => {
            if (externalExecution) return writeExecutorModel(next);
            const state = projectedProfileModelState(modelProjection, models, next ?? selectionDefaultModel ?? serverDefaultModel, modelSelectionPosition);
            if (state === 'blocked') return;
            return onChangeModel(next);
          }}
          efforts={externalExecution ? executorEfforts : efforts}
          effort={statusEffort}
          onChangeEffort={onChangeEffort}
          domainNote={modelDomainState === 'warning' ? t('selection.modelMenuWarning', { source: modelRuleSource }) : undefined}
        />
      ),
    });
  }
  if (bindingSetting !== undefined) {
    statusSegments.push({
      key: 'binding-setting',
      node: <span data-binding-setting={bindingSetting.state} className="flex min-w-0 items-center gap-1 text-[11px] text-ink-faint" title={bindingSetting.error}>
        {t(`modelSwitch.setting.${bindingSetting.state}`)}
        {bindingSetting.onRetry !== undefined ? <button type="button" className="underline" onClick={bindingSetting.onRetry}>{t('common.retry')}</button> : null}
      </span>,
    });
  }
  if (pendingModelSwitch !== undefined) {
    statusSegments.push({
      key: 'model-switch',
      node: (
        <span
          data-model-switch-pending={pendingModelSwitch.mode}
          title={`${t(pendingSwitchPrefix)}${pendingSwitchLabel} — ${t('modelSwitch.pendingChipTitle')}`}
          // A narrow composer drops this chip entirely and says the same thing
          // in words above the input instead of clipping it to "fixture/…".
          className="@max-[30rem]/composer:hidden flex h-7 max-w-56 min-w-0 items-center px-1.5 text-[12px] font-medium text-accent-ink"
        >
          {/* The width cap matches the model chip's, so a long target id
              truncates where the model beside it would. */}
          <span className="truncate">
            {t(pendingSwitchPrefix)}
            {pendingSwitchLabel}
          </span>
        </span>
      ),
    });
  }
  if (execution === undefined && pendingRuntimeControls !== undefined && pendingRuntimeControlParts.length > 0) {
    const label = pendingRuntimeControlParts.join(' · ');
    statusSegments.push({
      key: 'runtime-controls-pending',
      node: (
        <span
          data-runtime-controls-pending
          title={pendingRuntimeControls.model !== undefined || pendingRuntimeControls.thinking !== undefined
            ? t('modelSwitch.pendingChipTitle')
            : t('composer.execution.pendingTitle')}
          className="flex h-7 max-w-64 min-w-0 items-center gap-1 px-1.5 text-[12px] font-medium text-accent-ink"
        >
          <span className="min-w-0 truncate">{t('composer.execution.pendingSuffix', { name: label })}</span>
          {onCancelRuntimeControls !== undefined ? (
            <button
              type="button"
              data-runtime-controls-cancel
              aria-label={t('modelSwitch.action.cancel')}
              title={t('modelSwitch.action.cancel')}
              onClick={onCancelRuntimeControls}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none pointer-coarse:h-8 pointer-coarse:w-8"
            >
              <Icon name="close" size={12} />
            </button>
          ) : null}
        </span>
      ),
    });
  }
  if (variant !== 'subagent' || (!disabled && !externalExecution)) {
    statusSegments.push({
      key: 'permission',
      node: (
        <PermissionSelect
          open={modeOpen}
          compact={toolbarCrowded}
          onOpenChange={setModeOpen}
          value={permissionMode}
          onChange={onChangePermissionMode}
          nativeAutoPermission={nativeAutoPermission}
        />
      ),
    });
    if (variant !== 'subagent' && sessionId !== undefined) {
      statusSegments.push({
        key: 'output-layer',
        node: <OutputLayerSelect sessionId={sessionId} />,
      });
    }
  }

  return (
    <ComposerCardContext.Provider value={cardRef}>
    <div className="@container/composer-shell w-full min-w-0">
    <div className="group/composer px-3 pb-3 @[560px]/composer-shell:px-6 @[560px]/composer-shell:pb-5" data-composer-variant={variant}>
      {composerContextMenu}
      {ssh.dialog}
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
      <div className="@container/composer mx-auto w-full min-w-0 max-w-[var(--kiki-chat-content-width,760px)]">
        {variant === 'subagent' && replyingTo !== undefined ? (
          <p data-composer-replying-to className="mb-1.5 truncate px-1 text-[12px] text-ink-faint">
            {t('composer.replyingTo', { agent: replyingTo })}
          </p>
        ) : null}
        {modelSwitchError !== undefined ? (
          <p data-model-switch-error className="mb-1.5 flex flex-wrap items-center gap-2 px-1 text-[12px] leading-snug text-danger">
            <span className="min-w-0 break-words" title={modelSwitchError.detail}>
              {t('modelSwitch.listFailed')}
            </span>
            <button
              type="button"
              onClick={modelSwitchError.onRetry}
              className="shrink-0 rounded-full border border-hairline px-2 py-0.5 font-medium text-ink-soft transition-colors hover:border-accent hover:text-ink pointer-coarse:h-8"
            >
              {t('common.retry')}
            </button>
          </p>
        ) : null}
        {/* A queued switch is named in words here while the toolbar is too
            narrow to say it: the model that is on its way matters more than the
            one already bound, and a wrapped line beats a clipped label. */}
        {pendingModelSwitch !== undefined ? (
          <p
            data-model-switch-pending-line={pendingModelSwitch.mode}
            className="mb-1.5 flex items-start gap-1.5 px-1 text-[12px] leading-snug text-accent-ink @min-[30rem]/composer:hidden"
          >
            <Icon name="arrowRight" size={12} className="mt-[3px]" />
            <span className="min-w-0 break-words">
              {t(pendingSwitchLine, {
                model: pendingSwitchLabel ?? pendingModelSwitch.to,
                effort: pendingSwitchEffort ?? '',
                mode: t(`modelSwitch.modeName.${pendingModelSwitch.mode}` as I18nKey),
              })}
            </span>
          </p>
        ) : null}
        {selectionBlocked || selectionCatalogError !== null ? <div data-selection-diagnostic role={selectionBlocked ? 'alert' : 'status'} className="mb-2 max-h-[min(10rem,25dvh)] space-y-1 overflow-y-auto overscroll-contain break-words rounded-lg border border-hairline bg-paper px-3 py-2 text-[11.5px] text-danger">
          {selectionCatalogError !== null ? <p className="max-h-20 overflow-y-auto overscroll-contain break-words">{t('selection.catalogError', { detail: selectionCatalogError.message })}</p> : null}
          {invalidProfile ? (
            <div className="flex flex-wrap items-center gap-2">
              <p>{t('selection.profileInvalid', { value: agentProfile! })}</p>
              {onChangeExecution !== undefined && execution !== undefined ? (
                <button
                  type="button"
                  data-reset-invalid-profile
                  className="underline"
                  onClick={() => {
                    onChangeExecution({ ...execution, profile: undefined, profile_file: undefined });
                  }}
                >
                  {t('composer.agentDefaultName')}
                </button>
              ) : null}
            </div>
          ) : null}
          {invalidModel ? (
            <p>
              {/* The sentence is the recovery: it opens the model chip's own
                  menu, which already lists the catalog that just loaded. */}
              <button type="button" className="underline" onClick={() => { setModelMenuSignal((n) => n + 1); }}>
                {t('selection.modelInvalid', { value: validatingModel! })}
              </button>
            </p>
          ) : null}
          {invalidModelDomain ? (
            <div className="flex flex-wrap items-center gap-2">
              <p data-model-menu-blocked>{modelDomainState === 'unknown'
                ? t(frozenMenuQuery.isPending ? 'selection.modelMenuPending' : 'selection.modelMenuError')
                : t('selection.modelMenuBlocked', { source: modelRuleSource })}</p>
              {modelDomainState === 'blocked' ? (
                <>
                  {normalizedModel !== undefined && projectedProfileModelState(modelProjection, models, selectionDefaultModel ?? normalizedServerDefaultModel, modelSelectionPosition) !== 'blocked' ? (
                    <button
                      type="button"
                      data-reset-invalid-model-domain
                      className="underline"
                      onClick={() => { void onChangeModel(undefined); }}
                    >
                      {t('composer.execution.defaultModelOption')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    data-open-model-menu-recovery
                    className="underline"
                    onClick={() => { setModelMenuSignal((n) => n + 1); }}
                  >
                    {locale === 'zh' ? '选择可用模型' : 'Choose allowed model'}
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
          {modelDomainState === 'unknown' && frozenMenuQuery.isError ? <button type="button" className="min-h-9 underline" onClick={() => { void frozenMenuQuery.refetch(); }}>{t('common.retry')}</button> : null}
          {invalidEffort ? <p>{t('selection.effortInvalid', { value: effort! })}</p> : null}
          {selectionCatalogError !== null ? <button type="button" className="underline" onClick={() => { void modelsQuery.refetch(); if (validateProfile) void agentProfilesQuery.refetch(); if (validateFile) void filePreviewQuery.refetch(); }}>{t('common.retry')}</button> : null}
          {invalidEffort && selectedModel?.default_effort !== undefined && catalogModelSupportsEffort(selectedModel, selectedModel.default_effort) ? <button type="button" className="underline" onClick={() => { onChangeEffort(selectedModel.default_effort); }}>{t('selection.resetEffort')}</button> : null}
        </div> : null}
        {/* A draft is in progress: the pending decision waits on a bar
            instead of taking the card; the bar hands the card over. */}
        {offerTakeover ? (
          <button
            type="button"
            data-needs-you-banner
            onClick={takeOver}
            title={t('composer.needsYou.bannerTitle')}
            className="anim-enter mx-3 mb-1.5 flex min-h-9 w-[calc(100%-1.5rem)] items-center gap-2 rounded-[12px] bg-attention-soft px-3 text-left text-[13px] transition-colors duration-[var(--kiki-motion-quick)] hover:bg-attention-soft/80 focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none pointer-coarse:min-h-11"
          >
            <LifeMark markId="composer-needs-you-bar" life="waiting" tone="bg-attention" />
            <span className="min-w-0 flex-1 truncate font-medium text-attention">{tp('composer.needsYou.banner', needsYouCount)}</span>
            <span className="flex shrink-0 items-center gap-1 text-[12px] font-medium text-attention">
              {t('composer.needsYou.bannerAction')}
              <Icon name="arrowRight" size={12} />
            </span>
          </button>
        ) : null}
        {header}
        {remoteTarget !== null ? (
          <p
            data-composer-remote-target
            className="mb-1.5 flex items-center gap-1.5 truncate px-1 text-[12px] leading-snug text-ink-faint"
          >
            <Icon name="web" size={12} className="shrink-0" />
            <span className="min-w-0 truncate">
              {t('composer.remoteTarget', { label: remoteTargetLabel === '' ? remoteTarget.endpoint : remoteTargetLabel })}
            </span>
          </p>
        ) : null}
        <div
          ref={cardRef}
          data-composer-card
          data-run-mode={runMode}
          data-composer-takeover={takenOver ? '' : undefined}
          className={`composer-card relative rounded-[18px] bg-panel transition-[box-shadow] duration-[var(--kiki-motion-quick)] ${
            dropHighlight ? 'ring-2 ring-accent/50' : runMode !== 'normal' && !takenOver ? 'ring-1 ring-accent/25' : ''
          } ${takenOver ? 'ring-1 ring-attention/35' : ''}`}
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
            if (disabled || files.length === 0) return;
            event.preventDefault();
            dropFiles(files);
          }}
        >
          {dropHighlight ? (
            <div className="pointer-events-none absolute inset-0 z-20 rounded-[18px] border-2 border-dashed border-accent/60 bg-panel/85" />
          ) : null}
          {/* The takeover: the pending decision is the card's body. The input
              below stays mounted (hidden) so the draft, caret and undo
              history are exactly where the user left them. */}
          {takenOver ? needsYou.render(
            <button
              type="button"
              data-needs-you-back
              onClick={backToInput}
              className="flex min-h-10 w-full items-center gap-2 rounded-b-[18px] border-t border-hairline px-3 text-left text-[12.5px] text-ink-faint transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.025] hover:text-ink-soft focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none pointer-coarse:min-h-11"
            >
              <Icon name="edit" size={12} className="shrink-0" />
              {draftHasContent ? (
                <>
                  <span className="shrink-0">{t('composer.needsYou.draftKept')}</span>
                  <span data-needs-you-draft className="min-w-0 flex-1 truncate text-ink-soft">{text.split('\n')[0]}</span>
                  {attachments.length + (annotations?.length ?? 0) + quoteItems.length > 0 ? (
                    <span className="shrink-0 tabular-nums">
                      {tp('composer.needsYou.extras', attachments.length + (annotations?.length ?? 0) + quoteItems.length)}
                    </span>
                  ) : null}
                  <span className="shrink-0 font-medium text-ink-soft">{t('composer.needsYou.backToInput')}</span>
                </>
              ) : (
                <span className="min-w-0 flex-1">{t('composer.needsYou.backToInput')}</span>
              )}
            </button>,
          ) : null}
          <div hidden={takenOver} data-composer-body>
          {/* Subtraction-first 2-3 row Composer interior:
              1. Optional transient edit banner (queueEditing) OR 1-row 44px horizontal shelf (data-context-tray).
              2. Primary editor (<ComposerInput /> + floating / and @ menus).
              3. Calm action toolbar (data-composer-toolbar).
              Session SSH and active plugin capsules live in the bare external ContextStrip below. */}
          {hasModeBanner ? (
            <div data-composer-mode-banner className="flex flex-col gap-1.5 px-3 pt-2.5 pb-1">
              {queueEditing ? (
                <div
                  data-queue-edit-banner
                  className="anim-enter flex items-center gap-2 rounded-md bg-amber-card px-3 py-1.5"
                >
                  <span aria-hidden className="flex h-4 shrink-0 items-center text-amber-ink">
                    <Icon name="edit" />
                  </span>
                  <p className="min-w-0 flex-1 truncate text-[11.5px] leading-snug text-amber-ink">
                    {/* A touch keyboard's Enter is the newline key, so the hint
                        names no keys there; ✓ and ✕ are right beside it. */}
                    {t(coarsePointer ? 'composer.queueEditBannerTouch' : 'composer.queueEditBanner')}
                  </p>
                  <button
                    type="button"
                    aria-label={t('composer.queueEditCancel')}
                    title={t('composer.queueEditCancel')}
                    disabled={turnInFlight}
                    onClick={() => { onQueueEditCancel?.(); }}
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-amber-ink/60 transition-colors hover:bg-amber-ink/10 hover:text-amber-ink"
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          {/* Unified single-row 44px horizontal attachment shelf + inline draft alerts. */}
          {hasLayer2 ? (() => {
            const shelfItems: ReactNode[] = [];
            for (const attachment of payloadAttachments) {
              const chipKey = attachmentKeyOf(attachment);
              const remove = () => {
                if (attachment.kind === 'image' && attachment.previewUrl.startsWith('blob:')) {
                  URL.revokeObjectURL(attachment.previewUrl);
                }
                updateAttachments((current) => current.filter((item) => item !== attachment));
              };
              if (attachment.kind === 'file') {
                shelfItems.push(
                  <ComposerFileTile
                    key={chipKey}
                    variant="shelf"
                    path={attachment.path}
                    name={attachment.name}
                    isDir={attachment.isDir}
                    subtitle={fileExtensionTag(attachment.name, attachment.isDir, locale === 'zh' ? '目录' : 'DIR')}
                    leading={<FileGlyph dir={attachment.isDir} />}
                    onRemove={remove}
                    removeLabel={t('composer.removeAttachment', { name: attachment.name })}
                  />,
                );
                continue;
              }
              if (attachment.kind === 'retained') {
                const part = attachment.content;
                const src = attachment.previewUrl ?? (part.type === 'image' && part.source.kind === 'base64'
                  ? `data:${part.source.media_type};base64,${part.source.data}`
                  : part.type === 'image' && part.source.kind === 'url' && /^(?:data:|blob:|https?:)/.test(part.source.url) ? part.source.url : undefined);
                if (src !== undefined) {
                  shelfItems.push(
                    <ImageTile key={chipKey} variant="shelf" src={src} name={attachment.name}
                      onOpen={onOpenImage === undefined ? undefined : () => { onOpenImage(src, attachment.name); }}
                      onRemove={remove} removeLabel={t('composer.removeAttachment', { name: attachment.name })} />,
                  );
                } else {
                  shelfItems.push(
                    <TextTile
                      key={chipKey}
                      variant="shelf"
                      title={attachment.name}
                      subtitle={fileExtensionTag(attachment.name, false, 'DIR')}
                      leading={<FileGlyph dir={false} />}
                      onRemove={remove}
                      removeLabel={t('composer.removeAttachment', { name: attachment.name })}
                    >
                      <span className="min-w-0 truncate">{attachment.name}</span>
                    </TextTile>,
                  );
                }
                continue;
              }
              if (attachment.kind === 'upload') {
                const name = attachment.name === '' ? t('attach.pastedFile') : attachment.name;
                const uploading = attachment.fileId === undefined;
                const extTag = fileExtensionTag(name, false, 'DIR');
                shelfItems.push(
                  <TextTile
                    key={chipKey}
                    variant="shelf"
                    title={`${attachment.name} · ${attachment.mediaType} · ${formatBytes(attachment.size)}`}
                    subtitle={`${extTag} · ${formatBytes(attachment.size)}`}
                    leading={uploading ? (
                      <span className="status-dot-busy flex h-4 w-4 shrink-0 items-center justify-center">
                        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                      </span>
                    ) : (
                      <FileGlyph dir={false} />
                    )}
                    ariaLabel={uploading ? t('composer.attachmentUploading') : undefined}
                    dataAttrs={{ 'data-attachment-uploading': uploading ? '' : undefined }}
                    onRemove={remove}
                    removeLabel={t('composer.removeAttachment', { name })}
                  >
                    <span className="min-w-0 truncate">{name}</span>
                  </TextTile>,
                );
                continue;
              }
              const name = attachment.name === '' ? t('attach.pastedImage') : attachment.name;
              if (attachment.data === '') {
                shelfItems.push(
                  <TextTile
                    key={chipKey}
                    variant="shelf"
                    title={t('composer.attachmentReading')}
                    subtitle={t('composer.attachmentReading')}
                    leading={(
                      <span className="status-dot-busy flex h-4 w-4 shrink-0 items-center justify-center">
                        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                      </span>
                    )}
                    ariaLabel={t('composer.attachmentReading')}
                    dataAttrs={{ 'data-attachment-reading': '' }}
                    onRemove={remove}
                    removeLabel={t('composer.removeAttachment', { name })}
                  >
                    <span className="min-w-0 truncate">{name}</span>
                  </TextTile>,
                );
                continue;
              }
              shelfItems.push(
                <ImageTile
                  key={chipKey}
                  variant="shelf"
                  src={attachment.previewUrl}
                  name={name}
                  detail={formatBytes(attachment.size)}
                  onOpen={onOpenImage === undefined ? undefined : () => { onOpenImage(attachment.previewUrl, name); }}
                  onRemove={remove}
                  removeLabel={t('composer.removeAttachment', { name })}
                />,
              );
            }
            const hasShelfTrack =
              shelfItems.length > 0 ||
              quoteItems.length > 0 ||
              (annotations !== undefined && annotations.length > 0) ||
              draftSkills.length > 0;
            return (
              <div
                data-context-tray
                role="group"
                aria-label={t('composer.contextTrayAria')}
                className="flex flex-col gap-1"
              >
                {hasShelfTrack ? (
                  <div
                    ref={contextShelfRef}
                    data-attachment-chips
                    data-context-shelf
                    className="flex flex-nowrap items-center gap-2 overflow-x-auto px-3 pt-2 pb-1 no-scrollbar"
                  >
                    {annotations !== undefined && annotations.length > 0 ? (
                      <ComposerNotes
                        variant="shelf"
                        annotations={annotations}
                        onRemove={onRemoveAnnotation}
                        onUpdate={onUpdateAnnotation}
                        onLocate={onLocateAnnotation}
                      />
                    ) : null}
                    {quoteItems.map((item) => (
                      <QuoteChip
                        key={item.id}
                        variant="shelf"
                        quote={item.quote}
                        onRemove={quotes === undefined ? onRemoveQuote : onRemoveQuoteItem === undefined ? undefined : () => onRemoveQuoteItem(item.id)}
                      />
                    ))}
                    {draftSkills.map((match) => (
                      <SkillChip
                        key={`skill-${match.skillName}`}
                        variant="shelf"
                        name={match.item.name}
                        description={match.item.description}
                        onRemove={() => { removeDraftSkill(match.skillName); }}
                      />
                    ))}
                    {shelfItems}
                  </div>
                ) : null}
                {attachmentError !== null ? (
                  <div role="alert" data-attachment-error className="flex items-start gap-2 px-3 pt-1 pb-0.5 text-[12px] text-danger">
                    <p className="min-w-0 flex-1">{attachmentError}</p>
                    <button type="button" aria-label={t('common.close')} title={t('common.close')}
                      className="shrink-0 rounded p-0.5 text-ink-faint hover:bg-paper hover:text-ink"
                      onClick={() => { setAttachmentError(null); textareaRef.current?.focus(); }}>
                      <Icon name="close" size={14} />
                    </button>
                  </div>
                ) : null}
                {slashConfirm !== null ? (
                  <div
                    role="alert"
                    data-slash-confirm
                    className="mx-3 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-amber-card px-3 py-1.5 text-[12px] font-medium text-amber-ink"
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
                        className="rounded-full border border-amber-ink/30 px-2 py-0.5 text-[11px] transition-colors hover:bg-amber-ink/10 disabled:opacity-50"
                      >
                        {t('composer.slash.sendAnyway')}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setSlashConfirm(null); }}
                        className="rounded-full border border-transparent px-2 py-0.5 text-[11px] text-amber-ink underline transition-colors hover:bg-amber-ink/10"
                      >
                        {t('composer.slash.cancelSend')}
                      </button>
                    </span>
                  </div>
                ) : null}
              </div>
            );
          })() : null}

          {/* Layer 3 — Primary Editor: unobstructed writing area + floating /
              and @ autocomplete menu. Right-click anywhere opens the composer menu. */}
          {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- context menu only; the textarea is the keyboard target */}
          <div data-composer-editor className="relative px-3 pt-2.5 pb-1" onContextMenu={onComposerContextMenu}>
            {menu !== null ? (
              <div
                data-composer-menu
                role="listbox"
                aria-label={menu.kind === 'slash' ? t('composer.slashAria') : t('composer.filesAria')}
                className={`composer-floating-panel anim-enter absolute right-0 bottom-full left-0 z-30 mb-1.5 max-h-[min(18rem,calc(100dvh-160px))] overflow-y-auto overscroll-contain p-1 ${POPOVER_SURFACE_CLASS}`}
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
                    agentGroups={filteredAgentGroups}
                    agentsFailed={agentReferencesQuery.isError}
                    delegationAvailable={agentCandidateList.delegationAvailable}
                    delegationReason={agentCandidateList.unavailableReason}
                    activeIndex={activeIndex}
                    feed={fsFeed}
                    loading={mentionLoading}
                    query={menu.query}
                    onAccept={acceptMentionItem}
                    onAcceptAgent={acceptMentionAgent}
                  />
                )}
              </div>
            ) : null}
            {slashPreviewItem !== null ? (
              <SkillPreviewCard item={slashPreviewItem} />
            ) : null}
            {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- clicking the editor after Escape re-opens a dismissed trigger menu */}
            <div
              className="contents"
              onClick={() => {
                if (dismissedTriggerRef.current !== null) {
                  dismissedTriggerRef.current = null;
                  const node = textareaRef.current;
                  refreshMenu(node?.value ?? text, node?.selectionStart ?? lastCursorRef.current);
                }
              }}
            >
            <ComposerInput
              inputRef={textareaRef}
              value={liveTextRef.current}
              references={overlayTokens}
              skillSpans={skillSpans}
              label={t('composer.inputAria')}
              enterKeyHint={coarsePointer ? 'enter' : undefined}
              onCompositionStart={() => {
                composingRef.current = true;
                pushUndoSnapshot({ text: liveTextRef.current, cursor: textareaRef.current?.selectionStart ?? lastCursorRef.current });
                historyIndexRef.current = null;
              }}
              onCompositionEnd={() => {
                composingRef.current = false;
                const node = textareaRef.current;
                if (node === null) return;
                commitText(node.value, true);
                lastCursorRef.current = node.selectionStart;
                if (slashConfirm !== null) setSlashConfirm(null);
                refreshMenu(node.value, node.selectionStart);
              }}
              sessionId={sessionId}
              agentId={agentId}
              autoFocus={autoFocus}
              disabled={disabled}
              onChange={(nextText, cursor) => {
                if (attachmentError !== null) setAttachmentError(null);
                const prevLive = liveTextRef.current;
                if (!composingRef.current && nextText !== prevLive) {
                  pushUndoSnapshot({ text: prevLive, cursor: lastCursorRef.current });
                }
                historyIndexRef.current = null;
                recalledCaretUntouchedRef.current = false;
                recalledCaretPosRef.current = null;
                commitText(nextText);
                lastCursorRef.current = cursor;
                if (slashConfirm !== null) setSlashConfirm(null);
                refreshMenu(nextText, cursor);
              }}
              onKeyDown={onKeyDown}
              onSelection={(cursor) => {
                lastCursorRef.current = cursor;
                if (recalledCaretUntouchedRef.current && recalledCaretPosRef.current !== null && cursor !== recalledCaretPosRef.current) {
                  recalledCaretUntouchedRef.current = false;
                }
                refreshMenu(textareaRef.current?.value ?? liveTextRef.current, cursor);
              }}
              onFocus={() => { setInputFocused(true); }}
              onBlur={() => {
                cancelDraftSyncTimer();
                const latest = liveTextRef.current;
                if (latest !== localText) setLocalText(latest);
                if (latest !== normalizedPropValue) emitChange(latest);
                setMenu(null);
                setInputFocused(false);
                if (textareaRef.current?.disabled) refocusOnEnableRef.current = true;
              }}
              onPaste={(event) => {
                setAttachmentError(null);
                const data = event.clipboardData;
                if (data === null) return;
                const files = [...data.files];
                if (files.length === 0 && host.readClipboardFiles === undefined) return;
                const plain = data.getData('text/plain');
                event.preventDefault();
                void pasteContentRef.current(async () => ({ text: plain, files }));
              }}
              placeholder={
                disabled
                  ? (disabledPlaceholder ?? t('composer.placeholder'))
                  : runMode === 'goal'
                    ? t('composer.goalArmedChip')
                  : busy
                    ? (busyPlaceholder ?? t(busySendsNow ? 'composer.placeholderBusySendsNow' : 'composer.placeholderBusy'))
                    : t('composer.placeholder')
              }
            />
            </div>
          </div>

          {/* Bottom row: attach on the left edge, one quiet status line in the
              middle (each segment opens its own picker), meter + send on the
              right edge. The segments are an ordered list (statusSegments)
              so regrouping them stays a local change. */}
          <div
            data-composer-toolbar
            className="@container/toolbar flex min-w-0 items-center gap-0.5 px-2 pt-1 pb-2 [contain:layout_style]"
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              disabled={disabled}
              onChange={(event) => {
                const files = [...(event.target.files ?? [])];
                // Reset so re-picking the same file fires change again.
                event.target.value = '';
                if (files.length > 0) addFiles(readyAttachmentFiles(files));
              }}
            />
            <AddMenu
              view={addView}
              onViewChange={setAddView}
              attachDisabled={disabled}
              onAttach={openAttachPicker}
              onRebuild={onRebuildContext === undefined ? undefined : () => { setContextRebuildConfirm(true); }}
              rebuildDisabled={busy || contextRebuildBusy}
              runMode={variant === 'subagent' && (disabled || externalExecution) ? undefined : runModeControls}
              ssh={ssh.available ? { count: ssh.joinedCount, renderPanel: ssh.renderPanel, hosts: ssh.hosts, onToggleHost: ssh.toggleHost } : undefined}
              skills={skillCatalogReady && onActivateSkill !== undefined ? {
                items: skillMenuItems,
                status: skillsQuery.isError ? 'error' : skillsQuery.isSuccess ? 'ready' : 'loading',
                onInsert: insertSkillFromMenu,
                onShow: () => { if (skillsQuery.isStale && !skillsQuery.isFetching) void skillsQuery.refetch(); },
              } : undefined}
              plugins={pluginPick.available ? {
                items: pluginPick.items,
                loading: pluginPick.loading,
                failed: pluginPick.failed,
                ...(pluginPick.busyId !== undefined ? { busyId: pluginPick.busyId } : {}),
                onToggle: pluginPick.toggle,
              } : undefined}
              optional={{ sessionId }}
              mcp={mcpPick.available ? {
                items: mcpPick.items,
                loading: mcpPick.loading,
                failed: mcpPick.failed,
                writable: mcpPick.writable,
                busyName: mcpPick.busyName,
                busyAction: mcpPick.busyAction,
                busyOn: mcpPick.busyOn,
                failure: mcpPick.failure,
                onDismissFailure: mcpPick.dismissFailure,
                onShow: mcpPick.onShow,
                onOverride: mcpPick.setOverride,
                onReconnect: mcpPick.reconnect,
                externalEngine,
              } : undefined}
              files={fsSearch === undefined ? undefined : {
                search: fsSearch,
                scopeKey: mentionScopeKey ?? sessionId ?? 'none',
                onMention: mentionFromMenu,
              }}
              extensions={addMenuExtensionItems.length > 0 ? {
                items: addMenuExtensionItems,
                busyKey: pluginSlotBusyKey,
                disabled,
              } : undefined}
              permission={variant !== 'subagent' || (!disabled && !externalExecution) ? {
                value: permissionMode,
                onChange: onChangePermissionMode,
              } : undefined}
              timing={sendTimingAvailable && sendTimingDefault !== undefined ? {
                defaultTiming: sendTimingDefault,
                canSendNow: busy && onSendNow !== undefined && !sendNowDegrades,
                busy,
                busySendsNow,
                onPick: (choice: SendTimingChoice) => {
                  if (choice === 'default') send();
                  else if (choice === 'now') send(true);
                  else send(false, choice);
                },
              } : undefined}
            />
            <div
              data-composer-status
              className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
            >
              {/* One row at every width. No separator glyphs: each segment is
                  its own hover target led by a kind icon, so the gaps and the
                  icons do the separating. Who answers (mode, agent, model)
                  sits on the left; what it may do (approvals) is pushed right,
                  next to the meter. Agent and model truncate first. */}
              {(messageEditing ? [] : statusSegments).map((segment) => (
                <div
                  key={segment.key}
                  data-status-segment={segment.key}
                  className={`flex min-w-0 items-center [&>div]:flex [&>div]:min-w-0 ${
                    segment.key === 'permission'
                      ? 'ml-auto shrink-0 pl-1'
                      : segment.key === 'output-layer'
                        ? 'shrink-0 pl-0.5 @max-[34rem]/toolbar:hidden'
                      : segment.key === 'run-mode'
                        ? 'mr-1 shrink-0'
                      : segment.key === 'profile' || segment.key === 'agent'
                        ? 'min-w-0 shrink @max-[30rem]/toolbar:hidden'
                      : segment.key === 'execution'
                        ? 'min-w-0 shrink @max-[30rem]/toolbar:hidden'
                      : segment.key === 'compact-model'
                        ? 'hidden min-w-0 flex-1 @max-[30rem]/toolbar:flex'
                      : 'min-w-0 shrink'
                  }`}
                >
                  {segment.node}
                </div>
              ))}
              {/* CompactModelSheet renders via statusSegments right before
                  permission so narrow toolbars keep [Persona·Model·Effort] on
                  the left and [Permission] anchored on the right. */}
            </div>
            <div className="ml-1 flex shrink-0 items-center gap-1">
              {contextUsage !== undefined ? (
                <div className={keepContextOnNarrow ? 'flex shrink-0 items-center' : 'flex shrink-0 items-center @max-[17.5rem]/toolbar:hidden'}>
                  <ContextMeter
                    used={contextUsage.used}
                    limit={contextUsage.limit}
                    usage={sessionUsage}
                    usageError={sessionUsageError}
                    usageScope={variant === 'subagent' ? 'agent' : 'session'}
                    sessionId={sessionId}
                    agentId={agentId}
                    onCompact={onCompactContext}
                    autoCompact={contextAutoCompact}
                    compactAvailability={compactAvailability}
                  />
                </div>
              ) : null}
              {queueEditing && onQueueEditRemove !== undefined ? (
                // Queue-edit mode: the stop button becomes the remove control
                // for the queued message being edited (two-step: arm, then
                // confirm). Turn abort resumes when the edit ends.
                <button
                  type="button"
                  disabled={turnInFlight}
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
                  className={`flex h-8 shrink-0 items-center justify-center rounded-full border transition-colors focus-visible:ring-2 focus-visible:ring-danger/40 focus-visible:outline-none pointer-coarse:h-10 ${
                    queueEditRemoveArmed
                      ? 'gap-1 border-danger/60 bg-danger/10 px-3 text-[11px] font-medium text-danger hover:bg-danger/20'
                      : 'w-8 border-danger/40 text-danger hover:bg-danger/10 pointer-coarse:w-10'
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
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-danger/40 text-danger transition-colors hover:bg-danger/10 focus-visible:ring-2 focus-visible:ring-danger/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-10 pointer-coarse:w-10"
                >
                  <Icon name="stop" size={12} />
                </button>
              ) : null}
              {/* While busy, Send stays mounted beside Stop so a queued prompt
                  has a mouse path too (Enter works as before). The wrapper is
                  the send-timing menu's hover/focus zone and its positioning
                  context; the menu floats above the button. */}
              {/* Message editing ends where it is decided: one quiet circular X
                  left of Send abandons this edit (the message itself is never
                  touched) instead of a second row of controls below the
                  composer. Escape keeps the same meaning, and the X waits while
                  the edit is in flight. */}
              {messageEditing && onQueueEditCancel !== undefined ? (
                <button
                  type="button"
                  data-edit-cancel=""
                  disabled={turnInFlight}
                  onClick={() => { onQueueEditCancel(); }}
                  title={t('common.cancel')}
                  aria-label={t('common.cancel')}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-faint transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:h-10 pointer-coarse:w-10"
                >
                  <Icon name="close" size={12} />
                </button>
              ) : null}
              {busy && !canSend && !queueEditing && !messageEditing && onAbort !== undefined ? null : (
              <div
                ref={sendTimingRootRef}
                data-send-timing-root
                className="relative flex items-center"
                onMouseEnter={busy ? openSendTimingOnHover : undefined}
                onMouseLeave={closeSendTimingOnLeave}
                onBlur={onSendTimingBlur}
                onKeyDown={sendTimingKeys}
              >
                <button
                  ref={sendButtonRef}
                  type="button"
                  onClick={() => { closeSendTiming(); send(); }}
                  onKeyDown={onSendTimingButtonKeyDown}
                  disabled={!canSend}
                  aria-haspopup={sendTimingAvailable ? 'menu' : undefined}
                  aria-expanded={sendTimingAvailable ? sendTimingOpen : undefined}
                  aria-controls={sendTimingOpen ? sendTimingMenuId : undefined}
                  title={
                    messageEditing ? t('transcript.editSubmitTitle') : queueEditing
                      ? t(sendShortcut === 'cmd-enter' ? 'composer.queueEditConfirmTitleCmdEnter' : 'composer.queueEditConfirmTitle')
                      : sendDisabled && !disabled && sendDisabledTitle !== undefined
                        ? sendDisabledTitle
                        : busy && sendNowDegrades
                          ? t(sendShortcut === 'cmd-enter' ? 'composer.queueTitlePendingSwitchCmdEnter' : 'composer.queueTitlePendingSwitch')
                        : busy && busySendsNow
                          ? t(sendShortcut === 'cmd-enter' ? 'composer.sendNowTitleCmdEnter' : 'composer.sendNowTitle')
                        : busy
                          ? t(sendShortcut === 'cmd-enter' ? 'composer.queueTitleCmdEnter' : 'composer.queueTitle')
                          : t(sendShortcut === 'cmd-enter' ? 'composer.sendTitleCmdEnter' : 'composer.sendTitle')
                  }
                  aria-label={messageEditing ? t('transcript.editSubmit') : queueEditing ? t('composer.queueEditConfirm') : busy ? t(busySendsNow ? 'composer.sendNowAria' : 'composer.queueAria') : t('composer.sendAria')}
                  data-edit-submit={messageEditing ? '' : undefined}
                  data-send-ready={canSend ? '' : undefined}
                  className={`flex h-8 shrink-0 items-center justify-center transition-colors duration-[var(--kiki-motion-quick)] focus-visible:ring-2 focus-visible:ring-selected-ink/50 focus-visible:outline-none pointer-coarse:h-10 ${
                    sendTimingAvailable && canSend ? 'w-8 rounded-l-full pointer-coarse:w-9' : 'w-8 rounded-full pointer-coarse:w-10'
                  } ${
                    canSend
                      ? 'bg-accent text-primary-foreground hover:bg-accent-deep'
                      : 'bg-paper text-ink-faint'
                  }`}
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
                {sendTimingAvailable ? (
                  <button
                    ref={sendTimingCaretRef}
                    type="button"
                    data-send-timing-caret=""
                    aria-label={t('composer.sendTimingAria')}
                    aria-haspopup="menu"
                    aria-expanded={sendTimingOpen}
                    aria-controls={sendTimingOpen ? sendTimingMenuId : undefined}
                    onMouseEnter={openSendTimingOnHover}
                    onMouseLeave={!busy ? cancelPendingSendTimingOpen : undefined}
                    onKeyDown={(event) => { onSendTimingButtonKeyDown(event, 'caret'); }}
                    onClick={(event) => {
                      if (sendTimingOpen) { closeSendTiming(); return; }
                      sendTimingTriggerRef.current = 'caret';
                      if (event.detail === 0) sendTimingFocusRef.current = 'first';
                      setSendTimingOpen(true);
                    }}
                    className={`flex h-8 w-6 shrink-0 cursor-pointer items-center justify-center transition-colors focus-visible:ring-2 focus-visible:ring-selected-ink/50 focus-visible:outline-none pointer-coarse:h-10 pointer-coarse:w-8 ${
                      canSend
                        ? 'rounded-r-full border-l border-primary-foreground/25 bg-accent text-primary-foreground hover:bg-accent-deep'
                        : 'ml-0.5 rounded-full text-ink-faint hover:bg-ink/[0.05] hover:text-ink'
                    }`}
                  >
                    <Icon name="chevron" size={12} className={`transition-transform ${sendTimingOpen ? '-rotate-90' : 'rotate-90'}`} />
                  </button>
                ) : null}
                {sendTimingOpen && sendTimingDefault !== undefined ? (
                  <Popover.Root
                    open
                    modal={false}
                    onOpenChange={(nextOpen, eventDetails) => {
                      if (nextOpen) return;
                      if (eventDetails.reason === 'escape-key') {
                        closeSendTiming(true);
                        return;
                      }
                      eventDetails.cancel();
                    }}
                  >
                    <Popover.Portal>
                      <Popover.Positioner
                        anchor={sendTimingRootRef}
                        side="top"
                        align="end"
                        sideOffset={6}
                        collisionPadding={8}
                        positionMethod="fixed"
                        style={{ zIndex: floatingSurfaceZIndex(sendTimingRootRef.current) }}
                      >
                        <Popover.Popup
                          ref={attachSendTimingPanelRef}
                          role="menu"
                          id={sendTimingMenuId}
                          aria-label={t('composer.sendTimingAria')}
                          data-send-timing-menu
                          initialFocus={false}
                          finalFocus={false}
                          onMouseEnter={openSendTimingOnHover}
                          onMouseLeave={closeSendTimingOnLeave}
                          {...{
                            [FLOATING_OWNER_ATTRIBUTE]: 'composer-send-timing',
                            [FLOATING_PORTAL_OWNERS_ATTRIBUTE]: resolveFloatingOwners(sendTimingRootRef.current, 'composer-send-timing'),
                            [MODAL_ESCAPE_ATTRIBUTE]: owningModalId(sendTimingRootRef.current),
                          }}
                          className={`composer-floating-panel anim-enter max-h-[min(var(--available-height,22rem),22rem,calc(100dvh-120px))] w-60 overflow-y-auto overscroll-contain p-1 outline-none ${POPOVER_SURFACE_CLASS}`}
                        >
                          <p className={POPOVER_LABEL_CLASS}>{t('composer.sendTimingAria')}</p>
                          <SendTimingRows
                            defaultTiming={sendTimingDefault}
                            canSendNow={busy && onSendNow !== undefined && !sendNowDegrades}
                            busy={busy}
                            busySendsNow={busySendsNow}
                            onPick={(choice) => {
                              closeSendTiming();
                              if (choice === 'default') send();
                              else if (choice === 'now') send(true);
                              else send(false, choice);
                            }}
                          />
                        </Popover.Popup>
                      </Popover.Positioner>
                    </Popover.Portal>
                  </Popover.Root>
                ) : null}
              </div>
              )}
            </div>
          </div>
          </div>
        </div>
        {/* External bare ContextStrip below the composer card:
            Left: SSH summary trigger (`>_ GPU box +2 ▾` opening upward), active
            plugin status capsules, and actionable queue/send-now line (ordinary
            working state is already owned by the timeline tail and header).
            Right: SessionRemainder, statusNotice, or takenOver Stop. */}
        {(() => {
          const sendNowHint =
            working !== undefined &&
            text.trim() !== '' &&
            onSendNow !== undefined &&
            !busySendsNow &&
            !queueEditing &&
            !takenOver &&
            !sendNowDegrades
              ? t(sendShortcut === 'cmd-enter' ? 'composer.sendNowHintCmdEnter' : 'composer.sendNowHint')
              : undefined;
          const showWorkingAction = working !== undefined && (working.queued !== undefined || sendNowHint !== undefined);
          return (
            <div data-composer-status-line className="@container/statusline mt-1.5 flex min-h-6 min-w-0 items-center gap-2 px-1 [contain:layout_style]">
              {ssh.resident !== null || hasPluginStatusCapsules || showWorkingAction || statusNotice !== undefined || sessionRemainder !== undefined || (takenOver && busy && onAbort !== undefined) ? (
                <>
                  {ssh.resident}
                  {hasPluginStatusCapsules ? (
                    <PluginStatusCapsules
                      slots={pluginGuiSlots.slots}
                      sessionId={sessionId}
                      workspaceId={workspaceId}
                      disabled={disabled}
                    />
                  ) : null}
                  {showWorkingAction ? (
                    <ComposerWorkingLine
                      lastResponseAt={working.lastResponseAt}
                      queued={working.queued}
                      sendNowHint={sendNowHint}
                    />
                  ) : null}
                  <span className="flex-1" />
                  {sessionRemainder === undefined ? null : (
                    <SessionRemainder className="shrink" handle={sessionRemainder} />
                  )}
                  {statusNotice === undefined ? null : (
                    <span data-composer-status-notice className="flex min-w-0 shrink items-center gap-1.5 text-[12px] font-medium text-amber-ink">
                      {statusNotice}
                    </span>
                  )}
                  {takenOver && busy && onAbort !== undefined ? (
                    <button
                      type="button"
                      data-composer-status-stop
                      onClick={onAbort}
                      disabled={abortPending}
                      className="relative inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] leading-4 font-medium text-danger transition-colors hover:bg-danger/10 focus-visible:ring-2 focus-visible:ring-danger/40 focus-visible:outline-none disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-top-1.5 pointer-coarse:after:-bottom-4.5"
                    >
                      <Icon name="stop" size={12} />
                      {abortPending ? t('tasks.stopping') : t('composer.status.stop')}
                    </button>
                  ) : null}
                </>
              ) : null}
            </div>
          );
        })()}
      </div>
    </div>
    </div>
    </ComposerCardContext.Provider>
  );
}

function CompactModelSheet({
  icon,
  label,
  effortLabel,
  title,
  ariaLabel,
  profileNode,
  executionNode,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly effortLabel?: string;
  readonly title: string;
  readonly ariaLabel: string;
  readonly profileNode: ReactNode;
  readonly executionNode: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  useLayerHistory('compact-model-sheet', open, () => { setOpen(false); });
  useEffect(() => subscribeFloatingGroup(COMPOSER_FLOATING_GROUP, 'compact-model-sheet', () => {
    setOpen(false);
  }), []);
  useEffect(() => {
    if (!open) return;
    notifyFloatingGroupOpen(COMPOSER_FLOATING_GROUP, 'compact-model-sheet', triggerRef.current);
    return registerOverlay('compact-model-sheet');
  }, [open]);
  const triggerEl = triggerRef.current;
  return (
    <div className="flex min-w-0 flex-1">
      <Popover.Root
        open={open}
        modal={false}
        onOpenChange={(nextOpen, eventDetails) => {
          if (!nextOpen && (eventDetails.reason === 'outside-press' || eventDetails.reason === 'escape-key')) {
            if (typeof document !== 'undefined') {
              const target = eventDetails.event?.target;
              if (target instanceof Element && target.closest(`[${FLOATING_PORTAL_OWNERS_ATTRIBUTE}~="compact-model-sheet"]`) !== null) {
                eventDetails.cancel();
                return;
              }
              if (document.querySelector(`[${FLOATING_PORTAL_OWNERS_ATTRIBUTE}~="compact-model-sheet"]`) !== null) {
                eventDetails.cancel();
                return;
              }
            }
          }
          setOpen(nextOpen);
        }}
      >
        <Popover.Trigger
          ref={triggerRef}
          type="button"
          data-compact-model-sheet-trigger=""
          title={title}
          aria-label={ariaLabel}
          className={`${STATUS_SEGMENT_CLASS} max-w-full overflow-hidden @max-[30rem]/toolbar:gap-1 @max-[30rem]/toolbar:px-1.5`}
        >
          {icon}
          <span className="min-w-0 truncate">{label}</span>
          {effortLabel !== undefined ? (
            <span data-compact-model-effort="" className="shrink-0 whitespace-nowrap text-ink-faint">
              · {effortLabel}
            </span>
          ) : null}
          <Icon name="chevron" size={12} className="shrink-0 rotate-90 text-ink-faint" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner
            side="top"
            align="start"
            sideOffset={8}
            collisionPadding={8}
            positionMethod="fixed"
            style={{ zIndex: floatingSurfaceZIndex(triggerEl) }}
            className="outline-none"
          >
            <Popover.Popup
              data-compact-model-sheet=""
              {...{
                [FLOATING_OWNER_ATTRIBUTE]: 'compact-model-sheet',
                [FLOATING_PORTAL_OWNERS_ATTRIBUTE]: resolveFloatingOwners(triggerEl),
                [MODAL_ESCAPE_ATTRIBUTE]: owningModalId(triggerEl),
              }}
              className={`anim-enter flex w-[min(22rem,calc(100vw-24px))] flex-col gap-2 rounded-[14px] p-2.5 outline-none ${POPOVER_SURFACE_CLASS}`}
            >
              {profileNode}
              {executionNode}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
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
  const coarsePointer = useCoarsePointer();
  const pickerScale = getPickerScaleConfig();
  const rootRef = useRef<HTMLDivElement>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);

  const flatRows = useMemo(() => {
    const rows: { readonly item: SlashItem; readonly index: number; readonly header: string | null }[] = [];
    let seenSkill = false;
    let seenPlugin = false;
    let seenAction = false;
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]!;
      let header: string | null = null;
      if (item.kind === 'skill' && !seenSkill) {
        seenSkill = true;
        header = t('composer.slash.skills');
      } else if (item.kind === 'plugin' && !seenPlugin) {
        seenPlugin = true;
        header = t('composer.slash.plugins');
      } else if (item.kind === 'action' && !seenAction) {
        seenAction = true;
        header = t('composer.slash.shortcuts');
      }
      rows.push({ item, index: i, header });
    }
    return rows;
  }, [items, t]);

  useLayoutEffect(() => {
    const parent = rootRef.current?.closest<HTMLElement>('[data-composer-menu]') ?? null;
    setScrollEl((prev) => (prev === parent ? prev : parent));
  }, []);

  const isVirtualized = flatRows.length > pickerScale.selectVirtualizeThreshold;
  const virtualizer = useVirtualizer({
    count: isVirtualized ? flatRows.length : 0,
    getScrollElement: () => scrollEl,
    estimateSize: (index) => (flatRows[index]?.header !== null ? 58 : 34),
    getItemKey: (index) => {
      const entry = flatRows[index];
      return entry === undefined ? index : `${entry.item.kind}-${entry.item.name}`;
    },
    overscan: pickerScale.virtualOverscan,
    initialRect: { width: 420, height: 280 },
    observeElementRect: (instance, cb) => {
      const el = instance.scrollElement;
      if (el === null) return;
      const emit = () => {
        const rect = el.getBoundingClientRect();
        const height = Math.round(rect.height || el.clientHeight);
        const width = Math.round(rect.width || el.clientWidth);
        if (height > 0) cb({ width, height });
      };
      emit();
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(emit);
      observer.observe(el);
      return () => { observer.disconnect(); };
    },
    measureElement: (el) => {
      const height = Math.round(el.getBoundingClientRect().height);
      return height > 0 ? height : 34;
    },
    useFlushSync: false,
  });

  useLayoutEffect(() => {
    if (isVirtualized && scrollEl !== null && activeIndex >= 0 && activeIndex < flatRows.length) {
      if (scrollEl.scrollHeight > scrollEl.clientHeight) {
        virtualizer.scrollToIndex(activeIndex, { align: 'auto' });
      } else {
        const item = virtualizer.measurementsCache[activeIndex];
        if (item !== undefined) {
          const viewportH = scrollEl.clientHeight > 0 ? scrollEl.clientHeight : 280;
          const maxOffset = Math.max(0, virtualizer.getTotalSize() - viewportH);
          const current = scrollEl.scrollTop;
          let target = current;
          if (item.end > current + viewportH) target = item.end - viewportH;
          else if (item.start < current) target = item.start;
          const clamped = Math.max(0, Math.min(maxOffset, Math.round(target)));
          if (clamped !== current) {
            scrollEl.scrollTop = clamped;
            scrollEl.dispatchEvent(new Event('scroll'));
          }
        }
      }
      return;
    }
    const active = rootRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    active?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, flatRows.length, isVirtualized, scrollEl, virtualizer]);

  const renderEntry = (entry: { readonly item: SlashItem; readonly index: number; readonly header: string | null }) => {
    const { item, index, header } = entry;
    const active = index === activeIndex;
    const argHint = item.skill?.argument_hint ?? item.argumentHint;
    const descriptionText =
      item.kind === 'action' && item.action !== undefined
        ? t(SLASH_ACTION_DESCRIPTIONS[item.action])
        : item.description;
    return (
      <>
        {header !== null ? (
          <p className="px-3 pt-1.5 pb-1 text-[12px] font-medium text-ink-faint">
            {header}
          </p>
        ) : null}
        <button
          type="button"
          role="option"
          aria-selected={active}
          aria-disabled={item.disabled === true}
          aria-setsize={isVirtualized ? flatRows.length : undefined}
          aria-posinset={isVirtualized ? index + 1 : undefined}
          onClick={() => { onAccept(item); }}
          onMouseEnter={() => { onHoverRow(index); }}
          className={`flex w-full items-baseline gap-2 rounded-md px-3 py-1.5 text-left transition-colors ${
            item.disabled === true ? 'opacity-50' : ''
          } ${active ? 'bg-paper' : 'hover:bg-paper'}`}
        >
          <span className={`shrink-0 font-mono text-[12.5px] font-medium ${active ? 'text-selected-ink' : 'text-ink'}`}>
            /{item.name}
          </span>
          {argHint !== undefined ? (
            <span className="max-w-32 truncate font-mono text-[11px] text-ink-faint">{argHint}</span>
          ) : null}
          <span
            title={descriptionText}
            className={`min-w-0 flex-1 text-[13px] text-ink-soft ${
              active && item.kind === 'plugin'
                ? 'whitespace-normal break-words max-[640px]:leading-snug min-[641px]:truncate'
                : 'truncate'
            }`}
          >
            {descriptionText}
          </span>
          {item.disabled === true ? (
            <span className="shrink-0 text-[12px] text-ink-faint">{t('composer.slash.notActivatable')}</span>
          ) : item.kind === 'skill' ? (
            <span title={item.skill?.path} className="shrink-0 text-[12px] text-ink-faint">{item.skill?.source}</span>
          ) : item.kind === 'plugin' && item.pluginId !== undefined ? (
            <span className="shrink-0 font-mono text-[11.5px] text-ink-faint">{item.pluginId}</span>
          ) : null}
        </button>
      </>
    );
  };

  return (
    <div ref={rootRef}>
      {isVirtualized ? (
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((row) => {
            const entry = flatRows[row.index];
            if (entry === undefined) return null;
            return (
              <div
                key={row.key}
                data-index={row.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${row.start}px)`,
                }}
              >
                {renderEntry(entry)}
              </div>
            );
          })}
        </div>
      ) : (
        flatRows.map((entry) => (
          <div key={`${entry.item.kind}-${entry.item.name}`}>
            {renderEntry(entry)}
          </div>
        ))
      )}
      {items.length === 0 ? (
        <p className="px-3 py-2 text-[13px] text-ink-faint">
          {/* On touch Enter is a newline; the line goes out from the send button. */}
          {t(coarsePointer ? 'composer.slash.emptyTouch' : 'composer.slash.empty')}
        </p>
      ) : null}
      {skillsFailed && hasSession ? (
        <p className="border-t border-hairline px-3 py-1 text-[12px] text-ink-faint">
          {t('composer.slash.skillsFailed')}
        </p>
      ) : null}
    </div>
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
      className="anim-enter pointer-events-none absolute right-0 bottom-full z-40 mb-1 hidden w-72 translate-x-[calc(100%+0.5rem)] rounded-[10px] border border-hairline bg-panel p-3 shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06),0_8px_24px_-12px_rgb(var(--kiki-shadow-ink)/0.18)] min-[1360px]:block"
    >
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 font-mono text-[12px] font-medium text-accent-ink">
          /{item.name}
        </span>
        {skill !== undefined ? (
          <span className="shrink-0 rounded-full border border-hairline px-1.5 py-px text-[11px] text-ink-faint">
            {skill.source}
          </span>
        ) : item.pluginId !== undefined ? (
          <span className="shrink-0 rounded-full border border-hairline px-1.5 py-px font-mono text-[11px] text-ink-faint">
            {item.pluginId}
          </span>
        ) : null}
        {item.disabled === true ? (
          <span className="shrink-0 text-[11px] text-ink-faint">
            {t('composer.slash.notActivatable')}
          </span>
        ) : null}
      </div>
      <p className="mt-1.5 max-h-36 overflow-y-auto text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-soft">
        {item.description}
      </p>
      {skill !== undefined ? (
        <p title={skill.path} className="mt-2 truncate font-mono text-[11px] text-ink-faint">
          {skill.path}
        </p>
      ) : null}
    </div>
  );
}

function MentionMenuBody({
  items,
  agentGroups,
  agentsFailed,
  delegationAvailable,
  delegationReason,
  activeIndex,
  loading,
  feed,
  query,
  onAccept,
  onAcceptAgent,
}: {
  items: readonly FsSearchHit[];
  agentGroups: readonly AgentCandidateGroup[];
  /** The agent candidate load failed; files may still list. */
  agentsFailed: boolean;
  delegationAvailable: boolean;
  delegationReason?: string;
  activeIndex: number;
  loading: boolean;
  feed: FsSearchFeedView;
  query: string;
  onAccept: (item: FsSearchHit) => void;
  onAcceptAgent: (candidate: AgentReferenceCandidate) => void;
}) {
  const { t } = useI18n();
  const pickerScale = getPickerScaleConfig();
  const listRef = useRef<HTMLDivElement | null>(null);
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const setListNode = useCallback((node: HTMLDivElement | null) => {
    listRef.current = node;
    setListEl(node);
  }, []);
  const pending = feed.pendingMore || feed.pendingRestart;

  type FlatMentionRow =
    | { readonly kind: 'file'; readonly key: string; readonly index: number; readonly item: FsSearchHit }
    | {
        readonly kind: 'agent';
        readonly key: string;
        readonly index: number;
        readonly candidate: AgentReferenceCandidate;
        readonly groupLabel: string | null;
        readonly showDelegationNote: boolean;
      };

  const flatRows = useMemo<readonly FlatMentionRow[]>(() => {
    const out: FlatMentionRow[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]!;
      out.push({ kind: 'file', key: `file:${item.path}`, index: i, item });
    }
    let idx = items.length;
    let delegationBannerPlaced = false;
    for (let g = 0; g < agentGroups.length; g += 1) {
      const group = agentGroups[g]!;
      for (let c = 0; c < group.candidates.length; c += 1) {
        const candidate = group.candidates[c]!;
        const showDelegationNote = !delegationBannerPlaced && !delegationAvailable;
        if (showDelegationNote) delegationBannerPlaced = true;
        out.push({
          kind: 'agent',
          key: `agent:${group.group}:${candidate.profile}`,
          index: idx,
          candidate,
          groupLabel: c === 0 ? group.label : null,
          showDelegationNote,
        });
        idx += 1;
      }
    }
    return out;
  }, [items, agentGroups, delegationAvailable]);

  const bothEmpty = flatRows.length === 0;
  const isVirtualized = flatRows.length > pickerScale.selectVirtualizeThreshold;

  const virtualizer = useVirtualizer({
    count: isVirtualized ? flatRows.length : 0,
    getScrollElement: () => listEl,
    estimateSize: (index) => {
      const row = flatRows[index];
      if (row === undefined) return 34;
      if (row.kind === 'agent') {
        return 34 + (row.groupLabel !== null ? 26 : 0) + (row.showDelegationNote ? 34 : 0);
      }
      return 34;
    },
    getItemKey: (index) => flatRows[index]?.key ?? index,
    overscan: pickerScale.virtualOverscan,
    initialRect: { width: 420, height: 256 },
    observeElementRect: (instance, cb) => {
      const el = instance.scrollElement;
      if (el === null) return;
      const emit = () => {
        const rect = el.getBoundingClientRect();
        const height = Math.round(rect.height || el.clientHeight);
        const width = Math.round(rect.width || el.clientWidth);
        if (height > 0) cb({ width, height });
      };
      emit();
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(emit);
      observer.observe(el);
      return () => { observer.disconnect(); };
    },
    measureElement: (el) => {
      const height = Math.round(el.getBoundingClientRect().height);
      return height > 0 ? height : 34;
    },
    useFlushSync: false,
  });

  useLayoutEffect(() => {
    if (isVirtualized && listEl !== null && activeIndex >= 0 && activeIndex < flatRows.length) {
      if (listEl.scrollHeight > listEl.clientHeight) {
        virtualizer.scrollToIndex(activeIndex, { align: 'auto' });
      } else {
        const item = virtualizer.measurementsCache[activeIndex];
        if (item !== undefined) {
          const viewportH = listEl.clientHeight > 0 ? listEl.clientHeight : 256;
          const maxOffset = Math.max(0, virtualizer.getTotalSize() - viewportH);
          const current = listEl.scrollTop;
          let target = current;
          if (item.end > current + viewportH) target = item.end - viewportH;
          else if (item.start < current) target = item.start;
          const clamped = Math.max(0, Math.min(maxOffset, Math.round(target)));
          if (clamped !== current) {
            listEl.scrollTop = clamped;
            listEl.dispatchEvent(new Event('scroll'));
          }
        }
      }
    } else {
      const active = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
      active?.scrollIntoView?.({ block: 'nearest' });
    }
    if (
      !loading &&
      !pending &&
      !feed.failed &&
      !feed.exhausted &&
      items.length > 0 &&
      activeIndex >= items.length - 2 &&
      activeIndex < items.length
    ) {
      feed.loadMore();
    }
  }, [activeIndex, items.length, flatRows.length, isVirtualized, listEl, virtualizer, loading, pending, feed]);

  const renderMentionRow = (row: FlatMentionRow) => {
    if (row.kind === 'file') {
      const active = row.index === activeIndex;
      const isDir = row.item.kind === 'directory';
      return (
        <button
          type="button"
          role="option"
          aria-selected={active}
          aria-setsize={isVirtualized ? flatRows.length : undefined}
          aria-posinset={isVirtualized ? row.index + 1 : undefined}
          onClick={() => { onAccept(row.item); }}
          className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left transition-colors ${
            active ? 'bg-paper' : 'hover:bg-paper'
          }`}
        >
          <FileGlyph dir={isDir} />
          <span className={`shrink-0 font-mono text-[12.5px] font-medium ${active ? 'text-selected-ink' : 'text-ink'}`}>
            {row.item.name}
            {isDir ? '/' : ''}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">
            {row.item.path}
          </span>
        </button>
      );
    }
    const { candidate } = row;
    const active = row.index === activeIndex;
    const disabled = !candidate.available;
    const reason = agentUnavailableReason(candidate, t);
    return (
      <>
        {row.showDelegationNote ? (
          <p className="mx-1 mt-1 rounded-md bg-ink/[0.045] px-3 py-1.5 text-[11.5px] text-ink-faint" data-agent-mention-note>
            {t('composer.agentsNoDelegation')}{delegationReason !== undefined && delegationReason !== '' ? ` — ${delegationReason}` : ''}
          </p>
        ) : null}
        {row.groupLabel !== null ? (
          <p className="px-3 pt-1.5 pb-1 text-[12px] font-medium text-ink-faint">
            {row.groupLabel}
          </p>
        ) : null}
        <button
          type="button"
          role="option"
          aria-selected={active}
          aria-disabled={disabled}
          aria-setsize={isVirtualized ? flatRows.length : undefined}
          aria-posinset={isVirtualized ? row.index + 1 : undefined}
          disabled={disabled}
          title={disabled ? reason : undefined}
          onClick={() => { onAcceptAgent(candidate); }}
          className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left transition-colors ${
            disabled ? 'cursor-not-allowed opacity-45' : active ? 'bg-paper' : 'hover:bg-paper'
          }`}
        >
          <span aria-hidden className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-ink-faint">
            <Icon name="thread" size={12} />
          </span>
          <span className={`shrink-0 text-[12.5px] font-medium ${active && !disabled ? 'text-selected-ink' : 'text-ink'}`}>
            {candidate.label}
          </span>
          <span className="shrink-0 rounded-full border border-hairline px-1.5 py-px text-[10.5px] text-ink-faint">
            {candidate.engine_label}
          </span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">
            {disabled ? reason : candidate.description ?? ''}
          </span>
        </button>
      </>
    );
  };

  return (
    <>
      {feed.failed ? <p className="px-3 py-2 text-[12px] text-danger">{t('composer.filesFailed')}</p> : null}
      {/* The agent candidate load failing is its own line, independent of the
          file list beside it — files may still list while agents are gone. */}
      {agentsFailed ? <p className="px-3 py-2 text-[12px] text-ink-faint" data-agent-mention-failed>{t('composer.agentsFailed')}</p> : null}
      {(loading && bothEmpty) || (bothEmpty && feed.exhausted && !feed.failed && !agentsFailed) ? (
        <p className="px-3 py-2 text-[12px] text-ink-faint" data-mention-empty>
          {loading ? t('composer.filesSearching') : query === '' ? t('composer.mentionEmpty') : t('composer.mentionNoMatch', { query })}
        </p>
      ) : null}
      {items.length > 0 ? <p className="px-3 pt-1.5 pb-1 text-[12px] font-medium text-ink-faint">{t('composer.filesHeader')}</p> : null}
      <div ref={setListNode} data-mention-file-list className="max-h-64 overflow-y-auto" onScroll={(event) => {
        const node = event.currentTarget;
        if (!loading && !pending && !feed.failed && !feed.exhausted && node.scrollHeight - node.scrollTop - node.clientHeight <= 32) feed.loadMore();
      }}>
      {isVirtualized ? (
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vRow) => {
            const entry = flatRows[vRow.index];
            if (entry === undefined) return null;
            return (
              <div
                key={vRow.key}
                data-index={vRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vRow.start}px)`,
                }}
              >
                {renderMentionRow(entry)}
              </div>
            );
          })}
        </div>
      ) : (
        flatRows.map((entry) => (
          <div key={entry.key}>
            {renderMentionRow(entry)}
          </div>
        ))
      )}
      </div>
      {!loading && (!feed.exhausted || feed.failed || pending) ? (
        <button type="button" data-mention-file-more={feed.failed ? 'retry' : pending ? 'pending' : 'more'}
          disabled={pending} onClick={feed.failed ? feed.retry : feed.loadMore}
          className="flex w-full rounded-md px-3 py-2 text-left text-[12px] text-ink-soft hover:bg-paper disabled:cursor-wait">
          {feed.failed ? t('common.retry') : pending ? t('sidebar.loadingMore') : t('sidebar.searchLoadMore')}
        </button>
      ) : null}
    </>
  );
}

function ExternalModelChoice({ choice, engineLabel, executorResponse, executorRefreshBusy, executorRefreshFailed, onRefreshExecutorModels, onChange }: {
  choice: ExecutionChoice;
  engineLabel: string;
  executorResponse?: ExecutorModelCatalogResponse;
  executorRefreshBusy: boolean;
  executorRefreshFailed: boolean;
  onRefreshExecutorModels: () => void;
  onChange: (model: string | undefined) => void;
}) {
  const { t } = useI18n();
  const now = useNow();
  const executorCapabilities = mapExecutorCapabilities(executorResponse, now);
  const model = typeof choice.overrides?.model === 'string' ? choice.overrides.model : undefined;
  const modelDimension = executorCapabilities.models;
  const modelState = modelDimension.kind;
  const reportedValues = modelState === 'ready' || modelState === 'partial'
    ? modelDimension.values ?? []
    : [];
  const currentModelIsUnlisted = modelState === 'ready'
    && model !== undefined
    && model !== ''
    && !reportedValues.includes(model);
  const modelOptions: readonly SearchableSelectOption[] = [
    { value: '', label: t('composer.engineModelFollow') },
    ...reportedValues.map((value) => ({ value, label: value })),
    ...(model !== undefined && model !== '' && !reportedValues.includes(model)
      ? [{
        value: model,
        label: model,
        badges: currentModelIsUnlisted
          ? [{ label: t('composer.engineModelNotInList'), tone: 'caution' as const }]
          : undefined,
      }]
      : []),
  ];
  const statusMessage = modelState === 'loading'
    ? t('composer.engineModelLoading')
    : modelState === 'partial'
      ? t('composer.engineModelPartial', { count: reportedValues.length })
      : modelState === 'unavailable'
        ? t('composer.engineModelUnavailable')
        : modelState === 'unknown' ? t('composer.engineModelUnknown') : undefined;
  // One compact status line, in the order a person needs it: a failed refresh
  // first (the list on screen is stale by definition), then the model catalog's
  // own state with its real reason, then the age of the read. A stale read
  // collapses the model state to unknown, so its age — not "not known yet" —
  // is the honest line, with Refresh beside it as the recovery.
  const stale = executorCapabilities.freshness === 'stale';
  const modelDiagnostic = modelDimension.diagnostic !== undefined && modelDimension.diagnostic !== ''
    ? modelDimension.diagnostic
    : undefined;
  const modelNote = statusMessage === undefined || (stale && modelState === 'unknown')
    ? undefined
    : (modelState === 'unavailable' || modelState === 'unknown') && modelDiagnostic !== undefined
      ? `${statusMessage} · ${modelDiagnostic}`
      : statusMessage;
  const statusLine = executorRefreshFailed
    ? t('composer.engineCapabilityRefreshFailed')
    : [modelNote, stale ? t('composer.engineCapabilityStale') : undefined]
      .filter((part): part is string => part !== undefined)
      .join(' · ') || undefined;
  // The one capability that changes what this selector itself may do. Unknown
  // is not a refusal, so only a declared-unsupported control earns the line.
  const switchControl = executorCapabilities.controls.model_switch;
  const switchLine = switchControl.kind === 'unavailable'
    ? [t('composer.engineModelSwitchUnavailable'), switchControl.diagnostic]
      .filter((part): part is string => part !== undefined && part !== '')
      .join(' · ')
    : undefined;
  const panelFooter = (
    <div data-external-model-footer className="flex items-center gap-2 border-t border-hairline px-3 py-1.5 text-[12px] leading-snug text-ink-faint">
      <div data-external-model-status className="min-w-0 flex-1">
        {statusLine !== undefined ? (
          <p
            data-external-model-refresh-error={executorRefreshFailed ? true : undefined}
            className="truncate"
            title={statusLine}
          >
            {statusLine}
          </p>
        ) : null}
        {switchLine !== undefined ? (
          <p data-external-model-switch className="truncate" title={switchLine}>{switchLine}</p>
        ) : null}
      </div>
      <button
        type="button"
        data-external-model-refresh
        aria-label={t('composer.engineCapabilityRefreshAria')}
        title={t('composer.engineCapabilityRefreshAria')}
        disabled={executorRefreshBusy}
        onClick={onRefreshExecutorModels}
        className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-ink-soft hover:bg-ink/[0.06] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none disabled:cursor-wait disabled:opacity-60"
      >
        {executorRefreshBusy ? t('composer.engineCapabilityRefreshing') : t('composer.engineCapabilityRefresh')}
      </button>
    </div>
  );
  const writable = isExecutorActionAvailable(switchControl) && (modelState === 'ready' || modelState === 'partial');
  if (!writable) return <span className="flex min-w-0 items-center gap-1" data-external-model-readonly>
    <span data-composer-engine-model={engineLabel} className="max-w-56 truncate px-1.5 text-[13px] text-ink-soft" title={[engineLabel, statusLine, switchLine].filter(Boolean).join(' · ')}>
      {model ?? t('composer.engineModelFollow')}
    </span>
    <button type="button" data-external-model-refresh disabled={executorRefreshBusy} onClick={onRefreshExecutorModels}
      aria-label={t('composer.engineCapabilityRefreshAria')} title={statusLine ?? t('composer.engineCapabilityRefreshAria')}
      className="rounded p-1 text-ink-faint hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40">
      <Icon name="refresh" size={12} />
    </button>
  </span>;
  return (
    <ComposerPanelOrigin className="flex min-w-0 [&>div]:min-w-0">
      <ModelPicker
        id="composer-engine-model-select"
        value={model ?? ''}
        options={modelOptions}
        searchPlaceholder={t('composer.engineModelId')}
        allowCustomValue
        customValueLabel={(custom) => custom}
        onChange={(next) => { onChange(next === '' ? undefined : next); }}
        ariaLabel={t('composer.modelAria')}
        title={engineLabel}
        emptyText={t('composer.engineModelFollow')}
        density="compact"
        placement="above"
        hideChevron
        panelClassName="composer-floating-panel w-80"
        panelFooter={panelFooter}
        buttonClassName={`${STATUS_SEGMENT_CLASS} max-w-full ${model === undefined ? '' : STATUS_SEGMENT_SET}`}
      />
    </ComposerPanelOrigin>
  );
}

/**
 * ModelChip — one trigger for the model and its thinking effort. The trigger
 * reads `{model} · {effort}`, with the effort segment outside the truncation
 * so the two facts never squeeze each other out. The agent profile is a
 * separate toolbar control, not part of this panel.
 *
 * Native sessions keep the panel available even without a catalog so setup
 * remains reachable. External engines keep their own read-only model label.
 */
function ModelChip({
  modelOptions,
  hasCatalog,
  model,
  resolvedModelKey,
  effectiveModel,
  shortLabel,
  modelSource,
  disabled = false,
  onChangeModel,
  efforts,
  effort,
  onChangeEffort,
  engineLabel,
  executorLabel,
  openSignal,
  domainNote,
}: {
  /**
   * Why the bound model sits outside the profile's menu without blocking a
   * send. The chip carries a quiet dot and the reason lives in its tooltip;
   * the menu rows already explain it at the moment of choosing.
   */
  readonly domainNote?: string;
  readonly modelOptions: readonly SearchableSelectOption[];
  /** Set when an external engine serves the model: the label is read-only. */
  readonly engineLabel?: string;
  readonly executorLabel?: string;
  /** The invalid-model diagnostic bumps this to open the menu as its recovery. */
  readonly openSignal?: number;
  /** False when `GET /models` returned nothing — no model is pickable. */
  readonly hasCatalog: boolean;
  readonly model: string | undefined;
  /** The catalog key `model` resolves to (bare aliases land on a provider row). */
  readonly resolvedModelKey: string | undefined;
  readonly effectiveModel: string | undefined;
  /** Short trigger label (the model's display name); the panel rows keep the full labels. */
  readonly shortLabel?: string;
  readonly modelSource: ComposerModelSource;
  readonly disabled?: boolean;
  readonly onChangeModel: (model: string | undefined) => void | Promise<void>;
  readonly efforts: readonly string[] | undefined;
  readonly effort: string | undefined;
  readonly onChangeEffort: (effort: string) => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const displayEfforts = sortThinkingEffortsForDisplay(efforts ?? []);
  const showEffort = displayEfforts.length > 0 && effort !== undefined;
  const sourceTitle = t('composer.modelTitle', { source: t(`composer.modelProvenance.${modelSource}`) });
  // The trigger shows only the display name + effort; the tooltip carries the
  // full picture (raw id and where the choice came from).
  const servingEngine = executorLabel ?? engineLabel;
  const baseTitle = servingEngine !== undefined
    ? `${t('composer.engineModelTitle', { model: effectiveModel ?? t('composer.engineModelDefault'), engine: servingEngine })} · ${sourceTitle}`
    : effectiveModel !== undefined ? `${effectiveModel} · ${sourceTitle}` : sourceTitle;
  const title = domainNote === undefined ? baseTitle : `${baseTitle}\n${domainNote}`;

  if (engineLabel !== undefined) {
    return (
      <span
        data-composer-engine-model={engineLabel}
        className="flex h-7 max-w-56 min-w-0 items-center truncate px-1.5 text-[13px] text-ink-soft"
        title={title}
      >
        {shortLabel ?? effectiveModel ?? (engineLabel !== undefined ? t('composer.engineModelDefault') : t('composer.inheritDefault'))}
      </span>
    );
  }

  return (
    <ComposerPanelOrigin className="flex min-w-0 max-w-full [&>div]:min-w-0">
    <ModelPicker
      id="composer-model-select"
      rootClassName="relative flex min-w-0 max-w-full"
      options={hasCatalog ? modelOptions : []}
      allowCustomValue={false}
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
      openSignal={openSignal}
      title={title}
      ariaLabel={t('composer.modelAria')}
      emptyText={t(effectiveModel === undefined ? 'composer.chooseModel' : 'composer.inheritDefault')}
      searchPlaceholder={t('composer.modelSearchPlaceholder')}
      density="compact"
      placement="above"
      hideChevron
      // Capped at the room above the card (`--cp-max-h`): the provenance line,
      // filter and effort row keep their height and the list scrolls, so a
      // tall catalog on the centred /new hero never slides its first line
      // under the page header.
      panelClassName="composer-floating-panel max-h-[min(var(--available-height,420px),420px,calc(100dvh-120px))] w-96 [&>*]:shrink-0 [&>[role=listbox]]:min-h-0 [&>[role=listbox]]:shrink"
      buttonClassName={`${STATUS_SEGMENT_CLASS} max-w-full ${
        modelSource === 'override' ? STATUS_SEGMENT_SET : ''
      } disabled:cursor-not-allowed disabled:opacity-60`}
      triggerIcon={<EffortGauge efforts={displayEfforts} effort={showEffort ? effort : undefined} />}
      triggerLabel={shortLabel}
      triggerSuffix={
        showEffort || domainNote !== undefined ? (
          <>
            {showEffort && effort !== undefined ? (
              <>
                <span aria-hidden className="shrink-0 text-ink-faint/60 @max-[24rem]/toolbar:hidden">·</span>
                <span data-effort-label className="shrink-0 text-ink-faint @max-[24rem]/toolbar:hidden">
                  {formatThinkingEffortWord(effort, t)}
                </span>
              </>
            ) : null}
            {domainNote !== undefined ? (
              <span data-model-domain-note className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-rule">
                <span className="sr-only">{domainNote}</span>
              </span>
            ) : null}
          </>
        ) : null
      }
      // Provenance lives in the panel, not on the chip: where the current
      // model came from, plus a way back to the inherited default.
      panelHeader={
        <div data-model-provenance className="flex items-center gap-2 border-b border-hairline px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink-faint">
            {[executorLabel, t(`composer.modelProvenance.${modelSource}`)].filter(Boolean).join(' · ')}
          </span>
          {executorLabel === undefined && model !== undefined && hasCatalog && !disabled ? (
            <button
              type="button"
              data-model-reset
              onClick={() => { void Promise.resolve(onChangeModel(undefined)).catch(() => undefined); }}
              className="shrink-0 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-ink-soft underline decoration-hairline-strong underline-offset-2 transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
            >
              {t('composer.modelResetDefault')}
            </button>
          ) : null}
        </div>
      }
      panelFooter={
        <>
        {showEffort ? (
          <div className="flex items-center gap-2 border-t border-hairline px-3 py-2">
            <span className="shrink-0 text-[12px] font-medium text-ink-faint">
              {t('composer.effortHeading')}
            </span>
            <div
              role="radiogroup"
              aria-label={t('composer.effortTitle')}
              className="ml-auto flex items-center gap-0.5 rounded-md bg-paper p-0.5"
            >
              {displayEfforts.map((level) => (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={level === effort}
                  data-effort={level}
                  disabled={disabled}
                  onClick={() => { onChangeEffort(level); }}
                  className={`rounded-[5px] px-2 py-0.5 text-[12px] transition-colors focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none ${
                    level === effort
                      ? 'bg-panel font-medium text-ink shadow-[var(--kiki-sheet-shadow)]'
                      : 'text-ink-soft hover:text-ink'
                  }`}
                >
                  {t(`composer.effort.${level}` as I18nKey) === `composer.effort.${level}` ? <span className="capitalize">{level}</span> : t(`composer.effort.${level}` as I18nKey)}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {executorLabel === undefined ? <button
          type="button"
          data-model-configure
          onClick={() => { void navigate('/settings/ai?tab=providers#st-card-providers-add'); }}
          className="w-full border-t border-hairline px-3 py-2 text-left text-[12px] font-medium text-ink-soft hover:bg-paper hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
        >
          {t('composer.configureModels')}
        </button> : null}
        </>
      }
    />
    </ComposerPanelOrigin>
  );
}

/**
 * The model segment's lead mark: three rising bars, filled up to the current
 * thinking depth. It says "this is the model and how hard it thinks" before a
 * word is read, and moving the effort visibly moves the mark. Without an
 * effort (no levels offered) every bar rests faint.
 */
function EffortGauge({
  efforts,
  effort,
}: {
  readonly efforts: readonly string[] | undefined;
  readonly effort: string | undefined;
}) {
  const index = effort === undefined || efforts === undefined ? -1 : efforts.indexOf(effort);
  const lit = index < 0 || efforts === undefined ? 0 : Math.max(1, Math.round(((index + 1) / efforts.length) * 3));
  return (
    <svg
      aria-hidden
      data-effort-gauge={lit}
      viewBox="0 0 16 16"
      className={`h-3.5 w-3.5 shrink-0 ${STATUS_SEGMENT_ICON_CLASS}`}
    >
      {[5, 8, 11].map((height, bar) => (
        <rect
          key={height}
          x={2.6 + bar * 4}
          y={13.2 - height}
          width={2.6}
          height={height}
          rx={1.1}
          fill="currentColor"
          opacity={bar < lit ? 1 : 0.28}
        />
      ))}
    </svg>
  );
}

/**
 * Actionable status line under the composer card while a turn is active:
 * governance admission queue ("Queued" with click popover) and the send-now
 * shortcut hint while typing a draft. Ordinary working status lives in the
 * timeline tail and header rather than repeating below the composer.
 */
function ComposerWorkingLine({
  lastResponseAt,
  queued,
  sendNowHint,
}: {
  readonly lastResponseAt: number | undefined;
  readonly queued?: {
    readonly waitedMs: number;
    readonly modelId?: string;
    readonly blockingRules?: readonly string[];
  };
  readonly sendNowHint: string | undefined;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!detailsOpen) return undefined;
    const onPointerDown = (e: MouseEvent) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setDetailsOpen(false);
      }
    };
    // Registered as an overlay so the session's Escape-to-stop yields while
    // this is open: stopping propagation here did nothing for a sibling
    // listener on the same target, and one Escape closed the popover and
    // aborted the queued turn behind it.
    const unregister = registerOverlay('composer-queued-details');
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      setDetailsOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      unregister();
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [detailsOpen]);

  const isQueued = queued !== undefined;
  const waitedSec = queued !== undefined ? Math.max(1, Math.round(queued.waitedMs / 1000)) : 1;

  if (!isQueued && sendNowHint === undefined) return null;

  return (
    <div className="relative flex min-w-0 items-center">
      <p
        data-composer-working
        data-last-response-at={lastResponseAt}
        className="anim-enter flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-ink-faint"
      >
        {isQueued ? (
          <>
            <span aria-hidden className="status-dot-busy h-1.5 w-1.5 shrink-0 rounded-full bg-ink-soft" />
            <span data-composer-queued className="flex shrink-0 items-center gap-1">
              <button
                ref={triggerRef}
                type="button"
                data-composer-queued-trigger
                aria-expanded={detailsOpen}
                onClick={() => { setDetailsOpen((v) => !v); }}
                className="font-medium text-ink-soft underline decoration-dotted transition-colors hover:text-ink hover:decoration-solid focus-visible:outline-2 focus-visible:outline-selected-ink"
              >
                {t('composer.queued')}
              </button>
            </span>
          </>
        ) : null}
        {sendNowHint !== undefined ? (
          <span
            data-composer-send-now-hint
            className="min-w-0 truncate @max-[360px]/statusline:hidden pointer-coarse:hidden"
          >
            {isQueued ? `· ${sendNowHint}` : sendNowHint}
          </span>
        ) : null}
      </p>

      {isQueued && detailsOpen ? (
        <Popover.Root
          open
          modal={false}
          onOpenChange={(nextOpen, eventDetails) => {
            if (nextOpen) return;
            setDetailsOpen(false);
            if (eventDetails.reason === 'escape-key') {
              triggerRef.current?.focus();
            }
          }}
        >
          <Popover.Portal>
            <Popover.Positioner
              anchor={triggerRef}
              side="top"
              align="start"
              sideOffset={8}
              collisionPadding={8}
              positionMethod="fixed"
              style={{ zIndex: floatingSurfaceZIndex(triggerRef.current) }}
              className="outline-none"
            >
              <Popover.Popup
                ref={panelRef}
                data-composer-queued-popover
                initialFocus={false}
                finalFocus={false}
                className="anim-enter w-72 max-w-[calc(100vw-24px)] rounded-lg border border-hairline bg-paper p-3 shadow-lg text-[12px] text-ink outline-none"
              >
                <div className="flex items-center justify-between pb-1.5 border-b border-hairline/60">
                  <span className="font-semibold">{t('composer.queuedTitle')}</span>
                  <span className="font-mono text-[11px] text-ink-faint tabular-nums">
                    {t('composer.queuedWaited', { seconds: waitedSec })}
                  </span>
                </div>
                <p className="mt-1.5 leading-snug text-ink-soft text-[11.5px]">
                  {t('composer.queuedBody')}
                </p>
                {queued.modelId !== undefined ? (
                  <p className="mt-1 font-mono text-[11px] text-ink-faint">
                    {t('composer.queuedModel', { model: queued.modelId })}
                  </p>
                ) : null}
                {queued.blockingRules !== undefined && queued.blockingRules.length > 0 ? (
                  <p className="mt-0.5 text-[11px] text-ink-faint">
                    {t('composer.queuedRules', { rules: queued.blockingRules.join(', ') })}
                  </p>
                ) : null}
                <div className="mt-2.5 pt-1.5 border-t border-hairline/60">
                  <button
                    type="button"
                    data-composer-queued-usage
                    onClick={() => {
                      setDetailsOpen(false);
                      void navigate('/usage');
                    }}
                    className="text-[11.5px] font-medium text-selected-ink hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink"
                  >
                    {t('composer.queuedUsageLink')}
                  </button>
                </div>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      ) : null}
    </div>
  );
}

/** Small line glyph for file / folder chips and mention rows (no emoji). */
function FileGlyph({ dir }: { dir: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0 text-ink-faint">
      {dir ? (
        <path d="M1.5 3.5a1 1 0 0 1 1-1h2.2l1 1.2h3.8a1 1 0 0 1 1 1V9a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V3.5Z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
      ) : (
        <path d="M3 1.5h3.8L9.5 4.2V10a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5ZM6.6 1.6v2.8h2.8" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
      )}
    </svg>
  );
}
