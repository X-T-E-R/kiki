import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import {
  Decrypter,
  Encrypter,
  generateX25519Identity,
  identityToRecipient,
} from 'age-encryption';
import {
  encryptedCredentialEnvelopeSchema,
  type EncryptedCredentialEnvelope,
} from '@kiki/protocol';
import { z } from 'zod';

import {
  effectiveCredentialSyncPolicy,
  isCredentialEligibleForEncryptedSync,
  type CredentialPoolEntry,
  type CredentialsPoolSection,
} from '#/app/config/credentialPool';

export interface AgeX25519Keypair {
  readonly identity: string;
  readonly recipient: string;
}

export interface AgeX25519Cipher {
  generateX25519Keypair(): Promise<AgeX25519Keypair> | AgeX25519Keypair;
  recipientFromIdentity(identity: string): Promise<string> | string;
  encryptMultiRecipient(plaintext: Uint8Array, recipients: readonly string[]): Promise<Buffer> | Buffer;
  decryptIdentity(ciphertext: Uint8Array, identity: string): Promise<Buffer> | Buffer;
}

const AGE_X25519_RECIPIENT_PATTERN = /^age1(?!pq1|tag1|tagpq1)[a-z0-9]+$/u;

const credentialPayloadSchema = z.object({
  version: z.literal(1),
  credentialId: z.string().min(1).max(128),
  kind: z.enum(['api_key', 'bearer_token', 'oauth', 'env_ref', 'keyring_ref']).optional(),
  apiKey: z.string().min(1).optional(),
  secret: z.string().min(1).optional(),
  label: z.string().max(128).optional(),
  updatedAt: z.string().datetime({ offset: true }),
  revision: z.string().min(1).max(128),
}).strict();

type CredentialEnvelopePayload = z.infer<typeof credentialPayloadSchema>;

let cachedNativeCipher: AgeX25519Cipher | undefined;

/** Creates a pure-JS `age-encryption` X25519 cipher wire-compatible with `@kiki/auth-native`. */
export function createJsAgeX25519Cipher(): AgeX25519Cipher {
  return {
    async generateX25519Keypair(): Promise<AgeX25519Keypair> {
      const identity = await generateX25519Identity();
      const recipient = await identityToRecipient(identity);
      return { identity, recipient };
    },
    async recipientFromIdentity(identity: string): Promise<string> {
      const trimmed = identity.trim();
      if (!trimmed.startsWith('AGE-SECRET-KEY-1')) {
        throw new Error('Invalid age X25519 identity');
      }
      return identityToRecipient(trimmed);
    },
    async encryptMultiRecipient(plaintext: Uint8Array, recipients: readonly string[]): Promise<Buffer> {
      if (recipients.length === 0) {
        throw new Error('At least one age X25519 recipient is required');
      }
      const encrypter = new Encrypter();
      for (const raw of recipients) {
        const trimmed = raw.trim();
        if (!AGE_X25519_RECIPIENT_PATTERN.test(trimmed)) {
          throw new Error('Invalid age X25519 recipient');
        }
        encrypter.addRecipient(trimmed);
      }
      return Buffer.from(await encrypter.encrypt(plaintext));
    },
    async decryptIdentity(ciphertext: Uint8Array, identity: string): Promise<Buffer> {
      const trimmed = identity.trim();
      if (!trimmed.startsWith('AGE-SECRET-KEY-1')) {
        throw new Error('Invalid age X25519 identity');
      }
      const decrypter = new Decrypter();
      decrypter.addIdentity(trimmed);
      return Buffer.from(await decrypter.decrypt(ciphertext));
    },
  };
}

function isAgeX25519Cipher(candidate: unknown): candidate is AgeX25519Cipher {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const cipher = candidate as Partial<AgeX25519Cipher>;
  return (
    typeof cipher.generateX25519Keypair === 'function' &&
    typeof cipher.recipientFromIdentity === 'function' &&
    typeof cipher.encryptMultiRecipient === 'function' &&
    typeof cipher.decryptIdentity === 'function'
  );
}

