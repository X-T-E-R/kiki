import { visibleWidth } from '@kiki/pi-tui';
import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WelcomeComponent } from '#/tui/components/chrome/welcome';
import { setRainbowDance, type RainbowDanceController } from '#/tui/easter-eggs/dance';
import { darkColors } from '#/tui/theme/colors';
import type { AppState } from '#/tui/types';

const TRUECOLOR_PATTERN = /\u001B\[38;2;(\d+);(\d+);(\d+)m/g;
const ANSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/gu;

const appState: AppState = {
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
  theme: 'dark',
  editorCommand: null,
  notifications: { enabled: true, condition: 'unfocused' },
  availableModels: {},
  availableProviders: {},
  mcpServersSummary: null,
};

function truecolorCodes(text: string): Set<string> {
  const codes = new Set<string>();
  for (const match of text.matchAll(TRUECOLOR_PATTERN)) {
    codes.add(`${match[1]},${match[2]},${match[3]}`);
  }
  return codes;
}

function plainLines(lines: string[]): string[] {
  return lines.map((line) => line.replaceAll(ANSI_PATTERN, ''));
}

function stateWith(overrides: Partial<AppState>): AppState {
  return { ...appState, ...overrides };
}

function warningRgb(): string {
  return darkColors.warning
    .slice(1)
    .match(/.{2}/gu)!
    .map((channel) => String(Number.parseInt(channel, 16)))
    .join(',');
}

const displayModel = {
  provider: 'managed:kimi-code',
  model: 'kimi-k2',
  maxContextSize: 200_000,
  displayName: 'Kimi K2',
  capabilities: ['thinking'],
} as unknown as AppState['availableModels'][string];

/** The two header rows (logo + title) of the rendered welcome box. */
function headerOf(lines: string[]): string {
  return [lines[3], lines[4]].join('\n');
}

function setDanceView(colored: boolean, phase: number): void {
  const dance: RainbowDanceController = {
    colored,
    phase,
    start: () => {},
    stop: () => {},
    dispose: () => {},
  };
  setRainbowDance(dance);
}

describe('WelcomeComponent', () => {
  const previousChalkLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
    setRainbowDance(undefined);
  });

  it('renders the banner in a single brand color by default', () => {
    const codes = truecolorCodes(headerOf(new WelcomeComponent(appState).render(80)));

    // No rainbow by default — just the brand primary (plus the dim tagline).
    expect(codes.size).toBeLessThanOrEqual(2);
  });

  it('paints the banner in rainbow while colored', () => {
    setDanceView(true, 0);
    const codes = truecolorCodes(headerOf(new WelcomeComponent(appState).render(80)));

    expect(codes.size).toBeGreaterThanOrEqual(5);
  });

  it('renders exactly the default banner when not colored', () => {
    const base = headerOf(new WelcomeComponent(appState).render(80));
    setDanceView(false, 5);
    const off = headerOf(new WelcomeComponent(appState).render(80));

    expect(off).toBe(base);
  });

  it('keeps every line within the requested width on narrow terminals', () => {
    for (const width of [0, 1, 2, 4, 10, 39, 80]) {
      for (const line of new WelcomeComponent(appState).render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it.each([40, 50])('renders compact, wrapped guidance at %i columns', (width) => {
    const state = stateWith({
      workDir: '/home/user/projects/kiki',
      availableModels: { 'kimi-k2': displayModel },
    });
    const rendered = new WelcomeComponent(state).render(width);
    const lines = plainLines(rendered);
    const output = lines.join('\n');

    expect(lines[0]).toBe('');
    expect(lines.at(-1)).toBe('');
    expect(output).toContain('Kiki 1.2.3');
    expect(output).toContain('Kimi K2');
    expect(output).toContain('/projects/kiki');
    expect(output).toContain('/ commands');
    expect(output).toContain('/help keys');
    expect(output).toContain('\\ + Enter newline');
    expect(lines.some((line) => line.startsWith('╭'))).toBe(false);
    expect(lines.every((line) => !line.endsWith('…'))).toBe(true);
    expect(rendered.every((line) => visibleWidth(line) <= width)).toBe(true);
  });

  it('uses the compact form when startup height is short, but not after a render-time resize', () => {
    const compact = plainLines(new WelcomeComponent(appState, 20).render(100));
    const boxed = plainLines(new WelcomeComponent(appState, 40).render(100));

    expect(compact.some((line) => line.startsWith('╭'))).toBe(false);
    expect(boxed.some((line) => line.startsWith('╭'))).toBe(true);
    expect(plainLines(new WelcomeComponent(appState, 40).render(59)).some((line) =>
      line.startsWith('╭'),
    )).toBe(false);
  });

  it.each([60, 80])('wraps the boxed hint inside the logo text column at %i columns', (width) => {
    const lines = plainLines(new WelcomeComponent(appState, 40).render(width));

    expect(lines[4]).toContain('Type / for commands');
    expect(lines[5]).toContain('End a line with \\ + Enter for newline');
    expect(lines[5]).toMatch(/^│ {11}End a line/u);
  });

  it('omits the session row until a session id exists', () => {
    const withoutSession = plainLines(
      new WelcomeComponent(stateWith({ sessionId: '' }), 40).render(100),
    ).join('\n');
    const withSession = plainLines(new WelcomeComponent(appState, 40).render(100)).join('\n');

    expect(withoutSession).not.toContain('Session:');
    expect(withSession).toContain('Session:');
  });

  it.each([
    { width: 50, rows: 24 },
    { width: 80, rows: 40 },
  ])('shows login guidance and warning-colored model status when logged out', ({ width, rows }) => {
    const state = stateWith({ model: '', availableModels: {} });
    const rendered = new WelcomeComponent(state, rows).render(width);
    const output = plainLines(rendered).join('\n');

    expect(output).toContain('Run /login to get started.');
    expect(output).toContain('not set');
    expect(truecolorCodes(rendered.join('\n'))).toContain(warningRgb());
  });

  it.each([
    { width: 50, rows: 24 },
    { width: 80, rows: 40 },
  ])('asks for model selection, not login, when models are available', ({ width, rows }) => {
    const state = stateWith({ model: '', availableModels: { 'kimi-k2': displayModel } });
    const rendered = new WelcomeComponent(state, rows).render(width);
    const output = plainLines(rendered).join('\n');

    expect(output).toContain('Choose a model with /model.');
    expect(output).not.toContain('/login');
    expect(output).toContain('not set');
    expect(truecolorCodes(rendered.join('\n'))).toContain(warningRgb());
  });

  it('keeps a selected model usable when the catalog is empty', () => {
    const state = stateWith({ model: 'configured-model', availableModels: {} });
    const output = plainLines(new WelcomeComponent(state).render(50)).join('\n');

    expect(output).toContain('configured-model');
    expect(output).toContain('/ commands');
    expect(output).not.toContain('/login');
    expect(output).not.toContain('Choose a model');
  });
});
