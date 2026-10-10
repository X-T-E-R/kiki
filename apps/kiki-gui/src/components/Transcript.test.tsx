// @vitest-environment jsdom

/**
 * Differential test for streaming markdown segmentation.
 *
 * AssistantMessage renders the settled streaming prefix as independently
 * memoized chunks (splitPrefixSegments) instead of one document, so a
 * paragraph-boundary delta re-parses only the newest chunk. That is only
 * legitimate if chunk-local parsing NEVER diverges from whole-document
 * parsing: this test renders both forms for every append prefix of a
 * simulated stream and requires the produced block-level DOM to be
 * byte-identical.
 *
 * The shiki code-engine loader is mocked out: highlighting is async and
 * would make the comparison timing-dependent; fence STRUCTURE still goes
 * through the production KikiCodeBlock chrome either way.
 *
 * Cases deliberately cover the constructs a naive blank-line splitter gets
 * wrong: >2KiB ``` and ~~~ fences containing blank lines, loose lists,
 * blockquote runs, and reference definitions (which force the single-
 * document fallback).
 */

import { act, useLayoutEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, MemoryRouter, RouterProvider, useLocation, useNavigationType } from 'react-router-dom';
import { clearNavHistory, getCurrentVisit, recordNavigation } from '../lib/navHistory';
import { getReadingSnapshot, saveReadingSnapshot, timelineSnapshotKey, type TimelineReadingSnapshot } from '../lib/navViewState';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ApprovalDecision, QuestionAnswer } from '@kiki/protocol';
import { projectPresentedText, type AgentTranscriptSnapshot } from '@kiki/transcript';

import {
  annotationOverrideId,
  getAnnotationOverridesSnapshot,
  readDraft,
  resetAnnotationOverridesForTests,
  selectionCarryoverPresentation,
  buildQuotePrefix,
  sourceTextVersion,
} from '@kiki/session-core/composer';
import {
  SessionController,
  agentTranscriptToBlocks,
  assistantMessageIdFromBlockId,
  buildAgentForest,
  createViewState,
  projectAgentTranscriptView,
  sessionAgentForestFromAgentSnapshots,
  type AgentForest,
  type Block,
  type DisplayNode,
  type SessionViewState,
  type ToolBlock,
} from '@kiki/session-core/session';
import { writeSettings } from '@kiki/session-core/settings';
import {
  ASSISTANT_FRAME_ID,
  CHILD_AGENT_ID,
  PROMPT_ID,
  USER_MESSAGE_ID,
  appendOps,
  childAppendOps,
  childResetSnapshot,
  childFailureWireRecords,
  childCancellationWireRecords,
  childRetryWireRecords,
  replayAgentWire,
  completeTurnOps,
  olderTurnSnapshot,
  opsEvent,
  resetEvent,
  spawnChildOps,
  userTurnSnapshot,
} from '@kiki/session-core/session/__fixtures__/canonicalTranscript';
import { I18nProvider } from '../i18n';
import { ConnectionProvider } from '../state/connection';
import { writeStoredConfig } from '../state/connectionConfig';
import { browserHost, HostProvider } from '../host';
import type { AgentTranscriptResponse, KikiClient } from '../lib/client';
import { revealSubagentCard } from './ActivityHistory';
import { locateInTimeline, normalizeTurnId, registerTimelineLocator, resetTimelineLocatorsForTests } from '../lib/timelineLocate';
import { Markdown } from './Markdown';
import { MediaPartList, MediaPreviewProvider } from './mediaPreview';
import { resolveSubagentToolCalls } from './subagentToolCalls';
import { ToolCard, toolIcon, resolvedToolName } from './ToolCard';
import {
  mergeSubagentRows,
  splitPrefixSegments,
  splitStreamingText,
  subagentAutoForm,
  Transcript,
  TranscriptLoading,
  TurnTailLine,
  type TranscriptRowActions,
} from './Transcript';
import { messageLinkHref } from './RowActions';
import { displayUserMessageText, editableUserMessageText } from './message/messageSource';

vi.mock('./markdown/streamdown-plugins', async (importOriginal) => {
  const original = await importOriginal<typeof import('./markdown/streamdown-plugins')>();
  return { ...original, useStreamdownPlugins: () => ({}) };
});

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];
const originalElementDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
const elementHeights = new WeakMap<Element, number>();
const blockHeights = new Map<string, number>();
const resizeObservers = new Set<TestResizeObserver>();

class TestResizeObserver {
  readonly observed = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObservers.add(this);
  }

  observe(target: Element): void {
    this.observed.add(target);
  }

  unobserve(target: Element): void {
    this.observed.delete(target);
  }

  disconnect(): void {
    this.observed.clear();
    resizeObservers.delete(this);
  }

  trigger(target: Element, blockSize: number): void {
    if (!this.observed.has(target)) return;
    this.callback([
      {
        target,
        borderBoxSize: [{ blockSize, inlineSize: 760 }],
      } as unknown as ResizeObserverEntry,
    ], this as unknown as ResizeObserver);
  }

  triggerWithoutBorderBoxSize(target: Element): void {
    if (!this.observed.has(target)) return;
    this.callback([{ target } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

function resizeElement(target: Element, blockSize: number): void {
  elementHeights.set(target, blockSize);
  for (const observer of resizeObservers) observer.trigger(target, blockSize);
}

function installElementProperty(key: PropertyKey, descriptor: PropertyDescriptor): void {
  originalElementDescriptors.set(key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key));
  Object.defineProperty(HTMLElement.prototype, key, { configurable: true, ...descriptor });
}

function restoreElementProperties(): void {
  for (const [key, descriptor] of originalElementDescriptors) {
    if (descriptor === undefined) delete (HTMLElement.prototype as unknown as Record<PropertyKey, unknown>)[key];
    else Object.defineProperty(HTMLElement.prototype, key, descriptor);
  }
}

function makeRoot(): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);
  return { root, container };
}

/**
 * Render and wait for quiescence. Streamdown commits re-parsed blocks via
 * `startTransition` (streamdown/dist/chunk-*.js: `useEffect(() => {
 * U(() => setBlocks(fe)) })`), so immediately after a flushSync render the
 * DOM still shows the PREVIOUS content — and the transition commit itself
 * chains through further scheduled work (observed: several macrotasks).
 * `await act(...)` drains React's act queue recursively until everything —
 * transitions included — has landed, so both sides are compared settled.
 */
let editFixture: import('node:child_process').ChildProcess | undefined;
let editFixturePort: number;
async function renderSettled(root: Root, node: ReactNode, connected = false): Promise<void> {
  if (connected) {
    if (editFixture === undefined) {
      const { spawn } = await import('node:child_process');
      editFixture = spawn(process.execPath, ['--input-type=module', '-e', "import { startFixtureServer } from './scripts/fixture-server.mjs'; const server = await startFixtureServer({port: 0, scenario: 'queue'}); console.log('TEST_FIXTURE_PORT:' + server.http.address().port);"], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise<void>((resolve, reject) => {
        let output = '';
        editFixture!.stdout!.on('data', (chunk) => {
          output += String(chunk);
          const port = /TEST_FIXTURE_PORT:(\d+)/.exec(output);
          if (port !== null) { editFixturePort = Number(port[1]); resolve(); }
        });
        editFixture!.once('error', reject);
        editFixture!.once('exit', (code) => { if (editFixturePort === undefined) reject(new Error(`fixture exited: ${code}`)); });
      });
    }
    writeStoredConfig({ url: `http://127.0.0.1:${editFixturePort}`, token: 'kiki-fixture-token' });
  }
  let ready = false;
  function ConnectedSurface() {
    useLayoutEffect(() => { ready = true; }, []);
    return node;
  }
  await act(async () => {
    flushSync(() => {
      root.render(
        <MemoryRouter>
          <I18nProvider>{connected ? <HostProvider host={browserHost}><ConnectionProvider><ConnectedSurface /></ConnectionProvider></HostProvider> : node}</I18nProvider>
        </MemoryRouter>,
      );
    });
  });
  if (connected) {
    for (let attempt = 0; !ready && attempt < 100; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    expect(ready).toBe(true);
  }
}

/**
 * Serialize the block-level markdown content of every `.kiki-md` in the
 * container, joined in document order. Streamdown wraps its blocks in an
 * inner structural div (`space-y-4 …`); chunking legitimately produces one
 * such wrapper per chunk, so the comparison unwraps it and compares the
 * concatenation of the actual block trees. The plain-prose fast path has no
 * inner wrapper (a bare `<p>`), which is kept as-is.
 */
function blocksHtml(container: HTMLDivElement): string {
  return [...container.querySelectorAll('.kiki-md')]
    .map((element) => {
      const inner = element.firstElementChild;
      return inner instanceof HTMLDivElement && element.childElementCount === 1
        ? inner.innerHTML
        : element.innerHTML;
    })
    .join('');
}

/** Whole-document reference render. */
async function fullHtml(root: Root, container: HTMLDivElement, prefix: string): Promise<string> {
  await renderSettled(root, <Markdown text={prefix} />);
  return blocksHtml(container);
}

/** Chunked render, structured exactly like AssistantMessage. */
async function segmentedHtml(root: Root, container: HTMLDivElement, prefix: string): Promise<string> {
  const segments = splitPrefixSegments(prefix);
  await renderSettled(
    root,
    <div className="kiki-md-segments">
      {segments.map((segment, index) => (
        <Markdown key={index} text={segment} preserveEdgeMargins />
      ))}
    </div>,
  );
  return blocksHtml(container);
}

/** Deterministic irregular append sizes, so deltas cross boundaries at
 * many different offsets within tokens. */
const STEP_SIZES = [1, 3, 7, 2, 11, 5, 13, 4];

/**
 * Replay the stream append-by-append; at every step where the settled
 * prefix advanced, the chunked render must equal the whole-document render.
 *
 * Each comparison uses FRESH roots: what is being verified is the semantic
 * property "for any settled prefix, chunk-local parsing produces the same
 * block tree as whole-document parsing". Reusing roots across steps would
 * additionally race Streamdown's internal `startTransition` block commits
 * (which lag by several macrotasks and are briefly stale by design in
 * production too) — eventually consistent, but not step-wise comparable.
 */
async function expectStreamingEquivalence(fullText: string): Promise<void> {
  let cursor = 0;
  let step = 0;
  let previousPrefix = '';
  let comparisons = 0;
  while (cursor < fullText.length) {
    cursor = Math.min(fullText.length, cursor + STEP_SIZES[step % STEP_SIZES.length]!);
    step += 1;
    const { prefix } = splitStreamingText(fullText.slice(0, cursor));
    if (prefix === previousPrefix) continue;
    previousPrefix = prefix;
    const full = makeRoot();
    const segmented = makeRoot();
    const expected = await fullHtml(full.root, full.container, prefix);
    const actual = await segmentedHtml(segmented.root, segmented.container, prefix);
    comparisons += 1;
    expect(
      actual,
      `chunked render diverged at prefix length ${prefix.length}:\n--- prefix ---\n${prefix}\n--- whole-document ---\n${expected}`,
    ).toBe(expected);
  }
  expect(comparisons).toBeGreaterThan(0);
}

function repeatTo(unit: string, minLength: number): string {
  let text = '';
  while (text.length < minLength) text += unit;
  return text;
}

beforeAll(() => {
  localStorage.setItem('kiki.locale', 'en');
  vi.stubGlobal('__KIKI_PROXY_TARGET__', 'http://127.0.0.1:58627');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  installElementProperty('offsetHeight', {
    get(this: HTMLElement) {
      if (this.hasAttribute('data-transcript-scroll')) return 320;
      if (this.hasAttribute('data-transcript-virtual-item')) {
        const blockId = this.querySelector<HTMLElement>('[data-block-id]')?.dataset['blockId'];
        return elementHeights.get(this) ?? (blockId === undefined ? undefined : blockHeights.get(blockId)) ?? 96;
      }
      return 0;
    },
  });
  installElementProperty('offsetWidth', {
    get(this: HTMLElement) {
      return this.hasAttribute('data-transcript-scroll') ? 760 : 0;
    },
  });
  installElementProperty('clientHeight', {
    get(this: HTMLElement) {
      return this.hasAttribute('data-transcript-scroll') ? 320 : 0;
    },
  });
  installElementProperty('scrollHeight', {
    get(this: HTMLElement) {
      if (!this.hasAttribute('data-transcript-scroll')) return 0;
      const content = this.querySelector<HTMLElement>('[data-transcript-virtual-content]');
      let height = Math.max(320, Number.parseFloat(content?.style.height ?? '0'));
      for (const item of this.querySelectorAll<HTMLElement>('[data-transcript-virtual-item]')) {
        height = Math.max(height, virtualItemStart(item) + item.offsetHeight + 60);
      }
      this.scrollTop = Math.min(this.scrollTop, height - 320);
      return height;
    },
  });
  installElementProperty('scrollTo', {
    value(this: HTMLElement, options: ScrollToOptions | number, y?: number) {
      const requested = typeof options === 'number' ? (y ?? 0) : (options.top ?? this.scrollTop);
      const behavior = typeof options === 'number' ? 'auto' : (options.behavior ?? 'auto');
      const apply = () => {
        this.scrollTop = Math.max(0, Math.min(requested, this.scrollHeight - this.clientHeight));
        this.dispatchEvent(new Event('scroll'));
      };
      // Smooth scrolls are progressive in a real browser. Jumping instantly
      // would put the viewport AT the target before the virtualizer's
      // reconcile tick, flipping its keepSmooth guard off and letting the
      // at-end re-pin yank the scroll back — deferring one frame preserves
      // the production invariant under jsdom.
      if (behavior === 'smooth' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => apply());
        return;
      }
      apply();
    },
  });
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      flushSync(() => {
        root.unmount();
      });
    });
  }
  for (const container of containers.splice(0)) container.remove();
});

afterAll(async () => {
  if (editFixture !== undefined) {
    const exited = new Promise<void>((resolve) => { editFixture!.once('exit', () => resolve()); });
    editFixture.kill();
    await exited;
  }
  restoreElementProperties();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  vi.unstubAllGlobals();
});

describe('splitPrefixSegments streaming differential', () => {
  it('keeps a >2KiB tilde fence with blank lines as one code block', { timeout: 60_000 }, async () => {
    const body = repeatTo('const answer = 42; // filler line inside the fence\n\n', 2600);
    const text = `Intro paragraph.\n\n~~~text\n${body}~~~\n\nClosing paragraph with **bold** text.`;
    // Guard the reviewer's reproduction directly: exactly one fence chrome.
    await expectStreamingEquivalence(text);
    const probe = makeRoot();
    await renderSettled(probe.root, <Markdown text={splitStreamingText(text).prefix} />);
    expect(probe.container.querySelectorAll('.kiki-cb')).toHaveLength(1);
  });

  it('keeps a >2KiB backtick fence with blank lines as one code block', { timeout: 60_000 }, async () => {
    const body = repeatTo('line of generated output that pads the fence\n\n', 2600);
    const text = `Before the fence.\n\n\`\`\`log\n${body}\`\`\`\n\nAfter the fence.`;
    await expectStreamingEquivalence(text);
    const probe = makeRoot();
    await renderSettled(probe.root, <Markdown text={splitStreamingText(text).prefix} />);
    expect(probe.container.querySelectorAll('.kiki-cb')).toHaveLength(1);
  });

  it('renders a >2KiB loose list identically across chunk boundaries', { timeout: 60_000 }, async () => {
    const items = repeatTo('- List item with enough prose to fill out the row nicely.\n\n', 2400);
    const text = `Lead-in.\n\n${items}Trailing paragraph.`;
    await expectStreamingEquivalence(text);
  });

  it('renders blockquote runs with blank lines identically', { timeout: 60_000 }, async () => {
    const quotes = repeatTo('> A quoted line that carries some prose weight.\n\n', 2400);
    const text = `Before the quotes.\n\n${quotes}After the quotes.`;
    await expectStreamingEquivalence(text);
  });

  it('falls back to single-document parsing when reference definitions exist', { timeout: 60_000 }, async () => {
    const text =
      'See [the first link][ref-a] early on.\n\n' +
      `${repeatTo('An intervening paragraph of prose.\n\n', 1200)}\n` +
      '[ref-a]: https://example.test/first\n' +
      '[ref-b]: https://example.test/second\n\n' +
      'Later text uses [the second link][ref-b] and a bare <https://example.test>.';
    // The fallback must actually engage for this fixture…
    expect(splitPrefixSegments(text)).toHaveLength(1);
    // …and the prefix built from every append step still matches the
    // whole-document render (trivially true in fallback, so this pins the
    // fallback itself against regressions).
    await expectStreamingEquivalence(text);
  });

  it('renders mixed prose (headings, lists, table, hr, inline code) identically', { timeout: 60_000 }, async () => {
    const section =
      '## Section heading\n\n' +
      'A paragraph with **bold**, *italic*, `inline code`, and a [link](https://example.test).\n\n' +
      '- tight item one\n- tight item two\n\n' +
      '| col a | col b |\n| --- | --- |\n| 1 | 2 |\n\n' +
      '---\n\n' +
      '> a short quote\n\n';
    const text = repeatTo(section, 2600);
    await expectStreamingEquivalence(text);
  });

  it('parses GFM constructs (table, strikethrough, task list) as elements', async () => {
    // Regression: passing Streamdown's `remarkPlugins` prop replaces its
    // default remark-gfm, so these used to render as raw pipe/tilde text.
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <Markdown
        text={
          '| col a | col b |\n| --- | --- |\n| 1 | 2 |\n\n' +
          '~~gone~~\n\n' +
          '- [x] done\n- [ ] todo\n'
        }
      />,
    );
    const cells = [...probe.container.querySelectorAll('td')].map((td) => td.textContent);
    expect(cells).toEqual(['1', '2']);
    expect(probe.container.querySelector('th')?.textContent).toBe('col a');
    expect(probe.container.querySelector('del')?.textContent).toBe('gone');
    const boxes = probe.container.querySelectorAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    expect((boxes[1] as HTMLInputElement).checked).toBe(false);
  });

  it('keeps app-page links in the current router while external links open separately', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <Markdown text={'[Usage](/usage) · [Docs](https://example.test/docs)'} />,
    );
    const usage = probe.container.querySelector<HTMLAnchorElement>('a[href="/usage"]');
    const docs = probe.container.querySelector<HTMLAnchorElement>('a[href="https://example.test/docs"]');
    expect(usage?.getAttribute('target')).toBeNull();
    expect(docs?.getAttribute('target')).toBe('_blank');
    expect(docs?.getAttribute('rel')).toContain('noopener');
  });

  it('chunks join back to the exact source and respect the size target', () => {
    const text = repeatTo('Paragraph number with prose.\n\n', 6000);
    const chunks = splitPrefixSegments(text);
    expect(chunks.join('')).toBe(text);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.length).toBeLessThanOrEqual(2200); // target + one block
    }
  });

  it('shows per-turn decode throughput in the turn tail', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <TurnTailLine
        tail={{
          turnId: '1',
          endedAt: new Date().toISOString(),
          durationMs: 4_200,
          ttftMs: 1_500,
          usage: {
            inputOther: 100,
            output: 30,
            inputCacheRead: 20,
            inputCacheCreation: 10,
          },
          tokensPerSecond: 19.6,
        }}
      />,
    );
    expect(probe.container.querySelector('[data-turn-tail]')?.textContent).toContain('20 tok/s');
  });

  it('labels crash recovery as an interruption and still offers resume', async () => {
    const probe = makeRoot();
    await renderSettled(probe.root, <TurnTailLine tail={{
      turnId: 't1', state: 'cancelled', cancellation: 'recovery',
      endedAt: new Date().toISOString(), durationMs: 1000,
      ttftMs: undefined, usage: undefined, tokensPerSecond: undefined,
    }} onResume={() => undefined} />);
    const tail = probe.container.querySelector('[data-turn-tail]');
    expect(tail?.textContent).toContain('Interrupted when Kiki restarted');
    expect(tail?.textContent).not.toContain('Stopped by you');
    expect(tail?.textContent).toContain('Resume');
  });

  it('keeps the user-stop label for an explicit cancellation', async () => {
    const probe = makeRoot();
    await renderSettled(probe.root, <TurnTailLine tail={{
      turnId: 't1', state: 'cancelled', cancellation: 'user',
      endedAt: new Date().toISOString(), durationMs: 1000,
      ttftMs: undefined, usage: undefined, tokensPerSecond: undefined,
    }} onResume={() => undefined} />);
    expect(probe.container.querySelector('[data-turn-tail]')?.textContent).toContain('Stopped by you');
  });

  it('ages the turn-tail clock instead of freezing at first render', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <TurnTailLine
        tail={{
          turnId: '1',
          endedAt: new Date(Date.now() - 9_000).toISOString(),
          durationMs: 4_200,
          ttftMs: 1_500,
          usage: {
            inputOther: 100,
            output: 30,
            inputCacheRead: 20,
            inputCacheCreation: 10,
          },
          tokensPerSecond: 19.6,
        }}
      />,
    );
    const text = () => probe.container.querySelector('[data-turn-tail]')?.textContent ?? '';
    expect(text()).toContain('just now');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_200)); });
    expect(text()).toMatch(/\d+s ago/);
    expect(text()).not.toContain('just now');
  });
});

