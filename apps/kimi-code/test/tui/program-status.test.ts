import { describe, expect, it, vi } from 'vitest';
import { encodeProgramStatus, ProgramStatusReporter, truncateProgramText } from '#/tui/utils/program-status';
import { DaemonProgramStatus } from '#/tui/daemon/program-status';
import { createViewState } from '@kiki/session-core/session/transcript/types';

const osc = (body: string, end = '\x1b\\') => `\x1b]7501;${body}${end}`;
const challenge = (char = 'a') => char.repeat(43);
const loadedViewState = (sessionId: string) => ({ ...createViewState(sessionId), loaded: true });
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
const fields = (report: string) => Object.fromEntries(report.slice(7, -2).split(':').map((field) => {
  const separator = field.indexOf('=');
  return [field.slice(0, separator), field.slice(separator + 1)];
}));

describe('OSC 7501 serialization', () => {
  it('encodes text, strips controls, and preserves delimiters inside base64 text', () => {
    const report = fields(encodeProgramStatus({ state: 'blocked', kind: 'question', title: '会话:一;二\x1b\n', msg: 'Choose:\nA;B\t\x07\x7f\x85' }));
    expect(report['state']).toBe('blocked');
    expect(report['kind']).toBe('question');
    expect(report['app']).toBe('kiki');
    expect(Buffer.from(report['title']!, 'base64').toString()).toBe('会话:一;二');
    expect(Buffer.from(report['msg']!, 'base64').toString()).toBe('Choose:A;B');
    expect(report).not.toHaveProperty('progress');
    expect(report).not.toHaveProperty('id');
  });

  it('truncates on UTF-8 codepoint boundaries with 192/2048 byte limits', () => {
    expect(truncateProgramText('a😺中', 7)).toBe('a😺');
    const report = fields(encodeProgramStatus({ state: 'working', title: '😺'.repeat(100), msg: '中'.repeat(1000) }));
    const title = Buffer.from(report['title']!, 'base64');
    const msg = Buffer.from(report['msg']!, 'base64');
    expect(title.byteLength).toBe(192);
    expect(msg.byteLength).toBe(2046);
    expect(title.toString()).not.toContain('�');
    expect(msg.toString()).not.toContain('�');
  });

  it('omits empty titles and kind on non-blocked reports and clears without extensions', () => {
    expect(encodeProgramStatus({ state: 'idle', kind: 'auth', title: '\n' })).toBe(osc('state=idle:app=kiki'));
    expect(encodeProgramStatus({ state: 'clear', title: 'ignored', handoff: { session: 's', port: '80', server: 'server' } })).toBe(osc('state=clear:app=kiki'));
  });

  it.each(['bad:value', 'bad;value'])('omits all extension keys for %s', (server) => {
    const report = fields(encodeProgramStatus({ state: 'idle', handoff: { session: 's', port: '80', server } }));
    for (const key of ['handoff', 'session', 'port', 'server']) expect(report).not.toHaveProperty(key);
  });

  it('shortens msg to keep the full report including ticket at 4096 bytes', () => {
    const encoded = encodeProgramStatus({ state: 'error', title: '😺'.repeat(100), msg: '中'.repeat(1000), handoff: { session: 's'.repeat(1000), port: '57580', server: 'server' } }, { ticket: challenge('t'), challenge: challenge() });
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(4096);
    const report = fields(encoded);
    expect(report['handoff']).toBe('1');
    expect(Buffer.from(report['msg']!, 'base64').byteLength).toBeLessThan(2048);
    expect(Buffer.from(report['msg']!, 'base64').toString()).not.toContain('�');
  });
});

