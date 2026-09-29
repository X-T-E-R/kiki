/**
 * Shared scaffolding for the composer variants: a conversation sheet with a
 * few settled turns, and the composer card's fixed anatomy (input, toolbar,
 * send/stop). Variants differ only in where the surrounding state goes, so
 * everything that does not carry state lives here and looks the same in all
 * four.
 */

import type { ReactNode } from 'react';

import { AnnotationChip, ImageTile, TextTile } from '../ContextChips';
import { Icon } from '../icons';
import { COPY } from './copy';
import { PREVIEW_IMAGE } from './mockBlocks';
import type { ComposerMockState } from './states';

export const WIDTH_CLASS = 'mx-auto w-full max-w-[760px]';

/** The settled conversation every preview sits under. */
function MockTurns() {
  return (
    <>
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-[14px] rounded-br-[6px] bg-bubble-user px-4 py-2.5 text-[14px] leading-[1.6] text-ink">
          把 transcript 的分页读一遍，告诉我长会话打开时发生了什么。
        </div>
      </div>
      <p className="flex items-center gap-2 text-[12.5px] text-ink-faint">
        <Icon name="read" size={14} />
        已处理 · 8 步 · 2 次思考
      </p>
      <div className="kiki-prose text-[15px] leading-[1.7] text-ink">
        <p>
          分页加载把较早的轮次放在游标后面，所以长会话打开时只取最近五十轮。向上滚动到顶时再按
          <code className="mx-1 rounded bg-ink/[0.05] px-1 font-mono text-[13px]">before_turn</code>
          拉下一页，每页 20 轮。
        </p>
      </div>
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-[14px] rounded-br-[6px] bg-bubble-user px-4 py-2.5 text-[14px] leading-[1.6] text-ink">
          那压缩之后分页还准吗？顺便看看 hasMore 的边界。
        </div>
      </div>
      <p className="flex items-center gap-2 text-[12.5px] text-ink-faint">
        <Icon name="terminal" size={14} />
        正在运行 pnpm vitest run paginate
      </p>
    </>
  );
}

export function ConversationSheet({
  state,
  banner,
  tail,
  dock,
  composer,
}: {
  readonly state: ComposerMockState;
  /** Full-width line under the header (connection, recovery). */
  readonly banner?: ReactNode;
  /** Rendered at the end of the timeline, inside the scroll. */
  readonly tail?: ReactNode;
  /** Between the timeline and the composer. */
  readonly dock?: ReactNode;
  readonly composer: ReactNode;
}) {
  return (
    <div className="flex h-dvh bg-canvas p-2 max-sm:p-0">
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-[12px] bg-paper shadow-[var(--kiki-sheet-shadow)] max-sm:rounded-none">
        <header className="flex h-12 shrink-0 items-center gap-2 px-5">
          <h1 className="min-w-0 truncate text-[14px] font-medium text-ink">{COPY.sessionTitle}</h1>
          {state.ephemeral ? (
            <span data-ephemeral-tag className="shrink-0 rounded-md border border-dashed border-hairline-strong px-1.5 py-px text-[11.5px] text-ink-soft">
              {COPY.ephemeralTag}
            </span>
          ) : null}
          <span className="ml-auto shrink-0 text-[12px] text-ink-faint">
            {state.subagent === undefined ? COPY.sessionMeta : `kiki · ${state.subagent}`}
          </span>
        </header>
        {banner}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 max-sm:px-4" data-preview-scroll>
          <div className={`${WIDTH_CLASS} flex min-h-full flex-col justify-end gap-4 pt-6 pb-4`}>
            <MockTurns />
            {tail}
          </div>
        </div>
        {dock}
        <div className="shrink-0 px-6 pb-4 max-sm:px-3 max-sm:pb-3">{composer}</div>
      </main>
    </div>
  );
}

/** Chips that ride along with the next prompt: notes, images, files. */
export function RideAlongChips({ state }: { readonly state: ComposerMockState }) {
  if (state.annotations.length === 0 && state.attachments.length === 0) return null;
  return (
    <div data-ride-along className="flex flex-wrap items-center gap-1.5 px-3 pt-2.5">
      {state.annotations.map((note) => (
        <AnnotationChip key={note.id} quote={note.quote} comment={note.comment} onRemove={() => {}} />
      ))}
      {state.attachments.map((file) =>
        file.kind === 'image' ? (
          <ImageTile key={file.name} src={PREVIEW_IMAGE} name={file.name} detail={`${Math.round(file.size / 1024)} KB`} onOpen={() => {}} onRemove={() => {}} removeLabel={`${COPY.remove} ${file.name}`} />
        ) : (
          <TextTile key={file.name} title={file.name} mono onRemove={() => {}} removeLabel={`${COPY.remove} ${file.name}`}>
            <Icon name="file" size={12} />
            <span className="min-w-0 truncate">{file.name}</span>
          </TextTile>
        ),
      )}
    </div>
  );
}

export function placeholderFor(state: ComposerMockState): string {
  if (state.connection === 'offline') return COPY.placeholderOffline;
  if (state.run !== 'idle') return COPY.placeholderBusy;
  if (state.ephemeral) return COPY.placeholderEphemeral;
  return COPY.placeholder;
}

export function DraftInput({ state, placeholder }: { readonly state: ComposerMockState; readonly placeholder?: string }) {
  const lines = Math.min(4, Math.max(1, state.draft.split('\n').length));
  return (
    <div className="px-3.5 pt-3">
      <textarea
        aria-label={COPY.placeholder}
        rows={lines}
        defaultValue={state.draft}
        placeholder={placeholder ?? placeholderFor(state)}
        className="w-full resize-none bg-transparent py-0.5 text-[14.5px] leading-relaxed text-ink outline-none placeholder:text-ink-faint"
      />
    </div>
  );
}

