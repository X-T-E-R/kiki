import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import { Readable } from 'node:stream';

import type {
  BridgeToolsCallResult,
  RemoteExportedTool,
  RemoteToolMediaAttachment,
  SpacePlatform,
} from '@kiki/protocol';
import { createDecorator } from '#/_base/di/instantiation';
import { dispose, type IDisposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Service } from '#/_base/di/service';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { buildDaemonFileUrl, mediaExtensionForMime } from '#/agent/media/mediaRef';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import {
  IRemoteSpaceToolBridgeService,
  type RemoteBorrowedSpaceCatalog,
} from '#/app/remoteTools/remoteSpaceToolBridge';
import { LifecycleScope } from '#/app/scopes';
import type { ContentPart } from '#/kosong/contract/message';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  ToolAccesses,
  type ExecutableTool,
  type ExecutableToolOutput,
  type ExecutableToolResult,
} from '#/tool/toolContract';

const MAX_REMOTE_TOOL_NAME_LENGTH = 60;
const MAX_SPACE_SLUG_LENGTH = 12;

export interface IAgentRemoteToolService {
  readonly _serviceBrand: undefined;
  ready(): Promise<void>;
}

export const IAgentRemoteToolService = createDecorator<IAgentRemoteToolService>('agentRemoteToolService');

interface RegisteredRemoteTool {
  readonly disposable: IDisposable;
  readonly signature: string;
}

interface WantedRemoteTool {
  readonly catalog: RemoteBorrowedSpaceCatalog;
  readonly tool: RemoteExportedTool;
  readonly qualifiedName: string;
  readonly description: string;
  readonly signature: string;
}

interface MaterializedMedia {
  readonly attachment: RemoteToolMediaAttachment;
  readonly mimeType: string;
  readonly size: number;
  readonly localUri: string;
  readonly placeholderUri: string;
  referenced: boolean;
}

export class AgentRemoteToolService extends Service implements IAgentRemoteToolService {
  declare readonly _serviceBrand: undefined;
  private readonly registrations = new Map<string, RegisteredRemoteTool>();
  private refreshQueue: Promise<void> = Promise.resolve();
  private readonly refreshes = new Set<Promise<void>>();
  private activeRefreshCount = 0;
  private activeController: AbortController | undefined;
  private dirty = true;
  private revision = 0;
  private closing = false;

  constructor(
    @IRemoteSpaceToolBridgeService private readonly remoteBridge: IRemoteSpaceToolBridgeService,
    @IAgentToolRegistryService private readonly registry: IAgentToolRegistryService,
    @ISessionContext private readonly session?: ISessionContext,
    @ISessionMediaStore private readonly attachmentStore?: ISessionMediaStore,
  ) {
    super();
    this._register(this.remoteBridge.onDidChange(() => {
      this.dirty = true;
      void this.queueRefresh().catch(() => undefined);
    }));
    this._register(this.registry.registerPreparation(async () => {
      try {
        await this.refreshIfNeeded();
      } catch (error) {
        onUnexpectedError(error);
      }
    }));
    void this.queueRefresh().catch(() => undefined);
  }

  async ready(): Promise<void> {
    const current = this.refreshQueue;
    await current;
  }

