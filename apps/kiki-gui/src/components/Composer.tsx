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

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import type { DeferredAppendTiming, FsSearchHit, PermissionMode, PromptPlanGate, SessionUsageError } from '@kiki/protocol';

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
  appendThreadRefContext,
  fileToImageAttachment,
  findThreadRefs,
  formatBytes,
  hasMention,
  insertDroppedPaths,
  insertThreadRef,
  removeThreadRef,
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
  projectedProfileModelState,
  projectedProfileModelRuleSource,
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
import { API_CODES, ApiError, type ModelSwitchMode, type NamedAgentProfile } from '../lib/client';
import { registerOverlay } from '../lib/uiBusy';
import { useCoarsePointer } from '../lib/layoutHooks';
import { pastedMediaType } from '../lib/pastedFiles';
import { pushToast } from '../lib/toasts';
import { matchesShortcutAction } from '../lib/shortcuts';
import { useRemoteConnections } from '../lib/remoteConnections';
import { useConnection } from '../state/connection';
import { useProfileFilePreview } from '../lib/profileFilePreview';
import { ImageTile, QuoteChip, SkillChip, TextTile } from './ContextChips';
import { ComposerNotes } from './ComposerNotes';
import { ContextMeter, type ContextMeterAutoCompact, type ContextMeterUsage } from './ContextMeter';
import { LifeMark } from './LifeMark';
import { ConfirmDialog } from './ConfirmDialog';
import { useComposerContextMenu } from './ComposerContextMenu';
import { Icon } from './icons';
import { useNow } from './RelativeTime';
import { useComposerSsh } from './ssh/ComposerSsh';
import { ThreadRefChip } from './ThreadRefChip';
import { useThreadRefDirectory } from '../lib/threadRefs';
import { ExecutionSelect } from './harness/ExecutionSelect';
import { useExecutorCatalog } from './settings/profileEditor/engines';
import type { ExecutionChoice, ExecutionContextGroup } from '@kiki/session-core/composer';
import { buildCatalogModelOptions, modelFactBadges, modelTooltip, useProviderGroupLabel } from './modelSelectOptions';
import { POPOVER_SURFACE_CLASS, SearchableSelect, type SearchableSelectOption } from './SearchableSelect';
import { PersonaAvatar, type PersonaAvatarData } from './persona/PersonaAvatar';
import {
  AddMenu,
  type AddMenuView,
  COMPOSER_PANEL_START,
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


/** Localized descriptions for the client-side slash shortcuts (skills carry server text). */
/** `/btw` is listed only where a side question can be opened (not in a side agent's own composer). */
function withoutUnhandledActions(items: readonly SlashItem[], canAskSideQuestion: boolean): readonly SlashItem[] {
  return canAskSideQuestion ? items : items.filter((item) => item.action !== 'btw');
}

const SLASH_ACTION_DESCRIPTIONS: Record<SlashActionId, I18nKey> = {
  plan: 'composer.slash.plan',
  goal: 'composer.slash.goal',
  new: 'composer.slash.new',
  btw: 'composer.slash.btw',
  fork: 'composer.slash.fork',
  undo: 'composer.slash.undo',
  compact: 'composer.slash.compact',
};

const MENTION_DEBOUNCE_MS = 250;
const MENTION_ROW_LIMIT = 8;
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
 */
export function buildAgentProfileOptions(
  items: readonly NamedAgentProfile[],
  t: (key: I18nKey, params?: I18nParams) => string,
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
  return pickable.map((item) => toOption(item, t('composer.profileGroupMain')));
}

/** What the composer needs to know about an external engine driving main. */
export interface ComposerEngine {
  readonly label: string;
  readonly fork: boolean;
  readonly images: boolean;
}

/** `/fork` leaves the slash menu when the engine's handshake refused forking. */
function withoutRefusedActions<T extends { readonly kind: string; readonly action?: string }>(items: T[], engine: ComposerEngine | undefined): T[] {
  // A side question (/btw) is a fork of the main agent, refused with it.
  return engine?.fork === false ? items.filter((item) => item.kind !== 'action' || (item.action !== 'fork' && item.action !== 'btw')) : items;
}

const PERSONA_OPTION_PREFIX = 'persona:';

/** The agent picker's last row on /new: where personas are made. */
function PersonaPickerFooter() {
  const { t } = useI18n();
  const navigate = useNavigate();
  return (
    <div className="border-t border-hairline p-1.5">
      <button
        type="button"
        data-composer-persona-manage
        onClick={() => { void navigate('/personas'); }}
        className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-[12.5px] text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink pointer-coarse:min-h-11"
      >
        <Icon name="persona" size={14} className="text-ink-faint" />
        {t('persona.pickerManage')}
      </button>
    </div>
  );
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
  modelSwitchError,
  agentProfile,
  agentProfilePending = false,
  execution,
  onChangeExecution,
  executionPending = false,
  onCancelExecution,
  executionGrants,
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
  onSideQuestion,
  onCompactContext,
  onChangeModel,
  onChangeAgentProfile,
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
  onAbort,
  abortPending = false,
  queueEditing = false,
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
  pendingModelSwitch?: { readonly to: string; readonly mode: ModelSwitchMode };
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
  contextUsage?: { readonly used: number; readonly limit: number };
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
  onActivateSkill?: (name: string, args: string, attachments: readonly ComposerAttachment[], userInput: string) => void | Promise<unknown>;
  /** Session-scoped shortcuts (/fork, /undo, /compact). */
  onSessionAction?: (action: 'fork' | 'undo' | 'compact') => void;
  /** `/btw [question]`: open a side question beside the session; the text, when given, is sent to it. */
  onSideQuestion?: (question?: string) => void;
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
   * configured queue timing for this prompt only.
   */
  onSend: (
    text: string,
    attachments: readonly ComposerAttachment[],
    options?: { readonly goalObjective?: string; readonly appendTiming?: DeferredAppendTiming },
  ) => void | Promise<unknown>;
  /**
   * Send into the running turn instead of queueing behind it (⌘/Ctrl+Enter
   * under the default Enter semantics). Omit where there is no running turn
   * to join; the key then falls back to a normal send.
   */
  onSendNow?: (text: string, attachments: readonly ComposerAttachment[]) => void | Promise<unknown>;
  /**
   * The session's configured default queue timing. When set, hovering the
   * send button of a BUSY composer floats a menu that sends once with the
   * picked timing (plain / now / after subagents / after tasks) without
   * changing the default; the plain row names this value as what a normal
   * send does. Omit to drop the menu (e.g. where busy sends steer anyway).
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
   * `continuingCount` names the background work a stop will NOT end;
   * `queued` holds details if a model request is waiting on governance admission.
   */
  working?: {
    readonly lastResponseAt: number | undefined;
    readonly continuingCount?: number;
    readonly queued?: {
      readonly waitedMs: number;
      readonly modelId?: string;
      readonly blockingRules?: readonly string[];
    };
  };
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
  const { client, connectionId, scopeId, localClient } = useConnection();
  // In a remote space the message is delivered on another machine's home, so
  // the line above the card names that home. Nothing to say in a local space.
  const remoteRecords = useRemoteConnections(localClient);
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
  const text = value;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const [compositionText, setCompositionText] = useState<string | null>(null);
  // Custom right-click menu for the input (cut / copy / paste / select all).
  // Keyboard and menu paste share the native file-copy / browser media policy.
  type ClipboardContent = { text: string; files: File[] };
  const pasteContentRef = useRef<(read: () => Promise<ClipboardContent>) => Promise<void>>(async () => {});
  const pasteDraftRef = useRef({ text, sessionId, connectionId, scopeId });
  pasteDraftRef.current = { text, sessionId, connectionId, scopeId };
  const { onContextMenu: onComposerContextMenu, menu: composerContextMenu } =
    useComposerContextMenu({ textareaRef, onChange, onPasteContent: (read) => pasteContentRef.current(read) });
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
  const [activeIndex, setActiveIndex] = useState(0);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const turnInFlightRef = useRef(false);
  const sendNowRef = useRef(false);
  // One-shot queue-timing pick from the send-timing menu, consumed by the next
  // sendPrompt call (same latch shape as sendNowRef).
  const sendTimingRef = useRef<DeferredAppendTiming | undefined>(undefined);
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
  const skillCwd = agentProfileCatalogMode.mode === 'cwd' ? agentProfileCatalogMode.cwd : undefined;
  const skillCatalogReady = sessionId !== undefined || workspaceId !== undefined || agentProfileCatalogMode.mode !== 'disabled';
  const skillScope = JSON.stringify([scopeId, sessionId, workspaceId, skillCwd, skillCatalogReady]);
  const currentSlashDraftRef = useRef({ text, skillScope });
  currentSlashDraftRef.current = { text, skillScope };
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
  // by provider display label (buildCatalogModelOptions). The inherit row
  // resolves its target against the catalog so an ambiguous bare alias still
  // shows who will serve it; its provider rides the second line.
  const providerGroupLabel = useProviderGroupLabel();
  const catalogModelOptions: readonly SearchableSelectOption[] = useMemo(
    () => {
      const inheritTargetId = defaultModel ?? serverDefaultModel;
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
            defaultModel !== undefined
              ? t('composer.inheritSession', { model: inheritDisplay })
              : t(
                  modelSource === 'local-default'
                    ? 'composer.inheritLocal'
                    : 'composer.inheritServer',
                  { model: inheritDisplay },
                ),
          hint: inheritHint !== '' ? inheritHint : undefined,
          badges: inheritResolved !== undefined ? modelFactBadges(inheritResolved, t) : undefined,
          title: inheritResolved !== undefined ? modelTooltip(inheritResolved) : inheritTargetId,
        },
        ...buildCatalogModelOptions(models, t, { groupLabel: providerGroupLabel, currentId: defaultModel }),
      ];
    },
    [models, defaultModel, serverDefaultModel, modelSource, providerGroupLabel, t],
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
  // The engine catalog behind the execution panel. Empty while loading or on a
  // server without the route; the native engine is always offered regardless.
  const executorCatalog = useExecutorCatalog();
  const frozenMenuQuery = useQuery({
    queryKey: ['agentCapabilities', { session_id: sessionId, agent_id: agentId }],
    queryFn: () => client.getAgentCapabilities({ session_id: sessionId!, agent_id: agentId }),
    enabled: sessionId !== undefined,
    staleTime: 30_000,
    retry: retryCatalog,
    retryDelay: catalogRetryDelay,
  });
  const frozenProfile = frozenMenuQuery.data?.profile;
  const fromFile = execution?.profile_file !== undefined;
  const externalFile = fromFile && execution?.executor !== 'native';
  const validateFile = fromFile && (sessionId === undefined || executionPending);
  const filePreviewQuery = useProfileFilePreview(validateFile ? execution?.profile_file : undefined, agentProfileCatalogMode);
  const selectedProfileName = fromFile
    ? filePreviewQuery.data?.profile.name ?? frozenProfile?.name ?? execution!.profile_file!
    : agentProfile ?? frozenProfile?.name ?? DEFAULT_AGENT_PROFILE;
  const catalogProfile = agentProfilesQuery.data?.items.find((item) => item.name === selectedProfileName);
  // A pending file is its own declaration, even if a catalog profile has the same name.
  // A bound file keeps its frozen domain until the next message rebinds it.
  const modelProjection = fromFile
    ? validateFile ? filePreviewQuery.data?.profile : frozenProfile
    : sessionId === undefined ? catalogProfile
      : frozenProfile?.name === selectedProfileName ? frozenProfile
        : frozenProfile !== undefined ? catalogProfile : agentId === 'main' ? undefined : { restrict_models_to_menu: true };
  const modelSelectionPosition = agentId === 'main' ? 'main' : 'sub';
  const selectionDefaultModel = validateFile ? filePreviewQuery.data?.profile.pinned_model_alias ?? serverDefaultModel : defaultModel;
  const modelOptions: readonly SearchableSelectOption[] = useMemo(() => catalogModelOptions.map((option) => {
    const target = option.value === '' ? selectionDefaultModel ?? serverDefaultModel : option.value;
    const inheritedFileModel = validateFile && option.value === '' && target !== undefined ? resolveCatalogModel(models, target) : undefined;
    const row = validateFile && option.value === '' ? { ...option,
      label: t('composer.inheritSession', { model: inheritedFileModel?.display_name ?? target ?? t('composer.unknown') }),
      hint: inheritedFileModel === undefined ? target : providerGroupLabel(inheritedFileModel.provider_id), title: target,
    } : option;
    const state = projectedProfileModelState(modelProjection, models, target, modelSelectionPosition);
    const source = projectedProfileModelRuleSource(modelProjection, models, target, selectedProfileName);
    const reason = state === 'unknown' ? t('st.profiles.menuPreviewUnavailable')
      : t(state === 'warning' ? 'selection.modelMenuWarning' : 'selection.modelMenuBlocked', { source });
    return state === 'allowed' ? row : {
      ...row, disabled: state !== 'warning', hint: state === 'unknown' ? reason : source,
      description: reason, title: [row.title ?? row.label, reason].join('\n'),
    };
  }), [catalogModelOptions, modelProjection, models, selectionDefaultModel, serverDefaultModel, selectedProfileName, modelSelectionPosition, validateFile, providerGroupLabel, t]);
  const validateProfile = !fromFile && agentProfile !== undefined && agentProfileCatalogMode.mode !== 'disabled';
  const validatingModel = model ?? selectionDefaultModel ?? serverDefaultModel;
  const modelRuleSource = projectedProfileModelRuleSource(modelProjection, models, validatingModel, selectedProfileName);
  const modelDomainState = externalFile ? 'allowed' : projectedProfileModelState(modelProjection, models, validatingModel, modelSelectionPosition);
  const invalidModelDomain = modelDomainState === 'blocked' || modelDomainState === 'unknown';
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
    (!externalFile && modelsQuery.isPending && !isTransientCatalogError(modelsQuery.failureReason)) ||
    (validateProfile && agentProfilesQuery.isPending && !isTransientCatalogError(agentProfilesQuery.failureReason)) ||
    (validateFile && filePreviewQuery.isPending);
  const selectionCatalogError = (validateFile ? filePreviewQuery.error : null) ??
    [externalFile ? null : modelsQuery.error, validateProfile ? agentProfilesQuery.error : null]
      .find((error) => error !== null && !isTransientCatalogError(error)) ?? null;
  const invalidFile = validateFile && (!filePreviewQuery.isSuccess || filePreviewQuery.data?.profile.source_file === undefined);
  const invalidProfile = validateProfile && agentProfilesQuery.isSuccess
    && !agentProfileOptions.some((item) => item.value === agentProfile);
  const invalidModel = !externalFile && engine === undefined && modelsQuery.isSuccess && validatingModel !== undefined && selectedModel === undefined;
  const invalidEffort = !externalFile && engine === undefined && modelsQuery.isSuccess && selectedModel !== undefined
    && effort !== undefined && !catalogModelSupportsEffort(selectedModel, effort);
  const selectionBlocked = selectionLoading || selectionCatalogError !== null || invalidFile || invalidProfile || invalidModel || invalidEffort || invalidModelDomain;

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
    () => withoutUnhandledActions(withoutRefusedActions(buildSlashItems(skills, { hasSession: sessionId !== undefined }), engine), onSideQuestion !== undefined),
    [skills, sessionId, engine, onSideQuestion],
  );
  const skillMenuItems = useMemo(() => slashItems.filter((item) => item.kind === 'skill'), [slashItems]);
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
      !ssh.pending &&
      !turnInFlight &&
      !slashCatalogPending;

  // The chips band (quote/annotations/goal-mode/attachments/errors/typo
  // guard) only exists with content; it gates the wrapper's top padding above
  // the input.
  // The draft's leading skill token, chipped in the tray (typed or via ＋).
  const draftSkill = useMemo(() => {
    const draft = parseSlashDraft(text);
    // Only a completed token (followed by whitespace) — not one still being typed.
    if (draft === null || !/\s/.test(text)) return undefined;
    return skillMenuItems.find((item) => item.name === draft.query);
  }, [text, skillMenuItems]);
  const removeDraftSkill = () => {
    pushUndoSnapshot({ text, cursor: lastCursorRef.current });
    onChange(text.replace(/^\/\S*\s*/, ''));
    textareaRef.current?.focus();
  };
  // Thread links in the draft: one tray chip each (title, workspace, status),
  // a tinted token in the text, and whole-link deletion.
  const threadRefs = useMemo(() => findThreadRefs(text), [text]);
  const threadRefIds = useMemo(() => threadRefs.map((ref) => ref.sessionId), [threadRefs]);
  const fetchThreadSession = useCallback((id: string) => client.getSession(id), [client]);
  const fetchThreadHostId = useCallback(() => client.klient.global.threads.hostId(), [client]);
  const threadRefDirectory = useThreadRefDirectory(threadRefIds, fetchThreadSession, fetchThreadHostId);
  const threadRefBackdropRef = useRef<HTMLDivElement>(null);
  const removeThreadRefAt = (index: number) => {
    const ref = threadRefs[index];
    if (ref === undefined) return;
    pushUndoSnapshot({ text, cursor: lastCursorRef.current });
    historyIndexRef.current = null;
    const next = removeThreadRef(text, ref);
    applyTextChange(next.text, next.cursor);
  };
  const hasTray =
    threadRefs.length > 0 ||
    draftSkill !== undefined ||
    (quote !== undefined && quote !== null) ||
    (annotations !== undefined && annotations.length > 0) ||
    attachments.length > 0;
  const hasChips =
    queueEditing ||
    hasTray ||
    (annotations !== undefined && annotations.length > 0) ||
    runMode === 'goal' ||
    attachments.length > 0 ||
    attachmentError !== null ||
    slashConfirm !== null ||
    ssh.resident !== null;

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
    (quote !== undefined && quote !== null) ||
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

  /** Write a new draft value and land the caret once the controlled value renders. */
  const applyTextChange = (nextText: string, cursor: number) => {
    setMenu(null);
    onChange(nextText);
    lastCursorRef.current = cursor;
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (node !== null && !composingRef.current) {
        const at = Math.min(cursor, node.value.length);
        node.focus();
        node.setSelectionRange(at, at);
      }
    });
  };

  // Outside inserts (the sidebar's "Add to conversation"): the snippet lands
  // at the last caret of this session's main composer, as one undo step.
  const insertAtCaretRef = useRef<(snippet: string) => boolean>(() => false);
  insertAtCaretRef.current = (snippet: string) => {
    if (disabled || queueEditing || composingRef.current) return false;
    const node = textareaRef.current;
    const focused = node !== null && document.activeElement === node;
    const selection = focused
      ? { start: node.selectionStart, end: node.selectionEnd }
      : { start: lastCursorRef.current, end: lastCursorRef.current };
    const next = insertThreadRef(text, selection, snippet);
    pushUndoSnapshot({ text, cursor: lastCursorRef.current });
    historyIndexRef.current = null;
    applyTextChange(next.text, next.cursor);
    return true;
  };
  useEffect(() => {
    if (sessionId === undefined || variant === 'subagent') return;
    return subscribeComposerInserts(sessionId, (snippet) => insertAtCaretRef.current(snippet));
  }, [sessionId, variant]);

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
    setAttachmentError(null);
    if (historyKey !== undefined) pushInputHistory(historyKey, text);
    historyIndexRef.current = null;
    pushUndoSnapshot({ text, cursor: lastCursorRef.current });
  };

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
        if (node !== null && !composingRef.current) {
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
    onChange(next);
    lastCursorRef.current = token.length;
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (node !== null && !composingRef.current) {
        node.focus();
        node.setSelectionRange(token.length, token.length);
      }
    });
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

  /** Explicit attachments and preclassified clipboard media: images stay image parts; other attachments upload. */
  const addFiles = (files: readonly SelectedAttachmentFile[]) => {
    if (disabledRef.current) return;
    const images: SelectedAttachmentFile[] = [];
    const uploads: SelectedAttachmentFile[] = [];
    for (const file of files) {
      if (ACCEPTED_IMAGE_MIMES.includes(file.type)) images.push(file);
      else uploads.push(file);
    }
    // The engine said at handshake it takes no images; say so instead of
    // letting the send fail after the upload.
    if (images.length > 0 && engine?.images === false) {
      setAttachmentError(t('composer.engineNoImages', { engine: engine.label }));
      images.length = 0;
    }
    if (images.length > 0) addImageFiles(images);
    if (uploads.length > 0) addUploadFiles(uploads);
  };
  pasteContentRef.current = async (read) => {
    const node = textareaRef.current;
    if (node === null || node.disabled) return;
    setAttachmentError(null);
    const draft = pasteDraftRef.current;
    const selection = { start: node?.selectionStart ?? lastCursorRef.current, end: node?.selectionEnd ?? lastCursorRef.current };
    try {
      const native = await host.readClipboardFiles?.();
      const browser = native == null ? await read() : null;
      const latest = pasteDraftRef.current;
      if (textareaRef.current !== node || node.disabled || latest.sessionId !== draft.sessionId || latest.connectionId !== draft.connectionId || latest.scopeId !== draft.scopeId) return;
      if (latest.text !== draft.text) {
        setAttachmentError(t('composer.pasteDraftChanged'));
        return;
      }
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
      let next = { text: draft.text, cursor: selection.start };
      const plain = browser?.text ?? '';
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
      if (media.length > 0) addFiles(media);
      if (missingPaths) setAttachmentError(t('composer.pastePathUnavailable'));
    } catch (error) {
      setAttachmentError(errorText(locale, error));
    }
  };

  /**
   * Explicit Attach keeps its upload meaning for all files. The desktop shell
   * opens its native dialog; the browser uses a hidden input. Clipboard media
   * shares the same caps and chips, while ordinary pasted files insert paths.
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
          // `/btw <question>` goes to a side agent; the main turn never sees it.
          if (classified.item.action === 'btw' && classified.args !== '' && onSideQuestion !== undefined) {
            recordSubmission();
            onChange('');
            onSideQuestion(classified.args);
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
    // Goal mode: the message itself becomes the objective unless the draft
    // carries an explicit one.
    sendPrompt(
      text.trim(),
      runMode === 'goal'
        ? { goalObjective: goalObjective !== '' ? goalObjective : text.trim() }
        : undefined,
    );
    setLocalGoalArmed(false);
  };

  /** `now`: join the running turn instead of queueing behind it (plain prompts only). */
  const send = (now = false, timing?: DeferredAppendTiming) => {
    if (!canSend || slashCatalogPendingRef.current || composingRef.current) return;
    sendNowRef.current = now && onSendNow !== undefined;
    sendTimingRef.current = timing;
    // Queue-edit mode: the draft IS a queued message's text. Confirming hands
    // it to the queue round-trip (in-place replace at the original slot) —
    // never to command classification, skill activation, or a fresh send.
    if (queueEditing) {
      setMenu(null);
      const edited = appendThreadRefContext(text.trim(), threadRefDirectory.info);
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
        if (current.text !== text || current.skillScope !== skillScope) return;
        if (result.data === undefined) {
          setAttachmentError(t('composer.slash.submitCatalogFailed'));
          return;
        }
        setAttachmentError((previous) => previous === t('composer.slash.submitCatalogFailed') ? null : previous);
        submitWithSlashItems(withoutUnhandledActions(withoutRefusedActions(buildSlashItems(result.data.skills, { hasSession: sessionId !== undefined }), engine), onSideQuestion !== undefined), true);
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
    const now = sendNowRef.current;
    sendNowRef.current = false;
    const timing = sendTimingRef.current;
    sendTimingRef.current = undefined;
    // The caret the send leaves behind is not the user's choice to keep
    // typing: a decision arriving after this send may take the card over.
    setInputFocused(false);
    // Linked threads ride along as a trailing <thread_refs> context block the
    // model reads; the transcript strips it back off and shows chips.
    const withContext = (prepared: string) => appendThreadRefContext(prepared, threadRefDirectory.info);
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
      if (now && options === undefined && onSendNow !== undefined) {
        return onSendNow(prepared, sentAttachments);
      }
      // The timing menu's one-shot pick rides the same options object as a
      // goal objective; a plain send keeps the exact (text, attachments) call.
      const merged = timing === undefined ? options : { ...options, appendTiming: timing };
      return merged === undefined
        ? onSend(prepared, sentAttachments)
        : onSend(prepared, sentAttachments, merged);
    };
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
    const sentAttachments = sessionId === undefined && ssh.snapshot.length > 0
      ? [...attachments, ...ssh.snapshot]
      : attachments;
    if (!vscodeRuntime) {
      runAgentTurn(async () => {
        recordSubmission();
        await onActivateSkill?.(name, args, sentAttachments, text);
      });
      return;
    }
    runAgentTurn(async () => {
      await vscodeHost.preparePrompt('', vscodeConversationId, false);
      recordSubmission();
      await onActivateSkill?.(name, args, sentAttachments, text);
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
  // timing), send-now into the running turn, and the two deferred queue
  // timings. A pick fires ONCE — it never rewrites the configured default.
  // The menu stays closed while idle (every timing starts immediately, so the
  // choice would be noise), in queue-edit mode (the button is the edit's
  // confirm), and where a busy plain send already steers (busySendsNow).
  const sendTimingRootRef = useRef<HTMLDivElement | null>(null);
  const sendButtonRef = useRef<HTMLButtonElement | null>(null);
  const sendTimingMenuId = useId();
  const [sendTimingOpen, setSendTimingOpen] = useState(false);
  const sendTimingOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendTimingCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Where keyboard-opened focus lands once the menu renders. */
  const sendTimingFocusRef = useRef<'first' | 'last' | null>(null);
  const sendTimingAvailable =
    sendTimingDefault !== undefined && busy && !busySendsNow && !queueEditing && canSend && !takenOver;

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
    if (refocus) sendButtonRef.current?.focus();
  };
  // Hover intent: a short delay keeps a sweep across the button from flashing
  // the menu; a slightly longer leave grace bridges the gap into the panel.
  const openSendTimingOnHover = () => {
    if (!sendTimingAvailable || sendTimingOpen) return;
    if (sendTimingCloseTimerRef.current !== null) {
      clearTimeout(sendTimingCloseTimerRef.current);
      sendTimingCloseTimerRef.current = null;
    }
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
    if (sendTimingRootRef.current?.contains(document.activeElement) === true) return;
    sendTimingCloseTimerRef.current = setTimeout(() => {
      sendTimingCloseTimerRef.current = null;
      setSendTimingOpen(false);
    }, 250);
  };
  const onSendTimingBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!sendTimingOpen) return;
    const next = event.relatedTarget;
    if (next instanceof Node && sendTimingRootRef.current?.contains(next) === true) return;
    setSendTimingOpen(false);
  };
  // The menu-button key contract: ↑/↓ on the resting send button opens the
  // menu and lands on the first/last row; once open, usePopover's handler on
  // the root walks rows and Escape refocuses the button.
  const onSendTimingButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!sendTimingAvailable || sendTimingOpen) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    sendTimingFocusRef.current = event.key === 'ArrowUp' ? 'last' : 'first';
    setSendTimingOpen(true);
  };
  const sendTimingKeys = usePopover(sendTimingOpen, closeSendTiming, sendTimingRootRef, 'composer-send-timing');
  useEffect(() => {
    if (sendTimingAvailable || !sendTimingOpen) return;
    clearSendTimingTimers();
    setSendTimingOpen(false);
  }, [sendTimingAvailable, sendTimingOpen]);
  useEffect(() => {
    if (!sendTimingOpen || sendTimingFocusRef.current === null) return;
    const rows = [...(sendTimingRootRef.current?.querySelectorAll<HTMLElement>('[data-menu-row]:not(:disabled)') ?? [])];
    const target = sendTimingFocusRef.current === 'last' ? rows.at(-1) : rows[0];
    sendTimingFocusRef.current = null;
    target?.focus();
  }, [sendTimingOpen]);
  useEffect(() => clearSendTimingTimers, []);

  /** Recompute the trigger-driven menu after any text/caret change. */
  const refreshMenu = (nextText: string, cursor: number) => {
    if (composingRef.current) return;
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
    if (composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    // A thread link deletes as one token: Backspace/Delete touching it (or a
    // selection overlapping it) takes the whole link.
    if ((event.key === 'Backspace' || event.key === 'Delete') && !event.altKey) {
      const node = event.currentTarget;
      const range = threadRefDeletionRange(text, node.selectionStart, node.selectionEnd, event.key);
      if (range !== null) {
        event.preventDefault();
        pushUndoSnapshot({ text, cursor: node.selectionStart });
        historyIndexRef.current = null;
        const next = removeThreadRef(text, range);
        applyTextChange(next.text, next.cursor);
        refreshMenu(next.text, next.cursor);
        return;
      }
    }
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
    // The Mode menu and composer-local undo/redo (the controlled value defeats
    // the native textarea undo stack, so these walk our snapshot lane) use
    // the saved chords: ⌘/Ctrl+Shift+M and ⌘/Ctrl+Z / ⌘/Ctrl+Shift+Z by default.
    const chordEvent = {
      key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey,
      altKey: event.altKey, isComposing: event.nativeEvent.isComposing, target: event.target,
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
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.nativeEvent.keyCode,
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

  const effectiveModel = validatingModel;
  // The status line names the model by its catalog display name (the inherit
  // source and provider live in the picker and the tooltip).
  const modelShortLabel = selectedModel?.display_name ?? effectiveModel;
  // The queued switch names its target the same way the picker does.
  const pendingSwitchLabel = pendingModelSwitch === undefined
    ? undefined
    : resolveCatalogModel(models, pendingModelSwitch.to)?.display_name ?? pendingModelSwitch.to;

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
    const cancelOnFocusElsewhere = (event: globalThis.FocusEvent) => {
      if (event.target !== textarea) refocusOnEnableRef.current = false;
    };
    textarea.addEventListener('blur', armOnDisableBlur);
    document.addEventListener('focusin', cancelOnFocusElsewhere);
    return () => {
      textarea.removeEventListener('blur', armOnDisableBlur);
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

  // The agent chip names the profile; the default `agent` reads as "Kiki".
  const agentDisplayName = (name: string) =>
    name === DEFAULT_AGENT_PROFILE ? t('composer.agentDefaultName') : name;
  const agentChipLabel = agentProfile === undefined
    ? undefined
    : agentProfilePending
      ? t('composer.agentPendingSuffix', { name: agentDisplayName(agentProfile) })
      : agentDisplayName(agentProfile);

  // /new: the profile list stays profiles-only — a bot persona is not an
  // agent profile. A picked persona still rides the chip (personaPick.value)
  // and PersonaPickerFooter reaches the persona manager from the panel.
  const agentOptions: readonly SearchableSelectOption[] = agentProfileOptions;
  const agentSelectValue = personaPick?.value !== undefined
    ? `${PERSONA_OPTION_PREFIX}${personaPick.value.id}`
    : agentProfile ?? DEFAULT_AGENT_PROFILE;
  const changeAgent = (value: string) => {
    personaPick?.onChange(undefined);
    onChangeAgentProfile?.(value);
  };
  const pickedPersona = personaPick?.value;

  // The status line under the input: ordered segments, each a quiet trigger
  // for its own picker. Order and grouping live only in this list.
  const statusSegments: { key: string; node: ReactNode }[] = [];
  if (variant !== 'subagent') {
    const chip = (
      <RunModeChip
        runMode={runMode}
        onOpen={() => { setAddView('mode'); }}
        onClear={() => { changeRunMode('normal'); }}
      />
    );
    if (runMode !== 'normal') statusSegments.push({ key: 'run-mode', node: chip });
  }
  if (onChangeExecution !== undefined && execution !== undefined) {
    // The engine and its profile are ONE control: which program runs, and
    // whether Kiki's profile layer shapes it. A persona still rides the same
    // control on /new — the face names who answers, the panel behind it chooses
    // what runs, and its ✕ removes the identity without touching the engine.
    statusSegments.push({
      key: 'agent',
      node: (
        <ComposerPanelOrigin className="flex min-w-0 items-center [&>div]:min-w-0">
        <ExecutionSelect
          choice={execution}
          pending={executionPending}
          busy={busy}
          onChange={(next) => {
            // An engine without a profile is the bare harness: no persona can
            // ride it, so a carried persona steps aside rather than silently
            // binding Kiki's layer to a harness that was picked as-is.
            if (next.profile === undefined) personaPick?.onChange(undefined);
            onChangeExecution(next);
          }}
          catalog={executorCatalog}
          profiles={agentProfilesQuery.data?.items ?? []}
          catalogMode={agentProfileCatalogMode}
          pickableProfile={isConversationProfile}
          nativeLabel={t('composer.agentDefaultName')}
          contextGroups={executionGrants?.kikiContext}
          allowKikiSubagents={executionGrants?.allowKikiSubagents}
          persona={pickedPersona === undefined ? undefined : {
            id: pickedPersona.id,
            name: pickedPersona.name,
            avatar: <PersonaAvatar persona={pickedPersona} size={20} decorative className="!rounded-full" />,
          }}
          onClearPersona={pickedPersona === undefined ? undefined : () => { personaPick?.onChange(undefined); }}
          onCancelPending={executionPending ? onCancelExecution : undefined}
        />
        </ComposerPanelOrigin>
      ),
    });
  }
  statusSegments.push({
    key: 'model',
    node: (
      <ModelChip
        modelOptions={modelOptions}
        // An external engine's model is its own id, set on the profile: shown
        // read-only here, with the engine named in the tooltip.
        hasCatalog={!externalFile && engine === undefined && models.length > 0}
        engineLabel={externalFile ? executorCatalog.find((item) => item.id === execution?.executor)?.label ?? execution?.executor : engine?.label}
        openSignal={modelMenuSignal}
        model={model}
        resolvedModelKey={resolvedModelKey}
        effectiveModel={effectiveModel}
        shortLabel={modelShortLabel}
        modelSource={modelSource}
        disabled={variant === 'subagent' && disabled}
        onChangeModel={(next) => {
          const state = projectedProfileModelState(modelProjection, models, next ?? selectionDefaultModel ?? serverDefaultModel, modelSelectionPosition);
          if (state === 'blocked' || state === 'unknown') return;
          return onChangeModel(next);
        }}
        efforts={efforts}
        effort={effort}
        onChangeEffort={onChangeEffort}
      />
    ),
  });
  if (pendingModelSwitch !== undefined) {
    statusSegments.push({
      key: 'model-switch',
      node: (
        <span
          data-model-switch-pending={pendingModelSwitch.mode}
          title={`${pendingModelSwitch.to} — ${t('modelSwitch.pendingChipTitle')}`}
          // A narrow composer drops this chip entirely and says the same thing
          // in words above the input instead of clipping it to "fixture/…".
          className="@max-[30rem]/composer:hidden flex h-7 max-w-56 min-w-0 items-center px-1.5 text-[12px] font-medium text-accent-ink"
        >
          {/* The width cap matches the model chip's, so a long target id
              truncates where the model beside it would. */}
          <span className="truncate">
            {t('modelSwitch.pendingChipPrefix')}
            {pendingModelSwitch.to}
          </span>
        </span>
      ),
    });
  }
  if (variant !== 'subagent') {
    statusSegments.push({
      key: 'permission',
      node: (
        <PermissionSelect
          open={modeOpen}
          onOpenChange={setModeOpen}
          value={permissionMode}
          onChange={onChangePermissionMode}
        />
      ),
    });
  }

  return (
    <ComposerCardContext.Provider value={cardRef}>
    <div className="group/composer px-6 pb-5" data-composer-variant={variant}>
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
      <div className="@container/composer mx-auto max-w-[var(--kiki-chat-content-width,760px)]">
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
              {t('modelSwitch.pendingLine', {
                model: pendingSwitchLabel ?? pendingModelSwitch.to,
                mode: t(`modelSwitch.modeName.${pendingModelSwitch.mode}` as I18nKey),
              })}
            </span>
          </p>
        ) : null}
        {selectionBlocked ? <div data-selection-diagnostic role={selectionLoading ? 'status' : 'alert'} className="mb-2 space-y-1 rounded-lg border border-hairline bg-paper px-3 py-2 text-[11.5px] text-danger">
          {selectionLoading ? <p className="text-ink-soft">{t('selection.loading')}</p> : null}
          {selectionCatalogError !== null ? <p>{t('selection.catalogError', { detail: selectionCatalogError.message })}</p> : null}
          {invalidProfile ? <p>{t('selection.profileInvalid', { value: agentProfile! })}</p> : null}
          {invalidModel ? (
            <p>
              {/* The sentence is the recovery: it opens the model chip's own
                  menu, which already lists the catalog that just loaded. */}
              <button type="button" className="underline" onClick={() => { setModelMenuSignal((n) => n + 1); }}>
                {t('selection.modelInvalid', { value: validatingModel! })}
              </button>
            </p>
          ) : null}
          {invalidModelDomain ? <p data-model-menu-blocked>{modelDomainState === 'unknown'
            ? t(frozenMenuQuery.isPending ? 'selection.modelMenuPending' : 'selection.modelMenuError')
            : t('selection.modelMenuBlocked', { source: modelRuleSource })}</p> : null}
          {modelDomainState === 'unknown' && frozenMenuQuery.isError ? <button type="button" className="min-h-9 underline" onClick={() => { void frozenMenuQuery.refetch(); }}>{t('common.retry')}</button> : null}
          {invalidEffort ? <p>{t('selection.effortInvalid', { value: effort! })}</p> : null}
          {selectionCatalogError !== null ? <button type="button" className="underline" onClick={() => { void modelsQuery.refetch(); if (validateProfile) void agentProfilesQuery.refetch(); if (validateFile) void filePreviewQuery.refetch(); }}>{t('common.retry')}</button> : null}
          {invalidEffort && selectedModel?.default_effort !== undefined && catalogModelSupportsEffort(selectedModel, selectedModel.default_effort) ? <button type="button" className="underline" onClick={() => { onChangeEffort(selectedModel.default_effort); }}>{t('selection.resetEffort')}</button> : null}
        </div> : null}
        {modelDomainState === 'warning' ? <p data-model-menu-warning role="status" className="mb-2 px-1 text-[11.5px] text-ink-soft">
          {t('selection.modelMenuWarning', { source: modelRuleSource })}
        </p> : null}
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
          data-composer-takeover={takenOver ? '' : undefined}
          className={`composer-card relative rounded-[18px] bg-panel transition-[box-shadow] duration-[var(--kiki-motion-quick)] ${
            dragActive ? 'ring-2 ring-accent/50' : ''
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
            if (files.length === 0) return;
            event.preventDefault();
            insertDroppedFilePaths(files.map(droppedFilePath));
          }}
        >
          {dragActive ? (
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
                  {attachments.length + (annotations?.length ?? 0) + (quote !== undefined && quote !== null ? 1 : 0) > 0 ? (
                    <span className="shrink-0 tabular-nums">
                      {tp('composer.needsYou.extras', attachments.length + (annotations?.length ?? 0) + (quote !== undefined && quote !== null ? 1 : 0))}
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
          {/* Chips ride above the input; the toolbar lives below it. The
              wrapper only renders when at least one chip/banner exists so the
              textarea keeps its comfortable top padding on an empty draft. */}
          {hasChips ? (
            <div className="pt-2 pb-1.5">
          {queueEditing ? (
            <div
              data-queue-edit-banner
              className="anim-enter mx-3 mt-2 flex items-center gap-2 rounded-md bg-amber-card px-3 py-1.5"
            >
              <span aria-hidden className="flex h-4 shrink-0 items-center text-amber-ink">
                <Icon name="edit" />
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
                <Icon name="close" size={12} />
              </button>
            </div>
          ) : null}
          {/* Session SSH: a resident control for the hosts joined to this
              session, kept apart from the tray below it, which carries what
              rides the next message. */}
          {ssh.resident}
          {/* Goal mode armed: the next message becomes the session goal. The
              run-state card (pause/resume/cancel/edit) lives above the
              composer dock — see GoalCard. */}
          {runMode === 'goal' ? (
            <div
              data-goal-armed
              role="group"
              aria-label={t('composer.goalArmedAria')}
              className="anim-enter mx-3 mt-2 flex h-7 w-fit items-center gap-1.5 rounded-md bg-paper pr-1 pl-2 text-[12px] font-medium text-ink shadow-[var(--kiki-sheet-shadow)]"
            >
              <Icon name="goal" size={12} className="text-ink-soft" />
              <span>{t('composer.goalArmedChip')}</span>
              <button
                type="button"
                aria-label={t('composer.goalDisarmAria')}
                title={t('composer.goalDisarmAria')}
                onClick={() => { setGoalArmed(false); }}
                className="flex h-5 w-5 items-center justify-center rounded-[4px] text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          ) : null}
          {/* The context tray: everything that rides along with the next
              prompt (quote, annotations, images, files) in one wrap row,
              right above the input — state (goal/queue) stays in the header. */}
          {hasTray ? (
            <div data-context-tray role="group" aria-label={t('composer.contextTrayAria')} className="flex flex-wrap items-center gap-1.5 px-3 pt-2 pb-0.5">
              {threadRefs.map((ref, index) => (
                <ThreadRefChip
                  key={`thread-${ref.start}`}
                  sessionId={ref.sessionId}
                  entry={threadRefDirectory.lookup(ref.sessionId)}
                  group={threadRefs.map((item) => threadRefDirectory.lookup(item.sessionId))}
                  onRemove={() => { removeThreadRefAt(index); }}
                />
              ))}
              {draftSkill !== undefined ? (
                <SkillChip name={draftSkill.name} description={draftSkill.description} onRemove={removeDraftSkill} />
              ) : null}
              {quote !== undefined && quote !== null ? (
                <QuoteChip quote={quote} onRemove={onRemoveQuote} />
              ) : null}
              {annotations !== undefined && annotations.length > 0 ? (
                <ComposerNotes
                  annotations={annotations}
                  onRemove={onRemoveAnnotation}
                  onUpdate={onUpdateAnnotation}
                  onLocate={onLocateAnnotation}
                />
              ) : null}
              {attachments.length > 0 ? (
                <div data-attachment-chips className="contents">
                  {attachments.map((attachment, index) => {
                    if (attachment.kind === 'ssh') return null;
                    const remove = () => { updateAttachments(attachments.filter((_, i) => i !== index)); };
                    if (attachment.kind === 'file') {
                      return (
                        <TextTile
                          key={`file-${attachment.path}`}
                          title={attachment.path}
                          mono
                          onRemove={remove}
                          removeLabel={t('composer.removeAttachment', { name: attachment.name })}
                        >
                          <FileGlyph dir={attachment.isDir} />
                          <span className="min-w-0 truncate">{attachment.name}{attachment.isDir ? '/' : ''}</span>
                        </TextTile>
                      );
                    }
                    if (attachment.kind === 'retained') {
                      return (
                        <TextTile
                          key={`retained-${index}`}
                          title={attachment.name}
                          onRemove={remove}
                          removeLabel={t('composer.removeAttachment', { name: attachment.name })}
                        >
                          <FileGlyph dir={false} />
                          <span className="min-w-0 truncate">{attachment.name}</span>
                        </TextTile>
                      );
                    }
                    if (attachment.kind === 'upload') {
                      const name = attachment.name === '' ? t('attach.pastedFile') : attachment.name;
                      const uploading = attachment.fileId === undefined;
                      return (
                        <TextTile
                          key={`upload-${attachment.name}-${attachment.size}`}
                          title={`${attachment.name} · ${attachment.mediaType} · ${formatBytes(attachment.size)}`}
                          ariaLabel={uploading ? t('composer.attachmentUploading') : undefined}
                          dataAttrs={{ 'data-attachment-uploading': uploading ? '' : undefined }}
                          onRemove={remove}
                          removeLabel={t('composer.removeAttachment', { name })}
                        >
                          {uploading ? (
                            <span className="status-dot-busy flex h-4 w-4 shrink-0 items-center justify-center">
                              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                            </span>
                          ) : (
                            <FileGlyph dir={false} />
                          )}
                          <span className="min-w-0 truncate">{name}</span>
                          <span className="shrink-0 text-ink-faint tabular-nums">{formatBytes(attachment.size)}</span>
                        </TextTile>
                      );
                    }
                    const name = attachment.name === '' ? t('attach.pastedImage') : attachment.name;
                    if (attachment.data === '') {
                      // Read-in-flight placeholder: a pulsing dot instead of a
                      // preview, and sending stays blocked until data lands.
                      return (
                        <TextTile
                          key={`image-${attachment.name}-${attachment.size}`}
                          title={t('composer.attachmentReading')}
                          ariaLabel={t('composer.attachmentReading')}
                          dataAttrs={{ 'data-attachment-reading': '' }}
                          onRemove={remove}
                          removeLabel={t('composer.removeAttachment', { name })}
                        >
                          <span className="status-dot-busy flex h-4 w-4 shrink-0 items-center justify-center">
                            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                          </span>
                          <span className="min-w-0 truncate">{name}</span>
                        </TextTile>
                      );
                    }
                    return (
                      <ImageTile
                        key={`image-${attachment.name}-${attachment.size}`}
                        src={attachment.previewUrl}
                        name={name}
                        detail={formatBytes(attachment.size)}
                        onOpen={onOpenImage === undefined ? undefined : () => { onOpenImage(attachment.previewUrl, name); }}
                        onRemove={remove}
                        removeLabel={t('composer.removeAttachment', { name })}
                      />
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}
          {attachmentError !== null ? (
            <div role="alert" data-attachment-error className="flex items-start gap-2 px-3 pt-1.5 text-[12px] text-danger">
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
              className="mx-3 mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-amber-card px-3 py-1.5 text-[12px] font-medium text-amber-ink"
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
          ) : null}

          {/* Right-click anywhere on the input area (textarea or its padding)
              opens the composer menu. */}
          {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- context menu only; the textarea is the keyboard target */}
          <div className="relative px-3 pt-3" onContextMenu={onComposerContextMenu}>
            {menu !== null ? (
              <div
                data-composer-menu
                role="listbox"
                aria-label={menu.kind === 'slash' ? t('composer.slashAria') : t('composer.filesAria')}
                className={`anim-enter absolute right-0 bottom-full left-0 z-30 mb-1.5 max-h-72 overflow-y-auto p-1 ${POPOVER_SURFACE_CLASS}`}
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
            {/* Thread links read as tokens: a tinted backdrop mirrors the draft
                behind the (transparent) textarea and tints each link's range.
                Only mounted while the draft carries a link. */}
            {threadRefs.length > 0 ? (
              <div
                ref={threadRefBackdropRef}
                aria-hidden
                data-thread-ref-backdrop
                className="pointer-events-none absolute top-3 right-3 left-3 max-h-[190px] overflow-hidden py-0.5 text-[14.5px] pointer-coarse:text-[16px] leading-relaxed break-words whitespace-pre-wrap text-transparent"
              >
                {threadRefs.map((ref, index) => (
                  <span key={ref.start}>
                    {text.slice(index === 0 ? 0 : threadRefs[index - 1]!.end, ref.start)}
                    <mark data-thread-ref-token className="rounded-[3px] bg-accent/[0.14] text-transparent shadow-[0_0_0_1.5px_rgb(from_var(--color-accent)_r_g_b/0.14)]">{ref.raw}</mark>
                  </span>
                ))}
                {text.slice(threadRefs.at(-1)!.end)}
                {'​'}
              </div>
            ) : null}
            <textarea
              ref={textareaRef}
              data-composer-input
              rows={1}
              enterKeyHint={coarsePointer ? 'enter' : undefined}
              // A catalog/seat rerender can precede the browser's IME input
              // event. Never restore an older controlled prop over preedit text.
              value={composingRef.current ? textareaRef.current?.value ?? compositionText ?? text : text}
              onCompositionStart={(event) => {
                composingRef.current = true;
                setCompositionText(event.currentTarget.value);
                pushUndoSnapshot({ text, cursor: event.currentTarget.selectionStart });
                historyIndexRef.current = null;
              }}
              onCompositionEnd={(event) => {
                composingRef.current = false;
                setCompositionText(null);
                const node = event.currentTarget;
                onChange(node.value);
                lastCursorRef.current = node.selectionStart;
                setSlashConfirm(null);
                refreshMenu(node.value, node.selectionStart);
              }}
              data-composer
              onScroll={(event) => {
                const backdrop = threadRefBackdropRef.current;
                if (backdrop !== null) backdrop.scrollTop = event.currentTarget.scrollTop;
              }}
              data-autofocus={autoFocus === true ? '' : undefined}
              disabled={disabled}
              onChange={(event) => {
                setAttachmentError(null);
                // User edits only: programmatic value writes never fire this.
                if (!composingRef.current && event.target.value !== text) {
                  pushUndoSnapshot({ text, cursor: lastCursorRef.current });
                }
                // An edit while browsing history ends the browse; the edited
                // text stands (the pre-browse draft is superseded by it).
                historyIndexRef.current = null;
                if (composingRef.current) setCompositionText(event.target.value);
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
              onFocus={() => { setInputFocused(true); }}
              onBlur={(event) => {
                setMenu(null);
                // A caret in the input holds off the needs-you takeover only
                // while it is there; leaving an empty draft lets it through.
                setInputFocused(false);
                // Redundant arming path for engines that DO fire focusout on
                // disable; the native listener above covers Chromium.
                if (event.currentTarget.disabled) refocusOnEnableRef.current = true;
              }}
              onPaste={(event) => {
                setAttachmentError(null);
                const files = [...event.clipboardData.files];
                if (files.length === 0 && host.readClipboardFiles === undefined) return;
                const plain = event.clipboardData.getData('text/plain');
                event.preventDefault();
                void pasteContentRef.current(async () => ({ text: plain, files }));
              }}
              placeholder={
                disabled
                  ? (disabledPlaceholder ?? t('composer.placeholder'))
                  : busy
                    ? (busyPlaceholder ?? t(busySendsNow ? 'composer.placeholderBusySendsNow' : 'composer.placeholderBusy'))
                    : t('composer.placeholder')
              }
              // The card's focus-within border is the focus indicator; the
              // global :focus-visible ring would draw a box inside the card.
              className="relative max-h-[190px] min-h-[24px] w-full resize-none bg-transparent py-0.5 text-[14.5px] pointer-coarse:text-[16px] leading-relaxed text-ink outline-none placeholder:text-ink-faint focus-visible:outline-none disabled:opacity-60"
            />
          </div>

          {/* Bottom row: attach on the left edge, one quiet status line in the
              middle (each segment opens its own picker), meter + send on the
              right edge. The segments are an ordered list (statusSegments)
              so regrouping them stays a local change. */}
          <div
            data-composer-toolbar
            className="@container/toolbar flex items-center gap-0.5 px-2 pt-1 pb-2"
          >
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
            <AddMenu
              view={addView}
              onViewChange={setAddView}
              attachDisabled={disabled || queueEditing}
              onAttach={openAttachPicker}
              onRebuild={onRebuildContext === undefined ? undefined : () => { setContextRebuildConfirm(true); }}
              rebuildDisabled={busy || contextRebuildBusy}
              runMode={variant === 'subagent' ? undefined : runModeControls}
              ssh={ssh.available ? { count: ssh.joinedCount, renderPanel: ssh.renderPanel, hosts: ssh.hosts, onToggleHost: ssh.toggleHost } : undefined}
              skills={skillCatalogReady && onActivateSkill !== undefined ? {
                items: skillMenuItems,
                status: skillsQuery.isError ? 'error' : skillsQuery.isSuccess ? 'ready' : 'loading',
                onInsert: insertSkillFromMenu,
                onShow: () => { if (skillsQuery.isStale && !skillsQuery.isFetching) void skillsQuery.refetch(); },
              } : undefined}
              files={fsSearch === undefined ? undefined : {
                search: fsSearch,
                scopeKey: mentionScopeKey ?? sessionId ?? 'none',
                onMention: mentionFromMenu,
              }}
              timing={sendTimingAvailable && sendTimingDefault !== undefined ? {
                defaultTiming: sendTimingDefault,
                canSendNow: onSendNow !== undefined,
                onPick: (choice: SendTimingChoice) => {
                  if (choice === 'default') send();
                  else if (choice === 'now') send(true);
                  else send(false, choice);
                },
              } : undefined}
            />
            <div
              data-composer-status
              className="flex min-w-0 flex-1 items-center gap-0.5"
            >
              {/* One row at every width. No separator glyphs: each segment is
                  its own hover target led by a kind icon, so the gaps and the
                  icons do the separating. Who answers (mode, agent, model)
                  sits on the left; what it may do (approvals) is pushed right,
                  next to the meter. Agent and model truncate first. */}
              {statusSegments.map((segment) => (
                <div
                  key={segment.key}
                  data-status-segment={segment.key}
                  className={`flex min-w-0 items-center [&>div]:flex [&>div]:min-w-0 ${
                    segment.key === 'permission'
                      ? 'ml-auto shrink-0 pl-1'
                      : segment.key === 'run-mode'
                        ? 'mr-1 shrink-0'
                        : segment.key === 'agent'
                          ? 'min-w-[2.75rem] @max-[24rem]/toolbar:min-w-0 @max-[24rem]/toolbar:shrink-0'
                          : 'min-w-[3.5rem]'
                  }`}
                >
                  {segment.node}
                </div>
              ))}
            </div>
            <div className="ml-1 flex shrink-0 items-center gap-1 self-start">
              {contextUsage !== undefined ? (
                <ContextMeter
                  used={contextUsage.used}
                  limit={contextUsage.limit}
                  usage={sessionUsage}
                  usageError={sessionUsageError}
                  usageScope={variant === 'subagent' ? 'agent' : 'session'}
                  sessionId={sessionId}
                  onCompact={onCompactContext}
                  autoCompact={contextAutoCompact}
                />
              ) : null}
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
                      ? 'gap-1 border-danger/60 bg-danger/10 px-3 text-[11px] font-medium text-danger hover:bg-danger/20'
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
                  <Icon name="stop" size={12} />
                </button>
              ) : null}
              {/* While busy, Send stays mounted beside Stop so a queued prompt
                  has a mouse path too (Enter works as before). The wrapper is
                  the send-timing menu's hover/focus zone and its positioning
                  context; the menu floats above the button. */}
              <div
                ref={sendTimingRootRef}
                data-send-timing-root
                className="relative flex"
                onMouseEnter={openSendTimingOnHover}
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
                    queueEditing
                      ? t(sendShortcut === 'cmd-enter' ? 'composer.queueEditConfirmTitleCmdEnter' : 'composer.queueEditConfirmTitle')
                      : sendDisabled && !disabled && sendDisabledTitle !== undefined
                        ? sendDisabledTitle
                        : busy && busySendsNow
                          ? t(sendShortcut === 'cmd-enter' ? 'composer.sendNowTitleCmdEnter' : 'composer.sendNowTitle')
                        : busy
                          ? t(sendShortcut === 'cmd-enter' ? 'composer.queueTitleCmdEnter' : 'composer.queueTitle')
                          : t(sendShortcut === 'cmd-enter' ? 'composer.sendTitleCmdEnter' : 'composer.sendTitle')
                  }
                  aria-label={queueEditing ? t('composer.queueEditConfirm') : busy ? t(busySendsNow ? 'composer.sendNowAria' : 'composer.queueAria') : t('composer.sendAria')}
                  data-send-ready={canSend ? '' : undefined}
                  // Filled accent only once there is something to send; at rest
                  // the button is a quiet ink glyph on paper.
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors duration-[var(--kiki-motion-quick)] focus-visible:ring-2 focus-visible:ring-selected-ink/50 focus-visible:outline-none pointer-coarse:h-10 pointer-coarse:w-10 ${
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
                {/* Coarse pointers have no hover and no long-press: an explicit
                    caret opens the same menu the hover / ↑↓ paths open (split-
                    button convention: closed ▼, open ▲, as SearchableSelect). */}
                {sendTimingAvailable ? (
                  <button
                    type="button"
                    aria-label={t('composer.sendTimingAria')}
                    aria-haspopup="menu"
                    aria-expanded={sendTimingOpen}
                    aria-controls={sendTimingOpen ? sendTimingMenuId : undefined}
                    onClick={() => {
                      if (sendTimingOpen) { closeSendTiming(); return; }
                      setSendTimingOpen(true);
                    }}
                    className="ml-0.5 hidden h-8 w-6 shrink-0 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/50 focus-visible:outline-none pointer-coarse:flex pointer-coarse:h-10 pointer-coarse:w-8"
                  >
                    <Icon name="chevron" size={12} className={`transition-transform ${sendTimingOpen ? 'rotate-180' : ''}`} />
                  </button>
                ) : null}
                {sendTimingOpen && sendTimingDefault !== undefined ? (
                  <div
                    role="menu"
                    id={sendTimingMenuId}
                    aria-label={t('composer.sendTimingAria')}
                    data-send-timing-menu
                    className={`anim-enter absolute right-0 bottom-full z-40 mb-1.5 w-60 p-1 ${POPOVER_SURFACE_CLASS}`}
                  >
                    <p className={POPOVER_LABEL_CLASS}>{t('composer.sendTimingAria')}</p>
                    <SendTimingRows
                      defaultTiming={sendTimingDefault}
                      canSendNow={onSendNow !== undefined}
                      onPick={(choice) => {
                        closeSendTiming();
                        if (choice === 'default') send();
                        else if (choice === 'now') send(true);
                        else send(false, choice);
                      }}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          </div>
        </div>
        {/* The status line under the card: what the agent is doing (left) and
            the one connection fact plus Stop while the card is taken over
            (right). Key hints teach an empty draft only while the composer
            holds focus. The row never changes height, so the card never hops. */}
        <div data-composer-status-line className="mt-1.5 flex h-4 min-w-0 items-center gap-3 px-1">
          {working !== undefined || statusNotice !== undefined || (takenOver && busy && onAbort !== undefined) ? (
            <>
              {working !== undefined ? (
                <ComposerWorkingLine
                  lastResponseAt={working.lastResponseAt}
                  continuingCount={working.continuingCount}
                  queued={working.queued}
                  sendNowHint={text.trim() !== '' && onSendNow !== undefined && !busySendsNow && !queueEditing && !takenOver
                    ? t(sendShortcut === 'cmd-enter' ? 'composer.sendNowHintCmdEnter' : 'composer.sendNowHint')
                    : undefined}
                />
              ) : null}
              <span className="flex-1" />
              {statusNotice === undefined ? null : (
                <span data-composer-status-notice className="flex min-w-0 shrink items-center gap-1.5 text-[12px] font-medium text-amber-ink">
                  {statusNotice}
                </span>
              )}
              {takenOver && busy && onAbort !== undefined ? (
                // The card's Stop button is under the takeover; the line keeps it.
                <button
                  type="button"
                  data-composer-status-stop
                  onClick={onAbort}
                  disabled={abortPending}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] leading-4 font-medium text-danger transition-colors hover:bg-danger/10 focus-visible:ring-2 focus-visible:ring-danger/40 focus-visible:outline-none disabled:opacity-50"
                >
                  <Icon name="stop" size={12} />
                  {abortPending ? t('tasks.stopping') : t('composer.status.stop')}
                </button>
              ) : null}
            </>
          ) : text.trim() === '' && !busy ? (
            <p
              data-composer-hints
              className="min-w-0 flex-1 truncate text-center text-[12px] text-ink-faint opacity-0 transition-opacity duration-[var(--kiki-motion-quick)] group-focus-within/composer:opacity-100 motion-reduce:transition-none"
            >
              {t(sendShortcut === 'cmd-enter' ? 'composer.footerBaseCmdEnter' : 'composer.footerBase')}
              {t(skillCatalogReady ? 'composer.footerSkills' : 'composer.footerShortcuts')}
              {fsSearch !== undefined ? t('composer.footerFiles') : ''}
              {inputHistory.length > 0 ? t('composer.footerHistory') : ''}
            </p>
          ) : null}
        </div>
      </div>
    </div>
    </ComposerCardContext.Provider>
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
        className={`flex w-full items-baseline gap-2 rounded-md px-3 py-1.5 text-left transition-colors ${
          item.disabled === true ? 'opacity-50' : ''
        } ${active ? 'bg-paper' : 'hover:bg-paper'}`}
      >
        <span className={`shrink-0 font-mono text-[12.5px] font-medium ${active ? 'text-selected-ink' : 'text-ink'}`}>
          /{item.name}
        </span>
        {item.skill?.argument_hint !== undefined ? (
          <span className="max-w-32 truncate font-mono text-[11px] text-ink-faint">{item.skill.argument_hint}</span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-soft">
          {item.kind === 'action' && item.action !== undefined
            ? t(SLASH_ACTION_DESCRIPTIONS[item.action])
            : item.description}
        </span>
        {item.disabled === true ? (
          <span className="shrink-0 text-[12px] text-ink-faint">{t('composer.slash.notActivatable')}</span>
        ) : item.kind === 'skill' ? (
          <span title={item.skill?.path} className="shrink-0 text-[12px] text-ink-faint">{item.skill?.source}</span>
        ) : null}
      </button>
    );
  };
  return (
    <>
      {skills.length > 0 ? (
        <>
          <p className="px-3 pt-1.5 pb-1 text-[12px] font-medium text-ink-faint">
            {t('composer.slash.skills')}
          </p>
          {skills.map(renderRow)}
        </>
      ) : null}
      {actions.length > 0 ? (
        <>
          <p className="px-3 pt-1.5 pb-1 text-[12px] font-medium text-ink-faint">
            {t('composer.slash.shortcuts')}
          </p>
          {actions.map(renderRow)}
        </>
      ) : null}
      {items.length === 0 ? (
        <p className="px-3 py-2 text-[13px] text-ink-faint">
          {t('composer.slash.empty')}
        </p>
      ) : null}
      {skillsFailed && hasSession ? (
        <p className="border-t border-hairline px-3 py-1 text-[12px] text-ink-faint">
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
      <p className="px-3 py-2 text-[12px] text-danger">
        {t('composer.filesFailed')}
      </p>
    );
  }
  if (items.length === 0) {
    return (
      <p className="px-3 py-2 text-[11.5px] text-ink-faint">
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
      <p className="px-3 pt-1.5 pb-1 text-[12px] font-medium text-ink-faint">
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
            className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left transition-colors ${
              active ? 'bg-paper' : 'hover:bg-paper'
            }`}
          >
            <FileGlyph dir={isDir} />
            <span className={`shrink-0 font-mono text-[12.5px] font-medium ${active ? 'text-selected-ink' : 'text-ink'}`}>
              {item.name}
              {isDir ? '/' : ''}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">
              {item.path}
            </span>
          </button>
        );
      })}
    </>
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
  shortLabel,
  modelSource,
  disabled = false,
  onChangeModel,
  efforts,
  effort,
  onChangeEffort,
  engineLabel,
  openSignal,
}: {
  readonly modelOptions: readonly SearchableSelectOption[];
  /** Set when an external engine serves the model: the label is read-only. */
  readonly engineLabel?: string;
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
  const showEffort = efforts !== undefined && efforts.length > 0 && effort !== undefined;
  const sourceTitle = t('composer.modelTitle', { source: t(`composer.modelSource.${modelSource}`) });
  // The trigger shows only the display name + effort; the tooltip carries the
  // full picture (raw id and where the choice came from).
  const title = engineLabel !== undefined
    ? t('composer.engineModelTitle', { model: effectiveModel ?? t('composer.engineModelDefault'), engine: engineLabel })
    : effectiveModel !== undefined ? `${effectiveModel} — ${sourceTitle}` : sourceTitle;

  if (engineLabel !== undefined || (!hasCatalog && !showEffort)) {
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
    <ComposerPanelOrigin className="flex min-w-0 [&>div]:min-w-0">
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
      openSignal={openSignal}
      title={title}
      ariaLabel={t('composer.modelAria')}
      emptyText={t('composer.inheritDefault')}
      searchPlaceholder={t('composer.modelSearchPlaceholder')}
      density="compact"
      placement="above"
      hideChevron
      // Capped at the room above the card (`--cp-max-h`): the provenance line,
      // filter and effort row keep their height and the list scrolls, so a
      // tall catalog on the centred /new hero never slides its first line
      // under the page header.
      panelClassName={`anim-enter ${COMPOSER_PANEL_START} flex max-h-[var(--cp-max-h,none)] w-96 flex-col overflow-hidden ${POPOVER_SURFACE_CLASS} [&>*]:shrink-0 [&>[role=listbox]]:min-h-0 [&>[role=listbox]]:shrink`}
      buttonClassName={`${STATUS_SEGMENT_CLASS} max-w-full ${
        modelSource === 'override' ? STATUS_SEGMENT_SET : ''
      } disabled:cursor-not-allowed disabled:opacity-60`}
      triggerIcon={<EffortGauge efforts={efforts} effort={showEffort ? effort : undefined} />}
      triggerLabel={shortLabel}
      triggerSuffix={
        showEffort ? (
          // Same segment, same quiet gap: the gauge already draws the depth,
          // the word names it. Narrow composers drop the word first.
          <span data-effort-label className="shrink-0 text-ink-faint capitalize @max-[24rem]/toolbar:hidden">
            {effort}
          </span>
        ) : null
      }
      // Provenance lives in the panel, not on the chip: where the current
      // model came from, plus a way back to the inherited default.
      panelHeader={
        <div data-model-provenance className="flex items-center gap-2 border-b border-hairline px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink-faint">
            {t(`composer.modelProvenance.${modelSource}`)}
          </span>
          {model !== undefined && hasCatalog && !disabled ? (
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
        showEffort ? (
          <div className="flex items-center gap-2 border-t border-hairline px-3 py-2">
            <span className="shrink-0 text-[12px] font-medium text-ink-faint">
              {t('composer.effortHeading')}
            </span>
            <div
              role="radiogroup"
              aria-label={t('composer.effortTitle')}
              className="ml-auto flex items-center gap-0.5 rounded-md bg-paper p-0.5"
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
                  className={`rounded-[5px] px-2 py-0.5 text-[12px] transition-colors focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none ${
                    level === effort
                      ? 'bg-panel font-medium text-ink shadow-[var(--kiki-sheet-shadow)]'
                      : 'text-ink-soft hover:text-ink'
                  }`}
                >
                  <span className="capitalize">{level}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null
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
 * "Working · last response 12s ago" under the composer card. One faint line
 * led by the busy pulse, ticking once a second; before the turn's first
 * output it just says "Working". When waiting on governance admission, the
 * line shows a concise "Queued" status without noisy second counts or page
 * jumping, offering an inline popover on click for exact details and rules.
 * With a draft typed it also teaches the send-now key, while background work
 * shows "N more still running" (composer.continuing).
 */
function ComposerWorkingLine({
  lastResponseAt,
  continuingCount,
  queued,
  sendNowHint,
}: {
  readonly lastResponseAt: number | undefined;
  readonly continuingCount: number | undefined;
  readonly queued?: {
    readonly waitedMs: number;
    readonly modelId?: string;
    readonly blockingRules?: readonly string[];
  };
  readonly sendNowHint: string | undefined;
}) {
  const { t, time } = useI18n();
  const navigate = useNavigate();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useNow();

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
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setDetailsOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [detailsOpen]);

  const status = lastResponseAt === undefined
    ? t('composer.working')
    : t('composer.workingLastResponse', { ago: time.relativeTime(new Date(lastResponseAt).toISOString()) });
  const isQueued = queued !== undefined;
  const waitedSec = queued !== undefined ? Math.max(1, Math.round(queued.waitedMs / 1000)) : 1;

  return (
    <div className="relative flex min-w-0 items-center">
      <p
        data-composer-working
        data-last-response-at={lastResponseAt}
        className="anim-enter flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-ink-faint"
      >
        <span aria-hidden className="status-dot-busy h-1.5 w-1.5 shrink-0 rounded-full bg-ink-soft" />
        {isQueued ? (
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
        ) : (
          <span className="min-w-0 truncate tabular-nums">{status}</span>
        )}
        {continuingCount !== undefined && continuingCount > 0 ? (
          <span data-composer-continuing className="hidden shrink-0 sm:inline">· {t('composer.continuing', { count: continuingCount })}</span>
        ) : null}
        {sendNowHint !== undefined ? (
          <span data-composer-send-now-hint className="hidden shrink-0 sm:inline">· {sendNowHint}</span>
        ) : null}
      </p>

      {isQueued && detailsOpen ? (
        <div
          ref={panelRef}
          data-composer-queued-popover
          className="anim-enter absolute bottom-full left-0 z-30 mb-2 w-72 rounded-lg border border-hairline bg-paper p-3 shadow-lg text-[12px] text-ink"
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
        </div>
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
