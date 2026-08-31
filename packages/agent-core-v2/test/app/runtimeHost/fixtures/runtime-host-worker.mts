import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { HomeRuntimeHostService } from '#/app/runtimeHost/runtimeHostService';

const [homeDir = ''] = process.argv.slice(2);
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
  modelAccountHomeDir: homeDir,
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

function send(event: unknown): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

runtime.registerMethod('echo', (payload) => payload);
runtime.registerMethod('block', (_payload, context) => {
  send({ type: 'handler-started', requestId: context.requestId });
  return new Promise((_resolve, reject) => {
    context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
  });
});
runtime.onDidChangeRoleStatus((status) => send({ type: 'status', status: { ...status, hostId: runtime.status().hostId } }));

await runtime.ready();
send({ type: 'ready', status: runtime.status() });

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const command = JSON.parse(line) as {
    readonly type: 'call' | 'close';
    readonly id?: string;
    readonly method?: string;
    readonly payload?: unknown;
    readonly timeoutMs?: number;
  };
  if (command.type === 'close') {
    void runtime.close().then(() => {
      send({ type: 'closed' });
      input.close();
    });
    return;
  }
  void runtime.call(command.method!, command.payload, {
    requestId: command.id,
    timeoutMs: command.timeoutMs,
  }).then(
    (value) => send({ type: 'call-result', id: command.id, value }),
    (error: unknown) => {
      const cause = error instanceof Error ? error.cause as NodeJS.ErrnoException | undefined : undefined;
      send({
        type: 'call-error',
        id: command.id,
        code: error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined,
        causeCode: cause?.code,
        message: error instanceof Error ? error.message : String(error),
      });
    },
  );
});
