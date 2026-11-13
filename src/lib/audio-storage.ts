// audio-storage.ts: Zero-copy, disk-backed audio storage using OPFS (Origin Private File System)
// with automatic fallback to Cache Storage API (window.caches).
// Solves mobile/Android memory pressure spikes and Low-Memory-Killer (OOM) crashes
// by streaming chunks directly to and from disk rather than holding 100MB+ arrays in JS heap memory.

import { CHUNK_SIZE, type TrackManifest } from './chunk-pipeline';

export const MAX_STORAGE_BYTES = 350 * 1024 * 1024; // 350MB persistent storage quota

export function isOPFSSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage !== 'undefined' &&
    typeof navigator.storage.getDirectory === 'function' &&
    (typeof FileSystemFileHandle === 'undefined' || 'createWritable' in FileSystemFileHandle.prototype)
  );
}

export function isCacheAPISupported(): boolean {
  return typeof window !== 'undefined' && 'caches' in window;
}

// In-memory handle cache so open OPFS files are quickly accessible without directory re-scanning
const opfsFileHandleCache = new Map<string, FileSystemFileHandle>();

/**
 * OPFS Track Streaming Writer:
 * Streams incoming audio chunks directly to an OPFS file on disk.
 * Keeps JS heap memory allocation near 0MB even for 100MB+ FLAC tracks.
 */
export class OPFSTrackWriter {
  private fileHandle: FileSystemFileHandle | null = null;
  private writable: FileSystemWritableFileStream | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  public isReady: boolean = false;
  private hasFailed: boolean = false;

  async init(trackId: string, _expectedSize?: number): Promise<boolean> {
    if (!isOPFSSupported()) {
      this.hasFailed = true;
      return false;
    }

    try {
      const root = await navigator.storage.getDirectory();
      const filename = `track_${trackId}.bin`;
      this.fileHandle = await root.getFileHandle(filename, { create: true });
      opfsFileHandleCache.set(trackId, this.fileHandle);

      // Open persistent writable stream for random-access chunk writes
      if (typeof (this.fileHandle as any).createWritable !== 'function') {
        throw new Error('createWritable is not supported on this browser/context');
      }
      this.writable = await (this.fileHandle as any).createWritable({ keepExistingData: true });

      this.isReady = true;
      return true;
    } catch (err) {
      console.warn('[OPFS Writer] Initialization failed, falling back to memory/cache:', err);
      this.hasFailed = true;
      this.isReady = false;
      return false;
    }
  }

  writeChunk(chunkIndex: number, chunkSize: number, data: ArrayBuffer): void {
    if (this.hasFailed || !this.writable) return;

    const offset = chunkIndex * chunkSize;
    this.writeQueue = this.writeQueue
      .then(async () => {
        if (!this.writable) return;
        await this.writable.seek(offset);
        await this.writable.write(data);
      })
      .catch((err) => {
        console.warn(`[OPFS Writer] Error writing chunk ${chunkIndex}:`, err);
        this.hasFailed = true;
        this.isReady = false;
      });
  }

  async finish(): Promise<File | null> {
    if (this.hasFailed || !this.fileHandle) return null;

    try {
      await this.writeQueue;
      if (this.writable) {
        await this.writable.close();
        this.writable = null;
      }
      return await this.fileHandle.getFile();
    } catch (err) {
      console.warn('[OPFS Writer] Error closing stream:', err);
      return null;
    }
  }

  abort(): void {
    this.hasFailed = true;
    if (this.writable) {
      try {
        this.writable.abort().catch(() => {});
      } catch {}
      this.writable = null;
    }
  }
}

/**
 * Save an assembled track Blob/File directly to disk storage (OPFS or Cache API).
 */
