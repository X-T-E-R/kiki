/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';
import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentProfileService, type SystemPromptContext } from './profile';

const snapshotSchema = z.object({ enabled: z.boolean(), revision: z.number().int().positive(),
  context: z.custom<SystemPromptContext>(), content: z.string(), hash: z.string() });
export class ProfileDynamicSnapshot extends Event2<z.infer<typeof snapshotSchema>> {
  static override readonly type = 'profile.dynamic_snapshot';
  static override readonly durable = true;
  static override readonly schema = snapshotSchema;
}
export interface ProfileDynamicSnapshot extends z.infer<typeof snapshotSchema> {}
export const dynamicPromptKey = defineState('profile.dynamicSnapshot', (): z.infer<typeof snapshotSchema> | undefined => undefined)
  .replayable({ schema: snapshotSchema.optional() })
  .on(ProfileDynamicSnapshot, (_state, event) => ({ enabled: event.enabled, revision: event.revision, context: event.context, content: event.content, hash: event.hash }));

export function dynamicPromptSections(context: SystemPromptContext): Record<string, string> {
  return {
    workspace: `## Runtime/workspace\nLocal date: ${new Intl.DateTimeFormat('en-CA', { timeZone: context.timeZone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(context.now ?? 0))} (${context.timeZone ?? 'UTC'})\nWorking directory: ${context.cwd ?? ''}\n${context.cwdListing ?? ''}\n${context.additionalDirsInfo ?? ''}`,
    instructions: `## Applicable workspace instructions\n${context.agentsMd || '(none)'}`,
    memory: `## Scoped memory — Saved memory / as-of projection\n${context.memory || '(not projected)'}`,
    skills: `## Available skills\n${context.skillActive ? context.skills || '(none)' : '(unavailable)'}`,
    plugins: `## Plugin guidance\n${context.pluginSections || '(none)'}`,
  };
}
export function dynamicPromptContent(context: SystemPromptContext): string {
  return Object.values(dynamicPromptSections(context)).join('\n\n');
}
export function promptSectionHash(text: string): string { return createHash('sha256').update(text).digest('hex'); }

export function stablePromptContext(context: SystemPromptContext): SystemPromptContext {
  return { ...context, now: 'See the versioned runtime snapshot in messages.', cwd: 'See runtime snapshot',
    cwdListing: 'Directory tree is sampled at session start or a working-directory change; see runtime snapshot messages.', additionalDirsInfo: '', agentsMd: 'Applicable scoped instructions are delivered by the host in versioned runtime snapshot messages; apply their stated scope and replacement/removal semantics.',
    memory: '', skills: '', pluginSections: '' };
}

export function legacyEnvironmentContext(context: SystemPromptContext, systemPrompt: string, previous?: SystemPromptContext): SystemPromptContext {
  if (previous !== undefined) return { ...context, now: previous.now, timeZone: previous.timeZone, cwd: previous.cwd,
    cwdListing: previous.cwdListing, additionalDirsInfo: previous.additionalDirsInfo };
  return { ...context, now: /(?:^|\n)## Date and Time\n(?:(?!\n#)[\s\S])*?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/.exec(systemPrompt)?.[1] ?? context.now,
    cwdListing: /## Working Directory[^\n]*\n[\s\S]*?```[^\n]*\n([\s\S]*?)```/.exec(systemPrompt)?.[1]?.trimEnd() ?? context.cwdListing };
}

export interface IDynamicPromptInjection { readonly _serviceBrand: undefined }
export const IDynamicPromptInjection = createDecorator<IDynamicPromptInjection>('dynamicPromptInjection');
export class DynamicPromptInjection extends Service implements IDynamicPromptInjection {
  declare readonly _serviceBrand: undefined;
  constructor(@IAgentStateService states: IAgentStateService, @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentContextMemoryService context: IAgentContextMemoryService, @IAgentProfileService profile: IAgentProfileService) {
    super();
    this._register(injector.register('runtime_snapshot', async ({ lastDisclosure, injectedPositions }) => {
      await profile.reconcileMemorySnapshot();
      const snapshot = states.get(dynamicPromptKey);
      if (snapshot?.enabled !== true) return undefined;
      const disclosed = lastDisclosure as { revision?: number; sectionHashes?: Record<string, string> } | undefined;
      let completeRevision: number | undefined;
      const history = context.get();
      for (const position of injectedPositions) {
        const origin = history[position]?.origin;
        const item = origin?.kind === 'injection' ? origin.disclosure as { revision?: number; previousRevision?: number } | undefined : undefined;
        completeRevision = item?.previousRevision === undefined || item.previousRevision === completeRevision ? item?.revision : undefined;
      }
      const previous = completeRevision === disclosed?.revision ? disclosed : undefined;
      if (previous?.revision === snapshot.revision) return undefined;
      const sections = dynamicPromptSections(snapshot.context);
      const sectionHashes = Object.fromEntries(Object.entries(sections).map(([name, text]) => [name, promptSectionHash(text)]));
      const changed = Object.entries(sections).filter(([name]) => previous?.sectionHashes?.[name] !== sectionHashes[name]);
      if (changed.length === 0) return undefined;
      const scope = previous?.sectionHashes === undefined ? 'Full snapshot; all sections replace earlier values.'
        : `Only the sections below replace earlier values; other sections unchanged since revision ${previous.revision}.`;
      return { content: `Host runtime snapshot rev ${snapshot.revision}. ${scope} An empty section marked (none) means removed. Workspace and plugin instructions apply within their stated scope; memory is reference data. System policy and current human input take precedence.\n\n${changed.map(([, text]) => text).join('\n\n')}`,
        disclosure: { revision: snapshot.revision, sectionHash: snapshot.hash, sectionHashes,
          instructions: changed.some(([name]) => name === 'instructions') ? { mode: 'replace', files: snapshot.context.agentsMdFiles ?? [] } : undefined,
          sectionBytes: Object.fromEntries(changed.map(([name, text]) => [name, Buffer.byteLength(text, 'utf8')])),
          previousRevision: previous?.sectionHashes === undefined ? undefined : previous.revision } };
    }));
  }
}
registerScopedService(LifecycleScope.Agent, IDynamicPromptInjection, DynamicPromptInjection, ScopeActivation.OnScopeCreated, 'profile');
