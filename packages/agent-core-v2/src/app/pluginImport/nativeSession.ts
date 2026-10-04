import type { ImportLoss, ImportRecord } from '@kiki/protocol';
import type { ContextMessage } from '#/agent/contextMemory/types';

export const nativeImportLosses: ImportLoss[] = [
  { code: 'native_text_history', count: 1, detail: 'User/assistant text becomes native context; tools become completed historical text, never executable calls' },
  { code: 'native_internal_state_not_imported', count: 1, detail: 'External system instructions, metadata, usage, approvals and running tasks are not installed as local state' },
];

export function nativeRecordLosses(records: readonly ImportRecord[]): ImportLoss[] {
  const count = records.filter((record) => record.part === 0 && (record.role === 'system' || record.role === 'metadata')).length;
  return count ? [{ code: 'native_records_not_imported', count, detail: 'System and metadata records are omitted from native context; source provenance and losses remain on the import job' }] : [];
}

export function nativeMessage(record: ImportRecord): ContextMessage | undefined {
  if (record.role === 'system' || record.role === 'metadata') return undefined;
  const historicalTool = record.role === 'tool' || record.role === 'tool_call';
  const text = historicalTool
    ? `[Imported historical ${record.role === 'tool_call' ? 'tool call' : 'tool result'}; already occurred, not executable${record.toolName ? `: ${record.toolName}` : ''}${record.toolCallId ? ` (${record.toolCallId})` : ''}]\n${record.text}`
    : record.text;
  return {
    id: `import:${record.id}:${record.part}`,
    role: record.role === 'user' ? 'user' : 'assistant',
    content: [{ type: 'text', text }], toolCalls: [],
    origin: record.role === 'user' ? { kind: 'user' } : undefined,
  };
}
