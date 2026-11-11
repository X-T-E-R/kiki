import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { type Command } from 'commander';
import {
  connectRuntimeSupervisor, readInstalledRuntimeRelease, readRuntimeLaunch, readRuntimeReleasePointer,
  RuntimeStore, runtimeControllerRequest, runtimeReleaseSchema, saveRuntimeLaunch, startRuntimeSupervisor, verifiedRuntimeRelease,
} from '@kiki/kap-server';
import { getVersion } from '../cli/package-version';
import { resolveKikiHome } from './home';

async function runtimeRootFromExecutable(): Promise<{ root: string; releaseId: string } | undefined> {
  let executable = process.execPath;
  try { executable = await realpath(executable); } catch {}
  const releaseDir = dirname(executable), releasesDir = dirname(releaseDir);
  if (resolve(releasesDir, '..') === releasesDir || !existsSync(join(releasesDir, '..', 'current.json')) && !existsSync(join(releasesDir, '..', 'installed.json'))) return undefined;
  return { root: resolve(releasesDir, '..'), releaseId: releaseDir.slice(releasesDir.length + 1) };
}

async function defaultRuntimeLaunch(homeDir: string, options: { releaseRoot?: string; port?: string }) {
  const existing = await readRuntimeLaunch(homeDir);
  if (existing !== undefined && options.releaseRoot === undefined && options.port === undefined) return existing;
  const discovered = options.releaseRoot === undefined ? await runtimeRootFromExecutable() : undefined;
  const releaseRoot = options.releaseRoot === undefined ? discovered?.root : resolve(options.releaseRoot);
  if (releaseRoot !== undefined) {
    const releaseId = discovered?.releaseId ?? await readRuntimeReleasePointer(releaseRoot, 'current') ?? await readRuntimeReleasePointer(releaseRoot, 'installed');
    if (releaseId === undefined) throw new Error('No installed release pointer was found in the runtime root.');
    const initial = await verifiedRuntimeRelease(releaseRoot, releaseId);
    return { executable: initial.executable, args: initial.args, releaseRoot,
      initial: { ...initial, port: options.port === undefined ? undefined : Number(options.port) } };
  }
  const executable = process.execPath;
  const args = process.argv[1] === undefined || process.argv[1] === executable ? [] : [process.argv[1]];
  return { executable, args, initial: runtimeReleaseSchema.parse({ releaseId: process.env['KIKI_RELEASE_ID'] ?? getVersion(),
    serverVersion: getVersion(), buildId: process.env['KIKI_BUILD_ID'], buildChannel: process.env['KIKI_BUILD_CHANNEL'],
    executable, args, port: options.port === undefined ? undefined : Number(options.port), rollbackVerifiedWith: [] }) };
}

export function registerRuntimeCommand(program: Command): void {
  const runtime = program.command('runtime').description('Manage the desktop-owned server release switch');
  const homeOption = (command: Command) => command.option('--home <dir>', 'Kiki home directory').option('--json', 'Emit JSON');
  const write = (json: boolean | undefined, value: unknown) => { process.stdout.write(`${JSON.stringify(value, null, json ? 0 : 2)}\n`); };

  homeOption(runtime.command('supervise').option('--release-root <dir>', 'Release catalog root').option('--port <port>', 'Managed server port'))
    .action(async (opts: { home?: string; releaseRoot?: string; port?: string; json?: boolean }) => {
      const homeDir = resolveKikiHome(opts.home);
      const launch = await defaultRuntimeLaunch(homeDir, opts);
      await saveRuntimeLaunch(homeDir, launch);
      const existing = await connectRuntimeSupervisor(homeDir);
      if (existing !== undefined) { write(opts.json, await runtimeControllerRequest(homeDir, 'ensure', {})); return; }
      const supervisor = await startRuntimeSupervisor({ homeDir, initial: launch.initial, releaseRoot: launch.releaseRoot,
        warn: error => { process.stderr.write(`kiki runtime: ${error instanceof Error ? error.message : String(error)}\n`); } });
      write(opts.json, { status: 'running', port: supervisor.port, homeDir });
      await new Promise<void>(resolve => {
        const stop = () => { void supervisor.close().finally(resolve); };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    });

  homeOption(runtime.command('status').option('--release-root <dir>', 'Release catalog root'))
    .action(async (opts: { home?: string; releaseRoot?: string; json?: boolean }) => {
      const homeDir = resolveKikiHome(opts.home);
      if (await connectRuntimeSupervisor(homeDir) !== undefined) { write(opts.json, await runtimeControllerRequest(homeDir, 'status')); return; }
      const store = new RuntimeStore(homeDir);
      try {
        const launch = await readRuntimeLaunch(homeDir);
        const root = opts.releaseRoot === undefined ? launch?.releaseRoot : resolve(opts.releaseRoot);
        const active = store.read<{ releaseId?: string }>('active');
        const activeRelease = root !== undefined && active?.releaseId !== undefined ? await readInstalledRuntimeRelease(root, active.releaseId).catch(() => undefined) : undefined;
        write(opts.json, { controller: 'stopped', writer: store.writer(), operation: store.read('operation'), active, activeRelease });
      } finally { store.close(); }
    });

  for (const [name, reason] of [['activate', 'update'], ['rollback', 'rollback'], ['restart', 'restart']] as const) {
    const command = homeOption(runtime.command(name));
    if (reason !== 'restart') command.argument('<releaseId>', 'Installed release identifier');
    command.action(async (first: unknown, second?: unknown) => {
      const releaseId = typeof first === 'string' ? first : undefined;
      const opts = (typeof first === 'string' ? second : first) as { home?: string; json?: boolean };
      write(opts.json, await runtimeControllerRequest(resolveKikiHome(opts.home), 'activate', { releaseId, reason }));
    });
  }

  homeOption(runtime.command('cancel').argument('<operationId>', 'Waiting switch operation identifier'))
    .action(async (operationId: string, opts: { home?: string; json?: boolean }) => {
      write(opts.json, await runtimeControllerRequest(resolveKikiHome(opts.home), 'cancel', { operationId }));
    });
}
