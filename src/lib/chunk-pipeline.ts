// chunk-pipeline.ts: Manages zero-copy slicing of audio files into indexed chunks
// and streaming assembly directly to OPFS / Blobs without heap memory pressure.

import { OPFSTrackWriter, isOPFSSupported } from './audio-storage';

export const CHUNK_SIZE = 48 * 1024; // 48KB chunks (safe under WebRTC RTCDataChannel 64KB message limits)
export const MAX_TRACK_CHUNKS = 2560; // ~120MB upper bound per track
export const MAX_COVER_DATA_URL_LEN = 512 * 1024;

const ALLOWED_AUDIO_MIMES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/x-m4a',
  'audio/m4a',
  'audio/aac',
  'audio/flac',
  'audio/x-flac',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'audio/opus'
]);

const TRACK_ID_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const SAFE_COVER_DATA_URL_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/i;
const SHA256_B64_RE = /^[A-Za-z0-9+/]{43}=$/;

export interface TrackManifest {
  trackId: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  mimeType: string;
  totalSize: number;
  totalChunks: number;
  coverDataUrl?: string; // base64 thumbnail if available
  chunkHashes?: string[]; // per-chunk base64 SHA-256 digests
}

export async function sha256Base64(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export async function computeChunkHashes(
  file: Blob,
  chunkSize = CHUNK_SIZE
): Promise<string[]> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return [];
  const totalChunks = Math.ceil(file.size / chunkSize);
  const hashes: string[] = new Array(totalChunks);
  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    const buf = await file.slice(start, end).arrayBuffer();
    hashes[i] = await sha256Base64(buf);
  }
  return hashes;
}

function cleanMetaString(value: unknown, fallback: string, maxLen = 200): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLen);
  return cleaned || fallback;
}

export function sanitizeTrackManifest(raw: unknown): TrackManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;

  if (typeof m.trackId !== 'string' || !TRACK_ID_RE.test(m.trackId)) return null;

  const totalChunks = typeof m.totalChunks === 'number' ? Math.trunc(m.totalChunks) : 0;
  const totalSize = typeof m.totalSize === 'number' ? Math.trunc(m.totalSize) : 0;
  if (
    !Number.isFinite(totalChunks) ||
    !Number.isFinite(totalSize) ||
    totalChunks < 1 ||
    totalChunks > MAX_TRACK_CHUNKS
  ) {
    return null;
  }

  const minExpectedSize = (totalChunks - 1) * CHUNK_SIZE + 1;
  const maxExpectedSize = totalChunks * CHUNK_SIZE;
  if (totalSize < minExpectedSize || totalSize > maxExpectedSize) {
    return null;
  }

  const rawDuration = typeof m.duration === 'number' && Number.isFinite(m.duration) ? m.duration : 0;
  const duration = Math.max(0, Math.min(86400, rawDuration));

  const rawMime = typeof m.mimeType === 'string' ? m.mimeType.split(';')[0].trim().toLowerCase() : '';
  const mimeType = ALLOWED_AUDIO_MIMES.has(rawMime) ? rawMime : 'audio/mpeg';

  let coverDataUrl: string | undefined;
  if (typeof m.coverDataUrl === 'string' && m.coverDataUrl.length <= MAX_COVER_DATA_URL_LEN) {
    if (SAFE_COVER_DATA_URL_RE.test(m.coverDataUrl)) {
      coverDataUrl = m.coverDataUrl;
    }
  }

  let chunkHashes: string[] | undefined;
  if (m.chunkHashes !== undefined) {
    if (!Array.isArray(m.chunkHashes) || m.chunkHashes.length !== totalChunks) {
      return null;
    }
    const validated: string[] = new Array(totalChunks);
    for (let i = 0; i < totalChunks; i++) {
      const h = m.chunkHashes[i];
      if (typeof h !== 'string' || !SHA256_B64_RE.test(h)) {
        return null;
      }
      validated[i] = h;
    }
    chunkHashes = validated;
  }

  return {
    trackId: m.trackId,
    title: cleanMetaString(m.title, 'Unknown Track'),
    artist: cleanMetaString(m.artist, 'Unknown Artist'),
    album: cleanMetaString(m.album, ''),
    duration,
    mimeType,
    totalSize,
    totalChunks,
    ...(coverDataUrl ? { coverDataUrl } : {}),
    ...(chunkHashes ? { chunkHashes } : {})
  };
}