/** Loads `@kiki/auth-native` when available and automatically falls back to pure-JS `age-encryption`. */
export function loadNativeAgeX25519Cipher(
  moduleLoader?: (specifier: string) => unknown,
): AgeX25519Cipher {
  if (moduleLoader !== undefined) {
    try {
      const loaded = moduleLoader('@kiki/auth-native');
      if (isAgeX25519Cipher(loaded)) return loaded;
    } catch {
      return createJsAgeX25519Cipher();
    }
    return createJsAgeX25519Cipher();
  }
  if (cachedNativeCipher !== undefined) return cachedNativeCipher;
  const req = createRequire(import.meta.url);
  let loaded: unknown;
  try {
    const oauthEntry = req.resolve('@kiki/oauth');
    loaded = createRequire(oauthEntry)('@kiki/auth-native');
  } catch {
    try {
      loaded = req('@kiki/auth-native');
    } catch {
      loaded = undefined;
    }
  }
  cachedNativeCipher = isAgeX25519Cipher(loaded) ? loaded : createJsAgeX25519Cipher();
  return cachedNativeCipher;
}

/** Seals a single `sync_policy = "synced"` credential entry into an X25519 multi-recipient age envelope. */
export async function sealCredentialEntry(
  credentialId: string,
  entry: CredentialPoolEntry,
  recipients: readonly string[],
  cipher: AgeX25519Cipher = loadNativeAgeX25519Cipher(),
): Promise<EncryptedCredentialEnvelope> {
  if (!isCredentialEligibleForEncryptedSync(entry)) {
    throw new Error(
      `Credential '${credentialId}' has sync_policy='${effectiveCredentialSyncPolicy(entry)}' and cannot be sealed for cross-machine secret sync`,
    );
  }
  const uniqueRecipients = [...new Set(recipients.map((r) => r.trim()).filter((r) => r.length > 0))];
  if (uniqueRecipients.length === 0) {
    throw new Error('At least one X25519 recipient is required');
  }
  const updatedAt = entry.updatedAt ?? new Date().toISOString();
  const revision = entry.revision ?? randomUUID();
  const payload: CredentialEnvelopePayload = {
    version: 1,
    credentialId,
    ...(entry.kind === undefined ? {} : { kind: entry.kind }),
    ...(entry.apiKey === undefined ? {} : { apiKey: entry.apiKey }),
    ...(entry.secret === undefined ? {} : { secret: entry.secret }),
    ...(entry.label === undefined ? {} : { label: entry.label }),
    updatedAt,
    revision,
  };
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.from(await cipher.encryptMultiRecipient(plaintext, uniqueRecipients));
  return encryptedCredentialEnvelopeSchema.parse({
    format: 'kiki.credential-envelope.v1',
    credentialId,
    revision,
    updatedAt,
    recipients: uniqueRecipients,
    ciphertextBase64: ciphertext.toString('base64'),
  });
}

/** Seals all eligible `sync_policy = "synced"` entries from a credential pool section. */
export async function sealSyncedCredentialPool(
  pool: CredentialsPoolSection,
  recipients: readonly string[],
  options?: {
    readonly credentialIds?: readonly string[];
    readonly cipher?: AgeX25519Cipher;
  },
): Promise<{
  readonly envelopes: readonly EncryptedCredentialEnvelope[];
  readonly skipped: readonly { readonly credentialId: string; readonly reason: string }[];
}> {
  let cipher = options?.cipher;
  const filter = options?.credentialIds === undefined ? undefined : new Set(options.credentialIds);
  const envelopes: EncryptedCredentialEnvelope[] = [];
  const skipped: { readonly credentialId: string; readonly reason: string }[] = [];
  for (const [credentialId, entry] of Object.entries(pool)) {
    if (filter !== undefined && !filter.has(credentialId)) continue;
    if (!isCredentialEligibleForEncryptedSync(entry)) {
      skipped.push({
        credentialId,
        reason: `sync_policy=${effectiveCredentialSyncPolicy(entry)}`,
      });
      continue;
    }
    cipher ??= loadNativeAgeX25519Cipher();
    envelopes.push(await sealCredentialEntry(credentialId, entry, recipients, cipher));
  }
  return { envelopes, skipped };
}

