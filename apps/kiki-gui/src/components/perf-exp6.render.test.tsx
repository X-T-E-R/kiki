// @vitest-environment jsdom

/**
 * EXP-6 — real React Transcript render/commit scaling.
 *
 * This is an intentionally opt-in measurement test. Run only this file; the
 * assertions validate the fixture/measurement path rather than pinning timing
 * thresholds that would be machine-dependent.
 */
import { Profiler, type ProfilerOnRenderCallback } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import {
  createViewState,
  type AssistantBlock,
  type SessionViewState,
  type UserBlock,
} from '@kiki/session-core/session';
import { I18nProvider } from '../i18n';
import { Transcript } from './Transcript';

const LEVELS = [500, 1500, 3000] as const;
const MOUNT_SAMPLES = 3;
const UPDATE_WARMUPS = 5;
const UPDATE_SAMPLES = 40;
const LONG_MARKDOWN_SAMPLES = 30;
const TIMESTAMP = '2026-01-01T00:00:00.000Z';
const ORIGINAL_SCROLL_TO = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');

const loadOlder = async () => false;
const resolveApproval = async () => {};
const answerQuestion = async () => {};
const dismissQuestion = async () => {};

/**
 * Build an exact N-block session. Each settled turn contributes one user block
 * and one assistant block; the final turn is left streaming so the measured
 * update replaces only its assistant block.
 */
function buildSession(blockCount: number): { state: SessionViewState; liveTurnId: string } {
  if (blockCount % 2 !== 0 || blockCount < 2) {
    throw new Error(`blockCount must be an even number >= 2, received ${blockCount}`);
  }

  const turns = blockCount / 2;
  const blocks: (UserBlock | AssistantBlock)[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    const turnId = `turn-${turn}`;
    const streaming = turn === turns - 1;
    blocks.push({
      kind: 'user',
      id: `user-${turnId}`,
      text: `User prompt ${turn}`,
      createdAt: TIMESTAMP,
      turnId,
    });
    blocks.push({
      kind: 'assistant',
      id: streaming ? `agent-frame-live-${turnId}` : `agent-frame-${turnId}`,
      text: streaming
        ? '## Live answer\n\nSettled paragraph for the final turn.\n\nhot tail'
        : `Assistant reply ${turn}.`,
      streaming,
      createdAt: TIMESTAMP,
      turnId,
    });
  }
  const state: SessionViewState = {
    ...createViewState(`perf-${blockCount}`),
    loaded: true,
    blocks,
  };

  expect(state.blocks).toHaveLength(blockCount);
  expect(state.blocks.at(-1)).toMatchObject({ kind: 'assistant', streaming: true });
  return { state: { ...state, loaded: true }, liveTurnId: `turn-${turns - 1}` };
}

function buildLongMarkdownState(): { state: SessionViewState; liveTurnId: string } {
  const liveTurnId = 'long-markdown';
  const paragraph =
    'A paragraph with **bold text**, `inline code`, and a [link](https://example.test).';
  let text = '# Long streaming message\n\n';
  let index = 0;
  while (text.length < 20_000) {
    text += `${paragraph} Paragraph ${index}.\n\n`;
    index += 1;
  }
  text += 'hot tail';
  const state: SessionViewState = {
    ...createViewState('perf-long-markdown'),
    loaded: true,
    blocks: [
      {
        kind: 'user',
        id: `user-${liveTurnId}`,
        text: 'Render a long markdown response.',
        createdAt: TIMESTAMP,
        turnId: liveTurnId,
      },
      {
        kind: 'assistant',
        id: `agent-frame-live-${liveTurnId}`,
        text,
        streaming: true,
        createdAt: TIMESTAMP,
        turnId: liveTurnId,
      },
    ],
  };
  expect((state.blocks.at(-1) as { text: string }).text.length).toBeGreaterThanOrEqual(20_000);
  return { state, liveTurnId };
}

type Sample = {
  wallMs: number;
  profilerMs: number;
};

type Summary = {
  count: number;
  median: number;
  p95: number;
  max: number;
};

function summarize(values: readonly number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
  return {
    count: sorted.length,
    median: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1) ?? 0,
  };
}

function format(summary: Summary): string {
  return `median=${summary.median.toFixed(2)}ms p95=${summary.p95.toFixed(2)}ms max=${summary.max.toFixed(2)}ms`;
}

function renderTranscript(state: SessionViewState, onRender: ProfilerOnRenderCallback) {
  return (
    <I18nProvider>
      <Profiler id="transcript" onRender={onRender}>
        <Transcript
          state={state}
          onLoadOlder={loadOlder}
          onResolveApproval={resolveApproval}
          onAnswerQuestion={answerQuestion}
          onDismissQuestion={dismissQuestion}
        />
      </Profiler>
    </I18nProvider>
  );
}

function createContainerRoot(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.append(container);
  return { container, root: createRoot(container) };
}

function dispose(container: HTMLDivElement, root: Root): void {
  flushSync(() => {
    root.unmount();
  });
  container.remove();
}

function measureMount(state: SessionViewState): Sample & { domBlocks: number } {
  const { container, root } = createContainerRoot();
  let profilerMs = Number.NaN;
  const onRender: ProfilerOnRenderCallback = (_id, phase, actualDuration) => {
    if (phase === 'mount') profilerMs = actualDuration;
  };

  const started = performance.now();
  flushSync(() => {
    root.render(renderTranscript(state, onRender));
  });
  const wallMs = performance.now() - started;
  const domBlocks = container.querySelectorAll('[data-block-id]').length;

  dispose(container, root);
  expect(Number.isFinite(profilerMs)).toBe(true);
  return { wallMs, profilerMs, domBlocks };
}

