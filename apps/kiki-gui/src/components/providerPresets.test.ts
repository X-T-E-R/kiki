import { describe, expect, it } from 'vitest';

import {
  baseUrlRequired,
  connectionFieldIssue,
  draftForPreset,
  presetById,
  providerIdFromBaseUrl,
  withBaseUrl,
} from './providerPresets';

describe('providerIdFromBaseUrl', () => {
  it('names a connection after the vendor in its host', () => {
    expect(providerIdFromBaseUrl('https://api.deepseek.com/v1')).toBe('deepseek');
    expect(providerIdFromBaseUrl('https://api.groq.com/openai/v1')).toBe('groq');
    expect(providerIdFromBaseUrl('https://gateway.example.co.uk/v1')).toBe('example');
    expect(providerIdFromBaseUrl('https://llm.my-corp.com.cn')).toBe('my-corp');
  });

  it('reuses a preset id when the host belongs to a known service', () => {
    expect(providerIdFromBaseUrl('https://api.moonshot.ai/v1')).toBe('moonshot');
    expect(providerIdFromBaseUrl('https://generativelanguage.googleapis.com')).toBe('gemini');
  });

  it('calls a loopback server "local"', () => {
    expect(providerIdFromBaseUrl('http://localhost:8080/v1')).toBe('local');
    expect(providerIdFromBaseUrl('http://127.0.0.1:1234')).toBe('local');
    // …unless the port matches a known local server.
    expect(providerIdFromBaseUrl('http://localhost:11434/v1')).toBe('ollama');
  });

  it('returns nothing for text that is not an absolute URL', () => {
    expect(providerIdFromBaseUrl('')).toBe('');
    expect(providerIdFromBaseUrl('api.deepseek.com')).toBe('');
    expect(providerIdFromBaseUrl('https://')).toBe('');
  });
});

describe('withBaseUrl', () => {
  it('fills an empty id and keeps following the address while untouched', () => {
    const blank = draftForPreset(null, 'openai');
    expect(blank.id).toBe('');
    const first = withBaseUrl(blank, 'https://api.deepseek.com/v1');
    expect(first.id).toBe('deepseek');
    expect(withBaseUrl(first, 'https://api.mistral.ai/v1').id).toBe('mistral');
  });

  it('never overwrites an id the user typed', () => {
    const named = { ...withBaseUrl(draftForPreset(null, 'openai'), 'https://api.deepseek.com/v1'), id: 'work-deepseek' };
    expect(withBaseUrl(named, 'https://api.mistral.ai/v1').id).toBe('work-deepseek');
  });

  it('clears a derived id when the address is cleared, so the empty-name hint can show', () => {
    const derived = withBaseUrl(draftForPreset(null, 'openai'), 'https://api.deepseek.com/v1');
    expect(withBaseUrl(derived, '').id).toBe('');
  });
});

describe('connectionFieldIssue', () => {
  const protocolDraft = draftForPreset(null, 'openai');

  it('puts a missing address on the Base URL field, before the name', () => {
    expect(connectionFieldIssue(protocolDraft, { requireBaseUrl: true }))
      .toEqual({ field: 'baseUrl', issue: { key: 'val.baseUrlRequired' } });
  });

  it('puts a malformed address on the Base URL field', () => {
    expect(connectionFieldIssue({ ...protocolDraft, id: 'x', baseUrl: 'not a url' })?.field).toBe('baseUrl');
    expect(connectionFieldIssue({ ...protocolDraft, id: 'x', baseUrl: 'ftp://host' })?.issue.key).toBe('val.baseUrlHttp');
  });

  it('asks for a name when the id is empty, and names the rule when it is malformed', () => {
    const withUrl = { ...protocolDraft, baseUrl: 'https://api.example.com/v1' };
    expect(connectionFieldIssue({ ...withUrl, id: '' })).toEqual({ field: 'id', issue: { key: 'val.providerIdEmpty' } });
    expect(connectionFieldIssue({ ...withUrl, id: '   ' })?.issue.key).toBe('val.providerIdEmpty');
    expect(connectionFieldIssue({ ...withUrl, id: '!bad' })).toEqual({ field: 'id', issue: { key: 'val.providerId' } });
  });

  it('passes a named connection with a valid address', () => {
    expect(connectionFieldIssue({ ...protocolDraft, id: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' }, { requireBaseUrl: true })).toBeNull();
  });

  it('passes a preset draft untouched: presets bring both the id and the address', () => {
    expect(connectionFieldIssue(draftForPreset(presetById('deepseek')!), { requireBaseUrl: true })).toBeNull();
  });
});

describe('baseUrlRequired', () => {
  it('only lets the Google adapters fall back to their own endpoint', () => {
    expect(baseUrlRequired('openai')).toBe(true);
    expect(baseUrlRequired('anthropic')).toBe(true);
    expect(baseUrlRequired('google-genai')).toBe(false);
    expect(baseUrlRequired('vertexai')).toBe(false);
  });
});
