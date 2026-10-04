import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';

import { Marked } from '@kiki/pi-tui';

const markdown = new Marked();
const onlineDocsRoot = 'https://x-t-e-r.github.io/kiki/';
const htmlTag = /<!--[\s\S]*?-->|<\/?[a-z][a-z\d-]*\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;

function plainAlt(text) {
  return text.trim().replace(/\s+/g, ' ').replace(/([\\`*{}\[\]()#+.!_|<>])/g, '\\$1');
}

function stripHtmlImages(raw, state) {
  return raw.replace(htmlTag, (tag) => {
    if (tag.startsWith('<!--')) return tag;
    const name = /^<\/?([a-z][a-z\d-]*)/i.exec(tag)?.[1]?.toLowerCase();
    const closing = tag.startsWith('</');
    if (name === 'picture') {
      state.pictureDepth += closing ? -1 : 1;
      state.changed = true;
      return '';
    }
    if (name === 'source' && state.pictureDepth > 0) {
      state.changed = true;
      return '';
    }
    if (name !== 'img') return tag;
    state.changed = true;
    const alt = /\s+alt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    return plainAlt(alt?.[1] ?? alt?.[2] ?? alt?.[3] ?? '');
  });
}

function imageAndCodeTokens(token) {
  if (['image', 'html', 'code', 'codespan'].includes(token.type)) return [token];
  const children = token.type === 'list' ? token.items
    : token.type === 'table' ? [...token.header, ...token.rows.flat()]
      : token.tokens ?? [];
  return children.flatMap(imageAndCodeTokens);
}

function locateRaw(raw, text, cursor) {
  const exact = text.indexOf(raw, cursor);
  if (exact !== -1) return { start: exact, end: exact + raw.length };
  // Lists/quotes strip margins; table cells unescape their pipe separators.
  const pattern = raw.split('\n').map((line) => line.split('|')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\\\?\\|'))
    .join('\n[ \\t>]*');
  const match = new RegExp(pattern, 'g');
  match.lastIndex = cursor;
  const found = match.exec(text);
  if (found === null) throw new Error('Cannot locate documentation token in its source');
  return { start: found.index, end: found.index + found[0].length };
}

/** Project only rendered images to text, retaining the original Markdown elsewhere. */
export function localizeKikiDoc(source, relativePath) {
  const normalized = source.replace(/\r\n?/g, '\n');
  const offsets = [];
  for (let index = 0; index < source.length; index += 1) {
    offsets.push(index);
    if (source[index] === '\r' && source[index + 1] === '\n') index += 1;
  }
  offsets.push(source.length);
  const edits = [];
  const state = { changed: false, pictureDepth: 0 };
  let blockCursor = 0;
  for (const block of markdown.lexer(normalized)) {
    const blockRange = locateRaw(block.raw, normalized, blockCursor);
    blockCursor = blockRange.end;
    let cursor = 0;
    for (const token of imageAndCodeTokens(block)) {
      const range = locateRaw(token.raw, block.raw, cursor);
      cursor = range.end;
      const start = offsets[blockRange.start + range.start];
      const end = offsets[blockRange.start + range.end];
      const raw = source.slice(start, end);
      let replacement;
      if (token.type === 'image') {
        state.changed = true;
        replacement = plainAlt(token.text);
      } else if (token.type === 'html') {
        replacement = stripHtmlImages(raw, state);
      } else continue;
      if (replacement !== raw) edits.push({ start, end, replacement });
    }
  }
  if (!state.changed) return source;
  let result = source;
  for (const edit of edits.toReversed()) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  }
  const page = relativePath.replaceAll('\\', '/').replace(/(?:^|\/)index\.md$/, '/').replace(/\.md$/, '.html');
  const label = relativePath.startsWith('zh/') ? '在线图文版' : 'Online version with images';
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  return `${result.trimEnd()}${newline}${newline}[${label}](${onlineDocsRoot}${page})${newline}`;
}

/** Copy the bilingual Markdown projection, never media or site build assets. */
export async function copyKikiDocs({ sourceDir, targetDir }) {
  const files = [];
  async function visit(dir, prefix) {
    const entries = (await readdir(dir, { withFileTypes: true }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relativePath = `${prefix}/${entry.name}`;
      const source = join(dir, entry.name);
      if (entry.isDirectory()) await visit(source, relativePath);
      else if (entry.isFile() && extname(entry.name) === '.md') {
        const path = join(targetDir, relativePath);
        const bytes = Buffer.from(localizeKikiDoc(await readFile(source, 'utf8'), relativePath));
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes);
        files.push({ path, relativePath, bytes });
      }
    }
  }
  for (const locale of ['en', 'zh']) await visit(join(sourceDir, locale), locale);
  return files.toSorted((a, b) => a.relativePath.localeCompare(b.relativePath));
}
