import type { MemoryAdvisorConfig, MemoryAdvisorStatus } from '@kiki/protocol';
import { estimateTokens } from '#/kosong/contract/tokens';
import type { RequestAttribution } from '#/kosong/model/requestAdmission';
import type { Model } from '#/kosong/model/catalog';
import type { TokenUsage } from '#/kosong/contract/usage';
import { memoryApplicability, type IMemoryStore, type MemoryStoreSnapshot } from './memoryStore';
import { memoryAdviceKey, type MemoryAdvice, type MemoryAdviceItem } from './memoryAdvisorTypes';
import type { MemoryRecallEntry } from './memoryRecall';
import {
  selectorInputTokens,
  type IMemorySelector,
  type MemorySelectorStats,
  type MemorySelectorUnit,
} from './memorySelector';

export function memorySelectorBatches(
  units: readonly MemorySelectorUnit[],
  query: string,
  maximum: number,
  tokens: number,
  estimate = (items: readonly MemorySelectorUnit[]) =>
    estimateTokens(JSON.stringify({ query, units: items })) + 1_000,
): { batches: MemorySelectorUnit[][]; omitted: number } {
  const batches: MemorySelectorUnit[][] = [];
  let current: MemorySelectorUnit[] = [];
  let omitted = 0;
  const fits = (items: readonly MemorySelectorUnit[]) => estimate(items) <= tokens;
  for (const unit of units) {
    if (!fits([unit])) {
      omitted++;
      continue;
    }
    if (current.length === maximum || !fits([...current, unit])) {
      batches.push(current);
      current = [];
    }
    current.push(unit);
  }
  if (current.length > 0) batches.push(current);
  return { batches, omitted };
}
export async function runMemoryAdvice(input: {
  readonly config: MemoryAdvisorConfig;
  readonly view: MemoryStoreSnapshot;
  readonly query: string;
  readonly fingerprint: string;
  readonly selector: IMemorySelector;
  readonly store: IMemoryStore;
  readonly signal: AbortSignal;
  readonly attribution: RequestAttribution;
  readonly stats: MemorySelectorStats;
  readonly status: MemoryAdvisorStatus;
  readonly record: (model: Pick<Model, 'id' | 'name' | 'providerName'>, usage: TokenUsage, known: boolean) => void;
}): Promise<MemoryAdvice> {
  const { config, view, query, signal, stats } = input;
  const entries = view.entries.filter(
    (entry) => entry.status === 'active' && memoryApplicability(entry) !== 'expired',
  );
  const byHandle = new Map<string, MemoryRecallEntry>(
    entries.map((entry, index) => [`c${index}`, entry]),
  );
  const directory = [...byHandle].map(([handle, entry]) => ({
    handle,
    text: JSON.stringify({
      type: entry.type,
      title: entry.title,
      excerpt: entry.body.slice(0, config.candidate_chars),
      applicability: memoryApplicability(entry),
      validity: entry.validity,
    }),
  }));
  const batchesFor = (
    stage: 'discover' | 'judge',
    units: readonly MemorySelectorUnit[],
    maximum: number,
  ) =>
    memorySelectorBatches(
      units,
      query,
      maximum,
      config.judge_input_tokens,
      (items) => selectorInputTokens(config, stage, query, items, input.status) + 128,
    );
  const pages = batchesFor('discover', directory, config.catalog_page_items);
  const examined = pages.batches.slice(0, config.max_catalog_pages);
  let partial = pages.omitted > 0 || examined.length < pages.batches.length;
  const seen: string[] = [];
  const candidates: Array<{ handle: string; score: number }> = [];
  const call = (stage: 'discover' | 'judge', units: readonly MemorySelectorUnit[]) =>
    input.selector.call({
      config,
      stage,
      query,
      units,
      signal,
      attribution: input.attribution,
      stats,
      record: input.record,
    });
  for (const page of examined) {
    signal.throwIfAborted();
    const answers = await call('discover', page);
    seen.push(...page.map((unit) => memoryAdviceKey(byHandle.get(unit.handle)!)));
    for (const answer of answers)
      if (answer.use === 'read' || answer.score !== undefined)
        candidates.push({ handle: answer.handle, score: answer.score ?? 0 });
  }
  const selected = candidates.toSorted((a, b) => b.score - a.score).slice(0, config.max_full_units);
  const full: MemorySelectorUnit[] = [];
  const currentEntries = new Map<string, MemoryRecallEntry>();
  for (const candidate of selected) {
    signal.throwIfAborted();
    const discovered = byHandle.get(candidate.handle)!;
    const entry = await input.store.get(discovered.scope, discovered.id);
    if (
      entry === undefined ||
      entry.revision !== discovered.revision ||
      entry.status !== 'active' ||
      memoryApplicability(entry) === 'expired'
    ) {
      partial = true;
      continue;
    }
    currentEntries.set(candidate.handle, { ...entry, scope: discovered.scope });
    full.push({
      handle: candidate.handle,
      text: JSON.stringify({
        type: entry.type,
        title: entry.title,
        body: entry.body,
        basis: entry.basis,
        validity: entry.validity,
        applicability: memoryApplicability(entry),
      }),
    });
  }
  const batches = batchesFor('judge', full, config.max_full_units);
  if (batches.omitted > 0) partial = true;
  const items: MemoryAdviceItem[] = [];
  for (const batch of batches.batches) {
    signal.throwIfAborted();
    for (const answer of await call('judge', batch)) {
      const entry = currentEntries.get(answer.handle)!;
      items.push({
        key: memoryAdviceKey(entry),
        revision: entry.revision,
        use:
          answer.score === undefined ? (answer.use as 'apply' | 'history' | 'skip') : 'recommended',
        score: answer.score,
      });
    }
  }
  signal.throwIfAborted();
  const count = items.filter((item) => item.use !== 'skip').length;
  return {
    fingerprint: input.fingerprint,
    generation: view.generation,
    mode: config.mode === 'select' ? 'select' : 'rank',
    items,
    seen,
    status: {
      ...input.status,
      state: count === 0 ? 'none' : 'selected',
      reason: undefined,
      enumeration: partial ? 'partial' : 'complete',
      recommended_count: count,
      requests: stats.requests,
      retries: stats.retries,
      unjudged_count: entries.length - items.length,
    },
  };
}
