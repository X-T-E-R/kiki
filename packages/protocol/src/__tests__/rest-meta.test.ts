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

  it('round-trips a well-formed payload and normalizes started_at to UTC Z', () => {
    const parsed: MetaResponse = metaResponseSchema.parse(sample);
    expect(parsed).toEqual(sample);
    expect(parsed.backend).toBeUndefined();
    expect(metaResponseSchema.parse({ ...sample, dangerous_bypass_auth: true }).dangerous_bypass_auth).toBe(true);
    expect(metaResponseSchema.parse({ ...sample, backend: 'v2' }).backend).toBe('v2');
    expect(metaResponseSchema.parse({ ...sample, started_at: '2026-06-04T18:30:00+08:00' }).started_at)
      .toBe('2026-06-04T10:30:00.000Z');
  });

  it('validates optional server_home_id and current_space_id without guessing for older servers', () => {
    expect(metaResponseSchema.parse(sample).server_home_id).toBeUndefined();
    expect(metaResponseSchema.parse(sample).current_space_id).toBeUndefined();
    const server_home_id = '46aca369-50e8-4fd3-9c45-606d084450ed';
    expect(metaResponseSchema.parse({ ...sample, server_home_id }).server_home_id).toBe(server_home_id);
    expect(metaResponseSchema.safeParse({ ...sample, server_home_id: '/home/user/.kiki' }).success).toBe(false);

    for (const current_space_id of ['main', 'h-acme']) {
      expect(metaResponseSchema.parse({ ...sample, current_space_id }).current_space_id).toBe(current_space_id);
    }
    for (const current_space_id of ['46aca369-50e8-4fd3-9c45-606d084450ed', '/home/user/.kiki', '', 'h-ACME']) {
      expect(metaResponseSchema.safeParse({ ...sample, current_space_id }).success).toBe(false);
    }
  });

  it('validates external_delegation and maintenance storage recovery metadata', () => {
    const disabled = {
      state: 'disabled' as const,
      reason: 'workspace_drift' as const,
      message: 'workspace binding changed',
    };
    expect(metaResponseSchema.parse({ ...sample, external_delegation: disabled }).external_delegation).toEqual(disabled);
    expect(
      metaResponseSchema.safeParse({ ...sample, external_delegation: { state: 'disabled', reason: 'unknown_failure' } }).success,
    ).toBe(false);

    const maintenance = metaResponseSchema.parse({
      ...sample,
      open_in_apps: [],
      storage_mode: 'maintenance',
      storage_status_path: '/api/storage',
      capabilities: { websocket: false, file_upload: false, fs_query: false, mcp: false, tasks: false, thread_communication: false },
    });
    expect(maintenance.storage_mode).toBe('maintenance');
    expect(maintenance.storage_status_path).toBe('/api/storage');
    expect(metaResponseSchema.parse(sample).storage_mode).toBeUndefined();
    expect(metaResponseSchema.parse({ ...sample, storage_mode: 'normal' }).storage_mode).toBe('normal');
    expect(metaResponseSchema.safeParse({ ...sample, storage_mode: 'unknown' }).success).toBe(false);
  });

  it.each(['terminal', 'thread_communication', 'transcript'] as const)(
    'accepts omitted or unavailable %s capability',
    (name) => {
      const capabilities = { ...sample.capabilities } as Record<string, boolean>;
      delete capabilities[name];
      expect(metaResponseSchema.parse({ ...sample, capabilities }).capabilities[name]).toBeUndefined();
      for (const available of [true, false]) {
        expect(metaResponseSchema.parse({ ...sample, capabilities: { ...capabilities, [name]: available } }).capabilities[name])
          .toBe(available);
      }
      expect(metaResponseSchema.safeParse({ ...sample, capabilities: { ...capabilities, [name]: 'false' } }).success).toBe(false);
    },
  );

  it.each([
    ['missing server_version', (({ server_version: _, ...rest }) => rest)(sample)],
    ['missing capabilities', (({ capabilities: _, ...rest }) => rest)(sample)],
    ['missing server_id', (({ server_id: _, ...rest }) => rest)(sample)],
    ['missing started_at', (({ started_at: _, ...rest }) => rest)(sample)],
    ['missing dangerous_bypass_auth', (({ dangerous_bypass_auth: _, ...rest }) => rest)(sample)],
    ['unknown backend v3', { ...sample, backend: 'v3' }],
    ['non-boolean capability', { ...sample, capabilities: { ...sample.capabilities, websocket: 'false' } }],
    ['empty server_version', { ...sample, server_version: '' }],
    ['started_at without timezone', { ...sample, started_at: '2026-06-04T10:30:00' }],
  ] as const)('rejects %s', (_label, payload) => {
    expect(metaResponseSchema.safeParse(payload).success).toBe(false);
  });
});
