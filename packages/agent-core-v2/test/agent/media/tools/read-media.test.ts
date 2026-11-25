import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as posixPath from 'node:path/posix';

import { UNKNOWN_CAPABILITY, type ModelCapability } from '#/kosong/contract/capability';
import type { ContentPart } from '#/kosong/contract/message';
import { VideoUploadUnsupportedError } from '#/kosong/contract/errors';
import { Jimp } from 'jimp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { InstantiationService } from '#/_base/di/instantiationService';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import { Emitter } from '#/_base/event';
import {
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
} from '#/_base/errors/unexpectedError';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import type { Runtime } from '#/runtime/runtime';
import { ITelemetryService, type TelemetryProperties } from '#/app/telemetry/telemetry';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { IMAGE_SECTION } from '#/agent/media/configSection';
import { IImageConfigBridge, ImageConfigBridge } from '#/agent/media/imageConfigBridge';
import { IAgentMediaToolsRegistrar } from '#/agent/media/mediaTools';
import {
  ReadMediaFileInputSchema,
  type ReadMediaFileInput,
  type VideoUploader,
} from '#/agent/tools/read-media-file/read-media-file';
import { ReadMediaFileTool } from '#/agent/tools/read-media-file/readMediaFileTool';
import {
  MAX_IMAGE_DECODE_BYTES,
  MAX_IMAGE_EDGE_PX,
} from '#/agent/media/image-compress';
import {
  AV_INLINE_BYTE_BUDGET,
  compressAudioForModel,
  compressVideoForModel,
  findWinGetFfmpegBinary,
  setConfiguredAvCompressRunner,
  setConfiguredAvInlineByteBudget,
  type AvCompressRunner,
} from '#/agent/media/av-compress';
import { createVideoUploader, registerMediaTools } from '#/agent/media/registerMediaTools';
import type { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { AgentMediaToolsRegistrar } from '#/agent/media/mediaToolsRegistrar';
import { AgentStateService } from '#/agent/state/agentStateService';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
} from '#/tool/toolContract';
import { EventBusService } from '#/app/event/eventBusService';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { IAgentProfileService } from '#/agent/profile/profile';
import type { ModelRequester } from '#/kosong/model/modelRequester';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { isSensitiveFile, type WorkspaceConfig } from '#/tool/path-access';
import { sniffImageDimensions } from '#/agent/media/file-type';
import { StubConfigService } from '../../../kosong/stubs';

const PARALLEL_WORKER_CONTENTION_TIMEOUT_MS = 30_000;

const WORKSPACE: WorkspaceConfig = { workspaceDir: '/workspace', additionalDirs: [] };

const PNG_WIDTH = 1920;
const PNG_HEIGHT = 1080;

afterEach(() => {
  setConfiguredAvCompressRunner(undefined);
  setConfiguredAvInlineByteBudget(undefined);
});

function pngBuffer(width = PNG_WIDTH, height = PNG_HEIGHT): Buffer {
  const buf = Buffer.alloc(24);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function mp4Buffer(extraPayloadBytes = 0): Buffer {
  const ftyp = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftyp'),
    Buffer.from('mp42'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('mp42isom'),
  ]);
  const moovSize = 8 + extraPayloadBytes;
  const moov = Buffer.alloc(moovSize);
  moov.writeUInt32BE(moovSize, 0);
  moov.write('moov', 4, 'latin1');
  if (extraPayloadBytes > 0) moov.fill(0x22, 8);
  return Buffer.concat([ftyp, moov]);
}

function unfinalizedMp4Buffer(): Buffer {
  const ftyp = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftyp'),
    Buffer.from('isom'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('isommp41'),
  ]);
  const free = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x66, 0x72, 0x65, 0x65]);
  const mdat = Buffer.alloc(64);
  mdat.writeUInt32BE(64, 0);
  mdat.write('mdat', 4, 'latin1');
  return Buffer.concat([ftyp, free, mdat]);
}

function wavBuffer(): Buffer {
  return Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from('WAVE'),
    Buffer.from('fmt '),
    Buffer.alloc(28),
  ]);
}

function withExifOrientation(jpeg: Uint8Array, orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  tiff.writeUInt32LE(0, 22);
  const exifBody = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1Header = Buffer.alloc(4);
  app1Header.writeUInt16BE(0xff_e1, 0);
  app1Header.writeUInt16BE(exifBody.length + 2, 2);
  return Buffer.concat([
    Buffer.from(jpeg.subarray(0, 2)),
    app1Header,
    exifBody,
    Buffer.from(jpeg.subarray(2)),
  ]);
}

interface TelemetryRecord {
  readonly event: string;
  readonly properties: Readonly<Record<string, unknown>> | undefined;
}

function recordingTelemetry(records: TelemetryRecord[]): ITelemetryService {
  const telemetry: ITelemetryService = {
    _serviceBrand: undefined,
    track(event, properties) {
      records.push({ event, properties });
    },
    track2: (event, properties) => telemetry.track(event, properties as TelemetryProperties),
    withContext: () => telemetry,
    setContext: () => {},
    addAppender: () => ({ dispose: () => {} }),
    removeAppender: () => {},
    setAppender: () => {},
    setEnabled: () => {},
    flush: async () => {},
    shutdown: async () => {},
  };
  return telemetry;
}

function capabilities(overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    image_in: true,
    video_in: true,
    audio_in: false,
    thinking: false,
    tool_use: true,
    max_context_tokens: 0,
    ...overrides,
  };
}

interface FakeFile {
  readonly data: Buffer;
  readonly size?: number;
}

function createTestFs(files: Record<string, FakeFile>): IHostFileSystem {
  const lookup = (path: string): FakeFile | undefined => files[path];
  return {
    realpath: async (path: string) => path,
    readBytes: vi.fn(async (path: string, n?: number) => {
      const data = lookup(path)?.data ?? Buffer.alloc(0);
      return n === undefined ? data : data.subarray(0, n);
    }),
    stat: vi.fn(async (path: string) => {
      const file = lookup(path);
      return {
        isFile: true,
        isDirectory: false,
        size: file?.size ?? file?.data.length ?? 0,
      };
    }),
  } as unknown as IHostFileSystem;
}

function createTestEnv(): IHostEnvironment {
  return {
    _serviceBrand: undefined,
    osKind: 'Linux',
    osArch: 'x86_64',
    osVersion: 'test',
    shellName: 'bash',
    shellPath: '/bin/bash',
    pathClass: 'posix',
    homeDir: '/home',
    ready: Promise.resolve(),
  };
}

function runtimeFor(
  fs: IHostFileSystem,
  env: IHostEnvironment = createTestEnv(),
  runtimeId = 'local',
): IAgentRuntimeService {
  const runtime = {
    identity: { workspaceId: 'workspace', runtimeId, generation: 'test' },
    capabilities: new Set(['fs'] as const),
    environment: env,
    path: posixPath,
    workspace: { mapRoots: (roots: { workDir: string; additionalDirs?: readonly string[] }) => roots },
    fs,
    status: 'ready',
    onDidChangeStatus: () => ({ dispose: () => {} }),
    dispose: () => {},
  } as unknown as Runtime;
  return {
    _serviceBrand: undefined,
    onDidChange: () => ({ dispose: () => {} }),
    isAvailable: (required = []) => required.every((capability) => runtime.capabilities.has(capability)),
    inspect: () => runtime,
    acquire: () => ({
      runtime,
      track: (resource) => resource,
      dispose: () => {},
    }),
    prepareFor: async () => runtime,
    acquireFor: () => ({
      runtime,
      track: (resource) => resource,
      dispose: () => {},
    }),
  };
}

function makeTool(
  files: Record<string, FakeFile>,
  caps: ModelCapability = capabilities(),
  videoUploader?: VideoUploader,
  telemetry?: ITelemetryService,
  inlineVideoSupported?: boolean,
  workspace: WorkspaceConfig = WORKSPACE,
  runtimeId = 'local',
): ReadMediaFileTool {
  return new ReadMediaFileTool(
    runtimeFor(createTestFs(files), createTestEnv(), runtimeId),
    workspace,
    caps,
    videoUploader,
    telemetry,
    inlineVideoSupported,
  );
}

async function execute(
  tool: ReadMediaFileTool,
  args: ReadMediaFileInput,
): Promise<ExecutableToolResult> {
  const execution = await tool.resolveExecution(args);
  if (!('execute' in execution)) {
    return execution;
  }
  const ctx: ExecutableToolContext = {
    turnId: 1,
    toolCallId: 'call_media',
    signal: new AbortController().signal,
  };
  return execution.execute(ctx);
}

