<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { PeerNodeInfo } from './p2p-mesh';

  let {
    peers = [],
    activeStream = false
  }: {
    peers: PeerNodeInfo[];
    activeStream?: boolean;
  } = $props();

  const UNITS = [
    { id: '01', name: 'MELCHIOR 1', requiredNodes: 1 },
    { id: '02', name: 'BALTHASAR 2', requiredNodes: 2 },
    { id: '03', name: 'CASPER 3', requiredNodes: 3 }
  ] as const;

  const CODE_LINES = [
    'await harmonics.verify();',
    'if (waveform.type === BLUE) {',
    'LCL_PRESSURE.normalize();',
    'exec PRIORITY_ALPHA;',
    '0x3C7B verify_consensus(3/3)',
    'sync_rate = calc(0.9942);',
    '0xCC41 NEURAL_LINK :: stable',
    'PILOT_SYNC :: locked',
    '0x7F3A >> PATTERN_ANALYSIS',
    '0xD4F0 >> compile_verdict()',
    'scan SECTOR_7G :: pass',
    '0x88A1 sync CASPER_LOGIC',
    '0xAF02 :: SIGNAL_PROC',
    'deploy AT_FIELD_BARRIER;',
    '0x1B9E mem_alloc(PRIBNOW_BOX)',
    'return MAGI_CONSENSUS;',
    'mesh_relay.route(PYRAMID);',
    'buffer_integrity :: CHECK O.K.'
  ];

  // Track a scrolling offset + highlighted line index per unit
  let tick = $state(0);
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const activeCount = $derived(Math.min(3, Math.max(1, peers.length || 1)));

  $effect(() => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    // Gentle 700ms step so it feels alive without heavy CPU/GPU load
    intervalId = setInterval(() => {
      tick = (tick + 1) % CODE_LINES.length;
    }, activeStream ? 550 : 950);

    return () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };
  });

  onDestroy(() => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  });

  function getUnitLines(unitIndex: number, currentTick: number): { text: string; hot: boolean }[] {
    const visibleCount = 9;
    const offset = (currentTick + unitIndex * 5) % CODE_LINES.length;
    const result: { text: string; hot: boolean }[] = [];
    for (let i = 0; i < visibleCount; i++) {
      const idx = (offset + i) % CODE_LINES.length;
      const hot = i === 2 || i === 5 || i === visibleCount - 1;
      result.push({ text: CODE_LINES[idx], hot });
    }
    return result;
  }

  function getProgressPct(unitIndex: number, currentTick: number): number {
    return 62 + ((currentTick * 11 + unitIndex * 23) % 36);
  }
</script>

<section class="magi-compute-panel" aria-label="MAGI Super Computer System">
  <header class="magi-compute-header">
    <span class="magi-compute-title">MAGI SUPER COMPUTER SYSTEM</span>
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
            {#each getUnitLines(idx, tick) as line}
              <div class="magi-code-line" class:hot={line.hot}>{line.text}</div>
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
            style="width: {isActive ? getProgressPct(idx, tick) : 0}%"
          ></div>
        </div>

        <div class="magi-col-foot">
          {isActive ? 'COMPUTING...' : 'STANDBY'}
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

  .magi-compute-title {
    font-family: var(--font-display);
    font-size: 0.74rem;
    font-weight: 800;
    letter-spacing: 0.14em;
    color: #ff9500;
    text-shadow: 0 0 8px rgba(255, 119, 0, 0.45);
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
