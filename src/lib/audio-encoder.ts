// audio-encoder.ts: Non-blocking in-browser audio transcode to 128kbps MP3 via Web Worker
import { Mp3Encoder } from '@breezystack/lamejs';

/**
 * Transcodes an audio File or Blob to 128kbps MP3 asynchronously.
 * Offloads heavy MP3 encoding to a dedicated Web Worker so the main UI thread
 * remains completely unblocked and 100% responsive.
 */
export async function compressAudioTo128kMp3(
  file: File | Blob,
  fileName: string = 'track.mp3',
  onProgress?: (pct: number) => void
): Promise<File> {
  const arrayBuffer = await file.arrayBuffer();

  // Decode audio data using browser's native background decoding thread
  const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  } finally {
    if (audioCtx.state !== 'closed') {
      audioCtx.close().catch(() => {});
    }
  }

  const channels = Math.min(2, audioBuffer.numberOfChannels);
  const sampleRate = audioBuffer.sampleRate;
  const kbps = 128;
  const sampleCount = audioBuffer.length;

  // Extract PCM float buffers
  const leftChannel = new Float32Array(audioBuffer.getChannelData(0));
  const rightChannel = channels > 1 ? new Float32Array(audioBuffer.getChannelData(1)) : undefined;

  // Attempt Web Worker off-thread encoding
  try {
    const mp3Buffer = await encodeInWorker({
      channels,
      sampleRate,
      kbps,
      sampleCount,
      leftChannel,
      rightChannel,
      onProgress
    });

    const mp3Blob = new Blob([mp3Buffer], { type: 'audio/mpeg' });
    const finalFileName = fileName.replace(/\.[^/.]+$/, '') + '_128k.mp3';
    return new File([mp3Blob], finalFileName, { type: 'audio/mpeg' });
  } catch (workerErr) {
    console.warn('[Audio Encoder] Worker encoding failed or unavailable, falling back to time-sliced async encoder:', workerErr);
    // Fallback: non-blocking time-sliced encoding on main thread
    return encodeTimeSliced(leftChannel, rightChannel, channels, sampleRate, kbps, sampleCount, fileName, onProgress);
  }
}

interface WorkerParams {
  channels: number;
  sampleRate: number;
  kbps: number;
  sampleCount: number;
  leftChannel: Float32Array;
  rightChannel?: Float32Array;
  onProgress?: (pct: number) => void;
}

function encodeInWorker(params: WorkerParams): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL('./audio-encoder.worker.ts', import.meta.url), {
        type: 'module'
      });
    } catch (e) {
      reject(e);
      return;
    }

    const cleanup = () => {
      if (worker) {
        worker.terminate();
        worker = null;
      }
    };

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        params.onProgress?.(msg.pct);
      } else if (msg.type === 'done') {
        params.onProgress?.(100);
        cleanup();
        resolve(msg.buffer);
      } else if (msg.type === 'error') {
        cleanup();
        reject(new Error(msg.message || 'Worker encoding error'));
      }
    };

    worker.onerror = (err) => {
      cleanup();
      reject(err);
    };

    // Zero-copy transfer of channel Float32Arrays to the worker
    const transferables: Transferable[] = [params.leftChannel.buffer];
    if (params.rightChannel) {
      transferables.push(params.rightChannel.buffer);
    }

    worker.postMessage(
      {
        channels: params.channels,
        sampleRate: params.sampleRate,
        kbps: params.kbps,
        sampleCount: params.sampleCount,
        leftChannel: params.leftChannel,
        rightChannel: params.rightChannel
      },
      transferables
    );
  });
}

/**
 * Non-blocking time-sliced fallback: yields execution every 30 frames
 * using setTimeout(0) to prevent freezing the UI even without a Web Worker.
 */
async function encodeTimeSliced(
  leftChannel: Float32Array,
  rightChannel: Float32Array | undefined,
  channels: number,
  sampleRate: number,
  kbps: number,
  sampleCount: number,
  fileName: string,
  onProgress?: (pct: number) => void
): Promise<File> {
  const mp3encoder = new Mp3Encoder(channels, sampleRate, kbps);
  const mp3Data: Uint8Array[] = [];

  const blockSize = 1152;
  const leftChunk = new Int16Array(blockSize);
  const rightChunk = new Int16Array(blockSize);

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

    if (mp3buf.length > 0) {
      mp3Data.push(new Uint8Array(mp3buf));
    }

    // Yield control to event loop every 30 frames to keep UI responsive
    if (i % (blockSize * 30) === 0) {
      if (onProgress) {
        onProgress(Math.min(99, Math.round((i / sampleCount) * 100)));
      }
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const endBuf = mp3encoder.flush();
  if (endBuf.length > 0) {
    mp3Data.push(new Uint8Array(endBuf));
  }

  onProgress?.(100);

  const mp3Blob = new Blob(mp3Data as any[], { type: 'audio/mpeg' });
  const finalFileName = fileName.replace(/\.[^/.]+$/, '') + '_128k.mp3';
  return new File([mp3Blob], finalFileName, { type: 'audio/mpeg' });
}
