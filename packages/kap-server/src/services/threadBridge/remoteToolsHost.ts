import { randomUUID } from 'node:crypto';
import {
  IPluginHostService,
  IPluginUsageService,
  IWorkspaceInstanceManager,
  IWorkspaceService,
  type Scope,
} from '@kiki/agent-core-v2';
import type { ServiceIdentifier } from '@kiki/agent-core-v2/_base/di/instantiation';
import { parseImageDataUrl } from '@kiki/agent-core-v2/agent/media/image-format-policy';
import type { ISessionMediaStore, SessionMediaMaterializeInput } from '@kiki/agent-core-v2/agent/media/sessionMediaStore';
import { mcpResultToExecutableOutput } from '@kiki/agent-core-v2/agent/mcp/output';
import type { ContentPart } from '@kiki/agent-core-v2/kosong/contract/message';
import { qualifyMcpToolName } from '@kiki/agent-core-v2/mcpCore/tool-naming';
import type { ExecutableToolOutput } from '@kiki/agent-core-v2/tool/toolContract';
import type {
  BridgeToolsCall,
  BridgeToolsCallResult,
  BridgeToolsListResult,
  RemoteExportedTool,
  RemoteToolMediaAttachment,
} from '@kiki/protocol';
import { AdmissionError } from '../connections/admission';
import { currentSpacePlatform, machineLabel } from '../connections/pairing';

const MAX_EXPORTED_TOOLS = 512;
const MAX_REMOTE_MEDIA_BYTES = 11 * 1024 * 1024;
const MAX_REMOTE_MEDIA_ATTACHMENTS = 32;

function optionalService<T>(core: Scope, id: ServiceIdentifier<T>): T | undefined {
  try {
    return core.accessor.get(id);
  } catch {
    return undefined;
  }
}

function pluginToolName(pluginId: string, toolName: string): string {
  return `plugin__${pluginId.replaceAll('-', '_')}__${toolName}`;
}

interface CollectedMediaEntry {
  readonly data: Uint8Array;
  readonly name: string;
  readonly mimeType: string;
}

class RemoteAttachmentCollector {
  private totalBytes = 0;
  readonly attachments: RemoteToolMediaAttachment[] = [];
  private readonly byId = new Map<string, CollectedMediaEntry>();

  readonly store: ISessionMediaStore = {
    _serviceBrand: undefined,
    pathFor: () => undefined,
    resolveDisplayPath: async () => undefined,
    read: async (fileId) => {
      const entry = this.byId.get(fileId);
      return entry === undefined ? undefined : { data: entry.data, name: entry.name };
    },
    open: async () => undefined,
    materialize: async (input: SessionMediaMaterializeInput) => {
      input.signal?.throwIfAborted();
      if (input.size > MAX_REMOTE_MEDIA_BYTES || this.totalBytes + input.size > MAX_REMOTE_MEDIA_BYTES) {
        throw new Error('Remote tool media attachment exceeds the size budget');
      }
      const chunks: Buffer[] = [];
      let received = 0;
      const stream = input.stream();
      for await (const chunk of stream) {
        input.signal?.throwIfAborted();
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += buf.byteLength;
        if (received > input.size || this.totalBytes + received > MAX_REMOTE_MEDIA_BYTES) {
          throw new Error('Remote tool media attachment exceeds the size budget');
        }
        chunks.push(buf);
      }
      const combined = Buffer.concat(chunks);
      this.add(input.fileId, input.mimeType, combined, input.name);
      return input.name;
    },
  };

  add(id: string, mimeType: string, data: Uint8Array, filename?: string): void {
    if (this.attachments.length >= MAX_REMOTE_MEDIA_ATTACHMENTS) {
      throw new AdmissionError(413, 'remote_tool_media_budget_exceeded');
    }
    if (this.totalBytes + data.byteLength > MAX_REMOTE_MEDIA_BYTES) {
      throw new AdmissionError(413, 'remote_tool_media_budget_exceeded');
    }
    this.totalBytes += data.byteLength;
    this.byId.set(id, { data, name: filename ?? id, mimeType });
    this.attachments.push({
      id,
      mimeType,
      filename,
      dataBase64: Buffer.from(data).toString('base64'),
    });
  }
}

