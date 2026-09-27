export const TRANSCRIPT_COVERAGE_VERSION = 2;
export const TRANSCRIPT_COVERAGE_FIELD = 'transcript_coverage_version';
export const TRANSCRIPT_CLIENT_UPGRADE_MESSAGE = 'Transcript coverage requires a newer client; upgrade Kiki before reading transcripts.';
export const TRANSCRIPT_SERVER_UPGRADE_MESSAGE = 'Transcript coverage was not confirmed by the server; upgrade the Kiki server before reading transcripts.';

export function acceptsTranscriptCoverage(value: unknown): boolean {
  return value === TRANSCRIPT_COVERAGE_VERSION;
}

export function confirmsTranscriptCoverage(value: unknown): boolean {
  return value !== null && typeof value === 'object' &&
    TRANSCRIPT_COVERAGE_FIELD in value &&
    acceptsTranscriptCoverage(value.transcript_coverage_version);
}

export function requestsTranscript(spec: Readonly<Record<string, string | undefined>> | undefined): boolean {
  return spec !== undefined && Object.values(spec).some((grade) => grade !== undefined && grade !== 'off');
}
