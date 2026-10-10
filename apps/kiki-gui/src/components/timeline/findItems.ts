import { parseSelectionCarryovers, stripThreadRefContext } from '@kiki/session-core/composer';
import { extractToolOutputMedia } from '@kiki/session-core/composer/media';
import type { Block, DisplayNode } from '@kiki/session-core/session';

import { markdownVisibleText, type FindItem } from '../../lib/timelineFind';

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

function turnOf(block: Block): string | undefined {
  if (block.kind === 'subagent') return block.parentTurnId;
  return 'turnId' in block ? block.turnId : undefined;
}

export function blockFindText(block: Block, includeToolOutput = false): string {
  switch (block.kind) {
    case 'user': {
      const typed = stripThreadRefContext(block.text);
      const carry = parseSelectionCarryovers(typed);
      return carry.annotations.length > 0 || carry.quote !== null ? carry.body : typed;
    }
    case 'assistant':
      return markdownVisibleText(block.text);
    case 'tool':
      return includeToolOutput ? outputText(block.output).slice(0, OUTPUT_CAP) : '';
    case 'shell':
      return includeToolOutput ? block.output.slice(0, OUTPUT_CAP) : '';
    case 'message':
      return block.text;
    default:
      return '';
  }
}

export function buildFindItems(nodes: readonly DisplayNode[], includeToolOutput = false): FindItem[] {
  const out: FindItem[] = [];
  const pushBlock = (block: Block, reveal: readonly string[]) => {
    const toolOutput = block.kind === 'tool' || block.kind === 'shell';
    if (toolOutput ? !includeToolOutput : block.kind !== 'user' && block.kind !== 'assistant' && block.kind !== 'message') return;
    const text = blockFindText(block, includeToolOutput);
    out.push({
      blockId: block.id,
      reveal: toolOutput ? [...reveal, block.id] : reveal,
      toolCallId: block.kind === 'tool' ? block.toolCallId : undefined,
      toolOutput,
      textSelector: block.kind === 'tool' ? '[data-tool-record-field="output"]' : block.kind === 'shell' ? 'pre, [data-content-range-text]' : undefined,
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
      case 'subagent-ended':
        return;
      default:
        pushBlock(node, reveal);
    }
  };
  for (const node of nodes) visit(node, []);
  return out;
}
