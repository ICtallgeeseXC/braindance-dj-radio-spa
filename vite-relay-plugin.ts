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
  conn: RelayConnection;
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

  function setupWebSocketServer(httpServer: any) {
    if (!httpServer) return;

    httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
      const url = request.url || '';
      if (!url.startsWith('/__p2p_relay')) return;

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

      const conn = attachWebSocketHandler(
        socket,
        (rawData: Buffer, isBinary: boolean) => {
          try {
            if (isBinary) {
              // Binary frame format:
              // [0..31]: targetPeerId (32 bytes UTF-8 padded with spaces, or '*' for station broadcast)
              // [32..63]: fromPeerId (32 bytes UTF-8 padded with spaces)
              // [64..]: payload (e.g. 40-byte chunk header + audio bytes)
              if (rawData.byteLength < 64) return;
              const targetPeerId = rawData.subarray(0, 32).toString('utf8').trim();

              if (targetPeerId === '*') {
                if (registeredStationId && stations.has(registeredStationId)) {
                  for (const memberId of stations.get(registeredStationId)!) {
                    if (memberId !== registeredPeerId) {
                      const targetClient = clientsByPeerId.get(memberId);
                      if (targetClient && targetClient.conn.isOpen) {
                        targetClient.conn.sendBinary(rawData);
                      }
                    }
                  }
                }
              } else {
                const targetClient = clientsByPeerId.get(targetPeerId);
                if (targetClient && targetClient.conn.isOpen) {
                  targetClient.conn.sendBinary(rawData);
                }
              }
              return;
            }

            const text = rawData.toString('utf8');
            const msg = JSON.parse(text);

            if (msg.type === 'register') {
              const peerId = String(msg.peerId || '').trim();
              const stationId = String(msg.stationId || '').toLowerCase().trim();
              const role = msg.role === 'dj' ? 'dj' : 'listener';
              if (!peerId || !stationId) return;

              registeredPeerId = peerId;
              registeredStationId = stationId;

              clientsByPeerId.set(peerId, { peerId, stationId, role, conn });
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
              const targetPeerId = String(msg.to || '').trim();
              const fromPeerId = registeredPeerId || String(msg.from || '').trim();

              if (targetPeerId === '*') {
                if (registeredStationId && stations.has(registeredStationId)) {
                  const out = JSON.stringify({ ...msg, from: fromPeerId });
                  for (const memberId of stations.get(registeredStationId)!) {
                    if (memberId !== fromPeerId) {
                      const c = clientsByPeerId.get(memberId);
                      if (c && c.conn.isOpen) {
                        c.conn.sendText(out);
                      }
                    }
                  }
                }
              } else {
                const targetClient = clientsByPeerId.get(targetPeerId);
                if (targetClient && targetClient.conn.isOpen) {
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
                if (registeredPeerId !== djPeerId) {
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

  return {
    name: 'vite-plugin-p2p-relay',
    configureServer(server) {
      setupWebSocketServer(server.httpServer);
    },
    configurePreviewServer(server) {
      setupWebSocketServer(server.httpServer);
    }
  };
}