export async function saveTrackToDisk(
  trackId: string,
  manifest: TrackManifest,
  blobOrFile: Blob | File
): Promise<boolean> {
  // 1. Try OPFS first
  if (isOPFSSupported()) {
    try {
      const root = await navigator.storage.getDirectory();

      // Check if track_${trackId}.bin already exists and has full size (e.g. from OPFSTrackWriter)
      let needsBinaryWrite = true;
      try {
        const existingHandle = await root.getFileHandle(`track_${trackId}.bin`);
        const existingFile = await existingHandle.getFile();
        if (existingFile.size >= (manifest.totalSize || blobOrFile.size)) {
          needsBinaryWrite = false;
          opfsFileHandleCache.set(trackId, existingHandle);
        }
      } catch {
        needsBinaryWrite = true;
      }

      if (needsBinaryWrite) {
        const fileHandle = await root.getFileHandle(`track_${trackId}.bin`, { create: true });
        if (typeof (fileHandle as any).createWritable !== 'function') {
          await root.removeEntry(`track_${trackId}.bin`).catch(() => {});
          throw new Error('OPFS createWritable unavailable');
        }
        const writable = await (fileHandle as any).createWritable();
        await writable.write(blobOrFile);
        await writable.close();
        opfsFileHandleCache.set(trackId, fileHandle);
        console.log(`[Storage] Saved "${manifest.title}" (${(blobOrFile.size / (1024 * 1024)).toFixed(1)}MB) directly to OPFS`);
      }

      // Always save or update manifest metadata JSON
      try {
        const manifestHandle = await root.getFileHandle(`manifest_${trackId}.json`, { create: true });
        const mWritable = await (manifestHandle as any).createWritable();
        await mWritable.write(JSON.stringify(manifest));
        await mWritable.close();
      } catch (mErr) {
        console.warn('[Storage] Error saving manifest JSON:', mErr);
      }

      return true;
    } catch (err) {
      console.warn('[Storage] OPFS save failed, trying Cache API fallback:', err);
    }
  }

  // 2. Cache API fallback
  if (isCacheAPISupported()) {
    try {
      const cache = await caches.open('p2p_radio_audio_v1');
      const response = new Response(blobOrFile, {
        headers: {
          'Content-Type': manifest.mimeType || 'audio/flac',
          'X-Manifest': encodeURIComponent(JSON.stringify(manifest)),
          'X-Track-Id': trackId,
          'X-Saved-At': String(Date.now()),
        },
      });
      await cache.put(`/track/${trackId}`, response);
      console.log(`[Storage] Saved "${manifest.title}" (${(blobOrFile.size / (1024 * 1024)).toFixed(1)}MB) to Cache API`);
      return true;
    } catch (err) {
      console.warn('[Storage] Cache API save failed:', err);
    }
  }

  return false;
}

/**
 * Retrieve a track from OPFS or Cache API as a disk-backed Blob/File.
 * Zero-copy: Does not inflate JS heap memory.
 */
export async function getTrackFromDisk(
  trackId: string
): Promise<{ blob: Blob; manifest?: TrackManifest } | null> {
  // 1. Try OPFS
  if (isOPFSSupported()) {
    try {
      const root = await navigator.storage.getDirectory();
      let fileHandle = opfsFileHandleCache.get(trackId);
      if (!fileHandle) {
        fileHandle = await root.getFileHandle(`track_${trackId}.bin`);
        opfsFileHandleCache.set(trackId, fileHandle);
      }
      const file = await fileHandle.getFile();
      if (file.size === 0) {
        opfsFileHandleCache.delete(trackId);
        await root.removeEntry(`track_${trackId}.bin`).catch(() => {});
        throw new Error('Empty OPFS track file');
      }

      // Read manifest metadata if available
      let manifest: TrackManifest | undefined;
      try {
        const manifestHandle = await root.getFileHandle(`manifest_${trackId}.json`);
        const mFile = await manifestHandle.getFile();
        const mText = await mFile.text();
        manifest = JSON.parse(mText);
      } catch {}

      return { blob: file, manifest };
    } catch {}
  }

  // 2. Try Cache API
  if (isCacheAPISupported()) {
    try {
      const cache = await caches.open('p2p_radio_audio_v1');
      const res = await cache.match(`/track/${trackId}`);
      if (res) {
        const blob = await res.blob();
        const header = res.headers.get('X-Manifest');
        let manifest: TrackManifest | undefined;
        if (header) {
          try {
            manifest = JSON.parse(decodeURIComponent(header));
          } catch {}
        }
        return { blob, manifest };
      }
    } catch {}
  }

  return null;
}

