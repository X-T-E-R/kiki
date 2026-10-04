'use strict';

const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const native = require(path.join(__dirname, 'prebuilds', `${process.platform}-${process.arch}`, 'auth-native.node'));

exports.ageEncrypt = (bytes, passphrase) => native.ageEncrypt(Buffer.from(bytes), passphrase);
exports.ageDecrypt = (bytes, passphrase) => native.ageDecrypt(Buffer.from(bytes), passphrase);
exports.tryAcquireGrokAuthLock = native.tryAcquireGrokAuthLock;
exports.canonicalizeOriginalHome = native.canonicalizeOriginalHome;

exports.acquireGrokAuthLock = async (authJsonPath, { timeoutMs = 30_000, signal } = {}) => {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError('Auth lock timeoutMs must be finite and between 0 and 2147483647');
  }
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    const guard = native.tryAcquireGrokAuthLock(authJsonPath);
    if (guard !== null && guard !== undefined) {
      if (signal?.aborted) {
        guard.release();
        signal.throwIfAborted();
      }
      return guard;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      const error = new Error('Auth advisory lock acquisition timed out; holder left in place');
      error.code = 'AUTH_LOCK_TIMEOUT';
      throw error;
    }
    await delay(Math.min(50, remaining), undefined, { signal });
  }
};
