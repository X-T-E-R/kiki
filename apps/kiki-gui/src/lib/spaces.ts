/**
 * Spaces (multi-home isolation design §2.1, §6.4, §9): the GUI side of the
 * `rest.homes` contract, the per-key config origins, and the desktop
 * switch/open commands.
 *
 * Only the main space's server writes `homes.json`; a space can list the
 * spaces but its writes are rejected, so every write control here is shown
 * only while the main space is active. Which space this window belongs to
 * comes from the storage boot (`activeSpace()` is `null` for the main space
 * and for every non-desktop host).
 */

import { useQuery } from '@tanstack/react-query';

import type { ListSpacesResponse } from '@kiki/protocol';
import { activeSpace, type ActiveSpace } from '@kiki/session-core/storage';
import type { SpaceWindowMode } from '@kiki/session-core/settings';

import type { DesktopSpaceStatus, HostAdapter } from '../host';
import type { KikiClient } from './client';

export type SpaceListItem = ListSpacesResponse['items'][number] & { readonly credentials_shared?: boolean };

export const MAIN_SPACE_ID = 'main';

export const spaceKeys = {
  all: ['spaces'] as const,
  list: () => ['spaces', 'list'] as const,
  statuses: () => ['spaces', 'statuses'] as const,
  sshCandidates: (id: string) => ['spaces', 'ssh-copy-candidates', id] as const,
};

type HomesRest = NonNullable<KikiClient['klient']['rest']>['homes'];
type ConfigRest = NonNullable<KikiClient['klient']['rest']>['config'];
type SshRest = NonNullable<KikiClient['klient']['rest']>['ssh'];

function rest(client: KikiClient): NonNullable<KikiClient['klient']['rest']> {
  const value = client.klient.rest;
  if (value === undefined) throw new Error('Spaces need an HTTP connection to the server.');
  return value;
}

export function homesApi(client: KikiClient): HomesRest {
  return rest(client).homes;
}

export function spaceConfigApi(client: KikiClient): Pick<ConfigRest, 'removeOverride'> {
  return rest(client).config;
}

export function spaceSshApi(client: KikiClient): Pick<SshRest, 'copySharedCredentialsToIsolated' | 'list'> {
  return rest(client).ssh;
}

/** The space this window is showing; `null` means the main space. */
export function currentSpace(): ActiveSpace | null {
  return activeSpace();
}

export function isInSubspace(): boolean {
  return activeSpace() !== null;
}

/** The homeId of this window's space, `main` included. */
export function currentSpaceId(): string {
  return activeSpace()?.homeId ?? MAIN_SPACE_ID;
}

/** `GET /homes`. A server without the route yields an empty list (single-home). */
export function useSpaces(client: KikiClient) {
  return useQuery({
    queryKey: spaceKeys.list(),
    queryFn: () => homesApi(client).list(),
    staleTime: 30_000,
    select: (data) => data.items as readonly SpaceListItem[],
  });
}

/**
 * Hot/visited slots from the desktop, polled while mounted. Browsers and
 * desktop builds without spaces have no statuses, and every space reads cold.
 */
export function useSpaceStatuses(host: HostAdapter, enabled = true) {
  return useQuery({
    queryKey: spaceKeys.statuses(),
    queryFn: async (): Promise<readonly DesktopSpaceStatus[]> => (await host.spaceStatuses?.()) ?? [],
    enabled: enabled && host.spaceStatuses !== undefined,
    refetchInterval: 5_000,
    staleTime: 4_000,
  });
}

export type SpaceRunState = 'current' | 'hot' | 'cold';

export function spaceRunState(id: string, statuses: readonly DesktopSpaceStatus[] | undefined): SpaceRunState {
  if (id === currentSpaceId()) return 'current';
  return statuses?.find((status) => status.homeId === id)?.hot === true ? 'hot' : 'cold';
}

export function spaceStatus(id: string, statuses: readonly DesktopSpaceStatus[] | undefined): DesktopSpaceStatus | undefined {
  return statuses?.find((status) => status.homeId === id);
}

/** Pending approvals/questions in every space except this one (§9.4). */
export function otherSpacesPending(statuses: readonly DesktopSpaceStatus[] | undefined): number {
  const current = currentSpaceId();
  return (statuses ?? []).reduce((sum, status) => sum + (status.homeId === current ? 0 : status.pendingCount), 0);
}

