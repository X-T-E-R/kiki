/**
 * Composer — floating rounded-2xl card: permission-mode pills above a
 * multiline input (Enter sends, Shift+Enter newline), model selector fed from
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
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import type { FsSearchHit, PermissionMode } from '@moonshot-ai/protocol';

import {
  fileToImageAttachment,
  formatBytes,
  hasMention,
  parseMentionTrigger,
  validateImageFile,
  type ComposerAttachment,
} from '../lib/attachments';
import {
  buildSlashItems,
  filterSlashItems,
  resolveSlashCommand,
  type SlashActionId,
  type SlashItem,
} from '../lib/slashCommands';
import { registerOverlay } from '../lib/uiBusy';
import { useConnection } from '../state/connection';

const MODES: readonly { id: PermissionMode; hint: string }[] = [
  { id: 'manual', hint: 'Approve every action' },
  { id: 'auto', hint: 'Approve reads, ask for writes' },
  { id: 'yolo', hint: 'Never ask' },
];

const MENTION_DEBOUNCE_MS = 250;
const MENTION_ROW_LIMIT = 8;

type ComposerMenu =
  | { kind: 'slash'; query: string }
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
  busyPlaceholder,
  sessionId,
  fsSearch,
  mentionScopeKey,
  attachments,
  onChangeAttachments,
  onActivateSkill,
  onSessionAction,
  onChangeModel,
  onChangePermissionMode,
  onChangePlanMode,
  onChangeSwarmMode,
  onChangeGoalObjective,
  onChangeGoalControl,
  onChangeEffort,
  onSend,
  onAbort,
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
  modelSource: 'server-default' | 'session' | 'override';
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
  onChangeAttachments: (next: readonly ComposerAttachment[]) => void;
  /** Skill activation — the wire path for slash commands (POST :activate). */
  onActivateSkill?: (name: string, args: string, attachments: readonly ComposerAttachment[]) => void;
  /** Session-scoped shortcuts (/fork, /undo, /compact). */
  onSessionAction?: (action: 'fork' | 'undo' | 'compact') => void;
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
}) {
  const { client } = useConnection();
  const navigate = useNavigate();
  const text = value;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [goalOpen, setGoalOpen] = useState(false);
  const [menu, setMenu] = useState<ComposerMenu | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [mentionQuery, setMentionQuery] = useState('');

  const modelsQuery = useQuery({
    queryKey: ['models'],
    queryFn: () => client.listModels(),
    staleTime: 60_000,
  });
  const models = modelsQuery.data?.items ?? [];

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
  const filteredSlashItems = useMemo(
    () => (menu?.kind === 'slash' ? filterSlashItems(slashItems, menu.query) : []),
    [menu, slashItems],
  );

  // Debounced file-picker query (fires only while the mention menu is open).
  useEffect(() => {
    if (menu?.kind !== 'mention') return;
    const timer = setTimeout(() => setMentionQuery(menu.query), MENTION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
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

  const canSend = (text.trim() !== '' || attachments.length > 0) && !disabled;

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
    setMenu(null);
    if (item.kind === 'skill') {
      onChange(`/${item.name} `);
      // Caret to end after the controlled value lands in the DOM.
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (node !== null) {
          node.focus();
          node.setSelectionRange(node.value.length, node.value.length);
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
    if (!hasMention(attachments, hit.path)) {
      onChangeAttachments([
        ...attachments,
        { kind: 'file', path: hit.path, name: hit.name, isDir: hit.kind === 'directory' },
      ]);
    }
    node?.focus();
  };

  const addImageFiles = (files: File[]) => {
    // Validate the whole batch first (a size stub reserves capacity so the
    // per-image and per-message caps hold within one paste/drop), then read.
    let batch: readonly ComposerAttachment[] = attachments;
    const accepted: File[] = [];
    for (const file of files) {
      const problem = validateImageFile(file, batch);
      if (problem !== null) {
        setAttachmentError(problem);
        continue;
      }
      accepted.push(file);
      batch = [
        ...batch,
        {
          kind: 'image',
          name: file.name,
          mediaType: file.type,
          data: '',
          size: file.size,
          previewUrl: '',
        },
      ];
    }
    if (accepted.length === 0) return;
    setAttachmentError(null);
    void Promise.all(accepted.map((file) => fileToImageAttachment(file)))
      .then((images) => onChangeAttachments([...attachments, ...images]))
      .catch((error: unknown) => {
        setAttachmentError(error instanceof Error ? error.message : String(error));
      });
  };

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
    // command; anything else is plain prompt text (no invented commands).
    const resolved = resolveSlashCommand(slashItems, text.trim());
    if (resolved !== null) {
      if (resolved.item.kind === 'skill' && onActivateSkill !== undefined) {
        onActivateSkill(resolved.item.name, resolved.args, attachments);
        return;
      }
      if (resolved.item.kind === 'action' && resolved.item.action !== undefined) {
        onChange('');
        runAction(resolved.item.action);
        return;
      }
    }
    onSend(text.trim(), attachments);
  };

  /** Recompute the trigger-driven menu after any text/caret change. */
  const refreshMenu = (nextText: string, cursor: number) => {
    const slashMatch = /^\/(\S*)$/.exec(nextText);
    if (slashMatch !== null) {
      setMenu({ kind: 'slash', query: slashMatch[1] ?? '' });
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
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  const effectiveModel = model ?? defaultModel ?? serverDefaultModel;

  return (
    <div className="px-6 pb-5">
      <div className="mx-auto max-w-[760px]">
        <div
          className="rounded-2xl border border-hairline bg-panel shadow-[0_2px_4px_rgba(28,25,23,0.03),0_16px_40px_-20px_rgba(28,25,23,0.18)]"
          onDragOver={(event) => {
            if ([...event.dataTransfer.types].includes('Files')) event.preventDefault();
          }}
          onDrop={(event) => {
            const files = [...event.dataTransfer.files].filter((file) => file.type !== '');
            if (files.length > 0) {
              event.preventDefault();
              addImageFiles(files);
            }
          }}
        >
          <div className="flex flex-wrap items-center gap-1.5 px-3.5 pt-2.5">
            {MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                title={mode.hint}
                onClick={() => onChangePermissionMode(mode.id)}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                  permissionMode === mode.id
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-hairline text-ink-soft hover:border-hairline-strong'
                }`}
              >
                {mode.id}
              </button>
            ))}
            <span className="mx-1 h-3 w-px bg-hairline" />
            <button
              type="button"
              title="Plan mode — kiki proposes a plan before acting"
              aria-pressed={planMode}
              onClick={() => onChangePlanMode(!planMode)}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                planMode
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-hairline text-ink-soft hover:border-hairline-strong'
              }`}
            >
              plan
            </button>
            <button
              type="button"
              title="Swarm mode — allow concurrent subagent work"
              aria-pressed={swarmMode}
              onClick={() => onChangeSwarmMode(!swarmMode)}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                swarmMode
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-hairline text-ink-soft hover:border-hairline-strong'
              }`}
            >
              swarm
            </button>
            <div className="relative">
              <button
                type="button"
                onClick={() => setGoalOpen((open) => !open)}
                aria-expanded={goalOpen}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                  goalOpen || goalObjective !== '' || goalStatus !== undefined
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-hairline text-ink-soft hover:border-hairline-strong'
                }`}
              >
                goal{goalStatus !== undefined ? ` · ${goalStatus}` : ''}
              </button>
              {goalOpen ? (
                <div className="anim-enter absolute bottom-7 left-0 z-30 w-72 rounded-xl border border-hairline bg-panel p-3 shadow-[0_12px_32px_-12px_rgba(28,25,23,0.35)]">
                  <label className="text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
                    Goal objective
                  </label>
                  <input
                    value={goalObjective}
                    onChange={(event) => onChangeGoalObjective(event.target.value)}
                    placeholder="Objective (optional)"
                    className="mt-1.5 w-full rounded-lg border border-hairline bg-paper px-2.5 py-1.5 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
                  />
                  <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-faint">
                    Sent as <span className="font-mono">goal_objective</span> with the next prompt.
                  </p>
                  {goalStatus !== undefined && goalStatus !== 'complete' ? (
                    <div className="mt-2 flex gap-1.5 border-t border-hairline pt-2">
                      {(goalStatus === 'paused' ? ['resume', 'cancel'] : ['pause', 'cancel']).map((control) => (
                        <button
                          key={control}
                          type="button"
                          onClick={() =>
                            onChangeGoalControl(
                              goalControl === control
                                ? undefined
                                : (control as 'pause' | 'resume' | 'cancel'),
                            )
                          }
                          className={`rounded-full border px-2 py-0.5 text-[10.5px] ${
                            goalControl === control
                              ? 'border-accent bg-accent-soft text-accent'
                              : 'border-hairline text-ink-soft'
                          }`}
                        >
                          {control}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            <select
              className="max-w-56 truncate rounded-full border border-hairline bg-panel px-2 py-0.5 font-mono text-[11px] text-ink-soft outline-none transition-colors hover:border-hairline-strong focus:border-accent focus:ring-2 focus:ring-accent/30"
              value={model ?? ''}
              onChange={(event) =>
                onChangeModel(event.target.value === '' ? undefined : event.target.value)
              }
              title={`Model — ${modelSource} source`}
              aria-label="Model"
            >
              {models.length === 0 ? (
                <option value="">{effectiveModel ?? 'inherit default'}</option>
              ) : (
                <>
                  <option value="">
                    {defaultModel !== undefined
                      ? `inherit session · ${defaultModel}`
                      : `inherit server default · ${serverDefaultModel ?? 'unknown'}`}
                  </option>
                  {models.map((item) => (
                    <option key={`${item.provider}/${item.model}`} value={item.model}>
                      {item.display_name ?? item.model}
                      {item.model === defaultModel ? ' · session default' : ''}
                    </option>
                  ))}
                </>
              )}
            </select>
            {efforts !== undefined && efforts.length > 0 && effort !== undefined ? (
              <select
                className="rounded-full border border-hairline bg-panel px-2 py-0.5 font-mono text-[11px] text-ink-soft outline-none transition-colors hover:border-hairline-strong focus:border-accent"
                value={effort}
                onChange={(event) => onChangeEffort(event.target.value)}
                title="Thinking effort"
              >
                {efforts.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            ) : null}

          </div>

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
                      aria-label={`Remove ${attachment.name}`}
                      onClick={() =>
                        onChangeAttachments(attachments.filter((_, i) => i !== index))
                      }
                      className="flex h-4 w-4 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-hairline hover:text-ink"
                    >
                      ×
                    </button>
                  </span>
                ) : (
                  <span
                    key={`image-${attachment.name}-${attachment.size}`}
                    title={`${attachment.name} · ${formatBytes(attachment.size)}`}
                    className="flex items-center gap-1.5 rounded-full border border-hairline bg-paper py-0.5 pr-1 pl-0.5 text-[11px] text-ink-soft"
                  >
                    <img
                      src={attachment.previewUrl}
                      alt={attachment.name}
                      className="h-5 w-5 rounded-full object-cover"
                    />
                    <span className="max-w-32 truncate">{attachment.name}</span>
                    <span className="font-mono text-[9.5px] text-ink-faint">
                      {formatBytes(attachment.size)}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${attachment.name}`}
                      onClick={() =>
                        onChangeAttachments(attachments.filter((_, i) => i !== index))
                      }
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

          <div className="relative flex items-end gap-2 px-3.5 pt-1.5 pb-3">
            {menu !== null ? (
              <div
                data-composer-menu
                role="listbox"
                aria-label={menu.kind === 'slash' ? 'Slash commands' : 'Files'}
                className="anim-enter absolute right-0 bottom-full left-0 z-30 mb-1 max-h-72 overflow-y-auto rounded-xl border border-hairline bg-panel p-1 shadow-[0_12px_32px_-12px_rgba(28,25,23,0.35)]"
                // Keep textarea focus while rows are clicked.
                onMouseDown={(event) => event.preventDefault()}
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
              disabled={disabled}
              onChange={(event) => {
                onChange(event.target.value);
                refreshMenu(event.target.value, event.target.selectionStart);
              }}
              onKeyDown={onKeyDown}
              onKeyUp={(event) => {
                // Caret moves (arrows/Home/End) re-evaluate the trigger.
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                  refreshMenu(text, event.currentTarget.selectionStart);
                }
              }}
              onClick={(event) => refreshMenu(text, event.currentTarget.selectionStart)}
              onBlur={() => setMenu(null)}
              onPaste={(event) => {
                const files = [...event.clipboardData.files];
                if (files.length === 0) return;
                event.preventDefault();
                addImageFiles(files);
              }}
              placeholder={
                busy
                  ? (busyPlaceholder ?? 'Steer kiki — this queues while it works…')
                  : 'Ask kiki anything…'
              }
              className="max-h-[190px] min-h-[24px] flex-1 resize-none bg-transparent text-[14px] leading-relaxed text-ink outline-none placeholder:text-ink-faint disabled:opacity-60"
            />
            {busy && onAbort !== undefined ? (
              <button
                type="button"
                onClick={onAbort}
                title="Abort the running prompt"
                aria-label="Abort the running prompt"
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
              title={busy ? 'Queue this prompt (Enter)' : 'Send (Enter)'}
              aria-label={busy ? 'Queue prompt' : 'Send message'}
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
        <p className="mt-1.5 text-center text-[10.5px] text-ink-faint">
          Enter to send · Shift+Enter for a new line{sessionId !== undefined ? ' · / for skills' : ' · / for shortcuts'}
          {fsSearch !== undefined ? ' · @ for files' : ''}
        </p>
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
        onClick={() => onAccept(item)}
        className={`flex w-full items-baseline gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors ${
          item.disabled === true ? 'opacity-50' : ''
        } ${active ? 'bg-accent-soft' : 'hover:bg-paper'}`}
      >
        <span className="shrink-0 font-mono text-[12px] font-medium text-accent">
          /{item.name}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-soft">
          {item.description}
        </span>
        {item.disabled === true ? (
          <span className="shrink-0 text-[9.5px] text-ink-faint">not activatable</span>
        ) : item.kind === 'skill' ? (
          <span className="shrink-0 text-[9.5px] text-ink-faint">skill</span>
        ) : null}
      </button>
    );
  };
  return (
    <>
      {skills.length > 0 ? (
        <>
          <p className="px-2.5 pt-1 pb-0.5 text-[9.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
            Skills
          </p>
          {skills.map(renderRow)}
        </>
      ) : null}
      {actions.length > 0 ? (
        <>
          <p className="px-2.5 pt-1 pb-0.5 text-[9.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
            Shortcuts
          </p>
          {actions.map(renderRow)}
        </>
      ) : null}
      {items.length === 0 ? (
        <p className="px-2.5 py-2 text-[11.5px] text-ink-faint">
          No matching commands — Enter sends the line as a plain prompt.
        </p>
      ) : null}
      {skillsFailed && hasSession ? (
        <p className="border-t border-hairline px-2.5 py-1 font-mono text-[9.5px] text-ink-faint">
          Could not load skills — showing shortcuts only.
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
  if (failed) {
    return (
      <p className="px-2.5 py-2 font-mono text-[10.5px] text-danger">
        File search failed — the picker is unavailable for this session.
      </p>
    );
  }
  if (items.length === 0) {
    return (
      <p className="px-2.5 py-2 text-[11.5px] text-ink-faint">
        {loading ? 'Searching files…' : query === '' ? 'No files in this workspace.' : `No files match "${query}".`}
      </p>
    );
  }
  return (
    <>
      <p className="px-2.5 pt-1 pb-0.5 text-[9.5px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
        Files — mentioned as @path in the prompt
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
            onClick={() => onAccept(item)}
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
