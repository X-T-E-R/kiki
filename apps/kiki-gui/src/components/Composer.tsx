/**
 * Composer — floating rounded-2xl card: permission-mode pills above a
 * multiline input (send shortcut from settings), model selector fed from
 * the server catalog, accent send button; busy state swaps in Abort.
 *
 * Batch B additions:
 *   - `/` opens a slash menu of REAL entries: skills from the session's
 *     `GET /skills` catalog (submitted via the `:activate` route) plus
 *     client shortcuts that map to shipped actions. Unknown `/text` goes out
 *     as a plain prompt — nothing invented.
 *   - `@` opens a workspace file picker fed by `fs:search`; picks become
 *     reference chips that ride the prompt text as `@path` tokens.
 *   - Pasted/dropped images become preview chips and send as real base64
 *     image content parts (the server format-gates and compresses them).
 *     Placeholder chips cover the async reads; sending blocks until they land.
 *   - A slash-looking draft that resolves to no entry is intercepted at send
 *     time with an inline confirm, so a typo never silently ships as prompt
 *     text (disabled `reference` skills explain themselves instead).
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import type { FsSearchHit, PermissionMode, SessionUsage } from '@moonshot-ai/protocol';

import { useI18n } from '../i18n';
import { errorText, issueText, type I18nKey } from '../i18n/locale';
import {
  ACCEPTED_IMAGE_MIMES,
  fileToImageAttachment,
  formatBytes,
  hasMention,
  parseMentionTrigger,
  reserveImageFiles,
  reserveUploadFiles,
  type ComposerAttachment,
} from '../lib/attachments';
import {
  buildSlashItems,
  classifySlashSubmission,
  completeSlashTrigger,
  filterSlashItems,
  parseSlashTrigger,
  type SlashActionId,
  type SlashItem,
} from '../lib/slashCommands';
import { registerOverlay } from '../lib/uiBusy';
import type { SelectionAnnotation } from '../lib/selectionQuote';
import {
  isComposerSendKey,
  settingsServerSnapshot,
  settingsSnapshot,
  subscribeSettings,
  type ComposerModelSource,
} from '../lib/settings';
import { useConnection } from '../state/connection';
import { ContextMeter } from './ContextMeter';
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

/** The effort visible in the select is also the value submitted on send. */
export function resolveSelectedEffort(
  efforts: readonly string[] | undefined,
  effortOverride: string | undefined,
  defaultEffort: string | undefined,
): string | undefined {
  if (efforts === undefined || efforts.length === 0) return undefined;
  if (effortOverride !== undefined && efforts.includes(effortOverride)) return effortOverride;
  if (defaultEffort !== undefined && efforts.includes(defaultEffort)) return defaultEffort;
  return efforts[0];
}

type ComposerMenu =
  | { kind: 'slash'; start: number; end: number; query: string; inline: boolean }
  | { kind: 'mention'; start: number; query: string };

