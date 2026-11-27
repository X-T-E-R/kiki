import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useOutputLayer } from './outputLayerStore';
import { chunkText, type TextChunk } from './viewportChunker';
import { useChunkViewportScheduler } from './useViewportScheduler';
import { useOutputLayerClient, getActiveOutputLayerClient } from './useOutputLayerClient';
import { Markdown } from '../Markdown';
import { Icon } from '../icons';
import type { TimelineAnnotation } from '@kiki/session-core/composer';
import {
  outputLayerViewportIndices,
  hasConfiguredModel,
  type OutputLayerPreset,
  type OutputLayerSettings,
  type OutputLayerSource,
  type OutputLayerResult,
} from './types';
import { lazyComponent } from '../../lib/lazyComponent';

const LazyOutputPresetModal = lazyComponent(() =>
  import('./OutputPresetModal').then((m) => m.OutputPresetModal),
);

if (import.meta.env.MODE === 'test') {
  await LazyOutputPresetModal.preload();
}

function ChunkRenderer({
  sessionId,
  messageId,
  chunk,
  totalChunks,
  preset,
  settings,
  isVisible,
  isScheduled,
  isTailStreaming,
  onResultChange,
}: {
  sessionId?: string;
  messageId: string;
  chunk: TextChunk;
  totalChunks: number;
  preset: OutputLayerPreset;
  settings: OutputLayerSettings;
  isVisible: boolean;
  isScheduled: boolean;
  isTailStreaming: boolean;
  onResultChange?: (chunkIndex: number, text: string) => void;
}) {
  const currentSessionId = sessionId ?? '__global__';
  const client = useOutputLayerClient(sessionId) ?? getActiveOutputLayerClient();
  const sourceId = `${messageId}:${chunk.index}`;

  const source: OutputLayerSource = useMemo(
    () => ({
      sessionId: currentSessionId,
      sourceId,
      sourceRevision: '1',
      text: chunk.text,
    }),
    [currentSessionId, sourceId, chunk.text],
  );

  const binding = useMemo(() => ({ source, preset, settings, client }), [source, preset, settings, client]);
  const currentBinding = useRef<typeof binding | null>(binding);
  currentBinding.current = binding;
  const [readingResult, setReadingResult] = useState(() => ({
    binding,
    result: client?.get(source, preset, settings),
  }));
  const result = readingResult.binding === binding
    ? readingResult.result
    : client?.get(source, preset, settings);
  const setResult = useCallback((update: OutputLayerResult | undefined) => {
    if (currentBinding.current === binding) setReadingResult({ binding, result: update });
  }, [binding]);

  useEffect(() => {
    const text = isTailStreaming ? chunk.text
      : result?.status === 'completed' ? result.output
      : result?.status === 'streaming' ? result.output || chunk.text
      : chunk.text;
    onResultChange?.(chunk.index, text);
  }, [chunk.index, chunk.text, result?.status, result?.output, isTailStreaming, onResultChange]);

  const prevTextRef = useRef(chunk.text);
  useEffect(() => {
    if (prevTextRef.current !== chunk.text) {
      prevTextRef.current = chunk.text;
      client?.invalidateSource(currentSessionId, sourceId);
      setResult(client?.get(source, preset, settings));
    }
  }, [chunk.text, currentSessionId, sourceId, client, source, preset, settings, setResult]);

  useEffect(() => {
    setResult(client?.get(source, preset, settings));
  }, [preset, settings, client, source, setResult]);

  const shouldSchedule =
    isScheduled && !isTailStreaming && result?.status !== 'completed';

  const { retry, cancel } = useChunkViewportScheduler({
    sessionId: currentSessionId,
    messageId,
    chunkIndex: chunk.index,
    totalChunks,
    chunkText: chunk.text,
    preset,
    settings,
    isIntersecting: shouldSchedule,
    enabled: shouldSchedule,
    priority: isVisible ? 100 : 50,
    onUpdate: setResult,
  });

  useEffect(() => {
    currentBinding.current = binding;
    return () => {
      if (currentBinding.current === binding) currentBinding.current = null;
      cancel();
      client?.cancel(currentSessionId, sourceId);
    };
  }, [binding, cancel, client, currentSessionId, sourceId]);

  if (isTailStreaming) {
    return (
      <div className="relative my-0.5">
        <Markdown text={chunk.text} />
        <span className="stream-caret font-mono">▍</span>
      </div>
    );
  }

  if (result?.status === 'failed') {
    return (
      <div className="my-1.5 rounded border border-danger/30 bg-danger/5 p-2 text-[12px] text-danger">
        <div className="flex items-center justify-between">
          <span>处理失败：{result.error ?? '未知错误'}</span>
          <button
            type="button"
            onClick={retry}
            className="flex items-center gap-1 rounded bg-danger/10 px-2 py-0.5 font-normal hover:bg-danger/20"
          >
            <Icon name="refresh" size={12} />
            重试
          </button>
        </div>
      </div>
    );
  }

  if (result?.status === 'streaming') {
    return (
      <div className="relative my-0.5">
        <Markdown text={result.output || chunk.text} />
        <span className="stream-caret font-mono">▍</span>
      </div>
    );
  }

  if (result?.status === 'completed') {
    return (
      <div className="relative my-0.5">
        <Markdown text={result.output} />
      </div>
    );
  }

  if (result?.status === 'queued') {
    return (
      <div className="my-1.5 flex items-center gap-2 rounded bg-paper/40 px-2 py-1 text-[12px] text-ink-faint">
        <span className="stream-caret font-mono">▍</span>
        <span>正在等待处理 (第 {chunk.index + 1}/{totalChunks} 段)...</span>
      </div>
    );
  }

  return (
    <div className="relative my-0.5 opacity-90">
      <Markdown text={chunk.text} />
    </div>
  );
}

