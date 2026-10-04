import { fileAdapter, readInput, recordBuilder } from './files.mjs';

export const definition = { schemaVersion: 1, id: 'opencode', label: 'OpenCode export', formatVersion: 'opencode-export-v1' };
export function transformShareData(data) {
  const session = data.find((item) => item.type === 'session');
  if (!session) throw new Error('OpenCode share export is missing its session');
  const messages = new Map(); const parts = new Map();
  for (const item of data) {
    if (item.type === 'message') messages.set(item.data.id, item.data);
    else if (item.type === 'part') {
      if (!parts.has(item.data.messageID)) parts.set(item.data.messageID, []);
      parts.get(item.data.messageID).push(item.data);
    }
  }
  if (!messages.size) throw new Error('OpenCode share export has no messages');
  for (const id of parts.keys()) if (!messages.has(id)) throw new Error('OpenCode part references a missing message');
  return { info: session.data, messages: [...messages.values()].map((info) => ({ info, parts: parts.get(info.id) ?? [] })) };
}
export function projectOpenCode(data, signal) {
  const value = Array.isArray(data) ? transformShareData(data) : data;
  if (!value?.info?.id || !Array.isArray(value.messages)) throw new Error('Choose an OpenCode JSON export with info and messages');
  const builder = recordBuilder(signal); const seen = new Set();
  let messages = value.messages;
  if (value.info.revert) {
    const end = messages.findIndex((message) => message.info?.id === value.info.revert.messageID);
    if (end < 0) throw new Error('OpenCode revert references a missing message');
    builder.loss('reverted_history_not_imported', 'OpenCode reverted messages are omitted', messages.length - end);
    messages = messages.slice(0, end);
  }
  if (value.info.parentID) builder.loss('inherited_history_not_loaded', 'OpenCode parent session files are not loaded automatically');
  for (const message of messages) {
    signal.throwIfAborted(); const info = message?.info;
    if (!info?.id || seen.has(info.id) || (info.sessionID && info.sessionID !== value.info.id)) throw new Error('OpenCode message linkage or identity is invalid');
    seen.add(info.id);
    if (!['user', 'assistant'].includes(info.role)) { builder.loss('unknown_message_role', 'Unsupported OpenCode message roles are omitted'); continue; }
    if (!Array.isArray(message.parts)) throw new Error('OpenCode message has no parts array');
    for (const part of message.parts) {
      if ((part.messageID && part.messageID !== info.id) || (part.sessionID && part.sessionID !== value.info.id)) throw new Error('OpenCode part linkage is invalid');
      if (part.type === 'text') {
        if (part.synthetic || part.ignored) builder.loss('synthetic_text_not_imported', 'OpenCode synthetic and ignored text is omitted');
        else if (typeof part.text === 'string') builder.add(info.role, info.summary ? `[Imported historical compaction summary]\n${part.text}` : part.text);
        else builder.loss('unknown_content', 'Malformed OpenCode text is omitted');
      } else if (part.type === 'tool') {
        const extra = { toolName: String(part.tool ?? '').slice(0, 200), toolCallId: String(part.callID ?? '').slice(0, 200) };
        builder.add('tool_call', part.state?.input ?? {}, extra);
        if (['completed', 'error'].includes(part.state?.status)) builder.add('tool', part.state.output ?? part.state.error ?? '', extra);
        else builder.loss('unfinished_tool_update_not_imported', 'OpenCode unfinished tool state is not resumed');
        if (part.state?.attachments?.length) builder.loss('attachment_not_imported', 'OpenCode tool attachments are not copied', part.state.attachments.length);
      } else if (part.type === 'reasoning') builder.loss('thinking_not_imported', 'Private OpenCode reasoning is omitted');
      else if (part.type === 'file') { builder.loss('attachment_not_imported', 'OpenCode file parts are not copied'); builder.add('metadata', '[attachment not imported]'); }
      else builder.loss('opencode_part_not_imported', 'OpenCode steps, patches, compaction boundaries and other internal parts are omitted');
    }
  }
  return builder.result(value.info.title);
}
export const adapter = fileAdapter(definition, (name) => name.endsWith('.json'), async ({ home, externalId }, { signal }) => {
  const input = await readInput(home, externalId, signal); return { ...input, data: JSON.parse(input.bytes.toString('utf8')) };
}, projectOpenCode);
