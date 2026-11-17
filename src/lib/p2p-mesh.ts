// p2p-mesh.ts: Universal Zero-Config Hybrid P2P + WebSocket Relay Mesh Architecture
// - DJ acts as the Master Topology Orchestrator.
// - Deterministic shallowest-depth binary tree placement (max 2 children per node).
// - Tree-delegated link heartbeats (child <-> parent only). Listeners do NOT blast the DJ with O(N) heartbeats.
// - Dual-Transport Hybrid Engine:
//   1. Attempts direct WebRTC P2P DataChannels (LAN / IPv6 / Open Cone NAT).
//   2. Automatically and seamlessly bridges over the built-in WebSocket Tunnel Relay (`/__p2p_relay`)
//      whenever a peer is behind Symmetric NAT / 4G / 5G / CGNAT or corporate firewalls.
//   3. Zero router port forwarding or manual TURN server setup required!

import Peer, { type DataConnection } from 'peerjs';
import { sha256Base64, sanitizeTrackManifest, type TrackManifest } from './chunk-pipeline';

const TRACK_ID_RE = /^[a-zA-Z0-9_-]{3,32}$/;

function stableStringify(val: unknown): string {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return '[' + val.map((item) => (item === undefined ? 'null' : stableStringify(item))).join(',') + ']';
  }
  const obj = val as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function extractSignablePayload(msg: Record<string, unknown>): Record<string, unknown> {
  return {
    type: msg.type,
    ...(msg.parentId !== undefined ? { parentId: msg.parentId } : {}),
    ...(msg.depth !== undefined ? { depth: msg.depth } : {}),
    ...(msg.state !== undefined ? { state: msg.state } : {}),
    ...(msg.tree !== undefined ? { tree: msg.tree } : {}),
    ...(msg.authorized !== undefined ? { authorized: msg.authorized } : {}),
    ...(msg.trackId !== undefined ? { trackId: msg.trackId } : {}),
    ...(msg.sync !== undefined ? { sync: msg.sync } : {})
  };
}

export interface PlaybackSyncReport {
  trackId: string;
  djPosition: number;
  djDuration: number;
  sentAt: number;
  isPlaying: boolean;
}

export interface PeerNodeInfo {
  peerId: string;
  stationId: string;
  role: 'dj' | 'listener';
  parent: string | null;
  children: string[];
  depth: number;
  lastHeartbeat: number;
  bufferPct?: number;
  transport?: 'webrtc' | 'relay';
}

export type ToastVariant = 'info' | 'success' | 'warning' | 'error' | 'critical';

export interface StationActionEvent {
  id: string;
  variant: ToastVariant;
  message: string;
}

export interface StationState {
  stationId: string;
  djPeerId: string;
  currentTrackId: string | null;
  startedAt: number;
  isPlaying: boolean;
  nextTrackId: string | null;
  trackManifests: Record<string, TrackManifest>;
  playlistOrder: string[];
  isShuffled: boolean;
  lastAction?: StationActionEvent;
}

export class P2PMesh {
  public peerId: string = '';
  public stationId: string = '';
  public isDJ: boolean = false;
  public depth: number = 0;
  public currentParentId: string | null = null;
  public childrenIds: Set<string> = new Set();
  public maxChildren: number = 2; // Strict binary tree constraint

  private peer: Peer | null = null;

  // Built-in Zero-Config WebSocket Relay (works over localtunnel / cloudflared / ngrok / LAN)
  private relayWs: WebSocket | null = null;
  private relayConnected: boolean = false;
  private relayReconnectTimer: any = null;
  private relayPingInterval: any = null;
  private relayStabilityTimer: any = null;
  private isDestroyed: boolean = false;
  private hasLoggedRelayOnline: boolean = false;
  private relayReconnectAttempts: number = 0;

  // Direct WebRTC Connections
  private djControlConn: DataConnection | null = null; // Listener -> DJ direct WebRTC control link
  private allListenerConns: Map<string, DataConnection> = new Map(); // DJ -> active listeners WebRTC control link
  private parentDataConn: DataConnection | null = null; // Stream input connection (from assigned parent)
  private childDataConns: Map<string, DataConnection> = new Map(); // Stream output connections (to assigned children)

  // Track which children / parent are using WebSocket Relay vs direct WebRTC
  private relayChildrenIds: Set<string> = new Set();
  // Torrent-style swarm data channels (kept separate from pyramid childDataConns so live broadcasts don't push to swarm peers)
  private swarmConns: Map<string, DataConnection> = new Map();
  private lastSwarmPullAt: number = 0;
  private hostToken: string = '';
  private usingRelayForControl: boolean = false;
  private usingRelayForParentStream: boolean = false;
  private hasJoinedPyramid: boolean = false;
  private joinRetryTimer: any = null;
  private lastJoinRequestAt: number = 0;
  private relayFailures: number = 0;
  private relayEverConnected: boolean = false;

  // Chunk deduplication to prevent packet storms and endless re-relaying
  private seenChunks: Set<string> = new Set();

  // Master topology map (maintained authoritatively by DJ, mirrored on listeners)
  private masterTreeMap: Map<string, PeerNodeInfo> = new Map();
  private stationState: StationState | null = null;
  private heartbeatInterval: any = null;
  private playbackSyncInterval: any = null;
  private lastAppliedSyncSentAt: number = 0;
  private missedParentPings: number = 0;
  private currentBufferPct: number = 0;

  // Track chunk requesting & buffer stall watchdog state
  private pendingTrackChunkRequest: { trackId: string; missingIndexes?: number[] } | null = null;
  private chunksReceivedSinceParentConnect: number = 0;
  private parentConnectedTime: number = 0;
  private lastChunkReceivedAt: number = 0;

  // Callbacks
  public onStationStateUpdate?: (state: StationState) => void;
  public onChunkReceived?: (trackId: string, chunkIndex: number, totalChunks: number, data: ArrayBuffer) => boolean | void;
  public onTreeUpdated?: (peers: PeerNodeInfo[]) => void;
  public onStatusMessage?: (msg: string) => void;
  public onRequestTrackChunks?: (targetPeerId: string, trackId: string, missingIndexes?: number[]) => void;
  public onGetMissingChunks?: () => { trackId: string; missingIndexes: number[] } | null;
  public onStationConflict?: (stationId: string) => void;
  public onInjectAuthorized?: (authorized: boolean) => void;
  public onInjectTrackInit?: (peerId: string, manifest: TrackManifest) => void;
  public onInjectedChunkReceived?: (trackId: string, chunkIndex: number, totalChunks: number, data: ArrayBuffer) => void;
  public onInjectTrackComplete?: (trackId: string) => void;
  public onInjectTrackExpired?: (trackId: string) => void;
  public onPeerDeparted?: (peerId: string) => void;
  public onGetPlaybackSyncState?: () => PlaybackSyncReport | null;
  public onPlaybackSync?: (report: PlaybackSyncReport) => void;

  private isPublicBroadcast = true;
  private injectSecret = '';
  private listenerInjectToken = '';
  private authorizedInjectors = new Set<string>();
  private injectFailCounts = new Map<string, number>();
  private authorizedTrackSenders = new Map<string, string>();
  private pendingInjectManifests = new Map<string, TrackManifest>();
  private injectLastActivityAt = new Map<string, number>();
  private parentReportCooldowns = new Map<string, number>();
  private inFlightChunkKeys = new Set<string>();
  private assignedParentId: string | null = null;

  // Ephemeral ECDSA P-256 session signing (DJ -> listeners)
  private djSigningKeyPair: CryptoKeyPair | null = null;
  private djPublicJwk: JsonWebKey | null = null;
  private djKeyReadyPromise: Promise<void> = Promise.resolve();
  private controlSendQueue: Promise<void> = Promise.resolve();
  private pinnedDjVerifyKey: CryptoKey | null = null;
  private pinnedDjJwkCanonical = '';
  private listenerVerifyQueue: Promise<void> = Promise.resolve();

  private getCurrentTrackTitle(): string {
    const id = this.stationState?.currentTrackId;
    if (!id) return '';
    return this.stationState?.trackManifests?.[id]?.title || '';
  }

  constructor() {
    this.peerId = 'peer_' + Math.random().toString(36).substring(2, 9);
    this.bindWindowUnload();
  }

  // Bind graceful departure on window close/reload
  private bindWindowUnload() {
    if (typeof window === 'undefined') return;

    const handleDeparture = () => {
      this.signOff();
    };

    window.addEventListener('beforeunload', handleDeparture);
    window.addEventListener('pagehide', handleDeparture);
  }

  public signOff() {
    try {
      if (this.isDJ) {
        // DJ is exiting
        for (const conn of this.allListenerConns.values()) {
          if (conn.open) {
            conn.send({ type: 'dj_station_closed' });
          }
        }
        this.sendViaRelay('*', { type: 'dj_station_closed' });
      } else {
        // Listener is signing off gracefully
        const departMsg = {
          type: 'graceful_departure',
          peerId: this.peerId
        };
        if (this.djControlConn && this.djControlConn.open) {
          this.djControlConn.send(departMsg);
        }
        const djPeerId = `station-${this.stationId}-dj`;
        this.sendViaRelay(djPeerId, departMsg);

        if (this.currentParentId) {
          const childDepartMsg = {
            type: 'child_departing',
            childPeerId: this.peerId
          };
          if (this.parentDataConn && this.parentDataConn.open) {
            this.parentDataConn.send(childDepartMsg);
          }
          this.sendViaRelay(this.currentParentId, childDepartMsg);
        }
      }
    } catch (e) {
      console.warn('[P2P Mesh] Error during signOff:', e);
    }
  }

  // --- 1. DJ Mode: Host Station as Orchestrator ---

  public hostStation(
    stationId: string,
    initialManifests: Record<string, TrackManifest>,
    playlistOrder: string[],
    isPublic = true,
    injectSecret = '',
    persistedHostToken = ''
  ) {
    const cleanStationId = stationId.toLowerCase().trim();
    this.isDestroyed = false;
    this.hasLoggedRelayOnline = false;
    this.relayReconnectAttempts = 0;
    this.stationId = cleanStationId;
    this.isDJ = true;
    this.isPublicBroadcast = isPublic;
    this.injectSecret = injectSecret;
    this.authorizedInjectors.clear();
    this.injectFailCounts.clear();
    this.authorizedTrackSenders.clear();
    this.pendingInjectManifests.clear();
    this.injectLastActivityAt.clear();
    this.parentReportCooldowns.clear();
    this.depth = 0;
    this.currentParentId = null;
    this.assignedParentId = null;
    this.hostToken = persistedHostToken.trim().length >= 16
      ? persistedHostToken.trim()
      : (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2));
    clearInterval(this.playbackSyncInterval);
    this.lastAppliedSyncSentAt = 0;

    this.initDjSigningKeys();

    const djPeerId = `station-${cleanStationId}-dj`;
    this.peerId = djPeerId;

    this.stationState = {
      stationId: cleanStationId,
      djPeerId,
      currentTrackId: playlistOrder[0] || null,
      startedAt: Date.now(),
      isPlaying: true,
      nextTrackId: playlistOrder[1] || (playlistOrder.length > 1 ? playlistOrder[0] : null),
      trackManifests: initialManifests,
      playlistOrder,
      isShuffled: false,
    };

    // Initialize DJ node in master tree map
    this.masterTreeMap.set(djPeerId, {
      peerId: djPeerId,
      stationId: cleanStationId,
      role: 'dj',
      parent: null,
      children: [],
      depth: 0,
      lastHeartbeat: Date.now(),
      bufferPct: 100,
      transport: 'webrtc'
    });

