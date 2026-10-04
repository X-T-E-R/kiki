import { createHash } from 'node:crypto';

function fingerprint(role, text) {
  const normalized = String(text ?? '').replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
  return createHash('sha256').update(`${role}\0${normalized}`).digest('hex');
}
function messageText(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter((block) => ['input_text', 'output_text', 'text'].includes(block?.type)).map((block) => block.text ?? '').join('\n') : '';
}
export function codexConversationIndex() {
  const rows = []; const responseMessages = new Map(); let historyMode = 'legacy'; let metadataSeen = false; let ordinal = 0;
  return {
    add(raw, offset) {
      const payload = raw.payload ?? {};
      if (raw.type === 'session_meta') {
        const selected = payload.history_mode ?? 'legacy';
        if (!['legacy', 'paginated'].includes(selected)) throw new Error(`Unsupported Codex history mode: ${selected}`);
        if (metadataSeen && selected !== historyMode) throw new Error('Codex session metadata has conflicting history modes');
        if (selected === 'paginated' && ordinal !== 0) throw new Error('Codex paginated history must start with session metadata');
        metadataSeen = true; historyMode = selected;
      }
      if (historyMode === 'paginated' && raw.ordinal !== ordinal) throw new Error('Codex paginated ordinals must be contiguous from zero');
      ordinal++;
      const response = raw.type === 'response_item' && payload.type === 'message' && ['user', 'assistant'].includes(payload.role);
      const eventRole = raw.type === 'event_msg' && payload.type === 'user_message' ? 'user' : raw.type === 'event_msg' && payload.type === 'agent_message' ? 'assistant' : undefined;
      const responseKey = response ? fingerprint(payload.role, messageText(payload.content)) : undefined;
      if (responseKey) responseMessages.set(responseKey, (responseMessages.get(responseKey) ?? 0) + 1);
      rows.push({ offset, response, eventKey: eventRole ? fingerprint(eventRole, payload.message ?? payload.text) : undefined });
    },
    finish() {
      let duplicates = 0;
      const selected = rows.filter((row) => {
        if (historyMode === 'paginated') return !row.response && !row.eventKey;
        if (row.eventKey && responseMessages.get(row.eventKey)) {
          responseMessages.set(row.eventKey, responseMessages.get(row.eventKey) - 1); duplicates++; return false;
        }
        return true;
      });
      return { offsets: selected.map((row) => row.offset), historyMode, duplicates };
    },
  };
}

export function portableCodexRecord(raw, historyMode) {
  const payload = raw.payload ?? {};
  if (historyMode === 'paginated' && raw.type === 'event_msg' && payload.type === 'item_completed') {
    const item = payload.item ?? {};
    if (item.type === 'UserMessage' || item.type === 'AgentMessage') {
      const content = Array.isArray(item.content) ? item.content.map((block) => ({ ...block, type: ['Text', 'text'].includes(block?.type) ? 'text' : block?.type })) : item.content;
      return { ...raw, type: 'response_item', payload: { type: 'message', role: item.type === 'UserMessage' ? 'user' : 'assistant', content } };
    }
  }
  return raw;
}
