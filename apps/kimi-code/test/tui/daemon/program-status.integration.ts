import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { StdinBuffer } from '@kiki/pi-tui';
import { createViewState, type SessionViewState } from '@kiki/session-core/session/transcript/types';
import { VirtualTerminal } from '../../../../../packages/pi-tui/test/virtual-terminal';
import { startServer, type RunningServer } from '../../../../../packages/kap-server/src/start';
import { TEST_HOST_IDENTITY } from '../../../../../packages/kap-server/test/helpers/hostIdentity';
import { DEFAULT_TUI_CONFIG } from '#/tui/config';
import { DaemonTUI } from '#/tui/daemon/daemon-tui';
import { DaemonClient } from '#/tui/daemon/client';
import { DaemonProgramStatus } from '#/tui/daemon/program-status';
import { SessionPickerComponent } from '#/tui/components/dialogs/session-picker';
import { ApiError } from '@kiki/session-core/transport';
import { ErrorCode } from '@kiki/protocol';
import * as urlUtils from '#/utils/open-url';

const osc = (body: string) => `\x1b]7501;${body}\x1b\\`;
function parseReport(sequence: string): Record<string, string> {
  return Object.fromEntries(sequence.slice(7, -2).split(':').map((pair) => {
    const equal = pair.indexOf('=');
    return [pair.slice(0, equal), pair.slice(equal + 1)];
  }));
}

class ReportingTerminal extends VirtualTerminal {
  readonly writes: string[] = [];
  private readonly stdin = new StdinBuffer();
  override start(onInput: (data: string) => void, onResize: () => void): void {
    super.start(onInput, onResize);
    this.stdin.on('data', (data) => super.sendInput(data));
    this.stdin.on('paste', (data) => super.sendInput(`\x1b[200~${data}\x1b[201~`));
  }
  override write(data: string): void { this.writes.push(data); super.write(data); }
  raw(data: string): void { this.stdin.process(data); }
  reports(): string[] { return this.writes.filter((data) => data.startsWith('\x1b]7501;state=')); }
  latest(): Record<string, string> { return parseReport(this.reports().at(-1)!); }
  override stop(): void { this.stdin.destroy(); super.stop(); }
}

let server: RunningServer | undefined;
let tui: DaemonTUI | undefined;
let home: string | undefined;
const clients: DaemonClient[] = [];
const sockets: WebSocket[] = [];

async function boot(options: { ephemeral?: boolean; terminalHandoff?: boolean; answering?: boolean } = {}) {
  for (const key of ['KIKI_EXTERNAL_PRINCIPAL_ID', 'KIKI_EXTERNAL_SESSION_ID', 'KIKI_EXTERNAL_DELEGATION_TOKEN', 'KIKI_SQLITE_QUERY_WORKER_PATH', 'KIKI_SQLITE_INDEXER_PATH', 'KIKI_HISTORY_NAVIGATION_WORKER_ENTRY', 'SSH_CONNECTION', 'SSH_TTY']) vi.stubEnv(key, undefined);
  vi.stubEnv('KIKI_SEARCH_DISABLED', '1');
  const scratch = resolve(import.meta.dirname, '../../../../../.tmp');
  await mkdir(scratch, { recursive: true });
  home = await mkdtemp(join(scratch, 'osc7501-'));
  vi.stubEnv('KIKI_HOME', home);
  await writeFile(join(home, 'config.toml'), `[search]\nenabled = false\n[session_access]\nenabled = true\nterminal_handoff = ${options.terminalHandoff !== false}\n`);
  server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, homeDir: home, host: '127.0.0.1', port: 0, logLevel: 'silent' });
  const connection = { url: `http://127.0.0.1:${server.port}`, token: server.localOwnerToken, localOwner: true };
  const terminal = new ReportingTerminal(120, 36);
  tui = new DaemonTUI(connection, {
    cliOptions: { continue: false, ephemeral: options.ephemeral, yolo: false, auto: false, plan: false, agentFiles: [], skillsDirs: [] },
    tuiConfig: DEFAULT_TUI_CONFIG,
    version: '0.0.0-test',
    workDir: home,
  }, terminal);
  const started = tui.start();
  if (options.answering !== false) {
    terminal.raw('\x1b]7501;?vers');
    terminal.raw('ion=0.4\x1b');
    terminal.raw('\\');
  } else terminal.raw('\x1b[?62c');
  await started;
  const client = new DaemonClient(connection);
  clients.push(client);
  await vi.waitFor(() => expect(terminal.latest()['state']).toBe('idle'));
  return { terminal, client, connection, tui };
}

