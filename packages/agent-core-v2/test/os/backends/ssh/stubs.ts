import { createStubInstance } from 'sinon';
import { ConfigService } from '#/app/config/configService';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncation';
import { IBashTool } from '#/agent/tools/os/bash/bash';
import { BashTool } from '#/agent/tools/os/bash/bashTool';
import { IReadTool } from '#/agent/tools/os/read/read';
import { ReadTool } from '#/agent/tools/os/read/readTool';
import { IWriteTool } from '#/agent/tools/os/write/write';
import { WriteTool } from '#/agent/tools/os/write/writeTool';
import { IEditTool } from '#/agent/tools/edit/edit';
import { EditTool } from '#/agent/tools/edit/editTool';
import { IGlobTool } from '#/agent/tools/os/glob/glob';
import { GlobTool } from '#/agent/tools/os/glob/globTool';
import { IGrepTool } from '#/agent/tools/os/grep/grep';
import { GrepTool } from '#/agent/tools/os/grep/grepTool';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IFileEditService } from '#/app/edit/fileEdit';
import { FileEditService } from '#/app/edit/fileEditService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

export function sshTestTools(input: {
  runtime: IAgentRuntimeService;
  workspace: ISessionWorkspaceContext;
  localFs: IHostFileSystem;
  catalog: ISessionSkillCatalog;
  truncation: IAgentToolResultTruncationService;
  telemetry: ITelemetryService;
}) {
  const disposables = new DisposableStore();
  const tasks = new Map<string, Promise<void>>();
  const services = createServices(disposables, {
    additionalServices: (reg) => {
      reg.defineInstance(IAgentRuntimeService, input.runtime);
      reg.defineInstance(ISessionWorkspaceContext, input.workspace);
      reg.defineInstance(IHostFileSystem, input.localFs);
      reg.defineInstance(ISessionSkillCatalog, input.catalog);
      reg.defineInstance(IAgentToolResultTruncationService, input.truncation);
      reg.defineInstance(ITelemetryService, input.telemetry);
      reg.definePartialInstance(ISessionContext, {});
      reg.defineInstance(IConfigService, createStubInstance(ConfigService));
      reg.definePartialInstance(IFlagService, { enabled: () => false });
      reg.definePartialInstance(IAgentPermissionModeService, { mode: 'yolo' });
      reg.definePartialInstance(IAgentToolPolicyService, { isToolActive: () => false });
      reg.definePartialInstance(IAgentTaskService, {
        registerTask: (task) => {
          const id = `task-${tasks.size}`;
          tasks.set(id, Promise.resolve(task.start({ signal: new AbortController().signal, appendOutput: () => {}, settle: async () => true })));
          return id;
        },
        waitForForegroundRelease: async (id) => { await tasks.get(id); return 'terminal'; },
        getTask: () => undefined,
      });
      reg.define(IFileEditService, FileEditService);
      reg.define(IBashTool, BashTool);
      reg.define(IReadTool, ReadTool);
      reg.define(IWriteTool, WriteTool);
      reg.define(IEditTool, EditTool);
      reg.define(IGlobTool, GlobTool);
      reg.define(IGrepTool, GrepTool);
    },
  });
  return { bash: services.get(IBashTool), read: services.get(IReadTool), write: services.get(IWriteTool),
    edit: services.get(IEditTool), glob: services.get(IGlobTool), grep: services.get(IGrepTool), dispose: () => Promise.resolve(disposables.dispose()) };
}