/**
 * Enter a space. `open_space` covers both window modes on the native side:
 * in switch mode it starts the space's backend if needed and reloads this
 * window into it; in windows mode it opens (or focuses) the space's own
 * window. `mode` only picks the fallback for a build that lacks it.
 */
export async function enterSpace(host: HostAdapter, id: string, mode: SpaceWindowMode): Promise<void> {
  if (host.openSpace !== undefined) {
    await host.openSpace(id);
    return;
  }
  if (mode === 'switch' && host.switchSpace !== undefined) {
    await host.switchSpace(id);
    return;
  }
  throw new Error('Opening a space needs the Kiki desktop app.');
}

let launchedWindowMode: SpaceWindowMode | undefined;

/**
 * The window mode this desktop process started with. The preference can
 * change mid-session but only applies at the next launch, so the first value
 * read in this page load stands for the running process.
 */
export function launchWindowMode(current: SpaceWindowMode): SpaceWindowMode {
  launchedWindowMode ??= current;
  return launchedWindowMode;
}

/** Test seam. */
export function resetLaunchWindowMode(): void {
  launchedWindowMode = undefined;
}

/** Space colors offered on create. Muted so a dot never outshouts the accent. */
export const SPACE_COLORS = ['#c2410c', '#0f766e', '#4d7c0f', '#1d4ed8', '#7e22ce', '#be185d', '#78716c'] as const;

/** `~/.kiki-spaces/<slug>` next to the main home, with the main path's separator. */
export function suggestSpacePath(mainPath: string, name: string): string {
  const sep = mainPath.includes('\\') ? '\\' : '/';
  const trimmed = mainPath.replace(/[\\/]+$/, '');
  const parent = trimmed.slice(0, Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/')));
  const slug = name.trim().toLowerCase().normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-').replace(/^-+|-+$/g, '') || 'space';
  return `${parent === '' ? trimmed : parent}${sep}.kiki-spaces${sep}${slug}`;
}

export function isAbsolutePath(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path.trim());
}

// ---- config origins (§4.3, §9.3) ----

export type ConfigOrigin = 'default' | 'base' | 'home' | 'env' | 'memory';

/** `origins[domain][leafPath]`, as `GET /config` returns it (independent spaces only). */
export type ConfigOrigins = Readonly<Record<string, Readonly<Record<string, ConfigOrigin>>>>;

export function configOrigins(config: unknown): ConfigOrigins | undefined {
  if (typeof config !== 'object' || config === null) return undefined;
  const origins = (config as { origins?: unknown }).origins;
  return typeof origins === 'object' && origins !== null ? origins as ConfigOrigins : undefined;
}

/**
 * The origin of one setting. `key` is the leaf path inside the domain (`''`
 * for a scalar domain such as `default_model`); a table asked for as a whole
 * reads `home` when any of its leaves is local.
 */
export function originOf(origins: ConfigOrigins | undefined, domain: string, key = ''): ConfigOrigin | undefined {
  const entries = origins?.[domain];
  if (entries === undefined) return undefined;
  const exact = entries[key];
  if (exact !== undefined) return exact;
  const prefix = key === '' ? '' : `${key}.`;
  const leaves = Object.entries(entries).filter(([leaf]) => prefix === '' || leaf.startsWith(prefix)).map(([, origin]) => origin);
  if (leaves.length === 0) return undefined;
  for (const origin of ['env', 'memory', 'home', 'base'] as const) if (leaves.includes(origin)) return origin;
  return 'default';
}

export interface SpaceOverride {
  readonly domain: string;
  /** Leaf path segments inside the domain; empty for a scalar domain. */
  readonly keyPath: readonly string[];
  readonly label: string;
}

/** Every leaf this space sets itself (origin `home`), for the "changed here" list. */
export function spaceOverrides(origins: ConfigOrigins | undefined): SpaceOverride[] {
  const rows: SpaceOverride[] = [];
  for (const [domain, leaves] of Object.entries(origins ?? {})) {
    for (const [leaf, origin] of Object.entries(leaves)) {
      if (origin !== 'home') continue;
      const keyPath = leaf === '' ? [] : leaf.split('.');
      rows.push({ domain, keyPath, label: [domain, ...keyPath].join('.') });
    }
  }
  return rows.sort((left, right) => left.label.localeCompare(right.label));
}
