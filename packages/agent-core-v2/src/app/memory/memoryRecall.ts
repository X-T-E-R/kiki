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
const defaultCollator = new Intl.Collator();
const scopeKeyCache = new WeakMap<MemoryScope, string>();
function cachedScopeKey(scope: MemoryScope): string {
  let cached = scopeKeyCache.get(scope);
  if (cached === undefined) {
    cached = JSON.stringify(scope);
    scopeKeyCache.set(scope, cached);
  }
  return cached;
}
function key(entry: Pick<MemoryRecallEntry, 'id' | 'scope'>): string {
  return JSON.stringify([entry.scope.kind, 'workspaceId' in entry.scope ? entry.scope.workspaceId : null, 'personaId' in entry.scope ? entry.scope.personaId : null, entry.id]);
}
const stopWords = new Set(['a', 'an', 'and', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'with']);
function terms(text: string): string[] { return tokenize(normalizeLiteral(text)).filter((term) => !stopWords.has(term)); }
function termsFromNormalized(normalized: string): string[] { return tokenize(normalized).filter((term) => !stopWords.has(term)); }
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

interface IndexedRecallDoc {
  readonly entry: MemoryRecallEntry;
  readonly entryKey: string;
  readonly scopeKey: string;
  readonly titleNorm: string;
  readonly bodyNorm: string;
  readonly idNorm: string;
  readonly refNorms?: readonly string[];
  readonly length: number;
}

interface TermPosting {
  readonly docIndex: number;
  readonly tf: number;
  readonly inTitle: boolean;
}

export interface MemoryRecallIndex {
  readonly docCount: number;
  readonly averageLength: number;
  readonly docs: readonly IndexedRecallDoc[];
  readonly postings: ReadonlyMap<string, readonly TermPosting[]>;
  readonly exactIds: ReadonlyMap<string, readonly number[]>;
}

export function buildMemoryRecallIndex(entries: readonly MemoryRecallEntry[]): MemoryRecallIndex {
  const docs: IndexedRecallDoc[] = new Array(entries.length);
  const postings = new Map<string, TermPosting[]>();
  const exactIds = new Map<string, number[]>();
  const addExactId = (value: string, docIndex: number): void => {
    const list = exactIds.get(value);
    if (list === undefined) exactIds.set(value, [docIndex]);
    else if (list.at(-1) !== docIndex) list.push(docIndex);
  };
  let totalLength = 0;
  for (let docIndex = 0; docIndex < entries.length; docIndex++) {
    const entry = entries[docIndex]!;
    const titleNorm = normalizeLiteral(entry.title);
    const bodyNorm = normalizeLiteral(entry.body);
    const idNorm = normalizeLiteral(entry.id);
    addExactId(idNorm, docIndex);
    let refNorms: string[] | undefined;
    if (entry.basis?.refs !== undefined && entry.basis.refs.length > 0) {
      refNorms = entry.basis.refs.map((ref) => normalizeLiteral(ref));
      for (const ref of refNorms) addExactId(ref, docIndex);
    }
    const titleTokens = termsFromNormalized(titleNorm);
    const bodyTokens = termsFromNormalized(bodyNorm);
    const length = titleTokens.length + bodyTokens.length;
    totalLength += length;
    const tfMap = new Map<string, number>();
    const titleSet = new Set<string>();
    for (const token of titleTokens) {
      titleSet.add(token);
      tfMap.set(token, (tfMap.get(token) ?? 0) + 1);
    }
    for (const token of bodyTokens) {
      tfMap.set(token, (tfMap.get(token) ?? 0) + 1);
    }
    for (const [term, tf] of tfMap) {
      let list = postings.get(term);
      if (list === undefined) {
        list = [];
        postings.set(term, list);
      }
      list.push({ docIndex, tf, inTitle: titleSet.has(term) });
    }
    docs[docIndex] = {
      entry,
      entryKey: key(entry),
      scopeKey: cachedScopeKey(entry.scope),
      titleNorm,
      bodyNorm,
      idNorm,
      refNorms,
      length,
    };
  }
  return {
    docCount: entries.length,
    averageLength: Math.max(1, totalLength / Math.max(1, entries.length)),
    docs,
    postings,
    exactIds,
  };
}

