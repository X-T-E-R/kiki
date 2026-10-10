// @vitest-environment jsdom

import { act, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  transcriptDetailKey,
  type Block,
  type TranscriptDetailStatus,
} from '@kiki/session-core/session';
import type { MediaRef } from '@kiki/session-core/composer/media';
import type { ContentRef } from '@kiki/transcript';

import { I18nProvider } from '../i18n';
import { ContentContinuation } from './ContentContinuation';
import { MediaPartList } from './mediaPreview';
import { ShellMessage } from './Transcript';
import { SessionRemainder, useSessionRemainderPending } from './SessionRemainder';
import { ToolCard } from './ToolCard';
import { contentSegmentKey, TranscriptDetailProvider } from './transcriptDetail';

const roots: Root[] = [];

// The original-file outlet needs a connection and a save sink; this file's
// other cases render without either.
const host = vi.hoisted(() => ({
  client: undefined as unknown as { downloadTranscriptContent: (sessionId: string, agentId: string, ref: ContentRef, consume: (chunk: Uint8Array, progress: unknown) => Promise<void>, options?: unknown) => Promise<unknown> } | undefined,
  openSaveSink: vi.fn(),
}));
vi.mock('../host', () => ({ useHost: () => ({ kind: 'browser', openSaveSink: host.openSaveSink }) }));
vi.mock('../state/connection', () => ({ useOptionalConnection: () => ({ client: host.client }) }));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem('kiki.locale', 'en');
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount(); });
  document.body.innerHTML = '';
});

async function render(node: ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    flushSync(() => { root.render(<MemoryRouter><I18nProvider>{node}</I18nProvider></MemoryRouter>); });
  });
  return container;
}

async function click(element: Element | null | undefined): Promise<void> {
  expect(element).toBeTruthy();
  await act(async () => { (element as HTMLElement).click(); });
}

const truncatedShell: Extract<Block, { kind: 'shell' }> = {
  kind: 'shell', id: 'shell-task', commandId: 'task-1', command: 'pnpm build',
  output: '…last line', outputDetail: { agentId: 'main', taskId: 'task-1' }, done: true, isError: undefined,
};

/** Detail provider backed by a controllable loader; mirrors the controller's load states. */
function Harness({ load, children }: {
  load: (setLoads: (next: Record<string, TranscriptDetailStatus>) => void) => Promise<boolean>;
  children: ReactNode;
}) {
  const [loads, setLoads] = useState<Record<string, TranscriptDetailStatus>>({});
  return (
    <TranscriptDetailProvider load={() => load(setLoads)} loads={loads}>
      {children}
    </TranscriptDetailProvider>
  );
}

function renderShell(block: Extract<Block, { kind: 'shell' }>, load: Parameters<typeof Harness>[0]['load']) {
  return render(<Harness load={load}><ShellMessage block={block} /></Harness>);
}

