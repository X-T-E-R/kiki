import {
  bootstrap,
  IBootstrapService,
  IConfigService,
  ISessionIndex,
  applyPrintModeConfigDefaults,
  logSeed,
  resolveLoggingConfig,
  type BootstrapInput,
  type Scope,
} from '@kiki/agent-core-v2';
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
  dispose(): Promise<void>;
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
      dispose: () => disposing ??= klient.close().finally(() => app.dispose()),
    };
  } catch (error) {
    app.dispose();
    throw error;
  }
}
