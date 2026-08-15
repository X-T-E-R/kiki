import { describe, expect, it } from 'vitest';

import type { Session } from '@moonshot-ai/protocol';

import { composeWindowTitle, resolveWindowTitle } from './windowTitle';

const TEXT = {
  untitled: 'Untitled session',
  newSession: 'New session',
  settings: 'Settings',
  usage: 'Usage',
  capabilities: 'Capabilities',
};

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    workspace_id: 'wd_test',
    title: '',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    busy: false,
    metadata: { cwd: 'C:/tmp' },
    agent_config: { model: '' },
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_cost_usd: 0,
      context_tokens: 0,
      context_limit: 0,
      turn_count: 0,
    },
    permission_rules: [],
    message_count: 0,
    last_seq: 0,
    ...overrides,
  };
}

describe('composeWindowTitle', () => {
  it('joins a page label with the app name', () => {
    expect(composeWindowTitle('Settings')).toBe('Settings — Kiki');
  });

  it('falls back to the bare app name', () => {
    expect(composeWindowTitle(undefined)).toBe('Kiki');
    expect(composeWindowTitle('')).toBe('Kiki');
  });
});

describe('resolveWindowTitle', () => {
  it('titles a session route after the session record', () => {
    const sessions = [session('s1', { title: 'Refactor the renderer' })];
    expect(resolveWindowTitle({ kind: 'session', sessionId: 's1' }, sessions, TEXT)).toBe(
      'Refactor the renderer — Kiki',
    );
  });

  it('uses the last prompt, then the untitled label, for nameless sessions', () => {
    const prompted = [session('s1', { last_prompt: 'draw a persimmon' })];
    expect(resolveWindowTitle({ kind: 'session', sessionId: 's1' }, prompted, TEXT)).toBe(
      'draw a persimmon — Kiki',
    );
    const blank = [session('s2')];
    expect(resolveWindowTitle({ kind: 'session', sessionId: 's2' }, blank, TEXT)).toBe(
      'Untitled session — Kiki',
    );
  });

  it('degrades to the bare app name while the session list has no record yet', () => {
    expect(resolveWindowTitle({ kind: 'session', sessionId: 'gone' }, [], TEXT)).toBe('Kiki');
  });

  it('titles the /new, /settings, /usage, and /capabilities routes with their page names', () => {
    expect(resolveWindowTitle({ kind: 'new' }, [], TEXT)).toBe('New session — Kiki');
    expect(resolveWindowTitle({ kind: 'settings' }, [], TEXT)).toBe('Settings — Kiki');
    expect(resolveWindowTitle({ kind: 'usage' }, [], TEXT)).toBe('Usage — Kiki');
    expect(resolveWindowTitle({ kind: 'capabilities' }, [], TEXT)).toBe('Capabilities — Kiki');
    expect(resolveWindowTitle({ kind: 'other' }, [], TEXT)).toBe('Kiki');
  });
});
