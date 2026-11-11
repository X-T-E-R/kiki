import { isEmbeddedAndroidHost } from './appShell';

export type AndroidPermissionKind =
  | 'accessibility'
  | 'overlay'
  | 'notifications'
  | 'battery'
  | 'oem_autostart';

export interface AndroidPermissionStatus {
  readonly accessibility: boolean;
  readonly overlay: boolean;
  readonly notifications: boolean;
  readonly battery: boolean;
  readonly oemAutostart?: boolean;
}

export interface AndroidCapabilities {
  readonly permissions: AndroidPermissionStatus;
  readonly abi?: string;
  readonly sdk?: number;
  readonly sandbox?: boolean;
  readonly version?: string;
}

export interface AndroidSharedItem {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly path?: string;
  readonly text?: string;
}

export interface AndroidBridge {
  capabilities(): Promise<AndroidCapabilities | null>;
  readClipboard(): Promise<string | null>;
  writeClipboard(text: string): Promise<boolean>;
  openPermission(kind: AndroidPermissionKind): Promise<void>;
  openPhoneSettings(): Promise<void>;
  setAppearance(payload: { readonly dark: boolean }): Promise<void>;
  share(payload: { readonly text?: string; readonly fileIds?: readonly string[] }): Promise<void>;
  capturePhoto(): Promise<{ readonly uploadId: string } | null>;
  takeShareIntake(id: string): Promise<readonly AndroidSharedItem[]>;
}

export const ANDROID_HOST_EVENT = 'kiki:android';

export type AndroidHostEventDetail =
  | { readonly type: 'permissions'; readonly permissions: Partial<AndroidPermissionStatus> }
  | { readonly type: 'navigate'; readonly route: string }
  | { readonly type: 'share-intake'; readonly id: string };

