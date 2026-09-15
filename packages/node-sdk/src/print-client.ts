import {
  bootstrap,
  IBootstrapService,
  IConfigService,
  IEventDispatcher,
  ISessionIndex,
  ISessionManager,
  applyPrintModeConfigDefaults,
  logSeed,
  resolveLoggingConfig,
  type BootstrapInput,
  type Scope,
} from '@kiki/agent-core-v2';
import { IAgentLifecycleService } from '@kiki/agent-core-v2/session/agentLifecycle/agentLifecycle';
import { ITaskBoardService } from '@kiki/agent-core-v2/app/taskBoard/taskBoard';
import { createKlient } from '@kiki/klient/memory';
import type { Klient } from '@kiki/klient';

import { createPrintTaskBoardService } from './print-task-board';

export { PRINT_MAX_TURNS_DEFAULT, PRINT_WAIT_CEILING_S_DEFAULT, setClampedTimeout } from '@kiki/agent-core-v2';
export type { AgentTaskConfig, PrintBackgroundMode } from '@kiki/agent-core-v2';

/** In-process print host. Sessions, prompts and resource policy remain on the returned facade. */
export interface PrintClientHost {
  readonly klient: Klient;
  readonly osHomeDir: string;
  /**
   * Awaits every live agent's wire persist queue (and the append-log store
   * behind it). A headless run dispatches its tail records — `step.end`,
   * `turn.ended`, `prompt.completed` — fire-and-forget, so a process that
   * exits right after the turn would otherwise cut those records off.
   */
  flushWires(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Flush every live agent's event dispatcher. Each agent settles independently
 * and a failure is swallowed: the caller is exiting, and one broken journal
 * must not keep the others' records from reaching disk.
 */
export async function flushPrintWires(app: Scope): Promise<void> {
  const flushes: Promise<void>[] = [];
  for (const session of app.accessor.get(ISessionManager).list()) {
    let handles;
    try {
      handles = session.accessor.get(IAgentLifecycleService).list();
    } catch {
      continue;
    }
    for (const handle of handles) {
      try {
        flushes.push(handle.accessor.get(IEventDispatcher).flush());
      } catch {
        continue;
      }
    }
  }
  await Promise.allSettled(flushes);
}

export async function createPrintClient(input: BootstrapInput & { homeDir: string }): Promise<PrintClientHost> {
  let app: Scope | undefined;
  const result = bootstrap(input, [
    ...logSeed(resolveLoggingConfig({ homeDir: input.homeDir, env: process.env })),
    [ITaskBoardService, createPrintTaskBoardService(() => app!)],
  ]);
  app = result.app;
  try {
    const config = app.accessor.get(IConfigService);
    await config.ready;
    await applyPrintModeConfigDefaults(config);
    await app.accessor.get(ISessionIndex).prepare();
    const klient = createKlient({ scope: app });
    let disposing: Promise<void> | undefined;
    return {
      klient,
      osHomeDir: app.accessor.get(IBootstrapService).osHomeDir,
      flushWires: () => flushPrintWires(app),
      dispose: () => disposing ??= klient.close().finally(() => app.dispose()),
    };
  } catch (error) {
    app.dispose();
    throw error;
  }
}
