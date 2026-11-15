import {
  Container,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from '@kiki/pi-tui';

import type { MediaRef } from '@kiki/session-core/composer/media';
import {
  foldHistory, groupBlocks, groupHasError, groupHasRunning, groupSummary,
  readSubagentEndings, type AgentForest, type DisplayNode, type EndingTask,
} from '@kiki/session-core/session';
import { projectMessageContent } from '@kiki/session-core/session/transcript';
import type {
  Block,
  MessageBlock,
  NoticeBlock,
  SystemBlock,
  ToolBlock,
  UserBlock,
} from '@kiki/session-core/session/transcript/types';

import { ImageThumbnail } from '#/tui/components/media/image-thumbnail';
import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { UserMessageComponent } from '#/tui/components/messages/user-message';
import { currentTheme } from '#/tui/theme';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';
import type { ImageAttachment } from '#/tui/utils/image-attachment-store';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';
import { parseImageMeta } from '#/utils/image/image-mime';

interface MountedBlock {
  readonly kind: Block['kind'];
  readonly component: Component;
  block: Block;
}

export class DaemonTranscriptRenderer {
  private readonly mounted = new Map<string, MountedBlock>();
  /** Client-only notes, each shown after the block that was last when it was added. */
  private readonly notes: { readonly afterBlockId: string | undefined; readonly component: Component }[] = [];
  private lastBlocks: readonly Block[] | undefined;
  private lastSourceBlocks: readonly Block[] | undefined;
  private lastIngress: readonly import('@kiki/protocol').PromptItem[] | undefined;
  private context: TranscriptContext = {};
  private readonly summaries = new Map<string, TranscriptSummary>();
  private expanded = false;
  private showThinking = true;
  private showTimestamps = false;

  constructor(
    private readonly container: Container,
    private readonly ui?: TUI,
    private readonly workDir?: string,
    options?: { readonly showThinking?: boolean; readonly showTimestamps?: boolean },
  ) {
    if (options?.showThinking !== undefined) {
      this.showThinking = options.showThinking;
    }
    if (options?.showTimestamps !== undefined) {
      this.showTimestamps = options.showTimestamps;
    }
  }

  /**
   * Project blocks onto mounted components. session-core returns the same
   * array when nothing changed and keeps unchanged blocks object-identical, so
   * a streamed delta only touches the block that changed. Unchanged components
   * keep their render caches; nothing here invalidates the whole tree — theme
   * switches do that explicitly through `TUI.invalidate()`.
   */
  sync(
    blocks: readonly Block[],
    contextOrIngress: TranscriptContext | readonly import('@kiki/protocol').PromptItem[] = {},
  ): void {
    const context: TranscriptContext = Array.isArray(contextOrIngress)
      ? { ingress: contextOrIngress }
      : (contextOrIngress as TranscriptContext);
    const ingress = context.ingress ?? [];
    if (
      blocks === this.lastSourceBlocks &&
      ingress === this.lastIngress &&
      context.liveTurnId === this.context.liveTurnId &&
      context.tasks === this.context.tasks &&
      context.forest === this.context.forest
    ) {
      return;
    }
    this.lastSourceBlocks = blocks;
    this.lastIngress = ingress;
    this.context = context;
    const receipts: UserBlock[] = ingress.filter((item) =>
      (item.admission === 'failed' || item.admission === 'cancelled' || item.admission === 'held') &&
      !blocks.some((block) => block.kind === 'user' && block.promptId === item.prompt_id),
    ).map((item) => {
      const itemWithOrigin = item as {
        readonly origin?: unknown;
        readonly via?: { readonly client?: unknown };
      };
      const viaClient =
        extractViaClientFromOrigin(itemWithOrigin.origin) ??
        extractViaClientField(itemWithOrigin.via);
      const receipt: UserBlockWithVia = {
        kind: 'user',
        id: `ingress-${item.prompt_id}`,
        promptId: item.prompt_id,
        createdAt: item.created_at,
        ...projectMessageContent(item.content),
        sourceOrigin: itemWithOrigin.origin,
        via: viaClient === undefined ? undefined : { client: viaClient },
        steerStatus: item.admission === 'held' ? 'held' : undefined,
        promptOutcome: item.admission === 'held' ? undefined : {
          status: item.admission === 'cancelled' ? 'aborted' : 'failed',
          delivered: false,
          error: item.admission_error?.message,
        },
      };
      return receipt;
    });
    this.lastBlocks = receipts.length === 0 ? blocks : [...blocks, ...receipts];
    this.mountChildren();
    this.ui?.requestRender();
  }

  /**
   * Show client-only output (a command result, a /btw answer) in the
   * transcript after the current last block, where it stays readable instead
   * of in the status line that the next turn clears. Notes belong to the
   * session view: they are dropped by `clearNotes()` on a session switch, and
   * a note whose block is rewritten away (e.g. by /undo) is no longer shown.
   */
  addNote(component: Component): void {
    this.notes.push({ afterBlockId: this.lastBlocks?.at(-1)?.id, component });
    this.mountChildren();
    this.ui?.requestRender();
  }

  clearNotes(): void {
    this.notes.length = 0;
    this.mountChildren();
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    for (const { component } of this.mounted.values()) {
      if (
        component instanceof ToolCallComponent ||
        component instanceof DaemonUserMessageComponent ||
        component instanceof ThinkingComponent ||
        component instanceof ProcessDetail
      ) {
        component.setExpanded(expanded);
      }
    }
    this.mountChildren();
    this.ui?.requestRender();
  }

  setShowThinking(showThinking: boolean): void {
    if (this.showThinking === showThinking) return;
    this.showThinking = showThinking;
    this.mountChildren();
    this.container.invalidate();
    this.ui?.requestRender(true);
  }

  setShowTimestamps(showTimestamps: boolean): void {
    if (this.showTimestamps === showTimestamps) return;
    this.showTimestamps = showTimestamps;
    for (const mounted of this.mounted.values()) {
      if (mounted.kind === 'user') {
        (mounted.component as DaemonUserMessageComponent).setShowTimestamp(showTimestamps);
      }
    }
    this.container.invalidate();
    this.ui?.requestRender(true);
  }

  dispose(): void {
    for (const mounted of this.mounted.values()) disposeComponent(mounted.component);
    this.mounted.clear();
    this.notes.length = 0;
    this.lastBlocks = undefined;
    this.lastSourceBlocks = undefined;
    this.lastIngress = undefined;
    this.container.clear();
  }

  /** Re-mount children only when the component sequence actually changed. */
  private mountChildren(): void {
    const {
      displayBlocks: blocks,
      leadingSuppressedIds,
      suppressedAfterVisibleId,
    } = prepareDisplayBlocks(this.lastBlocks ?? [], {
      expanded: this.expanded,
      showThinking: this.showThinking,
    });
    const components = this.notes
      .filter(
        (note) =>
          note.afterBlockId === undefined || leadingSuppressedIds.has(note.afterBlockId),
      )
      .map((note) => note.component);
    const nodes = this.expanded ? blocks : foldHistory(
      readSubagentEndings(groupBlocks(blocks), this.context.tasks ?? []),
      this.context.liveTurnId,
      { forest: this.context.forest },
    );
    const visible = new Set<string>();
    const summaries = new Set<string>();
    const appendNotes = (ids: ReadonlySet<string>) => {
      const matchIds = new Set(ids);
      for (const id of ids) {
        for (const suppressedId of suppressedAfterVisibleId.get(id) ?? []) {
          matchIds.add(suppressedId);
        }
      }
      for (const note of this.notes) {
        if (note.afterBlockId !== undefined && matchIds.has(note.afterBlockId)) {
          components.push(note.component);
        }
      }
    };
    const append = (node: DisplayNode): void => {
      switch (node.kind) {
        case 'history-fold':
          if (node.failed > 0) { node.members.forEach(append); return; }
          break;
        case 'tool-group':
          if (groupHasRunning(node) || groupHasError(node)) { node.members.forEach(append); return; }
          break;
        case 'subagent-group':
        case 'media-run':
          node.members.forEach(append);
          return;
        case 'subagent-ended':
          if (this.expanded) { append(node.note); return; }
          break;
        default:
          visible.add(node.id);
          components.push(this.updateOrCreate(node).component);
          appendNotes(new Set([node.id]));
          return;
      }
      summaries.add(node.id);
      let summary = this.summaries.get(node.id);
      if (summary === undefined) {
        summary = new TranscriptSummary();
        this.summaries.set(node.id, summary);
      }
      summary.setText(summarizeNode(node));
      components.push(summary);
      appendNotes(new Set(memberIds(node)));
    };
    nodes.forEach(append);
    for (const [id, mounted] of this.mounted) {
      if (visible.has(id)) continue;
      disposeComponent(mounted.component);
      this.mounted.delete(id);
    }
    for (const id of this.summaries.keys()) if (!summaries.has(id)) this.summaries.delete(id);
    const children = this.container.children;
    if (
      components.length === children.length &&
      components.every((component, index) => component === children[index])
    ) {
      return;
    }
    this.container.clear();
    for (const component of components) this.container.addChild(component);
  }

  private updateOrCreate(block: Block): MountedBlock {
    const mounted = this.mounted.get(block.id);
    if (mounted?.block === block) return mounted;
    if (
      mounted !== undefined &&
      mounted.kind === block.kind &&
      !requiresReplacement(mounted.block, block)
    ) {
      updateMountedBlock(mounted.component, block);
      mounted.block = block;
      return mounted;
    }
    if (mounted !== undefined) disposeComponent(mounted.component);
    const component = createBlockComponent(block, this.ui, this.workDir);
    if (
      component instanceof ToolCallComponent ||
      component instanceof DaemonUserMessageComponent ||
      component instanceof ThinkingComponent ||
      component instanceof ProcessDetail
    ) {
      component.setExpanded(this.expanded);
    }
    if (component instanceof DaemonUserMessageComponent) {
      component.setShowTimestamp(this.showTimestamps);
    }
    const next = {
      kind: block.kind,
      component,
      block,
    };
    this.mounted.set(block.id, next);
    return next;
  }
}

export function createBlockComponent(block: Block, ui?: TUI, workDir?: string): Component {
  switch (block.kind) {
    case 'user':
      return new DaemonUserMessageComponent(block);
    case 'assistant':
      return new DaemonAssistantMessageComponent(block.text, block.streaming, block.media);
    case 'thinking':
      return new ThinkingComponent(block.text, true, block.streaming ? 'live' : 'finalized', ui);
    case 'tool':
      return createToolComponent(block, ui, workDir);
    case 'message':
      return new DaemonMessageComponent(block);
    case 'subagent':
      return new ProcessDetail(formatSubagent(block), [formatSubagent(block), block.summary, block.error].filter(Boolean).join('\n'), 'text');
    case 'subagent-event':
      return new ProcessDetail(`${block.name} · ${block.event}`, [block.name, block.event, block.message, block.error].filter(Boolean).join('\n'), block.error ? 'error' : 'textDim');
    case 'approval':
      return new Text(
        block.resolution === undefined
          ? currentTheme.fg('warning', `Approval required · ${block.request.action}`)
          : currentTheme.dim(`Approval ${block.resolution.decision} · ${block.request.action}`),
        2,
        0,
      );
    case 'question':
      return new Text(
        block.outcome === undefined
          ? currentTheme.fg('warning', block.request.questions[0]?.question ?? 'Question required')
          : currentTheme.dim(block.request.questions[0]?.question ?? 'Question answered'),
        2,
        0,
      );
    case 'shell': {
      const command = block.command ?? block.output;
      const output = block.command === undefined || block.output === '' ? '' : `\n${block.output}`;
      const body = `${block.done ? '$' : '…'} ${command}${output}`;
      if (!block.done || block.isError) return new Text(currentTheme.fg(block.isError ? 'error' : 'text', body), 2, 0);
      return new ProcessDetail(`$ ${command.split(/\r?\n/u, 1)[0]}`, body, 'text');
    }
    case 'skill':
      return new Text(currentTheme.dim(`/${block.name}${block.args === undefined ? '' : ` ${block.args}`}`), 2, 0);
    case 'system': {
      const info = classifySystemBlock(block);
      const body = info.kind === 'other' ? block.text : `${info.summary}\n${block.text}`;
      return new ProcessDetail(info.summary, body);
    }
    case 'system-reminder': {
      const label = block.variant === 'steer' ? 'Steer' : 'Reminder';
      const category = block.category?.kind;
      const heading = category === undefined ? label : `${label} · ${category}`;
      return new ProcessDetail(heading, `${heading}\n${block.text}`);
    }
    case 'notice': {
      const text = formatNoticeText(block);
      return new Text(
        block.tone === 'danger' ? currentTheme.fg('error', text) : currentTheme.dim(text),
        2,
        0,
      );
    }
  }
}

interface TranscriptContext {
  readonly liveTurnId?: string;
  readonly forest?: AgentForest;
  readonly tasks?: readonly EndingTask[];
  readonly ingress?: readonly import('@kiki/protocol').PromptItem[];
}

class TranscriptSummary implements Component {
  private text = '';
  setText(text: string): void { this.text = text; }
  invalidate(): void {}
  render(width: number): string[] {
    return [currentTheme.dim(truncateToWidth(`  ${this.text}`, width, '…'))];
  }
}

function memberIds(node: DisplayNode): string[] {
  if (node.kind === 'history-fold' || node.kind === 'tool-group' || node.kind === 'subagent-group' || node.kind === 'media-run') {
    return node.members.flatMap(memberIds);
  }
  return [node.kind === 'subagent-ended' ? node.note.id : node.id];
}

function summarizeNode(node: DisplayNode): string {
  if (node.kind === 'history-fold') {
    const parts = ['Worked'];
    if (node.steps > 0) parts.push(`${node.steps} ${node.steps === 1 ? 'step' : 'steps'}`);
    if (node.thoughts > 0) parts.push(`${node.thoughts} ${node.thoughts === 1 ? 'thought' : 'thoughts'}`);
    if (node.agents > 0) parts.push(`${node.agents} ${node.agents === 1 ? 'agent' : 'agents'}`);
    if (node.notes > 0) parts.push(`${node.notes} ${node.notes === 1 ? 'note' : 'notes'}`);
    return parts.join(' · ');
  }
  if (node.kind === 'tool-group') {
    const objects = groupSummary(node).map((part) => [part.verb, part.targets.join(', '), part.more > 0 ? `+${part.more}` : ''].filter(Boolean).join(' '));
    return `Read · ${node.count} steps · ${objects.join(' · ')}`;
  }
  if (node.kind === 'subagent-ended') return `Agent ${node.agentId} · ${node.outcome}`;
  return '';
}

class ProcessDetail implements Component {
  private expanded = false;
  private readonly detail = new Text('', 2, 0);

  constructor(
    private readonly summary: string,
    private readonly body: string,
    private readonly tone: 'text' | 'textDim' | 'error' = 'textDim',
  ) {}

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    if (expanded) this.invalidate();
  }

  invalidate(): void {
    if (this.expanded) this.detail.setText(currentTheme.fg(this.tone, this.body));
  }

  render(width: number): string[] {
    return this.expanded ? this.detail.render(width)
      : [currentTheme.fg(this.tone, truncateToWidth(`  ${this.summary}`, width, '…'))];
  }
}

