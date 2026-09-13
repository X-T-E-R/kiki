import type { FetchEnvelope, SearchEnvelope } from '@nb-corp/nb-search';
import { ToolOutputAccumulator } from '#/tool/output-accumulator';
import type { ExecutableToolResult } from '#/tool/toolContract';

export function renderNativeEnvelope(envelope: SearchEnvelope | FetchEnvelope): ExecutableToolResult {
  const builder = new ToolOutputAccumulator();
  builder.write(JSON.stringify(envelope, null, 2));
  const state = 'status' in envelope ? envelope.status : 'state' in envelope ? envelope.state : undefined;
  const result = builder.ok();
  return ['failed', 'timed_out', 'cancelled', 'partial'].includes(state ?? '') ? { ...result, isError: true } : result;
}
