import { describe, expect, it } from 'vitest';

import { translate, type I18nKey } from '@kiki/session-core/i18n';

import { plainFailure } from './failureText';
import { capabilitySourceLabel } from './sourceLabel';

describe('plainFailure', () => {
  it('keeps a plain sentence as it is', () => {
    expect(plainFailure('Test runner exited with code 1.')).toBe('Test runner exited with code 1.');
  });

  it('never returns a raw JSON payload', () => {
    expect(plainFailure('{"error":{"type":"rate_limit","message":"Too many requests, retry in 20s"}}'))
      .toBe('Too many requests, retry in 20s');
    expect(plainFailure('Provider error: {"detail":"model not found"}')).toBe('model not found');
    expect(plainFailure('[{"code":"invalid_type","message":"Expected string"}]')).toBe('Expected string');
    // Nothing readable inside: say nothing rather than print braces.
    expect(plainFailure('{"code":500}')).toBeUndefined();
    expect(plainFailure('Upstream failed: {"code":500}')).toBe('Upstream failed');
  });

  it('drops stack frames and an Error: prefix', () => {
    expect(plainFailure('Error: socket hang up\n    at TLSSocket.onClose (node:_tls)\n')).toBe('socket hang up');
  });

  it('caps a long line', () => {
    const long = plainFailure('x'.repeat(400))!;
    expect(long.length).toBe(160);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('capabilitySourceLabel', () => {
  const t = (key: I18nKey, params?: Record<string, string | number>) => translate('en', key, params);

  it('labels extra roots as global and says so', () => {
    const label = capabilitySourceLabel(t, { source: 'extra', sourceRoot: 'C:/Research/Meta/Manuscript/skills' });
    expect(label).toEqual({ text: 'Global · extra', tone: 'global', title: 'From C:/Research/Meta/Manuscript/skills' });
  });

  it('maps skill and target vocabularies onto the same words', () => {
    expect(capabilitySourceLabel(t, { source: 'project' })?.text).toBe('Workspace');
    expect(capabilitySourceLabel(t, { source: 'workspace' })?.text).toBe('Workspace');
    expect(capabilitySourceLabel(t, { source: 'user' })?.text).toBe('Global');
    expect(capabilitySourceLabel(t, { source: 'builtin' })?.text).toBe('Built-in');
    expect(capabilitySourceLabel(t, { source: 'user', sourceKind: 'plugin' })?.text).toBe('Plugin');
    expect(capabilitySourceLabel(t, { scope: 'global' })?.text).toBe('Global');
    expect(capabilitySourceLabel(t, {})).toBeUndefined();
  });
});