/**
 * Client-only output in the transcript: a command result, or a /btw question
 * with its Markdown answer. Starts with a blank line like every block.
 */
export class TranscriptNoteComponent implements Component {
  private answer: AssistantMessageComponent | undefined;
  private textCache: { width: number; lines: string[] } | undefined;
  private renderCache: { width: number; parts: string[][]; lines: string[] } | undefined;

  constructor(private message: string) {}

  /** Replace the note text, optionally followed by a Markdown answer. */
  update(message: string, answer?: string): void {
    this.message = message;
    if (answer !== undefined) {
      this.answer ??= new AssistantMessageComponent();
      this.answer.updateContent(answer);
    }
    this.textCache = undefined;
    this.renderCache = undefined;
  }

  invalidate(): void {
    this.answer?.invalidate();
    this.textCache = undefined;
    this.renderCache = undefined;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const textLines =
      this.textCache?.width === safeWidth
        ? this.textCache.lines
        : renderTranscriptNoteLines(this.message, safeWidth);
    this.textCache = { width: safeWidth, lines: textLines };
    const parts = [
      textLines,
      ...(this.answer === undefined ? [] : [this.answer.render(safeWidth)]),
    ];
    const cache = this.renderCache;
    if (
      cache?.width === safeWidth &&
      cache.parts.length === parts.length &&
      parts.every((lines, index) => lines === cache.parts[index])
    ) {
      return cache.lines;
    }
    const lines = ['', ...parts.flat()];
    this.renderCache = { width: safeWidth, parts, lines };
    return lines;
  }
}

