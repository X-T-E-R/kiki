// Unbundled browser module: the extension is part of the URL.
// oxlint-disable-next-line import/extensions
import {
  STORE_ORIGIN_KEY,
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
  updateSavedServerOrigin,
  verifySavedServerOrigin,
} from './target.js';

/*
 * The shell's unconnected onboarding and server management screen.
 * Leads with QR scanning (requesting camera permission only on tap), immediately
 * adjacent to manual address + pairing code entry, network reachability testing,
 * and saved computers whose device trust is kept separate from their current IP.
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

async function saveWebPeerToken(serverId, token) {
  if (!serverId || !token) return;
  ephemeralTokens.set(serverId, token);
  try {
    const db = await openVaultDb();
    if (!db) return;
    try {
      const key = await getOrCreateVaultKey(db);
      if (key) {
        const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
        const aad = new TextEncoder().encode(serverId);
        const cipher = await globalThis.crypto.subtle.encrypt(
          { name: 'AES-GCM', iv, additionalData: aad },
          key,
          new TextEncoder().encode(token),
        );
        await idbPut(db, serverId, { iv, cipher });
      } else {
        await idbPut(db, serverId, { token });
      }
    } finally {
      db.close();
    }
  } catch {
    /* fallback to in-memory map */
  }
}

async function readWebPeerToken(serverId) {
  if (!serverId) return undefined;
  if (ephemeralTokens.has(serverId)) {
    return ephemeralTokens.get(serverId);
  }
  try {
    const db = await openVaultDb();
    if (!db) return undefined;
    try {
      const record = await idbGet(db, serverId);
      if (!record) return undefined;
      if (record.iv && record.cipher && globalThis.crypto?.subtle) {
        const key = await getOrCreateVaultKey(db);
        if (!key) return undefined;
        const aad = new TextEncoder().encode(serverId);
        const plain = await globalThis.crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: record.iv, additionalData: aad },
          key,
          record.cipher,
        );
        const decoded = new TextDecoder().decode(plain);
        if (decoded) {
          ephemeralTokens.set(serverId, decoded);
          return decoded;
        }
      } else if (typeof record.token === 'string' && record.token !== '') {
        ephemeralTokens.set(serverId, record.token);
        return record.token;
      }
    } finally {
      db.close();
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

async function deleteWebPeerToken(serverId) {
  if (!serverId) return;
  ephemeralTokens.delete(serverId);
  try {
    const db = await openVaultDb();
    if (!db) return;
    try {
      await idbDelete(db, serverId);
    } finally {
      db.close();
    }
  } catch {
    /* ignore */
  }
}

const COPY = {
  en: {
    lede: 'Connect to Kiki on your computer.',
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
    testAddress: 'Test address',
    testing: 'Testing…',
    recent: 'Saved computers',
    pairedBadge: 'Paired',
    editAddress: 'Address',
    closeAddress: 'Done',
    saveAddress: 'Save address',
    forgetServer: 'Forget',
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
    identityMismatch:
      '{host} belongs to a different Kiki computer. Kept {label} on its verified address — enter a pairing code to pair the new computer.',
  },
  zh: {
    lede: '连接你电脑上的 Kiki。',
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
    testAddress: '测试连接',
    testing: '正在测试…',
    recent: '已保存的电脑',
    pairedBadge: '已配对',
    editAddress: '网络地址',
    closeAddress: '收起',
    saveAddress: '保存地址',
    forgetServer: '移除',
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
    identityMismatch:
      '{host} 属于另一台 Kiki 电脑，已保留 {label} 的原配对地址。如需连接该地址，请使用新配对码重新配对。',
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
const testButton = document.querySelector('#test-server');
const problem = document.querySelector('#problem');
const probeStatus = document.querySelector('#probe-status');
const scanButton = document.querySelector('#scan-qr');
const scanFeedback = document.querySelector('#scan-feedback');
const scannerPanel = document.querySelector('#scanner-panel');
const scannerVideo = document.querySelector('#scanner-video');
const scanCancel = document.querySelector('#scan-cancel');
const recent = document.querySelector('#recent');
const recentList = document.querySelector('#recent-list');

let activeStream = null;
let scanLoopActive = false;
let editingServerId = null;

function isNativeShell() {
  return window.Capacitor?.isNativePlatform?.() === true;
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
  const host = info.host || displayOrigin(originOrRaw).replace(' · http', '');
  if (info.layer === 'vpn') return copy.unreachableVpn.replace('{host}', host);
  if (info.layer === 'https' || info.layer === 'http') return copy.unreachableHttps.replace('{host}', host);
  return copy.unreachableLan.replace('{host}', host);
}

function identityMismatchMessageFor(originOrRaw, label) {
  const host = displayOrigin(originOrRaw).replace(' · http', '');
  return copy.identityMismatch
    .replace('{host}', host)
    .replace('{label}', label || (lang === 'zh' ? '已保存电脑' : 'saved computer'));
}

function showProblem(text) {
  problem.textContent = text;
  problem.hidden = text === '';
  input.ariaInvalid = text === '' ? 'false' : 'true';
  if (text !== '') {
    probeStatus.hidden = true;
    probeStatus.textContent = '';
  }
}

function showProbeStatus(text) {
  probeStatus.textContent = text;
  probeStatus.hidden = text === '';
  if (text !== '') {
    problem.hidden = true;
    problem.textContent = '';
    input.ariaInvalid = 'false';
  }
}

function showScanFeedback(text) {
  scanFeedback.textContent = text;
  scanFeedback.hidden = text === '';
}

function updateInputAffordances() {
  const raw = input.value.trim();
  const hasCode = codeInput.value.trim() !== '' || /^kiki:\/\/pair/i.test(raw);
  button.textContent = hasCode ? copy.pairAndOpen : copy.open;
  if (raw === '') {
    layerBadge.hidden = true;
    layerBadge.textContent = '';
    return;
  }
  const target = /^kiki:\/\//i.test(raw) ? readScanPayload(raw) : readTarget(raw);
  if (!target.ok) {
    layerBadge.hidden = true;
    layerBadge.textContent = '';
    return;
  }
  layerBadge.textContent = layerLabelFor(target.origin);
  layerBadge.hidden = false;
}

async function probeServer(origin) {
  if (isNativeShell()) {
    try {
      const res = await window.Capacitor.nativePromise('KikiShell', 'probe', { origin });
      return {
        ok: Boolean(res?.ok),
        targetLabel: typeof res?.targetLabel === 'string' && res.targetLabel !== '' ? res.targetLabel : undefined,
        targetHomeId: typeof res?.targetHomeId === 'string' && res.targetHomeId !== '' ? res.targetHomeId : undefined,
        targetHostId: typeof res?.targetHostId === 'string' && res.targetHostId !== '' ? res.targetHostId : undefined,
      };
    } catch {
      return { ok: false };
    }
  }
  return probeOriginHandshake(origin);
}

async function claimPairing(endpoint, code) {
  const platform = /iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'ios' : 'android';
  const identity = readDeviceIdentity(window.localStorage, platform);
  if (isNativeShell()) {
    try {
      const res = await window.Capacitor.nativePromise('KikiShell', 'claimPair', {
        endpoint,
        code,
        homeId: identity.homeId,
        hostId: identity.hostId,
        sourceLabel: identity.label,
      });
      if (res?.ok) {
        return {
          ok: true,
          targetHomeId: res.targetHomeId,
          targetHostId: res.targetHostId,
          targetLabel: res.targetLabel,
          grantId: res.grantId,
          serverId: res.serverId ?? res.targetHomeId,
        };
      }
      return {
        ok: false,
        reason: res?.reason === 'rejected' ? 'rejected' : 'unreachable',
      };
    } catch {
      /* fall through if native method is unavailable */
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(`${endpoint}/api/remote-connections/pair/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        code,
        source: {
          homeId: identity.homeId,
          hostId: identity.hostId,
          protocol: 1,
        },
        sourceLabel: identity.label,
        requestBridge: false,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        reason: response.status >= 400 && response.status < 500 ? 'rejected' : 'unreachable',
      };
    }
    const payload = await response.json();
    const data = payload?.data;
    if (!data || typeof data.peerToken !== 'string' || !data.target?.homeId) {
      return { ok: false, reason: 'rejected' };
    }
    await saveWebPeerToken(data.target.homeId, data.peerToken);
    return {
      ok: true,
      targetHomeId: data.target.homeId,
      targetHostId: data.target.hostId,
      targetLabel: data.targetLabel,
      grantId: data.grantId,
      serverId: data.target.homeId,
    };
  } catch {
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
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
    getToken: readWebPeerToken,
  });

  if (!resolved.ok) {
    button.disabled = false;
    renderSavedServers();
    if (resolved.reason === 'identity_mismatch') {
      input.value = displayOrigin(origin).replace(' · http', '');
      updateInputAffordances();
      showProblem(identityMismatchMessageFor(origin, resolved.server?.label ?? options.label));
      codeInput.focus();
    } else {
      updateInputAffordances();
      showProblem(unreachableMessageFor(origin));
    }
    return;
  }

  const serverId = resolved.serverId;

  if (isNativeShell()) {
    try {
      const res = await window.Capacitor.nativePromise('KikiShell', 'open', {
        origin,
        entry,
        serverId: isPairedTarget ? (serverId ?? undefined) : undefined,
        targetHomeId: options.targetHomeId ?? undefined,
        targetHostId: options.targetHostId ?? undefined,
      });
      if (res && res.ok === false) {
        button.disabled = false;
        if (res.reason === 'identity_mismatch' && targetServerId) {
          const rollback = verifySavedServerOrigin(window.localStorage, targetServerId, origin, {
            ok: true,
            targetHomeId: res.targetHomeId,
          });
          renderSavedServers();
          input.value = displayOrigin(origin).replace(' · http', '');
          updateInputAffordances();
          showProblem(identityMismatchMessageFor(origin, rollback.server?.label ?? options.label));
          codeInput.focus();
        } else {
          updateInputAffordances();
          showProblem(unreachableMessageFor(origin));
        }
      }
      return;
    } catch {
      /* fall through to plain navigation */
    }
  }

  window.location.assign(resolved.finalEntry);
}

async function submitConnect(parsed) {
  showProblem('');
  showProbeStatus('');

  if (parsed.kind === 'pair') {
    button.disabled = true;
    button.textContent = copy.pairing;
    const claim = await claimPairing(parsed.endpoint ?? parsed.origin, parsed.code);
    if (!claim.ok) {
      button.disabled = false;
      updateInputAffordances();
      showProblem(
        claim.reason === 'rejected'
          ? copy.pairRejected
          : unreachableMessageFor(parsed.origin),
      );
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
      verified: true,
    });
    return;
  }

  const existing = readSavedServers(window.localStorage).find(
    (s) => s.origin === parsed.origin || s.origins.includes(parsed.origin),
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

function stopCameraScanner() {
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
}

async function handleScannedPayload(rawValue) {
  stopCameraScanner();
  const parsed = readScanPayload(rawValue);
  if (!parsed.ok) {
    showScanFeedback(copy.invalid_qr);
    input.focus();
    return;
  }
  showScanFeedback('');
  input.value = displayOrigin(parsed.origin).replace(' · http', '');
  if (parsed.kind === 'pair') {
    codeInput.value = parsed.code;
  }
  updateInputAffordances();
  await submitConnect(parsed);
}

async function startWebCameraLoop() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showScanFeedback(copy.cameraUnavailable);
    input.focus();
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
    input.focus();
    return;
  }

  activeStream = stream;
  scannerVideo.srcObject = stream;
  scannerPanel.hidden = false;
  try {
    await scannerVideo.play();
  } catch {
    /* play may resolve after metadata */
  }

  if (typeof window.BarcodeDetector !== 'function') {
    stopCameraScanner();
    showScanFeedback(copy.cameraUnavailable);
    input.focus();
    return;
  }

  let detector;
  try {
    detector = new window.BarcodeDetector({ formats: ['qr_code'] });
  } catch {
    detector = new window.BarcodeDetector();
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
  showProbeStatus('');
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

function renderSavedServers() {
  const servers = readSavedServers(window.localStorage);
  if (servers.length === 0) {
    recent.hidden = true;
    recentList.replaceChildren();
    return;
  }
  recent.hidden = false;
  recentList.replaceChildren();

  servers.forEach((server, index) => {
    const card = document.createElement('div');
    card.className = 'saved-card';
    card.dataset.serverId = server.id;

    const mainRow = document.createElement('div');
    mainRow.className = 'saved-main';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'recent-row';
    if (index === 0) {
      openBtn.id = 'recent-open';
    }

    const summary = document.createElement('div');
    summary.className = 'saved-summary';

    const titleRow = document.createElement('div');
    titleRow.className = 'saved-title-row';

    const labelSpan = document.createElement('span');
    labelSpan.className = 'saved-label';
    labelSpan.textContent = server.label;
    titleRow.append(labelSpan);

    if (server.paired) {
      const pairedBadge = document.createElement('span');
      pairedBadge.className = 'saved-badge';
      pairedBadge.textContent = copy.pairedBadge;
      titleRow.append(pairedBadge);
    }

    const metaRow = document.createElement('div');
    metaRow.className = 'saved-meta';

    const hostSpan = document.createElement('span');
    hostSpan.className = 'recent-host';
    if (index === 0) {
      hostSpan.id = 'recent-host';
    }
    hostSpan.textContent = displayOrigin(server.origin);

    const layerSpan = document.createElement('span');
    layerSpan.className = 'saved-layer';
    layerSpan.textContent = `· ${shortLayerLabelFor(server.origin)}`;

    metaRow.append(hostSpan, layerSpan);
    summary.append(titleRow, metaRow);

    const arrow = document.createElement('span');
    arrow.className = 'recent-go';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '→';

    openBtn.append(summary, arrow);
    openBtn.addEventListener('click', () => {
      void openServer(server.origin, `${server.origin}/`, {
        serverId: server.id,
        label: server.label,
        paired: server.paired,
        targetHomeId: server.targetHomeId,
        targetHostId: server.targetHostId,
        grantId: server.grantId,
      });
    });

    const isEditing = editingServerId === server.id;
    const editToggle = document.createElement('button');
    editToggle.type = 'button';
    editToggle.className = 'saved-edit-toggle';
    editToggle.setAttribute('aria-expanded', isEditing ? 'true' : 'false');
    editToggle.textContent = isEditing ? copy.closeAddress : copy.editAddress;
    editToggle.addEventListener('click', () => {
      editingServerId = editingServerId === server.id ? null : server.id;
      renderSavedServers();
    });

    mainRow.append(openBtn, editToggle);
    card.append(mainRow);

    if (isEditing) {
      const editor = document.createElement('div');
      editor.className = 'saved-editor';

      if (server.origins.length > 1) {
        const endpointsWrap = document.createElement('div');
        endpointsWrap.className = 'saved-endpoints';
        for (const ep of server.origins) {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'endpoint-chip';
          chip.setAttribute('aria-current', ep === server.origin ? 'true' : 'false');
          chip.textContent = `${displayOrigin(ep).replace(' · http', '')} · ${layerLabelFor(ep)}`;
          chip.addEventListener('click', () => {
            updateSavedServerOrigin(window.localStorage, server.id, ep);
            renderSavedServers();
          });
          endpointsWrap.append(chip);
        }
        editor.append(endpointsWrap);
      }

      const editorRow = document.createElement('div');
      editorRow.className = 'saved-editor-row';

      const addrInput = document.createElement('input');
      addrInput.type = 'url';
      addrInput.className = 'saved-editor-input';
      addrInput.value = displayOrigin(server.origin).replace(' · http', '');
      addrInput.placeholder = '100.90.1.8:5494';
      addrInput.setAttribute('aria-label', copy.label);
      editorRow.append(addrInput);

      const statusLine = document.createElement('p');
      statusLine.className = 'saved-editor-status';
      statusLine.hidden = true;

      const actionsRow = document.createElement('div');
      actionsRow.className = 'saved-editor-actions';

      const forgetBtn = document.createElement('button');
      forgetBtn.type = 'button';
      forgetBtn.className = 'mini-button mini-danger';
      forgetBtn.textContent = copy.forgetServer;
      forgetBtn.addEventListener('click', () => {
        ephemeralTokens.delete(server.id);
        if (server.targetHomeId) ephemeralTokens.delete(server.targetHomeId);
        removeSavedServer(window.localStorage, server.id);
        if (editingServerId === server.id) editingServerId = null;
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
        void deleteWebPeerToken(server.id);
        if (server.targetHomeId) void deleteWebPeerToken(server.targetHomeId);
      });

      const rightBtns = document.createElement('div');
      rightBtns.className = 'saved-editor-right';

      const testEditBtn = document.createElement('button');
      testEditBtn.type = 'button';
      testEditBtn.className = 'mini-button';
      testEditBtn.textContent = copy.testAddress;
      testEditBtn.addEventListener('click', async () => {
        const parsed = readTarget(addrInput.value);
        if (!parsed.ok) {
          statusLine.dataset.tone = 'danger';
          statusLine.textContent = copy[parsed.reason] || copy.invalid;
          statusLine.hidden = false;
          return;
        }
        testEditBtn.disabled = true;
        testEditBtn.textContent = copy.testing;
        const probe = await probeServer(parsed.origin);
        testEditBtn.disabled = false;
        testEditBtn.textContent = copy.testAddress;
        if (probe.ok) {
          if (server.paired && server.targetHomeId) {
            const check = verifySavedServerOrigin(window.localStorage, server.id, parsed.origin, probe);
            if (!check.ok) {
              const mismatchText = identityMismatchMessageFor(
                parsed.origin,
                check.server?.label ?? server.label,
              );
              statusLine.dataset.tone = 'danger';
              statusLine.textContent = mismatchText;
              statusLine.hidden = false;
              input.value = displayOrigin(parsed.origin).replace(' · http', '');
              updateInputAffordances();
              showProblem(mismatchText);
              return;
            }
          }
          const host = displayOrigin(parsed.origin).replace(' · http', '');
          statusLine.dataset.tone = 'ok';
          statusLine.textContent = copy.probeOk
            .replace('{host}', host)
            .replace('{layer}', layerLabelFor(parsed.origin));
          statusLine.hidden = false;
        } else {
          statusLine.dataset.tone = 'danger';
          statusLine.textContent = unreachableMessageFor(parsed.origin);
          statusLine.hidden = false;
        }
      });

      const saveEditBtn = document.createElement('button');
      saveEditBtn.type = 'button';
      saveEditBtn.className = 'mini-button mini-primary';
      saveEditBtn.textContent = copy.saveAddress;
      saveEditBtn.addEventListener('click', () => {
        const res = updateSavedServerOrigin(window.localStorage, server.id, addrInput.value);
        if (!res.ok) {
          statusLine.dataset.tone = 'danger';
          statusLine.textContent = copy[res.reason] || copy.invalid;
          statusLine.hidden = false;
          return;
        }
        renderSavedServers();
        const candidateOrigin = res.server.origin;
        const host = displayOrigin(candidateOrigin).replace(' · http', '');
        showProbeStatus(
          copy.addressSaved
            .replace('{host}', host)
            .replace('{layer}', layerLabelFor(candidateOrigin)),
        );
        if (
          res.server.paired &&
          res.server.targetHomeId &&
          !isServerOriginVerified(res.server, candidateOrigin)
        ) {
          void (async () => {
            const probe = await probeServer(candidateOrigin);
            if (!probe.ok) return;
            const current = readSavedServers(window.localStorage).find((s) => s.id === server.id);
            if (!current || !current.origins.includes(candidateOrigin)) return;
            const verified = verifySavedServerOrigin(
              window.localStorage,
              server.id,
              candidateOrigin,
              probe,
            );
            if (!verified.ok && verified.reason === 'identity_mismatch') {
              renderSavedServers();
              input.value = displayOrigin(candidateOrigin).replace(' · http', '');
              updateInputAffordances();
              showProblem(
                identityMismatchMessageFor(candidateOrigin, verified.server?.label ?? server.label),
              );
              codeInput.focus();
            } else if (verified.ok) {
              renderSavedServers();
            }
          })();
        }
      });

      rightBtns.append(testEditBtn, saveEditBtn);
      actionsRow.append(forgetBtn, rightBtns);
      editor.append(editorRow, actionsRow, statusLine);
      card.append(editor);
    }

    recentList.append(card);
  });
}

scanButton.addEventListener('click', () => {
  void startQrScan();
});

scanCancel.addEventListener('click', () => {
  stopCameraScanner();
  input.focus();
});

input.addEventListener('input', () => {
  if (!problem.hidden) showProblem('');
  if (!probeStatus.hidden) showProbeStatus('');
  if (!scanFeedback.hidden) showScanFeedback('');
  const maybePair = readScanPayload(input.value);
  if (maybePair.ok && maybePair.kind === 'pair' && /^kiki:\/\/pair/i.test(input.value.trim())) {
    input.value = displayOrigin(maybePair.origin).replace(' · http', '');
    codeInput.value = maybePair.code;
  }
  updateInputAffordances();
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

testButton.addEventListener('click', async () => {
  const target = readTarget(input.value);
  if (!target.ok) {
    showProblem(copy[target.reason]);
    input.focus();
    return;
  }
  showProblem('');
  showProbeStatus('');
  testButton.disabled = true;
  testButton.textContent = copy.testing;
  const probe = await probeServer(target.origin);
  testButton.disabled = false;
  testButton.textContent = copy.testAddress;
  if (probe.ok) {
    const host = displayOrigin(target.origin).replace(' · http', '');
    showProbeStatus(
      copy.probeOk
        .replace('{host}', host)
        .replace('{layer}', layerLabelFor(target.origin)),
    );
  } else {
    showProblem(unreachableMessageFor(target.origin));
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
  if (attempted === null) return;
  const host = displayOrigin(attempted).replace(' · http', '');
  if (input.value.trim() === '') {
    input.value = host;
  }
  updateInputAffordances();
  showProblem(unreachableMessageFor(attempted));
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

window.addEventListener('hashchange', () => {
  if (window.location.hash === '#unreachable') {
    showUnreachable();
  } else if (window.location.hash === '#pair') {
    void consumePendingPairIfAny();
  }
});

renderSavedServers();
updateInputAffordances();

let firstVisit = false;
try {
  firstVisit = sessionStorage.getItem(STARTED_KEY) === null;
  sessionStorage.setItem(STARTED_KEY, '1');
} catch {
  /* no session storage: always show the screen */
}

const reason = window.location.hash.replace(/^#/, '');
const servers = readSavedServers(window.localStorage);
const primaryServer = servers[0] ?? null;

const handledPair = await consumePendingPairIfAny();
if (!handledPair) {
  if (reason === 'unreachable') {
    showUnreachable();
  } else if (primaryServer !== null && firstVisit && reason === '') {
    await openServer(primaryServer.origin, `${primaryServer.origin}/`, {
      serverId: primaryServer.id,
      label: primaryServer.label,
      paired: primaryServer.paired,
      targetHomeId: primaryServer.targetHomeId,
      targetHostId: primaryServer.targetHostId,
      grantId: primaryServer.grantId,
    });
  }
}
