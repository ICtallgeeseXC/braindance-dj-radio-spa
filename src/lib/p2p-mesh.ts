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
import type { TrackManifest } from './chunk-pipeline';

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

  private isPublicBroadcast = true;

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
    isPublic = true
  ) {
    const cleanStationId = stationId.toLowerCase().trim();
    this.stationId = cleanStationId;
    this.isDJ = true;
    this.isPublicBroadcast = isPublic;
    this.depth = 0;
    this.currentParentId = null;
    this.hostToken = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);

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

  // --- 2. Listener Mode: Join Station ---

  public joinStation(stationId: string) {
    this.stationId = stationId.toLowerCase().trim();
    this.isDJ = false;
    this.hasJoinedPyramid = false;

    const listenerId = 'peer_' + Math.random().toString(36).substring(2, 9);
    this.peerId = listenerId;

    this.initRelaySocket();
    this.initPeer(listenerId);
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

  private initRelaySocket() {
    if (typeof window === 'undefined') return;
    if (this.relayWs) {
      try { this.relayWs.close(); } catch {}
      this.relayWs = null;
    }
    clearTimeout(this.relayReconnectTimer);
    clearInterval(this.relayPingInterval);

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const stationParam = this.stationId ? `?station=${encodeURIComponent(this.stationId)}` : '';
    const wsUrl = `${proto}//${window.location.host}/__p2p_relay${stationParam}`;

    try {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      this.relayWs = ws;

      ws.onopen = () => {
        this.relayConnected = true;
        this.relayEverConnected = true;
        this.relayFailures = 0;
        this.log(`[RELAY] Universal Tunnel Relay online (NAT/Firewall bypass ready)`);
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
              if (!this.hasJoinedPyramid && !this.djControlConn?.open) {
                this.activateRelayControlFallback();
              }
            }, 1800);
          }
        }
      };

      ws.onmessage = (evt) => {
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
        this.relayConnected = false;
        clearInterval(this.relayPingInterval);
        this.relayFailures++;
        if (this.relayEverConnected || this.relayFailures < 2) {
          this.relayReconnectTimer = setTimeout(() => {
            if (this.stationId) this.initRelaySocket();
          }, 2500);
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
    const chunkPacket = frameBuffer.slice(64);
    this.handleBinaryChunk(chunkPacket);
  }

  private handleRelayControlFrame(msg: any) {
    if (msg.type === 'register_rejected') {
      const rejectedStation = msg.stationId || this.stationId || '';
      this.log(`🚨 Station "${rejectedStation}" is already hosted by another DJ! Connection rejected.`);
      this.relayFailures = 999;
      this.relayEverConnected = false;
      clearTimeout(this.relayReconnectTimer);
      this.onStationConflict?.(rejectedStation);
      return;
    }

    if (msg.type === 'relay_dj_disconnected' && !this.isDJ) {
      this.log(`🚨 DJ disconnected from station "${msg.stationId}".`);
      this.hasJoinedPyramid = false;
      this.currentParentId = null;
      this.usingRelayForParentStream = false;
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
    const fromId = msg.from;
    const data = msg.payload;

    if (this.isDJ) {
      // DJ receiving control or stream requests from a listener over the relay
      if (
        data.type === 'request_join_pyramid' ||
        data.type === 'buffer_update' ||
        data.type === 'graceful_departure' ||
        data.type === 'parent_unresponsive'
      ) {
        this.handleListenerRequestToDJ(fromId, data);
      } else {
        if (data.forceRelay) {
          this.dropWebRtcChildStream(fromId);
        }
        // Stream channel messages (e.g. request_audio_chunks, link_ping, child_departing)
        // Only register as a relay child if the DJ topology actually assigned this peer as our direct child.
        const node = this.masterTreeMap.get(fromId);
        if (node) {
          node.lastHeartbeat = Date.now();
          if (node.parent === this.peerId) {
            this.relayChildrenIds.add(fromId);
            this.childrenIds.add(fromId);
          }
        }
        this.handleStreamData(data, fromId);
      }
    } else {
      // Listener receiving control directives from DJ or stream messages from parent/child
      if (
        data.type === 'dj_assignment' ||
        data.type === 'master_tree_update' ||
        data.type === 'station_state' ||
        data.type === 'dj_station_closed'
      ) {
        this.handleDJControlMessage(data);
      } else if (data.type === 'relay_stream_ready') {
        // Parent confirmed stream bridge over relay!
        if (!this.parentDataConn || !this.parentDataConn.open) {
          this.usingRelayForParentStream = true;
          this.currentParentId = fromId;
          this.missedParentPings = 0;
          this.log(`⚡ Audio stream pipeline bridged with parent ${fromId} (Universal Relay)!`);
          this.sendViaRelay(fromId, { type: 'request_audio_chunks', from: this.peerId });
        }
      } else if (data.type === 'request_relay_stream') {
        // A child is connecting to us over the Universal Relay
        this.dropWebRtcChildStream(fromId);
        this.relayChildrenIds.add(fromId);
        this.childrenIds.add(fromId);
        this.log(`Data stream bridged with child ${fromId} (Universal Relay)`);
        this.sendViaRelay(fromId, { type: 'relay_stream_ready', from: this.peerId });
      } else {
        if (data.forceRelay) {
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

  private handleIncomingConnection(conn: DataConnection) {
    const remoteId = conn.peer;

    conn.on('open', () => {
      const role = conn.metadata?.role;
      const isControl = role === 'control_channel';
      const isSwarm = role === 'swarm_channel';

      if (this.isDJ && isControl) {
        this.allListenerConns.set(remoteId, conn);
        const node = this.masterTreeMap.get(remoteId);
        if (node) node.transport = 'webrtc';
        this.log(`Listener ${remoteId} connected via direct WebRTC`);
      } else if (isSwarm) {
        this.swarmConns.set(remoteId, conn);
        this.log(`Swarm channel connected with ${remoteId}`);
      } else {
        // Stream Data Channel (Audio chunks & link heartbeats)
        this.log(`Direct P2P stream connected with ${remoteId}`);
        this.childDataConns.set(remoteId, conn);
        this.relayChildrenIds.delete(remoteId); // Upgrade from relay if direct succeeded
        this.childrenIds.add(remoteId);
      }
    });

    conn.on('data', (data: any) => {
      const role = conn.metadata?.role;
      if (this.isDJ && role === 'control_channel') {
        this.handleListenerRequestToDJ(remoteId, data);
      } else if (role === 'swarm_channel') {
        if (!this.swarmConns.has(remoteId)) {
          this.swarmConns.set(remoteId, conn);
        }
        this.handleStreamData(data, remoteId);
      } else {
        // Ensure child is registered in childDataConns immediately even if 'open' event was delayed
        if (!this.childDataConns.has(remoteId)) {
          this.childDataConns.set(remoteId, conn);
          this.relayChildrenIds.delete(remoteId);
          this.childrenIds.add(remoteId);
        }
        this.handleStreamData(data, remoteId);
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
    if (data.type === 'request_join_pyramid') {
      const isRelay = !!data.viaRelay && (!this.allListenerConns.get(newcomerId)?.open);
      this.assignNewcomerToPyramid(newcomerId, isRelay ? 'relay' : 'webrtc');
    } else if (data.type === 'buffer_update') {
      const node = this.masterTreeMap.get(newcomerId);
      if (node) {
        const prevPct = node.bufferPct ?? 0;
        node.lastHeartbeat = Date.now();
        if (typeof data.bufferPct === 'number') {
          node.bufferPct = data.bufferPct;
          if (data.bufferPct >= 100 && prevPct < 100) {
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
      this.log(`[DJ Orchestrator] Peer ${newcomerId} reported parent ${data.deadParentId} unresponsive! Re-assigning...`);
      if (data.deadParentId && data.deadParentId !== this.peerId) {
        this.handleListenerDeparted(data.deadParentId);
      } else {
        const existing = this.masterTreeMap.get(newcomerId);
        this.assignNewcomerToPyramid(newcomerId, existing?.transport || 'relay');
      }
    }
  }

  // Pure binary tree placement: pick shallowest node with capacity (< maxChildren)
  private assignNewcomerToPyramid(newcomerId: string, transport: 'webrtc' | 'relay' = 'webrtc') {
    // If newcomer is already placed in the pyramid, just re-send their assignment and state!
    const existingNode = this.masterTreeMap.get(newcomerId);
    if (existingNode && existingNode.parent && this.masterTreeMap.has(existingNode.parent)) {
      existingNode.lastHeartbeat = Date.now();
      existingNode.transport = transport;
      this.sendControlToListener(newcomerId, {
        type: 'dj_assignment',
        parentId: existingNode.parent,
        depth: existingNode.depth,
        state: this.stationState
      });
      this.broadcastTreeTopology();
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

    // 1. Direct command to newcomer: "Connect to assigned parent"
    this.sendControlToListener(newcomerId, {
      type: 'dj_assignment',
      parentId,
      depth: newcomerDepth,
      state: this.stationState
    });

    // 2. Broadcast updated master tree map to all listeners so visualizer & peer state stay synced
    this.broadcastTreeTopology();
  }

  private canSendControlViaWebRTC(payload: any): boolean {
    if (!this.relayConnected) return true;
    try {
      return JSON.stringify(payload).length <= 32768;
    } catch {
      return false;
    }
  }

  private sendControlToListener(listenerId: string, payload: any) {
    const conn = this.allListenerConns.get(listenerId);
    if (conn && conn.open && this.canSendControlViaWebRTC(payload)) {
      try {
        conn.send(payload);
        return;
      } catch {}
    }
    this.sendViaRelay(listenerId, payload);
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

    // 2. Collect orphans of the departed node
    const orphans = [...droppedNode.children];
    this.masterTreeMap.delete(droppedPeerId);
    this.relayChildrenIds.delete(droppedPeerId);
    this.childrenIds.delete(droppedPeerId);

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

  private handleDJControlMessage(data: any) {
    if (data.type === 'dj_assignment') {
      this.hasJoinedPyramid = true;
      clearInterval(this.joinRetryTimer);
      this.joinRetryTimer = null;
      const { parentId, depth, state } = data;
      this.depth = depth;

      if (state) {
        this.stationState = state;
        if (this.onStationStateUpdate) this.onStationStateUpdate(state);
      }

      // Connect to assigned parent
      this.connectToAssignedParent(parentId, depth);
    } else if (data.type === 'master_tree_update') {
      if (data.tree) {
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
      this.stationState = data.state;
      if (this.onStationStateUpdate) this.onStationStateUpdate(data.state);
    } else if (data.type === 'dj_station_closed') {
      this.log('The DJ has closed the broadcast station.');
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
    }, 3500);
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
      this.handleBinaryChunk(buffer);
      return;
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      data.arrayBuffer().then((buffer) => this.handleBinaryChunk(buffer)).catch(() => {});
      return;
    }

    // 2. Control/Heartbeat message handling over Stream Channel
    if (typeof data === 'object' && data !== null) {
      if (data.type === 'request_audio_chunks') {
        const reqTrackId = data.trackId || 'current';
        this.log(`Child ${fromPeerId} requested audio chunks (track: ${reqTrackId})`);
        if (this.onRequestTrackChunks) {
          this.onRequestTrackChunks(fromPeerId, reqTrackId, data.missingIndexes);
        }
      } else if (data.type === 'link_ping') {
        if (this.isDJ) {
          const node = this.masterTreeMap.get(fromPeerId);
          if (node) {
            node.lastHeartbeat = Date.now();
            if (typeof data.bufferPct === 'number') node.bufferPct = data.bufferPct;
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
      } else if (data.type === 'child_departing') {
        this.log(`Child ${data.childPeerId} gracefully departed`);
        this.childDataConns.delete(data.childPeerId);
        this.relayChildrenIds.delete(data.childPeerId);
        this.childrenIds.delete(data.childPeerId);
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

  private handleBinaryChunk(data: ArrayBuffer) {
    if (data.byteLength < 40) return;
    const view = new DataView(data);
    const trackId = new TextDecoder().decode(new Uint8Array(data, 0, 32)).trim();
    const chunkIndex = view.getUint32(32, false);
    const totalChunks = view.getUint32(36, false);

    // Track chunk reception metrics for buffer stall watchdog
    this.chunksReceivedSinceParentConnect++;
    this.lastChunkReceivedAt = Date.now();

    const chunkKey = `${trackId}:${chunkIndex}`;

    // Deduplication check: drop duplicate chunks to prevent feedback storms and CPU saturation
    if (this.seenChunks.has(chunkKey)) {
      return;
    }

    const audioData = data.slice(40);
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

  private broadcastControl(msg: any) {
    if (this.canSendControlViaWebRTC(msg)) {
      for (const conn of this.allListenerConns.values()) {
        if (conn.open) {
          try { conn.send(msg); } catch {}
        }
      }
    }
    this.sendViaRelay('*', msg);
  }

  public updateStationState(partialState: Partial<StationState>) {
    if (!this.isDJ || !this.stationState) return;
    this.stationState = { ...this.stationState, ...partialState };
    this.broadcastControl({
      type: 'station_state',
      state: this.stationState
    });
  }

  private broadcastTreeTopology() {
    this.notifyTreeChange();
    this.broadcastControl({
      type: 'master_tree_update',
      tree: Array.from(this.masterTreeMap.entries())
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
    this.signOff();
    clearInterval(this.heartbeatInterval);
    clearInterval(this.relayPingInterval);
    clearInterval(this.joinRetryTimer);
    clearTimeout(this.relayReconnectTimer);
    try { this.relayWs?.close(); } catch {}
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
