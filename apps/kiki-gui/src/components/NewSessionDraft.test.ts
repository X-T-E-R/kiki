import { describe, expect, it } from 'vitest';

import { buildAgentProfileOptions, resolveSelectedEffort } from './Composer';
import { isAbsoluteCwdPath } from './NewSessionDraft';
import type { NamedAgentProfile } from '../lib/client';

describe('isAbsoluteCwdPath', () => {
  it('accepts POSIX, Windows-drive, and UNC absolute paths', () => {
    expect(isAbsoluteCwdPath('/home/you/project')).toBe(true);
    expect(isAbsoluteCwdPath('/')).toBe(true);
    expect(isAbsoluteCwdPath('C:/work/project')).toBe(true);
    expect(isAbsoluteCwdPath('C:\\work\\project')).toBe(true);
    expect(isAbsoluteCwdPath('\\\\server\\share\\project')).toBe(true);
  });

  it('rejects relative paths, drive letters without a separator, and empties', () => {
    expect(isAbsoluteCwdPath('project')).toBe(false);
    expect(isAbsoluteCwdPath('./project')).toBe(false);
    expect(isAbsoluteCwdPath('~/project')).toBe(false);
    expect(isAbsoluteCwdPath('C:project')).toBe(false);
    expect(isAbsoluteCwdPath('')).toBe(false);
    expect(isAbsoluteCwdPath('  ')).toBe(false);
  });
});

describe('resolveSelectedEffort', () => {
  it('submits the same catalog default that the untouched select displays', () => {
    expect(resolveSelectedEffort(['low', 'medium', 'high'], undefined, 'medium')).toBe('medium');
  });

  it('falls back to the first visible option and preserves a supported explicit selection', () => {
    expect(resolveSelectedEffort(['low', 'high'], undefined, undefined)).toBe('low');
    expect(resolveSelectedEffort(['low', 'high'], 'high', 'low')).toBe('high');
    expect(resolveSelectedEffort(['low', 'high'], 'stale', 'missing')).toBe('low');
  });

  it('omits thinking when the effective model has no effort selector', () => {
    expect(resolveSelectedEffort(undefined, 'high', 'medium')).toBeUndefined();
    expect(resolveSelectedEffort([], 'high', 'medium')).toBeUndefined();
  });
});

describe('buildAgentProfileOptions', () => {
  const profile = (overrides: Partial<NamedAgentProfile>): NamedAgentProfile => ({
    name: 'agent',
    source: 'builtin',
    main: false,
    disabled: false,
    routes: [],
    ...overrides,
  });

  it('drops disabled subagent profiles but keeps a disabled main profile selectable', () => {
    const options = buildAgentProfileOptions(
      [
        profile({ name: 'agent', main: true, description: 'General-purpose.' }),
        profile({ name: 'reviewer', source: 'workspace' }),
        profile({ name: 'legacy', disabled: true }),
        // Turning a main profile off only stops subagent calls, so the
        // picker must keep offering it for main sessions.
        profile({ name: 'suspended-main', main: true, disabled: true }),
      ],
      ' · main',
    );
    expect(options.map((option) => option.value)).toEqual(['agent', 'reviewer', 'suspended-main']);
    expect(options[0]?.label).toBe('agent · main');
    expect(options[0]?.hint).toBe('General-purpose.');
    expect(options[1]?.label).toBe('reviewer');
    expect(options[2]?.label).toBe('suspended-main · main');
  });

  it('never promotes a private scoped subagent lease to a selectable profile', () => {
    // Dedicated subagents live only inside a parent profile's `subagents`
    // lease list — they are not public catalog entries, so even a parent
    // carrying a `scope: 'private'` lease yields no option for the child.
    const options = buildAgentProfileOptions(
      [
        profile({
          name: 'agent',
          main: true,
          subagents: [
            'reviewer',
            {
              name: 'writer',
              source: './_private/research/writer.md',
              scope: 'private',
              status: 'ready',
            },
          ],
        }),
      ],
      ' · main',
    );
    expect(options.map((option) => option.value)).toEqual(['agent']);
  });
});
