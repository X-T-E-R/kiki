import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';

const patchDir = import.meta.dirname;
const root = resolve(patchDir, '../../..');
const kapRequire = createRequire(join(root, 'packages/kap-server/package.json'));
const nbPeerNodeModules = dirname(dirname(dirname(dirname(kapRequire.resolve('@nb-im/core')))));
await mkdir(join(root, '.tmp'), { recursive: true });
const scratch = await mkdtemp(join(root, '.tmp', 'nb-im-metadata-rebuild-'));
const archive = join(scratch, 'nb-im-core-0.3.0-kiki-im-metadata.tgz');
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: 'inherit' });
const local = (path) => relative(root, path).replaceAll('\\', '/');
run('tar', ['-xf', 'vendor/nb-im-core-0.3.0.tgz', '-C', local(scratch)]);
for (const patch of ['source.patch', 'wechat-send.patch', 'wechat-quote.patch', 'node24-lookup.patch', 'feishu-video.patch', 'inbound-rich-message.patch']) {
  run('git', ['apply', '--unidiff-zero', `--directory=${relative(root, join(scratch, 'package')).replaceAll('\\', '/')}`, join(patchDir, patch)]);
}
await symlink(nbPeerNodeModules, join(scratch, 'node_modules'), 'junction');
await writeFile(join(scratch, 'ws-ambient.d.ts'), `declare module 'ws' {
  import type { IncomingMessage } from 'node:http';
  import type { AddressInfo } from 'node:net';
  export class WebSocket {
    static readonly OPEN: number;
    readonly readyState: number;
    constructor(url: string, options?: Record<string, unknown>);
    on(event: 'message', listener: (data: string | Buffer) => void): this;
    on(event: 'close' | 'error' | 'open', listener: (...args: unknown[]) => void): this;
    once(event: 'open' | 'error' | 'close', listener: (...args: unknown[]) => void): this;
    send(data: string): void;
    close(): void;
    terminate(): void;
  }
  export class WebSocketServer {
    constructor(options: { host: string; port: number });
    once(event: 'listening' | 'error', listener: (...args: unknown[]) => void): this;
    on(event: 'connection', listener: (socket: WebSocket, request: IncomingMessage) => void): this;
    address(): AddressInfo | string | null;
    close(): void;
  }
}\n`);
await writeFile(join(scratch, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
    declaration: true, declarationMap: false, sourceMap: false, rewriteRelativeImportExtensions: true,
    verbatimModuleSyntax: true, typeRoots: [join(root, 'node_modules/@types')], types: ['node'],
    skipLibCheck: true, noEmitOnError: true, outDir: './generated', rootDir: './package/src',
  },
  files: [
    './ws-ambient.d.ts',
    './package/src/session/contract.ts',
    './package/src/session/telegram.ts',
    './package/src/session/wechat.ts',
    './package/src/session/feishu.ts',
    './package/src/session/feishu-sdk.ts',
    './package/src/session/onebot.ts',
    './package/src/session/realtime.ts',
    './package/src/providers.ts',
  ],
}, null, 2));
run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(scratch, 'tsconfig.json')]);
for (const module of ['session/contract', 'session/telegram', 'session/telegram-http', 'session/wechat', 'session/feishu', 'session/feishu-sdk', 'session/onebot', 'session/realtime', 'providers']) {
  for (const extension of ['js', 'd.ts']) await copyFile(join(scratch, `generated/${module}.${extension}`), join(scratch, `package/dist/${module}.${extension}`));
}
run(process.execPath, ['--test', '--experimental-strip-types', 'test/session-telegram.test.ts', 'test/session-wechat.test.ts', 'test/session-feishu.test.ts', 'test/session-onebot.test.ts', 'test/session-realtime.test.ts', 'test/session-extended-media.test.ts'], join(scratch, 'package'));
run(process.execPath, [join(patchDir, 'pinned-ipv4.test.mjs'), join(scratch, 'package')]);
run('tar', ['-czf', local(archive), '-C', local(scratch), 'package']);
process.stdout.write(`${archive}\n`);
