import type { Readable, Writable } from 'node:stream';

import type { Context } from '@kiki/cordis-runtime';
import type { ImageAttachmentLimits } from './vendor/attachment/src/types';
import { HostBackedAttachmentStore, InMemorySettingsService } from './nodeHostPorts';

export interface DshFsTarget {
  readonly targetKey: string;
  readonly displayPath: string;
}

export interface DshFsInfo {
  readonly version: string;
  readonly type: 'file' | 'directory' | 'other';
  readonly size?: number;
}

export interface DshFileSystemPort {
  resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<DshFsTarget>;
  stat(target: DshFsTarget, signal?: AbortSignal): Promise<DshFsInfo | undefined>;
  processPath(target: DshFsTarget): string;
  fileUrl(target: DshFsTarget): string;
  contains(parent: DshFsTarget, child: DshFsTarget): boolean;
  streamText(target: DshFsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>;
}

export interface DshSubprocessOutputReader {
  readFrom(offset: number): {
    readonly text: string;
    readonly nextOffset: number;
    readonly lossy: boolean;
    readonly spillPath?: string;
  };
}

export interface DshSubprocessHandle {
  readonly pid?: number;
  readonly stdin?: Writable;
  readonly stdout?: Readable;
  readonly stderr?: Readable;
  readonly collected: {
    readonly stdout?: DshSubprocessOutputReader;
    readonly stderr?: DshSubprocessOutputReader;
  };
  readonly done: Promise<{ readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }>;
  terminate(): void;
  waitForExit(signal?: AbortSignal): Promise<boolean>;
}

export interface DshSubprocessSpawnSpec {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly stdio: {
    readonly stdin: 'ignore' | 'pipe' | { readonly data: string };
    readonly stdout: 'pipe' | 'inherit' | { readonly maxBytes: number };
    readonly stderr: 'pipe' | 'inherit' | { readonly maxBytes: number };
  };
  readonly graceMs: number;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
}

export interface DshSubprocessPort {
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>;
  spawn(spec: DshSubprocessSpawnSpec): DshSubprocessHandle;
}

export interface DshImageAttachmentRef {
  readonly attachmentId: string;
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly name?: string;
}

export interface DshAttachmentsPort {
  saveImages(inputs: readonly {
    data: Uint8Array;
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    name?: string;
  }[]): Promise<readonly DshImageAttachmentRef[]>;
  readBase64?(attachmentId: string): string | undefined;
}

export interface DshLlmPort {
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{
    readonly inputModalities?: readonly string[];
    readonly context?: unknown;
    readonly defaultMaxTokens?: number;
  }>;
}

export interface DshCredentialsPort {
  resolve(ref: string): Promise<{ readonly value: string; readonly source: string } | undefined>;
  describe?(ref: string): Promise<{ readonly configured: boolean; readonly source?: string; readonly writable: boolean }>;
  set?(ref: string, value: string): Promise<void>;
  unset?(ref: string): Promise<void>;
}

export interface DshStorageDomainPort {
  open(name: string): Promise<{ close(): Promise<void> }>;
}

export interface DshTypertBroker {
  readonly mode: 'e12-http-ws' | 'in-process';
  call(input: {
    readonly service: string;
    readonly method: string;
    readonly args: readonly unknown[];
    readonly signal?: AbortSignal;
  }): Promise<unknown>;
  subscribe(input: {
    readonly service: string;
    readonly state: string;
    readonly listener: (value: unknown) => void;
    readonly signal?: AbortSignal;
  }): Promise<() => void | Promise<void>> | (() => void | Promise<void>);
}

export interface DshHostPorts {
  readonly workingDirectory: {
    ensure(agent: object, signal?: AbortSignal): Promise<string | undefined>;
    get?(session: object): string;
    set?(agent: object, path: string, signal?: AbortSignal): Promise<string>;
  };
  readonly fs: DshFileSystemPort;
  readonly subprocess: DshSubprocessPort;
  readonly attachments?: DshAttachmentsPort;
  readonly attachmentOptions?: {
    readonly storageDir?: string;
    readonly limits?: Partial<ImageAttachmentLimits>;
  };
  readonly settings?: Readonly<Record<string, Record<string, unknown>>>;
  readonly llm?: DshLlmPort;
  readonly credentials?: DshCredentialsPort;
  readonly storageDomain?: DshStorageDomainPort;
  readonly typert?: DshTypertBroker;
}

export class DshHostServicesBridge {
  private readonly processes = new Set<DshSubprocessHandle>();
  private readonly domains = new Set<{ close(): Promise<void> }>();
  private readonly subscriptions = new Set<() => void | Promise<void>>();
  readonly attachmentStore: DshAttachmentsPort;
  readonly settingsService: InMemorySettingsService;
  private disposed = false;

  constructor(private readonly ctx: Context, private readonly ports: DshHostPorts) {
    if (ports.attachments !== undefined) {
      this.attachmentStore = ports.attachments;
    } else {
      this.attachmentStore = new HostBackedAttachmentStore(ctx, ports.attachmentOptions);
    }
    this.settingsService = new InMemorySettingsService(ctx, ports.settings);
  }

