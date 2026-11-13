import { DurableObject } from 'cloudflare:workers';

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  P2P_RELAY: DurableObjectNamespace<P2PRelayDO>;
}

interface PeerAttachment {
  peerId?: string;
  stationId?: string;
  pendingStationId?: string;
  role?: 'dj' | 'listener';
  hostToken?: string;
  isPublic?: boolean;
  trackTitle?: string;
}

interface DjGraceRecord {
  hostToken: string;
  expiresAt: number;
}

interface DirectoryEntry {
  stationId: string;
  listeners: number;
  trackTitle?: string;
  updatedAt: number;
}

interface SocketRateState {
  textCount: number;
  textResetAt: number;
  binCount: number;
  binResetAt: number;
}

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const DIRECTORY_TTL_MS = 120_000;
const DJ_GRACE_MS = 25_000;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_BYTES = 256 * 1024;
const MAX_TEXT_MSGS_PER_SEC = 200;
const MAX_BINARY_MSGS_PER_SEC = 600;
const STATION_ID_RE = /^[a-z0-9_-]{1,36}$/;
const LISTENER_PEER_ID_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const RESERVED_STATIONS = new Set(['__directory__', 'global']);

function encodePadded32(str: string): Uint8Array {
  return textEncoder.encode(str.padEnd(32, ' ')).slice(0, 32);
}

export class P2PRelayDO extends DurableObject<Env> {
  private rateLimits = new WeakMap<WebSocket, SocketRateState>();

  private consumeRateLimit(ws: WebSocket, isBinary: boolean): boolean {
    const now = Date.now();
    let state = this.rateLimits.get(ws);
    if (!state) {
      state = {
        textCount: 0,
        textResetAt: now + 1000,
        binCount: 0,
        binResetAt: now + 1000
      };
      this.rateLimits.set(ws, state);
    }
    if (isBinary) {
      if (now >= state.binResetAt) {
        state.binCount = 0;
        state.binResetAt = now + 1000;
      }
      state.binCount++;
      return state.binCount <= MAX_BINARY_MSGS_PER_SEC;
    }
    if (now >= state.textResetAt) {
      state.textCount = 0;
      state.textResetAt = now + 1000;
    }
    state.textCount++;
    return state.textCount <= MAX_TEXT_MSGS_PER_SEC;
  }

  private getStationMetrics(stationId: string): { listeners: number; djMeta: PeerAttachment | null } {
    let listeners = 0;
    let djMeta: PeerAttachment | null = null;
    for (const ws of this.ctx.getWebSockets()) {
      const meta = ws.deserializeAttachment() as PeerAttachment | null;
      if (!meta?.peerId || meta.stationId !== stationId) continue;
      if (meta.role === 'dj') djMeta = meta;
      else listeners++;
    }
    return { listeners, djMeta };
  }