  private async refreshIfNeeded(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.closing) return;
    if (this.activeRefreshCount > 0 && !this.dirty) {
      await this.ready();
      return;
    }
    await this.queueRefresh(signal);
  }

  private queueRefresh(signal?: AbortSignal): Promise<void> {
    const revision = ++this.revision;
    this.dirty = false;
    this.activeController?.abort();
    const controller = new AbortController();
    this.activeController = controller;
    const effectiveSignal = signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]);
    this.activeRefreshCount += 1;
    const work = this.refresh(revision, effectiveSignal);
    this.refreshQueue = work;
    this.refreshes.add(work);
    void work.then(
      () => {
        this.activeRefreshCount -= 1;
        this.refreshes.delete(work);
        if (this.activeController === controller) this.activeController = undefined;
      },
      () => {
        this.activeRefreshCount -= 1;
        this.refreshes.delete(work);
        if (this.activeController === controller) this.activeController = undefined;
      },
    );
    return work;
  }

  private async refresh(revision: number, signal?: AbortSignal): Promise<void> {
    if (this.closing || revision !== this.revision) return;
    let catalogs: readonly RemoteBorrowedSpaceCatalog[];
    if (!this.remoteBridge.hasConnector()) {
      catalogs = [];
    } else {
      try {
        catalogs = await this.remoteBridge.listBorrowedTools({
          caller: this.callerIdentity(),
          signal,
        });
      } catch {
        catalogs = [];
      }
    }
    if (this.closing || revision !== this.revision) return;

    const wanted = buildWantedTools(catalogs);
    for (const [name, entry] of this.registrations) {
      if (wanted.get(name)?.signature === entry.signature) continue;
      void entry.disposable.dispose();
      this.registrations.delete(name);
    }
    if (this.closing || revision !== this.revision) return;

    for (const [name, target] of wanted) {
      if (this.registrations.has(name)) continue;
      if (this.registry.resolve(name) !== undefined) continue;
      const tool = this.buildExecutableTool(target);
      const disposable = this.registry.register(tool, {
        source: target.tool.kind,
        disclosure: 'deferred',
      });
      this.registrations.set(name, { disposable, signature: target.signature });
    }
  }

  private callerIdentity(): { readonly workspaceId: string; readonly sessionId: string } {
    return {
      workspaceId: this.session?.workspaceId ?? 'unknown-workspace',
      sessionId: this.session?.sessionId ?? 'unknown-session',
    };
  }

  private buildExecutableTool(target: WantedRemoteTool): ExecutableTool {
    const { catalog, tool, qualifiedName, description } = target;
    return {
      name: qualifiedName,
      description,
      parameters: tool.parameters ?? { type: 'object', properties: {} },
      resolveExecution: (args) => ({
        accesses: tool.concurrencySafe === true ? ToolAccesses.readAll() : ToolAccesses.all(),
        approvalRule: qualifiedName,
        execute: async (context) => {
          context.signal.throwIfAborted();
          const argsRecord =
            typeof args === 'object' && args !== null && !Array.isArray(args)
              ? (args as Record<string, unknown>)
              : {};
          const result = await this.remoteBridge.callBorrowedTool({
            bridgeId: catalog.bridgeId,
            connectionId: catalog.connectionId,
            caller: this.callerIdentity(),
            remoteName: tool.remoteName,
            arguments: argsRecord,
            callId: context.toolCallId,
            signal: context.signal,
          });
          return this.shapeRemoteToolResult(result, context.signal);
        },
      }),
    };
  }

  private async shapeRemoteToolResult(
    result: BridgeToolsCallResult,
    signal: AbortSignal,
  ): Promise<ExecutableToolResult> {
    signal.throwIfAborted();
    const materialized = await this.materializeMedia(result.media ?? [], signal);
    const output = formatRemoteToolOutput(result.output, materialized);
    return result.isError === true ? { isError: true, output } : { output };
  }

  private async materializeMedia(
    attachments: readonly RemoteToolMediaAttachment[],
    signal: AbortSignal,
  ): Promise<MaterializedMedia[]> {
    const out: MaterializedMedia[] = [];
    for (const attachment of attachments) {
      signal.throwIfAborted();
      const mimeType = normalizeAttachmentMime(attachment.mimeType);
      const bytes = Buffer.from(attachment.dataBase64, 'base64');
      let localUri: string | undefined;
      if (this.attachmentStore !== undefined) {
        const ext = attachmentExtension(attachment.filename, mimeType);
        const safeName = attachmentFilename(attachment.filename, ext);
        const hash = createHash('sha256')
          .update(attachment.id)
          .update('\0')
          .update(mimeType)
          .update('\0')
          .update(bytes)
          .digest('hex')
          .slice(0, 32);
        const fileId = `f_remote_${hash}`;
        try {
          const materializedPath = await this.attachmentStore.materialize({
            fileId,
            size: bytes.length,
            name: safeName,
            mimeType,
            stream: () => Readable.from([bytes]),
            signal,
          });
          if (materializedPath !== undefined || (await this.attachmentStore.open(fileId)) !== undefined) {
            localUri = buildDaemonFileUrl(fileId);
          }
        } catch (error) {
          signal.throwIfAborted();
          onUnexpectedError(error);
        }
      }
      localUri ??= `data:${mimeType};base64,${bytes.toString('base64')}`;
      out.push({
        attachment,
        mimeType,
        size: bytes.length,
        localUri,
        placeholderUri: `kimi-file://${attachment.id}`,
        referenced: false,
      });
    }
    return out;
  }

  override async dispose(): Promise<void> {
    this.closing = true;
    this.revision += 1;
    this.activeController?.abort();
    this.activeController = undefined;
    await Promise.allSettled(this.refreshes);
    await dispose([...this.registrations.values()].map((entry) => entry.disposable));
    this.registrations.clear();
    await super.dispose();
  }
}