// oxlint-disable-next-line no-control-regex -- ESC (\x1b) is required to match ANSI SGR escape sequences
const NOTE_ANSI_SGR = /\u001B\[[0-9;]*m/g;
const NOTE_KV_PREFIX = /^(\s*[A-Za-z][A-Za-z0-9 _-]{0,22}:\s+)(?=\S)/u;
const NOTE_TABLE_PREFIX = /^(\s{2}[A-Za-z][A-Za-z0-9 _-]{1,18}\s{2,})(?=\S)/u;

function renderTranscriptNoteLines(message: string, width: number): string[] {
  const rawLines = message.replaceAll('\r', '').split('\n');
  const out: string[] = [];
  for (const rawLine of rawLines) {
    const plain = rawLine.replaceAll(NOTE_ANSI_SGR, '');
    if (plain.length === 0) {
      out.push('  ');
      continue;
    }
    const styledFull = currentTheme.fg('textDim', `  ${rawLine}`);
    if (visibleWidth(styledFull) <= width) {
      out.push(styledFull);
      continue;
    }
    const kvMatch = NOTE_KV_PREFIX.exec(plain) ?? NOTE_TABLE_PREFIX.exec(plain);
    const baseLeadMatch = /^(\s*)/u.exec(plain);
    const baseIndentCols = 2 + (baseLeadMatch?.[1]?.length ?? 0);
    const hangingCols = kvMatch !== null ? 2 + kvMatch[1]!.length : baseIndentCols;
    const effectiveIndentCols = width - hangingCols >= 14 ? hangingCols : Math.min(baseIndentCols, Math.max(0, width - 4));
    if (kvMatch !== null && effectiveIndentCols === hangingCols && plain === rawLine) {
      const labelPart = rawLine.slice(0, kvMatch[1]!.length);
      const valuePart = rawLine.slice(kvMatch[1]!.length);
      const wrappedValue = wrapTextWithAnsi(valuePart, Math.max(1, width - hangingCols));
      out.push(currentTheme.fg('textDim', `  ${labelPart}${wrappedValue[0] ?? ''}`));
      const contIndent = ' '.repeat(hangingCols);
      for (let i = 1; i < wrappedValue.length; i++) {
        out.push(currentTheme.fg('textDim', `${contIndent}${wrappedValue[i] ?? ''}`));
      }
      continue;
    }
    const firstWrapped = wrapTextWithAnsi(styledFull, width);
    if (firstWrapped.length <= 1 || effectiveIndentCols <= 0 || width <= effectiveIndentCols + 2) {
      out.push(...firstWrapped);
      continue;
    }
    // Re-wrap with hanging continuation indent for styled multi-line rows
    const trimmedContent = `  ${rawLine}`.slice(Math.min(effectiveIndentCols, 2));
    const rewrapped = wrapTextWithAnsi(
      currentTheme.fg('textDim', trimmedContent),
      Math.max(1, width - effectiveIndentCols),
    );
    const firstPad = ' '.repeat(Math.min(effectiveIndentCols, 2));
    const contPad = ' '.repeat(effectiveIndentCols);
    out.push(`${firstPad}${rewrapped[0] ?? ''}`);
    for (let i = 1; i < rewrapped.length; i++) {
      out.push(`${contPad}${rewrapped[i] ?? ''}`);
    }
  }
  return out;
}

/**
 * Container that returns the same line array while none of its children
 * re-rendered, so `GutterContainer` can reuse its prefixed lines instead of
 * rebuilding every message's lines on each frame.
 */
class RenderCachedContainer extends Container {
  private renderCache: { width: number; childLines: string[][]; lines: string[] } | undefined;

  override invalidate(): void {
    this.renderCache = undefined;
    super.invalidate();
  }

  override render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const childLines = this.children.map((child) => child.render(safeWidth));
    const cache = this.renderCache;
    if (
      isRenderCacheEnabled() &&
      cache?.width === safeWidth &&
      cache.childLines.length === childLines.length &&
      childLines.every((lines, index) => lines === cache.childLines[index])
    ) {
      return cache.lines;
    }
    const lines = childLines.flat();
    this.renderCache = { width: safeWidth, childLines, lines };
    return lines;
  }
}

