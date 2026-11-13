// vite-relay-plugin.ts
// Pure zero-dependency RFC 6455 WebSocket P2P Relay Bridge embedded directly into the Vite server.
// Works seamlessly over any HTTP/HTTPS tunnel (localtunnel, cloudflared, ngrok, reverse proxy)
// without opening UDP ports or configuring TURN servers.

import type { Plugin } from 'vite';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { createHash } from 'node:crypto';

interface RelayConnection {
  socket: Duplex;
  isOpen: boolean;
  sendText: (text: string) => void;
  sendBinary: (buf: Buffer) => void;
}

interface RelayClient {
  peerId: string;
  stationId: string;
  role: 'dj' | 'listener';
  hostToken?: string;
  isPublic?: boolean;
  trackTitle?: string;
  conn: RelayConnection;
}

const DJ_GRACE_MS = 25_000;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_BYTES = 256 * 1024;
const MAX_TEXT_MSGS_PER_SEC = 200;
const MAX_BINARY_MSGS_PER_SEC = 600;
const STATION_ID_RE = /^[a-z0-9_-]{1,36}$/;
const LISTENER_PEER_ID_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const RESERVED_STATIONS = new Set(['__directory__', 'global']);

function encodePadded32Buf(str: string): Buffer {
  return Buffer.from(str.padEnd(32, ' '), 'utf8').subarray(0, 32);
}

function encodeWsFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.byteLength;
  let header: Buffer;

  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

function attachWebSocketHandler(
  socket: Duplex,
  onMessage: (payload: Buffer, isBinary: boolean) => void,
  onClose: () => void
): RelayConnection {
  let buffer = Buffer.alloc(0);
  let fragmentedChunks: Buffer[] = [];
  let fragmentedOpcode = 0;

  const conn: RelayConnection = {
    socket,
    isOpen: true,
    sendText(text: string) {
      if (!conn.isOpen || socket.destroyed) return;
      try {
        socket.write(encodeWsFrame(0x01, Buffer.from(text, 'utf8')));
      } catch {}
    },
    sendBinary(buf: Buffer) {
      if (!conn.isOpen || socket.destroyed) return;
      try {
        socket.write(encodeWsFrame(0x02, buf));
      } catch {}
    }
  };

  const cleanup = () => {
    if (!conn.isOpen) return;
    conn.isOpen = false;
    onClose();
  };

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 2) {
      const firstByte = buffer[0];
      const secondByte = buffer[1];
      const fin = (firstByte & 0x80) !== 0;
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) return;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        payloadLen = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = isMasked ? 4 : 0;
      if (buffer.length < offset + maskLen + payloadLen) {
        return; // Wait for full frame
      }

      let payload = buffer.subarray(offset + maskLen, offset + maskLen + payloadLen);
      if (isMasked) {
        const maskKey = buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
          unmasked[i] = payload[i] ^ maskKey[i & 3];
        }
        payload = unmasked;
      }

      buffer = buffer.subarray(offset + maskLen + payloadLen);

      if (opcode === 0x08) {
        // Close frame
        try {
          socket.write(encodeWsFrame(0x08, Buffer.alloc(0)));
          socket.end();
        } catch {}
        cleanup();
        return;
      } else if (opcode === 0x09) {
        // Ping -> Pong
        try {
          socket.write(encodeWsFrame(0x0a, payload));
        } catch {}
      } else if (opcode === 0x0a) {
        // Pong
      } else if (opcode === 0x00) {
        // Continuation frame
        fragmentedChunks.push(payload);
        if (fin) {
          const fullPayload = Buffer.concat(fragmentedChunks);
          fragmentedChunks = [];
          onMessage(fullPayload, fragmentedOpcode === 0x02);
        }
      } else if (opcode === 0x01 || opcode === 0x02) {
        if (fin) {
          onMessage(payload, opcode === 0x02);
        } else {
          fragmentedOpcode = opcode;
          fragmentedChunks = [payload];
        }
      }
    }
  });

  socket.on('close', cleanup);
  socket.on('end', cleanup);
  socket.on('error', cleanup);

  return conn;
}