  private async syncDirectory(
    action: 'upsert' | 'remove',
    stationId: string,
    listeners = 0,
    trackTitle?: string
  ): Promise<void> {
    if (!stationId || RESERVED_STATIONS.has(stationId)) return;
    try {
      const dirId = this.env.P2P_RELAY.idFromName('__directory__');
      await this.env.P2P_RELAY.get(dirId).fetch(`https://relay.internal/__p2p_relay/directory/${action}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Relay-Internal': '1'
        },
        body: JSON.stringify({
          stationId,
          listeners,
          trackTitle: trackTitle || undefined,
          updatedAt: Date.now()
        })
      });
    } catch {}
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/__p2p_relay/directory/upsert' && request.method === 'POST') {
      if (url.hostname !== 'relay.internal' || request.headers.get('X-Relay-Internal') !== '1') {
        return new Response('Forbidden', { status: 403 });
      }
      const data = (await request.json().catch(() => null)) as DirectoryEntry | null;
      if (data?.stationId && STATION_ID_RE.test(data.stationId) && !RESERVED_STATIONS.has(data.stationId)) {
        await this.ctx.storage.put(`station:${data.stationId}`, {
          stationId: data.stationId,
          listeners: Math.max(0, Number(data.listeners) || 0),
          trackTitle: data.trackTitle ? String(data.trackTitle).slice(0, 120) : undefined,
          updatedAt: Date.now()
        } satisfies DirectoryEntry);
      }
      return Response.json({ ok: true });
    }

    if (url.pathname === '/__p2p_relay/directory/remove' && request.method === 'POST') {
      if (url.hostname !== 'relay.internal' || request.headers.get('X-Relay-Internal') !== '1') {
        return new Response('Forbidden', { status: 403 });
      }
      const data = (await request.json().catch(() => null)) as { stationId?: string } | null;
      if (data?.stationId && STATION_ID_RE.test(data.stationId)) {
        await this.ctx.storage.delete(`station:${data.stationId}`);
      }
      return Response.json({ ok: true });
    }

    if (url.pathname === '/__p2p_relay/stations' && request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      const now = Date.now();
      const entries = await this.ctx.storage.list<DirectoryEntry>({ prefix: 'station:' });
      const active: DirectoryEntry[] = [];
      const staleKeys: string[] = [];
      for (const [key, entry] of entries) {
        if (!entry || now - entry.updatedAt > DIRECTORY_TTL_MS) {
          staleKeys.push(key);
        } else {
          active.push(entry);
        }
      }
      if (staleKeys.length > 0) {
        await this.ctx.storage.delete(staleKeys);
      }
      active.sort((a, b) => (b.listeners - a.listeners) || (b.updatedAt - a.updatedAt));
      return Response.json({ stations: active });
    }

    if (url.pathname === '/__p2p_relay/status' && request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      const station = (url.searchParams.get('station') || '').toLowerCase().trim();
      let live = false;
      let listeners = 0;
      for (const ws of this.ctx.getWebSockets()) {
        const meta = ws.deserializeAttachment() as PeerAttachment | null;
        if (!meta?.peerId || (station && meta.stationId !== station)) continue;
        if (meta.role === 'dj') live = true;
        else listeners++;
      }
      return Response.json({ live, stationId: station, listeners });
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const boundStation = (url.searchParams.get('station') || '').toLowerCase().trim();
    if (boundStation && RESERVED_STATIONS.has(boundStation)) {
      return new Response('Forbidden', { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    if (boundStation && STATION_ID_RE.test(boundStation)) {
      server.serializeAttachment({ pendingStationId: boundStation } satisfies PeerAttachment);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      if (typeof message !== 'string') {
        if (!this.consumeRateLimit(ws, true)) {
          try { ws.close(4029, 'rate_limited'); } catch {}
          return;
        }
        const rawBytes = message instanceof ArrayBuffer
          ? new Uint8Array(message)
          : new Uint8Array((message as ArrayBufferView).buffer, (message as ArrayBufferView).byteOffset, (message as ArrayBufferView).byteLength);
        if (rawBytes.byteLength < 64 || rawBytes.byteLength > MAX_BINARY_BYTES) return;

        const sender = ws.deserializeAttachment() as PeerAttachment | null;
        if (!sender?.peerId || !sender?.stationId) return;

        // Overwrite sender identity bytes [32..63] with the server-authenticated peerId
        const bytes = new Uint8Array(rawBytes);
        bytes.set(encodePadded32(sender.peerId), 32);

        const targetPeerId = textDecoder.decode(bytes.subarray(0, 32)).trim();
        if (!targetPeerId) return;

        if (targetPeerId === '*') {
          for (const other of this.ctx.getWebSockets()) {
            if (other === ws) continue;
            const meta = other.deserializeAttachment() as PeerAttachment | null;
            if (meta?.peerId && meta.stationId === sender.stationId) {
              try { other.send(bytes); } catch {}
            }
          }
        } else {
          for (const other of this.ctx.getWebSockets()) {
            const meta = other.deserializeAttachment() as PeerAttachment | null;
            if (meta?.peerId === targetPeerId && meta.stationId === sender.stationId) {
              try { other.send(bytes); } catch {}
              break;
            }
          }
        }
        return;
      }

      if (!this.consumeRateLimit(ws, false)) {
        try { ws.close(4029, 'rate_limited'); } catch {}
        return;
      }
      if (message.length > MAX_TEXT_BYTES) return;

      const msg = JSON.parse(message);

      if (msg.type === 'register') {
        const existingSelf = ws.deserializeAttachment() as PeerAttachment | null;
        const peerId = String(msg.peerId || '').trim();
        const stationId = String(msg.stationId || '').toLowerCase().trim();
        const role: 'dj' | 'listener' = msg.role === 'dj' ? 'dj' : 'listener';
        const hostToken = typeof msg.hostToken === 'string' ? msg.hostToken.trim() : '';

        if (!peerId || !stationId || !STATION_ID_RE.test(stationId) || RESERVED_STATIONS.has(stationId)) {
          try { ws.close(4008, 'invalid_station'); } catch {}
          return;
        }
        // Bind registration strictly to the WebSocket upgrade URL's ?station= parameter
        if (existingSelf?.pendingStationId && existingSelf.pendingStationId !== stationId) {
          try {
            ws.send(JSON.stringify({ type: 'register_rejected', reason: 'station_mismatch', stationId }));
            ws.close(4008, 'station_mismatch');
          } catch {}
          return;
        }
        // Prevent switching peerId/stationId on an already-registered socket
        if (existingSelf?.peerId && (existingSelf.peerId !== peerId || existingSelf.stationId !== stationId)) {
          try { ws.close(4008, 'reregister_forbidden'); } catch {}
          return;
        }

        const djPeerId = `station-${stationId}-dj`;
        const isIncomingDj = role === 'dj' || peerId === djPeerId;

        if (isIncomingDj) {
          if (peerId !== djPeerId || hostToken.length < 16) {
            try {
              ws.send(JSON.stringify({ type: 'register_rejected', reason: 'invalid_dj_credentials', stationId }));
              ws.close(4009, 'invalid_dj_credentials');
            } catch {}
            return;
          }

          // Reject if an active DJ socket exists with a different hostToken
          for (const other of this.ctx.getWebSockets()) {
            if (other === ws) continue;
            const meta = other.deserializeAttachment() as PeerAttachment | null;
            if (!meta?.peerId) continue;
            const isExistingDj = meta.stationId === stationId && (meta.role === 'dj' || meta.peerId === djPeerId);
            if (isExistingDj && (!hostToken || meta.hostToken !== hostToken)) {
              ws.serializeAttachment(null);
              try {
                ws.send(JSON.stringify({ type: 'register_rejected', reason: 'station_in_use', stationId }));
                ws.close(4009, 'station_in_use');
              } catch {}
              return;
            }
          }

          // Enforce DJ reconnect grace period to prevent hijacking during momentary network drops
          const grace = await this.ctx.storage.get<DjGraceRecord>('dj_grace');
          if (grace && Date.now() < grace.expiresAt && grace.hostToken !== hostToken) {
            ws.serializeAttachment(null);
            try {
              ws.send(JSON.stringify({ type: 'register_rejected', reason: 'station_in_use', stationId }));
              ws.close(4009, 'station_in_use');
            } catch {}
            return;
          }
          if (grace) {
            await this.ctx.storage.delete('dj_grace');
          }

          // Replace only same-hostToken previous DJ socket if reconnecting
          for (const other of this.ctx.getWebSockets()) {
            if (other === ws) continue;
            const meta = other.deserializeAttachment() as PeerAttachment | null;
            if (meta?.peerId === peerId && meta.hostToken === hostToken) {
              other.serializeAttachment(null);
              try { other.close(1000, 'replaced'); } catch {}
            }
          }
        } else {
          // Validate listener peerId format & forbid impersonating any DJ id
          if (!LISTENER_PEER_ID_RE.test(peerId) || peerId.startsWith('station-') || peerId.endsWith('-dj')) {
            try {
              ws.send(JSON.stringify({ type: 'register_rejected', reason: 'invalid_peer_id', stationId }));
              ws.close(4008, 'invalid_peer_id');
            } catch {}
            return;
          }
          // Reject duplicate listener peerIds instead of kicking the existing peer
          for (const other of this.ctx.getWebSockets()) {
            if (other === ws) continue;
            const meta = other.deserializeAttachment() as PeerAttachment | null;
            if (meta?.peerId === peerId) {
              ws.serializeAttachment(null);
              try {
                ws.send(JSON.stringify({ type: 'register_rejected', reason: 'peer_id_in_use', stationId }));
                ws.close(4009, 'peer_id_in_use');
              } catch {}
              return;
            }
          }
        }

        const isPublic = isIncomingDj ? Boolean(msg.isPublic) : undefined;
        const trackTitle = isIncomingDj && typeof msg.trackTitle === 'string' ? msg.trackTitle.trim().slice(0, 120) : undefined;

        ws.serializeAttachment({
          peerId,
          stationId,
          role: isIncomingDj ? 'dj' : 'listener',
          ...(isIncomingDj ? { hostToken, isPublic, trackTitle } : {})
        } satisfies PeerAttachment);
        ws.send(JSON.stringify({ type: 'registered', peerId, stationId }));

        const { listeners, djMeta } = this.getStationMetrics(stationId);
        if (isIncomingDj) {
          await this.syncDirectory(isPublic ? 'upsert' : 'remove', stationId, listeners, trackTitle);
        } else if (djMeta?.isPublic) {
          await this.syncDirectory('upsert', stationId, listeners, djMeta.trackTitle);
        }
      } else if (msg.type === 'signal' || msg.type === 'relay_control') {
        const sender = ws.deserializeAttachment() as PeerAttachment | null;
        if (!sender?.peerId || !sender?.stationId) return;
        const targetPeerId = String(msg.to || '').trim();
        if (!targetPeerId) return;
        const fromPeerId = sender.peerId;

        if (targetPeerId === '*') {
          const out = JSON.stringify({ ...msg, from: fromPeerId });
          for (const other of this.ctx.getWebSockets()) {
            const meta = other.deserializeAttachment() as PeerAttachment | null;
            if (meta?.peerId && meta.stationId === sender.stationId && meta.peerId !== fromPeerId) {
              try { other.send(out); } catch {}
            }
          }
        } else {
          let delivered = false;
          for (const other of this.ctx.getWebSockets()) {
            const meta = other.deserializeAttachment() as PeerAttachment | null;
            if (meta?.peerId === targetPeerId && meta.stationId === sender.stationId) {
              try {
                other.send(JSON.stringify({ ...msg, from: fromPeerId }));
                delivered = true;
              } catch {}
              break;
            }
          }
          if (!delivered && msg.type === 'relay_control') {
            ws.send(JSON.stringify({ type: 'peer_unreachable', targetPeerId }));
          }
        }
      } else if (msg.type === 'ping') {
        const sender = ws.deserializeAttachment() as PeerAttachment | null;
        if (!sender?.peerId || !sender?.stationId) return;
        if (sender.role === 'dj' && sender.isPublic) {
          const nextTitle = typeof msg.trackTitle === 'string'
            ? msg.trackTitle.trim().slice(0, 120)
            : sender.trackTitle;
          if (nextTitle !== sender.trackTitle) {
            ws.serializeAttachment({ ...sender, trackTitle: nextTitle } satisfies PeerAttachment);
          }
          const { listeners } = this.getStationMetrics(sender.stationId);
          await this.syncDirectory('upsert', sender.stationId, listeners, nextTitle);
        }
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (err) {
      console.warn('[CF P2P Relay] Error handling message:', err);
    }
  }

  async webSocketClose(ws: WebSocket) {
    await this.cleanupSocket(ws);
  }

  async webSocketError(ws: WebSocket) {
    await this.cleanupSocket(ws);
  }

  private async cleanupSocket(ws: WebSocket) {
    const meta = ws.deserializeAttachment() as PeerAttachment | null;
    ws.serializeAttachment(null);
    if (!meta?.peerId || !meta?.stationId) return;

    const djPeerId = `station-${meta.stationId}-dj`;

    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      const otherMeta = other.deserializeAttachment() as PeerAttachment | null;
      if (otherMeta?.peerId === meta.peerId) return;
    }

    if (meta.peerId === djPeerId) {
      if (meta.hostToken) {
        await this.ctx.storage.put('dj_grace', {
          hostToken: meta.hostToken,
          expiresAt: Date.now() + DJ_GRACE_MS
        } satisfies DjGraceRecord);
      }
      if (meta.isPublic) {
        await this.syncDirectory('remove', meta.stationId);
      }
      const msg = JSON.stringify({ type: 'relay_dj_disconnected', stationId: meta.stationId });
      for (const other of this.ctx.getWebSockets()) {
        const otherMeta = other.deserializeAttachment() as PeerAttachment | null;
        if (otherMeta?.stationId === meta.stationId && otherMeta.peerId !== djPeerId) {
          try { other.send(msg); } catch {}
        }
      }
      return;
    }

    const { listeners, djMeta } = this.getStationMetrics(meta.stationId);
    if (djMeta?.isPublic) {
      await this.syncDirectory('upsert', meta.stationId, listeners, djMeta.trackTitle);
    }

    for (const other of this.ctx.getWebSockets()) {
      const otherMeta = other.deserializeAttachment() as PeerAttachment | null;
      if (otherMeta?.peerId === djPeerId) {
        try {
          other.send(JSON.stringify({
            type: 'relay_peer_disconnected',
            peerId: meta.peerId
          }));
        } catch {}
        break;
      }
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/__p2p_relay/directory/')) {
      return new Response('Forbidden', { status: 403 });
    }
    if (url.pathname === '/__p2p_relay/stations') {
      const id = env.P2P_RELAY.idFromName('__directory__');
      return env.P2P_RELAY.get(id).fetch(request);
    }
    if (url.pathname.startsWith('/__p2p_relay')) {
      const station = (url.searchParams.get('station') || 'global').toLowerCase().trim() || 'global';
      if (station === '__directory__') {
        return new Response('Forbidden', { status: 403 });
      }
      const id = env.P2P_RELAY.idFromName(station);
      return env.P2P_RELAY.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};