class DaemonUserMessageComponent extends RenderCachedContainer {
  private message: UserMessageComponent;
  private readonly status = new Text('', 2, 0);
  private statusText: string | undefined;
  private expanded = false;
  private showTimestamp = false;

  constructor(private block: UserBlock) {
    super();
    this.message = new UserMessageComponent(
      block.text,
      undefined,
      undefined,
      undefined,
      readViaClient(block),
    );
    this.addChild(this.message);
    addMediaLabels(this, block.media);
    this.addChild(this.status);
    this.syncStatus();
  }

  update(block: UserBlock): void {
    this.block = block;
    this.message.updateContent(block.text);
    this.message.setSourceLabel(
      this.showTimestamp ? formatPromptTimestamp(block.createdAt) : undefined,
    );
    this.message.setViaClient(readViaClient(block));
    this.syncStatus();
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.syncStatus();
  }

  setShowTimestamp(showTimestamp: boolean): void {
    if (this.showTimestamp === showTimestamp) return;
    this.showTimestamp = showTimestamp;
    this.message.setSourceLabel(
      showTimestamp ? formatPromptTimestamp(this.block.createdAt) : undefined,
    );
    this.invalidate();
  }

  override invalidate(): void {
    super.invalidate();
    this.syncStatus();
  }

  private syncStatus(): void {
    // Text drops its cache on every setText, so only touch it on a real change.
    const status = formatUserPromptStatus(this.block, this.expanded) ?? '';
    if (status !== this.statusText) {
      this.statusText = status;
      this.status.setText(status);
    }
  }
}

