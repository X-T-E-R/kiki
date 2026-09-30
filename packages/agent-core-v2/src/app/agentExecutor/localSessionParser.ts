/**
 * Read-only adaptation of Codeg's Apache-2.0 Claude/Codex JSONL interpreters:
 * src-tauri/src/parsers/{claude,codex}.rs. Preserve vendor identity, title
 * precedence and canonical Codex messages; never project into Kiki's event log.
 * This is a bounded transcript preview, not a vendor history reconstruction.
 */
export type LocalSessionEngine = 'claude' | 'codex';
export interface LocalSessionBlock {
  readonly kind: 'text' | 'thought' | 'tool_call' | 'tool_result' | 'image';
  readonly text?: string;
  readonly name?: string;
}
export interface LocalSessionMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'system';
  readonly timestamp?: string;
  readonly blocks: readonly LocalSessionBlock[];
}
export interface ParsedLocalSession {
  readonly externalId?: string;
  readonly cwd?: string;
  readonly title?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly lastPrompt?: string;
  readonly parentId?: string;
  readonly messages: readonly LocalSessionMessage[];
  readonly warnings: readonly string[];
}

type JsonRecord = Partial<Record<
  'type' | 'text' | 'thinking' | 'name' | 'content' | 'timestamp' | 'payload' | 'uuid' | 'id' |
  'sessionId' | 'cwd' | 'customTitle' | 'aiTitle' | 'summary' | 'isMeta' | 'isSidechain' |
  'message' | 'model' | 'isCompactSummary' | 'forked_from_id' | 'parent_thread_id' |
  'history_base' | 'thread_name' | 'threadName' | 'role' | 'output', unknown>>;
const MAX_BLOCK_CHARS = 32_768;
function record(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function timestamp(value: unknown): string | undefined {
  const raw = text(value);
  return raw !== undefined && Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : undefined;
}
function blocks(value: unknown, warnings: Set<string>): LocalSessionBlock[] {
  if (typeof value === 'string') return [{ kind: 'text', text: clip(value, warnings) }];
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): LocalSessionBlock[] => {
    const block = record(raw);
    switch (block.type) {
      case 'text': case 'input_text': case 'output_text':
        return [{ kind: 'text', text: clip(text(block.text) ?? '', warnings) }];
      case 'thinking': case 'reasoning_text':
        return [{ kind: 'thought', text: clip(text(block.thinking) ?? text(block.text) ?? '', warnings) }];
      case 'tool_use': case 'server_tool_use':
        return [{ kind: 'tool_call', name: text(block.name) }];
      case 'tool_result': case 'server_tool_result':
        return [{ kind: 'tool_result', text: clip(plainText(block.content), warnings) }];
      case 'image': case 'input_image':
        // Do not inline base64 media, local image paths or private payloads.
        return [{ kind: 'image' }];
      default:
        warnings.add('unsupported_content');
        return [];
    }
  });
}
function plainText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((item) => text(record(item).text) ?? '').filter(Boolean).join('\n');
}
function clip(value: string, warnings: Set<string>): string {
  if (value.length > MAX_BLOCK_CHARS) warnings.add('content_truncated');
  return value.slice(0, MAX_BLOCK_CHARS);
}
function messageText(message: LocalSessionMessage): string {
  return message.blocks.filter((block) => block.kind === 'text').map((block) => block.text ?? '').join('\n');
}