describe('OSC 7501 negotiation and coalescing', () => {
  it('probes once, reports on success and field changes, and coalesces consecutive reports', () => {
    const writes: string[] = [];
    const reporter = new ProgramStatusReporter((data) => writes.push(data), async () => undefined);
    reporter.start();
    reporter.update({ state: 'working', title: 'Session' });
    expect(writes).toEqual([`${osc('?')}\x1b[c`]);
    reporter.handleInput(osc('?version=0.4', '\x07'));
    expect(fields(writes[1]!)).toMatchObject({ state: 'working', title: Buffer.from('Session').toString('base64') });
    reporter.update({ state: 'working', title: 'Session' });
    expect(writes).toHaveLength(2);
    reporter.update({ state: 'idle', title: 'Session' });
    expect(writes).toHaveLength(3);
    reporter.clear();
    reporter.clear();
    expect(writes.at(-1)).toBe(osc('state=clear:app=kiki'));
    expect(writes).toHaveLength(4);
  });

  it('locks out late support after DA1 arrives first and ignores ticket replies before support', async () => {
    const writes: string[] = [];
    const request = vi.fn(async () => challenge('t'));
    const reporter = new ProgramStatusReporter((data) => writes.push(data), request);
    reporter.start();
    reporter.handleInput(osc(`?ticket=${challenge()}`));
    reporter.handleInput('\x1b[?62c');
    reporter.handleInput(osc('?version=0.4'));
    reporter.update({ state: 'working' });
    reporter.clear();
    await flush();
    expect(request).not.toHaveBeenCalled();
    expect(writes).toEqual([`${osc('?')}\x1b[c`]);
  });

  it('consumes fragmented responses and strips replies from bracketed paste', () => {
    const reporter = new ProgramStatusReporter(() => {}, async () => undefined);
    expect(reporter.handleInput('\x1b]750')).toEqual({ consume: true });
    expect(reporter.handleInput('1;?ver')).toEqual({ consume: true });
    expect(reporter.handleInput('sion=0.4\x1b')).toEqual({ consume: true });
    expect(reporter.handleInput('\\')).toEqual({ consume: true });
    expect(reporter.supported).toBe(true);
    expect(reporter.handleInput(`\x1b[200~before${osc(`?ticket=${challenge()}`)}after\x1b[201~`)).toEqual({ data: '\x1b[200~beforeafter\x1b[201~' });
  });
});

describe('OSC 7501 ticket scheduling', () => {
  it('has one request in flight and replaces the waiting challenge with the newest', async () => {
    let resolveFirst!: (ticket: string | undefined) => void;
    const first = new Promise<string | undefined>((resolve) => { resolveFirst = resolve; });
    const request = vi.fn().mockImplementationOnce(() => first).mockResolvedValue(challenge('t'));
    const writes: string[] = [];
    const reporter = new ProgramStatusReporter((data) => writes.push(data), request);
    reporter.handleInput(osc('?'));
    reporter.handleInput(osc(`?ticket=${challenge('a')}`));
    reporter.handleInput(osc(`?ticket=${challenge('b')}`));
    reporter.handleInput(osc(`?ticket=${challenge('c')}`));
    expect(request).toHaveBeenCalledTimes(1);
    resolveFirst(challenge('t'));
    await flush();
    expect(request.mock.calls.map(([value]) => value)).toEqual([challenge('a'), challenge('c')]);
    expect(fields(writes.at(-1)!)['challenge']).toBe(challenge('c'));
    reporter.update({ state: 'idle' });
    expect(fields(writes.at(-1)!)).not.toHaveProperty('ticket');
  });

  it('answers only six tickets in a rolling minute and answers the seventh immediately with normal status', async () => {
    let now = 0;
    const request = vi.fn(async () => challenge('t'));
    const writes: string[] = [];
    const reporter = new ProgramStatusReporter((data) => writes.push(data), request, () => now);
    reporter.handleInput(osc('?'));
    for (let index = 0; index < 6; index += 1) {
      reporter.handleInput(osc(`?ticket=${challenge()}`));
      await flush();
    }
    reporter.handleInput(osc(`?ticket=${challenge()}`));
    expect(request).toHaveBeenCalledTimes(6);
    expect(writes.at(-1)).toBe(osc('state=idle:app=kiki'));
    now = 60_000;
    reporter.handleInput(osc(`?ticket=${challenge()}`));
    await flush();
    expect(request).toHaveBeenCalledTimes(7);
  });

  it('re-emits normal status for malformed challenge and refusal, without counting a refused ticket', async () => {
    const request = vi.fn(async () => { throw new Error('refused'); });
    const writes: string[] = [];
    const reporter = new ProgramStatusReporter((data) => writes.push(data), request);
    reporter.handleInput(osc('?'));
    reporter.handleInput(osc('?ticket=invalid'));
    expect(writes).toHaveLength(2);
    for (let index = 0; index < 7; index += 1) {
      reporter.handleInput(osc(`?ticket=${challenge()}`));
      await flush();
    }
    expect(request).toHaveBeenCalledTimes(7);
    expect(writes.every((sequence) => sequence === osc('state=idle:app=kiki'))).toBe(true);
  });
});