function shapeOutputWithMedia(output: ExecutableToolOutput, collector: RemoteAttachmentCollector): BridgeToolsCallResult {
  if (typeof output === 'string') {
    return {
      output,
      media: collector.attachments.length > 0 ? collector.attachments : undefined,
    };
  }
  const shaped: ContentPart[] = output.map((part) => {
    if (part.type === 'image_url' && part.imageUrl.url.startsWith('data:')) {
      const parsed = parseImageDataUrl(part.imageUrl.url);
      if (parsed !== null) {
        const bytes = Buffer.from(parsed.base64, 'base64');
        const id = randomUUID();
        collector.add(id, parsed.mimeType, bytes, part.imageUrl.name);
        return { ...part, imageUrl: { ...part.imageUrl, url: `kimi-file://${id}` } };
      }
    }
    if (part.type === 'audio_url' && part.audioUrl.url.startsWith('data:')) {
      const parsed = parseImageDataUrl(part.audioUrl.url);
      if (parsed !== null) {
        const bytes = Buffer.from(parsed.base64, 'base64');
        const id = randomUUID();
        collector.add(id, parsed.mimeType, bytes, part.audioUrl.name);
        return { ...part, audioUrl: { ...part.audioUrl, url: `kimi-file://${id}` } };
      }
    }
    if (part.type === 'video_url' && part.videoUrl.url.startsWith('data:')) {
      const parsed = parseImageDataUrl(part.videoUrl.url);
      if (parsed !== null) {
        const bytes = Buffer.from(parsed.base64, 'base64');
        const id = randomUUID();
        collector.add(id, parsed.mimeType, bytes, part.videoUrl.name);
        return { ...part, videoUrl: { ...part.videoUrl, url: `kimi-file://${id}` } };
      }
    }
    return part;
  });
  return {
    output: shaped,
    media: collector.attachments.length > 0 ? collector.attachments : undefined,
  };
}

async function resolveRemoteWorkspace(
  core: Scope,
  requestedWorkspaceId: string | undefined,
  requireExplicit: boolean,
): Promise<{ id: string; root: string } | undefined> {
  const workspaces = optionalService(core, IWorkspaceService);
  if (workspaces === undefined) return undefined;
  if (requestedWorkspaceId !== undefined) {
    const found = await workspaces.get(requestedWorkspaceId);
    if (found === undefined && requireExplicit) {
      throw new AdmissionError(404, 'workspace_not_found');
    }
    return found === undefined ? undefined : { id: found.id, root: found.root };
  }
  const list = await workspaces.list();
  if (list.length === 0) return undefined;
  const sorted = [...list].sort(
    (a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.lastOpenedAt - a.lastOpenedAt) || a.id.localeCompare(b.id),
  );
  return { id: sorted[0]!.id, root: sorted[0]!.root };
}

interface InFlightExportedTools {
  readonly controller: AbortController;
  readonly promise: Promise<BridgeToolsListResult>;
  readonly state: {
    waiters: number;
    settled: boolean;
  };
}

const exportedToolsInFlight = new WeakMap<Scope, Map<string, InFlightExportedTools>>();

function attachExportedToolsWaiter(
  flights: Map<string, InFlightExportedTools>,
  key: string,
  entry: InFlightExportedTools,
  signal?: AbortSignal,
): Promise<BridgeToolsListResult> {
  entry.state.waiters += 1;
  if (signal === undefined) {
    return entry.promise.finally(() => {
      entry.state.waiters = Math.max(0, entry.state.waiters - 1);
    });
  }
  if (signal.aborted) {
    entry.state.waiters = Math.max(0, entry.state.waiters - 1);
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }
  return new Promise<BridgeToolsListResult>((resolve, reject) => {
    let released = false;
    const release = (): number => {
      if (!released) {
        released = true;
        entry.state.waiters = Math.max(0, entry.state.waiters - 1);
      }
      return entry.state.waiters;
    };
    const onAbort = (): void => {
      const remaining = release();
      if (remaining === 0 && !entry.state.settled) {
        if (flights.get(key) === entry) flights.delete(key);
        entry.controller.abort(signal.reason);
      }
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void entry.promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        release();
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        release();
        reject(error);
      },
    );
  });
}