function buildWantedTools(
  catalogs: readonly RemoteBorrowedSpaceCatalog[],
): Map<string, WantedRemoteTool> {
  const spaceSlugs = assignSpaceSlugs(catalogs);
  const wanted = new Map<string, WantedRemoteTool>();
  for (let i = 0; i < catalogs.length; i += 1) {
    const catalog = catalogs[i]!;
    const spaceSlug = spaceSlugs[i]!;
    for (const tool of catalog.tools) {
      const qualifiedName = allocateRemoteToolName(catalog, spaceSlug, tool, wanted);
      const description = formatRemoteToolDescription(catalog, tool);
      const signature = JSON.stringify({
        bridgeId: catalog.bridgeId,
        connectionId: catalog.connectionId,
        spaceLabel: catalog.spaceLabel,
        platform: catalog.platform,
        tool,
      });
      wanted.set(qualifiedName, {
        catalog,
        tool,
        qualifiedName,
        description,
        signature,
      });
    }
  }
  return wanted;
}

function assignSpaceSlugs(catalogs: readonly RemoteBorrowedSpaceCatalog[]): string[] {
  const baseSlugs = catalogs.map((catalog) => buildBaseSpaceSlug(catalog.spaceLabel));
  const counts = new Map<string, number>();
  for (const base of baseSlugs) {
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  const used = new Set<string>();
  const seenPerBase = new Map<string, number>();
  return catalogs.map((catalog, index) => {
    const base = baseSlugs[index]!;
    const occurrence = (seenPerBase.get(base) ?? 0) + 1;
    seenPerBase.set(base, occurrence);
    if ((counts.get(base) ?? 0) === 1 && !used.has(base)) {
      used.add(base);
      return base;
    }
    if (occurrence === 1 && !used.has(base)) {
      used.add(base);
      return base;
    }
    const hash4 = createHash('sha256')
      .update(`${catalog.bridgeId}:${catalog.connectionId}`)
      .digest('hex')
      .slice(0, 4);
    const hashed = `${base}_${hash4}`;
    if (!used.has(hashed)) {
      used.add(hashed);
      return hashed;
    }
    let suffix = 2;
    while (used.has(`${base}_${suffix}`)) {
      suffix += 1;
    }
    const unique = `${base}_${suffix}`;
    used.add(unique);
    return unique;
  });
}

function buildBaseSpaceSlug(spaceLabel: string): string {
  const sanitized = sanitizeSlugPart(spaceLabel);
  const sliced = sanitized.slice(0, MAX_SPACE_SLUG_LENGTH).replaceAll(/_+$/g, '');
  return sliced.length > 0 ? sliced : 'space';
}

function buildToolSlug(tool: RemoteExportedTool): string {
  const toolPart = sanitizeSlugPart(tool.toolName);
  if (tool.kind === 'plugin') {
    const pluginPart = tool.pluginId === undefined ? '' : sanitizeSlugPart(tool.pluginId);
    if (pluginPart.length === 0) return toolPart || 'tool';
    if (toolPart.length === 0) return pluginPart;
    if (toolPart === pluginPart || toolPart.startsWith(`${pluginPart}_`)) return toolPart;
    return `${pluginPart}_${toolPart}`;
  }
  const serverPart = tool.serverName === undefined ? '' : sanitizeSlugPart(tool.serverName);
  if (serverPart.length === 0) return toolPart || 'tool';
  if (toolPart.length === 0) return serverPart;
  return `${serverPart}_${toolPart}`;
}

function allocateRemoteToolName(
  catalog: RemoteBorrowedSpaceCatalog,
  spaceSlug: string,
  tool: RemoteExportedTool,
  existing: ReadonlyMap<string, WantedRemoteTool>,
): string {
  const prefix = tool.kind === 'plugin' ? 'plugin__' : 'mcp__';
  const head = `${prefix}remote_${spaceSlug}__`;
  const toolSlug = buildToolSlug(tool);
  const fullKey = `${catalog.bridgeId}:${catalog.connectionId}:${tool.kind}:${tool.remoteName}`;
  const candidate = `${head}${toolSlug}`;
  if (candidate.length <= MAX_REMOTE_TOOL_NAME_LENGTH && !existing.has(candidate)) {
    return candidate;
  }
  for (let attempt = 0; ; attempt += 1) {
    const hashInput = attempt === 0 ? fullKey : `${fullKey}#${attempt}`;
    const hash6 = createHash('sha256').update(hashInput).digest('hex').slice(0, 6);
    const maxToolLen = Math.max(1, MAX_REMOTE_TOOL_NAME_LENGTH - head.length - 1 - hash6.length);
    const truncated =
      toolSlug.slice(0, maxToolLen).replaceAll(/_+$/g, '') || toolSlug.slice(0, maxToolLen);
    const hashed = `${head}${truncated}_${hash6}`;
    if (!existing.has(hashed)) {
      return hashed;
    }
  }
}

function sanitizeSlugPart(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]+/g, '_')
    .replaceAll(/_+/g, '_')
    .replaceAll(/^_+|_+$/g, '');
}

