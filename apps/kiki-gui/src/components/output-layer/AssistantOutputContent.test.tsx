// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantOutputContent } from './AssistantOutputContent';
import { outputLayerStore } from './outputLayerStore';
import { setActiveOutputLayerClient } from './useOutputLayerClient';
import { OutputLayerClient } from '../../lib/outputLayerClient';
import { I18nProvider } from '../../i18n';
import type { OutputLayerPreset } from './types';

let container: HTMLDivElement;
let root: Root;

const dummyPreset: OutputLayerPreset = {
  id: 'translate',
  label: '流式翻译',
  instruction: '将原文翻译为简体中文',
  modelId: 'test-model',
  contextWindow: 32768,
  maxOutputTokens: 2048,
};

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  outputLayerStore.setConfiguration({
    enabled: true,
    presets: [dummyPreset],
    settings: { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 },
  });

  // Mock clipboard
  Object.assign(navigator, {
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  setActiveOutputLayerClient(null);
});

function renderContent({
  sessionId = 'test-s',
  messageId = 'msg-1',
  sourceText = '这是原始回答文本',
  onReadingTextChange,
}: {
  sessionId?: string;
  messageId?: string;
  sourceText?: string;
  onReadingTextChange?: (text: string) => void;
} = {}) {
  act(() => {
    root.render(
      <I18nProvider>
        <AssistantOutputContent
          sessionId={sessionId}
          messageId={messageId}
          sourceText={sourceText}
          onReadingTextChange={onReadingTextChange}
        />
      </I18nProvider>,
    );
  });
}

