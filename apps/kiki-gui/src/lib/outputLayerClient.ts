import {
  OUTPUT_LAYER_DEFAULT_SETTINGS,
  type OutputLayerConfiguration,
  type OutputLayerHistoryPair,
  type OutputLayerPreset,
  type OutputLayerSettings,
  type OutputLayerStatus,
} from '@kiki/protocol';
import type { OutputLayerFacade } from '@kiki/klient/core/facade/output-layer';

export type { OutputLayerConfiguration, OutputLayerPreset, OutputLayerSettings, OutputLayerStatus };
export { OUTPUT_LAYER_DEFAULT_SETTINGS };

export interface OutputLayerSource {
  sessionId: string;
  sourceId: string;
  sourceRevision: string;
  text: string;
}

export interface OutputLayerResult extends OutputLayerSource {
  status: OutputLayerStatus;
  output: string;
  error?: string;
}

interface ReadingResult extends OutputLayerResult {
  identity: string;
  context: readonly Pick<OutputLayerHistoryPair, 'sourceId' | 'sourceRevision'>[];
}

interface HistoryCycle {
  id: string;
  pairs: OutputLayerHistoryPair[];
}

export interface OutputLayerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function identity(source: OutputLayerSource, preset: OutputLayerPreset, settings = OUTPUT_LAYER_DEFAULT_SETTINGS): string {
  return JSON.stringify([source.sessionId, source.sourceId, source.sourceRevision, source.text, preset, settings.historyTokens]);
}

