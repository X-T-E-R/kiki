import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

import type { PortableSpaceEncryption, PortableSpaceUnlock } from '@kiki/protocol';

import type { SyncService } from '../sync/syncService';
import { portableUnlockRequired } from './subscriptionErrors';

type RecipientRecord = { readonly recipient: string; readonly label?: string };
type AgeMode = 'x25519' | 'passphrase';
type NativeAge = {
  readonly ageEncrypt: (plaintext: Uint8Array, passphrase: string) => Promise<Uint8Array>;
  readonly ageDecrypt: (ciphertext: Uint8Array, passphrase: string) => Promise<Uint8Array>;
  readonly encryptMultiRecipient: (plaintext: Uint8Array, recipients: readonly string[]) => Uint8Array;
  readonly decryptIdentity: (ciphertext: Uint8Array, identity: string) => Uint8Array;
};

type AgeHeader = {
  readonly modes: ReadonlySet<AgeMode>;
};

const ARMOR_BEGIN = '-----BEGIN AGE ENCRYPTED FILE-----';
const ARMOR_END = '-----END AGE ENCRYPTED FILE-----';
const AGE_HEADER = 'age-encryption.org/v1';
const AGE_RECIPIENT_PATTERN = /^age1[a-z0-9]+$/u;
let nativeAge: NativeAge | undefined;

type DecodedAge = { bytes: Buffer; mode: 'x25519' } | { bytes: Buffer; mode: 'passphrase'; matchedPassphrase: string };

/** Decrypts a binary or armored age envelope using explicit, environment, or local unlock material. */
export async function decodeAge(
  bytes: Buffer,
  unlock: PortableSpaceUnlock | undefined,
  sync: SyncService,
  codecLoader: () => NativeAge = loadNativeAge,
  readOnly = false,
): Promise<DecodedAge> {
  const ciphertext = dearmorAge(bytes);
  const header = inspectAge(ciphertext);
  const native = codecLoader();
  const attempts: { readonly mode: AgeMode; readonly value: string }[] = [];
  const seenIdentities = new Set<string>();
  const seenPassphrases = new Set<string>();
  const addIdentities = async (value: string | undefined): Promise<void> => {
    if (value === undefined || !header.modes.has('x25519')) return;
    for (const identity of await resolveIdentityCandidates(value)) {
      if (seenIdentities.has(identity)) continue;
      seenIdentities.add(identity);
      attempts.push({ mode: 'x25519', value: identity });
    }
  };
  const addPassphrase = (value: string | undefined): void => {
    if (value === undefined || value.length === 0 || !header.modes.has('passphrase') || seenPassphrases.has(value)) return;
    seenPassphrases.add(value);
    attempts.push({ mode: 'passphrase', value });
  };
  await addIdentities(unlock?.identity);
  addPassphrase(unlock?.passphrase);
  await addIdentities(process.env['KIKI_AGE_KEY']);
  await addIdentities(process.env['KIKI_PACK_KEY']);
  addPassphrase(process.env['KIKI_PACK_KEY']);
  addPassphrase(effectivePassphrase());
  for (const attempt of attempts) {
    const plaintext = attempt.mode === 'x25519'
      ? await tryDecryptIdentity(native, ciphertext, attempt.value)
      : await tryDecryptPassphrase(native, ciphertext, attempt.value);
    if (plaintext !== undefined) return attempt.mode === 'passphrase' ? { bytes: plaintext, mode: attempt.mode, matchedPassphrase: attempt.value } : { bytes: plaintext, mode: attempt.mode };
  }
  if (header.modes.has('x25519')) {
    const keypair = readOnly
      ? await sync.readExistingDeviceKeypair().catch(() => undefined)
      : await sync.ensureDeviceKeypair().catch(() => undefined);
    const identity = keypair === undefined ? undefined : resolveInlineIdentity(keypair.identity);
    if (identity !== undefined && !seenIdentities.has(identity)) {
      const plaintext = await tryDecryptIdentity(native, ciphertext, identity);
      if (plaintext !== undefined) return { bytes: plaintext, mode: 'x25519' };
    }
  }
  if (header.modes.has('passphrase')) {
    throw portableUnlockRequired(
      attempts.some((attempt) => attempt.mode === 'passphrase')
        ? 'Incorrect passphrase for encrypted Portable Space archive'
        : 'Passphrase required to unlock encrypted Portable Space archive',
    );
  }
  throw portableUnlockRequired('Unable to decrypt portable age archive with available keys');
}

