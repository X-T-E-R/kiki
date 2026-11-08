import { parseSelectionCarryovers, stripThreadRefContext } from '@kiki/session-core/composer';
import { extractToolOutputMedia } from '@kiki/session-core/composer/media';
import type { ActivitySummary, Block, DisplayNode } from '@kiki/session-core/session';

import { markdownVisibleText, type FindItem } from '../../lib/timelineFind';

/** A row the timeline draws: the process tree, plus the message view's summary. */
export type FindNode = DisplayNode | ActivitySummary;

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
    case 'subagent-event':
      return block.message ?? '';
    case 'question': {
      const qText = block.request.questions.map((item) => item.question).join('\n');
      const aText =
        block.outcome?.kind === 'answered' && block.outcome.answers !== undefined
          ? Object.values(block.outcome.answers).join('\n')
          : '';
      return [qText, aText].filter((part) => part !== '').join('\n');
    }
    default:
      return '';
  }
}

export function buildFindItems(nodes: readonly FindNode[], includeToolOutput = false): FindItem[] {
  const out: FindItem[] = [];
  const pushBlock = (block: Block, reveal: readonly string[], processViewOnly = false) => {
    const toolOutput = block.kind === 'tool' || block.kind === 'shell';
    const isExpandableItem = block.kind === 'subagent-event' || block.kind === 'question';
    if (
      toolOutput
        ? !includeToolOutput
        : block.kind !== 'user' &&
          block.kind !== 'assistant' &&
          block.kind !== 'message' &&
          !isExpandableItem
    ) {
      return;
    }
    const text = blockFindText(block, includeToolOutput);
    if (isExpandableItem && text === '') return;
    out.push({
      blockId: block.id,
      reveal: toolOutput || isExpandableItem ? [...reveal, block.id] : reveal,
      toolCallId: block.kind === 'tool' ? block.toolCallId : undefined,
      toolOutput,
      processViewOnly: processViewOnly ? true : undefined,
      textSelector: block.kind === 'tool' ? '[data-tool-record-field="output"]' : block.kind === 'shell' ? 'pre, [data-content-range-text]' : undefined,
      turnId: turnOf(block),
      text,
    });
  };
  const visit = (node: FindNode, reveal: readonly string[]) => {
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
        const text = node.task?.output_preview ?? node.note.taskNotification?.outputPreview ?? node.note.text;
        if (text.trim() !== '') {
          out.push({
            blockId: node.id,
            reveal: [...reveal, node.id],
            turnId: node.turnId,
            text: markdownVisibleText(text),
          });
        }
        return;
      }
      case 'activity-summary':
        // The message view folds a stretch of internal activity into one
        // collapsed line. The tool output inside it is still loaded and the
        // tool checkbox selects it, so it must count here too; the process
        // view is the surface that can open and paint it.
        for (const member of node.members) {
          if (member.kind === 'tool' || member.kind === 'shell' || member.kind === 'subagent-event') {
            pushBlock(member, [...reveal, node.id], member.kind !== 'subagent-event');
          }
        }
        return;
      default:
        pushBlock(node, reveal);
    }
  };
  for (const node of nodes) visit(node, []);
  return out;
}
