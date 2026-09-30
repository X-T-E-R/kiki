/**
 * The searchable text of the displayed timeline, leaf by leaf, in display
 * order. Each leaf contributes what its row shows once opened: message text,
 * thinking, a tool's name, input and output, a shell's command and log. The
 * text is approximate where rendering adds labels or strips markup — the
 * count is a data-model count, and painting finds the same query in the
 * rendered text of the leaf it lands on.
 */

import { parseSelectionCarryovers, stripThreadRefContext } from '@kiki/session-core/composer';
import { extractToolOutputMedia } from '@kiki/session-core/composer/media';
import type { Block, DisplayNode, ToolBlock } from '@kiki/session-core/session';

import { markdownVisibleText, type FindItem } from '../../lib/timelineFind';
import { toolDisplayName } from '../../lib/pluginCatalog';

/** Output text is capped per tool: a 2 MB log is not a reading surface. */
const OUTPUT_CAP = 60_000;

function outputText(output: unknown): string {
  if (output === undefined || output === null) return '';
  if (typeof output === 'string') return output;
  const media = extractToolOutputMedia(output);
  if (media !== undefined) return media.text;
  if (typeof output === 'object') {
    const record = output as Record<string, unknown>;
    switch (record['kind']) {
      case 'command_output':
        return [record['stdout'], record['stderr']].filter((part) => typeof part === 'string').join('\n');
      case 'text':
        return typeof record['text'] === 'string' ? record['text'] : '';
      case 'error':
        return typeof record['message'] === 'string' ? record['message'] : '';
      case 'file_content':
        return typeof record['content'] === 'string' ? record['content'] : '';
    }
  }
  try {
    return JSON.stringify(output, null, 2) ?? '';
  } catch {
    return '';
  }
}

function argsText(block: ToolBlock): string {
  if (block.display?.kind === 'command') return block.display.command;
  if (block.args !== undefined) {
    try {
      return JSON.stringify(block.args, null, 2) ?? '';
    } catch {
      return block.argsText;
    }
  }
  return block.argsText;
}

function toolText(block: ToolBlock): string {
  const parts = [toolDisplayName(block.name), block.description ?? '', argsText(block), outputText(block.output).slice(0, OUTPUT_CAP)];
  return parts.filter((part) => part !== '').join('\n');
}

function turnOf(block: Block): string | undefined {
  if (block.kind === 'subagent') return block.parentTurnId;
  return 'turnId' in block ? block.turnId : undefined;
}

/** Searchable text of one block as its opened row shows it. */
export function blockFindText(block: Block): string {
  switch (block.kind) {
    case 'user': {
      const typed = stripThreadRefContext(block.text);
      const carry = parseSelectionCarryovers(typed);
      return carry.annotations.length > 0 || carry.quote !== null ? carry.body : typed;
    }
    case 'assistant':
      return markdownVisibleText(block.text);
    case 'thinking':
    case 'system-reminder':
    case 'system':
      return block.text;
    case 'skill':
      return [block.name, block.args ?? '', block.text].filter((part) => part !== '').join('\n');
    case 'tool':
      return toolText(block);
    case 'shell':
      return [block.command ?? '', block.output.slice(0, OUTPUT_CAP)].filter((part) => part !== '').join('\n');
    case 'subagent':
      return [block.name, block.description ?? '', block.error ?? ''].filter((part) => part !== '').join('\n');
    case 'subagent-event':
      return [block.name, block.message ?? '', block.error ?? ''].filter((part) => part !== '').join('\n');
    case 'notice':
      return block.i18n === undefined ? block.text : '';
    case 'message':
      return block.text;
    case 'approval':
    case 'question':
      return '';
  }
}

/** Blocks whose row body only renders once its own disclosure is open. */
function ownsDisclosure(block: Block): boolean {
  switch (block.kind) {
    case 'thinking':
    case 'system-reminder':
    case 'system':
    case 'skill':
    case 'tool':
    case 'shell':
      return true;
    default:
      return false;
  }
}

/**
 * Flatten display nodes into find leaves. `reveal` lists the disclosure ids a
 * landing must open, outermost first: a history fold, a read run, then the
 * leaf's own row.
 */
export function buildFindItems(nodes: readonly DisplayNode[]): FindItem[] {
  const out: FindItem[] = [];
  const pushBlock = (block: Block, reveal: readonly string[]) => {
    const text = blockFindText(block);
    if (text.trim() === '') return;
    out.push({
      blockId: block.id,
      reveal: ownsDisclosure(block) ? [...reveal, block.id] : reveal,
      toolCallId: block.kind === 'tool' ? block.toolCallId : undefined,
      turnId: turnOf(block),
      text,
    });
  };
  const visit = (node: DisplayNode, reveal: readonly string[]) => {
    switch (node.kind) {
      case 'history-fold':
        for (const member of node.members) visit(member, [...reveal, node.id]);
        return;
      case 'tool-group':
        for (const member of node.members) pushBlock(member, [...reveal, node.id]);
        return;
      case 'subagent-group':
      case 'media-run':
        for (const member of node.members) pushBlock(member, reveal);
        return;
      case 'subagent-ended': {
        // The row (and the locate index) is keyed by the ending, not the note.
        const text = node.note.text;
        if (text.trim() !== '') out.push({ blockId: node.id, reveal: [...reveal, node.id], turnId: node.turnId, text });
        return;
      }
      default:
        pushBlock(node, reveal);
    }
  };
  for (const node of nodes) visit(node, []);
  return out;
}