/** Resolves an explicit passphrase or the KIKI_AGE_PASSPHRASE / KIKI_SPACE_PASSPHRASE environment value. */
export function effectivePassphrase(passphrase?: string): string | undefined {
  if (passphrase !== undefined) return passphrase.length === 0 ? undefined : passphrase;
  const agePassphrase = process.env['KIKI_AGE_PASSPHRASE'];
  if (agePassphrase !== undefined && agePassphrase.length > 0) return agePassphrase;
  const environmentPassphrase = process.env['KIKI_SPACE_PASSPHRASE'];
  return environmentPassphrase === undefined || environmentPassphrase.length === 0 ? undefined : environmentPassphrase;
}

/** Encrypts bytes as a native binary age envelope using explicit recipients, the roster, or the local device. */
export async function encodeAge(
  bytes: Buffer,
  encryption: PortableSpaceEncryption | undefined,
  roster: string[],
  sync: SyncService,
  codecLoader: () => NativeAge = loadNativeAge,
): Promise<{ readonly bytes: Buffer; readonly mode: AgeMode; readonly recipients: string[] }> {
  const native = codecLoader();
  if (encryption?.mode === 'passphrase') {
    const passphrase = effectivePassphrase(encryption.passphrase);
    if (passphrase === undefined) {
      throw new Error('Portable age passphrase is required');
    }
    try {
      const encrypted = await native.ageEncrypt(bytes, passphrase);
      return { bytes: Buffer.from(encrypted), mode: 'passphrase', recipients: [] };
    } catch {
      throw new Error('Unable to encrypt portable age archive');
    }
  }
  const configured = encryption?.mode === 'x25519' ? encryption.recipients ?? [] : [];
  const explicit = normalizeRecipients(configured);
  const known = explicit.length > 0 ? explicit : normalizeRecipients(roster);
  const recipients = known.length > 0 ? known : [
    (await sync.ensureDeviceKeypair()).recipient,
  ];
  const normalized = normalizeRecipients(recipients);
  if (normalized.length === 0) {
    throw new Error('Portable age recipient is required');
  }
  try {
    const encrypted = native.encryptMultiRecipient(bytes, normalized);
    return { bytes: Buffer.from(encrypted), mode: 'x25519', recipients: normalized };
  } catch {
    throw new Error('Unable to encrypt portable age archive');
  }
}

/** Parses bare, labelled, comma-separated, or comment-annotated age recipients. */
export function parseRecipients(text: string): RecipientRecord[] {
  if (typeof text !== 'string') {
    throw new TypeError('Invalid portable age recipient list');
  }
  const parsed: RecipientRecord[] = [];
  const seen = new Set<string>();
  let precedingLabel: string | undefined;
  for (const raw of text.split(/[\r\n,]+/u)) {
    let line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#')) {
      const label = line.slice(1).trim();
      precedingLabel = label.length === 0 ? undefined : label;
      continue;
    }
    let label: string | undefined;
    const trailingComment = /^(age1[a-z0-9]+)\s+#\s*(.+)$/u.exec(line);
    if (trailingComment !== null) {
      line = trailingComment[1]!;
      label = trailingComment[2]!.trim();
    } else {
      const angle = /^(.+?)\s*<\s*(age1[a-z0-9]+)\s*>$/u.exec(line);
      const colon = /^(.+?)\s*:\s*(age1[a-z0-9]+)$/u.exec(line);
      if (angle !== null) {
        label = angle[1]!.trim();
        line = angle[2]!;
      } else if (colon !== null) {
        label = colon[1]!.trim();
        line = colon[2]!;
      }
    }
    if (!AGE_RECIPIENT_PATTERN.test(line)) {
      throw new TypeError('Invalid portable age recipient list');
    }
    const resolvedLabel = label ?? precedingLabel;
    precedingLabel = undefined;
    if (resolvedLabel !== undefined && !validLabel(resolvedLabel)) {
      throw new TypeError('Invalid portable age recipient list');
    }
    if (seen.has(line)) continue;
    seen.add(line);
    parsed.push(resolvedLabel === undefined ? { recipient: line } : { recipient: line, label: resolvedLabel });
  }
  return parsed;
}

/** Formats age recipients into a stable newline-separated list accepted by parseRecipients. */
export function formatRecipients(recipients: readonly (RecipientRecord | string)[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const item of recipients) {
    const record = typeof item === 'string' ? { recipient: item } : item;
    const recipient = record.recipient.trim();
    if (!AGE_RECIPIENT_PATTERN.test(recipient) || (record.label !== undefined && !validLabel(record.label))) {
      throw new TypeError('Invalid portable age recipient list');
    }
    if (seen.has(recipient)) continue;
    seen.add(recipient);
    if (record.label === undefined || record.label.trim().length === 0) {
      lines.push(recipient);
    } else {
      lines.push(`# ${record.label.trim()}`, recipient);
    }
  }
  return lines.join('\n');
}