describe('media preview wiring', () => {
  it('renders message image refs as thumbnails that open the lightbox', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work">
        <MediaPartList
          media={[{ kind: 'image', url: 'data:image/png;base64,AA', mime: 'image/png' }]}
        />
      </MediaPreviewProvider>,
    );
    const thumb = probe.container.querySelector('img');
    expect(thumb).not.toBeNull();
    expect(probe.container.textContent).not.toContain('Load full file');
    expect(probe.container.querySelector('a[download]')).toBeNull();
    expect(thumb?.getAttribute('src')).toBe('data:image/png;base64,AA');
    await act(async () => {
      thumb!.closest('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // The lightbox portals to document.body.
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AA');
    // Close the lightbox dialog so it does not leak modal state or escape handlers.
    await act(async () => {
      flushSync(() => {
        probe.root.unmount();
      });
    });
  });

  it('places user message media above the message text', async () => {
    const container = await renderTranscript([
      userBlock({
        id: 'u-media',
        text: 'look at this',
        media: [{ kind: 'image', url: 'data:image/png;base64,AA', mime: 'image/png' }],
      }),
    ]);
    const img = container.querySelector('img');
    expect(container.querySelector('[data-user-media]')?.textContent).not.toContain('Load full file');
    expect(container.querySelector('[data-user-media] a[download]')).toBeNull();
    const bubble = [...container.querySelectorAll('div')].find(
      (div) => div.textContent === 'look at this',
    );
    expect(img).not.toBeNull();
    expect(bubble).not.toBeNull();
    expect(
      img!.compareDocumentPosition(bubble!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('renders file refs as chips with name and size', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work">
        <MediaPartList
          media={[{ kind: 'file', fileId: 'upl_1', name: 'report.pdf', mime: 'application/pdf', size: 4096 }]}
        />
      </MediaPreviewProvider>,
    );
    expect(probe.container.textContent).toContain('report.pdf');
    expect(probe.container.textContent).toContain('4.0 KB');
  });

  it('opens file-id attachments through the session preview dialog', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work" sessionId="session_test">
        <MediaPartList
          media={[{ kind: 'file', fileId: 'upl_1', name: 'report.pdf', mime: 'application/pdf', size: 4096 }]}
        />
      </MediaPreviewProvider>,
    );
    const chip = [...probe.container.querySelectorAll('button')].find(
      (button) => button.textContent?.includes('report.pdf') === true,
    );
    expect(chip).toBeDefined();
    await act(async () => {
      chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const preview = document.body.querySelector('[data-attachment-preview]');
    expect(preview).not.toBeNull();
    expect(preview?.closest('[role="dialog"]')?.getAttribute('aria-label')).toContain('report.pdf');
    await act(async () => {
      flushSync(() => {
        probe.root.unmount();
      });
    });
  });

  it('opens the file preview pane from a workspace-relative markdown link', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work/app">
        <Markdown text={'See [the config](./config/app.toml) for details.'} />
      </MediaPreviewProvider>,
    );
    const link = probe.container.querySelector('a');
    expect(link?.getAttribute('title')).toBe('/work/app/config/app.toml');
    await act(async () => {
      link!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // The pane portals to document.body; without a connection the body shows
    // the failure notice, but the header still names the file.
    expect(document.body.textContent).toContain('app.toml');
    expect(document.body.textContent).toContain('/work/app/config/app.toml');
    await act(async () => {
      flushSync(() => {
        probe.root.unmount();
      });
    });
  });

  it('keeps app routes as router links even inside the preview provider', async () => {
    const probe = makeRoot();
    await renderSettled(
      probe.root,
      <MediaPreviewProvider cwd="/work/app">
        <Markdown text={'[Usage](/usage)'} />
      </MediaPreviewProvider>,
    );
    const link = probe.container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/usage');
    expect(link?.getAttribute('title')).toBeNull();
    await act(async () => {
      flushSync(() => {
        probe.root.unmount();
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Message-closure row actions + collapsible user messages. These render the
// full Transcript; the ResizeObserver stub from beforeAll covers both the
// virtualizer and the collapse hook's observer path (the hook's synchronous
// first measure is what the collapse tests drive).

function transcriptState(
  blocks: Block[],
  overrides: Partial<SessionViewState> = {},
): SessionViewState {
  return { ...createViewState('session_test'), loaded: true, transcriptReady: true, blocks, ...overrides };
}

function noopActions(): Promise<void> {
  return Promise.resolve();
}

async function renderTranscript(
  blocks: Block[],
  rowActions?: TranscriptRowActions,
  stateOverrides?: Partial<SessionViewState>,
  transcriptProps?: Partial<ComponentProps<typeof Transcript>>,
): Promise<HTMLDivElement> {
  const { root, container } = makeRoot();
  await renderSettled(
    root,
    <Transcript
      state={transcriptState(blocks, stateOverrides)}
      onLoadOlder={() => Promise.resolve(false)}
      onResolveApproval={() => noopActions()}
      onAnswerQuestion={() => noopActions()}
      onDismissQuestion={() => noopActions()}
      rowActions={rowActions}
      {...transcriptProps}
    />,
    rowActions !== undefined,
  );
  return container;
}

function userBlock(
  overrides: Partial<Extract<Block, { kind: 'user' }>> & { id: string; text: string },
): Extract<Block, { kind: 'user' }> {
  return { kind: 'user', createdAt: '2026-01-01T00:00:00.000Z', ...overrides };
}

function assistantBlock(id: string, text: string): Extract<Block, { kind: 'assistant' }> {
  return { kind: 'assistant', id, text, streaming: false, createdAt: '2026-01-01T00:00:01.000Z' };
}

/**
 * The row actions split in two surfaces: the flat icons the row shows on hover
 * (`data-row-action`) and the trailing `⋯` popover (`data-row-action-menu` for
 * the breakpoint copies of those icons, plain `data-row-action` for the
 * menu-only link/fork). Each action keeps exactly one `data-row-action` node.
 */
function rowActionButtons(row: Element): string[] {
  return [...row.querySelectorAll('[data-row-action]')].map(
    (el) => el.getAttribute('data-row-action') ?? '',
  );
}

function rowMenuItems(row: Element): string[] {
  return [...row.querySelectorAll('[data-row-action-menu]')].map(
    (el) => el.getAttribute('data-row-action-menu') ?? '',
  );
}

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

/**
 * Let one deferred frame land before a test opens a transient menu. The
 * transcript's own scroll (`scrollTo` is stubbed one frame late for smooth
 * jumps) fires a real scroll event, and the row-actions `⋯` closes on scroll by
 * design — so a frame that happens to land after the click would close a menu
 * the test just opened. In a browser the reader's scroll has long settled.
 */
async function drainDeferredFrames(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => { setTimeout(resolve, 40); });
  });
}

describe('user message token projection', () => {
  it('keeps slash-prefixed plain messages as verbatim user text', async () => {
    const container = await renderTranscript([
      userBlock({ id: 'user-slash', text: '/lint please' }),
      userBlock({ id: 'user-session-path', text: '/s/session_example' }),
    ]);

    expect(container.querySelector('[data-block-id="user-slash"]')?.textContent).toContain(
      '/lint please',
    );
    // A session route is a thread link: it renders as a thread chip, never a skill.
    const threadChip = container.querySelector('[data-block-id="user-session-path"] [data-thread-ref-chip="session_example"]');
    expect(threadChip?.getAttribute('href')).toBe('/s/session_example');
    expect(threadChip?.textContent).toContain('Thread example');
    expect(container.querySelector('[data-ref-chip="skill"]')).toBeNull();
    expect(container.querySelector('[data-skill]')).toBeNull();
  });

  it('shows thread links as chips and keeps the model-only context block out of the bubble', async () => {
    const id = 'session_0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
    const body = `compare with /s/${id} first`;
    const context = `<thread_refs>\n<thread_ref id="${id}" status="idle"/>\nRead it with ThreadRead.\n</thread_refs>`;
    const sent = `${body}\n\n${context}`;
    const presentation = { spans: [{ start: body.length, end: sent.length, kind: 'context' as const }] };
    const container = await renderTranscript([userBlock({ id: 'user-thread-ref', text: sent, presentation })]);
    const bubble = container.querySelector('[data-block-id="user-thread-ref"]')!;
    expect(bubble.querySelector(`[data-thread-ref-chip="${id}"]`)).not.toBeNull();
    expect(bubble.textContent).toContain('compare with');
    expect(bubble.textContent).toContain('first');
    expect(bubble.textContent).not.toContain('thread_ref');
    expect(bubble.textContent).not.toContain('ThreadRead');
  });

  it('hides a generated thread context and file notice while keeping the attachment chip', async () => {
    const id = 'session_7f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
    const body = `compare with /s/${id} first`;
    const threadContext = `<thread_refs>\n<thread_ref id="${id}" status="idle"/>\nRead it with ThreadRead.\n</thread_refs>`;
    const fileNotice = 'Attached file "report.pdf" (application/pdf, 4096 bytes): C:/work/report.pdf — open it with the Read tool';
    const sent = `${body}\n\n${threadContext}\n\n${fileNotice}`;
    const threadStart = body.length + 2;
    const attachmentStart = threadStart + threadContext.length + 2;
    const presentation = {
      spans: [
        { start: threadStart, end: threadStart + threadContext.length, kind: 'context' as const },
        {
          start: attachmentStart,
          end: sent.length,
          kind: 'attachment' as const,
          attachment: { path: 'C:/work/report.pdf', name: 'report.pdf', mime: 'application/pdf', size: 4096 },
        },
      ],
    };
    const container = await renderTranscript([userBlock({
      id: 'user-thread-file',
      text: sent,
      presentation,
      media: [{ kind: 'file', path: 'C:/work/report.pdf', name: 'report.pdf', mime: 'application/pdf', size: 4096 }],
    })]);
    const row = container.querySelector('[data-block-id="user-thread-file"]')!;
    expect(row.querySelector(`[data-thread-ref-chip="${id}"]`)).not.toBeNull();
    expect(row.querySelector('[data-user-media]')?.textContent).toContain('report.pdf');
    expect(row.querySelector('[data-user-media]')?.textContent).toContain('4.0 KB');
    expect(row.textContent).not.toContain('thread_ref');
    expect(row.textContent).not.toContain('Attached file');
    expect(row.textContent).not.toContain('C:/work/report.pdf');
  });

  it('keeps user-authored unknown XML, code, quotes, and comments literal', async () => {
    const raw = [
      '```xml',
      '<thread_refs>',
      '<unknown_ref id="literal"/>',
      '</thread_refs>',
      '<system-reminder>literal reminder</system-reminder>',
      '```',
      '',
      '> A user-authored quote',
      '',
      'Comment: keep this note literal',
    ].join('\n');
    const container = await renderTranscript([userBlock({ id: 'user-raw-envelope', text: raw })]);
    const body = container.querySelector('[data-source-block-id="user-raw-envelope"]')!;
    expect(body.textContent).toBe(raw);
    expect(container.querySelector('[data-user-context]')).toBeNull();
    expect(container.querySelector('[data-thread-ref-chip]')).toBeNull();
  });

  it('still decorates subagent references without promoting slash prose to a skill', async () => {
    const container = await renderTranscript([
      userBlock({ id: 'user-mixed-reference', text: 'ask @reviewer to inspect /plan' }),
    ]);

    expect(container.querySelector('[data-ref-chip="subagent"]')?.textContent).toBe('@reviewer');
    expect(container.querySelector('[data-ref-chip="skill"]')).toBeNull();
    expect(container.textContent).toContain('/plan');
  });
});

describe('timeline annotations', () => {
  it('marks the passage a draft note quotes and routes popover edits to the draft callbacks', async () => {
    const quote = 'batches transcript blocks into floors';
    const comment = 'Keep the floor boundary explicit';
    const onSave = vi.fn();
    const onRemove = vi.fn();
    const container = await renderTranscript(
      [
        assistantBlock(
          'assistant-annotation-source',
          'The renderer **batches transcript blocks into floors** so long sessions stay cheap.',
        ),
        userBlock({ id: 'user-plain', text: 'noted' }),
      ],
      undefined,
      undefined,
      {
        draftAnnotations: [{ id: 'draft-note-1', quote, comment }],
        onSaveDraftAnnotation: onSave,
        onRemoveDraftAnnotation: onRemove,
      },
    );

    const mark = container.querySelector<HTMLElement>('mark[data-annotation-ref="draft-note-1"]')!;
    expect(mark.textContent).toContain(quote);
    expect(mark.getAttribute('aria-haspopup')).toBe('dialog');

    await act(async () => { click(mark); });
    const panel = document.body.querySelector<HTMLElement>('[data-annotation-panel]')!;
    const input = panel.querySelector<HTMLInputElement>('[data-annotation-panel-input]')!;
    expect(panel.textContent).toContain(quote);
    expect(input.value).toBe(comment);

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'edited');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { click(panel.querySelector('[data-annotation-panel-save]')!); });
    expect(onSave).toHaveBeenCalledWith('draft-note-1', 'edited');

    await act(async () => { click(panel.querySelector('[data-annotation-panel-remove]')!); });
    expect(onRemove).toHaveBeenCalledWith('draft-note-1');
    expect(document.body.querySelector('[data-annotation-panel]')).toBeNull();
    // The draft state is the owner's: without it the local overlay store stays untouched.
    expect(getAnnotationOverridesSnapshot()).toEqual({});
  });

  it('keeps a sent note visible on its source as well as in the message bubble', async () => {
    resetAnnotationOverridesForTests();
    const quote = 'batches transcript blocks into floors';
    const originalComment = 'Floor batching keeps long sessions cheap';
    const carry = selectionCarryoverPresentation([{ quote, comment: originalComment }], null);
    const container = await renderTranscript([
      assistantBlock(
        'assistant-annotation-source',
        'The renderer **batches transcript blocks into floors** so long sessions stay cheap.',
      ),
      userBlock({
        id: 'user-annotation-carrier',
        text: `${carry.prefix}Please factor this in.`,
        presentation: carry.presentation,
      }),
    ]);

    expect(container.querySelector('mark[data-annotation-ref]')?.textContent).toContain(quote);
    const bubble = container.querySelector<HTMLElement>('[data-annotation-bubble="user-annotation-carrier"]')!;
    expect(bubble).not.toBeNull();

    await act(async () => { click(bubble); });
    let panel = document.body.querySelector<HTMLElement>('[data-annotation-bubble-panel]')!;
    expect(panel.textContent).toContain(quote);
    expect(panel.textContent).toContain(originalComment);

    // Edits write the same local overlay store the old timeline editor used.
    const editedComment = 'Keep the floor boundary explicit';
    await act(async () => { click(panel.querySelector('[data-annotation-bubble-edit]')!); });
    panel = document.body.querySelector<HTMLElement>('[data-annotation-bubble-panel]')!;
    const input = panel.querySelector<HTMLInputElement>('[data-annotation-bubble-input]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, editedComment);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { click(panel.querySelector('[data-annotation-bubble-save]')!); });
    const noteId = annotationOverrideId(quote, originalComment, 'user-annotation-carrier', 0);
    expect(getAnnotationOverridesSnapshot()[noteId]?.comment).toBe(editedComment);
    expect(document.body.querySelector('[data-annotation-bubble-panel]')!.textContent).toContain(editedComment);

    // Removing the only note folds the bubble away entirely.
    await act(async () => {
      click(document.body.querySelector<HTMLElement>('[data-annotation-bubble-panel] [data-annotation-bubble-remove]')!);
    });
    expect(getAnnotationOverridesSnapshot()[noteId]?.deleted).toBe(true);
    expect(container.querySelector('[data-annotation-bubble]')).toBeNull();
    expect(container.querySelector('mark[data-annotation-ref]')).toBeNull();
    expect(document.body.querySelector('[data-annotation-bubble-panel]')).toBeNull();
    resetAnnotationOverridesForTests();
  });

  it('hides a generated source prefix only when its presentation metadata is present', async () => {
    const source = { blockId: 'assistant-source-prefix', version: sourceTextVersion('quoted'), start: 0, end: 6, text: 'quoted' };
    const carry = selectionCarryoverPresentation([], 'quoted', source);
    const presented = await renderTranscript([
      assistantBlock('assistant-source-prefix', 'quoted source'),
      userBlock({ id: 'user-presented-source', text: `${carry.prefix}follow up`, presentation: carry.presentation }),
    ]);
    const raw = await renderTranscript([
      assistantBlock('assistant-raw-source-prefix', 'quoted source'),
      userBlock({ id: 'user-raw-source', text: `${carry.prefix}follow up` }),
    ]);
    expect(presented.querySelector('[data-block-id="user-presented-source"]')?.textContent).not.toContain('kiki-source:');
    expect(raw.querySelector('[data-block-id="user-raw-source"]')?.textContent).toContain('kiki-source:');
  });

  it('renders two multiline annotations without leaking source anchor comments', async () => {
    const sourceText = 'first second';
    const source = {
      blockId: 'assistant-multiline-source',
      version: sourceTextVersion(sourceText),
      start: 5,
      end: 11,
      text: 'second',
    };
    const carry = selectionCarryoverPresentation([
      { quote: 'first', comment: 'first note\nwith detail' },
      { quote: 'second', comment: 'second note', source },
    ], null);
    const container = await renderTranscript([
      assistantBlock('assistant-multiline-source', sourceText),
      userBlock({ id: 'user-multiline-annotations', text: `${carry.prefix}follow up`, presentation: carry.presentation }),
    ]);
    const row = container.querySelector('[data-block-id="user-multiline-annotations"]')!;
    expect(row.querySelectorAll('[data-annotation-bubble="user-multiline-annotations"]')).toHaveLength(2);
    expect(container.querySelectorAll('mark[data-annotation-ref]')).toHaveLength(2);
    expect(row.textContent).toContain('follow up');
    expect(row.textContent).not.toContain('kiki-source:');
    expect(row.textContent).not.toContain('Comment:');
  });

  it.each([undefined, 'queued'] as const)('marks the captured older message without guessing another source (%s carrier)', async (promptStatus) => {
    const text = 'same same tail';
    const source = { blockId: 'older-source', version: sourceTextVersion(text), start: 4, end: 8, text: 'same' };
    const carry = selectionCarryoverPresentation([
      { quote: 'same', comment: 'second occurrence', source },
      { quote: 'same', comment: 'invalid version', source: { ...source, version: 'stale' } },
      { quote: 'same', comment: 'missing message', source: { ...source, blockId: 'missing' } },
    ], null);
    const container = await renderTranscript([
      assistantBlock('older-source', text), assistantBlock('newer-source', text),
      userBlock({ id: 'carrier', text: `${carry.prefix}follow up`, presentation: carry.presentation, promptStatus }),
    ]);
    const mark = container.querySelector<HTMLElement>('mark')!;
    expect(container.querySelectorAll('mark')).toHaveLength(1);
    expect(mark.closest('[data-source-block-id]')?.getAttribute('data-source-block-id')).toBe('older-source');
    expect(mark.previousSibling?.textContent).toBe('same ');
    await act(async () => { click(mark); });
    expect(document.body.querySelector<HTMLInputElement>('[data-annotation-panel-input]')?.value).toBe('second occurrence');
  });
});

describe('live and event chrome', () => {
  it('shows elapsed time after three seconds and cleans up the timer', async () => {
    vi.useFakeTimers();
    const { root, container } = makeRoot();
    try {
      await act(async () => { root.render(<I18nProvider><TranscriptLoading /></I18nProvider>); });
      expect(container.textContent).toContain('Loading…');
      expect(container.textContent).not.toContain('elapsed');
      await act(async () => { vi.advanceTimersByTime(4000); });
      expect(container.textContent).toContain('4s elapsed');
      await act(async () => { root.render(null); });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a loaded shell in the loading state until its transcript arrives', async () => {
    const container = await renderTranscript([], undefined, { transcriptReady: false });
    expect(container.querySelector('[data-transcript-loading]')).not.toBeNull();
    expect(container.textContent).not.toContain('A blank page');
  });

  it('distinguishes an established empty transcript from loading', async () => {
    const container = await renderTranscript([]);
    expect(container.querySelector('[data-transcript-loading]')).toBeNull();
    expect(container.textContent).toContain('A blank page');
  });

  it('does not certify an unverified empty cold read as a blank session', async () => {
    const retry = vi.fn();
    const { root, container } = makeRoot();
    await renderSettled(root, <Transcript
      state={transcriptState([], { historyCoverageKind: 'unknown', hasMoreHistory: true })}
      onLoadOlder={() => Promise.resolve(false)} onResolveApproval={noopActions}
      onAnswerQuestion={noopActions} onDismissQuestion={noopActions} onRetryLoad={retry}
    />);
    expect(container.textContent).not.toContain('A blank page');
    expect(container.querySelector('[data-transcript-loading]')).toBeNull();
    const button = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Retry');
    expect(button).toBeDefined();
    await act(async () => { click(button!); });
    expect(retry).toHaveBeenCalledOnce();
  });

  it('offers retry for a failed transcript before a baseline arrives', async () => {
    const retry = vi.fn();
    const { root, container } = makeRoot();
    await renderSettled(root, <Transcript
      state={transcriptState([], { transcriptReady: false, resyncFailed: true,
        resyncError: { message: 'fixture read failed', retryable: true } })}
      onLoadOlder={() => Promise.resolve(false)} onResolveApproval={noopActions}
      onAnswerQuestion={noopActions} onDismissQuestion={noopActions} onRetryLoad={retry}
    />);
    expect(container.textContent).toContain('fixture read failed');
    const button = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Retry');
    expect(button).toBeDefined();
    await act(async () => { click(button!); });
    expect(retry).toHaveBeenCalledOnce();
  });
  it('shows a working status instead of the blank-state screen before live blocks arrive', async () => {
    const { root, container } = makeRoot();
    await renderSettled(
      root,
      <Transcript
        state={{ ...transcriptState([]), busy: true }}
        onLoadOlder={() => Promise.resolve(false)}
        onResolveApproval={() => noopActions()}
        onAnswerQuestion={() => noopActions()}
        onDismissQuestion={() => noopActions()}
      />,
    );

    expect(container.querySelector('[data-turn-status]')).not.toBeNull();
    expect(container.querySelector('[role="log"]')).not.toBeNull();
  });

  it('shows no clock on the working status when the turn start is unknown', async () => {
    const { root, container } = makeRoot();
    await renderSettled(
      root,
      <Transcript
        state={{ ...transcriptState([]), busy: true, turnStartedAt: undefined }}
        onLoadOlder={() => Promise.resolve(false)}
        onResolveApproval={() => noopActions()}
        onAnswerQuestion={() => noopActions()}
        onDismissQuestion={() => noopActions()}
      />,
    );
    const status = container.querySelector('[data-turn-status]');
    expect(status).not.toBeNull();
    // The label is there, but no cumulative clock may be fabricated from the
    // component's mount time.
    expect(status?.textContent).toContain('Working');
    expect(/\d/.test(status?.textContent ?? '')).toBe(false);
  });

  it('shows the cumulative clock once a known-started turn passes 15s', async () => {
    const { root, container } = makeRoot();
    await renderSettled(
      root,
      <Transcript
        state={{ ...transcriptState([]), busy: true, turnStartedAt: Date.now() - 16_000 }}
        onLoadOlder={() => Promise.resolve(false)}
        onResolveApproval={() => noopActions()}
        onAnswerQuestion={() => noopActions()}
        onDismissQuestion={() => noopActions()}
      />,
    );
    const status = container.querySelector('[data-turn-status]');
    expect(status).not.toBeNull();
    expect(/\d/.test(status?.textContent ?? '')).toBe(true);
  });

  it('drops the working status as soon as busy clears (turn ended)', async () => {
    const { root, container } = makeRoot();
    const state = {
      ...transcriptState([assistantBlock('assistant-m2-0', 'answer')]),
      busy: true,
      turnStartedAt: Date.now() - 16_000,
    };
    const props = {
      onLoadOlder: () => Promise.resolve(false),
      onResolveApproval: () => noopActions(),
      onAnswerQuestion: () => noopActions(),
      onDismissQuestion: () => noopActions(),
    };
    await renderSettled(root, <Transcript state={state} {...props} />);
    expect(container.querySelector('[data-turn-status]')).not.toBeNull();
    await renderSettled(
      root,
      <Transcript
        state={{
          ...state,
          busy: false,
          turnStartedAt: undefined,
          turnTail: {
            turnId: 't1',
            endedAt: new Date().toISOString(),
            durationMs: 16_000,
            ttftMs: undefined,
            usage: undefined,
            tokensPerSecond: undefined,
          },
        }}
        {...props}
      />,
    );
    expect(container.querySelector('[data-turn-status]')).toBeNull();
    expect(container.querySelector('[data-turn-tail]')).not.toBeNull();
  });

  it('renders turn tail failure state with error message and copy action', async () => {
    const { root, container } = makeRoot();
    const props = {
      onLoadOlder: () => Promise.resolve(false),
      onResolveApproval: () => noopActions(),
      onAnswerQuestion: () => noopActions(),
      onDismissQuestion: () => noopActions(),
    };
    await renderSettled(
      root,
      <Transcript
        state={{
          ...transcriptState([
            { kind: 'assistant', id: 'assistant-1', text: 'response', streaming: false, createdAt: undefined },
          ]),
          busy: false,
          turnTail: {
            turnId: 't1',
            state: 'failed',
            error: 'Provider token quota exceeded',
            endedAt: new Date().toISOString(),
            durationMs: 5_000,
            ttftMs: undefined,
            usage: undefined,
            tokensPerSecond: undefined,
          },
        }}
        {...props}
      />,
    );
    const tail = container.querySelector('[data-turn-tail]');
    expect(tail).not.toBeNull();
    expect(tail?.getAttribute('data-turn-tail-state')).toBe('failed');
    expect(tail?.textContent).toContain('Turn failed');
    expect(tail?.textContent).toContain('Provider token quota exceeded');
    expect(tail?.querySelector('button')?.textContent).toBe('copy');
    // Neutral: one small dot carries the colour, the words and error stay ink.
    expect(tail?.querySelectorAll('[data-turn-tail-dot]')).toHaveLength(1);
    expect(tail?.querySelector('.text-danger')).toBeNull();
    expect(tail?.querySelector('[data-turn-tail-error]')?.className).toContain('font-mono');
  });

  it('lets the failed tail own the failure instead of repeating it under the bubble', async () => {
    const outcome = { status: 'failed', delivered: true, error: 'Connection error.' } as const;
    const failedTail = {
      turnId: 't2', state: 'failed', error: 'Connection error.', endedAt: new Date().toISOString(),
      durationMs: 5_000, ttftMs: undefined, usage: undefined, tokensPerSecond: undefined,
    } as const;
    const container = await renderTranscript(
      [
        userBlock({ id: 'user-old', text: 'older failure', turnId: 't1', promptOutcome: outcome }),
        { ...assistantBlock('a1', 'older reply'), turnId: 't1' },
        userBlock({ id: 'user-now', text: 'send me again', turnId: 't2', promptOutcome: outcome }),
        { ...assistantBlock('a2', 'partial reply'), turnId: 't2' },
      ],
      undefined,
      { sessionId: 'session_tail', turnTail: failedTail },
    );
    // The tail's turn: no bubble line; the older turn keeps its own.
    const lines = [...container.querySelectorAll('[data-prompt-outcome]')];
    expect(lines).toHaveLength(1);
    expect(lines[0]!.closest('[data-block-id]')?.getAttribute('data-block-id')).toBe('user-old');
    const retry = container.querySelector<HTMLButtonElement>('[data-turn-tail] [data-turn-tail-retry]');
    expect(retry?.textContent).toBe('Send again');
    await act(async () => { retry!.click(); });
    expect(readDraft('session_tail')).toContain('send me again');
  });

  it('keeps the bubble failure line when a prompt failed without a tail', async () => {
    const container = await renderTranscript([
      userBlock({ id: 'user-unsent', text: 'never started', promptOutcome: { status: 'failed', delivered: false } }),
    ]);
    expect(container.querySelector('[data-prompt-outcome="failed"]')?.textContent).toContain('Not sent');
    expect(container.querySelector('[data-turn-tail]')).toBeNull();
  });

  it('renders tool stopped status with title and interrupted summary', async () => {
    const container = await renderTranscript([
      {
        kind: 'tool',
        id: 'tool-stopped-1',
        toolCallId: 'c-stop',
        name: 'Bash',
        argsText: '',
        args: {},
        display: undefined,
        description: undefined,
        status: 'stopped',
        output: 'user cancelled the process',
        isError: false,
        durationMs: 1200,
        durationSource: 'frame',
        progressText: undefined,
      },
    ]);
    const tool = container.querySelector('[data-tool]');
    expect(tool).not.toBeNull();
    expect(tool?.textContent).toContain('Stopped — user cancelled the process');
    const stoppedIcon = tool?.querySelector('[aria-label="stopped"]');
    expect(stoppedIcon?.getAttribute('title')).toBe('user cancelled the process');
  });

  it('renders subagent event row failure with danger styling and error tooltip', async () => {
    const container = await renderTranscript([
      {
        kind: 'subagent-event',
        id: 'event-sub-failed',
        subagentId: 'agent-child-1',
        parentAgentId: 'main',
        name: 'explorer',
        event: 'failed',
        status: 'failed',
        at: new Date().toISOString(),
        error: 'Connection timeout after 30s',
      },
    ]);
    const eventRow = container.querySelector('[data-subagent-event="agent-child-1"]');
    expect(eventRow).not.toBeNull();
    expect(eventRow?.textContent).toContain('explorer');
    expect(eventRow?.textContent).toContain('Failed');
    expect(eventRow?.textContent).toContain('Connection timeout after 30s');
    expect(eventRow?.getAttribute('title')).toBe('Connection timeout after 30s');
  });

  it('renders AgentSend message summary with full hover text and pending delivery status', async () => {
    const message = `Inspect the mailbox delivery path and verify that the injected content remains visible in the child transcript. ${'detail '.repeat(20)}`;
    const container = await renderTranscript([
      {
        kind: 'subagent-event',
        id: 'event-sub-sent',
        subagentId: 'agent-child-1',
        parentAgentId: 'main',
        name: 'explorer',
        event: 'sent',
        status: 'running',
        at: new Date().toISOString(),
        message,
        delivery: 'queued',
      },
    ]);
    const eventRow = container.querySelector('[data-subagent-event="agent-child-1"]');
    const summary = eventRow?.querySelector('[data-agent-message-summary]');
    const delivery = eventRow?.querySelector('[data-agent-message-delivery="queued"]');
    expect(summary?.textContent).toContain('Inspect the mailbox delivery path');
    expect(summary?.textContent).toMatch(/…$/);
    expect(summary?.getAttribute('title')).toBe(message);
    expect(delivery?.textContent).toBe('Pending delivery');
  });

  it('labels a mailbox-injected user bubble with its sender', async () => {
    const container = await renderTranscript([
      {
        kind: 'user',
        id: 'user-agent-message-1',
        text: 'Message from agent "root" (main):\n\ncheck the tests',
        createdAt: '2026-01-01T00:00:00.000Z',
        agentMessage: { senderAgentId: 'main', senderTaskName: 'root' },
      },
    ]);
    expect(container.querySelector('[data-agent-message-sender="main"]')?.textContent).toBe(
      'Main agent injected',
    );
    // No roster row for the main agent: nothing is claimed about its profile.
    expect(container.querySelector('[data-agent-message-sender-meta="main"]')).toBeNull();
  });

  it('adds the sender profile and model to a subagent-injected label', async () => {
    const container = await renderTranscript(
      [
        {
          kind: 'user',
          id: 'user-agent-message-2',
          text: 'Message from agent "readme_kiki_worker" (agent-244):\n\nstart the slice',
          createdAt: '2026-01-01T00:00:00.000Z',
          agentMessage: { senderAgentId: 'agent-244', senderTaskName: 'readme_kiki_worker' },
        },
      ],
      undefined,
      {
        snapshotSubagents: [
          {
            id: 'agent-244',
            agent_id: 'agent-244',
            session_id: 'session_test',
            kind: 'subagent',
            description: 'readme_kiki_worker',
            status: 'completed',
            created_at: '2026-01-01T00:00:00.000Z',
            profile: 'worker',
            model: 'axon/gpt-5.6-luna',
          },
        ],
      },
    );
    expect(container.querySelector('[data-agent-message-sender="agent-244"]')?.textContent).toBe(
      'readme_kiki_worker injected',
    );
    const meta = container.querySelector('[data-agent-message-sender-meta="agent-244"]');
    expect(meta?.textContent).toBe('worker · axon/gpt-5.6-luna');
    expect(meta?.getAttribute('title')).toBe(
      'Sender Agent: agent-244\nProfile: worker\nModel: axon/gpt-5.6-luna\nTask: readme_kiki_worker',
    );
  });

  it('renders the injected sender profile and model in Chinese', async () => {
    localStorage.setItem('kiki.locale', 'zh');
    try {
      const container = await renderTranscript(
        [
          {
            kind: 'user',
            id: 'user-agent-message-5',
            text: 'Message from agent "readme_kiki_worker" (agent-244):\n\nstart the slice',
            createdAt: '2026-01-01T00:00:00.000Z',
            agentMessage: { senderAgentId: 'agent-244', senderTaskName: 'readme_kiki_worker' },
          },
        ],
        undefined,
        {
          snapshotSubagents: [
            {
              id: 'agent-244',
              agent_id: 'agent-244',
              session_id: 'session_test',
              kind: 'subagent',
              description: 'readme_kiki_worker',
              status: 'completed',
              created_at: '2026-01-01T00:00:00.000Z',
              profile: 'worker',
              model: 'axon/gpt-5.6-luna',
            },
          ],
        },
      );
      expect(container.querySelector('[data-agent-message-sender="agent-244"]')?.textContent).toBe(
        'readme_kiki_worker 注入',
      );
      const meta = container.querySelector('[data-agent-message-sender-meta="agent-244"]');
      expect(meta?.textContent).toBe('worker · axon/gpt-5.6-luna');
      expect(meta?.getAttribute('title')).toBe(
        '发送方智能体：agent-244\n角色：worker\n模型：axon/gpt-5.6-luna\n任务：readme_kiki_worker',
      );
    } finally {
      localStorage.removeItem('kiki.locale');
    }
  });

  it('names only the roster facts it has for an injected sender', async () => {
    const container = await renderTranscript(
      [
        {
          kind: 'user',
          id: 'user-agent-message-3',
          text: 'Message from agent "worker" (agent-900):\n\nping',
          createdAt: '2026-01-01T00:00:00.000Z',
          agentMessage: { senderAgentId: 'agent-900', senderTaskName: 'probe' },
        },
      ],
      undefined,
      {
        snapshotSubagents: [
          {
            id: 'agent-900',
            agent_id: 'agent-900',
            session_id: 'session_test',
            kind: 'subagent',
            description: 'worker',
            status: 'running',
            created_at: '2026-01-01T00:00:00.000Z',
            model: 'axon/gpt-5.6-luna',
          },
        ],
      },
    );
    // The model is on the roster row, the profile is not: the label stays
    // quiet about the missing half instead of inventing one.
    expect(container.querySelector('[data-agent-message-sender-meta="agent-900"]')?.textContent).toBe(
      'axon/gpt-5.6-luna',
    );
    expect(container.querySelector('[data-agent-message-sender="agent-900"]')?.getAttribute('title')).toBe(
      'Sender Agent: agent-900\nProfile: unknown\nModel: axon/gpt-5.6-luna\nTask: probe',
    );
  });

  it('labels a subagent-injected bubble it has no roster row for', async () => {
    const container = await renderTranscript([
      {
        kind: 'user',
        id: 'user-agent-message-4',
        text: 'Message from agent "explorer" (agent-901):\n\nping',
        createdAt: '2026-01-01T00:00:00.000Z',
        agentMessage: { senderAgentId: 'agent-901', senderTaskName: 'explorer' },
      },
    ]);
    expect(container.querySelector('[data-agent-message-sender="agent-901"]')?.textContent).toBe(
      'explorer injected',
    );
    expect(container.querySelector('[data-agent-message-sender-meta="agent-901"]')).toBeNull();
    expect(container.querySelector('[data-agent-message-sender="agent-901"]')?.getAttribute('title')).toBe(
      'Sender Agent: agent-901\nProfile: unknown\nModel: unknown\nTask: explorer',
    );
  });

  it('labels a peer-thread bubble with its source thread', async () => {
    const container = await renderTranscript([
      {
        kind: 'user',
        id: 'user-peer-thread-1',
        text: 'Message from thread "Design review" (sess-source):\n\nping',
        createdAt: '2026-01-01T00:00:00.000Z',
        peerThread: { sessionId: 'sess-source' },
      },
    ]);
    expect(container.querySelector('[data-peer-thread="sess-source"]')?.textContent).toBe(
      'From thread sess-source',
    );
  });

  it('shows only the body of an agent-injected bubble, with the source stated once in the meta line', async () => {
    const container = await renderTranscript([
      userBlock({
        id: 'user-agent-body-1',
        text: 'Message from agent "root" (main):\n\ncheck the tests',
        agentMessage: { senderAgentId: 'main', senderTaskName: 'root' },
      }),
    ]);
    expect(container.querySelector('[data-source-block-id="user-agent-body-1"]')?.textContent).toBe('check the tests');
    expect(container.textContent).not.toContain('Message from agent');
    const senders = container.querySelectorAll('[data-agent-message-sender="main"]');
    expect(senders).toHaveLength(1);
    expect(senders[0]?.textContent).toBe('Main agent injected');
  });

  it('shows only the body of a peer-thread bubble', async () => {
    const container = await renderTranscript([
      userBlock({
        id: 'user-peer-body-1',
        text: 'Message from thread "Design review" (sess-source):\n\nping',
        peerThread: { sessionId: 'sess-source' },
      }),
    ]);
    expect(container.querySelector('[data-source-block-id="user-peer-body-1"]')?.textContent).toBe('ping');
    expect(container.textContent).not.toContain('Message from thread');
    expect(container.querySelector('[data-peer-thread="sess-source"]')?.textContent).toBe('From thread sess-source');
  });

  it('keeps a literal "Message from" the user typed verbatim: the text alone is never source evidence', async () => {
    const literal = 'Message from agent "root" (main):\n\nI wrote this myself';
    const container = await renderTranscript([
      userBlock({ id: 'user-literal-1', text: literal, userMessageId: 'm-literal-1' }),
    ]);
    expect(container.querySelector('[data-source-block-id="user-literal-1"]')?.textContent).toBe(literal);
    expect(container.querySelector('[data-agent-message-sender]')).toBeNull();
  });

  it('strips only an opening envelope, never a later mention of one', async () => {
    const text = 'notes quoting Message from agent "root" (main): inline';
    const container = await renderTranscript([
      userBlock({
        id: 'user-agent-inline-1',
        text,
        agentMessage: { senderAgentId: 'main', senderTaskName: 'root' },
      }),
    ]);
    expect(container.querySelector('[data-source-block-id="user-agent-inline-1"]')?.textContent).toBe(text);
  });

  it('copies the displayed body of an agent-injected bubble', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const container = await renderTranscript(
      [
        userBlock({
          id: 'user-agent-copy-1',
          text: 'Message from agent "worker" (agent-7):\n\nhandoff notes',
          userMessageId: 'm-agent-copy-1',
          agentMessage: { senderAgentId: 'agent-7', senderTaskName: 'worker' },
        }),
      ],
      { disabled: false, onEditMessage: () => undefined, onRegenerate: () => undefined, onFork: () => undefined },
    );
    const row = container.querySelector('[data-block-id="user-agent-copy-1"]')!;
    await act(async () => { click(row.querySelector('[data-row-action="copy"]')!); });
    expect(writeText).toHaveBeenCalledWith('handoff notes');
  });

  it('opens the editor with the verbatim text so a source envelope survives a rewrite', async () => {
    const raw = 'Message from agent "worker" (agent-7):\n\noriginal brief';
    const onEditMessage = vi.fn();
    const rowActions: TranscriptRowActions = {
      disabled: false,
      onEditMessage,
      onRegenerate: () => undefined,
      onFork: () => undefined,
    };
    const container = await renderTranscript(
      [
        userBlock({
          id: 'user-agent-edit-1',
          text: raw,
          userMessageId: 'm-agent-edit-1',
          agentMessage: { senderAgentId: 'agent-7', senderTaskName: 'worker' },
        }),
      ],
      rowActions,
    );
    const row = container.querySelector('[data-block-id="user-agent-edit-1"]')!;
    await act(async () => {
      flushSync(() => {
        click(row.querySelector('[data-row-action="edit"]')!);
      });
    });
    expect(container.querySelector<HTMLTextAreaElement>('[data-edit-editor] textarea')?.value).toBe(raw);
  });

  it('keeps the envelope in the editor when the presentation marks it as the message source', async () => {
    const envelope = 'Message from thread "Design review" (sess-source):\n\n';
    const body = 'ping the reviewer';
    const context = '<thread_refs>\n<thread_ref id="sess-source" status="idle"/>\nRead it with ThreadRead.\n</thread_refs>';
    const raw = `${envelope}${body}\n\n${context}`;
    // The producer's own marks: the opening envelope is a `source` span, and
    // the composer's generated context block keeps its `context` span. The
    // envelope is durable text a rewrite must carry; the context is not.
    const presentation = {
      spans: [
        { start: 0, end: envelope.length, kind: 'source' as const },
        { start: envelope.length + body.length, end: raw.length, kind: 'context' as const },
      ],
    };
    const container = await renderTranscript(
      [
        userBlock({
          id: 'user-thread-edit-1',
          text: raw,
          presentation,
          userMessageId: 'm-thread-edit-1',
          peerThread: { sessionId: 'sess-source' },
        }),
      ],
      { disabled: false, onEditMessage: () => undefined, onRegenerate: () => undefined, onFork: () => undefined },
    );
    expect(container.querySelector('[data-source-block-id="user-thread-edit-1"]')?.textContent).toBe(body);
    const row = container.querySelector('[data-block-id="user-thread-edit-1"]')!;
    await act(async () => {
      flushSync(() => {
        click(row.querySelector('[data-row-action="edit"]')!);
      });
    });
    expect(container.querySelector<HTMLTextAreaElement>('[data-edit-editor] textarea')?.value).toBe(`${envelope}${body}`);
  });

  describe('displayUserMessageText', () => {
    it('strips the agent envelope only when origin metadata proves the source', () => {
      const text = 'Message from agent "root" (main):\n\nbody';
      expect(displayUserMessageText({ text, agentMessage: { senderAgentId: 'main', senderTaskName: 'root' } }).text).toBe('body');
      expect(displayUserMessageText({ text }).text).toBe(text);
    });

    it('strips the external-agent envelope', () => {
      expect(displayUserMessageText({
        text: 'Message from external agent "deploy" (external:acme):\n\nshipped',
        agentMessage: { senderAgentId: 'external:acme', senderTaskName: 'deploy' },
      }).text).toBe('shipped');
    });

    it('strips the thread envelope in both label shapes', () => {
      expect(displayUserMessageText({
        text: 'Message from thread "Design review" (sess-1):\n\nping',
        peerThread: { sessionId: 'sess-1' },
      }).text).toBe('ping');
      expect(displayUserMessageText({
        text: 'Message from thread sess-1:\n\nping',
        peerThread: { sessionId: 'sess-1' },
      }).text).toBe('ping');
    });

    it('strips the bridged envelope and shifts presentation spans past the cut', () => {
      const envelope = 'Verified message from space home-a · thread sess-9 (local):\n\n';
      const cut = envelope.length;
      const display = displayUserMessageText({
        text: `${envelope}body`,
        presentation: {
          spans: [
            { start: 4, end: 8, kind: 'context' },
            { start: cut + 1, end: cut + 3, kind: 'attachment', attachment: { path: '/tmp/a.txt', name: 'a.txt', mime: 'text/plain', size: 3 } },
          ],
        },
        bridgedPeer: { sourceHomeId: 'home-a' },
      });
      expect(display.text).toBe('body');
      expect(display.presentation?.spans).toEqual([
        { start: 1, end: 3, kind: 'attachment', attachment: { path: '/tmp/a.txt', name: 'a.txt', mime: 'text/plain', size: 3 } },
      ]);
    });

    it('keeps the text when the metadata has no matching envelope shape', () => {
      expect(displayUserMessageText({ text: 'plain words', agentMessage: { senderAgentId: 'main' } }).text).toBe('plain words');
      const literal = 'Message from thread sess-1:\n\nmy own words';
      expect(displayUserMessageText({ text: literal }).text).toBe(literal);
    });
  });

  describe('editableUserMessageText', () => {
    it('keeps the envelope bytes the presentation marks as the message source', () => {
      const envelope = 'Message from thread "Design review" (sess-1):\n\n';
      const body = 'ping';
      const context = '<thread_refs>\n<thread_ref id="sess-1" status="idle"/>\nRead it with ThreadRead.\n</thread_refs>';
      const text = `${envelope}${body}\n\n${context}`;
      const presentation = {
        spans: [
          { start: 0, end: envelope.length, kind: 'source' as const },
          { start: envelope.length + body.length, end: text.length, kind: 'context' as const },
        ],
      };
      expect(editableUserMessageText({ text, presentation, peerThread: { sessionId: 'sess-1' } })).toBe(`${envelope}${body}`);
      // The metadata, not the span, is the authority: the same text without it
      // is the user's own voice and keeps the ordinary projection.
      expect(editableUserMessageText({ text, presentation })).toBe('ping');
    });

    it('keeps the envelope of a source message whose presentation marks no span', () => {
      const text = 'Message from agent "worker" (agent-7):\n\noriginal brief';
      expect(editableUserMessageText({ text, agentMessage: { senderAgentId: 'agent-7' } })).toBe(text);
    });

    it('clips a span that crosses the envelope cut to the body side', () => {
      const envelope = 'Message from thread "Review" (sess-source):\n\n';
      const text = `${envelope}body`;
      // Legal for the contract: one span may run from the envelope's last bytes
      // into the body. Only the body half of it may be projected out.
      const presentation = {
        spans: [{ start: envelope.length - 2, end: envelope.length + 2, kind: 'context' as const }],
      };
      expect(editableUserMessageText({ text, presentation, peerThread: { sessionId: 'sess-source' } })).toBe(`${envelope}dy`);
    });
  });

  it('hides the working status while assistant text streams even when busy', async () => {
    const { root, container } = makeRoot();
    await renderSettled(
      root,
      <Transcript
        state={{
          ...transcriptState([
            { kind: 'assistant', id: 'assistant-live', text: 'typing', streaming: true, createdAt: undefined },
          ]),
          busy: true,
          turnStartedAt: Date.now() - 20_000,
        }}
        onLoadOlder={() => Promise.resolve(false)}
        onResolveApproval={() => noopActions()}
        onAnswerQuestion={() => noopActions()}
        onDismissQuestion={() => noopActions()}
      />,
    );
    expect(container.querySelector('[data-turn-status]')).toBeNull();
  });

  it('renders projected model changes as one timeline divider', async () => {
    const snapshot = replayAgentWire('main', [
      { type: 'profile.bind', modelAlias: 'example/old', time: 1000 },
      { type: 'config.update', modelAlias: 'example/old', thinkingEffort: 'high', time: 2000 },
      { type: 'config.update', modelAlias: 'example/new', time: 3000 },
    ]);
    const state = projectAgentTranscriptView(createViewState('model-switch'), 'main', snapshot);
    const container = await renderTranscript([...state.blocks]);
    const dividers = container.querySelectorAll('[data-timeline-divider][data-notice-key="transcript.marker.modelSwitch"]');
    expect(dividers).toHaveLength(1);
    expect(dividers[0]?.textContent).toBe('Model changed from example/old to example/new');
  });

  it('renders twelve consecutive goal updates as one divider with a repeat count', async () => {
    const snapshot = replayAgentWire('main', Array.from({ length: 12 }, (_, index) => ({
      type: 'goal.update', tokensUsed: index + 1, time: 1000 + index,
    })));
    const state = projectAgentTranscriptView(createViewState('marker-fold'), 'main', snapshot);
    const container = await renderTranscript([...state.blocks]);
    const dividers = container.querySelectorAll('[data-timeline-divider][data-notice-key="transcript.marker.goal"]');
    expect(dividers).toHaveLength(1);
    expect(dividers[0]?.textContent).toBe('Goal updated ×12');
    expect(container.querySelector('[data-block-id]')?.getAttribute('data-block-id')).toBe(state.blocks[0]?.id);
  });

  it('labels folded compactions as successful commits and expands every time and reason', async () => {
    const snapshot = replayAgentWire('main', [1000, 2000, 3000].map((time, index) => ({
      type: 'context.apply_compaction', strategy: 'summarize', summary: 'summary', time, reasonCodes: [index === 0 ? 'notes_missing' : 'tool_error'],
    })));
    const state = projectAgentTranscriptView(createViewState('session_test'), 'main', snapshot);
    const container = await renderTranscript([...state.blocks]);
    const toggle = container.querySelector<HTMLButtonElement>('[data-notice-reasons-toggle]')!;
    expect(toggle.textContent).toBe('Context compacted · summary generated · 3 successful compactions');
    expect(toggle.textContent).not.toContain('×');
    await act(async () => { click(toggle); });
    const entries = container.querySelectorAll('[data-compaction-history] li');
    expect(entries).toHaveLength(3);
    expect(entries[0]?.textContent).toContain('The agent has no working notes');
    expect(entries[1]?.textContent).toContain('Recent tool failures need to remain in context.');
    expect(entries[0]?.textContent).not.toBe(entries[1]?.textContent);
  });

  it('renders relay, summary, unknown and failed compaction labels from the committed mode', async () => {
    const snapshot = replayAgentWire('main', [
      { type: 'full_compaction.begin', source: 'manual', time: 1000 },
      { type: 'context.apply_compaction', strategy: 'relay', summary: 'handoff', time: 1100 },
      { type: 'full_compaction.complete', time: 1101 },
      { type: 'full_compaction.begin', source: 'auto', time: 2000 },
      { type: 'context.apply_compaction', strategy: 'summarize', summary: 'summary', time: 2100 },
      { type: 'full_compaction.complete', time: 2101 },
      { type: 'context.apply_compaction', summary: 'mode unknown', time: 3000 },
      { type: 'full_compaction.begin', source: 'manual', time: 4000 },
      { type: 'full_compaction.cancel', reason: 'compaction.failed', time: 4100 },
    ]);
    const state = projectAgentTranscriptView(createViewState('session_test'), 'main', snapshot);
    const container = await renderTranscript([...state.blocks]);
    const labels = [...container.querySelectorAll('[data-timeline-divider]')].map(node => node.textContent);
    expect(labels).toEqual([
      'Fresh-context compaction complete · handoff retained', 'Context compacted · summary generated',
      'Context compacted', 'Compaction failed · context unchanged',
    ]);
  });

  it('says why a compaction fell back and lists the reasons on request', async () => {
    const container = await renderTranscript([
      {
        kind: 'notice',
        id: 'marker-c1',
        text: 'compaction',
        tone: 'neutral',
        i18n: { key: 'transcript.marker.compactionFallback' },
        reasonCodes: ['notes_missing', 'tool_error', 'future_code'],
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const toggle = container.querySelector<HTMLButtonElement>('[data-notice-reasons-toggle]')!;
    expect(toggle.textContent).toBe('Fresh start conditions were not met · summarized instead');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-notice-reason-list]')).toBeNull();
    await act(async () => { click(toggle); });
    const items = [...container.querySelectorAll('[data-notice-reason-list] li')].map((item) => item.textContent);
    expect(items).toHaveLength(3);
    expect(items[2]).toBe('future_code');
  });

  it('shows an over-limit notes notice without requiring the reasons panel to be opened', async () => {
    const container = await renderTranscript([{ kind: 'notice', id: 'notes-budget', text: 'compaction', tone: 'neutral',
      i18n: { key: 'transcript.marker.compactionSummarize' }, reasonCodes: ['notes_directives_budget'], createdAt: '2026-01-01T00:00:00.000Z' }]);
    expect(container.querySelector('[data-notice-reasons-toggle]')?.textContent).toBe('The summary’s task instructions exceed the notes limit. Existing notes are unchanged; the full text remains in the handoff for review.');
    expect(container.querySelector('[data-notice-reason-list]')).toBeNull();
  });

  it('renders a projected image compression caption as a separate folded reminder, not user text', async () => {
    const caption = 'Image compressed to fit model limits: original 4500x2800 -> sent 2000x1244. Fine detail may be lost. The original is at "/example/original.png".';
    const blocks = agentTranscriptToBlocks({ agent_id: 'main', items: [{
      kind: 'turn', turnId: 't-image', prompt: `Look at this.\n<system>${caption}</system>`,
      startedAt: '2026-01-01T00:00:00.000Z', steps: [],
    }] });
    const container = await renderTranscript(blocks);
    const bubble = container.querySelector('.steer-bubble');
    expect(bubble?.textContent).toBe('Look at this.');
    const reminder = container.querySelector('[data-activity-row]');
    expect(reminder?.textContent).toContain('System reminder');
    expect(reminder?.textContent).toContain('Image compressed');
    expect(reminder?.closest('.steer-bubble')).toBeNull();
    expect(reminder?.textContent).not.toContain('<system>');
    expect(reminder?.querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { click(reminder!.querySelector<HTMLElement>('[aria-expanded]')!); });
    expect(container.textContent).toContain('/example/original.png');
    expect(bubble?.textContent).toBe('Look at this.');
  });

  it('names an injected reminder by its first readable line and keeps the body folded', async () => {
    const container = await renderTranscript([
      {
        kind: 'system-reminder',
        id: 'reminder-1',
        text: '<tools_added>\nEnterPlanMode\n</tools_added>\nUse SelectTools before calling them.',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const row = container.querySelector('[data-activity-row]');
    expect(row?.textContent).toContain('System reminder');
    expect(row?.textContent).toContain('EnterPlanMode');
    expect(row?.textContent).not.toContain('<tools_added>');
    expect(row?.textContent).not.toContain('Use SelectTools');
  });

  it('heads a categorized reminder by its kind and keeps trigger facts for the open body', async () => {
    const container = await renderTranscript([
      {
        kind: 'system-reminder',
        id: 'reminder-renew',
        text: 'The context window will be renewed soon.',
        createdAt: '2026-01-01T00:00:00.000Z',
        variant: 'todo_list_reminder',
        category: { kind: 'renew', triggers: ['T2', 'E1'], epoch: 2, userTurn: 't7' },
      },
      {
        kind: 'system-reminder',
        id: 'reminder-progress',
        text: 'Update TodoList notes when convenient.',
        createdAt: '2026-01-01T00:00:00.000Z',
        category: { kind: 'progress', triggers: [] },
      },
    ]);
    const renew = container.querySelector<HTMLElement>('[data-reminder-kind="renew"]')!;
    expect(renew.textContent).toContain('Reminder · context renewal ahead');
    expect(renew.textContent).not.toContain('System reminder');
    expect(renew.querySelector('[data-reminder-facts]')).toBeNull();
    await act(async () => { click(renew.querySelector<HTMLElement>('[aria-expanded]')!); });
    expect(renew.querySelector('[data-reminder-facts]')?.textContent).toBe('Triggers T2 · E1  ·  Window 2  ·  For t7');
    const progress = container.querySelector<HTMLElement>('[data-reminder-kind="progress"]')!;
    expect(progress.textContent).toContain('Reminder · update notes');
    await act(async () => { click(progress.querySelector<HTMLElement>('[aria-expanded]')!); });
    expect(progress.querySelector('[data-reminder-facts]')).toBeNull();
  });

  it('keeps loaded skills compact until their details are explicitly expanded', async () => {
    const container = await renderTranscript([
      {
        kind: 'skill',
        id: 'skill-1',
        source: 'skill',
        name: 'browser-audit',
        args: '--deep',
        text: 'Long implementation notes that should not occupy the transcript by default.',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const skill = container.querySelector('[data-skill]');
    const trigger = skill?.querySelector('button');

    expect(skill).not.toBeNull();
    expect(skill?.className).not.toContain('rounded-xl');
    expect(skill?.className).not.toContain('bg-panel');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('Long implementation notes');

    await act(async () => {
      flushSync(() => { click(trigger!); });
    });
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('Long implementation notes');
  });

  it.each([{ names: ['review'] }, { names: ['review', 'check'] }])(
    'renders delivered skills at their in-turn position, not as empty trailing dividers: $names',
    async ({ names }) => {
      const blocks = agentTranscriptToBlocks({ agent_id: 'example-agent', items: [
        {
          kind: 'turn', turnId: 't0', ordinal: 0, state: 'completed', origin: { kind: 'user' },
          steps: [{ kind: 'step', turnId: 't0', stepId: 'step', ordinal: 1, state: 'completed', frames: [
            { kind: 'text', frameId: 'before', role: 'assistant', text: 'Before activation' },
            ...names.map(name => ({
              kind: 'text' as const, frameId: `skill-${name}`, role: 'user' as const,
              text: `<skill-loaded name="${name}">Instructions for ${name}</skill-loaded>`,
              origin: { kind: 'skill_activation', activationId: `activation-${name}`, skillName: name, trigger: 'model-tool' },
            })),
            { kind: 'text', frameId: 'after', role: 'assistant', text: 'After activation' },
          ] }],
        },
        ...names.map(name => ({
          kind: 'marker' as const, markerId: `live-${name}`, marker: 'skill',
          payload: { activationId: `activation-${name}`, skillName: name, trigger: 'model-tool' },
        })),
      ] });
      const container = await renderTranscript(blocks);
      expect(container.querySelector('[data-block-id^="agent-marker-"]')).toBeNull();
      const fold = container.querySelector('[data-history-fold]');
      if (fold !== null) await act(async () => { click(fold.querySelector('button')!); });
      const skills = [...container.querySelectorAll('[data-skill]')];
      expect(skills).toHaveLength(names.length);
      const before = container.querySelector('[data-block-id="agent-frame-before"]')!;
      const after = container.querySelector('[data-block-id="agent-frame-after"]')!;
      for (const [index, skill] of skills.entries()) {
        expect(skill.textContent).toContain(names[index]);
        expect(before.compareDocumentPosition(skill) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(skill.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        await act(async () => { click(skill.querySelector('button')!); });
        expect(skill.textContent).toContain(`Instructions for ${names[index]}`);
      }
    },
  );

  it('keeps shell cards collapsed by default and expands them on click', async () => {
    const container = await renderTranscript([
      {
        kind: 'shell',
        id: 'shell-1',
        commandId: 'bash-1',
        command: 'pnpm test',
        output: 'first line\nSuite is green — 42 passed.',
        done: true,
        isError: undefined,
      },
    ]);
    const shell = container.querySelector('[data-shell]');
    const trigger = shell?.querySelector('button');

    expect(shell).not.toBeNull();
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    // Collapsed: no log body, but the header keeps the command and output tail.
    expect(shell?.querySelector('pre')).toBeNull();
    expect(shell?.textContent).toContain('$ pnpm test');
    expect(shell?.textContent).toContain('Suite is green — 42 passed.');
    expect(shell?.textContent).not.toContain('first line');

    await act(async () => {
      flushSync(() => { click(trigger!); });
    });
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(shell?.textContent).toContain('$ pnpm test');
    expect(shell?.querySelector('pre')?.textContent).toContain('first line');
  });

  it('shows the full long command only after expanding while keeping output separate', async () => {
    const command = 'node -e ' + 'x'.repeat(180);
    const container = await renderTranscript([
      {
        kind: 'shell',
        id: 'shell-long',
        commandId: 'bash-long',
        command,
        output: 'done',
        done: true,
        isError: undefined,
      },
    ]);
    const shell = container.querySelector('[data-shell]')!;
    const trigger = shell.querySelector('button')!;
    const commandPreview = shell.querySelector('[data-shell-command-preview]');
    expect(commandPreview?.className).toContain('truncate');
    expect(commandPreview?.textContent).toContain('$ ' + command);
    await act(async () => {
      flushSync(() => { click(trigger); });
    });
    expect(shell.querySelector('[data-shell-command-full]')?.textContent).toContain(command);
    expect(shell.querySelector('pre')?.textContent).toBe('done');
  });
});

describe('explicit unknown timing', () => {
  function subagentBlock(
    overrides: Partial<Extract<Block, { kind: 'subagent' }>> & { subagentId: string },
  ): Block {
    return {
      kind: 'subagent',
      id: `subagent-${overrides.subagentId}`,
      parentAgentId: undefined,
      parentToolCallId: undefined,
      name: overrides.subagentId,
      description: undefined,
      model: undefined,
      thinkingEffort: undefined,
      status: 'completed',
      summary: undefined,
      error: undefined,
      startedAt: undefined,
      endedAt: undefined,
      toolCallCount: 0,
      transcript: [],
      ...overrides,
    };
  }

  it('leaves the duration empty instead of 0ms or a dash when a subagent start or end is unknown', async () => {
    const container = await renderTranscript([
      subagentBlock({ subagentId: 'agent-no-times' }),
      // Adjacent compact cards fold into a history run; a non-compact entry
      // between them keeps both cards individually visible for this probe.
      { kind: 'notice', id: 'break', text: 'boundary', tone: 'danger' },
      subagentBlock({
        subagentId: 'agent-no-end',
        startedAt: '2026-01-01T00:00:00.000Z',
      }),
    ]);
    for (const id of ['agent-no-times', 'agent-no-end']) {
      const card = container.querySelector(`[data-subagent-id="${id}"]`);
      expect(card, id).not.toBeNull();
      expect(card?.textContent, id).not.toContain('—');
      expect(card?.textContent, id).not.toContain('0ms');
    }
  });

  it('shows the real duration when a subagent has both true endpoints', async () => {
    const container = await renderTranscript([
      subagentBlock({
        subagentId: 'agent-timed',
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:01:30.000Z',
      }),
    ]);
    const card = container.querySelector('[data-subagent-id="agent-timed"]');
    expect(card?.textContent).toContain('1m 30s');
    expect(card?.textContent).not.toContain('—');
  });

  it('ticks a live duration for a running subagent with a real start', async () => {
    const container = await renderTranscript([
      subagentBlock({
        subagentId: 'agent-live',
        status: 'running',
        startedAt: new Date(Date.now() - 5_000).toISOString(),
      }),
    ]);
    const card = container.querySelector('[data-subagent-id="agent-live"]');
    expect(card?.textContent).toMatch(/\d\.\ds/);
    expect(card?.textContent).not.toContain('—');
  });

  function toolBlock(
    overrides: Partial<Extract<Block, { kind: 'tool' }>> & { toolCallId: string },
  ): Block {
    return {
      kind: 'tool',
      id: `tool-${overrides.toolCallId}`,
      name: 'Read',
      argsText: '',
      args: { path: 'a.ts' },
      display: undefined,
      description: undefined,
      status: 'done',
      output: 'ok',
      isError: undefined,
      startedAt: undefined,
      durationMs: undefined,
      progressText: undefined,
      ...overrides,
    };
  }

  async function renderToolCard(block: Block): Promise<HTMLDivElement> {
    const { root, container } = makeRoot();
    await renderSettled(root, <ToolCard block={block as Extract<Block, { kind: 'tool' }>} />);
    return container;
  }

  it.each(['Bash', 'TodoList', 'WebSearch', 'FetchURL', 'MemoryWrite', 'CallTool'])('keeps external %s as a human label, not native semantics or guessed icons', async (name) => {
    const block = toolBlock({ toolCallId: `external:session:${name}`, name, args: { command: 'do not guess', name: 'Read', arguments: { path: 'a.ts' } }, display: { kind: 'generic', summary: 'External label' } }) as Extract<Block, { kind: 'tool' }>;
    expect(toolIcon(block)).toBe('tool');
    expect(resolvedToolName(block)).toBe(name);
    const container = await renderToolCard(block);
    expect(container.querySelector('[data-tool-semantic]')).toBeNull();
    expect(container.textContent).toContain(name);
    expect(container.textContent).toContain('External label');
  });

  it('renders ACP text, images and every raw diff without treating the package as native output', async () => {
    const output = { kind: 'external_tool_output', protocol: 'acp-v1', text: 'partial stdout',
      rawOutput: { kind: 'command_output', stdout: 'not a native receipt', exit_code: 9 },
      content: [{ type: 'diff', path: 'first.ts', oldText: 'a', newText: 'b' }, { type: 'diff', path: 'second.ts', oldText: 'c', newText: 'd' }],
      media: [{ type: 'image', source: { kind: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }],
      locations: [{ path: 'first.ts', line: 4 }], remoteToolCallId: 'remote-call', remoteSessionId: 'remote-session' };
    const container = await renderToolCard(toolBlock({ toolCallId: 'external:session:call', name: 'Bash', display: { kind: 'command', command: 'npm test' }, output }));
    await act(async () => { flushSync(() => { click(container.querySelector('button')!); }); });
    expect(container.textContent).toContain('partial stdout');
    const loadImage = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('Load full file'));
    expect(loadImage).toBeDefined();
    await act(async () => { flushSync(() => { click(loadImage!); }); });
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    const preserved = container.querySelector('details');
    expect(preserved?.textContent).toContain('first.ts');
    expect(preserved?.textContent).toContain('second.ts');
    expect(preserved?.textContent).toContain('remote-call');
    expect(preserved?.textContent).toContain('not a native receipt');
    expect(container.textContent).not.toContain('Exit code: 9');
  });

  it('does not build an external edit from raw arguments when its display declined the semantics', async () => {
    const container = await renderToolCard(toolBlock({ toolCallId: 'external:session:edit', name: 'Write', display: { kind: 'generic', summary: 'Unknown edit' }, args: { path: 'a.ts', content: 'do not invent a hunk' }, output: {} }));
    await act(async () => { flushSync(() => { click(container.querySelector('button')!); }); });
    expect(container.textContent).toContain('"content"');
    expect(container.textContent).toContain('do not invent a hunk');
  });

  it('names a streaming CallTool bridge by the tool it calls, never by the bridge', async () => {
    // Mid-stream: only the bridge name and a partial argument text exist.
    const pending = await renderToolCard(toolBlock({
      toolCallId: 't-bridge-early', name: 'CallTool', status: 'running', args: undefined, argsText: '{"na',
    }));
    expect(pending.textContent).not.toContain('CallTool');
    expect(pending.textContent).toContain('Calling a tool');
    const streamed = await renderToolCard(toolBlock({
      toolCallId: 't-bridge', name: 'CallTool', status: 'running', args: undefined,
      argsText: '{"name":"plugin__kiki-office__office_view","arguments":{"file":"deck.pptx"',
    }));
    expect(streamed.textContent).not.toContain('CallTool');
    expect(streamed.textContent).toContain('office_view');
    expect(streamed.textContent).not.toContain('plugin__');
    expect(streamed.querySelector('[title="plugin__kiki-office__office_view"]')).not.toBeNull();
    expect(streamed.textContent).toContain('deck.pptx');
    // Once parsed, the bridged object's inner arguments feed the summary.
    const parsed = await renderToolCard(toolBlock({
      toolCallId: 't-bridge-done', name: 'CallTool', status: 'done',
      args: { name: 'mcp__fs__read_file', arguments: { path: 'README.md' } }, argsText: '',
    }));
    expect(parsed.textContent).toContain('read_file');
    expect(parsed.textContent).not.toContain('mcp__fs__');
    expect(parsed.textContent).toContain('README.md');
    expect(parsed.textContent).not.toContain('CallTool');
  });

  it('keeps a failed Bash command summary instead of replacing it with the error', async () => {
    const container = await renderToolCard({
      kind: 'tool',
      id: 'tool-bash-failed',
      toolCallId: 'bash-failed',
      name: 'Bash',
      argsText: '{"command":"pnpm test"}',
      args: { command: 'pnpm test' },
      display: undefined,
      description: undefined,
      status: 'error',
      output: 'permission denied',
      isError: true,
      startedAt: undefined,
      durationMs: undefined,
      progressText: undefined,
    });
    const trigger = container.querySelector('button')!;
    expect(trigger.textContent).toContain('pnpm test');
    expect(trigger.textContent).not.toContain('permission denied');
    await act(async () => {
      flushSync(() => { click(trigger); });
    });
    expect(container.textContent).toContain('pnpm test');
    expect(container.textContent).toContain('permission denied');
  });

  it('keeps a successful tool with unknown timing silent instead of showing the turn-level fallback', async () => {
    // The projection falls back to the TURN's durationMs when frame-level
    // timing is missing (startedAt undefined / legacy 0 sentinel) — the card
    // must not present that as this tool's own runtime. A success with no
    // real duration shows nothing at all (silent success), not a "—".
    const container = await renderToolCard(
      toolBlock({ toolCallId: 't-unknown', durationMs: 5_000 }),
    );
    expect(container.textContent).not.toContain('—');
    expect(container.textContent).not.toContain('5.0s');
    expect(container.querySelector('[title="duration unknown"]')).toBeNull();
  });

  it('leaves a failed tool with unknown timing without a duration — never the turn fallback', async () => {
    // The failure is carried by the tone, the error text and the cross mark;
    // an unexplained dash beside them was a second symbol to decode.
    const container = await renderToolCard(
      toolBlock({ toolCallId: 't-unknown-fail', status: 'error', isError: true, output: 'boom', durationMs: 5_000 }),
    );
    expect(container.textContent).toContain('boom');
    expect(container.textContent).not.toContain('—');
    expect(container.textContent).not.toContain('5.0s');
    expect(container.querySelector('[data-outcome="failed"]')).not.toBeNull();
  });

  it('reads a coded Codex MCP refusal in product words and keeps the engine text in the tooltip', async () => {
    const engineText = 'MCP tool call requires approval, but approval policy is never';
    const coded = await renderToolCard(toolBlock({ toolCallId: 't-coded', name: 'kiki-harness/kiki_list', status: 'error', isError: true,
      output: engineText, errorCode: 'codex_mcp_approval_denied' }));
    expect(coded.textContent).toContain('Codex did not run it');
    const titled = [...coded.querySelectorAll('[title]')].map((element) => element.getAttribute('title') ?? '');
    expect(titled.some((title) => title.startsWith('Codex did not run it') && title.endsWith(engineText))).toBe(true);
    const unknown = await renderToolCard(toolBlock({ toolCallId: 't-uncoded', status: 'error', isError: true,
      output: 'boom', errorCode: 'some_future_code' }));
    expect(unknown.textContent).toContain('boom');
  });

  it('never shows the legacy 0-start sentinel duration as runtime', async () => {
    const container = await renderToolCard(
      toolBlock({ toolCallId: 't-zero', startedAt: 0, durationMs: 5_000 }),
    );
    expect(container.textContent).not.toContain('—');
    expect(container.textContent).not.toContain('5.0s');
  });

  it('shows the per-tool duration when both frame endpoints are real', async () => {
    const container = await renderToolCard(
      toolBlock({ toolCallId: 't-timed', startedAt: 1_767_225_600_000, durationMs: 2_300, durationSource: 'frame' }),
    );
    expect(container.textContent).toContain('2.3s');
    expect(container.textContent).not.toContain('—');
  });

  it('never shows a turn-level fallback as runtime when only the frame start exists', async () => {
    // Half a frame timestamp pair: the start is real, the end is missing, so
    // the projected durationMs is the enclosing turn's — never this tool's.
    const container = await renderToolCard(
      toolBlock({
        toolCallId: 't-half',
        startedAt: 1_767_225_600_000,
        durationMs: 9_000,
        durationSource: 'turn',
      }),
    );
    expect(container.textContent).not.toContain('9.0s');
    expect(container.textContent).not.toContain('—');
  });

  it('shows no duration marker at all on a still-running tool', async () => {
    const container = await renderToolCard(
      toolBlock({ toolCallId: 't-running', status: 'running', output: undefined }),
    );
    expect(container.textContent).not.toContain('—');
  });
});

describe('message row actions', () => {
  it('shows edit/fork on settled user rows and regenerate/fork on the latest final reply only', async () => {
    const rowActions: TranscriptRowActions = {
      disabled: false,
      onEditMessage: () => undefined,
      onRegenerate: () => undefined,
      onFork: () => undefined,
    };
    const container = await renderTranscript(
      [
        userBlock({ id: 'user-m1', text: 'first question', userMessageId: 'm1' }),
        assistantBlock('assistant-m2-0', 'first answer'),
        userBlock({ id: 'user-m3', text: 'second question', userMessageId: 'm3' }),
        assistantBlock('assistant-live-1-final-end@9', 'second answer'),
      ],
      rowActions,
    );
    const rows = [...container.querySelectorAll('[data-block-id]')];
    expect(rows).toHaveLength(4);
    // Tiled first (copy / edit / regenerate), then what the `⋯` holds.
    expect(rowActionButtons(rows[0]!)).toEqual(['copy', 'edit', 'link', 'fork']);
    // An older assistant row copies but never regenerates.
    expect(rowActionButtons(rows[1]!)).toEqual(['copy', 'link']);
    expect(rowActionButtons(rows[2]!)).toEqual(['copy', 'edit', 'link', 'fork']);
    expect(rowActionButtons(rows[3]!)).toEqual(['copy', 'regenerate', 'link', 'fork']);
  });

  it('hides edit/fork on a user row without a wire identity', async () => {
    const rowActions: TranscriptRowActions = {
      disabled: false,
      onEditMessage: () => undefined,
      onRegenerate: () => undefined,
      onFork: () => undefined,
    };
    const container = await renderTranscript(
      [userBlock({ id: 'turn-1-prompt', text: 'placeholder without id' })],
      rowActions,
    );
    const rows = [...container.querySelectorAll('[data-block-id]')];
    expect(rowActionButtons(rows[0]!)).toEqual(['copy', 'link']);
  });

  it('omits queued prompts until they start while keeping blocked prompts visible', async () => {
    const anchor = assistantBlock('assistant-anchor', 'existing reply');
    const queued = userBlock({
      id: 'user-queued',
      text: 'queued duplicate',
      userMessageId: 'm-queued',
      promptId: 'p-queued',
      promptStatus: 'queued',
    });
    const queuedContainer = await renderTranscript([anchor, queued]);
    expect(queuedContainer.querySelector('[data-block-id="user-queued"]')).toBeNull();
    expect(queuedContainer.textContent).not.toContain('queued duplicate');

    const startedContainer = await renderTranscript([
      anchor,
      { ...queued, promptStatus: 'running' },
    ]);
    expect(startedContainer.querySelector('[data-block-id="user-queued"]')).not.toBeNull();
    expect(startedContainer.textContent).toContain('queued duplicate');

    const blockedContainer = await renderTranscript([
      anchor,
      { ...queued, id: 'user-blocked', text: 'blocked prompt', promptStatus: 'blocked' },
    ]);
    expect(blockedContainer.querySelector('[data-block-id="user-blocked"]')).not.toBeNull();
    expect(blockedContainer.textContent).toContain('blocked prompt');
    expect(blockedContainer.textContent).toContain('Blocked');
  });

  it('does not paint an acknowledged but undelivered steer as a bottom-of-timeline bubble', async () => {
    const opening = userTurnSnapshot({ streaming: true });
    const prompt = {
      promptId: 'queued-steer', status: 'queued' as const, userMessageId: 'queued-message',
      content: [{ type: 'text' as const, text: 'deliver me later' }],
      createdAt: '2026-01-01T00:00:03.000Z',
    };
    const pending = projectAgentTranscriptView(createViewState('session_test'), 'main', {
      ...opening, prompts: [...opening.prompts, prompt],
    });
    const acknowledged = projectAgentTranscriptView(pending, 'main', {
      ...opening, prompts: [...opening.prompts, {
        ...prompt, status: 'completed', steeredAt: '2026-01-01T00:00:04.000Z',
      }],
    });
    expect(acknowledged.queuedPromptIds).toEqual([]);
    const container = await renderTranscript([...acknowledged.blocks]);
    expect(container.textContent).not.toContain('deliver me later');
    expect(container.querySelector('[data-block-id="user-queued-message"]')).toBeNull();
  });

  it.each(['sending', 'waiting'] as const)('paints a %s send-now as an awaiting-insertion bubble without row mutations', async (phase) => {
    const rowActions: TranscriptRowActions = {
      disabled: false,
      onEditMessage: () => undefined,
      onRegenerate: () => undefined,
      onFork: () => undefined,
    };
    const container = await renderTranscript([
      assistantBlock('assistant-anchor', 'working on it'),
      userBlock({ id: 'user-p-now', text: 'also check the docs', userMessageId: 'p-now', promptId: 'p-now', steerStatus: phase }),
    ], rowActions);
    const row = container.querySelector('[data-block-id="user-p-now"]')!;
    expect(row).not.toBeNull();
    expect(row.querySelector(`[data-steer-status="${phase}"]`)?.className).toContain('steer-bubble-pending');
    expect(row.querySelector('[data-steer-line]')?.getAttribute('data-steer-line')).toBe(phase);
    expect(row.querySelector('[data-steer-line]')?.textContent).toContain(phase === 'waiting' ? 'Waiting to join' : 'Sending');
    // It is not in the conversation yet: nothing to edit or fork.
    expect(rowActionButtons(row)).toEqual(['copy', 'link']);

    const delivered = await renderTranscript([
      assistantBlock('assistant-anchor', 'working on it'),
      userBlock({ id: 'user-p-now', text: 'also check the docs', userMessageId: 'p-now', promptId: 'p-now', turnId: 't1' }),
    ], rowActions);
    const settledRow = delivered.querySelector('[data-block-id="user-p-now"]')!;
    expect(settledRow.querySelector('[data-steer-line]')).toBeNull();
    expect(settledRow.querySelector('.steer-bubble')?.className).toContain('bg-bubble-user');
    expect(rowActionButtons(settledRow)).toEqual(['copy', 'edit', 'link', 'fork']);
  });

  it('keeps fork on a settled journal user even if a later regenerate prompt is still running', async () => {
    const rowActions: TranscriptRowActions = {
      disabled: false,
      onEditMessage: () => undefined,
      onRegenerate: () => undefined,
      onFork: () => undefined,
    };
    const container = await renderTranscript(
      [
        userBlock({
          id: 'user-um-anchor',
          text: 'First fixture question — edited resend.',
          userMessageId: 'um-anchor',
          promptId: 'p-regen',
        }),
        assistantBlock('agent-frame-asst-t1', 'REGENERATED-REPLY replaced the old tail.'),
      ],
      rowActions,
    );
    const rows = [...container.querySelectorAll('[data-block-id]')];
    expect(rowActionButtons(rows[0]!)).toEqual(['copy', 'edit', 'link', 'fork']);
  });

  it('hides all mutating actions when rowActions is absent (read-only surface)', async () => {
    const container = await renderTranscript([
      userBlock({ id: 'user-m1', text: 'question', userMessageId: 'm1' }),
      assistantBlock('assistant-m2-0', 'answer'),
    ]);
    const rows = [...container.querySelectorAll('[data-block-id]')];
    expect(rowActionButtons(rows[0]!)).toEqual(['copy', 'link']);
    // Copy and link are not mutations: they survive without row actions.
    expect(rowActionButtons(rows[1]!)).toEqual(['copy', 'link']);
  });

  it('copies a ?block= deep link to the message, in the shape the session route reads', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const container = await renderTranscript([
      userBlock({ id: 'user-m1', text: 'question', userMessageId: 'm1' }),
      assistantBlock('assistant-m2-0', 'answer'),
    ]);
    const link = container.querySelector<HTMLButtonElement>('[data-block-id="assistant-m2-0"] [data-row-action="link"]')!;
    await act(async () => { click(link); });
    expect(writeText).toHaveBeenCalledWith('/s/session_test?block=assistant-m2-0');
    expect(messageLinkHref('session_x', 'agent/1', 'user-m1')).toBe('/s/session_x/agent/agent%2F1?block=user-m1');
  });

  it('edits inline: prefilled editor submits through onEditMessage', async () => {
    const onEditMessage = vi.fn();
    const rowActions: TranscriptRowActions = {
      disabled: false,
      onEditMessage,
      onRegenerate: () => undefined,
      onFork: () => undefined,
    };
    const container = await renderTranscript(
      [userBlock({ id: 'user-m1', text: 'original text', userMessageId: 'm1' })],
      rowActions,
    );
    const row = container.querySelector('[data-block-id="user-m1"]')!;
    await act(async () => {
      flushSync(() => {
        click(row.querySelector('[data-row-action="edit"]')!);
      });
    });
    const textarea = container.querySelector<HTMLTextAreaElement>('[data-edit-editor] textarea');
    expect(textarea?.value).toBe('original text');
    // The attachment note explains the full-replacement semantics.
    expect(container.querySelector('[data-edit-editor]')?.textContent).toContain(
      'Keep or change attachments',
    );
    await act(async () => {
      flushSync(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
        setter.call(textarea!, 'edited text');
        textarea!.dispatchEvent(new Event('input', { bubbles: true }));
      });
    });
    await act(async () => {
      flushSync(() => {
        click(container.querySelector('[data-edit-submit]')!);
      });
    });
    expect(onEditMessage).toHaveBeenCalledOnce();
    const [block, text] = onEditMessage.mock.calls[0] as [{ text: string }, string];
    expect(block.text).toBe('original text');
    expect(text).toBe('edited text');
    // The editor closed on submit.
    expect(container.querySelector('[data-edit-editor]')).toBeNull();
  });

  it('copies the typed body and preserves selected carry annotations in the edit metadata', async () => {
    const quote = 'selected fragment';
    const comment = 'keep this selection';
    const carry = selectionCarryoverPresentation([{ quote, comment }], null);
    const originalText = `${carry.prefix}original body`;
    const expectedTypedText = `${buildQuotePrefix(quote)}${comment}\n\noriginal body`;
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const onEditMessage = vi.fn();
    const rowActions: TranscriptRowActions = {
      disabled: false,
      onEditMessage,
      onRegenerate: () => undefined,
      onFork: () => undefined,
    };
    const container = await renderTranscript(
      [userBlock({ id: 'user-annotation-edit', text: originalText, presentation: carry.presentation, userMessageId: 'm-annotation-edit' })],
      rowActions,
      undefined,
      undefined,
      true,
    );
    const row = container.querySelector('[data-block-id="user-annotation-edit"]')!;
    await act(async () => { click(row.querySelector('[data-row-action="copy"]')!); });
    expect(writeText).toHaveBeenCalledWith(expectedTypedText);

    await act(async () => {
      flushSync(() => { click(row.querySelector('[data-row-action="edit"]')!); });
    });
    const textarea = container.querySelector<HTMLTextAreaElement>('[data-edit-editor] textarea')!;
    expect(textarea.value).toBe('original body');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, 'edited body /s/session_example');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { click(container.querySelector('[data-edit-submit]')!); });
    expect(onEditMessage).toHaveBeenCalledOnce();
    expect(onEditMessage.mock.calls[0]?.[0]).toMatchObject({ text: originalText });
    const submittedText = onEditMessage.mock.calls[0]?.[1] as string;
    const submittedPresentation = onEditMessage.mock.calls[0]?.[3] as import('@kiki/transcript').TextPresentation;
    expect(submittedText.startsWith(`${carry.prefix}edited body /s/session_example`)).toBe(true);
    expect(submittedText.match(/<thread_refs>/g)).toHaveLength(1);
    expect(submittedPresentation.spans[0]).toEqual(carry.presentation.spans[0]);
    expect(projectPresentedText(submittedText, submittedPresentation)).toBe('edited body /s/session_example');
  });

  it('disables mutating actions while the session is busy', async () => {
    const rowActions: TranscriptRowActions = {
      disabled: true,
      onEditMessage: () => undefined,
      onRegenerate: () => undefined,
      onFork: () => undefined,
    };
    const container = await renderTranscript(
      [
        userBlock({ id: 'user-m1', text: 'question', userMessageId: 'm1' }),
        assistantBlock('assistant-m2-0', 'answer'),
      ],
      rowActions,
    );
    const edit = container.querySelector<HTMLButtonElement>('[data-row-action="edit"]');
    const regenerate = container.querySelector<HTMLButtonElement>('[data-row-action="regenerate"]');
    const copy = container.querySelector<HTMLButtonElement>('[data-row-action="copy"]');
    expect(edit?.disabled).toBe(true);
    expect(regenerate?.disabled).toBe(true);
    expect(copy?.disabled).toBe(false);
  });

  it('toggles the row actions ⋯ menu on click and closes on escape', async () => {
    const container = await renderTranscript([
      assistantBlock('assistant-m2-0', 'assistant message text'),
    ]);
    await drainDeferredFrames();
    const trigger = () => container.querySelector<HTMLButtonElement>('[data-row-more]');
    const menu = () => container.querySelector<HTMLElement>('[role="menu"]')!;
    expect(trigger()).not.toBeNull();
    expect(trigger()?.getAttribute('aria-expanded')).toBe('false');
    expect(menu().className).toContain('hidden');

    await act(async () => {
      flushSync(() => { click(trigger()!); });
    });
    expect(trigger()?.getAttribute('aria-expanded')).toBe('true');
    expect(menu().className).toContain('flex');

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(trigger()?.getAttribute('aria-expanded')).toBe('false');
    expect(menu().className).toContain('hidden');
  });

  it('flips the ⋯ menu upward when the row sits near the bottom of the window', async () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      // The trigger hugs the bottom edge (jsdom's window is 768px tall) and has
      // more room above than below, which is the flip condition.
      if (this.hasAttribute('data-row-more')) {
        return { x: 0, y: 720, top: 720, bottom: 748, left: 0, right: 28, width: 28, height: 28, toJSON: () => undefined } as DOMRect;
      }
      return original.call(this);
    });
    try {
      const container = await renderTranscript([
        assistantBlock('assistant-m2-0', 'assistant message text'),
      ]);
      await act(async () => {
        flushSync(() => { click(container.querySelector('[data-row-more]')!); });
      });
      const menu = container.querySelector<HTMLElement>('[role="menu"]')!;
      expect(menu.className).toContain('bottom-full');
      expect(menu.className).not.toContain('top-full');
    } finally {
      rect.mockRestore();
    }
  });

  it('hangs the strip under the message it belongs to, on the message’s own side', async () => {
    const rowActions: TranscriptRowActions = {
      disabled: false,
      onEditMessage: () => undefined,
      onRegenerate: () => undefined,
      onFork: () => undefined,
    };
    const container = await renderTranscript(
      [
        userBlock({ id: 'user-m1', text: 'question', userMessageId: 'm1' }),
        assistantBlock('assistant-m2-0', 'answer'),
      ],
      rowActions,
    );
    const userRow = container.querySelector('[data-block-id="user-m1"]')!;
    const assistantRow = container.querySelector('[data-block-id="assistant-m2-0"]')!;
    const userStrip = userRow.querySelector('[data-row-actions]')!;
    const assistantStrip = assistantRow.querySelector('[data-row-actions]')!;
    // The strip follows the bubble / the prose as a sibling — it is not floating
    // in the row's top-right corner, over whatever the text happens to paint.
    expect(userStrip.previousElementSibling?.querySelector('[data-source-block-id="user-m1"]')).not.toBeNull();
    expect(assistantStrip.previousElementSibling?.hasAttribute('data-assistant-prose')).toBe(true);
    expect(userStrip.getAttribute('data-row-actions-align')).toBe('right');
    expect(assistantStrip.getAttribute('data-row-actions-align')).toBe('left');
    for (const strip of [userStrip, assistantStrip]) {
      // An overlay off the row's bottom edge: no reserved height, so an idle
      // row carries no placeholder and a revealed strip never moves the text…
      expect(strip.className).toContain('absolute');
      expect(strip.className).toContain('top-full');
      expect(strip.className).not.toContain('min-h-7');
      // …and it only takes the pointer while revealed, so whatever it hangs
      // over keeps its clicks and its text selection.
      expect(strip.className).toContain('pointer-events-none');
      expect(strip.className).toContain('group-hover/msg:pointer-events-auto');
      expect(strip.className).toContain('group-data-[actions-open]/msg:pointer-events-auto');
      // The open `⋯` must sit above the row's other chrome (a rotated chevron on
      // a collapsed message paints like a positioned box).
      expect(strip.className).toContain('z-20');
      expect(strip.className).toContain('opacity-0');
      expect(strip.className).toContain('group-hover/msg:opacity-100');
      expect(strip.className).toContain('group-focus-within/msg:opacity-100');
      expect(strip.className).toContain('group-data-[actions-open]/msg:opacity-100');
    }
    // A 14px glyph in a flat 28px box: no border, no pill.
    const copyTile = userStrip.querySelector('[data-row-action="copy"]')!;
    expect(copyTile.className).toContain('h-7');
    expect(copyTile.className).toContain('w-7');
    expect(copyTile.className).toContain('hover:bg-ink/[0.04]');
    expect(copyTile.className).not.toContain('border');
    expect(copyTile.querySelector('svg')?.getAttribute('class')).toContain('h-3.5');
  });

  it('summons the strip with a tap on quiet message text when hover is unavailable', async () => {
    // A coarse pointer has no hover: the row publishes `data-actions-open`
    // after a tap on its quiet surface, and the strip's
    // `group-data-[actions-open]/msg:` classes reveal the icons. The stub
    // restores matchMedia by hand — `unstubAllGlobals` would also drop the
    // file-wide ResizeObserver stand-in the scrolling tests still need.
    const media = window as unknown as { matchMedia?: unknown };
    const hadMatchMedia = 'matchMedia' in window;
    const originalMatchMedia = media.matchMedia;
    media.matchMedia = (query: string) => ({
      matches: query === '(hover: none)',
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    });
    try {
      const rowActions: TranscriptRowActions = {
        disabled: false,
        onEditMessage: () => undefined,
        onRegenerate: () => undefined,
        onFork: () => undefined,
      };
      const container = await renderTranscript(
        [userBlock({ id: 'user-m1', text: 'question', userMessageId: 'm1' })],
        rowActions,
      );
      const row = () => container.querySelector('[data-block-id="user-m1"]')!;
      expect(row().querySelector('[data-actions-open]')).toBeNull();

      // A tap on the bubble text opens the strip; a second tap closes it.
      await act(async () => { click(row().querySelector('[data-source-block-id="user-m1"]')!); });
      expect(row().querySelector('[data-actions-open]')).not.toBeNull();
      await act(async () => { click(row().querySelector('[data-source-block-id="user-m1"]')!); });
      expect(row().querySelector('[data-actions-open]')).toBeNull();

      // A tap on a tile acts on the tile — the toggle never swallows it, and
      // the summon survives the edit round-trip.
      await act(async () => { click(row().querySelector('[data-source-block-id="user-m1"]')!); });
      expect(row().querySelector('[data-actions-open]')).not.toBeNull();
      await act(async () => { click(row().querySelector('[data-row-action="edit"]')!); });
      expect(row().querySelector('[data-edit-editor]')).not.toBeNull();
      await act(async () => { click(row().querySelector('[data-edit-cancel]')!); });
      expect(row().querySelector('[data-actions-open]')).not.toBeNull();

      // A pointerdown outside the row closes an open strip.
      await act(async () => {
        document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
      });
      expect(row().querySelector('[data-actions-open]')).toBeNull();
    } finally {
      if (hadMatchMedia) media.matchMedia = originalMatchMedia;
      else delete media.matchMedia;
    }
  });

  it('ignores quiet-surface taps when hover is available (desktop pointer)', async () => {
    // jsdom has no matchMedia, which the hook treats as a fine pointer: the
    // row's clicks keep their plain meaning and no `data-actions-open` appears.
    const rowActions: TranscriptRowActions = {
      disabled: false,
      onEditMessage: () => undefined,
      onRegenerate: () => undefined,
      onFork: () => undefined,
    };
    const container = await renderTranscript(
      [userBlock({ id: 'user-m1', text: 'question', userMessageId: 'm1' })],
      rowActions,
    );
    const row = container.querySelector('[data-block-id="user-m1"]')!;
    await act(async () => { click(row.querySelector('[data-source-block-id="user-m1"]')!); });
    expect(row.querySelector('[data-actions-open]')).toBeNull();
  });

  it('folds the tiled icons into the ⋯ menu below sm', async () => {
    const rowActions: TranscriptRowActions = {
      disabled: false,
      onEditMessage: () => undefined,
      onRegenerate: () => undefined,
      onFork: () => undefined,
    };
    const container = await renderTranscript(
      [userBlock({ id: 'user-m1', text: 'question', userMessageId: 'm1' })],
      rowActions,
    );
    const row = container.querySelector('[data-block-id="user-m1"]')!;
    const tiles = row.querySelector('[data-row-action-tiles]')!;
    expect(tiles.className).toContain('hidden');
    expect(tiles.className).toContain('sm:flex');
    // Every action is one control on the flat surface…
    expect(rowActionButtons(row)).toEqual(['copy', 'edit', 'link', 'fork']);
    // …and a narrow lane gets its own copies of the tiled three inside the menu.
    expect(rowMenuItems(row)).toEqual(['copy', 'edit']);
    for (const item of row.querySelectorAll('[data-row-action-menu]')) {
      expect(item.className).toContain('sm:hidden');
    }
    const more = row.querySelector('[data-row-more]')!;
    expect(more.getAttribute('aria-haspopup')).toBe('menu');
    expect(more.className).toContain('h-7');
    // The trigger itself stays at every width while the menu-only actions exist.
    expect(more.className).not.toContain('sm:hidden');
  });

  it('keeps Esc and the arrow keys working inside a user row’s ⋯ menu', async () => {
    const onFork = vi.fn();
    const rowActions: TranscriptRowActions = {
      disabled: false,
      onEditMessage: () => undefined,
      onRegenerate: () => undefined,
      onFork,
    };
    const container = await renderTranscript(
      [userBlock({ id: 'user-m1', text: 'question', userMessageId: 'm1' })],
      rowActions,
    );
    // Re-query on every step: a virtualized row can be re-rendered between reads,
    // and a captured node would then be a detached copy of the control.
    const trigger = () => container.querySelector<HTMLButtonElement>('[data-block-id="user-m1"] [data-row-more]')!;
    const menu = () => container.querySelector<HTMLElement>('[data-block-id="user-m1"] [role="menu"]')!;
    const items = () => [...menu().querySelectorAll<HTMLButtonElement>('button:not([disabled])')];

    await drainDeferredFrames();
    await act(async () => { flushSync(() => { click(trigger()); }); });
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(menu().className).toContain('flex');

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(document.activeElement).toBe(items()[0]);
    // ArrowUp wraps to the last item — the fork the menu exists for.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    expect(document.activeElement).toBe(items()[items().length - 1]);
    await act(async () => { click(document.activeElement as Element); });
    expect(onFork).toHaveBeenCalledTimes(1);
    expect(menu().className).toContain('hidden');

    // Escape closes and hands focus back to the trigger.
    await act(async () => { flushSync(() => { click(trigger()); }); });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(menu().className).toContain('hidden');
    expect(document.activeElement).toBe(trigger());
  });
});

describe('user message body sizing', () => {
  it('does not render a collapse toggle for short messages', async () => {
    const container = await renderTranscript([userBlock({ id: 'user-m1', text: 'short' })]);
    expect(container.querySelector('[data-collapsible-toggle]')).toBeNull();
  });

  it('keeps a long user body fully expanded without a max-height clamp', async () => {
    const text = 'x'.repeat(600);
    const container = await renderTranscript([userBlock({ id: 'user-m1', text })]);
    const content = container.querySelector<HTMLElement>('[data-source-block-id="user-m1"]')!;
    expect(content.textContent).toBe(text);
    expect(content.className).not.toContain('max-h-60');
    expect(content.className).not.toContain('collapsed-content-fade');
    expect(container.querySelector('[data-collapsible-content]')).toBeNull();
    expect(container.querySelector('[data-collapsible-toggle]')).toBeNull();
  });
});

function snapshotResponse() {
  return {
    as_of_seq: 0,
    epoch: 'epoch-canonical',
    session: {
      id: 'session_test',
      workspace_id: 'wd_test',
      title: 'Canonical',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      busy: false,
      metadata: { cwd: 'C:/tmp' },
      agent_config: { model: '' },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        total_cost_usd: 0,
        context_tokens: 0,
        context_limit: 0,
        turn_count: 0,
      },
      permission_rules: [],
      message_count: 0,
      last_seq: 0,
    },
    messages: { items: [], has_more: false },
    in_flight_turn: null,
    pending_approvals: [],
    pending_questions: [],
  };
}

function emptyTranscriptPage(): AgentTranscriptResponse {
  return {
    agent_id: 'main',
    items: [],
    has_more: false,
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    prompts: [],
    meta: {},
  };
}

async function openLiveTranscript() {
  const client = {
    snapshot: vi.fn(async () => snapshotResponse()),
    listPrompts: vi.fn(async () => ({ active: null, queued: [] })),
    listTasks: vi.fn(async () => ({ items: [] })),
    getSessionGoal: vi.fn(async () => null),
    getAgentTranscript: vi.fn(async () => emptyTranscriptPage()),
    submitPrompt: vi.fn(),
  };
  const socket = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    updateCursor: vi.fn(),
    abort: vi.fn(),
    setTranscriptGrades: vi.fn(),
    restartGeneration: vi.fn(),
    updateTranscriptSince: vi.fn(),
    clearTranscriptSince: vi.fn(),
  };
  const pending: (() => void)[] = [];
  const controller = new SessionController(
    client as unknown as KikiClient,
    {
      snapshot: client.snapshot,
      transcript: {
        page: client.getAgentTranscript as unknown as import('@kiki/klient/session-view').SessionViewFacade['transcript']['page'],
        catchUp: vi.fn(),
      },
      subscribe: () => ({
        updateSessionCursor: socket.updateCursor,
        setTranscriptGrades: socket.setTranscriptGrades,
        updateTranscriptCursor: socket.updateTranscriptSince,
        restart: socket.restartGeneration,
        nudge: vi.fn(),
        close: socket.unsubscribe,
      }),
    },
    'session_test',
    {
      scheduler: {
        schedule(callback: () => void) {
          pending.push(callback);
          return pending.length;
        },
        cancel: () => {
          pending.length = 0;
        },
      },
    },
  );
  await controller.open();
  return {
    controller,
    client,
    flush() {
      while (pending.length > 0) pending.shift()?.();
    },
  };
}

function transcriptTree(
  controller: SessionController,
  extras?: { forest?: ReturnType<SessionController['getForest']>; composer?: boolean },
): ReactNode {
  const composer = extras?.composer === true
    ? (
        <textarea
          data-composer
          defaultValue="keep focus"
        />
      )
    : null;
  return (
    <>
      <Transcript
        state={controller.getState()}
        forest={extras?.forest ?? controller.getForest()}
        onLoadOlder={() => Promise.resolve(false)}
        onResolveApproval={() => noopActions()}
        onAnswerQuestion={() => noopActions()}
        onDismissQuestion={() => noopActions()}
        rowActions={{
          disabled: false,
          onEditMessage: () => undefined,
          onRegenerate: () => undefined,
          onFork: () => undefined,
        }}
      />
      {composer}
    </>
  );
}

async function renderController(
  controller: SessionController,
  extras?: { forest?: ReturnType<SessionController['getForest']>; composer?: boolean },
): Promise<{ root: Root; container: HTMLDivElement }> {
  const { root, container } = makeRoot();
  await renderSettled(root, transcriptTree(controller, extras));
  return { root, container };
}

function virtualBlocks(count: number, prefix = 'block'): Block[] {
  return Array.from({ length: count }, (_, index) => assistantBlock(`${prefix}-${index}`, `message ${index}`));
}

function virtualTranscript(
  state: SessionViewState,
  onLoadOlder: () => Promise<boolean> = () => Promise.resolve(false),
): ReactNode {
  return (
    <Transcript
      state={state}
      onLoadOlder={onLoadOlder}
      onResolveApproval={() => noopActions()}
      onAnswerQuestion={() => noopActions()}
      onDismissQuestion={() => noopActions()}
    />
  );
}

function interactiveVirtualTranscript(
  state: SessionViewState,
  options: {
    rowActions?: TranscriptRowActions;
    onResolveApproval?: (
      approvalId: string,
      decision: ApprovalDecision,
      scope?: 'session',
      selectedOptionId?: string,
    ) => Promise<void>;
    onAnswerQuestion?: (
      questionId: string,
      answers: Record<string, QuestionAnswer>,
    ) => Promise<void>;
  } = {},
): ReactNode {
  return (
    <Transcript
      state={state}
      onLoadOlder={() => Promise.resolve(false)}
      onResolveApproval={options.onResolveApproval ?? (() => noopActions())}
      onAnswerQuestion={options.onAnswerQuestion ?? (() => noopActions())}
      onDismissQuestion={() => noopActions()}
      rowActions={options.rowActions}
    />
  );
}

function pendingVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function virtualApprovalBlock(id = 'approval-a1'): Block {
  return {
    kind: 'approval',
    id,
    request: {
      approval_id: id,
      session_id: 'session_test',
      tool_call_id: `call-${id}`,
      tool_name: 'Bash',
      action: 'Run command',
      tool_input_display: { command: 'pnpm test' },
      created_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2026-01-02T00:00:00.000Z',
    },
    resolution: undefined,
  };
}

function virtualQuestionBlock(id = 'question-q1'): Block {
  return {
    kind: 'question',
    id,
    request: {
      question_id: id,
      session_id: 'session_test',
      questions: [{
        id: 'choice',
        question: 'Pick one',
        options: [
          { id: 'alpha', label: 'Alpha' },
          { id: 'beta', label: 'Beta' },
        ],
      }],
      created_at: '2026-01-01T00:00:00.000Z',
    },
    outcome: undefined,
  };
}

function virtualItemStart(item: Element): number {
  return Number.parseFloat((item as HTMLElement).style.top || '0');
}

function currentVirtualAnchor(container: HTMLDivElement): { blockId: string; offset: number } {
  const scroll = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;
  const items = [...container.querySelectorAll<HTMLElement>('[data-transcript-virtual-item]')];
  const item = items
    .filter((candidate) => virtualItemStart(candidate) <= scroll.scrollTop)
    .sort((left, right) => virtualItemStart(right) - virtualItemStart(left))[0] ?? items[0]!;
  return {
    blockId: item.querySelector<HTMLElement>('[data-block-id]')!.dataset['blockId']!,
    offset: virtualItemStart(item) - scroll.scrollTop,
  };
}

async function setTranscriptScroll(scroll: HTMLElement, top: number): Promise<void> {
  await act(async () => {
    scroll.scrollTop = top;
    scroll.dispatchEvent(new Event('scroll'));
  });
}

async function settleVirtualizer(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 35));
  });
}

async function settleReadingFrames(): Promise<void> {
  // Flush React between measured frames, as the browser does. One long act
  // batches all virtual-row positioning commits until after restore finishes.
  for (let frame = 0; frame < 20; frame += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 16)); });
  }
}

