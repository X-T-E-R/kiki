export interface ResourceProbeMetrics {
  readonly coldWatcherRoots: number;
  readonly liveWatcherRoots: number;
  readonly tailHydrateStatus: number;
  readonly coldCanonicalFallbacks: number;
  readonly giantCheckpointJsonDecodes: number;
  readonly maxSessionCreateMs: number;
  readonly maxClientGapMs: number;
  readonly maxSingleTickStallMs: number;
  readonly rosterNMs: number;
  readonly roster2NMs: number;
}

export function runResourceProbe(): Promise<ResourceProbeMetrics>;
