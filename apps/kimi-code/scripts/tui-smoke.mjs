import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { startServer } from '@kiki/kap-server';
import { VirtualTerminal } from '@kiki/pi-tui/testing';
import { DEFAULT_TUI_CONFIG } from '../src/tui/config';
import { DaemonTUI } from '../src/tui/daemon/daemon-tui';

const TEST_HOST_IDENTITY = {
  productName: 'test-host',
  version: '0.0.0-test',
  platform: 'test_platform',
};

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, '');
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`TUI smoke assertion failed: ${message}`);
  }
}

function assertNoCorruptAnsi(viewport, width, label) {
  for (let i = 0; i < viewport.length; i += 1) {
    const line = viewport[i] ?? '';
    const plain = stripAnsi(line);
    assert(!plain.includes('\x1b'), `${label} row ${i + 1} leaked raw ESC sequence: ${JSON.stringify(plain)}`);
    assert(!/\[(?:\d+;)*\d+m/.test(plain), `${label} row ${i + 1} leaked raw SGR code: ${JSON.stringify(plain)}`);
    assert(plain.trimEnd().length <= width + 2, `${label} row ${i + 1} unexpectedly wide: ${plain.trimEnd().length}`);
  }
}

async function sendClickOnText(vt, needle) {
  await vt.waitForRender();
  const rows = vt.getViewport().map((l) => stripAnsi(l));
  const rowIndex = rows.findIndex((line) => line.includes(needle));
  assert(rowIndex >= 0, `Could not find clickable row containing "${needle}" in viewport:\n${rows.join('\n')}`);
  const col = Math.max(1, rows[rowIndex].indexOf(needle) + 1);
  const row = rowIndex + 1;
  vt.sendInput(`\x1b[<0;${col};${row}M`);
  vt.sendInput(`\x1b[<0;${col};${row}m`);
  await vt.waitForRender();
}

async function runMode(screenMode) {
  const tempHome = mkdtempSync(join(tmpdir(), `kiki-tui-smoke-${screenMode}-`));
  const workDir = join(tempHome, 'workspace');
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(tempHome, 'config.toml'), '[search]\nenabled = false\n', 'utf8');

  const prevHome = process.env['KIKI_HOME'];
  const prevSearch = process.env['KIKI_SEARCH_DISABLED'];
  const prevFs = process.env['KIKI_TUI_FULL_SCREEN'];
  process.env['KIKI_HOME'] = tempHome;
  process.env['KIKI_SEARCH_DISABLED'] = '1';
  if (screenMode === 'alt') process.env['KIKI_TUI_FULL_SCREEN'] = '1';
  else delete process.env['KIKI_TUI_FULL_SCREEN'];

  let server;
  let tui;
  try {
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      homeDir: tempHome,
      host: '127.0.0.1',
      port: 0,
      logLevel: 'silent',
    });
    const url = `http://127.0.0.1:${server.port}`;
    const vt = new VirtualTerminal(100, 32);
    tui = new DaemonTUI(
      { url, token: server.localOwnerToken, localOwner: true },
      {
        workDir,
        additionalDirs: [],
        cliOptions: {
          continueLast: false,
          yolo: true,
          auto: false,
          plan: false,
          agentFiles: [],
          skillsDirs: [],
        },
        tuiConfig: { ...DEFAULT_TUI_CONFIG, screenMode },
        version: '0.5.1-smoke',
      },
      vt,
    );
    await tui.start();
    await vt.waitForRender();

    const makeTool = (id, path, turnId, status = 'done') => ({
      kind: 'tool',
      id,
      toolCallId: id,
      name: 'Read',
      turnId,
      args: { path },
      argsText: '',
      display: undefined,
      description: undefined,
      status,
      output: status === 'error' ? `${path} does not exist` : `body-of-${path}`,
      isError: status === 'error',
      durationMs: 12,
      progressText: undefined,
    });

    const fixtureBlocks = [
      { kind: 'user', id: 'u1', turnId: 't1', text: 'Ping', createdAt: '' },
      { kind: 'thinking', id: 'th1', turnId: 't1', text: 'Private thought turn 1\nSecond line', streaming: false, createdAt: undefined },
      { kind: 'assistant', id: 'a1', turnId: 't1', text: 'pong', streaming: false, createdAt: undefined },
      { kind: 'user', id: 'u2', turnId: 't2', text: 'Check alpha', createdAt: '' },
      makeTool('tool-alpha', 'alpha.txt', 't2'),
      { kind: 'assistant', id: 'a2', turnId: 't2', text: '42', streaming: false, createdAt: undefined },
      { kind: 'user', id: 'u3', turnId: 't3', text: 'Check three files', createdAt: '' },
      { kind: 'thinking', id: 'th3', turnId: 't3', text: 'Private thought turn 3\nMust stay folded', streaming: false, createdAt: undefined },
      makeTool('tool-ok1', 'alpha.txt', 't3'),
      makeTool('tool-ok2', 'beta.txt', 't3'),
      makeTool('tool-err', 'missing.txt', 't3', 'error'),
      { kind: 'assistant', id: 'a3', turnId: 't3', text: 'missing.txt is absent.', streaming: false, createdAt: undefined },
    ];

    const controller = tui['controller'];
    const baseGetState = controller.getState.bind(controller);
    controller.getState = () => ({ ...baseGetState(), blocks: fixtureBlocks });
    tui['refreshFocusedTranscript']();
    await vt.waitForRender();

    const readScreen = () => vt.getViewport().map((l) => stripAnsi(l).trimEnd()).join('\n');
    const compactScreen = readScreen();
    assertNoCorruptAnsi(vt.getViewport(), 100, `${screenMode}:compact-100x32`);
    assert(compactScreen.includes('▸ Thought'), `[${screenMode}] Expected single settled thinking to fold to ▸ Thought`);
    assert(!compactScreen.includes('Private thought turn 1'), `[${screenMode}] Completed thinking leaked in compact mode`);
    assert(compactScreen.includes('▸ Worked · 1 step · read alpha.txt'), `[${screenMode}] Expected single settled tool to fold to 1 summary line`);
    assert(compactScreen.includes('▸ Worked · 3 steps · 1 thought · 1 failed'), `[${screenMode}] Expected mixed turn summary with error badge`);
    assert(compactScreen.includes('missing.txt does not exist'), `[${screenMode}] Expected failed tool error to surface visibly in compact mode`);
    assert(!compactScreen.includes('Private thought turn 3'), `[${screenMode}] Completed thinking leaked beside failed tool`);

    if (screenMode === 'alt') {
      await sendClickOnText(vt, '▸ Thought');
      const afterClick = readScreen();
      assert(afterClick.includes('▾ Thought'), `[${screenMode}] Expected clicked fold chevron to flip to ▾ Thought`);
      assert(afterClick.includes('Private thought turn 1'), `[${screenMode}] Expected clicked thinking fold to reveal thought body`);
      assert(!afterClick.includes('Private thought turn 3'), `[${screenMode}] Unclicked turn 3 thinking must remain collapsed`);

      await sendClickOnText(vt, '▾ Thought');
      const afterReclick = readScreen();
      assert(afterReclick.includes('▸ Thought'), `[${screenMode}] Expected second click to collapse back to ▸ Thought`);
      assert(!afterReclick.includes('Private thought turn 1'), `[${screenMode}] Expected thought body hidden after re-collapse`);
    }

    vt.sendInput('\x0f');
    await vt.waitForRender();
    const expandedTranscript = stripAnsi(tui.state.transcriptContainer.render(100).join('\n'));
    assert(expandedTranscript.includes('Private thought turn 1'), `[${screenMode}] Expected Ctrl+O to reveal turn 1 thinking`);
    assert(expandedTranscript.includes('Private thought turn 3'), `[${screenMode}] Expected Ctrl+O to reveal turn 3 thinking`);
    assert(expandedTranscript.includes('body-of-alpha.txt'), `[${screenMode}] Expected Ctrl+O to reveal full tool output`);

    vt.sendInput('\x0f');
    await vt.waitForRender();
    assert(readScreen().includes('▸ Worked · 3 steps · 1 thought · 1 failed'), `[${screenMode}] Expected second Ctrl+O to restore compact folds`);

    vt.sendInput('/mo');
    await vt.waitForRender();
    assert(readScreen().includes('/model'), `[${screenMode}] Expected /mo slash autocomplete to surface /model`);
    vt.sendInput('\x1b');
    await vt.waitForRender();
    vt.sendInput('\x15');
    await vt.waitForRender();

    vt.sendInput('/help');
    await vt.waitForRender();
    vt.sendInput('\r');
    await vt.waitForRender();
    const helpScreen = readScreen();
    assertNoCorruptAnsi(vt.getViewport(), 100, `${screenMode}:help-100x32`);
    assert(
      helpScreen.includes('Slash commands') && helpScreen.includes('Esc / Enter / q cancel'),
      `[${screenMode}] Expected /help panel to render commands and dismiss hint:\n${helpScreen}`,
    );
    vt.sendInput('\x1b');
    await vt.waitForRender();

    vt.resize(120, 40);
    await vt.waitForRender();
    assertNoCorruptAnsi(vt.getViewport(), 120, `${screenMode}:compact-120x40`);
    assert(readScreen().includes('▸ Worked · 3 steps · 1 thought · 1 failed'), `[${screenMode}] Expected compact folds preserved at 120x40`);
  } finally {
    await tui?.close().catch(() => {});
    await server?.close().catch(() => {});
    if (prevHome === undefined) delete process.env['KIKI_HOME'];
    else process.env['KIKI_HOME'] = prevHome;
    if (prevSearch === undefined) delete process.env['KIKI_SEARCH_DISABLED'];
    else process.env['KIKI_SEARCH_DISABLED'] = prevSearch;
    if (prevFs === undefined) delete process.env['KIKI_TUI_FULL_SCREEN'];
    else process.env['KIKI_TUI_FULL_SCREEN'] = prevFs;
    try {
      rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Best-effort cleanup on Windows when SQLite handles close asynchronously.
    }
  }
}

async function run() {
  for (const screenMode of ['main', 'alt']) {
    await runMode(screenMode);
  }
  console.log('TUI E2E smoke passed (main + alt, 100x32 & 120x40: auto-fold, error surfacing, mouse click toggle, Ctrl+O, autocomplete, /help).');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