function transcriptDistanceFromEnd(scroll: HTMLElement): number {
  const max = scroll.scrollHeight - scroll.clientHeight;
  return max - scroll.scrollTop;
}

describe('virtualized transcript scrolling', () => {
  it('keeps unverified coverage quiet while older pages remain to load', async () => {
    const container = await renderTranscript([userBlock({ id: 'known-turn', text: 'known message' })], undefined, {
      historyCoverageKind: 'unknown', hasMoreHistory: true, oldestMessageId: 'known-turn', fetchedOlder: false,
    });
    expect(container.querySelector('[data-top-edge="unverified"]')).toBeNull();
    expect(container.textContent).toContain('Load earlier messages');
  });

  it('says unverified history is partial, as one quiet line, once the pages run out', async () => {
    const container = await renderTranscript([userBlock({ id: 'known-turn', text: 'known message' })], undefined, {
      historyCoverageKind: 'unknown', hasMoreHistory: false, oldestMessageId: 'known-turn', fetchedOlder: true,
    });
    const line = container.querySelector('[data-top-edge="unverified"]');
    expect(line?.getAttribute('role')).toBe('status');
    expect(line?.textContent).toContain('Earlier history is unverified');
    expect(line?.querySelector('button')).toBeNull();
    expect(container.textContent).not.toContain('beginning of history');
  });

  it('hangs a failed prompt on its bubble as a neutral line with the turn error behind Details', async () => {
    const container = await renderTranscript([
      userBlock({
        id: 'user-failed', text: 'please retry me', userMessageId: 'um-failed', turnId: 't1',
        promptOutcome: { status: 'failed', delivered: true, error: 'Connection error.', at: '2026-01-01T00:00:02.000Z' },
      }),
    ]);
    const line = container.querySelector('[data-prompt-outcome="failed"]');
    expect(line?.textContent).toContain('Reply failed');
    expect(line?.querySelector('.text-danger')).toBeNull();
    expect(container.querySelector('[data-notice-tone="danger"]')).toBeNull();
    const details = [...line!.querySelectorAll('button')].find((button) => button.textContent?.includes('Details'))!;
    expect(details.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { details.click(); });
    expect(container.querySelector('[data-prompt-outcome-details]')?.textContent).toBe('Connection error.');
  });

  it('merges earlier settled prompts into one expandable neutral row', async () => {
    const container = await renderTranscript([
      {
        kind: 'notice', id: 'notice-prompt-outcomes-earlier', text: '3 earlier', tone: 'neutral',
        i18n: { key: 'notice.earlierPromptOutcomes', params: { count: 3 } },
        earlierPromptOutcomes: [
          { promptId: 'p1', userMessageId: 'p1', status: 'failed', text: 'first' },
          { promptId: 'p2', userMessageId: 'p2', status: 'failed', text: 'second' },
          { promptId: 'p3', userMessageId: 'p3', status: 'aborted', text: 'third' },
        ],
      },
      userBlock({ id: 'u-now', text: 'current' }),
    ]);
    const row = container.querySelector('[data-prompt-failed-run]')!;
    expect(row.textContent).toContain('3 earlier messages did not complete');
    expect(container.querySelectorAll('[data-prompt-failed-entry]')).toHaveLength(0);
    const toggle = row.querySelector('button[aria-expanded]') as HTMLButtonElement;
    await act(async () => { toggle.click(); });
    expect([...container.querySelectorAll('[data-prompt-failed-entry]')].map((el) => el.getAttribute('data-prompt-failed-entry')))
      .toEqual(['failed', 'failed', 'aborted']);
  });

  it('positions the next row in the same resize delivery instead of a later animation frame', async () => {
    const { root, container } = makeRoot();
    await renderSettled(root, virtualTranscript(transcriptState([
      userBlock({ id: 'growing-user', text: 'long message' }),
      assistantBlock('next-reply', 'must stay below the user message'),
    ])));
    await settleVirtualizer();
    const first = container.querySelector<HTMLElement>('[data-transcript-virtual-item][data-index="0"]')!;
    const second = container.querySelector<HTMLElement>('[data-transcript-virtual-item][data-index="1"]')!;
    act(() => {
      resizeElement(first, 900);
      expect(virtualItemStart(second)).toBe(virtualItemStart(first) + 900 + 16);
      resizeElement(first, 120);
      expect(virtualItemStart(second)).toBe(virtualItemStart(first) + 120 + 16);
    });
  });

  it('keeps an end-anchored viewport pinned when the streaming last row grows past the estimate', async () => {
    // The regression behind the user-bubble overlap: during a streaming turn
    // the last row grows from the 120px estimate to its real height. The
    // fork's re-measure rule skips the compensation for a row that spans the
    // fold, and its virtual wasAtEnd gate reads the stale estimate — so the
    // end anchor was lost the first time the viewport rested below a growing
    // block, and every later append (the next user bubble included) drew
    // below the fold. The DOM-distance predicate re-asserts the anchor.
    const { root, container } = makeRoot();
    await renderSettled(root, virtualTranscript(transcriptState([
      userBlock({ id: 'stream-user', text: 'the prompt' }),
      assistantBlock('stream-reply', 'the growing answer'),
    ])));
    await settleVirtualizer();
    const scroll = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;
    // Anchor at the end, as the initial scrollToEnd leaves it.
    await setTranscriptScroll(scroll, scroll.scrollHeight - scroll.clientHeight);
    await settleVirtualizer();
    expect(transcriptDistanceFromEnd(scroll)).toBeLessThanOrEqual(80);

    // The streaming row grows past the estimate (120 → 515) while the turn
    // runs; the viewport must stay pinned at the end.
    const replyItem = container.querySelector<HTMLElement>(
      '[data-block-id="stream-reply"]',
    )!.closest<HTMLElement>('[data-transcript-virtual-item]')!;
    act(() => {
      resizeElement(replyItem, 515);
    });
    await settleVirtualizer();
    expect(transcriptDistanceFromEnd(scroll)).toBeLessThanOrEqual(80);

    // A later append (the turn's next user bubble) follows the growth.
    const appended = userBlock({ id: 'stream-user-2', text: 'the steer' });
    await renderSettled(root, virtualTranscript(transcriptState([
      userBlock({ id: 'stream-user', text: 'the prompt' }),
      assistantBlock('stream-reply', 'the growing answer'),
      appended,
    ])));
    await settleVirtualizer();
    expect(transcriptDistanceFromEnd(scroll)).toBeLessThanOrEqual(80);
    expect(container.querySelector('[data-block-id="stream-user-2"]')).not.toBeNull();
  });

  it('remeasures a returning row before positioning its successor', async () => {
    const first = assistantBlock('returning-first', 'first');
    const second = assistantBlock('returning-second', 'second');
    const { root, container } = makeRoot();
    await renderSettled(root, virtualTranscript(transcriptState([first, second])));
    await renderSettled(root, virtualTranscript(transcriptState([second])));
    blockHeights.set('returning-first', 180);
    try {
      await renderSettled(root, virtualTranscript(transcriptState([first, second])));
      const firstItem = container.querySelector<HTMLElement>('[data-block-id="returning-first"]')!
        .closest<HTMLElement>('[data-transcript-virtual-item]')!;
      const secondItem = container.querySelector<HTMLElement>('[data-block-id="returning-second"]')!
        .closest<HTMLElement>('[data-transcript-virtual-item]')!;
      expect(virtualItemStart(secondItem)).toBe(virtualItemStart(firstItem) + 180 + 16);
    } finally {
      blockHeights.delete('returning-first');
    }
  });

  it('falls back to offsetHeight when a resize entry lacks borderBoxSize', async () => {
    const { root, container } = makeRoot();
    await renderSettled(root, virtualTranscript(transcriptState([
      assistantBlock('legacy-first', 'first'),
      assistantBlock('legacy-second', 'second'),
    ])));
    await settleVirtualizer();
    const firstItem = container.querySelector<HTMLElement>('[data-block-id="legacy-first"]')!
      .closest<HTMLElement>('[data-transcript-virtual-item]')!;
    const secondItem = container.querySelector<HTMLElement>('[data-block-id="legacy-second"]')!
      .closest<HTMLElement>('[data-transcript-virtual-item]')!;
    act(() => {
      elementHeights.set(firstItem, 150);
      for (const observer of resizeObservers) observer.triggerWithoutBorderBoxSize(firstItem);
    });
    expect(virtualItemStart(secondItem)).toBe(virtualItemStart(firstItem) + 150 + 16);
  });

  it('keeps the mounted block DOM bounded for a large transcript', async () => {
    const blocks = virtualBlocks(1000);
    const { root, container } = makeRoot();
    await renderSettled(root, virtualTranscript(transcriptState(blocks)));

    const rows = container.querySelectorAll('[data-block-id]');
    expect(rows.length).toBeLessThan(24);
    expect(container.querySelector('[data-block-id="block-0"]')).toBeNull();
    expect(container.querySelector('[data-block-id="block-999"]')).not.toBeNull();
  });

  it('keeps an inline edit draft mounted while scrolling away and back', async () => {
    const rowActions: TranscriptRowActions = {
      disabled: false,
      onEditMessage: () => undefined,
      onRegenerate: () => undefined,
      onFork: () => undefined,
    };
    const edited = userBlock({
      id: 'user-edit-pinned',
      text: 'original draft',
      userMessageId: 'edit-pinned',
    });
    const state = transcriptState([...virtualBlocks(100, 'edit-history'), edited]);
    const { root, container } = makeRoot();
    await renderSettled(root, interactiveVirtualTranscript(state, { rowActions }), true);
    const scroll = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;
    const row = container.querySelector<HTMLElement>('[data-block-id="user-edit-pinned"]')!;

    await act(async () => { click(row.querySelector('[data-row-action="edit"]')!); });
    await settleVirtualizer();
    const textarea = row.querySelector<HTMLTextAreaElement>('[data-edit-editor] textarea')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, 'draft survives virtualization');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await setTranscriptScroll(scroll, 0);
    await settleVirtualizer();
    expect(container.querySelector('[data-block-id="user-edit-pinned"]')).toBe(row);
    await setTranscriptScroll(scroll, scroll.scrollHeight - scroll.clientHeight);
    await settleVirtualizer();
    expect(row.querySelector<HTMLTextAreaElement>('[data-edit-editor] textarea')).toBe(textarea);
    expect(textarea.value).toBe('draft survives virtualization');
  });

  it('keeps question selections mounted while scrolling away and back', async () => {
    const question = virtualQuestionBlock();
    const state = transcriptState([...virtualBlocks(100, 'question-history'), question]);
    const { root, container } = makeRoot();
    await renderSettled(root, interactiveVirtualTranscript(state));
    const scroll = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;
    const row = container.querySelector<HTMLElement>('[data-block-id="question-q1"]')!;
    const option = row.querySelector<HTMLButtonElement>('button[aria-pressed]')!;

    await act(async () => { click(option); });
    expect(option.getAttribute('aria-pressed')).toBe('true');
    await setTranscriptScroll(scroll, 0);
    await settleVirtualizer();
    expect(container.querySelector('[data-block-id="question-q1"]')).toBe(row);
    await setTranscriptScroll(scroll, scroll.scrollHeight - scroll.clientHeight);
    await settleVirtualizer();
    expect(row.querySelector('button[aria-pressed="true"]')).toBe(option);
  });

  it('keeps submitting approvals and questions mounted without reopening submission', async () => {
    const approvalPending = pendingVoid();
    const questionPending = pendingVoid();
    const onResolveApproval = vi.fn(() => approvalPending.promise);
    const onAnswerQuestion = vi.fn(() => questionPending.promise);
    const state = transcriptState([
      ...virtualBlocks(100, 'submit-history'),
      virtualApprovalBlock(),
      virtualQuestionBlock(),
    ]);
    const { root, container } = makeRoot();
    await renderSettled(root, interactiveVirtualTranscript(state, {
      onResolveApproval,
      onAnswerQuestion,
    }));
    const scroll = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;
    const approvalRow = container.querySelector<HTMLElement>('[data-block-id="approval-a1"]')!;
    const questionRow = container.querySelector<HTMLElement>('[data-block-id="question-q1"]')!;
    const approvalSubmit = [...approvalRow.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Approve') === true)!;
    const remember = approvalRow.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const questionOption = questionRow.querySelector<HTMLButtonElement>('button[aria-pressed]')!;
    await act(async () => {
      remember.click();
      click(questionOption);
    });
    const questionSubmit = [...questionRow.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Submit') === true)!;

    await act(async () => {
      click(approvalSubmit);
      click(questionSubmit);
    });
    expect(onResolveApproval).toHaveBeenCalledTimes(1);
    expect(onResolveApproval).toHaveBeenCalledWith('approval-a1', 'approved', 'session', undefined);
    expect(onAnswerQuestion).toHaveBeenCalledTimes(1);
    expect(approvalSubmit.disabled).toBe(true);
    expect(questionSubmit.disabled).toBe(true);

    await setTranscriptScroll(scroll, 0);
    await settleVirtualizer();
    expect(container.querySelector('[data-block-id="approval-a1"]')).toBe(approvalRow);
    expect(container.querySelector('[data-block-id="question-q1"]')).toBe(questionRow);
    expect(remember.checked).toBe(true);
    await setTranscriptScroll(scroll, scroll.scrollHeight - scroll.clientHeight);
    await settleVirtualizer();
    approvalSubmit.click();
    questionSubmit.click();
    expect(onResolveApproval).toHaveBeenCalledTimes(1);
    expect(onAnswerQuestion).toHaveBeenCalledTimes(1);

    await act(async () => {
      approvalPending.resolve();
      questionPending.resolve();
      await Promise.all([approvalPending.promise, questionPending.promise]);
    });
  });

  it('follows append only while the viewport was already at the end', async () => {
    const initial = virtualBlocks(120);
    const { root, container } = makeRoot();
    await renderSettled(root, virtualTranscript(transcriptState(initial)));
    const scroll = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;
    await setTranscriptScroll(scroll, scroll.scrollHeight - scroll.clientHeight);

    await renderSettled(root, virtualTranscript(transcriptState([...initial, assistantBlock('append-1', 'latest')])));
    await settleVirtualizer();
    expect(transcriptDistanceFromEnd(scroll)).toBe(0);

    await setTranscriptScroll(scroll, scroll.scrollTop - 500);
    const readingTop = scroll.scrollTop;
    await renderSettled(
      root,
      virtualTranscript(transcriptState([...initial, assistantBlock('append-1', 'latest'), assistantBlock('append-2', 'newer')])),
    );
    await settleVirtualizer();
    expect(scroll.scrollTop).toBe(readingTop);
  });

  it('keeps the same reading anchor when older blocks prepend', async () => {
    const current = virtualBlocks(160, 'current');
    const { root, container } = makeRoot();
    await renderSettled(root, virtualTranscript(transcriptState(current)));
    const scroll = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;
    await settleVirtualizer();
    await setTranscriptScroll(scroll, 6000);
    const before = currentVirtualAnchor(container);

    await renderSettled(
      root,
      virtualTranscript(transcriptState([...virtualBlocks(20, 'older'), ...current])),
    );
    await settleVirtualizer();
    const after = currentVirtualAnchor(container);
    expect(after.blockId).toBe(before.blockId);
    expect(after.offset).toBe(before.offset);
  });

  it('loads one older page only after an upward browsing gesture at the top edge', async () => {
    const onLoadOlder = vi.fn(async () => true);
    const current = virtualBlocks(100, 'history');
    const state = { ...transcriptState(current), hasMoreHistory: true };
    const { root, container } = makeRoot();
    await renderSettled(root, virtualTranscript(state, onLoadOlder));
    const scroll = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;
    await settleVirtualizer();
    expect(onLoadOlder).not.toHaveBeenCalled();

    await setTranscriptScroll(scroll, 0);
    await settleVirtualizer();
    expect(onLoadOlder).not.toHaveBeenCalled();
    await act(async () => { scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true })); });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    await renderSettled(root, virtualTranscript({ ...state, blocks: [...virtualBlocks(20, 'older'), ...current] }, onLoadOlder));
    await settleVirtualizer();
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    await setTranscriptScroll(scroll, 0);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    await act(async () => { scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true })); });
    expect(onLoadOlder).toHaveBeenCalledTimes(2);
  });

  it('loads an older page from the top button without a wheel gesture', async () => {
    const onLoadOlder = vi.fn(async () => true);
    const { root, container } = makeRoot();
    await renderSettled(root, virtualTranscript({ ...transcriptState(virtualBlocks(100)), hasMoreHistory: true }, onLoadOlder));
    const scroll = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;
    await settleVirtualizer();
    await setTranscriptScroll(scroll, 0);
    await settleVirtualizer();
    const loadButton = scroll.querySelector<HTMLButtonElement>('button.mx-auto.block.rounded-full');
    expect(loadButton).not.toBeNull();
    await act(async () => { loadButton!.click(); });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('loads one page when an upward gesture reaches the top from further away', async () => {
    const onLoadOlder = vi.fn(async () => true);
    const { root, container } = makeRoot();
    await renderSettled(root, virtualTranscript({ ...transcriptState(virtualBlocks(100)), hasMoreHistory: true }, onLoadOlder));
    const scroll = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;
    await settleVirtualizer();
    await setTranscriptScroll(scroll, 5000);
    await act(async () => { scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true })); });
    expect(onLoadOlder).not.toHaveBeenCalled();
    await setTranscriptScroll(scroll, 0);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: 'a transcript reset', resetVersion: 1, nextBlocks: virtualBlocks(2, 'replacement') },
    { label: 'content shortening', resetVersion: 0, nextBlocks: virtualBlocks(2, 'replacement') },
  ])('discards an old upward intent when $label moves the viewport to the top', async ({ resetVersion, nextBlocks }) => {
    const onLoadOlder = vi.fn(async () => true);
    const initial = { ...transcriptState(virtualBlocks(100, 'history')), hasMoreHistory: true };
    const { root, container } = makeRoot();
    await renderSettled(root, virtualTranscript(initial, onLoadOlder));
    const scroll = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;
    await setTranscriptScroll(scroll, 5000);
    await act(async () => { scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true })); });
    expect(onLoadOlder).not.toHaveBeenCalled();

    await renderSettled(root, virtualTranscript({ ...initial, blocks: nextBlocks, transcriptResetVersion: resetVersion }, onLoadOlder));
    expect(onLoadOlder).not.toHaveBeenCalled();
    await setTranscriptScroll(scroll, 0);
    await settleVirtualizer();
    expect(onLoadOlder).not.toHaveBeenCalled();
    await act(async () => { scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true })); });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('does not treat a delayed programmatic scroll as the old upward gesture', async () => {
    const onLoadOlder = vi.fn(async () => true);
    const { root, container } = makeRoot();
    await renderSettled(root, virtualTranscript({ ...transcriptState(virtualBlocks(100)), hasMoreHistory: true }, onLoadOlder));
    const scroll = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;
    await setTranscriptScroll(scroll, 5000);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      await act(async () => { scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true })); });
      expect(onLoadOlder).not.toHaveBeenCalled();
      clock.mockReturnValue(2001);
      await setTranscriptScroll(scroll, 0);
      expect(onLoadOlder).not.toHaveBeenCalled();
      await act(async () => { scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true })); });
      expect(onLoadOlder).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  it('ignores an upward gesture overtaken by a pending reset anchor restoration', async () => {
    const onLoadOlder = vi.fn(async () => true);
    const state = { ...transcriptState(virtualBlocks(100, 'anchor-reset')), hasMoreHistory: true };
    const { root, container } = makeRoot();
    await renderSettled(root, virtualTranscript(state, onLoadOlder));
    const scroll = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;
    await settleVirtualizer();
    await setTranscriptScroll(scroll, 0);
    await settleVirtualizer();

    let nextFrame = 1;
    const frames = new Map<number, FrameRequestCallback>();
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextFrame;
      nextFrame += 1;
      frames.set(id, callback);
      return id;
    });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id); });
    try {
      await renderSettled(root, virtualTranscript({ ...state, transcriptResetVersion: 1 }, onLoadOlder));
      expect(frames.size).toBeGreaterThan(0);
      await setTranscriptScroll(scroll, 5000);
      await act(async () => { scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true })); });
      expect(onLoadOlder).not.toHaveBeenCalled();
      await act(async () => {
        for (let iteration = 0; iteration < 10 && frames.size > 0; iteration += 1) {
          const batch = [...frames.entries()];
          frames.clear();
          for (const [, callback] of batch) callback(performance.now());
        }
      });
      expect(scroll.scrollTop).toBeLessThanOrEqual(48);
      expect(onLoadOlder).not.toHaveBeenCalled();
      await act(async () => { scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true })); });
      expect(onLoadOlder).toHaveBeenCalledTimes(1);
    } finally {
      raf.mockRestore();
      cancel.mockRestore();
    }
  });

  it('restores the end or reading anchor after a full measurement reset', async () => {
    const blocks = virtualBlocks(160, 'reset');
    const { root, container } = makeRoot();
    await renderSettled(root, virtualTranscript(transcriptState(blocks)));
    const scroll = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;
    await setTranscriptScroll(scroll, scroll.scrollHeight - scroll.clientHeight);

    await renderSettled(
      root,
      virtualTranscript({ ...transcriptState(blocks), transcriptResetVersion: 1 }),
    );
    await settleVirtualizer();
    expect(transcriptDistanceFromEnd(scroll)).toBe(0);

    await setTranscriptScroll(scroll, 7000);
    const before = currentVirtualAnchor(container);
    const resetBlocks = blocks.map((block) => block.kind === 'assistant' ? { ...block } : block);
    await renderSettled(
      root,
      virtualTranscript({ ...transcriptState(resetBlocks), transcriptResetVersion: 2 }),
    );
    await settleVirtualizer();
    const row = container.querySelector<HTMLElement>(`[data-block-id="${before.blockId}"]`)!;
    const item = row.closest<HTMLElement>('[data-transcript-virtual-item]')!;
    expect(virtualItemStart(item) - scroll.scrollTop).toBe(before.offset);
  });

  it('finishes reset restoration when a same-version delta lands before its frame', async () => {
    const blocks = virtualBlocks(160, 'reset-race');
    const { root, container } = makeRoot();
    await renderSettled(root, virtualTranscript(transcriptState(blocks)));
    const scroll = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;
    await settleVirtualizer();
    await setTranscriptScroll(scroll, 7000);
    const before = currentVirtualAnchor(container);

    let nextFrame = 1;
    const frames = new Map<number, FrameRequestCallback>();
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextFrame;
      nextFrame += 1;
      frames.set(id, callback);
      return id;
    });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    try {
      const resetBlocks = blocks.map((block) => block.kind === 'assistant' ? { ...block } : block);
      await renderSettled(
        root,
        virtualTranscript({ ...transcriptState(resetBlocks), transcriptResetVersion: 1 }),
      );
      expect(frames.size).toBeGreaterThan(0);
      const deltaBlocks = resetBlocks.slice();
      const tail = deltaBlocks.at(-1)! as Extract<Block, { kind: 'assistant' }>;
      deltaBlocks[deltaBlocks.length - 1] = { ...tail, text: `${tail.text} delta` };
      await renderSettled(
        root,
        virtualTranscript({ ...transcriptState(deltaBlocks), transcriptResetVersion: 1 }),
      );
      expect(frames.size).toBeGreaterThan(0);

      await act(async () => {
        for (let iteration = 0; iteration < 10 && frames.size > 0; iteration += 1) {
          const batch = [...frames.entries()];
          frames.clear();
          for (const [, callback] of batch) callback(performance.now());
        }
      });
      const after = currentVirtualAnchor(container);
      expect(after.blockId).toBe(before.blockId);
      expect(after.offset).toBe(before.offset);
    } finally {
      raf.mockRestore();
      cancel.mockRestore();
    }
  });

  it('inherits the original anchor across consecutive full resets before restoration', async () => {
    const blocks = virtualBlocks(160, 'double-reset');
    const { root, container } = makeRoot();
    await renderSettled(root, virtualTranscript(transcriptState(blocks)));
    const scroll = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;
    await settleVirtualizer();
    await setTranscriptScroll(scroll, 7000);
    const before = currentVirtualAnchor(container);
    const mounted = [...container.querySelectorAll<HTMLElement>('[data-transcript-virtual-item]')];
    mounted.forEach((item, index) => {
      elementHeights.set(item, index % 2 === 0 ? 40 : 280);
    });

    let nextFrame = 1;
    const frames = new Map<number, FrameRequestCallback>();
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextFrame;
      nextFrame += 1;
      frames.set(id, callback);
      return id;
    });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    try {
      const firstReset = blocks.map((block) => block.kind === 'assistant' ? { ...block } : block);
      await renderSettled(
        root,
        virtualTranscript({ ...transcriptState(firstReset), transcriptResetVersion: 1 }),
      );
      expect(frames.size).toBeGreaterThan(0);
      const secondReset = firstReset.map((block) => block.kind === 'assistant' ? { ...block } : block);
      await renderSettled(
        root,
        virtualTranscript({ ...transcriptState(secondReset), transcriptResetVersion: 2 }),
      );
      expect(frames.size).toBeGreaterThan(0);

      await act(async () => {
        for (let iteration = 0; iteration < 10 && frames.size > 0; iteration += 1) {
          const batch = [...frames.entries()];
          frames.clear();
          for (const [, callback] of batch) callback(performance.now());
        }
      });
      const after = currentVirtualAnchor(container);
      expect(after.blockId).toBe(before.blockId);
      expect(after.offset).toBe(before.offset);
    } finally {
      raf.mockRestore();
      cancel.mockRestore();
    }
  });

  it('remeasures only the streaming row and keeps end pinning', async () => {
    const blocks = virtualBlocks(80, 'stream');
    const live = { ...blocks.at(-1)!, streaming: true } as Extract<Block, { kind: 'assistant' }>;
    const initial = [...blocks.slice(0, -1), live];
    const { root, container } = makeRoot();
    await renderSettled(root, virtualTranscript(transcriptState(initial)));
    const scroll = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;
    await setTranscriptScroll(scroll, scroll.scrollHeight - scroll.clientHeight);
    const content = container.querySelector<HTMLElement>('[data-transcript-virtual-content]')!;
    const liveRow = container.querySelector<HTMLElement>('[data-block-id="stream-79"]')!;
    const liveItem = liveRow.closest<HTMLElement>('[data-transcript-virtual-item]')!;
    const sibling = [...container.querySelectorAll<HTMLElement>('[data-transcript-virtual-item]')].at(-2)!;
    const siblingStart = virtualItemStart(sibling);
    const beforeSize = Number.parseFloat(content.style.height);

    await renderSettled(
      root,
      virtualTranscript(transcriptState([...initial.slice(0, -1), { ...live, text: `${live.text} delta` }])),
    );
    expect(container.querySelector('[data-block-id="stream-79"]')?.closest('[data-transcript-virtual-item]')).toBe(liveItem);

    await act(async () => {
      resizeElement(liveItem, 180);
      await new Promise((resolve) => setTimeout(resolve, 35));
    });
    expect(Number.parseFloat(content.style.height)).toBe(beforeSize + 84);
    expect(virtualItemStart(sibling)).toBe(siblingStart);
    expect(transcriptDistanceFromEnd(scroll)).toBe(0);
  });

  it('jumps to an unmounted floor through the virtual index', async () => {
    const blocks = Array.from({ length: 100 }, (_, index) => userBlock({
      id: `floor-${index}`,
      text: `floor ${index}`,
    }));
    const { root, container } = makeRoot();
    await renderSettled(root, virtualTranscript(transcriptState(blocks)));
    const ticks = container.querySelectorAll<HTMLButtonElement>('[data-floor-tick]');
    expect(ticks.length).toBe(64);
    expect(ticks[0]?.getAttribute('aria-label')).toContain('1');
    expect(ticks[63]?.getAttribute('aria-label')).toContain('100');
    expect(container.querySelector('[data-block-id="floor-0"]')).toBeNull();

    await act(async () => {
      click(container.querySelector('[data-floor-tick]')!);
      await new Promise((resolve) => setTimeout(resolve, 35));
    });
    expect(container.querySelector('[data-block-id="floor-0"]')).not.toBeNull();
  });
});

