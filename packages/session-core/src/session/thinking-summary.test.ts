import { describe, expect, it } from 'vitest';

import {
  extractThinkingSummary,
  formatThinkingDuration,
  sanitizeThinkingText,
} from './thinking-summary';

describe('thinking-summary', () => {
  it('strips empty HTML comments and placeholder-only [REDACTED] lines while keeping genuine text', () => {
    expect(sanitizeThinkingText('<!-- -->\n[REDACTED]\nReal reasoning line\n<!--   -->')).toBe(
      'Real reasoning line',
    );
    expect(sanitizeThinkingText('[REDACTED]\n<!-- -->')).toBe('');
  });

  it('prefers the latest complete bold or markdown heading while streaming and holds across partial lines', () => {
    const partial = '**Inspecting scrollback**\n\nChecking xterm.js\n**Comparing mouse';
    expect(extractThinkingSummary(partial, { streaming: true })).toBe('Inspecting scrollback');

    const withTrailingComment = '**Inspecting scrollback**\n<!--';
    expect(extractThinkingSummary(withTrailingComment, { streaming: true })).toBe(
      'Inspecting scrollback',
    );

    const completeSecond = '**Inspecting scrollback**\n\n**Comparing mouse protocols**\nNext detail';
    expect(extractThinkingSummary(completeSecond, { streaming: true })).toBe(
      'Comparing mouse protocols',
    );

    const mdHeading = '# Planning refactor\n\n## Updating renderer\nDetails';
    expect(extractThinkingSummary(mdHeading, { streaming: true })).toBe('Updating renderer');
  });

  it('falls back to clipped first display line on settle for unstructured CoT and returns undefined for withheld-only text', () => {
    expect(extractThinkingSummary('Let me check the grouping pipeline carefully.', { streaming: true })).toBeUndefined();
    expect(extractThinkingSummary('Let me check the grouping pipeline carefully.', { streaming: false })).toBe(
      'Let me check the grouping pipeline carefully.',
    );
    expect(extractThinkingSummary('[REDACTED]\n<!-- -->', { streaming: false })).toBeUndefined();
  });

  it('formats durations cleanly and omits invalid/undefined durations', () => {
    expect(formatThinkingDuration(undefined)).toBeUndefined();
    expect(formatThinkingDuration(-5)).toBeUndefined();
    expect(formatThinkingDuration(400)).toBe('<1s');
    expect(formatThinkingDuration(14_200)).toBe('14s');
    expect(formatThinkingDuration(72_000)).toBe('1m 12s');
  });
});
