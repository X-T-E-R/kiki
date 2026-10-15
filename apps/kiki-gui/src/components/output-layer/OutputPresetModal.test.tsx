// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OutputPresetModal } from './OutputPresetModal';
import { outputLayerStore } from './outputLayerStore';
import { setActiveOutputLayerClient } from './useOutputLayerClient';
import { I18nProvider } from '../../i18n';
import { OUTPUT_LAYER_DEFAULT_PRESETS, OUTPUT_LAYER_DEFAULT_SETTINGS, type OutputLayerConfiguration, type OutputLayerPreset } from './types';

const fixture = vi.hoisted(() => ({ connection: null as any, configuration: vi.fn(), configure: vi.fn() }));
vi.mock('../../state/connection', () => ({ useOptionalConnection: () => fixture.connection, useConnection: () => fixture.connection }));
let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let serverConfiguration: OutputLayerConfiguration;
const savedPreset: OutputLayerPreset = { id: 'saved', label: '我的翻译', instruction: 'My saved instruction', modelId: 'default', contextWindow: 32768 };

beforeEach(() => {
  localStorage.clear();
  setActiveOutputLayerClient(null);
  serverConfiguration = { enabled: true, presets: [savedPreset], templates: [...OUTPUT_LAYER_DEFAULT_PRESETS], settings: { ...OUTPUT_LAYER_DEFAULT_SETTINGS } };
  fixture.configuration.mockReset().mockImplementation(async () => serverConfiguration);
  fixture.configure.mockReset().mockImplementation(async (input) => {
    serverConfiguration = { ...serverConfiguration, ...input };
    return serverConfiguration;
  });
  fixture.connection = { spaceKey: 'modal-scope', meta: { server_id: 'modal-server' }, client: {
    listModels: vi.fn().mockResolvedValue({ items: [] }),
    listProviders: vi.fn().mockResolvedValue({ items: [{ id: 'existing', type: 'openai' }] }),
    rest: { outputLayer: { configuration: fixture.configuration, configure: fixture.configure, stream: vi.fn() } },
  } };
  outputLayerStore.setConfiguration(serverConfiguration, 'modal-scope:modal-server:__all__');
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); queryClient.clear(); setActiveOutputLayerClient(null); });

