// Frame-exact video export: render offscreen at full resolution, encode with
// WebCodecs, mux to MP4 (H.264) or WebM (VP9). Nothing realtime — every frame is
// rendered and encoded in turn, so a 4K export never drops or duplicates a frame.

import * as Mp4 from '../vendor/mp4-muxer.js';
import * as Webm from '../vendor/webm-muxer.js';

const H264_CANDIDATES = ['avc1.640034', 'avc1.640033', 'avc1.4d0034', 'avc1.42e034'];
const VP9_CANDIDATES = ['vp09.00.51.08', 'vp09.00.41.08', 'vp09.00.10.08'];

export function isVideoExportSupported() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

async function pickConfig(format, width, height, fps, bitrate) {
  const candidates = format === 'webm' ? VP9_CANDIDATES : H264_CANDIDATES;
  const accelerations = ['prefer-hardware', 'no-preference', 'prefer-software'];
  for (const acceleration of accelerations) {
    for (const codec of candidates) {
      const config = {
        codec,
        width,
        height,
        bitrate,
        framerate: fps,
        latencyMode: 'quality',
        hardwareAcceleration: acceleration,
      };
      if (format === 'mp4') config.avc = { format: 'avc' };
      try {
        const support = await VideoEncoder.isConfigSupported(config);
        if (support?.supported) return support.config ?? config;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/**
 * @param {object} opts
 * @param {(p: {frame: number, total: number, phase: string}) => void} opts.onProgress
 * @param {() => boolean} opts.isCancelled
 * @param {(index: number) => void} opts.drawFrame  renders frame `index` into the canvas
 */
export async function exportVideo({
  canvas,
  drawFrame,
  width,
  height,
  fps,
  frameCount,
  format = 'mp4',
  bitrate,
  fileName = 'heatmap',
  onProgress = () => {},
  isCancelled = () => false,
}) {
  if (!isVideoExportSupported()) {
    throw new Error('This browser has no WebCodecs support. Use Chrome, Edge or Arc.');
  }

  const config = await pickConfig(format, width, height, fps, bitrate);
  if (!config) {
    throw new Error(
      `No ${format === 'mp4' ? 'H.264' : 'VP9'} encoder available at ${width}x${height}. Try the other format or a smaller size.`
    );
  }

  const extension = format === 'mp4' ? 'mp4' : 'webm';
  const Lib = format === 'mp4' ? Mp4 : Webm;

  // Stream straight to disk when the browser allows it, so a long 4K export is
  // never held in memory.
  let fileHandle = null;
  let writable = null;
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      fileHandle = await window.showSaveFilePicker({
        suggestedName: `${fileName}.${extension}`,
        types: [
          {
            description: format === 'mp4' ? 'MP4 video' : 'WebM video',
            accept: { [format === 'mp4' ? 'video/mp4' : 'video/webm']: [`.${extension}`] },
          },
        ],
      });
      writable = await fileHandle.createWritable();
    } catch (error) {
      if (error?.name === 'AbortError') return { cancelled: true };
      fileHandle = null;
      writable = null;
    }
  }

  const target = writable
    ? new Lib.FileSystemWritableFileStreamTarget(writable)
    : new Lib.ArrayBufferTarget();

  const muxerOptions = {
    target,
    video: {
      codec: format === 'mp4' ? 'avc' : 'V_VP9',
      width,
      height,
      frameRate: fps,
    },
  };
  if (format === 'mp4') {
    muxerOptions.fastStart = writable ? false : 'in-memory';
  } else if (writable) {
    muxerOptions.streaming = true;
  }

  const muxer = new Lib.Muxer(muxerOptions);

  let encoderError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (error) => {
      encoderError = error;
    },
  });
  encoder.configure(config);

  const microsPerFrame = 1e6 / fps;
  const keyFrameInterval = Math.max(1, Math.round(fps * 2));
  let cancelled = false;

  try {
    for (let i = 0; i < frameCount; i++) {
      if (encoderError) throw encoderError;
      if (isCancelled()) {
        cancelled = true;
        break;
      }

      // The caller owns the clock: a fixed step for a plain loop, or a timeline
      // lookup when parameters are keyframed.
      drawFrame(i);

      const frame = new VideoFrame(canvas, {
        timestamp: Math.round(i * microsPerFrame),
        duration: Math.round(microsPerFrame),
      });
      encoder.encode(frame, { keyFrame: i % keyFrameInterval === 0 });
      frame.close();

      onProgress({ frame: i + 1, total: frameCount, phase: 'encoding' });

      // Let the encoder drain and keep the tab responsive. setTimeout is clamped
      // (and heavily throttled in a background tab), so pace on the encoder's own
      // dequeue signal and yield through a message channel instead.
      while (encoder.encodeQueueSize > 4) {
        await waitForDequeue(encoder);
        if (encoderError) throw encoderError;
      }
      if (i % 8 === 7) await yieldToBrowser();
    }

    onProgress({ frame: frameCount, total: frameCount, phase: 'finishing' });
    await encoder.flush();
    if (encoderError) throw encoderError;
    muxer.finalize();

    if (writable) {
      await writable.close();
      return { cancelled, fileName: fileHandle.name, savedToDisk: true };
    }

    const blob = new Blob([target.buffer], { type: format === 'mp4' ? 'video/mp4' : 'video/webm' });
    downloadBlob(blob, `${fileName}.${extension}`);
    return { cancelled, fileName: `${fileName}.${extension}`, size: blob.size };
  } catch (error) {
    try {
      encoder.close();
    } catch {
      /* already closed */
    }
    if (writable) {
      try {
        await writable.close();
      } catch {
        /* nothing to salvage */
      }
    }
    throw error;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
}

/** A yield that is not clamped to 4ms the way setTimeout(0) is. */
const channel = typeof MessageChannel === 'function' ? new MessageChannel() : null;
function yieldToBrowser() {
  if (!channel) return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => {
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(0);
  });
}

