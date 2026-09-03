import { describe, expect, it } from 'vitest';

import type { AgentModelProfile } from '#/agentProfile';
import {
  applyMatchedModelProfilePrompt,
  applyModelProfilePromptDelta,
  declaresModelProfilePrompt,
  resolveModelProfileEntry,
} from '#/modelProfileOverlay';

const ENTRIES: readonly AgentModelProfile[] = [
  {
    alias: 'mock-model',
    when: 'When matching the live alias.',
    promptMode: 'prepend',
    prompt: 'ROLE DELTA',
  },
  {
    alias: 'other-model',
    when: 'When wrapping.',
    promptMode: 'wrap',
    prompt: 'BEFORE\n${parent_prompt}\nAFTER',
  },
  {
    alias: 'ghost-model',
    when: 'Missing from the live catalog.',
    promptMode: 'append',
    prompt: 'SHOULD NOT APPLY',
  },
];

function resolveId(id: string): string | undefined {
  if (id === 'mock-model' || id === 'test-provider/mock-model') return 'test-provider/mock-model';
  if (id === 'other-model') return 'other-model';
  return undefined;
}

describe('model profile overlay matching and prompt composition', () => {
  it('matches by canonical alias and skips catalog-missing entries', () => {
    expect(resolveModelProfileEntry(ENTRIES, 'mock-model', resolveId)?.alias).toBe('mock-model');
    expect(resolveModelProfileEntry(ENTRIES, 'test-provider/mock-model', resolveId)?.alias).toBe(
      'mock-model',
    );
    expect(resolveModelProfileEntry(ENTRIES, 'ghost-model', resolveId)).toBeUndefined();
  });

  it('prepends, appends, and wraps without injecting when text', () => {
    expect(applyModelProfilePromptDelta('BODY', ENTRIES[0])).toBe('ROLE DELTA\n\nBODY');
    expect(applyModelProfilePromptDelta('BODY', ENTRIES[1])).toBe('BEFORE\nBODY\nAFTER');
    expect(applyModelProfilePromptDelta('BODY', undefined)).toBe('BODY');
    expect(applyMatchedModelProfilePrompt('BODY', ENTRIES, 'mock-model', resolveId)).toBe(
      'ROLE DELTA\n\nBODY',
    );
    expect(applyMatchedModelProfilePrompt('BODY', ENTRIES, 'ghost-model', resolveId)).toBe('BODY');
    expect(declaresModelProfilePrompt(ENTRIES, 'mock-model', resolveId)).toBe(true);
    expect(declaresModelProfilePrompt(ENTRIES, 'ghost-model', resolveId)).toBe(false);
  });

  it('matches the first of two entries that share an alias', () => {
    const dup: readonly AgentModelProfile[] = [
      {
        alias: 'mock-model',
        when: 'First overlay.',
        promptMode: 'prepend',
        prompt: 'FIRST',
      },
      {
        alias: 'mock-model',
        when: 'Second overlay.',
        promptMode: 'prepend',
        prompt: 'SECOND',
      },
    ];
    expect(resolveModelProfileEntry(dup, 'mock-model', resolveId)?.prompt).toBe('FIRST');
    expect(applyMatchedModelProfilePrompt('BODY', dup, 'mock-model', resolveId)).toBe('FIRST\n\nBODY');
  });
});
