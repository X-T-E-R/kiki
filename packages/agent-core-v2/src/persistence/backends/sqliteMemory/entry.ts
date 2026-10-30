import { parentPort, workerData } from 'node:worker_threads';
// oxlint-disable-next-line import/extensions
import { MemoryDatabase } from './database.ts';
import type { MemoryOperation, MemoryRequest, MemoryResponse } from './protocol.ts';

const database = new MemoryDatabase((workerData as { database: string }).database);
function execute(operation: MemoryOperation): unknown {
  switch (operation.type) {
    case 'read': return database.read(operation.scopes, operation.generation);
    case 'revision': return database.revision(operation.scope, operation.id, operation.revision);
    case 'commit': return database.commit(operation.input);
    case 'receipt': return database.receipt(operation.operationId, operation.request);
    case 'journal': return database.journal(operation.scope, operation.id);
    case 'source': return database.source(operation.scope, operation.id);
    case 'provenance': return database.provenance(operation.scope, operation.id);
    case 'importLegacy': return database.importLegacy(operation.batch);
    case 'rejectedLegacyIds': return database.rejectedLegacyIds(operation.scope, operation.entries);
    case 'legacy': return database.legacy(operation.scope);
    case 'namespaces': return database.namespaces();
    case 'backup': return database.backup(operation.destination);
    case 'close': database.close(); return undefined;
  }
}
let tail = Promise.resolve();
parentPort!.on('message', (request: MemoryRequest) => {
  tail = tail.then(async () => {
    let response: MemoryResponse;
    try { response = { id: request.id, result: await execute(request.operation) }; }
    catch (error) {
      const failure = error as Error & { code?: string; committed?: boolean };
      response = { id: request.id, error: { message: failure.message, code: failure.code, committed: failure.committed } };
    }
    parentPort!.postMessage(response, []);
    if (request.operation.type === 'close') parentPort!.close();
  });
});
