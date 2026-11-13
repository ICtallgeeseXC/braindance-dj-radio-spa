export interface LookaheadTimeline {
  fps: number;
  frames: number;
  data: Float32Array; // frames * 7 channels, values in [-24, 24]
}

const FFT_SIZE = 512;
const HALF_FFT = FFT_SIZE / 2;

// Precompute Hann window and bit-reversal / twiddle tables once
const hannWindow = new Float32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  hannWindow[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
}

const bitRev = new Uint16Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  let j = 0;
  let x = i;
  for (let b = 0; b < 9; b++) {
    j = (j << 1) | (x & 1);
    x >>= 1;
  }
  bitRev[i] = j;
}

const cosTable = new Float32Array(HALF_FFT);
const sinTable = new Float32Array(HALF_FFT);
for (let i = 0; i < HALF_FFT; i++) {
  const angle = (-2 * Math.PI * i) / FFT_SIZE;
  cosTable[i] = Math.cos(angle);
  sinTable[i] = Math.sin(angle);
}

function computeSpectrumByteBins(
  samples: Float32Array,
  startIdx: number,
  real: Float32Array,
  imag: Float32Array,
  outBins: Uint8Array
) {
  const len = samples.length;
  for (let i = 0; i < FFT_SIZE; i++) {
    const idx = startIdx + i;
    const s = idx >= 0 && idx < len ? samples[idx] : 0;
    real[bitRev[i]] = s * hannWindow[i];
    imag[bitRev[i]] = 0;
  }

  for (let size = 2; size <= FFT_SIZE; size <<= 1) {
    const half = size >> 1;
    const step = FFT_SIZE / size;
    for (let i = 0; i < FFT_SIZE; i += size) {
      for (let j = 0; j < half; j++) {
        const tw = j * step;
        const wr = cosTable[tw];
        const wi = sinTable[tw];
        const k = i + j + half;
        const tr = wr * real[k] - wi * imag[k];
        const ti = wr * imag[k] + wi * real[k];
        real[k] = real[i + j] - tr;
        imag[k] = imag[i + j] - ti;
        real[i + j] += tr;
        imag[i + j] += ti;
      }
    }
  }

  // Match WebAudio AnalyserNode byte scaling (-100 dB .. -30 dB -> 0 .. 255)
  const minDb = -100;
  const maxDb = -30;
  const invRange = 255 / (maxDb - minDb);
  const norm = 2 / FFT_SIZE;

  for (let i = 0; i < HALF_FFT; i++) {
    const mag = Math.hypot(real[i], imag[i]) * norm;
    const db = mag > 1e-9 ? 20 * Math.log10(mag) : minDb;
    const scaled = (db - minDb) * invRange;
    outBins[i] = scaled <= 0 ? 0 : scaled >= 255 ? 255 : scaled | 0;
  }
}

function getBandEnergy(data: Uint8Array, startHz: number, endHz: number, sampleRate: number): number {
  const nyquist = sampleRate / 2;
  const startBin = Math.max(1, Math.min(data.length - 1, Math.floor((startHz / nyquist) * data.length)));
  const endBin = Math.max(startBin + 1, Math.min(data.length, Math.ceil((endHz / nyquist) * data.length)));
  const count = Math.max(1, endBin - startBin);

  let sum = 0;
  let activeBins = 0;
  for (let i = startBin; i < endBin; i++) {
    const val = data[i];
    sum += val;
    if (val >= 32) activeBins++;
  }

  const avg = sum / count / 255;
  const activeRatio = activeBins / count;
  const activityFactor = Math.min(1.0, activeRatio / 0.5);
  return avg * Math.pow(activityFactor, 0.7);
}

export async function buildAudioLookahead(
  blob: Blob,
  existingCtx?: AudioContext | null,
  shouldAbort?: () => boolean
): Promise<LookaheadTimeline | null> {
  if (typeof window === 'undefined') return null;

  let tempCtx: AudioContext | null = null;
  try {
    const ctx = existingCtx || (() => {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return null;
      tempCtx = new AudioCtx();
      return tempCtx;
    })();
    if (!ctx) return null;

    const arrayBuf = await blob.arrayBuffer();
    if (shouldAbort?.()) return null;

    const audioBuffer = await ctx.decodeAudioData(arrayBuf);
    if (shouldAbort?.()) return null;

    const sampleRate = audioBuffer.sampleRate;
    const duration = audioBuffer.duration;
    const fps = 30;
    const frames = Math.max(1, Math.ceil(duration * fps));
    const data = new Float32Array(frames * 7);

    const left = audioBuffer.getChannelData(0);
    const right = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : left;
    const mono = new Float32Array(FFT_SIZE);

    const real = new Float32Array(FFT_SIZE);
    const imag = new Float32Array(FFT_SIZE);
    const monoBins = new Uint8Array(HALF_FFT);
    const leftBins = new Uint8Array(HALF_FFT);
    const rightBins = new Uint8Array(HALF_FFT);

    const runningBaselines = new Float32Array([0.35, 0.28, 0.28, 0.35, 0.15, 0.28, 0.30]);
    const smoothed = new Float32Array(7).fill(-24);
    const sensitivities = [0.22, 0.20, 0.20, 0.22, 0.20, 0.20, 0.22];

    for (let f = 0; f < frames; f++) {
      if (shouldAbort?.()) return null;
      const centerSample = Math.floor((f / fps) * sampleRate);
      const startSample = centerSample - HALF_FFT;

      for (let i = 0; i < FFT_SIZE; i++) {
        const idx = startSample + i;
        const l = idx >= 0 && idx < left.length ? left[idx] : 0;
        const r = idx >= 0 && idx < right.length ? right[idx] : 0;
        mono[i] = 0.5 * (l + r);
      }

      computeSpectrumByteBins(mono, 0, real, imag, monoBins);
      computeSpectrumByteBins(left, startSample, real, imag, leftBins);
      computeSpectrumByteBins(right, startSample, real, imag, rightBins);

      const mags = [
        getBandEnergy(monoBins, 30, 80, sampleRate),
        getBandEnergy(leftBins, 40, 12000, sampleRate),
        getBandEnergy(rightBins, 40, 12000, sampleRate),
        getBandEnergy(monoBins, 80, 500, sampleRate),
        getBandEnergy(monoBins, 6000, 18000, sampleRate),
        getBandEnergy(monoBins, 2000, 6000, sampleRate),
        getBandEnergy(monoBins, 500, 2000, sampleRate)
      ];

      const base = f * 7;
      for (let c = 0; c < 7; c++) {
        const mag = mags[c];
        let targetOffset = -24;
        if (mag >= 0.015) {
          if (c === 4) {
            targetOffset = Math.max(-24, Math.min(24, -24 + (mag / 0.35) * 48));
          } else {
            runningBaselines[c] = runningBaselines[c] * 0.985 + mag * 0.015;
            const diff = mag - runningBaselines[c];
            targetOffset = Math.max(-24, Math.min(24, (diff / sensitivities[c]) * 24));
          }
        }
        smoothed[c] = smoothed[c] * 0.22 + targetOffset * 0.78;
        data[base + c] = smoothed[c];
      }

      // Yield every 450 frames (~15s of audio) so UI stays responsive
      if (f > 0 && f % 450 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    return { fps, frames, data };
  } catch {
    return null;
  } finally {
    if (tempCtx) {
      try { (tempCtx as AudioContext).close(); } catch {}
    }
  }
}
