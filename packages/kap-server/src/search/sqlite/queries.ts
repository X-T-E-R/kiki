import type { NormalizedQuery, SearchBudgets } from '../match';
import { SqliteSearchIndex, type SqliteSearchResult } from './index';
import { beforeDeadline, DEFAULT_SEARCH_BUDGETS, queryBudget } from './queryBudget';

const deadlineResult = (): SqliteSearchResult => ({ rows: [], hasMore: false, incomplete: 'deadline' });

export class SqliteSearchQueries {
  private readonly recent = new Map<string, { expires: number; version: number; result: Promise<SqliteSearchResult> }>();

  constructor(private readonly reader: SqliteSearchIndex, private readonly cacheMs = 500) {}

  async search(query: NormalizedQuery, pageToken?: string, budgets: SearchBudgets = DEFAULT_SEARCH_BUDGETS,
    deadlineAt = Date.now() + budgets.queryDeadlineMs): Promise<SqliteSearchResult> {
    const budget = queryBudget(budgets, deadlineAt);
    if (Date.now() >= deadlineAt) return deadlineResult();
    const key = this.cacheMs ? JSON.stringify([query, pageToken, budgets]) : '';
    const version = this.cacheMs
      ? (this.reader.db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version : 0;
    const cached = this.cacheMs ? this.recent.get(key) : undefined;
    if (cached && cached.expires >= Date.now() && cached.version === version) {
      const value = await beforeDeadline(cached.result, deadlineAt);
      if (value === undefined) return deadlineResult();
      const current = await this.reader.sourcesCurrent(value.rows, budget);
      if (current === true) return value;
      if (this.recent.get(key) === cached) this.recent.delete(key);
      if (current === undefined) return deadlineResult();
      return this.reader.search(query, pageToken, budgets, budget);
    }
    if (this.cacheMs && this.recent.size >= 16) this.recent.delete(this.recent.keys().next().value!);
    const result = this.reader.search(query, pageToken, budgets, budget);
    if (this.cacheMs) {
      const entry = { expires: Date.now() + this.cacheMs, version, result };
      this.recent.set(key, entry);
      void result.catch(() => { if (this.recent.get(key) === entry) this.recent.delete(key); });
    }
    return result;
  }
}
