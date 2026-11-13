<script lang="ts">
  let {
    progress = 0, // 0 to 100
    trackTitle = '',
    totalChunks = 0,
    bufferedChunks = 0,
    onEngage = () => {}
  }: {
    progress: number;
    trackTitle?: string;
    totalChunks?: number;
    bufferedChunks?: number;
    onEngage?: () => void;
  } = $props();

  // 12 columns total (6 pairs), 10 bars per column = 120 total bars
  const TOTAL_BARS = 120;
  let activeBars = $derived(Math.max(0, Math.min(TOTAL_BARS, Math.floor((progress / 100) * TOTAL_BARS))));

  // Top 5 battery / level segments (0 to 5)
  let topSegments = $derived(Math.max(0, Math.min(5, Math.floor(progress / 20))));
  let topPartialOpacity = $derived(((progress % 20) / 20));

  function isBarLit(colIdx: number, rowIdx: number): boolean {
    const globalIdx = colIdx * 10 + rowIdx;
    return globalIdx < activeBars;
  }

  function isBarCurrent(colIdx: number, rowIdx: number): boolean {
    const globalIdx = colIdx * 10 + rowIdx;
    return globalIdx === activeBars && progress < 100;
  }

  function isPairLit(pairIdx: number): boolean {
    // A pair has 20 bars (2 columns * 10)
    return (pairIdx * 20 + 10) <= activeBars;
  }
</script>

