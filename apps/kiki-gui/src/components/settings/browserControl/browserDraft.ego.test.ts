import { describe, expect, it } from 'vitest';

import { browserConnectionInput, draftIssues, draftOf, parseBrowserInput } from './browserDraft';

describe('ego-lite connection draft', () => {
  it('writes CLI fields and no endpoint', () => {
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
});
