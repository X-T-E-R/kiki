import { describe, expect, it } from 'vitest';

import { browserConnectionInput, draftIssues, draftOf, parseBrowserInput } from './browserDraft';

describe('kimi-webbridge connection draft', () => {
  it('writes the bridge type with no endpoint, and never asks for one', () => {
    const draft = draftOf({ id: 'kimi-webbridge', name: 'Daily Edge', enabled: true, type: 'kimi-webbridge' });
    const input = parseBrowserInput(browserConnectionInput(draft));
    expect(input).toEqual({ type: 'kimi-webbridge', name: 'Daily Edge', enabled: true, driverPath: undefined });
    expect(input).not.toHaveProperty('endpoint');
    expect(input).not.toHaveProperty('profilePath');
    expect(input).not.toHaveProperty('cliPath');
    // The branch that would have demanded a CDP address asks for nothing here.
    expect(draftIssues(draft, ['kimi-webbridge'])).toEqual({});
  });

  it('keeps a stored managed-driver override and the shared path rule', () => {
    const draft = draftOf({ id: 'kimi-webbridge', name: 'Daily Edge', enabled: true, type: 'kimi-webbridge', driverPath: 'C:\\kiki\\bridge.exe' });
    expect(browserConnectionInput(draft)).toMatchObject({ type: 'kimi-webbridge', driverPath: 'C:\\kiki\\bridge.exe' });
    expect(draftIssues({ ...draft, driverPath: 'bridge.exe' }, []).driverPath).toBe('st.browser.pathInvalid');
  });

  it('writes webbridge-command strictly with name and enabled without endpoint or driverPath', () => {
    const draft = draftOf({ id: 'webbridge-command', name: 'Kimi Command Bridge', enabled: true, type: 'webbridge-command' });
    const input = parseBrowserInput(browserConnectionInput(draft));
    expect(input).toEqual({ type: 'webbridge-command', name: 'Kimi Command Bridge', enabled: true });
    expect(input).not.toHaveProperty('driverPath');
    expect(input).not.toHaveProperty('endpoint');
    expect(draftIssues(draft, ['webbridge-command'])).toEqual({});
  });
});
