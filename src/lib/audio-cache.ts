// audio-cache.ts: Unified caching interface backed by OPFS & Cache Storage API.
// Replaces heavy IndexedDB blob cloning with high-performance, zero-copy disk streaming.

import type { TrackManifest, ChunkPayload } from './chunk-pipeline';
import {
  saveTrackToDisk,
  getTrackFromDisk,
  readTrackChunkFromDisk,
  purgeOldStorage,
  MAX_STORAGE_BYTES,
} from './audio-storage';

export { MAX_STORAGE_BYTES as MAX_CACHE_BYTES };

export interface CachedTrackRecord {
  trackId: string;
  manifest: TrackManifest;
  blob: Blob;
  chunks: ChunkPayload[];
  cachedAt: number;
}

export async function saveTrackToCache(
  trackId: string,
  manifest: TrackManifest,
  blob: Blob,
  _chunks?: ChunkPayload[]
): Promise<void> {
  await saveTrackToDisk(trackId, manifest, blob);
  await purgeOldStorage();
}

export async function getTrackFromCache(trackId: string): Promise<CachedTrackRecord | null> {
  const item = await getTrackFromDisk(trackId);
  if (!item || !item.manifest) return null;

  return {
    trackId,
    manifest: item.manifest,
    blob: item.blob,
    // Keep chunks empty to avoid loading 100MB+ into RAM;
    // Chunks are read on-demand via readTrackChunkFromDisk!
    chunks: [],
    cachedAt: Date.now(),
  };
}

export async function getCacheUsageBytes(): Promise<number> {
  if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      return estimate.usage || 0;
    } catch {}
  }
  return 0;
}

export async function clearTrackCache(): Promise<void> {
  await purgeOldStorage();
}

export { readTrackChunkFromDisk };
