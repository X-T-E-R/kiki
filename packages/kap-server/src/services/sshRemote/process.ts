import { spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, resolve, delimiter } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { sshRemoteProfileSchema, type SshRemoteProfile } from '@kiki/protocol';
import { AdmissionError } from '../connections/admission';

export function sshArguments(raw: SshRemoteProfile): string[] {
  const profile = sshRemoteProfileSchema.parse(raw);
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'PreferredAuthentications=publickey',
    '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no',
    '-o', 'PermitLocalCommand=no', '-o', 'ClearAllForwardings=no', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'RequestTTY=no'];
  if (profile.identityFile !== undefined) args.push('-i', profile.identityFile);
  if (profile.target.kind === 'host') {
    if (profile.target.port !== undefined) args.push('-p', String(profile.target.port));
    if (profile.target.username !== undefined) args.push('-l', profile.target.username);
    args.push(profile.target.hostname);
  } else args.push(profile.target.alias);
  return args;
}
export function remoteServeCommand(raw: SshRemoteProfile, ensure: boolean): string {
  const profile = sshRemoteProfileSchema.parse(raw);
  const values = [profile.remoteExecutable, 'serve', '--home', profile.remoteHome, ensure ? '--ensure' : '--query', '--json'];
  if (ensure) values.push('--idle-exit', '0ms');
  if (profile.remoteShell === 'posix') return values.map((v) => "'" + v.replaceAll("'", "'\\''") + "'").join(' ');
  const script = '& ' + values.map((v) => "'" + v.replaceAll("'", "''") + "'").join(' ') + '; exit $LASTEXITCODE';
  return 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64');
}
export interface SshProcessOptions { executable?: string; prefix?: string[]; timeoutMs?: number }
export interface SshTunnelProcess { endpoint: string; signal: AbortSignal; close(): Promise<void> }
function inspectFailure(child: ChildProcess): () => string | undefined {
  let tail = ''; let failure: string | undefined;
  child.stderr?.on('data', (chunk: Buffer) => {
    tail = (tail + chunk.toString('utf8')).slice(-8192);
    if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/.test(tail)) failure = 'ssh_host_key_rejected';
    else if (/Permission denied \(publickey/.test(tail)) failure = 'ssh_public_key_rejected';
    else if (/Could not resolve hostname|Connection timed out|No route to host/.test(tail)) failure = 'ssh_network_unreachable';
  });
  return () => failure;
}
export class SystemSshProcess {
  private readonly children = new Set<ChildProcess>();
  private closed = false;
  constructor(private readonly options: SshProcessOptions = {}) {}
  private async executable(): Promise<string> {
    if (this.options.executable !== undefined) return this.options.executable;
    const paths = (process.env['PATH'] ?? '').split(delimiter).filter((p) => isAbsolute(p) && resolve(p) !== process.cwd());
    const candidates = process.platform === 'win32'
      ? [join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe'), ...paths.map((p) => join(p, 'ssh.exe'))]
      : paths.map((p) => join(p, 'ssh'));
    for (const candidate of candidates) { try { await access(candidate, constants.X_OK); return candidate; } catch {} }
    throw new AdmissionError(409, 'system_openssh_unavailable');
  }
  private async start(args: string[]): Promise<ChildProcess> {
    const executable = await this.executable();
    if (this.closed) throw new AdmissionError(499, 'ssh_process_owner_closed');
    const child = spawn(executable, [...this.options.prefix ?? [], ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    this.children.add(child); child.once('close', () => this.children.delete(child)); return child;
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.children].map(async (child) => { const closed = once(child, 'close').catch(() => {}); child.kill(); await closed; }));
  }
  async query(profile: SshRemoteProfile, ensure: boolean, parent: AbortSignal): Promise<unknown> {
    const signal = AbortSignal.any([parent, AbortSignal.timeout(this.options.timeoutMs ?? (ensure ? 75000 : 15000))]);
    signal.throwIfAborted();
    const child = await this.start([...sshArguments(profile), remoteServeCommand(profile, ensure)]);
    let output = ''; let bytes = 0; const failure = inspectFailure(child); child.stdout?.setEncoding('utf8');
    return new Promise<unknown>((resolveResult, reject) => {
      let settled = false;
      const finish = (error?: unknown, result?: unknown) => {
        if (settled) return; settled = true; signal.removeEventListener('abort', abort);
        child.kill(); if (error !== undefined) reject(error); else resolveResult(result);
      };
      const abort = () => finish(new AdmissionError(499, 'ssh_operation_cancelled'));
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      child.stderr?.resume();
      child.stdout?.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 65536) { finish(new AdmissionError(502, 'ssh_bootstrap_too_large')); return; }
        output += chunk;
      });
      child.once('error', () => finish(new AdmissionError(502, 'ssh_process_failed')));
      child.once('close', (code) => {
        if (code !== 0) { finish(new AdmissionError(502, failure() ?? 'ssh_command_failed')); return; }
        try { finish(undefined, JSON.parse(output)); } catch { finish(new AdmissionError(502, 'ssh_bootstrap_invalid')); }
      });
    });
  }
  async tunnel(profile: SshRemoteProfile, remotePort: number, parent: AbortSignal): Promise<SshTunnelProcess> {
    parent.throwIfAborted();
    const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const address = reservation.address();
    if (address === null || typeof address === 'string') throw new AdmissionError(502, 'ssh_port_unavailable');
    const port = address.port;
    await new Promise<void>((done, reject) => { reservation.close((error) => error === undefined ? done() : reject(error)); });
    const args = sshArguments(profile);
    args.splice(args.length - 1, 0, '-v', '-N', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${port}:127.0.0.1:${remotePort}`);
    const child = await this.start(args); const failure = inspectFailure(child); child.stdout?.resume();
    const lifetime = new AbortController();
    let alive = true;
    const abort = () => { lifetime.abort(new AdmissionError(499, 'ssh_tunnel_closed')); if (alive) child.kill(); };
    parent.addEventListener('abort', abort, { once: true }); if (parent.aborted) abort();
    child.once('error', () => { alive = false; lifetime.abort(new AdmissionError(502, 'ssh_process_failed')); });
    child.once('exit', () => { alive = false; lifetime.abort(new AdmissionError(502, 'ssh_tunnel_offline')); parent.removeEventListener('abort', abort); });
    const close = async () => { abort(); if (alive) await once(child, 'close').catch(() => {}); parent.removeEventListener('abort', abort); };
    try {
      await new Promise<void>((ready, reject) => {
        const timer = setTimeout(() => failed(), this.options.timeoutMs ?? 12000);
        const failed = () => { cleanup(); reject(new AdmissionError(502, failure() ?? 'ssh_forward_not_confirmed')); };
        let tail = '';
        const data = (chunk: Buffer) => {
          const lines = (tail + chunk.toString('utf8')).slice(-8192).split('\n'); tail = lines.pop() ?? '';
          if (lines.some((line) => line.trimEnd() === `debug1: Local forwarding listening on 127.0.0.1 port ${port}.`)) { cleanup(); ready(); }
        };
        const cleanup = () => { clearTimeout(timer); child.stderr?.off('data', data); lifetime.signal.removeEventListener('abort', failed); };
        child.stderr?.on('data', data); lifetime.signal.addEventListener('abort', failed, { once: true }); if (lifetime.signal.aborted) failed();
      });
      return { endpoint: `http://127.0.0.1:${port}`, signal: lifetime.signal, close };
    } catch (error) { await close(); throw error; }
  }
}
