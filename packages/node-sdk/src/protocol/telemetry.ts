import type { TelemetryContextPatch, TelemetryProperties } from '@moonshot-ai/agent-core-v2';

/**
 * The telemetry sink a host hands the SDK. Deliberately narrower than the
 * engine's `ITelemetryService`: hosts supply a plain object, not a DI service.
 */
export interface TelemetryClient {
  track(event: string, properties?: TelemetryProperties): void;
  withContext?(patch: TelemetryContextPatch): TelemetryClient;
  setContext?(patch: TelemetryContextPatch): void;
}

export const noopTelemetryClient: TelemetryClient = {
  track: () => {},
  withContext: () => noopTelemetryClient,
  setContext: () => {},
};

export function withTelemetryContext(
  telemetry: TelemetryClient,
  patch: TelemetryContextPatch,
): TelemetryClient {
  return telemetry.withContext?.(patch) ?? telemetry;
}
