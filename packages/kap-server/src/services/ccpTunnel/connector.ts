import { once } from 'node:events';
import { createConnection, createServer } from 'node:net';
import { HostProcessService } from '@kiki/agent-core-v2/os/backends/node-local/hostProcessService';
import type { IHostProcess, IHostProcessService } from '@kiki/agent-core-v2/os/interface/hostProcess';
import {
  pairCodeCreateOutputSchema,
  type CcpTunnelTransport,
  type ConnectionIdentity,
} from '@kiki/protocol';
import { AdmissionError, sameIdentity } from '../connections/admission';

const REMOTE_POSIX_PATH = 'export PATH=~/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; ';
const CCP_RUNTIME_RE = /^ccp:([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?::(\d{1,5}))?$/;
const CCP_SESSION_ID_RE = /^ssh_[A-Za-z0-9]+$/;

/** Active managed CCP SSH tunnel process forwarding a local loopback port to a remote Kiki TLS port. */
export interface CcpTunnelProcess {
  readonly endpoint: string;
  readonly signal: AbortSignal;
  close(): Promise<void>;
}

/** Injectable runner abstraction for `ccp ssh prepare`, `ccp ssh connect --command`, and `ccp ssh connect -N -L`. */
export interface CcpTunnelRunner {
  prepare(runtimeId: string, signal: AbortSignal): Promise<string>;
  exec(sessionId: string, script: string, signal: AbortSignal): Promise<string>;
  openTunnel(sessionId: string, localPort: number, remoteTlsPort: number, signal: AbortSignal): Promise<CcpTunnelProcess>;
  close(): Promise<void>;
}

export interface CcpTunnelRecord {
  readonly id: string;
  readonly target: ConnectionIdentity;
  readonly pinnedFingerprint?: string;
  readonly transport: CcpTunnelTransport;
}

export interface CcpTunnelResolved {
  readonly id: string;
  readonly endpoint: string;
  readonly target: ConnectionIdentity;
  readonly pinnedFingerprint?: string;
}

export interface CcpPairingPrepared {
  readonly runtimeId: string;
  readonly remoteTlsPort: number;
  readonly code: string;
  readonly fingerprint?: string;
  readonly tunnel: CcpTunnelProcess;
}

/** Parses a `ccp:<runtimeId>[:<remoteTlsPort>]` target reference. */
export function parseCcpEndpoint(
  raw: string,
): { readonly runtimeId: string; readonly remoteTlsPort?: number } | undefined {
  const match = CCP_RUNTIME_RE.exec(raw.trim());
  if (match === null) return undefined;
  const runtimeId = match[1]!;
  if (match[2] === undefined) return { runtimeId };
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AdmissionError(400, 'invalid_ccp_remote_port');
  }
  return { runtimeId, remoteTlsPort: port };
}

async function allocateLoopbackPort(): Promise<number> {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  if (address === null || typeof address === 'string') {
    reservation.close();
    throw new AdmissionError(502, 'ccp_port_unavailable');
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    reservation.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
  return port;
}

async function waitForLoopbackTcp(port: number, signal: AbortSignal): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      const done = (ok: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      const onAbort = () => { done(false); };
      signal.addEventListener('abort', onAbort, { once: true });
      socket.once('connect', () => {
        signal.removeEventListener('abort', onAbort);
        done(true);
      });
      socket.once('error', () => {
        signal.removeEventListener('abort', onAbort);
        done(false);
      });
    });
    if (connected) return;
    signal.throwIfAborted();
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, 50);
      timer.unref();
      signal.addEventListener('abort', done, { once: true });
    });
  }
}

function parseLoopbackTlsPort(loopbackEndpoint: string | undefined): number {
  if (loopbackEndpoint === undefined || loopbackEndpoint.trim() === '') {
    throw new AdmissionError(409, 'ccp_remote_loopback_unavailable');
  }
  let parsed: URL;
  try {
    parsed = new URL(loopbackEndpoint);
  } catch {
    throw new AdmissionError(409, 'ccp_remote_loopback_invalid');
  }
  const port = Number(parsed.port);
  if (parsed.protocol !== 'https:' || parsed.hostname !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AdmissionError(409, 'ccp_remote_loopback_invalid');
  }
  return port;
}