function formatPlatformLabel(platform: SpacePlatform | undefined): string | undefined {
  switch (platform) {
    case 'win32':
      return 'Windows';
    case 'linux':
      return 'Linux';
    case 'darwin':
      return 'macOS';
    default:
      return undefined;
  }
}

function formatRemoteToolDescription(
  catalog: RemoteBorrowedSpaceCatalog,
  tool: RemoteExportedTool,
): string {
  const platformLabel = formatPlatformLabel(catalog.platform);
  const qualifier = platformLabel === undefined ? '' : ` (${platformLabel})`;
  return `[Remote space: ${catalog.spaceLabel}${qualifier}] ${tool.description}`;
}

function normalizeAttachmentMime(mimeType: string): string {
  const base = mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return base.length > 0 ? base : 'application/octet-stream';
}

function attachmentExtension(filename: string | undefined, mimeType: string): string {
  if (filename !== undefined) {
    const ext = extname(basename(filename));
    if (ext.length > 0) return ext;
  }
  return mediaExtensionForMime(mimeType) ?? '.bin';
}

function attachmentFilename(filename: string | undefined, ext: string): string {
  if (filename !== undefined) {
    const base = basename(filename);
    if (base.length > 0) return extname(base).length > 0 ? base : `${base}${ext}`;
  }
  return `attachment${ext}`;
}