/** Wait for the encoder to report progress, falling back to a short sleep. */
function waitForDequeue(encoder) {
  if (!('ondequeue' in encoder)) return new Promise((resolve) => setTimeout(resolve, 1));
  return new Promise((resolve) => {
    encoder.ondequeue = () => {
      encoder.ondequeue = null;
      resolve();
    };
  });
}

/**
 * Lossless master: one PNG per frame into a folder you pick. No codec, no chroma
 * subsampling, and alpha survives — which is what you want if the glow is going
 * to be composited over something else.
 */
export async function exportPngSequence({
  canvas,
  drawFrame,
  frameCount,
  fileName = 'heatmap',
  onProgress = () => {},
  isCancelled = () => false,
}) {
  if (typeof window.showDirectoryPicker !== 'function') {
    throw new Error('This browser cannot write a folder. Use Chrome or Edge, or pick MP4/WebM.');
  }

  let directory;
  try {
    directory = await window.showDirectoryPicker({ mode: 'readwrite', id: 'heatmap-frames' });
  } catch (error) {
    if (error?.name === 'AbortError') return { cancelled: true };
    throw error;
  }

  const pad = String(frameCount).length + 1;
  let written = 0;

  for (let i = 0; i < frameCount; i++) {
    if (isCancelled()) return { cancelled: true, written };

    drawFrame(i);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error(`Frame ${i + 1} could not be encoded as PNG.`);

    const name = `${fileName}_${String(i + 1).padStart(pad, '0')}.png`;
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    written++;

    onProgress({ frame: i + 1, total: frameCount, phase: 'encoding' });
    await yieldToBrowser();
  }

  return { cancelled: false, written, fileName: `${fileName}_*.png`, savedToDisk: true, folder: directory.name };
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Suggested H.264/VP9 bitrate for a given frame size and rate. */
export function suggestBitrate(width, height, fps, quality) {
  const pixels = width * height;
  const perPixel = { standard: 0.11, high: 0.2, max: 0.4 }[quality] ?? 0.2;
  return Math.round(pixels * fps * perPixel);
}
