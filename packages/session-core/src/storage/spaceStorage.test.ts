// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import { resetDraftMemoryForTests, flushDrafts, writeDraft } from '../composer/drafts';
import {
  resetAnnotationOverridesForTests,
  writeAnnotationOverride,
} from '../composer/timelineAnnotations';
import { markOnboardingCompleted, readOnboardingState } from '../settings/onboarding';
import { markSessionSeen, resetSessionSeen } from '../settings/sessionReadState';
import {
  clearRestartRequirement,
  readDesktopPrefs,
  readRestartRequirement,
  writeDesktopPrefs,
  writeLastSessionId,
  writeSettings,
} from '../settings/settings';
import {
  SPACE_STORAGE_PREFIX,
  activeSpace,
  configureSpaceStorage,
  spaceStorage,
  spaceStorageKey,
} from './spaceStorage';

function namespaced(homeId: string, key: string): string {
  return `${SPACE_STORAGE_PREFIX}${homeId}.${key}`;
}

afterEach(() => {
  configureSpaceStorage(null);
  resetDraftMemoryForTests();
  resetAnnotationOverridesForTests();
  resetSessionSeen();
  localStorage.clear();
});

describe('space storage namespacing', () => {
  it('keeps the original key names for the main space', () => {
    expect(spaceStorageKey('kiki.drafts')).toBe('kiki.drafts');
    expect(activeSpace()).toBeNull();
    spaceStorage.setItem('kiki.drafts', 'hello');
    expect(localStorage.getItem('kiki.drafts')).toBe('hello');
    expect(spaceStorage.getItem('kiki.drafts')).toBe('hello');
  });

  it('namespaces every key of a subspace and leaves the main space untouched', () => {
    configureSpaceStorage({ homeId: 'acme', name: 'ACME 机密' });
    expect(activeSpace()).toEqual({ homeId: 'acme', name: 'ACME 机密' });
    expect(spaceStorageKey('kiki.drafts')).toBe(namespaced('acme', 'kiki.drafts'));

    spaceStorage.setItem('kiki.drafts', 'secret text');
    expect(localStorage.getItem(namespaced('acme', 'kiki.drafts'))).toBe('secret text');
    expect(localStorage.getItem('kiki.drafts')).toBeNull();
    expect(spaceStorage.getItem('kiki.drafts')).toBe('secret text');

    spaceStorage.removeItem('kiki.drafts');
    expect(spaceStorage.getItem('kiki.drafts')).toBeNull();
  });

  it('does not namespace the main space when the entry marks it primary', () => {
    configureSpaceStorage({ homeId: 'main', isPrimary: true });
    expect(activeSpace()).toBeNull();
    expect(spaceStorageKey('kiki.drafts')).toBe('kiki.drafts');
  });

  it('treats an empty homeId as the main space', () => {
    configureSpaceStorage({ homeId: '' });
    expect(spaceStorageKey('kiki.skin')).toBe('kiki.skin');
  });

  it('namespaces every space independently', () => {
    configureSpaceStorage({ homeId: 'acme' });
    spaceStorage.setItem('kiki.lastSessionId', 'a-1');
    configureSpaceStorage({ homeId: 'beta' });
    spaceStorage.setItem('kiki.lastSessionId', 'b-1');
    expect(localStorage.getItem(namespaced('acme', 'kiki.lastSessionId'))).toBe('a-1');
    expect(localStorage.getItem(namespaced('beta', 'kiki.lastSessionId'))).toBe('b-1');
    expect(localStorage.getItem('kiki.lastSessionId')).toBeNull();
  });
});

describe('space-scoped keys of session-core go through the wrapper', () => {
  it('writes session-owned state into the active namespace', () => {
    configureSpaceStorage({ homeId: 'acme' });

    writeLastSessionId('session-1');
    markOnboardingCompleted();
    resetDraftMemoryForTests();
    writeDraft('session-1', 'unsent draft');
    flushDrafts();
    resetAnnotationOverridesForTests();
    writeAnnotationOverride('block-1', { comment: 'keep this', deleted: undefined });
    resetSessionSeen();
    markSessionSeen('session-1', 12);

    expect(localStorage.getItem(namespaced('acme', 'kiki.lastSessionId'))).toBe('session-1');
    expect(JSON.parse(localStorage.getItem(namespaced('acme', 'kiki.onboarding')) ?? '{}')).toMatchObject(
      { completedAt: expect.any(String) },
    );
    expect(localStorage.getItem(namespaced('acme', 'kiki.drafts'))).toContain('unsent draft');
    expect(localStorage.getItem(namespaced('acme', 'kiki.annotationOverrides'))).toContain('keep this');
    expect(localStorage.getItem(namespaced('acme', 'kiki.sessionSeen.v1'))).toContain('12');

    for (const key of [
      'kiki.lastSessionId',
      'kiki.onboarding',
      'kiki.drafts',
      'kiki.annotationOverrides',
      'kiki.sessionSeen.v1',
    ]) {
      expect(localStorage.getItem(key), `${key} must not be written in the main namespace`).toBeNull();
    }
  });

  it('does not leak one space state into another', () => {
    configureSpaceStorage({ homeId: 'acme' });
    writeLastSessionId('session-1');
    markOnboardingCompleted();
    clearRestartRequirement();
    resetSessionSeen();
    markSessionSeen('session-1', 12);

    configureSpaceStorage({ homeId: 'beta' });
    writeLastSessionId('session-2');

    expect(localStorage.getItem(namespaced('acme', 'kiki.lastSessionId'))).toBe('session-1');
    expect(localStorage.getItem(namespaced('beta', 'kiki.lastSessionId'))).toBe('session-2');
    // The storage of the other space is not even reachable under this prefix;
    // in-memory module caches are not consulted here because the app reloads
    // the whole window on a space switch instead of switching in place.
    for (const key of ['kiki.onboarding', 'kiki.restartRequired', 'kiki.sessionSeen.v1']) {
      expect(localStorage.getItem(namespaced('beta', key)), key).toBeNull();
    }
    expect(readOnboardingState().completedAt).toBeUndefined();
    expect(readRestartRequirement().required).toBe(false);

    configureSpaceStorage({ homeId: 'acme' });
    expect(readOnboardingState().completedAt).toEqual(expect.any(String));
  });

  it('keeps application-level preferences shared across spaces', () => {
    configureSpaceStorage({ homeId: 'acme' });
    writeSettings({});
    writeDesktopPrefs({ notifications: false });
    expect(readDesktopPrefs().notifications).toBe(false);

    expect(localStorage.getItem('kiki.settings')).not.toBeNull();
    expect(localStorage.getItem('kiki.desktopPrefs')).toContain('"notifications":false');
    expect(localStorage.getItem(namespaced('acme', 'kiki.settings'))).toBeNull();
    expect(localStorage.getItem(namespaced('acme', 'kiki.desktopPrefs'))).toBeNull();
  });
});
