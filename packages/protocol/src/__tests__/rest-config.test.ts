import { describe, expect, it } from 'vitest';

import { configResponseSchema, patchConfigRequestSchema } from '../rest/config';

describe('config REST protocol', () => {
  it('rejects the retired telemetry patch field', () => {
    expect(patchConfigRequestSchema.safeParse({ telemetry: false }).success).toBe(false);
  });

  it('omits the retired telemetry response field', () => {
    expect(configResponseSchema.parse({ providers: {}, telemetry: true })).toEqual({ providers: {} });
  });
});