interface WebMessageBridgeGlobal {
  postMessage?(message: string): void;
  addEventListener?(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  onmessage?: ((event: MessageEvent<unknown>) => void) | null;
  getCapabilities?: () => string;
  capabilities?: () => string;
  readClipboard?: () => string | null;
  writeClipboard?: (text: string) => boolean | void;
  openPermission?: (kind: string) => void;
  openNativeSettings?: () => void;
  openPhoneSettings?: () => void;
  setAppearance?: (dark: boolean) => void;
  invoke?: (payload: string) => string;
}

interface PendingRpc {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

let rpcSeq = 0;
const pendingByBridge = new WeakMap<object, Map<string, PendingRpc>>();
const installedByBridge = new WeakSet<object>();

function rawAndroidGlobal(win: Window | undefined = globalThis.window): WebMessageBridgeGlobal | undefined {
  if (!win) return undefined;
  const candidate = (win as unknown as { KikiAndroid?: unknown }).KikiAndroid;
  if (!candidate || (typeof candidate !== 'object' && typeof candidate !== 'function')) {
    return undefined;
  }
  return candidate as WebMessageBridgeGlobal;
}

export function hasAndroidBridge(win: Window | undefined = globalThis.window): boolean {
  return rawAndroidGlobal(win) !== undefined;
}

function normalizePermissions(raw: unknown): AndroidPermissionStatus {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const bool = (value: unknown): boolean => value === true;
  return {
    accessibility: bool(record['accessibility']),
    overlay: bool(record['overlay']),
    notifications: bool(record['notifications'] ?? true),
    battery: bool(record['battery']),
    oemAutostart: typeof record['oemAutostart'] === 'boolean'
      ? record['oemAutostart']
      : typeof record['oem_autostart'] === 'boolean'
        ? record['oem_autostart']
        : undefined,
  };
}

function normalizeCapabilities(raw: unknown): AndroidCapabilities | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const permissionsSource =
    record['permissions'] && typeof record['permissions'] === 'object'
      ? record['permissions']
      : record;
  return {
    permissions: normalizePermissions(permissionsSource),
    abi: typeof record['abi'] === 'string' ? record['abi'] : undefined,
    sdk: typeof record['sdk'] === 'number' ? record['sdk'] : undefined,
    sandbox: typeof record['sandbox'] === 'boolean' ? record['sandbox'] : undefined,
    version: typeof record['version'] === 'string' ? record['version'] : undefined,
  };
}

function ensureWebMessageListener(bridge: WebMessageBridgeGlobal): Map<string, PendingRpc> {
  let pending = pendingByBridge.get(bridge);
  if (!pending) {
    pending = new Map();
    pendingByBridge.set(bridge, pending);
  }
  if (!installedByBridge.has(bridge)) {
    const onReply = (event: MessageEvent<unknown>): void => {
      const raw = typeof event.data === 'string'
        ? (() => { try { return JSON.parse(event.data) as unknown; } catch { return null; } })()
        : event.data;
      if (!raw || typeof raw !== 'object') return;
      const frame = raw as { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
      if (typeof frame.id !== 'string') return;
      const entry = pending!.get(frame.id);
      if (!entry) return;
      pending!.delete(frame.id);
      clearTimeout(entry.timer);
      if (frame.ok === false) {
        entry.reject(new Error(typeof frame.error === 'string' ? frame.error : 'Android bridge call failed'));
      } else {
        entry.resolve(frame.result);
      }
    };
    if (typeof bridge.addEventListener === 'function') {
      bridge.addEventListener('message', onReply);
      installedByBridge.add(bridge);
    } else if ('onmessage' in bridge) {
      bridge.onmessage = onReply;
      installedByBridge.add(bridge);
    }
  }
  return pending;
}

async function callAndroidBridge(
  method: string,
  params: Record<string, unknown> = {},
  win: Window | undefined = globalThis.window,
): Promise<unknown> {
  const bridge = rawAndroidGlobal(win);
  if (!bridge) return undefined;

  if (typeof bridge.postMessage === 'function') {
    const pending = ensureWebMessageListener(bridge);
    const id = `ka_${++rpcSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Android bridge ${method} timed out`));
      }, 4_000);
      pending.set(id, { resolve, reject, timer });
      try {
        bridge.postMessage!(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  if (typeof bridge.invoke === 'function') {
    const raw = bridge.invoke(JSON.stringify({ method, params }));
    const parsed = JSON.parse(raw) as { ok?: boolean; result?: unknown; error?: string };
    if (parsed.ok === false) throw new Error(parsed.error ?? 'Android bridge invoke failed');
    return parsed.result;
  }

  if (method === 'capabilities') {
    const fn = bridge.getCapabilities ?? bridge.capabilities;
    if (typeof fn === 'function') return JSON.parse(fn.call(bridge));
  }
  if (method === 'readClipboard' && typeof bridge.readClipboard === 'function') {
    return bridge.readClipboard();
  }
  if (method === 'writeClipboard' && typeof bridge.writeClipboard === 'function') {
    const result = bridge.writeClipboard(String(params['text'] ?? ''));
    return result !== false;
  }
  if (method === 'openPermission' && typeof bridge.openPermission === 'function') {
    bridge.openPermission(String(params['kind'] ?? ''));
    return undefined;
  }
  if (method === 'openNativeSettings' || method === 'openPhoneSettings') {
    const fn = bridge.openNativeSettings ?? bridge.openPhoneSettings;
    if (typeof fn === 'function') {
      fn.call(bridge);
      return undefined;
    }
  }
  if (method === 'setAppearance' && typeof bridge.setAppearance === 'function') {
    bridge.setAppearance(params['dark'] === true);
    return undefined;
  }
  return undefined;
}

export function createAndroidBridge(win: Window | undefined = globalThis.window): AndroidBridge {
  return {
    async capabilities(): Promise<AndroidCapabilities | null> {
      if (!hasAndroidBridge(win) && !isEmbeddedAndroidHost(win?.navigator?.userAgent ?? '')) {
        return null;
      }
      try {
        const raw = await callAndroidBridge('capabilities', {}, win);
        return normalizeCapabilities(raw);
      } catch {
        return null;
      }
    },
    async readClipboard(): Promise<string | null> {
      if (!hasAndroidBridge(win)) return null;
      try {
        const raw = await callAndroidBridge('readClipboard', {}, win);
        return typeof raw === 'string' ? raw : null;
      } catch {
        return null;
      }
    },
    async writeClipboard(text: string): Promise<boolean> {
      if (!hasAndroidBridge(win)) return false;
      try {
        const raw = await callAndroidBridge('writeClipboard', { text }, win);
        return raw !== false;
      } catch {
        return false;
      }
    },
    async openPermission(kind: AndroidPermissionKind): Promise<void> {
      if (!hasAndroidBridge(win)) throw new Error('Android host bridge is unavailable.');
      await callAndroidBridge('openPermission', { kind }, win);
    },
    async openPhoneSettings(): Promise<void> {
      if (!hasAndroidBridge(win)) throw new Error('Android host bridge is unavailable.');
      try {
        await callAndroidBridge('openNativeSettings', {}, win);
      } catch {
        await callAndroidBridge('openPhoneSettings', {}, win);
      }
    },
    async setAppearance(payload: { readonly dark: boolean }): Promise<void> {
      if (!hasAndroidBridge(win)) return;
      try {
        await callAndroidBridge('setAppearance', { dark: payload.dark }, win);
      } catch {
        // Ignore unknown-method errors on older Android host builds.
      }
    },
    async share(payload: { readonly text?: string; readonly fileIds?: readonly string[] }): Promise<void> {
      await callAndroidBridge('share', { ...payload }, win);
    },
    async capturePhoto(): Promise<{ readonly uploadId: string } | null> {
      const raw = await callAndroidBridge('capturePhoto', {}, win);
      if (raw && typeof raw === 'object' && typeof (raw as { uploadId?: unknown }).uploadId === 'string') {
        return { uploadId: (raw as { uploadId: string }).uploadId };
      }
      return null;
    },
    async takeShareIntake(id: string): Promise<readonly AndroidSharedItem[]> {
      const raw = await callAndroidBridge('takeShareIntake', { id }, win);
      return Array.isArray(raw) ? (raw as AndroidSharedItem[]) : [];
    },
  };
}

export const androidBridge: AndroidBridge = createAndroidBridge();

function parseEventObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

export function subscribeAndroidHostEvents(
  listener: (detail: AndroidHostEventDetail) => void,
  win: Window | undefined = globalThis.window,
): () => void {
  if (!win || typeof win.addEventListener !== 'function') return () => {};
  const handler = (event: Event): void => {
    const record = parseEventObject((event as CustomEvent<unknown>).detail);
    if (!record) return;
    const payload = parseEventObject(record['data']) ?? record;
    if (record['type'] === 'permissions') {
      const permsSource = parseEventObject(payload['permissions']) ?? (payload !== record ? payload : null);
      if (permsSource) {
        listener({ type: 'permissions', permissions: normalizePermissions(permsSource) });
      }
    } else if (record['type'] === 'navigate' && typeof payload['route'] === 'string') {
      listener({ type: 'navigate', route: payload['route'] });
    } else if (record['type'] === 'share-intake' && typeof payload['id'] === 'string') {
      listener({ type: 'share-intake', id: payload['id'] });
    }
  };
  win.addEventListener(ANDROID_HOST_EVENT, handler);
  return () => {
    win.removeEventListener(ANDROID_HOST_EVENT, handler);
  };
}