export function p2pRelayPlugin(): Plugin {
  const clientsByPeerId = new Map<string, RelayClient>();
  const stations = new Map<string, Set<string>>(); // stationId -> Set of peerIds
  const djGraceByStation = new Map<string, { hostToken: string; expiresAt: number }>();

  function setupWebSocketServer(httpServer: any) {
    if (!httpServer) return;

    httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
      const rawUrl = request.url || '';
      if (!rawUrl.startsWith('/__p2p_relay')) return;

      const parsedUrl = new URL(rawUrl, 'http://localhost');
      const boundStationId = (parsedUrl.searchParams.get('station') || '').toLowerCase().trim();
      if (boundStationId && (RESERVED_STATIONS.has(boundStationId) || !STATION_ID_RE.test(boundStationId))) {
        socket.destroy();
        return;
      }

      const key = request.headers['sec-websocket-key'];
      if (!key || typeof key !== 'string') {
        socket.destroy();
        return;
      }

      const acceptKey = createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');

      const responseHeaders = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey}`,
        '\r\n'
      ];

      socket.write(responseHeaders.join('\r\n'));

      let registeredPeerId: string | null = null;
      let registeredStationId: string | null = null;
      let textCount = 0;
      let textResetAt = Date.now() + 1000;
      let binCount = 0;
      let binResetAt = Date.now() + 1000;

      const conn = attachWebSocketHandler(
        socket,
        (rawData: Buffer, isBinary: boolean) => {
          try {
            const now = Date.now();
            if (isBinary) {
              if (now >= binResetAt) {
                binCount = 0;
                binResetAt = now + 1000;
              }
              if (++binCount > MAX_BINARY_MSGS_PER_SEC) {
                try { socket.end(); } catch {}
                return;
              }
              // Binary frame format:
              // [0..31]: targetPeerId (32 bytes UTF-8 padded with spaces, or '*' for station broadcast)
              // [32..63]: fromPeerId (32 bytes UTF-8 padded with spaces, overwritten from server identity)
              // [64..]: payload (e.g. 40-byte chunk header + audio bytes)
              if (rawData.byteLength < 64 || rawData.byteLength > MAX_BINARY_BYTES) return;
              if (!registeredPeerId || !registeredStationId) return;

              const outFrame = Buffer.from(rawData);
              encodePadded32Buf(registeredPeerId).copy(outFrame, 32);

              const targetPeerId = outFrame.subarray(0, 32).toString('utf8').trim();
              if (!targetPeerId) return;

              if (targetPeerId === '*') {
                const stationSet = stations.get(registeredStationId);
                if (stationSet) {
                  for (const memberId of stationSet) {
                    if (memberId !== registeredPeerId) {
                      const targetClient = clientsByPeerId.get(memberId);
                      if (targetClient && targetClient.stationId === registeredStationId && targetClient.conn.isOpen) {
                        targetClient.conn.sendBinary(outFrame);
                      }
                    }
                  }
                }
              } else {
                const targetClient = clientsByPeerId.get(targetPeerId);
                if (targetClient && targetClient.stationId === registeredStationId && targetClient.conn.isOpen) {
                  targetClient.conn.sendBinary(outFrame);
                }
              }
              return;
            }

            if (now >= textResetAt) {
              textCount = 0;
              textResetAt = now + 1000;
            }
            if (++textCount > MAX_TEXT_MSGS_PER_SEC) {
              try { socket.end(); } catch {}
              return;
            }
            if (rawData.byteLength > MAX_TEXT_BYTES) return;

            const text = rawData.toString('utf8');
            const msg = JSON.parse(text);

            if (msg.type === 'register') {
              const peerId = String(msg.peerId || '').trim();
              const stationId = String(msg.stationId || '').toLowerCase().trim();
              const role: 'dj' | 'listener' = msg.role === 'dj' ? 'dj' : 'listener';
              const hostToken = typeof msg.hostToken === 'string' ? msg.hostToken.trim() : '';

              if (!peerId || !stationId || !STATION_ID_RE.test(stationId) || RESERVED_STATIONS.has(stationId)) {
                try { socket.end(); } catch {}
                return;
              }
              if (boundStationId && boundStationId !== stationId) {
                conn.sendText(JSON.stringify({ type: 'register_rejected', reason: 'station_mismatch', stationId }));
                try { socket.end(); } catch {}
                return;
              }
              if (registeredPeerId && (registeredPeerId !== peerId || registeredStationId !== stationId)) {
                try { socket.end(); } catch {}
                return;
              }

              const djPeerId = `station-${stationId}-dj`;
              const isIncomingDj = role === 'dj' || peerId === djPeerId;

              if (isIncomingDj) {
                if (peerId !== djPeerId || hostToken.length < 16) {
                  conn.sendText(JSON.stringify({ type: 'register_rejected', reason: 'invalid_dj_credentials', stationId }));
                  try { socket.end(); } catch {}
                  return;
                }
                const existingDj = clientsByPeerId.get(djPeerId);
                if (existingDj && existingDj.conn.isOpen && existingDj.hostToken !== hostToken) {
                  conn.sendText(JSON.stringify({ type: 'register_rejected', reason: 'station_in_use', stationId }));
                  try { socket.end(); } catch {}
                  return;
                }
                const grace = djGraceByStation.get(stationId);
                if (grace && Date.now() < grace.expiresAt && grace.hostToken !== hostToken) {
                  conn.sendText(JSON.stringify({ type: 'register_rejected', reason: 'station_in_use', stationId }));
                  try { socket.end(); } catch {}
                  return;
                }
                djGraceByStation.delete(stationId);
                if (existingDj && existingDj.conn !== conn && existingDj.hostToken === hostToken) {
                  try { existingDj.conn.socket.end(); } catch {}
                }
              } else {
                if (!LISTENER_PEER_ID_RE.test(peerId) || peerId.startsWith('station-') || peerId.endsWith('-dj')) {
                  conn.sendText(JSON.stringify({ type: 'register_rejected', reason: 'invalid_peer_id', stationId }));
                  try { socket.end(); } catch {}
                  return;
                }
                const existingPeer = clientsByPeerId.get(peerId);
                if (existingPeer && existingPeer.conn !== conn && existingPeer.conn.isOpen) {
                  conn.sendText(JSON.stringify({ type: 'register_rejected', reason: 'peer_id_in_use', stationId }));
                  try { socket.end(); } catch {}
                  return;
                }
              }

              registeredPeerId = peerId;
              registeredStationId = stationId;

              const isPublic = isIncomingDj ? Boolean(msg.isPublic) : undefined;
              const trackTitle = isIncomingDj && typeof msg.trackTitle === 'string'
                ? msg.trackTitle.trim().slice(0, 120)
                : undefined;

              clientsByPeerId.set(peerId, {
                peerId,
                stationId,
                role: isIncomingDj ? 'dj' : 'listener',
                ...(isIncomingDj ? { hostToken, isPublic, trackTitle } : {}),
                conn
              });
              if (!stations.has(stationId)) {
                stations.set(stationId, new Set());
              }
              stations.get(stationId)!.add(peerId);

              conn.sendText(JSON.stringify({
                type: 'registered',
                peerId,
                stationId
              }));
            } else if (msg.type === 'signal' || msg.type === 'relay_control') {
              if (!registeredPeerId || !registeredStationId) return;
              const targetPeerId = String(msg.to || '').trim();
              if (!targetPeerId) return;
              const fromPeerId = registeredPeerId;

              if (targetPeerId === '*') {
                const stationSet = stations.get(registeredStationId);
                if (stationSet) {
                  const out = JSON.stringify({ ...msg, from: fromPeerId });
                  for (const memberId of stationSet) {
                    if (memberId !== fromPeerId) {
                      const c = clientsByPeerId.get(memberId);
                      if (c && c.stationId === registeredStationId && c.conn.isOpen) {
                        c.conn.sendText(out);
                      }
                    }
                  }
                }
              } else {
                const targetClient = clientsByPeerId.get(targetPeerId);
                if (targetClient && targetClient.stationId === registeredStationId && targetClient.conn.isOpen) {
                  targetClient.conn.sendText(JSON.stringify({
                    ...msg,
                    from: fromPeerId
                  }));
                } else if (msg.type === 'relay_control') {
                  conn.sendText(JSON.stringify({
                    type: 'peer_unreachable',
                    targetPeerId
                  }));
                }
              }
            } else if (msg.type === 'ping') {
              if (!registeredPeerId || !registeredStationId) return;
              const c = clientsByPeerId.get(registeredPeerId);
              if (c && c.role === 'dj' && typeof msg.trackTitle === 'string') {
                c.trackTitle = msg.trackTitle.trim().slice(0, 120) || undefined;
              }
              conn.sendText(JSON.stringify({ type: 'pong' }));
            }
          } catch (err) {
            console.warn('[Vite P2P Relay] Error handling message:', err);
          }
        },
        () => {
          if (registeredPeerId) {
            const existing = clientsByPeerId.get(registeredPeerId);
            if (existing && existing.conn === conn) {
              clientsByPeerId.delete(registeredPeerId);
              if (registeredStationId && stations.has(registeredStationId)) {
                const set = stations.get(registeredStationId)!;
                set.delete(registeredPeerId);
                const djPeerId = `station-${registeredStationId}-dj`;
                if (registeredPeerId === djPeerId) {
                  if (existing.hostToken) {
                    djGraceByStation.set(registeredStationId, {
                      hostToken: existing.hostToken,
                      expiresAt: Date.now() + DJ_GRACE_MS
                    });
                  }
                  const disconnectMsg = JSON.stringify({
                    type: 'relay_dj_disconnected',
                    stationId: registeredStationId
                  });
                  for (const memberId of set) {
                    const member = clientsByPeerId.get(memberId);
                    if (member && member.conn.isOpen) {
                      member.conn.sendText(disconnectMsg);
                    }
                  }
                } else {
                  const djClient = clientsByPeerId.get(djPeerId);
                  if (djClient && djClient.conn.isOpen) {
                    djClient.conn.sendText(JSON.stringify({
                      type: 'relay_peer_disconnected',
                      peerId: registeredPeerId
                    }));
                  }
                }
              }
            }
          }
        }
      );
    });
  }

  function setupStatusMiddleware(middlewares: any) {
    middlewares.use('/__p2p_relay/stations', (_req: IncomingMessage, res: any) => {
      const active: Array<{ stationId: string; listeners: number; trackTitle?: string; updatedAt: number }> = [];
      for (const [stationId, peerSet] of stations.entries()) {
        let djClient: RelayClient | null = null;
        let listeners = 0;
        for (const peerId of peerSet) {
          const client = clientsByPeerId.get(peerId);
          if (!client || !client.conn.isOpen) continue;
          if (client.role === 'dj') djClient = client;
          else listeners++;
        }
        if (djClient && djClient.isPublic) {
          active.push({
            stationId,
            listeners,
            trackTitle: djClient.trackTitle,
            updatedAt: Date.now()
          });
        }
      }
      active.sort((a, b) => (b.listeners - a.listeners) || a.stationId.localeCompare(b.stationId));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ stations: active }));
    });

    middlewares.use('/__p2p_relay/status', (req: IncomingMessage, res: any) => {
      const url = new URL(req.url || '/', 'http://localhost');
      const station = (url.searchParams.get('station') || '').toLowerCase().trim();
      let live = false;
      let listeners = 0;
      const peerSet = station ? stations.get(station) : undefined;
      if (peerSet) {
        for (const peerId of peerSet) {
          const client = clientsByPeerId.get(peerId);
          if (!client || !client.conn.isOpen) continue;
          if (client.role === 'dj') live = true;
          else listeners++;
        }
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ live, stationId: station, listeners }));
    });
  }

  return {
    name: 'vite-plugin-p2p-relay',
    configureServer(server) {
      setupStatusMiddleware(server.middlewares);
      setupWebSocketServer(server.httpServer);
    },
    configurePreviewServer(server) {
      setupStatusMiddleware(server.middlewares);
      setupWebSocketServer(server.httpServer);
    }
  };
}
