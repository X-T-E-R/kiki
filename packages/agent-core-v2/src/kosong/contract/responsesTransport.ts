export interface ResponsesWebSocketConfig {
  targets: string[];
}

export interface ResponsesRequestTransport {
  request(params: Record<string, unknown>, options: {
    baseUrl: string;
    apiKey: string;
    headers: Readonly<Record<string, string>>;
    signal?: AbortSignal;
  }): Promise<AsyncIterable<unknown>>;
  close(): void;
}
