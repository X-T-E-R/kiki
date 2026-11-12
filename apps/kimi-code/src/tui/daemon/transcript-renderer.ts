import { Container, Text, truncateToWidth, type Component, type TUI } from '@kiki/pi-tui';

import type { MediaRef } from '@kiki/session-core/composer/media';
import {
  foldHistory, groupBlocks, groupHasError, groupHasRunning, groupSummary,
  readSubagentEndings, type AgentForest, type DisplayNode, type EndingTask,
} from '@kiki/session-core/session';
import { projectMessageContent } from '@kiki/session-core/session/transcript';
import type { Block, MessageBlock, ToolBlock, UserBlock } from '@kiki/session-core/session/transcript/types';

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

  constructor(
    private readonly container: Container,
    private readonly ui?: TUI,
    private readonly workDir?: string,
  ) {}

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
    ).map((item) => ({
      kind: 'user',
      id: `ingress-${item.prompt_id}`,
      promptId: item.prompt_id,
      createdAt: item.created_at,
      ...projectMessageContent(item.content),
      steerStatus: item.admission === 'held' ? 'held' : undefined,
      promptOutcome: item.admission === 'held' ? undefined : {
        status: item.admission === 'cancelled' ? 'aborted' : 'failed',
        delivered: false,
        error: item.admission_error?.message,
      },
    }));
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
      if (component instanceof ToolCallComponent || component instanceof DaemonUserMessageComponent ||
        component instanceof ThinkingComponent || component instanceof ProcessDetail) component.setExpanded(expanded);
    }
    this.mountChildren();
    this.ui?.requestRender();
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
    const components = this.notes
      .filter((note) => note.afterBlockId === undefined)
      .map((note) => note.component);
    const blocks = this.lastBlocks ?? [];
    const nodes = this.expanded ? blocks : foldHistory(
      readSubagentEndings(groupBlocks(blocks), this.context.tasks ?? []),
      this.context.liveTurnId,
      { forest: this.context.forest },
    );
    const visible = new Set<string>();
    const summaries = new Set<string>();
    const appendNotes = (ids: ReadonlySet<string>) => {
      for (const note of this.notes) {
        if (note.afterBlockId !== undefined && ids.has(note.afterBlockId)) components.push(note.component);
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
    if (component instanceof ToolCallComponent || component instanceof DaemonUserMessageComponent ||
      component instanceof ThinkingComponent || component instanceof ProcessDetail) component.setExpanded(this.expanded);
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
      const first = block.text.split(/\r?\n/u, 1)[0]!;
      return new ProcessDetail(first.trimStart().startsWith('<system-reminder>') ? 'Reminder' : first, block.text);
    }
    case 'system-reminder': {
      const label = block.variant === 'steer' ? 'Steer' : 'Reminder';
      const category = block.category?.kind;
      const heading = category === undefined ? label : `${label} · ${category}`;
      return new ProcessDetail(heading, `${heading}\n${block.text}`);
    }
    case 'notice':
      return new Text(
        block.tone === 'danger' ? currentTheme.fg('error', block.text) : currentTheme.dim(block.text),
        2,
        0,
      );
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
  private readonly text = new Text('', 0, 0);
  private answer: AssistantMessageComponent | undefined;
  private renderCache: { width: number; parts: string[][]; lines: string[] } | undefined;

  constructor(private message: string) {
    this.restyle();
  }

  /** Replace the note text, optionally followed by a Markdown answer. */
  update(message: string, answer?: string): void {
    this.message = message;
    this.restyle();
    if (answer !== undefined) {
      this.answer ??= new AssistantMessageComponent();
      this.answer.updateContent(answer);
    }
    this.renderCache = undefined;
  }

  invalidate(): void {
    this.restyle();
    this.answer?.invalidate();
    this.renderCache = undefined;
  }

  render(width: number): string[] {
    const parts = [this.text.render(width), ...(this.answer === undefined ? [] : [this.answer.render(width)])];
    const cache = this.renderCache;
    if (
      cache?.width === width &&
      cache.parts.length === parts.length &&
      parts.every((lines, index) => lines === cache.parts[index])
    ) {
      return cache.lines;
    }
    const lines = ['', ...parts.flat()];
    this.renderCache = { width, parts, lines };
    return lines;
  }

  private restyle(): void {
    // Indent every line (not only the first) and drop CRs from CRLF output,
    // which would otherwise blank the line once padded.
    const styled = currentTheme.fg('textDim', this.message.replaceAll('\r', ''));
    this.text.setText(styled.split('\n').map((line) => `  ${line}`).join('\n'));
  }
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
  private readonly message: UserMessageComponent;
  private readonly status = new Text('', 2, 0);
  private statusText: string | undefined;
  private expanded = false;

  constructor(private block: UserBlock) {
    super();
    this.message = new UserMessageComponent(block.text);
    this.addChild(this.message);
    addMediaLabels(this, block.media);
    this.addChild(this.status);
    this.syncStatus();
  }

  update(block: UserBlock): void {
    this.block = block;
    this.message.updateContent(block.text);
    this.syncStatus();
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.syncStatus();
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
    case 'notice':
      (component as Text).setText(block.tone === 'danger' ? currentTheme.fg('error', block.text) : currentTheme.dim(block.text));
      return;
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