function outputParts(result: ExecutableToolResult): ContentPart[] {
  expect(result.isError).toBeFalsy();
  expect(Array.isArray(result.output)).toBe(true);
  return result.output as ContentPart[];
}

function noteText(result: ExecutableToolResult): string {
  expect(typeof result.note).toBe('string');
  return result.note as string;
}

describe('ReadMediaFileTool', () => {
  it('has name, parameters, and a path-scoped read access', async () => {
    const tool = makeTool({ '/workspace/sample.png': { data: pngBuffer() } });

    expect(tool.name).toBe('ReadMediaFile');
    expect(ReadMediaFileInputSchema.safeParse({ path: '/workspace/sample.png' }).success).toBe(true);
    expect(
      ReadMediaFileInputSchema.safeParse({
        path: '/workspace/sample.png',
        region: { x: 0, y: 0, width: 10, height: 10 },
      }).success,
    ).toBe(true);
    expect(
      ReadMediaFileInputSchema.safeParse({
        path: '/workspace/sample.png',
        region: { x: -1, y: 0, width: 10, height: 10 },
      }).success,
    ).toBe(false);
    expect(
      ReadMediaFileInputSchema.safeParse({
        path: '/workspace/sample.png',
        region: { x: 0, y: 0, width: 0, height: 10 },
      }).success,
    ).toBe(false);
    expect(
      ReadMediaFileInputSchema.safeParse({
        path: '/workspace/sample.png',
        full_resolution: true,
      }).success,
    ).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' } },
    });

    const execution = await tool.resolveExecution({ path: '/workspace/sample.png' });
    if (execution.isError === true) throw new Error('Expected runnable media tool');
    expect(execution.accesses).toEqual(ToolAccesses.readFile('/workspace/sample.png'));
    expect(execution.approvalRule).toBe('ReadMediaFile(/workspace/sample.png)');
  });

  it('reads only the current local session attachments root and keeps sensitive and remote checks', async () => {
    const attachmentPath = '/session/current/attachments/image.png';
    const sensitivePath = '/session/current/attachments/.env';
    const workspace = { ...WORKSPACE, sessionAttachmentsReadRoot: '/session/current/attachments' };
    const files = {
      [attachmentPath]: { data: pngBuffer() },
      [sensitivePath]: { data: pngBuffer() },
    };
    const localTool = makeTool(files, capabilities(), undefined, undefined, undefined, workspace);
    const localExecution = await localTool.resolveExecution({ path: attachmentPath });
    if (localExecution.isError === true) throw new Error('Expected local session attachment read');
    expect(localExecution.accesses).toEqual(ToolAccesses.readFile(attachmentPath));
    expect((await execute(localTool, { path: attachmentPath })).isError).toBe(false);

    const sensitiveExecution = await localTool.resolveExecution({ path: sensitivePath });
    if (sensitiveExecution.isError === true) throw new Error('Expected sensitive attachment access to remain policy-visible');
    expect(sensitiveExecution.accesses).toEqual(ToolAccesses.readFile(sensitivePath));
    expect(isSensitiveFile(sensitivePath)).toBe(true);

    const remoteTool = makeTool(files, capabilities(), undefined, undefined, undefined, workspace, 'ssh:dev');
    const remoteExecution = await remoteTool.resolveExecution({ path: attachmentPath });
    if (remoteExecution.isError === true) throw new Error('Expected remote path classification');
    expect(remoteExecution.accesses).toEqual(ToolAccesses.readFile(attachmentPath, true));
  });

  it('reflects model capabilities in its description', () => {
    expect(
      makeTool({}, capabilities({ image_in: true, video_in: true, audio_in: true })).description,
    ).toContain('image, video, and audio files');
    expect(makeTool({}, capabilities({ image_in: true, video_in: true })).description).toContain(
      'image and video files',
    );
    expect(makeTool({}, capabilities({ image_in: true, video_in: true })).description).toContain(
      'Audio files are not supported',
    );
    expect(makeTool({}, capabilities({ image_in: true, video_in: false })).description).toContain(
      'Video and audio files are not supported',
    );
    expect(makeTool({}, capabilities({ image_in: false, video_in: true })).description).toContain(
      'Image and audio files are not supported',
    );
    expect(
      makeTool({}, capabilities({ image_in: false, video_in: false, audio_in: true })).description,
    ).toContain('This tool supports audio files');
    expect(
      makeTool({}, capabilities({ image_in: false, video_in: false, audio_in: true })).description,
    ).toContain('Image and video files are not supported');
    expect(makeTool({}, capabilities({ image_in: false, video_in: false })).description).toContain(
      'does not support image, video, or audio input',
    );
  });

  it('rejects empty paths', async () => {
    const result = await execute(makeTool({}), { path: '' });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('File path cannot be empty');
  });

  it('redirects text files to the Read tool', async () => {
    const result = await execute(
      makeTool({ '/workspace/note.txt': { data: Buffer.from('hello world') } }),
      { path: '/workspace/note.txt' },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('Use Read');
  });

  it('rejects unsupported binary formats', async () => {
    const result = await execute(
      makeTool({ '/workspace/archive.zip': { data: Buffer.from([0x50, 0x4b, 0x03, 0x04]) } }),
      { path: '/workspace/archive.zip' },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('not a supported image, video, or audio file');
  });

  it('reads a small media file once and sniffs the full-read prefix', async () => {
    const fs = createTestFs({ '/workspace/sample.png': { data: pngBuffer() } });
    const result = await execute(new ReadMediaFileTool(runtimeFor(fs), WORKSPACE, capabilities()), {
      path: '/workspace/sample.png',
    });

    expect(result.isError).toBe(false);
    expect(vi.mocked(fs.readBytes)).toHaveBeenCalledOnce();
    expect(vi.mocked(fs.readBytes)).toHaveBeenCalledWith('/workspace/sample.png');
  });

  it('returns a text/image/text wrap plus a <system> note for PNG files', async () => {
    const result = await execute(makeTool({ '/workspace/sample.png': { data: pngBuffer() } }), {
      path: '/workspace/sample.png',
    });

    const systemText = noteText(result);
    expect(systemText).toMatch(/^<system>.*<\/system>$/s);
    expect(systemText).toContain('Mime type: image/png');
    expect(systemText).toContain(`Original dimensions: ${PNG_WIDTH}x${PNG_HEIGHT}`);
    expect(systemText).toMatch(/relative coordinates first/i);
    expect(systemText).not.toMatch(/read the result back/i);

    const parts = outputParts(result);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ type: 'text', text: '<image path="/workspace/sample.png">' });
    expect(parts[1]).toMatchObject({
      type: 'image_url',
      imageUrl: { url: expect.stringContaining('data:image/png;base64,') },
    });
    expect(parts[2]).toEqual({ type: 'text', text: '</image>' });
  });

  it('records a resolved absolute image path when invoked with a relative path', async () => {
    const tool = makeTool({ '/workspace/sample.png': { data: pngBuffer() } });
    const execution = await tool.resolveExecution({ path: './sample.png' });
    expect(execution).toMatchObject({ display: { kind: 'file_io', path: '/workspace/sample.png' } });
    expect(outputParts(await execute(tool, { path: './sample.png' }))[0]).toEqual({
      type: 'text', text: '<image path="/workspace/sample.png">',
    });
  });

  it('downsamples large images and points the model to region readback', async () => {
    const big = Buffer.from(
      await new Jimp({ width: 2200, height: 2200, color: 0x3366ccff }).getBuffer('image/png'),
    );
    expect(sniffImageDimensions(big)).toEqual({ width: 2200, height: 2200 });

    const result = await execute(makeTool({ '/workspace/big.png': { data: big } }), {
      path: '/workspace/big.png',
    });

    const systemText = noteText(result);
    expect(systemText).toContain('2200x2200');
    expect(systemText).toContain(`${String(big.length)} bytes`);
    expect(systemText).toMatch(/The attached image was downsampled to 2000x2000/);
    expect(systemText).toMatch(/fine detail/i);
    expect(systemText).toContain('region');

    const parts = outputParts(result);
    const url = (parts[1] as { imageUrl: { url: string } }).imageUrl.url;
    const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(url);
    expect(match).not.toBeNull();
    const dims = sniffImageDimensions(Buffer.from(match![2]!, 'base64'));
    expect(Math.max(dims!.width, dims!.height)).toBeLessThanOrEqual(2000);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('returns an actionable error when compression cannot meet the byte budget', async () => {
    const oversized = Buffer.concat([pngBuffer(), Buffer.alloc(256 * 1024, 1)]);

    const result = await execute(
      makeTool({ '/workspace/oversized.png': { data: oversized } }),
      { path: '/workspace/oversized.png' },
    );

    expect(result).toEqual({
      isError: true,
      runtimeId: 'local',
      output:
        'Image is too large to send safely after compression (262168 bytes; limit 262144 bytes and 2000px on the longest edge). ' +
        'The original image was not sent to the model. Do not retry the same file unchanged. ' +
        'Use Bash or an available image-processing tool to create a smaller copy within both limits, ' +
        'then call ReadMediaFile on the smaller copy.',
    });
  });

  it('returns an actionable error when compression cannot meet the pixel budget', async () => {
    const result = await execute(
      makeTool({ '/workspace/wide.png': { data: pngBuffer(2001, 1000) } }),
      { path: '/workspace/wide.png' },
    );

    expect(result).toEqual({
      isError: true,
      runtimeId: 'local',
      output:
        'Image is too large to send safely after compression (24 bytes; limit 262144 bytes and 2000px on the longest edge). ' +
        'The original image was not sent to the model. Do not retry the same file unchanged. ' +
        'Use Bash or an available image-processing tool to create a smaller copy within both limits, ' +
        'then call ReadMediaFile on the smaller copy.',
    });
  });

  it('reads only the sniff header when the default image exceeds the safe decode allocation', async () => {
    const fs = createTestFs({
      '/workspace/huge.png': { data: pngBuffer(), size: MAX_IMAGE_DECODE_BYTES + 1 },
    });
    const tool = new ReadMediaFileTool(runtimeFor(fs), WORKSPACE, capabilities());

    const result = await execute(tool, { path: '/workspace/huge.png' });

    expect(result).toEqual({
      isError: true,
      runtimeId: 'local',
      output:
        'Image is too large to send safely after compression (67108865 bytes; limit 262144 bytes and 2000px on the longest edge). ' +
        'The original image was not sent to the model. Do not retry the same file unchanged. ' +
        'Use Bash or an available image-processing tool to create a smaller copy within both limits, ' +
        'then call ReadMediaFile on the smaller copy.',
    });
    expect(vi.mocked(fs.readBytes)).toHaveBeenCalledOnce();
    expect(vi.mocked(fs.readBytes)).toHaveBeenCalledWith('/workspace/huge.png', 512);
  });

  it('does not treat the decode allocation cap as a hard limit when the configured delivery budget accepts the file', async () => {
    const fs = createTestFs({
      '/workspace/large.png': { data: pngBuffer(), size: MAX_IMAGE_DECODE_BYTES + 1 },
    });
    const tool = new ReadMediaFileTool(
      runtimeFor(fs),
      WORKSPACE,
      capabilities(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { maxEdgePx: MAX_IMAGE_EDGE_PX, readByteBudget: 70 * 1024 * 1024 },
    );

    const result = await execute(tool, { path: '/workspace/large.png' });

    expect(result.isError).toBe(false);
    expect(vi.mocked(fs.readBytes)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fs.readBytes)).toHaveBeenLastCalledWith('/workspace/large.png');
  });

  it('returns external preprocessing guidance before loading an oversized region source', async () => {
    const fs = createTestFs({
      '/workspace/huge.png': { data: pngBuffer(), size: MAX_IMAGE_DECODE_BYTES + 1 },
    });
    const tool = new ReadMediaFileTool(runtimeFor(fs), WORKSPACE, capabilities());

    const result = await execute(tool, {
      path: '/workspace/huge.png',
      region: { x: 0, y: 0, width: 100, height: 100 },
    });

    expect(result).toEqual({
      isError: true,
      runtimeId: 'local',
      output:
        'Image is too large to process safely for region or full_resolution (67108865 bytes; safe decode limit 67108864 bytes). ' +
        'The original image was not sent to the model. Do not retry the same file unchanged. ' +
        'Use Bash or an available image-processing tool to create a smaller copy or crop the needed ' +
        'region into a separate image, then call ReadMediaFile on the resulting file.',
    });
    expect(vi.mocked(fs.readBytes)).toHaveBeenCalledOnce();
    expect(vi.mocked(fs.readBytes)).toHaveBeenCalledWith('/workspace/huge.png', 512);
  });

  it('does not claim downsampling for an image sent untouched', async () => {
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000030000000408020000003a' +
        '63dc1c0000001949444154789c63606060f8cf80019aa0a8a020' +
        '00000000ffff03000c1d03014b0000000049454e44ae426082',
      'hex',
    );
    const result = await execute(makeTool({ '/workspace/small.png': { data: png } }), {
      path: '/workspace/small.png',
    });
    expect(noteText(result)).not.toMatch(/downsampled/i);
  });

  it('reads image regions at native resolution', async () => {
    const big = Buffer.from(
      await new Jimp({ width: 2100, height: 2100, color: 0x3366ccff }).getBuffer('image/png'),
    );
    const result = await execute(makeTool({ '/workspace/big.png': { data: big } }), {
      path: '/workspace/big.png',
      region: { x: 100, y: 50, width: 400, height: 300 },
    });
    const parts = outputParts(result);
    const url = (parts[1] as { imageUrl: { url: string } }).imageUrl.url;
    const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(url);
    expect(match).not.toBeNull();
    expect(sniffImageDimensions(Buffer.from(match![2]!, 'base64'))).toEqual({
      width: 400,
      height: 300,
    });
    const systemText = noteText(result);
    expect(systemText).toContain('2100x2100');
    expect(systemText).toMatch(/region \(x=100, y=50, width=400, height=300\)/);
    expect(systemText).toMatch(/native resolution/);
    expect(systemText).toContain('offset');
  });

  it('rejects a region outside the image with the original size in the error', async () => {
    const big = Buffer.from(
      await new Jimp({ width: 2100, height: 2100, color: 0x3366ccff }).getBuffer('image/png'),
    );
    const result = await execute(makeTool({ '/workspace/big.png': { data: big } }), {
      path: '/workspace/big.png',
      region: { x: 5000, y: 0, width: 100, height: 100 },
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('2100x2100');
  });

  it('serves full_resolution when the bytes fit the per-image budget', async () => {
    const big = Buffer.from(
      await new Jimp({ width: 2100, height: 1050, color: 0x3366ccff }).getBuffer('image/png'),
    );
    const result = await execute(makeTool({ '/workspace/big.png': { data: big } }), {
      path: '/workspace/big.png',
      full_resolution: true,
    });

    const parts = outputParts(result);
    expect((parts[1] as { imageUrl: { url: string } }).imageUrl.url).toBe(
      `data:image/png;base64,${big.toString('base64')}`,
    );
    expect(noteText(result)).toMatch(/native resolution/);
  });

  it('returns the existing full_resolution limit error before loading an over-budget image', async () => {
    const data = Buffer.concat([pngBuffer(), Buffer.alloc(4 * 1024 * 1024, 1)]);
    const fs = createTestFs({ '/workspace/huge.png': { data } });
    const tool = new ReadMediaFileTool(runtimeFor(fs), WORKSPACE, capabilities());

    const result = await execute(tool, {
      path: '/workspace/huge.png',
      full_resolution: true,
    });
    expect(result).toEqual({
      isError: true,
      runtimeId: 'local',
      output:
        '"/workspace/huge.png" is 4194328 bytes (4.0 MB), over the 3932160-byte (3.8 MB) ' +
        'per-image limit, so full_resolution cannot be honored. ' +
        'Use region to view a crop at full fidelity instead.',
    });
    expect(vi.mocked(fs.readBytes)).toHaveBeenCalledOnce();
    expect(vi.mocked(fs.readBytes)).toHaveBeenCalledWith('/workspace/huge.png', 512);
  });

  it('prioritizes external preprocessing guidance for full_resolution above the decode cap', async () => {
    const fs = createTestFs({
      '/workspace/huge.png': { data: pngBuffer(), size: MAX_IMAGE_DECODE_BYTES + 1 },
    });
    const tool = new ReadMediaFileTool(runtimeFor(fs), WORKSPACE, capabilities());

    const result = await execute(tool, {
      path: '/workspace/huge.png',
      full_resolution: true,
    });

    expect(result).toEqual({
      isError: true,
      runtimeId: 'local',
      output:
        'Image is too large to process safely for region or full_resolution (67108865 bytes; safe decode limit 67108864 bytes). ' +
        'The original image was not sent to the model. Do not retry the same file unchanged. ' +
        'Use Bash or an available image-processing tool to create a smaller copy or crop the needed ' +
        'region into a separate image, then call ReadMediaFile on the resulting file.',
    });
    expect(vi.mocked(fs.readBytes)).toHaveBeenCalledOnce();
    expect(vi.mocked(fs.readBytes)).toHaveBeenCalledWith('/workspace/huge.png', 512);
  });

  it('reports an EXIF-rotated original in the decoded coordinate space', async () => {
    const portrait = withExifOrientation(
      new Uint8Array(
        await new Jimp({ width: 2200, height: 1100, color: 0x3366ccff }).getBuffer('image/jpeg', {
          quality: 90,
        }),
      ),
      6,
    );
    const result = await execute(makeTool({ '/workspace/portrait.jpg': { data: portrait } }), {
      path: '/workspace/portrait.jpg',
    });

    const systemText = noteText(result);
    expect(systemText).toContain('Original dimensions: 1100x2200');
    expect(systemText).toMatch(/downsampled to 1000x2000/);
  }, 15000);

  it('reports the decoded size for a region read of an EXIF-rotated image', async () => {
    const portrait = withExifOrientation(
      new Uint8Array(
        await new Jimp({ width: 120, height: 80, color: 0x3366ccff }).getBuffer('image/jpeg', {
          quality: 90,
        }),
      ),
      6,
    );
    const result = await execute(makeTool({ '/workspace/portrait.jpg': { data: portrait } }), {
      path: '/workspace/portrait.jpg',
      region: { x: 0, y: 0, width: 40, height: 40 },
    });

    expect(noteText(result)).toContain('Original dimensions: 80x120');
  });

  it('reports display-space dimensions for an EXIF-rotated image sent untouched', async () => {
    const portrait = withExifOrientation(
      new Uint8Array(
        await new Jimp({ width: 120, height: 80, color: 0x3366ccff }).getBuffer('image/jpeg', {
          quality: 90,
        }),
      ),
      6,
    );
    const result = await execute(makeTool({ '/workspace/portrait.jpg': { data: portrait } }), {
      path: '/workspace/portrait.jpg',
    });

    const systemText = noteText(result);
    expect(systemText).toContain('Original dimensions: 80x120');
    expect(systemText).not.toMatch(/downsampled/i);
  });

  it('emits image_compress and image_crop telemetry tagged read_media', async () => {
    const records: TelemetryRecord[] = [];
    const big = Buffer.from(
      await new Jimp({ width: 2200, height: 1100, color: 0x3366ccff }).getBuffer('image/png'),
    );
    const tool = makeTool(
      { '/workspace/big.png': { data: big } },
      capabilities(),
      undefined,
      recordingTelemetry(records),
    );

    await execute(tool, { path: '/workspace/big.png' });
    expect(records).toHaveLength(1);
    expect(records[0]!.event).toBe('image_compress');
    expect(records[0]!.properties?.['source']).toBe('read_media');
    expect(records[0]!.properties?.['outcome']).toBe('compressed');

    await execute(tool, {
      path: '/workspace/big.png',
      region: { x: 0, y: 0, width: 100, height: 100 },
    });
    expect(records).toHaveLength(2);
    expect(records[1]!.event).toBe('image_crop');
    expect(records[1]!.properties?.['source']).toBe('read_media');
    expect(records[1]!.properties?.['ok']).toBe(true);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('errors when reading an image without image input capability', async () => {
    const result = await execute(
      makeTool(
        { '/workspace/sample.png': { data: pngBuffer() } },
        capabilities({ image_in: false, video_in: true }),
      ),
      { path: '/workspace/sample.png' },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('does not support image input');
  });

  it('wraps a video as a data URL when no uploader is provided', async () => {
    const result = await execute(makeTool({ '/workspace/clip.mp4': { data: mp4Buffer() } }), {
      path: '/workspace/clip.mp4',
    });

    const systemText = noteText(result);
    expect(systemText).toMatch(/^<system>.*<\/system>$/s);
    expect(systemText).toContain('video/mp4');

    const parts = outputParts(result);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ type: 'text', text: '<video path="/workspace/clip.mp4">' });
    expect(parts[1]).toMatchObject({
      type: 'video_url',
      videoUrl: { url: expect.stringContaining('data:video/mp4;base64,') },
    });
    expect(parts[2]).toEqual({ type: 'text', text: '</video>' });
  });

  it('rejects region for videos while honoring full_resolution to skip local pre-compression', async () => {
    const bigVideo = mp4Buffer(512);
    setConfiguredAvInlineByteBudget(128);
    const runner = vi.fn<AvCompressRunner>(async () => ({ stdout: '', stderr: '' }));
    setConfiguredAvCompressRunner(runner);

    const tool = makeTool({ '/workspace/clip.mp4': { data: bigVideo } });
    const withRegion = await execute(tool, {
      path: '/workspace/clip.mp4',
      region: { x: 0, y: 0, width: 10, height: 10 },
    });
    expect(withRegion.isError).toBe(true);
    expect(withRegion.output).toBe('region applies only to image files.');

    const withFullResolution = await execute(tool, {
      path: '/workspace/clip.mp4',
      full_resolution: true,
    });
    expect(withFullResolution.isError).toBe(false);
    expect(runner).not.toHaveBeenCalled();
    expect(noteText(withFullResolution)).toContain('local pre-compression skipped');
    const parts = outputParts(withFullResolution);
    expect(parts[1]).toEqual({
      type: 'video_url',
      videoUrl: { url: `data:video/mp4;base64,${bigVideo.toString('base64')}` },
    });
  });

  it('returns an inline audio_url part and <audio> wrapper when audio_in is supported', async () => {
    const audio = wavBuffer();
    const result = await execute(
      makeTool(
        { '/workspace/clip.wav': { data: audio } },
        capabilities({ image_in: false, video_in: false, audio_in: true }),
      ),
      { path: '/workspace/clip.wav' },
    );

    const systemText = noteText(result);
    expect(systemText).toMatch(/^<system>.*<\/system>$/s);
    expect(systemText).toContain('Read audio file.');
    expect(systemText).toContain('Mime type: audio/wav.');
    expect(systemText).toContain(`Size: ${String(audio.length)} bytes.`);

    const parts = outputParts(result);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ type: 'text', text: '<audio path="/workspace/clip.wav">' });
    expect(parts[1]).toEqual({
      type: 'audio_url',
      audioUrl: { url: `data:audio/wav;base64,${audio.toString('base64')}` },
    });
    expect(parts[2]).toEqual({ type: 'text', text: '</audio>' });
  });

  it('errors when reading audio without audio input capability', async () => {
    const result = await execute(
      makeTool(
        { '/workspace/clip.wav': { data: wavBuffer() } },
        capabilities({ image_in: true, video_in: true, audio_in: false }),
      ),
      { path: '/workspace/clip.wav' },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toBe(
      'The current model does not support audio input. Tell the user to use a model with audio input capability.',
    );
  });

  it('rejects region, empty, and oversized audio files while honoring full_resolution', async () => {
    const caps = capabilities({ audio_in: true });
    const bigAudio = Buffer.concat([wavBuffer(), Buffer.alloc(512, 0x33)]);
    setConfiguredAvInlineByteBudget(128);
    const runner = vi.fn<AvCompressRunner>(async () => ({ stdout: '', stderr: '' }));
    setConfiguredAvCompressRunner(runner);
    const tool = makeTool({ '/workspace/clip.wav': { data: bigAudio } }, caps);

    const withRegion = await execute(tool, {
      path: '/workspace/clip.wav',
      region: { x: 0, y: 0, width: 10, height: 10 },
    });
    expect(withRegion.isError).toBe(true);
    expect(withRegion.output).toBe('region applies only to image files.');

    const withFullRes = await execute(tool, {
      path: '/workspace/clip.wav',
      full_resolution: true,
    });
    expect(withFullRes.isError).toBe(false);
    expect(runner).not.toHaveBeenCalled();
    expect(noteText(withFullRes)).toContain('local pre-compression skipped');
    expect(outputParts(withFullRes)[1]).toEqual({
      type: 'audio_url',
      audioUrl: { url: `data:audio/wav;base64,${bigAudio.toString('base64')}` },
    });

    const empty = await execute(
      makeTool({ '/workspace/empty.wav': { data: wavBuffer(), size: 0 } }, caps),
      { path: '/workspace/empty.wav' },
    );
    expect(empty.isError).toBe(true);
    expect(empty.output).toContain('is empty');

    const oversized = await execute(
      makeTool({ '/workspace/huge.wav': { data: wavBuffer(), size: 101 * 1024 * 1024 } }, caps),
      { path: '/workspace/huge.wav' },
    );
    expect(oversized.isError).toBe(true);
    expect(oversized.output).toContain('exceeds the maximum');
  });

  it('pre-compresses oversized inline video and audio and falls back gracefully when ffmpeg is missing', async () => {
    expect(AV_INLINE_BYTE_BUDGET).toBe(12 * 1024 * 1024);
    const smallVideo = mp4Buffer();
    const pass1Mp4 = mp4Buffer(568);
    const pass2Mp4 = mp4Buffer(48);
    const compressedMp3 = Buffer.concat([Buffer.from('ID3\x03\x00\x00'), Buffer.alloc(58, 0xcc)]);
    const runner = vi.fn<AvCompressRunner>(async (cmd, args) => {
      if (cmd.includes('ffprobe')) return { stdout: '30/1\n', stderr: '' };
      const outPath = args.at(-1)!;
      if (outPath.endsWith('out-pass1.mp4')) {
        await writeFile(outPath, pass1Mp4);
      } else if (outPath.endsWith('out-pass2.mp4')) {
        await writeFile(outPath, pass2Mp4);
      } else if (outPath.endsWith('.mp3')) {
        await writeFile(outPath, compressedMp3);
      }
      return { stdout: '', stderr: '' };
    });
    setConfiguredAvInlineByteBudget(200);
    setConfiguredAvCompressRunner(runner);

    const smallResult = await execute(makeTool({ '/workspace/small.mp4': { data: smallVideo } }), {
      path: '/workspace/small.mp4',
    });
    expect(smallResult.isError).toBe(false);
    expect(runner).not.toHaveBeenCalled();

    const bigVideo = mp4Buffer(1024);
    const videoResult = await execute(makeTool({ '/workspace/big.mp4': { data: bigVideo } }), {
      path: '/workspace/big.mp4',
    });
    expect(videoResult.isError).toBe(false);
    expect(noteText(videoResult)).toContain('pre-compressed to video/mp4');
    expect(outputParts(videoResult)[1]).toEqual({
      type: 'video_url',
      videoUrl: { url: `data:video/mp4;base64,${pass2Mp4.toString('base64')}` },
    });
    const ffmpegCalls = runner.mock.calls.filter(([cmd]) => !cmd.includes('ffprobe'));
    expect(ffmpegCalls).toHaveLength(2);
    expect(ffmpegCalls[0]![1]).toContain('fps=fps=2:round=near,scale=\'trunc(min(1280,iw)/2)*2\':-2:flags=lanczos');
    expect(ffmpegCalls[1]![1]).toContain('fps=fps=1:round=near,scale=\'trunc(min(960,iw)/2)*2\':-2:flags=lanczos');

    const bigAudio = Buffer.concat([wavBuffer(), Buffer.alloc(1024, 0x22)]);
    const audioResult = await execute(
      makeTool({ '/workspace/big.wav': { data: bigAudio } }, capabilities({ audio_in: true })),
      { path: '/workspace/big.wav' },
    );
    expect(audioResult.isError).toBe(false);
    expect(noteText(audioResult)).toContain('pre-compressed to audio/mpeg');
    expect(outputParts(audioResult)[1]).toEqual({
      type: 'audio_url',
      audioUrl: { url: `data:audio/mpeg;base64,${compressedMp3.toString('base64')}` },
    });

    const missingFfmpeg: AvCompressRunner = async () => {
      throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
    };
    const fallbackVideo = await compressVideoForModel(bigVideo, 'video/mp4', {
      byteBudget: 200,
      runner: missingFfmpeg,
    });
    expect(fallbackVideo.changed).toBe(false);
    expect(Buffer.compare(Buffer.from(fallbackVideo.data), bigVideo)).toBe(0);

    const fallbackAudio = await compressAudioForModel(bigAudio, 'audio/wav', {
      byteBudget: 200,
      runner: missingFfmpeg,
    });
    expect(fallbackAudio.changed).toBe(false);
    expect(Buffer.compare(Buffer.from(fallbackAudio.data), bigAudio)).toBe(0);

    const controller = new AbortController();
    controller.abort();
    await expect(
      compressVideoForModel(bigVideo, 'video/mp4', { byteBudget: 200, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('uses the video uploader when provided', async () => {
    const uploadResult = {
      type: 'video_url' as const,
      videoUrl: { url: 'https://example.com/uploaded.mp4' },
    };
    const videoUploader = vi.fn<VideoUploader>().mockResolvedValue(uploadResult);
    const result = await execute(
      makeTool({ '/workspace/clip.mp4': { data: mp4Buffer() } }, capabilities(), videoUploader),
      { path: '/workspace/clip.mp4' },
    );
    const parts = outputParts(result);
    expect(videoUploader).toHaveBeenCalledOnce();
    expect(videoUploader).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'video/mp4', filename: 'clip.mp4' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(parts[1]).toEqual(uploadResult);
  });

  it('falls back to an inline base64 video part when the upload fails', async () => {
    const videoUploader = vi.fn<VideoUploader>().mockRejectedValue(new Error('404 route not found'));
    const result = await execute(
      makeTool({ '/workspace/clip.mp4': { data: mp4Buffer() } }, capabilities(), videoUploader),
      { path: '/workspace/clip.mp4' },
    );
    expect(result.isError).not.toBe(true);
    const parts = outputParts(result);
    expect(videoUploader).toHaveBeenCalledOnce();
    expect(parts[1]).toEqual({
      type: 'video_url',
      videoUrl: { url: `data:video/mp4;base64,${mp4Buffer().toString('base64')}` },
    });
  });

  it('surfaces auth rejections from the upload channel instead of falling back', async () => {
    const videoUploader = vi
      .fn<VideoUploader>()
      .mockRejectedValue(Object.assign(new Error('401 Unauthorized'), { statusCode: 401 }));
    const result = await execute(
      makeTool({ '/workspace/clip.mp4': { data: mp4Buffer() } }, capabilities(), videoUploader),
      { path: '/workspace/clip.mp4' },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('401 Unauthorized');
  });

  it('surfaces the by-design no-hook error instead of falling back to inline', async () => {
    const videoUploader = vi
      .fn<VideoUploader>()
      .mockRejectedValue(
        new VideoUploadUnsupportedError(
          'Model "stub" (protocol=openai) does not support video upload',
        ),
      );
    const result = await execute(
      makeTool({ '/workspace/clip.mp4': { data: mp4Buffer() } }, capabilities(), videoUploader),
      { path: '/workspace/clip.mp4' },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('does not support video upload');
  });

  it('falls back to inline for a no-hook provider whose wire carries video', async () => {
    const videoUploader = vi
      .fn<VideoUploader>()
      .mockRejectedValue(
        new VideoUploadUnsupportedError(
          'Model "gemini-stub" (protocol=google-genai) does not support video upload',
        ),
      );
    const result = await execute(
      makeTool(
        { '/workspace/clip.mp4': { data: mp4Buffer() } },
        capabilities(),
        videoUploader,
        undefined,
        true,
      ),
      { path: '/workspace/clip.mp4' },
    );
    expect(result.isError).not.toBe(true);
    const parts = outputParts(result);
    expect(parts[1]).toEqual({
      type: 'video_url',
      videoUrl: { url: `data:video/mp4;base64,${mp4Buffer().toString('base64')}` },
    });
  });

  it('rejects unfinalized MP4 missing moov and truncated WAV before admitting media into history', async () => {
    const videoUploader = vi.fn<VideoUploader>();
    const unfinalized = await execute(
      makeTool({ '/workspace/recording.mp4': { data: unfinalizedMp4Buffer() } }, capabilities(), videoUploader),
      { path: '/workspace/recording.mp4' },
    );
    expect(unfinalized.isError).toBe(true);
    expect(unfinalized.output).toContain('moov');
    expect(unfinalized.output).toContain('unfinalized');
    expect(videoUploader).not.toHaveBeenCalled();

    const truncatedWav = await execute(
      makeTool(
        { '/workspace/truncated.wav': { data: Buffer.from('RIFF\x04\x00\x00\x00WAVE') } },
        capabilities({ audio_in: true }),
      ),
      { path: '/workspace/truncated.wav' },
    );
    expect(truncatedWav.isError).toBe(true);
    expect(truncatedWav.output).toContain('truncated');
  });

  it('rejects empty files', async () => {
    const result = await execute(
      makeTool({ '/workspace/sample.png': { data: pngBuffer(), size: 0 } }),
      { path: '/workspace/sample.png' },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('is empty');
  });

  it('rejects files larger than the media limit', async () => {
    const oversized = 101 * 1024 * 1024;
    const result = await execute(
      makeTool({ '/workspace/sample.png': { data: pngBuffer(), size: oversized } }),
      { path: '/workspace/sample.png' },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('exceeds the maximum');
  });
});

describe('registerMediaTools', () => {
  const fs = createTestFs({});
  const env = createTestEnv();

  it('registers ReadMediaFile when the model supports image input', async () => {
    const registry = new AgentToolRegistryService();
    const disposable = registerMediaTools(registry, {
      runtime: runtimeFor(fs, env),
      workspace: WORKSPACE,
      capabilities: capabilities({ image_in: true, video_in: false }),
    });
    expect(registry.resolve('ReadMediaFile')).toBeInstanceOf(ReadMediaFileTool);
    await disposable.dispose();
    expect(registry.resolve('ReadMediaFile')).toBeUndefined();
  });

  it('registers ReadMediaFile when the model supports video input', () => {
    const registry = new AgentToolRegistryService();
    registerMediaTools(registry, {
      runtime: runtimeFor(fs, env),
      workspace: WORKSPACE,
      capabilities: capabilities({ image_in: false, video_in: true }),
    });
    expect(registry.resolve('ReadMediaFile')).toBeInstanceOf(ReadMediaFileTool);
  });

  it('registers ReadMediaFile when the model supports audio input', () => {
    const registry = new AgentToolRegistryService();
    registerMediaTools(registry, {
      runtime: runtimeFor(fs, env),
      workspace: WORKSPACE,
      capabilities: capabilities({ image_in: false, video_in: false, audio_in: true }),
    });
    expect(registry.resolve('ReadMediaFile')).toBeInstanceOf(ReadMediaFileTool);
  });

  it('does not register anything when the model lacks media capability', () => {
    const registry = new AgentToolRegistryService();
    const disposable = registerMediaTools(registry, {
      runtime: runtimeFor(fs, env),
      workspace: WORKSPACE,
      capabilities: capabilities({ image_in: false, video_in: false }),
    });
    expect(registry.resolve('ReadMediaFile')).toBeUndefined();
    expect(() => disposable.dispose()).not.toThrow();
  });

  it('does not register when the runtime lacks filesystem availability', () => {
    const registry = new AgentToolRegistryService();
    const availableRuntime = runtimeFor(fs, env);
    registerMediaTools(registry, {
      runtime: { ...availableRuntime, isAvailable: () => false },
      workspace: WORKSPACE,
      capabilities: capabilities({ image_in: true, video_in: true }),
    });
    expect(registry.resolve('ReadMediaFile')).toBeUndefined();
  });
});

describe('AgentMediaToolsRegistrar', () => {
  interface ProfileState {
    alias: string;
    capabilities: ModelCapability;
    providerType?: string;
  }

  function createRegistrarHarness(session?: ISessionContext) {
    const registry = new AgentToolRegistryService();
    const eventBus = new EventBusService();
    const state: ProfileState = {
      alias: '',
      capabilities: capabilities({ image_in: false, video_in: false }),
    };
    const brokenAliases = new Set<string>();
    const resolveModel = (id: string) => {
      if (brokenAliases.has(id)) {
        throw new Error(`Model "${id}" is not configured in config.toml.`);
      }
      return { id, name: id, providerName: 'test', protocol: 'openai' };
    };
    const profile = {
      getModelCapabilities: () => state.capabilities,
      getModel: () => state.alias,
      getModelProviderType: () => state.providerType,
      getRuntimeModel: (id: string) => resolveModel(id),
      getRuntimeRequester: (id: string) => ({ model: resolveModel(id) }),
    } as unknown as IAgentProfileService;
    const workspaceCtx = {
      workDir: '/workspace',
      additionalDirs: [],
    } as unknown as ISessionWorkspaceContext;
    const baseRuntime = runtimeFor(createTestFs({}));
    const runtimeChanges = new Emitter<void>();
    let runtimeAvailable = true;
    const runtime: IAgentRuntimeService = {
      _serviceBrand: undefined,
      onDidChange: runtimeChanges.event,
      isAvailable: (required = []) => runtimeAvailable && baseRuntime.isAvailable(required),
      inspect: () => baseRuntime.inspect(),
      acquire: (required = []) => baseRuntime.acquire(required),
    };
    const registrar = new AgentMediaToolsRegistrar(
      registry,
      profile,
      eventBus,
      runtime,
      workspaceCtx,
      recordingTelemetry([]),
      { enabled: () => true } as never,
      new AgentStateService(),
      undefined,
      undefined,
      session,
    );
    const bindModel = (alias: string, caps: ModelCapability): void => {
      state.alias = alias;
      state.capabilities = caps;
      eventBus.publish(
        new AgentStatusUpdated({
          model: alias,
          maxContextTokens: caps.max_context_tokens,
        }),
      );
    };
    const setRuntimeAvailable = (available: boolean): void => {
      runtimeAvailable = available;
      runtimeChanges.fire();
    };
    const breakAlias = (alias: string): void => {
      brokenAliases.add(alias);
    };
    const healAlias = (alias: string): void => {
      brokenAliases.delete(alias);
    };
    return { registry, registrar, bindModel, setRuntimeAvailable, breakAlias, healAlias };
  }

  it('registers nothing until a media-capable model binds, then registers ReadMediaFile', () => {
    const { registry, bindModel } = createRegistrarHarness();
    expect(registry.resolve('ReadMediaFile')).toBeUndefined();

    bindModel('vision-model', capabilities({ image_in: true, video_in: false }));
    const tool = registry.resolve('ReadMediaFile');
    expect(tool).toBeInstanceOf(ReadMediaFileTool);
    expect((tool as ReadMediaFileTool).description).toContain('Video and audio files are not supported');

    bindModel('vision-model', capabilities({ image_in: true, video_in: false, audio_in: true }));
    const refreshed = registry.resolve('ReadMediaFile');
    expect(refreshed).toBeInstanceOf(ReadMediaFileTool);
    expect(refreshed).not.toBe(tool);
    expect((refreshed as ReadMediaFileTool).description).toContain('image and audio files');
  });

  it('passes the current session attachments root to the local media tool', async () => {
    const session = { _serviceBrand: undefined, sessionDir: '/session/current' } as ISessionContext;
    const { registry, bindModel } = createRegistrarHarness(session);
    bindModel('vision-model', capabilities({ image_in: true, video_in: false }));
    const tool = registry.resolve('ReadMediaFile') as ReadMediaFileTool;
    const path = '/session/current/attachments/image.png';
    const execution = await tool.resolveExecution({ path });
    if (execution.isError === true) throw new Error('Expected session attachment media access');
    expect(execution.accesses).toEqual(ToolAccesses.readFile(path));
  });

  it('drops the tool when the model loses media input', () => {
    const { registry, bindModel } = createRegistrarHarness();
    bindModel('vision-model', capabilities({ image_in: true, video_in: true }));
    expect(registry.resolve('ReadMediaFile')).toBeInstanceOf(ReadMediaFileTool);

    bindModel('text-model', capabilities({ image_in: false, video_in: false }));
    expect(registry.resolve('ReadMediaFile')).toBeUndefined();
  });

  it('combines model media support with runtime filesystem availability', () => {
    const { registry, bindModel, setRuntimeAvailable } = createRegistrarHarness();
    bindModel('vision-model', capabilities({ image_in: true, video_in: true }));
    expect(registry.resolve('ReadMediaFile')).toBeInstanceOf(ReadMediaFileTool);

    setRuntimeAvailable(false);
    expect(registry.resolve('ReadMediaFile')).toBeUndefined();

    setRuntimeAvailable(true);
    expect(registry.resolve('ReadMediaFile')).toBeInstanceOf(ReadMediaFileTool);
  });

  it('swaps the tool instance when the model alias changes', () => {
    const { registry, bindModel } = createRegistrarHarness();
    bindModel('vision-a', capabilities({ image_in: true, video_in: true }));
    const first = registry.resolve('ReadMediaFile');

    bindModel('vision-b', capabilities({ image_in: true, video_in: true }));
    const second = registry.resolve('ReadMediaFile');
    expect(second).toBeInstanceOf(ReadMediaFileTool);
    expect(second).not.toBe(first);
  });

  it('keeps the same instance across unrelated status updates', () => {
    const { registry, bindModel } = createRegistrarHarness();
    bindModel('vision-model', capabilities({ image_in: true, video_in: true }));
    const first = registry.resolve('ReadMediaFile');

    bindModel('vision-model', capabilities({ image_in: true, video_in: true }));
    expect(registry.resolve('ReadMediaFile')).toBe(first);
  });

  it('survives an unconfigured bound alias and recovers when it resolves again', () => {
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((err) => unexpected.push(err));
    try {
      const { registry, bindModel, breakAlias, healAlias } = createRegistrarHarness();
      breakAlias('stale-model');
      bindModel('stale-model', UNKNOWN_CAPABILITY);
      expect(unexpected).toHaveLength(0);
      expect(registry.resolve('ReadMediaFile')).toBeUndefined();

      healAlias('stale-model');
      bindModel('stale-model', capabilities({ image_in: true, video_in: true }));
      expect(registry.resolve('ReadMediaFile')).toBeInstanceOf(ReadMediaFileTool);
      expect(unexpected).toHaveLength(0);
    } finally {
      resetUnexpectedErrorHandler();
    }
  });

  it('unregisters on dispose', async () => {
    const { registry, registrar, bindModel } = createRegistrarHarness();
    bindModel('vision-model', capabilities({ image_in: true, video_in: true }));
    expect(registry.resolve('ReadMediaFile')).toBeInstanceOf(ReadMediaFileTool);

    await registrar.dispose();
    expect(registry.resolve('ReadMediaFile')).toBeUndefined();
    bindModel('vision-model-2', capabilities({ image_in: true, video_in: true }));
    expect(registry.resolve('ReadMediaFile')).toBeUndefined();
  });

  it('honors custom image config on the first ReadMediaFile call even when registrar activates before ImageConfigBridge', async () => {
    const fs = createTestFs({
      '/workspace/large.png': { data: pngBuffer(1200, 800), size: MAX_IMAGE_DECODE_BYTES + 1 },
    });
    const registry = new AgentToolRegistryService();
    const config = new StubConfigService({
      [IMAGE_SECTION]: { maxEdgePx: 1000, readByteBudget: 70 * 1024 * 1024 },
    });
    const services = new ServiceCollection();
    services.set(IAgentToolRegistryService, registry);
    services.set(IAgentProfileService, {
      getModelCapabilities: () => capabilities({ image_in: true, video_in: false }),
      getModel: () => 'vision-model',
      getModelProviderType: () => undefined,
      getRuntimeModel: (id: string) => ({ id, name: id, providerName: 'test', protocol: 'openai' }),
      getRuntimeRequester: (id: string) => ({ model: { id, name: id, providerName: 'test', protocol: 'openai' } }),
      getRecipeModelSettings: () => undefined,
    } as unknown as IAgentProfileService);
    services.set(IEventBus, new EventBusService());
    services.set(IAgentRuntimeService, runtimeFor(fs));
    services.set(ISessionWorkspaceContext, { workDir: '/workspace', additionalDirs: [] } as unknown as ISessionWorkspaceContext);
    services.set(ITelemetryService, recordingTelemetry([]));
    services.set(IFlagService, { enabled: () => true } as never);
    services.set(IAgentStateService, new AgentStateService());
    services.set(ISessionSkillCatalog, { catalog: { getSkillRoots: () => [] } } as unknown as ISessionSkillCatalog);
    services.set(IBootstrapService, { homeDir: '/home' } as unknown as IBootstrapService);
    services.set(ISessionContext, { sessionDir: '/session/current' } as unknown as ISessionContext);
    services.set(IConfigService, config);
    const ix = new InstantiationService(services);
    try {
      ix.provideAll([
        { id: IAgentMediaToolsRegistrar, descriptor: new SyncDescriptor(AgentMediaToolsRegistrar), options: { activation: 'eager' } },
        { id: IImageConfigBridge, descriptor: new SyncDescriptor(ImageConfigBridge), options: { activation: 'eager' } },
      ]);
      const tool = registry.resolve('ReadMediaFile') as ReadMediaFileTool;
      expect(tool).toBeInstanceOf(ReadMediaFileTool);
      const result = await execute(tool, { path: '/workspace/large.png' });
      expect(result.isError).toBe(true);
      expect(result.output).toContain('limit 73400320 bytes and 1000px on the longest edge');
    } finally {
      await ix.dispose();
    }
  });
});

describe('createVideoUploader', () => {
  const uploadResult = {
    type: 'video_url' as const,
    videoUrl: { url: 'https://example.com/uploaded.mp4' },
  };
  const input = { data: new Uint8Array(2048), mimeType: 'video/mp4', filename: 'clip.mp4' };

  function modelWith(uploadVideo: ModelRequester['uploadVideo']): Pick<ModelRequester, 'uploadVideo'> {
    return { uploadVideo } as Pick<ModelRequester, 'uploadVideo'>;
  }

  it('returns undefined when the model does not support video upload', () => {
    expect(createVideoUploader(undefined)).toBeUndefined();
    expect(createVideoUploader({} as Pick<ModelRequester, 'uploadVideo'>)).toBeUndefined();
    expect(
      createVideoUploader({
        uploadVideo: vi.fn().mockRejectedValue(new VideoUploadUnsupportedError('no upload')),
        supportsVideoUpload: () => false,
      }),
    ).toBeUndefined();
  });

  it('pre-compresses oversized local videos before blob archiving when supportsVideoUpload is false and refreshes stale WinGet ffmpeg cache on ENOENT', async () => {
    const bigVideo = mp4Buffer(1024);
    const pass1Mp4 = mp4Buffer(568);
    const pass2Mp4 = mp4Buffer(48);
    const runner = vi.fn<AvCompressRunner>(async (cmd, args) => {
      if (cmd.includes('ffprobe')) return { stdout: '30/1\n', stderr: '' };
      const outPath = args.at(-1)!;
      if (outPath.endsWith('out-pass1.mp4')) {
        await writeFile(outPath, pass1Mp4);
      } else if (outPath.endsWith('out-pass2.mp4')) {
        await writeFile(outPath, pass2Mp4);
      }
      return { stdout: '', stderr: '' };
    });
    setConfiguredAvInlineByteBudget(200);
    setConfiguredAvCompressRunner(runner);

    const offloadFile = vi.fn(async () => 'kiki-blob://raw-uncompressed.mp4');
    const offloadParts = vi.fn(async (parts: readonly ContentPart[]) =>
      parts.map(() => ({
        type: 'video_url' as const,
        videoUrl: { url: 'kiki-blob://compressed-pass2.mp4' },
      })),
    );
    const blobService: IAgentBlobService = {
      _serviceBrand: undefined,
      offloadFile,
      offloadParts,
      offloadBytes: vi.fn(async () => 'kiki-blob://bytes'),
      resolveUrl: vi.fn(async () => undefined),
    } as unknown as IAgentBlobService;

    const nonUploadingRequester: Pick<ModelRequester, 'uploadVideo' | 'supportsVideoUpload'> = {
      uploadVideo: vi.fn().mockRejectedValue(new VideoUploadUnsupportedError('anthropic inline only')),
      supportsVideoUpload: () => false,
    };
    const tool = new ReadMediaFileTool(
      runtimeFor(createTestFs({ '/workspace/big.mp4': { data: bigVideo } }), createTestEnv(), 'local'),
      WORKSPACE,
      capabilities(),
      createVideoUploader(nonUploadingRequester),
      undefined,
      true,
      'anthropic',
      undefined,
      undefined,
      undefined,
      blobService,
    );
    const result = await execute(tool, { path: '/workspace/big.mp4' });
    expect(result.isError).toBe(false);
    expect(offloadFile).not.toHaveBeenCalled();
    expect(offloadParts).toHaveBeenCalledOnce();
    expect(noteText(result)).toContain('pre-compressed to video/mp4');
    expect(outputParts(result)[1]).toEqual({
      type: 'video_url',
      videoUrl: { url: 'kiki-blob://compressed-pass2.mp4' },
    });

    const prevLocalAppData = process.env['LOCALAPPDATA'];
    const winGetAppData = await mkdtemp(join(tmpdir(), 'kiki-winget-upgrade-'));
    const pkgDir = join(winGetAppData, 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe');
    const oldSub = join(pkgDir, 'ffmpeg-9.0.2-full_build', 'bin');
    const newSub = join(pkgDir, 'ffmpeg-9.1-full_build', 'bin');
    try {
      process.env['LOCALAPPDATA'] = winGetAppData;
      await mkdir(oldSub, { recursive: true });
      await writeFile(join(oldSub, 'ffmpeg.exe'), 'old');
      const seenCommands: string[] = [];
      const winGetRunner: AvCompressRunner = async (cmd, args) => {
        seenCommands.push(cmd);
        if (cmd === 'ffmpeg' || cmd === 'ffprobe' || cmd.includes('ffmpeg-9.0.2-full_build')) {
          throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });
        }
        if (cmd.includes('ffprobe')) return { stdout: '24/1\n', stderr: '' };
        const outPath = args.at(-1)!;
        await writeFile(outPath, outPath.endsWith('out-pass1.mp4') ? pass1Mp4 : pass2Mp4);
        return { stdout: '', stderr: '' };
      };
      await mkdir(newSub, { recursive: true });
      await writeFile(join(newSub, 'ffmpeg.exe'), 'new');
      await rm(oldSub, { recursive: true, force: true });
      await mkdir(oldSub, { recursive: true });
      await writeFile(join(oldSub, 'ffmpeg.exe'), 'old');

      const seedRunner: AvCompressRunner = async (cmd, args) => {
        if (cmd === 'ffmpeg' || cmd === 'ffprobe') {
          throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });
        }
        if (cmd.includes('ffprobe')) return { stdout: '24/1\n', stderr: '' };
        const outPath = args.at(-1)!;
        await writeFile(outPath, outPath.endsWith('out-pass1.mp4') ? pass1Mp4 : pass2Mp4);
        return { stdout: '', stderr: '' };
      };
      await rm(newSub, { recursive: true, force: true });
      const firstRun = await compressVideoForModel(bigVideo, 'video/mp4', {
        byteBudget: 200,
        runner: seedRunner,
        allowWinGetFallback: true,
      });
      expect(firstRun.changed).toBe(true);

      await rm(oldSub, { recursive: true, force: true });
      await mkdir(newSub, { recursive: true });
      await writeFile(join(newSub, 'ffmpeg.exe'), 'new');

      const upgradedRun = await compressVideoForModel(bigVideo, 'video/mp4', {
        byteBudget: 200,
        runner: winGetRunner,
        allowWinGetFallback: true,
      });
      expect(upgradedRun.changed).toBe(true);
      expect(seenCommands.some((cmd) => cmd.includes('ffmpeg-9.0.2-full_build'))).toBe(true);
      expect(seenCommands.some((cmd) => cmd.includes('ffmpeg-9.1-full_build'))).toBe(true);
    } finally {
      if (prevLocalAppData === undefined) {
        delete process.env['LOCALAPPDATA'];
      } else {
        process.env['LOCALAPPDATA'] = prevLocalAppData;
      }
      await rm(winGetAppData, { recursive: true, force: true });
    }
  });

  it('binds uploadVideo without telemetry', async () => {
    const uploadVideo = vi.fn().mockResolvedValue(uploadResult);
    const uploader = createVideoUploader(modelWith(uploadVideo));
    await expect(uploader!(input)).resolves.toEqual(uploadResult);
    expect(uploadVideo).toHaveBeenCalledWith(input, undefined);
  });

  it('reports video_upload telemetry on success', async () => {
    const records: TelemetryRecord[] = [];
    const uploader = createVideoUploader(modelWith(vi.fn().mockResolvedValue(uploadResult)), {
      client: recordingTelemetry(records),
      props: { model: 'example-model', protocol: 'kimi' },
    });
    await expect(uploader!(input)).resolves.toEqual(uploadResult);
    expect(records).toHaveLength(1);
    expect(records[0]!.event).toBe('video_upload');
    expect(records[0]!.properties).toMatchObject({
      outcome: 'success',
      mime_type: 'video/mp4',
      size_bytes: 2048,
      model: 'example-model',
      protocol: 'kimi',
    });
    expect(records[0]!.properties?.['duration_ms']).toEqual(expect.any(Number));
  });

  it('reports an error outcome with the error type and rethrows', async () => {
    const records: TelemetryRecord[] = [];
    const failure = new TypeError('upload exploded');
    const uploader = createVideoUploader(modelWith(vi.fn().mockRejectedValue(failure)), {
      client: recordingTelemetry(records),
    });
    await expect(uploader!(input)).rejects.toBe(failure);
    expect(records).toHaveLength(1);
    expect(records[0]!.event).toBe('video_upload');
    expect(records[0]!.properties).toMatchObject({
      outcome: 'error',
      error_type: 'TypeError',
      mime_type: 'video/mp4',
      size_bytes: 2048,
    });
  });

  it('never lets a throwing telemetry client break the upload', async () => {
    const throwing = {
      ...recordingTelemetry([]),
      track2: () => {
        throw new Error('sink down');
      },
    } as ITelemetryService;
    const uploader = createVideoUploader(modelWith(vi.fn().mockResolvedValue(uploadResult)), {
      client: throwing,
    });
    await expect(uploader!(input)).resolves.toEqual(uploadResult);
  });

  function heicBytes(): Buffer {
    return Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00,
      0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00,
    ]);
  }

  it('refuses HEIC with a conversion command for the execution environment', async () => {
    const result = await execute(makeTool({ '/workspace/photo.heic': { data: heicBytes() } }), {
      path: '/workspace/photo.heic',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('image/heic');
    expect(result.output).toContain('Convert it to JPEG first');
    expect(result.output).toContain('/workspace/photo.jpg');
    expect(result.output).toMatch(/sips -s format jpeg|heif-convert|magick/);
  });

  function ftypBytes(brand: string): Buffer {
    const buf = Buffer.alloc(24);
    buf.writeUInt32BE(24, 0);
    buf.write('ftyp', 4, 'latin1');
    buf.write(brand, 8, 'latin1');
    buf.write(brand, 16, 'latin1');
    return buf;
  }

  it('refuses every format outside the provider-accepted set, not just HEIC', async () => {
    const result = await execute(makeTool({ '/workspace/photo.avif': { data: ftypBytes('avif') } }), {
      path: '/workspace/photo.avif',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('image/avif');
    expect(result.output).toContain('Convert it to JPEG first');
    expect(result.output).toContain('/workspace/photo.jpg');
    expect(result.output).toMatch(/sips -s format jpeg|magick/);
    expect(result.output).not.toContain('heif-convert');
  });

  it('discovers Windows WinGet ffmpeg binaries in Links and Packages layouts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-winget-ffmpeg-'));
    try {
      expect(await findWinGetFfmpegBinary(root)).toBeNull();
      const pkgBin = join(
        root,
        'Microsoft',
        'WinGet',
        'Packages',
        'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe',
        'ffmpeg-9.0.2-full_build',
        'bin',
      );
      await mkdir(pkgBin, { recursive: true });
      const pkgFfmpeg = join(pkgBin, 'ffmpeg.exe');
      await writeFile(pkgFfmpeg, '');
      expect(await findWinGetFfmpegBinary(root)).toBe(pkgFfmpeg);

      const linksDir = join(root, 'Microsoft', 'WinGet', 'Links');
      await mkdir(linksDir, { recursive: true });
      const linkFfmpeg = join(linksDir, 'ffmpeg.exe');
      await writeFile(linkFfmpeg, '');
      expect(await findWinGetFfmpegBinary(root)).toBe(linkFfmpeg);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('propagates ctx.signal into ReadMediaFile compression and blob offloadParts', async () => {
    const abortController = new AbortController();
    const oversizedPng = Buffer.alloc(6 * 1024 * 1024, 0);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(oversizedPng, 0);
    const abortWorker = {
      _serviceBrand: undefined,
      size: 1,
      request: vi.fn(async () => {
        abortController.abort(new DOMException('read media cancelled', 'AbortError'));
        throw abortController.signal.reason;
      }),
    };
    const tool = new ReadMediaFileTool(
      runtimeFor(createTestFs({ '/workspace/huge.png': { data: oversizedPng } }), createTestEnv(), 'local'),
      WORKSPACE,
      capabilities({ image_in: true }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      abortWorker as never,
    );
    const resolved = await tool.resolveExecution({ path: '/workspace/huge.png' });
    expect('execute' in resolved).toBe(true);
    if ('execute' in resolved) {
      await expect(
        resolved.execute({ turnId: 1, toolCallId: 'call_media_abort', signal: abortController.signal }),
      ).rejects.toThrow('read media cancelled');
    }

    const offloadParts = vi.fn(async (parts: readonly ContentPart[], options?: { readonly signal?: AbortSignal }) => {
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      return parts;
    });
    const fakeMp4 = Buffer.alloc(64, 0);
    fakeMp4.writeUInt32BE(24, 0);
    fakeMp4.write('ftyp', 4, 'latin1');
    fakeMp4.write('isom', 8, 'latin1');
    fakeMp4.writeUInt32BE(40, 24);
    fakeMp4.write('moov', 28, 'latin1');
    const videoSignal = new AbortController().signal;
    const videoTool = new ReadMediaFileTool(
      runtimeFor(createTestFs({ '/workspace/clip.mp4': { data: fakeMp4 } }), createTestEnv(), 'local'),
      WORKSPACE,
      capabilities({ image_in: true, video_in: true }),
      async () => ({ type: 'video_url', videoUrl: { url: 'data:video/mp4;base64,AAAA' } }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        _serviceBrand: undefined,
        offloadParts: offloadParts as never,
        loadParts: async (parts) => parts,
        isBlobRef: () => false,
      },
    );
    const videoResolved = await videoTool.resolveExecution({ path: '/workspace/clip.mp4' });
    expect('execute' in videoResolved).toBe(true);
    if ('execute' in videoResolved) {
      const videoRes = await videoResolved.execute({ turnId: 1, toolCallId: 'call_video', signal: videoSignal });
      expect(videoRes.isError).toBe(false);
    }
    expect(offloadParts).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ signal: videoSignal }),
    );
  });
});
