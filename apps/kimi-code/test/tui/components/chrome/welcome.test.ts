import { visibleWidth } from '@kiki/pi-tui';
import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import { GutterContainer } from '#/tui/components/chrome/gutter-container';
import { WelcomeComponent } from '#/tui/components/chrome/welcome';
import { SettingsDialogComponent } from '#/tui/components/dialogs/settings-dialog';
import { FileMentionProvider } from '#/tui/components/editor/file-mention-provider';
import { WrappingSelectList } from '#/tui/components/editor/wrapping-select-list';
import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import { GoalStatusMessageComponent } from '#/tui/components/messages/goal-panel';
import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { UsagePanelComponent, buildUsageReportLines } from '#/tui/components/messages/usage-panel';
import { UserMessageComponent } from '#/tui/components/messages/user-message';
import { QueuePaneComponent } from '#/tui/components/panes/queue-pane';
import { daemonAutocompleteCommands } from '#/tui/daemon/commands';
import { setRainbowDance, type RainbowDanceController } from '#/tui/easter-eggs/dance';
import { currentTheme, darkColors, lightColors } from '#/tui/theme';
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

  it('maintains WCAG AA light-theme contrast and crisp 80/120-column dark and light workspace frames', async () => {
    const relLuminance = (hex: string): number => {
      const n = Number.parseInt(hex.slice(1), 16);
      const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
    };
    const contrastRatio = (fgHex: string, bgHex: string): number => {
      const l1 = relLuminance(fgHex);
      const l2 = relLuminance(bgHex);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };

    for (const key of [
      'primary',
      'accent',
      'text',
      'textStrong',
      'textDim',
      'textMuted',
      'success',
      'warning',
      'error',
      'roleUser',
      'shellMode',
    ] as const) {
      expect(contrastRatio(lightColors[key], '#FFFFFF'), key).toBeGreaterThanOrEqual(4.5);
    }
    for (const key of ['border', 'borderFocus'] as const) {
      expect(contrastRatio(lightColors[key], '#FFFFFF'), key).toBeGreaterThanOrEqual(3.0);
    }

    const commands = daemonAutocompleteCommands(
      new Map([
        [
          'visual-brief',
          {
            commandName: 'visual-brief',
            name: 'visual-brief',
            description: '[user] Create dual-surface IM visual briefings',
            argumentHint: '<topic>',
          },
        ],
      ]),
      new Map([['reviewer', 'reviewer']]),
    );
    const provider = new FileMentionProvider(commands, '/workspace/project', null);
    const ac = new AbortController();
    const barePopup = await provider.getSuggestions(['/'], 0, 1, { signal: ac.signal });
    const fuzzyPopup = await provider.getSuggestions(['/rev'], 0, 4, { signal: ac.signal });

    try {
      for (const themeName of ['dark', 'light'] as const) {
        currentTheme.setPalette(themeName === 'dark' ? darkColors : lightColors);
        for (const width of [80, 120] as const) {
          const state: AppState = {
            ...appState,
            sessionId: 'a8f19c20-41be-479a-9f12-001122334455',
            model: 'kimi-k2.5',
            thinkingEffort: 'high',
            permissionMode: 'auto',
            planMode: true,
            contextUsage: 0.34,
            contextTokens: 43_520,
            maxContextTokens: 128_000,
            workDir: '/workspace/project',
            version: '0.5.1',
            theme: themeName,
            busySubmit: 'send_now',
            mouse: true,
            screenMode: 'main',
            showThinking: true,
            goal: {
              goalId: 'goal-1',
              status: 'active',
              objective: 'Transform Kiki TUI into a responsive clickable workspace',
              completionCriterion: 'All Vitest suites pass and 80/120-col frames look crisp',
              turnsUsed: 5,
              tokensUsed: 64_200,
              wallClockMs: 185_000,
              budget: {
                turnBudget: 15,
                tokenBudget: null,
                wallClockBudgetMs: null,
                remainingTokens: null,
                remainingTurns: 10,
                remainingWallClockMs: null,
                tokenBudgetReached: false,
                turnBudgetReached: false,
                wallClockBudgetReached: false,
                overBudget: false,
              },
            },
          };

          const welcome = new WelcomeComponent(state);
          const userMsg = new UserMessageComponent('Inspect /settings, /usage, /goal, and mouse pills.', []);
          const thinking = new ThinkingComponent(
            'Checking SGR mouse hit-testing across TuiMainScreen and TuiAltScreen.\nVerifying light-theme contrast >= 4.5:1.\nEnsuring busy Enter defaults to send_now while Alt+Enter queues.\nLine 4 hidden when collapsed.',
            true,
            'finalized',
          );
          const assistant = new AssistantMessageComponent();
          assistant.updateContent('Wired **SGR mouse routing**, interactive `/settings`, and curated `/` autocomplete.');
          const usagePanel = new UsagePanelComponent(
            () =>
              buildUsageReportLines({
                sessionUsage: {
                  total: { inputTokens: 38_400, outputTokens: 5_120, cacheReadTokens: 28_000 },
                  byModel: {
                    'kimi-k2.5': { inputTokens: 38_400, outputTokens: 5_120, cacheReadTokens: 28_000 },
                  },
                },
                sessionCostUsd: 0.0412,
                contextUsage: 0.34,
                contextTokens: 43_520,
                maxContextTokens: 128_000,
              }),
            'primary',
            ' Usage ',
          );
          const goalPanel = new GoalStatusMessageComponent(state.goal!);
          const queuePane = new QueuePaneComponent({
            isCompacting: false,
            isStreaming: true,
            canSteerImmediately: true,
            messages: [{ text: 'Add virtual-TTY frame verification next' }],
          });
          const listTheme = {
            selectedPrefix: (t: string) => currentTheme.fg('primary', t),
            selectedText: (t: string) => currentTheme.boldFg('primary', t),
            description: (t: string) => currentTheme.fg('textMuted', t),
            scrollInfo: (t: string) => currentTheme.fg('textMuted', t),
            noMatch: (t: string) => currentTheme.fg('textMuted', t),
          };
          const slashMenu = new WrappingSelectList(barePopup!.items, 8, listTheme);
          const fuzzyMenu = new WrappingSelectList(fuzzyPopup!.items, 6, listTheme);
          const settingsDialog = new SettingsDialogComponent({
            items: [
              {
                id: 'busy_submit',
                label: 'Busy Enter behavior',
                description: 'Send now steers the running turn; Queue waits for the next turn',
                getValue: () => 'Send now',
                getValueTone: () => 'primary',
                onActivate: () => {},
              },
              {
                id: 'mouse',
                label: 'Mouse reporting',
                description: 'Click & wheel navigation (Alt+M toggles for native drag selection)',
                getValue: () => 'enabled',
                onActivate: () => {},
              },
              {
                id: 'screen_mode',
                label: 'Screen mode',
                description: 'Applies on next launch',
                getValue: () => 'Main scrollback',
                getValueTone: () => 'primary',
                onActivate: () => {},
              },
              {
                id: 'theme',
                label: 'Theme',
                description: 'Cycle auto, dark, and light color palettes',
                getValue: () => themeName,
                getValueTone: () => 'primary',
                onActivate: () => {},
              },
            ],
            onCancel: () => {},
          });
          const footer = new FooterComponent(state);
          footer.setBackgroundCounts({ bashTasks: 1, agentTasks: 2 });
          const footerWrap = new GutterContainer(2, 2);
          footerWrap.addChild(footer);

          const frameLines = [
            ...welcome.render(width),
            ...userMsg.render(width),
            ...thinking.render(width),
            '',
            ...assistant.render(width),
            ...usagePanel.render(width),
            ...goalPanel.render(width),
            ...slashMenu.render(width),
            ...fuzzyMenu.render(width),
            ...settingsDialog.render(width),
            ...queuePane.render(width),
            ...footerWrap.render(width),
          ];

          for (const line of frameLines) {
            expect(visibleWidth(line)).toBeLessThanOrEqual(width);
            expect(line).not.toContain('✨');
          }
          if (process.env['PRINT_TUI_FRAMES'] === '1') {
            const strip = (s: string) =>
              s.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/g, '').replaceAll(/\u001B\]8;;.*?\u0007/g, '');
            process.stderr.write(
              `\n=== ${themeName.toUpperCase()} ${String(width)} COLS ===\n${frameLines.map(strip).join('\n')}\n`,
            );
          }
          footer.dispose();
          thinking.dispose();
        }
      }
    } finally {
      currentTheme.setPalette(darkColors);
    }
  });
});