async function stopOwnedProcess(proc: IHostProcess): Promise<void> {
  try {
    await proc.kill();
  } catch {}
  try {
    await Promise.resolve(proc.dispose());
  } catch {}
}

/** Default OS process runner that invokes `ccp` under `IHostProcessService` owned-tree supervision. */
export class SystemCcpTunnelRunner implements CcpTunnelRunner {
  private readonly procs = new Set<IHostProcess>();
  private closed = false;

  constructor(private readonly host: Pick<IHostProcessService, 'spawn'> = new HostProcessService()) {}

  private async spawnCcp(args: readonly string[]): Promise<IHostProcess> {
    if (this.closed) throw new AdmissionError(499, 'ccp_tunnel_owner_closed');
    const bashCcp = process.platform === 'win32';
    let proc: IHostProcess;
    try {
      proc = await this.host.spawn(
        bashCcp ? 'bash.exe' : 'ccp',
        bashCcp ? ['-lc', 'exec ccp "$@"', 'ccp', ...args] : [...args],
        {
          windowsHide: true,
          shell: false,
          ownedProcessTree: true,
          ownedProcessLifetime: 'process',
        },
      );
    } catch {
      throw new AdmissionError(502, 'ccp_process_failed');
    }
    proc.stdin.end();
    this.procs.add(proc);
    void proc.wait().finally(() => { this.procs.delete(proc); }).catch(() => {});
    return proc;
  }

  private async runCommand(args: readonly string[], signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const proc = await this.spawnCcp(args);
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let overflowed = false;
    const onStdout = (chunk: Uint8Array | string) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      bytes += Buffer.byteLength(text);
      if (bytes > 65_536) {
        overflowed = true;
        void stopOwnedProcess(proc);
        return;
      }
      stdout += text;
    };
    const onStderr = (chunk: Uint8Array | string) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      stderr += text;
    };
    proc.stdout.on('data', onStdout);
    proc.stderr.on('data', onStderr);
    const stdoutDone = new Promise<void>((done) => { proc.stdout.once('end', done); });
    const stderrDone = new Promise<void>((done) => { proc.stderr.once('end', done); });

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      void stopOwnedProcess(proc);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();

    try {
      const [code] = await Promise.all([proc.wait(), stdoutDone, stderrDone]);
      if (aborted || signal.aborted) {
        throw new AdmissionError(499, 'ccp_operation_cancelled');
      }
      if (overflowed) {
        throw new AdmissionError(502, 'ccp_command_output_too_large');
      }
      if (code !== 0) {
        throw new AdmissionError(502, `ccp_command_failed:${code}:${stderr.trim()}`);
      }
      return stdout;
    } finally {
      signal.removeEventListener('abort', onAbort);
      proc.stdout.off('data', onStdout);
      proc.stderr.off('data', onStderr);
      await stopOwnedProcess(proc);
    }
  }

  async prepare(runtimeId: string, signal: AbortSignal): Promise<string> {
    const raw = await this.runCommand(['ssh', 'prepare', runtimeId], signal);
    let parsed: { id?: unknown };
    try {
      parsed = JSON.parse(raw) as { id?: unknown };
    } catch {
      throw new AdmissionError(502, 'ccp_prepare_invalid_json');
    }
    if (typeof parsed.id !== 'string' || !CCP_SESSION_ID_RE.test(parsed.id)) {
      throw new AdmissionError(502, 'ccp_prepare_missing_session_id');
    }
    return parsed.id;
  }

  async exec(sessionId: string, script: string, signal: AbortSignal): Promise<string> {
    return this.runCommand(['ssh', 'connect', sessionId, '--command', script], signal);
  }

  async openTunnel(
    sessionId: string,
    localPort: number,
    remoteTlsPort: number,
    parent: AbortSignal,
  ): Promise<CcpTunnelProcess> {
    parent.throwIfAborted();
    const proc = await this.spawnCcp([
      'ssh',
      'connect',
      sessionId,
      '-N',
      '-L',
      `127.0.0.1:${localPort}:127.0.0.1:${remoteTlsPort}`,
    ]);
    proc.stdout.resume();
    proc.stderr.resume();
    const lifetime = new AbortController();
    let closingPromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closingPromise ??= (async () => {
        lifetime.abort(new AdmissionError(499, 'ccp_tunnel_closed'));
        parent.removeEventListener('abort', onParentAbort);
        await stopOwnedProcess(proc);
      })();
      return closingPromise;
    };
    const onParentAbort = () => { void close(); };
    parent.addEventListener('abort', onParentAbort, { once: true });
    if (parent.aborted) onParentAbort();

    void proc.wait().then(
      (code) => {
        lifetime.abort(new AdmissionError(502, `ccp_tunnel_exited_${code}`));
        parent.removeEventListener('abort', onParentAbort);
        void stopOwnedProcess(proc);
      },
      () => {
        lifetime.abort(new AdmissionError(502, 'ccp_process_failed'));
        parent.removeEventListener('abort', onParentAbort);
        void stopOwnedProcess(proc);
      },
    );

    try {
      await waitForLoopbackTcp(localPort, AbortSignal.any([parent, lifetime.signal]));
      return { endpoint: `https://127.0.0.1:${localPort}`, signal: lifetime.signal, close };
    } catch (error) {
      await close();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.procs].map((proc) => stopOwnedProcess(proc)));
  }
}

