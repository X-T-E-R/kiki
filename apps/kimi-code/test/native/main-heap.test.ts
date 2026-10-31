import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  for (const args of [[], ['serve'], ['web'], ['-p', 'hello']]) expect(needsLargeHeap(args)).toBe(true);
  for (const args of [['--version'], ['tools', 'Read', 'call'], ['completion'], ['serve', '--help']]) expect(needsLargeHeap(args)).toBe(false);
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
});
