import { createHash } from 'node:crypto';
import type { ContentPart } from '#/kosong/contract/message';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IBlobStore } from '#/persistence/interface/blobStore';
import {
  BLOBREF_PROTOCOL,
  CheckpointBlobMissingError,
  IAgentBlobService,
  MISSING_MEDIA_PLACEHOLDER,
} from './agentBlobService';
import { parseMediaBlobRef } from '#/agent/media/mediaRef';
import { ByteLruCache } from './byteLruCache';

const DEFAULT_THRESHOLD = 4096;
const DEFAULT_MAX_CACHE_SIZE = 50 * 1024 * 1024;
const DATA_URI_HEADER_RE = /^data:([^;]+);base64,/;

interface RememberedOffload {
  readonly part: ContentPart;
  readonly hashes: readonly string[];
}

export class AgentBlobServiceImpl implements IAgentBlobService {
  declare readonly _serviceBrand: undefined;

  private readonly storageScope: string;
  private readonly cache = new ByteLruCache(DEFAULT_MAX_CACHE_SIZE);
  private readonly offloadedPartRefs = new WeakMap<ContentPart, RememberedOffload>();

  constructor(
    @IBlobStore private readonly blobs: IBlobStore,
    @IAgentScopeContext agentCtx: IAgentScopeContext,
  ) {
    this.storageScope = agentCtx.scope('blobs');
  }

  protected get threshold(): number {
    return DEFAULT_THRESHOLD;
  }

  isBlobRef(url: string): boolean {
    return url.startsWith(BLOBREF_PROTOCOL);
  }

  async offloadParts(parts: readonly ContentPart[]): Promise<readonly ContentPart[]> {
    let changed = false;
    const out: ContentPart[] = [];
    for (const part of parts) {
      const next = await this.offloadContentPart(part);
      if (next !== part) changed = true;
      out.push(next);
    }
    return changed ? out : parts;
  }

  async loadParts(parts: readonly ContentPart[]): Promise<readonly ContentPart[]> {
    return this.loadPartsInternal(parts, false);
  }

  async loadPartsStrict(parts: readonly ContentPart[]): Promise<readonly ContentPart[]> {
    return this.loadPartsInternal(parts, true);
  }

  private async loadPartsInternal(parts: readonly ContentPart[], strict: boolean): Promise<readonly ContentPart[]> {
    let changed = false;
    const out: ContentPart[] = [];
    for (const part of parts) {
      const next = await this.loadContentPart(part, strict);
      if (next !== part) changed = true;
      out.push(next);
    }
    return changed ? out : parts;
  }

  private async offloadContentPart(part: ContentPart): Promise<ContentPart> {
    const remembered = this.offloadedPartRefs.get(part);
    if (remembered !== undefined && await this.hasAllBlobs(remembered.hashes)) {
      return remembered.part;
    }
    const hashes: string[] = [];
    const next = await this.rewriteMediaUrls(part, async (url) => {
      const rewritten = await this.maybeOffloadString(url);
      if (this.isBlobRef(rewritten)) {
        const parsed = parseBlobRef(rewritten);
        if (parsed !== undefined) hashes.push(parsed.hash);
      }
      return rewritten;
    });
    if (next !== part && hashes.length > 0) {
      this.offloadedPartRefs.set(part, { part: next, hashes });
    }
    return next;
  }

  private async loadContentPart(part: ContentPart, strict: boolean): Promise<ContentPart> {
    const hashes: string[] = [];
    let allResolved = true;
    const next = await this.rewriteMediaUrls(part, async (url) => {
      if (!this.isBlobRef(url)) return url;
      const parsed = parseBlobRef(url);
      if (parsed === undefined) {
        allResolved = false;
        if (strict) throw new CheckpointBlobMissingError(url);
        return MISSING_MEDIA_PLACEHOLDER;
      }
      const loaded = await this.loadBlobRefUrl(parsed);
      if (loaded === undefined) {
        allResolved = false;
        if (strict) throw new CheckpointBlobMissingError(url);
        return MISSING_MEDIA_PLACEHOLDER;
      }
      hashes.push(parsed.hash);
      return loaded;
    });
    if (next !== part && allResolved && hashes.length > 0) {
      this.offloadedPartRefs.set(next, { part, hashes });
    }
    return next;
  }

  private async hasAllBlobs(hashes: readonly string[]): Promise<boolean> {
    for (const hash of hashes) {
      const present = await this.blobs.has(this.storageScope, hash).catch(() => false);
      if (!present) {
        this.cache.delete?.(hash);
        return false;
      }
    }
    return true;
  }

  private async rewriteMediaUrls(
    part: ContentPart,
    transformUrl: (url: string) => Promise<string>,
  ): Promise<ContentPart> {
    let updated: Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(part)) {
      const mediaObj = asMediaContainer(value);
      if (mediaObj === undefined) continue;

      const url = mediaObj.url;
      if (typeof url !== 'string') continue;

      const newUrl = await transformUrl(url);
      if (newUrl === url) continue;

      if (updated === undefined) updated = { ...part };
      updated[key] = { ...(value as object), url: newUrl };
    }
    return updated === undefined ? part : (updated as unknown as ContentPart);
  }

  private async loadBlobRefUrl(ref: { readonly mimeType: string; readonly hash: string }): Promise<string | undefined> {
    const payload = await this.readBlob(ref.hash);
    if (payload === undefined) return undefined;

    return formatDataUri(ref.mimeType, payload);
  }

  private async readBlob(hash: string): Promise<Buffer | undefined> {
    const cached = this.cache.get(hash);
    if (cached !== undefined) {
      const exists = await this.blobs.has(this.storageScope, hash).catch(() => false);
      if (exists) return cached;
      this.cache.delete?.(hash);
      return undefined;
    }

    const payload = await this.blobs.get(this.storageScope, hash).catch(() => undefined);
    if (payload === undefined) return undefined;

    const buffer = Buffer.from(payload);
    this.cache.set(hash, buffer);
    return buffer;
  }

  private async maybeOffloadString(value: string): Promise<string> {
    if (this.isBlobRef(value)) return value;

    const match = DATA_URI_HEADER_RE.exec(value);
    if (match === null) return value;

    const mimeType = match[1]!;
    const payload = value.slice(match[0].length);
    if (payload.length < this.threshold) return value;

    return this.writeBlob(mimeType, payload);
  }

  private async writeBlob(mimeType: string, base64Payload: string): Promise<string> {
    const hash = createHash('sha256').update(base64Payload, 'utf8').digest('hex');
    const exists = await this.blobs.has(this.storageScope, hash).catch(() => false);
    if (!exists) {
      const binary = Buffer.from(base64Payload, 'base64');
      await this.blobs.put(this.storageScope, hash, binary);
      this.cache.set(hash, binary);
    }
    return formatBlobRef(mimeType, hash);
  }
}

function formatBlobRef(mimeType: string, hash: string): string {
  return `${BLOBREF_PROTOCOL}${mimeType};${hash}`;
}

function parseBlobRef(url: string): { mimeType: string; hash: string } | undefined {
  const ref = parseMediaBlobRef(url);
  return ref?.kind === 'mime' ? { mimeType: ref.mime, hash: ref.hash } : undefined;
}

function formatDataUri(mimeType: string, payload: Buffer): string {
  return `data:${mimeType};base64,${payload.toString('base64')}`;
}

function asMediaContainer(value: unknown): { url: unknown } | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  return 'url' in obj ? (obj as { url: unknown }) : undefined;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentBlobService,
  AgentBlobServiceImpl,
  ScopeActivation.OnScopeCreated,
  'agentBlob',
);
