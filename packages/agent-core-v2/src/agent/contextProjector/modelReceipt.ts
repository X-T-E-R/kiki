import { renderHistoryReceipt } from './historyReceipt';
import { renderCollaborationReceipt } from './collaborationReceipt';
import { errorReceipt, record } from './receiptFormat';
import { renderStateReceipt, renderTaskReceipt } from './stateReceipt';

const RECEIPT_TOOLS = new Set(['HistoryList', 'HistoryRead', 'HistorySearch', 'ThreadList', 'ThreadRead',
  'ThreadWait', 'ThreadSend', 'RoomRead', 'AgentList', 'TaskList', 'TaskOutput', 'MemorySearch', 'MemoryRead', 'TodoList']);

export function renderModelReceipt(name: string | undefined, output: string, args?: string | null): string {
  if (name === undefined || !RECEIPT_TOOLS.has(name)) return output;
  let input: Record<string, unknown> = {};
  try { input = record(JSON.parse(args ?? '{}')); } catch {}
  if (input['raw'] === true) return output;
  const plain = renderTaskReceipt(name, output);
  if (plain !== undefined) return plain;
  let value: unknown;
  try { value = JSON.parse(output); } catch { return output; }
  const data = record(value);
  const error = errorReceipt(data);
  if (error !== undefined) return error;
  return renderStateReceipt(name, value) ??
    (name.startsWith('History') ? renderHistoryReceipt(name, data) : renderCollaborationReceipt(name, data, input)) ?? output;
}