describe('on-demand transcript detail', () => {
  it('offers the full output for a truncated shell tail and shows loading, error and retry', async () => {
    const key = transcriptDetailKey('task', 'task-1');
    const load = vi.fn()
      .mockImplementationOnce(async (setLoads: (next: Record<string, TranscriptDetailStatus>) => void) => {
        setLoads({ [key]: { status: 'error', message: 'offline' } });
        return false;
      })
      .mockImplementationOnce(async (setLoads: (next: Record<string, TranscriptDetailStatus>) => void) => {
        setLoads({ [key]: { status: 'loading' } });
        return true;
      });
    const container = await renderShell(truncatedShell, load);
    await click(container.querySelector('[data-shell] button'));

    const row = () => container.querySelector('[data-shell-output-detail]');
    expect(row()?.getAttribute('data-shell-output-detail')).toBe('idle');
    expect(row()?.textContent).toContain('Showing the last lines only.');
    const action = () => container.querySelector<HTMLButtonElement>('[data-shell-output-detail-action]');
    expect(action()?.textContent).toBe('Show full output');

    await click(action());
    expect(row()?.getAttribute('data-shell-output-detail')).toBe('error');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Could not load the full output.');
    expect(action()?.textContent).toBe('Try again');

    await click(action());
    expect(row()?.getAttribute('data-shell-output-detail')).toBe('loading');
    expect(action()?.disabled).toBe(true);
    expect(action()?.getAttribute('aria-busy')).toBe('true');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shows no affordance when the output is already complete or no reader is available', async () => {
    const complete = await renderShell({ ...truncatedShell, outputDetail: undefined }, vi.fn());
    await click(complete.querySelector('[data-shell] button'));
    expect(complete.querySelector('[data-shell-output-detail]')).toBeNull();

    const readOnly = await render(<ShellMessage block={truncatedShell} />);
    await click(readOnly.querySelector('[data-shell] button'));
    expect(readOnly.querySelector('[data-shell-output-detail]')).toBeNull();
    expect(readOnly.querySelector('pre')?.textContent).toBe('…last line');
  });

  it('defers a windowed attachment until the reader asks for it', async () => {
    const item: MediaRef = { kind: 'image', name: 'screenshot.png', size: 912_000, mime: 'image/png', detail: { agentId: 'main', attachmentId: 'att-1' } };
    const load = vi.fn(async () => true);
    const container = await render(
      <Harness load={load}><MediaPartList media={[item]} /></Harness>,
    );
    const chip = container.querySelector<HTMLButtonElement>('[data-media-deferred]');
    expect(chip?.getAttribute('data-media-deferred')).toBe('idle');
    expect(chip?.getAttribute('aria-label')).toBe('Load screenshot.png');
    expect(container.querySelector('img')).toBeNull();
    expect(load).not.toHaveBeenCalled();
    await click(chip);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

type Shell = Extract<Block, { kind: 'shell' }>;
type Tool = Extract<Block, { kind: 'tool' }>;

/** One bounded field of one canonical entity, as the server published it. */
function boundedRef(
  source: ContentRef['source'],
  path: readonly (string | number)[],
  kind: ContentRef['kind'],
  offset: number,
  total: number,
): ContentRef {
  return { source, revision: 'rev-1', path: [...path], kind, offset, total };
}

const TASK_SOURCE: ContentRef['source'] = { kind: 'task', id: 'task-1' };
const FRAME_SOURCE: ContentRef['source'] = { kind: 'frame', id: 't1.1.call-1', turnId: 't1', stepId: 't1.1' };
const FRAME_BLOCK: Tool = {
  kind: 'tool', id: 'tool-call-1', toolCallId: 'call-1', frameId: 't1.1.call-1', stepId: 't1.1', turnId: 't1',
  name: 'Read', argsText: '{"file_path":"a.txt"}', args: { file_path: 'a.txt' }, display: undefined,
  description: undefined, status: 'done', output: 'first line', isError: undefined, durationMs: undefined,
  progressText: undefined,
};

/** A read that settles when the test says so. */
function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

interface ReadResult {
  readonly status?: TranscriptDetailStatus;
  /** The canonical refs the read leaves behind: the next segment, or none. */
  readonly refs?: readonly ContentRef[];
}

/**
 * Provider harness mirroring the controller: the request publishes a loading
 * state under the segment's own key, then the canonical refs the read left.
 */
function ContentHarness({ refs: initialRefs, read, sessionId, agentId, children }: {
  refs: readonly ContentRef[];
  read: (ref: ContentRef) => ReadResult | Promise<ReadResult>;
  /** The session and agent these refs address; an original-file read needs them. */
  sessionId?: string;
  agentId?: string;
  children: ReactNode;
}) {
  const [state, setState] = useState<{ readonly refs: readonly ContentRef[]; readonly loads: Record<string, TranscriptDetailStatus> }>(
    () => ({ refs: initialRefs, loads: {} }),
  );
  const loadContent = async (ref: ContentRef): Promise<boolean> => {
    const key = contentSegmentKey(ref);
    setState((current) => ({ ...current, loads: { ...current.loads, [key]: { status: 'loading' } } }));
    const result = await read(ref);
    setState((current) => {
      const loads = { ...current.loads };
      if (result.status === undefined) delete loads[key];
      else loads[key] = result.status;
      return { refs: result.refs ?? current.refs, loads };
    });
    return result.status === undefined;
  };
  return (
    <TranscriptDetailProvider
      load={() => Promise.resolve(false)}
      loads={state.loads}
      contentRefs={state.refs}
      sessionId={sessionId}
      agentId={agentId}
      loadContent={loadContent}
    >
      {children}
    </TranscriptDetailProvider>
  );
}

const boundedShell: Shell = {
  kind: 'shell', id: 'shell-task', commandId: 'call-1', frameId: 't1.1.call-1', stepId: 't1.1', turnId: 't1',
  command: 'pnpm build', output: '…last line', outputTaskId: 'task-1', done: true, isError: undefined,
};

function continuation(container: HTMLDivElement) {
  return {
    row: () => container.querySelector('[data-content-continuation]'),
    progress: () => container.querySelector('[data-content-continuation-progress]')?.textContent,
    action: () => container.querySelector<HTMLButtonElement>('[data-content-continuation-action]'),
    rows: () => container.querySelectorAll('[data-content-continuation]'),
  };
}

describe('bounded content continuation', () => {
  it('adds nothing when the server sent the whole body', async () => {
    const read = vi.fn(async (_ref: ContentRef): Promise<ReadResult> => ({}));
    const container = await render(
      <ContentHarness refs={[]} read={read}><ShellMessage block={boundedShell} /></ContentHarness>,
    );
    await click(container.querySelector('[data-shell] button'));
    expect(continuation(container).row()).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('reads one segment per press and stops offering once the last one lands', async () => {
    const ref = boundedRef(TASK_SOURCE, ['outputTail'], 'text', 1024, 1_048_576);
    const read = vi.fn(async (_ref: ContentRef): Promise<ReadResult> => ({ refs: [] }));
    const container = await render(
      <ContentHarness refs={[ref]} read={read}><ShellMessage block={boundedShell} /></ContentHarness>,
    );
    await click(container.querySelector('[data-shell] button'));
    const view = continuation(container);
    expect(view.row()?.getAttribute('data-content-continuation')).toBe('idle');
    expect(view.progress()).toBe('Output · <1% loaded');
    expect(view.action()?.textContent).toBe('Continue loading');
    expect(view.action()?.getAttribute('aria-label')).toBe('Continue loading Output');

    await click(view.action());
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[0]).toBe(ref);
    expect(view.row()).toBeNull();
    expect(container.querySelector('pre')?.textContent).toBe('…last line');
  });

  it('holds the body and reports the failure in place, then retries', async () => {
    const ref = boundedRef(TASK_SOURCE, ['outputTail'], 'text', 512, 4096);
    const read = vi.fn()
      .mockResolvedValueOnce({ status: { status: 'error', message: 'offline' } } satisfies ReadResult)
      .mockResolvedValueOnce({ refs: [] } satisfies ReadResult);
    const container = await render(
      <ContentHarness refs={[ref]} read={read}><ShellMessage block={boundedShell} /></ContentHarness>,
    );
    await click(container.querySelector('[data-shell] button'));
    const view = continuation(container);

    await click(view.action());
    expect(view.row()?.getAttribute('data-content-continuation')).toBe('error');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Could not load the rest of this content.');
    expect(view.action()?.textContent).toBe('Try again');
    expect(container.querySelector('pre')?.textContent).toBe('…last line');

    await click(view.action());
    expect(read).toHaveBeenCalledTimes(2);
    expect(view.row()).toBeNull();
  });

  it('shows the request in place and refuses a second press while it is open', async () => {
    const ref = boundedRef(TASK_SOURCE, ['outputTail'], 'text', 512, 4096);
    const pending = deferred<ReadResult>();
    const read = vi.fn((_ref: ContentRef) => pending.promise);
    const container = await render(
      <ContentHarness refs={[ref]} read={read}><ShellMessage block={boundedShell} /></ContentHarness>,
    );
    await click(container.querySelector('[data-shell] button'));
    const view = continuation(container);

    await click(view.action());
    expect(view.row()?.getAttribute('data-content-continuation')).toBe('loading');
    expect(view.action()?.disabled).toBe(true);
    expect(view.action()?.getAttribute('aria-busy')).toBe('true');
    expect(view.action()?.textContent).toContain('Loading more');

    await click(view.action());
    expect(read).toHaveBeenCalledTimes(1);

    await act(async () => { pending.resolve({ refs: [] }); });
    expect(view.row()).toBeNull();
  });

  it('counts array items from the contract, and keeps args and output in their own areas', async () => {
    const args = boundedRef(FRAME_SOURCE, ['input', 'content'], 'text', 512, 4096);
    const output = boundedRef(FRAME_SOURCE, ['output'], 'array', 4, 30);
    const read = vi.fn(async (_ref: ContentRef): Promise<ReadResult> => ({}));
    const container = await render(
      <ContentHarness refs={[args, output]} read={read}><ToolCard block={FRAME_BLOCK} /></ContentHarness>,
    );
    await click(container.querySelector('[data-tool] button'));
    const view = continuation(container);
    expect(view.rows().length).toBe(2);
    expect(view.progress()).toBe('Input · 12% loaded');
    expect(view.rows()[1]?.querySelector('[data-content-continuation-progress]')?.textContent)
      .toBe('Output · 4 / 30 items loaded');

    await click(view.rows()[1]?.querySelector('[data-content-continuation-action]'));
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[0]).toBe(output);
  });

  it('says how much of the body is still cut when more than one field is unread', async () => {
    const refs = [
      boundedRef(FRAME_SOURCE, ['output'], 'text', 1024, 8192),
      boundedRef(FRAME_SOURCE, ['error'], 'text', 16, 2048),
      boundedRef(FRAME_SOURCE, ['output', 'stderr'], 'text', 8, 1024),
    ];
    const container = await render(
      <ContentHarness refs={refs} read={vi.fn(async (): Promise<ReadResult> => ({}))}>
        <ToolCard block={FRAME_BLOCK} />
      </ContentHarness>,
    );
    await click(container.querySelector('[data-tool] button'));
    expect(continuation(container).progress()).toBe('Output · 12% loaded · 2 more parts cut off');
  });

  it('offers nothing for another frame, another field root, or a task', async () => {
    const refs = [
      boundedRef({ kind: 'frame', id: 't1.9.other', turnId: 't1', stepId: 't1.9' }, ['output'], 'text', 8, 64),
      boundedRef({ ...FRAME_SOURCE, turnId: 't2' }, ['output'], 'text', 8, 64),
      boundedRef(FRAME_SOURCE, ['progress', 'text'], 'text', 8, 64),
      boundedRef(FRAME_SOURCE, ['output'], 'text', 8, 64),
    ];
    const read = vi.fn(async (_ref: ContentRef): Promise<ReadResult> => ({}));
    const container = await render(
      <ContentHarness refs={refs} read={read}><ToolCard block={FRAME_BLOCK} /></ContentHarness>,
    );
    await click(container.querySelector('[data-tool] button'));
    const view = continuation(container);
    expect(view.rows().length).toBe(1);
    await click(view.action());
    expect(read.mock.calls[0]?.[0]).toBe(refs[3]);
  });

  it('offers the frame command line its own control in the shell card', async () => {
    const ref = boundedRef(FRAME_SOURCE, ['input', 'command'], 'text', 512, 7125);
    const read = vi.fn(async (_ref: ContentRef): Promise<ReadResult> => ({}));
    const container = await render(
      <ContentHarness refs={[ref]} read={read}><ShellMessage block={boundedShell} /></ContentHarness>,
    );
    await click(container.querySelector('[data-shell] button[aria-expanded]'));
    const view = continuation(container);
    expect(view.rows().length).toBe(1);
    expect(view.progress()).toBe('Command · 7% loaded');
    await click(view.action());
    expect(read.mock.calls[0]?.[0]).toBe(ref);
  });

  it('keeps a read bound to the agent it started from across a switch', async () => {
    const refA = boundedRef({ kind: 'task', id: 'task-a' }, ['outputTail'], 'text', 512, 2048);
    const refB = boundedRef({ kind: 'task', id: 'task-b' }, ['outputTail'], 'text', 9, 1024);
    const shell = (taskId: string): Shell => ({ ...boundedShell, outputTaskId: taskId });
    const pending = deferred<boolean>();
    const load = vi.fn((_agent: string, _ref: ContentRef) => pending.promise);
    function SwitchHarness() {
      const [agent, setAgent] = useState<'a' | 'b'>('a');
      const [loads, setLoads] = useState<Record<string, TranscriptDetailStatus>>({});
      return (
        <TranscriptDetailProvider
          load={() => Promise.resolve(false)}
          loads={loads}
          contentRefs={agent === 'a' ? [refA] : [refB]}
          loadContent={(ref: ContentRef) => {
            setLoads((current) => ({ ...current, [contentSegmentKey(ref)]: { status: 'loading' } }));
            return load(agent, ref);
          }}
        >
          <button type="button" data-switch-agent onClick={() => { setAgent((value) => (value === 'a' ? 'b' : 'a')); }}>switch</button>
          <ShellMessage block={shell(agent === 'a' ? 'task-a' : 'task-b')} />
        </TranscriptDetailProvider>
      );
    }
    const container = await render(<SwitchHarness />);
    await click(container.querySelector('[data-shell] button'));
    const view = continuation(container);
    expect(view.progress()).toBe('Output · 25% loaded');
    await click(view.action());
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]?.[0]).toBe('a');
    expect(load.mock.calls[0]?.[1]).toBe(refA);

    await click(container.querySelector('[data-switch-agent]'));
    expect(view.progress()).toBe('Output · <1% loaded');
    expect(view.row()?.getAttribute('data-content-continuation')).toBe('idle');

    await act(async () => { pending.resolve(false); });
    expect(view.row()?.getAttribute('data-content-continuation')).toBe('idle');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(view.action()?.textContent).toBe('Continue loading');
  });

  it('projects presentation spans for a range without changing its raw read offset', async () => {
    const ref: ContentRef = { source: { kind: 'frame', id: 'f', turnId: 't1', stepId: 's1' }, path: ['output'], revision: 'presented', kind: 'text', offset: 0, total: 600 };
    const readContentRange = vi.fn(async (_agentId: string, _contentRef: ContentRef, offset: number) => {
      expect(offset).toBe(0);
      return 'abcd';
    });
    const controller = {
      contentRefsFor: () => [ref],
      isContentRange: () => true,
      beginContentRead: () => ({ release() {}, retry() {} }),
      readContentRange,
    } as unknown as SessionController;
    const renderText = vi.fn((text: string) => <span data-presented-range>{text}</span>);
    const presentation = { spans: [{ start: 1, end: 3, kind: 'context' as const }] };
    const previousOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 240 });
    try {
      const container = await render(<TranscriptDetailProvider controller={controller} load={async () => false} loads={{}} sessionId="s" agentId="main"><ContentContinuation source={ref.source} roots={['output']} label="Output" presentation={presentation} renderText={renderText} /></TranscriptDetailProvider>);
      await act(async () => { await vi.waitFor(() => { expect(renderText).toHaveBeenCalledWith('ad'); }); });
      expect(container.querySelector('[data-presented-range]')?.textContent).toBe('ad');
      expect(container.querySelector('[data-presented-range]')?.parentElement?.className).toContain('whitespace-pre-wrap');
      expect(readContentRange).toHaveBeenCalledWith('main', ref, 0, expect.any(AbortSignal));
    } finally {
      if (previousOffsetHeight === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight');
      else Object.defineProperty(HTMLElement.prototype, 'offsetHeight', previousOffsetHeight);
    }
  });});

/**
 * The session's own remainder: refs that belong to no rendered body. Only the
 * fields a reading surface actually shows are offered, so the section and the
 * blank-transcript rule agree by construction.
 */
describe('session remainder', () => {
  function PendingProbe() {
    return <span data-remainder-probe={useSessionRemainderPending() ? 'yes' : 'no'} />;
  }

  it('offers nothing for a snapshot field no surface renders', async () => {
    // SCA-02's own counter-example: a legal custom key in the catchall metadata,
    // cut at the preview limit, with no client component that ever reads it.
    const hiddenMetadata = boundedRef({ kind: 'snapshot', id: '' }, ['session', 'metadata', 'review_unused_metadata'], 'text', 1024, 5024);
    const hiddenOffset = boundedRef({ kind: 'snapshot', id: '' }, ['context_tokens'], 'text', 1, 4);
    const read = vi.fn(async (_ref: ContentRef): Promise<ReadResult> => ({}));
    for (const hidden of [hiddenMetadata, hiddenOffset]) {
      const container = await render(
        <ContentHarness refs={[hidden]} read={read}><PendingProbe /><SessionRemainder /></ContentHarness>,
      );
      expect(container.querySelector('[data-session-remainder]')).toBeNull();
      // The blank-transcript rule reads the same selection, so an empty
      // session with only this ref still says it is empty.
      expect(container.querySelector('[data-remainder-probe]')?.getAttribute('data-remainder-probe')).toBe('no');
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps the outlet for the fields the header really shows', async () => {
    const read = vi.fn(async (_ref: ContentRef): Promise<ReadResult> => ({ refs: [] }));
    for (const path of [['session', 'title'], ['session', 'metadata', 'cwd'], ['session', 'agent_config']]) {
      const container = await render(
        <ContentHarness refs={[boundedRef({ kind: 'snapshot', id: '' }, path, 'text', 10, 100)]} read={read}>
          <PendingProbe /><SessionRemainder />
        </ContentHarness>,
      );
      expect(container.querySelector('[data-remainder-probe]')?.getAttribute('data-remainder-probe')).toBe('yes');
      expect(container.querySelector('[data-session-remainder]')).not.toBeNull();
    }
  });

  it('reads the session title and a roster entry one segment at a time', async () => {
    const title = boundedRef({ kind: 'snapshot', id: '' }, ['session', 'title'], 'text', 12, 40);
    const roster = boundedRef({ kind: 'roster', id: 'child-1' }, ['label'], 'text', 2, 8);
    const read = vi.fn(async (ref: ContentRef): Promise<ReadResult> => ({ refs: ref === title ? [roster] : [] }));
    const container = await render(
      <ContentHarness refs={[title, roster]} read={read}><PendingProbe /><SessionRemainder /></ContentHarness>,
    );
    expect(container.querySelector('[data-remainder-probe]')?.getAttribute('data-remainder-probe')).toBe('yes');
    // One quiet summary line until the reader opens it.
    expect(container.querySelector('[data-session-remainder-rows]')).toBeNull();
    await click(container.querySelector('[data-session-remainder-toggle]'));
    const sessionRow = container.querySelector('[data-continuation-kind="session"]');
    expect(sessionRow?.textContent).toContain('Session info');
    expect(sessionRow?.textContent).toContain('30% loaded');
    expect(container.querySelector('[data-continuation-kind="agents"]')?.textContent).toContain('Agents');
    await click(sessionRow?.querySelector('[data-content-continuation-action]'));
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[0]).toEqual(title);
    await click(container.querySelector('[data-continuation-kind="agents"] [data-content-continuation-action]'));
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1]?.[0]).toEqual(roster);
  });
});

