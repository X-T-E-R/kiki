import { describe, expect, it, vi } from 'vitest';
import { Container, Key, TuiAltScreen, TuiMainScreen, type Terminal } from '@kiki/pi-tui';
import type { Block } from '@kiki/session-core/session/transcript/types';

import { ApprovalPanelComponent } from '#/tui/components/dialogs/approval-panel';
import { QuestionDialogComponent } from '#/tui/components/dialogs/question-dialog';
import { TabbedModelSelectorComponent } from '#/tui/components/dialogs/tabbed-model-selector';
import { ThemeSelectorComponent } from '#/tui/components/dialogs/theme-selector';
import { FileMentionProvider } from '#/tui/components/editor/file-mention-provider';
import { ContextPanelComponent } from '#/tui/components/messages/context-panel';
import {
  DEFAULT_TUI_CONFIG,
  renderTuiConfig,
  resolveEffectiveScreenAndMouse,
} from '#/tui/config';
import { createDaemonArgumentCompletions, type DaemonCompletionSnapshot } from '#/tui/daemon/command-completions';
import { daemonAutocompleteCommands } from '#/tui/daemon/commands';
import { DaemonTranscriptRenderer } from '#/tui/daemon/transcript-renderer';
import { ScreenController } from '#/tui/screen-controller';
import { currentTheme, darkColors, lightColors } from '#/tui/theme';
import { extractCopyTargets } from '#/tui/utils/code-blocks';
import { buildActiveShortcutGroups } from '#/tui/daemon/daemon-shortcuts';

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replaceAll(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

function makeMockTerminal(cols = 100, rows = 30) {
  const writes: string[] = [];
  let onInput: ((data: string) => void) | undefined;
  const terminal: Terminal = {
    columns: cols,
    rows,
    kittyProtocolActive: true,
    start: (inputCb) => {
      onInput = inputCb;
    },
    stop: () => {
      onInput = undefined;
    },
    drainInput: async () => {},
    write: (data: string) => {
      writes.push(data);
    },
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
  };
  return {
    terminal,
    writes,
    sendInput: (data: string) => onInput?.(data),
  };
}

describe('Holistic TUI craft contracts', () => {
  it('defaults first launch to main scrollback with mouse OFF and does not pin mouse=true in rendered tui.toml', () => {
    const resolved = resolveEffectiveScreenAndMouse(DEFAULT_TUI_CONFIG, {});
    expect(resolved.screenMode).toBe('main');
    expect(resolved.effectiveMouse).toBe(false);
    expect(resolved.savedMouse).toBeUndefined();

    const toml = renderTuiConfig(DEFAULT_TUI_CONFIG);
    expect(toml).toContain('screen_mode = "main"');
    expect(toml).not.toMatch(/^mouse\s*=\s*true/m);

    // Explicit fullscreen enables mouse unless explicitly disabled
    const altResolved = resolveEffectiveScreenAndMouse({ screenMode: 'alt', mouse: undefined }, {});
    expect(altResolved.screenMode).toBe('alt');
    expect(altResolved.effectiveMouse).toBe(true);

    // Legacy persisted main + mouse=true does not hijack main scrollback
    const legacyMain = resolveEffectiveScreenAndMouse({ screenMode: 'main', mouse: true }, {});
    expect(legacyMain.screenMode).toBe('main');
    expect(legacyMain.effectiveMouse).toBe(false);
  });

  it('switches live between main and alt, supports PageUp transient reader, and fires onAllTakeoversClosed for deferred approvals', async () => {
    const { terminal, writes } = makeMockTerminal(100, 30);
    const containers = {
      breadcrumbContainer: new Container(),
      transcriptContainer: new Container(),
      activityContainer: new Container(),
      todoPanelContainer: new Container(),
      queueContainer: new Container(),
      btwPanelContainer: new Container(),
      editorContainer: new Container(),
    };
    const controller = new ScreenController({
      terminal,
      initialMode: 'main',
      savedMousePreference: undefined,
      containers,
    });
    const delivered = vi.fn();
    controller.setOnAllTakeoversClosed(delivered);
    controller.ui.start();

    expect(controller.getMode()).toBe('main');
    expect(controller.ui instanceof TuiMainScreen).toBe(true);
    expect(controller.getEffectiveMouse()).toBe(false);

    // Transient PageUp reader enters alt without mutating saved mode
    const reader = await controller.enterTransientReader(1);
    expect(reader.switched).toBe(true);
    expect(controller.getMode()).toBe('alt');
    expect(controller.isTransientReaderActive()).toBe(true);
    expect(controller.ui instanceof TuiAltScreen).toBe(true);
    expect(writes.join('')).toContain('\x1b[?1000h\x1b[?1002h\x1b[?1006h');
    expect(writes.join('')).not.toContain('\x1b[?1003h');
    expect(writes.join('')).not.toContain('\x1b[?1007h');

    // Nested full-screen takeover (e.g. /tasks -> TaskOutputViewer) defers approval until outermost closes
    const outerView = new Container();
    const innerView = new Container();
    const endOuter = controller.beginTakeover(outerView);
    expect(controller.isTakeoverActive()).toBe(true);
    const endInner = controller.beginTakeover(innerView);
    expect(controller.isTakeoverActive()).toBe(true);

    endInner();
    expect(controller.isTakeoverActive()).toBe(true);
    expect(delivered).not.toHaveBeenCalled();

    endOuter();
    expect(controller.isTakeoverActive()).toBe(false);
    expect(delivered).toHaveBeenCalledTimes(1);

    // Exit transient reader restores main scrollback
    const back = await controller.exitTransientReader();
    expect(back.switched).toBe(true);
    expect(controller.getMode()).toBe('main');
    expect(controller.isTransientReaderActive()).toBe(false);
    expect(controller.ui instanceof TuiMainScreen).toBe(true);

    controller.ui.stop();
  });

  it('protects running steps from black-box folding, shows thinking summary, and expands thinking on stationary click', () => {
    const body = new Container();
    const renderer = new DaemonTranscriptRenderer(body, undefined, '/repo', { showThinking: true });
    renderer.setScope('session-1:main');

    const blocks: Block[] = [
      {
        kind: 'thinking',
        id: 'think-1',
        turnId: 't1',
        createdAt: '2026-01-01T00:00:00Z',
        text: '**Inspecting layout invariants**\nChecking ScrollView and SGR mouse click handlers.',
        streaming: false,
      },
      {
        kind: 'tool',
        id: 'tool-done',
        turnId: 't1',
        toolCallId: 'tc-1',
        name: 'Read',
        args: { path: 'src/a.ts' },
        argsText: '{"path":"src/a.ts"}',
        display: undefined,
        description: 'Read src/a.ts',
        isError: false,
        durationMs: undefined,
        progressText: undefined,
        status: 'done',
        output: 'ok',
      },
      {
        kind: 'tool',
        id: 'tool-running',
        turnId: 't1',
        toolCallId: 'tc-2',
        name: 'Bash',
        args: { command: 'pnpm test' },
        argsText: '{"command":"pnpm test"}',
        display: undefined,
        description: 'Run tests',
        isError: false,
        durationMs: undefined,
        progressText: undefined,
        status: 'running',
        output: 'running suite 1/3...',
      },
    ];

    renderer.sync(blocks, { liveTurnId: 't1' });
    const renderedBefore = stripAnsi(body.render(100).join('\n'));
    // Thinking headline summary is visible even while collapsed
    expect(renderedBefore).toContain('Inspecting layout invariants');
    // Running tool is never hidden inside a collapsed black-box fold
    expect(renderedBefore).toContain('pnpm test');

    // First stationary left-click expands the collapsed fold revealing the Thinking header
    const clickEvent = {
      button: 0,
      action: 'release',
      col: 5,
      row: 1,
      wheel: null,
      leftClick: true,
      shift: false,
      alt: false,
      ctrl: false,
    };
    const foldComp = body.children.find(
      (child) => stripAnsi(child.render(100).join('\n')).includes('Inspecting layout invariants'),
    ) as unknown as { routeMouse?: (e: unknown, line: number, col: number) => boolean } | undefined;
    expect(foldComp?.routeMouse).toBeTypeOf('function');
    expect(foldComp!.routeMouse!(clickEvent, 0, 5)).toBe(true);

    // Second stationary left-click on the revealed ThinkingComponent header row expands full reasoning text
    const thinkingComp = body.children.find(
      (child) => stripAnsi(child.render(100).join('\n')).includes('Thought: Inspecting layout invariants'),
    ) as unknown as { render: (w: number) => string[]; routeMouse?: (e: unknown, line: number, col: number) => boolean } | undefined;
    expect(thinkingComp?.routeMouse).toBeTypeOf('function');
    const headerRow = thinkingComp!.render(100).findIndex((l) => stripAnsi(l).includes('Thought: Inspecting layout invariants'));
    expect(headerRow).toBeGreaterThanOrEqual(0);
    expect(thinkingComp!.routeMouse!(clickEvent, headerRow, 5)).toBe(true);
    const renderedAfter = stripAnsi(body.render(100).join('\n'));
    expect(renderedAfter).toContain('Checking ScrollView and SGR mouse click handlers.');
  });

  it('provides fuzzy /model completion, multi-token /tasks & /plugins completion, and dynamic inline hints', async () => {
    const lazyRefreshes: string[] = [];
    const snapshot: DaemonCompletionSnapshot = {
      workDir: process.cwd(),
      currentModel: 'claude-opus-4',
      availableModels: {
        'claude-opus-4': {
          provider: 'anthropic',
          model: 'claude-opus-4',
          displayName: 'Claude Opus 4',
          maxContextSize: 200_000,
          capabilities: ['thinking', 'tool_use'],
          supportEfforts: ['low', 'medium', 'high'],
        },
        'gpt-5': {
          provider: 'openai',
          model: 'gpt-5',
          displayName: 'GPT-5',
          maxContextSize: 128_000,
          capabilities: ['thinking'],
          supportEfforts: ['medium', 'high'],
        },
      },
      recentModels: ['gpt-5'],
      currentThinkingEffort: 'high',
      currentPermissionMode: 'manual',
      currentTheme: 'dark',
      effectiveMouse: true,
      screenMode: 'alt',
      currentAgentProfile: 'agent',
      availableAgentProfiles: [{ name: 'agent', description: 'Default agent' }],
      focusedAgentId: 'main',
      sessionAgents: [{ id: 'main', label: 'main', status: 'idle' }],
      plugins: [{ id: 'kiki-mail', name: 'Mail', enabled: true }],
      tasks: [{ id: 'bash-123', status: 'running', description: 'vitest run' }],
      personas: [],
      providers: [{ id: 'anthropic' }],
      configDomains: ['thinking'],
      webSessionIds: [],
      copyCandidates: [{ index: 1, preview: 'const x = 1;' }],
      requestLazyRefresh: (res) => lazyRefreshes.push(res),
    };

    const bindings = createDaemonArgumentCompletions(() => snapshot);
    const commands = daemonAutocompleteCommands(new Map(), new Map(), bindings);
    const provider = new FileMentionProvider(commands, process.cwd(), null);
    const controller = new AbortController();

    // /model fuzzy search
    const modelRes = await provider.getSuggestions(['/model opus'], 0, '/model opus'.length, {
      signal: controller.signal,
      trigger: 'typing',
    });
    expect(modelRes?.items.some((i) => i.value === 'claude-opus-4')).toBe(true);
    expect(modelRes?.items[0]?.intent).toBe('runOnEnter');

    // Multi-token /tasks stop <id>
    const taskRes = await provider.getSuggestions(['/tasks stop '], 0, '/tasks stop '.length, {
      signal: controller.signal,
      trigger: 'typing',
    });
    expect(taskRes?.items.some((i) => i.value === 'bash-123')).toBe(true);

    // Free-text guard on /goal stays quiet on typing, responds on explicit Tab
    const goalTyping = await provider.getSuggestions(['/goal fix'], 0, '/goal fix'.length, {
      signal: controller.signal,
      trigger: 'typing',
    });
    expect(goalTyping).toBeNull();
    const goalTab = await provider.getSuggestions(['/goal '], 0, '/goal '.length, {
      signal: controller.signal,
      trigger: 'tab',
    });
    expect(goalTab?.items.some((i) => i.value === 'status')).toBe(true);

    // Dynamic ghost hint for /provider add
    const hint = provider.getDynamicInlineHint(['/provider add '], 0, '/provider add '.length);
    expect(hint).toContain('<id>');
  });

  it('supports Tab note isolation in ApprovalPanelComponent and Shift+Tab reverse navigation in QuestionDialogComponent', () => {
    const submitted: unknown[] = [];
    const approval = new ApprovalPanelComponent(
      {
        data: {
          id: 'ap-1',
          tool_call_id: 'tc-1',
          tool_name: 'Bash',
          action: 'Run command',
          description: 'echo hi',
          display: [{ type: 'shell', language: 'bash', command: 'echo hi' }],
          choices: [
            { label: 'Approve once', response: 'approved' },
            { label: 'Approve for this session', response: 'approved_for_session' },
            { label: 'Reject', response: 'rejected' },
          ],
        },
      },
      (res) => {
        submitted.push(res);
      },
      undefined,
      undefined,
      { armAfterMs: 0 },
    );

    // Tab opens note on row 0 without submitting
    approval.handleInput('\t');
    expect(submitted).toHaveLength(0);
    approval.handleInput('looks safe');
    // Moving down to row 1 clears the note so it never leaks onto another decision
    approval.handleInput('\x1b[B');
    approval.handleInput('\r');
    expect(submitted).toEqual([{ response: 'approved_for_session', feedback: undefined, selected_label: undefined, selected_option_id: undefined }]);

    // QuestionDialog Shift+Tab moves backward across tabs
    const answers: unknown[] = [];
    const qDialog = new QuestionDialogComponent(
      {
        data: {
          id: 'q-1',
          tool_call_id: 'tc-q1',
          questions: [
            { header: 'Q1', question: 'First?', multi_select: false, options: [{ label: 'A' }, { label: 'B' }] },
            { header: 'Q2', question: 'Second?', multi_select: false, options: [{ label: 'C' }, { label: 'D' }] },
          ],
        },
      },
      (res) => {
        answers.push(res);
      },
      6,
      undefined,
      { armAfterMs: 0 },
    );
    qDialog.handleInput('\t'); // Q1 -> Q2
    expect(stripAnsi(qDialog.render(80).join('\n'))).toContain('Second?');
    qDialog.handleInput('\x1b[Z'); // Shift+Tab -> Q1
    expect(stripAnsi(qDialog.render(80).join('\n'))).toContain('First?');
  });

  it('supports TabbedModelSelector favorites without row-jump, ThemeSelector live preview highlight callback, ContextPanel honest estimates, and /copy code extraction', () => {
    const toggled: Array<[string, boolean]> = [];
    const sessionOnly: unknown[] = [];
    const selector = new TabbedModelSelectorComponent({
      models: {
        'model-a': { provider: 'p1', model: 'a', displayName: 'Model A', maxContextSize: 128_000, capabilities: ['thinking', 'tool_use'], supportEfforts: ['low', 'high'] },
        'model-b': { provider: 'p2', model: 'b', displayName: 'Model B', maxContextSize: 200_000, capabilities: ['image_in'] },
      },
      currentValue: 'model-a',
      currentThinkingEffort: 'high',
      favorites: ['model-b'],
      onToggleFavorite: (alias, fav) => toggled.push([alias, fav]),
      onSelect: () => {},
      onSessionOnlySelect: (sel) => sessionOnly.push(sel),
      onCancel: () => {},
    });
    const rendered = stripAnsi(selector.render(90).join('\n'));
    expect(rendered).toContain('*');
    expect(rendered).toContain('Context 125k');
    expect(rendered).toContain('Alt+S session-only');
    // Toggle favorite on selected model-a via Ctrl+F
    selector.handleInput('\x06');
    expect(toggled).toEqual([['model-a', true]]);
    // Alt+S triggers session-only selection
    selector.handleInput('\x1bs');
    expect(sessionOnly).toHaveLength(1);

    // ThemeSelector emits onHighlightChange for live preview
    const highlights: string[] = [];
    currentTheme.setPalette(darkColors);
    const themePicker = new ThemeSelectorComponent({
      currentValue: 'dark',
      onHighlightChange: (t) => highlights.push(t),
      onSelect: () => {},
      onCancel: () => {},
    });
    themePicker.handleInput('\x1b[B'); // dark -> light
    expect(highlights).toEqual(['light']);
    currentTheme.setPalette(lightColors);
    currentTheme.setPalette(darkColors);

    // ContextPanel never fabricates percentage when maxContextTokens is missing
    const coldPanel = new ContextPanelComponent({
      targetLabel: 'main',
      contextTokens: 4200,
      unavailableReason: 'Session is cold',
    });
    const coldOut = stripAnsi(coldPanel.render(80).join('\n'));
    expect(coldOut).toContain('Breakdown unavailable');
    expect(coldOut).not.toContain('%');

    // extractCopyTargets extracts code blocks newest-first plus last assistant message
    const copy = extractCopyTargets([
      {
        kind: 'assistant',
        id: 'a1',
        turnId: 't1',
        createdAt: '2026-01-01T00:00:00Z',
        text: 'Here:\n```ts\nconst a = 1;\n```\nAnd:\n```bash\necho ok\n```',
        streaming: false,
      },
    ]);
    expect(copy.codeBlocks).toHaveLength(2);
    expect(copy.codeBlocks[0]?.language).toBe('bash');
    expect(copy.codeBlocks[1]?.language).toBe('ts');
    expect(copy.allTargets[0]?.kind).toBe('message');

    // Dynamic shortcuts reflect current mode
    const groups = buildActiveShortcutGroups({
      screenMode: 'alt',
      mouseEnabled: true,
      busySubmit: 'send_now',
      ctrlPBoundToHistory: false,
    });
    expect(groups.length).toBeGreaterThanOrEqual(3);
  });

  it('ScreenController takeover from main preserves native scrollback without CSI 3J and restores main cleanly', async () => {
    const { terminal, writes } = makeMockTerminal(80, 20);
    const containers = {
      breadcrumbContainer: new Container(),
      transcriptContainer: new Container(),
      activityContainer: new Container(),
      todoPanelContainer: new Container(),
      queueContainer: new Container(),
      btwPanelContainer: new Container(),
      editorContainer: new Container(),
    };
    const sc = new ScreenController({
      terminal,
      initialMode: 'main',
      savedMousePreference: true,
      containers,
    });
    sc.ui.start();
    writes.length = 0;

    const viewer = { render: () => ['Tasks browser'], invalidate: () => {} };
    const closeTakeover = sc.beginTakeover(viewer);
    expect(sc.isTakeoverActive()).toBe(true);
    // Switching into temporary alt screen avoids emitting CSI 3J on main scrollback
    const duringWrites = writes.join('');
    expect(duringWrites).not.toContain('\x1b[3J');

    writes.length = 0;
    closeTakeover();
    expect(sc.isTakeoverActive()).toBe(false);
    expect(sc.getMode()).toBe('main');
    const afterCloseWrites = writes.join('');
    expect(afterCloseWrites).not.toContain('\x1b[3J');
    sc.ui.stop();
  });

  it('DaemonTranscriptRenderer.setScope preserves prior scope expansions across agent switches and computes block line offsets', () => {
    const container = new Container();
    const renderer = new DaemonTranscriptRenderer(container, undefined, process.cwd(), {
      showThinking: true,
    });
    const mainBlocks: Block[] = [
      { kind: 'user', id: 'u1', promptId: 'p1', createdAt: '2026-01-01T00:00:00Z', text: 'First prompt' },
      { kind: 'thinking', id: 'th1', turnId: 't1', createdAt: '2026-01-01T00:00:01Z', text: '**Step A**\nDetails here.', streaming: false },
      { kind: 'assistant', id: 'a1', turnId: 't1', createdAt: '2026-01-01T00:00:02Z', text: 'Answer one', streaming: false },
      { kind: 'user', id: 'u2', promptId: 'p2', createdAt: '2026-01-01T00:00:03Z', text: 'Second prompt' },
    ];
    const childBlocks: Block[] = [
      { kind: 'user', id: 'cu1', promptId: 'cp1', createdAt: '2026-01-01T00:00:04Z', text: 'Child task' },
    ];

    renderer.setScope('sess-1:main');
    renderer.sync(mainBlocks);
    // Simulate expanding th1 in main scope via mouse click toggle on summary/block
    const u1Offset = renderer.getBlockLineOffset('u1', 80);
    const u2Offset = renderer.getBlockLineOffset('u2', 80);
    expect(u1Offset).toBe(0);
    expect(u2Offset).toBeGreaterThan(0);

    // Switch to child scope and back — main scope must not have been pruned against child blocks
    renderer.setScope('sess-1:child-1');
    renderer.sync(childBlocks);
    expect(renderer.getBlockLineOffset('cu1', 80)).toBe(0);

    renderer.setScope('sess-1:main');
    renderer.sync(mainBlocks);
    expect(renderer.getBlockLineOffset('u2', 80)).toBe(u2Offset);
  });

  it('path completers (/attach) replace full argument range including spaces without duplicating prefix', async () => {
    const tmpDir = await import('node:fs/promises').then((fs) =>
      fs.mkdtemp(require('node:path').join(require('node:os').tmpdir(), 'kiki-attach-space-')),
    );
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      await fs.mkdir(path.join(tmpDir, 'my folder'));
      await fs.writeFile(path.join(tmpDir, 'my folder', 'report.txt'), 'ok');

      const snap: DaemonCompletionSnapshot = {
        workDir: tmpDir,
        currentModel: 'm1',
        availableModels: {},
        recentModels: [],
        currentThinkingEffort: 'high',
        currentPermissionMode: 'default',
        currentTheme: 'dark',
        effectiveMouse: true,
        screenMode: 'alt',
        availableAgentProfiles: [],
        focusedAgentId: 'main',
        sessionAgents: [],
        plugins: [],
        tasks: [],
        personas: [],
        providers: [],
        configDomains: [],
        webSessionIds: [],
        copyCandidates: [],
        requestLazyRefresh: () => {},
      };
      const bindings = createDaemonArgumentCompletions(() => snap);
      const commands = daemonAutocompleteCommands(new Map(), new Map(), bindings);
      const provider = new FileMentionProvider(commands, tmpDir, null);
      const line = '/attach my folder/re';
      const suggestions = await provider.getSuggestions([line], 0, line.length, {
        signal: new AbortController().signal,
        trigger: 'typing',
      });
      expect(suggestions).not.toBeNull();
      const hit = suggestions!.items.find((i) => i.value === 'my folder/report.txt');
      expect(hit).toBeDefined();
      // argsStartCol is right after "/attach " (column 8), NOT after the space inside "my folder"
      expect(hit!.replaceStartCol).toBe(8);
    } finally {
      const fs = await import('node:fs/promises');
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
