import { describe, expect, it } from 'vitest';

import { browserConnectionInput, draftIssues, draftOf, parseBrowserInput } from './browserDraft';

describe('browserDraft connection inputs and validation', () => {
  it('writes ego-lite CLI fields with no endpoint and rejects relative cliPath', () => {
    const draft = draftOf({
      id: 'ego-lite', name: 'Ego Lite', enabled: true, type: 'ego-lite',
      cliPath: 'C:\\Ego\\ego-browser.exe', profileId: 'main', serverName: 'desk',
    });
    const input = parseBrowserInput(browserConnectionInput(draft));
    expect(input).toEqual({
      type: 'ego-lite', name: 'Ego Lite', enabled: true,
      cliPath: 'C:\\Ego\\ego-browser.exe', profileId: 'main', serverName: 'desk',
    });
    expect(input).not.toHaveProperty('endpoint');
    expect(input).not.toHaveProperty('driverPath');
    expect(draftIssues({ ...draft, cliPath: 'relative.exe' }, []).cliPath).toBe('st.browser.pathInvalid');
  });

  it('writes kimi-webbridge with no endpoint and never demands a CDP address', () => {
    const draft = draftOf({ id: 'kimi-webbridge', name: 'Daily Edge', enabled: true, type: 'kimi-webbridge' });
    const input = parseBrowserInput(browserConnectionInput(draft));
    expect(input).toEqual({ type: 'kimi-webbridge', name: 'Daily Edge', enabled: true, driverPath: undefined });
    expect(input).not.toHaveProperty('endpoint');
    expect(input).not.toHaveProperty('profilePath');
    expect(input).not.toHaveProperty('cliPath');
    expect(draftIssues(draft, ['kimi-webbridge'])).toEqual({});
  });

  it('keeps a stored managed-driver override and enforces absolute path validation', () => {
    const draft = draftOf({
      id: 'kimi-webbridge', name: 'Daily Edge', enabled: true, type: 'kimi-webbridge', driverPath: 'C:\\kiki\\bridge.exe',
    });
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
