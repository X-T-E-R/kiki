'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, renameSync } = require('node:fs');
const { once } = require('node:events');
const { resolve, join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const auth = require('../index.cjs');
const root = resolve(__dirname, '../../..');
const scratch = resolve(root, '.tmp/auth-native-build');
const env = { ...process.env, CARGO_HOME: join(scratch, 'cargo-home'), CARGO_TARGET_DIR: join(scratch, 'target') };
const fixture = join(scratch, 'target/release/examples', process.platform === 'win32' ? 'compat.exe' : 'compat');
let temp;
const passphrase = 'synthetic-auth-fixture-passphrase';
const plaintext = Buffer.from('{"version":1,"secrets":{"example":"SYNTHETIC_ONLY"}}');
before(() => {
  mkdirSync(scratch, { recursive: true });
  temp = mkdtempSync(join(scratch, 'fixtures-'));
  execFileSync('cargo', ['build', '--release', '--locked', '--example', 'compat'], { cwd: resolve(__dirname, '..'), env, stdio: 'pipe' });
});
after(() => rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));

test('independent Rust age 0.11.1 scrypt vector decrypts in Node, and Node decrypts in Rust', async () => {
  const file = join(temp, 'synthetic.age');
  execFileSync(fixture, ['encrypt', file]);
  const ciphertext = readFileSync(file);
  assert.equal(ciphertext.subarray(0, 22).toString(), 'age-encryption.org/v1\n');
  assert.deepEqual(await auth.ageDecrypt(ciphertext, passphrase), plaintext);
  await assert.rejects(auth.ageDecrypt(ciphertext, 'wrong-synthetic-passphrase'), /Age decryption failed/);
  const output = await auth.ageEncrypt(plaintext, passphrase);
  writeFileSync(file, output);
  assert.match(execFileSync(fixture, ['decrypt', file], { encoding: 'utf8' }), /AGE_COMPAT_OK/);
  await assert.rejects(auth.ageDecrypt(Buffer.from('invalid age'), passphrase), /Age decryption failed/);
  assert.throws(() => auth.ageEncrypt(plaintext, ''), /passphrase must not be empty/);
});

test('Rust canonical home string and original SHA256 input are identical in Node', async () => {
  const { createHash } = require('node:crypto');
  const [expected, hash] = execFileSync(fixture, ['canonicalize', temp], { encoding: 'utf8' }).trim().split(/\r?\n/);
  const canonical = await auth.canonicalizeOriginalHome(temp);
  assert.equal(canonical, expected);
  assert.equal(createHash('sha256').update(canonical).digest('hex'), hash);
  if (process.platform === 'win32') assert.ok(canonical.startsWith('\\\\?\\'));
  await assert.rejects(auth.canonicalizeOriginalHome(join(temp, 'absent-home')), /canonicalization failed/);
  assert.equal(existsSync(join(temp, 'absent-home')), false);
});

test('same OS lock domain as donor-style independent fs2 process; timeout/cancel never unlink', async () => {
  const authPath = join(temp, 'auth.json');
  const lockPath = join(temp, 'auth.json.lock');
  const child = spawn(fixture, ['hold', lockPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    await once(child.stdout, 'data', { signal: AbortSignal.timeout(10_000) });
    assert.equal(auth.tryAcquireGrokAuthLock(authPath), null);
    await assert.rejects(auth.acquireGrokAuthLock(authPath, { timeoutMs: 80 }), { code: 'AUTH_LOCK_TIMEOUT' });
    const controller = new AbortController();
    const pending = auth.acquireGrokAuthLock(authPath, { timeoutMs: 10_000, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(existsSync(lockPath), true);
    child.stdin.end('\n');
    await exited;
    const guard = await auth.acquireGrokAuthLock(authPath, { timeoutMs: 1000 });
    assert.match(execFileSync(fixture, ['try', lockPath], { encoding: 'utf8' }), /LOCK_BUSY/);
    guard.release();
    guard.release();
    assert.match(readFileSync(lockPath, 'utf8'), new RegExp(`^${process.pid}:\\d+$`));
    assert.match(execFileSync(fixture, ['try', lockPath], { encoding: 'utf8' }), /LOCK_FREE/);
    assert.equal(existsSync(lockPath), true);
  } finally {
    if (child.exitCode === null) { child.kill(); await exited; }
  }
});

test('Kiki process exit releases lock, heartbeat advances while held, same-process contenders serialize', async () => {
  const dir = join(temp, 'exit'); mkdirSync(dir);
  const authPath = join(dir, 'auth.json');
  const lockPath = join(dir, 'auth.json.lock');
  const modulePath = resolve(__dirname, '../index.cjs');
  const script = `const a=require(process.argv[1]); global.guard=a.tryAcquireGrokAuthLock(process.argv[2]); console.log('READY'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', script, modulePath, authPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    await once(child.stdout, 'data', { signal: AbortSignal.timeout(10_000) });
    const startedAt = Math.floor(Date.now() / 1000);
    await delay(5300);
    assert.equal(auth.tryAcquireGrokAuthLock(authPath), null);
    child.kill(); await exited;
    const afterStamp = readFileSync(lockPath, 'utf8');
    assert.match(afterStamp, new RegExp(`^${child.pid}:\\d+$`));
    assert.ok(Number(afterStamp.split(':')[1]) >= startedAt + 4, '5s heartbeat must advance holder timestamp');
    const first = await auth.acquireGrokAuthLock(authPath, { timeoutMs: 1000 });
    const secondPromise = auth.acquireGrokAuthLock(authPath, { timeoutMs: 1000 });
    await delay(80);
    first.release();
    const second = await secondPromise;
    assert.equal(auth.tryAcquireGrokAuthLock(authPath), null);
    second.release();
  } finally {
    if (child.exitCode === null) { child.kill(); await exited; }
  }
});

test('guard isCurrent rejects a replaced held inode and reports held/released states', async () => {
  const dir = join(temp, 'identity'); mkdirSync(dir);
  const authPath = join(dir, 'auth.json');
  const lockPath = join(dir, 'auth.json.lock');
  const guard = await auth.acquireGrokAuthLock(authPath);
  try {
    assert.equal(guard.isCurrent(), true);
    renameSync(lockPath, join(dir, 'old.lock'));
    assert.equal(guard.isCurrent(), false);
    writeFileSync(lockPath, 'replacement');
    assert.equal(guard.isCurrent(), false);
    const replacement = await auth.acquireGrokAuthLock(authPath, { timeoutMs: 0 });
    assert.equal(replacement.isCurrent(), true);
    assert.equal(guard.isCurrent(), false);
    replacement.release();
    assert.equal(replacement.isCurrent(), false);
  } finally { guard.release(); }
  assert.equal(guard.isCurrent(), false);
});

test('invalid IO and invalid wait budget surface rather than reporting contention', async () => {
  assert.throws(() => auth.tryAcquireGrokAuthLock(join(temp, 'missing', 'auth.json')), /Auth advisory lock failed/);
  await assert.rejects(auth.acquireGrokAuthLock(join(temp, 'auth.json'), { timeoutMs: -1 }), RangeError);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(auth.acquireGrokAuthLock(join(temp, 'cancel.json'), { signal: controller.signal }), { name: 'AbortError' });
});