export function Composer({
  busy,
  disabled,
  value,
  onChange,
  model,
  defaultModel,
  serverDefaultModel,
  modelSource,
  permissionMode,
  planMode,
  swarmMode,
  goalObjective,
  goalStatus,
  goalControl,
  efforts,
  effort,
  contextUsage,
  sessionUsage,
  busyPlaceholder,
  sessionId,
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
  onChangePermissionMode,
  onChangePlanMode,
  onChangeSwarmMode,
  onChangeGoalObjective,
  onChangeGoalControl,
  onChangeEffort,
  onSend,
  onAbort,
  autoFocus,
}: {
  busy: boolean;
  disabled: boolean;
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
  permissionMode: PermissionMode;
  /** PromptSubmission.plan_mode — the wire field name (verified). */
  planMode: boolean;
  /** PromptSubmission.swarm_mode — enables concurrent subagent orchestration. */
  swarmMode: boolean;
  goalObjective: string;
  goalStatus: 'active' | 'paused' | 'blocked' | 'complete' | undefined;
  goalControl: 'pause' | 'resume' | 'cancel' | undefined;
  /** support_efforts of the effective model; effort UI hides when absent. */
  efforts: readonly string[] | undefined;
  effort: string | undefined;
  /** Session context usage for the footer's mini meter (hidden when absent). */
  contextUsage?: { readonly used: number; readonly limit: number };
  /** Lifetime session usage for the context meter's detail card (hidden when absent). */
  sessionUsage?: SessionUsage;
  /** Placeholder while busy (queue steering on /s, creation progress on /new). */
  busyPlaceholder?: string;
  /** Session scope for the skills catalog + session-scoped shortcuts. */
  sessionId?: string;
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
  onActivateSkill?: (name: string, args: string, attachments: readonly ComposerAttachment[]) => void;
  /** Session-scoped shortcuts (/fork, /undo, /compact). */
  onSessionAction?: (action: 'fork' | 'undo' | 'compact') => void;
  /** The context meter's click target (asks the session to compact). */
  onCompactContext?: () => void;
  onChangeModel: (model: string | undefined) => void;
  onChangePermissionMode: (mode: PermissionMode) => void;
  onChangePlanMode: (on: boolean) => void;
  onChangeSwarmMode: (on: boolean) => void;
  onChangeGoalObjective: (objective: string) => void;
  onChangeGoalControl: (control: 'pause' | 'resume' | 'cancel' | undefined) => void;
  onChangeEffort: (effort: string) => void;
  onSend: (text: string, attachments: readonly ComposerAttachment[]) => void;
  /** Omit when there is nothing to abort (e.g. /new session creation). */
  onAbort?: () => void;
  /** Marks the textarea as the dialog's initial-focus target (`data-autofocus`). */
  autoFocus?: boolean;
}) {
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
  const [goalOpen, setGoalOpen] = useState(false);
  const [menu, setMenu] = useState<ComposerMenu | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [mentionQuery, setMentionQuery] = useState('');
  // A slash-looking draft that resolved to nothing: send is held until the
  // user confirms plain-text shipping (typo guard) or edits the draft.
  const [slashConfirm, setSlashConfirm] = useState<{
    name: string;
    reason: 'unknown' | 'disabled';
  } | null>(null);

  const modelsQuery = useQuery({
    queryKey: ['models'],
    queryFn: () => client.listModels(),
    staleTime: 60_000,
  });
  const models = modelsQuery.data?.items ?? [];

  // Model picker options: the inherit entry first, then the catalog; the model
  // id rides `keywords` so searching works against display names AND raw ids.
  const modelOptions: readonly SearchableSelectOption[] = useMemo(
    () => [
      {
        value: '',
        label:
          defaultModel !== undefined
            ? t('composer.inheritSession', { model: defaultModel })
            : t(
                modelSource === 'local-default'
                  ? 'composer.inheritLocal'
                  : 'composer.inheritServer',
                { model: serverDefaultModel ?? t('composer.unknown') },
              ),
      },
      ...models.map((item) => ({
        value: item.model,
        label: `${item.display_name ?? item.model}${item.model === defaultModel ? t('composer.sessionDefaultSuffix') : ''}`,
        hint: item.provider,
        keywords: item.model,
        title: item.model,
      })),
    ],
    [models, defaultModel, serverDefaultModel, modelSource, t],
  );

  // The composer mount now survives route changes (the conversation shell owns
  // it), so session-scoped transient UI must reset when the session under it
  // changes: an open menu would otherwise filter A's catalog with B's draft.
  const previousSessionIdRef = useRef(sessionId);
  useEffect(() => {
    if (previousSessionIdRef.current === sessionId) return;
    previousSessionIdRef.current = sessionId;
    setMenu(null);
    setSlashConfirm(null);
  }, [sessionId]);

  // Skill catalog for the slash menu — session-scoped on the wire (the
  // catalog depends on the session cwd); /new gets client shortcuts only.
  const skillsQuery = useQuery({
    queryKey: ['skills', sessionId],
    queryFn: () => client.listSessionSkills(sessionId!),
    enabled: sessionId !== undefined,
    staleTime: 60_000,
  });
  const skills = skillsQuery.data?.skills ?? [];

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
  }, [menuQuery, menu?.kind]);

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

  const canSend =
    (text.trim() !== '' || attachments.length > 0) && !disabled && !pendingAttachments;

  const runAction = (action: SlashActionId) => {
    switch (action) {
      case 'plan':
        onChangePlanMode(!planMode);
        break;
      case 'goal':
        setGoalOpen(true);
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
      onChange(completed.text);
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
    onChange(next);
    const currentAttachments = attachmentBaselineRef.current;
    if (!hasMention(currentAttachments, hit.path)) {
      updateAttachments([
        ...currentAttachments,
        { kind: 'file', path: hit.path, name: hit.name, isDir: hit.kind === 'directory' },
      ]);
    }
    node?.focus();
  };

  const addImageFiles = (files: File[]) => {
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
    void Promise.all(accepted.map((file) => fileToImageAttachment(file)))
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

  const addUploadFiles = (files: File[]) => {
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
      client
        .uploadFile(file)
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

  /** Drop/paste entry point: whitelisted images stay image parts; everything else uploads. */
  const addFiles = (files: File[]) => {
    const images: File[] = [];
    const uploads: File[] = [];
    for (const file of files) {
      if (ACCEPTED_IMAGE_MIMES.includes(file.type)) images.push(file);
      else uploads.push(file);
    }
    if (images.length > 0) addImageFiles(images);
    if (uploads.length > 0) addUploadFiles(uploads);
  };

  // Drag-highlight depth counter: dragenter/dragleave fire on every child
  // boundary crossing, so a boolean would flicker the overlay off mid-drag.
  const dragDepthRef = useRef(0);
  const [dragActive, setDragActive] = useState(false);
  const dragHasFiles = (event: DragEvent) =>
    [...event.dataTransfer.types].includes('Files');

  const send = () => {
    if (!canSend) return;
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
    // Every hand-off below consumes the draft, so close any stale menu.
    setMenu(null);
    // Submit-time command resolution: `/name args…` for a known entry runs the
    // command; a slash-looking draft that resolves to nothing is intercepted
    // for an explicit confirm — a typo never silently ships as prompt text.
    const classified = classifySlashSubmission(slashItems, text.trim());
    if (classified !== null) {
      if (classified.kind === 'unknown' || classified.kind === 'disabled') {
        setSlashConfirm({
          name: classified.kind === 'unknown' ? classified.name : classified.item.name,
          reason: classified.kind,
        });
        return;
      }
      if (classified.item.kind === 'skill' && onActivateSkill !== undefined) {
        onActivateSkill(classified.item.name, classified.args, attachments);
        return;
      }
      if (classified.item.kind === 'action' && classified.item.action !== undefined) {
        onChange('');
        runAction(classified.item.action);
        return;
      }
    }
    onSend(text.trim(), attachments);
  };

  /** "Send anyway" from the typo guard: plain prompt, no command resolution. */
  const confirmSendPlain = () => {
    if (!canSend) return;
    setSlashConfirm(null);
    setMenu(null);
    onSend(text.trim(), attachments);
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
    if (event.nativeEvent.isComposing) return;
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

  return (
    <div className="px-6 pb-5">
      {composerContextMenu}
      {/* One width axis with the transcript: the conversation shell declares
          --kiki-chat-content-width; the 760px fallback is defensive. */}
      <div className="mx-auto max-w-[var(--kiki-chat-content-width,760px)]">
        <div
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
            if (files.length > 0) {
              event.preventDefault();
              addFiles(files);
            }
          }}
        >
          {dragActive ? (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent/60 bg-panel/85">
              <span className="text-[12px] font-medium text-accent">{t('composer.dropFiles')}</span>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5 px-3.5 pt-2.5">
            {MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                title={t(mode.hintKey)}
                onClick={() => { onChangePermissionMode(mode.id); }}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                  permissionMode === mode.id
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-hairline text-ink-soft hover:border-hairline-strong'
                }`}
              >
                {t(mode.labelKey)}
              </button>
            ))}
            <span className="mx-1 h-3 w-px bg-hairline" />
            <button
              type="button"
              title={t('composer.planHint')}
              aria-pressed={planMode}
              onClick={() => { onChangePlanMode(!planMode); }}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                planMode
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-hairline text-ink-soft hover:border-hairline-strong'
              }`}
            >
              {t('composer.plan')}
            </button>
            <button
              type="button"
              title={t('composer.swarmHint')}
              aria-pressed={swarmMode}
              onClick={() => { onChangeSwarmMode(!swarmMode); }}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                swarmMode
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-hairline text-ink-soft hover:border-hairline-strong'
              }`}
            >
              {t('composer.swarm')}
            </button>
            <div className="relative">
              <button
                type="button"
                onClick={() => { setGoalOpen((open) => !open); }}
                aria-expanded={goalOpen}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                  goalOpen || goalObjective !== '' || goalStatus !== undefined
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-hairline text-ink-soft hover:border-hairline-strong'
                }`}
              >
                {t('composer.goal')}
                {goalStatus !== undefined ? ` · ${t(`composer.goalStatus.${goalStatus}`)}` : ''}
              </button>
              {goalOpen ? (
                <div className="anim-enter absolute bottom-7 left-0 z-30 w-72 rounded-xl border border-hairline bg-panel p-3 shadow-[0_12px_32px_-12px_rgba(28,25,23,0.35)]">
                  <label className="text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
                    {t('composer.goalObjective')}
                  </label>
                  <input
                    value={goalObjective}
                    onChange={(event) => { onChangeGoalObjective(event.target.value); }}
                    placeholder={t('composer.goalObjectivePlaceholder')}
                    className="mt-1.5 w-full rounded-lg border border-hairline bg-paper px-2.5 py-1.5 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
                  />
                  <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-faint">
                    {t('composer.goalNoteBefore')}
                    <span className="font-mono">goal_objective</span>
                    {t('composer.goalNoteAfter')}
                  </p>
                  {goalStatus !== undefined && goalStatus !== 'complete' ? (
                    <div className="mt-2 flex gap-1.5 border-t border-hairline pt-2">
                      {(goalStatus === 'paused' ? ['resume', 'cancel'] : ['pause', 'cancel']).map((control) => (
                        <button
                          key={control}
                          type="button"
                          onClick={() => {
                            onChangeGoalControl(
                              goalControl === control
                                ? undefined
                                : (control as 'pause' | 'resume' | 'cancel'),
                            );
                          }}
                          className={`rounded-full border px-2 py-0.5 text-[10.5px] ${
                            goalControl === control
                              ? 'border-accent bg-accent-soft text-accent'
                              : 'border-hairline text-ink-soft'
                          }`}
                        >
                          {t(`composer.goalControl.${control as 'pause' | 'resume' | 'cancel'}`)}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            {models.length === 0 ? (
              <span
                className="max-w-56 truncate rounded-full border border-hairline bg-panel px-2 py-0.5 font-mono text-[11px] text-ink-soft"
                title={t('composer.modelTitle', { source: t(`composer.modelSource.${modelSource}`) })}
              >
                {effectiveModel ?? t('composer.inheritDefault')}
              </span>
            ) : (
              <SearchableSelect
                id="composer-model-select"
                options={modelOptions}
                value={model ?? ''}
                onChange={(next) => { onChangeModel(next === '' ? undefined : next); }}
                title={t('composer.modelTitle', { source: t(`composer.modelSource.${modelSource}`) })}
                ariaLabel={t('composer.modelAria')}
                placement="above"
                panelClassName="anim-enter absolute z-40 bottom-full left-0 mb-1 w-72 max-w-[calc(100vw-48px)] overflow-hidden rounded-xl border border-hairline bg-panel shadow-[0_12px_32px_-12px_rgba(28,25,23,0.35)]"
                buttonClassName="flex max-w-56 items-center gap-1 rounded-full border border-hairline bg-panel px-2 py-0.5 font-mono text-[11px] text-ink-soft outline-none transition-colors hover:border-hairline-strong focus:border-accent focus:ring-2 focus:ring-accent/30"
              />
            )}
            {efforts !== undefined && efforts.length > 0 && effort !== undefined ? (
              <select
                className="rounded-full border border-hairline bg-panel px-2 py-0.5 font-mono text-[11px] text-ink-soft outline-none transition-colors hover:border-hairline-strong focus:border-accent"
                value={effort}
                onChange={(event) => { onChangeEffort(event.target.value); }}
                title={t('composer.effortTitle')}
              >
                {efforts.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            ) : null}

          </div>

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
          {attachments.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 px-3.5 pt-2" data-attachment-chips>
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

          <div className="relative flex items-end gap-2 px-3.5 pt-1.5 pb-3">
            {menu !== null ? (
              <div
                data-composer-menu
                role="listbox"
                aria-label={menu.kind === 'slash' ? t('composer.slashAria') : t('composer.filesAria')}
                className="anim-enter absolute right-0 bottom-full left-0 z-30 mb-1 max-h-72 overflow-y-auto rounded-xl border border-hairline bg-panel p-1 shadow-[0_12px_32px_-12px_rgba(28,25,23,0.35)]"
                // Keep textarea focus while rows are clicked.
                onMouseDown={(event) => { event.preventDefault(); }}
              >
                {menu.kind === 'slash' ? (
                  <SlashMenuBody
                    items={filteredSlashItems}
                    activeIndex={activeIndex}
                    skillsFailed={skillsQuery.isError}
                    hasSession={sessionId !== undefined}
                    onAccept={acceptSlashItem}
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
            <textarea
              ref={textareaRef}
              rows={1}
              value={text}
              data-composer
              data-autofocus={autoFocus === true ? '' : undefined}
              disabled={disabled}
              onChange={(event) => {
                onChange(event.target.value);
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
                addFiles(files);
              }}
              placeholder={
                busy
                  ? (busyPlaceholder ?? t('composer.placeholderBusy'))
                  : t('composer.placeholder')
              }
              className="max-h-[190px] min-h-[24px] flex-1 resize-none bg-transparent text-[14px] leading-relaxed text-ink outline-none placeholder:text-ink-faint disabled:opacity-60"
            />
            {busy && onAbort !== undefined ? (
              <button
                type="button"
                onClick={onAbort}
                title={t('composer.abortTitle')}
                aria-label={t('composer.abortTitle')}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-danger/40 text-danger transition-colors hover:bg-danger/10 focus-visible:ring-2 focus-visible:ring-danger/40 focus-visible:outline-none"
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
              title={busy
                ? t(sendShortcut === 'cmd-enter' ? 'composer.queueTitleCmdEnter' : 'composer.queueTitle')
                : t(sendShortcut === 'cmd-enter' ? 'composer.sendTitleCmdEnter' : 'composer.sendTitle')}
              aria-label={busy ? t('composer.queueAria') : t('composer.sendAria')}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-accent text-white transition-colors hover:bg-accent-deep disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:outline-none"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path
                  d="M2.5 8h10M9 3.5 13.5 8 9 12.5"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
        <div className="mt-1.5 flex items-center gap-3">
          <p className="min-w-0 flex-1 text-center text-[10.5px] text-ink-faint">
            {t(sendShortcut === 'cmd-enter' ? 'composer.footerBaseCmdEnter' : 'composer.footerBase')}
            {t(sessionId !== undefined ? 'composer.footerSkills' : 'composer.footerShortcuts')}
            {fsSearch !== undefined ? t('composer.footerFiles') : ''}
          </p>
          {contextUsage !== undefined ? (
            <ContextMeter
              used={contextUsage.used}
              limit={contextUsage.limit}
              usage={sessionUsage}
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
}: {
  items: readonly SlashItem[];
  activeIndex: number;
  skillsFailed: boolean;
  hasSession: boolean;
  onAccept: (item: SlashItem) => void;
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
        className={`flex w-full items-baseline gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors ${
          item.disabled === true ? 'opacity-50' : ''
        } ${active ? 'bg-accent-soft' : 'hover:bg-paper'}`}
      >
        <span className="shrink-0 font-mono text-[12px] font-medium text-accent">
          /{item.name}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-soft">
          {item.kind === 'action' && item.action !== undefined
            ? t(SLASH_ACTION_DESCRIPTIONS[item.action])
            : item.description}
        </span>
        {item.disabled === true ? (
          <span className="shrink-0 text-[9.5px] text-ink-faint">{t('composer.slash.notActivatable')}</span>
        ) : item.kind === 'skill' ? (
          <span className="shrink-0 text-[9.5px] text-ink-faint">{t('composer.slash.skillBadge')}</span>
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
