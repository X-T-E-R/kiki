import { join } from 'node:path';
import { SyncDescriptor } from '../../src/_base/di/descriptors';
import { TestInstantiationService } from '../../src/_base/di/test';
import { IBootstrapService } from '../../src/app/bootstrap/bootstrap';
import { IMemoryScopes } from '../../src/app/memory/memoryScopes';
import { ILegacyMemoryStore, MemoryStore } from '../../src/app/memory/memoryStore';
import { IMemoryAuthorityService, MemoryAuthorityService } from '../../src/app/memory/memoryAuthorityStore';
import { ISqliteMemoryStore, SqliteMemoryStore } from '../../src/app/memory/sqliteMemoryStore';
import { IMemoryShadowImport, MemoryShadowImport } from '../../src/app/memory/memoryShadowImport';
import { IMemoryPersistence } from '../../src/persistence/interface/memoryPersistence';
import { SqliteMemoryPersistence } from '../../src/persistence/backends/sqliteMemory/sqliteMemoryPersistence';
import { IAtomicDocumentStore } from '../../src/persistence/interface/atomicDocumentStore';
import { JsonAtomicDocumentStore } from '../../src/persistence/backends/node-fs/atomicDocumentStore';
import { IFileSystemStorageService } from '../../src/persistence/interface/storage';
import { FileStorageService } from '../../src/persistence/backends/node-fs/fileStorageService';
import { MEMORY_AUTHORITY_SCOPE } from '../../src/persistence/memoryAuthority';

const home = process.argv[2]!;
const storage = new FileStorageService(home);
const write = storage.write.bind(storage);
storage.write = async (...args: Parameters<typeof write>) => {
  await write(...args);
  if (args[0] !== MEMORY_AUTHORITY_SCOPE || args[1] !== 'backend.json') return;
  const state = JSON.parse(new TextDecoder().decode(args[2]));
  if (state.backend === 'legacy' && state.migration?.index > 0) {
    process.stdout.write(`${JSON.stringify(state)}\n`, () => process.exit(73));
    await new Promise(() => {});
  }
};
const ix = new TestInstantiationService();
ix.stub(IBootstrapService, { storeDir: join(home, 'store') });
ix.stub(IFileSystemStorageService, storage);
ix.stub(IMemoryScopes, { resolve: async (scope) => scope.kind === 'global' ? 'memory/global' : scope.kind === 'persona' ? `memory/global/personas/${scope.personaId}` : scope.kind === 'workspace' ? `memory/workspaces/${scope.workspaceId}` : `memory/workspaces/${scope.workspaceId}/personas/${scope.personaId}` });
ix.set(ILegacyMemoryStore, new SyncDescriptor(MemoryStore));
ix.set(ISqliteMemoryStore, new SyncDescriptor(SqliteMemoryStore));
ix.set(IMemoryShadowImport, new SyncDescriptor(MemoryShadowImport));
ix.set(IMemoryPersistence, new SyncDescriptor(SqliteMemoryPersistence));
ix.set(IAtomicDocumentStore, new SyncDescriptor(JsonAtomicDocumentStore));
ix.set(IMemoryAuthorityService, new SyncDescriptor(MemoryAuthorityService));
await ix.get(IMemoryAuthorityService).prepare();
process.exit(1);