function formatPromptTimestamp(createdAt: string | number | undefined): string | undefined {
  if (createdAt === undefined) return undefined;
  const ms = typeof createdAt === 'number' ? createdAt : Date.parse(createdAt);
  if (!Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatUserPromptStatus(block: UserBlock, expanded = false): string | undefined {
  const outcome = block.promptOutcome;
  if (outcome !== undefined) {
    const label = outcome.status === 'aborted'
      ? outcome.delivered ? 'Prompt aborted' : 'Prompt aborted before delivery'
      : outcome.delivered ? 'Reply failed' : 'Prompt failed before delivery';
    const rawDetail = expanded ? (outcome.errorDetails ?? outcome.error) : outcome.error;
    const detail = rawDetail === undefined ? '' : ` · ${rawDetail}`;
    return currentTheme.fg(outcome.status === 'failed' ? 'error' : 'warning', `${label}${detail}`);
  }
  if (block.promptStatus === 'queued') return currentTheme.dim('Queued');
  if (block.promptStatus === 'blocked') return currentTheme.fg('warning', 'Blocked');
  if (block.steerStatus === 'sending') return currentTheme.dim('Sending…');
  if (block.steerStatus === 'preparing') return currentTheme.dim('Preparing delivery…');
  if (block.steerStatus === 'waiting') return currentTheme.dim('Waiting for delivery');
  if (block.steerStatus === 'unconfirmed') return currentTheme.fg('warning', 'Delivery unconfirmed · check the queue before retrying');
  if (block.steerStatus === 'held') return currentTheme.fg('warning', 'Prompt held · check the saved prompt before retrying');
  if (block.branchFold !== undefined) {
    const label = block.branchFold.done !== false ? 'Merged from branch' : 'Folded from branch';
    return currentTheme.dim(`${label} ${block.branchFold.branchTitle ?? block.branchFold.branchId}`);
  }
  return undefined;
}

class DaemonAssistantMessageComponent extends RenderCachedContainer {
  private readonly message = new AssistantMessageComponent();

  constructor(text: string, streaming: boolean, media: readonly MediaRef[] | undefined) {
    super();
    this.message.updateContent(text, { transient: streaming });
    this.addChild(this.message);
    addMediaLabels(this, media);
  }

  updateContent(text: string, options: { readonly transient: boolean }): void {
    this.message.updateContent(text, options);
  }
}

class DaemonMessageComponent extends RenderCachedContainer {
  constructor(block: MessageBlock) {
    super();
    this.addChild(new Text(formatMessageBlock(block), 2, 0));
    for (const attachment of block.attachments) {
      const label = attachment.title ?? attachment.path;
      this.addChild(new Text(currentTheme.dim(`[attachment: ${label}]`), 2, 0));
    }
  }
}

function formatMessageBlock(block: MessageBlock): string {
  const target = block.handoff?.targetName ?? block.to;
  const targetLabel = target === undefined ? '' : ` → ${target}`;
  const sender = block.senderName === undefined
    ? targetLabel === '' ? '' : `${targetLabel}: `
    : `${block.senderName}${targetLabel}: `;
  const text = `${sender}${block.text}`;
  switch (block.status) {
    case 'sent':
      return text;
    case 'sending':
      return currentTheme.dim(`Sending${targetLabel}: ${block.text}`);
    case 'pending':
      return currentTheme.fg('warning', `Delivery not confirmed${targetLabel}: ${block.text}`);
    case 'failed':
      return currentTheme.fg('error', `Message not sent (failed)${targetLabel}: ${block.text}`);
    case 'cancelled':
      return currentTheme.fg('warning', `Message not sent (cancelled)${targetLabel}: ${block.text}`);
  }
}

function addMediaLabels(container: Container, media: readonly MediaRef[] | undefined): void {
  for (const item of media ?? []) {
    const thumbnail = item.kind === 'image' ? imageThumbnail(item) : undefined;
    if (thumbnail !== undefined) {
      container.addChild(thumbnail);
      continue;
    }
    const urlLabel = item.url?.startsWith('data:') === true ? (item.mime ?? 'inline') : item.url;
    const label = item.name ?? item.path ?? item.fileId ?? urlLabel ?? item.kind;
    container.addChild(new Text(currentTheme.fg('accent', `[${item.kind}: ${label}]`), 2, 0));
  }
}

function imageThumbnail(item: MediaRef): ImageThumbnail | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/su.exec(item.url ?? '');
  if (match === null) return undefined;
  const bytes = Buffer.from(match[2]!, 'base64');
  const dimensions = parseImageMeta(bytes);
  if (dimensions === null) return undefined;
  const attachment: ImageAttachment = {
    id: 0,
    kind: 'image',
    bytes,
    mime: match[1]!,
    width: dimensions.width,
    height: dimensions.height,
    placeholder: `[image (${String(dimensions.width)}×${String(dimensions.height)})]`,
  };
  return new ImageThumbnail(attachment);
}

function requiresReplacement(previous: Block, next: Block): boolean {
  if (previous === next) return false;
  if (
    (previous.kind === 'user' || previous.kind === 'assistant') &&
    previous.kind === next.kind &&
    mediaKey(previous.media) !== mediaKey(next.media)
  ) {
    return true;
  }
  return (
    next.kind === 'message' ||
    next.kind === 'subagent' ||
    next.kind === 'subagent-event' ||
    next.kind === 'approval' ||
    next.kind === 'question' ||
    next.kind === 'system' ||
    next.kind === 'system-reminder' ||
    next.kind === 'shell'
  );
}

function mediaKey(media: readonly MediaRef[] | undefined): string {
  return JSON.stringify(media ?? []);
}

function updateMountedBlock(component: Component, block: Block): void {
  switch (block.kind) {
    case 'assistant':
      (component as DaemonAssistantMessageComponent).updateContent(block.text, {
        transient: block.streaming,
      });
      return;
    case 'thinking': {
      const thinking = component as ThinkingComponent;
      thinking.setText(block.text);
      if (!block.streaming) thinking.finalize();
      return;
    }
    case 'tool': {
      const tool = component as ToolCallComponent;
      tool.updateToolCall(toolCallData(block));
      const result = toolResultData(block);
      if (result !== undefined) tool.setResult(result);
      return;
    }
    case 'user':
      (component as DaemonUserMessageComponent).update(block);
      return;
    case 'skill':
      (component as Text).setText(currentTheme.dim(`/${block.name}${block.args === undefined ? '' : ` ${block.args}`}`));
      return;
    case 'notice': {
      const text = formatNoticeText(block);
      (component as Text).setText(
        block.tone === 'danger' ? currentTheme.fg('error', text) : currentTheme.dim(text),
      );
      return;
    }
    case 'system':
    case 'system-reminder':
    case 'message':
    case 'subagent':
    case 'subagent-event':
    case 'approval':
    case 'question':
    case 'shell':
      return;
  }
}

function createToolComponent(block: ToolBlock, ui?: TUI, workDir?: string): ToolCallComponent {
  const result = toolResultData(block);
  return new ToolCallComponent(toolCallData(block), result, ui, workDir);
}

function toolCallData(block: ToolBlock): ToolCallBlockData {
  return {
    id: block.toolCallId,
    name: block.name,
    args: asRecord(block.args, block.argsText),
    description: block.description,
    display: block.display,
    result: toolResultData(block),
    turnId: block.turnId,
  };
}

function toolResultData(block: ToolBlock): ToolResultBlockData | undefined {
  if (block.status === 'running') return undefined;
  return {
    tool_call_id: block.toolCallId,
    output: block.output === undefined ? '' : displayValue(block.output),
    is_error: block.status === 'error' || block.isError === true,
  };
}

function asRecord(value: unknown, argsText: string): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : argsText === ''
      ? {}
      : { input: argsText };
}

function displayValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, undefined, 2);
}

function formatSubagent(block: Extract<Block, { kind: 'subagent' }>): string {
  const status =
    block.status === 'completed'
      ? currentTheme.fg('success', '✓')
      : block.status === 'failed' || block.status === 'cancelled'
        ? currentTheme.fg('error', '✗')
        : currentTheme.fg('primary', '●');
  const detail = block.description ?? block.summary;
  return `  ${status} ${currentTheme.boldFg('primary', block.name)}${detail === undefined ? '' : currentTheme.dim(` · ${detail}`)}`;
}

function disposeComponent(component: Component): void {
  const disposable = component as Component & { dispose?: () => void };
  disposable.dispose?.();
}

type UserBlockWithVia = UserBlock & { readonly via?: { readonly client?: unknown } };

function extractViaClientField(via: unknown): string | undefined {
  if (typeof via !== 'object' || via === null) return undefined;
  const client = (via as { readonly client?: unknown }).client;
  return typeof client === 'string' && client.length > 0 ? client : undefined;
}

function extractViaClientFromOrigin(origin: unknown): string | undefined {
  if (typeof origin !== 'object' || origin === null) return undefined;
  return extractViaClientField((origin as { readonly via?: unknown }).via);
}

function readViaClient(block: UserBlock): string | undefined {
  return (
    extractViaClientField((block as UserBlockWithVia).via) ??
    extractViaClientFromOrigin(block.sourceOrigin)
  );
}