    this.initRelaySocket();
    this.initPeer(djPeerId);
  }

  private initDjSigningKeys() {
    this.djSigningKeyPair = null;
    this.djPublicJwk = null;
    this.controlSendQueue = Promise.resolve();
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      this.djKeyReadyPromise = Promise.resolve();
      return;
    }

    const storageKey = this.stationId ? `p2p_dj_signkey_${this.stationId}` : '';

    this.djKeyReadyPromise = (async () => {
      // Reuse persisted keypair across same-tab reloads so existing listeners keep verifying states
      if (storageKey && typeof sessionStorage !== 'undefined') {
        try {
          const raw = sessionStorage.getItem(storageKey);
          if (raw) {
            const parsed = JSON.parse(raw) as { privJwk?: JsonWebKey; pubJwk?: JsonWebKey };
            if (
              parsed?.privJwk?.kty === 'EC' &&
              parsed?.privJwk?.crv === 'P-256' &&
              parsed?.pubJwk?.kty === 'EC' &&
              parsed?.pubJwk?.crv === 'P-256'
            ) {
              const [privateKey, publicKey] = await Promise.all([
                crypto.subtle.importKey('jwk', parsed.privJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']),
                crypto.subtle.importKey('jwk', parsed.pubJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])
              ]);
              this.djSigningKeyPair = { privateKey, publicKey };
              this.djPublicJwk = parsed.pubJwk;
              return;
            }
          }
        } catch {}
      }

      const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const [privJwk, pubJwk] = await Promise.all([
        crypto.subtle.exportKey('jwk', kp.privateKey),
        crypto.subtle.exportKey('jwk', kp.publicKey)
      ]);
      this.djSigningKeyPair = kp;
      this.djPublicJwk = pubJwk;

      if (storageKey && typeof sessionStorage !== 'undefined') {
        try {
          sessionStorage.setItem(storageKey, JSON.stringify({ privJwk, pubJwk }));
        } catch {}
      }
    })().catch(() => {
      this.djSigningKeyPair = null;
      this.djPublicJwk = null;
    });
  }

  private enqueueSignedDjDispatch(sendFn: (signedMsg: any) => void, msg: Record<string, unknown>) {
    this.controlSendQueue = this.controlSendQueue.then(async () => {
      if (this.isDestroyed) return;
      // Strip undefined keys before signing so PeerJS BinaryPack (which converts undefined -> null)
      // and JSON relay transport produce identical objects on listeners.
      let cleanMsg: Record<string, unknown>;
      try {
        cleanMsg = JSON.parse(JSON.stringify(msg)) as Record<string, unknown>;
      } catch {
        cleanMsg = msg;
      }
      await this.djKeyReadyPromise;
      if (!this.djSigningKeyPair || !this.djPublicJwk || typeof crypto === 'undefined' || !crypto.subtle) {
        sendFn(cleanMsg);
        return;
      }
      try {
        const canonical = stableStringify(extractSignablePayload(cleanMsg));
        const encoded = new TextEncoder().encode(canonical);
        const sigBuf = await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          this.djSigningKeyPair.privateKey,
          encoded
        );
        sendFn({
          ...cleanMsg,
          djPubJwk: this.djPublicJwk,
          djSig: bytesToBase64(new Uint8Array(sigBuf))
        });
      } catch {
        sendFn(cleanMsg);
      }
    });
  }

  public rotateInjectSecret(newSecret: string) {
    if (!this.isDJ) return;
    const prevInjectors = Array.from(this.authorizedInjectors);
    this.injectSecret = newSecret;
    this.authorizedInjectors.clear();
    this.injectFailCounts.clear();
    this.authorizedTrackSenders.clear();
    this.pendingInjectManifests.clear();
    this.injectLastActivityAt.clear();
    for (const peerId of prevInjectors) {
      this.sendControlToListener(peerId, { type: 'inject_authorized', authorized: false });
    }
  }

  public clearPendingInjectTrack(trackId: string) {
    this.authorizedTrackSenders.delete(trackId);
    this.pendingInjectManifests.delete(trackId);
    this.injectLastActivityAt.delete(trackId);
  }

  private cleanupStaleInjects(maxIdleMs = 90_000) {
    if (!this.isDJ || this.injectLastActivityAt.size === 0) return;
    const now = Date.now();
    for (const [trackId, lastAt] of this.injectLastActivityAt.entries()) {
      if (now - lastAt > maxIdleMs) {
        this.clearPendingInjectTrack(trackId);
        this.onInjectTrackExpired?.(trackId);
      }
    }
  }

  // --- 2. Listener Mode: Join Station ---

  public joinStation(stationId: string, injectToken = '') {
    this.isDestroyed = false;
    this.hasLoggedRelayOnline = false;
    this.relayReconnectAttempts = 0;
    this.stationId = stationId.toLowerCase().trim();
    this.isDJ = false;
    this.hasJoinedPyramid = false;
    this.listenerInjectToken = injectToken.trim();
    this.pinnedDjVerifyKey = null;
    this.pinnedDjJwkCanonical = '';
    this.assignedParentId = null;
    this.listenerVerifyQueue = Promise.resolve();
    clearInterval(this.playbackSyncInterval);
    this.lastAppliedSyncSentAt = 0;

    const listenerId = 'peer_' + Math.random().toString(36).substring(2, 9);
    this.peerId = listenerId;

    this.initRelaySocket();
    this.initPeer(listenerId);
  }

  public sendControlToDJ(msg: any): boolean {
    if (this.isDJ || !this.stationId) return false;
    if (this.djControlConn && this.djControlConn.open) {
      this.djControlConn.send(msg);
      return true;
    }
    if (this.relayConnected) {
      return this.sendViaRelay(`station-${this.stationId}-dj`, msg);
    }
    return false;
  }

  public sendInjectTrackInit(manifest: TrackManifest): boolean {
    if (!this.listenerInjectToken) return false;
    return this.sendControlToDJ({
      type: 'inject_track_init',
      token: this.listenerInjectToken,
      manifest
    });
  }

  public sendInjectChunkToDJ(trackId: string, chunkIndex: number, totalChunks: number, rawData: ArrayBuffer): boolean {
    if (this.isDJ || !this.stationId) return false;
    const packet = this.encodeChunkPacket(trackId, chunkIndex, totalChunks, rawData);
    if (this.djControlConn && this.djControlConn.open) {
      this.djControlConn.send(packet);
      return true;
    }
    if (this.relayConnected) {
      return this.sendBinaryViaRelay(`station-${this.stationId}-dj`, packet);
    }
    return false;
  }

  public notifyInjectComplete(peerId: string, trackId: string) {
    if (!this.isDJ) return;
    this.clearPendingInjectTrack(trackId);
    this.sendControlToListener(peerId, { type: 'inject_track_complete', trackId });
  }

  public reportBufferProgress(bufferPct: number) {
    this.currentBufferPct = bufferPct;
    if (!this.isDJ && bufferPct === 100 && this.stationId) {
      const msg = {
        type: 'buffer_update',
        peerId: this.peerId,
        bufferPct: 100
      };
      if (this.djControlConn && this.djControlConn.open) {
        this.djControlConn.send(msg);
      } else if (this.relayConnected) {
        this.sendViaRelay(`station-${this.stationId}-dj`, msg);
      }
    }
  }

  public resetMetricsOnTrackChange() {
    this.chunksReceivedSinceParentConnect = 0;
    this.parentConnectedTime = Date.now();
    this.lastChunkReceivedAt = Date.now();
    this.missedParentPings = 0;
  }

  // --- 2b. Universal Zero-Config WebSocket Relay Bridge ---

  private detachRelaySocket(ws: WebSocket | null) {
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try { ws.close(); } catch {}
  }

  private initRelaySocket() {
    if (typeof window === 'undefined' || this.isDestroyed) return;
    if (this.relayWs) {
      this.detachRelaySocket(this.relayWs);
      this.relayWs = null;
    }
    clearTimeout(this.relayReconnectTimer);
    clearTimeout(this.relayStabilityTimer);
    clearInterval(this.relayPingInterval);

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const stationParam = this.stationId ? `?station=${encodeURIComponent(this.stationId)}` : '';
    const wsUrl = `${proto}//${window.location.host}/__p2p_relay${stationParam}`;

    try {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      this.relayWs = ws;

      ws.onopen = () => {
        if (this.isDestroyed || this.relayWs !== ws) {
          this.detachRelaySocket(ws);
          return;
        }
        this.relayConnected = true;
        this.relayEverConnected = true;
        this.relayFailures = 0;
        clearTimeout(this.relayStabilityTimer);
        this.relayStabilityTimer = setTimeout(() => {
          if (this.relayWs === ws && ws.readyState === WebSocket.OPEN) {
            this.relayReconnectAttempts = 0;
          }
        }, 10_000);
        if (!this.hasLoggedRelayOnline) {
          this.hasLoggedRelayOnline = true;
          this.log(`[RELAY] Universal Tunnel Relay online (NAT/Firewall bypass ready)`);
        }
        ws.send(JSON.stringify({
          type: 'register',
          peerId: this.peerId,
          stationId: this.stationId,
          role: this.isDJ ? 'dj' : 'listener',
          ...(this.isDJ && this.hostToken ? { hostToken: this.hostToken } : {}),
          ...(this.isDJ ? { isPublic: this.isPublicBroadcast, trackTitle: this.getCurrentTrackTitle() } : {})
        }));

        // Keep tunnel WebSocket alive across reverse proxies / localtunnel
        this.relayPingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'ping',
              ...(this.isDJ && this.isPublicBroadcast ? { trackTitle: this.getCurrentTrackTitle() } : {})
            }));
          }
        }, 15000);

        // If listener hasn't joined pyramid yet, after a brief head-start for direct WebRTC,
        // automatically register via the relay so mobile/CGNAT devices connect with zero delay!
        if (!this.isDJ) {
          if (this.hasJoinedPyramid && !this.djControlConn?.open) {
            // Re-register immediately after a WebSocket reconnect while using Relay control
            this.requestPyramidJoinViaRelay(false);
          } else {
            setTimeout(() => {
              if (!this.isDestroyed && !this.hasJoinedPyramid && !this.djControlConn?.open) {
                this.activateRelayControlFallback();
              }
            }, 1800);
          }
        }
      };

      ws.onmessage = (evt) => {
        if (this.isDestroyed || this.relayWs !== ws) return;
        if (evt.data instanceof ArrayBuffer) {
          this.handleRelayBinaryFrame(evt.data);
        } else if (typeof evt.data === 'string') {
          try {
            const msg = JSON.parse(evt.data);
            this.handleRelayControlFrame(msg);
          } catch {}
        }
      };

      ws.onclose = () => {
        if (this.relayWs !== ws) return;
        this.relayWs = null;
        this.relayConnected = false;
        clearTimeout(this.relayStabilityTimer);
        clearInterval(this.relayPingInterval);
        if (this.isDestroyed) return;
        this.relayFailures++;
        if (this.relayFailures >= 3) {
          this.hasLoggedRelayOnline = false;
        }
        if (this.relayEverConnected || this.relayFailures < 2) {
          const delayMs = Math.min(20_000, Math.round(2500 * Math.pow(1.5, Math.min(this.relayReconnectAttempts, 6))));
          this.relayReconnectAttempts++;
          this.relayReconnectTimer = setTimeout(() => {
            if (!this.isDestroyed && this.stationId) this.initRelaySocket();
          }, delayMs);
        }
      };

      ws.onerror = () => {
        // Handled by onclose
      };
    } catch (e) {
      console.warn('[P2P Mesh] Relay socket error:', e);
    }
  }

  private requestPyramidJoinViaRelay(logActivation: boolean) {
    if (this.isDJ || !this.relayConnected) return;
    const now = Date.now();
    if (now - this.lastJoinRequestAt < 1200) return;
    this.lastJoinRequestAt = now;
    this.usingRelayForControl = true;
    const djPeerId = `station-${this.stationId}-dj`;
    if (logActivation) {
      this.log(`⚡ Activating Universal Tunnel Bridge to DJ (${djPeerId})...`);
    }
    this.sendViaRelay(djPeerId, {
      type: 'request_join_pyramid',
      peerId: this.peerId,
      stationId: this.stationId,
      viaRelay: true
    });
  }

  private activateRelayControlFallback() {
    if (this.isDJ || this.hasJoinedPyramid || this.djControlConn?.open) return;
    if (!this.relayConnected) return;

    this.requestPyramidJoinViaRelay(!this.usingRelayForControl);
    if (!this.joinRetryTimer) {
      this.joinRetryTimer = setInterval(() => {
        if (this.isDJ || this.hasJoinedPyramid) {
          clearInterval(this.joinRetryTimer);
          this.joinRetryTimer = null;
          return;
        }
        if (this.relayConnected && !this.djControlConn?.open) {
          this.requestPyramidJoinViaRelay(false);
        }
      }, 2500);
    }
  }

  private sendViaRelay(targetPeerId: string, payload: any): boolean {
    if (!this.relayWs || this.relayWs.readyState !== WebSocket.OPEN) return false;
    try {
      this.relayWs.send(JSON.stringify({
        type: 'relay_control',
        to: targetPeerId,
        from: this.peerId,
        payload
      }));
      return true;
    } catch {
      return false;
    }
  }

  private sendBinaryViaRelay(targetPeerId: string, packet: ArrayBuffer): boolean {
    if (!this.relayWs || this.relayWs.readyState !== WebSocket.OPEN) return false;
    try {
      const targetBytes = this.getPadded32Bytes(targetPeerId, this.peerIdBytesCache);
      const fromBytes = this.getPadded32Bytes(this.peerId, this.peerIdBytesCache);
      const frame = new Uint8Array(64 + packet.byteLength);
      frame.set(targetBytes, 0);
      frame.set(fromBytes, 32);
      frame.set(new Uint8Array(packet), 64);
      this.relayWs.send(frame.buffer);
      return true;
    } catch {
      return false;
    }
  }

  private handleRelayBinaryFrame(frameBuffer: ArrayBuffer) {
    if (frameBuffer.byteLength < 64 + 40) return;
    const fromPeerId = new TextDecoder().decode(new Uint8Array(frameBuffer, 32, 32)).trim();
    const chunkPacket = frameBuffer.slice(64);
    this.handleBinaryChunk(chunkPacket, fromPeerId);
  }

  private handleRelayControlFrame(msg: any) {
    if (msg.type === 'register_rejected') {
      const rejectedStation = msg.stationId || this.stationId || '';
      if (msg.reason === 'peer_id_in_use') {
        this.peerId = 'peer_' + Math.random().toString(36).substring(2, 9);
        this.relayWs?.close();
        return;
      }
      this.log(`🚨 Station "${rejectedStation}" is already hosted by another DJ! Connection rejected.`);
      this.relayFailures = 999;
      this.relayEverConnected = false;
      clearTimeout(this.relayReconnectTimer);
      this.onStationConflict?.(rejectedStation);
      return;
    }

    if (msg.type === 'relay_dj_disconnected' && !this.isDJ) {
      // If direct WebRTC links are open, do not wipe verified DJ/parent state on a transient relay blip
      if (this.djControlConn?.open || this.parentDataConn?.open) {
        return;
      }
      this.log(`🚨 DJ disconnected from station "${msg.stationId}".`);
      this.hasJoinedPyramid = false;
      this.currentParentId = null;
      this.assignedParentId = null;
      this.usingRelayForParentStream = false;
      this.pinnedDjVerifyKey = null;
      this.pinnedDjJwkCanonical = '';
      return;
    }

    if (msg.type === 'relay_peer_disconnected' && this.isDJ) {
      const droppedId = msg.peerId;
      // Only prune immediately if they don't have an active direct WebRTC connection
      const webrtcConn = this.allListenerConns.get(droppedId);
      if (!webrtcConn || !webrtcConn.open) {
        this.relayChildrenIds.delete(droppedId);
        this.childrenIds.delete(droppedId);
        this.handleListenerDeparted(droppedId);
      }
      return;
    }

    if (msg.type !== 'relay_control' || !msg.payload) return;
    const fromId = typeof msg.from === 'string' ? msg.from.trim() : '';
    if (!fromId) return;
    const data = msg.payload;
    if (!data || typeof data !== 'object') return;
    const djPeerId = `station-${this.stationId}-dj`;

    if (this.isDJ) {
      // DJ receiving control or stream requests from a listener over the relay
      if (
        data.type === 'request_join_pyramid' ||
        data.type === 'buffer_update' ||
        data.type === 'graceful_departure' ||
        data.type === 'parent_unresponsive' ||
        data.type === 'verify_inject' ||
        data.type === 'inject_track_init'
      ) {
        this.handleListenerRequestToDJ(fromId, data);
      } else {
        const node = this.masterTreeMap.get(fromId);
        if (!node) return;
        if (data.forceRelay && node.parent === this.peerId) {
          this.dropWebRtcChildStream(fromId);
        }
        node.lastHeartbeat = Date.now();
        if (node.parent === this.peerId) {
          this.relayChildrenIds.add(fromId);
          this.childrenIds.add(fromId);
        }
        this.handleStreamData(data, fromId);
      }
    } else {
      // Listener receiving control directives ONLY from the station DJ or stream messages from assigned parent/child
      if (
        data.type === 'dj_assignment' ||
        data.type === 'master_tree_update' ||
        data.type === 'station_state' ||
        data.type === 'dj_station_closed' ||
        data.type === 'inject_authorized' ||
        data.type === 'inject_track_complete'
      ) {
        if (fromId !== djPeerId) return;
        this.handleDJControlMessage(data);
      } else if (data.type === 'playback_sync') {
        const expectedParent = this.currentParentId || this.assignedParentId || djPeerId;
        if (fromId !== djPeerId && fromId !== expectedParent) return;
        this.handleDJControlMessage(data);
      } else if (data.type === 'relay_stream_ready') {
        const expectedParent = this.assignedParentId || this.currentParentId || this.masterTreeMap.get(this.peerId)?.parent;
        if (fromId !== expectedParent) return;
        // Parent confirmed stream bridge over relay!
        if (!this.parentDataConn || !this.parentDataConn.open) {
          this.usingRelayForParentStream = true;
          this.currentParentId = fromId;
          this.missedParentPings = 0;
          this.log(`⚡ Audio stream pipeline bridged with parent ${fromId} (Universal Relay)!`);
          this.sendViaRelay(fromId, { type: 'request_audio_chunks', from: this.peerId });
        }
      } else if (data.type === 'request_relay_stream') {
        const requesterNode = this.masterTreeMap.get(fromId);
        if (requesterNode && requesterNode.parent !== this.peerId) return;
        // A child is connecting to us over the Universal Relay
        this.dropWebRtcChildStream(fromId);
        this.relayChildrenIds.add(fromId);
        this.childrenIds.add(fromId);
        this.log(`Data stream bridged with child ${fromId} (Universal Relay)`);
        this.sendViaRelay(fromId, { type: 'relay_stream_ready', from: this.peerId });
      } else {
        const requesterNode = this.masterTreeMap.get(fromId);
        if (data.forceRelay && requesterNode?.parent === this.peerId) {
          this.dropWebRtcChildStream(fromId);
          this.relayChildrenIds.add(fromId);
          this.childrenIds.add(fromId);
        }
        this.handleStreamData(data, fromId);
      }
    }
  }

  // --- 3. PeerJS Initialization & Routing ---

  public static getSavedIceServers(): RTCIceServer[] | null {
    try {
      const saved = localStorage.getItem('pyramid_ice_servers');
      if (saved) return JSON.parse(saved);
    } catch {}
    return null;
  }

  public static saveIceServers(servers: RTCIceServer[] | null) {
    try {
      if (servers && servers.length > 0) {
        localStorage.setItem('pyramid_ice_servers', JSON.stringify(servers));
      } else {
        localStorage.removeItem('pyramid_ice_servers');
      }
    } catch {}
  }

  private initPeer(customId: string) {
    if (this.peer) this.peer.destroy();

    const customIce = P2PMesh.getSavedIceServers();
    const defaultIceServers: RTCIceServer[] = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ];

    const activeIceServers = (customIce && customIce.length > 0)
      ? [...customIce, ...defaultIceServers]
      : defaultIceServers;

    this.peer = new Peer(customId, {
      debug: 1,
      config: {
        iceServers: activeIceServers,
        iceCandidatePoolSize: 2
      }
    });

    this.peer.on('open', (id) => {
      this.peerId = id;
      this.log(`P2P Node online: ${id}`);

      if (this.isDJ) {
        this.notifyTreeChange();
        this.startDJPruner();
        this.startPlaybackSyncLoop();
      } else {
        // As a listener, establish control channel with DJ orchestrator
        this.connectToDJOrchestrator();
        this.startTreeDelegatedHeartbeat();
      }
    });

    // Handle incoming connections
    this.peer.on('connection', (conn) => {
      this.handleIncomingConnection(conn);
    });

    this.peer.on('error', (err) => {
      // If direct WebRTC fails or peer-unavailable, automatically fall back to the Universal Tunnel Relay
      if (!this.isDJ && !this.hasJoinedPyramid) {
        this.activateRelayControlFallback();
      } else if (err.type === 'peer-unavailable' && !this.isDJ) {
        this.activateRelayControlFallback();
      }
    });
  }

  // --- 4. Listener -> DJ Control Channel ---

  private attachPCDiagnostics(conn: DataConnection, targetPeerId: string, role: string, onFail?: () => void) {
    const timer = setInterval(() => {
      const pc = (conn as any).peerConnection as RTCPeerConnection | null | undefined;
      if (pc) {
        clearInterval(timer);
        pc.addEventListener('iceconnectionstatechange', () => {
          const state = pc.iceConnectionState;
          if (state === 'failed' || state === 'disconnected') {
            if (onFail) onFail();
          }
        });
      }
    }, 50);

    setTimeout(() => clearInterval(timer), 10000);
  }

  private connectToDJOrchestrator() {
    if (!this.peer || this.peer.destroyed) return;
    const djPeerId = `station-${this.stationId}-dj`;

    this.log(`Registering with DJ Orchestrator (${djPeerId})...`);
    let hasOpened = false;
    let retryScheduled = false;

    const conn = this.peer.connect(djPeerId, {
      metadata: { role: 'control_channel' }
    });

    const scheduleWebRtcRetry = () => {
      if (retryScheduled || this.isDJ || this.hasJoinedPyramid || this.djControlConn?.open) return;
      retryScheduled = true;
      setTimeout(() => this.connectToDJOrchestrator(), 2000);
    };

    const relayFallbackTimer = setTimeout(() => {
      if (!hasOpened && !this.hasJoinedPyramid && this.relayConnected) {
        this.activateRelayControlFallback();
      }
    }, 2500);

    // Allow generous time for macOS mDNS (.local) -> STUN fallback on static SPA hosts
    const connectTimeout = setTimeout(() => {
      if (!hasOpened) {
        try { conn.close(); } catch {}
        if (!this.relayConnected && !this.hasJoinedPyramid) {
          this.log(`⚠️ Direct WebRTC handshake timed out. Retrying DJ connection...`);
          scheduleWebRtcRetry();
        } else if (!this.hasJoinedPyramid) {
          this.activateRelayControlFallback();
        }
      }
    }, 12000);

    this.attachPCDiagnostics(conn, djPeerId, 'ControlChannel', () => {
      if (this.relayConnected) {
        if (!this.hasJoinedPyramid) this.activateRelayControlFallback();
      } else if (!hasOpened) {
        clearTimeout(relayFallbackTimer);
        clearTimeout(connectTimeout);
        try { conn.close(); } catch {}
        scheduleWebRtcRetry();
      }
    });

    conn.on('open', () => {
      hasOpened = true;
      this.usingRelayForControl = false;
      clearTimeout(relayFallbackTimer);
      clearTimeout(connectTimeout);
      this.log(`⚡ Direct WebRTC Control channel established with DJ!`);
      this.djControlConn = conn;

      conn.send({
        type: 'request_join_pyramid',
        peerId: this.peerId,
        stationId: this.stationId,
        viaRelay: false
      });
    });

    conn.on('data', (data: any) => {
      if (this.djControlConn !== conn && conn.peer !== djPeerId) return;
      this.handleDJControlMessage(data);
    });

    conn.on('error', () => {
      clearTimeout(relayFallbackTimer);
      clearTimeout(connectTimeout);
      if (this.relayConnected) {
        if (!this.hasJoinedPyramid) this.activateRelayControlFallback();
      } else if (!hasOpened) {
        try { conn.close(); } catch {}
        scheduleWebRtcRetry();
      }
    });

    conn.on('close', () => {
      clearTimeout(relayFallbackTimer);
      clearTimeout(connectTimeout);
      this.djControlConn = null;
      if (!this.relayConnected) {
        this.log(`⚠️ Lost control channel with DJ. Reconnecting...`);
        scheduleWebRtcRetry();
      } else if (!this.hasJoinedPyramid) {
        this.activateRelayControlFallback();
      } else {
        this.usingRelayForControl = true;
      }
    });
  }

  // --- 5. Pure Binary Tree Capacity Placement ---

  private async isAuthorizedStreamChild(remoteId: string): Promise<boolean> {
    for (let attempt = 0; attempt < 6; attempt++) {
      if (!this.isDJ) {
        await this.listenerVerifyQueue;
      }
      const node = this.masterTreeMap.get(remoteId);
      if (node && node.parent === this.peerId) {
        return this.childDataConns.has(remoteId) || this.childDataConns.size < this.maxChildren;
      }
      if (this.isDJ || attempt === 5) return false;
      // Give master_tree_update a brief window to arrive after a child's dj_assignment
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  private async isKnownStationPeer(remoteId: string): Promise<boolean> {
    if (remoteId === this.peerId) return false;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (!this.isDJ) {
        await this.listenerVerifyQueue;
      }
      if (this.masterTreeMap.has(remoteId)) return true;
      if (this.isDJ || attempt === 5) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  private handleIncomingConnection(conn: DataConnection) {
    const remoteId = conn.peer;

    conn.on('open', () => {
      const role = conn.metadata?.role;
      const isControl = role === 'control_channel';
      const isSwarm = role === 'swarm_channel';

      if (isControl) {
        if (!this.isDJ) {
          try { conn.close(); } catch {}
          return;
        }
        this.allListenerConns.set(remoteId, conn);
        const node = this.masterTreeMap.get(remoteId);
        if (node) node.transport = 'webrtc';
        this.log(`Listener ${remoteId} connected via direct WebRTC`);
      } else if (isSwarm) {
        void (async () => {
          if (!(await this.isKnownStationPeer(remoteId)) || !conn.open) {
            try { conn.close(); } catch {}
            return;
          }
          this.swarmConns.set(remoteId, conn);
          this.log(`Swarm channel connected with ${remoteId}`);
        })();
      } else {
        // Stream Data Channel: authorize strictly against masterTreeMap topology and maxChildren
        void (async () => {
          if (!(await this.isAuthorizedStreamChild(remoteId)) || !conn.open) {
            try { conn.close(); } catch {}
            return;
          }
          this.log(`Direct P2P stream connected with ${remoteId}`);
          this.childDataConns.set(remoteId, conn);
          this.relayChildrenIds.delete(remoteId); // Upgrade from relay if direct succeeded
          this.childrenIds.add(remoteId);
        })();
      }
    });

    conn.on('data', (data: any) => {
      const role = conn.metadata?.role;
      if (role === 'control_channel') {
        if (!this.isDJ) {
          try { conn.close(); } catch {}
          return;
        }
        if (data instanceof ArrayBuffer) {
          void this.handleBinaryChunk(data, remoteId);
        } else if (ArrayBuffer.isView(data)) {
          const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
          void this.handleBinaryChunk(buf, remoteId);
        } else {
          this.handleListenerRequestToDJ(remoteId, data);
        }
      } else if (role === 'swarm_channel') {
        if (this.swarmConns.get(remoteId) === conn) {
          this.handleStreamData(data, remoteId);
        } else {
          void (async () => {
            if (!(await this.isKnownStationPeer(remoteId)) || !conn.open) {
              try { conn.close(); } catch {}
              return;
            }
            this.swarmConns.set(remoteId, conn);
            this.handleStreamData(data, remoteId);
          })();
        }
      } else {
        if (this.childDataConns.get(remoteId) === conn) {
          this.handleStreamData(data, remoteId);
        } else {
          void (async () => {
            if (!(await this.isAuthorizedStreamChild(remoteId)) || !conn.open) {
              try { conn.close(); } catch {}
              return;
            }
            this.childDataConns.set(remoteId, conn);
            this.relayChildrenIds.delete(remoteId);
            this.childrenIds.add(remoteId);
            this.handleStreamData(data, remoteId);
          })();
        }
      }
    });

    conn.on('error', () => {
      // Suppress noisy negotiation error logs when Universal Relay is active and handling the peer
      if (!this.masterTreeMap.has(remoteId) && !this.relayConnected) {
        this.log(`ℹ️ Direct UDP hole-punch to ${remoteId} blocked by NAT; using Universal Relay.`);
      }
    });

    conn.on('close', () => {
      const isControl = conn.metadata?.role === 'control_channel';
      if (this.isDJ && isControl) {
        if (this.allListenerConns.get(remoteId) === conn) {
          this.allListenerConns.delete(remoteId);
        }
        const node = this.masterTreeMap.get(remoteId);
        if (node && node.transport !== 'relay') {
          if (this.relayConnected) {
            node.transport = 'relay';
            node.lastHeartbeat = Date.now();
          } else {
            this.handleListenerDeparted(remoteId);
          }
        }
        return;
      }

      if (this.swarmConns.get(remoteId) === conn) {
        this.sendQueues.delete(remoteId);
        this.isDraining.delete(remoteId);
        this.swarmConns.delete(remoteId);
      }
      if (!this.childDataConns.has(remoteId) || this.childDataConns.get(remoteId) === conn) {
        this.sendQueues.delete(remoteId);
        this.isDraining.delete(remoteId);
        this.childDataConns.delete(remoteId);
        if (!this.relayChildrenIds.has(remoteId)) {
          this.childrenIds.delete(remoteId);
        }
      }
    });
  }

  // Handle listener control messages sent to the DJ (via either WebRTC or Relay)
  private handleListenerRequestToDJ(newcomerId: string, data: any) {
    if (!data || typeof data !== 'object') return;

    if (data.type === 'request_join_pyramid') {
      const isRelay = !!data.viaRelay && (!this.allListenerConns.get(newcomerId)?.open);
      this.assignNewcomerToPyramid(newcomerId, isRelay ? 'relay' : 'webrtc');
    } else if (data.type === 'buffer_update') {
      const node = this.masterTreeMap.get(newcomerId);
      if (node) {
        const prevPct = node.bufferPct ?? 0;
        node.lastHeartbeat = Date.now();
        if (typeof data.bufferPct === 'number' && Number.isFinite(data.bufferPct)) {
          const clampedPct = Math.max(0, Math.min(100, Math.round(data.bufferPct)));
          node.bufferPct = clampedPct;
          if (clampedPct >= 100 && prevPct < 100) {
            this.broadcastTreeTopology();
          }
        }
      }
    } else if (data.type === 'graceful_departure') {
      this.log(`[DJ Orchestrator] Graceful departure received for ${newcomerId}`);
      this.relayChildrenIds.delete(newcomerId);
      this.childrenIds.delete(newcomerId);
      this.handleListenerDeparted(newcomerId);
    } else if (data.type === 'parent_unresponsive') {
      const now = Date.now();
      const lastReport = this.parentReportCooldowns.get(newcomerId) || 0;
      if (now - lastReport < 4000) return;
      this.parentReportCooldowns.set(newcomerId, now);

      // Only act on the caller's actual assigned parent in masterTreeMap; never let peers evict arbitrary nodes
      const callerNode = this.masterTreeMap.get(newcomerId);
      if (!callerNode) return;
      const actualParentId = callerNode.parent;

      if (actualParentId && actualParentId !== this.peerId) {
        const parentNode = this.masterTreeMap.get(actualParentId);
        const parentConn = this.allListenerConns.get(actualParentId);
        const isParentStale = !parentNode || (!(parentConn && parentConn.open) && now - parentNode.lastHeartbeat > 12000);
        if (isParentStale) {
          this.log(`[DJ Orchestrator] Parent ${actualParentId} timed out after report from ${newcomerId}; pruning stale parent.`);
          this.handleListenerDeparted(actualParentId);
        } else {
          // Parent is still alive; re-assign only the reporting caller cleanly without kicking parent
          this.log(`[DJ Orchestrator] Re-routing ${newcomerId} away from ${actualParentId}`);
          parentNode.children = parentNode.children.filter((id) => id !== newcomerId);
          callerNode.parent = null;
          this.assignNewcomerToPyramid(newcomerId, callerNode.transport || 'relay');
        }
      } else {
        this.assignNewcomerToPyramid(newcomerId, callerNode.transport || 'relay');
      }
    } else if (data.type === 'verify_inject') {
      const failures = this.injectFailCounts.get(newcomerId) ?? 0;
      if (failures >= 5) return;

      const token = typeof data.token === 'string' ? data.token : '';
      const ok = Boolean(this.injectSecret && token && constantTimeEqual(token, this.injectSecret));
      if (ok) {
        this.injectFailCounts.delete(newcomerId);
        this.authorizedInjectors.add(newcomerId);
        this.log(`[CO-DJ] Authorized peer ${newcomerId} for track injection`);
      } else {
        this.injectFailCounts.set(newcomerId, failures + 1);
        this.authorizedInjectors.delete(newcomerId);
      }
      this.sendControlToListener(newcomerId, { type: 'inject_authorized', authorized: ok });
    } else if (data.type === 'inject_track_init') {
      const failures = this.injectFailCounts.get(newcomerId) ?? 0;
      if (failures >= 5) return;

      const token = typeof data.token === 'string' ? data.token : '';
      const tokenMatches = Boolean(this.injectSecret && token && constantTimeEqual(token, this.injectSecret));
      const isAuthorized = Boolean(
        this.injectSecret && (this.authorizedInjectors.has(newcomerId) || tokenMatches)
      );
      if (!isAuthorized) {
        this.injectFailCounts.set(newcomerId, failures + 1);
        return;
      }

      this.cleanupStaleInjects();
      if (this.pendingInjectManifests.size >= 5) return;

      const safeManifest = sanitizeTrackManifest(data.manifest);
      if (!safeManifest) return;
      if (
        this.stationState?.trackManifests?.[safeManifest.trackId] ||
        this.authorizedTrackSenders.has(safeManifest.trackId)
      ) {
        return;
      }

      this.authorizedInjectors.add(newcomerId);
      this.authorizedTrackSenders.set(safeManifest.trackId, newcomerId);
      this.pendingInjectManifests.set(safeManifest.trackId, safeManifest);
      this.injectLastActivityAt.set(safeManifest.trackId, Date.now());
      this.onInjectTrackInit?.(newcomerId, safeManifest);
    }
  }

  // Pure binary tree placement: pick shallowest node with capacity (< maxChildren)
  private assignNewcomerToPyramid(newcomerId: string, transport: 'webrtc' | 'relay' = 'webrtc') {
    const dispatchState = this.stationState ? this.buildCompactStateForDispatch(this.stationState) : null;
    // If newcomer is already placed in the pyramid, just re-send their assignment and state!
    const existingNode = this.masterTreeMap.get(newcomerId);
    if (existingNode && existingNode.parent && this.masterTreeMap.has(existingNode.parent)) {
      existingNode.lastHeartbeat = Date.now();
      existingNode.transport = transport;
      this.broadcastTreeTopology();
      this.sendControlToListener(newcomerId, {
        type: 'dj_assignment',
        parentId: existingNode.parent,
        depth: existingNode.depth,
        state: dispatchState
      });
      return;
    }

    // 1. Candidate parents are all nodes with children.length < maxChildren
    // Prioritize DJ and parents with bufferPct >= 100 so newcomers do not connect to starving peers
    const candidates = Array.from(this.masterTreeMap.values())
      .filter(n => n.peerId !== newcomerId && n.children.length < this.maxChildren)
      .sort((a, b) => {
        const aReady = (a.role === 'dj' || (a.bufferPct ?? 0) >= 100) ? 1 : 0;
        const bReady = (b.role === 'dj' || (b.bufferPct ?? 0) >= 100) ? 1 : 0;
        if (aReady !== bReady) return bReady - aReady;
        return a.depth - b.depth;
      });

    const assignedParent: PeerNodeInfo = candidates.length > 0
      ? candidates[0]
      : this.masterTreeMap.get(this.peerId)!;

    const parentId = assignedParent.peerId;
    const newcomerDepth = assignedParent.depth + 1;

    // Avoid duplicate insertions
    if (!assignedParent.children.includes(newcomerId)) {
      assignedParent.children.push(newcomerId);
    }

    this.masterTreeMap.set(newcomerId, {
      peerId: newcomerId,
      stationId: this.stationId,
      role: 'listener',
      parent: parentId,
      children: existingNode?.children || [],
      depth: newcomerDepth,
      lastHeartbeat: Date.now(),
      bufferPct: 0,
      transport
    });

    this.log(`[DJ Orchestrator] Placed ${newcomerId} under parent ${parentId} (Depth ${newcomerDepth}, ${transport.toUpperCase()})`);

    // 1. Broadcast updated master tree map first so assigned parents accept newcomer stream links immediately
    this.broadcastTreeTopology();

    // 2. Direct command to newcomer: "Connect to assigned parent"
    this.sendControlToListener(newcomerId, {
      type: 'dj_assignment',
      parentId,
      depth: newcomerDepth,
      state: dispatchState
    });
  }

  private buildCompactStateForDispatch(state: StationState): StationState {
    try {
      const rawLen = JSON.stringify(state).length;
      if (rawLen <= 700_000) return state;

      // Prioritize keeping complete manifests (cover art + chunkHashes) on active and upcoming tracks
      const priorityIds = new Set<string>();
      if (state.currentTrackId) priorityIds.add(state.currentTrackId);
      if (state.nextTrackId) priorityIds.add(state.nextTrackId);
      if (Array.isArray(state.playlistOrder) && state.playlistOrder.length > 0) {
        const curIdx = state.currentTrackId ? state.playlistOrder.indexOf(state.currentTrackId) : 0;
        for (let offset = 0; offset < Math.min(4, state.playlistOrder.length); offset++) {
          const idx = (Math.max(0, curIdx) + offset) % state.playlistOrder.length;
          priorityIds.add(state.playlistOrder[idx]);
        }
      }

      const trimmedManifests: Record<string, TrackManifest> = {};
      for (const [id, m] of Object.entries(state.trackManifests)) {
        if (priorityIds.has(id)) {
          trimmedManifests[id] = m;
        } else {
          const { coverDataUrl: _dropCover, ...withoutCover } = m;
          trimmedManifests[id] = withoutCover;
        }
      }

      let candidate: StationState = { ...state, trackManifests: trimmedManifests };
      if (JSON.stringify(candidate).length <= 850_000) return candidate;

      const tightManifests: Record<string, TrackManifest> = {};
      for (const [id, m] of Object.entries(trimmedManifests)) {
        if (priorityIds.has(id)) {
          tightManifests[id] = m;
        } else {
          const { chunkHashes: _dropHashes, ...minimal } = m;
          tightManifests[id] = minimal;
        }
      }
      candidate = { ...state, trackManifests: tightManifests };
      return candidate;
    } catch {
      return state;
    }
  }

  private canSendControlViaWebRTC(payload: any): boolean {
    if (!this.relayConnected) return true;
    try {
      return JSON.stringify(payload).length <= 32768;
    } catch {
      return false;
    }
  }

  private sendControlToListener(listenerId: string, payload: Record<string, unknown>) {
    this.enqueueSignedDjDispatch((signedPayload) => {
      const conn = this.allListenerConns.get(listenerId);
      if (conn && conn.open && this.canSendControlViaWebRTC(signedPayload)) {
        try {
          conn.send(signedPayload);
          return;
        } catch {}
      }
      if (this.sendViaRelay(listenerId, signedPayload)) {
        return;
      }
      if (conn && conn.open) {
        try { conn.send(signedPayload); } catch {}
      }
    }, payload);
  }

  // DJ Self-Healing: Re-balance when any peer drops out
  private handleListenerDeparted(droppedPeerId: string) {
    const droppedNode = this.masterTreeMap.get(droppedPeerId);
    if (!droppedNode) return;

    this.log(`[DJ Orchestrator] Node ${droppedPeerId} signed off/disconnected. Re-stitching pyramid...`);

    // 1. Remove from parent's children list
    if (droppedNode.parent) {
      const parentNode = this.masterTreeMap.get(droppedNode.parent);
      if (parentNode) {
        parentNode.children = parentNode.children.filter(id => id !== droppedPeerId);
      }
    }

    // 2. Collect orphans of the departed node and purge any partial Co-DJ uploads owned by it
    const orphans = [...droppedNode.children];
    this.masterTreeMap.delete(droppedPeerId);
    this.relayChildrenIds.delete(droppedPeerId);
    this.childrenIds.delete(droppedPeerId);
    this.authorizedInjectors.delete(droppedPeerId);
    this.injectFailCounts.delete(droppedPeerId);
    for (const [trackId, senderId] of this.authorizedTrackSenders.entries()) {
      if (senderId === droppedPeerId) {
        this.clearPendingInjectTrack(trackId);
      }
    }
    this.onPeerDeparted?.(droppedPeerId);

    // 3. Immediately re-assign orphans to optimal new parents via shallowest BFS
    for (const orphanId of orphans) {
      const orphanNode = this.masterTreeMap.get(orphanId);
      if (orphanNode) {
        orphanNode.parent = null;
        this.assignNewcomerToPyramid(orphanId, orphanNode.transport || 'relay');
      }
    }

    this.broadcastTreeTopology();
  }

  // --- 6. Listener Handling of DJ Directives ---

  private sanitizeIncomingState(rawState: any): StationState | null {
    if (!rawState || typeof rawState !== 'object') return null;
    if (typeof rawState.stationId !== 'string' || rawState.stationId.toLowerCase().trim() !== this.stationId) {
      return null;
    }
    const cleanManifests: Record<string, TrackManifest> = {};
    if (rawState.trackManifests && typeof rawState.trackManifests === 'object') {
      for (const [key, val] of Object.entries(rawState.trackManifests)) {
        const sanitized = sanitizeTrackManifest(val);
        if (sanitized && sanitized.trackId === key) {
          cleanManifests[key] = sanitized;
        }
      }
    }
    const playlistOrder = Array.isArray(rawState.playlistOrder)
      ? rawState.playlistOrder.filter((id: unknown): id is string => typeof id === 'string' && Boolean(cleanManifests[id]))
      : [];
    const currentTrackId = typeof rawState.currentTrackId === 'string' && cleanManifests[rawState.currentTrackId]
      ? rawState.currentTrackId
      : null;
    const nextTrackId = typeof rawState.nextTrackId === 'string' && cleanManifests[rawState.nextTrackId]
      ? rawState.nextTrackId
      : null;

    return {
      ...rawState,
      stationId: this.stationId,
      djPeerId: `station-${this.stationId}-dj`,
      currentTrackId,
      nextTrackId,
      trackManifests: cleanManifests,
      playlistOrder
    };
  }

  private async verifyDjEnvelope(data: any): Promise<boolean> {
    const hasSubtle = typeof crypto !== 'undefined' && Boolean(crypto.subtle);
    const requireCrypto = typeof window !== 'undefined' && window.isSecureContext && hasSubtle;

    if (!hasSubtle) return true;
    if (!data?.djPubJwk || typeof data?.djSig !== 'string') {
      return !requireCrypto && !this.pinnedDjVerifyKey;
    }

    try {
      const jwk = data.djPubJwk as JsonWebKey;
      if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
        return false;
      }
      const canonicalJwk = stableStringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
      if (!this.pinnedDjVerifyKey) {
        this.pinnedDjVerifyKey = await crypto.subtle.importKey(
          'jwk',
          { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
          { name: 'ECDSA', namedCurve: 'P-256' },
          false,
          ['verify']
        );
        this.pinnedDjJwkCanonical = canonicalJwk;
      } else if (canonicalJwk !== this.pinnedDjJwkCanonical) {
        return false;
      }

      const canonicalPayload = stableStringify(extractSignablePayload(data));
      const encodedPayload = new TextEncoder().encode(canonicalPayload);
      const sigBytes = base64ToBytes(data.djSig);
      return await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        this.pinnedDjVerifyKey,
        sigBytes as BufferSource,
        encodedPayload
      );
    } catch (err) {
      console.warn('[P2P Mesh] DJ envelope verification error:', err);
      return false;
    }
  }

  private handleDJControlMessage(data: any) {
    if (!data || typeof data !== 'object') return;

    if (data.type === 'dj_station_closed') {
      this.log('The DJ has closed the broadcast station.');
      return;
    }

    this.listenerVerifyQueue = this.listenerVerifyQueue.then(async () => {
      const valid = await this.verifyDjEnvelope(data);
      if (!valid) {
        console.warn('[P2P Mesh] Rejected unverified DJ control directive:', data.type);
        return;
      }
      this.applyVerifiedDJControlMessage(data);
    });
  }

  private applyVerifiedDJControlMessage(data: any) {
    if (data.type === 'dj_assignment') {
      this.hasJoinedPyramid = true;
      clearInterval(this.joinRetryTimer);
      this.joinRetryTimer = null;
      const { parentId, depth, state } = data;
      if (typeof parentId !== 'string' || typeof depth !== 'number') return;
      this.depth = depth;
      this.assignedParentId = parentId;

      if (state) {
        const cleanState = this.sanitizeIncomingState(state);
        if (cleanState) {
          this.stationState = cleanState;
          if (this.onStationStateUpdate) this.onStationStateUpdate(cleanState);
        }
      }

      // Connect to assigned parent
      this.connectToAssignedParent(parentId, depth);

      // Verify Co-DJ injection secret if present in URL hash
      if (this.listenerInjectToken) {
        this.sendControlToDJ({ type: 'verify_inject', token: this.listenerInjectToken });
      }
    } else if (data.type === 'inject_authorized') {
      const authorized = Boolean(data.authorized);
      if (!authorized) {
        this.listenerInjectToken = '';
      }
      this.onInjectAuthorized?.(authorized);
    } else if (data.type === 'inject_track_complete') {
      if (typeof data.trackId === 'string') {
        this.onInjectTrackComplete?.(data.trackId);
      }
    } else if (data.type === 'master_tree_update') {
      if (Array.isArray(data.tree)) {
        this.masterTreeMap = new Map(data.tree);
        this.notifyTreeChange();
        if (!this.isDJ && this.hasJoinedPyramid && !this.masterTreeMap.has(this.peerId)) {
          this.hasJoinedPyramid = false;
          if (this.djControlConn && this.djControlConn.open) {
            this.djControlConn.send({
              type: 'request_join_pyramid',
              peerId: this.peerId,
              stationId: this.stationId,
              viaRelay: false
            });
          } else {
            this.activateRelayControlFallback();
          }
        }
      }
    } else if (data.type === 'station_state') {
      const cleanState = this.sanitizeIncomingState(data.state);
      if (cleanState) {
        this.stationState = cleanState;
        if (this.onStationStateUpdate) this.onStationStateUpdate(cleanState);
      }
    } else if (data.type === 'playback_sync') {
      const rawSync = data.sync as Partial<PlaybackSyncReport> | undefined;
      if (
        !rawSync ||
        typeof rawSync !== 'object' ||
        typeof rawSync.trackId !== 'string' ||
        !TRACK_ID_RE.test(rawSync.trackId) ||
        typeof rawSync.djPosition !== 'number' ||
        !Number.isFinite(rawSync.djPosition) ||
        rawSync.djPosition < 0 ||
        typeof rawSync.djDuration !== 'number' ||
        !Number.isFinite(rawSync.djDuration) ||
        rawSync.djDuration < 0 ||
        typeof rawSync.sentAt !== 'number' ||
        !Number.isFinite(rawSync.sentAt) ||
        rawSync.sentAt <= 0 ||
        typeof rawSync.isPlaying !== 'boolean'
      ) {
        return;
      }
      if (rawSync.sentAt <= this.lastAppliedSyncSentAt) return;
      this.lastAppliedSyncSentAt = rawSync.sentAt;
      const report: PlaybackSyncReport = {
        trackId: rawSync.trackId,
        djPosition: rawSync.djPosition,
        djDuration: rawSync.djDuration,
        sentAt: rawSync.sentAt,
        isPlaying: rawSync.isPlaying
      };
      this.onPlaybackSync?.(report);
      this.forwardPlaybackSyncToChildren(data);
    }
  }

  private connectToAssignedParent(parentId: string, depth: number) {
    if (this.currentParentId === parentId && (this.parentDataConn?.open || this.usingRelayForParentStream)) {
      return;
    }

    this.log(`Connecting to assigned parent: ${parentId} (Depth ${depth})...`);
    if (this.parentDataConn) {
      try { this.parentDataConn.close(); } catch {}
      this.parentDataConn = null;
    }
    this.usingRelayForParentStream = false;
    this.missedParentPings = 0;
    this.chunksReceivedSinceParentConnect = 0;
    this.parentConnectedTime = Date.now();
    this.lastChunkReceivedAt = Date.now();

    // If we already know direct WebRTC failed for control or relay is connected,
    // start WebRTC attempt in parallel with a fast 1.5s fallback to Universal Relay!
    let streamConnected = false;

    const activateRelayStream = () => {
      if (streamConnected || this.usingRelayForParentStream) return;
      if (!this.relayConnected) return;
      streamConnected = true;
      this.usingRelayForParentStream = true;
      this.currentParentId = parentId;
      this.missedParentPings = 0;
      this.chunksReceivedSinceParentConnect = 0;
      this.parentConnectedTime = Date.now();
      this.lastChunkReceivedAt = Date.now();

      const reqTrackId = this.pendingTrackChunkRequest?.trackId || this.stationState?.currentTrackId || 'current';
      const missingIndexes = this.pendingTrackChunkRequest?.missingIndexes;
      this.pendingTrackChunkRequest = null;

      if (parentId === `station-${this.stationId}-dj`) {
        this.log(`⚡ Audio stream pipeline connected with DJ ${parentId} (Universal Relay)!`);
        this.sendViaRelay(parentId, { type: 'request_audio_chunks', trackId: reqTrackId, missingIndexes, from: this.peerId });
      } else {
        this.sendViaRelay(parentId, { type: 'request_relay_stream', from: this.peerId });
        this.sendViaRelay(parentId, { type: 'request_audio_chunks', trackId: reqTrackId, missingIndexes, from: this.peerId });
      }
    };

    // If control channel needed the relay (e.g. mobile 4G/5G Symmetric NAT), bridge stream immediately!
    if (this.usingRelayForControl && this.relayConnected) {
      activateRelayStream();
    }

    const fallbackTimer = setTimeout(() => {
      if (!streamConnected && this.relayConnected) {
        activateRelayStream();
      }
    }, 1800);

    if (this.peer && !this.peer.destroyed) {
      const conn = this.peer.connect(parentId, {
        metadata: { role: 'stream_channel' }
      });

      let streamRetryScheduled = false;
      const handleStreamFailure = () => {
        if (this.relayConnected) {
          activateRelayStream();
          return;
        }
        if (streamConnected || streamRetryScheduled) return;
        streamRetryScheduled = true;
        clearTimeout(fallbackTimer);
        clearTimeout(streamTimeout);
        try { conn.close(); } catch {}
        this.parentDataConn = null;
        this.currentParentId = null;
        this.log(`⚠️ Direct P2P stream with ${parentId} failed/timed out. Retrying...`);
        setTimeout(() => this.connectToAssignedParent(parentId, depth), 2000);
      };

      const streamTimeout = setTimeout(() => {
        if (!streamConnected && !this.usingRelayForParentStream && !this.relayConnected) {
          handleStreamFailure();
        }
      }, 10000);

      this.attachPCDiagnostics(conn, parentId, 'StreamChannel', () => {
        handleStreamFailure();
      });

      conn.on('open', () => {
        streamConnected = true;
        clearTimeout(fallbackTimer);
        clearTimeout(streamTimeout);
        this.usingRelayForParentStream = false;
        this.log(`⚡ Direct P2P audio stream pipeline connected with parent ${parentId}!`);
        this.parentDataConn = conn;
        this.currentParentId = parentId;
        this.missedParentPings = 0;
        this.chunksReceivedSinceParentConnect = 0;
        this.parentConnectedTime = Date.now();
        this.lastChunkReceivedAt = Date.now();

        const reqTrackId = this.pendingTrackChunkRequest?.trackId || this.stationState?.currentTrackId || 'current';
        const missingIndexes = this.pendingTrackChunkRequest?.missingIndexes;
        this.pendingTrackChunkRequest = null;

        // Request stream chunks
        conn.send({ type: 'request_audio_chunks', trackId: reqTrackId, missingIndexes, from: this.peerId });
      });

      conn.on('data', (data) => {
        this.handleStreamData(data, parentId);
      });

      conn.on('error', () => {
        handleStreamFailure();
      });

      conn.on('close', () => {
        clearTimeout(fallbackTimer);
        clearTimeout(streamTimeout);
        this.parentDataConn = null;
        if (!this.usingRelayForParentStream && !streamRetryScheduled) {
          if (this.relayConnected) {
            activateRelayStream();
          } else {
            this.log(`Stream connection to parent ${parentId} closed.`);
            this.currentParentId = null;
            this.reportDeadParent(parentId);
          }
        }
      });
    } else {
      activateRelayStream();
    }
  }

  private reportDeadParent(deadParentId: string) {
    const msg = {
      type: 'parent_unresponsive',
      peerId: this.peerId,
      deadParentId
    };
    if (this.djControlConn && this.djControlConn.open) {
      this.log(`Reporting unresponsive parent ${deadParentId} to DJ...`);
      this.djControlConn.send(msg);
    } else if (this.relayConnected) {
      this.log(`Reporting unresponsive parent ${deadParentId} to DJ via Relay...`);
      this.sendViaRelay(`station-${this.stationId}-dj`, msg);
    }
  }

  // --- 8. Tree-Delegated Heartbeat (Child <-> Parent only) ---

  private startTreeDelegatedHeartbeat() {
    clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = setInterval(() => {
      if (this.isDJ) return;

      const pingMsg = {
        type: 'link_ping',
        from: this.peerId,
        bufferPct: this.currentBufferPct
      };

      if (this.parentDataConn && this.parentDataConn.open) {
        try {
          this.parentDataConn.send(pingMsg);
        } catch {}
        this.checkMissedPings();
      } else if (this.usingRelayForParentStream && this.currentParentId && this.relayConnected) {
        this.sendViaRelay(this.currentParentId, pingMsg);
        this.checkMissedPings();
      }

      // Keep DJ pruner & UI progress fresh even when placed at Depth >= 2 under another listener
      const djPeerId = `station-${this.stationId}-dj`;
      if (this.currentParentId && this.currentParentId !== djPeerId) {
        const djHeartbeat = {
          type: 'buffer_update',
          peerId: this.peerId,
          bufferPct: this.currentBufferPct
        };
        if (this.djControlConn && this.djControlConn.open) {
          try { this.djControlConn.send(djHeartbeat); } catch {}
        } else if (this.relayConnected) {
          this.sendViaRelay(djPeerId, djHeartbeat);
        }
      }

      // Buffer stall watchdog:
      // If connected to parent, buffer not complete, and 0 chunks received after grace period
      if (this.currentParentId && this.currentBufferPct < 100 && this.chunksReceivedSinceParentConnect === 0 && this.parentConnectedTime > 0) {
        const elapsed = Date.now() - this.parentConnectedTime;
        if (!this.usingRelayForParentStream && this.relayConnected && elapsed > 3000) {
          this.log(`⚠️ WebRTC stream from ${this.currentParentId} stalled (0 chunks in ${Math.round(elapsed / 1000)}s). Switching stream to Universal Relay...`);
          this.usingRelayForParentStream = true;
          this.parentConnectedTime = Date.now();
          if (this.parentDataConn) {
            try { this.parentDataConn.close(); } catch {}
            this.parentDataConn = null;
          }
          const trackId = this.stationState?.currentTrackId || 'current';
          if (this.currentParentId !== djPeerId) {
            this.sendViaRelay(this.currentParentId, { type: 'request_relay_stream', from: this.peerId });
            this.sendViaRelay(this.currentParentId, { type: 'request_audio_chunks', trackId, from: this.peerId, forceRelay: true });
          }
          this.sendViaRelay(djPeerId, { type: 'request_audio_chunks', trackId, from: this.peerId, forceRelay: true });
          if (this.stationState?.nextTrackId && this.stationState.nextTrackId !== trackId) {
            this.sendViaRelay(djPeerId, { type: 'request_audio_chunks', trackId: this.stationState.nextTrackId, from: this.peerId, forceRelay: true });
          }
        } else if (elapsed > 6500) {
          this.log(`🚨 Buffer stall watchdog: Parent ${this.currentParentId} delivered 0 chunks in ${Math.round(elapsed/1000)}s! Reporting dead parent.`);
          const deadId = this.currentParentId;
          this.currentParentId = null;
          this.usingRelayForParentStream = false;
          this.reportDeadParent(deadId);
        } else if (elapsed > 3500 && this.relayConnected && this.currentParentId !== djPeerId) {
          this.log(`⚠️ Buffer stall watchdog: Parent ${this.currentParentId} delivered 0 chunks in ${Math.round(elapsed/1000)}s. Requesting direct stream from DJ via Relay...`);
          this.sendViaRelay(djPeerId, {
            type: 'request_audio_chunks',
            trackId: this.stationState?.currentTrackId || 'current',
            from: this.peerId
          });
        }
      }

      // Torrent-style Swarm Fallback:
      // If buffer is incomplete and either initial chunks haven't arrived or mid-track delivery stalled,
      // pull missing chunk ranges in parallel from buffered (100%) listener seeders.
      if (!this.isDJ && this.currentParentId && this.currentBufferPct < 100) {
        const now = Date.now();
        const initialStall = this.chunksReceivedSinceParentConnect === 0 && this.parentConnectedTime > 0 && (now - this.parentConnectedTime > 3000);
        const midTrackStall = this.lastChunkReceivedAt > 0 && (now - this.lastChunkReceivedAt > 3500);
        if (initialStall || midTrackStall) {
          this.triggerSwarmFallback();
        }
      }
    }, 2500);
  }

  private triggerSwarmFallback() {
    const now = Date.now();
    if (now - this.lastSwarmPullAt < 4000) return;

    const missing = this.onGetMissingChunks?.();
    if (!missing || missing.missingIndexes.length === 0) return;

    const djPeerId = `station-${this.stationId}-dj`;
    const seeders: string[] = [];
    for (const node of this.masterTreeMap.values()) {
      if (node.peerId !== this.peerId && node.role === 'listener' && (node.bufferPct ?? 0) >= 100) {
        seeders.push(node.peerId);
        if (seeders.length >= 3) break;
      }
    }

    if (seeders.length === 0) {
      if (this.currentParentId !== djPeerId || (this.lastChunkReceivedAt > 0 && now - this.lastChunkReceivedAt > 3500)) {
        seeders.push(djPeerId);
      } else {
        return;
      }
    }

    this.lastSwarmPullAt = now;
    const batch = missing.missingIndexes.slice(0, 48);
    for (const idx of batch) {
      this.seenChunks.delete(`${missing.trackId}:${idx}`);
    }

    const buckets: number[][] = seeders.map(() => []);
    for (let i = 0; i < batch.length; i++) {
      buckets[i % seeders.length].push(batch[i]);
    }

    this.log(`🐝 Swarm fallback: pulling ${batch.length} missing chunks from ${seeders.length} seeder(s) (${seeders.join(', ')})`);

    seeders.forEach((seederId, idx) => {
      const slice = buckets[idx];
      if (!slice || slice.length === 0) return;

      const req = {
        type: 'request_audio_chunks',
        trackId: missing.trackId,
        missingIndexes: slice,
        from: this.peerId
      };

      const existing = this.swarmConns.get(seederId);
      if (existing && existing.open) {
        try {
          existing.send(req);
          return;
        } catch {}
      }

      if (this.peer && !this.peer.destroyed && !existing) {
        try {
          const swarmConn = this.peer.connect(seederId, {
            reliable: true,
            metadata: { role: 'swarm_channel' }
          });
          this.swarmConns.set(seederId, swarmConn);

          swarmConn.on('open', () => {
            try { swarmConn.send(req); } catch {}
          });
          swarmConn.on('data', (data: any) => {
            this.handleStreamData(data, seederId);
          });
          const cleanup = () => {
            if (this.swarmConns.get(seederId) === swarmConn) {
              this.swarmConns.delete(seederId);
            }
          };
          swarmConn.on('close', cleanup);
          swarmConn.on('error', cleanup);
        } catch {}
      }

      if (this.relayConnected) {
        this.sendViaRelay(seederId, req);
      }
    });
  }

  private checkMissedPings() {
    this.missedParentPings++;
    if (this.missedParentPings >= 4) {
      this.log(`⚠️ Parent ${this.currentParentId} missed link pings. Requesting failover from DJ...`);
      if (this.currentParentId) {
        const deadId = this.currentParentId;
        this.currentParentId = null;
        this.usingRelayForParentStream = false;
        this.reportDeadParent(deadId);
      }
      this.missedParentPings = 0;
    }
  }

  // DJ pruner loop
  private startDJPruner() {
    clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = setInterval(() => {
      if (!this.isDJ) return;
      const now = Date.now();
      for (const [id, node] of this.masterTreeMap.entries()) {
        if (id !== this.peerId) {
          const conn = this.allListenerConns.get(id);
          const isWebRtcOpen = conn && conn.open;
          // Prune if neither WebRTC is open nor a heartbeat received within 15s
          if (!isWebRtcOpen && (now - node.lastHeartbeat > 15000)) {
            this.handleListenerDeparted(id);
          }
        }
      }
      this.cleanupStaleInjects();
    }, 3500);
  }

  // DJ periodic corrective sync beacon (every 25s down to direct connected children)
  private startPlaybackSyncLoop() {
    clearInterval(this.playbackSyncInterval);
    this.playbackSyncInterval = setInterval(() => {
      if (!this.isDJ || this.isDestroyed) return;
      const report = this.onGetPlaybackSyncState?.();
      if (!report || !report.isPlaying || !report.trackId) return;
      this.enqueueSignedDjDispatch((signedMsg) => {
        this.forwardPlaybackSyncToChildren(signedMsg);
      }, {
        type: 'playback_sync',
        sync: report
      });
    }, 25_000);
  }

  private forwardPlaybackSyncToChildren(signedMsg: Record<string, unknown>) {
    if (this.isDestroyed) return;
    const delivered = new Set<string>();

    for (const [peerId, conn] of this.childDataConns) {
      if (conn.open) {
        try {
          conn.send(signedMsg);
          delivered.add(peerId);
        } catch {}
      }
    }
    for (const relayChildId of this.relayChildrenIds) {
      if (delivered.has(relayChildId)) continue;
      if (this.sendViaRelay(relayChildId, signedMsg)) {
        delivered.add(relayChildId);
      }
    }
    if (this.isDJ) {
      for (const node of this.masterTreeMap.values()) {
        if (node.parent === this.peerId && !delivered.has(node.peerId)) {
          const ctrlConn = this.allListenerConns.get(node.peerId);
          if (ctrlConn?.open) {
            try {
              ctrlConn.send(signedMsg);
              delivered.add(node.peerId);
              continue;
            } catch {}
          }
          this.sendViaRelay(node.peerId, signedMsg);
        }
      }
    }
  }

  // --- 9. Stream Data & Binary Audio Chunks ---

  private dropWebRtcChildStream(peerId: string) {
    const staleConn = this.childDataConns.get(peerId);
    if (staleConn) {
      this.childDataConns.delete(peerId);
      try { staleConn.close(); } catch {}
    }
    this.sendQueues.delete(peerId);
    this.isDraining.delete(peerId);
  }

  private handleStreamData(data: any, fromPeerId: string) {
    // 1. Binary chunk handling
    if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
      const buffer = (data instanceof Uint8Array
        ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        : data) as ArrayBuffer;
      void this.handleBinaryChunk(buffer, fromPeerId);
      return;
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      data.arrayBuffer().then((buffer) => this.handleBinaryChunk(buffer, fromPeerId)).catch(() => {});
      return;
    }

    // 2. Control/Heartbeat message handling over Stream Channel
    if (typeof data === 'object' && data !== null) {
      if (data.type === 'request_audio_chunks') {
        const isKnownPeer =
          this.childrenIds.has(fromPeerId) ||
          this.childDataConns.has(fromPeerId) ||
          this.relayChildrenIds.has(fromPeerId) ||
          (fromPeerId !== this.peerId && this.masterTreeMap.has(fromPeerId));
        if (!isKnownPeer) return;

        const reqTrackId = typeof data.trackId === 'string' && (data.trackId === 'current' || TRACK_ID_RE.test(data.trackId))
          ? data.trackId
          : 'current';
        let safeMissing: number[] | undefined;
        if (Array.isArray(data.missingIndexes)) {
          const seen = new Set<number>();
          safeMissing = [];
          for (const rawIdx of data.missingIndexes) {
            if (typeof rawIdx === 'number' && Number.isInteger(rawIdx) && rawIdx >= 0 && rawIdx < 2560 && !seen.has(rawIdx)) {
              seen.add(rawIdx);
              safeMissing.push(rawIdx);
              if (safeMissing.length >= 2560) break;
            }
          }
        }
        this.log(`Child ${fromPeerId} requested audio chunks (track: ${reqTrackId})`);
        if (this.onRequestTrackChunks) {
          this.onRequestTrackChunks(fromPeerId, reqTrackId, safeMissing);
        }
      } else if (data.type === 'link_ping') {
        if (this.isDJ) {
          const node = this.masterTreeMap.get(fromPeerId);
          if (node) {
            node.lastHeartbeat = Date.now();
            if (typeof data.bufferPct === 'number' && Number.isFinite(data.bufferPct)) {
              node.bufferPct = Math.max(0, Math.min(100, Math.round(data.bufferPct)));
            }
          }
        }
        // Reply with link_pong over WebRTC or Relay
        const childConn = this.childDataConns.get(fromPeerId);
        if (childConn && childConn.open) {
          childConn.send({ type: 'link_pong', from: this.peerId });
        } else if (this.relayChildrenIds.has(fromPeerId)) {
          this.sendViaRelay(fromPeerId, { type: 'link_pong', from: this.peerId });
        }
      } else if (data.type === 'link_pong') {
        // Parent replied! Reset missed pings
        this.missedParentPings = 0;
      } else if (data.type === 'playback_sync') {
        if (this.isDJ) return;
        const djPeerId = `station-${this.stationId}-dj`;
        const expectedParent = this.currentParentId || this.assignedParentId || djPeerId;
        if (fromPeerId !== djPeerId && fromPeerId !== expectedParent) return;
        this.handleDJControlMessage(data);
      } else if (data.type === 'child_departing') {
        if (typeof data.childPeerId === 'string' && data.childPeerId !== fromPeerId) return;
        if (!this.childrenIds.has(fromPeerId) && !this.childDataConns.has(fromPeerId) && !this.relayChildrenIds.has(fromPeerId)) {
          return;
        }
        this.log(`Child ${fromPeerId} gracefully departed`);
        this.childDataConns.delete(fromPeerId);
        this.relayChildrenIds.delete(fromPeerId);
        this.childrenIds.delete(fromPeerId);
      }
    }
  }

  // Per-peer transmission queue to ensure ZERO chunks are dropped due to WebRTC buffer overflow
  private sendQueues: Map<string, ArrayBuffer[]> = new Map();
  private isDraining: Map<string, boolean> = new Map();
  private trackIdBytesCache: Map<string, Uint8Array> = new Map();
  private peerIdBytesCache: Map<string, Uint8Array> = new Map();

  private getPadded32Bytes(str: string, cache: Map<string, Uint8Array>): Uint8Array {
    let cached = cache.get(str);
    if (!cached) {
      cached = new TextEncoder().encode(str.padEnd(32, ' ')).slice(0, 32);
      if (cache.size > 200) cache.clear();
      cache.set(str, cached);
    }
    return cached;
  }

  public getPeerBufferedAmount(peerId: string): number {
    let total = 0;
    const q = this.sendQueues.get(peerId);
    if (q && q.length > 0) {
      for (let i = 0; i < q.length; i++) {
        total += q[i].byteLength;
      }
    }
    const conn = this.childDataConns.get(peerId) || this.swarmConns.get(peerId);
    if (conn) {
      const dc = (conn as any).dataChannel as RTCDataChannel | undefined;
      if (dc) {
        total += dc.bufferedAmount;
      }
    }
    if (this.relayConnected && this.relayWs) {
      if (this.relayChildrenIds.has(peerId) || !conn?.open) {
        total += this.relayWs.bufferedAmount;
      }
    }
    return total;
  }

  public isPeerActive(peerId: string): boolean {
    if (this.childDataConns.get(peerId)?.open) return true;
    if (this.swarmConns.get(peerId)?.open) return true;
    if (this.relayChildrenIds.has(peerId)) return true;
    return this.masterTreeMap.has(peerId);
  }

  public shouldThrottleBroadcast(maxBytes: number): boolean {
    let activeCount = 0;
    let backedUpCount = 0;
    for (const [peerId, conn] of this.childDataConns) {
      if (!conn.open) continue;
      activeCount++;
      if (this.getPeerBufferedAmount(peerId) > maxBytes) backedUpCount++;
    }
    for (const relayChildId of this.relayChildrenIds) {
      if (this.childDataConns.get(relayChildId)?.open) continue;
      activeCount++;
      if (this.getPeerBufferedAmount(relayChildId) > maxBytes) backedUpCount++;
    }
    return activeCount > 0 && backedUpCount === activeCount;
  }

  public getMaxChildrenBufferedAmount(): number {
    let max = 0;
    for (const peerId of this.childDataConns.keys()) {
      const b = this.getPeerBufferedAmount(peerId);
      if (b > max) max = b;
    }
    for (const relayChildId of this.relayChildrenIds) {
      const b = this.getPeerBufferedAmount(relayChildId);
      if (b > max) max = b;
    }
    return max;
  }

  public broadcastChunk(trackId: string, chunkIndex: number, totalChunks: number, rawData: ArrayBuffer) {
    const chunkKey = `${trackId}:${chunkIndex}`;
    this.seenChunks.add(chunkKey);
    if (this.seenChunks.size > 2000) {
      const iter = this.seenChunks.values();
      for (let i = 0; i < 500; i++) {
        const next = iter.next();
        if (next.done) break;
        this.seenChunks.delete(next.value);
      }
    }

    const packet = this.encodeChunkPacket(trackId, chunkIndex, totalChunks, rawData);
    this.relayBinaryToChildren(packet);
  }

  public sendChunkToPeer(peerId: string, trackId: string, chunkIndex: number, totalChunks: number, rawData: ArrayBuffer) {
    const packet = this.encodeChunkPacket(trackId, chunkIndex, totalChunks, rawData);
    const conn = this.childDataConns.get(peerId) || this.swarmConns.get(peerId);
    if (conn && conn.open) {
      this.enqueuePacketToPeer(peerId, conn, packet);
    } else if (this.relayConnected) {
      this.sendBinaryViaRelay(peerId, packet);
    }
  }

  public requestMissingTrackChunks(trackId: string, missingIndexes?: number[]) {
    if (missingIndexes && missingIndexes.length > 0) {
      for (const idx of missingIndexes) {
        this.seenChunks.delete(`${trackId}:${idx}`);
      }
    } else {
      const prefix = `${trackId}:`;
      for (const key of this.seenChunks) {
        if (key.startsWith(prefix)) this.seenChunks.delete(key);
      }
    }

    const req = {
      type: 'request_audio_chunks',
      trackId,
      missingIndexes,
      from: this.peerId
    };
    if (this.parentDataConn && this.parentDataConn.open) {
      this.log(`Requesting missing chunks for track ${trackId} (${missingIndexes ? missingIndexes.length + ' chunks' : 'all'}) from parent ${this.currentParentId}`);
      this.parentDataConn.send(req);
    } else if (this.usingRelayForParentStream && this.currentParentId && this.relayConnected) {
      this.log(`Requesting missing chunks for track ${trackId} via Universal Relay from ${this.currentParentId}`);
      this.sendViaRelay(this.currentParentId, req);
    } else {
      this.log(`Parent connection not open yet; queuing request for track ${trackId}`);
      this.pendingTrackChunkRequest = { trackId, missingIndexes };
    }

    // If current parent is not the DJ, also request directly from the DJ via Relay as safety fallback
    const djPeerId = `station-${this.stationId}-dj`;
    if (this.currentParentId && this.currentParentId !== djPeerId && this.relayConnected) {
      this.sendViaRelay(djPeerId, req);
    }
  }

  private encodeChunkPacket(trackId: string, chunkIndex: number, totalChunks: number, rawData: ArrayBuffer): ArrayBuffer {
    const trackIdBytes = this.getPadded32Bytes(trackId, this.trackIdBytesCache);
    const packet = new Uint8Array(32 + 4 + 4 + rawData.byteLength);

    packet.set(trackIdBytes, 0);
    const view = new DataView(packet.buffer);
    view.setUint32(32, chunkIndex, false);
    view.setUint32(36, totalChunks, false);
    packet.set(new Uint8Array(rawData), 40);

    return packet.buffer;
  }

  private async handleBinaryChunk(data: ArrayBuffer, fromPeerId = '') {
    if (data.byteLength < 40 || data.byteLength > 96 * 1024) return;
    const view = new DataView(data);
    const trackId = new TextDecoder().decode(new Uint8Array(data, 0, 32)).trim();
    if (!TRACK_ID_RE.test(trackId)) return;
    const chunkIndex = view.getUint32(32, false);
    const totalChunks = view.getUint32(36, false);

    if (this.isDJ) {
      if (!fromPeerId || !this.authorizedInjectors.has(fromPeerId)) return;
      if (this.authorizedTrackSenders.get(trackId) !== fromPeerId) return;
      const injectManifest = this.pendingInjectManifests.get(trackId);
      if (!injectManifest || totalChunks !== injectManifest.totalChunks || chunkIndex >= injectManifest.totalChunks) {
        return;
      }
      const audioData = data.slice(40);
      if (injectManifest.chunkHashes && typeof crypto !== 'undefined' && crypto.subtle) {
        const expected = injectManifest.chunkHashes[chunkIndex];
        if (!expected) return;
        const actual = await sha256Base64(audioData);
        if (actual !== expected) {
          console.warn(`[CO-DJ] Dropped tampered chunk ${trackId}:${chunkIndex} from ${fromPeerId}`);
          return;
        }
      }
      this.injectLastActivityAt.set(trackId, Date.now());
      this.onInjectedChunkReceived?.(trackId, chunkIndex, totalChunks, audioData);
      return;
    }

    // Ensure any queued station_state verification settles before checking manifest hashes
    await this.listenerVerifyQueue;

    const manifest = this.stationState?.trackManifests?.[trackId];
    if (!manifest || totalChunks !== manifest.totalChunks || chunkIndex >= manifest.totalChunks) {
      return;
    }

    const chunkKey = `${trackId}:${chunkIndex}`;

    // Deduplication check: drop duplicate chunks to prevent feedback storms and CPU saturation
    if (this.seenChunks.has(chunkKey) || this.inFlightChunkKeys.has(chunkKey)) {
      return;
    }

    this.inFlightChunkKeys.add(chunkKey);
    const audioData = data.slice(40);
    try {
      if (manifest.chunkHashes && typeof crypto !== 'undefined' && crypto.subtle) {
        const expectedHash = manifest.chunkHashes[chunkIndex];
        if (!expectedHash) return;
        const actualHash = await sha256Base64(audioData);
        if (actualHash !== expectedHash) {
          console.warn(`[P2P Mesh] Dropped corrupted/forged chunk ${chunkKey} (SHA-256 mismatch)`);
          return;
        }
      }

      if (this.seenChunks.has(chunkKey)) {
        return;
      }

      // Track chunk reception metrics for buffer stall watchdog
      this.chunksReceivedSinceParentConnect++;
      this.lastChunkReceivedAt = Date.now();

      const accepted = this.onChunkReceived
        ? this.onChunkReceived(trackId, chunkIndex, totalChunks, audioData) !== false
        : true;

      if (!accepted) return;

      this.seenChunks.add(chunkKey);

      if (this.seenChunks.size > 2000) {
        const iter = this.seenChunks.values();
        for (let i = 0; i < 500; i++) {
          const next = iter.next();
          if (next.done) break;
          this.seenChunks.delete(next.value);
        }
      }

      // Forward down to assigned children in the pyramid
      this.relayBinaryToChildren(data);
    } finally {
      this.inFlightChunkKeys.delete(chunkKey);
    }
  }

  private relayBinaryToChildren(data: ArrayBuffer) {
    // 1. Send to direct WebRTC children
    for (const [peerId, conn] of this.childDataConns) {
      if (conn.open) {
        this.enqueuePacketToPeer(peerId, conn, data);
      }
    }
    // 2. Send to Universal Relay children
    for (const relayChildId of this.relayChildrenIds) {
      if (!this.childDataConns.get(relayChildId)?.open) {
        this.sendBinaryViaRelay(relayChildId, data);
      }
    }
  }

  private enqueuePacketToPeer(peerId: string, conn: DataConnection, packet: ArrayBuffer) {
    if (!this.sendQueues.has(peerId)) {
      this.sendQueues.set(peerId, []);
    }
    const queue = this.sendQueues.get(peerId)!;
    // Cap per-peer backlog (~3MB) so a stalled child does not cause unbounded RAM growth
    if (queue.length >= 64) {
      this.drainQueue(peerId, conn);
      return;
    }
    queue.push(packet);
    this.drainQueue(peerId, conn);
  }

  private drainQueue(peerId: string, conn: DataConnection) {
    if (this.isDraining.get(peerId)) return;
    this.isDraining.set(peerId, true);

    const step = () => {
      const queue = this.sendQueues.get(peerId);
      if (!queue || queue.length === 0 || !conn.open) {
        this.isDraining.set(peerId, false);
        return;
      }

      const dc = (conn as any).dataChannel as RTCDataChannel | undefined;
      const MAX_BUFFERED = 512 * 1024;
      while (queue.length > 0 && (!dc || dc.bufferedAmount < MAX_BUFFERED)) {
        const pkt = queue.shift()!;
        try {
          conn.send(pkt);
        } catch (e) {
          console.warn(`[P2P Mesh] Failed to send packet to ${peerId}:`, e);
          break;
        }
      }

      if (queue.length > 0) {
        if (dc && 'bufferedAmountLowThreshold' in dc) {
          dc.bufferedAmountLowThreshold = 128 * 1024;
          let timer: any = null;
          const onLow = () => {
            clearTimeout(timer);
            dc.removeEventListener('bufferedamountlow', onLow);
            step();
          };
          dc.addEventListener('bufferedamountlow', onLow);
          timer = setTimeout(() => {
            dc.removeEventListener('bufferedamountlow', onLow);
            step();
          }, 50);
        } else {
          setTimeout(step, 20);
        }
      } else {
        this.isDraining.set(peerId, false);
      }
    };

    step();
  }

  // --- 10. Master Tree Synchronization & State Updates ---

  private broadcastControl(msg: Record<string, unknown>) {
    this.enqueueSignedDjDispatch((signedMsg) => {
      const relayOk = this.sendViaRelay('*', signedMsg);
      if (!relayOk || this.canSendControlViaWebRTC(signedMsg)) {
        for (const conn of this.allListenerConns.values()) {
          if (conn.open) {
            try { conn.send(signedMsg); } catch {}
          }
        }
      }
    }, msg);
  }

  public updateStationState(partialState: Partial<StationState>) {
    if (!this.isDJ || !this.stationState) return;
    this.stationState = { ...this.stationState, ...partialState };
    this.broadcastControl({
      type: 'station_state',
      state: this.buildCompactStateForDispatch(this.stationState)
    });
  }

  private broadcastTreeTopology() {
    this.notifyTreeChange();
    const treeSnapshot = Array.from(this.masterTreeMap.entries(), ([id, node]) => [
      id,
      { ...node, children: [...node.children] }
    ]);
    this.broadcastControl({
      type: 'master_tree_update',
      tree: treeSnapshot
    });
  }

  private notifyTreeChange() {
    if (this.onTreeUpdated) {
      this.onTreeUpdated(Array.from(this.masterTreeMap.values()));
    }
  }

  private log(msg: string) {
    console.log(`[P2P Mesh] ${msg}`);
    if (this.onStatusMessage) this.onStatusMessage(msg);
  }

  public destroy() {
    this.isDestroyed = true;
    this.signOff();
    clearInterval(this.heartbeatInterval);
    clearInterval(this.playbackSyncInterval);
    clearInterval(this.relayPingInterval);
    clearInterval(this.joinRetryTimer);
    clearTimeout(this.relayReconnectTimer);
    clearTimeout(this.relayStabilityTimer);
    this.detachRelaySocket(this.relayWs);
    this.relayWs = null;
    this.relayConnected = false;
    this.stationId = '';
    this.djControlConn?.close();
    this.parentDataConn?.close();
    for (const conn of this.allListenerConns.values()) conn.close();
    for (const conn of this.childDataConns.values()) conn.close();
    for (const conn of this.swarmConns.values()) conn.close();
    this.allListenerConns.clear();
    this.childDataConns.clear();
    this.swarmConns.clear();
    this.relayChildrenIds.clear();
    this.peer?.destroy();
  }
}