export interface ChunkPayload {
  trackId: string;
  chunkIndex: number;
  totalChunks: number;
  data: ArrayBuffer;
}

export class TrackBuffer {
  manifest: TrackManifest;
  receivedIndexes: Set<number> = new Set();
  isComplete: boolean = false;
  blobUrl: string | null = null;
  blob: Blob | null = null;
  public onComplete?: (blob: Blob, blobUrl: string) => void;

  // OPFS zero-copy disk streaming writer
  private opfsWriter: OPFSTrackWriter | null = null;
  private opfsInitPromise: Promise<boolean> | null = null;
  private pendingInitChunks: Array<{ chunkIndex: number; data: ArrayBuffer }> = [];
  private isFinalizing: boolean = false;
  private isDestroyed: boolean = false;

  // In-memory fallback only used if OPFS is unavailable or fails
  private fallbackChunks: Map<number, Uint8Array> | null = null;

  constructor(manifest: TrackManifest) {
    this.manifest = manifest;
    if (isOPFSSupported()) {
      this.opfsWriter = new OPFSTrackWriter();
      this.opfsInitPromise = this.opfsWriter.init(manifest.trackId, manifest.totalSize).then((ok) => {
        this.opfsInitPromise = null;
        if (this.isDestroyed || this.isComplete) {
          if (this.opfsWriter) {
            this.opfsWriter.abort();
            this.opfsWriter = null;
          }
          this.pendingInitChunks = [];
          return false;
        }
        if (ok && this.opfsWriter && this.opfsWriter.isReady) {
          for (const item of this.pendingInitChunks) {
            this.opfsWriter.writeChunk(item.chunkIndex, CHUNK_SIZE, item.data);
          }
          this.pendingInitChunks = [];
        } else {
          this.opfsWriter = null;
          if (!this.fallbackChunks) this.fallbackChunks = new Map();
          for (const item of this.pendingInitChunks) {
            this.fallbackChunks.set(item.chunkIndex, new Uint8Array(item.data));
          }
          this.pendingInitChunks = [];
        }

        if (this.receivedIndexes.size === this.manifest.totalChunks) {
          this.finalize();
        }
        return ok;
      });
    } else {
      this.fallbackChunks = new Map();
    }
  }

  addChunk(chunkIndex: number, data: ArrayBuffer): boolean {
    if (this.isComplete || this.receivedIndexes.has(chunkIndex)) {
      return this.isComplete;
    }

    this.receivedIndexes.add(chunkIndex);

    // Stream chunk directly to OPFS disk file or queue
    if (this.opfsWriter && this.opfsWriter.isReady) {
      this.opfsWriter.writeChunk(chunkIndex, CHUNK_SIZE, data);
    } else if (this.opfsInitPromise) {
      this.pendingInitChunks.push({ chunkIndex, data });
    } else {
      if (!this.fallbackChunks) this.fallbackChunks = new Map();
      this.fallbackChunks.set(chunkIndex, new Uint8Array(data));
    }

    if (this.receivedIndexes.size === this.manifest.totalChunks) {
      this.finalize();
    }

    return this.isComplete;
  }

  get progress(): number {
    if (this.isComplete) return 100;
    if (this.manifest.totalChunks === 0) return 0;
    return Math.round((this.receivedIndexes.size / this.manifest.totalChunks) * 100);
  }

  getMissingChunkIndexes(): number[] {
    if (this.isComplete) return [];
    const missing: number[] = [];
    for (let i = 0; i < this.manifest.totalChunks; i++) {
      if (!this.receivedIndexes.has(i)) {
        missing.push(i);
      }
    }
    return missing;
  }

