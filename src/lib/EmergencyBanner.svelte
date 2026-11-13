<script lang="ts">
  import { fade } from 'svelte/transition';

  let {
    open = false,
    title = 'BROADCAST',
    subtitle = 'SYSTEM-WIDE ANNOUNCEMENT',
    stationCode = '',
    onDismiss = () => {}
  }: {
    open?: boolean;
    title?: string;
    subtitle?: string;
    stationCode?: string;
    onDismiss?: () => void;
  } = $props();

  function handleKeydown(e: KeyboardEvent) {
    if (open && e.key === 'Escape') {
      onDismiss();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <div
    class="emergency-overlay"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
    transition:fade={{ duration: 220 }}
    onclick={onDismiss}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onDismiss(); }}
  >
    <div class="emergency-frame">
      <div class="frame-meta top">
        <span class="meta-live">LIVE TRANSMISSION // NERV_EMERGENCY_BANNER</span>
        <span class="meta-id">FRAME-01</span>
      </div>

      <div class="banner-core">
        <div class="chevron-bar" aria-hidden="true">
          <span class="chevron-half left"></span>
          <span class="chevron-half right"></span>
        </div>

        <div class="banner-center">
          <h1 class="banner-title">{title}</h1>
          <p class="banner-subtitle">
            {subtitle}{#if stationCode} // STATION: {stationCode.toUpperCase()}{/if}
          </p>
        </div>

        <div class="chevron-bar" aria-hidden="true">
          <span class="chevron-half left"></span>
          <span class="chevron-half right"></span>
        </div>
      </div>

      <div class="frame-meta bottom">
        <span class="meta-hint">CLICK OR PRESS [ESC] TO BYPASS</span>
        <span class="meta-timer">AUTO-CLEAR: 05.0S</span>
      </div>
    </div>
  </div>
{/if}

<style>
  .emergency-overlay {
    position: fixed;
    inset: 0;
    z-index: 9950;
    background: rgba(0, 0, 0, 0.94);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: clamp(12px, 3vw, 32px);
    cursor: pointer;
    user-select: none;
  }

  .emergency-frame {
    position: relative;
    width: min(1040px, 100%);
    background: #000000;
    border: 1px solid rgba(255, 255, 255, 0.2);
    padding: clamp(12px, 2.2vw, 22px);
    box-shadow:
      0 0 60px rgba(0, 0, 0, 0.95),
      inset 0 0 36px rgba(255, 255, 255, 0.03);
    overflow: hidden;
  }

  .emergency-frame::after {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: repeating-linear-gradient(
      0deg,
      rgba(0, 0, 0, 0.28) 0px,
      rgba(0, 0, 0, 0.28) 1px,
      transparent 1px,
      transparent 3px
    );
    z-index: 3;
  }

  .frame-meta {
    position: relative;
    z-index: 2;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    font-family: var(--font-mono);
    font-size: 0.68rem;
    letter-spacing: 0.14em;
    color: rgba(255, 255, 255, 0.45);
  }

  .frame-meta.top {
    margin-bottom: 12px;
  }

  .frame-meta.bottom {
    margin-top: 12px;
  }

  .meta-live {
    color: #39ff6a;
  }

  .banner-core {
    position: relative;
    z-index: 2;
    background: #000000;
    padding: clamp(8px, 1.5vw, 14px) 0;
  }

  .chevron-bar {
    display: flex;
    width: 100%;
    height: clamp(20px, 3.2vw, 34px);
    overflow: hidden;
  }

  .chevron-half {
    flex: 1;
    height: 100%;
    background-size: 34px 34px;
  }

  .chevron-half.left {
    background-image: repeating-linear-gradient(
      -45deg,
      #f2f2f2 0px,
      #f2f2f2 12px,
      #000000 12px,
      #000000 24px
    );
    animation: nerv-chevron-left 1.1s linear infinite;
  }

  .chevron-half.right {
    background-image: repeating-linear-gradient(
      45deg,
      #f2f2f2 0px,
      #f2f2f2 12px,
      #000000 12px,
      #000000 24px
    );
    animation: nerv-chevron-right 1.1s linear infinite;
  }

  @keyframes nerv-chevron-left {
    from {
      background-position: 0 0;
    }
    to {
      background-position: -34px 0;
    }
  }

  @keyframes nerv-chevron-right {
    from {
      background-position: 0 0;
    }
    to {
      background-position: 34px 0;
    }
  }

  .banner-center {
    text-align: center;
    padding: clamp(18px, 4vw, 40px) 12px clamp(14px, 3vw, 28px);
  }

  .banner-title {
    margin: 0;
    font-family: 'Impact', 'Arial Narrow', var(--font-display), sans-serif;
    font-weight: 900;
    font-size: clamp(2.5rem, 10.5vw, 6.4rem);
    line-height: 0.94;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #e4e4e4;
    text-shadow: 0 0 18px rgba(255, 255, 255, 0.16);
    transform: scaleY(1.08);
  }

  .banner-subtitle {
    margin: clamp(10px, 2vw, 18px) 0 0;
    font-family: var(--font-mono);
    font-size: clamp(0.68rem, 1.4vw, 0.88rem);
    letter-spacing: 0.24em;
    text-transform: uppercase;
    color: rgba(230, 230, 230, 0.72);
  }

  @media (max-width: 520px) {
    .banner-subtitle {
      letter-spacing: 0.12em;
    }
    .frame-meta {
      font-size: 0.58rem;
      letter-spacing: 0.08em;
    }
  }
</style>
