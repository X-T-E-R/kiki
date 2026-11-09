// Unbundled browser module: the extension is part of the URL.
// oxlint-disable-next-line import/extensions
import {
  STORE_ORIGIN_KEY,
  claimPairingOrigin,
  classifyOrigin,
  displayOrigin,
  formatPairingCodeInput,
  isServerOriginVerified,
  probeOriginHandshake,
  readConnectInput,
  readDeviceIdentity,
  readSavedServers,
  readScanPayload,
  readTarget,
  removeSavedServer,
  resolveVerifiedServerOpen,
  stripTokenFromEntry,
  updateSavedServerOrigin,
  verifySavedServerOrigin,
} from './target.js';

/*
 * The shell's own home, shown before any Kiki is connected and whenever the
 * user returns from a server. A persistent bottom bar switches between three
 * local views: Connect (QR scan, requesting camera permission only on tap, plus
 * manual address + pairing code), Computers (saved computers, whose device trust
 * is kept separate from their current IP), and Network (reachability checks and
 * per-computer address switching).
 */

const STARTED_KEY = 'kiki.shell.started';
const VAULT_DB_NAME = 'kiki.shell.vault';
const VAULT_STORE_NAME = 'tokens';
const VAULT_KEY_ID = '__aes_gcm_key__';
const ephemeralTokens = new Map();

function openVaultDb() {
  return new Promise((resolveDb, rejectDb) => {
    if (typeof indexedDB === 'undefined') {
      resolveDb(null);
      return;
    }
    const req = indexedDB.open(VAULT_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(VAULT_STORE_NAME)) {
        db.createObjectStore(VAULT_STORE_NAME);
      }
    };
    req.onsuccess = () => resolveDb(req.result);
    req.onerror = () => rejectDb(req.error);
  });
}

function idbGet(db, key) {
  return new Promise((resolveGet, rejectGet) => {
    const tx = db.transaction(VAULT_STORE_NAME, 'readonly');
    const req = tx.objectStore(VAULT_STORE_NAME).get(key);
    req.onsuccess = () => resolveGet(req.result);
    req.onerror = () => rejectGet(req.error);
  });
}

function idbPut(db, key, value) {
  return new Promise((resolvePut, rejectPut) => {
    const tx = db.transaction(VAULT_STORE_NAME, 'readwrite');
    tx.objectStore(VAULT_STORE_NAME).put(value, key);
    tx.oncomplete = () => resolvePut();
    tx.onerror = () => rejectPut(tx.error);
  });
}

function idbDelete(db, key) {
  return new Promise((resolveDel, rejectDel) => {
    const tx = db.transaction(VAULT_STORE_NAME, 'readwrite');
    tx.objectStore(VAULT_STORE_NAME).delete(key);
    tx.oncomplete = () => resolveDel();
    tx.onerror = () => rejectDel(tx.error);
  });
}

async function getOrCreateVaultKey(db) {
  if (!globalThis.crypto?.subtle) return null;
  const existing = await idbGet(db, VAULT_KEY_ID);
  if (existing) return existing;
  const key = await globalThis.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  await idbPut(db, VAULT_KEY_ID, key);
  return key;
}

function tokenVaultKey(serverId, origin) {
  return origin ? `${serverId}@${origin}` : serverId;
}

async function encryptAndStoreVaultEntry(db, key, vaultKey, token) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(vaultKey);
  const cipher = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    key,
    new TextEncoder().encode(token),
  );
  await idbPut(db, vaultKey, { iv, cipher });
}

async function readAndDecryptVaultEntry(db, key, vaultKey) {
  const record = await idbGet(db, vaultKey);
  if (!record) return undefined;
  if (!record.iv || !record.cipher) {
    await idbDelete(db, vaultKey).catch(() => {});
    return undefined;
  }
  const aad = new TextEncoder().encode(vaultKey);
  const plain = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: record.iv, additionalData: aad },
    key,
    record.cipher,
  );
  const decoded = new TextDecoder().decode(plain);
  return decoded || undefined;
}

async function saveWebPeerToken(serverId, token, origin) {
  if (!serverId || !token) return;
  ephemeralTokens.set(serverId, token);
  if (origin) {
    ephemeralTokens.set(tokenVaultKey(serverId, origin), token);
  }
  if (!globalThis.crypto?.subtle || typeof globalThis.crypto?.getRandomValues !== 'function') {
    return;
  }
  try {
    const db = await openVaultDb();
    if (!db) return;
    try {
      const key = await getOrCreateVaultKey(db);
      if (!key) return;
      await encryptAndStoreVaultEntry(db, key, serverId, token);
      if (origin) {
        await encryptAndStoreVaultEntry(db, key, tokenVaultKey(serverId, origin), token);
      }
    } finally {
      db.close();
    }
  } catch {
    /* keep in-memory token */
  }
}

