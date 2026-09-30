import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';

import { ManagedAdapterService } from '#/app/agentExecutor/managedAdapterService';
import { MANAGED_ADAPTER_RELEASES, type ManagedAdapterRelease } from '#/app/agentExecutor/managedAdapterRegistry';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostProcessService } from '#/os/interface/hostProcess';

const [home, version] = process.argv.slice(2);
if (home === undefined || version === undefined) throw new Error('home and version are required');
const archive = Buffer.from(`fixture archive ${version}`);
const release = MANAGED_ADAPTER_RELEASES['claude-acp']!;
(MANAGED_ADAPTER_RELEASES as Record<string, ManagedAdapterRelease>)['claude-acp'] = {
  ...release, version, integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
};
const bootstrap = { homeDir: home, platform: 'linux', getEnv: (key: string) => key === 'PATH' ? '/bin' : undefined } as IBootstrapService;
const fs = {
  mkdir: async () => {},
  stat: async (path: string) => ({ isFile: true, isDirectory: false, size: path.endsWith('.tgz') ? archive.length : 0 }),
  readBytes: async () => archive,
  readText: async () => JSON.stringify({ name: release.packageName, version }),
} as unknown as IHostFileSystem;
const hostProcess = {
  spawn: async (_command: string, args: readonly string[]) => ({
    pid: process.pid,
    stdin: new Writable({ write(_chunk, _encoding, done) { done(); } }),
    stdout: Readable.from([args[0] === 'pack' ? 'fixture.tgz\n' : 'added 1 package\n']),
    stderr: Readable.from([]),
    wait: async () => 0,
    kill: async () => {}, dispose: async () => {},
  }),
} as unknown as IHostProcessService;
const store = new TomlAtomicDocumentStore(new FileStorageService(home));
const installer = new ManagedAdapterService(bootstrap, fs, hostProcess, store);
process.send?.('ready');
process.on('message', () => {
  void installer.install('claude-acp').then(
    (status) => { process.send?.({ active: status.active?.version, previous: status.previous?.version },
      () => process.disconnect?.()); },
    (error) => { console.error(error); process.exitCode = 1; process.disconnect?.(); },
  );
});