  private async finalize() {
    if (this.isComplete || this.isFinalizing) return;
    this.isFinalizing = true;

    if (this.opfsInitPromise) {
      await this.opfsInitPromise;
    }

    // 1. Try OPFS finish
    if (this.opfsWriter && this.opfsWriter.isReady) {
      try {
        const file = await this.opfsWriter.finish();
        if (file && file.size > 0) {
          this.blob = file.slice(0, file.size, this.manifest.mimeType || 'audio/flac');
          this.blobUrl = URL.createObjectURL(this.blob);
          this.isComplete = true;
          this.isFinalizing = false;
          this.fallbackChunks = null;
          console.log(`[TrackBuffer] OPFS finalized "${this.manifest.title}" (${(file.size / (1024 * 1024)).toFixed(1)}MB, ${this.blob.type})`);
          if (this.onComplete) this.onComplete(this.blob, this.blobUrl);
          return;
        }
      } catch (err) {
        console.warn('[TrackBuffer] OPFS finalize failed, checking fallback:', err);
      }
    }

    // 2. Fallback memory assembly (if OPFS was unavailable or failed)
    if (this.fallbackChunks && this.fallbackChunks.size === this.manifest.totalChunks) {
      const parts: Uint8Array[] = [];
      for (let i = 0; i < this.manifest.totalChunks; i++) {
        const chunk = this.fallbackChunks.get(i);
        if (chunk) parts.push(chunk);
      }
      this.blob = new Blob(parts as any[], { type: this.manifest.mimeType });
      this.blobUrl = URL.createObjectURL(this.blob);
      this.isComplete = true;
      this.isFinalizing = false;
      this.fallbackChunks.clear();
      this.fallbackChunks = null;
      console.log(`[TrackBuffer] Fallback assembled "${this.manifest.title}" (${(this.blob.size / (1024 * 1024)).toFixed(1)}MB)`);
      if (this.onComplete) this.onComplete(this.blob, this.blobUrl);
    }
  }

  loadFromCachedBlob(blob: Blob, _chunks?: ChunkPayload[]) {
    if (this.isDestroyed) return;
    this.blob = blob;
    this.blobUrl = URL.createObjectURL(blob);
    this.isComplete = true;
    this.isFinalizing = false;
    this.pendingInitChunks = [];
    if (this.opfsWriter) {
      this.opfsWriter.abort();
      this.opfsWriter = null;
    }
    for (let i = 0; i < this.manifest.totalChunks; i++) {
      this.receivedIndexes.add(i);
    }
    if (this.fallbackChunks) {
      this.fallbackChunks.clear();
      this.fallbackChunks = null;
    }
  }

  destroy() {
    this.isDestroyed = true;
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }
    this.blob = null;
    this.receivedIndexes.clear();
    this.isComplete = false;
    this.isFinalizing = false;
    this.pendingInitChunks = [];
    if (this.opfsWriter) {
      this.opfsWriter.abort();
      this.opfsWriter = null;
    }
    if (this.fallbackChunks) {
      this.fallbackChunks.clear();
      this.fallbackChunks = null;
    }
  }
}

/**
 * Slice a File or Blob into chunks for transmission.
 * Uses Blob.slice() to stream chunk by chunk without reading the whole file into RAM!
 */
export async function createTrackChunks(
  file: File | Blob,
  manifest: TrackManifest,
  onProgress?: (percent: number) => void
): Promise<ChunkPayload[]> {
  const chunks: ChunkPayload[] = [];
  const totalChunks = manifest.totalChunks;

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    // Slice chunk on-demand - does not allocate full file
    const chunkBuffer = await file.slice(start, end).arrayBuffer();

    chunks.push({
      trackId: manifest.trackId,
      chunkIndex: i,
      totalChunks,
      data: chunkBuffer,
    });

    if (i % 25 === 0) {
      if (onProgress) {
        onProgress(Math.round(((i + 1) / totalChunks) * 100));
      }
      // Micro-yield to keep UI completely responsive
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  if (onProgress) {
    onProgress(100);
  }

  return chunks;
}
