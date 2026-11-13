<script lang="ts">
  import { onMount } from 'svelte';
  import type { PeerNodeInfo } from './p2p-mesh';

  let { peers = [], currentPeerId = '' }: { peers: PeerNodeInfo[]; currentPeerId: string } = $props();

  let canvas: HTMLCanvasElement;
  let logicalWidth = $state(480);
  const logicalHeight = 195;

  $effect(() => {
    // Re-run whenever peers, currentPeerId, or logicalWidth changes
    void peers.length;
    void currentPeerId;
    void logicalWidth;
    drawTree();
  });

  function drawHexagon(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 6;
      const vx = cx + radius * Math.cos(angle);
      const vy = cy + radius * Math.sin(angle);
      if (i === 0) ctx.moveTo(vx, vy);
      else ctx.lineTo(vx, vy);
    }
    ctx.closePath();
  }

  function drawTacticalGrid(ctx: CanvasRenderingContext2D, w: number, h: number) {
    // Subtle crosshair & range rings
    ctx.strokeStyle = 'rgba(255, 123, 0, 0.1)';
    ctx.lineWidth = 1;

    // Horizontal & vertical center lines
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.moveTo(w / 2, 0);
    ctx.lineTo(w / 2, h);
    ctx.stroke();

    // Dashed concentric radar circle
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(0, 240, 255, 0.1)';
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, Math.min(w, h) * 0.36, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Corner HUD telemetry micro-labels
    ctx.fillStyle = 'rgba(255, 123, 0, 0.55)';
    ctx.font = '9px "Share Tech Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText('MAGI_RADAR // SEC.01', 8, 14);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(0, 240, 255, 0.55)';
    ctx.fillText(peers.length > 0 ? 'PATTERN: BLUE' : 'PATTERN: AMBER', w - 8, 14);
  }

  function drawTree() {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
    const w = logicalWidth;
    const h = logicalHeight;

    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    drawTacticalGrid(ctx, w, h);

    if (peers.length === 0) {
      // Draw NERV Hexagonal Standby Reticle
      const cx = w / 2;
      const cy = h / 2 - 4;
      drawHexagon(ctx, cx, cy, 24);
      ctx.strokeStyle = 'rgba(255, 123, 0, 0.45)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      drawHexagon(ctx, cx, cy, 16);
      ctx.fillStyle = 'rgba(255, 123, 0, 0.08)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0, 240, 255, 0.4)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = '#ff7b00';
      ctx.font = 'bold 11px "Share Tech Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('STANDBY // AWAITING SIGNAL LOCK', cx, cy + 42);

      ctx.fillStyle = '#64748b';
      ctx.font = '10px "Share Tech Mono", monospace';
      ctx.fillText('待機中 • NO ACTIVE PEERS IN PYRAMID MESH', cx, cy + 56);
      ctx.restore();
      return;
    }

    // Group peers by depth
    const levels: Map<number, PeerNodeInfo[]> = new Map();
    for (const p of peers) {
      const d = p.depth || 0;
      if (!levels.has(d)) levels.set(d, []);
      levels.get(d)!.push(p);
    }

    const maxDepth = Math.max(...Array.from(levels.keys()), 0);
    const nodePositions: Map<string, { x: number; y: number }> = new Map();

    const verticalPadding = 38;
    const levelHeight = (h - verticalPadding * 2) / Math.max(1, maxDepth);

    levels.forEach((peerList, depth) => {
      const y = maxDepth === 0 ? h / 2 - 4 : verticalPadding + depth * levelHeight;
      const step = w / (peerList.length + 1);

      peerList.forEach((p, idx) => {
        const x = step * (idx + 1);
        nodePositions.set(p.peerId, { x, y });
      });
    });

    // Draw vector links from children to parents
    ctx.lineWidth = 2;
    for (const p of peers) {
      if (p.parent && nodePositions.has(p.parent) && nodePositions.has(p.peerId)) {
        const childPos = nodePositions.get(p.peerId)!;
        const parentPos = nodePositions.get(p.parent)!;

        const grad = ctx.createLinearGradient(parentPos.x, parentPos.y, childPos.x, childPos.y);
        if (p.transport === 'relay') {
          grad.addColorStop(0, '#00ff66');
          grad.addColorStop(1, '#00f0ff');
          ctx.setLineDash([5, 3]);
        } else {
          grad.addColorStop(0, '#ff7b00');
          grad.addColorStop(1, '#00f0ff');
          ctx.setLineDash([]);
        }

        ctx.strokeStyle = grad;
        ctx.beginPath();
        ctx.moveTo(parentPos.x, parentPos.y);
        ctx.lineTo(childPos.x, childPos.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Draw Hexagonal NERV Nodes
    for (const p of peers) {
      const pos = nodePositions.get(p.peerId);
      if (!pos) continue;

      const isMe = p.peerId === currentPeerId;
      const isDJ = p.role === 'dj';

      if (isMe || isDJ) {
        drawHexagon(ctx, pos.x, pos.y, 21);
        ctx.fillStyle = isDJ ? 'rgba(255, 123, 0, 0.14)' : 'rgba(0, 240, 255, 0.14)';
        ctx.strokeStyle = isDJ ? 'rgba(255, 123, 0, 0.45)' : 'rgba(0, 240, 255, 0.45)';
        ctx.lineWidth = 1;
        ctx.fill();
        ctx.stroke();
      }

      drawHexagon(ctx, pos.x, pos.y, 15);
      ctx.fillStyle = isDJ ? '#ff7b00' : isMe ? '#00f0ff' : '#081224';
      ctx.strokeStyle = isDJ
        ? '#ffd000'
        : isMe
          ? '#ffffff'
          : p.transport === 'relay'
            ? '#00ff66'
            : '#00f0ff';
      ctx.lineWidth = 1.8;
      ctx.fill();
      ctx.stroke();

      // Node Identifier
      ctx.fillStyle = isDJ || isMe ? '#04060c' : '#00f0ff';
      ctx.font = 'bold 9px "Share Tech Mono", monospace';
      ctx.textAlign = 'center';
      const label = isDJ ? 'DJ' : isMe ? 'YOU' : p.peerId.slice(-4).toUpperCase();
      ctx.fillText(label, pos.x, pos.y + 3);

      // Telemetry Tag Below Node
      ctx.fillStyle = isDJ ? '#ffd000' : p.transport === 'relay' ? '#00ff66' : '#8ca0be';
      ctx.font = '8.5px "Share Tech Mono", monospace';
      const modeTag = isDJ
        ? 'ROOT•00'
        : p.transport === 'relay'
          ? `L${p.depth}•RLY`
          : `L${p.depth}•P2P`;
      ctx.fillText(modeTag, pos.x, pos.y + 26);
    }

    ctx.restore();
  }

  onMount(() => {
    drawTree();
    if (typeof ResizeObserver !== 'undefined' && canvas?.parentElement) {
      const ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const w = Math.floor(entry.contentRect.width);
          if (w > 180) {
            logicalWidth = w;
          }
        }
      });
      ro.observe(canvas.parentElement);
      return () => ro.disconnect();
    }
  });
