import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { legacyHeapOptions, mainHeapEnvironment, mainHeapMb, needsLargeHeap } from '../../src/native/main-heap';
import { removeInjectedHeapOption } from '../../../../packages/agent-core-v2/src/_base/node/workerHeapPolicy';

const policy = new URL('../../../../packages/agent-core-v2/src/_base/node/workerHeapPolicy.ts', import.meta.url).href;
const launcher = new URL('../../src/native/main-heap.ts', import.meta.url).href;

it('sizes the main heap and exempts short commands', () => {
  expect(mainHeapMb(16 * 1024 ** 3)).toBe(8192);
  expect(mainHeapMb(64 * 1024 ** 3)).toBe(16384);
  for (const args of [['serve'], ['acp'], ['-p', 'hello'], ['--prompt-file=prompt.txt'], ['-m', 'web', '-p', 'serve']]) expect(needsLargeHeap(args)).toBe(true);
  for (const args of [[], ['--session', 'example'], ['--continue'], ['--version'], ['web'], ['serve', '--ensure'], ['serve', '--query'], ['serve', '--stop'], ['acp', '--login'], ['tools', 'Read', 'call'], ['completion'], ['serve', '--help'], ['-m', 'serve'], ['-p', 'ignored', '__plugin_run_node', 'entry.mjs']]) expect(needsLargeHeap(args)).toBe(false);
  expect(legacyHeapOptions(['exe', '--node-options=--max-old-space-size=9000', 'serve'])).toEqual({ argv: ['exe', 'serve'], options: ['--max-old-space-size=9000'] });
  expect(() => legacyHeapOptions(['--node-options=--inspect'])).toThrow('Unsupported --node-options flag');
});

it('removes only the injected heap flag and leaves user NODE_OPTIONS byte-for-byte', () => {
  const original = ' --trace-warnings  ';
  const env = mainHeapEnvironment({ NODE_OPTIONS: original }, 16384);
  removeInjectedHeapOption(env);
  expect(env['NODE_OPTIONS']).toBe(original);
  expect(env['KIKI_INJECTED_HEAP_OPTION']).toBeUndefined();
  const explicit = { NODE_OPTIONS: '--max-old-space-size=1024' };
  removeInjectedHeapOption(explicit);
  expect(explicit.NODE_OPTIONS).toBe('--max-old-space-size=1024');
});

it('pre-sizes a detached server so its registry PID remains the spawned PID', () => {
  expect(mainHeapEnvironment({ KIKI_HOME: 'isolated-home', NODE_OPTIONS: '--trace-warnings' }, 16384)).toMatchObject({
    KIKI_HOME: 'isolated-home', NODE_OPTIONS: '--trace-warnings --max-old-space-size=16384', KIKI_INJECTED_HEAP_OPTION: '--max-old-space-size=16384',
  });
});

it('preserves a detached server user heap override without adding an injection marker', () => {
  expect(mainHeapEnvironment({ NODE_OPTIONS: '--max_old_space_size=1024' }, 16384)).toEqual({ NODE_OPTIONS: '--max_old_space_size=1024' });
});

