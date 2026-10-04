import { createReadStream } from 'node:fs';
import { open, realpath, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { codexConversationIndex, portableCodexRecord } from './native-selection.mjs';

const definition = { schemaVersion: 1, id: 'codex', label: 'Codex', formatVersion: 'codex-rollout-jsonl-v1' };
const snapshots = new Map();
const cache = new Map();
const loss = (code, detail) => ({ code, count: 1, detail });
function reportLosses(items) {
  const counts = new Map();
  for (const item of items) {
    const previous = counts.get(item.code);
    if (previous) previous.count += item.count;
    else counts.set(item.code, { ...item });
  }
  return [...counts.values()];
}
async function locate(home, externalId) {
  if (!path.isAbsolute(home)) throw new Error('Choose an absolute source directory');
  const root = await realpath(home);
  const file = await realpath(path.resolve(root, externalId));
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !file.endsWith('.jsonl')) throw new Error('Session file must be JSONL inside the chosen source home');
  return { file, sourceHome: process.platform === 'win32' ? root.toLowerCase() : root };
}
async function* lines(file, offset, signal) {
  const handle = await open(file, 'r');
  const buffer = Buffer.alloc(64 * 1024);
  let position = offset; let start = offset; let parts = []; let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      let from = 0;
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] !== 10) continue;
        parts.push(Buffer.from(buffer.subarray(from, i))); size += i - from;
        yield { text: Buffer.concat(parts, size).toString('utf8'), start, next: position + i + 1 };
        start = position + i + 1; from = i + 1; parts = []; size = 0;
      }
      parts.push(Buffer.from(buffer.subarray(from, bytesRead))); size += bytesRead - from;
      if (size > 128 * 1024 * 1024) throw new Error('JSONL record exceeds 128 MiB; export smaller records');
      position += bytesRead;
    }
    if (size) yield { text: Buffer.concat(parts, size).toString('utf8'), start, next: position };
  } finally { await handle.close(); }
}
function convert(raw, ordinal) {
  const records = []; const losses = [];
  const payload = raw.payload ?? {};
  const add = (role, text, extra = {}) => {
    const value = typeof text === 'string' ? text : JSON.stringify(text ?? '');
    const id = `${ordinal}:${records.length}`;
    for (let part = 0, offset = 0; offset < value.length || part === 0; part++) {
      let end = Math.min(value.length, offset + 48 * 1024);
      if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
      records.push({ id, part, role, text: value.slice(offset, end), timestamp: typeof raw.timestamp === 'string' ? raw.timestamp.slice(0, 100) : undefined, ...extra });
      offset = end;
    }
  };
  const content = (value, role) => {
    if (typeof value === 'string') { add(role, value); return; }
    if (!Array.isArray(value)) { losses.push(loss('unknown_content', 'Unrecognized Codex message content')); add('metadata', value); return; }
    for (const block of value) {
      if (['input_text', 'output_text', 'text', 'reasoning_text'].includes(block?.type)) add(role, block.text);
      else if (['input_image', 'image', 'document'].includes(block?.type)) {
        losses.push(loss('attachment_not_imported', 'Referenced or embedded attachment is not copied; text history remains available'));
        add('metadata', `[${block.type}: attachment not imported]`);
      } else { losses.push(loss('unknown_block', `Unknown Codex content block: ${String(block?.type).slice(0, 100)}`)); add('metadata', block); }
    }
  };
  if (raw.type === 'response_item') {
    if (payload.type === 'message' && ['user', 'assistant', 'system', 'developer'].includes(payload.role)) content(payload.content, payload.role === 'developer' ? 'system' : payload.role);
    else if (['function_call', 'custom_tool_call'].includes(payload.type)) add('tool_call', payload.arguments ?? payload.input, { toolName: String(payload.name ?? '').slice(0, 200), toolCallId: String(payload.call_id ?? '').slice(0, 200) });
    else if (['function_call_output', 'custom_tool_call_output'].includes(payload.type)) add('tool', payload.output, { toolCallId: String(payload.call_id ?? '').slice(0, 200) });
    else if (payload.type === 'reasoning') { content(payload.summary ?? payload.content ?? [], 'assistant'); if (payload.encrypted_content) losses.push(loss('encrypted_reasoning', 'Encrypted reasoning cannot be decoded')); }
    else { losses.push(loss('unknown_response', `Unknown Codex response item: ${String(payload.type).slice(0, 100)}`)); add('metadata', payload); }
  } else if (raw.type === 'event_msg') {
    if (['user_message', 'agent_message', 'agent_reasoning'].includes(payload.type)) add(payload.type === 'user_message' ? 'user' : 'assistant', payload.message ?? payload.text);
    else add('metadata', payload);
  } else if (raw.type === 'compacted') add('system', payload.message ?? payload.summary ?? payload);
  else if (raw.type === 'session_meta' || raw.type === 'turn_context') {
    add('metadata', payload);
    if (payload.history_base || payload.forked_from_id || payload.parent_thread_id) losses.push(loss('inherited_history_not_loaded', 'Parent thread history is not loaded automatically; selected file is archived as stored'));
  } else { losses.push(loss('unknown_record', `Unknown Codex record: ${String(raw.type).slice(0, 100)}`)); add('metadata', raw); }
  return { records, losses };
}
async function discover({ home, cursor }, { signal }) {
  if (!path.isAbsolute(home)) throw new Error('Choose an absolute source directory');
  const root = await realpath(home); const entries = [];
  let passed = cursor === undefined;
  async function walk(directory, depth) {
    if (depth > 20) throw new Error('Source directory exceeds 20 levels; choose a closer history directory');
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      signal.throwIfAborted(); if (entries.length > 100) return;
      const file = path.join(directory, item.name);
      if (item.isDirectory()) await walk(file, depth + 1);
      else if (item.isFile() && item.name.endsWith('.jsonl')) {
        const externalId = path.relative(root, file).replaceAll('\\', '/');
        if (passed) entries.push({ externalId, title: item.name });
        else if (externalId === cursor) passed = true;
      }
    }
  }
  await walk(root, 0);
  if (!passed) throw new Error('Discovery cursor no longer exists; list the source again');
  return { entries: entries.slice(0, 100), cursor: entries.length > 100 ? entries[99].externalId : null };
}
async function probe(args, context) {
  const result = await probeBase(args, context);
  if (args.mode !== 'native-session') return result;
  const { file } = await locate(args.home, args.externalId);
  const index = codexConversationIndex(); let malformed = 0;
  for await (const line of lines(file, 0, context.signal)) {
    if (!line.text.trim()) continue;
    let raw;
    try { raw = JSON.parse(line.text); } catch { malformed++; continue; }
    index.add(raw, line.start);
  }
  const selected = index.finish();
  snapshots.get(file).nativeRows = selected.offsets;
  snapshots.get(file).historyMode = selected.historyMode;
  const losses = result.losses.filter((item) => !['archive_only', 'bad_jsonl_sample'].includes(item.code));
  if (selected.duplicates) losses.push({ code: 'duplicate_message_projection', count: selected.duplicates, detail: 'Duplicate response/event views are collapsed with occurrence counts; intentional repeated messages remain' });
  if (malformed) losses.push({ code: 'bad_jsonl', count: malformed, detail: 'Malformed rows were omitted during conversation selection' });
  if (selected.historyMode === 'paginated') losses.push(loss('paginated_provider_context_not_imported', 'Conversation text comes from canonical completed items, not synthetic provider context messages'));
  return { ...result, losses };
}
function convertNative(raw, offset, historyMode) {
  raw = portableCodexRecord(raw, historyMode);
  const payload = raw.payload ?? {};
  if ((raw.type === 'response_item' && payload.type === 'reasoning') || (raw.type === 'event_msg' && payload.type === 'agent_reasoning')) return { records: [], losses: [loss('thinking_not_imported', 'Internal reasoning is omitted from portable conversation text')] };
  if (raw.type === 'compacted') raw = { ...raw, type: 'response_item', payload: { type: 'message', role: 'assistant', content: `[Imported historical compaction summary]\n${payload.message ?? payload.summary ?? ''}` } };
  if (raw.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(payload.type) && Array.isArray(payload.output)) {
    const text = payload.output.filter((block) => ['text', 'input_text', 'output_text'].includes(block?.type)).map((block) => block.text ?? '').join('\n');
    const parsed = convert({ ...raw, payload: { ...payload, output: text } }, offset);
    const omitted = payload.output.length - payload.output.filter((block) => ['text', 'input_text', 'output_text'].includes(block?.type)).length;
    if (omitted) parsed.losses.push({ code: 'tool_output_blocks_not_imported', count: omitted, detail: 'Non-text historical tool output blocks are omitted' });
    return parsed;
  }
  return convert(raw, offset);
}
async function parseNative({ home, externalId, revision, cursor }, { signal }) {
  const { file } = await locate(home, externalId); const current = await stat(file);
  let snapshot = snapshots.get(file);
  if (!snapshot?.nativeRows || snapshot.revision !== revision || snapshot.size !== current.size || snapshot.mtimeMs !== current.mtimeMs) {
    const checked = await probe({ home, externalId, mode: 'native-session' }, { signal });
    if (checked.revision !== revision) throw new Error('Source changed; preview again');
    snapshot = snapshots.get(file);
  }
  const position = cursor ? JSON.parse(cursor) : { index: 0, skip: 0 };
  if (![position.index, position.skip].every((item) => Number.isSafeInteger(item) && item >= 0) || position.index > snapshot.nativeRows.length) throw new Error('Invalid native parser cursor');
  const records = []; const losses = []; let bytes = 0; let scanned = 0;
  for (let index = position.index; index < snapshot.nativeRows.length; index++) {
    const offset = snapshot.nativeRows[index]; let raw;
    for await (const line of lines(file, offset, signal)) { raw = JSON.parse(line.text); break; }
    const parsed = convertNative(raw, offset, snapshot.historyMode);
    for (let part = index === position.index ? position.skip : 0; part < parsed.records.length; part++) {
      const record = parsed.records[part]; const size = Buffer.byteLength(JSON.stringify(record));
      if (records.length && (records.length >= 32 || bytes + size > 192 * 1024)) return { records, losses: reportLosses(losses), cursor: JSON.stringify({ index, skip: part }), bytesRead: Math.floor(snapshot.size * index / snapshot.nativeRows.length) };
      if (part === 0) losses.push(...parsed.losses);
      records.push(record); bytes += size;
    }
    if (!parsed.records.length) losses.push(...parsed.losses);
    if (++scanned >= 256 && index + 1 < snapshot.nativeRows.length) return { records, losses: reportLosses(losses), cursor: JSON.stringify({ index: index + 1, skip: 0 }), bytesRead: Math.floor(snapshot.size * (index + 1) / snapshot.nativeRows.length) };
  }
  return { records, losses: reportLosses(losses), cursor: null, bytesRead: snapshot.size };
}
async function probeBase({ home, externalId }, { signal }) {
  const { file, sourceHome } = await locate(home, externalId);
  const before = await stat(file); const hash = createHash('sha256');
  for await (const bytes of createReadStream(file, { signal })) hash.update(bytes);
  const after = await stat(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Source changed during preview');
  const revision = hash.digest('hex'); snapshots.set(file, { revision, size: after.size, mtimeMs: after.mtimeMs });
  let title = path.basename(file); let recognized = false; let count = 0;
  const losses = [loss('archive_only', 'Response and event channels are kept as recorded, including duplicate views; no executable continuation state is reconstructed')];
  for await (const line of lines(file, 0, signal)) {
    if (!line.text.trim()) continue;
    try {
      const raw = JSON.parse(line.text);
      if (['session_meta', 'response_item', 'event_msg'].includes(raw.type)) recognized = true;
      if (raw.payload?.type === 'thread_name_updated') title = String(raw.payload.thread_name ?? raw.payload.threadName ?? title).slice(0, 500);
    } catch { losses.push(loss('bad_jsonl_sample', 'Invalid JSONL row in preview sample; full import counts are reported separately')); }
    if (++count >= 64) break;
  }
  return { revision, title, sourceHome, formatVersion: definition.formatVersion, status: recognized ? 'partial' : 'unsupported', losses: reportLosses(losses), totalBytes: after.size };
}
async function parse({ home, externalId, revision, cursor, mode }, { signal }) {
  if (mode === 'native-session') return parseNative({ home, externalId, revision, cursor }, { signal });
  const { file } = await locate(home, externalId); const current = await stat(file);
  let snapshot = snapshots.get(file);
  if (!snapshot || snapshot.revision !== revision || snapshot.size !== current.size || snapshot.mtimeMs !== current.mtimeMs) {
    const checked = await probe({ home, externalId }, { signal });
    if (checked.revision !== revision) throw new Error('Source changed; preview again');
    snapshot = snapshots.get(file);
  }
  const position = cursor ? JSON.parse(cursor) : { offset: 0, skip: 0 };
  if (!Number.isSafeInteger(position.offset) || position.offset < 0 || !Number.isSafeInteger(position.skip) || position.skip < 0) throw new Error('Invalid parser cursor');
  const records = []; const losses = []; let chars = 0; let bytesRead = position.offset; let scanned = 0;
  for await (const line of lines(file, position.offset, signal)) {
    const cacheKey = `${file}:${revision}:${line.start}`;
    let parsed = cache.get(cacheKey);
    if (!parsed) {
      try { parsed = line.text.trim() ? convert(JSON.parse(line.text), line.start) : { records: [], losses: [] }; }
      catch { parsed = { records: [], losses: [loss('bad_jsonl', `Invalid JSONL row at byte ${line.start}`)] }; }
      cache.clear(); cache.set(cacheKey, parsed);
    }
    let index = line.start === position.offset ? position.skip : 0;
    for (; index < parsed.records.length; index++) {
      const record = parsed.records[index];
      const bytes = Buffer.byteLength(JSON.stringify(record));
      if (records.length && (records.length >= 32 || chars + bytes > 192 * 1024)) return { records, losses: reportLosses(losses), cursor: JSON.stringify({ offset: line.start, skip: index }), bytesRead: line.start };
      if (index === 0) losses.push(...parsed.losses);
      records.push(record); chars += bytes;
    }
    if (parsed.records.length === 0) losses.push(...parsed.losses);
    bytesRead = line.next;
    if (++scanned >= 256) return { records, losses: reportLosses(losses), cursor: bytesRead < snapshot.size ? JSON.stringify({ offset: bytesRead, skip: 0 }) : null, bytesRead };
  }
  return { records, losses: reportLosses(losses), cursor: null, bytesRead };
}
export function register(api) { api.registerSessionSource(definition, { discover, probe, parse }); }