async function renderModal(props: Partial<Parameters<typeof OutputPresetModal>[0]> = {}) {
  const onClose = props.onClose ?? vi.fn();
  const onSaved = props.onSaved ?? vi.fn();
  await act(async () => root.render(<QueryClientProvider client={queryClient}><I18nProvider>
    <OutputPresetModal key={`${props.sessionId ?? ''}:${props.preset?.id ?? 'new'}`} open onClose={onClose} onSaved={onSaved} {...props} />
  </I18nProvider></QueryClientProvider>));
  return { onClose, onSaved };
}
function button(text: string) {
  const found = Array.from(document.body.querySelectorAll('button')).find(item => item.textContent?.includes(text));
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}
async function change(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function save() { await act(async () => button('保存预设').click()); }
async function budgetInput() {
  await act(async () => button('高级参数').click());
  return document.body.querySelector<HTMLInputElement>('input[placeholder="不限制"]')!;
}

describe('OutputPresetModal', () => {
  it('uses all six installed templates and saves a new unconfigured preset without replacing saved edits', async () => {
    const { onSaved, onClose } = await renderModal();
    const picker = document.body.querySelector<HTMLSelectElement>('select[aria-label="内置模板"]')!;
    expect(Array.from(picker.options).map(option => option.value)).toEqual(OUTPUT_LAYER_DEFAULT_PRESETS.map(template => template.id));
    expect(document.body.textContent).toContain('未选择模型 (保持原文，不触发处理)');
    expect((await budgetInput()).value).toBe('');
    await change(picker, 'translate-en');
    const template = OUTPUT_LAYER_DEFAULT_PRESETS.find(item => item.id === 'translate-en')!;
    expect(document.body.querySelector('textarea')!.value).toBe(template.instruction);
    await save();
    const added = serverConfiguration.presets[1]!;
    expect(onSaved).toHaveBeenCalledWith(added);
    expect(added).toMatchObject({ label: template.label, instruction: template.instruction, modelId: undefined, maxOutputTokens: undefined });
    expect(added.id).not.toBe(template.id);
    expect(serverConfiguration.presets).toEqual([savedPreset, added]);
    expect(onClose).toHaveBeenCalledTimes(1);
    await renderModal({ preset: added });
    expect(document.body.querySelector('select[aria-label="内置模板"]')).toBeNull();
    await change(document.body.querySelector('textarea')!, 'Edited English translation');
    await save();
    expect(serverConfiguration.presets).toHaveLength(2);
    expect(serverConfiguration.presets[0]).toEqual(savedPreset);
    expect(serverConfiguration.presets[1]).toMatchObject({ id: added.id, instruction: 'Edited English translation' });
  });

  it('preserves an opaque catalog ID named default and an explicit output cap without clamping', async () => {
    const { onSaved } = await renderModal({ preset: { ...savedPreset, maxOutputTokens: 2097152 } });
    expect((await budgetInput()).value).toBe('2097152');
    await save();
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'default', maxOutputTokens: 2097152 }));
  });

  it('rejects nonpositive, fractional and nonfinite caps while keeping the draft, and reads scientific notation numerically', async () => {
    const { onSaved, onClose } = await renderModal();
    const input = await budgetInput();
    for (const value of ['0', '-1', '1.5', '1e-3', '1e309']) {
      await change(input, value);
      await save();
      expect(document.body.textContent).toContain('输出上限必须是正整数');
      expect(input.value).toBe(value);
      expect(fixture.configure).not.toHaveBeenCalled();
      expect(onSaved).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
    }
    await change(input, '1e3'); await save();
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 1000 }));
  });

  it('allows an empty custom pair but rejects either half without clearing the selected field', async () => {
    const { onSaved } = await renderModal({ preset: { ...savedPreset, modelId: undefined, connectionId: 'existing' } });
    const picker = document.body.querySelector<HTMLSelectElement>('select:not([aria-label])')!;
    const custom = document.body.querySelector<HTMLInputElement>('input[placeholder^="输入自定义模型"]')!;
    await save();
    expect(document.body.textContent).toContain('自定义模型需要同时选择已有连接并填写模型 ID');
    expect(picker.value).toBe('existing'); expect(fixture.configure).not.toHaveBeenCalled();
    await change(picker, ''); await change(custom, 'remote/model'); await save();
    expect(custom.value).toBe('remote/model'); expect(fixture.configure).not.toHaveBeenCalled();
    await change(custom, ''); await save();
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ modelId: undefined, connectionId: undefined, customModelId: undefined }));
  });

  it('saves a complete custom binding and history zero', async () => {
    const { onSaved } = await renderModal({ preset: { ...savedPreset, modelId: undefined, connectionId: 'existing', customModelId: 'remote/model' } });
    await budgetInput();
    const history = document.body.querySelector<HTMLInputElement>('input[type="number"][value="16384"]')!;
    await change(history, '0'); await save();
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'existing', customModelId: 'remote/model' }));
    expect(serverConfiguration.settings.historyTokens).toBe(0);
  });

  it('keeps the modal and draft on a rejected save', async () => {
    const { onSaved, onClose } = await renderModal();
    fixture.configure.mockRejectedValueOnce(new Error('网络连接超时，请重试'));
    await save();
    expect(document.body.textContent).toContain('网络连接超时，请重试');
    expect(onSaved).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
    expect(document.body.querySelector('textarea')!.value).toBe(OUTPUT_LAYER_DEFAULT_PRESETS.find(item => item.id === 'custom')!.instruction);
  });

  it('deletes an existing preset through persistence', async () => {
    const { onClose } = await renderModal({ preset: savedPreset });
    await act(async () => button('删除预设').click());
    expect(serverConfiguration.presets).toEqual([]); expect(onClose).toHaveBeenCalled();
  });

  it('does not let a late save select or close a new connection context', async () => {
    let resolve!: (value: OutputLayerConfiguration) => void;
    fixture.configure.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const callbacks = await renderModal();
    await act(async () => button('保存预设').click());
    fixture.connection = { ...fixture.connection, spaceKey: 'different-home' };
    await renderModal(callbacks);
    const nextConfiguration = outputLayerStore.getConfiguration('different-home:modal-server:__all__');
    await act(async () => resolve(serverConfiguration));
    expect(callbacks.onSaved).not.toHaveBeenCalled(); expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(outputLayerStore.getConfiguration('different-home:modal-server:__all__')).toEqual(nextConfiguration);
  });
});
