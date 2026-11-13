<script lang="ts">
  import type { ToastVariant } from './p2p-mesh';

  export interface ToastItem {
    id: string;
    variant: ToastVariant;
    message: string;
    durationMs: number;
  }

  let {
    toasts = [],
    onDismiss
  }: {
    toasts: ToastItem[];
    onDismiss: (id: string) => void;
  } = $props();

  const PREFIX_MAP: Record<ToastVariant, string> = {
    info: '[SYS]',
    success: '[OK]',
    warning: '[WARN]',
    error: '[ERR]',
    critical: '[CRITICAL]'
  };
</script>

{#if toasts.length > 0}
  <div class="toast-stack" role="status" aria-live="polite" aria-label="System notifications">
    {#each toasts as toast (toast.id)}
      <button
        type="button"
        class="toast-card variant-{toast.variant}"
        style="--toast-dur: {toast.durationMs}ms"
        onclick={() => onDismiss(toast.id)}
        title="Dismiss notification"
      >
        <div class="toast-body">
          <span class="toast-prefix">{PREFIX_MAP[toast.variant]}</span>
          <span class="toast-msg">{toast.message}</span>
        </div>
        <div class="toast-progress" aria-hidden="true"></div>
      </button>
    {/each}
  </div>
{/if}

<style>
  .toast-stack {
    position: fixed;
    right: 18px;
    bottom: 18px;
    z-index: 9500;
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: min(380px, calc(100vw - 36px));
    pointer-events: none;
  }

  .toast-card {
    pointer-events: auto;
    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
    text-align: left;
    padding: 12px 14px 14px;
    background: rgba(3, 5, 10, 0.96);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-left: 3px solid #00f0ff;
    color: #00f0ff;
    font-family: var(--font-mono);
    font-size: 0.78rem;
    line-height: 1.4;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.85);
    cursor: pointer;
    overflow: hidden;
    animation: toast-enter 0.2s cubic-bezier(0.22, 1, 0.36, 1) forwards;
  }

  .toast-body {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }

  .toast-prefix {
    font-weight: 800;
    flex-shrink: 0;
    letter-spacing: 0.05em;
  }

  .toast-msg {
    word-break: break-word;
  }

  .toast-progress {
    position: absolute;
    left: 0;
    bottom: 0;
    height: 2px;
    width: 100%;
    background: currentColor;
    transform-origin: left center;
    animation: toast-drain var(--toast-dur, 3500ms) linear forwards;
  }

  .toast-card.variant-info {
    border-left-color: #00f0ff;
    border-color: rgba(0, 240, 255, 0.28);
    border-left-width: 3px;
    color: #3df4ff;
  }

  .toast-card.variant-success {
    border-left-color: #00ff66;
    border-color: rgba(0, 255, 102, 0.28);
    border-left-width: 3px;
    color: #2aff80;
  }

  .toast-card.variant-warning {
    border-left-color: #ff9500;
    border-color: rgba(255, 149, 0, 0.32);
    border-left-width: 3px;
    color: #ffaa33;
  }

  .toast-card.variant-error {
    border-left-color: #ff2a2a;
    border-color: rgba(255, 42, 42, 0.32);
    border-left-width: 3px;
    color: #ff4d4d;
  }

  .toast-card.variant-critical {
    border-left-color: #ff22dd;
    border-color: rgba(255, 34, 221, 0.34);
    border-left-width: 3px;
    color: #ff55ee;
  }

  @keyframes toast-enter {
    from {
      opacity: 0;
      transform: translateX(16px);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }

  @keyframes toast-drain {
    from {
      transform: scaleX(1);
    }
    to {
      transform: scaleX(0);
    }
  }
</style>
