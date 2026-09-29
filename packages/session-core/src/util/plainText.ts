/**
 * One readable sentence out of markdown an agent wrote (a receipt, a
 * summary), for a single-line row: headings, fences, list and quote marks,
 * emphasis and code backticks are dropped, links keep their text.
 */

const HEADING_LINE = /^\s{0,3}#{1,6}\s/;
const FENCE_LINE = /^\s{0,3}(?:`{3,}|~{3,})/;
const RULE_LINE = /^\s{0,3}(?:[-*_]\s*){3,}$/;
const TABLE_LINE = /^\s*\|/;

/** Strip inline markdown from one line of text. */
export function plainInline(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The first sentence of the first prose line: heading, fence, rule and table
 * lines are skipped, as is everything inside a fence.
 */
export function firstSentence(markdown: string): string {
  let fenced = false;
  for (const raw of markdown.split('\n')) {
    if (FENCE_LINE.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || HEADING_LINE.test(raw) || RULE_LINE.test(raw) || TABLE_LINE.test(raw)) continue;
    const line = plainInline(raw);
    if (line === '') continue;
    const cut = line.search(/[。！？]|[.!?](?=\s|$)/);
    return cut === -1 ? line : line.slice(0, cut + 1);
  }
  return '';
}
