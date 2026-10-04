import { readFile, realpath, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
export async function readInput(home, externalId, signal) {
  if (!path.isAbsolute(home)) throw new Error('Choose an absolute source directory');
  const root = await realpath(home);
  const file = await realpath(path.resolve(root, externalId));
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('History must be inside the chosen source directory');
  const before = await stat(file);
  if (!before.isFile() || before.size > MAX_EXPORT_BYTES) throw new Error('Choose a history export file no larger than 64 MiB');
  const bytes = await readFile(file, { signal });
  const after = await stat(file);
  if (bytes.length > MAX_EXPORT_BYTES || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Source changed during read; preview again');
  return { file, bytes, sourceHome: process.platform === 'win32' ? root.toLowerCase() : root };
}
export function jsonLines(bytes) {
  return bytes.toString('utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}
export function recordBuilder(signal) {
  const records = []; const losses = new Map();
  return {
    records,
    loss(code, detail, count = 1) {
      if (!count) return;
      const previous = losses.get(code);
      if (previous) previous.count += count;
      else losses.set(code, { code, detail, count });
    },
    add(role, text, extra = {}) {
      signal.throwIfAborted();
      const value = typeof text === 'string' ? text : JSON.stringify(text ?? '');
      const id = String(records.length);
      for (let part = 0, offset = 0; offset < value.length || part === 0; part++) {
        let end = Math.min(value.length, offset + 48 * 1024);
        if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
        records.push({ id, part, role, text: value.slice(offset, end), ...extra }); offset = end;
      }
    },
    result(title) { return { records, losses: [...losses.values()], title }; },
  };
}
export function textBlocks(builder, content, role, extra = {}) {
  if (typeof content === 'string') { builder.add(role, content, extra); return; }
  if (!Array.isArray(content)) { builder.loss('unknown_content', 'Unrecognized message content is omitted'); return; }
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') builder.add(role, block.text, extra);
    else if (block?.type === 'image' || block?.type === 'file') {
      builder.loss('attachment_not_imported', 'Attachments are not copied'); builder.add('metadata', '[attachment not imported]');
    } else if (block?.type === 'thinking' || block?.type === 'reasoning') builder.loss('thinking_not_imported', 'Private thinking is omitted');
    else builder.loss('unknown_block', 'Unrecognized content blocks are omitted');
  }
}
export function fileAdapter(definition, accepts, load, project) {
  const snapshots = new Map();
  async function inspect(args, context, refresh = false) {
    context.signal.throwIfAborted();
    if (!path.isAbsolute(args.home)) throw new Error('Choose an absolute source directory');
    const root = await realpath(args.home); const sourceHome = process.platform === 'win32' ? root.toLowerCase() : root;
    const key = `${sourceHome}\0${args.externalId}\0${args.mode ?? ''}`;
    let snapshot = snapshots.get(key);
    if (snapshot && !refresh) return snapshot;
    const input = await load(args, context);
    const revision = createHash('sha256').update(input.bytes).digest('hex');
    if (snapshot?.revision !== revision) {
      const converted = project(input.data, context.signal, args.mode);
      snapshot = { ...converted, revision, sourceHome: input.sourceHome, totalBytes: input.bytes.length };
      snapshots.set(key, snapshot);
      if (snapshots.size > 2) snapshots.delete(snapshots.keys().next().value);
    }
    return snapshot;
  }
  return {
    async discover({ home, cursor }, { signal }) {
      if (!path.isAbsolute(home)) throw new Error('Choose an absolute source directory');
      const root = await realpath(home); const entries = []; let passed = cursor === undefined;
      async function walk(directory, depth) {
        if (depth > 20) throw new Error('Choose a source directory closer to the history files');
        for (const item of (await readdir(directory, { withFileTypes: true })).toSorted((a, b) => a.name.localeCompare(b.name))) {
          signal.throwIfAborted(); if (entries.length > 100) return;
          const file = path.join(directory, item.name);
          if (item.isDirectory()) await walk(file, depth + 1);
          else if (item.isFile() && accepts(item.name)) {
            const externalId = path.relative(root, file).replaceAll('\\', '/');
            if (passed) entries.push({ externalId, title: item.name }); else if (externalId === cursor) passed = true;
          }
        }
      }
      await walk(root, 0);
      if (!passed) throw new Error('Discovery cursor no longer exists; list the source again');
      return { entries: entries.slice(0, 100), cursor: entries.length > 100 ? entries[99].externalId : null };
    },
    async probe(args, context) {
      const snapshot = await inspect(args, context, true);
      return { revision: snapshot.revision, sourceHome: snapshot.sourceHome, totalBytes: snapshot.totalBytes,
        title: String(snapshot.title ?? path.basename(args.externalId)).slice(0, 500), formatVersion: definition.formatVersion,
        status: snapshot.records.some((record) => record.role !== 'metadata') ? 'partial' : 'unsupported', losses: snapshot.losses };
    },
    async parse(args, context) {
      const snapshot = await inspect(args, context);
      if (snapshot.revision !== args.revision) throw new Error('Source changed; preview again');
      let index = args.cursor === undefined ? 0 : Number(args.cursor);
      if (!Number.isSafeInteger(index) || index < 0 || index > snapshot.records.length) throw new Error('Invalid rule cursor');
      const records = []; let bytes = 0;
      while (index < snapshot.records.length) {
        context.signal.throwIfAborted(); const record = snapshot.records[index]; const size = Buffer.byteLength(JSON.stringify(record));
        if (records.length && (records.length >= 32 || bytes + size > 192 * 1024)) break;
        records.push(record); bytes += size; index++;
      }
      return { records, losses: [], cursor: index < snapshot.records.length ? String(index) : null,
        bytesRead: index === snapshot.records.length ? snapshot.totalBytes : Math.floor(snapshot.totalBytes * index / snapshot.records.length) };
    },
  };
}