function readBlockTurnId(block: Block): string | undefined {
  return 'turnId' in block && typeof block.turnId === 'string' ? block.turnId : undefined;
}

interface PreparedDisplayBlocks {
  readonly displayBlocks: Block[];
  readonly leadingSuppressedIds: Set<string>;
  readonly suppressedAfterVisibleId: Map<string, string[]>;
}

function prepareDisplayBlocks(
  blocks: readonly Block[],
  options: { readonly expanded: boolean; readonly showThinking: boolean },
): PreparedDisplayBlocks {
  const displayBlocks: Block[] = [];
  const leadingSuppressedIds = new Set<string>();
  const suppressedAfterVisibleId = new Map<string, string[]>();
  const seenRecipes = new Set<string>();
  let lastVisibleId: string | undefined;
  let currentTurnId: string | undefined;
  let activeTurnFailure:
    | { readonly turnId: string | undefined; readonly normError: string; outcomeSeen: boolean }
    | undefined;
  let pendingFrameDanger: { readonly turnId: string | undefined; readonly normError: string } | undefined;

  const recordSuppressed = (id: string): void => {
    if (lastVisibleId === undefined) {
      leadingSuppressedIds.add(id);
      return;
    }
    let list = suppressedAfterVisibleId.get(lastVisibleId);
    if (list === undefined) {
      list = [];
      suppressedAfterVisibleId.set(lastVisibleId, list);
    }
    list.push(id);
  };

  for (const block of blocks) {
    const turnId = readBlockTurnId(block);
    if (turnId !== undefined && currentTurnId !== undefined && turnId !== currentTurnId) {
      activeTurnFailure = undefined;
      pendingFrameDanger = undefined;
    }
    if (turnId !== undefined) {
      currentTurnId = turnId;
    }

    if (block.kind === 'user') {
      pendingFrameDanger = undefined;
      const outcome = block.promptOutcome;
      if (
        outcome !== undefined &&
        (outcome.status === 'failed' || outcome.status === 'aborted') &&
        outcome.error !== undefined
      ) {
        const normError = normalizeFailureText(outcome.error);
        activeTurnFailure =
          normError.length > 0 ? { turnId, normError, outcomeSeen: false } : undefined;
      } else {
        activeTurnFailure = undefined;
      }
    } else if (block.kind === 'assistant') {
      pendingFrameDanger = undefined;
    }

    if (!options.showThinking && block.kind === 'thinking') {
      recordSuppressed(block.id);
      continue;
    }

    if (!options.expanded && block.kind === 'system-reminder' && block.variant !== 'steer') {
      recordSuppressed(block.id);
      continue;
    }

    if (block.kind === 'system') {
      const info = classifySystemBlock(block);
      if (!options.expanded) {
        if (info.kind === 'internal') {
          recordSuppressed(block.id);
          continue;
        }
        if (info.kind === 'recipe') {
          const recipeKey = `${info.summary}\u0000${block.text}`;
          if (seenRecipes.has(recipeKey)) {
            recordSuppressed(block.id);
            continue;
          }
          seenRecipes.add(recipeKey);
        }
      }
    }

    if (block.kind === 'notice') {
      if (isStructuredDomainNotice(block)) {
        pendingFrameDanger = undefined;
      }
      if (!options.expanded && isPlumbingNotice(block)) {
        recordSuppressed(block.id);
        continue;
      }
      if (!options.expanded && isTurnFailureNotice(block)) {
        const normNotice = normalizeFailureText(formatNoticeText(block));
        if (normNotice.length > 0) {
          const explicitOutcome = isExplicitTurnOutcomeNotice(block);
          const activeFailure = activeTurnFailure;
          const inActiveFailedPromptTurn =
            activeFailure !== undefined &&
            (turnId !== undefined
              ? activeFailure.turnId === undefined || turnId === activeFailure.turnId
              : !activeFailure.outcomeSeen);
          if (inActiveFailedPromptTurn && normNotice === activeFailure.normError) {
            if (explicitOutcome) {
              activeFailure.outcomeSeen = true;
            }
            recordSuppressed(block.id);
            continue;
          }
          if (explicitOutcome && activeFailure !== undefined && turnId === activeFailure.turnId) {
            activeFailure.outcomeSeen = true;
          }

          if (
            explicitOutcome &&
            pendingFrameDanger !== undefined &&
            (turnId === undefined ||
              pendingFrameDanger.turnId === undefined ||
              turnId === pendingFrameDanger.turnId) &&
            normNotice === pendingFrameDanger.normError
          ) {
            pendingFrameDanger = undefined;
            recordSuppressed(block.id);
            continue;
          }
          if (!explicitOutcome) {
            pendingFrameDanger = { turnId, normError: normNotice };
          } else {
            pendingFrameDanger = undefined;
          }
        }
      }
    }

    displayBlocks.push(block);
    lastVisibleId = block.id;
  }

  return { displayBlocks, leadingSuppressedIds, suppressedAfterVisibleId };
}