/** Only Assistant-visible text belongs in source.text; the client never reads a transcript or submits prompts. */
export class OutputLayerClient {
  private readonly results = new Map<string, ReadingResult>();
  private readonly cycles = new Map<string, HistoryCycle>();
  private readonly pending = new Map<string, { source: OutputLayerSource; controller: AbortController; promise: Promise<OutputLayerResult> }>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly api: OutputLayerFacade, private readonly storage?: OutputLayerStorage) {
    const saved = storage?.getItem('kiki.output-layer.results.v1');
    if (saved) {
      try {
        for (const result of JSON.parse(saved) as ReadingResult[]) {
          if (result.status === 'completed') this.results.set(result.identity, result);
        }
      } catch {
        storage?.setItem('kiki.output-layer.results.v1', '[]');
      }
    }
  }

  configuration(options?: Parameters<OutputLayerFacade['configuration']>[0]): Promise<OutputLayerConfiguration> { return this.api.configuration(options); }
  configure(input: Pick<OutputLayerConfiguration, 'presets' | 'settings'>): Promise<OutputLayerConfiguration> { return this.api.configure(input); }

  get(source: OutputLayerSource, preset: OutputLayerPreset, settings = OUTPUT_LAYER_DEFAULT_SETTINGS): OutputLayerResult | undefined {
    return this.results.get(identity(source, preset, settings));
  }

  process(source: OutputLayerSource, preset: OutputLayerPreset, settings: OutputLayerSettings, onUpdate: (result: OutputLayerResult) => void): Promise<OutputLayerResult> {
    const snapshot = structuredClone({ source, preset, settings });
    const key = identity(snapshot.source, snapshot.preset, snapshot.settings);
    const cached = this.results.get(key);
    if (cached?.status === 'completed') { onUpdate(cached); return Promise.resolve(cached); }
    const existing = this.pending.get(key);
    if (existing) return existing.promise.then((result) => { onUpdate(result); return result; });
    const controller = new AbortController();
    const abortedStatus = (): OutputLayerStatus => controller.signal.reason === 'source-invalidated' ? 'stale' : 'cancelled';
    const result: OutputLayerResult = { ...snapshot.source, status: 'queued', output: '' };
    onUpdate({ ...result });
    const run = async (): Promise<OutputLayerResult> => {
      if (controller.signal.aborted) { result.status = abortedStatus(); onUpdate({ ...result }); return result; }
      const cycleKey = JSON.stringify([snapshot.source.sessionId, snapshot.preset, snapshot.settings.historyTokens]);
      let cycle = this.cycles.get(cycleKey);
      if (!cycle) { cycle = { id: crypto.randomUUID(), pairs: [] }; this.cycles.set(cycleKey, cycle); }
      let context = structuredClone(cycle.pairs);
      try {
        await this.api.stream({
          ...snapshot.source, preset: snapshot.preset, history: context,
          historyTokens: snapshot.settings.historyTokens, cycleId: cycle.id,
        }, (event) => {
          if (controller.signal.aborted) return;
          switch (event.type) {
            case 'started':
              result.status = 'streaming';
              cycle!.id = event.cycleId;
              if (event.historyReset) { cycle!.pairs = []; context = []; }
              break;
            case 'delta': result.output += event.text; break;
            case 'reset': result.output = ''; break;
            case 'completed': result.status = 'completed'; result.output = event.text; break;
            case 'cancelled': result.status = 'cancelled'; break;
            case 'failed': result.status = 'failed'; result.error = event.message; break;
          }
          onUpdate({ ...result });
        }, { signal: controller.signal });
        if (controller.signal.aborted) result.status = abortedStatus();
        if (result.status === 'completed') {
          if (snapshot.settings.historyTokens > 0 && this.cycles.get(cycleKey) === cycle) cycle.pairs.push({
            sourceId: source.sourceId, sourceRevision: source.sourceRevision, original: source.text, output: result.output,
          });
          this.results.set(key, { ...result, identity: key, context: context.map(({ sourceId, sourceRevision }) => ({ sourceId, sourceRevision })) });
          this.persist();
        }
      } catch (error) {
        result.status = controller.signal.aborted ? abortedStatus() : 'failed';
        result.error = controller.signal.aborted ? undefined : error instanceof Error ? error.message : String(error);
      }
      onUpdate({ ...result });
      return result;
    };
    const promise = this.queue.then(run, run).finally(() => this.pending.delete(key));
    this.pending.set(key, { source: snapshot.source, controller, promise });
    this.queue = promise;
    return promise;
  }

  cancel(sessionId?: string, sourceId?: string): void {
    for (const item of this.pending.values()) {
      if ((sessionId === undefined || item.source.sessionId === sessionId) && (sourceId === undefined || item.source.sourceId === sourceId)) item.controller.abort();
    }
  }

  /** Call on undo, retry, removal or replacement before rendering the changed source. */
  invalidateSource(sessionId: string, sourceId: string): void {
    for (const item of this.pending.values()) if (item.source.sessionId === sessionId) item.controller.abort('source-invalidated');
    for (const [key, result] of this.results) {
      if (result.sessionId === sessionId && (result.sourceId === sourceId || result.context.some((pair) => pair.sourceId === sourceId))) this.results.delete(key);
    }
    for (const [key, cycle] of this.cycles) {
      if (JSON.parse(key)[0] === sessionId && cycle.pairs.some((pair) => pair.sourceId === sourceId)) this.cycles.delete(key);
    }
    this.persist();
  }

  clearHistory(sessionId?: string): void {
    for (const key of this.cycles.keys()) if (sessionId === undefined || JSON.parse(key)[0] === sessionId) this.cycles.delete(key);
  }

  clearResults(sessionId?: string): void {
    this.cancel(sessionId);
    for (const [key, value] of this.results) if (sessionId === undefined || value.sessionId === sessionId) this.results.delete(key);
    this.persist();
  }

  private persist(): void {
    this.storage?.setItem('kiki.output-layer.results.v1', JSON.stringify([...this.results.values()]));
  }
}

/** Returns contiguous Unicode-safe groups; paragraph and sentence ends are preferred near the target size. */
export function splitOutputLayerText(text: string, groupChars = 600): string[] {
  const chars = Array.from(text);
  const groups: string[] = [];
  const target = Math.max(80, Math.floor(groupChars));
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(start + target, chars.length);
    if (end < chars.length) {
      for (let candidate = end; candidate > start + target * 0.6; candidate--) {
        if (/[\n。！？.!?]/u.test(chars[candidate - 1]!)) { end = candidate; break; }
      }
    }
    groups.push(chars.slice(start, end).join(''));
    start = end;
  }
  return groups;
}

export function outputLayerViewportIndices(first: number, last: number, count: number, settings: OutputLayerSettings): number[] {
  const visible = Array.from({ length: Math.max(0, Math.min(last, count - 1) - Math.max(first, 0) + 1) }, (_, i) => Math.max(first, 0) + i);
  const before = Array.from({ length: Math.min(Math.max(first, 0), settings.preloadBefore) }, (_, i) => first - i - 1);
  const after = Array.from({ length: Math.min(Math.max(count - last - 1, 0), settings.preloadAfter) }, (_, i) => last + i + 1);
  return [...visible, ...before, ...after];
}
