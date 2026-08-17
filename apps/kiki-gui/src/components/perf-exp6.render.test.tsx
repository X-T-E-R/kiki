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

import { I18nProvider } from '../i18n';
import type { SessionEventFrame } from '../lib/types';
import {
  applyFrame,
  createViewState,
  type SessionViewState,
} from '../state/transcript';
import { Transcript } from './Transcript';

const LEVELS = [500, 1500, 3000] as const;
const MOUNT_SAMPLES = 3;
const UPDATE_WARMUPS = 5;
const UPDATE_SAMPLES = 40;
const LONG_MARKDOWN_SAMPLES = 30;
const TIMESTAMP = '2026-01-01T00:00:00.000Z';

const loadOlder = async () => false;
const resolveApproval = async () => {};
const answerQuestion = async () => {};
const dismissQuestion = async () => {};

let sequence = 0;

function durableFrame(payload: SessionEventFrame['payload']): SessionEventFrame {
  sequence += 1;
  return {
    type: 'event.agent',
    seq: sequence,
    timestamp: TIMESTAMP,
    payload,
  };
}

function deltaFrame(turnId: string, delta: string, offset: number): SessionEventFrame {
  return {
    type: 'event.agent',
    seq: sequence,
    timestamp: TIMESTAMP,
    volatile: true,
    offset,
    payload: {
      type: 'assistant.delta',
      turnId,
      delta,
      agentId: 'main',
    } as never,
  };
}

function apply(state: SessionViewState, frame: SessionEventFrame): SessionViewState {
  const result = applyFrame(state, frame);
  expect(result.gapDetected).toBe(false);
  return result.state;
}

/**
 * Build an exact N-block session through the production reducer. Each settled
 * turn contributes one user block and one assistant block; the final turn is
 * left streaming so the measured update replaces only its assistant block.
 */
function buildSession(blockCount: number): { state: SessionViewState; liveTurnId: string } {
  if (blockCount % 2 !== 0 || blockCount < 2) {
    throw new Error(`blockCount must be an even number >= 2, received ${blockCount}`);
  }

  sequence = 0;
  let state = createViewState(`perf-${blockCount}`);
  const turns = blockCount / 2;

  for (let turn = 0; turn < turns; turn += 1) {
    const turnId = `turn-${turn}`;
    state = apply(
      state,
      durableFrame({
        type: 'turn.started',
        turnId,
        prompt: `User prompt ${turn}`,
        agentId: 'main',
      } as never),
    );

    const text = turn === turns - 1
      ? '## Live answer\n\nSettled paragraph for the final turn.\n\nhot tail'
      : `Assistant reply ${turn}.`;
    state = apply(state, deltaFrame(turnId, text, 0));

    if (turn !== turns - 1) {
      state = apply(
        state,
        durableFrame({
          type: 'turn.ended',
          turnId,
          reason: 'completed',
          agentId: 'main',
        } as never),
      );
    }
  }

  expect(state.blocks).toHaveLength(blockCount);
  expect(state.blocks.at(-1)).toMatchObject({ kind: 'assistant', streaming: true });
  return { state: { ...state, loaded: true }, liveTurnId: `turn-${turns - 1}` };
}

function buildLongMarkdownState(): { state: SessionViewState; liveTurnId: string } {
  sequence = 0;
  const liveTurnId = 'long-markdown';
  let state = createViewState('perf-long-markdown');
  state = apply(
    state,
    durableFrame({
      type: 'turn.started',
      turnId: liveTurnId,
      prompt: 'Render a long markdown response.',
      agentId: 'main',
    } as never),
  );

  const paragraph =
    'A paragraph with **bold text**, `inline code`, and a [link](https://example.test).';
  let text = '# Long streaming message\n\n';
  let index = 0;
  while (text.length < 20_000) {
    text += `${paragraph} Paragraph ${index}.\n\n`;
    index += 1;
  }
  text += 'hot tail';

  state = apply(state, deltaFrame(liveTurnId, text, 0));
  expect((state.blocks.at(-1) as { text: string }).text.length).toBeGreaterThanOrEqual(20_000);
  return { state: { ...state, loaded: true }, liveTurnId };
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
    state = apply(state, deltaFrame(liveTurnId, deltaForIteration(iteration), live.text.length));

    currentProfilerMs = Number.NaN;
    const started = performance.now();
    flushSync(() => {
      root.render(renderTranscript(state, onRender));
    });
    const wallMs = performance.now() - started;

    expect(Number.isFinite(currentProfilerMs)).toBe(true);
    if (iteration >= warmups) measured.push({ wallMs, profilerMs: currentProfilerMs });
  }

  expect(container.querySelectorAll('[data-block-id]').length).toBe(state.blocks.length);
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
      expect(samples.every((sample) => sample.domBlocks === blockCount)).toBe(true);
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