describe('AssistantOutputContent', () => {
  it('renders original markdown text directly when no preset is active', () => {
    outputLayerStore.setActivePreset('test-s', null);
    renderContent({ sourceText: '未经处理的原文' });

    expect(container.textContent).toContain('未经处理的原文');
    expect(container.querySelector('[data-output-layer-panel]')).toBeNull();
  });

  it('renders derived chunks when preset is active and in processed view mode', async () => {
    const sessionId = 'test-derived';
    const messageId = 'msg-derived';
    outputLayerStore.setActivePreset(sessionId, 'translate');
    outputLayerStore.setViewMode(sessionId, 'processed');

    const client = new OutputLayerClient(
      {
        configuration: vi.fn().mockResolvedValue({
          enabled: true,
          presets: [dummyPreset],
          settings: { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 },
        }),
        configure: vi.fn(),
        stream: vi.fn(async (input, onEvent) => {
          onEvent({ type: 'started', cycleId: input.cycleId, historyReset: false, contextWindow: 32768, inputTokensEstimate: 10 });
          onEvent({ type: 'completed', text: '你好，世界' });
        }),
      },
    );
    await client.process(
      {
        sessionId,
        sourceId: `${messageId}:0`,
        sourceRevision: '1',
        text: 'Hello world',
      },
      dummyPreset,
      { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 },
      () => {},
    );
    setActiveOutputLayerClient(client);

    renderContent({
      sessionId,
      messageId,
      sourceText: 'Hello world',
    });

    // Content should show the translated text and the status banner
    expect(container.textContent).toContain('流式翻译');
    expect(container.textContent).toContain('处理版');
    expect(container.textContent).toContain('你好，世界');
    expect(container.textContent).toContain('查看原文');
    expect(container.textContent).toContain('复制原文');
  });

  it('switches to original text when user clicks 查看原文', async () => {
    const sessionId = 'test-switch';
    const messageId = 'msg-switch';
    outputLayerStore.setActivePreset(sessionId, 'translate');
    outputLayerStore.setViewMode(sessionId, 'processed');

    const client = new OutputLayerClient(
      {
        configuration: vi.fn().mockResolvedValue({
          enabled: true,
          presets: [dummyPreset],
          settings: { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 },
        }),
        configure: vi.fn(),
        stream: vi.fn(async (input, onEvent) => {
          onEvent({ type: 'started', cycleId: input.cycleId, historyReset: false, contextWindow: 32768, inputTokensEstimate: 10 });
          onEvent({ type: 'completed', text: '你好，世界' });
        }),
      },
    );
    await client.process(
      {
        sessionId,
        sourceId: `${messageId}:0`,
        sourceRevision: '1',
        text: 'Hello world',
      },
      dummyPreset,
      { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 },
      () => {},
    );
    setActiveOutputLayerClient(client);


    renderContent({
      sessionId,
      messageId,
      sourceText: 'Hello world',
    });

    // Click "查看原文"
    const switchButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('查看原文'),
    );
    expect(switchButton).toBeDefined();

    act(() => {
      switchButton?.click();
    });

    expect(outputLayerStore.getSessionState(sessionId).viewMode).toBe('original');
    expect(container.textContent).toContain('Hello world');
    expect(container.textContent).toContain('查看处理版');
  });

  it('copies original text when user clicks 复制原文', async () => {
    const sessionId = 'test-copy';
    const messageId = 'msg-copy';
    outputLayerStore.setActivePreset(sessionId, 'translate');

    renderContent({
      sessionId,
      messageId,
      sourceText: '原始复制内容',
    });

    const copyOriginalButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('复制原文'),
    );
    expect(copyOriginalButton).toBeDefined();

    await act(async () => {
      copyOriginalButton?.click();
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('原始复制内容');
  });

  it('shows error banner on stream failure and allows retry', async () => {
    const sessionId = 'test-err';
    const messageId = 'msg-err';
    outputLayerStore.setActivePreset(sessionId, 'translate');
    outputLayerStore.setViewMode(sessionId, 'processed');

    let streamAttempt = 0;
    const client = new OutputLayerClient({
      configuration: vi.fn().mockResolvedValue({
        enabled: true,
        presets: [dummyPreset],
        settings: { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 },
      }),
      configure: vi.fn(),
      stream: vi.fn(async (input, onEvent) => {
        streamAttempt += 1;
        if (streamAttempt === 1) {
          onEvent({ type: 'failed', message: '连接超时，无法生成' });
        } else {
          onEvent({ type: 'started', cycleId: input.cycleId, historyReset: false, contextWindow: 32768, inputTokensEstimate: 10 });
          onEvent({ type: 'completed', text: '重试成功' });
        }
      }),
    });
    setActiveOutputLayerClient(client);

    renderContent({
      sessionId,
      messageId,
      sourceText: '待重试文本',
    });

    // Wait for the failed state
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(container.textContent).toContain('处理失败：连接超时，无法生成');
    const retryBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('重试'),
    );
    expect(retryBtn).toBeDefined();

    // Click retry
    await act(async () => {
      retryBtn?.click();
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(container.textContent).toContain('重试成功');
  });

  it('handles streaming tail without scheduling it until stream ends', async () => {
    const sessionId = 'test-stream-tail';
    const messageId = 'msg-stream-tail';
    outputLayerStore.setActivePreset(sessionId, 'translate');
    outputLayerStore.setViewMode(sessionId, 'processed');

    const streamFn = vi.fn(async (input: any, onEvent: any) => {
      onEvent({ type: 'started', cycleId: input.cycleId, historyReset: false, contextWindow: 32768, inputTokensEstimate: 10 });
      onEvent({ type: 'completed', text: '译文' });
    });
    const client = new OutputLayerClient({
      configuration: vi.fn().mockResolvedValue({
        enabled: true,
        presets: [dummyPreset],
        settings: { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 },
      }),
      configure: vi.fn(),
      stream: streamFn,
    });
    setActiveOutputLayerClient(client);

    // Initial render with isStreamingSource = true (a single chunk is the tail)
    act(() => {
      root.render(
        <I18nProvider>
          <AssistantOutputContent
            sessionId={sessionId}
            messageId={messageId}
            sourceText="这是流式中的文本..."
            isStreamingSource={true}
          />
        </I18nProvider>,
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    // Tail should NOT have been scheduled for translation yet
    expect(streamFn).not.toHaveBeenCalled();
    expect(container.textContent).toContain('这是流式中的文本...');

    // Now streaming finishes: isStreamingSource = false
    act(() => {
      root.render(
        <I18nProvider>
          <AssistantOutputContent
            sessionId={sessionId}
            messageId={messageId}
            sourceText="这是流式中的文本..."
            isStreamingSource={false}
          />
        </I18nProvider>,
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Now tail was flushed and processed
    expect(streamFn).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('译文');
  });

  it('requests stable chunks while source is streaming, delays tail, and flushes tail without repeating stable chunks', async () => {
    const sessionId = 'stream-multi-chunks';
    const messageId = 'msg-multi-chunks';
    outputLayerStore.setConfiguration({
      enabled: true,
      presets: [dummyPreset],
      settings: { groupChars: 80, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 },
    });
    outputLayerStore.setActivePreset(sessionId, 'translate');

    const requestedChunks: number[] = [];
    const streamFn = vi.fn().mockImplementation((req, onEvent) => {
      const match = req.sourceId.match(/:(\d+)$/);
      if (match) requestedChunks.push(Number(match[1]));
      onEvent({ type: 'started', cycleId: 'c1', historyReset: false, contextWindow: 32768, inputTokensEstimate: 100 });
      onEvent({ type: 'delta', text: `译文段落-${match ? match[1] : '0'}` });
      onEvent({ type: 'completed', text: `译文段落-${match ? match[1] : '0'}` });
    });

    const client = new OutputLayerClient({
      configuration: vi.fn().mockResolvedValue({
        enabled: true,
        presets: [dummyPreset],
        settings: { groupChars: 80, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 },
      }),
      configure: vi.fn(),
      stream: streamFn,
    });
    setActiveOutputLayerClient(client);

    const p1 = '第一段已稳定的文字，内容足够长，足以形成一个独立完整的句段。'.repeat(2);
    const p2 = '第二段正在流式生成的尾段文字，尚未稳定。';
    const streamingText = `${p1}\n\n${p2}`;

    // 1. Initial render with isStreamingSource = true
    act(() => {
      root.render(
        <I18nProvider>
          <AssistantOutputContent
            sessionId={sessionId}
            messageId={messageId}
            sourceText={streamingText}
            isStreamingSource={true}
          />
        </I18nProvider>,
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Chunk 0 (stable) should be requested; Chunk 1 (tail) should NOT be requested
    expect(requestedChunks).toContain(0);
    expect(requestedChunks).not.toContain(1);
    expect(streamFn).toHaveBeenCalledTimes(1);

    // 2. Stream completes: isStreamingSource = false
    act(() => {
      root.render(
        <I18nProvider>
          <AssistantOutputContent
            sessionId={sessionId}
            messageId={messageId}
            sourceText={streamingText}
            isStreamingSource={false}
          />
        </I18nProvider>,
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    // Now tail is flushed and processed; stable chunk 0 is NOT re-requested
    expect(requestedChunks).toEqual([0, 1]);
    expect(streamFn).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, '', '   '])('does not trigger process/stream and keeps original text & copy with empty model %s', async (modelId) => {
    const unconfiguredPreset: OutputLayerPreset = {
      id: 'unconfigured',
      label: '未配置预设',
      modelId,
      instruction: '翻译',
      contextWindow: 32768,
    };
    outputLayerStore.setConfiguration({
      enabled: true,
      presets: [unconfiguredPreset],
      settings: { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 },
    });

    const sessionId = 'test-empty-model';
    const messageId = 'msg-empty-model';
    outputLayerStore.setActivePreset(sessionId, 'unconfigured');
    outputLayerStore.setViewMode(sessionId, 'processed');

    const processFn = vi.fn();
    const streamFn = vi.fn();
    const client = new OutputLayerClient({
      configuration: vi.fn().mockResolvedValue({
        enabled: true,
        presets: [unconfiguredPreset],
        settings: { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 },
      }),
      configure: vi.fn(),
      stream: streamFn,
    });
    client.process = processFn;
    setActiveOutputLayerClient(client);

    const onReadingTextChange = vi.fn();
    renderContent({
      sessionId,
      messageId,
      sourceText: '原始文本不应触发处理',
      onReadingTextChange,
    });

    // Zero backend requests
    expect(processFn).not.toHaveBeenCalled();
    expect(streamFn).not.toHaveBeenCalled();

    // UI maintains original text and displays unconfigured status
    expect(container.textContent).toContain('未配置预设');
    expect(container.textContent).toContain('未配置处理模型（显示原文）');
    expect(container.textContent).toContain('原始文本不应触发处理');
    expect(container.textContent).toContain('配置模型');
    expect(container.textContent).toContain('复制原文');
    expect(onReadingTextChange).toHaveBeenCalledWith('原始文本不应触发处理');

    // Click copy original
    const copyBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('复制原文'),
    );
    expect(copyBtn).toBeDefined();
    await act(async () => {
      copyBtn?.click();
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('原始文本不应触发处理');
  });
});