</script>

<div class="tree-container">
  <div class="nerv-card-strip"></div>
  <div class="tree-header">
    <div class="tree-title-group">
      <span class="nerv-code">MAGI // 01</span>
      <span class="tree-title">PYRAMID TOPOLOGY</span>
    </div>
    <span class="tree-count">[ {peers.length} {peers.length === 1 ? 'NODE' : 'NODES'} ]</span>
  </div>
  <div class="canvas-wrap">
    <canvas bind:this={canvas} class="tree-canvas"></canvas>
    <div class="canvas-scanlines" aria-hidden="true"></div>
    <div class="verdict-stamp" class:ok={peers.length > 0}>
      {peers.length > 0 ? 'CHECK O.K.' : 'STANDBY'}
    </div>
  </div>
  <div class="tree-legend">
    <div class="legend-item"><span class="hex-dot dj"></span> DJ ROOT</div>
    <div class="legend-item"><span class="hex-dot me"></span> LOCAL UNIT</div>
    <div class="legend-item"><span class="hex-dot peer"></span> MESH RELAY</div>
  </div>
</div>

<style>
  .tree-container {
    position: relative;
    background: rgba(8, 12, 22, 0.94);
    border: 1px solid rgba(255, 123, 0, 0.4);
    clip-path: polygon(0 0, calc(100% - 14px) 0, 100% 14px, 100% 100%, 14px 100%, 0 calc(100% - 14px));
    padding: 14px;
    display: flex;
    flex-direction: column;
    box-shadow: inset 0 0 20px rgba(255, 123, 0, 0.05);
  }

  .nerv-card-strip {
    height: 3px;
    width: 100%;
    background: var(--hazard-amber);
    margin-bottom: 10px;
    opacity: 0.85;
  }

  .tree-header {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 0.75rem;
    font-family: var(--font-mono);
    margin-bottom: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .tree-title-group {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .nerv-code {
    background: rgba(255, 123, 0, 0.18);
    color: var(--nerv-amber);
    border: 1px solid rgba(255, 123, 0, 0.5);
    padding: 1px 6px;
    font-size: 0.68rem;
    font-weight: bold;
  }

  .tree-title {
    color: var(--text-primary);
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 0.76rem;
    letter-spacing: 0.1em;
  }

  .tree-count {
    color: var(--neon-cyan);
    font-weight: bold;
  }

  .canvas-wrap {
    width: 100%;
    position: relative;
  }

  .canvas-scanlines {
    position: absolute;
    inset: 0;
    background: repeating-linear-gradient(
      0deg,
      rgba(0, 0, 0, 0.28) 0px,
      rgba(0, 0, 0, 0.28) 1px,
      transparent 1px,
      transparent 3px
    );
    pointer-events: none;
  }

  .verdict-stamp {
    position: absolute;
    right: 8px;
    bottom: 8px;
    padding: 3px 8px;
    font-family: var(--font-mono);
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    color: #ff9900;
    background: rgba(8, 12, 22, 0.88);
    border: 1px solid rgba(255, 119, 0, 0.55);
    pointer-events: none;
  }

  .verdict-stamp.ok {
    color: #00ff88;
    border-color: rgba(0, 255, 136, 0.6);
    text-shadow: 0 0 6px rgba(0, 255, 136, 0.55);
  }

  .tree-canvas {
    display: block;
    width: 100%;
    height: 195px;
    background:
      radial-gradient(circle at center, rgba(255, 123, 0, 0.05) 0%, rgba(4, 6, 12, 0.98) 100%);
    border: 1px solid rgba(0, 240, 255, 0.25);
  }

  .tree-legend {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 10px;
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid rgba(255, 123, 0, 0.2);
    font-size: 0.7rem;
    font-family: var(--font-mono);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .hex-dot {
    width: 9px;
    height: 9px;
    display: inline-block;
    clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
  }

  .hex-dot.dj {
    background: var(--nerv-amber);
  }
  .hex-dot.me {
    background: var(--neon-cyan);
  }
  .hex-dot.peer {
    background: var(--neon-green);
  }
</style>