interface CcpSlot {
  record: CcpTunnelRecord;
  lifetime: AbortController;
  pending?: Promise<CcpTunnelResolved>;
  tunnel?: CcpTunnelProcess;
}

/** Manages auto-reconnecting CCP SSH tunnels with fresh `ccp ssh prepare` tickets on connect and after tunnel exit. */
export class CcpTunnelConnector {
  private readonly slots = new Map<string, CcpSlot>();
  private readonly lifetime = new AbortController();
  private readonly runner: CcpTunnelRunner;
  private onTunnelDropped?: (connectionId: string, endpoint: string) => void;

  constructor(runner: CcpTunnelRunner = new SystemCcpTunnelRunner()) {
    this.runner = runner;
  }

  setOnTunnelDropped(listener: (connectionId: string, endpoint: string) => void): void {
    this.onTunnelDropped = listener;
  }

  async preparePairing(input: {
    readonly runtimeId: string;
    readonly remoteTlsPort?: number;
    readonly code?: string;
    readonly trusted?: boolean;
    readonly fingerprint?: string;
    readonly signal?: AbortSignal;
  }): Promise<CcpPairingPrepared> {
    const signal = input.signal === undefined
      ? this.lifetime.signal
      : AbortSignal.any([this.lifetime.signal, input.signal]);
    signal.throwIfAborted();
    const sessionId = await this.runner.prepare(input.runtimeId, signal);
    let code = input.code;
    let remoteTlsPort = input.remoteTlsPort;
    let fingerprint = input.fingerprint;

    if (code === undefined) {
      const pairCmd = input.trusted === true
        ? `${REMOTE_POSIX_PATH}exec kiki pair --trusted --json`
        : `${REMOTE_POSIX_PATH}exec kiki pair --json`;
      const raw = await this.runner.exec(sessionId, pairCmd, signal);
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch {
        throw new AdmissionError(502, 'ccp_remote_pair_invalid_json');
      }
      const created = pairCodeCreateOutputSchema.parse(parsedJson);
      code = created.code;
      remoteTlsPort = remoteTlsPort ?? parseLoopbackTlsPort(created.loopbackEndpoint);
      fingerprint = fingerprint ?? created.tlsFingerprint;
    } else if (remoteTlsPort === undefined) {
      const statusCmd = `${REMOTE_POSIX_PATH}exec kiki connections status`;
      const raw = await this.runner.exec(sessionId, statusCmd, signal);
      let parsedStatus: { inbound?: { loopbackEndpoint?: string } };
      try {
        parsedStatus = JSON.parse(raw) as { inbound?: { loopbackEndpoint?: string } };
      } catch {
        throw new AdmissionError(502, 'ccp_remote_status_invalid_json');
      }
      remoteTlsPort = parseLoopbackTlsPort(parsedStatus.inbound?.loopbackEndpoint);
    }

    const localPort = await allocateLoopbackPort();
    const tunnel = await this.runner.openTunnel(sessionId, localPort, remoteTlsPort, signal);
    return { runtimeId: input.runtimeId, remoteTlsPort, code, fingerprint, tunnel };
  }

