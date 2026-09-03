import { describe, expect, it } from 'vitest';

import { configResponseSchema, patchConfigRequestSchema } from '../rest/config';

describe('config REST protocol', () => {
  it('omits the retired telemetry patch field', () => {
    expect(patchConfigRequestSchema.parse({ telemetry: false })).toEqual({});
  });

  it('keeps accepting server patch fields not mirrored by the shared schema', () => {
    expect(patchConfigRequestSchema.safeParse({
      thread_communication: { enabled: true },
      replace_domains: ['thread_communication'],
    }).success).toBe(true);
  });

  it('omits the retired telemetry response field', () => {
    expect(configResponseSchema.parse({ providers: {}, telemetry: true })).toEqual({ providers: {} });
  });
});