export function AssistantOutputProcessor({
  messageId,
  sessionId,
  sourceText,
  isStreamingSource = false,
  annotations,
  onReadingTextChange,
}: {
  messageId: string;
  sessionId?: string;
  sourceText: string;
  isStreamingSource?: boolean;
  annotations?: readonly TimelineAnnotation[];
  onReadingTextChange?: (text: string) => void;
}) {
  const { contextKey, isProcessingEnabled, isPluginEnabled, activePreset, settings, viewMode, setViewMode } =
    useOutputLayer(sessionId);
  const [copiedOriginal, setCopiedOriginal] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  const groupChars = settings?.groupChars ?? 600;
  const chunks = useMemo(() => {
    if (!isProcessingEnabled || !activePreset) return [];
    return chunkText(sourceText, groupChars);
  }, [sourceText, isProcessingEnabled, activePreset, groupChars]);

  const chunkElementsRef = useRef<Map<number, HTMLElement>>(new Map());
  const visibleIndicesRef = useRef<Set<number>>(new Set());
  const [visibleRange, setVisibleRange] = useState<[number, number]>([-1, -1]);

  const registerChunkElement = useCallback(
    (index: number, element: HTMLElement | null) => {
      if (element) {
        chunkElementsRef.current.set(index, element);
      } else {
        chunkElementsRef.current.delete(index);
        visibleIndicesRef.current.delete(index);
      }
    },
    [],
  );

  useEffect(() => {
    if (!isProcessingEnabled || chunks.length === 0 || typeof IntersectionObserver === 'undefined') {
      if (chunks.length > 0) setVisibleRange([0, chunks.length - 1]);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const indexAttr = entry.target.getAttribute('data-chunk-index');
          if (indexAttr === null) continue;
          const index = Number(indexAttr);
          if (entry.isIntersecting) {
            if (!visibleIndicesRef.current.has(index)) {
              visibleIndicesRef.current.add(index);
              changed = true;
            }
          } else if (visibleIndicesRef.current.has(index)) {
            visibleIndicesRef.current.delete(index);
            changed = true;
          }
        }

        if (changed) {
          if (visibleIndicesRef.current.size === 0) {
            setVisibleRange([-1, -1]);
          } else {
            const arr = Array.from(visibleIndicesRef.current);
            setVisibleRange([Math.min(...arr), Math.max(...arr)]);
          }
        }
      },
      { threshold: 0.05 },
    );

    for (const el of chunkElementsRef.current.values()) {
      observer.observe(el);
    }

    return () => {
      observer.disconnect();
    };
  }, [chunks, isProcessingEnabled]);

  const scheduledIndices = useMemo(() => {
    if (visibleRange[0] < 0 || visibleRange[1] < 0 || chunks.length === 0) {
      return [];
    }
    const rawIndices = outputLayerViewportIndices(
      visibleRange[0],
      visibleRange[1],
      chunks.length,
      settings,
    );

    if (isStreamingSource) {
      return rawIndices.filter((idx) => idx < chunks.length - 1);
    }
    return rawIndices;
  }, [visibleRange, chunks.length, settings, isStreamingSource]);

  const chunkTexts = useMemo(() => new Map<number, string>(), [chunks, contextKey, messageId, settings]);
  const currentChunkTexts = useRef(chunkTexts);
  currentChunkTexts.current = chunkTexts;
  const publishReadingText = useCallback(() => {
    const text = !isProcessingEnabled || viewMode === 'original' || chunks.length === 0
      ? sourceText
      : chunks.map((chunk) => chunkTexts.get(chunk.index) ?? chunk.text).join('\n\n').trim();
    onReadingTextChange?.(text);
  }, [isProcessingEnabled, viewMode, chunks, chunkTexts, sourceText, onReadingTextChange]);
  const handleChunkResultChange = useCallback((chunkIndex: number, text: string) => {
    if (currentChunkTexts.current !== chunkTexts) return;
    chunkTexts.set(chunkIndex, text);
    publishReadingText();
  }, [chunkTexts, publishReadingText]);

  useEffect(publishReadingText, [publishReadingText]);

  const handleCopyOriginal = async () => {
    try {
      await navigator.clipboard.writeText(sourceText);
      setCopiedOriginal(true);
      setTimeout(() => setCopiedOriginal(false), 2000);
    } catch {
      // Fallback
    }
  };

  if (!isPluginEnabled || !activePreset) {
    return (
      <div className="kiki-prose min-w-0">
        <Markdown text={sourceText} sourceBlockId={messageId} annotationTargets={annotations} />
      </div>
    );
  }

  if (!hasConfiguredModel(activePreset)) {
    return (
      <div className="group/output-layer min-w-0" data-output-layer-unconfigured>
        <div className="mb-1 flex items-center justify-between border-b border-hairline/60 pb-1 text-[11.5px] text-ink-faint">
          <div className="flex items-center gap-1.5">
            <span className="flex h-3.5 w-3.5 items-center justify-center text-accent">
              <Icon name="sliders" size={12} />
            </span>
            <span className="font-normal text-ink-soft">{activePreset.label}</span>
            <span className="text-ink-faint/60">·</span>
            <span>未配置处理模型（显示原文）</span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="rounded px-1.5 py-0.5 text-[11px] font-normal text-accent hover:bg-accent/10"
            >
              配置模型
            </button>
            <button
              type="button"
              onClick={() => { void handleCopyOriginal(); }}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-normal text-ink-soft hover:bg-ink/[0.04] hover:text-ink"
              title="复制主模型原始文字"
            >
              <Icon
                name={copiedOriginal ? 'check' : 'copy'}
                size={12}
                className={copiedOriginal ? 'text-accent' : ''}
              />
              <span>{copiedOriginal ? '已复制原文' : '复制原文'}</span>
            </button>
          </div>
        </div>

        <div className="kiki-prose min-w-0">
          <Markdown text={sourceText} sourceBlockId={messageId} annotationTargets={annotations} />
        </div>

        {modalOpen ? (
          <LazyOutputPresetModal
            preset={activePreset}
            open={modalOpen}
            sessionId={sessionId}
            onClose={() => setModalOpen(false)}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="group/output-layer min-w-0">
      <div className="mb-1 flex items-center justify-between border-b border-hairline/60 pb-1 text-[11.5px] text-ink-faint">
        <div className="flex items-center gap-1.5">
          <span className="flex h-3.5 w-3.5 items-center justify-center text-accent">
            <Icon name="sliders" size={12} />
          </span>
          <span className="font-normal text-ink-soft">{activePreset.label}</span>
          <span className="text-ink-faint/60">·</span>
          <span>{viewMode === 'processed' ? '处理版' : '原文'}</span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setViewMode(viewMode === 'processed' ? 'original' : 'processed')}
            className="rounded px-1.5 py-0.5 text-[11px] font-normal text-ink-soft hover:bg-ink/[0.04] hover:text-ink"
          >
            {viewMode === 'processed' ? '查看原文' : '查看处理版'}
          </button>

          <button
            type="button"
            onClick={() => { void handleCopyOriginal(); }}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-normal text-ink-soft hover:bg-ink/[0.04] hover:text-ink"
            title="复制主模型原始文字"
          >
            <Icon
              name={copiedOriginal ? 'check' : 'copy'}
              size={12}
              className={copiedOriginal ? 'text-accent' : ''}
            />
            <span>{copiedOriginal ? '已复制原文' : '复制原文'}</span>
          </button>
        </div>
      </div>

      <div className="kiki-prose min-w-0">
        {viewMode === 'original' ? (
          <Markdown text={sourceText} sourceBlockId={messageId} annotationTargets={annotations} />
        ) : (
          <div className="space-y-1">
            {chunks.map((chunk) => {
              const isVisible =
                visibleRange[0] >= 0 &&
                chunk.index >= visibleRange[0] &&
                chunk.index <= visibleRange[1];
              const isScheduled = scheduledIndices.includes(chunk.index);
              const isTailStreaming =
                isStreamingSource && chunk.index === chunks.length - 1;

              return (
                <div
                  key={`${messageId}-${chunk.index}`}
                  ref={(el) => registerChunkElement(chunk.index, el)}
                  data-chunk-index={chunk.index}
                >
                  <ChunkRenderer
                    sessionId={sessionId}
                    messageId={messageId}
                    chunk={chunk}
                    totalChunks={chunks.length}
                    preset={activePreset}
                    settings={settings}
                    isVisible={isVisible}
                    isScheduled={isScheduled}
                    isTailStreaming={isTailStreaming}
                    onResultChange={handleChunkResultChange}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
