import { COPY, type CopyKey, type Locale } from './copy';
import {
  decodeQrFromImageData,
  decodeQrFromImageFile,
  decodeQrFromVideo,
  type NativeBarcodeDetector,
} from './qr';
import * as TargetApi from './target';
import {
  STORE_ORIGIN_KEY,
  claimPairingOrigin,
  classifyOrigin,
  displayOrigin,
  editableOrigin,
  formatPairingCodeInput,
  getServerFingerprint,
  isServerOriginVerified,
  probeOriginHandshake,
  readConnectInput,
  readDeviceIdentity,
  readPastePayload,
  readSavedServers,
  readScanPayload,
  readTarget,
  removeSavedServer,
  resolveVerifiedServerOpen,
  stripTokenFromEntry,
  updateSavedServerOrigin,
  verifySavedServerOrigin,
  type HandshakeProbeResult,
  type HandshakeStatus,
  type NativeClaimResponse,
  type ProbeHandshakeOptions,
  type SavedServer,
} from './target';
import { deleteWebPeerToken, readWebPeerToken, saveWebPeerToken } from './vault';

interface CapacitorBridgeLike {
  isNativePlatform?: () => boolean;
  nativePromise: (plugin: string, method: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): NativeBarcodeDetector;
}

type LauncherExportApi = typeof TargetApi & {
  decodeQrFromImageData: typeof decodeQrFromImageData;
  saveWebPeerToken: typeof saveWebPeerToken;
  readWebPeerToken: typeof readWebPeerToken;
  deleteWebPeerToken: typeof deleteWebPeerToken;
  openServer?: (origin: string, entry: string, options?: OpenServerOptions) => Promise<void>;
};

interface LauncherGlobal {
  __kikiLauncher?: LauncherExportApi;
  __kikiTestReadClipboard?: () => Promise<string> | string;
  __kikiTestScanQr?: () => Promise<{ status?: string; value?: string }>;
  Capacitor?: CapacitorBridgeLike;
  BarcodeDetector?: BarcodeDetectorCtor;
}

const STARTED_KEY = 'kiki.shell.started';

(globalThis as unknown as LauncherGlobal).__kikiLauncher = {
  ...TargetApi,
  decodeQrFromImageData,
  saveWebPeerToken,
  readWebPeerToken,
  deleteWebPeerToken,
};

interface RecoveryBinding {
  origin: string;
  serverId: string;
  label?: string;
  targetHomeId?: string;
  targetHostId?: string;
  grantId?: string;
  server: SavedServer;
}

interface OpenServerOptions {
  serverId?: string;
  label?: string;
  paired?: boolean;
  targetHomeId?: string;
  targetHostId?: string;
  grantId?: string;
  fingerprint?: string;
  fromAutoRecovery?: boolean;
  expectedAutoEpoch?: number;
  expectedRecovery?: RecoveryBinding;
}

type ParsedConnectSubmission =
  | {
      kind: 'pair';
      origin: string;
      endpoint?: string;
      code: string;
      entry: string;
      fingerprint?: string;
    }
  | {
      kind: 'target';
      origin: string;
      entry: string;
    };

