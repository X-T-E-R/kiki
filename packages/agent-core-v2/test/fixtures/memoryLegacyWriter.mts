import { SyncDescriptor } from '../../src/_base/di/descriptors';
import { TestInstantiationService } from '../../src/_base/di/test';
import { IMemoryStore, MemoryStore } from '../../src/app/memory/memoryStore';
import { IMemoryScopes } from '../../src/app/memory/memoryScopes';
import { IFileSystemStorageService } from '../../src/persistence/interface/storage';
import { FileStorageService } from '../../src/persistence/backends/node-fs/fileStorageService';

const storage = new FileStorageService(process.argv[2]!);
const ix = new TestInstantiationService();
ix.stub(IFileSystemStorageService, storage);
ix.stub(IMemoryScopes, { resolve: async () => 'memory/global' });
ix.set(IMemoryStore, new SyncDescriptor(MemoryStore));
try {
  await ix.get(IMemoryStore).put({ action: 'create', scope: { kind: 'global' }, type: 'feedback', title: 'Legacy writer attempt', body: 'Never create this stale legacy write.', reason: 'Legacy writer compatibility probe', source: { writer: 'user' } });
  process.stdout.write(`${JSON.stringify({ written: true })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ written: false, code: (error as { code?: string }).code, message: (error as Error).message })}\n`);
} finally { await storage.close(); await ix.dispose(); }
