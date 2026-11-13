<script lang="ts">
  import { onDestroy, onMount } from 'svelte';

  let {
    currentTime = 0,
    duration = 0,
    isPlaying = false,
    isAudioActuallyPlaying = false,
    mode = 'listener',
    onSeek = (frac: number) => {},
    getAudioData = () => null,
    onVisModeChange = (_visMode: 'off' | 'lo' | 'hi' | '666') => {}
  }: {
    currentTime: number;
    duration: number;
    isPlaying: boolean;
    isAudioActuallyPlaying: boolean;
    mode?: string;
    onSeek?: (frac: number) => void;
    getAudioData?: () => any;
    onVisModeChange?: (visMode: 'off' | 'lo' | 'hi' | '666') => void;
  } = $props();

  let showRemaining = $state(true);

  type VisMode = 'off' | 'lo' | 'hi' | '666';
  let visMode = $state<VisMode>(
    (typeof localStorage !== 'undefined' && (localStorage.getItem('p2p_vis_mode') as VisMode)) || 'lo'
  );
  let wasVisOff = false;

  function cycleVisMode() {
    visMode =
      visMode === 'lo' ? 'hi' : visMode === 'hi' ? '666' : visMode === '666' ? 'off' : 'lo';
    try { localStorage.setItem('p2p_vis_mode', visMode); } catch {}
    onVisModeChange(visMode);
    if (visMode === 'off') {
      resetWavesToBaseline();
      wasVisOff = true;
      stopLoop();
    } else {
      wasVisOff = false;
      lastWaveRenderAt = 0;
      resetDigitCache();
    }
  }

  function resetWavesToBaseline() {
    for (let i = 0; i < CHANNELS.length; i++) {
      smoothedX[i] = -24;
      historyBuffers[i].fill(-24);
      const pathEl = wavePaths[i];
      if (pathEl) {
        const cx = 20 + i * 112 + 52;
        pathEl.setAttribute('d', buildWavePath(i, cx));
      }
      const groupEl = chanGroups[i];
      if (groupEl && lastIsBlue[i]) {
        groupEl.classList.remove('is-blue');
        lastIsBlue[i] = false;
      }
      const textEl = telemetryTexts[i];
      if (textEl && lastTelemetryStr[i] !== 'X: -9.99') {
        textEl.textContent = 'X: -9.99';
        lastTelemetryStr[i] = 'X: -9.99';
      }
    }
  }

  // Channel definitions matching reference screenshots
  interface ChannelDef {
    id: string;
    name: string;
  }

  // Authentic bright electric orange and cyan colors matching reference images
  const ORANGE = '#ff7700';
  const CYAN = '#00d4ff';

  const CHANNELS: ChannelDef[] = [
    { id: 'ch0', name: 'CONTACT LINE' },
    { id: 'ch1', name: 'LEFT CHANNEL' },
    { id: 'ch2', name: 'RIGHT CHANNEL' },
    { id: 'ch3', name: 'BASS' },
    { id: 'ch4', name: 'TREBLE' },
    { id: 'ch5', name: 'CH ALFA' },
    { id: 'ch6', name: 'CH BETA' }
  ];

  // SVG Channel Group Elements, Wave Path References & Telemetry Value Elements
  let chanGroups: SVGGElement[] = [];
  let wavePaths: SVGPathElement[] = [];
  let telemetryTexts: SVGTextElement[] = [];

  // Direct 7-Segment SVG Element References for Digital Clock with Shadow 8s
  let m1Svg = $state<SVGGElement | undefined>(undefined);
  let m2Svg = $state<SVGGElement | undefined>(undefined);
  let s1Svg = $state<SVGGElement | undefined>(undefined);
  let s2Svg = $state<SVGGElement | undefined>(undefined);
  let c1Svg = $state<SVGGElement | undefined>(undefined);
  let c2Svg = $state<SVGGElement | undefined>(undefined);

  // Pre-allocated static digit strings for 0 garbage collection
  const DIGIT_STRS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

  // Track idle / throttle state to avoid redundant SVG DOM writes on macOS/Gecko
  let wasIdle = false;
  let lastWaveRenderAt = 0;
  const lastTelemetryStr: string[] = new Array(7).fill('');
  const lastIsBlue: boolean[] = new Array(7).fill(false);

  // Cache last rendered digit values so DOM attributes are only touched when changed
  let lastM1 = -1;
  let lastM2 = -1;
  let lastS1 = -1;
  let lastS2 = -1;
  let lastC1 = -1;
  let lastC2 = -1;

  // Time & Interpolation Baseline
  let baseAudioTime = 0;
  let basePerfTime = 0;

  // Song duration formatted strictly as mm:ss:ms (e.g. 04:50:00) in vertical blue text
  let formattedDuration = $derived.by(() => {
    const dur = Math.max(0, duration);
    const m = Math.floor(dur / 60);
    const s = Math.floor(dur % 60);
    const ms = Math.floor((dur % 1) * 100);
    const pad = (n: number) => (n < 10 ? '0' + n : String(n));
    return `${pad(m)}:${pad(s)}:${pad(ms)}`;
  });

  // Extract individual digits for the 7-segment duration display matching the timer
  let durDigits = $derived.by(() => {
    const dur = Math.max(0, duration);
    const m = Math.floor(dur / 60);
    const s = Math.floor(dur % 60);
    const ms = Math.floor((dur % 1) * 100);
    const pad = (n: number) => (n < 10 ? '0' + n : String(n));
    const sm = pad(m);
    const ss = pad(s);
    const sms = pad(ms);
    return {
      m1: sm[0],
      m2: sm[1],
      s1: ss[0],
      s2: ss[1],
      c1: sms[0],
      c2: sms[1],
    };
  });

  let progressPct = $derived(Math.min(1, Math.max(0, currentTime / Math.max(1, duration))));

  function applyDigits(secs: number) {
    const totalCentis = Math.max(0, Math.floor(secs * 100));
    const c2 = totalCentis % 10;
    const c1 = Math.floor(totalCentis / 10) % 10;
    const totalWholeSecs = Math.floor(totalCentis / 100);
    const s2 = totalWholeSecs % 10;
    const s1 = Math.floor(totalWholeSecs / 10) % 6;
    const mins = Math.floor(totalWholeSecs / 60);
    const m2 = mins % 10;
    const m1 = Math.floor(mins / 10) % 10;

    if (c2 !== lastC2 && c2Svg) {
      c2Svg.setAttribute('data-d', DIGIT_STRS[c2]);
      lastC2 = c2;
    }
    if (c1 !== lastC1 && c1Svg) {
      c1Svg.setAttribute('data-d', DIGIT_STRS[c1]);
      lastC1 = c1;
    }
    if (s2 !== lastS2 && s2Svg) {
      s2Svg.setAttribute('data-d', DIGIT_STRS[s2]);
      lastS2 = s2;
    }
    if (s1 !== lastS1 && s1Svg) {
      s1Svg.setAttribute('data-d', DIGIT_STRS[s1]);
      lastS1 = s1;
    }
    if (m2 !== lastM2 && m2Svg) {
      m2Svg.setAttribute('data-d', DIGIT_STRS[m2]);
      lastM2 = m2;
    }
    if (m1 !== lastM1 && m1Svg) {
      m1Svg.setAttribute('data-d', DIGIT_STRS[m1]);
      lastM1 = m1;
    }
  }

  function computeDisplaySecs(audioSecs: number): number {
    const dur = Math.max(0, duration);
    if (showRemaining) {
      return Math.max(0, dur - audioSecs);
    }
    return Math.max(0, audioSecs);
  }

  function resetDigitCache() {
    lastM1 = -1;
    lastM2 = -1;
    lastS1 = -1;
    lastS2 = -1;
    lastC1 = -1;
    lastC2 = -1;
  }

  // When playback state changes (pause / play), immediately sync timer baseline
  $effect(() => {
    const active = isPlaying && isAudioActuallyPlaying;
    baseAudioTime = currentTime;
    basePerfTime = performance.now();
    resetDigitCache();
    applyDigits(computeDisplaySecs(currentTime));
  });

  // Smooth drift filter for HTML5 audio timeupdate to eliminate jitter
  $effect(() => {
    const cur = currentTime;
    const now = performance.now();
    const active = isPlaying && isAudioActuallyPlaying;

    if (!active) {
      baseAudioTime = cur;
      basePerfTime = now;
      resetDigitCache();
      applyDigits(computeDisplaySecs(cur));
      return;
    }

    if (basePerfTime > 0) {
      const elapsed = Math.max(0, (now - basePerfTime) / 1000);
      const est = baseAudioTime + elapsed;
      const diff = cur - est;

      if (Math.abs(diff) < 0.15 && Math.abs(cur - baseAudioTime) < 1.0) {
        baseAudioTime = est * 0.75 + cur * 0.25;
      } else {
        baseAudioTime = cur;
        resetDigitCache();
      }
    } else {
      baseAudioTime = cur;
      resetDigitCache();
    }
    basePerfTime = now;
  });

  function getRangeAverage(data: Uint8Array, startBin: number, endBin: number): number {
    let sum = 0;
    const end = Math.min(data.length, endBin);
    const count = Math.max(1, end - startBin);
    for (let i = startBin; i < end; i++) {
      sum += data[i];
    }
    return sum / count;
  }

  function getInterpolatedBin(freqArray: Uint8Array, floatIndex: number): number {
    const idx0 = Math.max(0, Math.min(freqArray.length - 1, Math.floor(floatIndex)));
    const idx1 = Math.max(0, Math.min(freqArray.length - 1, Math.ceil(floatIndex)));
    const frac = floatIndex - idx0;
    return (freqArray[idx0] * (1 - frac) + freqArray[idx1] * frac) / 255;
  }

  // Strip-Chart Seismograph Downward Scrolling History Buffers (48 frames matching reference image 2)
  const HISTORY_LEN = 48;
  const historyBuffers: Float32Array[] = Array.from({ length: 7 }, () => {
    const arr = new Float32Array(HISTORY_LEN);
    arr.fill(-24); // All channels rest at left edge baseline (-24px = -9.99)
    return arr;
  });
  const smoothedX = new Float32Array(7).fill(-24);
  const runningBaselines = new Float32Array([0.35, 0.28, 0.28, 0.35, 0.15, 0.28, 0.30]);

  function getBandEnergy(data: Uint8Array, startHz: number, endHz: number, sampleRate: number): number {
    const nyquist = sampleRate / 2;
    // Always skip bin 0 (DC offset / 0Hz sub-rumble) for frequency analysis
    const startBin = Math.max(1, Math.min(data.length - 1, Math.floor((startHz / nyquist) * data.length)));
    const endBin = Math.max(startBin + 1, Math.min(data.length, Math.ceil((endHz / nyquist) * data.length)));
    const count = Math.max(1, endBin - startBin);

    let sum = 0;
    let activeBins = 0;
    // An active bin has significant energy (>= 32 out of 255)
    for (let i = startBin; i < endBin; i++) {
      const val = data[i];
      sum += val;
      if (val >= 32) activeBins++;
    }

    const avg = (sum / count) / 255;
    const activeRatio = activeBins / count;

    // "they should really only max out if 50% of the frequency band is actually active or similar"
    // If less than 50% of the band is active, scale down proportionally so narrow spikes cannot max out
    const activityFactor = Math.min(1.0, activeRatio / 0.50);

    return avg * Math.pow(activityFactor, 0.7);
  }

  // Native 60Hz Oscilloscope & 7-Segment Digital Clock Rendering Loop
  let rafId: number | null = null;
  let frameCounter = 0;

  // Psychographic Display (666 Mode) — 10 neural link strands (A¹ bottom .. A¹⁰ top)
  const PSYCHO_BANDS = [
    { sup: '1', minHz: 30, maxHz: 90, baseY: 266 },
    { sup: '2', minHz: 90, maxHz: 180, baseY: 243 },
    { sup: '3', minHz: 180, maxHz: 350, baseY: 220 },
    { sup: '4', minHz: 350, maxHz: 700, baseY: 197 },
    { sup: '5', minHz: 700, maxHz: 1400, baseY: 174 },
    { sup: '6', minHz: 1400, maxHz: 2800, baseY: 151 },
    { sup: '7', minHz: 2800, maxHz: 5000, baseY: 128 },
    { sup: '8', minHz: 5000, maxHz: 8000, baseY: 105 },
    { sup: '9', minHz: 8000, maxHz: 12000, baseY: 82 },
    { sup: '10', minHz: 12000, maxHz: 18000, baseY: 59 }
  ];
  const PSYCHO_CONVERGE_X = 484;
  const PSYCHO_CONVERGE_Y = 289;
  const PSYCHO_THRESHOLD = 0.26;
  const psychoPaths: (SVGPathElement | null)[] = Array(10).fill(null);
  const psychoLeftPaths: (SVGPathElement | null)[] = Array(10).fill(null);
  let psychoEyeGroup: SVGGElement | null = $state(null);
  const psychoSmoothedEnergy = new Float32Array(10);

  function buildPsychoLeftPath(idx: number): string {
    const baseY = PSYCHO_BANDS[idx].baseY;
    const kneeX = 334 - idx * 2.4;
    return `M14,${baseY} L${kneeX.toFixed(1)},${baseY} L${PSYCHO_CONVERGE_X},${PSYCHO_CONVERGE_Y}`;
  }

  function buildPsychoRightPath(idx: number, energy: number, timeData: Uint8Array | null, nowSec: number): string {
    const targetY = PSYCHO_BANDS[idx].baseY;
    const chaos = Math.max(0, Math.min(1, (energy - PSYCHO_THRESHOLD) / 0.34));
    const points = 28;
    let d = `M${PSYCHO_CONVERGE_X},${PSYCHO_CONVERGE_Y}`;

    for (let s = 1; s <= points; s++) {
      const p = s / points;
      const baseX = PSYCHO_CONVERGE_X + p * 378;
      // Smooth fan-out from convergence vertex toward each band's target stratum
      const fanY = PSYCHO_CONVERGE_Y + (targetY - PSYCHO_CONVERGE_Y) * Math.pow(p, 0.72);

      let waveSample = 0;
      if (timeData && timeData.length > 0) {
        const sampleIdx = (idx * 29 + s * 9) % timeData.length;
        waveSample = (timeData[sampleIdx] - 128) / 128;
      }

      // Live audiograph displacement along the strand
      const audioDisplaceY = waveSample * (8 + energy * 38) * Math.sin(p * Math.PI);
      const harmonicRippleY = Math.sin(p * 10 - nowSec * (3.2 + idx * 0.25) + idx) * (2.5 + energy * 10);

      // Artistic psychographic loop-backs & chaotic scrawls when energy crosses threshold
      const loopAmp = chaos * p * (16 + energy * 34);
      const loopX = loopAmp * Math.sin(nowSec * (2.7 + idx * 0.35) + s * 1.65 + waveSample * 4.2);
      const loopY = loopAmp * Math.cos(nowSec * (3.3 + idx * 0.28) + s * 2.05 - waveSample * 4.8);

      const x = Math.max(PSYCHO_CONVERGE_X + 2, Math.min(868, baseX + loopX));
      const y = Math.max(46, Math.min(289, fanY + audioDisplaceY + harmonicRippleY + loopY));
      d += ` L${x.toFixed(1)},${y.toFixed(1)}`;
    }
    return d;
  }

  function updatePsychograph(nowMs: number, audioData: any) {
    const nowSec = nowMs * 0.001;
    const sampleRate = audioData?.sampleRate || 44100;
    const freqData: Uint8Array | null = audioData?.freq || null;
    const timeData: Uint8Array | null = audioData?.time || null;

    let totalEnergy = 0;
    for (let i = 0; i < PSYCHO_BANDS.length; i++) {
      const band = PSYCHO_BANDS[i];
      const rawEnergy = freqData ? getBandEnergy(freqData, band.minHz, band.maxHz, sampleRate) : 0;
      psychoSmoothedEnergy[i] = psychoSmoothedEnergy[i] * 0.35 + rawEnergy * 0.65;
      const e = psychoSmoothedEnergy[i];
      totalEnergy += e;

      const rightEl = psychoPaths[i];
      if (rightEl) {
        rightEl.setAttribute('d', buildPsychoRightPath(i, e, timeData, nowSec));
        rightEl.setAttribute('stroke-width', (1.25 + e * 1.35).toFixed(2));
        rightEl.setAttribute('opacity', (0.68 + Math.min(0.32, e * 0.5)).toFixed(2));
      }

      const leftEl = psychoLeftPaths[i];
      if (leftEl) {
        leftEl.setAttribute('opacity', (0.62 + Math.min(0.38, e * 0.65)).toFixed(2));
      }
    }

    if (psychoEyeGroup) {
      const avgEnergy = totalEnergy / PSYCHO_BANDS.length;
      const eyeChaos = Math.max(0, Math.min(1, (avgEnergy - 0.28) / 0.32));
      psychoEyeGroup.setAttribute('opacity', (eyeChaos * 0.92).toFixed(2));
      const jx = eyeChaos * Math.sin(nowSec * 19) * 3.5;
      const jy = eyeChaos * Math.cos(nowSec * 23) * 2.5;
      psychoEyeGroup.setAttribute('transform', `translate(${jx.toFixed(1)}, ${jy.toFixed(1)})`);
    }
  }

  function computeInstantChannelOffset(chanIdx: number, audioData: any): number {
    if (!audioData || !audioData.freq) return -24;

    const sampleRate = audioData.sampleRate || 44100;
    let mag = 0;

    if (chanIdx === 0) {
      // CONTACT LINE: Sub 80Hz (sub-bass 30Hz to 80Hz, excluding 0Hz DC bias)
      mag = getBandEnergy(audioData.freq, 30, 80, sampleRate);
    } else if (chanIdx === 1) {
      // LEFT CHANNEL: True stereo left spectrum (40Hz to 12kHz)
      const leftArr = audioData.leftFreq || audioData.freq;
      mag = getBandEnergy(leftArr, 40, 12000, sampleRate);
    } else if (chanIdx === 2) {
      // RIGHT CHANNEL: True stereo right spectrum (40Hz to 12kHz)
      const rightArr = audioData.rightFreq || audioData.freq;
      mag = getBandEnergy(rightArr, 40, 12000, sampleRate);
    } else if (chanIdx === 3) {
      // BASS: 80Hz to 500Hz
      mag = getBandEnergy(audioData.freq, 80, 500, sampleRate);
    } else if (chanIdx === 4) {
      // TREBLE: 6kHz and above (6kHz to 18kHz)
      mag = getBandEnergy(audioData.freq, 6000, 18000, sampleRate);
    } else if (chanIdx === 5) {
      // CH ALFA: 2kHz to 6kHz
      mag = getBandEnergy(audioData.freq, 2000, 6000, sampleRate);
    } else if (chanIdx === 6) {
      // CH BETA: 500Hz to 2kHz
      mag = getBandEnergy(audioData.freq, 500, 2000, sampleRate);
    }

    if (mag < 0.015) return -24;

    if (chanIdx === 4) {
      // TREBLE: rests against left wall in Orange (-24px), spiking into Cyan only on percussive hits
      const rawOffset = -24 + (mag / 0.35) * 48;
      return Math.max(-24, Math.min(24, rawOffset));
    }

    // Dynamic running baseline: tracks nominal level so beats swing into Cyan (+) and decays swing into Orange (-)
    runningBaselines[chanIdx] = runningBaselines[chanIdx] * 0.985 + mag * 0.015;
    const diff = mag - runningBaselines[chanIdx];

    // Sensitivity divisor per band: determines how easily beats cross the +/- 0 line
    const sensitivities = [0.22, 0.20, 0.20, 0.22, 0.20, 0.20, 0.22];
    const sens = sensitivities[chanIdx] || 0.20;

    // Center is 0px (X = 0.00). On beats (diff > 0), swings right into Cyan. On decays (diff < 0), swings left into Orange.
    const rawOffset = (diff / sens) * 24;
    return Math.max(-24, Math.min(24, rawOffset));
  }

  function buildWavePath(chanIdx: number, cx: number): string {
    const rawBuf = historyBuffers[chanIdx];
    const topY = 62;
    const botY = 295;
    const h = botY - topY;
    const stepY = h / (HISTORY_LEN - 1);

    // Subtle 8% smoothing to remove raster jaggies while preserving rich wave crests and valleys
    const filteredX: number[] = new Array(HISTORY_LEN);
    for (let i = 0; i < HISTORY_LEN; i++) {
      const prev = rawBuf[Math.max(0, i - 1)];
      const curr = rawBuf[i];
      const next = rawBuf[Math.min(HISTORY_LEN - 1, i + 1)];
      const smoothed = prev * 0.08 + curr * 0.84 + next * 0.08;
      filteredX[i] = cx + Math.max(-24, Math.min(24, smoothed));
    }

    let d = `M ${filteredX[0].toFixed(1)} ${topY.toFixed(1)}`;

    for (let i = 0; i < HISTORY_LEN - 1; i++) {
      const y1 = topY + i * stepY;
      const y2 = topY + (i + 1) * stepY;
      const x1 = filteredX[i];
      const x2 = filteredX[i + 1];

      const x0 = filteredX[Math.max(0, i - 1)];
      const x3 = filteredX[Math.min(HISTORY_LEN - 1, i + 2)];

      const cp1x = x1 + (x2 - x0) / 6;
      const cp1y = y1 + (y2 - (topY + Math.max(0, i - 1) * stepY)) / 6;
      const cp2x = x2 - (x3 - x1) / 6;
      const cp2y = y2 - ((topY + Math.min(HISTORY_LEN - 1, i + 2) * stepY) - y1) / 6;

      d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
    }

    return d;
  }

  function tick() {
    if (document.hidden) {
      if (isPlaying && isAudioActuallyPlaying) {
        rafId = requestAnimationFrame(tick);
      } else {
        rafId = null;
      }
      return;
    }

    const now = performance.now();
    const active = isPlaying && isAudioActuallyPlaying;

    if (!active) {
      const estAudio = Math.min(Math.max(0, duration), currentTime);
      baseAudioTime = currentTime;
      basePerfTime = now;
      applyDigits(computeDisplaySecs(estAudio));

      if (!wasIdle) {
        wasIdle = true;
        resetWavesToBaseline();
      }
      rafId = null;
      return;
    }

    wasIdle = false;
    frameCounter++;

    if (visMode === 'off') {
      if (!wasVisOff) {
        wasVisOff = true;
        resetWavesToBaseline();
      }
      rafId = null;
      return;
    }
    wasVisOff = false;

    const elapsed = Math.max(0, (now - basePerfTime) / 1000);
    const estAudio = Math.min(Math.max(0, duration), baseAudioTime + elapsed);

    // 1. Update 7-Segment Digital Clock with Shadow 8s
    applyDigits(computeDisplaySecs(estAudio));

    const minWaveInterval = visMode === 'hi' || visMode === '666' ? 0 : 28;
    if (minWaveInterval === 0 || now - lastWaveRenderAt >= minWaveInterval) {
      lastWaveRenderAt = now;

      // Sample real-time audio spectrum
      const audioData = getAudioData ? getAudioData() : null;

      if (visMode === '666') {
        updatePsychograph(now, audioData);
      } else {
        if (audioData && audioData.freq) {
          // 2. Compute instantaneous scalar X for each channel and push to history buffer
          for (let i = 0; i < CHANNELS.length; i++) {
            const targetOffset = computeInstantChannelOffset(i, audioData);
            smoothedX[i] = smoothedX[i] * 0.22 + targetOffset * 0.78;

            const buf = historyBuffers[i];
            for (let k = HISTORY_LEN - 1; k > 0; k--) {
              buf[k] = buf[k - 1];
            }
            buf[0] = smoothedX[i];
          }
        }

        // 3. Render waveform paths for all 7 channels
        for (let i = 0; i < CHANNELS.length; i++) {
          const pathEl = wavePaths[i];
          if (pathEl) {
            const cx = 20 + i * 112 + 52;
            pathEl.setAttribute('d', buildWavePath(i, cx));
          }
        }

        // 4. Update Top-Point Telemetry "X: ..." values & Dynamic Color (only when changed)
        for (let i = 0; i < CHANNELS.length; i++) {
          const textEl = telemetryTexts[i];
          const groupEl = chanGroups[i];

          if (!audioData || !audioData.freq) {
            if (groupEl && lastIsBlue[i]) {
              groupEl.classList.remove('is-blue');
              lastIsBlue[i] = false;
            }
            if (textEl && lastTelemetryStr[i] !== 'X: -9.99') {
              textEl.textContent = 'X: -9.99';
              lastTelemetryStr[i] = 'X: -9.99';
            }
            continue;
          }

          const topOffset = historyBuffers[i][0];
          const clampedTop = Math.max(-24, Math.min(24, topOffset));
          const xVal = (clampedTop / 24) * 9.99;
          const isBlue = xVal > 0;

          if (groupEl && lastIsBlue[i] !== isBlue) {
            groupEl.classList.toggle('is-blue', isBlue);
            lastIsBlue[i] = isBlue;
          }

          if (textEl) {
            let nextStr: string;
            if (clampedTop <= -23.95) {
              nextStr = 'X: -9.99';
            } else if (clampedTop >= 23.95) {
              nextStr = 'X: +9.99';
            } else if (xVal > 0) {
              nextStr = `X: +${xVal.toFixed(2)}`;
            } else {
              nextStr = `X: ${xVal.toFixed(2)}`;
            }
            if (lastTelemetryStr[i] !== nextStr) {
              textEl.textContent = nextStr;
              lastTelemetryStr[i] = nextStr;
            }
          }
        }
      }
    }

    rafId = requestAnimationFrame(tick);
  }

  function startLoop() {
    stopLoop();
    basePerfTime = performance.now();
    rafId = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  $effect(() => {
    // Re-trigger loop or single idle render whenever playback/time/mode props change
    void currentTime;
    void duration;
    void isPlaying;
    void isAudioActuallyPlaying;
    void showRemaining;
    if (visMode === 'off') {
      stopLoop();
      return;
    }
    if (rafId === null) {
      startLoop();
    }
  });

  onDestroy(() => {
    stopLoop();
  });

  function handleProgressBarClick(e: MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const frac = Math.max(0, Math.min(1, x / rect.width));
    onSeek(frac);
  }
</script>

<div class="eva-audiovisual-panel" role="region" aria-label="AUDIOVISUAL Oscilloscope & Timer">
  <div class="vis-top-bar">
    <div class="vis-tooltip-wrap" data-tooltip="CYCLE VIS: LO (30FPS) / HI (60FPS) / 666 (PSYCHOGRAPHIC) / OFF">
      <button
        type="button"
        class="vis-mode-pill"
        class:is-lo={visMode === 'lo'}
        class:is-hi={visMode === 'hi'}
        class:is-666={visMode === '666'}
        class:is-off={visMode === 'off'}
        onclick={cycleVisMode}
        aria-label="Cycle Visualizer Mode: LO (30fps) / HI (60fps) / 666 (Psychographic) / OFF"
      >
        <span class="vis-led" aria-hidden="true"></span>
        <span class="vis-prefix">VIS //</span>
        <span class="vis-state">{visMode.toUpperCase()}</span>
        <span class="vis-bars" aria-hidden="true">
          <span class="vis-bar" class:lit={visMode !== 'off'}></span>
          <span class="vis-bar" class:lit={visMode === 'hi' || visMode === '666'}></span>
          <span class="vis-bar" class:lit={visMode === '666'}></span>
        </span>
      </button>
    </div>
  </div>
  <svg class="audiovisual-svg" viewBox="0 0 880 320" preserveAspectRatio="xMidYMid meet">
    <defs>
      <!-- Background Cyberpunk / NERV Grid Pattern matching Buffer Loader -->
      <pattern id="eva-audiovisual-grid" width="16" height="16" patternUnits="userSpaceOnUse">
        <path d="M 16 0 L 0 0 0 16" fill="none" stroke="#2a0a03" stroke-width="0.8" />
      </pattern>

      <!-- Radial Vignette for CRT monitor depth -->
      <radialGradient id="audiovisual-vignette" cx="50%" cy="50%" r="70%">
        <stop offset="0%" stop-color="#160401" stop-opacity="0.25" />
        <stop offset="100%" stop-color="#060101" stop-opacity="0.85" />
      </radialGradient>

      <!-- Phosphor glow for Psychographic 666 Mode -->
      <filter id="psycho-glow" x="-15%" y="-15%" width="130%" height="130%">
        <feGaussianBlur stdDeviation="1.6" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>

    <!-- Dark Vignette Background with NERV Gridlines -->
    <rect x="0" y="0" width="880" height="320" fill="#060201" />
    <rect x="2" y="2" width="876" height="316" fill="url(#eva-audiovisual-grid)" opacity="0.9" />
    <rect x="2" y="2" width="876" height="316" fill="url(#audiovisual-vignette)" stroke="#2a0802" stroke-width="1.2" pointer-events="none" />

    <!-- Top Left Header: "AUDIOVISUAL" or "PSYCHOGRAPHIC DISPLAY" in 666 Mode -->
    {#if visMode === '666'}
      <rect x="14" y="9" width="220" height="24" rx="5" fill="none" stroke="#ff7700" stroke-width="1.5" />
      <text x="124" y="25.5" text-anchor="middle" class="psycho-display-title">PSYCHOGRAPHIC DISPLAY</text>
      <text x="246" y="19" class="psycho-phase-title">Phase 4</text>
      <text x="246" y="33" class="psycho-sub-title">NERV_AUDIO // CONTAMINATION 666</text>
      <line x1="12" y1="40" x2="868" y2="40" stroke="#ff7700" stroke-width="1.6" />
    {:else}
      <text x="18" y="30" class="audiovisual-title">AUDIOVISUAL</text>
    {/if}

    {#if visMode !== 'off'}
      <!-- Top Right 7-Segment Digital Clock (MM:SS:CC) with Shadow Digital 8s -->
      <!-- Clickable to toggle between Remaining and Elapsed time -->
      <g
        transform="translate(738, 10) skewX(-5)"
        class="digital-clock-group"
        role="button"
        tabindex="0"
        onclick={() => { showRemaining = !showRemaining; resetDigitCache(); }}
        onkeydown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            showRemaining = !showRemaining;
            resetDigitCache();
          }
        }}
        aria-label="Toggle Countdown / Elapsed Digital Timer"
      >
      <!-- Full bounding-box hit area so gaps between segments are clickable -->
      <rect x="-6" y="-4" width="136" height="33" fill="transparent" />
      <!-- Minute 1 -->
      <g bind:this={m1Svg} class="seg-digit" transform="translate(0, 0) scale(0.48)" data-d="0">
        <polygon points="5,3 29,3 25,8 9,8" class="seg sa" />
        <polygon points="30,4 30,24 25,22 26,9" class="seg sb" />
        <polygon points="30,28 30,48 26,43 25,30" class="seg sc" />
        <polygon points="5,49 29,49 25,44 9,44" class="seg sd" />
        <polygon points="4,28 4,48 9,43 8,30" class="seg se" />
        <polygon points="4,4 4,24 8,22 9,9" class="seg sf" />
        <polygon points="7,26 10,23 24,23 27,26 24,29 10,29" class="seg sg" />
      </g>

      <!-- Minute 2 -->
      <g bind:this={m2Svg} class="seg-digit" transform="translate(18, 0) scale(0.48)" data-d="0">
        <polygon points="5,3 29,3 25,8 9,8" class="seg sa" />
        <polygon points="30,4 30,24 25,22 26,9" class="seg sb" />
        <polygon points="30,28 30,48 26,43 25,30" class="seg sc" />
        <polygon points="5,49 29,49 25,44 9,44" class="seg sd" />
        <polygon points="4,28 4,48 9,43 8,30" class="seg se" />
        <polygon points="4,4 4,24 8,22 9,9" class="seg sf" />
        <polygon points="7,26 10,23 24,23 27,26 24,29 10,29" class="seg sg" />
      </g>

      <!-- Colon 1 -->
      <g transform="translate(36, 0)">
        <rect x="2" y="7" width="3" height="3" class="colon-dot" />
        <rect x="2" y="15" width="3" height="3" class="colon-dot" />
      </g>

      <!-- Second 1 -->
      <g bind:this={s1Svg} class="seg-digit" transform="translate(45, 0) scale(0.48)" data-d="0">
        <polygon points="5,3 29,3 25,8 9,8" class="seg sa" />
        <polygon points="30,4 30,24 25,22 26,9" class="seg sb" />
        <polygon points="30,28 30,48 26,43 25,30" class="seg sc" />
        <polygon points="5,49 29,49 25,44 9,44" class="seg sd" />
        <polygon points="4,28 4,48 9,43 8,30" class="seg se" />
        <polygon points="4,4 4,24 8,22 9,9" class="seg sf" />
        <polygon points="7,26 10,23 24,23 27,26 24,29 10,29" class="seg sg" />
      </g>

      <!-- Second 2 -->
      <g bind:this={s2Svg} class="seg-digit" transform="translate(63, 0) scale(0.48)" data-d="0">
        <polygon points="5,3 29,3 25,8 9,8" class="seg sa" />
        <polygon points="30,4 30,24 25,22 26,9" class="seg sb" />
        <polygon points="30,28 30,48 26,43 25,30" class="seg sc" />
        <polygon points="5,49 29,49 25,44 9,44" class="seg sd" />
        <polygon points="4,28 4,48 9,43 8,30" class="seg se" />
        <polygon points="4,4 4,24 8,22 9,9" class="seg sf" />
        <polygon points="7,26 10,23 24,23 27,26 24,29 10,29" class="seg sg" />
      </g>

      <!-- Colon 2 -->
      <g transform="translate(81, 0)">
        <rect x="2" y="7" width="3" height="3" class="colon-dot" />
        <rect x="2" y="15" width="3" height="3" class="colon-dot" />
      </g>

      <!-- Centisecond 1 -->
      <g bind:this={c1Svg} class="seg-digit" transform="translate(90, 0) scale(0.48)" data-d="0">
        <polygon points="5,3 29,3 25,8 9,8" class="seg sa" />
        <polygon points="30,4 30,24 25,22 26,9" class="seg sb" />
        <polygon points="30,28 30,48 26,43 25,30" class="seg sc" />
        <polygon points="5,49 29,49 25,44 9,44" class="seg sd" />
        <polygon points="4,28 4,48 9,43 8,30" class="seg se" />
        <polygon points="4,4 4,24 8,22 9,9" class="seg sf" />
        <polygon points="7,26 10,23 24,23 27,26 24,29 10,29" class="seg sg" />
      </g>

      <!-- Centisecond 2 -->
      <g bind:this={c2Svg} class="seg-digit" transform="translate(108, 0) scale(0.48)" data-d="0">
        <polygon points="5,3 29,3 25,8 9,8" class="seg sa" />
        <polygon points="30,4 30,24 25,22 26,9" class="seg sb" />
        <polygon points="30,28 30,48 26,43 25,30" class="seg sc" />
        <polygon points="5,49 29,49 25,44 9,44" class="seg sd" />
        <polygon points="4,28 4,48 9,43 8,30" class="seg se" />
        <polygon points="4,4 4,24 8,22 9,9" class="seg sf" />
        <polygon points="7,26 10,23 24,23 27,26 24,29 10,29" class="seg sg" />
      </g>
    </g>
    {/if}

    <!-- Far Right Edge: Rotated Vertical Duration in Cyan Formatted strictly as mm:ss:ms (7-Segment Digital matching Timer) -->
    <g
      transform="translate(788, 240) rotate(-90)"
      class="digital-duration-group"
      role="img"
      aria-label="Song Duration: {formattedDuration}"
    >
      <!-- Minute 1 -->
      <g class="seg-digit" transform="translate(0, 0) scale(0.48)" data-d={durDigits.m1}>
        <polygon points="5,3 29,3 25,8 9,8" class="seg sa" />
        <polygon points="30,4 30,24 25,22 26,9" class="seg sb" />
        <polygon points="30,28 30,48 26,43 25,30" class="seg sc" />
        <polygon points="5,49 29,49 25,44 9,44" class="seg sd" />
        <polygon points="4,28 4,48 9,43 8,30" class="seg se" />
        <polygon points="4,4 4,24 8,22 9,9" class="seg sf" />
        <polygon points="7,26 10,23 24,23 27,26 24,29 10,29" class="seg sg" />
      </g>

      <!-- Minute 2 -->
      <g class="seg-digit" transform="translate(18, 0) scale(0.48)" data-d={durDigits.m2}>
        <polygon points="5,3 29,3 25,8 9,8" class="seg sa" />
        <polygon points="30,4 30,24 25,22 26,9" class="seg sb" />
        <polygon points="30,28 30,48 26,43 25,30" class="seg sc" />
        <polygon points="5,49 29,49 25,44 9,44" class="seg sd" />
        <polygon points="4,28 4,48 9,43 8,30" class="seg se" />
        <polygon points="4,4 4,24 8,22 9,9" class="seg sf" />
        <polygon points="7,26 10,23 24,23 27,26 24,29 10,29" class="seg sg" />
      </g>

      <!-- Colon 1 -->
      <g transform="translate(36, 0)">
        <rect x="2" y="7" width="3" height="3" class="colon-dot" />
        <rect x="2" y="15" width="3" height="3" class="colon-dot" />
      </g>

      <!-- Second 1 -->
      <g class="seg-digit" transform="translate(45, 0) scale(0.48)" data-d={durDigits.s1}>
        <polygon points="5,3 29,3 25,8 9,8" class="seg sa" />
        <polygon points="30,4 30,24 25,22 26,9" class="seg sb" />
        <polygon points="30,28 30,48 26,43 25,30" class="seg sc" />
        <polygon points="5,49 29,49 25,44 9,44" class="seg sd" />
        <polygon points="4,28 4,48 9,43 8,30" class="seg se" />
        <polygon points="4,4 4,24 8,22 9,9" class="seg sf" />
        <polygon points="7,26 10,23 24,23 27,26 24,29 10,29" class="seg sg" />
      </g>

      <!-- Second 2 -->
      <g class="seg-digit" transform="translate(63, 0) scale(0.48)" data-d={durDigits.s2}>
        <polygon points="5,3 29,3 25,8 9,8" class="seg sa" />
        <polygon points="30,4 30,24 25,22 26,9" class="seg sb" />
        <polygon points="30,28 30,48 26,43 25,30" class="seg sc" />
        <polygon points="5,49 29,49 25,44 9,44" class="seg sd" />
        <polygon points="4,28 4,48 9,43 8,30" class="seg se" />
        <polygon points="4,4 4,24 8,22 9,9" class="seg sf" />
        <polygon points="7,26 10,23 24,23 27,26 24,29 10,29" class="seg sg" />
      </g>

      <!-- Colon 2 -->
      <g transform="translate(81, 0)">
        <rect x="2" y="7" width="3" height="3" class="colon-dot" />
        <rect x="2" y="15" width="3" height="3" class="colon-dot" />
      </g>

      <!-- Centisecond 1 -->
      <g class="seg-digit" transform="translate(90, 0) scale(0.48)" data-d={durDigits.c1}>
        <polygon points="5,3 29,3 25,8 9,8" class="seg sa" />
        <polygon points="30,4 30,24 25,22 26,9" class="seg sb" />
        <polygon points="30,28 30,48 26,43 25,30" class="seg sc" />
        <polygon points="5,49 29,49 25,44 9,44" class="seg sd" />
        <polygon points="4,28 4,48 9,43 8,30" class="seg se" />
        <polygon points="4,4 4,24 8,22 9,9" class="seg sf" />
        <polygon points="7,26 10,23 24,23 27,26 24,29 10,29" class="seg sg" />
      </g>

      <!-- Centisecond 2 -->
      <g class="seg-digit" transform="translate(108, 0) scale(0.48)" data-d={durDigits.c2}>
        <polygon points="5,3 29,3 25,8 9,8" class="seg sa" />
        <polygon points="30,4 30,24 25,22 26,9" class="seg sb" />
        <polygon points="30,28 30,48 26,43 25,30" class="seg sc" />
        <polygon points="5,49 29,49 25,44 9,44" class="seg sd" />
        <polygon points="4,28 4,48 9,43 8,30" class="seg se" />
        <polygon points="4,4 4,24 8,22 9,9" class="seg sf" />
        <polygon points="7,26 10,23 24,23 27,26 24,29 10,29" class="seg sg" />
      </g>
    </g>

    <!-- 7 VERTICAL OSCILLOSCOPE CHANNELS, 666 PSYCHOGRAPHIC DISPLAY, OR SEELE 02 SOUND ONLY MONOLITH -->
    {#if visMode === '666'}
      <g class="psycho-display-group" filter="url(#psycho-glow)">
        <!-- Left Converging Neural Links (LINK A¹ .. A¹⁰) & Live Right-Side Audiograph Strands -->
        {#each PSYCHO_BANDS as band, i}
          <text x="64" y={band.baseY - 5} class="psycho-link-label">
            LINK A<tspan dy="-4" font-size="7.5">{band.sup}</tspan>
          </text>
          <path
            bind:this={psychoLeftPaths[i]}
            d={buildPsychoLeftPath(i)}
            fill="none"
            stroke="#fff49a"
            stroke-width="1.35"
            opacity="0.82"
          />
          <path
            bind:this={psychoPaths[i]}
            d={buildPsychoRightPath(i, 0.1, null, 0)}
            fill="none"
            stroke="#fff6aa"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
            opacity="0.85"
          />
        {/each}

        <!-- Psychographic Contamination Eye Motifs (emerge above threshold) -->
        <g bind:this={psychoEyeGroup} opacity="0">
          <!-- Primary Mid-Right Eye Scrawl -->
          <path
            d="M578,136 Q616,104 656,134 Q616,162 578,136 Z M598,134 A17,17 0 1,0 634,134 A17,17 0 1,0 598,134 M610,134 A6,6 0 1,0 622,134 A6,6 0 1,0 610,134"
            fill="none"
            stroke="#fff6aa"
            stroke-width="1.6"
          />
          <path
            d="M574,130 L584,119 L594,125 L605,112 L617,120 L629,110 L640,122 L652,115 L660,129"
            fill="none"
            stroke="#fff6aa"
            stroke-width="1.2"
            opacity="0.85"
          />
          <!-- Upper-Right Secondary Eye Scrawl -->
          <path
            d="M694,88 Q726,64 760,86 Q726,106 694,88 Z M713,86 A13,13 0 1,0 741,86 A13,13 0 1,0 713,86 M723,86 A4.5,4.5 0 1,0 732,86 A4.5,4.5 0 1,0 723,86"
            fill="none"
            stroke="#fff6aa"
            stroke-width="1.45"
          />
          <path
            d="M690,83 L702,71 L713,77 L725,65 L737,74 L749,67 L762,81"
            fill="none"
            stroke="#fff6aa"
            stroke-width="1.1"
            opacity="0.82"
          />
        </g>

        <!-- Bottom Calibrated Psychographic Ruler (-50 .. ±0 .. +50) -->
        <line x1="12" y1="292" x2="868" y2="292" stroke="#ff7700" stroke-width="1.5" />
        {#each [-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50] as tickVal}
          {@const tx = 460 + tickVal * 8}
          <line x1={tx} y1="292" x2={tx} y2="300" stroke="#ff7700" stroke-width="1.3" />
          <text x={tx} y="313" text-anchor="middle" class="psycho-ruler-label">
            {tickVal === 0 ? '±0' : tickVal > 0 ? `+${tickVal}` : `${tickVal}`}
          </text>
          {#if tickVal < 50}
            {#each [1, 2, 3, 4] as sub}
              <line x1={tx + sub * 16} y1="292" x2={tx + sub * 16} y2="296.5" stroke="#ff7700" stroke-width="0.9" opacity="0.85" />
            {/each}
          {/if}
        {/each}
      </g>
    {:else if visMode !== 'off'}
      {#each CHANNELS as ch, i}
        {@const chanX = 20 + i * 112}
        {@const cx = chanX + 52}

        <g bind:this={chanGroups[i]} class="channel-column">
          <!-- 1. Top Telemetry Box: "X: ..." -->
          <g class="chan-telemetry-group">
            <rect
              x={chanX + 22}
              y="40"
              width="60"
              height="16"
              fill="#0a0301"
              class="chan-telemetry-box"
              stroke-width="1.2"
            />
            <text
              bind:this={telemetryTexts[i]}
              x={cx}
              y="52.5"
              class="telemetry-coord-text"
              text-anchor="middle"
            >
              X: -9.99
            </text>
          </g>

          <!-- 2. Channel Oscilloscope Viewport Box -->
          <rect
            x={chanX + 22}
            y="62"
            width="60"
            height="233"
            fill="#040101"
            class="chan-viewport"
            stroke-width="1.4"
          />

          <!-- 3. Horizontal Center Gate / Split Line -->
          <line
            x1={chanX + 22}
            y1="178"
            x2={chanX + 82}
            y2="178"
            class="chan-gate"
            stroke-width="1.2"
            stroke-opacity="0.9"
          />

          <!-- 4. Left Instrument Ruler with Tick Marks and Labels -->
          <g class="chan-ruler">
            <!-- Vertical scale baseline -->
            <line x1={chanX + 16} y1="62" x2={chanX + 16} y2="295" stroke-width="0.9" />
            <!-- Instrument tick marks along ruler -->
            {#each Array(24) as _, tk}
              <line
                x1={chanX + 12}
                y1={66 + tk * 9.6}
                x2={chanX + 16}
                y2={66 + tk * 9.6}
                stroke-width="0.8"
                stroke-opacity={tk % 4 === 0 ? 0.95 : 0.45}
              />
            {/each}
            <!-- -01 / 01 Scale Numbers -->
            <text x={chanX + 6} y="125" class="ruler-scale-num">-01</text>
            <text x={chanX + 6} y="235" class="ruler-scale-num">01</text>

            <!-- Vertical Rotated Channel Name Label -->
            <text
              x={chanX + 9}
              y="178"
              transform="rotate(-90 {chanX + 9} 178)"
              class="chan-vertical-label"
              text-anchor="middle"
            >
              8 {ch.name}
            </text>
          </g>

          <!-- 5. Dynamic 60Hz Oscilloscope Waveform Path -->
          <path
            bind:this={wavePaths[i]}
            d="M {cx - 24} 62 L {cx - 24} 295"
            fill="none"
            class="oscilloscope-wave"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </g>
      {/each}
    {:else}
      <!-- SEELE 02 // SOUND ONLY Monolith -->
      <g class="seele-monolith" class:speaking={isPlaying && isAudioActuallyPlaying}>
        <rect
          x="36"
          y="54"
          width="732"
          height="242"
          rx="2"
          fill="#030203"
          stroke="#1a1210"
          stroke-width="1.2"
        />
        <rect
          x="38"
          y="56"
          width="728"
          height="238"
          fill="none"
          stroke="rgba(255, 119, 0, 0.14)"
          stroke-width="1"
        />
        <text x="402" y="84" text-anchor="middle" class="seele-top-label">SEELE 02</text>
        <text x="402" y="176" text-anchor="middle" class="seele-sound-only">SOUND ONLY</text>

        <!-- 4-bar speaking equalizer -->
        <g transform="translate(388, 192)">
          <rect x="0" y="10" width="4" height="8" class="seele-eq-bar b1" />
          <rect x="7" y="4" width="4" height="14" class="seele-eq-bar b2" />
          <rect x="14" y="8" width="4" height="10" class="seele-eq-bar b3" />
          <rect x="21" y="2" width="4" height="16" class="seele-eq-bar b4" />
        </g>

        <text x="402" y="274" text-anchor="middle" class="seele-bottom-id">02</text>
      </g>
    {/if}

    <!-- CRT Scan Line Effect Sweep Beam matching Buffer Loader -->
    {#if visMode !== 'off' && isPlaying && isAudioActuallyPlaying}
      <line x1="2" y1="2" x2="2" y2="318" stroke="#ff7700" stroke-width="1.8" opacity="0.55" class="scan-beam">
        <animate attributeName="x1" values="2;878;2" dur="4.5s" repeatCount="indefinite" />
        <animate attributeName="x2" values="2;878;2" dur="4.5s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.7;0.18;0.7" dur="4.5s" repeatCount="indefinite" />
      </line>
    {/if}

    <!-- NERV-UI Repeating Grid Pattern Overlay when Paused -->
    {#if !isPlaying || !isAudioActuallyPlaying}
      <g class="paused-grid-overlay" pointer-events="none">
        <rect x="2" y="38" width="876" height="278" fill="rgba(4, 1, 1, 0.78)" />
        {#each [124, 188, 252] as rowY}
          <text x="295" y={rowY} text-anchor="middle" class="paused-grid-text">PAUSED</text>
          <text x="585" y={rowY} text-anchor="middle" class="paused-grid-text">PAUSED</text>
        {/each}
      </g>
    {/if}
  </svg>

  <!-- Sleek Interactive Seek Scrubber Bar at Bottom -->
  <div
    class="eva-scrubber-track"
    onclick={handleProgressBarClick}
    role="slider"
    tabindex="0"
    aria-label="Seek Song Position"
    aria-valuenow={Math.round(currentTime)}
    aria-valuemin="0"
    aria-valuemax={Math.round(duration)}
    onkeydown={(e) => {
      if (e.key === 'ArrowRight') onSeek(Math.min(1, (currentTime + 5) / Math.max(1, duration)));
      if (e.key === 'ArrowLeft') onSeek(Math.max(0, (currentTime - 5) / Math.max(1, duration)));
    }}
  >
    <div class="eva-scrubber-spectrum" aria-hidden="true"></div>
    <div
      class="eva-scrubber-mask"
      style="transform: scaleX({Math.max(0, Math.min(1, 1 - progressPct))})"
      aria-hidden="true"
    ></div>
    <div class="eva-scrubber-crt" aria-hidden="true"></div>
    <div
      class="eva-scrubber-head"
      style="left: {Math.max(0, Math.min(100, progressPct * 100))}%"
      aria-hidden="true"
    ></div>
  </div>
</div>

<style>
  .eva-audiovisual-panel {
    background: #060201;
    border: 1.5px solid #ff7700;
    box-shadow: 0 0 22px rgba(255, 119, 0, 0.3), inset 0 0 16px rgba(0, 0, 0, 0.95);
    position: relative;
    padding: 8px 10px 10px 10px;
    box-sizing: border-box;
    margin: 4px 0 10px 0;
    width: 100%;
    overflow: hidden;
    contain: content;
  }

  /* Authentic CRT Scanline Overlay matching Buffer Loader */
  .eva-audiovisual-panel::before {
    content: "";
    position: absolute;
    inset: 0;
    background: repeating-linear-gradient(
      to bottom,
      transparent 0px,
      transparent 2px,
      rgba(0, 0, 0, 0.32) 2px,
      rgba(0, 0, 0, 0.32) 4px
    );
    pointer-events: none;
    z-index: 5;
    opacity: 0.75;
  }

  .scan-beam {
    pointer-events: none;
  }

  .audiovisual-svg {
    width: 100%;
    height: auto;
    max-height: 310px;
    display: block;
    overflow: visible;
  }

  .vis-top-bar {
    position: relative;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    padding: 0 2px 6px 2px;
  }

  .vis-mode-pill {
    position: relative;
    z-index: 10;
    display: inline-flex;
    align-items: center;
    justify-content: space-between;
    gap: 7px;
    min-width: 132px;
    font-family: 'Share Tech Mono', monospace;
    font-size: 0.72rem;
    letter-spacing: 0.1em;
    padding: 4px 12px 4px 10px;
    background: rgba(3, 7, 16, 0.95);
    border: 1px solid rgba(0, 240, 255, 0.55);
    clip-path: polygon(0 0, calc(100% - 7px) 0, 100% 7px, 100% 100%, 7px 100%, 0 calc(100% - 7px));
    box-shadow: inset 0 0 8px rgba(0, 0, 0, 0.85);
    cursor: pointer !important;
    user-select: none;
    -webkit-user-select: none;
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  .vis-led {
    width: 6px;
    height: 12px;
    background: #00f0ff;
    box-shadow: 0 0 6px rgba(0, 240, 255, 0.75);
  }
  .vis-prefix {
    color: rgba(255, 119, 0, 0.65);
    font-size: 0.65rem;
    font-weight: 700;
  }
  .vis-state {
    color: #00f0ff;
    font-family: 'Orbitron', 'Share Tech Mono', monospace;
    font-weight: 800;
    font-size: 0.74rem;
    letter-spacing: 0.12em;
    min-width: 3.2ch;
    text-align: center;
  }
  .vis-bars {
    display: inline-flex;
    align-items: flex-end;
    gap: 2px;
    margin-left: 2px;
  }
  .vis-bar {
    width: 4px;
    height: 6px;
    background: rgba(255, 255, 255, 0.12);
    border: 1px solid rgba(255, 255, 255, 0.15);
  }
  .vis-bar:nth-child(2) {
    height: 10px;
  }
  .vis-bar:nth-child(3) {
    height: 13px;
  }
  .vis-mode-pill.is-lo .vis-bar.lit {
    background: #00f0ff;
    border-color: #00f0ff;
  }
  .vis-mode-pill:hover {
    background: rgba(0, 240, 255, 0.12);
    border-color: #00f0ff;
  }

  .vis-mode-pill.is-hi {
    border-color: rgba(255, 42, 77, 0.75);
  }
  .vis-mode-pill.is-hi .vis-led {
    background: #ff2a4d;
    box-shadow: 0 0 6px rgba(255, 42, 77, 0.85);
  }
  .vis-mode-pill.is-hi .vis-state {
    color: #ff2a4d;
  }
  .vis-mode-pill.is-hi .vis-bar.lit {
    background: #ff2a4d;
    border-color: #ff2a4d;
  }
  .vis-mode-pill.is-hi:hover {
    background: rgba(255, 42, 77, 0.14);
    border-color: #ff2a4d;
  }

  .vis-mode-pill.is-666 {
    border-color: rgba(255, 224, 102, 0.85);
    box-shadow: inset 0 0 10px rgba(255, 119, 0, 0.25), 0 0 8px rgba(255, 224, 102, 0.2);
  }
  .vis-mode-pill.is-666 .vis-led {
    background: #ffe066;
    box-shadow: 0 0 8px rgba(255, 224, 102, 0.95);
  }
  .vis-mode-pill.is-666 .vis-state {
    color: #ffe066;
    text-shadow: 0 0 6px rgba(255, 224, 102, 0.65);
  }
  .vis-mode-pill.is-666 .vis-bar.lit {
    background: #ffe066;
    border-color: #ffe066;
  }
  .vis-mode-pill.is-666:hover {
    background: rgba(255, 224, 102, 0.14);
    border-color: #ffe066;
  }

  .psycho-display-title {
    fill: #ff8811;
    font-family: 'Orbitron', 'Share Tech Mono', monospace;
    font-size: 11.5px;
    font-weight: 800;
    letter-spacing: 0.08em;
  }
  .psycho-phase-title {
    fill: #ff8811;
    font-family: 'Orbitron', 'Share Tech Mono', monospace;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.06em;
  }
  .psycho-sub-title {
    fill: #ff7700;
    font-family: 'Share Tech Mono', monospace;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.1em;
    opacity: 0.9;
  }
  .psycho-link-label {
    fill: #ff8811;
    font-family: 'Orbitron', 'Share Tech Mono', monospace;
    font-size: 9.5px;
    font-weight: 800;
    letter-spacing: 0.08em;
  }
  .psycho-ruler-label {
    fill: #ff7700;
    font-family: 'Share Tech Mono', monospace;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
  }

  .vis-mode-pill.is-off {
    border-color: rgba(255, 119, 0, 0.35);
  }
  .vis-mode-pill.is-off .vis-led {
    background: rgba(255, 119, 0, 0.35);
    box-shadow: none;
  }
  .vis-mode-pill.is-off .vis-state {
    color: rgba(255, 119, 0, 0.6);
  }
  .vis-mode-pill.is-off:hover {
    background: rgba(255, 119, 0, 0.1);
    border-color: rgba(255, 119, 0, 0.6);
  }

  /* Header Typography matching reference image */
  .audiovisual-title {
    font-family: 'Orbitron', 'Rajdhani', sans-serif;
    font-size: 26px;
    font-weight: 900;
    letter-spacing: 0.12em;
    fill: #ff7700;
    text-shadow: 0 0 10px rgba(255, 119, 0, 0.7);
  }

  /* 7-Segment Digital Clock Group */
  .digital-clock-group {
    cursor: pointer;
    --lit-fill: #ff7700;
    --lit-stroke: #ffa000;
    --lit-glow: rgba(255, 119, 0, 0.75);
    --unlit-fill: rgba(255, 119, 0, 0.12);
    --unlit-stroke: rgba(255, 119, 0, 0.18);
  }

  /* 7-Segment Digital Duration Group (matches Clock font & look in Electric Cyan) */
  .digital-duration-group {
    --lit-fill: #00d4ff;
    --lit-stroke: #38bdf8;
    --lit-glow: rgba(0, 212, 255, 0.85);
    --unlit-fill: rgba(0, 212, 255, 0.12);
    --unlit-stroke: rgba(0, 212, 255, 0.18);
  }

  .seg-digit {
    overflow: visible;
  }

  /* Authentic Shadow 8 Digital Display:
     Unlit segments default to faint shadow outline, always visible as a digital 8 */
  .seg {
    fill: var(--unlit-fill);
    stroke: var(--unlit-stroke);
    stroke-width: 0.5;
  }

  /* Lit bright electric segments */
  .seg-digit:global([data-d="0"]) .sa,
  .seg-digit:global([data-d="2"]) .sa,
  .seg-digit:global([data-d="3"]) .sa,
  .seg-digit:global([data-d="5"]) .sa,
  .seg-digit:global([data-d="6"]) .sa,
  .seg-digit:global([data-d="7"]) .sa,
  .seg-digit:global([data-d="8"]) .sa,
  .seg-digit:global([data-d="9"]) .sa,
  .seg-digit:global([data-d="0"]) .sb,
  .seg-digit:global([data-d="1"]) .sb,
  .seg-digit:global([data-d="2"]) .sb,
  .seg-digit:global([data-d="3"]) .sb,
  .seg-digit:global([data-d="4"]) .sb,
  .seg-digit:global([data-d="7"]) .sb,
  .seg-digit:global([data-d="8"]) .sb,
  .seg-digit:global([data-d="9"]) .sb,
  .seg-digit:global([data-d="0"]) .sc,
  .seg-digit:global([data-d="1"]) .sc,
  .seg-digit:global([data-d="3"]) .sc,
  .seg-digit:global([data-d="4"]) .sc,
  .seg-digit:global([data-d="5"]) .sc,
  .seg-digit:global([data-d="6"]) .sc,
  .seg-digit:global([data-d="7"]) .sc,
  .seg-digit:global([data-d="8"]) .sc,
  .seg-digit:global([data-d="9"]) .sc,
  .seg-digit:global([data-d="0"]) .sd,
  .seg-digit:global([data-d="2"]) .sd,
  .seg-digit:global([data-d="3"]) .sd,
  .seg-digit:global([data-d="5"]) .sd,
  .seg-digit:global([data-d="6"]) .sd,
  .seg-digit:global([data-d="8"]) .sd,
  .seg-digit:global([data-d="9"]) .sd,
  .seg-digit:global([data-d="0"]) .se,
  .seg-digit:global([data-d="2"]) .se,
  .seg-digit:global([data-d="6"]) .se,
  .seg-digit:global([data-d="8"]) .se,
  .seg-digit:global([data-d="0"]) .sf,
  .seg-digit:global([data-d="4"]) .sf,
  .seg-digit:global([data-d="5"]) .sf,
  .seg-digit:global([data-d="6"]) .sf,
  .seg-digit:global([data-d="8"]) .sf,
  .seg-digit:global([data-d="9"]) .sf,
  .seg-digit:global([data-d="2"]) .sg,
  .seg-digit:global([data-d="3"]) .sg,
  .seg-digit:global([data-d="4"]) .sg,
  .seg-digit:global([data-d="5"]) .sg,
  .seg-digit:global([data-d="6"]) .sg,
  .seg-digit:global([data-d="8"]) .sg,
  .seg-digit:global([data-d="9"]) .sg {
    fill: var(--lit-fill);
    stroke: var(--lit-stroke);
    stroke-width: 0.7;
  }

  .colon-dot {
    fill: var(--lit-fill);
  }

  /* 7-Channel Dynamic Coloring (Electric Orange by default, Electric Cyan when X > 0) */
  .channel-column {
    color: #ff7700;
  }
  .channel-column:global(.is-blue) {
    color: #00d4ff;
  }

  .chan-telemetry-box {
    stroke: currentColor;
    transition: stroke 0.08s ease;
  }

  .telemetry-coord-text {
    fill: currentColor;
    font-family: 'Share Tech Mono', monospace;
    font-size: 11px;
    font-weight: bold;
    letter-spacing: 0.05em;
    transition: fill 0.08s ease;
  }

  .chan-viewport {
    stroke: currentColor;
    transition: stroke 0.08s ease;
  }

  .chan-gate {
    stroke: #ff7700;
  }

  .chan-ruler {
    stroke: #ff7700;
  }

  .ruler-scale-num {
    fill: #ff7700;
    font-family: 'Share Tech Mono', monospace;
    font-size: 7.5px;
    font-weight: bold;
  }

  .chan-vertical-label {
    fill: #ff7700;
    font-family: 'Share Tech Mono', 'Orbitron', monospace;
    font-size: 8.5px;
    font-weight: 900;
    letter-spacing: 0.16em;
  }

  /* Oscilloscope Waveform Path */
  .oscilloscope-wave {
    stroke: currentColor;
    transition: stroke 0.08s ease;
  }

  /* Scrubber Track (Thicker Fixed-Spectrum CRT Phosphor Envelope) */
  .eva-scrubber-track {
    width: 100%;
    height: 14px;
    background: #080202;
    border: 1px solid rgba(255, 119, 0, 0.55);
    box-shadow:
      inset 0 0 8px rgba(0, 0, 0, 0.85),
      0 0 10px rgba(255, 119, 0, 0.22);
    position: relative;
    cursor: pointer;
    margin-top: 8px;
    overflow: hidden;
  }

  .eva-scrubber-track:focus-visible {
    outline: 2px solid #00d4ff;
  }

  .eva-scrubber-spectrum {
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, #ff1e38 0%, #ff7700 35%, #ffaa00 58%, #38bdf8 82%, #7dd3fc 100%);
    filter: saturate(1.15);
    pointer-events: none;
  }

  .eva-scrubber-mask {
    position: absolute;
    inset: 0;
    background: rgba(4, 2, 2, 0.86);
    transform-origin: right center;
    will-change: transform;
    pointer-events: none;
  }

  .eva-scrubber-crt {
    position: absolute;
    inset: 0;
    background:
      repeating-linear-gradient(
        0deg,
        rgba(0, 0, 0, 0.46) 0px,
        rgba(0, 0, 0, 0.46) 1px,
        transparent 1px,
        transparent 3px
      ),
      linear-gradient(
        180deg,
        rgba(255, 255, 255, 0.18) 0%,
        transparent 35%,
        rgba(0, 0, 0, 0.42) 100%
      );
    box-shadow: inset 0 0 8px rgba(0, 0, 0, 0.75);
    pointer-events: none;
  }

  .eva-scrubber-head {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: #ffffff;
    box-shadow: 0 0 8px rgba(255, 255, 255, 0.95), 0 0 14px rgba(0, 212, 255, 0.7);
    transform: translateX(-50%);
    pointer-events: none;
  }

  /* SEELE 02 // SOUND ONLY Monolith */
  .seele-top-label {
    fill: rgba(255, 255, 255, 0.35);
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.34em;
  }

  .seele-sound-only {
    fill: #ff8c00;
    font-family: var(--font-display);
    font-size: 23px;
    font-weight: 900;
    letter-spacing: 0.22em;
  }

  .seele-bottom-id {
    fill: rgba(255, 255, 255, 0.24);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.25em;
  }

  .seele-eq-bar {
    fill: rgba(255, 140, 0, 0.35);
    transform-box: fill-box;
    transform-origin: center bottom;
  }

  .seele-monolith.speaking .seele-eq-bar {
    fill: #ff9500;
    animation: seele-eq-pulse 0.65s ease-in-out infinite alternate;
  }

  .seele-monolith.speaking .seele-eq-bar.b2 { animation-delay: 0.14s; }
  .seele-monolith.speaking .seele-eq-bar.b3 { animation-delay: 0.28s; }
  .seele-monolith.speaking .seele-eq-bar.b4 { animation-delay: 0.08s; }

  @keyframes seele-eq-pulse {
    0% { transform: scaleY(0.35); opacity: 0.6; }
    100% { transform: scaleY(1); opacity: 1; }
  }

  .paused-grid-text {
    fill: #dc1e1e;
    font-family: "Oswald", "Impact", "Arial Narrow", var(--font-display), sans-serif;
    font-size: 38px;
    font-weight: 800;
    letter-spacing: 0.24em;
    opacity: 0.92;
  }
</style>