function replaceTextPlaceholders(text: string, media: readonly MaterializedMedia[]): string {
  let out = text;
  for (const item of media) {
    if (out.includes(item.placeholderUri)) {
      out = out.replaceAll(item.placeholderUri, item.localUri);
      item.referenced = true;
    } else if (out === item.attachment.id) {
      out = item.localUri;
      item.referenced = true;
    }
  }
  return out;
}

function replaceUrlPlaceholder(url: string, media: readonly MaterializedMedia[]): string {
  let out = url;
  for (const item of media) {
    if (out === item.placeholderUri || out === item.attachment.id) {
      item.referenced = true;
      return item.localUri;
    }
    if (out.includes(item.placeholderUri)) {
      out = out.replaceAll(item.placeholderUri, item.localUri);
      item.referenced = true;
    }
  }
  return out;
}

function mediaItemToContentPart(item: MaterializedMedia): ContentPart {
  const name = item.attachment.filename;
  if (item.mimeType.startsWith('image/')) {
    return {
      type: 'image_url',
      imageUrl: { url: item.localUri, name, mimeType: item.mimeType, size: item.size },
    };
  }
  if (item.mimeType.startsWith('audio/')) {
    return {
      type: 'audio_url',
      audioUrl: { url: item.localUri, name, mimeType: item.mimeType, size: item.size },
    };
  }
  if (item.mimeType.startsWith('video/')) {
    return {
      type: 'video_url',
      videoUrl: { url: item.localUri, name, mimeType: item.mimeType, size: item.size },
    };
  }
  return {
    type: 'text',
    text: `[Attachment${name === undefined ? '' : ` ${name}`} (${item.mimeType}): ${item.localUri}]`,
  };
}

function formatRemoteToolOutput(
  output: unknown,
  media: readonly MaterializedMedia[],
): ExecutableToolOutput {
  if (Array.isArray(output)) {
    const parts: ContentPart[] = output.map((entry): ContentPart => {
      if (typeof entry === 'string') {
        return { type: 'text', text: replaceTextPlaceholders(entry, media) };
      }
      if (typeof entry === 'object' && entry !== null && 'type' in entry) {
        const part = entry as ContentPart;
        if (part.type === 'text' && typeof part.text === 'string') {
          return { ...part, text: replaceTextPlaceholders(part.text, media) };
        }
        if (part.type === 'image_url' && typeof part.imageUrl?.url === 'string') {
          return {
            ...part,
            imageUrl: { ...part.imageUrl, url: replaceUrlPlaceholder(part.imageUrl.url, media) },
          };
        }
        if (part.type === 'audio_url' && typeof part.audioUrl?.url === 'string') {
          return {
            ...part,
            audioUrl: { ...part.audioUrl, url: replaceUrlPlaceholder(part.audioUrl.url, media) },
          };
        }
        if (part.type === 'video_url' && typeof part.videoUrl?.url === 'string') {
          return {
            ...part,
            videoUrl: { ...part.videoUrl, url: replaceUrlPlaceholder(part.videoUrl.url, media) },
          };
        }
      }
      return { type: 'text', text: replaceTextPlaceholders(JSON.stringify(entry) ?? '', media) };
    });
    for (const item of media) {
      if (!item.referenced) {
        parts.push(mediaItemToContentPart(item));
      }
    }
    return parts;
  }

  if (output === undefined || output === null) {
    if (media.length === 0) return '';
    return media.map((item) => mediaItemToContentPart(item));
  }

  const rawText = typeof output === 'string' ? output : (JSON.stringify(output) ?? '');
  const text = replaceTextPlaceholders(rawText, media);
  const unreferenced = media.filter((item) => !item.referenced).map((item) => mediaItemToContentPart(item));
  if (unreferenced.length === 0) return text;
  return text.length > 0 ? [{ type: 'text', text }, ...unreferenced] : unreferenced;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentRemoteToolService,
  AgentRemoteToolService,
  ScopeActivation.OnScopeCreated,
  'remoteTools',
);