  get activeProcessCount(): number {
    return this.processes.size;
  }

  install(): () => Promise<void> {
    const subprocess: DshSubprocessPort = {
      resolveExecutable: (command, env, signal) => {
        this.assertActive();
        return this.ports.subprocess.resolveExecutable(command, env, signal);
      },
      spawn: (spec) => {
        this.assertActive();
        const handle = this.ports.subprocess.spawn(spec);
        this.processes.add(handle);
        void handle.done.finally(() => this.processes.delete(handle)).catch(() => {});
        return handle;
      },
    };
    const disposers: Array<() => void> = [
      this.ctx.provide('workingDirectory', this.ports.workingDirectory),
      this.ctx.provide('fs', this.ports.fs),
      this.ctx.provide('subprocess', subprocess),
      this.ctx.provide('shell', {
        spawn: (spec: DshSubprocessSpawnSpec) => subprocess.spawn(spec),
      }),
    ];
    if (this.ports.attachments !== undefined && this.ctx.get('attachments') === undefined) {
      disposers.push(this.ctx.provide('attachments', this.ports.attachments));
    }
    if (this.ports.llm !== undefined) {
      disposers.push(this.ctx.provide('llm', this.ports.llm));
    }
    if (this.ports.credentials !== undefined) {
      const creds = this.ports.credentials;
      const secretStore = new Map<string, string>();
      disposers.push(this.ctx.provide('credentials', {
        resolve: async (ref: string) => {
          this.assertActive();
          const local = secretStore.get(ref);
          if (local !== undefined && local.length > 0) return { value: local, source: 'runtime-override' };
          return creds.resolve(ref);
        },
        describe: async (ref: string) => {
          this.assertActive();
          if (creds.describe !== undefined) return creds.describe(ref);
          const resolved = secretStore.has(ref)
            ? { value: secretStore.get(ref)!, source: 'runtime-override' }
            : await creds.resolve(ref);
          return {
            configured: resolved !== undefined && resolved.value.length > 0,
            ...(resolved === undefined ? {} : { source: resolved.source }),
            writable: true,
          };
        },
        set: async (ref: string, value: string) => {
          this.assertActive();
          if (value.length === 0) throw new Error('credential value must not be empty');
          if (creds.set !== undefined) {
            await creds.set(ref, value);
          } else {
            secretStore.set(ref, value);
          }
          (this.ctx as any).emit('credentials/reference-updated', ref);
        },
        unset: async (ref: string) => {
          this.assertActive();
          if (creds.unset !== undefined) {
            await creds.unset(ref);
          } else {
            secretStore.delete(ref);
          }
          (this.ctx as any).emit('credentials/reference-updated', ref);
        },
      }));
    }
    if (this.ports.storageDomain !== undefined) {
      disposers.push(this.ctx.provide('storageDomain', {
        open: async (name: string) => {
          this.assertActive();
          const domain = await this.ports.storageDomain!.open(name);
          this.domains.add(domain);
          let open = true;
          return {
            close: async () => {
              if (!open) return;
              open = false;
              this.domains.delete(domain);
              await domain.close();
            },
          };
        },
      }));
    }
    if (this.ports.typert !== undefined) {
      disposers.push(this.ctx.provide('typert', this.createTypert(this.ports.typert)));
    }
    return this.ctx.effect(() => async () => {
      this.disposed = true;
      const failures: unknown[] = [];
      for (const unsubscribe of this.subscriptions) {
        try {
          await unsubscribe();
        } catch (error) {
          failures.push(error);
        }
      }
      this.subscriptions.clear();
      const snapshotProcesses = [...this.processes];
      for (const proc of snapshotProcesses) proc.terminate();
      const exits = await Promise.allSettled(snapshotProcesses.map(proc => proc.waitForExit()));
      this.processes.clear();
      for (const exit of exits) {
        if (exit.status === 'rejected') failures.push(exit.reason);
        else if (!exit.value) failures.push(new Error('a DSH subprocess did not reach quiescence'));
      }
      for (const domain of this.domains) {
        try {
          await domain.close();
        } catch (error) {
          failures.push(error);
        }
      }
      this.domains.clear();
      for (const dispose of disposers.toReversed()) dispose();
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'DSH host service teardown failed');
    }, 'dsh-compat.hostServices');
  }

  private createTypert(broker: DshTypertBroker): object {
    return {
      mode: broker.mode,
      call: (service: string, method: string, args: readonly unknown[], signal?: AbortSignal) => {
        this.assertActive();
        return broker.call({ service, method, args, signal });
      },
      subscribe: async (service: string, state: string, listener: (value: unknown) => void, signal?: AbortSignal) => {
        this.assertActive();
        const unsubscribe = await broker.subscribe({ service, state, listener, signal });
        this.subscriptions.add(unsubscribe);
        return async () => {
          this.subscriptions.delete(unsubscribe);
          await unsubscribe();
        };
      },
    };
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('DSH host services are disposed');
  }
}

export function isImageAdmissionError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AttachmentError';
}
