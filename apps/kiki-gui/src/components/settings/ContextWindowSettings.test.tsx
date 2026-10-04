// @vitest-environment jsdom

import { act, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { GlobalCompactionCard, ModelContextFields } from './ContextWindowSettings';

const { client } = vi.hoisted(() => ({ client: { getConfig: vi.fn(), patchConfig: vi.fn() } }));
vi.mock('../../state/connection', () => ({ useConnection: () => ({ client }) }));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.setItem('kiki.locale', 'en');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

async function render() {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={queries}><I18nProvider><GlobalCompactionCard /></I18nProvider></QueryClientProvider>));
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
}

describe('GlobalCompactionCard', () => {
  it('shows the legacy ratio and replaces it with a percentage on save', async () => {
    client.getConfig.mockResolvedValue({ loop_control: { maxStepsPerTurn: 40, compactionTriggerRatio: 0.8 } });
    client.patchConfig.mockResolvedValue({ loop_control: { maxStepsPerTurn: 40, autoCompact: '75%' } });
    await render();
    const input = container.querySelector<HTMLInputElement>('[data-global-auto-compact]')!;
    expect(input.value).toBe('80');
    expect(container.textContent).toContain('Currently active at 80%.');
    await type(input, '75');
    expect(client.patchConfig).toHaveBeenCalledWith({
      loop_control: { maxStepsPerTurn: 40, autoCompact: '75%' },
      replace_domains: ['loop_control'],
    });
  });

  it('refuses a percentage outside 1–100 without writing', async () => {
    client.getConfig.mockResolvedValue({ loop_control: { autoCompact: '85%' } });
    await render();
    const input = container.querySelector<HTMLInputElement>('[data-global-auto-compact]')!;
    expect(input.value).toBe('85');
    await type(input, '140');
    expect(client.patchConfig).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Enter a percentage between 1 and 100.');
  });
});

/**
 * The model editor owns the point as a draft, so the track is a controlled
 * control: it moves that draft, the text box shows the same number, and
 * nothing leaves the page until the editor saves.
 */
function ModelDraft({
  modelId,
  windowTokens,
  inputTokens,
  contextBudget,
  overrides,
  loopControl,
  initial,
}: {
  modelId: string;
  windowTokens: number;
  inputTokens?: number;
  contextBudget?: number;
  overrides?: unknown;
  loopControl: unknown;
  initial?: number;
}) {
  const [autoCompact, setAutoCompact] = useState<number | undefined>(initial);
  return (
    <ModelContextFields
      modelId={modelId}
      windowTokens={windowTokens}
      inputTokens={inputTokens}
      contextBudget={contextBudget}
      overrides={overrides}
      onWindowChange={() => {}}
      autoCompact={autoCompact}
      onAutoCompactChange={setAutoCompact}
      loopControl={loopControl}
    />
  );
}

const draw = async (children: ReactElement) => {
  await act(async () => root.render(<I18nProvider>{children}</I18nProvider>));
};

function setRange(input: HTMLInputElement, value: number) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, String(value));
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const trackOf = (modelId: string) => container.querySelector<HTMLElement>(`[data-compact-track="model:${modelId}"]`);
const sliderOf = (modelId: string) => trackOf(modelId)!.querySelector<HTMLInputElement>('[data-compact-slider]');
const readoutOf = (modelId: string) => trackOf(modelId)!.querySelector<HTMLElement>('[data-compact-track-value]')!;
const pointInputOf = (modelId: string) => container.querySelector<HTMLInputElement>(`[data-compact-point-field="model:${modelId}"] input`)!;
const reasonText = () => container.querySelector('[data-compact-track-reason]')?.textContent;

