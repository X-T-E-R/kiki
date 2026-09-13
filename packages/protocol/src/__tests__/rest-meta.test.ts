import { describe, expect, it } from 'vitest';

import { metaResponseSchema, type MetaResponse } from '../rest/meta';

describe('metaResponseSchema', () => {
  const sample = {
    server_version: '0.1.0',
    build_id: 'build-42',
    build_channel: 'beta',
    capabilities: {
      websocket: true,
      file_upload: true,
      fs_query: true,
      mcp: true,
      tasks: true,
      terminal: true,
      thread_communication: true,
    },
    server_id: '01HXYZABCDEFGHJKMNPQRSTVWX',
    started_at: '2026-06-04T10:30:00.000Z',
    open_in_apps: ['finder', 'vscode'] as const,
    dangerous_bypass_auth: false,
    external_delegation: { state: 'active' as const },
  };

  it('round-trips a well-formed payload', () => {
    const parsed: MetaResponse = metaResponseSchema.parse(sample);
    expect(parsed.server_version).toBe('0.1.0');
    expect(parsed.build_id).toBe('build-42');
    expect(parsed.build_channel).toBe('beta');
    expect(parsed.capabilities.websocket).toBe(true);
    expect(parsed.server_id).toBe('01HXYZABCDEFGHJKMNPQRSTVWX');
    expect(parsed.started_at).toBe('2026-06-04T10:30:00.000Z');
    expect(parsed.dangerous_bypass_auth).toBe(false);
    expect(parsed.external_delegation).toEqual({ state: 'active' });
  });

  it('accepts explicit disabled external delegation status', () => {
    const parsed = metaResponseSchema.parse({
      ...sample,
      external_delegation: {
        state: 'disabled',
        reason: 'workspace_drift',
        message: 'workspace binding changed',
      },
    });
    expect(parsed.external_delegation).toEqual({
      state: 'disabled',
      reason: 'workspace_drift',
      message: 'workspace binding changed',
    });
  });

  it('rejects unknown external delegation disable reasons', () => {
    expect(metaResponseSchema.safeParse({
      ...sample,
      external_delegation: {
        state: 'disabled',
        reason: 'unknown_failure',
      },
    }).success).toBe(false);
  });

  it('accepts an omitted terminal capability but rejects terminal = false', () => {
    const { terminal: _omit, ...capabilitiesWithoutTerminal } = sample.capabilities;
    const parsed = metaResponseSchema.parse({
      ...sample,
      capabilities: capabilitiesWithoutTerminal,
    });
    expect(parsed.capabilities.terminal).toBeUndefined();

    const bad = {
      ...sample,
      capabilities: { ...sample.capabilities, terminal: false },
    };
    expect(metaResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts an omitted thread_communication capability (old server) but rejects false', () => {
    const { thread_communication: _omit, ...capabilitiesWithoutThreadComm } = sample.capabilities;
    const parsed = metaResponseSchema.parse({
      ...sample,
      capabilities: capabilitiesWithoutThreadComm,
    });
    expect(parsed.capabilities.thread_communication).toBeUndefined();

    const bad = {
      ...sample,
      capabilities: { ...sample.capabilities, thread_communication: false },
    };
    expect(metaResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts an omitted transcript capability (old server) but rejects false', () => {
    const parsed = metaResponseSchema.parse(sample);
    expect(parsed.capabilities.transcript).toBeUndefined();

    const withTranscript = metaResponseSchema.parse({
      ...sample,
      capabilities: { ...sample.capabilities, transcript: true },
    });
    expect(withTranscript.capabilities.transcript).toBe(true);

    const bad = {
      ...sample,
      capabilities: { ...sample.capabilities, transcript: false },
    };
    expect(metaResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('normalizes started_at to UTC Z with millisecond precision', () => {
    const offsetForm = {
      ...sample,
      started_at: '2026-06-04T18:30:00+08:00',
    };
    const parsed = metaResponseSchema.parse(offsetForm);
    expect(parsed.started_at).toBe('2026-06-04T10:30:00.000Z');
  });

  it('rejects missing server_version', () => {
    const { server_version: _omit, ...rest } = sample;
    expect(metaResponseSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects missing capabilities', () => {
    const { capabilities: _omit, ...rest } = sample;
    expect(metaResponseSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects missing server_id', () => {
    const { server_id: _omit, ...rest } = sample;
    expect(metaResponseSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects missing started_at', () => {
    const { started_at: _omit, ...rest } = sample;
    expect(metaResponseSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects missing dangerous_bypass_auth', () => {
    const { dangerous_bypass_auth: _omit, ...rest } = sample;
    expect(metaResponseSchema.safeParse(rest).success).toBe(false);
  });

  it('accepts dangerous_bypass_auth = true', () => {
    const parsed = metaResponseSchema.parse({ ...sample, dangerous_bypass_auth: true });
    expect(parsed.dangerous_bypass_auth).toBe(true);
  });

  it('accepts backend = v2', () => {
    const parsed = metaResponseSchema.parse({ ...sample, backend: 'v2' });
    expect(parsed.backend).toBe('v2');
  });

  it('accepts a missing backend (treated as v1)', () => {
    const parsed = metaResponseSchema.parse(sample);
    expect(parsed.backend).toBeUndefined();
  });

  it('rejects an unknown backend value', () => {
    const bad = { ...sample, backend: 'v3' };
    expect(metaResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a capability set with the wrong boolean literal', () => {
    const bad = {
      ...sample,
      capabilities: { ...sample.capabilities, websocket: false },
    };
    expect(metaResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an empty server_version string', () => {
    const bad = { ...sample, server_version: '' };
    expect(metaResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a malformed started_at (no timezone marker)', () => {
    const bad = { ...sample, started_at: '2026-06-04T10:30:00' };
    expect(metaResponseSchema.safeParse(bad).success).toBe(false);
  });
});
