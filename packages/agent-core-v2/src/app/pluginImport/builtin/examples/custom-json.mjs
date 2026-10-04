import { readFile, realpath, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

async function snapshot({ home, externalId }, { signal }) {
  if (!path.isAbsolute(home)) throw new Error('Choose an absolute source directory');
  const root = await realpath(home); const file = await realpath(path.resolve(root, externalId));
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Choose a JSON file inside the source directory');
  const bytes = await readFile(file, { signal });
  if (bytes.length > 64 * 1024 * 1024) throw new Error('Example JSON export exceeds 64 MiB');
  const data = JSON.parse(bytes.toString('utf8')); const messages = Array.isArray(data) ? data : data.messages;
  if (!Array.isArray(messages)) throw new Error('Example expects a JSON message array or an object with messages');
  const records = []; let omitted = 0;
  for (const [index, message] of messages.entries()) {
    signal.throwIfAborted();
    if (!['user', 'assistant', 'system', 'tool', 'tool_call', 'metadata'].includes(message.role) || typeof (message.text ?? message.content) !== 'string') { omitted++; continue; }
    const text = message.text ?? message.content;
    for (let offset = 0, part = 0; offset < text.length || part === 0; part++) {
      let end = Math.min(text.length, offset + 48 * 1024);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      records.push({ id: String(index), part, role: message.role, text: text.slice(offset, end) }); offset = end;
    }
  }
  return { records, revision: createHash('sha256').update(bytes).digest('hex'), totalBytes: bytes.length,
    sourceHome: process.platform === 'win32' ? root.toLowerCase() : root, title: String(data.title ?? path.basename(file)).slice(0, 500),
    losses: omitted ? [{ code: 'custom_message_not_imported', count: omitted, detail: 'Example accepts recognized roles with string text/content only' }] : [] };
}
export async function discover({ home, cursor }, { signal }) {
  signal.throwIfAborted();
  const files = (await readdir(home)).filter((name) => name.endsWith('.json')).toSorted();
  const start = cursor === undefined ? 0 : files.indexOf(cursor) + 1;
  if (cursor !== undefined && start === 0) throw new Error('Source list changed; discover again');
  const page = files.slice(start, start + 100);
  return { entries: page.map((externalId) => ({ externalId, title: externalId })), cursor: start + page.length < files.length ? page.at(-1) : null };
}
export async function probe(args, context) {
  const { records, ...value } = await snapshot(args, context);
  return { ...value, formatVersion: 'custom-records-v1', status: records.length ? 'partial' : 'unsupported' };
}
export async function parse(args, context) {
  const value = await snapshot(args, context);
  if (value.revision !== args.revision) throw new Error('Custom source changed; preview again');
  const start = args.cursor === undefined ? 0 : Number(args.cursor);
  if (!Number.isSafeInteger(start) || start < 0 || start > value.records.length) throw new Error('Invalid example cursor');
  const records = []; let index = start; let bytes = 0;
  while (index < value.records.length) {
    const record = value.records[index]; const size = Buffer.byteLength(JSON.stringify(record));
    if (records.length && (records.length >= 32 || bytes + size > 192 * 1024)) break;
    records.push(record); bytes += size; index++;
  }
  return { records, cursor: index < value.records.length ? String(index) : null, losses: [],
    bytesRead: index === value.records.length ? value.totalBytes : Math.floor(value.totalBytes * index / value.records.length) };
}
