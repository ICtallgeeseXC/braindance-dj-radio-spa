import { DurableObject } from 'cloudflare:workers';

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  P2P_RELAY: DurableObjectNamespace<P2PRelayDO>;
}

interface PeerAttachment {
  peerId: string;
  stationId: string;
  role: 'dj' | 'listener';
  hostToken?: string;
  isPublic?: boolean;
  trackTitle?: string;
}

interface DirectoryEntry {
  stationId: string;
  listeners: number;
  trackTitle?: string;
  updatedAt: number;
}

const textDecoder = new TextDecoder();
const DIRECTORY_TTL_MS = 120_000;

export class P2PRelayDO extends DurableObject<Env> {
  private getStationMetrics(stationId: string): { listeners: number; djMeta: PeerAttachment | null } {
    let listeners = 0;
    let djMeta: PeerAttachment | null = null;
    for (const ws of this.ctx.getWebSockets()) {
      const meta = ws.deserializeAttachment() as PeerAttachment | null;
      if (!meta || meta.stationId !== stationId) continue;
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
    if (!stationId || stationId === '__directory__') return;
    try {
      const dirId = this.env.P2P_RELAY.idFromName('__directory__');
      await this.env.P2P_RELAY.get(dirId).fetch(`https://relay.internal/__p2p_relay/directory/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      const data = (await request.json().catch(() => null)) as DirectoryEntry | null;
      if (data?.stationId) {
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
      const data = (await request.json().catch(() => null)) as { stationId?: string } | null;
      if (data?.stationId) {
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
        if (!meta || (station && meta.stationId !== station)) continue;
        if (meta.role === 'dj') live = true;
        else listeners++;
      }
      return Response.json({ live, stationId: station, listeners });
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      if (typeof message !== 'string') {
        const bytes = message instanceof ArrayBuffer
          ? new Uint8Array(message)
          : new Uint8Array((message as ArrayBufferView).buffer, (message as ArrayBufferView).byteOffset, (message as ArrayBufferView).byteLength);
        if (bytes.byteLength < 64) return;

        const targetPeerId = textDecoder.decode(bytes.subarray(0, 32)).trim();
        const sender = ws.deserializeAttachment() as PeerAttachment | null;

        if (targetPeerId === '*') {
          if (!sender?.stationId) return;
          for (const other of this.ctx.getWebSockets()) {
            if (other === ws) continue;
            const meta = other.deserializeAttachment() as PeerAttachment | null;
            if (meta?.stationId === sender.stationId) {
              try { other.send(bytes); } catch {}
            }
          }
        } else {
          for (const other of this.ctx.getWebSockets()) {
            const meta = other.deserializeAttachment() as PeerAttachment | null;
            if (meta?.peerId === targetPeerId) {
              try { other.send(bytes); } catch {}
              break;
            }
          }
        }
        return;
      }

      const msg = JSON.parse(message);

      if (msg.type === 'register') {
        const peerId = String(msg.peerId || '').trim();
        const stationId = String(msg.stationId || '').toLowerCase().trim();
        const role: 'dj' | 'listener' = msg.role === 'dj' ? 'dj' : 'listener';
        const hostToken = typeof msg.hostToken === 'string' ? msg.hostToken.trim() : '';
        if (!peerId || !stationId) return;

        // Prevent hijacking: reject a different DJ trying to claim an already-live station
        const djPeerId = `station-${stationId}-dj`;
        const isIncomingDj = role === 'dj' || peerId === djPeerId;
        if (isIncomingDj) {
          for (const other of this.ctx.getWebSockets()) {
            if (other === ws) continue;
            const meta = other.deserializeAttachment() as PeerAttachment | null;
            if (!meta) continue;
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
        }

        // Clear any previous socket registered for the same peerId before attaching this one
        for (const other of this.ctx.getWebSockets()) {
          if (other === ws) continue;
          const meta = other.deserializeAttachment() as PeerAttachment | null;
          if (meta?.peerId === peerId) {
            other.serializeAttachment(null);
            try { other.close(1000, 'replaced'); } catch {}
          }
        }

        const isPublic = isIncomingDj ? Boolean(msg.isPublic) : undefined;
        const trackTitle = isIncomingDj && typeof msg.trackTitle === 'string' ? msg.trackTitle.trim().slice(0, 120) : undefined;

        ws.serializeAttachment({
          peerId,
          stationId,
          role,
          ...(hostToken ? { hostToken } : {}),
          ...(isIncomingDj ? { isPublic, trackTitle } : {})
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
        const targetPeerId = String(msg.to || '').trim();
        const fromPeerId = sender?.peerId || String(msg.from || '').trim();

        if (targetPeerId === '*') {
          if (!sender?.stationId) return;
          const out = JSON.stringify({ ...msg, from: fromPeerId });
          for (const other of this.ctx.getWebSockets()) {
            const meta = other.deserializeAttachment() as PeerAttachment | null;
            if (meta?.stationId === sender.stationId && meta.peerId !== fromPeerId) {
              try { other.send(out); } catch {}
            }
          }
        } else {
          let delivered = false;
          for (const other of this.ctx.getWebSockets()) {
            const meta = other.deserializeAttachment() as PeerAttachment | null;
            if (meta?.peerId === targetPeerId) {
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
        if (sender?.role === 'dj' && sender.isPublic) {
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
    if (url.pathname === '/__p2p_relay/stations') {
      const id = env.P2P_RELAY.idFromName('__directory__');
      return env.P2P_RELAY.get(id).fetch(request);
    }
    if (url.pathname.startsWith('/__p2p_relay')) {
      const station = (url.searchParams.get('station') || 'global').toLowerCase().trim() || 'global';
      const id = env.P2P_RELAY.idFromName(station);
      return env.P2P_RELAY.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};