describe('ModelContextFields compaction track', () => {
  it('measures the point against the clamped window, not an oversized input limit', async () => {
    // 529.4k declared input under a 400k window: the engine reads 400k, so the
    // built-in 85% default is 340k — the raw declaration would have said 450k.
    await draw(<ModelDraft modelId="axon-for-test/gpt-6-astra" windowTokens={400_000} inputTokens={529_400} loopControl={{ autoCompact: '85%' }} />);
    const field = pointInputOf('axon-for-test/gpt-6-astra');
    expect(field.value).toBe('');
    expect(field.placeholder).toBe('Default 340k (global 85%)');
    expect(container.textContent).toContain('Usable context is 400k; compaction measures against that.');
    const readout = readoutOf('axon-for-test/gpt-6-astra');
    expect(readout.textContent).toBe('340k85%');
    expect(readout.getAttribute('title')).toBe('Default 340k (global 85%)');
    const slider = sliderOf('axon-for-test/gpt-6-astra')!;
    expect(slider.type).toBe('range');
    expect(slider.min).toBe('64000');
    expect(slider.max).toBe('350000');
    expect(slider.value).toBe('340000');
    expect(slider.disabled).toBe(false);
    expect(slider.getAttribute('aria-label')).toBe('Compaction point slider');
    expect(slider.getAttribute('aria-valuetext')).toBe('Compaction point 340k, limit 400k');
    expect(trackOf('axon-for-test/gpt-6-astra')!.querySelector<HTMLElement>('[data-compact-thumb]')?.style.left).toBe('85%');
    expect(trackOf('axon-for-test/gpt-6-astra')!.querySelector<HTMLElement>('[data-compact-track-reserve]')?.style.width).toBe('12.5%');
    expect(reasonText()).toBeUndefined();
  });

  it('drags the point into the draft without writing anything', async () => {
    await draw(<ModelDraft modelId="m/one" windowTokens={400_000} loopControl={{}} />);
    await act(async () => { setRange(sliderOf('m/one')!, 216_000); });
    expect(sliderOf('m/one')!.value).toBe('216000');
    expect(readoutOf('m/one').textContent).toBe('216k54%');
    // The same draft drives the text box and the preset row.
    expect(pointInputOf('m/one').value).toBe('216k');
    expect(container.querySelector('[data-token-presets="model:m/one"] [data-token-preset="200000"]')?.getAttribute('aria-pressed')).toBe('false');
    // Dragging is a draft edit: the track owns no writer at all.
    expect(client.patchConfig).not.toHaveBeenCalled();
  });

  it('keeps the text box on the raw draft while the readout shows the point that applies', async () => {
    await draw(<ModelDraft modelId="m/two" windowTokens={400_000} loopControl={{ autoCompact: '85%' }} />);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-token-presets="model:m/two"] [data-token-preset="200000"]')!.click(); });
    expect(readoutOf('m/two').textContent).toBe('200k50%');
    expect(pointInputOf('m/two').value).toBe('200k');
    // Inside the movable range the two agree exactly.
    await type(pointInputOf('m/two'), '450k');
    expect(pointInputOf('m/two').value).toBe('450k');
    expect(container.textContent).toContain('Above limit minus reserve; it will apply as 350k.');
    // The number on the right, and the thumb, are the point the engine applies.
    expect(readoutOf('m/two').textContent).toBe('350k87.5%');
    expect(readoutOf('m/two').getAttribute('title')).toBe('Above limit minus reserve; it will apply as 350k.');
    expect(sliderOf('m/two')!.value).toBe('350000');
    // Emptying the field returns the row to the inherited default.
    await type(pointInputOf('m/two'), '');
    expect(pointInputOf('m/two').value).toBe('');
    expect(readoutOf('m/two').textContent).toBe('340k85%');
    expect(sliderOf('m/two')!.value).toBe('340000');
  });

  it('steps once per key from an off-grid inherited point instead of jumping', async () => {
    await draw(<ModelDraft modelId="m/offgrid" windowTokens={400_000} loopControl={{ autoCompact: '85%' }} />);
    const press = async (key: string) => {
      await act(async () => { sliderOf('m/offgrid')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
    };
    expect(sliderOf('m/offgrid')!.value).toBe('340000');
    await press('ArrowRight');
    expect(sliderOf('m/offgrid')!.value).toBe('348000');
    expect(readoutOf('m/offgrid').textContent).toBe('348k87%');
    // The next step would pass the ceiling, so it stops on it.
    await press('ArrowRight');
    expect(sliderOf('m/offgrid')!.value).toBe('350000');
    await press('ArrowLeft');
    expect(sliderOf('m/offgrid')!.value).toBe('342000');
    await press('Home');
    expect(sliderOf('m/offgrid')!.value).toBe('64000');
    await press('End');
    expect(sliderOf('m/offgrid')!.value).toBe('350000');
  });

  it('steps with the keyboard and reaches both real endpoints', async () => {
    await draw(<ModelDraft modelId="m/keys" windowTokens={400_000} loopControl={{}} initial={200_000} />);
    const press = async (key: string) => {
      await act(async () => { sliderOf('m/keys')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
    };
    await press('ArrowRight');
    expect(sliderOf('m/keys')!.value).toBe('208000');
    await press('ArrowLeft');
    await press('ArrowLeft');
    expect(sliderOf('m/keys')!.value).toBe('192000');
    await press('PageUp');
    expect(sliderOf('m/keys')!.value).toBe('216000');
    await press('End');
    expect(sliderOf('m/keys')!.value).toBe('350000');
    await press('Home');
    expect(sliderOf('m/keys')!.value).toBe('64000');
    expect(readoutOf('m/keys').textContent).toBe('64k16%');
  });

  it('keeps a real but unmovable control disabled, and draws nothing without a scale', async () => {
    // A 32.7k window under a 50k reserve has a negative ceiling: no scale, so
    // the track stays a hairline instead of painting negative space.
    await draw(<ModelDraft modelId="m/tiny" windowTokens={32_768} loopControl={{}} />);
    expect(sliderOf('m/tiny')).toBeNull();
    expect(trackOf('m/tiny')!.querySelector('[data-compact-track-fill]')).toBeNull();
    expect(trackOf('m/tiny')!.querySelector('[data-compact-thumb]')).toBeNull();
    expect(readoutOf('m/tiny').textContent).toBe('27.9k');
    expect(reasonText()).toBe('No room to adjust in this window.');

    // With the global percentage the same clamp lands below zero: the field
    // promises no default at all rather than printing a negative one.
    await draw(<ModelDraft modelId="m/tiny-global" windowTokens={32_768} loopControl={{ autoCompact: '85%' }} />);
    expect(pointInputOf('m/tiny-global').placeholder).toBe('');
    expect(readoutOf('m/tiny-global').textContent).toBe('—');
    expect(container.textContent).not.toContain('Leave empty');
    expect(reasonText()).toBe('No room to adjust in this window.');

    // 10k of ceiling left is a real scale with a single position: a genuinely
    // disabled control next to the reason.
    await draw(<ModelDraft modelId="m/flat" windowTokens={60_000} loopControl={{}} />);
    const flat = sliderOf('m/flat')!;
    expect(flat.disabled).toBe(true);
    expect(flat.min).toBe('10000');
    expect(flat.max).toBe('10000');
    expect(flat.getAttribute('aria-describedby')).not.toBeNull();
    expect(reasonText()).toBe('No room to adjust in this window.');

    await draw(<ModelDraft modelId="m/none" windowTokens={0} loopControl={{}} />);
    expect(sliderOf('m/none')).toBeNull();
    expect(readoutOf('m/none').textContent).toBe('—');
    expect(reasonText()).toBe('Set the context window first.');
  });

  it('counts a context budget and a window override as the effective window', async () => {
    await draw(<ModelDraft modelId="m/budget" windowTokens={400_000} contextBudget={300_000} loopControl={{ autoCompact: '85%' }} />);
    expect(readoutOf('m/budget').textContent).toBe('250k83.3%');
    expect(sliderOf('m/budget')!.max).toBe('250000');

    await draw(<ModelDraft modelId="m/override-window" windowTokens={400_000} inputTokens={529_400} overrides={{ max_context_size: 200_000 }} loopControl={{ autoCompact: '85%' }} />);
    expect(readoutOf('m/override-window').textContent).toBe('150k75%');
    expect(sliderOf('m/override-window')!.max).toBe('150000');

    // An override replaces the declared budget instead of narrowing it again.
    await draw(<ModelDraft modelId="m/budget-override" windowTokens={400_000} contextBudget={300_000} overrides={{ context_budget: 200_000 }} loopControl={{ autoCompact: '85%' }} />);
    expect(readoutOf('m/budget-override').textContent).toBe('150k75%');
    expect(sliderOf('m/budget-override')!.max).toBe('150000');
  });

  it('marks a model override that sets the point itself, and refuses to fake a broken one', async () => {
    await draw(<ModelDraft modelId="m/pinned" windowTokens={400_000} overrides={'{"auto_compact":300000}'} loopControl={{ autoCompact: '85%' }} />);
    const slider = sliderOf('m/pinned')!;
    expect(readoutOf('m/pinned').textContent).toBe('300k75%');
    expect(readoutOf('m/pinned').getAttribute('title')).toBe('The model override sets this point.');
    expect(slider.disabled).toBe(true);
    expect(reasonText()).toBe('The model override sets this point.');

    // Overrides that cannot be read give no preview at all — never a made-up one.
    await draw(<ModelDraft modelId="m/broken" windowTokens={400_000} overrides={'{'} loopControl={{}} />);
    expect(sliderOf('m/broken')).toBeNull();
    expect(readoutOf('m/broken').textContent).toBe('—');
    expect(reasonText()).toBe('Fix the model overrides to preview this point.');
  });

  it('keeps two models with the same display name on their own drafts', async () => {
    await draw(
      <>
        <ModelDraft modelId="axon-for-test/gpt-6-astra" windowTokens={400_000} inputTokens={529_400} loopControl={{ autoCompact: '85%' }} />
        <ModelDraft modelId="axon/gpt-6-astra" windowTokens={400_000} inputTokens={529_400} loopControl={{ autoCompact: '85%' }} />
      </>,
    );
    await act(async () => { setRange(sliderOf('axon-for-test/gpt-6-astra')!, 160_000); });
    expect(readoutOf('axon-for-test/gpt-6-astra').textContent).toBe('160k40%');
    expect(readoutOf('axon/gpt-6-astra').textContent).toBe('340k85%');
    expect(pointInputOf('axon-for-test/gpt-6-astra').value).toBe('160k');
    expect(pointInputOf('axon/gpt-6-astra').value).toBe('');
    expect(sliderOf('axon/gpt-6-astra')!.value).toBe('340000');
  });
});