export function parseLocalSession(engine: LocalSessionEngine, input: string): ParsedLocalSession {
  let externalId: string | undefined;
  let cwd: string | undefined;
  let title: string | undefined;
  let generatedTitle: string | undefined;
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  let parentId: string | undefined;
  let codexHeaderSeen = false;
  const warnings = new Set<string>();
  const messages: Array<LocalSessionMessage & { channel: 'canonical' | 'response'; ordinal: number }> = [];
  let ordinal = 0;
  for (const line of input.split('\n')) {
    ordinal += 1;
    if (line.trim().length === 0) continue;
    let value: JsonRecord;
    try { value = record(JSON.parse(line)); } catch { warnings.add('invalid_jsonl_record'); continue; }
    const time = timestamp(value.timestamp);
    createdAt ??= time;
    if (time !== undefined) updatedAt = time;
    const payload = record(value.payload);
    const add = (role: LocalSessionMessage['role'], content: unknown, channel: 'canonical' | 'response' = 'canonical') => {
      const contentBlocks = blocks(content, warnings);
      if (contentBlocks.length === 0) return;
      messages.push({ id: text(value.uuid) ?? text(payload.id) ?? `record-${ordinal}`,
        role, timestamp: time, blocks: contentBlocks, channel, ordinal });
    };
    if (engine === 'claude') {
      externalId ??= text(value.sessionId);
      cwd ??= text(value.cwd);
      if (value.type === 'custom-title') title = text(value.customTitle)?.trim() || title;
      if (value.type === 'ai-title') generatedTitle = text(value.aiTitle)?.trim() || generatedTitle;
      if (value.type === 'summary') {
        add('system', text(value.summary));
        continue;
      }
      if (value.isMeta === true || value.isSidechain === true) continue;
      const message = record(value.message);
      if (value.type === 'assistant' && message.model === '<synthetic>') continue;
      const raw = typeof message.content === 'string' ? message.content :
        Array.isArray(message.content) && message.content.length === 1 && record(message.content[0]).type === 'text'
          ? record(message.content[0]).text : undefined;
      if (value.type === 'user' && (raw === '[Request interrupted by user]' || raw === '[Request interrupted by user for tool use]')) continue;
      if (value.type === 'user' || value.type === 'assistant') {
        add(value.isCompactSummary === true ? 'system' : value.type, message.content);
      }
      continue;
    }
    if (value.type === 'session_meta' && !codexHeaderSeen) {
      // The first header belongs to this thread; replayed headers belong to parents.
      codexHeaderSeen = true;
      externalId = text(payload.id);
      cwd = text(payload.cwd);
      parentId = text(payload.forked_from_id) ?? text(payload.parent_thread_id);
      if (payload.history_base !== undefined) warnings.add('inherited_history_not_loaded');
    } else if (value.type === 'event_msg') {
      if (payload.type === 'thread_name_updated') title = text(payload.thread_name) ?? text(payload.threadName) ?? text(payload.name) ?? title;
      if (payload.type === 'user_message') add('user', payload.message);
      if (payload.type === 'agent_message') add('assistant', payload.message);
      if (payload.type === 'agent_reasoning') {
        add('assistant', [{ type: 'reasoning_text', text: payload.text }]);
      }
    } else if (value.type === 'response_item') {
      if (payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
        add(payload.role, payload.content, 'response');
      } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        add('assistant', [{ type: 'tool_use', name: payload.name }]);
      } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
        add('system', [{ type: 'tool_result', content: payload.output }]);
      }
    } else if (value.type === 'compacted') {
      add('system', text(payload.message) ?? text(payload.summary));
    }
  }
  // Codex can persist the same spoken turn in both channels. Pair nearby twins
  // one-to-one; repeated identical prompts in different turns remain distinct.
  const matched = new Set<number>();
  const visible = messages.filter((message, messageIndex) => {
    if (message.channel !== 'response') return true;
    const content = messageText(message);
    if (content.length === 0 || message.timestamp === undefined) return true;
    for (let index = Math.max(0, messageIndex - 8); index < Math.min(messages.length, messageIndex + 9); index += 1) {
      const other = messages[index]!;
      if (other.channel === 'canonical' && !matched.has(index) && other.role === message.role &&
          Math.abs(other.ordinal - message.ordinal) <= 8 && other.timestamp === message.timestamp &&
          messageText(other) === content) {
        matched.add(index);
        return false;
      }
    }
    return true;
  }).map(({ channel: _channel, ordinal: _ordinal, ...message }) => message);
  const prompts = visible.filter((message) => message.role === 'user').map(messageText).filter(Boolean);
  return { externalId, cwd, title: (title ?? generatedTitle ?? prompts[0])?.slice(0, 160),
    createdAt, updatedAt, lastPrompt: prompts.at(-1)?.slice(0, 500), parentId,
    messages: visible, warnings: [...warnings] };
}
