// audio-metadata.ts: Client-side parser for basic MP3 (ID3v1/ID3v2) and FLAC metadata without heavy external dependencies

export interface TrackMetadata {
  title: string;
  artist: string;
  album: string;
  duration: number; // in seconds
  coverUrl?: string;
  mimeType: string;
  sizeBytes: number;
}

export async function parseAudioFile(file: File): Promise<TrackMetadata> {
  const lowerName = file.name.toLowerCase();
  let mimeType = file.type;
  if (lowerName.endsWith('.mp3') || mimeType === 'audio/mp3') {
    mimeType = 'audio/mpeg';
  } else if (lowerName.endsWith('.flac')) {
    mimeType = 'audio/flac';
  } else if (!mimeType) {
    mimeType = 'audio/mpeg';
  }
  let sliceSize = 1024 * 512;
  const headerBuf = await file.slice(0, 10).arrayBuffer();
  if (headerBuf.byteLength >= 10) {
    const h = new DataView(headerBuf);
    if (h.getUint8(0) === 0x49 && h.getUint8(1) === 0x44 && h.getUint8(2) === 0x33) {
      const tagSize = ((h.getUint8(6) & 0x7f) << 21) | ((h.getUint8(7) & 0x7f) << 14) | ((h.getUint8(8) & 0x7f) << 7) | (h.getUint8(9) & 0x7f);
      sliceSize = Math.min(tagSize + 10, 16 * 1024 * 1024);
    }
  }
  const buffer = await file.slice(0, Math.min(file.size, sliceSize)).arrayBuffer();
  const view = new DataView(buffer);

  let title = file.name.replace(/\.[^/.]+$/, "");
  let artist = "Unknown Artist";
  let album = "Unknown Album";
  let coverBlob: Blob | undefined = undefined;

  // Check ID3v2 (MP3 and some FLAC)
  if (buffer.byteLength >= 10 && view.getUint8(0) === 0x49 && view.getUint8(1) === 0x44 && view.getUint8(2) === 0x33) {
    try {
      const parsed = parseID3v2(view, buffer);
      if (parsed.title) title = parsed.title;
      if (parsed.artist) artist = parsed.artist;
      if (parsed.album) album = parsed.album;
      if (parsed.coverBlob) coverBlob = parsed.coverBlob;
    } catch (e) {
      console.warn("ID3 parse error, falling back", e);
    }
  } else if (buffer.byteLength >= 4 && view.getUint8(0) === 0x66 && view.getUint8(1) === 0x4C && view.getUint8(2) === 0x61 && view.getUint8(3) === 0x43) {
    // "fLaC" signature
    try {
      const flacMeta = parseFLAC(view, buffer);
      if (flacMeta.title) title = flacMeta.title;
      if (flacMeta.artist) artist = flacMeta.artist;
      if (flacMeta.album) album = flacMeta.album;
      if (flacMeta.coverBlob) coverBlob = flacMeta.coverBlob;
    } catch (e) {
      console.warn("FLAC metadata parse error", e);
    }
  }

  const coverUrl = coverBlob ? await blobToCompactDataUrl(coverBlob) : undefined;

  // Get accurate duration via standard HTML5 Audio element
  const duration = await getAudioDuration(file);

  return {
    title,
    artist,
    album,
    duration,
    coverUrl,
    mimeType,
    sizeBytes: file.size,
  };
}

async function blobToCompactDataUrl(blob: Blob): Promise<string | undefined> {
  try {
    if (typeof createImageBitmap === 'function' && typeof document !== 'undefined') {
      const bmp = await createImageBitmap(blob);
      const maxDim = 256;
      const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        bmp.close();
        return canvas.toDataURL('image/jpeg', 0.8);
      }
      bmp.close();
    }
    return await new Promise<string | undefined>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined);
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  }
}

function getAudioDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    let resolved = false;
    const audio = document.createElement("audio");
    const objectUrl = URL.createObjectURL(file);
    audio.preload = "metadata";
    audio.src = objectUrl;

    let timer: any = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(objectUrl);
    };

    timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(180);
      }
    }, 4000);

    audio.onloadedmetadata = () => {
      if (!resolved) {
        resolved = true;
        const dur = audio.duration || 0;
        cleanup();
        resolve(dur);
      }
    };

    audio.onerror = () => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(180);
      }
    };
  });
}

