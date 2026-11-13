<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { PeerNodeInfo } from './p2p-mesh';

  let {
    peers = [],
    activeStream = false,
    volume = 0.8,
    visMode = 'lo',
    trackTitle = '',
    trackArtist = '',
    currentTime = 0,
    duration = 0,
    bufferProgress = 100,
    stationCode = '',
    mode = 'listener',
    isShuffled = false,
    queueLength = 0
  }: {
    peers: PeerNodeInfo[];
    activeStream?: boolean;
    volume?: number;
    visMode?: 'off' | 'lo' | 'hi';
    trackTitle?: string;
    trackArtist?: string;
    currentTime?: number;
    duration?: number;
    bufferProgress?: number;
    stationCode?: string;
    mode?: 'dj' | 'listener';
    isShuffled?: boolean;
    queueLength?: number;
  } = $props();

  interface CodeEntry {
    text: string;
    tone: 'dim' | 'hot' | 'pass' | 'fail';
  }

  const UNITS = [
    { id: '01', name: 'MELCHIOR 1', short: 'MELCHIOR', requiredNodes: 1 },
    { id: '02', name: 'BALTHASAR 2', short: 'BALTHASAR', requiredNodes: 2 },
    { id: '03', name: 'CASPER 3', short: 'CASPER', requiredNodes: 3 }
  ] as const;

  const VISIBLE_LINES = 8;

  const activeCount = $derived(Math.min(3, Math.max(1, peers.length || 1)));
  const consensusState = $derived.by(() => {
    if (activeCount >= 3) return { label: '3/3 UNANIMOUS', status: 'pass' as const };
    if (activeCount === 2) return { label: '2/3 CONSENSUS PASS', status: 'warn' as const };
    return { label: '1/3 CONSENSUS FAILED', status: 'fail' as const };
  });

  function randHex(digits = 4): string {
    const max = Math.pow(16, digits);
    return '0x' + Math.floor(Math.random() * max).toString(16).toUpperCase().padStart(digits, '0');
  }

  function fmtClock(sec: number): string {
    if (!Number.isFinite(sec) || sec < 0) return '00:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function sanitizeTag(raw: string, fallback: string, maxLen = 16): string {
    const clean = (raw || fallback).replace(/[^a-zA-Z0-9_.\- ]/g, '').trim();
    return (clean || fallback).slice(0, maxLen).toUpperCase();
  }

  function generateLiveLine(unitIndex: number): CodeEntry {
    const unit = UNITS[unitIndex];
    const addr = randHex(4);
    const volPct = Math.round(volume * 100);
    const seekPct = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;
    const maxDepth = peers.length > 0 ? Math.max(...peers.map((p) => p.depth ?? 0)) : 0;
    const syncRate = activeStream ? (0.94 + Math.random() * 0.059).toFixed(4) : '0.0000';
    const titleTag = sanitizeTag(trackTitle, 'AWAITING_TX', 16);
    const artistTag = sanitizeTag(trackArtist, 'CENTRAL_DOGMA', 14);
    const stationTag = sanitizeTag(stationCode, 'GEOFRONT', 12);
    const visTag = visMode.toUpperCase();

    const generators: Array<() => CodeEntry> = [
      () => ({
        text: activeCount === 1
          ? `${addr} verify_consensus(1/3) :: FAILED`
          : activeCount === 2
            ? `${addr} verify_consensus(2/3) :: PASS`
            : `${addr} verify_consensus(3/3) :: UNANIMOUS`,
        tone: activeCount === 1 ? 'fail' : 'pass'
      }),
      () => ({
        text: `${addr} audio_gain.set(${volPct}%, ${volPct === 0 ? 'MUTE' : `${(20 * Math.log10(Math.max(volume, 0.01))).toFixed(1)}dB`});`,
        tone: volPct === 0 ? 'fail' : 'hot'
      }),
      () => ({
        text: `if (vis_mode === '${visTag}') ${visMode === 'off' ? 'deploy SEELE_02;' : 'render_fft();'}`,
        tone: visMode === 'off' ? 'dim' : 'hot'
      }),
      () => ({
        text: `${addr} track_lock("${titleTag}");`,
        tone: trackTitle ? 'hot' : 'dim'
      }),
      () => ({
        text: `${addr} origin_sig("${artistTag}");`,
        tone: 'dim'
      }),
      () => ({
        text: `seek_pos = ${seekPct.toFixed(1)}% [${fmtClock(currentTime)}/${fmtClock(duration)}];`,
        tone: activeStream ? 'hot' : 'dim'
      }),
      () => ({
        text: `${addr} mem_alloc(PRIBNOW_BOX, ${randHex(3)}K);`,
        tone: 'dim'
      }),
      () => ({
        text: `${addr} mem_alloc(${unit.short}_HEAP, ${128 + Math.floor(Math.random() * 896)}KB);`,
        tone: 'dim'
      }),
      () => ({
        text: `sync_rate = calc(${syncRate});`,
        tone: activeStream ? 'pass' : 'dim'
      }),
      () => ({
        text: `mesh_relay.route(${mode.toUpperCase()}, nodes=${peers.length}, d=${maxDepth});`,
        tone: 'hot'
      }),
      () => ({
        text: `buffer_integrity :: ${bufferProgress >= 100 ? 'CHECK O.K.' : `FILL_${Math.round(bufferProgress)}%`};`,
        tone: bufferProgress >= 100 ? 'pass' : 'dim'
      }),
      () => ({
        text: `if (waveform.type === ${activeStream ? 'BLUE' : 'ORANGE'}) {`,
        tone: 'dim'
      }),
      () => ({
        text: `${addr} >> PATTERN_ANALYSIS(${stationTag});`,
        tone: 'hot'
      }),
      () => ({
        text: `${addr} >> compile_verdict(${activeCount >= 2 ? 'ACCEPT' : 'DENY'});`,
        tone: activeCount >= 2 ? 'pass' : 'fail'
      }),
      () => ({
        text: `LCL_PRESSURE.normalize(${(98 + Math.random() * 4).toFixed(2)}kPa);`,
        tone: 'dim'
      }),
      () => ({
        text: `await harmonics.verify(${unit.short}_CH${unit.id});`,
        tone: 'dim'
      }),
      () => ({
        text: `deploy AT_FIELD_BARRIER;`,
        tone: 'dim'
      }),
      () => ({
        text: `${addr} shuffle_mode :: ${isShuffled ? 'RANDOMIZED' : 'LINEAR'} (${queueLength} TRKS);`,
        tone: isShuffled ? 'hot' : 'dim'
      }),
      () => ({
        text: `${addr} permute_queue(n=${queueLength}, ${isShuffled ? 'SHUFFLE' : 'SEQ'});`,
        tone: 'dim'
      }),
      () => ({
        text: `${addr} artist_vector("${artistTag}");`,
        tone: trackArtist ? 'hot' : 'dim'
      }),
      () => ({
        text: `${addr} id3_meta.bind("${artistTag}", "${titleTag.slice(0, 10)}");`,
        tone: 'dim'
      }),
      () => ({
        text: `${addr} dma_ring_push(CH_${unit.id}, 64KB);`,
        tone: 'dim'
      }),
      () => ({
        text: `${addr} fft_window(4096, HANNING);`,
        tone: visMode === 'off' ? 'dim' : 'hot'
      }),
      () => ({
        text: `${addr} p2p_tree.balance(peers=${peers.length});`,
        tone: 'dim'
      }),
      () => ({
        text: `${addr} phase_lock(PLL_SYNC, ${activeStream ? 'LOCKED' : 'HOLD'});`,
        tone: activeStream ? 'pass' : 'dim'
      }),
      () => ({
        text: `${addr} lcl_density(${(0.985 + Math.random() * 0.014).toFixed(4)});`,
        tone: 'dim'
      }),
      () => ({
        text: `${addr} packet_crc32(${randHex(4)}${randHex(4).slice(2)});`,
        tone: 'dim'
      }),
      () => ({
        text: `${addr} webrtc_ice.probe(NAT_BYPASS);`,
        tone: 'dim'
      }),
      () => ({
        text: `${addr} jitter_buf(${12 + Math.floor(Math.random() * 48)}ms);`,
        tone: 'dim'
      }),
      () => ({
        text: `${addr} clock_drift(${(Math.random() * 2.4 - 1.2).toFixed(2)}ms);`,
        tone: 'dim'
      }),
      () => ({
        text: `${addr} plug_depth(${(42 + Math.random() * 35).toFixed(1)}m);`,
        tone: 'dim'
      }),
      () => ({
        text: `${addr} a10_nerve_sync(${activeStream ? (96 + Math.random() * 3.9).toFixed(2) : '0.00'}%);`,
        tone: activeStream ? 'pass' : 'dim'
      }),
      () => ({
        text: `${addr} casper_heuristic(${isShuffled ? 'STOCHASTIC' : 'ORDERED'});`,
        tone: 'dim'
      }),
      () => ({
        text: `${addr} pribn0w_gate(${activeCount >= 2 ? 'OPEN' : 'SEALED'});`,
        tone: activeCount >= 2 ? 'pass' : 'fail'
      }),
      () => ({
        text: `${addr} bitrate_est(${activeStream ? 128 + Math.floor(Math.random() * 192) : 0}kbps);`,
        tone: activeStream ? 'hot' : 'dim'
      })
    ];

    const recent = recentGens[unitIndex];
    const candidates: number[] = [];
    for (let i = 0; i < generators.length; i++) {
      if (!recent.includes(i)) candidates.push(i);
    }
    const pool = candidates.length > 0 ? candidates : Array.from({ length: generators.length }, (_, i) => i);
    const idx = pool[Math.floor(Math.random() * pool.length)];
    recent.push(idx);
    if (recent.length > 7) recent.shift();
    return generators[idx]();
  }

  const recentGens: [number[], number[], number[]] = [[], [], []];

  function makeInitialBuffer(unitIndex: number): CodeEntry[] {
    return Array.from({ length: VISIBLE_LINES }, () => generateLiveLine(unitIndex));
  }

  let unitBuffers = $state<[CodeEntry[], CodeEntry[], CodeEntry[]]>([
    makeInitialBuffer(0),
    makeInitialBuffer(1),
    makeInitialBuffer(2)
  ]);
  let unitProgress = $state<[number, number, number]>([74, 68, 82]);
  const unitTimers: Array<ReturnType<typeof setTimeout> | null> = [null, null, null];

  function clearAllUnitTimers() {
    for (let i = 0; i < unitTimers.length; i++) {
      if (unitTimers[i] !== null) {
        clearTimeout(unitTimers[i]!);
        unitTimers[i] = null;
      }
    }
  }

  function nextUnitDelay(streaming: boolean): number {
    return streaming
      ? 320 + Math.floor(Math.random() * 560)
      : 680 + Math.floor(Math.random() * 780);
  }

  $effect(() => {
    const streaming = activeStream;
    clearAllUnitTimers();
    let cancelled = false;

    const scheduleUnit = (unitIndex: number) => {
      if (cancelled) return;
      unitTimers[unitIndex] = setTimeout(() => {
        if (cancelled) return;
        const nextBuffers: [CodeEntry[], CodeEntry[], CodeEntry[]] = [
          unitBuffers[0],
          unitBuffers[1],
          unitBuffers[2]
        ];
        nextBuffers[unitIndex] = [...unitBuffers[unitIndex].slice(1), generateLiveLine(unitIndex)];
        unitBuffers = nextBuffers;

        const nextProgress: [number, number, number] = [
          unitProgress[0],
          unitProgress[1],
          unitProgress[2]
        ];
        nextProgress[unitIndex] = streaming
          ? 64 + Math.floor(Math.random() * 36)
          : 24 + Math.floor(Math.random() * 34);
        unitProgress = nextProgress;

        scheduleUnit(unitIndex);
      }, nextUnitDelay(streaming));
    };

    for (let i = 0; i < UNITS.length; i++) {
      scheduleUnit(i);
    }

    return () => {
      cancelled = true;
      clearAllUnitTimers();
    };
  });

  onDestroy(() => {
    clearAllUnitTimers();
  });
