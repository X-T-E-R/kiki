import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LockError } from '@moonshot-ai/minidb';

import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { HomeRuntimeHostService } from '#/app/runtimeHost/runtimeHostService';
import { RuntimeThreadMailboxStore } from '#/app/threadCommunication/runtimeThreadMailboxStore';
import type { ThreadRef } from '#/app/threadCommunication/threadCommunication';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';

const [homeDir = '', writer = '0', countText = '1'] = process.argv.slice(2);
const count = Number.parseInt(countText, 10);
const source: ThreadRef = { hostId: 'host-a', workspaceId: 'workspace-a', sessionId: 'source' };
const target: ThreadRef = { hostId: 'host-a', workspaceId: 'workspace-b', sessionId: 'target' };
const bootstrap: IBootstrapService = {
  _serviceBrand: undefined,
  platform: process.platform,
  arch: process.arch,
  cwd: process.cwd(),
  osHomeDir: tmpdir(),
  homeDir,
  configPath: join(homeDir, 'config.toml'),
  configReadOnly: false,
  userAgentProfileHomeDir: homeDir,
  configKey: 'config.toml',
  clientIdentity: { productName: 'test', version: '0', platform: 'test' },
  args: { requestHeaders: {} },
  sessionsDir: join(homeDir, 'sessions'),
  blobsDir: join(homeDir, 'blobs'),
  storeDir: join(homeDir, 'store'),
  cacheDir: join(homeDir, 'cache'),
  logsDir: join(homeDir, 'logs'),
  getEnv: () => undefined,
  scope: (name) => name,
};
const runtime = new HomeRuntimeHostService(bootstrap);
const store = new RuntimeThreadMailboxStore(bootstrap, runtime, new HostFileSystem());
const seqs: number[] = [];
let lockErrors = 0;
try {
  for (let index = 0; index < count; index += 1) {
    try {
      const accepted = await store.acceptMessage({
        producer: { kind: 'peer_thread', source },
        target,
        content: `${writer}-${index}`,
        idempotencyKey: `${writer}-${index}`,
      });
      seqs.push(accepted.message.targetSeq);
    } catch (error) {
      if (error instanceof LockError) lockErrors += 1;
      else throw error;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
} finally {
  await store.close();
  await runtime.close();
}
process.stdout.write(JSON.stringify({ seqs, lockErrors }));
