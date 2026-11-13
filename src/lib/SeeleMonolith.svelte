<script lang="ts">
  let {
    number = '00',
    isPlaying = false
  }: {
    number?: string;
    isPlaying?: boolean;
  } = $props();

  // Ensure minimum 2-digit representation (e.g. '00', '01')
  const formattedNumber = $derived.by(() => {
    const raw = String(number || '00').trim();
    return raw.length === 1 ? '0' + raw : raw;
  });

  const chars = $derived(formattedNumber.split(''));

  function getDigitWidth(char: string): number {
    return char === '1' ? 28 : 42;
  }

  const GAP = 12;
  const DIGIT_Y = 95;

  const digitOffsets = $derived.by(() => {
    let totalW = 0;
    for (let i = 0; i < chars.length; i++) {
      totalW += getDigitWidth(chars[i]);
      if (i < chars.length - 1) totalW += GAP;
    }
    const startX = Math.round((180 - totalW) / 2);

    const offsets: { char: string; x: number; w: number }[] = [];
    let curX = startX;
    for (let i = 0; i < chars.length; i++) {
      const w = getDigitWidth(chars[i]);
      offsets.push({ char: chars[i], x: curX, w });
      curX += w + GAP;
    }
    return offsets;
  });
</script>

<div class="seele-monolith-container" class:is-playing={isPlaying}>
  <svg
    viewBox="0 0 180 400"
    xmlns="http://www.w3.org/2000/svg"
    class="monolith-svg"
    role="img"
    aria-label={`SEELE ${formattedNumber} SOUND ONLY Monolith`}
  >
    <defs>
      <!-- Atmospheric dark obsidian-to-indigo monolith slab gradient -->
      <linearGradient id="monolithSlabGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#080911" />
        <stop offset="35%" stop-color="#0b0d18" />
        <stop offset="65%" stop-color="#12162a" />
        <stop offset="85%" stop-color="#191f3a" />
        <stop offset="100%" stop-color="#242c52" />
      </linearGradient>

      <!-- Core ambient luminescence centered on telemetry -->
      <radialGradient id="coreGlow" cx="50%" cy="38%" r="45%">
        <stop offset="0%" stop-color="#ff003c" stop-opacity="0.18" />
        <stop offset="65%" stop-color="#ff003c" stop-opacity="0.04" />
        <stop offset="100%" stop-color="#ff003c" stop-opacity="0" />
      </radialGradient>

      <!-- Neon glow filter for fiery SEELE markings -->
      <filter id="neonRedGlow" x="-35%" y="-35%" width="170%" height="170%">
        <feGaussianBlur stdDeviation="2" result="blur1" />
        <feGaussianBlur stdDeviation="5.5" result="blur2" />
        <feMerge>
          <feMergeNode in="blur2" />
          <feMergeNode in="blur1" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>

    <!-- 1. Monolith Slab Background -->
    <rect x="1" y="1" width="178" height="398" fill="url(#monolithSlabGrad)" stroke="#030408" stroke-width="2" />
    <rect x="1" y="1" width="178" height="398" fill="url(#coreGlow)" />

    <!-- 2. Inner Frame with Stepped Corner Notches at Bottom Base -->
    <path
      d="M 8,8
         L 172,8
         L 172,386
         L 164,386
         L 164,392
         L 16,392
         L 16,386
         L 8,386
         Z"
      fill="none"
      stroke="rgba(85, 110, 165, 0.32)"
      stroke-width="1.2"
    />
    <!-- Bottom corner bracket accents -->
    <path d="M 12,382 L 12,388 L 18,388" fill="none" stroke="#ff4400" stroke-opacity="0.55" stroke-width="1.2" />
    <path d="M 168,382 L 168,388 L 162,388" fill="none" stroke="#ff4400" stroke-opacity="0.55" stroke-width="1.2" />

    <!-- 3. Dynamic Outline Digits ('00' for DJ, Listener Number for Listeners) -->
    <g class="seele-digits" filter="url(#neonRedGlow)">
      {#each digitOffsets as digit}
        <g transform={`translate(${digit.x}, ${DIGIT_Y})`}>
          {#if digit.char === '0'}
            <!-- Clean, iconic hollow outline zero: no inner zigzag/22 -->
            <rect
              x="2"
              y="2"
              width="42"
              height="80"
              rx="3"
              fill="none"
              stroke="#ff1230"
              stroke-width="5"
            />
            <!-- Warm neon orange accent bars at top and bottom -->
            <rect x="10" y="2" width="26" height="5" fill="#ff6600" />
            <rect x="10" y="77" width="26" height="5" fill="#ff6600" />

          {:else if digit.char === '1'}
            <!-- Stylized SEELE 1: Tall pillar with angled top serif -->
            <path
              d="M 3,20 L 16,7 L 25,7 L 25,82 L 5,82 L 5,76 L 18,76 L 18,14 L 11,21 Z"
              fill="#ff1230"
            />
            <rect x="18" y="8" width="5" height="68" fill="#ff6600" />

          {:else if digit.char === '2'}
            <!-- Stylized SEELE 2: Outline block numeral -->
            <path
              d="M 2,2 L 40,2 L 40,40 L 7,40 L 7,76 L 40,76 L 40,82 L 2,82 L 2,35.5 L 35,35.5 L 35,7.5 L 2,7.5 Z"
              fill="#ff1230"
            />
            <rect x="8" y="2" width="24" height="5" fill="#ff6600" />
            <rect x="8" y="35.5" width="24" height="5" fill="#ff6600" />
            <rect x="8" y="77" width="24" height="5" fill="#ff6600" />

          {:else if digit.char === '3'}
            <!-- Stylized SEELE 3 -->
            <path
              d="M 2,2 L 40,2 L 40,82 L 2,82 L 2,76 L 35,76 L 35,42 L 12,42 L 12,36.5 L 35,36.5 L 35,7.5 L 2,7.5 Z"
              fill="#ff1230"
            />
            <rect x="8" y="2" width="24" height="5" fill="#ff6600" />
            <rect x="12" y="36.5" width="20" height="5" fill="#ff6600" />
            <rect x="8" y="77" width="24" height="5" fill="#ff6600" />

          {:else if digit.char === '4'}
            <!-- Stylized SEELE 4 -->
            <path
              d="M 2,2 L 7.5,2 L 7.5,36.5 L 34.5,36.5 L 34.5,2 L 40,2 L 40,82 L 34.5,82 L 34.5,42 L 2,42 Z"
              fill="#ff1230"
            />
            <rect x="7.5" y="36.5" width="27" height="5.5" fill="#ff6600" />

          {:else if digit.char === '5'}
            <!-- Stylized SEELE 5 -->
            <path
              d="M 2,2 L 40,2 L 40,7.5 L 7.5,7.5 L 7.5,36.5 L 40,36.5 L 40,82 L 2,82 L 2,76 L 34.5,76 L 34.5,42 L 2,42 Z"
              fill="#ff1230"
            />
            <rect x="8" y="2" width="24" height="5" fill="#ff6600" />
            <rect x="8" y="36.5" width="24" height="5" fill="#ff6600" />
            <rect x="8" y="77" width="24" height="5" fill="#ff6600" />

          {:else if digit.char === '6'}
            <!-- Stylized SEELE 6 -->
            <path
              d="M 2,2 L 40,2 L 40,7.5 L 7.5,7.5 L 7.5,36.5 L 40,36.5 L 40,82 L 2,82 Z"
              fill="#ff1230"
            />
            <rect x="7.5" y="42" width="27" height="34" fill="#080911" />
            <rect x="8" y="2" width="24" height="5" fill="#ff6600" />
            <rect x="8" y="36.5" width="24" height="5" fill="#ff6600" />
            <rect x="8" y="77" width="24" height="5" fill="#ff6600" />

          {:else if digit.char === '7'}
            <!-- Stylized SEELE 7 -->
            <path
              d="M 2,2 L 40,2 L 40,82 L 34.5,82 L 34.5,7.5 L 2,7.5 Z"
              fill="#ff1230"
            />
            <rect x="8" y="2" width="28" height="5" fill="#ff6600" />

          {:else if digit.char === '8'}
            <!-- Stylized SEELE 8 -->
            <path
              d="M 2,2 L 40,2 L 40,82 L 2,82 Z"
              fill="#ff1230"
            />
            <rect x="7.5" y="7.5" width="27" height="29" fill="#080911" />
            <rect x="7.5" y="42" width="27" height="34" fill="#080911" />
            <rect x="8" y="2" width="24" height="5" fill="#ff6600" />
            <rect x="8" y="36.5" width="24" height="5" fill="#ff6600" />
            <rect x="8" y="77" width="24" height="5" fill="#ff6600" />

          {:else if digit.char === '9'}
            <!-- Stylized SEELE 9 -->
            <path
              d="M 2,2 L 40,2 L 40,82 L 2,82 L 2,76 L 34.5,76 L 34.5,42 L 2,42 Z"
              fill="#ff1230"
            />
            <rect x="7.5" y="7.5" width="27" height="29" fill="#080911" />
            <rect x="8" y="2" width="24" height="5" fill="#ff6600" />
            <rect x="8" y="36.5" width="24" height="5" fill="#ff6600" />
            <rect x="8" y="77" width="24" height="5" fill="#ff6600" />

          {:else}
            <!-- Fallback text for any non-standard char -->
            <text x="0" y="62" font-family="'Orbitron', monospace" font-size="54" font-weight="900" fill="#ff1230">{digit.char}</text>
          {/if}
        </g>
      {/each}
    </g>

    <!-- 4. "SOUND ONLY" (Stacked below Number) -->
    <g class="seele-sound-only" filter="url(#neonRedGlow)" text-anchor="middle">
      <text
        x="90"
        y="218"
        font-family="'Share Tech Mono', 'Orbitron', monospace"
        font-size="21"
        font-weight="900"
        letter-spacing="5"
        fill="#ff1432"
      >SOUND</text>
      <text
        x="90"
        y="244"
        font-family="'Share Tech Mono', 'Orbitron', monospace"
        font-size="21"
        font-weight="900"
        letter-spacing="5"
        fill="#ff1432"
      >ONLY</text>
    </g>

    <!-- 5. Bottom Atmospheric Monolith Space with Subtle Telemetry Lines -->
    <g stroke="rgba(80, 105, 160, 0.22)" stroke-width="0.8">
      <line x1="28" y1="285" x2="36" y2="285" />
      <line x1="144" y1="285" x2="152" y2="285" />
      <line x1="28" y1="315" x2="33" y2="315" />
      <line x1="147" y1="315" x2="152" y2="315" />
      <line x1="28" y1="345" x2="36" y2="345" />
      <line x1="144" y1="345" x2="152" y2="345" />
    </g>
  </svg>
</div>

<style>
  .seele-monolith-container {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #020307;
    position: relative;
    overflow: hidden;
  }

  .monolith-svg {
    width: 100%;
    height: 100%;
    max-height: 100%;
    display: block;
    filter: drop-shadow(0 0 14px rgba(0, 0, 0, 0.95));
    transition: filter 0.4s ease;
  }

  .seele-monolith-container.is-playing .monolith-svg {
    animation: monolith-pulse 2.8s ease-in-out infinite;
  }

  @keyframes monolith-pulse {
    0%, 100% {
      filter: drop-shadow(0 0 14px rgba(255, 10, 40, 0.35)) drop-shadow(0 0 24px rgba(255, 60, 0, 0.15));
    }
    50% {
      filter: drop-shadow(0 0 20px rgba(255, 10, 40, 0.65)) drop-shadow(0 0 32px rgba(255, 70, 0, 0.3));
    }
  }
</style>