describe('isolated heap processes', () => {
  it.each([8192, 16384])('keeps the %s MiB main heap while enforcing worker heaps and surviving worker OOM', (mb) => {
    const code = `import {Worker} from 'node:worker_threads';
      import {getHeapStatistics} from 'node:v8';
      import {enableIndependentWorkerHeaps} from ${JSON.stringify(policy)};
      const main = getHeapStatistics().heap_size_limit;
      enableIndependentWorkerHeaps(); enableIndependentWorkerHeaps();
      const worker = new Worker('const {parentPort}=require("node:worker_threads");parentPort.postMessage(require("node:v8").getHeapStatistics().heap_size_limit)',{eval:true,execArgv:[],resourceLimits:{maxOldGenerationSizeMb:512}});
      const heap = await new Promise(resolve=>worker.on('message',resolve));
      const doomed = new Worker('const retained=[];while(true)retained.push(new Array(1000000).fill(Math.random()))',{eval:true,execArgv:[],resourceLimits:{maxOldGenerationSizeMb:16}});
      const error = await new Promise(resolve=>doomed.on('error',error=>resolve(error.code)));
      console.log(JSON.stringify({main:main/1048576,after:getHeapStatistics().heap_size_limit/1048576,worker:heap/1048576,error,alive:true}));`;
    const result = JSON.parse(execFileSync(process.execPath, [`--max-old-space-size=${mb}`, '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 30_000 }).trim());
    expect(result.main).toBeGreaterThanOrEqual(mb);
    expect(result.after).toBe(result.main);
    expect(result.worker).toBeGreaterThanOrEqual(512);
    expect(result.worker).toBeLessThanOrEqual(768);
    expect(result).toMatchObject({ error: 'ERR_WORKER_OUT_OF_MEMORY', alive: true });
  }, 35_000);

  it('keeps injected Node options out of spawned tools and preserves user heap overrides', () => {
    const code = `import {execFileSync} from 'node:child_process';import {removeInjectedHeapOption} from ${JSON.stringify(policy)};removeInjectedHeapOption(process.env);console.log(execFileSync(process.execPath,['-e','console.log(require("node:v8").getHeapStatistics().heap_size_limit/1048576)'],{encoding:'utf8'}).trim());`;
    const injected = Number(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: mainHeapEnvironment(process.env, 16384) }).trim());
    const normal = Number(execFileSync(process.execPath, ['-e', 'console.log(require("node:v8").getHeapStatistics().heap_size_limit/1048576)'], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } }).trim());
    expect(injected).toBe(normal);
    const user = Number(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=1024' } }).trim());
    expect(user).toBeGreaterThanOrEqual(1024);
    expect(user).toBeLessThan(1400);
  });

  it('reexecutes long entries once, inherits stdin/stdout/stderr and propagates exit codes', () => {
    const home = mkdtempSync(join(tmpdir(), 'kiki-heap-launch-'));
    const entry = join(home, 'entry.mjs');
    writeFileSync(entry, `import {initializeMainHeap} from ${JSON.stringify(launcher)};if(!initializeMainHeap()){process.stdin.pipe(process.stdout);process.stderr.write('stderr retained');process.exitCode=7;}`);
    try {
      let result: unknown;
      try { execFileSync(process.execPath, ['--experimental-strip-types', entry, 'serve'], { input: 'stdio retained', encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', KIKI_HEAP_REEXEC: '' }, timeout: 20_000 }); }
      catch (error) { result = error; }
      expect(result).toMatchObject({ status: 7, stdout: 'stdio retained', stderr: 'stderr retained' });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('preserves the platform termination result when the engine child is killed by SIGTERM', () => {
    const home = mkdtempSync(join(tmpdir(), 'kiki-heap-terminated-'));
    const entry = join(home, 'entry.mjs');
    writeFileSync(entry, `import {initializeMainHeap} from ${JSON.stringify(launcher)};if(!initializeMainHeap())process.kill(process.pid,'SIGTERM');`);
    const termination = (args: string[]) => {
      try { execFileSync(process.execPath, args, { env: { ...process.env, NODE_OPTIONS: '', KIKI_HEAP_REEXEC: '' }, timeout: 20_000 }); }
      catch (error) { const result = error as { status: number | null; signal: string | null }; return { status: result.status, signal: result.signal }; }
      throw new Error('Expected forced process termination');
    };
    try {
      const direct = termination(['-e', 'process.kill(process.pid,"SIGTERM")']);
      expect(direct).toEqual(process.platform === 'win32' ? { status: 1, signal: null } : { status: null, signal: 'SIGTERM' });
      expect(termination([entry, 'serve'])).toEqual(direct);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('handles real Windows Ctrl+C, Ctrl+Break and console close in an isolated console', () => {
    const home = mkdtempSync(join(tmpdir(), 'kiki-heap-console-'));
    const entry = join(home, 'entry.mjs');
    const harness = join(home, 'console.exe');
    const script = join(home, 'console.ps1');
    const windows = process.env['WINDIR'] ?? 'C:\\Windows';
    writeFileSync(entry, `import {appendFileSync} from 'node:fs';import {initializeMainHeap} from ${JSON.stringify(launcher)};if(!initializeMainHeap()){const path=process.argv[3];appendFileSync(path,JSON.stringify({event:'ready',pid:process.pid,ppid:process.ppid})+'\\n');for(const [signal,code] of [['SIGINT',130],['SIGBREAK',131],['SIGHUP',129]])process.on(signal,()=>{appendFileSync(path,JSON.stringify({event:signal})+'\\n');process.exit(code)});setInterval(()=>{},1000);}`);
    writeFileSync(script, `param([string]$Conhost,[string]$Harness,[string]$Node,[string]$Entry,[string]$Log,[string]$Mode)\n$arguments='"'+$Harness+'" "'+$Node+'" "'+$Entry+'" "'+$Log+'" '+$Mode\n$p=Start-Process -FilePath $Conhost -ArgumentList $arguments -PassThru -Wait\nexit $p.ExitCode\n`);
    try {
      execFileSync(join(windows, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['-nologo', '-target:exe', `-out:${harness}`, fileURLToPath(new URL('./fixtures/main-heap-console.cs', import.meta.url))]);
      for (const [mode, signal, code] of [['interrupt', 'SIGINT', 130], ['break', 'SIGBREAK', 131], ['close', 'SIGHUP', 129]] as const) {
        const log = join(home, `${mode}.jsonl`);
        try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, join(windows, 'System32/conhost.exe'), harness, process.execPath, entry, log, mode], { timeout: 30_000 }); }
        catch (error) { if ((error as { killed?: boolean }).killed) throw error; }
        const events = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { event: string; ppid?: number });
        expect(events.map(event => event.event)).toEqual(['ready', signal]);
        const pid = Number(readFileSync(`${log}.controller`, 'utf8'));
        expect(events[0]!.ppid).toBe(pid);
        if (mode !== 'close') expect(Number(readFileSync(`${log}.exit`, 'utf8'))).toBe(code);
        expect(() => process.kill(pid, 0)).toThrow();
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 100_000);
});
