import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeHandshakeProof,
  createMutualHandshakeChallenge,
  formatPairingUri,
  hmacSha256Hex,
  normalizePairingCode,
  normalizeTlsFingerprint,
  parsePairInput,
  parsePairingUri,
  sha256BytesHex,
  sha256Hex,
  upgradeEndpointForTlsPin,
} from '../pairing';

const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../test-vectors/pairing-handshake-v1.json'), 'utf8'),
);

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

describe('pairing-handshake-v1 RFC test vectors', () => {
  it('validates pairing code normalization and rejection vectors', () => {
    for (const item of vectors.pairingCodes.valid) {
      expect(normalizePairingCode(item.input)).toBe(item.normalized);
    }
    for (const invalid of vectors.pairingCodes.invalid) {
      expect(normalizePairingCode(invalid)).toBeUndefined();
    }
  });

  it('validates SPKI DER SHA-256 64-hex pin vectors', async () => {
    const computedPin = await sha256BytesHex(hexToBytes(vectors.spkiPin.spkiDerHex));
    expect(computedPin).toBe(vectors.spkiPin.spkiSha256Hex);
    for (const valid of vectors.spkiPin.validInputs) {
      expect(normalizeTlsFingerprint(valid)).toBe(vectors.spkiPin.spkiSha256Hex);
    }
    for (const invalid of vectors.spkiPin.invalidInputs) {
      expect(normalizeTlsFingerprint(invalid)).toBeUndefined();
    }
  });

  it('validates kiki://pair URIs and http -> https TLS pin upgrade vectors', () => {
    const lan = vectors.pairingUri.lanWithoutPin;
    expect(formatPairingUri({ endpoint: lan.endpoint, code: lan.code })).toBe(lan.uri);
    expect(parsePairingUri(lan.uri)).toEqual({ endpoint: lan.endpoint, code: lan.code });
    expect(upgradeEndpointForTlsPin(lan.endpoint, undefined)).toBe(lan.expectedUpgradedOrigin);

    const ts = vectors.pairingUri.tailscaleWithPinUpgrade;
    expect(formatPairingUri({ endpoint: ts.endpoint, code: ts.code, fingerprint: ts.fingerprint })).toBe(ts.uri);
    expect(parsePairingUri(ts.uri)).toEqual({
      endpoint: ts.endpoint,
      code: ts.code,
      fingerprint: ts.fingerprint,
    });
    expect(upgradeEndpointForTlsPin(ts.endpoint, ts.fingerprint)).toBe(ts.expectedUpgradedOrigin);

    const p80 = vectors.pairingUri.implicitPort80WithPinUpgrade;
    expect(upgradeEndpointForTlsPin(p80.endpoint, p80.fingerprint)).toBe(p80.expectedUpgradedOrigin);

    const pub = vectors.pairingUri.publicHttpsWithPin;
    expect(formatPairingUri({ endpoint: pub.endpoint, code: pub.code, fingerprint: pub.fingerprint })).toBe(pub.uri);
    expect(upgradeEndpointForTlsPin(pub.endpoint, pub.fingerprint)).toBe(pub.expectedUpgradedOrigin);
  });

  it('validates parsePairInput across pairing URI (with http->https fp upgrade), code, and target vectors', () => {
    for (const entry of vectors.parsePairInput) {
      const parsed = parsePairInput(entry.input);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.kind).toBe(entry.kind);
      if (parsed.kind === 'pair') {
        expect(parsed.origin).toBe(entry.origin);
        expect(parsed.endpoint).toBe(entry.endpoint);
        expect(parsed.entry).toBe(entry.entry);
        expect(parsed.code).toBe(entry.code);
        expect(parsed.fingerprint).toBe(entry.fingerprint);
      } else if (parsed.kind === 'code') {
        expect(parsed.code).toBe(entry.code);
      } else {
        expect(parsed.origin).toBe(entry.origin);
        expect(parsed.entry).toBe(entry.entry);
      }
    }
  });

  it('validates owner mutual HMAC-SHA256 handshake vectors (approved, revoked, inbound_disabled, negative)', async () => {
    const owner = vectors.ownerHandshake;
    expect(await sha256Hex(owner.peerToken)).toBe(owner.grantDigest);
    expect(await computeHandshakeProof(owner.peerToken, owner.nonce)).toBe(owner.reqProof);
    expect(await hmacSha256Hex(owner.grantDigest, owner.reqPreimage)).toBe(owner.reqProof);
    expect(await hmacSha256Hex(owner.grantDigest, owner.resPreimage)).toBe(owner.resProof);
    expect(await hmacSha256Hex(owner.grantDigest, owner.revokedPreimage)).toBe(owner.revokedProof);
    expect(await hmacSha256Hex(owner.grantDigest, owner.disabledPreimage)).toBe(owner.disabledProof);

    const challenge = await createMutualHandshakeChallenge({
      peerToken: owner.peerToken,
      grantId: owner.grantId,
      nonce: owner.nonce,
    });
    expect(challenge).toBeDefined();
    if (!challenge) return;
    expect(challenge.nonce).toBe(owner.nonce);
    expect(challenge.grantId).toBe(owner.grantId);
    expect(challenge.requestProof).toBe(owner.reqProof);

    expect(await challenge.verifyResponse(owner.resProof, owner.target.homeId, owner.target.hostId)).toBe(true);
    expect(await challenge.verifyRevokedResponse(owner.revokedProof, owner.target.homeId, owner.target.hostId)).toBe(true);
    expect(await challenge.verifyDisabledResponse(owner.disabledProof, owner.target.homeId, owner.target.hostId)).toBe(true);
    expect(await challenge.verifyStatusResponse('approved', owner.resProof, owner.target.homeId, owner.target.hostId)).toBe('approved');
    expect(await challenge.verifyStatusResponse('revoked', owner.revokedProof, owner.target.homeId, owner.target.hostId)).toBe('revoked');
    expect(await challenge.verifyStatusResponse('inbound_disabled', owner.disabledProof, owner.target.homeId, owner.target.hostId)).toBe('inbound_disabled');

    // Cross-domain & identity-tamper negative assertions
    expect(await challenge.verifyResponse(owner.revokedProof, owner.target.homeId, owner.target.hostId)).toBe(false);
    expect(await challenge.verifyInvitedResponse(owner.resProof, owner.target.homeId, owner.target.hostId)).toBe(false);
    expect(await challenge.verifyResponse(owner.resProof, owner.target.homeId, 'wrong-host')).toBe(false);
    expect(await challenge.verifyResponse(owner.resProof, '99999999-9999-4999-8999-999999999999', owner.target.hostId)).toBe(false);
  });

  it('validates invited-space kiki-handshake-invited-v1 mutual HMAC-SHA256 vectors', async () => {
    const invited = vectors.invitedHandshake;
    expect(await sha256Hex(invited.invitation)).toBe(invited.invitationDigest);
    expect(await computeHandshakeProof(invited.invitation, invited.nonce)).toBe(invited.reqProof);
    expect(await hmacSha256Hex(invited.invitationDigest, invited.invitedPreimage)).toBe(invited.invitedProof);

    const challenge = await createMutualHandshakeChallenge({
      peerToken: invited.invitation,
      grantId: invited.grantId,
      nonce: invited.nonce,
    });
    expect(challenge).toBeDefined();
    if (!challenge) return;
    expect(challenge.nonce).toBe(invited.nonce);
    expect(challenge.grantId).toBe(invited.grantId);
    expect(challenge.requestProof).toBe(invited.reqProof);

    expect(await challenge.verifyInvitedResponse(invited.invitedProof, invited.target.homeId, invited.target.hostId)).toBe(true);
    expect(await challenge.verifyStatusResponse('invited', invited.invitedProof, invited.target.homeId, invited.target.hostId)).toBe('invited');
    expect(await challenge.verifyStatusResponse(null, invited.invitedProof, invited.target.homeId, invited.target.hostId)).toBe('invited');
    expect(await challenge.verifyRevokedResponse(invited.revokedProof, invited.target.homeId, invited.target.hostId)).toBe(true);
    expect(await challenge.verifyDisabledResponse(invited.disabledProof, invited.target.homeId, invited.target.hostId)).toBe(true);

    // Invited proof must NEVER satisfy approved owner domain and vice-versa
    expect(await challenge.verifyResponse(invited.invitedProof, invited.target.homeId, invited.target.hostId)).toBe(false);
    expect(await challenge.verifyInvitedResponse(vectors.ownerHandshake.resProof, invited.target.homeId, invited.target.hostId)).toBe(false);
  });
});
