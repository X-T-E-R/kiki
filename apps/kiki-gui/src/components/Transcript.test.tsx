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

import { act, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ApprovalDecision, QuestionAnswer } from '@kiki/protocol';
import type { AgentTranscriptSnapshot } from '@kiki/transcript';

import {
  getAnnotationOverridesSnapshot,
  readDraft,
  resetAnnotationOverridesForTests,
} from '@kiki/session-core/composer';
import {
  SessionController,
  agentTranscriptToBlocks,
  assistantMessageIdFromBlockId,
  buildAgentForest,
  createViewState,
  projectAgentTranscriptView,
  type AgentForest,
  type Block,
  type DisplayNode,
  type SessionViewState,
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
  completeTurnOps,
  olderTurnSnapshot,
  opsEvent,
  resetEvent,
  spawnChildOps,
  userTurnSnapshot,
} from '@kiki/session-core/session/__fixtures__/canonicalTranscript';
import { I18nProvider } from '../i18n';
import type { AgentTranscriptResponse, KikiClient } from '../lib/client';
import { revealSubagentCard } from './ActivityHistory';
import { locateInTimeline, normalizeTurnId, registerTimelineLocator, resetTimelineLocatorsForTests } from '../lib/timelineLocate';
import { Markdown } from './Markdown';
import { MediaPartList, MediaPreviewProvider } from './mediaPreview';
import { resolveSubagentToolCalls } from './subagentToolCalls';
import { ToolCard } from './ToolCard';
import {
  mergeSubagentRows,
  splitPrefixSegments,
  splitStreamingText,
  subagentAutoForm,
  Transcript,
  TurnTailLine,
  type TranscriptRowActions,
} from './Transcript';

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
async function renderSettled(root: Root, node: ReactNode): Promise<void> {
  await act(async () => {
    flushSync(() => {
      root.render(
        <MemoryRouter>
          <I18nProvider>{node}</I18nProvider>
        </MemoryRouter>,
      );
    });
  });
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

afterAll(async () => {
  for (const root of roots) {
    await act(async () => {
      flushSync(() => {
        root.unmount();
      });
    });
  }
  for (const container of containers) container.remove();
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
    expect(thumb?.getAttribute('src')).toBe('data:image/png;base64,AA');
    await act(async () => {
      thumb!.closest('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // The lightbox portals to document.body.
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AA');
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
  return { ...createViewState('session_test'), loaded: true, blocks, ...overrides };
}

function noopActions(): Promise<void> {
  return Promise.resolve();
}

async function renderTranscript(
  blocks: Block[],
  rowActions?: TranscriptRowActions,
  stateOverrides?: Partial<SessionViewState>,
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
    />,
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

function rowActionButtons(row: Element): string[] {
  return [...row.querySelectorAll('[data-row-action]')].map(
    (el) => el.getAttribute('data-row-action') ?? '',
  );
}

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
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
    const sent = `compare with /s/${id} first\n\n<thread_refs>\n<thread_ref id="${id}" status="idle"/>\nRead it with ThreadRead.\n</thread_refs>`;
    const container = await renderTranscript([userBlock({ id: 'user-thread-ref', text: sent })]);
    const bubble = container.querySelector('[data-block-id="user-thread-ref"]')!;
    expect(bubble.querySelector(`[data-thread-ref-chip="${id}"]`)).not.toBeNull();
    expect(bubble.textContent).toContain('compare with');
    expect(bubble.textContent).toContain('first');
    expect(bubble.textContent).not.toContain('thread_ref');
    expect(bubble.textContent).not.toContain('ThreadRead');
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
  it('marks the source passage and reopens it for local comment editing', async () => {
    resetAnnotationOverridesForTests();
    const quote = 'batches transcript blocks into floors';
    const originalComment = 'Floor batching keeps long sessions cheap';
    const editedComment = 'Keep the floor boundary explicit';
    const container = await renderTranscript([
      assistantBlock(
        'assistant-annotation-source',
        'The renderer **batches transcript blocks into floors** so long sessions stay cheap.',
      ),
      userBlock({
        id: 'user-annotation-carrier',
        text: `> ${quote}\n\nComment: ${originalComment}\n\nPlease factor this in.`,
      }),
    ]);

    const mark = container.querySelector<HTMLElement>('[data-annotation-ref]')!;
    expect(mark.textContent).toContain('batches transcript blocks into floors');
    expect(mark.getAttribute('aria-haspopup')).toBe('dialog');

    await act(async () => { click(mark); });
    let panel = document.body.querySelector<HTMLElement>('[data-annotation-panel]')!;
    let input = panel.querySelector<HTMLInputElement>('[data-annotation-panel-input]')!;
    expect(panel.textContent).toContain(quote);
    expect(input.value).toBe(originalComment);

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, editedComment);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { click(panel.querySelector('[data-annotation-panel-save]')!); });
    const annotationId = mark.dataset['annotationRef']!;
    expect(getAnnotationOverridesSnapshot()[annotationId]?.comment).toBe(editedComment);

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(document.body.querySelector('[data-annotation-panel]')).toBeNull();

    await act(async () => { click(mark); });
    panel = document.body.querySelector<HTMLElement>('[data-annotation-panel]')!;
    input = panel.querySelector<HTMLInputElement>('[data-annotation-panel-input]')!;
    expect(input.value).toBe(editedComment);
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    resetAnnotationOverridesForTests();
  });
});

describe('live and event chrome', () => {
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
    expect(rowActionButtons(rows[0]!)).toEqual(['copy', 'edit', 'fork']);
    // An older assistant row copies but never regenerates.
    expect(rowActionButtons(rows[1]!)).toEqual(['copy']);
    expect(rowActionButtons(rows[2]!)).toEqual(['copy', 'edit', 'fork']);
    expect(rowActionButtons(rows[3]!)).toEqual(['copy', 'regenerate', 'fork']);
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
    expect(rowActionButtons(rows[0]!)).toEqual(['copy']);
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
    expect(rowActionButtons(rows[0]!)).toEqual(['copy', 'edit', 'fork']);
  });

  it('hides all mutating actions when rowActions is absent (read-only surface)', async () => {
    const container = await renderTranscript([
      userBlock({ id: 'user-m1', text: 'question', userMessageId: 'm1' }),
      assistantBlock('assistant-m2-0', 'answer'),
    ]);
    const rows = [...container.querySelectorAll('[data-block-id]')];
    expect(rowActionButtons(rows[0]!)).toEqual([]);
    // The assistant copy button survives without row actions.
    expect(rowActionButtons(rows[1]!)).toEqual(['copy']);
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
      'attachments are not carried over',
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
});

describe('collapsible user message', () => {
  // jsdom has no layout: drive the overflow decision with prototype getters
  // keyed on the clamp class (clamped → clientHeight caps at 240px).
  function stubMetrics() {
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(
      function (this: HTMLElement) {
        return (this.textContent ?? '').length;
      },
    );
    const client = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(
      function (this: HTMLElement) {
        const full = (this.textContent ?? '').length;
        return this.classList.contains('max-h-60') ? Math.min(240, full) : full;
      },
    );
    return () => {
      scroll.mockRestore();
      client.mockRestore();
    };
  }

  it('shows no toggle for short messages', async () => {
    const restore = stubMetrics();
    const container = await renderTranscript([userBlock({ id: 'user-m1', text: 'short' })]);
    expect(container.querySelector('[data-collapsible-toggle]')).toBeNull();
    restore();
  });

  it('clamps overflowing messages and expands on toggle', async () => {
    const restore = stubMetrics();
    const container = await renderTranscript([
      userBlock({ id: 'user-m1', text: 'x'.repeat(600) }),
    ]);
    const content = container.querySelector('[data-collapsible-content]')!;
    const toggle = container.querySelector('[data-collapsible-toggle]');
    expect(toggle).not.toBeNull();
    expect(content.className).toContain('max-h-60');
    expect(content.className).toContain('collapsed-content-fade');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      flushSync(() => {
        click(toggle!);
      });
    });
    expect(content.className).not.toContain('max-h-60');
    expect(content.className).not.toContain('collapsed-content-fade');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    restore();
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
    await renderSettled(root, interactiveVirtualTranscript(state, { rowActions }));
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
});


describe('subagent timeline dual form (G-4)', () => {
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
  ): Promise<HTMLDivElement> {
    const { root, container } = makeRoot();
    await renderSettled(
      root,
      <Transcript
        state={transcriptState(blocks)}
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
    await act(async () => {
      flushSync(() => { click(card()!.querySelector('[data-card-collapse]')!); });
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
    await act(async () => {
      flushSync(() => { click(card()!.querySelector('[data-card-expand]')!); });
    });
    expect(card()?.getAttribute('data-card-form')).toBe('full');
    expect(card()?.textContent).toContain('the task brief');
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
