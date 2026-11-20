/// <reference types="node" />

/** Binary age v1 scrypt envelope; passphrase acquisition belongs to the caller. */
export function ageEncrypt(plaintext: Uint8Array, passphrase: string): Promise<Buffer>;
/** Decrypts an age scrypt envelope without interpreting the plaintext schema. */
export function ageDecrypt(ciphertext: Uint8Array, passphrase: string): Promise<Buffer>;

/** Generated age X25519 secret identity (`AGE-SECRET-KEY-1...`) and public recipient (`age1...`). */
export interface AgeX25519Keypair {
  readonly identity: string;
  readonly recipient: string;
}
/** Generates a new age X25519 device identity and public recipient pair. */
export function generateX25519Keypair(): AgeX25519Keypair;
/** Derives the public `age1...` recipient string from an `AGE-SECRET-KEY-1...` identity. */
export function recipientFromIdentity(identity: string): string;
/** Encrypts plaintext into a binary age v1 envelope readable by every listed X25519 recipient. */
export function encryptMultiRecipient(plaintext: Uint8Array, recipients: readonly string[]): Buffer;
/** Decrypts a binary age v1 X25519 envelope with the matching secret identity. */
export function decryptIdentity(ciphertext: Uint8Array, identity: string): Buffer;

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
