import { describe, expect, it } from 'vitest';

import { browserIdSchema } from '../rest/browser';
import {
  browserSetupConnectInputSchema,
  browserSetupStatusSchema,
  codexBridgeBrowserIdSchema,
} from '../rest/browser-setup';

const hyphen = 'codex-browser-use-11111111-2222-4333-8444-555555555555';
const slash = 'codex-browser-use\\11111111-2222-4333-8444-555555555555';
const status = {
  preset: 'codex-browser' as const,
  displayName: 'Codex / ChatGPT browser extension',
  controlSurface: 'browser-connection' as const,
  state: 'needs_user_action' as const,
  supported: true,
  executionHost: 'test',
  steps: [{ id: 'detect', state: 'user_action' as const, reason: 'choose_connection' }],
  actions: [{ id: 'choose_connection' as const }],
  sourceUrl: 'https://github.com/DeliciousBuding/codex-browser-bridge',
};

describe('codex browser setup selection', () => {
  it('keeps connectionId as the Kiki id and carries both pipe forms on browserId', () => {
    expect(browserIdSchema.safeParse('codex-browser').success).toBe(true);
    expect(browserIdSchema.safeParse(slash).success).toBe(false);
    expect(browserIdSchema.safeParse(hyphen).success).toBe(true);
    expect(codexBridgeBrowserIdSchema.parse(hyphen)).toBe(hyphen);
    expect(codexBridgeBrowserIdSchema.parse(slash)).toBe(slash);
    expect(browserSetupConnectInputSchema.parse({})).toEqual({});
    expect(browserSetupConnectInputSchema.parse({ connectionId: 'codex-browser' })).toEqual({ connectionId: 'codex-browser' });
    expect(browserSetupConnectInputSchema.parse({ connectionId: 'codex-browser', browserId: slash, setDefault: true })).toEqual({
      connectionId: 'codex-browser', browserId: slash, setDefault: true,
    });
    expect(browserSetupConnectInputSchema.safeParse({ connectionId: slash }).success).toBe(false);
    expect(browserSetupConnectInputSchema.safeParse({ browserId: 'first-pipe' }).success).toBe(false);
  });

  it('projects candidates for Codex and still accepts a status that omits them', () => {
    expect(browserSetupStatusSchema.parse({ ...status, candidates: [{ browserId: hyphen }, { browserId: slash }] }).candidates).toEqual([
      { browserId: hyphen }, { browserId: slash },
    ]);
    expect(browserSetupStatusSchema.parse(status).candidates).toBeUndefined();
    expect(browserSetupStatusSchema.safeParse({ ...status, candidates: [{ browserId: 'first-pipe' }] }).success).toBe(false);
    expect(browserSetupStatusSchema.safeParse({ ...status, browserId: slash }).success).toBe(true);
    expect(browserSetupStatusSchema.safeParse({ ...status, connectionId: slash }).success).toBe(false);
  });
});
