import type { ReactNode } from 'react';
import type { ToolBlock } from '@kiki/session-core/session';

import { useI18n } from '../../i18n';
import { ContentContinuation, frameContentSource, INPUT_ROOTS, INPUT_TEXT_ROOTS, OUTPUT_ROOTS } from '../ContentContinuation';
import { useTranscriptController } from '../transcriptDetail';
import { toolPayloadIncomplete } from '../toolSemantics';
import { toolRecordCopy } from '../toolRecordCopy';
import { CopyButton } from './ContentCopyButton';
import { LoadedToolText, recordText } from './LoadedToolText';

/** The frame's actual field, with the same reader and copy path on every tool row. */
export function ToolRecordField({ block, agentId, field, children }: {
  block: ToolBlock;
  agentId: string;
  field: 'input' | 'output';
  children?: ReactNode;
}) {
  const { t, locale } = useI18n();
  const controller = useTranscriptController();
  const source = frameContentSource(block);
  const root = field === 'input' && block.args === undefined ? 'inputText' : field;
  const roots = field === 'output' ? OUTPUT_ROOTS : root === 'inputText' ? INPUT_TEXT_ROOTS : INPUT_ROOTS;
  const range = controller !== undefined && source !== undefined && controller.contentRefsFor(agentId, source)
    .some((ref) => ref.path.length === 1 && roots.includes(String(ref.path[0])) && controller.isContentRange(agentId, ref));
  const prepare = controller === undefined || source === undefined ? undefined
    : (signal: AbortSignal) => field === 'output'
      ? controller.copyToolCallField(agentId, block.toolCallId, 'output', signal)
      : controller.copyContentField(agentId, source, [root], signal);
  const text = field === 'output' ? recordText(block.output)
    : block.args !== undefined ? recordText(block.args) : block.argsText || t('tc.noInput');
  const label = t(field === 'input' ? 'tc.input' : 'tc.output');
  const absent = field === 'output' && block.output === undefined;
  return <div data-tool-record-field={field}>
    <div className="mb-1 flex items-center justify-between text-[12px] font-medium text-ink-faint">
      <span>{label}{field === 'output' && block.isError === true ? t('tc.outputError') : ''}</span>
      {absent ? null : <CopyButton label={field === 'input' && prepare === undefined ? `${label} · ${toolRecordCopy('loadedOnly', locale)}` : label} text={text} prepare={prepare} />}
    </div>
    {field === 'output' && toolPayloadIncomplete(block.output) ? <p data-tool-payload-status className="text-[12px] text-ink-faint">{toolRecordCopy('payloadTruncated', locale)}</p> : null}
    {absent ? <p className="text-[12px] text-ink-faint">{toolRecordCopy('notLoaded', locale)}</p>
      : range ? null : children ?? <LoadedToolText copy={false} text={text} />}
    <ContentContinuation source={source} roots={roots} callerAgentId={agentId} label={label} headingPresent className="mt-1" />
  </div>;
}
