import type { Server } from 'node:http';

export const RELAY_PROTOCOL_VERSION: number;
export const RELAY_WS_SUBPROTOCOL: string;

export interface StartKikiRelayServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly basePath?: string;
  readonly publicUrl?: string;
  readonly label?: string;
  readonly hostToken?: string;
  readonly secret?: string;
  readonly verifyUrl?: string;
  readonly trustProxy?: boolean;
  readonly requireTicket?: boolean;
  readonly maxWarmPool?: number;
  readonly maxStreamsPerIp?: number;
  readonly rateLimitPerMinute?: number;
  readonly probeDelayMs?: number;
}

export interface RunningKikiRelayServer {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  readonly basePath: string;
  readonly publicUrl: string;
  readonly shareUri: string;
  stats(): {
    readonly registeredHosts: number;
    readonly warmSockets: number;
    readonly activeClientStreams: number;
  };
  setProbeDelayMs(ms: number): void;
  stop(): Promise<void>;
}

export function startKikiRelayServer(
  options?: StartKikiRelayServerOptions,
): Promise<RunningKikiRelayServer>;