afterEach(async () => {
  await tui?.close();
  tui = undefined;
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const client of clients.splice(0)) await client.close();
  await server?.close();
  server = undefined;
  if (home !== undefined) await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  home = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('OSC 7501 daemon TUI over a virtual terminal and real server', () => {
  it('reports local access, exchanges a PKCE ticket and revokes on /new and exit', async () => {
    const { terminal, client, connection, tui: current } = await boot();
    const first = current.getCurrentSessionId();
    await client.setTitle(first, 'First session');
    await vi.waitFor(() => expect(Buffer.from(terminal.latest()['title']!, 'base64').toString()).toBe('First session'));
    await vi.waitFor(() => expect(terminal.latest()).toMatchObject({ handoff: '1', session: first, port: String(server!.port) }));
    expect(terminal.latest()['server']).toBe((await client.getSessionAccess()).server_id);
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    terminal.raw(`\x1b]7501;?ticket=${challenge.slice(0, 20)}`);
    terminal.raw(`${challenge.slice(20)}\x1b\\`);
    await vi.waitFor(() => expect(terminal.latest()['challenge']).toBe(challenge));
    const response = await fetch(`${connection.url}/api/session-access/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: terminal.latest()['ticket'], verifier, client: { name: 'example-terminal' } }) });
    const envelope = await response.json() as { code: number; data: { token: string } };
    expect(envelope.code).toBe(0);
    const token = envelope.data.token;
    expect(token).toMatch(/^ksa_/u);
    const sessionResponse = () => fetch(`${connection.url}/api/sessions/${first}`, { headers: { Authorization: `Bearer ${token}` } });
    expect((await sessionResponse()).status).toBe(200);
    const socket = new WebSocket(`ws://127.0.0.1:${server!.port}/api/ws`, [`kimi-code.bearer.${token}`]);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    terminal.raw('/new\r');
    await vi.waitFor(() => expect(current.getCurrentSessionId()).not.toBe(first));
    const second = current.getCurrentSessionId();
    await vi.waitFor(() => expect(terminal.latest()['session']).toBe(second));
    expect((await sessionResponse()).status).toBe(401);
    await closed;
    await client.setTitle(second, 'Second session');
    await vi.waitFor(() => expect(Buffer.from(terminal.latest()['title']!, 'base64').toString()).toBe('Second session'));
    current.state.editor.setText('/sessions');
    terminal.raw('\r');
    await vi.waitFor(() => expect(current.state.editorContainer.children[0], current.state.activityContainer.render(120).join('\n')).toBeInstanceOf(SessionPickerComponent));
    terminal.raw('First session\r');
    await vi.waitFor(() => expect(current.getCurrentSessionId()).toBe(first));
    await vi.waitFor(() => expect(Buffer.from(terminal.latest()['title']!, 'base64').toString()).toBe('First session'));
    terminal.raw(osc(`?ticket=${challenge}`));
    await vi.waitFor(() => expect(terminal.latest()['ticket']).toBeDefined());
    const exchange = await fetch(`${connection.url}/api/session-access/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: terminal.latest()['ticket'], verifier, client: { name: 'example-terminal' } }) });
    const issued = await exchange.json() as { data: { token: string } };
    await current.close();
    expect(terminal.latest()).toEqual({ state: 'clear', app: 'kiki' });
    expect((await fetch(`${connection.url}/api/sessions/${first}`, { headers: { Authorization: `Bearer ${issued.data.token}` } })).status).toBe(401);
    const reports = terminal.reports();
    for (let index = 1; index < reports.length; index += 1) expect(reports[index]).not.toBe(reports[index - 1]);
  }, 60_000);

  it.each([{ ephemeral: true }, { terminalHandoff: false }])('omits session tickets for %j', async (options) => {
    const { terminal, tui: current } = await boot(options);
    await vi.waitFor(() => expect(terminal.latest()['app']).toBe('kiki'));
    if (options.ephemeral) {
      await vi.waitFor(() => expect(terminal.latest()['handoff']).toBe('1'));
      expect(terminal.latest()).not.toHaveProperty('session');
    } else expect(terminal.latest()).not.toHaveProperty('handoff');
    const count = terminal.reports().length;
    terminal.raw(osc(`?ticket=${'a'.repeat(43)}`));
    await vi.waitFor(() => expect(terminal.reports()).toHaveLength(count + 1));
    expect(terminal.latest()).not.toHaveProperty('ticket');
    await current.close();
    expect(terminal.latest()['state']).toBe('clear');
  }, 60_000);
});

function statusFixture() {
  const terminal = new ReportingTerminal(120, 36);
  tui = new DaemonTUI({ url: 'http://127.0.0.1:57580', token: 'fixture' }, {
    cliOptions: { continue: false, yolo: false, auto: false, plan: false, agentFiles: [], skillsDirs: [] },
    tuiConfig: DEFAULT_TUI_CONFIG, version: '0.0.0-test', workDir: resolve(import.meta.dirname, '../../../../..'),
  }, terminal);
  const internal = tui as unknown as { programStatus: DaemonProgramStatus; renderSession(view: SessionViewState): void };
  tui.state.ui.start();
  tui.state.ui.setFocus(tui.state.editor);
  internal.programStatus.start();
  return { terminal, current: tui, internal, base: createViewState('fixture') };
}

describe('OSC 7501 status projection and early virtual-TTY input', () => {
  it('stays silent after DA1 wins the probe and consumes late probe and ticket replies', async () => {
    const { terminal, internal, current, base } = statusFixture();
    terminal.raw('\x1b[?62c');
    terminal.raw(osc('?version=0.4'));
    terminal.raw(osc(`?ticket=${'a'.repeat(43)}`));
    internal.renderSession({ ...base, busy: true });
    await current.close();
    expect(terminal.reports()).toEqual([]);
    expect(current.state.editor.getText()).toBe('');
  });

  it('projects work, completion, errors and blocked permission/question/auth states', async () => {
    const { terminal, internal, current, base } = statusFixture();
    terminal.raw(osc('?version=0.4'));
    expect(terminal.latest()['state']).toBe('idle');
    internal.renderSession({ ...base, busy: true });
    expect(terminal.latest()['state']).toBe('working');
    const ended = (turnId: string, state = 'completed'): SessionViewState => ({ ...base, turnTail: { turnId, state, endedAt: '2026-01-01T00:00:00Z', durationMs: 1, ttftMs: undefined, usage: undefined, tokensPerSecond: undefined } });
    current.state.terminalState.focused = false;
    internal.renderSession(ended('1'));
    expect(terminal.latest()['state']).toBe('done');
    terminal.raw('x');
    expect(terminal.latest()['state']).toBe('idle');
    internal.renderSession({ ...base, busy: true });
    internal.renderSession(ended('2'));
    expect(terminal.latest()['state']).toBe('done');
    terminal.raw('\x1b[I');
    expect(terminal.latest()['state']).toBe('idle');
    internal.renderSession({ ...base, busy: true });
    internal.renderSession(ended('3', 'cancelled'));
    expect(terminal.latest()['state']).toBe('idle');
    current.state.terminalState.focused = true;
    internal.renderSession({ ...base, busy: true });
    internal.renderSession(ended('4'));
    expect(terminal.latest()['state']).toBe('idle');
    internal.renderSession({ ...base, turnTail: { turnId: '1', state: 'failed', error: 'Provider unavailable', endedAt: '2026-01-01T00:00:00Z', durationMs: 1, ttftMs: undefined, usage: undefined, tokensPerSecond: undefined } });
    expect(terminal.latest()['state']).toBe('error');
    expect(Buffer.from(terminal.latest()['msg']!, 'base64').toString()).toBe('Provider unavailable');
    internal.renderSession({ ...base, busy: true, blocks: [{ kind: 'approval', id: 'approval', resolution: undefined, request: { approval_id: 'approval', session_id: 'fixture', tool_call_id: 'call', tool_name: 'Bash', action: 'Run tests', tool_input_display: {}, created_at: '2026-01-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' } }] });
    expect(terminal.latest()).toMatchObject({ state: 'blocked', kind: 'permission' });
    expect(Buffer.from(terminal.latest()['msg']!, 'base64').toString()).toBe('Bash: Run tests');
    internal.renderSession({ ...base, busy: true, blocks: [{ kind: 'question', id: 'question', outcome: undefined, request: { question_id: 'question', session_id: 'fixture', created_at: '2026-01-01T00:00:00Z', questions: [{ id: 'q1', question: 'Which branch?', options: [] }] } }] });
    expect(terminal.latest()).toMatchObject({ state: 'blocked', kind: 'question' });
    expect(Buffer.from(terminal.latest()['msg']!, 'base64').toString()).toBe('Which branch?');
    internal.renderSession(base);
    internal.programStatus.requireAuth('Sign in to continue');
    expect(terminal.latest()).toMatchObject({ state: 'blocked', kind: 'auth' });
    const count = terminal.reports().length;
    internal.programStatus.requireAuth('Sign in to continue');
    expect(terminal.reports()).toHaveLength(count);
    await current.close();
    expect(terminal.latest()).toEqual({ state: 'clear', app: 'kiki' });
  });

  it('consumes split reports before the editor, dialogs, pickers and bracketed paste', () => {
    const { terminal, current } = statusFixture();
    terminal.raw('\x1b]7501;?ver');
    terminal.raw('sion=0.4\x1b');
    terminal.raw('\\');
    expect(current.state.editor.getText()).toBe('');
    const assertConsumed = () => {
      terminal.raw('\x1b]7501;?tick');
      terminal.raw(`et=${'a'.repeat(43)}\x07`);
    };
    assertConsumed();
    expect(current.state.editor.getText()).toBe('');
    const input = vi.fn();
    const dialog = { render: () => ['Dialog'], handleInput: input, invalidate: () => {} };
    current.state.ui.setFocus(dialog);
    assertConsumed();
    expect(input).not.toHaveBeenCalled();
    const picker = new SessionPickerComponent({ sessions: [], loading: false, currentSessionId: '', onSelect: () => {}, onCancel: () => {} });
    const pickerInput = vi.spyOn(picker, 'handleInput');
    current.state.ui.setFocus(picker);
    assertConsumed();
    expect(pickerInput).not.toHaveBeenCalled();
    current.state.ui.setFocus(current.state.editor);
    terminal.raw(`\x1b[200~left${osc('?version=0.4')}`);
    terminal.raw(`${osc(`?ticket=${'b'.repeat(43)}`)}right\x1b[201~`);
    expect(current.state.editor.getText()).toBe('leftright');
  });
});

it('refreshes access metadata and presence after an idle daemon restart', async () => {
  const { terminal, client, tui: current } = await boot();
  const sessionId = current.getCurrentSessionId();
  const previousServer = terminal.latest()['server'];
  terminal.raw(osc(`?ticket=${'a'.repeat(43)}`));
  await vi.waitFor(() => expect(terminal.reports().some((sequence) => parseReport(sequence)['challenge'] === 'a'.repeat(43))).toBe(true));
  const port = server!.port;
  await server!.close();
  server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, homeDir: home!, host: '127.0.0.1', port, logLevel: 'silent' });
  const nextServer = (await client.getSessionAccess()).server_id;
  expect(nextServer).not.toBe(previousServer);
  await vi.waitFor(() => expect(terminal.latest()['server']).toBe(nextServer), { timeout: 15_000 });
  expect(terminal.latest()['session']).toBe(sessionId);
  terminal.raw(osc(`?ticket=${'b'.repeat(43)}`));
  await vi.waitFor(() => expect(terminal.reports().some((sequence) => parseReport(sequence)['challenge'] === 'b'.repeat(43))).toBe(true), { timeout: 5000 });
}, 60_000);

it.each(['\x03', '\x04'])('clears the report on a confirmed exit key %j', async (key) => {
  const { terminal } = statusFixture();
  terminal.raw(osc('?'));
  terminal.raw(key);
  expect(terminal.latest()['state']).not.toBe('clear');
  terminal.raw(key);
  await vi.waitFor(() => expect(terminal.latest()['state']).toBe('clear'));
});

it('clears the auth block when the browser login flow completes', async () => {
  const { terminal, current } = statusFixture();
  const internal = current as unknown as { client: DaemonClient; handleInput(text: string): Promise<void> };
  const flow = { flow_id: 'fixture-flow', provider: 'example', status: 'pending' as const, verification_uri: 'https://example.test/login', verification_uri_complete: 'https://example.test/login?code=code', user_code: 'code', expires_in: 300, interval: 1, expires_at: '2099-01-01T00:00:00Z' };
  vi.spyOn(urlUtils, 'openUrl').mockImplementation(() => {});
  vi.spyOn(internal.client.klient.global.auth, 'startLogin').mockResolvedValue(flow);
  const poll = vi.spyOn(internal.client.klient.global.auth, 'flow').mockResolvedValue({ ...flow, status: 'authenticated' });
  vi.spyOn(internal.client, 'listModels').mockResolvedValue({ items: [] });
  terminal.raw(osc('?'));
  await internal.handleInput('/login example');
  expect(terminal.latest()).toMatchObject({ state: 'blocked', kind: 'auth' });
  await vi.waitFor(() => expect(terminal.latest()['state']).toBe('idle'), { timeout: 2500 });
  expect(poll).toHaveBeenCalledWith('example');
});

it.each(['enter', 'alt-enter'])('reports auth rejection for %s submissions', async (key) => {
  const { terminal, current } = statusFixture();
  const internal = current as unknown as { handleInput(text: string): Promise<void> };
  vi.spyOn(internal, 'handleInput').mockRejectedValue(new ApiError({ code: ErrorCode.AUTH_TOKEN_MISSING, msg: 'Sign in required', data: null }));
  terminal.raw(osc('?'));
  current.state.editor.setText('Continue');
  if (key === 'enter') current.state.editor.onSubmit?.('Continue');
  else current.state.editor.onAltEnter?.();
  await vi.waitFor(() => expect(terminal.latest()).toMatchObject({ state: 'blocked', kind: 'auth' }));
});

it('shares TUI disposal and calls onExit only after clear for concurrent stop requests', async () => {
  const { terminal, current } = statusFixture();
  terminal.raw(osc('?'));
  const clear = current.clearProgramStatus.bind(current);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  vi.spyOn(current, 'clearProgramStatus').mockImplementation(async () => { await pending; await clear(); });
  const stopUi = vi.spyOn(current.state.ui, 'stop');
  current.onExit = vi.fn(async () => { expect(terminal.latest()['state']).toBe('clear'); });
  const first = current.stop();
  const second = current.stop(143);
  const closing = current.close();
  expect(second).toBe(first);
  expect(current.onExit).not.toHaveBeenCalled();
  expect(stopUi).not.toHaveBeenCalled();
  release();
  await Promise.all([first, second, closing]);
  expect(stopUi).toHaveBeenCalledOnce();
  expect(current.onExit).toHaveBeenCalledOnce();
});