/**
 * Read a single 48KB chunk on-demand directly from disk.
 * Allocates ONLY the 48KB chunk being transmitted, then immediately releases it.
 */
export async function readTrackChunkFromDisk(
  trackId: string,
  chunkIndex: number,
  chunkSize: number = CHUNK_SIZE,
  cachedBlob?: Blob | File | null
): Promise<ArrayBuffer | null> {
  let blob = cachedBlob;
  if (!blob) {
    const item = await getTrackFromDisk(trackId);
    blob = item?.blob ?? null;
  }
  if (!blob) return null;

  const start = chunkIndex * chunkSize;
  const end = Math.min(start + chunkSize, blob.size);
  if (start >= blob.size) return null;

  // Blob.slice() produces an unallocated slice pointer;
  // arrayBuffer() only reads that single 48KB chunk into RAM!
  return await blob.slice(start, end).arrayBuffer();
}

/**
 * Clean up old tracks from storage to stay under MAX_STORAGE_BYTES quota.
 */
export async function purgeOldStorage(protectedTrackIds?: Iterable<string>): Promise<void> {
  const protectedSet = new Set<string>(protectedTrackIds || []);

  // Cache API purge
  if (isCacheAPISupported()) {
    try {
      const cache = await caches.open('p2p_radio_audio_v1');
      const keys = await cache.keys();
      const evictable = keys.filter((req) => {
        const match = req.url.match(/\/track\/([^/?#]+)$/);
        return !match || !protectedSet.has(match[1]);
      });
      if (evictable.length > 5) {
        for (let i = 0; i < evictable.length - 5; i++) {
          await cache.delete(evictable[i]);
        }
      }
    } catch {}
  }

  // OPFS purge: evict stale temp files, orphan manifests, and oldest tracks beyond 5 files or quota
  if (isOPFSSupported()) {
    try {
      const root = await navigator.storage.getDirectory();
      const tracks: Array<{ trackId: string; lastModified: number; size: number }> = [];
      const manifestTrackIds: string[] = [];
      let totalBytes = 0;

      for await (const [name, handle] of (root as any).entries()) {
        if (name.startsWith('temp_')) {
          try {
            await root.removeEntry(name);
          } catch {}
          continue;
        }
        const trackMatch = /^track_(.+)\.bin$/.exec(name);
        if (trackMatch && handle?.kind === 'file') {
          try {
            const file = await handle.getFile();
            const size = file?.size || 0;
            totalBytes += size;
            tracks.push({
              trackId: trackMatch[1],
              lastModified: file?.lastModified || 0,
              size
            });
          } catch {}
          continue;
        }
        const manifestMatch = /^manifest_(.+)\.json$/.exec(name);
        if (manifestMatch) {
          manifestTrackIds.push(manifestMatch[1]);
        }
      }

      const activeTrackSet = new Set(tracks.map((t) => t.trackId));
      for (const orphanId of manifestTrackIds) {
        if (!activeTrackSet.has(orphanId)) {
          await root.removeEntry(`manifest_${orphanId}.json`).catch(() => {});
        }
      }

      // Oldest first so newest 5 tracks are preserved unless quota requires further trimming
      tracks.sort((a, b) => a.lastModified - b.lastModified);
      let remainingCount = tracks.length;

      for (const entry of tracks) {
        if (protectedSet.has(entry.trackId)) continue;
        if (remainingCount <= 5 && totalBytes <= MAX_STORAGE_BYTES) break;

        opfsFileHandleCache.delete(entry.trackId);
        await root.removeEntry(`track_${entry.trackId}.bin`).catch(() => {});
        await root.removeEntry(`manifest_${entry.trackId}.json`).catch(() => {});
        remainingCount--;
        totalBytes = Math.max(0, totalBytes - entry.size);
      }
    } catch {}
  }
}
