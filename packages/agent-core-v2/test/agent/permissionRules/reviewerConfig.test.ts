import { describe, expect, it } from 'vitest';

import { splitConfigCredentials } from '#/app/config/credentials';
import {
  permissionFromToml,
  PermissionConfigSchema,
  permissionToToml,
} from '#/agent/permissionRules/configSection';
import { InteractionConfigSchema } from '#/agent/tools/ask-user-question/configSection';

describe('reviewer configuration', () => {
  it('round-trips nested snake_case settings and separates the Jev key', () => {
    const parsed = PermissionConfigSchema.parse(permissionFromToml({
      reviewer: {
        backend: 'jev', jev_consent: true, api_key: 'test-key', timeout_ms: 4200,
        allow_threshold: 0.92, deny_threshold: 0.91, categories: ['no_secret_egress'],
      },
    }));
    expect(parsed.reviewer).toMatchObject({ backend: 'jev', jevConsent: true, apiKey: 'test-key', timeoutMs: 4200 });
    const encoded = permissionToToml(parsed, {}) as Record<string, unknown>;
    const separated = splitConfigCredentials({ permission: encoded });
    expect(separated.config).toMatchObject({ permission: { reviewer: {
      backend: 'jev', jev_consent: true, timeout_ms: 4200,
    } } });
    expect(JSON.stringify(separated.config)).not.toContain('test-key');
    expect(separated.credentials).toMatchObject({ permission: { reviewer: { api_key: 'test-key' } } });
  });

  it('defaults question interactions to background', () => {
    expect(InteractionConfigSchema.parse({})).toEqual({ askUserQuestion: 'background' });
    expect(InteractionConfigSchema.parse({ askUserQuestion: 'blocking' })).toEqual({ askUserQuestion: 'blocking' });
  });
});