function measureDeltaUpdates(
  initialState: SessionViewState,
  liveTurnId: string,
  samples: number,
  warmups: number,
  deltaForIteration: (iteration: number) => string,
): Sample[] {
  const { container, root } = createContainerRoot();
  let state = initialState;
  let currentProfilerMs = Number.NaN;
  const onRender: ProfilerOnRenderCallback = (_id, phase, actualDuration) => {
    if (phase === 'update') currentProfilerMs = actualDuration;
  };

  flushSync(() => {
    root.render(renderTranscript(state, onRender));
  });

  const measured: Sample[] = [];
  for (let iteration = 0; iteration < warmups + samples; iteration += 1) {
    const live = state.blocks.at(-1);
    if (live?.kind !== 'assistant') throw new Error('expected final live assistant block');
    const nextBlocks = state.blocks.slice();
    nextBlocks[nextBlocks.length - 1] = {
      ...live,
      text: live.text + deltaForIteration(iteration),
    };
    state = { ...state, blocks: nextBlocks };

    currentProfilerMs = Number.NaN;
    const started = performance.now();
    flushSync(() => {
      root.render(renderTranscript(state, onRender));
    });
    const wallMs = performance.now() - started;

    expect(Number.isFinite(currentProfilerMs)).toBe(true);
    if (iteration >= warmups) measured.push({ wallMs, profilerMs: currentProfilerMs });
  }

  expect(container.querySelectorAll('[data-block-id]').length).toBeLessThan(24);
  dispose(container, root);
  return measured;
}

function printHeader(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function printRow(label: string, samples: readonly Sample[]): void {
  console.log(
    `${label} | wall ${format(summarize(samples.map((sample) => sample.wallMs)))} | ` +
      `Profiler.actualDuration ${format(summarize(samples.map((sample) => sample.profilerMs)))}`,
  );
}

beforeAll(() => {
  localStorage.setItem('kiki.locale', 'en');
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute('data-transcript-scroll')) return 600;
    return this.hasAttribute('data-transcript-virtual-item') ? 96 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-transcript-scroll') ? 760 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-transcript-scroll') ? 600 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (!this.hasAttribute('data-transcript-scroll')) return 0;
    const content = this.querySelector<HTMLElement>('[data-transcript-virtual-content]');
    return Math.max(600, Number.parseFloat(content?.style.height ?? '0'));
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value(this: HTMLElement, options: ScrollToOptions | number, y?: number) {
      const requested = typeof options === 'number' ? (y ?? 0) : (options.top ?? this.scrollTop);
      this.scrollTop = Math.max(0, Math.min(requested, this.scrollHeight - this.clientHeight));
      this.dispatchEvent(new Event('scroll'));
    },
  });
  vi.stubGlobal(
    'ResizeObserver',
    class NoopResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterAll(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_SCROLL_TO === undefined) {
    delete (HTMLElement.prototype as unknown as { scrollTo?: unknown }).scrollTo;
  }
  else Object.defineProperty(HTMLElement.prototype, 'scrollTo', ORIGINAL_SCROLL_TO);
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it(
  'measures real Transcript mount and per-delta React commit scaling',
  { timeout: 240_000 },
  () => {
    console.log(
      `EXP-6 environment: node=${process.version} platform=${process.platform} ` +
        `vitest=jsdom (no layout/paint)`,
    );

    // Small unrecorded mount to pay module/JIT first-use costs before M1.
    const warm = buildSession(20);
    measureMount(warm.state);

    printHeader(`M1 initial mount (${MOUNT_SAMPLES} samples per N)`);
    console.log('blocks | wall render+commit | React Profiler render duration');
    const fixtures = new Map<number, ReturnType<typeof buildSession>>();
    for (const blockCount of LEVELS) {
      const fixture = buildSession(blockCount);
      fixtures.set(blockCount, fixture);
      const samples = Array.from({ length: MOUNT_SAMPLES }, () => measureMount(fixture.state));
      expect(samples.every((sample) => sample.domBlocks > 0 && sample.domBlocks < 24)).toBe(true);
      printRow(String(blockCount).padStart(6), samples);
    }

    printHeader(`M2 one streaming delta (${UPDATE_SAMPLES} samples after ${UPDATE_WARMUPS} warmups)`);
    console.log('blocks | wall render+commit (reducer excluded) | React Profiler render duration');
    for (const blockCount of LEVELS) {
      const fixture = fixtures.get(blockCount)!;
      const samples = measureDeltaUpdates(
        fixture.state,
        fixture.liveTurnId,
        UPDATE_SAMPLES,
        UPDATE_WARMUPS,
        () => 'x',
      );
      expect(samples).toHaveLength(UPDATE_SAMPLES);
      printRow(String(blockCount).padStart(6), samples);
    }

    printHeader(`M3 20k markdown streaming (${LONG_MARKDOWN_SAMPLES} samples)`);
    console.log('scenario | wall render+commit | React Profiler render duration');
    const hotTail = buildLongMarkdownState();
    const hotTailSamples = measureDeltaUpdates(
      hotTail.state,
      hotTail.liveTurnId,
      LONG_MARKDOWN_SAMPLES,
      UPDATE_WARMUPS,
      () => 'x',
    );
    printRow('hot-tail token (stable parsed prefix)', hotTailSamples);

    const boundary = buildLongMarkdownState();
    const boundarySamples = measureDeltaUpdates(
      boundary.state,
      boundary.liveTurnId,
      LONG_MARKDOWN_SAMPLES,
      UPDATE_WARMUPS,
      () => 'x\n\n',
    );
    printRow('paragraph boundary (prefix reparse)', boundarySamples);

    expect(hotTailSamples).toHaveLength(LONG_MARKDOWN_SAMPLES);
    expect(boundarySamples).toHaveLength(LONG_MARKDOWN_SAMPLES);
  },
);
