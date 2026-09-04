import { Container, Text, type Component, type TUI } from '@moonshot-ai/pi-tui';

import type { MediaRef } from '@kiki/session-core/composer/media';
import type { Block, ToolBlock } from '@kiki/session-core/session/transcript/types';

import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { UserMessageComponent } from '#/tui/components/messages/user-message';
import { currentTheme } from '#/tui/theme';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

interface MountedBlock {
  readonly kind: Block['kind'];
  readonly component: Component;
  block: Block;
}

export class DaemonTranscriptRenderer {
  private readonly mounted = new Map<string, MountedBlock>();
  private expanded = false;

  constructor(
    private readonly container: Container,
    private readonly ui?: TUI,
    private readonly workDir?: string,
  ) {}

  sync(blocks: readonly Block[]): void {
    const active = new Set(blocks.map((block) => block.id));
    for (const [id, mounted] of this.mounted) {
      if (active.has(id)) continue;
      disposeComponent(mounted.component);
      this.mounted.delete(id);
    }

    this.container.clear();
    for (const block of blocks) {
      const mounted = this.updateOrCreate(block);
      this.container.addChild(mounted.component);
    }
    this.container.invalidate();
    this.ui?.requestRender();
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    for (const mounted of this.mounted.values()) {
      if (mounted.kind === 'tool') {
        (mounted.component as ToolCallComponent).setExpanded(expanded);
      }
    }
    this.container.invalidate();
    this.ui?.requestRender(true);
  }

  dispose(): void {
    for (const mounted of this.mounted.values()) disposeComponent(mounted.component);
    this.mounted.clear();
    this.container.clear();
  }

  private updateOrCreate(block: Block): MountedBlock {
    const mounted = this.mounted.get(block.id);
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
      return new DaemonUserMessageComponent(block.text, block.media);
    case 'assistant':
      return new DaemonAssistantMessageComponent(block.text, block.streaming, block.media);
    case 'thinking':
      return new ThinkingComponent(block.text, true, block.streaming ? 'live' : 'finalized', ui);
    case 'tool':
      return createToolComponent(block, ui, workDir);
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
    case 'shell':
      return new Text(`${block.done ? '$' : '…'} ${block.output}`, 2, 0);
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

class DaemonUserMessageComponent extends Container {
  constructor(text: string, media: readonly MediaRef[] | undefined) {
    super();
    this.addChild(new UserMessageComponent(text));
    addMediaLabels(this, media);
  }
}

class DaemonAssistantMessageComponent extends Container {
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

function addMediaLabels(container: Container, media: readonly MediaRef[] | undefined): void {
  for (const item of media ?? []) {
    const urlLabel = item.url?.startsWith('data:') === true ? (item.mime ?? 'inline') : item.url;
    const label = item.name ?? item.path ?? item.fileId ?? urlLabel ?? item.kind;
    container.addChild(new Text(currentTheme.fg('accent', `[${item.kind}: ${label}]`), 2, 0));
  }
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