const SEGMENT = 'flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-[13px] text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none pointer-coarse:h-10';

export function ContextRing({ percent }: { readonly percent: number }) {
  const level = percent >= 80 ? 'danger' : percent >= 50 ? 'warn' : 'ok';
  const stroke = level === 'danger' ? 'var(--color-danger)' : level === 'warn' ? 'var(--color-amber-rule)' : 'var(--color-ink-faint)';
  return (
    <button
      type="button"
      aria-label={COPY.context(percent)}
      title={COPY.context(percent)}
      className={`flex h-7 items-center gap-1 rounded-md px-1 text-[12px] tabular-nums transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none ${
        level === 'danger' ? 'font-medium text-danger hover:bg-danger/10' : level === 'warn' ? 'font-medium text-amber-ink' : 'text-ink-faint hover:bg-paper'
      }`}
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5 -rotate-90" aria-hidden>
        <circle cx="12" cy="12" r="9.5" fill="none" strokeWidth="2.25" stroke="var(--color-hairline)" />
        <circle cx="12" cy="12" r="9.5" fill="none" strokeWidth="2.25" strokeLinecap="round" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - percent} stroke={stroke} />
      </svg>
      <span className="max-sm:sr-only">{percent}%</span>
    </button>
  );
}

export function StopButton() {
  return (
    <button
      type="button"
      aria-label={COPY.stop}
      title={COPY.stop}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-danger/40 text-danger transition-colors hover:bg-danger/10 focus-visible:ring-2 focus-visible:ring-danger/40 focus-visible:outline-none pointer-coarse:h-10 pointer-coarse:w-10"
    >
      <Icon name="stop" size={12} />
    </button>
  );
}

export function SendButton({ ready, queue }: { readonly ready: boolean; readonly queue: boolean }) {
  return (
    <button
      type="button"
      aria-label={queue ? COPY.queueSend : COPY.send}
      title={queue ? COPY.queueSend : COPY.send}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:outline-none pointer-coarse:h-10 pointer-coarse:w-10 ${
        ready ? 'bg-accent text-primary-foreground hover:bg-accent-deep' : 'bg-paper text-ink-faint'
      }`}
    >
      <Icon name="arrowRight" size={14} />
    </button>
  );
}

/**
 * The toolbar row: add, run mode, agent, model on the left; approvals mode,
 * meter, stop and send on the right. `status` lets a variant put its own
 * segment between the pickers and the right edge.
 */
export function ComposerToolbar({
  state,
  status,
  showStop = state.run !== 'idle',
  sendReady,
  meter = true,
}: {
  readonly state: ComposerMockState;
  readonly status?: ReactNode;
  readonly showStop?: boolean;
  readonly sendReady?: boolean;
  readonly meter?: boolean;
}) {
  const yolo = state.permission === 'yolo';
  const ready = sendReady ?? (state.draft.trim() !== '' || state.attachments.length > 0 || state.annotations.length > 0);
  return (
    <div className="flex items-center gap-0.5 px-2 pt-1 pb-2">
      <button type="button" aria-label="添加" className={`${SEGMENT} w-8 justify-center px-0`}>
        <Icon name="plus" size={16} />
      </button>
      {state.plan ? (
        <span className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-paper px-2 text-[13px] font-medium text-ink shadow-[var(--kiki-sheet-shadow)]">
          <Icon name="plan" size={14} className="text-ink-soft" />
          <span className="max-sm:sr-only">{COPY.planChip}</span>
        </span>
      ) : null}
      {state.subagent === undefined ? (
        <button type="button" className={`${SEGMENT} max-sm:hidden`}>
          <Icon name="agent" size={14} className="text-ink-faint" />
          <span className="truncate">{COPY.agent}</span>
        </button>
      ) : null}
      <button type="button" className={`${SEGMENT} min-w-0`}>
        <Icon name="usage" size={14} className="text-ink-faint" />
        <span className="truncate">{COPY.model}</span>
        <span className="text-ink-faint max-sm:hidden">{COPY.effort}</span>
      </button>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-0.5">
        {status}
        <button
          type="button"
          className={`${SEGMENT} shrink-0 ${yolo ? 'bg-danger/10 font-medium text-danger hover:bg-danger/15 hover:text-danger' : ''}`}
        >
          <Icon name="gate" size={14} className={yolo ? '' : 'text-ink-faint'} />
          <span className="max-sm:sr-only">{COPY.perm[state.permission]}</span>
        </button>
      </div>
      <div className="ml-1 flex shrink-0 items-center gap-1">
        {meter ? <ContextRing percent={state.context} /> : null}
        {showStop ? <StopButton /> : null}
        <SendButton ready={ready} queue={state.run !== 'idle'} />
      </div>
    </div>
  );
}

export function ComposerCard({ children, tone = 'plain', attrs }: {
  readonly children: ReactNode;
  readonly tone?: 'plain' | 'attention';
  readonly attrs?: Record<string, string>;
}) {
  return (
    <div
      {...attrs}
      className={`composer-card relative rounded-[18px] bg-panel ${WIDTH_CLASS} ${tone === 'attention' ? 'ring-1 ring-attention/40' : ''}`}
    >
      {children}
    </div>
  );
}

/** "回复 reviewer" line of the subagent-tab composer. */
export function ReplyingTo({ state }: { readonly state: ComposerMockState }) {
  if (state.subagent === undefined) return null;
  return <p className={`${WIDTH_CLASS} mb-1.5 truncate px-1 text-[12px] text-ink-faint`}>{COPY.replyingTo(state.subagent)}</p>;
}
