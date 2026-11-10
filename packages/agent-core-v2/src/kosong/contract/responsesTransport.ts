export interface ResponsesWebSocketConfig {
  targets: string[];
}

export interface ResponsesTransportSelection {
  readonly transport: ResponsesRequestTransport;
  readonly config: ResponsesWebSocketConfig;
}

export interface ResponsesOutputProjection {
  readonly input: readonly unknown[];
  readonly incremental: boolean;
}

export type ResponsesFullInputReason =
  | 'initial'
  | 'non_incremental_output'
  | 'connection_changed'
  | 'identity_changed'
  | 'forced_full'
  | 'prefix_mismatch'
  | 'state_miss';

export interface ResponsesTransportDiagnostics {
  readonly transport: 'ws' | 'sse';
  readonly webSocketCapabilities: boolean | null;
  readonly webSocketCapabilityVersion: 1 | 2 | null;
  readonly webSocketConnectionAgeMs: number | null;
  readonly webSocketFrameBytes?: number | null;
  readonly webSocketMaxFrameBytes?: number | null;
  readonly webSocketFullInputReason?: ResponsesFullInputReason | null;
  readonly webSocketFallbackReason?: string | null;
}

export interface ResponsesRequestTransport {
  diagnostics?(): ResponsesTransportDiagnostics;
  request(params: Record<string, unknown>, options: {
    baseUrl: string;
    apiKey: string;
    headers: Readonly<Record<string, string>>;
    signal?: AbortSignal;
    canonicalOutput?: (nativeOutput: readonly unknown[]) => ResponsesOutputProjection | undefined;
    onFullInput?: (input: readonly unknown[]) => void;
  }): Promise<AsyncIterable<unknown>>;
  commitResponse(responseId: string, canonicalOutput: readonly unknown[]): void;
  close(): void;
}
