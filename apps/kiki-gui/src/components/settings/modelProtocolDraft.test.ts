import { describe, expect, it } from 'vitest';

import type { CreateProviderRequest } from '@kiki/protocol';

import {
  alignProtocolChoices,
  protocolChoiceFrom,
  protocolCreateField,
  protocolPatchField,
  withModelProtocols,
} from './modelProtocolDraft';

describe('protocolChoiceFrom', () => {
  it('reads an absent or null stored value as inherit', () => {
    expect(protocolChoiceFrom(undefined)).toBe('inherit');
    expect(protocolChoiceFrom(null)).toBe('inherit');
  });

  it('keeps a stored format as its own choice', () => {
    expect(protocolChoiceFrom('anthropic')).toBe('anthropic');
    expect(protocolChoiceFrom('openai_responses')).toBe('openai_responses');
  });
});

describe('protocolPatchField', () => {
  it('omits the field when the choice did not move', () => {
    expect(protocolPatchField('inherit', 'inherit')).toEqual({});
    expect(protocolPatchField('anthropic', 'anthropic')).toEqual({});
  });

  it('encodes a return to the provider default as explicit null', () => {
    expect(protocolPatchField('inherit', 'anthropic')).toEqual({ protocol: null });
  });

  it('sends the chosen format when it changed', () => {
    expect(protocolPatchField('openai_responses', 'inherit')).toEqual({ protocol: 'openai_responses' });
    expect(protocolPatchField('google-genai', 'anthropic')).toEqual({ protocol: 'google-genai' });
  });
});

describe('protocolCreateField', () => {
  it('stores nothing for a model that follows its provider', () => {
    expect(protocolCreateField('inherit')).toEqual({});
  });

  it('stores the chosen format', () => {
    expect(protocolCreateField('anthropic')).toEqual({ protocol: 'anthropic' });
  });
});

describe('withModelProtocols', () => {
  const body: CreateProviderRequest = {
    id: 'edge',
    type: 'openai',
    models: [{ remote_id: 'vendor/a' }, { remote_id: 'vendor/b' }],
  };

  it('lays choices onto models by index and leaves inherit rows untouched', () => {
    expect(withModelProtocols(body, ['anthropic', 'inherit']).models).toEqual([
      { remote_id: 'vendor/a', protocol: 'anthropic' },
      { remote_id: 'vendor/b' },
    ]);
  });

  it('treats a missing choice as inherit', () => {
    expect(withModelProtocols(body, []).models).toEqual(body.models);
  });

  it('returns a model-less body unchanged', () => {
    const bare: CreateProviderRequest = { id: 'edge', type: 'openai' };
    expect(withModelProtocols(bare, ['anthropic'])).toBe(bare);
  });
});

describe('alignProtocolChoices', () => {
  it('truncates extra choices and pads missing ones with inherit', () => {
    expect(alignProtocolChoices(['anthropic', 'openai', 'inherit'], 2)).toEqual(['anthropic', 'openai']);
    expect(alignProtocolChoices(['anthropic'], 3)).toEqual(['anthropic', 'inherit', 'inherit']);
    expect(alignProtocolChoices(undefined, 2)).toEqual(['inherit', 'inherit']);
  });
});
