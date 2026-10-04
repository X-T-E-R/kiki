import { fileAdapter, readInput, jsonLines, recordBuilder, textBlocks } from './files.mjs';

export const definition = { schemaVersion: 1, id: 'pi', label: 'Pi', formatVersion: 'pi-jsonl-v3' };
export function projectPi(records, signal) {
  const header = records[0];
  if (header?.type !== 'session' || header.version !== 3 || !header.id || !header.cwd || !header.timestamp) throw new Error('Pi rule requires a v3 session header');
  const entries = records.slice(1); const indexed = new Map();
  for (const entry of entries) {
    signal.throwIfAborted();
    if (typeof entry.id !== 'string' || !entry.id) throw new Error('Pi entry is missing an id');
    if (indexed.has(entry.id)) throw new Error('Pi session contains a duplicate entry id');
    if (entry.parentId !== null && entry.parentId !== undefined && !indexed.has(entry.parentId)) throw new Error('Pi session tree references a missing parent');
    indexed.set(entry.id, entry);
  }
  const branch = []; const seen = new Set(); let current = entries.at(-1);
  while (current) {
    if (seen.has(current.id)) throw new Error('Pi session tree contains a cycle');
    seen.add(current.id); branch.push(current);
    current = current.parentId === null || current.parentId === undefined ? undefined : indexed.get(current.parentId);
  }
  const builder = recordBuilder(signal);
  builder.loss('inactive_pi_branch', 'Only the active Pi branch is imported', entries.length - branch.length);
  if (header.parentSession) builder.loss('inherited_history_not_loaded', 'Pi parent session files are not loaded automatically');
  let title;
  for (const entry of branch.toReversed()) {
    if (entry.type === 'session_info') { title = entry.name; continue; }
    if (entry.type === 'compaction') {
      if (typeof entry.summary === 'string') builder.add('assistant', `[Imported historical compaction summary]\n${entry.summary}`);
      else builder.loss('unknown_content', 'Pi compaction summary is missing');
      builder.loss('compaction_state_not_imported', 'Pi compaction boundaries and token state are not installed'); continue;
    }
    if (entry.type !== 'message') { builder.loss('pi_entry_not_imported', 'Pi model, extension, branch-summary and other internal entries are omitted'); continue; }
    const message = entry.message;
    if (!message || !['user', 'assistant', 'toolResult'].includes(message.role)) { builder.loss('pi_message_not_imported', 'Unsupported Pi message roles are omitted'); continue; }
    if (message.role === 'toolResult') {
      textBlocks(builder, message.content, 'tool', { toolName: String(message.toolName ?? '').slice(0, 200), toolCallId: String(message.toolCallId ?? '').slice(0, 200) });
      if (message.details !== undefined) builder.loss('tool_details_not_imported', 'Pi tool result details are omitted');
      continue;
    }
    if (typeof message.content === 'string') { builder.add(message.role, message.content); continue; }
    if (!Array.isArray(message.content)) { builder.loss('unknown_content', 'Pi message content is not text or blocks'); continue; }
    for (const block of message.content) {
      if (block?.type === 'toolCall') builder.add('tool_call', block.arguments, { toolName: String(block.name ?? '').slice(0, 200), toolCallId: String(block.id ?? '').slice(0, 200) });
      else textBlocks(builder, [block], message.role);
    }
  }
  return builder.result(title);
}
export const adapter = fileAdapter(definition, (name) => name.endsWith('.jsonl'), async ({ home, externalId }, { signal }) => {
  const input = await readInput(home, externalId, signal); return { ...input, data: jsonLines(input.bytes) };
}, projectPi);
