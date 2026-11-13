// audio-encoder.worker.ts: Dedicated Web Worker for off-thread MP3 encoding
import { Mp3Encoder } from '@breezystack/lamejs';

export interface WorkerTranscodeRequest {
  channels: number;
  sampleRate: number;
  kbps: number;
  leftChannel: Float32Array;
  rightChannel?: Float32Array;
  sampleCount: number;
}

self.onmessage = (e: MessageEvent<WorkerTranscodeRequest>) => {
  const { channels, sampleRate, kbps, leftChannel, rightChannel, sampleCount } = e.data;

  try {
    const mp3encoder = new Mp3Encoder(channels, sampleRate, kbps);
    const mp3Chunks: Uint8Array[] = [];

    const blockSize = 1152;
    const leftChunk = new Int16Array(blockSize);
    const rightChunk = new Int16Array(blockSize);

    let lastReportedPct = -1;

    for (let i = 0; i < sampleCount; i += blockSize) {
      const remaining = Math.min(blockSize, sampleCount - i);

      for (let j = 0; j < remaining; j++) {
        const idx = i + j;
        const sL = Math.max(-1, Math.min(1, leftChannel[idx]));
        leftChunk[j] = sL < 0 ? sL * 32768 : sL * 32767;

        if (channels > 1 && rightChannel) {
          const sR = Math.max(-1, Math.min(1, rightChannel[idx]));
          rightChunk[j] = sR < 0 ? sR * 32768 : sR * 32767;
        }
      }

      for (let j = remaining; j < blockSize; j++) {
        leftChunk[j] = 0;
        rightChunk[j] = 0;
      }

      const mp3buf = channels === 1
        ? mp3encoder.encodeBuffer(leftChunk)
        : mp3encoder.encodeBuffer(leftChunk, rightChunk);

      if (mp3buf && mp3buf.length > 0) {
        mp3Chunks.push(new Uint8Array(mp3buf));
      }

      if (i % (blockSize * 30) === 0) {
        const pct = Math.min(99, Math.round((i / sampleCount) * 100));
        if (pct !== lastReportedPct) {
          lastReportedPct = pct;
          self.postMessage({ type: 'progress', pct });
        }
      }
    }

    const endBuf = mp3encoder.flush();
    if (endBuf && endBuf.length > 0) {
      mp3Chunks.push(new Uint8Array(endBuf));
    }

    // Merge mp3 chunks into single contiguous buffer
    let totalBytes = 0;
    for (let k = 0; k < mp3Chunks.length; k++) {
      totalBytes += mp3Chunks[k].length;
    }

    const outputBuffer = new Uint8Array(totalBytes);
    let offset = 0;
    for (let k = 0; k < mp3Chunks.length; k++) {
      outputBuffer.set(mp3Chunks[k], offset);
      offset += mp3Chunks[k].length;
    }

    // Transfer back with zero-copy
    (self as any).postMessage({ type: 'done', buffer: outputBuffer.buffer }, [outputBuffer.buffer]);
  } catch (err: any) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};