export function rankMemoryRecallIndexed(
  index: MemoryRecallIndex,
  query: string,
  type?: MemoryType,
  options: MemoryRecallOptions = {},
): MemoryRecallResult[] {
  const normalized = normalizeLiteral(query).trim();
  const queryTerms = [...new Set(termsFromNormalized(normalized))];
  const identifiers = new Set([...normalized.matchAll(/\[(m_[a-z0-9_]+)\]/g)].map((match) => match[1]!));
  const semantic = new Map((options.semantic ?? []).filter((entry) => Number.isFinite(entry.score) && entry.score >= 0).map((entry) => [key(entry), entry]));
  const semanticWeight = options.semantic === undefined ? 0 : Math.max(0, Math.min(1, options.semanticWeight ?? 0.7));
  let docCount = index.docCount;
  let averageLength = index.averageLength;
  if (type !== undefined) {
    let filteredCount = 0;
    let filteredLength = 0;
    for (const doc of index.docs) {
      if (doc.entry.type !== type) continue;
      filteredCount++;
      filteredLength += doc.length;
    }
    docCount = filteredCount;
    averageLength = Math.max(1, filteredLength / Math.max(1, filteredCount));
  }
  const bm25ByDoc = new Map<number, number>();
  for (const term of queryTerms) {
    const list = index.postings.get(term);
    if (list === undefined || list.length === 0) continue;
    let count = 0;
    if (type === undefined) {
      count = list.length;
    } else {
      for (const posting of list) {
        if (index.docs[posting.docIndex]!.entry.type === type) count++;
      }
    }
    if (count === 0) continue;
    const idf = Math.log(1 + (docCount - count + 0.5) / (count + 0.5));
    for (const posting of list) {
      const doc = index.docs[posting.docIndex]!;
      if (type !== undefined && doc.entry.type !== type) continue;
      const titleBoost = posting.inTitle ? 1.5 : 1;
      const contribution = idf * posting.tf * 2.2 / (posting.tf + 1.2 * (0.25 + 0.75 * doc.length / averageLength)) * titleBoost;
      bm25ByDoc.set(posting.docIndex, (bm25ByDoc.get(posting.docIndex) ?? 0) + contribution);
    }
  }
  const exactDocSet = new Set<number>();
  if (normalized.length > 0) {
    for (const docIndex of index.exactIds.get(normalized) ?? []) exactDocSet.add(docIndex);
    for (const id of identifiers) {
      for (const docIndex of index.exactIds.get(id) ?? []) {
        if (index.docs[docIndex]!.idNorm === id) exactDocSet.add(docIndex);
      }
    }
  }
  const candidates = new Set<number>([...bm25ByDoc.keys(), ...exactDocSet]);
  if (normalized.length > 0 || semantic.size > 0) {
    for (let docIndex = 0; docIndex < index.docs.length; docIndex++) {
      const doc = index.docs[docIndex]!;
      if (type !== undefined && doc.entry.type !== type) continue;
      if (candidates.has(docIndex)) continue;
      if (semantic.size > 0 && semantic.has(doc.entryKey)) {
        candidates.add(docIndex);
        continue;
      }
      if (normalized.length > 0 && (doc.titleNorm.includes(normalized) || doc.bodyNorm.includes(normalized))) {
        candidates.add(docIndex);
      }
    }
  }
  const scored: Array<{ readonly result: MemoryRecallResult; readonly scopeKey: string }> = [];
  for (const docIndex of candidates) {
    const doc = index.docs[docIndex]!;
    if (type !== undefined && doc.entry.type !== type) continue;
    const { entry } = doc;
    const semanticCandidate = semantic.get(doc.entryKey);
    const semanticScore = semanticCandidate?.revision === entry.revision ? Math.min(1, semanticCandidate.score) : 0;
    const bm25 = bm25ByDoc.get(docIndex) ?? 0;
    const literalMatch = normalized.length > 0 && (doc.titleNorm.includes(normalized) || doc.bodyNorm.includes(normalized));
    const lexical = bm25 / (1 + bm25) + (literalMatch ? 0.1 : 0);
    const exactIdentifier = exactDocSet.has(docIndex);
    if (!exactIdentifier && lexical === 0 && semanticScore === 0) continue;
    scored.push({
      scopeKey: doc.scopeKey,
      result: {
        ...entry,
        score: exactIdentifier ? 1 : Math.min(0.999, semanticWeight * semanticScore + (1 - semanticWeight) * Math.min(1, lexical)),
        score_details: { lexical: Math.min(1, lexical), semantic: semanticScore, exactIdentifier },
      },
    });
  }
  const compare = (a: typeof scored[number], b: typeof scored[number]): number =>
    b.result.score - a.result.score || defaultCollator.compare(a.result.title, b.result.title) || defaultCollator.compare(a.result.id, b.result.id) || defaultCollator.compare(a.scopeKey, b.scopeKey);
  const exact = scored.filter((item) => item.result.score_details.exactIdentifier).toSorted(compare).map((item) => item.result);
  const other = scored.filter((item) => !item.result.score_details.exactIdentifier).toSorted(compare).map((item) => item.result);
  return [...diversify(exact, options.diversity ?? 1), ...diversify(other, options.diversity ?? 1)];
}