function parseID3v2(view: DataView, buffer: ArrayBuffer) {
  let title = "";
  let artist = "";
  let album = "";
  let coverBlob: Blob | undefined = undefined;

  let offset = 10;
  const version = view.getUint8(3);
  const tagSize = ((view.getUint8(6) & 0x7f) << 21) |
                  ((view.getUint8(7) & 0x7f) << 14) |
                  ((view.getUint8(8) & 0x7f) << 7) |
                  (view.getUint8(9) & 0x7f);

  const maxOffset = Math.min(buffer.byteLength, tagSize + 10);
  const utf8Decoder = new TextDecoder("utf-8");
  const latin1Decoder = new TextDecoder("iso-8859-1");
  const utf16Decoder = new TextDecoder("utf-16");
  const utf16beDecoder = new TextDecoder("utf-16be");

  while (offset + 10 < maxOffset) {
    const frameId = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );

    if (frameId.charCodeAt(0) === 0) break; // Padding reached

    const frameSize = version === 4
      ? ((view.getUint8(offset + 4) & 0x7f) << 21) |
        ((view.getUint8(offset + 5) & 0x7f) << 14) |
        ((view.getUint8(offset + 6) & 0x7f) << 7) |
        (view.getUint8(offset + 7) & 0x7f)
      : view.getUint32(offset + 4, false);

    if (frameSize <= 0 || offset + 10 + frameSize > buffer.byteLength) break;

    const frameData = new Uint8Array(buffer, offset + 10, frameSize);
    const encoding = frameData[0];
    const textBytes = frameData.subarray(1);

    const decodeText = () => {
      const dec = encoding === 0 ? latin1Decoder : encoding === 1 ? utf16Decoder : encoding === 2 ? utf16beDecoder : utf8Decoder;
      return dec.decode(textBytes).replace(/\0+$/g, "").trim();
    };

    if (frameId === "TIT2") title = decodeText();
    else if (frameId === "TPE1") artist = decodeText();
    else if (frameId === "TALB") album = decodeText();
    else if (frameId === "APIC") {
      // Attached Picture
      try {
        let p = 1;
        const mimeStart = p;
        while (p < frameData.length && frameData[p] !== 0) p++;
        const mime = latin1Decoder.decode(frameData.subarray(mimeStart, p)) || "image/jpeg";
        p++; // null terminator
        p++; // pic type
        if (encoding === 1 || encoding === 2) {
          while (p + 1 < frameData.length && (frameData[p] !== 0 || frameData[p + 1] !== 0)) p += 2;
          p += 2;
        } else {
          while (p < frameData.length && frameData[p] !== 0) p++;
          p++;
        }
        if (p < frameData.length) {
          coverBlob = new Blob([frameData.slice(p)], { type: mime });
        }
      } catch (err) {
        console.warn("Error reading APIC frame", err);
      }
    }

    offset += 10 + frameSize;
  }

  return { title, artist, album, coverBlob };
}

function parseFLAC(view: DataView, buffer: ArrayBuffer) {
  let title = "";
  let artist = "";
  let album = "";
  let coverBlob: Blob | undefined = undefined;

  let offset = 4;
  let isLast = false;
  const decoder = new TextDecoder("utf-8");

  while (!isLast && offset + 4 < buffer.byteLength) {
    const headerByte = view.getUint8(offset);
    isLast = (headerByte & 0x80) !== 0;
    const blockType = headerByte & 0x7F;
    const length = (view.getUint8(offset + 1) << 16) | (view.getUint8(offset + 2) << 8) | view.getUint8(offset + 3);
    offset += 4;

    if (offset + length > buffer.byteLength) break;

    if (blockType === 4) {
      // VORBIS_COMMENT
      try {
        let p = offset;
        const vendorLen = view.getUint32(p, true);
        p += 4 + vendorLen;
        const commentCount = view.getUint32(p, true);
        p += 4;

        for (let i = 0; i < commentCount && p + 4 < offset + length; i++) {
          const cLen = view.getUint32(p, true);
          p += 4;
          const commentStr = decoder.decode(new Uint8Array(buffer, p, cLen));
          p += cLen;
          const eqIdx = commentStr.indexOf("=");
          if (eqIdx > 0) {
            const field = commentStr.slice(0, eqIdx).toUpperCase();
            const val = commentStr.slice(eqIdx + 1);
            if (field === "TITLE") title = val;
            else if (field === "ARTIST") artist = val;
            else if (field === "ALBUM") album = val;
          }
        }
      } catch (e) {
        console.warn("Error parsing Vorbis comment", e);
      }
    } else if (blockType === 6) {
      // PICTURE block
      try {
        let p = offset;
        p += 4; // picture type
        const mimeLen = view.getUint32(p, false);
        p += 4;
        const mime = decoder.decode(new Uint8Array(buffer, p, mimeLen));
        p += mimeLen;
        const descLen = view.getUint32(p, false);
        p += 4 + descLen;
        p += 16; // width, height, depth, colors
        const dataLen = view.getUint32(p, false);
        p += 4;
        if (p + dataLen <= buffer.byteLength) {
          const picBytes = new Uint8Array(buffer, p, dataLen);
          coverBlob = new Blob([picBytes], { type: mime || "image/jpeg" });
        }
      } catch (e) {
        console.warn("Error parsing FLAC picture block", e);
      }
    }

    offset += length;
  }

  return { title, artist, album, coverBlob };
}
