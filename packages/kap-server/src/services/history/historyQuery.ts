import { normalizeLiteral, tokenize } from '@kiki/minidb';

export type HistoryMode = 'auto' | 'all' | 'any' | 'literal' | 'terms';

export interface HistoryClause {
  readonly text: string;
  readonly weak: boolean;
}

export interface HistoryQuery {
  readonly mode: HistoryMode;
  readonly query: string;
  readonly normalized: string;
  readonly clauses: readonly HistoryClause[];
  readonly terms: readonly string[];
}

export interface HistoryMatch {
  readonly matched: readonly string[];
  readonly score: number;
  readonly start: number;
  readonly end: number;
}

const MAX_CLAUSES = 32;

export function planHistoryQuery(query: string, mode: HistoryMode = 'auto'): HistoryQuery {
  if (!query.trim() || query.length > 1024) throw new Error('query must contain 1–1024 non-whitespace characters');
  const normalized = normalizeLiteral(query);
  const clauses: HistoryClause[] = [];
  if (mode === 'literal') clauses.push({ text: normalized, weak: false });
  else if (mode !== 'terms') {
    const pattern = /"([^"]+)"|([^\s"]+)/gu;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(query)) !== null) {
      const text = normalizeLiteral((match[1] ?? match[2] ?? '').trim());
      if (!text) continue;
      clauses.push({ text, weak: /^[a-z0-9]$/u.test(text) });
      if (clauses.length > MAX_CLAUSES) throw new Error('query has too many clauses; use fewer words or mode=literal');
    }
    if (query.includes('"') && (query.match(/"/gu)?.length ?? 0) % 2 !== 0) {
      throw new Error('query has an unmatched quote; close the quote or use mode=literal');
    }
  }
  const terms = mode === 'terms' ? [...new Set(tokenize(query))] : [];
  if (mode === 'terms' && terms.length > MAX_CLAUSES) {
    throw new Error('query has too many terms; use fewer words or mode=literal');
  }
  return { query, normalized, mode, clauses, terms };
}

function clausePosition(text: string, clause: string, literal: boolean): number {
  let offset = 0;
  while (offset <= text.length) {
    const at = text.indexOf(clause, offset);
    if (at < 0) return -1;
    if (literal || !/^[a-z0-9_]+$/u.test(clause) ||
        ((at === 0 || !/[a-z0-9_]/u.test(text[at - 1]!)) &&
          (at + clause.length === text.length || !/[a-z0-9_]/u.test(text[at + clause.length]!)))) return at;
    offset = at + 1;
  }
  return -1;
}

function originalRange(text: string, start: number, end: number): [number, number] {
  const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text);
  let normalizedOffset = 0;
  let originalStart = 0;
  let originalEnd = text.length;
  for (const segment of segments) {
    const next = normalizedOffset + normalizeLiteral(segment.segment).length;
    if (normalizedOffset <= start && start < next) originalStart = segment.index;
    if (normalizedOffset < end && end <= next) { originalEnd = segment.index + segment.segment.length; break; }
    normalizedOffset = next;
  }
  return [originalStart, originalEnd];
}

export function matchHistoryText(text: string, plan: HistoryQuery): HistoryMatch | undefined {
  if (plan.mode === 'terms') {
    const tokens = new Set(tokenize(text));
    if (!plan.terms.length || !plan.terms.every((term) => tokens.has(term))) return undefined;
    return { matched: plan.terms, score: plan.terms.length, start: 0, end: 0 };
  }
  const normalized = normalizeLiteral(text);
  const positions = plan.clauses.map((clause) => clausePosition(normalized, clause.text, plan.mode === 'literal'));
  const present = plan.clauses.filter((_clause, i) => positions[i]! >= 0);
  if (plan.mode === 'all' && present.length !== plan.clauses.length) return undefined;
  if (plan.mode === 'literal' && positions[0]! < 0) return undefined;
  if (plan.mode === 'any' && present.length === 0) return undefined;
  if (plan.mode === 'auto' && !present.some((clause) => !clause.weak) &&
      (plan.clauses.some((clause) => !clause.weak) || present.length === 0)) return undefined;
  if (present.length === 0) return undefined;
  const focus = positions.findIndex((position, i) => position! >= 0 && !plan.clauses[i]!.weak);
  const focusIndex = focus >= 0 ? focus : positions.findIndex((position) => position! >= 0);
  const clause = plan.clauses[focusIndex]!;
  const [start, end] = originalRange(text, positions[focusIndex]!, positions[focusIndex]! + clause.text.length);
  const strong = present.filter((item) => !item.weak).length;
  return { matched: present.map((item) => item.text), score: strong * 10 + present.length +
    (normalized.includes(plan.normalized) ? 20 : 0), start, end };
}
