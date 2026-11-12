import { parentPort, workerData } from 'node:worker_threads';
import { RESOURCE_DEFAULTS } from '@kiki/agent-core-v2/_base/node/resourceDefaults';
import { warnIfWorkerHeapLimit } from '@kiki/agent-core-v2/_base/node/workerHeapPolicy';
import { HistoryNavigationDb } from '../historyNavigationDb';
import { HistoryLocatorEngine, type HistoryNavigationSources } from '../historyLocatorStore';
import { readHistoryColdTailTurn } from '../historyColdTailTurn';
import { navigationError, type NavigationCallbackResult, type NavigationRequest, type NavigationResponse, type TranscriptCallback } from './protocol';

warnIfWorkerHeapLimit(RESOURCE_DEFAULTS.workerHeapMb);
if (parentPort === null) throw new Error('History navigation requires a worker port');
const port = parentPort;
const database = HistoryNavigationDb.lazy((workerData as { database: string }).database);
let active: { request: NavigationRequest; controller: AbortController } | undefined;
let detailBudget = RESOURCE_DEFAULTS.workerHeapMb << 20;
let callbackId = 0;
const callbacks = new Map<number, (message: NavigationCallbackResult) => void>();

function coldTurn(method: TranscriptCallback): HistoryNavigationSources[TranscriptCallback] {
  return (session, agent, turn, signal) => {
    signal?.throwIfAborted();
    const id = ++callbackId;
    return new Promise((resolve, reject) => {
      callbacks.set(id, message => {
        if (message.error !== undefined) reject(Object.assign(new Error(message.error.message), message.error));
        else resolve(message.result as Awaited<ReturnType<HistoryNavigationSources[TranscriptCallback]>>);
      });
      port.postMessage({ type: 'callback', id, request: active!.request.id, method,
        args: [session, agent, turn] } satisfies NavigationResponse);
    });
  };
}

const engine = new HistoryLocatorEngine(database, {
  async historyWireLocation(session, agent) {
    const request = active!.request;
    if (request.session !== session || request.agent !== agent) throw new Error('history navigation source mismatch');
    return request.location;
  },
  detailCacheBudgetBytes: () => detailBudget,
  scheduleHistoryRead: (signal, read) => read(signal ?? active!.controller.signal),
  readRetainedColdTurn: coldTurn('readRetainedColdTurn'),
  readColdWindowTurn: coldTurn('readColdWindowTurn'),
  readProjectedColdTurn: async (_session, agent, turn, signal) => {
    const location = active!.request.location;
    return location === undefined ? undefined : readHistoryColdTailTurn(location.wirePath, agent, turn, signal);
  },
}, true);

function dispatch(request: NavigationRequest, signal: AbortSignal): unknown {
  const { method, args } = request;
  switch (method) {
    case 'scan': return engine.scan(...args.slice(0, 2) as [string, string], signal,
      ...args.slice(2) as [Parameters<typeof engine.scan>[3], number?, Parameters<typeof engine.scan>[5]?]);
    case 'list': return engine.list({ ...args[0] as Parameters<typeof engine.list>[0], signal });
    case 'lookupDirectory': return engine.lookupDirectory(...args as [string, string, string, number, string?, Parameters<typeof engine.lookupDirectory>[5]?], signal);
    case 'readBlocks': return engine.readBlocks(...args as [string, number, Parameters<typeof engine.readBlocks>[2]], signal);
    case 'read': return engine.read(args[0] as string, signal);
    case 'lookupToolCall': return engine.lookupToolCall(...args as [string, string, string], signal);
    case 'readCanonicalEntity': return engine.readCanonicalEntity(...args.slice(0, 3) as [string, string, Parameters<typeof engine.readCanonicalEntity>[2]], signal, args[3] === true);
    case 'readDurableTurn': return engine.readDurableTurn(...args as [string, string, string], signal);
    case 'readCanonicalTurnHeader': return engine.readCanonicalTurnHeader(...args as [string, string, string], signal);
    case 'readCanonicalTurnHeaders': return engine.readCanonicalTurnHeaders(...args as [string, string, readonly string[]], signal);
    case 'prepareResidentProof': return engine.residentCheckpoint(...args as [string, string], signal);
    case 'proveResident': return engine.proveResidentCheckpoint(...args as [Parameters<typeof engine.proveResidentCheckpoint>[0], string,
      Parameters<typeof engine.proveResidentCheckpoint>[2]], signal);
    case 'checkResidentFailure': return engine.checkResidentFailure(...args as Parameters<typeof engine.checkResidentFailure>);
    case 'row': return engine.row(...args as Parameters<typeof engine.row>);
    case 'indexedTurnByte': return engine.indexedTurnByte(...args as Parameters<typeof engine.indexedTurnByte>);
    case 'invalidateCanonical': return engine.invalidateCanonical();
    case 'close': engine.invalidateCanonical(); return database.close();
  }
}

async function execute(request: NavigationRequest): Promise<void> {
  const controller = new AbortController();
  const signal = controller.signal;
  const cancellation = new Int32Array(request.cancellation);
  const isCancelled = () => Atomics.load(cancellation, 0) !== 0;
  Object.defineProperties(signal, {
    aborted: { get: isCancelled },
    throwIfAborted: { value: () => { if (isCancelled()) throw new DOMException('History navigation cancelled', 'AbortError'); } },
  });
  const timer = setInterval(() => { if (isCancelled()) controller.abort(); }, 10);
  timer.unref();
  active = { request, controller };
  detailBudget = request.detailBudget;
  let response: NavigationResponse;
  try {
    signal.throwIfAborted();
    const result = await dispatch(request, signal);
    signal.throwIfAborted();
    response = { id: request.id, result, report: engine.canonicalReadReport(), retainedBodyChars: engine.retainedBodyChars };
  } catch (error) {
    response = { id: request.id, error: navigationError(error) };
  } finally { clearInterval(timer); active = undefined; }
  port.postMessage(response);
  if (request.method === 'close') port.close();
}

port.on('message', (message: NavigationRequest | NavigationCallbackResult) => {
  if ('type' in message) {
    const callback = callbacks.get(message.id);
    callbacks.delete(message.id);
    callback?.(message);
  } else {
    void execute(message);
  }
});
