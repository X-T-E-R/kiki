import path from 'node:path';
import { fileAdapter, readInput, jsonLines, recordBuilder } from './files.mjs';

export const definition = { schemaVersion: 1, id: 'grok', label: 'Grok Build', formatVersion: 'grok-acp-v1' };
export function projectGrok({ summary, updates }, signal) {
  const sessionId = summary?.info?.id;
  if (typeof sessionId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(sessionId) || !summary.info.cwd) throw new Error('Grok summary is missing valid session info');
  if (!Array.isArray(updates) || !updates.length || summary.num_messages !== updates.length) throw new Error('Grok summary count does not match updates');
  const builder = recordBuilder(signal); let pending;
  const flush = () => { if (pending) builder.add(pending.role, pending.text); pending = undefined; };
  for (const record of updates) {
    signal.throwIfAborted(); const update = record?.params?.update;
    if (!['session/update', '_x.ai/session/update'].includes(record.method) || record.params?.sessionId !== sessionId || !Number.isInteger(record.timestamp) || !update?.sessionUpdate) throw new Error('Grok update linkage or envelope is invalid');
    const kind = update.sessionUpdate; const content = update.content;
    if (['user_message_chunk', 'agent_message_chunk'].includes(kind) && content?.type === 'text') {
      if (typeof content.text !== 'string') throw new Error('Grok text update is malformed');
      let role = kind === 'user_message_chunk' ? 'user' : 'assistant'; let text = content.text;
      if (role === 'user' && text.startsWith('[Imported conversation summary]\n')) {
        flush(); builder.add('assistant', `[Imported historical compaction summary]\n${text.slice('[Imported conversation summary]\n'.length)}`);
        builder.loss('compaction_state_not_imported', 'Grok imported summaries are text, not local compaction state'); continue;
      }
      if (pending?.role === role) { pending.text += text; builder.loss('stream_chunks_joined', 'Adjacent Grok message chunks are joined as conversation text'); }
      else { flush(); pending = { role, text }; }
      continue;
    }
    flush();
    if (kind === 'agent_thought_chunk') builder.loss('thinking_not_imported', 'Private Grok thought chunks are omitted');
    else if (['user_message_chunk', 'agent_message_chunk'].includes(kind)) {
      if (content?.type === 'image') { builder.loss('attachment_not_imported', 'Grok images are not copied'); builder.add('metadata', '[attachment not imported]'); }
      else throw new Error('Grok message update is malformed');
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      if (typeof update.toolCallId !== 'string' || !update.toolCallId) throw new Error('Grok tool update is missing its call id');
      const extra = { toolName: String(update.title ?? '').slice(0, 200), toolCallId: update.toolCallId.slice(0, 200) };
      if (kind === 'tool_call') builder.add('tool_call', update.rawInput ?? {}, extra);
      else if (['completed', 'failed'].includes(update.status)) {
        const blocks = Array.isArray(update.content) ? update.content : [];
        const portable = blocks.filter((item) => item?.content?.type === 'text');
        const rawText = update.rawOutput?.session_migrate_text;
        const text = typeof rawText === 'string' ? rawText : portable.map((item) => item.content.text ?? '').join('') || (update.rawOutput === undefined ? '' : JSON.stringify(update.rawOutput));
        builder.add('tool', text, extra);
        builder.loss('tool_output_blocks_not_imported', 'Non-text Grok tool output is omitted', blocks.length - portable.length);
      } else builder.loss('unfinished_tool_update_not_imported', 'In-progress Grok tool updates are not continued or executed');
    } else builder.loss('grok_update_not_imported', 'Grok plans, modes and other internal updates are omitted');
  }
  flush(); return builder.result(summary.generated_title ?? summary.session_summary);
}
export const adapter = fileAdapter(definition, (name) => name === 'summary.json' || name.endsWith('.grok.json'), async ({ home, externalId }, { signal }) => {
  const input = await readInput(home, externalId, signal); const value = JSON.parse(input.bytes.toString('utf8'));
  if (value.schema === 'session-migrate.grok.v1') return { ...input, data: { summary: value.summary, updates: value.updates } };
  if (path.basename(input.file) !== 'summary.json') throw new Error('Choose Grok summary.json or a session-migrate Grok bundle');
  const updates = await readInput(home, path.join(path.dirname(externalId), 'updates.jsonl'), signal);
  return { ...input, bytes: Buffer.concat([input.bytes, Buffer.from('\0'), updates.bytes]), data: { summary: value, updates: jsonLines(updates.bytes) } };
}, projectGrok);