</script>

<section class="magi-compute-panel" aria-label="MAGI Super Computer System">
  <header class="magi-compute-header">
    <div class="magi-title-group">
      <span class="magi-compute-title">MAGI SUPER COMPUTER SYSTEM</span>
      <span
        class="magi-consensus-pill"
        class:pass={consensusState.status === 'pass'}
        class:warn={consensusState.status === 'warn'}
        class:fail={consensusState.status === 'fail'}
      >
        {consensusState.label}
      </span>
    </div>
    <div class="magi-status-blocks" aria-hidden="true">
      {#each UNITS as unit, i}
        <span class="magi-block" class:lit={i < activeCount}></span>
      {/each}
    </div>
  </header>

  <div class="magi-columns">
    {#each UNITS as unit, idx (unit.id)}
      {@const isActive = idx < activeCount}
      {@const peerNode = peers[idx]}
      <div class="magi-col" class:standby={!isActive}>
        <div class="magi-col-head">
          <span class="magi-col-name">{unit.name}</span>
          <span class="magi-col-num">{unit.id}</span>
        </div>

        <div class="magi-col-body">
          {#if isActive}
            {#if peerNode}
              <div class="magi-code-line peer-line">
                NODE // {peerNode.role.toUpperCase()} [{peerNode.peerId.slice(-6)}]
              </div>
            {/if}
            {#each unitBuffers[idx] as line}
              <div
                class="magi-code-line"
                class:hot={line.tone === 'hot'}
                class:pass={line.tone === 'pass'}
                class:fail={line.tone === 'fail'}
              >
                {line.text}
              </div>
            {/each}
          {:else}
            <div class="magi-standby-msg">
              <span>NODE_SLOT_{unit.id} // OFFLINE</span>
              <small>AWAITING PEER CONNECTION</small>
            </div>
          {/if}
        </div>

        <div class="magi-col-progress">
          <div
            class="magi-col-progress-fill"
            style="width: {isActive ? unitProgress[idx] : 0}%"
          ></div>
        </div>

        <div class="magi-col-foot">
          {isActive ? (activeStream ? 'COMPUTING...' : 'IDLE_SCAN') : 'STANDBY'}
        </div>
      </div>
    {/each}
  </div>
</section>

<style>
  .magi-compute-panel {
    background: #020408;
    border: 1px solid rgba(255, 119, 0, 0.38);
    box-shadow: 0 0 18px rgba(0, 0, 0, 0.8), inset 0 0 14px rgba(0, 240, 255, 0.04);
    clip-path: polygon(0 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 12px 100%, 0 calc(100% - 12px));
    overflow: hidden;
  }

  .magi-compute-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 14px;
    background: rgba(12, 16, 24, 0.95);
    border-bottom: 1px solid rgba(255, 119, 0, 0.35);
  }

  .magi-title-group {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
  }

  .magi-compute-title {
    font-family: var(--font-display);
    font-size: 0.74rem;
    font-weight: 800;
    letter-spacing: 0.14em;
    color: #ff9500;
    text-shadow: 0 0 8px rgba(255, 119, 0, 0.45);
  }

  .magi-consensus-pill {
    font-family: var(--font-mono);
    font-size: 0.62rem;
    font-weight: bold;
    letter-spacing: 0.08em;
    padding: 1px 6px;
    border: 1px solid rgba(255, 119, 0, 0.45);
    color: #ff9500;
  }

  .magi-consensus-pill.pass {
    border-color: rgba(57, 255, 106, 0.55);
    color: #39ff6a;
    background: rgba(57, 255, 106, 0.1);
  }

  .magi-consensus-pill.warn {
    border-color: rgba(255, 153, 0, 0.6);
    color: #ffbb33;
    background: rgba(255, 153, 0, 0.12);
  }

  .magi-consensus-pill.fail {
    border-color: rgba(255, 42, 77, 0.65);
    color: #ff4d6d;
    background: rgba(255, 42, 77, 0.14);
  }

  .magi-status-blocks {
    display: flex;
    align-items: center;
    gap: 5px;
  }

  .magi-block {
    width: 7px;
    height: 7px;
    background: rgba(0, 240, 255, 0.14);
    border: 1px solid rgba(0, 240, 255, 0.3);
  }

  .magi-block.lit {
    background: #00f0ff;
    border-color: #7df6ff;
    box-shadow: 0 0 6px rgba(0, 240, 255, 0.85);
  }

  .magi-columns {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .magi-col {
    display: flex;
    flex-direction: column;
    border-right: 1px solid rgba(255, 255, 255, 0.08);
    min-width: 0;
  }

  .magi-col:last-child {
    border-right: none;
  }

  .magi-col-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 7px 10px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(6, 10, 18, 0.9);
  }

  .magi-col-name {
    font-family: var(--font-display);
    font-size: 0.72rem;
    font-weight: 800;
    letter-spacing: 0.12em;
    color: #ff9500;
  }

  .magi-col.standby .magi-col-name {
    color: rgba(255, 149, 0, 0.38);
  }

  .magi-col-num {
    font-family: var(--font-mono);
    font-size: 0.66rem;
    color: rgba(148, 163, 184, 0.65);
  }

  .magi-col-body {
    height: 146px;
    padding: 8px 10px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: #010306;
    font-family: var(--font-mono);
    font-size: 0.65rem;
    line-height: 1.32;
  }

  .magi-code-line {
    color: rgba(0, 240, 255, 0.24);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .magi-code-line.hot {
    color: #00f0ff;
    text-shadow: 0 0 6px rgba(0, 240, 255, 0.55);
  }

  .magi-code-line.pass {
    color: #39ff6a;
    text-shadow: 0 0 6px rgba(57, 255, 106, 0.45);
  }

  .magi-code-line.fail {
    color: #ff4d6d;
    text-shadow: 0 0 6px rgba(255, 42, 77, 0.5);
  }

  .magi-code-line.peer-line {
    color: #ff9500;
    margin-bottom: 2px;
  }

  .magi-standby-msg {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    text-align: center;
    color: rgba(148, 163, 184, 0.42);
    letter-spacing: 0.08em;
  }

  .magi-standby-msg small {
    font-size: 0.58rem;
    color: rgba(255, 42, 77, 0.55);
  }

  .magi-col-progress {
    height: 2px;
    background: rgba(0, 240, 255, 0.08);
  }

  .magi-col-progress-fill {
    height: 100%;
    background: #00f0ff;
    box-shadow: 0 0 6px rgba(0, 240, 255, 0.75);
    transition: width 0.35s ease;
  }

  .magi-col-foot {
    padding: 6px 10px;
    text-align: center;
    font-family: var(--font-mono);
    font-size: 0.66rem;
    font-weight: 700;
    letter-spacing: 0.14em;
    color: #00f0ff;
    background: rgba(6, 10, 18, 0.92);
    text-shadow: 0 0 6px rgba(0, 240, 255, 0.55);
  }

  .magi-col.standby .magi-col-foot {
    color: rgba(148, 163, 184, 0.45);
    text-shadow: none;
  }

  @media (max-width: 720px) {
    .magi-columns {
      grid-template-columns: 1fr;
    }
    .magi-col {
      border-right: none;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .magi-col:last-child {
      border-bottom: none;
    }
  }
</style>
