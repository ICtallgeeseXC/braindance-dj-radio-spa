// player-controller.ts: Coordinates local Audio playback, synchronized timing, and chunk buffering

import { TrackBuffer, type TrackManifest } from './chunk-pipeline';
import { getSyncedTime } from './time-sync';
import type { StationState } from './p2p-mesh';
import { getTrackFromCache, saveTrackToCache } from './audio-cache';
import { getTrackFromDisk } from './audio-storage';

export interface AudioVisualData {
  freq: Uint8Array;
  time: Uint8Array;
  leftFreq: Uint8Array;
  leftTime: Uint8Array;
  rightFreq: Uint8Array;
  rightTime: Uint8Array;
  sampleRate: number;
}

export class PlayerController {
  private audioElement: HTMLAudioElement;
  private currentTrackBuffer: TrackBuffer | null = null;
  private nextTrackBuffer: TrackBuffer | null = null;

  // Web Audio API graph for real-time spectrum analysis
  private audioContext: AudioContext | null = null;
  private analyserNode: AnalyserNode | null = null;
  private leftAnalyser: AnalyserNode | null = null;
  private rightAnalyser: AnalyserNode | null = null;
  private gainNode: GainNode | null = null;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private freqData: Uint8Array | null = null;
  private timeData: Uint8Array | null = null;
  private leftFreqData: Uint8Array | null = null;
  private leftTimeData: Uint8Array | null = null;
  private rightFreqData: Uint8Array | null = null;
  private rightTimeData: Uint8Array | null = null;
  private userVolume: number = 1.0;
  private ownedBlobUrl: string | null = null;
  private errorRetryCount: number = 0;
  private syncTimer: any = null;
  
  public currentTrackId: string | null = null;
  public nextTrackId: string | null = null;
  public isPlaying: boolean = false;
  public trackManifests: Map<string, TrackManifest> = new Map();
  public stationStartedAt: number = 0;

  // Reactivity callbacks
  public onBufferProgress?: (currentPct: number, nextPct: number) => void;
  public onTimeUpdate?: (currentTime: number, duration: number) => void;
  public onTrackChange?: (manifest: TrackManifest | null) => void;
  public onTrackEnded?: () => void;
  public onPlayStateChange?: (isPlaying: boolean) => void;
  public onRequestMissingChunks?: (trackId: string, missingIndexes?: number[]) => void;
  /** Fires true when audio is mounted and playable (possibly a partial prefix), false on track switch. */
  public onSourceMounted?: (mounted: boolean) => void;

