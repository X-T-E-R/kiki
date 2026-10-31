import { agentRefsContext, findAgentRefs, textContentSchema, type AgentReference, type AgentRunSource } from '@kiki/protocol';
import { isNativeTarget } from '@kiki/agent-profiles/nativeTarget';
import type { ServicesAccessor } from '#/_base/di/instantiation';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';
import { resolveSubagentTarget } from '#/app/agentProfileCatalog/subagentDispatch';
import { IModelService } from '#/kosong/model/model';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { Error2, ErrorCodes } from '#/errors';

export function prepareAgentReferences(message: ContextMessage, messageId: string, accessor: ServicesAccessor): ContextMessage {
  if (message.role !== 'user' || message.origin?.kind !== 'user') return message;
  const origin = message.origin;
  const prior = origin.agentRefContext;
  let content = [...message.content];
  if (prior !== undefined) content = content.map((part, index) => {
    if (index !== prior.partIndex || part.type !== 'text' || part.text.slice(prior.start, prior.end) !== prior.text) return part;
    const parsed = textContentSchema.shape.presentation.safeParse(part.presentation);
    return { ...part, text: part.text.slice(0, prior.start) + part.text.slice(prior.end),
      presentation: parsed.success ? { spans: parsed.data?.spans.filter(span => span.start !== prior.start || span.end !== prior.end) ?? [] } : undefined };
  });
  const requested = [...new Set(content.flatMap(part => part.type === 'text' ? findAgentRefs(part.text).map(ref => ref.profile) : []))];
  if (requested.length === 0) return { ...message, content, origin: { ...origin, agentRefs: undefined, agentRefContext: undefined } };
  const catalog = accessor.get(ISessionAgentProfileCatalog);
  const caller = accessor.get(IAgentProfileService).data();
  const models = accessor.get(IModelService);
  const delegationAvailable = accessor.get(IAgentToolPolicyService).isToolActive('AgentRun');
  const refs: AgentReference[] = requested.map(profile => {
    const target = resolveSubagentTarget(catalog, caller, { profileName: profile }, models);
    const resolved = target.selection.baseProfile;
    const executor = resolved.executor ?? 'native';
    const engineLabel = executor === 'native' ? 'Kiki' : accessor.get(IAgentExecutorRegistry).get(executor)?.label ?? executor;
    return { refId: `ar:${encodeURIComponent(messageId)}:${encodeURIComponent(profile)}`, profile,
      executor, configuration: isNativeTarget(resolved) ? 'native' : 'profile', label: profile, engine_label: engineLabel };
  });
  const block = `\n\n${agentRefsContext(refs, delegationAvailable)}`;
  let partIndex = content.findLastIndex(part => part.type === 'text');
  if (partIndex < 0) { partIndex = content.length; content.push({ type: 'text', text: '' }); }
  const part = content[partIndex]!;
  if (part.type !== 'text') throw new Error2(ErrorCodes.INTERNAL, 'Agent reference context requires a text part');
  const start = part.text.length;
  const parsed = textContentSchema.shape.presentation.safeParse(part.presentation);
  content[partIndex] = { ...part, text: part.text + block,
    presentation: { spans: [...(parsed.success ? parsed.data?.spans ?? [] : []), { start, end: start + block.length, kind: 'context' }] } };
  return { ...message, content, origin: { ...origin, agentRefs: refs,
    agentRefContext: { partIndex, start, end: start + block.length, text: block } } };
}

export function resolveAgentRunSource(
  messages: readonly ContextMessage[],
  profile: string,
  executor: string,
  configuration: AgentReference['configuration'],
  sourceRef?: string,
): AgentRunSource | undefined {
  const candidates = sourceRef === undefined
    ? [messages.findLast(message => message.role === 'user' && message.origin?.kind !== 'injection')].filter(message => message !== undefined)
    : messages;
  const refs = candidates.flatMap(message => message.id !== undefined && message.origin?.kind === 'user'
    ? (message.origin.agentRefs ?? []).filter(ref => sourceRef === undefined || ref.refId === sourceRef)
      .filter(ref => ref.profile === profile && ref.executor === executor && ref.configuration === configuration)
      .map(ref => ({ ...ref, messageId: message.id! })) : []);
  if (sourceRef !== undefined && refs.length !== 1) throw new Error2(ErrorCodes.REQUEST_INVALID,
    'source_ref must identify a visible user-message reference matching the selected profile and engine.');
  return refs.length === 1 ? refs[0] : undefined;
}