function classifySystemBlock(
  block: SystemBlock,
): { readonly kind: 'recipe' | 'internal' | 'other'; readonly summary: string } {
  const recipeName = extractRecipeName(block);
  const source = block.source ?? '';
  const isRecipe =
    recipeName !== undefined ||
    source === 'model_steering' ||
    source === 'recipe' ||
    /^(?:recipe|model_steering)(?:[:/]|$)/iu.test(source);
  if (isRecipe) {
    return {
      kind: 'recipe',
      summary: recipeName !== undefined ? `Recipe · ${recipeName}` : 'Recipe',
    };
  }

  const trimmed = block.text.trimStart();
  const isInternalTag =
    trimmed.startsWith('<system-reminder>') ||
    trimmed.startsWith('<tools_added>') ||
    trimmed.startsWith('<tools_removed>') ||
    trimmed.startsWith('<memory-workset') ||
    trimmed.startsWith('<cognition') ||
    trimmed.startsWith('<skill-loaded');
  if (isInternalTag || block.variant === 'injection') {
    const label = trimmed.startsWith('<system-reminder>')
      ? 'Reminder'
      : source.length > 0
        ? `System · ${source}`
        : 'System injection';
    return { kind: 'internal', summary: label };
  }

  const first = block.text.split(/\r?\n/u, 1)[0]!.trim() || 'System';
  return { kind: 'other', summary: first };
}

function extractRecipeName(block: SystemBlock): string | undefined {
  const extra = block as SystemBlock & {
    readonly recipeName?: unknown;
    readonly recipe?: { readonly name?: unknown };
  };
  if (typeof extra.recipe?.name === 'string' && extra.recipe.name.trim().length > 0) {
    return extra.recipe.name.trim();
  }
  if (typeof extra.recipeName === 'string' && extra.recipeName.trim().length > 0) {
    return extra.recipeName.trim();
  }
  if (typeof block.source === 'string') {
    const sourceMatch = /^(?:recipe|model_steering)[:/](.+)$/iu.exec(block.source.trim());
    if (sourceMatch?.[1]?.trim()) return sourceMatch[1].trim();
  }
  const tagMatch = /^\s*<recipe(?:\s+[^>]*?)?\s+name=["']([^"'\r\n]+)["']/iu.exec(block.text);
  if (tagMatch?.[1]?.trim()) return tagMatch[1].trim();
  const bracketMatch = /^\s*\[recipe:\s*([^\r\n\]]+)\]/iu.exec(block.text);
  if (bracketMatch?.[1]?.trim()) return bracketMatch[1].trim();
  const firstLine = block.text.split(/\r?\n/u, 1)[0]?.trim() ?? '';
  const headingMatch = /^(?:#+\s*)?recipe\s*[:·—-]\s*([A-Za-z0-9._/-][^\r\n:]{0,39})$/iu.exec(
    firstLine,
  );
  if (headingMatch?.[1] && !/[.!?。！？，；]/u.test(headingMatch[1])) {
    return headingMatch[1].trim();
  }
  return undefined;
}

function isPlumbingNotice(block: NoticeBlock): boolean {
  const key = block.i18n?.key;
  if (
    key === 'transcript.marker.interruption' ||
    key === 'transcript.marker.hook' ||
    key === 'transcript.marker.skill'
  ) {
    return true;
  }
  if (block.tone === 'neutral') {
    const trimmed = block.text.trim();
    return trimmed === 'interruption' || trimmed === 'hook' || trimmed === 'skill';
  }
  return false;
}

function isStructuredDomainNotice(block: NoticeBlock): boolean {
  return (
    block.compactionPhase !== undefined ||
    block.modelSwitch !== undefined ||
    block.goalChange !== undefined ||
    block.branchBase !== undefined ||
    block.executor !== undefined ||
    block.externalText !== undefined
  );
}

function isExplicitTurnOutcomeNotice(block: NoticeBlock): boolean {
  const key = block.i18n?.key;
  return (
    key === 'notice.turnFailedDetail' ||
    key === 'notice.turnCancelledDetail' ||
    block.id.startsWith('agent-turn-outcome-')
  );
}

function isTurnFailureNotice(block: NoticeBlock): boolean {
  if (isStructuredDomainNotice(block)) return false;
  return block.tone === 'danger' || isExplicitTurnOutcomeNotice(block);
}

function formatNoticeText(block: NoticeBlock): string {
  const trimmed = block.text.trim();
  if (block.compactionPhase !== undefined && trimmed === 'compaction') {
    if (block.compactionPhase === 'failed' && block.compactionFailure) {
      return `Context compaction failed · ${block.compactionFailure}`;
    }
    const summaryLine = block.summary?.split(/\r?\n/u, 1)[0]?.trim();
    return summaryLine ? `Context compacted · ${summaryLine}` : `Context compaction · ${block.compactionPhase}`;
  }
  if (block.modelSwitch !== undefined && trimmed === 'model.switch') {
    return block.modelSwitch.to ? `Model switched · ${block.modelSwitch.to}` : 'Model switched';
  }
  if (block.goalChange !== undefined && trimmed === 'goal') {
    return 'Goal updated';
  }
  if (block.branchBase !== undefined && trimmed === 'branch.base') {
    return `Branched from ${block.branchBase.sourceAgentId}`;
  }
  if (trimmed === 'interruption') return 'Interrupted';
  return block.text;
}

function normalizeFailureText(text: string): string {
  return text
    .trim()
    .replace(
      /^(?:reply failed|prompt failed(?: before delivery)?|prompt aborted(?: before delivery)?|turn failed|error)\s*[·:—-]\s*/iu,
      '',
    )
    .replaceAll(/\s+/gu, ' ')
    .toLowerCase();
}