function handoffFixture(options: { url?: string; localOwner?: boolean; env?: NodeJS.ProcessEnv; ephemeral?: boolean } = {}) {
  const writes: string[] = [];
  let markReady!: () => void;
  let closePresence!: () => void;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const closed = new Promise<void>((resolve) => { closePresence = resolve; });
  const presence = { ready, closed, close: vi.fn(() => closePresence()) };
  const client = {
    getSessionAccess: vi.fn(async () => ({ enabled: true, terminal_handoff: true, server_id: 'server-one' })),
    openSessionAccessPresence: vi.fn((_holder: string) => presence),
    requestSessionAccessTicket: vi.fn(async (_session: string, _challenge: string, _holder: string) => ({ ticket: challenge('t') })),
    releaseSessionAccess: vi.fn(async (_holder: string, _session?: string, _signal?: AbortSignal) => ({ revoked: 1 })),
  };
  const status = new DaemonProgramStatus(client, { url: options.url ?? 'http://127.0.0.1:57580', token: 'owner', localOwner: options.localOwner ?? true }, (sequence) => writes.push(sequence), () => true, () => options.ephemeral ?? false, options.env ?? {});
  status.reporter.handleInput(osc('?'));
  return { status, client, writes, presence, markReady };
}

describe('OSC 7501 hand-off lifecycle', () => {
  it('waits for presence ready before minting a ticket, using one process holder ID', async () => {
    const { status, client, markReady, writes } = handoffFixture();
    await status.refreshConfig();
    await status.switchSession('first');
    status.update(loadedViewState('first'));
    status.input(osc(`?ticket=${challenge()}`));
    expect(client.openSessionAccessPresence).toHaveBeenCalledOnce();
    expect(client.requestSessionAccessTicket).not.toHaveBeenCalled();
    const holder = client.openSessionAccessPresence.mock.calls[0]![0];
    markReady();
    await flush();
    expect(client.requestSessionAccessTicket).toHaveBeenCalledWith('first', challenge(), holder);
    expect(holder).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(fields(writes.at(-1)!)['ticket']).toBe(challenge('t'));
    await status.dispose();
    expect(client.releaseSessionAccess).toHaveBeenLastCalledWith(holder, undefined, expect.any(AbortSignal));
    expect(writes.at(-1)).toBe(osc('state=clear:app=kiki'));
  });

  it('releases the old session before reporting the new one and discards a ticket minted across a switch', async () => {
    const { status, client, markReady, writes } = handoffFixture();
    await status.refreshConfig();
    await status.switchSession('first');
    status.update(loadedViewState('first'));
    markReady();
    let finishTicket!: (ticket: { ticket: string }) => void;
    client.requestSessionAccessTicket.mockImplementationOnce(() => new Promise((resolve) => { finishTicket = resolve; }));
    status.input(osc(`?ticket=${challenge()}`));
    await flush();
    expect(client.requestSessionAccessTicket).toHaveBeenCalledOnce();
    await status.switchSession('second');
    expect(client.releaseSessionAccess.mock.calls[0]![1]).toBe('first');
    status.update(loadedViewState('second'));
    expect(fields(writes.at(-1)!)['session']).toBe('second');
    finishTicket({ ticket: challenge('t') });
    await flush();
    expect(client.releaseSessionAccess.mock.calls.filter((call) => call[1] === 'first')).toHaveLength(2);
    expect(fields(writes.at(-1)!)['session']).toBe('second');
    expect(fields(writes.at(-1)!)).not.toHaveProperty('ticket');
    await status.dispose();
  });

  it('refreshes hand-off metadata and reopens existing presence after reconnection', async () => {
    const { status, client, markReady, presence, writes } = handoffFixture();
    await status.refreshConfig();
    await status.switchSession('first');
    status.update(loadedViewState('first'));
    markReady();
    status.input(osc(`?ticket=${challenge()}`));
    await flush();
    client.getSessionAccess.mockResolvedValueOnce({ enabled: true, terminal_handoff: true, server_id: 'server-two' });
    await status.refreshConfig();
    expect(client.getSessionAccess).toHaveBeenCalledTimes(2);
    expect(presence.close).toHaveBeenCalledOnce();
    expect(client.openSessionAccessPresence).toHaveBeenCalledTimes(2);
    expect(fields(writes.at(-1)!)['server']).toBe('server-two');
    await status.dispose();
  });

  it.each([
    { url: 'https://example.test:57580' },
    { localOwner: false },
    { env: { SSH_TTY: '/dev/pts/1' } },
    { env: { SSH_CONNECTION: '127.0.0.1 22 127.0.0.1 22' } },
  ])('does not query access or issue tickets outside local-owner terminals: %j', async (options) => {
    const { status, client, writes } = handoffFixture(options);
    await status.refreshConfig();
    await status.switchSession('first');
    status.update(loadedViewState('first'));
    status.input(osc(`?ticket=${challenge()}`));
    await flush();
    expect(client.getSessionAccess).not.toHaveBeenCalled();
    expect(client.openSessionAccessPresence).not.toHaveBeenCalled();
    expect(client.requestSessionAccessTicket).not.toHaveBeenCalled();
    expect(fields(writes.at(-1)!)).not.toHaveProperty('handoff');
    await status.dispose();
  });

  it.each(['http://localhost:57580', 'http://[::1]:57580'])('supports the other loopback host spelling %s', async (url) => {
    const { status, writes } = handoffFixture({ url });
    await status.refreshConfig();
    expect(fields(writes.at(-1)!)).toMatchObject({ handoff: '1', port: '57580', server: 'server-one' });
    await status.dispose();
  });
});