  constructor() {
    this.audioElement = document.createElement('audio');
    this.audioElement.preload = 'auto';
    this.audioElement.setAttribute('playsinline', 'true');
    this.audioElement.setAttribute('webkit-playsinline', 'true');
    this.audioElement.style.position = 'fixed';
    this.audioElement.style.top = '-9999px';
    this.audioElement.style.left = '-9999px';
    this.audioElement.style.width = '1px';
    this.audioElement.style.height = '1px';
    this.audioElement.style.opacity = '0.01';

    if (typeof document !== 'undefined' && document.body) {
      document.body.appendChild(this.audioElement);
    } else if (typeof window !== 'undefined') {
      window.addEventListener('DOMContentLoaded', () => {
        document.body.appendChild(this.audioElement);
      });
    }

    this.audioElement.ontimeupdate = () => {
      if (this.onTimeUpdate) {
        const manifest = this.currentTrackId ? this.trackManifests.get(this.currentTrackId) : null;
        const dur = (this.audioElement.duration && !isNaN(this.audioElement.duration) && this.audioElement.duration > 0)
          ? this.audioElement.duration
          : (manifest?.duration || 0);
        this.onTimeUpdate(this.audioElement.currentTime, dur);
      }
    };

    this.audioElement.onplay = () => {
      this.ensureAudioContextRunning();
      this.updateMediaSessionState('playing');
      if (this.onPlayStateChange) this.onPlayStateChange(true);
    };

    this.audioElement.onplaying = () => {
      this.errorRetryCount = 0;
    };

    this.audioElement.onseeked = () => {
      if (this.isPlaying && this.audioElement.paused) {
        this.ensureAudioContextRunning();
        this.audioElement.play().catch(() => {});
      }
    };

    this.audioElement.onpause = () => {
      this.updateMediaSessionState('paused');
      if (this.onPlayStateChange) this.onPlayStateChange(false);
    };

    this.initMediaSession();

    this.audioElement.onerror = async () => {
      const err = this.audioElement.error;
      console.warn(`[Player] Audio error (code: ${err?.code}, msg: ${err?.message})`);
      if (this.currentTrackId && this.errorRetryCount < 2) {
        this.errorRetryCount++;
        console.log(`[Player] Recovering from audio playback error via disk reload (attempt ${this.errorRetryCount}/2)...`);
        const cached = await getTrackFromDisk(this.currentTrackId);
        if (cached && cached.blob) {
          const mimeType = cached.manifest?.mimeType || 'audio/flac';
          const freshBlob = cached.blob.slice(0, cached.blob.size, mimeType);
          this.attachSource(this.setOwnedBlobSource(freshBlob));
          this.audioElement.play().catch(() => {});
        }
      }
    };

    if (typeof window !== 'undefined') {
      this.syncTimer = setInterval(() => {
        if (this.isPlaying && !this.audioElement.paused && this.audioElement.playbackRate !== 1.0) {
          this.syncPlaybackPosition();
        }
      }, 1000);
    }

    this.audioElement.onstalled = () => {
      console.warn('[Player] Audio stalled, attempting to resume playback...');
      if (this.isPlaying && this.audioElement.paused) {
        this.audioElement.play().catch(() => {});
      }
    };

    this.audioElement.onwaiting = () => {
      console.log('[Player] Audio buffer waiting...');
    };

    // Auto-advance to next track when completed
    this.audioElement.onended = () => {
      const manifest = this.currentTrackId ? this.trackManifests.get(this.currentTrackId) : null;
      const curTime = this.audioElement.currentTime;
      const realDur = manifest?.duration || this.audioElement.duration || 0;
      // Guard against false "ended" events on mobile if audio stopped prematurely!
      if (realDur > 10 && curTime < realDur - 2.5) {
        console.warn(`[Player] Premature "ended" event at ${curTime.toFixed(1)}s of ${realDur.toFixed(1)}s track! Resuming...`);
        this.audioElement.play().catch(() => {});
        return;
      }
      console.log("[Player] Track ended.");
      if (this.onTrackEnded) this.onTrackEnded();
    };

    // Unlock Web Audio Context on user interaction & tab visibility
    if (typeof window !== 'undefined') {
      const unlock = () => {
        this.ensureAudioContextRunning();
        window.removeEventListener('click', unlock);
        window.removeEventListener('touchstart', unlock);
        window.removeEventListener('keydown', unlock);
      };
      window.addEventListener('click', unlock, { passive: true });
      window.addEventListener('touchstart', unlock, { passive: true });
      window.addEventListener('keydown', unlock, { passive: true });

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          this.ensureAudioContextRunning();
          if (this.isPlaying && this.audioElement.paused) {
            this.audioElement.play().catch(() => {});
          }
        }
      });
    }
  }

  private initMediaSession() {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler('play', () => {
        this.resumeSync();
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        this.pause();
      });
    } catch {}
  }

  private updateMediaSessionState(state: 'playing' | 'paused' | 'none') {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = state;
      const manifest = this.currentTrackId ? this.trackManifests.get(this.currentTrackId) : null;
      if (manifest && typeof MediaMetadata !== 'undefined') {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: manifest.title || 'P2P Radio Stream',
          artist: manifest.artist || 'BRAINDANCE // RADIO',
          album: 'BRAINDANCE // RADIO'
        });
      }
    } catch {}
  }

  public setupAudioAnalyser() {
    if (this.analyserNode || typeof window === 'undefined') return;
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      this.audioContext = new AudioCtx();

      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 1024; // 512 frequency bins (~43Hz resolution for sub-bass)
      this.analyserNode.smoothingTimeConstant = 0.75;

      this.leftAnalyser = this.audioContext.createAnalyser();
      this.leftAnalyser.fftSize = 1024;
      this.leftAnalyser.smoothingTimeConstant = 0.75;

      this.rightAnalyser = this.audioContext.createAnalyser();
      this.rightAnalyser.fftSize = 1024;
      this.rightAnalyser.smoothingTimeConstant = 0.75;

      const splitter = this.audioContext.createChannelSplitter(2);

      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = this.userVolume;

      this.sourceNode = this.audioContext.createMediaElementSource(this.audioElement);
      // Retain strong global references to prevent Chromium V8 GC from severing audio mid-stream on mobile
      if (typeof window !== 'undefined') {
        (window as any).__p2p_audio_ctx = this.audioContext;
        (window as any).__p2p_source_node = this.sourceNode;
      }

      // Route audio: source -> main analyser -> gain -> speakers
      this.sourceNode.connect(this.analyserNode);
      this.analyserNode.connect(this.gainNode);
      this.gainNode.connect(this.audioContext.destination);

      // Route stereo separation: source -> splitter -> left/right analysers
      this.sourceNode.connect(splitter);
      splitter.connect(this.leftAnalyser, 0);
      splitter.connect(this.rightAnalyser, 1);

      this.freqData = new Uint8Array(this.analyserNode.frequencyBinCount);
      this.timeData = new Uint8Array(this.analyserNode.fftSize);
      this.leftFreqData = new Uint8Array(this.leftAnalyser.frequencyBinCount);
      this.leftTimeData = new Uint8Array(this.leftAnalyser.fftSize);
      this.rightFreqData = new Uint8Array(this.rightAnalyser.frequencyBinCount);
      this.rightTimeData = new Uint8Array(this.rightAnalyser.fftSize);
    } catch (err) {
      console.warn("[Player] AudioContext / Analyser init notice:", err);
    }
  }

  public ensureAudioContextRunning(): Promise<void> {
    if (!this.audioContext) {
      this.setupAudioAnalyser();
    }
    if (this.audioContext && this.audioContext.state !== 'running' && this.audioContext.state !== 'closed') {
      return this.audioContext.resume().catch(() => {});
    }
    return Promise.resolve();
  }

  public getAudioVisualData(): AudioVisualData | null {
    if (!this.analyserNode) {
      this.setupAudioAnalyser();
    }
    if (
      !this.analyserNode ||
      !this.freqData ||
      !this.timeData ||
      !this.leftAnalyser ||
      !this.leftFreqData ||
      !this.leftTimeData ||
      !this.rightAnalyser ||
      !this.rightFreqData ||
      !this.rightTimeData
    ) {
      return null;
    }

    if (this.audioContext && this.audioContext.state !== 'running' && this.audioContext.state !== 'closed' && !this.audioElement.paused) {
      this.audioContext.resume().catch(() => {});
    }

    this.analyserNode.getByteFrequencyData(this.freqData as any);
    this.analyserNode.getByteTimeDomainData(this.timeData as any);
    this.leftAnalyser.getByteFrequencyData(this.leftFreqData as any);
    this.leftAnalyser.getByteTimeDomainData(this.leftTimeData as any);
    this.rightAnalyser.getByteFrequencyData(this.rightFreqData as any);
    this.rightAnalyser.getByteTimeDomainData(this.rightTimeData as any);

    return {
      freq: this.freqData,
      time: this.timeData,
      leftFreq: this.leftFreqData,
      leftTime: this.leftTimeData,
      rightFreq: this.rightFreqData,
      rightTime: this.rightTimeData,
      sampleRate: this.audioContext?.sampleRate || 44100
    };
  }

  private setOwnedBlobSource(blob: Blob): string {
    if (this.ownedBlobUrl) {
      URL.revokeObjectURL(this.ownedBlobUrl);
    }
    this.ownedBlobUrl = URL.createObjectURL(blob);
    return this.ownedBlobUrl;
  }

  public async resumeSync() {
    // Synchronously unlock both AudioContext and HTMLAudioElement inside the user gesture (critical for iOS Safari)
    const ctxPromise = this.ensureAudioContextRunning();
    const hasValidSrc = Boolean(this.audioElement.src) && !this.audioElement.error && this.audioElement.networkState !== HTMLMediaElement.NETWORK_NO_SOURCE;
    const gesturePlay = hasValidSrc ? this.audioElement.play().catch(() => {}) : Promise.resolve();

    await Promise.all([ctxPromise, gesturePlay]);

    // If the audio element has an error or no valid source, recreate fresh blob URL from disk
    if (this.currentTrackId && (this.audioElement.error || !this.audioElement.src || this.audioElement.networkState === HTMLMediaElement.NETWORK_NO_SOURCE)) {
      console.log('[Player] resumeSync: Audio in unready/error state, refreshing from storage...');
      const cached = await getTrackFromDisk(this.currentTrackId);
      if (cached && cached.blob) {
        const mimeType = cached.manifest?.mimeType || 'audio/flac';
        const freshBlob = cached.blob.slice(0, cached.blob.size, mimeType);
        this.attachSource(this.setOwnedBlobSource(freshBlob));
      }
    }

    this.syncPlaybackPosition(true);
    try {
      await this.audioElement.play();
    } catch (e) {
      console.warn('[Player] resumeSync play notice:', e);
    }
  }

  public loadDirectFile(file: File, manifest: TrackManifest) {
    this.ensureAudioContextRunning();
    this.registerManifest(manifest);
    this.currentTrackId = manifest.trackId;
    this.errorRetryCount = 0;
    if (this.currentTrackBuffer) {
      this.currentTrackBuffer.destroy();
      this.currentTrackBuffer = null;
    }
    this.audioElement.src = this.setOwnedBlobSource(file);
    if (this.onTrackChange) this.onTrackChange(manifest);
    this.syncPlaybackPosition();
    return this.audioElement.play();
  }

  public getMissingChunksInfo(): { trackId: string; missingIndexes: number[] } | null {
    if (this.currentTrackId && this.currentTrackBuffer && !this.currentTrackBuffer.isComplete) {
      const missingIndexes = this.currentTrackBuffer.getMissingChunkIndexes();
      if (missingIndexes.length > 0) return { trackId: this.currentTrackId, missingIndexes };
    }
    if (this.nextTrackId && this.nextTrackBuffer && !this.nextTrackBuffer.isComplete) {
      const missingIndexes = this.nextTrackBuffer.getMissingChunkIndexes();
      if (missingIndexes.length > 0) return { trackId: this.nextTrackId, missingIndexes };
    }
    return null;
  }

  public registerManifest(manifest: TrackManifest) {
    this.trackManifests.set(manifest.trackId, manifest);
    if (this.currentTrackBuffer && this.currentTrackBuffer.manifest.trackId === manifest.trackId) {
      this.currentTrackBuffer.manifest = manifest;
    }
    if (this.nextTrackBuffer && this.nextTrackBuffer.manifest.trackId === manifest.trackId) {
      this.nextTrackBuffer.manifest = manifest;
    }
  }

  private createTrackBuffer(manifest: TrackManifest): TrackBuffer {
    const buf = new TrackBuffer(manifest);
    buf.onComplete = (blob, _blobUrl) => {
      saveTrackToCache(manifest.trackId, manifest, blob);
      if (this.currentTrackId === manifest.trackId) {
        this.mountCurrentTrack();
      }
    };
    return buf;
  }

  public handleIncomingChunk(trackId: string, chunkIndex: number, totalChunks: number, data: ArrayBuffer): boolean {
    if (!this.currentTrackId && this.trackManifests.has(trackId)) {
      this.currentTrackId = trackId;
    }

    const getOrCreateManifest = (id: string): TrackManifest => {
      const existing = this.trackManifests.get(id);
      if (existing) return existing;
      const fallback: TrackManifest = {
        trackId: id,
        title: 'Track ' + id,
        artist: 'Unknown Artist',
        album: 'Live Transmission',
        duration: 0,
        mimeType: 'audio/flac',
        totalSize: totalChunks * 49152,
        totalChunks,
      };
      this.trackManifests.set(id, fallback);
      return fallback;
    };

    let targetBuffer: TrackBuffer | null = null;

    if (this.currentTrackId === trackId) {
      if (!this.currentTrackBuffer || this.currentTrackBuffer.manifest.trackId !== trackId) {
        if (this.currentTrackBuffer) this.currentTrackBuffer.destroy();
        this.currentTrackBuffer = this.createTrackBuffer(getOrCreateManifest(trackId));
      }
      targetBuffer = this.currentTrackBuffer;
    } else if (this.nextTrackId === trackId) {
      if (!this.nextTrackBuffer || this.nextTrackBuffer.manifest.trackId !== trackId) {
        if (this.nextTrackBuffer) this.nextTrackBuffer.destroy();
        this.nextTrackBuffer = this.createTrackBuffer(getOrCreateManifest(trackId));
      }
      targetBuffer = this.nextTrackBuffer;
    } else if (!this.currentTrackBuffer) {
      this.currentTrackId = trackId;
      this.currentTrackBuffer = this.createTrackBuffer(getOrCreateManifest(trackId));
      targetBuffer = this.currentTrackBuffer;
    } else if (!this.nextTrackBuffer) {
      // Stage early next-track chunks arriving before station_state updates nextTrackId
      this.nextTrackId = trackId;
      this.nextTrackBuffer = this.createTrackBuffer(getOrCreateManifest(trackId));
      targetBuffer = this.nextTrackBuffer;
    }

    if (!targetBuffer) return false;

    targetBuffer.addChunk(chunkIndex, data);

    if (this.onBufferProgress) {
      this.onBufferProgress(
        this.currentTrackBuffer ? this.currentTrackBuffer.progress : 0,
        this.nextTrackBuffer ? this.nextTrackBuffer.progress : 0
      );
    }

    // If current track is complete, mount it
    if (targetBuffer === this.currentTrackBuffer && targetBuffer.isComplete) {
      this.mountCurrentTrack();
    }
    return true;
  }

  public updateStationTimeline(state: StationState) {
    // Cache any manifests received from state
    if (state.trackManifests) {
      for (const m of Object.values(state.trackManifests)) {
        this.registerManifest(m);
      }
    }

    const currentTrackChanged = this.currentTrackId !== state.currentTrackId;
    const nextTrackChanged = this.nextTrackId !== state.nextTrackId;

    this.currentTrackId = state.currentTrackId;
    this.nextTrackId = state.nextTrackId;
    this.stationStartedAt = state.startedAt;
    this.isPlaying = state.isPlaying;

    if (currentTrackChanged) {
      this.handleTrackSwitch();
    } else if (nextTrackChanged) {
      this.handleNextTrackSwitch();
    }

    // Check drift and sync position
    this.syncPlaybackPosition();
  }

  private handleNextTrackSwitch() {
    // If the next track buffer held a different track, destroy it
    if (this.nextTrackBuffer && this.nextTrackBuffer.manifest.trackId !== this.nextTrackId) {
      this.nextTrackBuffer.destroy();
      this.nextTrackBuffer = null;
    }

    if (!this.nextTrackId) {
      if (this.onBufferProgress) {
        this.onBufferProgress(
          this.currentTrackBuffer ? this.currentTrackBuffer.progress : 0,
          0
        );
      }
      return;
    }

    const targetId = this.nextTrackId;
    // Check if new next track is already in local disk cache
    getTrackFromCache(targetId).then(cached => {
      if (cached && this.nextTrackId === cached.trackId) {
        if (!this.nextTrackBuffer) {
          this.nextTrackBuffer = this.createTrackBuffer(cached.manifest);
        }
        this.nextTrackBuffer.loadFromCachedBlob(cached.blob, cached.chunks);
        if (this.onBufferProgress) {
          this.onBufferProgress(
            this.currentTrackBuffer ? this.currentTrackBuffer.progress : 0,
            100
          );
        }
      } else {
        const manifest = this.trackManifests.get(targetId);
        if (manifest && (!this.nextTrackBuffer || this.nextTrackBuffer.manifest.trackId !== targetId)) {
          if (this.nextTrackBuffer) this.nextTrackBuffer.destroy();
          this.nextTrackBuffer = this.createTrackBuffer(manifest);
        }
        if (this.onBufferProgress) {
          this.onBufferProgress(
            this.currentTrackBuffer ? this.currentTrackBuffer.progress : 0,
            this.nextTrackBuffer ? this.nextTrackBuffer.progress : 0
          );
        }
      }
    });
  }

  private handleTrackSwitch() {
    this.errorRetryCount = 0;
    this.audioElement.playbackRate = 1.0;
    if (this.onSourceMounted) this.onSourceMounted(false);

    if (!this.currentTrackId) {
      this.audioElement.pause();
      this.audioElement.removeAttribute('src');
      this.audioElement.load();
      if (this.onTrackChange) this.onTrackChange(null);
      return;
    }

    const manifest = this.trackManifests.get(this.currentTrackId);
    if (this.onTrackChange) this.onTrackChange(manifest || null);

    // If next buffer was already initialized for this track, check if complete
    if (this.nextTrackBuffer && this.nextTrackBuffer.manifest.trackId === this.currentTrackId) {
      if (this.currentTrackBuffer) this.currentTrackBuffer.destroy();
      this.currentTrackBuffer = this.nextTrackBuffer;
      this.nextTrackBuffer = null;

      if (this.currentTrackBuffer.isComplete && this.currentTrackBuffer.blobUrl) {
        this.mountCurrentTrack();
      } else {
        // Buffer is not complete yet! Unload previous track so it does not continue playing
        this.audioElement.pause();
        this.audioElement.removeAttribute('src');
        this.audioElement.load();
        const missing = this.currentTrackBuffer.getMissingChunkIndexes();
        console.warn(`[Player] Promoted track ${this.currentTrackId} buffer incomplete (${this.currentTrackBuffer.progress}%). Requesting ${missing.length} missing chunks...`);
        if (this.onRequestMissingChunks) {
          this.onRequestMissingChunks(this.currentTrackId, missing);
        }
      }
    } else {
      // Re-initialize buffer for new track
      if (this.currentTrackBuffer) this.currentTrackBuffer.destroy();
      // Unload previous track so it does not continue playing
      this.audioElement.pause();
      this.audioElement.removeAttribute('src');
      this.audioElement.load();

      if (manifest) {
        this.currentTrackBuffer = this.createTrackBuffer(manifest);
      }

      // Check if this track is already in local IndexedDB cache!
      getTrackFromCache(this.currentTrackId).then(cached => {
        if (cached && this.currentTrackId === cached.trackId) {
          console.log(`[Player] Loaded "${cached.manifest.title}" instantly from local cache!`);
          this.currentTrackBuffer?.loadFromCachedBlob(cached.blob, cached.chunks);
          if (this.onBufferProgress) {
            this.onBufferProgress(100, this.nextTrackBuffer ? this.nextTrackBuffer.progress : 0);
          }
          this.mountCurrentTrack();
        } else {
          // Track not in cache and buffer fresh: request all chunks
          if (this.onRequestMissingChunks && this.currentTrackId) {
            this.onRequestMissingChunks(this.currentTrackId);
          }
        }
      });
    }

    // Also pre-check if next track is in cache
    if (this.nextTrackId) {
      getTrackFromCache(this.nextTrackId).then(cached => {
        if (cached && this.nextTrackId === cached.trackId) {
          if (!this.nextTrackBuffer) {
            this.nextTrackBuffer = this.createTrackBuffer(cached.manifest);
          }
          this.nextTrackBuffer.loadFromCachedBlob(cached.blob, cached.chunks);
          if (this.onBufferProgress) {
            this.onBufferProgress(
              this.currentTrackBuffer ? this.currentTrackBuffer.progress : 0,
              100
            );
          }
        }
      });
    }
  }

  private mountCurrentTrack() {
    if (!this.currentTrackBuffer || !this.currentTrackBuffer.blobUrl) return;

    // Do NOT re-mount if already mounted to this exact URL
    if (this.audioElement.src === this.currentTrackBuffer.blobUrl) {
      this.ensureAudioContextRunning();
      this.syncPlaybackPosition();
      return;
    }

    console.log(`[Player] Mounting current track: ${this.currentTrackBuffer.manifest.title}`);
    this.attachSource(this.currentTrackBuffer.blobUrl);
  }

  private attachSource(url: string) {
    this.audioElement.src = url;
    if (this.onSourceMounted) this.onSourceMounted(true);

    let startedForThisUrl = false;
    const onReadyToPlay = () => {
      if (startedForThisUrl) return;
      startedForThisUrl = true;

      this.ensureAudioContextRunning();
      this.syncPlaybackPosition(true); // initial stream alignment
      if (this.isPlaying && this.audioElement.paused) {
        this.audioElement.play().catch(e => {
          if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') {
            console.warn("[Player] Playback notice:", e);
          }
        });
      }
    };

    this.audioElement.onloadedmetadata = onReadyToPlay;
    this.audioElement.oncanplay = onReadyToPlay;
    this.audioElement.load();
  }

  public syncPlaybackPosition(isInitialSeek = false) {
    if (!this.audioElement.src) return;

    if (!this.isPlaying) {
      if (!this.audioElement.paused) {
        this.audioElement.playbackRate = 1.0;
        this.audioElement.pause();
      }
      return;
    }

    if (!this.stationStartedAt) return;

    const now = getSyncedTime();
    const targetOffset = Math.max(0, (now - this.stationStartedAt) / 1000);
    const manifest = this.currentTrackId ? this.trackManifests.get(this.currentTrackId) : null;
    const trackDur = manifest?.duration || (this.audioElement.duration && !isNaN(this.audioElement.duration) && this.audioElement.duration > 0 ? this.audioElement.duration : Infinity);

    // Check seekable range safety before any seek operation
    const canSeekToTarget = () => {
      try {
        const ranges = this.audioElement.seekable;
        if (!ranges || ranges.length === 0) return true;
        const rangeEnd = ranges.end(ranges.length - 1);
        if (rangeEnd < 5.0 && trackDur > 10.0) {
          return targetOffset >= 0 && targetOffset <= trackDur;
        }
        return targetOffset >= ranges.start(0) && targetOffset <= rangeEnd;
      } catch {
        return true;
      }
    };

    if (this.audioElement.readyState >= 1 && targetOffset < trackDur) {
      const diff = targetOffset - this.audioElement.currentTime;
      const drift = Math.abs(diff);

      if (isInitialSeek) {
        // Initial stream jump on track load if more than 1s into song
        if (targetOffset > 1.0 && canSeekToTarget() && !this.audioElement.seeking) {
          console.log(`[SyncEngine] Initial stream alignment to ${targetOffset.toFixed(2)}s`);
          try {
            this.audioElement.currentTime = targetOffset;
          } catch (e) {
            console.warn('[SyncEngine] Initial seek notice:', e);
          }
        }
      } else {
        // Ongoing playback drift compensation:
        // For small drift (0.15s - 3.0s), use smooth micro-speed adjustments (+/- 3%)!
        // Never hard-seek during playback! This eliminates audio stutter and mobile decoder stalls.
        if (drift >= 0.15 && drift <= 3.0) {
          if (diff > 0) {
            // Audio is behind by 0.15s - 3.0s: speed up slightly (+3%) to catch up
            this.audioElement.playbackRate = 1.03;
          } else {
            // Audio is ahead by 0.15s - 3.0s: slow down slightly (-3%) to let station catch up
            this.audioElement.playbackRate = 0.97;
          }
        } else if (drift < 0.15) {
          // Perfectly synced! Keep normal 1.0x rate
          if (this.audioElement.playbackRate !== 1.0) {
            this.audioElement.playbackRate = 1.0;
          }
        } else if (drift > 3.0 && canSeekToTarget() && !this.audioElement.seeking) {
          // Massive drift (>3.0s): jump
          console.log(`[SyncEngine] Large drift (${drift.toFixed(2)}s), hard seeking to ${targetOffset.toFixed(2)}s`);
          this.audioElement.playbackRate = 1.0;
          try {
            this.audioElement.currentTime = targetOffset;
          } catch (e) {
            console.warn('[SyncEngine] Large drift seek notice:', e);
          }
        }
      }
    }

    if (this.isPlaying && this.audioElement.paused) {
      this.ensureAudioContextRunning();
      this.audioElement.play().catch(() => {});
    } else if (!this.isPlaying && !this.audioElement.paused) {
      this.audioElement.playbackRate = 1.0;
      this.audioElement.pause();
    }
  }

  public setVolume(vol: number) {
    this.userVolume = Math.max(0, Math.min(1, vol));
    if (this.gainNode) {
      this.gainNode.gain.value = this.userVolume;
    } else {
      this.audioElement.volume = this.userVolume;
    }
  }

  public play() {
    this.ensureAudioContextRunning();
    return this.audioElement.play();
  }

  public pause() {
    this.audioElement.pause();
  }

  public seek(timeInSeconds: number) {
    if (this.audioElement) {
      this.audioElement.currentTime = timeInSeconds;
    }
  }

  public destroy() {
    clearInterval(this.syncTimer);
    if (this.ownedBlobUrl) {
      URL.revokeObjectURL(this.ownedBlobUrl);
      this.ownedBlobUrl = null;
    }
    this.audioElement.pause();
    this.audioElement.removeAttribute('src');
    if (this.currentTrackBuffer) this.currentTrackBuffer.destroy();
    if (this.nextTrackBuffer) this.nextTrackBuffer.destroy();
  }
}
