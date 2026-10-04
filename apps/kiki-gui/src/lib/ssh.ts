/**
 * Native SSH hosts: the GUI side of the wired `klient.rest.ssh` contract.
 * Only the routes the contract marks as wired are called here (hosts CRUD,
 * discover, config sync, host keys, connection approval, write-back, status,
 * disconnect, session join/leave). Nothing here reads or sends a credential.
 */

import { useQuery } from '@tanstack/react-query';

import type { SshHost, SshHostInput, SshHostStatus, SshSessionHostsResponse } from '@kiki/protocol';

import type { KikiClient } from './client';

export type { SshHost, SshHostInput, SshHostStatus } from '@kiki/protocol';

export const NATIVE_SSH_FLAG = 'native_ssh';

/** Alias rule the server enforces on `{id}` (kap-server routes/ssh.ts). */
export const SSH_HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Hostname rule of the host store (agent-core sshHosts.ts normalizeHost). */
export const SSH_HOSTNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,253}$/;

export const sshKeys = {
  all: ['ssh'] as const,
  hosts: () => ['ssh', 'hosts'] as const,
  discovered: () => ['ssh', 'discovered'] as const,
  approval: () => ['ssh', 'connection-approval'] as const,
  configSync: () => ['ssh', 'config-sync'] as const,
  hostKeys: (id: string) => ['ssh', 'host-keys', id] as const,
  status: (id: string) => ['ssh', 'status', id] as const,
  session: (sessionId: string) => ['ssh', 'session-hosts', sessionId] as const,
};

type SshRest = NonNullable<KikiClient['klient']['rest']>['ssh'];

export function sshApi(client: KikiClient): SshRest {
  const rest = client.klient.rest;
  if (rest === undefined) throw new Error('SSH host management needs an HTTP connection to the server.');
  return rest.ssh;
}

/** `user@host:port`, dropping the parts the record leaves to ssh config. */
export function sshTargetLabel(host: Pick<SshHost, 'hostname' | 'user' | 'port'>): string | undefined {
  if (host.hostname === undefined) return undefined;
  const user = host.user === undefined ? '' : `${host.user}@`;
  const port = host.port === undefined || host.port === 22 ? '' : `:${host.port}`;
  return `${user}${host.hostname}${port}`;
}

/** Write-back needs an explicit hostname and user (server rule). */
export function canWriteBack(host: SshHost): boolean {
  return host.source === 'kiki' && host.hostname !== undefined && host.user !== undefined;
}

/**
 * The stored "always sync ~/.ssh/config" value, read from the server instead
 * of being guessed from the host lists: a discovered alias may be missing
 * because sync is off, because a Kiki host shadows it, or because the file is
 * empty, and none of those is the setting.
 */
export function useSshConfigSync(client: KikiClient) {
  return useQuery({
    queryKey: sshKeys.configSync(),
    queryFn: () => sshApi(client).configSync(),
    staleTime: 30_000,
  });
}

/**
 * Known_hosts entries for one host, read only when `enabled` turns true: the
 * list screen must not fan out one file read per host, and the route opens no
 * connection of its own.
 */
export function useSshHostKeys(client: KikiClient, hostId: string, enabled: boolean) {
  return useQuery({
    queryKey: sshKeys.hostKeys(hostId),
    queryFn: () => sshApi(client).hostKeys(hostId),
    enabled,
    staleTime: 30_000,
  });
}

/** Connected-host state words shown on rows and chips; idle draws nothing. */
export type SshVisibleState = Exclude<SshHostStatus['state'], 'idle'>;

export function visibleState(status: SshHostStatus | undefined): SshVisibleState | undefined {
  if (status === undefined || status.state === 'idle') return undefined;
  return status.state;
}

/** Flag read from `/meta`; the same query key the settings pages share. */
export function useNativeSshEnabled(client: KikiClient): { enabled: boolean | undefined; loading: boolean } {
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => client.meta(), staleTime: 15_000 });
  return {
    enabled: meta.data === undefined ? undefined : meta.data.experimental_flags?.[NATIVE_SSH_FLAG] === true,
    loading: meta.isLoading,
  };
}

export function useSshHosts(client: KikiClient, enabled = true) {
  return useQuery({
    queryKey: sshKeys.hosts(),
    queryFn: async () => (await sshApi(client).list()).hosts,
    enabled,
    staleTime: 10_000,
  });
}

export function useSessionSshHosts(client: KikiClient, sessionId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: sshKeys.session(sessionId ?? ''),
    queryFn: async (): Promise<SshSessionHostsResponse['hosts']> => (await sshApi(client).sessionHosts(sessionId!)).hosts,
    enabled: enabled && sessionId !== undefined,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });
}

/** Build the PUT body from form values; blank optionals are left to ssh config. */
export function sshHostInput(values: {
  name: string;
  hostname: string;
  user: string;
  port: string;
  identityFile: string;
  roots: string;
  description: string;
  offered: boolean;
}): SshHostInput {
  const roots = values.roots.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  const port = values.port.trim();
  return {
    name: values.name.trim(),
    ...(values.hostname.trim() !== '' ? { hostname: values.hostname.trim() } : {}),
    ...(values.user.trim() !== '' ? { user: values.user.trim() } : {}),
    ...(port !== '' ? { port: Number(port) } : {}),
    ...(values.identityFile.trim() !== '' ? { identityFile: values.identityFile.trim() } : {}),
    ...(roots.length > 0 ? { roots } : {}),
    ...(values.description.trim() !== '' ? { description: values.description.trim() } : {}),
    agentAccess: values.offered ? 'offered' : 'hidden',
  };
}