describe('OSC 7501 input and revocation regressions', () => {
  it('does not swallow Alt+], prefix mismatches, expired fragments or exit keys', () => {
    let now = 0;
    const reporter = new ProgramStatusReporter(() => {}, async () => undefined, () => now);
    for (const input of ['\x1b]', 'ordinary text', '\x03', '\x04']) expect(reporter.handleInput(input)).toBeUndefined();
    reporter.handleInput('\x1b]750');
    expect(reporter.handleInput('oops')).toEqual({ data: '\x1b]750oops' });
    reporter.handleInput('\x1b]7501;?');
    now = 201;
    expect(reporter.handleInput('normal')).toBeUndefined();
    reporter.handleInput('\x1b]7501;?');
    expect(reporter.handleInput('\x03')).toBeUndefined();
    reporter.handleInput('\x1b]7501;?');
    expect(reporter.handleInput('\x04')).toBeUndefined();
  });

  it('strips OSC-shaped pasted text without negotiating or requesting a ticket', async () => {
    const request = vi.fn(async () => challenge('t'));
    const reporter = new ProgramStatusReporter(() => {}, request);
    expect(reporter.handleInput(`\x1b[200~${osc('?')}\x1b[201~`)).toEqual({ data: '\x1b[200~\x1b[201~' });
    expect(reporter.supported).toBe(false);
    reporter.handleInput(osc('?'));
    reporter.handleInput(`\x1b[200~${osc(`?ticket=${challenge()}`)}\x1b[201~`);
    await flush();
    expect(request).not.toHaveBeenCalled();
  });

  it('discards a waiting request when the session changes instead of minting for the new session', async () => {
    const { status, client, markReady, writes } = handoffFixture();
    await status.refreshConfig();
    await status.switchSession('first');
    status.update(loadedViewState('first'));
    markReady();
    let finish!: (value: { ticket: string }) => void;
    client.requestSessionAccessTicket.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    status.input(osc(`?ticket=${challenge('a')}`));
    await flush();
    status.input(osc(`?ticket=${challenge('b')}`));
    await status.switchSession('second');
    status.update(loadedViewState('second'));
    finish({ ticket: challenge('t') });
    await flush();
    expect(client.requestSessionAccessTicket).toHaveBeenCalledTimes(1);
    expect(fields(writes.at(-1)!)).toMatchObject({ session: 'second' });
    expect(fields(writes.at(-1)!)).not.toHaveProperty('ticket');
    await status.dispose();
  });

  it('serializes session releases and retains the old session if revocation fails', async () => {
    const { status, client, markReady, presence, writes } = handoffFixture();
    await status.refreshConfig();
    await status.switchSession('first');
    status.update(loadedViewState('first'));
    markReady();
    status.input(osc(`?ticket=${challenge()}`));
    await flush();
    let release!: (value: { revoked: number }) => void;
    client.releaseSessionAccess.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const second = status.switchSession('second');
    const third = status.switchSession('third');
    await flush();
    expect(client.releaseSessionAccess).toHaveBeenCalledTimes(1);
    status.update(loadedViewState('third'));
    expect(fields(writes.at(-1)!)['session']).toBe('first');
    release({ revoked: 1 });
    await Promise.all([second, third]);
    expect(client.releaseSessionAccess.mock.calls.map((call) => call[1])).toEqual(['first', 'second']);
    status.update(loadedViewState('third'));
    client.releaseSessionAccess.mockRejectedValueOnce(new Error('release refused'));
    await expect(status.switchSession('fourth')).rejects.toThrow('release refused');
    expect(presence.close).toHaveBeenCalled();
    status.update(loadedViewState('third'));
    expect(fields(writes.at(-1)!)['session']).toBe('third');
    await status.dispose();
  });

  it('shares one teardown promise and clears after the bounded release', async () => {
    const { status, client, markReady, presence, writes } = handoffFixture();
    await status.refreshConfig();
    await status.switchSession('first');
    status.update(loadedViewState('first'));
    markReady();
    status.input(osc(`?ticket=${challenge()}`));
    await flush();
    let signal: AbortSignal | undefined;
    client.releaseSessionAccess.mockImplementationOnce((_holder, _session, abort) => new Promise((_resolve, reject) => {
      signal = abort;
      abort!.addEventListener('abort', () => reject(abort!.reason), { once: true });
    }));
    const closing = status.dispose();
    expect(status.dispose()).toBe(closing);
    expect(fields(writes.at(-1)!)['state']).not.toBe('clear');
    await closing;
    expect(signal!.aborted).toBe(true);
    expect(signal!.reason.name).toBe('TimeoutError');
    expect(presence.close).toHaveBeenCalledOnce();
    expect(writes.at(-1)).toBe(osc('state=clear:app=kiki'));
  });

  it('reopens missing presence when reconnect metadata is unchanged', async () => {
    const { status, client, markReady, presence } = handoffFixture();
    await status.refreshConfig();
    await status.switchSession('first');
    status.update(loadedViewState('first'));
    markReady();
    status.input(osc(`?ticket=${challenge()}`));
    await flush();
    presence.close();
    await flush();
    await status.refreshConfig();
    expect(client.openSessionAccessPresence).toHaveBeenCalledTimes(2);
    await status.dispose();
  });
});

