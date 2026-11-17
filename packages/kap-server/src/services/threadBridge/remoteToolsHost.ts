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
import { machineLabel } from '../connections/pairing';
import { currentSpacePlatform } from '../connections/spaceSummary';

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

export async function listExportedTools(core: Scope, workspaceId?: string): Promise<BridgeToolsListResult> {
  const tools: RemoteExportedTool[] = [];
  const seenNames = new Set<string>();

  const pluginHosts = optionalService(core, IPluginHostService);
  const pluginUsage = optionalService(core, IPluginUsageService);
  if (pluginHosts !== undefined) {
    const registrations = await pluginHosts.list();
    const allowedByPlugin = new Map<string, boolean>();
    for (const { pluginId, definition } of registrations) {
      if (tools.length >= MAX_EXPORTED_TOOLS) break;
      if (pluginUsage !== undefined) {
        let allowed = allowedByPlugin.get(pluginId);
        if (allowed === undefined) {
          allowed = await pluginUsage.allows(workspaceId, pluginId);
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
    const candidates = workspaceId !== undefined
      ? (workspaceInstances.get(workspaceId) !== undefined ? [workspaceInstances.get(workspaceId)!] : [])
      : workspaceInstances.list();
    for (const instance of candidates) {
      if (tools.length >= MAX_EXPORTED_TOOLS) break;
      let manager;
      try {
        const mcp = instance.program.mcp;
        await mcp.ready;
        manager = mcp.connectionManager();
      } catch {
        continue;
      }
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
  const effectiveWorkspaceId = targetWorkspaceScope === '*' ? input.workspaceId : targetWorkspaceScope;

  const pluginHosts = optionalService(core, IPluginHostService);
  const pluginUsage = optionalService(core, IPluginUsageService);
  if (pluginHosts !== undefined) {
    const registrations = await pluginHosts.list();
    const match = registrations.find(({ pluginId, definition }) => pluginToolName(pluginId, definition.name) === input.remoteName);
    if (match !== undefined) {
      if (pluginUsage !== undefined && !(await pluginUsage.allows(effectiveWorkspaceId, match.pluginId))) {
        throw new AdmissionError(403, 'bridge_operation_denied');
      }
      const workspaces = optionalService(core, IWorkspaceService);
      const workspaceRoot = effectiveWorkspaceId !== undefined && workspaces !== undefined
        ? (await workspaces.get(effectiveWorkspaceId))?.root
        : undefined;
      const collector = new RemoteAttachmentCollector();
      const result = await pluginHosts.execute(
        match.pluginId,
        match.definition.name,
        input.arguments,
        signal,
        undefined,
        {
          workspaceRoot,
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
    const candidates = effectiveWorkspaceId !== undefined
      ? (workspaceInstances.get(effectiveWorkspaceId) !== undefined ? [workspaceInstances.get(effectiveWorkspaceId)!] : [])
      : workspaceInstances.list();
    for (const instance of candidates) {
      let manager;
      try {
        const mcp = instance.program.mcp;
        await mcp.ready;
        manager = mcp.connectionManager();
      } catch {
        continue;
      }
      for (const serverEntry of manager.list()) {
        if (serverEntry.status !== 'connected') continue;
        const resolved = manager.resolved(serverEntry.name);
        if (resolved === undefined) continue;
        for (const tool of resolved.tools) {
          if (!resolved.enabledNames.has(tool.name)) continue;
          if (qualifyMcpToolName(serverEntry.name, tool.name) !== input.remoteName) continue;
          const lease = await resolved.admitCall?.();
          if (resolved.admitCall !== undefined && lease === undefined) {
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
            lease?.release();
          }
        }
      }
    }
  }

  throw new AdmissionError(404, 'remote_tool_not_found');
}
