/**
 * AssistantOutputContent — shared display entry for visible Assistant prose
 * (supporting both native Assistant blocks and external client assistant excerpts).
 *
 * Fast path: when no output-layer preset is active, renders Markdown directly
 * without loading the chunk scheduler, output-layer client, or preset toolbar.
 */

import { useEffect } from 'react';
import type { TimelineAnnotation } from '@kiki/session-core/composer';
import { lazyComponent } from '../../lib/lazyComponent';
import { Markdown } from '../Markdown';
import { useMessageViewContext } from '../message/messageViewContext';
import { useOutputLayer } from './outputLayerStore';

const LazyAssistantOutputProcessor = lazyComponent(() =>
  import('./AssistantOutputProcessor').then((m) => m.AssistantOutputProcessor),
);

if (import.meta.env.MODE === 'test') {
  await LazyAssistantOutputProcessor.preload();
}

export function AssistantOutputContent({
  messageId,
  sessionId: explicitSessionId,
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
  const messageContext = useMessageViewContext();
  const sessionId = explicitSessionId ?? messageContext.sessionId;
  const { isPluginEnabled, activePreset } = useOutputLayer(sessionId);
  const active = isPluginEnabled && activePreset !== null;

  useEffect(() => {
    if (!active) {
      onReadingTextChange?.(sourceText);
    }
  }, [active, sourceText, onReadingTextChange]);

  if (!active) {
    return (
      <div className="kiki-prose min-w-0">
        <Markdown text={sourceText} sourceBlockId={messageId} annotationTargets={annotations} />
      </div>
    );
  }

  return (
    <LazyAssistantOutputProcessor
      messageId={messageId}
      sessionId={sessionId}
      sourceText={sourceText}
      isStreamingSource={isStreamingSource}
      annotations={annotations}
      onReadingTextChange={onReadingTextChange}
    />
  );
}