/** Decrypts and validates a single per-entry X25519 credential envelope. */
export async function openCredentialEnvelope(
  envelope: EncryptedCredentialEnvelope,
  identity: string,
  cipher: AgeX25519Cipher = loadNativeAgeX25519Cipher(),
): Promise<{ readonly credentialId: string; readonly entry: CredentialPoolEntry }> {
  const parsedEnvelope = encryptedCredentialEnvelopeSchema.parse(envelope);
  const ciphertext = Buffer.from(parsedEnvelope.ciphertextBase64, 'base64');
  const plaintext = Buffer.from(await cipher.decryptIdentity(ciphertext, identity));
  const payload = credentialPayloadSchema.parse(JSON.parse(plaintext.toString('utf8')));
  if (payload.credentialId !== parsedEnvelope.credentialId) {
    throw new Error('Credential envelope ID mismatch');
  }
  if (payload.revision !== parsedEnvelope.revision || payload.updatedAt !== parsedEnvelope.updatedAt) {
    throw new Error('Credential envelope metadata mismatch');
  }
  return {
    credentialId: payload.credentialId,
    entry: {
      ...(payload.kind === undefined ? {} : { kind: payload.kind }),
      syncPolicy: 'synced',
      ...(payload.apiKey === undefined ? {} : { apiKey: payload.apiKey }),
      ...(payload.secret === undefined ? {} : { secret: payload.secret }),
      ...(payload.label === undefined ? {} : { label: payload.label }),
      updatedAt: payload.updatedAt,
      revision: payload.revision,
    },
  };
}

export interface CredentialEnvelopeMergeResult {
  readonly merged: CredentialsPoolSection;
  readonly applied: readonly string[];
  readonly skipped: readonly { readonly credentialId: string; readonly reason: string }[];
  readonly conflictIds: readonly string[];
}

export interface CredentialMergeReceipt {
  readonly appliedIds: readonly string[];
  readonly skippedIds: readonly { readonly credentialId: string; readonly reason: string }[];
  readonly conflictIds: readonly string[];
  readonly revision: string;
}

/** Projects a merge result into a secret-free HTTP receipt containing only IDs and revision metadata. */
export function sanitizeCredentialMergeReceipt(
  result: CredentialEnvelopeMergeResult,
  revision: string,
): CredentialMergeReceipt {
  return {
    appliedIds: [...result.applied],
    skippedIds: result.skipped.map((entry) => ({
      credentialId: entry.credentialId,
      reason: entry.reason,
    })),
    conflictIds: [...result.conflictIds],
    revision,
  };
}

function compareCredentialVersion(
  incoming: Pick<CredentialPoolEntry, 'updatedAt' | 'revision'>,
  current: Pick<CredentialPoolEntry, 'updatedAt' | 'revision'>,
): number {
  const inTime = incoming.updatedAt === undefined ? 0 : Date.parse(incoming.updatedAt);
  const curTime = current.updatedAt === undefined ? 0 : Date.parse(current.updatedAt);
  if (inTime !== curTime) return inTime - curTime;
  const inRev = incoming.revision ?? '';
  const curRev = current.revision ?? '';
  return inRev.localeCompare(curRev);
}

/** Conflict-free per-entry merge of incoming X25519 envelopes without clobbering machine-local or unrelated entries. */
export async function mergeCredentialEnvelopes(
  localPool: CredentialsPoolSection,
  envelopes: readonly EncryptedCredentialEnvelope[],
  identity: string,
  cipher?: AgeX25519Cipher,
  pinnedMachineIds?: ReadonlySet<string>,
): Promise<CredentialEnvelopeMergeResult> {
  const merged: Record<string, CredentialPoolEntry> = { ...localPool };
  const applied: string[] = [];
  const skipped: { readonly credentialId: string; readonly reason: string }[] = [];
  const conflictIds: string[] = [];
  let resolvedCipher = cipher;
  for (const envelope of envelopes) {
    if (pinnedMachineIds?.has(envelope.credentialId) === true) {
      skipped.push({ credentialId: envelope.credentialId, reason: 'local_machine_pinned' });
      conflictIds.push(envelope.credentialId);
      continue;
    }
    const existing = merged[envelope.credentialId];
    if (existing !== undefined && effectiveCredentialSyncPolicy(existing) === 'machine') {
      skipped.push({ credentialId: envelope.credentialId, reason: 'local_machine_pinned' });
      conflictIds.push(envelope.credentialId);
      continue;
    }
    let opened: { readonly credentialId: string; readonly entry: CredentialPoolEntry };
    try {
      resolvedCipher ??= loadNativeAgeX25519Cipher();
      opened = await openCredentialEnvelope(envelope, identity, resolvedCipher);
    } catch {
      skipped.push({ credentialId: envelope.credentialId, reason: 'decrypt_failed' });
      continue;
    }
    if (existing !== undefined && compareCredentialVersion(opened.entry, existing) <= 0) {
      skipped.push({ credentialId: opened.credentialId, reason: 'stale_or_equal' });
      continue;
    }
    merged[opened.credentialId] = opened.entry;
    applied.push(opened.credentialId);
  }
  return { merged, applied, skipped, conflictIds };
}