async function resolveIdentityCandidates(value: string): Promise<string[]> {
  const inline = extractIdentities(value);
  if (inline.length > 0) return inline;
  const path = value.trim();
  if (path.length === 0) return [];
  try {
    return extractIdentities(await readFile(path, 'utf8'));
  } catch {
    return [];
  }
}

function resolveInlineIdentity(value: string): string | undefined {
  return extractIdentities(value)[0];
}

function extractIdentities(value: string): string[] {
  const identities: string[] = [];
  const seen = new Set<string>();
  for (const raw of value.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    const line = raw.trim();
    if (!/^AGE-SECRET-KEY-1[A-Z0-9]+$/u.test(line) || seen.has(line)) continue;
    seen.add(line);
    identities.push(line);
  }
  return identities;
}

async function tryDecryptIdentity(native: NativeAge, ciphertext: Buffer, identity: string): Promise<Buffer | undefined> {
  try {
    const plaintext = native.decryptIdentity(ciphertext, identity);
    return plaintext instanceof Uint8Array ? Buffer.from(plaintext) : undefined;
  } catch {
    return undefined;
  }
}

async function tryDecryptPassphrase(native: NativeAge, ciphertext: Buffer, passphrase: string): Promise<Buffer | undefined> {
  try {
    const plaintext = await native.ageDecrypt(ciphertext, passphrase);
    return plaintext instanceof Uint8Array ? Buffer.from(plaintext) : undefined;
  } catch {
    return undefined;
  }
}

function loadNativeAge(): NativeAge {
  if (nativeAge !== undefined) return nativeAge;
  const req = createRequire(import.meta.url);
  let loaded: unknown;
  try {
    const oauthEntry = req.resolve('@kiki/oauth');
    loaded = createRequire(oauthEntry)('@kiki/auth-native');
  } catch {
    try {
      loaded = req('@kiki/auth-native');
    } catch {
      throw new TypeError('Portable age codec is unavailable');
    }
  }
  const candidate = loaded as Partial<NativeAge>;
  if (
    typeof candidate.ageEncrypt !== 'function' ||
    typeof candidate.ageDecrypt !== 'function' ||
    typeof candidate.encryptMultiRecipient !== 'function' ||
    typeof candidate.decryptIdentity !== 'function'
  ) {
    throw new TypeError('Portable age codec is unavailable');
  }
  nativeAge = candidate as NativeAge;
  return nativeAge;
}

function normalizeRecipients(values: readonly string[]): string[] {
  return parseRecipients(values.join('\n')).map((entry) => entry.recipient);
}

function validLabel(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !/[<>\r\n]/u.test(value);
}

function dearmorAge(bytes: Buffer): Buffer {
  if (!Buffer.isBuffer(bytes)) {
    throw new TypeError('Invalid portable age archive');
  }
  const prefix = bytes.subarray(0, ARMOR_BEGIN.length).toString('ascii');
  if (prefix !== ARMOR_BEGIN) return bytes;
  let text: string;
  try {
    text = new TextDecoder('ascii', { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError('Invalid portable age archive');
  }
  const lines = text.split(/\r?\n/u);
  if (lines[0] !== ARMOR_BEGIN) {
    throw new TypeError('Invalid portable age archive');
  }
  const end = lines.indexOf(ARMOR_END, 1);
  if (end < 0 || lines.slice(end + 1).some((line) => line.trim().length > 0)) {
    throw new TypeError('Invalid portable age archive');
  }
  const body = lines.slice(1, end).join('');
  if (body.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(body) || body.length % 4 !== 0) {
    throw new TypeError('Invalid portable age archive');
  }
  return Buffer.from(body, 'base64');
}

function inspectAge(bytes: Buffer): AgeHeader {
  const firstLine = Buffer.from(`${AGE_HEADER}\n`, 'ascii');
  if (bytes.byteLength <= firstLine.byteLength || !bytes.subarray(0, firstLine.byteLength).equals(firstLine)) {
    throw new TypeError('Invalid portable age archive');
  }
  const footerStart = bytes.indexOf(Buffer.from('\n--- ', 'ascii'), firstLine.byteLength);
  if (footerStart < 0) {
    throw new TypeError('Invalid portable age archive');
  }
  const modes = new Set<AgeMode>();
  for (const line of bytes.subarray(firstLine.length, footerStart).toString('ascii').split('\n')) {
    if (line.startsWith('-> X25519 ')) modes.add('x25519');
    else if (line.startsWith('-> scrypt ')) modes.add('passphrase');
  }
  if (modes.size === 0) {
    throw new Error('Unsupported portable age recipient stanza');
  }
  return { modes };
}