/**
 * The original-file outlet beside a failed read: offered only for a field the
 * server keeps an original for, and only while the row is in error.
 */
describe('original-file download', () => {
  /** One reading area whose body the server cut, driven by the harness' reads. */
  function OutputArea({ source, roots }: { readonly source: ContentRef['source']; readonly roots: readonly string[] }) {
    return <ContentContinuation source={source} roots={roots} label="Output" />;
  }

  it('offers the original in the error state, and for no other field or state', async () => {
    // A frame's own `output` is one of the fields the server keeps an original
    // for; a turn's nested frame path is not.
    const withOriginal = boundedRef(FRAME_SOURCE, ['output'], 'text', 512, 4096);
    const read = vi.fn(async (_ref: ContentRef): Promise<ReadResult> => ({ status: { status: 'error', message: 'offline' } }));
    const sink = { streaming: true, write: vi.fn(async () => {}), close: vi.fn(async () => true), abort: vi.fn(async () => {}) };
    host.client = { downloadTranscriptContent: vi.fn(async (_session: string, _agent: string, _ref: ContentRef, consume: (chunk: Uint8Array, progress: unknown) => Promise<void>) => {
      await consume(new Uint8Array([1, 2, 3, 4]), { bytes: 4, mime: 'text/plain;charset=utf-8', notModified: false });
      return { bytes: 4, mime: 'text/plain;charset=utf-8', name: 'output.txt', notModified: false };
    }) };
    host.openSaveSink.mockResolvedValue(sink);
    const container = await render(
      <ContentHarness refs={[withOriginal]} read={read} sessionId="sess-1" agentId="main"><OutputArea source={FRAME_SOURCE} roots={['output']} /></ContentHarness>,
    );
    const view = continuation(container);
    // Idle: the row's own action is the way forward, so no second outlet.
    expect(view.row()?.getAttribute('data-content-continuation')).toBe('idle');
    expect(container.querySelector('[data-content-original-action]')).toBeNull();

    await click(view.action());
    expect(view.row()?.getAttribute('data-content-continuation')).toBe('error');
    const original = container.querySelector<HTMLButtonElement>('[data-content-original-action]');
    expect(original?.textContent).toContain('Download original');
    expect(original?.getAttribute('aria-label')).toBe('Download the original Output');
    expect(container.querySelector('[data-content-original]')?.getAttribute('data-content-original')).toBe('idle');
    // The failed read is still recoverable from the same row.
    expect(view.action()?.textContent).toBe('Try again');

    // Pressing it streams the same ref through the same sink, then closes.
    await click(original);
    expect(host.client.downloadTranscriptContent).toHaveBeenCalledWith(
      'sess-1', 'main', withOriginal, expect.any(Function), expect.anything(),
    );
    expect(sink.write).toHaveBeenCalledTimes(1);
    await act(async () => {});
    expect(sink.close).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-content-original]')?.getAttribute('data-content-original')).toBe('saved');

    // A cut value under the same field root but deeper in it (the contract
    // names an original only for a single-root field) still gets no outlet.
    const nested = boundedRef(FRAME_SOURCE, ['output', 'nested'], 'text', 512, 4096);
    const without = await render(
      <ContentHarness refs={[nested]} read={read} sessionId="sess-1" agentId="main"><OutputArea source={FRAME_SOURCE} roots={['output']} /></ContentHarness>,
    );
    await click(continuation(without).action());
    expect(without.querySelector('[data-content-original-action]')).toBeNull();
  });
});