describe('canonical mount and key stability', () => {
  it('keeps the same DOM node across consecutive deltas', async () => {
    const { controller, flush } = await openLiveTranscript();
    controller.handleTranscript(resetEvent('main', userTurnSnapshot({ streaming: true, assistantText: 'He' }), 1));
    expect(controller.getState().transcriptResetVersion).toBe(1);
    const { root, container } = await renderController(controller);
    const before = container.querySelector(`[data-block-id="agent-frame-${ASSISTANT_FRAME_ID}"]`);
    expect(before).not.toBeNull();
    controller.handleTranscript(opsEvent('main', appendOps(2, 'llo'), 2));
    flush();
    await renderSettled(
      root,
      <Transcript
        state={controller.getState()}
        onLoadOlder={() => Promise.resolve(false)}
        onResolveApproval={() => noopActions()}
        onAnswerQuestion={() => noopActions()}
        onDismissQuestion={() => noopActions()}
      />,
    );
    const after = container.querySelector(`[data-block-id="agent-frame-${ASSISTANT_FRAME_ID}"]`);
    expect(after).toBe(before);
    expect(after?.textContent).toContain('Hello');
    controller.close();
  });

  it('keeps the same DOM node from running to completed', async () => {
    const { controller, flush } = await openLiveTranscript();
    controller.handleTranscript(resetEvent('main', userTurnSnapshot({ streaming: true, assistantText: 'Hello' }), 1));
    const { root, container } = await renderController(controller);
    const before = container.querySelector(`[data-block-id="agent-frame-${ASSISTANT_FRAME_ID}"]`);
    controller.handleTranscript(opsEvent('main', completeTurnOps(), 2));
    flush();
    await renderSettled(root, transcriptTree(controller));
    const after = container.querySelector(`[data-block-id="agent-frame-${ASSISTANT_FRAME_ID}"]`);
    expect(after).not.toBeNull();
    expect(after?.getAttribute('data-block-id')).toBe(before?.getAttribute('data-block-id'));
    controller.close();
  });

  it('keeps unchanged keys across reset/reconcile and prepend older', async () => {
    const { controller, client } = await openLiveTranscript();
    controller.handleTranscript(resetEvent('main', { ...userTurnSnapshot(), hasMoreOlder: true }, 1, true));
    const { root, container } = await renderController(controller);
    const live = container.querySelector(`[data-block-id="user-${USER_MESSAGE_ID}"]`);
    expect(live).not.toBeNull();
    controller.handleTranscript(resetEvent('main', { ...userTurnSnapshot(), hasMoreOlder: true }, 2, true));
    await renderSettled(root, transcriptTree(controller));
    expect(container.querySelector(`[data-block-id="user-${USER_MESSAGE_ID}"]`)).toBe(live);
    client.getAgentTranscript.mockResolvedValueOnce({
      agent_id: 'main',
      has_more: false,
      items: olderTurnSnapshot().items,
      attachments: [],
    });
    await controller.loadOlderMessages('main');
    await renderSettled(root, transcriptTree(controller));
    expect(container.querySelector(`[data-block-id="user-${USER_MESSAGE_ID}"]`)).toBe(live);
    expect(container.querySelector('[data-block-id="user-um-old"]')).not.toBeNull();
    controller.close();
  });

  it('does not remount parent rows when only a child agent appends', async () => {
    const { controller, flush } = await openLiveTranscript();
    controller.handleTranscript(resetEvent('main', userTurnSnapshot({ streaming: true, assistantText: 'delegating' }), 1));
    controller.handleTranscript(opsEvent('main', spawnChildOps(), 2));
    controller.handleTranscript(resetEvent(CHILD_AGENT_ID, childResetSnapshot(), 1));
    flush();
    const { root, container } = await renderController(controller);
    const parent = container.querySelector(`[data-block-id="agent-frame-${ASSISTANT_FRAME_ID}"]`);
    const forests = controller.forestPublishCount;
    controller.handleTranscript(opsEvent(CHILD_AGENT_ID, childAppendOps(), 2));
    flush();
    await renderSettled(
      root,
      <Transcript
        state={controller.getState()}
        forest={controller.getForest()}
        onLoadOlder={() => Promise.resolve(false)}
        onResolveApproval={() => noopActions()}
        onAnswerQuestion={() => noopActions()}
        onDismissQuestion={() => noopActions()}
      />,
    );
    expect(container.querySelector(`[data-block-id="agent-frame-${ASSISTANT_FRAME_ID}"]`)).toBe(parent);
    expect(controller.forestPublishCount).toBe(forests);
    controller.close();
  });

  it('does not steal composer focus on a pure stream update', async () => {
    const { controller, flush } = await openLiveTranscript();
    controller.handleTranscript(resetEvent('main', userTurnSnapshot({ streaming: true, assistantText: 'He' }), 1));
    const { root, container } = await renderController(controller, { composer: true });
    const textarea = container.querySelector<HTMLTextAreaElement>('[data-composer]')!;
    textarea.focus();
    expect(document.activeElement).toBe(textarea);
    controller.handleTranscript(opsEvent('main', appendOps(2, 'llo'), 2));
    flush();
    await renderSettled(
      root,
      <>
        <Transcript
          state={controller.getState()}
          onLoadOlder={() => Promise.resolve(false)}
          onResolveApproval={() => noopActions()}
          onAnswerQuestion={() => noopActions()}
          onDismissQuestion={() => noopActions()}
        />
        <textarea data-composer defaultValue="keep focus" />
      </>,
    );
    expect(container.querySelector<HTMLTextAreaElement>('[data-composer]') === document.activeElement
      || document.activeElement?.getAttribute('data-composer') === '').toBe(true);
    controller.close();
  });

  it('exposes user identity for edit/fork and refuses assistant regenerate via parsed live ids', async () => {
    const { controller } = await openLiveTranscript();
    controller.handleTranscript(resetEvent('main', userTurnSnapshot(), 1));
    const { container } = await renderController(controller);
    const userRow = container.querySelector('[data-block-id="user-agent-turn-t1-prompt"]');
    expect(userRow?.querySelector('[data-row-action="edit"]')).not.toBeNull();
    expect(userRow?.querySelector('[data-row-action="fork"]')).not.toBeNull();
    const user = controller.getState().blocks.find((block) => block.kind === 'user');
    expect(user).toMatchObject({ userMessageId: USER_MESSAGE_ID, promptId: PROMPT_ID });
    const assistant = controller.getState().blocks.find((block) => block.kind === 'assistant');
    expect(assistant?.id).toBe(`agent-frame-${ASSISTANT_FRAME_ID}`);
    expect(assistantMessageIdFromBlockId(assistant!.id)).toBeUndefined();
    controller.close();
  });
});