async function readWebPeerToken(serverId, origin) {
  if (!serverId) return undefined;
  const scopedKey = origin ? tokenVaultKey(serverId, origin) : null;
  if (scopedKey && ephemeralTokens.has(scopedKey)) {
    return ephemeralTokens.get(scopedKey);
  }
  if (ephemeralTokens.has(serverId)) {
    return ephemeralTokens.get(serverId);
  }
  if (!globalThis.crypto?.subtle) {
    return undefined;
  }
  try {
    const db = await openVaultDb();
    if (!db) return undefined;
    try {
      const key = await getOrCreateVaultKey(db);
      if (!key) return undefined;
      if (scopedKey) {
        const scopedDecoded = await readAndDecryptVaultEntry(db, key, scopedKey);
        if (scopedDecoded) {
          ephemeralTokens.set(scopedKey, scopedDecoded);
          return scopedDecoded;
        }
      }
      const decoded = await readAndDecryptVaultEntry(db, key, serverId);
      if (decoded) {
        ephemeralTokens.set(serverId, decoded);
        return decoded;
      }
    } finally {
      db.close();
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

async function deleteWebPeerToken(serverId, origins = []) {
  if (!serverId) return;
  ephemeralTokens.delete(serverId);
  for (const origin of origins) {
    ephemeralTokens.delete(tokenVaultKey(serverId, origin));
  }
  try {
    const db = await openVaultDb();
    if (!db) return;
    try {
      await idbDelete(db, serverId);
      for (const origin of origins) {
        await idbDelete(db, tokenVaultKey(serverId, origin));
      }
    } finally {
      db.close();
    }
  } catch {
    /* ignore */
  }
}

const COPY = {
  en: {
    connectTitle: 'Connect a computer',
    lede: 'Scan the QR code on your computer, or enter its address.',
    tabConnect: 'Connect',
    tabComputers: 'Computers',
    tabNetwork: 'Network',
    scanQr: 'Scan QR code',
    scanning: 'Scanning…',
    scannerPrompt: 'Point at the QR code',
    scanCancel: 'Enter manually',
    manualDivider: 'Or enter address',
    label: 'Server address or entry link',
    codeLabel: 'Pairing code',
    codeOptional: '8 chars · for new pairing',
    hint: 'Find the address and pairing code in Settings → Remote Connection on your computer.',
    open: 'Open Kiki',
    pairAndOpen: 'Pair & open',
    opening: 'Opening…',
    pairing: 'Pairing…',
    computersTitle: 'Computers',
    computersEmpty: 'No paired computers yet.',
    computersEmptyAction: 'Connect a computer',
    networkTitle: 'Network',
    probeTitle: 'Check an address',
    networkHint: 'LAN needs the same Wi‑Fi. Tailscale or VPN works across networks.',
    addressesTitle: 'Computer addresses',
    testAddress: 'Test',
    testing: 'Testing…',
    pairedBadge: 'Paired',
    manage: 'Manage',
    manageDone: 'Done',
    manageAddresses: 'Network addresses',
    forgetServer: 'Forget',
    currentAddress: 'Current',
    useAddress: 'Use',
    newAddress: 'New address',
    saveAddress: 'Save',
    layerLan: 'LAN · HTTP',
    layerVpn: 'Tailscale / VPN',
    layerHttps: 'HTTPS',
    layerHttp: 'HTTP',
    empty: 'Enter the address shown on your computer.',
    invalid: 'That is not a server address. Try something like 192.168.1.5:5494.',
    scheme: 'Only http and https addresses can be opened.',
    credentials: 'Leave the user name and password out of the address.',
    invalid_code: 'Enter the 8-character pairing code shown on your computer (such as 2345-6789).',
    invalid_qr: 'That QR code is not a Kiki pairing code. Enter the address or code below.',
    cameraDenied: 'Camera access is off. Enter the address and pairing code below.',
    cameraUnavailable: 'Camera is unavailable here. Enter the address and pairing code below.',
    pairRejected: 'That pairing code expired or was already used. Refresh the code on your computer and try again.',
    unreachableLan:
      'Could not reach {host} over LAN. Confirm Kiki is running and both devices share the same Wi-Fi, or switch to a VPN address.',
    unreachableVpn:
      'Could not reach {host} over VPN. Confirm Tailscale or your VPN is active on both devices and Kiki is running.',
    unreachableHttps:
      'Could not reach {host}. Confirm the HTTPS tunnel or reverse proxy is online and forwarding to Kiki.',
    probeOk: 'Reached {host} ({layer}). Ready to connect.',
    addressSaved: 'Updated address to {host} ({layer}). Device trust preserved.',
    pairingRequired:
      'Enter a pairing code or scan QR to trust {host}. Kept {label}.',
    identityMismatch:
      '{host} belongs to another Kiki computer. Enter a pairing code to pair; kept {label}.',
  },
  zh: {
    connectTitle: '连接电脑',
    lede: '扫描电脑上的二维码，或输入它的地址。',
    tabConnect: '连接',
    tabComputers: '电脑',
    tabNetwork: '网络',
    scanQr: '扫码连接',
    scanning: '正在扫码…',
    scannerPrompt: '对准电脑上的二维码',
    scanCancel: '手动输入',
    manualDivider: '或手动输入',
    label: '服务器地址或访问链接',
    codeLabel: '配对码',
    codeOptional: '8 位 · 新设备配对',
    hint: '在电脑端 设置 → 远程连接 查看地址与配对码。',
    open: '打开 Kiki',
    pairAndOpen: '配对并连接',
    opening: '正在打开…',
    pairing: '正在配对…',
    computersTitle: '电脑',
    computersEmpty: '还没有配对的电脑。',
    computersEmptyAction: '连接电脑',
    networkTitle: '网络',
    probeTitle: '检测地址',
    networkHint: '局域网需在同一 Wi‑Fi；Tailscale / VPN 可跨网络连接。',
    addressesTitle: '电脑地址',
    testAddress: '检测',
    testing: '检测中…',
    pairedBadge: '已配对',
    manage: '管理',
    manageDone: '完成',
    manageAddresses: '网络地址',
    forgetServer: '移除',
    currentAddress: '当前',
    useAddress: '使用',
    newAddress: '新地址',
    saveAddress: '保存',
    layerLan: '局域网 · HTTP',
    layerVpn: 'Tailscale / VPN',
    layerHttps: '外部 HTTPS',
    layerHttp: '外部 HTTP',
    empty: '请输入电脑端显示的地址。',
    invalid: '这不像服务器地址，可以试试 192.168.1.5:5494 这样的格式。',
    scheme: '只能打开 http 或 https 地址。',
    credentials: '地址里不要带用户名和密码。',
    invalid_code: '请输入电脑上显示的 8 位配对码（例如 2345-6789）。',
    invalid_qr: '这不是有效的 Kiki 配对二维码，请在下方输入地址或配对码。',
    cameraDenied: '未开启相机权限，可直接在下方输入地址与配对码。',
    cameraUnavailable: '当前环境无法启用相机，请在下方输入地址与配对码。',
    pairRejected: '配对码已过期或已被使用。请在电脑上刷新二维码或配对码后重试。',
    unreachableLan:
      '无法通过局域网连接 {host}。请确认电脑端 Kiki 正在运行且处于同一 Wi‑Fi，或改用 VPN 地址。',
    unreachableVpn:
      '无法通过 VPN 连接 {host}。请确认手机与电脑均已开启 Tailscale 或 VPN，且 Kiki 正在运行。',
    unreachableHttps:
      '无法连接 {host}。请确认外部 HTTPS 隧道或反向代理在线，并已转发至电脑上的 Kiki。',
    probeOk: '已连通 {host}（{layer}），可直接连接。',
    addressSaved: '已更新为 {host}（{layer}），已保留配对信任。',
    pairingRequired:
      '请输入新配对码或扫码以信任 {host}；已保留 {label}。',
    identityMismatch:
      '{host} 属于另一台 Kiki 电脑，请用新配对码重新配对；已保留 {label}。',
  },
};

const lang = /^zh\b/i.test(navigator.language) ? 'zh' : 'en';
const copy = COPY[lang];
document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
for (const node of document.querySelectorAll('[data-i18n]')) {
  const key = node.dataset.i18n;
  if (key && copy[key]) node.textContent = copy[key];
}

const form = document.querySelector('#connect');
const input = document.querySelector('#server');
const codeInput = document.querySelector('#pair-code');
const layerBadge = document.querySelector('#layer-badge');
const button = document.querySelector('#open');
const problem = document.querySelector('#problem');
const scanButton = document.querySelector('#scan-qr');
const scanFeedback = document.querySelector('#scan-feedback');
const scannerPanel = document.querySelector('#scanner-panel');
const scannerVideo = document.querySelector('#scanner-video');
const scanCancel = document.querySelector('#scan-cancel');
const recent = document.querySelector('#recent');
const recentList = document.querySelector('#recent-list');
const computersEmpty = document.querySelector('#computers-empty');
const emptyConnect = document.querySelector('#empty-connect');
const probeInput = document.querySelector('#probe-address');
const probeLayer = document.querySelector('#probe-layer');
const testButton = document.querySelector('#test-server');
const probeResult = document.querySelector('#probe-result');
const addresses = document.querySelector('#addresses');
const addressList = document.querySelector('#address-list');
const tabs = [...document.querySelectorAll('.tab[data-tab]')];
const views = {
  connect: document.querySelector('#view-connect'),
  computers: document.querySelector('#view-computers'),
  network: document.querySelector('#view-network'),
};

let activeStream = null;
let scanLoopActive = false;
let scannerHistoryEntry = false;
let managingServerId = null;
const addressStatus = new Map();

function isNativeShell() {
  return window.Capacitor?.isNativePlatform?.() === true;
}

function hostOf(origin) {
  return displayOrigin(origin).replace(' · http', '');
}

function setTab(name, options = {}) {
  if (!views[name]) return;
  if (name !== 'connect' && activeStream) stopCameraScanner();
  for (const [key, view] of Object.entries(views)) {
    view.hidden = key !== name;
  }
  for (const tab of tabs) {
    if (tab.dataset.tab === name) {
      tab.setAttribute('aria-current', 'page');
    } else {
      tab.removeAttribute('aria-current');
    }
  }
  if (name === 'network' && probeInput.value.trim() === '' && input.value.trim() !== '') {
    probeInput.value = input.value.trim();
    updateProbeLayer();
  }
  if (options.scroll !== false) window.scrollTo(0, 0);
}

function shortLayerLabelFor(originOrRaw) {
  const info = classifyOrigin(originOrRaw);
  if (info.layer === 'vpn') return copy.layerVpn;
  if (info.layer === 'https') return copy.layerHttps;
  if (info.layer === 'http') return copy.layerHttp;
  return lang === 'zh' ? '局域网' : 'LAN';
}

function layerLabelFor(originOrRaw) {
  const info = classifyOrigin(originOrRaw);
  if (info.layer === 'vpn') return copy.layerVpn;
  if (info.layer === 'https') return copy.layerHttps;
  if (info.layer === 'http') return copy.layerHttp;
  return copy.layerLan;
}

function unreachableMessageFor(originOrRaw) {
  const info = classifyOrigin(originOrRaw);
  const host = info.host || hostOf(originOrRaw);
  if (info.layer === 'vpn') return copy.unreachableVpn.replace('{host}', host);
  if (info.layer === 'https' || info.layer === 'http') return copy.unreachableHttps.replace('{host}', host);
  return copy.unreachableLan.replace('{host}', host);
}

function identityMismatchMessageFor(originOrRaw, label) {
  return copy.identityMismatch
    .replace('{host}', hostOf(originOrRaw))
    .replace('{label}', label || (lang === 'zh' ? '已保存电脑' : 'saved computer'));
}

function pairingRequiredMessageFor(originOrRaw, label) {
  return copy.pairingRequired
    .replace('{host}', hostOf(originOrRaw))
    .replace('{label}', label || (lang === 'zh' ? '已保存电脑' : 'saved computer'));
}

function probeOkMessageFor(origin) {
  return copy.probeOk.replace('{host}', hostOf(origin)).replace('{layer}', layerLabelFor(origin));
}

function showProblem(text) {
  problem.textContent = text;
  problem.hidden = text === '';
  input.ariaInvalid = text === '' ? 'false' : 'true';
  if (text !== '') setTab('connect', { scroll: false });
}

function showProbeResult(text, tone) {
  probeResult.textContent = text;
  probeResult.dataset.tone = tone ?? '';
  probeResult.hidden = text === '';
}

function showScanFeedback(text) {
  scanFeedback.textContent = text;
  scanFeedback.hidden = text === '';
}

function readAnyTarget(raw) {
  return /^kiki:\/\//i.test(raw) ? readScanPayload(raw) : readTarget(raw);
}

function updateInputAffordances() {
  const raw = input.value.trim();
  const hasCode = codeInput.value.trim() !== '' || /^kiki:\/\/pair/i.test(raw);
  button.textContent = hasCode ? copy.pairAndOpen : copy.open;
  const target = raw === '' ? null : readAnyTarget(raw);
  layerBadge.textContent = target?.ok ? layerLabelFor(target.origin) : '';
  layerBadge.hidden = !target?.ok;
}

function updateProbeLayer() {
  const raw = probeInput.value.trim();
  const target = raw === '' ? null : readTarget(raw);
  probeLayer.textContent = target?.ok ? layerLabelFor(target.origin) : '';
  probeLayer.hidden = !target?.ok;
}

async function probeServer(origin, probeOptions = {}) {
  if (isNativeShell()) {
    try {
      const res = await window.Capacitor.nativePromise('KikiShell', 'probe', {
        origin,
        serverId: probeOptions?.serverId ?? undefined,
        grantId: probeOptions?.grantId ?? undefined,
      });
      return {
        ok: Boolean(res?.ok),
        targetLabel: typeof res?.targetLabel === 'string' && res.targetLabel !== '' ? res.targetLabel : undefined,
        targetHomeId: typeof res?.targetHomeId === 'string' && res.targetHomeId !== '' ? res.targetHomeId : undefined,
        targetHostId: typeof res?.targetHostId === 'string' && res.targetHostId !== '' ? res.targetHostId : undefined,
        mutualProofVerified: Boolean(res?.mutualProofVerified),
      };
    } catch {
      return { ok: false };
    }
  }
  return probeOriginHandshake(origin, probeOptions);
}

async function claimPairing(endpoint, code) {
  const platform = /iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'ios' : 'android';
  const nativeIdentity = readDeviceIdentity(window.localStorage, platform);
  if (isNativeShell()) {
    return claimPairingOrigin(window.localStorage, {
      endpoint,
      code,
      platform,
      identity: nativeIdentity,
      nativeClaim: async (params) => {
        try {
          const res = await window.Capacitor.nativePromise('KikiShell', 'claimPair', {
            endpoint: params.endpoint,
            code: params.code,
            homeId: params.homeId,
            hostId: params.hostId,
            sourceLabel: params.sourceLabel,
          });
          if (res && typeof res.ok === 'boolean') return res;
        } catch {
          /* native bridge call failed: never fall back to browser token route */
        }
        return { ok: false, reason: 'unreachable' };
      },
    });
  }
  return claimPairingOrigin(window.localStorage, {
    endpoint,
    code,
    platform,
    identity: nativeIdentity,
    saveToken: saveWebPeerToken,
  });
}

function promptForPairing(origin, message) {
  setTab('connect');
  input.value = hostOf(origin);
  updateInputAffordances();
  showProblem(message);
  codeInput.focus();
}

function reportUnreachable(origin) {
  setTab('connect');
  if (input.value.trim() === '') {
    input.value = hostOf(origin);
  }
  updateInputAffordances();
  showProblem(unreachableMessageFor(origin));
}

async function openServer(origin, entry, options = {}) {
  const isPairedTarget = Boolean(options.paired || options.targetHomeId);
  const targetServerId = options.serverId ?? options.targetHomeId;

  button.disabled = true;
  button.textContent = copy.opening;

  const resolved = await resolveVerifiedServerOpen(window.localStorage, {
    ...options,
    origin,
    entry,
    probe: probeServer,
    requireMutualProof: isPairedTarget && isNativeShell(),
    getToken: isNativeShell() ? undefined : readWebPeerToken,
  });

  if (!resolved.ok) {
    button.disabled = false;
    renderSavedServers();
    if (resolved.reason === 'identity_mismatch') {
      promptForPairing(origin, identityMismatchMessageFor(origin, resolved.server?.label ?? options.label));
    } else if (resolved.reason === 'pairing_required') {
      promptForPairing(origin, pairingRequiredMessageFor(origin, resolved.server?.label ?? options.label));
    } else {
      input.value = hostOf(origin);
      reportUnreachable(origin);
    }
    return;
  }

  const serverId = resolved.serverId;

  try {
    window.name = '';
  } catch {}

  if (isNativeShell()) {
    try {
      const res = await window.Capacitor.nativePromise('KikiShell', 'open', {
        origin,
        entry: resolved.finalEntry,
        serverId: isPairedTarget ? (serverId ?? undefined) : undefined,
        grantId: isPairedTarget ? (resolved.server?.grantId ?? options.grantId ?? undefined) : undefined,
        targetHomeId: options.targetHomeId ?? undefined,
        targetHostId: options.targetHostId ?? undefined,
      });
      if (!res || res.ok === false) {
        button.disabled = false;
        renderSavedServers();
        if (res?.reason === 'identity_mismatch' && targetServerId) {
          const rollback = verifySavedServerOrigin(window.localStorage, targetServerId, origin, {
            ok: true,
            targetHomeId: res.targetHomeId,
          });
          renderSavedServers();
          promptForPairing(origin, identityMismatchMessageFor(origin, rollback.server?.label ?? options.label));
        } else if (res?.reason === 'pairing_required') {
          promptForPairing(origin, pairingRequiredMessageFor(origin, resolved.server?.label ?? options.label));
        } else {
          reportUnreachable(origin);
        }
      }
      return;
    } catch {
      button.disabled = false;
      renderSavedServers();
      reportUnreachable(origin);
      return;
    }
  }

  if (isPairedTarget || resolved.sessionToken) {
    button.disabled = false;
    renderSavedServers();
    reportUnreachable(origin);
    return;
  }

  window.location.assign(stripTokenFromEntry(origin, resolved.finalEntry));
}

function openSavedServer(server) {
  return openServer(server.origin, `${server.origin}/`, {
    serverId: server.id,
    label: server.label,
    paired: server.paired,
    targetHomeId: server.targetHomeId,
    targetHostId: server.targetHostId,
    grantId: server.grantId,
  });
}

async function submitConnect(parsed) {
  showProblem('');

  if (parsed.kind === 'pair') {
    button.disabled = true;
    button.textContent = copy.pairing;
    const claim = await claimPairing(parsed.endpoint ?? parsed.origin, parsed.code);
    if (!claim.ok) {
      button.disabled = false;
      updateInputAffordances();
      showProblem(claim.reason === 'rejected' ? copy.pairRejected : unreachableMessageFor(parsed.origin));
      return;
    }
    codeInput.value = '';
    await openServer(parsed.origin, `${parsed.origin}/`, {
      serverId: claim.serverId,
      label: claim.targetLabel,
      paired: true,
      targetHomeId: claim.targetHomeId,
      targetHostId: claim.targetHostId,
      grantId: claim.grantId,
    });
    return;
  }

  const existing = readSavedServers(window.localStorage).find(
    (s) =>
      isServerOriginVerified(s, parsed.origin) ||
      (!s.paired && !s.targetHomeId && (s.origin === parsed.origin || s.origins.includes(parsed.origin))),
  );
  await openServer(parsed.origin, parsed.entry, {
    serverId: existing?.id,
    label: existing?.label,
    paired: existing?.paired,
    targetHomeId: existing?.targetHomeId,
    targetHostId: existing?.targetHostId,
    grantId: existing?.grantId,
  });
}

function stopCameraScanner(options = {}) {
  scanLoopActive = false;
  if (activeStream) {
    for (const track of activeStream.getTracks()) track.stop();
    activeStream = null;
  }
  if (scannerVideo) {
    scannerVideo.srcObject = null;
  }
  scannerPanel.hidden = true;
  scanButton.disabled = false;
  const labelNode = scanButton.querySelector('[data-i18n="scanQr"]');
  if (labelNode) labelNode.textContent = copy.scanQr;
  if (scannerHistoryEntry) {
    scannerHistoryEntry = false;
    if (!options.fromHistory) history.back();
  }
}

async function handleScannedPayload(rawValue) {
  stopCameraScanner();
  setTab('connect', { scroll: false });
  const parsed = readScanPayload(rawValue);
  if (!parsed.ok) {
    showScanFeedback(copy.invalid_qr);
    input.focus();
    return;
  }
  showScanFeedback('');
  input.value = hostOf(parsed.origin);
  if (parsed.kind === 'pair') {
    codeInput.value = parsed.code;
  }
  updateInputAffordances();
  await submitConnect(parsed);
}

function focusManualConnectInput() {
  if (input.value.trim() !== '') {
    codeInput.focus();
  } else {
    input.focus();
  }
}

async function startWebCameraLoop() {
  if (!navigator.mediaDevices?.getUserMedia || typeof window.BarcodeDetector !== 'function') {
    showScanFeedback(copy.cameraUnavailable);
    focusManualConnectInput();
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
  } catch (error) {
    const denied = error && (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError');
    showScanFeedback(denied ? copy.cameraDenied : copy.cameraUnavailable);
    focusManualConnectInput();
    return;
  }

  activeStream = stream;
  scannerVideo.srcObject = stream;
  scannerPanel.hidden = false;
  scanButton.disabled = true;
  const labelNode = scanButton.querySelector('[data-i18n="scanQr"]');
  if (labelNode) labelNode.textContent = copy.scanning;
  history.pushState({ kikiScanner: true }, '');
  scannerHistoryEntry = true;
  scannerPanel.scrollIntoView({ block: 'nearest' });
  try {
    await scannerVideo.play();
  } catch {
    /* play may resolve after metadata */
  }

  let detector;
  try {
    detector = new window.BarcodeDetector({ formats: ['qr_code'] });
  } catch {
    try {
      detector = new window.BarcodeDetector();
    } catch {
      stopCameraScanner();
      showScanFeedback(copy.cameraUnavailable);
      focusManualConnectInput();
      return;
    }
  }

  scanLoopActive = true;
  const tick = async () => {
    if (!scanLoopActive || !activeStream) return;
    try {
      if (scannerVideo.readyState >= 2) {
        const codes = await detector.detect(scannerVideo);
        if (Array.isArray(codes) && codes.length > 0 && codes[0]?.rawValue) {
          await handleScannedPayload(codes[0].rawValue);
          return;
        }
      }
    } catch {
      /* continue scanning */
    }
    if (scanLoopActive) {
      requestAnimationFrame(() => {
        void tick();
      });
    }
  };
  requestAnimationFrame(() => {
    void tick();
  });
}

async function startQrScan() {
  showProblem('');
  showScanFeedback('');

  if (typeof window.__kikiTestScanQr === 'function') {
    const res = await window.__kikiTestScanQr();
    if (res?.status === 'scanned' && typeof res.value === 'string') {
      await handleScannedPayload(res.value);
    } else if (res?.status === 'denied') {
      showScanFeedback(copy.cameraDenied);
      input.focus();
    } else if (res?.status === 'cancelled') {
      input.focus();
    }
    return;
  }

  if (isNativeShell()) {
    try {
      const result = await window.Capacitor.nativePromise('KikiShell', 'scanQr', {});
      if (result?.status === 'scanned' && typeof result.value === 'string') {
        await handleScannedPayload(result.value);
        return;
      }
      if (result?.status === 'denied') {
        showScanFeedback(copy.cameraDenied);
        input.focus();
        return;
      }
      if (result?.status === 'cancelled') {
        stopCameraScanner();
        input.focus();
        return;
      }
    } catch {
      /* fall through to web camera */
    }
  }

  await startWebCameraLoop();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function forgetServer(server) {
  const allOrigins = [...new Set([server.origin, ...(server.origins ?? []), ...(server.verifiedOrigins ?? [])])];
  removeSavedServer(window.localStorage, server.id);
  if (managingServerId === server.id) managingServerId = null;
  addressStatus.delete(server.id);
  renderSavedServers();
  if (isNativeShell()) {
    try {
      void window.Capacitor.nativePromise('KikiShell', 'forgetServer', {
        serverId: server.id,
        origin: server.origin,
      });
    } catch {
      /* ignore */
    }
  }
  void deleteWebPeerToken(server.id, allOrigins);
  if (server.targetHomeId) void deleteWebPeerToken(server.targetHomeId, allOrigins);
}

function renderComputerRow(server, index) {
  const card = el('div', 'saved-card');
  card.dataset.serverId = server.id;

  const mainRow = el('div', 'saved-main');
  const openBtn = el('button', 'recent-row');
  openBtn.type = 'button';
  if (index === 0) openBtn.id = 'recent-open';

  const summary = el('div', 'saved-summary');
  const titleRow = el('div', 'saved-title-row');
  titleRow.append(el('span', 'saved-label', server.label));
  if (server.paired) titleRow.append(el('span', 'saved-badge', copy.pairedBadge));

  const metaRow = el('div', 'saved-meta');
  const hostSpan = el('span', 'recent-host', displayOrigin(server.origin));
  if (index === 0) hostSpan.id = 'recent-host';
  metaRow.append(hostSpan, el('span', 'saved-layer', `· ${shortLayerLabelFor(server.origin)}`));
  summary.append(titleRow, metaRow);

  const arrow = el('span', 'recent-go', '→');
  arrow.setAttribute('aria-hidden', 'true');
  openBtn.append(summary, arrow);
  openBtn.addEventListener('click', async () => {
    openBtn.disabled = true;
    openBtn.setAttribute('aria-busy', 'true');
    try {
      await openSavedServer(server);
    } finally {
      openBtn.disabled = false;
      openBtn.removeAttribute('aria-busy');
    }
  });

  const isManaging = managingServerId === server.id;
  const manageToggle = el('button', 'saved-edit-toggle', isManaging ? copy.manageDone : copy.manage);
  manageToggle.type = 'button';
  manageToggle.setAttribute('aria-expanded', isManaging ? 'true' : 'false');
  manageToggle.addEventListener('click', () => {
    managingServerId = managingServerId === server.id ? null : server.id;
    renderSavedServers();
  });

  mainRow.append(openBtn, manageToggle);
  card.append(mainRow);

  if (isManaging) {
    const manageRow = el('div', 'saved-manage');
    const addressesBtn = el('button', 'text-button', copy.manageAddresses);
    addressesBtn.type = 'button';
    addressesBtn.addEventListener('click', () => {
      setTab('network');
      addressList.querySelector(`[data-server-id="${CSS.escape(server.id)}"]`)?.scrollIntoView({ block: 'start' });
    });
    const forgetBtn = el('button', 'text-button danger', copy.forgetServer);
    forgetBtn.type = 'button';
    forgetBtn.classList.add('mini-danger');
    forgetBtn.addEventListener('click', () => forgetServer(server));
    manageRow.append(addressesBtn, forgetBtn);
    card.append(manageRow);
  }
  return card;
}

function setAddressStatus(serverId, text, tone) {
  if (text === '') {
    addressStatus.delete(serverId);
  } else {
    addressStatus.set(serverId, { text, tone });
  }
  const line = addressList.querySelector(`[data-server-id="${CSS.escape(serverId)}"] .addr-status`);
  if (!line) return;
  line.textContent = text;
  line.dataset.tone = tone ?? '';
  line.hidden = text === '';
}

async function testServerAddress(server, rawAddress, trigger) {
  const parsed = readTarget(rawAddress);
  if (!parsed.ok) {
    setAddressStatus(server.id, copy[parsed.reason] || copy.invalid, 'danger');
    return;
  }
  trigger.disabled = true;
  const original = trigger.textContent;
  trigger.textContent = copy.testing;
  setAddressStatus(server.id, '');
  const probe = await probeServer(
    parsed.origin,
    isServerOriginVerified(server, parsed.origin)
      ? { serverId: server.id, grantId: server.grantId }
      : undefined,
  );
  trigger.disabled = false;
  trigger.textContent = original;
  if (!probe.ok) {
    setAddressStatus(server.id, unreachableMessageFor(parsed.origin), 'danger');
    return;
  }
  if (server.paired && server.targetHomeId && probe.targetHomeId && probe.targetHomeId !== server.targetHomeId) {
    setAddressStatus(server.id, identityMismatchMessageFor(parsed.origin, server.label), 'danger');
    return;
  }
  setAddressStatus(server.id, probeOkMessageFor(parsed.origin), 'ok');
}

async function saveServerAddress(server, rawAddress, trigger) {
  const res = updateSavedServerOrigin(window.localStorage, server.id, rawAddress);
  if (!res.ok) {
    if (res.reason === 'pairing_required' && res.origin) {
      trigger.disabled = true;
      setAddressStatus(server.id, '');
      const probe = await probeServer(res.origin);
      trigger.disabled = false;
      const isDifferentHome = Boolean(
        probe.ok && server.targetHomeId && probe.targetHomeId && probe.targetHomeId !== server.targetHomeId,
      );
      renderSavedServers();
      promptForPairing(
        res.origin,
        isDifferentHome
          ? identityMismatchMessageFor(res.origin, server.label)
          : pairingRequiredMessageFor(res.origin, server.label),
      );
      return;
    }
    setAddressStatus(server.id, copy[res.reason] || copy.invalid, 'danger');
    return;
  }
  const candidateOrigin = res.server.origin;
  addressStatus.set(server.id, {
    text: copy.addressSaved.replace('{host}', hostOf(candidateOrigin)).replace('{layer}', layerLabelFor(candidateOrigin)),
    tone: 'ok',
  });
  renderSavedServers();
}

function renderAddressGroup(server) {
  const group = el('div', 'addr-group');
  group.dataset.serverId = server.id;
  group.append(el('h3', 'addr-owner', server.label));

  const list = el('ul', 'addr-list');
  for (const ep of server.origins) {
    const isCurrent = ep === server.origin;
    const row = el('li', 'addr-row');
    const main = el('div', 'addr-main');
    main.append(el('span', 'addr-host', hostOf(ep)), el('span', 'addr-layer', layerLabelFor(ep)));
    row.append(main);

    const actions = el('div', 'addr-actions');
    if (isCurrent) {
      actions.append(el('span', 'addr-current', copy.currentAddress));
    } else {
      const useBtn = el('button', 'mini-button endpoint-chip', copy.useAddress);
      useBtn.type = 'button';
      useBtn.setAttribute('aria-label', `${copy.useAddress} ${hostOf(ep)}`);
      useBtn.addEventListener('click', () => {
        const res = updateSavedServerOrigin(window.localStorage, server.id, ep);
        if (!res.ok && res.reason === 'pairing_required') {
          promptForPairing(ep, pairingRequiredMessageFor(ep, server.label));
          return;
        }
        addressStatus.delete(server.id);
        renderSavedServers();
      });
      actions.append(useBtn);
    }
    const testBtn = el('button', 'mini-button addr-test', copy.testAddress);
    testBtn.type = 'button';
    testBtn.setAttribute('aria-label', `${copy.testAddress} ${hostOf(ep)}`);
    testBtn.addEventListener('click', () => {
      void testServerAddress(server, ep, testBtn);
    });
    actions.append(testBtn);
    row.append(actions);
    list.append(row);
  }
  group.append(list);

  const addRow = el('div', 'inline-field addr-add');
  const addrInput = el('input', 'saved-editor-input');
  addrInput.type = 'url';
  addrInput.inputMode = 'url';
  addrInput.autocapitalize = 'off';
  addrInput.spellcheck = false;
  addrInput.setAttribute('autocorrect', 'off');
  addrInput.setAttribute('enterkeyhint', 'done');
  addrInput.placeholder = copy.newAddress;
  addrInput.setAttribute('aria-label', `${copy.newAddress} · ${server.label}`);
  const testNewBtn = el('button', 'secondary addr-test-new', copy.testAddress);
  testNewBtn.type = 'button';
  testNewBtn.addEventListener('click', () => {
    if (addrInput.value.trim() === '') {
      addrInput.focus();
      return;
    }
    void testServerAddress(server, addrInput.value, testNewBtn);
  });
  const saveBtn = el('button', 'secondary mini-primary', copy.saveAddress);
  saveBtn.type = 'button';
  saveBtn.addEventListener('click', () => {
    if (addrInput.value.trim() === '') {
      addrInput.focus();
      return;
    }
    void saveServerAddress(server, addrInput.value, saveBtn);
  });
  addrInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveBtn.click();
    }
  });
  addRow.append(addrInput, testNewBtn, saveBtn);
  group.append(addRow);

  const status = el('p', 'status-line addr-status');
  status.setAttribute('role', 'status');
  const saved = addressStatus.get(server.id);
  status.textContent = saved?.text ?? '';
  status.dataset.tone = saved?.tone ?? '';
  status.hidden = !saved;
  group.append(status);
  return group;
}

function renderSavedServers() {
  const servers = readSavedServers(window.localStorage);
  recentList.replaceChildren(...servers.map(renderComputerRow));
  recent.hidden = servers.length === 0;
  computersEmpty.hidden = servers.length > 0;
  addressList.replaceChildren(...servers.map(renderAddressGroup));
  addresses.hidden = servers.length === 0;
}

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    setTab(tab.dataset.tab);
  });
}

