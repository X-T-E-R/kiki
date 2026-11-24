import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
  type MouseRoutable,
  type SgrMouseEvent,
} from '@kiki/pi-tui';
import type { Block } from '@kiki/session-core/session/transcript/types';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';
import { SearchableList } from '#/tui/utils/searchable-list';

export interface CopyTarget {
  readonly id: string;
  readonly kind: 'message' | 'code';
  readonly label: string;
  readonly language?: string;
  readonly preview: string;
  readonly text: string;
  readonly lineCount: number;
}

const FENCE_RE = /^```([^\n`]*)\n([\s\S]*?)^```[ \t]*$/gmu;

/**
 * Extract copyable targets from completed assistant messages in the current transcript:
 * newest fenced code blocks first (for `/copy 1..N`), plus the full last assistant message.
 */
export function extractCopyTargets(blocks: readonly Block[]): {
  readonly lastAssistantText: string | undefined;
  readonly codeBlocks: readonly CopyTarget[];
  readonly allTargets: readonly CopyTarget[];
} {
  const completed = blocks.filter(
    (block): block is Extract<Block, { kind: 'assistant' }> =>
      block.kind === 'assistant' && !block.streaming && block.text.trim().length > 0,
  );
  const lastAssistant = completed.at(-1);
  const lastAssistantText = lastAssistant?.text;

  const extracted: CopyTarget[] = [];
  for (let m = completed.length - 1; m >= 0; m--) {
    const msg = completed[m]!;
    const matches = [...msg.text.matchAll(FENCE_RE)];
    for (let k = matches.length - 1; k >= 0; k--) {
      const match = matches[k]!;
      const lang = (match[1] ?? '').trim();
      const body = (match[2] ?? '').replace(/\n$/u, '');
      if (body.trim().length === 0) continue;
      const lines = body.split('\n');
      const firstLine = lines.find((line) => line.trim().length > 0)?.trim() ?? '';
      const ordinal = extracted.length + 1;
      extracted.push({
        id: `code-${String(ordinal)}`,
        kind: 'code',
        language: lang.length > 0 ? lang : undefined,
        label: `#${String(ordinal)} ${lang.length > 0 ? lang : 'code'} (${String(lines.length)} lines)`,
        preview: firstLine,
        text: body,
        lineCount: lines.length,
      });
    }
  }

  const allTargets: CopyTarget[] = [];
  if (lastAssistantText !== undefined) {
    const lines = lastAssistantText.split('\n');
    const firstLine = lines.find((line) => line.trim().length > 0)?.trim() ?? '';
    allTargets.push({
      id: 'last-assistant',
      kind: 'message',
      label: `Last assistant message (${String(lines.length)} lines)`,
      preview: firstLine,
      text: lastAssistantText,
      lineCount: lines.length,
    });
  }
  allTargets.push(...extracted);
  return { lastAssistantText, codeBlocks: extracted, allTargets };
}

export interface CopyPickerOptions {
  readonly targets: readonly CopyTarget[];
  readonly onCopy: (target: CopyTarget) => void;
  readonly onWriteFile: (target: CopyTarget, filePath: string) => void | Promise<unknown>;
  readonly onCancel: () => void;
}

export class CopyPickerComponent extends Container implements Focusable, MouseRoutable {
  focused = false;
  private readonly opts: CopyPickerOptions;
  private readonly list: SearchableList<CopyTarget>;
  private writingTarget: CopyTarget | undefined;
  private readonly pathInput = new Input();
  private renderedRowToIndex: Array<number | undefined> = [];

  constructor(opts: CopyPickerOptions) {
    super();
    this.opts = opts;
    this.list = new SearchableList({
      items: opts.targets,
      toSearchText: (target) => `${target.label} ${target.language ?? ''} ${target.preview}`,
      searchable: false,
      pageSize: 8,
    });
    this.pathInput.onSubmit = (value) => {
      const target = this.writingTarget;
      const trimmed = value.trim();
      if (target !== undefined && trimmed.length > 0) {
        this.writingTarget = undefined;
        this.pathInput.setValue('');
        void this.opts.onWriteFile(target, trimmed);
      }
    };
    this.pathInput.onEscape = () => {
      this.writingTarget = undefined;
      this.pathInput.setValue('');
    };
  }

