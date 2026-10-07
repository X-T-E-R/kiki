import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';

import { ErrorCodes, Error2 } from '#/errors';
import type { IHostProcess } from '#/os/interface/hostProcess';
import type { IRuntimeResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { proxyEnvForChild, reconcileChildNoProxy } from '#/_base/utils/proxy';
import { abortable } from '#/_base/utils/abort';
import { canonicalWorkspaceRoot } from '#/_base/utils/paths';
import { isComputerMcpConfig, isDirectComputerMcpConfig, type ComputerMcpStopResult } from './computer';

import {
  buildRequestOptions,
  KIMI_MCP_CLIENT_NAME,
  KIMI_MCP_CLIENT_VERSION,
  MCP_LIVENESS_PROBE_TIMEOUT_MS,
  McpToolsListChanged,
  listAllMcpTools,
  toMcpToolResult,
  type UnexpectedCloseListener,
  type UnexpectedCloseReason,
} from './client-shared';
import type { McpServerStdioConfig } from './config-schema';
import type { MCPClient, MCPToolDefinition, MCPToolResult } from './types';

export interface StdioMcpClientOptions {
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly startupTimeoutMs?: number;
  readonly toolCallTimeoutMs?: number;
  readonly defaultCwd?: string;
  readonly runtimeResolver: IRuntimeResolver;
  readonly workspaceId: string;
  readonly runtimeId: string;
  readonly computerControl?: boolean;
  readonly computerDirect?: boolean;
  readonly serverName?: string;
  readonly drainTimeoutMs?: number;
}

const STDERR_BUFFER_CAPACITY = 4 * 1024;
let computerOwner: { readonly client: StdioMcpClient; readonly tool: string } | undefined;
const computerClients = new Map<StdioMcpClient, { readonly key: string; readonly cwd?: string }>();
const stoppedComputerConfigs = new Set<string>();
const unconfirmedComputerClients = new Set<StdioMcpClient>();

function computerKey(name: string, config: McpServerStdioConfig): string {
  return JSON.stringify([name, config.command, config.args ?? [], config.cwd, config.executor ?? 'local', config.runtime_id,
    Object.entries(config.env ?? {}).toSorted(([left], [right]) => left.localeCompare(right))]);
}

export function allowComputerMcp(name: string, config: McpServerStdioConfig): void {
  stoppedComputerConfigs.delete(computerKey(name, config));
}

export function captureComputerMcpStop(name: string, config: McpServerStdioConfig, cwd?: string): () => Promise<ComputerMcpStopResult> {
  const key = computerKey(name, config);
  const clients = [...computerClients].filter(([, entry]) => entry.key === key &&
    (cwd === undefined || (entry.cwd !== undefined && canonicalWorkspaceRoot(entry.cwd) === canonicalWorkspaceRoot(cwd)))).map(([client]) => client);
  stoppedComputerConfigs.add(key);
  for (const client of clients) client.blockCalls();
  return async () => {
    const results = await Promise.allSettled(clients.map((client) => client.close()));
    const failed = results.filter((result) => result.status === 'rejected');
    if (failed.length > 0) {
      return { state: 'unconfirmed', output: failed.map((result) => result.status === 'rejected'
        ? result.reason instanceof Error ? result.reason.message : String(result.reason) : '').join('\n') };
    }
    return clients.length === 0
      ? { state: 'idle', output: 'No matching cua MCP child is running in this Kiki service process. This is not a statement about the whole desktop.' }
      : { state: 'stopped', output: 'Admission is closed and all matching directly owned cua MCP children have exited.' };
  };
}

export class StdioMcpClient implements MCPClient {
  private readonly toolsListChanged: McpToolsListChanged;
  private readonly client: Client;
  private readonly transport: RuntimeStdioTransport;
  private readonly startupTimeoutMs?: number;
  private readonly toolCallTimeoutMs?: number;
  private readonly computerControl: boolean;
  private readonly directlyOwned: boolean;
  private readonly computerConfigKey: string;
  private readonly stderrBuffer = new BoundedTail(STDERR_BUFFER_CAPACITY);
  private started = false;
  private closed = false;
  private closeWork: Promise<void> | undefined;
  private ready = false;
  private hooksInstalled = false;
  private unexpectedCloseListener: UnexpectedCloseListener | undefined;
  private lastTransportError: Error | undefined;
  private pendingUnexpectedClose: UnexpectedCloseReason | undefined;

  static readonly stderrBufferCapacity = STDERR_BUFFER_CAPACITY;

  constructor(config: McpServerStdioConfig, options: StdioMcpClientOptions) {
    if (config.executor !== undefined && config.executor !== 'local') {
      throw new Error2(ErrorCodes.NOT_IMPLEMENTED, `MCP stdio executor '${config.executor}' is not yet implemented`);
    }
    this.computerControl = options.computerControl ?? isComputerMcpConfig(config);
    const osKind = this.computerControl && options.computerDirect === undefined
      ? options.runtimeResolver.inspect({ workspaceId: options.workspaceId, runtimeId: options.runtimeId }).environment.osKind
      : undefined;
    const platform = osKind === 'macOS' ? 'darwin' : osKind === 'Windows' ? 'win32' : osKind === 'Linux' ? 'linux' : undefined;
    this.directlyOwned = options.computerDirect ?? (platform !== undefined && isDirectComputerMcpConfig(config, platform));
    this.computerConfigKey = computerKey(options.serverName ?? '', config);
    if (this.computerControl) computerClients.set(this, { key: this.computerConfigKey, cwd: options.defaultCwd });
    this.transport = new RuntimeStdioTransport(config, options, this.stderrBuffer, this.computerControl,
      () => {
        if (!this.computerControl || this.directlyOwned) {
          if (computerOwner?.client === this) computerOwner = undefined;
          computerClients.delete(this);
          unconfirmedComputerClients.delete(this);
        } else if (computerOwner?.client !== this && !unconfirmedComputerClients.has(this)) {
          computerClients.delete(this);
        }
      });
    this.client = new Client({
      name: options.clientName ?? KIMI_MCP_CLIENT_NAME,
      version: options.clientVersion ?? KIMI_MCP_CLIENT_VERSION,
    });
    this.toolsListChanged = new McpToolsListChanged(this.client);
    this.startupTimeoutMs = options.startupTimeoutMs;
    this.toolCallTimeoutMs = options.toolCallTimeoutMs;
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error2(ErrorCodes.MCP_STARTUP_FAILED, 'MCP stdio client is closed');
    }
    if (this.started) return;
    this.started = true;
    this.installTransportHooks();
    try {
      await this.client.connect(
        this.transport,
        buildRequestOptions(this.startupTimeoutMs, undefined),
      );
    } catch (error) {
      await this.close();
      throw error;
    }
    if (this.closed) {
      await this.close();
      throw new Error2(ErrorCodes.MCP_STARTUP_FAILED, 'MCP stdio client was closed during startup');
    }
    this.ready = true;
  }

  blockCalls(): void {
    this.closed = true;
    this.toolsListChanged.close();
    if (this.computerControl && this.started && (this.directlyOwned || computerOwner?.client === this)) {
      unconfirmedComputerClients.add(this);
    }
  }

  close(): Promise<void> {
    if (this.closeWork !== undefined) return this.closeWork;
    this.blockCalls();
    this.closeWork = this.closeStartedClient();
    return this.closeWork;
  }

  onUnexpectedClose(listener: UnexpectedCloseListener): void {
    this.unexpectedCloseListener = listener;
    const pending = this.pendingUnexpectedClose;
    if (pending !== undefined) {
      this.pendingUnexpectedClose = undefined;
      listener(pending);
    }
  }

  stderrSnapshot(): string {
    return this.stderrBuffer.snapshot();
  }

  getServerCapabilities(): ServerCapabilities | undefined {
    return this.client.getServerCapabilities();
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    return listAllMcpTools(this.client, this.startupTimeoutMs);
  }

  onToolsListChanged(listener: () => void): () => void {
    return this.toolsListChanged.subscribe(listener);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<MCPToolResult> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error2(ErrorCodes.MCP_SERVER_DISABLED, 'MCP client is closed');
    if (this.computerControl && stoppedComputerConfigs.has(this.computerConfigKey)) {
      throw new Error2(ErrorCodes.MCP_SERVER_DISABLED, 'Computer MCP admission is stopped; explicitly enable the configuration before resuming');
    }
    if (!this.computerControl) {
      const result = await this.client.callTool({ name, arguments: args }, undefined,
        buildRequestOptions(this.toolCallTimeoutMs, signal));
      return toMcpToolResult(result);
    }
    if (computerOwner !== undefined || unconfirmedComputerClients.size > 0) {
      throw new Error2(ErrorCodes.MCP_COMPUTER_BUSY,
        `Computer is occupied by MCP tool "${computerOwner?.tool ?? 'unconfirmed proxy action'}"; wait for completion or confirmed driver exit`);
    }
    const owner = { client: this, tool: name };
    computerOwner = owner;
    const work = this.client.callTool({ name, arguments: args }, undefined,
      buildRequestOptions(this.toolCallTimeoutMs, undefined)).then((result) => {
      if (computerOwner === owner && !this.closed) computerOwner = undefined;
      return toMcpToolResult(result);
    });
    return signal === undefined ? work : abortable(work, signal);
  }

  async ping(signal?: AbortSignal): Promise<void> {
    await this.client.ping(buildRequestOptions(MCP_LIVENESS_PROBE_TIMEOUT_MS, signal));
  }

  private async closeStartedClient(): Promise<void> {
    if (!this.started) {
      computerClients.delete(this);
      return;
    }
    this.started = false;
    await this.client.close();
    if (this.computerControl && !this.directlyOwned) {
      throw new Error2(ErrorCodes.MCP_COMPUTER_STOP_UNCONFIRMED,
        'Only the cua proxy connection has exited; external daemon actions are unconfirmed and desktop occupancy is retained');
    }
  }

  private installTransportHooks(): void {
    if (this.hooksInstalled) return;
    this.hooksInstalled = true;
    this.client.onclose = () => {
      this.toolsListChanged.close();
      if (this.closed) return;
      if (!this.ready) return;
      const stderr = this.stderrBuffer.snapshot();
      const reason: UnexpectedCloseReason = {
        error: this.lastTransportError,
        stderr: stderr.length > 0 ? stderr : undefined,
      };
      const listener = this.unexpectedCloseListener;
      if (listener !== undefined) {
        listener(reason);
      } else {
        this.pendingUnexpectedClose = reason;
      }
    };
    this.client.onerror = (error) => {
      this.lastTransportError = error;
    };
  }
}

class RuntimeStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  private readonly readBuffer = new ReadBuffer();
  private process: IHostProcess | undefined;
  private spawnWork: Promise<IHostProcess> | undefined;
  private lease: ReturnType<IRuntimeResolver['acquire']> | undefined;
  private started = false;
  private closed = false;

  constructor(
    private readonly config: McpServerStdioConfig,
    private readonly options: StdioMcpClientOptions,
    private readonly stderr: BoundedTail,
    private readonly computerControl: boolean,
    private readonly confirmedExit: () => void,
  ) {}

  async start(): Promise<void> {
    if (this.started) throw new Error('Runtime stdio transport is already started');
    if (this.closed) throw new Error('Runtime stdio transport is closed');
    this.started = true;
    const lease = this.options.runtimeResolver.acquire(
      { workspaceId: this.options.workspaceId, runtimeId: this.options.runtimeId },
      ['process'],
    );
    this.lease = lease;
    try {
      const base = lease.runtime.path.resolve(this.options.defaultCwd ?? lease.runtime.environment.homeDir);
      const cwd = this.config.cwd === undefined ? base : lease.runtime.path.resolve(base, this.config.cwd);
      this.spawnWork = lease.runtime.process!.spawn(
        this.config.command,
        this.config.args,
        { cwd, env: mergeStdioEnv(this.config.env) },
      );
      const process = lease.track(await this.spawnWork);
      this.process = process;
      lease.track(this);
      process.stdin.on('error', (error: Error) => this.onerror?.(error));
      process.stdout.on('data', (chunk: Buffer | string) => this.onData(chunk));
      process.stdout.on('end', () => { if (!this.computerControl) this.finish(); });
      process.stdout.on('error', (error: Error) => this.onerror?.(error));
      process.stderr.on('data', (chunk: Buffer | string) => {
        this.stderr.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      });
      process.stderr.on('error', (error: Error) => this.onerror?.(error));
      void process.wait().then(
        () => { this.confirmedExit(); this.finish(); },
        (error: unknown) => {
          this.onerror?.(error instanceof Error ? error : new Error(String(error)));
          if (!this.computerControl) this.finish();
        },
      );
    } catch (error) {
      this.lease = undefined;
      lease.dispose();
      throw error;
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const process = this.process;
    if (process === undefined || this.closed) throw new Error('Runtime stdio transport is not running');
    const data = serializeMessage(message);
    await new Promise<void>((resolve, reject) => {
      process.stdin.write(data, (error) => {
        if (error !== null && error !== undefined) reject(error);
        else resolve();
      });
    });
  }

  dispose(): Promise<void> {
    return this.close();
  }

  async close(): Promise<void> {
    if (this.closed && this.process === undefined) return;
    this.closed = true;
    if (this.computerControl && this.process === undefined && this.spawnWork !== undefined) {
      await this.spawnWork.catch(() => undefined);
    }
    const process = this.process;
    if (process !== undefined) {
      if (this.computerControl) {
        process.stdin.end();
        if (!(await exitedWithin(process, this.options.drainTimeoutMs ?? 5_000))) {
          try {
            await process.kill();
          } catch (cause) {
            throw new Error2(ErrorCodes.MCP_COMPUTER_STOP_UNCONFIRMED,
              'Computer driver did not exit after EOF and could not be terminated; occupancy is retained', { cause });
          }
          if (!(await exitedWithin(process, 2_000))) {
            throw new Error2(ErrorCodes.MCP_COMPUTER_STOP_UNCONFIRMED,
              'Computer driver termination is unconfirmed; occupancy is retained');
          }
        }
        this.confirmedExit();
      } else {
        try { await process.kill(); } catch {}
      }
      void process.dispose();
    } else if (this.computerControl) {
      this.confirmedExit();
    }
    this.process = undefined;
    this.readBuffer.clear();
    const lease = this.lease;
    this.lease = undefined;
    lease?.dispose();
    this.onclose?.();
  }

  private onData(chunk: Buffer | string): void {
    this.readBuffer.append(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    while (true) {
      try {
        const message = this.readBuffer.readMessage();
        if (message === null) return;
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private finish(): void {
    const wasClosed = this.closed;
    this.closed = true;
    this.process = undefined;
    this.readBuffer.clear();
    const lease = this.lease;
    this.lease = undefined;
    lease?.dispose();
    if (!wasClosed) this.onclose?.();
  }
}

async function exitedWithin(process: IHostProcess, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      process.wait().then(() => true, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class BoundedTail {
  private buffer = '';
  constructor(private readonly capacity: number) {}

  push(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > this.capacity) {
      this.buffer = this.buffer.slice(this.buffer.length - this.capacity);
    }
  }

  snapshot(): string {
    return this.buffer;
  }
}

export function mergeStdioEnv(
  configEnv?: Record<string, string>,
  parentEnv: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value !== undefined) merged[key] = value;
  }
  if (configEnv !== undefined) Object.assign(merged, configEnv);
  Object.assign(merged, proxyEnvForChild(merged));
  reconcileChildNoProxy(merged, configEnv);
  return merged;
}
