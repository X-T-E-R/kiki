type SettleMetricRow = {
  readonly totalTokens: number | null;
  readonly totalCostUsd: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly usagePartial?: boolean;
  readonly usageComplete?: boolean;
  readonly usageSource?: 'live' | 'persisted';
};

type UsageSlice = {
  readonly inputOther?: number;
  readonly output?: number;
  readonly inputCacheRead?: number;
  readonly inputCacheCreation?: number;
};

type UsageRevision = {
  readonly total?: UsageSlice;
  readonly currentTurn?: UsageSlice;
};

export type PanelMetricsSource = {
  readonly cursorSeq?: number;
  readonly cursorEpoch?: string;
  readonly transcriptResetVersion?: number;
  readonly usageSourceRevision?: string;
  readonly usage?: UsageRevision;
  readonly rosterUsage?: UsageRevision;
};

/** A missing or interrupted count still needs a settle read. */
export function isUnsettledPanelMetrics(row: SettleMetricRow | undefined): boolean {
  if (row === undefined) return true;
  if (row.usageComplete !== undefined) return !row.usageComplete;
  if (row.usagePartial !== true) return false;
  return [row.totalTokens, row.totalCostUsd, row.inputTokens, row.outputTokens]
    .every((value) => value === null || value === undefined);
}

/** A measured row. A cold placeholder and an unreported unknown are not one. */
export function isCompletePanelMetrics(row: SettleMetricRow | undefined): boolean {
  if (row === undefined) return false;
  if (row.usageComplete !== undefined) return row.usageComplete;
  if (row.usagePartial === true) return false;
  if (row.usageSource === 'live' || row.usageSource === 'persisted') return true;
  return [row.totalTokens, row.totalCostUsd, row.inputTokens, row.outputTokens]
    .some((value) => value !== null && value !== undefined);
}

function hasMeasuredUsage(row: SettleMetricRow | undefined): boolean {
  return row !== undefined && [row.totalTokens, row.totalCostUsd, row.inputTokens, row.outputTokens]
    .some((value) => value !== null && value !== undefined);
}

/** Successful interrupted reads resume without retrying transport errors. */
export function panelMetricsContinuationDelay(
  metrics: Readonly<Record<string, SettleMetricRow>> | undefined,
  ids: readonly string[],
  successes: number,
): number | false {
  if (!ids.some((id) => metrics?.[id]?.usageComplete === false)) return false;
  return Math.min(15_000, 1_000 * 2 ** Math.min(4, Math.max(0, successes - 1)));
}

function packUsage(usage: UsageRevision | undefined): string {
  if (usage === undefined) return '';
  const pack = (slice: UsageSlice | undefined) => slice === undefined
    ? ''
    : [slice.inputOther ?? 0, slice.output ?? 0, slice.inputCacheRead ?? 0, slice.inputCacheCreation ?? 0].join(',');
  return pack(usage.total);
}

/**
 * Stable for a dead agent and for an unchanged transcript. Appending usage,
 * rewriting the transcript, or changing the roster total moves it.
 */
export function panelMetricsSourceRevision(source: PanelMetricsSource | undefined): string {
  if (source === undefined) return '';
  const reset = `${source.transcriptResetVersion ?? ''}:${source.cursorEpoch ?? ''}`;
  const usage = packUsage(source.usage);
  const roster = packUsage(source.rosterUsage);
  const hasCursor = source.cursorSeq !== undefined || source.cursorEpoch !== undefined || source.transcriptResetVersion !== undefined;
  if (!hasCursor && usage === '' && roster === '' && source.usageSourceRevision === undefined) return '';
  return `${reset}:${usage}:${roster}:${source.usageSourceRevision ?? ''}`;
}

/**
 * Keep a measured prefix over a cold placeholder. When both rows are measured
 * or complete, the newer stamp wins; without stamps the header is the later read.
 */
export function mergePanelMetrics<T extends SettleMetricRow>(
  header: Readonly<Record<string, T>>,
  settled: Readonly<Record<string, T>> | undefined,
  freshness?: { readonly headerStamp: number; readonly settledStamp: Readonly<Record<string, number>> },
): Readonly<Record<string, T>> {
  if (settled === undefined) return header;
  const merged: Record<string, T> = {};
  for (const id of new Set([...Object.keys(header), ...Object.keys(settled)])) {
    const headerRow = header[id];
    const settledRow = settled[id];
    const headerMeasured = isCompletePanelMetrics(headerRow) || hasMeasuredUsage(headerRow);
    const settledMeasured = isCompletePanelMetrics(settledRow) || hasMeasuredUsage(settledRow);
    const headerNewer = freshness === undefined || freshness.headerStamp >= (freshness.settledStamp[id] ?? -1);
    if (headerMeasured && (!settledMeasured || headerNewer)) merged[id] = headerRow as T;
    else if (settledMeasured) merged[id] = settledRow as T;
    else if (headerRow !== undefined && !isUnsettledPanelMetrics(headerRow)) merged[id] = headerRow;
    else if (settledRow !== undefined && !isUnsettledPanelMetrics(settledRow)) merged[id] = settledRow;
    else if (headerRow !== undefined) merged[id] = headerRow;
    else if (settledRow !== undefined) merged[id] = settledRow;
  }
  return merged;
}

export function panelMetricsSettleKey(
  sessionId: string,
  agentId: string,
  agentIds: readonly string[],
  sourceRevision = '',
  serverId = '',
): readonly [string, string, string, readonly string[], string, string] {
  return ['agentPanelMetrics', sessionId, agentId, [...agentIds].sort(), sourceRevision, serverId];
}

export function panelMetricsCapabilitiesKey<T extends { session_id?: string; agent_id?: string }>(
  query: T,
  spaceKey = 'main',
  scopeId = 'local',
  serverId = '',
): readonly [string, T, string, string, string] {
  return ['agentCapabilities', query, spaceKey, scopeId, serverId];
}