  handleInput(data: string): void {
    if (this.writingTarget !== undefined) {
      if (matchesKey(data, Key.escape)) {
        this.writingTarget = undefined;
        this.pathInput.setValue('');
        return;
      }
      this.pathInput.handleInput(data);
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (this.list.handleKey(data)) return;

    const k = printableChar(data);
    if (k === 'w' || k === 'W') {
      const selected = this.list.selected();
      if (selected !== undefined) {
        this.writingTarget = selected;
        const ext = selected.language && /^[a-z0-9_+-]+$/iu.test(selected.language)
          ? selected.language.toLowerCase()
          : 'txt';
        this.pathInput.setValue(`snippet.${ext}`);
      }
      return;
    }

    if (matchesKey(data, Key.enter)) {
      const selected = this.list.selected();
      if (selected !== undefined) this.opts.onCopy(selected);
    }
  }

  routeMouse(event: SgrMouseEvent, line: number, _col: number): boolean {
    if (this.writingTarget !== undefined) return false;
    if (event.wheel !== null) {
      if (event.wheel < 0) this.list.moveUp();
      else this.list.moveDown();
      return true;
    }
    if (event.leftClick) {
      const idx = this.renderedRowToIndex[line];
      if (idx === undefined) return false;
      this.list.setSelectedIndex(idx);
      const selected = this.list.selected();
      if (selected !== undefined) this.opts.onCopy(selected);
      return true;
    }
    return false;
  }

  onOutsideMouseDown(_event: SgrMouseEvent): boolean {
    this.opts.onCancel();
    return true;
  }

  override render(width: number): string[] {
    this.pathInput.focused = this.focused && this.writingTarget !== undefined;
    if (this.writingTarget !== undefined) {
      const inputLines = this.pathInput.render(Math.max(10, width - 10));
      const lines = [
        currentTheme.fg('primary', '─'.repeat(width)),
        currentTheme.boldFg('primary', ` Write ${this.writingTarget.label} to file`),
        currentTheme.fg('textMuted', ' Enter save · Esc back'),
        '',
        currentTheme.fg('primary', ' Path: ') + (inputLines[0] ?? ''),
        '',
        currentTheme.fg('primary', '─'.repeat(width)),
      ];
      return lines.map((line) => truncateToWidth(line, width, '…'));
    }

    const view = this.list.view();
    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ' Copy response or code block'),
      currentTheme.fg('textMuted', ' ↑↓ navigate · Enter copy · w write to file · Esc cancel'),
      '',
    ];
    this.renderedRowToIndex = Array.from({ length: lines.length }, () => undefined);
    if (view.items.length === 0) {
      lines.push(currentTheme.fg('textMuted', '   Nothing to copy yet.'));
    } else {
      for (let i = view.page.start; i < view.page.end; i++) {
        const item = view.items[i]!;
        const selected = i === view.selectedIndex;
        const pointer = selected ? SELECT_POINTER : ' ';
        const prefix = currentTheme.fg(selected ? 'primary' : 'textDim', `  ${pointer} `);
        const title = selected
          ? currentTheme.boldFg('primary', item.label)
          : currentTheme.fg('text', item.label);
        lines.push(`${prefix}${title}`);
        this.renderedRowToIndex.push(i);
        if (item.preview.length > 0) {
          lines.push(currentTheme.fg('textMuted', `      ${item.preview}`));
          this.renderedRowToIndex.push(i);
        }
      }
    }
    lines.push('');
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width, '…'));
  }

  override invalidate(): void {
    super.invalidate();
    this.pathInput.invalidate();
  }
}
