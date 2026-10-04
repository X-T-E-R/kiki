/// <reference types="node" />

/** Binary age v1 scrypt envelope; passphrase acquisition belongs to the caller. */
export function ageEncrypt(plaintext: Uint8Array, passphrase: string): Promise<Buffer>;
/** Decrypts an age scrypt envelope without interpreting the plaintext schema. */
export function ageDecrypt(ciphertext: Uint8Array, passphrase: string): Promise<Buffer>;

/** Rust std::fs::canonicalize + to_string_lossy, including Windows namespace prefix. Never creates a path. */
export function canonicalizeOriginalHome(path: string): Promise<string>;

export interface GrokAuthLock {
  /** Checks held file identity against the current path; false if replaced, gone or released; throws other I/O errors. */
  isCurrent(): boolean;
  /** Stops the heartbeat and releases the OS advisory lock. Idempotent; never unlinks. */
  release(): void;
}
export interface GrokAuthLockOptions {
  /** Default 30000; 0 tries once without waiting. */
  timeoutMs?: number;
  /** Cancels acquisition, not a guard already returned to the caller. */
  signal?: AbortSignal;
}
/** Locks the sibling auth.json.lock, matching Grok's fs2 OS advisory lock domain. */
export function tryAcquireGrokAuthLock(authJsonPath: string): GrokAuthLock | null;
/** Rejects with code AUTH_LOCK_TIMEOUT or an AbortError; never breaks a held lock. */
export function acquireGrokAuthLock(authJsonPath: string, options?: GrokAuthLockOptions): Promise<GrokAuthLock>;