describe('external executor badge', () => {
  const execution = {
    executorId: 'grok',
    protocol: 'acp-v1',
    resumeMode: 'resume' as const,
    fidelity: 'degraded' as const,
    losses: ['acp_no_step_boundaries', 'tool_output_summary_only'],
  };

  async function renderWithExecutions(
    blocks: Block[],
    turnExecutions: SessionViewState['turnExecutions'],
  ): Promise<HTMLDivElement> {
    const { root, container } = makeRoot();
    await renderSettled(
      root,
      <Transcript
        state={{ ...transcriptState(blocks), turnExecutions }}
        onLoadOlder={() => Promise.resolve(false)}
        onResolveApproval={() => noopActions()}
        onAnswerQuestion={() => noopActions()}
        onDismissQuestion={() => noopActions()}
      />,
    );
    return container;
  }

  it('marks the first row of an external turn with executor, protocol and loss codes', async () => {
    const container = await renderWithExecutions(
      [
        userBlock({ id: 'user-t1', text: 'run it', turnId: 't1' }),
        {
          kind: 'assistant',
          id: 'assistant-t1-0',
          text: 'done',
          streaming: false,
          createdAt: '2026-01-01T00:00:01.000Z',
          turnId: 't1',
        },
        userBlock({ id: 'user-t2', text: 'native turn', turnId: 't2' }),
      ],
      { t1: execution },
    );

    const badges = [...container.querySelectorAll('[data-turn-execution]')];
    expect(badges).toHaveLength(1);
    const badge = badges[0]!;
    expect(badge.parentElement?.getAttribute('data-block-id')).toBe('user-t1');
    expect(badge.textContent).toContain('Grok · ACP');
    // A quiet "Partial record" note: loss codes stay machine data, the
    // tooltip reads each loss in words.
    const degraded = badge.querySelector('[data-turn-degraded]');
    expect(degraded?.textContent).toContain('Partial record');
    expect(degraded?.getAttribute('data-loss-codes')).toBe('acp_no_step_boundaries tool_output_summary_only');
    expect(badge.textContent).not.toContain('acp_no_step_boundaries');
    expect(degraded?.getAttribute('title')).toContain('step boundaries');
  });

  it('names how the profile instructions reached the engine', async () => {
    const container = await renderWithExecutions(
      [userBlock({ id: 'user-t1', text: 'run it', turnId: 't1' })],
      { t1: { ...execution, executorId: 'claude-acp', profileDelivery: 'first_prompt_preamble', fidelity: 'full', losses: [] } },
    );
    const badge = container.querySelector('[data-turn-execution]');
    expect(badge?.textContent).toContain('Claude Code · ACP');
    expect(badge?.querySelector('[data-turn-delivery]')?.textContent).toContain('instructions sent with the first message');
  });

  it('leaves turns without execution metadata unmarked', async () => {
    const container = await renderWithExecutions(
      [userBlock({ id: 'user-t1', text: 'run it', turnId: 't1' })],
      {},
    );
    expect(container.querySelector('[data-turn-execution]')).toBeNull();
  });

  it('omits the degraded marker for full-fidelity external turns', async () => {
    const container = await renderWithExecutions(
      [userBlock({ id: 'user-t1', text: 'run it', turnId: 't1' })],
      { t1: { ...execution, fidelity: 'full', losses: [] } },
    );
    const badge = container.querySelector('[data-turn-execution]');
    expect(badge?.textContent).toContain('Grok · ACP');
    expect(badge?.querySelector('[data-turn-degraded]')).toBeNull();
  });

  it('renders engine notes in the turn: delivery states, compaction divider, turn diff', async () => {
    const note = (id: string, executor: NonNullable<Extract<Block, { kind: 'notice' }>['executor']>): Block =>
      ({ kind: 'notice', id, text: 'executor', tone: 'neutral', turnId: 't1', executor });
    const container = await renderWithExecutions(
      [
        userBlock({ id: 'user-t1', text: 'run it', turnId: 't1' }),
        note('n-steer', { kind: 'hint', method: 'native_steer', status: 'delivered' }),
        note('n-queued', { kind: 'hint', method: 'next_turn_preamble', status: 'queued' }),
        note('n-dropped', { kind: 'hint', method: 'undelivered', status: 'undelivered' }),
        note('n-compact', { kind: 'compaction' }),
        note('n-diff', { kind: 'diff', diff: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n one\n+two' }),
      ],
      {},
    );
    // Settled engine notes fold with the turn's other process; open the fold.
    const fold = container.querySelector('[data-history-fold] [data-activity-toggle]');
    expect(fold).not.toBeNull();
    await act(async () => { click(fold!); });
    expect(container.querySelector('[data-executor-note="hint-delivered"]')?.textContent).toContain('reached the engine during the turn');
    // Queued is waiting, never delivered.
    const queued = container.querySelector('[data-executor-note="hint-queued"]')?.textContent ?? '';
    expect(queued).toContain('waiting');
    expect(queued).not.toContain('reached');
    expect(container.querySelector('[data-executor-note="hint-undelivered"]')?.textContent).toContain('not delivered');
    expect(container.querySelector('[data-executor-note="compaction"]')?.hasAttribute('data-timeline-divider')).toBe(true);
    const diff = container.querySelector('[data-executor-note="diff"]');
    expect(diff?.textContent).toContain('Changes this turn');
    expect(diff?.textContent).toContain('a.ts');
    expect(diff?.textContent).toContain('+1');
  });

  it('names the engine’s own context reading and a dropped image instead of the marker', async () => {
    const note = (id: string, executor: NonNullable<Extract<Block, { kind: 'notice' }>['executor']>): Block =>
      ({ kind: 'notice', id, text: 'executor', tone: 'neutral', turnId: 't1', executor });
    const container = await renderWithExecutions(
      [
        userBlock({ id: 'user-t1', text: 'read this image and fix the limit', turnId: 't1' }),
        note('n-usage', { kind: 'usage', used: 61_700, size: 200_000 }),
        note('n-image', { kind: 'session', droppedImage: { reason: 'image exceeds the engine limit', notes: ['Dropped before upload'] } }),
        note('n-model', { kind: 'session', observed: { source: 'claude-acp', model: 'claude-sonnet-4.5', version: '0.84.0' } }),
        note('n-hint', { kind: 'hint', method: 'native_steer', status: 'delivered' }),
      ],
      {},
    );
    const fold = container.querySelector('[data-history-fold] [data-activity-toggle]');
    expect(fold).not.toBeNull();
    await act(async () => { click(fold!); });

    const usage = container.querySelector('[data-executor-note="usage"]');
    // The number is labelled as the engine's, so it is never read as Kiki's
    // own context meter.
    expect(usage?.textContent).toContain('Engine context: 61.7k of 200.0k tokens');

    const dropped = container.querySelector('[data-executor-note="session"]');
    expect(dropped?.textContent).toContain('dropped an image you sent: image exceeds the engine limit');
    expect(dropped?.getAttribute('title')).toBe('Dropped before upload');

    // The engine's own identity: the observed model is stated as the engine's,
    // never as the session's Kiki model, with source and version as support.
    const observed = container.querySelector('[data-executor-note="session-model"]');
    expect(observed?.textContent).toContain('The engine is running claude-sonnet-4.5');
    expect(observed?.getAttribute('title')).toBe('claude-acp · 0.84.0');
  });
});


describe('subagent timeline dual form (G-4)', () => {
  const toolDefaults = { display: undefined, description: undefined, isError: undefined, durationMs: undefined, progressText: undefined };
  function lifecycleSubagentBlock(
    subagentId: string,
    overrides: Partial<Extract<Block, { kind: 'subagent' }>> = {},
  ): Block {
    return {
      kind: 'subagent',
      id: `subagent-${subagentId}`,
      subagentId,
      parentAgentId: 'main',
      parentToolCallId: `call-${subagentId}`,
      name: subagentId,
      description: undefined,
      model: undefined,
      thinkingEffort: undefined,
      status: 'completed',
      summary: undefined,
      error: undefined,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:01:30.000Z',
      toolCallCount: 3,
      transcript: [],
      ...overrides,
    };
  }

  function eventBlock(
    subagentId: string,
    event: Extract<Block, { kind: 'subagent-event' }>['event'],
  ): Block {
    return {
      kind: 'subagent-event',
      id: `subagent-event-${subagentId}-${event}`,
      subagentId,
      parentAgentId: 'main',
      name: subagentId,
      event,
      status: 'completed',
      at: '2026-01-01T00:00:05.000Z',
    };
  }

  async function renderWithAgents(
    blocks: Block[],
    opened: string[],
    forest?: AgentForest,
    state?: SessionViewState,
  ): Promise<HTMLDivElement> {
    const { root, container } = makeRoot();
    await renderSettled(
      root,
      <Transcript
        state={state ?? transcriptState(blocks)}
        onLoadOlder={() => Promise.resolve(false)}
        onResolveApproval={() => noopActions()}
        onAnswerQuestion={() => noopActions()}
        onDismissQuestion={() => noopActions()}
        forest={forest}
        onOpenAgent={(agentId) => { opened.push(agentId); }}
      />,
    );
    return container;
  }

  it('keeps consecutive lifecycle rows inline and individually clickable', async () => {
    const opened: string[] = [];
    const container = await renderWithAgents(
      [eventBlock('agent-1', 'sent'), eventBlock('agent-1', 'completed')],
      opened,
    );
    // Settled events are NOT folded behind a counter: both stay on screen in
    // order, so the reader never has to open a summary to learn what happened.
    expect(container.querySelector('[data-history-run]')).toBeNull();
    const rows = [...container.querySelectorAll('[data-subagent-event]')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Input sent');
    expect(rows[1]?.textContent).toContain('Completed');
    await act(async () => {
      flushSync(() => { click(rows[0]!.querySelector('button')!); });
    });
    expect(opened).toEqual(['agent-1']);
  });

  it('keeps the subagent turn failure on its card after switching away and reopening cold state', async () => {
    const { root, container } = makeRoot();
    const props = {
      onLoadOlder: () => Promise.resolve(false),
      onResolveApproval: () => noopActions(),
      onAnswerQuestion: () => noopActions(),
      onDismissQuestion: () => noopActions(),
    };
    const block = lifecycleSubagentBlock(CHILD_AGENT_ID, { status: 'running', name: 'Researcher' });
    for (const cold of [false, true]) {
      const child = replayAgentWire(CHILD_AGENT_ID, childFailureWireRecords, cold);
      const forest = sessionAgentForestFromAgentSnapshots(new Map([[CHILD_AGENT_ID, child]]));
      await renderSettled(root, <Transcript key={cold ? 'reopened' : 'live'}
        state={transcriptState([block])} forest={forest} {...props} />);
      const card = container.querySelector(`[data-subagent-id="${CHILD_AGENT_ID}"]`);
      expect(card?.querySelector('[data-agent-turn-outcome="failed"]')?.textContent)
        .toContain('Last turn failed · Connection closed');
      await renderSettled(root, <Transcript key="other-session" state={transcriptState([])} {...props} />);
      expect(container.querySelector('[data-agent-turn-outcome]')).toBeNull();
    }
  });

  it('renders both the earlier failure and later cancellation from a fresh child transcript', async () => {
    const snapshot = replayAgentWire(CHILD_AGENT_ID, childCancellationWireRecords, true);
    const state = projectAgentTranscriptView(createViewState('session_reopened'), CHILD_AGENT_ID, snapshot);
    const container = await renderWithAgents([...state.blocks], [], undefined, state);
    expect(container.textContent).toContain('Turn failed: Connection closed');
    expect(container.textContent).toContain('Turn cancelled');
    expect(container.querySelector('[data-turn-status]')).toBeNull();
  });

  it('shows only the last failed attempt when an unfinished retry is recovered cold', async () => {
    const snapshot = replayAgentWire(CHILD_AGENT_ID, childRetryWireRecords, true);
    const state = projectAgentTranscriptView(createViewState('session_reopened'), CHILD_AGENT_ID, snapshot);
    const container = await renderWithAgents([...state.blocks], [], undefined, state);
    expect(container.textContent).toContain('Last attempt failed (APIConnectionError, 2/5): Connection closed');
    expect(container.textContent).not.toContain('retry 2/5 in');
    expect(container.querySelector('[data-turn-status]')).toBeNull();
  });

  it('renders one subagent as one line: the card absorbs its lifecycle rows and dispatch call', async () => {
    const dispatch: Block = {
      kind: 'tool',
      id: 'tool-call-agent-1',
      toolCallId: 'call-agent-1',
      name: 'Agent',
      argsText: '',
      args: undefined,
      display: undefined,
      description: undefined,
      status: 'done',
      output: undefined,
      isError: undefined,
      startedAt: undefined,
      durationMs: undefined,
      progressText: undefined,
    };
    const container = await renderWithAgents(
      [
        dispatch,
        lifecycleSubagentBlock('agent-1', { name: 'Researcher', summary: 'Mapped it.' }),
        eventBlock('agent-1', 'spawned'),
        eventBlock('agent-1', 'sent'),
        eventBlock('agent-1', 'completed'),
      ],
      [],
    );
    expect(container.querySelectorAll('[data-subagent-id="agent-1"]')).toHaveLength(1);
    expect(container.querySelector('[data-tool-id="call-agent-1"]')).toBeNull();
    // A delivery carries its own message, so it stays; restated states go.
    const events = [...container.querySelectorAll('[data-subagent-event]')].map((row) => row.getAttribute('data-agent-event'));
    expect(events).toEqual(['sent']);
    const card = container.querySelector('[data-subagent-id="agent-1"]');
    expect(card?.textContent).toContain('Researcher');
    expect(card?.textContent).toContain('Completed');
    expect(card?.textContent).not.toContain('completed ');
  });

  it('opens original cold-replay invocation details without replacing child navigation', async () => {
    const output = 'task_id: task-example\nagent_id: agent-1\nactual_profile: explore\nbinding_advisories: [{"code":"model_not_preferred","requestedValue":"requested","effectiveValue":"effective","futureField":42},{"code":"effort_not_preferred","effectiveValue":"high"}]\n\nStanding directives in effect: historical raw text';
    const prompt = '  Complete prompt\nwith trailing whitespace  ';
    const call: ToolBlock = {
      ...toolDefaults,
      kind: 'tool', id: 'tool-call-agent-1', toolCallId: 'call-agent-1', name: 'AgentRun', argsText: '',
      args: { profile: 'explore', name: 'research', model_alias: 'requested', effort: 'high', background: false, prompt },
      status: 'done', output,
    };
    const opened: string[] = [];
    const container = await renderWithAgents([call, lifecycleSubagentBlock('agent-1')], opened);
    expect(container.querySelector('[data-tool-id="call-agent-1"]')).toBeNull();
    await act(async () => { click(container.querySelector('[data-invocation-toggle="call-agent-1"]')!); });
    const details = container.querySelector('[data-invocation-tool="call-agent-1"]')!;
    expect(details.textContent).toContain('"background": false');
    expect(details.textContent).toContain('task_id: task-example');
    expect(details.querySelectorAll('[data-binding-advisories] pre')).toHaveLength(2);
    expect(details.textContent).toContain('"futureField": 42');
    expect(details.querySelector('[data-invocation-output]')?.textContent).toBe(output);
    // The prompt is the input this invocation exists to show, so one expand
    // puts it on screen verbatim; the advisory list is a separate child object
    // and keeps its own grouping.
    expect(details.querySelector('[data-invocation-text="prompt"] pre')?.textContent).toBe(prompt);
    expect(details.querySelector('details')).toBeNull();
    expect(details.querySelector('[data-binding-advisories] summary')).toBeNull();
    expect(opened).toEqual([]);
    await act(async () => { click(container.querySelector('[data-agent-open="agent-1"]')!); });
    expect(opened).toEqual(['agent-1']);
  });

  it('reads the invocation input body in one expand, with no second collapse', async () => {
    // The one reading purpose of this region is the input that produced the
    // call. An outer expand that leaves the message behind its own summary
    // made the reader press twice for one thing, so the text itself is the
    // body's first content — the well and the target parameters beside it.
    const message = 'M'.repeat(229);
    const send: ToolBlock = { ...toolDefaults, kind: 'tool', id: 'tool-send', toolCallId: 'send', name: 'AgentSend', argsText: '', args: { target: 'agent-1', message }, status: 'done', output: '{"status":"queued"}' };
    const sent: Block = { ...eventBlock('agent-1', 'sent'), kind: 'subagent-event', anchorToolCallId: 'send' } as Block;
    const container = await renderWithAgents([send, sent], []);
    // Closed: nothing of the body is on screen at all.
    expect(container.querySelector('[data-invocation-tool]')).toBeNull();
    await act(async () => { click(container.querySelector('[data-invocation-toggle="send"]')!); });
    const body = container.querySelector('[data-invocation-tool="send"]')!;
    // No inner disclosure stands between the expand and the text.
    expect(body.querySelector('details')).toBeNull();
    expect(body.querySelector('summary')).toBeNull();
    const wells = [...body.querySelectorAll('pre')].map((well) => well.textContent);
    expect(wells).toContain(message);
    // The other arguments stay readable in the same body, not behind a toggle.
    expect(wells.join('\n')).toContain('"target": "agent-1"');
    // One press, whole body: nothing about the text is left to a second click.
    expect(body.textContent).not.toContain('229');
    expect(body.textContent).not.toMatch(/Show (message|prompt)/);
    // Closing and reopening reads the same way.
    await act(async () => { click(container.querySelector('[data-invocation-toggle="send"]')!); });
    expect(container.querySelector('[data-invocation-tool]')).toBeNull();
    await act(async () => { click(container.querySelector('[data-invocation-toggle="send"]')!); });
    expect([...container.querySelectorAll('[data-invocation-tool="send"] pre')].map((well) => well.textContent)).toContain(message);
  });

  it('labels the input body and keeps each field copyable in one expand', async () => {
    const prompt = '  Complete prompt\nwith trailing whitespace  ';
    const call: ToolBlock = {
      ...toolDefaults, kind: 'tool', id: 'tool-call-agent-1', toolCallId: 'call-agent-1', name: 'AgentRun', argsText: '',
      args: { profile: 'explore', name: 'research', prompt }, status: 'done', output: 'task_id: task-example',
    };
    const container = await renderWithAgents([call, lifecycleSubagentBlock('agent-1')], []);
    await act(async () => { click(container.querySelector('[data-invocation-toggle="call-agent-1"]')!); });
    const body = container.querySelector('[data-invocation-tool="call-agent-1"]')!;
    // The body names the field it is: two text fields in one invocation would
    // otherwise be two anonymous wells.
    const field = body.querySelector('[data-invocation-text="prompt"]')!;
    expect(field.querySelector('pre')?.textContent).toBe(prompt);
    // Verbatim copy stays available for both the body and the named field.
    const fieldCopy = field.querySelector('[data-copy-state]');
    expect(fieldCopy?.getAttribute('aria-label')).toBe('Copy Prompt');
    expect(body.querySelector('[data-copy-state]')?.getAttribute('aria-label')).toBe('Copy Input');
  });

  it('matches AgentSend and resume by invocation anchor, not child identity', async () => {
    const send: ToolBlock = { ...toolDefaults, kind: 'tool', id: 'tool-send', toolCallId: 'send', name: 'AgentSend', argsText: '', args: { target: 'agent-1', message: 'Complete message\nsecond line' }, status: 'done', output: '{"message_id":"msg-1","status":"queued","deduplicated":false,"resumed":true,"target":{"task_name":"research","agent_id":"agent-1"}}' };
    const resume: ToolBlock = { ...send, id: 'tool-resume', toolCallId: 'resume', name: 'AgentRun', args: { resume: 'agent-1', prompt: 'Resume prompt', description: 'Continue' }, output: 'task_id: task-resume\nagent_id: agent-1\nactual_profile: explore' };
    const sent: Block = { ...eventBlock('agent-1', 'sent'), kind: 'subagent-event', anchorToolCallId: 'send' } as Block;
    const resumed: Block = { ...eventBlock('agent-1', 'resumed'), kind: 'subagent-event', anchorToolCallId: 'resume' } as Block;
    const container = await renderWithAgents([send, sent, resume, resumed], []);
    for (const id of ['send', 'resume']) await act(async () => { click(container.querySelector(`[data-invocation-toggle="${id}"]`)!); });
    expect(container.querySelector('[data-invocation-tool="send"]')?.textContent).toContain('Complete message\nsecond line');
    expect(container.querySelector('[data-invocation-tool="send"] [data-invocation-output]')?.textContent).toBe(send.output);
    expect(container.querySelector('[data-invocation-tool="resume"]')?.textContent).toContain('task-resume');
    expect(container.querySelector('[data-invocation-tool="resume"]')?.textContent).not.toContain('Complete message');
  });

  it('fetches a missing invocation from older parent pages and does not fabricate input', async () => {
    const { TranscriptDetailProvider } = await import('./transcriptDetail');
    const { controller } = await openLiveTranscript();
    const { root, container } = makeRoot();
    let resolveLookup!: (value: Awaited<ReturnType<SessionController['lookupToolCall']>>) => void;
    const lookup = vi.spyOn(controller, 'lookupToolCall').mockReturnValue(new Promise((resolve) => { resolveLookup = resolve; }));
    const loadOlder = vi.fn(async () => false);
    try {
      await renderSettled(root, <TranscriptDetailProvider controller={controller} load={async () => false} loads={{}} sessionId="session_test" agentId="main"><Transcript state={{ ...transcriptState([lifecycleSubagentBlock('agent-1')]), hasMoreHistory: true }} onLoadOlder={loadOlder} onResolveApproval={noopActions} onAnswerQuestion={noopActions} onDismissQuestion={noopActions} /></TranscriptDetailProvider>);
      await act(async () => { click(container.querySelector('[data-invocation-toggle="call-agent-1"]')!); });
      expect(lookup).toHaveBeenCalledWith('main', 'call-agent-1', expect.any(AbortSignal));
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(loadOlder).not.toHaveBeenCalled();
      expect(container.querySelector('[data-invocation-tool]')).toBeNull();
      await act(async () => { resolveLookup({ status: 'found', turnId: 'older-turn', stepId: 'older-step', frame: { kind: 'tool', frameId: 'older-frame', toolCallId: 'call-agent-1', name: 'AgentRun', input: { prompt: 'Earlier prompt' }, state: 'done', output: 'task_id: old-task' } }); });
      expect(container.querySelector('[data-invocation-tool="call-agent-1"]')?.textContent).toContain('Earlier prompt');
      expect(container.querySelector('[data-invocation-output]')?.textContent).toBe('task_id: old-task');
    } finally {
      lookup.mockRestore();
      controller.close();
    }
  });

  it('keeps a failed dispatch call visible next to its card', () => {
    const failedCall: Block = {
      kind: 'tool', id: 'tool-call-agent-1', toolCallId: 'call-agent-1', name: 'Agent', argsText: '',
      args: undefined, display: undefined, description: undefined, status: 'error', output: 'quota',
      isError: true, startedAt: undefined, durationMs: undefined, progressText: undefined,
    };
    const card = lifecycleSubagentBlock('agent-1');
    expect(mergeSubagentRows([failedCall, card])).toEqual([failedCall, card]);
    const plain = [eventBlock('agent-2', 'completed')];
    expect(mergeSubagentRows(plain)).toBe(plain);
  });

  it('keeps failed and cancelled lifecycle events out of the fold', async () => {
    const container = await renderWithAgents(
      [eventBlock('agent-1', 'sent'), eventBlock('agent-1', 'failed')],
      [],
    );
    // The failed event must stay individually visible; nothing folds.
    expect(container.querySelector('[data-history-run]')).toBeNull();
    const rows = [...container.querySelectorAll('[data-subagent-event]')];
    expect(rows).toHaveLength(2);
    expect(rows[1]?.textContent).toContain('Failed');
  });

  it('collapses a terminal card to compact with summary, duration, and tools', async () => {
    const opened: string[] = [];
    const container = await renderWithAgents(
      [
        lifecycleSubagentBlock('agent-done', {
          name: 'Researcher',
          summary: 'Mapped the whole protocol surface.',
        }),
      ],
      opened,
    );
    const card = container.querySelector('[data-subagent-id="agent-done"]');
    expect(card?.getAttribute('data-card-form')).toBe('compact');
    expect(card?.textContent).toContain('Mapped the whole protocol surface.');
    expect(card?.textContent).toContain('1m 30s');
    expect(card?.textContent).toContain('3 tool');
    // The compact row jumps; the full body (description line) stays folded.
    await act(async () => {
      flushSync(() => { click(card!.querySelector('[data-agent-open]')!); });
    });
    expect(opened).toEqual(['agent-done']);
  });

  it('keeps an active run full and lets the user collapse it by hand', async () => {
    const container = await renderWithAgents(
      [
        lifecycleSubagentBlock('agent-live', {
          status: 'running',
          endedAt: undefined,
          summary: undefined,
        }),
      ],
      [],
    );
    const card = () => container.querySelector('[data-subagent-id="agent-live"]');
    expect(card()?.getAttribute('data-card-form')).toBe('full');
    // The card-form control leads the card (its own diagonal-arrows mark);
    // the invocation-details chevron trails — never two chevrons side by side.
    const collapseButton = card()!.querySelector('[data-card-collapse]')!;
    const openButton = card()!.querySelector('[data-agent-open]')!;
    const detailsButton = card()!.querySelector('[data-invocation-toggle]')!;
    expect(collapseButton.querySelector('[data-icon="collapse"]')).not.toBeNull();
    expect(detailsButton.querySelector('[data-icon="chevron"]')).not.toBeNull();
    const headerOrder = [...card()!.querySelectorAll('[data-card-collapse], [data-agent-open], [data-invocation-toggle]')];
    expect(headerOrder).toEqual([collapseButton, openButton, detailsButton]);
    await act(async () => {
      flushSync(() => { click(collapseButton); });
    });
    expect(card()?.getAttribute('data-card-form')).toBe('compact');
    // Manual override wins over the auto rule: still compact after republish.
    await act(async () => {
      flushSync(() => { click(card()!.querySelector('[data-card-expand]')!); });
    });
    expect(card()?.getAttribute('data-card-form')).toBe('full');
  });

  it('lets the user expand a terminal card and keeps it expanded', async () => {
    const container = await renderWithAgents(
      [lifecycleSubagentBlock('agent-done', { description: 'the task brief' })],
      [],
    );
    const card = () => container.querySelector('[data-subagent-id="agent-done"]');
    expect(card()?.getAttribute('data-card-form')).toBe('compact');
    // Same reading order as the full card: the form control (expand mark)
    // comes before the invocation-details toggle.
    const expandButton = card()!.querySelector('[data-card-expand]')!;
    const detailsButton = card()!.querySelector('[data-invocation-toggle]')!;
    expect(expandButton.querySelector('[data-icon="expand"]')).not.toBeNull();
    expect(detailsButton.querySelector('[data-icon="chevron"]')).not.toBeNull();
    const asideOrder = [...card()!.querySelectorAll('[data-card-expand], [data-invocation-toggle]')];
    expect(asideOrder).toEqual([expandButton, detailsButton]);
    await act(async () => {
      flushSync(() => { click(expandButton); });
    });
    expect(card()?.getAttribute('data-card-form')).toBe('full');
    expect(card()?.textContent).toContain('the task brief');
  });

  it('carries invocation details as an icon alone, with the name in its tooltip', async () => {
    const container = await renderWithAgents(
      [lifecycleSubagentBlock('agent-done', { description: 'the task brief' })],
      [],
    );
    const card = () => container.querySelector('[data-subagent-id="agent-done"]');
    const details = () => card()!.querySelector('[data-invocation-toggle]')!;
    // No word beside the glyph: the compact card's right edge is a row of
    // controls, and a pill reading "Invocation Details" read as a second label.
    expect(details().textContent).toBe('');
    expect(details().getAttribute('title')).toBe('Expand invocation details');
    expect(details().getAttribute('aria-label')).toBe('Expand invocation details');
    expect(details().getAttribute('aria-expanded')).toBe('false');
    // The name still reaches assistive tech and the expanded region.
    expect(card()!.textContent).not.toContain('Invocation Details');
    await act(async () => {
      flushSync(() => { click(details()); });
    });
    expect(details().getAttribute('aria-expanded')).toBe('true');
    expect(details().getAttribute('title')).toBe('Collapse invocation details');
    expect(details().getAttribute('aria-label')).toBe('Collapse invocation details');
    expect(details().querySelector('[data-icon="chevron"]')?.getAttribute('class')).toContain('rotate-90');
    // The region it opens is named for screen readers, so the visible text can
    // go without the name going with it.
    const region = card()!.querySelector('[role="region"]');
    expect(region?.getAttribute('aria-label')).toBe('Invocation Details');
    await act(async () => {
      flushSync(() => { click(details()); });
    });
    expect(details().getAttribute('aria-expanded')).toBe('false');
    expect(card()!.querySelector('[role="region"]')).toBeNull();
  });

  it('auto form: only running/background go full; suspended, completed and unknown stay compact', () => {
    expect(subagentAutoForm('running')).toBe('full');
    expect(subagentAutoForm('background')).toBe('full');
    expect(subagentAutoForm('suspended')).toBe('compact');
    expect(subagentAutoForm('completed')).toBe('compact');
    expect(subagentAutoForm('failed')).toBe('compact');
    expect(subagentAutoForm('cancelled')).toBe('compact');
    expect(subagentAutoForm('unknown')).toBe('compact');
  });

  describe('nested subagents that finished before the view opened', () => {
    const tree = (grandStatus: Record<string, 'completed' | 'running' | 'suspended' | 'failed'>) => buildAgentForest(
      [],
      [
        { agentId: 'main', name: 'Main' },
        { agentId: 'lead', parentAgentId: 'main', name: 'Lead', status: 'running', toolCallCount: 1 },
        ...Object.entries(grandStatus).map(([agentId, status]) => ({
          agentId, parentAgentId: 'lead', name: agentId, status, toolCallCount: 2, summary: `${agentId} result. More detail.`,
          startedAt: '2026-01-01T00:00:00.000Z', endedAt: status === 'completed' || status === 'failed' ? '2026-01-01T00:02:00.000Z' : undefined,
        })),
      ],
    );
    const leadBlock = lifecycleSubagentBlock('lead', { status: 'running', name: 'Lead' });
    const card = (container: Element, id: string) => container.querySelector(`[data-subagent-id="${id}"]`);

    it('folds a nested agent that had already finished to one summary line', async () => {
      const container = await renderWithAgents([leadBlock], [], tree({ done: 'completed' }));
      const row = card(container, 'done')!;
      expect(row.getAttribute('data-card-form')).toBe('compact');
      expect(row.getAttribute('data-nested-folded')).toBe('true');
      expect(row.textContent).toContain('done result.');
      expect(row.textContent).not.toContain('More detail');
      expect(card(container, 'lead')?.getAttribute('data-card-form')).toBe('full');
    });

    it('never folds a nested agent that is running, waiting on you or failed', async () => {
      const container = await renderWithAgents([leadBlock], [], tree({ live: 'running', asks: 'suspended', broke: 'failed' }));
      for (const id of ['live', 'asks', 'broke']) {
        expect(card(container, id)?.getAttribute('data-card-form')).toBe('full');
        expect(card(container, id)?.hasAttribute('data-nested-folded')).toBe(false);
      }
    });

    it('keeps a nested agent that finishes while the view is open expanded', async () => {
      const { root, container } = makeRoot();
      const render = (status: 'running' | 'completed') => renderSettled(
        root,
        <Transcript
          state={transcriptState([leadBlock])}
          onLoadOlder={() => Promise.resolve(false)}
          onResolveApproval={() => noopActions()}
          onAnswerQuestion={() => noopActions()}
          onDismissQuestion={() => noopActions()}
          forest={tree({ worker: status })}
          onOpenAgent={() => {}}
        />,
      );
      await render('running');
      expect(card(container, 'worker')?.getAttribute('data-card-form')).toBe('full');
      await render('completed');
      expect(card(container, 'worker')?.getAttribute('data-card-form')).toBe('full');
    });

    it('tracks running agents even before their collapsed parent mounts them', async () => {
      const { root, container } = makeRoot();
      const render = (status: 'running' | 'completed') => renderSettled(root, <Transcript state={transcriptState([lifecycleSubagentBlock('lead', { name: 'Lead' })])} forest={buildAgentForest([], [{ agentId: 'main' }, { agentId: 'lead', parentAgentId: 'main', status: 'completed' }, { agentId: 'worker', parentAgentId: 'lead', status }])} onLoadOlder={() => Promise.resolve(false)} onResolveApproval={noopActions} onAnswerQuestion={noopActions} onDismissQuestion={noopActions} />);
      await render('running');
      expect(card(container, 'worker')).toBeNull();
      await render('completed');
      await act(async () => { click(container.querySelector('[data-card-expand="lead"]')!); });
      await act(async () => { click([...container.querySelectorAll('button')].find((button) => button.getAttribute('data-subagent-children') === 'lead')!); });
      expect(card(container, 'worker')?.getAttribute('data-card-form')).toBe('full');
    });

    it('folds direct children in a child timeline only after leaving and returning', async () => {
      const { root, container } = makeRoot();
      const render = (status: 'running' | 'completed', visible = true) => renderSettled(root, <Transcript agentId="lead" visible={visible} state={transcriptState([lifecycleSubagentBlock('worker', { parentAgentId: 'lead', status, summary: 'Result.' })])} onLoadOlder={() => Promise.resolve(false)} onResolveApproval={noopActions} onAnswerQuestion={noopActions} onDismissQuestion={noopActions} />);
      await render('running');
      await render('completed');
      expect(card(container, 'worker')?.getAttribute('data-card-form')).toBe('full');
      await render('completed', false);
      await render('completed');
      expect(card(container, 'worker')?.getAttribute('data-nested-folded')).toBe('true');
      await act(async () => { click(container.querySelector('[data-card-expand="worker"]')!); });
      expect(card(container, 'worker')?.getAttribute('data-card-form')).toBe('full');
    });

    it('opens a folded nested agent on click and keeps it open', async () => {
      const container = await renderWithAgents([leadBlock], [], tree({ done: 'completed' }));
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-card-expand="done"]')!.click(); });
      expect(card(container, 'done')?.getAttribute('data-card-form')).toBe('full');
    });
  });

  it('renders a suspended card compact and a completed parent does not inflate for a running child', async () => {
    const forest = buildAgentForest(
      [],
      [
        { agentId: 'main', name: 'Main' },
        { agentId: 'agent-parent', parentAgentId: 'main', name: 'Parent', status: 'completed', toolCallCount: 1 },
        { agentId: 'agent-grand', parentAgentId: 'agent-parent', name: 'Grand', status: 'running', toolCallCount: 0 },
      ],
    );
    const container = await renderWithAgents(
      [
        lifecycleSubagentBlock('agent-suspended', { status: 'suspended', name: 'Sleeper' }),
        // A non-compact entry between the cards keeps both individually visible.
        { kind: 'notice', id: 'break', text: 'boundary', tone: 'danger' },
        lifecycleSubagentBlock('agent-parent', { name: 'Parent' }),
      ],
      [],
      forest,
    );
    // Neither suspension nor an active grandchild inflates a card.
    const cards = [...container.querySelectorAll('[data-card-form]')];
    const byId = new Map(cards.map((card) => [card.getAttribute('data-subagent-id'), card]));
    expect(byId.get('agent-suspended')?.getAttribute('data-card-form')).toBe('compact');
    expect(byId.get('agent-parent')?.getAttribute('data-card-form')).toBe('compact');
  });

  it('keeps every settled card visible in order and marks the failed one', async () => {
    const container = await renderWithAgents(
      [
        lifecycleSubagentBlock('agent-a', { name: 'Alpha' }),
        lifecycleSubagentBlock('agent-b', { name: 'Beta' }),
        lifecycleSubagentBlock('agent-c', {
          name: 'Gamma',
          status: 'failed',
          error: 'model request failed',
        }),
      ],
      [],
    );
    // All three stay on the timeline in time order — no counter swallows the
    // two that happened to succeed.
    const visible = [...container.querySelectorAll('[data-card-form]')];
    expect(visible.map((card) => card.getAttribute('data-subagent-id'))).toEqual([
      'agent-a',
      'agent-b',
      'agent-c',
    ]);
    // The failure carries its reason and a danger wash the others do not.
    expect(visible[2]?.textContent).toContain('model request failed');
    expect(visible[2]?.querySelector('button')?.className).toContain('bg-danger');
    expect(visible[0]?.querySelector('button')?.className).not.toContain('bg-danger');
  });

  it('leaves the tool count empty when neither task nor roster ever reported one', async () => {
    const container = await renderWithAgents(
      [
        lifecycleSubagentBlock('agent-live', {
          status: 'running',
          endedAt: undefined,
          toolCallCount: 0,
          toolCallCountKnown: false,
        }),
      ],
      [],
    );
    const card = container.querySelector('[data-subagent-id="agent-live"]');
    expect(card?.getAttribute('data-card-form')).toBe('full');
    expect(card?.textContent).not.toContain('Not reported');
    expect(card?.textContent).not.toContain('0 tool');
  });

  it('shows the authoritative node count instead of a stale larger block snapshot', async () => {
    // The forest node is re-projected on every child update and may revise the
    // tally DOWN; the parent-timeline block keeps its stale snapshot. The node
    // declaration must win.
    const forest = buildAgentForest(
      [],
      [
        { agentId: 'main', name: 'Main' },
        {
          agentId: 'agent-live',
          parentAgentId: 'main',
          name: 'Live',
          status: 'running',
          toolCallCount: 4,
          toolCallCountKnown: true,
          toolCallCountAuthoritative: true,
        },
      ],
    );
    const container = await renderWithAgents(
      [
        lifecycleSubagentBlock('agent-live', {
          status: 'running',
          endedAt: undefined,
          toolCallCount: 17,
          toolCallCountKnown: true,
        }),
      ],
      [],
      forest,
    );
    const card = container.querySelector('[data-subagent-id="agent-live"]');
    expect(card?.textContent).toContain('4 tool');
    expect(card?.textContent).not.toContain('17 tool');
  });

  it('follows the live forest node when a resume outdates the dispatch block', async () => {
    // The block is the frozen snapshot of the previous (failed) run; the
    // forest node carries the fresh resumed run. Model, effort and the
    // terminal error must follow the node, and the stale endedAt must not
    // pin the resumed run at a fake 0ms.
    const forest = buildAgentForest(
      [],
      [
        { agentId: 'main', name: 'Main' },
        {
          agentId: 'agent-live',
          parentAgentId: 'main',
          name: 'Live',
          status: 'running',
          model: 'new-route/k3-256k',
          thinkingEffort: 'high',
          startedAt: new Date(Date.now() - 5_000).toISOString(),
        },
      ],
    );
    const container = await renderWithAgents(
      [
        lifecycleSubagentBlock('agent-live', {
          status: 'failed',
          error: 'stale quota error',
          model: 'old-route/k3',
          thinkingEffort: 'low',
        }),
      ],
      [],
      forest,
    );
    const card = container.querySelector('[data-subagent-id="agent-live"]');
    expect(card?.getAttribute('data-card-form')).toBe('full');
    expect(card?.textContent).toContain('new-route/k3-256k');
    expect(card?.textContent).not.toContain('old-route/k3');
    expect(card?.textContent).not.toContain('stale quota error');
    expect(card?.textContent).toContain('high');
    expect(card?.textContent).not.toContain('1m 30s');
    expect(card?.textContent).not.toContain('0ms');
  });

  it('leaves the tool count empty when the authoritative node withdraws known-ness', async () => {
    const forest = buildAgentForest(
      [],
      [
        { agentId: 'main', name: 'Main' },
        {
          agentId: 'agent-live',
          parentAgentId: 'main',
          name: 'Live',
          status: 'running',
          toolCallCount: 4,
          toolCallCountKnown: false,
          toolCallCountAuthoritative: true,
        },
      ],
    );
    const container = await renderWithAgents(
      [
        lifecycleSubagentBlock('agent-live', {
          status: 'running',
          endedAt: undefined,
          toolCallCount: 17,
          toolCallCountKnown: true,
        }),
      ],
      [],
      forest,
    );
    const card = container.querySelector('[data-subagent-id="agent-live"]');
    expect(card?.textContent).not.toContain('Not reported');
    expect(card?.textContent).not.toContain('17 tool');
  });

  it('resolves the tally with node declarations winning over stale blocks', () => {
    // Authoritative downward revision: node 4/known beats block 17/known.
    expect(
      resolveSubagentToolCalls(
        { toolCallCount: 17, toolCallCountKnown: true },
        { toolCallCount: 4, toolCallCountKnown: true },
      ),
    ).toEqual({ count: 4, known: true });
    // The node may also withdraw known-ness entirely.
    expect(
      resolveSubagentToolCalls(
        { toolCallCount: 17, toolCallCountKnown: true },
        { toolCallCount: 4, toolCallCountKnown: false },
      ),
    ).toEqual({ count: 4, known: false });
    // Without a node declaration the block's own declaration stands.
    expect(
      resolveSubagentToolCalls({ toolCallCount: 7, toolCallCountKnown: true }, undefined),
    ).toEqual({ count: 7, known: true });
    expect(
      resolveSubagentToolCalls(
        { toolCallCount: 7, toolCallCountKnown: true },
        { toolCallCount: 2 },
      ),
    ).toEqual({ count: 7, known: true });
    // Only when nothing declares does the legacy max of raw counts show,
    // treated as trustworthy (legacy blocks predate the known-ness flag).
    expect(
      resolveSubagentToolCalls({ toolCallCount: 17 }, { toolCallCount: 4 }),
    ).toEqual({ count: 17, known: true });
    expect(resolveSubagentToolCalls(undefined, undefined)).toEqual({ count: 0, known: true });
  });

  it('jump-to-spawn finds a settled card directly, with no fold to open first', async () => {
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      const container = await renderWithAgents(
        [
          lifecycleSubagentBlock('agent-jump-a', { name: 'JumpAlpha' }),
          lifecycleSubagentBlock('agent-jump-b', { name: 'JumpBeta' }),
        ],
        [],
      );
      // Both cards are mounted in place, so the jump succeeds on the FIRST
      // pass — the old two-phase expand-then-find round trip is gone.
      expect(container.querySelector('[data-subagent-id="agent-jump-b"]')).not.toBeNull();
      let found = false;
      await act(async () => {
        flushSync(() => {
          found = revealSubagentCard('agent-jump-b');
        });
      });
      expect(found).toBe(true);
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});

describe('background task notification folding (TUI-01)', () => {
  type SnapshotItem = AgentTranscriptSnapshot['items'][number];

  // Real wire shape: a background task's terminal notification arrives as a
  // user-role text frame carrying the task origin (wireAdapter's
  // taskNotificationOp), and projects to a system block with variant 'task'.
  function taskNotificationItem(turnId: string, ordinal: number, text: string): SnapshotItem {
    return {
      kind: 'turn',
      turnId,
      ordinal,
      state: 'completed',
      origin: { kind: 'task', taskId: `task-${turnId}` },
      steps: [
        {
          kind: 'step',
          stepId: `${turnId}.1`,
          turnId,
          ordinal: 1,
          state: 'completed',
          frames: [
            {
              kind: 'text',
              frameId: `f-${turnId}`,
              role: 'user',
              origin: { kind: 'task', taskId: `task-${turnId}` },
              text,
            },
          ],
        },
      ],
    };
  }

  function userPromptItem(turnId: string, ordinal: number, prompt: string): SnapshotItem {
    return {
      kind: 'turn',
      turnId,
      ordinal,
      state: 'completed',
      origin: { kind: 'user' },
      prompt,
      steps: [],
    };
  }

  it('renders question answers once per task and retains different questions with the same title', async () => {
    const item = (id: string, ordinal: number, answer: string, echo: boolean): SnapshotItem => ({
      kind: 'turn', turnId: `t${ordinal}`, ordinal, state: 'completed', origin: { kind: 'task', taskId: id },
      steps: [{
        kind: 'step', stepId: `t${ordinal}.1`, turnId: `t${ordinal}`, ordinal: 1, state: 'completed',
        frames: [
          ...(echo ? [{ kind: 'text', frameId: `task-notified:${id}`, role: 'user', taskId: id, origin: { kind: 'task', taskId: id }, text: 'Background question answered\nThe user answered "Which database?".' } as const] : []),
          { kind: 'text', frameId: `receipt-${id}`, role: 'user', origin: { kind: 'task', taskId: id }, text: `<notification id="task:${id}:completed" category="task" type="task.completed" source_kind="background_task" source_id="${id}">\nTitle: Background question answered\nSeverity: info\nThe user answered "Which database?".\n<answer>\n{"answers":{"Which database?":"${answer}"}}\n</answer>\n</notification>` },
        ],
      }],
    });
    const blocks = agentTranscriptToBlocks({ agent_id: 'main', items: [item('question-1', 1, 'Postgres', true), item('question-2', 2, 'SQLite', false)] });
    expect(blocks.flatMap((block) => block.kind === 'system' && block.variant === 'task' ? [block.taskId] : [])).toEqual(['question-1', 'question-2']);
    const container = await renderTranscript(blocks);
    const rows = [...container.querySelectorAll('[data-system="task"]')];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.textContent).toContain('Background question answered');
      await act(async () => { click(row.querySelector('[data-activity-toggle]')!); });
    }
    expect(rows[0]?.textContent).toContain('<answer>\n{"answers":{"Which database?":"Postgres"}}\n</answer>');
    expect(rows[1]?.textContent).toContain('<answer>\n{"answers":{"Which database?":"SQLite"}}\n</answer>');
  });

  it('counts one completion per execution and keeps resumed receipts independent of the latest roster summary', async () => {
    const card: Block = {
      kind: 'subagent', id: 'subagent-inspector', subagentId: 'inspector', parentAgentId: 'main', parentToolCallId: undefined,
      parentTurnId: 't1', name: 'Inspector', description: undefined, model: 'example-model', thinkingEffort: 'high',
      status: 'completed', summary: 'Latest roster result must not replace past receipts.', error: undefined,
      startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:03:00.000Z', toolCallCount: 0, transcript: [],
    };
    const note = (id: string, taskId: string, body: string): Block => ({
      kind: 'system', id, taskId, variant: 'task', turnId: 't2', createdAt: '2026-01-01T00:03:00.000Z',
      text: `Title: Background agent completed\n${body}`,
    });
    const tasks = ['first', 'second'].map((id, index) => ({
      id, session_id: 'session_test', kind: 'subagent' as const, agent_id: 'inspector', description: 'Inspect', status: 'completed' as const,
      created_at: '2026-01-01T00:00:00.000Z', started_at: '2026-01-01T00:00:00.000Z', completed_at: `2026-01-01T00:0${index + 1}:00.000Z`,
      output_preview: index === 0 ? 'First execution result.' : 'Second execution result.',
    }));
    const openAgent = vi.fn();
    const container = await renderTranscript([
      card, userBlock({ id: 'next-turn', text: 'Continue.', turnId: 't2' }),
      { kind: 'thinking', id: 'thought', text: 'Compare.', streaming: false, turnId: 't2', createdAt: undefined },
      note('system-receipt-first', 'first', 'First execution result.'),
      note('system-agent-frame-task-notified:first', 'first', 'Completed.'),
      note('system-receipt-second', 'second', 'Second execution result.'),
      { ...assistantBlock('reply', 'Reviewed.'), turnId: 't2' },
    ], undefined, { tasks }, { onOpenAgent: openAgent });
    const fold = container.querySelector('[data-history-fold]')!;
    expect(fold.textContent).toContain('2 subagents finished');
    await act(async () => { flushSync(() => { click(fold.querySelector('button')!); }); });
    const endings = [...container.querySelectorAll('[data-subagent-ended]')];
    expect(endings).toHaveLength(2);
    expect(endings[0]?.textContent).toContain('First execution result.');
    expect(endings[1]?.textContent).toContain('Second execution result.');
    expect(endings[0]?.textContent).toContain('1m');
    expect(endings[1]?.textContent).toContain('2m');
    expect(endings.every((row) => !row.textContent?.includes('Latest roster result'))).toBe(true);
    expect(container.querySelectorAll('[data-subagent-ended-dispatch="inspector"]')).toHaveLength(2);
    await act(async () => { click(endings[0]!.querySelector('[data-agent-open]')!); });
    expect(openAgent).toHaveBeenCalledWith('inspector');
    await act(async () => { click(endings[0]!.querySelector('[data-subagent-ended-dispatch]')!); });
    expect(container.querySelector('[data-subagent-id="inspector"]')).not.toBeNull();
  });

  it('keeps every background notification inline, including successes', async () => {
    const blocks = agentTranscriptToBlocks({
      agent_id: 'main',
      items: [
        taskNotificationItem('t-n1', 1, 'Background agent completed\nSearch config completed.'),
        taskNotificationItem('t-n2', 2, 'Background agent completed\nIndex rebuild completed.'),
        userPromptItem('t-u1', 3, 'break the run here'),
        taskNotificationItem('t-n3', 4, 'Background agent completed\nWrap-up completed.'),
      ],
    });
    expect(
      blocks.filter((block) => block.kind === 'system' && block.variant === 'task'),
    ).toHaveLength(3);
    const container = await renderTranscript(blocks);
    // All three notifications are on screen at once; none is behind a counter.
    expect(container.querySelector('[data-history-run]')).toBeNull();
    expect(container.querySelectorAll('[data-system="task"]')).toHaveLength(3);
    expect(container.textContent).toContain('break the run here');
  });

  it('washes a failed or timed-out notification in danger and leaves successes quiet', async () => {
    const blocks = agentTranscriptToBlocks({
      agent_id: 'main',
      items: [
        taskNotificationItem('t-f1', 1, 'Background agent failed\nProvider returned 403.'),
        // Served history carries the stripped-XML shape with header lines.
        taskNotificationItem('t-f2', 2, 'Title: Background agent timed_out\nSeverity: warning\nDeadline exceeded.'),
        taskNotificationItem('t-f3', 3, 'Background agent completed\nDone.'),
      ],
    });
    const container = await renderTranscript(blocks);
    const rows = [...container.querySelectorAll('[data-system="task"]')];
    expect(rows).toHaveLength(3);
    expect(rows[0]?.querySelector('button')?.className).toContain('bg-danger');
    expect(rows[1]?.querySelector('button')?.className).toContain('bg-danger');
    expect(rows[2]?.querySelector('button')?.className).not.toContain('bg-danger');
  });

  it('names each notification by its headline so a settled row is never a bare "Task"', async () => {
    const blocks = agentTranscriptToBlocks({
      agent_id: 'main',
      items: [
        taskNotificationItem('t-h1', 1, 'Title: Background agent timed_out\nSeverity: warning\nDeadline exceeded.'),
        taskNotificationItem('t-h2', 2, 'Background agent completed\nIndex rebuild completed.'),
      ],
    });
    const container = await renderTranscript(blocks);
    const rows = [...container.querySelectorAll('[data-system="task"]')];
    expect(rows[0]?.textContent).toContain('Background agent timed_out');
    expect(rows[0]?.textContent).not.toContain('Title:');
    expect(rows[1]?.textContent).toContain('Background agent completed');
    // The body stays folded until the row is opened.
    expect(rows[1]?.textContent).not.toContain('Index rebuild completed.');
  });
});

describe('terminal pile-up folding (timeline tail)', () => {
  function answeredQuestionBlock(id: string, question: string): Block {
    return {
      kind: 'question',
      id,
      request: {
        question_id: id,
        session_id: 'session_test',
        questions: [{ id: 'choice', question, options: [{ id: 'a', label: 'A' }] }],
        created_at: '2026-01-01T00:00:02.000Z',
      },
      outcome: { kind: 'answered', at: '2026-01-01T00:00:03.000Z' },
    };
  }

  function markerNoticeBlock(id: string): Block {
    return {
      kind: 'notice',
      id: `agent-marker-${id}`,
      text: id,
      tone: 'neutral',
      i18n: { key: 'transcript.marker.goal' },
    };
  }

  function abortedNoticeBlock(promptId: string, turnId?: string): Block {
    return {
      kind: 'notice',
      id: `notice-aborted-${promptId}`,
      text: 'Prompt aborted',
      tone: 'neutral',
      i18n: { key: 'notice.promptAborted' },
      turnId,
    };
  }

  function failedNoticeBlock(promptId: string, turnId?: string): Block {
    return {
      kind: 'notice',
      id: `notice-failed-${promptId}`,
      text: 'Prompt failed',
      tone: 'danger',
      i18n: { key: 'notice.promptFailed' },
      turnId,
    };
  }

  function interruptionNoticeBlock(turnId: string): Block {
    return {
      kind: 'notice',
      id: `agent-marker-${turnId}-interruption`,
      text: 'interruption',
      tone: 'neutral',
      i18n: { key: 'transcript.marker.interruption' },
      turnId,
    };
  }

  const stoppedTail = {
    turnId: 't-latest',
    state: 'cancelled',
    endedAt: '2026-01-01T09:00:00.000Z',
    durationMs: 12_000,
    ttftMs: undefined,
    usage: undefined,
    tokensPerSecond: undefined,
  } as const;

  it('keeps the answered-question + aborted-divider pile readable in place', async () => {
    const container = await renderTranscript([
      userBlock({ id: 'u1', text: 'kick off' }),
      assistantBlock('a1', 'done with the first pass'),
      answeredQuestionBlock('question-q1', 'Continue with the plan?'),
      abortedNoticeBlock('prompt-1'),
      answeredQuestionBlock('question-q2', 'Ship the second part?'),
      abortedNoticeBlock('prompt-2'),
    ]);
    // No fold: both answered questions keep their own line, and both aborted
    // dividers are readable without a click.
    expect(container.querySelector('[data-history-run]')).toBeNull();
    expect(container.querySelectorAll('[data-history-line]')).toHaveLength(2);
    expect(container.textContent).toContain('Continue with the plan?');
    expect(container.textContent).toContain('Ship the second part?');
    expect(container.textContent).toContain('Prompt aborted');
  });

  it('names only a subagent origin on a resolved approval line', async () => {
    const resolved = (id: string, originAgentId: string): Block => ({
      ...(virtualApprovalBlock(id) as Extract<Block, { kind: 'approval' }>),
      originAgentId,
      resolution: { decision: 'approved', resolvedAt: '2026-01-01T00:01:00.000Z' },
    });
    const container = await renderTranscript([
      userBlock({ id: 'u1', text: 'kick off' }),
      resolved('approval-main', 'main'),
      resolved('approval-child', 'agent-writer'),
    ]);
    const lines = [...container.querySelectorAll('[data-history-line]')].map((line) => line.textContent ?? '');
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toContain('main');
    expect(lines[0]).toContain('Bash · Run command');
    expect(lines[1]).toContain('agent-writer · Bash · Run command');
  });

  it('shows every historical failure inline and still renders the latest tail', async () => {
    // Kept inside the virtual window: the point is that the failures are
    // inline, not that they survive being scrolled off screen.
    const before = Array.from({ length: 2 }, (_, index) => markerNoticeBlock(`before-${index}`));
    const after = Array.from({ length: 2 }, (_, index) => markerNoticeBlock(`after-${index}`));
    const container = await renderTranscript(
      [
        userBlock({ id: 'u-pile', text: 'run the old work', turnId: 't-old' }),
        { ...assistantBlock('a-pile', 'old work ended'), turnId: 't-old' },
        ...before,
        failedNoticeBlock('old-1', 't-old-1'),
        failedNoticeBlock('old-2', 't-old-2'),
        failedNoticeBlock('old-3', 't-old-3'),
        abortedNoticeBlock('old-abort', 't-old-4'),
        failedNoticeBlock('old-4', 't-old-5'),
        interruptionNoticeBlock('t-old-6'),
        ...after,
      ],
      undefined,
      { turnTail: stoppedTail },
    );

    // Every one of the four failures is countable ON SCREEN rather than as a
    // number in a summary the reader has to trust and then open.
    expect(container.querySelector('[data-history-run]')).toBeNull();
    expect(container.querySelectorAll('[data-notice-tone="danger"]')).toHaveLength(4);
    expect(container.textContent).toContain('Prompt failed');
    expect(container.textContent).toContain('Prompt aborted');
    expect(container.textContent).toContain('You stopped this turn');
    // The stopped tail still owns the latest outcome line.
    expect(container.querySelector('[data-turn-tail-state="cancelled"]')).not.toBeNull();
  });

  it('keeps the latest-turn failure and interruption marker unfolded beside the failed tail', async () => {
    const currentTail = {
      ...stoppedTail,
      state: 'failed',
      error: 'Provider rejected the request',
    } as const;
    const container = await renderTranscript(
      [
        { ...assistantBlock('a-current', 'latest attempt'), turnId: 't-latest' },
        markerNoticeBlock('historical-neighbour'),
        failedNoticeBlock('latest', 't-latest'),
        abortedNoticeBlock('latest-aborted', 't-latest'),
        interruptionNoticeBlock('t-latest'),
      ],
      undefined,
      { turnTail: currentTail },
    );

    expect(container.querySelector('[data-history-run]')).toBeNull();
    expect(container.querySelectorAll('[data-notice-tone="danger"]')).toHaveLength(1);
    expect(container.textContent).toContain('Prompt failed');
    expect(container.textContent).toContain('Prompt aborted');
    expect(container.textContent).toContain('You stopped this turn');
    expect(container.querySelector('[data-turn-tail-state="failed"]')).not.toBeNull();
  });

  it('keeps a lone aborted divider as a single line', async () => {
    const container = await renderTranscript([
      assistantBlock('a1', 'final answer'),
      abortedNoticeBlock('prompt-1'),
    ]);
    expect(container.querySelector('[data-history-run]')).toBeNull();
    expect(container.textContent).toContain('Prompt aborted');
  });

  it('keeps a pending question in the conversation lane while settled neighbours sit in the activity lane', async () => {
    const container = await renderTranscript([
      assistantBlock('a1', 'working through it'),
      answeredQuestionBlock('question-q1', 'First pick?'),
      abortedNoticeBlock('prompt-1'),
      virtualQuestionBlock('question-pending'),
    ]);
    // The pending question is still the current turn, so it keeps the full
    // card in the conversation lane; the answered one became a settled record.
    const lane = (blockId: string) =>
      container.querySelector(`[data-block-id="${blockId}"]`)?.getAttribute('data-timeline-lane');
    expect(lane('question-pending')).toBe('conversation');
    expect(lane('question-q1')).toBe('activity');
    expect(container.textContent).toContain('Pick one');
    // And the settled record is visible, not folded away.
    expect(container.querySelector('[data-history-line]')).not.toBeNull();
    expect(container.textContent).toContain('First pick?');
  });

  it('projects a cron injection once at its turn anchor without leaking the envelope', async () => {
    const blocks = agentTranscriptToBlocks({
      agent_id: 'main',
      items: [
        {
          kind: 'turn',
          turnId: 't-cron',
          ordinal: 1,
          state: 'completed',
          origin: { kind: 'cron', payload: { kind: 'cron_job', jobId: 'nightly' } },
          prompt: '<cron-fire jobId="nightly">\n<prompt>\nRun the nightly report.\n</prompt>\n</cron-fire>',
          startedAt: '2026-01-01T00:00:05.000Z',
          endedAt: '2026-01-01T00:00:06.000Z',
          steps: [],
        },
        {
          kind: 'marker',
          markerId: 'cron-fired-1',
          marker: 'cron.fired',
          payload: { origin: { kind: 'cron_job', jobId: 'nightly' } },
          at: '2026-01-01T00:00:06.000Z',
        },
      ],
    });
    const cronSystem = blocks.find(
      (block) => block.kind === 'system' && block.variant === 'cron_job',
    );
    expect(cronSystem).toMatchObject({
      kind: 'system',
      text: 'Run the nightly report.',
      createdAt: '2026-01-01T00:00:05.000Z',
      turnId: 't-cron',
    });
    expect(blocks).toHaveLength(1);
    expect(blocks.some((block) => block.kind === 'user')).toBe(false);
    expect(blocks.some((block) => block.id === 'agent-marker-cron-fired-1')).toBe(false);

    const container = await renderTranscript(blocks);
    expect(container.querySelector('[data-history-run]')).toBeNull();
    expect(container.querySelectorAll('[data-system="cron_job"]')).toHaveLength(1);
    expect(container.textContent).toContain('Scheduled job');
    expect(container.textContent).not.toContain('Run the nightly report.');
    expect(container.textContent).not.toContain('cron.fired');
    expect(container.textContent).not.toContain('<cron-fire');
    await act(async () => {
      click(container.querySelector('[data-system="cron_job"] button')!);
    });
    expect(container.textContent).toContain('Run the nightly report.');
    expect(container.textContent).not.toContain('<cron-fire');
  });
});

describe('read-run folding (fold-steps)', () => {
  function stepTool(toolCallId: string, overrides: Partial<Extract<Block, { kind: 'tool' }>> = {}): Block {
    return {
      kind: 'tool',
      id: `tool-${toolCallId}`,
      toolCallId,
      name: 'Read',
      argsText: '',
      args: { file_path: `C:/w/${toolCallId}.ts` },
      display: undefined,
      description: undefined,
      status: 'done',
      output: 'ok',
      isError: undefined,
      startedAt: undefined,
      durationMs: undefined,
      progressText: undefined,
      ...overrides,
    };
  }

  function stepShell(id: string, overrides: Partial<Extract<Block, { kind: 'shell' }>> = {}): Block {
    return {
      kind: 'shell',
      id,
      commandId: id,
      command: 'npm test',
      output: '',
      done: true,
      isError: undefined,
      ...overrides,
    };
  }

  function renderTranscriptInto(root: Root, blocks: Block[]): Promise<void> {
    return renderSettled(
      root,
      <Transcript
        state={transcriptState(blocks)}
        onLoadOlder={() => Promise.resolve(false)}
        onResolveApproval={() => noopActions()}
        onAnswerQuestion={() => noopActions()}
        onDismissQuestion={() => noopActions()}
      />,
    );
  }

  async function withFold<T>(on: boolean, run: () => Promise<T>): Promise<T> {
    writeSettings({ foldSteps: on });
    try {
      return await run();
    } finally {
      writeSettings({ foldSteps: false });
    }
  }

  const reads = () => [
    stepTool('plan', { name: 'Read' }),
    stepTool('notes', { name: 'Read' }),
    stepTool('grep', { name: 'Grep', args: { pattern: 'TODO' } }),
  ];

  it('is off by default: every settled action stays in place in the timeline', async () => {
    const container = await renderTranscript([...reads(), stepShell('shell-1')]);
    expect(container.querySelector('[data-read-run]')).toBeNull();
    expect(container.querySelectorAll('[data-tool-id]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-shell]')).toHaveLength(1);
  });

  it('when on, folds ≥3 pure reads into one line that names every object', async () => {
    await withFold(true, async () => {
      const container = await renderTranscript(reads());
      const run = container.querySelector('[data-read-run]');
      expect(run?.getAttribute('data-read-run')).toBe('3');
      expect(run?.textContent).toContain('read plan.ts, notes.ts');
      expect(run?.textContent).toContain('searched TODO');
      expect(container.querySelectorAll('[data-tool-id]')).toHaveLength(0);
      // Expand: the members hang in original order on the nested spine.
      await act(async () => { click(run!.querySelector('button')!); });
      const order = [...container.querySelectorAll('[data-tool-id]')].map((el) => el.getAttribute('data-tool-id'));
      expect(order).toEqual(['plan', 'notes', 'grep']);
      const nestedShell = container.querySelector('[data-tool-id="plan"] [data-activity-toggle]')!;
      expect(nestedShell.className).toContain('-ml-[17px]');
      expect(nestedShell.className).not.toContain('-ml-[34px]');
    });
  });

  it('when on, never folds edits, shells, or runs shorter than three', async () => {
    await withFold(true, async () => {
      const container = await renderTranscript([
        stepTool('a'),
        stepTool('b'),
        stepTool('edit', { name: 'Edit' }),
        stepTool('c'),
        stepShell('shell-1'),
        stepTool('d'),
      ]);
      expect(container.querySelector('[data-read-run]')).toBeNull();
      expect(container.querySelectorAll('[data-tool-id]')).toHaveLength(5);
    });
  });

  it('applies the toggle instantly', async () => {
    const probe = makeRoot();
    await renderTranscriptInto(probe.root, reads());
    expect(probe.container.querySelector('[data-read-run]')).toBeNull();
    await withFold(true, async () => {
      await act(async () => { writeSettings({ foldSteps: true }); });
      expect(probe.container.querySelector('[data-read-run]')).not.toBeNull();
      await act(async () => { writeSettings({ foldSteps: false }); });
      expect(probe.container.querySelector('[data-read-run]')).toBeNull();
    });
  });

  it('spins while a member runs and auto-expands when one fails', async () => {
    await withFold(true, async () => {
      const probe = makeRoot();
      const [plan, notes] = reads();
      await renderTranscriptInto(probe.root, [plan!, notes!, stepTool('last', { status: 'running' })]);
      let run = probe.container.querySelector('[data-read-run]')!;
      expect(run.querySelector('.spinner')).not.toBeNull();
      await renderTranscriptInto(probe.root, [plan!, notes!, stepTool('last', { status: 'error', isError: true, output: 'boom' })]);
      run = probe.container.querySelector('[data-read-run]')!;
      expect(run.querySelector('.spinner')).toBeNull();
      expect(probe.container.querySelector('[data-tool-id="last"]')).not.toBeNull();
      expect(probe.container.textContent).toContain('boom');
    });
  });
});

describe('settled history folds and the unified locate entry', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const doneTool = (id: string, turnId: string, extra: Partial<Extract<Block, { kind: 'tool' }>> = {}): Block => ({
    kind: 'tool', id, toolCallId: id, name: 'Bash', argsText: '', args: { command: `echo ${id}` }, display: undefined,
    description: undefined, status: 'done', output: 'ok', isError: undefined, durationMs: undefined, progressText: undefined,
    turnId, ...extra,
  });
  const think = (id: string, turnId: string): Block => ({ kind: 'thinking', id, text: 'weighing it', streaming: false, createdAt: at, turnId });
  const turnBlocks = (turn: number, userText: string): Block[] => {
    const turnId = `t${turn}`;
    return [
      { ...userBlock({ id: `u${turn}`, text: userText }), turnId },
      think(`th${turn}`, turnId),
      doneTool(`tool${turn}a`, turnId),
      doneTool(`tool${turn}b`, turnId),
      { ...assistantBlock(`a${turn}`, `answer ${turn}`), turnId },
    ];
  };

  it('N2 consumer measures a short restored row before accepting its estimated landing', async () => {
    act(() => clearNavHistory());
    const location = { key: 'short-row-return', pathname: '/s/session_test', search: '', hash: '' };
    const visit = recordNavigation({ location, scope: { homeId: 'main', scopeId: 'local' }, action: 'PUSH' });
    saveReadingSnapshot(visit.visitId, timelineSnapshotKey('session_test'), { anchor: { key: 'short-35', atEnd: false, offset: 10 }, openFolds: [] });
    const blocks = virtualBlocks(90, 'short');
    for (const block of blocks) blockHeights.set(block.id, 26);
    const probe = makeRoot();
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const scroll = this.closest<HTMLElement>('[data-transcript-scroll]');
      const row = this.closest<HTMLElement>('[data-transcript-virtual-item]');
      const top = row === null ? 0 : virtualItemStart(row) - (scroll?.scrollTop ?? 0);
      return { x: 0, y: top, top, bottom: top + this.offsetHeight, left: 0, right: 760, width: 760, height: this.offsetHeight, toJSON: () => ({}) };
    });
    const router = createMemoryRouter([{ path: '*', element: <I18nProvider>{virtualTranscript(transcriptState(blocks))}</I18nProvider> }], { initialEntries: [location] });
    try {
      await act(async () => { probe.root.render(<RouterProvider router={router} />); });
      await settleReadingFrames();
      const block = probe.container.querySelector<HTMLElement>('[data-block-id="short-35"]')!;
      expect(block).not.toBeNull();
      expect(block.getBoundingClientRect().top).toBeCloseTo(-10, 0);
      expect(probe.container.querySelector('[data-reading-restore-retry]')).toBeNull();
    } finally {
      await act(async () => { probe.root.unmount(); });
      rect.mockRestore();
      for (const block of blocks) blockHeights.delete(block.id);
      act(() => clearNavHistory());
    }
  });

  it.each(['paged', 'unknown'] as const)('N2 consumer retains a failed %s anchor and retries it without landing at end', async (coverage) => {
    act(() => clearNavHistory());
    const location = { key: 'reading-return', pathname: '/s/session_test', search: '', hash: '' };
    const visit = recordNavigation({ location, scope: { homeId: 'main', scopeId: 'local' }, action: 'PUSH' });
    const saved: TimelineReadingSnapshot = { anchor: { key: 'old-1', atEnd: false, offset: 17 }, openFolds: [], cardForms: {} };
    saveReadingSnapshot(visit.visitId, timelineSnapshotKey('session_test'), saved);
    const probe = makeRoot();
    let fails = true;
    let update!: (state: SessionViewState) => void;
    const load = vi.fn(async () => {
      if (fails) throw new Error('offline');
      flushSync(() => update(transcriptState([...virtualBlocks(15, 'old'), ...virtualBlocks(30)], { hasMoreHistory: false })));
      return true;
    });
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const scroll = this.closest<HTMLElement>('[data-transcript-scroll]');
      const row = this.closest<HTMLElement>('[data-transcript-virtual-item]');
      const top = row === null ? 0 : virtualItemStart(row) - (scroll?.scrollTop ?? 0);
      return { x: 0, y: top, top, bottom: top + this.offsetHeight, left: 0, right: 760, width: 760, height: this.offsetHeight, toJSON: () => ({}) };
    });
    function Page() {
      const location = useLocation();
      const action = useNavigationType();
      useLayoutEffect(() => { recordNavigation({ location, scope: { homeId: 'main', scopeId: 'local' }, action }); }, [location, action]);
      const [state, setState] = useState(transcriptState(virtualBlocks(30), { hasMoreHistory: coverage === 'paged', historyCoverageKind: 'unknown' }));
      update = setState;
      return location.pathname === '/away' ? <div>away</div> : virtualTranscript(state, load);
    }
    const router = createMemoryRouter([{ path: '*', element: <I18nProvider><Page /></I18nProvider> }], { initialEntries: [location] });
    await act(async () => { probe.root.render(<RouterProvider router={router} />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); });
    const scroll = probe.container.querySelector<HTMLElement>('[data-transcript-scroll]')!;
    expect(load).toHaveBeenCalledOnce();
    expect(transcriptDistanceFromEnd(scroll)).toBeGreaterThan(80);
    const retry = probe.container.querySelector<HTMLElement>('[data-reading-restore-retry]');
    expect(retry).not.toBeNull();
    await act(async () => { await router.navigate('/away'); });
    expect(getReadingSnapshot(visit.visitId, timelineSnapshotKey('session_test'))).toEqual(saved);
    await act(async () => { await router.navigate(-1); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 160)); });
    expect(load).toHaveBeenCalledTimes(2);
    fails = false;
    await act(async () => { click(probe.container.querySelector('[data-reading-restore-retry]')!); });
    await settleReadingFrames();
    expect(load).toHaveBeenCalledTimes(3);
    expect(probe.container.querySelector('[data-reading-restore-retry]')).toBeNull();
    expect(probe.container.querySelector<HTMLElement>('[data-block-id="old-1"]')!.getBoundingClientRect().top).toBeCloseTo(-17, 0);
    await act(async () => { probe.root.unmount(); });
    rect.mockRestore();
    act(() => clearNavHistory());
  });

  it('N2 consumer returns a raw process block to its measured place inside a settled fold', async () => {
    act(() => clearNavHistory());
    const probe = makeRoot();
    let settled = false;
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const scroll = this.closest<HTMLElement>('[data-transcript-scroll]');
      const row = this.closest<HTMLElement>('[data-transcript-virtual-item]');
      const memberInset = this.dataset['blockId'] === 'th1' && this.closest('[data-history-fold-members]') !== null ? 64 : 0;
      const top = row === null ? 0 : virtualItemStart(row) + memberInset - (scroll?.scrollTop ?? 0);
      return { x: 0, y: top, top, bottom: top + this.offsetHeight, left: 0, right: 760, width: 760, height: this.offsetHeight, toJSON: () => ({}) };
    });
    function Page() {
      const location = useLocation();
      const action = useNavigationType();
      useLayoutEffect(() => { recordNavigation({ location, scope: { homeId: 'main', scopeId: 'local' }, action }); }, [location, action]);
      if (location.pathname === '/away') return <div>away</div>;
      const work = settled ? turnBlocks(1, 'reading') : [userBlock({ id: 'u1', text: 'reading', turnId: 't1' }), doneTool('tool1a', 't1'), think('th1', 't1')];
      return <I18nProvider>{virtualTranscript(transcriptState([...virtualBlocks(30), ...work]))}</I18nProvider>;
    }
    const router = createMemoryRouter([{ path: '*', element: <Page /> }], { initialEntries: ['/s/session_test'] });
    blockHeights.set('th1', 900);
    // The expanded fold contains that same tall block; its outer height must
    // contain the member, rather than allowing jsdom-only scroll overshoot.
    blockHeights.set('fold-th1', 900);
    try {
      await act(async () => { probe.root.render(<RouterProvider router={router} />); });
      await settleVirtualizer();
      const scroll = probe.container.querySelector<HTMLElement>('[data-transcript-scroll]')!;
      const source = probe.container.querySelector<HTMLElement>('[data-block-id="th1"]')!;
      expect(source).not.toBeNull();
      const sourceRow = source.closest<HTMLElement>('[data-transcript-virtual-item]')!;
      await act(async () => { resizeElement(sourceRow, 900); });
      await setTranscriptScroll(scroll, virtualItemStart(sourceRow) + 17);
      await settleVirtualizer();
      expect(transcriptDistanceFromEnd(scroll)).toBeGreaterThan(80);
      const visit = getCurrentVisit()!.visitId;
      await act(async () => { await router.navigate('/away'); });
      expect(getReadingSnapshot<TimelineReadingSnapshot>(visit, timelineSnapshotKey('session_test'))?.anchor).toMatchObject({ key: 'th1', offset: 17, atEnd: false });
      settled = true;
      await act(async () => { await router.navigate(-1); });
      await settleReadingFrames();
      const target = probe.container.querySelector<HTMLElement>('[data-history-fold-members] [data-block-id="th1"]');
      expect(target).not.toBeNull();
      expect(probe.container.querySelector('[data-reading-restore-retry]')).toBeNull();
      expect(target!.getBoundingClientRect().top).toBeCloseTo(-17, 0);
    } finally {
      await act(async () => { probe.root.unmount(); });
      rect.mockRestore(); blockHeights.delete('th1'); blockHeights.delete('fold-th1'); act(() => clearNavHistory());
    }
  });

  it('folds each turn’s work into one line once its answer is in, and expands in place', async () => {
    const container = await renderTranscript([...turnBlocks(1, 'first'), ...turnBlocks(2, 'second')]);
    const folds = container.querySelectorAll('[data-history-fold]');
    // The latest turn folds too: its answer came after the work, so no
    // process row is the newest thing any more.
    expect(folds).toHaveLength(2);
    expect(folds[0]!.textContent).toContain('Worked');
    expect(folds[0]!.textContent).toContain('2 steps');
    expect(folds[0]!.textContent).toContain('1 thought');
    expect(container.querySelector('[data-block-id="tool1a"]')).toBeNull();
    expect(container.querySelector('[data-block-id="tool2a"]')).toBeNull();
    await act(async () => { click(folds[0]!.querySelector('[data-activity-toggle]')!); });
    expect(container.querySelector('[data-history-fold-members] [data-block-id="tool1a"]')).not.toBeNull();
  });

  it('locates a block inside a fold and in older, unloaded history; reports what is missing', async () => {
    resetTimelineLocatorsForTests();
    const { root, container } = makeRoot();
    let state = transcriptState([...turnBlocks(5, 'recent'), ...turnBlocks(6, 'latest')], {
      sessionId: 'session_locate', hasMoreHistory: true,
    });
    const onLoadOlder = vi.fn(async () => {
      state = { ...state, blocks: [...turnBlocks(1, 'oldest'), ...state.blocks], hasMoreHistory: false };
      await renderSettled(root, virtualTranscript(state, onLoadOlder));
      return true;
    });
    await renderSettled(root, virtualTranscript(state, onLoadOlder));
    await settleVirtualizer();

    let outcome: Awaited<ReturnType<typeof locateInTimeline>> | undefined;
    await act(async () => {
      outcome = await locateInTimeline({ kind: 'block', blockId: 'tool5a' }, { sessionId: 'session_locate', notify: false });
    });
    expect(outcome).toEqual({ status: 'found' });
    expect(container.querySelector('[data-history-fold-open] [data-block-id="tool5a"]')).not.toBeNull();
    expect(onLoadOlder).not.toHaveBeenCalled();

    await act(async () => {
      outcome = await locateInTimeline({ kind: 'turn', turnId: normalizeTurnId(1) }, { sessionId: 'session_locate', notify: false });
    });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ status: 'found' });

    await act(async () => {
      outcome = await locateInTimeline({ kind: 'block', blockId: 'gone' }, { sessionId: 'session_locate', notify: false });
    });
    expect(outcome).toEqual({ status: 'not-found' });
  });

  it('re-lands a shown agent tab on its latest message unless the reader scrolled up', async () => {
    resetTimelineLocatorsForTests();
    const { root, container } = makeRoot();
    const many = Array.from({ length: 8 }, (_, index) => turnBlocks(index + 1, `message ${index + 1}`)).flat();
    const state = transcriptState(many, { sessionId: 'session_reveal' });
    const render = (visible: boolean) => renderSettled(root, (
      <Transcript state={state} agentId="agent-x" visible={visible} onLoadOlder={() => Promise.resolve(false)}
        onResolveApproval={() => noopActions()} onAnswerQuestion={() => noopActions()} onDismissQuestion={() => noopActions()} />
    ));
    await render(true);
    await settleVirtualizer();
    const scroll = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;
    let outcome: Awaited<ReturnType<typeof locateInTimeline>> | undefined;

    // A reader who scrolled up keeps their place when the tab is re-opened.
    await setTranscriptScroll(scroll, 0);
    await settleVirtualizer();
    await act(async () => {
      outcome = await locateInTimeline({ kind: 'latest', respectReader: true }, { sessionId: 'session_reveal', agentId: 'agent-x', notify: false });
    });
    expect(outcome).toEqual({ status: 'kept' });
    expect(scroll.scrollTop).toBe(0);

    // A plain reveal (opening at the latest) lands at the end.
    await act(async () => {
      outcome = await locateInTimeline({ kind: 'latest' }, { sessionId: 'session_reveal', agentId: 'agent-x', notify: false });
    });
    expect(outcome).toEqual({ status: 'found' });
    expect(transcriptDistanceFromEnd(scroll)).toBeLessThanOrEqual(80);

    // Hidden then shown: the end anchor survives the hidden box's resets.
    await render(false);
    await setTranscriptScroll(scroll, 0);
    await render(true);
    await settleVirtualizer();
    expect(transcriptDistanceFromEnd(scroll)).toBeLessThanOrEqual(80);
  });

  it('spends the one-time landing only after an agent tab has its own rows', async () => {
    resetTimelineLocatorsForTests();
    const { root, container } = makeRoot();
    const many = Array.from({ length: 8 }, (_, index) => turnBlocks(index + 1, `message ${index + 1}`)).flat();
    const render = (state: SessionViewState) => renderSettled(root, (
      <Transcript state={state} agentId="agent-late" visible onLoadOlder={() => Promise.resolve(false)}
        onResolveApproval={() => noopActions()} onAnswerQuestion={() => noopActions()} onDismissQuestion={() => noopActions()} />
    ));
    await render(transcriptState([], { sessionId: 'session_late', loaded: false }));
    await settleVirtualizer();
    await render(transcriptState(many, { sessionId: 'session_late', loaded: true }));
    await settleVirtualizer();
    const scroll = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight + 200);
    expect(transcriptDistanceFromEnd(scroll)).toBeLessThanOrEqual(80);
  });
});

