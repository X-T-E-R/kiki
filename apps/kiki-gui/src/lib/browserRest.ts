/**
 * Browser connections: the GUI side of the wired `klient.rest.browser`
 * contract, plus the two display helpers the settings page needs.
 *
 * Every call here goes through the client SDK facade, like `lib/ssh.ts`. The
 * page never speaks raw routes, and nothing in this module starts a driver:
 * `list` / `status` read config and in-memory state only.
 */

import { browserFailureSchema } from '@kiki/protocol';
import type { BrowserCatalogResponse, BrowserConnection, BrowserConnectionInput, BrowserControlList, BrowserFailure, BrowserPresetId, BrowserSetupList, BrowserSetupStatus, BrowserStatus, BrowserTab } from '@kiki/protocol';

import type { KikiClient } from './client';

export type {
  BrowserCatalogResponse, BrowserConnection, BrowserConnectionInput, BrowserControlList, BrowserFailure, BrowserPresetId, BrowserSetupList, BrowserSetupStatus, BrowserStatus, BrowserTab,
} from '@kiki/protocol';

export type BrowserConnectionType = BrowserConnection['type'];
export type BrowserState = BrowserStatus['state'];
export type BrowserOwnership = NonNullable<BrowserStatus['ownership']>;
export type BrowserEndpointEdit = Extract<BrowserConnectionInput, { type: 'agent-browser-cdp' }>['endpoint'];
/** One connection as the list returns it: the record plus the state Kiki already knows. */
export type BrowserConnectionRow = BrowserControlList['connections'][number];
/** Why the server refused: the flag, the connection's own switch, or an unknown outcome. */
export type BrowserFailureReason = NonNullable<BrowserFailure['reason']>;
/** What the page offers for a route the server named: prepare it, then connect it. */
export type BrowserSetupActionId = BrowserSetupStatus['actions'][number]['id'];
export type BrowserSetupStepState = BrowserSetupStatus['steps'][number]['state'];
export type BrowserSetupState = BrowserSetupStatus['state'];
/**
 * States in which something of this connection exists on the server: connect is
 * meaningless in all of them, disconnect (or a stop check) is the way out, and
 * the daemon can be asked for its target list.
 */
export const LIVE_STATES: ReadonlySet<string> = new Set(['connecting', 'ready', 'running', 'stopping', 'unconfirmed']);

type BrowserRest = NonNullable<KikiClient['klient']['rest']>['browser'];

export const browserKeys = {
  all: ['browser'] as const,
  connections: (scopeId: string) => ['browser', 'connections', scopeId] as const,
  /** Every named route the server supports, with its own readiness. One read for the wizard. */
  presets: (scopeId: string) => ['browser', 'setup', scopeId] as const,
  /** One generation of one connection's targets; a reconnect makes the old list stale. */
  tabs: (scopeId: string, id: string, generation: number) => ['browser', 'tabs', scopeId, id, generation] as const,
  /** The catalogue is read on demand, and separately with schemas. */
  catalog: (scopeId: string, id: string, generation: number, includeSchema: boolean) =>
    ['browser', 'catalog', scopeId, id, generation, includeSchema] as const,
};

export function browserApi(client: KikiClient): BrowserRest {
  const rest = client.klient.rest;
  if (rest === undefined) throw new Error('Browser connection management needs an HTTP connection to the server.');
  return rest.browser;
}

/**
 * What the server said about a failure, off the error envelope's `details`
 * (`packages/protocol/src/rest/browser.ts` `browserFailureSchema`). Parsed with
 * the published schema rather than read by hand, so a shape change shows up as
 * "no structured reason" instead of as a wrong branch.
 */
export function browserFailureOf(error: unknown): BrowserFailure | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const parsed = browserFailureSchema.safeParse((error as { details?: unknown }).details);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Whether the server refused because of the development-candidate flag. Two
 * different causes share the `browser.disabled` code — the flag and a
 * connection switched off in its own config — so only the structured reason
 * decides; nothing here reads the service's sentence.
 */
export function isFlagDisabled(failure: BrowserFailure | undefined): boolean {
  return failure?.code === 'browser.disabled' && failure.reason === 'feature_disabled';
}

/**
 * The build the managed driver has to be: this version, printing **both**
 * markers (`agent-core-v2/src/app/browser/browserBackend.ts`). The first keeps a
 * lost response from being replayed automatically; the second keeps the managed
 * MCP output from hanging on Windows.
 */
export const AGENT_BROWSER_VERSION = '0.38.2';
export const AGENT_BROWSER_MARKERS = 'kiki-no-replay-r1 kiki-stdio-r1';

/**
 * Where a named route stands, as the two words the page needs: has everything
 * arrived yet, and is a browser already running through it. Everything else the
 * status carries (steps, reasons, the action list) is the server's own.
 */
export type PresetReadiness = 'preparing' | 'needs-action' | 'ready' | 'connected' | 'blocked' | 'external';

export function presetReadiness(preset: BrowserSetupStatus): PresetReadiness {
  if (preset.state === 'preparing') return 'preparing';
  if (preset.state === 'connected') return 'connected';
  if (preset.state === 'ready') return 'ready';
  // `external_only` is its own answer, not a failure: nothing is missing here
  // that Kiki could install, because the control surface is another app.
  if (preset.state === 'external_only') return 'external';
  if (preset.state === 'needs_user_action' || preset.state === 'not_prepared') return 'needs-action';
  return 'blocked';
}

/**
 * The next thing to *act on*, in the server's own order.
 *
 * A `warning` is deliberately not this: nothing is missing and nothing failed,
 * so a warning ahead of a real blocker must not hide it — otherwise the row
 * reads "everything installable is in place" while a component is missing and
 * the install button disappears. Warnings are collected separately by
 * `warningStep`.
 */
export function blockingStep(preset: BrowserSetupStatus): BrowserSetupStatus['steps'][number] | undefined {
  return preset.steps.find((step) => step.state !== 'ready' && step.state !== 'running' && step.state !== 'warning');
}

/** The step reporting progress, while a preparation is still running. */
export function runningStep(preset: BrowserSetupStatus): BrowserSetupStatus['steps'][number] | undefined {
  return preset.steps.find((step) => step.state === 'running');
}

/**
 * What the server flagged without blocking. Its own answer, independent of
 * whether anything else is outstanding: a warning the reader should see before
 * trusting the route stays visible even while a blocker is being handled.
 */
export function warningStep(preset: BrowserSetupStatus): BrowserSetupStatus['steps'][number] | undefined {
  return preset.steps.find((step) => step.state === 'warning');
}

export function presetAction(preset: BrowserSetupStatus, id: BrowserSetupActionId): BrowserSetupStatus['actions'][number] | undefined {
  return preset.actions.find((action) => action.id === id);
}

/** `http://127.0.0.1:9222` → `127.0.0.1:9222`; the record's own redacted projection. */
export function endpointHost(display: string | undefined): string | undefined {
  if (display === undefined || display === '') return undefined;
  const match = /^[a-z][a-z0-9+.-]*:\/\/(.+)$/i.exec(display);
  return match === null ? display : match[1];
}

export function whenText(locale: string, at: string | undefined): string | undefined {
  if (at === undefined) return undefined;
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? at : parsed.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}
