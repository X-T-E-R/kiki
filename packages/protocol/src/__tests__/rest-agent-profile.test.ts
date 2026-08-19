import { describe, expect, it } from 'vitest';

import {
  listNamedAgentProfilesQuerySchema,
  namedAgentProfileSchema,
  patchConfigRequestSchema,
} from '../index';

describe('named agent profile REST protocol', () => {
  it('parses merged workspace applicability and the expanded-list query flag', () => {
    expect(listNamedAgentProfilesQuerySchema.parse({ expand: '1' })).toEqual({ expand: true });
    expect(namedAgentProfileSchema.parse({
      name: 'reviewer',
      source: 'user',
      workspace_id: 'wd_a',
      workspace_ids: ['wd_a', 'wd_b'],
      disabled: true,
      routes: [],
    })).toMatchObject({
      workspace_ids: ['wd_a', 'wd_b'],
      disabled: true,
    });
  });

  it('accepts the named-profile disable config patch', () => {
    expect(patchConfigRequestSchema.parse({
      disabled_named_profiles: ['reviewer'],
    })).toEqual({ disabled_named_profiles: ['reviewer'] });
  });
});
