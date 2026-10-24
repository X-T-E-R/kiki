/**
 * The editable shape of one browser connection: the draft the form holds, what
 * counts as dirty, which field is wrong, and the write shape the real protocol
 * schema accepts. Pure — no React, no client — so the card and its tests agree
 * on one set of rules and those rules stay readable on their own.
 *
 * Field rules mirror `packages/protocol/src/rest/browser.ts` and the store
 * behind it (`agent-core-v2/src/app/browser/browserConfig.ts`): a display name,
 * a stable id, an optional managed-driver path, and a type branch — profile
 * paths for a browser Kiki starts, a CDP endpoint for a browser that already
 * exists, and CLI fields for an installed Ego Lite app. Ego Lite and the Kimi
 * bridge carry no endpoint: the bridge reaches the person's own browser through
 * its local HTTP daemon, so there is no DevTools address to enter.
 */

import { browserConnectionInputSchema, browserIdSchema } from '@kiki/protocol';
import type { BrowserConnection, BrowserConnectionInput } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';

import { KEEP_SECRET, type SecretDraft } from '../SecretField';
import type { BrowserConnectionType, BrowserEndpointEdit } from '../../../lib/browserRest';

export interface BrowserDraft {
  /** Fixed once the connection exists; only a new draft can still choose it. */
  readonly id: string;
  /** The stored record this draft came from; undefined while creating. */
  readonly original: BrowserConnection | undefined;
  readonly name: string;
  readonly enabled: boolean;
  readonly type: BrowserConnectionType;
  /** The managed agent-browser binary on the server; blank means the server's PATH. */
  readonly driverPath: string;
  readonly profilePath: string;
  readonly executablePath: string;
  /** Profile branch only: run with a visible window instead of headless. */
  readonly headed: boolean;
  readonly endpoint: SecretDraft;
  readonly cliPath: string;
  readonly profileId: string;
  readonly serverName: string;
}

export interface BrowserDraftIssues {
  readonly id?: I18nKey;
  readonly name?: I18nKey;
  readonly driverPath?: I18nKey;
  readonly profilePath?: I18nKey;
  readonly executablePath?: I18nKey;
  readonly endpoint?: I18nKey;
  readonly cliPath?: I18nKey;
}

export function newBrowserDraft(): BrowserDraft {
  return {
    id: '', original: undefined, name: '', enabled: true, type: 'agent-browser-profile',
    driverPath: '', profilePath: '', executablePath: '', headed: false, endpoint: KEEP_SECRET,
    cliPath: '', profileId: '', serverName: '',
  };
}

export function draftOf(connection: BrowserConnection): BrowserDraft {
  return {
    id: connection.id,
    original: connection,
    name: connection.name,
    enabled: connection.enabled,
    type: connection.type,
    driverPath: connection.driverPath ?? '',
    profilePath: connection.profilePath ?? '',
    executablePath: connection.executablePath ?? '',
    headed: connection.headed === true,
    endpoint: KEEP_SECRET,
    cliPath: connection.cliPath ?? '',
    profileId: connection.profileId ?? '',
    serverName: connection.serverName ?? '',
  };
}

export function isNewDraft(draft: BrowserDraft): boolean {
  return draft.original === undefined;
}

export function isDirtyDraft(draft: BrowserDraft): boolean {
  return draft.original === undefined || JSON.stringify(draft) !== JSON.stringify(draftOf(draft.original));
}

/**
 * Whether the text names a location on the server. The GUI cannot know which
 * filesystem the server has, so all three absolute forms are accepted; a
 * relative path is refused here because the store refuses it too.
 */
function isAbsolutePath(text: string): boolean {
  return text.startsWith('/') || text.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(text);
}