  adoptTunnel(record: CcpTunnelRecord, tunnel: CcpTunnelProcess): void {
    if (this.lifetime.signal.aborted || tunnel.signal.aborted) {
      void tunnel.close().catch(() => {});
      return;
    }
    this.stop(record.id);
    const slot: CcpSlot = {
      record: { ...record, target: { ...record.target }, transport: { ...record.transport } },
      lifetime: new AbortController(),
      tunnel,
    };
    this.slots.set(record.id, slot);
    this.watchTunnelDrop(record.id, slot, tunnel);
  }

  async acquire(record: CcpTunnelRecord, signal: AbortSignal): Promise<CcpTunnelResolved> {
    signal.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    let slot = this.slots.get(record.id);
    if (
      slot !== undefined &&
      (!sameIdentity(slot.record.target, record.target) ||
        slot.record.transport.runtimeId !== record.transport.runtimeId ||
        slot.record.transport.remoteTlsPort !== record.transport.remoteTlsPort)
    ) {
      this.stop(record.id);
      slot = undefined;
    }
    if (slot === undefined) {
      slot = {
        record: { ...record, target: { ...record.target }, transport: { ...record.transport } },
        lifetime: new AbortController(),
      };
      this.slots.set(record.id, slot);
    }
    const current = slot;
    if (current.tunnel !== undefined) {
      if (!current.tunnel.signal.aborted) {
        return {
          id: record.id,
          endpoint: current.tunnel.endpoint,
          target: { ...record.target },
          pinnedFingerprint: record.pinnedFingerprint,
        };
      }
      current.tunnel = undefined;
    }
    if (current.pending === undefined) {
      const openSignal = AbortSignal.any([this.lifetime.signal, current.lifetime.signal]);
      current.pending = (async () => {
        const sessionId = await this.runner.prepare(record.transport.runtimeId, openSignal);
        const localPort = await allocateLoopbackPort();
        const tunnel = await this.runner.openTunnel(
          sessionId,
          localPort,
          record.transport.remoteTlsPort,
          openSignal,
        );
        if (this.slots.get(record.id) !== current || openSignal.aborted) {
          await tunnel.close().catch(() => {});
          throw new AdmissionError(499, 'ccp_tunnel_cancelled');
        }
        current.tunnel = tunnel;
        this.watchTunnelDrop(record.id, current, tunnel);
        return {
          id: record.id,
          endpoint: tunnel.endpoint,
          target: { ...record.target },
          pinnedFingerprint: record.pinnedFingerprint,
        };
      })().finally(() => {
        if (current.pending !== undefined) current.pending = undefined;
      });
    }
    const resolved = await raceAbort(current.pending, signal);
    signal.throwIfAborted();
    return resolved;
  }

  stop(id: string): void {
    const slot = this.slots.get(id);
    if (slot === undefined) return;
    this.slots.delete(id);
    slot.lifetime.abort();
    const tunnel = slot.tunnel;
    slot.tunnel = undefined;
    if (tunnel !== undefined) void tunnel.close().catch(() => {});
  }

  async close(): Promise<void> {
    this.lifetime.abort();
    const slots = [...this.slots.values()];
    const slotIds = Array.from(this.slots.keys());
    for (const id of slotIds) this.stop(id);
    await Promise.allSettled(
      slots.map(async (slot) => {
        await slot.pending?.catch(() => {});
        await slot.tunnel?.close().catch(() => {});
      }),
    );
    await this.runner.close();
  }

  private watchTunnelDrop(connectionId: string, slot: CcpSlot, tunnel: CcpTunnelProcess): void {
    tunnel.signal.addEventListener(
      'abort',
      () => {
        if (this.slots.get(connectionId) === slot && slot.tunnel === tunnel) {
          slot.tunnel = undefined;
          this.onTunnelDropped?.(connectionId, tunnel.endpoint);
        }
      },
      { once: true },
    );
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
