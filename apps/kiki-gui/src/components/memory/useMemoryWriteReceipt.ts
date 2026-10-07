import { useEffect, useState } from 'react';
import type { ToolBlock } from '@kiki/session-core/session';

import { frameContentSource } from '../ContentContinuation';
import { useTranscriptController } from '../transcriptDetail';
import { parseMemoryWriteResult, type MemoryWriteReceipt } from './memoryReceipt';

/** Recover action metadata from the recorded output when a range cannot be parsed inline. */
export function useMemoryWriteReceipt(block: ToolBlock, agentId: string, expanded: boolean) {
  const controller = useTranscriptController();
  const source = frameContentSource(block);
  const refs = controller === undefined || source === undefined ? [] : controller.contentRefsFor(agentId, source).filter(ref => ref.path[0] === 'output');
  const identity = JSON.stringify([agentId, source, refs.map(ref => [ref.path, ref.revision, ref.total])]);
  const [read, setRead] = useState<{ identity: string; receipt?: MemoryWriteReceipt; failed?: boolean }>();
  const [attempt, setAttempt] = useState(0);
  const inline = block.name === 'MemoryWrite' ? parseMemoryWriteResult(block.output) : undefined;
  const cached = read?.identity === identity ? read : undefined;
  const needed = block.name === 'MemoryWrite' && typeof block.output === 'string' && refs.some(ref => controller?.isContentRange(agentId, ref)) && inline === undefined;
  useEffect(() => {
    if (!expanded || !needed || controller === undefined || cached?.receipt !== undefined) return;
    const abort = new AbortController();
    setRead({ identity });
    void controller.copyToolCallField(agentId, block.toolCallId, 'output', abort.signal).then(value => {
      if (abort.signal.aborted) return;
      const receipt = parseMemoryWriteResult(value);
      setRead({ identity, receipt: receipt === undefined ? undefined : { ...receipt, entry: undefined } });
    }, () => { if (!abort.signal.aborted) setRead({ identity, failed: true }); });
    return () => { abort.abort(); };
  }, [controller, identity, expanded, needed, agentId, block.toolCallId, attempt]);
  return { receipt: inline ?? cached?.receipt, failed: cached?.failed === true, retry: () => { setAttempt(value => value + 1); } };
}