describe('folding the live turn and what the agent looked at (FOLDING.md)', () => {
  const step = (id: string, turnId = 't1'): Block => ({
    kind: 'tool', id, toolCallId: id, name: 'Bash', argsText: '', args: { command: `echo ${id}` }, display: undefined,
    description: undefined, status: 'done', output: 'ok', isError: undefined, durationMs: undefined, progressText: undefined, turnId,
  });
  const look = (id: string, turnId = 't1'): Block => ({
    kind: 'tool', id, toolCallId: id, name: 'ReadMediaFile', argsText: '', args: { path: `C:/w/${id}.png` }, display: undefined,
    description: undefined, status: 'done', isError: undefined, durationMs: undefined, progressText: undefined, turnId,
    output: [
      { type: 'text', text: `<image path="C:/w/${id}.png">` },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
      { type: 'text', text: '</image>' },
    ],
  });
  const user = { ...userBlock({ id: 'u1', text: 'go' }), turnId: 't1' } as Block;

  it('folds the live turn’s settled work behind one line and keeps its newest row out', async () => {
    const container = await renderTranscript([user, step('s1'), step('s2'), step('s3')], undefined, { busy: true });
    const fold = container.querySelector('[data-history-fold]');
    expect(fold?.textContent).toContain('2 steps');
    expect(container.querySelector('[data-history-fold] [data-block-id="s1"]')).toBeNull();
    // The newest row stays in view until the next one arrives.
    expect(container.querySelector('[data-block-id="s3"]')?.closest('[data-history-fold]')).toBeNull();
  });

  it('marks a fold holding a failure in the outcome column and keeps a clean fold silent', async () => {
    const failed: Block = { ...step('s2'), status: 'error', isError: true } as Block;
    const bad = await renderTranscript([user, step('s1'), failed, step('s3')], undefined, { busy: true });
    expect(bad.querySelector('[data-history-fold] [data-outcome="failed"]')).not.toBeNull();
    const clean = await renderTranscript([user, step('s1'), step('s2'), step('s3')], undefined, { busy: true });
    expect(clean.querySelector('[data-history-fold] [data-outcome]')).toBeNull();
  });

  it('never closes a fold the reader opened when the turn moves on', async () => {
    const { root, container } = makeRoot();
    const render = (blocks: Block[]) => renderSettled(root, virtualTranscript(transcriptState(blocks, { busy: true })));
    await render([user, step('s1'), step('s2'), step('s3')]);
    const toggle = container.querySelector<HTMLElement>('[data-history-fold] [data-activity-toggle]')!;
    await act(async () => { click(toggle); });
    expect(container.querySelector('[data-history-fold-open] [data-block-id="s2"]')).not.toBeNull();
    // s3 joins the same fold (its id is s1's); the fold stays open.
    await render([user, step('s1'), step('s2'), step('s3'), step('s4')]);
    expect(container.querySelector('[data-history-fold-open] [data-block-id="s3"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-history-fold]')).toHaveLength(1);
  });

  it('shows what the agent looked at as its own row: a preview while latest, a strip once history', async () => {
    const { root, container } = makeRoot();
    const render = (blocks: Block[]) => renderSettled(root, virtualTranscript(transcriptState(blocks, { busy: true })));
    await render([user, step('s1'), step('s2'), look('m1'), look('m2')]);
    const latest = container.querySelector('[data-media-run]');
    expect(latest?.getAttribute('data-media-run')).toBe('2');
    expect(latest?.hasAttribute('data-media-run-latest')).toBe(true);
    expect(latest?.textContent).toContain('Viewed images');
    await act(async () => { latest?.querySelectorAll<HTMLButtonElement>('[data-media-thumb] button').forEach((button) => button.click()); });
    expect(latest?.querySelectorAll('[data-media-thumb] img')).toHaveLength(2);
    expect(latest?.querySelector('img')?.className).toContain('h-[120px]');
    // Never inside a fold: the fold before it stops there.
    expect(latest?.closest('[data-history-fold]')).toBeNull();
    await render([user, step('s1'), step('s2'), look('m1'), look('m2'), step('s3'), step('s4')]);
    const settled = container.querySelector('[data-media-run]');
    expect(settled?.hasAttribute('data-media-run-latest')).toBe(false);
    expect(settled?.querySelector('img')?.className).toContain('h-9');
    expect(container.querySelectorAll('[data-history-fold]')).toHaveLength(1);
  });
});