export function rankMemoryRecall(entries: readonly MemoryRecallEntry[], query: string, type?: MemoryType, options: MemoryRecallOptions = {}): MemoryRecallResult[] {
  const normalized = normalizeLiteral(query).trim();
  const queryTerms = [...new Set(termsFromNormalized(normalized))];
  const queryTermIndex = new Map(queryTerms.map((term, index) => [term, index]));
  const identifiers = new Set([...normalized.matchAll(/\[(m_[a-z0-9_]+)\]/g)].map((match) => match[1]!));
  const semantic = new Map((options.semantic ?? []).filter((entry) => Number.isFinite(entry.score) && entry.score >= 0).map((entry) => [key(entry), entry]));
  const semanticWeight = options.semantic === undefined ? 0 : Math.max(0, Math.min(1, options.semanticWeight ?? 0.7));
  const docFreq = new Int32Array(queryTerms.length);
  let docCount = 0;
  let totalLength = 0;
  const candidates: Array<{
    readonly entry: MemoryRecallEntry;
    readonly length: number;
    readonly counts?: Int32Array;
    readonly inTitle?: Uint8Array;
    readonly literalMatch: boolean;
    readonly exactIdentifier: boolean;
    readonly semanticScore: number;
  }> = [];
  for (const entry of entries) {
    if (type !== undefined && entry.type !== type) continue;
    docCount++;
    const titleNorm = normalizeLiteral(entry.title);
    const bodyNorm = normalizeLiteral(entry.body);
    let length = 0;
    let counts: Int32Array | undefined;
    let inTitle: Uint8Array | undefined;
    let hasTermHit = false;
    const rawTitleTokens = tokenize(titleNorm);
    const rawBodyTokens = tokenize(bodyNorm);
    for (const token of rawTitleTokens) {
      if (stopWords.has(token)) continue;
      length++;
      const termIdx = queryTermIndex.get(token);
      if (termIdx === undefined) continue;
      if (counts === undefined) {
        counts = new Int32Array(queryTerms.length);
        inTitle = new Uint8Array(queryTerms.length);
      }
      if (counts[termIdx] === 0) docFreq[termIdx] = docFreq[termIdx]! + 1;
      counts[termIdx] = counts[termIdx]! + 1;
      inTitle![termIdx] = 1;
      hasTermHit = true;
    }
    for (const token of rawBodyTokens) {
      if (stopWords.has(token)) continue;
      length++;
      const termIdx = queryTermIndex.get(token);
      if (termIdx === undefined) continue;
      if (counts === undefined) {
        counts = new Int32Array(queryTerms.length);
        inTitle = new Uint8Array(queryTerms.length);
      }
      if (counts[termIdx] === 0) docFreq[termIdx] = docFreq[termIdx]! + 1;
      counts[termIdx] = counts[termIdx]! + 1;
      hasTermHit = true;
    }
    totalLength += length;
    const literalMatch = normalized.length > 0 && (titleNorm.includes(normalized) || bodyNorm.includes(normalized));
    const idNorm = normalized.length > 0 ? normalizeLiteral(entry.id) : '';
    const exactIdentifier = normalized.length > 0 && (
      idNorm === normalized ||
      identifiers.has(idNorm) ||
      entry.basis?.refs?.some((ref) => normalizeLiteral(ref) === normalized) === true
    );
    const semanticCandidate = semantic.size === 0 ? undefined : semantic.get(key(entry));
    const semanticScore = semanticCandidate?.revision === entry.revision ? Math.min(1, semanticCandidate.score) : 0;
    if (!exactIdentifier && !hasTermHit && !literalMatch && semanticScore === 0) continue;
    candidates.push({ entry, length, counts, inTitle, literalMatch, exactIdentifier, semanticScore });
  }
  const averageLength = Math.max(1, totalLength / Math.max(1, docCount));
  const idfByTerm = new Float64Array(queryTerms.length);
  for (let i = 0; i < queryTerms.length; i++) {
    const count = docFreq[i]!;
    idfByTerm[i] = Math.log(1 + (docCount - count + 0.5) / (count + 0.5));
  }
  const scored: Array<{ readonly result: MemoryRecallResult; readonly scopeKey: string }> = [];
  for (const candidate of candidates) {
    let bm25 = 0;
    if (candidate.counts !== undefined) {
      for (let i = 0; i < queryTerms.length; i++) {
        const frequency = candidate.counts[i]!;
        if (frequency === 0) continue;
        const titleBoost = candidate.inTitle![i] === 1 ? 1.5 : 1;
        bm25 += idfByTerm[i]! * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * candidate.length / averageLength)) * titleBoost;
      }
    }
    const lexical = bm25 / (1 + bm25) + (candidate.literalMatch ? 0.1 : 0);
    if (!candidate.exactIdentifier && lexical === 0 && candidate.semanticScore === 0) continue;
    scored.push({
      scopeKey: cachedScopeKey(candidate.entry.scope),
      result: {
        ...candidate.entry,
        score: candidate.exactIdentifier ? 1 : Math.min(0.999, semanticWeight * candidate.semanticScore + (1 - semanticWeight) * Math.min(1, lexical)),
        score_details: { lexical: Math.min(1, lexical), semantic: candidate.semanticScore, exactIdentifier: candidate.exactIdentifier },
      },
    });
  }
  const compare = (a: typeof scored[number], b: typeof scored[number]): number =>
    b.result.score - a.result.score || defaultCollator.compare(a.result.title, b.result.title) || defaultCollator.compare(a.result.id, b.result.id) || defaultCollator.compare(a.scopeKey, b.scopeKey);
  const exact = scored.filter((item) => item.result.score_details.exactIdentifier).toSorted(compare).map((item) => item.result);
  const other = scored.filter((item) => !item.result.score_details.exactIdentifier).toSorted(compare).map((item) => item.result);
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
