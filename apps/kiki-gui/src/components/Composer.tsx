/**
 * Composer — floating rounded-2xl card: permission-mode pills above a
 * multiline input (Enter sends, Shift+Enter newline), model selector fed from
 * the server catalog, accent send button; busy state swaps in Abort.
 */

import { useEffect, useRef, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { PermissionMode } from '@moonshot-ai/protocol';

import { useConnection } from '../state/connection';

const MODES: readonly { id: PermissionMode; hint: string }[] = [
  { id: 'manual', hint: 'Approve every action' },
  { id: 'auto', hint: 'Approve reads, ask for writes' },
  { id: 'yolo', hint: 'Never ask' },
];

export function Composer({
  busy,
  disabled,
  value,
  onChange,
  model,
  defaultModel,
  serverDefaultModel,
  permissionMode,
  planMode,
  efforts,
  effort,
  onChangeModel,
  onChangePermissionMode,
  onChangePlanMode,
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
  permissionMode: PermissionMode;
  /** PromptSubmission.plan_mode — the wire field name (verified). */
  planMode: boolean;
  /** support_efforts of the effective model; effort UI hides when absent. */
  efforts: readonly string[] | undefined;
  effort: string | undefined;
  onChangeModel: (model: string | undefined) => void;
  onChangePermissionMode: (mode: PermissionMode) => void;
  onChangePlanMode: (on: boolean) => void;
  onChangeEffort: (effort: string) => void;
  onSend: (text: string) => void;
  onAbort: () => void;
}) {
  const { client } = useConnection();
  const text = value;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const modelsQuery = useQuery({
    queryKey: ['models'],
    queryFn: () => client.listModels(),
    staleTime: 60_000,
  });
  const models = modelsQuery.data?.items ?? [];

  // Autosize the textarea up to ~8 lines.
  useEffect(() => {
    const node = textareaRef.current;
    if (node === null) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 190)}px`;
  }, [text]);

  const canSend = text.trim() !== '' && !disabled;

  const send = () => {
    if (!canSend) return;
    onSend(text.trim());
    onChange('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  const effectiveModel = model ?? defaultModel ?? serverDefaultModel;

  return (
    <div className="px-6 pb-5">
      <div className="mx-auto max-w-[760px]">
        <div className="rounded-2xl border border-hairline bg-panel shadow-[0_2px_4px_rgba(28,25,23,0.03),0_16px_40px_-20px_rgba(28,25,23,0.18)]">
          <div className="flex items-center gap-1.5 px-3.5 pt-2.5">
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
              onClick={() => onChangePlanMode(!planMode)}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                planMode
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-hairline text-ink-soft hover:border-hairline-strong'
              }`}
            >
              plan
            </button>
            <select
              className="max-w-56 truncate rounded-full border border-hairline bg-panel px-2 py-0.5 font-mono text-[11px] text-ink-soft outline-none transition-colors hover:border-hairline-strong focus:border-accent"
              value={effectiveModel ?? ''}
              onChange={(event) =>
                onChangeModel(event.target.value === '' ? undefined : event.target.value)
              }
              title="Model"
            >
              {models.length === 0 ? (
                <option value="">{effectiveModel ?? 'server default'}</option>
              ) : (
                <>
                  <option value="">server default</option>
                  {models.map((item) => (
                    <option key={`${item.provider}/${item.model}`} value={item.model}>
                      {item.display_name ?? item.model}
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

          <div className="flex items-end gap-2 px-3.5 pt-1.5 pb-3">
            <textarea
              ref={textareaRef}
              rows={1}
              value={text}
              data-composer
              disabled={disabled}
              onChange={(event) => onChange(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={busy ? 'Steer kiki — this queues while it works…' : 'Ask kiki anything…'}
              className="max-h-[190px] min-h-[24px] flex-1 resize-none bg-transparent text-[14px] leading-relaxed text-ink outline-none placeholder:text-ink-faint disabled:opacity-60"
            />
            {busy ? (
              <button
                type="button"
                onClick={onAbort}
                title="Abort the running prompt"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-danger/40 text-danger transition-colors hover:bg-danger/10"
              >
                <span aria-hidden className="text-[11px] font-bold">■</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={send}
                disabled={!canSend}
                title="Send (Enter)"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-accent text-white transition-colors hover:bg-accent-deep disabled:opacity-40"
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
            )}
          </div>
        </div>
        <p className="mt-1.5 text-center text-[10.5px] text-ink-faint">
          Enter to send · Shift+Enter for a new line
        </p>
      </div>
    </div>
  );
}
