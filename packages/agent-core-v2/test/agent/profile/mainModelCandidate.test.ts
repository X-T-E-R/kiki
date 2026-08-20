import { describe, expect, it } from 'vitest';

import {
  resolveMainModelCandidate,
  resolveMainThinkingCandidate,
} from '#/agent/profile/mainModelCandidate';

describe('main bind candidate ladder', () => {
  it('prefers explicit input, then route lock, then profile alias, then default', () => {
    expect(
      resolveMainModelCandidate({
        inputModel: 'cli-model',
        routeLockedAlias: 'route-model',
        profileModelAlias: 'profile-model',
        defaultModel: 'default-model',
      }),
    ).toEqual({ alias: 'cli-model', source: 'input' });
    expect(
      resolveMainModelCandidate({
        routeLockedAlias: 'route-model',
        profileModelAlias: 'profile-model',
        defaultModel: 'default-model',
      }),
    ).toEqual({ alias: 'route-model', source: 'route' });
    expect(
      resolveMainModelCandidate({
        profileModelAlias: 'profile-model',
        defaultModel: 'default-model',
      }),
    ).toEqual({ alias: 'profile-model', source: 'profile' });
    expect(resolveMainModelCandidate({ defaultModel: 'default-model' })).toEqual({
      alias: 'default-model',
      source: 'default',
    });
    expect(resolveMainModelCandidate({})).toEqual({ alias: undefined, source: 'default' });
  });

  it('places profile thinking after the route lock and before session thinking', () => {
    expect(
      resolveMainThinkingCandidate({
        inputThinking: 'high',
        routeLockedThinking: 'max',
        modelProfileThinking: 'low',
        profileThinking: 'medium',
        sessionThinking: 'off',
      }),
    ).toBe('high');
    expect(
      resolveMainThinkingCandidate({
        routeLockedThinking: 'max',
        modelProfileThinking: 'low',
        profileThinking: 'medium',
        sessionThinking: 'off',
      }),
    ).toBe('max');
    expect(
      resolveMainThinkingCandidate({
        modelProfileThinking: 'low',
        profileThinking: 'medium',
        sessionThinking: 'off',
      }),
    ).toBe('low');
    expect(
      resolveMainThinkingCandidate({
        profileThinking: 'medium',
        sessionThinking: 'off',
      }),
    ).toBe('medium');
    expect(resolveMainThinkingCandidate({ sessionThinking: 'off' })).toBe('off');
  });
});