export async function listExportedTools(
  core: Scope,
  workspaceId?: string,
  options?: { signal?: AbortSignal; materializeCold?: boolean },
): Promise<BridgeToolsListResult> {
  const signal = options?.signal;
  signal?.throwIfAborted();
  const materializeCold = options?.materializeCold !== false;
  let flights = exportedToolsInFlight.get(core);
  if (flights === undefined) {
    flights = new Map();
    exportedToolsInFlight.set(core, flights);
  }
  const key = `${workspaceId ?? ''}\0${materializeCold ? '1' : '0'}`;
  const existing = flights.get(key);
  if (existing !== undefined && !existing.state.settled && !existing.controller.signal.aborted) {
    return attachExportedToolsWaiter(flights, key, existing, signal);
  }
  const controller = new AbortController();
  const state = { waiters: 0, settled: false };
  const promise = listExportedToolsUncached(core, workspaceId, materializeCold, controller.signal).finally(() => {
    state.settled = true;
    const current = flights.get(key);
    if (current?.controller === controller) flights.delete(key);
  });
  void promise.catch(() => {});
  const entry: InFlightExportedTools = { controller, promise, state };
  flights.set(key, entry);
  return attachExportedToolsWaiter(flights, key, entry, signal);
}

async function listExportedToolsUncached(
  core: Scope,
  workspaceId: string | undefined,
  materializeCold: boolean,
  signal: AbortSignal,
): Promise<BridgeToolsListResult> {
  signal.throwIfAborted();
  const targetWorkspace = await resolveRemoteWorkspace(core, workspaceId, workspaceId !== undefined && materializeCold);
  signal?.throwIfAborted();
  const effectiveWorkspaceId = targetWorkspace?.id ?? workspaceId;

  const tools: RemoteExportedTool[] = [];
  const seenNames = new Set<string>();

  const pluginHosts = optionalService(core, IPluginHostService);
  const pluginUsage = optionalService(core, IPluginUsageService);
  if (pluginHosts !== undefined) {
    const registrations = await pluginHosts.list();
    signal?.throwIfAborted();
    const allowedByPlugin = new Map<string, boolean>();
    for (const { pluginId, definition } of registrations) {
      if (tools.length >= MAX_EXPORTED_TOOLS) break;
      if (pluginUsage !== undefined) {
        let allowed = allowedByPlugin.get(pluginId);
        if (allowed === undefined) {
          allowed = await pluginUsage.allows(effectiveWorkspaceId, pluginId);
          signal?.throwIfAborted();
          allowedByPlugin.set(pluginId, allowed);
        }
        if (!allowed) continue;
      }
      const remoteName = pluginToolName(pluginId, definition.name);
      if (seenNames.has(remoteName)) continue;
      seenNames.add(remoteName);
      tools.push({
        remoteName,
        kind: 'plugin',
        pluginId,
        toolName: definition.name,
        description: definition.description.slice(0, 16384),
        parameters: (definition.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>,
        concurrencySafe: definition.concurrencySafe === true ? true : undefined,
      });
    }
  }

  const workspaceInstances = optionalService(core, IWorkspaceInstanceManager);
  if (workspaceInstances !== undefined && tools.length < MAX_EXPORTED_TOOLS) {
    const refWorkspaceId = targetWorkspace?.id ?? workspaceId ?? (optionalService(core, IWorkspaceService) === undefined ? workspaceInstances.list()[0]?.id : undefined);
    if (refWorkspaceId !== undefined && (materializeCold || workspaceInstances.get(refWorkspaceId) !== undefined)) {
      let lease;
      try {
        lease = await workspaceInstances.acquire({ workspaceId: refWorkspaceId, root: targetWorkspace?.root });
      } catch {
        lease = undefined;
      }
      if (lease !== undefined) {
        try {
          signal?.throwIfAborted();
          let manager;
          try {
            const mcp = lease.instance.program.mcp;
            await mcp.ready;
            signal?.throwIfAborted();
            manager = mcp.connectionManager();
          } catch {
            manager = undefined;
          }
          if (manager !== undefined) {
            for (const serverEntry of manager.list()) {
              if (tools.length >= MAX_EXPORTED_TOOLS) break;
              if (serverEntry.status !== 'connected') continue;
              const resolved = manager.resolved(serverEntry.name);
              if (resolved === undefined) continue;
              for (const tool of resolved.tools) {
                if (tools.length >= MAX_EXPORTED_TOOLS) break;
                if (!resolved.enabledNames.has(tool.name)) continue;
                const remoteName = qualifyMcpToolName(serverEntry.name, tool.name);
                if (seenNames.has(remoteName)) continue;
                seenNames.add(remoteName);
                tools.push({
                  remoteName,
                  kind: 'mcp',
                  serverName: serverEntry.name,
                  toolName: tool.name,
                  description: tool.description.slice(0, 16384),
                  parameters: (tool.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>,
                });
              }
            }
          }
        } finally {
          lease.dispose();
        }
      }
    }
  }

  return {
    spaceLabel: machineLabel(),
    platform: currentSpacePlatform(),
    tools,
  };
}

export async function callExportedTool(
  core: Scope,
  input: BridgeToolsCall,
  targetWorkspaceScope: string,
  signal: AbortSignal,
): Promise<BridgeToolsCallResult> {
  signal.throwIfAborted();
  const requestedWorkspaceId = targetWorkspaceScope === '*' ? input.workspaceId : targetWorkspaceScope;
  const targetWorkspace = await resolveRemoteWorkspace(core, requestedWorkspaceId, requestedWorkspaceId !== undefined);
  signal.throwIfAborted();
  const effectiveWorkspaceId = targetWorkspace?.id ?? requestedWorkspaceId;

  const pluginHosts = optionalService(core, IPluginHostService);
  const pluginUsage = optionalService(core, IPluginUsageService);
  if (pluginHosts !== undefined) {
    const registrations = await pluginHosts.list();
    signal.throwIfAborted();
    const match = registrations.find(({ pluginId, definition }) => pluginToolName(pluginId, definition.name) === input.remoteName);
    if (match !== undefined) {
      if (pluginUsage !== undefined && !(await pluginUsage.allows(effectiveWorkspaceId, match.pluginId))) {
        throw new AdmissionError(403, 'bridge_operation_denied');
      }
      signal.throwIfAborted();
      const collector = new RemoteAttachmentCollector();
      const result = await pluginHosts.execute(
        match.pluginId,
        match.definition.name,
        input.arguments,
        signal,
        undefined,
        {
          workspaceRoot: targetWorkspace?.root,
          workspaceId: effectiveWorkspaceId,
          imageIn: true,
          attachmentStore: collector.store,
        },
        match.definition,
      );
      const shaped = shapeOutputWithMedia(result.output, collector);
      return result.isError === true ? { ...shaped, isError: true } : shaped;
    }
  }

  const workspaceInstances = optionalService(core, IWorkspaceInstanceManager);
  if (workspaceInstances !== undefined) {
    const refWorkspaceId = targetWorkspace?.id ?? requestedWorkspaceId ?? (optionalService(core, IWorkspaceService) === undefined ? workspaceInstances.list()[0]?.id : undefined);
    if (refWorkspaceId !== undefined) {
      let lease;
      try {
        lease = await workspaceInstances.acquire({ workspaceId: refWorkspaceId, root: targetWorkspace?.root });
      } catch {
        lease = undefined;
      }
      if (lease !== undefined) {
        try {
          signal.throwIfAborted();
          let manager;
          try {
            const mcp = lease.instance.program.mcp;
            await mcp.ready;
            signal.throwIfAborted();
            manager = mcp.connectionManager();
          } catch {
            manager = undefined;
          }
          if (manager !== undefined) {
            for (const serverEntry of manager.list()) {
              if (serverEntry.status !== 'connected') continue;
              const resolved = manager.resolved(serverEntry.name);
              if (resolved === undefined) continue;
              for (const tool of resolved.tools) {
                if (!resolved.enabledNames.has(tool.name)) continue;
                if (qualifyMcpToolName(serverEntry.name, tool.name) !== input.remoteName) continue;
                const callLease = await resolved.admitCall?.();
                if (resolved.admitCall !== undefined && callLease === undefined) {
                  throw new AdmissionError(409, 'remote_tool_unavailable');
                }
                try {
                  const mcpResult = await resolved.client.callTool(tool.name, input.arguments, signal);
                  const collector = new RemoteAttachmentCollector();
                  const execResult = await mcpResultToExecutableOutput(mcpResult, input.remoteName, {
                    signal,
                    attachmentStore: collector.store,
                  });
                  const shaped = shapeOutputWithMedia(execResult.output, collector);
                  return execResult.isError === true ? { ...shaped, isError: true } : shaped;
                } finally {
                  callLease?.release();
                }
              }
            }
          }
        } finally {
          lease.dispose();
        }
      }
    }
  }

  throw new AdmissionError(404, 'remote_tool_not_found');
}
