import { describe, expect, it } from 'vitest';

import {
  adhocEndpointInputSchema,
  adhocEndpointModelId,
  boundEndpointSchema,
  mergeEndpointInputs,
  normalizeEndpointLayer,
} from '../index';

describe('adhoc endpoint protocol', () => {
  it('keeps input layers partial and canonicalizes provider aliases', () => {
    expect(adhocEndpointInputSchema.parse({ provider_type: 'openai-responses' })).toEqual({ provider_type: 'openai_responses' });
    expect(adhocEndpointInputSchema.parse({ provider_type: 'anthropic' })).toEqual({ provider_type: 'anthropic' });
    expect(adhocEndpointInputSchema.parse({ model: 'solo' })).toEqual({ model: 'solo' });
    expect(adhocEndpointInputSchema.safeParse({ provider_type: 'custom' }).success).toBe(false);
    expect(adhocEndpointInputSchema.safeParse({ provider_type: 'kimi' }).success).toBe(false);
    expect(adhocEndpointInputSchema.safeParse({ provider_type: 'openai', secret_ref: 'hidden' }).success).toBe(false);
    expect(adhocEndpointInputSchema.safeParse({ capabilities: ['video_in', 'audio_in'] }).success).toBe(true);
    expect(adhocEndpointInputSchema.safeParse({ capabilities: ['unknown'] }).success).toBe(false);
    expect(adhocEndpointInputSchema.safeParse({ support_efforts: ['max'] }).success).toBe(false);
    expect(adhocEndpointInputSchema.safeParse({ api_key: 'one', api_key_env: 'TWO' }).success).toBe(false);
    expect(adhocEndpointInputSchema.safeParse({ max_context_size: 0 }).success).toBe(false);
    expect(adhocEndpointInputSchema.safeParse({ max_completion_tokens: 1.5 }).success).toBe(false);
    expect(adhocEndpointInputSchema.safeParse({ request_params: { nested: { value: true } } }).success).toBe(false);
  });

  it('extracts structured and flat layers without treating a model-only record as an endpoint', () => {
    expect(normalizeEndpointLayer({ model: 'unrelated-model' })).toBeUndefined();
    expect(normalizeEndpointLayer({ base_url: 'https://api.example.test/v1/', model: 'chat' })).toEqual({
      base_url: 'https://api.example.test/v1',
      model: 'chat',
    });
    expect(normalizeEndpointLayer({ endpoint: { provider_type: 'openai-legacy', base_url: 'https://api.example.test/v1', model: 'chat' } })).toEqual({
      provider_type: 'openai',
      base_url: 'https://api.example.test/v1',
      model: 'chat',
    });
    expect(() => normalizeEndpointLayer({ endpoint: { base_url: 'https://api.example.test/v1' }, model: 'chat' })).toThrowError(new Error('Invalid endpoint configuration'));
    expect(() => normalizeEndpointLayer({ base_url: 'https://api.example.test/v1', headers: { authorization: 'hidden' } })).toThrowError(new Error('Invalid endpoint configuration'));
  });

  it('rejects unsafe endpoint URLs while allowing direct and test targets', () => {
    for (const base_url of [
      'http://127.0.0.1:4311/v1',
      'http://router.local/v1',
      'http://model.example.test/v1',
      'https://127.0.0.1:4311/v1',
      'https://192.168.1.20/v1',
      'https://node.tailnet.ts.net/v1',
      'https://100.64.0.5/v1',
      'https://api.example.test/v1',
    ]) {
      expect(adhocEndpointInputSchema.safeParse({ base_url }).success).toBe(true);
    }
    for (const base_url of [
      'http://api.example.com/v1',
      'http://directConnectionHost/v1',
      'https://user:pass@example.test/v1',
      'https://api.example.test/v1?token=hidden',
      'https://api.example.test/v1#fragment',
      'http://169.254.169.254/latest',
      'https://[fe80::1]/latest',
      'http://[::ffff:169.254.169.254]/latest',
      'https://[fd00:ec2::254]/latest',
    ]) {
      expect(adhocEndpointInputSchema.safeParse({ base_url }).success).toBe(false);
    }
  });

  it('clears inherited credentials only when the normalized endpoint changes', () => {
    const base = adhocEndpointInputSchema.parse({ provider_type: 'openai-chat', base_url: 'https://api.example.test/v1/', model: 'first', api_key: 'ephemeral' });
    expect(mergeEndpointInputs(base, { provider_type: 'openai', base_url: 'https://api.example.test/v1', model: 'second' })).toEqual({
      provider_type: 'openai', base_url: 'https://api.example.test/v1', model: 'second', api_key: 'ephemeral',
    });
    expect(mergeEndpointInputs(base, { base_url: 'https://other.example.test/v1', model: 'second' })).toEqual({
      provider_type: 'openai', base_url: 'https://other.example.test/v1', model: 'second',
    });
    expect(mergeEndpointInputs(base, { base_url: 'https://other.example.test/v1', api_key_env: 'OPENAI_API_KEY' })).toEqual({
      provider_type: 'openai', base_url: 'https://other.example.test/v1', model: 'first', api_key_env: 'OPENAI_API_KEY',
    });
  });

  it('serializes a canonical bound endpoint with exact defaults', () => {
    expect(boundEndpointSchema.parse({ base_url: 'https://api.example.test/v1/', model: 'chat', credential: { kind: 'env', env: 'OPENAI_API_KEY' } })).toEqual({
      provider_type: 'openai',
      base_url: 'https://api.example.test/v1',
      model: 'chat',
      capabilities: ['tool_use', 'image_in', 'thinking'],
      support_efforts: ['low', 'medium', 'high', 'xhigh'],
      max_context_size: 131072,
      credential: { kind: 'env', env: 'OPENAI_API_KEY' },
    });
    expect(boundEndpointSchema.parse({ base_url: 'https://api.example.test/v1', model: 'chat', capabilities: ['tool_use'], credential: { kind: 'env', env: 'OPENAI_API_KEY' } })).not.toHaveProperty('support_efforts');
    expect(boundEndpointSchema.parse({ base_url: 'https://api.example.test/v1', model: 'chat', credential: { kind: 'env', env: 'OPENAI_API_KEY' } }).credential).toEqual({ kind: 'env', env: 'OPENAI_API_KEY' });
    expect(boundEndpointSchema.parse({ base_url: 'https://api.example.test/v1', model: 'chat', credential: { kind: 'ephemeral', secretRef: 'ref-1' } }).credential).toEqual({ kind: 'ephemeral', secretRef: 'ref-1' });
    expect(boundEndpointSchema.safeParse({ base_url: 'https://api.example.test/v1', model: 'chat' }).success).toBe(false);
    expect(boundEndpointSchema.safeParse({ base_url: 'https://api.example.test/v1', model: 'chat', provider_type: 'openai-chat', credential: { kind: 'env', env: 'OPENAI_API_KEY' } }).success).toBe(false);
    expect(boundEndpointSchema.safeParse({ base_url: 'https://api.example.test/v1', model: 'chat', api_key: 'hidden', credential: { kind: 'env', env: 'OPENAI_API_KEY' } }).success).toBe(false);
    expect(boundEndpointSchema.safeParse({ base_url: 'https://api.example.test/v1', model: 'chat', credential: { kind: 'ephemeral', secret_ref: 'hidden' } }).success).toBe(false);
  });

  it('builds a stable model id from the canonical endpoint URL', () => {
    expect(adhocEndpointModelId({ provider_type: 'openai_responses', base_url: 'https://API.example.test/v1///', model: 'chat' })).toBe('adhoc:openai_responses@https://api.example.test/v1#chat');
    expect(() => adhocEndpointModelId({ provider_type: 'custom', base_url: 'https://api.example.test/v1', model: 'chat' } as never)).toThrowError(new Error('Invalid endpoint configuration'));
  });
});
