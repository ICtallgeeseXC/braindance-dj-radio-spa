<script lang="ts">
  let {
    open = false,
    variant = 'critical',
    title = 'SYSTEM ALERT',
    sysCode = 'MAGI.SYS',
    message = '',
    confirmLabel = 'ACKNOWLEDGE',
    cancelLabel = '',
    onConfirm,
    onCancel
  }: {
    open: boolean;
    variant?: 'critical' | 'warning';
    title?: string;
    sysCode?: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    onConfirm?: () => void;
    onCancel?: () => void;
  } = $props();

  function handleKeydown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      (onCancel ?? onConfirm)?.();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onConfirm?.();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <div
    class="sys-dialog-backdrop"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) (onCancel ?? onConfirm)?.();
    }}
  >
    <div
      class="sys-dialog-frame"
      class:is-warning={variant === 'warning'}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="sys-dialog-title"
      aria-describedby="sys-dialog-desc"
    >
      <div class="sys-dialog-hazard" aria-hidden="true"></div>

      <div class="sys-dialog-inner">
        <header class="sys-dialog-header">
          <div class="sys-dialog-title-wrap">
            <span class="sys-dialog-bang" aria-hidden="true">!</span>
            <h2 id="sys-dialog-title" class="sys-dialog-title">{title}</h2>
          </div>
          <span class="sys-dialog-code">{sysCode}</span>
        </header>

        <div id="sys-dialog-desc" class="sys-dialog-body">
          {message}
        </div>

        <footer class="sys-dialog-actions">
          {#if cancelLabel}
            <button type="button" class="sys-btn secondary" onclick={() => onCancel?.()}>
              <span class="sys-btn-box" aria-hidden="true">□</span>
              <span>{cancelLabel}</span>
            </button>
          {/if}
          <button type="button" class="sys-btn primary" onclick={() => onConfirm?.()}>
            <span class="sys-btn-box" aria-hidden="true">□</span>
            <span>{confirmLabel}</span>
          </button>
        </footer>
      </div>

      <div class="sys-dialog-hazard" aria-hidden="true"></div>
    </div>
  </div>
{/if}

<style>
  .sys-dialog-backdrop {
    position: fixed;
    inset: 0;
    z-index: 9999;
    background: rgba(2, 3, 6, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }

  .sys-dialog-frame {
    width: min(520px, 100%);
    background: #040406;
    border: 2px solid #ff1e1e;
    box-shadow: 0 0 36px rgba(255, 30, 30, 0.35), 0 18px 48px rgba(0, 0, 0, 0.9);
    display: flex;
    flex-direction: column;
  }

  .sys-dialog-frame.is-warning {
    border-color: #ff7700;
    box-shadow: 0 0 36px rgba(255, 119, 0, 0.3), 0 18px 48px rgba(0, 0, 0, 0.9);
  }

  .sys-dialog-hazard {
    height: 10px;
    width: 100%;
    background: repeating-linear-gradient(
      -45deg,
      #ff1e1e 0px,
      #ff1e1e 10px,
      #0a0404 10px,
      #0a0404 20px
    );
  }

  .sys-dialog-frame:has(.sys-btn.primary:hover) .sys-dialog-hazard,
  .sys-dialog-frame:has(.sys-btn.primary:focus-visible) .sys-dialog-hazard {
    animation: sys-hazard-march 0.55s linear infinite;
  }

  @keyframes sys-hazard-march {
    from { background-position: 0 0; }
    to { background-position: 28.284px 0; }
  }

  .sys-dialog-frame.is-warning .sys-dialog-hazard {
    background: repeating-linear-gradient(
      -45deg,
      #ff7700 0px,
      #ff7700 10px,
      #0a0602 10px,
      #0a0602 20px
    );
  }

  .sys-dialog-inner {
    padding: 16px 20px 18px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .sys-dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-bottom: 12px;
    border-bottom: 1px solid rgba(255, 30, 30, 0.35);
  }

  .sys-dialog-frame.is-warning .sys-dialog-header {
    border-bottom-color: rgba(255, 119, 0, 0.35);
  }

  .sys-dialog-title-wrap {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .sys-dialog-bang {
    color: #ff2a2a;
    font-family: var(--font-mono);
    font-weight: 900;
    font-size: 1rem;
    text-shadow: 0 0 8px rgba(255, 42, 42, 0.7);
  }

  .sys-dialog-frame.is-warning .sys-dialog-bang {
    color: #ff9500;
    text-shadow: 0 0 8px rgba(255, 149, 0, 0.7);
  }

  .sys-dialog-title {
    margin: 0;
    color: #ff2a2a;
    font-family: var(--font-display);
    font-size: 0.9rem;
    font-weight: 800;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .sys-dialog-frame.is-warning .sys-dialog-title {
    color: #ff9500;
  }

  .sys-dialog-code {
    color: rgba(148, 163, 184, 0.65);
    font-family: var(--font-mono);
    font-size: 0.68rem;
    letter-spacing: 0.12em;
    flex-shrink: 0;
  }

  .sys-dialog-body {
    color: #e2e8f0;
    font-family: var(--font-mono);
    font-size: 0.84rem;
    line-height: 1.55;
    padding: 4px 0 6px;
  }

  .sys-dialog-actions {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 12px;
    padding-top: 12px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }

  .sys-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    height: 38px;
    padding: 0 16px;
    font-family: var(--font-display);
    font-size: 0.76rem;
    font-weight: 800;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
  }

  .sys-btn-box {
    font-family: var(--font-mono);
    font-size: 0.68rem;
    opacity: 0.8;
  }

  .sys-btn.secondary {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(148, 163, 184, 0.35);
    color: #cbd5e1;
  }

  .sys-btn.secondary:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: #cbd5e1;
    color: #ffffff;
  }

  .sys-btn.primary {
    background: rgba(255, 30, 30, 0.14);
    border: 1px solid #ff2a2a;
    color: #ff4444;
    box-shadow: inset 0 0 10px rgba(255, 30, 30, 0.12);
  }

  .sys-btn.primary:hover {
    background: rgba(255, 30, 30, 0.28);
    border-color: #ff6666;
    color: #ffffff;
  }

  .sys-dialog-frame.is-warning .sys-btn.primary {
    background: rgba(255, 119, 0, 0.14);
    border-color: #ff7700;
    color: #ff9500;
  }

  .sys-dialog-frame.is-warning .sys-btn.primary:hover {
    background: rgba(255, 119, 0, 0.28);
    border-color: #ffaa33;
    color: #ffffff;
  }
</style>
