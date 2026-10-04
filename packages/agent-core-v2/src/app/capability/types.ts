export type CapabilityId = 'kimi-cu' | 'kimi-webbridge' | 'kiki-computer';

export type CapabilityReadiness = 'not_installed' | 'partial' | 'ready' | 'unsupported';

export type CapabilityStepState = 'ok' | 'missing' | 'failed';

/**
 * Why a step is not `ok`, as a code the client can localize.
 *
 * `detail` is a free-form sentence the detector writes in its own words, so it
 * reaches the user in the server's language and cannot be translated. A step
 * that wants to explain itself on the first screen sets `reason` instead; the
 * client maps it to one localized line and keeps `detail` for the folded
 * diagnostics. These are capability-level facts ("the loopback status cannot
 * authenticate the responder"), not template strings, and they are additive:
 * an unknown code falls back to the step's state rather than to raw prose.
 */
export type CapabilityStepReason = string;

export interface CapabilityStep {
  readonly id: string;
  readonly state: CapabilityStepState;
  /** Machine-readable explanation; prefer this over `detail` for user-facing copy. */
  readonly reason?: CapabilityStepReason;
  /** Free-form detector prose. Diagnostics only — never the first screen. */
  readonly detail?: string;
  readonly optional?: boolean;
}

export interface CapabilityInstallProgress {
  readonly running: boolean;
  readonly step?: string;
  readonly percent?: number;
  readonly error?: string;
  readonly note?: string;
}

export interface CapabilityDetectResult {
  readonly version?: string;
  readonly steps: readonly CapabilityStep[];
}

export interface CapabilityInstallPlan {
  readonly artifact: {
    readonly version: string;
    readonly url: string;
    readonly sha256: string;
    readonly metadataUrl: string;
    readonly maxBytes: number;
  };
  readonly destination: string;
  readonly browserExtensionUrl?: string;
  readonly note: string;
}

export interface CapabilityStatus {
  readonly id: CapabilityId;
  /** Plugin identifier used to provide this capability's agent wiring. */
  readonly pluginId?: string;
  readonly displayName: string;
  readonly description: string;
  readonly supported: boolean;
  readonly state: CapabilityReadiness;
  readonly version?: string;
  readonly steps: readonly CapabilityStep[];
  readonly plan?: CapabilityInstallPlan;
  readonly install: CapabilityInstallProgress;
}

export type CapabilityInstallReporter = (step: string, percent?: number) => void;

export interface CapabilityDescriptor {
  readonly id: CapabilityId;
  readonly pluginId?: string;
  readonly displayName: string;
  readonly description: string;
  readonly supported: boolean;
}

export interface CapabilityInstallChange {
  readonly id: CapabilityId;
  readonly install: CapabilityInstallProgress;
}

export interface CapabilityEntry {
  readonly id: CapabilityId;
  readonly pluginId?: string;
  readonly displayName: string;
  readonly description: string;
  readonly supported: boolean;
  readonly plan?: CapabilityInstallPlan;
  detect(): Promise<CapabilityDetectResult>;
  install(report: CapabilityInstallReporter): Promise<string | undefined>;
}