/** The first thing wrong with this draft, per field, in the page's own words. */
export function draftIssues(draft: BrowserDraft, takenIds: readonly string[]): BrowserDraftIssues {
  const issues: { id?: I18nKey; name?: I18nKey; driverPath?: I18nKey; profilePath?: I18nKey; executablePath?: I18nKey; endpoint?: I18nKey; cliPath?: I18nKey } = {};
  if (isNewDraft(draft)) {
    const id = draft.id.trim();
    if (id === '') issues.id = 'st.browser.idRequired';
    else if (!browserIdSchema.safeParse(id).success) issues.id = 'st.browser.idInvalid';
    else if (takenIds.includes(id)) issues.id = 'st.browser.idTaken';
  }
  const name = draft.name.trim();
  if (name === '') issues.name = 'st.browser.nameRequired';
  else if (name.length > 256) issues.name = 'st.browser.nameTooLong';
  const driverPath = draft.driverPath.trim();
  if (driverPath !== '' && !isAbsolutePath(driverPath)) issues.driverPath = 'st.browser.pathInvalid';
  if (draft.type === 'agent-browser-profile') {
    const profilePath = draft.profilePath.trim();
    const executablePath = draft.executablePath.trim();
    if (profilePath !== '' && !isAbsolutePath(profilePath)) issues.profilePath = 'st.browser.pathInvalid';
    if (executablePath !== '' && !isAbsolutePath(executablePath)) issues.executablePath = 'st.browser.pathInvalid';
  } else if (draft.type === 'agent-browser-cdp' && (draft.endpoint.mode === 'clear' || (draft.endpoint.mode === 'set' && draft.endpoint.value.trim() === ''))) {
    issues.endpoint = 'st.browser.endpointRequired';
  } else if (draft.type === 'agent-browser-cdp' && draft.endpoint.mode === 'keep' && draft.original?.type !== 'agent-browser-cdp') {
    issues.endpoint = 'st.browser.endpointRequired';
  } else if (draft.type === 'ego-lite') {
    const cliPath = draft.cliPath.trim();
    if (cliPath !== '' && !isAbsolutePath(cliPath)) issues.cliPath = 'st.browser.pathInvalid';
    if (draft.profileId.trim().length > 256 || draft.serverName.trim().length > 256) issues.name = issues.name ?? 'st.browser.nameTooLong';
  }
  return issues;
}

export function hasIssues(issues: BrowserDraftIssues): boolean {
  return Object.values(issues).some((issue) => issue !== undefined);
}

function endpointEdit(draft: SecretDraft): BrowserEndpointEdit {
  return draft.mode === 'set' ? { action: 'set', value: draft.value.trim() } : { action: 'keep' };
}

export function browserConnectionInput(draft: BrowserDraft): BrowserConnectionInput {
  const name = draft.name.trim();
  const driverPath = draft.driverPath.trim();
  const driver = driverPath === '' ? undefined : driverPath;
  if (draft.type === 'codex-extension') {
    if (draft.original?.runtimeRoot === undefined || draft.original.browserId === undefined) throw new Error('st.browser.invalid');
    return { type: 'codex-extension', name, enabled: draft.enabled, runtimeRoot: draft.original.runtimeRoot, browserId: draft.original.browserId };
  }
  if (draft.type === 'agent-browser-profile') {
    const profilePath = draft.profilePath.trim();
    const executablePath = draft.executablePath.trim();
    return {
      name, enabled: draft.enabled, driverPath: driver, type: 'agent-browser-profile',
      profilePath: profilePath === '' ? undefined : profilePath,
      executablePath: executablePath === '' ? undefined : executablePath,
      // Absent means headless, so a headless connection stores nothing.
      headed: draft.headed ? true : undefined,
    };
  }
  if (draft.type === 'ego-lite') {
    const cliPath = draft.cliPath.trim();
    const profileId = draft.profileId.trim();
    const serverName = draft.serverName.trim();
    return {
      type: 'ego-lite', name, enabled: draft.enabled,
      ...(cliPath === '' ? {} : { cliPath }),
      ...(profileId === '' ? {} : { profileId }),
      ...(serverName === '' ? {} : { serverName }),
    };
  }
  if (draft.type === 'kimi-webbridge') {
    // Nothing addresses the bridge: the server talks to its own local daemon, so
    // the write shape is the type plus the common fields and no endpoint at all.
    return { name, enabled: draft.enabled, driverPath: driver, type: 'kimi-webbridge' };
  }
  if (draft.type === 'webbridge-command') {
    return { name, enabled: draft.enabled, type: 'webbridge-command' };
  }
  return { name, enabled: draft.enabled, driverPath: driver, type: 'agent-browser-cdp', endpoint: endpointEdit(draft.endpoint) };
}

/**
 * The same input through the published schema. The page's own checks run first
 * so a mistake is explained in the person's words; this is the authority, and a
 * disagreement surfaces as the page's "invalid configuration" line instead of a
 * request the server would reject.
 */
export function parseBrowserInput(input: BrowserConnectionInput): BrowserConnectionInput {
  const parsed = browserConnectionInputSchema.safeParse(input);
  if (!parsed.success) throw new Error('st.browser.invalid');
  return parsed.data;
}