emptyConnect.addEventListener('click', () => {
  setTab('connect');
});

scanButton.addEventListener('click', () => {
  void startQrScan();
});

scanCancel.addEventListener('click', () => {
  stopCameraScanner();
  input.focus();
});

window.addEventListener('popstate', () => {
  if (scannerHistoryEntry) stopCameraScanner({ fromHistory: true });
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && activeStream) {
    stopCameraScanner();
    input.focus();
  }
});

input.addEventListener('input', () => {
  if (!problem.hidden) showProblem('');
  if (!scanFeedback.hidden) showScanFeedback('');
  const maybePair = readScanPayload(input.value);
  if (maybePair.ok && maybePair.kind === 'pair' && /^kiki:\/\/pair/i.test(input.value.trim())) {
    input.value = hostOf(maybePair.origin);
    codeInput.value = maybePair.code;
  }
  updateInputAffordances();
});

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && codeInput.value.trim() === '') {
    event.preventDefault();
    codeInput.focus();
  }
});

codeInput.addEventListener('input', () => {
  const formatted = formatPairingCodeInput(codeInput.value);
  if (codeInput.value !== formatted) {
    codeInput.value = formatted;
  }
  if (!problem.hidden) showProblem('');
  if (!scanFeedback.hidden) showScanFeedback('');
  updateInputAffordances();
});

