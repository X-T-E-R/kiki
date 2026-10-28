import { normalizeLiteral, tokenize } from '@kiki/lexical';
import type { MemoryEntry, MemoryType } from './memoryStore';
import type { MemoryScope } from './memoryScopes';

export interface MemoryScoreDetails {
  readonly lexical: number;
  readonly semantic: number;
  readonly exactIdentifier: boolean;
}
export type MemoryRecallEntry = MemoryEntry & { readonly scope: MemoryScope };
export type MemoryRecallResult = MemoryRecallEntry & { readonly score: number; readonly score_details: MemoryScoreDetails };
export interface MemorySemanticCandidate {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly revision: string;
  readonly score: number;
}
export interface MemoryRecallOptions {
  readonly semantic?: readonly MemorySemanticCandidate[];
  readonly semanticWeight?: number;
  readonly diversity?: number;
}
function key(entry: Pick<MemoryRecallEntry, 'id' | 'scope'>): string {
  return JSON.stringify([entry.scope.kind, 'workspaceId' in entry.scope ? entry.scope.workspaceId : null, 'personaId' in entry.scope ? entry.scope.personaId : null, entry.id]);
}
const stopWords = new Set(['a', 'an', 'and', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'with']);
function terms(text: string): string[] { return tokenize(normalizeLiteral(text)).filter((term) => !stopWords.has(term)); }
function frequencies(values: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}
function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let overlap = 0;
  for (const term of a) if (b.has(term)) overlap++;
  const union = a.size + b.size - overlap;
  return union === 0 ? 0 : overlap / union;
}
function diversify(results: readonly MemoryRecallResult[], lambda: number): MemoryRecallResult[] {
  if (lambda >= 1 || results.length < 2) return [...results];
  const bounded = Math.max(0, Math.min(1, lambda));
  const tokens = new Map(results.map((entry) => [entry, new Set(terms(`${entry.title}\n${entry.body}`))]));
  const minimum = Math.min(...results.map((entry) => entry.score));
  const range = Math.max(...results.map((entry) => entry.score)) - minimum;
  const remaining = new Set(results);
  const similarity = new Map<MemoryRecallResult, number>();
  const selected: MemoryRecallResult[] = [];
  while (remaining.size > 0) {
    let best: MemoryRecallResult | undefined;
    let bestScore = -Infinity;
    for (const entry of remaining) {
      const relevance = range === 0 ? 1 : (entry.score - minimum) / range;
      const score = bounded * relevance - (1 - bounded) * (similarity.get(entry) ?? 0);
      if (score > bestScore || score === bestScore && entry.score > (best?.score ?? -Infinity)) { best = entry; bestScore = score; }
    }
    if (best === undefined) break;
    selected.push(best);
    remaining.delete(best);
    for (const entry of remaining) similarity.set(entry, Math.max(similarity.get(entry) ?? 0, jaccard(tokens.get(entry)!, tokens.get(best)!)));
  }
  return selected;
}
export function rankMemoryRecall(entries: readonly MemoryRecallEntry[], query: string, type?: MemoryType, options: MemoryRecallOptions = {}): MemoryRecallResult[] {
  const normalized = normalizeLiteral(query).trim();
  const queryTerms = [...new Set(terms(normalized))];
  const identifiers = new Set([...normalized.matchAll(/\[(m_[a-z0-9_]+)\]/g)].map((match) => match[1]));
  const documents = entries.filter((entry) => type === undefined || entry.type === type).map((entry) => {
    const tokens = terms(`${entry.title}\n${entry.body}`);
    return { entry, title: normalizeLiteral(entry.title), body: normalizeLiteral(entry.body), titleTerms: new Set(terms(entry.title)), frequencies: frequencies(tokens), length: tokens.length };
  });
  const averageLength = Math.max(1, documents.reduce((sum, document) => sum + document.length, 0) / Math.max(1, documents.length));
  const documentFrequency = new Map(queryTerms.map((term) => [term, documents.filter((document) => document.frequencies.has(term)).length]));
  const semantic = new Map((options.semantic ?? []).filter((entry) => Number.isFinite(entry.score) && entry.score >= 0).map((entry) => [key(entry), entry]));
  const semanticWeight = options.semantic === undefined ? 0 : Math.max(0, Math.min(1, options.semanticWeight ?? 0.7));
  const results: MemoryRecallResult[] = [];
  for (const document of documents) {
    const { entry } = document;
    const semanticCandidate = semantic.get(key(entry));
    const semanticScore = semanticCandidate?.revision === entry.revision ? Math.min(1, semanticCandidate.score) : 0;
    let bm25 = 0;
    for (const term of queryTerms) {
      const frequency = document.frequencies.get(term) ?? 0;
      if (frequency === 0) continue;
      const count = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (documents.length - count + 0.5) / (count + 0.5));
      const titleBoost = document.titleTerms.has(term) ? 1.5 : 1;
      bm25 += idf * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * document.length / averageLength)) * titleBoost;
    }
    const literalMatch = normalized.length > 0 && (document.title.includes(normalized) || document.body.includes(normalized));
    const lexical = bm25 / (1 + bm25) + (literalMatch ? 0.1 : 0);
    const exactIdentifier = normalized.length > 0 && (normalizeLiteral(entry.id) === normalized || identifiers.has(normalizeLiteral(entry.id)) || entry.basis?.refs?.some((ref) => normalizeLiteral(ref) === normalized) === true);
    if (!exactIdentifier && lexical === 0 && semanticScore === 0) continue;
    results.push({ ...entry, score: exactIdentifier ? 1 : Math.min(0.999, semanticWeight * semanticScore + (1 - semanticWeight) * Math.min(1, lexical)), score_details: { lexical: Math.min(1, lexical), semantic: semanticScore, exactIdentifier } });
  }
  const compare = (a: MemoryRecallResult, b: MemoryRecallResult): number => b.score - a.score || a.title.localeCompare(b.title) || a.id.localeCompare(b.id) || JSON.stringify(a.scope).localeCompare(JSON.stringify(b.scope));
  const exact = results.filter((entry) => entry.score_details.exactIdentifier).toSorted(compare);
  const other = results.filter((entry) => !entry.score_details.exactIdentifier).toSorted(compare);
  return [...diversify(exact, options.diversity ?? 1), ...diversify(other, options.diversity ?? 1)];
}
export function selectMemoryRecall(results: readonly MemoryRecallResult[], maximum: number, minimumScore: number): MemoryRecallResult[] {
  const strict = results.filter((entry) => entry.score_details.exactIdentifier || entry.score >= minimumScore);
  const selected = strict.slice(0, maximum);
  if (selected.length === maximum) return selected;
  if (strict.length === 0) return results.filter((entry) => entry.score_details.lexical > 0).slice(0, maximum);
  const seen = new Set(selected.map(key));
  for (const entry of results) {
    if (selected.length >= maximum) break;
    if (entry.score_details.semantic === 0 && entry.score_details.lexical > 0 && !seen.has(key(entry))) { selected.push(entry); seen.add(key(entry)); }
  }
  return selected;
}
