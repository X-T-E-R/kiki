import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { installNativeModuleHook } from '../../../apps/kimi-code/src/native/module-hook';

installNativeModuleHook();
const auth = createRequire(import.meta.url)('@kiki/auth-native') as typeof import('../index');
const base = process.env['KIKI_CACHE_DIR'];
if (!base) throw new Error('Distribution fixture requires isolated cache');
mkdirSync(base, { recursive: true });
const dir = mkdtempSync(join(base, 'auth-fixture-'));
async function verify(): Promise<void> {
  try {
    if (process.env['KIKI_AUTH_NATIVE_IDENTITY_ONLY'] === '1') {
      const path = join(dir, 'auth.json');
      const lockPath = join(dir, 'auth.json.lock');
      const guard = await auth.acquireGrokAuthLock(path);
      try {
        assert.equal(guard.isCurrent(), true);
        renameSync(lockPath, join(dir, 'old.lock'));
        assert.equal(guard.isCurrent(), false);
        writeFileSync(lockPath, 'synthetic replacement');
        assert.equal(guard.isCurrent(), false);
        const replacement = await auth.acquireGrokAuthLock(path);
        assert.equal(replacement.isCurrent(), true);
        replacement.release();
        assert.equal(replacement.isCurrent(), false);
      } finally { guard.release(); }
      assert.equal(guard.isCurrent(), false);
      process.stdout.write('AUTH_DISTRIBUTION_OK: guard isCurrent held/replaced/released\n');
      return;
    }
    const plain = Buffer.from('ISOLATED_SYNTHETIC_AUTH');
    const passphrase = 'synthetic-distribution-passphrase';
    const encrypted = await auth.ageEncrypt(plain, passphrase);
    assert.deepEqual(await auth.ageDecrypt(encrypted, passphrase), plain);
    await assert.rejects(auth.ageDecrypt(encrypted, 'wrong-passphrase'), /Age decryption failed/);
    const canonical = await auth.canonicalizeOriginalHome(dir);
    if (process.platform === 'win32') assert.ok(canonical.startsWith('\\\\?\\'));
    const path = join(dir, 'auth.json');
    const first = await auth.acquireGrokAuthLock(path, { timeoutMs: 1000 });
    try {
      assert.equal(auth.tryAcquireGrokAuthLock(path), null);
      await assert.rejects(auth.acquireGrokAuthLock(path, { timeoutMs: 50 }), { code: 'AUTH_LOCK_TIMEOUT' });
      const controller = new AbortController();
      const waiting = auth.acquireGrokAuthLock(path, { signal: controller.signal });
      controller.abort();
      await assert.rejects(waiting, { name: 'AbortError' });
    } finally { first.release(); }
    first.release();
    const second = await auth.acquireGrokAuthLock(path, { timeoutMs: 0 });
    second.release();
    process.stdout.write('AUTH_DISTRIBUTION_OK: age/canonicalize/lock/timeout/cancel/release\n');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}
void verify().catch((error) => { console.error(error); process.exitCode = 1; });