probeInput.addEventListener('input', () => {
  if (!probeResult.hidden) showProbeResult('');
  updateProbeLayer();
});

probeInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    testButton.click();
  }
});

testButton.addEventListener('click', async () => {
  const target = readTarget(probeInput.value);
  if (!target.ok) {
    showProbeResult(copy[target.reason] || copy.invalid, 'danger');
    probeInput.focus();
    return;
  }
  showProbeResult('');
  testButton.disabled = true;
  testButton.textContent = copy.testing;
  const probe = await probeServer(target.origin);
  testButton.disabled = false;
  testButton.textContent = copy.testAddress;
  if (probe.ok) {
    showProbeResult(probeOkMessageFor(target.origin), 'ok');
  } else {
    showProbeResult(unreachableMessageFor(target.origin), 'danger');
  }
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const parsed = readConnectInput(input.value, codeInput.value);
  if (!parsed.ok) {
    showProblem(copy[parsed.reason] || copy.invalid);
    if (parsed.reason === 'invalid_code') {
      codeInput.focus();
    } else {
      input.focus();
    }
    return;
  }
  void submitConnect(parsed);
});

let restingHeight = window.visualViewport?.height ?? window.innerHeight;

function isTextEntry(node) {
  return node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement;
}

function updateKeyboardState() {
  const height = window.visualViewport?.height ?? window.innerHeight;
  const editing = isTextEntry(document.activeElement);
  if (!editing) restingHeight = height;
  document.body.classList.toggle('keyboard-open', editing && height < restingHeight - 120);
}

