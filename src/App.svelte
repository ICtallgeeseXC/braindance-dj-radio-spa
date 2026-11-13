<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Tween } from 'svelte/motion';
  import { cubicOut } from 'svelte/easing';
  import { P2PMesh, type StationState, type PeerNodeInfo, type ToastVariant, type StationActionEvent } from './lib/p2p-mesh';
  import { PlayerController } from './lib/player-controller';
  import { parseAudioFile } from './lib/audio-metadata';
  import { CHUNK_SIZE, type TrackManifest } from './lib/chunk-pipeline';
  import { syncNetworkTime, getSyncedTime } from './lib/time-sync';
  import { readTrackChunkFromDisk, getTrackFromDisk } from './lib/audio-storage';
  import { compressAudioTo128kMp3 } from './lib/audio-encoder';
  import PyramidTree from './lib/PyramidTree.svelte';
  import EvaTimer from './lib/EvaTimer.svelte';
  import EvaBufferAnalysis from './lib/EvaBufferAnalysis.svelte';
  import SeeleMonolith from './lib/SeeleMonolith.svelte';
  import MagiComputing from './lib/MagiComputing.svelte';
  import SystemDialog from './lib/SystemDialog.svelte';
  import SystemToast, { type ToastItem } from './lib/SystemToast.svelte';

  let toasts = $state<ToastItem[]>([]);
  let toastSeq = 0;
  let lastSeenActionId = '';
  let hasInitialListenerSync = false;

  function dismissToast(id: string) {
    toasts = toasts.filter((t) => t.id !== id);
  }

  function pushToast(variant: ToastVariant, message: string, durationMs = 3500) {
    const id = `toast-${Date.now()}-${++toastSeq}`;
    toasts = [...toasts.slice(-4), { id, variant, message, durationMs }];
    setTimeout(() => dismissToast(id), durationMs + 80);
  }

  function createDjAction(variant: ToastVariant, message: string): StationActionEvent {
    pushToast(variant, message);
    return {
      id: `${Date.now()}-${++toastSeq}`,
      variant,
      message
    };
  }

  let systemDialog = $state<{
    open: boolean;
    variant: 'critical' | 'warning';
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    onConfirm?: () => void;
    onCancel?: () => void;
  }>({
    open: false,
    variant: 'critical',
    title: '',
    message: ''
  });

  let abortArmed = $state(false);

  function triggerAbortSequence() {
    abortArmed = true;
    systemDialog = {
      open: true,
      variant: 'critical',
      title: 'SELF-DESTRUCT // ABORT LINK',
      message:
        mode === 'dj'
          ? 'Terminating this link will shut down the DJ broadcast origin and disconnect all listeners. Confirm link termination?'
          : 'Severing this P2P audio link will disconnect your receiver from the station mesh. Confirm link termination?',
      confirmLabel: 'CONFIRM',
      cancelLabel: 'ABORT',
      onConfirm: () => {
        systemDialog.open = false;
        abortArmed = false;
        window.location.hash = '';
        window.location.reload();
      },
      onCancel: () => {
        systemDialog.open = false;
        abortArmed = false;
      }
    };
  }

  function openStationConflictDialog(conflictId: string) {
    systemDialog = {
      open: true,
      variant: 'critical',
      title: 'STATION CALLSIGN CONFLICT',
      message: `Station "${conflictId}" is already live with another DJ! Choose a different callsign or tune in as a listener.`,
      confirmLabel: 'ACKNOWLEDGE',
      cancelLabel: 'TUNE IN AS LISTENER',
      onConfirm: () => {
        systemDialog.open = false;
      },
      onCancel: () => {
        systemDialog.open = false;
        stationCode = conflictId;
        joinAsListener();
      }
    };
  }

  // App mode
  let mode = $state<'select' | 'dj' | 'listener'>('select');
  let stationCode = $state<string>(
    (typeof localStorage !== 'undefined' && localStorage.getItem('p2p_station_code')) || ''
  );
  let showBufferAnalysis = $state<boolean>(false);

  // DJ State
  let djFiles = $state<File[]>([]);
  let trackManifests = $state<Map<string, TrackManifest>>(new Map());
  let playlist = $state<string[]>([]); // trackIds in order
  let isShuffled = $state<boolean>(false);
  let isBroadcasting = $state<boolean>(false);
  let djActiveTrackIndex = $state<number>(0);
  let uploadProcessing = $state<boolean>(false);
  let autoCompressMp3 = $state<boolean>(
    typeof localStorage !== 'undefined' && localStorage.getItem('p2p_auto_compress_mp3') !== null
      ? localStorage.getItem('p2p_auto_compress_mp3') === 'true'
      : true
  );
  let compressStatus = $state<string>('');

  $effect(() => {
    try {
      localStorage.setItem('p2p_auto_compress_mp3', String(autoCompressMp3));
    } catch {}
  });

  $effect(() => {
    try {
      localStorage.setItem('p2p_station_code', stationCode.trim());
    } catch {}
  });

  // Progressive Phase Rail buffer tweens (smooth 0 -> 100% sweep even on instant loads)
  const priBufferTween = new Tween(0, { duration: 650, easing: cubicOut });
  const auxBufferTween = new Tween(0, { duration: 650, easing: cubicOut });
  let lastPriTrackId = '';
  let lastAuxTrackId = '';

  $effect(() => {
    const tId = currentTrack?.trackId || '';
    const target = mode === 'dj' ? (currentTrack ? 100 : 0) : currentBufferProgress;
    if (tId !== lastPriTrackId) {
      lastPriTrackId = tId;
      priBufferTween.set(0, { duration: 0 });
    }
    priBufferTween.set(target, { duration: target > 0 ? 650 : 180 });
  });

  $effect(() => {
    const nId = nextTrack?.trackId || '';
    const target = nextTrack ? nextBufferProgress : 0;
    if (nId !== lastAuxTrackId) {
      lastAuxTrackId = nId;
      auxBufferTween.set(0, { duration: 0 });
    }
    auxBufferTween.set(target, { duration: target > 0 ? 650 : 180 });
  });

  // Mesh & Player Instances
  let mesh: P2PMesh | null = null;
  let player: PlayerController | null = null;
  let peers = $state<PeerNodeInfo[]>([]);
  let myPeerId = $state<string>('');
  let statusLogs = $state<string[]>([]);

  // SEELE Monolith Telemetry Identifier: '00' for DJ, assigned listener number for listeners
  let monolithNumber = $derived.by(() => {
    if (mode === 'dj') {
      return '00';
    }
    if (mode === 'listener') {
      const listeners = peers.filter(p => p.role === 'listener');
      const idx = listeners.findIndex(p => p.peerId === myPeerId);
      if (idx !== -1) {
        return String(idx + 1).padStart(2, '0');
      }
      return '01';
    }
    return '00';
  });

  // Live P2P transport & signal health for the BLOOD_TYPE telemetry cell
  let bloodTypeStatus = $derived.by(() => {
    if (mode === 'select') {
      return {
        label: 'PATTERN: STANDBY',
        tone: 'amber' as const,
        tooltip: 'NO ACTIVE STATION LINK'
      };
    }
    if (mode === 'dj') {
      const listeners = peers.filter(p => p.role === 'listener');
      if (listeners.length === 0) {
        return {
          label: 'PATTERN: BLUE [ORIGIN]',
          tone: 'cyan' as const,
          tooltip: 'DJ ORIGIN ONLINE • AWAITING LISTENERS'
        };
      }
      const relayCount = listeners.filter(p => p.transport === 'relay').length;
      const webrtcCount = listeners.length - relayCount;
      if (relayCount > 0 && webrtcCount === 0) {
        return {
          label: 'PATTERN: AMBER [RELAY]',
          tone: 'amber' as const,
          tooltip: `${relayCount} LISTENER(S) ON TUNNEL RELAY`
        };
      }
      if (relayCount > 0) {
        return {
          label: 'PATTERN: BLUE [HYBRID]',
          tone: 'cyan' as const,
          tooltip: `${webrtcCount} WEBRTC • ${relayCount} RELAY`
        };
      }
      return {
        label: 'PATTERN: BLUE [P2P]',
        tone: 'cyan' as const,
        tooltip: `${webrtcCount} DIRECT WEBRTC ${webrtcCount === 1 ? 'PEER' : 'PEERS'}`
      };
    }

    if (peers.length === 0) {
      return {
        label: 'PATTERN: RED [SEEK]',
        tone: 'danger' as const,
        tooltip: 'SEARCHING FOR STATION MESH'
      };
    }
    const me = peers.find(p => p.peerId === myPeerId);
    if (me?.transport === 'relay') {
      return {
        label: 'PATTERN: AMBER [RELAY]',
        tone: 'amber' as const,
        tooltip: 'CONNECTED VIA TUNNEL RELAY FALLBACK'
      };
    }
    return {
      label: 'PATTERN: BLUE [P2P]',
      tone: 'cyan' as const,
      tooltip: 'CONNECTED VIA DIRECT WEBRTC MESH'
    };
  });

  // Playback & Buffer Indicators
  let currentTrack = $state<TrackManifest | null>(null);
  let nextTrack = $state<TrackManifest | null>(null);
  let currentBufferProgress = $state<number>(0);
  let nextBufferProgress = $state<number>(0);
  const isBufferView = $derived((mode === 'listener' && currentBufferProgress < 100) || showBufferAnalysis);
  let currentTime = $state<number>(0);
  let duration = $state<number>(0);
  let isPlaying = $state<boolean>(false);
  let volume = $state<number>(0.8);
  let stationStartTime = $state<number>(0);

  // Unthrottled macrotask scheduler (bypasses Android background tab timer throttling)
  function yieldUnthrottled(): Promise<void> {
    if (typeof MessageChannel !== 'undefined') {
      return new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(null);
      });
    }
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  let isAudioActuallyPlaying = $state<boolean>(false);
  let sourceMounted = $state<boolean>(false);
  let addingTracks = $state<boolean>(false);
  let deferredInstallPrompt = $state<any>(null);

  async function handleInstallPwa() {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    console.log('[PWA] Install prompt outcome:', choice?.outcome);
    deferredInstallPrompt = null;
  }

  // DJ: trackId -> File (independent of playlist order, so shuffle/append never misaligns files)
  const trackFiles = new Map<string, File>();

  // Auto-join if hash present (#station-id)
  onMount(async () => {
    await syncNetworkTime();
    mesh = new P2PMesh();
    myPeerId = mesh.peerId;
    player = new PlayerController();

    // Register Player listeners
    let lastBufferUiUpdate = 0;
    player.onBufferProgress = (cur, next) => {
      if (mode === 'listener') {
        mesh?.reportBufferProgress(cur);
        const now = performance.now();
        if (cur === 0 || cur >= 100 || now - lastBufferUiUpdate >= 150) {
          lastBufferUiUpdate = now;
          currentBufferProgress = cur;
          nextBufferProgress = next;
        }
      }
    };

    player.onPlayStateChange = (playing) => {
      isAudioActuallyPlaying = playing;
    };

    player.onSourceMounted = (mounted) => {
      sourceMounted = mounted;
    };

    player.onTimeUpdate = (c, d) => {
      currentTime = c;
      duration = d;
    };

    player.onTrackChange = (manifest) => {
      currentTrack = manifest;
    };

    // Auto-repeat loop when track ends!
    player.onTrackEnded = () => {
      if (mode === 'dj' && playlist.length > 0) {
        console.log("[DJ Auto-Repeat] Track ended, advancing to next in queue");
        skipNext();
      }
    };

    player.onRequestMissingChunks = (trackId, missingIndexes) => {
      if (mode === 'listener' && mesh) {
        mesh.requestMissingTrackChunks(trackId, missingIndexes);
      }
    };

    // Register Mesh listeners
    mesh.onTreeUpdated = (updatedPeers) => {
      peers = updatedPeers;
    };

    mesh.onStatusMessage = (msg) => {
      statusLogs = [msg, ...statusLogs.slice(0, 15)];
    };

    mesh.onStationStateUpdate = (state) => {
      handleStationState(state);
    };

    mesh.onChunkReceived = (trackId, chunkIndex, totalChunks, data) => {
      // Feed local player buffer (which streams directly to OPFS disk with zero RAM bloat)
      return player ? player.handleIncomingChunk(trackId, chunkIndex, totalChunks, data) : false;
    };

    mesh.onGetMissingChunks = () => (player ? player.getMissingChunksInfo() : null);

    mesh.onStationConflict = (conflictStationId) => {
      openStationConflictDialog(conflictStationId);
      mode = 'select';
      isBroadcasting = false;
      isPlaying = false;
      player?.pause();
    };

    const repairTokens = new Map<string, number>();
    let nextRepairToken = 0;

    // When a child asks for track chunks, stream from disk with paced chunks and backpressure
    mesh.onRequestTrackChunks = async (targetPeerId, reqTrackId, missingIndexes) => {
      const seedTrackChunks = async (targetId: string) => {
        const key = `${targetPeerId}:${targetId}`;
        const token = ++nextRepairToken;
        repairTokens.set(key, token);

        // 1. Check if we have the file directly in DJ trackFiles
        let sourceBlob: Blob | File | null = trackFiles.get(targetId) || null;
        let manifest: TrackManifest | undefined = trackManifests.get(targetId);

        // 2. If not in memory (Listener), fetch disk handle from OPFS / Cache API
        if (!sourceBlob) {
          const diskTrack = await getTrackFromDisk(targetId);
          if (diskTrack) {
            sourceBlob = diskTrack.blob;
            if (!manifest && diskTrack.manifest) {
              manifest = diskTrack.manifest;
            }
          }
        }

        if (!sourceBlob || repairTokens.get(key) !== token) return;

        const totalChunks = manifest?.totalChunks || Math.ceil(sourceBlob.size / CHUNK_SIZE);
        const indexesToSend: number[] = (missingIndexes && missingIndexes.length > 0)
          ? missingIndexes.filter(idx => idx >= 0 && idx < totalChunks)
          : Array.from({ length: totalChunks }, (_, k) => k);

        console.log(`[P2P Relay] Paced disk-seeding of ${indexesToSend.length} chunks (track: ${targetId}) to child ${targetPeerId}`);
        const MAX_BUFFERED_BYTES = 256 * 1024;

        for (let i = 0; i < indexesToSend.length; i++) {
          if (repairTokens.get(key) !== token || !mesh || !mesh.isPeerActive(targetPeerId)) break;

          const chunkIdx = indexesToSend[i];
          // Apply backpressure if target peer's queue or socket buffer exceeds threshold
          while (mesh && mesh.isPeerActive(targetPeerId) && repairTokens.get(key) === token && mesh.getPeerBufferedAmount(targetPeerId) > MAX_BUFFERED_BYTES) {
            await new Promise(r => setTimeout(r, 20));
          }
          if (repairTokens.get(key) !== token || !mesh || !mesh.isPeerActive(targetPeerId)) break;

          const chunkData = await readTrackChunkFromDisk(targetId, chunkIdx, CHUNK_SIZE, sourceBlob);
          if (chunkData && repairTokens.get(key) === token) {
            mesh?.sendChunkToPeer(targetPeerId, targetId, chunkIdx, totalChunks, chunkData);
          }

          // Unthrottled yield every 3 chunks to prevent blocking event loop without mobile timer clamp
          if (i % 3 === 0) {
            await yieldUnthrottled();
          }
        }
      };

      if (reqTrackId && reqTrackId !== 'current') {
        await seedTrackChunks(reqTrackId);
      } else {
        if (currentTrack) await seedTrackChunks(currentTrack.trackId);
        if (nextTrack) await seedTrackChunks(nextTrack.trackId);
      }
    };

    // Check URL hash - populate stationCode and auto-tune if station is live
    const hash = window.location.hash.replace('#', '').trim();
    if (hash) {
      stationCode = hash;
      try {
        const res = await fetch(`/__p2p_relay/status?station=${encodeURIComponent(hash.toLowerCase())}`);
        if (res.ok) {
          const status = await res.json();
          if (status?.live && mode === 'select') {
            joinAsListener();
          }
        }
      } catch {
        // Ignore if status endpoint is unavailable (e.g. static-only host)
      }
    }

    // Capture PWA install prompt
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onAppInstalled);
  });

  function onBeforeInstall(e: Event) {
    e.preventDefault();
    deferredInstallPrompt = e;
  }

  function onAppInstalled() {
    deferredInstallPrompt = null;
    console.log('[PWA] PYRAMID // RADIO installed successfully');
  }

  onDestroy(() => {
    window.removeEventListener('beforeinstallprompt', onBeforeInstall);
    window.removeEventListener('appinstalled', onAppInstalled);
    mesh?.destroy();
    player?.destroy();
  });

  // --- DJ Actions ---

  // Parse (and optionally transcode) files, registering them in the playlist. Returns new trackIds.
  async function ingestFiles(files: File[]): Promise<string[]> {
    const added: string[] = [];

    for (let idx = 0; idx < files.length; idx++) {
      let file = files[idx];
      compressStatus = `Processing track ${idx + 1}/${files.length}: ${file.name}...`;

      // If auto-compress is enabled and file is not already a small mp3
      if (autoCompressMp3) {
        try {
          compressStatus = `Transcoding ${idx + 1}/${files.length} to 128k MP3... 0%`;
          file = await compressAudioTo128kMp3(file, file.name, (pct) => {
            compressStatus = `Transcoding ${idx + 1}/${files.length} to 128k MP3... ${pct}%`;
          });
        } catch (err) {
          console.warn(`[DJ Compressor] Failed to transcode ${file.name}, using original:`, err);
        }
      }

      const meta = await parseAudioFile(file);
      const trackId = 't_' + Math.random().toString(36).substring(2, 9);
      const manifest: TrackManifest = {
        trackId,
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        duration: meta.duration,
        mimeType: meta.mimeType,
        totalSize: meta.sizeBytes,
        totalChunks: Math.ceil(meta.sizeBytes / CHUNK_SIZE),
        coverDataUrl: meta.coverUrl,
      };

      djFiles.push(file);
      trackFiles.set(trackId, file);
      trackManifests.set(trackId, manifest);
      playlist.push(trackId);
      added.push(trackId);

      // Yield execution to the browser event loop so UI can repaint and remain responsive
      await new Promise((r) => setTimeout(r, 0));
    }

    return added;
  }

  async function handleFilesSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    uploadProcessing = true;
    compressStatus = '';

    await ingestFiles(Array.from(input.files));

    compressStatus = '';
    uploadProcessing = false;
  }

  // DJ: append songs to the live playlist without interrupting playback
  async function handleAddTracksLive(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0 || !mesh) return;
    const files = Array.from(input.files);
    input.value = ''; // allow re-selecting the same files later
    addingTracks = true;
    compressStatus = '';

    try {
      const added = await ingestFiles(files);
      if (added.length > 0) {
        statusLogs = [`[DJ] Added ${added.length} track(s) to the live playlist`, ...statusLogs.slice(0, 15)];
        const action = createDjAction(
          'success',
          `DJ INJECTED ${added.length} ${added.length === 1 ? 'TRACK' : 'TRACKS'} TO MANIFEST`
        );
        syncPlaylistToListeners(action);
      }
    } finally {
      compressStatus = '';
      addingTracks = false;
    }
  }

  function getNextTrackId(idx: number): string | null {
    return playlist[idx + 1] || (playlist.length > 1 ? playlist[0] : null);
  }

  // Push the latest playlist/manifests/next-track to all listeners and pre-buffer the new next track if it changed
  function syncPlaylistToListeners(lastAction?: StationActionEvent) {
    if (!mesh) return;
    const manifestObj: Record<string, TrackManifest> = {};
    for (const [id, m] of trackManifests.entries()) manifestObj[id] = m;

    const previousNextId = nextTrack?.trackId ?? null;
    const nextId = getNextTrackId(djActiveTrackIndex);
    nextTrack = nextId ? trackManifests.get(nextId) || null : null;

    mesh.updateStationState({
      trackManifests: manifestObj,
      playlistOrder: [...playlist],
      isShuffled,
      nextTrackId: nextId,
      ...(lastAction ? { lastAction } : {})
    });

    // If the next track changed, reset DJ next progress and pre-buffer if ready
    if (nextId && nextId !== previousNextId) {
      nextBufferProgress = 0;
      if (currentBroadcastDone) {
        preBufferNextTrack(nextId);
      }
    }
  }

  async function isStationLive(code: string): Promise<boolean> {
    try {
      const res = await fetch(`/__p2p_relay/status?station=${encodeURIComponent(code.toLowerCase().trim())}`);
      if (!res.ok) return false;
      const data = await res.json();
      return Boolean(data?.live);
    } catch {
      return false;
    }
  }

  async function startDJBroadcast() {
    if (!mesh || playlist.length === 0) return;
    const rawCode = stationCode.trim();
    if (!rawCode) {
      let candidate = 'radio-' + Math.random().toString(36).substring(2, 7);
      for (let i = 0; i < 5; i++) {
        if (!(await isStationLive(candidate))) break;
        candidate = 'radio-' + Math.random().toString(36).substring(2, 7);
      }
      stationCode = candidate;
    } else {
      const cleanCode = rawCode.toLowerCase();
      if (await isStationLive(cleanCode)) {
        openStationConflictDialog(rawCode);
        return;
      }
      stationCode = cleanCode;
    }
    history.replaceState(null, '', '#' + stationCode);

    mode = 'dj';
    isBroadcasting = true;

    try {
      const manifestObj: Record<string, TrackManifest> = {};
      for (const [id, m] of trackManifests.entries()) {
        manifestObj[id] = m;
      }
      mesh.hostStation(stationCode, manifestObj, playlist);
      myPeerId = mesh.peerId;
    } catch (e) {
      console.error("Error hosting station:", e);
    }

    // Start Track 0
    playTrackAtIndex(0);
  }

  let playToken = 0;
  let currentBroadcastDone = false;
  let preBufferToken = 0;

  async function playTrackAtIndex(idx: number) {
    if (!mesh || !player || idx < 0 || idx >= playlist.length) return;
    djActiveTrackIndex = idx;
    const token = ++playToken;
    currentBroadcastDone = false;
    nextBufferProgress = 0;

    const trackId = playlist[idx];
    const manifest = trackManifests.get(trackId);
    const file = trackFiles.get(trackId);
    if (!manifest || !file) return;

    currentTrack = manifest;
    stationStartTime = getSyncedTime();
    isPlaying = true;

    // 1. Immediately play local file directly for DJ!
    player.loadDirectFile(file, manifest).catch((e) => {
      console.warn("Local playback requires click", e);
    });

    const nextId = playlist[idx + 1] || (playlist.length > 1 ? playlist[0] : null);
    nextTrack = nextId ? trackManifests.get(nextId) || null : null;

    const manifestObj: Record<string, TrackManifest> = {};
    for (const [id, m] of trackManifests.entries()) manifestObj[id] = m;

    mesh.updateStationState({
      currentTrackId: trackId,
      startedAt: stationStartTime,
      isPlaying: true,
      nextTrackId: nextId,
      trackManifests: manifestObj,
      playlistOrder: [...playlist],
      lastAction: createDjAction('info', `NOW PLAYING: ${manifest.title}`)
    });

    // 2. Slice and broadcast chunks on demand down the P2P tree in paced, backpressure-guarded stream
    try {
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const MAX_BUFFERED_BYTES = 384 * 1024;
      for (let i = 0; i < totalChunks; i++) {
        // If track changed while broadcasting, stop
        if (playToken !== token) break;

        while (mesh && mesh.shouldThrottleBroadcast(MAX_BUFFERED_BYTES)) {
          if (playToken !== token) break;
          await new Promise(r => setTimeout(r, 20));
        }
        if (playToken !== token) break;

        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunkData = await file.slice(start, end).arrayBuffer();
        mesh?.broadcastChunk(trackId, i, totalChunks, chunkData);

        // Unthrottled yield every 3 chunks to prevent blocking event loop without mobile timer clamp
        if (i % 3 === 0) {
          await yieldUnthrottled();
        }
      }
    } catch (e) {
      console.error("[DJ] Error broadcasting current track chunks:", e);
    }
    if (playToken !== token) return;
    currentBroadcastDone = true;

    // 3. Pre-buffer next track (recomputed so live-added tracks count)
    await new Promise(r => setTimeout(r, 1500));
    if (playToken !== token) return;
    const latestNext = getNextTrackId(djActiveTrackIndex);
    if (latestNext) {
      preBufferNextTrack(latestNext);
    }
  }

  async function preBufferNextTrack(nextTrackId: string) {
    const nextFile = trackFiles.get(nextTrackId);
    const nextManifest = trackManifests.get(nextTrackId);
    if (!nextFile || !nextManifest || !mesh) return;

    const token = ++preBufferToken;
    console.log(`[DJ] Pre-broadcasting chunks for Next Track: ${nextManifest.title}`);
    if (mode === 'dj') nextBufferProgress = 0;

    try {
      const totalChunks = Math.ceil(nextFile.size / CHUNK_SIZE);
      const MAX_BUFFERED_BYTES = 384 * 1024;
      for (let i = 0; i < totalChunks; i++) {
        if (preBufferToken !== token) break;
        while (mesh && mesh.shouldThrottleBroadcast(MAX_BUFFERED_BYTES)) {
          if (preBufferToken !== token) break;
          await new Promise(r => setTimeout(r, 20));
        }
        if (preBufferToken !== token) break;

        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, nextFile.size);
        const chunkData = await nextFile.slice(start, end).arrayBuffer();
        mesh.broadcastChunk(nextTrackId, i, totalChunks, chunkData);

        if (mode === 'dj') {
          nextBufferProgress = Math.round(((i + 1) / totalChunks) * 100);
        }

        // Unthrottled yield every 3 chunks to keep main thread unblocked
        if (i % 3 === 0) {
          await yieldUnthrottled();
        }
      }
      if (preBufferToken === token && mode === 'dj') {
        nextBufferProgress = 100;
      }
    } catch (e) {
      console.error("[DJ] Error pre-broadcasting next track chunks:", e);
    }
  }

  function toggleShuffle() {
    isShuffled = !isShuffled;
    if (isShuffled) {
      const currentId = playlist[djActiveTrackIndex];
      const rest = playlist.filter(id => id !== currentId);
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      playlist = currentId ? [currentId, ...rest] : rest;
      djActiveTrackIndex = 0;
    }
    syncPlaylistToListeners(
      createDjAction('info', isShuffled ? 'DJ ENGAGED SHUFFLE QUEUE' : 'DJ DISENGAGED SHUFFLE')
    );
  }

  let draggedIndex = $state<number | null>(null);
  let dragOverIndex = $state<number | null>(null);

  function moveTrack(fromIndex: number, direction: -1 | 1) {
    const toIndex = fromIndex + direction;
    if (toIndex < 0 || toIndex >= playlist.length) return;
    reorderTracks(fromIndex, toIndex);
  }

  function reorderTracks(fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex || fromIndex < 0 || fromIndex >= playlist.length || toIndex < 0 || toIndex >= playlist.length) return;

    // Track which track ID is currently playing
    const currentPlayingId = playlist[djActiveTrackIndex];

    const newPlaylist = [...playlist];
    const [moved] = newPlaylist.splice(fromIndex, 1);
    newPlaylist.splice(toIndex, 0, moved);
    playlist = newPlaylist;

    // Preserve active index for the current playing track
    if (currentPlayingId) {
      const newActiveIdx = playlist.indexOf(currentPlayingId);
      if (newActiveIdx !== -1) {
        djActiveTrackIndex = newActiveIdx;
      }
    }

    // Manual reorder overrides active shuffle state
    if (isShuffled) isShuffled = false;

    // Sync new sequence to mesh network and listeners
    syncPlaylistToListeners(createDjAction('info', 'DJ REORDERED TRANSMISSION MANIFEST'));
    statusLogs = [`[DJ] Manifest updated: track reordered`, ...statusLogs.slice(0, 15)];
  }

  function handleDragStart(e: DragEvent, index: number) {
    draggedIndex = index;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(index));
    }
  }

  function handleDragOver(e: DragEvent, index: number) {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
    dragOverIndex = index;
  }

  function handleDragLeave(e: DragEvent, index: number) {
    if (dragOverIndex === index) {
      dragOverIndex = null;
    }
  }

  function handleDrop(e: DragEvent, targetIndex: number) {
    e.preventDefault();
    if (draggedIndex !== null && draggedIndex !== targetIndex) {
      reorderTracks(draggedIndex, targetIndex);
    }
    draggedIndex = null;
    dragOverIndex = null;
  }

  function handleDragEnd() {
    draggedIndex = null;
    dragOverIndex = null;
  }

  function skipNext() {
    const nextIdx = (djActiveTrackIndex + 1) % playlist.length;
    playTrackAtIndex(nextIdx);
  }

  function togglePlayPause() {
    if (!mesh || !player) return;
    isPlaying = !isPlaying;
    if (isPlaying) {
      stationStartTime = getSyncedTime() - (currentTime * 1000);
      mesh.updateStationState({
        isPlaying: true,
        startedAt: stationStartTime,
        lastAction: createDjAction('success', 'DJ RESUMED TRANSMISSION')
      });
      player.play();
    } else {
      mesh.updateStationState({
        isPlaying: false,
        lastAction: createDjAction('warning', 'DJ PAUSED TRANSMISSION')
      });
      player.pause();
    }
  }

  function handleSeek(fraction: number) {
    if (mode === 'dj') {
      const dur = currentTrack?.duration || duration || 0;
      if (dur <= 0) return;
      const targetTime = fraction * dur;
      currentTime = targetTime;
      stationStartTime = getSyncedTime() - (targetTime * 1000);
      mesh?.updateStationState({
        isPlaying,
        startedAt: stationStartTime,
        lastAction: createDjAction('info', `DJ SEEKED TO ${formatTime(targetTime)}`)
      });
      player?.seek(targetTime);
    }
  }

  // --- Listener Actions ---

  function joinAsListener() {
    if (!mesh || !stationCode) return;
    hasInitialListenerSync = false;
    lastSeenActionId = '';
    history.replaceState(null, '', '#' + stationCode);
    mode = 'listener';
    mesh.joinStation(stationCode);
    myPeerId = mesh.peerId;
  }

  function handleStationState(state: StationState) {
    isPlaying = state.isPlaying;
    stationStartTime = state.startedAt;

    if (state.trackManifests) {
      for (const [id, m] of Object.entries(state.trackManifests)) {
        trackManifests.set(id, m);
        player?.registerManifest(m);
      }
    }

    const prevTrackId = currentTrack?.trackId;
    if (state.currentTrackId && trackManifests.has(state.currentTrackId)) {
      currentTrack = trackManifests.get(state.currentTrackId)!;
    }

    const prevNextId = nextTrack?.trackId;
    if (state.nextTrackId && trackManifests.has(state.nextTrackId)) {
      nextTrack = trackManifests.get(state.nextTrackId)!;
    } else if (!state.nextTrackId) {
      nextTrack = null;
    }

    if (state.nextTrackId !== prevNextId && mode === 'listener') {
      nextBufferProgress = 0;
    }

    if (prevTrackId && state.currentTrackId && state.currentTrackId !== prevTrackId) {
      mesh?.resetMetricsOnTrackChange();
    }

    if (player) {
      player.updateStationTimeline(state);
    }

    if (mode === 'listener') {
      if (!hasInitialListenerSync) {
        hasInitialListenerSync = true;
        lastSeenActionId = state.lastAction?.id || '';
        pushToast('success', 'MAGI SYSTEM: Telemetry link established');
      } else if (state.lastAction && state.lastAction.id !== lastSeenActionId) {
        lastSeenActionId = state.lastAction.id;
        pushToast(state.lastAction.variant, state.lastAction.message);
      }
    }
  }

  function formatTime(secs: number): string {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }
</script>

<main class="app-root">
  <!-- NERV Top Caution Stripe -->
  <div class="nerv-top-hazard" aria-hidden="true"></div>

  <!-- NERV / MAGI Command Header -->
  <header class="header">
    <div class="logo">
      <div class="nerv-emblem">
        <span class="emblem-main">NERV</span>
        <span class="emblem-sub">P2P•01</span>
      </div>
      <div class="logo-titles">
        <div class="logo-row">
          <div class="logo-pulse"></div>
          <span class="logo-text">PYRAMID // RADIO</span>
          <span class="badge">MAGI MESH</span>
        </div>
        <span class="logo-sub">特務機関 音響中継網 // CENTRAL DOGMA SYNCHRONIZED BROADCAST</span>
      </div>
    </div>

    <div class="header-right">
      {#if deferredInstallPrompt}
        <button type="button" class="install-pwa-btn" onclick={handleInstallPwa} title="Install PYRAMID // RADIO as Standalone Offline App">
          ⬇ INSTALL HUD
        </button>
      {/if}
      {#if mode !== 'select'}
        <div class="tooltip-wrap" data-tooltip="ARM & CONFIRM LINK TERMINATION" data-tooltip-align="right">
          <button
            type="button"
            class="exit-btn"
            class:armed={abortArmed}
            onclick={triggerAbortSequence}
            aria-label="Arm and Confirm Link Termination"
          >
            <span class="abort-hazard-bar top" aria-hidden="true"></span>
            <span class="abort-inner">
              <span class="abort-led" aria-hidden="true"></span>
              <span class="abort-label">{abortArmed ? 'ARMED // FIRE' : 'ABORT LINK'}</span>
            </span>
            <span class="abort-hazard-bar bottom" aria-hidden="true"></span>
          </button>
        </div>
      {/if}
      <div class="peer-id-badge">
        <span class="node-label">UNIT_ID:</span>
        <code>{myPeerId}</code>
      </div>
    </div>
  </header>

  <!-- MAGI Tri-System Telemetry Bar -->
  <section class="magi-strip" aria-label="System Telemetry">
    <div class="magi-cell">
      <span class="magi-id">MELCHIOR•1</span>
      <span class="magi-val ok">MESH_CORE: ONLINE</span>
    </div>
    <div class="magi-cell">
      <span class="magi-id">BALTHASAR•2</span>
      <span class="magi-val" class:ok={isPlaying || isAudioActuallyPlaying} class:warn={!isPlaying && !isAudioActuallyPlaying}>
        SYNC: {mode === 'select' ? 'STANDBY' : (isPlaying || isAudioActuallyPlaying ? 'LOCKED' : 'BUFFERING')}
      </span>
    </div>
    <div class="magi-cell">
      <span class="magi-id">CASPER•3</span>
      <span class="magi-val cyan">CACHE_MEM: 100MB</span>
    </div>
    <div
      class="magi-cell pattern-cell"
      class:active-pattern={bloodTypeStatus.tone === 'cyan'}
      class:danger-pattern={bloodTypeStatus.tone === 'danger'}
      data-tooltip={bloodTypeStatus.tooltip}
      data-tooltip-align="right"
    >
      <span class="magi-id">BLOOD_TYPE</span>
      <span
        class="magi-val"
        class:cyan={bloodTypeStatus.tone === 'cyan'}
        class:warn={bloodTypeStatus.tone === 'amber'}
        class:danger={bloodTypeStatus.tone === 'danger'}
      >
        {bloodTypeStatus.label}
      </span>
    </div>
  </section>

  <div class="content-grid">
    <!-- Center Command Console -->
    <div class="main-console">
      {#if mode === 'select'}
        <div class="welcome-card">
          <div class="card-tech-bar">
            <span class="tech-code">[ SYS.00 // OPERATION SELECT ]</span>
            <span class="tech-jp">作戦選択 // ZERO-CLOUD P2P AUDIO RELAY</span>
          </div>

          <div class="welcome-hero">
            <h2>DECENTRALIZED SYNCHRONIZED RADIO</h2>
            <p>
              The DJ acts as the Central Dogma broadcast origin. Zero cloud servers. Lossless FLAC &amp; MP3 streams are pre-buffered and relayed across a self-healing peer pyramid.
            </p>
          </div>

          <div class="choice-cards">
            <!-- DJ Host Card -->
            <div class="action-card dj-card">
              <div class="unit-strip amber">
                <span>UNIT-01 // TRANSMITTER</span>
                <span>発信局 • SOURCE</span>
              </div>
              <h3>🎧 HOST A STATION (DJ)</h3>
              <p>Drop lossless FLAC or MP3 tracks to broadcast directly from your browser into the P2P relay tree.</p>

              <div class="toggle-compress-row">
                <label class="toggle-label">
                  <input type="checkbox" bind:checked={autoCompressMp3} />
                  <span class="toggle-switch"></span>
                  <span class="toggle-text">
                    <span class="toggle-title-line">
                      <strong>AUTO-COMPRESS TO 128KBPS MP3</strong>
                      <span class="state-pill" class:engaged={autoCompressMp3}>
                        {autoCompressMp3 ? 'ENGAGED' : 'BYPASS'}
                      </span>
                    </span>
                    <small>Cuts P2P relay bandwidth ~90% (25MB FLAC ➔ ~2MB MP3)</small>
                  </span>
                </label>
              </div>

              <div class="file-dropzone">
                <input type="file" multiple accept=".mp3,.flac,audio/*" onchange={handleFilesSelected} id="audio-input" />
                <label for="audio-input" class="dropzone-label" class:ready={djFiles.length > 0}>
                  {#if uploadProcessing}
                    <span class="dropzone-tag">PROCESSING // 解析中</span>
                    <span class="dropzone-main">⏳ {compressStatus || 'Parsing Audio Headers...'}</span>
                  {:else if djFiles.length > 0}
                    <span class="dropzone-tag ready">SIGNAL READY // 準備完了</span>
                    <span class="dropzone-main">✅ {djFiles.length} {djFiles.length === 1 ? 'TRACK' : 'TRACKS'} ARMED FOR BROADCAST</span>
                  {:else}
                    <span class="dropzone-tag">INPUT_BAY // 音声入力</span>
                    <span class="dropzone-main">📁 SELECT OR DROP FLAC &amp; MP3 FILES</span>
                  {/if}
                </label>
              </div>

              {#if djFiles.length > 0}
                <div class="station-name-input">
                  <input type="text" bind:value={stationCode} placeholder="Station Callsign (e.g. geofront-fm)" />
                  <button type="button" class="primary-btn" onclick={startDJBroadcast}>
                    ⚡ INITIATE TRANSMISSION
                  </button>
                </div>
              {/if}
            </div>

            <!-- Listener Card -->
            <div class="action-card listener-card">
              <div class="unit-strip cyan">
                <span>UNIT-02 // RECEIVER</span>
                <span>受信局 • RELAY</span>
              </div>
              <h3>📻 TUNE IN (LISTENER)</h3>
              <p>Synchronize with a live station callsign. Tracks pre-buffer into local IndexedDB memory for zero-dropout playback.</p>

              <div class="nerv-spec-box">
                <div class="spec-row">
                  <span>SYNC_MODE:</span>
                  <strong>CLOCK-LOCKED P2P STREAM</strong>
                </div>
                <div class="spec-row">
                  <span>FAILOVER:</span>
                  <strong>AUTO-HEALING TREE MESH</strong>
                </div>
              </div>

              <div class="join-input-group">
                <input type="text" bind:value={stationCode} placeholder="ENTER STATION CALLSIGN / CODE" />
                <button type="button" class="secondary-btn" disabled={!stationCode} onclick={joinAsListener}>
                  📡 LOCK SIGNAL &amp; TUNE IN
                </button>
              </div>
            </div>
          </div>
        </div>

      {:else}
        <!-- Active Player Deck -->
        <div class="deck-card">
          <div class="nerv-hazard-banner"></div>

          <div class="deck-top">
            <div class="station-meta">
              <span class="live-dot"></span>
              <span class="station-title">STATION // {stationCode.toUpperCase()}</span>
              <span class="role-tag">{mode === 'dj' ? 'DJ // ORIGIN' : 'LISTENER // RELAY'}</span>
            </div>
            <div class="share-box">
              <span class="share-label">UPLINK:</span>
              <button
                type="button"
                class="share-code-btn"
                onclick={() => navigator.clipboard.writeText(window.location.href)}
                title="Click to copy station link"
              >
                {window.location.host}/#{stationCode} 📋
              </button>
              <button
                type="button"
                class="analysis-toggle-btn"
                class:active={showBufferAnalysis}
                onclick={() => (showBufferAnalysis = !showBufferAnalysis)}
                title="Toggle Evangelion Buffer Analysis HUD"
              >
                {showBufferAnalysis ? '◀ AUDIO DECK' : '📊 BUFFER ANALYSIS'}
              </button>
            </div>
          </div>

          <!-- Unified Deck Stage: Container sized to the larger Audio Deck view to eliminate layout jumps -->
          <div class="deck-stage">
            <div class="deck-view-pane" class:is-hidden={!isBufferView} inert={!isBufferView}>
              <EvaBufferAnalysis
                progress={mode === 'dj' ? 100 : currentBufferProgress}
                trackTitle={currentTrack?.title || 'SYNCHRONIZING P2P AUDIO STREAM...'}
                totalChunks={currentTrack?.totalChunks || 0}
                bufferedChunks={Math.round(((mode === 'dj' ? 100 : currentBufferProgress) / 100) * (currentTrack?.totalChunks || 100))}
                onEngage={() => player?.resumeSync()}
              />
            </div>

            <div class="deck-view-pane" class:is-hidden={isBufferView} inert={isBufferView}>
              <div class="player-display" class:has-cover={!!currentTrack?.coverDataUrl}>
                {#if currentTrack?.coverDataUrl}
                  <div class="cover-art" class:is-playing={isPlaying || isAudioActuallyPlaying}>
                    <img src={currentTrack.coverDataUrl} alt="Track Cover" />
                  </div>
                {/if}

                <div class="track-info">
                  <div class="track-header-row">
                    <span class="telemetry-prefix">AUDIO_CH // ACTIVE_STREAM</span>
                    <span class="sync-badge">SYNC: {isPlaying || isAudioActuallyPlaying ? '100.0%' : 'STANDBY'}</span>
                  </div>

                  <h1 class="track-title">{currentTrack?.title || 'AWAITING TRANSMISSION...'}</h1>
                  <h2 class="track-artist">{currentTrack?.artist || 'UNIDENTIFIED BROADCASTER'}</h2>

                  <div class="track-tags">
                    <span class="tag amber">
                      {currentTrack?.mimeType.toUpperCase().replace('AUDIO/', '') || 'STREAM'}
                    </span>
                    {#if currentTrack?.totalSize}
                      <span class="tag cyan">{(currentTrack.totalSize / (1024 * 1024)).toFixed(1)} MB</span>
                    {/if}
                    <span class="tag green">P2P MESH SYNC</span>
                  </div>

                  <!-- Evangelion Internal Battery Song Timer HUD -->
                  <EvaTimer
                    {currentTime}
                    duration={currentTrack?.duration || duration || 0}
                    {isPlaying}
                    {isAudioActuallyPlaying}
                    {mode}
                    onSeek={handleSeek}
                    getAudioData={() => player ? player.getAudioVisualData() : null}
                  />

                  <!-- Pre-buffer status badges (NERV-UI Phase Rails) -->
                  <div class="buffer-meters phase-rails">
                    <div class="phase-rail-spine" aria-hidden="true"></div>

                    <div class="phase-rail-row">
                      <span class="phase-tag">RAIL 01</span>
                      <div
                        class="phase-rail-bar"
                        class:charged={Math.round(priBufferTween.current) >= 100}
                        class:empty={Math.round(priBufferTween.current) === 0}
                      >
                        <div class="phase-rail-fill" style="width: {priBufferTween.current}%"></div>
                        <div class="phase-rail-scanlines" aria-hidden="true"></div>
                        <div class="phase-rail-overlay">
                          <span class="phase-name">PRI_BUFFER // CURRENT</span>
                          <span class="phase-pct">{mode === 'dj' ? `${Math.round(priBufferTween.current)}% [HOST]` : `${Math.round(priBufferTween.current)}%`}</span>
                        </div>
                      </div>
                    </div>

                    <div class="phase-rail-row">
                      <span class="phase-tag">RAIL 02</span>
                      <div
                        class="phase-rail-bar"
                        class:charged={Boolean(nextTrack) && Math.round(auxBufferTween.current) >= 100}
                        class:empty={!nextTrack || Math.round(auxBufferTween.current) === 0}
                      >
                        <div class="phase-rail-fill" style="width: {auxBufferTween.current}%"></div>
                        <div class="phase-rail-scanlines" aria-hidden="true"></div>
                        <div class="phase-rail-overlay">
                          <span class="phase-name">AUX_BUFFER // NEXT {nextTrack ? `[${nextTrack.title.slice(0, 14)}…]` : ''}</span>
                          <span class="phase-pct">{nextTrack ? `${Math.round(auxBufferTween.current)}%` : 'STANDBY'}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Controls -->
          <div class="deck-controls">
            <div class="deck-controls-hazard"></div>
            <div class="transport-group">
              {#if mode === 'dj'}
                <button type="button" class="icon-btn transport-btn" onclick={toggleShuffle} class:active={isShuffled} title="Shuffle Queue">
                  <span class="cmd-led" aria-hidden="true"></span>
                  <span class="cmd-prefix">CMD //</span>
                  <span>{isShuffled ? 'SHUFFLE: ON' : 'SHUFFLE'}</span>
                  <span class="btn-glyph">⤮</span>
                </button>
                <button type="button" class="main-play-btn" class:is-live={isPlaying} onclick={togglePlayPause}>
                  <span class="cmd-led" aria-hidden="true"></span>
                  <span class="cmd-prefix">TX //</span>
                  <span class="play-icon">{isPlaying ? '❚❚' : '▶'}</span>
                  <span>{isPlaying ? 'PAUSE TX' : 'TRANSMIT'}</span>
                </button>
                <button type="button" class="icon-btn transport-btn" onclick={skipNext} title="Next Track">
                  <span class="cmd-led" aria-hidden="true"></span>
                  <span class="cmd-prefix">CMD //</span>
                  <span>SKIP TRACK</span>
                  <span class="btn-glyph">⏭</span>
                </button>
              {:else}
                {#if isAudioActuallyPlaying}
                  <button type="button" class="main-play-btn playing" onclick={() => player?.pause()}>
                    <span class="cmd-led" aria-hidden="true"></span>
                    <span class="cmd-prefix">RX //</span>
                    <span class="play-icon">❚❚</span>
                    <span>PAUSE STREAM</span>
                  </button>
                {:else if currentBufferProgress < 100}
                  <button type="button" class="main-play-btn buffering" disabled>
                    <span class="buffering-spinner"></span>
                    <span class="cmd-prefix">RX //</span>
                    <span>{sourceMounted ? 'SYNCING' : 'BUFFERING'} ({currentBufferProgress}%)...</span>
                  </button>
                {:else}
                  <button type="button" class="main-play-btn pulse" onclick={() => player?.resumeSync()}>
                    <span class="cmd-led" aria-hidden="true"></span>
                    <span class="cmd-prefix">RX //</span>
                    <span class="play-icon">⚡</span>
                    <span>ENGAGE AUDIO LINK</span>
                  </button>
                {/if}
              {/if}
            </div>

            <div class="volume-slider">
              <div class="vol-label-group">
                <span class="vol-led" class:muted={volume === 0} aria-hidden="true"></span>
                <span class="vol-prefix">VOL //</span>
                <span class="vol-label">GAIN</span>
              </div>
              <div class="vol-track-wrap">
                <div class="vol-segments" aria-hidden="true">
                  {#each Array(10) as _, idx}
                    <span
                      class="vol-seg"
                      class:lit={volume >= (idx + 0.5) / 10}
                      class:mid={idx >= 5 && idx <= 7}
                      class:peak={idx >= 8}
                    ></span>
                  {/each}
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  aria-label="Audio Gain Volume"
                  bind:value={volume}
                  oninput={(e) => player?.setVolume(parseFloat((e.target as HTMLInputElement).value))}
                />
              </div>
              <span class="vol-val">{Math.round(volume * 100)}%</span>
            </div>
          </div>
        </div>

        <MagiComputing {peers} activeStream={mode === 'dj' ? isPlaying : isAudioActuallyPlaying} />

        <!-- DJ Playlist Queue -->
        {#if mode === 'dj'}
          <div class="queue-card">
            <div class="nerv-hazard-banner"></div>
            <div class="queue-header">
              <div class="queue-title-group">
                <span class="tech-code">MAGI // QUEUE</span>
                <h3>TRANSMISSION MANIFEST [{String(playlist.length).padStart(2, '0')}]</h3>
              </div>
              <label class="icon-btn add-songs-btn">
                <span class="cmd-led" aria-hidden="true"></span>
                <span class="cmd-prefix">CMD //</span>
                <span class="btn-glyph">{addingTracks ? '⏳' : '＋'}</span>
                <span>{addingTracks ? 'ENCODING…' : 'INJECT TRACKS'}</span>
                <input type="file" multiple accept=".mp3,.flac,audio/*" style="display:none" disabled={addingTracks} onchange={handleAddTracksLive} />
              </label>
            </div>

            <div class="queue-list">
              {#each playlist as tId, index (tId)}
                {@const item = trackManifests.get(tId)}
                <div
                  role="button"
                  tabindex="0"
                  class="queue-item"
                  class:active={index === djActiveTrackIndex}
                  class:is-dragging={draggedIndex === index}
                  class:drag-over={dragOverIndex === index && draggedIndex !== index}
                  draggable="true"
                  ondragstart={(e) => handleDragStart(e, index)}
                  ondragover={(e) => handleDragOver(e, index)}
                  ondragleave={(e) => handleDragLeave(e, index)}
                  ondrop={(e) => handleDrop(e, index)}
                  ondragend={handleDragEnd}
                  onclick={() => playTrackAtIndex(index)}
                  onkeydown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      playTrackAtIndex(index);
                    }
                  }}
                >
                  <span class="q-drag-handle" title="Drag to reorder" aria-hidden="true">⠿</span>
                  <span class="q-idx">{String(index + 1).padStart(2, '0')}</span>
                  <div class="q-meta">
                    <span class="q-title">{item?.title || 'Unknown Track'}</span>
                    <span class="q-artist">{item?.artist || 'Unknown'} • {formatTime(item?.duration || 0)}</span>
                  </div>
                  <div class="q-item-right">
                    {#if index === djActiveTrackIndex}
                      <span class="q-playing">
                        <span class="q-pulse-dot"></span>
                        <span>ON AIR</span>
                      </span>
                    {:else}
                      <span class="q-standby">QUEUED</span>
                    {/if}
                    <div class="q-reorder-group" role="group" aria-label="Reorder track">
                      <button
                        type="button"
                        class="q-nudge-btn"
                        disabled={index === 0}
                        onclick={(e) => { e.stopPropagation(); moveTrack(index, -1); }}
                        title="Move track up"
                        aria-label="Move track up"
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        class="q-nudge-btn"
                        disabled={index === playlist.length - 1}
                        onclick={(e) => { e.stopPropagation(); moveTrack(index, 1); }}
                        title="Move track down"
                        aria-label="Move track down"
                      >
                        ▼
                      </button>
                    </div>
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {/if}
      {/if}
    </div>

    <!-- Right / Bottom Sidebar: P2P Pyramid & Live Network Log -->
    <aside class="sidebar">
      <PyramidTree {peers} currentPeerId={myPeerId} />

      <div class="log-card">
        <div class="nerv-card-strip cyan-strip"></div>
        <div class="log-header">
          <div class="log-title-wrap">
            <span class="log-code">MAGI // 02</span>
            <span>P2P MESH TELEMETRY</span>
          </div>
          <span class="log-indicator"><span class="log-beacon">◆</span> LIVE</span>
        </div>
        <div class="log-window">
          <div class="log-terminal-bar">
            <div class="log-dots-group">
              <span class="log-dot red"></span>
              <span class="log-dot amber"></span>
              <span class="log-dot green"></span>
              <span class="log-term-title">P2P.LOG</span>
            </div>
            <span class="log-term-sys">MAGI_SYS</span>
          </div>
          {#each statusLogs as log, idx}
            <div class="log-line">
              <span class="log-seq">{String(idx + 1).padStart(3, '0')}</span>
              <span class="log-arrow">&gt;</span>
              <span class="log-text">{log}</span>
            </div>
          {/each}
          {#if statusLogs.length === 0}
            <div class="log-line text-muted">
              <span class="log-seq">000</span>
              <span class="log-arrow">&gt;</span>
              <span>Awaiting peer connections...</span>
            </div>
          {/if}
          <div class="log-prompt-line">
            <span class="log-arrow">&gt;</span>
            <span class="prompt-text">SYS_MONITOR //</span>
            <span class="blinking-cursor">_</span>
          </div>
        </div>
      </div>
    </aside>
  </div>

  <SystemDialog
    open={systemDialog.open}
    variant={systemDialog.variant}
    title={systemDialog.title}
    message={systemDialog.message}
    confirmLabel={systemDialog.confirmLabel}
    cancelLabel={systemDialog.cancelLabel}
    onConfirm={systemDialog.onConfirm}
    onCancel={systemDialog.onCancel}
  />

  <SystemToast {toasts} onDismiss={dismissToast} />
</main>

<style>
  .app-root {
    min-height: 100vh;
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    padding: clamp(10px, 2vw, 20px) clamp(12px, 2.5vw, 28px);
    box-sizing: border-box;
    font-family: var(--font-body);
    color: var(--text-primary);
    position: relative;
    max-width: 1480px;
    margin: 0 auto;
    width: 100%;
  }

  .nerv-top-hazard {
    height: 4px;
    width: 100%;
    background: var(--hazard-amber);
    margin-bottom: 12px;
    border-bottom: 1px solid rgba(255, 123, 0, 0.5);
  }

  /* Header */
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 14px;
    padding-bottom: 14px;
    border-bottom: 1px solid rgba(255, 123, 0, 0.35);
  }

  .logo {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }

  .nerv-emblem {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: rgba(255, 0, 60, 0.14);
    border: 1px solid var(--neon-magenta);
    padding: 4px 8px;
    clip-path: polygon(0 0, calc(100% - 6px) 0, 100% 6px, 100% 100%, 6px 100%, 0 calc(100% - 6px));
    flex-shrink: 0;
  }

  .emblem-main {
    font-family: var(--font-display);
    font-weight: 900;
    font-size: 0.78rem;
    letter-spacing: 0.16em;
    color: var(--neon-magenta);
    line-height: 1;
  }

  .emblem-sub {
    font-family: var(--font-mono);
    font-size: 0.58rem;
    color: var(--nerv-amber);
    letter-spacing: 0.08em;
    margin-top: 2px;
  }

  .logo-titles {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .logo-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
  }

  .logo-pulse {
    width: 10px;
    height: 10px;
    background: var(--nerv-amber);
    clip-path: polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%);
    animation: nerv-pulse 2s infinite ease-in-out;
    flex-shrink: 0;
  }

  @keyframes nerv-pulse {
    0%, 100% { transform: scale(0.9); opacity: 0.75; }
    50% { transform: scale(1.25); opacity: 1; }
  }

  .logo-text {
    font-family: var(--font-display);
    font-size: clamp(1.05rem, 2.2vw, 1.35rem);
    font-weight: 900;
    letter-spacing: 0.15em;
    color: var(--text-primary);
    text-shadow: 0 0 12px rgba(255, 123, 0, 0.45);
  }

  .logo-sub {
    font-family: var(--font-mono);
    font-size: 0.68rem;
    color: var(--nerv-amber);
    letter-spacing: 0.08em;
    opacity: 0.9;
  }

  .badge {
    background: rgba(0, 240, 255, 0.12);
    color: var(--neon-cyan);
    font-size: 0.65rem;
    padding: 2px 7px;
    font-family: var(--font-mono);
    font-weight: bold;
    border: 1px solid rgba(0, 240, 255, 0.45);
    letter-spacing: 0.1em;
  }

  .header-right {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
  }

  .install-pwa-btn {
    background: rgba(0, 240, 255, 0.16);
    color: var(--neon-cyan);
    border: 1px solid rgba(0, 240, 255, 0.65);
    font-family: var(--font-mono);
    font-size: 0.78rem;
    font-weight: 700;
    padding: 7px 12px;
    clip-path: polygon(0 0, calc(100% - 7px) 0, 100% 7px, 100% 100%, 7px 100%, 0 calc(100% - 7px));
    text-transform: uppercase;
    letter-spacing: 0.08em;
    cursor: pointer;
    box-shadow: 0 0 10px rgba(0, 240, 255, 0.25);
    transition: background 0.15s, color 0.15s, border-color 0.15s, box-shadow 0.15s;
    animation: pulse-install 2.5s infinite ease-in-out;
  }

  .install-pwa-btn:hover {
    background: rgba(0, 240, 255, 0.35);
    color: #fff;
    border-color: #fff;
    box-shadow: 0 0 16px rgba(0, 240, 255, 0.6);
  }

  @keyframes pulse-install {
    0%, 100% {
      border-color: rgba(0, 240, 255, 0.65);
      box-shadow: 0 0 8px rgba(0, 240, 255, 0.2);
    }
    50% {
      border-color: var(--neon-green);
      color: var(--neon-green);
      box-shadow: 0 0 14px rgba(0, 255, 102, 0.4);
    }
  }

  .exit-btn {
    position: relative;
    display: inline-flex;
    flex-direction: column;
    justify-content: space-between;
    width: 158px;
    height: 38px;
    padding: 0;
    background: linear-gradient(180deg, #1b060c 0%, #0d0205 100%);
    color: #ff385c;
    border: 1px solid rgba(255, 30, 60, 0.65);
    font-family: var(--font-mono);
    font-size: 0.72rem;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    cursor: pointer;
    overflow: hidden;
    user-select: none;
    box-shadow:
      inset 0 1px 0 rgba(255, 130, 150, 0.2),
      inset 0 -2px 0 rgba(0, 0, 0, 0.75),
      0 3px 0 #160308,
      0 5px 12px rgba(0, 0, 0, 0.7);
    transition: transform 0.06s ease, box-shadow 0.06s ease, background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
  }

  .exit-btn:hover {
    background: linear-gradient(180deg, #2b0812 0%, #140307 100%);
    border-color: #ff4466;
    color: #ffffff;
  }

  .exit-btn:active {
    transform: translateY(2px);
    box-shadow:
      inset 0 1px 2px rgba(0, 0, 0, 0.85),
      0 1px 0 #160308;
  }

  .exit-btn.armed {
    background: linear-gradient(180deg, #3b070e 0%, #1c0306 100%);
    border-color: #ff1e1e;
    color: #ffffff;
    box-shadow:
      inset 0 1px 0 rgba(255, 120, 120, 0.3),
      0 3px 0 #1c0204,
      0 0 16px rgba(255, 30, 30, 0.45);
  }

  .abort-hazard-bar {
    display: block;
    width: 100%;
    height: 4px;
    background: repeating-linear-gradient(
      -45deg,
      rgba(255, 30, 60, 0.45) 0px,
      rgba(255, 30, 60, 0.45) 5px,
      #090204 5px,
      #090204 10px
    );
    flex-shrink: 0;
  }

  .exit-btn.armed .abort-hazard-bar {
    background: repeating-linear-gradient(
      -45deg,
      #ff1e1e 0px,
      #ff1e1e 6px,
      #090204 6px,
      #090204 12px
    );
  }

  .abort-inner {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 0 10px;
    white-space: nowrap;
  }

  .abort-led {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: rgba(255, 30, 60, 0.55);
    border: 1px solid rgba(255, 120, 140, 0.5);
    flex-shrink: 0;
  }

  .exit-btn.armed .abort-led {
    background: #ff2a2a;
    border-color: #ffaaaa;
    box-shadow: 0 0 8px #ff1e1e;
    animation: abort-led-blink 0.5s infinite alternate ease-in-out;
  }

  @keyframes abort-led-blink {
    0% { opacity: 0.4; }
    100% { opacity: 1; }
  }

  .peer-id-badge {
    font-family: var(--font-mono);
    font-size: 0.76rem;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .node-label {
    color: var(--nerv-amber);
  }

  .peer-id-badge code {
    color: var(--neon-cyan);
    background: rgba(0, 240, 255, 0.08);
    border: 1px solid rgba(0, 240, 255, 0.35);
    padding: 3px 8px;
    font-family: var(--font-mono);
  }

  /* MAGI Tri-System Telemetry Strip */
  .magi-strip {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    gap: 8px;
    margin-top: 10px;
  }

  .magi-cell {
    background: rgba(8, 12, 22, 0.9);
    border: 1px solid rgba(255, 123, 0, 0.28);
    border-left: 3px solid var(--nerv-amber);
    padding: 6px 10px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-family: var(--font-mono);
    font-size: 0.72rem;
    letter-spacing: 0.06em;
  }

  .magi-cell.pattern-cell {
    border-left-color: var(--nerv-amber);
  }

  .magi-cell.pattern-cell.active-pattern {
    border-left-color: var(--neon-cyan);
    border-color: rgba(0, 240, 255, 0.4);
  }

  .magi-cell.pattern-cell.danger-pattern {
    border-left-color: #ff2a4d;
    border-color: rgba(255, 42, 77, 0.5);
  }

  .magi-id {
    color: var(--text-muted);
    font-weight: bold;
  }

  .magi-val {
    color: var(--nerv-amber);
    font-weight: bold;
  }

  .magi-val.ok {
    color: var(--neon-green);
  }

  .magi-val.warn {
    color: var(--neon-yellow);
  }

  .magi-val.cyan {
    color: var(--neon-cyan);
  }

  .magi-val.danger {
    color: #ff2a4d;
  }

  /* Main Layout Grid: Single-column default for mobile & standard windows; 2-col on ultra-wide */
  .content-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 20px;
    margin-top: 16px;
    flex: 1;
  }

  @media (min-width: 1450px) {
    .content-grid {
      grid-template-columns: 1fr minmax(340px, 400px);
    }
  }

  .main-console {
    display: flex;
    flex-direction: column;
    gap: 20px;
    min-width: 0;
    container-type: inline-size;
  }

  /* Welcome / Operation Select Card */
  .welcome-card {
    background: var(--bg-card);
    border: 1px solid rgba(255, 123, 0, 0.4);
    clip-path: polygon(0 0, calc(100% - 18px) 0, 100% 18px, 100% 100%, 18px 100%, 0 calc(100% - 18px));
    padding: clamp(16px, 3vw, 28px);
    box-shadow: inset 0 0 30px rgba(255, 123, 0, 0.04);
  }

  .card-tech-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding-bottom: 10px;
    margin-bottom: 14px;
    border-bottom: 1px solid rgba(255, 123, 0, 0.28);
    font-family: var(--font-mono);
    font-size: 0.72rem;
    letter-spacing: 0.08em;
  }

  .tech-code {
    color: var(--nerv-amber);
    font-weight: bold;
  }

  .tech-jp {
    color: var(--text-muted);
  }

  .welcome-hero h2 {
    margin: 0 0 8px 0;
    font-family: var(--font-display);
    color: var(--neon-cyan);
    letter-spacing: 0.08em;
    font-size: clamp(1.2rem, 2.4vw, 1.6rem);
    text-shadow: 0 0 12px rgba(0, 240, 255, 0.35);
  }

  .welcome-hero p {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.98rem;
    line-height: 1.45;
  }

  .choice-cards {
    display: grid;
    grid-template-columns: 1fr;
    gap: 20px;
    margin-top: 20px;
  }

  @container (min-width: 680px) {
    .choice-cards {
      grid-template-columns: 1fr 1fr;
    }
  }

  @supports not (container-type: inline-size) {
    @media (min-width: 768px) {
      .choice-cards {
        grid-template-columns: 1fr 1fr;
      }
    }
  }

  .action-card {
    background: rgba(6, 10, 20, 0.92);
    border: 1px solid rgba(0, 240, 255, 0.28);
    clip-path: polygon(0 0, calc(100% - 14px) 0, 100% 14px, 100% 100%, 14px 100%, 0 calc(100% - 14px));
    padding: clamp(16px, 2.2vw, 22px);
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
    box-sizing: border-box;
  }

  .action-card.dj-card {
    border-color: rgba(255, 123, 0, 0.45);
  }

  .action-card.listener-card {
    border-color: rgba(0, 240, 255, 0.4);
  }

  .unit-strip {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 10px;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    font-weight: bold;
    letter-spacing: 0.08em;
  }

  .unit-strip.amber {
    background: rgba(255, 123, 0, 0.16);
    color: var(--nerv-amber);
    border-left: 3px solid var(--nerv-amber);
  }

  .unit-strip.cyan {
    background: rgba(0, 240, 255, 0.12);
    color: var(--neon-cyan);
    border-left: 3px solid var(--neon-cyan);
  }

  .action-card h3 {
    margin: 0;
    font-family: var(--font-display);
    color: var(--neon-yellow);
    font-size: 1.05rem;
    letter-spacing: 0.08em;
  }

  .action-card p {
    margin: 0;
    font-size: 0.94rem;
    color: var(--text-muted);
    line-height: 1.4;
  }

  .toggle-compress-row {
    background: rgba(3, 6, 14, 0.95);
    border: 1px solid rgba(255, 123, 0, 0.35);
    padding: 12px;
    box-sizing: border-box;
  }

  .toggle-label {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    cursor: pointer;
  }

  .toggle-label input[type="checkbox"] {
    display: none;
  }

  .toggle-switch {
    width: 38px;
    height: 20px;
    background: #0b1324;
    border: 1px solid rgba(255, 123, 0, 0.5);
    position: relative;
    transition: background 0.15s, border-color 0.15s;
    flex-shrink: 0;
    margin-top: 2px;
  }

  .toggle-switch::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    background: var(--text-muted);
    transition: transform 0.18s ease, background 0.18s ease;
  }

  .toggle-label input[type="checkbox"]:checked + .toggle-switch {
    background: rgba(255, 123, 0, 0.22);
    border-color: var(--nerv-amber);
  }

  .toggle-label input[type="checkbox"]:checked + .toggle-switch::after {
    transform: translateX(18px);
    background: var(--nerv-amber);
  }

  .toggle-text {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-family: var(--font-mono);
    min-width: 0;
    flex: 1;
    line-height: 1.3;
  }

  .toggle-title-line {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 6px;
  }

  .toggle-text strong {
    font-size: 0.8rem;
    color: var(--text-primary);
    letter-spacing: 0.04em;
  }

  .state-pill {
    font-size: 0.65rem;
    padding: 1px 6px;
    border: 1px solid rgba(140, 160, 190, 0.4);
    color: var(--text-muted);
  }

  .state-pill.engaged {
    background: rgba(0, 255, 102, 0.15);
    border-color: var(--neon-green);
    color: var(--neon-green);
  }

  .toggle-text small {
    font-size: 0.72rem;
    color: var(--text-muted);
    line-height: 1.3;
  }

  .file-dropzone {
    margin-top: auto;
  }

  .file-dropzone input {
    display: none;
  }

  .dropzone-label {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    box-sizing: border-box;
    width: 100%;
    border: 1px dashed rgba(255, 123, 0, 0.55);
    clip-path: polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px));
    padding: 16px;
    text-align: center;
    cursor: pointer;
    font-family: var(--font-mono);
    transition: background 0.15s, border-color 0.15s;
    background: rgba(255, 123, 0, 0.05);
  }

  .dropzone-label.ready {
    border-style: solid;
    border-color: var(--neon-green);
    background: rgba(0, 255, 102, 0.07);
  }

  .dropzone-label:hover {
    border-color: var(--neon-cyan);
    background: rgba(0, 240, 255, 0.1);
  }

  .dropzone-tag {
    font-size: 0.68rem;
    color: var(--nerv-amber);
    letter-spacing: 0.1em;
  }

  .dropzone-tag.ready {
    color: var(--neon-green);
  }

  .dropzone-main {
    font-size: 0.86rem;
    color: var(--text-primary);
    font-weight: bold;
  }

  .nerv-spec-box {
    background: rgba(3, 6, 14, 0.9);
    border: 1px solid rgba(0, 240, 255, 0.22);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: 0.74rem;
  }

  .spec-row {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    color: var(--text-muted);
  }

  .spec-row strong {
    color: var(--neon-cyan);
  }

  .station-name-input,
  .join-input-group {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: auto;
  }

  input[type="text"] {
    width: 100%;
    box-sizing: border-box;
    background: #03060e;
    border: 1px solid rgba(0, 240, 255, 0.38);
    color: var(--neon-cyan);
    font-family: var(--font-mono);
    padding: 12px 14px;
    outline: none;
    font-size: 0.9rem;
    clip-path: polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px));
  }

  input[type="text"]:focus {
    border-color: var(--nerv-amber);
  }

  button {
    cursor: pointer;
    font-weight: 700;
    font-family: var(--font-display);
    padding: 12px 18px;
    border: none;
    transition: transform 0.12s, background 0.15s, opacity 0.15s;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    min-height: 44px;
  }

  button:active:not(:disabled) {
    transform: scale(0.99);
  }

  .primary-btn {
    background: linear-gradient(135deg, var(--nerv-amber), #ff3c00);
    color: #04060c;
    clip-path: polygon(0 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 12px 100%, 0 calc(100% - 12px));
    font-weight: 900;
  }

  .primary-btn:hover {
    background: linear-gradient(135deg, var(--neon-yellow), var(--nerv-amber));
  }

  .secondary-btn {
    background: rgba(0, 240, 255, 0.14);
    color: var(--neon-cyan);
    border: 1px solid var(--neon-cyan);
    clip-path: polygon(0 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 12px 100%, 0 calc(100% - 12px));
  }

  .secondary-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .secondary-btn:hover:not(:disabled) {
    background: var(--neon-cyan);
    color: #04060c;
  }

  /* Active Broadcast Deck */
  .deck-card {
    background: var(--bg-card);
    border: 1px solid rgba(255, 123, 0, 0.45);
    clip-path: polygon(0 0, calc(100% - 20px) 0, 100% 20px, 100% 100%, 20px 100%, 0 calc(100% - 20px));
    padding: clamp(16px, 2.8vw, 26px);
  }

  .nerv-hazard-banner {
    height: 4px;
    width: 100%;
    background: var(--hazard-crimson);
    margin-bottom: 14px;
  }

  .deck-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
    margin-bottom: 20px;
    border-bottom: 1px solid rgba(255, 123, 0, 0.28);
    padding-bottom: 12px;
  }

  .station-meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
  }

  .live-dot {
    width: 10px;
    height: 10px;
    background: var(--neon-magenta);
    clip-path: polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%);
    animation: live-blink 1.2s infinite;
  }

  @keyframes live-blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.25; }
  }

  .station-title {
    font-weight: 800;
    font-family: var(--font-display);
    font-size: 0.98rem;
    color: #fff8ea;
    letter-spacing: 0.12em;
    text-shadow:
      0 0 6px rgba(255, 240, 200, 0.72),
      0 0 16px rgba(255, 185, 85, 0.45),
      0 0 30px rgba(255, 120, 20, 0.25);
  }

  .role-tag {
    font-size: 0.68rem;
    background: rgba(255, 123, 0, 0.16);
    border: 1px solid var(--nerv-amber);
    padding: 2px 8px;
    color: var(--nerv-amber);
    font-family: var(--font-mono);
    font-weight: bold;
  }

  .share-box {
    font-size: 0.76rem;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    font-family: var(--font-mono);
  }

  .share-label {
    color: var(--nerv-amber);
  }

  .share-code-btn {
    background: #03060e;
    border: 1px solid rgba(0, 240, 255, 0.4);
    padding: 5px 10px;
    min-height: 32px;
    color: var(--neon-cyan);
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 0.76rem;
    text-transform: none;
    letter-spacing: 0.03em;
    clip-path: polygon(0 0, calc(100% - 6px) 0, 100% 6px, 100% 100%, 6px 100%, 0 calc(100% - 6px));
    word-break: break-all;
  }

  .share-code-btn:hover {
    border-color: var(--nerv-amber);
    color: var(--neon-yellow);
  }

  .analysis-toggle-btn {
    background: #03060e;
    border: 1px solid var(--nerv-amber);
    color: var(--nerv-amber);
    padding: 5px 10px;
    min-height: 32px;
    font-family: var(--font-mono);
    font-size: 0.74rem;
    font-weight: bold;
    cursor: pointer;
    letter-spacing: 0.05em;
    clip-path: polygon(0 0, calc(100% - 6px) 0, 100% 6px, 100% 100%, 6px 100%, 0 calc(100% - 6px));
    transition: all 0.15s ease-out;
  }

  .analysis-toggle-btn:hover,
  .analysis-toggle-btn.active {
    background: rgba(255, 123, 0, 0.22);
    border-color: var(--neon-yellow);
    color: var(--neon-yellow);
    box-shadow: 0 0 10px rgba(255, 123, 0, 0.45);
  }

  /* Deck Stage Stack: Matches the height of the larger Audio Deck view to eliminate layout shifts */
  .deck-stage {
    display: grid;
    grid-template-columns: 1fr;
    grid-template-rows: auto;
    align-items: stretch;
    position: relative;
    width: 100%;
  }

  .deck-view-pane {
    grid-column: 1;
    grid-row: 1;
    width: 100%;
    min-width: 0;
    display: flex;
    flex-direction: column;
    transition: opacity 0.15s ease-out;
  }

  .deck-view-pane.is-hidden {
    visibility: hidden;
    opacity: 0;
    pointer-events: none;
    z-index: 0;
  }

  .player-display {
    display: grid;
    grid-template-columns: 1fr;
    gap: 20px;
    align-items: stretch;
  }

  .player-display.has-cover {
    grid-template-columns: auto 1fr;
  }

  @container (max-width: 680px) {
    .player-display.has-cover {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 720px) {
    .player-display.has-cover {
      grid-template-columns: 1fr;
    }
  }

  /* Album Art (when embedded in track) */
  .cover-art {
    width: clamp(120px, 16vw, 160px);
    aspect-ratio: 1;
    overflow: hidden;
    background: #020307;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: 0 0 24px rgba(0, 0, 0, 0.9), inset 0 0 14px rgba(0, 0, 0, 0.95);
    position: relative;
    margin: 0 auto;
    flex-shrink: 0;
  }

  .cover-art.is-playing {
    border-color: rgba(255, 123, 0, 0.4);
    box-shadow: 0 0 26px rgba(255, 123, 0, 0.2), inset 0 0 14px rgba(0, 0, 0, 0.9);
  }

  .cover-art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .track-info {
    min-width: 0;
  }

  .track-header-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    margin-bottom: 4px;
  }

  .telemetry-prefix {
    color: var(--nerv-amber);
    letter-spacing: 0.08em;
  }

  .sync-badge {
    color: var(--neon-green);
    font-weight: bold;
  }

  .track-title {
    margin: 0 0 4px 0;
    font-family: "Times New Roman", "Noto Serif JP", Georgia, serif;
    font-size: clamp(1.38rem, 2.6vw, 1.85rem);
    font-weight: 700;
    color: #fff8ea;
    letter-spacing: -0.01em;
    line-height: 1.15;
    overflow-wrap: break-word;
    text-shadow:
      0 0 7px rgba(255, 242, 205, 0.78),
      0 0 20px rgba(255, 188, 90, 0.5),
      0 0 38px rgba(255, 120, 20, 0.28);
  }

  .track-artist {
    margin: 0 0 10px 0;
    font-size: 1rem;
    color: var(--neon-cyan);
    font-weight: 600;
    font-family: var(--font-mono);
    letter-spacing: 0.05em;
  }

  .track-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 12px;
  }

  .tag {
    font-size: 0.68rem;
    padding: 2px 8px;
    font-family: var(--font-mono);
    font-weight: bold;
    letter-spacing: 0.06em;
  }

  .tag.amber {
    background: rgba(255, 123, 0, 0.14);
    color: var(--nerv-amber);
    border: 1px solid rgba(255, 123, 0, 0.45);
  }

  .tag.cyan {
    background: rgba(0, 240, 255, 0.12);
    color: var(--neon-cyan);
    border: 1px solid rgba(0, 240, 255, 0.4);
  }

  .tag.green {
    background: rgba(0, 255, 102, 0.1);
    color: var(--neon-green);
    border: 1px solid rgba(0, 255, 102, 0.35);
  }

  .buffer-meters.phase-rails {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 14px;
    background: rgba(3, 5, 11, 0.92);
    border: 1px solid rgba(255, 119, 0, 0.28);
    padding: 10px 12px;
    clip-path: polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px));
  }

  .phase-rail-spine {
    position: absolute;
    left: calc(58px + (100% - 58px - 24px) / 2);
    top: 10px;
    bottom: 10px;
    width: 4px;
    transform: translateX(-50%);
    background: linear-gradient(180deg, rgba(255, 119, 0, 0.25), #ff7700 50%, rgba(255, 119, 0, 0.25));
    box-shadow: 0 0 8px rgba(255, 119, 0, 0.7);
    pointer-events: none;
    z-index: 0;
  }

  .phase-rail-row {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .phase-tag {
    width: 48px;
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 0.66rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: #ff8c2a;
    text-shadow: 0 0 6px rgba(255, 119, 0, 0.65);
  }

  .phase-rail-bar {
    position: relative;
    flex: 1;
    height: 22px;
    background: rgba(88, 10, 16, 0.45);
    border: 1px solid rgba(180, 28, 38, 0.65);
    border-radius: 3px;
    overflow: hidden;
    box-shadow: inset 0 0 8px rgba(0, 0, 0, 0.85);
  }

  .phase-rail-bar.charged {
    border-color: rgba(56, 214, 130, 0.7);
    box-shadow: inset 0 0 8px rgba(0, 0, 0, 0.7), 0 0 8px rgba(46, 204, 113, 0.22);
  }

  .phase-rail-fill {
    position: absolute;
    inset: 0 auto 0 0;
    background: linear-gradient(90deg, rgba(28, 128, 80, 0.85), rgba(58, 198, 128, 0.92));
    box-shadow: 0 0 10px rgba(46, 204, 113, 0.45);
  }

  .phase-rail-scanlines {
    position: absolute;
    inset: 0;
    background: repeating-linear-gradient(
      0deg,
      rgba(0, 0, 0, 0.42) 0px,
      rgba(0, 0, 0, 0.42) 1px,
      transparent 1px,
      transparent 3px
    );
    pointer-events: none;
  }

  .phase-rail-overlay {
    position: relative;
    z-index: 2;
    height: 100%;
    padding: 0 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.05em;
  }

  .phase-name {
    color: #e8fff4;
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.95);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .phase-pct {
    color: #a6ffd2;
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.95);
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }

  .phase-rail-bar.empty .phase-name {
    color: rgba(255, 160, 165, 0.82);
  }

  .phase-rail-bar.empty .phase-pct {
    color: #ff6b78;
  }

  .deck-controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 16px;
    margin-top: 14px;
    padding: 14px 18px;
    background: #020409;
    background-image:
      linear-gradient(rgba(255, 119, 0, 0.035) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 119, 0, 0.035) 1px, transparent 1px);
    background-size: 16px 16px;
    border: 1px solid rgba(255, 119, 0, 0.45);
    border-top: 2px solid #ff7700;
    clip-path: polygon(0 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 12px 100%, 0 calc(100% - 12px));
    box-shadow: 0 0 16px rgba(255, 119, 0, 0.15), inset 0 0 12px rgba(255, 60, 0, 0.08);
    position: relative;
  }

  .deck-controls-hazard {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: repeating-linear-gradient(
      90deg,
      #ff7700 0px,
      #ff7700 12px,
      #040201 12px,
      #040201 20px
    );
    opacity: 0.85;
  }

  .transport-group {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    width: 268px;
    max-width: 100%;
    flex-shrink: 0;
  }

  .transport-group .transport-btn,
  .transport-group .main-play-btn {
    width: 100%;
    height: 36px;
    padding: 0 14px 0 10px;
    justify-content: flex-start;
    white-space: nowrap;
    box-sizing: border-box;
  }

  .transport-group .btn-glyph {
    margin-left: auto;
  }

  .cmd-led {
    width: 5px;
    height: 13px;
    background: #00f0ff;
    box-shadow: 0 0 6px rgba(0, 240, 255, 0.75);
    flex-shrink: 0;
  }

  .cmd-prefix {
    color: rgba(255, 119, 0, 0.62);
    font-family: var(--font-mono);
    font-size: 0.66rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    flex-shrink: 0;
  }

  .main-play-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background: rgba(3, 7, 16, 0.96);
    color: #ff9500;
    font-family: var(--font-display);
    font-weight: 800;
    font-size: 0.82rem;
    padding: 8px 18px 8px 12px;
    letter-spacing: 0.12em;
    border: 1px solid rgba(255, 119, 0, 0.75);
    cursor: pointer;
    clip-path: polygon(0 0, calc(100% - 9px) 0, 100% 9px, 100% 100%, 9px 100%, 0 calc(100% - 9px));
    box-shadow: inset 0 0 10px rgba(0, 0, 0, 0.85), 0 0 12px rgba(255, 119, 0, 0.22);
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
    user-select: none;
  }

  .main-play-btn .cmd-led {
    background: #ff7700;
    box-shadow: 0 0 7px rgba(255, 119, 0, 0.85);
  }

  .main-play-btn.is-live {
    background: rgba(255, 119, 0, 0.14);
    border-color: #ff7700;
    color: #ffaa33;
  }

  .main-play-btn:hover {
    background: rgba(255, 119, 0, 0.22);
    border-color: #ffaa33;
    color: #ffffff;
  }

  .main-play-btn:active {
    transform: translateY(1px);
  }

  .main-play-btn .play-icon {
    font-size: 0.88rem;
  }

  .main-play-btn.buffering {
    background: rgba(8, 15, 30, 0.95);
    color: var(--neon-yellow);
    border: 1px solid rgba(255, 208, 0, 0.55);
    box-shadow: inset 0 0 8px rgba(0, 0, 0, 0.85);
    cursor: wait;
  }

  .buffering-spinner {
    width: 10px;
    height: 10px;
    border: 2px solid rgba(255, 208, 0, 0.3);
    border-top-color: var(--neon-yellow);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .main-play-btn.playing {
    background: rgba(0, 240, 255, 0.12);
    border-color: rgba(0, 240, 255, 0.75);
    color: #00f0ff;
    box-shadow: inset 0 0 10px rgba(0, 0, 0, 0.85), 0 0 12px rgba(0, 240, 255, 0.22);
  }

  .main-play-btn.playing .cmd-led {
    background: #00f0ff;
    box-shadow: 0 0 7px rgba(0, 240, 255, 0.85);
  }

  .main-play-btn.playing:hover {
    background: rgba(0, 240, 255, 0.22);
    border-color: #00f0ff;
    color: #ffffff;
  }

  .main-play-btn.pulse {
    background: rgba(255, 42, 77, 0.14);
    border-color: #ff2a4d;
    color: #ff5c77;
  }

  .main-play-btn.pulse .cmd-led {
    background: #ff2a4d;
    box-shadow: 0 0 7px rgba(255, 42, 77, 0.9);
    animation: pulse-led 0.9s infinite alternate ease-in-out;
  }

  @keyframes pulse-led {
    0% { opacity: 0.45; }
    100% { opacity: 1; }
  }

  .icon-btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    background: rgba(3, 7, 16, 0.95);
    border: 1px solid rgba(0, 240, 255, 0.42);
    color: #8ee8ff;
    padding: 8px 14px 8px 10px;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 0.74rem;
    letter-spacing: 0.08em;
    clip-path: polygon(0 0, calc(100% - 7px) 0, 100% 7px, 100% 100%, 7px 100%, 0 calc(100% - 7px));
    box-shadow: inset 0 0 8px rgba(0, 0, 0, 0.85);
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
    user-select: none;
  }

  .icon-btn:hover {
    border-color: #00f0ff;
    color: #ffffff;
    background: rgba(0, 240, 255, 0.12);
  }

  .icon-btn.active {
    background: rgba(255, 119, 0, 0.16);
    color: #ffaa33;
    border-color: #ff7700;
  }

  .icon-btn.active .cmd-led {
    background: #ff7700;
    box-shadow: 0 0 7px rgba(255, 119, 0, 0.85);
  }

  .btn-glyph {
    font-family: var(--font-mono);
    font-weight: bold;
    font-size: 0.88rem;
  }

  .volume-slider {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 0.76rem;
    font-family: var(--font-mono);
    background: rgba(3, 7, 16, 0.95);
    border: 1px solid rgba(255, 119, 0, 0.45);
    clip-path: polygon(0 0, calc(100% - 7px) 0, 100% 7px, 100% 100%, 7px 100%, 0 calc(100% - 7px));
    box-shadow: inset 0 0 8px rgba(0, 0, 0, 0.85);
    padding: 6px 14px;
    user-select: none;
  }

  .vol-label-group {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .vol-led {
    width: 5px;
    height: 13px;
    background: #ff7700;
    box-shadow: 0 0 6px rgba(255, 119, 0, 0.75);
  }

  .vol-led.muted {
    background: #ff2a4d;
    box-shadow: 0 0 6px rgba(255, 42, 77, 0.85);
  }

  .vol-prefix {
    color: rgba(255, 119, 0, 0.65);
    font-size: 0.65rem;
    font-weight: bold;
  }

  .vol-label {
    color: #ff7700;
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: 0.1em;
    text-shadow: 0 0 6px rgba(255, 119, 0, 0.5);
  }

  .vol-track-wrap {
    position: relative;
    display: flex;
    align-items: center;
    width: 112px;
    height: 18px;
  }

  .vol-segments {
    display: grid;
    grid-template-columns: repeat(10, 1fr);
    gap: 3px;
    width: 100%;
    height: 12px;
    pointer-events: none;
  }

  .vol-seg {
    background: rgba(255, 119, 0, 0.1);
    border: 1px solid rgba(255, 119, 0, 0.25);
    height: 100%;
  }

  .vol-seg.lit {
    background: #ff7700;
    border-color: #ffaa33;
    box-shadow: 0 0 5px rgba(255, 119, 0, 0.6);
  }

  .vol-seg.lit.mid {
    background: #00f0ff;
    border-color: #7df6ff;
    box-shadow: 0 0 6px rgba(0, 240, 255, 0.75);
  }

  .vol-seg.lit.peak {
    background: #ff2a4d;
    border-color: #ff7a90;
    box-shadow: 0 0 6px rgba(255, 42, 77, 0.8);
  }

  .volume-slider input[type="range"] {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }

  .vol-val {
    color: #00f0ff;
    min-width: 40px;
    text-align: right;
    font-weight: bold;
    font-size: 0.84rem;
    font-variant-numeric: tabular-nums;
    text-shadow: 0 0 6px rgba(0, 240, 255, 0.6);
  }

  /* Queue Manifest */
  .queue-card {
    background: #020408;
    background-image:
      linear-gradient(rgba(255, 119, 0, 0.03) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 119, 0, 0.03) 1px, transparent 1px);
    background-size: 16px 16px;
    border: 1px solid rgba(255, 119, 0, 0.42);
    border-top: 2px solid #ff7700;
    box-shadow: 0 0 18px rgba(0, 0, 0, 0.8), inset 0 0 14px rgba(255, 119, 0, 0.05);
    clip-path: polygon(0 0, calc(100% - 14px) 0, 100% 14px, 100% 100%, 14px 100%, 0 calc(100% - 14px));
    padding: 14px 18px 18px;
    position: relative;
    overflow: hidden;
  }

  .queue-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
    margin-bottom: 12px;
    padding-bottom: 10px;
    border-bottom: 1px solid rgba(255, 119, 0, 0.28);
  }

  .queue-title-group {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .tech-code {
    background: rgba(255, 119, 0, 0.14);
    color: #ff9500;
    border: 1px solid rgba(255, 119, 0, 0.65);
    padding: 2px 8px;
    font-family: var(--font-mono);
    font-weight: 800;
    font-size: 0.68rem;
    letter-spacing: 0.12em;
    clip-path: polygon(0 0, calc(100% - 4px) 0, 100% 4px, 100% 100%, 4px 100%, 0 calc(100% - 4px));
  }

  .queue-card h3 {
    margin: 0;
    font-family: var(--font-display);
    font-size: 0.84rem;
    font-weight: 800;
    color: #ff9500;
    letter-spacing: 0.14em;
    text-shadow: 0 0 8px rgba(255, 119, 0, 0.45);
  }

  .add-songs-btn {
    display: inline-flex;
    align-items: center;
    cursor: pointer;
    min-height: 34px;
    padding: 6px 14px;
  }

  .queue-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 250px;
    overflow-y: auto;
    content-visibility: auto;
    contain-intrinsic-size: auto 200px;
    padding-right: 4px;
  }

  .queue-list::-webkit-scrollbar {
    width: 6px;
  }

  .queue-list::-webkit-scrollbar-track {
    background: #020408;
    border: 1px solid rgba(255, 119, 0, 0.18);
  }

  .queue-list::-webkit-scrollbar-thumb {
    background: #ff7700;
  }

  .queue-item {
    width: 100%;
    text-align: left;
    display: flex;
    align-items: center;
    padding: 8px 12px;
    background: rgba(4, 7, 13, 0.94);
    border: 1px solid rgba(255, 119, 0, 0.24);
    border-left: 3px solid rgba(255, 119, 0, 0.48);
    clip-path: polygon(0 0, calc(100% - 7px) 0, 100% 7px, 100% 100%, 7px 100%, 0 calc(100% - 7px));
    cursor: pointer;
    gap: 11px;
    text-transform: none;
    transition: background 0.15s ease, border-color 0.15s ease;
  }

  .queue-item:hover {
    background: rgba(255, 119, 0, 0.08);
    border-color: rgba(255, 119, 0, 0.72);
  }

  .queue-item.active {
    background: linear-gradient(90deg, rgba(255, 119, 0, 0.16) 0%, rgba(0, 255, 136, 0.05) 100%);
    border: 1.5px solid #ff7700;
    border-left: 4px solid #00ff88;
    box-shadow: inset 0 0 12px rgba(255, 119, 0, 0.12);
  }

  .q-idx {
    font-family: var(--font-mono);
    font-size: 0.78rem;
    color: #ff9500;
    background: rgba(255, 119, 0, 0.08);
    border: 1px solid rgba(255, 119, 0, 0.35);
    padding: 2px 7px;
    min-width: 28px;
    text-align: center;
    font-weight: 800;
    letter-spacing: 0.06em;
  }

  .queue-item.active .q-idx {
    color: #020408;
    background: #00ff88;
    border-color: #6effb8;
    box-shadow: 0 0 8px rgba(0, 255, 136, 0.55);
    font-weight: 900;
  }

  .q-meta {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }

  .q-title {
    font-size: 0.92rem;
    font-family: var(--font-body);
    font-weight: 700;
    color: #f1f5f9;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    letter-spacing: 0.02em;
  }

  .queue-item.active .q-title {
    color: #fff8ea;
    text-shadow: 0 0 6px rgba(255, 185, 85, 0.45);
  }

  .q-artist {
    font-size: 0.74rem;
    font-family: var(--font-mono);
    color: rgba(148, 163, 184, 0.8);
    margin-top: 1px;
  }

  .queue-item.active .q-artist {
    color: #ffaa55;
  }

  .q-standby {
    font-family: var(--font-mono);
    font-size: 0.64rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    color: rgba(255, 149, 0, 0.65);
    border: 1px solid rgba(255, 119, 0, 0.28);
    background: rgba(255, 119, 0, 0.05);
    padding: 2px 7px;
    flex-shrink: 0;
  }

  .q-playing {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 0.68rem;
    background: rgba(0, 255, 136, 0.14);
    color: #00ff88;
    border: 1px solid rgba(0, 255, 136, 0.65);
    padding: 2px 8px;
    font-weight: 900;
    font-family: var(--font-mono);
    letter-spacing: 0.12em;
    flex-shrink: 0;
    text-shadow: 0 0 6px rgba(0, 255, 136, 0.45);
  }

  .q-pulse-dot {
    width: 6px;
    height: 6px;
    background: #00ff88;
    border-radius: 50%;
    animation: blink-dot 0.8s infinite alternate;
  }

  @keyframes blink-dot {
    0% { opacity: 0.25; transform: scale(0.75); }
    100% { opacity: 1; transform: scale(1.1); }
  }

  .q-drag-handle {
    cursor: grab;
    color: rgba(255, 119, 0, 0.42);
    font-size: 1rem;
    padding: 0 2px;
    display: inline-flex;
    align-items: center;
    user-select: none;
    transition: color 0.15s ease;
  }

  .q-drag-handle:hover {
    color: #ff9500;
  }

  .queue-item:active .q-drag-handle {
    cursor: grabbing;
  }

  .queue-item.is-dragging {
    opacity: 0.42;
    border: 1.5px dashed #ff7700;
    transform: scale(0.99);
  }

  .queue-item.drag-over {
    border: 1.5px solid #00ff88;
    background: rgba(0, 255, 136, 0.1);
  }

  .q-item-right {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
    margin-left: auto;
  }

  .q-reorder-group {
    display: inline-flex;
    align-items: center;
    background: rgba(2, 4, 9, 0.95);
    border: 1px solid rgba(255, 119, 0, 0.35);
    padding: 2px 4px;
    gap: 2px;
    flex-shrink: 0;
  }

  .queue-item.active .q-reorder-group {
    border-color: rgba(255, 119, 0, 0.55);
  }

  .q-nudge-btn {
    background: transparent;
    border: none;
    color: #ff9500;
    font-size: 0.65rem;
    padding: 4px 6px;
    cursor: pointer;
    font-family: var(--font-mono);
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.12s ease, color 0.12s ease;
  }

  .q-nudge-btn:hover:not(:disabled) {
    background: rgba(255, 119, 0, 0.25);
    color: #ffffff;
  }

  .q-nudge-btn:disabled {
    opacity: 0.22;
    cursor: not-allowed;
  }

  /* Sidebar & Logs */
  .sidebar {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(290px, 1fr));
    gap: 20px;
    align-items: start;
    min-width: 0;
  }

  @media (min-width: 1450px) {
    .sidebar {
      display: flex;
      flex-direction: column;
    }
  }

  .log-card {
    background: #020409;
    background-image:
      linear-gradient(rgba(0, 240, 255, 0.035) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0, 240, 255, 0.035) 1px, transparent 1px);
    background-size: 16px 16px;
    border: 1.5px solid rgba(0, 240, 255, 0.38);
    box-shadow: 0 0 22px rgba(0, 240, 255, 0.16), inset 0 0 14px rgba(0, 240, 255, 0.05);
    clip-path: polygon(0 0, calc(100% - 14px) 0, 100% 14px, 100% 100%, 14px 100%, 0 calc(100% - 14px));
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    flex: 1;
    width: 100%;
    box-sizing: border-box;
  }

  .nerv-card-strip.cyan-strip {
    height: 3px;
    width: 100%;
    background: repeating-linear-gradient(
      -45deg,
      #00f0ff 0px,
      #00f0ff 8px,
      #040814 8px,
      #040814 16px
    );
    margin-bottom: 10px;
    box-shadow: 0 0 8px rgba(0, 240, 255, 0.45);
  }

  .log-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-family: var(--font-display);
    font-size: 0.78rem;
    color: var(--text-primary);
    margin-bottom: 10px;
    letter-spacing: 0.1em;
  }

  .log-title-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .log-title-wrap span:last-child {
    font-weight: 800;
    color: #00f0ff;
    text-shadow: 0 0 6px rgba(0, 240, 255, 0.5);
  }

  .log-code {
    background: rgba(0, 240, 255, 0.15);
    color: #00f0ff;
    border: 1px solid rgba(0, 240, 255, 0.5);
    padding: 2px 7px;
    font-family: var(--font-mono);
    font-size: 0.68rem;
    font-weight: bold;
    clip-path: polygon(0 0, calc(100% - 4px) 0, 100% 4px, 100% 100%, 4px 100%, 0 calc(100% - 4px));
    text-shadow: 0 0 6px rgba(0, 240, 255, 0.6);
  }

  .log-indicator {
    font-family: var(--font-mono);
    color: #00f0ff;
    font-weight: bold;
    font-size: 0.78rem;
    letter-spacing: 0.08em;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    text-shadow: 0 0 6px rgba(0, 240, 255, 0.6);
  }

  .log-beacon {
    color: #00f0ff;
    font-size: 0.7rem;
    animation: blink-beacon 0.8s infinite alternate ease-in-out;
  }

  @keyframes blink-beacon {
    0% { opacity: 0.3; transform: scale(0.85); text-shadow: 0 0 2px #00f0ff; }
    100% { opacity: 1; transform: scale(1.15); text-shadow: 0 0 10px #00f0ff; }
  }

  .log-window {
    background: #020408;
    background-image:
      linear-gradient(rgba(0, 240, 255, 0.03) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0, 240, 255, 0.03) 1px, transparent 1px),
      repeating-linear-gradient(0deg, rgba(0, 240, 255, 0.025) 0px, rgba(0, 240, 255, 0.025) 1px, transparent 1px, transparent 3px);
    background-size: 16px 16px, 16px 16px, 100% 3px;
    border: 1px solid rgba(0, 240, 255, 0.35);
    box-shadow: inset 0 0 18px rgba(0, 240, 255, 0.08), 0 0 10px rgba(0, 240, 255, 0.1);
    padding: 12px;
    font-family: var(--font-mono);
    font-size: 0.8rem;
    height: 230px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 7px;
    content-visibility: auto;
    contain-intrinsic-size: auto 230px;
  }

  .log-window::-webkit-scrollbar {
    width: 6px;
  }

  .log-window::-webkit-scrollbar-track {
    background: #020610;
    border: 1px solid rgba(0, 240, 255, 0.15);
  }

  .log-window::-webkit-scrollbar-thumb {
    background: #00f0ff;
    box-shadow: 0 0 8px rgba(0, 240, 255, 0.6);
  }

  .log-terminal-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 8px;
    margin-bottom: 4px;
    border-bottom: 1px solid rgba(0, 240, 255, 0.22);
    font-size: 0.68rem;
    letter-spacing: 0.1em;
  }

  .log-dots-group {
    display: flex;
    align-items: center;
    gap: 5px;
  }

  .log-dot {
    width: 7px;
    height: 7px;
    display: inline-block;
  }

  .log-dot.red { background: #ff2a4d; }
  .log-dot.amber { background: #ff9900; }
  .log-dot.green { background: #00ff66; }

  .log-term-title {
    margin-left: 6px;
    color: rgba(255, 255, 255, 0.85);
    font-weight: 700;
  }

  .log-term-sys {
    color: rgba(148, 163, 184, 0.75);
    font-size: 0.64rem;
  }

  .log-seq {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 28px;
    height: 16px;
    padding: 0 4px;
    font-size: 0.64rem;
    font-weight: 700;
    color: #67e8f9;
    background: rgba(0, 240, 255, 0.08);
    border: 1px solid rgba(0, 240, 255, 0.22);
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }

  .log-line {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    color: #9fe6f7;
    word-break: break-word;
    line-height: 1.35;
    letter-spacing: 0.03em;
    text-shadow: 0 0 3px rgba(0, 240, 255, 0.35);
  }

  .log-text {
    flex: 1;
  }

  .log-arrow {
    color: #ff7700;
    font-weight: 900;
    text-shadow: 0 0 6px #ff7700;
    flex-shrink: 0;
  }

  .log-prompt-line {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
    color: rgba(0, 240, 255, 0.6);
    font-family: var(--font-mono);
    font-size: 0.78rem;
  }

  .prompt-text {
    color: rgba(0, 240, 255, 0.6);
    letter-spacing: 0.06em;
  }

  .blinking-cursor {
    color: #00f0ff;
    font-weight: 900;
    animation: blink-cursor 0.8s infinite step-start;
    text-shadow: 0 0 8px #00f0ff;
  }

  @keyframes blink-cursor {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  .text-muted {
    color: var(--text-dim);
  }

</style>
