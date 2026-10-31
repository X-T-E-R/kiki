import { spawn } from 'node:child_process';
import { totalmem } from 'node:os';
import { isSea } from 'node:sea';
import { getHeapStatistics } from 'node:v8';

let initialized = false;
const heapFlag = /--max[-_]old[-_]space[-_]size(?:[-_]percentage)?(?:=|\s|$)/;

export function mainHeapMb(memoryBytes = totalmem()): number {
  return Math.max(8192, Math.floor(memoryBytes / 1024 / 1024 / 4));
}

export function legacyHeapOptions(argv: readonly string[]): { argv: string[]; options: string[] } {
  const args: string[] = [];
  const options: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg !== '--node-options' && !arg.startsWith('--node-options=')) { args.push(arg); continue; }
    const value = arg === '--node-options' ? argv[++index] : arg.slice('--node-options='.length);
    if (!value) throw new Error('--node-options requires heap flags; use NODE_OPTIONS for other Node flags.');
    const tokens = value.trim().split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      const [flag, inline] = token.split('=');
      if (!/^--max[-_](?:old[-_]space[-_]size(?:[-_]percentage)?|semi[-_]space[-_]size)$/.test(flag!)) {
        throw new Error(`Unsupported --node-options flag ${JSON.stringify(token)}. Set other supported Node flags through NODE_OPTIONS.`);
      }
      const number = inline ?? tokens[++i];
      if (number === undefined || !/^\d+(?:\.\d+)?$/.test(number)) throw new Error(`Invalid heap size for ${flag}.`);
      options.push(`${flag}=${number}`);
    }
  }
  return { argv: args, options };
}

export function needsLargeHeap(args: readonly string[]): boolean {
  if (args.some(arg => ['--version', '-V', '--help', '-h'].includes(arg))) return false;
  if (args.some(arg => ['-p', '--prompt', '--prompt-file'].includes(arg) || arg.startsWith('--prompt='))) return true;
  return args.length === 0 || args.some(arg => ['serve', 'web', '--resume', '--session'].includes(arg));
}

export function mainHeapEnvironment(env: NodeJS.ProcessEnv, mb = mainHeapMb()): NodeJS.ProcessEnv {
  if (heapFlag.test(env['NODE_OPTIONS'] ?? '')) return { ...env };
  const flag = `--max-old-space-size=${mb}`;
  return { ...env, NODE_OPTIONS: `${env['NODE_OPTIONS'] ?? ''} ${flag}`, KIKI_INJECTED_HEAP_OPTION: flag };
}

export function initializeMainHeap(): boolean {
  if (initialized) return false;
  initialized = true;
  const reexecuted = process.env['KIKI_HEAP_REEXEC'] === '1';
  delete process.env['KIKI_HEAP_REEXEC'];
  const legacy = legacyHeapOptions(process.argv);
  const explicit = heapFlag.test(`${process.execArgv.join(' ')} ${process.env['NODE_OPTIONS'] ?? ''}`);
  const target = mainHeapMb();
  const resize = !reexecuted && !explicit && needsLargeHeap(legacy.argv.slice(2)) && getHeapStatistics().heap_size_limit < target * 1024 * 1024 * 0.9;
  if (legacy.options.length === 0 && !resize) return false;
  if (reexecuted) throw new Error('Kiki heap launcher did not apply the requested Node options.');
  const env = legacy.options.length > 0
    ? { ...process.env, NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} ${legacy.options.join(' ')}` }
    : mainHeapEnvironment(process.env, target);
  env['KIKI_HEAP_REEXEC'] = '1';
  const args = isSea() ? legacy.argv.slice(2) : [...process.execArgv, ...legacy.argv.slice(1)];
  const child = spawn(process.execPath, args, { env, stdio: 'inherit', windowsHide: false });
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const;
  const handlers = signals.map(signal => {
    const handler = () => {
      if (process.platform !== 'win32' || signal === 'SIGTERM') child.kill(signal);
    };
    process.on(signal, handler);
    return { signal, handler };
  });
  const clear = () => { for (const { signal, handler } of handlers) process.off(signal, handler); };
  child.once('error', error => { clear(); process.stderr.write(`Cannot start Kiki with the selected heap: ${error.message}\n`); process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    clear();
    if (signal !== null) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
  return true;
}