describe('semantic tool cards', () => {
  const THREAD_REF = { host_id: 'local', workspace_id: 'ws_example', session_id: 'session_peer' };

  function semanticTool(
    name: string,
    args: unknown,
    output: unknown,
    overrides: Partial<Extract<Block, { kind: 'tool' }>> = {},
  ): Extract<Block, { kind: 'tool' }> {
    return {
      kind: 'tool',
      id: `tool-${name}`,
      toolCallId: `call-${name}`,
      name,
      argsText: JSON.stringify(args),
      args,
      display: undefined,
      description: undefined,
      status: 'done',
      output,
      isError: false,
      durationMs: undefined,
      progressText: undefined,
      ...overrides,
    };
  }

  /** Renders one card inside a router whose location the test can read. */
  async function renderCard(
    block: Extract<Block, { kind: 'tool' }>,
    options: { sessionId?: string; onOpenAgent?: (agentId: string) => void } = {},
  ): Promise<{ container: HTMLDivElement; path: () => string }> {
    const { root, container } = makeRoot();
    let location = '';
    function Probe() {
      const current = useLocation();
      location = `${current.pathname}${current.search}`;
      return null;
    }
    await act(async () => {
      flushSync(() => {
        root.render(
          <MemoryRouter initialEntries={['/s/session_here']}>
            <I18nProvider>
              <MediaPreviewProvider sessionId={options.sessionId ?? 'session_here'}>
                <ToolCard block={block} onOpenAgent={options.onOpenAgent} />
              </MediaPreviewProvider>
            </I18nProvider>
            <Probe />
          </MemoryRouter>,
        );
      });
    });
    return { container, path: () => location };
  }

  async function expand(container: HTMLElement): Promise<void> {
    await act(async () => { click(container.querySelector('[data-activity-toggle]')!); });
  }

  async function openRaw(container: HTMLElement): Promise<void> {
    await act(async () => { click(container.querySelector('[data-tool-raw-toggle]')!); });
  }

  it('says who a thread message went to, whether it landed, and jumps to that thread', async () => {
    const content = `Please rebase onto main and rerun the integration suite. ${'context '.repeat(20)}`;
    const { container, path } = await renderCard(semanticTool(
      'ThreadSend',
      { thread: THREAD_REF, content, idempotency_key: 'send-1' },
      JSON.stringify({ messageId: 'msg_1', targetSeq: 4, acceptedAt: 1_767_225_600_000, deduplicated: false, delivery: 'pending' }, null, 2),
    ));
    const row = container.querySelector('[data-tool-semantic="ThreadSend"]')!;
    expect(row.querySelector('[data-activity-toggle]')?.textContent).toContain('Send to');
    expect(row.textContent).toContain('session_peer');
    expect(row.querySelector('[data-tool-semantic-detail]')?.textContent).toMatch(/Please rebase onto main.*…$/);
    expect(row.querySelector('[data-tool-state]')?.textContent).toBe('Pending delivery');
    expect(row.textContent).not.toContain('"idempotency_key"');
    await expand(container);
    const threadField = [...container.querySelectorAll('[data-tool-semantic-fields] dd')][0]!;
    expect(threadField.getAttribute('title')).toBe('session_peer');
    await act(async () => { click(row.querySelector('[data-tool-jump="session"]')!); });
    expect(path()).toBe('/s/session_peer');
  });

  it('names a new thread by its title and marks an undeliverable send as a failure word', async () => {
    const created = await renderCard(semanticTool(
      'ThreadCreate',
      { title: 'Release notes draft', prompt: 'Draft the notes for 0.3' },
      JSON.stringify({ id: 'session_new', title: 'Release notes draft', cwd: 'C:/work/app', profile: 'agent', prompt_started: true, message: 'Thread created in the session list.' }, null, 2),
    ));
    expect(created.container.textContent).toContain('New thread');
    expect(created.container.textContent).toContain('Release notes draft');
    await act(async () => { click(created.container.querySelector('[data-tool-jump="session"]')!); });
    expect(created.path()).toBe('/s/session_new');
    const failed = await renderCard(semanticTool(
      'ThreadSend',
      { thread: THREAD_REF, content: 'ping', idempotency_key: 'k' },
      JSON.stringify({ messageId: 'm', targetSeq: 1, acceptedAt: 1, deduplicated: false, delivery: 'undeliverable' }),
    ));
    const state = failed.container.querySelector('[data-tool-state]');
    expect(state?.textContent).toBe('Not delivered');
    expect(state?.className).toContain('text-danger');
  });

  it('shows what a thread wait returned, per thread, with the turn to open', async () => {
    const { container, path } = await renderCard(semanticTool(
      'ThreadWait',
      { threads: [{ thread: THREAD_REF }], timeout_ms: 30_000 },
      JSON.stringify({
        threads: [{
          thread: { hostId: 'local', workspaceId: 'ws_example', sessionId: 'session_peer' },
          cursor: 'c2',
          activities: [{ ref: { hostId: 'local', workspaceId: 'ws_example', sessionId: 'session_peer' }, seq: 7, kind: 'terminal', at: 1, reason: 'completed', turnId: 3 }],
        }],
        timedOut: false,
      }),
    ));
    expect(container.textContent).toContain('Wait on');
    expect(container.querySelector('[data-tool-state]')?.textContent).toBe('1 update');
    await expand(container);
    const item = container.querySelector('[data-tool-semantic-items] [data-tool-semantic-link="session"]')!;
    expect(item.textContent).toContain('turn ended · Completed');
    await act(async () => { click(item); });
    expect(path()).toBe('/s/session_peer?turn=3');
  });

  it('reads an AgentRun result as the agent, its profile and outcome, with a way to open it', async () => {
    const opened: string[] = [];
    const { container } = await renderCard(semanticTool(
      'AgentRun',
      { prompt: 'Map the auth flow', description: 'Map auth flow', profile: 'explore' },
      'agent_id: agent-7\nactual_profile: explore\nparent_notify: enabled\nstatus: completed\n\n[summary]\nThe auth flow starts in login.ts.',
    ), { onOpenAgent: (id) => { opened.push(id); } });
    expect(container.textContent).toContain('Run agent');
    expect(container.textContent).toContain('Map auth flow');
    expect(container.textContent).toContain('explore');
    expect(container.querySelector('[data-tool-state]')?.textContent).toBe('Completed');
    await act(async () => { click(container.querySelector('[data-tool-jump="agent"]')!); });
    expect(opened).toEqual(['agent-7']);
    await expand(container);
    expect(container.querySelector('[data-tool-semantic-preview]')?.textContent).toContain('The auth flow starts in login.ts.');
  });

  it('gives a task its id, status and a clipped output preview, with the raw text one disclosure away', async () => {
    const output = [
      'retrieval_status: success',
      'task_id: bash-k3',
      'kind: process',
      'description: pnpm test',
      'status: failed',
      'exit_code: 1',
      'output_size_bytes: 2048',
      '',
      '[output]',
      ...Array.from({ length: 30 }, (_, index) => `line ${String(index + 1)}`),
    ].join('\n');
    const { container } = await renderCard(semanticTool('TaskOutput', { task_id: 'bash-k3' }, output));
    expect(container.textContent).toContain('Task output');
    expect(container.textContent).toContain('pnpm test');
    const state = container.querySelector('[data-tool-state]');
    expect(state?.textContent).toBe('Failed');
    expect(state?.className).toContain('text-danger');
    await expand(container);
    const fields = container.querySelector('[data-tool-semantic-fields]')!;
    expect(fields.textContent).toContain('bash-k3');
    expect(fields.textContent).toContain('Exit code');
    const preview = container.querySelector('[data-tool-semantic-preview]')!.textContent!;
    expect(preview).toContain('line 1');
    expect(preview).not.toContain('line 30');
    expect(container.querySelector('[data-tool-raw]')).toBeNull();
    await openRaw(container);
    expect(container.querySelector('[data-tool-raw]')?.textContent).toContain('line 30');
  });

  it('counts a TaskWait timeout as the wait running out, not the task', async () => {
    const { container } = await renderCard(semanticTool(
      'TaskWait',
      { timeout: 30, task_id: 'agent-x1' },
      'wait_status: timed_out\ntask_id: agent-x1\nwaited_ms: 30004\ntimeout_ms: 30000\nThe wait timed out, not the task. The task is still running.',
    ));
    expect(container.textContent).toContain('Wait for task');
    expect(container.textContent).toContain('agent-x1');
    expect(container.querySelector('[data-tool-state]')?.textContent).toBe('Timed out');
  });

  it('shows a history search as its query and hit count, and jumps back to a hit turn in this session', async () => {
    resetTimelineLocatorsForTests();
    const targets: unknown[] = [];
    const unregister = registerTimelineLocator('session_here', 'main', {
      isVisible: () => true,
      locate: (target) => { targets.push(target); return Promise.resolve({ status: 'found' as const }); },
    });
    const { container } = await renderCard(semanticTool(
      'HistorySearch',
      { query: 'rate limit', scope: 'session' },
      JSON.stringify({
        schema_version: 2,
        status: 'ok',
        target: { workspace_id: 'ws_example', session_id: 'session_here', agent_id: 'main' },
        scope_used: 'session',
        mode_used: 'auto',
        hits: [
          { session_id: 'session_here', agent_id: 'main', role: 'assistant', turn: 12, step_id: 't12.1', ref: 'r1', time: '2026-01-01T00:00:00.000Z', snippet: 'We hit the provider rate limit at 40 rpm.', matched: ['rate limit'] },
          { session_id: 'session_here', agent_id: 'main', role: 'user', turn: 4, step_id: null, ref: 'r2', time: '2026-01-01T00:00:00.000Z', snippet: 'Why is there a rate limit?', matched: ['rate limit'] },
        ],
        next_cursor: null,
        has_more: false,
      }),
    ));
    expect(container.textContent).toContain('Search history');
    expect(container.textContent).toContain('rate limit');
    expect(container.querySelector('[data-tool-count]')?.textContent).toBe('2 hits');
    await expand(container);
    const hits = container.querySelectorAll('[data-tool-semantic-items] [data-tool-semantic-link="session"]');
    expect(hits).toHaveLength(2);
    expect(hits[0]!.textContent).toContain('Turn 12');
    await act(async () => { click(hits[0]!); });
    expect(targets).toEqual([{ kind: 'turn', turnId: 't12' }]);
    unregister();
  });

  it('names the board card a write touched and links to the board', async () => {
    const { container, path } = await renderCard(semanticTool(
      'BoardWrite',
      { action: 'create', requestKey: 'rk-1', title: 'Ship thread cards', priority: 'P1' },
      JSON.stringify({ ok: true, value: {
        id: 'card_1', workspaceId: 'ws_example', storage: { root: 'C:/work', storageId: 's1', kind: 'workspace' },
        title: 'Ship thread cards', priority: 'P1', status: 'active', revision: 1, createdAt: 'x', updatedAt: 'x',
        completedAt: null, archived: false, category: 'gui', sessionIds: [], executionIds: [], description: '', prd: '',
      } }),
    ));
    expect(container.textContent).toContain('New card');
    expect(container.textContent).toContain('Ship thread cards');
    await expand(container);
    expect(container.querySelector('[data-tool-semantic-fields]')?.textContent).toContain('Workspace');
    await act(async () => { click(container.querySelector('[data-tool-jump="route"]')!); });
    expect(path()).toBe('/board');
  });

  it('folds SelectTools into one line naming the tools it loaded', async () => {
    const { container } = await renderCard(semanticTool(
      'SelectTools',
      { names: ['HistoryRead', 'HistorySearch'] },
      'Loaded: HistoryRead, HistorySearch',
    ));
    const row = container.querySelector('[data-tool-semantic="SelectTools"]')!;
    expect(row.querySelector('[data-activity-toggle]')?.textContent).toContain('Load toolsHistoryRead, HistorySearch');
    expect(row.textContent).not.toContain('"names"');
  });

  it('renders a CallTool bridge as the tool it calls, with that tool’s card', async () => {
    const { container } = await renderCard(semanticTool(
      'CallTool',
      { name: 'HistoryList', arguments: { kind: 'turns', limit: 2 } },
      JSON.stringify({ schema_version: 2, status: 'ok', kind: 'turns', turns: [
        { ref: 'r1', turn: 1, started_at: 'x', prompt_excerpt: 'Set up CI', answer_excerpt: 'Done', step_count: 3, tool_count: 5 },
        { ref: 'r2', turn: 2, started_at: 'x', prompt_excerpt: 'Fix lint', answer_excerpt: 'Fixed', step_count: 1, tool_count: 1 },
      ], has_more: false }),
    ));
    const row = container.querySelector('[data-tool-semantic="HistoryList"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).not.toContain('CallTool');
    expect(row?.textContent).toContain('List turns');
    expect(container.querySelector('[data-tool-count]')?.textContent).toBe('2 turns');
  });

  it('shows a room send as a room, reads its delivery honestly, and links the room', async () => {
    const { container, path } = await renderCard(semanticTool(
      'ThreadSend',
      { room: 'release-contract', content: 'status?', mentions: ['session_peer'] },
      JSON.stringify({ roomId: 'release-contract', messageId: 'msg_room', delivery: 'delivered' }),
    ));
    const row = container.querySelector('[data-tool-semantic="ThreadSend"]')!;
    expect(row.textContent).toContain('Post to room');
    expect(row.textContent).not.toContain('Send to');
    // A room send is never drawn as a peer thread.
    expect(row.textContent).not.toContain('session_peer');
    expect(row.querySelector('[data-tool-state]')?.textContent).toContain('Logged');
    await expand(container);
    // The receipt proves the line was recorded, not that anyone was woken.
    expect(container.querySelector('[data-tool-semantic-fields]')?.textContent).toContain('Asked');
    await act(async () => { click(row.querySelector('[data-tool-jump="route"]')!); });
    expect(path()).toBe('/rooms/release-contract');
  });

  it('expands a room send to its whole body without a second expand inside it', async () => {
    const content = Array.from({ length: 60 }, (_, index) => `line ${index}: the full room message body`).join('\n');
    const { container } = await renderCard(semanticTool(
      'ThreadSend',
      { room: 'release-contract', content },
      JSON.stringify({ roomId: 'release-contract', messageId: 'msg_room', delivery: 'delivered' }),
    ));
    await expand(container);
    const preview = container.querySelector('[data-tool-semantic-preview]')!;
    expect(preview.textContent).toContain('line 0: the full room message body');
    // The complete body is one click away; it never nests a second expander.
    const full = container.querySelector<HTMLButtonElement>('[data-tool-preview-full]')!;
    expect(full).not.toBeNull();
    expect(container.querySelectorAll('[data-tool-semantic-preview]')).toHaveLength(1);
    await act(async () => { click(full); });
    expect(container.querySelector('[data-tool-semantic-preview]')?.textContent).toContain('line 59: the full room message body');
    expect(container.querySelectorAll('[data-tool-semantic-preview]')).toHaveLength(1);
  });

  it('marks an undeliverable room send as a failure and keeps the room readable', async () => {
    const { container } = await renderCard(semanticTool(
      'ThreadSend',
      { room: 'release-contract', content: 'status?' },
      JSON.stringify({ roomId: 'release-contract', messageId: undefined, delivery: 'undeliverable' }),
    ));
    const state = container.querySelector('[data-tool-state]');
    expect(state?.textContent).toBe('Not delivered');
    expect(state?.className).toContain('text-danger');
    expect(container.textContent).toContain('release-contract');
  });

  it('keeps failure, stop and running states identical to any other step', async () => {
    const failed = await renderCard(semanticTool(
      'ThreadSend',
      { thread: THREAD_REF, content: 'ping', idempotency_key: 'k' },
      'Thread communication is disabled for this session.',
      { status: 'error', isError: true },
    ));
    expect(failed.container.querySelector('[data-outcome="failed"]')).not.toBeNull();
    expect(failed.container.textContent).toContain('Thread communication is disabled');
    expect(failed.container.querySelector('[data-tool-state]')).toBeNull();
    const stopped = await renderCard(semanticTool('TaskWait', { timeout: 60 }, 'user cancelled', { status: 'stopped' }));
    expect(stopped.container.querySelector('[data-outcome="stopped"]')).not.toBeNull();
    expect(stopped.container.textContent).toContain('Stopped — user cancelled');
    const running = await renderCard(semanticTool('HistorySearch', { query: 'deploy' }, undefined, { status: 'running' }));
    expect(running.container.textContent).toContain('Search history');
    expect(running.container.textContent).toContain('deploy');
    expect(running.container.querySelector('[data-tool-count]')).toBeNull();
    expect(running.container.querySelector('[aria-label="running"]')).not.toBeNull();
  });

  it('shows todo progress, the question asked, and the page fetched', async () => {
    const todo = await renderCard(semanticTool(
      'TodoList',
      { todos: [{ title: 'Inventory', status: 'done' }, { title: 'Wire cards', status: 'in_progress' }, { title: 'Screenshots', status: 'pending' }] },
      'Todo list updated.\nCurrent todo list:\n  [done] Inventory\n  [in_progress] Wire cards\n  [pending] Screenshots',
    ));
    expect(todo.container.textContent).toContain('Update todos');
    expect(todo.container.textContent).toContain('Wire cards');
    expect(todo.container.querySelector('[data-tool-count]')?.textContent).toBe('1/3');
    const ask = await renderCard(semanticTool(
      'AskUserQuestion',
      { questions: [{ question: 'Which branch?', header: 'Branch', options: [{ label: 'main', description: '' }, { label: 'dev', description: '' }], multi_select: false }] },
      JSON.stringify({ answers: { 'Which branch?': 'main' } }),
    ));
    expect(ask.container.textContent).toContain('Which branch?');
    expect(ask.container.querySelector('[data-tool-state]')?.textContent).toBe('Answered');
    const fetched = await renderCard(semanticTool(
      'FetchURL',
      { url: 'https://example.com/docs' },
      'Fetched https://example.com/docs. If you use it in your answer, cite this page as a markdown link, e.g. [title](url).\n\n# Docs\nBody text.',
      { display: { kind: 'url_fetch', url: 'https://example.com/docs' } },
    ));
    expect(fetched.container.textContent).toContain('Fetch page');
    expect(fetched.container.textContent).toContain('https://example.com/docs');
    await expand(fetched.container);
    expect(fetched.container.querySelector('[data-tool-semantic-preview]')?.textContent).toContain('Body text.');
    expect(fetched.container.querySelector('[data-tool-raw]')).toBeNull();
    await openRaw(fetched.container);
    expect(fetched.container.querySelector('[data-tool-raw]')?.textContent).toContain('"url": "https://example.com/docs"');
    expect(fetched.container.querySelector('[data-tool-raw]')?.textContent).toContain('Body text.');
  });

  it('previews a native partial fetch, expands the loaded article, and keeps Raw data separate', async () => {
    const body = '# Article\nReadable body\n' + 'paragraph\n'.repeat(40) + 'loaded article tail';
    const output = JSON.stringify({ schema_version: 1, mode: 'fetch', action: 'run', execution: 'sync', status: 'partial',
      documents: [{ url: 'https://example.com/article', content: body, content_type: 'text/html', truncated: true,
        warnings: [{ code: 'CONTENT_LIMIT', message: 'Content limit reached' }] }], hints: [] }, null, 2);
    const { container } = await renderCard(semanticTool('FetchURL', { source: { kind: 'url', url: 'https://example.com/article' }, max_content_chars: 10000 }, output,
      { status: 'error', isError: true }));
    await expand(container);
    expect(container.querySelector('[data-tool-semantic-preview]')?.textContent).toContain('Readable body');
    expect(container.querySelector('[data-tool-semantic-fields]')?.textContent).toContain('truncated or incomplete');
    expect(container.querySelector('[data-tool-preview-notice]')?.textContent).toContain('Content limit reached');
    expect(container.querySelector('[data-tool-semantic-preview]')?.textContent).not.toContain('loaded article tail');
    await act(async () => { click(container.querySelector('[data-tool-preview-full]')!); });
    expect(container.querySelector('[data-tool-semantic-preview]')?.textContent).toBe(body);
    expect(container.querySelector('[data-tool-raw]')).toBeNull();
    await openRaw(container);
    expect(container.querySelector('[data-tool-raw]')?.textContent).toContain('"max_content_chars": 10000');
  });

  it('shows unknown search content rather than zero results in the first disclosure', async () => {
    const { container } = await renderCard(semanticTool('WebSearch', { query: 'example' }, '{"future_shape":"Useful evidence"}'));
    expect(container.querySelector('[data-tool-count]')).toBeNull();
    await expand(container);
    expect(container.querySelector('[data-tool-preview-notice]')?.textContent).toBe('Preview unavailable');
    expect(container.querySelector('[data-tool-semantic-preview]')?.textContent).toContain('Useful evidence');
    await openRaw(container);
    expect(container.querySelector('[data-tool-raw]')?.textContent).toContain('"query": "example"');
  });

  it.each(['MemoryRead', 'MemorySearch'])('%s marks the display cut, reads the loaded tail and exposes the original parameters', async (name) => {
    localStorage.setItem('kiki.locale', 'zh');
    try {
      const output = JSON.stringify([{ title: 'Memory title', body: 'context '.repeat(400) + 'memory result tail' }]);
      const { container } = await renderCard(semanticTool(name, { query: 'memory query', scope: 'global' }, output));
      await act(async () => { click(container.querySelector('[data-memory-tool-toggle]')!); });
      expect(container.querySelector('[data-tool-show-full]')).toBeNull();
      expect(container.querySelector('[data-tool-record-field="output"] pre')?.textContent).toBe(output);
      expect(container.querySelector('[data-tool-record-field="input"]')?.textContent).toContain('"query": "memory query"');
      expect(container.querySelector('[data-tool-raw-toggle]')).toBeNull();
    } finally { localStorage.removeItem('kiki.locale'); }
  });

  it('preserves MemoryWrite View and Undo while adding original parameters and results', async () => {
    const { container } = await renderCard(semanticTool('MemoryWrite', { body: 'Remember this', reason: 'User preference' },
      JSON.stringify({ id: 'memory-example', title: 'Preference', scope: 'global', status: 'active', revision: '1', operation_id: 'operation-example' })));
    expect(container.querySelector('[data-memory-tool-view]')).not.toBeNull();
    expect(container.querySelector('[data-memory-tool-undo]')).not.toBeNull();
    await act(async () => { click(container.querySelector('[data-memory-tool-toggle]')!); });
    expect(container.textContent).toContain('User preference');
    expect(container.querySelector('[data-tool-record-field="output"]')?.textContent).toContain('operation-example');
    expect(container.querySelector('[data-tool-record-field="input"]')?.textContent).toContain('"body": "Remember this"');
    expect(container.querySelector('[data-tool-raw-toggle]')).toBeNull();
  });

  it('tells a stored write, a proposal and a no-op apart, and only offers Undo for a real operation', async () => {
    const receipt = (fields: Record<string, unknown>) => JSON.stringify({
      action: 'update', outcome: 'applied', id: 'memory-example', title: 'Preference',
      scope: 'global', owner_scope: { kind: 'global' },
      target: { scope: 'global', id: 'memory-example', expected_revision: '1' },
      status: 'active', revision: '1', operation_id: 'operation-example', ...fields,
    });
    const stored = await renderCard(semanticTool('MemoryWrite', { action: 'update', reason: 'User preference' }, receipt({})));
    expect(stored.container.querySelector('[data-memory-tool-undo]')).not.toBeNull();
    expect(stored.container.textContent).toContain('Updated memory');

    const proposal = await renderCard(semanticTool('MemoryWrite', { action: 'update', reason: 'Learned from review' }, receipt({
      outcome: 'pending', status: 'pending', operation_id: 'operation-pending',
      proposed_target: { scope: 'global', id: 'memory-old', expected_revision: '0' },
    })));
    expect(proposal.container.textContent).toContain('Sent to the memory inbox');
    // A proposal is journal-backed, so it can still be taken back.
    expect(proposal.container.querySelector('[data-memory-tool-undo]')).not.toBeNull();
    await act(async () => { click(proposal.container.querySelector('[data-memory-tool-toggle]')!); });
    expect(proposal.container.querySelector('[data-memory-tool-pending]')?.textContent).toContain('original entry is unchanged');

    const duplicate = await renderCard(semanticTool('MemoryWrite', { action: 'create' }, receipt({ outcome: 'pending', status: 'pending', operation_id: null })));
    expect(duplicate.container.querySelector('[data-memory-tool-undo]')).toBeNull();
    await act(async () => { click(duplicate.container.querySelector('[data-memory-tool-toggle]')!); });
    expect(duplicate.container.querySelector('[data-memory-tool-pending]')?.textContent).toBe('This is a pending proposal and is not in effect yet.');

    const noop = await renderCard(semanticTool('MemoryWrite', { action: 'update', reason: 'Re-checking' }, receipt({
      outcome: 'unchanged', operation_id: null,
    })));
    expect(noop.container.textContent).toContain('No change');
    // No operation was created, so there is nothing to replay.
    expect(noop.container.querySelector('[data-memory-tool-undo]')).toBeNull();
    await act(async () => { click(noop.container.querySelector('[data-memory-tool-toggle]')!); });
    expect(noop.container.querySelector('[data-memory-tool-unchanged]')?.textContent).toContain('no new version');
  });

  it('locates a persona-owned write in its own namespace instead of the session workspace', async () => {
    const { container } = await renderCard(semanticTool('MemoryWrite', { reason: 'Role agreement' }, JSON.stringify({
      action: 'create', outcome: 'applied', id: 'm_persona', title: 'Publish confirmation',
      scope: 'persona', owner_scope: { kind: 'persona', personaId: 'lin-lan' },
      target: { scope: 'persona', id: 'm_persona', expected_revision: '1' },
      status: 'active', revision: '1', operation_id: 'op_persona',
    })));
    expect(container.querySelector('[data-memory-tool-scope]')?.getAttribute('data-memory-scope-kind')).toBe('persona');
    expect(container.querySelector('[data-memory-tool-scope]')?.textContent).toContain('Persona');
  });

  it('reads a search envelope and a short page as partial rather than as a complete result', async () => {
    const envelope = await renderCard(semanticTool('MemorySearch', { query: 'report' }, JSON.stringify({
      items: [{ id: 'm_1', title: 'One' }, { id: 'm_2', title: 'Two' }],
      mode: 'search', next_cursor: 'next-page',
      coverage: { scopes: [{ kind: 'global' }], statuses: ['active'], exhausted: false, complete: false, warnings: ['1 unreadable'] },
    })));
    expect(envelope.container.textContent).toContain('2 results, maybe more');

    // A pre-envelope session recorded a plain array, and it still reads.
    const legacy = await renderCard(semanticTool('MemorySearch', { query: 'report' }, JSON.stringify([{ id: 'm_1' }])));
    expect(legacy.container.textContent).toContain('1 match');
  });

  it('reads and copies loaded input and generic JSON beyond 6000 characters without conflating display and payload cuts', async () => {
    const args = { content: 'input '.repeat(1200) + 'input record tail' };
    const output = { result: 'output '.repeat(1100) + 'output record tail', truncated: true };
    const writeText = vi.fn().mockResolvedValue(undefined);
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      const { container } = await renderCard(semanticTool('ExampleTool', args, output));
      await expand(container);
      const wells = container.querySelectorAll('[data-loaded-tool-text]');
      expect(wells).toHaveLength(2);
      expect(container.querySelector('[data-tool-show-full]')).toBeNull();
      expect(container.textContent).toContain('input record tail');
      expect(container.textContent).toContain('output record tail');
      expect(container.querySelector('[data-tool-payload-status]')?.textContent).toContain('payload is truncated or incomplete');
      // Each well's copy tile is named after the body it takes, so a column of
      // identical glyphs still says which one a press acts on. The input well
      // also keeps the "loaded record only" caveat in its name: this input
      // arrived cut, and a bare "Copy" would overstate what lands.
      const copies = [...container.querySelectorAll('[data-copy-state]')];
      expect(copies.map((button) => button.getAttribute('aria-label'))).toEqual([
        'Copy Input · Copies the loaded record only',
        'Copy Output',
      ]);
      expect(copies.every((button) => button.textContent === '')).toBe(true);
      await act(async () => { click(copies[0]!); click(copies[1]!); });
      expect(writeText.mock.calls.map((call) => call[0])).toEqual([JSON.stringify(args, null, 2), JSON.stringify(output, null, 2)]);
      for (const button of container.querySelectorAll('[data-tool-show-full]')) await act(async () => { click(button); });
      expect(wells[0]!.querySelector('pre')?.textContent).toBe(JSON.stringify(args, null, 2));
      expect(wells[1]!.querySelector('pre')?.textContent).toBe(JSON.stringify(output, null, 2));
    } finally {
      if (descriptor !== undefined) Object.defineProperty(navigator, 'clipboard', descriptor);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('labels an absent result rather than showing an empty raw output well', async () => {
    const { container } = await renderCard(semanticTool('FetchURL', { url: 'https://example.com/article' }, undefined, { status: 'running' }));
    await expand(container);
    expect(container.querySelector('[data-tool-preview-notice]')?.textContent).toContain('not yet loaded');
    await openRaw(container);
    expect(container.querySelector('[data-tool-raw]')?.textContent).toContain('not yet loaded');
  });

  it('drops a settled AgentSend call once its Input sent entry stands for it', () => {
    const call = semanticTool('AgentSend', { target: 'explorer', message: 'go' }, JSON.stringify({ message_id: 'm', status: 'delivered', deduplicated: false, target: { task_name: 'explorer', agent_id: 'agent-1' } }));
    const sent: Block = {
      kind: 'subagent-event', id: 'event-sent', subagentId: 'agent-1', parentAgentId: 'main', name: 'explorer',
      event: 'sent', status: 'running', at: '2026-01-01T00:00:00.000Z', message: 'go', delivery: 'delivered', anchorToolCallId: call.toolCallId,
    };
    expect(mergeSubagentRows([call, sent] as DisplayNode[])).toEqual([sent]);
    const failedCall = { ...call, status: 'error' as const, isError: true };
    expect(mergeSubagentRows([failedCall, sent] as DisplayNode[])).toEqual([failedCall, sent]);
  });
  it('keeps one right edge: every semantic row reserves the mark and jump slots, and the fact is proportional', async () => {
    const withJump = await renderCard(semanticTool(
      'ThreadSend',
      { thread: THREAD_REF, content: 'ping', idempotency_key: 'k' },
      JSON.stringify({ messageId: 'm', targetSeq: 1, acceptedAt: 1, deduplicated: false, delivery: 'delivered' }),
    ));
    const withoutJump = await renderCard(semanticTool('ThreadList', {}, JSON.stringify({ threads: [] })));
    expect(withJump.container.querySelector('[data-tool-jump="session"]')).not.toBeNull();
    const slot = withoutJump.container.querySelector('[data-tool-jump-slot]');
    expect(slot?.className).toContain('w-7');
    for (const { container } of [withJump, withoutJump]) {
      const fact = container.querySelector('[data-tool-fact]')!;
      expect(fact.className).toContain('font-sans');
      expect(fact.className).toContain('tabular-nums');
      expect(fact.closest('[class*="font-mono"]')).toBeNull();
    }
    expect(withoutJump.container.querySelector('[data-tool-count]')?.textContent).toBe('0 threads');
  });

  it('writes a failure’s first line in the row’s own type, coloured only', async () => {
    const { container } = await renderCard(semanticTool(
      'ThreadSend',
      { thread: THREAD_REF, content: 'ping', idempotency_key: 'k' },
      'Thread communication is disabled for this session.',
      { status: 'error', isError: true },
    ));
    const detail = [...container.querySelectorAll('[data-activity-toggle] span')].find((node) => node.textContent === 'Thread communication is disabled for this session.')!;
    expect(detail.closest('[class*="font-mono"]')).toBeNull();
    expect(detail.closest('.text-danger')).not.toBeNull();
  });

  it('translates wire states in Chinese instead of showing the engine words', async () => {
    localStorage.setItem('kiki.locale', 'zh');
    try {
      const run = await renderCard(semanticTool(
        'AgentRun',
        { prompt: 'x', description: 'Map auth flow' },
        'agent_id: agent-7\nactual_profile: explore\nstatus: completed',
      ));
      expect(run.container.querySelector('[data-tool-state]')?.textContent).toBe('已完成');
      const stop = await renderCard(semanticTool('TaskStop', { task_id: 'bash-k2' }, 'task_id: bash-k2\nstatus: killed\nreason: done'));
      expect(stop.container.querySelector('[data-tool-state]')?.textContent).toBe('已停止');
      const list = await renderCard(semanticTool('AgentList', {}, JSON.stringify({ agents: [{ agent_id: 'a1', name: 'deps', status: 'running' }] })));
      await expand(list.container);
      expect(list.container.querySelector('[data-tool-semantic-items]')?.textContent).toContain('运行中');
      expect(list.container.querySelector('[data-tool-semantic-items]')?.textContent).not.toContain('running');
    } finally {
      localStorage.removeItem('kiki.locale');
    }
  });
});

describe('Kiki hook injections', () => {
  const hookText = '[Kiki memory]\nPrefers pnpm over npm.\n\n[Kiki goal_state]\nGoal (active): ship the limit fix';

  function hookBlocks(event: string, text: string): Block[] {
    return agentTranscriptToBlocks({
      agent_id: 'main',
      items: [{
        kind: 'turn', turnId: 't-hook', ordinal: 1, state: 'completed',
        origin: { kind: 'user', payload: { promptId: 'p-hook' } }, prompt: 'Fix the limit parser.',
        startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:05.000Z',
        steps: [{
          kind: 'step', stepId: 't-hook.1', turnId: 't-hook', ordinal: 1, state: 'completed',
          frames: [{
            kind: 'text', frameId: 'f-hook', role: 'user', text,
            origin: { kind: 'hook_result', event, blocked: false },
          }],
        }],
      }],
      has_more: false,
    });
  }

  it('projects the hook event onto the system block', () => {
    const hook = hookBlocks('kiki:claude:SessionStart', hookText).find((block) => block.kind === 'system');
    expect(hook).toMatchObject({ kind: 'system', variant: 'hook_result', hookEvent: 'kiki:claude:SessionStart' });
  });

  it('says who and when on the row, and reveals the labelled parts on expand', async () => {
    const container = await renderTranscript(hookBlocks('kiki:claude:SessionStart', hookText));
    const row = container.querySelector('[data-kiki-hook="claude:SessionStart"]')!;
    expect(row.getAttribute('data-hook-outcome')).toBe('injected');
    expect(row.textContent).toContain('Kiki added context for Claude Code');
    expect(row.textContent).toContain('Session start');
    expect(row.textContent).toContain('Memory, Goal');
    expect(row.textContent).not.toContain('Prefers pnpm');
    expect(row.querySelector('[data-hook-prepared]')).toBeNull();
    await act(async () => { click(row.querySelector('button')!); });
    const parts = [...row.querySelectorAll('[data-kiki-hook-part]')].map((part) => part.getAttribute('data-kiki-hook-part'));
    expect(parts).toEqual(['memory', 'goal_state']);
    expect(row.textContent).toContain('Prefers pnpm over npm.');
    expect(row.textContent).not.toContain('[Kiki memory]');
  });

  it('shows PreCompact as prepared, never as delivered', async () => {
    const container = await renderTranscript(hookBlocks('kiki:codex:PreCompact',
      `[Handoff prepared; not injected by this hook]\n[Kiki handoff]\nPreserve the current goal.`));
    const row = container.querySelector('[data-kiki-hook="codex:PreCompact"]')!;
    expect(row.getAttribute('data-hook-outcome')).toBe('prepared');
    expect(row.querySelector('[data-hook-prepared]')?.textContent).toBe('Prepared, not injected');
    expect(row.textContent).toContain('Kiki prepared a handoff for Codex');
    expect(row.textContent).not.toContain('added context');
    await act(async () => { click(row.querySelector('button')!); });
    expect(row.textContent).toContain('this hook sent nothing');
    expect(row.textContent).not.toContain('Handoff prepared; not injected by this hook');
  });

  it('leaves a non-Kiki hook result on the generic row', async () => {
    const container = await renderTranscript(hookBlocks('UserPromptSubmit', 'lint passed'));
    expect(container.querySelector('[data-kiki-hook]')).toBeNull();
    expect(container.querySelector('[data-system="hook_result"]')?.textContent).toContain('Hook result');
  });
});


it('strips a stored SSH host block from an old message and draws no per-message host row', async () => {
  const container = await renderTranscript([{ kind: 'user', id: 'ssh-user', createdAt: '2026-01-01T00:00:00.000Z',
    text: 'Inspect the host\n\n<ssh_host_refs>\n[{"id":"example-host","name":"Example host"}]\n</ssh_host_refs>',
  }]);
  // The hosts live on the session's control in the composer now; the message
  // reads exactly as it was typed, with no marker and no raw XML.
  expect(container.querySelector('.bg-bubble-user')?.textContent).toBe('Inspect the host');
  expect(container.textContent).not.toContain('ssh_host_refs');
  expect(container.textContent).not.toContain('Example host');
  expect(container.querySelector('[data-user-ssh-hosts]')).toBeNull();
  expect(container.querySelector('[data-user-ssh-host]')).toBeNull();
});


describe('ordinary bounded message reading', () => {
  it('continues prompt, assistant and thinking from their exact sources, then restores full copy/edit targets', async () => {
    const { TranscriptDetailProvider } = await import('./transcriptDetail');
    const source: import('@kiki/transcript').ContentSource = { kind: 'turn', id: 't0' };
    const frameSource: import('@kiki/transcript').ContentSource = { kind: 'frame', id: 'f0', turnId: 't0', stepId: 's0' };
    const thinkingSource = { ...frameSource, id: 'think0' };
    const refs: import('@kiki/transcript').ContentRef[] = [source, frameSource, thinkingSource].map((entry) => ({ source: entry, path: [entry.kind === 'turn' ? 'prompt' : 'text'], revision: entry.id, kind: 'text', offset: 6, total: 12 }));
    const loadContent = vi.fn(async (_ref: import('@kiki/transcript').ContentRef) => true);
    const actions: TranscriptRowActions = { disabled: false, onEditMessage: vi.fn(), onRegenerate: vi.fn(), onFork: vi.fn() };
    const blocks: Block[] = [userBlock({ id: 'user-m0', text: 'prefix', userMessageId: 'm0', turnId: 't0', contentSource: source }), { ...assistantBlock('agent-frame-f0', 'prefix'), frameId: 'f0', stepId: 's0', turnId: 't0' }, { kind: 'thinking', id: 'agent-frame-think0', text: 'prefix', frameId: 'think0', stepId: 's0', turnId: 't0', streaming: false, createdAt: undefined }];
    const { root, container } = makeRoot();
    const show = async (pending: typeof refs, values: Block[]) => renderSettled(root, <TranscriptDetailProvider load={async () => false} loads={{}} contentRefs={pending} loadContent={loadContent}><Transcript state={transcriptState(values)} onLoadOlder={async () => false} onResolveApproval={noopActions} onAnswerQuestion={noopActions} onDismissQuestion={noopActions} rowActions={actions} /></TranscriptDetailProvider>, true);
    await show(refs, blocks);
    const user = container.querySelector('[data-block-id="user-m0"]')!;
    const answer = container.querySelector('[data-block-id="agent-frame-f0"]')!;
    expect(user.querySelector('[data-row-action="copy"]')).toBeNull();
    expect(user.querySelector('[data-row-action="edit"]')).toBeNull();
    expect(answer.querySelector('[data-row-action="copy"]')).toBeNull();
    await act(async () => { (user.querySelector('[data-content-continuation-action]') as HTMLButtonElement).click(); });
    await act(async () => { (answer.querySelector('[data-content-continuation-action]') as HTMLButtonElement).click(); });
    const thought = container.querySelector('[data-block-id="agent-frame-think0"]')!;
    await act(async () => { (thought.querySelector('button') as HTMLButtonElement).click(); });
    await act(async () => { (thought.querySelector('[data-content-continuation-action]') as HTMLButtonElement).click(); });
    expect(loadContent.mock.calls.map(([ref]) => ref)).toEqual(refs);
    await show([], blocks.map((block) => 'text' in block ? { ...block, text: 'prefixsuffix' } : block));
    expect(container.querySelectorAll('[data-content-continuation]')).toHaveLength(0);
    expect(container.querySelector('[data-block-id="user-m0"] [data-row-action="copy"]')).not.toBeNull();
    const edit = container.querySelector('[data-block-id="user-m0"] [data-row-action="edit"]') as HTMLButtonElement;
    await act(async () => { edit.click(); });
    expect(container.querySelector('textarea')?.value).toBe('prefixsuffix');
    expect(container.querySelector('[data-block-id="agent-frame-f0"] [data-row-action="copy"]')).not.toBeNull();
  });
});
