import { describe, expect, it } from 'vitest';

import {
  createWorkspaceRequestSchema,
  deleteWorkspaceResponseSchema,
  listWorkspaceCatalogResponseSchema,
  listWorkspacesResponseSchema,
  updateWorkspaceRequestSchema,
  workspaceIdParamSchema,
  workspaceViewQuerySchema,
} from '../rest/workspace';
import { workspaceIdSchema, workspaceSchema, type Workspace } from '../workspace';

const sampleWorkspace: Workspace = {
  id: 'wd_kimi-code_0123456789ab',
  root: '/Users/foo/code/kimi-code',
  name: 'kimi-code',
  created_at: '2026-06-08T09:00:00.000Z',
  last_opened_at: '2026-06-08T09:30:00.000Z',
  session_count: 3,
  pinned: false,
  isGit: true,
};

describe('workspace REST schemas', () => {
  it.each([
    ['standard id', 'wd_kimi_0123456789ab', true],
    ['slug with dots/dashes/underscores', 'wd_kimi-code.v2_0123456789ab', true],
    ['missing wd_ prefix', 'kimi_0123456789ab', false],
    ['non-hex tail', 'wd_kimi_xyzxyzxyzxyz', false],
    ['truncated hash', 'wd_kimi_0123456789', false],
  ] as const)('validates workspaceIdSchema (%s)', (_label, value, valid) => {
    expect(workspaceIdSchema.safeParse(value).success).toBe(valid);
  });

  it('validates workspaceSchema and workspaceIdParamSchema', () => {
    expect(workspaceSchema.parse(sampleWorkspace)).toEqual(sampleWorkspace);
    expect(workspaceSchema.safeParse({ ...sampleWorkspace, name: 'x'.repeat(101) }).success).toBe(false);
    expect(workspaceIdParamSchema.parse({ workspace_id: 'wd_kimi_0123456789ab' }).workspace_id)
      .toBe('wd_kimi_0123456789ab');
    expect(workspaceIdParamSchema.safeParse({ workspace_id: 'sess_abc' }).success).toBe(false);
  });

  it.each([
    ['root-only', { root: '/Users/foo/code' }, true],
    ['root + name', { root: '/Users/foo/code', name: 'Frontend Project' }, true],
    ['empty root', { root: '' }, false],
    ['missing root', {}, false],
    ['empty name', { root: '/Users/foo/code', name: '' }, false],
    ['name > 100 chars', { root: '/Users/foo/code', name: 'x'.repeat(101) }, false],
  ] as const)('validates createWorkspaceRequestSchema (%s)', (_label, payload, valid) => {
    const result = createWorkspaceRequestSchema.safeParse(payload);
    expect(result.success).toBe(valid);
    if (result.success) expect(result.data).toEqual(payload);
  });

  it.each([
    ['name patch', { name: 'Renamed' }, true],
    ['pinned true', { pinned: true }, true],
    ['pinned false', { pinned: false }, true],
    ['both fields', { name: 'Renamed', pinned: true }, true],
    ['empty body', {}, false],
    ['non-boolean pinned', { pinned: 'yes' }, false],
  ] as const)('validates updateWorkspaceRequestSchema (%s)', (_label, payload, valid) => {
    const result = updateWorkspaceRequestSchema.safeParse(payload);
    expect(result.success).toBe(valid);
    if (result.success) expect(result.data).toEqual(payload);
  });

  it('distinguishes full workspace lists from catalog metadata views', () => {
    expect(listWorkspacesResponseSchema.parse({ items: [] })).toEqual({ items: [] });
    expect(listWorkspacesResponseSchema.parse({ items: [sampleWorkspace] }).items[0]?.id).toBe(sampleWorkspace.id);
    const catalog = {
      id: sampleWorkspace.id,
      root: sampleWorkspace.root,
      name: sampleWorkspace.name,
      created_at: sampleWorkspace.created_at,
      last_opened_at: sampleWorkspace.last_opened_at,
      pinned: false,
    };
    expect(listWorkspaceCatalogResponseSchema.parse({ items: [catalog] })).toEqual({ items: [catalog] });
    expect(listWorkspacesResponseSchema.safeParse({ items: [catalog] }).success).toBe(false);
    expect(workspaceViewQuerySchema.parse({ view: 'catalog' })).toEqual({ view: 'catalog' });
    expect(workspaceViewQuerySchema.parse({})).toEqual({});
    expect(workspaceViewQuerySchema.safeParse({ view: 'unsupported' }).success).toBe(false);
  });

  it('requires deleted: true and rejects false success receipts', () => {
    expect(deleteWorkspaceResponseSchema.parse({ deleted: true })).toEqual({ deleted: true });
    expect(deleteWorkspaceResponseSchema.safeParse({ deleted: false }).success).toBe(false);
  });
});
