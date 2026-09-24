import { isAbsolute } from 'node:path';
import { z } from 'zod';

import { createDecorator, type ServicesAccessor } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { Error2, ErrorCodes } from '#/errors';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { AgentTool, ToolExecution } from '#/tool/toolContract';

import THREAD_CREATE_DESCRIPTION from './thread-create.md?raw';

export const ThreadCreateToolInputSchema = z.object({
  title: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  profile: z.string().min(1).optional(),
  prompt: z.string().min(1).max(100_000).optional(),
}).strict();

type ThreadCreateToolInput = z.infer<typeof ThreadCreateToolInputSchema>;

export interface IThreadCreateTool extends AgentTool<ThreadCreateToolInput> {
  readonly _serviceBrand: undefined;
}

export const IThreadCreateTool = createDecorator<IThreadCreateTool>('threadCreateTool');

export class ThreadCreateTool implements IThreadCreateTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'ThreadCreate';
  readonly description = THREAD_CREATE_DESCRIPTION;
  readonly parameters = toInputJsonSchema(ThreadCreateToolInputSchema);

  constructor(
    @ISessionManager private readonly sessions: ISessionManager,
    @ISessionContext private readonly session: ISessionContext,
  ) {}

  resolveExecution(input: ThreadCreateToolInput): ToolExecution {
    if (input.cwd !== undefined && !isAbsolute(input.cwd)) {
      return { output: 'cwd must be an absolute path to an existing directory.', isError: true };
    }
    if (input.prompt !== undefined && input.prompt.trim() === '') {
      return { output: 'prompt must contain non-whitespace text.', isError: true };
    }
    return {
      approvalRule: this.name,
      description: 'Creating a new thread',
      execute: async () => {
        const handle = await this.sessions.create({
          workDir: input.cwd ?? this.session.cwd,
          mainAgentBinding: input.profile === undefined ? undefined : { profile: input.profile },
        });
        let promptAccepted = false;
        try {
          const catalog = handle.accessor.get(ISessionAgentProfileCatalog);
          await catalog.ready;
          const profile = input.profile === undefined ? catalog.getDefault() : catalog.get(input.profile);
          if (profile === undefined) {
            throw new Error2(
              ErrorCodes.PROFILE_UNKNOWN,
              `Agent profile "${input.profile}" is unavailable or disabled. Choose an enabled main-agent profile.`,
            );
          }
          if (profile.main !== true) {
            throw new Error2(
              ErrorCodes.REQUEST_INVALID,
              `Agent profile "${profile.name}" is not a main-agent profile. Choose an enabled main-agent profile.`,
            );
          }
          const firstLine = input.prompt?.split(/\r?\n/, 1)[0]?.trim();
          const title = input.title ?? (firstLine ? Array.from(firstLine).slice(0, 80).join('') : undefined);
          const metadata = handle.accessor.get(ISessionMetadata);
          if (title !== undefined) await metadata.setTitle(title);
          if (input.prompt !== undefined) {
            const main = await ensureMainAgent(handle);
            const submitted = await main.accessor.get(IAgentPromptService).enqueue({
              message: {
                role: 'user',
                content: [{ type: 'text', text: input.prompt }],
                toolCalls: [],
                origin: { kind: 'user' },
              },
            });
            promptAccepted = true;
            if (await submitted.launched === undefined) {
              const completion = await submitted.completion;
              throw new Error2(
                ErrorCodes.REQUEST_INVALID,
                `Thread "${handle.id}" accepted the prompt but could not start it (${completion.state}).`,
              );
            }
          }
          const created = await metadata.read();
          const context = handle.accessor.get(ISessionContext);
          return {
            output: JSON.stringify({
              id: handle.id,
              title: created.title ?? 'Untitled session',
              cwd: context.cwd,
              profile: profile.name,
              prompt_started: input.prompt !== undefined,
              message: 'The new thread will appear in the session list on the left within a few seconds. Use ThreadSend and ThreadWait to continue the conversation.',
            }, null, 2),
          };
        } catch (error) {
          if (!promptAccepted) await this.sessions.delete(handle.id);
          throw error;
        }
      },
    };
  }
}

function mainAgentOnly(accessor: ServicesAccessor): boolean {
  return accessor.get(IAgentScopeContext).agentId === 'main';
}

registerAgentToolService(IThreadCreateTool, ThreadCreateTool, {
  name: 'ThreadCreate',
  domain: 'threadCommunication',
  when: mainAgentOnly,
});
