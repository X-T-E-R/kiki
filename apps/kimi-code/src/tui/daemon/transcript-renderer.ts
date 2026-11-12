import { Container, Text, type Component, type TUI } from '@kiki/pi-tui';

import type { MediaRef } from '@kiki/session-core/composer/media';
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
  sync(blocks: readonly Block[]): void {
    if (blocks === this.lastBlocks) return;
    this.lastBlocks = blocks;
    const active = new Set(blocks.map((block) => block.id));
    for (const [id, mounted] of this.mounted) {
      if (active.has(id)) continue;
      disposeComponent(mounted.component);
      this.mounted.delete(id);
    }

    for (const block of blocks) this.updateOrCreate(block);
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
    this.expanded = expanded;
    for (const mounted of this.mounted.values()) {
      if (mounted.kind === 'tool') {
        (mounted.component as ToolCallComponent).setExpanded(expanded);
      } else if (mounted.kind === 'user') {
        (mounted.component as DaemonUserMessageComponent).setExpanded(expanded);
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
    this.container.clear();
  }

  /** Re-mount children only when the component sequence actually changed. */
  private mountChildren(): void {
    const components = this.notes
      .filter((note) => note.afterBlockId === undefined)
      .map((note) => note.component);
    for (const block of this.lastBlocks ?? []) {
      const mounted = this.mounted.get(block.id);
      if (mounted !== undefined) components.push(mounted.component);
      for (const note of this.notes) {
        if (note.afterBlockId === block.id) components.push(note.component);
      }
    }
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
    if (block.kind === 'tool') (component as ToolCallComponent).setExpanded(this.expanded);
    if (block.kind === 'user') (component as DaemonUserMessageComponent).setExpanded(this.expanded);
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
      return new Text(formatSubagent(block), 0, 0);
    case 'subagent-event':
      return new Text(currentTheme.dim(`${block.name} · ${block.event}`), 2, 0);
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
      return new Text(`${block.done ? '$' : '…'} ${command}${output}`, 2, 0);
    }
    case 'skill':
      return new Text(currentTheme.dim(`/${block.name}${block.args === undefined ? '' : ` ${block.args}`}`), 2, 0);
    case 'system':
    case 'system-reminder':
      return new Text(currentTheme.dim(block.text), 2, 0);
    case 'notice':
      return new Text(
        block.tone === 'danger' ? currentTheme.fg('error', block.text) : currentTheme.dim(block.text),
        2,
        0,
      );
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
  if (block.steerStatus === 'waiting') return currentTheme.dim('Waiting for delivery');
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
    case 'message':
    case 'subagent':
    case 'subagent-event':
    case 'approval':
    case 'question':
    case 'shell':
    case 'skill':
    case 'system':
    case 'system-reminder':
    case 'notice':
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