it('retries an unexpectedly closed presence stream while the event socket stays healthy', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { status, client, markReady, presence } = handoffFixture();
  try {
    client.openSessionAccessPresence.mockReturnValueOnce(presence).mockReturnValue({ ready: Promise.resolve(), closed: new Promise<void>(() => {}), close: vi.fn() });
    await status.refreshConfig();
    await status.switchSession('first');
    status.update(loadedViewState('first'));
    markReady();
    status.input(osc(`?ticket=${challenge()}`));
    await flush();
    presence.close();
    await flush();
    expect(client.openSessionAccessPresence).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(client.openSessionAccessPresence).toHaveBeenCalledTimes(2);
    await status.dispose();
  } finally {
    vi.useRealTimers();
  }
});

it('refuses ticket arrivals throughout release and until the next session view is reported', async () => {
  const { status, client, markReady, writes } = handoffFixture();
  await status.refreshConfig();
  await status.switchSession('first');
  status.update(loadedViewState('first'));
  markReady();
  let finishTicket!: (value: { ticket: string }) => void;
  client.requestSessionAccessTicket.mockImplementationOnce(() => new Promise((resolve) => { finishTicket = resolve; }));
  status.input(osc(`?ticket=${challenge('a')}`));
  await flush();
  let finishRelease!: (value: { revoked: number }) => void;
  client.releaseSessionAccess.mockImplementationOnce(() => new Promise((resolve) => { finishRelease = resolve; }));
  const switched = status.switchSession('second');
  await flush();
  status.input(osc(`?ticket=${challenge('b')}`));
  finishRelease({ revoked: 1 });
  await switched;
  status.input(osc(`?ticket=${challenge('c')}`));
  finishTicket({ ticket: challenge('t') });
  await flush();
  expect(client.requestSessionAccessTicket).toHaveBeenCalledTimes(1);
  status.update(loadedViewState('second'));
  status.input(osc(`?ticket=${challenge('d')}`));
  await flush();
  expect(client.requestSessionAccessTicket).toHaveBeenCalledTimes(2);
  expect(fields(writes.at(-1)!)).toMatchObject({ session: 'second', challenge: challenge('d') });
  await status.dispose();
});
