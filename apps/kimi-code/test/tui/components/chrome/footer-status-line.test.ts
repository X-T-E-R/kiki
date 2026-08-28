import { describe, expect, it } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import type { AppState } from '#/tui/types';

const baseState: AppState = {
  version: '1.2.3',
  workDir: '/tmp/project',
  additionalDirs: [],
  sessionId: 'ses-1',
  sessionTitle: null,
  model: 'kimi-k2',
  permissionMode: 'manual',
  thinkingEffort: 'off',
  contextUsage: 0,
  contextTokens: 0,
  maxContextTokens: 0,
  isCompacting: false,
  isReplaying: false,
  streamingPhase: 'idle',
  streamingStartTime: 0,
  stepRetry: null,
  planMode: false,
  inputMode: 'prompt',
  swarmMode: false,
  theme: 'dark',
  editorCommand: null,
  notifications: { enabled: true, condition: 'unfocused' },
  upgrade: { autoInstall: true },
  availableModels: {},
  availableProviders: {},
  mcpServersSummary: null,
};

function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('FooterComponent status_line items', () => {
  it('renders only the chosen slots in the given order', () => {
    const state: AppState = {
      ...baseState,
      statusLine: { items: ['cwd', 'model'], command: null },
    };
    const footer = new FooterComponent(state);

    const line1 = plain(footer.render(120)[0]!);
    const cwdAt = line1.indexOf('/tmp/project');
    const modelAt = line1.indexOf('kimi-k2');
    expect(cwdAt).toBeGreaterThanOrEqual(0);
    expect(modelAt).toBeGreaterThan(cwdAt);
    expect(line1).not.toContain('goal');
  });

  it('keeps the default layout when statusLine is unset', () => {
    const footer = new FooterComponent({ ...baseState });

    const line1 = plain(footer.render(120)[0]!);
    expect(line1).toContain('kimi-k2');
    expect(line1).toContain('/tmp/project');
  });

  it('drops the rotating tips when tips is not in items', () => {
    const withTips = plain(new FooterComponent(baseState).render(200)[0]!);
    const state: AppState = {
      ...baseState,
      statusLine: { items: ['model', 'cwd'], command: null },
    };
    const withoutTips = plain(new FooterComponent(state).render(200)[0]!);

    expect(withoutTips.length).toBeLessThan(withTips.length);
    expect(withoutTips.trimEnd()).toMatch(/kimi-k2 {2}\/tmp\/project$/);
  });

  it('honors the configured position of the tips slot', () => {
    // The tip content itself rotates; locate it via a tips-only render.
    const tipsOnly = plain(
      new FooterComponent({
        ...baseState,
        statusLine: { items: ['tips'], command: null },
      }).render(200)[0]!,
    ).trim();

    const tipsFirst = plain(
      new FooterComponent({
        ...baseState,
        statusLine: { items: ['tips', 'model'], command: null },
      }).render(200)[0]!,
    );
    const tipsLast = plain(
      new FooterComponent({
        ...baseState,
        statusLine: { items: ['model', 'tips'], command: null },
      }).render(200)[0]!,
    );

    expect(tipsOnly.length).toBeGreaterThan(0);
    expect(tipsFirst.indexOf(tipsOnly)).toBeLessThan(tipsFirst.indexOf('kimi-k2'));
    expect(tipsLast.indexOf('kimi-k2')).toBeLessThan(tipsLast.indexOf(tipsOnly));
  });

  it('renders nothing on line 1 for an empty items list', () => {
    const state: AppState = {
      ...baseState,
      statusLine: { items: [], command: null },
    };
    const footer = new FooterComponent(state);

    expect(plain(footer.render(120)[0]!).trim()).toBe('');
  });
});