function bootstrapLauncherUi(): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const qForm = document.querySelector<HTMLFormElement>('#connect');
  const qInput = document.querySelector<HTMLInputElement>('#server');
  const qCodeInput = document.querySelector<HTMLInputElement>('#pair-code');
  const codeField = document.querySelector<HTMLElement>('.code-field');
  const qLayerBadge = document.querySelector<HTMLElement>('#layer-badge');
  const qButton = document.querySelector<HTMLButtonElement>('#open');
  const switchComputerBtn = document.querySelector<HTMLButtonElement>('#switch-computer');
  const hint = document.querySelector<HTMLElement>('#hint');
  const qProblem = document.querySelector<HTMLElement>('#problem');
  const qScanButton = document.querySelector<HTMLButtonElement>('#scan-qr');
  const pasteButton = document.querySelector<HTMLButtonElement>('#paste-link');
  const manualToggle = document.querySelector<HTMLButtonElement>('#manual-toggle');
  const qScanFeedback = document.querySelector<HTMLElement>('#scan-feedback');
  const qScannerPanel = document.querySelector<HTMLElement>('#scanner-panel');
  const qScannerVideo = document.querySelector<HTMLVideoElement>('#scanner-video');
  const qScanCancel = document.querySelector<HTMLButtonElement>('#scan-cancel');
  const pickQrPhotoButton = document.querySelector<HTMLButtonElement>('#pick-qr-photo');
  const pickQrPhotoFallbackButton = document.querySelector<HTMLButtonElement>('#pick-qr-photo-fallback');
  const qrPhotoInput = document.querySelector<HTMLInputElement>('#qr-photo-input');
  const qRecent = document.querySelector<HTMLElement>('#recent');
  const qRecentList = document.querySelector<HTMLElement>('#recent-list');
  const qComputersEmpty = document.querySelector<HTMLElement>('#computers-empty');
  const qEmptyConnect = document.querySelector<HTMLButtonElement>('#empty-connect');
  const qProbeInput = document.querySelector<HTMLInputElement>('#probe-address');
  const qProbeLayer = document.querySelector<HTMLElement>('#probe-layer');
  const qTestButton = document.querySelector<HTMLButtonElement>('#test-server');
  const qProbeResult = document.querySelector<HTMLElement>('#probe-result');
  const qAddresses = document.querySelector<HTMLElement>('#addresses');
  const qAddressList = document.querySelector<HTMLElement>('#address-list');
  const viewConnect = document.querySelector<HTMLElement>('#view-connect');
  const viewComputers = document.querySelector<HTMLElement>('#view-computers');
  const viewNetwork = document.querySelector<HTMLElement>('#view-network');

  if (
    !qForm ||
    !qInput ||
    !qCodeInput ||
    !qLayerBadge ||
    !qButton ||
    !qProblem ||
    !qScanButton ||
    !qScanFeedback ||
    !qScannerPanel ||
    !qScannerVideo ||
    !qScanCancel ||
    !qRecent ||
    !qRecentList ||
    !qComputersEmpty ||
    !qEmptyConnect ||
    !qProbeInput ||
    !qProbeLayer ||
    !qTestButton ||
    !qProbeResult ||
    !qAddresses ||
    !qAddressList ||
    !viewConnect ||
    !viewComputers ||
    !viewNetwork
  ) {
    return;
  }

  const form: HTMLFormElement = qForm;
  const input: HTMLInputElement = qInput;
  const codeInput: HTMLInputElement = qCodeInput;
  const layerBadge: HTMLElement = qLayerBadge;
  const button: HTMLButtonElement = qButton;
  const problem: HTMLElement = qProblem;
  const scanButton: HTMLButtonElement = qScanButton;
  const scanFeedback: HTMLElement = qScanFeedback;
  const scannerPanel: HTMLElement = qScannerPanel;
  const scannerVideo: HTMLVideoElement = qScannerVideo;
  const scanCancel: HTMLButtonElement = qScanCancel;
  const recent: HTMLElement = qRecent;
  const recentList: HTMLElement = qRecentList;
  const computersEmpty: HTMLElement = qComputersEmpty;
  const emptyConnect: HTMLButtonElement = qEmptyConnect;
  const probeInput: HTMLInputElement = qProbeInput;
  const probeLayer: HTMLElement = qProbeLayer;
  const testButton: HTMLButtonElement = qTestButton;
  const probeResult: HTMLElement = qProbeResult;
  const addresses: HTMLElement = qAddresses;
  const addressList: HTMLElement = qAddressList;

  const tabs = [...document.querySelectorAll<HTMLButtonElement>('.tab[data-tab]')];
  const views: Record<'connect' | 'computers' | 'network', HTMLElement> = {
    connect: viewConnect,
    computers: viewComputers,
    network: viewNetwork,
  };

  const lang: Locale = /^zh\b/i.test(navigator.language) ? 'zh' : 'en';
  const copy = COPY[lang];
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = node.dataset['i18n'] as CopyKey | undefined;
    if (key && copy[key]) node.textContent = copy[key];
  }

  const win = window as unknown as Window & LauncherGlobal;

  let activeStream: MediaStream | null = null;
  let scanLoopActive = false;
  let scanStarting = false;
  let scanGeneration = 0;
  let scannerHistoryEntry = false;
  let managingServerId: string | null = null;
  let unreachablePairedRecovery: RecoveryBinding | null = null;
  let autoReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let autoReconnectFlight = false;
  let autoReconnectEpoch = 0;
  let autoReconnectAttempt = 0;
  let openFlightEpoch = 0;
  let openFlightOpId: string | null = null;
  let openFlightAbortController: AbortController | null = null;
  let pendingManualFingerprint: { origin: string; fingerprint: string } | null = null;
  const addressStatus = new Map<string, { text: string; tone?: string }>();

  function isNativeShell(): boolean {
    return win.Capacitor?.isNativePlatform?.() === true;
  }

  function copyByReason(reason: string): string {
    return (copy as Record<string, string>)[reason] ?? copy.invalid;
  }

  function cancelInFlightOpen(): void {
    openFlightEpoch += 1;
    const activeOpId = openFlightOpId;
    openFlightOpId = null;
    if (openFlightAbortController !== null) {
      openFlightAbortController.abort();
      openFlightAbortController = null;
    }
    if (activeOpId !== null && isNativeShell()) {
      try {
        void win.Capacitor?.nativePromise('KikiShell', 'cancelOpen', { opId: activeOpId }).catch(() => {});
      } catch {
      }
    }
    if (button.disabled) {
      button.disabled = false;
      updateInputAffordances();
    }
  }

  function stopAutoReconnect(clearBinding = false): void {
    autoReconnectEpoch += 1;
    autoReconnectFlight = false;
    cancelInFlightOpen();
    if (autoReconnectTimer !== null) {
      clearTimeout(autoReconnectTimer);
      autoReconnectTimer = null;
    }
    if (clearBinding) {
      unreachablePairedRecovery = null;
      autoReconnectAttempt = 0;
    }
  }

  function scheduleAutoReconnect(delayMs?: number): void {
    if (!unreachablePairedRecovery || views.connect.hidden || problem.hidden) return;
    if (autoReconnectTimer !== null) {
      clearTimeout(autoReconnectTimer);
      autoReconnectTimer = null;
    }
    const wait =
      typeof delayMs === 'number'
        ? delayMs
        : Math.min(1000 * 2 ** Math.min(autoReconnectAttempt, 3), 8000);
    const expectedEpoch = autoReconnectEpoch;
    const bound = unreachablePairedRecovery;
    autoReconnectTimer = setTimeout(() => {
      autoReconnectTimer = null;
      void runAutoReconnectAttempt(bound, expectedEpoch);
    }, wait);
  }

  async function runAutoReconnectAttempt(
    bound: RecoveryBinding,
    expectedEpoch: number,
  ): Promise<void> {
    if (
      !bound ||
      expectedEpoch !== autoReconnectEpoch ||
      unreachablePairedRecovery !== bound ||
      autoReconnectFlight ||
      views.connect.hidden ||
      problem.hidden ||
      button.disabled
    ) {
      return;
    }
    const latest = findExactSavedServerForOrigin(bound.origin, bound.serverId);
    if (!latest || (!latest.paired && !latest.targetHomeId)) {
      stopAutoReconnect(true);
      updateInputAffordances();
      return;
    }
    const activeGrantId = latest.grantId ?? bound.grantId;
    const currentRecovery: RecoveryBinding = {
      ...bound,
      serverId: latest.id,
      label: latest.label,
      targetHomeId: latest.targetHomeId ?? bound.targetHomeId,
      targetHostId: latest.targetHostId ?? bound.targetHostId,
      grantId: activeGrantId,
      server: latest,
    };
    unreachablePairedRecovery = currentRecovery;
    autoReconnectFlight = true;
    autoReconnectAttempt += 1;
    try {
      await openServer(bound.origin, `${bound.origin}/`, {
        serverId: latest.id,
        label: latest.label,
        paired: true,
        targetHomeId: latest.targetHomeId ?? bound.targetHomeId,
        targetHostId: latest.targetHostId ?? bound.targetHostId,
        grantId: activeGrantId,
        fromAutoRecovery: true,
        expectedAutoEpoch: expectedEpoch,
        expectedRecovery: currentRecovery,
      });
    } finally {
      if (expectedEpoch === autoReconnectEpoch) {
        autoReconnectFlight = false;
      }
    }
  }

  function wakeAutoReconnect(): void {
    if (!unreachablePairedRecovery || views.connect.hidden || problem.hidden) return;
    autoReconnectAttempt = 0;
    if (autoReconnectFlight || button.disabled) return;
    scheduleAutoReconnect(0);
  }

  function hostOf(origin: string): string {
    return displayOrigin(origin).replace(' · http', '');
  }

  function setTab(
    name: 'connect' | 'computers' | 'network',
    options: { animate?: boolean; scroll?: boolean } = {},
  ): void {
    if (!views[name]) return;
    if (name !== 'connect') {
      stopAutoReconnect(false);
      if (activeStream) stopCameraScanner();
    }
    for (const [key, view] of Object.entries(views)) {
      if (options.animate) view.dataset['animate'] = 'true';
      else delete view.dataset['animate'];
      view.hidden = key !== name;
    }
    for (const tab of tabs) {
      if (tab.dataset['tab'] === name) {
        tab.setAttribute('aria-current', 'page');
      } else {
        tab.removeAttribute('aria-current');
      }
    }
    if (name === 'network' && probeInput.value.trim() === '' && input.value.trim() !== '') {
      probeInput.value = input.value.trim();
      updateProbeLayer();
    }
    if (name === 'connect' && unreachablePairedRecovery && !problem.hidden) {
      scheduleAutoReconnect();
    }
    if (options.scroll !== false) window.scrollTo(0, 0);
  }

  function shortLayerLabelFor(originOrRaw: string): string {
    const info = classifyOrigin(originOrRaw);
    if (info.layer === 'invalid') return '';
    if (info.layer === 'vpn') return copy.layerVpn;
    if (info.layer === 'https') return copy.layerHttps;
    if (info.layer === 'http') return copy.layerHttp;
    return lang === 'zh' ? '局域网' : 'LAN';
  }

  function layerLabelFor(originOrRaw: string): string {
    const info = classifyOrigin(originOrRaw);
    if (info.layer === 'invalid') return '';
    if (info.layer === 'vpn') return copy.layerVpn;
    if (info.layer === 'https') return copy.layerHttps;
    if (info.layer === 'http') return copy.layerHttp;
    return copy.layerLan;
  }

  function unreachableMessageFor(originOrRaw: string): string {
    const info = classifyOrigin(originOrRaw);
    const host = info.host || hostOf(originOrRaw);
    if (info.layer === 'vpn') return copy.unreachableVpn.replace('{host}', host);
    if (info.layer === 'https' || info.layer === 'http') return copy.unreachableHttps.replace('{host}', host);
    return copy.unreachableLan.replace('{host}', host);
  }

  function identityMismatchMessageFor(originOrRaw: string, label?: string): string {
    return copy.identityMismatch
      .replace('{host}', hostOf(originOrRaw))
      .replace('{label}', label || (lang === 'zh' ? '已保存电脑' : 'saved computer'));
  }

  function pairingRequiredMessageFor(originOrRaw: string, label?: string): string {
    return copy.pairingRequired
      .replace('{host}', hostOf(originOrRaw))
      .replace('{label}', label || (lang === 'zh' ? '已保存电脑' : 'saved computer'));
  }

  function pairingRevokedMessageFor(originOrRaw: string, label?: string): string {
    const host = hostOf(originOrRaw);
    return copy.pairingRevoked
      .replace('{host}', host)
      .replace('{label}', label || host);
  }

  function unverifiedHandshakeProofMessageFor(originOrRaw: string, label?: string): string {
    const host = hostOf(originOrRaw);
    return copy.unverifiedHandshakeProof
      .replace('{host}', host)
      .replace('{label}', label || host);
  }

  function probeOkMessageFor(origin: string): string {
    return copy.probeOk.replace('{host}', hostOf(origin)).replace('{layer}', layerLabelFor(origin));
  }

  function syncHintVisibility(): void {
    if (!hint) return;
    hint.hidden = !problem.hidden || !scanFeedback.hidden;
  }

  function setManualExpanded(expanded: boolean): void {
    const isOpen = Boolean(expanded);
    form.hidden = !isOpen;
    if (manualToggle) {
      manualToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      manualToggle.textContent = isOpen ? copy.manualCollapse : copy.manualToggle;
    }
    if (isOpen || !scannerPanel.hidden || !scanFeedback.hidden) {
      views.connect.dataset['manualOpen'] = 'true';
    } else {
      delete views.connect.dataset['manualOpen'];
    }
    syncHintVisibility();
  }

  function showProblem(text: string): void {
    problem.textContent = text;
    problem.hidden = text === '';
    input.ariaInvalid = text === '' ? 'false' : 'true';
    syncHintVisibility();
    if (text !== '') {
      setManualExpanded(true);
      setTab('connect', { scroll: false });
    }
  }

  function showProbeResult(text: string, tone?: string): void {
    probeResult.textContent = text;
    probeResult.dataset['tone'] = tone ?? '';
    probeResult.hidden = text === '';
  }

  function showScanFeedback(text: string, options: { offerPhotoPicker?: boolean } = {}): void {
    scanFeedback.textContent = text;
    scanFeedback.hidden = text === '';
    if (pickQrPhotoFallbackButton) {
      pickQrPhotoFallbackButton.hidden = !(options.offerPhotoPicker === true && text !== '');
    }
    syncHintVisibility();
    setManualExpanded(!form.hidden);
  }

  function readAnyTarget(raw: string) {
    return /^kiki:\/\//i.test(raw) ? readScanPayload(raw) : readTarget(raw);
  }

  function updateInputAffordances(): void {
    const raw = input.value.trim();
    const hasCode = codeInput.value.trim() !== '' || /^kiki:\/\/pair/i.test(raw);
    const isUnreachablePaired = unreachablePairedRecovery !== null && !hasCode;
    button.textContent = hasCode
      ? copy.pairAndOpen
      : isUnreachablePaired
        ? copy.reconnect
        : copy.open;
    if (codeField) {
      codeField.hidden = isUnreachablePaired;
    }
    if (switchComputerBtn) {
      switchComputerBtn.hidden = !isUnreachablePaired;
    }
    const target = raw === '' ? null : readAnyTarget(raw);
    layerBadge.textContent = target?.ok ? layerLabelFor(target.origin) : '';
    layerBadge.hidden = !target?.ok;
  }

  function updateProbeLayer(): void {
    const raw = probeInput.value.trim();
    const target = raw === '' ? null : readTarget(raw);
    probeLayer.textContent = target?.ok ? layerLabelFor(target.origin) : '';
    probeLayer.hidden = !target?.ok;
  }

  async function probeServer(
    origin: string,
    probeOptions: ProbeHandshakeOptions = {},
  ): Promise<HandshakeProbeResult> {
    const signal = probeOptions?.signal;
    const isSignalAborted = (): boolean => signal?.aborted === true;
    if (isSignalAborted()) {
      return { ok: false, aborted: true, reason: 'aborted' };
    }
    if (isNativeShell()) {
      try {
        const res = await win.Capacitor!.nativePromise('KikiShell', 'probe', {
          origin,
          serverId: probeOptions?.serverId ?? undefined,
          grantId: probeOptions?.grantId ?? undefined,
          fingerprint: probeOptions?.fingerprint ?? undefined,
          expectedStatus: probeOptions?.expectedStatus ?? undefined,
        });
        if (isSignalAborted()) {
          return { ok: false, aborted: true, reason: 'aborted' };
        }
        const rawStatus = res?.['handshakeStatus'];
        const handshakeStatus: HandshakeStatus | undefined =
          rawStatus === 'approved' ||
          rawStatus === 'revoked' ||
          rawStatus === 'inbound_disabled' ||
          rawStatus === 'invited'
            ? rawStatus
            : undefined;
        return {
          ok: Boolean(res?.['ok']),
          status: typeof res?.['status'] === 'number' ? res['status'] : undefined,
          reason:
            typeof res?.['reason'] === 'string' && res['reason'] !== '' ? res['reason'] : undefined,
          authRejected: res?.['authRejected'] === true,
          targetLabel:
            typeof res?.['targetLabel'] === 'string' && res['targetLabel'] !== ''
              ? res['targetLabel']
              : undefined,
          targetHomeId:
            typeof res?.['targetHomeId'] === 'string' && res['targetHomeId'] !== ''
              ? res['targetHomeId']
              : undefined,
          targetHostId:
            typeof res?.['targetHostId'] === 'string' && res['targetHostId'] !== ''
              ? res['targetHostId']
              : undefined,
          handshakeStatus,
          mutualProofVerified: Boolean(res?.['mutualProofVerified']),
          mutualRevokedVerified: Boolean(res?.['mutualRevokedVerified']),
          mutualDisabledVerified: Boolean(res?.['mutualDisabledVerified']),
          mutualInvitedVerified: Boolean(res?.['mutualInvitedVerified']),
          inboundEnabled:
            typeof res?.['inboundEnabled'] === 'boolean' ? res['inboundEnabled'] : undefined,
        };
      } catch {
        if (isSignalAborted()) {
          return { ok: false, aborted: true, reason: 'aborted' };
        }
        return { ok: false };
      }
    }
    return probeOriginHandshake(origin, probeOptions);
  }

  async function claimPairing(endpoint: string, code: string, fingerprint?: string) {
    const platform = /iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'ios' : 'android';
    const nativeIdentity = readDeviceIdentity(window.localStorage, platform);
    if (isNativeShell()) {
      return claimPairingOrigin(window.localStorage, {
        endpoint,
        code,
        fingerprint,
        platform,
        identity: nativeIdentity,
        nativeClaim: async (params): Promise<NativeClaimResponse> => {
          try {
            const payload: Record<string, unknown> = {
              endpoint: params.endpoint,
              code: params.code,
              homeId: params.homeId,
              hostId: params.hostId,
              sourceLabel: params.sourceLabel,
            };
            if (params.fingerprint) {
              payload['fingerprint'] = params.fingerprint;
            }
            const res = await win.Capacitor!.nativePromise('KikiShell', 'claimPair', payload);
            if (res && typeof res['ok'] === 'boolean') return res as unknown as NativeClaimResponse;
          } catch {
          }
          return { ok: false, reason: 'unreachable' };
        },
      });
    }
    return claimPairingOrigin(window.localStorage, {
      endpoint,
      code,
      fingerprint,
      platform,
      identity: nativeIdentity,
      saveToken: saveWebPeerToken,
    });
  }

  function promptForPairing(origin: string, message: string): void {
    stopAutoReconnect(true);
    setTab('connect');
    input.value = editableOrigin(origin);
    updateInputAffordances();
    showProblem(message);
    codeInput.focus();
  }

  function reportUnreachable(
    origin: string,
    context: {
      serverId?: string;
      label?: string;
      targetHomeId?: string;
      targetHostId?: string;
      grantId?: string;
      reason?: string;
    } = {},
  ): void {
    const exactSaved = findExactSavedServerForOrigin(origin, context.serverId);
    const isVerifiedPaired = Boolean(
      exactSaved &&
        (exactSaved.paired || exactSaved.targetHomeId) &&
        isServerOriginVerified(exactSaved, origin),
    );
    if (isVerifiedPaired && exactSaved) {
      const sameBinding =
        unreachablePairedRecovery &&
        unreachablePairedRecovery.origin === origin &&
        unreachablePairedRecovery.serverId === exactSaved.id;
      unreachablePairedRecovery = {
        origin,
        serverId: exactSaved.id,
        label: exactSaved.label ?? context.label,
        targetHomeId: exactSaved.targetHomeId ?? context.targetHomeId,
        targetHostId: exactSaved.targetHostId ?? context.targetHostId,
        grantId: exactSaved.grantId ?? context.grantId,
        server: exactSaved,
      };
      if (!sameBinding) {
        autoReconnectAttempt = 0;
      }
    } else {
      stopAutoReconnect(true);
    }
    setTab('connect');
    if (input.value.trim() === '' || isVerifiedPaired) {
      input.value = editableOrigin(origin);
    }
    updateInputAffordances();
    const message =
      context.reason === 'unverified_handshake_proof'
        ? unverifiedHandshakeProofMessageFor(origin, exactSaved?.label ?? context.label)
        : unreachableMessageFor(origin);
    showProblem(message);
    if (isVerifiedPaired) {
      scheduleAutoReconnect();
    }
  }

  async function openServer(
    origin: string,
    entry: string,
    options: OpenServerOptions = {},
  ): Promise<void> {
    const isPairedTarget = Boolean(options.paired || options.targetHomeId);
    const targetServerId = options.serverId ?? options.targetHomeId;

    if (!options.fromAutoRecovery) {
      const matchesCurrentRecovery =
        unreachablePairedRecovery &&
        unreachablePairedRecovery.origin === origin &&
        (!targetServerId || unreachablePairedRecovery.serverId === targetServerId);
      stopAutoReconnect(!matchesCurrentRecovery);
    } else {
      cancelInFlightOpen();
    }

    openFlightEpoch += 1;
    const callOpenEpoch = openFlightEpoch;
    const callOpId = `open-${callOpenEpoch}-${Date.now()}`;
    openFlightOpId = callOpId;
    const abortController = new AbortController();
    openFlightAbortController = abortController;
    const isStaleOpen = (): boolean => {
      if (
        callOpenEpoch !== openFlightEpoch ||
        openFlightOpId !== callOpId ||
        abortController.signal.aborted
      ) {
        return true;
      }
      if (options.fromAutoRecovery) {
        if (
          (typeof options.expectedAutoEpoch === 'number' &&
            options.expectedAutoEpoch !== autoReconnectEpoch) ||
          !unreachablePairedRecovery ||
          unreachablePairedRecovery.origin !== origin ||
          (targetServerId && unreachablePairedRecovery.serverId !== targetServerId) ||
          (options.expectedRecovery && unreachablePairedRecovery !== options.expectedRecovery) ||
          views.connect.hidden
        ) {
          return true;
        }
      }
      return false;
    };

    button.disabled = true;
    button.textContent = copy.opening;

    const resolved = await resolveVerifiedServerOpen(window.localStorage, {
      ...options,
      origin,
      entry,
      probe: probeServer,
      signal: abortController.signal,
      isStale: isStaleOpen,
      requireMutualProof: isPairedTarget && isNativeShell(),
      getToken: isNativeShell() ? undefined : readWebPeerToken,
    });

    if (isStaleOpen()) {
      return;
    }

    if (!resolved.ok) {
      if (resolved.stale || resolved.reason === 'aborted') {
        return;
      }
      const failedOrigin = resolved.server?.origin ?? origin;
      button.disabled = false;
      renderSavedServers();
      if (resolved.reason === 'identity_mismatch') {
        promptForPairing(
          failedOrigin,
          identityMismatchMessageFor(failedOrigin, resolved.server?.label ?? options.label),
        );
      } else if (resolved.reason === 'pairing_revoked') {
        promptForPairing(
          failedOrigin,
          pairingRevokedMessageFor(failedOrigin, resolved.server?.label ?? options.label),
        );
      } else if (resolved.reason === 'pairing_required') {
        promptForPairing(
          failedOrigin,
          pairingRequiredMessageFor(failedOrigin, resolved.server?.label ?? options.label),
        );
      } else {
        input.value = editableOrigin(failedOrigin);
        reportUnreachable(failedOrigin, {
          serverId: resolved.server?.id ?? targetServerId,
          label: resolved.server?.label ?? options.label,
          targetHomeId: resolved.server?.targetHomeId ?? options.targetHomeId,
          targetHostId: resolved.server?.targetHostId ?? options.targetHostId,
          grantId: resolved.server?.grantId ?? options.grantId,
          reason: resolved.reason,
        });
      }
      return;
    }

    const targetOrigin = resolved.origin;
    const serverId = resolved.serverId;

    if (isStaleOpen()) {
      return;
    }

    try {
      window.name = '';
    } catch {
    }

    if (isNativeShell()) {
      try {
        const openPayload: Record<string, unknown> = {
          opId: callOpId,
          origin: targetOrigin,
          entry: resolved.finalEntry,
          serverId: isPairedTarget ? (serverId ?? undefined) : undefined,
          grantId: isPairedTarget
            ? (resolved.server?.grantId ?? options.grantId ?? undefined)
            : undefined,
          targetHomeId: options.targetHomeId ?? undefined,
          targetHostId: options.targetHostId ?? undefined,
        };
        const resolvedFp =
          options.fingerprint ??
          getServerFingerprint(resolved.server, targetOrigin) ??
          getServerFingerprint(resolved.server, origin);
        if (resolvedFp) {
          openPayload['fingerprint'] = resolvedFp;
        }
        const res = await win.Capacitor!.nativePromise('KikiShell', 'open', openPayload);
        if (isStaleOpen() || res?.['reason'] === 'aborted') {
          return;
        }
        if (!res || res['ok'] === false) {
          if (openFlightOpId === callOpId) openFlightOpId = null;
          button.disabled = false;
          renderSavedServers();
          if (res?.['reason'] === 'identity_mismatch' && targetServerId) {
            const rollback = verifySavedServerOrigin(window.localStorage, targetServerId, targetOrigin, {
              ok: true,
              targetHomeId:
                typeof res['targetHomeId'] === 'string' ? res['targetHomeId'] : undefined,
            });
            renderSavedServers();
            promptForPairing(
              targetOrigin,
              identityMismatchMessageFor(targetOrigin, rollback.server?.label ?? options.label),
            );
          } else if (res?.['reason'] === 'pairing_revoked') {
            promptForPairing(
              targetOrigin,
              pairingRevokedMessageFor(targetOrigin, resolved.server?.label ?? options.label),
            );
          } else if (res?.['reason'] === 'pairing_required') {
            promptForPairing(
              targetOrigin,
              pairingRequiredMessageFor(targetOrigin, resolved.server?.label ?? options.label),
            );
          } else {
            reportUnreachable(targetOrigin, {
              serverId: resolved.server?.id ?? serverId ?? targetServerId,
              label: resolved.server?.label ?? options.label,
              targetHomeId: resolved.server?.targetHomeId ?? options.targetHomeId,
              targetHostId: resolved.server?.targetHostId ?? options.targetHostId,
              grantId: resolved.server?.grantId ?? options.grantId,
              reason: typeof res?.['reason'] === 'string' ? res['reason'] : undefined,
            });
          }
          return;
        }
        if (openFlightOpId === callOpId) openFlightOpId = null;
        stopAutoReconnect(true);
        return;
      } catch {
        if (isStaleOpen()) {
          return;
        }
        if (openFlightOpId === callOpId) openFlightOpId = null;
        button.disabled = false;
        renderSavedServers();
        reportUnreachable(targetOrigin, {
          serverId: resolved.server?.id ?? serverId ?? targetServerId,
          label: resolved.server?.label ?? options.label,
          targetHomeId: resolved.server?.targetHomeId ?? options.targetHomeId,
          targetHostId: resolved.server?.targetHostId ?? options.targetHostId,
          grantId: resolved.server?.grantId ?? options.grantId,
        });
        return;
      }
    }

    if (isPairedTarget || resolved.sessionToken) {
      button.disabled = false;
      renderSavedServers();
      reportUnreachable(targetOrigin, {
        serverId: resolved.server?.id ?? serverId ?? targetServerId,
        label: resolved.server?.label ?? options.label,
        targetHomeId: resolved.server?.targetHomeId ?? options.targetHomeId,
        targetHostId: resolved.server?.targetHostId ?? options.targetHostId,
        grantId: resolved.server?.grantId ?? options.grantId,
      });
      return;
    }

    if (isStaleOpen()) {
      return;
    }
    stopAutoReconnect(true);
    window.location.assign(stripTokenFromEntry(targetOrigin, resolved.finalEntry));
  }

  function openSavedServer(server: SavedServer): Promise<void> {
    return openServer(server.origin, `${server.origin}/`, {
      serverId: server.id,
      label: server.label,
      paired: server.paired,
      targetHomeId: server.targetHomeId,
      targetHostId: server.targetHostId,
      grantId: server.grantId,
      fingerprint: getServerFingerprint(server, server.origin),
    });
  }

  async function submitConnect(parsed: ParsedConnectSubmission): Promise<void> {
    showProblem('');

    if (parsed.kind === 'pair') {
      button.disabled = true;
      button.textContent = copy.pairing;
      const claim = await claimPairing(
        parsed.endpoint ?? parsed.origin,
        parsed.code,
        parsed.fingerprint,
      );
      if (!claim.ok) {
        button.disabled = false;
        updateInputAffordances();
        showProblem(
          claim.reason === 'rejected' ? copy.pairRejected : unreachableMessageFor(parsed.origin),
        );
        return;
      }
      pendingManualFingerprint = null;
      codeInput.value = '';
      await openServer(claim.origin, `${claim.origin}/`, {
        serverId: claim.serverId,
        label: claim.targetLabel,
        paired: true,
        targetHomeId: claim.targetHomeId,
        targetHostId: claim.targetHostId,
        grantId: claim.grantId,
        fingerprint: claim.fingerprint ?? parsed.fingerprint,
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
      fingerprint: getServerFingerprint(existing, parsed.origin),
    });
  }

  function stopCameraScanner(options: { fromHistory?: boolean } = {}): void {
    scanGeneration += 1;
    scanStarting = false;
    scanLoopActive = false;
    if (activeStream) {
      for (const track of activeStream.getTracks()) track.stop();
      activeStream = null;
    }
    scannerVideo.srcObject = null;
    scannerPanel.hidden = true;
    scanButton.disabled = false;
    const labelNode = scanButton.querySelector('[data-i18n="scanQr"]');
    if (labelNode) labelNode.textContent = copy.scanQr;
    setManualExpanded(!form.hidden);
    if (scannerHistoryEntry) {
      scannerHistoryEntry = false;
      if (!options.fromHistory) history.back();
    }
  }

  async function handleScannedPayload(rawValue: string): Promise<void> {
    stopCameraScanner();
    setTab('connect', { scroll: false });
    const parsed = readScanPayload(rawValue);
    if (!parsed.ok) {
      showScanFeedback(copy.invalid_qr);
      focusManualConnectInput();
      return;
    }
    showScanFeedback('');
    input.value = editableOrigin(parsed.origin);
    pendingManualFingerprint =
      parsed.kind === 'pair' && parsed.fingerprint
        ? { origin: parsed.origin, fingerprint: parsed.fingerprint }
        : null;
    if (parsed.kind === 'pair') {
      codeInput.value = parsed.code;
    }
    setManualExpanded(true);
    updateInputAffordances();
    await submitConnect(parsed);
  }

  async function readClipboardText(): Promise<{ ok: boolean; text: string }> {
    if (typeof win.__kikiTestReadClipboard === 'function') {
      const val = await win.__kikiTestReadClipboard();
      return { ok: true, text: typeof val === 'string' ? val : '' };
    }
    if (isNativeShell()) {
      try {
        const res = await win.Capacitor!.nativePromise('KikiShell', 'readClipboard', {});
        if (res && typeof res['text'] === 'string') {
          return { ok: true, text: res['text'] };
        }
      } catch {
      }
    }
    if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
      try {
        const text = await navigator.clipboard.readText();
        return { ok: true, text: typeof text === 'string' ? text : '' };
      } catch {
        return { ok: false, text: '' };
      }
    }
    return { ok: false, text: '' };
  }

  async function startPasteLink(): Promise<void> {
    showProblem('');
    showScanFeedback('');
    const clip = await readClipboardText();
    if (!clip.ok) {
      showScanFeedback(copy.pasteDenied);
      focusManualConnectInput();
      return;
    }
    const parsed = readPastePayload(clip.text);
    if (!parsed.ok) {
      showScanFeedback(copy.pasteEmpty);
      focusManualConnectInput();
      return;
    }
    if (parsed.kind === 'pair') {
      input.value = editableOrigin(parsed.origin);
      codeInput.value = parsed.code;
      pendingManualFingerprint = parsed.fingerprint
        ? { origin: parsed.origin, fingerprint: parsed.fingerprint }
        : null;
      setManualExpanded(true);
      updateInputAffordances();
      await submitConnect(parsed);
      return;
    }
    input.value = editableOrigin(parsed.origin);
    pendingManualFingerprint = null;
    setManualExpanded(true);
    updateInputAffordances();
    const hasEntryToken = parsed.entry !== `${parsed.origin}/`;
    const existing = readSavedServers(window.localStorage).find((s) =>
      isServerOriginVerified(s, parsed.origin),
    );
    if (hasEntryToken || existing) {
      await submitConnect(parsed);
    } else {
      codeInput.focus();
    }
  }

  function focusManualConnectInput(): void {
    setManualExpanded(true);
    if (input.value.trim() !== '') {
      codeInput.focus();
    } else {
      input.focus();
    }
  }

  function createOptionalBarcodeDetector(): NativeBarcodeDetector | null {
    if (typeof win.BarcodeDetector !== 'function') return null;
    try {
      return new win.BarcodeDetector({ formats: ['qr_code'] });
    } catch {
      try {
        return new win.BarcodeDetector();
      } catch {
        return null;
      }
    }
  }

  async function handlePickedQrPhoto(file: File | null | undefined): Promise<void> {
    if (!file) return;
    showProblem('');
    const detector = createOptionalBarcodeDetector();
    const decoded = await decodeQrFromImageFile(file, detector);
    if (!decoded) {
      showScanFeedback(copy.photoNoQr, { offerPhotoPicker: true });
      focusManualConnectInput();
      return;
    }
    await handleScannedPayload(decoded);
  }

  function triggerQrPhotoPicker(): void {
    if (!qrPhotoInput) return;
    qrPhotoInput.value = '';
    qrPhotoInput.click();
  }

  async function startWebCameraLoop(): Promise<void> {
    if (scanStarting || activeStream !== null) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      showScanFeedback(copy.cameraUnavailable, { offerPhotoPicker: true });
      focusManualConnectInput();
      return;
    }
    scanStarting = true;
    const generation = ++scanGeneration;
    scanButton.disabled = true;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
    } catch (error: unknown) {
      scanStarting = false;
      scanButton.disabled = false;
      const errName = error && typeof error === 'object' ? (error as { name?: string }).name : '';
      const denied = errName === 'NotAllowedError' || errName === 'PermissionDeniedError';
      showScanFeedback(denied ? copy.cameraDenied : copy.cameraUnavailable, {
        offerPhotoPicker: true,
      });
      focusManualConnectInput();
      return;
    }
    scanStarting = false;
    if (generation !== scanGeneration || activeStream !== null) {
      for (const track of stream.getTracks()) track.stop();
      if (activeStream === null) scanButton.disabled = false;
      return;
    }

    activeStream = stream;
    scannerVideo.srcObject = stream;
    scannerPanel.hidden = false;
    setManualExpanded(!form.hidden);
    scanButton.disabled = true;
    const labelNode = scanButton.querySelector('[data-i18n="scanQr"]');
    if (labelNode) labelNode.textContent = copy.scanning;
    history.pushState({ kikiScanner: true }, '');
    scannerHistoryEntry = true;
    scannerPanel.scrollIntoView({ block: 'nearest' });
    try {
      await scannerVideo.play();
    } catch {
    }

    const detector = createOptionalBarcodeDetector();
    let lastFallbackDecodeAt = 0;

    scanLoopActive = true;
    const tick = async (): Promise<void> => {
      if (!scanLoopActive || !activeStream) return;
      try {
        const now = Date.now();
        if (scannerVideo.readyState >= 2 && (detector !== null || now - lastFallbackDecodeAt >= 140)) {
          lastFallbackDecodeAt = now;
          const decoded = await decodeQrFromVideo(scannerVideo, detector);
          if (decoded) {
            await handleScannedPayload(decoded);
            return;
          }
        }
      } catch {
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

  async function startQrScan(): Promise<void> {
    showProblem('');
    showScanFeedback('');

    if (typeof win.__kikiTestScanQr === 'function') {
      const res = await win.__kikiTestScanQr();
      if (res?.status === 'scanned' && typeof res.value === 'string') {
        await handleScannedPayload(res.value);
      } else if (res?.status === 'denied') {
        showScanFeedback(copy.cameraDenied, { offerPhotoPicker: true });
        focusManualConnectInput();
      } else if (res?.status === 'cancelled') {
        focusManualConnectInput();
      }
      return;
    }

    if (isNativeShell()) {
      try {
        const result = await win.Capacitor!.nativePromise('KikiShell', 'scanQr', {});
        if (result?.['status'] === 'scanned' && typeof result['value'] === 'string') {
          await handleScannedPayload(result['value']);
          return;
        }
        if (result?.['status'] === 'denied') {
          showScanFeedback(copy.cameraDenied, { offerPhotoPicker: true });
          focusManualConnectInput();
          return;
        }
        if (result?.['status'] === 'cancelled') {
          stopCameraScanner();
          focusManualConnectInput();
          return;
        }
      } catch {
      }
    }

    await startWebCameraLoop();
  }

  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svgIcon(pathData: string): SVGSVGElement {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', pathData);
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
    return svg;
  }

  function moreDotsIcon(): SVGSVGElement {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    for (const cx of ['5', '10', '15']) {
      const circle = document.createElementNS(ns, 'circle');
      circle.setAttribute('cx', cx);
      circle.setAttribute('cy', '10');
      circle.setAttribute('r', '1.5');
      circle.setAttribute('fill', 'currentColor');
      svg.append(circle);
    }
    return svg;
  }

  function forgetServer(server: SavedServer): void {
    if (
      unreachablePairedRecovery &&
      (unreachablePairedRecovery.serverId === server.id ||
        unreachablePairedRecovery.origin === server.origin ||
        server.origins?.includes(unreachablePairedRecovery.origin))
    ) {
      stopAutoReconnect(true);
      updateInputAffordances();
    }
    const allOrigins = [
      ...new Set([server.origin, ...(server.origins ?? []), ...(server.verifiedOrigins ?? [])]),
    ];
    removeSavedServer(window.localStorage, server.id);
    if (managingServerId === server.id) managingServerId = null;
    addressStatus.delete(server.id);
    renderSavedServers();
    if (isNativeShell()) {
      try {
        void win.Capacitor?.nativePromise('KikiShell', 'forgetServer', {
          serverId: server.id,
          origin: server.origin,
        });
      } catch {
      }
    }
    void deleteWebPeerToken(server.id, allOrigins);
    if (server.targetHomeId) void deleteWebPeerToken(server.targetHomeId, allOrigins);
  }

  function renderComputerRow(server: SavedServer, index: number): HTMLDivElement {
    const card = el('div', 'saved-card');
    card.dataset['serverId'] = server.id;

    const mainRow = el('div', 'saved-main');
    const openBtn = el('button', 'recent-row');
    openBtn.type = 'button';
    if (index === 0) openBtn.id = 'recent-open';

    const summary = el('div', 'saved-summary');
    const titleRow = el('div', 'saved-title-row');
    titleRow.append(el('span', 'saved-label', server.label));
    if (server.paired) titleRow.append(el('span', 'saved-badge', copy.pairedBadge));

    const metaRow = el('div', 'saved-meta');
    const hostSpan = el('span', 'recent-host', hostOf(server.origin));
    if (index === 0) hostSpan.id = 'recent-host';
    metaRow.append(hostSpan, el('span', 'saved-layer', `· ${shortLayerLabelFor(server.origin)}`));
    summary.append(titleRow, metaRow);

    const arrow = el('span', 'recent-go');
    arrow.setAttribute('aria-hidden', 'true');
    arrow.append(svgIcon('M7.5 4.5 13 10l-5.5 5.5'));
    openBtn.append(summary, arrow);
    openBtn.addEventListener('click', () => {
      void (async () => {
        openBtn.disabled = true;
        openBtn.setAttribute('aria-busy', 'true');
        try {
          await openSavedServer(server);
        } finally {
          openBtn.disabled = false;
          openBtn.removeAttribute('aria-busy');
        }
      })();
    });

    const isManaging = managingServerId === server.id;
    const manageToggle = el('button', 'saved-edit-toggle');
    manageToggle.type = 'button';
    manageToggle.setAttribute(
      'aria-label',
      `${isManaging ? copy.manageDone : copy.manage} · ${server.label}`,
    );
    manageToggle.setAttribute('aria-expanded', isManaging ? 'true' : 'false');
    manageToggle.append(moreDotsIcon());
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
        addressList
          .querySelector(`[data-server-id="${CSS.escape(server.id)}"]`)
          ?.scrollIntoView({ block: 'start' });
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

  function setAddressStatus(serverId: string, text: string, tone?: string): void {
    if (text === '') {
      addressStatus.delete(serverId);
    } else {
      addressStatus.set(serverId, { text, tone });
    }
    const line = addressList.querySelector<HTMLElement>(
      `[data-server-id="${CSS.escape(serverId)}"] .addr-status`,
    );
    if (!line) return;
    line.textContent = text;
    line.dataset['tone'] = tone ?? '';
    line.hidden = text === '';
  }

  async function testServerAddress(
    server: SavedServer,
    rawAddress: string,
    trigger: HTMLButtonElement,
  ): Promise<void> {
    const parsed = readTarget(rawAddress);
    if (!parsed.ok) {
      setAddressStatus(server.id, copyByReason(parsed.reason), 'danger');
      return;
    }
    trigger.disabled = true;
    const original = trigger.textContent;
    trigger.textContent = copy.testing;
    setAddressStatus(server.id, '');
    const probe = await probeServer(
      parsed.origin,
      isServerOriginVerified(server, parsed.origin)
        ? {
            serverId: server.id,
            targetHomeId: server.targetHomeId,
            targetHostId: server.targetHostId,
            grantId: server.grantId,
            fingerprint: getServerFingerprint(server, parsed.origin),
          }
        : {
            fingerprint: getServerFingerprint(server, parsed.origin),
          },
    );
    trigger.disabled = false;
    trigger.textContent = original;
    if (
      server.paired &&
      server.targetHomeId &&
      probe.targetHomeId &&
      probe.targetHomeId !== server.targetHomeId
    ) {
      setAddressStatus(server.id, identityMismatchMessageFor(parsed.origin, server.label), 'danger');
      return;
    }
    if (
      probe.reason === 'pairing_revoked' ||
      probe.authRejected === true ||
      probe.mutualRevokedVerified === true
    ) {
      setAddressStatus(server.id, pairingRevokedMessageFor(parsed.origin, server.label), 'danger');
      return;
    }
    if (
      probe.reason === 'pairing_required' ||
      probe.mutualInvitedVerified === true ||
      probe.handshakeStatus === 'invited'
    ) {
      setAddressStatus(server.id, pairingRequiredMessageFor(parsed.origin, server.label), 'danger');
      return;
    }
    if (
      probe.reason === 'unverified_handshake_proof' ||
      (isNativeShell() && isServerOriginVerified(server, parsed.origin) && probe.ok && !probe.mutualProofVerified)
    ) {
      setAddressStatus(
        server.id,
        unverifiedHandshakeProofMessageFor(parsed.origin, server.label),
        'danger',
      );
      return;
    }
    if (!probe.ok) {
      setAddressStatus(server.id, unreachableMessageFor(parsed.origin), 'danger');
      return;
    }
    setAddressStatus(server.id, probeOkMessageFor(parsed.origin), 'ok');
  }

  async function saveServerAddress(
    server: SavedServer,
    rawAddress: string,
    trigger: HTMLButtonElement,
  ): Promise<void> {
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
      setAddressStatus(server.id, copyByReason(res.reason), 'danger');
      return;
    }
    const candidateOrigin = res.server.origin;
    addressStatus.set(server.id, {
      text: copy.addressSaved
        .replace('{host}', hostOf(candidateOrigin))
        .replace('{layer}', layerLabelFor(candidateOrigin)),
      tone: 'ok',
    });
    renderSavedServers();
  }

  function renderAddressGroup(server: SavedServer): HTMLDivElement {
    const group = el('div', 'addr-group');
    group.dataset['serverId'] = server.id;
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
    status.dataset['tone'] = saved?.tone ?? '';
    status.hidden = !saved;
    group.append(status);
    return group;
  }

  function renderSavedServers(): void {
    const servers = readSavedServers(window.localStorage);
    recentList.replaceChildren(...servers.map(renderComputerRow));
    recent.hidden = servers.length === 0;
    computersEmpty.hidden = servers.length > 0;
    addressList.replaceChildren(...servers.map(renderAddressGroup));
    addresses.hidden = servers.length === 0;
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      const name = tab.dataset['tab'];
      if (name === 'connect' || name === 'computers' || name === 'network') {
        setTab(name, { animate: true });
      }
    });
  }

  emptyConnect.addEventListener('click', () => {
    setTab('connect', { animate: true });
  });

  scanButton.addEventListener('click', () => {
    void startQrScan();
  });

  pasteButton?.addEventListener('click', () => {
    void startPasteLink();
  });

  manualToggle?.addEventListener('click', () => {
    const nextExpanded = Boolean(form.hidden);
    setManualExpanded(nextExpanded);
    if (nextExpanded) {
      focusManualConnectInput();
    }
  });

  scanCancel.addEventListener('click', () => {
    stopCameraScanner();
    focusManualConnectInput();
  });

  pickQrPhotoButton?.addEventListener('click', () => {
    triggerQrPhotoPicker();
  });

  pickQrPhotoFallbackButton?.addEventListener('click', () => {
    triggerQrPhotoPicker();
  });

  qrPhotoInput?.addEventListener('change', () => {
    const file = qrPhotoInput.files?.[0];
    qrPhotoInput.value = '';
    void handlePickedQrPhoto(file);
  });

  switchComputerBtn?.addEventListener('click', () => {
    stopAutoReconnect(true);
    showProblem('');
    updateInputAffordances();
    setTab('computers', { animate: true });
  });

  window.addEventListener('online', wakeAutoReconnect);
  window.addEventListener('focus', wakeAutoReconnect);
  window.addEventListener('pageshow', wakeAutoReconnect);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      wakeAutoReconnect();
    }
  });

  window.addEventListener('popstate', () => {
    if (scannerHistoryEntry) stopCameraScanner({ fromHistory: true });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && activeStream) {
      stopCameraScanner();
      focusManualConnectInput();
    }
  });

  input.addEventListener('input', () => {
    stopAutoReconnect(true);
    if (!problem.hidden) showProblem('');
    if (!scanFeedback.hidden) showScanFeedback('');
    const maybePair = readScanPayload(input.value);
    if (maybePair.ok && maybePair.kind === 'pair' && /^kiki:\/\/pair/i.test(input.value.trim())) {
      input.value = editableOrigin(maybePair.origin);
      codeInput.value = maybePair.code;
      pendingManualFingerprint = maybePair.fingerprint
        ? { origin: maybePair.origin, fingerprint: maybePair.fingerprint }
        : null;
    } else if (pendingManualFingerprint) {
      const currentTarget = readTarget(input.value);
      if (!currentTarget.ok || currentTarget.origin !== pendingManualFingerprint.origin) {
        pendingManualFingerprint = null;
      }
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
    if (codeInput.value.trim() !== '') {
      stopAutoReconnect(true);
    }
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

  async function runAddressTest(): Promise<void> {
    const target = readTarget(probeInput.value);
    if (!target.ok) {
      showProbeResult(copyByReason(target.reason), 'danger');
      probeInput.focus();
      return;
    }
    showProbeResult('');
    testButton.disabled = true;
    testButton.textContent = copy.testing;
    const exactSaved =
      readSavedServers(window.localStorage).find(
        (s) => s.origin === target.origin || s.origins?.includes(target.origin),
      ) ?? null;
    const probe = await probeServer(target.origin, {
      serverId: exactSaved?.id,
      grantId: exactSaved?.grantId,
      fingerprint: getServerFingerprint(exactSaved, target.origin),
    });
    testButton.disabled = false;
    testButton.textContent = copy.testAddress;
    if (probe.ok) {
      if (exactSaved?.paired && isNativeShell() && probe.mutualProofVerified === false) {
        showProbeResult(
          unverifiedHandshakeProofMessageFor(target.origin, exactSaved.label),
          'danger',
        );
      } else {
        showProbeResult(probeOkMessageFor(target.origin), 'ok');
      }
    } else if (probe.reason === 'pairing_revoked' || probe.authRejected === true) {
      showProbeResult(pairingRevokedMessageFor(target.origin, exactSaved?.label), 'danger');
    } else if (
      probe.reason === 'pairing_required' ||
      probe.mutualInvitedVerified === true ||
      probe.handshakeStatus === 'invited'
    ) {
      showProbeResult(pairingRequiredMessageFor(target.origin, exactSaved?.label), 'danger');
    } else if (probe.reason === 'unverified_handshake_proof') {
      showProbeResult(
        unverifiedHandshakeProofMessageFor(target.origin, exactSaved?.label),
        'danger',
      );
    } else {
      showProbeResult(unreachableMessageFor(target.origin), 'danger');
    }
  }

  testButton.addEventListener('click', () => {
    void runAddressTest();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (unreachablePairedRecovery && codeInput.value.trim() === '') {
      const parsedTarget = readTarget(input.value);
      if (parsedTarget.ok && parsedTarget.origin === unreachablePairedRecovery.origin) {
        const bound = unreachablePairedRecovery;
        void openServer(bound.origin, `${bound.origin}/`, {
          serverId: bound.serverId,
          label: bound.label,
          paired: true,
          targetHomeId: bound.targetHomeId,
          targetHostId: bound.targetHostId,
          grantId: bound.grantId,
        });
        return;
      }
    }
    const parsed = readConnectInput(input.value, codeInput.value);
    if (!parsed.ok) {
      showProblem(copyByReason(parsed.reason));
      if (parsed.reason === 'invalid_code') {
        codeInput.focus();
      } else {
        input.focus();
      }
      return;
    }
    const submission: ParsedConnectSubmission =
      parsed.kind === 'pair' &&
      !parsed.fingerprint &&
      pendingManualFingerprint &&
      pendingManualFingerprint.origin === parsed.origin
        ? { ...parsed, fingerprint: pendingManualFingerprint.fingerprint }
        : parsed;
    void submitConnect(submission);
  });

  let restingHeight = window.visualViewport?.height ?? window.innerHeight;

  function isTextEntry(node: Element | null): boolean {
    return node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement;
  }

  function updateKeyboardState(): void {
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

  function savedOrigin(): string | null {
    try {
      return window.localStorage.getItem(STORE_ORIGIN_KEY);
    } catch {
      return null;
    }
  }

  function findExactSavedServerForOrigin(
    origin: string,
    preferredServerId?: string,
  ): SavedServer | null {
    if (!origin) return null;
    const servers = readSavedServers(window.localStorage);
    if (preferredServerId) {
      const byId = servers.find(
        (s) =>
          (s.id === preferredServerId || s.targetHomeId === preferredServerId) &&
          (s.origin === origin || s.origins?.includes(origin) || isServerOriginVerified(s, origin)),
      );
      if (byId) return byId;
    }
    return (
      servers.find(
        (s) => s.origin === origin || s.origins?.includes(origin) || isServerOriginVerified(s, origin),
      ) ?? null
    );
  }

  function findSavedServerByOrigin(origin: string): SavedServer | null {
    if (!origin) return null;
    const servers = readSavedServers(window.localStorage);
    return findExactSavedServerForOrigin(origin) ?? servers[0] ?? null;
  }

  function showUnreachable(reason = 'unreachable'): void {
    const attempted = savedOrigin();
    button.disabled = false;
    updateInputAffordances();
    if (attempted === null) {
      setManualExpanded(true);
      setTab('connect');
      input.focus();
      return;
    }
    reportUnreachable(attempted, { reason });
  }

  function showPairingRecovery(kind: 'pairing_revoked' | 'identity_mismatch' | 'pairing_required'): void {
    const attempted = savedOrigin();
    button.disabled = false;
    updateInputAffordances();
    if (attempted === null) {
      setManualExpanded(true);
      setTab('connect');
      input.focus();
      return;
    }
    const saved = findSavedServerByOrigin(attempted);
    const message =
      kind === 'identity_mismatch'
        ? identityMismatchMessageFor(attempted, saved?.label)
        : kind === 'pairing_required'
          ? pairingRequiredMessageFor(attempted, saved?.label)
          : pairingRevokedMessageFor(attempted, saved?.label);
    promptForPairing(attempted, message);
  }

  async function consumePendingPairIfAny(): Promise<boolean> {
    if (isNativeShell()) {
      try {
        const pending = await win.Capacitor!.nativePromise('KikiShell', 'consumePendingPair', {});
        if (pending && typeof pending['uri'] === 'string' && pending['uri'] !== '') {
          await handleScannedPayload(pending['uri']);
          return true;
        }
      } catch {
      }
    }
    return false;
  }

  function landingTab(): 'connect' | 'computers' {
    return readSavedServers(window.localStorage).length > 0 ? 'computers' : 'connect';
  }

  window.addEventListener('kiki:pair-deeplink', () => {
    void consumePendingPairIfAny();
  });

  window.addEventListener('hashchange', () => {
    if (window.location.hash === '#unreachable') {
      showUnreachable('unreachable');
    } else if (window.location.hash === '#unverified_handshake_proof') {
      showUnreachable('unverified_handshake_proof');
    } else if (window.location.hash === '#pairing_revoked') {
      showPairingRecovery('pairing_revoked');
    } else if (window.location.hash === '#pairing_required') {
      showPairingRecovery('pairing_required');
    } else if (window.location.hash === '#identity_mismatch') {
      showPairingRecovery('identity_mismatch');
    } else if (window.location.hash === '#pair') {
      void consumePendingPairIfAny();
    } else if (window.location.hash === '#change') {
      setTab(landingTab());
    }
  });

  if (win.__kikiLauncher) {
    win.__kikiLauncher.openServer = openServer;
  }

  renderSavedServers();
  updateInputAffordances();
  setTab(landingTab());

  let firstVisit = false;
  try {
    firstVisit = sessionStorage.getItem(STARTED_KEY) === null;
    sessionStorage.setItem(STARTED_KEY, '1');
  } catch {
  }

  const reason = window.location.hash.replace(/^#/, '');
  const primaryServer = readSavedServers(window.localStorage)[0] ?? null;

  void (async () => {
    const handledPair = await consumePendingPairIfAny();
    if (!handledPair) {
      if (reason === 'unreachable' || reason === 'unverified_handshake_proof') {
        showUnreachable(reason);
      } else if (
        reason === 'pairing_revoked' ||
        reason === 'pairing_required' ||
        reason === 'identity_mismatch'
      ) {
        showPairingRecovery(reason);
      } else if (primaryServer !== null && firstVisit && reason === '') {
        await openSavedServer(primaryServer);
      }
    }
  })();
}

bootstrapLauncherUi();