/** A download in flight belongs to one row: leaving it, or cancelling, ends it. */
describe('original-file download scope', () => {
  function Area({ source, roots }: { readonly source: ContentRef['source']; readonly roots: readonly string[] }) {
    return <ContentContinuation source={source} roots={roots} label="Output" />;
  }

  it('cancels on a target change and on unmount, and returns the row to ready', async () => {
    const ref = boundedRef(FRAME_SOURCE, ['output'], 'text', 512, 4096);
    const read = vi.fn(async (_ref: ContentRef): Promise<ReadResult> => ({ status: { status: 'error', message: 'offline' } }));
    const signals: AbortSignal[] = [];
    const sink = { streaming: true, write: vi.fn(async () => {}), close: vi.fn(async () => true), abort: vi.fn(async () => {}) };
    // A real stream ends when its signal aborts; this one behaves that way, so
    // the test exercises the same settle path a cancelled download takes.
    host.client = { downloadTranscriptContent: vi.fn(async (_s: string, _a: string, _r: ContentRef, _c: unknown, options?: unknown) => {
      const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
      if (signal !== undefined) signals.push(signal);
      return new Promise<unknown>((_, reject) => {
        signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')); });
      });
    }) };
    host.openSaveSink.mockResolvedValue(sink);

    // The provider's own identity changes while the row stays mounted: this is
    // the real case a session or agent switch produces, and it is not an
    // unmount (a separate case below).
    function Target() {
      const [agentId, setAgentId] = useState('main');
      return (
        <>
          <button type="button" data-switch-agent onClick={() => { setAgentId((value) => (value === 'main' ? 'child' : 'main')); }}>switch</button>
          <ContentHarness refs={[ref]} read={read} sessionId="sess-1" agentId={agentId}>
            <Area source={FRAME_SOURCE} roots={['output']} />
          </ContentHarness>
        </>
      );
    }
    const container = await render(<Target />);
    await click(continuation(container).action());
    await click(container.querySelector('[data-content-original-action]'));
    expect(signals.length).toBe(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(container.querySelector('[data-content-original]')?.getAttribute('data-content-original')).toBe('downloading');
    // The row is still the same DOM node; only the target under it changed.
    expect(container.querySelectorAll('[data-content-original]')).toHaveLength(1);

    await click(container.querySelector('[data-switch-agent]'));
    expect(signals[0]?.aborted).toBe(true);
    expect(container.querySelector('[data-content-original]')?.getAttribute('data-content-original')).toBe('idle');
    expect(container.querySelector<HTMLButtonElement>('[data-content-original-action]')?.disabled).toBe(false);

    // Leaving the row entirely (here: it stops being rendered) also ends it.
    function Shown() {
      const [visible, setVisible] = useState(true);
      return (
        <>
          <button type="button" data-hide-row onClick={() => { setVisible(false); }}>hide</button>
          {visible
            ? <ContentHarness refs={[ref]} read={read} sessionId="sess-1" agentId="main"><Area source={FRAME_SOURCE} roots={['output']} /></ContentHarness>
            : null}
        </>
      );
    }
    const unmounting = await render(<Shown />);
    await click(continuation(unmounting).action());
    await click(unmounting.querySelector('[data-content-original-action]'));
    expect(signals.length).toBe(2);
    await click(unmounting.querySelector('[data-hide-row]'));
    expect(signals[1]?.aborted).toBe(true);

    // An explicit cancel returns the row to ready and abandons the save.
    const survivor = await render(<Target />);
    await click(continuation(survivor).action());
    const before = sink.abort.mock.calls.length;
    await click(survivor.querySelector('[data-content-original-action]'));
    expect(survivor.querySelector('[data-content-original]')?.getAttribute('data-content-original')).toBe('downloading');
    await click(survivor.querySelector('[data-content-original-cancel]'));
    await act(async () => {});
    expect(survivor.querySelector('[data-content-original]')?.getAttribute('data-content-original')).toBe('idle');
    expect(sink.abort.mock.calls.length).toBe(before + 1);
    expect(sink.close).not.toHaveBeenCalled();
  });

  it('keeps a press on its own client while the save picker is still open', async () => {
    const ref = boundedRef(FRAME_SOURCE, ['output'], 'text', 512, 4096);
    const read = vi.fn(async (_ref: ContentRef): Promise<ReadResult> => ({ status: { status: 'error', message: 'offline' } }));
    // The save picker is the one await here that can outlast a home switch, so
    // it is held open on purpose: the press has not reached the client yet.
    let openPicker!: (sink: unknown) => void;
    const picker = new Promise((resolve) => { openPicker = resolve; });
    const sink = { streaming: true, write: vi.fn(async () => {}), close: vi.fn(async () => true), abort: vi.fn(async () => {}) };
    const first = { downloadTranscriptContent: vi.fn(async () => ({ bytes: 2 })) };
    const second = { downloadTranscriptContent: vi.fn(async () => ({ bytes: 2 })) };
    host.client = first;
    host.openSaveSink.mockReturnValue(picker as unknown as Promise<typeof sink>);

    // The session, agent and ref never change here — only the client the
    // connection hands down, which is what a home switch looks like from inside
    // this row.
    function Home() {
      const [next, setNext] = useState(false);
      return (
        <>
          <button type="button" data-switch-home onClick={() => { host.client = next ? first : second; setNext((value) => !value); }}>switch home</button>
          <ContentHarness refs={[ref]} read={read} sessionId="sess-1" agentId="main">
            <Area source={FRAME_SOURCE} roots={['output']} />
          </ContentHarness>
        </>
      );
    }
    const container = await render(<Home />);
    await click(continuation(container).action());
    await click(container.querySelector('[data-content-original-action]'));
    // Still waiting on the picker: nothing has been sent to either client.
    expect(first.downloadTranscriptContent).not.toHaveBeenCalled();
    expect(second.downloadTranscriptContent).not.toHaveBeenCalled();

    await click(container.querySelector('[data-switch-home]'));
    openPicker(sink);
    await act(async () => {});
    // The press belonged to the old home, so its request is abandoned rather
    // than re-aimed: the new client is never asked for it, and the picker the
    // reader opened for it is not committed.
    expect(first.downloadTranscriptContent).not.toHaveBeenCalled();
    expect(second.downloadTranscriptContent).not.toHaveBeenCalled();
    expect(sink.close).not.toHaveBeenCalled();
    expect(sink.abort).toHaveBeenCalledTimes(1);
    // And the row is left pressable, not stuck mid-download.
    expect(container.querySelector('[data-content-original]')?.getAttribute('data-content-original')).not.toBe('downloading');
    expect(container.querySelector<HTMLButtonElement>('[data-content-original-action]')?.disabled).toBe(false);
  });
});


describe('real snapshot subagent remainder', () => {
  it('offers snapshot.subagents under the existing agents row and never offers hidden metadata', async () => {
    const ref = boundedRef({ kind: 'snapshot', id: '' }, ['subagents'], 'array', 4, 6);
    const hidden = boundedRef({ kind: 'snapshot', id: '' }, ['session', 'metadata', 'custom_hidden'], 'text', 3, 30);
    const loadContent = vi.fn(async () => true);
    const container = await render(<TranscriptDetailProvider load={async () => false} loads={{}} contentRefs={[hidden, ref]} loadContent={loadContent}><SessionRemainder /></TranscriptDetailProvider>);
    await click(container.querySelector('[data-session-remainder-toggle]'));
    expect(container.querySelectorAll('[data-content-continuation]')).toHaveLength(1);
    expect(container.querySelector('[data-continuation-kind="agents"]')).not.toBeNull();
    await click(container.querySelector('[data-content-continuation-action]'));
    expect(loadContent).toHaveBeenCalledWith(ref);
  });
});
