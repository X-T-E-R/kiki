import type { MatchBudget, SearchBudgets } from '../match';

export const DEFAULT_SEARCH_BUDGETS: SearchBudgets = {
  literalCandidateCap: 10_000, maxTextHits: 100_000, postingsVisitBudget: 250_000,
  queryDeadlineMs: 500, queryTextBudgetChars: 16_000_000,
};

export interface SqliteQueryBudget extends MatchBudget {
  candidatesLeft: number;
}

export function queryBudget(budgets: SearchBudgets, deadlineAt = Date.now() + budgets.queryDeadlineMs): SqliteQueryBudget {
  return { deadlineAt, textCharsLeft: budgets.queryTextBudgetChars,
    candidatesLeft: Math.max(budgets.literalCandidateCap, budgets.maxTextHits) };
}

export async function beforeDeadline<T>(work: Promise<T>, deadlineAt: number): Promise<T | undefined> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) { void work.catch(() => {}); return undefined; }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), remaining);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