window.visualViewport?.addEventListener('resize', updateKeyboardState);
window.addEventListener('resize', updateKeyboardState);
document.addEventListener('focusin', () => {
  requestAnimationFrame(updateKeyboardState);
});
document.addEventListener('focusout', () => {
  requestAnimationFrame(updateKeyboardState);
});

function savedOrigin() {
  try {
    return window.localStorage.getItem(STORE_ORIGIN_KEY);
  } catch {
    return null;
  }
}

function showUnreachable() {
  const attempted = savedOrigin();
  button.disabled = false;
  updateInputAffordances();
  if (attempted === null) {
    setTab('connect');
    return;
  }
  reportUnreachable(attempted);
}

async function consumePendingPairIfAny() {
  if (isNativeShell()) {
    try {
      const pending = await window.Capacitor.nativePromise('KikiShell', 'consumePendingPair', {});
      if (pending && typeof pending.uri === 'string' && pending.uri !== '') {
        await handleScannedPayload(pending.uri);
        return true;
      }
    } catch {
      /* ignore */
    }
  }
  return false;
}

function landingTab() {
  return readSavedServers(window.localStorage).length > 0 ? 'computers' : 'connect';
}

window.addEventListener('hashchange', () => {
  if (window.location.hash === '#unreachable') {
    showUnreachable();
  } else if (window.location.hash === '#pair') {
    void consumePendingPairIfAny();
  } else if (window.location.hash === '#change') {
    setTab(landingTab());
  }
});

renderSavedServers();
updateInputAffordances();
setTab(landingTab());

let firstVisit = false;
try {
  firstVisit = sessionStorage.getItem(STARTED_KEY) === null;
  sessionStorage.setItem(STARTED_KEY, '1');
} catch {
  /* no session storage: always show the screen */
}

const reason = window.location.hash.replace(/^#/, '');
const primaryServer = readSavedServers(window.localStorage)[0] ?? null;

const handledPair = await consumePendingPairIfAny();
if (!handledPair) {
  if (reason === 'unreachable') {
    showUnreachable();
  } else if (primaryServer !== null && firstVisit && reason === '') {
    await openSavedServer(primaryServer);
  }
}