<div class="eva-buffer-container" role="region" aria-label="Evangelion Buffer Analysis">
  <svg class="eva-buffer-svg" viewBox="0 0 1000 400" preserveAspectRatio="xMidYMid meet">
    <defs>
      <!-- Background Cyberpunk / NERV Grid Pattern -->
      <pattern id="nerv-grid" width="16" height="16" patternUnits="userSpaceOnUse">
        <path d="M 16 0 L 0 0 0 16" fill="none" stroke="#2a0a03" stroke-width="0.8" />
      </pattern>

      <!-- Glow Filter for Active Chevron Energy -->
      <filter id="amber-glow" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="2.5" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>

      <!-- Chevron Parallelogram Symbol (Left-tilted /) -->
      <!-- Width: 46px, Height: 12px, Slant: 14px -->
      <g id="chev-left">
        <polygon points="0,12 14,0 46,0 32,12" />
        <!-- Micro notch chip on top edge -->
        <rect x="12" y="-3" width="8" height="3" />
      </g>

      <!-- Chevron Parallelogram Symbol (Right-tilted \) -->
      <g id="chev-right">
        <polygon points="14,12 0,0 32,0 46,12" />
        <!-- Micro notch chip on top edge -->
        <rect x="2" y="-3" width="8" height="3" />
      </g>
    </defs>

    <!-- Outer Frame Grid Canvas -->
    <rect x="12" y="10" width="976" height="380" fill="#040201" stroke="#3d1205" stroke-width="1.2" />
    <rect x="16" y="14" width="968" height="372" fill="url(#nerv-grid)" />

    <!-- Top Right Status Header -->
    <text x="960" y="32" text-anchor="end" class="hud-top-title">
      TEST RENDER : 01
    </text>

    <!-- Top Left 5 Battery Segments -->
    <g class="top-battery-bar">
      {#each [0, 1, 2, 3, 4] as s}
        <g transform="translate({50 + s * 34}, 18)">
          <!-- Outer border -->
          <rect x="0" y="0" width="30" height="12" fill="#0c0402" stroke="#501606" stroke-width="1" />
          <!-- Inner fill depending on progress -->
          {#if s < topSegments}
            <rect x="2" y="2" width="26" height="8" fill="#ff7b00" filter="url(#amber-glow)" />
          {:else if s === topSegments && progress < 100}
            <rect x="2" y="2" width="26" height="8" fill="#ff7b00" opacity={0.3 + topPartialOpacity * 0.7} />
          {/if}
        </g>
      {/each}
    </g>

    <!-- Outer Frame Double Borders with Corner Bracket Notches -->
    <rect x="75" y="46" width="850" height="332" fill="none" stroke="#601a08" stroke-width="1.2" />
    <rect x="80" y="52" width="840" height="320" fill="none" stroke="#ff6a00" stroke-width="1.5" />

    <!-- Corner/Edge Tick Marks -->
    <rect x="78" y="378" width="16" height="4" fill="#ff7b00" />
    <rect x="906" y="378" width="16" height="4" fill="#ff7b00" />
    <rect x="926" y="180" width="4" height="24" fill="#ff7b00" />

    <!-- Top LED Ruler Ticks spanning across above the chevron banks -->
    <g class="led-ruler-ticks">
      {#each Array(52) as _, t}
        <rect x={86 + t * 9.6} y="44" width="5" height="3" fill="#ff7b00" opacity={t * 2 < progress ? 1 : 0.25} />
      {/each}
    </g>

    <!-- 6 PAIRS OF CHEVRONS (12 COLUMNS TOTAL) -->
    {#each [0, 1, 2, 3, 4, 5] as p}
      {@const pairX = 96 + p * 136}
      {@const col1X = pairX}
      {@const trunkX = pairX + 58}
      {@const col2X = pairX + 68}
      {@const col1Idx = p * 2}
      {@const col2Idx = p * 2 + 1}

      <!-- Center Circuit Bus Trunk Line -->
      <line
        x1={trunkX}
        y1="64"
        x2={trunkX}
        y2="280"
        stroke={isPairLit(p) ? '#ff7b00' : '#451205'}
        stroke-width={isPairLit(p) ? '1.5' : '1'}
      />

      <!-- 10 Rows of Chevrons in this Pair -->
      {#each [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as r}
        {@const y = 68 + r * 20.5}
        {@const lit1 = isBarLit(col1Idx, r)}
        {@const curr1 = isBarCurrent(col1Idx, r)}
        {@const lit2 = isBarLit(col2Idx, r)}
        {@const curr2 = isBarCurrent(col2Idx, r)}

        <!-- Horizontal Circuit Traces Branching to Bar 1 -->
        <path
          d="M {trunkX} {y + 6} L {col1X + 46} {y + 6} L {col1X + 22} {y - 2}"
          fill="none"
          stroke={lit1 ? '#ff7b00' : '#3d1004'}
          stroke-width={lit1 ? '1.2' : '0.8'}
        />

        <!-- Horizontal Circuit Traces Branching to Bar 2 -->
        <path
          d="M {trunkX} {y + 6} L {col2X} {y + 6} L {col2X + 16} {y - 2}"
          fill="none"
          stroke={lit2 ? '#ff7b00' : '#3d1004'}
          stroke-width={lit2 ? '1.2' : '0.8'}
        />

        <!-- Left Column Chevron -->
        <g
          transform="translate({col1X}, {y})"
          class="chev-bar"
          class:lit={lit1}
          class:current={curr1}
        >
          <use href="#chev-left" />
        </g>

        <!-- Right Column Chevron:
             Pair 0 uses left-tilt (/), Pairs 1..5 use right-tilt (\) to form V chevrons -->
        <g
          transform="translate({col2X}, {y})"
          class="chev-bar"
          class:lit={lit2}
          class:current={curr2}
        >
          {#if p === 0}
            <use href="#chev-left" />
          {:else}
            <use href="#chev-right" />
          {/if}
          <!-- Faint high-tech SYNC text on unlit bars -->
          {#if !lit2}
            <text x="24" y="9" font-size="5" fill="#4d1607" font-family="'Orbitron', monospace" text-anchor="middle" transform="rotate(-15 24 9)">
              SYNC
            </text>
          {/if}
        </g>
      {/each}

      <!-- Bottom Circuitry & Lower Nodes Under Each Pair -->
      {#if p === 0}
        <!-- Pair 0 Bottom: Symmetrical Bus Circuitry + 4 Symmetrical Stacked Chip Rectangles matching Columns 1 & 2 -->
        <g transform="translate({pairX}, 274)">
          <path d="M {trunkX - pairX} 0 L {trunkX - pairX} 8 L 29 8 L 29 15" fill="none" stroke={isPairLit(0) ? '#ff7b00' : '#451205'} stroke-width="1.2" />
          <path d="M {trunkX - pairX} 8 L 87 8 L 87 15" fill="none" stroke={isPairLit(0) ? '#ff7b00' : '#451205'} stroke-width="1.2" />
          <!-- Chips under column 1 -->
          <rect x="6" y="15" width="46" height="9" fill={isPairLit(0) ? '#ff7b00' : '#220802'} stroke={isPairLit(0) ? '#ffa000' : '#4d1406'} stroke-width="1" />
          <rect x="6" y="27" width="46" height="9" fill={isPairLit(0) ? '#ff7b00' : '#220802'} stroke={isPairLit(0) ? '#ffa000' : '#4d1406'} stroke-width="1" />
          <!-- Chips under column 2 -->
          <rect x="64" y="15" width="46" height="9" fill={isPairLit(0) ? '#ff7b00' : '#220802'} stroke={isPairLit(0) ? '#ffa000' : '#4d1406'} stroke-width="1" />
          <rect x="64" y="27" width="46" height="9" fill={isPairLit(0) ? '#ff7b00' : '#220802'} stroke={isPairLit(0) ? '#ffa000' : '#4d1406'} stroke-width="1" />
        </g>
      {:else if p >= 1 && p <= 3}
        <!-- Pairs 1, 2, 3 Bottom: Lower Chevron Pair (\ /) + SYNC Chip -->
        {@const pairLit = isPairLit(p)}
        <g transform="translate({pairX}, 280)">
          <!-- Bus line branching down to lower chevrons -->
          <path d="M {trunkX - pairX} 0 L {trunkX - pairX} 12 L 18 12 L 18 20" fill="none" stroke={pairLit ? '#ff7b00' : '#451205'} stroke-width="1.2" />
          <path d="M {trunkX - pairX} 12 L 102 12 L 102 20" fill="none" stroke={pairLit ? '#ff7b00' : '#451205'} stroke-width="1.2" />

          <!-- Lower left chevron -->
          <g transform="translate(6, 24)" class="chev-bar" class:lit={pairLit}>
            <polygon points="14,14 0,0 34,0 48,14" />
          </g>
          <!-- Lower right chevron -->
          <g transform="translate(66, 24)" class="chev-bar" class:lit={pairLit}>
            <polygon points="0,14 14,0 48,0 34,14" />
          </g>

          <!-- Small center SYNC node box -->
          <rect x="50" y="44" width="22" height="8" fill={pairLit ? '#ff7b00' : '#220802'} stroke={pairLit ? '#ffa000' : '#4d1406'} />
        </g>
      {:else}
        <!-- Pairs 4 & 5 Bottom: Double Stacked Memory Blocks -->
        {@const pairLit = isPairLit(p)}
        <g transform="translate({pairX}, 285)">
          <path d="M {trunkX - pairX} 0 L {trunkX - pairX} 16 L 36 16 L 36 24" fill="none" stroke={pairLit ? '#ff7b00' : '#451205'} stroke-width="1.2" />
          <path d="M {trunkX - pairX} 16 L 86 16 L 86 24" fill="none" stroke={pairLit ? '#ff7b00' : '#451205'} stroke-width="1.2" />

          <!-- Left block pair -->
          <rect x="22" y="24" width="34" height="9" fill={pairLit ? '#ff7b00' : '#220802'} stroke={pairLit ? '#ffa000' : '#4d1406'} />
          <rect x="22" y="36" width="34" height="9" fill={pairLit ? '#ff7b00' : '#220802'} stroke={pairLit ? '#ffa000' : '#4d1406'} />

          <!-- Right block pair -->
          <rect x="62" y="24" width="34" height="9" fill={pairLit ? '#ff7b00' : '#220802'} stroke={pairLit ? '#ffa000' : '#4d1406'} />
          <rect x="62" y="36" width="34" height="9" fill={pairLit ? '#ff7b00' : '#220802'} stroke={pairLit ? '#ffa000' : '#4d1406'} />
        </g>
      {/if}
    {/each}

    <!-- Bottom Left Telemetry Block: "ANALYSIS" -->
    <g class="bottom-analysis-block">
      <text x="94" y="332" class="analysis-heading">ANALYSIS</text>
      <text x="94" y="348" class="analysis-stat">
        BUFFER: {progress}% {progress === 100 ? '// SYNC COMPLETE' : `// P2P CHUNKS: ${bufferedChunks}/${totalChunks || 100}`}
      </text>
    </g>

    <!-- Scan Line Effect Sweep -->
    <line x1="80" y1="52" x2="80" y2="372" stroke="#ff8500" stroke-width="2" opacity="0.6" class="scan-beam">
      <animate attributeName="x1" values="80;920;80" dur="4s" repeatCount="indefinite" />
      <animate attributeName="x2" values="80;920;80" dur="4s" repeatCount="indefinite" />
      <animate attributeName="opacity" values="0.7;0.2;0.7" dur="4s" repeatCount="indefinite" />
    </line>
  </svg>

  <!-- Interactive Action Banner below the Analysis Canvas -->
  <div class="eva-buffer-hud-footer">
    <div class="hud-stat-badge">
      <span class="label">NERV PROTOCOL // P2P BUFFER:</span>
      <span class="value">{progress}%</span>
    </div>

    {#if trackTitle}
      <div class="track-buffering-title">
        <span class="title-label">INGESTING SIGNAL:</span>
        <span class="title-text">{trackTitle}</span>
      </div>
    {/if}

    {#if progress >= 100}
      <button type="button" class="eva-engage-btn pulse" onclick={onEngage}>
        ⚡ SIGNAL BUFFERED // ENGAGE PLAYBACK
      </button>
    {:else}
      <div class="buffering-status-pill">
        <span class="pulse-indicator"></span>
        STREAMING AUDIO CHUNKS FROM MESH RELAY...
      </div>
    {/if}
  </div>
</div>

<style>
  .eva-buffer-container {
    width: 100%;
    height: 100%;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    background: #020101;
    border: 1.5px solid #ff7b00;
    box-shadow: 0 0 24px rgba(255, 123, 0, 0.28), inset 0 0 16px rgba(255, 60, 0, 0.15);
    padding: 10px 12px 14px 12px;
    box-sizing: border-box;
    margin: 0;
    overflow: hidden;
    position: relative;
    contain: content;
  }

  .eva-buffer-svg {
    width: 100%;
    flex: 1;
    min-height: 0;
    height: auto;
    max-height: 100%;
    display: block;
    overflow: visible;
  }

  .hud-top-title {
    font-family: 'Orbitron', 'Share Tech Mono', monospace;
    font-size: 19px;
    font-weight: 900;
    letter-spacing: 0.12em;
    fill: #ff7b00;
    text-shadow: 0 0 8px rgba(255, 123, 0, 0.8);
  }

  /* Chevron Polygon Fills */
  .chev-bar {
    fill: #1a0502;
    stroke: #380d04;
    stroke-width: 0.8;
    transition: fill 0.12s ease-out, stroke 0.12s ease-out;
  }

  .chev-bar.lit {
    fill: #ff7b00;
    stroke: #ffa000;
    stroke-width: 1;
    filter: drop-shadow(0 0 3px rgba(255, 123, 0, 0.65));
  }

  .chev-bar.current {
    fill: #ffd000;
    stroke: #ffffff;
    stroke-width: 1.2;
    animation: pulse-current 0.6s infinite alternate ease-in-out;
  }

  @keyframes pulse-current {
    0% { fill: #ff7b00; filter: drop-shadow(0 0 2px #ff7b00); }
    100% { fill: #fff2a3; filter: drop-shadow(0 0 8px #ffbb00); }
  }

  .analysis-heading {
    font-family: 'Orbitron', 'Noto Sans JP', sans-serif;
    font-size: 20px;
    font-weight: 900;
    letter-spacing: 0.1em;
    fill: #ff7b00;
  }

  .analysis-stat {
    font-family: 'Share Tech Mono', monospace;
    font-size: 8.5px;
    font-weight: bold;
    letter-spacing: 0.06em;
    fill: #ff9d00;
  }

  /* Footer Controls below SVG */
  .eva-buffer-hud-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid rgba(255, 123, 0, 0.35);
    font-family: 'Share Tech Mono', monospace;
    flex-shrink: 0;
  }

  .hud-stat-badge {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  .hud-stat-badge .label {
    color: #ff8500;
    font-size: 0.72rem;
    font-weight: bold;
    letter-spacing: 0.08em;
  }

  .hud-stat-badge .value {
    color: #ffd000;
    font-size: 1.1rem;
    font-weight: 900;
  }

  .track-buffering-title {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: 0.75rem;
    color: #ff9500;
    max-width: 400px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .title-label {
    color: #ff6600;
    font-weight: bold;
  }

  .title-text {
    color: #ffffff;
    font-weight: bold;
  }

  .buffering-status-pill {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.72rem;
    color: #ff8500;
    background: rgba(255, 123, 0, 0.1);
    border: 1px solid rgba(255, 123, 0, 0.4);
    padding: 4px 10px;
  }

  .pulse-indicator {
    width: 8px;
    height: 8px;
    background: #ff7b00;
    clip-path: polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%);
    animation: blink-indicator 0.8s infinite alternate;
  }

  @keyframes blink-indicator {
    0% { opacity: 0.2; transform: scale(0.8); }
    100% { opacity: 1; transform: scale(1.2); }
  }

  .eva-engage-btn {
    background: linear-gradient(180deg, #ff8500 0%, #d65500 100%);
    color: #040201;
    font-family: 'Orbitron', 'Share Tech Mono', sans-serif;
    font-weight: 900;
    font-size: 0.78rem;
    padding: 6px 14px;
    border: none;
    cursor: pointer;
    letter-spacing: 0.06em;
    clip-path: polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px));
    box-shadow: 0 0 14px rgba(255, 123, 0, 0.6);
  }

  .eva-engage-btn:hover {
    background: #ffaa00;
    box-shadow: 0 0 20px #ffaa00;
  }
</style>
