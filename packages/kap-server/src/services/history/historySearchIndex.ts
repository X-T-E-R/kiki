import { normalizeLiteral } from '@kiki/lexical';
import { encodeTerm } from '../../search/sqlite/terms';
import type { HistoryQuery } from './historyQuery';

export interface HistorySearchCandidate {
  readonly index: 'nav_terms' | 'nav_trigrams';
  readonly match: string;
}

export function historySearchCandidate(plan: HistoryQuery): HistorySearchCandidate | undefined {
  if (plan.mode === 'terms') return plan.terms.length === 0 ? undefined : {
    index: 'nav_terms', match: plan.terms.map(term => `"${encodeTerm(term)}"`).join(' AND '),
  };
  const strong = plan.clauses.filter(clause => !clause.weak);
  const clauses = plan.mode === 'auto' && strong.length > 0 ? strong : plan.clauses;
  const all = plan.mode === 'all' || plan.mode === 'literal';
  const queries = clauses.map(clause => {
    const chars = Array.from(normalizeLiteral(clause.text));
    if (chars.length < 3 || clause.text.includes('\0')) return undefined;
    const grams = new Set<string>();
    for (let index = 0; index + 2 < chars.length; index++) grams.add(chars.slice(index, index + 3).join(''));
    return `(${[...grams].map(gram => `"${gram.replaceAll('"', '""')}"`).join(' AND ')})`;
  });
  if (!all && queries.includes(undefined)) return undefined;
  const indexed = queries.filter(query => query !== undefined);
  return indexed.length === 0 ? undefined : { index: 'nav_trigrams', match: indexed.join(all ? ' AND ' : ' OR ') };
}
